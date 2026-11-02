// A `localStorage` for the pool wallet module, kept in one JSON file: the wallet saves its scan checkpoints and the
// hints for the notes it has found there, so a restart continues from where the last scan ended instead of reading the
// pool's whole history again. Writes are batched and atomic.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function makeFileStorage(file, { delayMs = 500 } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  let m = new Map();
  try { m = new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')))); } catch { /* none yet, or unreadable: the wallet scans again */ }
  let timer = null;
  function flush() {
    timer = null;
    const tmp = file + '.tmp', fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(Object.fromEntries(m))); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  }
  const later = () => { if (!timer) { timer = setTimeout(flush, delayMs); timer.unref?.(); } };
  process.on('exit', () => { if (timer) { try { flush(); } catch { /* best effort */ } } });
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); later(); },
    removeItem: (k) => { m.delete(k); later(); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    flush: () => { if (timer) { clearTimeout(timer); flush(); } },
    exists: () => existsSync(file),
  };
}
