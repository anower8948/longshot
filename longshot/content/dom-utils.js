/**
 * LongShot page agent — shared DOM helpers.
 *
 * Content scripts are injected on demand (chrome.scripting) into the page's
 * isolated world. They cannot be ES modules, so the files share a namespace
 * object and each file guards against being evaluated twice.
 */
(() => {
  const ns = (globalThis.__longshot = globalThis.__longshot || {});
  if (ns.dom) return;

  const OVERLAY_HOST_ID = 'longshot-overlay-host';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Resolves on the next animation frame, or after 120 ms if frames are throttled. */
  const nextFrame = () =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 120);
    });

  const frames = async (count = 2) => {
    for (let i = 0; i < count; i += 1) await nextFrame();
  };

  /**
   * Visit every element (including inside open shadow roots). Returning
   * `false` from `visit` skips that element's subtree.
   */
  function forEachElement(root, visit) {
    const roots = [root];
    while (roots.length) {
      const current = roots.pop();
      const walker = document.createTreeWalker(current, NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          const result = visit(node);
          if (result === false) return NodeFilter.FILTER_REJECT;
          if (node.shadowRoot) roots.push(node.shadowRoot);
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) {
        // acceptNode does the work
      }
    }
  }

  /** The layout viewport size excluding scrollbars, in CSS px. */
  function viewportSize() {
    const root = document.documentElement;
    const quirks = document.compatMode === 'BackCompat' && document.body;
    const width = quirks ? document.body.clientWidth : root.clientWidth;
    const height = quirks ? document.body.clientHeight : root.clientHeight;
    return {
      width: width > 0 ? Math.min(width, window.innerWidth) : window.innerWidth,
      height: height > 0 ? Math.min(height, window.innerHeight) : window.innerHeight,
    };
  }

  /** Save inline style values so they can be restored exactly. */
  function saveInlineStyles(element, properties) {
    const saved = {};
    for (const property of properties) {
      saved[property] = {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      };
    }
    return saved;
  }

  /**
   * Restore saved inline styles, but only for properties that still hold the
   * value we set — if the page changed them meanwhile, the page wins.
   */
  function restoreInlineStyles(element, saved, applied) {
    for (const [property, original] of Object.entries(saved)) {
      const currentValue = element.style.getPropertyValue(property);
      const currentPriority = element.style.getPropertyPriority(property);
      if (applied && (currentValue !== applied[property] || currentPriority !== 'important')) continue;
      if (original.value) {
        element.style.setProperty(property, original.value, original.priority);
      } else {
        element.style.removeProperty(property);
      }
    }
    if (element.getAttribute('style') === '') element.removeAttribute('style');
  }

  function applyImportantStyles(element, styles) {
    for (const [property, value] of Object.entries(styles)) {
      element.style.setProperty(property, value, 'important');
    }
  }

  /**
   * Wait for images near the capture band to load and decode, so lazy-loaded
   * pictures aren't captured half-painted.
   */
  async function waitForMedia(band, timeoutMs) {
    if (timeoutMs <= 0) return;
    const margin = (band.bottom - band.top) * 0.5;
    const pending = [];
    for (const img of document.images) {
      const rect = img.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < band.top - margin || rect.top > band.bottom + margin) continue;
      if (!img.complete) {
        pending.push(
          new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }),
        );
      } else if (img.naturalWidth > 0 && typeof img.decode === 'function') {
        pending.push(img.decode().catch(() => {}));
      }
    }
    if (!pending.length) return;
    await Promise.race([Promise.all(pending), sleep(timeoutMs)]);
  }

  ns.dom = {
    OVERLAY_HOST_ID,
    sleep,
    nextFrame,
    frames,
    forEachElement,
    viewportSize,
    saveInlineStyles,
    restoreInlineStyles,
    applyImportantStyles,
    waitForMedia,
  };
})();
