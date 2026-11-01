/**
 * End-to-end tests: loads the real extension into Chrome for Testing at a 2×
 * device scale factor, drives captures through the same messages the popup
 * sends, and verifies the stitched output pixel by pixel.
 *
 *   cd dev && npm install && npm run test:e2e
 *   node dev/test/e2e.mjs --only=fixed,sticky   # run a subset
 *   HEADFUL=1 node dev/test/e2e.mjs             # watch it run
 *
 * The test copy of the extension adds host_permissions: <all_urls>, because
 * automation can't click the toolbar button to grant activeTab.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { startFixtureServer, stripeRuns, checkContinuity } from './fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_SRC = join(ROOT, 'longshot');
const SCALE = 2;
const WINDOW = { width: 1280, height: 900 };
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ setup

const workDir = mkdtempSync(join(tmpdir(), 'longshot-e2e-'));
const extensionDir = join(workDir, 'extension');
const downloadDir = join(workDir, 'downloads');
cpSync(EXTENSION_SRC, extensionDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const { server, origin } = await startFixtureServer();

// Point the profile's download folder at a temp dir (like a real user's
// setting) so the extension's own filenames are used.
const profileDir = join(workDir, 'profile');
mkdirSync(join(profileDir, 'Default'), { recursive: true });
writeFileSync(
  join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } }),
);

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  pipe: true,
  enableExtensions: [extensionDir],
  defaultViewport: null,
  userDataDir: profileDir,
  args: [`--window-size=${WINDOW.width},${WINDOW.height}`, `--force-device-scale-factor=${SCALE}`, '--hide-scrollbars=false', '--no-first-run'],
});

const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'), { timeout: 20_000 });
const extensionId = new URL(workerTarget.url()).host;
const worker = await workerTarget.worker();
worker.on('console', (message) => {
  if (process.env.VERBOSE || message.type() === 'error') console.log(`    [sw:${message.type()}] ${message.text()}`);
});

// Helper extension page in its own window, so the fixture tab stays active.
await worker.evaluate((url) => chrome.windows.create({ url, focused: false, width: 500, height: 400 }), `chrome-extension://${extensionId}/options/options.html`);
const helperTarget = await browser.waitForTarget((t) => t.url().includes('/options/options.html'));
const helper = await helperTarget.page();

const fixtureTab = await browser.newPage();
fixtureTab.on('console', (message) => {
  if (process.env.VERBOSE) console.log(`    [page] ${message.text()}`);
});

async function tabIdFor(url) {
  return helper.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)?.id;
  }, url);
}

async function setSettings(patch) {
  await helper.evaluate(async (values) => {
    const { saveSettings, resetSettings } = await import(chrome.runtime.getURL('utils/storage.js'));
    await resetSettings();
    await saveSettings(values);
  }, { autoDownload: false, captureDelay: 250, ...patch });
}

async function send(message) {
  return helper.evaluate((msg) => chrome.runtime.sendMessage(msg), message);
}

async function openFixture(path) {
  const url = `${origin}${path}`;
  await fixtureTab.goto(url, { waitUntil: 'load' });
  await fixtureTab.bringToFront();
  await sleep(150);
  return { url, tabId: await tabIdFor(url) };
}

async function waitForTerminalState(since, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await send({ type: 'LS_GET_STATE' });
    const state = response?.data;
    if (state && state.updatedAt >= since && ['done', 'error', 'cancelled'].includes(state.status)) return state;
    await sleep(250);
  }
  throw new Error('Timed out waiting for capture to finish');
}

async function capture(path, mode, settings = {}, { beforeStart, duringCapture } = {}) {
  await setSettings(settings);
  const { tabId, url } = await openFixture(path);
  if (beforeStart) await beforeStart();
  const since = Date.now();
  const response = await send({ type: 'LS_START_CAPTURE', tabId, mode, overrides: {} });
  if (!response?.ok) return { error: response?.error, url, tabId };
  if (duringCapture) await duringCapture();
  const state = await waitForTerminalState(since);
  if (state.status !== 'done') return { error: state.error, state, url, tabId };
  const data = await helper.evaluate(async (sessionId) => {
    const db = await import(chrome.runtime.getURL('utils/image-db.js'));
    const session = await db.getSession(sessionId);
    const parts = [];
    for (const output of session.outputs) {
      const blob = await db.getBlob(output.key);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      let dims = null;
      if (output.mime !== 'image/png') {
        const bitmap = await createImageBitmap(blob);
        dims = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
      }
      parts.push({ ...output, base64: btoa(binary), dims });
    }
    return { session, parts };
  }, state.result.sessionId);
  return { state, url, tabId, ...data };
}

function decode(part) {
  return PNG.sync.read(Buffer.from(part.base64, 'base64'));
}

function pixel(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

function isColor(rgb, target, tolerance = 6) {
  return rgb.every((value, i) => Math.abs(value - target[i]) <= tolerance);
}

/** Rows (in the given column) whose colour matches `target`. */
function rowsWithColor(png, x, target) {
  const rows = [];
  for (let y = 0; y < png.height; y += 1) if (isColor(pixel(png, x, y), target)) rows.push(y);
  return rows;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertContinuous(png, x, label, y0 = 0, y1 = png.height, tolerance = 0) {
  const runs = stripeRuns(png, x, y0, y1);
  const error = checkContinuity(runs, 10 * SCALE, { tolerance, label });
  assert(!error, error);
  return runs;
}

async function pageState() {
  return fixtureTab.evaluate(() => ({
    scrollY: window.scrollY,
    captureStyle: Boolean(document.getElementById('longshot-capture-style')),
    styledElements: [...document.querySelectorAll('[style*="opacity: 0"], [style*="important"]')].length,
  }));
}

// ------------------------------------------------------------------ tests

const tests = {
  async 'full-page-stripes'() {
    const result = await capture('/stripes?h=12345', 'full');
    assert(!result.error, JSON.stringify(result.error));
    const [part] = result.parts;
    assert(result.parts.length === 1, `expected 1 image, got ${result.parts.length}`);
    const png = decode(part);
    const clientWidth = await fixtureTab.evaluate(() => document.documentElement.clientWidth);
    assert(png.width === clientWidth * SCALE, `width ${png.width} != ${clientWidth * SCALE}`);
    assert(png.height === 12345 * SCALE, `height ${png.height} != ${12345 * SCALE}`);
    for (const x of [10, Math.floor(png.width / 2), png.width - 10]) assertContinuous(png, x, `column ${x}`);
    const runs = stripeRuns(png, 100);
    assert(runs[0].index === 0 && runs.at(-1).index === 1234, `stripe range ${runs[0].index}..${runs.at(-1).index}`);
    const state = await pageState();
    assert(state.scrollY === 0 && !state.captureStyle, `page not restored: ${JSON.stringify(state)}`);
    return `${png.width}×${png.height}, ${result.session.tileCount} sections, ${(part.bytes / 1e6).toFixed(2)} MB`;
  },

  async 'restore-scroll-and-from-current'() {
    let start = 0;
    const result = await capture('/stripes?h=9000', 'current', {}, {
      // The fixture uses scroll-snap, so read where the page actually settled.
      beforeStart: async () => {
        start = await fixtureTab.evaluate(async () => {
          window.scrollTo({ top: 4200, behavior: 'instant' });
          await new Promise((r) => setTimeout(r, 300));
          return window.scrollY;
        });
      },
    });
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    assert(png.height === (9000 - start) * SCALE, `height ${png.height}, expected ${(9000 - start) * SCALE}`);
    const runs = assertContinuous(png, 50, 'from-current');
    assert(runs[0].index === start / 10, `starts at stripe ${runs[0].index}, expected ${start / 10}`);
    const state = await pageState();
    assert(state.scrollY === start, `scroll not restored: ${state.scrollY}, expected ${start}`);
    return `${png.width}×${png.height}, started at stripe ${runs[0].index}, scroll restored to ${state.scrollY}`;
  },

  async 'sticky-header'() {
    const result = await capture('/sticky', 'full', {}, {
      beforeStart: () => fixtureTab.evaluate(() => window.scrollTo({ top: 2500, behavior: 'instant' })),
    });
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    const magenta = rowsWithColor(png, 100 * SCALE, [255, 0, 255]);
    assert(magenta.length === 300 * SCALE, `sticky nav rows: ${magenta.length}, expected ${300 * SCALE}`);
    assert(magenta[0] === 0 && magenta.at(-1) === 300 * SCALE - 1, `sticky nav at rows ${magenta[0]}..${magenta.at(-1)}`);
    assertContinuous(png, 600 * SCALE, 'content column');
    const after = await fixtureTab.evaluate(() => ({
      scrollY,
      style: document.getElementById('sticky-nav').getAttribute('style'),
      position: getComputedStyle(document.getElementById('sticky-nav')).position,
    }));
    assert(after.scrollY === 2500, `scroll ${after.scrollY}`);
    assert(after.position === 'sticky' && !after.style.includes('important'), `sticky not restored: ${JSON.stringify(after)}`);
    return `nav appears once (rows 0–${magenta.at(-1)}), restored to sticky`;
  },

  async 'fixed-header-bubble-backtotop'() {
    const result = await capture('/fixed', 'full');
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    const H = png.height;
    assert(H === (9000 + 64) * SCALE, `height ${H}`);
    const magenta = rowsWithColor(png, 640 * SCALE, [255, 0, 255]);
    assert(magenta.length === 64 * SCALE && magenta.at(-1) === 64 * SCALE - 1, `fixed header rows ${magenta.length} (last ${magenta.at(-1)})`);
    assertContinuous(png, 640 * SCALE, 'under header', 64 * SCALE);

    const clientWidth = await fixtureTab.evaluate(() => document.documentElement.clientWidth);
    const bubbleX = (clientWidth - 24 - 32) * SCALE;
    const green = rowsWithColor(png, bubbleX, [0, 255, 0]);
    assert(green.length === 64 * SCALE, `bubble rows ${green.length}, expected ${64 * SCALE}`);
    assert(green[0] === H - (24 + 64) * SCALE, `bubble starts at row ${green[0]}, expected ${H - 88 * SCALE}`);

    const orange = rowsWithColor(png, 64 * SCALE, [255, 136, 0]);
    assert(orange.length === 0, `"back to top" button captured in ${orange.length} rows`);
    const state = await pageState();
    assert(!state.captureStyle && state.styledElements === 0, `page not restored: ${JSON.stringify(state)}`);
    return 'header once at top, bubble once at bottom, late-appearing button hidden';
  },

  async 'lazy-images'() {
    const result = await capture('/lazy', 'full', { captureDelay: 500 });
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    const colors = ['ff0000', '00aa00', '0000ff', 'ffaa00', 'aa00ff', '00aaaa', 'aaaa00', 'ff0088', '008888', '884400', '004488', '448800'];
    const cx = Math.floor(png.width / 2);
    const failures = [];
    colors.forEach((hex, index) => {
      const y = (index * 1000 + 100 + 200) * SCALE;
      const expected = [0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16));
      const actual = pixel(png, cx, y);
      if (!isColor(actual, expected, 8)) failures.push(`image ${index} (${hex}) is rgb(${actual})`);
    });
    assert(!failures.length, failures.join('; '));
    return `all ${colors.length} lazy images loaded (native + IntersectionObserver)`;
  },

  async 'inner-scroll-container'() {
    const result = await capture('/inner', 'full');
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    const expected = await fixtureTab.evaluate(() => {
      const el = document.getElementById('scroller');
      return { width: el.clientWidth, height: el.scrollHeight };
    });
    assert(png.width === expected.width * SCALE, `width ${png.width}, expected ${expected.width * SCALE}`);
    assert(png.height === expected.height * SCALE, `height ${png.height}, expected ${expected.height * SCALE}`);
    assertContinuous(png, Math.floor(png.width / 2), 'inner');
    const scrollTop = await fixtureTab.evaluate(() => document.getElementById('scroller').scrollTop);
    assert(scrollTop === 0, `container scroll not restored: ${scrollTop}`);
    return `${png.width}×${png.height} from the scrolling container`;
  },

  async 'infinite-scroll'() {
    const result = await capture('/infinite', 'full', { captureDelay: 500 });
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    const total = await fixtureTab.evaluate(() => document.getElementById('feed').offsetHeight);
    assert(total === 9000, `feed grew to ${total}, expected 9000`);
    assert(png.height === total * SCALE, `height ${png.height}, expected ${total * SCALE}`);
    const runs = assertContinuous(png, 300, 'infinite');
    return `captured ${runs.length} stripes after the feed grew to ${total}px`;
  },

  async 'visible-area'() {
    let start = 0;
    const result = await capture('/stripes?h=5000', 'visible', {}, {
      beforeStart: async () => {
        start = await fixtureTab.evaluate(async () => {
          window.scrollTo({ top: 1000, behavior: 'instant' });
          await new Promise((r) => setTimeout(r, 300));
          return window.scrollY;
        });
      },
    });
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    const viewport = await fixtureTab.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    assert(png.width === viewport.w * SCALE && png.height === viewport.h * SCALE, `${png.width}×${png.height} vs viewport ${viewport.w}×${viewport.h}`);
    const runs = assertContinuous(png, 40, 'visible');
    assert(runs[0].index === start / 10, `first stripe ${runs[0].index}, expected ${start / 10}`);
    return `${png.width}×${png.height}`;
  },

  async 'region-drag-with-autoscroll'() {
    await setSettings({});
    const { tabId } = await openFixture('/stripes?h=6000');
    const since = Date.now();
    const response = await send({ type: 'LS_START_CAPTURE', tabId, mode: 'region', overrides: {} });
    assert(response?.ok && response.data.selecting, `selection did not start: ${JSON.stringify(response)}`);
    await sleep(300);
    const viewportHeight = await fixtureTab.evaluate(() => document.documentElement.clientHeight);
    await fixtureTab.mouse.move(300, 205);
    await fixtureTab.mouse.down();
    await fixtureTab.mouse.move(700, viewportHeight - 10, { steps: 10 });
    await sleep(900); // auto-scroll near the bottom edge
    await fixtureTab.mouse.move(700, viewportHeight - 300, { steps: 5 });
    await fixtureTab.mouse.up();
    await sleep(200);
    const scrolled = await fixtureTab.evaluate(() => window.scrollY);
    await fixtureTab.keyboard.press('Enter');
    const state = await waitForTerminalState(since);
    assert(state.status === 'done', JSON.stringify(state.error));
    const session = await helper.evaluate(async (id) => {
      const db = await import(chrome.runtime.getURL('utils/image-db.js'));
      const s = await db.getSession(id);
      const blob = await db.getBlob(s.outputs[0].key);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { base64: btoa(binary) };
    }, state.result.sessionId);
    const png = decode(session);
    const expectedHeight = (viewportHeight - 300 + scrolled - 205) * SCALE;
    assert(png.width === 400 * SCALE, `width ${png.width}`);
    assert(Math.abs(png.height - expectedHeight) <= SCALE, `height ${png.height}, expected ≈${expectedHeight}`);
    assert(png.height > viewportHeight * SCALE, 'selection should be taller than the viewport');
    assertContinuous(png, 100, 'region');
    const runs = stripeRuns(png, 100);
    assert(runs[1].index === 21, `region starts at stripe ${runs[0].index}/${runs[1].index}`);
    return `${png.width}×${png.height} selection spanning ${scrolled}px of auto-scroll`;
  },

  async 'docs-optimized-clean-cuts'() {
    const result = await capture('/text', 'full', { docsOptimized: true });
    assert(!result.error, JSON.stringify(result.error));
    const pngs = result.parts.map(decode);
    const width = pngs[0].width;
    const limit = Math.floor(width * (9 / 6.5) * 0.98);
    const pageHeight = await fixtureTab.evaluate(() => document.documentElement.scrollHeight);
    assert(pngs.length > 3, `expected several parts, got ${pngs.length}`);
    let total = 0;
    const cutReport = [];
    pngs.forEach((png, i) => {
      assert(png.width === width, `part ${i} width ${png.width}`);
      assert(png.height <= limit, `part ${i} height ${png.height} > ${limit}`);
      assert(png.width * png.height <= 25_000_000, `part ${i} exceeds 25 MP`);
      total += png.height;
      if (i < pngs.length - 1) {
        // The rows on both sides of each cut must be blank (no text sliced).
        const blank = (p, y) => {
          for (let x = 0; x < p.width; x += 1) if (!isColor(pixel(p, x, y), [255, 255, 255], 3)) return false;
          return true;
        };
        assert(blank(png, png.height - 1), `part ${i} ends on a row with ink`);
        assert(blank(pngs[i + 1], 0), `part ${i + 1} starts on a row with ink`);
        cutReport.push(png.height);
      }
    });
    assert(total === pageHeight * SCALE, `parts total ${total}, expected ${pageHeight * SCALE}`);
    return `${pngs.length} pages (${cutReport.join(', ')}…) all cut on blank rows, ≤${limit}px, ≤25 MP`;
  },

  async 'crop-editor-typed-and-dragged'() {
    const result = await capture('/stripes?h=6000', 'full');
    assert(!result.error, JSON.stringify(result.error));
    const sessionId = result.session.id;
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${extensionId}/result/result.html#${sessionId}&crop=0`);
    await page.waitForSelector('.crop-toolbar input[data-edge="top"]');
    await sleep(700);

    // 1) Typed values: keep rows 2000..8000 of the 12,000-row image.
    const setField = async (edge, value) => {
      await page.click(`.crop-toolbar input[data-edge="${edge}"]`, { clickCount: 3 });
      await page.keyboard.type(String(value));
      await page.keyboard.press('Enter');
    };
    await setField('top', 2000);
    await setField('bottom', 8000);
    await page.click('.crop-toolbar [data-action="apply"]');
    await page.waitForFunction(() => !document.querySelector('.crop-toolbar') && document.querySelector('.badge'), { timeout: 30_000 });

    const readPart = () =>
      helper.evaluate(async (id) => {
        const db = await import(chrome.runtime.getURL('utils/image-db.js'));
        const s = await db.getSession(id);
        const blob = await db.getBlob(s.outputs[0].key);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { base64: btoa(binary), part: s.outputs[0], output: s.output };
      }, sessionId);

    let stored = await readPart();
    let png = decode(stored);
    assert(png.width === result.parts[0].width || png.width === decode(result.parts[0]).width, `width ${png.width}`);
    assert(png.height === 6000 && stored.output.height === 6000, `typed crop height ${png.height}`);
    let runs = assertContinuous(png, 300, 'typed crop');
    assert(runs[0].index === 100 && runs[0].length === 20, `typed crop starts at stripe ${runs[0].index} (${runs[0].length} rows)`);
    assert(stored.part.original?.height === 12000, 'original not kept for restore');

    // 2) Drag the bottom edge handle up by 300 CSS px (the image is displayed at 1:2).
    const cropButton = await page.$('[data-action="crop"]');
    const hit = await cropButton.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { covered: !el.contains(top), topElement: top?.className || top?.tagName };
    });
    assert(!hit.covered, `Crop button is covered by ${hit.topElement}`);
    await cropButton.click();
    await page.waitForSelector('.crop-handle[data-handle="s"]', { timeout: 5_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.querySelector('.crop-handle[data-handle="s"]').scrollIntoView({ block: 'center' }));
    await sleep(400);
    const box = await (await page.$('.crop-handle[data-handle="s"]')).boundingBox();
    const frameBox = await (await page.$('.image-frame')).boundingBox();
    const displayScale = png.width / frameBox.width;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY - 150, { steps: 8 });
    await page.mouse.move(startX, startY - 300, { steps: 8 });
    await page.mouse.up();
    const typedBottom = await page.$eval('.crop-toolbar input[data-edge="bottom"]', (input) => Number(input.value));
    // The dragged edge must end exactly under the pointer, whatever the page scrolled.
    const handleAfter = await (await page.$('.crop-handle[data-handle="s"]')).boundingBox();
    const edgeY = handleAfter.y + handleAfter.height / 2;
    assert(Math.abs(edgeY - (startY - 300)) <= 1.5, `edge at y=${edgeY.toFixed(1)}, pointer released at y=${startY - 300}`);
    assert(typedBottom < 6000 - 250 * displayScale && typedBottom > 6000 - 350 * displayScale, `dragged bottom ${typedBottom}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.crop-toolbar'), { timeout: 30_000 });
    await sleep(300);

    stored = await readPart();
    png = decode(stored);
    assert(png.height === typedBottom, `dragged crop height ${png.height}, expected ${typedBottom}`);
    runs = assertContinuous(png, 300, 'dragged crop');
    assert(runs[0].index === 100, 'second crop should keep the first crop offset');
    assert(stored.part.original?.height === 12000, 'original should still be the uncropped capture');

    // 3) Restore original.
    await page.click('[data-action="restore"]');
    await page.waitForFunction(() => !document.querySelector('.badge'), { timeout: 10_000 });
    stored = await readPart();
    assert(stored.part.height === 12000 && !stored.part.original, `restore failed: ${JSON.stringify(stored.part)}`);
    await page.close();
    return `typed crop 6,000 rows from stripe 100 (pixel-exact), dragged edge → ${typedBottom} rows, original restored`;
  },

  async 'crop-beyond-canvas-limit'() {
    const result = await capture('/stripes?h=20000', 'full', { captureDelay: 0, preloadLazyContent: false });
    assert(!result.error, JSON.stringify(result.error));
    const cropped = await helper.evaluate(async (id) => {
      const db = await import(chrome.runtime.getURL('utils/image-db.js'));
      const { cropImageBlob } = await import(chrome.runtime.getURL('capture/crop.js'));
      const s = await db.getSession(id);
      const blob = await db.getBlob(s.outputs[0].key);
      const out = await cropImageBlob(blob, { x: 100, y: 1000, width: 800, height: 36000 }, { mime: 'image/png' });
      const bytes = new Uint8Array(await out.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { base64: btoa(binary) };
    }, result.session.id);
    const png = decode(cropped);
    assert(png.width === 800 && png.height === 36000, `${png.width}×${png.height}`);
    const runs = assertContinuous(png, 50, 'tall crop');
    assert(runs[0].index === 50, `starts at stripe ${runs[0].index}`);
    return `${png.width}×${png.height} crop (taller than the 32,767 px canvas limit), pixel-exact`;
  },

  async 'from-current-hides-fixed-header-over-content'() {
    let start = 0;
    const result = await capture('/fixed', 'current', {}, {
      beforeStart: async () => {
        start = await fixtureTab.evaluate(async () => {
          window.scrollTo({ top: 3000, behavior: 'instant' });
          await new Promise((r) => setTimeout(r, 200));
          return window.scrollY;
        });
      },
    });
    assert(!result.error, JSON.stringify(result.error));
    const png = decode(result.parts[0]);
    const magenta = rowsWithColor(png, 640 * SCALE, [255, 0, 255]);
    assert(magenta.length === 0, `fixed header painted over content in ${magenta.length} rows`);
    const runs = assertContinuous(png, 640 * SCALE, 'from-current under header');
    assert(runs[0].index === Math.floor((start - 64) / 10), `starts at stripe ${runs[0].index}, expected ${Math.floor((start - 64) / 10)}`);
    return `header hidden when starting at ${start}px; content under it captured`;
  },

  async 'trusted-types-page-region-and-full'() {
    await setSettings({});
    const { tabId } = await openFixture('/stripes?h=3000&tt=1');
    const since = Date.now();
    const response = await send({ type: 'LS_START_CAPTURE', tabId, mode: 'region', overrides: {} });
    assert(response?.ok && response.data.selecting, `selection failed on Trusted Types page: ${JSON.stringify(response)}`);
    await sleep(300);
    await fixtureTab.mouse.move(100, 100);
    await fixtureTab.mouse.down();
    await fixtureTab.mouse.move(500, 400, { steps: 5 });
    await fixtureTab.mouse.up();
    await fixtureTab.keyboard.press('Enter');
    const state = await waitForTerminalState(since);
    assert(state.status === 'done', JSON.stringify(state.error));
    assert(state.result.width === 400 * SCALE && state.result.height === 300 * SCALE, `${state.result.width}×${state.result.height}`);
    const full = await capture('/stripes?h=3000&tt=1', 'full');
    assert(!full.error, JSON.stringify(full.error));
    return `region ${state.result.width}×${state.result.height} and full page work under require-trusted-types-for`;
  },

  async 'concurrent-start-requests-are-rejected'() {
    await setSettings({ captureDelay: 500 });
    const { tabId } = await openFixture('/stripes?h=4000');
    const since = Date.now();
    const [a, b] = await helper.evaluate((id) => Promise.all([
      chrome.runtime.sendMessage({ type: 'LS_START_CAPTURE', tabId: id, mode: 'full', overrides: {} }),
      chrome.runtime.sendMessage({ type: 'LS_START_CAPTURE', tabId: id, mode: 'full', overrides: {} }),
    ]), tabId);
    const busy = [a, b].filter((r) => !r.ok && r.error.code === 'BUSY').length;
    const started = [a, b].filter((r) => r.ok).length;
    const state = await waitForTerminalState(since);
    assert(started === 1 && busy === 1, `expected one start and one BUSY, got ${JSON.stringify([a, b])}`);
    assert(state.status === 'done', JSON.stringify(state.error));
    return 'second simultaneous request answered BUSY; single capture completed';
  },

  async 'stale-selection-is-cleared-after-reload'() {
    await setSettings({});
    const { tabId } = await openFixture('/stripes?h=3000');
    const response = await send({ type: 'LS_START_CAPTURE', tabId, mode: 'region', overrides: {} });
    assert(response?.ok && response.data.selecting, JSON.stringify(response));
    let state = (await send({ type: 'LS_GET_STATE' })).data;
    assert(state.status === 'selecting', `expected selecting, got ${state.status}`);
    await fixtureTab.reload({ waitUntil: 'load' });
    state = (await send({ type: 'LS_GET_STATE' })).data;
    assert(state.status === 'idle', `stale selection still reported: ${state.status}`);
    return 'selection state reset once the page no longer shows the overlay';
  },

  async 'popup-fast-capture-reaches-done-view'() {
    await setSettings({ lastMode: 'visible' });
    const { tabId } = await openFixture('/stripes?h=3000');
    const popup = await browser.newPage();
    await popup.evaluateOnNewDocument((t) => {
      const original = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info.active && info.currentWindow ? [await chrome.tabs.get(t)] : original(info));
    }, tabId);
    await popup.setViewport({ width: 376, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await sleep(900);
    await fixtureTab.bringToFront();
    await popup.evaluate(() => document.getElementById('start').click());
    let view = '';
    for (let i = 0; i < 40; i += 1) {
      view = await popup.evaluate(() => ['view-main', 'view-progress', 'view-done', 'view-error'].find((v) => !document.getElementById(v).hidden));
      if (view === 'view-done' || view === 'view-error') break;
      await sleep(250);
    }
    const detail = await popup.evaluate(() => document.getElementById('done-resolution').textContent);
    await popup.close();
    assert(view === 'view-done', `popup ended on ${view}`);
    return `popup showed the result (${detail})`;
  },

  async 'standard-quality-jpeg'() {
    const result = await capture('/stripes?h=5000', 'full', { quality: 'standard', format: 'jpeg' });
    assert(!result.error, JSON.stringify(result.error));
    const [part] = result.parts;
    const clientWidth = await fixtureTab.evaluate(() => document.documentElement.clientWidth);
    assert(part.mime === 'image/jpeg', part.mime);
    assert(part.dims.width === clientWidth && part.dims.height === 5000, `${part.dims.width}×${part.dims.height}`);
    return `${part.dims.width}×${part.dims.height} JPEG at 1×`;
  },

  async 'webp-auto-split'() {
    const result = await capture('/stripes?h=20000', 'full', { format: 'webp', captureDelay: 0, preloadLazyContent: false });
    assert(!result.error, JSON.stringify(result.error));
    const heights = result.parts.map((p) => p.dims.height);
    assert(result.parts.length === 3, `expected 3 parts, got ${heights}`);
    assert(heights.every((h) => h <= 16383), `part too tall: ${heights}`);
    assert(heights.reduce((a, b) => a + b, 0) === 40000, `sum ${heights}`);
    return `WebP split into ${heights.join(' + ')} px`;
  },

  async 'very-long-single-png-beyond-canvas-limit'() {
    const result = await capture('/stripes?h=40000', 'full', { quality: 'standard', captureDelay: 0, preloadLazyContent: false });
    assert(!result.error, JSON.stringify(result.error));
    assert(result.parts.length === 1, `parts ${result.parts.length}`);
    const png = decode(result.parts[0]);
    assert(png.height === 40000 && png.height > 32767, `height ${png.height}`);
    // 2× → 1× resampling may soften stripe edges by a row.
    const runs = stripeRuns(png, 200);
    const error = checkContinuity(runs, 10, { tolerance: 1, label: 'downscaled' });
    assert(!error, error);
    return `${png.width}×${png.height} single PNG (canvas max is 32,767), ${result.session.tileCount} sections`;
  },

  async 'auto-download'() {
    const before = existsSync(join(downloadDir, 'LongShot')) ? readdirSync(join(downloadDir, 'LongShot')).length : 0;
    const result = await capture('/stripes?h=3000', 'full', { autoDownload: true });
    assert(!result.error, JSON.stringify(result.error));
    assert(result.state.downloaded, `download not started: ${JSON.stringify(result.state.downloadError)}`);
    const deadline = Date.now() + 15_000;
    let files = [];
    while (Date.now() < deadline) {
      files = existsSync(join(downloadDir, 'LongShot')) ? readdirSync(join(downloadDir, 'LongShot')).filter((f) => f.endsWith('.png')) : [];
      if (files.length > before) break;
      await sleep(250);
    }
    if (files.length <= before) {
      const items = await helper.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 3 }));
      throw new Error(`no file appeared in Downloads/LongShot; downloads: ${JSON.stringify(items.map((d) => ({ state: d.state, error: d.error, filename: d.filename, url: d.url.slice(0, 60) })))}`);
    }
    const file = join(downloadDir, 'LongShot', files.at(-1));
    const png = PNG.sync.read(readFileSync(file));
    assert(png.height === 6000, `downloaded height ${png.height}`);
    return `saved "${files.at(-1)}" (${(statSync(file).size / 1024).toFixed(0)} KB)`;
  },

  async 'cancel-restores-page'() {
    const result = await capture('/fixed', 'full', { captureDelay: 1000 }, {
      beforeStart: () => fixtureTab.evaluate(() => window.scrollTo({ top: 3000, behavior: 'instant' })),
      duringCapture: async () => {
        await sleep(3500);
        await send({ type: 'LS_CANCEL_CAPTURE' });
      },
    });
    assert(result.error?.code === 'CANCELLED', `expected CANCELLED, got ${JSON.stringify(result.error)}`);
    await sleep(300);
    const state = await pageState();
    assert(state.scrollY === 3000, `scroll ${state.scrollY}`);
    assert(!state.captureStyle && state.styledElements === 0, `page still modified: ${JSON.stringify(state)}`);
    return 'cancelled mid-capture; scroll and styles restored';
  },

  async 'restricted-page'() {
    await fixtureTab.goto('chrome://version');
    await fixtureTab.bringToFront();
    await sleep(400);
    // chrome:// URLs are hidden without the "tabs" permission: find the fixture
    // window's active tab instead.
    const tabId = await helper.evaluate(async () => {
      const own = await chrome.windows.getCurrent();
      const tabs = await chrome.tabs.query({ active: true });
      return tabs.find((tab) => tab.windowId !== own.id)?.id;
    });
    const since = Date.now();
    const response = await send({ type: 'LS_START_CAPTURE', tabId, mode: 'full', overrides: {} });
    let error = response.ok ? null : response.error;
    if (!error) error = (await waitForTerminalState(since, 20_000)).error;
    assert(error?.code === 'RESTRICTED_PAGE', JSON.stringify(error));
    const state = (await send({ type: 'LS_GET_STATE' })).data;
    assert(!state || state.status !== 'capturing', 'capture state stuck');
    return `"${error.title}"`;
  },
};

// ------------------------------------------------------------------ run

let failed = 0;
const names = Object.keys(tests).filter((name) => !only.length || only.some((o) => name.includes(o)));
console.log(`LongShot e2e — Chrome ${await browser.version()}, DPR ${SCALE}, ${names.length} tests\n`);

for (const name of names) {
  const started = Date.now();
  try {
    const detail = await tests[name]();
    console.log(`  ✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) — ${detail}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)\n    ${error.message}`);
  }
}

console.log(`\n${names.length - failed} passed, ${failed} failed`);
await browser.close();
server.close();
rmSync(workDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
