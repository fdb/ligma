//! Polygon boolean operations: Greiner-Hormann clipping and mitered
//! offsetting on flattened outlines.

use crate::point_in_polygon;

/// Drops duplicate and collinear points so flattened straight edges
/// reduce back to their corners before clipping.
pub(crate) fn simplify_polygon(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
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

pub(crate) fn signed_area(p: &[(f64, f64)]) -> f64 {
    let n = p.len();
    let mut a = 0.0;
    for i in 0..n {
        let (x1, y1) = p[i];
        let (x2, y2) = p[(i + 1) % n];
        a += x1 * y2 - x2 * y1;
    }
    a / 2.0
}

pub(crate) struct GhVert {
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
pub(crate) fn gh_ring(verts: &mut Vec<GhVert>, poly: &[(f64, f64)]) -> usize {
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
pub(crate) fn polygon_clip(pa: &[(f64, f64)], pb: &[(f64, f64)], op: u8) -> Vec<Vec<(f64, f64)>> {
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
pub(crate) fn offset_polygon(poly: &[(f64, f64)], d: f64) -> Vec<(f64, f64)> {
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

