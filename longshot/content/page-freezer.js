/**
 * LongShot page agent — temporarily freezes the page for a stable capture.
 *
 *  • Forces instant scrolling and disables scroll snapping (so programmatic
 *    scroll positions are exact).
 *  • Optionally collapses CSS animations/transitions to their end state,
 *    pauses script-driven Web Animations and playing videos, and hides the
 *    text caret. Collapsing (rather than `animation: none`) keeps elements that
 *    fade in with `animation-fill-mode: forwards` visible.
 *  • Switches lazy images to eager loading.
 *
 * Everything is recorded and undone by restore().
 */
(() => {
  const ns = globalThis.__longshot;
  if (ns.PageFreezer) return;

  const STYLE_ID = 'longshot-capture-style';

  class PageFreezer {
    constructor() {
      this.styleElement = null;
      this.pausedAnimations = [];
      this.pausedVideos = [];
      this.eagerImages = [];
    }

    apply({ pauseAnimations, neutralizeFixedBackgrounds, eagerImages }) {
      const rules = [
        'html, body { scroll-behavior: auto !important; }',
        '*, *::before, *::after { scroll-snap-type: none !important; scroll-behavior: auto !important; }',
      ];

      if (pauseAnimations) {
        rules.push(
          '*, *::before, *::after {' +
            ' animation-duration: 0s !important; animation-delay: 0s !important;' +
            ' transition-duration: 0s !important; transition-delay: 0s !important;' +
            ' caret-color: transparent !important; }',
        );
      }

      if (neutralizeFixedBackgrounds) {
        // `background-attachment: fixed` would repeat the same backdrop in every section.
        rules.push('*, *::before, *::after { background-attachment: scroll !important; }');
      }

      document.getElementById(STYLE_ID)?.remove();
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = rules.join('\n');
      (document.head || document.documentElement).appendChild(style);
      this.styleElement = style;

      if (pauseAnimations) {
        this.pauseScriptAnimations();
        this.pauseVideos();
      }

      if (eagerImages) {
        for (const img of document.querySelectorAll('img[loading="lazy"]')) {
          img.loading = 'eager';
          this.eagerImages.push(img);
        }
      }
    }

    pauseScriptAnimations() {
      if (typeof document.getAnimations !== 'function') return;
      const hasCssTypes = typeof CSSAnimation !== 'undefined' && typeof CSSTransition !== 'undefined';
      for (const animation of document.getAnimations()) {
        // CSS animations/transitions are handled by the injected stylesheet.
        if (hasCssTypes && (animation instanceof CSSAnimation || animation instanceof CSSTransition)) continue;
        if (animation.playState === 'running') {
          try {
            animation.pause();
            this.pausedAnimations.push(animation);
          } catch {
            // Some animations cannot be paused; ignore.
          }
        }
      }
    }

    pauseVideos() {
      for (const video of document.querySelectorAll('video')) {
        if (!video.paused && !video.ended) {
          video.pause();
          this.pausedVideos.push(video);
        }
      }
    }

    restore() {
      this.styleElement?.remove();
      this.styleElement = null;

      for (const animation of this.pausedAnimations) {
        try {
          if (animation.playState === 'paused') animation.play();
        } catch {
          // ignore
        }
      }
      this.pausedAnimations = [];

      for (const video of this.pausedVideos) {
        if (video.isConnected && video.paused) video.play().catch(() => {});
      }
      this.pausedVideos = [];

      for (const img of this.eagerImages) {
        if (img.isConnected) img.loading = 'lazy';
      }
      this.eagerImages = [];
    }
  }

  ns.PageFreezer = PageFreezer;
})();
