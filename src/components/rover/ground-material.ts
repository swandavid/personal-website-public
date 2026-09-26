/**
 * The terrain's material. Lighting was baked in the worker, so it stays
 * unlit; the shader mixes in a texture of the rover's map (seen, cost,
 * hazard) to dim unexplored ground, draw a survey grid over mapped ground
 * and, in cost view, paint the heat gradient with no-go ground hatched.
 */
import { Color, MeshBasicMaterial, type DataTexture } from "three";
import { BLOCKED } from "@/lib/rover/costmap";

/** Inferno colour map: polynomial fit (public domain), one RGB row per power of t. */
export const INFERNO = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
] as const;

const INFERNO_GLSL = `vec3 inferno(float t) {
  return ${INFERNO.map((c) => `vec3(${c.join(", ")})`).join(" + t * (")}${")".repeat(INFERNO.length - 1)};
}`;

/**
 * Map a cost to 0..1 for the heat gradient. No-go ground (a hazard under the
 * wheels) is 1; the keep-out ring around it, where the centre can't go but a
 * wheel may, sits below it; ordinary ground runs up to 0.68.
 */
export const heat = (cost: number, hazard = false) =>
  hazard ? 1 : cost === BLOCKED ? 0.76 : Math.min(0.68, (cost - 1) / 8);

/** How much of the ground's own shading the heat map covers in cost view. */
export const COST_MIX = 0.72;

export const groundUniforms = () => ({
  uKnown: { value: null as DataTexture | null },
  uCostMix: { value: 0 },
  uCells: { value: 128 },
  uGrid: { value: new Color() },
});

export function groundMaterial(uniforms: ReturnType<typeof groundUniforms>) {
  const mat = new MeshBasicMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec2 gridUv;\nattribute float light;\nvarying vec2 vGridUv;\nvarying vec2 vGround;\nvarying float vLight;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvGridUv = gridUv;\nvGround = position.xz;\nvLight = light;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uKnown;
uniform float uCostMix, uCells;
uniform vec3 uGrid;
varying vec2 vGridUv;
varying vec2 vGround;
varying float vLight;
${INFERNO_GLSL}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
{
  vec4 k = texture2D(uKnown, vGridUv);
  float seen = k.r;
  // Fine regolith grain the half-metre mesh can't carry.
  float grain = vnoise(vGround * 1.1) * 0.45 + vnoise(vGround * 4.3) * 0.35 + vnoise(vGround * 13.0) * 0.2;
  vec3 lit = diffuseColor.rgb * (0.86 + 0.28 * grain) * vLight;
  vec3 col = mix(lit * vec3(0.34, 0.36, 0.42), lit, seen);
  // Cost heat map over mapped ground, keeping the relief shading.
  vec3 hot = pow(clamp(inferno(k.g), 0.0, 1.0), vec3(2.2)) * (0.3 + 0.7 * clamp(vLight / 2.0, 0.0, 1.0)) * 1.05;
  col = mix(col, hot, seen * uCostMix);
  // No-go ground, where a wheel must never go, is hatched like hazard tape.
  float q = (vGround.x + vGround.y) * 1.6;
  float w = fwidth(q) * 0.75;
  float stripe = smoothstep(0.33 - w, 0.33 + w, abs(fract(q) - 0.5));
  vec3 tape = mix(vec3(0.9, 0.74, 0.3), vec3(0.16, 0.015, 0.03), stripe);
  tape *= 0.45 + 0.55 * clamp(vLight / 1.6, 0.0, 1.0);
  col = mix(col, tape, smoothstep(0.35, 0.65, k.b) * seen * min(1.0, uCostMix * 1.3));
  // Survey grid every 4 m over mapped ground.
  vec2 gp = vGridUv * uCells / 4.0;
  vec2 gd = abs(fract(gp - 0.5) - 0.5) / fwidth(gp);
  float line = 1.0 - min(min(gd.x, gd.y), 1.0);
  col = mix(col, uGrid, line * seen * 0.14 * (1.0 - uCostMix * 0.6));
  diffuseColor.rgb = col;
}`,
      );
  };
  mat.customProgramCacheKey = () => "lunar-ground";
  return mat;
}
