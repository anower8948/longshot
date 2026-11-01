/**
 * Shared constants. Imported by the service worker, offscreen document,
 * popup, options and result pages (all ES modules).
 */

export const APP_NAME = 'LongShot';

/** Capture modes exposed in the UI. */
export const CaptureMode = Object.freeze({
  FULL: 'full',
  VISIBLE: 'visible',
  REGION: 'region',
  FROM_CURRENT: 'current',
});

export const Quality = Object.freeze({
  STANDARD: 'standard',
  HIGH: 'high',
  MAXIMUM: 'maximum',
});

export const Format = Object.freeze({
  PNG: 'png',
  JPEG: 'jpeg',
  WEBP: 'webp',
});

export const MIME_TYPES = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

export const FILE_EXTENSIONS = Object.freeze({
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
});

/** Hard technical limits of Chrome / image formats / Google Docs. */
export const LIMITS = Object.freeze({
  // Chromium caps a canvas at 32,767 px per side and 268,435,456 px of area.
  CANVAS_MAX_SIDE: 32_767,
  CANVAS_MAX_AREA: 268_435_456,
  // WebP bitstreams cannot exceed 16,383 px per side.
  WEBP_MAX_SIDE: 16_383,
  // Google Docs rejects images above 25 megapixels or 50 MB.
  DOCS_MAX_PIXELS: 25_000_000,
  DOCS_MAX_BYTES: 50 * 1024 * 1024,
  // chrome.tabs.captureVisibleTab is limited to 2 calls per second.
  CAPTURE_MIN_INTERVAL_MS: 560,
  // Safety valve against runaway infinite-scroll pages.
  MAX_TILES: 800,
  // Rows rendered per strip while streaming an image to the encoder.
  STRIP_ROWS: 1024,
});

/**
 * Google Docs page content boxes (page size minus default 1in margins), as
 * height / width. An image taller than this ratio is shrunk by Docs to fit a
 * single page, so page-sized parts keep text at full page width.
 */
export const DOCS_PAGE_RATIOS = Object.freeze({
  letter: 9 / 6.5,
  a4: 9.69 / 6.27,
  legal: 12 / 6.5,
  pageless: Infinity,
});

/** Message types exchanged between extension contexts. */
export const Msg = Object.freeze({
  // popup / result page -> service worker
  START_CAPTURE: 'LS_START_CAPTURE',
  CANCEL_CAPTURE: 'LS_CANCEL_CAPTURE',
  GET_STATE: 'LS_GET_STATE',
  DOWNLOAD_SESSION: 'LS_DOWNLOAD_SESSION',
  OPEN_RESULT: 'LS_OPEN_RESULT',
  RESET_STATE: 'LS_RESET_STATE',
  // content script -> service worker
  REGION_SELECTED: 'LS_REGION_SELECTED',
  REGION_CANCELLED: 'LS_REGION_CANCELLED',
  USER_CANCEL: 'LS_USER_CANCEL',
  // service worker -> offscreen document
  OFFSCREEN_PROCESS: 'LS_OFFSCREEN_PROCESS',
  OFFSCREEN_CREATE_URLS: 'LS_OFFSCREEN_CREATE_URLS',
  OFFSCREEN_REVOKE_URLS: 'LS_OFFSCREEN_REVOKE_URLS',
  OFFSCREEN_CANCEL: 'LS_OFFSCREEN_CANCEL',
  OFFSCREEN_DELETE_TILES: 'LS_OFFSCREEN_DELETE_TILES',
  // offscreen document -> service worker
  OFFSCREEN_PROGRESS: 'LS_OFFSCREEN_PROGRESS',
  // service worker -> popup (via port)
  STATE_UPDATE: 'LS_STATE_UPDATE',
});

export const PORT_NAME = 'longshot-popup';
export const OFFSCREEN_TARGET = 'longshot-offscreen';
export const AGENT_TARGET = 'longshot-agent';

/** Files injected (in order) into the captured page. */
export const CONTENT_SCRIPT_FILES = Object.freeze([
  'content/dom-utils.js',
  'content/scroll-target.js',
  'content/page-freezer.js',
  'content/fixed-elements.js',
  'content/selection-overlay.js',
  'content/agent.js',
]);
