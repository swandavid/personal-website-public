/**
 * Capture the rover demo's paused still as its placeholder images, so the
 * page opens on exactly what the live demo draws once it has loaded.
 *
 * Needs the dev server running (bun run dev). Writes a square frame for
 * phones and a 16:10 frame for wider screens, matching the stage's aspect
 * ratios, without the dimming or the HUD (the page applies those).
 *
 * Usage: node scripts/rover-still.mjs [baseUrl]
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "http://localhost:4321";

const shots = [
  {
    file: "src/assets/rover-still-square.jpg",
    viewport: { width: 400, height: 900 },
  },
  {
    file: "src/assets/rover-still-wide.jpg",
    viewport: { width: 1280, height: 900 },
  },
];

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
for (const { file, viewport } of shots) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(`${base}/rover`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-rover][data-paused]", { timeout: 60_000 });
  await page.addStyleTag({
    content: `[data-rover] canvas { filter: none !important; transition: none !important; }
      [data-rover] .poster, [data-rover] .hud { display: none !important; }
      [data-rover] .stage { border: 0 !important; border-radius: 0 !important; }`,
  });
  await page.waitForTimeout(300);
  await page
    .locator("[data-rover-canvas]")
    .screenshot({ path: resolve(root, file), type: "jpeg", quality: 85 });
  await page.close();
  console.log(`wrote ${file}`);
}
await browser.close();
