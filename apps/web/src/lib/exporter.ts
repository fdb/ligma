import type { Engine } from "../engine/pkg/ligma_core";
import type { ExportPreset, SceneNode } from "../types";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Renders one node through one of its export presets and downloads it. */
export async function exportNode(engine: Engine, node: SceneNode, preset: ExportPreset) {
  if (preset.format === "svg") {
    const svg = engine.export_svg(node.id);
    download(new Blob([svg], { type: "image/svg+xml" }), `${node.name}.svg`);
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(node.w * preset.scale));
  canvas.height = Math.max(1, Math.ceil(node.h * preset.scale));
  engine.render_export(canvas.getContext("2d")!, node.id, preset.scale);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob) {
    const suffix = preset.scale !== 1 ? `@${preset.scale}x` : "";
    download(blob, `${node.name}${suffix}.png`);
  }
}
