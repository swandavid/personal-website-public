/**
 * One rover drive, with no map up front.
 *
 * The rover starts knowing only the edge of its operating area and assumes
 * unseen ground is probably drivable. Its stereo cameras (a pair on a
 * panning mast, and wide pairs low on the front and back) turn every frame
 * into a cloud of 3D points; the points build an elevation map, and the
 * elevation map is all the cost map is built from. When new knowledge makes
 * the current route worse, it replans.
 *
 * Several layers keep it safe, each independent of the others:
 * - routes are checked against the latest map before they are driven;
 * - the controller refuses any move that puts the body's centre into the
 *   keep-out zone around a hazard, or a wheel onto a hazard it knows about;
 * - an IMU watches the body's tilt;
 * - the body checks its footprint against the real ground before every
 *   move, which catches what the cameras got wrong.
 * If a move is refused, or it stops making progress, it recovers: remember
 * the contact, back up along its own tracks, and replan. After a few failed
 * recoveries in a row it declares itself stuck.
 */
import {
  BLOCKED,
  Costmap,
  KEEP_OUT,
  contactRadius,
  fence,
  isHazard,
  nearestPassable,
  rockCells,
  traversalCost,
  UNKNOWN_COST,
} from "./costmap";
import { clamp, dist, pointAhead, wheels, wrap, type Point } from "./geometry";
import { Perception, attitude } from "./perception";
import { smoothPath } from "./planner";
import { isObstacle, rng, type Rock, type Terrain } from "./terrain";
import { CAMERAS, VEHICLE } from "./vehicle";

export type { Point };

export type MissionState =
  "idle" | "planning" | "driving" | "backing" | "arrived" | "stuck";

export interface StepResult {
  /** Cells whose known cost changed, for redrawing the map. */
  sensed: number[];
  /** A route that was just abandoned, for showing what changed. */
  abandoned: Point[] | null;
  /** The body refused a move. */
  bumped: boolean;
}

export interface PlanRequest {
  /** Hand back to `acceptPlan` with the result. */
  id: number;
  start: number;
  goal: number;
  /** The cost map to search, a copy of what the rover knows. */
  cost: Float32Array;
}

const LOOKAHEAD = 3.2;
const ARRIVE = 0.8;
/** Seconds between stereo frames. */
const FRAME_DT = 0.1;
/** Refresh the plan this often (metres) to use what's been learned. */
const REFRESH_EVERY = 12;
/** Don't re-search for mere cost changes more often than this (seconds). */
const SOFT_REPLAN_S = 1;
const MAX_ATTEMPTS = 4;
const BACKUP_DISTANCE = 3.5;
const WATCHDOG_S = 4;
/** IMU tilt at which the rover stops and backs off. */
const TILT_LIMIT = VEHICLE.tipSlope - (1.5 * Math.PI) / 180;
const PAN_RATE = 2.2;
const PAN_LIMIT = 2.9;
/** How far the rover may pick its way out of a keep-out zone it finds itself in. */
const ESCAPE_RADIUS = 3;
/**
 * Planning costs for escape cells: no-go ground under the body is dearest,
 * and keep-out cells cost more the deeper into the zone they are.
 */
const ESCAPE_COST = { hazard: 60, keepOut: 12, perMetreIn: 30 };
/** A hazard found on the route closer than this (metres) stops the rover while it replans. */
const STOP_AHEAD = 6;
/** Metres driven carefully after a refused move. */
const CAREFUL_DISTANCE = 8;
/** Metres of driving after a recovery that clear the count of failed attempts. */
const ATTEMPTS_FORGIVEN = 12;
/** A cell on the route that rises past this cost is worth a fresh search. */
const COSTLY = UNKNOWN_COST + 1.5;
/** Heading error (radians) past which the rover turns on the spot; speed halves at it. */
const TURN_IN_PLACE = 0.7;
/** Share of speed shed on ground at the slope limit. */
const SLOPE_SLOWDOWN = 0.55;
/** IMU attitude noise, radians peak to peak. */
const IMU_NOISE = 0.004;
/** How far along the route the mast looks while driving, metres. */
const MAST_LOOK = 9;
/** Furthest off the nose the mast turns toward the route, radians. */
const MAST_LEAD = 1.3;
/** Mast sweeps (amplitude in radians, rate in rad/s) that widen what each frame covers. */
const SWEEP = {
  driving: [0.55, 1.7],
  backing: [0.5, 1.4],
  waiting: [2.4, 0.8],
} as const;

const NAV = CAMERAS.findIndex((c) => c.id === "navcam");
const HAZ_FRONT = CAMERAS.findIndex((c) => c.id === "hazFront");
const HAZ_REAR = CAMERAS.findIndex((c) => c.id === "hazRear");

export class Mission {
  /** What the rover believes, built from its own sensing. */
  readonly map: Costmap;
  readonly known: Float32Array;
  /** Cells the rover has enough stereo points for. */
  readonly seen: Uint8Array;
  readonly perception: Perception;
  /** Hazards learned by contact rather than sight. */
  private learned: Uint8Array;
  private obstacles: Rock[];

  pos: Point;
  heading = -Math.PI / 4;
  /** Signed ground speed, m/s (negative when reversing). */
  speed = 0;
  /** Mast pan relative to the body, radians. */
  pan = 0;
  /** Latest IMU reading, radians. */
  imu = { roll: 0, pitch: 0 };
  /** Stereo frames taken, by camera index. */
  frames = CAMERAS.map(() => 0);
  state: MissionState = "idle";
  reason = "";
  goal: Point | null = null;
  path: Point[] = [];
  pathVersion = 0;
  trail: Point[] = [];
  driven = 0;
  replans = 0;
  recoveries = 0;

  private progress = 0;
  private needsPlan = false;
  private planId = 0;
  /** The plan request still wanted, or 0 for none. */
  private awaiting = 0;
  private attempts = 0;
  private frameClock = 0;
  private frameCount = 0;
  private sinceRefresh = 0;
  private sinceRecovery = 0;
  private lastSoftPlan = -Infinity;
  /**
   * Seconds spent trying to drive without getting anywhere, across replans:
   * a new plan doesn't reset it, only real progress does.
   */
  private stalled = 0;
  private gained = 0;
  private clock = 0;
  private watch = { pos: { x: 0, y: 0 }, t: 0 };
  private backPath: Point[] = [];
  /** Where the rover last refused to step into no-go ground. */
  private lastHold: Point | null = null;
  /**
   * Metres left to drive carefully: after a refused move the rover follows
   * the grid route itself, with a short look-ahead, instead of cutting
   * corners.
   */
  private careful = 0;
  /** Keep-out cells the current route may use to get clear of a hazard. */
  private escape = new Set<number>();
  /** Mast angles still to shoot for the opening panorama. */
  private panorama: number[] = [];
  private imuNoise: () => number;

  constructor(readonly terrain: Terrain) {
    const n = terrain.size;
    this.map = new Costmap(n);
    fence(this.map);
    this.map.flush();
    this.known = this.map.cost;
    this.seen = new Uint8Array(n * n);
    this.learned = new Uint8Array(n * n);
    this.obstacles = terrain.rocks.filter(isObstacle);
    this.perception = new Perception(terrain);
    this.pos = { ...terrain.start };
    this.trail.push({ ...this.pos });
    const random = rng(terrain.seed + 1);
    this.imuNoise = () => (random() - 0.5) * IMU_NOISE;
    // A panorama before it moves, as a lander-deployed rover would take:
    // the forward frame now, the rest one per step so construction stays
    // cheap.
    this.capture(NAV);
    for (let k = 1; k < 8; k++) this.panorama.push(wrap((k / 8) * Math.PI * 2));
    this.capture(HAZ_FRONT);
    this.capture(HAZ_REAR);
    this.integrate();
    this.readImu();
  }

  cellOf(p: Point) {
    const s = this.terrain.size;
    return (
      clamp(Math.round(p.y), 0, s - 1) * s + clamp(Math.round(p.x), 0, s - 1)
    );
  }

  /** Stereo points produced so far. */
  points() {
    return this.perception.cloud.total;
  }

  // ---------- sensing ----------

  private capture(cam: number, pan = this.pan) {
    this.perception.capture(cam, {
      x: this.pos.x,
      y: this.pos.y,
      heading: this.heading,
      pan,
    });
    this.frames[cam]!++;
  }

  /**
   * Fold new points into the map. Returns cells whose view changed, and
   * those whose cost rose.
   */
  private integrate() {
    const redraw: number[] = [];
    this.perception.update((i, e) => {
      if (e.seen && !this.seen[i]) {
        this.seen[i] = 1;
        redraw.push(i);
      }
      if (this.learned[i]) return;
      if (!e.seen) return;
      const hazard = isHazard(e.slope, e.rough);
      this.map.setHazard(i, hazard);
      if (!hazard) this.map.setBase(i, traversalCost(e.slope, e.rough));
    });
    return this.flush(redraw);
  }

  private flush(extra: number[] = []) {
    const { changed, raised } = this.map.flush();
    return {
      redraw: extra.length ? [...new Set([...changed, ...extra])] : changed,
      raised,
    };
  }

  /** Take whichever frames are due. With `all`, every camera fires now. */
  sense(all = false) {
    if (all) {
      CAMERAS.forEach((_, i) => this.capture(i));
    } else {
      this.frameCount++;
      this.capture(NAV);
      // The hazard cameras facing the direction of travel run every frame;
      // the other pair every third.
      const lead = this.state === "backing" ? HAZ_REAR : HAZ_FRONT;
      this.capture(lead);
      if (this.frameCount % 3 === 0)
        this.capture(lead === HAZ_REAR ? HAZ_FRONT : HAZ_REAR);
    }
    return this.integrate();
  }

  /** Point the mast: along the route while driving, sweeping while it waits. */
  private aimMast(dt: number) {
    const sweep = ([amp, rate]: readonly [number, number]) =>
      amp * Math.sin(this.clock * rate);
    let want: number;
    if (this.state === "driving" && this.path.length) {
      const ahead = this.lookahead(MAST_LOOK, false);
      const bearing = wrap(
        Math.atan2(ahead.y - this.pos.y, ahead.x - this.pos.x) - this.heading,
      );
      want = clamp(bearing, -MAST_LEAD, MAST_LEAD) + sweep(SWEEP.driving);
    } else if (this.state === "backing") {
      want = Math.PI - sweep(SWEEP.backing);
    } else {
      want = sweep(SWEEP.waiting);
    }
    want = clamp(wrap(want), -PAN_LIMIT, PAN_LIMIT);
    this.pan += clamp(want - this.pan, -PAN_RATE * dt, PAN_RATE * dt);
  }

  private readImu() {
    const a = attitude(
      this.terrain,
      this.perception.rocks,
      this.pos.x,
      this.pos.y,
      this.heading,
    );
    this.imu.roll = a.roll + this.imuNoise();
    this.imu.pitch = a.pitch + this.imuNoise();
  }

  /**
   * How cells whose cost rose affect the route ahead: "blocked" if it now
   * crosses a hazard (with how far ahead), "worse" if it got costly.
   */
  private routeImpact(raised: number[]): {
    kind: "none" | "worse" | "blocked";
    ahead: number;
  } {
    const hit = new Set(raised);
    const pts = this.remaining();
    let kind: "none" | "worse" | "blocked" = "none";
    let travelled = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = dist(a, b);
      const n = Math.max(1, Math.ceil(len / 0.5));
      for (let k = 0; k <= n; k++) {
        const c = this.cellOf({
          x: a.x + ((b.x - a.x) * k) / n,
          y: a.y + ((b.y - a.y) * k) / n,
        });
        if (!hit.has(c)) continue;
        if (this.known[c] === BLOCKED && !this.escape.has(c))
          return { kind: "blocked", ahead: travelled + (len * k) / n };
        if (this.known[c]! > COSTLY) kind = "worse";
      }
      travelled += len;
    }
    return { kind, ahead: Infinity };
  }

  private passable(c: number) {
    return this.known[c] !== BLOCKED || this.escape.has(c);
  }

  /** True if a straight line crosses no known no-go cell (the start cell excepted). */
  private segmentClear(a: Point, b: Point) {
    const n = Math.max(1, Math.ceil(dist(a, b) / 0.25));
    const from = this.cellOf(a);
    for (let k = 1; k <= n; k++) {
      const c = this.cellOf({
        x: a.x + ((b.x - a.x) * k) / n,
        y: a.y + ((b.y - a.y) * k) / n,
      });
      if (c !== from && !this.passable(c)) return false;
    }
    return true;
  }

  private routeClear(path: Point[]) {
    for (let i = 1; i < path.length; i++)
      if (!this.segmentClear(path[i - 1]!, path[i]!)) return false;
    return true;
  }

  /** React to costs rising: reroute around hazards, quietly refine otherwise. */
  private react(raised: number[], out: StepResult) {
    if (!raised.length || this.state !== "driving") return;
    const impact = this.routeImpact(raised);
    if (impact.kind === "blocked") {
      out.abandoned = this.remaining();
      this.replans++;
      // Stop if the hazard is close; otherwise keep rolling while it replans.
      this.requestPlan(impact.ahead < STOP_AHEAD);
    } else if (
      impact.kind === "worse" &&
      this.clock - this.lastSoftPlan > SOFT_REPLAN_S
    ) {
      this.lastSoftPlan = this.clock;
      this.requestPlan(false);
    }
  }

  // ---------- goals and plans ----------

  setGoal(p: Point) {
    this.awaiting = 0;
    this.stalled = this.gained = 0;
    const s = this.terrain.size;
    this.goal = {
      x: clamp(Math.round(p.x), 2, s - 3),
      y: clamp(Math.round(p.y), 2, s - 3),
    };
    this.attempts = 0;
    this.reason = "";
    this.requestPlan();
  }

  /** Ask for a new route. With `stop`, the rover waits for it in place. */
  private requestPlan(stop = true) {
    this.needsPlan = true;
    if (stop || this.state !== "driving") {
      this.state = "planning";
      this.speed = 0;
    }
  }

  /**
   * If the rover is standing somewhere the planner would refuse to start
   * from (in a keep-out ring, or on a hazard the map found under it), the
   * cells it may cross to get clear: keep-out cells connected to it, and
   * no-go cells only where they are already under its body. The costs
   * steer it out the way that gets clear fastest.
   */
  private escapeCells(cost: Float32Array) {
    this.escape.clear();
    const start = this.cellOf(this.pos);
    if (this.known[start] !== BLOCKED) return;
    const s = this.terrain.size;
    // No-go cells may be crossed only if the rover is really standing on
    // no-go ground, and then only those under its own footprint.
    const onHazard =
      !!this.map.hazard[start] ||
      this.wheelsOnHazard(this.pos, this.heading) > 0;
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    const underBody = (x: number, y: number) => {
      const dx = x - this.pos.x;
      const dy = y - this.pos.y;
      return (
        Math.abs(dx * cos + dy * sin) <= VEHICLE.length / 2 + 0.3 &&
        Math.abs(-dx * sin + dy * cos) <= VEHICLE.width / 2 + 0.3
      );
    };
    const allowed = (j: number, x: number, y: number) => {
      if (Math.hypot(x - this.pos.x, y - this.pos.y) > ESCAPE_RADIUS)
        return false;
      return !this.map.hazard[j] || (onHazard && underBody(x, y));
    };
    const stack = [start];
    this.escape.add(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % s;
      const y = (i - x) / s;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= s || yy >= s) continue;
          const j = yy * s + xx;
          if (this.escape.has(j) || this.known[j] !== BLOCKED) continue;
          if (!allowed(j, xx, yy)) continue;
          this.escape.add(j);
          stack.push(j);
        }
    }
    for (const i of this.escape)
      cost[i] = this.map.hazard[i]
        ? ESCAPE_COST.hazard
        : ESCAPE_COST.keepOut +
          ESCAPE_COST.perMetreIn * (KEEP_OUT - this.map.clearance[i]!);
  }

  /** The next search the caller should run, if one is due. */
  takePlanRequest(): PlanRequest | null {
    if (!this.needsPlan || !this.goal) return null;
    this.needsPlan = false;
    this.awaiting = ++this.planId;
    if (this.known[this.cellOf(this.goal)] === BLOCKED) {
      const moved = nearestPassable(this.known, this.terrain.size, this.goal);
      if (moved) this.goal = moved;
    }
    const cost = this.known.slice();
    this.escapeCells(cost);
    return {
      id: this.awaiting,
      start: this.cellOf(this.pos),
      goal: this.cellOf(this.goal),
      cost,
    };
  }

  /**
   * Adopt the result of request `id`, unless it has been superseded by a
   * newer request, a new goal or a recovery.
   */
  acceptPlan(id: number, cells: number[] | null) {
    if (
      id !== this.awaiting ||
      (this.state !== "planning" && this.state !== "driving")
    )
      return;
    this.awaiting = 0;
    if (this.needsPlan) return; // superseded by a newer request
    if (!cells || cells.length < 2) {
      if (cells && dist(this.pos, this.goal!) < ARRIVE * 2)
        return this.finish("arrived", "");
      // If the rover is wedged in a hazard zone, backing out may open a way.
      if (
        this.known[this.cellOf(this.pos)] === BLOCKED &&
        this.attempts < MAX_ATTEMPTS
      )
        return this.recover("Too close to a hazard");
      return this.finish("stuck", "No way through");
    }
    // Last line of defence: never adopt a route that crosses known no-go
    // ground. A plan worked out before the latest hazards appeared is thrown
    // away here. A straightened corner that clips a hazard falls back to the
    // raw grid route; if even that is blocked, search again.
    const size = this.terrain.size;
    const raw = cells.map((c) => ({ x: c % size, y: Math.floor(c / size) }));
    let path =
      this.escape.size || this.careful > 0
        ? raw
        : smoothPath(this.known, size, cells);
    if (!this.routeClear(path)) {
      path = raw;
      if (!this.routeClear(path)) {
        this.requestPlan();
        return;
      }
    }
    this.path = path;
    this.progress = 0;
    this.pathVersion++;
    this.sinceRefresh = 0;
    this.state = "driving";
    this.resetWatch();
  }

  // ---------- motion ----------

  /** Shoot any panorama frames still owed. Returns cells whose view changed. */
  finishPanorama(): number[] {
    while (this.panorama.length) this.capture(NAV, this.panorama.shift());
    return this.integrate().redraw;
  }

  step(dt: number): StepResult {
    const out: StepResult = { sensed: [], abandoned: null, bumped: false };
    const pan = this.panorama.shift();
    if (pan !== undefined) {
      this.capture(NAV, pan);
      out.sensed.push(...this.integrate().redraw);
    }
    const active =
      this.state === "driving" ||
      this.state === "backing" ||
      this.state === "planning";
    if (!active) {
      this.speed = 0;
      return out;
    }
    this.clock += dt;
    this.speed = 0;
    if (this.state === "driving") this.drive(dt, out);
    else if (this.state === "backing") this.back(dt, out);
    this.aimMast(dt);
    this.readImu();

    this.frameClock += dt;
    if (this.frameClock >= FRAME_DT) {
      this.frameClock -= FRAME_DT;
      const { redraw, raised } = this.sense();
      out.sensed.push(...redraw);
      this.react(raised, out);
    }
    if (this.state === "driving" && this.sinceRefresh > REFRESH_EVERY) {
      this.sinceRefresh = 0;
      this.requestPlan(false);
    }
    return out;
  }

  /** Pursuit target, pulled closer if the straight chord to it would clip no-go ground. */
  private target(): Point {
    const steps = this.careful > 0 ? [1.2, 0.6] : [LOOKAHEAD, 2, 1.2, 0.6];
    for (const l of steps) {
      const t = this.lookahead(l);
      if (this.segmentClear(this.pos, t)) return t;
    }
    return this.lookahead(0.6);
  }

  private lookahead(distance = LOOKAHEAD, advance = true): Point {
    const { point, seg } = pointAhead(
      this.path,
      this.progress,
      this.pos,
      distance,
    );
    if (advance) this.progress = seg;
    return point;
  }

  /** How many wheels would sit on ground the rover knows is a hazard. */
  private wheelsOnHazard(p: Point, heading: number) {
    let n = 0;
    for (const w of wheels(p, heading))
      if (this.map.hazard[this.cellOf(w)]) n++;
    return n;
  }

  /** Stop and replan rather than move; a second hold in the same place backs up. */
  private hold(out: StepResult) {
    out.abandoned = this.remaining();
    if (this.lastHold && dist(this.lastHold, this.pos) < 0.3) {
      this.lastHold = null;
      return this.recover("Blocked, backing up");
    }
    this.lastHold = { ...this.pos };
    this.careful = CAREFUL_DISTANCE;
    this.replans++;
    this.requestPlan();
  }

  private drive(dt: number, out: StepResult) {
    this.stalled += dt;
    if (this.stalled > WATCHDOG_S * 2) {
      this.stalled = this.gained = 0;
      return this.recover("Not making progress");
    }
    const end = this.path.at(-1)!;
    if (dist(this.pos, end) < ARRIVE) {
      this.path = [];
      this.pathVersion++;
      return this.finish("arrived", "");
    }
    const target = this.target();
    const err = wrap(
      Math.atan2(target.y - this.pos.y, target.x - this.pos.x) - this.heading,
    );
    const heading =
      this.heading + clamp(err, -VEHICLE.turnRate * dt, VEHICLE.turnRate * dt);
    // Slow down on slopes (as the IMU feels them) and while still turning.
    const tilt = Math.min(
      1,
      Math.hypot(this.imu.roll, this.imu.pitch) / VEHICLE.maxSlope,
    );
    const v =
      Math.abs(err) < TURN_IN_PLACE
        ? VEHICLE.speed *
          (1 - SLOPE_SLOWDOWN * tilt) *
          (1 - Math.abs(err) / (2 * TURN_IN_PLACE))
        : 0;
    const next = {
      x: this.pos.x + Math.cos(heading) * v * dt,
      y: this.pos.y + Math.sin(heading) * v * dt,
    };

    // Never move the centre from open ground into a keep-out zone, or put a
    // wheel onto a hazard, that the rover already knows about.
    const here = this.cellOf(this.pos);
    const there = this.cellOf(next);
    if (there !== here && !this.passable(there) && this.passable(here))
      return this.hold(out);
    const onHazard = this.wheelsOnHazard(this.pos, this.heading);
    if (this.wheelsOnHazard(next, heading) > onHazard) {
      // Line up on the spot first if that alone keeps the wheels clear.
      if (v > 0 && this.wheelsOnHazard(this.pos, heading) <= onHazard) {
        this.move(this.pos, heading, 0, dt);
        return;
      }
      return this.hold(out);
    }

    const contact = this.contact(next, heading);
    if (contact) {
      out.bumped = true;
      out.abandoned = this.remaining();
      out.sensed.push(...this.learnContact(contact, next));
      return this.recover(
        contact === "slope" ? "Too steep, backing up" : "Blocked, backing up",
      );
    }
    this.move(next, heading, v, dt);
    this.gained += v * dt;
    if (this.gained > 0.5) this.stalled = this.gained = 0;

    if (
      Math.max(Math.abs(this.imu.roll), Math.abs(this.imu.pitch)) > TILT_LIMIT
    ) {
      out.abandoned = this.remaining();
      out.sensed.push(
        ...this.learnContact("slope", this.lookahead(1.5, false)),
      );
      return this.recover("Tilt limit, backing up");
    }

    if (this.clock - this.watch.t > WATCHDOG_S) {
      if (dist(this.pos, this.watch.pos) < 1)
        return this.recover("Not making progress");
      this.resetWatch();
    }
  }

  private back(dt: number, out: StepResult) {
    const target = this.backPath[0];
    if (!target) {
      this.sinceRecovery = 0;
      return this.requestPlan();
    }
    if (dist(this.pos, target) < 0.4) {
      this.backPath.shift();
      return;
    }
    // Reverse: point the rear at the target.
    const err = wrap(
      Math.atan2(target.y - this.pos.y, target.x - this.pos.x) +
        Math.PI -
        this.heading,
    );
    const heading =
      this.heading +
      clamp(err, -VEHICLE.turnRate * 0.6 * dt, VEHICLE.turnRate * 0.6 * dt);
    const v = Math.abs(err) < 0.5 ? -VEHICLE.reverseSpeed : 0;
    const next = {
      x: this.pos.x + Math.cos(heading) * v * dt,
      y: this.pos.y + Math.sin(heading) * v * dt,
    };
    if (this.contact(next, heading)) {
      out.bumped = true;
      return this.finish("stuck", "Can't back out");
    }
    this.move(next, heading, v, dt);
    if (this.clock - this.watch.t > WATCHDOG_S) {
      if (dist(this.pos, this.watch.pos) < 0.5)
        return this.finish("stuck", "Can't back out");
      this.resetWatch();
    }
  }

  private move(next: Point, heading: number, v: number, dt: number) {
    this.pos = next;
    this.heading = wrap(heading);
    this.speed = v;
    const moved = Math.abs(v) * dt;
    this.driven += moved;
    this.sinceRefresh += moved;
    this.sinceRecovery += moved;
    this.careful = Math.max(0, this.careful - moved);
    if (this.sinceRecovery > ATTEMPTS_FORGIVEN) this.attempts = 0;
    if (dist(this.trail.at(-1)!, this.pos) > 0.6)
      this.trail.push({ ...this.pos });
  }

  /**
   * Footprint check for a pose against the real ground: a rock it can't
   * climb under the body, or ground steep enough to tip it.
   */
  private contact(p: Point, heading: number): Rock | "slope" | null {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const hl = VEHICLE.length / 2;
    const hw = VEHICLE.width / 2;
    for (const r of this.obstacles) {
      const dx = r.x - p.x;
      const dy = r.y - p.y;
      if (dx * dx + dy * dy > (r.r + 2.2) ** 2) continue;
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      if (
        Math.hypot(lx - clamp(lx, -hl, hl), ly - clamp(ly, -hw, hw)) <
        contactRadius(r)
      )
        return r;
    }
    if (this.terrain.slope[this.cellOf(p)]! > VEHICLE.tipSlope) return "slope";
    return null;
  }

  /** Remember a contact as a hazard the cameras missed. */
  private learnContact(contact: Rock | "slope", at: Point) {
    const size = this.terrain.size;
    const cells: number[] = [];
    if (contact === "slope") {
      const r = 1;
      for (let y = Math.floor(at.y - r); y <= Math.ceil(at.y + r); y++)
        for (let x = Math.floor(at.x - r); x <= Math.ceil(at.x + r); x++)
          if (
            x >= 0 &&
            y >= 0 &&
            x < size &&
            y < size &&
            Math.hypot(x - at.x, y - at.y) <= r
          )
            cells.push(y * size + x);
    } else {
      rockCells({ ...contact, r: contact.r + 0.5 }, size, (i) => cells.push(i));
    }
    const here = this.cellOf(this.pos);
    const redraw: number[] = [];
    for (const i of cells) {
      // Never mark the cell the rover is standing on.
      if (i === here) continue;
      this.learned[i] = 1;
      this.map.setHazard(i, true);
      if (!this.seen[i]) {
        this.seen[i] = 1;
        redraw.push(i);
      }
    }
    return this.flush(redraw).redraw;
  }

  private recover(reason: string) {
    this.attempts++;
    if (this.attempts > MAX_ATTEMPTS) return this.finish("stuck", "Boxed in");
    this.recoveries++;
    this.reason = reason;
    // Retrace the tracks: the way it came in is known to be clear.
    const back: Point[] = [];
    let d = 0;
    let prev = this.pos;
    for (let i = this.trail.length - 1; i >= 0 && d < BACKUP_DISTANCE; i--) {
      const q = this.trail[i]!;
      d += dist(prev, q);
      if (dist(q, this.pos) > 0.3) back.push(q);
      prev = q;
    }
    if (d < 1) {
      back.length = 0;
      back.push({
        x: this.pos.x - Math.cos(this.heading) * BACKUP_DISTANCE,
        y: this.pos.y - Math.sin(this.heading) * BACKUP_DISTANCE,
      });
    }
    this.backPath = back;
    this.needsPlan = false;
    this.awaiting = 0;
    this.path = [];
    this.pathVersion++;
    this.state = "backing";
    this.resetWatch();
  }

  private finish(state: "arrived" | "stuck", reason: string) {
    this.state = state;
    this.reason = reason;
    this.speed = 0;
    if (state === "stuck") {
      this.path = [];
      this.pathVersion++;
    }
  }

  private resetWatch() {
    this.watch = { pos: { ...this.pos }, t: this.clock };
  }

  /**
   * Add a rock the rover hasn't seen (tests). Every camera takes a frame
   * straight away, so it is known if any of them can see it.
   */
  addRock(rock: Rock): StepResult {
    this.terrain.rocks.push(rock);
    if (isObstacle(rock)) this.obstacles.push(rock);
    this.perception.addRock(rock);
    const { redraw, raised } = this.sense(true);
    const out: StepResult = { sensed: redraw, abandoned: null, bumped: false };
    this.react(raised, out);
    return out;
  }

  /** Route still ahead, starting at the rover. */
  remaining(): Point[] {
    return [this.pos, ...this.path.slice(this.progress + 1)];
  }
}
