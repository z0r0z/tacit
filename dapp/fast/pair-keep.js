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

// A copy is signed by the key that made it: `mac(text) -> hex` is a MAC under a key only the Tacit key derives (fast/pair-wire.js), over the copy as `signed` writes it.
// A file is read back only when its MAC is this key's: the prefix names the key's PUBLIC key, which anyone can write, so it says nothing of who made the file.
const KIND = 'tacit-btc-eth-swaps';
export const signed = (c) => JSON.stringify([c.v, c.kind, c.prefix, c.at, Object.keys(c.items).sort().map((k) => [k, c.items[k]])]);
const sameHex = (a, b) => {
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  if (x.length !== y.length || !x.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
};

export function saveCopy(prefix, storage = globalThis.localStorage, mac) {
  if (typeof mac !== 'function') throw new Error('A copy is signed by the key: open your Tacit wallet first.');
  const items = {};
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(prefix)) items[k] = storage.getItem(k); }
  const c = { v: 2, kind: KIND, prefix, at: Math.floor(Date.now() / 1000), items };
  return { ...c, mac: mac(signed(c)) };
}

// What a copy puts back, of what it holds (each item a [suffix, record] under the prefix): the swaps of Bitcoin for ETH, and the swaps of ETH for Bitcoin whose ETH is
// already locked, which only need the chains from there (their next steps read the pool and take the BTC, or take the ETH back). The list of providers asked and
// the quotes are not put back, nor a swap of ETH for Bitcoin before its ETH is locked: those are what would lock ETH, and nothing of the key's is held by them.
// Such a swap is kept as one found again from the key (fastbridge-pair.js RECOVERED: no provider to ask, and none needed).
const LOCKED = new Set(['offered', 'taking', 'refunding', 'done', 'refunded', 'lost', 'aborted']);
const restored = (suffix, v) => {
  if (suffix.startsWith('fwd:')) return suffix;
  const m = /^(.*):swaps:([0-9a-f]+)$/.exec(suffix);
  if (!m) return null;
  const rec = JSON.parse(v);
  return rec && rec.role === 'el' && LOCKED.has(rec.phase) && rec.lock && rec.lock.lockLeaf ? `recovered:swaps:${m[2]}` : null;
};

// Only records of this key are read back (the prefix names it, the MAC says the key made the copy), and only where this browser has none.
export function loadCopy(json, prefix, storage = globalThis.localStorage, mac) {
  if (typeof mac !== 'function') throw new Error('Open your Tacit wallet first.');
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  if (!j || j.kind !== KIND || j.prefix !== prefix || !j.items || typeof j.items !== 'object') throw new Error('This file is not a copy of this wallet’s swaps.');
  if (!j.mac) throw new Error('This copy was saved before copies were signed by the key, so it is not read. Your swaps are found again from your key on the chains.');
  if (!sameHex(j.mac, mac(signed(j)))) throw new Error('This file was not saved by this wallet, so it is not read.');
  let n = 0, rec = false;
  for (const [k, v] of Object.entries(j.items)) {
    if (!k.startsWith(prefix) || typeof v !== 'string') continue;
    let to;
    try { to = restored(k.slice(prefix.length), v); } catch { continue; }
    if (!to || storage.getItem(prefix + to) != null || storage.getItem(k) != null) continue;
    storage.setItem(prefix + to, v); write(prefix + to, v); n++;
    if (to.startsWith('recovered:')) rec = true;
  }
  // the swaps put back as found from the key are listed and stepped under that name
  const idx = `${prefix}providers:recovered`;
  if (rec && storage.getItem(idx) == null) { const v = JSON.stringify({ id: 'recovered', name: 'Found from your key', ref: { kind: 'recovered' } }); storage.setItem(idx, v); write(idx, v); }
  return n;
}
