/**
 * The page's "Inside the rover" view: a high-detail model of the rover with
 * two looks. X-ray turns the body panels, deck and arrays to a glowing
 * outline so the avionics, actuators and harness show through; Flight shows
 * the vehicle as built, harness in its real white. Hovering (or tapping,
 * or picking from the list) a part lights it, pulses the wires that serve
 * it and explains it; cameras also show their field of view.
 *
 * Draws only while something changes: the turntable spin, a drag or zoom
 * (including damping afterwards), or a pulsing wire. Pauses off screen.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CAMERAS, type CameraSpec } from "@/lib/rover/vehicle";
import { accentColor } from "./accent";
import { buildRover } from "./anatomy-model";
import { HEAD } from "./anatomy-routes";
import { PARTS, type Part } from "./anatomy-parts";

const XRAY = new Color(0x9fd8ff);
type Mode = "xray" | "flight";

/** Field-of-view pyramid for a camera, in the body frame, `length` metres long. */
function viewCone(cam: CameraSpec, origin: Vector3, length: number) {
  const dir = (u: number, v: number) => {
    const el = -cam.pitch + v * cam.vfov;
    const az = cam.yaw + u * cam.hfov;
    return new Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
    ).multiplyScalar(length);
  };
  const corners = [
    dir(-0.5, -0.5),
    dir(0.5, -0.5),
    dir(0.5, 0.5),
    dir(-0.5, 0.5),
  ].map((d) => d.add(origin));
  const pts: number[] = [];
  const seg = (a: Vector3, b: Vector3) =>
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  corners.forEach((c, i) => {
    seg(origin, c);
    seg(c, corners[(i + 1) % 4]!);
  });
  return new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(pts, 3),
  );
}

const xrayMaterial = (color: Color, strength: number) =>
  new ShaderMaterial({
    uniforms: { uColor: { value: color }, uStrength: { value: strength } },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    vertexShader: `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `
uniform vec3 uColor;
uniform float uStrength;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
  gl_FragColor = vec4(uColor * (0.012 + rim * 0.34) * uStrength, 1.0);
}`,
  });

export function mountAnatomy(root: HTMLElement, onReady: () => void) {
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const canvas = $<HTMLCanvasElement>("[data-anatomy-canvas]");
  const tip = $<HTMLElement>("[data-tip]");
  const field = (name: string) => $<HTMLElement>(`[data-tip-${name}]`);
  const tipEls = {
    group: field("group"),
    title: field("title"),
    body: field("body"),
    basis: field("basis"),
    sim: field("sim"),
    links: field("links"),
  };
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-part]")];
  const modeButtons = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-mode]"),
  ];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const listeners = new AbortController();
  const { signal } = listeners;

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x040506, 1);
  renderer.toneMapping = NeutralToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // Nothing moves relative to the light, so the shadow map is drawn once.
  renderer.shadowMap.autoUpdate = false;
  renderer.debug.checkShaderErrors = import.meta.env.DEV;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.55;

  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(4.7, 2.9, 4.3);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.9, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.minDistance = 2.2;
  controls.maxDistance = 11;
  controls.maxPolarAngle = 1.64;
  controls.autoRotate = !reduced.matches;
  controls.autoRotateSpeed = 0.7;
  controls.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE };
  canvas.style.touchAction = "pan-y";

  // Low sun from one side, as near the lunar poles, plus a soft fill.
  const sun = new DirectionalLight(0xfff8ee, 2.6);
  sun.position.set(4, 3.4, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -3;
  sun.shadow.camera.right = sun.shadow.camera.top = 3;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, new HemisphereLight(0xdfe8ff, 0x1a1c20, 0.5));

  // Floor: a faint ring grid and the rover's shadow.
  const floor = new Mesh(
    new CircleGeometry(4.5, 64).rotateX(-Math.PI / 2),
    new ShadowMaterial({ opacity: 0.5 }),
  );
  floor.receiveShadow = true;
  const rings: number[] = [];
  for (const r of [1, 2, 3, 4]) {
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const b = ((i + 1) / 96) * Math.PI * 2;
      rings.push(
        Math.cos(a) * r,
        0.002,
        Math.sin(a) * r,
        Math.cos(b) * r,
        0.002,
        Math.sin(b) * r,
      );
    }
  }
  const grid = new LineSegments(
    new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute(rings, 3),
    ),
    new LineBasicMaterial({ color: 0x2a3038, transparent: true, opacity: 0.6 }),
  );
  scene.add(floor, grid);

  const accent = accentColor().color;
  const built = buildRover();
  scene.add(built.root);
  const { meshes, wireUniforms } = built;
  const shells = meshes.filter((m) => m.userData.shell);
  const solids = meshes.filter((m) => !m.userData.shell);
  const xray = xrayMaterial(XRAY.clone(), 1);
  const xrayHot = xrayMaterial(accent.clone(), 2.6);

  // Fields of view, shown while a camera part is active.
  const cone = (cam: CameraSpec, origin: Vector3) => {
    const lines = new LineSegments(
      viewCone(cam, origin, cam.pans ? 3.2 : 1.6),
      new LineBasicMaterial({
        color: cam.pans ? 0x7fe6ff : 0xffd27a,
        transparent: true,
        opacity: 0.8,
        toneMapped: false,
      }),
    );
    lines.visible = false;
    built.root.add(lines);
    return lines;
  };
  const [hx, hy] = HEAD;
  const cones: Record<string, Object3D[]> = {
    navcam: [
      cone(
        CAMERAS.find((c) => c.id === "navcam")!,
        new Vector3(hx + 0.24, hy + 0.04, 0),
      ),
    ],
    hazcams: [
      cone(
        CAMERAS.find((c) => c.id === "hazFront")!,
        new Vector3(1.08, -0.08, 0),
      ),
      cone(
        CAMERAS.find((c) => c.id === "hazRear")!,
        new Vector3(-1.08, -0.08, 0),
      ),
    ],
  };

  const part = (id: string) => PARTS.find((p) => p.id === id)!;
  const isWire = (id: string) => part(id).group === "Wiring";

  // ---------- modes ----------

  let mode: Mode = "xray";
  const setMode = (m: Mode) => {
    mode = m;
    wireUniforms.uReal.value = m === "flight" ? 1 : 0;
    modeButtons.forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === m)),
    );
    paint();
  };

  // ---------- highlighting ----------

  let active: string | null = null;
  /** Wires that serve a part, or every run of a bus. */
  const litRoutes = (id: string) => {
    const key = part(id).of ?? id;
    return built.routes.map((r) =>
      isWire(key) ? r.bus === key : r.ends.includes(key),
    );
  };

  function paint() {
    const family = active ? part(active) : null;
    const lit = active ? litRoutes(active) : [];
    wireUniforms.uLit.value.fill(0);
    lit.forEach((on, i) => (wireUniforms.uLit.value[i] = on ? 1 : 0));
    wireUniforms.uAny.value = active ? 1 : 0;
    for (const m of meshes) {
      const id = m.userData.part;
      const exact = !!id && id === active;
      // The board lights faintly with a chip, and chips with the board.
      const near =
        !!id && !!active && (part(id)?.of === active || family?.of === id);
      if (m.userData.shell && mode === "xray") {
        m.material = exact ? xrayHot : xray;
        m.castShadow = false;
      } else {
        m.material = m.userData.flight;
        m.castShadow = true;
        m.userData.flight.emissive
          .copy(m.userData.emissive)
          .lerp(accent, exact ? 0.55 : near ? 0.16 : 0);
      }
    }
    // Dim the x-ray skin while something is picked so it stands out.
    xray.uniforms.uStrength!.value = active ? 0.55 : 1;
    for (const [id, list] of Object.entries(cones))
      list.forEach((o) => (o.visible = active === id));
    buttons.forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.part === active || b.dataset.part === family?.of),
      ),
    );
    renderer.shadowMap.needsUpdate = true;
    wake();
  }

  const setActive = (id: string | null) => {
    if (id === active) return;
    active = id;
    paint();
  };

  const linkText = (p: Part) => {
    if (isWire(p.id)) {
      // Grouped by source: "Motor controller boards → steering, drive…"
      const from = new Map<string, Set<string>>();
      for (const r of built.routes.filter((r) => r.bus === p.id)) {
        const [a, b] = r.ends.map((e) => part(e).title);
        if (!from.has(a!)) from.set(a!, new Set());
        from.get(a!)!.add(b!.toLowerCase());
      }
      return [...from]
        .map(([a, bs]) => `${a} → ${[...bs].join(", ")}`)
        .join(". ");
    }
    const key = p.of ?? p.id;
    const buses = [
      ...new Set(
        built.routes.filter((r) => r.ends.includes(key)).map((r) => r.bus),
      ),
    ];
    return buses.map((b) => part(b).title).join(" · ");
  };

  const showTip = (
    p: Part | null,
    at?: { x: number; y: number },
    from: "pointer" | "list" | "focus" = "pointer",
  ) => {
    if (!p) {
      tip.hidden = true;
      return;
    }
    // Announce only what keyboard focus opens, not every part hovered.
    tip.setAttribute("aria-live", from === "focus" ? "polite" : "off");
    tipEls.group.textContent = p.of
      ? `${p.group} · on the flight computer`
      : p.group;
    tipEls.title.textContent = p.title;
    tipEls.body.textContent = p.body;
    tipEls.basis.textContent = p.basis;
    tipEls.sim.textContent = p.sim ?? "";
    tipEls.sim.parentElement!.hidden = !p.sim;
    const links = linkText(p);
    tipEls.links.textContent = links;
    tipEls.links.parentElement!.hidden = !links;
    tipEls.links.previousElementSibling!.textContent = isWire(p.id)
      ? "Connects"
      : "Wiring";
    tip.hidden = false;
    if (getComputedStyle(tip).position === "static") return;
    const r = canvas.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x: number;
    let y: number;
    if (from === "pointer" && at) {
      // Beside the pointer, on whichever side has room.
      x =
        at.x + 18 + w < r.width - 12 ? at.x + 18 : Math.max(12, at.x - w - 18);
      y = Math.min(r.height - h - 12, at.y - h / 2);
    } else {
      // From the list: in the top corner away from the part.
      x = !at || at.x > r.width / 2 ? 12 : r.width - w - 12;
      y = 12;
    }
    tip.style.transform = `translate(${x}px, ${Math.max(12, y)}px)`;
  };

  /** Screen position of a part's centre, for tips opened from the list. */
  const centres = new Map<string, Vector3>();
  for (const m of [...meshes, ...built.wireHits]) {
    const id = m.userData.part as string | null;
    if (!id || centres.has(id)) continue;
    m.geometry.computeBoundingBox();
    centres.set(
      id,
      m.geometry.boundingBox!.getCenter(new Vector3()).add(built.root.position),
    );
  }
  const anchor = (id: string) => {
    const c = centres.get(id);
    if (!c) return undefined;
    const v = c.clone().project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  };

  // ---------- picking ----------

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const solidTargets: Object3D[] = [...solids, ...built.wireHits];
  const allTargets: Object3D[] = [...meshes, ...built.wireHits];
  const pick = (clientX: number, clientY: number): Part | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const first = (targets: Object3D[]) => {
      for (const h of raycaster.intersectObjects(targets, false)) {
        const id = h.object.userData.part as string | null;
        // In flight view the skin hides what's behind it.
        if (!id) return mode === "flight" ? null : undefined;
        return part(id);
      }
      return undefined;
    };
    if (mode === "flight") return first(allTargets) ?? null;
    // X-ray: what's inside wins over the skin around it.
    return first(solidTargets) ?? first(shells) ?? null;
  };

  let pointerAt: { x: number; y: number } | null = null;
  let pickQueued = false;
  let pinned = false;
  let pickFrame = 0;
  const onPointer = () => {
    pickQueued = false;
    if (!pointerAt || pinned) return;
    const r = canvas.getBoundingClientRect();
    const p = pick(pointerAt.x, pointerAt.y);
    setActive(p?.id ?? null);
    showTip(p, { x: pointerAt.x - r.left, y: pointerAt.y - r.top });
  };
  let pressed = false;
  canvas.addEventListener(
    "pointermove",
    (e) => {
      if (pressed || e.pointerType !== "mouse") return;
      pointerAt = { x: e.clientX, y: e.clientY };
      if (!pickQueued) {
        pickQueued = true;
        pickFrame = requestAnimationFrame(onPointer);
      }
    },
    { signal },
  );
  canvas.addEventListener(
    "pointerleave",
    () => {
      pointerAt = null;
      if (pinned) return;
      setActive(null);
      showTip(null);
    },
    { signal },
  );
  let down = { x: 0, y: 0 };
  canvas.addEventListener(
    "pointerdown",
    (e) => {
      down = { x: e.clientX, y: e.clientY };
      pressed = true;
    },
    { signal },
  );
  const onUp = (e: PointerEvent) => {
    if (!pressed) return;
    pressed = false;
    if (e.target !== canvas) return;
    // A click or tap (not a drag) selects, and keeps the selection until
    // the next click; clicking empty space clears it.
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const r = canvas.getBoundingClientRect();
    const p = pick(e.clientX, e.clientY);
    pinned = !!p;
    setActive(p?.id ?? null);
    showTip(p, { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  window.addEventListener("pointerup", onUp, { signal });

  for (const b of buttons) {
    const id = b.dataset.part!;
    const open = (from: "list" | "focus" = "list") => {
      setActive(id);
      showTip(part(id), anchor(id), from);
    };
    const close = () => {
      if (pinned) return;
      setActive(null);
      showTip(null);
    };
    // Hover only for a real mouse: a tap's emulated hover would open the tip,
    // shift the layout and make the tap's click miss.
    b.addEventListener(
      "pointerenter",
      (e) => {
        if (e.pointerType === "mouse" && !pinned) open();
      },
      { signal },
    );
    b.addEventListener(
      "pointerleave",
      (e) => {
        if (e.pointerType === "mouse" && document.activeElement !== b) close();
      },
      { signal },
    );
    b.addEventListener("focus", () => open("focus"), { signal });
    b.addEventListener(
      "click",
      () => {
        pinned = false;
        open();
      },
      { signal },
    );
    b.addEventListener("blur", close, { signal });
  }
  for (const b of modeButtons)
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode), {
      signal,
    });

  // ---------- frame loop ----------

  let raf = 0;
  let visible = true;
  let ready = false;
  let interacting = false;
  let last = performance.now();
  const animating = () =>
    controls.autoRotate || interacting || (!!active && !reduced.matches);
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    wireUniforms.uTime.value += dt;
    const moved = controls.update(dt);
    renderer.render(scene, camera);
    raf = visible && (moved || animating()) ? requestAnimationFrame(frame) : 0;
  };
  function wake() {
    if (!raf && visible && ready) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  // OrbitControls moves the camera inside its own pointer and wheel
  // handlers, so a render has to follow every change, not just our loop.
  controls.addEventListener("change", wake);
  controls.addEventListener("start", () => {
    interacting = true;
    controls.autoRotate = false;
    if (!pinned) showTip(null);
    wake();
  });
  controls.addEventListener("end", () => {
    interacting = false;
  });
  reduced.addEventListener(
    "change",
    () => {
      if (reduced.matches) controls.autoRotate = false;
      wake();
    },
    { signal },
  );

  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = width < 520 ? 38 : 30;
    camera.updateProjectionMatrix();
    wake();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) wake();
  });
  io.observe(canvas);
  resize();
  setMode("xray");

  // Compile every shader before the first frame so turning the model never
  // stalls on a first-use compile (and doesn't block the page meanwhile).
  let disposed = false;
  const prepare = async () => {
    // Both looks, so switching modes is instant too.
    for (const s of shells) s.material = s.userData.flight;
    await renderer.compileAsync(scene, camera);
    for (const s of shells) s.material = xray;
    await renderer.compileAsync(scene, camera);
  };
  prepare()
    .catch(() => undefined)
    .then(() => {
      if (disposed) return;
      paint();
      ready = true;
      onReady();
      wake();
    });

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(pickFrame);
    listeners.abort();
    ro.disconnect();
    io.disconnect();
    controls.dispose();
    built.dispose();
    xray.dispose();
    xrayHot.dispose();
    env.dispose();
    for (const o of [floor, grid, ...Object.values(cones).flat()]) {
      const m = o as Mesh;
      m.geometry.dispose();
      (m.material as Material).dispose();
    }
    sun.shadow.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };
}
