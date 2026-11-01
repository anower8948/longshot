/**
 * Unit tests for pure modules: stitch geometry, part planning, cut selection
 * and the streaming PNG encoder (round-tripped through an independent decoder).
 *
 *   node dev/test/unit.mjs
 */

import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { buildLayout, sourceRowsFor, planPartHeights, computeCuts, chooseCutRow, targetScaleFor } from '../../longshot/capture/stitch-plan.js';
import { StreamingPngEncoder, readPngDimensions } from '../../longshot/utils/png-encoder.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../longshot/utils/storage.js';
import { classifyUrl } from '../../longshot/utils/page-detection.js';
import { sanitizeFilename } from '../../longshot/utils/format.js';
import { buildFilenames } from '../../longshot/utils/filenames.js';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error.stack?.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

const tile = (index, contentTop, bandTop, bandBottom, extra = {}) => ({
  index,
  key: `t${index}`,
  imageWidth: 2560,
  imageHeight: 1800,
  bandTop,
  bandBottom,
  bandLeft: 0,
  bandRight: 1280,
  contentTop,
  ...extra,
});

console.log('stitch-plan');

await test('full page with clamped last tile overlaps exactly', () => {
  // Page 2000 CSS px, viewport 900: scrolls 0, 900, 1100 (clamped).
  const layout = buildLayout({
    tiles: [tile(0, 0, 0, 900), tile(1, 900, 0, 900), tile(2, 1100, 0, 900)],
    captureScale: 2,
    targetScale: 2,
    startContent: 0,
  });
  assert.equal(layout.outputWidth, 2560);
  assert.equal(layout.outputHeight, 4000);
  assert.deepEqual(layout.gaps, []);
  const last = layout.tiles[2];
  assert.equal(last.outTop, 2200);
  assert.equal(last.outBottom, 4000);
  // Rows 2200..3600 are drawn twice (identical content); last tile wins.
  assert.deepEqual(sourceRowsFor(layout, last, 3600, 4000), { sy0: 1400, sy1: 1800 });
});

await test('hairline rounding gaps are closed from the next tile', () => {
  const layout = buildLayout({
    tiles: [tile(0, 0, 0, 900), tile(1, 901, 10, 900)],
    captureScale: 2,
    targetScale: 2,
    startContent: 0,
  });
  // tile1 contentTop 901 → dst 1802, previous ends at 1800: 2-row gap pulled from rows above its band.
  assert.deepEqual(layout.gaps, []);
  assert.equal(layout.tiles[1].dstTop, 1800);
  assert.equal(layout.tiles[1].srcTop, 18);
});

await test('large gaps are reported, not hidden', () => {
  const layout = buildLayout({
    tiles: [tile(0, 0, 0, 900), tile(1, 1000, 0, 900)],
    captureScale: 2,
    targetScale: 2,
    startContent: 0,
  });
  assert.equal(layout.gaps.length, 1);
  assert.equal(layout.gaps[0].rows, 200);
});

await test('region clip and inner container bands map to the right rows', () => {
  // Container band starts at viewport y=60 (origin 60). Content 0..840 visible.
  const layout = buildLayout({
    tiles: [
      tile(0, 0, 60, 900, { bandLeft: 200, bandRight: 1280 }),
      tile(1, 840, 60, 900, { bandLeft: 200, bandRight: 1280 }),
    ],
    captureScale: 2,
    targetScale: 2,
    startContent: 0,
  });
  assert.equal(layout.srcLeft, 400);
  assert.equal(layout.outputWidth, 2160);
  assert.equal(layout.outputHeight, 3360);
  assert.equal(layout.tiles[1].srcTop, 120);
});

await test('standard quality downsamples without gaps', () => {
  const layout = buildLayout({
    tiles: [tile(0, 0, 0, 900), tile(1, 900, 0, 900), tile(2, 1100, 0, 900)],
    captureScale: 2,
    targetScale: 1,
    startContent: 0,
  });
  assert.equal(layout.ratio, 0.5);
  assert.equal(layout.outputHeight, 2000);
  assert.equal(layout.tiles[1].outTop, 900);
  assert.deepEqual(sourceRowsFor(layout, layout.tiles[1], 900, 1000), { sy0: 0, sy1: 200 });
});

await test('quality levels never upscale', () => {
  assert.equal(targetScaleFor('standard', 2), 1);
  assert.equal(targetScaleFor('high', 2), 2);
  assert.equal(targetScaleFor('high', 3), 2);
  assert.equal(targetScaleFor('high', 1), 1);
  assert.equal(targetScaleFor('high', 2.2), 2.2, 'zoomed Retina capture must not be resampled');
  assert.equal(targetScaleFor('high', 1.5), 1.5);
  assert.equal(targetScaleFor('maximum', 3), 3);
  assert.equal(targetScaleFor('maximum', 1.25), 1.25);
});

await test('part planning: docs pages, megapixels and format limits', () => {
  const docs = planPartHeights({ outputWidth: 2560, outputHeight: 40000, format: 'png', settings: { ...DEFAULT_SETTINGS, docsOptimized: true } });
  assert.equal(docs.reason, 'docs-page');
  assert.ok(docs.targetPartHeight <= 2560 * (9 / 6.5));
  assert.ok(docs.targetPartHeight * 2560 <= 25_000_000);

  const wide = planPartHeights({ outputWidth: 5760, outputHeight: 40000, format: 'png', settings: { ...DEFAULT_SETTINGS, docsOptimized: true } });
  assert.equal(wide.reason, 'docs-megapixels');
  assert.ok(wide.targetPartHeight * 5760 <= 25_000_000);

  const webp = planPartHeights({ outputWidth: 2560, outputHeight: 40000, format: 'webp', settings: DEFAULT_SETTINGS });
  assert.equal(webp.targetPartHeight, 16383);
  assert.equal(webp.reason, 'format-limit');

  const png = planPartHeights({ outputWidth: 2560, outputHeight: 80000, format: 'png', settings: DEFAULT_SETTINGS });
  assert.equal(png.reason, 'single');
  assert.equal(png.targetPartHeight, 100000);
});

await test('computeCuts covers the image exactly with bounded parts', async () => {
  const parts = await computeCuts(10000, 3000, async (lo, ideal) => ideal - 7);
  assert.equal(parts[0].top, 0);
  assert.equal(parts.at(-1).bottom, 10000);
  for (let i = 1; i < parts.length; i += 1) assert.equal(parts[i].top, parts[i - 1].bottom);
  for (const part of parts) assert.ok(part.bottom - part.top <= 3000);
});

await test('chooseCutRow prefers blank rows between text lines', () => {
  const width = 50;
  const lo = 100;
  const ideal = 140;
  const rows = ideal - lo + 1;
  const rgba = new Uint8ClampedArray(width * rows * 4).fill(255);
  // "Text" everywhere except a blank run at rows 118..124.
  for (let r = 0; r < rows; r += 1) {
    const row = lo + r;
    if (row >= 118 && row <= 124) continue;
    for (let x = 0; x < width; x += 1) {
      const i = (r * width + x) * 4;
      const ink = (x * 7 + row * 3) % 5 === 0 ? 0 : 255;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = ink;
    }
  }
  const cut = chooseCutRow(rgba, width, lo, ideal);
  assert.ok(cut >= 119 && cut <= 124, `cut ${cut} should be inside the blank run`);
});

console.log('png-encoder');

async function roundTrip(width, height, effort, pixel) {
  const encoder = new StreamingPngEncoder(width, { effort, dpi: 192 });
  const strip = 37;
  for (let y0 = 0; y0 < height; y0 += strip) {
    const rows = Math.min(strip, height - y0);
    const rgba = new Uint8ClampedArray(width * rows * 4);
    for (let r = 0; r < rows; r += 1) {
      for (let x = 0; x < width; x += 1) {
        const [cr, cg, cb] = pixel(x, y0 + r);
        const i = (r * width + x) * 4;
        rgba[i] = cr;
        rgba[i + 1] = cg;
        rgba[i + 2] = cb;
        rgba[i + 3] = 255;
      }
    }
    await encoder.addRgbaRows(rgba, rows);
  }
  const blob = await encoder.finish();
  const dims = await readPngDimensions(blob);
  assert.deepEqual(dims, { width, height });
  const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const expected = pixel(x, y);
      if (png.data[i] !== expected[0] || png.data[i + 1] !== expected[1] || png.data[i + 2] !== expected[2]) {
        throw new Error(`pixel mismatch at ${x},${y}: got ${png.data[i]},${png.data[i + 1]},${png.data[i + 2]} want ${expected}`);
      }
    }
  }
  return blob.size;
}

const noisy = (x, y) => [(x * 13 + y * 7) & 255, (x * y + 31) & 255, ((x ^ y) * 5) & 255];
const screenshotLike = (x, y) => ((y % 40 < 12 && (x * 3 + y) % 7 < 3) || x < 4 ? [30, 30, 30] : [255, 255, 255]);

for (const effort of ['fast', 'balanced', 'smallest']) {
  await test(`lossless round trip (${effort}, noisy)`, () => roundTrip(123, 211, effort, noisy));
  await test(`lossless round trip (${effort}, screenshot-like)`, () => roundTrip(640, 500, effort, screenshotLike));
}

await test('encoder handles images taller than canvas limits cheaply', async () => {
  const width = 8;
  const height = 70_000;
  const encoder = new StreamingPngEncoder(width, { effort: 'balanced' });
  const rows = 4096;
  for (let y0 = 0; y0 < height; y0 += rows) {
    const count = Math.min(rows, height - y0);
    const rgba = new Uint8ClampedArray(width * count * 4).fill(200);
    await encoder.addRgbaRows(rgba, count);
  }
  const blob = await encoder.finish();
  assert.deepEqual(await readPngDimensions(blob), { width, height });
  const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
  assert.equal(png.height, height);
  assert.equal(png.data[(height - 1) * width * 4], 200);
});

console.log('settings & helpers');

await test('settings normalization rejects invalid values', () => {
  const s = normalizeSettings({ quality: 'ultra', captureDelay: '1000', maxImageHeight: 5, docsOptimized: 1, bogus: true });
  assert.equal(s.quality, 'high');
  assert.equal(s.captureDelay, 1000);
  assert.equal(s.maxImageHeight, 4000);
  assert.equal(s.docsOptimized, true);
  assert.ok(!('bogus' in s));
});

await test('restricted URL classification', () => {
  assert.equal(classifyUrl('chrome://settings').capturable, false);
  assert.equal(classifyUrl('chrome-extension://abc/popup.html').capturable, false);
  assert.equal(classifyUrl('https://chromewebstore.google.com/detail/x').code, 'WEB_STORE');
  assert.equal(classifyUrl('https://chrome.google.com/webstore/category').code, 'WEB_STORE');
  assert.equal(classifyUrl('https://example.com/doc.pdf').limited, 'PDF_VIEWER');
  assert.equal(classifyUrl('file:///Users/me/page.html').code, 'FILE_URL');
  assert.equal(classifyUrl('https://en.wikipedia.org/wiki/PNG').capturable, true);
});

await test('filenames are safe and ordered', () => {
  assert.equal(sanitizeFilename('  My: "Doc" / v2?  '), 'My Doc v2');
  assert.equal(sanitizeFilename('...'), 'Screenshot');
  const names = buildFilenames({
    title: 'Guide',
    createdAt: new Date(2026, 0, 2, 3, 4, 5).getTime(),
    outputs: [0, 1, 2].map((index) => ({ index, mime: 'image/png' })),
  });
  assert.equal(names[0], 'LongShot/Guide - 2026-01-02 at 03.04.05/Guide - part 01 of 3.png');
  assert.equal(names[2], 'LongShot/Guide - 2026-01-02 at 03.04.05/Guide - part 03 of 3.png');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
