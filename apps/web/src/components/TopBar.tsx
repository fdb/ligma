import { useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Engine } from "../engine/pkg/ligma_core";
import { placementSize, uploadImage } from "../lib/images";
import type { Scene, Tool } from "../types";
import { Icon } from "./Icon";
import { MenuBar, type Menu } from "./MenuBar";

const tools: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "select", icon: "select", label: "Move", key: "V" },
  { id: "frame", icon: "frame", label: "Frame", key: "F" },
  { id: "rect", icon: "rect", label: "Rectangle", key: "R" },
  { id: "ellipse", icon: "ellipse", label: "Ellipse", key: "O" },
  { id: "pen", icon: "pen", label: "Pen", key: "P" },
  { id: "text", icon: "text", label: "Text", key: "T" },
  { id: "hand", icon: "hand", label: "Hand", key: "H" },
];

export type SaveState = "idle" | "saving" | "saved" | "error";

interface Props {
  engine: Engine;
  scene: Scene;
  docName: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  dirty: boolean;
  onSave: () => void;
  commentMode: boolean;
  onToggleCommentMode: () => void;
  viewport: () => { w: number; h: number };
}

export function TopBar({
  engine,
  scene,
  docName,
  onRename,
  saveState,
  dirty,
  onSave,
  commentMode,
  onToggleCommentMode,
  viewport,
}: Props) {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const zoomAroundCenter = (zoom: number) => {
    const { w, h } = viewport();
    engine.set_zoom(zoom, w / 2, h / 2);
  };

  const placeImage = async (file: File) => {
    const up = await uploadImage(file);
    if (!up) return;
    const { w, h } = placementSize(up.width, up.height);
    const vp = viewport();
    const wx = (vp.w / 2 - scene.panX) / scene.zoom - w / 2;
    const wy = (vp.h / 2 - scene.panY) / scene.zoom - h / 2;
    engine.add_image(up.hash, wx, wy, w, h);
  };

  const single = scene.selection.length === 1;
  const multi = scene.selection.length >= 2;
  const align = (mode: string) => ({
    label: `Align ${mode === "hcenter" ? "horizontal centers" : mode === "vcenter" ? "vertical centers" : mode}`,
    disabled: !multi,
    action: () => engine.align_selection(mode),
  });

  const menus: Menu[] = [
    {
      title: "File",
      items: [
        {
          label: "New design file",
          action: async () => {
            const res = await fetch("/api/documents", { method: "POST" });
            const { id } = (await res.json()) as { id: string };
            navigate({ to: "/d/$docId", params: { docId: id } });
          },
        },
        { label: "Place image…", action: () => fileInput.current?.click() },
        { label: "Save", shortcut: "⌘S", action: onSave },
      ],
    },
    {
      title: "Edit",
      items: [
        { label: "Undo", shortcut: "⌘Z", action: () => engine.undo() },
        { label: "Redo", shortcut: "⇧⌘Z", action: () => engine.redo() },
        "---",
        {
          label: "Copy",
          shortcut: "⌘C",
          disabled: scene.selection.length === 0,
          action: () => engine.copy_selection(),
        },
        {
          label: "Cut",
          shortcut: "⌘X",
          disabled: scene.selection.length === 0,
          action: () => engine.cut_selection(),
        },
        {
          label: "Paste",
          shortcut: "⌘V",
          disabled: engine.clipboard_len() === 0,
          action: () => engine.paste_clipboard(),
        },
        {
          label: "Duplicate",
          shortcut: "⌘D",
          disabled: scene.selection.length === 0,
          action: () => engine.duplicate_selection(),
        },
        {
          label: "Delete",
          shortcut: "⌫",
          disabled: scene.selection.length === 0,
          action: () => engine.delete_selection(),
        },
        "---",
        {
          label: "Copy as SVG",
          disabled: !single,
          action: () => navigator.clipboard.writeText(engine.export_svg(scene.selection[0])),
        },
      ],
    },
    {
      title: "View",
      items: [
        { label: "Zoom in", action: () => zoomAroundCenter(scene.zoom * 1.25) },
        { label: "Zoom out", action: () => zoomAroundCenter(scene.zoom / 1.25) },
        {
          label: "Zoom to 100%",
          shortcut: "⌘0",
          action: () => zoomAroundCenter(1),
        },
        {
          label: "Zoom to fit",
          shortcut: "⇧1",
          action: () => {
            const { w, h } = viewport();
            engine.zoom_to_fit(w, h);
          },
        },
      ],
    },
    {
      title: "Object",
      items: [
        {
          label: "Bring to front",
          shortcut: "⌘]",
          disabled: scene.selection.length === 0,
          action: () => engine.bring_to_front(),
        },
        {
          label: "Send to back",
          shortcut: "⌘[",
          disabled: scene.selection.length === 0,
          action: () => engine.send_to_back(),
        },
        "---",
        {
          label: "Group selection",
          shortcut: "⌘G",
          disabled: !multi,
          action: () => engine.group_selection(),
        },
        {
          label: "Ungroup",
          shortcut: "⇧⌘G",
          disabled: scene.selection.length === 0,
          action: () => engine.ungroup_selection(),
        },
        "---",
        align("left"),
        align("hcenter"),
        align("right"),
        align("top"),
        align("vcenter"),
        align("bottom"),
        "---",
        {
          label: "Distribute horizontally",
          disabled: scene.selection.length < 3,
          action: () => engine.distribute_selection("h"),
        },
        {
          label: "Distribute vertically",
          disabled: scene.selection.length < 3,
          action: () => engine.distribute_selection("v"),
        },
      ],
    },
  ];

  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-3">
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        data-testid="image-input"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) placeImage(file);
          e.currentTarget.value = "";
        }}
      />
      <div className="flex items-center gap-2.5">
        <Link
          to="/"
          title="Back to your files"
          className="flex size-7 items-center justify-center rounded-md bg-sky-500 text-white shadow-sm transition-colors hover:bg-sky-600"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
            <path d="M3 1.5h2.5v8.5H11v2.5H3z" />
          </svg>
        </Link>
        <div className="leading-tight">
          <div className="font-semibold tracking-tight text-zinc-900">Ligma</div>
          <input
            key={docName}
            data-testid="doc-name"
            defaultValue={docName}
            placeholder="Untitled"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const name = e.currentTarget.value.trim();
              if (name && name !== docName) onRename(name);
              else e.currentTarget.value = docName;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = docName;
                e.currentTarget.blur();
              }
              e.stopPropagation();
            }}
            className="-mx-1 w-36 truncate rounded-sm px-1 text-[11px] text-zinc-400 outline-none hover:bg-zinc-100 focus:bg-white focus:text-zinc-700 focus:ring-1 focus:ring-sky-400"
          />
        </div>
        <div className="ml-2 border-l border-zinc-200 pl-2">
          <MenuBar menus={menus} />
        </div>
      </div>

      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 shadow-sm">
        <button
          title="Comment (C)"
          data-testid="comment-tool"
          onClick={onToggleCommentMode}
          className={`flex size-8 items-center justify-center rounded-md transition-colors ${
            commentMode
              ? "bg-sky-500 text-white"
              : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          }`}
        >
          <Icon name="comment" />
        </button>
        <div className="mx-0.5 h-5 border-l border-zinc-200" />
        {tools.map((t) => (
          <button
            key={t.id}
            title={`${t.label} (${t.key})`}
            onClick={() => engine.set_tool(t.id)}
            className={`flex size-8 items-center justify-center rounded-md transition-colors ${
              scene.tool === t.id
                ? "bg-sky-500 text-white"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            <Icon name={t.icon} />
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-md border border-zinc-200">
          <button
            title="Zoom out"
            onClick={() => zoomAroundCenter(scene.zoom / 1.25)}
            className="flex size-7 items-center justify-center rounded-l-md text-zinc-500 hover:bg-zinc-100"
          >
            <Icon name="minus" size={14} />
          </button>
          <span className="w-12 text-center font-mono text-[11px] text-zinc-600">
            {Math.round(scene.zoom * 100)}%
          </span>
          <button
            title="Zoom in"
            onClick={() => zoomAroundCenter(scene.zoom * 1.25)}
            className="flex size-7 items-center justify-center text-zinc-500 hover:bg-zinc-100"
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            title="Zoom to fit (Shift+1)"
            onClick={() => {
              const { w, h } = viewport();
              engine.zoom_to_fit(w, h);
            }}
            className="flex size-7 items-center justify-center rounded-r-md border-l border-zinc-200 text-zinc-500 hover:bg-zinc-100"
          >
            <Icon name="fit" size={14} />
          </button>
        </div>
        <button
          onClick={onSave}
          disabled={saveState === "saving"}
          className="h-7 rounded-md bg-sky-500 px-3 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-sky-600 disabled:opacity-60"
        >
          {saveState === "saving"
            ? "Saving…"
            : saveState === "saved"
              ? "Saved ✓"
              : saveState === "error"
                ? "Retry save"
                : dirty
                  ? "Save"
                  : "Saved"}
        </button>
      </div>
    </header>
  );
}
