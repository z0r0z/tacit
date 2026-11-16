// worker/src/op-admit.js: an op of a type the relay sponsors must carry the fields its prover reads, checked at the door before it takes a place
// in the queue or a free settle. Its shape only; never the chain.
//   node --test tests/op-admit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';
import { admitOpShape, SHAPED_TYPES } from '../worker/src/op-admit.js';

const worker = await import('../worker/src/index.js');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool, signSchnorr });
const fixture = (f) => JSON.parse(readFileSync(new URL(`../contracts/sp1/confidential/fixtures/${f}.json`, import.meta.url), 'utf8'));
const FX = { cbtcmint: fixture('cbtc_mint_op'), cdpmint: fixture('cdp_mint_op'), cdptopup: fixture('cdp_topup_op'), farmunbond: fixture('farm_unbond_op') };
// As the relay client posts an op: every BigInt a decimal string (dapp/confidential-relay.js bigintSafe).
const wire = (op) => JSON.parse(JSON.stringify(op, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('the types it judges are the ones the relay sponsors without a fee, and the farm unbond a burst of junk jobs held the relay on', () => {
  assert.deepEqual([...SHAPED_TYPES].sort(), ['cbtcmint', 'cdpmint', 'cdptopup', 'farmunbond']);
});

test('a farm unbond is read as its prover reads it: the signature is 64 bytes, the path 32 long, the fee optional', () => {
  const op = clone(FX.farmunbond);
  assert.deepEqual(admitOpShape('farmunbond', op), { ok: true });
  const noFee = clone(op); delete noFee.fee;
  assert.deepEqual(admitOpShape('farmunbond', noFee), { ok: true }, 'fee is optional, as the prover reads it');
  for (const v of ['0x' + 'ab'.repeat(65), '0x' + 'ab'.repeat(63), 'ab'.repeat(64)]) assert.equal(admitOpShape('farmunbond', { ...op, ownerSig: v }).ok, false, `a signature of ${v.length} characters`);
  assert.equal(admitOpShape('farmunbond', { ...op, oldPath: op.oldPath.slice(1) }).ok, false, 'a path of 31');
  assert.equal(admitOpShape('farmunbond', { ...op, controller: '0x' + '11'.repeat(32) }).ok, false, 'a controller is an address');
  assert.equal(admitOpShape('farmunbond', { ...op, shares: -1 }).ok, false);
  assert.equal(admitOpShape('farmunbond', { ...op, fee: 'x' }).ok, false);
  assert.equal(admitOpShape('farmunbond', {}).ok, false, 'the empty op of the burst');
  // As the page posts it: every BigInt a decimal string.
  assert.deepEqual(admitOpShape('farmunbond', wire({ ...op, shares: BigInt(op.shares), oldIndex: BigInt(op.oldIndex), fee: 0n })), { ok: true });
});

test('the ops the prover\'s harnesses were built against pass', () => {
  for (const t of SHAPED_TYPES) assert.deepEqual(admitOpShape(t, clone(FX[t])), { ok: true }, t);
});

test('what the page\'s own builders make passes, as it is posted', () => {
  const chainBinding = '0x' + '11'.repeat(32), outpoint = '0x' + '33'.repeat(32);
  const cbtc = wire(cdp.buildCbtcMintOp({ chainBinding, outpoint, vBtc: 100000n, blinding: randomScalar() }));
  assert.deepEqual(admitOpShape('cbtcmint', cbtc), { ok: true });
  const nk = '0x' + randomScalar().toString(16).padStart(64, '0'), blinding = randomScalar(), value = 600n;      // the note's secret, as the page holds it
  const leg = { asset: '0x' + 'aa'.repeat(32), ...pool.commitXY(value, blinding), value, blinding, leafIndex: 0, path: pool.zeros, owner: pool.nkToOwner(nk), nk };
  const loan = wire(cdp.buildCdpMintOp({ chainBinding, controller: '0x' + 'c1'.repeat(20), owner: '0x' + '0b'.repeat(32), debtOwner: pool.nkToOwner(randomScalar()), debtValue: 1000n, nonce: '0x' + '00'.repeat(32),
    rateSnapshot: '0x' + '00'.repeat(32), fee: 0n, collateral: [leg], spendRoot: '0x' + '22'.repeat(32), debtBlinding: randomScalar() }));
  const r = admitOpShape('cdpmint', loan);
  assert.equal(r.ok, true, JSON.stringify(r) + ' ' + JSON.stringify(Object.keys(loan.legs[0])));
});

test('an op missing any one of the fields its prover reads is refused, naming it', () => {
  for (const t of SHAPED_TYPES) {
    for (const k of Object.keys(FX[t])) {
      if (['expected', 'op', 'nonce', 'fee', 'debtOwner', 'debt'].includes(k) && t !== 'cdptopup') continue;     // read as optional or not at all by the door
      if (k === 'expected' || k === 'op') continue;
      const o = clone(FX[t]); delete o[k];
      const r = admitOpShape(t, o);
      assert.equal(r.ok, false, `${t} without ${k}`);
      assert.equal(r.code, 'bad_op');
      assert.match(r.error, new RegExp(k), `${t}: the reason names ${k}`);
    }
  }
});

test('a leg that lacks what the prover reads, or a basket that is empty or too large, is refused', () => {
  const l = clone(FX.cdpmint);
  for (const k of ['asset', 'cx', 'cy', 'owner', 'nk', 'value', 'index', 'path', 'sigR', 'sigZ']) {
    const o = clone(l); delete o.legs[0][k];
    assert.equal(admitOpShape('cdpmint', o).ok, false, `a leg without ${k}`);
  }
  assert.equal(admitOpShape('cdpmint', { ...clone(l), legs: [] }).ok, false, 'no collateral');
  assert.equal(admitOpShape('cdpmint', { ...clone(l), legs: Array(9).fill(clone(l.legs[0])) }).ok, false, 'nine legs');
  const o = clone(l); o.legs[0].path = o.legs[0].path.slice(1);
  assert.equal(admitOpShape('cdpmint', o).ok, false, 'a path of 31');
  const t = clone(FX.cdptopup); t.oldLegs = [];
  assert.equal(admitOpShape('cdptopup', t).ok, false, 'a top-up of a position with no old basket');
});

test('a number may be an integer, a decimal string or hex, and nothing else', () => {
  for (const v of [100000, '100000', '0x186a0', 100000n]) assert.equal(admitOpShape('cbtcmint', { ...clone(FX.cbtcmint), vBtc: v }).ok, true, String(v));
  for (const v of [-1, 1.5, 'x', '', null, undefined, {}, [], '1e5']) assert.equal(admitOpShape('cbtcmint', { ...clone(FX.cbtcmint), vBtc: v }).ok, false, String(v));
  for (const v of ['0x' + '00'.repeat(32), 10n ** 27n, String(10n ** 27n)]) assert.equal(admitOpShape('cdpmint', { ...clone(FX.cdpmint), rateSnapshot: v }).ok, true, String(v));
});

test('hex fields are the length their prover reads', () => {
  const c = clone(FX.cbtcmint);
  for (const [k, v] of [['outpoint', '0x1234'], ['cx', '0x' + 'zz'.repeat(32)], ['sigR', '0x' + '02'.repeat(32)], ['chainBinding', 'abc'], ['sigZ', '0x' + '11'.repeat(33)]]) assert.equal(admitOpShape('cbtcmint', { ...c, [k]: v }).ok, false, `${k}=${v.slice(0, 12)}`);
  assert.equal(admitOpShape('cdpmint', { ...clone(FX.cdpmint), controller: '0x' + '11'.repeat(32) }).ok, false, 'a controller is an address');
});

test('what is not an object, and what it does not judge', () => {
  for (const bad of [null, undefined, 'x', 3, []]) assert.equal(admitOpShape('cbtcmint', bad).ok, false);
  for (const t of ['transfer', 'wrap', 'bridgemint', 'cdpclose', 'farmharvest', '', undefined]) assert.deepEqual(admitOpShape(t, {}), { ok: true }, `${t} is judged elsewhere`);
});

// The door: an op that is not a mint is turned back before it takes a place in the queue or a free settle.
function memKv() {
  const m = new Map();
  return { get: async (k, t) => { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }), _m: m };
}
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 404 });
test('the door turns back a junk op, before it is queued or counted, and takes a real one', async () => {
  const kv = memKv(), env = { CONFIDENTIAL_SETTLE: '1', REGISTRY_KV: kv, CONFIDENTIAL_KV: kv, PROVE_RL_BURST: '1000', FREE_RELAY_CHEAP_GWEI: '0' };
  let ip = 0;
  const post = async (type, op, mode = 'settle') => { const r = await worker.default.fetch(new Request('https://api.test/confidential/submit', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `203.0.113.${++ip}` }, body: JSON.stringify({ type, op, memos: [], mode }) }), env, { waitUntil() {} }); return { status: r.status, body: await r.json() }; };
  for (const [type, mode] of [['cbtcmint', 'settle'], ['cdpmint', 'settle'], ['cdptopup', 'settle'], ['cbtcmint', 'prove'], ['farmunbond', 'settle'], ['farmunbond', 'prove']]) {
    const r = await post(type, { fee: 0, junk: true }, mode);
    assert.equal(r.status, 400, `${type} ${mode}`);
    assert.equal(r.body.code, 'bad_op');
    assert.doesNotMatch(r.body.error, /relay (is|has) (low|failed|down)/i, 'and says nothing of the relay');
  }
  assert.equal([...kv._m.keys()].filter((k) => k.startsWith('cps:budget:') || k.startsWith('cps:job:')).length, 0, 'no allowance spent and no job queued');
  const good = await post('cbtcmint', clone(FX.cbtcmint));
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.ok(good.body.jobId);
});
test('OP_SHAPE_CHECK=0 switches the check off', async () => {
  const kv = memKv(), env = { CONFIDENTIAL_SETTLE: '1', REGISTRY_KV: kv, CONFIDENTIAL_KV: kv, PROVE_RL_BURST: '1000', FREE_RELAY_CHEAP_GWEI: '0', OP_SHAPE_CHECK: '0' };
  const r = await worker.default.fetch(new Request('https://api.test/confidential/submit', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.250' }, body: JSON.stringify({ type: 'cbtcmint', op: { fee: 0, junk: true }, memos: [], mode: 'settle' }) }), env, { waitUntil() {} });
  assert.equal(r.status, 200, 'with the check off, the door is as it was');
});
test.after(() => { globalThis.fetch = realFetch; });
