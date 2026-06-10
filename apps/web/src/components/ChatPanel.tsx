import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../lib/usePresence";
import { Icon } from "./Icon";

interface Props {
  chat: ChatMessage[];
  onSend: (body: string) => void;
}

/** Ephemeral session chat, floating over the canvas (bottom-right).
 * Messages live only as long as the presence session — nothing stored. */
export function ChatPanel({ chat, onSend }: Props) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const seen = useRef(0);

  useEffect(() => {
    if (open) {
      seen.current = chat.length;
      setUnread(0);
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    } else {
      setUnread(chat.length - seen.current);
    }
  }, [chat, open]);

  return (
    <div className="absolute right-4 bottom-4 z-20 flex flex-col items-end gap-2">
      {open && (
        <div
          data-testid="chat-panel"
          className="flex h-72 w-64 flex-col rounded-lg border border-zinc-200 bg-white shadow-xl"
        >
          <div className="border-b border-zinc-100 px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
            Chat
          </div>
          <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
            {chat.length === 0 && (
              <p className="text-[12px] text-zinc-400">
                Say hi — everyone in this file can read along. Messages vanish when you leave.
              </p>
            )}
            {chat.map((m, i) => (
              <div key={i} data-testid="chat-message">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] font-semibold" style={{ color: m.color }}>
                    {m.id === "me" ? "You" : m.name}
                  </span>
                  <span className="text-[10px] text-zinc-300">
                    {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <p className="text-[12px] leading-5 break-words whitespace-pre-wrap text-zinc-800">
                  {m.body}
                </p>
              </div>
            ))}
          </div>
          <form
            className="border-t border-zinc-100 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.querySelector("input")!;
              onSend(input.value);
              input.value = "";
            }}
          >
            <input
              data-testid="chat-input"
              placeholder="Message…"
              onKeyDown={(e) => e.stopPropagation()}
              className="h-7 w-full rounded-md bg-zinc-100 px-2 text-[12px] text-zinc-800 outline-none focus:ring-1 focus:ring-sky-400"
            />
          </form>
        </div>
      )}
      <button
        data-testid="chat-toggle"
        title="Session chat"
        onClick={() => setOpen((o) => !o)}
        className={`relative flex size-10 items-center justify-center rounded-full border shadow-md transition-colors ${
          open
            ? "border-sky-500 bg-sky-500 text-white"
            : "border-zinc-200 bg-white text-zinc-600 hover:text-zinc-900"
        }`}
      >
        <Icon name="comment" size={16} />
        {unread > 0 && !open && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        )}
      </button>
    </div>
  );
}
