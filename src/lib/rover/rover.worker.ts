/// <reference lib="webworker" />
/**
 * Background thread for the demo: builds worlds (terrain, costs, baked
 * lighting) and runs route searches, so the page's main thread only renders.
 */
import { findPath } from "./planner";
import { buildWorld, transferables, type World } from "./world";

export type WorkerRequest =
  | {
      kind: "plan";
      id: number;
      cost: Float32Array;
      size: number;
      start: number;
      goal: number;
    }
  | { kind: "world"; id: number; seed: number; search: boolean };

export type WorkerResponse =
  | { kind: "plan"; id: number; path: number[] | null; ms: number }
  | { kind: "world"; id: number; world: World; ms: number }
  | { kind: "error"; id: number; message: string };

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  self.postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const t0 = performance.now();
  try {
    if (msg.kind === "plan") {
      const path = findPath(msg.cost, msg.size, msg.start, msg.goal);
      post({ kind: "plan", id: msg.id, path, ms: performance.now() - t0 });
    } else {
      const world = buildWorld(msg.seed, msg.search);
      post(
        { kind: "world", id: msg.id, world, ms: performance.now() - t0 },
        transferables(world),
      );
    }
  } catch (err) {
    // Answer anyway, so the caller waiting on this id can fail instead of hang.
    post({ kind: "error", id: msg.id, message: String(err) });
  }
};
