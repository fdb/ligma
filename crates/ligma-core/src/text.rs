//! Rich-text span helpers: per-character style maps, run-length
//! span rebuilding, line segmentation, and canvas font specs.

use crate::{Node, Span};

/// Re-encodes a per-char (bold, italic, color) map as minimal spans.
pub(crate) fn run_length_spans(styles: &[(bool, bool, String)]) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < styles.len() {
        let (b, it, col) = styles[i].clone();
        let start = i;
        while i < styles.len() && styles[i] == (b, it, col.clone()) {
            i += 1;
        }
        if b || it || !col.is_empty() {
            spans.push(Span { start, len: i - start, bold: b, italic: it, color: col });
        }
    }
    spans
}

/// The per-char style map for a text node (resolved from its spans).
pub(crate) fn char_styles(n: &Node) -> Vec<(bool, bool, String)> {
    let chars = n.text.chars().count();
    let mut styles = vec![(false, false, String::new()); chars];
    for s in &n.spans {
        for c in styles.iter_mut().skip(s.start).take(s.len) {
            c.0 |= s.bold;
            c.1 |= s.italic;
            if !s.color.is_empty() {
                c.2 = s.color.clone();
            }
        }
    }
    styles
}

/// Splits one wrapped line (starting at char `off` in the node's text)
/// into maximal same-style segments.
pub(crate) fn line_segments(
    styles: &[(bool, bool, String)],
    line: &str,
    off: usize,
) -> Vec<(String, bool, bool, String)> {
    let mut segs: Vec<(String, bool, bool, String)> = Vec::new();
    for (i, ch) in line.chars().enumerate() {
        let (b, it, col) =
            styles.get(off + i).cloned().unwrap_or((false, false, String::new()));
        match segs.last_mut() {
            Some(s) if s.1 == b && s.2 == it && s.3 == col => s.0.push(ch),
            _ => segs.push((ch.to_string(), b, it, col)),
        }
    }
    segs
}

pub(crate) fn font_spec(size: f64, family: &str, bold: bool, italic: bool) -> String {
    format!(
        "{}{}{}px '{}', sans-serif",
        if italic { "italic " } else { "" },
        if bold { "700 " } else { "" },
        size,
        family
    )
}

