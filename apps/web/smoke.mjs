// Headless smoke test for the WASM engine (everything except rendering).
import { readFile } from "node:fs/promises";
import { initSync, Engine } from "./src/engine/pkg/ligma_core.js";

const wasm = await readFile("./src/engine/pkg/ligma_core_bg.wasm");
initSync({ module: wasm });

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
};

const e = new Engine();
const scene = () => JSON.parse(e.scene());

// Draw a rectangle by dragging.
e.set_tool("rect");
e.pointer_down(100, 100, false);
e.pointer_move(220, 180);
e.pointer_up();
let s = scene();
assert(s.nodes.length === 1, "drag-draw creates a node");
assert(s.nodes[0].w === 120 && s.nodes[0].h === 80, "node has dragged size");
assert(s.selection.length === 1, "new node is selected");
assert(s.tool === "select", "tool returns to select after drawing");

// Move it.
e.pointer_down(150, 150, false);
e.pointer_move(200, 170);
e.pointer_up();
s = scene();
assert(s.nodes[0].x === 150 && s.nodes[0].y === 120, "drag moves the node");

// Undo / redo.
e.undo();
assert(scene().nodes[0].x === 100, "undo restores position");
e.redo();
assert(scene().nodes[0].x === 150, "redo reapplies move");
e.undo();
e.undo();
assert(scene().nodes.length === 0, "undo removes drawn node");
e.redo();

// Panel edits + duplicate + delete.
const id = scene().nodes[0].id;
e.select(id, false);
assert(scene().selection.includes(id), "select() targets a node");
e.set_field(id, "w", 300);
assert(scene().nodes[0].w === 300, "set_field updates width");
e.update_paint(id, "fills", 0, "#0ea5e9", 0.5);
assert(scene().nodes[0].fills[0].color === "#0ea5e9", "update_paint sets color");
assert(scene().nodes[0].fills[0].opacity === 0.5, "each paint carries its own opacity");
e.add_paint(id, "fills");
assert(scene().nodes[0].fills.length === 2, "add_paint appends a second fill");
e.remove_paint(id, "fills", 1);
assert(scene().nodes[0].fills.length === 1, "remove_paint removes it");
e.add_paint(id, "strokes");
assert(scene().nodes[0].strokes.length === 1, "add_paint appends a stroke");

// Edit transactions: a scrub's many live values coalesce into one undo step.
e.begin_edit();
for (let i = 1; i <= 30; i++) e.set_field_live(id, "w", 300 + i);
e.commit_edit();
assert(scene().nodes[0].w === 330, "set_field_live applies live values");
e.undo();
assert(scene().nodes[0].w === 300, "scrub coalesces into a single undo step");
e.redo();
assert(scene().nodes[0].w === 330, "redo restores the scrubbed value");
e.duplicate_selection();
assert(scene().nodes.length === 2, "duplicate adds a copy");
e.delete_selection();
assert(scene().nodes.length === 1, "delete removes selection");

// Persistence round trip, including through the worker API.
const saved = e.to_json();
const e2 = new Engine();
assert(e2.load_json(saved), "load_json accepts engine output");
assert(JSON.parse(e2.scene()).nodes.length === 1, "document round-trips");

const API = process.env.API ?? "http://127.0.0.1:8787";
const put = await fetch(`${API}/api/documents/smoke-test`, { method: "PUT", body: saved });
assert(put.status === 204, "worker accepts document save");
const remote = await fetch(`${API}/api/documents/smoke-test`).then((r) => r.text());
assert(e2.load_json(remote), "load_json accepts worker-stored document");

// Groups: group two nodes, move the group (children follow), ungroup.
e.set_tool("rect");
e.pointer_down(500, 500, false);
e.pointer_move(560, 560);
e.pointer_up();
const idB = scene().nodes.at(-1).id;
e.select(id, false);
e.select(idB, true);
e.group_selection();
let group = scene().nodes.find((n) => n.kind === "group");
assert(group && group.children.length === 2, "group_selection nests both nodes");
const childX = group.children[0].x;
e.set_field(group.id, "x", group.x + 50);
group = scene().nodes.find((n) => n.kind === "group");
assert(group.children[0].x === childX + 50, "moving a group moves its children");
e.set_visible(group.id, false);
assert(scene().nodes.find((n) => n.kind === "group").visible === false, "set_visible hides");
e.set_visible(group.id, true);
e.set_locked(group.id, true);
assert(scene().nodes.find((n) => n.kind === "group").locked === true, "set_locked locks");
e.set_locked(group.id, false);
e.ungroup_selection();
assert(!scene().nodes.some((n) => n.kind === "group"), "ungroup dissolves the group");
assert(scene().selection.length === 2, "ungroup selects the freed children");

// Export: presets persist on the node; SVG serializes the subtree.
e.add_export_preset(id);
e.set_export_preset(id, 0, 2, "svg");
const preset = JSON.parse(e.scene()).nodes.find((n) => n.id === id).exportPresets[0];
assert(preset.scale === 2 && preset.format === "svg", "export preset saved on the node");
const svg = e.export_svg(id);
assert(svg.startsWith("<svg") && svg.includes("<rect"), "export_svg emits an SVG document");

// Migration: a v1 document (flat fill string) loads as v2 paints.
const v1 = JSON.stringify({
  nodes: [{ id: 1, name: "Old", kind: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#ff0000", opacity: 0.8, cornerRadius: 2, text: "", fontSize: 16 }],
  next_id: 2,
});
const e3 = new Engine();
assert(e3.load_json(v1), "v1 document loads");
const migrated = JSON.parse(e3.scene()).nodes[0];
assert(migrated.fills[0].color === "#ff0000", "v1 fill migrates to fills[0]");
assert(migrated.opacity === 0.8 && migrated.visible === true, "v1 node fields survive migration");

// Camera.
e.wheel(0, -100, true, 400, 300);
assert(scene().zoom > 1, "ctrl+wheel zooms in");
e.zoom_to_fit(800, 600);
assert(scene().zoom > 0, "zoom_to_fit yields a valid zoom");

console.log("\nAll engine smoke tests passed.");
