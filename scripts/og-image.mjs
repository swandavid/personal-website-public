/**
 * Render the link-preview image (public/og.png, 1200×630) that LinkedIn,
 * Slack and iMessage show when someone shares the site. Rerun after changing
 * the name, title or tagline below.
 *
 * Usage: node scripts/og-image.mjs
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { inlineFonts } from "./lib/fonts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logo = await readFile(resolve(root, "public/swan.svg"), "utf8");

const fonts = await inlineFonts(
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@500&display=block",
);

const html = `<!doctype html>
<html><head><style>
  ${fonts}
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; padding: 88px 96px;
    display: flex; flex-direction: column; justify-content: space-between;
    font-family: Inter, system-ui, sans-serif; color: oklch(97.5% 0.006 160);
    background:
      radial-gradient(900px 600px at 0% -10%, oklch(79% 0.15 155 / 0.18), transparent 70%),
      oklch(15.5% 0.01 165);
  }
  .logo svg { width: 96px; height: 96px; }
  h1 { font-size: 88px; font-weight: 700; letter-spacing: -0.02em; }
  h2 { margin-top: 16px; font-size: 40px; font-weight: 600; color: oklch(84% 0.012 160); }
  p { margin-top: 28px; font-size: 28px; color: oklch(66% 0.014 160); max-width: 900px; }
  .url { font-family: "JetBrains Mono", monospace; font-size: 24px; letter-spacing: 0.18em;
         text-transform: uppercase; color: oklch(79% 0.15 155); }
</style></head><body>
  <div class="logo">${logo}</div>
  <div>
    <h1>David Swan</h1>
    <h2>Software Engineer · Autonomy, Robotics &amp; Edge ML</h2>
    <p>ROS2 navigation for rovers, on-board ML inference on FPGAs, and C++/Python flight software.</p>
  </div>
  <div class="url">swandavid.com</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: resolve(root, "public/og.png") });
await browser.close();
console.log("Wrote public/og.png");
