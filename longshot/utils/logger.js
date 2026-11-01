/**
 * Debug logger gated by the "Debug logging" setting.
 */

let debugEnabled = false;

export function setDebugLogging(enabled) {
  debugEnabled = Boolean(enabled);
}

export function createLogger(scope) {
  const prefix = `[LongShot:${scope}]`;
  return {
    debug: (...args) => {
      if (debugEnabled) console.debug(prefix, ...args);
    },
    info: (...args) => {
      if (debugEnabled) console.info(prefix, ...args);
    },
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}
