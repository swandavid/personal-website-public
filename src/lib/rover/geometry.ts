/** Plane geometry shared by the rover's controller and sensing, in grid metres. */
import { VEHICLE } from "./vehicle";

export interface Point {
  x: number;
  y: number;
}

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Wheel contact points for a pose: front left, front right, rear left, rear right. */
export function wheels(p: Point, heading: number): Point[] {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const { wheelBase: a, wheelTrack: b } = VEHICLE;
  return [
    [a, b],
    [a, -b],
    [-a, b],
    [-a, -b],
  ].map(([lx, ly]) => ({
    x: p.x + lx! * c - ly! * s,
    y: p.y + lx! * s + ly! * c,
  }));
}

/**
 * The pure-pursuit target: the point `distance` further along `path` than
 * `pos`'s projection onto it. Only the few segments from `from` are
 * searched, so a later stretch of route passing nearby is never mistaken for
 * where the rover is. Also returns the segment `pos` projects onto.
 */
export function pointAhead(
  path: Point[],
  from: number,
  pos: Point,
  distance: number,
): { point: Point; seg: number } {
  let seg = from;
  let best = Infinity;
  let bestT = 0;
  for (let i = from; i < Math.min(path.length - 1, from + 4); i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = clamp(
      ((pos.x - a.x) * (b.x - a.x) + (pos.y - a.y) * (b.y - a.y)) / len2,
      0,
      1,
    );
    const d = Math.hypot(
      a.x + (b.x - a.x) * t - pos.x,
      a.y + (b.y - a.y) * t - pos.y,
    );
    if (d < best) {
      best = d;
      seg = i;
      bestT = t;
    }
  }
  if (seg >= path.length - 1) return { point: path.at(-1)!, seg };
  let left = distance;
  let at = {
    x: path[seg]!.x + (path[seg + 1]!.x - path[seg]!.x) * bestT,
    y: path[seg]!.y + (path[seg + 1]!.y - path[seg]!.y) * bestT,
  };
  for (let i = seg; i < path.length - 1; i++) {
    const to = path[i + 1]!;
    const d = dist(at, to);
    if (d >= left)
      return {
        point: {
          x: at.x + ((to.x - at.x) * left) / d,
          y: at.y + ((to.y - at.y) * left) / d,
        },
        seg,
      };
    left -= d;
    at = to;
  }
  return { point: path.at(-1)!, seg };
}
