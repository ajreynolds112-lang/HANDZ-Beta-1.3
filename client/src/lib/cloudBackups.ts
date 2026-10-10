/**
 * Private browser-side career backups (guest career while signed in, unsynced
 * account progress). Kept in IndexedDB, not localStorage: a full career copy
 * next to the live career would double localStorage use and blow its ~5 MB quota.
 */
const DB_NAME = "handz_cloud_backups";
const STORE = "backups";
/** Old localStorage homes of these backups; migrated once, then removed. */
const LEGACY_KEYS = ["handz_cloud_guest_backup"];
const LEGACY_PREFIX = "handz_cloud_recovery_";

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => { dbPromise = null; reject(open.error ?? new Error("Could not open the local backup store.")); };
    });
  }
  return dbPromise;
}
async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Local backup failed."));
  });
}

export function getBackup<T>(key: string): Promise<T | undefined> {
  return run("readonly", store => store.get(key) as IDBRequest<T | undefined>);
}
export async function setBackup(key: string, value: unknown): Promise<void> {
  await run("readwrite", store => store.put(value, key));
}
export async function deleteBackup(key: string): Promise<void> {
  await run("readwrite", store => store.delete(key));
}

/** Moves backups written by earlier builds out of localStorage, freeing the quota. */
export async function migrateLegacyBackups(): Promise<void> {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (LEGACY_KEYS.includes(key) || key.startsWith(LEGACY_PREFIX))) keys.push(key);
  }
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      if ((await getBackup(key)) === undefined) await setBackup(key, JSON.parse(raw));
    } catch {
      // Unreadable legacy copy: leave it for now rather than lose it.
      continue;
    }
    localStorage.removeItem(key);
  }
}
