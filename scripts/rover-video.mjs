/**
 * Record a short silent loop of the rover demo driving for its project card
 * on the home page: public/media/rover-loop.mp4 plus a poster frame in
 * src/assets/rover-loop-poster.jpg.
 *
 * Needs the dev server running (bun run dev) and ffmpeg on PATH, or its path
 * in FFMPEG.
 * The Chromium flags pick the Metal GPU backend, so this runs on macOS.
 *
 * Usage: node scripts/rover-video.mjs [baseUrl] [seconds]
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "http://localhost:4321";
const seconds = Number(process.argv[3] ?? 12);
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

const browser = await chromium.launch({
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
});
await page.goto(`${base}/rover`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-rover][data-paused]", { timeout: 60_000 });
await page.addStyleTag({
  content: `[data-rover] .hud, [data-rover] .hint { display: none !important; }
    [data-rover] .stage { border: 0 !important; border-radius: 0 !important; }`,
});
const canvas = page.locator("[data-rover-canvas]");
await canvas.scrollIntoViewIfNeeded();
const box = await canvas.boundingBox();
if (!box) throw new Error("rover canvas has no layout box");

const dir = await mkdtemp(join(tmpdir(), "rover-video-"));
const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  frames.push({ data, t: metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});

await page.click("[data-rover-launch]");
await page.waitForSelector("[data-rover][data-live]");
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92 });
await page.waitForTimeout(seconds * 1000);
await cdp.send("Page.stopScreencast");
await browser.close();

// Screencast frames arrive only when the page repaints, so give each frame
// its real on-screen duration through an ffconcat list.
const list = ["ffconcat version 1.0"];
for (const [i, f] of frames.entries()) {
  const file = join(dir, `${String(i).padStart(5, "0")}.jpg`);
  await writeFile(file, Buffer.from(f.data, "base64"));
  const next = frames[i + 1]?.t ?? f.t + 1 / 30;
  list.push(`file '${file}'`, `duration ${(next - f.t).toFixed(4)}`);
}
await writeFile(join(dir, "list.txt"), list.join("\n"));

// Inset a few pixels so rounding never pulls the page background into the edge.
const inset = 2;
const crop = `crop=${Math.floor(box.width) - 2 * inset}:${Math.floor(box.height) - 2 * inset}:${Math.ceil(box.x) + inset}:${Math.ceil(box.y) + inset}`;
// Fade the ends so the jump back to the start reads as a cut, not a glitch.
const fade = `fade=in:st=0:d=0.4,fade=out:st=${seconds - 0.4}:d=0.4`;
const vf = `${crop},scale=720:-2,fps=30,${fade}`;
const input = ["-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt")];
const video = resolve(root, "public/media/rover-loop.mp4");
const poster = resolve(root, "src/assets/rover-loop-poster.jpg");
await mkdir(dirname(video), { recursive: true });
execFileSync(ffmpeg, [
  ...input,
  "-vf",
  vf,
  "-an",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "30",
  "-preset",
  "slow",
  "-movflags",
  "+faststart",
  video,
]);
execFileSync(ffmpeg, [
  "-y",
  "-ss",
  "1",
  "-i",
  video,
  "-frames:v",
  "1",
  "-update",
  "1",
  "-q:v",
  "3",
  poster,
]);
await rm(dir, { recursive: true });
console.log(
  `wrote public/media/rover-loop.mp4 and its poster (${frames.length} frames)`,
);
