import { test, expect, type Page } from "@playwright/test";

const API = "http://127.0.0.1:8787";

// Every test fails if anything reaches the browser console as an error —
// WASM panics, JSON corruption, and unhandled rejections all land there.
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("console", (m) => {
    // 404s are expected when probing documents that don't exist.
    if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text()))
      errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
});

test.afterEach(() => {
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

const layers = (page: Page) => page.getByTestId("layers");

/** Create a fresh document through the API and open its editor. */
async function openNewDocument(page: Page): Promise<string> {
  const res = await page.request.post(`${API}/api/documents`);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/d/${id}`);
  await expect(page.locator("canvas")).toBeVisible();
  return id;
}

async function canvasBox(page: Page) {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  return box;
}

async function drag(page: Page, x1: number, y1: number, x2: number, y2: number) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  await page.mouse.move(box.x + x2, box.y + y2, { steps: 12 });
  await page.mouse.up();
}

async function clickCanvas(page: Page, x: number, y: number) {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + x, box.y + y);
}

async function hoverSweep(page: Page, x1: number, y1: number, x2: number, y2: number) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.move(box.x + x2, box.y + y2, { steps: 25 });
}

/** Click a layer row's expand chevron, waiting for it to appear (the
 * chevron only renders once the rAF scene sync delivers the children). */
async function expandLayer(page: Page, name: string) {
  await layers(page)
    .locator("[data-layer]", { hasText: name })
    .getByTitle("Expand")
    .click();
}

const findKind = (nodes: any[], id: number): string | null => {
  for (const n of nodes) {
    if (n.id === id) return n.kind;
    const k = findKind(n.children, id);
    if (k) return k;
  }
  return null;
};

const sceneOf = (page: Page) =>
  page.evaluate(() => JSON.parse((window as any).__engine.scene()));

test("homepage creates a document and lists it afterwards", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New design file/ }).click();

  // Minted id: 16 chars of the base32 alphabet.
  await page.waitForURL(/\/d\/[a-z2-7]{16}$/);
  await expect(page.locator("canvas")).toBeVisible();

  // Draw and save so the file gains a version.
  await page.keyboard.press("r");
  await drag(page, 250, 200, 400, 300);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();

  // Back home via the logo: the file is listed with a version.
  await page.getByTitle("Back to your files").click();
  await expect(page.getByText("Untitled").first()).toBeVisible();
  await expect(page.getByText("v1").first()).toBeVisible();
});

test("unknown document id shows not-found, not an editor", async ({ page }) => {
  await page.goto("/d/zzzzzzzzzzzzzzzz");
  await expect(page.getByText("No document at")).toBeVisible();
  await page.getByRole("link", { name: "Back to your files" }).click();
  await expect(page.getByRole("button", { name: /New design file/ })).toBeVisible();
});

test("draw a frame, select it, hover and move it (regression: select-frame crash)", async ({
  page,
}) => {
  await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 500, 350);
  await expect(layers(page).getByText("Frame 1")).toBeVisible();

  // Deselect, hover around, then click the frame to select it again —
  // the exact sequence that corrupted scene JSON and poisoned the engine.
  await clickCanvas(page, 700, 450);
  await hoverSweep(page, 700, 450, 350, 250);
  await clickCanvas(page, 350, 250);
  await hoverSweep(page, 350, 250, 600, 400);

  // Engine must still be alive: move the frame.
  await drag(page, 350, 250, 450, 300);
  await expect(layers(page).getByText("Frame 1")).toBeVisible();
});

test("draw shapes, edit properties, undo and delete", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 400, 300);
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();

  await page.keyboard.press("o");
  await drag(page, 450, 200, 550, 300);
  await expect(layers(page).getByText("Ellipse 1")).toBeVisible();

  // Edit width through the properties panel.
  const wField = page.locator("label", { hasText: "W" }).locator("input");
  await wField.fill("240");
  await wField.press("Enter");
  await expect(wField).toHaveValue("240");

  // Click the (now wider) ellipse so focus is back on the canvas, then
  // duplicate, delete, and undo the delete. Duplicates keep their name
  // (Figma behavior), so assert on layer count.
  await clickCanvas(page, 570, 250);
  await page.keyboard.press("Meta+d");
  await expect(layers(page).getByText("Ellipse 1")).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await expect(layers(page).getByText("Ellipse 1")).toHaveCount(1);
  await page.keyboard.press("Meta+z");
  await expect(layers(page).getByText("Ellipse 1")).toHaveCount(2);
});

test("number fields: expressions, scrub with capture, shift steps, undo coalescing", async ({
  page,
}) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280); // 100x80 rectangle

  const w = () =>
    page.evaluate(() => JSON.parse((window as any).__engine.scene()).nodes[0].w as number);

  // Expressions evaluate on commit; invalid input reverts.
  const wField = page.locator("label", { hasText: "W" }).locator("input");
  await wField.fill("12*2+1");
  await wField.press("Enter");
  expect(await w()).toBe(25);
  await expect(wField).toHaveValue("25");
  await wField.fill("2*+");
  await wField.press("Enter");
  await expect(wField).toHaveValue("25");
  expect(await w()).toBe(25);

  // Scrub the label 300px right — far outside the tiny span, proving
  // pointer capture holds — for +300 at 1/px.
  const sb = (await page.locator('[data-scrub="w"]').boundingBox())!;
  const cx = sb.x + sb.width / 2;
  const cy = sb.y + sb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 300, cy, { steps: 10 });
  await page.mouse.up();
  expect(await w()).toBe(325);

  // The whole scrub is one undo step.
  await page.keyboard.press("Meta+z");
  expect(await w()).toBe(25);

  // Shift while scrubbing: 10 per pixel.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(cx + 20, cy, { steps: 4 });
  await page.keyboard.up("Shift");
  await page.mouse.up();
  expect(await w()).toBe(225);
});

test("groups: ⌘G nesting, visibility toggle, ⇧⌘G ungroup", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);
  await page.keyboard.press("r");
  await drag(page, 400, 200, 500, 280);

  // Marquee both, group them.
  await drag(page, 200, 150, 550, 330);
  await page.keyboard.press("Meta+g");
  await expect(layers(page).getByText("Group 1")).toBeVisible();

  // Expand the group, hide a child via the eye toggle.
  const groupRow = page.locator("[data-layer]", { hasText: "Group 1" });
  await groupRow.locator("button").first().click();
  const childRow = page.locator("[data-layer]", { hasText: "Rectangle 1" });
  await childRow.hover();
  await childRow.locator("button").last().click();
  const childVisible = await page.evaluate(() => {
    const s = JSON.parse((window as any).__engine.scene());
    const g = s.nodes.find((n: any) => n.kind === "group");
    return g.children.find((c: any) => c.name === "Rectangle 1").visible;
  });
  expect(childVisible).toBe(false);

  // Moving the group moves its children (absolute coords follow).
  const before = await page.evaluate(() => {
    const g = JSON.parse((window as any).__engine.scene()).nodes.find(
      (n: any) => n.kind === "group",
    );
    return g.children.map((c: any) => c.x);
  });
  await page.keyboard.press("Shift+ArrowRight");
  const after = await page.evaluate(() => {
    const g = JSON.parse((window as any).__engine.scene()).nodes.find(
      (n: any) => n.kind === "group",
    );
    return g.children.map((c: any) => c.x);
  });
  expect(after).toEqual(before.map((x: number) => x + 10));

  await page.keyboard.press("Meta+Shift+g");
  await expect(layers(page).getByText("Group 1")).not.toBeVisible();
  await expect(layers(page).getByText("Rectangle 2")).toBeVisible();
});

test("export presets: saved per node, PNG and SVG download", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);

  // Two presets: default 1x PNG, plus an SVG.
  await page.getByTitle("Add export").click();
  await page.getByTitle("Add export").click();
  // The second preset's format select (format selects are the ones that
  // offer an "svg" option — index-proof against other panel selects).
  await page
    .locator("select")
    .filter({ has: page.locator('option[value="svg"]') })
    .last()
    .selectOption("svg");

  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole("button", { name: /Export Rectangle 1/ }).click();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads).toContain("Rectangle 1.png");
  expect(downloads).toContain("Rectangle 1.svg");

  // Presets persist with the document.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.reload();
  await expect(page.locator("canvas")).toBeVisible();
  await layers(page).getByText("Rectangle 1").click();
  await expect(page.getByRole("button", { name: /Export Rectangle 1/ })).toBeVisible();
});

test("v1 documents migrate to the paint model on load", async ({ page }) => {
  const res = await page.request.post(`${API}/api/documents`);
  const { id } = (await res.json()) as { id: string };
  await page.request.put(`${API}/api/documents/${id}`, {
    data: {
      nodes: [
        { id: 1, name: "Legacy", kind: "rect", x: 0, y: 0, w: 100, h: 100, fill: "#ff0000", opacity: 1, cornerRadius: 0, text: "", fontSize: 16 },
      ],
      next_id: 2,
    },
  });
  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Legacy")).toBeVisible();
  const fills = await page.evaluate(
    () => JSON.parse((window as any).__engine.scene()).nodes[0].fills,
  );
  expect(fills).toEqual([
    { color: "#ff0000", opacity: 1, kind: "solid", stops: [], angle: 0 },
  ]);
});

test("option-drag copies a shape; one undo removes the copy", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);

  await page.keyboard.down("Alt");
  await drag(page, 300, 240, 520, 240);
  await page.keyboard.up("Alt");
  await expect(layers(page).getByText("Rectangle 1")).toHaveCount(2);

  await page.keyboard.press("Meta+z");
  await expect(layers(page).getByText("Rectangle 1")).toHaveCount(1);
});

test("arrange: align and distribute from the properties panel", async ({ page }) => {
  await openNewDocument(page);
  for (const [x, y] of [
    [220, 180],
    [330, 210],
    [520, 250],
  ] as const) {
    await page.keyboard.press("r");
    await drag(page, x, y, x + 40, y + 40);
  }
  await drag(page, 180, 140, 600, 330); // marquee all three

  const ys = () =>
    page.evaluate(() => JSON.parse((window as any).__engine.scene()).nodes.map((n: any) => n.y));
  await page.getByTitle("Align top").click();
  expect(new Set(await ys()).size).toBe(1);

  await page.getByTitle("Distribute horizontally").click();
  const xs = await page.evaluate(() =>
    JSON.parse((window as any).__engine.scene()).nodes.map((n: any) => n.x),
  );
  const sorted = [...xs].sort((a: number, b: number) => a - b);
  expect(sorted[1] - sorted[0]).toBeCloseTo(sorted[2] - sorted[1], 5);
});

test("menu bar drives commands; Copy as SVG fills the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);

  // Object menu: group is disabled with a single selection. Close by
  // toggling the menu button — Escape would also clear the canvas
  // selection via the global shortcut.
  await page.getByRole("button", { name: "Object" }).click();
  await expect(page.getByRole("button", { name: "Group selection" })).toBeDisabled();
  await page.getByRole("button", { name: "Object" }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Copy as SVG" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("<svg");
  expect(clip).toContain("<rect");

  // Edit > Duplicate works from the menu.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(layers(page).getByText("Rectangle 1")).toHaveCount(2);
});

test("double-click edits text directly on the canvas", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250);
  await expect(layers(page).getByText("Text 1")).toBeVisible();

  const box = await canvasBox(page);
  await page.mouse.dblclick(box.x + 320, box.y + 262);
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("Hello Ligma");
  await editor.press("Escape"); // Enter now inserts a newline; Escape commits

  const text = await page.evaluate(
    () => JSON.parse((window as any).__engine.scene()).nodes[0].text,
  );
  expect(text).toBe("Hello Ligma");
});

test("frames rename by double-clicking their canvas label", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 500, 350);

  const box = await canvasBox(page);
  await page.mouse.dblclick(box.x + 215, box.y + 140); // the label above the frame
  const editor = page.getByTestId("frame-name-editor");
  await expect(editor).toBeVisible();
  await editor.fill("Hero Section");
  await editor.press("Enter");

  await expect(layers(page).getByText("Hero Section")).toBeVisible();
});

test("renaming the document updates the HTML title and the file list", async ({ page }) => {
  await openNewDocument(page);
  await expect(page).toHaveTitle("Untitled – Ligma");

  const nameField = page.getByTestId("doc-name");
  await nameField.fill("Brand Board");
  await nameField.press("Enter");
  await expect(page).toHaveTitle("Brand Board – Ligma");

  await page.getByTitle("Back to your files").click();
  await expect(page.getByText("Brand Board")).toBeVisible();
});

test("autosave: drawing persists across reload without pressing Save", async ({ page }) => {
  const id = await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);

  // The debounced autosave fires and flashes the saved state.
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible({ timeout: 5000 });

  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();
});

test("navigating home flushes unsaved changes immediately", async ({ page }) => {
  const id = await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);

  // Leave before the autosave debounce elapses.
  await page.getByTitle("Back to your files").click();
  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();
});

test("documents persist through the worker across reload", async ({ page }) => {
  const id = await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 500, 350);
  // Text placed inside the frame becomes its child; selecting it
  // auto-expands the frame, so the row appears without clicking.
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250);
  await expect(layers(page).getByText("Text 1")).toBeVisible();

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();

  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Frame 1")).toBeVisible();
  await expandLayer(page, "Frame 1");
  await expect(layers(page).getByText("Text 1")).toBeVisible();
});

test("marquee select, zoom, and pan survive a workout", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);
  await page.keyboard.press("r");
  await drag(page, 400, 200, 500, 280);

  // Marquee across both rectangles.
  await drag(page, 200, 150, 550, 330);
  await expect(page.getByText("2 layers selected")).toBeVisible();

  // Zoom in/out around the cursor (pinch arrives as ctrl+wheel), then pan.
  const box = await canvasBox(page);
  await page.mouse.move(box.x + 300, box.y + 250);
  await page.mouse.wheel(0, -400);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.mouse.wheel(0, 300);
  await page.keyboard.up("Control");
  await expect(page.locator("canvas")).toBeVisible();
});

test("⌘+ and ⌘− zoom the canvas", async ({ page }) => {
  await openNewDocument(page);
  const zoom = async () => (await sceneOf(page)).zoom as number;
  const before = await zoom();
  await page.keyboard.press("Meta+Equal");
  expect(await zoom()).toBeGreaterThan(before);
  await page.keyboard.press("Meta+Minus");
  await page.keyboard.press("Meta+Minus");
  expect(await zoom()).toBeLessThan(before);
});

test("inline text edit opens with no visual glyph shift", async ({ page }) => {
  await openNewDocument(page);
  await page.evaluate(() => (document as any).fonts.ready);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250); // places the default text node
  await clickCanvas(page, 700, 450); // deselect: no selection chrome near the glyphs

  const box = await canvasBox(page);
  const s = await sceneOf(page);
  const n = s.nodes[0];
  const rect = {
    x: n.x * s.zoom + s.panX,
    y: n.y * s.zoom + s.panY,
    w: n.w * s.zoom,
    h: n.h * s.zoom,
  };
  const clip = {
    x: box.x + rect.x - 8,
    y: box.y + rect.y - 12,
    width: rect.w + 16,
    height: rect.h + 24,
  };

  // Locate the dark glyph pixels inside a region screenshot, decoded in
  // the browser (no Node-side PNG dependency).
  const glyphPos = async () => {
    const shot = await page.screenshot({ clip });
    return page.evaluate(async (b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let top = Infinity;
      let left = Infinity;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum < 100) {
            if (y < top) top = y;
            if (x < left) left = x;
          }
        }
      }
      return { top, left };
    }, shot.toString("base64"));
  };

  const before = await glyphPos();
  expect(before.top).not.toBe(Infinity); // sanity: glyphs found on canvas

  await page.mouse.dblclick(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
  await expect(page.getByTestId("text-editor")).toBeVisible();
  const during = await glyphPos();

  expect(Math.abs(during.top - before.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(during.left - before.left)).toBeLessThanOrEqual(2);
});

test("drawing inside a frame nests the shape under it in the outliner", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 600, 400);
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 300);

  const s = await sceneOf(page);
  expect(s.nodes.length).toBe(1);
  expect(s.nodes[0].children.map((c: any) => c.kind)).toEqual(["rect"]);

  // The new child is selected, which auto-reveals it in the outliner;
  // the chevron now collapses it and expands it again.
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();
  await layers(page).getByTitle("Collapse").click();
  await expect(layers(page).getByText("Rectangle 1")).not.toBeVisible();
  await expandLayer(page, "Frame 1");
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();

  // The nested child stays directly selectable on the canvas.
  await clickCanvas(page, 300, 250);
  const sel = (await sceneOf(page)).selection;
  expect(sel).toEqual([s.nodes[0].children[0].id]);
});

test("right-click context menu: z-order, copy and paste", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 200, 200, 300, 300);
  await page.keyboard.press("r");
  await drag(page, 250, 250, 350, 350);
  const order = async () => (await sceneOf(page)).nodes.map((n: any) => n.name);
  expect(await order()).toEqual(["Rectangle 1", "Rectangle 2"]);

  const box = await canvasBox(page);
  const menu = page.getByTestId("context-menu");
  await page.mouse.click(box.x + 210, box.y + 210, { button: "right" });
  await expect(menu).toBeVisible();
  await menu.getByText("Bring to front").click();
  expect(await order()).toEqual(["Rectangle 2", "Rectangle 1"]);

  await page.mouse.click(box.x + 210, box.y + 210, { button: "right" });
  await menu.getByText("Copy", { exact: true }).click();
  await page.mouse.click(box.x + 550, box.y + 200, { button: "right" });
  await menu.getByText("Paste").click();
  await expect.poll(async () => (await sceneOf(page)).nodes.length).toBe(3);
});

test("multi-selection resizes through the joint bbox handles", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 200, 200, 250, 250);
  await page.keyboard.press("r");
  await drag(page, 300, 300, 350, 350);

  await clickCanvas(page, 225, 225);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 325, 325);
  await page.keyboard.up("Shift");
  expect((await sceneOf(page)).selection.length).toBe(2);

  // Drag the bottom-right bbox handle: 150×150 bbox doubles to 300×300.
  // Assertions are relative (pan-independent): both 50×50 rects double,
  // and the 100px gap between their origins doubles too.
  await drag(page, 350, 350, 500, 500);
  const nodes = (await sceneOf(page)).nodes;
  expect(nodes[0].w).toBe(100);
  expect(nodes[1].w).toBe(100);
  expect(nodes[1].x - nodes[0].x).toBe(200);
});

test("color picker: hex entry, SV drag coalesces undo, eyedropper samples the canvas", async ({
  page,
}) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 200, 200, 300, 300);

  const fillOf = async (i: number) => (await sceneOf(page)).nodes[i].fills[0];

  // Hex entry through the picker.
  await page.getByTestId("swatch-fills-0").click();
  const picker = page.getByTestId("color-picker");
  await expect(picker).toBeVisible();
  const hexField = page.getByTestId("picker-hex");
  await hexField.fill("FF0000");
  await hexField.press("Enter");
  expect((await fillOf(0)).color).toBe("#ff0000");

  // Dragging in the SV square fires many live updates → one undo step.
  const sv = (await page.getByTestId("sv-square").boundingBox())!;
  await page.mouse.move(sv.x + sv.width - 2, sv.y + 2);
  await page.mouse.down();
  await page.mouse.move(sv.x + sv.width - 2, sv.y + sv.height / 2, { steps: 10 });
  await page.mouse.up();
  expect((await fillOf(0)).color).not.toBe("#ff0000");
  await page.keyboard.press("Meta+z");
  expect((await fillOf(0)).color).toBe("#ff0000");
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();

  // Eyedropper: a second rect adopts the red rect's pixel color.
  await page.keyboard.press("r");
  await drag(page, 450, 200, 550, 300);
  await page.getByTestId("swatch-fills-0").click();
  await page.getByTitle("Pick color from canvas").click();
  await clickCanvas(page, 250, 250); // sample inside the red rectangle
  await expect.poll(async () => (await fillOf(1)).color).toBe("#ff0000");
});

test("blend modes composite on the canvas and survive reload", async ({ page }) => {
  const id = await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 200, 200, 300, 300);
  await page.keyboard.press("r");
  await drag(page, 250, 250, 350, 350);
  await page.evaluate(() => {
    const e = (window as any).__engine;
    const s = JSON.parse(e.scene());
    e.update_paint(s.nodes[0].id, "fills", 0, "#ff0000", 1);
    e.update_paint(s.nodes[1].id, "fills", 0, "#00ff00", 1);
  });

  // Sample the overlap: green wins while the top rect is "normal".
  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);
  await expect.poll(() => pixelAt(275, 275)).toEqual([0, 255, 0]);

  // Multiply: red × green = black.
  await page.getByTestId("blend-mode").selectOption("multiply");
  await expect.poll(() => pixelAt(275, 275)).toEqual([0, 0, 0]);

  // The mode persists through save + reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Rectangle 2")).toBeVisible(); // engine loaded
  await expect
    .poll(async () => (await sceneOf(page)).nodes[1].blendMode)
    .toBe("multiply");
});

test("multiplayer: peer cursors appear and saves sync live", async ({ page, browser }) => {
  const id = await openNewDocument(page);

  // A second editor in an isolated context (its own presence identity).
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => errors.push(String(e)));
  page2.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text()))
      errors.push(m.text());
  });
  await page2.goto(`http://localhost:5173/d/${id}`);
  await expect(page2.locator("canvas")).toBeVisible();

  // Moving the mouse on page 1 paints a labelled cursor on page 2.
  for (let i = 0; i < 5; i++) {
    await hoverSweep(page, 250 + i * 10, 250, 400 + i * 10, 320);
    if (await page2.getByTestId("peer-cursor").first().isVisible()) break;
    await page.waitForTimeout(300);
  }
  await expect(page2.getByTestId("peer-cursor").first()).toBeVisible();
  await expect(page2.getByTestId("peer-cursor").getByText(/Guest/)).toBeVisible();

  // Drawing on page 1 autosaves; the version broadcast refreshes page 2.
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 280);
  await expect(page2.getByTestId("layers").getByText("Rectangle 1")).toBeVisible({
    timeout: 10_000,
  });

  await ctx2.close();
});

test("images: place via File menu, drag-drop, render and persist", async ({ page }) => {
  const id = await openNewDocument(page);

  // A deterministic 60×40 red PNG, generated in-page.
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 60;
    c.height = 40;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 60, 40);
    return c.toDataURL("image/png").split(",")[1];
  });
  const buffer = Buffer.from(b64, "base64");

  // Place via File ▸ Place image…
  await page.getByRole("button", { name: "File" }).click();
  await page.getByRole("button", { name: "Place image…" }).click();
  await page
    .getByTestId("image-input")
    .setInputFiles({ name: "red.png", mimeType: "image/png", buffer });
  await expect(layers(page).getByText("Image 1")).toBeVisible();

  // The bitmap really renders: sample the node's center pixel.
  const s = await sceneOf(page);
  const n = s.nodes[0];
  const cx = (n.x + n.w / 2) * s.zoom + s.panX;
  const cy = (n.y + n.h / 2) * s.zoom + s.panY;
  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);
  await expect.poll(() => pixelAt(cx, cy)).toEqual([255, 0, 0]);

  // Drag-drop places a second image at the drop point.
  const box = await canvasBox(page);
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0));
    dt.items.add(new File([bytes], "drop.png", { type: "image/png" }));
    return dt;
  }, b64);
  await page.dispatchEvent("canvas", "drop", {
    dataTransfer,
    clientX: box.x + 550,
    clientY: box.y + 200,
  });
  await expect(layers(page).getByText("Image 2")).toBeVisible();

  // Survives reload: document references the R2 asset. The camera
  // re-fits to content on load, so recompute the sample point.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Image 1")).toBeVisible();
  const s2 = await sceneOf(page);
  const n2 = s2.nodes[0];
  const cx2 = (n2.x + n2.w / 2) * s2.zoom + s2.panX;
  const cy2 = (n2.y + n2.h / 2) * s2.zoom + s2.panY;
  await expect.poll(() => pixelAt(cx2, cy2), { timeout: 10_000 }).toEqual([255, 0, 0]);
});

test("text wraps to its box and honors alignment", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250); // 160×24 default text box
  await page
    .locator("textarea")
    .fill("the quick brown fox jumps over the lazy dog repeatedly");
  await page.locator("textarea").blur();

  // The canvas wrapped it: SVG export (which reads the layout captured
  // by the last render) emits several <text> lines. Poll — the cache
  // updates on the next animation frame after the edit.
  const lineCount = () =>
    page.evaluate(() => {
      const e = (window as any).__engine;
      const s = JSON.parse(e.scene());
      const svg = e.export_svg(s.nodes[0].id) as string;
      return (svg.match(/<text /g) ?? []).length;
    });
  await expect.poll(lineCount).toBeGreaterThan(1);

  // Alignment buttons drive the engine and the export.
  await page.getByTestId("text-align-center").click();
  await page.getByTestId("text-valign-top").click();
  const n = (await sceneOf(page)).nodes[0];
  expect(n.textAlign).toBe("center");
  expect(n.textValign).toBe("top");
  const svg2 = await page.evaluate(() => {
    const e = (window as any).__engine;
    const s = JSON.parse(e.scene());
    return e.export_svg(s.nodes[0].id) as string;
  });
  expect(svg2).toContain('text-anchor="middle"');

  // Inline editing of multiline text: Enter inserts a newline.
  const box = await canvasBox(page);
  const sc = await sceneOf(page);
  const tn = sc.nodes[0];
  await page.mouse.dblclick(
    box.x + (tn.x + tn.w / 2) * sc.zoom + sc.panX,
    box.y + (tn.y + tn.h / 2) * sc.zoom + sc.panY,
  );
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("first");
  await editor.press("Enter");
  await editor.pressSequentially("second");
  await editor.press("Escape");
  expect((await sceneOf(page)).nodes[0].text).toBe("first\nsecond");
});

test("outliner: dragging rows reorders and reparents layers", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 500, 350);
  await page.keyboard.press("r");
  await drag(page, 600, 150, 700, 250); // outside the frame
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();

  // HTML5 drag: Rectangle 1's row into the middle of Frame 1's row.
  const srcRow = layers(page).locator("[data-layer]", { hasText: "Rectangle 1" });
  const dstRow = layers(page).locator("[data-layer]", { hasText: "Frame 1" });
  const dst = (await dstRow.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await srcRow.dispatchEvent("dragstart", { dataTransfer });
  await dstRow.dispatchEvent("dragover", {
    dataTransfer,
    clientX: dst.x + dst.width / 2,
    clientY: dst.y + dst.height / 2, // middle = "into"
  });
  await dstRow.dispatchEvent("drop", { dataTransfer });

  const s = await sceneOf(page);
  expect(s.nodes.length).toBe(1);
  expect(s.nodes[0].children.map((c: any) => c.name)).toEqual(["Rectangle 1"]);
  // The drop auto-expands the frame, so the nested row is visible.
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();

  // Drag it back out: below the frame row (bottom edge = "below" =
  // earlier in z-order at the root).
  const src2 = layers(page).locator("[data-layer]", { hasText: "Rectangle 1" });
  const dt2 = await page.evaluateHandle(() => new DataTransfer());
  await src2.dispatchEvent("dragstart", { dataTransfer: dt2 });
  const dst2 = (await dstRow.boundingBox())!;
  await dstRow.dispatchEvent("dragover", {
    dataTransfer: dt2,
    clientX: dst2.x + dst2.width / 2,
    clientY: dst2.y + dst2.height - 2, // bottom = "below"
  });
  await dstRow.dispatchEvent("drop", { dataTransfer: dt2 });

  const s2 = await sceneOf(page);
  expect(s2.nodes.map((n: any) => n.name)).toEqual(["Rectangle 1", "Frame 1"]);
  expect(s2.nodes[1].children.length).toBe(0);
});

test("text: choosing a Google Font loads it and re-renders", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250);

  await page.getByTestId("font-family").selectOption("Space Mono");
  expect((await sceneOf(page)).nodes[0].fontFamily).toBe("Space Mono");

  // The Google Fonts stylesheet was injected and the face becomes
  // available to the document (the canvas picks it up next frame).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          await (document as any).fonts.load("16px 'Space Mono'");
          return (document as any).fonts.check("16px 'Space Mono'");
        }),
      { timeout: 10_000 },
    )
    .toBe(true);

  // Persists through the engine round trip.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
});

test("comments: pin, read, resolve, and live-sync to other editors", async ({
  page,
  browser,
}) => {
  const id = await openNewDocument(page);

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => errors.push(String(e)));
  page2.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text()))
      errors.push(m.text());
  });
  await page2.goto(`http://localhost:5173/d/${id}`);
  await expect(page2.locator("canvas")).toBeVisible();

  // Comment mode (C), click the canvas, write, post.
  await page.keyboard.press("c");
  const box = await canvasBox(page);
  await page.mouse.click(box.x + 300, box.y + 250);
  await page.getByTestId("comment-input").fill("Make this pop");
  await page.getByTestId("comment-post").click();
  await expect(page.getByTestId("comment-pin")).toBeVisible();

  // The presence broadcast delivers it to the other editor live.
  await expect(page2.getByTestId("comment-pin")).toBeVisible({ timeout: 10_000 });

  // Read and resolve from the second editor; both sides clear.
  await page2.getByTestId("comment-pin").click();
  await expect(page2.getByTestId("comment-popover")).toContainText("Make this pop");
  await page2.getByRole("button", { name: "Resolve" }).click();
  await expect(page2.getByTestId("comment-pin")).toHaveCount(0);
  await expect(page.getByTestId("comment-pin")).toHaveCount(0, { timeout: 10_000 });

  await ctx2.close();
});

test("chat: messages broadcast live between editors", async ({ page, browser }) => {
  const id = await openNewDocument(page);

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => errors.push(String(e)));
  page2.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text()))
      errors.push(m.text());
  });
  await page2.goto(`http://localhost:5173/d/${id}`);
  await expect(page2.locator("canvas")).toBeVisible();
  await page2.waitForTimeout(500); // let the presence socket open

  await page.getByTestId("chat-toggle").click();
  await page.getByTestId("chat-input").fill("hello from page one");
  await page.getByTestId("chat-input").press("Enter");
  await expect(page.getByTestId("chat-message")).toContainText("hello from page one");

  // Unread badge on the second editor, then the message itself.
  await page2.getByTestId("chat-toggle").click();
  await expect(page2.getByTestId("chat-message")).toContainText("hello from page one", {
    timeout: 10_000,
  });

  await ctx2.close();
});

test("pen tool: open path, smooth anchor, closed triangle, persistence", async ({ page }) => {
  const id = await openNewDocument(page);

  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);

  // Open zig-zag: two corner clicks, then a click-drag (smooth anchor).
  await page.keyboard.press("p");
  await clickCanvas(page, 200, 200);
  await clickCanvas(page, 300, 200);
  await drag(page, 300, 280, 340, 320);
  await page.keyboard.press("Enter");

  let s = await sceneOf(page);
  expect(s.tool).toBe("select");
  const open = s.nodes[0];
  expect(open.kind).toBe("path");
  expect(open.points.length).toBe(3);
  expect(open.closed).toBe(false);
  expect(open.fills.length).toBe(0);
  expect(open.strokes.length).toBe(1);
  // The drag dragged out mirrored handles on the last anchor.
  const smooth = open.points[2];
  expect(smooth.hxOut).not.toBe(smooth.x);
  expect(smooth.hxIn).toBeCloseTo(2 * smooth.x - smooth.hxOut, 5);

  // The stroke renders where it was drawn: a dark pixel on the first
  // segment (antialiasing makes exact equality fragile; just "dark").
  await expect.poll(async () => (await pixelAt(250, 200))[0]).toBeLessThan(160);

  // Closed triangle: clicking the first anchor again closes the path.
  await page.keyboard.press("p");
  await clickCanvas(page, 450, 350);
  await clickCanvas(page, 550, 350);
  await clickCanvas(page, 500, 430);
  await clickCanvas(page, 450, 350);

  s = await sceneOf(page);
  const tri = s.nodes[1];
  expect(tri.kind).toBe("path");
  expect(tri.closed).toBe(true);
  expect(tri.fills.length).toBe(1);
  // Solid interior pixel: the default #d4d4d8 fill.
  await expect.poll(() => pixelAt(500, 380)).toEqual([212, 212, 216]);

  // Clicking a stroke segment selects the open path; the empty corner of
  // its bbox does not.
  await clickCanvas(page, 250, 200);
  expect((await sceneOf(page)).selection).toEqual([open.id]);
  await clickCanvas(page, 210, 260); // inside bbox, far from the curve
  expect((await sceneOf(page)).selection).toEqual([]);

  // Paths persist through save + reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Path 1")).toBeVisible();
  await expect.poll(async () => (await sceneOf(page)).nodes.length).toBe(2);
  const reloaded = (await sceneOf(page)).nodes[1];
  expect(reloaded.closed).toBe(true);
  expect(reloaded.points.length).toBe(3);
});

test("path editing: double-click to edit, drag anchors, toggle smooth, escape", async ({
  page,
}) => {
  await openNewDocument(page);

  // Draw an L with the pen: three corner anchors.
  await page.keyboard.press("p");
  await clickCanvas(page, 200, 200);
  await clickCanvas(page, 300, 200);
  await clickCanvas(page, 300, 300);
  await page.keyboard.press("Enter");
  const pathId = (await sceneOf(page)).nodes[0].id;

  // Double-click a segment to enter vector-edit mode.
  const box = await canvasBox(page);
  await page.mouse.dblclick(box.x + 250, box.y + 200);
  await expect.poll(async () => (await sceneOf(page)).pathEdit).toBe(pathId);

  // Drag the corner anchor at screen (300,200) up and to the right.
  // World ≠ screen (the camera pans on load), so assert the delta.
  const before = (await sceneOf(page)).nodes[0].points[1];
  await drag(page, 300, 200, 340, 160);
  let pts = (await sceneOf(page)).nodes[0].points;
  expect(pts[1].x).toBeCloseTo(before.x + 40, 5);
  expect(pts[1].y).toBeCloseTo(before.y - 40, 5);
  // Bounds follow the anchors (the dragged one is now topmost).
  expect((await sceneOf(page)).nodes[0].y).toBeCloseTo(pts[1].y, 5);

  // Double-click the anchor: corner becomes smooth (handles appear).
  await page.mouse.dblclick(box.x + 340, box.y + 160);
  pts = (await sceneOf(page)).nodes[0].points;
  expect(pts[1].hxOut).not.toBe(pts[1].x);
  // Still in edit mode after a toggle.
  expect((await sceneOf(page)).pathEdit).toBe(pathId);

  // Drag the anchor to 4px shy of the bottom anchor's x: it snaps on.
  await drag(page, 340, 160, 304, 140);
  pts = (await sceneOf(page)).nodes[0].points;
  expect(pts[1].x).toBe(pts[2].x);

  // Escape leaves edit mode but keeps the path selected.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sceneOf(page)).pathEdit).toBe(null);
  expect((await sceneOf(page)).selection).toEqual([pathId]);

  // A second Escape clears the selection as usual.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sceneOf(page)).selection).toEqual([]);
});

test("flatten merges shapes with even-odd holes; frame selection wraps", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 200, 200, 400, 400);
  await page.keyboard.press("r");
  await drag(page, 300, 300, 500, 500);

  // Select both and flatten from the context menu.
  await clickCanvas(page, 250, 250);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 450, 450);
  await page.keyboard.up("Shift");
  const box = await canvasBox(page);
  await page.mouse.click(box.x + 250, box.y + 250, { button: "right" });
  await page.getByTestId("context-menu").getByText("Flatten").click();

  let s = await sceneOf(page);
  expect(s.nodes.length).toBe(1);
  expect(s.nodes[0].kind).toBe("path");
  expect(s.nodes[0].inner.length).toBe(1);

  // The overlap square is a hole: its pixel shows the canvas background.
  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);
  await expect.poll(() => pixelAt(350, 350)).toEqual([233, 233, 236]);
  await expect.poll(() => pixelAt(250, 250)).toEqual([212, 212, 216]);

  // ⌥⌘G wraps the flattened path in a frame sized to it.
  await page.keyboard.press("Alt+Meta+g");
  s = await sceneOf(page);
  expect(s.nodes.length).toBe(1);
  expect(s.nodes[0].kind).toBe("frame");
  expect(s.nodes[0].children.map((c: any) => c.kind)).toEqual(["path"]);
  expect(s.nodes[0].w).toBe(300);
  await expect(layers(page).getByText("Frame 1")).toBeVisible();
});

test("pathfinder: union and subtract from the context menu", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 200, 200, 400, 400);
  await page.keyboard.press("r");
  await drag(page, 300, 300, 500, 500);
  await clickCanvas(page, 250, 250);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 450, 450);
  await page.keyboard.up("Shift");

  const box = await canvasBox(page);
  await page.mouse.click(box.x + 250, box.y + 250, { button: "right" });
  await page.getByTestId("context-menu").getByText("Subtract").click();

  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);

  // The L remains: subject-only solid, overlap and top-only cut away.
  // The op is non-destructive: a bool group with both sources inside.
  let s = await sceneOf(page);
  expect(s.nodes.length).toBe(1);
  expect(s.nodes[0].kind).toBe("bool");
  expect(s.nodes[0].boolOp).toBe("subtract");
  expect(s.nodes[0].children.length).toBe(2);
  await expect.poll(() => pixelAt(250, 250)).toEqual([212, 212, 216]);
  await expect.poll(() => pixelAt(350, 350)).toEqual([233, 233, 236]);
  await expect.poll(() => pixelAt(450, 450)).toEqual([233, 233, 236]);

  // Undo restores both rects; union merges them into one solid.
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await sceneOf(page)).nodes.length).toBe(2);
  await clickCanvas(page, 250, 250);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 450, 450);
  await page.keyboard.up("Shift");
  await page.mouse.click(box.x + 250, box.y + 250, { button: "right" });
  await page.getByTestId("context-menu").getByText("Union").click();
  s = await sceneOf(page);
  expect(s.nodes.length).toBe(1);
  await expect.poll(() => pixelAt(350, 350)).toEqual([212, 212, 216]);

  // Editing a source inside the union updates the render live: drag the
  // top rect away so the former overlap zone empties out.
  const target = box; // reuse canvas box
  await page.mouse.dblclick(target.x + 450, target.y + 450); // deep select top rect
  await drag(page, 450, 450, 650, 450); // move it right by 200
  await expect.poll(() => pixelAt(310, 450)).toEqual([233, 233, 236]);
  await expect.poll(() => pixelAt(610, 450)).toEqual([212, 212, 216]);

  // Flatten (⌘E) bakes the boolean into a real path.
  await page.keyboard.press("Escape");
  await clickCanvas(page, 250, 250);
  await page.keyboard.press("Meta+e");
  await expect
    .poll(async () => {
      const sc = await sceneOf(page);
      return [sc.nodes.length, sc.nodes[0].kind];
    })
    .toEqual([1, "path"]);
});

test("rich text: ⌘B styles the selection; panel buttons style all", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 300);
  await page.keyboard.press("Escape"); // commit the default "Text"

  const darkPixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const d = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++;
      return n;
    });
  await expect.poll(darkPixels).toBeGreaterThan(0);
  const before = await darkPixels();

  // Edit, select "Tex" (3 chars), bold it via ⌘B, commit.
  const box = await canvasBox(page);
  await page.mouse.dblclick(box.x + 305, box.y + 300);
  const editor = page.getByTestId("text-editor");
  await editor.waitFor();
  // Select the first 3 chars ("Tex") in the contenteditable.
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Meta+b");
  await page.keyboard.press("Escape");

  let s = await sceneOf(page);
  expect(s.nodes[0].spans).toEqual([{ start: 0, len: 3, bold: true, italic: false, color: "", size: 0, family: "" }]);
  // Bold glyphs carry more ink.
  await expect.poll(darkPixels).toBeGreaterThan(before);

  // The panel's B button styles the whole text; clicking again clears.
  await page.getByTestId("text-bold").click();
  s = await sceneOf(page);
  expect(s.nodes[0].spans).toEqual([{ start: 0, len: 4, bold: true, italic: false, color: "", size: 0, family: "" }]);
  await page.getByTestId("text-bold").click();
  s = await sceneOf(page);
  expect(s.nodes[0].spans).toEqual([]);

  // Italic via the panel survives reload.
  await page.getByTestId("text-italic").click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.reload();
  await expect(layers(page).getByText("Text 1")).toBeVisible();
  await expect
    .poll(async () => (await sceneOf(page)).nodes[0].spans)
    .toEqual([{ start: 0, len: 4, bold: false, italic: true, color: "", size: 0, family: "" }]);
});

test("frames clip their children's rendering", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 200, 400, 400);
  await page.keyboard.press("r");
  await drag(page, 300, 250, 380, 330); // child inside the frame

  // Stretch the child far past the frame's right edge.
  const wField = page.locator("label", { hasText: "W" }).locator("input");
  await wField.fill("400");
  await wField.press("Enter");

  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);

  // Inside the frame the child shows; past the frame edge it's clipped
  // to the canvas background.
  await expect.poll(() => pixelAt(390, 290)).toEqual([212, 212, 216]);
  await expect.poll(() => pixelAt(450, 290)).toEqual([233, 233, 236]);
});

test("linear gradient fills: toggle, render across the axis, persist", async ({ page }) => {
  const id = await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 300, 200, 500, 400);

  // Make it red, then toggle the fill to a linear gradient (red → white,
  // 90° = top-to-bottom).
  await page.evaluate(() => {
    const e = (window as any).__engine;
    const s = JSON.parse(e.scene());
    e.update_paint(s.nodes[0].id, "fills", 0, "#ff0000", 1);
  });
  await page.getByTestId("gradient-toggle-0").click();

  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);

  // Near the top: red dominates; near the bottom: almost white.
  await expect.poll(async () => (await pixelAt(400, 210))[1]).toBeLessThan(80);
  await expect.poll(async () => (await pixelAt(400, 390))[1]).toBeGreaterThan(200);

  // The gradient survives save + reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Rectangle 1")).toBeVisible();
  await expect
    .poll(async () => (await sceneOf(page)).nodes[0].fills[0].kind)
    .toBe("linear");

  // The toggle cycles on: linear → radial (center red, edges white),
  // then back to solid. The reload re-fit the camera, so compute screen
  // points from the live scene.
  const s2 = await sceneOf(page);
  const rect = s2.nodes[0];
  const sx = (wx: number) => wx * s2.zoom + s2.panX;
  const sy = (wy: number) => wy * s2.zoom + s2.panY;
  await clickCanvas(page, sx(rect.x + rect.w / 2), sy(rect.y + rect.h / 2));
  await page.getByTestId("gradient-toggle-0").click();
  expect((await sceneOf(page)).nodes[0].fills[0].kind).toBe("radial");
  await expect
    .poll(async () => (await pixelAt(sx(rect.x + rect.w / 2), sy(rect.y + rect.h / 2)))[1])
    .toBeLessThan(80);
  await expect
    .poll(async () => (await pixelAt(sx(rect.x + 4), sy(rect.y + 4)))[1])
    .toBeGreaterThan(180);
  await page.getByTestId("gradient-toggle-0").click();
  expect((await sceneOf(page)).nodes[0].fills[0].kind).toBe("solid");
});

test("text toolbar: color dots tint the selection", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 300);
  await page.keyboard.press("Escape");

  const box = await canvasBox(page);
  await page.mouse.dblclick(box.x + 305, box.y + 300);
  await expect(page.getByTestId("text-toolbar")).toBeVisible();
  await page.getByTestId("text-editor").waitFor();
  await page.keyboard.press("Meta+a");
  await page.getByTestId("span-color-ef4444").click();
  // Styling shows live in the editor before any commit.
  await expect
    .poll(() =>
      page
        .getByTestId("text-editor")
        .evaluate((el) => (el.querySelector("span") as HTMLElement)?.style.color),
    )
    .toBe("rgb(239, 68, 68)");
  await page.keyboard.press("Escape");

  const s = await sceneOf(page);
  expect(s.nodes[0].spans).toEqual([
    { start: 0, len: 4, bold: false, italic: false, color: "#ef4444", size: 0, family: "" },
  ]);

  // Red ink actually lands on the canvas.
  const redPixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const d = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4)
        if (d[i] > 180 && d[i + 1] < 120 && d[i + 2] < 120) n++;
      return n;
    });
  await expect.poll(redPixels).toBeGreaterThan(0);
});

test("gradient handle: dragging re-aims the linear gradient", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 300, 200, 500, 400);
  await page.getByTestId("gradient-toggle-0").click(); // linear, 90°

  const handle = page.getByTestId("gradient-handle");
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;

  // Drag the handle from below the center (90°) to the right (≈0°).
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  const box = await canvasBox(page);
  await page.mouse.move(box.x + 480, box.y + 300, { steps: 8 });
  await page.mouse.up();

  const angle = (await sceneOf(page)).nodes[0].fills[0].angle;
  expect(Math.abs(angle)).toBeLessThan(10);

  // One undo restores the original aim.
  await page.keyboard.press("Meta+z");
  expect((await sceneOf(page)).nodes[0].fills[0].angle).toBe(90);
});

test("components: create master, place instance, master edits propagate", async ({ page }) => {
  const id = await openNewDocument(page);
  await page.keyboard.press("r");
  await drag(page, 250, 250, 350, 350);
  await page.keyboard.press("Alt+Meta+k");
  await expect(layers(page).getByText("Component 1")).toBeVisible();

  // Select the master via its outliner row (clicking the canvas would
  // hit the child rect), then place an instance from the Object menu.
  await layers(page).getByText("Component 1").click();
  await page.getByRole("button", { name: "Object" }).click();
  await page.getByRole("button", { name: "Create instance" }).click();
  let s = await sceneOf(page);
  expect(s.nodes.map((n: any) => n.kind)).toEqual(["component", "instance"]);
  const inst = s.nodes[1];
  expect(inst.component).toBe(s.nodes[0].id);

  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);
  // The instance mirrors the master's gray rect at +124px.
  await expect.poll(() => pixelAt(424, 300)).toEqual([212, 212, 216]);

  // Recolor the rect inside the master: the instance follows live.
  await page.evaluate(() => {
    const e = (window as any).__engine;
    const s = JSON.parse(e.scene());
    e.update_paint(s.nodes[0].children[0].id, "fills", 0, "#ff0000", 1);
  });
  await expect.poll(() => pixelAt(424, 300)).toEqual([255, 0, 0]);

  // Persists through save + reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.goto(`/d/${id}`);
  // Master and instance share the name, so two rows match.
  await expect(layers(page).getByText("Component 1")).toHaveCount(2);
  await expect
    .poll(async () => (await sceneOf(page)).nodes.map((n: any) => n.kind))
    .toEqual(["component", "instance"]);
});

test("editing text hides the canvas copy, even inside a frame", async ({ page }) => {
  await openNewDocument(page);
  await page.evaluate(() => (document as any).fonts.ready);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 560, 420);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250); // text node nested in the frame
  await page.keyboard.press("Escape"); // deselect; selection chrome away

  const box = await canvasBox(page);
  const s = await sceneOf(page);
  const n = s.nodes[0].children[0];
  expect(n.kind).toBe("text");
  const rect = {
    x: n.x * s.zoom + s.panX,
    y: n.y * s.zoom + s.panY,
    w: n.w * s.zoom,
    h: n.h * s.zoom,
  };

  // Dark engine-drawn glyph pixels inside the node's box. getImageData
  // reads the canvas only, so the DOM textarea (and its caret) never
  // pollute the count.
  const glyphPixels = () =>
    page.evaluate((r) => {
      const canvas = document.querySelector("canvas")!;
      const cr = canvas.getBoundingClientRect();
      const dpr = canvas.width / cr.width;
      const d = canvas
        .getContext("2d")!
        .getImageData(r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum < 100) dark++;
      }
      return dark;
    }, rect);

  await expect.poll(glyphPixels).toBeGreaterThan(20); // "Text" drawn

  // While the overlay edits the node, the canvas stops drawing it: the
  // glyphs the user sees are the textarea's alone, so typing can't
  // overlap the stale committed text.
  await page.mouse.dblclick(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
  await expect(page.getByTestId("text-editor")).toBeVisible();
  await expect.poll(glyphPixels).toBe(0);

  // Committing brings the (new) text back to the canvas.
  await page.keyboard.type("Bye");
  await page.keyboard.press("Escape");
  await expect.poll(glyphPixels).toBeGreaterThan(20);
  await expect.poll(async () => (await sceneOf(page)).nodes[0].children[0].text).toBe("Bye");
});

test("panel W field resizes frame and group contents proportionally", async ({ page }) => {
  await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 400, 350); // 200x200 frame
  await page.keyboard.press("r");
  await drag(page, 250, 200, 300, 250); // 50x50 child at +50,+50

  // Select the frame and double its width through the panel.
  await page.keyboard.press("Escape");
  await layers(page).getByText("Frame 1").click();
  const wField = page.locator("label", { hasText: "W" }).locator("input");
  await wField.fill("400");
  await wField.press("Enter");
  await expect
    .poll(async () => {
      const f = (await sceneOf(page)).nodes[0];
      return [f.w, f.children[0].w, f.children[0].x - f.x];
    })
    .toEqual([400, 100, 100]);

  // Groups expose W/H too now, scaling the same way.
  await page.keyboard.press("r");
  await drag(page, 700, 150, 750, 200);
  await page.keyboard.press("r");
  await drag(page, 760, 150, 800, 200);
  await clickCanvas(page, 725, 175);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 780, 175);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Meta+g");
  await expect(layers(page).getByText("Group 1")).toBeVisible();
  await wField.fill("200");
  await wField.press("Enter");
  await expect
    .poll(async () => {
      const g = (await sceneOf(page)).nodes.find((n: any) => n.kind === "group");
      return [g.w, g.children.map((c: any) => c.w)];
    })
    .toEqual([200, [100, 80]]);
});

test("shift constraints, edge-band resize, and snap-to-frame", async ({ page }) => {
  await openNewDocument(page);
  const box = await canvasBox(page);

  // Shift while drawing constrains to a square.
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 250, box.y + 200);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 370, box.y + 260, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect
    .poll(async () => {
      const n = (await sceneOf(page)).nodes[0];
      return [n.w, n.h];
    })
    .toEqual([120, 120]);

  // The whole edge is a grab band: hovering shows a resize cursor, and
  // dragging it resizes that axis only.
  await clickCanvas(page, 310, 260); // select
  await page.mouse.move(box.x + 370, box.y + 260); // right edge, mid-height
  await expect
    .poll(() => page.locator("canvas").evaluate((el) => el.style.cursor))
    .toBe("ew-resize");
  await drag(page, 370, 260, 450, 290);
  await expect
    .poll(async () => {
      const n = (await sceneOf(page)).nodes[0];
      return [n.w, n.h];
    })
    .toEqual([200, 120]);

  // Dragging a child's edge snaps to its parent frame's edge.
  await page.keyboard.press("Escape");
  await page.keyboard.press("f");
  await drag(page, 500, 150, 800, 450);
  await page.keyboard.press("r");
  await drag(page, 550, 200, 650, 300);
  await clickCanvas(page, 600, 250);
  await drag(page, 650, 250, 796, 250); // right edge lands 4px short of the frame edge
  await expect
    .poll(async () => {
      const f = (await sceneOf(page)).nodes.find((n: any) => n.kind === "frame");
      const c = f.children[0];
      return c.x + c.w === f.x + f.w;
    })
    .toBe(true);
});

test("double-click deep-selects into groups; next one edits text", async ({ page }) => {
  await openNewDocument(page);
  const box = await canvasBox(page);

  // A group of a rect and a text node.
  await page.keyboard.press("r");
  await drag(page, 250, 200, 350, 300);
  await page.keyboard.press("t");
  await clickCanvas(page, 420, 240);
  await clickCanvas(page, 300, 250);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 440, 250);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Meta+g");
  await expect(layers(page).getByText("Group 1")).toBeVisible();

  // Single click selects the group; double-click descends to the rect.
  await clickCanvas(page, 300, 250);
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      return findKind(s.nodes, s.selection[0]);
    })
    .toBe("group");
  await page.mouse.dblclick(box.x + 300, box.y + 250);
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      return findKind(s.nodes, s.selection[0]);
    })
    .toBe("rect");

  // The deep-selected rect resizes through its own handles.
  await drag(page, 350, 300, 380, 330); // SE corner of the rect
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      const g = s.nodes.find((n: any) => n.kind === "group");
      return g.children.find((c: any) => c.kind === "rect").w;
    })
    .toBe(130);

  // Double-click on the grouped text first selects it, then opens the
  // inline editor.
  await page.mouse.dblclick(box.x + 440, box.y + 250);
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      return findKind(s.nodes, s.selection[0]);
    })
    .toBe("text");
  await page.mouse.dblclick(box.x + 440, box.y + 250);
  await expect(page.getByTestId("text-editor")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("frame-interior drag marquees children; document colors fill the picker", async ({
  page,
}) => {
  await openNewDocument(page);

  // A frame with two child rects.
  await page.keyboard.press("f");
  await drag(page, 150, 150, 500, 450);
  await page.keyboard.press("r");
  await drag(page, 200, 200, 250, 250);
  await page.keyboard.press("r");
  await drag(page, 280, 200, 330, 250);
  await page.keyboard.press("Escape"); // deselect

  // Dragging across the frame's interior rubber-bands its children
  // instead of moving the frame.
  const before = (await sceneOf(page)).nodes[0].x;
  await drag(page, 190, 190, 340, 260);
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      return [s.nodes[0].x === before, s.selection.length];
    })
    .toEqual([true, 2]);

  // A plain click on the body still selects the frame.
  await clickCanvas(page, 170, 400);
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      return findKind(s.nodes, s.selection[0]);
    })
    .toBe("frame");

  // A click on one of the marquee'd children narrows the selection
  // to it (Figma behavior), so the panel shows its fills.
  await page.keyboard.press("Escape");
  await drag(page, 190, 190, 340, 260);
  await expect.poll(async () => (await sceneOf(page)).selection.length).toBe(2);
  await clickCanvas(page, 225, 225);
  await expect.poll(async () => (await sceneOf(page)).selection.length).toBe(1);

  // Color one child red, then apply it to the other through the
  // picker's document-colors row.
  await clickCanvas(page, 225, 225);
  await page.getByTestId("swatch-fills-0").click();
  const hexField = page.getByTestId("picker-hex");
  await hexField.fill("FF0000");
  await hexField.press("Enter");
  await page.keyboard.press("Escape");

  await clickCanvas(page, 305, 225);
  await page.getByTestId("swatch-fills-0").click();
  await page.getByTestId("doc-color-ff0000").click();
  await expect
    .poll(async () => {
      const f = (await sceneOf(page)).nodes[0];
      return f.children.map((c: any) => c.fills[0].color);
    })
    .toEqual(["#ff0000", "#ff0000"]);
});

test("pathfinder handles 3 shapes and preserves holes", async ({ page }) => {
  await openNewDocument(page);
  const box = await canvasBox(page);
  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);

  // Three rects in a row, overlapping their neighbors.
  await page.keyboard.press("r");
  await drag(page, 200, 200, 300, 300);
  await page.keyboard.press("r");
  await drag(page, 280, 200, 380, 300);
  await page.keyboard.press("r");
  await drag(page, 360, 200, 460, 300);
  await clickCanvas(page, 220, 250);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 330, 250);
  await clickCanvas(page, 440, 250);
  await page.keyboard.up("Shift");
  await page.mouse.click(box.x + 220, box.y + 250, { button: "right" });
  await page.getByTestId("context-menu").getByText("Union").click();
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      return [s.nodes.length, s.nodes[0].kind, s.nodes[0].children.length];
    })
    .toEqual([1, "bool", 3]);
  // Solid across the whole bar.
  for (const x of [220, 330, 440]) {
    await expect.poll(() => pixelAt(x, 250)).toEqual([212, 212, 216]);
  }

  // Subtract both top shapes from the bottom one instead: undo, reselect.
  await page.keyboard.press("Meta+z");
  await clickCanvas(page, 220, 250);
  await page.keyboard.down("Shift");
  await clickCanvas(page, 330, 250);
  await clickCanvas(page, 440, 250);
  await page.keyboard.up("Shift");
  await page.mouse.click(box.x + 220, box.y + 250, { button: "right" });
  await page.getByTestId("context-menu").getByText("Subtract").click();
  // Only the part of rect 1 not covered by rects 2/3 remains.
  await expect.poll(() => pixelAt(220, 250)).toEqual([212, 212, 216]);
  await expect.poll(() => pixelAt(330, 250)).toEqual([233, 233, 236]);
  await expect.poll(() => pixelAt(440, 250)).toEqual([233, 233, 236]);
});

test("outline stroke on an open path renders round caps and joins", async ({ page }) => {
  await openNewDocument(page);
  const box = await canvasBox(page);
  const pixelAt = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const canvas = document.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const d = canvas.getContext("2d")!.getImageData(px * dpr, py * dpr, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [x, y]);

  // Open L path with the pen, committed via Enter.
  await page.keyboard.press("p");
  await clickCanvas(page, 200, 200);
  await clickCanvas(page, 400, 200);
  await clickCanvas(page, 400, 400);
  await page.keyboard.press("Enter");

  // Bump the stroke weight (the second "W" field — the first is the
  // node's width), then outline via the Object menu.
  const wField = page.locator("label", { hasText: "W" }).locator("input").nth(1);
  await wField.fill("24");
  await wField.press("Enter");
  await page.getByRole("button", { name: "Object" }).click();
  await page.getByText("Outline stroke").click();
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      return [s.nodes.length, s.nodes[0].kind, s.nodes[0].name.includes("(stroke)")];
    })
    .toEqual([1, "path", true]);

  // The band is solid mid-leg; the round cap extends past the start; the
  // bend interior stays empty. Stroke color is the default dark ink.
  const dark = async (x: number, y: number) => (await pixelAt(x, y))[0] < 120;
  await expect.poll(() => dark(300, 200)).toBe(true); // horizontal leg
  await expect.poll(() => dark(400, 300)).toBe(true); // vertical leg
  await expect.poll(() => dark(192, 200)).toBe(true); // round start cap
  await expect.poll(() => dark(180, 200)).toBe(false); // beyond the cap
  await expect.poll(() => dark(340, 280)).toBe(false); // bend interior
});

test("text toolbar sets per-span font size and family", async ({ page }) => {
  await openNewDocument(page);
  await page.evaluate(() => (document as any).fonts.ready);
  const box = await canvasBox(page);

  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250);
  const s0 = await sceneOf(page);
  const n = s0.nodes[0];

  // Open the editor, select all, bump the size of the selection to 40.
  await page.mouse.dblclick(box.x + 320, box.y + 255);
  const ta = page.getByTestId("text-editor");
  await expect(ta).toBeVisible();
  await ta.press("Meta+a");
  const sizeField = page.getByTestId("span-size");
  await sizeField.click();
  await sizeField.fill("40");
  await sizeField.press("Enter");
  // The overlay must survive the focus trip through the toolbar, and
  // the styled run shows live at 40px in the editor DOM.
  await expect(ta).toBeVisible();
  await expect
    .poll(() => ta.evaluate((el) => (el.querySelector("span") as HTMLElement)?.style.fontSize))
    .toBe("40px");

  // Apply a family to the same selection through the dropdown.
  await ta.press("Meta+a");
  await page.getByTestId("span-family").selectOption("Lora");
  await expect
    .poll(() => ta.evaluate((el) => (el.querySelector("span") as HTMLElement)?.style.fontFamily))
    .toContain("Lora");

  // Commit: the engine receives the spans in one step, and the canvas
  // re-renders the run at 40px — far more ink than the 16px base.
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => {
      const sc = await sceneOf(page);
      const sp = sc.nodes[0].spans[0];
      return sp ? [sp.size, sp.family] : null;
    })
    .toEqual([40, "Lora"]);
  const darkCount = (r: { x: number; y: number; w: number; h: number }) =>
    page.evaluate((rr) => {
      const canvas = document.querySelector("canvas")!;
      const cr = canvas.getBoundingClientRect();
      const dpr = canvas.width / cr.width;
      const d = canvas
        .getContext("2d")!
        .getImageData(rr.x * dpr, rr.y * dpr, rr.w * dpr, rr.h * dpr).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 100) dark++;
      }
      return dark;
    }, r);
  // The 40px block is centered on the node box; sample a tall region
  // around it and expect far more ink than a 16px line could produce.
  const region = {
    x: n.x * s0.zoom + s0.panX - 10,
    y: n.y * s0.zoom + s0.panY - 30,
    w: 220,
    h: 90,
  };
  await expect.poll(() => darkCount(region)).toBeGreaterThan(300);

  // Survives reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.reload();
  await expect(page.locator("canvas")).toBeVisible();
  await expect
    .poll(async () => {
      const s = await sceneOf(page);
      const sp = s.nodes[0]?.spans?.[0];
      return sp ? [sp.size, sp.family] : null;
    })
    .toEqual([40, "Lora"]);
});
