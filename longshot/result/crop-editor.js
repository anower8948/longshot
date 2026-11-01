/**
 * Interactive crop editor for the result page.
 *
 * Works directly on the displayed screenshot, which may be many screens tall:
 * drag the edges/corners or the whole box, or drag out a new box; dragging
 * near the top or bottom of the window scrolls the page so any part of a long
 * capture can be selected. Exact values can be typed in the toolbar, which
 * also offers Top half / Bottom half / What's on screen presets.
 *
 * All coordinates are kept in image pixels; the overlay is positioned in
 * percentages so it stays aligned however the image is scaled on screen.
 */

import { formatDimensions } from '../utils/format.js';

const MIN_SIZE = 16;
const EDGE = 70; // px from the window edge that triggers auto-scroll
const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class CropEditor {
  /**
   * @param {object} params
   * @param {HTMLElement} params.frame   Positioned element wrapping the image.
   * @param {{width:number,height:number}} params.image  Image size in pixels.
   * @param {string} params.title
   * @param {(rect) => Promise<void>} params.onApply
   * @param {(rect) => Promise<void>} params.onCopy
   * @param {(rect) => Promise<void>} params.onDownload
   * @param {() => void} params.onClose
   */
  constructor({ frame, image, title, onApply, onCopy, onDownload, onClose }) {
    this.frame = frame;
    this.image = image;
    this.title = title;
    this.onApply = onApply;
    this.onCopy = onCopy;
    this.onDownload = onDownload;
    this.onClose = onClose;
    this.rect = { x: 0, y: 0, width: image.width, height: image.height };
    this.drag = null;
    this.scrollFrame = 0;
    this.busy = false;
    this.listeners = [];
  }

  // ---------------------------------------------------------------- lifecycle

  open() {
    this.buildOverlay();
    this.buildToolbar();
    this.listen(window, 'pointermove', (event) => this.onPointerMove(event));
    this.listen(window, 'pointerup', (event) => this.onPointerUp(event));
    this.listen(window, 'pointercancel', (event) => this.onPointerUp(event));
    this.listen(window, 'keydown', (event) => this.onKeyDown(event), true);
    this.listen(window, 'scroll', () => this.renderDims(), { passive: true });
    document.body.classList.add('cropping');
    this.render();
    // Bring the image into view only if it isn't visible at all; never animate,
    // so the page can't slide under a drag that starts immediately.
    const bounds = this.frame.getBoundingClientRect();
    if (bounds.bottom < 80 || bounds.top > window.innerHeight - 200) {
      window.scrollTo({ top: Math.max(0, bounds.top + window.scrollY - 90), behavior: 'instant' });
    }
    // Move focus into the editor so keyboard shortcuts don't reach page buttons.
    this.toolbar.focus({ preventScroll: true });
  }

  close() {
    cancelAnimationFrame(this.scrollFrame);
    for (const [target, type, handler, options] of this.listeners) target.removeEventListener(type, handler, options);
    this.listeners = [];
    this.layer?.remove();
    this.toolbar?.remove();
    document.body.classList.remove('cropping');
    this.onClose?.();
  }

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listeners.push([target, type, handler, options]);
  }

  // ---------------------------------------------------------------- DOM

  buildOverlay() {
    const layer = document.createElement('div');
    layer.className = 'crop-layer';
    layer.innerHTML = `
      <div class="crop-shade" data-shade="top"></div>
      <div class="crop-shade" data-shade="bottom"></div>
      <div class="crop-shade" data-shade="left"></div>
      <div class="crop-shade" data-shade="right"></div>
      <div class="crop-box">
        <div class="crop-grid"></div>
        ${HANDLES.map((h) => `<span class="crop-handle" data-handle="${h}"></span>`).join('')}
      </div>`;
    this.layer = layer;
    this.box = layer.querySelector('.crop-box');
    this.shades = Object.fromEntries([...layer.querySelectorAll('[data-shade]')].map((el) => [el.dataset.shade, el]));
    layer.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.frame.append(layer);
  }

  buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'crop-toolbar glass';
    toolbar.setAttribute('role', 'dialog');
    toolbar.setAttribute('aria-label', 'Crop image');
    toolbar.tabIndex = -1;
    toolbar.innerHTML = `
      <div class="crop-head">
        <div class="crop-title">
          <strong>Crop ${this.title}</strong>
          <span class="crop-dims num" aria-live="polite"></span>
        </div>
        <div class="crop-presets" role="group" aria-label="Crop presets">
          <button type="button" class="chip" data-preset="top">Top half</button>
          <button type="button" class="chip" data-preset="bottom">Bottom half</button>
          <button type="button" class="chip" data-preset="screen" title="Select the part of the image currently visible in the window">What’s on screen</button>
          <button type="button" class="chip" data-preset="reset">Reset</button>
        </div>
      </div>
      <div class="crop-body">
        <div class="crop-fields num">
          <label>Top<input type="number" min="0" step="1" data-edge="top" /></label>
          <label>Bottom<input type="number" min="1" step="1" data-edge="bottom" /></label>
          <label>Left<input type="number" min="0" step="1" data-edge="left" /></label>
          <label>Right<input type="number" min="1" step="1" data-edge="right" /></label>
        </div>
        <div class="crop-actions">
          <button type="button" class="btn" data-action="cancel">Cancel</button>
          <button type="button" class="btn btn-glass" data-action="copy">Copy</button>
          <button type="button" class="btn btn-glass" data-action="download">Download</button>
          <button type="button" class="btn btn-primary" data-action="apply">Save Crop</button>
        </div>
      </div>
      <p class="crop-hint muted">Drag the edges or corners · drag inside to move · drag near the window edge to scroll · <span class="kbd">Enter</span> saves · <span class="kbd">Esc</span> cancels</p>`;

    toolbar.querySelectorAll('[data-preset]').forEach((button) => {
      button.addEventListener('click', () => this.applyPreset(button.dataset.preset));
    });
    toolbar.querySelectorAll('input[data-edge]').forEach((input) => {
      // Select the value on focus so typing replaces it instead of appending.
      input.addEventListener('focus', () => input.select());
      input.addEventListener('mouseup', (event) => event.preventDefault());
      input.addEventListener('change', () => this.onFieldChange(input));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.onFieldChange(input);
        }
      });
    });
    toolbar.querySelector('[data-action="cancel"]').addEventListener('click', () => this.close());
    toolbar.querySelector('[data-action="copy"]').addEventListener('click', () => this.run('copy'));
    toolbar.querySelector('[data-action="download"]').addEventListener('click', () => this.run('download'));
    toolbar.querySelector('[data-action="apply"]').addEventListener('click', () => this.run('apply'));
    this.toolbar = toolbar;
    document.body.append(toolbar);
  }

  // ---------------------------------------------------------------- geometry

  /** Client coordinates → image pixels (clamped to the image). */
  toImage(clientX, clientY) {
    const bounds = this.frame.getBoundingClientRect();
    return {
      x: clamp(((clientX - bounds.left) / bounds.width) * this.image.width, 0, this.image.width),
      y: clamp(((clientY - bounds.top) / bounds.height) * this.image.height, 0, this.image.height),
    };
  }

  setEdges({ left, top, right, bottom }) {
    const W = this.image.width;
    const H = this.image.height;
    left = clamp(left, 0, W - MIN_SIZE);
    top = clamp(top, 0, H - MIN_SIZE);
    right = clamp(right, left + MIN_SIZE, W);
    bottom = clamp(bottom, top + MIN_SIZE, H);
    this.rect = { x: left, y: top, width: right - left, height: bottom - top };
    this.render();
  }

  edges() {
    const { x, y, width, height } = this.rect;
    return { left: x, top: y, right: x + width, bottom: y + height };
  }

  rounded() {
    const { left, top, right, bottom } = this.edges();
    const l = Math.round(left);
    const t = Math.round(top);
    return { x: l, y: t, width: Math.round(right) - l, height: Math.round(bottom) - t };
  }

  applyPreset(preset) {
    const W = this.image.width;
    const H = this.image.height;
    const half = Math.round(H / 2);
    if (preset === 'top') this.setEdges({ left: 0, top: 0, right: W, bottom: half });
    else if (preset === 'bottom') this.setEdges({ left: 0, top: half, right: W, bottom: H });
    else if (preset === 'reset') this.setEdges({ left: 0, top: 0, right: W, bottom: H });
    else if (preset === 'screen') {
      const toolbarHeight = this.toolbar.getBoundingClientRect().height + 16;
      const top = this.toImage(0, 0).y;
      const bottom = this.toImage(0, window.innerHeight - toolbarHeight).y;
      this.setEdges({ left: 0, top, right: W, bottom });
    }
  }

  onFieldChange(input) {
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
      this.render();
      return;
    }
    const edges = this.edges();
    edges[input.dataset.edge] = value;
    this.setEdges(edges);
  }

  // ---------------------------------------------------------------- pointer

  onPointerDown(event) {
    if (event.button !== 0 || this.busy) return;
    event.preventDefault();
    const point = this.toImage(event.clientX, event.clientY);
    let handle = event.target.closest('[data-handle]')?.dataset.handle;
    if (!handle && event.target.classList?.contains('crop-box')) {
      // The invisible strips along the top and bottom edges resize too.
      const bounds = this.box.getBoundingClientRect();
      if (event.clientY - bounds.top <= 14) handle = 'n';
      else if (bounds.bottom - event.clientY <= 14) handle = 's';
    }
    let mode = 'new';
    if (handle) mode = 'resize';
    else if (event.target.closest('.crop-box')) mode = 'move';

    this.drag = {
      mode,
      handle: handle || '',
      pointerId: event.pointerId,
      start: point,
      startEdges: this.edges(),
      clientX: event.clientX,
      clientY: event.clientY,
    };
    this.layer.classList.add('dragging');
    this.autoScroll();
  }

  onPointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    event.preventDefault();
    this.drag.clientX = event.clientX;
    this.drag.clientY = event.clientY;
    this.applyDrag();
  }

  onPointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.applyDrag();
    this.drag = null;
    cancelAnimationFrame(this.scrollFrame);
    this.layer.classList.remove('dragging');
  }

  applyDrag() {
    const { drag } = this;
    const point = this.toImage(drag.clientX, drag.clientY);
    const W = this.image.width;
    const H = this.image.height;
    const s = drag.startEdges;

    if (drag.mode === 'new') {
      // Ignore tiny accidental drags (a click) until the pointer really moves.
      if (Math.abs(point.x - drag.start.x) < 4 && Math.abs(point.y - drag.start.y) < 4) return;
      this.setEdges({
        left: Math.min(drag.start.x, point.x),
        right: Math.max(drag.start.x, point.x),
        top: Math.min(drag.start.y, point.y),
        bottom: Math.max(drag.start.y, point.y),
      });
    } else if (drag.mode === 'move') {
      const width = s.right - s.left;
      const height = s.bottom - s.top;
      const left = clamp(s.left + point.x - drag.start.x, 0, W - width);
      const top = clamp(s.top + point.y - drag.start.y, 0, H - height);
      this.setEdges({ left, top, right: left + width, bottom: top + height });
    } else {
      const next = { ...s };
      if (drag.handle.includes('w')) next.left = Math.min(point.x, s.right - MIN_SIZE);
      if (drag.handle.includes('e')) next.right = Math.max(point.x, s.left + MIN_SIZE);
      if (drag.handle.includes('n')) next.top = Math.min(point.y, s.bottom - MIN_SIZE);
      if (drag.handle.includes('s')) next.bottom = Math.max(point.y, s.top + MIN_SIZE);
      this.setEdges(next);
    }
  }

  autoScroll() {
    const step = () => {
      if (!this.drag) return;
      const toolbarTop = this.toolbar.getBoundingClientRect().top;
      const { clientY } = this.drag;
      let delta = 0;
      if (clientY < EDGE) delta = -Math.ceil((EDGE - clientY) / 3) - 4;
      else if (clientY > toolbarTop - EDGE) delta = Math.ceil((clientY - (toolbarTop - EDGE)) / 3) + 4;
      if (delta) {
        window.scrollBy({ top: delta, behavior: 'instant' });
        this.applyDrag();
      }
      this.scrollFrame = requestAnimationFrame(step);
    };
    this.scrollFrame = requestAnimationFrame(step);
  }

  onKeyDown(event) {
    if (this.busy) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (event.key === 'Enter') {
      // Fields and toolbar buttons handle Enter themselves; anywhere else
      // (including a still-focused page button) Enter saves the crop.
      const target = event.target;
      if (target.matches?.('input') || (target.closest?.('button') && this.toolbar.contains(target))) return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.toolbar.querySelector('[data-action="apply"]').disabled) this.run('apply');
    }
  }

  // ---------------------------------------------------------------- render

  render() {
    const W = this.image.width;
    const H = this.image.height;
    const { left, top, right, bottom } = this.edges();
    const pct = (value, total) => `${(value / total) * 100}%`;

    Object.assign(this.box.style, { left: pct(left, W), top: pct(top, H), width: pct(right - left, W), height: pct(bottom - top, H) });
    Object.assign(this.shades.top.style, { left: '0', top: '0', width: '100%', height: pct(top, H) });
    Object.assign(this.shades.bottom.style, { left: '0', top: pct(bottom, H), width: '100%', height: pct(H - bottom, H) });
    Object.assign(this.shades.left.style, { left: '0', top: pct(top, H), width: pct(left, W), height: pct(bottom - top, H) });
    Object.assign(this.shades.right.style, { left: pct(right, W), top: pct(top, H), width: pct(W - right, W), height: pct(bottom - top, H) });

    const values = { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) };
    for (const input of this.toolbar.querySelectorAll('input[data-edge]')) {
      if (document.activeElement !== input) input.value = String(values[input.dataset.edge]);
      input.max = String(input.dataset.edge === 'top' || input.dataset.edge === 'bottom' ? H : W);
    }
    this.renderDims();
  }

  renderDims() {
    if (!this.toolbar) return;
    const { width, height } = this.rounded();
    const full = width === this.image.width && height === this.image.height;
    this.toolbar.querySelector('.crop-dims').textContent = full
      ? `${formatDimensions(width, height)} · whole image`
      : `${formatDimensions(width, height)} · ${Math.round((height / this.image.height) * 100)}% of the height`;
    this.toolbar.querySelector('[data-action="apply"]').disabled = this.busy || full;
  }

  async run(action) {
    if (this.busy) return;
    const rect = this.rounded();
    const handlers = { apply: this.onApply, copy: this.onCopy, download: this.onDownload };
    this.busy = true;
    const buttons = [...this.toolbar.querySelectorAll('button')];
    buttons.forEach((button) => {
      button.disabled = true;
    });
    const target = this.toolbar.querySelector(`[data-action="${action}"]`);
    const label = target.textContent;
    target.textContent = action === 'apply' ? 'Saving…' : action === 'copy' ? 'Copying…' : 'Preparing…';
    try {
      await handlers[action](rect);
      if (action === 'apply') {
        this.close();
        return;
      }
    } finally {
      if (this.toolbar?.isConnected) {
        this.busy = false;
        target.textContent = label;
        buttons.forEach((button) => {
          button.disabled = false;
        });
        this.renderDims();
      }
    }
  }
}
