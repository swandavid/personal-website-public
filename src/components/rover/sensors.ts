/**
 * Each camera's view traced on the ground as edges plus a faint fill, and the
 * recent stereo point cloud in a ring buffer that only uploads new slots.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Points,
  ShaderMaterial,
  type Vector3,
} from "three";
import type { Mission } from "@/lib/rover/mission";
import { Perception, type PointCloud } from "@/lib/rover/perception";
import { heightAt, type Terrain } from "@/lib/rover/terrain";
import { CAMERAS } from "@/lib/rover/vehicle";

/** Seconds a stereo point stays on screen, fading out. */
export const POINT_FADE_S = 2.2;
/** Samples along each edge of a camera's image when drawing its view. */
const EDGE_SAMPLES = 10;

/** Point colours by camera (index into CAMERAS). */
const COLOURS = [new Color(0x7fe6ff), new Color(0xffd27a), new Color(0xffd27a)];

export class Sensors {
  readonly group = new Object3D();
  private viewLines: LineSegments<BufferGeometry, LineBasicMaterial>[] = [];
  private viewFills: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
  private cloud: Points<BufferGeometry, ShaderMaterial>;
  private synced = 0;
  private uniforms = { uTime: { value: 0 }, uScale: { value: 1 } };

  constructor() {
    CAMERAS.forEach((cam, ci) => {
      const n = EDGE_SAMPLES * 4;
      const lines = new LineSegments(
        new BufferGeometry().setAttribute(
          "position",
          new BufferAttribute(new Float32Array((n + 4) * 2 * 3), 3).setUsage(
            DynamicDrawUsage,
          ),
        ),
        new LineBasicMaterial({
          transparent: true,
          opacity: cam.pans ? 0.6 : 0.3,
          toneMapped: false,
          depthWrite: false,
        }),
      );
      const fill = new Mesh(
        new BufferGeometry()
          .setAttribute(
            "position",
            new BufferAttribute(new Float32Array((n + 1) * 3), 3).setUsage(
              DynamicDrawUsage,
            ),
          )
          .setIndex(
            Array.from({ length: n }, (_, i) => [
              0,
              i + 1,
              ((i + 1) % n) + 1,
            ]).flat(),
          ),
        new MeshBasicMaterial({
          transparent: true,
          opacity: cam.pans ? 0.07 : 0,
          toneMapped: false,
          depthWrite: false,
          side: DoubleSide,
          blending: AdditiveBlending,
        }),
      );
      lines.material.color.copy(COLOURS[ci]!);
      fill.material.color.copy(COLOURS[ci]!);
      lines.frustumCulled = fill.frustumCulled = false;
      fill.visible = cam.pans;
      this.viewLines.push(lines);
      this.viewFills.push(fill);
      this.group.add(fill, lines);
    });

    const cap = 24000;
    const geo = new BufferGeometry();
    geo.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(cap * 3), 3).setUsage(
        DynamicDrawUsage,
      ),
    );
    geo.setAttribute(
      "aBirth",
      new BufferAttribute(new Float32Array(cap).fill(-1e3), 1).setUsage(
        DynamicDrawUsage,
      ),
    );
    geo.setAttribute(
      "aColor",
      new BufferAttribute(new Float32Array(cap * 3), 3).setUsage(
        DynamicDrawUsage,
      ),
    );
    this.cloud = new Points(
      geo,
      new ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        vertexShader: `
uniform float uTime, uScale;
attribute float aBirth;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aBirth;
  vAlpha = clamp(1.0 - age / ${POINT_FADE_S.toFixed(1)}, 0.0, 1.0) * 0.6;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(uScale * 30.0 / -mv.z, 1.0, 2.6 * uScale);
  gl_Position = projectionMatrix * mv;
  if (vAlpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
        fragmentShader: `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  gl_FragColor = vec4(vColor * vAlpha * (1.0 - d * 2.5), 1.0);
}`,
      }),
    );
    this.cloud.frustumCulled = false;
    this.group.add(this.cloud);
  }

  /** Point size follows the renderer's pixel ratio. */
  setScale(ratio: number) {
    this.uniforms.uScale.value = ratio;
  }

  /** Forget the cloud on the next sync (a new world). */
  reset() {
    this.synced = Infinity;
  }

  /** Trace each camera's image border onto the terrain. */
  updateViews(
    m: Mission,
    terrain: Terrain,
    toScene: (x: number, y: number, h: number) => Vector3,
  ) {
    const p = m.perception;
    const pose = { x: m.pos.x, y: m.pos.y, heading: m.heading, pan: m.pan };
    CAMERAS.forEach((cam, ci) => {
      const o = Perception.mount(terrain, cam, pose);
      const border: Vector3[] = [];
      const edge = (u: number, v: number) => {
        const el = -cam.pitch + v * cam.vfov;
        const az = o.yaw + u * cam.hfov;
        const ce = Math.cos(el);
        const dx = ce * Math.cos(az);
        const dy = ce * Math.sin(az);
        const dz = Math.sin(el);
        const t = p.cast(o.x, o.y, o.z, dx, dy, dz, cam.range);
        // Rays that reach no ground within range end on the ground at range.
        const r = t < 0 ? cam.range * ce : t * ce;
        const gx = o.x + Math.cos(az) * r;
        const gy = o.y + Math.sin(az) * r;
        border.push(
          toScene(
            gx,
            gy,
            (t < 0 ? heightAt(terrain, gx, gy) : o.z + dz * t) + 0.06,
          ),
        );
      };
      const k = EDGE_SAMPLES;
      for (let i = 0; i < k; i++) edge(-0.5 + i / k, -0.5);
      for (let i = 0; i < k; i++) edge(0.5, -0.5 + i / k);
      for (let i = 0; i < k; i++) edge(0.5 - i / k, 0.5);
      for (let i = 0; i < k; i++) edge(-0.5, 0.5 - i / k);
      const eye = toScene(o.x, o.y, o.z);

      const lines = this.viewLines[ci]!.geometry.getAttribute(
        "position",
      ) as BufferAttribute;
      let w = 0;
      const seg = (a: Vector3, b: Vector3) => {
        lines.setXYZ(w++, a.x, a.y, a.z);
        lines.setXYZ(w++, b.x, b.y, b.z);
      };
      border.forEach((b, i) => seg(b, border[(i + 1) % border.length]!));
      for (let c = 0; c < 4; c++) seg(eye, border[c * k]!);
      lines.needsUpdate = true;

      const fill = this.viewFills[ci]!.geometry.getAttribute(
        "position",
      ) as BufferAttribute;
      fill.setXYZ(0, eye.x, eye.y, eye.z);
      border.forEach((b, i) => fill.setXYZ(i + 1, b.x, b.y, b.z));
      fill.needsUpdate = true;
    });
  }

  /** Copy points added since the last sync into the GPU buffer. */
  syncCloud(cloud: PointCloud, time: number, offset: number): void {
    this.uniforms.uTime.value = time;
    const cap = cloud.capacity;
    const geo = this.cloud.geometry;
    const pos = geo.getAttribute("position") as BufferAttribute;
    const birth = geo.getAttribute("aBirth") as BufferAttribute;
    const col = geo.getAttribute("aColor") as BufferAttribute;
    const from = Math.max(this.synced, cloud.total - cap);
    if (cloud.total < this.synced) {
      // A new mission: forget the old cloud.
      (birth.array as Float32Array).fill(-1e3);
      birth.clearUpdateRanges();
      birth.needsUpdate = true;
      this.synced = 0;
      return this.syncCloud(cloud, time, offset);
    }
    if (from >= cloud.total) return;
    for (let n = from; n < cloud.total; n++) {
      const k = n % cap;
      // Draw every other point: plenty to read the cloud, half the clutter.
      if (n & 1) {
        birth.setX(k, -1e3);
        continue;
      }
      const x = cloud.xyz[k * 3]!;
      const y = cloud.xyz[k * 3 + 1]!;
      const z = cloud.xyz[k * 3 + 2]!;
      pos.setXYZ(k, x - offset, z + 0.04, y - offset);
      // Stagger births across the frame interval so frames don't pulse.
      birth.setX(k, time - ((cloud.total - n) / (cloud.total - from)) * 0.1);
      const c = COLOURS[cloud.source[k]!]!;
      col.setXYZ(k, c.r, c.g, c.b);
    }
    for (const a of [pos, birth, col]) {
      a.clearUpdateRanges();
      const s = from % cap;
      const e = cloud.total % cap || cap;
      const size = a.itemSize;
      if (e > s) a.addUpdateRange(s * size, (e - s) * size);
      else {
        a.addUpdateRange(s * size, (cap - s) * size);
        a.addUpdateRange(0, e * size);
      }
      a.needsUpdate = true;
    }
    this.synced = cloud.total;
  }
}
