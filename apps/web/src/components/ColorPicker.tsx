import { useEffect, useRef, useState } from "react";
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "../lib/color";

interface Props {
  color: string; // #rrggbb
  opacity: number; // 0..1
  anchor: DOMRect; // swatch rect; the popover opens to its left
  onGestureStart: () => void; // begin_edit (coalesce the drag into one undo)
  onLive: (color: string, opacity: number) => void;
  onGestureEnd: () => void; // commit_edit
  onSet: (color: string, opacity: number) => void; // one-shot (hex, eyedrop)
  onClose: () => void;
}

const CHECKER =
  "repeating-conic-gradient(#e4e4e7 0% 25%, #ffffff 0% 50%) 0 / 8px 8px";

/** Figma-style popover color picker: SV square, hue + opacity sliders,
 * hex input, and a canvas eyedropper. */
export function ColorPicker({
  color,
  opacity,
  anchor,
  onGestureStart,
  onLive,
  onGestureEnd,
  onSet,
  onClose,
}: Props) {
  // HSV lives locally so hue survives s=0 / v=0 (a gray hex collapses h).
  const [[h, s, v], setHsv] = useState(() => rgbToHsv(...hexToRgb(color)));
  const [alpha, setAlpha] = useState(opacity);
  const [picking, setPicking] = useState(false);
  const [probe, setProbe] = useState<{ x: number; y: number; color: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const hex = rgbToHex(...hsvToRgb(h, s, v));

  // Close on outside pointerdown or Escape (unless eyedropping).
  useEffect(() => {
    if (picking) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, picking]);

  // Eyedropper: sample the editor canvas under the cursor.
  useEffect(() => {
    if (!picking) return;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) {
      setPicking(false);
      return;
    }
    const sample = (e: PointerEvent): string | null => {
      const r = canvas.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom)
        return null;
      const dpr = canvas.width / r.width;
      const d = canvas
        .getContext("2d")!
        .getImageData((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, 1, 1).data;
      return rgbToHex(d[0], d[1], d[2]);
    };
    const onMove = (e: PointerEvent) => {
      const c = sample(e);
      setProbe(c ? { x: e.clientX, y: e.clientY, color: c } : null);
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const c = sample(e);
      if (c) {
        setHsv(rgbToHsv(...hexToRgb(c)));
        onSet(c, alpha);
      }
      setPicking(false);
      setProbe(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPicking(false);
        setProbe(null);
      }
    };
    document.body.style.cursor = "crosshair";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picking, alpha, onSet]);

  /** Shared drag plumbing: capture the pointer, map positions through
   * `apply`, and bracket the gesture for undo coalescing. */
  const dragHandler =
    (apply: (e: React.PointerEvent | PointerEvent, el: HTMLElement) => void) =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      onGestureStart();
      apply(e, el);
      const move = (ev: PointerEvent) => apply(ev, el);
      const up = () => {
        onGestureEnd();
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    };

  const frac = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return {
      fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      fy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const onSvDrag = dragHandler((e, el) => {
    const { fx, fy } = frac(e, el);
    const next: [number, number, number] = [h, fx, 1 - fy];
    setHsv(next);
    onLive(rgbToHex(...hsvToRgb(...next)), alpha);
  });

  const onHueDrag = dragHandler((e, el) => {
    const { fx } = frac(e, el);
    const next: [number, number, number] = [fx * 360, s, v];
    setHsv(next);
    onLive(rgbToHex(...hsvToRgb(...next)), alpha);
  });

  const onAlphaDrag = dragHandler((e, el) => {
    const { fx } = frac(e, el);
    setAlpha(fx);
    onLive(hex, fx);
  });

  const width = 232;
  const left = Math.max(8, anchor.left - width - 12);
  const top = Math.min(Math.max(8, anchor.top - 60), window.innerHeight - 330);

  return (
    <div
      ref={ref}
      data-testid="color-picker"
      className="fixed z-50 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl"
      style={{ left, top, width }}
    >
      <div
        data-testid="sv-square"
        onPointerDown={onSvDrag}
        className="relative h-36 w-full cursor-crosshair touch-none rounded-md"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))`,
        }}
      >
        <div
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: hex }}
        />
      </div>

      <div className="mt-3 flex items-center gap-2.5">
        <button
          title="Pick color from canvas"
          onClick={() => setPicking(true)}
          className={`flex size-8 shrink-0 items-center justify-center rounded-md border ${
            picking
              ? "border-sky-400 bg-sky-50 text-sky-600"
              : "border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9.5 3.5l3 3M11 2l3 3-7.5 7.5L3 13l.5-3.5L11 2z" />
          </svg>
        </button>
        <div className="flex flex-1 flex-col gap-2">
          <div
            data-testid="hue-slider"
            onPointerDown={onHueDrag}
            className="relative h-3 cursor-ew-resize touch-none rounded-full"
            style={{
              background:
                "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
            }}
          >
            <div
              className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: `${(h / 360) * 100}%`, background: `hsl(${h}, 100%, 50%)` }}
            />
          </div>
          <div
            data-testid="alpha-slider"
            onPointerDown={onAlphaDrag}
            className="relative h-3 cursor-ew-resize touch-none rounded-full"
            style={{ background: CHECKER }}
          >
            <div
              className="absolute inset-0 rounded-full"
              style={{ background: `linear-gradient(to right, transparent, ${hex})` }}
            />
            <div
              className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: `${alpha * 100}%`, background: hex }}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-md bg-zinc-100 px-2 focus-within:ring-1 focus-within:ring-sky-400">
          <span className="mr-1 text-[11px] text-zinc-400">#</span>
          <input
            key={hex}
            data-testid="picker-hex"
            defaultValue={hex.replace("#", "").toUpperCase()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const raw = e.currentTarget.value.replace("#", "");
              if (/^[0-9a-fA-F]{6}$/.test(raw)) {
                const next = `#${raw.toLowerCase()}`;
                setHsv(rgbToHsv(...hexToRgb(next)));
                onSet(next, alpha);
              }
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
            key={alpha}
            defaultValue={Math.round(alpha * 100)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const p = parseFloat(e.currentTarget.value);
              if (!Number.isNaN(p)) {
                const next = Math.min(100, Math.max(0, p)) / 100;
                setAlpha(next);
                onSet(hex, next);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              e.stopPropagation();
            }}
            className="w-full bg-transparent font-mono text-[11.5px] text-zinc-800 outline-none"
          />
          <span className="text-[11px] text-zinc-400">%</span>
        </div>
      </div>

      {picking && probe && (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white py-1 pr-2 pl-1 shadow-lg"
          style={{ left: probe.x + 14, top: probe.y + 14 }}
        >
          <span className="size-4 rounded-sm border border-zinc-200" style={{ background: probe.color }} />
          <span className="font-mono text-[10.5px] text-zinc-600">{probe.color.toUpperCase()}</span>
        </div>
      )}
    </div>
  );
}
