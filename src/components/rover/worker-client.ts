/** Promise wrapper around the demo's worker, shared across mounts until stopped. */
import type { WorkerRequest, WorkerResponse } from "@/lib/rover/rover.worker";

type Reply = Exclude<WorkerResponse, { kind: "error" }>;
type Request =
  | Omit<Extract<WorkerRequest, { kind: "plan" }>, "id">
  | Omit<Extract<WorkerRequest, { kind: "world" }>, "id">;

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<
  number,
  { resolve: (r: Reply) => void; reject: (e: Error) => void }
>();

function getWorker() {
  if (!worker) {
    worker = new Worker(
      new URL("../../lib/rover/rover.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const r = e.data;
      const call = waiting.get(r.id);
      waiting.delete(r.id);
      if (r.kind === "error") call?.reject(new Error(r.message));
      else call?.resolve(r);
    };
    // The worker failed to load or crashed: nothing pending will be answered.
    worker.onerror = (e) => {
      const err = new Error(e.message || "Rover worker failed");
      const calls = [...waiting.values()];
      stopWorker();
      calls.forEach((c) => c.reject(err));
    };
  }
  return worker;
}

export function ask<K extends Request["kind"]>(
  msg: Extract<Request, { kind: K }>,
  transfer: Transferable[] = [],
) {
  const id = ++nextId;
  return new Promise<Extract<Reply, { kind: K }>>((resolve, reject) => {
    waiting.set(id, {
      resolve: resolve as (r: Reply) => void,
      reject,
    });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

/** Terminate the worker; replies still pending are dropped. */
export function stopWorker() {
  worker?.terminate();
  worker = null;
  waiting.clear();
}
