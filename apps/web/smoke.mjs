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
e.set_fill(id, "#0ea5e9");
assert(scene().nodes[0].fill === "#0ea5e9", "set_fill updates fill");

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

// Camera.
e.wheel(0, -100, true, 400, 300);
assert(scene().zoom > 1, "ctrl+wheel zooms in");
e.zoom_to_fit(800, 600);
assert(scene().zoom > 0, "zoom_to_fit yields a valid zoom");

console.log("\nAll engine smoke tests passed.");
