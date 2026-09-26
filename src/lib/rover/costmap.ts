/**
 * Traversal cost per one-metre cell, in the layered style of a robot
 * costmap:
 *
 * - Hazard cells are ground the wheels must never touch: slopes past the
 *   limit, steps taller than a wheel can climb, boulders, the area's edge.
 * - An inflation layer turns hazards into limits on where the body's centre
 *   may go. Within KEEP_OUT of a hazard the side of the body would be over
 *   it, so the centre is blocked there; in the next ring a turn could swing
 *   a corner over it, so it is costly; beyond that a soft falloff keeps
 *   routes from shaving past.
 *
 * Keeping hazards separate from the inflation around them is what lets the
 * view show "no-go" as the ground the wheels avoid, rather than the larger
 * zone the centre avoids.
 */
import type { Point } from "./geometry";
import { VEHICLE, CIRCUMSCRIBED, INSCRIBED } from "./vehicle";
import { isObstacle, type Rock, type Terrain } from "./terrain";

export const BLOCKED = Number.POSITIVE_INFINITY;
/** What the rover assumes about ground it hasn't seen: probably fine. */
export const UNKNOWN_COST = 1.4;
/** Centre-to-hazard distance (cell centres) inside which the body would overlap it. */
export const KEEP_OUT = INSCRIBED + 0.45;
const CLIP = CIRCUMSCRIBED + 0.5;
const REACH = 4.6;
/** How far a goal on no-go ground may be moved to reach open ground, metres. */
const GOAL_SNAP_RADIUS = 15;

export const isHazard = (slope: number, rough: number) =>
  slope > VEHICLE.maxSlope || rough > VEHICLE.maxStep;

/** Cost of ground from how tilted and bumpy it is. */
export function traversalCost(slope: number, rough: number) {
  if (isHazard(slope, rough)) return BLOCKED;
  return (
    1 + 4 * (slope / VEHICLE.maxSlope) ** 2 + 2 * (rough / VEHICLE.maxStep) ** 2
  );
}

/** Contact radius used for both costs and collisions. */
export const contactRadius = (r: Rock) => r.r * 0.85;

/** Extra cost for being `d` from the nearest hazard. */
function inflation(d: number) {
  if (d < KEEP_OUT) return BLOCKED;
  if (d < CLIP) return 5;
  if (d >= REACH) return 0;
  return 3 * (1 - (d - CLIP) / (REACH - CLIP)) ** 2;
}

/** Cell offsets within REACH, nearest first. */
const KERNEL = (() => {
  const r = Math.ceil(REACH);
  const out: [number, number, number][] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < REACH) out.push([dx, dy, d]);
    }
  return out.sort((a, b) => a[2] - b[2]);
})();

/**
 * A cost map that keeps its inflation up to date incrementally: set cells'
 * ground cost or hazard flag, then `flush()` recomputes only the cells those
 * changes can reach and reports which final costs moved, and which rose.
 */
export class Costmap {
  /** Final cost the planner uses. */
  readonly cost: Float32Array;
  /** 1 where the wheels must not go. */
  readonly hazard: Uint8Array;
  /** Distance from each cell to the nearest hazard, capped at REACH. */
  readonly clearance: Float32Array;
  private base: Float32Array;
  private mark: Uint8Array;
  private touched: number[] = [];
  private spread: number[] = [];

  constructor(
    readonly size: number,
    fill = UNKNOWN_COST,
  ) {
    const n = size * size;
    this.cost = new Float32Array(n).fill(fill);
    this.base = new Float32Array(n).fill(fill);
    this.hazard = new Uint8Array(n);
    this.clearance = new Float32Array(n).fill(REACH);
    this.mark = new Uint8Array(n);
  }

  setBase(i: number, v: number) {
    if (this.base[i] === v) return;
    this.base[i] = v;
    this.touch(i);
  }

  setHazard(i: number, on: boolean) {
    if (!!this.hazard[i] === on) return;
    this.hazard[i] = on ? 1 : 0;
    this.spread.push(i);
    this.touch(i);
  }

  private touch(i: number) {
    if (this.mark[i]) return;
    this.mark[i] = 1;
    this.touched.push(i);
  }

  /** Recompute every cell affected since the last flush. */
  flush(): { changed: number[]; raised: number[] } {
    const s = this.size;
    for (const i of this.spread) {
      const x = i % s;
      const y = (i - x) / s;
      for (const [dx, dy] of KERNEL) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < s && yy < s) this.touch(yy * s + xx);
      }
    }
    this.spread.length = 0;
    const changed: number[] = [];
    const raised: number[] = [];
    for (const j of this.touched) {
      this.mark[j] = 0;
      const x = j % s;
      const y = (j - x) / s;
      let d = REACH;
      if (this.hazard[j]) d = 0;
      else
        for (const [dx, dy, dd] of KERNEL) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= s || yy >= s) continue;
          if (this.hazard[yy * s + xx]) {
            d = dd;
            break;
          }
        }
      this.clearance[j] = d;
      // Rounded as stored, so an unchanged cost isn't reported as a change.
      const v = Math.fround(
        this.hazard[j] ? BLOCKED : this.base[j]! + inflation(d),
      );
      if (this.cost[j] !== v) {
        if (v > this.cost[j]!) raised.push(j);
        this.cost[j] = v;
        changed.push(j);
      }
    }
    this.touched.length = 0;
    return { changed, raised };
  }
}

/** Cells a boulder makes into hazards: those its body covers. */
export function rockCells(
  rock: Rock,
  size: number,
  visit: (i: number) => void,
) {
  const reach = contactRadius(rock) + 0.2;
  for (
    let y = Math.max(0, Math.floor(rock.y - reach));
    y <= Math.min(size - 1, Math.ceil(rock.y + reach));
    y++
  )
    for (
      let x = Math.max(0, Math.floor(rock.x - reach));
      x <= Math.min(size - 1, Math.ceil(rock.x + reach));
      x++
    )
      if (Math.hypot(x - rock.x, y - rock.y) <= reach) visit(y * size + x);
}

/** Wall off the edge of the map (the operating area's boundary). */
export function fence(map: Costmap, width = 1) {
  const s = map.size;
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++)
      if (x < width || y < width || x >= s - width || y >= s - width)
        map.setHazard(y * s + x, true);
}

/** The true cost map: what the rover would build with perfect sensing. */
export function truthMap(t: Terrain) {
  const map = new Costmap(t.size, 1);
  const s = t.size;
  const bump = new Float32Array(s * s);
  for (const rock of t.rocks) {
    if (isObstacle(rock)) {
      rockCells(rock, s, (i) => map.setHazard(i, true));
      continue;
    }
    // Rocks shorter than a wheel are just bumpy ground.
    const reach = rock.r + 0.8;
    for (
      let y = Math.max(0, Math.floor(rock.y - reach));
      y <= Math.min(s - 1, Math.ceil(rock.y + reach));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(rock.x - reach));
        x <= Math.min(s - 1, Math.ceil(rock.x + reach));
        x++
      ) {
        const d = Math.hypot(x - rock.x, y - rock.y);
        if (d < reach) bump[y * s + x]! += 1.2 * (1 - d / reach);
      }
  }
  for (let i = 0; i < s * s; i++) {
    if (isHazard(t.slope[i]!, t.rough[i]!)) map.setHazard(i, true);
    else map.setBase(i, traversalCost(t.slope[i]!, t.rough[i]!) + bump[i]!);
  }
  fence(map);
  map.flush();
  return map;
}

/** The open cell nearest to `p`, within GOAL_SNAP_RADIUS. */
export function nearestPassable(
  cost: Float32Array,
  size: number,
  p: Point,
): Point | null {
  const cx = Math.round(p.x);
  const cy = Math.round(p.y);
  const r = GOAL_SNAP_RADIUS;
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = Math.max(0, cy - r); y <= Math.min(size - 1, cy + r); y++)
    for (let x = Math.max(0, cx - r); x <= Math.min(size - 1, cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r && d < bestD && cost[y * size + x] !== BLOCKED) {
        best = { x, y };
        bestD = d;
      }
    }
  return best;
}
