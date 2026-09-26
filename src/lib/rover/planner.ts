/**
 * A* on an 8-connected grid. The cost of a step is its length times the mean
 * cost of the two cells, and the heuristic is octile distance (admissible
 * because the cheapest cell costs 1). Diagonal steps may not cut the corner
 * of a blocked cell.
 */
import { BLOCKED } from "./costmap";

const SQRT2 = Math.SQRT2;
const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

/** Whether (f1, h1) comes out of the heap before (f2, h2). */
const precedes = (f1: number, h1: number, f2: number, h2: number) =>
  f1 < f2 || (f1 === f2 && h1 < h2);

/**
 * Binary min-heap of nodes by f. Ties go to the lower h (the node nearer the
 * goal), which keeps A* from fanning out across equal-cost ground.
 */
class Heap {
  private node: number[] = [];
  private f: number[] = [];
  private h: number[] = [];
  get size() {
    return this.node.length;
  }
  private put(i: number, node: number, f: number, h: number) {
    this.node[i] = node;
    this.f[i] = f;
    this.h[i] = h;
  }
  push(node: number, f: number, h: number) {
    let i = this.node.length;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!precedes(f, h, this.f[p]!, this.h[p]!)) break;
      this.put(i, this.node[p]!, this.f[p]!, this.h[p]!);
      i = p;
    }
    this.put(i, node, f, h);
  }
  pop() {
    const top = this.node[0]!;
    const node = this.node.pop()!;
    const f = this.f.pop()!;
    const h = this.h.pop()!;
    const n = this.node.length;
    if (n === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c =
        r < n && precedes(this.f[r]!, this.h[r]!, this.f[l]!, this.h[l]!)
          ? r
          : l;
      if (!precedes(this.f[c]!, this.h[c]!, f, h)) break;
      this.put(i, this.node[c]!, this.f[c]!, this.h[c]!);
      i = c;
    }
    this.put(i, node, f, h);
    return top;
  }
}

/** Cell indices from `start` to `goal` inclusive, or null if there is no route. */
export function findPath(
  cost: Float32Array,
  size: number,
  start: number,
  goal: number,
): number[] | null {
  // The start may sit in a costly zone (the rover is already there), but the
  // goal must be somewhere the rover could actually stop.
  if (cost[goal] === BLOCKED) return null;
  const n = size * size;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gx = goal % size;
  const gy = (goal / size) | 0;
  const h = (i: number) => {
    const dx = Math.abs((i % size) - gx);
    const dy = Math.abs(((i / size) | 0) - gy);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };

  const open = new Heap();
  g[start] = 0;
  open.push(start, h(start), h(start));

  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue; // stale heap entry
    closed[cur] = 1;
    if (cur === goal) {
      const path = [cur];
      for (let p = came[cur]!; p !== -1; p = came[p]!) path.push(p);
      return path.reverse();
    }
    const cx = cur % size;
    const cy = (cur / size) | 0;
    for (const [dx, dy, len] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const next = ny * size + nx;
      if (closed[next] || cost[next] === BLOCKED) continue;
      if (
        dx &&
        dy &&
        (cost[cy * size + nx] === BLOCKED || cost[ny * size + cx] === BLOCKED)
      )
        continue;
      const tentative = g[cur]! + len * (cost[cur]! + cost[next]!) * 0.5;
      if (tentative < g[next]!) {
        g[next] = tentative;
        came[next] = cur;
        const hn = h(next);
        open.push(next, tentative + hn, hn); // duplicates are skipped via `closed`
      }
    }
  }
  return null;
}

export interface Waypoint {
  x: number;
  y: number;
}

/** Average cost along a straight segment, or Infinity if it crosses a blocked cell. */
function segmentCost(
  cost: Float32Array,
  size: number,
  a: Waypoint,
  b: Waypoint,
) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / 0.4));
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    const x = Math.round(a.x + ((b.x - a.x) * k) / n);
    const y = Math.round(a.y + ((b.y - a.y) * k) / n);
    const c = cost[y * size + x]!;
    if (c === BLOCKED) return Infinity;
    sum += c;
  }
  return (sum / (n + 1)) * len;
}

/**
 * Turn an 8-connected grid path into straighter waypoints. A corner is cut
 * only when the straight line crosses no blocked cell and costs at most a
 * little more than the grid path it replaces (3%, plus 0.2 for sampling
 * error), so smoothing never trades safety for looks.
 */
export function smoothPath(
  cost: Float32Array,
  size: number,
  cells: number[],
): Waypoint[] {
  const pts = cells.map((c) => ({ x: c % size, y: Math.floor(c / size) }));
  if (pts.length < 3) return pts;
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = cells[i - 1]!;
    const b = cells[i]!;
    acc.push(
      acc[i - 1]! +
        Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y) *
          (cost[a]! + cost[b]!) *
          0.5,
    );
  }
  const out = [pts[0]!];
  let i = 0;
  while (i < pts.length - 1) {
    let next = i + 1;
    for (let j = Math.min(pts.length - 1, i + 30); j > i + 1; j--) {
      if (
        segmentCost(cost, size, pts[i]!, pts[j]!) <=
        (acc[j]! - acc[i]!) * 1.03 + 0.2
      ) {
        next = j;
        break;
      }
    }
    out.push(pts[next]!);
    i = next;
  }
  return out;
}
