import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

export interface Menu {
  title: string;
  items: (MenuItem | "---")[];
}

/** Classic Mac-style menu bar: click to open, hover to switch menus. */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="flex items-center">
      {menus.map((menu, i) => (
        <div key={menu.title} className="relative">
          <button
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => open !== null && setOpen(i)}
            className={`h-7 rounded-md px-2.5 text-[12.5px] ${
              open === i ? "bg-sky-500 text-white" : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {menu.title}
          </button>
          {open === i && (
            <div className="absolute top-8 left-0 z-50 min-w-52 rounded-lg border border-zinc-200 bg-white py-1.5 shadow-lg">
              {menu.items.map((item, j) =>
                item === "---" ? (
                  <div key={j} className="mx-3 my-1.5 border-t border-zinc-100" />
                ) : (
                  <button
                    key={j}
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
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
          )}
        </div>
      ))}
    </div>
  );
}
