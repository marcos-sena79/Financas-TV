// Gera os ícones do app (PWA) em public/icons/, sem dependências: desenha três barras
// crescentes sobre fundo escuro e grava PNG à mão. Rode de novo se mudar o desenho:
//   node scripts/make-icons.js
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.join(import.meta.dirname, "..", "public", "icons");
const BG = [0x1a, 0x1a, 0x19];
const BAR = [0xc3, 0xc2, 0xb7];
const ACCENT = [0x39, 0x87, 0xe5];

// Barras em coordenadas 0..1 do ícone inteiro, dentro da área segura dos ícones "maskable" (círculo de 80%).
const BARS = [
  { x: 0.29, w: 0.12, top: 0.55, color: BAR },
  { x: 0.44, w: 0.12, top: 0.43, color: BAR },
  { x: 0.59, w: 0.12, top: 0.29, color: ACCENT },
];
const BOTTOM = 0.71;

function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r), cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** rounded: cantos arredondados (ícone comum); sem isso, fundo cheio (maskable e Apple). */
function draw(size, { rounded }) {
  const SS = 4, px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      if (rounded && !inRoundRect(u, v, 0, 0, 1, 1, 0.22)) continue;
      const bar = BARS.find((k) => inRoundRect(u, v, k.x, k.top, k.x + k.w, BOTTOM, 0.025));
      const c = bar ? bar.color : BG;
      r += c[0]; g += c[1]; b += c[2]; a += 255;
    }
    const n = SS * SS, i = (y * size + x) * 4, cov = a / 255;
    px[i] = cov ? r / cov : 0; px[i + 1] = cov ? g / cov : 0; px[i + 2] = cov ? b / cov : 0; px[i + 3] = a / n;
  }
  return png(size, px);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  "icon-192.png": draw(192, { rounded: true }),
  "icon-512.png": draw(512, { rounded: true }),
  "maskable-512.png": draw(512, { rounded: false }),
  "apple-touch-icon.png": draw(180, { rounded: false }),
  "favicon-32.png": draw(32, { rounded: true }),
};
for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), buf);
console.log("Ícones gerados:", Object.keys(files).join(", "));
