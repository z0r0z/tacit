#!/usr/bin/env node
// GET /reflection/burndep/cache-status — reports how much of the header-chain cache
// (worker/src/burndep-admission.js) between an asset's etch and the current tip is warm. Runs against real
// esplora (the tip lookup) with an in-memory KV, so this is a real, if small, network test.
//   node tests/burndep-cache-status.mjs
import assert from 'node:assert';
import { handleBurndepCacheStatus } from '../worker/src/index.js';

function makeKv(seed) {
  const m = new Map(Object.entries(seed || {}));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => m.set(k, typeof v === 'string' ? v : JSON.stringify(v)), _m: m };
}
function req() { return { headers: { get: () => null } }; }

let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

// signet has no configured floor by default -> a clean, explicit "not configured" response, not an error.
{
  const res = await handleBurndepCacheStatus(req(), { BURNDEP_CACHE_STATUS_TTL_MS: 0, REGISTRY_KV: makeKv() }, new URL('https://x/reflection/burndep/cache-status?network=signet'), {});
  const body = await res.json();
  ok(body.ok === true && body.floor === 0, 'signet (no floor configured) reports cleanly rather than erroring');
}

// mainnet: real tip lookup, empty cache -> 0 chunks warm, complete:false, warmThroughHeight:null.
{
  const res = await handleBurndepCacheStatus(req(), { BURNDEP_CACHE_STATUS_TTL_MS: 0, REGISTRY_KV: makeKv() }, new URL('https://x/reflection/burndep/cache-status?network=mainnet'), {});
  const body = await res.json();
  ok(body.ok === true, 'mainnet with an empty cache still responds ok');
  ok(body.floor === 948242, 'reports TAC\'s real mainnet etch height as the floor');
  ok(Number.isInteger(body.tip) && body.tip > body.floor, `reports a real current tip past the floor (tip=${body.tip})`);
  ok(body.chunksWarm === 0 && body.complete === false && body.warmThroughHeight === null, 'an empty cache reports zero progress, not a false positive');
  ok(body.chunksTotal > 15 && body.chunksTotal < 30, `chunk count is in the expected ballpark for a ~21k-block range (got ${body.chunksTotal})`);
}

// A seeded, fully-warm chunk at the floor is correctly reported.
{
  const chunkIndex = Math.floor(948242 / 1000);
  const fullChunk = new Array(1000).fill('0x' + 'ab'.repeat(80));
  const kv = makeKv({ [`reflection:hdrs:mainnet:${chunkIndex}`]: JSON.stringify(fullChunk) });
  const res = await handleBurndepCacheStatus(req(), { BURNDEP_CACHE_STATUS_TTL_MS: 0, REGISTRY_KV: kv }, new URL('https://x/reflection/burndep/cache-status?network=mainnet'), {});
  const body = await res.json();
  ok(body.chunksWarm === 1, 'a single fully-warm chunk is counted');
  ok(body.warmThroughHeight === (chunkIndex + 1) * 1000 - 1, 'warmThroughHeight reflects exactly the warmed chunk\'s own top height');
}

// A partial (not-yet-complete) chunk is not counted as warm.
{
  const chunkIndex = Math.floor(948242 / 1000);
  const kv = makeKv({ [`reflection:hdrs:mainnet:${chunkIndex}`]: JSON.stringify(new Array(500).fill('0x' + 'ab'.repeat(80))) });
  const res = await handleBurndepCacheStatus(req(), { BURNDEP_CACHE_STATUS_TTL_MS: 0, REGISTRY_KV: kv }, new URL('https://x/reflection/burndep/cache-status?network=mainnet'), {});
  const body = await res.json();
  ok(body.chunksWarm === 0, 'a partial (500/1000) chunk does not count as warm');
}

// A warm chunk, then a gap, then a warm chunk: contiguous coverage stops at the gap, even though more
// chunks past it are warm — this is exactly the case the floor-alignment fix above exists for.
{
  const first = Math.floor(948242 / 1000);
  const fullChunk = () => new Array(1000).fill('0x' + 'ab'.repeat(80));
  const kv = makeKv({
    [`reflection:hdrs:mainnet:${first}`]: JSON.stringify(fullChunk()),
    [`reflection:hdrs:mainnet:${first + 2}`]: JSON.stringify(fullChunk()), // first+1 left empty: the gap
  });
  const res = await handleBurndepCacheStatus(req(), { BURNDEP_CACHE_STATUS_TTL_MS: 0, REGISTRY_KV: kv }, new URL('https://x/reflection/burndep/cache-status?network=mainnet'), {});
  const body = await res.json();
  ok(body.chunksWarm === 1, 'contiguous coverage stops at the gap (does not count the chunk past it)');
  ok(body.chunksWarmTotal === 2, 'the diagnostic total still reports both warm chunks');
  ok(body.warmThroughHeight === (first + 1) * 1000 - 1, 'warmThroughHeight reflects only the contiguous prefix, not the chunk past the gap');
}

console.log(`\n${n} burndep-cache-status checks passed`);
