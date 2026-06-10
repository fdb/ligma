import type { Scene } from "../types";

/** Curated Google Fonts offering (plus the built-in default). */
export const FONT_FAMILIES = [
  "Hanken Grotesk",
  "Archivo",
  "Bebas Neue",
  "Caveat",
  "DM Sans",
  "IBM Plex Mono",
  "Inter",
  "JetBrains Mono",
  "Lora",
  "Merriweather",
  "Montserrat",
  "Open Sans",
  "Pacifico",
  "Playfair Display",
  "Poppins",
  "Roboto",
  "Source Serif 4",
  "Space Grotesk",
  "Space Mono",
];

const requested = new Set<string>(["Hanken Grotesk"]); // shipped with the app shell

/** Injects the Google Fonts stylesheet for a family (once). The canvas
 * re-renders every frame, so text snaps to the real font as soon as it
 * decodes — no engine notification needed. */
export function ensureFont(family: string) {
  if (!family || requested.has(family)) return;
  requested.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;600&display=swap`;
  document.head.appendChild(link);
}

/** Kick off loads for every font referenced by the scene. */
export function ensureSceneFonts(scene: Scene) {
  const walk = (nodes: Scene["nodes"]) => {
    for (const n of nodes) {
      if (n.kind === "text") ensureFont(n.fontFamily);
      walk(n.children);
    }
  };
  walk(scene.nodes);
}
