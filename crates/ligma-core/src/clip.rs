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

/// Even-odd containment over a whole ring set.
pub(crate) fn point_in_region(region: &[Vec<(f64, f64)>], x: f64, y: f64) -> bool {
    let mut inside = false;
    for ring in region {
        if point_in_polygon(ring, x, y) {
            inside = !inside;
        }
    }
    inside
}

/// Boolean of two even-odd regions, each a set of rings (outer shells and
/// holes alike — parity decides what's solid). Greiner-Hormann on every
/// ring pair; rings that never cross the other region are kept or dropped
/// whole by containment. Output renders under the even-odd rule.
/// op: 0 = intersect, 1 = union, 2 = a minus b.
pub(crate) fn region_clip(
    ra: &[Vec<(f64, f64)>],
    rb: &[Vec<(f64, f64)>],
    op: u8,
) -> Vec<Vec<(f64, f64)>> {
    // Snap every exit to a 1e-3 grid: the tie-breaking nudge below is 5×
    // finer than half a cell, so clean coordinates round back exactly,
    // and 0.001px is far below anything visible.
    region_clip_raw(ra, rb, op)
        .into_iter()
        .map(|ring| {
            let snapped: Vec<(f64, f64)> = ring
                .into_iter()
                .map(|(x, y)| ((x * 1e3).round() / 1e3, (y * 1e3).round() / 1e3))
                .collect();
            simplify_polygon(&snapped)
        })
        .filter(|r| r.len() >= 3)
        .collect()
}

fn region_clip_raw(
    ra: &[Vec<(f64, f64)>],
    rb: &[Vec<(f64, f64)>],
    op: u8,
) -> Vec<Vec<(f64, f64)>> {
    let clean = |r: &[Vec<(f64, f64)>]| -> Vec<Vec<(f64, f64)>> {
        r.iter()
            .map(|p| {
                let mut s = simplify_polygon(p);
                if signed_area(&s) < 0.0 {
                    s.reverse();
                }
                s
            })
            .filter(|s| s.len() >= 3)
            .collect()
    };
    let a = clean(ra);
    let mut b = clean(rb);
    if a.is_empty() {
        return if op == 1 { b } else { Vec::new() };
    }
    if b.is_empty() {
        return if op == 0 { Vec::new() } else { a };
    }
    // Coincident collinear edges (rampant after edge snapping) yield no
    // detectable crossings and break the trace. Translating all of B
    // rigidly by a sub-visual offset breaks the ties without slanting
    // any edge (a slant would split crossings unevenly around corners
    // and ruin the even-crossing parity Greiner-Hormann needs); the
    // 1e-3 output snap above erases the offset again.
    for ring in &mut b {
        for p in ring.iter_mut() {
            p.0 += 1.7e-4;
            p.1 += 2.3e-4;
        }
    }

    let mut verts: Vec<GhVert> = Vec::new();
    let heads_a: Vec<usize> = a.iter().map(|r| gh_ring(&mut verts, r)).collect();
    let heads_b: Vec<usize> = b.iter().map(|r| gh_ring(&mut verts, r)).collect();

    // Edge intersections between every ring of A and every ring of B,
    // grouped per original edge with the parametric position so the
    // splice below inserts them in order along each edge.
    let mut by_edge_a: Vec<Vec<Vec<(f64, usize)>>> =
        a.iter().map(|r| vec![Vec::new(); r.len()]).collect();
    let mut by_edge_b: Vec<Vec<Vec<(f64, usize)>>> =
        b.iter().map(|r| vec![Vec::new(); r.len()]).collect();
    let mut crossings_a = vec![0usize; a.len()];
    let mut crossings_b = vec![0usize; b.len()];
    for (ri, ring_a) in a.iter().enumerate() {
        let na = ring_a.len();
        for i in 0..na {
            let (a1, a2) = (ring_a[i], ring_a[(i + 1) % na]);
            for (rj, ring_b) in b.iter().enumerate() {
                let nb = ring_b.len();
                for j in 0..nb {
                    let (b1, b2) = (ring_b[j], ring_b[(j + 1) % nb]);
                    let d = (a2.0 - a1.0) * (b2.1 - b1.1) - (a2.1 - a1.1) * (b2.0 - b1.0);
                    if d.abs() < 1e-12 {
                        continue;
                    }
                    let t = ((b1.0 - a1.0) * (b2.1 - b1.1) - (b1.1 - a1.1) * (b2.0 - b1.0)) / d;
                    let u = ((b1.0 - a1.0) * (a2.1 - a1.1) - (b1.1 - a1.1) * (a2.0 - a1.0)) / d;
                    let eps = 1e-9;
                    if t > eps && t < 1.0 - eps && u > eps && u < 1.0 - eps {
                        let (x, y) = (a1.0 + t * (a2.0 - a1.0), a1.1 + t * (a2.1 - a1.1));
                        let ia = verts.len();
                        verts.push(GhVert {
                            x,
                            y,
                            next: 0,
                            prev: 0,
                            neighbor: ia + 1,
                            intersect: true,
                            entry: false,
                            visited: false,
                        });
                        let ib = verts.len();
                        verts.push(GhVert {
                            x,
                            y,
                            next: 0,
                            prev: 0,
                            neighbor: ia,
                            intersect: true,
                            entry: false,
                            visited: false,
                        });
                        by_edge_a[ri][i].push((t, ia));
                        by_edge_b[rj][j].push((u, ib));
                        crossings_a[ri] += 1;
                        crossings_b[rj] += 1;
                    }
                }
            }
        }
    }

    // Rings that never cross the other region survive or vanish whole.
    // (For subtract, a B ring inside A becomes a hole boundary — parity
    // handles holes-of-holes the same way.)
    let mut result: Vec<Vec<(f64, f64)>> = Vec::new();
    for (ri, ring) in a.iter().enumerate() {
        if crossings_a[ri] == 0 {
            let inside_b = point_in_region(&b, ring[0].0, ring[0].1);
            if match op {
                0 => inside_b,
                _ => !inside_b,
            } {
                result.push(ring.clone());
            }
        }
    }
    for (rj, ring) in b.iter().enumerate() {
        if crossings_b[rj] == 0 {
            let inside_a = point_in_region(&a, ring[0].0, ring[0].1);
            if match op {
                1 => !inside_a,
                _ => inside_a,
            } {
                result.push(ring.clone());
            }
        }
    }
    if verts.iter().all(|v| !v.intersect) {
        return result;
    }

    // Insert intersection vertices into their rings, ordered along edges.
    let mut splice = |head: usize, by_edge: &mut Vec<Vec<(f64, usize)>>| {
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
        }
    };
    for (ri, head) in heads_a.iter().enumerate() {
        splice(*head, &mut by_edge_a[ri]);
    }
    for (rj, head) in heads_b.iter().enumerate() {
        splice(*head, &mut by_edge_b[rj]);
    }

    // Entry/exit flags: walk each ring, toggling containment in the other
    // REGION (parity over all of its rings — each crossing flips it).
    // Flipping a side's flags complements that operand: intersect flips
    // neither, union flips both, A−B flips A only.
    let (flip_a, flip_b) = (op != 0, op == 1);
    let mark = |head: usize, other: &[Vec<(f64, f64)>], flip: bool, verts: &mut Vec<GhVert>| {
        // Heads are original vertices, never intersections.
        let mut inside = point_in_region(other, verts[head].x, verts[head].y);
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
    };
    for head in &heads_a {
        mark(*head, &b, flip_a, &mut verts);
    }
    for head in &heads_b {
        mark(*head, &a, flip_b, &mut verts);
    }

    // Trace result contours.
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

