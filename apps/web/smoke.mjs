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

// Path editing: enter/exit, anchor drag, handle drags, toggle, delete.
const e20 = new Engine();
e20.set_tool("pen");
for (const [px, py] of [[100, 100], [200, 100], [200, 200]]) {
  e20.pointer_down(px, py, false, false);
  e20.pointer_up();
}
e20.pen_commit();
const pid20 = JSON.parse(e20.scene()).nodes[0].id;
e20.enter_path_edit(pid20);
let s20 = JSON.parse(e20.scene());
assert(s20.pathEdit === pid20, "enter_path_edit exposes the id in the scene");
assert(e20.path_edit_active(), "path_edit_active reflects edit mode");

// Drag the middle anchor: click it, move, release.
e20.pointer_down(200, 100, false, false);
e20.pointer_move(230, 80);
e20.pointer_up();
s20 = JSON.parse(e20.scene());
let pts20 = s20.nodes[0].points;
assert(pts20[1].x === 230 && pts20[1].y === 80, "anchor drag moves the anchor");
assert(pts20[1].hxOut === 230, "anchor drag carries its handles");
assert(s20.nodes[0].y === 80, "bounds resync after an anchor drag");
e20.undo();
pts20 = JSON.parse(e20.scene()).nodes[0].points;
assert(pts20[1].x === 200, "anchor drag is one undo step");
e20.redo();

// Toggle the dragged (corner) anchor to smooth: handles appear collinear.
assert(e20.path_toggle_anchor(230, 80), "toggle hits the anchor");
pts20 = JSON.parse(e20.scene()).nodes[0].points;
const t20 = pts20[1];
assert(t20.hxOut !== t20.x || t20.hyOut !== t20.y, "toggled anchor grew handles");
const crossT =
  (t20.hxOut - t20.x) * (t20.y - t20.hyIn) - (t20.hyOut - t20.y) * (t20.x - t20.hxIn);
assert(Math.abs(crossT) < 1e-6, "synthesized handles are collinear");
assert(!e20.path_toggle_anchor(150, 150), "toggle misses empty space");

// Smooth handle drag: moving the out handle rotates the in handle.
e20.pointer_down(230, 80, false, false); // select the smooth anchor
e20.pointer_up();
const before20 = JSON.parse(e20.scene()).nodes[0].points[1];
const inLen = Math.hypot(before20.hxIn - before20.x, before20.hyIn - before20.y);
e20.pointer_down(before20.hxOut, before20.hyOut, false, false);
e20.pointer_move(230, 20); // straight up from the anchor
e20.pointer_up();
let a20 = JSON.parse(e20.scene()).nodes[0].points[1];
assert(a20.hxOut === 230 && a20.hyOut === 20, "handle drag moves the out handle");
assert(
  Math.abs(a20.hxIn - 230) < 1e-6 && Math.abs(a20.hyIn - (80 + inLen)) < 1e-6,
  "smooth drag keeps the in handle mirrored at its own length",
);

// Broken (alt) handle drag: the in handle stays put.
const heldIn = { x: a20.hxIn, y: a20.hyIn };
e20.pointer_down(a20.hxOut, a20.hyOut, false, true); // alt
e20.pointer_move(280, 60);
e20.pointer_up();
a20 = JSON.parse(e20.scene()).nodes[0].points[1];
assert(a20.hxOut === 280 && a20.hyOut === 60, "alt drag moves the grabbed handle");
assert(a20.hxIn === heldIn.x && a20.hyIn === heldIn.y, "alt drag leaves the mirror alone");

// Marquee around two anchors, drag them together.
e20.pointer_down(60, 60, false, false); // empty spot: starts anchor marquee
e20.pointer_move(150, 250); // covers anchors at (100,100) and... only first
e20.pointer_up();
e20.pointer_down(100, 100, false, false); // drag from the selected anchor
e20.pointer_move(110, 120);
e20.pointer_up();
pts20 = JSON.parse(e20.scene()).nodes[0].points;
assert(pts20[0].x === 110 && pts20[0].y === 120, "marquee-selected anchor drags");

// Delete an anchor; deleting down to one removes the node.
e20.pointer_down(110, 120, false, false);
e20.pointer_up();
e20.delete_selection();
pts20 = JSON.parse(e20.scene()).nodes[0].points;
assert(pts20.length === 2, "delete removes the selected anchor");
e20.pointer_down(pts20[0].x, pts20[0].y, false, false);
e20.pointer_up();
e20.delete_selection();
s20 = JSON.parse(e20.scene());
assert(s20.nodes.length === 0, "a path below two anchors is deleted");
assert(s20.pathEdit === null, "edit mode exits with its node");

// Anchor snapping: a dragged anchor within 6px of a stationary anchor's
// axis lands exactly on it; handles snap to anchor axes too.
const e22 = new Engine();
e22.set_tool("pen");
for (const [px, py] of [[100, 100], [200, 100], [200, 200]]) {
  e22.pointer_down(px, py, false, false);
  e22.pointer_up();
}
e22.pen_commit();
const pid22 = JSON.parse(e22.scene()).nodes[0].id;
e22.enter_path_edit(pid22);
e22.pointer_down(200, 200, false, false); // grab the last anchor
e22.pointer_move(104, 150); // 4px off anchor 0's x -> snaps to 100
e22.pointer_up();
let pts22 = JSON.parse(e22.scene()).nodes[0].points;
assert(pts22[2].x === 100 && pts22[2].y === 150, "dragged anchor snaps to a stationary x");

e22.path_toggle_anchor(200, 100); // smooth the middle anchor
e22.pointer_down(200, 100, false, false); // select it
e22.pointer_up();
pts22 = JSON.parse(e22.scene()).nodes[0].points;
e22.pointer_down(pts22[1].hxOut, pts22[1].hyOut, false, false);
e22.pointer_move(204, 40); // 4px off the anchor's own x -> vertical tangent
e22.pointer_up();
pts22 = JSON.parse(e22.scene()).nodes[0].points;
assert(pts22[1].hxOut === 200 && pts22[1].hyOut === 40, "handle snaps to an anchor axis");

// Exit by hand and by tool switch.
const e21 = new Engine();
e21.set_tool("pen");
for (const [px, py] of [[0, 0], [100, 0]]) {
  e21.pointer_down(px, py, false, false);
  e21.pointer_up();
}
e21.pen_commit();
const pid21 = JSON.parse(e21.scene()).nodes[0].id;
e21.enter_path_edit(pid21);
e21.exit_path_edit();
assert(!e21.path_edit_active(), "exit_path_edit leaves edit mode");
e21.enter_path_edit(pid21);
e21.set_tool("rect");
assert(!e21.path_edit_active(), "switching to a drawing tool leaves edit mode");
e21.set_tool("select");
e21.enter_path_edit(99999);
assert(!e21.path_edit_active(), "enter_path_edit ignores unknown ids");

// Flatten: overlapping shapes merge into one even-odd path (hole).
const e23 = new Engine();
const draw23 = (tool, x1, y1, x2, y2) => {
  e23.set_tool(tool);
  e23.pointer_down(x1, y1, false, false);
  e23.pointer_move(x2, y2);
  e23.pointer_up();
};
draw23("rect", 100, 100, 300, 300);
draw23("rect", 200, 200, 400, 400);
const ids23 = JSON.parse(e23.scene()).nodes.map((n) => n.id);
e23.select(ids23[0], false);
e23.select(ids23[1], true);
e23.flatten_selection();
let s23 = JSON.parse(e23.scene());
assert(s23.nodes.length === 1 && s23.nodes[0].kind === "path", "flatten yields one path node");
const flat23 = s23.nodes[0];
assert(flat23.points.length === 4 && flat23.inner.length === 1, "two rects become two contours");
assert(flat23.closed === true, "flattened contours are closed");
assert(flat23.x === 100 && flat23.w === 300, "flattened bounds span both shapes");
assert(s23.selection[0] === flat23.id, "flattened path is selected");
// Even-odd: the overlap square (200..300)^2 is a hole.
assert(e23.node_at(150, 150) === flat23.id, "solid region hits");
assert(e23.node_at(250, 250) == null, "overlap region is a hole (even-odd)");
assert(e23.node_at(350, 350) === flat23.id, "second shape's solid region hits");
const svg23 = e23.export_svg(flat23.id);
assert(svg23.includes('fill-rule="evenodd"'), "SVG uses the even-odd fill rule");
assert(svg23.split("M ").length === 3, "SVG d contains both contours");
e23.undo();
assert(JSON.parse(e23.scene()).nodes.length === 2, "flatten is one undo step");
e23.redo();

// Flatten converts rounded rects and ellipses to beziers.
const e24 = new Engine();
const draw24 = (tool, x1, y1, x2, y2) => {
  e24.set_tool(tool);
  e24.pointer_down(x1, y1, false, false);
  e24.pointer_move(x2, y2);
  e24.pointer_up();
};
draw24("rect", 0, 0, 100, 100);
const rid24 = JSON.parse(e24.scene()).nodes[0].id;
e24.set_field(rid24, "cornerRadius", 20);
e24.select(rid24, false);
e24.flatten_selection();
let n24 = JSON.parse(e24.scene()).nodes[0];
assert(n24.kind === "path" && n24.points.length === 8, "rounded rect flattens to 8 arc anchors");
assert(n24.points[0].hxIn !== n24.points[0].x, "arc anchors carry handles");
draw24("ellipse", 200, 0, 300, 100);
const eid24 = JSON.parse(e24.scene()).nodes[1].id;
e24.select(eid24, false);
e24.flatten_selection();
const n24b = JSON.parse(e24.scene()).nodes[1];
assert(n24b.kind === "path" && n24b.points.length === 4, "ellipse flattens to 4 smooth anchors");
assert(e24.node_at(250, 50) === n24b.id, "flattened ellipse center hits");
assert(e24.node_at(204, 4) == null, "flattened ellipse corner misses (curve, not box)");

// Frame selection wraps nodes in a bbox-sized frame.
const e25 = new Engine();
const draw25 = (x1, y1, x2, y2) => {
  e25.set_tool("rect");
  e25.pointer_down(x1, y1, false, false);
  e25.pointer_move(x2, y2);
  e25.pointer_up();
};
draw25(100, 100, 200, 200);
draw25(300, 150, 400, 250);
const ids25 = JSON.parse(e25.scene()).nodes.map((n) => n.id);
e25.select(ids25[0], false);
e25.select(ids25[1], true);
e25.frame_selection();
let s25 = JSON.parse(e25.scene());
assert(s25.nodes.length === 1 && s25.nodes[0].kind === "frame", "frame selection wraps in a frame");
const fr25 = s25.nodes[0];
assert(fr25.x === 100 && fr25.y === 100 && fr25.w === 300 && fr25.h === 150, "frame matches the bbox");
assert(fr25.children.length === 2, "both nodes nest inside");
assert(s25.selection[0] === fr25.id, "the new frame is selected");
e25.undo();
assert(JSON.parse(e25.scene()).nodes.length === 2, "frame selection undoes in one step");

// Pathfinder booleans: union, subtract, intersect on two shapes.
const mkBool = () => {
  const en = new Engine();
  const d = (x1, y1, x2, y2) => {
    en.set_tool("rect");
    en.pointer_down(x1, y1, false, false);
    en.pointer_move(x2, y2);
    en.pointer_up();
  };
  d(100, 100, 300, 300); // bottom shape (subject)
  d(200, 200, 400, 400); // top shape
  const ids = JSON.parse(en.scene()).nodes.map((n) => n.id);
  en.select(ids[0], false);
  en.select(ids[1], true);
  return en;
};

let eb = mkBool();
eb.boolean_selection("union");
let sb1 = JSON.parse(eb.scene());
assert(
  sb1.nodes.length === 1 && sb1.nodes[0].kind === "bool" && sb1.nodes[0].boolOp === "union",
  "union yields a non-destructive boolean group",
);
assert(
  sb1.nodes[0].children.length === 2 && sb1.nodes[0].children.every((c) => c.kind === "rect"),
  "the source shapes live inside the boolean group",
);
assert(eb.node_at(250, 250) === sb1.nodes[0].id, "union overlap is solid (no hole)");
assert(eb.node_at(150, 150) === sb1.nodes[0].id, "union keeps the first rect's area");
assert(eb.node_at(350, 350) === sb1.nodes[0].id, "union keeps the second rect's area");
assert(sb1.nodes[0].x === 100 && sb1.nodes[0].w === 300, "union bounds span both");
// Moving a source shape recomputes the result live.
eb.deep_select(150, 150);
eb.pointer_down(150, 150, false, false);
eb.pointer_move(250, 250);
eb.pointer_up();
assert(
  JSON.parse(eb.scene()).nodes[0].x === 200,
  "moving a source inside the boolean updates the result bounds",
);
eb.undo();
// Flatten bakes the computed outline into a real path.
eb.select(sb1.nodes[0].id, false);
eb.flatten_selection();
sb1 = JSON.parse(eb.scene());
assert(sb1.nodes[0].kind === "path", "flatten bakes the boolean into a path");
assert(sb1.nodes[0].inner.length === 0, "union of overlapping rects is a single contour");
assert(sb1.nodes[0].points.length === 8, "union outline is the L-merge octagon");
eb.undo();
assert(JSON.parse(eb.scene()).nodes[0].kind === "bool", "undoing flatten restores the boolean");
eb.undo();
assert(JSON.parse(eb.scene()).nodes.length === 2, "the boolean op is one undo step");

eb = mkBool();
eb.boolean_selection("subtract");
let sb2 = JSON.parse(eb.scene());
assert(sb2.nodes.length === 1 && sb2.nodes[0].boolOp === "subtract", "subtract yields a bool group");
assert(eb.node_at(150, 150) === sb2.nodes[0].id, "subtract keeps the subject-only area");
assert(eb.node_at(250, 250) == null, "subtract removes the overlap");
assert(eb.node_at(350, 350) == null, "subtract drops the top shape's own area");
eb.flatten_selection();
assert(
  JSON.parse(eb.scene()).nodes[0].points.length === 6,
  "rect-minus-rect flattens to an L (6 corners)",
);

eb = mkBool();
eb.boolean_selection("intersect");
let sb3 = JSON.parse(eb.scene());
assert(sb3.nodes.length === 1 && sb3.nodes[0].boolOp === "intersect", "intersect yields a bool group");
assert(eb.node_at(250, 250) === sb3.nodes[0].id, "intersect keeps the overlap");
assert(eb.node_at(150, 150) == null, "intersect drops subject-only area");
assert(sb3.nodes[0].x === 200 && sb3.nodes[0].w === 100, "intersect bounds are the overlap");

// Containment special cases: subtract a fully inside shape -> a hole.
const ehc = new Engine();
const dh = (x1, y1, x2, y2) => {
  ehc.set_tool("rect");
  ehc.pointer_down(x1, y1, false, false);
  ehc.pointer_move(x2, y2);
  ehc.pointer_up();
};
dh(100, 100, 400, 400);
dh(200, 200, 300, 300); // fully inside
const idsH = JSON.parse(ehc.scene()).nodes.map((n) => n.id);
ehc.select(idsH[0], false);
ehc.select(idsH[1], true);
ehc.boolean_selection("subtract");
const hole = JSON.parse(ehc.scene()).nodes[0];
assert(ehc.node_at(250, 250) == null, "punched hole misses");
assert(ehc.node_at(150, 150) === hole.id, "ring area still hits");
ehc.flatten_selection();
assert(
  JSON.parse(ehc.scene()).nodes[0].inner.length === 1,
  "contained subtract flattens to a hole contour",
);

// Disjoint union keeps both as contours of one node.
const ed = new Engine();
const dd = (x1, y1, x2, y2) => {
  ed.set_tool("rect");
  ed.pointer_down(x1, y1, false, false);
  ed.pointer_move(x2, y2);
  ed.pointer_up();
};
dd(0, 0, 100, 100);
dd(200, 0, 300, 100);
const idsD = JSON.parse(ed.scene()).nodes.map((n) => n.id);
ed.select(idsD[0], false);
ed.select(idsD[1], true);
ed.boolean_selection("union");
const dis = JSON.parse(ed.scene()).nodes[0];
assert(ed.node_at(50, 50) === dis.id && ed.node_at(250, 50) === dis.id, "both pieces hit");
ed.flatten_selection();
assert(JSON.parse(ed.scene()).nodes[0].inner.length === 1, "disjoint union flattens to two contours");
ed.boolean_selection("union"); // needs exactly 2 selected: no-op
assert(JSON.parse(ed.scene()).nodes.length === 1, "boolean with one node selected is a no-op");

// Pathfinder on 3+ shapes and on shapes with holes.
const e3p = new Engine();
const d3p = (x1, y1, x2, y2) => {
  e3p.set_tool("rect");
  e3p.pointer_down(x1, y1, false, false);
  e3p.pointer_move(x2, y2);
  e3p.pointer_up();
};
const selAll3 = () => {
  const ids = JSON.parse(e3p.scene()).nodes.map((n) => n.id);
  ids.forEach((id, i) => e3p.select(id, i > 0));
};
// Union of three aligned rects in a row -> one solid bar.
d3p(0, 0, 100, 100);
d3p(80, 0, 180, 100);
d3p(160, 0, 260, 100);
selAll3();
e3p.boolean_selection("union");
{
  const b = JSON.parse(e3p.scene()).nodes[0];
  assert(b.children.length === 3, "3-shape boolean keeps all sources inside");
  assert(
    [50, 130, 210].every((x) => e3p.node_at(x, 50) === b.id),
    "3-shape union is solid across all three",
  );
  e3p.flatten_selection();
  assert(
    JSON.parse(e3p.scene()).nodes[0].inner.length === 0,
    "3-shape union flattens to a single contour",
  );
  e3p.undo();
  e3p.undo();
}
// Subtract two cutters from one slab -> two holes.
selAll3();
e3p.boolean_selection("subtract");
{
  const b = JSON.parse(e3p.scene()).nodes[0];
  assert(
    e3p.node_at(90, 50) == null && e3p.node_at(170, 50) == null && e3p.node_at(20, 50) === b.id,
    "subtracting two shapes carves both",
  );
  e3p.undo();
}
// A flattened donut (path with a hole) participates with its hole intact.
const edo = new Engine();
const ddo = (x1, y1, x2, y2) => {
  edo.set_tool("rect");
  edo.pointer_down(x1, y1, false, false);
  edo.pointer_move(x2, y2);
  edo.pointer_up();
};
ddo(100, 100, 300, 300);
ddo(150, 150, 250, 250);
{
  const ids = JSON.parse(edo.scene()).nodes.map((n) => n.id);
  edo.select(ids[0], false);
  edo.select(ids[1], true);
}
edo.boolean_selection("subtract");
edo.flatten_selection(); // a real path with one inner contour
ddo(0, 0, 400, 400);
{
  const nodes = JSON.parse(edo.scene()).nodes;
  const big = nodes.find((n) => n.kind === "rect");
  edo.select(big.id, false);
  edo.send_to_back();
  const donut = nodes.find((n) => n.kind === "path");
  edo.select(big.id, false);
  edo.select(donut.id, true);
  edo.boolean_selection("subtract");
  const b = JSON.parse(edo.scene()).nodes[0];
  assert(
    edo.node_at(120, 200) == null && edo.node_at(200, 200) === b.id && edo.node_at(350, 350) === b.id,
    "subtracting a donut keeps its hole solid (region parity)",
  );
}
// Tiles that exactly share an edge union into one solid.
const etu = new Engine();
const dtu = (x1, y1, x2, y2) => {
  etu.set_tool("rect");
  etu.pointer_down(x1, y1, false, false);
  etu.pointer_move(x2, y2);
  etu.pointer_up();
};
dtu(0, 0, 100, 100);
dtu(100, 0, 200, 100);
{
  const ids = JSON.parse(etu.scene()).nodes.map((n) => n.id);
  etu.select(ids[0], false);
  etu.select(ids[1], true);
}
etu.boolean_selection("union");
{
  const b = JSON.parse(etu.scene()).nodes[0];
  assert(
    etu.node_at(50, 50) === b.id && etu.node_at(150, 50) === b.id,
    "union of exactly-touching tiles covers both",
  );
}

// Outline stroke: a stroked rect becomes a ring path (even-odd).
const eo = new Engine();
eo.set_tool("rect");
eo.pointer_down(100, 100, false, false);
eo.pointer_move(300, 300);
eo.pointer_up();
const oid = JSON.parse(eo.scene()).nodes[0].id;
eo.add_paint(oid, "strokes");
eo.set_field(oid, "strokeWeight", 20);
eo.outline_stroke();
let so = JSON.parse(eo.scene());
assert(so.nodes.length === 2, "filled shape keeps its body under the ring");
const ring = so.nodes[1];
assert(ring.kind === "path" && ring.inner.length === 1, "ring is a two-contour path");
assert(ring.fills.length === 1 && ring.strokes.length === 0, "ring is fill-only");
assert(so.nodes[0].strokes.length === 0, "body loses its stroke");
assert(ring.x === 90 && ring.w === 220, "outer contour offsets by half the weight");
// Ring hit-test: band hits, center (between inner offsets) misses the ring.
assert(eo.node_at(100, 200) === ring.id, "stroke band hits the ring");
assert(eo.node_at(200, 200) === so.nodes[0].id, "ring center falls through to the body");
eo.undo();
assert(JSON.parse(eo.scene()).nodes.length === 1, "outline stroke is one undo step");

// Stroke-only shape: the ring replaces it.
const eo2 = new Engine();
eo2.set_tool("rect");
eo2.pointer_down(0, 0, false, false);
eo2.pointer_move(100, 100);
eo2.pointer_up();
const oid2 = JSON.parse(eo2.scene()).nodes[0].id;
eo2.add_paint(oid2, "strokes");
eo2.remove_paint(oid2, "fills", 0);
eo2.outline_stroke();
const so2 = JSON.parse(eo2.scene());
assert(so2.nodes.length === 1 && so2.nodes[0].kind === "path", "stroke-only shape is replaced");
assert(so2.nodes[0].inner.length === 1, "replacement is a ring");

// Outline stroke on an OPEN path: capsule union with round joins/caps.
const eop = new Engine();
eop.set_tool("pen");
eop.pointer_down(100, 100, false, false);
eop.pointer_up();
eop.pointer_down(300, 100, false, false);
eop.pointer_up();
eop.pointer_down(300, 300, false, false);
eop.pointer_up();
eop.pen_commit();
{
  const path = JSON.parse(eop.scene()).nodes[0];
  eop.select(path.id, false);
  eop.set_field(path.id, "strokeWeight", 20);
  eop.outline_stroke();
  const ring = JSON.parse(eop.scene()).nodes[0];
  assert(
    ring.kind === "path" && ring.name.includes("(stroke)"),
    "open-path outline replaces the stroke-only path",
  );
  assert(
    ring.x === 90 && ring.y === 90 && ring.w === 220 && ring.h === 220,
    "capsule outline bounds = path bounds + half weight each side",
  );
  assert(
    eop.node_at(200, 100) === ring.id && eop.node_at(300, 200) === ring.id,
    "both legs of the stroked L are solid",
  );
  assert(eop.node_at(95, 100) === ring.id, "round start cap extends past the endpoint");
  assert(eop.node_at(82, 100) == null, "nothing beyond the cap radius");
  assert(eop.node_at(250, 200) == null, "the bend interior stays empty");
  assert(eop.node_at(305, 95) === ring.id, "the join corner is rounded, not mitered");
}

// Rich text spans: bold/italic runs merge, split, clamp, export.
const es = new Engine();
es.set_tool("text");
es.pointer_down(0, 0, false, false);
es.pointer_up();
const tid = JSON.parse(es.scene()).nodes[0].id;
es.set_text(tid, "hello world");
es.set_span_style(tid, 0, 5, "bold", true);
let sp = JSON.parse(es.scene()).nodes[0].spans;
assert(sp.length === 1 && sp[0].start === 0 && sp[0].len === 5 && sp[0].bold, "bold span applies");
es.set_span_style(tid, 3, 5, "italic", true);
sp = JSON.parse(es.scene()).nodes[0].spans;
assert(sp.length === 3, "overlapping italic splits into three runs");
assert(sp[1].bold && sp[1].italic, "overlap run carries both styles");
es.set_span_style(tid, 0, 11, "bold", true);
es.set_span_style(tid, 0, 11, "italic", false);
sp = JSON.parse(es.scene()).nodes[0].spans;
assert(sp.length === 1 && sp[0].len === 11 && sp[0].bold && !sp[0].italic, "runs re-merge");
es.set_span_style(tid, 0, 11, "bold", false);
assert(JSON.parse(es.scene()).nodes[0].spans.length === 0, "unstyling clears spans");
es.set_span_style(tid, 6, 5, "bold", true);
es.undo();
assert(JSON.parse(es.scene()).nodes[0].spans.length === 0, "span styling is undoable");
es.redo();
// set_text clamps spans to the new length.
es.set_text(tid, "hello wo");
sp = JSON.parse(es.scene()).nodes[0].spans;
assert(sp.length === 1 && sp[0].start === 6 && sp[0].len === 2, "set_text clamps spans");
// Round-trip + SVG tspan.
const es2 = new Engine();
es2.load_json(es.to_json());
assert(JSON.parse(es2.scene()).nodes[0].spans.length === 1, "spans round-trip through JSON");
const svgT = es.export_svg(tid);
assert(svgT.includes('<tspan font-weight="700">wo</tspan>'), "SVG export emits bold tspans");

// Per-span color: applies, merges with bold, exports, clears.
es.set_span_color(tid, 0, 5, "#ff0000");
let spc = JSON.parse(es.scene()).nodes[0].spans;
assert(spc.some((s) => s.color === "#ff0000" && s.start === 0 && s.len === 5), "span color applies");
const svgC = es.export_svg(tid);
assert(svgC.includes('fill="#ff0000"'), "SVG tspan carries the color");
es.set_span_color(tid, 0, 5, "");
spc = JSON.parse(es.scene()).nodes[0].spans;
assert(!spc.some((s) => s.color === "#ff0000"), "empty color clears the override");
es.set_span_color(tid, 0, 5, 'red";<evil');
assert(!JSON.parse(es.scene()).nodes[0].spans.some((s) => s.color.includes("<")), "hostile colors rejected");

// Per-span font size and family.
const esf = new Engine();
esf.set_tool("text");
esf.pointer_down(50, 50, false, false);
esf.pointer_up();
{
  const tid = JSON.parse(esf.scene()).nodes[0].id;
  esf.set_text(tid, "Hello world");
  esf.set_span_size(tid, 0, 5, 32);
  esf.set_span_family(tid, 6, 5, "Lora");
  const spans = JSON.parse(esf.scene()).nodes[0].spans;
  assert(
    spans.length === 2 && spans[0].size === 32 && spans[1].family === "Lora",
    "span size and family apply to char ranges",
  );
  const svg = esf.export_svg(tid);
  assert(
    svg.includes('font-size="32"') && svg.includes('font-family="Lora, sans-serif"'),
    "SVG tspans carry size and family overrides",
  );
  esf.set_span_size(tid, 0, 5, 0);
  assert(
    JSON.parse(esf.scene()).nodes[0].spans.length === 1,
    "size 0 clears the override and the span dissolves",
  );
  esf.set_span_family(tid, 0, 5, 'Ev"il<x');
  assert(
    JSON.parse(esf.scene()).nodes[0].spans.length === 1,
    "hostile family strings are rejected",
  );
  const e2f = new Engine();
  e2f.load_json(esf.to_json());
  assert(
    JSON.parse(e2f.scene()).nodes[0].spans[0].family === "Lora",
    "span size/family round-trip through JSON",
  );
}

// Frame clipping: SVG wraps children in a clipPath; overhang is
// unreachable by hit-testing (it falls outside the frame).
const ef = new Engine();
ef.set_tool("frame");
ef.pointer_down(0, 0, false, false);
ef.pointer_move(200, 200);
ef.pointer_up();
ef.set_tool("rect");
ef.pointer_down(150, 50, false, false);
ef.pointer_move(190, 90); // child centered inside the frame
ef.pointer_up();
const fidF = JSON.parse(ef.scene()).nodes[0].id;
const cidF = JSON.parse(ef.scene()).nodes[0].children[0].id;
ef.select(cidF, false);
ef.set_field(cidF, "w", 150); // now overhangs to x=300
const svgF = ef.export_svg(fidF);
assert(svgF.includes("<clipPath id=") && svgF.includes("clip-path="), "frame SVG clips children");
assert(ef.node_at(250, 70) == null, "child overhang outside the frame is not clickable");
assert(ef.node_at(170, 70) === cidF, "child inside the frame stays clickable");

// Linear gradients: setter, round-trip, SVG paint server, solid revert.
const eg = new Engine();
eg.set_tool("rect");
eg.pointer_down(0, 0, false, false);
eg.pointer_move(200, 100);
eg.pointer_up();
const gid = JSON.parse(eg.scene()).nodes[0].id;
eg.set_paint_gradient(gid, 0, "linear", 45, JSON.stringify([
  { position: 0, color: "#ff0000" },
  { position: 1, color: "#0000ff" },
]));
let gp = JSON.parse(eg.scene()).nodes[0].fills[0];
assert(gp.kind === "linear" && gp.stops.length === 2 && gp.angle === 45, "gradient applies");
assert(gp.color === "#ff0000", "swatch fallback tracks the first stop");
eg.set_paint_gradient(gid, 0, "linear", 0, JSON.stringify([{ position: 0, color: "#fff" }]));
assert(JSON.parse(eg.scene()).nodes[0].fills[0].stops.length === 2, "single-stop input rejected");
const gsvg = eg.export_svg(gid);
assert(gsvg.includes("<linearGradient id=") && gsvg.includes('fill="url(#'), "SVG emits a paint server");
assert(gsvg.includes('stop-color="#ff0000"') && gsvg.includes('stop-color="#0000ff"'), "SVG carries both stops");
const eg2 = new Engine();
eg2.load_json(eg.to_json());
assert(JSON.parse(eg2.scene()).nodes[0].fills[0].kind === "linear", "gradient round-trips");
eg.update_paint(gid, "fills", 0, "#00ff00", 1);
gp = JSON.parse(eg.scene()).nodes[0].fills[0];
assert(gp.kind === "solid" && gp.stops.length === 0, "picking a flat color reverts to solid");
eg.undo();
assert(JSON.parse(eg.scene()).nodes[0].fills[0].kind === "linear", "solid revert is undoable");

// Radial: kind round-trips and SVG emits a radialGradient circle.
eg.set_paint_gradient(gid, 0, "radial", 0, JSON.stringify([
  { position: 0, color: "#ff0000" },
  { position: 1, color: "#0000ff" },
]));
assert(JSON.parse(eg.scene()).nodes[0].fills[0].kind === "radial", "radial kind applies");
const rsvg = eg.export_svg(gid);
assert(rsvg.includes("<radialGradient id=") && rsvg.includes('gradientUnits="userSpaceOnUse"'), "SVG emits a radial paint server");
eg.set_paint_gradient(gid, 0, "conic", 0, JSON.stringify([
  { position: 0, color: "#fff" },
  { position: 1, color: "#000" },
]));
assert(JSON.parse(eg.scene()).nodes[0].fills[0].kind === "radial", "unknown gradient kinds rejected");

// Live gradient updates coalesce into one undo step.
const egl = new Engine();
egl.set_tool("rect");
egl.pointer_down(0, 0, false, false);
egl.pointer_move(100, 100);
egl.pointer_up();
const glid = JSON.parse(egl.scene()).nodes[0].id;
const stops = JSON.stringify([
  { position: 0, color: "#ff0000" },
  { position: 1, color: "#0000ff" },
]);
egl.set_paint_gradient(glid, 0, "linear", 0, stops);
egl.begin_edit();
for (let a = 1; a <= 60; a++) egl.set_paint_gradient_live(glid, 0, "linear", a, stops);
egl.commit_edit();
assert(JSON.parse(egl.scene()).nodes[0].fills[0].angle === 60, "live gradient angle applies");
egl.undo();
assert(JSON.parse(egl.scene()).nodes[0].fills[0].angle === 0, "handle drag is one undo step");

// Components & instances: master renders into instances by reference.
const ec = new Engine();
ec.set_tool("rect");
ec.pointer_down(100, 100, false, false);
ec.pointer_move(200, 180);
ec.pointer_up();
const rcid = JSON.parse(ec.scene()).nodes[0].id;
ec.select(rcid, false);
ec.create_component();
let sc = JSON.parse(ec.scene());
assert(sc.nodes.length === 1 && sc.nodes[0].kind === "component", "create_component wraps the selection");
const comp = sc.nodes[0];
assert(comp.children.length === 1 && comp.children[0].id === rcid, "the rect nests inside the master");
assert(comp.x === 100 && comp.w === 100, "master takes the selection bbox");

ec.create_instance();
sc = JSON.parse(ec.scene());
assert(sc.nodes.length === 2 && sc.nodes[1].kind === "instance", "create_instance adds an instance");
const inst = sc.nodes[1];
assert(inst.component === comp.id, "instance references its master");
assert(inst.x === comp.x + comp.w + 24, "instance lands beside the master");
assert(sc.selection[0] === inst.id, "the new instance is selected");

// The instance's SVG embeds the master subtree under a transform.
const isvg = ec.export_svg(inst.id);
assert(isvg.includes("<g transform=") && isvg.includes("<rect"), "instance SVG embeds the master");

// Editing the master shows up in the instance's export.
ec.update_paint(rcid, "fills", 0, "#ff0000", 1);
assert(ec.export_svg(inst.id).includes('fill="#ff0000"'), "master edits propagate to instances");

// Resizing the instance scales the embedded master.
ec.select(inst.id, false);
ec.set_field(inst.id, "w", 200);
const isvg2 = ec.export_svg(inst.id);
assert(isvg2.includes("scale(2 1)"), "instance resize scales the mapping");

// Deleting the master leaves the instance rendering a placeholder (no crash).
ec.select(comp.id, false);
ec.delete_selection();
sc = JSON.parse(ec.scene());
assert(sc.nodes.length === 1 && sc.nodes[0].kind === "instance", "instance survives master deletion");
assert(ec.export_svg(sc.nodes[0].id).length > 0, "orphan instance still exports");

// create_instance refuses non-components.
const ec2 = new Engine();
ec2.set_tool("rect");
ec2.pointer_down(0, 0, false, false);
ec2.pointer_up();
ec2.create_instance();
assert(JSON.parse(ec2.scene()).nodes.length === 1, "create_instance is a no-op on plain shapes");

// Components persist through JSON.
const ec3 = new Engine();
ec3.set_tool("rect");
ec3.pointer_down(0, 0, false, false);
ec3.pointer_move(50, 50);
ec3.pointer_up();
ec3.create_component();
ec3.create_instance();
const ec3b = new Engine();
ec3b.load_json(ec3.to_json());
const sc3 = JSON.parse(ec3b.scene());
assert(
  sc3.nodes[0].kind === "component" && sc3.nodes[1].kind === "instance" && sc3.nodes[1].component === sc3.nodes[0].id,
  "components round-trip through JSON",
);

// Panel resize (set_field w/h) scales frame and group contents about the
// top-left, matching what handle drags do.
const er = new Engine();
er.set_tool("frame");
er.pointer_down(100, 100, false, false);
er.pointer_move(300, 300);
er.pointer_up();
er.set_tool("rect");
er.pointer_down(150, 150, false, false);
er.pointer_move(200, 200);
er.pointer_up();
er.set_tool("select");
const erFrame = JSON.parse(er.scene()).nodes.find((n) => n.kind === "frame");
er.set_field(erFrame.id, "w", 400); // 2x
er.set_field(erFrame.id, "h", 100); // 0.5x
{
  const f = JSON.parse(er.scene()).nodes.find((n) => n.kind === "frame");
  const c = f.children[0];
  assert(
    c.x === 200 && c.w === 100 && c.y === 125 && c.h === 25,
    "frame panel resize scales its children",
  );
}
er.set_tool("rect");
er.pointer_down(400, 400, false, false);
er.pointer_move(450, 450);
er.pointer_up();
er.set_tool("rect");
er.pointer_down(460, 400, false, false);
er.pointer_move(500, 450);
er.pointer_up();
er.set_tool("select");
{
  const top = JSON.parse(er.scene()).nodes;
  er.select(top.at(-2).id, false);
  er.select(top.at(-1).id, true);
}
er.group_selection();
const erGroup = JSON.parse(er.scene()).nodes.find((n) => n.kind === "group");
er.set_field(erGroup.id, "w", 200); // group was 100 wide -> 2x
{
  const g = JSON.parse(er.scene()).nodes.find((n) => n.kind === "group");
  assert(
    g.w === 200 && g.children[0].w === 100 && g.children[1].x === 520,
    "group panel resize scales its children",
  );
}
er.undo();
assert(
  JSON.parse(er.scene()).nodes.find((n) => n.kind === "group").w === 100,
  "panel resize of a group is one undo step",
);

// Shift constraints, edge resize bands, and resize snapping.
const ehz = new Engine();
ehz.set_tool("rect");
ehz.pointer_down(100, 100, false, false);
ehz.pointer_move(220, 160, true); // shift: square along the larger delta
ehz.pointer_up();
{
  const n = JSON.parse(ehz.scene()).nodes[0];
  assert(n.w === 120 && n.h === 120, "shift-draw constrains to a square");
  ehz.set_tool("select");
  ehz.select(n.id, false);
}
ehz.pointer_down(220, 160, false, false); // right edge band, mid-height
ehz.pointer_move(300, 200, false);
ehz.pointer_up();
{
  const n = JSON.parse(ehz.scene()).nodes[0];
  assert(n.w === 200 && n.h === 120, "edge band resizes one axis only");
}
ehz.pointer_down(300, 220, false, false); // SE corner
ehz.pointer_move(400, 230, true);
ehz.pointer_up();
{
  const n = JSON.parse(ehz.scene()).nodes[0];
  assert(
    Math.abs(n.w / n.h - 200 / 120) < 0.02,
    "shift-resize keeps the original proportions",
  );
}
const esz = new Engine();
esz.set_tool("frame");
esz.pointer_down(100, 100, false, false);
esz.pointer_move(400, 400, false);
esz.pointer_up();
esz.set_tool("rect");
esz.pointer_down(150, 150, false, false);
esz.pointer_move(250, 250, false);
esz.pointer_up();
esz.set_tool("select");
esz.select(JSON.parse(esz.scene()).nodes[0].children[0].id, false);
esz.pointer_down(250, 200, false, false); // child's right edge band
esz.pointer_move(396, 200, false); // within 6px of the frame's right edge
esz.pointer_up();
{
  const c = JSON.parse(esz.scene()).nodes[0].children[0];
  assert(c.x + c.w === 400, "resize-drag snaps the edge to the parent frame");
}

// Deep select: double-click descends one container level per call and
// the deep-selected child stays the drag target.
const edp = new Engine();
const edpDraw = (x, y, x2, y2) => {
  edp.set_tool("rect");
  edp.pointer_down(x, y, false, false);
  edp.pointer_move(x2, y2, false);
  edp.pointer_up();
};
edpDraw(100, 100, 150, 150);
edpDraw(200, 100, 250, 150);
{
  const ids = JSON.parse(edp.scene()).nodes.map((n) => n.id);
  edp.select(ids[0], false);
  edp.select(ids[1], true);
}
edp.group_selection();
edpDraw(300, 100, 350, 150);
{
  const top = JSON.parse(edp.scene()).nodes;
  edp.select(top[0].id, false);
  edp.select(top[1].id, true);
}
edp.group_selection();
edp.set_tool("select");
edp.pointer_down(120, 120, false, false);
edp.pointer_up();
{
  const outer = JSON.parse(edp.scene()).nodes[0];
  assert(
    JSON.parse(edp.scene()).selection[0] === outer.id,
    "click on nested content selects the outer group",
  );
  const inner = outer.children.find((c) => c.kind === "group");
  assert(edp.deep_select(120, 120) === true, "deep_select descends a level");
  assert(
    JSON.parse(edp.scene()).selection[0] === inner.id,
    "first deep_select picks the inner group",
  );
  edp.deep_select(120, 120);
  assert(
    JSON.parse(edp.scene()).selection[0] === inner.children[0].id,
    "second deep_select reaches the leaf",
  );
  assert(edp.deep_select(120, 120) === false, "deep_select at a leaf returns false");
  edp.pointer_down(120, 120, false, false);
  edp.pointer_move(140, 140, false);
  edp.pointer_up();
  const ig = JSON.parse(edp.scene()).nodes[0].children.find((c) => c.kind === "group");
  assert(
    ig.children[0].x === 120 && ig.children[1].x === 200,
    "dragging a deep-selected child moves it alone",
  );
}

// Frame-interior drags marquee children; clicks still select the frame.
const ef9 = new Engine();
ef9.set_tool("frame");
ef9.pointer_down(100, 100, false, false);
ef9.pointer_move(300, 300, false);
ef9.pointer_up();
ef9.set_tool("rect");
ef9.pointer_down(150, 150, false, false);
ef9.pointer_move(200, 200, false);
ef9.pointer_up();
ef9.set_tool("rect");
ef9.pointer_down(220, 150, false, false);
ef9.pointer_move(270, 200, false);
ef9.pointer_up();
ef9.set_tool("select");
ef9.pointer_down(600, 600, false, false); // deselect
ef9.pointer_up();
const ef9x = JSON.parse(ef9.scene()).nodes[0].x;
ef9.pointer_down(140, 140, false, false);
ef9.pointer_move(280, 210, false);
ef9.pointer_up();
{
  const s9 = JSON.parse(ef9.scene());
  assert(
    s9.nodes[0].x === ef9x && s9.selection.length === 2,
    "dragging a non-empty frame's interior marquees its children",
  );
}
ef9.pointer_down(600, 600, false, false);
ef9.pointer_up();
ef9.pointer_down(120, 280, false, false); // frame body, off the children
ef9.pointer_up();
assert(
  JSON.parse(ef9.scene()).selection[0] === JSON.parse(ef9.scene()).nodes[0].id,
  "a plain click on the frame body still selects the frame",
);
ef9.pointer_down(120, 280, false, false); // now selected: drag moves it
ef9.pointer_move(130, 290, false);
ef9.pointer_up();
assert(
  JSON.parse(ef9.scene()).nodes[0].x === ef9x + 10,
  "a selected frame still drags by its body",
);

// A plain click on one node of a multi-selection narrows to it.
ef9.pointer_down(600, 600, false, false); // deselect the frame first
ef9.pointer_up();
ef9.pointer_down(140, 142, false, false);
ef9.pointer_move(290, 215, false);
ef9.pointer_up(); // marquee: both children selected again
assert(JSON.parse(ef9.scene()).selection.length === 2, "marquee re-selects both children");
ef9.pointer_down(185, 185, false, false); // on the first child, off the handles
ef9.pointer_up();
{
  const s9 = JSON.parse(ef9.scene());
  assert(
    s9.selection.length === 1 && s9.selection[0] === s9.nodes[0].children[0].id,
    "clicking one of several selected nodes narrows the selection",
  );
}

// Document colors: most frequent first, includes gradient stops/spans.
const ec9 = new Engine();
ec9.set_tool("rect");
ec9.pointer_down(0, 0, false, false);
ec9.pointer_move(50, 50, false);
ec9.pointer_up();
ec9.set_tool("rect");
ec9.pointer_down(60, 0, false, false);
ec9.pointer_move(110, 50, false);
ec9.pointer_up();
{
  const ids9 = JSON.parse(ec9.scene()).nodes.map((n) => n.id);
  ec9.update_paint(ids9[0], "fills", 0, "#ff0000", 1);
  ec9.update_paint(ids9[1], "fills", 0, "#ff0000", 1);
  const colors = JSON.parse(ec9.document_colors());
  assert(colors[0] === "#ff0000", "document_colors sorts by frequency");
}

// Camera.
e.wheel(0, -100, true, 400, 300);
assert(scene().zoom > 1, "ctrl+wheel zooms in");
e.zoom_to_fit(800, 600);
assert(scene().zoom > 0, "zoom_to_fit yields a valid zoom");

console.log("\nAll engine smoke tests passed.");
