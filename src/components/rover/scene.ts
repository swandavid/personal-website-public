/**
 * Three.js view of a rover mission. The ground's lighting is baked, so only
 * the rover casts a live shadow; routes, tracks and the point cloud reuse
 * their buffers; nothing renders unless the controller asks for a frame.
 */
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  LinearFilter,
  Line,
  MOUSE,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  Object3D,
  OctahedronGeometry,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RGBAFormat,
  Raycaster,
  Scene,
  ShadowMaterial,
  TOUCH,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SUN, sunlitAt } from "@/lib/rover/bake";
import { UNKNOWN_COST } from "@/lib/rover/costmap";
import type { Mission, Point } from "@/lib/rover/mission";
import type { PointCloud } from "@/lib/rover/perception";
import { heightAt, rng, type Terrain } from "@/lib/rover/terrain";
import { VEHICLE } from "@/lib/rover/vehicle";
import type { World } from "@/lib/rover/world";
import { Drape, annulus, disc, merge, tick } from "./drape";
import {
  COST_MIX,
  groundMaterial,
  groundUniforms,
  heat,
} from "./ground-material";
import { Rocks } from "./rocks";
import { RoverModel } from "./rover-model";
import { Sensors } from "./sensors";

const FOLLOW_DISTANCE = 26;
const MAX_TRACK_POINTS = 4000;
const RADIAL = 6;
/** Physically based lights divide diffuse by π; scale to match the bake. */
const SUN_LIGHT = 3.1 * Math.PI;
const FILL_LIGHT = 0.2 * Math.PI;
const SKY = new Color(0x030405);

export class RoverScene {
  readonly renderer: WebGLRenderer;
  readonly camera = new PerspectiveCamera(32, 1, 0.5, 3000);
  readonly controls: OrbitControls;
  private scene = new Scene();
  private world?: World;
  private terrain!: Terrain;
  private offset = 0;
  private accent: Color;
  private hazard = new Color(0xe07b39);

  private ground?: Mesh<BufferGeometry, MeshBasicMaterial>;
  private skirt?: Mesh<BufferGeometry, MeshBasicMaterial>;
  private knowledge?: DataTexture;
  private uniforms = groundUniforms();
  private rocks = new Rocks();

  private rover: RoverModel;
  private shadowPatch: Mesh<PlaneGeometry, ShadowMaterial>;
  private sun = new DirectionalLight(0xffffff, SUN_LIGHT);
  private fill = new AmbientLight(0xdfe6ff, FILL_LIGHT);

  private path: Mesh<TubeGeometry, MeshBasicMaterial>;
  private pathLength = 0;
  private pathSegments = 0;
  private ghost: Mesh<TubeGeometry, MeshBasicMaterial>;
  private tracks: Mesh<BufferGeometry, MeshBasicMaterial>;
  private trackCount = 0;
  private goal = new Object3D();
  private goalMat = new MeshBasicMaterial({
    toneMapped: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  private goalDrape: Drape;
  /** Preview ring under the pointer: where a click would send the rover. */
  private hoverMat = new MeshBasicMaterial({
    toneMapped: false,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  private hover: Drape;

  private sensors = new Sensors();
  private raycaster = new Raycaster();

  private follow = true;
  private targetDistance = FOLLOW_DISTANCE;
  private fitDistance = 200;
  private snap = false;

  constructor(canvas: HTMLCanvasElement, accent: Color) {
    this.accent = accent;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(SKY, 1);
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    // Error checks force synchronous GPU round trips; only pay for them in dev.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Map-style: drag slides across the ground, right-drag (or a modifier
    // key with drag) orbits, scroll zooms.
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = false;
    this.controls.mouseButtons = {
      LEFT: MOUSE.PAN,
      MIDDLE: MOUSE.DOLLY,
      RIGHT: MOUSE.ROTATE,
    };
    this.controls.minDistance = 8;
    this.controls.minPolarAngle = 0.2;
    this.controls.maxPolarAngle = 1.32;
    // One finger scrolls the page and taps; two fingers orbit and zoom.
    this.controls.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE };
    canvas.style.touchAction = "pan-y";

    // The sun lights the rover and rocks live; only the rover casts, into a
    // small shadow map that travels with it.
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -6;
    cam.right = cam.top = 6;
    cam.near = 1;
    cam.far = 80;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target, this.fill);

    this.rover = new RoverModel(accent);
    this.scene.add(this.rover.group);
    this.shadowPatch = new Mesh(
      new PlaneGeometry(14, 14, 28, 28).rotateX(-Math.PI / 2),
      new ShadowMaterial({
        opacity: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        depthWrite: false,
      }),
    );
    this.shadowPatch.receiveShadow = true;
    (
      this.shadowPatch.geometry.getAttribute("position") as BufferAttribute
    ).setUsage(DynamicDrawUsage);
    this.scene.add(this.shadowPatch);

    this.path = new Mesh(
      new TubeGeometry(),
      new MeshBasicMaterial({ toneMapped: false }),
    );
    this.ghost = new Mesh(
      new TubeGeometry(),
      new MeshBasicMaterial({ toneMapped: false, transparent: true }),
    );
    this.path.visible = this.ghost.visible = false;

    // Wheel ruts: one preallocated buffer, appended to as the rover drives.
    const trackGeo = new BufferGeometry();
    const trackPos = new BufferAttribute(
      new Float32Array(MAX_TRACK_POINTS * 4 * 3),
      3,
    ).setUsage(DynamicDrawUsage);
    trackGeo.setAttribute("position", trackPos);
    const idx = new Uint32Array((MAX_TRACK_POINTS - 1) * 12);
    for (let i = 1, q = 0; i < MAX_TRACK_POINTS; i++) {
      for (const s of [0, 2]) {
        const a = (i - 1) * 4 + s;
        const b = i * 4 + s;
        idx.set([a, b, a + 1, a + 1, b, b + 1], q);
        q += 6;
      }
    }
    trackGeo.setIndex(new BufferAttribute(idx, 1));
    trackGeo.setDrawRange(0, 0);
    this.tracks = new Mesh(
      trackGeo,
      new MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
    );
    this.tracks.frustumCulled = false;
    this.scene.add(this.path, this.ghost, this.tracks);

    const goal = this.buildGoal();
    this.goalDrape = goal;
    const h = merge(annulus(1.28, 1.44, 56), disc(0.17));
    this.hover = new Drape(h, this.hoverMat);
    this.hover.mesh.visible = false;
    this.scene.add(this.hover.mesh);
    this.scene.add(this.rocks.group, this.sensors.group);
    this.buildStars();
    this.setAccent(accent);
  }

  // ---------- coordinates ----------

  /** Grid metres (x, y) and height to scene coordinates. */
  toScene = (x: number, y: number, h: number) =>
    new Vector3(x - this.offset, h, y - this.offset);

  private onGround(x: number, y: number, lift = 0) {
    return this.toScene(x, y, heightAt(this.terrain, x, y) + lift);
  }

  /** Grid point under a screen position, by marching the ray over the heightfield. */
  pick(clientX: number, clientY: number): Point | null {
    if (!this.world) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const n = this.terrain.size - 1;
    const probe = (t: number) => {
      const p = origin.clone().addScaledVector(direction, t);
      const gx = p.x + this.offset;
      const gy = p.z + this.offset;
      if (gx < 0 || gy < 0 || gx > n || gy > n) return null;
      return p.y <= heightAt(this.terrain, gx, gy) ? { x: gx, y: gy } : false;
    };
    let prev = 0;
    for (let t = 0.5; t < 1500; t += 0.5) {
      const hit = probe(t);
      if (!hit) {
        if (hit === false) prev = t;
        continue;
      }
      let lo = prev;
      let hi = t;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        if (probe(mid)) hi = mid;
        else lo = mid;
      }
      return probe(hi) || hit;
    }
    return null;
  }

  // ---------- world ----------

  setWorld(world: World) {
    this.world = world;
    this.terrain = world.terrain;
    this.offset = (this.terrain.size - 1) / 2;
    for (const m of [this.ground, this.skirt]) {
      if (!m) continue;
      m.geometry.dispose();
      m.material.dispose();
      this.scene.remove(m);
    }
    this.knowledge?.dispose();

    const b = world.baked;
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(b.positions, 3));
    geo.setAttribute("gridUv", new BufferAttribute(b.gridUv, 2));
    geo.setAttribute("color", new BufferAttribute(b.albedo, 3));
    geo.setAttribute("light", new BufferAttribute(b.light, 1));
    geo.setIndex(new BufferAttribute(b.index, 1));
    geo.computeBoundingSphere();

    const size = this.terrain.size;
    this.knowledge = new DataTexture(
      new Uint8Array(size * size * 4),
      size,
      size,
      RGBAFormat,
    );
    this.knowledge.magFilter = this.knowledge.minFilter = LinearFilter;
    this.knowledge.needsUpdate = true;
    this.uniforms.uKnown.value = this.knowledge;
    this.uniforms.uCells.value = size;

    this.ground = new Mesh(geo, groundMaterial(this.uniforms));
    this.scene.add(this.ground);
    this.buildSkirt();
    this.rocks.set(world.terrain, b.sunlit, this.onGround.bind(this));
    this.resetTracks();
    this.path.visible = this.ghost.visible = false;
    this.sensors.reset();
  }

  /** Sides of the terrain tile, so it reads as a cut-away block. */
  private buildSkirt() {
    const t = this.terrain;
    const n = t.detailSize;
    let lo = Infinity;
    for (const h of t.detail) lo = Math.min(lo, h);
    const base = lo - 4;
    const edge: [number, number][] = [];
    for (let i = 0; i < n; i += 2) edge.push([i, 0]);
    for (let j = 0; j < n; j += 2) edge.push([n - 1, j]);
    for (let i = n - 1; i >= 0; i -= 2) edge.push([i, n - 1]);
    for (let j = n - 1; j >= 0; j -= 2) edge.push([0, j]);
    const pos: number[] = [];
    const col: number[] = [];
    for (let e = 0; e < edge.length - 1; e++) {
      const [i0, j0] = edge[e]!;
      const [i1, j1] = edge[e + 1]!;
      const a = this.toScene(i0 / 2, j0 / 2, t.detail[j0 * n + i0]!);
      const b = this.toScene(i1 / 2, j1 / 2, t.detail[j1 * n + i1]!);
      // Two triangles down to the base, fading from regolith grey at the top
      // edge to black at the base.
      for (const [v, low] of [
        [a, false],
        [b, true],
        [b, false],
        [a, false],
        [a, true],
        [b, true],
      ] as const) {
        pos.push(v.x, low ? base : v.y, v.z);
        const c = low ? 0 : 0.05;
        col.push(c, c, c);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
    this.skirt = new Mesh(
      geo,
      new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }),
    );
    this.scene.add(this.skirt);
  }

  private buildStars() {
    const random = rng(7);
    const count = 1600;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * r * 900, u * 900, Math.sin(a) * r * 900], i * 3);
      const b = 0.25 + random() ** 3 * 0.75;
      col.set([b, b, b * (0.9 + random() * 0.2)], i * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("color", new BufferAttribute(col, 3));
    const stars = new Points(
      geo,
      new PointsMaterial({
        size: 1.4,
        sizeAttenuation: false,
        vertexColors: true,
        toneMapped: false,
      }),
    );
    stars.frustumCulled = false;
    this.scene.add(stars);
  }

  /** Redraw the rover's map for the given cells (or all of them). */
  updateKnowledge(m: Mission, cells?: number[]) {
    if (!this.knowledge) return;
    const data = this.knowledge.image.data as Uint8Array;
    const write = (i: number) => {
      data[i * 4] = m.seen[i] ? 255 : 0;
      data[i * 4 + 1] = Math.round(heat(m.known[i] ?? UNKNOWN_COST) * 255);
      data[i * 4 + 2] = m.map.hazard[i] ? 255 : 0;
      data[i * 4 + 3] = 255;
    };
    if (cells) cells.forEach(write);
    else for (let i = 0; i < m.known.length; i++) write(i);
    this.knowledge.needsUpdate = true;
  }

  setCostView(on: boolean) {
    this.uniforms.uCostMix.value = on ? COST_MIX : 0;
  }

  // ---------- rover ----------

  updateRover(m: Mission, dt: number) {
    const t = this.terrain;
    this.rover.update(
      t,
      m.pos,
      m.heading,
      dt,
      m.speed,
      this.toScene,
      this.rocks.heightAt,
    );
    const sun = sunlitAt(t, this.world!.baked.sunlit, m.pos.x, m.pos.y);
    this.rover.setShade(sun);

    // Keep the rover's shadow camera and receiver patch on the rover.
    const at = this.rover.group.position;
    this.sun.target.position.copy(at);
    this.sun.position.set(
      at.x + SUN.x * 40,
      at.y + SUN.h * 40,
      at.z + SUN.y * 40,
    );
    this.shadowPatch.material.opacity = 0.72 * sun;
    const patch = this.shadowPatch.geometry.getAttribute(
      "position",
    ) as BufferAttribute;
    const cx = Math.round(m.pos.x * 2) / 2;
    const cy = Math.round(m.pos.y * 2) / 2;
    for (let i = 0; i < patch.count; i++) {
      const gx = cx + (i % 29) * 0.5 - 7;
      const gy = cy + Math.floor(i / 29) * 0.5 - 7;
      const v = this.onGround(gx, gy, 0.02);
      patch.setXYZ(i, v.x, v.y, v.z);
    }
    patch.needsUpdate = true;
    this.shadowPatch.geometry.computeBoundingSphere();

    this.rover.setPan(m.pan);
    if (this.sensors.group.visible)
      this.sensors.updateViews(m, t, this.toScene);
  }

  /** Show or hide the cameras' views and the point cloud. */
  setSensorsVisible(on: boolean) {
    this.sensors.group.visible = on;
  }

  syncCloud(cloud: PointCloud, time: number) {
    this.sensors.syncCloud(cloud, time, this.offset);
  }

  // ---------- routes ----------

  /** Densify to about one point per metre so the tube hugs the ground. */
  private drape(points: Point[], lift: number) {
    const out: Vector3[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let k = 0; k < n; k++)
        out.push(
          this.onGround(
            a.x + ((b.x - a.x) * k) / n,
            a.y + ((b.y - a.y) * k) / n,
            lift,
          ),
        );
    }
    const last = points.at(-1);
    if (last) out.push(this.onGround(last.x, last.y, lift));
    return out;
  }

  private tube(
    mesh: Mesh<TubeGeometry, MeshBasicMaterial>,
    points: Point[],
    radius: number,
  ) {
    mesh.geometry.dispose();
    const pts = this.drape(points, 0.3);
    if (pts.length < 2) {
      mesh.visible = false;
      return { length: 0, segments: 0 };
    }
    const curve = new CatmullRomCurve3(pts, false, "centripetal");
    const segments = Math.min(1500, pts.length * 3);
    mesh.geometry = new TubeGeometry(curve, segments, radius, RADIAL, false);
    mesh.visible = true;
    return { length: curve.getLength(), segments };
  }

  /** New route: built once, then trimmed from the start as the rover drives it. */
  setPath(points: Point[]) {
    const { length, segments } = this.tube(this.path, points, 0.07);
    this.pathLength = length;
    this.pathSegments = segments;
  }

  /** Hide the part of the route already driven (metres along it). */
  trimPath(along: number) {
    if (!this.path.visible || !this.pathLength) return;
    const done = Math.min(
      this.pathSegments,
      Math.floor((along / this.pathLength) * this.pathSegments),
    );
    this.path.geometry.setDrawRange(done * RADIAL * 6, Infinity);
  }

  setGhost(points: Point[]) {
    this.tube(this.ghost, points, 0.07);
    this.ghost.material.opacity = 0.9;
  }

  fadeGhost(dt: number) {
    if (!this.ghost.visible) return false;
    this.ghost.material.opacity -= dt / 1.2;
    if (this.ghost.material.opacity <= 0) this.ghost.visible = false;
    return this.ghost.visible;
  }

  resetTracks() {
    this.trackCount = 0;
    this.tracks.geometry.setDrawRange(0, 0);
  }

  /** Add any new trail points to the wheel ruts, in place. */
  appendTracks(trail: Point[]) {
    const attr = this.tracks.geometry.getAttribute(
      "position",
    ) as BufferAttribute;
    const arr = attr.array as Float32Array;
    const half = 0.15;
    const track = VEHICLE.width / 2 - 0.16;
    const start = this.trackCount;
    const end = Math.min(trail.length, MAX_TRACK_POINTS);
    if (end <= start) return;
    // Re-write the previous point too: its direction changes once a new one exists.
    for (let i = Math.max(0, start - 1); i < end; i++) {
      const p = trail[i]!;
      const a = trail[Math.max(0, i - 1)]!;
      const b = trail[Math.min(end - 1, i + 1)]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      [-track - half, -track + half, track - half, track + half].forEach(
        (o, k) => {
          const v = this.onGround(p.x + nx * o, p.y + ny * o, 0.04);
          arr.set([v.x, v.y, v.z], (i * 4 + k) * 3);
        },
      );
    }
    const from = Math.max(0, start - 1) * 12;
    attr.clearUpdateRanges();
    attr.addUpdateRange(from, end * 12 - from);
    attr.needsUpdate = true;
    this.trackCount = end;
    this.tracks.geometry.setDrawRange(0, Math.max(0, end - 1) * 12);
  }

  /** Goal: a ring and ticks draped on the ground, and a flag pole. */
  private buildGoal() {
    const shape = merge(
      annulus(1.34, 1.46, 64),
      ...[0, 1, 2, 3].map((i) => tick((i * Math.PI) / 2, 1.6, 2.1, 0.05)),
    );
    const drape = new Drape(shape, this.goalMat, 0.06);
    const pole = new Mesh(
      new CylinderGeometry(0.025, 0.025, 2.2, 6),
      this.goalMat,
    );
    pole.position.y = 1.1;
    const tip = new Mesh(new OctahedronGeometry(0.16), this.goalMat);
    tip.position.y = 2.35;
    this.goal.add(pole, tip);
    this.goal.visible = drape.mesh.visible = false;
    this.scene.add(this.goal, drape.mesh);
    return drape;
  }

  /** Show where a click would set the goal; orange over known no-go ground. */
  setHover(p: Point | null, nogo = false) {
    this.hover.mesh.visible = !!p;
    if (!p) return;
    this.hover.place(this.onGround.bind(this), p.x, p.y);
    this.hoverMat.color.copy(nogo ? this.hazard : this.accent);
  }

  setGoal(p: Point | null) {
    this.goal.visible = this.goalDrape.mesh.visible = !!p;
    if (!p) return;
    this.goal.position.copy(this.onGround(p.x, p.y));
    this.goalDrape.place(this.onGround.bind(this), p.x, p.y);
  }

  setAccent(accent: Color) {
    this.accent = accent;
    this.path.material.color.copy(accent);
    this.ghost.material.color.copy(this.hazard);
    this.goalMat.color.copy(accent);
    this.uniforms.uGrid.value.copy(accent);
    this.rover.setAccent(accent);
  }

  // ---------- camera ----------

  /** Follow the rover, or leave the camera wherever the visitor puts it. */
  setFollow(on: boolean) {
    this.follow = on;
    if (on) this.targetDistance = FOLLOW_DISTANCE;
  }

  /** Reduced motion: no orbit damping, and following snaps instead of easing. */
  setReducedMotion(on: boolean) {
    this.controls.enableDamping = !on;
    this.snap = on;
  }

  /** Put the camera behind and above the rover, with the sun to one side. */
  frameRover(m: Mission) {
    const target = this.onGround(m.pos.x, m.pos.y);
    this.controls.target.copy(target);
    const back = new Vector3(
      -Math.cos(m.heading) - 0.5,
      0,
      -Math.sin(m.heading) + 0.2,
    ).normalize();
    this.camera.position
      .copy(target)
      .addScaledVector(back, FOLLOW_DISTANCE * 0.8)
      .add(new Vector3(0, FOLLOW_DISTANCE * 0.6, 0));
    this.targetDistance = FOLLOW_DISTANCE;
  }

  /**
   * Ease the camera toward the rover while following; otherwise just keep
   * the view over the map. Returns true while moving.
   */
  updateCamera(m: Mission, dt: number) {
    const t = this.controls.target;
    const lim = this.offset;
    // Panning can't wander off the map.
    const cx = Math.min(lim, Math.max(-lim, t.x));
    const cz = Math.min(lim, Math.max(-lim, t.z));
    if (cx !== t.x || cz !== t.z) {
      this.camera.position.x += cx - t.x;
      this.camera.position.z += cz - t.z;
      t.x = cx;
      t.z = cz;
    }
    if (!this.follow) return false;
    const k = this.snap ? 1 : 1 - Math.exp(-dt * 3);
    const want = this.onGround(m.pos.x, m.pos.y);
    const delta = want.clone().sub(t).multiplyScalar(k);
    t.add(delta);
    this.camera.position.add(delta);
    const offset = this.camera.position.clone().sub(t);
    const d = offset.length();
    const nd = d + (this.targetDistance - d) * k;
    this.camera.position.copy(t).addScaledVector(offset.normalize(), nd);
    return delta.lengthSq() > 1e-5 || Math.abs(this.targetDistance - d) > 0.05;
  }

  /** Stop pulling the zoom once the visitor zooms by hand. */
  releaseZoom() {
    this.targetDistance = this.camera.position.distanceTo(this.controls.target);
  }

  // ---------- size, quality, render ----------

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.fov = aspect < 1 ? 44 : 32;
    this.camera.updateProjectionMatrix();
    const half = Math.tan((this.camera.fov * Math.PI) / 360);
    this.fitDistance = Math.max(80 / (half * aspect), 58 / half);
    this.controls.maxDistance = this.fitDistance * 1.5;
  }

  setPixelRatio(ratio: number) {
    this.renderer.setPixelRatio(ratio);
    this.sensors.setScale(ratio);
  }

  /**
   * Compile shaders ahead of the first frame, one object at a time with a
   * yield between each, so no single step blocks the page. Uses the parallel
   * compile extension where the browser has it.
   */
  async compile() {
    for (const child of [...this.scene.children]) {
      await this.renderer.compileAsync(child, this.camera, this.scene);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.controls.dispose();
    this.rover.dispose();
    this.knowledge?.dispose();
    this.rocks.dispose();
    this.sun.shadow.dispose();
    this.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Line || o instanceof Points) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mat: Material) => mat.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
