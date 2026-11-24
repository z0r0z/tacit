// A second copy of a key's Bitcoin and ETH swaps, for a browser whose site storage is cleared: the pair client keeps its records in localStorage (fast/pair-wire.js
// openPair), and a swap of ETH for BTC cannot be found again from the key alone. Every write under the key's prefix is copied to IndexedDB, and a record the copy has
// that localStorage has lost is put back when the pair opens. A copy can also be saved as a file and read back, on another browser too. No DOM.
//
//   const storage = await keptStorage(prefix)          a localStorage that copies its writes under `prefix`, with what was lost put back
//   saveCopy(prefix) -> { v, prefix, at, items }      loadCopy(json, prefix) -> how many records were put back
//
// IndexedDB is a convenience here: where it cannot be opened (a private window, a test) the storage is localStorage as it was.

const DB = 'tacit-pair-keep', STORE = 'kv';
let dbP = null;
const openDb = () => (dbP ||= new Promise((resolve) => {
  try {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.onblocked = () => resolve(null);
  } catch { resolve(null); }
}));
const tx = async (mode, fn) => {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : true);
      t.onerror = () => resolve(null); t.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
};
const keysUnder = (prefix) => (typeof IDBKeyRange === 'function' ? IDBKeyRange.bound(prefix, `${prefix}\uffff`) : null);

async function readCopy(prefix) {
  const range = keysUnder(prefix);
  if (!range) return [];
  const [keys, vals] = await Promise.all([tx('readonly', (s) => s.getAllKeys(range)), tx('readonly', (s) => s.getAll(range))]);
  return Array.isArray(keys) && Array.isArray(vals) && keys.length === vals.length ? keys.map((k, i) => [String(k), vals[i]]) : [];
}
const write = (k, v) => { void tx('readwrite', (s) => (v == null ? s.delete(k) : s.put(v, k))); };

// A record is put back only when localStorage has none under that key: what is there is newer than any copy.
export async function keptStorage(prefix, storage = globalThis.localStorage) {
  try {
    for (const [k, v] of await readCopy(prefix)) if (typeof v === 'string' && storage.getItem(k) == null) storage.setItem(k, v);
  } catch { /* the copy is a convenience */ }
  return {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => { storage.setItem(k, v); if (String(k).startsWith(prefix)) write(String(k), String(v)); },
    removeItem: (k) => { storage.removeItem(k); if (String(k).startsWith(prefix)) write(String(k), null); },
    key: (i) => storage.key(i),
    get length() { return storage.length; },
  };
}

export function saveCopy(prefix, storage = globalThis.localStorage) {
  const items = {};
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(prefix)) items[k] = storage.getItem(k); }
  return { v: 1, kind: 'tacit-btc-eth-swaps', prefix, at: Math.floor(Date.now() / 1000), items };
}

// Only records of this key are read back (the prefix names it), and only where this browser has none.
export function loadCopy(json, prefix, storage = globalThis.localStorage) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  if (!j || j.kind !== 'tacit-btc-eth-swaps' || j.prefix !== prefix || !j.items || typeof j.items !== 'object') throw new Error('This file is not a copy of this wallet’s swaps.');
  let n = 0;
  for (const [k, v] of Object.entries(j.items)) {
    if (!k.startsWith(prefix) || typeof v !== 'string' || storage.getItem(k) != null) continue;
    try { JSON.parse(v); } catch { continue; }
    storage.setItem(k, v); write(k, v); n++;
  }
  return n;
}
