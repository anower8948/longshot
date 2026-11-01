/**
 * LongShot page agent — region selection overlay.
 *
 * Rendered in a closed shadow root so page CSS can't affect it. The selection
 * is tracked in document coordinates, so the user can scroll (wheel, or drag
 * near the top/bottom edge to auto-scroll) to select an area taller than the
 * viewport.
 */
(() => {
  const ns = globalThis.__longshot;
  if (ns.SelectionOverlay) return;
  const { OVERLAY_HOST_ID, viewportSize } = ns.dom;

  const MIN_SIZE = 8;
  const EDGE = 36;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer {
      position: fixed; inset: 0; cursor: crosshair; user-select: none;
      font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .shade { position: fixed; inset: 0; background: rgba(12, 14, 20, 0.42); }
    .box {
      position: fixed; display: none;
      border: 1.5px solid rgba(255, 255, 255, 0.95);
      border-radius: 3px;
      box-shadow: 0 0 0 100000px rgba(12, 14, 20, 0.42), 0 0 0 1px rgba(10, 132, 255, 0.9) inset;
    }
    .size {
      position: absolute; left: 0; top: -30px; white-space: nowrap;
      padding: 5px 9px; border-radius: 8px; color: #fff;
      background: rgba(28, 30, 38, 0.72);
      backdrop-filter: blur(16px) saturate(160%); -webkit-backdrop-filter: blur(16px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.18);
      font-variant-numeric: tabular-nums;
    }
    .size.inside { top: 6px; left: 6px; }
    .hint {
      position: fixed; left: 50%; top: 18px; transform: translateX(-50%);
      padding: 9px 16px; border-radius: 999px; color: #fff; white-space: nowrap;
      background: rgba(28, 30, 38, 0.66);
      backdrop-filter: blur(20px) saturate(170%); -webkit-backdrop-filter: blur(20px) saturate(170%);
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      pointer-events: none; transition: opacity 0.2s;
    }
    .hint kbd {
      font: inherit; padding: 1px 6px; margin: 0 2px; border-radius: 5px;
      background: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .toolbar {
      position: fixed; display: none; gap: 6px; padding: 6px; border-radius: 14px;
      background: rgba(28, 30, 38, 0.7);
      backdrop-filter: blur(20px) saturate(170%); -webkit-backdrop-filter: blur(20px) saturate(170%);
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
      cursor: default;
    }
    .toolbar.visible { display: flex; }
    button {
      all: unset; cursor: pointer; padding: 7px 14px; border-radius: 9px; color: #fff;
      font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      transition: background 0.15s, transform 0.1s;
    }
    button:active { transform: scale(0.97); }
    .cancel { background: rgba(255, 255, 255, 0.1); }
    .cancel:hover { background: rgba(255, 255, 255, 0.18); }
    .confirm { background: #0a84ff; }
    .confirm:hover { background: #2e95ff; }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
  `;

  class SelectionOverlay {
    constructor({ showCoordinates = false, scale = window.devicePixelRatio || 1, onComplete, onCancel }) {
      this.showCoordinates = showCoordinates;
      this.scale = scale;
      this.onComplete = onComplete;
      this.onCancel = onCancel;
      this.start = null;
      this.end = null;
      this.dragging = false;
      this.pointer = null;
      this.autoScrollFrame = 0;
      this.handlers = {};
    }

    mount() {
      document.getElementById(OVERLAY_HOST_ID)?.remove();
      const host = document.createElement('div');
      host.id = OVERLAY_HOST_ID;
      host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
      const root = host.attachShadow({ mode: 'closed' });
      // Built with DOM APIs rather than innerHTML: pages that enforce Trusted
      // Types (Gmail, Google Docs…) reject string-to-HTML assignments.
      const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      };
      const style = el('style');
      style.textContent = CSS;
      const layer = el('div', 'layer');
      const box = el('div', 'box');
      box.append(el('div', 'size'));
      const hint = el('div', 'hint');
      hint.append('Drag to select an area · scroll to extend · ', el('kbd', '', 'Esc'), ' to cancel');
      const toolbar = el('div', 'toolbar');
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', 'Selection actions');
      const cancelButton = el('button', 'cancel', 'Cancel');
      const confirmButton = el('button', 'confirm', 'Capture');
      cancelButton.type = 'button';
      confirmButton.type = 'button';
      toolbar.append(cancelButton, confirmButton);
      layer.append(el('div', 'shade'), box, hint, toolbar);
      root.append(style, layer);
      this.host = host;
      this.layer = root.querySelector('.layer');
      this.shade = root.querySelector('.shade');
      this.box = root.querySelector('.box');
      this.sizeLabel = root.querySelector('.size');
      this.hint = root.querySelector('.hint');
      this.toolbar = root.querySelector('.toolbar');

      root.querySelector('.cancel').addEventListener('click', (event) => {
        event.stopPropagation();
        this.cancel();
      });
      root.querySelector('.confirm').addEventListener('click', (event) => {
        event.stopPropagation();
        this.confirm();
      });
      this.toolbar.addEventListener('mousedown', (event) => event.stopPropagation());

      this.handlers = {
        mousedown: (event) => this.onMouseDown(event),
        mousemove: (event) => this.onMouseMove(event),
        mouseup: (event) => this.onMouseUp(event),
        keydown: (event) => this.onKeyDown(event),
        scroll: () => this.render(),
        resize: () => this.render(),
      };
      this.layer.addEventListener('mousedown', this.handlers.mousedown);
      window.addEventListener('mousemove', this.handlers.mousemove, true);
      window.addEventListener('mouseup', this.handlers.mouseup, true);
      window.addEventListener('keydown', this.handlers.keydown, true);
      window.addEventListener('scroll', this.handlers.scroll, true);
      window.addEventListener('resize', this.handlers.resize);

      document.documentElement.appendChild(host);
    }

    unmount() {
      cancelAnimationFrame(this.autoScrollFrame);
      window.removeEventListener('mousemove', this.handlers.mousemove, true);
      window.removeEventListener('mouseup', this.handlers.mouseup, true);
      window.removeEventListener('keydown', this.handlers.keydown, true);
      window.removeEventListener('scroll', this.handlers.scroll, true);
      window.removeEventListener('resize', this.handlers.resize);
      this.host?.remove();
      this.host = null;
    }

    docPoint(event) {
      const viewport = viewportSize();
      const scroller = document.scrollingElement || document.documentElement;
      return {
        x: Math.min(Math.max(event.clientX, 0), viewport.width),
        y: Math.min(Math.max(event.clientY + window.scrollY, 0), scroller.scrollHeight),
      };
    }

    onMouseDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.dragging = true;
      this.start = this.docPoint(event);
      this.end = { ...this.start };
      this.pointer = { clientX: event.clientX, clientY: event.clientY };
      this.toolbar.classList.remove('visible');
      this.hint.style.opacity = '0';
      this.autoScroll();
      this.render();
    }

    onMouseMove(event) {
      if (!this.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      this.pointer = { clientX: event.clientX, clientY: event.clientY };
      this.end = this.docPoint(event);
      this.render();
    }

    onMouseUp(event) {
      if (!this.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      this.dragging = false;
      cancelAnimationFrame(this.autoScrollFrame);
      this.end = this.docPoint(event);
      const rect = this.selectionRect();
      if (!rect || rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        this.start = null;
        this.end = null;
        this.hint.style.opacity = '1';
      } else {
        this.toolbar.classList.add('visible');
        this.toolbar.querySelector('.confirm').focus({ preventScroll: true });
      }
      this.render();
    }

    onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
      } else if (event.key === 'Enter' && this.toolbar.classList.contains('visible')) {
        event.preventDefault();
        event.stopPropagation();
        this.confirm();
      }
    }

    /** While dragging near the top/bottom edge, scroll the page. */
    autoScroll() {
      const step = () => {
        if (!this.dragging || !this.pointer) return;
        const viewport = viewportSize();
        const { clientY } = this.pointer;
        let delta = 0;
        if (clientY < EDGE) delta = -Math.ceil((EDGE - clientY) / 2) - 4;
        else if (clientY > viewport.height - EDGE) delta = Math.ceil((clientY - (viewport.height - EDGE)) / 2) + 4;
        if (delta !== 0) {
          window.scrollBy({ top: delta, behavior: 'instant' });
          this.end = this.docPoint(this.pointer);
          this.render();
        }
        this.autoScrollFrame = requestAnimationFrame(step);
      };
      this.autoScrollFrame = requestAnimationFrame(step);
    }

    selectionRect() {
      if (!this.start || !this.end) return null;
      const x = Math.min(this.start.x, this.end.x);
      const y = Math.min(this.start.y, this.end.y);
      return {
        x,
        y,
        width: Math.abs(this.end.x - this.start.x),
        height: Math.abs(this.end.y - this.start.y),
      };
    }

    render() {
      if (!this.host) return;
      const rect = this.selectionRect();
      if (!rect || (rect.width < 1 && rect.height < 1)) {
        this.box.style.display = 'none';
        this.shade.style.display = 'block';
        return;
      }
      const viewport = viewportSize();
      const top = rect.y - window.scrollY;
      this.shade.style.display = 'none';
      Object.assign(this.box.style, {
        display: 'block',
        left: `${rect.x}px`,
        top: `${top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });

      const outW = Math.round(rect.width * this.scale);
      const outH = Math.round(rect.height * this.scale);
      let label = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      if (Math.abs(this.scale - 1) > 0.01) label += `  →  ${outW} × ${outH} px`;
      if (this.showCoordinates) label += `  ·  x ${Math.round(rect.x)}, y ${Math.round(rect.y)}`;
      this.sizeLabel.textContent = label;
      this.sizeLabel.classList.toggle('inside', top < 34);

      if (this.toolbar.classList.contains('visible')) {
        const toolbarWidth = this.toolbar.offsetWidth || 170;
        const toolbarHeight = this.toolbar.offsetHeight || 44;
        let left = rect.x + rect.width - toolbarWidth;
        let tTop = top + rect.height + 10;
        if (tTop + toolbarHeight > viewport.height - 8) tTop = Math.min(top + rect.height - toolbarHeight - 10, viewport.height - toolbarHeight - 12);
        tTop = Math.max(8, tTop);
        left = Math.min(Math.max(8, left), viewport.width - toolbarWidth - 8);
        this.toolbar.style.left = `${left}px`;
        this.toolbar.style.top = `${tTop}px`;
      }
    }

    confirm() {
      const rect = this.selectionRect();
      this.unmount();
      if (!rect || rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        this.onCancel?.();
        return;
      }
      this.onComplete?.(rect);
    }

    cancel() {
      this.unmount();
      this.onCancel?.();
    }
  }

  ns.SelectionOverlay = SelectionOverlay;
})();
