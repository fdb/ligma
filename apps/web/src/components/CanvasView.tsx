import { useEffect, useRef } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import type { Scene, Tool } from "../types";

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

export function CanvasView({ engine, scene, onSave, wrapRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

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

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full touch-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const { x, y } = pos(e);
          engine.pointer_down(x, y, e.shiftKey);
        }}
        onPointerMove={(e) => {
          const { x, y } = pos(e);
          engine.pointer_move(x, y);
          e.currentTarget.style.cursor = engine.cursor(x, y);
        }}
        onPointerUp={() => engine.pointer_up()}
      />
    </div>
  );
}
