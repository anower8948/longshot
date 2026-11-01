/**
 * LongShot page agent — fixed & sticky element handling.
 *
 * Without intervention a fixed header is captured in every section and ends up
 * repeated down the stitched image. Strategy ("smart" mode):
 *
 *  • position: sticky  → rendered as position: relative for the whole capture,
 *    so it appears once, at its natural place in the document flow.
 *  • position: fixed, classified by where it sits in the capture band:
 *      top (headers, nav bars)          → shown in the first section only
 *      bottom (cookie bars, chat pills) → shown in the last section only
 *      other (sidebars, overlays)       → first section only
 *      background (full-bleed, z ≤ 0)   → always shown (it is the backdrop)
 *    Fixed elements that only appear after scrolling (e.g. "back to top"
 *    buttons, headers that become fixed) are hidden in every section.
 *  • "hide" mode hides all fixed elements everywhere; "off" changes nothing.
 *
 * Hiding uses inline `opacity: 0 !important` (descendants can't override it
 * and layout is unaffected). Original inline styles are recorded and restored.
 */
(() => {
  const ns = globalThis.__longshot;
  if (ns.FixedElementManager) return;
  const { forEachElement, saveInlineStyles, restoreInlineStyles, applyImportantStyles, OVERLAY_HOST_ID } = ns.dom;

  const HIDE_STYLES = { opacity: '0', transition: 'none' };
  const STICKY_STYLES = { position: 'relative', top: 'auto', bottom: 'auto', left: 'auto', right: 'auto' };

  function classify(rect, style, band) {
    const bandHeight = band.bottom - band.top;
    const bandWidth = band.right - band.left;
    const overlapWidth = Math.max(0, Math.min(rect.right, band.right) - Math.max(rect.left, band.left));
    const overlapHeight = Math.max(0, Math.min(rect.bottom, band.bottom) - Math.max(rect.top, band.top));
    const coverage = (overlapWidth * overlapHeight) / Math.max(1, bandWidth * bandHeight);

    if (coverage >= 0.85) {
      // Full-bleed layers behind the content are backdrops; above it, overlays.
      const zIndex = Number.parseInt(style.zIndex, 10);
      const behind = style.zIndex === 'auto' || (Number.isFinite(zIndex) && zIndex <= 0);
      return behind ? 'background' : 'overlay';
    }
    if (rect.height <= bandHeight * 0.5) {
      if (rect.top - band.top <= bandHeight * 0.25) return 'top';
      if (band.bottom - rect.bottom <= bandHeight * 0.25) return 'bottom';
    }
    return 'other';
  }

  class FixedElementManager {
    /**
     * @param {{ mode: 'smart'|'hide'|'off', scrollElement: Element|null }} options
     */
    constructor({ mode, scrollElement }) {
      this.mode = mode;
      this.scrollElement = scrollElement;
      /** @type {Map<Element, object>} */
      this.records = new Map();
      this.captureStarted = false;
    }

    /** Find fixed/sticky elements not seen before. */
    scan(band) {
      if (this.mode === 'off') return;
      forEachElement(document.documentElement, (el) => {
        if (el.id === OVERLAY_HOST_ID) return false;
        const known = this.records.get(el);
        if (known) return known.kind !== 'fixed';

        const style = getComputedStyle(el);
        if (style.display === 'none') return false;
        const position = style.position;
        if (position !== 'fixed' && position !== 'sticky') return true;
        if (el === document.documentElement || el === document.body) return true;
        // Never touch ancestors of the scrolled container (app-shell layouts).
        if (this.scrollElement && el.contains(this.scrollElement)) return true;

        this.track(el, position, style, band);
        return position !== 'fixed';
      });
    }

    track(el, position, style, band) {
      const record = {
        el,
        kind: position,
        anchor: 'other',
        lateAppearance: this.captureStarted,
        hiddenStyles: null,
        isHidden: false,
        stickyStyles: null,
      };
      if (position === 'fixed') {
        record.anchor = classify(el.getBoundingClientRect(), style, band);
      } else {
        record.stickyStyles = saveInlineStyles(el, Object.keys(STICKY_STYLES));
        applyImportantStyles(el, STICKY_STYLES);
      }
      this.records.set(el, record);
    }

    shouldShow(record, phase) {
      if (this.mode === 'off' || record.anchor === 'background') return true;
      if (this.mode === 'hide' || record.lateAppearance) return false;
      if (record.anchor === 'bottom') return phase === 'last' || phase === 'single';
      return phase === 'first' || phase === 'single';
    }

    /** @param {'first'|'middle'|'last'|'single'} phase */
    applyPhase(phase) {
      if (this.mode === 'off') return { hidden: 0, tracked: 0 };
      let hidden = 0;
      for (const record of this.records.values()) {
        if (record.kind !== 'fixed' || !record.el.isConnected) continue;
        // An element may stop being fixed (e.g. a header that docks back into flow).
        const stillFixed = getComputedStyle(record.el).position === 'fixed';
        if (stillFixed && !this.shouldShow(record, phase)) {
          this.hide(record);
          hidden += 1;
        } else {
          this.show(record);
        }
      }
      this.captureStarted = true;
      return { hidden, tracked: this.records.size };
    }

    hide(record) {
      if (!record.hiddenStyles) {
        record.hiddenStyles = saveInlineStyles(record.el, Object.keys(HIDE_STYLES));
      }
      // Re-applied every time in case a framework re-rendered the style attribute.
      applyImportantStyles(record.el, HIDE_STYLES);
      record.isHidden = true;
    }

    show(record) {
      if (!record.isHidden) return;
      // Only opacity is restored here; `transition: none` stays until restore()
      // so the element can't fade in while a section is being captured.
      restoreInlineStyles(record.el, { opacity: record.hiddenStyles.opacity }, { opacity: HIDE_STYLES.opacity });
      record.isHidden = false;
    }

    restore() {
      for (const record of this.records.values()) {
        const { el } = record;
        if (record.hiddenStyles) {
          if (record.isHidden) {
            restoreInlineStyles(el, { opacity: record.hiddenStyles.opacity }, { opacity: HIDE_STYLES.opacity });
          }
          restoreInlineStyles(el, { transition: record.hiddenStyles.transition }, { transition: HIDE_STYLES.transition });
        }
        if (record.stickyStyles) {
          restoreInlineStyles(el, record.stickyStyles, STICKY_STYLES);
        }
      }
      this.records.clear();
    }
  }

  ns.FixedElementManager = FixedElementManager;
})();
