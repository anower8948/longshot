/**
 * Saves finished screenshots through chrome.downloads.
 *
 * Blob URLs are minted by the offscreen document (service workers can't
 * create them). The offscreen document is closed once every download has
 * finished, which releases the blobs.
 */

import { Msg } from '../utils/constants.js';
import { LongShotError } from '../utils/errors.js';
import { buildFilenames, fallbackFilename } from '../utils/filenames.js';
import { callOffscreen, closeOffscreenDocument, isOffscreenBusy } from './offscreen-client.js';

const pendingDownloads = new Map(); // downloadId -> sessionId
let closeTimer = 0;

export function initDownloadTracking(isCaptureActive) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!pendingDownloads.has(delta.id) || !delta.state) return;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      pendingDownloads.delete(delta.id);
      scheduleClose(isCaptureActive);
    }
  });
}

/** Close the offscreen document once no work or downloads depend on it. */
export function scheduleClose(isCaptureActive) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (pendingDownloads.size === 0 && !isOffscreenBusy() && !isCaptureActive()) {
      closeOffscreenDocument();
    }
  }, 3_000);
}

async function downloadOne(url, filename, fallbackName) {
  try {
    return await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (error) {
    // Some titles still produce names Chrome rejects; fall back to a plain name.
    if (String(error?.message).toLowerCase().includes('filename')) {
      return chrome.downloads.download({ url, filename: fallbackName, conflictAction: 'uniquify', saveAs: false });
    }
    throw error;
  }
}

/**
 * @param {object} session  Session record from IndexedDB (status "done").
 * @param {() => boolean} isCaptureActive
 * @returns {Promise<number[]>} download ids
 */
export async function downloadSession(session, isCaptureActive) {
  if (!session?.outputs?.length) throw new LongShotError('SESSION_NOT_FOUND');
  const urls = await callOffscreen(Msg.OFFSCREEN_CREATE_URLS, { sessionId: session.id });
  const filenames = buildFilenames(session);
  const ids = [];

  try {
    for (const { index, url } of urls) {
      const part = session.outputs.find((p) => p.index === index);
      const id = await downloadOne(url, filenames[index], fallbackFilename(session, part));
      if (typeof id === 'number') {
        pendingDownloads.set(id, session.id);
        ids.push(id);
      }
    }
  } catch (error) {
    throw new LongShotError('DOWNLOAD_FAILED', error?.message);
  }
  if (!ids.length) scheduleClose(isCaptureActive);
  return ids;
}
