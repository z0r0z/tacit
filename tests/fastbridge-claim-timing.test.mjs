// The swap of sats for pool ETH around its claim: how a claim is read when its transaction does not carry it as it is, what the Bitcoin locker does with its own
// claim before and after its timelock, which explorers a lock of ETH waits for, which clock and lock set a claim is built on, and how much work one settle's
// calldata can ask of a claim read.
//   node tests/fastbridge-claim-timing.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import * as adaptor from '../dapp/adaptor-signature.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../dapp/adaptor-btc-tx.js';
import { makeBitcoinLocker } from '../dapp/fastbridge-bl.js';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import { makeFastBridgeEvm, makeTxTracer, poolCallsTracer } from '../dapp/fastbridge-evm.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
import { makeConfidentialLockScan } from '../dapp/confidential-lock-scan.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { G, SECP_N, bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes, secp, keccak_256, sha256 as dsha, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { te, scalar, fetched } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool as simPool, sha256, ASSET } from './lib/chain-sim.mjs';
import { memStore } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const SATS = 100_000n, OUT = 3_700_000n, CSV = 144;

// ── the simulated chains: the Bitcoin locker (it holds t, locks sats and claims the pool lock) and the Ethereum locker (it locks pool ETH and takes the sats with t).
// In a swap of BTC for ETH the first is the user's page and the second the provider; in a swap of ETH for BTC the provider is the first and the user's page the second.
function satsWorld() {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const blW = wallet('bl'), elW = wallet('el');
  const blKeys = partyKeys('bl'), elKeys = partyKeys('el');
  const blEvm = makeEvmParty({ evm, keys: blKeys, clock }), elEvm = makeEvmParty({ evm, keys: elKeys, clock });
  elEvm.fund(OUT, 'inv0');
  let coinN = 0;
  const coin = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];
  const blBtc = btc.adapter({ prims: blW.prims, builder: makeAdaptorBtcTx({ prims: blW.prims }), sats: coin });
  const elBtc = btc.adapter({ prims: elW.prims, builder: makeAdaptorBtcTx({ prims: elW.prims }), sats: coin });
  elBtc.resolveNote = async () => { throw new Error('no note'); };
  elBtc.crossLaneBlocked = async () => { throw new Error('no note'); };
  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, findClaim: evm.findClaim, lockNullifier: simPool.nullifier };
  const blCtx = { now: evm.now, lockPosition: evm.lockPosition, recipient: blEvm.recipient, claimOp: blEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus, findClaim: evm.findClaim, lockNullifier: simPool.nullifier };
  const elCtx = { ...base, lockOp: elEvm.lockOp, refundOp: elEvm.refundOp, refundKey: elEvm.refundKey, available: elEvm.available };
  const quote = { id: 'q1', btcAsset: X.SATS_ASSET, btcValue: SATS, evmAsset: ASSET, evmAmount: OUT, validUntil: clock.now() + 3600 };
  const offers = new Map();
  const w = { clock, btc, evm, blW, elW, blKeys, blBtc, elBtc, blCtx, elCtx, blStore: memStore(), elStore: memStore(), blUp: true, elUp: true };
  const toEl = { sendOffer: async (msg) => w.el.receive(msg), getEvmOffer: async (id) => offers.get(id) || null };
  const toBl = { publishEvmOffer: async (id, o) => { offers.set(id, o); } };
  w.bl = makeBitcoinLocker({ seed: blKeys.seed, now: clock.now, policy: { csvBlocks: CSV, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 }, store: w.blStore, btc: blBtc, evm: blCtx, counter: toEl });
  w.el = makeEthereumLocker({ seed: elKeys.seed, now: clock.now, policy: { minCsv: 72, minConfsFor: () => 1, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, minAmount: 20_000, maxAmount: 10_000_000, roundSecs: 600 }, store: w.elStore, quotes: { get: async (id) => (id === quote.id ? quote : null) }, btc: elBtc, evm: elCtx, counter: toBl });
  w.blRec = async () => (await w.blStore.list())[0];
  w.elRec = async () => (await w.elStore.list())[0];
  w.start = () => w.bl.start({ asset: hexToBytes(X.SATS_ASSET), amount: SATS, counterClaimPub: elW.wallet.pub, evmAsset: ASSET, evmAmount: OUT, quoteId: quote.id });
  w.step = async () => {
    if (w.blUp) for (const r of await w.blStore.list()) await w.bl.step(r);
    if (w.elUp) for (const r of await w.elStore.list()) await w.el.step(r);
    evm.process();
  };
  let ticks = 0;
  w.run = async (until, max = 4000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: bl ' + JSON.stringify(await w.blRec()).slice(0, 400) + ' el ' + JSON.stringify(await w.elRec()).slice(0, 400));
  };
  w.lockOf = (rec, T) => deriveLock({ prims: blW.prims, claimerPub: elW.wallet.pub, T, lockerXonly: blW.prims.wallet.xonly(), csvBlocks: CSV });
  return w;
}
const p2wpkh = (wl) => bytesToHex(wl.prims.p2wpkhScript(wl.prims.wallet.pub));

// ── the pool side, read as the page and the provider read it ──
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256: dsha });
const lockScan = makeConfidentialLockScan({ pool });
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytes32 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const encBytes = (h) => { const b = String(h).replace(/^0x/, ''); return word(b.length / 2) + b + '0'.repeat((64 - (b.length % 64)) % 64); };
const encB32Arr = (items) => word(items.length) + items.map(bytes32).join('');
const encBytesArr = (items) => { const e = items.map(encBytes); let off = items.length * 32, head = ''; for (const x of e) { head += word(off); off += x.length / 2; } return word(items.length) + head + e.join(''); };
const sel = (sig) => hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const tuple = ({ publicValues, proof, memos }) => { const a = encBytes(publicValues), b = encBytes(proof), c = encBytesArr(memos); const o1 = 96, o2 = o1 + a.length / 2, o3 = o2 + b.length / 2; return word(o1) + word(o2) + word(o3) + a + b + c; };
const settle = (c) => '0x' + sel('settle(bytes,bytes,bytes[])') + tuple(c);
function publicValues({ lockNullifiers, adaptorClaimS }) {
  const z32 = bytes32('0x' + '00'.repeat(32));
  const dyn = (enc) => ({ dyn: enc });
  const F = [{ st: word(1) }, { st: z32 }, { st: z32 }, dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(word(0)), dyn(word(0)), dyn(encB32Arr([])), dyn(word(0)), dyn(encB32Arr([])),
    { st: z32 }, { st: z32 }, dyn(word(0)), dyn(word(0)), { st: word(0) }, { st: z32 }, dyn(encB32Arr([])), dyn(encB32Arr(lockNullifiers)), dyn(encB32Arr(adaptorClaimS)), { st: word(0) }];
  let head = '', tail = '', pos = F.length * 32;
  for (const f of F) { if (f.st != null) head += f.st; else { head += word(pos); tail += f.dyn; pos += f.dyn.length / 2; } }
  return '0x' + word(32) + head + tail;
}
const t = 0x1234567890abcdefn % SECP_N, T = G.multiply(t);
const sTilde = 0xabcdef0123456789n % SECP_N;
const zReal = '0x' + ((sTilde + t) % SECP_N).toString(16).padStart(64, '0');
const lockNu = '0x' + 'ab'.repeat(32);
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const WRAPPER = '0x' + '5e'.repeat(20);
const realClaim = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: [zReal] }), proof: '0x' + 'cc'.repeat(32), memos: [] };

function makeEvm(txs, { relayStatus = null, trace = null, selfSettle = null, clock = () => Date.now(), prove = null, onUnread = null, quorum = null, latest = null, lockSet = null } = {}) {
  const byHash = new Map(txs.map((x) => [x.hash, x]));
  const ux = {
    pool, lockScan,
    rpc: async (m, p) => {
      if (m === 'eth_getStorageAt') return '0x' + '00'.repeat(31) + '01';
      if (m === 'eth_getTransactionByHash') { const x = byHash.get(p[0]); return x ? { input: x.input, to: x.to } : null; }
      if (m === 'eth_getTransactionReceipt') { const x = byHash.get(p[0]); return x ? { status: '0x1', blockNumber: '0x30', logs: [] } : null; }
      if (m === 'eth_blockNumber') return '0x100';
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + (p[0] === 'latest' && latest != null ? latest : 1_700_000_000 + (p[0] === 'latest' ? 256 : parseInt(p[0], 16)) * 12).toString(16) };
      throw new Error('stub: ' + m);
    },
    fetchEvents: async () => txs.map((x, i) => ({ type: 'NullifiersSpent', txHash: x.hash, blockNumber: 30 + i, logIndex: 1 })),
    identity: () => ({ pubHex: '0x00' }), chainBindingHex: () => '0x' + '00'.repeat(32), stealthLockPosition: async (a) => (lockSet ? lockSet(a) : null),
    relay: { status: async () => ({ status: relayStatus }), prove: prove || (async () => ({ publicValues: '0x01', proof: '0x02' })), state: async () => ({ state: 'ok' }) },
  };
  return makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(dsha, k, m), walletPriv: new Uint8Array(32).fill(7), seed: new Uint8Array(32).fill(9), asset: '0x' + 'f0'.repeat(32), poolAddress: POOL, trace, selfSettle, clock, onUnread, quorum });
}
const elAt = (evm) => {
  const recs = new Map();
  const rec = { id: 'aa'.repeat(36), role: 'el', phase: 'offered', created: 1_700_000_000, lock: { lockLeaf: '0x' + '11'.repeat(32), lockNu }, deadline: 4_000_000_000, evmOffer: { presign: { sTilde: '0x' + sTilde.toString(16).padStart(64, '0') } }, offer: { T: hex(T.toRawBytes(true)), btc: {} }, csvBlocks: 144, lockHeight: 100, lockTxid: '55'.repeat(32) };
  recs.set(rec.id, rec);
  const store = { get: async (id) => recs.get(id) || null, put: async (r) => { recs.set(r.id, r); } };
  const btc = { status: async () => ({ confirmations: 20, height: 100 }), tip: async () => 120 };
  const el = makeEthereumLocker({ seed: new Uint8Array(32), store, policy: { minCsv: 72, refundMarginSecs: 600 }, quotes: { get: async () => null }, btc, evm: { ...evm, now: async () => 1_700_000_100 }, counter: {}, now: () => 1_700_000_100 });
  return { step: () => el.step(recs.get(rec.id)), rec: () => recs.get(rec.id) };
};
// A node that answers debug_traceTransaction with a tracer of its own (the calls to the pool) and refuses every other form, as a node does with a transaction whose
// whole call tree is too large to send
const rpcOk = (result) => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result }), status: 200 });
const rpcNo = (message) => ({ json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }), status: 200 });

// ── 1. A claim sent through a contract that carries it in a form of its own ──
// The claim is settled from a contract of the claimer's that takes the settle's calldata xored with one byte: nothing in the transaction's input decodes as a settle,
// the pool emits no kernel, and the only place z shows is the pool's own call in the trace.
const hidden = '0x' + 'c0ffee00' + strip(settle(realClaim)).match(/../g).map((b) => (parseInt(b, 16) ^ 0x5a).toString(16).padStart(2, '0')).join('');
test('a claim settled through a contract that carries it in a form of its own is read from a trace of the calls made to the pool, where a node refuses the whole call tree', async () => {
  assert.equal(lockScan.decodeSettleCalls(hidden), null, 'the input says nothing a page can read');
  const tx = { hash: '0x' + '01'.repeat(32), to: WRAPPER, input: hidden };
  const asked = [];
  const node = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    asked.push([url, method, params[1] && typeof params[1].tracer === 'string' && params[1].tracer.length > 40 ? 'pool calls' : params[1] && params[1].tracer]);
    if (method === 'debug_traceTransaction' && params[1] && /enter: function/.test(params[1].tracer)) return url === 'https://own' ? rpcOk([{ to: POOL.toLowerCase(), input: settle(realClaim) }]) : rpcNo('the method is not available');
    return rpcNo('response size exceeded');
  };
  const tracer = makeTxTracer({ nodes: ['https://public', 'https://own'], fetchImpl: node, pool: POOL });
  const traced = elAt(makeEvm([tx], { trace: tracer }));
  assert.equal((await traced.step()).phase, 'taking', 'with the pool\'s own call, t');
  assert.equal(traced.rec().t, '0x' + t.toString(16).padStart(64, '0'));
  assert.deepEqual(asked.filter(([u]) => u === 'https://own').map(([, m, k]) => [m, k]), [['debug_traceTransaction', 'pool calls']], 'the node of one\'s own answered the first form');
});

test('the tracer of calls to the pool keeps only plain calls that ran: a call under a frame that reverted, and a delegatecall into the pool\'s code, are left out', async () => {
  const toHex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const addr = (h) => hexToBytes(strip(h));
  const tracer = new Function('toHex', `return (${poolCallsTracer(POOL)});`)(toHex);
  const frame = (type, to, input) => ({ getType: () => type, getTo: () => addr(to), getInput: () => hexToBytes(input) });
  const ok = { getError: () => undefined }, failed = { getError: () => 'execution reverted' };
  tracer.enter(frame('CALL', POOL, 'aa01')); tracer.exit(ok);                                 // runs
  tracer.enter(frame('DELEGATECALL', POOL, 'aa02')); tracer.exit(ok);                         // the pool's code, not the pool
  tracer.enter(frame('CALL', WRAPPER, 'bb')); tracer.enter(frame('CALL', POOL, 'aa03')); tracer.exit(ok); tracer.exit(failed);   // undone with its caller
  tracer.enter(frame('CALL', WRAPPER, 'bb')); tracer.enter(frame('CALL', POOL, 'aa04')); tracer.exit(ok); tracer.exit(ok);       // runs, one level down
  const out = tracer.result({ type: 'CALL', to: addr(WRAPPER), input: hexToBytes('cc'), error: undefined });
  assert.deepEqual(out.map((c) => c.input), ['0xaa01', '0xaa04']);
  assert.ok(out.every((c) => c.to === POOL.toLowerCase()));
  const top = new Function('toHex', `return (${poolCallsTracer(POOL)});`)(toHex);
  assert.deepEqual(top.result({ type: 'CALL', to: addr(POOL), input: hexToBytes('dd'), error: undefined }).map((c) => c.input), ['0xdd'], 'a transaction sent to the pool itself');
  const gone = new Function('toHex', `return (${poolCallsTracer(POOL)});`)(toHex);
  gone.enter(frame('CALL', POOL, 'aa05')); gone.exit(ok);
  assert.deepEqual(gone.result({ type: 'CALL', to: addr(WRAPPER), input: hexToBytes('cc'), error: 'execution reverted' }), [], 'a transaction that failed ran nothing');
});

test('while no node traces the transaction a claim may be in, the lock stays unread, the trace is asked again less often, and the operator is told with the transaction', async () => {
  const tx = { hash: '0x' + '01'.repeat(32), to: WRAPPER, input: hidden };
  let ms = 1_000_000, tries = 0;
  const told = [];
  const evm = makeEvm([tx], { clock: () => ms, trace: async () => { tries++; throw new Error('execution timeout'); }, onUnread: (o) => told.push(o) });
  const none = elAt(evm);
  for (let i = 0; i < 20; i++) { await none.step(); ms += 1000; }
  assert.equal(none.rec().phase, 'offered');
  assert.match(none.rec().lastError || '', /settle that spent it is not found/);
  assert.equal(none.rec().t, undefined);
  assert.ok(tries >= 2 && tries <= 4, `asked again with a growing wait, not on every look (${tries} tries in 20 s)`);
  assert.equal(told.length, 1, 'said once, not on every look');
  assert.deepEqual([told[0].level, told[0].tx, told[0].lock], ['alert', tx.hash, lockNu]);
  assert.match(told[0].msg, /FB_LP_TRACE_RPCS/);
  ms += 31 * 60 * 1000;
  await none.step();
  assert.equal(told.length, 2, 'and again half an hour on while it stays unread');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} claim timing checks passed`);
process.exit(process.exitCode || 0);
