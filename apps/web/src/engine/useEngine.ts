import { useEffect, useRef, useState } from "react";
import init, { Engine } from "./pkg/ligma_core";
import { ensureSceneImages } from "../lib/images";
import type { Scene } from "../types";

// init() must run exactly once per page: wasm-bindgen's loader has no
// in-flight guard, so two concurrent calls (e.g. StrictMode's double
// effect) instantiate two WASM instances and the second silently
// rebinds the module's memory — corrupting every live Engine pointer.
let wasmReady: Promise<unknown> | undefined;

/**
 * Boots the WASM engine, loads the document, and keeps a React snapshot of
 * the scene in sync. The engine is the source of truth; `scene` is a
 * read-only mirror refreshed whenever the engine's generation counter
 * changes. `notFound` is set when the server has no such document.
 */
export function useEngine(docId: string) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [notFound, setNotFound] = useState(false);
  const generation = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setEngine(null);
    setScene(null);
    setNotFound(false);
    generation.current = -1;
    (async () => {
      await (wasmReady ??= init());
      const e = new Engine();
      try {
        const res = await fetch(`/api/documents/${docId}`);
        if (res.ok) {
          e.load_json(await res.text());
        } else if (res.status === 404 || res.status === 400) {
          if (!cancelled) setNotFound(true);
          return;
        }
      } catch {
        // Server unreachable — start with an empty document.
      }
      // Ground-truth access for E2E tests and console debugging.
      if (import.meta.env.DEV) (window as unknown as { __engine?: Engine }).__engine = e;
      if (!cancelled) setEngine(e);
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  useEffect(() => {
    if (!engine) return;
    let raf = 0;
    const tick = () => {
      const gen = engine.generation();
      if (gen !== generation.current) {
        generation.current = gen;
        const next = JSON.parse(engine.scene()) as Scene;
        ensureSceneImages(next); // start fetching any newly referenced assets
        setScene(next);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return { engine, scene, notFound };
}
