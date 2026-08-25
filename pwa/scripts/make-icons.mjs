// Generates the PWA icon PNGs (192 + 512) with zero dependencies.
// Draws a simple barbell on a dark rounded background into an RGBA buffer
// and encodes it as a PNG by hand (zlib deflate + CRC32).
// Run: node scripts/make-icons.mjs   (output: public/icons/)

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "icons");

// ---- PNG encoding ----------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing ---------------------------------------------------------------

function hex(color) {
  return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = hex("#0d1117");
  const bar = hex("#e6edf3");
  const plate = hex("#3fb950");

  const put = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  };

  // background (full square; the maskable variant relies on this)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, bg);

  const rect = (x0, y0, x1, y1, c) => {
    const px0 = Math.round(x0 * size);
    const py0 = Math.round(y0 * size);
    const px1 = Math.round(x1 * size);
    const py1 = Math.round(y1 * size);
    for (let y = py0; y < py1; y++)
      for (let x = px0; x < px1; x++)
        if (x >= 0 && x < size && y >= 0 && y < size) put(x, y, c);
  };

  // bar
  rect(0.1, 0.47, 0.9, 0.53, bar);
  // inner plates
  rect(0.28, 0.28, 0.36, 0.72, plate);
  rect(0.64, 0.28, 0.72, 0.72, plate);
  // outer plates
  rect(0.18, 0.34, 0.25, 0.66, plate);
  rect(0.75, 0.34, 0.82, 0.66, plate);
  // collars
  rect(0.13, 0.44, 0.16, 0.56, bar);
  rect(0.84, 0.44, 0.87, 0.56, bar);

  return buf;
}

mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const png = encodePng(size, drawIcon(size));
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
