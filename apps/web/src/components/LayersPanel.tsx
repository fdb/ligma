import { useRef, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import type { Scene, SceneNode } from "../types";
import { Icon } from "./Icon";

const kindIcon = (kind: SceneNode["kind"]) =>
  kind === "frame" ? "frame" : kind === "group" ? "group" : kind;

type Zone = "above" | "below" | "into";

/** The parent id (0 = root) and sibling list containing a node. */
function locate(
  nodes: SceneNode[],
  id: number,
  parent = 0,
): { parent: number; list: SceneNode[] } | null {
  for (const n of nodes) {
    if (n.id === id) return { parent, list: nodes };
    const found = locate(n.children, id, n.id);
    if (found) return found;
  }
  return null;
}

function LayerRow({
  engine,
  scene,
  node,
  depth,
  expanded,
  onToggleExpand,
  editing,
  setEditing,
  dropHint,
  onDragStartRow,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: {
  engine: Engine;
  scene: Scene;
  node: SceneNode;
  depth: number;
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  editing: number | null;
  setEditing: (id: number | null) => void;
  dropHint: { id: number; zone: Zone } | null;
  onDragStartRow: (id: number) => void;
  onDragOverRow: (id: number, zone: Zone) => void;
  onDropRow: (id: number) => void;
  onDragEndRow: () => void;
}) {
  const selected = scene.selection.includes(node.id);
  const hovered = scene.hovered === node.id;
  const isGroup = node.children.length > 0;
  const isContainer = node.kind === "frame" || node.kind === "group";
  const open = expanded.has(node.id);
  const hint = dropHint?.id === node.id ? dropHint.zone : null;

  // The panel lists topmost-first, so "above" a row means later in the
  // z-order list; the drop handler does that mapping.
  const hintClass =
    hint === "above"
      ? "shadow-[inset_0_2px_0_0_#0ea5e9]"
      : hint === "below"
        ? "shadow-[inset_0_-2px_0_0_#0ea5e9]"
        : hint === "into"
          ? "ring-1 ring-sky-400 ring-inset bg-sky-50"
          : "";

  return (
    <>
      <div
        data-layer={node.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", String(node.id));
          e.dataTransfer.effectAllowed = "move";
          onDragStartRow(node.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const f = (e.clientY - r.top) / r.height;
          const zone: Zone = isContainer
            ? f < 0.3
              ? "above"
              : f > 0.7
                ? "below"
                : "into"
            : f < 0.5
              ? "above"
              : "below";
          onDragOverRow(node.id, zone);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDropRow(node.id);
        }}
        onDragEnd={onDragEndRow}
        onPointerDown={(e) => engine.select(node.id, e.shiftKey)}
        onDoubleClick={() => setEditing(node.id)}
        className={`group/row flex h-7 cursor-default items-center gap-1.5 rounded-md pr-1 ${
          selected
            ? "bg-sky-50 text-sky-800"
            : hovered
              ? "bg-zinc-50 text-zinc-700"
              : "text-zinc-600 hover:bg-zinc-50"
        } ${!node.visible ? "opacity-45" : ""} ${hintClass}`}
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
            dropHint={dropHint}
            onDragStartRow={onDragStartRow}
            onDragOverRow={onDragOverRow}
            onDropRow={onDropRow}
            onDragEndRow={onDragEndRow}
          />
        ))}
    </>
  );
}

export function LayersPanel({ engine, scene }: { engine: Engine; scene: Scene }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [dropHint, setDropHint] = useState<{ id: number; zone: Zone } | null>(null);
  // The latest hint, readable synchronously: a drop can arrive before
  // React re-renders the state set by the preceding dragover.
  const hintRef = useRef<{ id: number; zone: Zone } | null>(null);
  const dragId = useRef<number | null>(null);

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearDrag = () => {
    dragId.current = null;
    hintRef.current = null;
    setDropHint(null);
  };

  const handleDrop = (targetId: number) => {
    const src = dragId.current;
    const hint = hintRef.current;
    clearDrag();
    if (!src || !hint || hint.id !== targetId || src === targetId) return;
    if (hint.zone === "into") {
      engine.reparent(src, targetId, 0); // append = topmost inside
      setExpanded((prev) => new Set(prev).add(targetId));
      return;
    }
    const info = locate(scene.nodes, targetId);
    if (!info) return;
    const idx = info.list.findIndex((n) => n.id === targetId);
    if (hint.zone === "above") {
      // Visually above the row = next position up in z-order = inserted
      // after it in the list, i.e. before its next sibling.
      let before = info.list[idx + 1];
      if (before?.id === src) before = info.list[idx + 2];
      engine.reparent(src, info.parent, before?.id ?? 0);
    } else {
      engine.reparent(src, info.parent, targetId);
    }
  };

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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onDragLeave={() => setDropHint(null)}>
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
            dropHint={dropHint}
            onDragStartRow={(id) => (dragId.current = id)}
            onDragOverRow={(id, zone) => {
              hintRef.current = { id, zone };
              setDropHint((h) => (h?.id === id && h.zone === zone ? h : { id, zone }));
            }}
            onDropRow={handleDrop}
            onDragEndRow={clearDrag}
          />
        ))}
      </div>
    </aside>
  );
}
