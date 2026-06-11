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
  expect(fills).toEqual([{ color: "#ff0000", opacity: 1 }]);
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
  // Text placed inside the frame becomes its child; expand to see it.
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250);
  await expandLayer(page, "Frame 1");
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

  // Escape leaves edit mode but keeps the path selected.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sceneOf(page)).pathEdit).toBe(null);
  expect((await sceneOf(page)).selection).toEqual([pathId]);

  // A second Escape clears the selection as usual.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sceneOf(page)).selection).toEqual([]);
});
