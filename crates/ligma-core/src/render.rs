//! Canvas drawing, shared by the editor render loop and PNG export.

use crate::text::{char_styles, font_spec, line_segments};
use crate::tree::find_node;
use crate::geometry::*;
use crate::*;
use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::JsCast;
use web_sys::CanvasRenderingContext2d;

pub(crate) fn draw_node(
    ctx: &CanvasRenderingContext2d,
    n: &Node,
    parent_alpha: f64,
    zoom: f64,
    layouts: &RefCell<HashMap<u32, Vec<String>>>,
    root: &[Node],
    depth: u32,
    skip_text: Option<u32>,
) {
    if !n.visible {
        return;
    }
    // A text node under inline editing renders in the DOM overlay
    // instead — drawing it too would show old and new text on top of
    // each other while typing.
    if skip_text == Some(n.id) && n.kind == NodeKind::Text {
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
                draw_node(ctx, c, alpha, zoom, layouts, root, depth, skip_text);
            }
        }
        NodeKind::Instance => {
            // Draw the master mapped onto the instance box. The depth cap
            // breaks reference cycles (an instance dragged into its own
            // master) instead of recursing forever.
            let master = find_node(root, n.component)
                .filter(|m| m.kind == NodeKind::Component && depth < 8);
            match master {
                Some(m) => {
                    ctx.save();
                    let fx = if m.w > 0.0 { n.w / m.w } else { 1.0 };
                    let fy = if m.h > 0.0 { n.h / m.h } else { 1.0 };
                    let _ = ctx.translate(n.x - m.x * fx, n.y - m.y * fy);
                    let _ = ctx.scale(fx, fy);
                    // Instances keep drawing the master's committed text
                    // even while the master is being edited elsewhere.
                    draw_node(ctx, m, alpha, zoom, layouts, root, depth + 1, None);
                    ctx.restore();
                }
                None => {
                    ctx.set_global_alpha(alpha);
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
        }
        NodeKind::Component | NodeKind::Frame => {
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
                draw_node(ctx, c, alpha, zoom, layouts, root, depth, skip_text);
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
                    .map(|(s, b, it, _)| {
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
                for ((seg, b, it, col), w) in segs.iter().zip(&widths) {
                    ctx.set_font(&font_spec(n.font_size, &n.font_family, *b, *it));
                    for p in &n.fills {
                        ctx.set_global_alpha(alpha * p.opacity);
                        ctx.set_fill_style_str(if col.is_empty() { &p.color } else { col });
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
        NodeKind::Bool => {
            // The live clip of the children; the sources themselves are
            // never drawn, only their combined outline.
            let rings = bool_rings(n);
            if !rings.is_empty() {
                let trace = |ctx: &CanvasRenderingContext2d| {
                    ctx.begin_path();
                    for ring in &rings {
                        if let Some(&(fx, fy)) = ring.first() {
                            ctx.move_to(fx, fy);
                            for &(px, py) in &ring[1..] {
                                ctx.line_to(px, py);
                            }
                            ctx.close_path();
                        }
                    }
                };
                for p in &n.fills {
                    ctx.set_global_alpha(alpha * p.opacity);
                    apply_fill(ctx, p, n.x, n.y, n.w, n.h);
                    trace(ctx);
                    ctx.fill_with_canvas_winding_rule(web_sys::CanvasWindingRule::Evenodd);
                }
                stroke_paints(ctx, n, alpha, trace);
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
pub(crate) fn wrap_text(ctx: &CanvasRenderingContext2d, text: &str, max_w: f64) -> Vec<String> {
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
pub(crate) fn apply_fill(ctx: &CanvasRenderingContext2d, p: &Paint, x: f64, y: f64, w: f64, h: f64) {
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

pub(crate) fn stroke_paints(
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
pub(crate) fn trace_path(ctx: &CanvasRenderingContext2d, points: &[Anchor], closed: bool) {
    ctx.begin_path();
    trace_contour(ctx, points, closed);
}

/// Traces every contour of a path node into one canvas path, so an
/// even-odd fill turns contour overlaps into holes.
pub(crate) fn trace_path_all(ctx: &CanvasRenderingContext2d, n: &Node) {
    ctx.begin_path();
    trace_contour(ctx, &n.points, n.closed);
    for c in &n.inner {
        trace_contour(ctx, c, true);
    }
}

pub(crate) fn trace_contour(ctx: &CanvasRenderingContext2d, points: &[Anchor], closed: bool) {
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

pub(crate) fn ellipse_path(ctx: &CanvasRenderingContext2d, n: &Node) {
    ctx.begin_path();
    let _ = ctx.ellipse(n.x + n.w / 2.0, n.y + n.h / 2.0, n.w / 2.0, n.h / 2.0, 0.0, 0.0, TAU);
}

pub(crate) fn rounded_rect_path(ctx: &CanvasRenderingContext2d, x: f64, y: f64, w: f64, h: f64, r: f64) {
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

pub(crate) fn fill_rounded(ctx: &CanvasRenderingContext2d, x: f64, y: f64, w: f64, h: f64, r: f64) {
    rounded_rect_path(ctx, x, y, w, h, r);
    ctx.fill();
}

