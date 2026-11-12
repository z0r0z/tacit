export function storageFallback(scope = globalThis) {
  const standIn = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    try { scope[name].getItem('tacit-storage-probe'); continue; } catch { }
    const m = new Map();
    const store = {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); },
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
    try { Object.defineProperty(scope, name, { value: store, configurable: true }); standIn.push(name); } catch { }
  }
  return standIn;
}
storageFallback();
