import type { Scene } from "../types";

/** Decoded image elements, keyed by asset hash. The WASM renderer reads
 * this map (window.__ligmaImages) every frame, so an image pops in on
 * the first frame after it decodes — no engine round-trip needed. */
const cache: Record<string, HTMLImageElement> = ((window as unknown as Record<string, any>)
  .__ligmaImages ??= {});
const loading = new Set<string>();

export function ensureImage(hash: string) {
  if (!hash || cache[hash] || loading.has(hash)) return;
  loading.add(hash);
  const img = new Image();
  img.onload = () => {
    cache[hash] = img;
    loading.delete(hash);
  };
  img.onerror = () => loading.delete(hash);
  img.src = `/api/assets/${hash}`;
}

/** Kick off loads for every image referenced by the scene. */
export function ensureSceneImages(scene: Scene) {
  const walk = (nodes: Scene["nodes"]) => {
    for (const n of nodes) {
      if (n.kind === "image") ensureImage(n.image);
      walk(n.children);
    }
  };
  walk(scene.nodes);
}

/** Uploads an image file to the content-addressed asset store and primes
 * the cache. Returns the asset hash plus intrinsic pixel size. */
export async function uploadImage(
  file: File,
): Promise<{ hash: string; width: number; height: number } | null> {
  if (!file.type.startsWith("image/")) return null;
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!res.ok) return null;
  const { hash } = (await res.json()) as { hash: string };
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      cache[hash] = img;
      resolve({ hash, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

/** Default placement size: fit within 400px, never upscale. */
export function placementSize(width: number, height: number) {
  const scale = Math.min(1, 400 / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}
