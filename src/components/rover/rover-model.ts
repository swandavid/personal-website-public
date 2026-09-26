/**
 * Procedural four-wheel lunar rover: a white thermal-painted chassis with a
 * radiator deck, vertical side solar arrays for low polar sun, a camera mast
 * with a stereo head and floodlights, a high-gain dish, and open mesh wheels
 * on independent arms. Each wheel finds the ground (and any rock) under it,
 * the chassis pitches and rolls to match, and the arms are redrawn between
 * body and hubs. Dimensions come from VEHICLE; the design is generic.
 */
import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Object3D,
  RepeatWrapping,
  Vector2,
  Vector3,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { heightAt, type Terrain } from "@/lib/rover/terrain";
import { VEHICLE } from "@/lib/rover/vehicle";
import { canvasTexture } from "./canvas-texture";

const {
  wheelRadius: R,
  wheelWidth: WHEEL_W,
  wheelBase: AXLE,
  wheelTrack: TRACK,
  rideHeight: RIDE,
} = VEHICLE;
const X = new Vector3(1, 0, 0);

/** Woven wire tyre with chevron treads, like the open mesh wheels used on the Moon. */
const meshTyre = () => {
  const tex = canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = "#3a3d40";
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = "#a9adb2";
    ctx.lineWidth = 1.5;
    for (let i = -64; i < 256 + 64; i += 8) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 64, 64);
      ctx.moveTo(i + 64, 0);
      ctx.lineTo(i, 64);
      ctx.stroke();
    }
    ctx.fillStyle = "#c9ccd0";
    for (let i = 0; i < 256; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i + 4, 8);
      ctx.lineTo(i + 14, 32);
      ctx.lineTo(i + 4, 56);
      ctx.lineTo(i + 9, 56);
      ctx.lineTo(i + 19, 32);
      ctx.lineTo(i + 9, 8);
      ctx.fill();
    }
  });
  tex.wrapS = RepeatWrapping;
  tex.repeat.set(2, 1);
  return tex;
};

const solarCells = () =>
  canvasTexture(256, 128, (ctx) => {
    ctx.fillStyle = "#101a2e";
    ctx.fillRect(0, 0, 256, 128);
    for (let y = 0; y < 128; y += 16) {
      for (let x = 0; x < 256; x += 16) {
        const g = ctx.createLinearGradient(x, y, x + 16, y + 16);
        g.addColorStop(0, "#1c2c4d");
        g.addColorStop(1, "#0e1729");
        ctx.fillStyle = g;
        ctx.fillRect(x + 1, y + 1, 14, 14);
      }
    }
  });

const radiatorFins = () =>
  canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = "#e9eaea";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "#c9cccd";
    for (let x = 0; x < 128; x += 6) ctx.fillRect(x, 0, 1.5, 128);
  });

export class RoverModel {
  readonly group = new Group();
  /** Chassis frame: x forward, y up, z to the left. */
  readonly body = new Group();
  /** Wheel groups: front-left, front-right, rear-left, rear-right. */
  readonly wheels: Group[] = [];
  private tyres: Mesh[] = [];
  private arms: Mesh[] = [];
  /** Pan head on the mast carrying the navigation stereo pair. */
  readonly head = new Group();
  private base = new Map<MeshPhongMaterial, Color>();
  private lamp = new MeshBasicMaterial({ color: 0xfff4e0, toneMapped: false });
  private status = new MeshBasicMaterial({ toneMapped: false });
  private textures: Texture[] = [];
  private scratch = new Vector3();

  constructor(accent: Color) {
    const tyreTex = meshTyre();
    const solarTex = solarCells();
    const finTex = radiatorFins();
    this.textures.push(tyreTex, solarTex, finTex);

    // Phong rather than PBR: a fraction of the shader cost, and with no
    // environment to reflect, PBR metals would look no better here.
    const std = (
      color: number,
      roughness: number,
      metalness: number,
      map?: Texture,
    ) => {
      const m = new MeshPhongMaterial({
        color,
        map: map ?? null,
        shininess: 8 + (1 - roughness) * 90,
        specular: new Color().setScalar(0.04 + metalness * 0.35),
      });
      this.base.set(m, m.color.clone());
      return m;
    };
    const paint = std(0xeeeeec, 0.55, 0.05);
    const radiator = std(0xffffff, 0.5, 0.05, finTex);
    const graphite = std(0x2c2f33, 0.6, 0.35);
    const alloy = std(0xb9bec4, 0.35, 0.75);
    const foil = std(0xd4a646, 0.3, 0.9);
    const solar = std(0xffffff, 0.22, 0.6, solarTex);
    const tyre = std(0xffffff, 0.45, 0.6, tyreTex);
    tyre.side = DoubleSide;
    const glass = std(0x0b0d10, 0.08, 0.2);
    this.setAccent(accent);

    const add = (mesh: Mesh, parent: Object3D = this.body) => {
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Chassis, radiator deck and foil-wrapped avionics.
    add(new Mesh(new RoundedBoxGeometry(2.0, 0.46, 1.24, 3, 0.07), paint));
    const deck = add(
      new Mesh(new RoundedBoxGeometry(1.7, 0.05, 1.0, 2, 0.02), radiator),
    );
    deck.position.y = 0.25;
    const avionics = add(
      new Mesh(new RoundedBoxGeometry(0.62, 0.18, 0.86, 2, 0.03), foil),
    );
    avionics.position.set(0.55, -0.3, 0);
    // Hazard camera pairs, low on the front and back.
    for (const x of [-0.99, 1.0]) {
      const cams = add(new Mesh(new BoxGeometry(0.06, 0.08, 0.5), graphite));
      cams.position.set(x, -0.08, 0);
      for (const z of [-0.15, 0.15]) {
        const lens = add(
          new Mesh(new CylinderGeometry(0.028, 0.028, 0.03, 14), glass),
        );
        lens.rotation.z = Math.PI / 2;
        lens.position.set(x + Math.sign(x) * 0.035, -0.08, z);
      }
    }
    const light = add(new Mesh(new BoxGeometry(0.02, 0.035, 0.3), this.status));
    light.position.set(1.005, 0.1, 0);

    // Vertical solar arrays on both flanks: low sun comes in from the side.
    for (const side of [-1, 1]) {
      const frame = add(new Mesh(new BoxGeometry(1.78, 0.76, 0.03), alloy));
      frame.position.set(-0.05, 0.27, side * 0.66);
      const panel = add(new Mesh(new BoxGeometry(1.7, 0.68, 0.01), solar));
      panel.position.set(-0.05, 0.27, side * 0.68);
    }

    // Mast with a stereo camera bar and floodlights.
    const mast = add(
      new Mesh(new CylinderGeometry(0.045, 0.055, 1.25, 12), alloy),
    );
    mast.position.set(0.72, 0.85, 0);
    this.head.position.set(0.72, 1.5, 0);
    this.body.add(this.head);
    add(
      new Mesh(new RoundedBoxGeometry(0.2, 0.16, 0.7, 2, 0.04), paint),
      this.head,
    );
    for (const z of [-0.26, 0.26]) {
      const lens = add(
        new Mesh(new CylinderGeometry(0.05, 0.05, 0.04, 20), glass),
        this.head,
      );
      lens.rotation.z = Math.PI / 2;
      lens.position.set(0.11, 0.01, z);
    }
    for (const z of [-0.1, 0.1]) {
      const flood = add(
        new Mesh(new BoxGeometry(0.02, 0.05, 0.1), this.lamp),
        this.head,
      );
      flood.position.set(0.105, -0.02, z);
    }

    // High-gain dish on a short boom at the back.
    const boom = add(new Mesh(new CylinderGeometry(0.03, 0.03, 0.5, 8), alloy));
    boom.position.set(-0.75, 0.5, -0.3);
    const dishProfile = Array.from({ length: 10 }, (_, i) => {
      const r = (i / 9) * 0.26;
      return new Vector2(r, r * r * 1.1);
    });
    // Its own copy of the paint: only the dish needs both faces drawn.
    const dishPaint = paint.clone();
    dishPaint.side = DoubleSide;
    this.base.set(dishPaint, dishPaint.color.clone());
    const dish = add(new Mesh(new LatheGeometry(dishProfile, 28), dishPaint));
    dish.position.set(-0.75, 0.76, -0.3);
    dish.rotation.set(0.5, 0, 1.0);

    // Wheels on independent arms.
    const tyreGeo = new CylinderGeometry(R, R, WHEEL_W, 36, 1, true);
    tyreGeo.rotateX(Math.PI / 2);
    const hubGeo = new CircleGeometry(R * 0.82, 24);
    const capGeo = new CylinderGeometry(0.1, 0.1, WHEEL_W + 0.04, 16);
    capGeo.rotateX(Math.PI / 2);
    const armGeo = new BoxGeometry(1, 0.07, 0.07);
    for (const x of [AXLE, -AXLE]) {
      for (const side of [-1, 1]) {
        const wheel = new Group();
        const t = add(new Mesh(tyreGeo, tyre), wheel);
        this.tyres.push(t);
        for (const z of [-WHEEL_W / 2 + 0.02, WHEEL_W / 2 - 0.02]) {
          const hub = add(new Mesh(hubGeo, graphite), wheel);
          hub.position.z = z;
        }
        add(new Mesh(capGeo, alloy), wheel);
        wheel.position.set(x, -RIDE + R, side * TRACK);
        this.body.add(wheel);
        this.wheels.push(wheel);
        this.arms.push(
          add(new Mesh(armGeo, alloy)),
          add(new Mesh(armGeo, alloy)),
        );
      }
    }

    this.group.add(this.body);
  }

  /** The status light shows the site's accent colour. */
  setAccent(accent: Color) {
    this.status.color.copy(accent);
  }

  /** Turn the mast head (radians, positive to the left). */
  setPan(pan: number) {
    this.head.rotation.y = -pan;
  }

  /** Darken the rover when it drives into shadow (0 = full shade, 1 = full sun). */
  setShade(sun: number) {
    const f = 0.35 + 0.65 * sun;
    for (const [m, c] of this.base) m.color.copy(c).multiplyScalar(f);
  }

  private setBeam(mesh: Mesh, a: Vector3, b: Vector3) {
    const dir = this.scratch.copy(b).sub(a);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.set(dir.length(), 1, 1);
    mesh.quaternion.setFromUnitVectors(X, dir.normalize());
  }

  /**
   * Pose the rover. `world` maps grid metres to scene coordinates; `bump`
   * adds rock height under a point so wheels climb small rocks.
   */
  update(
    t: Terrain,
    pos: { x: number; y: number },
    heading: number,
    dt: number,
    speed: number,
    world: (x: number, y: number, h: number) => Vector3,
    bump: (x: number, y: number) => number,
  ) {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const at = (lx: number, lz: number) =>
      [pos.x + lx * c - lz * s, pos.y + lx * s + lz * c] as const;
    const locals = this.wheels.map(
      (w) => [w.position.x, w.position.z] as const,
    );
    const h = locals.map(([lx, lz]) => {
      const [x, y] = at(lx, lz);
      return heightAt(t, x, y) + bump(x, y);
    });
    // Wheel order: front-left, front-right, rear-left, rear-right.
    const front = (h[0]! + h[1]!) / 2;
    const rear = (h[2]! + h[3]!) / 2;
    const left = (h[0]! + h[2]!) / 2;
    const right = (h[1]! + h[3]!) / 2;
    const mean = (front + rear) / 2;

    this.group.position.copy(world(pos.x, pos.y, mean));
    this.group.rotation.set(0, -heading, 0);
    this.body.position.y = RIDE;
    this.body.rotation.set(
      -Math.atan2(right - left, 2 * TRACK),
      0,
      Math.atan2(front - rear, 2 * AXLE),
      "YXZ",
    );
    this.group.updateMatrixWorld(true);

    this.wheels.forEach((w, i) => {
      const [lx, lz] = locals[i]!;
      const [x, y] = at(lx, lz);
      const p = this.body.worldToLocal(world(x, y, h[i]! + R));
      w.position.y = Math.min(
        -RIDE + R + 0.25,
        Math.max(-RIDE + R - 0.25, p.y),
      );
      this.tyres[i]!.rotation.z -= (speed * dt) / R;
      // Two arms from the chassis side to the hub: an upper and a lower link.
      const side = Math.sign(lz);
      const pivotX = Math.sign(lx) * 0.55;
      const hub = new Vector3(
        lx,
        w.position.y,
        lz - side * (WHEEL_W / 2 + 0.02),
      );
      this.setBeam(
        this.arms[i * 2]!,
        new Vector3(pivotX, -0.05, side * 0.6),
        hub.clone().setY(hub.y + 0.06),
      );
      this.setBeam(
        this.arms[i * 2 + 1]!,
        new Vector3(pivotX, -0.22, side * 0.6),
        hub.clone().setY(hub.y - 0.06),
      );
    });
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    for (const m of this.base.keys()) m.dispose();
    this.lamp.dispose();
    this.status.dispose();
    this.textures.forEach((t) => t.dispose());
  }
}
