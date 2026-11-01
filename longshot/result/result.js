/**
 * Result page: shows a finished capture with Crop / Copy / Open / Download.
 *
 * URL: result.html#<sessionId>            view a capture
 *      result.html#<sessionId>&crop=<n>   open the crop editor on image n
 */

import { getSession, getBlob, putBlob, deleteBlob, updateSession, blobKey } from '../utils/image-db.js';
import { buildFilenames, fallbackFilename } from '../utils/filenames.js';
import { formatBytes, formatDimensions, formatNumber, formatScale } from '../utils/format.js';
import { LIMITS } from '../utils/constants.js';
import { cropImageBlob, normalizeCropRect } from '../capture/crop.js';
import { CropEditor } from './crop-editor.js';

const $ = (id) => document.getElementById(id);

// Show the full-resolution image inline up to this size (Chrome decodes it
// lazily). Beyond it a thumbnail is shown at its natural size — never stretched,
// so the page never makes a sharp capture look blurry.
const INLINE_PIXEL_LIMIT = 160_000_000;

const pageUrls = []; // object URLs that live as long as the page
let partUrls = []; // object URLs for the currently rendered images
let session = null;
let previewUrl = null;
let activeEditor = null;
let toastTimer = 0;

// ------------------------------------------------------------------ helpers

function toast(message, { error = false } = {}) {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 2_800);
}

function objectUrl(blob, { persistent = false } = {}) {
  const url = URL.createObjectURL(blob);
  (persistent ? pageUrls : partUrls).push(url);
  return url;
}

async function loadPartBlob(part) {
  const blob = await getBlob(part.key);
  if (!blob) throw new Error('Image data is no longer available');
  return blob;
}

function croppedFilename(filename) {
  if (/ \(cropped\)\.[a-z0-9]+$/i.test(filename)) return filename;
  return filename.replace(/(\.[a-z0-9]+)$/i, ' (cropped)$1');
}

async function downloadBlob(blob, filename, fallback) {
  // Kept for the page's lifetime: the download reads the blob asynchronously.
  const url = objectUrl(blob, { persistent: true });
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch {
    await chrome.downloads.download({ url, filename: fallback, conflictAction: 'uniquify', saveAs: false });
  }
}

async function toPngBlob(blob) {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width > LIMITS.CANVAS_MAX_SIDE || bitmap.height > LIMITS.CANVAS_MAX_SIDE) {
    bitmap.close();
    throw new Error('Image is too large to convert for the clipboard');
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

async function copyBlob(blob, label) {
  try {
    const png = await toPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(`${label} copied — paste it into your document`);
  } catch (error) {
    toast(`Couldn’t copy: ${error.message || error}`, { error: true });
  }
}

function button(label, icon, className = 'btn btn-glass') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.innerHTML = `${icon}<span>${label}</span>`;
  return element;
}

const ICONS = {
  crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
};

function partTitle(part) {
  return session.outputs.length > 1 ? `Image ${part.index + 1} of ${session.outputs.length}` : 'Screenshot';
}

// ------------------------------------------------------------------ crop

/** Persist a crop: the cropped image replaces the part, the original is kept for restore. */
async function applyCrop(part, rect) {
  const crop = normalizeCropRect(rect, part.width, part.height);
  const source = await loadPartBlob(part);
  const blob = await cropImageBlob(source, crop, {
    mime: part.mime,
    quality: 0.95,
    dpi: Math.round(96 * (session.output.scale || 1)),
  });

  const key = `${blobKey.output(session.id, part.index)}-crop-${Date.now()}`;
  await putBlob(key, session.id, blob);

  const original = part.original || { key: part.key, width: part.width, height: part.height, bytes: part.bytes };
  if (part.original && part.key !== original.key) await deleteBlob(part.key).catch(() => {});

  const updated = {
    ...part,
    key,
    width: crop.width,
    height: crop.height,
    bytes: blob.size,
    original,
    // Offset of the crop within the original image (crops can be repeated).
    cropOffset: { x: (part.cropOffset?.x || 0) + crop.x, y: (part.cropOffset?.y || 0) + crop.y },
  };
  await saveOutputs(session.outputs.map((p) => (p.index === part.index ? updated : p)));
  toast(`Cropped to ${formatDimensions(crop.width, crop.height)}`);
}

async function restoreOriginal(part) {
  if (!part.original) return;
  const restored = { ...part, ...part.original };
  delete restored.original;
  delete restored.cropOffset;
  await saveOutputs(session.outputs.map((p) => (p.index === part.index ? restored : p)));
  await deleteBlob(part.key).catch(() => {});
  toast('Original image restored');
}

async function saveOutputs(outputs) {
  const output = {
    ...session.output,
    width: Math.max(...outputs.map((p) => p.width)),
    height: outputs.reduce((sum, p) => sum + p.height, 0),
    totalBytes: outputs.reduce((sum, p) => sum + p.bytes, 0),
  };
  session = (await updateSession(session.id, { outputs, output })) || { ...session, outputs, output };
  await renderAll();
}

function openCropEditor(part, frame) {
  if (activeEditor?.frame === frame) return; // already cropping this image
  if (activeEditor) activeEditor.close();
  const filename = buildFilenames(session)[part.index];
  activeEditor = new CropEditor({
    frame,
    image: { width: part.width, height: part.height },
    title: session.outputs.length > 1 ? `image ${part.index + 1}` : 'screenshot',
    onApply: async (rect) => {
      try {
        await applyCrop(part, rect);
      } catch (error) {
        toast(`Couldn’t crop: ${error.message || error}`, { error: true });
        throw error;
      }
    },
    onCopy: async (rect) => {
      const crop = normalizeCropRect(rect, part.width, part.height);
      const blob = await cropImageBlob(await loadPartBlob(part), crop, { mime: 'image/png', dpi: Math.round(96 * (session.output.scale || 1)) });
      await copyBlob(blob, 'Cropped image');
    },
    onDownload: async (rect) => {
      try {
        const crop = normalizeCropRect(rect, part.width, part.height);
        const blob = await cropImageBlob(await loadPartBlob(part), crop, { mime: part.mime, dpi: Math.round(96 * (session.output.scale || 1)) });
        await downloadBlob(blob, croppedFilename(filename), croppedFilename(fallbackFilename(session, part)));
        toast('Cropped image download started');
      } catch (error) {
        toast(`Download failed: ${error.message || error}`, { error: true });
      }
    },
    onClose: () => {
      activeEditor = null;
    },
  });
  activeEditor.open();
}

// ------------------------------------------------------------------ render

function addSeamMarkers(frame, part) {
  if (!session.coordinates || part.original) return;
  for (const tile of session.coordinates) {
    const top = tile.placement?.outTop;
    if (typeof top !== 'number' || top <= part.top || top >= part.bottom) continue;
    const marker = document.createElement('div');
    marker.className = 'seam';
    marker.style.top = `${((top - part.top) / part.height) * 100}%`;
    marker.innerHTML = `<span>#${tile.index} · row ${formatNumber(top)}</span>`;
    frame.append(marker);
  }
}

async function renderPart(part, filename) {
  const card = document.createElement('article');
  card.className = 'part glass';
  card.dataset.index = String(part.index);

  const head = document.createElement('div');
  head.className = 'part-head';
  const title = document.createElement('strong');
  title.textContent = partTitle(part);
  const meta = document.createElement('span');
  meta.className = 'muted num';
  meta.textContent = `${formatDimensions(part.width, part.height)} · ${formatBytes(part.bytes)} · ${((part.width * part.height) / 1e6).toFixed(1)} MP`;
  if (part.original) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Cropped';
    title.append(' ', badge);
  }

  const actions = document.createElement('div');
  actions.className = 'part-actions';
  const cropButton = button('Crop', ICONS.crop);
  cropButton.dataset.action = 'crop';
  const copyButton = button('Copy', ICONS.copy);
  const openButton = button('Open', ICONS.open);
  const downloadButton = button('Download', ICONS.download);
  if (part.original) {
    const restoreButton = button('Restore Original', ICONS.restore);
    restoreButton.dataset.action = 'restore';
    restoreButton.addEventListener('click', () => restoreOriginal(part).catch((error) => toast(error.message, { error: true })));
    actions.append(restoreButton);
  }
  actions.append(cropButton, copyButton, openButton, downloadButton);
  head.append(title, meta, actions);

  const canvas = document.createElement('div');
  canvas.className = 'canvas';
  const frame = document.createElement('div');
  frame.className = 'image-frame';
  const img = document.createElement('img');
  img.decoding = 'async';
  img.alt = session.outputs.length > 1 ? `Screenshot part ${part.index + 1}` : 'Captured screenshot';
  img.draggable = false;

  // Display at CSS size so the preview matches the original page.
  frame.style.width = `${Math.round(part.width / (session.output.scale || 1))}px`;
  frame.style.aspectRatio = `${part.width} / ${part.height}`;

  const blob = await loadPartBlob(part);
  const fullUrl = objectUrl(blob);

  const tooLargeInline = part.width * part.height > INLINE_PIXEL_LIMIT;
  if (tooLargeInline && previewUrl && session.outputs.length === 1 && !part.original) {
    img.src = previewUrl;
    frame.style.width = `${session.preview?.width || 480}px`;
    frame.append(img);
    canvas.append(frame);
    const note = document.createElement('p');
    note.className = 'preview-note';
    note.textContent = 'Small preview — this image is too large to display here. Use Open or Download to see it at full resolution.';
    canvas.append(note);
  } else {
    img.src = fullUrl;
    frame.append(img);
    canvas.append(frame);
  }
  addSeamMarkers(frame, part);

  cropButton.addEventListener('click', () => openCropEditor(part, frame));
  copyButton.addEventListener('click', () => copyBlob(blob, session.outputs.length > 1 ? `Image ${part.index + 1}` : 'Image'));
  openButton.addEventListener('click', () => window.open(fullUrl, '_blank'));
  downloadButton.addEventListener('click', async () => {
    try {
      await downloadBlob(blob, filename, fallbackFilename(session, part));
      toast('Download started');
    } catch (error) {
      toast(`Download failed: ${error.message}`, { error: true });
    }
  });

  card.append(head, canvas);
  return card;
}

async function renderAll() {
  activeEditor?.close();
  for (const url of partUrls) URL.revokeObjectURL(url);
  partUrls = [];

  renderSummary();
  const filenames = buildFilenames(session);
  const cards = [];
  for (const part of session.outputs) cards.push(await renderPart(part, filenames[part.index]));
  $('parts').replaceChildren(...cards);
}

function renderSummary() {
  const { output, outputs } = session;
  $('stat-resolution').textContent = formatDimensions(output.width, output.height);
  $('stat-format').textContent = session.format.toUpperCase();
  $('stat-size').textContent = formatBytes(output.totalBytes);
  $('stat-parts').textContent = outputs.length === 1 ? (outputs[0].original ? 'Single image · cropped' : 'Single image') : `${outputs.length} images`;
  $('stat-scale').textContent = `${formatScale(output.scale)}${output.scale < session.captureScale - 0.01 ? ` of ${formatScale(session.captureScale)}` : ''}`;
  $('stat-date').textContent = new Date(session.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('summary').hidden = false;
}

function renderGuidance() {
  const count = session.outputs.length;
  const callout = $('docs-callout');
  const mac = /Mac/.test(navigator.platform);
  if (session.docsOptimized) {
    $('docs-callout-title').textContent = count > 1 ? `Ready for Google Docs — ${count} page-sized images` : 'Ready for Google Docs';
    $('docs-callout-text').textContent =
      count > 1
        ? `Each image fills one page at full sharpness and is cut between lines of text. In Docs, choose Insert → Image → Upload from computer and select all ${count} files, or click Copy on each image and paste (${mac ? '⌘V' : 'Ctrl+V'}) in order.`
        : `Click Copy and paste (${mac ? '⌘V' : 'Ctrl+V'}) into your document, or use Insert → Image → Upload from computer.`;
    callout.hidden = false;
  } else if (session.output.height > session.output.width * 1.6) {
    $('docs-callout-title').textContent = 'Inserting into Google Docs?';
    $('docs-callout-text').textContent =
      'Docs shrinks images taller than one page to fit, which makes long screenshots unreadable, and rejects images over 25 MP. Use Crop to keep just the part you need, or turn on “Google Docs Optimized” in the LongShot popup to get page-sized, full-resolution images.';
    callout.hidden = false;
  }

  const notes = [];
  const warnings = {
    'max-length': 'The page is longer than the maximum page length in Settings, so the capture stopped early.',
    'max-tiles': 'The page kept growing (infinite scroll), so the capture stopped at a safe limit.',
    'scroll-stalled': 'The page stopped scrolling before its end; the capture includes everything reachable.',
    'scroll-jump': 'The page adjusted its own scroll position during capture; check for seams.',
    gaps: 'The page moved during capture, so a few rows may be missing. Try a longer capture delay.',
  };
  for (const warning of session.warnings || []) if (warnings[warning]) notes.push(warnings[warning]);
  if (notes.length) {
    const container = $('notes');
    for (const text of notes) {
      const p = document.createElement('p');
      p.textContent = text;
      container.append(p);
    }
    container.hidden = false;
  }
}

function renderDebug() {
  if (!session.coordinates?.length) return;
  const body = $('debug-rows');
  for (const tile of session.coordinates) {
    const row = document.createElement('tr');
    const cells = [
      tile.index,
      tile.phase,
      tile.scrollTop.toFixed(1),
      tile.contentTop.toFixed(1),
      `${tile.band[0].toFixed(1)} → ${tile.band[1].toFixed(1)}`,
      tile.placement ? `${formatNumber(tile.placement.outTop)} → ${formatNumber(tile.placement.outBottom)}` : '—',
    ];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    }
    body.append(row);
  }
  $('debug').hidden = false;
}

function showEmpty(title, text) {
  $('page-title').textContent = 'LongShot';
  $('empty-title').textContent = title;
  if (text) $('empty-text').textContent = text;
  $('empty').hidden = false;
}

// ------------------------------------------------------------------ init

function parseHash() {
  const [id, ...rest] = location.hash.slice(1).split('&');
  const params = new URLSearchParams(rest.join('&'));
  const crop = params.get('crop');
  return { sessionId: decodeURIComponent(id || ''), cropIndex: crop === null ? null : Number(crop) };
}

async function init() {
  const { sessionId, cropIndex } = parseHash();
  if (!sessionId) {
    showEmpty('No screenshot selected');
    return;
  }

  session = await getSession(sessionId).catch(() => null);
  if (!session || session.status !== 'done' || !session.outputs?.length) {
    showEmpty('Screenshot not found');
    return;
  }

  document.title = `${session.title || session.hostname || 'Screenshot'} — LongShot`;
  $('page-title').textContent = session.title || session.hostname || 'Screenshot';
  const link = $('page-url');
  link.textContent = session.url;
  if (/^https?:/i.test(session.url)) link.href = session.url;

  const previewBlob = await getBlob(blobKey.preview(session.id)).catch(() => null);
  if (previewBlob) previewUrl = objectUrl(previewBlob, { persistent: true });

  renderGuidance();
  try {
    await renderAll();
  } catch (error) {
    showEmpty('Screenshot not found', error.message);
    return;
  }
  renderDebug();

  const downloadAll = $('download-all');
  const updateDownloadLabel = () => {
    $('download-all-label').textContent = session.outputs.length > 1 ? `Download All (${session.outputs.length})` : 'Download';
  };
  updateDownloadLabel();
  downloadAll.disabled = false;
  downloadAll.addEventListener('click', async () => {
    downloadAll.disabled = true;
    try {
      const filenames = buildFilenames(session);
      for (const part of session.outputs) {
        await downloadBlob(await loadPartBlob(part), filenames[part.index], fallbackFilename(session, part));
      }
      toast(session.outputs.length > 1 ? `${session.outputs.length} downloads started` : 'Download started');
    } catch (error) {
      toast(`Download failed: ${error.message}`, { error: true });
    } finally {
      downloadAll.disabled = false;
    }
  });

  if (session.outputs.length === 1) {
    const copyFirst = $('copy-first');
    copyFirst.hidden = false;
    copyFirst.addEventListener('click', async () => copyBlob(await loadPartBlob(session.outputs[0]), 'Image'));
  }

  if (Number.isInteger(cropIndex)) {
    const card = document.querySelector(`.part[data-index="${cropIndex}"]`);
    card?.querySelector('[data-action="crop"]')?.click();
  }
}

window.addEventListener('pagehide', () => {
  for (const url of [...pageUrls, ...partUrls]) URL.revokeObjectURL(url);
});

init();
