#!/usr/bin/env node
// dapp/storage-fallback.js: where a browser refuses storage, reading window.localStorage throws (not only using it), so the front page's module died on its first read of it and
// the tile stayed a skeleton. The page's module imports this first, and a store that cannot be read is replaced by one in memory for the visit; one that reads is left alone.
// Nothing here needs a browser: the scopes are plain objects shaped like the ways a window refuses (tests/front-boot.mjs loads the page with storage refused).
//
//   node tests/storage-fallback.mjs
const { storageFallback } = await import(new URL('../dapp/storage-fallback.js', import.meta.url));

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const refuse = () => { throw new DOMException('Failed to read the \'localStorage\' property from \'Window\': Access is denied for this document.', 'SecurityError'); };
const working = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
const windowWith = (props) => { const w = {}; for (const [k, v] of Object.entries(props)) Object.defineProperty(w, k, typeof v === 'function' && v === refuse ? { get: v, configurable: true } : { value: v, configurable: true, writable: true }); return w; };

// 1. both stores refused (a Chrome with cookies blocked): each reads, writes and forgets in memory, and the two are apart
{
  const w = windowWith({ localStorage: refuse, sessionStorage: refuse });
  ok(storageFallback(w).join() === 'localStorage,sessionStorage', 'a window whose stores both throw on read gets a stand-in for each');
  const l = w.localStorage, s = w.sessionStorage;
  ok(l.getItem('a') === null, 'reading a key nobody wrote is null, as in a real store');
  l.setItem('a', 1); l.setItem('b', { toString: () => 'two' });
  ok(l.getItem('a') === '1' && l.getItem('b') === 'two' && l.length === 2, 'what is written comes back as the text it was (a store keeps strings) and is counted');
  ok(l.key(0) === 'a' && l.key(1) === 'b' && l.key(2) === null, 'key(i) lists them in the order written, null past the end');
  ok(s.getItem('a') === null && s.length === 0, 'sessionStorage is its own store: it does not see localStorage\'s keys');
  l.removeItem('a'); ok(l.getItem('a') === null && l.length === 1, 'removeItem forgets one');
  l.clear(); ok(l.length === 0 && l.getItem('b') === null, 'clear forgets all');
  ok(w.localStorage === l, 'the property keeps one store (every read of window.localStorage is the same object)');
}

// 2. a store that reads is left exactly as it is: nothing changes for a browser that allows storage
{
  const ls = working(), ss = working();
  const w = windowWith({ localStorage: ls, sessionStorage: ss });
  ok(storageFallback(w).length === 0 && w.localStorage === ls && w.sessionStorage === ss, 'a window whose stores read keeps them (the same objects, nothing standing in)');
  ls.setItem('kept', 'yes'); storageFallback(w);
  ok(w.localStorage.getItem('kept') === 'yes', 'and what they hold is still there after a second run');
}

// 3. one refused, one not
{
  const ss = working();
  const w = windowWith({ localStorage: refuse, sessionStorage: ss });
  ok(storageFallback(w).join() === 'localStorage' && w.sessionStorage === ss, 'only the store that throws is replaced');
}

// 4. the other ways a window refuses: no store at all (null), and a store whose methods throw
{
  const w = windowWith({ localStorage: null, sessionStorage: { getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse, key: refuse, length: 0 } });
  ok(storageFallback(w).join() === 'localStorage,sessionStorage', 'a null store, and a store whose methods throw, are replaced too');
  w.localStorage.setItem('x', 'y'); ok(w.localStorage.getItem('x') === 'y' && w.sessionStorage.length === 0, 'and then work');
}

// 5. a window that will not be changed is left as it was, and the page's script is not stopped by the attempt
{
  const w = windowWith({ sessionStorage: working() }); Object.defineProperty(w, 'localStorage', { get: refuse, configurable: false });
  let threw = false, said;
  try { said = storageFallback(w); } catch { threw = true; }
  ok(!threw && said.length === 0, 'a store that cannot be replaced is skipped without throwing');
}

console.log(`\n${n} storage-fallback checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
