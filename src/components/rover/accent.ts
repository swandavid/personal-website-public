import { Color, SRGBColorSpace } from "three";

/** The site's accent colour (--color-visited), resolved to sRGB for three.js and CSS. */
export function accentColor() {
  const probe = Object.assign(document.createElement("canvas"), {
    width: 1,
    height: 1,
  }).getContext("2d", {
    willReadFrequently: true,
  })!;
  probe.fillStyle =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-visited")
      .trim() || "#3fbf7f";
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return {
    css: `rgb(${r} ${g} ${b})`,
    color: new Color().setRGB(r! / 255, g! / 255, b! / 255, SRGBColorSpace),
  };
}
