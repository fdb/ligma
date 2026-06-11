import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import { fontMetrics, wrapLines } from "../lib/fontMetrics";
import { ensureFont, FONT_FAMILIES } from "../lib/fonts";
import { placementSize, uploadImage } from "../lib/images";
import type { Peer } from "../lib/usePresence";
import type { CommentRow } from "../lib/useComments";
import { CommentsLayer } from "./Comments";
import { findNode, type Scene, type SceneNode, type Tool } from "../types";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./MenuBar";

interface Props {
  engine: Engine;
  scene: Scene;
  onSave: () => void;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  peers: Record<string, Peer>;
  reportCursor: (x: number, y: number) => void;
  comments: CommentRow[];
  commentMode: boolean;
  onToggleCommentMode: () => void;
  onExitCommentMode: () => void;
  onAddComment: (x: number, y: number, body: string) => void;
  onResolveComment: (id: string) => void;
}

const toolKeys: Record<string, Tool> = {
  v: "select",
  f: "frame",
  r: "rect",
  o: "ellipse",
  t: "text",
  p: "pen",
  h: "hand",
};

type Overlay = { id: number; kind: "text" | "name" } | null;

export function CanvasView({
  engine,
  scene,
  onSave,
  wrapRef,
  peers,
  reportCursor,
  comments,
  commentMode,
  onToggleCommentMode,
  onExitCommentMode,
  onAddComment,
  onResolveComment,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const closeOverlay = () => {
    engine.set_editing_node(0);
    setOverlay(null);
  };

  // Render loop + DPR-aware sizing.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(wrap.clientWidth * dpr);
      canvas.height = Math.round(wrap.clientHeight * dpr);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    engine.zoom_to_fit(wrap.clientWidth, wrap.clientHeight);

    let raf = 0;
    const tick = () => {
      engine.render(ctx, wrap.clientWidth, wrap.clientHeight, window.devicePixelRatio || 1);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [engine, wrapRef]);

  // Wheel must be registered natively: React's wheel listeners are passive,
  // and we need preventDefault to stop browser page-zoom on pinch.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      engine.wheel(e.deltaX, e.deltaY, e.ctrlKey || e.metaKey, e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [engine]);

  // Keyboard: tools, delete, undo/redo, duplicate, nudge, space-pan, save.
  useEffect(() => {
    const prevTool = { current: null as Tool | null };
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? engine.redo() : engine.undo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        engine.duplicate_selection();
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.altKey) engine.frame_selection();
        else if (e.shiftKey) engine.ungroup_selection();
        else engine.group_selection();
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        engine.flatten_selection();
      } else if (mod && e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        engine.create_component();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      } else if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        engine.copy_selection();
      } else if (mod && e.key.toLowerCase() === "x") {
        e.preventDefault();
        engine.cut_selection();
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        engine.paste_clipboard();
      } else if (mod && e.key === "]") {
        e.preventDefault();
        engine.bring_to_front();
      } else if (mod && e.key === "[") {
        e.preventDefault();
        engine.send_to_back();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        const wrap = wrapRef.current!;
        engine.set_zoom(engine.zoom() * 1.25, wrap.clientWidth / 2, wrap.clientHeight / 2);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        const wrap = wrapRef.current!;
        engine.set_zoom(engine.zoom() / 1.25, wrap.clientWidth / 2, wrap.clientHeight / 2);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        const wrap = wrapRef.current!;
        engine.set_zoom(1, wrap.clientWidth / 2, wrap.clientHeight / 2);
      } else if (e.shiftKey && e.key === "1") {
        const wrap = wrapRef.current!;
        engine.zoom_to_fit(wrap.clientWidth, wrap.clientHeight);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        engine.delete_selection();
      } else if (e.key === "Escape") {
        // First Escape leaves vector-edit mode, keeping the selection.
        if (engine.path_edit_active()) {
          engine.exit_path_edit();
          return;
        }
        onExitCommentMode();
        engine.clear_selection();
        // Leaving the pen tool commits the in-progress path (engine-side).
        engine.set_tool("select");
      } else if (e.key === "Enter" && engine.pen_active()) {
        engine.pen_commit();
      } else if (!mod && e.key.toLowerCase() === "c") {
        onToggleCommentMode();
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const [dx, dy] = d[e.key];
        engine.nudge(dx, dy);
      } else if (e.key === " " && !e.repeat) {
        e.preventDefault();
        prevTool.current = sceneRef.current.tool;
        engine.set_tool("hand");
      } else if (!mod && toolKeys[e.key.toLowerCase()]) {
        engine.set_tool(toolKeys[e.key.toLowerCase()]);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && prevTool.current) {
        engine.set_tool(prevTool.current);
        prevTool.current = null;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [engine, onSave, wrapRef, onToggleCommentMode, onExitCommentMode]);

  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    // Read fresh engine state, not the React snapshot: the dblclick's own
    // pointer events bump the engine generation and this handler runs
    // before the next rAF sync catches React up.
    const live: Scene = JSON.parse(engine.scene());
    if (live.tool !== "select") return;
    const { x, y } = pos(e);
    // Vector-edit mode: double-click toggles an anchor corner <-> smooth;
    // off the anchors it leaves edit mode.
    if (live.pathEdit != null) {
      if (!engine.path_toggle_anchor(x, y)) engine.exit_path_edit();
      return;
    }
    const labelId = engine.frame_label_at(x, y);
    if (labelId !== undefined) {
      engine.set_editing_node(labelId);
      setOverlay({ id: labelId, kind: "name" });
      return;
    }
    // Deep select: enter one container level (group/frame nesting) per
    // double-click. Only at a leaf do we fall through to editing.
    if (engine.deep_select(x, y)) return;
    // node_at stops at group boundaries; after deep-selecting down to a
    // leaf, the selection IS the node under the cursor, so prefer it.
    const hitId = engine.node_at(x, y);
    const sel = live.selection.length === 1 ? findNode(live.nodes, live.selection[0]) : null;
    const hit = hitId === undefined ? null : (sel ?? findNode(live.nodes, hitId));
    if (hit?.kind === "text") {
      engine.set_editing_node(hit.id);
      setOverlay({ id: hit.id, kind: "text" });
    } else if (hit?.kind === "path") {
      engine.enter_path_edit(hit.id);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = pos(e);
    const hit = engine.node_at(x, y);
    const live: Scene = JSON.parse(engine.scene());
    if (hit !== undefined && !live.selection.includes(hit)) {
      engine.select(hit, false);
    } else if (hit === undefined) {
      engine.clear_selection();
    }
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const ctxItems = (): (MenuItem | "---")[] => {
    const sel = scene.selection;
    const some = sel.length > 0;
    const first = some ? findNode(scene.nodes, sel[0]) : null;
    return [
      { label: "Copy", shortcut: "⌘C", disabled: !some, action: () => engine.copy_selection() },
      { label: "Cut", shortcut: "⌘X", disabled: !some, action: () => engine.cut_selection() },
      {
        label: "Paste",
        shortcut: "⌘V",
        disabled: engine.clipboard_len() === 0,
        action: () => engine.paste_clipboard(),
      },
      {
        label: "Duplicate",
        shortcut: "⌘D",
        disabled: !some,
        action: () => engine.duplicate_selection(),
      },
      "---",
      {
        label: "Bring to front",
        shortcut: "⌘]",
        disabled: !some,
        action: () => engine.bring_to_front(),
      },
      {
        label: "Send to back",
        shortcut: "⌘[",
        disabled: !some,
        action: () => engine.send_to_back(),
      },
      "---",
      {
        label: "Group selection",
        shortcut: "⌘G",
        disabled: sel.length < 2,
        action: () => engine.group_selection(),
      },
      {
        label: "Ungroup",
        shortcut: "⇧⌘G",
        disabled: !some,
        action: () => engine.ungroup_selection(),
      },
      {
        label: "Frame selection",
        shortcut: "⌥⌘G",
        disabled: !some,
        action: () => engine.frame_selection(),
      },
      {
        label: "Flatten",
        shortcut: "⌘E",
        disabled: !some,
        action: () => engine.flatten_selection(),
      },
      "---",
      {
        label: "Union",
        disabled: sel.length < 2,
        action: () => engine.boolean_selection("union"),
      },
      {
        label: "Subtract",
        disabled: sel.length < 2,
        action: () => engine.boolean_selection("subtract"),
      },
      {
        label: "Intersect",
        disabled: sel.length < 2,
        action: () => engine.boolean_selection("intersect"),
      },
      {
        label: "Outline stroke",
        disabled: !some,
        action: () => engine.outline_stroke(),
      },
      "---",
      {
        label: "Create component",
        shortcut: "⌥⌘K",
        disabled: !some,
        action: () => engine.create_component(),
      },
      {
        label: "Create instance",
        disabled: sel.length !== 1 || first?.kind !== "component",
        action: () => engine.create_instance(),
      },
      "---",
      {
        label: first?.visible === false ? "Show" : "Hide",
        disabled: !some,
        action: () => sel.forEach((id) => engine.set_visible(id, first?.visible === false)),
      },
      {
        label: first?.locked ? "Unlock" : "Lock",
        disabled: !some,
        action: () => sel.forEach((id) => engine.set_locked(id, !first?.locked)),
      },
      "---",
      { label: "Delete", shortcut: "⌫", disabled: !some, action: () => engine.delete_selection() },
    ];
  };

  const overlayNode: SceneNode | null = overlay ? findNode(scene.nodes, overlay.id) : null;

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const up = await uploadImage(file);
    if (!up) return;
    const s = sceneRef.current;
    const { w, h } = placementSize(up.width, up.height);
    const wx = (sx - s.panX) / s.zoom - w / 2;
    const wy = (sy - s.panY) / s.zoom - h / 2;
    engine.add_image(up.hash, wx, wy, w, h);
  };

  return (
    <div
      ref={wrapRef}
      className="relative min-w-0 flex-1 overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full touch-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const { x, y } = pos(e);
          engine.pointer_down(x, y, e.shiftKey, e.altKey);
        }}
        onPointerMove={(e) => {
          const { x, y } = pos(e);
          engine.pointer_move(x, y, e.shiftKey);
          e.currentTarget.style.cursor = engine.cursor(x, y);
          const s = sceneRef.current;
          reportCursor((x - s.panX) / s.zoom, (y - s.panY) / s.zoom);
        }}
        onPointerUp={() => engine.pointer_up()}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems()}
          onClose={() => setCtxMenu(null)}
        />
      )}
      <CommentsLayer
        scene={scene}
        comments={comments}
        mode={commentMode}
        onExitMode={onExitCommentMode}
        onAdd={onAddComment}
        onResolve={onResolveComment}
      />
      {Object.values(peers).map((p) => (
        <div
          key={p.id}
          data-testid="peer-cursor"
          className="pointer-events-none absolute z-10 transition-[left,top] duration-75"
          style={{ left: p.x * scene.zoom + scene.panX, top: p.y * scene.zoom + scene.panY }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M2 1l5 13 2-5.5L14.5 7z"
              fill={p.color}
              stroke="#ffffff"
              strokeWidth="1.2"
            />
          </svg>
          <span
            className="mt-0.5 ml-3 block w-max rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm"
            style={{ background: p.color }}
          >
            {p.name}
          </span>
        </div>
      ))}
      {(() => {
        // A draggable angle handle for linear-gradient fills: a spoke
        // from the node center; dragging the dot re-aims the gradient.
        if (scene.selection.length !== 1 || scene.pathEdit != null || overlay) return null;
        const n = findNode(scene.nodes, scene.selection[0]);
        const g = n?.fills[0];
        if (!n || !g || g.kind !== "linear" || g.stops.length < 2) return null;
        const cx = (n.x + n.w / 2) * scene.zoom + scene.panX;
        const cy = (n.y + n.h / 2) * scene.zoom + scene.panY;
        const rad = (g.angle * Math.PI) / 180;
        const len = (Math.min(n.w, n.h) / 2) * scene.zoom * 0.8;
        const hx = cx + Math.cos(rad) * len;
        const hy = cy + Math.sin(rad) * len;
        return (
          <>
            <svg className="pointer-events-none absolute inset-0 size-full">
              <line x1={cx} y1={cy} x2={hx} y2={hy} stroke="#0ea5e9" strokeWidth="1.5" />
            </svg>
            <span
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-sky-500 shadow"
              style={{ left: cx, top: cy }}
            />
            <span
              data-testid="gradient-handle"
              title="Drag to aim the gradient"
              className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-sky-500 shadow active:cursor-grabbing"
              style={{ left: hx, top: hy }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                engine.begin_edit();
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const r = canvasRef.current!.getBoundingClientRect();
                const px = e.clientX - r.left;
                const py = e.clientY - r.top;
                const angle = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
                engine.set_paint_gradient_live(n.id, 0, g.kind, angle, JSON.stringify(g.stops));
              }}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture(e.pointerId);
                engine.commit_edit();
              }}
            />
          </>
        );
      })()}
      {overlay &&
        overlayNode &&
        overlay.kind === "text" &&
        (() => {
          // Align the editor's glyphs exactly with where the canvas drew
          // them. The canvas lays text in slots of 1.4em with the em box
          // centered in each slot; CSS line boxes position glyphs by font
          // bounding box, so shift the whole textarea by the measured
          // difference — both grids share the same period, so every line
          // stays aligned.
          const fs = overlayNode.fontSize * scene.zoom;
          const slh = overlayNode.fontSize * 1.4 * scene.zoom;
          const m = fontMetrics(fs, overlayNode.fontFamily);
          const lineCount = wrapLines(
            overlayNode.text,
            fs,
            overlayNode.w * scene.zoom,
            overlayNode.fontFamily,
          ).length;
          const block = lineCount * slh;
          const boxTop = overlayNode.y * scene.zoom + scene.panY;
          const boxH = overlayNode.h * scene.zoom;
          const y0 =
            overlayNode.textValign === "top"
              ? boxTop
              : overlayNode.textValign === "bottom"
                ? boxTop + boxH - block
                : boxTop + (boxH - block) / 2;
          const top =
            y0 + (slh - fs) / 2 + m.emAscent - (slh - m.fbAscent - m.fbDescent) / 2 - m.fbAscent;
          // Style the textarea's current selection. Toolbar buttons keep
          // the textarea focused (pointerdown is prevented), so the
          // selection survives the click.
          const styleSelection = (
            apply: (id: number, start: number, len: number) => void,
          ) => {
            const ta = document.querySelector<HTMLTextAreaElement>(
              '[data-testid="text-editor"]',
            );
            if (!ta) return;
            const [start, end] = [ta.selectionStart, ta.selectionEnd];
            if (start === end) return;
            engine.set_text(overlayNode.id, ta.value);
            apply(overlayNode.id, start, end - start);
          };
          const toggleSpan = (field: "bold" | "italic", start: number, end: number) => {
            const live: Scene = JSON.parse(engine.scene());
            const node = findNode(live.nodes, overlayNode.id);
            const allOn = !!node?.spans.some(
              (s) =>
                s.start <= start &&
                s.start + s.len >= end &&
                (field === "bold" ? s.bold : s.italic),
            );
            engine.set_span_style(overlayNode.id, start, end - start, field, !allOn);
          };
          const SPAN_COLORS = ["#18181b", "#ef4444", "#f59e0b", "#22c55e", "#0ea5e9", ""];
          const refocusEditor = () => {
            document
              .querySelector<HTMLTextAreaElement>('[data-testid="text-editor"]')
              ?.focus();
          };
          return (
            <>
            <div
              data-testid="text-toolbar"
              className="absolute z-10 flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-1.5 py-1 shadow-md"
              style={{
                left: overlayNode.x * scene.zoom + scene.panX,
                top: top - 38,
              }}
              onPointerDown={(e) => e.preventDefault()}
            >
              {(["bold", "italic"] as const).map((f) => (
                <button
                  key={f}
                  title={f === "bold" ? "Bold (⌘B)" : "Italic (⌘I)"}
                  onClick={() =>
                    styleSelection((_, start, len) => toggleSpan(f, start, start + len))
                  }
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
                  onClick={() =>
                    styleSelection((id, start, len) => engine.set_span_color(id, start, len, c))
                  }
                  className="flex size-6 items-center justify-center rounded hover:bg-zinc-100"
                >
                  <span
                    className={`block size-3.5 rounded-full ${c ? "" : "border border-zinc-300 bg-white"}`}
                    style={c ? { background: c } : undefined}
                  />
                </button>
              ))}
              <span className="mx-0.5 h-4 w-px bg-zinc-200" />
              {/* Size + family act on the selection; they take focus, so
                  the textarea's blur handler spares toolbar targets. */}
              <input
                data-testid="span-size"
                type="number"
                min={1}
                max={400}
                placeholder={String(overlayNode.fontSize)}
                title="Font size for the selection (empty resets)"
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key !== "Enter") return;
                  // Without preventDefault the Enter keypress would land
                  // in the refocused textarea and replace the selection
                  // with a newline.
                  e.preventDefault();
                  const v = parseFloat(e.currentTarget.value);
                  styleSelection((id, start, len) =>
                    engine.set_span_size(id, start, len, Number.isFinite(v) ? v : 0),
                  );
                  refocusEditor();
                }}
                className="h-6 w-12 rounded bg-zinc-100 px-1.5 text-[11px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
              />
              <select
                data-testid="span-family"
                title="Font family for the selection"
                defaultValue=""
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const family = e.currentTarget.value;
                  if (family) ensureFont(family);
                  styleSelection((id, start, len) =>
                    engine.set_span_family(id, start, len, family),
                  );
                  e.currentTarget.value = "";
                  refocusEditor();
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
            <textarea
              autoFocus
              data-testid="text-editor"
              defaultValue={overlayNode.text}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                // Focus moving into the toolbar (size field, font select)
                // is part of editing — keep the overlay open; the
                // textarea's selection range survives the blur.
                const to = e.relatedTarget as HTMLElement | null;
                if (to && to.closest('[data-testid="text-toolbar"]')) return;
                engine.set_text(overlayNode.id, e.currentTarget.value);
                closeOverlay();
              }}
              onKeyDown={(e) => {
                // Enter inserts a newline (Figma behavior); Escape commits.
                if (e.key === "Escape") e.currentTarget.blur();
                // ⌘B/⌘I style the selected character range. The overlay
                // textarea stays plain; styling shows after commit.
                if ((e.metaKey || e.ctrlKey) && ["b", "i"].includes(e.key.toLowerCase())) {
                  e.preventDefault();
                  const field = e.key.toLowerCase() === "b" ? "bold" : "italic";
                  styleSelection((_, start, len) => toggleSpan(field, start, start + len));
                }
                e.stopPropagation();
              }}
              className="absolute resize-none overflow-hidden bg-transparent p-0 outline-none"
              style={{
                left: overlayNode.x * scene.zoom + scene.panX,
                top,
                width: overlayNode.w * scene.zoom,
                height: Math.max(block, slh) + slh, // headroom for the line being typed
                fontSize: fs,
                lineHeight: `${slh}px`,
                textAlign: overlayNode.textAlign,
                whiteSpace: "pre-wrap",
                fontFamily: `'${overlayNode.fontFamily}', sans-serif`,
                color: overlayNode.fills[0]?.color ?? "#18181b",
              }}
            />
            </>
          );
        })()}
      {overlay && overlayNode && overlay.kind === "name" && (
        <input
          autoFocus
          data-testid="frame-name-editor"
          defaultValue={overlayNode.name}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            engine.set_name(overlayNode.id, e.currentTarget.value || overlayNode.name);
            closeOverlay();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") closeOverlay();
            e.stopPropagation();
          }}
          className="absolute rounded-sm bg-white px-1 text-[11px] text-zinc-700 ring-1 ring-sky-400 outline-none"
          style={{
            left: overlayNode.x * scene.zoom + scene.panX - 4,
            top: overlayNode.y * scene.zoom + scene.panY - 20,
            width: 160,
          }}
        />
      )}
    </div>
  );
}
