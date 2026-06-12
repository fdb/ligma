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
use web_sys::CanvasRenderingContext2d;

mod model;
pub use model::*;
mod clip;
use clip::*;
mod tree;
use tree::*;
mod geometry;
use geometry::*;
mod text;
use text::*;
mod render;
use render::*;
mod svg;
use svg::*;

const DOC_VERSION: u32 = 2;
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
/// Resize handles: four corners (drawn as squares) then four mid-edge
/// grab bands (top, right, bottom, left — invisible, the whole edge).
const HANDLES: [(f64, f64); 8] = [
    (0.0, 0.0),
    (1.0, 0.0),
    (1.0, 1.0),
    (0.0, 1.0),
    (0.5, 0.0),
    (1.0, 0.5),
    (0.5, 1.0),
    (0.0, 0.5),
];

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
        /// The node hit at pointer-down: a click (no drag) on one node of
        /// a multi-selection narrows the selection to it on release.
        pressed: u32,
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
        /// 0 selects among root nodes; a frame id restricts the rubber
        /// band to that frame's children (drag started on its body).
        scope: u32,
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
            component: 0,
            bool_op: String::new(),
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
                    matches!(f.kind, NodeKind::Frame | NodeKind::Component)
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
                    // A deep-selected child stays the drag target while the
                    // pointer is over it, instead of popping back out to
                    // its group.
                    let id = self
                        .selection
                        .iter()
                        .copied()
                        .find(|&s| {
                            s != id
                                && is_within(&self.nodes, id, s)
                                && find_node(&self.nodes, s)
                                    .map_or(false, |n| self.node_hit(n, x, y))
                        })
                        .unwrap_or(id);
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
                    self.drag = Drag::Move {
                        starts,
                        ox: x,
                        oy: y,
                        moved: false,
                        alt_copied: alt,
                        pressed: if shift { 0 } else { id },
                    };
                } else {
                    // A non-empty frame's body is click-transparent, but a
                    // frame that is ALREADY selected still drags by it.
                    let dragging_selected = !shift
                        && !alt
                        && self.selection.iter().any(|&sid| {
                            find_node(&self.nodes, sid).is_some_and(|n| {
                                matches!(n.kind, NodeKind::Frame | NodeKind::Component)
                                    && n.contains(x, y)
                            })
                        });
                    if dragging_selected {
                        self.begin_mutation();
                        let starts = self
                            .selection
                            .iter()
                            .filter_map(|&sid| {
                                find_node(&self.nodes, sid).map(|n| (sid, n.x, n.y))
                            })
                            .collect();
                        self.drag = Drag::Move {
                            starts,
                            ox: x,
                            oy: y,
                            moved: false,
                            alt_copied: false,
                            pressed: 0,
                        };
                        self.touch();
                        return;
                    }
                    if !shift {
                        self.selection.clear();
                    }
                    // Inside a non-empty frame's body the rubber band
                    // scopes to that frame's children.
                    let scope = self
                        .nodes
                        .iter()
                        .rev()
                        .find(|f| {
                            matches!(f.kind, NodeKind::Frame | NodeKind::Component)
                                && !f.children.is_empty()
                                && f.visible
                                && !f.locked
                                && f.contains(x, y)
                        })
                        .map_or(0, |f| f.id);
                    self.drag = Drag::Marquee { ox: x, oy: y, cx: x, cy: y, scope };
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
                // Drawing that starts inside a frame parents the shape
                // immediately (children keep absolute coordinates), so the
                // outliner shows it in place from the first drag frame
                // instead of snapping it inside at pointer-up.
                if kind != NodeKind::Frame {
                    let target = self
                        .nodes
                        .iter()
                        .rev()
                        .find(|f| {
                            matches!(f.kind, NodeKind::Frame | NodeKind::Component)
                                && f.id != id
                                && f.visible
                                && !f.locked
                                && f.contains(x, y)
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
                self.drag = Drag::Draw { id, ox: x, oy: y };
                self.touch();
            }
        }
    }

    pub fn pointer_move(&mut self, sx: f64, sy: f64, shift: bool) {
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
                let (mut dx, mut dy) = (x - ox, y - oy);
                // Shift constrains to a square (circle), in the direction
                // the pointer actually went.
                if shift {
                    let s = dx.abs().max(dy.abs());
                    dx = if dx < 0.0 { -s } else { s };
                    dy = if dy < 0.0 { -s } else { s };
                }
                if let Some(n) = find_node_mut(&mut self.nodes, id) {
                    n.x = ox.min(ox + dx);
                    n.y = oy.min(oy + dy);
                    n.w = dx.abs();
                    n.h = dy.abs();
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
                let (bx, by, bw, bh, handle, ox, oy) =
                    (*bx, *by, *bw, *bh, *handle, *ox, *oy);
                let starts = starts.clone();
                let ids: Vec<u32> = starts.iter().map(|s| s.id).collect();
                // Images resize proportionally by default (Figma: the bitmap
                // is a fill, so free resize only crops); shift breaks the
                // lock. Everything else inverts: free by default, shift locks.
                let images = starts.iter().all(|s| s.kind == NodeKind::Image);
                let constrain = if images { !shift } else { shift };
                let (dx, dy) = (x - ox, y - oy);
                let (hx, hy) = HANDLES[handle];
                // A drag moves the edge(s) the handle sits on; the opposite
                // edge stays anchored. Mid-edge handles leave the other
                // axis alone.
                let (mut nx, mut nw) = if hx == 0.0 {
                    (bx + dx, bw - dx)
                } else if hx == 1.0 {
                    (bx, bw + dx)
                } else {
                    (bx, bw)
                };
                let (mut ny, mut nh) = if hy == 0.0 {
                    (by + dy, bh - dy)
                } else if hy == 1.0 {
                    (by, bh + dy)
                } else {
                    (by, bh)
                };
                // The dragged edge snaps to nearby edges/centers — most
                // usefully the parent frame's — unless proportions are
                // constrained (snapping one edge would break the ratio).
                self.guides.clear();
                if !constrain {
                    if hx != 0.5 {
                        let edge = if hx == 0.0 { nx } else { nx + nw };
                        if let Some((pos, from, to)) = self.snap_edge(edge, true, &ids) {
                            if hx == 0.0 {
                                nw += nx - pos;
                                nx = pos;
                            } else {
                                nw = pos - nx;
                            }
                            self.guides.push(Guide {
                                vertical: true,
                                pos,
                                from: from.min(ny),
                                to: to.max(ny + nh),
                            });
                        }
                    }
                    if hy != 0.5 {
                        let edge = if hy == 0.0 { ny } else { ny + nh };
                        if let Some((pos, from, to)) = self.snap_edge(edge, false, &ids) {
                            if hy == 0.0 {
                                nh += ny - pos;
                                ny = pos;
                            } else {
                                nh = pos - ny;
                            }
                            self.guides.push(Guide {
                                vertical: false,
                                pos,
                                from: from.min(nx),
                                to: to.max(nx + nw),
                            });
                        }
                    }
                }
                if nw < 0.0 {
                    nx += nw;
                    nw = -nw;
                }
                if nh < 0.0 {
                    ny += nh;
                    nh = -nh;
                }
                // Constrained resize keeps the original proportions,
                // following whichever axis changed more (corner handles only).
                if constrain && hx != 0.5 && hy != 0.5 && bw > 0.0 && bh > 0.0 {
                    let (fx, fy) = (nw / bw, nh / bh);
                    let f = if (fx - 1.0).abs() >= (fy - 1.0).abs() { fx } else { fy };
                    nw = bw * f;
                    nh = bh * f;
                    if hx == 0.0 {
                        nx = bx + bw - nw;
                    }
                    if hy == 0.0 {
                        ny = by + bh - nh;
                    }
                }
                let fx = if bw > 0.0 { nw / bw } else { 1.0 };
                let fy = if bh > 0.0 { nh / bh } else { 1.0 };
                let scaled: Vec<Node> = starts
                    .iter()
                    .map(|s| {
                        let mut c = s.clone();
                        scale_subtree(&mut c, bx, by, nx, ny, fx, fy);
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
            Drag::Marquee { ox, oy, cx, cy, scope } => {
                *cx = x;
                *cy = y;
                let (mx, my) = (ox.min(*cx), oy.min(*cy));
                let (mw, mh) = ((*cx - *ox).abs(), (*cy - *oy).abs());
                let list: &[Node] = if *scope == 0 {
                    &self.nodes
                } else {
                    find_node(&self.nodes, *scope).map_or(&[][..], |n| &n.children)
                };
                self.selection = list
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
                // (Frame parenting happened at pointer-down, so the
                // outliner never shows the shape at the top level.)
                // A frame drawn around existing objects adopts everything
                // fully enclosed by it (Figma behavior). Children keep
                // absolute coordinates, so nothing shifts.
                if let Some(f) = find_node(&self.nodes, id) {
                    if f.kind == NodeKind::Frame {
                        let (fx, fy, fw, fh) = (f.x, f.y, f.w, f.h);
                        let mut adopted = Vec::new();
                        let mut i = 0;
                        while i < self.nodes.len() {
                            let n = &self.nodes[i];
                            let enclosed = n.id != id
                                && !matches!(n.kind, NodeKind::Frame | NodeKind::Component)
                                && n.x >= fx
                                && n.y >= fy
                                && n.x + n.w <= fx + fw
                                && n.y + n.h <= fy + fh;
                            if enclosed {
                                adopted.push(self.nodes.remove(i));
                            } else {
                                i += 1;
                            }
                        }
                        if !adopted.is_empty() {
                            if let Some(f) = find_node_mut(&mut self.nodes, id) {
                                f.children.extend(adopted);
                            }
                        }
                    }
                }
                self.commit_mutation();
                self.tool = Tool::Select;
            }
            Drag::Move { starts, moved, alt_copied, pressed, .. } => {
                if moved {
                    let ids: Vec<u32> = starts.iter().map(|s| s.0).collect();
                    for (id, _, _) in starts {
                        if let Some(n) = find_node_mut(&mut self.nodes, id) {
                            round_subtree(n);
                        }
                    }
                    self.reparent_dropped(&ids);
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
                    // A plain click on one node of a multi-selection
                    // narrows the selection to it (Figma behavior).
                    if pressed != 0
                        && self.selection.len() > 1
                        && self.selection.contains(&pressed)
                    {
                        self.selection = vec![pressed];
                    }
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
            Drag::Marquee { .. } => {
                self.pending_undo = None;
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
                Some(1) | Some(3) => "nesw-resize",
                Some(4) | Some(6) => "ns-resize",
                Some(_) => "ew-resize",
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
        // Panel X/Y are relative to the direct parent container (Figma
        // semantics); geometry stays absolute world space internally.
        let (px, py) = parent_of(&self.nodes, id).map_or((0.0, 0.0), |p| (p.x, p.y));
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            match field {
                // Moving a group moves its subtree; its size is derived.
                "x" => {
                    let dx = px + value - n.x;
                    shift_subtree(n, dx, 0.0);
                }
                "y" => {
                    let dy = py + value - n.y;
                    shift_subtree(n, 0.0, dy);
                }
                // Resizing scales the whole subtree about the box's
                // top-left, so frame/group children and bezier anchors
                // follow proportionally (matching handle drags).
                "w" => {
                    let f = value.max(1.0) / n.w.max(1.0);
                    let (bx, by) = (n.x, n.y);
                    scale_subtree(n, bx, by, bx, by, f, 1.0);
                    // The ratio round-trip (w * value/w) drifts in floating
                    // point; the node's own size is the typed value, exactly.
                    n.w = value.max(1.0);
                    sync_path_bounds(n);
                }
                "h" => {
                    let f = value.max(1.0) / n.h.max(1.0);
                    let (bx, by) = (n.x, n.y);
                    scale_subtree(n, bx, by, bx, by, 1.0, f);
                    n.h = value.max(1.0);
                    sync_path_bounds(n);
                }
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
        self.apply_gradient(id, index, kind, angle, stops);
    }

    /// Live gradient update during a handle drag: no undo snapshot —
    /// wrap the gesture in begin_edit/commit_edit (same contract as
    /// set_field_live).
    pub fn set_paint_gradient_live(
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
        self.touch_doc();
        self.apply_gradient(id, index, kind, angle, stops);
    }

    fn apply_gradient(
        &mut self,
        id: u32,
        index: usize,
        kind: &str,
        angle: f64,
        stops: Vec<GradientStop>,
    ) {
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

    /// Replaces a text node's content and spans together, as one undo
    /// step — the styled inline editor commits through this. Hostile
    /// span payloads (oversized, markup-bearing) are dropped per span.
    pub fn set_text_styled(&mut self, id: u32, text: &str, spans_json: &str) {
        let Ok(mut spans) = serde_json::from_str::<Vec<Span>>(spans_json) else {
            return;
        };
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.text = text.to_string();
            let len = n.text.chars().count();
            spans.retain(|s| {
                s.len > 0
                    && s.start < len
                    && s.color.len() <= 32
                    && !s.color.contains(['<', '"', ';'])
                    && s.family.len() <= 64
                    && !s.family.contains(['<', '"', ';', '\''])
                    && (s.size == 0.0 || (1.0..=400.0).contains(&s.size))
            });
            for s in &mut spans {
                s.len = s.len.min(len - s.start);
            }
            n.spans = spans;
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
            let mut styles = char_styles(n);
            for c in styles.iter_mut().skip(start).take(len.min(chars.saturating_sub(start))) {
                if field == "bold" {
                    c.bold = on;
                } else {
                    c.italic = on;
                }
            }
            n.spans = run_length_spans(&styles);
        }
        self.touch();
    }

    /// Sets (or clears, with "") the fill-color override on a char range.
    pub fn set_span_color(&mut self, id: u32, start: usize, len: usize, color: &str) {
        if len == 0 || color.len() > 32 || color.contains(['<', '"', ';']) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let chars = n.text.chars().count();
            let mut styles = char_styles(n);
            for c in styles.iter_mut().skip(start).take(len.min(chars.saturating_sub(start))) {
                c.color = color.to_string();
            }
            n.spans = run_length_spans(&styles);
        }
        self.touch();
    }

    /// Sets (or clears, with 0) the font-size override on a char range.
    pub fn set_span_size(&mut self, id: u32, start: usize, len: usize, size: f64) {
        if len == 0 || !(size == 0.0 || (1.0..=400.0).contains(&size)) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let chars = n.text.chars().count();
            let mut styles = char_styles(n);
            for c in styles.iter_mut().skip(start).take(len.min(chars.saturating_sub(start))) {
                c.size = size;
            }
            n.spans = run_length_spans(&styles);
        }
        self.touch();
    }

    /// Sets (or clears, with "") the font-family override on a char range.
    pub fn set_span_family(&mut self, id: u32, start: usize, len: usize, family: &str) {
        if len == 0 || family.len() > 64 || family.contains(['<', '"', ';', '\'']) {
            return;
        }
        self.snapshot_now();
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            let chars = n.text.chars().count();
            let mut styles = char_styles(n);
            for c in styles.iter_mut().skip(start).take(len.min(chars.saturating_sub(start))) {
                c.family = family.to_string();
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
            component: 0,
            bool_op: String::new(),
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
                find_node(&self.nodes, id)
                    .map(|n| matches!(n.kind, NodeKind::Group | NodeKind::Bool))
                    .unwrap_or(false)
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
            component: 0,
            bool_op: String::new(),
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
        if self.selection.len() < 2 {
            return;
        }
        // Subject = the lowest shape in z-order (Figma semantics); the
        // others clip into the accumulated result from bottom to top.
        let mut ordered: Vec<(Vec<usize>, u32)> = self
            .selection
            .iter()
            .filter_map(|&id| path_to(&self.nodes, id).map(|p| (p, id)))
            .collect();
        if ordered.len() < 2 {
            return;
        }
        ordered.sort();
        let ids: Vec<u32> = ordered.into_iter().map(|(_, id)| id).collect();
        let sa = ids[0];
        let regions: Vec<Vec<Vec<(f64, f64)>>> = ids
            .iter()
            .filter_map(|&id| find_node(&self.nodes, id).map(node_region))
            .collect();
        if fold_regions(regions, opcode).is_empty() {
            return;
        }
        self.snapshot_now();

        // Non-destructive: the sources move into a boolean group whose
        // outline is recomputed from them live; ⌘E bakes it to a path.
        let style = find_node(&self.nodes, sa).unwrap().clone();
        let insert_path = path_to(&self.nodes, sa).unwrap();
        let insert_at = *insert_path.last().unwrap();
        let id = self.next_id;
        self.next_id += 1;
        let name = format!(
            "{} {}",
            match opcode {
                0 => "Intersect",
                2 => "Subtract",
                _ => "Union",
            },
            count_kind(&self.nodes, NodeKind::Bool) + 1
        );
        let node = Node {
            id,
            name,
            kind: NodeKind::Bool,
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
            points: Vec::new(),
            closed: false,
            inner: Vec::new(),
            spans: Vec::new(),
            component: 0,
            bool_op: op.to_string(),
            export_presets: Vec::new(),
            children: Vec::new(),
        };
        let list = list_at(&mut self.nodes, &insert_path);
        list.insert(insert_at.min(list.len()), node);
        // Move the sources inside, subject (lowest z) first.
        for sid in ids {
            if let Some(p) = path_to(&self.nodes, sid) {
                let i = *p.last().unwrap();
                let child = list_at(&mut self.nodes, &p).remove(i);
                if let Some(b) = find_node_mut(&mut self.nodes, id) {
                    b.children.push(child);
                }
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
        // Collect convertible nodes first. Closed outlines become mitered
        // offset rings; open paths become capsule-union outlines with
        // round joins and round end caps.
        let mut jobs: Vec<(u32, Vec<Vec<(f64, f64)>>, Paint, Node)> = Vec::new();
        for &id in &self.selection {
            let Some(n) = find_node(&self.nodes, id) else {
                continue;
            };
            if n.strokes.is_empty() || n.stroke_weight <= 0.0 {
                continue;
            }
            let rings = if n.kind == NodeKind::Path && !n.closed && n.points.len() >= 2 {
                stroke_polyline(&flatten_path(&n.points, false), n.stroke_weight / 2.0)
            } else {
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
                vec![
                    offset_polygon(&poly, n.stroke_weight / 2.0),
                    offset_polygon(&poly, -n.stroke_weight / 2.0),
                ]
            };
            if rings.is_empty() || rings[0].len() < 3 {
                continue;
            }
            jobs.push((id, rings, n.strokes[0].clone(), n.clone()));
        }
        if jobs.is_empty() {
            return;
        }
        self.snapshot_now();
        let mut new_sel = Vec::new();
        for (id, mut rings, paint, style) in jobs {
            let outer = rings.remove(0);
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
                inner: rings.iter().map(|r| to_anchors(r)).collect(),
                spans: Vec::new(),
                component: 0,
            bool_op: String::new(),
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
        self.wrap_selection(NodeKind::Frame);
    }

    /// Converts the selection into a component (a reusable master).
    pub fn create_component(&mut self) {
        self.wrap_selection(NodeKind::Component);
    }

    /// Places an instance of the selected component beside it.
    pub fn create_instance(&mut self) {
        if self.selection.len() != 1 {
            return;
        }
        let Some(m) = find_node(&self.nodes, self.selection[0]) else {
            return;
        };
        if m.kind != NodeKind::Component {
            return;
        }
        let (mid, mx, my, mw, mh, mname) = (m.id, m.x, m.y, m.w, m.h, m.name.clone());
        self.snapshot_now();
        let id = self.add_node(NodeKind::Instance, mx + mw + 24.0, my, mw, mh);
        if let Some(n) = find_node_mut(&mut self.nodes, id) {
            n.component = mid;
            n.name = mname;
            n.fills.clear(); // the master paints the instance
        }
        self.selection = vec![id];
        self.touch();
    }

    fn wrap_selection(&mut self, kind: NodeKind) {
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
        let name = match kind {
            NodeKind::Component => {
                format!("Component {}", count_kind(&self.nodes, NodeKind::Component) + 1)
            }
            _ => format!("Frame {}", count_kind(&self.nodes, NodeKind::Frame) + 1),
        };
        let frame = Node {
            id,
            name,
            kind,
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
            component: 0,
            bool_op: String::new(),
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

    /// Solid colors used anywhere in the document (fills, strokes,
    /// gradient stops, text span colors), most frequent first, as a JSON
    /// array of hex strings. Feeds the picker's "document colors" row.
    pub fn document_colors(&self) -> String {
        fn add(counts: &mut Vec<(String, u32)>, c: &str) {
            if c.is_empty() {
                return;
            }
            match counts.iter_mut().find(|(k, _)| k == c) {
                Some(e) => e.1 += 1,
                None => counts.push((c.to_string(), 1)),
            }
        }
        fn walk(counts: &mut Vec<(String, u32)>, nodes: &[Node]) {
            for n in nodes {
                for p in n.fills.iter().chain(&n.strokes) {
                    add(counts, &p.color);
                    for s in &p.stops {
                        add(counts, &s.color);
                    }
                }
                for s in &n.spans {
                    add(counts, &s.color);
                }
                walk(counts, &n.children);
            }
        }
        let mut counts = Vec::new();
        walk(&mut counts, &self.nodes);
        counts.sort_by(|a, b| b.1.cmp(&a.1));
        counts.truncate(12);
        let colors: Vec<String> = counts.into_iter().map(|(c, _)| c).collect();
        serde_json::to_string(&colors).unwrap_or_else(|_| "[]".into())
    }

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
        self.reparent_many(&[id], parent, before);
    }

    /// Reparents several nodes in one undo step, preserving their order
    /// (the outliner drags whole selections). Invalid moves are skipped.
    pub fn reparent_many(&mut self, ids: &[u32], parent: u32, before: u32) {
        let valid: Vec<u32> =
            ids.iter().copied().filter(|&id| self.can_reparent(id, parent)).collect();
        if valid.is_empty() {
            return;
        }
        self.snapshot_now();
        for &id in &valid {
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
        }
        dissolve_empty_groups(&mut self.nodes);
        recompute_group_bounds(&mut self.nodes);
        self.retain_valid_selection();
        self.touch();
    }

    fn can_reparent(&self, id: u32, parent: u32) -> bool {
        if id == parent || find_node(&self.nodes, id).is_none() {
            return false;
        }
        // The target may not be inside the moved subtree.
        if let Some(n) = find_node(&self.nodes, id) {
            if parent != 0 && find_node(&n.children, parent).is_some() {
                return false;
            }
        }
        if parent != 0 {
            match find_node(&self.nodes, parent) {
                Some(p)
                    if matches!(
                        p.kind,
                        NodeKind::Frame | NodeKind::Group | NodeKind::Component | NodeKind::Bool
                    ) => {}
                _ => return false,
            }
        }
        true
    }

    /// After a move-drag, drops the dragged nodes into the topmost root
    /// frame under the selection's center, or back to the root when they
    /// land on open canvas. Runs inside the move's mutation, so the move
    /// and the reparent undo as one step. Children keep absolute
    /// coordinates, so nothing shifts.
    fn reparent_dropped(&mut self, ids: &[u32]) {
        let Some((bx, by, bx2, by2)) = self.selection_bbox(ids) else { return };
        let (cx, cy) = ((bx + bx2) / 2.0, (by + by2) / 2.0);
        let target = self
            .nodes
            .iter()
            .rev()
            .find(|f| {
                matches!(f.kind, NodeKind::Frame | NodeKind::Component)
                    && !ids.contains(&f.id)
                    && f.visible
                    && !f.locked
                    && f.contains(cx, cy)
            })
            .map_or(0, |f| f.id);
        for &id in ids {
            let Some(n) = find_node(&self.nodes, id) else { continue };
            // Frames don't nest (Figma 1.0 scope); group/bool members
            // travel with their container instead of escaping it.
            if matches!(n.kind, NodeKind::Frame | NodeKind::Component) {
                continue;
            }
            match parent_of(&self.nodes, id) {
                Some(p) if matches!(p.kind, NodeKind::Group | NodeKind::Bool) => continue,
                Some(p) if p.id == target => continue,
                None if target == 0 => continue,
                _ => {}
            }
            let path = path_to(&self.nodes, id).unwrap();
            let i = *path.last().unwrap();
            let node = list_at(&mut self.nodes, &path).remove(i);
            if target == 0 {
                self.nodes.push(node);
            } else if let Some(f) = find_node_mut(&mut self.nodes, target) {
                f.children.push(node);
            }
        }
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

    /// Double-click "deep select": narrows the selection one container
    /// level along the hit chain under a screen point (group → child →
    /// grandchild…, Figma-style). Returns false at a leaf so callers can
    /// fall through to text or path editing.
    pub fn deep_select(&mut self, sx: f64, sy: f64) -> bool {
        let (x, y) = self.to_world(sx, sy);
        let mut chain: Vec<u32> = Vec::new();
        let mut list: &[Node] = &self.nodes;
        loop {
            let Some(n) = list
                .iter()
                .rev()
                .find(|n| n.visible && !n.locked && self.node_hit(n, x, y))
            else {
                break;
            };
            chain.push(n.id);
            if matches!(
                n.kind,
                NodeKind::Frame | NodeKind::Component | NodeKind::Group | NodeKind::Bool
            ) {
                list = &n.children;
            } else {
                break;
            }
        }
        if chain.is_empty() {
            return false;
        }
        // One level below the deepest currently-selected ancestor; with
        // no selection on the chain, behave like a plain click.
        let next = match chain.iter().rposition(|id| self.selection.contains(id)) {
            Some(i) if i + 1 < chain.len() => chain[i + 1],
            Some(_) => return false,
            None => chain[0],
        };
        self.selection = vec![next];
        self.touch();
        true
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
            draw_node(ctx, n, 1.0, scale, &self.text_layouts, &self.nodes, 0, None);
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
        svg_node(n, -n.x, -n.y, &mut out, &self.text_layouts.borrow(), &self.nodes, 0);
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
            // instead, however deeply nested. (Frames being renamed keep
            // their body; only the label pass skips them.)
            draw_node(ctx, n, 1.0, self.zoom, &self.text_layouts, &self.nodes, 0, self.editing);
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
                for &(hx, hy) in &HANDLES[..4] {
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
        if let Drag::Marquee { ox, oy, cx, cy, .. } = self.drag {
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
            if matches!(n.kind, NodeKind::Frame | NodeKind::Component) {
                if let Some(c) = n
                    .children
                    .iter()
                    .rev()
                    .find(|c| c.visible && !c.locked && self.node_hit(c, x, y))
                {
                    return Some(c.id);
                }
                // A non-empty frame's body is click-transparent: only its
                // children, its label, or an empty frame hit directly.
                if !n.children.is_empty() {
                    continue;
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
        // Boolean groups hit against their computed result (even-odd),
        // so subtract holes don't swallow clicks.
        if n.kind == NodeKind::Bool {
            if !n.contains(x, y) {
                return false;
            }
            let mut inside = false;
            for ring in bool_rings(n) {
                if point_in_polygon(&ring, x, y) {
                    inside = !inside;
                }
            }
            return inside;
        }
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
        if let Some(i) = HANDLES[..4].iter().position(|(hx, hy)| {
            let px = (bx + hx * (bx2 - bx)) * self.zoom + self.pan_x;
            let py = (by + hy * (by2 - by)) * self.zoom + self.pan_y;
            (sx - px).abs() <= grab && (sy - py).abs() <= grab
        }) {
            return Some(i);
        }
        // Whole edges act as grab bands between the corner zones.
        let (x0, y0) = (bx * self.zoom + self.pan_x, by * self.zoom + self.pan_y);
        let (x1, y1) = (bx2 * self.zoom + self.pan_x, by2 * self.zoom + self.pan_y);
        let band = 4.0;
        let inx = sx > x0 + grab && sx < x1 - grab;
        let iny = sy > y0 + grab && sy < y1 - grab;
        if inx && (sy - y0).abs() <= band {
            return Some(4);
        }
        if iny && (sx - x1).abs() <= band {
            return Some(5);
        }
        if inx && (sy - y1).abs() <= band {
            return Some(6);
        }
        if iny && (sx - x0).abs() <= band {
            return Some(7);
        }
        None
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

    /// Nearest snap candidate for one moving edge coordinate, against the
    /// edges/centers of top-level nodes and of the moved nodes' direct
    /// parents (so a child's resize snaps to its frame). Returns the
    /// snapped position plus the candidate's perpendicular span for the
    /// guide line.
    fn snap_edge(&self, v: f64, vertical: bool, exclude: &[u32]) -> Option<(f64, f64, f64)> {
        let threshold = 6.0 / self.zoom;
        let mut best: Option<(f64, f64, f64, f64)> = None;
        let mut consider = |n: &Node| {
            let cands = if vertical {
                [n.x, n.x + n.w / 2.0, n.x + n.w]
            } else {
                [n.y, n.y + n.h / 2.0, n.y + n.h]
            };
            let (from, to) = if vertical { (n.y, n.y + n.h) } else { (n.x, n.x + n.w) };
            for cand in cands {
                let d = cand - v;
                if d.abs() < threshold && best.map_or(true, |(bd, ..)| d.abs() < bd.abs()) {
                    best = Some((d, cand, from, to));
                }
            }
        };
        for n in &self.nodes {
            if n.visible && !exclude.contains(&n.id) {
                consider(n);
            }
        }
        for &id in exclude {
            if let Some(p) = parent_of(&self.nodes, id) {
                if p.visible {
                    consider(p);
                }
            }
        }
        best.map(|(_, pos, from, to)| (pos, from, to))
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
            NodeKind::Component => (format!("Component {count}"), "#ffffff"),
            NodeKind::Instance => (format!("Instance {count}"), "#ffffff"),
            NodeKind::Bool => (format!("Boolean {count}"), "#d4d4d8"),
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
            component: 0,
            bool_op: String::new(),
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

