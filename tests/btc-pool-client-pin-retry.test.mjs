// A pin.json read that failed is asked again by the next call; one that succeeded is kept.
//   node tests/btc-pool-client-pin-retry.test.mjs
import assert from 'node:assert/strict';
import { makePoolClient } from '../dapp/btc-pool-client.js';

const pinned = { wasm: 'a.wasm', wasm_sha256: 'aa', wasm_bytes: 10, params: 'p.bin', params_sha256: 'bb', params_bytes: 20, vk: 'v.bin', vk_sha256: 'cc', vk_bytes: 5 };
let pinReads = 0, failFirst = 1;
const fetchImpl = async (url) => {
  if (!String(url).endsWith('/btc-pool/pin.json')) throw new Error(`unexpected request ${url}`);
  pinReads++;
  if (failFirst-- > 0) throw new TypeError('network down');
  return { ok: true, status: 200, json: async () => pinned };
};
const client = makePoolClient({ api: 'http://replay', fetchImpl });

await assert.rejects(client.artifactBytes(), /network down/, 'the first read fails');
assert.equal(await client.artifactBytes(), 35, 'the next call reads pin.json again and succeeds');
assert.equal(pinReads, 2);
assert.equal(await client.artifactBytes(), 35);
assert.equal(pinReads, 2, 'a read that worked is kept');

// An HTTP error is not kept either.
let status = 503, reads = 0;
const flaky = makePoolClient({ api: 'http://replay', fetchImpl: async () => { reads++; return { ok: status < 400, status, json: async () => (status < 400 ? pinned : { error: 'busy' }) }; } });
await assert.rejects(flaky.artifactBytes(), /busy/);
status = 200;
assert.equal(await flaky.artifactBytes(), 35);
assert.equal(reads, 2);

console.log('btc-pool-client-pin-retry: all checks passed');
