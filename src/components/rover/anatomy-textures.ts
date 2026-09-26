/** Canvas-drawn textures for the anatomy model, seeded so every load matches. */
import { RepeatWrapping } from "three";
import { rng } from "@/lib/rover/terrain";
import { canvasTexture } from "./canvas-texture";

export function makeTextures() {
  // Woven wire tyre with chevron treads; the gaps are transparent.
  const tyre = canvasTexture(
    1024,
    256,
    (ctx) => {
      ctx.strokeStyle = "#c4c8cc";
      ctx.lineWidth = 2.2;
      for (let i = -256; i < 1024 + 256; i += 14) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 256, 256);
        ctx.moveTo(i + 256, 0);
        ctx.lineTo(i, 256);
        ctx.stroke();
      }
      ctx.fillStyle = "#e3e5e7";
      for (let x = 0; x < 1024; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x + 6, 18);
        ctx.lineTo(x + 30, 128);
        ctx.lineTo(x + 6, 238);
        ctx.lineTo(x + 18, 238);
        ctx.lineTo(x + 42, 128);
        ctx.lineTo(x + 18, 18);
        ctx.fill();
      }
      ctx.fillRect(0, 0, 1024, 10);
      ctx.fillRect(0, 246, 1024, 10);
    },
    { anisotropy: 8 },
  );
  tyre.wrapS = RepeatWrapping;
  tyre.repeat.set(2, 1);

  const solar = canvasTexture(
    1024,
    512,
    (ctx) => {
      ctx.fillStyle = "#b9bec4";
      ctx.fillRect(0, 0, 1024, 512);
      const cw = 1024 / 12;
      const ch = 512 / 5;
      for (let j = 0; j < 5; j++) {
        for (let i = 0; i < 12; i++) {
          const x = i * cw + 3;
          const y = j * ch + 3;
          const g = ctx.createLinearGradient(x, y, x + cw, y + ch);
          g.addColorStop(0, "#1d2d52");
          g.addColorStop(0.5, "#131f3b");
          g.addColorStop(1, "#1a2848");
          ctx.fillStyle = g;
          ctx.fillRect(x, y, cw - 6, ch - 6);
          // Cropped corners and silver gridlines, as on real cells.
          ctx.fillStyle = "#b9bec4";
          for (const [cx, cy] of [
            [x, y],
            [x + cw - 6, y],
            [x, y + ch - 6],
            [x + cw - 6, y + ch - 6],
          ])
            ctx.fillRect(cx! - 5, cy! - 5, 10, 10);
          ctx.fillStyle = "rgba(200,206,214,0.35)";
          for (let k = 1; k < 8; k++)
            ctx.fillRect(x + (k * (cw - 6)) / 8, y, 1, ch - 6);
          ctx.fillRect(x, y + (ch - 6) / 2, cw - 6, 2);
        }
      }
    },
    { anisotropy: 8 },
  );

  // Crinkled foil for the insulation blankets, used as a bump map.
  const crinkle = canvasTexture(
    512,
    512,
    (ctx) => {
      const r = rng(7);
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 900; i++) {
        const x = r() * 512;
        const y = r() * 512;
        const a = r() * Math.PI;
        const l = 10 + r() * 60;
        ctx.strokeStyle = `rgba(${r() > 0.5 ? 255 : 0},${r() > 0.5 ? 255 : 0},${r() > 0.5 ? 255 : 0},0.12)`;
        ctx.lineWidth = 1 + r() * 5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        ctx.stroke();
      }
    },
    { srgb: false, anisotropy: 8 },
  );
  crinkle.wrapS = crinkle.wrapT = RepeatWrapping;
  crinkle.repeat.set(3, 2);

  // Circuit board: solder mask with traces, pads and vias.
  const pcb = canvasTexture(
    1024,
    1024,
    (ctx) => {
      const r = rng(11);
      ctx.fillStyle = "#0d3b2a";
      ctx.fillRect(0, 0, 1024, 1024);
      ctx.strokeStyle = "rgba(90,170,120,0.45)";
      ctx.lineCap = "round";
      for (let i = 0; i < 260; i++) {
        let x = Math.round(r() * 64) * 16;
        let y = Math.round(r() * 64) * 16;
        ctx.lineWidth = r() > 0.85 ? 5 : 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let k = 0; k < 4; k++) {
          const d = Math.round((r() - 0.5) * 12) * 16;
          if (k % 2) y += d;
          else x += d;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = "#c9a64f";
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(220,230,220,0.5)";
      ctx.lineWidth = 3;
      ctx.strokeRect(10, 10, 1004, 1004);
    },
    { anisotropy: 8 },
  );

  const fins = canvasTexture(
    512,
    512,
    (ctx) => {
      ctx.fillStyle = "#f4f4f2";
      ctx.fillRect(0, 0, 512, 512);
      ctx.fillStyle = "#d9dbdb";
      for (let x = 0; x < 512; x += 16) ctx.fillRect(x, 0, 3, 512);
      ctx.fillStyle = "#b9bcbd";
      for (let x = 8; x < 512; x += 64)
        for (let y = 8; y < 512; y += 64) ctx.fillRect(x, y, 4, 4);
    },
    { anisotropy: 8 },
  );

  return { tyre, solar, crinkle, pcb, fins };
}

export type Textures = ReturnType<typeof makeTextures>;
