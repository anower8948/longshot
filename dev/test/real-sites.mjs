/**
 * Captures real websites and writes the results (plus a downscaled overview)
 * for visual inspection. Requires network access.
 *
 *   node dev/test/real-sites.mjs [outputDir] [url ...]
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'dev', 'real-sites'));
const DEFAULT_URLS = [
  'https://en.wikipedia.org/wiki/Portable_Network_Graphics',
  'https://developer.mozilla.org/en-US/docs/Web/CSS/position',
  'https://developer.chrome.com/docs/extensions/reference/api/tabs',
  'https://tailwindcss.com/docs/installation',
  'https://github.com/puppeteer/puppeteer',
];
const urls = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_URLS;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workDir = mkdtempSync(join(tmpdir(), 'longshot-real-'));
const extensionDir = join(workDir, 'extension');
cpSync(join(ROOT, 'longshot'), extensionDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [extensionDir],
  defaultViewport: null,
  args: ['--window-size=1440,900', '--force-device-scale-factor=2'],
});
const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
const id = new URL(workerTarget.url()).host;
const worker = await workerTarget.worker();
await worker.evaluate((url) => chrome.windows.create({ url, focused: false }), `chrome-extension://${id}/options/options.html`);
const helper = await (await browser.waitForTarget((t) => t.url().includes('options.html'))).page();
await helper.evaluate(async () => {
  const { saveSettings } = await import(chrome.runtime.getURL('utils/storage.js'));
  await saveSettings({ autoDownload: false, captureDelay: 500, maxPageLength: 30000 });
});
const tab = await browser.newPage();

/** Box-filter downscale to `width` for a quick overview image. */
function overview(png, width) {
  const factor = png.width / width;
  const height = Math.floor(png.height / factor);
  const out = new PNG({ width, height });
  const f = Math.floor(factor);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy += 1) {
        for (let dx = 0; dx < f; dx += 1) {
          const i = ((y * f + dy) * png.width + x * f + dx) * 4;
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = r / (f * f);
      out.data[o + 1] = g / (f * f);
      out.data[o + 2] = b / (f * f);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

for (const [n, url] of urls.entries()) {
  const name = `${n + 1}-${new URL(url).hostname.replace(/^www\./, '')}`;
  const started = Date.now();
  try {
    await tab.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
    await tab.bringToFront();
    await sleep(800);
    const tabId = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u.split('#')[0].slice(0, 30)))?.id, tab.url());
    const since = Date.now();
    const response = await helper.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'LS_START_CAPTURE', tabId, mode: 'full', overrides: {} });
    if (!response.ok) throw new Error(JSON.stringify(response.error));
    let state;
    for (;;) {
      state = (await helper.evaluate(() => chrome.runtime.sendMessage({ type: 'LS_GET_STATE' }))).data;
      if (state.updatedAt >= since && ['done', 'error', 'cancelled'].includes(state.status)) break;
      await sleep(400);
    }
    if (state.status !== 'done') throw new Error(JSON.stringify(state.error));
    const { base64, session } = await helper.evaluate(async (sessionId) => {
      const db = await import(chrome.runtime.getURL('utils/image-db.js'));
      const s = await db.getSession(sessionId);
      const blob = await db.getBlob(s.outputs[0].key);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { base64: btoa(binary), session: s };
    }, state.result.sessionId);
    const buffer = Buffer.from(base64, 'base64');
    writeFileSync(join(OUT, `${name}.png`), buffer);
    const png = PNG.sync.read(buffer);
    writeFileSync(join(OUT, `${name}-overview.png`), PNG.sync.write(overview(png, 360)));
    const restored = await tab.evaluate(() => ({ scrollY, style: Boolean(document.getElementById('longshot-capture-style')) }));
    console.log(`  ✓ ${name}: ${png.width}×${png.height}, ${session.tileCount} sections, ${(buffer.length / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)}s, warnings=[${session.warnings}] restored=${restored.scrollY === 0 && !restored.style}`);
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}

await browser.close();
rmSync(workDir, { recursive: true, force: true });
