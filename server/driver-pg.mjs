// Postgres KV driver. One table holds both namespaces; keys compare and sort
// under COLLATE "C" (byte order) to match Cloudflare KV's lexicographic list
// contract regardless of the database's default collation. `pg` is imported
// lazily so test/local runs on the mem driver don't need it installed.

import { dedupBatch } from './kv-store.mjs';

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

// Errors that mean the connection died mid-query and an idempotent retry is
// safe — the socket-level codes plus the pg SQLSTATEs for admin shutdown /
// connection failure. Callers own the retry policy (attempts, backoff); the
// driver owns knowing which errors are worth retrying.
const TRANSIENT_CODES = new Set([
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  '57P01', '08006', '08003', '08000',
]);
export const isTransientError = (e) => TRANSIENT_CODES.has(e?.code);

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
  // Long idle timeout + TCP keepalive: with the default 10s reap, a traffic
  // lull empties the pool and the next request pays a fresh TLS+auth
  // handshake (~50-150ms) before its first query.
  const pool = new pg.Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: 60_000, keepAlive: true });
  // Without this listener, an idle client dropping (Render recycling a
  // connection, a network blip) re-emits as an unhandled error and crashes the
  // process; log and swallow so the pool just reconnects on the next query.
  pool.on('error', (err) => console.error('[pg-pool] idle client error (recovering):', err.code || err.message));
  await pool.query(SCHEMA);

  const msOf = (ts) => (ts ? new Date(ts).getTime() : null);
  const rowOut = (r) => ({
    value: r.v,
    metadata: r.metadata ?? null,
    expiresAt: msOf(r.expires_at),
  });

  // Batched upsert: one multi-row INSERT per call. `put` delegates here so
  // the upsert SQL and row marshalling live in exactly one place.
  async function putMany(rows) {
    if (!rows.length) return 0;
    // Dedup first — a multi-row ON CONFLICT errors if the same key appears
    // twice in one statement.
    const uniq = dedupBatch(rows);
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
  }

  return {
    async get(ns, key) {
      // Named statement: get() runs several times per uncached request and
      // its text never varies, so let each connection parse/plan it once.
      const { rows } = await pool.query({
        name: 'kv-get',
        text: `SELECT v, metadata, expires_at FROM kv
         WHERE ns = $1 AND k = $2 AND (expires_at IS NULL OR expires_at > now())`,
        values: [ns, key],
      });
      return rows.length ? rowOut(rows[0]) : null;
    },

    async put(ns, key, value, { metadata = null, expiresAt = null } = {}) {
      await putMany([{ ns, key, value, metadata, expiresAt }]);
    },

    putMany,

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
          expiresAt: msOf(r.expires_at),
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
