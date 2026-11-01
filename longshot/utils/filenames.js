/**
 * Download filenames: "LongShot/<title> - <timestamp>.png", or a folder of
 * numbered parts for split captures.
 */

import { APP_NAME, FILE_EXTENSIONS } from './constants.js';
import { sanitizeFilename, timestampForFilename } from './format.js';

export function extensionForMime(mime) {
  if (mime === 'image/jpeg') return FILE_EXTENSIONS.jpeg;
  if (mime === 'image/webp') return FILE_EXTENSIONS.webp;
  return FILE_EXTENSIONS.png;
}

export function buildFilenames(session) {
  const title = sanitizeFilename(session.title || session.hostname, 'Screenshot');
  const stamp = timestampForFilename(new Date(session.createdAt));
  const base = `${title} - ${stamp}`;
  const count = session.outputs.length;
  const digits = Math.max(2, String(count).length);
  return session.outputs.map((part) => {
    const ext = extensionForMime(part.mime);
    const cropped = part.original ? ' (cropped)' : '';
    if (count === 1) return `${APP_NAME}/${base}${cropped}.${ext}`;
    const number = String(part.index + 1).padStart(digits, '0');
    return `${APP_NAME}/${base}/${title} - part ${number} of ${count}${cropped}.${ext}`;
  });
}

export function fallbackFilename(session, part) {
  return `${APP_NAME}/longshot-${session.createdAt}-${part.index + 1}.${extensionForMime(part.mime)}`;
}
