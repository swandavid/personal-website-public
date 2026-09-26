/** Flat markers draped over the terrain, built from simple 2D shapes. */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Mesh,
  type MeshBasicMaterial,
  type Vector3,
} from "three";

interface Shape {
  verts: number[];
  index: number[];
}

/** A flat shape draped over the terrain: local 2D vertices, lifted off the ground. */
export class Drape {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private local: Float32Array;
  constructor(
    { verts, index }: Shape,
    material: MeshBasicMaterial,
    private lift = 0.07,
  ) {
    this.local = new Float32Array(verts);
    const geo = new BufferGeometry();
    geo.setAttribute(
      "position",
      new BufferAttribute(new Float32Array((verts.length / 2) * 3), 3).setUsage(
        DynamicDrawUsage,
      ),
    );
    geo.setIndex(index);
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
  }
  place(
    to: (x: number, y: number, lift: number) => Vector3,
    x: number,
    y: number,
  ) {
    const pos = this.mesh.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const v = to(
        x + this.local[i * 2]!,
        y + this.local[i * 2 + 1]!,
        this.lift,
      );
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
  }
}

/** Annulus, optionally in dashes. */
export function annulus(
  inner: number,
  outer: number,
  segments = 56,
  dashes = 0,
): Shape {
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    verts.push(Math.cos(a) * inner, Math.sin(a) * inner);
    verts.push(Math.cos(a) * outer, Math.sin(a) * outer);
    if (i === segments) break;
    if (dashes && Math.floor((i / segments) * dashes * 2) % 2) continue;
    const k = i * 2;
    index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  return { verts, index };
}

export function disc(r: number, segments = 20): Shape {
  const verts = [0, 0];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    verts.push(Math.cos(a) * r, Math.sin(a) * r);
    if (i) index.push(0, i, i + 1);
  }
  return { verts, index };
}

export function merge(...parts: Shape[]): Shape {
  const verts: number[] = [];
  const index: number[] = [];
  for (const p of parts) {
    const base = verts.length / 2;
    verts.push(...p.verts);
    index.push(...p.index.map((i) => i + base));
  }
  return { verts, index };
}

/** A short radial bar, for the goal marker's ticks. */
export function tick(angle: number, from: number, to: number, w: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const px = -s * w;
  const py = c * w;
  return {
    verts: [
      c * from + px,
      s * from + py,
      c * from - px,
      s * from - py,
      c * to + px,
      s * to + py,
      c * to - px,
      s * to - py,
    ],
    index: [0, 1, 2, 1, 3, 2],
  };
}
