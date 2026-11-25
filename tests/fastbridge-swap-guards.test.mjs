// The atomic swap's guards: the claim of a pool lock is read however its settle was sent (a forwarder, a contract wallet, an obfuscated call read from a trace), and a lock
// spent with no claim to read is said loudly; one Bitcoin lock of a provider is never answered by two locks of the user's ETH; an ETH-for-Bitcoin swap is found again from
// the key alone and finished; a market-priced quote is not answered at its old price long after its time; a provider's hold is only for the quote's own lock; and one key
// asks the reverse side for one lock at a time.
//   node tests/fastbridge-swap-guards.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFastBridgeEvm, makeTxTracer, makeOwnLockFinder, openLockMemo, lockMemoKey } from '../dapp/fastbridge-evm.js';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import { makeBitcoinLocker } from '../dapp/fastbridge-bl.js';
import { makeLpService } from '../dapp/fastbridge-provider.js';
import { makeCounter } from '../dapp/fastbridge-http.js';
import { makeConfidentialLockScan } from '../dapp/confidential-lock-scan.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { SATS_ASSET, PAIR_POLICY } from '../dapp/fastbridge-pair.js';
import * as X from '../dapp/adaptor-xswap.js';
import { G, SECP_N } from '../dapp/bulletproofs.js';
import { secp, keccak_256, sha256, hmac, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { memStore } from './lib/fastbridge-world.mjs';
import { pairWorld, UNITS, SATS, strip } from './lib/pair-world.mjs';
import { pairReverseOptions } from '../fastbridge-lp/lib/pair.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const hmacSha256 = (k, m) => hmac(sha256, k, m);

// ── the settle's calldata, as ConfidentialPool.settle(bytes publicValues, bytes proof, bytes[] memos) takes it ──
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const lockScan = makeConfidentialLockScan({ pool });
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytes32 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const encBytes = (h) => { const b = String(h).replace(/^0x/, ''); return word(b.length / 2) + b + '0'.repeat((64 - (b.length % 64)) % 64); };
const encB32Arr = (items) => word(items.length) + items.map(bytes32).join('');
const encBytesArr = (items) => { const e = items.map(encBytes); let off = items.length * 32, head = ''; for (const x of e) { head += word(off); off += x.length / 2; } return word(items.length) + head + e.join(''); };
const args3 = ({ publicValues, proof, memos }) => { const a = encBytes(publicValues), b = encBytes(proof), c = encBytesArr(memos); const o1 = 96, o2 = o1 + a.length / 2, o3 = o2 + b.length / 2; return word(o1) + word(o2) + word(o3) + a + b + c; };
// public values: fields 0..20 in ConfidentialPool.sol's order (18 lockNullifiers, 19 adaptorClaimS)
function publicValues({ lockNullifiers = [], adaptorClaimS = [], lockLeaves = [] }) {
  const z32 = bytes32('0x' + '00'.repeat(32));
  const dyn = (enc) => ({ dyn: enc });
  const F = [{ st: word(1) }, { st: z32 }, { st: z32 }, dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(word(0)), dyn(word(0)), dyn(encB32Arr([])), dyn(word(0)), dyn(encB32Arr([])),
    { st: z32 }, { st: z32 }, dyn(word(0)), dyn(word(0)), { st: word(0) }, { st: z32 }, dyn(encB32Arr(lockLeaves)), dyn(encB32Arr(lockNullifiers)), dyn(encB32Arr(adaptorClaimS)), { st: word(0) }];
  let head = '', tail = '', pos = F.length * 32;
  for (const f of F) { if (f.st != null) head += f.st; else { head += word(pos); tail += f.dyn; pos += f.dyn.length / 2; } }
  return '0x' + word(32) + head + tail;
}
const settleData = (lockNu, s) => '0x717fd7f2' + args3({ publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: s }), proof: '0x' + 'cc'.repeat(32), memos: [] });
// a forwarder's call that carries the settle as it is: forward(address target, bytes data)
const forwarded = (data) => '0x12345678' + word('0x' + '0e'.repeat(20)) + word(64) + encBytes(data);
// one that does not: the settle's bytes are scrambled in its calldata and put together by the contract
const scrambled = (data) => '0x87654321' + strip(data).split('').map((c) => (parseInt(c, 16) ^ 0x5).toString(16)).join('');

const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', FWD = '0x' + 'f0'.repeat(20);
const t = 0x1234567890abcdefn % SECP_N, T = G.multiply(t);
const sTilde = 0xabcdef0123456789n % SECP_N, z = (sTilde + t) % SECP_N;
const zHex = '0x' + z.toString(16).padStart(64, '0');
const lockNu = '0x' + 'ab'.repeat(32);
const opens = (s) => { const x = (BigInt(s) - sTilde + SECP_N) % SECP_N; return G.multiply(x).equals(T); };

function evmFor(txs, { trace = null } = {}) {
  const ux = {
    pool, lockScan,
    rpc: async (m, p) => {
      if (m === 'eth_getStorageAt') return '0x' + '00'.repeat(31) + '01';
      if (m === 'eth_getTransactionByHash') return txs[p[0]] || null;
      if (m === 'eth_blockNumber') return '0x20';
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + (1_700_000_000 + parseInt(p[0], 16) * 12).toString(16) };
      throw new Error('stub: ' + m);
    },
    fetchEvents: async () => Object.keys(txs).map((txHash, i) => ({ type: 'LeavesInserted', txHash, blockNumber: 30 + i, logIndex: 1 })),
    identity: () => ({ pubHex: '0x00' }), chainBindingHex: () => '0x' + '00'.repeat(32), relay: {},
  };
  return makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: new Uint8Array(32).fill(7), seed: new Uint8Array(32).fill(9), asset: '0x' + 'f0'.repeat(32), poolAddress: POOL, trace });
}

test('a claim settled through a forwarder that carries the settle is read, and its kernel is taken only when it opens the swap', async () => {
  const direct = evmFor({ '0xa': { input: settleData(lockNu, [zHex]), to: POOL.toLowerCase() } });
  assert.deepEqual(await direct.findClaim(lockNu), [zHex], 'sent straight to the pool');
  const viaFwd = { '0xa': { input: forwarded(settleData(lockNu, [zHex])), to: FWD } };
  assert.deepEqual(await evmFor(viaFwd).findClaim(lockNu, { check: opens }), [zHex], 'the same settle inside a forwarder\'s call');
  await assert.rejects(() => evmFor(viaFwd).findClaim(lockNu), /not found yet/, 'with nothing to check it by, bytes in another contract\'s call are not believed');
  // a decoy that names the lock with a kernel that opens nothing, or with none (as a refund would), is passed over: never a refund, never a lost claim
  const decoys = { '0xd1': { input: forwarded(settleData(lockNu, ['0x' + '07'.repeat(32)])), to: FWD }, '0xd2': { input: forwarded(settleData(lockNu, [])), to: FWD } };
  await assert.rejects(() => evmFor(decoys).findClaim(lockNu, { check: opens }), /not found yet/);
  assert.deepEqual(await evmFor({ ...decoys, '0xa': viaFwd['0xa'] }).findClaim(lockNu, { check: opens }), [zHex], 'the real one among decoys');
});

test('a claim settled through a contract that does not carry the settle is read from the trace of what the pool ran; a call that reverted is not', async () => {
  const txs = { '0xa': { input: scrambled(settleData(lockNu, [zHex])), to: FWD } };
  await assert.rejects(() => evmFor(txs).findClaim(lockNu, { check: opens }), /not found yet/, 'with no trace, nothing in the calldata says it');
  const ran = { '0xa': [{ to: FWD, input: txs['0xa'].input }, { to: POOL.toLowerCase(), input: settleData(lockNu, [zHex]) }] };
  const traced = [];
  const trace = async (h) => { traced.push(h); return ran[h] || []; };
  assert.deepEqual(await evmFor(txs, { trace }).findClaim(lockNu, { check: opens }), [zHex]);
  assert.deepEqual(traced, ['0xa']);
  // the tracer over a node: callTracer's tree (a reverted frame and what is under it are left out) and trace_transaction's list
  const node = (result) => async (url, o) => ({ status: 200, json: async () => { const m = JSON.parse(o.body).method; return m === 'debug_traceTransaction' ? (result.debug ? { result: result.debug } : { error: { message: 'no debug' } }) : (result.parity ? { result: result.parity } : { error: { message: 'no trace' } }); } });
  const fake = settleData(lockNu, []), real = settleData(lockNu, [zHex]);
  const tree = { to: FWD, input: '0x87654321', calls: [{ to: FWD, input: '0x01', error: 'execution reverted', calls: [{ to: POOL, input: fake }] }, { to: POOL, input: real }] };
  assert.deepEqual((await makeTxTracer({ nodes: ['n1'], fetchImpl: node({ debug: tree }) })('0xa')).map((c) => c.input), ['0x87654321', real]);
  const parity = [
    { type: 'call', traceAddress: [], action: { to: FWD, input: '0x87654321' } },
    { type: 'call', traceAddress: [0], error: 'Reverted', action: { to: FWD, input: '0x01' } },
    { type: 'call', traceAddress: [0, 0], action: { to: POOL, input: fake } },
    { type: 'call', traceAddress: [1], action: { to: POOL, input: real } },
  ];
  assert.deepEqual((await makeTxTracer({ nodes: ['n1'], fetchImpl: node({ parity }) })('0xa')).map((c) => c.input), ['0x87654321', real]);
  // a node's trace that names the lock with a kernel that opens nothing is not taken
  const lying = async () => [{ to: POOL, input: settleData(lockNu, ['0x' + '07'.repeat(32)]) }];
  await assert.rejects(() => evmFor(txs, { trace: lying }).findClaim(lockNu, { check: opens }), /not found yet/);
});

test('the Ethereum locker reads t from a claim sent through a forwarder and goes on to take the Bitcoin lock', async () => {
  const evm = evmFor({ '0xa': { input: forwarded(settleData(lockNu, [zHex])), to: FWD } });
  const rec = { id: 'aa'.repeat(36), role: 'el', phase: 'offered', created: 1_700_000_000, lock: { lockLeaf: '0x' + '11'.repeat(32), lockNu }, deadline: 4_000_000_000, evmOffer: { presign: { sTilde: '0x' + sTilde.toString(16).padStart(64, '0') } }, offer: { T: bytesToHex(T.toRawBytes(true)), btc: {} }, csvBlocks: 144 };
  const recs = new Map([[rec.id, rec]]);
  const store = { get: async (id) => recs.get(id) || null, put: async (r) => { recs.set(r.id, r); } };
  const el = makeEthereumLocker({ seed: new Uint8Array(32), store, policy: { minCsv: 72, refundMarginSecs: 600 }, quotes: { get: async () => null }, btc: {}, evm: { ...evm, now: async () => 1_700_000_100 }, counter: {}, now: () => 1_700_000_100 });
  const after = await el.step(rec);
  assert.equal(after.phase, 'taking');
  assert.equal(BigInt(after.t), t);
});

test('a lock the provider holds, spent by a claim it cannot read, is alerted after a few minutes and again every quarter hour', async () => {
  let clock = 1_800_000_000;
  const alerts = [];
  const rec = { id: 'bb'.repeat(36), role: 'el', phase: 'offered', created: clock, lock: { lockLeaf: '0x' + '11'.repeat(32), lockNu }, deadline: clock + 4 * 3600, evmOffer: { presign: { sTilde: '0x01' } }, offer: { T: bytesToHex(T.toRawBytes(true)), btc: { value: '1000' }, evm: { amount: '1000' } }, lockTxid: 'cd'.repeat(32), lockHeight: 900_000, csvBlocks: 144 };
  const swaps = memStore(); await swaps.put(rec);
  const evm = { now: async () => clock, findClaim: async () => { throw new Error('the lock is spent, and the settle that spent it is not found yet'); } };
  const svc = makeLpService({
    seed: new Uint8Array(32), btc: {}, evm, swaps, quoteStore: memStore(), now: () => clock, alert: (a) => alerts.push(a),
    config: { claimPub: '02' + '11'.repeat(32), csvBlocks: 144, quote: { btcAsset: SATS_ASSET, evmAsset: '22'.repeat(32), minAmount: 1, maxAmount: 10 ** 9, rate: () => ({ num: 1, den: 1 }) }, policy: { minConfsFor: () => 1, evmWindowSecs: 14400 } },
  });
  const unread = () => alerts.filter((a) => /claim that spent it cannot be read/.test(a.msg));
  await svc.tick();
  assert.equal(unread().length, 0, 'not at the first look: the events may only be late');
  clock += 700; await svc.tick();
  assert.equal(unread().length, 1);
  assert.equal(unread()[0].refundOpensAtHeight, 900_143, 'with when the user\'s refund opens');
  clock += 300; await svc.tick();
  assert.equal(unread().length, 1, 'not again at once');
  clock += 900; await svc.tick();
  assert.equal(unread().length, 2);
});

test('the pool lock this side builds carries a memo sealed to its key, which the key alone finds again in the pool\'s lock set', async () => {
  const priv = new Uint8Array(32).fill(7), ASSET = 'ab'.repeat(32), leaf = '0x' + 'e1'.repeat(32);
  const note = { leaf: '0x' + '01'.padStart(64, '0'), value: '1000', root: '0x00', cx: '0x01', cy: '0x02', owner: '0x03', blinding: '0x04', leafIndex: 1, path: [], secret: '0x05' };
  const txs = {};
  const ux = {
    pool: { leaf: () => '0x00', nullifier: (l) => l }, lockScan, identity: () => ({ pubHex: '03' }), chainBindingHex: () => '0x00',
    balance: async () => ({ byAsset: { ['0x' + ASSET]: { notes: [note] } } }),
    rpc: async (m, p) => (m === 'eth_getTransactionByHash' ? txs[p[0]] || null : null),
    fetchEvents: async () => [{ type: 'LockLeavesInserted', firstLockIndex: 0, lockLeaves: [leaf], txHash: '0xl', blockNumber: 1, logIndex: 0 }],
  };
  const adaptor = { buildAdaptorLock: (a) => ({ lockLeaf: leaf, nCx: a.nNote.cx, nCy: a.nNote.cy, locker: a.nNote.owner }) };
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: priv, seed: new Uint8Array(32), asset: ASSET, poolAddress: POOL, adaptor });
  const offer = { v: 1, swapId: 'aa'.repeat(36), T: bytesToHex(T.toRawBytes(true)), btc: { asset: SATS_ASSET, value: '100539', txid: 'cd'.repeat(32), vout: 0, csvBlocks: 96, lockerXonly: '22'.repeat(32) }, evm: { asset: ASSET, amount: '1000', recipient: '33'.repeat(32), rOut: '44'.repeat(32) } };
  const built = await evm.lockOp({ rec: { id: offer.swapId, offer }, rEvmLock: 5n, T, deadline: 1_800_014_400, recipient: '0x' + '33'.repeat(32), refundXonly: new Uint8Array(32).fill(2) });
  const memo = built.op.lockMemos[0];
  assert.equal(strip(memo).length / 2, 322, 'the size of a stealth lock\'s memo with its sender\'s tail');
  assert.equal(openLockMemo({ hmacSha256, key: lockMemoKey({ hmacSha256, walletPriv: new Uint8Array(32).fill(8) }), memo }), null, 'another key opens nothing');
  txs['0xl'] = { input: '0x717fd7f2' + args3({ publicValues: publicValues({ lockLeaves: [leaf] }), proof: '0x00', memos: [memo] }), to: POOL };
  const found = await makeOwnLockFinder({ ux, hmacSha256, walletPriv: priv })();
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].swapId, found[0].lockLeaf, found[0].deadline, found[0].btc.txid, found[0].btc.value, found[0].btc.rLock, found[0].evm.amount, found[0].evm.rOut, found[0].T], [offer.swapId, leaf, 1_800_014_400, offer.btc.txid, '100539', null, '1000', offer.evm.rOut, offer.T]);
});

// ── the pair world ──
const mine = (w, n = 1) => w.btc.mine(n);
async function stepAll(w, pairs, { lp = true } = {}) {
  await w.providerFeed.refresh().catch(() => {}); await w.clientFeed.refresh().catch(() => {});
  if (lp) { await w.fwd.tick(); await w.rev.tick(); }
  for (const p of pairs) await p.pump();
  w.evm.process();
}

test('one Bitcoin lock of a provider is answered once: a second ad that hands back the same lock is refused, and the user locks ETH once', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0'); w.uEvm.fund(UNITS, 'inv1');
  const info = async () => (await w.discover())[0];
  const A = await info(), B = { ...(await info()), id: 'lp2', name: 'Other', ref: { kind: 'http', base: 'http://lp2' } };
  let ads = [A], swapA = null, otherRecipient = null, firstQuote = null;
  const real = async (method, path, body) => { const r = await w.rev.handle({ method, path, body }); if (path === '/reverse/quote' && !firstQuote) firstQuote = r.body; return { status: r.status, body: r.body }; };
  // the second ad: the same provider behind another name, which answers a start with the first swap and offers its lock with another recipient
  const second = async (method, path, body) => {
    if (method === 'POST' && path === '/reverse/quote') return { status: 200, body: { ...firstQuote, id: 'b'.repeat(32), created: w.clock.now(), validUntil: w.clock.now() + 600 } };
    if (method === 'POST' && path === '/reverse/start') return { status: 200, body: { ok: true, swapId: swapA } };
    const r = await real(method, path, body);
    if (method === 'GET' && /\/offer$/.test(path) && r.status === 200) return { status: 200, body: { ...r.body, evm: { ...r.body.evm, recipient: otherRecipient } } };
    return r;
  };
  otherRecipient = bytesToHex(G.multiply(12345n).toRawBytes(true).slice(1));
  const pair = w.makePair({ discover: async () => ads, reverseCallFor: (ref) => (ref.base === 'http://lp2' ? second : real) });
  const q1 = await pair.quote({ dir: 'e2b', amount: UNITS });
  swapA = (await pair.start(q1)).id;
  const userLocks = () => w.evm.submitted.filter((j) => j.type === 'adaptorlock').length;
  for (let i = 0; i < 300 && userLocks() < 1; i++) { await stepAll(w, [pair]); w.clock.advance(60); if (i % 10 === 9) mine(w); }
  assert.equal(userLocks(), 1, 'the first swap locked the user\'s ETH');
  ads = [B];
  const q2 = await pair.quote({ dir: 'e2b', amount: UNITS });
  assert.equal((await pair.start(q2)).id, swapA, 'the second ad answers with the first swap');
  for (let i = 0; i < 60; i++) { await stepAll(w, [pair]); w.clock.advance(60); if (i % 10 === 9) mine(w); }
  assert.equal(userLocks(), 1, 'no second lock of ETH against the one Bitcoin lock');
  const asked = (await w.mems.get('quotes:lp2').list()).find((q) => q.swapId === swapA);
  assert.match(String(asked.gaveUp), /already answered/);
});

test('an ETH-for-Bitcoin swap is found again from the key alone: the provider claimed, and a page with nothing kept takes the sats', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const q = await w.pair.quote({ dir: 'e2b', amount: UNITS });
  await w.pair.start(q);
  const recOf = async () => (await w.mems.get('swaps:lp1').list())[0];
  for (let i = 0; i < 300 && (await recOf())?.phase !== 'offered'; i++) { await stepAll(w, [w.pair]); w.clock.advance(60); if (i % 10 === 9) mine(w); }
  const old = await recOf();
  assert.equal(old.phase, 'offered', 'the user\'s ETH is locked and the provider told');
  // the browser loses everything; the provider claims meanwhile
  for (let i = 0; i < 60 && !w.evm.lockSpent.has(old.lock.lockNu); i++) { await stepAll(w, []); w.clock.advance(60); }
  assert.ok(w.evm.lockSpent.has(old.lock.lockNu), 'the provider claimed the ETH');
  const fresh = w.makePair({ stores: { fwd: memStore(), index: memStore(), swaps: (() => { const m = new Map(); return (id) => { if (!m.has(id)) m.set(id, memStore()); return m.get(id); }; })(), quotes: () => memStore() } });
  assert.deepEqual(await fresh.records(), []);
  assert.equal(await fresh.recover(), 1, 'the lock\'s memo names the swap');
  assert.equal(await fresh.recover(), 0, 'and it is found once');
  for (let i = 0; i < 60 && (await fresh.records())[0].state !== 'done'; i++) { await stepAll(w, [fresh]); w.clock.advance(60); if (i % 5 === 4) mine(w); }
  const done = (await fresh.records())[0];
  assert.deepEqual([done.dir, done.state, done.provider], ['e2b', 'done', 'Found from your key']);
  const take = [...w.btc.txs.values()].find((e) => e.esplora.vin.some((i) => i.txid === old.lockTxid) && e.esplora.vout.some((o) => o.scriptpubkey === bytesToHex(w.uW.prims.p2wpkhScript(w.uW.wallet.pub))));
  assert.ok(take, 'the sats went to the user\'s address');
});

test('the same with no claim: the swap found from the key takes the ETH back after the deadline', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'e2b', amount: UNITS }));
  const recOf = async () => (await w.mems.get('swaps:lp1').list())[0];
  // (stopped once the lock is in the pool, before the page tells the provider: a provider that is told steps its claim at once)
  for (let i = 0; i < 300 && !['locked', 'offered'].includes((await recOf())?.phase); i++) { await stepAll(w, [w.pair]); w.clock.advance(60); if (i % 10 === 9) mine(w); }
  const old = await recOf();
  const fresh = w.makePair({ stores: { fwd: memStore(), index: memStore(), swaps: (() => { const m = new Map(); return (id) => { if (!m.has(id)) m.set(id, memStore()); return m.get(id); }; })(), quotes: () => memStore() } });
  assert.equal(await fresh.recover(), 1);
  w.clock.advance(old.deadline - w.clock.now() + 700);
  for (let i = 0; i < 30 && (await fresh.records())[0].state !== 'returned'; i++) { await stepAll(w, [fresh], { lp: false }); w.clock.advance(60); }
  assert.equal((await fresh.records())[0].state, 'returned');
  assert.ok(w.evm.lockSpent.has(old.lock.lockNu));
  assert.deepEqual(w.evm.claims.get(old.lock.lockNu), [], 'spent by the refund');
});

// the user's Bitcoin locker over the pair world's chains, speaking to the forward provider
function userLocker(w, csvBlocks) {
  const transport = async (method, path, body) => { const r = await w.fwd.handle({ method, path, body }); return { status: r.status, body: r.body }; };
  const e = w.uEvmCtx;
  return makeBitcoinLocker({ seed: w.uKeys.seed, now: w.clock.now, store: memStore(), btc: w.uBtc, evm: { now: e.now, lockPosition: e.lockPosition, recipient: e.recipient, claimOp: e.claimOp, submit: e.submit, claimStatus: e.claimStatus }, policy: { ...PAIR_POLICY, csvBlocks }, counter: makeCounter(transport) });
}
const lockFor = (w, bl, q) => bl.start({ asset: hexToBytes(SATS_ASSET), amount: BigInt(q.btcValue), counterClaimPub: hexToBytes(q.claimPub), evmAsset: q.evmAsset, evmAmount: BigInt(q.evmAmount), quoteId: q.id });
const live = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.btc-eth.render.json', import.meta.url), 'utf8')).quote;

test('with the live terms, a quote never held is not answered hours later at its old price after the market moved', async () => {
  const w = pairWorld({ fwdQuote: { validSecs: live.validSecs, graceSecs: live.graceSecs, lateSecs: live.lateSecs, lateMoveBps: live.lateMoveBps } });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = (await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } })).body;
  // 5.17 hours on, ETH is 4% cheaper against BTC: the old quote pays 4% over the market
  w.clock.advance(Math.round(5.17 * 3600));
  w.market.provider = 35.6 * 0.96; await w.providerFeed.refresh();
  assert.ok(BigInt(q.evmAmount) > w.fwd.quoter.price(SATS).evmAmount);
  const bl = userLocker(w, q.csvBlocks);
  let rec = await lockFor(w, bl, q);
  rec = await bl.step(rec);
  mine(w);
  rec = await bl.step(rec);
  assert.equal(rec.phase, 'refund-wait');
  assert.match(rec.why, /quote expired/);
  assert.deepEqual(await w.stores.lp.list(), [], 'the provider took on nothing');
});

test('past the short grace, a lock seen in time is still answered while the market holds, and refused once it has moved too far', async () => {
  for (const [move, answered] of [[0.995, true], [0.96, false]]) {
    const w = pairWorld({ fwdQuote: { validSecs: 300, graceSecs: 900, lateSecs: 21600, lateMoveBps: 100 } });
    await w.ready();
    w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
    const q = (await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } })).body;
    assert.equal((await w.fwd.handle({ method: 'POST', path: '/reserve', body: { quoteId: q.id } })).body.ok, true);
    const bl = userLocker(w, q.csvBlocks);
    let rec = await lockFor(w, bl, q);
    rec = await bl.step(rec);                                       // broadcast, and named to the provider (its hold, and the time it saw the lock)
    rec = await bl.step(rec);
    assert.equal(rec.extended, true);
    // the lock waits three hours for a block (a low fee), past the hold
    w.clock.advance(3 * 3600);
    w.market.provider = 35.6 * move; await w.providerFeed.refresh();
    mine(w, 1);
    rec = await bl.step(rec);
    if (answered) assert.equal(rec.phase, 'offered', `moved ${move}: answered`);
    else { assert.equal(rec.phase, 'refund-wait', `moved ${move}: refused`); assert.match(rec.why, /quote expired/); }
  }
  // and a lock never seen in time (no hold, confirmed late) is not answered late even at the same price
  const w = pairWorld({ fwdQuote: { validSecs: 300, graceSecs: 900, lateSecs: 21600, lateMoveBps: 100 } });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = (await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } })).body;
  w.clock.advance(3600);
  const bl = userLocker(w, q.csvBlocks);
  let rec = await bl.step(await lockFor(w, bl, q));
  mine(w); rec = await bl.step(rec);
  assert.match(rec.why || '', /quote expired/);
});

test('the reverse side of a pair provider takes one lock at a time from one key', async () => {
  assert.equal(pairReverseOptions({ reverse: { enabled: true, maxSats: '1000000', maxOpen: 2, lockFeeReserve: '2000', minAmount: '1', maxAmount: '2', feeBps: 0, flatFee: '0' }, policy: {} }, { rate: () => null }).maxOpenPerKey, 1);
  const w = pairWorld({ revConfig: { maxOpenPerKey: 1 }, revCoins: [2_000_000, 2_000_000] });
  await w.ready();
  const claimPub = bytesToHex(w.uBtc.wallet.pub);
  const ask = async () => (await w.rev.handle({ method: 'POST', path: '/reverse/quote', body: { amount: String(UNITS), claimPub } })).body;
  const first = await w.rev.handle({ method: 'POST', path: '/reverse/start', body: { quoteId: (await ask()).id } });
  assert.equal(first.body.ok, true);
  const second = await w.rev.handle({ method: 'POST', path: '/reverse/start', body: { quoteId: (await ask()).id } });
  assert.equal(second.body.ok, false);
  assert.match(second.body.why, /already has a send under way/);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} swap guard checks passed`);
process.exit(process.exitCode || 0);
