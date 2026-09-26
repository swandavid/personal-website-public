/** Boulders and pebbles, instanced per shape variant and lit live by the sun. */
import {
  BufferAttribute,
  Color,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  Vector3,
} from "three";
import { sunlitAt } from "@/lib/rover/bake";
import { contactRadius } from "@/lib/rover/costmap";
import { rng, type Terrain } from "@/lib/rover/terrain";

const VARIANTS = 5;
const PEBBLES = 1800;
/** Grid cell (metres) for looking up rocks near a point. */
const CELL = 4;

function lumpy(v: Vector3, seed: number) {
  let n = 0;
  let f = 1.6;
  let a = 0.5;
  for (let o = 0; o < 3; o++) {
    n +=
      a *
      Math.sin(v.x * f + seed) *
      Math.sin(v.y * f * 1.3 + seed * 1.7) *
      Math.sin(v.z * f * 0.9 + seed * 2.3);
    f *= 2.2;
    a *= 0.5;
  }
  return n;
}

function rockGeometry(seed: number, detail: number) {
  const g = new IcosahedronGeometry(1, detail);
  const pos = g.getAttribute("position") as BufferAttribute;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + 0.3 * lumpy(v, seed));
    if (v.y < -0.1) v.y *= 0.35;
    v.y *= 0.8;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export class Rocks {
  readonly group = new Group();
  private geos = Array.from({ length: VARIANTS }, (_, i) =>
    rockGeometry(i * 7.31 + 1.1, 1),
  );
  private pebbleGeo = rockGeometry(3.3, 0);
  private mat = new MeshLambertMaterial({ flatShading: true });
  private meshes: InstancedMesh[] = [];
  private pebbles = new InstancedMesh(this.pebbleGeo, this.mat, PEBBLES);
  private grid = new Map<number, Terrain["rocks"]>();

  constructor() {
    this.group.add(this.pebbles);
  }

  /** Rebuild the instances from the terrain's rock list. */
  set(
    t: Terrain,
    sunlit: Float32Array,
    onGround: (x: number, y: number, lift: number) => Vector3,
  ) {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.dispose();
    }
    this.meshes = [];
    this.grid.clear();
    for (const r of t.rocks) {
      const key = Math.floor(r.x / CELL) * 1000 + Math.floor(r.y / CELL);
      const list = this.grid.get(key) ?? [];
      list.push(r);
      this.grid.set(key, list);
    }
    const random = rng(t.seed ^ 0x2c1b3c6d);
    const dummy = new Object3D();
    const tint = new Color();
    // Rocks are lit live by the sun, so darken the ones sitting in shadow.
    const shade = (x: number, y: number) =>
      0.2 + 0.8 * sunlitAt(t, sunlit, x, y);
    const groups: Terrain["rocks"][] = Array.from(
      { length: VARIANTS },
      () => [],
    );
    t.rocks.forEach((r, i) => groups[i % VARIANTS]!.push(r));
    groups.forEach((rocks, v) => {
      const mesh = new InstancedMesh(
        this.geos[v]!,
        this.mat,
        Math.max(1, rocks.length),
      );
      mesh.count = rocks.length;
      rocks.forEach((r, i) => {
        dummy.position.copy(onGround(r.x, r.y, r.h * 0.18));
        dummy.rotation.set(
          (random() - 0.5) * 0.3,
          random() * Math.PI * 2,
          (random() - 0.5) * 0.3,
        );
        // Drawn at the contact radius the physics uses: what you see is what it can hit.
        const w = contactRadius(r) / 1.2;
        dummy.scale.set(
          w * (0.92 + random() * 0.16),
          r.h * 1.25,
          w * (0.92 + random() * 0.16),
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Boulders are fresher rock than the weathered soil, so a touch brighter.
        const g = (0.17 + random() * 0.07) * shade(r.x, r.y);
        mesh.setColorAt(i, tint.setRGB(g, g * 0.985, g * 0.96));
      });
      this.meshes.push(mesh);
      this.group.add(mesh);
    });

    for (let i = 0; i < PEBBLES; i++) {
      const x = 1 + random() * (t.size - 3);
      const y = 1 + random() * (t.size - 3);
      const s = 0.05 + random() ** 2 * 0.12;
      dummy.position.copy(onGround(x, y, s * 0.2));
      dummy.rotation.set(random() * 3, random() * 3, random() * 3);
      dummy.scale.set(s, s * 0.8, s);
      dummy.updateMatrix();
      this.pebbles.setMatrixAt(i, dummy.matrix);
      const g = (0.15 + random() * 0.06) * shade(x, y);
      this.pebbles.setColorAt(i, tint.setRGB(g, g, g * 0.97));
    }
    this.pebbles.instanceMatrix.needsUpdate = true;
    if (this.pebbles.instanceColor)
      this.pebbles.instanceColor.needsUpdate = true;
  }

  /** Height of any rock surface under a point, so wheels climb small rocks. */
  heightAt = (x: number, y: number) => {
    let top = 0;
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        const list = this.grid.get(i * 1000 + j);
        if (!list) continue;
        for (const r of list) {
          const d = Math.hypot(x - r.x, y - r.y) / contactRadius(r);
          if (d < 1) top = Math.max(top, r.h * Math.sqrt(1 - d * d));
        }
      }
    }
    return top;
  };

  dispose() {
    this.meshes.forEach((m) => m.dispose());
    this.pebbles.dispose();
    this.geos.forEach((g) => g.dispose());
    this.pebbleGeo.dispose();
    this.mat.dispose();
  }
}
