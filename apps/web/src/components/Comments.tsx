import { useState } from "react";
import type { CommentRow } from "../lib/useComments";
import type { Scene } from "../types";

interface Props {
  scene: Scene;
  comments: CommentRow[];
  mode: boolean; // comment tool active: clicks place a new pin
  onExitMode: () => void;
  onAdd: (x: number, y: number, body: string) => void;
  onResolve: (id: string) => void;
}

/** Comment pins + popovers, drawn over the canvas in screen space. */
export function CommentsLayer({ scene, comments, mode, onExitMode, onAdd, onResolve }: Props) {
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null); // world
  const [openId, setOpenId] = useState<string | null>(null);

  const toScreen = (x: number, y: number) => ({
    left: x * scene.zoom + scene.panX,
    top: y * scene.zoom + scene.panY,
  });
  const open = openId ? comments.find((c) => c.id === openId) : null;

  return (
    <>
      {mode && (
        <div
          data-testid="comment-catcher"
          className="absolute inset-0 z-10 cursor-crosshair"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setDraft({
              x: (e.clientX - r.left - scene.panX) / scene.zoom,
              y: (e.clientY - r.top - scene.panY) / scene.zoom,
            });
          }}
        />
      )}

      {comments
        .filter((c) => !c.resolved)
        .map((c) => {
          const p = toScreen(c.x, c.y);
          return (
            <button
              key={c.id}
              data-testid="comment-pin"
              title={`${c.author}: ${c.body.slice(0, 60)}`}
              onClick={() => setOpenId(openId === c.id ? null : c.id)}
              className="absolute z-20 flex size-6 -translate-y-full items-center justify-center rounded-tl-full rounded-tr-full rounded-br-full border-2 border-white text-[11px] font-bold text-white shadow-md"
              style={{ ...p, background: c.color }}
            >
              {c.author.replace(/^Guest\s*/, "").charAt(0) || "?"}
            </button>
          );
        })}

      {open && (
        <div
          data-testid="comment-popover"
          className="absolute z-30 w-56 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl"
          style={toScreen(open.x + 8 / scene.zoom, open.y)}
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: open.color }} />
            <span className="text-[11px] font-semibold text-zinc-700">{open.author}</span>
            <span className="text-[10px] text-zinc-400">
              {open.created_at.replace(/:\d+$/, "")}
            </span>
          </div>
          <p className="text-[12px] leading-5 whitespace-pre-wrap text-zinc-800">{open.body}</p>
          <button
            onClick={() => {
              onResolve(open.id);
              setOpenId(null);
            }}
            className="mt-2 h-6 rounded-md border border-zinc-200 px-2 text-[11px] font-medium text-zinc-600 hover:border-sky-300 hover:text-sky-700"
          >
            Resolve
          </button>
        </div>
      )}

      {draft && (
        <div
          className="absolute z-30 w-60 rounded-lg border border-zinc-200 bg-white p-2 shadow-xl"
          style={toScreen(draft.x, draft.y)}
        >
          <textarea
            autoFocus
            data-testid="comment-input"
            placeholder="Add a comment…"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.currentTarget
                  .closest("div")!
                  .querySelector<HTMLButtonElement>("[data-post]")!
                  .click();
              }
              e.stopPropagation();
            }}
            className="w-full resize-none rounded-md bg-zinc-100 px-2 py-1.5 text-[12px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              onClick={() => {
                setDraft(null);
                onExitMode();
              }}
              className="h-6 rounded-md px-2 text-[11px] text-zinc-500 hover:bg-zinc-100"
            >
              Cancel
            </button>
            <button
              data-post
              data-testid="comment-post"
              onClick={(e) => {
                const body = e.currentTarget
                  .closest("div")!
                  .parentElement!.querySelector("textarea")!
                  .value.trim();
                if (body) onAdd(draft.x, draft.y, body);
                setDraft(null);
                onExitMode();
              }}
              className="h-6 rounded-md bg-sky-500 px-2.5 text-[11px] font-semibold text-white hover:bg-sky-600"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </>
  );
}
