/**
 * Renders the extension UI (popup states, settings, result page) in light and
 * dark mode for visual review.
 *
 *   node dev/test/screenshots.mjs [outputDir]
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startFixtureServer } from './fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'dev', 'screenshots'));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workDir = mkdtempSync(join(tmpdir(), 'longshot-shots-'));
const extensionDir = join(workDir, 'extension');
cpSync(join(ROOT, 'longshot'), extensionDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));

const { server, origin } = await startFixtureServer();
const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [extensionDir],
  defaultViewport: null,
  args: ['--window-size=1280,900', '--force-device-scale-factor=2'],
});
const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
const id = new URL(workerTarget.url()).host;
const worker = await workerTarget.worker();

const fixture = await browser.newPage();
await fixture.goto(`${origin}/text`);

// Extension page in its own window so the fixture stays the active tab.
await worker.evaluate((url) => chrome.windows.create({ url, focused: false }), `chrome-extension://${id}/options/options.html`);
const helper = await (await browser.waitForTarget((t) => t.url().includes('options.html'))).page();
const fixtureTabId = await helper.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(url))?.id, origin);

async function popupPage(scheme) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  // Make the popup see the fixture as "the current tab" (it is opened as a tab here).
  await page.evaluateOnNewDocument((tabId) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active && info.currentWindow ? [await chrome.tabs.get(tabId)] : original(info));
  }, fixtureTabId);
  await page.setViewport({ width: 376, height: 640, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  await sleep(900);
  return page;
}

async function shot(page, name) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewport({ width: page.viewport().width, height, deviceScaleFactor: 2 });
  await sleep(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ${name}.png`);
}

for (const scheme of ['light', 'dark']) {
  const popup = await popupPage(scheme);
  await shot(popup, `popup-main-${scheme}`);
  if (scheme === 'light') {
    await popup.click('input[value="maximum"]');
    await popup.click('#docs-optimized');
    await sleep(300);
    await shot(popup, 'popup-docs-maximum-light');
    await popup.click('input[value="high"]');
    await popup.click('#docs-optimized');
  }

  // Start a real capture and grab progress + done views.
  await helper.evaluate(async () => {
    const { saveSettings } = await import(chrome.runtime.getURL('utils/storage.js'));
    await saveSettings({ autoDownload: false, captureDelay: 1000, openResultAfterCapture: false, lastMode: 'full' });
  });
  await fixture.bringToFront();
  await popup.evaluate(() => document.getElementById('start').click());
  await sleep(4200);
  await shot(popup, `popup-progress-${scheme}`);
  for (let i = 0; i < 120; i += 1) {
    if (await popup.evaluate(() => !document.getElementById('view-done').hidden)) break;
    await sleep(500);
  }
  await sleep(1200);
  await shot(popup, `popup-done-${scheme}`);

  const sessionId = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'LS_GET_STATE' }).then((r) => r.data.result.sessionId));
  const result = await browser.newPage();
  await result.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await result.setViewport({ width: 1180, height: 900, deviceScaleFactor: 1 });
  await result.goto(`chrome-extension://${id}/result/result.html#${sessionId}`);
  await sleep(1500);
  await result.screenshot({ path: join(OUT, `result-${scheme}.png`) });
  console.log(`  result-${scheme}.png`);

  // Crop editor with a selection that shows shading above and below.
  await result.goto(`chrome-extension://${id}/result/result.html#${sessionId}&crop=0`);
  await result.reload();
  await result.waitForSelector('.crop-toolbar');
  for (const [edge, value] of [['top', 700], ['bottom', 1500], ['left', 280], ['right', 2280]]) {
    await result.$eval(`.crop-toolbar input[data-edge="${edge}"]`, (input, v) => {
      input.value = String(v);
      input.dispatchEvent(new Event('change'));
    }, value);
  }
  await result.evaluate(() => window.scrollTo(0, 120));
  await sleep(500);
  await result.screenshot({ path: join(OUT, `crop-${scheme}.png`) });
  console.log(`  crop-${scheme}.png`);

  const options = await browser.newPage();
  await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await options.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 });
  await options.goto(`chrome-extension://${id}/options/options.html`);
  await sleep(700);
  await options.screenshot({ path: join(OUT, `options-${scheme}.png`) });
  console.log(`  options-${scheme}.png`);

  // Restricted page popup.
  if (scheme === 'light') {
    await helper.evaluate(() => chrome.runtime.sendMessage({ type: 'LS_RESET_STATE' }));
    await fixture.goto('chrome://version');
    await sleep(300);
    const restricted = await popupPage(scheme);
    await shot(restricted, 'popup-restricted-light');
    await fixture.goto(`${origin}/text`);
    await restricted.close();
  }
  await Promise.all([popup.close(), result.close(), options.close()]);
  await helper.evaluate(() => chrome.runtime.sendMessage({ type: 'LS_RESET_STATE' }));
}

await browser.close();
server.close();
rmSync(workDir, { recursive: true, force: true });
console.log(`Screenshots in ${OUT}`);
