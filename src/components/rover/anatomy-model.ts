/**
 * High-detail model of the rover for the anatomy view: the same layout and
 * dimensions as the simulation's rover, with its avionics, actuators,
 * cameras and wiring harness modelled inside. Only the anatomy section
 * loads it; the simulation keeps its lighter model.
 *
 * Everything is static, so pieces are baked into the body frame and merged
 * per (part, material): a few dozen draw calls for the whole vehicle, and
 * each part keeps its own material so it can light up on its own. Cables
 * are routed as straight runs with bend radii, like a real harness, and
 * carry a per-route index so the view can light the wires that serve a part.
 *
 * Body frame: x forward, y up, z to the left, origin at the chassis centre.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Curve,
  CurvePath,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  LineCurve3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  QuadraticBezierCurve3,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VEHICLE } from "@/lib/rover/vehicle";
import { WIRES } from "./anatomy-parts";
import {
  HAZ_Z,
  HEAD,
  HUB_Y,
  NAV_Z,
  routes,
  type Route,
  type V,
} from "./anatomy-routes";
import { makeTextures, type Textures } from "./anatomy-textures";

const {
  wheelRadius: R,
  wheelWidth: WHEEL_W,
  wheelBase: AXLE,
  wheelTrack: TRACK,
  rideHeight: RIDE,
} = VEHICLE;

// ---------- materials ----------

const MATS = {
  paint: () => new MeshStandardMaterial({ color: 0xf3f3ef, roughness: 0.55 }),
  radiator: (t: Textures) =>
    new MeshStandardMaterial({ color: 0xffffff, map: t.fins, roughness: 0.6 }),
  alloy: () =>
    new MeshStandardMaterial({
      color: 0xc6cbd1,
      roughness: 0.32,
      metalness: 0.95,
    }),
  anodize: () =>
    new MeshStandardMaterial({
      color: 0x2c3036,
      roughness: 0.42,
      metalness: 0.55,
    }),
  black: () =>
    new MeshStandardMaterial({
      color: 0x111315,
      roughness: 0.75,
      side: DoubleSide,
    }),
  mli: (t: Textures) =>
    new MeshStandardMaterial({
      color: 0xe2b04c,
      roughness: 0.26,
      metalness: 1,
      bumpMap: t.crinkle,
      bumpScale: 2.2,
    }),
  kapton: () =>
    new MeshStandardMaterial({
      color: 0xc9781e,
      roughness: 0.35,
      metalness: 0.3,
    }),
  solar: (t: Textures) =>
    new MeshStandardMaterial({
      color: 0xffffff,
      map: t.solar,
      roughness: 0.18,
      metalness: 0.4,
    }),
  glass: () =>
    new MeshStandardMaterial({
      color: 0x05070a,
      roughness: 0.04,
      metalness: 0.6,
    }),
  pcb: (t: Textures) =>
    new MeshStandardMaterial({ color: 0xffffff, map: t.pcb, roughness: 0.5 }),
  chip: () =>
    new MeshStandardMaterial({
      color: 0x2e3034,
      roughness: 0.4,
      metalness: 0.15,
    }),
  lid: () =>
    new MeshStandardMaterial({
      color: 0xd4ae5c,
      roughness: 0.22,
      metalness: 1,
    }),
  cell: () =>
    new MeshStandardMaterial({
      color: 0x35557a,
      roughness: 0.4,
      metalness: 0.25,
    }),
  tyre: (t: Textures) =>
    new MeshStandardMaterial({
      color: 0xffffff,
      map: t.tyre,
      alphaTest: 0.5,
      roughness: 0.35,
      metalness: 0.85,
      side: DoubleSide,
    }),
  lamp: () =>
    new MeshStandardMaterial({
      color: 0xfff6e8,
      emissive: 0xfff1d6,
      emissiveIntensity: 0.9,
    }),
  coax: () => new MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.55 }),
} as const;
type Mat = keyof typeof MATS;

// ---------- builder ----------

interface Piece {
  part: string | null;
  mat: Mat;
  /** Outer skin that turns to x-ray. */
  shell: boolean;
  geo: BufferGeometry;
}

const ONE = new Vector3(1, 1, 1);
const compose = (pos: V, rot: V) =>
  new Matrix4().compose(
    new Vector3(...pos),
    new Quaternion().setFromEuler(new Euler(...rot)),
    ONE,
  );

class Builder {
  pieces: Piece[] = [];
  part: string | null = null;
  shell = false;
  private stack = [new Matrix4()];

  in(part: string | null, fn: () => void, shell = false) {
    const [p, s] = [this.part, this.shell];
    this.part = part;
    this.shell = shell;
    fn();
    this.part = p;
    this.shell = s;
  }

  frame(pos: V, rot: V, fn: () => void) {
    this.stack.push(this.stack.at(-1)!.clone().multiply(compose(pos, rot)));
    fn();
    this.stack.pop();
  }

  add(mat: Mat, geo: BufferGeometry, pos: V = [0, 0, 0], rot: V = [0, 0, 0]) {
    return this.addM(mat, geo, compose(pos, rot));
  }

  addM(mat: Mat, geo: BufferGeometry, m: Matrix4) {
    geo.applyMatrix4(this.stack.at(-1)!.clone().multiply(m));
    this.pieces.push({ part: this.part, mat, shell: this.shell, geo });
  }

  /** A square-section bar from a to b. */
  beam(mat: Mat, a: Vector3, b: Vector3, w: number, h = w) {
    const d = b.clone().sub(a);
    const geo = new BoxGeometry(d.length(), h, w);
    const q = new Quaternion().setFromUnitVectors(
      new Vector3(1, 0, 0),
      d.clone().normalize(),
    );
    this.addM(
      mat,
      geo,
      new Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, ONE),
    );
  }
}

const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);
const rbox = (w: number, h: number, d: number, r = 0.02) =>
  new RoundedBoxGeometry(w, h, d, 2, r);
const cylY = (rBottom: number, len: number, seg = 28, rTop = rBottom) =>
  new CylinderGeometry(rTop, rBottom, len, seg);
const cylX = (r: number, len: number, seg = 28) =>
  cylY(r, len, seg).rotateZ(Math.PI / 2);
const cylZ = (r: number, len: number, seg = 28) =>
  cylY(r, len, seg).rotateX(Math.PI / 2);
const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

class Helix extends Curve<Vector3> {
  constructor(
    private c: Vector3,
    private r: number,
    private h: number,
    private turns: number,
  ) {
    super();
  }
  override getPoint(t: number, out = new Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return out.set(
      this.c.x + Math.cos(a) * this.r,
      this.c.y + t * this.h,
      this.c.z + Math.sin(a) * this.r,
    );
  }
}

/** A cable path: straight runs joined by bends of radius `bend`. */
function cablePath(pts: Vector3[], bend = 0.035) {
  const path = new CurvePath<Vector3>();
  let prev = pts[0]!.clone();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const ab = b.clone().sub(a);
    const bc = c.clone().sub(b);
    const f = Math.min(bend, ab.length() / 2, bc.length() / 2);
    const p1 = b.clone().addScaledVector(ab.normalize(), -f);
    const p2 = b.clone().addScaledVector(bc.normalize(), f);
    if (prev.distanceTo(p1) > 1e-4) path.add(new LineCurve3(prev, p1));
    path.add(new QuadraticBezierCurve3(p1, b.clone(), p2));
    prev = p2;
  }
  path.add(new LineCurve3(prev, pts.at(-1)!.clone()));
  return path;
}

/** Wire gauge by bus, in metres. */
const GAUGE: Record<string, number> = {
  power: 0.011,
  motor: 0.0095,
  spacewire: 0.0072,
  fibre: 0.0045,
  ethernet: 0.0068,
  serial: 0.0058,
};

// ---------- the vehicle ----------

function buildVehicle(b: Builder) {
  const P = Math.PI;

  // Chassis: the warm electronics box. Its skin, deck and arrays turn to
  // x-ray; the frame and everything inside stay solid.
  b.in(
    "web",
    () => {
      b.add("paint", rbox(2.0, 0.46, 1.24, 0.06));
      b.add("mli", rbox(1.92, 0.035, 1.18, 0.015), [0, -0.245, 0]);
      b.add("mli", rbox(0.035, 0.36, 1.1, 0.012), [-1.012, -0.02, 0]);
    },
    true,
  );
  b.in("web", () => {
    // Frame rails and bulkheads.
    for (const y of [-0.2, 0.2])
      for (const z of [-0.585, 0.585])
        b.add("alloy", box(1.94, 0.03, 0.03), [0, y, z]);
    for (const x of [-0.96, 0.96, -0.3])
      for (const y of [-0.2, 0.2])
        b.add("alloy", box(0.03, 0.03, 1.14), [x, y, 0]);
    for (const x of [-0.96, 0.96])
      for (const z of [-0.585, 0.585])
        b.add("alloy", box(0.03, 0.38, 0.03), [x, 0, z]);
    b.add("anodize", box(1.88, 0.012, 1.12), [0, -0.214, 0]);
    // Test port on the back panel.
    b.add("alloy", cylX(0.028, 0.05), [-1.02, 0.1, -0.32]);
    b.add("anodize", cylX(0.032, 0.012), [-1.047, 0.1, -0.32]);
  });

  // Radiator deck with fins.
  b.in(
    "radiator",
    () => {
      b.add("radiator", rbox(1.72, 0.035, 1.02, 0.012), [0, 0.248, 0]);
      for (let i = 0; i < 13; i++)
        b.add("radiator", box(1.6, 0.03, 0.01), [
          0,
          0.28,
          -0.45 + (i * 0.9) / 12,
        ]);
    },
    true,
  );

  // Upright solar arrays on both flanks.
  for (const s of [1, -1]) {
    b.in(
      "solar",
      () => {
        b.add("alloy", box(1.8, 0.78, 0.028), [-0.05, 0.27, s * 0.655]);
        b.add(
          "solar",
          box(1.72, 0.7, 0.008),
          [-0.05, 0.27, s * 0.672],
          [0, s > 0 ? 0 : P, 0],
        );
      },
      true,
    );
    b.in("solar", () => {
      for (const x of [-0.75, -0.05, 0.65])
        b.add("alloy", box(0.05, 0.05, 0.05), [x, 0.12, s * 0.63]);
    });
  }

  // Hazard cameras: bodies inside the front and back walls, lenses outside.
  b.in("hazcams", () => {
    for (const f of [1, -1]) {
      b.add("anodize", box(0.05, 0.1, 0.46), [f * 1.025, -0.08, 0]);
      for (const z of [HAZ_Z, -HAZ_Z]) {
        b.add("anodize", rbox(0.1, 0.09, 0.09, 0.01), [f * 0.925, -0.08, z]);
        b.add("alloy", cylX(0.034, 0.07), [f * 1.04, -0.08, z]);
        b.add("black", cylX(0.038, 0.012), [f * 1.07, -0.08, z]);
        b.add(
          "glass",
          new SphereGeometry(0.03, 24, 12, 0, P * 2, 0, P / 2),
          [f * 1.075, -0.08, z],
          [0, 0, -f * (P / 2)],
        );
      }
    }
  });

  // Mast: base hinge and a hollow tube, which carries the harness up
  // inside it (so it turns to x-ray too).
  const [hx, hy] = HEAD;
  b.in(
    "mastActuators",
    () => {
      b.add("alloy", cylY(0.042, hy - 0.2 - 0.3, 32, 0.048), [
        hx,
        (hy - 0.2 + 0.3) / 2,
        0,
      ]);
    },
    true,
  );
  b.in("mastActuators", () => {
    b.add("alloy", box(0.18, 0.03, 0.18), [hx, 0.262, 0]);
    b.add("anodize", cylZ(0.04, 0.15), [hx, 0.3, 0]);
    for (const y of [0.34, hy - 0.23])
      b.add("alloy", cylY(0.056, 0.02, 32), [hx, y, 0]);
    // Pan actuator, with the cable wrap coiled around it.
    b.add("alloy", cylY(0.085, 0.012), [hx, hy - 0.2, 0]);
    b.add("anodize", cylY(0.072, 0.1), [hx, hy - 0.14, 0]);
    b.add("kapton", cylY(0.074, 0.03), [hx, hy - 0.15, 0]);
    b.add("alloy", cylY(0.085, 0.012), [hx, hy - 0.085, 0]);
    b.add(
      "coax",
      new TubeGeometry(
        new Helix(v3(hx, hy - 0.19, 0), 0.088, 0.09, 3.5),
        120,
        0.006,
        6,
      ),
    );
    // Tilt actuator and yoke under the camera bar.
    b.add("anodize", box(0.08, 0.05, 0.12), [hx, hy - 0.055, 0]);
    b.add("anodize", cylZ(0.042, 0.2), [hx, hy - 0.02, 0]);
    b.add("kapton", cylZ(0.044, 0.05), [hx, hy - 0.02, 0.07]);
  });

  // Navigation stereo cameras on their bar, with sunshades and floodlights.
  b.in("navcam", () => {
    b.frame([hx, hy, 0], [0, 0, 0], () => {
      b.add("paint", rbox(0.12, 0.11, 0.66, 0.025), [0, 0.04, 0]);
      for (const z of [NAV_Z, -NAV_Z]) {
        b.add("anodize", rbox(0.17, 0.1, 0.1, 0.012), [0.07, 0.04, z]);
        for (let i = 0; i < 4; i++)
          b.add("anodize", box(0.004, 0.08, 0.1), [-0.03 - i * 0.012, 0.04, z]);
        b.add("alloy", cylX(0.034, 0.05), [0.18, 0.04, z]);
        b.add("glass", cylX(0.028, 0.004), [0.206, 0.04, z]);
        b.add(
          "black",
          new LatheGeometry(
            [new Vector2(0.037, 0), new Vector2(0.056, 0.07)],
            28,
          ).rotateZ(-P / 2),
          [0.205, 0.04, z],
        );
      }
      for (const z of [-0.07, 0.07])
        b.add("lamp", rbox(0.02, 0.04, 0.09, 0.006), [0.065, 0.04, z]);
    });
  });

  // High-gain antenna: two-axis gimbal, boom, dish, feed on three struts.
  const hga = v3(-0.72, 0.265, -0.34);
  b.in("hga", () => {
    b.frame([hga.x, hga.y, hga.z], [0, 0, 0], () => {
      b.add("alloy", cylY(0.07, 0.012), [0, 0.006, 0]);
      b.add("anodize", cylY(0.058, 0.08), [0, 0.05, 0]);
      b.add("kapton", cylY(0.06, 0.02), [0, 0.05, 0]);
      b.add("alloy", cylY(0.022, 0.3), [0, 0.24, 0]);
      b.add("anodize", cylZ(0.04, 0.12), [0, 0.42, 0]);
      b.frame([0, 0.45, 0], [0.25, 0, 0.95], () => {
        const prof = Array.from({ length: 16 }, (_, i) => {
          const r = (i / 15) * 0.27;
          return new Vector2(r, r * r * 1.1);
        });
        b.add("paint", new LatheGeometry(prof, 48));
        b.add(
          "alloy",
          new TorusGeometry(0.27, 0.006, 6, 48),
          [0, 0.08, 0],
          [P / 2, 0, 0],
        );
        const focus = v3(0, 1 / (4 * 1.1), 0);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * P * 2;
          b.beam(
            "alloy",
            v3(Math.cos(a) * 0.25, 0.069, Math.sin(a) * 0.25),
            focus,
            0.008,
          );
        }
        b.add("anodize", cylY(0.024, 0.05), [0, focus.y + 0.01, 0]);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * P * 2;
          b.beam(
            "alloy",
            v3(0, 0.0, 0),
            v3(Math.cos(a) * 0.25, 0.05, Math.sin(a) * 0.25),
            0.012,
            0.025,
          );
        }
      });
    });
  });

  // Internal avionics.
  // Flight computer board: conduction-cooled, wedge locks along its edges.
  b.frame([0.45, -0.02, 0], [0, 0, 0], () => {
    b.in("computer", () => {
      b.add("pcb", box(0.62, 0.016, 0.46));
      for (const z of [-0.238, 0.238])
        b.add("alloy", box(0.62, 0.03, 0.02), [0, 0.004, z]);
      for (const z of [-0.2, 0.2])
        b.add("anodize", box(0.56, 0.012, 0.025), [0, 0.022, z]);
      // DC-DC converters and the micro-D connectors on the back edge.
      b.add("alloy", rbox(0.08, 0.03, 0.06, 0.004), [0.22, 0.024, -0.1]);
      b.add("alloy", rbox(0.08, 0.03, 0.06, 0.004), [0.22, 0.024, -0.17]);
      for (const z of [0.192, 0.124, 0.057, -0.027, -0.09, -0.17])
        b.add("alloy", rbox(0.03, 0.028, 0.055, 0.004), [-0.325, 0.018, z]);
      for (let i = 0; i < 10; i++)
        b.add("chip", box(0.012, 0.006, 0.02), [0.02 + i * 0.022, 0.011, 0.02]);
    });
    b.in("cpu", () => {
      b.add("chip", box(0.1, 0.012, 0.1), [-0.13, 0.014, -0.1]);
      b.add("lid", box(0.068, 0.005, 0.068), [-0.13, 0.022, -0.1]);
    });
    b.in("fpga", () => {
      b.add("chip", box(0.13, 0.014, 0.13), [0.06, 0.015, -0.1]);
      b.add("lid", box(0.094, 0.005, 0.094), [0.06, 0.024, -0.1]);
    });
    b.in("memory", () => {
      for (const x of [-0.22, -0.14])
        for (const z of [0.08, 0.14])
          b.add("chip", box(0.06, 0.009, 0.036), [x, 0.012, z]);
    });
    b.in("storage", () => {
      for (const x of [-0.04, 0.03])
        b.add("chip", box(0.05, 0.012, 0.05), [x, 0.014, 0.12]);
    });
    b.in("watchdog", () => {
      b.add("chip", box(0.03, 0.008, 0.03), [0.21, 0.012, 0.14]);
    });
  });

  // Motor controller boards, one per side.
  for (const s of [1, -1]) {
    b.in("motorControllers", () => {
      b.frame([0.45, -0.02, s * 0.44], [0, 0, 0], () => {
        b.add("pcb", box(0.58, 0.016, 0.2));
        b.add("alloy", box(0.58, 0.045, 0.024), [0, 0.02, s * 0.09]);
        b.add("chip", box(0.05, 0.01, 0.05), [-0.2, 0.013, 0]);
        for (let ch = 0; ch < 4; ch++) {
          const x = -0.1 + ch * 0.1;
          b.add("chip", box(0.022, 0.007, 0.018), [x, 0.011, -s * 0.05]);
          for (let k = 0; k < 6; k++)
            b.add("chip", box(0.016, 0.008, 0.02), [
              x - 0.025 + (k % 3) * 0.025,
              0.012,
              s * (0.03 + (k > 2 ? 0.03 : 0)),
            ]);
          b.add("alloy", cylY(0.011, 0.03, 12), [x + 0.03, 0.023, -s * 0.075]);
        }
        for (const z of [0.36, 0.42, 0.47, 0.52])
          b.add("alloy", rbox(0.03, 0.028, 0.045, 0.004), [
            -0.305,
            0.018,
            s * z - s * 0.44,
          ]);
        b.add("alloy", rbox(0.03, 0.028, 0.05, 0.004), [
          0.305,
          0.018,
          s * 0.06,
        ]);
      });
    });
  }

  // IMU on its bracket near the centre of mass, fibre coil housing on top.
  b.in("imu", () => {
    b.add("alloy", box(0.19, 0.012, 0.19), [-0.05, -0.2, 0]);
    b.add("anodize", rbox(0.13, 0.11, 0.13, 0.01), [-0.05, -0.135, 0]);
    b.add("alloy", cylY(0.052, 0.03, 32), [-0.05, -0.066, 0]);
    b.add("lid", box(0.05, 0.001, 0.03), [0.016, -0.12, 0.03], [0, 0, P / 2]);
    b.add("alloy", rbox(0.012, 0.025, 0.04, 0.003), [0.02, -0.13, 0]);
  });

  // Power distribution unit.
  b.in("pdu", () => {
    b.add("anodize", rbox(0.24, 0.2, 0.24, 0.012), [-0.12, -0.08, 0.36]);
    for (let i = 0; i < 6; i++)
      b.add("alloy", box(0.22, 0.02, 0.006), [-0.12, 0.03, 0.26 + i * 0.04]);
    for (const [y, z] of [
      [-0.1, 0.27],
      [-0.06, 0.31],
      [-0.02, 0.42],
      [0.0, 0.34],
      [-0.15, 0.44],
    ] as const)
      b.add("alloy", rbox(0.014, 0.028, 0.04, 0.003), [0.004, y, z]);
  });

  // Radio transceiver with RF connectors on top.
  b.in("radio", () => {
    b.add("anodize", rbox(0.22, 0.16, 0.22, 0.012), [-0.12, -0.08, -0.36]);
    for (let i = 0; i < 5; i++)
      b.add("anodize", box(0.2, 0.012, 0.006), [
        -0.12,
        0.004,
        -0.44 + i * 0.04,
      ]);
    for (const x of [-0.08, -0.16])
      b.add("alloy", cylY(0.012, 0.02, 12), [x, 0.01, -0.36]);
    b.add("alloy", rbox(0.014, 0.028, 0.04, 0.003), [-0.005, -0.06, -0.3]);
    // Low-gain antenna on the back deck: a short helix under a radome.
    b.add("alloy", cylY(0.03, 0.012), [-0.84, 0.272, 0.42]);
    b.add("alloy", cylY(0.01, 0.06), [-0.84, 0.3, 0.42]);
    b.add(
      "alloy",
      new TubeGeometry(
        new Helix(v3(-0.84, 0.33, 0.42), 0.025, 0.12, 5),
        160,
        0.003,
        5,
      ),
    );
    // Coax to both antennas.
    const coax = (pts: V[]) =>
      b.add(
        "coax",
        new TubeGeometry(cablePath(pts.map((p) => v3(...p))), 90, 0.006, 6),
      );
    coax([
      [-0.08, 0.02, -0.36],
      [-0.08, 0.14, -0.36],
      [-0.66, 0.14, -0.36],
      [-0.66, 0.14, -0.34],
      [-0.66, 0.27, -0.34],
    ]);
    coax([
      [-0.16, 0.02, -0.36],
      [-0.16, 0.115, -0.36],
      [-0.16, 0.115, 0.42],
      [-0.84, 0.115, 0.42],
      [-0.84, 0.268, 0.42],
    ]);
  });

  // Battery: strings of cylindrical cells in a frame, low at the back.
  b.in("battery", () => {
    b.add("anodize", box(0.46, 0.014, 0.92), [-0.58, -0.2, 0]);
    for (const x of [-0.815, -0.345])
      b.add("anodize", box(0.012, 0.2, 0.92), [x, -0.1, 0]);
    const cell = cylY(0.036, 0.19, 18);
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 11; j++)
        b.add("cell", cell.clone(), [-0.76 + i * 0.09, -0.1, -0.4 + j * 0.08]);
    for (let j = 0; j < 11; j++)
      b.add("alloy", box(0.42, 0.003, 0.02), [-0.58, -0.003, -0.4 + j * 0.08]);
    b.add("alloy", rbox(0.02, 0.03, 0.05, 0.004), [-0.36, -0.05, 0.3]);
  });

  // Wheels: steering actuator over each, a fork down to the hub, a drive
  // actuator in the hub, flexible spokes and an open mesh tyre.
  const tyre = new CylinderGeometry(R, R, WHEEL_W, 96, 1, true).rotateX(P / 2);
  for (const f of [1, -1]) {
    for (const s of [1, -1]) {
      const cx = f * AXLE;
      const cz = s * TRACK;
      b.in("steering", () => {
        b.add("alloy", cylY(0.078, 0.012), [cx, -0.01, cz]);
        b.add("anodize", cylY(0.064, 0.13), [cx, -0.08, cz]);
        b.add("kapton", cylY(0.066, 0.04), [cx, -0.07, cz]);
        b.add("alloy", cylY(0.078, 0.012), [cx, -0.15, cz]);
      });
      b.in("wheels", () => {
        // Suspension arms from the chassis to the steering housing.
        b.beam(
          "alloy",
          v3(f * 0.6, -0.14, s * 0.6),
          v3(cx - f * 0.05, -0.05, s * 0.87),
          0.045,
        );
        b.beam(
          "alloy",
          v3(f * 0.6, -0.21, s * 0.6),
          v3(cx - f * 0.03, -0.13, s * 0.87),
          0.045,
        );
        b.add("anodize", box(0.08, 0.12, 0.03), [f * 0.6, -0.175, s * 0.605]);
        // Fork.
        b.add("alloy", box(0.1, 0.025, 0.24), [cx, -0.168, s * 0.83]);
        b.add("alloy", box(0.1, 0.4, 0.024), [cx, -0.36, s * 0.715]);
        b.add("alloy", cylZ(0.03, 0.12), [cx, HUB_Y, s * 0.77]);
        // Tyre, rims, spokes, hub.
        b.frame([cx, HUB_Y, cz], [0, 0, 0], () => {
          b.add("tyre", tyre.clone());
          for (const z of [-WHEEL_W / 2, WHEEL_W / 2])
            b.add("alloy", new TorusGeometry(R - 0.004, 0.011, 8, 96), [
              0,
              0,
              z,
            ]);
          for (const z of [-0.12, 0.12])
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * P * 2 + (z > 0 ? P / 8 : 0);
              b.beam(
                "alloy",
                v3(Math.cos(a) * 0.1, Math.sin(a) * 0.1, z * 0.6),
                v3(
                  Math.cos(a + 0.35) * (R - 0.01),
                  Math.sin(a + 0.35) * (R - 0.01),
                  z,
                ),
                0.03,
                0.006,
              );
            }
          b.add("alloy", cylZ(0.11, 0.05), [0, 0, s * 0.1]);
        });
      });
      b.in("driveMotors", () => {
        b.frame([cx, HUB_Y, cz], [0, 0, 0], () => {
          b.add("anodize", cylZ(0.085, 0.18, 32), [0, 0, -s * 0.03]);
          b.add("kapton", cylZ(0.087, 0.05, 32), [0, 0, -s * 0.06]);
          b.add("alloy", cylZ(0.095, 0.04, 32), [0, 0, s * 0.06]);
        });
      });
    }
  }
}

// ---------- assembly ----------

export interface AnatomyMesh extends Mesh {
  userData: {
    part: string | null;
    shell: boolean;
    flight: MeshStandardMaterial;
    emissive: Color;
  };
}

export interface BuiltRover {
  /** Rover root: the body frame, lifted so the wheels sit on y = 0. */
  root: Group;
  meshes: AnatomyMesh[];
  /** Visible wires, one mesh per bus, and fatter invisible ones to pick. */
  wires: Mesh<BufferGeometry, ShaderMaterial>[];
  wireHits: Mesh[];
  routes: Route[];
  /** Uniforms shared by every wire material. */
  wireUniforms: {
    uTime: { value: number };
    uLit: { value: Float32Array };
    uAny: { value: number };
    uReal: { value: number };
  };
  dispose(): void;
}

export const MAX_ROUTES = 64;

const WIRE_VERT = `
attribute float aAlong;
attribute float aRoute;
varying float vAlong;
varying float vRoute;
varying vec3 vN;
varying vec3 vV;
void main() {
  vAlong = aAlong;
  vRoute = aRoute;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const WIRE_FRAG = `
uniform vec3 uColor;
uniform float uTime;
uniform float uLit[${MAX_ROUTES}];
uniform float uAny;
uniform float uReal;
varying float vAlong;
varying float vRoute;
varying vec3 vN;
varying vec3 vV;
void main() {
  float lit = uLit[int(vRoute + 0.5)];
  vec3 n = normalize(vN);
  float diff = 0.45 + 0.55 * max(dot(n, normalize(vec3(0.3, 0.8, 0.6))), 0.0);
  float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.0);
  // Flight view shows harness as built: white insulation and lacing tape.
  vec3 base = mix(uColor, vec3(0.86, 0.83, 0.76), uReal * (1.0 - lit));
  float level = mix(1.0, mix(0.22, 1.25, lit), uAny);
  vec3 c = base * (diff + rim * 0.35) * level;
  // Pulses run from source to destination along a lit wire.
  float p = fract(vAlong * 3.0 - uTime * 0.9);
  c += lit * smoothstep(0.82, 1.0, p) * mix(base, vec3(1.0), 0.6) * 1.3;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function buildRover(): BuiltRover {
  const tex = makeTextures();
  const b = new Builder();
  buildVehicle(b);

  const root = new Group();
  root.position.y = RIDE;

  // Merge pieces per (part, material, shell).
  const buckets = new Map<string, Piece[]>();
  for (const p of b.pieces) {
    const k = `${p.part}|${p.mat}|${p.shell}`;
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(p);
  }
  const meshes: AnatomyMesh[] = [];
  for (const list of buckets.values()) {
    const geos = list.map(({ geo }) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      for (const name of Object.keys(g.attributes))
        if (!["position", "normal", "uv"].includes(name))
          g.deleteAttribute(name);
      if (!g.attributes.uv)
        g.setAttribute(
          "uv",
          new Float32BufferAttribute(
            new Float32Array(g.attributes.position!.count * 2),
            2,
          ),
        );
      if (g !== geo) geo.dispose();
      return g;
    });
    const merged = mergeGeometries(geos, false)!;
    geos.forEach((g) => g.dispose());
    const { part, mat, shell } = list[0]!;
    const material = MATS[mat](tex);
    const mesh = new Mesh(merged, material) as unknown as AnatomyMesh;
    mesh.userData = {
      part,
      shell,
      flight: material,
      emissive: material.emissive.clone(),
    };
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    meshes.push(mesh);
  }

  // Wiring: one merged tube mesh per bus, with each route's index and
  // distance along it baked in for the shader.
  const all = routes();
  const wireUniforms = {
    uTime: { value: 0 },
    uLit: { value: new Float32Array(MAX_ROUTES) },
    uAny: { value: 0 },
    uReal: { value: 0 },
  };
  const wires: BuiltRover["wires"] = [];
  const wireHits: Mesh[] = [];
  const hitMat = new MeshStandardMaterial({ visible: false });
  for (const w of WIRES) {
    const vis: BufferGeometry[] = [];
    const hit: BufferGeometry[] = [];
    const ends: BufferGeometry[] = [];
    all.forEach((route, i) => {
      if (route.bus !== w.id) return;
      const path = cablePath(route.pts.map((p) => v3(...p)));
      const len = path.getLength();
      const segs = Math.max(8, Math.ceil(len / 0.012));
      const g = new TubeGeometry(path, segs, GAUGE[w.id]!, 8);
      const uv = g.attributes.uv!;
      const along = new Float32Array(uv.count);
      for (let k = 0; k < uv.count; k++) along[k] = uv.getX(k) * len;
      g.setAttribute("aAlong", new Float32BufferAttribute(along, 1));
      g.setAttribute(
        "aRoute",
        new Float32BufferAttribute(new Float32Array(uv.count).fill(i), 1),
      );
      vis.push(g);
      hit.push(new TubeGeometry(path, Math.ceil(segs / 3), 0.022, 5));
      // Connector backshells at both ends.
      for (const t of [0, 1]) {
        const at = path.getPointAt(t);
        const dir = path.getTangentAt(t);
        const cyl = cylY(GAUGE[w.id]! * 2.1, 0.028, 12);
        cyl.applyMatrix4(
          new Matrix4().compose(
            at.addScaledVector(dir, t ? -0.014 : 0.014),
            new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir),
            ONE,
          ),
        );
        ends.push(cyl.toNonIndexed());
        cyl.dispose();
      }
    });
    if (!vis.length) continue;
    const material = new ShaderMaterial({
      uniforms: { ...wireUniforms, uColor: { value: new Color(w.color) } },
      vertexShader: WIRE_VERT,
      fragmentShader: WIRE_FRAG,
    });
    const mesh = new Mesh(mergeGeometries(vis, false)!, material);
    mesh.userData = { part: w.id };
    mesh.castShadow = true;
    root.add(mesh);
    wires.push(mesh);
    const hitMesh = new Mesh(mergeGeometries(hit, false)!, hitMat);
    hitMesh.userData = { part: w.id };
    root.add(hitMesh);
    wireHits.push(hitMesh);
    const endMat = MATS.alloy();
    const endMesh = new Mesh(
      mergeGeometries(ends, false)!,
      endMat,
    ) as unknown as AnatomyMesh;
    endMesh.userData = {
      part: w.id,
      shell: false,
      flight: endMat,
      emissive: endMat.emissive.clone(),
    };
    root.add(endMesh);
    meshes.push(endMesh);
    [...vis, ...hit, ...ends].forEach((g) => g.dispose());
  }

  return {
    root,
    meshes,
    wires,
    wireHits,
    routes: all,
    wireUniforms,
    dispose() {
      root.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          (o.material as { dispose(): void }).dispose();
        }
      });
      // Shells may be wearing the view's x-ray material instead of their own.
      meshes.forEach((m) => m.userData.flight.dispose());
      hitMat.dispose();
      Object.values(tex).forEach((t: Texture) => t.dispose());
    },
  };
}
