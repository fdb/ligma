import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import { findNode, type Scene, type SceneNode, type Tool } from "../types";

interface Props {
  engine: Engine;
  scene: Scene;
  onSave: () => void;
  wrapRef: React.RefObject<HTMLDivElement | null>;
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

export function CanvasView({ engine, scene, onSave, wrapRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
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
    // Topmost visible, unlocked top-level node under the cursor.
    const wx = (x - live.panX) / live.zoom;
    const wy = (y - live.panY) / live.zoom;
    const hit = [...live.nodes]
      .reverse()
      .find(
        (n) =>
          n.visible && !n.locked && wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h,
      );
    if (hit?.kind === "text") {
      engine.set_editing_node(hit.id);
      setOverlay({ id: hit.id, kind: "text" });
    }
  };

  const overlayNode: SceneNode | null = overlay ? findNode(scene.nodes, overlay.id) : null;

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1 overflow-hidden">
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
        }}
        onPointerUp={() => engine.pointer_up()}
        onDoubleClick={onDoubleClick}
      />
      {overlay && overlayNode && overlay.kind === "text" && (
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
          className="absolute bg-transparent outline-none"
          style={{
            left: overlayNode.x * scene.zoom + scene.panX,
            top: overlayNode.y * scene.zoom + scene.panY,
            width: Math.max(60, overlayNode.w * scene.zoom + 16),
            height: overlayNode.h * scene.zoom,
            fontSize: overlayNode.fontSize * scene.zoom,
            lineHeight: `${overlayNode.h * scene.zoom}px`,
            fontFamily: "'Hanken Grotesk', sans-serif",
            color: overlayNode.fills[0]?.color ?? "#18181b",
          }}
        />
      )}
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
