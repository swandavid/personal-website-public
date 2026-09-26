/**
 * Wires a Mission, the worker and the RoverScene to the demo's controls.
 * Worlds and route searches run in the worker, shaders compile before the
 * poster lifts, and frames are drawn only while something is moving.
 */
import { BLOCKED } from "@/lib/rover/costmap";
import {
  Mission,
  type MissionState,
  type Point,
  type StepResult,
} from "@/lib/rover/mission";
import { defaultGoal } from "@/lib/rover/terrain";
import type { World } from "@/lib/rover/world";
import { accentColor } from "./accent";
import { Minimap, infernoCss } from "./minimap";
import { RoverScene } from "./scene";
import { POINT_FADE_S } from "./sensors";
import { ask, stopWorker } from "./worker-client";

export type Stage = "engine" | "terrain" | "scene";

const DEFAULT_SEED = 2026;
const HUD_INTERVAL = 0.16;
/** A press that moves less than this (px) and lifts within CLICK_MS is a click. */
const CLICK_SLOP = 6;
const CLICK_MS = 450;
/** How long the pointer must rest before the goal preview shows. */
const HOVER_REST_MS = 140;
const DEG = 180 / Math.PI;
/** Frames longer than this (s), for this long in total, drop the resolution. */
const SLOW_FRAME = 0.026;
const SLOW_FOR = 1.2;
/** A beat to see the rover before it sets off, after a load or after Run. */
const START_DELAY_MS = 800;
const PLAY_DELAY_MS = 500;

let firstWorld: Promise<World> | null = null;

const requestWorld = (seed: number, search: boolean) =>
  ask({ kind: "world", seed, search }).then((r) => r.world);

const urlSeed = () => {
  const s = Number(new URL(location.href).searchParams.get("seed"));
  return Number.isInteger(s) && s > 0 ? s : null;
};

/** Start building the first world in the background. Safe to call repeatedly. */
export function prepare() {
  const seed = urlSeed();
  firstWorld ??= requestWorld(seed ?? DEFAULT_SEED, seed === null);
}

// ---------- mount ----------

const STATUS: Record<MissionState, [string, "ok" | "busy" | "warn"]> = {
  idle: ["Ready", "ok"],
  planning: ["Planning", "busy"],
  driving: ["Mapping and driving", "ok"],
  backing: ["Backing up", "busy"],
  arrived: ["Arrived", "ok"],
  stuck: ["Stuck", "warn"],
};

/**
 * Mount the demo. With `startPaused` it draws one still of the world (the
 * opening panorama mapped, the rover waiting) and stops until `play()`.
 */
export async function mountRover(
  root: HTMLElement,
  onStage: (s: Stage) => void = () => {},
  startPaused = false,
) {
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const canvas = $<HTMLCanvasElement>("[data-rover-canvas]");
  const stat = (name: string) => $<HTMLElement>(`[data-stat="${name}"]`);
  const status = stat("status");
  const announce = $<HTMLElement>("[data-announce]");
  const hint = $<HTMLElement>("[data-hint]");
  const costToggle = $<HTMLButtonElement>("[data-toggle-cost]");
  const followToggle = $<HTMLButtonElement>("[data-toggle-follow]");
  const sensorToggle = $<HTMLButtonElement>("[data-toggle-sensors]");
  const horizon = $<SVGGElement>("[data-horizon]");
  const newTerrain = $<HTMLButtonElement>("[data-new-terrain]");
  const legend = $<HTMLElement>("[data-legend]");
  $<HTMLElement>("[data-legend-bar]").style.background = infernoCss();

  prepare();
  const accent = accentColor();
  const scene = new RoverScene(canvas, accent.color);
  const minimap = new Minimap(
    $<HTMLCanvasElement>("[data-minimap]"),
    accent.css,
    (p) => sendTo(p),
  );
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  scene.setCostView(true);

  let mission!: Mission;
  let costView = true;
  let planPending = false;
  let pathVersion = -1;
  let drivenAtPlan = 0;
  let trailLength = 0;
  let visible = true;
  let hudClock = 0;
  let lastStatus = "";
  let generation = 0;
  let sensorsOn = true;
  let follow = true;
  /** When the last stereo points arrived, so their fade can finish drawing. */
  let lastPoints = 0;
  let paused = startPaused;

  // Adaptive resolution: start sharp, step down if frames run long.
  let pixelRatio = Math.min(
    devicePixelRatio,
    matchMedia("(pointer: coarse)").matches ? 1.5 : 1.75,
  );
  let slowTime = 0;
  scene.setPixelRatio(pixelRatio);

  /** Distance left along the planned route, or straight-line if none yet. */
  const routeLength = () => {
    if (!mission.path.length)
      return mission.goal
        ? Math.hypot(
            mission.goal.x - mission.pos.x,
            mission.goal.y - mission.pos.y,
          )
        : 0;
    const pts = mission.remaining();
    let d = 0;
    for (let i = 1; i < pts.length; i++)
      d += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    return d;
  };

  const showHud = () => {
    const [label, tone] = STATUS[mission.state];
    const text =
      mission.state === "backing" || mission.state === "stuck"
        ? mission.reason || label
        : label;
    const full =
      mission.state === "stuck" ? `Stuck: ${text.toLowerCase()}` : text;
    if (full !== lastStatus) {
      lastStatus = full;
      status.textContent = full;
      status.dataset.tone = tone;
      // Screen readers hear how a drive ends, not every replan along the way.
      if (mission.state === "arrived" || mission.state === "stuck")
        announce.textContent = full;
    }
    const set = (k: string, v: string) => {
      const el = stat(k);
      if (el.textContent !== v) el.textContent = v;
    };
    set(
      "remaining",
      mission.goal && mission.state !== "arrived"
        ? String(Math.round(routeLength()))
        : "–",
    );
    set("driven", String(Math.round(mission.driven)));
    set("replans", String(mission.replans));
    set("recoveries", String(mission.recoveries));
    const pts = mission.points();
    set(
      "points",
      pts > 1e6 ? `${(pts / 1e6).toFixed(1)}M` : `${Math.round(pts / 1e3)}k`,
    );
    const { roll, pitch } = mission.imu;
    const sign = (v: number) =>
      `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}°`;
    set("roll", sign(roll * DEG));
    set("pitch", sign(pitch * DEG));
    horizon.setAttribute(
      "transform",
      `rotate(${(-roll * DEG).toFixed(1)} 12 12) translate(0 ${(pitch * DEG * 0.35).toFixed(2)})`,
    );
    minimap.draw(mission, costView);
  };

  // ---------- planning ----------

  const dispatchPlan = () => {
    if (planPending) return;
    const req = mission.takePlanRequest();
    if (!req) return;
    if (mission.goal) scene.setGoal(mission.goal);
    const forMission = mission;
    const { id: planId, ...search } = req;
    planPending = true;
    ask({ kind: "plan", size: mission.terrain.size, ...search }, [
      req.cost.buffer,
    ])
      .then(
        (r) => {
          if (forMission !== mission) return;
          stat("plan").textContent = r.ms.toFixed(1);
          mission.acceptPlan(planId, r.path);
        },
        (err: unknown) => {
          // A failed search reads as no route, rather than planning forever.
          console.error(err);
          if (forMission === mission) mission.acceptPlan(planId, null);
        },
      )
      .finally(() => {
        planPending = false;
        wake();
      });
  };

  const applyStep = (r: StepResult) => {
    if (r.sensed.length) scene.updateKnowledge(mission, r.sensed);
    if (r.abandoned) scene.setGhost(r.abandoned);
  };

  // ---------- world ----------

  const load = (world: World) => {
    generation++;
    mission = new Mission(world.terrain);
    scene.setWorld(world);
    minimap.setWorld(world);
    scene.setGoal(null);
    scene.updateKnowledge(mission);
    scene.frameRover(mission);
    pathVersion = -1;
    trailLength = 0;
    stat("seed").textContent = String(world.terrain.seed);
    stat("plan").textContent = "–";
    showHud();
    if (paused) return;
    const g = generation;
    setTimeout(() => {
      if (g !== generation) return;
      mission.setGoal(defaultGoal(world.terrain.size));
      wake();
    }, START_DELAY_MS);
  };

  // ---------- frame loop (runs only while something is changing) ----------

  let raf = 0;
  let last = 0;

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    for (let left = dt; left > 1e-6; left -= 1 / 60)
      applyStep(mission.step(Math.min(left, 1 / 60)));
    dispatchPlan();

    if (mission.pathVersion !== pathVersion) {
      pathVersion = mission.pathVersion;
      drivenAtPlan = mission.driven;
      scene.setPath(mission.path.length ? mission.remaining() : []);
    } else if (mission.state === "driving") {
      scene.trimPath(mission.driven - drivenAtPlan);
    }
    if (mission.trail.length !== trailLength) {
      trailLength = mission.trail.length;
      scene.appendTracks(mission.trail);
    }
    scene.updateRover(mission, dt);
    const clock = now / 1000;
    if (sensorsOn) {
      const before = mission.perception.cloud.total;
      scene.syncCloud(mission.perception.cloud, clock);
      if (mission.perception.cloud.total !== before || mission.speed)
        lastPoints = clock;
    }
    const fading = sensorsOn && clock - lastPoints < POINT_FADE_S;
    const ghost = scene.fadeGhost(dt);
    const camera = scene.updateCamera(mission, dt);
    const orbit = scene.controls.update();
    scene.render();

    hudClock += dt;
    if (hudClock > HUD_INTERVAL) {
      hudClock = 0;
      showHud();
    }

    // Step resolution down once if the device is struggling.
    if (dt > SLOW_FRAME && pixelRatio > 1) slowTime += dt;
    else slowTime = Math.max(0, slowTime - dt * 0.5);
    if (slowTime > SLOW_FOR) {
      pixelRatio = 1;
      slowTime = 0;
      scene.setPixelRatio(1);
      resize();
    }

    const active =
      mission.state === "driving" ||
      mission.state === "backing" ||
      mission.state === "planning";
    if (active || planPending || ghost || camera || orbit || fading) {
      raf = visible ? requestAnimationFrame(frame) : 0;
    } else {
      raf = 0;
      showHud();
    }
  };

  function wake() {
    if (paused) return;
    if (!raf && visible && mission) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  // ---------- input ----------

  /** The press that might become a click (a drag or a second finger cancels it). */
  let press: {
    x: number;
    y: number;
    id: number;
    t: number;
    pans: boolean;
    moved: boolean;
  } | null = null;
  let pointers = 0;

  const setFollow = (on: boolean) => {
    follow = on;
    followToggle.setAttribute("aria-pressed", String(on));
    scene.setFollow(on);
    wake();
  };

  /** A goal chosen by the visitor (canvas or minimap). */
  const sendTo = (p: Point) => {
    mission.setGoal(p);
    scene.setGoal(mission.goal);
    root.dataset.goalSet = "";
    wake();
  };

  // Preview where a click would send the rover once the pointer rests: one
  // pick per rest rather than one per mouse move.
  const hintText = $<HTMLElement>("[data-hint-text]");
  const hintNogo = $<HTMLElement>("[data-hint-nogo]");
  let hoverTimer = 0;
  let hoverShown = false;
  const showHover = (at: { x: number; y: number } | null) => {
    const p = at && mission ? scene.pick(at.x, at.y) : null;
    const nogo = !!p && mission.known[mission.cellOf(p)] === BLOCKED;
    if (!p && !hoverShown) return;
    hoverShown = !!p;
    scene.setHover(p, nogo);
    hint.toggleAttribute("data-nogo", nogo);
    hintText.hidden = nogo;
    hintNogo.hidden = !nogo;
    wake();
  };
  const restHover = (at: { x: number; y: number } | null) => {
    clearTimeout(hoverTimer);
    if (hoverShown) showHover(null);
    if (at) hoverTimer = window.setTimeout(() => showHover(at), HOVER_REST_MS);
  };

  const onDown = (e: PointerEvent) => {
    pointers++;
    restHover(null);
    // A second finger means a pinch or two-finger orbit, never a tap.
    press =
      pointers === 1 && e.button === 0
        ? {
            x: e.clientX,
            y: e.clientY,
            id: e.pointerId,
            t: performance.now(),
            pans:
              e.pointerType === "mouse" &&
              !(e.shiftKey || e.ctrlKey || e.metaKey),
            moved: false,
          }
        : null;
  };
  const onMove = (e: PointerEvent) => {
    if (press && press.id === e.pointerId) {
      if (
        !press.moved &&
        Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP
      ) {
        press.moved = true;
        // Sliding the map means looking somewhere else: stop following.
        if (press.pans && follow) setFollow(false);
      }
      return;
    }
    if (e.pointerType !== "mouse") return;
    if (!e.buttons) pointers = 0; // a release that happened off the canvas
    if (!pointers) restHover({ x: e.clientX, y: e.clientY });
  };
  const onUp = (e: PointerEvent) => {
    pointers = Math.max(0, pointers - 1);
    const p = press;
    if (!p || p.id !== e.pointerId || !mission) return;
    press = null;
    if (p.moved || performance.now() - p.t > CLICK_MS) return;
    const at = scene.pick(e.clientX, e.clientY);
    if (at) sendTo(at);
    if (e.pointerType === "mouse") restHover({ x: e.clientX, y: e.clientY });
  };

  const listeners = new AbortController();
  const { signal } = listeners;
  canvas.addEventListener("pointerdown", onDown, { signal });
  canvas.addEventListener("pointermove", onMove, { signal });
  canvas.addEventListener("pointerup", onUp, { signal });
  canvas.addEventListener(
    "pointercancel",
    (e) => {
      pointers = Math.max(0, pointers - 1);
      if (press?.id === e.pointerId) press = null;
    },
    { signal },
  );
  canvas.addEventListener(
    "pointerleave",
    (e) => {
      if (e.pointerType === "mouse" && !pointers) restHover(null);
    },
    { signal },
  );
  canvas.addEventListener("contextmenu", (e) => e.preventDefault(), {
    signal,
  });
  scene.controls.addEventListener("start", wake);
  canvas.addEventListener("wheel", () => scene.releaseZoom(), {
    passive: true,
    signal,
  });

  costToggle.addEventListener(
    "click",
    () => {
      costView = !costView;
      costToggle.setAttribute("aria-pressed", String(costView));
      legend.hidden = !costView;
      scene.setCostView(costView);
      showHud();
      wake();
    },
    { signal },
  );

  followToggle.setAttribute("aria-pressed", "true");
  followToggle.addEventListener("click", () => setFollow(!follow), { signal });

  sensorToggle.setAttribute("aria-pressed", "true");
  sensorToggle.addEventListener(
    "click",
    () => {
      sensorsOn = !sensorsOn;
      sensorToggle.setAttribute("aria-pressed", String(sensorsOn));
      scene.setSensorsVisible(sensorsOn);
      if (sensorsOn) lastPoints = performance.now() / 1000;
      wake();
    },
    { signal },
  );

  const onNewTerrain = async () => {
    newTerrain.disabled = true;
    const world = await requestWorld(
      Math.floor(Math.random() * 1e6),
      true,
    ).finally(() => (newTerrain.disabled = false));
    const url = new URL(location.href);
    url.searchParams.set("seed", String(world.terrain.seed));
    history.replaceState(history.state, "", url);
    load(world);
    wake();
  };
  newTerrain.addEventListener("click", onNewTerrain, { signal });

  // ---------- lifecycle ----------

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    scene.resize(width, height);
    if (mission) {
      if (paused) scene.controls.update();
      scene.render();
      wake();
    }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const io = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) wake();
  });
  io.observe(canvas);

  const themeWatch = new MutationObserver(() => {
    const a = accentColor();
    scene.setAccent(a.color);
    minimap.accent = a.css;
    wake();
  });
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  const applyMotion = () => scene.setReducedMotion(reduced.matches);
  reduced.addEventListener("change", applyMotion, { signal });
  applyMotion();

  const teardown = () => {
    generation++;
    cancelAnimationFrame(raf);
    clearTimeout(hoverTimer);
    listeners.abort();
    ro.disconnect();
    io.disconnect();
    themeWatch.disconnect();
    scene.dispose();
    stopWorker();
  };

  // Load in stages; the poster stays up until the first frame is drawn.
  try {
    onStage("terrain");
    // Taken before awaiting, so a failed build isn't reused by a retry.
    const pending = firstWorld!;
    firstWorld = null;
    const world = await pending;
    onStage("scene");
    resize();
    load(world);
    await scene.compile();
    if (paused) {
      // The still: the opening panorama mapped, a frame at a time so no step
      // holds the page, then one render with the points frozen in place.
      for (let i = 0; i < 16; i++) {
        applyStep(mission.step(1 / 60));
        await new Promise((r) => setTimeout(r, 0));
      }
      scene.updateRover(mission, 0);
      scene.syncCloud(mission.perception.cloud, performance.now() / 1000);
      scene.updateCamera(mission, 1);
      scene.controls.update();
      showHud();
    }
  } catch (err) {
    teardown();
    throw err;
  }
  scene.render();
  wake();

  /** Leave the still and set off from where it left off. */
  const play = () => {
    if (!paused) return;
    paused = false;
    const g = generation;
    setTimeout(() => {
      if (g !== generation || mission.goal) return;
      mission.setGoal(defaultGoal(mission.terrain.size));
      wake();
    }, PLAY_DELAY_MS);
    wake();
  };

  return { teardown, play };
}
