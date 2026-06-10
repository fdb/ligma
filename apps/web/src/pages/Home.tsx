import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Icon } from "../components/Icon";

interface DocMeta {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  current_version: number;
  size: number;
}

function timeAgo(sqlDate: string): string {
  // D1's datetime('now') is UTC without a timezone suffix.
  const then = new Date(`${sqlDate.replace(" ", "T")}Z`).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (24 * 60))}d ago`;
}

export function Home() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/documents")
      .then((r) => (r.ok ? r.json() : []))
      .then(setDocs)
      .catch(() => setDocs([]));
  }, []);

  const createDocument = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/documents", { method: "POST" });
      const { id } = (await res.json()) as { id: string };
      navigate({ to: "/d/$docId", params: { docId: id } });
    } catch {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-full bg-zinc-50 font-sans text-[13px] text-zinc-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header className="mb-12 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-sky-500 text-white shadow-sm">
            <svg width="18" height="18" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
              <path d="M3 1.5h2.5v8.5H11v2.5H3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">Ligma</h1>
            <p className="text-zinc-400">Design files, light as air.</p>
          </div>
        </header>

        <button
          onClick={createDocument}
          disabled={creating}
          className="mb-12 flex w-full items-center gap-4 rounded-xl border border-zinc-200 bg-white p-5 text-left shadow-sm transition-all hover:border-sky-300 hover:shadow disabled:opacity-60"
        >
          <span className="flex size-10 items-center justify-center rounded-lg bg-sky-50 text-sky-500">
            <Icon name="plus" />
          </span>
          <span>
            <span className="block text-[14px] font-semibold text-zinc-900">
              {creating ? "Creating…" : "New design file"}
            </span>
            <span className="text-zinc-400">Start from a blank canvas. No account needed.</span>
          </span>
        </button>

        <h2 className="mb-3 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
          Recent files
        </h2>
        {docs === null ? (
          <p className="py-2 text-zinc-400">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-zinc-400">
            Nothing here yet — your files will show up here once you create one.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            {docs.map((d) => (
              <li key={d.id} className="border-b border-zinc-100 last:border-b-0">
                <Link
                  to="/d/$docId"
                  params={{ docId: d.id }}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-sky-50/60"
                >
                  <span className="text-zinc-400">
                    <Icon name="frame" size={14} />
                  </span>
                  <span className="flex-1 truncate font-medium text-zinc-800">{d.name}</span>
                  <span className="font-mono text-[11px] text-zinc-400">
                    {d.current_version === 0 ? "empty" : `v${d.current_version}`}
                  </span>
                  <span className="w-20 text-right text-zinc-400">{timeAgo(d.updated_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
