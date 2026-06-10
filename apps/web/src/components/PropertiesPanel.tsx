import { useEffect, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import type { Scene, SceneNode } from "../types";

function Field({
  label,
  value,
  onCommit,
  suffix,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  suffix?: string;
}) {
  const display = String(Math.round(value * 100) / 100);
  const [draft, setDraft] = useState(display);
  useEffect(() => setDraft(display), [display]);

  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isNaN(v) && v !== value) onCommit(v);
    else setDraft(display);
  };

  return (
    <label className="flex h-7 items-center rounded-md bg-zinc-100 px-2 focus-within:ring-1 focus-within:ring-sky-400">
      <span className="w-4 shrink-0 text-[11px] text-zinc-400">{label}</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const delta = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
            onCommit((parseFloat(draft) || 0) + delta);
          }
          e.stopPropagation();
        }}
        className="w-full bg-transparent font-mono text-[11.5px] text-zinc-800 outline-none"
      />
      {suffix && <span className="text-[11px] text-zinc-400">{suffix}</span>}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-100 px-4 py-3">
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

export function PropertiesPanel({ engine, scene }: { engine: Engine; scene: Scene }) {
  const selected: SceneNode[] = scene.nodes.filter((n) => scene.selection.includes(n.id));

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
    return (
      <aside className="w-60 shrink-0 border-l border-zinc-200 bg-white">
        <Section title="Design">
          <p className="text-[12px] text-zinc-500">{selected.length} layers selected</p>
        </Section>
      </aside>
    );
  }

  const n = selected[0];

  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-l border-zinc-200 bg-white">
      <Section title={n.name}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="X" value={n.x} onCommit={(v) => engine.set_field(n.id, "x", v)} />
          <Field label="Y" value={n.y} onCommit={(v) => engine.set_field(n.id, "y", v)} />
          <Field label="W" value={n.w} onCommit={(v) => engine.set_field(n.id, "w", v)} />
          <Field label="H" value={n.h} onCommit={(v) => engine.set_field(n.id, "h", v)} />
        </div>
      </Section>

      <Section title="Appearance">
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="O"
            suffix="%"
            value={n.opacity * 100}
            onCommit={(v) => engine.set_field(n.id, "opacity", v / 100)}
          />
          {(n.kind === "rect" || n.kind === "frame") && (
            <Field
              label="R"
              value={n.cornerRadius}
              onCommit={(v) => engine.set_field(n.id, "cornerRadius", v)}
            />
          )}
        </div>
      </Section>

      <Section title="Fill">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={n.fill}
            onChange={(e) => engine.set_fill(n.id, e.target.value)}
            className="size-7 cursor-pointer rounded-md border border-zinc-200 bg-white p-0.5"
          />
          <div className="flex h-7 flex-1 items-center rounded-md bg-zinc-100 px-2 focus-within:ring-1 focus-within:ring-sky-400">
            <input
              key={n.fill}
              defaultValue={n.fill.replace("#", "").toUpperCase()}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                const hex = e.currentTarget.value.replace("#", "");
                if (/^[0-9a-fA-F]{6}$/.test(hex)) engine.set_fill(n.id, `#${hex.toLowerCase()}`);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                e.stopPropagation();
              }}
              className="w-full bg-transparent font-mono text-[11.5px] text-zinc-800 outline-none"
            />
          </div>
        </div>
      </Section>

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
            <Field
              label="S"
              value={n.fontSize}
              onCommit={(v) => engine.set_field(n.id, "fontSize", v)}
            />
          </div>
        </Section>
      )}
    </aside>
  );
}
