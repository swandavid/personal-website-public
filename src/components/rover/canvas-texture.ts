import { CanvasTexture, SRGBColorSpace } from "three";

/** A texture drawn once on a 2D canvas; pass `srgb: false` for data such as bump maps. */
export function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  { srgb = true, anisotropy = 4 } = {},
) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const tex = new CanvasTexture(c);
  if (srgb) tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}
