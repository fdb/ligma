//! Ligma core: the editor engine.
//!
//! Owns the document (a tree of nodes; top-level order is z-order), the
//! camera, the active tool's state machine, selection, undo history, and
//! rendering. The JS side forwards raw input events and reads scene
//! snapshots; it never mutates document state directly.
//!
//! Coordinates are absolute document space everywhere, including children
//! of groups — a group's rect is derived as the union of its children.

use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::f64::consts::TAU;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::CanvasRenderingContext2d;

const DOC_VERSION: u32 = 2;
const EMPTY_DOC: &str = r#"{"version":2,"nodes":[],"next_id":1}"#;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Frame,
    Group,
    Rect,
    Ellipse,
    Text,
    Image,
    Path,
}

/// A path anchor point with its bezier control handles. Everything is in
/// absolute world coordinates (like all node geometry); a corner anchor's
/// handles coincide with the point, degenerating its curves to lines.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub hx_in: f64,
    pub hy_in: f64,
    pub hx_out: f64,
    pub hy_out: f64,
}

/// A styled run inside a text node, addressed by char offsets into
/// `text`. Characters outside every span render with the base style.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: usize,
    pub len: usize,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
}

/// A gradient color stop at a 0..1 position along the gradient axis.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    pub position: f64,
    pub color: String,
}

fn default_paint_kind() -> String {
    "solid".to_string()
}

impl Paint {
    fn solid(color: &str, opacity: f64) -> Paint {
        Paint {
            color: color.to_string(),
            opacity,
            kind: default_paint_kind(),
            stops: Vec::new(),
            angle: 0.0,
        }
    }
}

/// A single fill or stroke: a solid color, or a linear gradient across
/// the node's bounding box. `color` doubles as the solid value and the
/// swatch fallback.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paint {
    pub color: String,
    pub opacity: f64,
    #[serde(default = "default_paint_kind")]
    pub kind: String,
    #[serde(default)]
    pub stops: Vec<GradientStop>,
    /// Gradient direction in degrees; 0 points right, 90 points down.
    #[serde(default)]
    pub angle: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Png,
    Svg,
}

/// An export setting saved with the node, Figma-style (2x PNG, 1x SVG, …).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub scale: f64,
    pub format: ExportFormat,
}

fn default_true() -> bool {
    true
}
fn default_stroke_weight() -> f64 {
    1.0
}
fn default_blend_mode() -> String {
    "normal".to_string()
}
fn default_font_family() -> String {
    "Hanken Grotesk".to_string()
}
fn default_text_align() -> String {
    "left".to_string()
}
fn default_text_valign() -> String {
    // Existing documents rendered text vertically centered; "middle"
    // keeps them pixel-identical.
    "middle".to_string()
}

/// Line height as a multiple of font size.
const LINE_HEIGHT: f64 = 1.4;

/// CSS blend modes shared by canvas (globalCompositeOperation) and SVG
/// (mix-blend-mode). "normal" maps to canvas "source-over".
const BLEND_MODES: [&str; 16] = [
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: u32,
    pub name: String,
    pub kind: NodeKind,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
    pub fills: Vec<Paint>,
    #[serde(default)]
    pub strokes: Vec<Paint>,
    #[serde(default = "default_stroke_weight")]
    pub stroke_weight: f64,
    pub opacity: f64,
    #[serde(default = "default_blend_mode")]
    pub blend_mode: String,
    pub corner_radius: f64,
    pub text: String,
    pub font_size: f64,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_text_align")]
    pub text_align: String,
    #[serde(default = "default_text_valign")]
    pub text_valign: String,
    /// Content hash of an uploaded asset (image nodes only); the bytes
    /// live in R2 and the browser keeps decoded elements in a JS cache.
    #[serde(default)]
    pub image: String,
    /// Bezier anchors (path nodes only). x/y/w/h is the derived bounding
    /// box of the flattened curve.
    #[serde(default)]
    pub points: Vec<Anchor>,
    #[serde(default)]
    pub closed: bool,
    /// Additional closed contours (flatten results). Filled together
    /// with `points` under the even-odd rule, so overlaps become holes.
    #[serde(default)]
    pub inner: Vec<Vec<Anchor>>,
    /// Styled runs in `text` (text nodes only).
    #[serde(default)]
    pub spans: Vec<Span>,
    #[serde(default)]
    pub export_presets: Vec<ExportPreset>,
    #[serde(default)]
    pub children: Vec<Node>,
}

impl Node {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }

    fn intersects(&self, x: f64, y: f64, w: f64, h: f64) -> bool {
        self.x < x + w && self.x + self.w > x && self.y < y + h && self.y + self.h > y
    }
}

// ----- tree helpers -----

fn find_node(nodes: &[Node], id: u32) -> Option<&Node> {
    for n in nodes {
        if n.id == id {
            return Some(n);
        }
        if let Some(found) = find_node(&n.children, id) {
            return Some(found);
        }
    }
    None
}

fn find_node_mut(nodes: &mut [Node], id: u32) -> Option<&mut Node> {
    for n in nodes {
        if n.id == id {
            return Some(n);
        }
        if let Some(found) = find_node_mut(&mut n.children, id) {
            return Some(found);
        }
    }
    None
}

/// Index path from the root list to the node (last entry is the index in
/// its parent's list).
fn path_to(nodes: &[Node], id: u32) -> Option<Vec<usize>> {
    for (i, n) in nodes.iter().enumerate() {
        if n.id == id {
            return Some(vec![i]);
        }
        if let Some(mut rest) = path_to(&n.children, id) {
            let mut path = vec![i];
            path.append(&mut rest);
            return Some(path);
        }
    }
    None
}

/// The sibling list containing the node a path points at.
fn list_at<'a>(nodes: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Vec<Node> {
    let mut list = nodes;
    for &i in &path[..path.len() - 1] {
        list = &mut list[i].children;
    }
    list
}

fn shift_subtree(n: &mut Node, dx: f64, dy: f64) {
    n.x += dx;
    n.y += dy;
    for a in n.points.iter_mut().chain(n.inner.iter_mut().flatten()) {
        a.x += dx;
        a.y += dy;
        a.hx_in += dx;
        a.hy_in += dy;
        a.hx_out += dx;
        a.hy_out += dy;
    }
    for c in &mut n.children {
        shift_subtree(c, dx, dy);
    }
}

/// Maps a subtree from the old selection bbox (bx,by × fx,fy scale) into a
/// new one anchored at (nx,ny).
fn scale_subtree(n: &mut Node, bx: f64, by: f64, nx: f64, ny: f64, fx: f64, fy: f64) {
    n.x = nx + (n.x - bx) * fx;
    n.y = ny + (n.y - by) * fy;
    n.w *= fx;
    n.h *= fy;
    for a in n.points.iter_mut().chain(n.inner.iter_mut().flatten()) {
        a.x = nx + (a.x - bx) * fx;
        a.y = ny + (a.y - by) * fy;
        a.hx_in = nx + (a.hx_in - bx) * fx;
        a.hy_in = ny + (a.hy_in - by) * fy;
        a.hx_out = nx + (a.hx_out - bx) * fx;
        a.hy_out = ny + (a.hy_out - by) * fy;
    }
    for c in &mut n.children {
        scale_subtree(c, bx, by, nx, ny, fx, fy);
    }
}

fn round_subtree(n: &mut Node) {
    // Rounding a path's box without its anchors would desync them, and
    // rounding anchors would warp curves — leave paths exact.
    if n.kind == NodeKind::Path {
        return;
    }
    n.x = n.x.round();
    n.y = n.y.round();
    n.w = n.w.round().max(1.0);
    n.h = n.h.round().max(1.0);
    for c in &mut n.children {
        round_subtree(c);
    }
}

fn assign_fresh_ids(n: &mut Node, next_id: &mut u32) {
    n.id = *next_id;
    *next_id += 1;
    for c in &mut n.children {
        assign_fresh_ids(c, next_id);
    }
}

fn count_kind(nodes: &[Node], kind: NodeKind) -> usize {
    nodes
        .iter()
        .map(|n| usize::from(n.kind == kind) + count_kind(&n.children, kind))
        .sum()
}

/// Recompute every group's rect as the union of its children, bottom-up.
fn recompute_group_bounds(nodes: &mut [Node]) {
    for n in nodes {
        recompute_group_bounds(&mut n.children);
        if n.kind == NodeKind::Group && !n.children.is_empty() {
            let min_x = n.children.iter().map(|c| c.x).fold(f64::MAX, f64::min);
            let min_y = n.children.iter().map(|c| c.y).fold(f64::MAX, f64::min);
            let max_x = n.children.iter().map(|c| c.x + c.w).fold(f64::MIN, f64::max);
            let max_y = n.children.iter().map(|c| c.y + c.h).fold(f64::MIN, f64::max);
            n.x = min_x;
            n.y = min_y;
            n.w = max_x - min_x;
            n.h = max_y - min_y;
        }
    }
}

/// Remove groups that lost all their children (e.g. after deletes).
fn dissolve_empty_groups(nodes: &mut Vec<Node>) {
    for n in nodes.iter_mut() {
        dissolve_empty_groups(&mut n.children);
    }
    nodes.retain(|n| n.kind != NodeKind::Group || !n.children.is_empty());
}

// ----- bezier path geometry -----

/// Samples per bezier segment when flattening (bounds, hit-testing).
const FLATTEN_STEPS: usize = 16;

fn cubic_point(p0: (f64, f64), c0: (f64, f64), c1: (f64, f64), p1: (f64, f64), t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    (
        a * p0.0 + b * c0.0 + c * c1.0 + d * p1.0,
        a * p0.1 + b * c0.1 + c * c1.1 + d * p1.1,
    )
}

/// Flattens the path into a polyline (closing segment included if closed).
fn flatten_path(points: &[Anchor], closed: bool) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    if points.is_empty() {
        return out;
    }
    out.push((points[0].x, points[0].y));
    let segs = if closed { points.len() } else { points.len() - 1 };
    for i in 0..segs {
        let a = &points[i];
        let b = &points[(i + 1) % points.len()];
        for s in 1..=FLATTEN_STEPS {
            let t = s as f64 / FLATTEN_STEPS as f64;
            out.push(cubic_point(
                (a.x, a.y),
                (a.hx_out, a.hy_out),
                (b.hx_in, b.hy_in),
                (b.x, b.y),
                t,
            ));
        }
    }
    out
}

fn path_bounds(points: &[Anchor], closed: bool) -> (f64, f64, f64, f64) {
    let flat = flatten_path(points, closed);
    let min_x = flat.iter().map(|p| p.0).fold(f64::MAX, f64::min);
    let min_y = flat.iter().map(|p| p.1).fold(f64::MAX, f64::min);
    let max_x = flat.iter().map(|p| p.0).fold(f64::MIN, f64::max);
    let max_y = flat.iter().map(|p| p.1).fold(f64::MIN, f64::max);
    (min_x, min_y, max_x - min_x, max_y - min_y)
}

/// Recomputes a path node's bounding box from its anchors.
fn sync_path_bounds(n: &mut Node) {
    if n.kind == NodeKind::Path && !n.points.is_empty() {
        let (mut x, mut y, mut x2, mut y2) = {
            let (bx, by, bw, bh) = path_bounds(&n.points, n.closed);
            (bx, by, bx + bw, by + bh)
        };
        for c in &n.inner {
            let (bx, by, bw, bh) = path_bounds(c, true);
            x = x.min(bx);
            y = y.min(by);
            x2 = x2.max(bx + bw);
            y2 = y2.max(by + bh);
        }
        n.x = x;
        n.y = y;
        n.w = x2 - x;
        n.h = y2 - y;
    }
}

fn point_in_polygon(poly: &[(f64, f64)], x: f64, y: f64) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn dist_sq_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let len_sq = dx * dx + dy * dy;
    let t = if len_sq > 0.0 {
        (((px - ax) * dx + (py - ay) * dy) / len_sq).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    (px - cx) * (px - cx) + (py - cy) * (py - cy)
}

/// Precise hit test for a path node: within `tol` of the (flattened)
/// outline, or inside the fill when one is painted.
fn path_hit(n: &Node, x: f64, y: f64, tol: f64) -> bool {
    if n.points.len() < 2 {
        return false;
    }
    let reach = tol.max(n.stroke_weight / 2.0);
    let mut inside = false;
    for (contour, closed) in std::iter::once((&n.points, n.closed))
        .chain(n.inner.iter().map(|c| (c, true)))
    {
        let flat = flatten_path(contour, closed);
        for w in flat.windows(2) {
            if dist_sq_to_segment(x, y, w[0].0, w[0].1, w[1].0, w[1].1) <= reach * reach {
                return true;
            }
        }
        // Even-odd across contours: each containment toggles, so the
        // overlap of two contours reads as a hole. (Canvas fills open
        // paths by implicitly closing them; match that.)
        if point_in_polygon(&flat, x, y) {
            inside = !inside;
        }
    }
    !n.fills.is_empty() && inside
}

/// Re-encodes a per-char (bold, italic) map as minimal spans.
fn run_length_spans(styles: &[(bool, bool)]) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < styles.len() {
        let (b, it) = styles[i];
        let start = i;
        while i < styles.len() && styles[i] == (b, it) {
            i += 1;
        }
        if b || it {
            spans.push(Span { start, len: i - start, bold: b, italic: it });
        }
    }
    spans
}

/// The per-char style map for a text node (resolved from its spans).
fn char_styles(n: &Node) -> Vec<(bool, bool)> {
    let chars = n.text.chars().count();
    let mut styles = vec![(false, false); chars];
    for s in &n.spans {
        for c in styles.iter_mut().skip(s.start).take(s.len) {
            c.0 |= s.bold;
            c.1 |= s.italic;
        }
    }
    styles
}

/// Splits one wrapped line (starting at char `off` in the node's text)
/// into maximal same-style segments.
fn line_segments(styles: &[(bool, bool)], line: &str, off: usize) -> Vec<(String, bool, bool)> {
    let mut segs: Vec<(String, bool, bool)> = Vec::new();
    for (i, ch) in line.chars().enumerate() {
        let (b, it) = styles.get(off + i).copied().unwrap_or((false, false));
        match segs.last_mut() {
            Some(s) if s.1 == b && s.2 == it => s.0.push(ch),
            _ => segs.push((ch.to_string(), b, it)),
        }
    }
    segs
}

fn font_spec(size: f64, family: &str, bold: bool, italic: bool) -> String {
    format!(
        "{}{}{}px '{}', sans-serif",
        if italic { "italic " } else { "" },
        if bold { "700 " } else { "" },
        size,
        family
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ----- tools & interaction -----

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tool {
    Select,
    Frame,
    Rect,
    Ellipse,
    Text,
    Pen,
    Hand,
}

impl Tool {
    fn as_str(self) -> &'static str {
        match self {
            Tool::Select => "select",
            Tool::Frame => "frame",
            Tool::Rect => "rect",
            Tool::Ellipse => "ellipse",
            Tool::Text => "text",
            Tool::Pen => "pen",
            Tool::Hand => "hand",
        }
    }

    fn from_str(s: &str) -> Tool {
        match s {
            "frame" => Tool::Frame,
            "rect" => Tool::Rect,
            "ellipse" => Tool::Ellipse,
            "text" => Tool::Text,
            "pen" => Tool::Pen,
            "hand" => Tool::Hand,
            _ => Tool::Select,
        }
    }
}

/// Corner handles, clockwise from top-left.
const HANDLES: [(f64, f64); 4] = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];

enum Drag {
    None,
    Pan {
        last_x: f64,
        last_y: f64,
    },
    Draw {
        id: u32,
        ox: f64,
        oy: f64,
    },
    Move {
        starts: Vec<(u32, f64, f64)>,
        ox: f64,
        oy: f64,
        moved: bool,
        alt_copied: bool,
    },
    Resize {
        /// Clones of the selected nodes at drag start; live values are
        /// recomputed from these so repeated scaling never accumulates error.
        starts: Vec<Node>,
        bx: f64,
        by: f64,
        bw: f64,
        bh: f64,
        handle: usize,
        ox: f64,
        oy: f64,
    },
    Marquee {
        ox: f64,
        oy: f64,
        cx: f64,
        cy: f64,
    },
}

/// Vector edit mode: double-clicking a path exposes its anchors for
/// direct manipulation. Anchor selection is by index into `points`.
struct PathEdit {
    id: u32,
    selected: Vec<usize>,
    drag: PathDrag,
}

enum PathDrag {
    None,
    /// Moving every selected anchor. Positions are recomputed from the
    /// drag-start clones so snapping never accumulates drift.
    Anchors { starts: Vec<(usize, Anchor)>, ox: f64, oy: f64, moved: bool },
    /// Dragging one control handle; `broken` (alt) frees it from its
    /// mirror, otherwise the opposite handle stays collinear.
    Handle { idx: usize, out: bool, broken: bool, moved: bool },
    /// Rubber-band selecting anchors.
    Marquee { ox: f64, oy: f64, cx: f64, cy: f64 },
}

/// Screen-space grab radius for anchors and handle dots.
const ANCHOR_GRAB: f64 = 8.0;

fn nearest_anchor(points: &[Anchor], x: f64, y: f64, grab: f64) -> Option<usize> {
    points
        .iter()
        .enumerate()
        .map(|(i, a)| (i, (a.x - x).hypot(a.y - y)))
        .filter(|&(_, d)| d <= grab)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// Bezier circle constant: handle length factor for a quarter arc.
const KAPPA: f64 = 0.5522847498;

fn corner_anchor(x: f64, y: f64) -> Anchor {
    Anchor { x, y, hx_in: x, hy_in: y, hx_out: x, hy_out: y }
}

/// A rectangle as a closed contour; corner radius becomes bezier arcs.
fn rect_contour(x: f64, y: f64, w: f64, h: f64, radius: f64) -> Vec<Anchor> {
    let r = radius.min(w / 2.0).min(h / 2.0);
    if r <= 0.0 {
        return vec![
            corner_anchor(x, y),
            corner_anchor(x + w, y),
            corner_anchor(x + w, y + h),
            corner_anchor(x, y + h),
        ];
    }
    let k = r * KAPPA;
    let mut a = Vec::with_capacity(8);
    // Clockwise from the top-left arc end; each corner contributes the
    // two arc endpoints with one handle each.
    a.push(Anchor { x: x + r, y, hx_in: x + r - k, hy_in: y, hx_out: x + r, hy_out: y });
    a.push(Anchor { x: x + w - r, y, hx_in: x + w - r, hy_in: y, hx_out: x + w - r + k, hy_out: y });
    a.push(Anchor { x: x + w, y: y + r, hx_in: x + w, hy_in: y + r - k, hx_out: x + w, hy_out: y + r });
    a.push(Anchor { x: x + w, y: y + h - r, hx_in: x + w, hy_in: y + h - r, hx_out: x + w, hy_out: y + h - r + k });
    a.push(Anchor { x: x + w - r, y: y + h, hx_in: x + w - r + k, hy_in: y + h, hx_out: x + w - r, hy_out: y + h });
    a.push(Anchor { x: x + r, y: y + h, hx_in: x + r, hy_in: y + h, hx_out: x + r - k, hy_out: y + h });
    a.push(Anchor { x, y: y + h - r, hx_in: x, hy_in: y + h - r + k, hx_out: x, hy_out: y + h - r });
    a.push(Anchor { x, y: y + r, hx_in: x, hy_in: y + r, hx_out: x, hy_out: y + r - k });
    a
}

/// An ellipse as four smooth anchors with kappa handles.
fn ellipse_contour(x: f64, y: f64, w: f64, h: f64) -> Vec<Anchor> {
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    let (kx, ky) = (w / 2.0 * KAPPA, h / 2.0 * KAPPA);
    vec![
        Anchor { x: cx, y, hx_in: cx - kx, hy_in: y, hx_out: cx + kx, hy_out: y },
        Anchor { x: x + w, y: cy, hx_in: x + w, hy_in: cy - ky, hx_out: x + w, hy_out: cy + ky },
        Anchor { x: cx, y: y + h, hx_in: cx + kx, hy_in: y + h, hx_out: cx - kx, hy_out: y + h },
        Anchor { x, y: cy, hx_in: x, hy_in: cy + ky, hx_out: x, hy_out: cy - ky },
    ]
}

/// Collects a node's outline contours for flattening (groups recurse;
/// text and images have no vector outline and contribute nothing).
fn collect_contours(n: &Node, out: &mut Vec<Vec<Anchor>>) {
    match n.kind {
        NodeKind::Rect | NodeKind::Frame => out.push(rect_contour(n.x, n.y, n.w, n.h, n.corner_radius)),
        NodeKind::Ellipse => out.push(ellipse_contour(n.x, n.y, n.w, n.h)),
        NodeKind::Path => {
            out.push(n.points.clone());
            out.extend(n.inner.iter().cloned());
        }
        NodeKind::Group => {
            for c in &n.children {
                collect_contours(c, out);
            }
        }
        NodeKind::Text | NodeKind::Image => {}
    }
}

// ----- polygon boolean ops (Greiner-Hormann on flattened outlines) -----

/// Drops duplicate and collinear points so flattened straight edges
/// reduce back to their corners before clipping.
fn simplify_polygon(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    for &p in pts {
        if let Some(&last) = out.last() {
            if (p.0 - last.0).abs() < 1e-9 && (p.1 - last.1).abs() < 1e-9 {
                continue;
            }
        }
        out.push(p);
    }
    while out.len() > 1 && {
        let (a, b) = (out[0], *out.last().unwrap());
        (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9
    } {
        out.pop();
    }
    let n = out.len();
    if n < 3 {
        return out;
    }
    let mut keep = Vec::with_capacity(n);
    for i in 0..n {
        let p = out[(i + n - 1) % n];
        let c = out[i];
        let q = out[(i + 1) % n];
        let cross = (c.0 - p.0) * (q.1 - p.1) - (c.1 - p.1) * (q.0 - p.0);
        if cross.abs() > 1e-7 {
            keep.push(c);
        }
    }
    if keep.len() >= 3 { keep } else { out }
}

fn signed_area(p: &[(f64, f64)]) -> f64 {
    let n = p.len();
    let mut a = 0.0;
    for i in 0..n {
        let (x1, y1) = p[i];
        let (x2, y2) = p[(i + 1) % n];
        a += x1 * y2 - x2 * y1;
    }
    a / 2.0
}

struct GhVert {
    x: f64,
    y: f64,
    next: usize,
    prev: usize,
    neighbor: usize,
    intersect: bool,
    entry: bool,
    visited: bool,
}

/// Builds a doubly linked ring; returns the head index.
fn gh_ring(verts: &mut Vec<GhVert>, poly: &[(f64, f64)]) -> usize {
    let base = verts.len();
    let n = poly.len();
    for (i, &(x, y)) in poly.iter().enumerate() {
        verts.push(GhVert {
            x,
            y,
            next: base + (i + 1) % n,
            prev: base + (i + n - 1) % n,
            neighbor: usize::MAX,
            intersect: false,
            entry: false,
            visited: false,
        });
    }
    base
}

/// Pairwise boolean of two simple polygons. Output contours render under
/// the even-odd rule, so holes and disjoint pieces both come out right.
/// op: 0 = intersect, 1 = union, 2 = a minus b.
fn polygon_clip(pa: &[(f64, f64)], pb: &[(f64, f64)], op: u8) -> Vec<Vec<(f64, f64)>> {
    let mut a = simplify_polygon(pa);
    let mut b = simplify_polygon(pb);
    if a.len() < 3 || b.len() < 3 {
        return Vec::new();
    }
    // Normalize to counter-clockwise.
    if signed_area(&a) < 0.0 {
        a.reverse();
    }
    if signed_area(&b) < 0.0 {
        b.reverse();
    }

    let mut verts: Vec<GhVert> = Vec::new();
    let ha = gh_ring(&mut verts, &a);
    let hb = gh_ring(&mut verts, &b);
    let na = a.len();

    // Find all edge intersections; collect per original edge with the
    // parametric position so insertion order along the edge is right.
    let mut hits: Vec<(usize, usize, f64, f64, f64, f64)> = Vec::new(); // (ea, eb, ta, tb, x, y)
    for i in 0..na {
        let (a1, a2) = (a[i], a[(i + 1) % na]);
        for j in 0..b.len() {
            let (b1, b2) = (b[j], b[(j + 1) % b.len()]);
            let d = (a2.0 - a1.0) * (b2.1 - b1.1) - (a2.1 - a1.1) * (b2.0 - b1.0);
            if d.abs() < 1e-12 {
                continue;
            }
            let t = ((b1.0 - a1.0) * (b2.1 - b1.1) - (b1.1 - a1.1) * (b2.0 - b1.0)) / d;
            let u = ((b1.0 - a1.0) * (a2.1 - a1.1) - (b1.1 - a1.1) * (a2.0 - a1.0)) / d;
            let eps = 1e-9;
            if t > eps && t < 1.0 - eps && u > eps && u < 1.0 - eps {
                hits.push((i, j, t, u, a1.0 + t * (a2.0 - a1.0), a1.1 + t * (a2.1 - a1.1)));
            }
        }
    }

    if hits.is_empty() {
        // No crossings: containment decides everything.
        let a_in_b = point_in_polygon(&b, a[0].0, a[0].1);
        let b_in_a = point_in_polygon(&a, b[0].0, b[0].1);
        return match op {
            0 => {
                if a_in_b {
                    vec![a]
                } else if b_in_a {
                    vec![b]
                } else {
                    Vec::new()
                }
            }
            1 => {
                if a_in_b {
                    vec![b]
                } else if b_in_a {
                    vec![a]
                } else {
                    vec![a, b]
                }
            }
            _ => {
                if b_in_a {
                    vec![a, b] // hole under even-odd
                } else if a_in_b {
                    Vec::new()
                } else {
                    vec![a]
                }
            }
        };
    }

    // Insert intersection vertices into both rings, ordered along edges.
    let mut by_edge_a: Vec<Vec<(f64, usize)>> = vec![Vec::new(); na];
    let mut by_edge_b: Vec<Vec<(f64, usize)>> = vec![Vec::new(); b.len()];
    for &(ea, eb, ta, tb, x, y) in &hits {
        let ia = verts.len();
        verts.push(GhVert { x, y, next: 0, prev: 0, neighbor: ia + 1, intersect: true, entry: false, visited: false });
        let ib = verts.len();
        verts.push(GhVert { x, y, next: 0, prev: 0, neighbor: ia, intersect: true, entry: false, visited: false });
        by_edge_a[ea].push((ta, ia));
        by_edge_b[eb].push((tb, ib));
    }
    let splice = |verts: &mut Vec<GhVert>, head: usize, n: usize, by_edge: &mut Vec<Vec<(f64, usize)>>| {
        for (e, list) in by_edge.iter_mut().enumerate() {
            list.sort_by(|p, q| p.0.total_cmp(&q.0));
            let mut after = head + e;
            for &(_, v) in list.iter() {
                let nxt = verts[after].next;
                verts[after].next = v;
                verts[v].prev = after;
                verts[v].next = nxt;
                verts[nxt].prev = v;
                after = v;
            }
            let _ = n;
        }
    };
    splice(&mut verts, ha, na, &mut by_edge_a);
    splice(&mut verts, hb, b.len(), &mut by_edge_b);

    // Entry/exit flags: walk each ring, toggling containment in the
    // other polygon. Flipping a ring's flags complements that operand:
    // intersect flips neither, union flips both, A−B flips A only.
    let (flip_a, flip_b) = (op != 0, op == 1);
    let mark = |head: usize, other: &[(f64, f64)], flip: bool, verts: &mut Vec<GhVert>| {
        let mut inside = point_in_polygon(other, verts[head].x, verts[head].y);
        let mut v = verts[head].next;
        loop {
            if verts[v].intersect {
                verts[v].entry = if flip { inside } else { !inside };
                inside = !inside;
            }
            if v == head {
                break;
            }
            v = verts[v].next;
        }
        // head itself is never an intersection (original vertex).
    };
    mark(ha, &b, flip_a, &mut verts);
    mark(hb, &a, flip_b, &mut verts);

    // Trace result contours.
    let mut result = Vec::new();
    loop {
        let Some(start) = (0..verts.len()).find(|&i| verts[i].intersect && !verts[i].visited)
        else {
            break;
        };
        let mut contour = Vec::new();
        let mut cur = start;
        loop {
            verts[cur].visited = true;
            let nb = verts[cur].neighbor;
            verts[nb].visited = true;
            if verts[cur].entry {
                loop {
                    contour.push((verts[cur].x, verts[cur].y));
                    cur = verts[cur].next;
                    if verts[cur].intersect {
                        break;
                    }
                }
            } else {
                loop {
                    contour.push((verts[cur].x, verts[cur].y));
                    cur = verts[cur].prev;
                    if verts[cur].intersect {
                        break;
                    }
                }
            }
            verts[cur].visited = true;
            cur = verts[cur].neighbor;
            if cur == start || verts[cur].neighbor == start {
                break;
            }
        }
        let contour = simplify_polygon(&contour);
        if contour.len() >= 3 {
            result.push(contour);
        }
        if result.len() > 64 {
            break; // degenerate input: bail rather than loop forever
        }
    }
    result
}

/// Offsets a closed CCW polygon outward by `d` (inward for negative d)
/// with mitered joins, beveling spikes whose miter would run away.
fn offset_polygon(poly: &[(f64, f64)], d: f64) -> Vec<(f64, f64)> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let p = poly[(i + n - 1) % n];
        let c = poly[i];
        let q = poly[(i + 1) % n];
        // Unit normals of the two edges meeting at c (left-hand normals;
        // for shoelace-positive rings in screen space these point outward).
        let norm = |a: (f64, f64), b: (f64, f64)| -> (f64, f64) {
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len = dx.hypot(dy).max(1e-12);
            (dy / len, -dx / len)
        };
        let n1 = norm(p, c);
        let n2 = norm(c, q);
        let (mx, my) = (n1.0 + n2.0, n1.1 + n2.1);
        let dot = 1.0 + (n1.0 * n2.0 + n1.1 * n2.1);
        if dot < 0.25 {
            // Sharp spike: bevel with both edge-offset endpoints.
            out.push((c.0 + n1.0 * d, c.1 + n1.1 * d));
            out.push((c.0 + n2.0 * d, c.1 + n2.1 * d));
        } else {
            let scale = d / dot;
            out.push((c.0 + mx * scale, c.1 + my * scale));
        }
    }
    out
}

/// An in-progress pen path. Lives outside the document until committed,
/// so undo treats the whole path as one step.
struct PenState {
    anchors: Vec<Anchor>,
    /// Pointer position in world space, for the rubber-band preview.
    cur: (f64, f64),
    /// Dragging out the last anchor's handles (click-drag = smooth point).
    dragging: bool,
}

// ----- document & persistence -----

#[derive(Serialize, Deserialize)]
struct Document {
    version: u32,
    nodes: Vec<Node>,
    next_id: u32,
}

/// The v1 document format: flat nodes with a single `fill` color string.
mod v1 {
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct Document {
        pub nodes: Vec<Node>,
        pub next_id: u32,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Node {
        pub id: u32,
        pub name: String,
        pub kind: String,
        pub x: f64,
        pub y: f64,
        pub w: f64,
        pub h: f64,
        pub fill: String,
        pub opacity: f64,
        pub corner_radius: f64,
        pub text: String,
        pub font_size: f64,
    }
}

fn migrate_v1(doc: v1::Document) -> Document {
    let nodes = doc
        .nodes
        .into_iter()
        .map(|n| Node {
            id: n.id,
            name: n.name,
            kind: match n.kind.as_str() {
                "frame" => NodeKind::Frame,
                "ellipse" => NodeKind::Ellipse,
                "text" => NodeKind::Text,
                _ => NodeKind::Rect,
            },
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            visible: true,
            locked: false,
            fills: vec![Paint::solid(&n.fill, 1.0)],
            strokes: Vec::new(),
            stroke_weight: 1.0,
            opacity: n.opacity,
            blend_mode: default_blend_mode(),
            corner_radius: n.corner_radius,
            text: n.text,
            font_size: n.font_size,
            font_family: default_font_family(),
            text_align: default_text_align(),
            text_valign: default_text_valign(),
            image: String::new(),
            points: Vec::new(),
            closed: false,
            inner: Vec::new(),
            spans: Vec::new(),
            export_presets: Vec::new(),
            children: Vec::new(),
        })
        .collect();
    Document { version: DOC_VERSION, nodes, next_id: doc.next_id }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneInfo<'a> {
    nodes: &'a [Node],
    selection: &'a [u32],
    hovered: Option<u32>,
    tool: &'static str,
    zoom: f64,
    pan_x: f64,
    pan_y: f64,
    /// Id of the path in vector-edit mode, if any.
    path_edit: Option<u32>,
    generation: u32,
    doc_generation: u32,
}

/// A snap guide produced while dragging: a vertical or horizontal line in
/// world space, spanning the snapped boxes.
struct Guide {
    vertical: bool,
    pos: f64,
    from: f64,
    to: f64,
}

#[wasm_bindgen]
pub struct Engine {
    nodes: Vec<Node>,
    next_id: u32,
    selection: Vec<u32>,
    hovered: Option<u32>,
    tool: Tool,
    pan_x: f64,
    pan_y: f64,
    zoom: f64,
    drag: Drag,
    pen: Option<PenState>,
    path_edit: Option<PathEdit>,
    guides: Vec<Guide>,
    editing: Option<u32>,
    pending_undo: Option<Vec<Node>>,
    undo: Vec<Vec<Node>>,
    redo: Vec<Vec<Node>>,
    clipboard: Vec<Node>,
    /// Wrapped lines per text node, captured during canvas rendering
    /// (the only place real text measurement exists). SVG export reads
    /// this so its line breaks match what the user saw.
    text_layouts: RefCell<HashMap<u32, Vec<String>>>,
    generation: u32,
    doc_generation: u32,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        console_error_panic_hook::set_once();
        Engine {
            nodes: Vec::new(),
            next_id: 1,
            selection: Vec::new(),
            hovered: None,
            tool: Tool::Select,
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
            drag: Drag::None,
            pen: None,
            path_edit: None,
            guides: Vec::new(),
            editing: None,
            pending_undo: None,
            undo: Vec::new(),
            redo: Vec::new(),
            clipboard: Vec::new(),
            text_layouts: RefCell::new(HashMap::new()),
            generation: 0,
            doc_generation: 0,
        }
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Bumped only by document mutations (never hover/selection/camera);
    /// the autosave debounce keys off this.
    pub fn doc_generation(&self) -> u32 {
        self.doc_generation
    }

    pub fn scene(&self) -> String {
        serde_json::to_string(&SceneInfo {
            nodes: &self.nodes,
            selection: &self.selection,
            hovered: self.hovered,
            tool: self.tool.as_str(),
            zoom: self.zoom,
            pan_x: self.pan_x,
            pan_y: self.pan_y,
            path_edit: self.path_edit.as_ref().map(|p| p.id),
            generation: self.generation,
            doc_generation: self.doc_generation,
        })
        .unwrap_or_default()
    }

    // ----- document persistence & migration -----

    pub fn to_json(&self) -> String {
        serde_json::to_string(&Document {
            version: DOC_VERSION,
            nodes: self.nodes.clone(),
            next_id: self.next_id,
        })
        .unwrap_or_else(|_| EMPTY_DOC.to_string())
    }

    /// Loads a document, migrating older formats forward as needed.
    pub fn load_json(&mut self, json: &str) -> bool {
        let value: serde_json::Value = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
        let doc = if version >= 2 {
            match serde_json::from_value::<Document>(value) {
                Ok(d) => d,
                Err(_) => return false,
            }
        } else {
            match serde_json::from_value::<v1::Document>(value) {
                Ok(d) => migrate_v1(d),
                Err(_) => return false,
            }
        };
        self.nodes = doc.nodes;
        self.next_id = doc.next_id;
        recompute_group_bounds(&mut self.nodes);
        self.selection.clear();
        self.hovered = None;
        self.path_edit = None;
        self.undo.clear();
        self.redo.clear();
        self.touch();
        true
    }

    // ----- tools -----

    pub fn set_tool(&mut self, tool: &str) {
        let next = Tool::from_str(tool);
        // Leaving the pen tool commits whatever was drawn so far.
        if self.tool == Tool::Pen && next != Tool::Pen {
            self.finish_pen(false);
        }
        // Picking a drawing tool leaves vector-edit mode.
        if next != Tool::Select {
            self.path_edit = None;
        }
        self.tool = next;
        self.touch();
    }

    // ----- pen tool -----

    /// True while a pen path is being drawn (anchors placed, not committed).
    pub fn pen_active(&self) -> bool {
        self.pen.is_some()
    }

    /// Commits the in-progress pen path as an open path (Enter/Escape).
    pub fn pen_commit(&mut self) {
        self.finish_pen(false);
    }

    /// Turns the accumulated pen anchors into a path node (one undo step)
    /// and returns to the select tool. Fewer than two anchors = discard.
    fn finish_pen(&mut self, closed: bool) {
        let Some(pen) = self.pen.take() else {
            return;
        };
        if pen.anchors.len() < 2 {
            self.touch();
            return;
        }
        self.snapshot_now();
        let (x, y, w, h) = path_bounds(&pen.anchors, closed);
        let id = self.add_node(NodeKind::Path, x, y, w.max(1.0), h.max(1.0));
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.points = pen.anchors;
            n.closed = closed;
            // Open paths read as lines: stroke only. Closing adds the fill.
            if !closed {
                n.fills.clear();
            }
            n.strokes = vec![Paint::solid("#18181b", 1.0)];
        }
        // Same frame parenting rule as drawn shapes: center inside a frame
        // nests the path under it.
        let center = find_node(&self.nodes, id).map(|n| (n.x + n.w / 2.0, n.y + n.h / 2.0));
        if let Some((cx, cy)) = center {
            let target = self
                .nodes
                .iter()
                .rev()
                .find(|f| {
                    f.kind == NodeKind::Frame
                        && f.id != id
                        && f.visible
                        && !f.locked
                        && f.contains(cx, cy)
                })
                .map(|f| f.id);
            if let Some(fid) = target {
                if let Some(pos) = self.nodes.iter().position(|n| n.id == id) {
                    let node = self.nodes.remove(pos);
                    if let Some(f) = find_node_mut(&mut self.nodes, fid) {
                        f.children.push(node);
                    }
                }
            }
        }
        self.selection = vec![id];
        self.tool = Tool::Select;
        self.touch();
    }

    // ----- path editing (double-click a path) -----

    pub fn enter_path_edit(&mut self, id: u32) {
        let is_path =
            find_node(&self.nodes, id).map(|n| n.kind == NodeKind::Path).unwrap_or(false);
        if is_path {
            self.path_edit = Some(PathEdit { id, selected: Vec::new(), drag: PathDrag::None });
            self.selection = vec![id];
            self.hovered = None;
            self.touch();
        }
    }

    pub fn exit_path_edit(&mut self) {
        if self.path_edit.take().is_some() {
            self.touch();
        }
    }

    pub fn path_edit_active(&self) -> bool {
        self.path_edit.is_some()
    }

    /// Double-click on an anchor while editing toggles corner <-> smooth.
    /// Returns false when no anchor sits under the (screen-space) point.
    pub fn path_toggle_anchor(&mut self, sx: f64, sy: f64) -> bool {
        let (x, y) = self.to_world(sx, sy);
        let grab = ANCHOR_GRAB / self.zoom;
        let Some(pe) = &self.path_edit else {
            return false;
        };
        let id = pe.id;
        let Some(n) = find_node(&self.nodes, id) else {
            return false;
        };
        let Some(i) = nearest_anchor(&n.points, x, y, grab) else {
            return false;
        };
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let len = n.points.len();
            let a = &n.points[i];
            let smooth =
                a.hx_in != a.x || a.hy_in != a.y || a.hx_out != a.x || a.hy_out != a.y;
            if smooth {
                let a = &mut n.points[i];
                a.hx_in = a.x;
                a.hy_in = a.y;
                a.hx_out = a.x;
                a.hy_out = a.y;
            } else {
                // Corner -> smooth: collinear handles along the direction
                // between the neighbors, a third of each span long.
                let prev = if i == 0 { if n.closed { len - 1 } else { i } } else { i - 1 };
                let next = if i + 1 == len { if n.closed { 0 } else { i } } else { i + 1 };
                let (px, py) = (n.points[prev].x, n.points[prev].y);
                let (qx, qy) = (n.points[next].x, n.points[next].y);
                let a = &mut n.points[i];
                let (dx, dy) = (qx - px, qy - py);
                let d = dx.hypot(dy);
                if d > 0.0 {
                    let (ux, uy) = (dx / d, dy / d);
                    let dn = ((qx - a.x).hypot(qy - a.y) / 3.0).max(8.0);
                    let dp = ((px - a.x).hypot(py - a.y) / 3.0).max(8.0);
                    a.hx_out = a.x + ux * dn;
                    a.hy_out = a.y + uy * dn;
                    a.hx_in = a.x - ux * dp;
                    a.hy_in = a.y - uy * dp;
                }
            }
            sync_path_bounds(n);
        }
        recompute_group_bounds(&mut self.nodes);
        self.touch();
        true
    }

    fn path_edit_pointer_down(&mut self, x: f64, y: f64, shift: bool, alt: bool) {
        let grab = ANCHOR_GRAB / self.zoom;
        let Some(pe) = &self.path_edit else {
            return;
        };
        let id = pe.id;
        let selected = pe.selected.clone();
        let Some(n) = find_node(&self.nodes, id) else {
            self.path_edit = None;
            return;
        };

        // Handle dots first — only selected anchors show them, and they
        // can sit within an anchor's own grab radius.
        for &i in &selected {
            let Some(a) = n.points.get(i) else {
                continue;
            };
            for (hx, hy, out) in [(a.hx_out, a.hy_out, true), (a.hx_in, a.hy_in, false)] {
                if (hx != a.x || hy != a.y) && (hx - x).hypot(hy - y) <= grab {
                    self.begin_mutation();
                    let pe = self.path_edit.as_mut().unwrap();
                    pe.drag = PathDrag::Handle { idx: i, out, broken: alt, moved: false };
                    return;
                }
            }
        }
        if let Some(i) = nearest_anchor(&n.points, x, y, grab) {
            let pe = self.path_edit.as_mut().unwrap();
            if shift {
                if let Some(p) = pe.selected.iter().position(|&s| s == i) {
                    pe.selected.remove(p);
                } else {
                    pe.selected.push(i);
                }
            } else if !pe.selected.contains(&i) {
                pe.selected = vec![i];
            }
            self.begin_mutation();
            let starts: Vec<(usize, Anchor)> = {
                let pe = self.path_edit.as_ref().unwrap();
                let n = find_node(&self.nodes, pe.id).unwrap();
                pe.selected
                    .iter()
                    .filter_map(|&i| n.points.get(i).map(|a| (i, a.clone())))
                    .collect()
            };
            let pe = self.path_edit.as_mut().unwrap();
            pe.drag = PathDrag::Anchors { starts, ox: x, oy: y, moved: false };
            return;
        }
        // Empty space: rubber-band anchors.
        let pe = self.path_edit.as_mut().unwrap();
        if !shift {
            pe.selected.clear();
        }
        pe.drag = PathDrag::Marquee { ox: x, oy: y, cx: x, cy: y };
    }

    fn path_edit_pointer_move(&mut self, x: f64, y: f64) {
        let Some(pe) = &mut self.path_edit else {
            return;
        };
        let id = pe.id;
        match &mut pe.drag {
            PathDrag::None => {}
            PathDrag::Anchors { starts, ox, oy, moved } => {
                let (mut dx, mut dy) = (x - *ox, y - *oy);
                *moved = *moved || dx != 0.0 || dy != 0.0;
                let starts = starts.clone();
                let moved_idx: Vec<usize> = starts.iter().map(|s| s.0).collect();

                // Snap dragged anchors to the path's stationary anchors,
                // axis by axis (same scheme as node-move snapping).
                let threshold = 6.0 / self.zoom;
                self.guides.clear();
                // (delta, snapped pos, other point's cross-axis, own cross-axis)
                let mut best_x: Option<(f64, f64, f64, f64)> = None;
                let mut best_y: Option<(f64, f64, f64, f64)> = None;
                if let Some(n) = find_node(&self.nodes, id) {
                    for (j, c) in n.points.iter().enumerate() {
                        if moved_idx.contains(&j) {
                            continue;
                        }
                        for (_, s) in &starts {
                            let d = c.x - (s.x + dx);
                            if d.abs() < threshold
                                && best_x.map_or(true, |(bd, ..)| d.abs() < bd.abs())
                            {
                                best_x = Some((d, c.x, c.y, s.y + dy));
                            }
                            let d = c.y - (s.y + dy);
                            if d.abs() < threshold
                                && best_y.map_or(true, |(bd, ..)| d.abs() < bd.abs())
                            {
                                best_y = Some((d, c.y, c.x, s.x + dx));
                            }
                        }
                    }
                }
                dx += best_x.map_or(0.0, |b| b.0);
                dy += best_y.map_or(0.0, |b| b.0);

                if let Some(n) = find_node_mut(&mut self.nodes, id) {
                    for (i, s) in &starts {
                        if let Some(a) = n.points.get_mut(*i) {
                            a.x = s.x + dx;
                            a.y = s.y + dy;
                            a.hx_in = s.hx_in + dx;
                            a.hy_in = s.hy_in + dy;
                            a.hx_out = s.hx_out + dx;
                            a.hy_out = s.hy_out + dy;
                        }
                    }
                    sync_path_bounds(n);
                }
                recompute_group_bounds(&mut self.nodes);
                if let Some((_, pos, oc, sc)) = best_x {
                    self.guides.push(Guide {
                        vertical: true,
                        pos,
                        from: oc.min(sc),
                        to: oc.max(sc),
                    });
                }
                if let Some((_, pos, oc, sc)) = best_y {
                    self.guides.push(Guide {
                        vertical: false,
                        pos,
                        from: oc.min(sc),
                        to: oc.max(sc),
                    });
                }
            }
            PathDrag::Handle { idx, out, broken, moved } => {
                let (idx, out, broken) = (*idx, *out, *broken);
                *moved = true;

                // Snap the handle to anchor x/y lines — most usefully its
                // own anchor's, for flat horizontal/vertical tangents.
                let threshold = 6.0 / self.zoom;
                self.guides.clear();
                let (mut hx, mut hy) = (x, y);
                let mut gx: Option<(f64, f64)> = None; // pos, other cross-axis
                let mut gy: Option<(f64, f64)> = None;
                if let Some(n) = find_node(&self.nodes, id) {
                    let (mut bx, mut by) = (threshold, threshold);
                    for c in &n.points {
                        let d = (c.x - x).abs();
                        if d < bx {
                            bx = d;
                            hx = c.x;
                            gx = Some((c.x, c.y));
                        }
                        let d = (c.y - y).abs();
                        if d < by {
                            by = d;
                            hy = c.y;
                            gy = Some((c.y, c.x));
                        }
                    }
                }

                if let Some(n) = find_node_mut(&mut self.nodes, id) {
                    if let Some(a) = n.points.get_mut(idx) {
                        if out {
                            a.hx_out = hx;
                            a.hy_out = hy;
                        } else {
                            a.hx_in = hx;
                            a.hy_in = hy;
                        }
                        if !broken {
                            // Keep the opposite handle collinear without
                            // changing its length.
                            let (ox, oy) =
                                if out { (a.hx_in, a.hy_in) } else { (a.hx_out, a.hy_out) };
                            let olen = (ox - a.x).hypot(oy - a.y);
                            let dlen = (hx - a.x).hypot(hy - a.y);
                            if olen > 0.0 && dlen > 0.0 {
                                let (ux, uy) = ((hx - a.x) / dlen, (hy - a.y) / dlen);
                                if out {
                                    a.hx_in = a.x - ux * olen;
                                    a.hy_in = a.y - uy * olen;
                                } else {
                                    a.hx_out = a.x - ux * olen;
                                    a.hy_out = a.y - uy * olen;
                                }
                            }
                        }
                    }
                    sync_path_bounds(n);
                }
                recompute_group_bounds(&mut self.nodes);
                if let Some((pos, oc)) = gx {
                    self.guides.push(Guide {
                        vertical: true,
                        pos,
                        from: oc.min(hy),
                        to: oc.max(hy),
                    });
                }
                if let Some((pos, oc)) = gy {
                    self.guides.push(Guide {
                        vertical: false,
                        pos,
                        from: oc.min(hx),
                        to: oc.max(hx),
                    });
                }
            }
            PathDrag::Marquee { ox, oy, cx, cy } => {
                *cx = x;
                *cy = y;
                let (mx, my) = (ox.min(*cx), oy.min(*cy));
                let (mw, mh) = ((*cx - *ox).abs(), (*cy - *oy).abs());
                if let Some(n) = find_node(&self.nodes, id) {
                    pe.selected = n
                        .points
                        .iter()
                        .enumerate()
                        .filter(|(_, a)| {
                            a.x >= mx && a.x <= mx + mw && a.y >= my && a.y <= my + mh
                        })
                        .map(|(i, _)| i)
                        .collect();
                }
            }
        }
    }

    fn path_edit_pointer_up(&mut self) {
        let Some(pe) = &mut self.path_edit else {
            return;
        };
        let commit = match std::mem::replace(&mut pe.drag, PathDrag::None) {
            PathDrag::Anchors { moved, .. } => moved,
            PathDrag::Handle { moved, .. } => moved,
            _ => false,
        };
        if commit {
            self.commit_mutation();
        } else {
            self.pending_undo = None;
        }
        self.guides.clear();
        self.touch();
    }

    /// Drops edit state whose node disappeared or shrank (undo, deletes).
    fn validate_path_edit(&mut self) {
        if let Some(pe) = &self.path_edit {
            match find_node(&self.nodes, pe.id) {
                Some(n) if n.kind == NodeKind::Path => {
                    let len = n.points.len();
                    if let Some(pe) = &mut self.path_edit {
                        pe.selected.retain(|&i| i < len);
                    }
                }
                _ => self.path_edit = None,
            }
        }
    }

    // ----- pointer input (screen coordinates) -----

    pub fn pointer_down(&mut self, sx: f64, sy: f64, shift: bool, alt: bool) {
        let (x, y) = self.to_world(sx, sy);
        match self.tool {
            Tool::Hand => {
                self.drag = Drag::Pan { last_x: sx, last_y: sy };
            }
            Tool::Select => {
                if self.path_edit.is_some() {
                    self.path_edit_pointer_down(x, y, shift, alt);
                    self.touch();
                    return;
                }
                // Resize handles take priority, then frame labels, then
                // nodes, then marquee.
                if let Some(handle) = self.handle_at(sx, sy) {
                    let ids = self.selection.clone();
                    let (bx, by, bx2, by2) = self.selection_bbox(&ids).unwrap();
                    let starts: Vec<Node> =
                        ids.iter().filter_map(|&id| find_node(&self.nodes, id).cloned()).collect();
                    self.begin_mutation();
                    self.drag = Drag::Resize {
                        starts,
                        bx,
                        by,
                        bw: bx2 - bx,
                        bh: by2 - by,
                        handle,
                        ox: x,
                        oy: y,
                    };
                } else if let Some(id) = self.hit_test(x, y).or_else(|| self.frame_label_hit(sx, sy)) {
                    if shift {
                        if let Some(i) = self.selection.iter().position(|&s| s == id) {
                            self.selection.remove(i);
                        } else {
                            self.selection.push(id);
                        }
                    } else if !self.selection.contains(&id) {
                        self.selection = vec![id];
                    }
                    self.begin_mutation();
                    // Option-drag: duplicate in place and drag the copies;
                    // the originals stay put.
                    if alt {
                        let mut new_ids = Vec::new();
                        for sid in self.selection.clone() {
                            if let Some(path) = path_to(&self.nodes, sid) {
                                let index = *path.last().unwrap();
                                let list = list_at(&mut self.nodes, &path);
                                let mut copy = list[index].clone();
                                assign_fresh_ids(&mut copy, &mut self.next_id);
                                new_ids.push(copy.id);
                                list.insert(index + 1, copy);
                            }
                        }
                        self.selection = new_ids;
                    }
                    let starts = self
                        .selection
                        .iter()
                        .filter_map(|&sid| find_node(&self.nodes, sid).map(|n| (sid, n.x, n.y)))
                        .collect();
                    self.drag = Drag::Move { starts, ox: x, oy: y, moved: false, alt_copied: alt };
                } else {
                    if !shift {
                        self.selection.clear();
                    }
                    self.drag = Drag::Marquee { ox: x, oy: y, cx: x, cy: y };
                }
                self.touch();
            }
            Tool::Pen => {
                // Clicking the first anchor again closes the path.
                let close_tol = 6.0 / self.zoom;
                if let Some(pen) = &self.pen {
                    if pen.anchors.len() >= 2 {
                        let f = &pen.anchors[0];
                        if (x - f.x).hypot(y - f.y) <= close_tol {
                            self.finish_pen(true);
                            return;
                        }
                    }
                }
                let pen = self.pen.get_or_insert_with(|| PenState {
                    anchors: Vec::new(),
                    cur: (x, y),
                    dragging: false,
                });
                pen.anchors.push(Anchor {
                    x,
                    y,
                    hx_in: x,
                    hy_in: y,
                    hx_out: x,
                    hy_out: y,
                });
                pen.dragging = true;
                self.touch();
            }
            tool => {
                self.begin_mutation();
                let kind = match tool {
                    Tool::Frame => NodeKind::Frame,
                    Tool::Ellipse => NodeKind::Ellipse,
                    Tool::Text => NodeKind::Text,
                    _ => NodeKind::Rect,
                };
                let id = self.add_node(kind, x, y, 0.0, 0.0);
                self.selection = vec![id];
                self.drag = Drag::Draw { id, ox: x, oy: y };
                self.touch();
            }
        }
    }

    pub fn pointer_move(&mut self, sx: f64, sy: f64) {
        let (x, y) = self.to_world(sx, sy);
        if self.tool == Tool::Pen {
            if let Some(pen) = &mut self.pen {
                pen.cur = (x, y);
                if pen.dragging {
                    // Drag out symmetric handles: a smooth anchor.
                    if let Some(a) = pen.anchors.last_mut() {
                        a.hx_out = x;
                        a.hy_out = y;
                        a.hx_in = 2.0 * a.x - x;
                        a.hy_in = 2.0 * a.y - y;
                    }
                }
                self.touch();
            }
            return;
        }
        if self.path_edit.is_some() {
            self.path_edit_pointer_move(x, y);
            self.touch();
            return;
        }
        match &mut self.drag {
            Drag::None => {
                let hit = if self.tool == Tool::Select { self.hit_test(x, y) } else { None };
                if hit != self.hovered {
                    self.hovered = hit;
                    self.touch();
                }
                return;
            }
            Drag::Pan { last_x, last_y } => {
                self.pan_x += sx - *last_x;
                self.pan_y += sy - *last_y;
                *last_x = sx;
                *last_y = sy;
            }
            Drag::Draw { id, ox, oy } => {
                let (id, ox, oy) = (*id, *ox, *oy);
                if let Some(n) = find_node_mut(&mut self.nodes, id) {
                    n.x = ox.min(x);
                    n.y = oy.min(y);
                    n.w = (x - ox).abs();
                    n.h = (y - oy).abs();
                }
            }
            Drag::Move { starts, ox, oy, moved, .. } => {
                let (dx, dy) = (x - *ox, y - *oy);
                *moved = *moved || dx.abs() > 0.01 || dy.abs() > 0.01;
                let updates: Vec<(u32, f64, f64)> =
                    starts.iter().map(|&(id, nx, ny)| (id, nx + dx, ny + dy)).collect();
                let ids: Vec<u32> = starts.iter().map(|s| s.0).collect();
                for (id, nx, ny) in updates {
                    if let Some(n) = find_node_mut(&mut self.nodes, id) {
                        let (ddx, ddy) = (nx - n.x, ny - n.y);
                        shift_subtree(n, ddx, ddy);
                    }
                }
                recompute_group_bounds(&mut self.nodes);
                self.apply_snapping(&ids);
            }
            Drag::Resize { starts, bx, by, bw, bh, handle, ox, oy } => {
                let (dx, dy) = (x - *ox, y - *oy);
                let (hx, hy) = HANDLES[*handle];
                // A corner drag moves the edge(s) it sits on; the opposite
                // corner stays anchored.
                let (mut nx, mut nw) = if hx == 0.0 {
                    (*bx + dx, *bw - dx)
                } else {
                    (*bx, *bw + dx)
                };
                let (mut ny, mut nh) = if hy == 0.0 {
                    (*by + dy, *bh - dy)
                } else {
                    (*by, *bh + dy)
                };
                if nw < 0.0 {
                    nx += nw;
                    nw = -nw;
                }
                if nh < 0.0 {
                    ny += nh;
                    nh = -nh;
                }
                let fx = if *bw > 0.0 { nw / *bw } else { 1.0 };
                let fy = if *bh > 0.0 { nh / *bh } else { 1.0 };
                let (obx, oby) = (*bx, *by);
                let scaled: Vec<Node> = starts
                    .iter()
                    .map(|s| {
                        let mut c = s.clone();
                        scale_subtree(&mut c, obx, oby, nx, ny, fx, fy);
                        c
                    })
                    .collect();
                for c in scaled {
                    if let Some(slot) = find_node_mut(&mut self.nodes, c.id) {
                        *slot = c;
                    }
                }
                recompute_group_bounds(&mut self.nodes);
            }
            Drag::Marquee { ox, oy, cx, cy } => {
                *cx = x;
                *cy = y;
                let (mx, my) = (ox.min(*cx), oy.min(*cy));
                let (mw, mh) = ((*cx - *ox).abs(), (*cy - *oy).abs());
                self.selection = self
                    .nodes
                    .iter()
                    .filter(|n| n.visible && !n.locked && n.intersects(mx, my, mw, mh))
                    .map(|n| n.id)
                    .collect();
            }
        }
        self.touch();
    }

    pub fn pointer_up(&mut self) {
        if self.tool == Tool::Pen {
            if let Some(pen) = &mut self.pen {
                if pen.dragging {
                    pen.dragging = false;
                    // A barely-moved drag is a click: keep it a corner.
                    let tol = 2.0 / self.zoom;
                    if let Some(a) = pen.anchors.last_mut() {
                        if (a.hx_out - a.x).hypot(a.hy_out - a.y) < tol {
                            a.hx_in = a.x;
                            a.hy_in = a.y;
                            a.hx_out = a.x;
                            a.hy_out = a.y;
                        }
                    }
                    self.touch();
                }
            }
            return;
        }
        if self.path_edit.is_some() {
            self.path_edit_pointer_up();
            return;
        }
        match std::mem::replace(&mut self.drag, Drag::None) {
            Drag::Draw { id, .. } => {
                if let Some(n) = find_node_mut(&mut self.nodes, id) {
                    // A click without a drag places a default-sized node.
                    if n.w < 4.0 && n.h < 4.0 {
                        let (w, h) = match n.kind {
                            NodeKind::Frame => (400.0, 300.0),
                            NodeKind::Text => (160.0, 24.0),
                            _ => (100.0, 100.0),
                        };
                        n.w = w;
                        n.h = h;
                    }
                    round_subtree(n);
                }
                // Drawing inside a frame parents the new shape to it
                // (children keep absolute coordinates, so no translation).
                let center = find_node(&self.nodes, id)
                    .filter(|n| n.kind != NodeKind::Frame)
                    .map(|n| (n.x + n.w / 2.0, n.y + n.h / 2.0));
                if let Some((cx, cy)) = center {
                    let target = self
                        .nodes
                        .iter()
                        .rev()
                        .find(|f| {
                            f.kind == NodeKind::Frame
                                && f.id != id
                                && f.visible
                                && !f.locked
                                && f.contains(cx, cy)
                        })
                        .map(|f| f.id);
                    if let Some(fid) = target {
                        if let Some(pos) = self.nodes.iter().position(|n| n.id == id) {
                            let node = self.nodes.remove(pos);
                            if let Some(f) = find_node_mut(&mut self.nodes, fid) {
                                f.children.push(node);
                            }
                        }
                    }
                }
                self.commit_mutation();
                self.tool = Tool::Select;
            }
            Drag::Move { starts, moved, alt_copied, .. } => {
                if moved {
                    for (id, _, _) in starts {
                        if let Some(n) = find_node_mut(&mut self.nodes, id) {
                            round_subtree(n);
                        }
                    }
                    recompute_group_bounds(&mut self.nodes);
                    self.commit_mutation();
                } else if alt_copied {
                    // Option-click without a drag: discard the staged copies.
                    if let Some(snap) = self.pending_undo.take() {
                        self.nodes = snap;
                        self.retain_valid_selection();
                    }
                } else {
                    self.pending_undo = None;
                }
            }
            Drag::Resize { starts, .. } => {
                for s in starts {
                    if let Some(n) = find_node_mut(&mut self.nodes, s.id) {
                        round_subtree(n);
                    }
                }
                recompute_group_bounds(&mut self.nodes);
                self.commit_mutation();
            }
            _ => {
                self.pending_undo = None;
            }
        }
        self.guides.clear();
        self.touch();
    }

    /// Returns a CSS cursor for the current pointer position.
    pub fn cursor(&self, sx: f64, sy: f64) -> String {
        match self.tool {
            Tool::Hand => {
                if matches!(self.drag, Drag::Pan { .. }) { "grabbing" } else { "grab" }
            }
            Tool::Text => "text",
            Tool::Select => match self.handle_at(sx, sy) {
                Some(0) | Some(2) => "nwse-resize",
                Some(_) => "nesw-resize",
                None => "default",
            },
            _ => "crosshair",
        }
        .to_string()
    }

    // ----- camera -----

    pub fn wheel(&mut self, dx: f64, dy: f64, zooming: bool, cx: f64, cy: f64) {
        if zooming {
            let factor = (-dy * 0.01).exp();
            self.zoom_around(self.zoom * factor, cx, cy);
        } else {
            self.pan_x -= dx;
            self.pan_y -= dy;
        }
        self.touch();
    }

    pub fn set_zoom(&mut self, zoom: f64, cx: f64, cy: f64) {
        self.zoom_around(zoom, cx, cy);
        self.touch();
    }

    pub fn zoom(&self) -> f64 {
        self.zoom
    }

    pub fn zoom_to_fit(&mut self, vw: f64, vh: f64) {
        if self.nodes.is_empty() {
            self.pan_x = vw / 2.0;
            self.pan_y = vh / 2.0;
            self.zoom = 1.0;
        } else {
            let min_x = self.nodes.iter().map(|n| n.x).fold(f64::MAX, f64::min);
            let min_y = self.nodes.iter().map(|n| n.y).fold(f64::MAX, f64::min);
            let max_x = self.nodes.iter().map(|n| n.x + n.w).fold(f64::MIN, f64::max);
            let max_y = self.nodes.iter().map(|n| n.y + n.h).fold(f64::MIN, f64::max);
            let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
            let margin = 64.0;
            self.zoom = ((vw - margin * 2.0) / bw)
                .min((vh - margin * 2.0) / bh)
                .clamp(0.05, 4.0);
            self.pan_x = (vw - bw * self.zoom) / 2.0 - min_x * self.zoom;
            self.pan_y = (vh - bh * self.zoom) / 2.0 - min_y * self.zoom;
        }
        self.touch();
    }

    // ----- selection -----

    pub fn select(&mut self, id: u32, shift: bool) {
        if shift {
            if let Some(i) = self.selection.iter().position(|&s| s == id) {
                self.selection.remove(i);
            } else {
                self.selection.push(id);
            }
        } else {
            self.selection = vec![id];
        }
        self.touch();
    }

    pub fn clear_selection(&mut self) {
        self.selection.clear();
        self.touch();
    }

    // ----- field edits (panel-driven) -----

    pub fn set_field(&mut self, id: u32, field: &str, value: f64) {
        self.snapshot_now();
        self.apply_field(id, field, value);
        self.touch();
    }

    // Scrubbing a number control fires many value changes that must
    // coalesce into a single undo step: begin_edit stages one snapshot,
    // set_field_live applies values without snapshotting, commit_edit
    // pushes the staged snapshot onto the undo stack.

    pub fn begin_edit(&mut self) {
        self.pending_undo = Some(self.nodes.clone());
    }

    pub fn set_field_live(&mut self, id: u32, field: &str, value: f64) {
        self.apply_field(id, field, value);
        self.touch_doc();
        self.touch();
    }

    pub fn commit_edit(&mut self) {
        if let Some(snap) = self.pending_undo.take() {
            self.undo.push(snap);
            self.redo.clear();
        }
        self.touch();
    }

    fn apply_field(&mut self, id: u32, field: &str, value: f64) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            match field {
                // Moving a group moves its subtree; its size is derived.
                "x" => {
                    let dx = value - n.x;
                    shift_subtree(n, dx, 0.0);
                }
                "y" => {
                    let dy = value - n.y;
                    shift_subtree(n, 0.0, dy);
                }
                // Resizing a path scales its anchors about the box origin.
                "w" if n.kind == NodeKind::Path => {
                    let f = value.max(1.0) / n.w.max(1.0);
                    let (bx, by) = (n.x, n.y);
                    scale_subtree(n, bx, by, bx, by, f, 1.0);
                    sync_path_bounds(n);
                }
                "h" if n.kind == NodeKind::Path => {
                    let f = value.max(1.0) / n.h.max(1.0);
                    let (bx, by) = (n.x, n.y);
                    scale_subtree(n, bx, by, bx, by, 1.0, f);
                    sync_path_bounds(n);
                }
                "w" if n.kind != NodeKind::Group => n.w = value.max(1.0),
                "h" if n.kind != NodeKind::Group => n.h = value.max(1.0),
                "opacity" => n.opacity = value.clamp(0.0, 1.0),
                "cornerRadius" => n.corner_radius = value.max(0.0),
                "fontSize" => n.font_size = value.max(1.0),
                "strokeWeight" => n.stroke_weight = value.max(0.0),
                _ => {}
            }
        }
        recompute_group_bounds(&mut self.nodes);
    }

    // ----- paints -----

    pub fn add_paint(&mut self, id: u32, kind: &str) {
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let paint = Paint::solid("#d4d4d8", 1.0);
            if kind == "strokes" {
                n.strokes.push(Paint::solid("#18181b", 1.0));
            } else {
                n.fills.push(paint);
            }
        }
        self.touch();
    }

    pub fn remove_paint(&mut self, id: u32, kind: &str, index: usize) {
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let list = if kind == "strokes" { &mut n.strokes } else { &mut n.fills };
            if index < list.len() {
                list.remove(index);
            }
        }
        self.touch();
    }

    pub fn update_paint(&mut self, id: u32, kind: &str, index: usize, color: &str, opacity: f64) {
        self.snapshot_now();
        self.update_paint_live(id, kind, index, color, opacity);
    }

    /// Live paint update during a color-picker drag: no undo snapshot —
    /// wrap the gesture in begin_edit/commit_edit so it coalesces into a
    /// single undo step (same contract as set_field_live).
    pub fn update_paint_live(
        &mut self,
        id: u32,
        kind: &str,
        index: usize,
        color: &str,
        opacity: f64,
    ) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let list = if kind == "strokes" { &mut n.strokes } else { &mut n.fills };
            if let Some(p) = list.get_mut(index) {
                p.color = color.to_string();
                p.opacity = opacity.clamp(0.0, 1.0);
                p.kind = default_paint_kind();
                p.stops.clear();
            }
        }
        self.touch();
    }

    /// Turns fills[index] into a gradient ("linear" or "radial").
    /// `stops_json` is a JSON array of { position, color }; fewer than
    /// two stops are rejected.
    pub fn set_paint_gradient(
        &mut self,
        id: u32,
        index: usize,
        kind: &str,
        angle: f64,
        stops_json: &str,
    ) {
        if !["linear", "radial"].contains(&kind) {
            return;
        }
        let Ok(stops) = serde_json::from_str::<Vec<GradientStop>>(stops_json) else {
            return;
        };
        if stops.len() < 2 {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            if let Some(p) = n.fills.get_mut(index) {
                p.kind = kind.to_string();
                p.angle = angle;
                p.color = stops[0].color.clone();
                p.stops = stops;
            }
        }
        self.touch();
    }

    /// Sets a node's blend mode (one of the CSS blend modes; "normal"
    /// resets). Unknown values are ignored.
    pub fn set_blend_mode(&mut self, id: u32, mode: &str) {
        if !BLEND_MODES.contains(&mode) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.blend_mode = mode.to_string();
        }
        self.touch();
    }

    pub fn set_font_family(&mut self, id: u32, family: &str) {
        let family = family.trim();
        if family.is_empty() || family.len() > 80 || family.contains(['\'', '"', ';']) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.font_family = family.to_string();
        }
        self.touch();
    }

    pub fn set_text_align(&mut self, id: u32, align: &str) {
        if !["left", "center", "right"].contains(&align) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.text_align = align.to_string();
        }
        self.touch();
    }

    pub fn set_text_valign(&mut self, id: u32, valign: &str) {
        if !["top", "middle", "bottom"].contains(&valign) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.text_valign = valign.to_string();
        }
        self.touch();
    }

    // ----- visibility & locking -----

    pub fn set_visible(&mut self, id: u32, visible: bool) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.visible = visible;
        }
        self.touch_doc();
        self.touch();
    }

    pub fn set_locked(&mut self, id: u32, locked: bool) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.locked = locked;
        }
        self.touch_doc();
        self.touch();
    }

    pub fn set_name(&mut self, id: u32, name: &str) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.name = name.to_string();
        }
        self.touch_doc();
        self.touch();
    }

    pub fn set_text(&mut self, id: u32, text: &str) {
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.text = text.to_string();
            // Spans address char offsets; clamp them to the new text.
            let len = n.text.chars().count();
            for s in &mut n.spans {
                s.start = s.start.min(len);
                s.len = s.len.min(len - s.start);
            }
            n.spans.retain(|s| s.len > 0);
        }
        self.touch();
    }

    /// Toggles bold/italic over a char range of a text node. Spans are
    /// rebuilt from a per-char style map, so overlaps merge and split
    /// cleanly no matter how ranges are applied.
    pub fn set_span_style(&mut self, id: u32, start: usize, len: usize, field: &str, on: bool) {
        if len == 0 || !["bold", "italic"].contains(&field) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let chars = n.text.chars().count();
            let mut styles = vec![(false, false); chars];
            for s in &n.spans {
                for c in styles.iter_mut().skip(s.start).take(s.len) {
                    c.0 |= s.bold;
                    c.1 |= s.italic;
                }
            }
            for c in styles.iter_mut().skip(start).take(len.min(chars.saturating_sub(start))) {
                if field == "bold" {
                    c.0 = on;
                } else {
                    c.1 = on;
                }
            }
            n.spans = run_length_spans(&styles);
        }
        self.touch();
    }

    // ----- grouping -----

    /// Groups the selection. All selected nodes must share a parent list;
    /// the group lands at the topmost member's z-position.
    pub fn group_selection(&mut self) {
        if self.selection.len() < 2 {
            return;
        }
        let mut paths: Vec<Vec<usize>> = Vec::new();
        for &id in &self.selection {
            match path_to(&self.nodes, id) {
                Some(p) => paths.push(p),
                None => return,
            }
        }
        let parent = paths[0][..paths[0].len() - 1].to_vec();
        if !paths.iter().all(|p| p[..p.len() - 1] == parent[..]) {
            return;
        }
        self.snapshot_now();

        let mut indices: Vec<usize> = paths.iter().map(|p| *p.last().unwrap()).collect();
        indices.sort_unstable();
        let insert_at = indices[indices.len() - 1] + 1 - indices.len();

        // Take children out in z-order (bottom to top).
        let full_parent_path = {
            let mut p = parent.clone();
            p.push(0); // dummy leaf so list_at returns the parent's list
            p
        };
        let list = list_at(&mut self.nodes, &full_parent_path);
        let mut children = Vec::new();
        for &i in indices.iter().rev() {
            children.insert(0, list.remove(i));
        }

        let id = self.next_id;
        self.next_id += 1;
        let name = format!("Group {}", count_kind(&self.nodes, NodeKind::Group) + 1);
        let mut group = Node {
            id,
            name,
            kind: NodeKind::Group,
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
            visible: true,
            locked: false,
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_weight: 1.0,
            opacity: 1.0,
            blend_mode: default_blend_mode(),
            corner_radius: 0.0,
            text: String::new(),
            font_size: 16.0,
            font_family: default_font_family(),
            text_align: default_text_align(),
            text_valign: default_text_valign(),
            image: String::new(),
            points: Vec::new(),
            closed: false,
            inner: Vec::new(),
            spans: Vec::new(),
            export_presets: Vec::new(),
            children,
        };
        recompute_group_bounds(std::slice::from_mut(&mut group));

        let list = list_at(&mut self.nodes, &full_parent_path);
        list.insert(insert_at.min(list.len()), group);
        self.selection = vec![id];
        self.touch();
    }

    /// Dissolves selected groups, splicing children back in place.
    pub fn ungroup_selection(&mut self) {
        let group_ids: Vec<u32> = self
            .selection
            .iter()
            .copied()
            .filter(|&id| {
                find_node(&self.nodes, id).map(|n| n.kind == NodeKind::Group).unwrap_or(false)
            })
            .collect();
        if group_ids.is_empty() {
            return;
        }
        self.snapshot_now();
        let mut new_selection = Vec::new();
        for id in group_ids {
            if let Some(path) = path_to(&self.nodes, id) {
                let index = *path.last().unwrap();
                let list = list_at(&mut self.nodes, &path);
                let group = list.remove(index);
                new_selection.extend(group.children.iter().map(|c| c.id));
                for (offset, child) in group.children.into_iter().enumerate() {
                    list.insert(index + offset, child);
                }
            }
        }
        recompute_group_bounds(&mut self.nodes);
        self.selection = new_selection;
        self.touch();
    }

    // ----- flatten & frame selection -----

    /// Merges the selected shapes into one path node whose contours fill
    /// under the even-odd rule (overlaps become holes — Figma's classic
    /// flatten look). Open paths are closed; text and images are skipped.
    pub fn flatten_selection(&mut self) {
        let mut contours: Vec<Vec<Anchor>> = Vec::new();
        let mut donors: Vec<u32> = Vec::new();
        let mut style: Option<Node> = None;
        for &id in &self.selection {
            if let Some(n) = find_node(&self.nodes, id) {
                let before = contours.len();
                collect_contours(n, &mut contours);
                contours.retain(|c| c.len() >= 2);
                if contours.len() > before {
                    donors.push(id);
                    if style.is_none() {
                        style = Some(n.clone());
                    }
                }
            }
        }
        let (Some(style), Some(&first)) = (style, donors.first()) else {
            return;
        };
        self.snapshot_now();

        // The flattened path takes the first donor's place in z-order.
        let insert_path = path_to(&self.nodes, first).unwrap();
        let insert_at = *insert_path.last().unwrap();
        let id = self.next_id;
        self.next_id += 1;
        let mut node = Node {
            id,
            name: format!("Path {}", count_kind(&self.nodes, NodeKind::Path) + 1),
            kind: NodeKind::Path,
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
            visible: true,
            locked: false,
            fills: if style.fills.is_empty() && style.kind != NodeKind::Path {
                vec![Paint::solid("#d4d4d8", 1.0)]
            } else {
                style.fills.clone()
            },
            strokes: style.strokes.clone(),
            stroke_weight: style.stroke_weight,
            opacity: style.opacity,
            blend_mode: style.blend_mode.clone(),
            corner_radius: 0.0,
            text: String::new(),
            font_size: 16.0,
            font_family: default_font_family(),
            text_align: default_text_align(),
            text_valign: default_text_valign(),
            image: String::new(),
            points: contours.remove(0),
            closed: true,
            inner: contours,
            spans: Vec::new(),
            export_presets: Vec::new(),
            children: Vec::new(),
        };
        sync_path_bounds(&mut node);
        let list = list_at(&mut self.nodes, &insert_path);
        list.insert(insert_at.min(list.len()), node);

        for did in donors {
            if let Some(p) = path_to(&self.nodes, did) {
                let i = *p.last().unwrap();
                list_at(&mut self.nodes, &p).remove(i);
            }
        }
        dissolve_empty_groups(&mut self.nodes);
        recompute_group_bounds(&mut self.nodes);
        self.selection = vec![id];
        self.path_edit = None;
        self.touch();
    }

    /// Pairwise pathfinder op on exactly two selected shapes: "union",
    /// "subtract" (top shape removed from the bottom one) or "intersect".
    /// Operates on the flattened outer outlines; the result is a
    /// multi-contour even-odd path, so holes and split pieces both work.
    pub fn boolean_selection(&mut self, op: &str) {
        let opcode = match op {
            "intersect" => 0,
            "union" => 1,
            "subtract" => 2,
            _ => return,
        };
        if self.selection.len() != 2 {
            return;
        }
        // Subject = the lower shape in z-order (Figma semantics).
        let (mut sa, mut sb) = (self.selection[0], self.selection[1]);
        let (pa, pb) = match (path_to(&self.nodes, sa), path_to(&self.nodes, sb)) {
            (Some(a), Some(b)) => (a, b),
            _ => return,
        };
        if pb < pa {
            std::mem::swap(&mut sa, &mut sb);
        }
        let outline = |id: u32, nodes: &[Node]| -> Option<Vec<(f64, f64)>> {
            let n = find_node(nodes, id)?;
            let mut contours = Vec::new();
            collect_contours(n, &mut contours);
            let first = contours.into_iter().find(|c| c.len() >= 2)?;
            Some(flatten_path(&first, true))
        };
        let (Some(poly_a), Some(poly_b)) = (outline(sa, &self.nodes), outline(sb, &self.nodes))
        else {
            return;
        };
        let mut out = polygon_clip(&poly_a, &poly_b, opcode);
        if out.is_empty() {
            return;
        }
        self.snapshot_now();

        let style = find_node(&self.nodes, sa).unwrap().clone();
        let insert_path = path_to(&self.nodes, sa).unwrap();
        let insert_at = *insert_path.last().unwrap();
        let id = self.next_id;
        self.next_id += 1;
        let to_anchors = |c: Vec<(f64, f64)>| -> Vec<Anchor> {
            c.into_iter().map(|(x, y)| corner_anchor(x, y)).collect()
        };
        let mut node = Node {
            id,
            name: format!("Path {}", count_kind(&self.nodes, NodeKind::Path) + 1),
            kind: NodeKind::Path,
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
            visible: true,
            locked: false,
            fills: if style.fills.is_empty() {
                vec![Paint::solid("#d4d4d8", 1.0)]
            } else {
                style.fills.clone()
            },
            strokes: style.strokes.clone(),
            stroke_weight: style.stroke_weight,
            opacity: style.opacity,
            blend_mode: style.blend_mode.clone(),
            corner_radius: 0.0,
            text: String::new(),
            font_size: 16.0,
            font_family: default_font_family(),
            text_align: default_text_align(),
            text_valign: default_text_valign(),
            image: String::new(),
            points: to_anchors(out.remove(0)),
            closed: true,
            inner: out.into_iter().map(to_anchors).collect(),
            spans: Vec::new(),
            export_presets: Vec::new(),
            children: Vec::new(),
        };
        sync_path_bounds(&mut node);
        let list = list_at(&mut self.nodes, &insert_path);
        list.insert(insert_at.min(list.len()), node);
        for did in [sa, sb] {
            if let Some(p) = path_to(&self.nodes, did) {
                let i = *p.last().unwrap();
                list_at(&mut self.nodes, &p).remove(i);
            }
        }
        dissolve_empty_groups(&mut self.nodes);
        recompute_group_bounds(&mut self.nodes);
        self.selection = vec![id];
        self.path_edit = None;
        self.touch();
    }

    /// Converts each selected shape's stroke into a filled ring path
    /// (outer + inner offset contours under the even-odd rule). The new
    /// path is filled with the first stroke paint; the body fill is gone.
    pub fn outline_stroke(&mut self) {
        // Collect convertible nodes first: stroked closed outlines.
        let mut jobs: Vec<(u32, Vec<(f64, f64)>, Paint, f64, Node)> = Vec::new();
        for &id in &self.selection {
            let Some(n) = find_node(&self.nodes, id) else {
                continue;
            };
            if n.strokes.is_empty() || n.stroke_weight <= 0.0 {
                continue;
            }
            let mut contours = Vec::new();
            collect_contours(n, &mut contours);
            let Some(first) = contours.into_iter().find(|c| c.len() >= 2) else {
                continue;
            };
            let mut poly = simplify_polygon(&flatten_path(&first, true));
            if poly.len() < 3 {
                continue;
            }
            if signed_area(&poly) < 0.0 {
                poly.reverse();
            }
            jobs.push((id, poly, n.strokes[0].clone(), n.stroke_weight, n.clone()));
        }
        if jobs.is_empty() {
            return;
        }
        self.snapshot_now();
        let mut new_sel = Vec::new();
        for (id, poly, paint, weight, style) in jobs {
            let outer = offset_polygon(&poly, weight / 2.0);
            let inner = offset_polygon(&poly, -weight / 2.0);
            let to_anchors = |c: &[(f64, f64)]| -> Vec<Anchor> {
                c.iter().map(|&(x, y)| corner_anchor(x, y)).collect()
            };
            let nid = self.next_id;
            self.next_id += 1;
            let mut node = Node {
                id: nid,
                name: format!("{} (stroke)", style.name),
                kind: NodeKind::Path,
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
                visible: style.visible,
                locked: false,
                fills: vec![paint],
                strokes: Vec::new(),
                stroke_weight: 0.0,
                opacity: style.opacity,
                blend_mode: style.blend_mode.clone(),
                corner_radius: 0.0,
                text: String::new(),
                font_size: 16.0,
                font_family: default_font_family(),
                text_align: default_text_align(),
                text_valign: default_text_valign(),
                image: String::new(),
                points: to_anchors(&outer),
                closed: true,
                inner: vec![to_anchors(&inner)],
            spans: Vec::new(),
                export_presets: Vec::new(),
                children: Vec::new(),
            };
            sync_path_bounds(&mut node);
            if let Some(p) = path_to(&self.nodes, id) {
                let i = *p.last().unwrap();
                let list = list_at(&mut self.nodes, &p);
                if style.fills.is_empty() {
                    // Stroke-only shape: the ring replaces it.
                    list.remove(i);
                    list.insert(i.min(list.len()), node);
                } else {
                    // Keep the filled body underneath; the ring sits on top.
                    list[i].strokes.clear();
                    list.insert(i + 1, node);
                }
                new_sel.push(nid);
            }
        }
        dissolve_empty_groups(&mut self.nodes);
        recompute_group_bounds(&mut self.nodes);
        self.selection = new_sel;
        self.path_edit = None;
        self.touch();
    }

    /// Wraps the selection in a new frame sized to its bounding box.
    /// All selected nodes must share a parent list (like grouping).
    pub fn frame_selection(&mut self) {
        if self.selection.is_empty() {
            return;
        }
        let mut paths: Vec<Vec<usize>> = Vec::new();
        for &id in &self.selection {
            match path_to(&self.nodes, id) {
                Some(p) => paths.push(p),
                None => return,
            }
        }
        let parent = paths[0][..paths[0].len() - 1].to_vec();
        if !paths.iter().all(|p| p[..p.len() - 1] == parent[..]) {
            return;
        }
        let Some((bx, by, bx2, by2)) = self.selection_bbox(&self.selection.clone()) else {
            return;
        };
        self.snapshot_now();

        let mut indices: Vec<usize> = paths.iter().map(|p| *p.last().unwrap()).collect();
        indices.sort_unstable();
        let insert_at = indices[indices.len() - 1] + 1 - indices.len();
        let full_parent_path = {
            let mut p = parent.clone();
            p.push(0);
            p
        };
        let list = list_at(&mut self.nodes, &full_parent_path);
        let mut children = Vec::new();
        for &i in indices.iter().rev() {
            children.insert(0, list.remove(i));
        }

        let id = self.next_id;
        self.next_id += 1;
        let frame = Node {
            id,
            name: format!("Frame {}", count_kind(&self.nodes, NodeKind::Frame) + 1),
            kind: NodeKind::Frame,
            x: bx,
            y: by,
            w: bx2 - bx,
            h: by2 - by,
            visible: true,
            locked: false,
            fills: vec![Paint::solid("#ffffff", 1.0)],
            strokes: Vec::new(),
            stroke_weight: 1.0,
            opacity: 1.0,
            blend_mode: default_blend_mode(),
            corner_radius: 0.0,
            text: String::new(),
            font_size: 16.0,
            font_family: default_font_family(),
            text_align: default_text_align(),
            text_valign: default_text_valign(),
            image: String::new(),
            points: Vec::new(),
            closed: false,
            inner: Vec::new(),
            spans: Vec::new(),
            export_presets: Vec::new(),
            children,
        };
        let list = list_at(&mut self.nodes, &full_parent_path);
        list.insert(insert_at.min(list.len()), frame);
        self.selection = vec![id];
        self.touch();
    }

    // ----- align & distribute -----

    /// Aligns selected nodes within their joint bounding box.
    /// Modes: left, hcenter, right, top, vcenter, bottom.
    pub fn align_selection(&mut self, mode: &str) {
        if self.selection.len() < 2 {
            return;
        }
        let Some((bx, by, bx2, by2)) = self.selection_bbox(&self.selection.clone()) else {
            return;
        };
        self.snapshot_now();
        for id in self.selection.clone() {
            if let Some(n) = find_node_mut(&mut self.nodes, id) {
                let (dx, dy) = match mode {
                    "left" => (bx - n.x, 0.0),
                    "hcenter" => ((bx + bx2) / 2.0 - (n.x + n.w / 2.0), 0.0),
                    "right" => (bx2 - (n.x + n.w), 0.0),
                    "top" => (0.0, by - n.y),
                    "vcenter" => (0.0, (by + by2) / 2.0 - (n.y + n.h / 2.0)),
                    "bottom" => (0.0, by2 - (n.y + n.h)),
                    _ => (0.0, 0.0),
                };
                shift_subtree(n, dx, dy);
            }
        }
        recompute_group_bounds(&mut self.nodes);
        self.touch();
    }

    /// Distributes 3+ selected nodes with equal gaps along an axis ("h"/"v").
    pub fn distribute_selection(&mut self, axis: &str) {
        if self.selection.len() < 3 {
            return;
        }
        let horizontal = axis == "h";
        let mut items: Vec<(u32, f64, f64)> = self
            .selection
            .iter()
            .filter_map(|&id| {
                find_node(&self.nodes, id).map(|n| {
                    if horizontal { (id, n.x, n.w) } else { (id, n.y, n.h) }
                })
            })
            .collect();
        items.sort_by(|a, b| a.1.total_cmp(&b.1));
        let first_start = items[0].1;
        let last = items.last().unwrap();
        let span = (last.1 + last.2) - first_start;
        let total_size: f64 = items.iter().map(|i| i.2).sum();
        let gap = (span - total_size) / (items.len() - 1) as f64;

        self.snapshot_now();
        let mut cursor = first_start;
        for (id, pos, size) in items {
            let delta = cursor - pos;
            if let Some(n) = find_node_mut(&mut self.nodes, id) {
                if horizontal {
                    shift_subtree(n, delta, 0.0);
                } else {
                    shift_subtree(n, 0.0, delta);
                }
            }
            cursor += size + gap;
        }
        recompute_group_bounds(&mut self.nodes);
        self.touch();
    }

    // ----- canvas text editing & frame labels -----

    /// Marks a node as being edited in an overlay; rendering skips it.
    /// Pass 0 to clear.
    pub fn set_editing_node(&mut self, id: u32) {
        self.editing = if id == 0 { None } else { Some(id) };
        self.touch();
    }

    /// The frame whose name label sits under a screen-space point.
    pub fn frame_label_at(&self, sx: f64, sy: f64) -> Option<u32> {
        self.frame_label_hit(sx, sy)
    }

    // ----- destructive ops -----

    pub fn delete_selection(&mut self) {
        // In vector-edit mode, Delete removes the selected anchors; the
        // node itself goes once fewer than two remain.
        if let Some(pe) = &self.path_edit {
            let id = pe.id;
            let mut sel = pe.selected.clone();
            if !sel.is_empty() {
                self.snapshot_now();
                sel.sort_unstable();
                sel.dedup();
                let mut remove_node = false;
                if let Some(n) = find_node_mut(&mut self.nodes, id) {
                    for &i in sel.iter().rev() {
                        if i < n.points.len() {
                            n.points.remove(i);
                        }
                    }
                    if n.points.len() < 2 {
                        remove_node = true;
                    } else {
                        sync_path_bounds(n);
                    }
                }
                if remove_node {
                    if let Some(path) = path_to(&self.nodes, id) {
                        let index = *path.last().unwrap();
                        list_at(&mut self.nodes, &path).remove(index);
                    }
                    self.path_edit = None;
                    self.selection.clear();
                } else if let Some(pe) = &mut self.path_edit {
                    pe.selected.clear();
                }
                dissolve_empty_groups(&mut self.nodes);
                recompute_group_bounds(&mut self.nodes);
                self.touch();
                return;
            }
        }
        if self.selection.is_empty() {
            return;
        }
        self.snapshot_now();
        for id in self.selection.clone() {
            if let Some(path) = path_to(&self.nodes, id) {
                let index = *path.last().unwrap();
                list_at(&mut self.nodes, &path).remove(index);
            }
        }
        dissolve_empty_groups(&mut self.nodes);
        recompute_group_bounds(&mut self.nodes);
        self.selection.clear();
        self.hovered = None;
        self.validate_path_edit();
        self.touch();
    }

    pub fn duplicate_selection(&mut self) {
        if self.selection.is_empty() {
            return;
        }
        self.snapshot_now();
        let mut new_ids = Vec::new();
        for id in self.selection.clone() {
            if let Some(path) = path_to(&self.nodes, id) {
                let index = *path.last().unwrap();
                let list = list_at(&mut self.nodes, &path);
                let mut copy = list[index].clone();
                assign_fresh_ids(&mut copy, &mut self.next_id);
                shift_subtree(&mut copy, 16.0, 16.0);
                new_ids.push(copy.id);
                list.insert(index + 1, copy);
            }
        }
        recompute_group_bounds(&mut self.nodes);
        self.selection = new_ids;
        self.touch();
    }

    /// Places an uploaded image as a new node (world coordinates) and
    /// selects it.
    pub fn add_image(&mut self, hash: &str, x: f64, y: f64, w: f64, h: f64) -> u32 {
        self.snapshot_now();
        let id = self.add_node(NodeKind::Image, x, y, w.max(1.0), h.max(1.0));
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.image = hash.to_string();
            n.fills.clear(); // the bitmap is the fill
            round_subtree(n);
        }
        self.selection = vec![id];
        self.touch();
        id
    }

    /// Moves a node to a new parent (0 = the root list), inserted before
    /// the sibling `before` in that parent's child list (0 = append, i.e.
    /// topmost). Children keep absolute coordinates, so nothing shifts.
    pub fn reparent(&mut self, id: u32, parent: u32, before: u32) {
        if id == parent || find_node(&self.nodes, id).is_none() {
            return;
        }
        // The target may not be inside the moved subtree.
        if let Some(n) = find_node(&self.nodes, id) {
            if parent != 0 && (parent == id || find_node(&n.children, parent).is_some()) {
                return;
            }
        }
        if parent != 0 {
            match find_node(&self.nodes, parent) {
                Some(p) if matches!(p.kind, NodeKind::Frame | NodeKind::Group) => {}
                _ => return,
            }
        }
        self.snapshot_now();
        let path = path_to(&self.nodes, id).unwrap();
        let i = *path.last().unwrap();
        let node = list_at(&mut self.nodes, &path).remove(i);
        let list = if parent == 0 {
            &mut self.nodes
        } else {
            &mut find_node_mut(&mut self.nodes, parent).unwrap().children
        };
        let at = if before == 0 {
            list.len()
        } else {
            list.iter().position(|n| n.id == before).unwrap_or(list.len())
        };
        list.insert(at, node);
        dissolve_empty_groups(&mut self.nodes);
        recompute_group_bounds(&mut self.nodes);
        self.retain_valid_selection();
        self.touch();
    }

    // ----- clipboard & z-order -----

    /// Copies the selection into the engine's internal clipboard.
    pub fn copy_selection(&mut self) {
        let copies: Vec<Node> =
            self.selection.iter().filter_map(|&id| find_node(&self.nodes, id).cloned()).collect();
        if !copies.is_empty() {
            self.clipboard = copies;
        }
    }

    pub fn cut_selection(&mut self) {
        if self.selection.is_empty() {
            return;
        }
        self.copy_selection();
        self.delete_selection();
    }

    /// Pastes clipboard contents at a cascading offset, selecting the copies.
    pub fn paste_clipboard(&mut self) {
        if self.clipboard.is_empty() {
            return;
        }
        self.snapshot_now();
        // Shift the clipboard itself so repeated pastes cascade.
        for n in &mut self.clipboard {
            shift_subtree(n, 16.0, 16.0);
        }
        let mut new_ids = Vec::new();
        for n in self.clipboard.clone() {
            let mut copy = n;
            assign_fresh_ids(&mut copy, &mut self.next_id);
            new_ids.push(copy.id);
            self.nodes.push(copy);
        }
        self.selection = new_ids;
        self.touch();
    }

    pub fn clipboard_len(&self) -> usize {
        self.clipboard.len()
    }

    pub fn bring_to_front(&mut self) {
        self.reorder_selection(true);
    }

    pub fn send_to_back(&mut self) {
        self.reorder_selection(false);
    }

    fn reorder_selection(&mut self, front: bool) {
        if self.selection.is_empty() {
            return;
        }
        self.snapshot_now();
        for id in self.selection.clone() {
            if let Some(path) = path_to(&self.nodes, id) {
                let index = *path.last().unwrap();
                let list = list_at(&mut self.nodes, &path);
                let node = list.remove(index);
                if front {
                    list.push(node);
                } else {
                    list.insert(0, node);
                }
            }
        }
        self.touch();
    }

    /// Topmost node under a screen-space point (for context menus).
    pub fn node_at(&self, sx: f64, sy: f64) -> Option<u32> {
        let (x, y) = self.to_world(sx, sy);
        self.hit_test(x, y)
    }

    pub fn nudge(&mut self, dx: f64, dy: f64) {
        if self.selection.is_empty() {
            return;
        }
        self.snapshot_now();
        for id in self.selection.clone() {
            if let Some(n) = find_node_mut(&mut self.nodes, id) {
                shift_subtree(n, dx, dy);
            }
        }
        recompute_group_bounds(&mut self.nodes);
        self.touch();
    }

    // ----- export presets -----

    pub fn add_export_preset(&mut self, id: u32) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.export_presets.push(ExportPreset { scale: 1.0, format: ExportFormat::Png });
        }
        self.touch_doc();
        self.touch();
    }

    pub fn remove_export_preset(&mut self, id: u32, index: usize) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            if index < n.export_presets.len() {
                n.export_presets.remove(index);
            }
        }
        self.touch_doc();
        self.touch();
    }

    pub fn set_export_preset(&mut self, id: u32, index: usize, scale: f64, format: &str) {
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            if let Some(p) = n.export_presets.get_mut(index) {
                p.scale = scale.clamp(0.25, 8.0);
                p.format = if format == "svg" { ExportFormat::Svg } else { ExportFormat::Png };
            }
        }
        self.touch_doc();
        self.touch();
    }

    // ----- export rendering -----

    /// Renders one node's subtree at `scale` into a context whose canvas is
    /// sized ceil(w*scale) × ceil(h*scale). Transparent background; no
    /// selection chrome.
    pub fn render_export(&self, ctx: &CanvasRenderingContext2d, id: u32, scale: f64) {
        if let Some(n) = find_node(&self.nodes, id) {
            let _ = ctx.set_transform(scale, 0.0, 0.0, scale, -n.x * scale, -n.y * scale);
            draw_node(ctx, n, 1.0, scale, &self.text_layouts);
        }
    }

    /// Serializes one node's subtree as a standalone SVG document.
    pub fn export_svg(&self, id: u32) -> String {
        let Some(n) = find_node(&self.nodes, id) else {
            return String::new();
        };
        let mut out = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">"#,
            w = n.w,
            h = n.h
        );
        svg_node(n, -n.x, -n.y, &mut out, &self.text_layouts.borrow());
        out.push_str("</svg>");
        out
    }

    // ----- undo -----

    pub fn undo(&mut self) {
        if let Some(prev) = self.undo.pop() {
            self.redo.push(std::mem::replace(&mut self.nodes, prev));
            self.retain_valid_selection();
            self.validate_path_edit();
            self.touch_doc();
            self.touch();
        }
    }

    pub fn redo(&mut self) {
        if let Some(next) = self.redo.pop() {
            self.undo.push(std::mem::replace(&mut self.nodes, next));
            self.retain_valid_selection();
            self.validate_path_edit();
            self.touch_doc();
            self.touch();
        }
    }

    // ----- rendering -----

    pub fn render(&self, ctx: &CanvasRenderingContext2d, width: f64, height: f64, dpr: f64) {
        let _ = ctx.set_transform(dpr, 0.0, 0.0, dpr, 0.0, 0.0);
        ctx.set_fill_style_str("#e9e9ec");
        ctx.fill_rect(0.0, 0.0, width, height);

        let _ = ctx.translate(self.pan_x, self.pan_y);
        let _ = ctx.scale(self.zoom, self.zoom);

        for n in &self.nodes {
            // A text node under inline editing renders in the DOM overlay
            // instead. (Frames being renamed keep their body; only the
            // label pass skips them.)
            if self.editing == Some(n.id) && n.kind == NodeKind::Text {
                continue;
            }
            draw_node(ctx, n, 1.0, self.zoom, &self.text_layouts);
        }
        ctx.set_global_alpha(1.0);

        // Hover highlight.
        if let Some(id) = self.hovered {
            if !self.selection.contains(&id) {
                if let Some(n) = find_node(&self.nodes, id) {
                    ctx.set_stroke_style_str("#38bdf8");
                    ctx.set_line_width(1.5 / self.zoom);
                    ctx.stroke_rect(n.x, n.y, n.w, n.h);
                }
            }
        }

        // Selection outlines, then resize handles on the joint bbox.
        // Vector-edit mode replaces this chrome with anchors and handles.
        if self.path_edit.is_none() {
            for &id in &self.selection {
                if let Some(n) = find_node(&self.nodes, id) {
                    ctx.set_stroke_style_str("#0ea5e9");
                    ctx.set_line_width(1.5 / self.zoom);
                    ctx.stroke_rect(n.x, n.y, n.w, n.h);
                }
            }
            if let Some((bx, by, bx2, by2)) = self.selection_bbox(&self.selection) {
                ctx.set_stroke_style_str("#0ea5e9");
                if self.selection.len() > 1 {
                    ctx.set_line_width(1.0 / self.zoom);
                    ctx.stroke_rect(bx, by, bx2 - bx, by2 - by);
                }
                let hs = 7.0 / self.zoom;
                for (hx, hy) in HANDLES {
                    let (px, py) =
                        (bx + hx * (bx2 - bx) - hs / 2.0, by + hy * (by2 - by) - hs / 2.0);
                    ctx.set_fill_style_str("#ffffff");
                    ctx.fill_rect(px, py, hs, hs);
                    ctx.set_line_width(1.0 / self.zoom);
                    ctx.stroke_rect(px, py, hs, hs);
                }
            }
        }

        // Vector-edit chrome: outline, anchors (filled when selected),
        // handle spokes and dots for selected anchors, anchor marquee.
        if let Some(pe) = &self.path_edit {
            if let Some(n) = find_node(&self.nodes, pe.id) {
                ctx.set_stroke_style_str("#0ea5e9");
                ctx.set_line_width(1.0 / self.zoom);
                trace_path(ctx, &n.points, n.closed);
                ctx.stroke();
                for &i in &pe.selected {
                    if let Some(a) = n.points.get(i) {
                        for (hx, hy) in [(a.hx_in, a.hy_in), (a.hx_out, a.hy_out)] {
                            if hx != a.x || hy != a.y {
                                ctx.set_stroke_style_str("#a1a1aa");
                                ctx.set_line_width(1.0 / self.zoom);
                                ctx.begin_path();
                                ctx.move_to(a.x, a.y);
                                ctx.line_to(hx, hy);
                                ctx.stroke();
                                ctx.set_fill_style_str("#ffffff");
                                ctx.set_stroke_style_str("#0ea5e9");
                                ctx.begin_path();
                                let _ = ctx.arc(hx, hy, 3.5 / self.zoom, 0.0, TAU);
                                ctx.fill();
                                ctx.stroke();
                            }
                        }
                    }
                }
                let hs = 7.0 / self.zoom;
                ctx.set_line_width(1.0 / self.zoom);
                for (i, a) in n.points.iter().enumerate() {
                    let sel = pe.selected.contains(&i);
                    ctx.set_fill_style_str(if sel { "#0ea5e9" } else { "#ffffff" });
                    ctx.set_stroke_style_str("#0ea5e9");
                    ctx.fill_rect(a.x - hs / 2.0, a.y - hs / 2.0, hs, hs);
                    ctx.stroke_rect(a.x - hs / 2.0, a.y - hs / 2.0, hs, hs);
                }
                if let PathDrag::Marquee { ox, oy, cx, cy } = pe.drag {
                    ctx.set_fill_style_str("rgba(14, 165, 233, 0.08)");
                    ctx.set_stroke_style_str("#0ea5e9");
                    ctx.set_line_width(1.0 / self.zoom);
                    let (mx, my) = (ox.min(cx), oy.min(cy));
                    let (mw, mh) = ((cx - ox).abs(), (cy - oy).abs());
                    ctx.fill_rect(mx, my, mw, mh);
                    ctx.stroke_rect(mx, my, mw, mh);
                }
            }
        }

        // Marquee.
        if let Drag::Marquee { ox, oy, cx, cy } = self.drag {
            ctx.set_fill_style_str("rgba(14, 165, 233, 0.08)");
            ctx.set_stroke_style_str("#0ea5e9");
            ctx.set_line_width(1.0 / self.zoom);
            let (mx, my) = (ox.min(cx), oy.min(cy));
            let (mw, mh) = ((cx - ox).abs(), (cy - oy).abs());
            ctx.fill_rect(mx, my, mw, mh);
            ctx.stroke_rect(mx, my, mw, mh);
        }

        // Snap guides.
        for g in &self.guides {
            ctx.set_stroke_style_str("#f43f5e");
            ctx.set_line_width(1.0 / self.zoom);
            ctx.begin_path();
            if g.vertical {
                ctx.move_to(g.pos, g.from);
                ctx.line_to(g.pos, g.to);
            } else {
                ctx.move_to(g.from, g.pos);
                ctx.line_to(g.to, g.pos);
            }
            ctx.stroke();
        }

        // In-progress pen path: segments so far, a rubber band to the
        // cursor, anchor dots, and a ring on the first anchor once the
        // path can be closed by clicking it.
        if let Some(pen) = &self.pen {
            if !pen.anchors.is_empty() {
                ctx.set_stroke_style_str("#0ea5e9");
                ctx.set_line_width(1.5 / self.zoom);
                trace_path(ctx, &pen.anchors, false);
                if !pen.dragging {
                    let last = pen.anchors.last().unwrap();
                    ctx.bezier_curve_to(
                        last.hx_out,
                        last.hy_out,
                        pen.cur.0,
                        pen.cur.1,
                        pen.cur.0,
                        pen.cur.1,
                    );
                }
                ctx.stroke();
                let hs = 6.0 / self.zoom;
                for (i, a) in pen.anchors.iter().enumerate() {
                    ctx.set_fill_style_str("#ffffff");
                    ctx.fill_rect(a.x - hs / 2.0, a.y - hs / 2.0, hs, hs);
                    ctx.set_line_width(1.0 / self.zoom);
                    ctx.stroke_rect(a.x - hs / 2.0, a.y - hs / 2.0, hs, hs);
                    if i == 0 && pen.anchors.len() >= 2 {
                        ctx.begin_path();
                        let _ = ctx.arc(a.x, a.y, 6.0 / self.zoom, 0.0, TAU);
                        ctx.stroke();
                    }
                }
            }
        }

        // Frame labels are drawn in screen space so they stay readable at
        // any zoom level.
        let _ = ctx.set_transform(dpr, 0.0, 0.0, dpr, 0.0, 0.0);
        ctx.set_font("11px 'Hanken Grotesk', sans-serif");
        ctx.set_text_baseline("alphabetic");
        for n in &self.nodes {
            if n.kind == NodeKind::Frame && n.visible && self.editing != Some(n.id) {
                let selected = self.selection.contains(&n.id);
                ctx.set_fill_style_str(if selected { "#0284c7" } else { "#71717a" });
                let _ = ctx.fill_text(
                    &n.name,
                    n.x * self.zoom + self.pan_x,
                    n.y * self.zoom + self.pan_y - 6.0,
                );
            }
        }
    }

    // ----- internals -----

    fn to_world(&self, sx: f64, sy: f64) -> (f64, f64) {
        ((sx - self.pan_x) / self.zoom, (sy - self.pan_y) / self.zoom)
    }

    fn zoom_around(&mut self, new_zoom: f64, cx: f64, cy: f64) {
        let new_zoom = new_zoom.clamp(0.02, 64.0);
        let scale = new_zoom / self.zoom;
        self.pan_x = cx - (cx - self.pan_x) * scale;
        self.pan_y = cy - (cy - self.pan_y) * scale;
        self.zoom = new_zoom;
    }

    /// Topmost node under a world-space point. Frame children are hit
    /// before the frame body; groups act as one unit. Hidden and locked
    /// nodes are not clickable.
    fn hit_test(&self, x: f64, y: f64) -> Option<u32> {
        for n in self.nodes.iter().rev() {
            if !n.visible || n.locked || !self.node_hit(n, x, y) {
                continue;
            }
            if n.kind == NodeKind::Frame {
                if let Some(c) = n
                    .children
                    .iter()
                    .rev()
                    .find(|c| c.visible && !c.locked && self.node_hit(c, x, y))
                {
                    return Some(c.id);
                }
            }
            return Some(n.id);
        }
        None
    }

    /// Box containment for most nodes; paths test against the actual
    /// outline (with a zoom-aware grab tolerance) so empty bbox corners
    /// don't swallow clicks.
    fn node_hit(&self, n: &Node, x: f64, y: f64) -> bool {
        if n.kind != NodeKind::Path {
            return n.contains(x, y);
        }
        let tol = 4.0 / self.zoom;
        let inside_box = x >= n.x - tol
            && x <= n.x + n.w + tol
            && y >= n.y - tol
            && y <= n.y + n.h + tol;
        inside_box && path_hit(n, x, y, tol)
    }

    /// Resize handle under a screen-space point, on the selection's joint
    /// bounding box (works for single nodes, groups, and multi-selections).
    fn handle_at(&self, sx: f64, sy: f64) -> Option<usize> {
        if self.selection.is_empty() {
            return None;
        }
        let (bx, by, bx2, by2) = self.selection_bbox(&self.selection)?;
        let grab = 6.0;
        HANDLES.iter().position(|(hx, hy)| {
            let px = (bx + hx * (bx2 - bx)) * self.zoom + self.pan_x;
            let py = (by + hy * (by2 - by)) * self.zoom + self.pan_y;
            (sx - px).abs() <= grab && (sy - py).abs() <= grab
        })
    }

    fn selection_bbox(&self, ids: &[u32]) -> Option<(f64, f64, f64, f64)> {
        let mut bbox: Option<(f64, f64, f64, f64)> = None;
        for &id in ids {
            if let Some(n) = find_node(&self.nodes, id) {
                bbox = Some(match bbox {
                    None => (n.x, n.y, n.x + n.w, n.y + n.h),
                    Some((bx, by, bx2, by2)) => {
                        (bx.min(n.x), by.min(n.y), bx2.max(n.x + n.w), by2.max(n.y + n.h))
                    }
                });
            }
        }
        bbox
    }

    /// Snaps the moving selection's bounding box edges/centers to other
    /// top-level nodes within a screen-space threshold, recording guides.
    fn apply_snapping(&mut self, moved_ids: &[u32]) {
        self.guides.clear();
        let Some((bx, by, bx2, by2)) = self.selection_bbox(moved_ids) else {
            return;
        };
        let threshold = 6.0 / self.zoom;

        // (delta, snapped position, other box span on the perpendicular axis)
        let mut best_x: Option<(f64, f64, f64, f64)> = None;
        let mut best_y: Option<(f64, f64, f64, f64)> = None;
        for n in &self.nodes {
            if !n.visible || moved_ids.contains(&n.id) {
                continue;
            }
            for cand in [n.x, n.x + n.w / 2.0, n.x + n.w] {
                for own in [bx, (bx + bx2) / 2.0, bx2] {
                    let d = cand - own;
                    if d.abs() < threshold
                        && best_x.map_or(true, |(bd, ..)| d.abs() < bd.abs())
                    {
                        best_x = Some((d, cand, n.y, n.y + n.h));
                    }
                }
            }
            for cand in [n.y, n.y + n.h / 2.0, n.y + n.h] {
                for own in [by, (by + by2) / 2.0, by2] {
                    let d = cand - own;
                    if d.abs() < threshold
                        && best_y.map_or(true, |(bd, ..)| d.abs() < bd.abs())
                    {
                        best_y = Some((d, cand, n.x, n.x + n.w));
                    }
                }
            }
        }

        let dx = best_x.map_or(0.0, |b| b.0);
        let dy = best_y.map_or(0.0, |b| b.0);
        if dx != 0.0 || dy != 0.0 {
            for &id in moved_ids {
                if let Some(n) = find_node_mut(&mut self.nodes, id) {
                    shift_subtree(n, dx, dy);
                }
            }
            recompute_group_bounds(&mut self.nodes);
        }
        if let Some((_, pos, from, to)) = best_x {
            self.guides.push(Guide {
                vertical: true,
                pos,
                from: from.min(by + dy),
                to: to.max(by2 + dy),
            });
        }
        if let Some((_, pos, from, to)) = best_y {
            self.guides.push(Guide {
                vertical: false,
                pos,
                from: from.min(bx + dx),
                to: to.max(bx2 + dx),
            });
        }
    }

    /// Screen-space hit test for frame name labels (drawn above frames).
    fn frame_label_hit(&self, sx: f64, sy: f64) -> Option<u32> {
        for n in self.nodes.iter().rev() {
            if n.kind != NodeKind::Frame || !n.visible || n.locked {
                continue;
            }
            let lx = n.x * self.zoom + self.pan_x;
            let ly = n.y * self.zoom + self.pan_y - 18.0;
            let lw = (n.name.chars().count() as f64) * 6.5 + 6.0;
            if sx >= lx && sx <= lx + lw && sy >= ly && sy <= ly + 16.0 {
                return Some(n.id);
            }
        }
        None
    }

    fn add_node(&mut self, kind: NodeKind, x: f64, y: f64, w: f64, h: f64) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let count = count_kind(&self.nodes, kind) + 1;
        let (name, fill) = match kind {
            NodeKind::Frame => (format!("Frame {count}"), "#ffffff"),
            NodeKind::Group => (format!("Group {count}"), "#ffffff"),
            NodeKind::Rect => (format!("Rectangle {count}"), "#d4d4d8"),
            NodeKind::Ellipse => (format!("Ellipse {count}"), "#d4d4d8"),
            NodeKind::Text => (format!("Text {count}"), "#18181b"),
            NodeKind::Image => (format!("Image {count}"), "#f4f4f5"),
            NodeKind::Path => (format!("Path {count}"), "#d4d4d8"),
        };
        self.nodes.push(Node {
            id,
            name,
            kind,
            x,
            y,
            w,
            h,
            visible: true,
            locked: false,
            fills: vec![Paint::solid(fill, 1.0)],
            strokes: Vec::new(),
            stroke_weight: 1.0,
            opacity: 1.0,
            blend_mode: default_blend_mode(),
            corner_radius: 0.0,
            text: if kind == NodeKind::Text { "Text".to_string() } else { String::new() },
            font_size: 16.0,
            font_family: default_font_family(),
            text_align: default_text_align(),
            text_valign: default_text_valign(),
            image: String::new(),
            points: Vec::new(),
            closed: false,
            inner: Vec::new(),
            spans: Vec::new(),
            export_presets: Vec::new(),
            children: Vec::new(),
        });
        id
    }

    fn retain_valid_selection(&mut self) {
        let nodes = &self.nodes;
        self.selection.retain(|&id| find_node(nodes, id).is_some());
        self.hovered = None;
    }

    /// Stage an undo snapshot at the start of a drag; committed only if the
    /// drag actually changed the document.
    fn begin_mutation(&mut self) {
        self.pending_undo = Some(self.nodes.clone());
    }

    fn commit_mutation(&mut self) {
        if let Some(snap) = self.pending_undo.take() {
            self.undo.push(snap);
            self.redo.clear();
            self.touch_doc();
        }
    }

    /// Immediate snapshot for one-shot edits (panel fields, delete, nudge).
    fn snapshot_now(&mut self) {
        self.undo.push(self.nodes.clone());
        self.redo.clear();
        self.touch_doc();
    }

    fn touch(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }

    fn touch_doc(&mut self) {
        self.doc_generation = self.doc_generation.wrapping_add(1);
    }
}

// ----- canvas drawing (shared by editor render and export render) -----

fn draw_node(
    ctx: &CanvasRenderingContext2d,
    n: &Node,
    parent_alpha: f64,
    zoom: f64,
    layouts: &RefCell<HashMap<u32, Vec<String>>>,
) {
    if !n.visible {
        return;
    }
    let alpha = parent_alpha * n.opacity;
    let blended = n.blend_mode != "normal";
    if blended {
        let _ = ctx.set_global_composite_operation(&n.blend_mode);
    }
    match n.kind {
        NodeKind::Group => {
            for c in &n.children {
                draw_node(ctx, c, alpha, zoom, layouts);
            }
        }
        NodeKind::Frame => {
            ctx.set_shadow_color("rgba(24, 24, 27, 0.10)");
            ctx.set_shadow_blur(3.0);
            ctx.set_shadow_offset_y(1.0);
            for p in &n.fills {
                ctx.set_global_alpha(alpha * p.opacity);
                apply_fill(ctx, p, n.x, n.y, n.w, n.h);
                fill_rounded(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
                ctx.set_shadow_color("transparent");
            }
            ctx.set_shadow_color("transparent");
            ctx.set_shadow_blur(0.0);
            ctx.set_shadow_offset_y(0.0);
            stroke_paints(ctx, n, alpha, |ctx| {
                rounded_rect_path(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            });
            // Children clip to the frame, Figma-style.
            ctx.save();
            rounded_rect_path(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            ctx.clip();
            for c in &n.children {
                draw_node(ctx, c, alpha, zoom, layouts);
            }
            ctx.restore();
        }
        NodeKind::Rect => {
            for p in &n.fills {
                ctx.set_global_alpha(alpha * p.opacity);
                apply_fill(ctx, p, n.x, n.y, n.w, n.h);
                fill_rounded(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            }
            stroke_paints(ctx, n, alpha, |ctx| {
                rounded_rect_path(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            });
        }
        NodeKind::Ellipse => {
            for p in &n.fills {
                ctx.set_global_alpha(alpha * p.opacity);
                apply_fill(ctx, p, n.x, n.y, n.w, n.h);
                ellipse_path(ctx, n);
                ctx.fill();
            }
            stroke_paints(ctx, n, alpha, |ctx| ellipse_path(ctx, n));
        }
        NodeKind::Text => {
            ctx.set_font(&format!("{}px '{}', sans-serif", n.font_size, n.font_family));
            ctx.set_text_baseline("top");
            let lh = n.font_size * LINE_HEIGHT;
            let lines = wrap_text(ctx, &n.text, n.w);
            let block = lines.len() as f64 * lh;
            let y0 = match n.text_valign.as_str() {
                "top" => n.y,
                "bottom" => n.y + n.h - block,
                _ => n.y + (n.h - block) / 2.0,
            };
            layouts.borrow_mut().insert(n.id, lines.clone());
            let styles = char_styles(n);
            let mut off = 0;
            for (i, line) in lines.iter().enumerate() {
                // Each line slot is lh tall; the em box centers in it so a
                // single line at "middle" matches the pre-wrap rendering.
                let ty = y0 + i as f64 * lh + (lh - n.font_size) / 2.0;
                // Style runs render with their own font variant; the line
                // width for alignment sums the styled segment widths.
                let segs = line_segments(&styles, line, off);
                off += line.chars().count() + 1; // +1: the break char
                let widths: Vec<f64> = segs
                    .iter()
                    .map(|(s, b, it)| {
                        ctx.set_font(&font_spec(n.font_size, &n.font_family, *b, *it));
                        ctx.measure_text(s).map(|m| m.width()).unwrap_or(0.0)
                    })
                    .collect();
                let total: f64 = widths.iter().sum();
                let mut tx = match n.text_align.as_str() {
                    "center" => n.x + (n.w - total) / 2.0,
                    "right" => n.x + n.w - total,
                    _ => n.x,
                };
                for ((seg, b, it), w) in segs.iter().zip(&widths) {
                    ctx.set_font(&font_spec(n.font_size, &n.font_family, *b, *it));
                    for p in &n.fills {
                        ctx.set_global_alpha(alpha * p.opacity);
                        ctx.set_fill_style_str(&p.color);
                        let _ = ctx.fill_text(seg, tx, ty);
                    }
                    for p in &n.strokes {
                        ctx.set_global_alpha(alpha * p.opacity);
                        ctx.set_stroke_style_str(&p.color);
                        ctx.set_line_width(n.stroke_weight);
                        let _ = ctx.stroke_text(seg, tx, ty);
                    }
                    tx += w;
                }
            }
        }
        NodeKind::Path => {
            if n.points.len() >= 2 {
                for p in &n.fills {
                    ctx.set_global_alpha(alpha * p.opacity);
                    apply_fill(ctx, p, n.x, n.y, n.w, n.h);
                    trace_path_all(ctx, n);
                    ctx.fill_with_canvas_winding_rule(web_sys::CanvasWindingRule::Evenodd);
                }
                stroke_paints(ctx, n, alpha, |ctx| trace_path_all(ctx, n));
            }
        }
        NodeKind::Image => {
            // Decoded bitmaps live in a JS-side cache the app fills as
            // assets stream in; until then draw a loading placeholder.
            ctx.set_global_alpha(alpha);
            let el = web_sys::window()
                .and_then(|w| js_sys::Reflect::get(&w, &"__ligmaImages".into()).ok())
                .and_then(|m| js_sys::Reflect::get(&m, &n.image.as_str().into()).ok())
                .and_then(|v| v.dyn_into::<web_sys::HtmlImageElement>().ok());
            match el {
                Some(img) => {
                    let _ = ctx.draw_image_with_html_image_element_and_dw_and_dh(
                        &img, n.x, n.y, n.w, n.h,
                    );
                }
                None => {
                    ctx.set_fill_style_str("#f4f4f5");
                    ctx.fill_rect(n.x, n.y, n.w, n.h);
                    ctx.set_stroke_style_str("#d4d4d8");
                    ctx.set_line_width(1.0 / zoom);
                    ctx.stroke_rect(n.x, n.y, n.w, n.h);
                    ctx.begin_path();
                    ctx.move_to(n.x, n.y);
                    ctx.line_to(n.x + n.w, n.y + n.h);
                    ctx.stroke();
                }
            }
            stroke_paints(ctx, n, alpha, |ctx| {
                rounded_rect_path(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            });
        }
    }
    ctx.set_global_alpha(1.0);
    if blended {
        let _ = ctx.set_global_composite_operation("source-over");
    }
}

/// Greedy word wrap against real canvas metrics. Explicit newlines are
/// hard breaks; a word longer than the box gets its own overflowing line.
fn wrap_text(ctx: &CanvasRenderingContext2d, text: &str, max_w: f64) -> Vec<String> {
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split(' ') {
            let cand = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            let w = ctx.measure_text(&cand).map(|m| m.width()).unwrap_or(0.0);
            if w <= max_w || line.is_empty() {
                line = cand;
            } else {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            }
        }
        lines.push(line);
    }
    lines
}

/// Sets the context fill style for a paint: solid color, or a linear
/// gradient spanning the node's bounding box at the paint's angle.
fn apply_fill(ctx: &CanvasRenderingContext2d, p: &Paint, x: f64, y: f64, w: f64, h: f64) {
    if p.kind == "radial" && p.stops.len() >= 2 {
        let (cx, cy) = (x + w / 2.0, y + h / 2.0);
        let r = (w.max(h)) / 2.0;
        if let Ok(g) = ctx.create_radial_gradient(cx, cy, 0.0, cx, cy, r.max(0.01)) {
            for s in &p.stops {
                let _ = g.add_color_stop(s.position.clamp(0.0, 1.0) as f32, &s.color);
            }
            ctx.set_fill_style_canvas_gradient(&g);
            return;
        }
        ctx.set_fill_style_str(&p.color);
    } else if p.kind == "linear" && p.stops.len() >= 2 {
        let (cx, cy) = (x + w / 2.0, y + h / 2.0);
        let rad = p.angle.to_radians();
        let (dx, dy) = (rad.cos(), rad.sin());
        let hl = (w / 2.0 * dx).abs() + (h / 2.0 * dy).abs();
        let g = ctx.create_linear_gradient(cx - dx * hl, cy - dy * hl, cx + dx * hl, cy + dy * hl);
        for s in &p.stops {
            let _ = g.add_color_stop(s.position.clamp(0.0, 1.0) as f32, &s.color);
        }
        ctx.set_fill_style_canvas_gradient(&g);
    } else {
        ctx.set_fill_style_str(&p.color);
    }
}

fn stroke_paints(
    ctx: &CanvasRenderingContext2d,
    n: &Node,
    alpha: f64,
    trace: impl Fn(&CanvasRenderingContext2d),
) {
    if n.stroke_weight <= 0.0 {
        return;
    }
    for p in &n.strokes {
        ctx.set_global_alpha(alpha * p.opacity);
        ctx.set_stroke_style_str(&p.color);
        ctx.set_line_width(n.stroke_weight);
        trace(ctx);
        ctx.stroke();
    }
}

/// Traces a path node's bezier outline into the current canvas path.
fn trace_path(ctx: &CanvasRenderingContext2d, points: &[Anchor], closed: bool) {
    ctx.begin_path();
    trace_contour(ctx, points, closed);
}

/// Traces every contour of a path node into one canvas path, so an
/// even-odd fill turns contour overlaps into holes.
fn trace_path_all(ctx: &CanvasRenderingContext2d, n: &Node) {
    ctx.begin_path();
    trace_contour(ctx, &n.points, n.closed);
    for c in &n.inner {
        trace_contour(ctx, c, true);
    }
}

fn trace_contour(ctx: &CanvasRenderingContext2d, points: &[Anchor], closed: bool) {
    if points.is_empty() {
        return;
    }
    ctx.move_to(points[0].x, points[0].y);
    let segs = if closed { points.len() } else { points.len() - 1 };
    for i in 0..segs {
        let a = &points[i];
        let b = &points[(i + 1) % points.len()];
        ctx.bezier_curve_to(a.hx_out, a.hy_out, b.hx_in, b.hy_in, b.x, b.y);
    }
    if closed {
        ctx.close_path();
    }
}

fn ellipse_path(ctx: &CanvasRenderingContext2d, n: &Node) {
    ctx.begin_path();
    let _ = ctx.ellipse(n.x + n.w / 2.0, n.y + n.h / 2.0, n.w / 2.0, n.h / 2.0, 0.0, 0.0, TAU);
}

fn rounded_rect_path(ctx: &CanvasRenderingContext2d, x: f64, y: f64, w: f64, h: f64, r: f64) {
    let r = r.min(w / 2.0).min(h / 2.0);
    ctx.begin_path();
    if r <= 0.0 {
        ctx.rect(x, y, w, h);
        return;
    }
    ctx.move_to(x + r, y);
    let _ = ctx.arc_to(x + w, y, x + w, y + h, r);
    let _ = ctx.arc_to(x + w, y + h, x, y + h, r);
    let _ = ctx.arc_to(x, y + h, x, y, r);
    let _ = ctx.arc_to(x, y, x + w, y, r);
    ctx.close_path();
}

fn fill_rounded(ctx: &CanvasRenderingContext2d, x: f64, y: f64, w: f64, h: f64, r: f64) {
    rounded_rect_path(ctx, x, y, w, h, r);
    ctx.fill();
}

// ----- SVG serialization -----

/// Emits a paint server for gradient paints (returns the fill value).
/// Solid paints just return their escaped color.
fn svg_fill(p: &Paint, uid: &str, out: &mut String, x: f64, y: f64, w: f64, h: f64) -> String {
    if !["linear", "radial"].contains(&p.kind.as_str()) || p.stops.len() < 2 {
        return xml_escape(&p.color);
    }
    if p.kind == "radial" {
        out.push_str(&format!(
            r#"<radialGradient id="{uid}" gradientUnits="userSpaceOnUse" cx="{}" cy="{}" r="{}">"#,
            x + w / 2.0,
            y + h / 2.0,
            (w.max(h)) / 2.0
        ));
        for s in &p.stops {
            out.push_str(&format!(
                r#"<stop offset="{}" stop-color="{}"/>"#,
                s.position.clamp(0.0, 1.0),
                xml_escape(&s.color)
            ));
        }
        out.push_str("</radialGradient>");
        return format!("url(#{uid})");
    }
    let rad = p.angle.to_radians();
    let (dx, dy) = (rad.cos() / 2.0, rad.sin() / 2.0);
    out.push_str(&format!(
        r#"<linearGradient id="{uid}" x1="{}" y1="{}" x2="{}" y2="{}">"#,
        0.5 - dx,
        0.5 - dy,
        0.5 + dx,
        0.5 + dy
    ));
    for s in &p.stops {
        out.push_str(&format!(
            r#"<stop offset="{}" stop-color="{}"/>"#,
            s.position.clamp(0.0, 1.0),
            xml_escape(&s.color)
        ));
    }
    out.push_str("</linearGradient>");
    format!("url(#{uid})")
}

fn path_d(points: &[Anchor], closed: bool, ox: f64, oy: f64) -> String {
    if points.is_empty() {
        return String::new();
    }
    let mut d = format!("M {} {}", points[0].x + ox, points[0].y + oy);
    let segs = if closed { points.len() } else { points.len() - 1 };
    for i in 0..segs {
        let a = &points[i];
        let b = &points[(i + 1) % points.len()];
        d.push_str(&format!(
            " C {} {} {} {} {} {}",
            a.hx_out + ox,
            a.hy_out + oy,
            b.hx_in + ox,
            b.hy_in + oy,
            b.x + ox,
            b.y + oy
        ));
    }
    if closed {
        d.push_str(" Z");
    }
    d
}

fn svg_node(
    n: &Node,
    ox: f64,
    oy: f64,
    out: &mut String,
    layouts: &HashMap<u32, Vec<String>>,
) {
    if !n.visible {
        return;
    }
    let opacity = if n.opacity < 1.0 { format!(r#" opacity="{}""#, n.opacity) } else { String::new() };
    let blend = if n.blend_mode != "normal" {
        format!(r#" style="mix-blend-mode:{}""#, n.blend_mode)
    } else {
        String::new()
    };
    out.push_str(&format!("<g{opacity}{blend}>"));
    let (x, y) = (n.x + ox, n.y + oy);
    match n.kind {
        NodeKind::Group => {
            for c in &n.children {
                svg_node(c, ox, oy, out, layouts);
            }
        }
        NodeKind::Frame | NodeKind::Rect => {
            let rx = n.corner_radius.min(n.w / 2.0).min(n.h / 2.0);
            let rx_attr = if rx > 0.0 { format!(r#" rx="{rx}""#) } else { String::new() };
            for (pi, p) in n.fills.iter().enumerate() {
                let fill = svg_fill(p, &format!("g{}f{}", n.id, pi), out, x, y, n.w, n.h);
                out.push_str(&format!(
                    r#"<rect x="{x}" y="{y}" width="{}" height="{}"{rx_attr} fill="{fill}" fill-opacity="{}"/>"#,
                    n.w, n.h, p.opacity
                ));
            }
            for p in &n.strokes {
                out.push_str(&format!(
                    r#"<rect x="{x}" y="{y}" width="{}" height="{}"{rx_attr} fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{}"/>"#,
                    n.w, n.h, xml_escape(&p.color), p.opacity, n.stroke_weight
                ));
            }
            if n.kind == NodeKind::Frame && !n.children.is_empty() {
                out.push_str(&format!(
                    r#"<clipPath id="clip{id}"><rect x="{x}" y="{y}" width="{}" height="{}"{rx_attr}/></clipPath><g clip-path="url(#clip{id})">"#,
                    n.w, n.h, id = n.id
                ));
                for c in &n.children {
                    svg_node(c, ox, oy, out, layouts);
                }
                out.push_str("</g>");
            } else {
                for c in &n.children {
                    svg_node(c, ox, oy, out, layouts);
                }
            }
        }
        NodeKind::Ellipse => {
            let (cx, cy, rx, ry) = (x + n.w / 2.0, y + n.h / 2.0, n.w / 2.0, n.h / 2.0);
            for (pi, p) in n.fills.iter().enumerate() {
                let fill = svg_fill(p, &format!("g{}f{}", n.id, pi), out, x, y, n.w, n.h);
                out.push_str(&format!(
                    r#"<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{fill}" fill-opacity="{}"/>"#,
                    p.opacity
                ));
            }
            for p in &n.strokes {
                out.push_str(&format!(
                    r#"<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{}"/>"#,
                    xml_escape(&p.color), p.opacity, n.stroke_weight
                ));
            }
        }
        NodeKind::Text => {
            // Line breaks come from the last canvas render (the only
            // place real measurement exists); fall back to raw lines.
            let fallback: Vec<String> = n.text.split('\n').map(str::to_string).collect();
            let lines = layouts.get(&n.id).unwrap_or(&fallback);
            let lh = n.font_size * LINE_HEIGHT;
            let block = lines.len() as f64 * lh;
            let y0 = match n.text_valign.as_str() {
                "top" => y,
                "bottom" => y + n.h - block,
                _ => y + (n.h - block) / 2.0,
            };
            let (anchor, tx) = match n.text_align.as_str() {
                "center" => ("middle", x + n.w / 2.0),
                "right" => ("end", x + n.w),
                _ => ("start", x),
            };
            let styles = char_styles(n);
            for p in &n.fills {
                let mut off = 0;
                for (i, line) in lines.iter().enumerate() {
                    // Baseline approximation: ~0.8em below the em top.
                    let ty = y0 + i as f64 * lh + (lh - n.font_size) / 2.0 + n.font_size * 0.8;
                    let mut body = String::new();
                    for (seg, b, it) in line_segments(&styles, line, off) {
                        if b || it {
                            body.push_str(&format!(
                                r#"<tspan{}{}>{}</tspan>"#,
                                if b { r#" font-weight="700""# } else { "" },
                                if it { r#" font-style="italic""# } else { "" },
                                xml_escape(&seg)
                            ));
                        } else {
                            body.push_str(&xml_escape(&seg));
                        }
                    }
                    off += line.chars().count() + 1;
                    out.push_str(&format!(
                        r#"<text x="{tx}" y="{ty}" text-anchor="{anchor}" font-family="{}, sans-serif" font-size="{}" fill="{}" fill-opacity="{}">{}</text>"#,
                        xml_escape(&n.font_family), n.font_size, xml_escape(&p.color), p.opacity, body
                    ));
                }
            }
        }
        NodeKind::Path => {
            let mut d = path_d(&n.points, n.closed, ox, oy);
            for c in &n.inner {
                d.push(' ');
                d.push_str(&path_d(c, true, ox, oy));
            }
            for (pi, p) in n.fills.iter().enumerate() {
                let fill = svg_fill(p, &format!("g{}f{}", n.id, pi), out, x, y, n.w, n.h);
                out.push_str(&format!(
                    r#"<path d="{d}" fill-rule="evenodd" fill="{fill}" fill-opacity="{}"/>"#,
                    p.opacity
                ));
            }
            for p in &n.strokes {
                out.push_str(&format!(
                    r#"<path d="{d}" fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{}"/>"#,
                    xml_escape(&p.color),
                    p.opacity,
                    n.stroke_weight
                ));
            }
        }
        NodeKind::Image => {
            out.push_str(&format!(
                r#"<image x="{x}" y="{y}" width="{}" height="{}" href="/api/assets/{}" preserveAspectRatio="none"/>"#,
                n.w, n.h, xml_escape(&n.image)
            ));
            for p in &n.strokes {
                out.push_str(&format!(
                    r#"<rect x="{x}" y="{y}" width="{}" height="{}" fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{}"/>"#,
                    n.w, n.h, xml_escape(&p.color), p.opacity, n.stroke_weight
                ));
            }
        }
    }
    out.push_str("</g>");
}
