/**
 * Formatting helpers for sizes, numbers and filenames.
 */

const numberFormatter = new Intl.NumberFormat();

export function formatNumber(value) {
  return numberFormatter.format(Math.round(value));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit >= 2 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDimensions(width, height) {
  return `${formatNumber(width)} × ${formatNumber(height)} px`;
}

export function formatScale(scale) {
  const rounded = Math.round(scale * 100) / 100;
  return `${rounded}×`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function timestampForFilename(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

/** Make a string safe for use as a Chrome download filename segment. */
export function sanitizeFilename(input, fallback = 'Screenshot') {
  const cleaned = String(input || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}
