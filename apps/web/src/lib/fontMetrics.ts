let probe: CanvasRenderingContext2D | null = null;

/**
 * Vertical font metrics at a given pixel size, measured off-screen.
 *
 * The canvas draws text with textBaseline = "top" (anchored at the em-square
 * top), while a DOM input positions glyphs by CSS line-box math built on the
 * font bounding box. These differ per font, so the text-edit overlay measures
 * both and aligns its baseline to the canvas baseline exactly:
 *
 * - emAscent: distance from the canvas "top" origin down to the alphabetic
 *   baseline (measured rather than assumed, so it tracks whatever the
 *   browser actually does).
 * - fbAscent/fbDescent: the font bounding box the browser also uses for CSS
 *   line layout.
 */
export function fontMetrics(size: number) {
  probe ??= document.createElement("canvas").getContext("2d")!;
  probe.font = `${size}px 'Hanken Grotesk', sans-serif`;
  probe.textBaseline = "alphabetic";
  const alpha = probe.measureText("Mg");
  probe.textBaseline = "top";
  const top = probe.measureText("Mg");
  return {
    emAscent: alpha.fontBoundingBoxAscent - top.fontBoundingBoxAscent,
    fbAscent: alpha.fontBoundingBoxAscent,
    fbDescent: alpha.fontBoundingBoxDescent,
  };
}
