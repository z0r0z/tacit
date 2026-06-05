// Load a kv-export.mjs NDJSON snapshot into the Node KV store. Upserts, so
// re-running with a newer snapshot is the delta-sync step of cutover.
// Already-expired keys are dropped; future expirations are preserved.
//
//   DATABASE_URL=postgres://… node scripts/kv-import.mjs kv-export.ndjson

import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('usage: DATABASE_URL=… node scripts/kv-import.mjs <export.ndjson>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { createPgDriver } = await import('../server/driver-pg.mjs');
const driver = await createPgDriver(process.env.DATABASE_URL);

const CONCURRENCY = 16;
const inflight = new Set();
let imported = 0, expired = 0, malformed = 0;

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { malformed++; continue; }
  const { ns, key, value_b64, metadata, expiration } = row;
  if (!ns || !key || value_b64 == null) { malformed++; continue; }
  const expiresAt = expiration != null ? expiration * 1000 : null;
  if (expiresAt != null && expiresAt <= Date.now()) { expired++; continue; }

  const p = driver
    .put(ns, key, Buffer.from(value_b64, 'base64'), { metadata: metadata ?? null, expiresAt })
    .then(() => { if (++imported % 1000 === 0) console.log(`…${imported} imported`); })
    .finally(() => inflight.delete(p));
  inflight.add(p);
  if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
}
await Promise.all(inflight);
await driver.close();
console.log(`done: ${imported} imported, ${expired} skipped (already expired), ${malformed} malformed lines`);
