/**
 * Popup controller: capture options, live progress, results.
 */

import { Msg, PORT_NAME, CaptureMode, DOCS_PAGE_RATIOS } from '../utils/constants.js';
import { getSettings, saveSettings } from '../utils/storage.js';
import { classifyUrl, hostnameOf } from '../utils/page-detection.js';
import { ERROR_DESCRIPTIONS, serializeError } from '../utils/errors.js';
import { formatBytes, formatDimensions, formatNumber, formatScale } from '../utils/format.js';
import { targetScaleFor } from '../capture/stitch-plan.js';
import { getBlob, getSession, blobKey } from '../utils/image-db.js';

const $ = (id) => document.getElementById(id);
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const VIEWS = ['view-main', 'view-selecting', 'view-progress', 'view-done', 'view-error'];

const PHASE_TITLES = {
  preparing: 'Preparing page…',
  preloading: 'Loading lazy content…',
  capturing: 'Capturing page…',
  cancelling: 'Cancelling…',
  planning: 'Finding clean page breaks…',
  stitching: 'Stitching sections…',
  encoding: 'Encoding image…',
};

// Rough compressed bytes per pixel for typical text-heavy screenshots.
const BYTES_PER_PIXEL = { png: 0.42, jpeg: 0.16, webp: 0.1 };

const ui = {
  tab: null,
  settings: null,
  page: null, // measurements of the current page
  pageError: null,
  state: { status: 'idle' },
  port: null,
  thumbUrl: null,
  currentView: null,
};

// ------------------------------------------------------------------ helpers

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response) throw new Error('No response from LongShot');
    if (!response.ok) {
      const error = new Error(response.error?.message || 'Error');
      Object.assign(error, response.error);
      throw error;
    }
    return response.data;
  });
}

function showView(id) {
  if (ui.currentView === id) return;
  ui.currentView = id;
  for (const viewId of VIEWS) $(viewId).hidden = viewId !== id;
}

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

// ------------------------------------------------------------------ page probe

/** Injected into the page (activeTab) to measure it for the size estimate. */
function probePage() {
  const root = document.documentElement;
  const scroller = document.scrollingElement || root;
  const viewportWidth = root.clientWidth || window.innerWidth;
  const viewportHeight = root.clientHeight || window.innerHeight;
  let contentHeight = scroller.scrollHeight;
  let contentWidth = viewportWidth;
  let scrollTop = window.scrollY;
  let inner = false;

  if (scroller.scrollHeight - viewportHeight < viewportHeight * 0.15 && document.body) {
    // App-style layout: find the main scrolling container.
    let best = null;
    let bestArea = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let visited = 0;
    while (walker.nextNode() && visited < 8000) {
      visited += 1;
      const el = walker.currentNode;
      if (el.scrollHeight - el.clientHeight < 32 || el.clientHeight < 80) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (!/(auto|scroll|overlay)/.test(overflow)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea && area > viewportWidth * viewportHeight * 0.2) {
        best = el;
        bestArea = area;
      }
    }
    if (best && best.scrollHeight - best.clientHeight > (scroller.scrollHeight - viewportHeight) * 2) {
      inner = true;
      contentHeight = best.scrollHeight;
      contentWidth = best.clientWidth;
      scrollTop = best.scrollTop;
    }
  }

  return {
    title: document.title,
    viewportWidth,
    viewportHeight,
    contentWidth,
    contentHeight,
    scrollTop,
    inner,
    dpr: window.devicePixelRatio || 1,
    pinchZoomed: window.visualViewport ? Math.abs(window.visualViewport.scale - 1) > 0.01 : false,
  };
}

async function measurePage() {
  const { tab } = ui;
  const classification = classifyUrl(tab.url);
  if (!classification.capturable) {
    ui.pageError = classification.code;
    return;
  }
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage });
    ui.page = injection?.result || null;
    if (classification.limited) ui.pageLimited = classification.limited;
  } catch (error) {
    const payload = serializeError(error);
    // Visible area still works in some unscriptable views (e.g. the PDF viewer).
    ui.pageError = payload.code === 'UNKNOWN' ? 'INJECTION_FAILED' : payload.code;
  }
}

// ------------------------------------------------------------------ main view

function renderPageChip() {
  const dot = $('chip-dot');
  const host = hostnameOf(ui.tab?.url) || ui.tab?.title || 'This page';
  $('page-host').textContent = host;

  const restricted = $('restricted');
  if (ui.pageError) {
    dot.className = 'chip-dot bad';
    $('page-detail').textContent = 'Not capturable';
    const description = ERROR_DESCRIPTIONS[ui.pageError] || ERROR_DESCRIPTIONS.UNKNOWN;
    $('restricted-title').textContent = description.title;
    $('restricted-message').textContent = description.hint || description.message;
    restricted.hidden = false;
    return;
  }
  restricted.hidden = true;

  if (!ui.page) {
    dot.className = 'chip-dot';
    $('page-detail').textContent = 'Measuring…';
    return;
  }

  dot.className = 'chip-dot ok';
  const { dpr, contentWidth, contentHeight, inner } = ui.page;
  const density = dpr >= 2 ? `${formatScale(dpr)} Retina` : `${formatScale(dpr)} display`;
  const layout = inner ? ' · app layout' : '';
  $('page-detail').textContent = `${density} · page ${formatNumber(contentWidth)} × ${formatNumber(contentHeight)} CSS px${layout}`;
}

function qualityNote(quality, dpr) {
  const scale = targetScaleFor(quality, dpr);
  if (quality === 'standard') return dpr > 1 ? `${formatScale(scale)} · smaller files` : `${formatScale(scale)} · native`;
  if (quality === 'high') return dpr >= 2 ? `${formatScale(scale)} · sharp text` : `${formatScale(scale)} · display maximum`;
  return `${formatScale(scale)} · full native resolution`;
}

function renderQuality() {
  const dpr = ui.page?.dpr || window.devicePixelRatio || 1;
  const quality = radioValue('quality');
  $('quality-note').textContent = qualityNote(quality, dpr);

  const limit = $('quality-limit');
  const target = quality === 'maximum' ? dpr : quality === 'high' ? 2 : 1;
  if (dpr < target - 0.01) {
    limit.hidden = false;
    limit.textContent = `Your display is ${formatScale(dpr)} and LongShot never upscales. For sharper text, zoom the page in (${IS_MAC ? '⌘' : 'Ctrl'} +) first.`;
  } else if (quality === 'maximum' && Math.abs(dpr - 2) < 0.01) {
    limit.hidden = false;
    limit.textContent = 'Same as High here — 2× is this display’s maximum.';
  } else {
    limit.hidden = true;
  }
}

function renderFormat() {
  const docs = $('docs-optimized').checked;
  for (const input of document.querySelectorAll('input[name="format"]')) {
    input.disabled = docs;
  }
  if (docs) setRadio('format', 'png');
  const format = radioValue('format');
  $('format-note').textContent = docs ? 'PNG · required for Docs' : format === 'png' ? 'Lossless · best for text' : format === 'jpeg' ? 'Smaller · slight blur on text' : 'Smallest · not supported by Docs';
}

function renderEstimate() {
  const estimate = $('estimate');
  const mode = radioValue('mode');
  if (!ui.page || ui.pageError) {
    estimate.hidden = true;
    return;
  }
  if (mode === CaptureMode.REGION) {
    estimate.hidden = false;
    estimate.innerHTML = '<span>Select any area on the page after you start — even taller than the screen.</span>';
    return;
  }

  const { dpr, contentWidth, contentHeight, viewportHeight, scrollTop } = ui.page;
  const scale = targetScaleFor(radioValue('quality'), dpr);
  const cssHeight = mode === CaptureMode.VISIBLE ? viewportHeight : mode === CaptureMode.FROM_CURRENT ? Math.max(viewportHeight, contentHeight - scrollTop) : contentHeight;
  const cappedHeight = Math.min(cssHeight, ui.settings.maxPageLength);
  const width = Math.round(contentWidth * scale);
  const height = Math.round(cappedHeight * scale);
  const docs = $('docs-optimized').checked;
  const format = docs ? 'png' : radioValue('format');
  const bytes = width * height * BYTES_PER_PIXEL[format];

  const parts = [`<span><b>≈ ${formatDimensions(width, height)}</b></span>`, `<span>≈ ${formatBytes(bytes)}</span>`];
  if (docs && mode !== CaptureMode.VISIBLE) {
    const ratio = DOCS_PAGE_RATIOS[ui.settings.docsPageSize];
    const pageHeight = Number.isFinite(ratio) ? Math.min(width * ratio * 0.98, 25_000_000 / width) : 25_000_000 / width;
    const count = Math.max(1, Math.ceil(height / pageHeight));
    parts.push(`<span>${count} Docs page${count === 1 ? '' : 's'}</span>`);
  }
  estimate.innerHTML = parts.join('');
  estimate.hidden = false;
}

function renderStartButton() {
  const mode = radioValue('mode');
  const labels = {
    full: 'Capture Full Page',
    visible: 'Capture Visible Area',
    region: 'Select Area',
    current: 'Capture From Here',
  };
  $('start-label').textContent = labels[mode] || 'Start Capture';

  const pdfLimited = ui.pageLimited === 'PDF_VIEWER' && mode !== CaptureMode.VISIBLE;
  const blocked = Boolean(ui.pageError) && !(mode === CaptureMode.VISIBLE && ui.pageError === 'INJECTION_FAILED');
  $('start').disabled = blocked || pdfLimited;
  // Nothing can be captured on this page at all: don't show options that can't apply.
  const nothingCapturable = Boolean(ui.pageError) && ui.pageError !== 'INJECTION_FAILED';
  $('modes').hidden = nothingCapturable;
  $('options').hidden = nothingCapturable;
  $('start').hidden = nothingCapturable;
  if (pdfLimited && !ui.pageError) {
    $('restricted').hidden = false;
    $('restricted-title').textContent = ERROR_DESCRIPTIONS.PDF_VIEWER.title;
    $('restricted-message').textContent = ERROR_DESCRIPTIONS.PDF_VIEWER.message;
  } else if (!ui.pageError) {
    $('restricted').hidden = true;
  }
}

async function renderShortcutHint() {
  try {
    const commands = await chrome.commands.getAll();
    const full = commands.find((c) => c.name === 'capture-full-page');
    if (full?.shortcut) {
      $('shortcut-hint').innerHTML = `Full page <span class="kbd">${full.shortcut.replace(/\+/g, ' ')}</span>`;
    }
  } catch {
    // ignore
  }
}

function renderMain() {
  renderPageChip();
  renderQuality();
  renderFormat();
  renderEstimate();
  renderStartButton();
}

function persistChoices() {
  saveSettings({
    quality: radioValue('quality'),
    format: $('docs-optimized').checked ? ui.settings.format : radioValue('format'),
    docsOptimized: $('docs-optimized').checked,
    lastMode: radioValue('mode'),
  })
    .then((settings) => {
      ui.settings = settings;
    })
    .catch(() => {});
}

async function startCapture() {
  const mode = radioValue('mode');
  const button = $('start');
  button.disabled = true;
  const requestedAt = Date.now();
  // Switch to the progress view *before* asking the worker to start: a fast
  // capture (Visible Area) can finish before the reply arrives, and its "done"
  // update must find the popup already waiting for it.
  if (mode !== CaptureMode.REGION) renderProgress({ status: 'capturing', phase: 'preparing', percent: 0 });
  try {
    const data = await sendMessage({
      type: Msg.START_CAPTURE,
      tabId: ui.tab.id,
      mode,
      overrides: {
        quality: radioValue('quality'),
        format: radioValue('format'),
        docsOptimized: $('docs-optimized').checked,
      },
    });
    if (data?.selecting) {
      window.close();
      return;
    }
    // Apply the latest state in case it changed while the request was in flight
    // (ignoring anything left over from a previous capture).
    const state = await sendMessage({ type: Msg.GET_STATE }).catch(() => null);
    if (state && state.status !== 'idle' && state.updatedAt >= requestedAt) applyState(state);
  } catch (error) {
    renderError(error);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ progress

function renderProgress(state) {
  showView('view-progress');
  const percent = Math.max(0, Math.min(100, state.percent || 0));
  $('progress-percent').textContent = `${Math.round(percent)}%`;
  $('ring-value').style.strokeDashoffset = String(213.6 * (1 - percent / 100));
  $('progress-fill').style.width = `${percent}%`;
  $('progress-bar').setAttribute('aria-valuenow', String(Math.round(percent)));

  let title = PHASE_TITLES[state.phase] || 'Working…';
  if (state.status === 'processing' && state.partCount > 1) {
    title = `${state.phase === 'planning' ? 'Finding clean page breaks' : 'Encoding image'} ${Math.min(state.partIndex + 1, state.partCount)} of ${state.partCount}…`;
  }
  $('progress-title').textContent = title;

  if (state.status === 'processing') {
    $('progress-section').textContent = state.partCount ? `Image ${Math.min((state.partIndex || 0) + 1, state.partCount)} / ${state.partCount}` : 'Stitching';
    $('progress-position').textContent = state.rowsTotal ? `${formatNumber(state.rowsDone)} / ${formatNumber(state.rowsTotal)} px` : '—';
  } else {
    $('progress-section').textContent = state.section ? `${state.section} / ${state.sectionsTotal}` : '—';
    $('progress-position').textContent = state.positionTotal ? `${formatNumber(state.position)} / ${formatNumber(state.positionTotal)} px` : '—';
  }
  $('cancel-capture').disabled = state.phase === 'cancelling';
}

// ------------------------------------------------------------------ done

const PART_REASONS = {
  'docs-page': 'Split into Google Docs page-sized images at clean line breaks — insert them in order.',
  'docs-megapixels': 'Split to stay under Google Docs’ 25-megapixel limit — insert the images in order.',
  split: 'Split into parts as set in Settings.',
  'format-limit': 'Split because the image exceeds this format’s maximum size. Choose PNG for a single image.',
  'max-height': 'Split because it exceeds the maximum image height set in Settings.',
};

const WARNINGS = {
  'max-length': 'The page is longer than the maximum page length in Settings, so the capture stopped early.',
  'max-tiles': 'The page kept growing (infinite scroll), so the capture stopped at a safe limit.',
  'scroll-stalled': 'The page stopped scrolling before its end; the capture includes everything reachable.',
  'scroll-jump': 'The page adjusted its own scroll position during capture; check the result for seams.',
  gaps: 'The page moved during capture, so a few rows may be missing. Try a longer capture delay.',
};

async function renderDone(state) {
  showView('view-done');
  let result = state.result;
  if (!result) return;
  // The capture may have been cropped on the result page since it finished.
  const stored = await getSession(result.sessionId).catch(() => null);
  if (stored?.output && stored.outputs) {
    result = { ...result, width: stored.output.width, height: stored.output.height, totalBytes: stored.output.totalBytes, parts: stored.outputs.length };
  }

  $('done-resolution').textContent = formatDimensions(result.width, result.height);
  $('done-format').textContent = `${result.format.toUpperCase()} · ${formatScale(result.scale)}`;
  $('done-size').textContent = formatBytes(result.totalBytes);
  $('done-parts').textContent = result.parts === 1 ? 'Single image' : `${result.parts} images`;

  let subtitle = state.downloaded ? (result.parts > 1 ? 'Saved to Downloads › LongShot folder' : 'Saved to Downloads › LongShot') : 'Ready — not downloaded yet';
  if (state.downloadError) subtitle = 'Created, but the download failed';
  $('done-subtitle').textContent = subtitle;
  $('download-label').textContent = 'Download';
  $('crop-image').title = result.parts > 1 ? 'Open the images to crop any of them' : 'Trim the screenshot — keep only the part you need';

  const notes = [];
  if (result.parts > 1 && PART_REASONS[result.partReason]) notes.push(PART_REASONS[result.partReason]);
  for (const warning of result.warnings || []) if (WARNINGS[warning]) notes.push(WARNINGS[warning]);
  const note = $('done-note');
  note.hidden = notes.length === 0;
  note.textContent = notes.join(' ');
  note.classList.toggle('warn', (result.warnings || []).length > 0);

  if (!ui.thumbUrl) {
    try {
      const blob = await getBlob(blobKey.preview(result.sessionId));
      if (blob) {
        ui.thumbUrl = URL.createObjectURL(blob);
        $('done-thumb-img').src = ui.thumbUrl;
        $('done-thumb').hidden = false;
      }
    } catch {
      // preview is optional
    }
  }
}

// ------------------------------------------------------------------ error

function renderError(error) {
  showView('view-error');
  const code = error?.code && ERROR_DESCRIPTIONS[error.code] ? error.code : 'UNKNOWN';
  const description = ERROR_DESCRIPTIONS[code];
  const cancelled = code === 'CANCELLED';
  $('error-title').textContent = error?.title || description.title;
  $('error-message').textContent = error?.message && error.title ? error.message : description.message;
  const hint = error?.hint ?? description.hint;
  $('error-hint').hidden = !hint;
  $('error-hint').textContent = hint || '';
  $('error-icon').className = `status-icon ${cancelled ? 'neutral' : 'danger'}`;
  const detail = error?.detail;
  $('error-detail-wrap').hidden = !detail || cancelled;
  $('error-detail').textContent = detail || '';
  $('error-retry').textContent = cancelled ? 'Capture Again' : 'Try Again';
}

// ------------------------------------------------------------------ state

function applyState(state) {
  ui.state = state;
  const sameTab = !state.tabId || state.tabId === ui.tab?.id;
  const age = Date.now() - (state.updatedAt || 0);
  // Terminal states are shown when the popup was waiting on them (fresh open,
  // progress or selection view) — never over something the user is doing.
  const awaiting = ui.currentView === null || ui.currentView === 'view-progress' || ui.currentView === 'view-selecting';

  if (state.status === 'capturing' || state.status === 'processing') {
    renderProgress(state);
    return;
  }
  if (state.status === 'selecting') {
    showView('view-selecting');
    return;
  }
  if (state.status === 'done' && sameTab && awaiting && age < 120_000) {
    renderDone(state);
    return;
  }
  if ((state.status === 'error' || state.status === 'cancelled') && sameTab && awaiting && age < 30_000) {
    renderError(state.error);
    return;
  }
  if (awaiting) {
    showView('view-main');
    renderMain();
  }
}

function connectPort() {
  ui.port = chrome.runtime.connect({ name: PORT_NAME });
  ui.port.onMessage.addListener((message) => {
    if (message?.type === Msg.STATE_UPDATE) applyState(message.state);
  });
  ui.port.onDisconnect.addListener(() => {
    // The worker restarted; reconnect so progress keeps flowing.
    setTimeout(connectPort, 250);
  });
}

function backToMain() {
  sendMessage({ type: Msg.RESET_STATE }).catch(() => {});
  if (ui.thumbUrl) {
    URL.revokeObjectURL(ui.thumbUrl);
    ui.thumbUrl = null;
    $('done-thumb').hidden = true;
  }
  ui.currentView = null;
  showView('view-main');
  renderMain();
}

// ------------------------------------------------------------------ init

function bindEvents() {
  for (const input of document.querySelectorAll('input[name="mode"], input[name="quality"], input[name="format"]')) {
    input.addEventListener('change', () => {
      renderMain();
      persistChoices();
    });
  }
  $('docs-optimized').addEventListener('change', () => {
    renderMain();
    persistChoices();
  });
  $('start').addEventListener('click', startCapture);
  $('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('open-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  $('cancel-capture').addEventListener('click', () => {
    $('cancel-capture').disabled = true;
    sendMessage({ type: Msg.CANCEL_CAPTURE }).catch(() => {});
  });
  $('cancel-selection').addEventListener('click', async () => {
    await sendMessage({ type: Msg.CANCEL_CAPTURE }).catch(() => {});
    backToMain();
  });

  const openResult = async (crop) => {
    const sessionId = ui.state.result?.sessionId;
    if (!sessionId) return;
    try {
      await sendMessage({ type: Msg.OPEN_RESULT, sessionId, tabId: ui.tab?.id, crop });
      window.close();
    } catch (error) {
      renderError(error);
    }
  };
  $('open-image').addEventListener('click', () => openResult(false));
  $('crop-image').addEventListener('click', () => openResult(true));

  $('download-again').addEventListener('click', async () => {
    const sessionId = ui.state.result?.sessionId;
    if (!sessionId) return;
    const button = $('download-again');
    button.disabled = true;
    try {
      await sendMessage({ type: Msg.DOWNLOAD_SESSION, sessionId });
      $('download-label').textContent = 'Saved ✓';
      $('done-subtitle').textContent = 'Saved to Downloads › LongShot';
    } catch (error) {
      renderError(error);
    } finally {
      setTimeout(() => {
        button.disabled = false;
        $('download-label').textContent = 'Download';
      }, 1_600);
    }
  });

  $('new-capture').addEventListener('click', backToMain);
  $('error-back').addEventListener('click', backToMain);
  $('error-retry').addEventListener('click', () => {
    backToMain();
    if (!ui.pageError) startCapture();
  });
}

async function init() {
  bindEvents();
  ui.settings = await getSettings();
  setRadio('mode', ui.settings.lastMode);
  setRadio('quality', ui.settings.quality);
  setRadio('format', ui.settings.format);
  $('docs-optimized').checked = ui.settings.docsOptimized;

  [ui.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  renderShortcutHint();

  const state = await sendMessage({ type: Msg.GET_STATE }).catch(() => ({ status: 'idle' }));
  applyState(state);
  connectPort();

  if (ui.tab) {
    await measurePage();
    if (ui.currentView === 'view-main') renderMain();
  }
}

init().catch((error) => {
  console.error('[LongShot] Popup failed to initialise', error);
  renderError(serializeError(error));
});
