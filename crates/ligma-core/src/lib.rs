//! Ligma core: the editor engine.
//!
//! Owns the document (a flat, z-ordered list of nodes), the camera, the
//! active tool's state machine, selection, undo history, and rendering.
//! The JS side forwards raw input events and reads scene snapshots; it
//! never mutates document state directly.

use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;
use wasm_bindgen::prelude::*;
use web_sys::CanvasRenderingContext2d;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Frame,
    Rect,
    Ellipse,
    Text,
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
    pub fill: String,
    pub opacity: f64,
    pub corner_radius: f64,
    pub text: String,
    pub font_size: f64,
}

impl Node {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }

    fn intersects(&self, x: f64, y: f64, w: f64, h: f64) -> bool {
        self.x < x + w && self.x + self.w > x && self.y < y + h && self.y + self.h > y
    }
}

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
    },
    Resize {
        id: u32,
        handle: usize,
        sx: f64,
        sy: f64,
        sw: f64,
        sh: f64,
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

#[derive(Serialize, Deserialize)]
struct Document {
    nodes: Vec<Node>,
    next_id: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneInfo<'a> {
    nodes: &'a [Node],
    selection: &'a [u32],
    hovered: Option<u32>,
    tool: &'static str,
    zoom: f64,
    generation: u32,
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
    pending_undo: Option<Vec<Node>>,
    undo: Vec<Vec<Node>>,
    redo: Vec<Vec<Node>>,
    generation: u32,
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
            pending_undo: None,
            undo: Vec::new(),
            redo: Vec::new(),
            generation: 0,
        }
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn scene(&self) -> String {
        serde_json::to_string(&SceneInfo {
            nodes: &self.nodes,
            selection: &self.selection,
            hovered: self.hovered,
            tool: self.tool.as_str(),
            zoom: self.zoom,
            generation: self.generation,
        })
        .unwrap_or_default()
    }

    // ----- document persistence -----

    pub fn to_json(&self) -> String {
        serde_json::to_string(&Document {
            nodes: self.nodes.clone(),
            next_id: self.next_id,
        })
        .unwrap_or_default()
    }

    pub fn load_json(&mut self, json: &str) -> bool {
        match serde_json::from_str::<Document>(json) {
            Ok(doc) => {
                self.nodes = doc.nodes;
                self.next_id = doc.next_id;
                self.selection.clear();
                self.hovered = None;
                self.undo.clear();
                self.redo.clear();
                self.touch();
                true
            }
            Err(_) => false,
        }
    }

    // ----- tools -----

    pub fn set_tool(&mut self, tool: &str) {
        self.tool = Tool::from_str(tool);
        self.touch();
    }

    // ----- pointer input (screen coordinates) -----

    pub fn pointer_down(&mut self, sx: f64, sy: f64, shift: bool) {
        let (x, y) = self.to_world(sx, sy);
        match self.tool {
            Tool::Hand => {
                self.drag = Drag::Pan { last_x: sx, last_y: sy };
            }
            Tool::Select => {
                // Resize handles take priority, then nodes, then marquee.
                if let Some(handle) = self.handle_at(sx, sy) {
                    let id = self.selection[0];
                    let n = self.node(id).unwrap();
                    let (nx, ny, nw, nh) = (n.x, n.y, n.w, n.h);
                    self.begin_mutation();
                    self.drag = Drag::Resize {
                        id,
                        handle,
                        sx: nx,
                        sy: ny,
                        sw: nw,
                        sh: nh,
                        ox: x,
                        oy: y,
                    };
                } else if let Some(id) = self.hit_test(x, y) {
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
                    let starts = self
                        .selection
                        .iter()
                        .filter_map(|&sid| self.node(sid).map(|n| (sid, n.x, n.y)))
                        .collect();
                    self.drag = Drag::Move { starts, ox: x, oy: y, moved: false };
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
                if let Some(n) = self.node_mut(id) {
                    n.x = ox.min(x);
                    n.y = oy.min(y);
                    n.w = (x - ox).abs();
                    n.h = (y - oy).abs();
                }
            }
            Drag::Move { starts, ox, oy, moved } => {
                let (dx, dy) = (x - *ox, y - *oy);
                *moved = *moved || dx.abs() > 0.01 || dy.abs() > 0.01;
                let updates: Vec<(u32, f64, f64)> =
                    starts.iter().map(|&(id, nx, ny)| (id, nx + dx, ny + dy)).collect();
                for (id, nx, ny) in updates {
                    if let Some(n) = self.node_mut(id) {
                        n.x = nx;
                        n.y = ny;
                    }
                }
            }
            Drag::Resize { id, handle, sx: rx, sy: ry, sw, sh, ox, oy } => {
                let (dx, dy) = (x - *ox, y - *oy);
                let (hx, hy) = HANDLES[*handle];
                // A corner drag moves the edge(s) it sits on; the opposite
                // corner stays anchored.
                let (mut nx, mut nw) = if hx == 0.0 {
                    (*rx + dx, *sw - dx)
                } else {
                    (*rx, *sw + dx)
                };
                let (mut ny, mut nh) = if hy == 0.0 {
                    (*ry + dy, *sh - dy)
                } else {
                    (*ry, *sh + dy)
                };
                if nw < 0.0 {
                    nx += nw;
                    nw = -nw;
                }
                if nh < 0.0 {
                    ny += nh;
                    nh = -nh;
                }
                let id = *id;
                if let Some(n) = self.node_mut(id) {
                    n.x = nx;
                    n.y = ny;
                    n.w = nw;
                    n.h = nh;
                }
            }
            Drag::Marquee { ox, oy, cx, cy } => {
                *cx = x;
                *cy = y;
                let (mx, my) = (ox.min(*cx), oy.min(*cy));
                let (mw, mh) = ((*cx - *ox).abs(), (*cy - *oy).abs());
                self.selection = self
                    .nodes
                    .iter()
                    .filter(|n| n.intersects(mx, my, mw, mh))
                    .map(|n| n.id)
                    .collect();
            }
        }
        self.touch();
    }

    pub fn pointer_up(&mut self) {
        match std::mem::replace(&mut self.drag, Drag::None) {
            Drag::Draw { id, .. } => {
                if let Some(n) = self.node_mut(id) {
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
                    round_rect_props(n);
                }
                self.commit_mutation();
                self.tool = Tool::Select;
            }
            Drag::Move { starts, moved, .. } => {
                if moved {
                    for (id, _, _) in starts {
                        if let Some(n) = self.node_mut(id) {
                            round_rect_props(n);
                        }
                    }
                    self.commit_mutation();
                } else {
                    self.pending_undo = None;
                }
            }
            Drag::Resize { id, .. } => {
                if let Some(n) = self.node_mut(id) {
                    round_rect_props(n);
                }
                self.commit_mutation();
            }
            _ => {
                self.pending_undo = None;
            }
        }
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

    // ----- selection & edits (panel-driven) -----

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

    pub fn set_field(&mut self, id: u32, field: &str, value: f64) {
        self.snapshot_now();
        if let Some(n) = self.node_mut(id) {
            match field {
                "x" => n.x = value,
                "y" => n.y = value,
                "w" => n.w = value.max(1.0),
                "h" => n.h = value.max(1.0),
                "opacity" => n.opacity = value.clamp(0.0, 1.0),
                "cornerRadius" => n.corner_radius = value.max(0.0),
                "fontSize" => n.font_size = value.max(1.0),
                _ => {}
            }
        }
        self.touch();
    }

    pub fn set_fill(&mut self, id: u32, fill: &str) {
        self.snapshot_now();
        if let Some(n) = self.node_mut(id) {
            n.fill = fill.to_string();
        }
        self.touch();
    }

    pub fn set_name(&mut self, id: u32, name: &str) {
        if let Some(n) = self.node_mut(id) {
            n.name = name.to_string();
        }
        self.touch();
    }

    pub fn set_text(&mut self, id: u32, text: &str) {
        self.snapshot_now();
        if let Some(n) = self.node_mut(id) {
            n.text = text.to_string();
        }
        self.touch();
    }

    pub fn delete_selection(&mut self) {
        if self.selection.is_empty() {
            return;
        }
        self.snapshot_now();
        self.nodes.retain(|n| !self.selection.contains(&n.id));
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
        let copies: Vec<Node> = self
            .nodes
            .iter()
            .filter(|n| self.selection.contains(&n.id))
            .cloned()
            .collect();
        for mut n in copies {
            n.id = self.next_id;
            self.next_id += 1;
            n.x += 16.0;
            n.y += 16.0;
            new_ids.push(n.id);
            self.nodes.push(n);
        }
        self.selection = new_ids;
        self.touch();
    }

    pub fn nudge(&mut self, dx: f64, dy: f64) {
        if self.selection.is_empty() {
            return;
        }
        self.snapshot_now();
        let ids = self.selection.clone();
        for id in ids {
            if let Some(n) = self.node_mut(id) {
                n.x += dx;
                n.y += dy;
            }
        }
        self.touch();
    }

    /// Move a node to a new z-index (position in document order).
    pub fn reorder(&mut self, id: u32, to: usize) {
        if let Some(from) = self.nodes.iter().position(|n| n.id == id) {
            self.snapshot_now();
            let n = self.nodes.remove(from);
            self.nodes.insert(to.min(self.nodes.len()), n);
            self.touch();
        }
    }

    // ----- undo -----

    pub fn undo(&mut self) {
        if let Some(prev) = self.undo.pop() {
            self.redo.push(std::mem::replace(&mut self.nodes, prev));
            self.retain_valid_selection();
            self.touch();
        }
    }

    pub fn redo(&mut self) {
        if let Some(next) = self.redo.pop() {
            self.undo.push(std::mem::replace(&mut self.nodes, next));
            self.retain_valid_selection();
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
            ctx.set_global_alpha(n.opacity);
            match n.kind {
                NodeKind::Frame => {
                    ctx.set_shadow_color("rgba(24, 24, 27, 0.10)");
                    ctx.set_shadow_blur(3.0 * dpr);
                    ctx.set_shadow_offset_y(1.0 * dpr);
                    ctx.set_fill_style_str(&n.fill);
                    fill_rounded(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
                    ctx.set_shadow_color("transparent");
                    ctx.set_shadow_blur(0.0);
                    ctx.set_shadow_offset_y(0.0);
                }
                NodeKind::Rect => {
                    ctx.set_fill_style_str(&n.fill);
                    fill_rounded(ctx, n.x, n.y, n.w, n.h, n.corner_radius);
                }
                NodeKind::Ellipse => {
                    ctx.set_fill_style_str(&n.fill);
                    ctx.begin_path();
                    let _ = ctx.ellipse(
                        n.x + n.w / 2.0,
                        n.y + n.h / 2.0,
                        n.w / 2.0,
                        n.h / 2.0,
                        0.0,
                        0.0,
                        TAU,
                    );
                    ctx.fill();
                }
                NodeKind::Text => {
                    ctx.set_fill_style_str(&n.fill);
                    ctx.set_font(&format!(
                        "{}px 'Hanken Grotesk', sans-serif",
                        n.font_size
                    ));
                    ctx.set_text_baseline("top");
                    let _ = ctx.fill_text(&n.text, n.x, n.y + (n.h - n.font_size).max(0.0) / 2.0);
                }
            }
        }
        ctx.set_global_alpha(1.0);

        // Hover highlight.
        if let Some(id) = self.hovered {
            if !self.selection.contains(&id) {
                if let Some(n) = self.node(id) {
                    ctx.set_stroke_style_str("#38bdf8");
                    ctx.set_line_width(1.5 / self.zoom);
                    ctx.stroke_rect(n.x, n.y, n.w, n.h);
                }
            }
        }

        // Selection outlines + handles.
        for &id in &self.selection {
            if let Some(n) = self.node(id) {
                ctx.set_stroke_style_str("#0ea5e9");
                ctx.set_line_width(1.5 / self.zoom);
                ctx.stroke_rect(n.x, n.y, n.w, n.h);
                if self.selection.len() == 1 {
                    let hs = 7.0 / self.zoom;
                    for (hx, hy) in HANDLES {
                        let (px, py) = (n.x + hx * n.w - hs / 2.0, n.y + hy * n.h - hs / 2.0);
                        ctx.set_fill_style_str("#ffffff");
                        ctx.fill_rect(px, py, hs, hs);
                        ctx.set_line_width(1.0 / self.zoom);
                        ctx.stroke_rect(px, py, hs, hs);
                    }
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

        // Frame labels are drawn in screen space so they stay readable at
        // any zoom level.
        let _ = ctx.set_transform(dpr, 0.0, 0.0, dpr, 0.0, 0.0);
        ctx.set_font("11px 'Hanken Grotesk', sans-serif");
        ctx.set_text_baseline("alphabetic");
        for n in &self.nodes {
            if n.kind == NodeKind::Frame {
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

    fn node(&self, id: u32) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    fn node_mut(&mut self, id: u32) -> Option<&mut Node> {
        self.nodes.iter_mut().find(|n| n.id == id)
    }

    /// Topmost node under a world-space point.
    fn hit_test(&self, x: f64, y: f64) -> Option<u32> {
        self.nodes.iter().rev().find(|n| n.contains(x, y)).map(|n| n.id)
    }

    /// Resize handle under a screen-space point (single selection only).
    fn handle_at(&self, sx: f64, sy: f64) -> Option<usize> {
        if self.selection.len() != 1 {
            return None;
        }
        let n = self.node(self.selection[0])?;
        let grab = 6.0;
        HANDLES.iter().position(|(hx, hy)| {
            let px = (n.x + hx * n.w) * self.zoom + self.pan_x;
            let py = (n.y + hy * n.h) * self.zoom + self.pan_y;
            (sx - px).abs() <= grab && (sy - py).abs() <= grab
        })
    }

    fn add_node(&mut self, kind: NodeKind, x: f64, y: f64, w: f64, h: f64) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let count = self.nodes.iter().filter(|n| n.kind == kind).count() + 1;
        let (name, fill) = match kind {
            NodeKind::Frame => (format!("Frame {count}"), "#ffffff"),
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
            fill: fill.to_string(),
            opacity: 1.0,
            corner_radius: 0.0,
            text: if kind == NodeKind::Text { "Text".to_string() } else { String::new() },
            font_size: 16.0,
        });
        id
    }

    fn retain_valid_selection(&mut self) {
        let ids: Vec<u32> = self.nodes.iter().map(|n| n.id).collect();
        self.selection.retain(|id| ids.contains(id));
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
        }
    }

    /// Immediate snapshot for one-shot edits (panel fields, delete, nudge).
    fn snapshot_now(&mut self) {
        self.undo.push(self.nodes.clone());
        self.redo.clear();
    }

    fn touch(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

fn round_rect_props(n: &mut Node) {
    n.x = n.x.round();
    n.y = n.y.round();
    n.w = n.w.round().max(1.0);
    n.h = n.h.round().max(1.0);
}

fn fill_rounded(ctx: &CanvasRenderingContext2d, x: f64, y: f64, w: f64, h: f64, r: f64) {
    let r = r.min(w / 2.0).min(h / 2.0);
    if r <= 0.0 {
        ctx.fill_rect(x, y, w, h);
        return;
    }
    ctx.begin_path();
    ctx.move_to(x + r, y);
    let _ = ctx.arc_to(x + w, y, x + w, y + h, r);
    let _ = ctx.arc_to(x + w, y + h, x, y + h, r);
    let _ = ctx.arc_to(x, y + h, x, y, r);
    let _ = ctx.arc_to(x, y, x + w, y, r);
    ctx.close_path();
    ctx.fill();
}
