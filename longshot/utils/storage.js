/**
 * Settings persistence (chrome.storage.sync) with defaults and validation.
 */

const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  // Capture
  quality: 'high', // standard | high | maximum
  format: 'png', // png | jpeg | webp
  captureDelay: 500, // ms to wait after each scroll
  pauseAnimations: true,
  hideFixedElements: 'smart', // smart | hide | off
  preloadLazyContent: true,
  restoreScroll: true, // false = stay at the end position
  lastMode: 'full',

  // Output
  jpegQuality: 0.95,
  pngEffort: 'balanced', // fast | balanced | smallest
  maxImageHeight: 100_000, // single image height cap (output px) before auto-splitting
  splitLongScreenshots: false,
  splitPartHeight: 16_000,
  maxPageLength: 100_000, // CSS px safety cap for infinite-scroll pages
  autoDownload: true,
  openResultAfterCapture: false,

  // Google Docs
  docsOptimized: false,
  docsPageSize: 'letter', // letter | a4 | legal | pageless

  // Advanced
  debugLogging: false,
  showCaptureCoordinates: false,
});

const ENUMS = {
  quality: ['standard', 'high', 'maximum'],
  format: ['png', 'jpeg', 'webp'],
  captureDelay: [0, 250, 500, 1000, 2000],
  hideFixedElements: ['smart', 'hide', 'off'],
  pngEffort: ['fast', 'balanced', 'smallest'],
  docsPageSize: ['letter', 'a4', 'legal', 'pageless'],
  lastMode: ['full', 'visible', 'region', 'current'],
};

const NUMBER_RANGES = {
  jpegQuality: [0.5, 1],
  maxImageHeight: [4_000, 1_000_000],
  splitPartHeight: [1_000, 100_000],
  maxPageLength: [5_000, 1_000_000],
};

/** Coerce arbitrary stored data into a valid settings object. */
export function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return settings;

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    const fallback = DEFAULT_SETTINGS[key];

    if (ENUMS[key]) {
      const coerced = typeof fallback === 'number' ? Number(value) : value;
      if (ENUMS[key].includes(coerced)) settings[key] = coerced;
    } else if (NUMBER_RANGES[key]) {
      const [min, max] = NUMBER_RANGES[key];
      const num = Number(value);
      if (Number.isFinite(num)) settings[key] = Math.min(max, Math.max(min, num));
    } else if (typeof fallback === 'boolean') {
      settings[key] = Boolean(value);
    }
  }
  return settings;
}

export async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...partial });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'sync' && changes[SETTINGS_KEY]) {
      callback(normalizeSettings(changes[SETTINGS_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
