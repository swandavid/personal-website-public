import { describe, expect, it } from "vitest";
import { SUN, bake } from "./bake";
import {
  BLOCKED,
  Costmap,
  KEEP_OUT,
  UNKNOWN_COST,
  truthMap,
  traversalCost,
} from "./costmap";
import { Perception } from "./perception";
import { findPath, smoothPath } from "./planner";
import { Mission } from "./mission";
import {
  DETAIL,
  defaultGoal,
  generateTerrain,
  heightAt,
  rng,
  type Rock,
} from "./terrain";
import { drive, world } from "./test-utils";
import { VEHICLE } from "./vehicle";
import { hasRoute } from "./world";

/** Run a mission to completion with a synchronous planner. */
function run(m: Mission, seconds = 120) {
  drive(m, { seconds });
  return m;
}

const boulder = (x: number, y: number): Rock => ({ x, y, r: 1.2, h: 0.9 });

describe("terrain", () => {
  it("is deterministic for a seed", () => {
    const a = generateTerrain(42, 48);
    const b = generateTerrain(42, 48);
    expect(a.detail).toEqual(b.detail);
    expect(a.rocks).toEqual(b.rocks);
    expect(generateTerrain(43, 48).detail).not.toEqual(a.detail);
  });

  it("keeps the start clear of rocks the rover can't climb", () => {
    const t = generateTerrain(7);
    for (const r of t.rocks.filter((r) => r.h > VEHICLE.maxStep))
      expect(
        Math.hypot(r.x - t.start.x, r.y - t.start.y),
      ).toBeGreaterThanOrEqual(9);
  });

  it("interpolates heights between samples", () => {
    const t = world(4, [], (x) => x);
    expect(heightAt(t, 1.25, 0)).toBeCloseTo(1.25);
  });
});

describe("cost map", () => {
  it("blocks ground past the slope and step limits", () => {
    expect(traversalCost(0, 0)).toBe(1);
    expect(traversalCost(VEHICLE.maxSlope / 2, 0)).toBeGreaterThan(1);
    expect(traversalCost(VEHICLE.maxSlope * 1.01, 0)).toBe(BLOCKED);
    expect(traversalCost(0, VEHICLE.maxStep * 1.01)).toBe(BLOCKED);
  });

  it("gives boulders a no-go core, a keep-out ring and a costly margin", () => {
    const map = truthMap(world(30, [boulder(15, 15)]));
    const at = (x: number, y: number) => y * 30 + x;
    expect(map.hazard[at(15, 15)]).toBe(1);
    // Next to the rock the wheels would be fine but the body wouldn't.
    expect(map.hazard[at(17, 15)]).toBe(0);
    expect(map.cost[at(17, 15)]).toBe(BLOCKED);
    expect(map.cost[at(19, 15)]).toBeGreaterThan(1);
    expect(map.cost[at(19, 15)]).toBeLessThan(BLOCKED);
  });

  it("keeps the whole body off steep ground, not just the centre", () => {
    // A slope past the limit for x >= 15: the centre must stay a body's
    // half-width away from it, so the wheels never reach it.
    const t = world(30);
    for (let y = 0; y < 30; y++)
      for (let x = 15; x < 30; x++)
        t.slope[y * 30 + x] = VEHICLE.maxSlope * 1.2;
    const map = truthMap(t);
    for (let x = 0; x < 15; x++) {
      const i = 15 * 30 + x;
      const gap = 15 - x;
      if (gap < KEEP_OUT) expect(map.cost[i], `x=${x}`).toBe(BLOCKED);
      if (gap >= KEEP_OUT && x > 2)
        expect(map.cost[i], `x=${x}`).toBeLessThan(BLOCKED);
    }
    expect(KEEP_OUT).toBeGreaterThan(VEHICLE.width / 2 + 0.4);
  });

  it("lets the rover drive over rocks shorter than a wheel", () => {
    const map = truthMap(world(20, [{ x: 10, y: 10, r: 0.3, h: 0.2 }]));
    expect(map.cost[10 * 20 + 10]).toBeLessThan(BLOCKED);
    expect(map.cost[10 * 20 + 10]).toBeGreaterThan(1);
  });

  it("fences the edge of the area", () => {
    const truth = truthMap(world(20)).cost;
    expect(truth[0]).toBe(BLOCKED);
    expect(truth[10 * 20 + 10]).toBe(1);
  });

  it("updates incrementally to exactly what a rebuild gives", () => {
    const size = 24;
    const n = size * size;
    const random = rng(7);
    const map = new Costmap(size);
    const base = new Float32Array(n).fill(UNKNOWN_COST);
    const hazard = new Uint8Array(n);
    for (let round = 0; round < 40; round++) {
      const before = map.cost.slice();
      for (let k = 0; k < 6; k++) {
        const i = Math.floor(random() * n);
        if (random() < 0.5) {
          hazard[i] = 1 - hazard[i]!;
          map.setHazard(i, !!hazard[i]);
        } else {
          base[i] = 1 + random() * 4;
          map.setBase(i, base[i]);
        }
      }
      const { changed, raised } = map.flush();

      const fresh = new Costmap(size);
      for (let i = 0; i < n; i++) {
        fresh.setBase(i, base[i]!);
        fresh.setHazard(i, !!hazard[i]);
      }
      fresh.flush();
      expect(map.cost).toEqual(fresh.cost);
      expect(map.clearance).toEqual(fresh.clearance);

      const cells = [...map.cost.keys()];
      const byIndex = (a: number, b: number) => a - b;
      expect(changed.sort(byIndex)).toEqual(
        cells.filter((i) => map.cost[i] !== before[i]),
      );
      expect(raised.sort(byIndex)).toEqual(
        cells.filter((i) => map.cost[i]! > before[i]!),
      );
    }
  });
});

describe("stereo perception", () => {
  const pose = { x: 10, y: 30, heading: 0, pan: 0 };

  it("has depth noise that grows with range", () => {
    const p = new Perception(world(60));
    for (let k = 0; k < 30; k++) p.capture(0, pose);
    const { xyz, total } = p.cloud;
    let near = 0;
    let far = 0;
    let nn = 0;
    let nf = 0;
    for (let i = 0; i < total; i++) {
      const d = Math.hypot(xyz[i * 3]! - pose.x, xyz[i * 3 + 1]! - pose.y);
      const err = Math.abs(xyz[i * 3 + 2]!); // flat ground at height 0
      if (d < 6) {
        near += err;
        nn++;
      } else if (d > 12) {
        far += err;
        nf++;
      }
    }
    expect(nn).toBeGreaterThan(50);
    expect(nf).toBeGreaterThan(50);
    expect(far / nf).toBeGreaterThan((near / nn) * 3);
  });

  it("maps flat ground as easy and a boulder as no-go", () => {
    const m = new Mission({ ...world(60, [boulder(20, 30)]), start: pose });
    m.heading = 0;
    for (let k = 0; k < 10; k++) m.sense(true);
    expect(m.map.hazard[30 * 60 + 20]).toBe(1);
    expect(m.known[30 * 60 + 14]).toBeLessThan(1.5);
    expect(m.map.hazard[34 * 60 + 14]).toBe(0);
  });

  it("measures slope from its own points", () => {
    const ramp = (deg: number) => {
      const k = Math.tan((deg * Math.PI) / 180);
      const m = new Mission({
        ...world(60, [], (x) => Math.max(0, x - 16) * k),
        start: pose,
      });
      m.heading = 0;
      for (let k2 = 0; k2 < 12; k2++) m.sense(true);
      return m;
    };
    expect(ramp(12).map.hazard[30 * 60 + 19]).toBe(0);
    expect(ramp(12).known[30 * 60 + 19]).toBeGreaterThan(1.5);
    expect(ramp(28).map.hazard[30 * 60 + 19]).toBe(1);
  });
});

describe("planning", () => {
  const size = 10;
  const open = () => new Float32Array(size * size).fill(1);
  const step = (cost: Float32Array, a: number, b: number) =>
    (a % size !== b % size && ((a / size) | 0) !== ((b / size) | 0)
      ? Math.SQRT2
      : 1) *
    (cost[a]! + cost[b]!) *
    0.5;
  const pathCost = (cost: Float32Array, path: number[]) =>
    path.slice(1).reduce((sum, c, i) => sum + step(cost, path[i]!, c), 0);

  /** Reference Dijkstra (no heuristic, no heap) with the planner's moves and corner rule. */
  function cheapest(cost: Float32Array, start: number, goal: number) {
    if (cost[goal] === BLOCKED) return Infinity;
    const d = new Float64Array(size * size).fill(Infinity);
    const done = new Uint8Array(size * size);
    d[start] = 0;
    for (;;) {
      let cur = -1;
      for (let i = 0; i < d.length; i++)
        if (!done[i] && d[i]! < Infinity && (cur < 0 || d[i]! < d[cur]!))
          cur = i;
      if (cur < 0 || cur === goal) return d[goal]!;
      done[cur] = 1;
      const cx = cur % size;
      const cy = (cur / size) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if ((!dx && !dy) || x < 0 || y < 0 || x >= size || y >= size)
            continue;
          const next = y * size + x;
          if (cost[next] === BLOCKED) continue;
          if (
            dx &&
            dy &&
            (cost[cy * size + x] === BLOCKED || cost[y * size + cx] === BLOCKED)
          )
            continue;
          d[next] = Math.min(d[next]!, d[cur]! + step(cost, cur, next));
        }
    }
  }

  it("goes straight on open ground", () => {
    expect(findPath(open(), size, 0, 9)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("routes around a wall and fails when fully walled off", () => {
    const cost = open();
    for (let y = 0; y < 8; y++) cost[y * size + 5] = BLOCKED;
    expect(findPath(cost, size, 0, 9)!.every((c) => cost[c] !== BLOCKED)).toBe(
      true,
    );
    cost[8 * size + 5] = cost[9 * size + 5] = BLOCKED;
    expect(findPath(cost, size, 0, 9)).toBeNull();
  });

  it("does not cut corners between blocked cells", () => {
    const cost = open();
    cost[1] = BLOCKED;
    cost[size] = BLOCKED;
    expect(findPath(cost, size, 0, size + 1)).toBeNull();
  });

  it("smooths a staircase into a straight line on open ground", () => {
    const cost = open();
    const path = findPath(cost, size, 0, 9 * size + 5)!;
    const smooth = smoothPath(cost, size, path);
    expect(smooth.length).toBeLessThan(path.length);
    expect(smooth[0]).toEqual({ x: 0, y: 0 });
    expect(smooth.at(-1)).toEqual({ x: 5, y: 9 });
  });

  it("finds routes as cheap as an exhaustive search", () => {
    const random = rng(3);
    for (let trial = 0; trial < 200; trial++) {
      const cost = new Float32Array(size * size).map(() =>
        random() < 0.2 ? BLOCKED : 1 + random() * 4,
      );
      const start = Math.floor(random() * size * size);
      const goal = Math.floor(random() * size * size);
      const path = findPath(cost, size, start, goal);
      const best = cheapest(cost, start, goal);
      if (best === Infinity) expect(path).toBeNull();
      else expect(pathCost(cost, path!)).toBeCloseTo(best, 9);
    }
  });
});

describe("Mission", () => {
  it("starts with no map beyond its sensor range", () => {
    const m = new Mission(world(120));
    m.finishPanorama();
    expect(m.known[80 * 120 + 80]).toBeCloseTo(UNKNOWN_COST);
    expect(m.seen[5 * 120 + 9]).toBe(1);
    expect(m.seen.reduce((a, b) => a + b, 0) / m.seen.length).toBeLessThan(0.1);
  });

  it("feels a slope through its IMU", () => {
    const k = Math.tan((10 * Math.PI) / 180);
    const m = new Mission(world(40, [], (x) => x * k));
    m.heading = 0;
    m.setGoal({ x: 30, y: 5 });
    const req = m.takePlanRequest()!;
    m.acceptPlan(req.id, findPath(req.cost, 40, req.start, req.goal));
    m.step(1 / 60);
    expect((m.imu.pitch * 180) / Math.PI).toBeGreaterThan(8);
    expect(Math.abs(m.imu.roll)).toBeLessThan(0.05);
  });

  it("can't see past a ridge until it gets a view", () => {
    const wall = (x: number) => (x >= 12 && x <= 13 ? 8 : 0);
    const m = new Mission(world(60, [], wall));
    m.finishPanorama();
    expect(m.seen[5 * 60 + 10]).toBe(1);
    expect(m.seen[5 * 60 + 18]).toBe(0);
  });

  it("maps as it drives and arrives", () => {
    const m = new Mission(world(60));
    m.setGoal({ x: 50, y: 50 });
    run(m);
    expect(m.state).toBe("arrived");
    expect(m.seen[50 * 60 + 50]).toBe(1);
  });

  it("reroutes when it sees a boulder on its route", () => {
    const m = new Mission(world(60, [boulder(30, 30)]));
    m.setGoal({ x: 52, y: 52 });
    run(m);
    expect(m.state).toBe("arrived");
    expect(m.replans).toBeGreaterThan(0);
    expect(m.recoveries).toBe(0);
  });

  it("backs up and goes around a rock its sensors missed", () => {
    const t = world(60, [boulder(30, 30)]);
    const m = new Mission(t);
    // Blind the cameras to rocks: the map will never show it.
    m.perception.surface = (x, y) => heightAt(t, x, y);
    m.setGoal({ x: 52, y: 52 });
    run(m);
    expect(m.recoveries).toBeGreaterThan(0);
    expect(m.state).toBe("arrived");
  });

  it("picks its way off a hazard it finds itself standing on", () => {
    // A 60 cm step runs right under the start. The rover must get clear of
    // it on the side it is on, without driving down it.
    const t = world(40, [], (x) => (x >= 20 ? 0.6 : 0));
    t.start = { x: 20, y: 20 };
    const m = new Mission(t);
    m.setGoal({ x: 32, y: 20 });
    let lowest = Infinity;
    drive(m, {
      seconds: 60,
      during: () => (lowest = Math.min(lowest, m.pos.x)),
    });
    expect(m.state).toBe("arrived");
    expect(lowest).toBeGreaterThan(19);
  });

  it("gives up when boxed in", () => {
    const ring = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return boulder(15 + Math.cos(a) * 6, 15 + Math.sin(a) * 6);
    });
    const t = world(40, ring);
    t.start = { x: 15, y: 15 };
    const m = new Mission(t);
    m.setGoal({ x: 35, y: 35 });
    run(m);
    expect(m.state).toBe("stuck");
  });
});

describe("generated worlds", () => {
  // End-to-end on seeds where a route exists: the rover finds it without a
  // map.
  it.each([11, 19, 27])(
    "reaches the far corner, seed %i",
    (seed) => {
      const t = generateTerrain(seed);
      expect(hasRoute(t, truthMap(t).cost)).toBe(true);
      const m = new Mission(t);
      m.setGoal(defaultGoal(t.size));
      run(m, 240);
      expect(m.state, m.reason).toBe("arrived");
    },
    30_000,
  );
});

describe("bake", () => {
  it("puts ground behind a wall in the sun's shadow", () => {
    // A tall wall at x = 20; the sun comes from low x, so x > 20 is shaded.
    expect(SUN.x).toBeLessThan(0);
    const t = world(40, [], (x) => (x >= 19 && x <= 20 ? 6 : 0));
    const { sunlit } = bake(t);
    const n = t.detailSize;
    const at = (x: number, y: number) => sunlit[y * DETAIL * n + x * DETAIL]!;
    expect(at(10, 30)).toBeGreaterThan(0.9);
    expect(at(23, 30)).toBeLessThan(0.1);
  });
});
