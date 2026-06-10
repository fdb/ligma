import { Link } from "@tanstack/react-router";
import type { Engine } from "../engine/pkg/ligma_core";
import type { Scene, Tool } from "../types";
import { Icon } from "./Icon";

const tools: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "select", icon: "select", label: "Move", key: "V" },
  { id: "frame", icon: "frame", label: "Frame", key: "F" },
  { id: "rect", icon: "rect", label: "Rectangle", key: "R" },
  { id: "ellipse", icon: "ellipse", label: "Ellipse", key: "O" },
  { id: "text", icon: "text", label: "Text", key: "T" },
  { id: "hand", icon: "hand", label: "Hand", key: "H" },
];

export type SaveState = "idle" | "saving" | "saved" | "error";

interface Props {
  engine: Engine;
  scene: Scene;
  docId: string;
  saveState: SaveState;
  onSave: () => void;
  viewport: () => { w: number; h: number };
}

export function TopBar({ engine, scene, docId, saveState, onSave, viewport }: Props) {
  const zoomAroundCenter = (zoom: number) => {
    const { w, h } = viewport();
    engine.set_zoom(zoom, w / 2, h / 2);
  };

  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-3">
      <div className="flex items-center gap-2.5">
        <Link
          to="/"
          title="Back to your files"
          className="flex size-7 items-center justify-center rounded-md bg-sky-500 text-white shadow-sm transition-colors hover:bg-sky-600"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
            <path d="M3 1.5h2.5v8.5H11v2.5H3z" />
          </svg>
        </Link>
        <div className="leading-tight">
          <div className="font-semibold tracking-tight text-zinc-900">Ligma</div>
          <div className="font-mono text-[10px] text-zinc-400">{docId}</div>
        </div>
      </div>

      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 shadow-sm">
        {tools.map((t) => (
          <button
            key={t.id}
            title={`${t.label} (${t.key})`}
            onClick={() => engine.set_tool(t.id)}
            className={`flex size-8 items-center justify-center rounded-md transition-colors ${
              scene.tool === t.id
                ? "bg-sky-500 text-white"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            <Icon name={t.icon} />
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-md border border-zinc-200">
          <button
            title="Zoom out"
            onClick={() => zoomAroundCenter(scene.zoom / 1.25)}
            className="flex size-7 items-center justify-center rounded-l-md text-zinc-500 hover:bg-zinc-100"
          >
            <Icon name="minus" size={14} />
          </button>
          <span className="w-12 text-center font-mono text-[11px] text-zinc-600">
            {Math.round(scene.zoom * 100)}%
          </span>
          <button
            title="Zoom in"
            onClick={() => zoomAroundCenter(scene.zoom * 1.25)}
            className="flex size-7 items-center justify-center text-zinc-500 hover:bg-zinc-100"
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            title="Zoom to fit (Shift+1)"
            onClick={() => {
              const { w, h } = viewport();
              engine.zoom_to_fit(w, h);
            }}
            className="flex size-7 items-center justify-center rounded-r-md border-l border-zinc-200 text-zinc-500 hover:bg-zinc-100"
          >
            <Icon name="fit" size={14} />
          </button>
        </div>
        <button
          onClick={onSave}
          disabled={saveState === "saving"}
          className="h-7 rounded-md bg-sky-500 px-3 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-sky-600 disabled:opacity-60"
        >
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : saveState === "error" ? "Retry save" : "Save"}
        </button>
      </div>
    </header>
  );
}
