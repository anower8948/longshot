/**
 * Pixel-exact cropping of a finished screenshot.
 *
 * No resampling happens: the selected rows and columns are copied 1:1. PNG
 * crops are streamed strip by strip through the streaming encoder, so a crop
 * of an image taller than Chrome's 32,767 px canvas limit still works.
 */

import { LIMITS } from '../utils/constants.js';
import { StreamingPngEncoder } from '../utils/png-encoder.js';

/** Clamp and round a crop rectangle to whole pixels inside the image. */
export function normalizeCropRect(rect, imageWidth, imageHeight) {
  const left = Math.max(0, Math.min(imageWidth - 1, Math.round(rect.x)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.round(rect.y)));
  const right = Math.max(left + 1, Math.min(imageWidth, Math.round(rect.x + rect.width)));
  const bottom = Math.max(top + 1, Math.min(imageHeight, Math.round(rect.y + rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * @param {Blob} blob            Source image.
 * @param {{x:number,y:number,width:number,height:number}} rect  Crop in image pixels.
 * @param {{ mime?: string, quality?: number, dpi?: number }} [options]
 * @returns {Promise<Blob>}
 */
export async function cropImageBlob(blob, rect, { mime = blob.type || 'image/png', quality = 0.95, dpi = 96 } = {}) {
  // Decoding with a source rectangle yields a bitmap of just the crop.
  const bitmap = await createImageBitmap(blob, rect.x, rect.y, rect.width, rect.height);
  const { width, height } = rect;

  try {
    const fitsCanvas = width <= LIMITS.CANVAS_MAX_SIDE && height <= LIMITS.CANVAS_MAX_SIDE && width * height <= LIMITS.CANVAS_MAX_AREA;

    if (mime !== 'image/png' && fitsCanvas) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: mime, quality });
    }

    // PNG (or anything too large for one canvas): stream rows into the encoder.
    const encoder = new StreamingPngEncoder(width, { effort: 'balanced', dpi });
    const stripRows = Math.min(LIMITS.STRIP_ROWS, height);
    const strip = new OffscreenCanvas(width, stripRows);
    const ctx = strip.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    try {
      for (let y = 0; y < height; y += stripRows) {
        const rows = Math.min(stripRows, height - y);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, rows);
        ctx.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
        const { data } = ctx.getImageData(0, 0, width, rows);
        await encoder.addRgbaRows(data, rows);
      }
      return await encoder.finish();
    } catch (error) {
      await encoder.abort();
      throw error;
    } finally {
      strip.width = 0;
      strip.height = 0;
    }
  } finally {
    bitmap.close();
  }
}
