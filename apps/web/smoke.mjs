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
e.pointer_down(100, 100, false, false);
e.pointer_move(220, 180);
e.pointer_up();
let s = scene();
assert(s.nodes.length === 1, "drag-draw creates a node");
assert(s.nodes[0].w === 120 && s.nodes[0].h === 80, "node has dragged size");
assert(s.selection.length === 1, "new node is selected");
assert(s.tool === "select", "tool returns to select after drawing");

// Move it.
e.pointer_down(150, 150, false, false);
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
e.pointer_down(500, 500, false, false);
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

// Option-drag copies: drag with alt duplicates in place and moves the copy.
e3.set_tool("select");
e3.pointer_down(5, 5, false, true);
e3.pointer_move(40, 5);
e3.pointer_up();
let s3 = JSON.parse(e3.scene());
assert(s3.nodes.length === 2, "alt-drag duplicates the shape");
assert(s3.nodes[0].x === 0 && s3.nodes[1].x === 35, "original stays, copy moves");
e3.undo();
assert(JSON.parse(e3.scene()).nodes.length === 1, "one undo removes the alt-copy");
e3.pointer_down(5, 5, false, true);
e3.pointer_up();
assert(JSON.parse(e3.scene()).nodes.length === 1, "alt-click without drag leaves no copy");

// Snapping: dragging near another node's edge snaps to it exactly.
const e4 = new Engine();
e4.set_tool("rect");
e4.pointer_down(0, 0, false, false);
e4.pointer_move(100, 100);
e4.pointer_up();
e4.set_tool("rect");
e4.pointer_down(200, 50, false, false);
e4.pointer_move(260, 110);
e4.pointer_up();
e4.pointer_down(230, 80, false, false); // grab the second rect
e4.pointer_move(133, 80); // left edge lands at 103 — within snap range of 100
e4.pointer_up();
assert(JSON.parse(e4.scene()).nodes[1].x === 100, "drag snaps to a neighboring edge");

// Align & distribute.
const e5 = new Engine();
const drawRect = (x, y) => {
  e5.set_tool("rect");
  e5.pointer_down(x, y, false, false);
  e5.pointer_move(x + 40, y + 40);
  e5.pointer_up();
};
drawRect(0, 0);
drawRect(100, 10);
drawRect(300, 30);
const ids5 = JSON.parse(e5.scene()).nodes.map((n) => n.id);
e5.select(ids5[0], false);
e5.select(ids5[1], true);
e5.select(ids5[2], true);
e5.align_selection("top");
assert(
  JSON.parse(e5.scene()).nodes.every((n) => n.y === 0),
  "align top moves all nodes to the bbox top",
);
e5.distribute_selection("h");
assert(
  JSON.parse(e5.scene()).nodes.map((n) => n.x).join() === "0,150,300",
  "distribute h spaces gaps evenly",
);
e5.undo();
assert(
  JSON.parse(e5.scene()).nodes.map((n) => n.x).join() === "0,100,300",
  "distribute is one undo step",
);

// doc_generation: the autosave signal bumps on mutations only.
const e6 = new Engine();
e6.set_tool("rect");
e6.pointer_down(0, 0, false, false);
e6.pointer_move(50, 50);
e6.pointer_up();
const dg = e6.doc_generation();
const rid = JSON.parse(e6.scene()).nodes[0].id;
e6.pointer_move(25, 25); // hover
e6.select(rid, false);
e6.wheel(0, -50, true, 100, 100);
assert(e6.doc_generation() === dg, "hover/select/zoom leave doc_generation untouched");
e6.set_field(rid, "x", 99);
assert(e6.doc_generation() > dg, "mutations bump doc_generation");

// Frame parenting: drawing inside a frame nests the shape under it.
const e7 = new Engine();
e7.set_tool("frame");
e7.pointer_down(0, 0, false, false);
e7.pointer_move(400, 300);
e7.pointer_up();
e7.set_tool("rect");
e7.pointer_down(50, 50, false, false);
e7.pointer_move(150, 150, false, false);
e7.pointer_up();
let s7 = JSON.parse(e7.scene());
assert(s7.nodes.length === 1 && s7.nodes[0].kind === "frame", "shape drawn in a frame leaves top level");
assert(s7.nodes[0].children.length === 1 && s7.nodes[0].children[0].kind === "rect", "frame adopts the new shape");
const childId = s7.nodes[0].children[0].id;
assert(e7.node_at(100, 100) === childId, "hit test descends into frame children");
assert(e7.node_at(300, 250) === s7.nodes[0].id, "frame body is hit where no child sits");
e7.set_tool("rect");
e7.pointer_down(600, 600, false, false);
e7.pointer_move(700, 700, false, false);
e7.pointer_up();
assert(JSON.parse(e7.scene()).nodes.length === 2, "shape drawn outside frames stays top level");

// Clipboard: copy / paste (cascading) / cut.
const e8 = new Engine();
e8.set_tool("rect");
e8.pointer_down(0, 0, false, false);
e8.pointer_move(50, 50);
e8.pointer_up();
assert(e8.clipboard_len() === 0, "clipboard starts empty");
e8.copy_selection();
assert(e8.clipboard_len() === 1, "copy fills the clipboard");
e8.paste_clipboard();
let s8 = JSON.parse(e8.scene());
assert(s8.nodes.length === 2 && s8.nodes[1].x === 16, "paste inserts an offset copy");
assert(s8.selection.length === 1 && s8.selection[0] === s8.nodes[1].id, "paste selects the copy");
e8.paste_clipboard();
assert(JSON.parse(e8.scene()).nodes[2].x === 32, "repeated pastes cascade");
e8.cut_selection();
assert(JSON.parse(e8.scene()).nodes.length === 2, "cut removes the selection");
e8.paste_clipboard();
assert(JSON.parse(e8.scene()).nodes.length === 3, "cut contents can be pasted back");

// Z-order: bring to front / send to back.
const e9 = new Engine();
const draw9 = (x) => {
  e9.set_tool("rect");
  e9.pointer_down(x, 0, false, false);
  e9.pointer_move(x + 40, 40);
  e9.pointer_up();
};
draw9(0);
draw9(100);
draw9(200);
const first9 = JSON.parse(e9.scene()).nodes[0].id;
e9.select(first9, false);
e9.bring_to_front();
assert(JSON.parse(e9.scene()).nodes.at(-1).id === first9, "bring_to_front moves node to the end");
e9.send_to_back();
assert(JSON.parse(e9.scene()).nodes[0].id === first9, "send_to_back moves node to the start");
e9.undo();
assert(JSON.parse(e9.scene()).nodes.at(-1).id === first9, "z-order change is one undo step");

// Multi-selection resize: dragging a bbox handle scales every selected node.
const e10 = new Engine();
const draw10 = (x, y) => {
  e10.set_tool("rect");
  e10.pointer_down(x, y, false, false);
  e10.pointer_move(x + 100, y + 100);
  e10.pointer_up();
};
draw10(0, 0);
draw10(200, 200);
const ids10 = JSON.parse(e10.scene()).nodes.map((n) => n.id);
e10.select(ids10[0], false);
e10.select(ids10[1], true);
e10.pointer_down(300, 300, false, false); // bottom-right bbox handle
e10.pointer_move(600, 600);
e10.pointer_up();
let s10 = JSON.parse(e10.scene());
assert(s10.nodes[0].w === 200 && s10.nodes[1].w === 200, "bbox resize scales both widths");
assert(s10.nodes[1].x === 400 && s10.nodes[1].y === 400, "bbox resize scales positions");
e10.undo();
s10 = JSON.parse(e10.scene());
assert(s10.nodes[0].w === 100 && s10.nodes[1].x === 200, "multi-resize is one undo step");

// Paint transactions: a color-picker drag coalesces into one undo step.
const e11 = new Engine();
e11.set_tool("rect");
e11.pointer_down(0, 0, false, false);
e11.pointer_move(50, 50);
e11.pointer_up();
const rid11 = JSON.parse(e11.scene()).nodes[0].id;
const before11 = JSON.parse(e11.scene()).nodes[0].fills[0].color;
e11.begin_edit();
for (let i = 0; i < 20; i++) e11.update_paint_live(rid11, "fills", 0, "#0ea5e9", 0.8);
e11.commit_edit();
const after11 = JSON.parse(e11.scene()).nodes[0].fills[0];
assert(after11.color === "#0ea5e9" && after11.opacity === 0.8, "update_paint_live applies");
e11.undo();
assert(
  JSON.parse(e11.scene()).nodes[0].fills[0].color === before11,
  "picker drag is one undo step",
);

// Blend modes: set, validate, serialize, and survive old documents.
const e12 = new Engine();
e12.set_tool("rect");
e12.pointer_down(0, 0, false, false);
e12.pointer_move(50, 50);
e12.pointer_up();
const rid12 = JSON.parse(e12.scene()).nodes[0].id;
assert(JSON.parse(e12.scene()).nodes[0].blendMode === "normal", "blend mode defaults to normal");
e12.set_blend_mode(rid12, "multiply");
assert(JSON.parse(e12.scene()).nodes[0].blendMode === "multiply", "set_blend_mode applies");
e12.set_blend_mode(rid12, "bogus");
assert(JSON.parse(e12.scene()).nodes[0].blendMode === "multiply", "unknown blend modes ignored");
e12.undo();
assert(JSON.parse(e12.scene()).nodes[0].blendMode === "normal", "blend change is undoable");
e12.set_blend_mode(rid12, "screen");
const e12b = new Engine();
assert(e12b.load_json(e12.to_json()), "blend mode round-trips");
assert(JSON.parse(e12b.scene()).nodes[0].blendMode === "screen", "blend mode persists");
const svg12 = e12.export_svg(rid12);
assert(svg12.includes("mix-blend-mode:screen"), "SVG export carries mix-blend-mode");
// A pre-blend document (no blendMode field) loads with the default.
const legacy = JSON.parse(e12.to_json());
delete legacy.nodes[0].blendMode;
const e12c = new Engine();
assert(e12c.load_json(JSON.stringify(legacy)), "doc without blendMode loads");
assert(JSON.parse(e12c.scene()).nodes[0].blendMode === "normal", "missing blendMode defaults");

// Image nodes: placement, serialization, SVG export.
const e13 = new Engine();
const HASH = "a".repeat(32);
const imgId = e13.add_image(HASH, 10, 20, 200, 100);
let s13 = JSON.parse(e13.scene());
assert(s13.nodes[0].kind === "image" && s13.nodes[0].image === HASH, "add_image creates an image node");
assert(s13.nodes[0].fills.length === 0, "image nodes carry no fill paints");
assert(s13.selection[0] === imgId, "placed image is selected");
const e13b = new Engine();
e13b.load_json(e13.to_json());
assert(JSON.parse(e13b.scene()).nodes[0].image === HASH, "image hash round-trips");
assert(
  e13.export_svg(imgId).includes(`href="/api/assets/${HASH}"`),
  "SVG export references the asset",
);
e13.undo();
assert(JSON.parse(e13.scene()).nodes.length === 0, "add_image is undoable");

// Asset store: upload bytes, read them back, dedupe on content.
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
const up = await fetch(`${API}/api/assets`, {
  method: "POST",
  headers: { "Content-Type": "image/png" },
  body: pngBytes,
});
assert(up.status === 201, "asset upload accepted");
const { hash } = await up.json();
const back = new Uint8Array(await fetch(`${API}/api/assets/${hash}`).then((r) => r.arrayBuffer()));
assert(back.length === pngBytes.length && back[0] === 0x89, "asset bytes round-trip");
const dup = await fetch(`${API}/api/assets`, {
  method: "POST",
  headers: { "Content-Type": "image/png" },
  body: pngBytes,
}).then((r) => r.json());
assert(dup.hash === hash, "re-upload dedupes to the same hash");
const rejected = await fetch(`${API}/api/assets`, {
  method: "POST",
  headers: { "Content-Type": "text/html" },
  body: "<svg/>",
});
assert(rejected.status === 415, "non-image uploads are rejected");

// Text alignment: setters validate, persist, and default sensibly.
const e14 = new Engine();
e14.set_tool("text");
e14.pointer_down(0, 0, false, false);
e14.pointer_up();
const tid14 = JSON.parse(e14.scene()).nodes[0].id;
let tn14 = JSON.parse(e14.scene()).nodes[0];
assert(tn14.textAlign === "left" && tn14.textValign === "middle", "text aligns default left/middle");
e14.set_text_align(tid14, "center");
e14.set_text_valign(tid14, "bottom");
tn14 = JSON.parse(e14.scene()).nodes[0];
assert(tn14.textAlign === "center" && tn14.textValign === "bottom", "alignment setters apply");
e14.set_text_align(tid14, "justified-nonsense");
assert(JSON.parse(e14.scene()).nodes[0].textAlign === "center", "invalid alignment ignored");
e14.undo();
assert(JSON.parse(e14.scene()).nodes[0].textValign === "middle", "alignment is undoable");
const e14b = new Engine();
e14b.load_json(e14.to_json());
assert(JSON.parse(e14b.scene()).nodes[0].textAlign === "center", "alignment round-trips");
// SVG export honors explicit newlines even without a canvas render.
e14.set_text(tid14, "one\ntwo");
const svg14 = e14.export_svg(tid14);
assert(
  svg14.includes(">one</text>") && svg14.includes(">two</text>"),
  "SVG export splits text lines",
);
assert(svg14.includes('text-anchor="middle"'), "SVG export carries text-anchor");

// Reparenting (outliner drag-reorganization).
const e15 = new Engine();
e15.set_tool("frame");
e15.pointer_down(0, 0, false, false);
e15.pointer_move(400, 300);
e15.pointer_up();
e15.set_tool("rect");
e15.pointer_down(600, 0, false, false);
e15.pointer_move(700, 100);
e15.pointer_up();
e15.set_tool("rect");
e15.pointer_down(600, 200, false, false);
e15.pointer_move(700, 300);
e15.pointer_up();
let s15 = JSON.parse(e15.scene());
const [fid, r1, r2] = s15.nodes.map((n) => n.id);
e15.reparent(r1, fid, 0); // into the frame
s15 = JSON.parse(e15.scene());
assert(s15.nodes.length === 2 && s15.nodes[0].children[0]?.id === r1, "reparent moves into a frame");
e15.reparent(r2, fid, r1); // before r1 inside the frame
s15 = JSON.parse(e15.scene());
assert(
  s15.nodes[0].children.map((n) => n.id).join() === `${r2},${r1}`,
  "reparent inserts before a sibling",
);
e15.reparent(r1, 0, 0); // back to root
s15 = JSON.parse(e15.scene());
assert(s15.nodes.length === 2 && s15.nodes.at(-1).id === r1, "reparent back to root appends");
e15.reparent(fid, r2, 0); // into own child's sibling? r2 is inside fid → must refuse
s15 = JSON.parse(e15.scene());
assert(s15.nodes[0].id === fid, "reparent into own subtree is refused");
e15.reparent(r2, r1, 0); // rect is not a container → refused
s15 = JSON.parse(e15.scene());
assert(s15.nodes[0].children.length === 1, "reparent into a non-container is refused");
e15.undo();
s15 = JSON.parse(e15.scene());
assert(s15.nodes[0].children.length === 2, "reparent is undoable");

// Font family: setter, validation, persistence, SVG.
const e16 = new Engine();
e16.set_tool("text");
e16.pointer_down(0, 0, false, false);
e16.pointer_up();
const tid16 = JSON.parse(e16.scene()).nodes[0].id;
assert(
  JSON.parse(e16.scene()).nodes[0].fontFamily === "Hanken Grotesk",
  "font family defaults to Hanken Grotesk",
);
e16.set_font_family(tid16, "Space Grotesk");
assert(JSON.parse(e16.scene()).nodes[0].fontFamily === "Space Grotesk", "set_font_family applies");
e16.set_font_family(tid16, 'Bad"; injection');
assert(
  JSON.parse(e16.scene()).nodes[0].fontFamily === "Space Grotesk",
  "quote-bearing family names rejected",
);
const e16b = new Engine();
e16b.load_json(e16.to_json());
assert(JSON.parse(e16b.scene()).nodes[0].fontFamily === "Space Grotesk", "font family round-trips");
assert(
  e16.export_svg(tid16).includes('font-family="Space Grotesk, sans-serif"'),
  "SVG export carries the family",
);
e16.undo();
assert(JSON.parse(e16.scene()).nodes[0].fontFamily === "Hanken Grotesk", "font change is undoable");

// Pen tool: open paths, smooth anchors, closing, hit-testing, transforms.
const e17 = new Engine();
e17.set_tool("pen");
assert(!e17.pen_active(), "pen inactive before first click");
e17.pointer_down(100, 100, false, false);
e17.pointer_up();
e17.pointer_down(200, 100, false, false);
e17.pointer_up();
e17.pointer_down(200, 200, false, false);
e17.pointer_move(240, 240); // drag out handles -> smooth anchor
e17.pointer_up();
assert(e17.pen_active(), "pen active while drawing");
e17.pen_commit();
assert(!e17.pen_active(), "commit clears the pen state");
let s17 = JSON.parse(e17.scene());
assert(s17.tool === "select", "committing returns to the select tool");
const path17 = s17.nodes[0];
assert(path17.kind === "path", "pen commit creates a path node");
assert(path17.points.length === 3, "three anchors placed");
assert(!path17.closed, "commit leaves the path open");
assert(path17.fills.length === 0 && path17.strokes.length === 1, "open path is stroke-only");
const smooth = path17.points[2];
assert(smooth.hxOut === 240 && smooth.hyOut === 240, "click-drag sets the out handle");
assert(
  smooth.hxIn === 2 * smooth.x - 240 && smooth.hyIn === 2 * smooth.y - 240,
  "in handle mirrors the out handle",
);
assert(path17.points[0].hxOut === path17.points[0].x, "plain click places a corner anchor");
assert(s17.selection[0] === path17.id, "committed path is selected");
e17.undo();
assert(JSON.parse(e17.scene()).nodes.length === 0, "whole path is one undo step");
e17.redo();

// Hit-testing: on the stroke hits, empty bbox corner misses.
assert(e17.node_at(150, 100) === path17.id, "click on a segment hits the path");
assert(e17.node_at(120, 180) == null, "empty corner of the path bbox misses");

// Closing by clicking the first anchor.
const e18 = new Engine();
e18.set_tool("pen");
for (const [px, py] of [[300, 300], [400, 300], [350, 380]]) {
  e18.pointer_down(px, py, false, false);
  e18.pointer_up();
}
e18.pointer_down(301, 301, false, false); // within close tolerance of the first
let s18 = JSON.parse(e18.scene());
const tri = s18.nodes[0];
assert(tri.kind === "path" && tri.closed, "clicking the first anchor closes the path");
assert(tri.fills.length === 1, "closed path gets a fill");
assert(e18.node_at(350, 320) === tri.id, "interior of a closed path hits");

// Transforms keep anchors in sync.
const ax0 = tri.points[0].x;
e18.nudge(10, 0);
s18 = JSON.parse(e18.scene());
assert(s18.nodes[0].points[0].x === ax0 + 10, "nudge shifts anchors with the box");
const w0 = s18.nodes[0].w;
e18.set_field(tri.id, "w", w0 * 2);
s18 = JSON.parse(e18.scene());
assert(Math.abs(s18.nodes[0].w - w0 * 2) < 0.01, "set_field w doubles the path width");
const xs18 = s18.nodes[0].points.map((p) => p.x);
assert(
  Math.abs(Math.max(...xs18) - Math.min(...xs18) - w0 * 2) < 0.01,
  "anchors scale with the box",
);

// SVG export and persistence round-trip.
const svg18 = e18.export_svg(tri.id);
assert(svg18.includes('<path d="M ') && svg18.includes(" Z"), "SVG export emits a closed path d");
const e18b = new Engine();
e18b.load_json(e18.to_json());
const tri2 = JSON.parse(e18b.scene()).nodes[0];
assert(tri2.points.length === 3 && tri2.closed, "path round-trips through JSON");

// Switching tools mid-draw commits; a single anchor is discarded.
const e19 = new Engine();
e19.set_tool("pen");
e19.pointer_down(0, 0, false, false);
e19.pointer_up();
e19.set_tool("select");
assert(JSON.parse(e19.scene()).nodes.length === 0, "single-anchor pen draw is discarded");
e19.set_tool("pen");
e19.pointer_down(0, 0, false, false);
e19.pointer_up();
e19.pointer_down(50, 50, false, false);
e19.pointer_up();
e19.set_tool("rect");
const s19 = JSON.parse(e19.scene());
assert(
  s19.nodes.length === 1 && s19.nodes[0].kind === "path",
  "switching tools commits the in-progress path",
);

// Camera.
e.wheel(0, -100, true, 400, 300);
assert(scene().zoom > 1, "ctrl+wheel zooms in");
e.zoom_to_fit(800, 600);
assert(scene().zoom > 0, "zoom_to_fit yields a valid zoom");

console.log("\nAll engine smoke tests passed.");
