import { useLayoutEffect, useRef, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import { ensureFont, FONT_FAMILIES } from "../lib/fonts";
import type { SceneNode } from "../types";

/** One character's style; zeros/empties inherit from the node. */
interface SpanStyle {
  bold: boolean;
  italic: boolean;
  color: string;
  size: number;
  family: string;
}
const PLAIN: SpanStyle = { bold: false, italic: false, color: "", size: 0, family: "" };
const same = (a: SpanStyle, b: SpanStyle) =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.color === b.color &&
  a.size === b.size &&
  a.family === b.family;

const SPAN_COLORS = ["#18181b", "#ef4444", "#f59e0b", "#22c55e", "#0ea5e9", ""];

interface Props {
  engine: Engine;
  node: SceneNode;
  zoom: number;
  left: number;
  top: number;
  width: number;
  minHeight: number;
  lineHeight: number; // node base line height, screen px
  onClose: () => void;
}

/** Styled inline text editor: a contenteditable whose DOM is rebuilt
 * from local (text, per-char styles) state, so bold/italic/color/size/
 * family show live while typing. Everything commits to the engine as
 * one set_text_styled call when the editor closes. */
export function TextEditorOverlay({
  engine,
  node,
  zoom,
  left,
  top,
  width,
  minHeight,
  lineHeight,
  onClose,
}: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  // Selection (char offsets) to restore after the next DOM rebuild.
  const pendingSel = useRef<[number, number] | null>(null);
  const closed = useRef(false);

  const [text, setText] = useState(node.text);
  const [styles, setStyles] = useState<SpanStyle[]>(() => {
    const arr: SpanStyle[] = Array.from({ length: node.text.length }, () => ({ ...PLAIN }));
    for (const s of node.spans) {
      for (let i = s.start; i < s.start + s.len && i < arr.length; i++) {
        arr[i] = {
          bold: arr[i].bold || s.bold,
          italic: arr[i].italic || s.italic,
          color: s.color || arr[i].color,
          size: s.size || arr[i].size,
          family: s.family || arr[i].family,
        };
      }
    }
    return arr;
  });

  /** The editor's plain text (literal \n; the display-only trailing <br>
   * contributes nothing). */
  const serialize = (): string => {
    let out = "";
    const walk = (el: Node) => {
      el.childNodes.forEach((c) => {
        if (c.nodeType === Node.TEXT_NODE) out += c.nodeValue ?? "";
        else if ((c as HTMLElement).tagName === "BR") {
          if (!(c as HTMLElement).dataset.trailer) out += "\n";
        } else if (!(c as HTMLElement).dataset?.anchor) walk(c);
      });
    };
    if (editorRef.current) walk(editorRef.current);
    return out;
  };

  /** Char length a node contributes to the serialized text (a non-
   * trailer <br> counts as the newline it stands for). */
  const nodeTextLen = (node: Node): number => {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.parentNode as HTMLElement | null)?.dataset?.anchor) return 0;
      return node.nodeValue?.length ?? 0;
    }
    const el = node as HTMLElement;
    if (el.tagName === "BR") return el.dataset.trailer ? 0 : 1;
    if (el.dataset?.anchor) return 0;
    let len = 0;
    node.childNodes.forEach((c) => (len += nodeTextLen(c)));
    return len;
  };

  /** Current selection as char offsets into the serialized text. Walks
   * whatever DOM the browser left behind, so <br>s count as one char. */
  const selOffsets = (): [number, number] => {
    const sel = window.getSelection();
    const root = editorRef.current;
    if (!sel || !root || sel.rangeCount === 0) return [0, 0];
    const range = sel.getRangeAt(0);
    const offsetOf = (target: Node, off: number): number => {
      let acc = 0;
      let done = false;
      const walk = (el: Node) => {
        if (done) return;
        if (el === target && el.nodeType !== Node.TEXT_NODE) {
          // Element-anchored: count the first `off` children.
          let i = 0;
          el.childNodes.forEach((c) => {
            if (i < off) acc += nodeTextLen(c);
            i++;
          });
          done = true;
          return;
        }
        if (el.nodeType === Node.TEXT_NODE) {
          const zwsp = !!(el.parentNode as HTMLElement | null)?.dataset?.anchor;
          if (el === target) {
            acc += zwsp ? 0 : off;
            done = true;
          } else if (!zwsp) {
            acc += el.nodeValue?.length ?? 0;
          }
          return;
        }
        if ((el as HTMLElement).tagName === "BR") {
          acc += nodeTextLen(el);
          return;
        }
        el.childNodes.forEach(walk);
      };
      walk(root);
      return acc;
    };
    const a = offsetOf(range.startContainer, range.startOffset);
    const b = offsetOf(range.endContainer, range.endOffset);
    return a <= b ? [a, b] : [b, a];
  };

  // The window selection collapses into the toolbar's input/select the
  // moment one takes focus, so remember the editor's last selection.
  const lastSel = useRef<[number, number]>([0, 0]);
  /** Synchronously snapshot the editor's selection — called from the
   * toolbar controls' pointerdown, before focus moves into them
   * (selectionchange is async and coalesced, so it can lag). */
  const captureSel = () => {
    const sel = window.getSelection();
    if (sel?.anchorNode && editorRef.current?.contains(sel.anchorNode)) {
      lastSel.current = selOffsets();
    }
  };

  const currentSel = (): [number, number] => {
    const sel = window.getSelection();
    if (sel?.anchorNode && editorRef.current?.contains(sel.anchorNode)) {
      return selOffsets();
    }
    return lastSel.current;
  };

  const placeSelection = (a: number, b: number) => {
    const root = editorRef.current;
    if (!root) return;
    const locate = (idx: number): [Node, number] => {
      let acc = 0;
      let result: [Node, number] | null = null;
      let anchorPos: [Node, number] | null = null;
      const walk = (el: Node) => {
        if (result) return;
        if ((el as HTMLElement).dataset?.anchor) {
          // The zero-width-space hosting the empty last line: a real
          // text position Chrome won't normalize away.
          if (el.firstChild) anchorPos = [el.firstChild, 0];
          return;
        }
        if (el.nodeType === Node.TEXT_NODE) {
          const len = el.nodeValue?.length ?? 0;
          // Strict: a position at a node's end resolves into the NEXT
          // node (downstream affinity) — so a caret at a line start
          // lands after the <br>, where typing continues that line.
          if (acc + len > idx) result = [el, idx - acc];
          acc += len;
          return;
        }
        if ((el as HTMLElement).tagName === "BR") {
          if (!(el as HTMLElement).dataset.trailer) {
            // idx == acc: the caret sits at the end of the line, right
            // before this break.
            if (acc + 1 > idx) {
              const parent = el.parentNode!;
              result = [parent, Array.prototype.indexOf.call(parent.childNodes, el)];
            }
            acc += 1;
          }
          return;
        }
        el.childNodes.forEach(walk);
      };
      walk(root);
      // Past every text node: the empty last line's anchor when there is
      // one, else the slot before the display-only trailer <br>.
      return result ?? anchorPos ?? [root, Math.max(0, root.childNodes.length - 1)];
    };
    const range = document.createRange();
    const [an, ao] = locate(a);
    const [bn, bo] = locate(b);
    range.setStart(an, ao);
    range.setEnd(bn, bo);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  // Rebuild the editor DOM from (text, styles): one styled <span> per
  // same-style run, then a display-only trailing <br> so an empty last
  // line stays clickable. Restores any selection saved before setState.
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
      const st = styles[i] ?? PLAIN;
      let j = i + 1;
      while (j < text.length && same(styles[j] ?? PLAIN, st)) j++;
      const span = document.createElement("span");
      const size = (st.size || node.fontSize) * zoom;
      span.style.fontWeight = st.bold ? "700" : "400";
      span.style.fontStyle = st.italic ? "italic" : "normal";
      span.style.color = st.color || "";
      span.style.fontSize = `${size}px`;
      span.style.lineHeight = `${size * 1.4}px`;
      span.style.fontFamily = st.family ? `'${st.family}', sans-serif` : "";
      // Line breaks become real <br>s: Chrome can't keep a caret between
      // a literal \n and the end of a text node, so typing at the start
      // of a new line would land before the break.
      const pieces = text.slice(i, j).split("\n");
      pieces.forEach((piece, pi) => {
        if (piece) span.appendChild(document.createTextNode(piece));
        if (pi < pieces.length - 1) span.appendChild(document.createElement("br"));
      });
      frag.appendChild(span);
      i = j;
    }
    if (text.endsWith("\n") || text.length === 0) {
      const anchor = document.createElement("span");
      anchor.dataset.anchor = "1";
      anchor.appendChild(document.createTextNode("\u200B"));
      frag.appendChild(anchor);
    }
    const trailer = document.createElement("br");
    trailer.dataset.trailer = "1";
    frag.appendChild(trailer);
    root.replaceChildren(frag);
    if (pendingSel.current) {
      placeSelection(...pendingSel.current);
      pendingSel.current = null;
    }
  }, [text, styles, node.fontSize, zoom]);

  // Focus + select-all on mount (matching the old textarea).
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    placeSelection(0, text.length);
    lastSel.current = [0, text.length];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the editor's selection so toolbar actions can use it after
  // their own controls take focus.
  useLayoutEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (sel?.anchorNode && editorRef.current?.contains(sel.anchorNode)) {
        lastSel.current = selOffsets();
      }
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Replaces the current selection with plain text through state. The
   * editor is fully controlled: the browser never mutates the DOM for
   * common edits (Chrome won't keep a caret on an empty last line and
   * rewrites spans unpredictably), we splice state and rebuild. */
  const insertPlain = (str: string) => {
    const [a, b] = currentSel();
    const inherit = styles[a - 1] ?? styles[a] ?? PLAIN;
    pendingSel.current = [a + str.length, a + str.length];
    setStyles((prev) => [
      ...prev.slice(0, a),
      ...Array.from({ length: str.length }, () => ({ ...inherit })),
      ...prev.slice(b),
    ]);
    setText((prev) => prev.slice(0, a) + str + prev.slice(b));
  };

  const deleteRange = (a: number, b: number) => {
    if (a >= b) return;
    pendingSel.current = [a, a];
    setStyles((prev) => [...prev.slice(0, a), ...prev.slice(b)]);
    setText((prev) => prev.slice(0, a) + prev.slice(b));
  };

  // React's synthetic onBeforeInput doesn't reliably carry inputType, so
  // the interception listens natively, calling the latest closures.
  const handlers = useRef({ insertPlain, deleteRange, currentSel, textLen: text.length });
  handlers.current = { insertPlain, deleteRange, currentSel, textLen: text.length };
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const onBeforeInput = (ev: InputEvent) => {
      if (composing.current) return; // IME edits commit via the diff path
      const h = handlers.current;
      switch (ev.inputType) {
        case "insertText":
          ev.preventDefault();
          h.insertPlain(ev.data ?? "");
          break;
        case "insertParagraph":
        case "insertLineBreak":
          ev.preventDefault();
          h.insertPlain("\n");
          break;
        case "deleteContentBackward": {
          ev.preventDefault();
          const [a, b] = h.currentSel();
          if (a !== b) h.deleteRange(a, b);
          else if (a > 0) h.deleteRange(a - 1, a);
          break;
        }
        case "deleteContentForward": {
          ev.preventDefault();
          const [a, b] = h.currentSel();
          if (a !== b) h.deleteRange(a, b);
          else if (a < h.textLen) h.deleteRange(a, a + 1);
          break;
        }
        default:
          break; // uncommon edits fall through to the onInput diff
      }
    };
    root.addEventListener("beforeinput", onBeforeInput);
    return () => root.removeEventListener("beforeinput", onBeforeInput);
  }, []);

  const onInput = () => {
    if (composing.current) return;
    const next = serialize();
    // Single-edit diff: common prefix/suffix locate the splice.
    let p = 0;
    while (p < text.length && p < next.length && text[p] === next[p]) p++;
    let s = 0;
    while (
      s < text.length - p &&
      s < next.length - p &&
      text[text.length - 1 - s] === next[next.length - 1 - s]
    )
      s++;
    const inserted = next.length - p - s;
    const inherit = styles[p - 1] ?? styles[p + (text.length - next.length)] ?? PLAIN;
    const nextStyles = [
      ...styles.slice(0, p),
      ...Array.from({ length: inserted }, () => ({ ...inherit })),
      ...styles.slice(text.length - s),
    ];
    pendingSel.current = selOffsets();
    setText(next);
    setStyles(nextStyles);
  };

  const applyToSelection = (patch: (st: SpanStyle) => SpanStyle) => {
    const [a, b] = currentSel();
    if (a === b) return;
    pendingSel.current = [a, b];
    setStyles((prev) => prev.map((st, i) => (i >= a && i < b ? patch(st) : st)));
  };

  const toggle = (field: "bold" | "italic") => {
    const [a, b] = currentSel();
    if (a === b) return;
    const allOn = styles.slice(a, b).every((st) => st[field]);
    applyToSelection((st) => ({ ...st, [field]: !allOn }));
  };

  const commit = () => {
    if (closed.current) return;
    closed.current = true;
    const spans: SceneNode["spans"] = [];
    let i = 0;
    while (i < styles.length) {
      const st = styles[i];
      let j = i + 1;
      while (j < styles.length && same(styles[j], st)) j++;
      if (!same(st, PLAIN)) {
        spans.push({ start: i, len: j - i, ...st });
      }
      i = j;
    }
    engine.set_text_styled(node.id, text, JSON.stringify(spans));
    onClose();
  };

  return (
    <>
      <div
        data-testid="text-toolbar"
        className="absolute z-10 flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-1.5 py-1 shadow-md"
        style={{ left, top: top - 38 }}
        onPointerDown={(e) => {
          // Buttons act on the editor's selection; never steal focus.
          if ((e.target as HTMLElement).tagName !== "INPUT" && (e.target as HTMLElement).tagName !== "SELECT")
            e.preventDefault();
        }}
      >
        {(["bold", "italic"] as const).map((f) => (
          <button
            key={f}
            title={f === "bold" ? "Bold (⌘B)" : "Italic (⌘I)"}
            onClick={() => toggle(f)}
            className="flex size-6 items-center justify-center rounded text-[12px] text-zinc-600 hover:bg-zinc-100"
          >
            <span className={f === "bold" ? "font-bold" : "italic"}>
              {f === "bold" ? "B" : "I"}
            </span>
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-zinc-200" />
        {SPAN_COLORS.map((c) => (
          <button
            key={c || "clear"}
            data-testid={`span-color-${c.replace("#", "") || "clear"}`}
            title={c ? `Color ${c}` : "Clear color"}
            onClick={() => applyToSelection((st) => ({ ...st, color: c }))}
            className="flex size-6 items-center justify-center rounded hover:bg-zinc-100"
          >
            <span
              className={`block size-3.5 rounded-full ${c ? "" : "border border-zinc-300 bg-white"}`}
              style={c ? { background: c } : undefined}
            />
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-zinc-200" />
        <input
          data-testid="span-size"
          type="number"
          min={1}
          max={400}
          placeholder={String(node.fontSize)}
          title="Font size for the selection (empty resets)"
          onPointerDown={captureSel}
          onFocus={captureSel}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key !== "Enter") return;
            e.preventDefault();
            const v = parseFloat(e.currentTarget.value);
            applyToSelection((st) => ({ ...st, size: Number.isFinite(v) && v > 0 ? v : 0 }));
            editorRef.current?.focus();
          }}
          className="h-6 w-12 rounded bg-zinc-100 px-1.5 text-[11px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
        />
        <select
          data-testid="span-family"
          title="Font family for the selection"
          defaultValue=""
          onPointerDown={captureSel}
          onFocus={captureSel}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const family = e.currentTarget.value;
            if (family) ensureFont(family);
            applyToSelection((st) => ({ ...st, family }));
            e.currentTarget.value = "";
            editorRef.current?.focus();
          }}
          className="h-6 w-24 rounded bg-zinc-100 px-1 text-[11px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
        >
          <option value="">Font…</option>
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <div
        ref={editorRef}
        data-testid="text-editor"
        contentEditable
        suppressContentEditableWarning
        onPaste={(e) => {
          e.preventDefault();
          const plain = e.clipboardData.getData("text/plain");
          if (plain) insertPlain(plain);
        }}
        onInput={onInput}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => {
          composing.current = false;
          onInput();
        }}
        onBlur={(e) => {
          // Focus moving into the toolbar is part of editing.
          const to = e.relatedTarget as HTMLElement | null;
          if (to && to.closest('[data-testid="text-toolbar"]')) return;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") commit();
          if ((e.metaKey || e.ctrlKey) && ["b", "i"].includes(e.key.toLowerCase())) {
            e.preventDefault();
            toggle(e.key.toLowerCase() === "b" ? "bold" : "italic");
          }
          e.stopPropagation();
        }}
        className="absolute overflow-hidden bg-transparent outline-none"
        style={{
          left,
          top,
          width,
          minHeight,
          fontSize: node.fontSize * zoom,
          lineHeight: `${lineHeight}px`,
          textAlign: node.textAlign,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: `'${node.fontFamily}', sans-serif`,
          color: node.fills[0]?.color ?? "#18181b",
        }}
      />
    </>
  );
}
