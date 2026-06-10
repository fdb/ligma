import { useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import type { Scene, SceneNode } from "../types";
import { Icon } from "./Icon";

const kindIcon = (kind: SceneNode["kind"]) =>
  kind === "frame" ? "frame" : kind === "group" ? "group" : kind;

function LayerRow({
  engine,
  scene,
  node,
  depth,
  expanded,
  onToggleExpand,
  editing,
  setEditing,
}: {
  engine: Engine;
  scene: Scene;
  node: SceneNode;
  depth: number;
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  editing: number | null;
  setEditing: (id: number | null) => void;
}) {
  const selected = scene.selection.includes(node.id);
  const hovered = scene.hovered === node.id;
  const isGroup = node.children.length > 0;
  const open = expanded.has(node.id);

  return (
    <>
      <div
        data-layer={node.id}
        onPointerDown={(e) => engine.select(node.id, e.shiftKey)}
        onDoubleClick={() => setEditing(node.id)}
        className={`group/row flex h-7 cursor-default items-center gap-1.5 rounded-md pr-1 ${
          selected
            ? "bg-sky-50 text-sky-800"
            : hovered
              ? "bg-zinc-50 text-zinc-700"
              : "text-zinc-600 hover:bg-zinc-50"
        } ${!node.visible ? "opacity-45" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {isGroup ? (
          <button
            title={open ? "Collapse" : "Expand"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onToggleExpand(node.id)}
            className={`flex size-4 shrink-0 items-center justify-center text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
          >
            <Icon name="chevron" size={10} />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span className={selected ? "text-sky-500" : "text-zinc-400"}>
          <Icon name={kindIcon(node.kind)} size={12} />
        </span>
        {editing === node.id ? (
          <input
            autoFocus
            defaultValue={node.name}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              engine.set_name(node.id, e.currentTarget.value || node.name);
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
          <span className="flex-1 truncate text-[12px]">{node.name}</span>
        )}
        <button
          title={node.locked ? "Unlock" : "Lock"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => engine.set_locked(node.id, !node.locked)}
          className={`flex size-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-700 ${
            node.locked ? "" : "opacity-0 group-hover/row:opacity-100"
          }`}
        >
          <Icon name={node.locked ? "lock" : "unlock"} size={11} />
        </button>
        <button
          title={node.visible ? "Hide" : "Show"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => engine.set_visible(node.id, !node.visible)}
          className={`flex size-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-700 ${
            node.visible ? "opacity-0 group-hover/row:opacity-100" : ""
          }`}
        >
          <Icon name={node.visible ? "eye" : "eye-off"} size={11} />
        </button>
      </div>
      {isGroup &&
        open &&
        [...node.children].reverse().map((c) => (
          <LayerRow
            key={c.id}
            engine={engine}
            scene={scene}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            editing={editing}
            setEditing={setEditing}
          />
        ))}
    </>
  );
}

export function LayersPanel({ engine, scene }: { engine: Engine; scene: Scene }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
        {layers.map((n) => (
          <LayerRow
            key={n.id}
            engine={engine}
            scene={scene}
            node={n}
            depth={0}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            editing={editing}
            setEditing={setEditing}
          />
        ))}
      </div>
    </aside>
  );
}
