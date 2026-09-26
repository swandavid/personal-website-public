/**
 * Build a complete world for the demo: terrain, the true cost map and the
 * baked render data. Runs in the worker so the page never stalls on it.
 */
import { bake, type Baked } from "./bake";
import { nearestPassable, truthMap } from "./costmap";
import { findPath } from "./planner";
import { defaultGoal, generateTerrain, type Terrain } from "./terrain";

export interface World {
  terrain: Terrain;
  truth: Float32Array;
  baked: Baked;
}

/** Seeds tried when searching for a world whose opening drive has a route. */
const SEARCH_SEEDS = 12;

/** Whether the opening drive is possible with perfect knowledge. */
export function hasRoute(terrain: Terrain, truth: Float32Array) {
  const n = terrain.size;
  const goal = nearestPassable(truth, n, defaultGoal(n));
  const start = terrain.start.y * n + terrain.start.x;
  return !!goal && !!findPath(truth, n, start, goal.y * n + goal.x);
}

/**
 * With `search`, step through seeds until the opening drive is possible
 * with perfect knowledge. The rover still has to discover the route; this
 * only rules out worlds where no route exists at all. If none of the seeds
 * tried has one, the last is used anyway: the rover explores and reports
 * itself stuck, which is still an honest drive.
 */
export function buildWorld(seed: number, search: boolean): World {
  let terrain = generateTerrain(seed);
  let truth = truthMap(terrain).cost;
  for (
    let s = seed + 1;
    search && s < seed + SEARCH_SEEDS && !hasRoute(terrain, truth);
    s++
  ) {
    terrain = generateTerrain(s);
    truth = truthMap(terrain).cost;
  }
  return { terrain, truth, baked: bake(terrain) };
}

/** Buffers to hand over without copying. */
export function transferables(w: World): Transferable[] {
  const { terrain: t, baked: b } = w;
  return [
    t.detail.buffer,
    t.slope.buffer,
    t.rough.buffer,
    w.truth.buffer,
    b.positions.buffer,
    b.gridUv.buffer,
    b.index.buffer,
    b.albedo.buffer,
    b.light.buffer,
    b.sunlit.buffer,
    b.minimap.buffer,
  ];
}
