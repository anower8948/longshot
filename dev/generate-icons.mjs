#!/usr/bin/env node
/**
 * Generates LongShot's toolbar/store icons (16, 32, 48, 128 px) without any
 * dependencies: shapes are rendered from signed-distance functions with 6×6
 * supersampling and written as PNG with node:zlib.
 *
 *   node dev/generate-icons.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'longshot', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 6;

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Signed distance to a rounded rectangle (centre cx,cy, half size hx,hy, radius r). */
function roundedBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function box(x0, y0, x1, y1, r) {
  return (px, py) => roundedBox(px, py, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, r);
}

/** Colour of one sample point in unit space, as premultiplied [r,g,b,a]. */
function shade(x, y, size) {
  const small = size <= 16;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  const over = (cr, cg, cb, ca) => {
    r = cr * ca + r * (1 - ca);
    g = cg * ca + g * (1 - ca);
    b = cb * ca + b * (1 - ca);
    a = ca + a * (1 - ca);
  };

  // Background squircle with a diagonal blue → indigo gradient.
  const inset = small ? 0.02 : 0.04;
  if (box(inset, inset, 1 - inset, 1 - inset, 0.23)(x, y) <= 0) {
    const t = clamp01((x + y) / 2);
    over(mix(64, 88, t) / 255, mix(170, 86, t) / 255, mix(255, 246, t) / 255, 1);
    // Soft top highlight for depth.
    const highlight = clamp01(1 - y / 0.55) * 0.22;
    over(1, 1, 1, highlight);
  }

  // Back page (translucent), offset up/right.
  const back = small ? box(0.36, 0.14, 0.78, 0.74, 0.07) : box(0.39, 0.13, 0.77, 0.72, 0.06);
  if (back(x, y) <= 0) over(1, 1, 1, 0.42);

  // Front page: the long screenshot.
  const front = small ? box(0.2, 0.26, 0.64, 0.88, 0.08) : box(0.23, 0.27, 0.63, 0.87, 0.06);
  if (front(x, y) <= 0) {
    over(1, 1, 1, 1);
    // Text lines.
    const lines = small
      ? [
          [0.3, 0.44, 0.54],
          [0.3, 0.62, 0.54],
          [0.3, 0.8, 0.46],
        ]
      : [
          [0.31, 0.39, 0.55],
          [0.31, 0.49, 0.55],
          [0.31, 0.59, 0.55],
          [0.31, 0.69, 0.55],
          [0.31, 0.79, 0.46],
        ];
    const thickness = small ? 0.075 : 0.034;
    for (const [lx, ly, lx1] of lines) {
      if (box(lx, ly - thickness / 2, lx1, ly + thickness / 2, thickness / 2)(x, y) <= 0) {
        const t = clamp01((y - 0.35) / 0.5);
        over(mix(64, 90, t) / 255, mix(150, 96, t) / 255, mix(255, 240, t) / 255, 0.9);
      }
    }
  }

  return [r, g, b, a];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const [cr, cg, cb, ca] = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, size);
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SAMPLES * SAMPLES;
      const alpha = a / n;
      const i = (py * size + px) * 4;
      // Un-premultiply for straight-alpha PNG.
      pixels[i] = alpha ? Math.round((r / n / alpha) * 255) : 0;
      pixels[i + 1] = alpha ? Math.round((g / n / alpha) * 255) : 0;
      pixels[i + 2] = alpha ? Math.round((b / n / alpha) * 255) : 0;
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
