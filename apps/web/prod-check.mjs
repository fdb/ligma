import { chromium } from "@playwright/test";

const BASE = "https://ligma.enigmeta.workers.dev";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

const res = await page.request.post(`${BASE}/api/documents`);
const { id } = await res.json();
await page.goto(`${BASE}/d/${id}`);
await page.waitForSelector("canvas");
const box = await page.locator("canvas").boundingBox();
const check = (label, ok) => {
  console.log(`${label}: ${ok ? "ok" : "FAILED"}`);
  if (!ok) process.exitCode = 1;
};
const pixelAt = (x, y) =>
  page.evaluate(([x, y]) => {
    const canvas = document.querySelector("canvas");
    const cr = canvas.getBoundingClientRect();
    const dpr = canvas.width / cr.width;
    const d = canvas.getContext("2d").getImageData(x * dpr, y * dpr, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
const dragm = async (x1, y1, x2, y2) => {
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  await page.mouse.move(box.x + x2, box.y + y2, { steps: 8 });
  await page.mouse.up();
};

// Frame with two rects.
await page.keyboard.press("f");
await dragm(150, 150, 500, 450);
await page.keyboard.press("r");
await dragm(200, 200, 250, 250);
await page.keyboard.press("r");
await dragm(280, 200, 330, 250);
await page.keyboard.press("Escape");

// Drag across the frame interior: the frame must NOT move (its white
// fill still covers (160,440)), and the two children get selected —
// nudge them and check both moved.
await dragm(190, 190, 340, 260);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(300);
check("frame stayed (white body at left edge)", (await pixelAt(160, 440))[0] === 255);
check("marquee'd child 1 nudged down", (await pixelAt(225, 251))[0] === 212);
check("marquee'd child 2 nudged down", (await pixelAt(305, 251))[0] === 212);

// Document colors: color child 1 red, then apply via doc swatch to child 2.
await page.mouse.click(box.x + 225, box.y + 227);
await page.getByTestId("swatch-fills-0").click();
await page.getByTestId("picker-hex").fill("FF0000");
await page.getByTestId("picker-hex").press("Enter");
await page.keyboard.press("Escape");
await page.mouse.click(box.x + 305, box.y + 227);
await page.getByTestId("swatch-fills-0").click();
await page.getByTestId("doc-color-ff0000").click();
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("doc-color swatch applied red", (await pixelAt(305, 227))[0] === 255 && (await pixelAt(305, 227))[1] === 0);

console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "console errors: none");
if (errors.length) process.exitCode = 1;
await browser.close();
