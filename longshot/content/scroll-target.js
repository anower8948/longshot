/**
 * LongShot page agent — scroll target detection.
 *
 * Most pages scroll the document, but many web apps (chat apps, dashboards,
 * docs tools) keep the document fixed and scroll an inner container. LongShot
 * scrolls and captures whichever one actually holds the long content.
 *
 * measure() returns, in viewport CSS px:
 *  • scrollTop / scrollHeight / maxScroll of the target
 *  • band: the visible rectangle of the target's content box (no scrollbars)
 *  • origin: viewport Y where content coordinate === scrollTop
 */
(() => {
  const ns = globalThis.__longshot;
  if (ns.scroll) return;
  const { viewportSize, forEachElement, OVERLAY_HOST_ID } = ns.dom;

  class WindowTarget {
    constructor() {
      this.kind = 'window';
      this.element = null;
    }

    getTop() {
      return window.scrollY;
    }

    scrollTo(top) {
      window.scrollTo({ top, left: window.scrollX, behavior: 'instant' });
    }

    measure() {
      const viewport = viewportSize();
      const scroller = document.scrollingElement || document.documentElement;
      const scrollHeight = Math.max(scroller.scrollHeight, viewport.height);
      return {
        scrollTop: window.scrollY,
        scrollHeight,
        clientHeight: viewport.height,
        maxScroll: Math.max(0, scrollHeight - viewport.height),
        band: { top: 0, bottom: viewport.height, left: 0, right: viewport.width },
        origin: 0,
      };
    }
  }

  class ElementTarget {
    constructor(element) {
      this.kind = 'element';
      this.element = element;
    }

    getTop() {
      return this.element.scrollTop;
    }

    scrollTo(top) {
      this.element.scrollTo({ top, left: this.element.scrollLeft, behavior: 'instant' });
    }

    measure() {
      const el = this.element;
      const viewport = viewportSize();
      const rect = el.getBoundingClientRect();
      const originY = rect.top + el.clientTop;
      const originX = rect.left + el.clientLeft;
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        maxScroll: Math.max(0, el.scrollHeight - el.clientHeight),
        band: {
          top: Math.max(0, originY),
          bottom: Math.min(viewport.height, originY + el.clientHeight),
          left: Math.max(0, originX),
          right: Math.min(viewport.width, originX + el.clientWidth),
        },
        origin: originY,
      };
    }
  }

  /** Find the largest visible scrollable container, if any. */
  function findScrollableContainer() {
    const viewport = viewportSize();
    const viewportArea = viewport.width * viewport.height;
    let best = null;
    let bestScore = 0;

    forEachElement(document.body || document.documentElement, (el) => {
      if (el.id === OVERLAY_HOST_ID) return false;
      const range = el.scrollHeight - el.clientHeight;
      if (range < 32 || el.clientHeight < 80) return true;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) return true;
      const rect = el.getBoundingClientRect();
      const visibleWidth = Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
      const visibleHeight = Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0);
      if (visibleWidth <= 0 || visibleHeight <= 0) return true;
      const area = visibleWidth * visibleHeight;
      if (area < viewportArea * 0.2) return true;
      const score = area * Math.log2(2 + range);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
      return true;
    });
    return best;
  }

  function detect() {
    const windowTarget = new WindowTarget();
    const windowMetrics = windowTarget.measure();
    const container = findScrollableContainer();
    if (!container) return windowTarget;

    const containerTarget = new ElementTarget(container);
    const containerRange = containerTarget.measure().maxScroll;
    const viewportHeight = windowMetrics.clientHeight;

    // Prefer the document unless it barely scrolls and the container holds
    // substantially more content (the classic "app shell" layout).
    if (windowMetrics.maxScroll < viewportHeight * 0.15 && containerRange > windowMetrics.maxScroll * 2) {
      return containerTarget;
    }
    return windowTarget;
  }

  ns.scroll = {
    detect,
    windowTarget: () => new WindowTarget(),
  };
})();
