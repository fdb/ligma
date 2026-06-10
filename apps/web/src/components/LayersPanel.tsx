import { useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import type { Scene } from "../types";
import { Icon } from "./Icon";

export function LayersPanel({ engine, scene }: { engine: Engine; scene: Scene }) {
  const [editing, setEditing] = useState<number | null>(null);

  // Topmost layer first, matching Figma's convention.
  const layers = [...scene.nodes].reverse();

  return (
    <aside
      data-testid="layers"
      className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white"
    >
      <div className="px-4 pt-4 pb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
        Layers
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {layers.length === 0 && (
          <p className="px-2 py-1 text-[12px] leading-5 text-zinc-400">
            Nothing here yet. Draw a frame (F) or rectangle (R) to get started.
          </p>
        )}
        {layers.map((n) => {
          const selected = scene.selection.includes(n.id);
          const hovered = scene.hovered === n.id;
          return (
            <div
              key={n.id}
              onPointerDown={(e) => engine.select(n.id, e.shiftKey)}
              onDoubleClick={() => setEditing(n.id)}
              className={`flex h-7 cursor-default items-center gap-2 rounded-md px-2 ${
                selected
                  ? "bg-sky-50 text-sky-800"
                  : hovered
                    ? "bg-zinc-50 text-zinc-700"
                    : "text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              <span className={selected ? "text-sky-500" : "text-zinc-400"}>
                <Icon name={n.kind === "frame" ? "frame" : n.kind} size={12} />
              </span>
              {editing === n.id ? (
                <input
                  autoFocus
                  defaultValue={n.name}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => {
                    engine.set_name(n.id, e.currentTarget.value || n.name);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditing(null);
                    e.stopPropagation();
                  }}
                  className="w-full rounded-sm bg-white px-1 text-[12px] ring-1 ring-sky-400 outline-none"
                />
              ) : (
                <span className="truncate text-[12px]">{n.name}</span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
