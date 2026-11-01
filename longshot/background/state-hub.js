/**
 * Holds the current capture state and pushes it to open popups (via ports)
 * and to the toolbar badge. The last terminal state is mirrored into
 * chrome.storage.session so a reopened popup can show it even after the
 * service worker was suspended.
 */

import { Msg, PORT_NAME } from '../utils/constants.js';

const STORAGE_KEY = 'captureState';
const ports = new Set();
let state = { status: 'idle', updatedAt: Date.now() };
let badgeTimer = 0;
let loaded = false;

const BADGE_COLORS = {
  capturing: '#0A84FF',
  processing: '#5E5CE6',
  done: '#30D158',
  error: '#FF453A',
};

export function initStateHub() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    loadState().then(() => port.postMessage({ type: Msg.STATE_UPDATE, state }));
  });
}

export async function loadState() {
  if (loaded) return state;
  loaded = true;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const saved = stored[STORAGE_KEY];
    if (saved && state.status === 'idle') {
      // A capture that was running when the worker stopped cannot be resumed.
      state = saved.status === 'capturing' || saved.status === 'processing'
        ? { status: 'idle', updatedAt: Date.now() }
        : saved;
    }
  } catch {
    // storage.session unavailable: keep in-memory state
  }
  return state;
}

export function getState() {
  return state;
}

function broadcast() {
  for (const port of ports) {
    try {
      port.postMessage({ type: Msg.STATE_UPDATE, state });
    } catch {
      ports.delete(port);
    }
  }
}

function updateBadge() {
  clearTimeout(badgeTimer);
  const { status } = state;
  let text = '';
  if (status === 'capturing') text = `${Math.max(0, Math.min(99, Math.round(state.percent || 0)))}%`;
  else if (status === 'processing') text = '•••';
  else if (status === 'done') text = '✓';
  else if (status === 'error') text = '!';

  chrome.action.setBadgeText({ text }).catch(() => {});
  if (BADGE_COLORS[status]) {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[status] }).catch(() => {});
    chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' })?.catch?.(() => {});
  }
  if (status === 'done' || status === 'error') {
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), status === 'done' ? 6_000 : 10_000);
  }
}

/**
 * @param {object} patch
 * @param {{ replace?: boolean }} [options]
 */
export function setState(patch, { replace = false } = {}) {
  const previousStatus = state.status;
  state = replace ? { ...patch, updatedAt: Date.now() } : { ...state, ...patch, updatedAt: Date.now() };
  loaded = true;
  broadcast();

  const statusChanged = previousStatus !== state.status;
  if (statusChanged || state.status === 'capturing') updateBadge();
  if (statusChanged || state.status === 'done' || state.status === 'error') {
    chrome.storage.session.set({ [STORAGE_KEY]: state }).catch(() => {});
  }
}
