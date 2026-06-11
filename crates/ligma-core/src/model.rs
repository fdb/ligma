//! The document model: node kinds, paints, spans, anchors, and
//! their serde defaults. All geometry is absolute world space.

use serde::{Deserialize, Serialize};

pub(crate) const EMPTY_DOC: &str = r#"{"version":2,"nodes":[],"next_id":1}"#;

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
    Component,
    Instance,
    /// Non-destructive boolean group: renders the clip of its children
    /// (per `bool_op`) while the source shapes stay editable inside.
    Bool,
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
    /// Fill override for the run; empty = the node's own fill color.
    #[serde(default)]
    pub color: String,
    /// Font size override; 0 = the node's own font size.
    #[serde(default)]
    pub size: f64,
    /// Font family override; empty = the node's own family.
    #[serde(default)]
    pub family: String,
}

/// A gradient color stop at a 0..1 position along the gradient axis.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    pub position: f64,
    pub color: String,
}

pub(crate) fn default_paint_kind() -> String {
    "solid".to_string()
}

impl Paint {
    pub(crate) fn solid(color: &str, opacity: f64) -> Paint {
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

pub(crate) fn default_true() -> bool {
    true
}
pub(crate) fn default_stroke_weight() -> f64 {
    1.0
}
pub(crate) fn default_blend_mode() -> String {
    "normal".to_string()
}
pub(crate) fn default_font_family() -> String {
    "Hanken Grotesk".to_string()
}
pub(crate) fn default_text_align() -> String {
    "left".to_string()
}
pub(crate) fn default_text_valign() -> String {
    // Existing documents rendered text vertically centered; "middle"
    // keeps them pixel-identical.
    "middle".to_string()
}

/// Line height as a multiple of font size.
pub(crate) const LINE_HEIGHT: f64 = 1.4;

/// CSS blend modes shared by canvas (globalCompositeOperation) and SVG
/// (mix-blend-mode). "normal" maps to canvas "source-over".
pub(crate) const BLEND_MODES: [&str; 16] = [
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
    /// Master component id (instance nodes only).
    #[serde(default)]
    pub component: u32,
    /// Boolean operation (bool nodes only): "union", "subtract",
    /// "intersect".
    #[serde(default)]
    pub bool_op: String,
    #[serde(default)]
    pub export_presets: Vec<ExportPreset>,
    #[serde(default)]
    pub children: Vec<Node>,
}

impl Node {
    pub(crate) fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }

    pub(crate) fn intersects(&self, x: f64, y: f64, w: f64, h: f64) -> bool {
        self.x < x + w && self.x + self.w > x && self.y < y + h && self.y + self.h > y
    }
}

