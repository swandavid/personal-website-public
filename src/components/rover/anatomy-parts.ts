/**
 * The parts and wiring called out in the rover anatomy view. Shared by the
 * page (the part list and its text version) and the 3D view (hover labels).
 *
 * The design is generic and textbook: nothing here describes a real vehicle
 * or supplier. Each entry says what the part does, why it is built that way
 * (the public engineering reason, citing open standards where there is
 * one), and, where the simulation models it, the numbers the simulation
 * actually uses, read from the same constants the planner runs on.
 */
import { CAMERAS, DISPARITY_NOISE, VEHICLE } from "@/lib/rover/vehicle";

export type PartGroup =
  | "Sensing"
  | "Computing"
  | "Mobility"
  | "Power"
  | "Comms"
  | "Thermal"
  | "Wiring";

export interface Part {
  id: string;
  title: string;
  group: PartGroup;
  /** What it is and what it does. */
  body: string;
  /** Why it is built this way: the engineering reason behind the choice. */
  basis: string;
  /** What the simulation above models, from its own constants. */
  sim?: string;
  /** Parent part, for the chips on the flight computer board. */
  of?: string;
  /** Wire colour in the x-ray view, for wiring. */
  color?: string;
}

const deg = (r: number) => Math.round((r * 180) / Math.PI);
const cm = (m: number) => Math.round(m * 100);
const nav = CAMERAS.find((c) => c.id === "navcam")!;
const haz = CAMERAS.find((c) => c.id === "hazFront")!;

export const GROUPS: PartGroup[] = [
  "Sensing",
  "Computing",
  "Mobility",
  "Power",
  "Comms",
  "Thermal",
];

export const PARTS: Part[] = [
  // ---------- sensing ----------
  {
    id: "navcam",
    title: "Navigation stereo cameras",
    group: "Sensing",
    body: "Two identical cameras on a bar at the top of the mast. Each is a sealed box holding a black-and-white image sensor, its readout electronics and a fixed-focus lens behind a sunshade. Matching the left and right images shows how far each feature shifts between them, and that shift gives its distance.",
    basis:
      "Depth from stereo is focal length × baseline ÷ disparity, so a fixed matching error grows with the square of range; a wider baseline pushes that out. Navigation cameras are usually black and white because a colour filter throws away most of the light at each pixel. The sunshade matters near the poles, where the sun sits on the horizon.",
    sim: `${cm(nav.baseline)} cm apart, ${deg(nav.hfov)}° × ${deg(nav.vfov)}° view, ${nav.range} m range, ${VEHICLE.mastHeight} m up. Each point's depth gets the noise a ${DISPARITY_NOISE}-pixel matching error causes.`,
  },
  {
    id: "hazcams",
    title: "Hazard cameras",
    group: "Sensing",
    body: "Wide-angle stereo pairs low on the front and back panels, looking down at the ground right around the wheels. The camera bodies sit inside the heated box with only their lenses outside.",
    basis:
      "From the top of the mast the body hides the ground next to the wheels, so rovers commonly carry body-mounted fisheye pairs front and rear. The rear pair is what makes reversing safe.",
    sim: `${cm(haz.baseline)} cm apart, ${deg(haz.hfov)}° × ${deg(haz.vfov)}° view, ${haz.range} m range, front and rear.`,
  },
  {
    id: "imu",
    title: "Inertial measurement unit",
    group: "Sensing",
    body: "Three gyroscopes and three accelerometers in one block, bolted to the structure near the centre of mass. The gyros measure how fast the body turns; the accelerometers sense which way gravity pulls, which gives tilt while the rover is still.",
    basis:
      "Many space IMUs use fibre-optic gyroscopes: light sent both ways around a coil of fibre arrives slightly out of step when the coil turns (the Sagnac effect), with no moving parts to wear out. Mounting near the centre of mass keeps the body's rocking out of the readings.",
    sim: `Roll and pitch come from the four wheels' actual ground heights plus noise. It slows on slopes it feels and backs off at ${deg(VEHICLE.tipSlope) - 1.5}°, whatever the map said.`,
  },

  // ---------- computing ----------
  {
    id: "computer",
    title: "Flight computer board",
    group: "Computing",
    body: "A single board runs everything: perception, mapping, planning, driving and fault checks. There are no fans: in vacuum there is no air to move, so heat leaves through the board's metal frame and clamped edges into the chassis. Hover the chips for what each does.",
    basis:
      "Conduction cooling through the board edges, with wedge-lock clamps pressing them against a cold wall, is the standard way to cool electronics in vacuum.",
    sim: "In your browser the planner runs in a background worker while the page draws, much as flight software splits time-critical and heavy work.",
  },
  {
    id: "cpu",
    of: "computer",
    title: "Processor",
    group: "Computing",
    body: "A radiation-hardened processor running the flight software. It is many times slower than a phone's.",
    basis:
      "Hardening a chip and qualifying it for space takes years, so flight processors trail consumer ones by generations and run at a few hundred megahertz at most. That is why the planner searches a coarse grid and the cost map updates only the cells that change.",
    sim: `The planner searches a 1 m grid; the cost map changes only where new points land.`,
  },
  {
    id: "fpga",
    of: "computer",
    title: "Vision FPGA",
    group: "Computing",
    body: "Reconfigurable logic that does the heavy, repetitive image work in hardware: straightening the stereo images and matching them into disparity maps, so the processor receives finished 3D points.",
    basis:
      "Stereo matching is the same small comparison repeated for every pixel, which suits parallel hardware. A particle strike can flip a bit of an FPGA's configuration, so it is checked and rewritten in the background, or a type whose configuration can't flip is used.",
  },
  {
    id: "memory",
    of: "computer",
    title: "Memory with error correction",
    group: "Computing",
    body: "Working memory for the map, the cost map and the images being processed. Every word carries extra check bits.",
    basis:
      "A charged particle can deposit enough charge to flip a stored bit. Error-correcting codes repair a single flipped bit per word, and a background scrubber rereads and rewrites memory so flips don't pile up into ones the code can't fix.",
  },
  {
    id: "storage",
    of: "computer",
    title: "Non-volatile storage",
    group: "Computing",
    body: "Flash memory that survives power cycles: more than one copy of the flight software, plus logs and images waiting for the next contact with Earth.",
    basis:
      "If a software update or a radiation hit corrupts one copy, the computer can boot a known-good one. Keeping a protected fallback image is standard practice.",
  },
  {
    id: "watchdog",
    of: "computer",
    title: "Watchdog",
    group: "Computing",
    body: "A small, independent timer that resets the processor if the software stops checking in, then lets the rover come back up in a safe mode.",
    basis:
      "Hangs happen, and there is no one to press reset. A hardware watchdog is the last line of defence and one of the oldest patterns in embedded systems.",
    sim: "The simulated rover has a software version: if it stops making progress for several seconds, it stops, backs up and replans.",
  },

  // ---------- mobility ----------
  {
    id: "motorControllers",
    title: "Motor controller boards",
    group: "Mobility",
    body: "Two boards, one per side, each driving that side's wheel and steering motors plus one pointing mechanism. A controller chip runs the current, speed and position loops; rows of power transistors switch battery power into each motor's three windings.",
    basis:
      "Brushless motors need electronic commutation: the controller energises the windings in turn based on where the shaft is. Keeping the power electronics in the heated box, with long shielded cables out to cold motors, is a common choice because the motors tolerate cold far better than the electronics.",
  },
  {
    id: "driveMotors",
    title: "Wheel drive actuators",
    group: "Mobility",
    body: "A brushless motor and a high-ratio gearbox inside each wheel hub, with a resolver reporting the shaft angle.",
    basis:
      "Strain-wave (harmonic) gears are common in space actuators: a large reduction with almost no backlash in a small package. Resolvers are plain windings with no electronics at the motor, so they survive cold and radiation. Lubricant that works in vacuum and cold is a design driver, and actuators often need heaters before they move.",
  },
  {
    id: "steering",
    title: "Steering actuators",
    group: "Mobility",
    body: "A steering actuator above each wheel turns it about a vertical axis. With all four wheels angled around a common centre the rover can turn on the spot.",
    basis:
      "Turning in place with steered wheels scrubs far less than skid steering, which wastes energy and digs into loose soil.",
    sim: "The rover turns in place to square up to its route before driving, and whenever a move would put a wheel on known no-go ground.",
  },
  {
    id: "wheels",
    title: "Wheels and suspension",
    group: "Mobility",
    body: "Four open woven-mesh wheels with flexible spokes, each on its own pair of arms so all four stay on the ground over uneven terrain.",
    basis:
      "Mesh wheels are light and let fine dust fall through instead of packing. A wheeled rover of this kind can climb a step of roughly one wheel radius; beyond that it needs more elaborate suspension.",
    sim: `Wheel radius ${cm(VEHICLE.wheelRadius)} cm, so steps over ${cm(VEHICLE.maxStep)} cm are no-go. Planned routes stay under ${deg(VEHICLE.maxSlope)}° and the body refuses ground past ${deg(VEHICLE.tipSlope)}°.`,
  },
  {
    id: "mastActuators",
    title: "Mast pan and tilt",
    group: "Mobility",
    body: "Two actuators at the top of the mast aim the navigation cameras: one turns the head left and right, one tips it up and down. Cables cross the pan joint in a coiled wrap.",
    basis:
      "A cable wrap limits how far the head can turn but avoids the wear and electrical noise of a slip ring, which is why pointing mechanisms with a limited range usually use one.",
    sim: "The head pans to look along the route ahead and sweeps side to side while the rover waits.",
  },

  // ---------- power ----------
  {
    id: "battery",
    title: "Battery",
    group: "Power",
    body: "Lithium-ion cells in series strings, with cell balancing, temperature sensors and heaters. Mounted low and at the back to balance the mast.",
    basis:
      "Charging lithium-ion cells below freezing plates lithium metal onto the electrode and damages them, so space batteries are kept warm and charged only within a temperature window.",
  },
  {
    id: "pdu",
    title: "Power distribution unit",
    group: "Power",
    body: "Takes power from the arrays and battery, regulates it onto one bus and switches it out to every device through its own protected output, so a short in one device can't bring down the rover.",
    basis:
      "A regulated 28 V bus is a long-standing spacecraft standard. Solid-state switches with current limits act as resettable fuses the flight software can also turn on and off.",
  },
  {
    id: "solar",
    title: "Solar arrays",
    group: "Power",
    body: "Mounted upright on both sides of the body.",
    basis:
      "The Moon's axis is tilted only about 1.5°, so near the poles the sun always sits within a degree or two of the horizon. Upright panels catch that low light; flat ones on the deck would barely see it.",
  },

  // ---------- comms ----------
  {
    id: "radio",
    title: "Radio transceiver",
    group: "Comms",
    body: "Turns telemetry and images into radio signals and decodes commands and goals from Earth. A short low-gain antenna on the back deck works in any direction at low data rates, as a backup.",
    basis:
      "Signals take a couple of seconds to make the round trip, and contact windows are limited, so the rover must plan and drive between check-ins on its own. That is why it navigates autonomously at all.",
  },
  {
    id: "hga",
    title: "High-gain antenna",
    group: "Comms",
    body: "A dish on a two-axis gimbal that points at Earth for high-rate links.",
    basis:
      "The Moon keeps one face toward Earth, so from the near side Earth hangs almost fixed in the sky, wobbling by a few degrees. The gimbal mostly has to make up for the rover's own heading and tilt.",
  },

  // ---------- thermal ----------
  {
    id: "web",
    title: "Warm electronics box",
    group: "Thermal",
    body: "The chassis is an insulated box on an aluminium frame. Everything that can't take the cold lives inside it, wrapped in gold multi-layer insulation underneath.",
    basis:
      "Lunar night lasts about 14 Earth days and drops well below −150 °C. Multi-layer insulation, many thin sheets of aluminised film separated by netting, blocks radiated heat, which is how heat moves in vacuum.",
  },
  {
    id: "radiator",
    title: "Radiator deck",
    group: "Thermal",
    body: "The finned white top deck sheds the electronics' waste heat to space.",
    basis:
      "In vacuum, heat leaves only by radiating it. White paint absorbs little sunlight but gives off infrared well, so a white panel facing the sky stays cool in sunlight.",
  },

  // ---------- wiring ----------
  {
    id: "power",
    title: "Power harness",
    group: "Wiring",
    color: "#ff5d52",
    body: "Heavy wires from the arrays and battery into the distribution unit, and a switched feed from it to every device.",
    basis:
      "Current sets the wire size, so power lines are the thickest in the harness. Supply and return run as twisted pairs so their magnetic fields cancel.",
  },
  {
    id: "motor",
    title: "Motor drive cables",
    group: "Wiring",
    color: "#ff9f1c",
    body: "Three-phase motor power plus resolver feedback from the controller boards to each actuator. They leave the body along the suspension arms, with slack loops across every joint that moves.",
    basis:
      "Fast-switched motor currents are the harness's loudest source of electrical noise, so these cables are twisted and shielded and routed apart from camera and sensor lines.",
  },
  {
    id: "spacewire",
    title: "SpaceWire links",
    group: "Wiring",
    color: "#4cc9f0",
    body: "Point-to-point serial links carrying the hazard cameras' images to the vision FPGA.",
    basis:
      "SpaceWire is an open European space standard (ECSS-E-ST-50-12C) built for spacecraft instruments: each cable carries four twisted pairs, data and strobe in each direction, at a few to a few hundred megabits per second, and routers can join links into a network.",
  },
  {
    id: "fibre",
    title: "Optical fibre",
    group: "Wiring",
    color: "#ffd84d",
    body: "Fibre carries the mast cameras' images down the mast and through the pan joint's cable wrap to the vision FPGA.",
    basis:
      "Light instead of current: immune to the motors' electrical noise, electrically isolating and light for its bandwidth. The costs are handling: a minimum bend radius, spotless connectors, and fibre that slowly darkens under radiation, so radiation-tolerant fibre is used. Yellow is the standard jacket colour for single-mode fibre.",
  },
  {
    id: "ethernet",
    title: "Ethernet",
    group: "Wiring",
    color: "#7bd88f",
    body: "Links the flight computer to the radio, and to a test port on the back panel used on the ground.",
    basis:
      "Ethernet is increasingly flown because chips, tools and test gear are everywhere. Time-triggered variants (SAE AS6802) reserve fixed time slots so critical traffic always gets through.",
  },
  {
    id: "serial",
    title: "RS-422 serial",
    group: "Wiring",
    color: "#c792ea",
    body: "Low-rate command and telemetry links to the IMU, the power unit and the motor controllers.",
    basis:
      "RS-422 (TIA-422) sends each signal as a voltage difference on a pair of wires, so noise that hits both wires equally cancels out. Simple, old and very tolerant: well suited to links that must never glitch.",
  },
];

export const WIRES = PARTS.filter((p) => p.group === "Wiring");
