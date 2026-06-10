export type NodeKind = "frame" | "group" | "rect" | "ellipse" | "text" | "image";

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
  blendMode: string;
  cornerRadius: number;
  text: string;
  fontSize: number;
  fontFamily: string;
  textAlign: "left" | "center" | "right";
  textValign: "top" | "middle" | "bottom";
  image: string;
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
