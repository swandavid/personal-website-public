/**
 * Everything about the world that never changes once it's generated, worked
 * out once (in a worker) so the renderer does almost nothing per frame:
 * mesh buffers, surface colour, and lighting with soft terrain and rock
 * shadows from a low sun. The sun doesn't move, so there's no reason to pay
 * for real-time shadows on the ground.
 */
import {
  DETAIL,
  bilinear,
  craterIndex,
  fbm,
  heightAt,
  perlin,
  type Terrain,
} from "./terrain";

/** Unit vector toward the sun: (x, y) on the grid, h up. Low, as near the lunar poles. */
export const SUN = (() => {
  const el = (17 * Math.PI) / 180;
  const az = Math.atan2(-0.6, -0.8);
  return {
    x: Math.cos(el) * Math.cos(az),
    y: Math.cos(el) * Math.sin(az),
    h: Math.sin(el),
  };
})();
const SUN_INTENSITY = 3.1;
const FILL = 0.2; // earthshine and scattered light from sunlit ground

export interface Baked {
  /** Scene-space positions (x, height, y), centred on the map. */
  positions: Float32Array;
  gridUv: Float32Array;
  index: Uint32Array;
  /** Linear surface colour per vertex. */
  albedo: Float32Array;
  /** Lighting per vertex (sun, shadow and fill combined). */
  light: Float32Array;
  /** Direct sunlight per vertex, 0 in shadow to 1 in full sun. */
  sunlit: Float32Array;
  /** size × size RGBA shaded relief for the minimap. */
  minimap: Uint8ClampedArray;
}

/** Summed-area table for fast box means. */
function integral(v: Float32Array, n: number) {
  const s = new Float64Array((n + 1) * (n + 1));
  for (let j = 0; j < n; j++) {
    let row = 0;
    for (let i = 0; i < n; i++) {
      row += v[j * n + i]!;
      s[(j + 1) * (n + 1) + i + 1] = s[j * (n + 1) + i + 1]! + row;
    }
  }
  return (i: number, j: number, r: number) => {
    const x0 = Math.max(0, i - r);
    const y0 = Math.max(0, j - r);
    const x1 = Math.min(n, i + r + 1);
    const y1 = Math.min(n, j + r + 1);
    const w = n + 1;
    const sum =
      s[y1 * w + x1]! - s[y0 * w + x1]! - s[y1 * w + x0]! + s[y0 * w + x0]!;
    return sum / ((x1 - x0) * (y1 - y0));
  };
}

/** Top of any boulder at a point, for casting shadows. */
function rockTops(t: Terrain) {
  const cell = 4;
  const buckets = new Map<number, Terrain["rocks"]>();
  for (const r of t.rocks) {
    if (r.h < 0.25) continue;
    const key = Math.floor(r.x / cell) * 4096 + Math.floor(r.y / cell);
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  return (x: number, y: number) => {
    let top = 0;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        const list = buckets.get(i * 4096 + j);
        if (!list) continue;
        for (const r of list) {
          const d2 = ((x - r.x) ** 2 + (y - r.y) ** 2) / (r.r * r.r);
          if (d2 < 1) top = Math.max(top, r.h * Math.sqrt(1 - d2));
        }
      }
    }
    return top;
  };
}

export function bake(t: Terrain): Baked {
  const n = t.detailSize;
  const count = n * n;
  const d = t.detail;
  const off = (t.size - 1) / 2;

  const positions = new Float32Array(count * 3);
  const gridUv = new Float32Array(count * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = i / DETAIL;
      const y = j / DETAIL;
      positions[k * 3] = x - off;
      positions[k * 3 + 1] = d[k]!;
      positions[k * 3 + 2] = y - off;
      gridUv[k * 2] = (x + 0.5) / t.size;
      gridUv[k * 2 + 1] = (y + 0.5) / t.size;
    }
  }

  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const e = c + 1;
      // Alternate the diagonal so slopes don't show a directional grain.
      if ((i + j) % 2) index.set([a, c, b, b, c, e], q);
      else index.set([a, c, e, a, e, b], q);
      q += 6;
    }
  }

  // ---- lighting ----
  const top = rockTops(t);
  let maxH = 0;
  for (const h of d) maxH = Math.max(maxH, h);
  maxH += 2.5;
  const mean = integral(d, n);
  const light = new Float32Array(count);
  const sunlit = new Float32Array(count);
  const step = 1 / DETAIL;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = i * step;
      const y = j * step;
      const h0 = d[k]!;
      const dx =
        (d[j * n + Math.min(n - 1, i + 1)]! - d[j * n + Math.max(0, i - 1)]!) /
        (2 * step);
      const dy =
        (d[Math.min(n - 1, j + 1) * n + i]! - d[Math.max(0, j - 1) * n + i]!) /
        (2 * step);
      const len = Math.hypot(dx, dy, 1);
      const nx = -dx / len;
      const ny = -dy / len;
      const nh = 1 / len;
      const ndl = Math.max(0, nx * SUN.x + ny * SUN.y + nh * SUN.h);

      // Soft shadow: march toward the sun, tracking the closest miss.
      let res = ndl > 0 ? 1 : 0;
      for (let s = 0.35; res > 0 && s < 90; s += Math.max(0.3, s * 0.05)) {
        const pz = h0 + 0.05 + SUN.h * s;
        if (pz > maxH) break;
        const px = x + SUN.x * s;
        const py = y + SUN.y * s;
        if (px < 0 || py < 0 || px > t.size - 1 || py > t.size - 1) break;
        const gap = pz - heightAt(t, px, py) - top(px, py);
        if (gap < 0) res = 0;
        else res = Math.min(res, (10 * gap) / s);
      }
      const shadow = res * res * (3 - 2 * res);

      // Ambient occlusion from how far the point sits below its surroundings.
      const ao =
        1 -
        Math.min(
          0.6,
          Math.max(0, mean(i, j, 4) - h0) * 0.35 +
            Math.max(0, mean(i, j, 16) - h0) * 0.06,
        );

      sunlit[k] = shadow;
      light[k] = SUN_INTENSITY * ndl * shadow + FILL * ao * (0.55 + 0.45 * nh);
    }
  }

  // ---- surface colour ----
  const albedo = new Float32Array(count * 3);
  const nA = perlin(t.seed + 404);
  const nB = perlin(t.seed + 505);
  const fresh = craterIndex(
    t.craters.filter((c) => c.fresh),
    8,
    3.2,
  );
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = i * step;
      const y = j * step;
      // Darker basalt plains against lighter highland material.
      const mare = Math.min(
        1,
        Math.max(0, (fbm(nA, x / 85, y / 85, 3) + 0.05) * 3),
      );
      let a =
        0.15 *
        (1 - 0.32 * mare) *
        (0.9 + 0.2 * (0.5 + fbm(nB, x / 7, y / 7, 3)));
      // Fresh impacts throw bright, streaky ejecta.
      for (const c of fresh(x, y)) {
        const dist = Math.hypot(x - c.x, y - c.y) / c.r;
        if (dist > 3.2) continue;
        if (dist < 0.9) {
          a *= 1.08;
          continue;
        }
        const angle = Math.atan2(y - c.y, x - c.x);
        const rays = (0.5 + 0.5 * Math.sin(angle * (7 + (c.r % 5)) + c.x)) ** 3;
        a += 0.09 * (1 - (dist - 0.9) / 2.3) ** 2 * (0.5 + 0.5 * rays);
      }
      albedo[k * 3] = a * (1 - 0.05 * mare);
      albedo[k * 3 + 1] = a * (0.975 - 0.02 * mare);
      albedo[k * 3 + 2] = a * (0.94 + 0.05 * mare);
    }
  }

  // ---- minimap: shaded relief, one pixel per planning cell ----
  const minimap = new Uint8ClampedArray(t.size * t.size * 4);
  const encode = (v: number) => {
    const c = 1 - Math.exp(-v * 1.6); // soft exposure curve
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  for (let y = 0; y < t.size; y++) {
    for (let x = 0; x < t.size; x++) {
      const k = y * DETAIL * n + x * DETAIL;
      const p = (y * t.size + x) * 4;
      for (let c = 0; c < 3; c++)
        minimap[p + c] = encode(albedo[k * 3 + c]! * light[k]!);
      minimap[p + 3] = 255;
    }
  }

  return { positions, gridUv, index, albedo, light, sunlit, minimap };
}

/** Direct sunlight at a position in metres (bilinear). */
export function sunlitAt(
  t: Terrain,
  sunlit: Float32Array,
  x: number,
  y: number,
) {
  return bilinear(t, sunlit, x, y);
}
