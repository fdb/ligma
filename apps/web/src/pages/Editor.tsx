import { useCallback, useEffect, useRef, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { CanvasView } from "../components/CanvasView";
import { ChatPanel } from "../components/ChatPanel";
import { LayersPanel } from "../components/LayersPanel";
import { PropertiesPanel } from "../components/PropertiesPanel";
import { TopBar, type SaveState } from "../components/TopBar";
import { useEngine } from "../engine/useEngine";
import { useComments } from "../lib/useComments";
import { usePresence } from "../lib/usePresence";

const route = getRouteApi("/d/$docId");

export function Editor() {
  const { docId } = route.useParams();
  const { engine, scene, notFound } = useEngine(docId);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [docName, setDocName] = useState("");
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/documents/${docId}/meta`)
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => meta && setDocName(meta.name))
      .catch(() => {});
  }, [docId]);

  useEffect(() => {
    document.title = docName ? `${docName} – Ligma` : "Ligma";
    return () => {
      document.title = "Ligma";
    };
  }, [docName]);

  const onRename = useCallback(
    (name: string) => {
      setDocName(name);
      fetch(`/api/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).catch(() => {});
    },
    [docId],
  );

  const savedGen = useRef<number | null>(null);

  // Another editor saved a new version: refresh our copy, but never
  // clobber unsaved local changes (last writer wins on the next save).
  const onRemoteVersion = useCallback(async () => {
    if (!engine) return;
    if (savedGen.current === null || engine.doc_generation() !== savedGen.current) return;
    try {
      const res = await fetch(`/api/documents/${docId}`);
      if (!res.ok) return;
      engine.load_json(await res.text());
      savedGen.current = engine.doc_generation();
    } catch {
      /* next version event retries */
    }
  }, [engine, docId]);

  const [commentMode, setCommentMode] = useState(false);
  const { comments, addComment, resolveComment, refetch } = useComments(docId);
  const { peers, chat, sendChat, reportCursor, sessionId } = usePresence(
    docId,
    onRemoteVersion,
    refetch,
  );
  const toggleCommentMode = useCallback(() => setCommentMode((m) => !m), []);

  const onSave = useCallback(async () => {
    if (!engine) return;
    const gen = engine.doc_generation();
    // Nothing changed since the last save — don't write another version.
    if (savedGen.current !== null && gen === savedGen.current) {
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
      return;
    }
    setSaveState("saving");
    try {
      const res = await fetch(
        `/api/documents/${docId}?session=${sessionId.current ?? ""}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: engine.to_json(),
        },
      );
      if (res.ok) savedGen.current = gen;
      setSaveState(res.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
    setTimeout(() => setSaveState("idle"), 1500);
  }, [engine, docId, sessionId]);

  // Autosave: any document mutation (doc_generation, which ignores
  // hover/selection/camera) schedules a debounced save.
  const docGen = scene?.docGeneration;
  useEffect(() => {
    if (!engine || docGen === undefined) return;
    if (savedGen.current === null) {
      savedGen.current = docGen; // baseline right after load
      return;
    }
    if (docGen === savedGen.current) return;
    const t = setTimeout(onSave, 1500);
    return () => clearTimeout(t);
  }, [engine, docGen, onSave]);

  // Flush unsaved changes when leaving — closing the tab or navigating
  // back to the file browser (SPA unmount).
  useEffect(() => {
    if (!engine) return;
    const flush = () => {
      if (savedGen.current !== null && engine.doc_generation() !== savedGen.current) {
        savedGen.current = engine.doc_generation();
        fetch(`/api/documents/${docId}?session=${sessionId.current ?? ""}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: engine.to_json(),
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [engine, docId]);

  const dirty =
    scene !== null && savedGen.current !== null && scene.docGeneration !== savedGen.current;

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
    <div className="relative flex h-full flex-col bg-white font-sans text-[13px] text-zinc-800">
      <TopBar
        engine={engine}
        scene={scene}
        commentMode={commentMode}
        onToggleCommentMode={toggleCommentMode}
        docName={docName}
        onRename={onRename}
        saveState={saveState}
        dirty={dirty}
        onSave={onSave}
        viewport={() => ({
          w: canvasWrapRef.current?.clientWidth ?? 0,
          h: canvasWrapRef.current?.clientHeight ?? 0,
        })}
      />
      <div className="flex min-h-0 flex-1">
        <LayersPanel engine={engine} scene={scene} />
        <CanvasView
          engine={engine}
          scene={scene}
          onSave={onSave}
          wrapRef={canvasWrapRef}
          peers={peers}
          reportCursor={reportCursor}
          comments={comments}
          commentMode={commentMode}
          onToggleCommentMode={toggleCommentMode}
          onExitCommentMode={() => setCommentMode(false)}
          onAddComment={addComment}
          onResolveComment={resolveComment}
        />
        <PropertiesPanel engine={engine} scene={scene} />
      </div>
      <ChatPanel chat={chat} onSend={sendChat} />
    </div>
  );
}
