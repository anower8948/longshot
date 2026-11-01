# LongShot

**Razor-sharp full-page screenshots for Chrome — stitched seamlessly and ready for Google Docs.**

LongShot scrolls a page, captures every section at your display's native pixel density, and stitches them into one continuous image — without duplicated rows, gaps, repeated sticky headers or blurry text. It was built for one workflow in particular:

> Create or read a long page → capture all of it → get one extremely sharp PNG → put it into Google Docs.

---

## Contents

- [Features](#features)
- [Install (Load unpacked)](#install-load-unpacked)
- [Using LongShot](#using-longshot)
- [Getting sharp screenshots into Google Docs](#getting-sharp-screenshots-into-google-docs)
- [Quality and resolution](#quality-and-resolution)
- [Settings](#settings)
- [Permissions](#permissions)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## Features

| | |
|---|---|
| **Capture modes** | Full Page · Visible Area · Custom Area (drag, with auto-scroll for areas taller than the screen) · From Here (current position → bottom) |
| **Native resolution** | Captures at the real device pixel ratio (2× on Retina). Never upscales. |
| **Exact stitching** | Tiles are placed from measured scroll offsets; overlap in the final section is removed; ≤3-row rounding gaps on fractional DPRs are closed from real pixels. |
| **Sticky & fixed elements** | Sticky headers render once in place; fixed headers once at the top; cookie bars / chat bubbles once at the bottom; buttons that appear on scroll are hidden. |
| **Lazy content** | Optional pre-scroll, native lazy images switched to eager, waits for in-view images to load and decode, configurable delay (0–2000 ms). |
| **Dynamic pages** | Optional animation freezing (collapses CSS animations/transitions, pauses videos and script animations, hides the caret). Infinite-scroll pages are followed up to a safety limit. |
| **App layouts** | Detects pages that scroll an inner container (chat apps, dashboards, docs tools) and captures that container. |
| **Huge images** | A streaming PNG encoder writes single images far beyond Chrome's 32,767 px canvas limit, using memory for only ~1,000 rows at a time. |
| **Formats** | PNG (default, lossless), JPEG, WebP. Automatic splitting where a format has size limits. |
| **Google Docs mode** | Page-sized PNG parts cut on blank rows between lines of text, each under Docs' 25 MP limit. |
| **Crop** | Trim any capture after the fact — drag edges/corners (auto-scrolls on tall images), type exact pixel edges, or use Top half / Bottom half / What's on screen. Pixel-exact (no resampling), works beyond canvas limits, original always restorable. |
| **Result page** | Full-resolution preview, per-image Crop, Copy (paste straight into Docs), Open and Download. |
| **Safety** | Cancel any time (button or <kbd>Esc</kbd>); the page's styles and scroll position are always restored — even if the extension is reloaded mid-capture. |

## Install (Load unpacked)

1. Download or clone this repository.
2. Open Chrome and go to **`chrome://extensions`** (menu ⋮ → Extensions → Manage Extensions).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`longshot`** folder (the one containing `manifest.json`).
5. Pin LongShot: click the puzzle-piece icon in the toolbar → pin **LongShot**.

No build step is needed — the extension is plain JavaScript modules, HTML and CSS.

To update after pulling changes, click the ↻ reload button on LongShot's card in `chrome://extensions`.

## Using LongShot

1. Open the page you want to capture and wait for it to finish loading.
2. Click the LongShot icon.
3. Choose a mode, quality and format (your choices are remembered).
4. Click **Capture**. Keep the tab in front while it scrolls — Chrome can only capture the visible tab.
5. The image is saved to **Downloads › LongShot**. From the popup you can **Open Image** or **Download Again**.

**Crop a capture** (keep half the page, or just one section): click **Crop** on the "Screenshot captured" screen, or on any image in the result page.

- Drag the blue edge bars or corners, drag inside the box to move it, or drag on the shaded area to draw a new box. Drag near the top or bottom of the window to scroll through long captures.
- Or type exact **Top / Bottom / Left / Right** pixel positions, or use **Top half**, **Bottom half**, or **What's on screen** (scroll the result page to the part you want, then click it).
- **Save Crop** (or <kbd>Enter</kbd>) replaces the image inside LongShot, so Download and Copy use the cropped version. **Restore Original** brings the full capture back at any time. **Copy** and **Download** in the crop toolbar export just the selection without changing the saved image.
- Cropping copies pixels 1:1 — no quality is lost — and cropped downloads are named `… (cropped).png`.

You can also crop *before* capturing with **Custom Area**, which scrolls with your selection.

**Custom Area:** after clicking *Select Area*, drag on the page. Drag to the top or bottom edge (or scroll) to extend the selection beyond the screen. Press <kbd>Enter</kbd> or click **Capture**; <kbd>Esc</kbd> cancels.

**Keyboard shortcuts** (change them at `chrome://extensions/shortcuts`):

| Action | Windows / Linux | macOS |
|---|---|---|
| Capture full page | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>S</kbd> |
| Capture visible area | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | <kbd>⌃</kbd>+<kbd>⇧</kbd>+<kbd>V</kbd> |

Pressing a shortcut again during a capture cancels it.

> On macOS the visible-area shortcut uses Control rather than Command because <kbd>⌘</kbd><kbd>⇧</kbd><kbd>V</kbd> is "Paste and Match Style" — which you'll want in Google Docs. On Windows/Linux, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> is Chrome's "paste as plain text"; if you use that, remap LongShot's shortcut. Chrome won't assign a suggested shortcut that another extension already uses — check `chrome://extensions/shortcuts` if one doesn't work.

## Getting sharp screenshots into Google Docs

Google Docs has two limits that ruin long screenshots:

1. **An image can't be taller than a page.** Docs shrinks it until it fits — a 2,880 × 18,000 px capture becomes a thin strip about 1.4 inches wide with unreadable text.
2. **Images over 25 megapixels (or 50 MB) are rejected.**

Turn on **Google Docs Optimized** in the popup. LongShot then saves:

- **PNG** (lossless — no JPEG artifacts around text),
- at **full captured resolution** (2× on Retina ≈ 440 DPI on a Letter page),
- split into **page-shaped images** that fill the page width, each cut on a **blank row between lines of text**, never through a line,
- each under **25 MP**.

Then, in Google Docs, either:

- **Insert → Image → Upload from computer**, select all parts at once (they're numbered in order), or
- open the result page (**Open Image**) and click **Copy** on each image, then paste (<kbd>⌘V</kbd>/<kbd>Ctrl+V</kbd>).

Match **Settings → Google Docs → Document page size** to your document's page setup (Letter, A4, Legal). For *Pageless* documents, choose **Pageless** to keep one image per capture (split only at 25 MP).

## Quality and resolution

Chrome's `captureVisibleTab` returns the tab at your **display's pixel density** — 2× on Retina/HiDPI screens, 1× on most standard monitors. LongShot never upscales, so:

| Quality | 2× display | 3× display | 1× display |
|---|---|---|---|
| Standard | 1× (downsampled, smaller file) | 1× | 1× |
| **High** (default) | **2× native** | 2× (downsampled) | 1× |

High keeps captures up to 2.75× at native resolution — e.g. 2.2× when a Retina page is zoomed to 110% — because a fractional resample like 2.2 → 2 would soften text.
| Maximum | 2× native | 3× native | 1× |

The popup tells you when your display limits the result. **Tip for 1× displays:** zoom the page in (<kbd>Ctrl</kbd>+<kbd>+</kbd>) before capturing — Chrome renders at the higher zoom, and LongShot captures those real pixels. (The page layout becomes narrower, like on a smaller window.)

## Settings

Open from the ⚙ button in the popup, or right-click the icon → **Options**. Changes save automatically.

| Section | Setting | Default |
|---|---|---|
| Capture | Default quality · format | High · PNG |
| | Capture delay (0 / 250 / 500 / 1000 / 2000 ms) | 500 ms |
| | Fixed & sticky elements (Smart / Hide completely / Don't change) | Smart |
| | Pause animations · Preload lazy content · Restore scroll position | On · On · On |
| Output | PNG compression (Fast / Balanced / Smallest — always lossless) | Balanced |
| | JPEG / WebP quality | 95% |
| | Maximum image height (auto-split above it) | 100,000 px |
| | Split long screenshots · part height | Off · 16,000 px |
| | Download automatically · Open result page after capture | On · Off |
| Google Docs | Optimized by default · page size | Off · Letter |
| Advanced | Maximum page length (infinite-scroll safety) | 100,000 CSS px |
| | Debug logging · Show capture coordinates | Off · Off |

*Restore scroll position* off = "stay at bottom". Cancelled or failed captures always restore.

*Show capture coordinates* shows coordinates while selecting and, on the result page, a table of every section's scroll offset and output rows, with dashed seam markers drawn on the image.

## Permissions

LongShot requests only what it uses and has **no host permissions** — it can't see any page until you invoke it. Nothing is sent over the network.

| Permission | Why |
|---|---|
| `activeTab` | Temporary access to the current tab only after you click the icon or press a shortcut — required to screenshot and scroll it. |
| `scripting` | Injects the capture helper into that tab to measure, scroll, handle sticky elements and restore the page. |
| `downloads` | Saves the finished image(s) to Downloads › LongShot. |
| `offscreen` | A hidden extension page that stitches and encodes images (service workers can't create the blob URLs downloads need). |
| `storage` | Saves your settings (synced with your Chrome profile). |
| `clipboardWrite` | The result page's **Copy** button. |

Captured sections and results are stored temporarily in the extension's IndexedDB so large captures don't sit in memory; only the 3 most recent results are kept.

## How it works

```
Popup / shortcut ──► Service worker (capture controller)
                        │  1. inject page agent (content scripts)
                        │  2. prepare: detect scroll target, freeze animations,
                        │     convert sticky → relative, classify fixed elements
                        │  3. optional pre-scroll for lazy content
                        │  4. loop: scroll → wait (delay, images, 2 frames)
                        │           → set fixed-element phase → captureVisibleTab
                        │           → store tile + measured scroll offset (IndexedDB)
                        │  5. restore page (styles, scroll)
                        ▼
                     Offscreen document
                        6. layout: place tiles by measured offsets, later tiles win overlaps
                        7. plan parts (format limits, Docs pages) + find blank-row cuts
                        8. render strip by strip → streaming PNG encoder / canvas (JPEG, WebP)
                        9. store outputs → blob URLs → chrome.downloads
```

**Why stitching is exact.** The agent reports the *actual* scroll offset after each scroll (pages clamp, snap, or refuse). Each tile records which viewport band it covers and where that band sits in content coordinates, so its output rows are `round((contentTop − start) × scale)`. The last section, clamped to the page bottom, therefore overlaps the previous one by exactly the right number of rows, and the overlap is drawn once. `scroll-behavior: smooth` and scroll snapping are neutralised during capture so programmatic scrolls land where requested.

**Fixed elements.** Sticky elements become `position: relative` (same layout, no stickiness), so they appear once in their natural place. Fixed elements are classified by position: top-anchored ones show only in the first section, bottom-anchored ones only in the last, full-bleed backgrounds (z-index ≤ 0) always, and elements that only appear after scrolling never. Hiding uses inline `opacity: 0 !important`; original inline styles are recorded and restored (and left alone if the page changed them meanwhile).

**Huge PNGs.** Chrome canvases max out at 32,767 px per side. LongShot's encoder takes ~1,000 rows at a time, applies PNG row filters in JavaScript and pipes them through the browser's native zlib (`CompressionStream('deflate')`), assembling IDAT chunks into a disk-backed Blob. Output is 8-bit sRGB with a pHYs DPI tag matching the capture scale.

**Clean page cuts.** For each split, rows in a window above the ideal cut are scored by horizontal detail plus change from the row above; LongShot picks the quietest row nearest the ideal position and centres the cut in that whitespace run.

## Project structure

```
longshot/                      ← load this folder in chrome://extensions
├── manifest.json
├── background/
│   ├── service-worker.js      message routing, shortcuts, capture lifecycle
│   ├── capture-controller.js  scroll/capture loop, tab checks, quota throttling
│   ├── offscreen-client.js    offscreen document management
│   ├── downloads.js           chrome.downloads + offscreen cleanup
│   └── state-hub.js           progress state → popup (ports) + toolbar badge
├── content/                   injected on demand (isolated world)
│   ├── dom-utils.js           frames, element walking, style save/restore, media waits
│   ├── scroll-target.js       window vs inner scroll container detection & metrics
│   ├── page-freezer.js        animations, smooth scroll, snap, lazy images
│   ├── fixed-elements.js      sticky/fixed classification and phases
│   ├── selection-overlay.js   Custom Area UI (shadow DOM)
│   └── agent.js               command handler + watchdog restore
├── capture/
│   ├── stitch-plan.js         pure geometry: layout, part planning, cut selection
│   ├── stitcher.js            strip renderer, tile decoder cache, part encoding
│   └── crop.js                pixel-exact crop (streams PNG rows beyond canvas limits)
├── offscreen/                 offscreen.html / offscreen.js — processing jobs
├── popup/                     popup.html / .css / .js
├── options/                   options.html / .css / .js
├── result/                    result.html / .css / .js — viewer, copy, download
│   └── crop-editor.js         interactive crop overlay + toolbar
├── ui/theme.css               shared glass design system (light/dark)
├── utils/
│   ├── constants.js           limits, message types, modes
│   ├── storage.js             settings defaults + validation
│   ├── image-db.js            IndexedDB sessions & blobs
│   ├── png-encoder.js         streaming PNG encoder
│   ├── page-detection.js      restricted URL detection
│   ├── errors.js              error codes → friendly messages
│   ├── filenames.js · format.js · logger.js
└── icons/                     16 / 32 / 48 / 128 px

dev/                           ← tooling, not shipped
├── generate-icons.mjs         regenerates icons (no dependencies)
├── package-extension.mjs      validates manifest and zips for the Web Store
└── test/
    ├── unit.mjs               geometry, cuts, PNG encoder round-trips, settings
    ├── e2e.mjs                real captures in Chrome for Testing, pixel-verified
    ├── fixtures.mjs           local test pages + stripe decoding
    ├── screenshots.mjs        renders UI states (light/dark) for review
    └── real-sites.mjs         captures public websites for visual review
```

## Development

Requirements: Chrome 116+ (for the extension); Node.js 20+ for tooling.

- Edit files in `longshot/`, then click ↻ on the extension card in `chrome://extensions` (reopen the popup to see popup changes; reload open tabs is not required — content scripts are injected fresh on each capture).
- **Service worker logs:** `chrome://extensions` → LongShot → *service worker* link. Turn on **Settings → Advanced → Debug logging** for detailed capture decisions (scale, tile positions, part plan).
- **Offscreen logs:** `chrome://extensions` → LongShot → *Inspect views: offscreen.html* (visible while processing).
- **Icons:** `node dev/generate-icons.mjs`.
- **Package:** `node dev/package-extension.mjs` → `dev/dist/longshot-<version>.zip`.

There is no build step and no runtime dependency.

## Testing

```bash
cd dev
npm install          # puppeteer (downloads Chrome for Testing) + pngjs
npm run test:unit    # fast, no browser
npm run test:e2e     # ~3 minutes, loads the extension into Chrome for Testing at 2× DPR
```

The E2E suite captures purpose-built pages whose 10 px stripes encode their own index in their colour. Reading any column of the output back must give indices increasing by exactly one, each exactly 20 rows tall at 2× — so a single duplicated, missing or shifted row fails the test. It covers: full page (with smooth scrolling and scroll snap enabled), from-current-position with scroll restore, sticky sidebar, fixed header + bottom bubble + late "back to top" button, native and IntersectionObserver lazy images, inner scroll containers, infinite scroll, visible area, custom area with drag auto-scroll, Docs mode (cuts on blank rows, ≤ page height, ≤ 25 MP), JPEG at Standard quality, WebP auto-split, a 40,000 px single PNG, the crop editor (typed edges, dragged handle, repeated crop, restore original — verified pixel-exact), a 36,000 px crop beyond the canvas limit, auto-download filenames, cancel-and-restore, restricted pages, From Here not painting fixed headers over content, Custom Area on a Trusted Types page (like Gmail/Docs), rejecting simultaneous capture requests, clearing a selection abandoned by a page reload, and the popup reaching its result view after a very fast capture.

The test copy of the extension adds `host_permissions: <all_urls>` because automation can't click the toolbar button to grant `activeTab`; the shipped manifest does not include it.

`node test/popup-height.mjs` checks every popup state against Chrome's 600 px popup height limit at 1× and 2×.

Other scripts: `node test/screenshots.mjs [dir]` renders every popup state plus the settings and result pages in light and dark mode; `node test/real-sites.mjs [dir] [urls…]` captures public sites (Wikipedia, MDN, Chrome docs, Tailwind, GitHub by default) for visual review.

**Manual checklist** for a release (on a real display): simple article · long documentation page · Wikipedia · blog · sticky header · fixed sidebar · lazy images · very long page · responsive/narrow window · dark-mode site · page with large images · Google Docs insert of Docs-optimized parts · Custom Area taller than the screen · shortcut capture · cancel with Esc · a `chrome://` page.

## Troubleshooting

| Problem | Fix |
|---|---|
| **"This page can't be captured"** | Chrome blocks extensions on `chrome://` pages, the New Tab page, the Chrome Web Store and other extensions' pages. Use a normal website. |
| **"No access to this tab"** | Chrome grants access when you click the LongShot icon or press its shortcut *on that tab*. Click the icon again, then capture. |
| **Local `file://` pages fail** | `chrome://extensions` → LongShot → Details → enable **Allow access to file URLs**. |
| **Capture interrupted / tab switched** | Chrome can only capture the visible tab. Keep the tab in front and the window unminimized until it finishes. |
| **Blank or grey images in the result** | The page loads images slowly. Increase **Capture delay** to 1000–2000 ms and keep **Preload lazy content** on. |
| **Header or banner repeated** | Make sure **Fixed & sticky elements** is *Smart*. For stubborn cookie/chat widgets choose *Hide completely*. Please report the site. |
| **Content duplicated or cut mid-page** | The page moved during capture (carousels, auto-refreshing feeds). Enable **Pause animations**, increase the delay, or capture a Custom Area. The result page warns when LongShot detected movement. |
| **Image is only 1× even on High** | Your display is 1× — see [Quality and resolution](#quality-and-resolution). |
| **Text is tiny in Google Docs** | Turn on **Google Docs Optimized** and insert the page-sized parts. |
| **Capture stops early on an endless feed** | Raise **Maximum page length** in Advanced settings. |
| **"Page is pinch-zoomed"** | Pinch back out to 100% (trackpad zoom). Normal ⌘/Ctrl +/− zoom is fine. |
| **Shortcut doesn't work** | Another extension may own it. Assign one at `chrome://extensions/shortcuts`. |
| **Download failed** | The result page opens automatically — use its Download or Copy buttons. Check that Chrome can write to your Downloads folder. |
| **Something else** | Enable **Debug logging**, reproduce, and check the service worker console. |

## Known limitations

- **Horizontal scrolling** isn't stitched; LongShot captures the page's current horizontal viewport.
- **Cross-origin iframes with their own scrollbars** (embedded maps, some comment widgets) are captured as they appear, not expanded.
- **Canvas/WebGL animations and GIFs** can't be paused.
- **Custom Area** extends by scrolling the document; on app layouts that scroll an inner container, select within the visible screen or use Full Page.
- **Chrome's PDF viewer** supports Visible Area only.
- Pages that **re-layout on every scroll** (scroll-jacking, parallax driven by JavaScript) may not be capturable perfectly; LongShot reports detected jumps.
