export type NodeKind = "frame" | "group" | "rect" | "ellipse" | "text";

export type Tool = "select" | "frame" | "rect" | "ellipse" | "text" | "hand";

export interface Paint {
  color: string;
  opacity: number;
}

export type ExportFormat = "png" | "svg";

export interface ExportPreset {
  scale: number;
  format: ExportFormat;
}

export interface SceneNode {
  id: number;
  name: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  locked: boolean;
  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  opacity: number;
  cornerRadius: number;
  text: string;
  fontSize: number;
  exportPresets: ExportPreset[];
  children: SceneNode[];
}

export interface Scene {
  nodes: SceneNode[];
  selection: number[];
  hovered: number | null;
  tool: Tool;
  zoom: number;
  panX: number;
  panY: number;
  generation: number;
  docGeneration: number;
}

export function findNode(nodes: SceneNode[], id: number): SceneNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}
