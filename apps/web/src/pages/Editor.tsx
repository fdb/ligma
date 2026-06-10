import { useCallback, useRef, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { CanvasView } from "../components/CanvasView";
import { LayersPanel } from "../components/LayersPanel";
import { PropertiesPanel } from "../components/PropertiesPanel";
import { TopBar, type SaveState } from "../components/TopBar";
import { useEngine } from "../engine/useEngine";

const route = getRouteApi("/d/$docId");

export function Editor() {
  const { docId } = route.useParams();
  const { engine, scene, notFound } = useEngine(docId);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  const onSave = useCallback(async () => {
    if (!engine) return;
    setSaveState("saving");
    try {
      const res = await fetch(`/api/documents/${docId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: engine.to_json(),
      });
      setSaveState(res.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
    setTimeout(() => setSaveState("idle"), 1500);
  }, [engine, docId]);

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-50 font-sans text-zinc-500">
        <p>
          No document at <span className="font-mono text-[12px]">{docId}</span>.
        </p>
        <Link to="/" className="font-semibold text-sky-600 hover:text-sky-700">
          Back to your files
        </Link>
      </div>
    );
  }

  if (!engine || !scene) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-50 font-sans text-zinc-400">
        <div className="flex items-center gap-3">
          <div className="size-2 animate-pulse rounded-full bg-sky-500" />
          Loading Ligma…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white font-sans text-[13px] text-zinc-800">
      <TopBar
        engine={engine}
        scene={scene}
        docId={docId}
        saveState={saveState}
        onSave={onSave}
        viewport={() => ({
          w: canvasWrapRef.current?.clientWidth ?? 0,
          h: canvasWrapRef.current?.clientHeight ?? 0,
        })}
      />
      <div className="flex min-h-0 flex-1">
        <LayersPanel engine={engine} scene={scene} />
        <CanvasView engine={engine} scene={scene} onSave={onSave} wrapRef={canvasWrapRef} />
        <PropertiesPanel engine={engine} scene={scene} />
      </div>
    </div>
  );
}
