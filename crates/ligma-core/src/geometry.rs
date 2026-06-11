//! Vector geometry: bezier flattening, path bounds and hit-testing,
//! shape outline contours, and the live boolean-group result.

use crate::clip::region_clip;
use crate::{Anchor, Node, NodeKind};

/// Samples per bezier segment when flattening (bounds, hit-testing).
pub(crate) const FLATTEN_STEPS: usize = 16;

pub(crate) fn cubic_point(p0: (f64, f64), c0: (f64, f64), c1: (f64, f64), p1: (f64, f64), t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    (
        a * p0.0 + b * c0.0 + c * c1.0 + d * p1.0,
        a * p0.1 + b * c0.1 + c * c1.1 + d * p1.1,
    )
}

/// Flattens the path into a polyline (closing segment included if closed).
pub(crate) fn flatten_path(points: &[Anchor], closed: bool) -> Vec<(f64, f64)> {
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

pub(crate) fn path_bounds(points: &[Anchor], closed: bool) -> (f64, f64, f64, f64) {
    let flat = flatten_path(points, closed);
    let min_x = flat.iter().map(|p| p.0).fold(f64::MAX, f64::min);
    let min_y = flat.iter().map(|p| p.1).fold(f64::MAX, f64::min);
    let max_x = flat.iter().map(|p| p.0).fold(f64::MIN, f64::max);
    let max_y = flat.iter().map(|p| p.1).fold(f64::MIN, f64::max);
    (min_x, min_y, max_x - min_x, max_y - min_y)
}

/// Recomputes a path node's bounding box from its anchors.
pub(crate) fn sync_path_bounds(n: &mut Node) {
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

pub(crate) fn point_in_polygon(poly: &[(f64, f64)], x: f64, y: f64) -> bool {
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

pub(crate) fn dist_sq_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
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
pub(crate) fn path_hit(n: &Node, x: f64, y: f64, tol: f64) -> bool {
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


/// Bezier circle constant: handle length factor for a quarter arc.
pub(crate) const KAPPA: f64 = 0.5522847498;

pub(crate) fn corner_anchor(x: f64, y: f64) -> Anchor {
    Anchor { x, y, hx_in: x, hy_in: y, hx_out: x, hy_out: y }
}

/// A rectangle as a closed contour; corner radius becomes bezier arcs.
pub(crate) fn rect_contour(x: f64, y: f64, w: f64, h: f64, radius: f64) -> Vec<Anchor> {
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
pub(crate) fn ellipse_contour(x: f64, y: f64, w: f64, h: f64) -> Vec<Anchor> {
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
pub(crate) fn collect_contours(n: &Node, out: &mut Vec<Vec<Anchor>>) {
    match n.kind {
        NodeKind::Rect | NodeKind::Frame | NodeKind::Component | NodeKind::Instance => {
            out.push(rect_contour(n.x, n.y, n.w, n.h, n.corner_radius))
        }
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
        NodeKind::Bool => {
            // The computed boolean result, as straight-line contours —
            // this is what flatten (⌘E) bakes into a real path.
            for ring in bool_rings(n) {
                out.push(ring.into_iter().map(|(x, y)| corner_anchor(x, y)).collect());
            }
        }
        NodeKind::Text | NodeKind::Image => {}
    }
}

pub(crate) fn bool_opcode(op: &str) -> u8 {
    match op {
        "intersect" => 0,
        "subtract" => 2,
        _ => 1, // union
    }
}

/// A node's outline as an even-odd region: every contour (including a
/// path's holes, a group's members, or a nested boolean's result),
/// flattened to polygon rings.
pub(crate) fn node_region(n: &Node) -> Vec<Vec<(f64, f64)>> {
    let mut contours = Vec::new();
    collect_contours(n, &mut contours);
    contours
        .iter()
        .filter(|c| c.len() >= 2)
        .map(|c| flatten_path(c, true))
        .collect()
}

/// Folds a list of regions through one boolean op, in order: the first
/// is the subject, each later one clips into the accumulated result.
pub(crate) fn fold_regions(regions: Vec<Vec<Vec<(f64, f64)>>>, opcode: u8) -> Vec<Vec<(f64, f64)>> {
    let mut acc: Option<Vec<Vec<(f64, f64)>>> = None;
    for region in regions {
        if region.is_empty() {
            continue;
        }
        acc = Some(match acc {
            None => region,
            Some(base) => region_clip(&base, &region, opcode),
        });
    }
    acc.unwrap_or_default()
}

/// The clip result of a bool node's children, as flattened polygon rings
/// filled under the even-odd rule. The first visible child is the
/// subject; each later child clips into the accumulated result, so 3+
/// children and shapes with holes both work.
pub(crate) fn bool_rings(n: &Node) -> Vec<Vec<(f64, f64)>> {
    let opcode = bool_opcode(&n.bool_op);
    fold_regions(
        n.children.iter().filter(|c| c.visible).map(node_region).collect(),
        opcode,
    )
}

