/**
 * Offscreen document: stitches captured tiles and encodes the final images.
 *
 * Runs in a hidden extension page because service workers cannot create blob:
 * URLs (needed by chrome.downloads) and heavy image work should not block the
 * service worker's event handling.
 */

import { Msg, OFFSCREEN_TARGET, MIME_TYPES } from '../utils/constants.js';
import { getBlob, putBlob, blobKey, getSession, deleteBlobs } from '../utils/image-db.js';
import { buildLayout, planPartHeights } from '../capture/stitch-plan.js';
import { TileSource, renderParts } from '../capture/stitcher.js';
import { serializeError, LongShotError, EXPECTED_ERROR_CODES } from '../utils/errors.js';
import { createLogger, setDebugLogging } from '../utils/logger.js';

const log = createLogger('offscreen');
const cancelledSessions = new Set();
const urlsBySession = new Map();

function sendProgress(sessionId, progress) {
  chrome.runtime.sendMessage({ type: Msg.OFFSCREEN_PROGRESS, sessionId, progress }).catch(() => {});
}

async function processJob(job) {
  const { sessionId, tiles, captureScale, startContent, settings } = job;
  setDebugLogging(settings.debugLogging);
  log.info('Processing session', sessionId, { tiles: tiles.length, captureScale });

  let layout = buildLayout({
    tiles,
    captureScale,
    targetScale: job.targetScale,
    startContent,
  });

  let partPlan = planPartHeights({
    outputWidth: layout.outputWidth,
    outputHeight: layout.outputHeight,
    format: job.format,
    settings,
  });

  if (partPlan.needsScaleDown < 1) {
    // Only reachable when the output is wider than the format allows.
    layout = buildLayout({
      tiles,
      captureScale,
      targetScale: layout.outputScale * partPlan.needsScaleDown,
      startContent,
    });
    partPlan = planPartHeights({
      outputWidth: layout.outputWidth,
      outputHeight: layout.outputHeight,
      format: job.format,
      settings,
    });
  }

  log.info('Layout', {
    output: `${layout.outputWidth}×${layout.outputHeight}`,
    ratio: layout.ratio,
    gaps: layout.gaps,
    partPlan,
  });

  const source = new TileSource((key) => getBlob(key));
  const outputs = [];
  let lastProgressAt = 0;

  try {
    const result = await renderParts({
      layout,
      source,
      format: job.format,
      partPlan,
      settings,
      isCancelled: () => cancelledSessions.has(sessionId),
      onProgress: (progress) => {
        const now = performance.now();
        if (now - lastProgressAt > 120 || progress.rowsDone === progress.rowsTotal) {
          lastProgressAt = now;
          sendProgress(sessionId, progress);
        }
      },
      onPart: async ({ index, blob, top, bottom, width, height }) => {
        const key = blobKey.output(sessionId, index);
        await putBlob(key, sessionId, blob);
        outputs.push({ index, key, width, height, top, bottom, bytes: blob.size, mime: MIME_TYPES[job.format] });
      },
    });

    await putBlob(blobKey.preview(sessionId), sessionId, result.previewBlob);

    return {
      outputs,
      output: {
        width: layout.outputWidth,
        height: layout.outputHeight,
        scale: layout.outputScale,
        captureScale,
        totalBytes: outputs.reduce((sum, part) => sum + part.bytes, 0),
      },
      preview: { width: result.previewWidth, height: result.previewHeight },
      partReason: outputs.length > 1 ? partPlan.reason : 'single',
      gaps: layout.gaps,
      placements: layout.tiles.map((t) => ({ index: t.index, outTop: t.outTop, outBottom: t.outBottom })),
    };
  } finally {
    source.close();
    cancelledSessions.delete(sessionId);
  }
}

async function createUrls(sessionId) {
  revokeUrls(sessionId);
  const session = await getSession(sessionId);
  if (!session || !session.outputs?.length) throw new LongShotError('SESSION_NOT_FOUND');
  const urls = [];
  for (const part of session.outputs) {
    const blob = await getBlob(part.key);
    if (!blob) throw new LongShotError('SESSION_NOT_FOUND');
    urls.push({ index: part.index, url: URL.createObjectURL(blob) });
  }
  urlsBySession.set(sessionId, urls);
  return urls;
}

function revokeUrls(sessionId) {
  const urls = urlsBySession.get(sessionId);
  if (!urls) return;
  for (const { url } of urls) URL.revokeObjectURL(url);
  urlsBySession.delete(sessionId);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== OFFSCREEN_TARGET) return false;

  const respond = (promise) => {
    promise
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        const payload = serializeError(error);
        if (!EXPECTED_ERROR_CODES.has(payload.code)) log.error(error);
        sendResponse({ ok: false, error: payload });
      });
    return true;
  };

  switch (message.type) {
    case Msg.OFFSCREEN_PROCESS:
      return respond(processJob(message.job));
    case Msg.OFFSCREEN_CREATE_URLS:
      return respond(createUrls(message.sessionId));
    case Msg.OFFSCREEN_REVOKE_URLS:
      return respond(Promise.resolve(revokeUrls(message.sessionId)));
    case Msg.OFFSCREEN_CANCEL:
      cancelledSessions.add(message.sessionId);
      return respond(Promise.resolve(true));
    case Msg.OFFSCREEN_DELETE_TILES:
      return respond(deleteBlobs(message.sessionId, 'tile'));
    default:
      return false;
  }
});
