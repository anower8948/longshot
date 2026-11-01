/**
 * Chrome caps extension popups at 600 px tall (800 px wide); anything taller
 * scrolls and can push the Start button out of view. Measures every popup
 * state at 1× and 2× device pixel ratios.
 *
 *   node dev/test/popup-height.mjs   (exits 1 if any state is too tall)
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startFixtureServer } from './fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIMIT = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;

for (const dpr of [1, 2]) {
  const workDir = mkdtempSync(join(tmpdir(), 'longshot-popup-'));
  const extensionDir = join(workDir, 'extension');
  cpSync(join(ROOT, 'longshot'), extensionDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  const { server, origin } = await startFixtureServer();
  const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [extensionDir], defaultViewport: null, args: ['--window-size=1280,900', `--force-device-scale-factor=${dpr}`] });
  const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const id = new URL(workerTarget.url()).host;
  const worker = await workerTarget.worker();
  const fixture = await browser.newPage();
  await fixture.goto(`${origin}/text`);
  await worker.evaluate((url) => chrome.windows.create({ url, focused: false }), `chrome-extension://${id}/options/options.html`);
  const helper = await (await browser.waitForTarget((t) => t.url().includes('options.html'))).page();
  const tabId = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, origin);
  await helper.evaluate(async () => {
    const { saveSettings } = await import(chrome.runtime.getURL('utils/storage.js'));
    await saveSettings({ autoDownload: false, captureDelay: 250, docsOptimized: true, quality: 'maximum', splitLongScreenshots: false });
  });

  const popup = await browser.newPage();
  await popup.evaluateOnNewDocument((t) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active && info.currentWindow ? [await chrome.tabs.get(t)] : original(info));
  }, tabId);
  await popup.setViewport({ width: 376, height: 400, deviceScaleFactor: dpr });
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await sleep(1000);

  const measure = async (label) => {
    const height = await popup.evaluate(() => document.documentElement.scrollHeight);
    const ok = height <= LIMIT;
    if (!ok) failed = true;
    console.log(`  ${ok ? '✓' : '✗'} DPR ${dpr} ${label}: ${height}px`);
  };

  await measure('main (Maximum + Docs, with notes)');
  await popup.click('input[value="high"]');
  await sleep(200);
  await measure('main (High + Docs)');
  await fixture.bringToFront();
  await popup.evaluate(() => document.getElementById('start').click());
  await sleep(2500);
  await measure('progress');
  for (let i = 0; i < 120; i += 1) {
    if (await popup.evaluate(() => !document.getElementById('view-done').hidden)) break;
    await sleep(500);
  }
  await sleep(800);
  await measure('done (multi-image note + preview)');
  await popup.evaluate(() => {
    document.getElementById('view-done').hidden = true;
    const view = document.getElementById('view-error');
    view.hidden = false;
    document.getElementById('error-title').textContent = 'Screenshot permission denied';
    document.getElementById('error-message').textContent = 'Chrome refused to capture the tab.';
    document.getElementById('error-hint').hidden = false;
    document.getElementById('error-hint').textContent = 'Click the LongShot icon on this tab (this grants access), keep the tab visible, and try again.';
    document.getElementById('error-detail-wrap').hidden = false;
    document.getElementById('error-detail-wrap').open = true;
    document.getElementById('error-detail').textContent = 'Either the <all_urls> or activeTab permission is required. '.repeat(3);
  });
  await measure('error (hint + open details)');

  await popup.goto('about:blank');
  await helper.evaluate(() => chrome.runtime.sendMessage({ type: 'LS_RESET_STATE' }));
  await fixture.goto('chrome://version');
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await sleep(1000);
  await measure('main (restricted page banner)');

  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
