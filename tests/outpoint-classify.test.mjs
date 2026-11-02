// POST /outpoints/classify — the spend-guard lookup for key-less (multisig vault) wallets.
//
// The route is exercised through the worker's real fetch handler with a stubbed explorer, so the real
// envelope decoder and the real ancestry walk's early exits run. The "verified asset" arm injects the
// ancestry verdict (the walk's crypto is covered where it lives); what is pinned here is the contract a
// spend guard depends on: plain / asset / unverified, and that anything uncertain is never reported plain.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import { makeOutpointClassifier } from '../worker/src/outpoint-classify.js';

const hex = (b) => Buffer.from(b).toString('hex');
const T = (n) => n.toString(16).padStart(2, '0').repeat(32);

// <xonly32> OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <payload> OP_ENDIF — the envelope leaf of SPEC §3.1.
function envelopeScript(opcode, body = new Uint8Array(40)) {
  const payload = Uint8Array.from([opcode, ...body]);
  return hex(Uint8Array.from([
    32, ...new Uint8Array(32).fill(7), 0xac, 0x00, 0x63,
    5, ...new TextEncoder().encode('TACIT'), 1, 0x01, payload.length, ...payload, 0x68,
  ]));
}
const taprootWitness = (opcode) => ['aa'.repeat(64), envelopeScript(opcode), 'c0' + '11'.repeat(32)];
const p2wpkhWitness = ['30'.repeat(71), '02' + '22'.repeat(32)];

const T_CETCH = 0x21, T_BTC_SPEND = 0x6d;
const txs = {
  [T(1)]: { vin: [{ witness: p2wpkhWitness }], vout: [{}, {}] },                                   // ordinary payment
  [T(2)]: { vin: [{ witness: taprootWitness(T_BTC_SPEND) }, { witness: p2wpkhWitness }], vout: [{}, {}] }, // op the walk does not cover
  [T(3)]: { vin: [{ witness: p2wpkhWitness }, { witness: taprootWitness(T_BTC_SPEND) }], vout: [{}, {}] }, // pool spend on a later input
  [T(4)]: { vin: [{ witness: taprootWitness(T_CETCH) }], vout: [{}, {}] },                         // etch: supply at vout 0 only
};

const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async (input) => {
    const m = String(input).match(/\/tx\/([0-9a-f]{64})$/);
    if (m && txs[m[1]]) return new Response(JSON.stringify(txs[m[1]]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
});
test.after(() => { globalThis.fetch = realFetch; });

const env = { MAINNET_API: 'https://stub.test/api' };
const post = (body, origin = 'https://www.multisig.software') => worker.fetch(new Request('https://api.test/outpoints/classify?network=mainnet', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
}), env, { waitUntil() {} });

test('plain coins are plain; anything uncertain is unverified, never plain', async () => {
  const r = await post({ outpoints: [`${T(1)}:0`, `${T(2)}:0`, `${T(3)}:1`, `${T(9)}:0`, `${T(4)}:1`, `${T(4)}:5`] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.coins[`${T(1)}:0`].status, 'plain');
  assert.equal(j.coins[`${T(2)}:0`].status, 'unverified');   // envelope op the walk does not cover
  assert.equal(j.coins[`${T(3)}:1`].status, 'unverified');   // envelope on a later input
  assert.equal(j.coins[`${T(9)}:0`].status, 'unverified');   // explorer cannot answer
  assert.equal(j.coins[`${T(4)}:1`].status, 'plain');        // etch supply lives at vout 0 only
  assert.equal(j.coins[`${T(4)}:5`].status, 'unverified');   // no such output
  assert.deepEqual(j.assets, {});
  assert.deepEqual([...j.unverified].sort(), [`${T(2)}:0`, `${T(3)}:1`, `${T(9)}:0`, `${T(4)}:5`].sort());
});

test('open to any origin (gateways have no fixed origin)', async () => {
  const r = await post({ outpoints: [`${T(1)}:0`] }, 'https://some-gateway.example');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('bad requests are rejected whole', async () => {
  for (const body of [{}, { outpoints: [] }, { outpoints: ['nope'] }, { outpoints: [`${T(1)}:-1`] }, { outpoints: Array(101).fill(`${T(1)}:0`) }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test('a verified ancestry walk reports the asset; walk errors and an exhausted budget fail closed', async () => {
  const asset = 'ab'.repeat(32);
  const fiveOut = { vin: [{ witness: taprootWitness(0x22) }], vout: [{}, {}, {}, {}, {}] };
  const mk = (verify) => makeOutpointClassifier({
    apiJson: async () => fiveOut,
    decodeEnvelopeScript: (b) => (b.length > 40 ? { opcode: 0x22, payload: b } : null),
    hexToBytes: (h) => Buffer.from(h, 'hex'),
    verifyTacAncestry: verify,
  });
  const c = mk(async (_e, _t, vout) => {
    if (vout === 0) return { ok: true, assetIdHex: asset };
    if (vout === 1) return { ok: false, notTacit: true, reason: 'vout 1 is not a tacit output of this tx' };
    if (vout === 2) throw new Error('boom');
    return { ok: false, reason: 'kernel signature invalid' };
  });
  const out = await c.classifyOutpoints({}, 'mainnet', [0, 1, 2, 3].map((v) => `${T(5)}:${v}`));
  assert.deepEqual(out[`${T(5)}:0`], { status: 'asset', asset_ids: [asset] });
  assert.deepEqual(out[`${T(5)}:1`], { status: 'plain' });
  assert.equal(out[`${T(5)}:2`].status, 'unverified');
  assert.equal(out[`${T(5)}:3`].status, 'unverified');
  assert.match(out[`${T(5)}:3`].reason, /kernel signature/);

  // 30 coins that each need a walk: the first 25 are walked, the rest come back unverified, none plain.
  let walked = 0;
  const b = mk(async () => { walked++; return { ok: true, assetIdHex: asset }; });
  const many = [];
  for (let n = 10; n < 16; n++) for (let v = 0; v < 5; v++) many.push(`${T(n)}:${v}`);
  const res = await b.classifyOutpoints({}, 'mainnet', many);
  assert.equal(walked, 25);
  assert.equal(Object.values(res).filter((x) => x.status === 'asset').length, 25);
  assert.equal(Object.values(res).filter((x) => x.status === 'unverified').length, 5);
  assert.equal(Object.values(res).filter((x) => x.status === 'plain').length, 0);
});

test('a proven asset keeps answering when the explorer is down; plain, unconfirmed and unproven coins do not', async () => {
  const asset = 'ab'.repeat(32);
  const kv = new Map();
  const REGISTRY_KV = { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } };
  let down = false;
  const lookups = [];
  const txOf = (txid) => (txid === T(7)
    ? { status: { confirmed: true }, vin: [{ witness: p2wpkhWitness }], vout: [{}, {}] }
    : { status: { confirmed: txid !== T(6) }, vin: [{ witness: taprootWitness(0x22) }], vout: [{}, {}] });
  const c = makeOutpointClassifier({
    apiJson: async (_e, path) => { lookups.push(path); if (down) throw new Error('all sources failed'); return txOf(path.split('/')[2]); },
    decodeEnvelopeScript: (b) => (b.length > 40 ? { opcode: 0x22, payload: b } : null),
    hexToBytes: (h) => Buffer.from(h, 'hex'),
    verifyTacAncestry: async () => ({ ok: true, assetIdHex: asset }),
  });
  const env = { REGISTRY_KV };
  const ops = [`${T(5)}:0`, `${T(6)}:0`, `${T(7)}:0`, `${T(8)}:0`];

  const up = await c.classifyOutpoints(env, 'mainnet', ops);
  assert.equal(up[ops[0]].status, 'asset');
  assert.equal(up[ops[1]].status, 'asset');   // proven, but its transaction is not confirmed yet
  assert.equal(up[ops[2]].status, 'plain');
  assert.deepEqual([...kv.keys()].filter((k) => k.includes(T(5))), [`tacclass:v1:mainnet:${T(5)}:0`]);
  assert.equal(kv.size, 2, 'only the confirmed assets (T(5), T(8)) are kept');

  // The explorer goes down, and one kept entry is damaged: it is a miss, never an answer.
  down = true;
  kv.set(`tacclass:v1:mainnet:${T(8)}:0`, JSON.stringify({ asset_ids: ['zz'] }));
  lookups.length = 0;
  const out = await c.classifyOutpoints(env, 'mainnet', ops);
  assert.deepEqual(out[ops[0]], { status: 'asset', asset_ids: [asset] });
  assert.equal(out[ops[1]].status, 'unverified');
  assert.equal(out[ops[2]].status, 'unverified');   // plain is never answered from memory
  assert.equal(out[ops[3]].status, 'unverified');
  assert.ok(!lookups.some((p) => p.includes(T(5))), 'a kept asset needs no explorer call');

  // A kv failure is a miss, not an error.
  const broken = { REGISTRY_KV: { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } } };
  down = false;
  assert.equal((await c.classifyOutpoints(broken, 'mainnet', [ops[0]]))[ops[0]].status, 'asset');
});
