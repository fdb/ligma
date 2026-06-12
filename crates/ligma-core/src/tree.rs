//! Node-tree helpers: lookup, paths, subtree transforms, and
//! derived bounds maintenance.

use crate::geometry::bool_rings;
use crate::{Node, NodeKind};

pub(crate) fn find_node(nodes: &[Node], id: u32) -> Option<&Node> {
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

pub(crate) fn find_node_mut(nodes: &mut [Node], id: u32) -> Option<&mut Node> {
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
pub(crate) fn path_to(nodes: &[Node], id: u32) -> Option<Vec<usize>> {
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
pub(crate) fn list_at<'a>(nodes: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Vec<Node> {
    let mut list = nodes;
    for &i in &path[..path.len() - 1] {
        list = &mut list[i].children;
    }
    list
}

/// Whether `id` lives anywhere inside `ancestor`'s subtree.
pub(crate) fn is_within(root: &[Node], ancestor: u32, id: u32) -> bool {
    find_node(root, ancestor).is_some_and(|a| find_node(&a.children, id).is_some())
}

/// The direct parent of a node, if it isn't at the root.
pub(crate) fn parent_of(nodes: &[Node], id: u32) -> Option<&Node> {
    for n in nodes {
        if n.children.iter().any(|c| c.id == id) {
            return Some(n);
        }
        if let Some(p) = parent_of(&n.children, id) {
            return Some(p);
        }
    }
    None
}

pub(crate) fn shift_subtree(n: &mut Node, dx: f64, dy: f64) {
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
/// new one anchored at (nx,ny). Frame children don't scale (Figma
/// constraints): they keep their offset from the frame's top-left, only
/// shifting when that corner moves.
pub(crate) fn resize_subtree(n: &mut Node, bx: f64, by: f64, nx: f64, ny: f64, fx: f64, fy: f64) {
    let (ox, oy) = (n.x, n.y);
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
    if matches!(n.kind, NodeKind::Frame | NodeKind::Component) {
        for c in &mut n.children {
            shift_subtree(c, n.x - ox, n.y - oy);
        }
    } else {
        for c in &mut n.children {
            resize_subtree(c, bx, by, nx, ny, fx, fy);
        }
    }
}

pub(crate) fn round_subtree(n: &mut Node) {
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

pub(crate) fn assign_fresh_ids(n: &mut Node, next_id: &mut u32) {
    n.id = *next_id;
    *next_id += 1;
    for c in &mut n.children {
        assign_fresh_ids(c, next_id);
    }
}

pub(crate) fn count_kind(nodes: &[Node], kind: NodeKind) -> usize {
    nodes
        .iter()
        .map(|n| usize::from(n.kind == kind) + count_kind(&n.children, kind))
        .sum()
}

/// Recompute every group's rect as the union of its children, bottom-up.
pub(crate) fn recompute_group_bounds(nodes: &mut [Node]) {
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
        // A boolean group's box is its computed result's bounds (an
        // intersect can be much smaller than its sources' union).
        if n.kind == NodeKind::Bool {
            let pts: Vec<(f64, f64)> = bool_rings(n).into_iter().flatten().collect();
            if !pts.is_empty() {
                let min_x = pts.iter().map(|p| p.0).fold(f64::MAX, f64::min);
                let min_y = pts.iter().map(|p| p.1).fold(f64::MAX, f64::min);
                n.x = min_x;
                n.y = min_y;
                n.w = pts.iter().map(|p| p.0).fold(f64::MIN, f64::max) - min_x;
                n.h = pts.iter().map(|p| p.1).fold(f64::MIN, f64::max) - min_y;
            }
        }
    }
}

/// Remove groups that lost all their children (e.g. after deletes).
pub(crate) fn dissolve_empty_groups(nodes: &mut Vec<Node>) {
    for n in nodes.iter_mut() {
        dissolve_empty_groups(&mut n.children);
    }
    nodes.retain(|n| {
        !matches!(n.kind, NodeKind::Group | NodeKind::Bool) || !n.children.is_empty()
    });
}


