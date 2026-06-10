export type NodeKind = "frame" | "rect" | "ellipse" | "text";

export type Tool = "select" | "frame" | "rect" | "ellipse" | "text" | "hand";

export interface SceneNode {
  id: number;
  name: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  opacity: number;
  cornerRadius: number;
  text: string;
  fontSize: number;
}

export interface Scene {
  nodes: SceneNode[];
  selection: number[];
  hovered: number | null;
  tool: Tool;
  zoom: number;
  generation: number;
}
