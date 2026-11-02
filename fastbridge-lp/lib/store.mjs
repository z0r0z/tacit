// Durable storage for the LP: one JSON file per record, written to a temporary file, synced, and renamed over the old
// one, which is kept as `<id>.json.bak`. A record that cannot be read is read from its backup.

import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
function writeAtomic(f, text) {
  const tmp = f + '.tmp';
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(f)) copyFileSync(f, f + '.bak');
  renameSync(tmp, f);
}

export function makeFileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const broken = new Map();
  const path = (id) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(id))) throw new Error('store: bad record id');
    return join(dir, id + '.json');
  };
  return {
    async get(id) {
      const f = path(id);
      for (const g of [f, f + '.bak']) {
        try { return read(g); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      }
      return null;
    },
    async put(rec) { writeAtomic(path(rec.id), JSON.stringify(rec)); broken.delete(rec.id); },
    async del(id) { const f = path(id); for (const g of [f, f + '.bak']) { try { unlinkSync(g); } catch { /* already gone */ } } broken.delete(id); },
    // every record that can be read, each from its backup if its file cannot be; one that cannot be read at all is
    // reported by problems() and left alone
    async list() {
      const out = [];
      for (const n of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const id = n.slice(0, -5);
        try {
          const rec = await this.get(id);
          if (rec) { out.push(rec); broken.delete(id); } else broken.set(id, 'unreadable');
        } catch (e) { broken.set(id, String((e && e.message) || e).slice(0, 120)); }
      }
      return out;
    },
    problems() { return [...broken].map(([id, error]) => ({ id, error })); },
  };
}

// The same interface in memory, for a dry run: nothing is kept past the process.
export function makeMemoryStore() {
  const m = new Map();
  return {
    async get(id) { return m.has(id) ? JSON.parse(m.get(id)) : null; },
    async put(rec) { m.set(rec.id, JSON.stringify(rec)); },
    async del(id) { m.delete(id); },
    async list() { return [...m.values()].map((v) => JSON.parse(v)); },
    problems() { return []; },
  };
}

// The pool wallet's cache of the logs it has read (the `logStore` of makeConfidentialPoolUx), keyed by an arbitrary string.
export function makeFileLogStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = (key) => join(dir, createHash('sha256').update(String(key)).digest('hex') + '.json');
  return {
    async get(key) { try { return read(file(key)); } catch { return null; } },
    async put(key, value) { writeAtomic(file(key), JSON.stringify(value)); },
    async del(key) { try { unlinkSync(file(key)); } catch { /* already gone */ } },
  };
}
