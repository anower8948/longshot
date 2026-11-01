/**
 * Settings page: binds form controls to chrome.storage.sync.
 */

import { getSettings, saveSettings, resetSettings, onSettingsChanged } from '../utils/storage.js';

const form = document.getElementById('settings-form');
const savedBadge = document.getElementById('saved');
let savedTimer = 0;

function fieldValue(element) {
  if (element.type === 'checkbox') return element.checked;
  const raw = element.value;
  const num = Number(raw);
  return raw !== '' && Number.isFinite(num) ? num : raw;
}

/** Ensure a select can show a stored value even if it isn't a preset option. */
function ensureOption(select, value) {
  const exists = [...select.options].some((option) => Number(option.value) === Number(value) || option.value === String(value));
  if (!exists) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = typeof value === 'number' ? value.toLocaleString() : String(value);
    select.append(option);
  }
}

function populate(settings) {
  for (const element of form.elements) {
    if (!element.name || !(element.name in settings)) continue;
    const value = settings[element.name];
    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else if (element.tagName === 'SELECT') {
      ensureOption(element, value);
      const match = [...element.options].find((option) => option.value === String(value) || Number(option.value) === Number(value));
      if (match) element.value = match.value;
    }
  }
  updateDependents(settings);
}

function updateDependents(settings) {
  document.getElementById('split-height-row').classList.toggle('disabled', !settings.splitLongScreenshots);
}

function flashSaved() {
  savedBadge.classList.add('visible');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedBadge.classList.remove('visible'), 1_400);
}

async function renderShortcuts() {
  const list = document.getElementById('shortcut-list');
  try {
    const commands = await chrome.commands.getAll();
    const describe = (name, label) => {
      const command = commands.find((c) => c.name === name);
      return `${label}: ${command?.shortcut || 'not set'}`;
    };
    list.textContent = `${describe('capture-full-page', 'Full page')} · ${describe('capture-visible-area', 'Visible area')}`;
  } catch {
    list.textContent = 'Manage shortcuts at chrome://extensions/shortcuts';
  }
}

async function init() {
  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
  document.getElementById('dpr-info').textContent = `${Math.round((window.devicePixelRatio || 1) * 100) / 100}×`;

  populate(await getSettings());
  renderShortcuts();

  form.addEventListener('change', async (event) => {
    const element = event.target;
    if (!element.name) return;
    const settings = await saveSettings({ [element.name]: fieldValue(element) });
    updateDependents(settings);
    flashSaved();
  });

  form.addEventListener('submit', (event) => event.preventDefault());

  document.getElementById('reset').addEventListener('click', async () => {
    populate(await resetSettings());
    flashSaved();
  });

  document.getElementById('edit-shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Keep in sync if the popup changes quality/format while this page is open.
  onSettingsChanged((settings) => populate(settings));
  window.addEventListener('focus', renderShortcuts);
}

init();
