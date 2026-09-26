/**
 * Top-down readout of what the rover knows: shaded relief where it has
 * mapped, darkness where it hasn't, the heat gradient in cost view (no-go
 * ground striped), plus the route, tracks, goal, rover and the navigation
 * cameras' field of view. Plain 2D canvas, redrawn a few times a
 * second by the caller. Clicking it sets a goal.
 */
import type { Mission, Point } from "@/lib/rover/mission";
import { CAMERAS } from "@/lib/rover/vehicle";
import type { World } from "@/lib/rover/world";
import { INFERNO as COEFFS, heat } from "./ground-material";

/** Inferno colour map as a 256-entry sRGB lookup (same fit as the shader). */
const INFERNO = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    for (let ch = 0; ch < 3; ch++) {
      let v = 0;
      for (let k = COEFFS.length - 1; k >= 0; k--) v = v * t + COEFFS[k]![ch]!;
      lut[i * 3 + ch] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return lut;
})();

/** CSS gradient for the legend, sampled from the same map. */
export const infernoCss = () => {
  const stops = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1].map((t) => {
    const i = Math.round(t * 255) * 3;
    return `rgb(${INFERNO[i]} ${INFERNO[i + 1]} ${INFERNO[i + 2]}) ${t * 100}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
};

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement("canvas");
  private layerCtx: CanvasRenderingContext2D;
  private image?: ImageData;
  private base?: Uint8ClampedArray;
  private size = 128;

  constructor(
    private canvas: HTMLCanvasElement,
    accent: string,
    onPick: (p: Point) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.layerCtx = this.layer.getContext("2d")!;
    this.accent = accent;
    canvas.addEventListener("click", (e) => {
      const r = canvas.getBoundingClientRect();
      onPick({
        x: ((e.clientX - r.left) / r.width) * (this.size - 1),
        y: ((e.clientY - r.top) / r.height) * (this.size - 1),
      });
    });
  }

  accent: string;

  setWorld(world: World) {
    this.size = world.terrain.size;
    this.base = world.baked.minimap;
    this.layer.width = this.layer.height = this.size;
    this.image = this.layerCtx.createImageData(this.size, this.size);
  }

  draw(m: Mission, costView: boolean) {
    if (!this.image || !this.base) return;
    const { canvas, ctx } = this;
    const dpr = Math.min(2, devicePixelRatio);
    const w = Math.round(canvas.clientWidth * dpr);
    if (canvas.width !== w) canvas.width = canvas.height = w;

    const px = this.image.data;
    const base = this.base;
    for (let i = 0; i < m.seen.length; i++) {
      const o = i * 4;
      if (!m.seen[i]) {
        px[o] = base[o]! * 0.16;
        px[o + 1] = base[o + 1]! * 0.17;
        px[o + 2] = base[o + 2]! * 0.2;
      } else if (costView) {
        const lum = (base[o]! + base[o + 1]! + base[o + 2]!) / 765;
        const hazard = !!m.map.hazard[i];
        const k = Math.round(heat(m.known[i]!, hazard) * 255) * 3;
        // No-go cells alternate with dark stripes, as in the 3D view.
        const x = i % this.size;
        const y = (i - x) / this.size;
        const f = hazard && (x + y) % 3 === 0 ? 0.25 : 0.45 + 0.75 * lum;
        px[o] = INFERNO[k]! * f;
        px[o + 1] = INFERNO[k + 1]! * f;
        px[o + 2] = INFERNO[k + 2]! * f;
      } else {
        px[o] = base[o]!;
        px[o + 1] = base[o + 1]!;
        px[o + 2] = base[o + 2]!;
      }
      px[o + 3] = 255;
    }
    this.layerCtx.putImageData(this.image, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.layer, 0, 0, w, w);
    const s = w / (this.size - 1);
    const line = (pts: Point[], color: string, width: number) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x * s, pts[0]!.y * s);
      for (const p of pts.slice(1)) ctx.lineTo(p.x * s, p.y * s);
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.stroke();
    };
    line(m.trail, "rgba(255,255,255,0.45)", 1);
    if (m.path.length) line(m.remaining(), this.accent, 1.5);

    // Where the navigation cameras are looking.
    const nav = CAMERAS[0]!;
    const yaw = m.heading + m.pan;
    ctx.fillStyle = "rgba(127,230,255,0.16)";
    ctx.beginPath();
    ctx.moveTo(m.pos.x * s, m.pos.y * s);
    ctx.arc(
      m.pos.x * s,
      m.pos.y * s,
      nav.range * s,
      yaw - nav.hfov / 2,
      yaw + nav.hfov / 2,
    );
    ctx.closePath();
    ctx.fill();

    if (m.goal) {
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(m.goal.x * s, m.goal.y * s, 3.5 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(m.pos.x * s, m.pos.y * s);
    ctx.rotate(m.heading);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(5 * dpr, 0);
    ctx.lineTo(-3.5 * dpr, 3.2 * dpr);
    ctx.lineTo(-2 * dpr, 0);
    ctx.lineTo(-3.5 * dpr, -3.2 * dpr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
