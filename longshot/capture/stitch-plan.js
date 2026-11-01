/**
 * Pure stitching geometry — no DOM or Chrome APIs, so it is unit-testable.
 *
 * Coordinate systems
 * ------------------
 *  • Viewport CSS px — what the content script measures (band top/bottom…).
 *  • Content CSS px  — position inside the scrolled document / container.
 *  • Native px       — the capture's own pixels (CSS px × captureScale).
 *  • Output px       — native px × ratio (ratio ≤ 1; we never upscale).
 *
 * Each captured tile contributes a horizontal band of rows. Its position in
 * the final image comes from the *measured* scroll offset at the moment of
 * capture, never from an assumed scroll step, so the last (clamped) tile and
 * any page that refuses to scroll exactly still lands on the right rows.
 * Tiles are drawn in capture order and later tiles overwrite overlapping rows,
 * which removes duplicated content from the final overlap.
 */

import { LIMITS, DOCS_PAGE_RATIOS } from '../utils/constants.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @param {object} params
 * @param {Array<object>} params.tiles  Tile records captured by the controller.
 * @param {number} params.captureScale  Native px per CSS px (e.g. 2 on Retina).
 * @param {number} params.targetScale   Desired output px per CSS px.
 * @param {number} params.startContent  Content coordinate of the first output row.
 */
export function buildLayout({ tiles, captureScale, targetScale, startContent }) {
  if (!tiles.length) throw new Error('No tiles to stitch');
  const S = captureScale;
  const first = tiles[0];

  const srcLeft = clamp(Math.round(first.bandLeft * S), 0, first.imageWidth);
  const srcRight = clamp(Math.round(first.bandRight * S), srcLeft, first.imageWidth);
  const nativeWidth = srcRight - srcLeft;
  if (nativeWidth <= 0) throw new Error('Capture area has no width');

  const placed = [];
  for (const tile of tiles) {
    const srcTop = clamp(Math.round(tile.bandTop * S), 0, tile.imageHeight);
    const srcBottom = clamp(Math.round(tile.bandBottom * S), srcTop, tile.imageHeight);
    if (srcBottom <= srcTop) continue;
    const dstTop = Math.round((tile.contentTop - startContent) * S);
    placed.push({
      key: tile.key,
      index: tile.index,
      imageWidth: tile.imageWidth,
      imageHeight: tile.imageHeight,
      srcTop,
      srcBottom,
      dstTop,
      dstBottom: dstTop + (srcBottom - srcTop),
    });
  }
  if (!placed.length) throw new Error('No visible rows captured');

  // Normalise so the image starts at row 0.
  const minTop = Math.min(...placed.map((p) => p.dstTop));
  for (const p of placed) {
    p.dstTop -= minTop;
    p.dstBottom -= minTop;
  }

  // Close hairline gaps (≤ 3 native rows) caused by rounding fractional scroll
  // offsets on non-integer device pixel ratios. Larger gaps mean the page
  // jumped and are reported instead of being papered over.
  const gaps = [];
  let coveredBottom = placed[0].dstBottom;
  for (let i = 1; i < placed.length; i += 1) {
    const p = placed[i];
    if (p.dstTop > coveredBottom) {
      const gap = p.dstTop - coveredBottom;
      if (gap <= 3 && p.srcTop >= gap) {
        p.srcTop -= gap;
        p.dstTop -= gap;
      } else if (gap <= 3) {
        const prev = placed[i - 1];
        const extend = Math.min(gap, prev.imageHeight - prev.srcBottom);
        prev.srcBottom += extend;
        prev.dstBottom += extend;
        if (extend < gap) gaps.push({ atRow: coveredBottom, rows: gap - extend });
      } else {
        gaps.push({ atRow: coveredBottom, rows: gap });
      }
    }
    coveredBottom = Math.max(coveredBottom, p.dstBottom);
  }

  const nativeHeight = Math.max(...placed.map((p) => p.dstBottom));
  const ratio = Math.min(1, targetScale / S);
  const outputWidth = Math.max(1, Math.round(nativeWidth * ratio));
  const outputHeight = Math.max(1, Math.round(nativeHeight * ratio));

  for (const p of placed) {
    p.outTop = Math.round(p.dstTop * ratio);
    p.outBottom = Math.round(p.dstBottom * ratio);
  }

  return {
    tiles: placed,
    srcLeft,
    nativeWidth,
    nativeHeight,
    ratio,
    outputScale: S * ratio,
    outputWidth,
    outputHeight,
    gaps,
  };
}

/**
 * For output rows [a, b) of a placed tile, the source rows in its image.
 * Fractional when downscaling; drawImage handles sub-pixel source rects.
 */
export function sourceRowsFor(layout, placedTile, a, b) {
  const { ratio } = layout;
  const sy0 = placedTile.srcTop + (a / ratio - placedTile.dstTop);
  const sy1 = placedTile.srcTop + (b / ratio - placedTile.dstTop);
  return {
    sy0: clamp(sy0, 0, placedTile.imageHeight),
    sy1: clamp(sy1, 0, placedTile.imageHeight),
  };
}

/**
 * Pick the output scale for a quality level. Never exceeds the capture scale.
 *
 * "High" targets 2×, but a capture only slightly above 2× (e.g. 2.2× on a
 * Retina screen with 110% browser zoom) is kept native: a fractional resample
 * such as 2.2 → 2 softens every glyph edge, which defeats the purpose.
 */
export function targetScaleFor(quality, captureScale) {
  switch (quality) {
    case 'standard':
      return Math.min(1, captureScale);
    case 'maximum':
      return captureScale;
    case 'high':
    default:
      return captureScale < 2.75 ? captureScale : 2;
  }
}

/**
 * Decide how tall each output image may be.
 * @returns {{ targetPartHeight: number, hardLimit: number, reason: string, needsScaleDown: number }}
 */
export function planPartHeights({ outputWidth, outputHeight, format, settings }) {
  const formatSide = format === 'webp' ? LIMITS.WEBP_MAX_SIDE : format === 'jpeg' ? LIMITS.CANVAS_MAX_SIDE : Infinity;
  // PNG is streamed, so only JPEG/WebP need the whole part in one canvas.
  const areaHeight = format === 'png' ? Infinity : Math.floor(LIMITS.CANVAS_MAX_AREA / outputWidth);

  // Output wider than the format allows: must scale down (rare, e.g. WebP on 8K).
  const widthLimit = Math.min(formatSide, LIMITS.CANVAS_MAX_SIDE);
  const needsScaleDown = outputWidth > widthLimit ? widthLimit / outputWidth : 1;

  const hardLimit = Math.max(1, Math.min(settings.maxImageHeight, formatSide, areaHeight));

  if (settings.docsOptimized) {
    const ratio = DOCS_PAGE_RATIOS[settings.docsPageSize] ?? DOCS_PAGE_RATIOS.letter;
    const pageHeight = Number.isFinite(ratio) ? Math.floor(outputWidth * ratio * 0.98) : Infinity;
    const pixelHeight = Math.floor((LIMITS.DOCS_MAX_PIXELS * 0.99) / outputWidth);
    return {
      targetPartHeight: Math.max(1, Math.min(pageHeight, pixelHeight, hardLimit)),
      hardLimit,
      reason: pageHeight <= pixelHeight ? 'docs-page' : 'docs-megapixels',
      needsScaleDown,
    };
  }

  if (settings.splitLongScreenshots) {
    return {
      targetPartHeight: Math.max(1, Math.min(settings.splitPartHeight, hardLimit)),
      hardLimit,
      reason: 'split',
      needsScaleDown,
    };
  }

  let reason = 'single';
  if (outputHeight > hardLimit) {
    reason = hardLimit === formatSide || hardLimit === areaHeight ? 'format-limit' : 'max-height';
  }
  return { targetPartHeight: hardLimit, hardLimit, reason, needsScaleDown };
}

/**
 * Split [0, totalHeight) into parts no taller than `target`.
 * `findCut(lo, ideal)` may return a better cut row in (lo, ideal] — e.g. a
 * blank row between lines of text — so parts never slice through text.
 */
export async function computeCuts(totalHeight, target, findCut) {
  const cuts = [0];
  let start = 0;
  while (totalHeight - start > target) {
    const ideal = start + target;
    const windowRows = clamp(Math.floor(target * 0.18), 24, 1200);
    const lo = Math.max(start + Math.floor(target * 0.5), ideal - windowRows);
    let cut = ideal;
    if (findCut && ideal - lo > 2) {
      const found = await findCut(lo, ideal);
      if (Number.isFinite(found) && found > lo && found <= ideal) cut = Math.round(found);
    }
    cuts.push(cut);
    start = cut;
  }
  cuts.push(totalHeight);

  const parts = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    parts.push({ top: cuts[i], bottom: cuts[i + 1] });
  }
  return parts;
}

/**
 * Choose the cleanest cut row from RGBA pixels of rows [lo, ideal] (inclusive).
 * A cut at row k separates row k-1 from row k. Rows with little horizontal
 * detail that also match their neighbour are whitespace between text lines.
 */
export function chooseCutRow(rgba, width, lo, ideal) {
  const rowCount = ideal - lo + 1;
  const rowEnergy = new Float64Array(rowCount);
  const stride = width * 4;

  for (let r = 0; r < rowCount; r += 1) {
    const base = r * stride;
    let energy = 0;
    for (let x = 1; x < width; x += 1) {
      const i = base + x * 4;
      energy += Math.abs(rgba[i] - rgba[i - 4]) + Math.abs(rgba[i + 1] - rgba[i - 3]) + Math.abs(rgba[i + 2] - rgba[i - 2]);
    }
    rowEnergy[r] = energy / width;
  }

  // score[k] for k in (lo, ideal]: detail on both sides + vertical change.
  const scores = [];
  let minScore = Infinity;
  for (let k = lo + 1; k <= ideal; k += 1) {
    const above = k - 1 - lo;
    const below = k - lo;
    let vertical = 0;
    const aBase = above * stride;
    const bBase = below * stride;
    for (let x = 0; x < width; x += 1) {
      const i = x * 4;
      vertical += Math.abs(rgba[aBase + i] - rgba[bBase + i]) + Math.abs(rgba[aBase + i + 1] - rgba[bBase + i + 1]) + Math.abs(rgba[aBase + i + 2] - rgba[bBase + i + 2]);
    }
    const score = rowEnergy[above] + rowEnergy[below] + vertical / width;
    scores.push(score);
    if (score < minScore) minScore = score;
  }

  const tolerance = minScore + 0.35;
  // Prefer the candidate closest to the ideal cut (fullest part)…
  let best = -1;
  for (let j = scores.length - 1; j >= 0; j -= 1) {
    if (scores[j] <= tolerance) {
      best = j;
      break;
    }
  }
  if (best < 0) return ideal;

  // …but step back into the middle of a whitespace run so both parts keep a
  // little breathing room around the text.
  let runStart = best;
  while (runStart > 0 && scores[runStart - 1] <= tolerance) runStart -= 1;
  const runLength = best - runStart + 1;
  const offset = Math.min(Math.floor(runLength / 2), 40);
  return lo + 1 + best - offset;
}
