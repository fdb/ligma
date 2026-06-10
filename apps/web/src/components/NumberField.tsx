import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine/pkg/ligma_core";
import { evaluateExpression } from "../lib/expression";

interface Props {
  label: string;
  suffix?: string;
  /** Display-space value; the engine stores value * scale. */
  value: number;
  scale?: number;
  min?: number;
  max?: number;
  engine: Engine;
  nodeId: number;
  field: string;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/**
 * A Figma-style number control: type plain numbers or expressions (12*2,
 * (4+5)*3, 50%), nudge with arrow keys, or scrub by dragging the label —
 * pointer-captured, 1/px (shift = 10/px, alt = 0.1/px). A whole scrub
 * coalesces into a single undo step via the engine's edit transaction.
 */
export function NumberField({
  label,
  suffix,
  value,
  scale = 1,
  min = -Infinity,
  max = Infinity,
  engine,
  nodeId,
  field,
}: Props) {
  const display = fmt(value);
  const [draft, setDraft] = useState(display);
  useEffect(() => setDraft(display), [display]);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrub = useRef<{ downX: number; lastX: number; acc: number; started: boolean } | null>(
    null,
  );

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const stepFor = (e: { shiftKey: boolean; altKey: boolean }) =>
    e.shiftKey ? 10 : e.altKey ? 0.1 : 1;

  const commitTyped = (raw: string) => {
    const v = evaluateExpression(raw);
    if (v === null || fmt(clamp(v)) === display) {
      setDraft(display);
      return;
    }
    engine.set_field(nodeId, field, clamp(v) * scale);
  };

  const nudge = (e: React.KeyboardEvent, dir: 1 | -1) => {
    const base = evaluateExpression(draft) ?? value;
    engine.set_field(nodeId, field, clamp(base + dir * stepFor(e)) * scale);
  };

  return (
    <label className="flex h-7 items-center rounded-md bg-zinc-100 px-2 focus-within:ring-1 focus-within:ring-sky-400">
      <span
        data-scrub={field}
        className="w-4 shrink-0 cursor-ew-resize text-[11px] text-zinc-400 select-none"
        // Block label activation: a click on the label would focus the
        // input even after a scrub, stealing subsequent keyboard input.
        onClick={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub.current = { downX: e.clientX, lastX: e.clientX, acc: value, started: false };
        }}
        onPointerMove={(e) => {
          const s = scrub.current;
          if (!s) return;
          if (!s.started) {
            if (Math.abs(e.clientX - s.downX) < 3) return;
            s.started = true;
            engine.begin_edit();
            document.body.style.cursor = "ew-resize";
          }
          const dx = e.clientX - s.lastX;
          s.lastX = e.clientX;
          // Clamp the accumulator itself so reversing direction takes
          // effect immediately after hitting a bound.
          s.acc = clamp(s.acc + dx * stepFor(e));
          engine.set_field_live(nodeId, field, s.acc * scale);
        }}
        onPointerUp={() => {
          const s = scrub.current;
          scrub.current = null;
          if (s?.started) {
            engine.commit_edit();
            document.body.style.cursor = "";
          } else {
            inputRef.current?.focus();
          }
        }}
        onPointerCancel={() => {
          if (scrub.current?.started) {
            engine.commit_edit();
            document.body.style.cursor = "";
          }
          scrub.current = null;
        }}
      >
        {label}
      </span>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commitTyped(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(display);
            e.currentTarget.blur();
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            nudge(e, e.key === "ArrowUp" ? 1 : -1);
          }
          e.stopPropagation();
        }}
        className="w-full bg-transparent font-mono text-[11.5px] text-zinc-800 outline-none"
      />
      {suffix && <span className="text-[11px] text-zinc-400">{suffix}</span>}
    </label>
  );
}
