// Postgres KV driver. One table holds both namespaces; keys compare and sort
// under COLLATE "C" (byte order) to match Cloudflare KV's lexicographic list
// contract regardless of the database's default collation. `pg` is imported
// lazily so test/local runs on the mem driver don't need it installed.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  ns text NOT NULL,
  k text NOT NULL,
  v bytea NOT NULL,
  metadata jsonb,
  expires_at timestamptz,
  PRIMARY KEY (ns, k)
);
CREATE INDEX IF NOT EXISTS kv_list_idx ON kv (ns, k COLLATE "C");
`;

// Smallest string strictly greater than every key with this prefix, under
// byte order. Worker key prefixes are ASCII (hex, colons, dashes), so
// incrementing the last unit is exact.
function prefixUpperBound(prefix) {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const c = prefix.charCodeAt(i);
    if (c < 0xff) return prefix.slice(0, i) + String.fromCharCode(c + 1);
  }
  return null;
}

export async function createPgDriver(databaseUrl, { max = 10 } = {}) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  // Without this listener, an idle client dropping (Render recycling a
  // connection, a network blip) re-emits as an unhandled error and crashes the
  // process; log and swallow so the pool just reconnects on the next query.
  pool.on('error', (err) => console.error('[pg-pool] idle client error (recovering):', err.code || err.message));
  await pool.query(SCHEMA);

  const rowOut = (r) => ({
    value: r.v,
    metadata: r.metadata ?? null,
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
  });

  return {
    async get(ns, key) {
      const { rows } = await pool.query(
        `SELECT v, metadata, expires_at FROM kv
         WHERE ns = $1 AND k = $2 AND (expires_at IS NULL OR expires_at > now())`,
        [ns, key],
      );
      return rows.length ? rowOut(rows[0]) : null;
    },

    async put(ns, key, value, { metadata = null, expiresAt = null } = {}) {
      await pool.query(
        `INSERT INTO kv (ns, k, v, metadata, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ns, k) DO UPDATE SET v = $3, metadata = $4, expires_at = $5`,
        [ns, key, value, metadata == null ? null : JSON.stringify(metadata),
         expiresAt == null ? null : new Date(expiresAt)],
      );
    },

    // Batched upsert for snapshot import: one multi-row INSERT per call.
    async putMany(rows) {
      if (!rows.length) return 0;
      const sep = String.fromCharCode(0);           // NUL joins (ns,key); appears in neither, so no collisions
      const seen = new Map();                        // last write wins on a duplicate (ns,key) within the batch
      for (const r of rows) seen.set(r.ns + sep + r.key, r);
      const uniq = [...seen.values()];
      const tuples = [];
      const params = [];
      let i = 1;
      for (const r of uniq) {
        tuples.push(`($${i++},$${i++},$${i++},$${i++},$${i++})`);
        params.push(r.ns, r.key, r.value,
          r.metadata == null ? null : JSON.stringify(r.metadata),
          r.expiresAt == null ? null : new Date(r.expiresAt));
      }
      await pool.query(
        `INSERT INTO kv (ns, k, v, metadata, expires_at) VALUES ${tuples.join(',')}
         ON CONFLICT (ns, k) DO UPDATE SET v = EXCLUDED.v, metadata = EXCLUDED.metadata, expires_at = EXCLUDED.expires_at`,
        params,
      );
      return uniq.length;
    },

    async delete(ns, key) {
      const { rowCount } = await pool.query('DELETE FROM kv WHERE ns = $1 AND k = $2', [ns, key]);
      return rowCount > 0;
    },

    async list(ns, { prefix = '', limit = 1000, after = null } = {}) {
      const params = [ns];
      const where = ['ns = $1', '(expires_at IS NULL OR expires_at > now())'];
      if (prefix) {
        params.push(prefix);
        where.push(`k COLLATE "C" >= $${params.length}`);
        const upper = prefixUpperBound(prefix);
        if (upper != null) {
          params.push(upper);
          where.push(`k COLLATE "C" < $${params.length}`);
        }
      }
      if (after != null) {
        params.push(after);
        where.push(`k COLLATE "C" > $${params.length}`);
      }
      params.push(limit + 1); // one extra row decides `complete` without a second query
      const { rows } = await pool.query(
        `SELECT k, metadata, expires_at FROM kv
         WHERE ${where.join(' AND ')}
         ORDER BY k COLLATE "C"
         LIMIT $${params.length}`,
        params,
      );
      const complete = rows.length <= limit;
      const slice = complete ? rows : rows.slice(0, limit);
      return {
        entries: slice.map((r) => ({
          name: r.k,
          metadata: r.metadata ?? null,
          expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
        })),
        complete,
      };
    },

    async sweepExpired() {
      const { rowCount } = await pool.query(
        'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= now()',
      );
      return rowCount;
    },

    async close() {
      await pool.end();
    },
  };
}
