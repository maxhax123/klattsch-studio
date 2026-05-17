const DB_NAME = 'klattsch-studio-db';
const DB_VERSION = 1;
const STORE_NAME = 'workspace';
const WORKSPACE_KEY = 'primary';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('Failed to open IndexedDB.')));
  });
}

function withStore(mode, executor) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = executor(store);
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed.')));
    tx.addEventListener('complete', () => db.close());
    tx.addEventListener('error', () => reject(tx.error ?? new Error('IndexedDB transaction failed.')));
    tx.addEventListener('abort', () => reject(tx.error ?? new Error('IndexedDB transaction aborted.')));
  }));
}

export function loadWorkspaceState() {
  return withStore('readonly', (store) => store.get(WORKSPACE_KEY)).catch(() => null);
}

export function saveWorkspaceState(workspace) {
  return withStore('readwrite', (store) => store.put(structuredClone(workspace), WORKSPACE_KEY));
}
