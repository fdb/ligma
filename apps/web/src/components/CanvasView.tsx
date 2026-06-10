import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import { fontMetrics } from "../lib/fontMetrics";
import { placementSize, uploadImage } from "../lib/images";
import type { Peer } from "../lib/usePresence";
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
}

const toolKeys: Record<string, Tool> = {
  v: "select",
  f: "frame",
  r: "rect",
  o: "ellipse",
  t: "text",
  h: "hand",
};

type Overlay = { id: number; kind: "text" | "name" } | null;

export function CanvasView({ engine, scene, onSave, wrapRef, peers, reportCursor }: Props) {
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
        e.shiftKey ? engine.ungroup_selection() : engine.group_selection();
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
        engine.clear_selection();
        engine.set_tool("select");
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
  }, [engine, onSave, wrapRef]);

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
    const labelId = engine.frame_label_at(x, y);
    if (labelId !== undefined) {
      engine.set_editing_node(labelId);
      setOverlay({ id: labelId, kind: "name" });
      return;
    }
    // Engine hit test (descends into frame children, skips hidden/locked).
    const hitId = engine.node_at(x, y);
    const hit = hitId !== undefined ? findNode(live.nodes, hitId) : null;
    if (hit?.kind === "text") {
      engine.set_editing_node(hit.id);
      setOverlay({ id: hit.id, kind: "text" });
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
          engine.pointer_move(x, y);
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
      {overlay &&
        overlayNode &&
        overlay.kind === "text" &&
        (() => {
          // Align the input's glyphs exactly with where the canvas drew
          // them: match the CSS line-box baseline to the canvas baseline
          // (textBaseline="top" at the vertically-centered em top).
          const fs = overlayNode.fontSize * scene.zoom;
          const m = fontMetrics(fs);
          const boxH = m.fbAscent + m.fbDescent;
          const emTop =
            (overlayNode.y + Math.max(0, overlayNode.h - overlayNode.fontSize) / 2) * scene.zoom +
            scene.panY;
          return (
            <input
              autoFocus
              data-testid="text-editor"
              defaultValue={overlayNode.text}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                engine.set_text(overlayNode.id, e.currentTarget.value);
                closeOverlay();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") closeOverlay();
                e.stopPropagation();
              }}
              className="absolute bg-transparent p-0 outline-none"
              style={{
                left: overlayNode.x * scene.zoom + scene.panX,
                top: emTop + m.emAscent - m.fbAscent,
                width: Math.max(60, overlayNode.w * scene.zoom + 16),
                height: boxH,
                fontSize: fs,
                lineHeight: `${boxH}px`,
                fontFamily: "'Hanken Grotesk', sans-serif",
                color: overlayNode.fills[0]?.color ?? "#18181b",
              }}
            />
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
