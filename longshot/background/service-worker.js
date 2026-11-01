/**
 * LongShot service worker: routes messages, keyboard commands and capture
 * lifecycle. All listeners are registered synchronously at top level, as
 * Manifest V3 requires for events to wake a suspended worker.
 */

import { Msg, CaptureMode } from '../utils/constants.js';
import { getSettings, normalizeSettings } from '../utils/storage.js';
import { getSession, pruneSessions } from '../utils/image-db.js';
import { LongShotError, serializeError, EXPECTED_ERROR_CODES } from '../utils/errors.js';
import { setDebugLogging, createLogger } from '../utils/logger.js';
import { initStateHub, getState, setState, loadState } from './state-hub.js';
import { CaptureController, assertCapturable, injectAgent, sendToAgent } from './capture-controller.js';
import { downloadSession, initDownloadTracking, scheduleClose } from './downloads.js';

const log = createLogger('sw');
const PENDING_REGION_KEY = 'pendingRegion';

/** @type {CaptureController | null} */
let activeController = null;
// Set synchronously when a capture is requested, before any await, so two
// near-simultaneous requests (double click, shortcut + popup) can't both start.
let captureStarting = false;
const isCaptureActive = () => Boolean(activeController) || captureStarting;

initStateHub();
initDownloadTracking(isCaptureActive);

chrome.runtime.onInstalled.addListener(() => {
  pruneSessions({ keep: 3 }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  pruneSessions({ keep: 3 }).catch(() => {});
});

// ------------------------------------------------------------------ capture

/** Per-capture overrides chosen in the popup (validated like stored settings). */
function applyOverrides(settings, overrides = {}) {
  const allowed = ['quality', 'format', 'docsOptimized'];
  const picked = Object.fromEntries(Object.entries(overrides).filter(([key]) => allowed.includes(key)));
  return normalizeSettings({ ...settings, ...picked });
}

function resultSummary(result) {
  return {
    sessionId: result.sessionId,
    width: result.output.width,
    height: result.output.height,
    scale: result.output.scale,
    captureScale: result.captureScale,
    format: result.format,
    totalBytes: result.output.totalBytes,
    parts: result.outputs.length,
    partReason: result.partReason,
    docsOptimized: result.docsOptimized,
    warnings: result.warnings,
  };
}

async function openResultPage(sessionId, sourceTab, { crop = false } = {}) {
  const url = chrome.runtime.getURL(`result/result.html#${encodeURIComponent(sessionId)}${crop ? '&crop=0' : ''}`);
  const createProperties = { url, active: true };
  if (sourceTab && typeof sourceTab.index === 'number') {
    createProperties.index = sourceTab.index + 1;
    createProperties.windowId = sourceTab.windowId;
  }
  try {
    await chrome.tabs.create(createProperties);
  } catch {
    await chrome.tabs.create({ url, active: true });
  }
}

async function startCapture({ tab, mode, overrides, region }) {
  if (isCaptureActive()) throw new LongShotError('BUSY');
  captureStarting = true;
  let controller;
  try {
    const settings = applyOverrides(await getSettings(), overrides);
    setDebugLogging(settings.debugLogging);
    // Keep only the most recent results so screenshots don't accumulate on disk.
    await pruneSessions({ keep: 3 }).catch(() => {});
    controller = new CaptureController({
      tab,
      mode,
      settings,
      region,
      onProgress: (patch) => {
        if (activeController === controller) setState(patch);
      },
    });
    activeController = controller;
  } finally {
    captureStarting = false;
  }
  const { settings } = controller;
  setState(
    {
      status: 'capturing',
      tabId: tab.id,
      mode,
      phase: 'preparing',
      percent: 0,
      startedAt: Date.now(),
      sessionId: controller.sessionId,
      docsOptimized: settings.docsOptimized,
    },
    { replace: true },
  );

  try {
    const result = await controller.run();
    const summary = resultSummary(result);
    let downloadError = null;

    if (settings.autoDownload) {
      try {
        const session = await getSession(result.sessionId);
        await downloadSession(session, isCaptureActive);
      } catch (error) {
        log.error('Download failed', error);
        downloadError = serializeError(error);
      }
    }

    activeController = null;
    setState({ status: 'done', tabId: tab.id, mode, percent: 100, result: summary, downloaded: settings.autoDownload && !downloadError, downloadError }, { replace: true });

    if (settings.openResultAfterCapture || !settings.autoDownload || downloadError) {
      await openResultPage(result.sessionId, tab);
    }
  } catch (error) {
    const payload = serializeError(error);
    // Expected conditions (restricted page, cancel…) must not land in chrome://extensions → Errors.
    if (EXPECTED_ERROR_CODES.has(payload.code)) log.info('Capture ended', payload.code, payload.detail);
    else log.error('Capture failed', error);
    activeController = null;
    setState({ status: payload.code === 'CANCELLED' ? 'cancelled' : 'error', tabId: tab.id, mode, error: payload }, { replace: true });
  } finally {
    if (activeController === controller) activeController = null;
    // Pending downloads keep the offscreen document alive; otherwise release it.
    scheduleClose(isCaptureActive);
  }
}

async function beginRegionSelection(tab, overrides) {
  if (isCaptureActive()) throw new LongShotError('BUSY');
  await assertCapturable(tab, CaptureMode.REGION);
  await injectAgent(tab.id);
  const settings = await getSettings();
  await chrome.storage.session.set({
    [PENDING_REGION_KEY]: { tabId: tab.id, overrides, startedAt: Date.now() },
  });
  setState({ status: 'selecting', tabId: tab.id, mode: CaptureMode.REGION }, { replace: true });
  await sendToAgent(tab.id, 'startSelection', { showCoordinates: settings.showCaptureCoordinates });
}

async function takePendingRegion(tabId) {
  const stored = await chrome.storage.session.get(PENDING_REGION_KEY);
  const pending = stored[PENDING_REGION_KEY];
  if (!pending || pending.tabId !== tabId) return null;
  await chrome.storage.session.remove(PENDING_REGION_KEY);
  return pending;
}

async function handleStart({ tabId, mode, overrides }) {
  if (!Object.values(CaptureMode).includes(mode)) throw new LongShotError('UNKNOWN', `Unknown mode ${mode}`);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new LongShotError('PAGE_NAVIGATED', 'Tab no longer exists');
  }

  if (mode === CaptureMode.REGION) {
    await beginRegionSelection(tab, overrides);
    return { selecting: true };
  }

  if (isCaptureActive()) throw new LongShotError('BUSY');
  // Validate synchronously so the popup can show restricted-page errors instantly.
  await assertCapturable(tab, mode);
  startCapture({ tab, mode, overrides }).catch((error) => log.error(error));
  return { started: true };
}

async function handleCancel() {
  if (activeController) {
    activeController.cancel();
    return { cancelled: true };
  }
  const state = getState();
  if (state.status === 'selecting' && state.tabId) {
    await chrome.storage.session.remove(PENDING_REGION_KEY);
    await sendToAgent(state.tabId, 'cancelSelection', {}, 3_000).catch(() => {});
    setState({ status: 'idle' }, { replace: true });
  }
  return { cancelled: false };
}

/**
 * A "selecting" state outlives the overlay if the page was reloaded, navigated
 * or closed mid-selection. Ask the page before showing it as still active.
 */
async function verifySelectionStillActive() {
  const state = getState();
  if (state.status !== 'selecting') return;
  const alive = state.tabId ? await sendToAgent(state.tabId, 'ping', {}, 1_500).then((r) => r.selecting).catch(() => false) : false;
  if (!alive) {
    await chrome.storage.session.remove(PENDING_REGION_KEY).catch(() => {});
    setState({ status: 'idle' }, { replace: true });
  }
}

// ------------------------------------------------------------------ routing

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages with a `target` are addressed to the page agent or offscreen document.
  if (!message || typeof message.type !== 'string' || message.target) return false;

  const respond = (work) => {
    Promise.resolve()
      .then(work)
      .then(
        (data) => sendResponse({ ok: true, data }),
        (error) => sendResponse({ ok: false, error: serializeError(error) }),
      );
    return true;
  };

  switch (message.type) {
    case Msg.START_CAPTURE:
      return respond(() => handleStart(message));

    case Msg.CANCEL_CAPTURE:
      return respond(handleCancel);

    case Msg.GET_STATE:
      return respond(async () => {
        await loadState();
        await verifySelectionStillActive();
        return getState();
      });

    case Msg.RESET_STATE:
      return respond(() => {
        if (!activeController && getState().status !== 'selecting') setState({ status: 'idle' }, { replace: true });
        return true;
      });

    case Msg.DOWNLOAD_SESSION:
      return respond(async () => {
        const session = await getSession(message.sessionId);
        if (!session || session.status !== 'done') throw new LongShotError('SESSION_NOT_FOUND');
        return downloadSession(session, isCaptureActive);
      });

    case Msg.OPEN_RESULT:
      return respond(async () => {
        const session = await getSession(message.sessionId);
        if (!session || session.status !== 'done') throw new LongShotError('SESSION_NOT_FOUND');
        let sourceTab = null;
        if (typeof message.tabId === 'number') sourceTab = await chrome.tabs.get(message.tabId).catch(() => null);
        // Crop opens the editor directly when there is a single image.
        await openResultPage(message.sessionId, sourceTab, { crop: Boolean(message.crop) && session.outputs.length === 1 });
        return true;
      });

    case Msg.REGION_SELECTED:
      if (!sender.tab) return false;
      return respond(async () => {
        const pending = await takePendingRegion(sender.tab.id);
        if (!pending) return false;
        const { rect } = message;
        if (!rect || rect.width < 1 || rect.height < 1) throw new LongShotError('NOTHING_TO_CAPTURE');
        setState({ status: 'idle' }, { replace: true });
        startCapture({ tab: sender.tab, mode: CaptureMode.REGION, overrides: pending.overrides, region: rect }).catch((error) => log.error(error));
        return true;
      });

    case Msg.REGION_CANCELLED:
      if (!sender.tab) return false;
      return respond(async () => {
        await takePendingRegion(sender.tab.id);
        if (getState().status === 'selecting') setState({ status: 'idle' }, { replace: true });
        return true;
      });

    case Msg.USER_CANCEL:
      if (!sender.tab) return false;
      return respond(() => {
        if (activeController && activeController.tabId === sender.tab.id) activeController.cancel();
        return true;
      });

    case Msg.OFFSCREEN_PROGRESS:
      if (activeController && activeController.sessionId === message.sessionId) {
        const { rowsDone, rowsTotal, partIndex, partCount, stage } = message.progress;
        const fraction = rowsTotal > 0 ? rowsDone / rowsTotal : 0;
        setState({
          status: 'processing',
          phase: stage,
          percent: 82 + 17 * fraction,
          partIndex,
          partCount,
          rowsDone,
          rowsTotal,
        });
      }
      return false;

    default:
      return false;
  }
});

// ------------------------------------------------------------------ commands

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = command === 'capture-full-page' ? CaptureMode.FULL : command === 'capture-visible-area' ? CaptureMode.VISIBLE : null;
  if (!mode) return;
  try {
    const targetTab = tab?.id ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!targetTab) return;
    if (activeController) {
      // Pressing the shortcut again while capturing acts as a cancel.
      activeController.cancel();
      return;
    }
    await assertCapturable(targetTab, mode);
    await startCapture({ tab: targetTab, mode, overrides: {} });
  } catch (error) {
    setState({ status: 'error', mode, error: serializeError(error) }, { replace: true });
  }
});
