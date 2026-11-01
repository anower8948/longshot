/**
 * LongShot page agent — command handler.
 *
 * The service worker drives the capture; this agent performs page-side steps
 * (prepare, scroll, fixed-element phases, restore) and reports exact metrics.
 * A watchdog restores the page automatically if the service worker stops
 * sending commands (e.g. the extension was reloaded mid-capture), so a page
 * is never left modified.
 */
(() => {
  const ns = globalThis.__longshot;
  if (ns.agentInstalled) return;
  ns.agentInstalled = true;

  const TARGET = 'longshot-agent';
  const WATCHDOG_MS = 25_000;
  const { frames, sleep, waitForMedia } = ns.dom;

  const Messages = {
    REGION_SELECTED: 'LS_REGION_SELECTED',
    REGION_CANCELLED: 'LS_REGION_CANCELLED',
    USER_CANCEL: 'LS_USER_CANCEL',
  };

  /** @type {null | { target, freezer, fixed, originalScroll, lastCommandAt, aborted, keyHandler, watchdog }} */
  let session = null;
  let selection = null;

  class AgentError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  function snapshot(target) {
    const metrics = target.measure();
    return {
      ...metrics,
      targetKind: target.kind,
      viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      dpr: window.devicePixelRatio || 1,
      visualScale: window.visualViewport ? window.visualViewport.scale : 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }

  function requireSession() {
    if (!session) throw new AgentError('PAGE_NAVIGATED', 'Capture session is not active on this page');
    session.lastCommandAt = Date.now();
    return session;
  }

  function touch() {
    if (session) session.lastCommandAt = Date.now();
  }

  function restoreSession({ restoreScroll }) {
    const current = session;
    if (!current) return false;
    session = null;
    current.aborted = true;
    clearInterval(current.watchdog);
    window.removeEventListener('keydown', current.keyHandler, true);

    try {
      current.fixed?.restore();
    } catch (error) {
      console.warn('[LongShot] Failed to restore fixed elements', error);
    }
    if (restoreScroll) {
      const { x, y, targetTop } = current.originalScroll;
      if (current.target.kind === 'element') current.target.scrollTo(targetTop);
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
    }
    try {
      current.freezer?.restore();
    } catch (error) {
      console.warn('[LongShot] Failed to restore page styles', error);
    }
    return true;
  }

  const handlers = {
    ping() {
      return { ready: true, active: Boolean(session), selecting: Boolean(selection) };
    },

    async prepare({ mode, settings }) {
      if (session) restoreSession({ restoreScroll: true });
      selection?.unmount();
      selection = null;

      if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) {
        throw new AgentError('PINCH_ZOOM');
      }

      const scrolling = mode === 'full' || mode === 'current';
      const target = scrolling ? ns.scroll.detect() : ns.scroll.windowTarget();
      const current = {
        target,
        freezer: null,
        fixed: null,
        originalScroll: { x: window.scrollX, y: window.scrollY, targetTop: target.getTop() },
        lastCommandAt: Date.now(),
        aborted: false,
        keyHandler: (event) => {
          if (event.key === 'Escape') {
            chrome.runtime.sendMessage({ type: Messages.USER_CANCEL }).catch(() => {});
          }
        },
        watchdog: 0,
      };
      session = current;

      window.addEventListener('keydown', current.keyHandler, true);
      current.watchdog = setInterval(() => {
        if (session === current && Date.now() - current.lastCommandAt > WATCHDOG_MS) {
          console.warn('[LongShot] Capture stalled; restoring the page.');
          restoreSession({ restoreScroll: true });
        }
      }, 2_000);

      if (mode !== 'visible') {
        const hideMode = settings.hideFixedElements;
        current.freezer = new ns.PageFreezer();
        current.freezer.apply({
          pauseAnimations: settings.pauseAnimations,
          neutralizeFixedBackgrounds: hideMode !== 'off',
          eagerImages: settings.preloadLazyContent,
        });
        if (hideMode !== 'off') {
          current.fixed = new ns.FixedElementManager({ mode: hideMode, scrollElement: target.element });
          current.fixed.scan(target.measure().band);
        }
      }

      if (document.fonts && document.fonts.status !== 'loaded') {
        await Promise.race([document.fonts.ready, sleep(1_500)]);
      }
      await frames(2);

      return {
        ...snapshot(target),
        title: document.title,
        url: location.href,
        trackedFixedElements: current.fixed ? current.fixed.records.size : 0,
      };
    },

    /**
     * Scroll through the capture range once so lazy loaders and infinite lists
     * populate and the layout settles before real capture begins.
     */
    async preload({ startTop, endContent, maxMs }) {
      const current = requireSession();
      const { target } = current;
      const startedAt = performance.now();
      target.scrollTo(startTop);

      while (!current.aborted && performance.now() - startedAt < maxMs) {
        await frames(1);
        await sleep(90);
        const metrics = target.measure();
        await waitForMedia(metrics.band, 450);
        touch();
        const bandHeight = metrics.band.bottom - metrics.band.top;
        const contentBottom = metrics.scrollTop + (metrics.band.bottom - metrics.origin);
        if (metrics.scrollTop >= metrics.maxScroll - 1) break;
        if (endContent !== null && contentBottom >= endContent) break;
        target.scrollTo(metrics.scrollTop + Math.max(1, bandHeight));
        if (target.getTop() <= metrics.scrollTop + 0.5) break;
      }

      if (current.aborted) throw new AgentError('CANCELLED');
      target.scrollTo(startTop);
      await frames(2);
      await sleep(150);
      return snapshot(target);
    },

    async scrollTo({ top, delayMs = 0, mediaTimeoutMs = 2_500 }) {
      const current = requireSession();
      const { target } = current;
      target.scrollTo(top);
      await frames(2);
      if (delayMs > 0) await sleep(delayMs);
      touch();
      await waitForMedia(target.measure().band, delayMs > 0 ? mediaTimeoutMs : 300);
      await frames(2);
      if (current.aborted) throw new AgentError('CANCELLED');
      return snapshot(target);
    },

    async setFixedPhase({ phase }) {
      const current = requireSession();
      const { target, fixed } = current;
      let stats = { hidden: 0, tracked: 0 };
      if (fixed) {
        fixed.scan(target.measure().band);
        stats = fixed.applyPhase(phase);
        await frames(2);
        await sleep(30);
      }
      return { ...snapshot(target), fixedStats: stats };
    },

    measure() {
      const current = requireSession();
      return snapshot(current.target);
    },

    abort() {
      if (session) session.aborted = true;
      return true;
    },

    async restore({ restoreScroll = true }) {
      const restored = restoreSession({ restoreScroll });
      await frames(1);
      return { restored };
    },

    startSelection({ showCoordinates }) {
      selection?.unmount();
      selection = new ns.SelectionOverlay({
        showCoordinates,
        onComplete: (rect) => {
          selection = null;
          chrome.runtime
            .sendMessage({
              type: Messages.REGION_SELECTED,
              rect,
              scrollY: window.scrollY,
              viewport: ns.dom.viewportSize(),
            })
            .catch(() => {});
        },
        onCancel: () => {
          selection = null;
          chrome.runtime.sendMessage({ type: Messages.REGION_CANCELLED }).catch(() => {});
        },
      });
      selection.mount();
      return { selecting: true };
    },

    cancelSelection() {
      selection?.unmount();
      selection = null;
      return true;
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== TARGET) return false;
    const handler = handlers[message.cmd];
    if (!handler) {
      sendResponse({ ok: false, error: { code: 'UNKNOWN', message: `Unknown command: ${message.cmd}` } });
      return false;
    }
    touch();
    Promise.resolve()
      .then(() => handler(message.args || {}))
      .then(
        (data) => sendResponse({ ok: true, data }),
        (error) => sendResponse({ ok: false, error: { code: error.code || 'UNKNOWN', message: String(error.message || error) } }),
      );
    return true;
  });

  // If the page is being unloaded mid-capture there is nothing to restore, but
  // bfcache can bring it back: make sure it returns unmodified.
  window.addEventListener('pagehide', () => {
    restoreSession({ restoreScroll: false });
    selection?.unmount();
    selection = null;
  });
})();
