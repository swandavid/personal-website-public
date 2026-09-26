/**
 * Procedural lunar terrain for the rover demo. Everything is derived from a
 * seed, so the same seed always rebuilds the same world and a link can share
 * one.
 *
 * The surface is a continuous height function (gently warped fractal noise,
 * a few ridges, and a power-law crater field from 20 m basins down to
 * one-metre pits) sampled every half metre. The planner works on a coarser
 * one-metre grid of traversability derived from it.
 */
import { VEHICLE } from "./vehicle";

export interface Rock {
  /** Centre in metres (grid coordinates). */
  x: number;
  y: number;
  /** Footprint radius in metres. */
  r: number;
  /** Height above the ground in metres. */
  h: number;
}

export interface Crater {
  x: number;
  y: number;
  r: number;
  depth: number;
  rim: number;
  peak: number;
  /** Young craters keep sharp rims and bright ejecta. */
  fresh: boolean;
}

export interface Terrain {
  seed: number;
  /** Planning grid is size × size one-metre cells. */
  size: number;
  /** Height samples per side (DETAIL per metre). */
  detailSize: number;
  /** Heights in metres, row-major. */
  detail: Float32Array;
  /** Per planning cell: body tilt over its length, radians. */
  slope: Float32Array;
  /** Per planning cell: worst bump height relative to the local plane, metres. */
  rough: Float32Array;
  rocks: Rock[];
  craters: Crater[];
  start: { x: number; y: number };
}

export const GRID_SIZE = 128;
export const DETAIL = 2;

export const isObstacle = (r: Rock) => r.h > VEHICLE.maxStep;

/** Where the demo's opening drive heads: the far corner from the start. */
export const defaultGoal = (size: number) => ({ x: size - 14, y: 14 });

/** mulberry32: small, fast, good enough for terrain. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Classic 2D gradient noise, roughly in [-1, 1]. */
export function perlin(seed: number) {
  const random = rng(seed);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number) => {
    switch (h & 7) {
      case 0:
        return x + y;
      case 1:
        return -x + y;
      case 2:
        return x - y;
      case 3:
        return -x - y;
      case 4:
        return x;
      case 5:
        return -x;
      case 6:
        return y;
      default:
        return -y;
    }
  };
  return (x: number, y: number) => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const X = xf & 255;
    const Y = yf & 255;
    x -= xf;
    y -= yf;
    const u = fade(x);
    const v = fade(y);
    const a = perm[X]! + Y;
    const b = perm[X + 1]! + Y;
    const n00 = grad(perm[a]!, x, y);
    const n10 = grad(perm[b]!, x - 1, y);
    const n01 = grad(perm[a + 1]!, x, y - 1);
    const n11 = grad(perm[b + 1]!, x - 1, y - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 0.7;
  };
}

export type Noise = (x: number, y: number) => number;
export function fbm(n: Noise, x: number, y: number, octaves: number) {
  let sum = 0;
  let amp = 0.5;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 - 9.7;
    amp *= 0.5;
  }
  return sum;
}
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function placeCraters(
  random: () => number,
  size: number,
  avoid: { x: number; y: number }[],
) {
  const craters: Crater[] = [];
  // Power law: a few basins, more medium craters, lots of small pits.
  const bands: [number, number, number, number][] = [
    // count, min radius, max radius, chance of being fresh
    [1 + Math.floor(random() * 2), 14, 22, 0.15],
    [5 + Math.floor(random() * 4), 6, 11, 0.25],
    [22 + Math.floor(random() * 10), 2, 4.5, 0.35],
    [70 + Math.floor(random() * 30), 0.7, 1.8, 0.5],
  ];
  for (const [count, lo, hi, freshChance] of bands) {
    for (let k = 0, tries = 0; k < count && tries < count * 10; tries++) {
      const r = lo + random() * (hi - lo);
      const x = random() * size;
      const y = random() * size;
      const margin = r * 1.6 + (r > 3 ? 8 : 3);
      if (avoid.some((a) => Math.hypot(a.x - x, a.y - y) < margin)) continue;
      const fresh = random() < freshChance;
      const age = fresh ? 0.85 + random() * 0.15 : 0.35 + random() * 0.5;
      craters.push({
        x,
        y,
        r,
        depth: r * (r < 2 ? 0.2 : 0.24) * age,
        rim: r * 0.07 * age,
        peak: r > 15 ? r * 0.2 * age * 0.45 : 0,
        fresh,
      });
      k++;
    }
  }
  return craters;
}

/** Craters bucketed on a coarse grid so each sample only checks its neighbours. */
export function craterIndex(craters: Crater[], cell = 8, reachFactor = 2.2) {
  const buckets = new Map<number, Crater[]>();
  for (const c of craters) {
    const reach = c.r * reachFactor;
    for (
      let bx = Math.floor((c.x - reach) / cell);
      bx <= Math.floor((c.x + reach) / cell);
      bx++
    ) {
      for (
        let by = Math.floor((c.y - reach) / cell);
        by <= Math.floor((c.y + reach) / cell);
        by++
      ) {
        const key = bx * 4096 + by;
        const list = buckets.get(key) ?? [];
        list.push(c);
        buckets.set(key, list);
      }
    }
  }
  const empty: Crater[] = [];
  return (x: number, y: number) =>
    buckets.get(Math.floor(x / cell) * 4096 + Math.floor(y / cell)) ?? empty;
}

function heightFunction(seed: number, craters: Crater[]) {
  const n1 = perlin(seed);
  const n2 = perlin(seed + 101);
  const n3 = perlin(seed + 202);
  const n4 = perlin(seed + 303);
  const near = craterIndex(craters);

  return (x: number, y: number) => {
    // Gentle domain warp: rolling regolith with no grid feel.
    const wx = x + 14 * fbm(n2, x / 64, y / 64, 3);
    const wy = y + 14 * fbm(n3, x / 64 + 5.2, y / 64 + 1.3, 3);
    let h = 11 * fbm(n1, wx / 58, wy / 58, 5);

    // Occasional ridges: natural barriers with passes between.
    const ridge = 1 - Math.abs(n4(wx / 36, wy / 36) * 1.4);
    const ridgeMask = smoothstep(
      -0.05,
      0.25,
      fbm(n2, x / 90 + 9, y / 90 + 3, 2),
    );
    h += 3.6 * Math.max(0, ridge) ** 4 * ridgeMask;

    for (const c of near(x, y)) {
      const d = Math.hypot(x - c.x, y - c.y) / c.r;
      if (d >= 2.2) continue;
      if (d < 1) {
        h += -c.depth + (c.depth + c.rim) * d * d;
        if (c.peak) h += c.peak * Math.exp(-((d / 0.2) ** 2));
      } else {
        h += c.rim * (1 - (d - 1) / 1.2) ** 3;
      }
    }
    return h;
  };
}

export function generateTerrain(seed: number, size = GRID_SIZE): Terrain {
  const random = rng(seed);
  const start = { x: 10, y: size - 11 };
  const craters = placeCraters(random, size, [start, defaultGoal(size)]);
  const h = heightFunction(seed, craters);

  const detailSize = (size - 1) * DETAIL + 1;
  const detail = new Float32Array(detailSize * detailSize);
  let lo = Infinity;
  for (let j = 0; j < detailSize; j++) {
    for (let i = 0; i < detailSize; i++) {
      const v = h(i / DETAIL, j / DETAIL);
      detail[j * detailSize + i] = v;
      lo = Math.min(lo, v);
    }
  }
  for (let i = 0; i < detail.length; i++) detail[i]! -= lo;

  const terrain: Terrain = {
    seed,
    size,
    detailSize,
    detail,
    slope: new Float32Array(size * size),
    rough: new Float32Array(size * size),
    rocks: [],
    craters,
    start,
  };
  analyse(terrain);
  terrain.rocks = scatterRocks(random, size, craters, start);
  return terrain;
}

/** Bilinear height at a position in metres. */
export function heightAt(t: Terrain, x: number, y: number) {
  return bilinear(t, t.detail, x, y);
}

/** Bilinear sample, at a position in metres, of a value per height sample. */
export function bilinear(t: Terrain, v: Float32Array, x: number, y: number) {
  const n = t.detailSize;
  const gx = Math.min(n - 1, Math.max(0, x * DETAIL));
  const gy = Math.min(n - 1, Math.max(0, y * DETAIL));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const top = v[y0 * n + x0]! * (1 - fx) + v[y0 * n + x1]! * fx;
  const bottom = v[y1 * n + x0]! * (1 - fx) + v[y1 * n + x1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Traversability per planning cell, measured the way the body experiences
 * the ground: tilt over the body's length, and the largest bump that sticks
 * out of the plane under the rover.
 */
function analyse(t: Terrain) {
  const half = VEHICLE.length / 2;
  for (let y = 0; y < t.size; y++) {
    for (let x = 0; x < t.size; x++) {
      const gx =
        (heightAt(t, x + half, y) - heightAt(t, x - half, y)) / (2 * half);
      const gy =
        (heightAt(t, x, y + half) - heightAt(t, x, y - half)) / (2 * half);
      const i = y * t.size + x;
      t.slope[i] = Math.atan(Math.hypot(gx, gy));
      const hc = heightAt(t, x, y);
      let rough = 0;
      for (let oy = -1; oy <= 1; oy += 0.5) {
        for (let ox = -1; ox <= 1; ox += 0.5) {
          const plane = hc + gx * ox + gy * oy;
          rough = Math.max(
            rough,
            Math.abs(heightAt(t, x + ox, y + oy) - plane),
          );
        }
      }
      t.rough[i] = rough;
    }
  }
  // The body spans several cells, so what it feels is the neighbourhood, not
  // one sample. Averaging also stops single cells flickering along crests.
  boxBlur(t.slope, t.size);
  boxBlur(t.rough, t.size);
}

function boxBlur(v: Float32Array, size: number) {
  const src = v.slice();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          sum += src[yy * size + xx]!;
          n++;
        }
      }
      v[y * size + x] = sum / n;
    }
  }
}

function scatterRocks(
  random: () => number,
  size: number,
  craters: Crater[],
  start: { x: number; y: number },
) {
  const rocks: Rock[] = [];
  // Boulders are thrown out by impacts, mostly around the younger craters.
  const big = craters.filter((c) => c.r > 4 && (c.fresh || c.r > 10));
  const place = (
    count: number,
    lo: number,
    hi: number,
    nearCraters: number,
  ) => {
    for (let k = 0, tries = 0; k < count && tries < count * 20; tries++) {
      const r = lo + random() ** 1.6 * (hi - lo);
      let x: number;
      let y: number;
      const c = big.length ? big[Math.floor(random() * big.length)]! : null;
      if (c && random() < nearCraters) {
        // Ejecta: thrown out past the rim.
        const a = random() * Math.PI * 2;
        const d = c.r * (1.05 + random() * 0.9);
        x = c.x + Math.cos(a) * d;
        y = c.y + Math.sin(a) * d;
      } else {
        x = random() * size;
        y = random() * size;
      }
      if (x < 3 || y < 3 || x > size - 4 || y > size - 4) continue;
      const rock = { x, y, r, h: r * (0.5 + random() * 0.3) };
      const clearance = isObstacle(rock) ? 9 : 3;
      if (Math.hypot(x - start.x, y - start.y) < clearance) continue;
      rocks.push(rock);
      k++;
    }
  };
  place(20 + Math.floor(random() * 8), 1.0, 2.2, 0.6);
  place(70 + Math.floor(random() * 30), 0.5, 1.0, 0.35);
  place(260 + Math.floor(random() * 80), 0.15, 0.45, 0.25);
  return rocks;
}
