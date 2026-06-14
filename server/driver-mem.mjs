// In-memory KV driver. Backs tests and dependency-free local runs; state is
// process-lifetime only. Mirrors driver-pg.mjs semantics exactly — the shim
// conformance suite (tests/server-kv-shim.test.mjs) runs against both.

import { dedupBatch } from './kv-store.mjs';

export function createMemDriver() {
  const spaces = new Map(); // ns -> Map(key -> { value: Buffer, metadata, expiresAt })

  const space = (ns) => {
    let m = spaces.get(ns);
    if (!m) { m = new Map(); spaces.set(ns, m); }
    return m;
  };

  const live = (row) => row && (row.expiresAt == null || row.expiresAt > Date.now());

  return {
    async get(ns, key) {
      const row = space(ns).get(key);
      if (!row) return null;
      if (!live(row)) { space(ns).delete(key); return null; }
      return row;
    },

    async put(ns, key, value, { metadata = null, expiresAt = null } = {}) {
      await this.putMany([{ ns, key, value, metadata, expiresAt }]);
    },

    // Batched upsert; last write wins on a duplicate (ns,key) within the
    // batch, and the returned count is post-dedup — same as driver-pg.
    async putMany(rows) {
      const uniq = dedupBatch(rows);
      for (const r of uniq) {
        space(r.ns).set(r.key, { value: r.value, metadata: r.metadata ?? null, expiresAt: r.expiresAt ?? null });
      }
      return uniq.length;
    },

    async delete(ns, key) {
      return space(ns).delete(key);
    },

    async list(ns, { prefix = '', limit = 1000, after = null } = {}) {
      const m = space(ns);
      const names = [];
      for (const [k, row] of m) {
        if (!k.startsWith(prefix)) continue;
        if (after != null && k <= after) continue;
        if (!live(row)) continue;
        names.push(k);
      }
      names.sort();
      const slice = names.slice(0, limit);
      const entries = slice.map((name) => {
        const row = m.get(name);
        return { name, metadata: row.metadata, expiresAt: row.expiresAt };
      });
      return { entries, complete: slice.length === names.length };
    },

    async sweepExpired() {
      let n = 0;
      const now = Date.now();
      for (const m of spaces.values()) {
        for (const [k, row] of m) {
          if (row.expiresAt != null && row.expiresAt <= now) { m.delete(k); n++; }
        }
      }
      return n;
    },

    async close() {},
  };
}
