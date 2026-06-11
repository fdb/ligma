export type NodeKind =
  | "frame"
  | "group"
  | "rect"
  | "ellipse"
  | "text"
  | "image"
  | "path"
  | "component"
  | "instance"
  | "bool";

export type Tool = "select" | "frame" | "rect" | "ellipse" | "text" | "pen" | "hand";

/** A bezier anchor (path nodes). Absolute world coordinates; handles
 * coinciding with the point mean a corner. */
export interface PathAnchor {
  x: number;
  y: number;
  hxIn: number;
  hyIn: number;
  hxOut: number;
  hyOut: number;
}

export interface Paint {
  color: string;
  opacity: number;
  /** "solid" or "linear". */
  kind: string;
  stops: { position: number; color: string }[];
  /** Gradient direction in degrees; 0 → right, 90 → down. */
  angle: number;
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
  points: PathAnchor[];
  closed: boolean;
  /** Extra closed contours, filled with `points` under the even-odd rule. */
  inner: PathAnchor[][];
  /** Styled runs in `text` (char offsets; text nodes only). */
  spans: {
    start: number;
    len: number;
    bold: boolean;
    italic: boolean;
    color: string;
    /** Font size override; 0 = the node's own size. */
    size: number;
    /** Font family override; "" = the node's own family. */
    family: string;
  }[];
  /** Master component id (instance nodes only). */
  component: number;
  /** Boolean operation (bool nodes only): "union" | "subtract" | "intersect". */
  boolOp: string;
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
  /** Id of the path in vector-edit mode, or null. */
  pathEdit: number | null;
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
