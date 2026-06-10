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
use std::f64::consts::TAU;
use wasm_bindgen::prelude::*;
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
}

/// A single fill or stroke: a color with its own opacity.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paint {
    pub color: String,
    pub opacity: f64,
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
    pub corner_radius: f64,
    pub text: String,
    pub font_size: f64,
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
    for c in &mut n.children {
        scale_subtree(c, bx, by, nx, ny, fx, fy);
    }
}

fn round_subtree(n: &mut Node) {
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
            Tool::Hand => "hand",
        }
    }

    fn from_str(s: &str) -> Tool {
        match s {
            "frame" => Tool::Frame,
            "rect" => Tool::Rect,
            "ellipse" => Tool::Ellipse,
            "text" => Tool::Text,
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
            fills: vec![Paint { color: n.fill, opacity: 1.0 }],
            strokes: Vec::new(),
            stroke_weight: 1.0,
            opacity: n.opacity,
            corner_radius: n.corner_radius,
            text: n.text,
            font_size: n.font_size,
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
    guides: Vec<Guide>,
    editing: Option<u32>,
    pending_undo: Option<Vec<Node>>,
    undo: Vec<Vec<Node>>,
    redo: Vec<Vec<Node>>,
    clipboard: Vec<Node>,
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
            guides: Vec::new(),
            editing: None,
            pending_undo: None,
            undo: Vec::new(),
            redo: Vec::new(),
            clipboard: Vec::new(),
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
        self.undo.clear();
        self.redo.clear();
        self.touch();
        true
    }

    // ----- tools -----

    pub fn set_tool(&mut self, tool: &str) {
        self.tool = Tool::from_str(tool);
        self.touch();
    }

    // ----- pointer input (screen coordinates) -----

    pub fn pointer_down(&mut self, sx: f64, sy: f64, shift: bool, alt: bool) {
        let (x, y) = self.to_world(sx, sy);
        match self.tool {
            Tool::Hand => {
                self.drag = Drag::Pan { last_x: sx, last_y: sy };
            }
            Tool::Select => {
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
            let paint = Paint { color: "#d4d4d8".to_string(), opacity: 1.0 };
            if kind == "strokes" {
                n.strokes.push(Paint { color: "#18181b".to_string(), ..paint });
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
            }
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
            corner_radius: 0.0,
            text: String::new(),
            font_size: 16.0,
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
            draw_node(ctx, n, 1.0, scale);
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
        svg_node(n, -n.x, -n.y, &mut out);
        out.push_str("</svg>");
        out
    }

    // ----- undo -----

    pub fn undo(&mut self) {
        if let Some(prev) = self.undo.pop() {
            self.redo.push(std::mem::replace(&mut self.nodes, prev));
            self.retain_valid_selection();
            self.touch_doc();
            self.touch();
        }
    }

    pub fn redo(&mut self) {
        if let Some(next) = self.redo.pop() {
            self.undo.push(std::mem::replace(&mut self.nodes, next));
            self.retain_valid_selection();
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
            draw_node(ctx, n, 1.0, self.zoom);
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
            if !n.visible || n.locked || !n.contains(x, y) {
                continue;
            }
            if n.kind == NodeKind::Frame {
                if let Some(c) =
                    n.children.iter().rev().find(|c| c.visible && !c.locked && c.contains(x, y))
                {
                    return Some(c.id);
                }
            }
            return Some(n.id);
        }
        None
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
            fills: vec![Paint { color: fill.to_string(), opacity: 1.0 }],
            strokes: Vec::new(),
            stroke_weight: 1.0,
            opacity: 1.0,
            corner_radius: 0.0,
            text: if kind == NodeKind::Text { "Text".to_string() } else { String::new() },
            font_size: 16.0,
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

fn draw_node(ctx: &CanvasRenderingContext2d, n: &Node, parent_alpha: f64, zoom: f64) {
    if !n.visible {
        return;
    }
    let alpha = parent_alpha * n.opacity;
    match n.kind {
        NodeKind::Group => {
            for c in &n.children {
                draw_node(ctx, c, alpha, zoom);
            }
        }
        NodeKind::Frame => {
            ctx.set_shadow_color("rgba(24, 24, 27, 0.10)");
            ctx.set_shadow_blur(3.0);
            ctx.set_shadow_offset_y(1.0);
            for p in &n.fills {
                ctx.set_global_alpha(alpha * p.opacity);
                ctx.set_fill_style_str(&p.color);
                fill_rounded(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
                ctx.set_shadow_color("transparent");
            }
            ctx.set_shadow_color("transparent");
            ctx.set_shadow_blur(0.0);
            ctx.set_shadow_offset_y(0.0);
            stroke_paints(ctx, n, alpha, |ctx| {
                rounded_rect_path(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            });
            for c in &n.children {
                draw_node(ctx, c, alpha, zoom);
            }
        }
        NodeKind::Rect => {
            for p in &n.fills {
                ctx.set_global_alpha(alpha * p.opacity);
                ctx.set_fill_style_str(&p.color);
                fill_rounded(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            }
            stroke_paints(ctx, n, alpha, |ctx| {
                rounded_rect_path(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
            });
        }
        NodeKind::Ellipse => {
            for p in &n.fills {
                ctx.set_global_alpha(alpha * p.opacity);
                ctx.set_fill_style_str(&p.color);
                ellipse_path(ctx, n);
                ctx.fill();
            }
            stroke_paints(ctx, n, alpha, |ctx| ellipse_path(ctx, n));
        }
        NodeKind::Text => {
            ctx.set_font(&format!("{}px 'Hanken Grotesk', sans-serif", n.font_size));
            ctx.set_text_baseline("top");
            let ty = n.y + (n.h - n.font_size).max(0.0) / 2.0;
            for p in &n.fills {
                ctx.set_global_alpha(alpha * p.opacity);
                ctx.set_fill_style_str(&p.color);
                let _ = ctx.fill_text(&n.text, n.x, ty);
            }
            for p in &n.strokes {
                ctx.set_global_alpha(alpha * p.opacity);
                ctx.set_stroke_style_str(&p.color);
                ctx.set_line_width(n.stroke_weight);
                let _ = ctx.stroke_text(&n.text, n.x, ty);
            }
        }
    }
    ctx.set_global_alpha(1.0);
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

fn svg_node(n: &Node, ox: f64, oy: f64, out: &mut String) {
    if !n.visible {
        return;
    }
    let opacity = if n.opacity < 1.0 { format!(r#" opacity="{}""#, n.opacity) } else { String::new() };
    out.push_str(&format!("<g{opacity}>"));
    let (x, y) = (n.x + ox, n.y + oy);
    match n.kind {
        NodeKind::Group => {
            for c in &n.children {
                svg_node(c, ox, oy, out);
            }
        }
        NodeKind::Frame | NodeKind::Rect => {
            let rx = n.corner_radius.min(n.w / 2.0).min(n.h / 2.0);
            let rx_attr = if rx > 0.0 { format!(r#" rx="{rx}""#) } else { String::new() };
            for p in &n.fills {
                out.push_str(&format!(
                    r#"<rect x="{x}" y="{y}" width="{}" height="{}"{rx_attr} fill="{}" fill-opacity="{}"/>"#,
                    n.w, n.h, xml_escape(&p.color), p.opacity
                ));
            }
            for p in &n.strokes {
                out.push_str(&format!(
                    r#"<rect x="{x}" y="{y}" width="{}" height="{}"{rx_attr} fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{}"/>"#,
                    n.w, n.h, xml_escape(&p.color), p.opacity, n.stroke_weight
                ));
            }
            for c in &n.children {
                svg_node(c, ox, oy, out);
            }
        }
        NodeKind::Ellipse => {
            let (cx, cy, rx, ry) = (x + n.w / 2.0, y + n.h / 2.0, n.w / 2.0, n.h / 2.0);
            for p in &n.fills {
                out.push_str(&format!(
                    r#"<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{}" fill-opacity="{}"/>"#,
                    xml_escape(&p.color), p.opacity
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
            // Baseline approximation: top-aligned text sits one em below
            // its vertical-centering offset.
            let ty = y + (n.h - n.font_size).max(0.0) / 2.0 + n.font_size * 0.8;
            for p in &n.fills {
                out.push_str(&format!(
                    r#"<text x="{x}" y="{ty}" font-family="Hanken Grotesk, sans-serif" font-size="{}" fill="{}" fill-opacity="{}">{}</text>"#,
                    n.font_size, xml_escape(&p.color), p.opacity, xml_escape(&n.text)
                ));
            }
        }
    }
    out.push_str("</g>");
}
