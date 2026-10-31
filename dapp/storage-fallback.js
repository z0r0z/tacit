// A browser that refuses storage (cookies blocked, a sandboxed frame, some private modes) throws when `window.localStorage` is read, not only when it is used, so a default
// argument or a first line that reads it ends the script it runs in. On the front page that was the page's module: it stopped before it drew the tile, and the tile stayed a
// skeleton for good. Where reading a store throws, the page keeps what it saves there in memory for the visit instead (nothing is remembered after it, which is all such a
// browser allows); a store that reads is left as it is. The page's module imports this first, so it has run before anything else that touches storage.
export function storageFallback(scope = globalThis) {
  const standIn = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    try { scope[name].getItem('tacit-storage-probe'); continue; } catch { /* refused: the stand-in below */ }
    const m = new Map();
    const store = {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); },
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
    try { Object.defineProperty(scope, name, { value: store, configurable: true }); standIn.push(name); } catch { /* a scope that cannot be changed keeps what it had */ }
  }
  return standIn;
}
storageFallback();
