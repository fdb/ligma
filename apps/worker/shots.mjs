import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const res = await page.request.post("http://127.0.0.1:8787/api/documents");
const { id } = await res.json();
await page.goto(`http://localhost:5199/d/${id}`);
await page.waitForSelector("canvas");
await page.waitForTimeout(600);
const box = await page.locator("canvas").boundingBox();
await page.keyboard.press("r");
await page.mouse.move(box.x + 300, box.y + 200); await page.mouse.down();
await page.mouse.move(box.x + 500, box.y + 400, { steps: 6 }); await page.mouse.up();
await page.getByTestId("gradient-toggle-0").click();
await page.getByTestId("gradient-toggle-0").click(); // radial
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/ui-gradient.png" });
await browser.close();
