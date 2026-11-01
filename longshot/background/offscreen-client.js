/**
 * Manages the offscreen document that stitches and encodes images.
 */

import { OFFSCREEN_TARGET } from '../utils/constants.js';
import { LongShotError } from '../utils/errors.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let creating = null;
let busyCount = 0;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

export async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: 'Stitch captured screenshot sections and encode the final image files for download.',
      })
      .catch((error) => {
        // Another caller may have created it in the meantime.
        if (!String(error?.message).includes('single offscreen')) throw error;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send a request to the offscreen document and unwrap its { ok, data | error } reply. */
export async function callOffscreen(type, payload = {}) {
  busyCount += 1;
  try {
    await ensureOffscreenDocument();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type, ...payload });
        if (!response) throw new Error('Receiving end does not exist (no response)');
        if (!response.ok) {
          throw new LongShotError(response.error?.code || 'UNKNOWN', response.error?.detail || response.error?.message);
        }
        return response.data;
      } catch (error) {
        if (error instanceof LongShotError) throw error;
        const message = String(error?.message || error);
        const transient = message.includes('Receiving end does not exist') || message.includes('message port closed');
        if (transient && attempt < 8) {
          await sleep(100 + attempt * 50);
          await ensureOffscreenDocument();
          continue;
        }
        throw new LongShotError('STITCH_FAILED', message);
      }
    }
  } finally {
    busyCount -= 1;
  }
}

export function isOffscreenBusy() {
  return busyCount > 0;
}

export async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch {
    // already closed
  }
}
