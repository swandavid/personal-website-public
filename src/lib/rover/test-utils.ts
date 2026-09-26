import { BLOCKED } from "./costmap";
import { wheels, type Point } from "./geometry";
import type { Mission, PlanRequest } from "./mission";
import { findPath } from "./planner";
import { DETAIL, type Rock, type Terrain } from "./terrain";

/** Flat test world starting at (5, 5), optionally with a height function. */
export function world(
  size: number,
  rocks: Rock[] = [],
  h?: (x: number, y: number) => number,
): Terrain {
  const detailSize = (size - 1) * DETAIL + 1;
  const detail = new Float32Array(detailSize * detailSize);
  if (h)
    for (let j = 0; j < detailSize; j++)
      for (let i = 0; i < detailSize; i++)
        detail[j * detailSize + i] = h(i / DETAIL, j / DETAIL);
  return {
    seed: 0,
    size,
    detailSize,
    detail,
    slope: new Float32Array(size * size),
    rough: new Float32Array(size * size),
    rocks,
    craters: [],
    start: { x: 5, y: 5 },
  };
}

export interface DriveOptions {
  /** Called at the start of every frame, with whether a plan is in flight. */
  during?: (frame: number, planning: boolean) => void;
  /** Frames the planner takes to answer, like the worker in the real app. */
  latency?: number;
  seconds?: number;
  /**
   * Count touching a rock as a violation: on flat ground every rock in range
   * is visible, so touching one means it drove at a hazard it knew about.
   */
  noContact?: boolean;
}

/**
 * Drive until the mission ends or time runs out, at 60 frames a second.
 * Returns every time the rover stepped from known-open ground into a known
 * no-go cell or put a wheel onto a known hazard (and, with `noContact`,
 * touched a rock).
 */
export function drive(
  m: Mission,
  { during, latency = 0, seconds = 120, noContact = false }: DriveOptions = {},
) {
  const n = m.terrain.size;
  let inflight: { due: number; req: PlanRequest } | null = null;
  const violations: string[] = [];
  for (
    let f = 0;
    f < seconds * 60 && m.state !== "arrived" && m.state !== "stuck";
    f++
  ) {
    during?.(f, !!inflight);
    if (!inflight) {
      const req = m.takePlanRequest();
      if (req) inflight = { due: f + latency, req };
    }
    if (inflight && f >= inflight.due) {
      const { id, cost, start, goal } = inflight.req;
      m.acceptPlan(id, findPath(cost, n, start, goal));
      inflight = null;
    }
    // Judged on the map as it was before the step: the step's own frames
    // may reveal hazards where the rover has just moved, which it could not
    // have known.
    const known = m.known.slice();
    const hazard = m.map.hazard.slice();
    const onHazard = (p: Point, heading: number) =>
      wheels(p, heading).filter((w) => hazard[m.cellOf(w)]).length;
    const before = m.cellOf(m.pos);
    const state = m.state;
    const from = { ...m.pos };
    const heading = m.heading;
    const r = m.step(1 / 60);
    if (
      state === "driving" &&
      onHazard(m.pos, m.heading) > onHazard(from, heading)
    )
      violations.push(
        `frame ${f}: put a wheel on a known hazard at ${m.pos.x.toFixed(1)},${m.pos.y.toFixed(1)}`,
      );
    if (noContact && r.bumped)
      violations.push(
        `frame ${f}: drove into a rock at ${m.pos.x.toFixed(1)},${m.pos.y.toFixed(1)}`,
      );
    const after = m.cellOf(m.pos);
    if (
      state === "driving" &&
      known[before] !== BLOCKED &&
      after !== before &&
      known[after] === BLOCKED
    )
      violations.push(
        `frame ${f}: entered no-go cell ${after % n},${Math.floor(after / n)}`,
      );
  }
  return violations;
}
