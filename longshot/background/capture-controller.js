/**
 * Orchestrates one capture: prepare page → scroll/capture loop → restore page
 * → stitch & encode in the offscreen document.
 *
 * Scroll positions are computed from the page's live measurements before every
 * step (the page may grow while lazy content loads) and each tile records the
 * *actual* scroll offset reported after scrolling. The stitcher positions
 * tiles from those offsets, so the final clamped section and pages that
 * adjust scrolling still stitch without duplicated or missing rows.
 */

import { AGENT_TARGET, CONTENT_SCRIPT_FILES, LIMITS, Msg, CaptureMode } from '../utils/constants.js';
import { LongShotError, toLongShotError, ERROR_DESCRIPTIONS } from '../utils/errors.js';
import { putSession, updateSession, putBlob, blobKey, deleteBlobs, deleteSession } from '../utils/image-db.js';
import { readPngDimensions } from '../utils/png-encoder.js';
import { classifyUrl, hostnameOf } from '../utils/page-detection.js';
import { targetScaleFor } from '../capture/stitch-plan.js';
import { callOffscreen } from './offscreen-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('capture');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CAPTURE_PROGRESS_SHARE = 82; // % of the progress bar used by the scroll/capture phase

function withTimeout(promise, ms, code, detail) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LongShotError(code, detail)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function injectAgent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [...CONTENT_SCRIPT_FILES] });
  } catch (error) {
    const lsError = toLongShotError(error);
    if (lsError.code === 'UNKNOWN' || lsError.code === 'PAGE_NAVIGATED') {
      throw new LongShotError('INJECTION_FAILED', error?.message);
    }
    throw lsError;
  }
}

export async function sendToAgent(tabId, cmd, args = {}, timeoutMs = 30_000) {
  let response;
  try {
    response = await withTimeout(
      chrome.tabs.sendMessage(tabId, { target: AGENT_TARGET, cmd, args }, { frameId: 0 }),
      timeoutMs,
      'PAGE_NAVIGATED',
      `Page did not respond to "${cmd}"`,
    );
  } catch (error) {
    throw toLongShotError(error);
  }
  if (!response) throw new LongShotError('PAGE_NAVIGATED', `No response to "${cmd}"`);
  if (!response.ok) {
    const code = ERROR_DESCRIPTIONS[response.error?.code] ? response.error.code : 'UNKNOWN';
    throw new LongShotError(code, response.error?.message);
  }
  return response.data;
}

/** Validate that a tab can be captured before touching it. */
export async function assertCapturable(tab, mode) {
  const classification = classifyUrl(tab.url);
  if (!classification.capturable) throw new LongShotError(classification.code);
  if (classification.limited === 'PDF_VIEWER' && mode !== CaptureMode.VISIBLE) {
    throw new LongShotError('PDF_VIEWER');
  }
  if (classification.code === 'FILE_URL' && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    throw new LongShotError('FILE_ACCESS');
  }
}

export class CaptureController {
  /**
   * @param {object} params
   * @param {chrome.tabs.Tab} params.tab
   * @param {string} params.mode
   * @param {object} params.settings
   * @param {{x:number,y:number,width:number,height:number}} [params.region]
   * @param {(patch: object) => void} params.onProgress
   */
  constructor({ tab, mode, settings, region, onProgress }) {
    this.tab = tab;
    this.tabId = tab.id;
    this.windowId = tab.windowId;
    this.mode = mode;
    this.settings = settings;
    this.region = region || null;
    this.onProgress = onProgress;
    this.sessionId = crypto.randomUUID();
    this.cancelled = false;
    this.processing = false;
    this.lastCaptureAt = 0;
    this.tiles = [];
    this.warnings = new Set();
    this.captureScale = null;
    this.viewport = null;
  }

  // ---------------------------------------------------------------- control

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onProgress({ phase: 'cancelling' });
    sendToAgent(this.tabId, 'abort', {}, 3_000).catch(() => {});
    if (this.processing) {
      callOffscreen(Msg.OFFSCREEN_CANCEL, { sessionId: this.sessionId }).catch(() => {});
    }
  }

  throwIfCancelled() {
    if (this.cancelled) throw new LongShotError('CANCELLED');
  }

  agent(cmd, args, timeoutMs) {
    return sendToAgent(this.tabId, cmd, args, timeoutMs);
  }

  // ---------------------------------------------------------------- capture

  async assertTabStillActive() {
    let tab;
    try {
      tab = await chrome.tabs.get(this.tabId);
    } catch {
      throw new LongShotError('PAGE_NAVIGATED', 'Tab was closed');
    }
    if (!tab.active || tab.windowId !== this.windowId) throw new LongShotError('TAB_SWITCHED');
    if (tab.status === 'loading' && tab.url && this.tab.url && tab.url !== this.tab.url) {
      throw new LongShotError('PAGE_NAVIGATED');
    }
  }

  /** captureVisibleTab, respecting Chrome's 2-calls-per-second quota. */
  async grabViewport() {
    this.throwIfCancelled();
    await this.assertTabStillActive();

    for (let attempt = 0; ; attempt += 1) {
      const wait = this.lastCaptureAt + LIMITS.CAPTURE_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCaptureAt = Date.now();
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(this.windowId, { format: 'png' });
        await this.assertTabStillActive();
        const blob = await (await fetch(dataUrl)).blob();
        return blob;
      } catch (error) {
        if (error instanceof LongShotError) throw error;
        const message = String(error?.message || error);
        if (message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') && attempt < 5) {
          await sleep(600 + attempt * 200);
          continue;
        }
        const lsError = toLongShotError(error);
        if (['RESTRICTED_PAGE', 'WEB_STORE', 'NO_ACCESS', 'FILE_ACCESS', 'PAGE_NAVIGATED'].includes(lsError.code)) throw lsError;
        throw new LongShotError('CAPTURE_FAILED', message);
      }
    }
  }

  /**
   * Store a captured viewport as a tile.
   * @param {Blob} blob
   * @param {object} metrics  Agent snapshot taken right before capturing.
   * @param {{top:number,bottom:number,left:number,right:number}} clip  Viewport CSS px.
   */
  async storeTile(blob, metrics, clip, phase) {
    let dims;
    try {
      dims = await readPngDimensions(blob);
    } catch (error) {
      throw new LongShotError('IMAGE_LOAD_FAILED', error.message);
    }

    const { innerWidth, innerHeight } = metrics.viewport;
    const scale = dims.width / innerWidth;
    if (!this.viewport) {
      this.viewport = { innerWidth, innerHeight, imageWidth: dims.width, imageHeight: dims.height };
      this.captureScale = scale;
      log.info('Capture scale', scale, 'viewport', innerWidth, innerHeight, 'dpr', metrics.dpr);
    } else if (
      innerWidth !== this.viewport.innerWidth ||
      innerHeight !== this.viewport.innerHeight ||
      dims.width !== this.viewport.imageWidth ||
      dims.height !== this.viewport.imageHeight
    ) {
      throw new LongShotError('WINDOW_RESIZED');
    }

    const index = this.tiles.length;
    const key = blobKey.tile(this.sessionId, index);
    await putBlob(key, this.sessionId, blob);
    const tile = {
      index,
      key,
      phase,
      imageWidth: dims.width,
      imageHeight: dims.height,
      scrollTop: metrics.scrollTop,
      bandTop: clip.top,
      bandBottom: clip.bottom,
      bandLeft: clip.left,
      bandRight: clip.right,
      contentTop: metrics.scrollTop + (clip.top - metrics.origin),
    };
    this.tiles.push(tile);
    log.debug('Tile', index, phase, tile);
    return tile;
  }

  report(patch) {
    this.onProgress({ sessionId: this.sessionId, ...patch });
  }

  // ---------------------------------------------------------------- flows

  async run() {
    const { tab, mode, settings } = this;
    const createdAt = Date.now();
    await assertCapturable(tab, mode);

    this.report({ phase: 'preparing', percent: 1 });
    await putSession({
      id: this.sessionId,
      createdAt,
      status: 'capturing',
      mode,
      title: tab.title || '',
      url: tab.url || '',
      hostname: hostnameOf(tab.url),
    });

    try {
      let agentReady = false;
      try {
        await injectAgent(this.tabId);
        agentReady = true;
      } catch (error) {
        // Visible-area capture can still work where scripting is blocked (e.g. PDF viewer).
        if (mode !== CaptureMode.VISIBLE || ['RESTRICTED_PAGE', 'WEB_STORE', 'NO_ACCESS', 'FILE_ACCESS'].includes(error.code)) {
          throw error;
        }
        log.info('Agent injection failed; capturing visible area without page metrics', error);
      }

      let startContent;
      if (!agentReady) {
        startContent = await this.captureVisibleWithoutAgent();
      } else {
        let restoreScroll = mode === CaptureMode.VISIBLE ? false : settings.restoreScroll;
        try {
          startContent = mode === CaptureMode.VISIBLE ? await this.captureVisible() : await this.captureScrolling();
        } catch (error) {
          restoreScroll = true; // cancelled/failed captures always return to where the user was
          throw error;
        } finally {
          await this.agent('restore', { restoreScroll }, 5_000).catch((error) => log.info('Restore skipped', error.code));
        }
      }

      this.throwIfCancelled();
      if (!this.tiles.length) throw new LongShotError('NOTHING_TO_CAPTURE');
      return await this.process({ createdAt, startContent });
    } catch (error) {
      await deleteSession(this.sessionId).catch(() => {});
      throw error;
    }
  }

  async captureVisibleWithoutAgent() {
    this.report({ phase: 'capturing', percent: 30, section: 1, sectionsTotal: 1 });
    const blob = await this.grabViewport();
    const dims = await readPngDimensions(blob);
    // Without page metrics assume the image maps 1:1 to the tab's viewport.
    const scale = self.devicePixelRatio || 1;
    const metrics = {
      viewport: { innerWidth: Math.round(dims.width / scale), innerHeight: Math.round(dims.height / scale) },
      scrollTop: 0,
      origin: 0,
      dpr: scale,
    };
    await this.storeTile(blob, metrics, { top: 0, bottom: metrics.viewport.innerHeight, left: 0, right: metrics.viewport.innerWidth }, 'single');
    return 0;
  }

  async captureVisible() {
    const metrics = await this.agent('prepare', { mode: this.mode, settings: this.agentSettings() });
    this.report({ phase: 'capturing', percent: 30, section: 1, sectionsTotal: 1 });
    const blob = await this.grabViewport();
    // Crop away scrollbars: keep the layout viewport only.
    await this.storeTile(blob, metrics, { ...metrics.band }, 'single');
    return metrics.scrollTop;
  }

  agentSettings() {
    const { pauseAnimations, hideFixedElements, preloadLazyContent } = this.settings;
    return { pauseAnimations, hideFixedElements, preloadLazyContent };
  }

  async captureScrolling() {
    const { mode, settings, region } = this;
    const delayMs = settings.captureDelay;

    let m = await this.agent('prepare', { mode, settings: this.agentSettings() });
    this.throwIfCancelled();
    log.info('Prepared', m);

    // Content-coordinate range to capture.
    let startContent = 0;
    let endContent = null;
    if (mode === CaptureMode.FROM_CURRENT) {
      startContent = m.scrollTop + (m.band.top - m.origin);
    } else if (mode === CaptureMode.REGION) {
      startContent = region.y;
      endContent = region.y + region.height;
    }
    const hardEnd = startContent + settings.maxPageLength;

    const bandHeight = m.band.bottom - m.band.top;
    if (bandHeight <= 0 || m.band.right - m.band.left <= 0) throw new LongShotError('NOTHING_TO_CAPTURE');

    // Scroll offset that puts `content` at the top of the capture band.
    const scrollTopFor = (content, metrics) => content - (metrics.band.top - metrics.origin);

    const regionFitsViewport =
      mode === CaptureMode.REGION &&
      region.y >= m.scrollTop + (m.band.top - m.origin) &&
      region.y + region.height <= m.scrollTop + (m.band.bottom - m.origin);

    if (settings.preloadLazyContent && !regionFitsViewport) {
      this.report({ phase: 'preloading', percent: 3 });
      m = await this.agent(
        'preload',
        { startTop: scrollTopFor(startContent, m), endContent: Math.min(endContent ?? Infinity, hardEnd), maxMs: 12_000 },
        45_000,
      );
      this.throwIfCancelled();
    }

    const firstTop = regionFitsViewport ? m.scrollTop : scrollTopFor(startContent, m);
    m = await this.agent('scrollTo', { top: firstTop, delayMs });

    let previousScrollTop = null;
    let droppedForGrowth = 0;

    for (;;) {
      this.throwIfCancelled();
      if (this.tiles.length >= LIMITS.MAX_TILES) {
        this.warnings.add('max-tiles');
        break;
      }

      const fullBandHeight = m.band.bottom - m.band.top;
      const viewTopContent = m.scrollTop + (m.band.top - m.origin);
      const viewBottomContent = viewTopContent + fullBandHeight;
      const limitEnd = Math.min(endContent ?? Infinity, hardEnd, m.scrollHeight);
      const atScrollEnd = m.scrollTop >= m.maxScroll - 0.5;
      const reachedEnd = atScrollEnd || viewBottomContent >= limitEnd - 0.5;
      const isFirst = this.tiles.length === 0;
      let phase = isFirst ? (reachedEnd ? 'single' : 'first') : reachedEnd ? 'last' : 'middle';
      // Headers and sidebars belong at the top of the *page*. When the capture
      // starts further down (From Here, or a tall Custom Area), showing them in
      // the first section would paint them over real content — hide them
      // instead. A Custom Area that fits on screen stays exactly as the user saw it.
      const startsBelowPageTop = isFirst && viewTopContent > 1 && !regionFitsViewport;
      if (startsBelowPageTop) phase = reachedEnd ? 'last' : 'middle';

      if (settings.hideFixedElements !== 'off') {
        m = await this.agent('setFixedPhase', { phase });
      }

      // Clip the band to the requested content range (region / page end / length cap).
      const clip = {
        top: Math.max(m.band.top, m.origin + (startContent - m.scrollTop)),
        bottom: Math.min(m.band.bottom, m.origin + (limitEnd - m.scrollTop)),
        left: m.band.left,
        right: m.band.right,
      };
      if (mode === CaptureMode.REGION) {
        clip.left = Math.max(m.band.left, region.x);
        clip.right = Math.min(m.band.right, region.x + region.width);
      }

      if (clip.bottom > clip.top && clip.right > clip.left) {
        const blob = await this.grabViewport();
        await this.storeTile(blob, m, clip, phase);
      }

      const total = Math.max(1, limitEnd - startContent);
      const done = Math.min(total, viewBottomContent - startContent);
      this.report({
        phase: 'capturing',
        percent: 4 + (CAPTURE_PROGRESS_SHARE - 4) * (done / total),
        section: this.tiles.length,
        sectionsTotal: Math.max(this.tiles.length, Math.ceil(total / fullBandHeight)),
        position: Math.round(Math.min(viewBottomContent, limitEnd)),
        positionTotal: Math.round(limitEnd),
        startContent: Math.round(startContent),
      });

      if (reachedEnd) {
        const cappedByLength = viewBottomContent >= hardEnd - 0.5 && m.scrollHeight > hardEnd;
        if (cappedByLength) {
          this.warnings.add('max-length');
          break;
        }
        if (mode === CaptureMode.REGION || !atScrollEnd || droppedForGrowth >= 50) break;

        // Infinite-scroll pages append content once the bottom is reached.
        const settled = await this.agent('scrollTo', { top: m.scrollTop, delayMs: Math.max(delayMs, 400) });
        if (settled.scrollHeight > m.scrollHeight + 1 && settled.maxScroll > m.scrollTop + 1) {
          // The tile just taken showed bottom-anchored fixed elements but is no
          // longer the last one: discard it and re-capture this same position
          // as a regular section (its key is reused, overwriting the blob).
          this.tiles.pop();
          droppedForGrowth += 1;
          m = settled;
          continue;
        }
        break;
      }

      // Advance by exactly one band, clamped to the real end of the page.
      previousScrollTop = m.scrollTop;
      const nextTop = Math.min(m.scrollTop + fullBandHeight, m.maxScroll);
      if (nextTop <= previousScrollTop + 0.5) break;

      let next = await this.agent('scrollTo', { top: nextTop, delayMs });
      if (next.scrollTop > previousScrollTop + fullBandHeight + 1) {
        // The page jumped past the band (scroll hijacking); try once more.
        next = await this.agent('scrollTo', { top: nextTop, delayMs });
        if (next.scrollTop > previousScrollTop + fullBandHeight + 1) this.warnings.add('scroll-jump');
      }
      if (next.scrollTop <= previousScrollTop + 0.5) {
        this.warnings.add('scroll-stalled');
        break;
      }
      m = next;
    }

    return startContent;
  }

  // ---------------------------------------------------------------- process

  async process({ createdAt, startContent }) {
    const { settings } = this;
    this.processing = true;
    this.report({ status: 'processing', phase: 'stitching', percent: CAPTURE_PROGRESS_SHARE });

    const format = settings.docsOptimized ? 'png' : settings.format;
    const contentStart = Math.min(...this.tiles.map((t) => t.contentTop));
    const job = {
      sessionId: this.sessionId,
      tiles: this.tiles,
      captureScale: this.captureScale,
      targetScale: targetScaleFor(settings.quality, this.captureScale),
      startContent: Number.isFinite(contentStart) ? contentStart : startContent,
      format,
      settings,
    };

    let result;
    try {
      result = await callOffscreen(Msg.OFFSCREEN_PROCESS, { job });
    } finally {
      this.processing = false;
    }
    this.throwIfCancelled();

    if (result.gaps?.length) this.warnings.add('gaps');
    const record = {
      status: 'done',
      completedAt: Date.now(),
      format,
      quality: settings.quality,
      docsOptimized: settings.docsOptimized,
      docsPageSize: settings.docsPageSize,
      captureScale: this.captureScale,
      output: result.output,
      outputs: result.outputs,
      preview: result.preview,
      partReason: result.partReason,
      warnings: [...this.warnings],
      tileCount: this.tiles.length,
      coordinates: settings.showCaptureCoordinates
        ? this.tiles.map((t) => ({
            index: t.index,
            phase: t.phase,
            scrollTop: t.scrollTop,
            contentTop: t.contentTop,
            band: [t.bandTop, t.bandBottom],
            placement: result.placements.find((p) => p.index === t.index) || null,
          }))
        : null,
    };
    await updateSession(this.sessionId, record);
    await deleteBlobs(this.sessionId, 'tile').catch(() => {});
    log.info('Capture finished', { createdAt, ...record });
    return { sessionId: this.sessionId, ...record };
  }
}
