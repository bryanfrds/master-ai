import { deflateSync } from 'node:zlib';

// A tiny PNG writer and rasterizer, so the app icon needs no image library.
// Shapes are drawn once at a large size and averaged down, which antialiases
// every smaller size for free.

const table = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
export function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bits per channel
  header[9] = 6;   // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const INK = rgb('#283f31');      // the dashboard's primary green
const PAPER = rgb('#f6f7f4');
const ACCENT = rgb('#95ad87');

// Signed distance to a rounded rectangle: negative inside, positive outside.
function roundedRect(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, x - (left + width - radius), 0);
  const dy = Math.max(top + radius - y, y - (top + height - radius), 0);
  return Math.hypot(dx, dy) - radius;
}

// Three bars of different lengths: a list of agents, legible down to 16px.
const BARS = [
  { top: 0.30, width: 0.46, color: PAPER },
  { top: 0.45, width: 0.62, color: ACCENT },
  { top: 0.60, width: 0.34, color: PAPER }
];

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const inset = 0.085 * size;
  const side = size - inset * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let color = null;
      if (roundedRect(px, py, inset, inset, side, side, 0.225 * side) < 0) {
        color = INK;
        for (const bar of BARS) {
          const height = 0.1 * side;
          const inside = roundedRect(px, py, inset + 0.19 * side, inset + bar.top * side,
            bar.width * side, height, height / 2) < 0;
          if (inside) { color = bar.color; break; }
        }
      }
      const at = (y * size + x) * 4;
      if (color) {
        pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2]; pixels[at + 3] = 255;
      }
    }
  }
  return pixels;
}

function shrink(pixels, from, to) {
  const factor = from / to;
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      const sums = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const at = ((y * factor + sy) * from + x * factor + sx) * 4;
          // Weight colour by coverage so transparent edges do not darken.
          const alpha = pixels[at + 3] / 255;
          sums[0] += pixels[at] * alpha; sums[1] += pixels[at + 1] * alpha;
          sums[2] += pixels[at + 2] * alpha; sums[3] += pixels[at + 3];
        }
      }
      const count = factor * factor;
      const alpha = sums[3] / count;
      const at = (y * to + x) * 4;
      const scale = alpha > 0 ? 255 / (alpha * count) : 0;
      out[at] = Math.round(sums[0] * scale); out[at + 1] = Math.round(sums[1] * scale);
      out[at + 2] = Math.round(sums[2] * scale); out[at + 3] = Math.round(alpha);
    }
  }
  return out;
}

// Every size divides 2048 exactly, so each is a clean box average of one render.
export const SIZES = [16, 32, 64, 128, 256, 512, 1024];
export function iconSet() {
  const master = 2048;
  const pixels = draw(master);
  return new Map(SIZES.map(size => [size, encodePNG(size, shrink(pixels, master, size))]));
}
