// Load a kv-export.mjs NDJSON snapshot into the Node KV store. Batched upserts,
// so re-running with a newer snapshot is the delta-sync step of cutover.
// Already-expired keys are dropped; future expirations are preserved. Each
// batch retries on transient network errors so a blip mid-import doesn't lose
// the whole run.
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

const BATCH = Number(process.env.IMPORT_BATCH) || 1000;
const RETRIES = 5;
const TRANSIENT = new Set([
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  '57P01', '08006', '08003', '08000', // pg: admin shutdown / connection failure
]);

const { createPgDriver } = await import('../server/driver-pg.mjs');
const driver = await createPgDriver(process.env.DATABASE_URL, { max: 2 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function flush(batch) {
  for (let attempt = 1; ; attempt++) {
    try { return await driver.putMany(batch); }
    catch (e) {
      if (attempt > RETRIES || !TRANSIENT.has(e?.code)) throw e;
      const backoff = Math.min(500 * 2 ** (attempt - 1), 8000);
      console.error(`batch retry ${attempt}/${RETRIES} after ${e.code} (${backoff}ms)`);
      await sleep(backoff);
    }
  }
}

let imported = 0, expired = 0, malformed = 0, nextLog = 20000;
let batch = [];

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { malformed++; continue; }
  const { ns, key, value_b64, metadata, expiration } = row;
  if (!ns || !key || value_b64 == null) { malformed++; continue; }
  const expiresAt = expiration != null ? expiration * 1000 : null;
  if (expiresAt != null && expiresAt <= Date.now()) { expired++; continue; }

  batch.push({ ns, key, value: Buffer.from(value_b64, 'base64'), metadata: metadata ?? null, expiresAt });
  if (batch.length >= BATCH) {
    imported += await flush(batch);
    batch = [];
    if (imported >= nextLog) { console.log(`…${imported} imported`); nextLog += 20000; }
  }
}
if (batch.length) imported += await flush(batch);
await driver.close();
console.log(`done: ${imported} imported, ${expired} skipped (already expired), ${malformed} malformed lines`);
