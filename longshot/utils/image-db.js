/**
 * IndexedDB storage for capture sessions.
 *
 * Captured tiles and encoded output images are Blobs, which Chrome can page to
 * disk. Keeping them here (instead of in service-worker memory) means a very
 * long capture never holds all sections in RAM, and results survive the
 * service worker being suspended so "Download Again" / "Open Image" work later.
 * The service worker, offscreen document and extension pages share this DB.
 */

const DB_NAME = 'longshot';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const BLOBS = 'blobs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        const store = db.createObjectStore(BLOBS, { keyPath: 'key' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(run(store))
      .then((value) => {
        result = value;
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export const blobKey = {
  tile: (sessionId, index) => `${sessionId}/tile/${String(index).padStart(5, '0')}`,
  output: (sessionId, index) => `${sessionId}/output/${String(index).padStart(4, '0')}`,
  preview: (sessionId) => `${sessionId}/preview`,
};

export function putSession(session) {
  return withStore(SESSIONS, 'readwrite', (store) => requestToPromise(store.put(session)));
}

export function getSession(id) {
  return withStore(SESSIONS, 'readonly', (store) => requestToPromise(store.get(id)));
}

export async function updateSession(id, patch) {
  return withStore(SESSIONS, 'readwrite', async (store) => {
    const existing = await requestToPromise(store.get(id));
    if (!existing) return null;
    const next = { ...existing, ...patch };
    await requestToPromise(store.put(next));
    return next;
  });
}

export function listSessions() {
  return withStore(SESSIONS, 'readonly', (store) => requestToPromise(store.getAll()));
}

export function putBlob(key, sessionId, blob) {
  return withStore(BLOBS, 'readwrite', (store) => requestToPromise(store.put({ key, sessionId, blob })));
}

export async function getBlob(key) {
  const record = await withStore(BLOBS, 'readonly', (store) => requestToPromise(store.get(key)));
  return record ? record.blob : null;
}

export function deleteBlob(key) {
  return withStore(BLOBS, 'readwrite', (store) => requestToPromise(store.delete(key)));
}

/** Delete blobs of a session whose key starts with `${sessionId}/${kind}/`. */
export function deleteBlobs(sessionId, kind) {
  const prefix = kind ? `${sessionId}/${kind}/` : `${sessionId}/`;
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  return withStore(BLOBS, 'readwrite', (store) => requestToPromise(store.delete(range)));
}

export async function deleteSession(id) {
  await deleteBlobs(id);
  await withStore(SESSIONS, 'readwrite', (store) => requestToPromise(store.delete(id)));
}

/**
 * Keep only the newest `keep` completed sessions and drop abandoned ones
 * (e.g. the browser closed mid-capture).
 */
export async function pruneSessions({ keep = 3, keepIds = [] } = {}) {
  const sessions = await listSessions();
  sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const now = Date.now();
  let kept = 0;
  for (const session of sessions) {
    if (keepIds.includes(session.id)) continue;
    const stale = session.status !== 'done' && now - (session.createdAt || 0) > 10 * 60 * 1000;
    if (session.status === 'done' && kept < keep) {
      kept += 1;
      continue;
    }
    if (session.status === 'done' || stale || session.status === 'failed') {
      await deleteSession(session.id).catch(() => {});
    }
  }
}
