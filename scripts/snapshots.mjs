/**
 * Capture fresh screenshots of each project's live site.
 *
 * For every entry in src/data/projects.json with a `snapshotUrl`, loads the
 * page in headless Chromium and writes a JPEG to the entry's `image` path.
 * The file is only rewritten, and its date in src/data/snapshots.json only
 * bumped, when the new capture differs from the one on disk. A scheduled
 * GitHub Action runs this and commits any changes, which redeploys the site.
 *
 * Usage: node scripts/snapshots.mjs [projectId ...]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectsFile = resolve(root, "src/data/projects.json");
const manifestFile = resolve(root, "src/data/snapshots.json");

const VIEWPORT = { width: 1280, height: 880 };
const SETTLE_MS = 2500; // let fonts, charts and live data finish painting
const NAV_TIMEOUT_MS = 45_000;

const only = new Set(process.argv.slice(2));
const projects = JSON.parse(await readFile(projectsFile, "utf8"));
const manifest = JSON.parse(
  await readFile(manifestFile, "utf8").catch(() => "{}"),
);

const targets = projects.filter(
  (p) => p.snapshotUrl && (only.size === 0 || only.has(p.id)),
);
if (targets.length === 0) {
  console.log("No projects with a snapshotUrl to capture.");
  process.exit(0);
}

const browser = await chromium.launch();
let failures = 0;
try {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });

  for (const project of targets) {
    const out = resolve(dirname(projectsFile), project.image);
    const page = await context.newPage();
    try {
      // Live sites may never go fully network-idle (polling, websockets), so
      // fall back to the load event rather than failing the capture.
      await page
        .goto(project.snapshotUrl, {
          waitUntil: "networkidle",
          timeout: NAV_TIMEOUT_MS,
        })
        .catch(() =>
          page.goto(project.snapshotUrl, {
            waitUntil: "load",
            timeout: NAV_TIMEOUT_MS,
          }),
        );
      await page.waitForTimeout(SETTLE_MS);
      const shot = await page.screenshot({ type: "jpeg", quality: 82 });

      const previous = await readFile(out).catch(() => null);
      if (previous && Buffer.compare(previous, shot) === 0) {
        console.log(`${project.id}: unchanged`);
        continue;
      }
      await writeFile(out, shot);
      manifest[project.id] = { capturedAt: new Date().toISOString() };
      console.log(`${project.id}: updated ${project.image}`);
    } catch (err) {
      failures++;
      console.error(`${project.id}: capture failed`, err);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
// A failed capture keeps the previous image, so only fail the run if every capture failed.
if (failures > 0 && failures === targets.length) process.exit(1);
