/**
 * Render resume/resume.html to public/David_Swan_Resume.pdf (US Letter). The PDF keeps
 * real, selectable text so applicant tracking systems can parse it.
 *
 * Usage: node scripts/resume.mjs
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { inlineFonts } from "./lib/fonts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(root, "resume/resume.html"), "utf8");
const fonts = await inlineFonts(
  "https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;700&display=block",
);
const html = source.replace("/* FONTS */", fonts);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const pdf = await page.pdf({
  path: resolve(root, "public/David_Swan_Resume.pdf"),
  format: "Letter",
  preferCSSPageSize: true,
  printBackground: true,
});
await browser.close();

const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
console.log(
  `Wrote public/David_Swan_Resume.pdf (${pages} page${pages === 1 ? "" : "s"})`,
);
if (pages > 1) console.warn("Warning: the résumé runs past one page.");
