// Where the extension keeps things.
// - IndexedDB, on disk: the lock record and, later, the vault and anything sealed under M. Nothing
//   stored here opens without the password.
// - storage.session, in memory: M while the extension is unlocked. The browser clears it when it
//   quits, and keeps it from content scripts. It outlives the background being stopped.

const DATABASE = 'cometotp';
const STORE = 'records';
const SESSION_KEY = 'localKey';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function database(): Promise<IDBDatabase> {
  const req = indexedDB.open(DATABASE, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return request(req);
}

async function withStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    const tx = db.transaction(STORE, mode);
    const result = await request(use(tx.objectStore(STORE)));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } finally {
    db.close();
  }
}

export function getRecord(key: string): Promise<unknown> {
  return withStore('readonly', (store) => store.get(key));
}

export async function putRecord(key: string, value: unknown): Promise<void> {
  await withStore('readwrite', (store) => store.put(value, key));
}

export async function deleteRecord(key: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(key));
}

export async function clearRecords(): Promise<void> {
  await withStore('readwrite', (store) => store.clear());
}

/** M while unlocked, base64url; null while locked. */
export async function getSessionKey(): Promise<string | null> {
  const value = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  return typeof value === 'string' ? value : null;
}

export function setSessionKey(value: string): Promise<void> {
  return chrome.storage.session.set({ [SESSION_KEY]: value });
}

export function clearSessionKey(): Promise<void> {
  return chrome.storage.session.remove(SESSION_KEY);
}
