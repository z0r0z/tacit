// POST /outpoints/classify over a real signet chain whose last hop is a Bulletproofs+ transfer.
//
// The ancestry walk parses commitments with the worker's @noble/secp256k1 but checks BP+ proofs with the dapp's
// verifier, which runs on a vendored copy of the same library; noble tests every point with `instanceof`, so the
// two copies' points do not mix and a valid BP+ transfer used to answer `unverified` ("ancestry walk failed").
// Here the whole chain (etch -> two classic transfers -> BP+ transfer) goes through the worker's real fetch handler
// with the explorer stubbed from a captured fixture, so the real envelope decoder, kernel signatures and both
// range-proof verifiers run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../worker/src/index.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/signet-bpp-ancestry.json', import.meta.url), 'utf8'));
const ETCH_ASSET = 'bcace0dedc8bd6b0c43d4dc0280471d43826bca94702858ae3379881b25c949c';
const [TARGET_TXID] = fx.target.split(':');

// Flip one bit of the BP+ proof inside the target transfer's envelope. The transfer's witness is
// [schnorr sig, envelope script, control block]; the proof sits in the middle of the script's payload.
function withBrokenProof(txs) {
  const t = structuredClone(txs);
  const w = t[TARGET_TXID].vin[0].witness;
  const k = w.findIndex((x) => x.includes('5441434954'));
  const mid = Math.floor(w[k].length / 2) & ~1;
  const flipped = (parseInt(w[k].slice(mid, mid + 2), 16) ^ 0x01).toString(16).padStart(2, '0');
  w[k] = w[k].slice(0, mid) + flipped + w[k].slice(mid + 2);
  return t;
}

const realFetch = globalThis.fetch;
let served = fx.txs;
test.before(() => {
  globalThis.fetch = async (input) => {
    const m = String(input).match(/\/tx\/([0-9a-f]{64})$/);
    if (m && served[m[1]]) return new Response(JSON.stringify(served[m[1]]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
});
test.after(() => { globalThis.fetch = realFetch; });

const classify = async (op, env = { SIGNET_API: 'https://stub.test/api' }) => {
  const r = await worker.fetch(new Request('https://api.test/outpoints/classify?network=signet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outpoints: [op] }),
  }), env, { waitUntil() {} });
  assert.equal(r.status, 200);
  return (await r.json()).coins[op];
};

test('a transfer carrying a Bulletproofs+ range proof classifies as the etched asset', async () => {
  served = fx.txs;
  const c = await classify(fx.target);
  assert.deepEqual(c, { status: 'asset', asset_ids: [ETCH_ASSET] });
});

test('a corrupted Bulletproofs+ proof is still refused, never reported as an asset', async () => {
  served = withBrokenProof(fx.txs);
  const c = await classify(fx.target);
  assert.equal(c.status, 'unverified');
  assert.notEqual(c.reason, 'ancestry walk failed', 'the verifier must answer, not throw');
});

// Last in the file: a 503 from every source puts them all on cooldown for the rest of the process.
test('a proven Bulletproofs+ asset still answers when every explorer is down', async () => {
  served = fx.txs;
  const kv = new Map();
  const env = { SIGNET_API: 'https://stub.test/api', REGISTRY_KV: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } } };
  assert.equal((await classify(fx.target, env)).status, 'asset');

  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  assert.deepEqual(await classify(fx.target, env), { status: 'asset', asset_ids: [ETCH_ASSET] });
  const other = `${'cd'.repeat(32)}:0`;
  assert.equal((await classify(other, env)).status, 'unverified');
});
