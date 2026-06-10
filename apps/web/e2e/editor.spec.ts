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
  await page.locator("select").nth(3).selectOption("svg");

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

test("documents persist through the worker across reload", async ({ page }) => {
  const id = await openNewDocument(page);
  await page.keyboard.press("f");
  await drag(page, 200, 150, 500, 350);
  await page.keyboard.press("t");
  await clickCanvas(page, 300, 250);
  await expect(layers(page).getByText("Text 1")).toBeVisible();

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved ✓")).toBeVisible();

  await page.goto(`/d/${id}`);
  await expect(layers(page).getByText("Frame 1")).toBeVisible();
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
