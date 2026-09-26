/**
 * Stereo perception, simulated.
 *
 * Each camera frame casts a thinned grid of rays (one per matched pixel)
 * against the true surface, including rocks, and turns each hit into a 3D
 * point with the depth noise a stereo pair really has: error grows with the
 * square of range, shrinks with baseline and focal length. Pixel positions
 * are jittered each frame, as a real matcher's valid pixels vary, so ground
 * fills in over successive frames.
 *
 * Points are binned into a one-metre elevation map. From that map alone the
 * rover estimates, per cell, the ground height, the tilt across the
 * wheelbase, the bumpiness and the tallest step (a rock sticking up out of
 * the local ground plane). Those estimates are what the cost map is built
 * from, so what the rover believes can differ from the truth: far ground is
 * noisier, and the back of a boulder stays unknown until it drives past.
 */
import { CAMERAS, DISPARITY_NOISE, VEHICLE, type CameraSpec } from "./vehicle";
import { contactRadius } from "./costmap";
import { wheels } from "./geometry";
import { heightAt, rng, type Rock, type Terrain } from "./terrain";

export interface Pose {
  x: number;
  y: number;
  heading: number;
  /** Mast pan relative to the body, radians (positive is to the left). */
  pan: number;
}

/** Samples kept per cell for the ground estimate. */
const RESERVOIR = 12;
/** Points a cell needs before the rover trusts what it knows about it. */
export const MIN_POINTS = 3;
/** Points this close above the lowest one count as ground, not rock. */
const LOW_BAND = 0.22;
/** Ray-march steps assume the surface is no steeper than this (rise over run). */
const SLOPE_BOUND = 0.8;
const TALLEST_ROCK = 2;
/** Most of a cell's height spread that is put down to the ground's slope. */
const STEP_RISE_CAP = 0.15;
/**
 * Steps are flagged a little below the true limit: the estimate is noisy
 * and a missed rock costs far more than a detour.
 */
const STEP_MARGIN = 0.85;

/** Rocks bucketed on a coarse grid for fast surface lookups. */
export class RockField {
  private buckets = new Map<number, Rock[]>();
  constructor(rocks: Rock[] = []) {
    rocks.forEach((r) => this.add(r));
  }
  add(r: Rock) {
    const key = Math.floor(r.x / 4) * 4096 + Math.floor(r.y / 4);
    const list = this.buckets.get(key);
    if (list) list.push(r);
    else this.buckets.set(key, [r]);
  }
  /** Height of any rock surface above the ground at a point. */
  height(x: number, y: number) {
    let top = 0;
    const cx = Math.floor(x / 4);
    const cy = Math.floor(y / 4);
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let j = cy - 1; j <= cy + 1; j++) {
        const list = this.buckets.get(i * 4096 + j);
        if (!list) continue;
        for (const r of list) {
          const c = contactRadius(r);
          const dx = x - r.x;
          const dy = y - r.y;
          const d2 = (dx * dx + dy * dy) / (c * c);
          if (d2 < 1) top = Math.max(top, r.h * Math.sqrt(1 - d2));
        }
      }
    return top;
  }
}

/** Ring buffer of recent points, for drawing the cloud. */
export class PointCloud {
  readonly xyz: Float32Array;
  /** Which camera saw each point (index into CAMERAS). */
  readonly source: Uint8Array;
  /** Points ever written; the slot is `total % capacity`. */
  total = 0;
  constructor(readonly capacity: number) {
    this.xyz = new Float32Array(capacity * 3);
    this.source = new Uint8Array(capacity);
  }
  push(x: number, y: number, z: number, cam: number) {
    const k = this.total % this.capacity;
    this.xyz[k * 3] = x;
    this.xyz[k * 3 + 1] = y;
    this.xyz[k * 3 + 2] = z;
    this.source[k] = cam;
    this.total++;
  }
}

export interface CellEstimate {
  seen: boolean;
  slope: number;
  /** Worst of bumpiness and step height. */
  rough: number;
}

export class Perception {
  readonly size: number;
  /** Points that have landed in each cell (saturating). */
  readonly count: Uint16Array;
  readonly rocks: RockField;
  readonly cloud = new PointCloud(24000);

  private samples: Float32Array;
  private top: Float32Array;
  private ground: Float32Array;
  private rawSlope: Float32Array;
  private rawRough: Float32Array;
  private step: Float32Array;
  private random: () => number;
  private spare: number | null = null;
  private mark: Uint8Array;
  private dirty: number[] = [];

  constructor(readonly terrain: Terrain) {
    const n = terrain.size * terrain.size;
    this.size = terrain.size;
    this.count = new Uint16Array(n);
    this.samples = new Float32Array(n * RESERVOIR);
    this.top = new Float32Array(n).fill(-Infinity);
    this.ground = new Float32Array(n).fill(NaN);
    this.rawSlope = new Float32Array(n);
    this.rawRough = new Float32Array(n);
    this.step = new Float32Array(n);
    this.mark = new Uint8Array(n);
    this.rocks = new RockField(terrain.rocks.filter((r) => r.h > 0.05));
    this.random = rng(terrain.seed * 7919 + 17);
  }

  private gauss() {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    const u = Math.max(1e-9, this.random());
    const v = this.random();
    const m = Math.sqrt(-2 * Math.log(u));
    this.spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  }

  /** The surface the cameras see: ground plus rocks. */
  surface(x: number, y: number, above = -Infinity) {
    const g = heightAt(this.terrain, x, y);
    if (above - g > TALLEST_ROCK) return g;
    return g + this.rocks.height(x, y);
  }

  /** March a ray until it meets the surface. Returns the distance, or -1. */
  cast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    max: number,
  ) {
    const lim = this.size - 1;
    const bound = Math.abs(dz) + SLOPE_BOUND * Math.hypot(dx, dy);
    let prev = 0.3;
    let t = 0.3;
    while (t < max) {
      const px = ox + dx * t;
      const py = oy + dy * t;
      if (px < 0 || py < 0 || px > lim || py > lim) return -1;
      const pz = oz + dz * t;
      const gap = pz - this.surface(px, py, pz);
      if (gap <= 0) {
        let lo = prev;
        let hi = t;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2;
          const mx = ox + dx * mid;
          const my = oy + dy * mid;
          const mz = oz + dz * mid;
          if (mz <= this.surface(mx, my, mz)) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prev = t;
      t += Math.min(1, Math.max(0.06, gap / bound));
    }
    return -1;
  }

  /** Where a camera sits and looks for a given rover pose. */
  static mount(t: Terrain, cam: CameraSpec, pose: Pose) {
    const c = Math.cos(pose.heading);
    const s = Math.sin(pose.heading);
    return {
      x: pose.x + cam.x * c - cam.y * s,
      y: pose.y + cam.x * s + cam.y * c,
      z: heightAt(t, pose.x, pose.y) + cam.z,
      yaw: pose.heading + cam.yaw + (cam.pans ? pose.pan : 0),
    };
  }

  /** Take one stereo frame. Returns how many points it produced. */
  capture(camIndex: number, pose: Pose) {
    const cam = CAMERAS[camIndex]!;
    const o = Perception.mount(this.terrain, cam, pose);
    const k = DISPARITY_NOISE / (cam.focalPx * cam.baseline);
    const lim = this.size - 1;
    let made = 0;
    for (let r = 0; r < cam.rows; r++) {
      for (let q = 0; q < cam.cols; q++) {
        const u = ((q + this.random()) / cam.cols - 0.5) * cam.hfov;
        const v = ((r + this.random()) / cam.rows - 0.5) * cam.vfov;
        const el = -cam.pitch + v;
        const az = o.yaw + u;
        const ce = Math.cos(el);
        const dx = ce * Math.cos(az);
        const dy = ce * Math.sin(az);
        const dz = Math.sin(el);
        const t = this.cast(o.x, o.y, o.z, dx, dy, dz, cam.range);
        if (t < 0) continue;
        // Depth error from disparity matching: sigma_z = z^2 * sigma_d / (f * b).
        const range = t + this.gauss() * t * t * k;
        const x = o.x + dx * range;
        const y = o.y + dy * range;
        const z = o.z + dz * range;
        if (x < 0 || y < 0 || x > lim || y > lim) continue;
        this.add(x, y, z);
        this.cloud.push(x, y, z, camIndex);
        made++;
      }
    }
    return made;
  }

  private add(x: number, y: number, z: number) {
    const i = Math.round(y) * this.size + Math.round(x);
    const n = this.count[i]!;
    if (n < RESERVOIR) this.samples[i * RESERVOIR + n] = z;
    else {
      // Reservoir sampling keeps a fair sample of everything seen.
      const slot = Math.floor(this.random() * (n + 1));
      if (slot < RESERVOIR) this.samples[i * RESERVOIR + slot] = z;
    }
    if (n < 65535) this.count[i] = n + 1;
    if (z > this.top[i]!) this.top[i] = z;
    if (!this.mark[i]) {
      this.mark[i] = 1;
      this.dirty.push(i);
    }
  }

  /** Cells with enough points to be trusted. */
  seen(i: number) {
    return this.count[i]! >= MIN_POINTS;
  }

  private groundOf(i: number) {
    const n = Math.min(RESERVOIR, this.count[i]!);
    if (n < MIN_POINTS) return NaN;
    const base = i * RESERVOIR;
    let lo = Infinity;
    for (let k = 0; k < n; k++) lo = Math.min(lo, this.samples[base + k]!);
    let sum = 0;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const z = this.samples[base + k]!;
      if (z <= lo + LOW_BAND) {
        sum += z;
        m++;
      }
    }
    return sum / m;
  }

  /**
   * Fold new points into the per-cell estimates. Calls `emit` for every cell
   * whose estimate may have changed.
   */
  update(emit: (i: number, e: CellEstimate) => void) {
    if (!this.dirty.length) return;
    const s = this.size;
    const dirty = this.dirty;
    this.dirty = [];
    for (const i of dirty) {
      this.mark[i] = 0;
      this.ground[i] = this.groundOf(i);
    }
    const ring1 = dilate(dirty, s, 1);
    for (const i of ring1) this.raw(i);
    for (const i of dilate(ring1, s, 1)) emit(i, this.estimate(i));
  }

  /** Tilt, bumpiness and step at one cell, from its neighbours' ground. */
  private raw(i: number) {
    const s = this.size;
    const g = this.ground;
    const h = g[i]!;
    if (Number.isNaN(h)) return;
    const x = i % s;
    const y = (i - x) / s;
    const at = (xx: number, yy: number) =>
      xx < 0 || yy < 0 || xx >= s || yy >= s ? NaN : g[yy * s + xx]!;
    const grad = (a: number, b: number) =>
      !Number.isNaN(a) && !Number.isNaN(b)
        ? (b - a) / 2
        : !Number.isNaN(b)
          ? b - h
          : !Number.isNaN(a)
            ? h - a
            : 0;
    const gx = grad(at(x - 1, y), at(x + 1, y));
    const gy = grad(at(x, y - 1), at(x, y + 1));
    const tilt = Math.hypot(gx, gy);
    this.rawSlope[i] = Math.atan(tilt);
    let rough = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const v = at(x + dx, y + dy);
        if (!Number.isNaN(v))
          rough = Math.max(rough, Math.abs(v - (h + gx * dx + gy * dy)));
      }
    this.rawRough[i] = rough;
    // A step is something standing above the local ground within the cell.
    // Allow for the ground's own rise across the cell, measured over a wider
    // baseline so a rock lifting its neighbours doesn't explain itself away.
    const wide = Math.hypot(
      grad(at(x - 2, y), at(x + 2, y)) / 2 || gx,
      grad(at(x, y - 2), at(x, y + 2)) / 2 || gy,
    );
    const rise = Math.min(STEP_RISE_CAP, Math.min(wide, tilt) * 0.6);
    this.step[i] = Math.max(0, this.top[i]! - h - rise);
  }

  /** The cell as the rover believes it is, smoothed over the body's size. */
  private estimate(i: number): CellEstimate {
    if (!this.seen(i)) return { seen: false, slope: 0, rough: 0 };
    const s = this.size;
    const x = i % s;
    const y = (i - x) / s;
    let slope = 0;
    let rough = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= s || yy >= s) continue;
        const j = yy * s + xx;
        if (Number.isNaN(this.ground[j]!)) continue;
        slope += this.rawSlope[j]!;
        rough += this.rawRough[j]!;
        n++;
      }
    return {
      seen: true,
      slope: slope / n,
      rough: Math.max(rough / n, this.step[i]! / STEP_MARGIN),
    };
  }

  /** A rock that just appeared (used by tests). */
  addRock(r: Rock) {
    if (r.h > 0.05) this.rocks.add(r);
  }
}

/** Cells within `r` (Chebyshev) of any in `cells`, deduplicated. */
function dilate(cells: number[], size: number, r: number) {
  const out = new Set<number>();
  for (const i of cells) {
    const x = i % size;
    const y = (i - x) / size;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < size && yy < size)
          out.add(yy * size + xx);
      }
  }
  return [...out];
}

/** Body attitude from the ground under the four wheels, as an IMU would report it. */
export function attitude(
  t: Terrain,
  rocks: RockField,
  x: number,
  y: number,
  heading: number,
) {
  const [fl, fr, rl, rr] = wheels({ x, y }, heading).map(
    (p) => heightAt(t, p.x, p.y) + rocks.height(p.x, p.y),
  ) as [number, number, number, number];
  const { wheelBase: a, wheelTrack: b } = VEHICLE;
  return {
    pitch: Math.atan2((fl + fr - rl - rr) / 2, 2 * a),
    roll: Math.atan2((fr + rr - fl - rl) / 2, 2 * b),
  };
}
