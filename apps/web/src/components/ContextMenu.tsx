import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuItem } from "./MenuBar";

interface Props {
  x: number;
  y: number;
  items: (MenuItem | "---")[];
  onClose: () => void;
}

/** Right-click menu; same visual language as the MenuBar dropdowns. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 4),
      y: Math.min(y, window.innerHeight - r.height - 4),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-testid="context-menu"
      className="fixed z-50 min-w-52 rounded-lg border border-zinc-200 bg-white py-1.5 shadow-lg"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "---" ? (
          <div key={i} className="mx-3 my-1.5 border-t border-zinc-100" />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action();
            }}
            className="flex h-7 w-full items-center justify-between gap-6 px-3 text-left text-[12.5px] text-zinc-700 hover:bg-sky-500 hover:text-white disabled:pointer-events-none disabled:text-zinc-300"
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="text-[11px] tracking-wide opacity-50">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
