//! SVG serialization of node subtrees (export and clipboard).

use crate::geometry::*;
use crate::text::*;
use crate::tree::*;
use crate::*;
use std::collections::HashMap;

pub(crate) fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Emits a paint server for gradient paints (returns the fill value).
/// Solid paints just return their escaped color.
pub(crate) fn svg_fill(p: &Paint, uid: &str, out: &mut String, x: f64, y: f64, w: f64, h: f64) -> String {
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

pub(crate) fn path_d(points: &[Anchor], closed: bool, ox: f64, oy: f64) -> String {
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

pub(crate) fn svg_node(
    n: &Node,
    ox: f64,
    oy: f64,
    out: &mut String,
    layouts: &HashMap<u32, Vec<String>>,
    root: &[Node],
    depth: u32,
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
                svg_node(c, ox, oy, out, layouts, root, depth);
            }
        }
        NodeKind::Instance => {
            if let Some(m) = find_node(root, n.component)
                .filter(|m| m.kind == NodeKind::Component && depth < 8)
            {
                let fx = if m.w > 0.0 { n.w / m.w } else { 1.0 };
                let fy = if m.h > 0.0 { n.h / m.h } else { 1.0 };
                out.push_str(&format!(
                    r#"<g transform="translate({} {}) scale({fx} {fy})">"#,
                    x - m.x * fx,
                    y - m.y * fy
                ));
                svg_node(m, 0.0, 0.0, out, layouts, root, depth + 1);
                out.push_str("</g>");
            }
        }
        NodeKind::Component | NodeKind::Frame | NodeKind::Rect => {
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
            if matches!(n.kind, NodeKind::Frame | NodeKind::Component) && !n.children.is_empty() {
                out.push_str(&format!(
                    r#"<clipPath id="clip{id}"><rect x="{x}" y="{y}" width="{}" height="{}"{rx_attr}/></clipPath><g clip-path="url(#clip{id})">"#,
                    n.w, n.h, id = n.id
                ));
                for c in &n.children {
                    svg_node(c, ox, oy, out, layouts, root, depth);
                }
                out.push_str("</g>");
            } else {
                for c in &n.children {
                    svg_node(c, ox, oy, out, layouts, root, depth);
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
            let styles = char_styles(n);
            // Per-line slot heights mirror the canvas: 1.4× the tallest
            // run, runs sharing a ~0.8em baseline.
            let line_offs: Vec<usize> = {
                let mut offs = Vec::with_capacity(lines.len());
                let mut off = 0;
                for line in lines {
                    offs.push(off);
                    off += line.chars().count() + 1;
                }
                offs
            };
            let heights: Vec<f64> = lines
                .iter()
                .zip(&line_offs)
                .map(|(line, &off)| line_max_size(n, &styles, line, off) * LINE_HEIGHT)
                .collect();
            let block: f64 = heights.iter().sum();
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
            for p in &n.fills {
                let mut y_cur = y0;
                for ((line, &off), &lh) in lines.iter().zip(&line_offs).zip(&heights) {
                    let max_size = lh / LINE_HEIGHT;
                    let ty = y_cur + (lh - max_size) / 2.0 + max_size * 0.8;
                    let mut body = String::new();
                    for (seg, st) in line_segments(&styles, line, off) {
                        if st.is_plain() {
                            body.push_str(&xml_escape(&seg));
                        } else {
                            let mut attrs = String::new();
                            if st.bold {
                                attrs.push_str(r#" font-weight="700""#);
                            }
                            if st.italic {
                                attrs.push_str(r#" font-style="italic""#);
                            }
                            if !st.color.is_empty() {
                                attrs.push_str(&format!(r#" fill="{}""#, xml_escape(&st.color)));
                            }
                            if st.size > 0.0 {
                                attrs.push_str(&format!(r#" font-size="{}""#, st.size));
                            }
                            if !st.family.is_empty() {
                                attrs.push_str(&format!(
                                    r#" font-family="{}, sans-serif""#,
                                    xml_escape(&st.family)
                                ));
                            }
                            body.push_str(&format!(
                                r#"<tspan{attrs}>{}</tspan>"#,
                                xml_escape(&seg)
                            ));
                        }
                    }
                    out.push_str(&format!(
                        r#"<text x="{tx}" y="{ty}" text-anchor="{anchor}" font-family="{}, sans-serif" font-size="{}" fill="{}" fill-opacity="{}">{}</text>"#,
                        xml_escape(&n.font_family), n.font_size, xml_escape(&p.color), p.opacity, body
                    ));
                    y_cur += lh;
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
        NodeKind::Bool => {
            let mut d = String::new();
            for ring in bool_rings(n) {
                let Some(&(fx, fy)) = ring.first() else { continue };
                d.push_str(&format!("M {} {} ", fx - ox, fy - oy));
                for &(px, py) in &ring[1..] {
                    d.push_str(&format!("L {} {} ", px - ox, py - oy));
                }
                d.push_str("Z ");
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
