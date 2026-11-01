/**
 * Detects pages Chrome does not allow extensions to capture or script.
 */

const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'about:',
  'view-source:',
  'data:',
  'blob:',
  'javascript:',
  'filesystem:',
];

const WEB_STORE_HOSTS = [
  { host: 'chromewebstore.google.com', path: '/' },
  { host: 'chrome.google.com', path: '/webstore' },
  { host: 'microsoftedge.microsoft.com', path: '/addons' },
];

/**
 * @param {string | undefined} url
 * @returns {{ capturable: boolean, code?: string, limited?: string }}
 */
export function classifyUrl(url) {
  if (!url) {
    // URL is hidden when we have no access to the tab yet; let injection decide.
    return { capturable: true };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { capturable: false, code: 'RESTRICTED_PAGE' };
  }

  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) {
    return { capturable: false, code: 'RESTRICTED_PAGE' };
  }

  for (const { host, path } of WEB_STORE_HOSTS) {
    if (parsed.hostname === host && parsed.pathname.startsWith(path)) {
      return { capturable: false, code: 'WEB_STORE' };
    }
  }

  if (parsed.protocol === 'file:') {
    return { capturable: true, code: 'FILE_URL' };
  }

  if (/\.pdf$/i.test(parsed.pathname)) {
    // Chrome's PDF viewer renders inside a plugin frame: only the visible area works.
    return { capturable: true, limited: 'PDF_VIEWER' };
  }

  return { capturable: true };
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return '';
  }
}
