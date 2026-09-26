/**
 * Where the harness runs: each cable as straight runs between bend points,
 * in the body frame (x forward, y up, z to the left, origin at the chassis
 * centre), with the mount points the model shares.
 */
import { VEHICLE } from "@/lib/rover/vehicle";

export type V = [number, number, number];

const AXLE = VEHICLE.wheelBase;
/** Wheel hub height in the body frame. */
export const HUB_Y = VEHICLE.wheelRadius - VEHICLE.rideHeight;
/** Mast head centre, in the body frame. */
export const HEAD: V = [0.72, VEHICLE.mastHeight - VEHICLE.rideHeight, 0];
/** Stereo lens offsets from the centre line: navigation and hazard pairs. */
export const NAV_Z = 0.21;
export const HAZ_Z = 0.15;

/** One cable run: which bus, which parts it joins, and its path (source first). */
export interface Route {
  bus: string;
  ends: [string, string];
  pts: V[];
}

export function routes(): Route[] {
  const out: Route[] = [];
  const r = (bus: string, ends: [string, string], ...pts: V[]) =>
    out.push({ bus, ends, pts });
  const [hx, hy] = HEAD;
  // Flight computer connectors along its back edge, at y 0.
  const FC = 0.105;

  // Mast cameras: fibre down the back of the mast to the vision FPGA.
  for (const [z, fz] of [
    [NAV_Z, 0.198],
    [-NAV_Z, 0.186],
  ] as const) {
    const lane = z > 0 ? 0.008 : -0.008;
    r(
      "fibre",
      ["navcam", "computer"],
      [hx - 0.02, hy + 0.04, z],
      [hx - 0.085, hy + 0.04, z],
      [hx - 0.085, hy - 0.02, lane],
      [hx - 0.018, hy - 0.12, lane],
      [hx - 0.018, 0.13, lane],
      [0.06, 0.13, fz],
      [0.06, 0, fz],
      [FC, 0, fz],
    );
  }

  // Hazard cameras: SpaceWire to the computer.
  for (const z of [HAZ_Z, -HAZ_Z]) {
    const fz = z > 0 ? 0.132 : 0.116;
    r(
      "spacewire",
      ["hazcams", "computer"],
      [0.875, -0.08, z],
      [0.8, -0.08, z],
      [0.8, -0.15, z],
      [0.25, -0.15, z],
      [0.25, -0.15, fz],
      [0.085, -0.15, fz],
      [0.085, 0, fz],
      [FC, 0, fz],
    );
    const rz = z > 0 ? 0.064 : 0.05;
    r(
      "spacewire",
      ["hazcams", "computer"],
      [-0.875, -0.08, z],
      [-0.86, -0.08, z],
      [-0.86, 0.1, z],
      [0.06, 0.1, z],
      [0.06, 0.1, rz],
      [0.06, 0, rz],
      [FC, 0, rz],
    );
  }

  // Ethernet: computer to radio, and to the ground test port.
  r(
    "ethernet",
    ["computer", "radio"],
    [FC, 0, -0.02],
    [0.045, 0, -0.02],
    [0.045, -0.06, -0.02],
    [0.045, -0.06, -0.3],
    [-0.005, -0.06, -0.3],
  );
  r(
    "ethernet",
    ["computer", "web"],
    [FC, 0, -0.034],
    [0.07, 0, -0.034],
    [0.07, 0.15, -0.034],
    [0.07, 0.15, -0.24],
    [-0.9, 0.15, -0.24],
    [-0.9, 0.1, -0.32],
    [-0.99, 0.1, -0.32],
  );

  // RS-422: computer to the IMU, the power unit and both motor controllers.
  const ser: V[] = [
    [FC, 0, -0.09],
    [0.072, 0, -0.09],
    [0.072, -0.1, -0.09],
  ];
  r(
    "serial",
    ["computer", "imu"],
    ...ser,
    [0.072, -0.13, -0.09],
    [0.072, -0.13, 0],
    [0.024, -0.13, 0],
  );
  r(
    "serial",
    ["computer", "pdu"],
    ...ser,
    [0.072, -0.1, 0.27],
    [0.004, -0.1, 0.27],
  );
  for (const s of [1, -1]) {
    r(
      "serial",
      ["computer", "motorControllers"],
      ...ser,
      [0.072, -0.088, s * 0.36],
      [0.12, -0.088, s * 0.36],
      [0.12, 0, s * 0.36],
      [0.145, 0, s * 0.36],
    );
  }

  // Power: sources into the distribution unit, then out to every load.
  r(
    "power",
    ["battery", "pdu"],
    [-0.37, -0.05, 0.3],
    [-0.3, -0.05, 0.3],
    [-0.3, -0.05, 0.36],
    [-0.245, -0.05, 0.36],
  );
  r(
    "power",
    ["solar", "pdu"],
    [-0.4, 0.17, 0.655],
    [-0.4, 0.17, 0.45],
    [-0.15, 0.17, 0.45],
    [-0.15, 0.03, 0.45],
  );
  r(
    "power",
    ["solar", "pdu"],
    [-0.42, 0.17, -0.655],
    [-0.42, 0.17, 0.3],
    [-0.2, 0.17, 0.3],
    [-0.2, 0.03, 0.3],
  );
  r(
    "power",
    ["pdu", "computer"],
    [0.004, -0.06, 0.31],
    [0.03, -0.06, 0.31],
    [0.03, -0.06, -0.17],
    [0.03, 0, -0.17],
    [FC, 0, -0.17],
  );
  r(
    "power",
    ["pdu", "motorControllers"],
    [0.004, -0.02, 0.42],
    [0.1, -0.02, 0.42],
    [0.1, 0, 0.42],
    [0.145, 0, 0.42],
  );
  r(
    "power",
    ["pdu", "motorControllers"],
    [0.004, 0.0, 0.34],
    [0.02, 0.06, 0.34],
    [0.02, 0.06, -0.42],
    [0.1, 0.06, -0.42],
    [0.1, 0, -0.42],
    [0.145, 0, -0.42],
  );
  r("power", ["pdu", "imu"], [-0.05, -0.14, 0.235], [-0.05, -0.14, 0.072]);
  r(
    "power",
    ["pdu", "radio"],
    [-0.19, 0.03, 0.33],
    [-0.19, 0.08, 0.33],
    [-0.19, 0.08, -0.36],
    [-0.19, 0.0, -0.36],
  );
  r(
    "power",
    ["pdu", "navcam"],
    [-0.06, 0.03, 0.4],
    [-0.06, 0.19, 0.4],
    [hx + 0.02, 0.19, 0.4],
    [hx + 0.02, 0.19, 0],
    [hx + 0.02, hy - 0.12, 0],
    [hx + 0.05, hy - 0.08, 0],
    [hx + 0.05, hy - 0.025, 0],
  );
  r(
    "power",
    ["pdu", "hazcams"],
    [0.004, -0.15, 0.44],
    [0.03, -0.17, 0.44],
    [0.03, -0.17, 0.29],
    [0.84, -0.17, 0.29],
    [0.84, -0.17, 0],
    [0.9, -0.12, 0],
  );
  r(
    "power",
    ["pdu", "hazcams"],
    [-0.24, 0.03, 0.42],
    [-0.24, 0.07, 0.42],
    [-0.84, 0.07, 0.42],
    [-0.84, 0.07, 0],
    [-0.84, -0.04, 0],
    [-0.88, -0.08, 0],
  );

  // Motor drives: each side's board to its wheels (drive and steering) and
  // to one pointing mechanism. Cables leave low through the side wall and
  // follow the lower suspension arm, with slack across the steering joint.
  for (const s of [1, -1]) {
    for (const f of [1, -1]) {
      const start: V[] =
        f > 0
          ? [
              [0.76, 0, s * 0.5],
              [0.8, 0, s * 0.5],
              [0.8, -0.16, s * 0.5],
            ]
          : [
              [0.145, 0, s * 0.52],
              [0.1, 0, s * 0.52],
              [0.1, -0.16, s * 0.52],
              [-0.8, -0.16, s * 0.52],
            ];
      const cx = f * AXLE;
      const out: V[] = [
        [f * 0.8, -0.165, s * 0.64],
        [f * 0.86, -0.175, s * 0.69],
        [f * 1.03, -0.13, s * 0.83],
      ];
      r("motor", ["motorControllers", "steering"], ...start, ...out, [
        cx - f * 0.07,
        -0.08,
        s * 0.87,
      ]);
      r(
        "motor",
        ["motorControllers", "driveMotors"],
        ...start.map(([x, y, z]) => [x, y - 0.014, z] as V),
        ...out.map(([x, y, z]) => [x, y - 0.014, z] as V),
        [cx - f * 0.04, -0.2, s * 0.8],
        [cx + f * 0.06, -0.19, s * 0.715],
        [cx + f * 0.06, HUB_Y + 0.08, s * 0.715],
        [cx + f * 0.02, HUB_Y + 0.02, s * 0.76],
      );
    }
  }
  r(
    "motor",
    ["motorControllers", "mastActuators"],
    [0.145, 0, 0.47],
    [0.1, 0, 0.47],
    [0.1, 0.21, 0.47],
    [hx, 0.21, 0.47],
    [hx, 0.21, 0.02],
    [hx, hy - 0.2, 0.02],
    [hx, hy - 0.16, 0.08],
  );
  r(
    "motor",
    ["motorControllers", "hga"],
    [0.145, 0, -0.47],
    [0.1, 0, -0.47],
    [0.1, -0.13, -0.49],
    [-0.3, -0.13, -0.49],
    [-0.3, 0.13, -0.49],
    [-0.72, 0.13, -0.49],
    [-0.72, 0.13, -0.37],
    [-0.72, 0.29, -0.37],
  );
  return out;
}
