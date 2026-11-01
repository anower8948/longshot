/**
 * Error codes and user-facing descriptions.
 */

export class LongShotError extends Error {
  /**
   * @param {string} code  One of the keys in ERROR_DESCRIPTIONS.
   * @param {string} [detail]  Technical detail for logs / advanced display.
   */
  constructor(code, detail) {
    super(detail || code);
    this.name = 'LongShotError';
    this.code = code;
    this.detail = detail || '';
  }
}

export const ERROR_DESCRIPTIONS = Object.freeze({
  RESTRICTED_PAGE: {
    title: 'This page can’t be captured',
    message: 'Chrome doesn’t allow extensions to capture browser pages such as chrome://, new tab, settings or other extension pages.',
    hint: 'Open a regular website and try again.',
  },
  WEB_STORE: {
    title: 'The Chrome Web Store is protected',
    message: 'For security, Chrome blocks all extensions from reading or capturing the Web Store.',
    hint: 'Use Chrome’s built-in screenshot tool (DevTools → ⌘/Ctrl+Shift+P → “Capture full size screenshot”).',
  },
  FILE_ACCESS: {
    title: 'Local files need permission',
    message: 'LongShot isn’t allowed to access file:// pages yet.',
    hint: 'Open chrome://extensions, click “Details” on LongShot and enable “Allow access to file URLs”.',
  },
  PDF_VIEWER: {
    title: 'PDF viewer supports visible area only',
    message: 'Chrome’s built-in PDF viewer can’t be scrolled by extensions, so full-page capture isn’t possible here.',
    hint: 'Use “Visible Area”, or export the PDF pages as images from a PDF app.',
  },
  NO_ACCESS: {
    title: 'No access to this tab',
    message: 'Chrome only lets LongShot capture a tab right after you click the toolbar icon or use a LongShot shortcut.',
    hint: 'Click the LongShot icon on this tab again, then start the capture.',
  },
  INJECTION_FAILED: {
    title: 'Couldn’t prepare the page',
    message: 'LongShot couldn’t run on this page. It may be restricted by an enterprise policy or still loading.',
    hint: 'Wait for the page to finish loading and try again.',
  },
  CAPTURE_FAILED: {
    title: 'Screenshot permission denied',
    message: 'Chrome refused to capture the tab.',
    hint: 'Click the LongShot icon on this tab (this grants access), keep the tab visible, and try again.',
  },
  TAB_SWITCHED: {
    title: 'Capture interrupted',
    message: 'The tab was switched or hidden during capture. Chrome can only capture the tab that’s currently visible.',
    hint: 'Keep the tab in front until the capture finishes.',
  },
  PAGE_NAVIGATED: {
    title: 'Page changed during capture',
    message: 'The page navigated or reloaded while LongShot was capturing it.',
    hint: 'Wait until the page is stable, then capture again.',
  },
  WINDOW_RESIZED: {
    title: 'Window resized during capture',
    message: 'The window size or zoom level changed mid-capture, so the sections no longer line up.',
    hint: 'Keep the window size and zoom unchanged while capturing.',
  },
  PINCH_ZOOM: {
    title: 'Page is pinch-zoomed',
    message: 'The page is magnified with a pinch/trackpad zoom, which makes accurate stitching impossible.',
    hint: 'Pinch out until the page is back to normal size, then try again. (Regular ⌘/Ctrl +/− zoom is fine.)',
  },
  NOTHING_TO_CAPTURE: {
    title: 'Nothing to capture',
    message: 'The selected area is empty or outside the page.',
    hint: 'Select a larger area and try again.',
  },
  PAGE_TOO_LARGE: {
    title: 'Page too large',
    message: 'The page is larger than LongShot’s configured maximum length.',
    hint: 'Increase “Maximum page length” in Settings, or turn on “Split long screenshots”.',
  },
  CANVAS_MEMORY: {
    title: 'Not enough memory for this image',
    message: 'Chrome ran out of canvas memory while building the image.',
    hint: 'Choose PNG (streams large images), lower the quality, or enable “Split long screenshots”.',
  },
  STORAGE_QUOTA: {
    title: 'Not enough disk space',
    message: 'LongShot stores captured sections temporarily on disk and ran out of space.',
    hint: 'Free some disk space and try again.',
  },
  STITCH_FAILED: {
    title: 'Stitching failed',
    message: 'The captured sections couldn’t be combined into an image.',
    hint: 'Try again with a longer capture delay (Settings → Capture delay).',
  },
  IMAGE_LOAD_FAILED: {
    title: 'Captured image couldn’t be read',
    message: 'One of the captured sections was corrupted or couldn’t be decoded.',
    hint: 'Try capturing again.',
  },
  DOWNLOAD_FAILED: {
    title: 'Download failed',
    message: 'The image was created but Chrome couldn’t save it.',
    hint: 'Check your download folder permissions, or use “Open Image” and save it from there.',
  },
  BUSY: {
    title: 'A capture is already running',
    message: 'LongShot can capture one page at a time.',
    hint: 'Wait for the current capture to finish or cancel it.',
  },
  SESSION_NOT_FOUND: {
    title: 'Screenshot no longer available',
    message: 'This capture was cleaned up to save disk space.',
    hint: 'Capture the page again.',
  },
  CANCELLED: {
    title: 'Capture cancelled',
    message: 'The page has been restored to its original state.',
    hint: '',
  },
  UNKNOWN: {
    title: 'Something went wrong',
    message: 'An unexpected error interrupted the capture. The page has been restored.',
    hint: 'Try again. If it keeps happening, enable Debug logging in Settings.',
  },
});

/** Conditions caused by the page or the user, not by a LongShot bug. */
export const EXPECTED_ERROR_CODES = new Set([
  'CANCELLED',
  'RESTRICTED_PAGE',
  'WEB_STORE',
  'FILE_ACCESS',
  'PDF_VIEWER',
  'NO_ACCESS',
  'TAB_SWITCHED',
  'PAGE_NAVIGATED',
  'WINDOW_RESIZED',
  'PINCH_ZOOM',
  'NOTHING_TO_CAPTURE',
  'BUSY',
  'SESSION_NOT_FOUND',
]);

/** Map a raw error (from Chrome APIs, canvas, IndexedDB...) to a LongShotError. */
export function toLongShotError(error) {
  if (error instanceof LongShotError) return error;
  if (error && typeof error === 'object' && error.code && ERROR_DESCRIPTIONS[error.code]) {
    return new LongShotError(error.code, error.detail || error.message);
  }

  const message = String(error?.message || error || '');
  const lower = message.toLowerCase();

  if (lower.includes('extensions gallery cannot be scripted') || lower.includes('webstore')) {
    return new LongShotError('WEB_STORE', message);
  }
  if (lower.includes('file://') || lower.includes('file url')) {
    return new LongShotError('FILE_ACCESS', message);
  }
  if (lower.includes('cannot access a chrome') || lower.includes('chrome://') || lower.includes('cannot be scripted')) {
    return new LongShotError('RESTRICTED_PAGE', message);
  }
  if (lower.includes('cannot access contents of') || lower.includes('missing host permission') || lower.includes('activetab')) {
    return new LongShotError('NO_ACCESS', message);
  }
  if (lower.includes('receiving end does not exist') || lower.includes('message port closed') || lower.includes('frame with id') || lower.includes('no tab with id')) {
    return new LongShotError('PAGE_NAVIGATED', message);
  }
  if (lower.includes('quota') && !lower.includes('capture_visible_tab')) {
    return new LongShotError('STORAGE_QUOTA', message);
  }
  if (lower.includes('canvas') || lower.includes('out of memory') || lower.includes('allocation')) {
    return new LongShotError('CANVAS_MEMORY', message);
  }
  return new LongShotError('UNKNOWN', message);
}

/** Plain, message-safe error payload. */
export function serializeError(error) {
  const lsError = toLongShotError(error);
  const description = ERROR_DESCRIPTIONS[lsError.code] || ERROR_DESCRIPTIONS.UNKNOWN;
  return {
    code: lsError.code,
    title: description.title,
    message: description.message,
    hint: description.hint,
    detail: lsError.detail,
  };
}
