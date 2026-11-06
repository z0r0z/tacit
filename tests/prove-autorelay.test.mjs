// dapp/prove/autorelay.js: the open board's settles sent from a relay account kept in the browser. A pass sends only what pays its gas
// with a fifth to spare, runs it first, sends it through Protect, waits for it before the next, counts what it earned, and stops at the
// day's gas allowance or the account's reserve.
// Run: node --test tests/prove-autorelay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAutoRelay, AUTO_DAY_GAS_WEI } from '../dapp/prove/autorelay.js';
import { ETH_ASSET_ID as ETH, ETH_UNIT_SCALE, POOL } from '../dapp/community-ops.js';

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
function pv(fees) {
  const head = Array.from({ length: 19 }, () => word(0));
  head[7] = word(19 * 32);
  return '0x' + word(32) + head.join('') + word(fees.length) + fees.map(([a, v]) => a.slice(2) + word(v)).join('');
}
const job = (id, feeWei, since = 1000) => ({ jobId: 'j' + id, type: 'transfer', status: 'open', publicValues: pv(feeWei ? [[ETH, feeWei / ETH_UNIT_SCALE]] : []), proof: '0x' + 'cd'.repeat(260), memos: [], openSince: since });
const GWEI = 10n ** 9n, ME = '0x' + 'aa'.repeat(20);

function chain({ bal = 10n ** 17n, base = 1n * GWEI, est = 400000n, refuse = false, jobs = [] } = {}) {
  const C = { sent: [], landed: [], calls: [], head: 100, receipt: null, saved: null, jobs };
  const hex = (n) => '0x' + BigInt(n).toString(16);
  C.rpc = async (m, p) => {
    C.calls.push(m);
    if (m === 'eth_getBalance') return hex(bal);
    if (m === 'eth_gasPrice') return hex(base + 10n ** 8n);
    if (m === 'eth_getBlockByNumber') return { number: hex(C.head), baseFeePerGas: hex(base) };
    if (m === 'eth_call') { if (refuse) throw new Error('execution reverted'); assert.equal(p[0].to, POOL); assert.equal(p[0].from, ME); return '0x'; }
    if (m === 'eth_estimateGas') return hex(est);
    if (m === 'eth_getTransactionCount') return '0x7';
    if (m === 'eth_getTransactionReceipt') return C.receipt;
    if (m === 'eth_blockNumber') return hex(C.head);
    throw new Error('unexpected ' + m);
  };
  C.relay = (o = {}) => makeAutoRelay({ address: ME, rpc: C.rpc, sign: (tx) => { C.signed = tx; return { raw: '0xraw', hash: '0x' + 'ee'.repeat(32) }; },
    sendPrivate: async (raw) => { C.sent.push(raw); return '0x' + 'ee'.repeat(32); }, board: async () => ({ jobs: C.jobs }), landed: async (id, h) => { C.landed.push([id, h]); },
    store: { get: () => C.saved, set: (v) => { C.saved = JSON.parse(JSON.stringify(v)); } }, now: () => 5e12, ...o });
  return C;
}

test('a settle whose fee pays its gas with a fifth to spare is run first, then sent privately from the relay account', async () => {
  const C = chain({ jobs: [job(1, 10n ** 15n)] });                // 0.001 ETH fee; 400k gas at ~1 gwei is 0.0004
  const r = await C.relay().pass();
  assert.equal(r.did, 'sent');
  assert.deepEqual(C.sent, ['0xraw']);
  assert.ok(C.calls.indexOf('eth_call') < C.calls.indexOf('eth_getTransactionCount'), 'run before it is signed');
  assert.equal(C.signed.to, POOL); assert.equal(C.signed.nonce, 7n); assert.equal(C.signed.value, 0n);
  assert.equal(C.saved.inFlight.jobId, 'j1');
});

test('nothing that does not pay its gas is sent, nor one the pool would refuse', async () => {
  const thin = chain({ jobs: [job(1, 10n ** 13n)] });
  assert.equal((await thin.relay().pass()).did, 'idle');
  assert.equal(thin.sent.length, 0);
  const taken = chain({ jobs: [job(2, 10n ** 15n)], refuse: true });
  assert.equal((await taken.relay().pass()).did, 'idle');
  assert.equal(taken.sent.length, 0);
});

test('one at a time: while a send is in flight the next waits; landed, it is counted and reported', async () => {
  const C = chain({ jobs: [job(1, 10n ** 15n), job(2, 10n ** 15n, 2000)] });
  const r = C.relay();
  await r.pass();
  assert.equal((await r.pass()).did, 'waiting');
  assert.equal(C.sent.length, 1);
  C.receipt = { status: '0x1', gasUsed: '0x61a80', effectiveGasPrice: '0x3b9aca00' };   // 400k at 1 gwei
  const l = await r.pass();
  assert.equal(l.did, 'landed');
  assert.deepEqual(C.landed, [['j1', '0x' + 'ee'.repeat(32)]]);
  const t = r.today();
  assert.equal(t.sent, 1); assert.equal(t.earnedWei, String(10n ** 15n)); assert.equal(t.gasWei, String(400000n * GWEI));
});

test('a send Protect dropped frees the account after its blocks', async () => {
  const C = chain({ jobs: [job(1, 10n ** 15n)] });
  const r = C.relay();
  await r.pass();
  C.head += 30;
  const n = await r.pass();
  assert.notEqual(n.did, 'waiting');
  assert.equal(C.saved.inFlight?.jobId ?? 'j1', 'j1');
});

test('it stops at the day’s gas allowance and at the reserve', async () => {
  const C = chain({ jobs: [job(1, 10n ** 15n)] });
  C.saved = { day: Math.floor(5e12 / 86400e3), gasWei: String(AUTO_DAY_GAS_WEI), earnedWei: '0', sent: 0, inFlight: null };
  assert.equal((await C.relay().pass()).did, 'stopped');
  const poor = chain({ jobs: [job(1, 10n ** 15n)], bal: 10n ** 15n });
  assert.match((await poor.relay().pass()).why, /needs more ETH/);
  assert.equal(C.sent.length + poor.sent.length, 0);
});
