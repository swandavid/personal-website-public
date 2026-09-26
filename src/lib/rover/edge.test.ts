/**
 * Edge cases around hazards appearing while the rover is driving or waiting
 * on a plan. The planner here answers a few frames late, like the worker in
 * the real app, which is where stale plans can slip through.
 */
import { describe, expect, it } from "vitest";
import { BLOCKED } from "./costmap";
import { Mission } from "./mission";
import { findPath } from "./planner";
import { defaultGoal, generateTerrain, rng, type Rock } from "./terrain";
import { drive as driveWith, world, type DriveOptions } from "./test-utils";

const flat = (rocks: Rock[] = []) => ({
  ...world(64, rocks),
  start: { x: 6, y: 30 },
});

const boulder = (x: number, y: number): Rock => ({ x, y, r: 1.3, h: 0.9 });

/** Every cell a route passes through, sampled every half metre. */
function routeCells(m: Mission, pts: { x: number; y: number }[]) {
  const cells: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
    for (let k = 0; k <= n; k++)
      cells.push(
        m.cellOf({
          x: a.x + ((b.x - a.x) * k) / n,
          y: a.y + ((b.y - a.y) * k) / n,
        }),
      );
  }
  return cells;
}

/** A slow planner, a time limit, and no touching rocks. */
const drive = (m: Mission, options: DriveOptions = {}) =>
  driveWith(m, { latency: 3, seconds: 90, noContact: true, ...options });

describe("hazards appearing mid-drive", () => {
  it("never drives into a no-go zone it already knows about", () => {
    const m = new Mission(flat());
    m.setGoal({ x: 58, y: 30 });
    let dropped = false;
    const violations = drive(m, {
      during: (f, planning) => {
        // Wait until a replan is in flight, then drop a wall across the
        // route a few metres ahead of the rover.
        if (dropped || f < 60 || !planning) return;
        dropped = true;
        const x = m.pos.x + 7;
        for (let i = -4; i <= 4; i++) m.addRock(boulder(x, m.pos.y + i * 2));
      },
    });
    expect(dropped).toBe(true);
    expect(violations).toEqual([]);
    expect(m.state).toBe("arrived");
  });

  it("handles rocks dropped one at a time in front of it", () => {
    const m = new Mission(flat());
    m.setGoal({ x: 58, y: 30 });
    let placed = 0;
    let x = 0;
    const violations = drive(m, {
      during: (f) => {
        if (f < 60 || placed >= 9 || f % 2) return;
        if (placed === 0) x = m.pos.x + 7;
        m.addRock(boulder(x, m.pos.y + (placed - 4) * 2));
        placed++;
      },
    });
    expect(violations).toEqual([]);
    expect(m.state).toBe("arrived");
  });

  it("ignores a plan that was computed before new hazards appeared", () => {
    const m = new Mission(flat());
    m.heading = 0; // facing the route, so the boulder will be in view
    m.setGoal({ x: 58, y: 30 });
    const req = m.takePlanRequest()!;
    const stale = findPath(req.cost, 64, req.start, req.goal)!;
    m.addRock(boulder(14, 30)); // lands on the straight route, inside sensor range
    expect(m.known[30 * 64 + 14]).toBe(BLOCKED);
    expect(
      routeCells(m, [m.pos, m.goal!]).some((c) => m.known[c] === BLOCKED),
    ).toBe(true);
    m.acceptPlan(req.id, stale);
    // The stale route is thrown away and a new search requested.
    expect(m.path).toEqual([]);
    expect(m.state).toBe("planning");
    expect(m.takePlanRequest()).not.toBeNull();
  });

  it("routes around a wall with a gap instead of through it", () => {
    const wall = Array.from({ length: 14 }, (_, i) =>
      boulder(30, 14 + i * 2.2),
    ).filter((r) => Math.abs(r.y - 30) > 4);
    const m = new Mission(flat(wall));
    m.setGoal({ x: 58, y: 30 });
    expect(drive(m)).toEqual([]);
    expect(m.state).toBe("arrived");
  });

  it("stops and reports stuck when fully walled off, without entering the wall", () => {
    const wall = Array.from({ length: 30 }, (_, i) => boulder(30, i * 2.2));
    const m = new Mission(flat(wall));
    m.setGoal({ x: 58, y: 30 });
    expect(drive(m)).toEqual([]);
    expect(m.state).toBe("stuck");
    expect(m.pos.x).toBeLessThan(30);
  });

  it("gets walled in by rocks dropped around it and stays put", () => {
    const m = new Mission(flat());
    m.setGoal({ x: 58, y: 30 });
    const violations = drive(m, {
      during: (f) => {
        if (f !== 60) return;
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2;
          m.addRock(
            boulder(m.pos.x + Math.cos(a) * 6, m.pos.y + Math.sin(a) * 6),
          );
        }
      },
    });
    expect(violations).toEqual([]);
    expect(m.state).toBe("stuck");
  });

  it("moves a goal set inside a no-go zone to the nearest open ground", () => {
    const m = new Mission(flat([boulder(20, 30)]));
    m.setGoal({ x: 20, y: 30 });
    const req = m.takePlanRequest()!;
    expect(m.known[req.goal]).not.toBe(BLOCKED);
  });

  it("clamps goals outside the map", () => {
    const m = new Mission(flat());
    m.setGoal({ x: -40, y: 400 });
    expect(m.goal).toEqual({ x: 2, y: 61 });
    m.setGoal({ x: 400, y: -40 });
    expect(m.goal).toEqual({ x: 61, y: 2 });
  });

  it("takes a new goal mid-drive", () => {
    const m = new Mission(flat());
    m.setGoal({ x: 58, y: 30 });
    drive(m, { seconds: 1 });
    expect(m.state).toBe("driving");
    m.setGoal({ x: 6, y: 50 });
    drive(m);
    expect(m.state).toBe("arrived");
    expect(Math.hypot(m.pos.x - 6, m.pos.y - 50)).toBeLessThan(1.5);
  });
});

describe("generated worlds under harassment", () => {
  // Real lunar terrain, a slow planner, and boulders dropped across the
  // route at random moments. The rover may reroute, back up or give up, but
  // it must never step into ground it already knows is no-go.
  it.each([5, 12, 23, 31])("seed %i", (seed) => {
    const t = generateTerrain(seed);
    const m = new Mission(t);
    m.setGoal(defaultGoal(t.size));
    const random = rng(seed * 97);
    const violations = drive(m, {
      during: (f) => {
        if (f < 120 || f % 90 || !m.path.length) return;
        // Drop a short wall across the route about 8 m ahead.
        const a = m.heading;
        const cx = m.pos.x + Math.cos(a) * 8;
        const cy = m.pos.y + Math.sin(a) * 8;
        const len = 2 + Math.floor(random() * 4);
        for (let i = -len; i <= len; i++)
          m.addRock(
            boulder(cx - Math.sin(a) * i * 2, cy + Math.cos(a) * i * 2),
          );
      },
      latency: 4,
      seconds: 240,
      noContact: false,
    });
    expect(violations).toEqual([]);
    expect(["arrived", "stuck"]).toContain(m.state);
  });
});
