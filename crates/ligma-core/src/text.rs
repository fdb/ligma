//! Rich-text span helpers: per-character style maps, run-length
//! span rebuilding, line segmentation, and canvas font specs.

use crate::{Node, Span};

/// The full style of one character, resolved from the node's spans.
/// `size == 0.0` / empty `family` mean "inherit from the node".
#[derive(Clone, PartialEq, Default)]
pub(crate) struct CharStyle {
    pub bold: bool,
    pub italic: bool,
    pub color: String,
    pub size: f64,
    pub family: String,
}

impl CharStyle {
    pub(crate) fn is_plain(&self) -> bool {
        !self.bold
            && !self.italic
            && self.color.is_empty()
            && self.size == 0.0
            && self.family.is_empty()
    }

    /// The actual font size for this run inside `n`.
    pub(crate) fn size_in(&self, n: &Node) -> f64 {
        if self.size > 0.0 { self.size } else { n.font_size }
    }

    /// The actual font family for this run inside `n`.
    pub(crate) fn family_in<'a>(&'a self, n: &'a Node) -> &'a str {
        if self.family.is_empty() { &n.font_family } else { &self.family }
    }
}

/// Re-encodes a per-char style map as minimal spans.
pub(crate) fn run_length_spans(styles: &[CharStyle]) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < styles.len() {
        let st = styles[i].clone();
        let start = i;
        while i < styles.len() && styles[i] == st {
            i += 1;
        }
        if !st.is_plain() {
            spans.push(Span {
                start,
                len: i - start,
                bold: st.bold,
                italic: st.italic,
                color: st.color,
                size: st.size,
                family: st.family,
            });
        }
    }
    spans
}

/// The per-char style map for a text node (resolved from its spans).
pub(crate) fn char_styles(n: &Node) -> Vec<CharStyle> {
    let chars = n.text.chars().count();
    let mut styles = vec![CharStyle::default(); chars];
    for s in &n.spans {
        for c in styles.iter_mut().skip(s.start).take(s.len) {
            c.bold |= s.bold;
            c.italic |= s.italic;
            if !s.color.is_empty() {
                c.color = s.color.clone();
            }
            if s.size > 0.0 {
                c.size = s.size;
            }
            if !s.family.is_empty() {
                c.family = s.family.clone();
            }
        }
    }
    styles
}

/// Splits one wrapped line (starting at char `off` in the node's text)
/// into maximal same-style segments.
pub(crate) fn line_segments(styles: &[CharStyle], line: &str, off: usize) -> Vec<(String, CharStyle)> {
    let mut segs: Vec<(String, CharStyle)> = Vec::new();
    for (i, ch) in line.chars().enumerate() {
        let st = styles.get(off + i).cloned().unwrap_or_default();
        match segs.last_mut() {
            Some(s) if s.1 == st => s.0.push(ch),
            _ => segs.push((ch.to_string(), st)),
        }
    }
    segs
}

/// The tallest font size on a wrapped line (the node's own size when the
/// line is empty or unstyled) — drives that line's slot height and the
/// shared baseline.
pub(crate) fn line_max_size(n: &Node, styles: &[CharStyle], line: &str, off: usize) -> f64 {
    let mut max = n.font_size;
    for i in 0..line.chars().count() {
        if let Some(st) = styles.get(off + i) {
            max = max.max(st.size_in(n));
        }
    }
    max
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
