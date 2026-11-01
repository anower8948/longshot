/**
 * Renders the stitched image part by part, strip by strip.
 *
 * Only one strip (≈1,000 rows) plus at most two decoded tiles are in memory at
 * any time, regardless of how long the page is. PNG parts are streamed straight
 * into the encoder; JPEG/WebP need one canvas per part (sized within Chrome's
 * canvas limits by the part planner).
 */

import { LIMITS, MIME_TYPES } from '../utils/constants.js';
import { StreamingPngEncoder } from '../utils/png-encoder.js';
import { LongShotError } from '../utils/errors.js';
import { sourceRowsFor, computeCuts, chooseCutRow } from './stitch-plan.js';

/** Decodes tile blobs on demand with a tiny LRU cache. */
export class TileSource {
  constructor(loadBlob, capacity = 2) {
    this.loadBlob = loadBlob;
    this.capacity = capacity;
    this.cache = new Map();
  }

  async get(tile) {
    if (this.cache.has(tile.key)) {
      const bitmap = this.cache.get(tile.key);
      this.cache.delete(tile.key);
      this.cache.set(tile.key, bitmap);
      return bitmap;
    }
    const blob = await this.loadBlob(tile.key);
    if (!blob) throw new LongShotError('IMAGE_LOAD_FAILED', `Missing tile ${tile.key}`);
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (error) {
      throw new LongShotError('IMAGE_LOAD_FAILED', `Could not decode tile ${tile.key}: ${error.message}`);
    }
    this.cache.set(tile.key, bitmap);
    while (this.cache.size > this.capacity) {
      const [oldestKey, oldest] = this.cache.entries().next().value;
      oldest.close();
      this.cache.delete(oldestKey);
    }
    return bitmap;
  }

  close() {
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
  }
}

function create2dCanvas(width, height, { readback = false } = {}) {
  let canvas;
  let ctx;
  try {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: readback });
  } catch (error) {
    throw new LongShotError('CANVAS_MEMORY', `Canvas ${width}×${height}: ${error.message}`);
  }
  if (!ctx) throw new LongShotError('CANVAS_MEMORY', `Canvas ${width}×${height} could not be allocated`);
  return { canvas, ctx };
}

/**
 * Draw output rows [o0, o1) into ctx starting at canvas row destY.
 * Tiles are drawn in capture order; later tiles overwrite overlapping rows.
 */
export async function renderRows(ctx, layout, source, o0, o1, destY = 0) {
  const { outputWidth, srcLeft, nativeWidth, ratio } = layout;
  ctx.imageSmoothingEnabled = ratio < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, destY, outputWidth, o1 - o0);

  for (const tile of layout.tiles) {
    const a = Math.max(o0, tile.outTop);
    const b = Math.min(o1, tile.outBottom);
    if (a >= b) continue;
    const { sy0, sy1 } = sourceRowsFor(layout, tile, a, b);
    if (sy1 <= sy0) continue;
    const bitmap = await source.get(tile);
    ctx.drawImage(bitmap, srcLeft, sy0, nativeWidth, sy1 - sy0, 0, destY + (a - o0), outputWidth, b - a);
  }
}

/**
 * Finds whitespace rows near each ideal cut so parts don't slice text lines.
 */
export function createCutFinder(layout, source) {
  return async (lo, ideal) => {
    const rows = ideal - lo + 1;
    const { canvas, ctx } = create2dCanvas(layout.outputWidth, rows, { readback: true });
    await renderRows(ctx, layout, source, lo, ideal + 1, 0);
    const { data } = ctx.getImageData(0, 0, layout.outputWidth, rows);
    canvas.width = 0;
    canvas.height = 0;
    return chooseCutRow(data, layout.outputWidth, lo, ideal);
  };
}

/**
 * Render and encode all output parts.
 *
 * @param {object} params
 * @param {object} params.layout       From buildLayout().
 * @param {TileSource} params.source
 * @param {string} params.format       png | jpeg | webp
 * @param {object} params.partPlan     From planPartHeights().
 * @param {object} params.settings
 * @param {(part: {index:number, blob: Blob, top:number, bottom:number}) => Promise<void>} params.onPart
 * @param {(progress: {rowsDone:number, rowsTotal:number, partIndex:number, partCount:number, stage:string}) => void} params.onProgress
 * @param {() => boolean} params.isCancelled
 */
export async function renderParts({ layout, source, format, partPlan, settings, onPart, onProgress, isCancelled }) {
  const { outputWidth: width, outputHeight: height } = layout;
  const smartCuts = height > partPlan.targetPartHeight;

  onProgress({ rowsDone: 0, rowsTotal: height, partIndex: 0, partCount: 0, stage: smartCuts ? 'planning' : 'stitching' });
  const parts = await computeCuts(height, partPlan.targetPartHeight, smartCuts ? createCutFinder(layout, source) : null);

  // Thumbnail for the popup/result page. Capped so it stays cheap.
  const previewWidth = Math.min(480, width);
  let previewScale = previewWidth / width;
  if (height * previewScale > 12_000) previewScale = 12_000 / height;
  const preview = create2dCanvas(Math.max(1, Math.round(width * previewScale)), Math.max(1, Math.round(height * previewScale)));

  const drawPreview = (sourceCanvas, sourceY, rowTop, rowCount) => {
    const y0 = Math.floor(rowTop * previewScale);
    const y1 = Math.ceil((rowTop + rowCount) * previewScale);
    if (y1 <= y0) return;
    preview.ctx.imageSmoothingEnabled = true;
    preview.ctx.imageSmoothingQuality = 'high';
    preview.ctx.drawImage(sourceCanvas, 0, sourceY, width, rowCount, 0, y0, preview.canvas.width, y1 - y0);
  };

  const stripRows = LIMITS.STRIP_ROWS;
  let rowsDone = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const { top, bottom } = parts[index];
    const partHeight = bottom - top;
    let blob;

    if (format === 'png') {
      const encoder = new StreamingPngEncoder(width, {
        effort: settings.pngEffort,
        dpi: Math.round(96 * layout.outputScale),
      });
      const strip = create2dCanvas(width, Math.min(stripRows, partHeight), { readback: true });
      try {
        for (let r0 = top; r0 < bottom; r0 += stripRows) {
          if (isCancelled()) throw new LongShotError('CANCELLED');
          const r1 = Math.min(bottom, r0 + stripRows);
          const rows = r1 - r0;
          await renderRows(strip.ctx, layout, source, r0, r1, 0);
          const { data } = strip.ctx.getImageData(0, 0, width, rows);
          await encoder.addRgbaRows(data, rows);
          drawPreview(strip.canvas, 0, r0, rows);
          rowsDone += rows;
          onProgress({ rowsDone, rowsTotal: height, partIndex: index, partCount: parts.length, stage: 'encoding' });
        }
        blob = await encoder.finish();
      } catch (error) {
        await encoder.abort();
        throw error;
      } finally {
        strip.canvas.width = 0;
        strip.canvas.height = 0;
      }
    } else {
      const part = create2dCanvas(width, partHeight);
      try {
        for (let r0 = top; r0 < bottom; r0 += stripRows) {
          if (isCancelled()) throw new LongShotError('CANCELLED');
          const r1 = Math.min(bottom, r0 + stripRows);
          await renderRows(part.ctx, layout, source, r0, r1, r0 - top);
          drawPreview(part.canvas, r0 - top, r0, r1 - r0);
          rowsDone += r1 - r0;
          onProgress({ rowsDone, rowsTotal: height, partIndex: index, partCount: parts.length, stage: 'stitching' });
        }
        onProgress({ rowsDone, rowsTotal: height, partIndex: index, partCount: parts.length, stage: 'encoding' });
        try {
          blob = await part.canvas.convertToBlob({ type: MIME_TYPES[format], quality: settings.jpegQuality });
        } catch (error) {
          throw new LongShotError('CANVAS_MEMORY', `Encoding ${format} failed: ${error.message}`);
        }
      } finally {
        part.canvas.width = 0;
        part.canvas.height = 0;
      }
    }

    await onPart({ index, blob, top, bottom, width, height: partHeight });
  }

  const previewBlob = await preview.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  return { parts, previewBlob, previewWidth: preview.canvas.width, previewHeight: preview.canvas.height };
}
