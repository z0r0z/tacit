// Conformance suite for the Node KV shim (server/kv-store.mjs) against the
// Cloudflare KV contract the worker depends on: get text/json/arrayBuffer,
// getWithMetadata, put with expirationTtl, byte-lex list ordering, prefix
// isolation, and cursor pagination. Runs against the mem driver always and
// the Postgres driver when TEST_DATABASE_URL is set, so both backends stay
// pinned to the same semantics.
//
// Run: `node tests/server-kv-shim.test.mjs`

import { createKVNamespace } from '../server/kv-store.mjs';
import { createMemDriver } from '../server/driver-mem.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSuite(label, driver) {
  console.log(`\n[${label}]`);
  const kv = createKVNamespace(driver, 'REGISTRY_KV');
  const other = createKVNamespace(driver, 'UPLOAD_KV');

  // text + missing
  await kv.put('t:plain', 'hello');
  ok('text roundtrip', (await kv.get('t:plain')) === 'hello');
  ok('missing key is null', (await kv.get('t:absent')) === null);

  // json (the worker's dominant form: .get(key, 'json'))
  await kv.put('t:json', JSON.stringify({ a: 1, b: [2, 3] }));
  const j = await kv.get('t:json', 'json');
  ok('json type parses', j && j.a === 1 && j.b[1] === 3);

  // arrayBuffer with binary bytes (dapp bundle path)
  const bytes = new Uint8Array(256).map((_, i) => i);
  await kv.put('t:bin', bytes, { metadata: { cb: 'deadbeef' } });
  const buf = await kv.get('t:bin', { type: 'arrayBuffer' });
  ok('arrayBuffer roundtrip', buf instanceof ArrayBuffer
    && buf.byteLength === 256 && new Uint8Array(buf)[255] === 255);
  const { value: mv, metadata } = await kv.getWithMetadata('t:bin', { type: 'arrayBuffer' });
  ok('getWithMetadata value+metadata', mv?.byteLength === 256 && metadata?.cb === 'deadbeef');
  const { value: nv, metadata: nm } = await kv.getWithMetadata('t:absent');
  ok('getWithMetadata missing', nv === null && nm === null);

  // namespace isolation
  await other.put('t:plain', 'other-ns');
  ok('namespaces isolated', (await kv.get('t:plain')) === 'hello'
    && (await other.get('t:plain')) === 'other-ns');

  // putMany (driver-level): batched upsert, intra-batch duplicate (ns,key)
  // resolves last-write-wins, returned count is post-dedup
  const pmN = await driver.putMany([
    { ns: 'REGISTRY_KV', key: 't:pm-batch-a', value: Buffer.from('one'), metadata: null, expiresAt: null },
    { ns: 'REGISTRY_KV', key: 't:pm-batch-b', value: Buffer.from('two'), metadata: { m: 1 }, expiresAt: null },
    { ns: 'REGISTRY_KV', key: 't:pm-batch-a', value: Buffer.from('three'), metadata: null, expiresAt: null },
  ]);
  ok('putMany returns deduped count', pmN === 2, pmN);
  ok('putMany intra-batch last write wins', (await kv.get('t:pm-batch-a')) === 'three');
  ok('putMany upserts all rows', (await kv.get('t:pm-batch-b')) === 'two'
    && (await kv.getWithMetadata('t:pm-batch-b')).metadata?.m === 1);

  // expirationTtl: present before, null after, excluded from list
  await kv.put('ttl:short', 'ephemeral', { expirationTtl: 1 });
  ok('ttl key live before expiry', (await kv.get('ttl:short')) === 'ephemeral');
  await sleep(1100);
  ok('ttl key null after expiry', (await kv.get('ttl:short')) === null);
  const ttlList = await kv.list({ prefix: 'ttl:' });
  ok('expired key excluded from list', ttlList.keys.length === 0, ttlList.keys);

  // lex ordering with zero-padded heights — the pmint canonical-order contract
  const heights = [9, 100, 23, 1, 999999];
  for (const h of heights) {
    await kv.put(`pm:${String(h).padStart(10, '0')}:x`, String(h));
  }
  const lex = await kv.list({ prefix: 'pm:' });
  ok('lex order matches numeric order of zero-padded keys',
    lex.keys.map((k) => k.name).join() ===
    [...heights].sort((a, b) => a - b).map((h) => `pm:${String(h).padStart(10, '0')}:x`).join(),
    lex.keys.map((k) => k.name));
  ok('list_complete true on full fetch', lex.list_complete === true && lex.cursor === null);

  // prefix isolation: pm: must not leak into pmx:
  await kv.put('pmx:intruder', '1');
  const iso = await kv.list({ prefix: 'pm:' });
  ok('prefix does not match sibling prefix', iso.keys.every((k) => k.name.startsWith('pm:')));

  // cursor pagination: walk in pages of 2, no dups, no skips
  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = await kv.list({ prefix: 'pm:', limit: 2, cursor });
    seen.push(...page.keys.map((k) => k.name));
    ok(`page ${guard} sized ≤ limit`, page.keys.length <= 2);
    cursor = page.cursor;
    if (page.list_complete) ok(`final page ${guard} has null cursor`, cursor === null);
    if (++guard > 10) break;
  } while (cursor);
  ok('pagination visits every key exactly once',
    seen.join() === lex.keys.map((k) => k.name).join(), seen);

  // keyset cursor survives interleaved writes: a key inserted behind the
  // cursor never reappears, one inserted ahead is picked up
  const p1 = await kv.list({ prefix: 'pm:', limit: 2 });
  await kv.put('pm:0000000000:behind', 'b');   // sorts before page 1's keys
  await kv.put('pm:9999999999:ahead', 'a');    // sorts after everything
  const rest = [];
  cursor = p1.cursor;
  while (cursor) {
    const page = await kv.list({ prefix: 'pm:', limit: 2, cursor });
    rest.push(...page.keys.map((k) => k.name));
    cursor = page.cursor;
  }
  ok('no duplicates across interleaved insert', !rest.includes(p1.keys[0].name) && !rest.includes(p1.keys[1].name));
  ok('key inserted ahead of cursor is reached', rest.includes('pm:9999999999:ahead'));

  // foreign cursors (Cloudflare's opaque blobs imported with a KV snapshot)
  // restart the list instead of throwing or poisoning the query
  const head = (await kv.list({ prefix: 'pm:', limit: 2 })).keys[0].name;
  for (const foreign of [
    'AAAAANuIf9XEF7sjk_q7Z2ho3eRRJzCi1oajZJXKuQyIvWDXX5gb7NQ', // CF-style opaque
    Buffer.from([0, 1, 2, 254, 255]).toString('base64url'),     // binary w/ NUL
    'not base64url!!',
  ]) {
    const fresh = await kv.list({ prefix: 'pm:', limit: 2, cursor: foreign });
    ok(`foreign cursor restarts list (${foreign.slice(0, 12)}…)`,
      fresh.keys.length === 2 && fresh.keys[0].name === head, fresh.keys.map((k) => k.name));
  }

  // delete
  await kv.delete('t:plain');
  ok('deleted key is null', (await kv.get('t:plain')) === null);

  // list keys carry expiration when set
  await kv.put('exp:carry', 'v', { expirationTtl: 3600 });
  const expList = await kv.list({ prefix: 'exp:' });
  const nowSec = Math.floor(Date.now() / 1000);
  ok('list exposes expiration epoch-seconds',
    expList.keys[0]?.expiration > nowSec && expList.keys[0].expiration <= nowSec + 3601,
    expList.keys[0]);

  // sweep reclaims expired rows
  await kv.put('sweep:gone', 'v', { expirationTtl: 1 });
  await sleep(1100);
  const swept = await driver.sweepExpired();
  ok('sweepExpired reclaims rows', swept >= 1, swept);
}

await runSuite('mem driver', createMemDriver());

if (process.env.TEST_DATABASE_URL) {
  const { createPgDriver } = await import('../server/driver-pg.mjs');
  const pgDriver = await createPgDriver(process.env.TEST_DATABASE_URL);
  // isolate runs: clear both namespaces' test keys
  for (const ns of ['REGISTRY_KV', 'UPLOAD_KV']) {
    for (const prefix of ['t:', 'ttl:', 'pm:', 'pmx:', 'exp:', 'sweep:']) {
      let cur = null;
      do {
        const page = await createKVNamespace(pgDriver, ns).list({ prefix, cursor: cur });
        for (const k of page.keys) await pgDriver.delete(ns, k.name);
        cur = page.cursor;
      } while (cur);
    }
  }
  await runSuite('pg driver', pgDriver);
  await pgDriver.close();
} else {
  console.log('\n[pg driver] skipped — set TEST_DATABASE_URL to run');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
