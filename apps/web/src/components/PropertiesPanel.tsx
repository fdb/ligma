import { useRef, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import { findNode, type Paint, type Scene, type SceneNode } from "../types";
import { exportNode } from "../lib/exporter";
import { ColorPicker } from "./ColorPicker";
import { Icon } from "./Icon";
import { NumberField } from "./NumberField";

function Section({
  title,
  onAdd,
  children,
}: {
  title: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-zinc-100 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
          {title}
        </span>
        {onAdd && (
          <button
            title={`Add ${title.toLowerCase()}`}
            onClick={onAdd}
            className="flex size-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function PaintRow({
  engine,
  nodeId,
  kind,
  index,
  paint,
}: {
  engine: Engine;
  nodeId: number;
  kind: "fills" | "strokes";
  index: number;
  paint: Paint;
}) {
  const update = (color: string, opacity: number) =>
    engine.update_paint(nodeId, kind, index, color, opacity);
  const [pickerOpen, setPickerOpen] = useState(false);
  const swatchRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="mb-1.5 flex items-center gap-1.5 last:mb-0">
      <button
        ref={swatchRef}
        data-testid={`swatch-${kind}-${index}`}
        title="Edit color"
        onClick={() => setPickerOpen((o) => !o)}
        className="size-7 shrink-0 cursor-pointer rounded-md border border-zinc-200 bg-white p-0.5"
      >
        <span className="block size-full rounded-[4px]" style={{ background: paint.color }} />
      </button>
      {pickerOpen && (
        <ColorPicker
          color={paint.color}
          opacity={paint.opacity}
          anchor={swatchRef.current!.getBoundingClientRect()}
          onGestureStart={() => engine.begin_edit()}
          onLive={(c, o) => engine.update_paint_live(nodeId, kind, index, c, o)}
          onGestureEnd={() => engine.commit_edit()}
          onSet={(c, o) => engine.update_paint(nodeId, kind, index, c, o)}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div className="flex h-7 min-w-0 flex-1 items-center rounded-md bg-zinc-100 px-2 focus-within:ring-1 focus-within:ring-sky-400">
        <input
          key={paint.color}
          defaultValue={paint.color.replace("#", "").toUpperCase()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const hex = e.currentTarget.value.replace("#", "");
            if (/^[0-9a-fA-F]{6}$/.test(hex)) update(`#${hex.toLowerCase()}`, paint.opacity);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            e.stopPropagation();
          }}
          className="w-full bg-transparent font-mono text-[11.5px] text-zinc-800 outline-none"
        />
      </div>
      <div className="flex h-7 w-14 shrink-0 items-center rounded-md bg-zinc-100 px-2 focus-within:ring-1 focus-within:ring-sky-400">
        <input
          key={paint.opacity}
          defaultValue={Math.round(paint.opacity * 100)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const v = parseFloat(e.currentTarget.value);
            if (!Number.isNaN(v)) update(paint.color, Math.min(100, Math.max(0, v)) / 100);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            e.stopPropagation();
          }}
          className="w-full bg-transparent font-mono text-[11.5px] text-zinc-800 outline-none"
        />
        <span className="text-[11px] text-zinc-400">%</span>
      </div>
      <button
        title="Remove"
        onClick={() => engine.remove_paint(nodeId, kind, index)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
      >
        <Icon name="minus" size={12} />
      </button>
    </div>
  );
}

const SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4];

const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

function ExportSection({ engine, node }: { engine: Engine; node: SceneNode }) {
  return (
    <Section title="Export" onAdd={() => engine.add_export_preset(node.id)}>
      {node.exportPresets.map((p, i) => (
        <div key={i} className="mb-1.5 flex items-center gap-1.5">
          <select
            value={p.scale}
            onChange={(e) => engine.set_export_preset(node.id, i, parseFloat(e.target.value), p.format)}
            className="h-7 flex-1 rounded-md bg-zinc-100 px-1.5 text-[11.5px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
          >
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
          <select
            value={p.format}
            onChange={(e) => engine.set_export_preset(node.id, i, p.scale, e.target.value)}
            className="h-7 flex-1 rounded-md bg-zinc-100 px-1.5 text-[11.5px] text-zinc-800 uppercase outline-none focus:ring-1 focus:ring-sky-400"
          >
            <option value="png">PNG</option>
            <option value="svg">SVG</option>
          </select>
          <button
            title="Remove preset"
            onClick={() => engine.remove_export_preset(node.id, i)}
            className="flex size-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <Icon name="minus" size={12} />
          </button>
        </div>
      ))}
      {node.exportPresets.length > 0 && (
        <button
          onClick={() => node.exportPresets.forEach((p) => exportNode(engine, node, p))}
          className="mt-1 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-zinc-200 text-[12px] font-medium text-zinc-700 transition-colors hover:border-sky-300 hover:text-sky-700"
        >
          <Icon name="download" size={12} />
          Export {node.name}
        </button>
      )}
    </Section>
  );
}

export function PropertiesPanel({ engine, scene }: { engine: Engine; scene: Scene }) {
  const selected = scene.selection
    .map((id) => findNode(scene.nodes, id))
    .filter((n): n is SceneNode => n !== null);

  if (selected.length === 0) {
    return (
      <aside className="w-60 shrink-0 border-l border-zinc-200 bg-white">
        <Section title="Design">
          <p className="text-[12px] leading-5 text-zinc-400">
            Select a layer to see its properties.
          </p>
        </Section>
      </aside>
    );
  }

  if (selected.length > 1) {
    const aligns = [
      ["align-left", "left", "Align left"],
      ["align-hcenter", "hcenter", "Align horizontal centers"],
      ["align-right", "right", "Align right"],
      ["align-top", "top", "Align top"],
      ["align-vcenter", "vcenter", "Align vertical centers"],
      ["align-bottom", "bottom", "Align bottom"],
    ] as const;
    return (
      <aside className="w-60 shrink-0 border-l border-zinc-200 bg-white">
        <Section title="Arrange">
          <div className="flex items-center justify-between">
            {aligns.map(([icon, mode, title]) => (
              <button
                key={mode}
                title={title}
                onClick={() => engine.align_selection(mode)}
                className="flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
              >
                <Icon name={icon} size={14} />
              </button>
            ))}
          </div>
          {selected.length >= 3 && (
            <div className="mt-1 flex items-center gap-1">
              <button
                title="Distribute horizontally"
                onClick={() => engine.distribute_selection("h")}
                className="flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
              >
                <Icon name="dist-h" size={14} />
              </button>
              <button
                title="Distribute vertically"
                onClick={() => engine.distribute_selection("v")}
                className="flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
              >
                <Icon name="dist-v" size={14} />
              </button>
            </div>
          )}
        </Section>
        <Section title="Design">
          <p className="text-[12px] text-zinc-500">{selected.length} layers selected</p>
          <p className="mt-1 text-[11px] text-zinc-400">⌘G to group them</p>
        </Section>
      </aside>
    );
  }

  const n = selected[0];
  const common = { engine, nodeId: n.id };
  const isGroup = n.kind === "group";

  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-l border-zinc-200 bg-white">
      <Section title={n.name}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={n.x} field="x" {...common} />
          <NumberField label="Y" value={n.y} field="y" {...common} />
          {!isGroup && (
            <>
              <NumberField label="W" value={n.w} field="w" min={1} {...common} />
              <NumberField label="H" value={n.h} field="h" min={1} {...common} />
            </>
          )}
        </div>
      </Section>

      <Section title="Appearance">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="O"
            suffix="%"
            value={n.opacity * 100}
            scale={0.01}
            min={0}
            max={100}
            field="opacity"
            {...common}
          />
          {(n.kind === "rect" || n.kind === "frame") && (
            <NumberField
              label="R"
              value={n.cornerRadius}
              min={0}
              field="cornerRadius"
              {...common}
            />
          )}
        </div>
        <select
          data-testid="blend-mode"
          value={n.blendMode}
          onChange={(e) => engine.set_blend_mode(n.id, e.target.value)}
          className="mt-2 h-7 w-full rounded-md bg-zinc-100 px-1.5 text-[11.5px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
        >
          {BLEND_MODES.map((m) => (
            <option key={m} value={m}>
              {m.charAt(0).toUpperCase() + m.slice(1).replace("-", " ")}
            </option>
          ))}
        </select>
      </Section>

      {!isGroup && (
        <>
          <Section title="Fill" onAdd={() => engine.add_paint(n.id, "fills")}>
            {n.fills.length === 0 && (
              <p className="text-[11px] text-zinc-400">No fills. Click + to add one.</p>
            )}
            {n.fills.map((p, i) => (
              <PaintRow key={i} engine={engine} nodeId={n.id} kind="fills" index={i} paint={p} />
            ))}
          </Section>

          <Section title="Stroke" onAdd={() => engine.add_paint(n.id, "strokes")}>
            {n.strokes.length === 0 && (
              <p className="text-[11px] text-zinc-400">No strokes. Click + to add one.</p>
            )}
            {n.strokes.map((p, i) => (
              <PaintRow key={i} engine={engine} nodeId={n.id} kind="strokes" index={i} paint={p} />
            ))}
            {n.strokes.length > 0 && (
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <NumberField
                  label="W"
                  value={n.strokeWeight}
                  min={0}
                  field="strokeWeight"
                  {...common}
                />
              </div>
            )}
          </Section>
        </>
      )}

      {n.kind === "text" && (
        <Section title="Text">
          <textarea
            key={n.id}
            defaultValue={n.text}
            onBlur={(e) => engine.set_text(n.id, e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()}
            rows={2}
            className="mb-2 w-full resize-none rounded-md bg-zinc-100 px-2 py-1.5 text-[12px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="S" value={n.fontSize} min={1} field="fontSize" {...common} />
          </div>
        </Section>
      )}

      <ExportSection engine={engine} node={n} />
    </aside>
  );
}
