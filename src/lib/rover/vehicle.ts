/**
 * The rover's physical limits and sensor layout. The terrain analysis, the
 * planner's safety margins, the collision checks, the simulated cameras and
 * the 3D model all read from here, so what the rover believes it can do
 * matches what its body can actually do. Distances in metres, angles in
 * radians. The design is generic: textbook numbers, not any real vehicle.
 */
const deg = (d: number) => (d * Math.PI) / 180;

export const VEHICLE = {
  length: 3.0,
  width: 2.2,
  wheelRadius: 0.36,
  wheelWidth: 0.32,
  /** Wheel centres from the body centre: forward and sideways. */
  wheelBase: 1.14,
  wheelTrack: 0.94,
  /** Chassis centre above the ground, 0.55 m over the wheel centres. */
  rideHeight: 0.91,
  /** Height of the stereo head above the ground. */
  mastHeight: 2.4,
  sensorRange: 16,
  /** Steepest ground the planner will choose to drive on. */
  maxSlope: deg(20),
  /** Past this the rover risks tipping, so the body refuses to go there. */
  tipSlope: deg(27),
  /** Tallest step or rock it can climb, about one wheel radius. */
  maxStep: 0.34,
  speed: 5.5,
  reverseSpeed: 2.4,
  turnRate: 1.7,
} as const;

/** Radius of the largest circle inside the footprint. */
export const INSCRIBED = VEHICLE.width / 2;
/** Radius of the smallest circle around the footprint. */
export const CIRCUMSCRIBED = Math.hypot(VEHICLE.length / 2, VEHICLE.width / 2);

export interface CameraSpec {
  id: "navcam" | "hazFront" | "hazRear";
  label: string;
  /** Mount in the body frame: forward, left, height above ground. */
  x: number;
  y: number;
  z: number;
  /** Direction relative to the body (0 forward) and tilt below horizontal. */
  yaw: number;
  pitch: number;
  hfov: number;
  vfov: number;
  range: number;
  /** Stereo baseline and focal length in pixels set the depth noise. */
  baseline: number;
  focalPx: number;
  /** Rays cast per frame (a thinned-out image grid). */
  cols: number;
  rows: number;
  /** The navigation cameras sit on a pan head on the mast. */
  pans: boolean;
}

/**
 * A stereo pair on the mast for mapping ahead, and wide stereo hazard
 * cameras low on the front and back of the body for the ground right around
 * the wheels (the rear pair covers reversing).
 */
export const CAMERAS: readonly CameraSpec[] = [
  {
    id: "navcam",
    label: "Navigation stereo pair",
    x: 0.72,
    y: 0,
    z: VEHICLE.mastHeight,
    yaw: 0,
    pitch: deg(24),
    hfov: deg(64),
    vfov: deg(44),
    range: VEHICLE.sensorRange,
    baseline: 0.42,
    focalPx: 820,
    cols: 40,
    rows: 20,
    pans: true,
  },
  {
    id: "hazFront",
    label: "Front hazard cameras",
    x: 1.0,
    y: 0,
    z: 0.82,
    yaw: 0,
    pitch: deg(38),
    hfov: deg(120),
    vfov: deg(80),
    range: 5.5,
    baseline: 0.3,
    focalPx: 300,
    cols: 22,
    rows: 10,
    pans: false,
  },
  {
    id: "hazRear",
    label: "Rear hazard cameras",
    x: -1.0,
    y: 0,
    z: 0.82,
    yaw: Math.PI,
    pitch: deg(38),
    hfov: deg(120),
    vfov: deg(80),
    range: 5.5,
    baseline: 0.3,
    focalPx: 300,
    cols: 22,
    rows: 10,
    pans: false,
  },
];

/** Stereo disparity matching error, in pixels (a typical sub-pixel figure). */
export const DISPARITY_NOISE = 0.25;
