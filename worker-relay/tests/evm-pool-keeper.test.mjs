// EVM pool box keeper (src/evm-pool-keeper.js) against a mocked router/pool and a stub prover: config and signer
// isolation, intake validation and body caps, leaf sync, and the completion loop (stale-root re-proving,
// profitability, wraps, expiry and reclaim). The real prover path is tests/evm-pool-keeper-prover.test.mjs.
//   node worker-relay/tests/evm-pool-keeper.test.mjs

import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { keccak_256 } from '../../dapp/vendor/tacit-deps.min.js';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { encodeAbiParameters, keccak256 as viemKeccak, encodeFunctionData, decodeFunctionData, toHex, createPublicClient, http as viemHttp } from 'viem';
import { depositIntent, receiveRho, receiveKeys, callIntent, callIntentJson, callEscrowAddress, v1ZapShieldedNoteCall } from '../../dapp/evm-pool-gateway.js';
import { ROUTER_ABI, frontFees, makeKeeperChain, readerFor } from '../src/lib/evm-pool-keeper-chain.js';
import { loadKeeperConfig, checkKeeperSigner, parseTokenMap, RELAY_EOA } from '../src/lib/evm-pool-keeper-config.js';
import { openKeeperStore } from '../src/lib/evm-pool-keeper-store.js';
import { makeLeafSync, makeFactsSync, LeafSyncError, ChunkNotKept, CatchingUp, FACT_KEYS } from '../src/lib/evm-pool-keeper-leaves.js';
import { createIntakeHandler, parseDepositSubmission, parseWrapSubmission, parseReceiveSubmission, parseRelaySubmission, ipKey } from '../src/lib/evm-pool-keeper-intake.js';
import { createKeeper, coverCheck, quoteFee, receiveMinOf, receiveFloorOf, subsidyOf, subsidyRoom, absorbed, sweepGasOf, forgetSweepGas, reclaimWorth } from '../src/lib/evm-pool-keeper-loop.js';
import { loadZk } from '../src/lib/evm-pool-keeper-prover.js';
import { makeForwarder } from '../src/lib/evm-pool-forwarder.js';
import { makeSealedGateway, makeServiceGateway } from '../src/lib/evm-pool-keeper-sealed.js';
import { makeTokenBucket, clientKey } from '../src/lib/token-bucket.js';
import { gatewayKeys, sealRequest, makeSealedFetch } from '../../dapp/sealed-request.js';

const zk = await loadZk();
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const CHAIN_ID = 1;
const POOL = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const KEEPER = '0x4444444444444444444444444444444444444444';
const REFUND = '0x5555555555555555555555555555555555555555';
const V1 = '0x6666666666666666666666666666666666666666';
const WRAP_TOKEN = '0x7777777777777777777777777777777777777777';
const ETH = '0x0000000000000000000000000000000000000000';
const ASSET_ID = '0x' + 'a1'.repeat(32);
const assetField = poolAsset({ chainId: BigInt(CHAIN_ID), pool: POOL, token: TOKEN });
const T0 = 1_800_000_000;
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

const baseEnv = {
  EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: 'http://127.0.0.1:1',
  EVM_POOL_KEEPER_MIN_FEES: `${TOKEN}:10,${WRAP_TOKEN}:5`,
};
const mkCfg = (over = {}) => ({ ...loadKeeperConfig(baseEnv), pollSecs: 10, maxBackoffSecs: 100, ...over });

const alice = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
const sOut = (i) => Uint8Array.from([2, i, ...new Uint8Array(31).fill(0x60 + i)]);
const outTo = (v, i) => { const o = zk.outputKeys(alice.A, alice.N, sOut(i)); return { v, npk: o.npk, rho: o.rho }; };

// A deposit intent and its HTTP body. fee = amount − Σ v.
function makeDeposit({ amount = 1000n, vs = [600n, 300n], memo0 = '0xa11ce0', memo1 = '0x', deadline = T0 + 3600, nonce = 0n } = {}) {
  const outputs = vs.map((v, i) => (v === null ? null : outTo(v, i)));
  const { intent, hint } = depositIntent(zk, { asset: assetField, amount, outputs, memo0, memo1, refund: REFUND, deadline, nonce });
  const s = (x) => x.toString();
  const body = {
    intent: { amount: s(intent.amount), outLeaf0: s(intent.outLeaf0), outLeaf1: s(intent.outLeaf1), memo0Hash: intent.memo0Hash, memo1Hash: intent.memo1Hash, refund: intent.refund, deadline: s(intent.deadline), nonce: s(intent.nonce) },
    hint: { outputs: hint.outputs.map((o) => (o ? { v: s(o.v), npk: s(o.npk), rho: s(o.rho) } : null)), memo0: hex(hint.memo0), memo1: hex(hint.memo1) },
  };
  return { intent, hint, body };
}
const makeWrap = ({ amount = 5000n, tip = 50n, deadline = T0 + 3600, nonce = 0n } = {}) => ({
  intent: { assetId: ASSET_ID, amount: amount.toString(), tip: tip.toString(), commit: '0x' + 'c0'.repeat(32), refund: REFUND, deadline: String(deadline), nonce: String(nonce) },
});

const revert = (name) => Object.assign(new Error(`The contract function reverted with the following reason: ${name}()`), { shortMessage: `reverted: ${name}()` });

// Router + pool + tokens in memory. Completion re-checks what the router and pool check on chain.
function mockChain({ log = [] } = {}) {
  const c = {
    address: KEEPER, chainId: CHAIN_ID, pool: POOL, router: ROUTER, asset: TOKEN, v1: V1,
    leaves: [], events: [], block: 100n, balances: new Map(), gas: 1n, sent: [], estimates: 0,
    receiptMode: 'success', beforeEstimate: null, estimateError: null, receipts: new Map(),
  };
  const key = (t, h) => `${t.toLowerCase()}:${h.toLowerCase()}`;
  c.fund = (token, box, v) => c.balances.set(key(token, box), (c.balances.get(key(token, box)) || 0n) + BigInt(v));
  c.boxOf = (tag, intent) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(tag + JSON.stringify(intent, (_, v) => (typeof v === 'bigint' ? v.toString() : v))))).subarray(12).toString('hex');
  c.depositBoxOf = async (i) => c.boxOf('d', i);
  c.wrapBoxOf = async (i) => c.boxOf('w', i);
  c.counts = new Map();
  c.receiveBoxOf = async (npk, feeBps) => c.boxOf('r', { npk: BigInt(npk), feeBps: Number(feeBps) });
  c.receiveCount = async (box) => BigInt(c.counts.get(box.toLowerCase()) || 0);
  c.wrapToken = async (assetId) => ({ registered: assetId === ASSET_ID, token: WRAP_TOKEN });
  c.balanceOf = async (token, holder) => c.balances.get(key(token, holder)) || 0n;
  c.gasPrice = async () => c.gas;
  c.blockNumber = async () => c.block;
  // The pool's state at `blockNumber` (the head when none is given): the leaves its events up to there inserted.
  c.poolState = async (blockNumber) => {
    const at = blockNumber === undefined ? c.block : BigInt(blockNumber);
    const n = c.events.filter((e) => e.blockNumber <= at && (e.outLeaf0 !== 0n || e.outLeaf1 !== 0n)).length * 2;
    return { root: zk.tree(c.leaves.slice(0, n)).root, nextIndex: BigInt(n) };
  };
  c.transactLogs = async (from, to) => c.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
  c.foreignTx = () => {
    const firstIndex = BigInt(c.leaves.length);
    const pair = [BigInt(c.leaves.length + 1) * 7919n, 0n];
    c.leaves.push(...pair);
    c.block += 1n;
    c.events.push({ firstIndex, outLeaf0: pair[0], outLeaf1: pair[1], blockNumber: c.block });
  };
  const insert = (pub) => {
    const firstIndex = BigInt(c.leaves.length);
    c.leaves.push(pub[9], pub[10]);
    assert.equal(zk.tree(c.leaves).root, pub[2], 'newRoot must be the root after insertion');
    c.block += 1n;
    c.events.push({ firstIndex, outLeaf0: pub[9], outLeaf1: pub[10], blockNumber: c.block });
  };
  const exec = (functionName, args) => {
    if (functionName === 'sweepReceive') {
      const [npk, feeBps, t] = args;
      const box = c.boxOf('r', { npk, feeBps });
      const amount = t.extAmount;
      if (amount <= 0n || t.recipient !== ETH || t.memo0 !== '0x' || t.memo1 !== '0x' || t.publicInputs[10] !== 0n) throw revert('BadIntent');
      if (t.fee * 10000n > amount * BigInt(feeBps)) throw revert('BadIntent');
      const n = BigInt(c.counts.get(box) || 0);
      if (t.publicInputs[9] !== zk.leafOf(assetField, amount - t.fee, npk, receiveRho(box, n))) throw revert('BadIntent');
      if (t.publicInputs[1] !== zk.tree(c.leaves).root) throw revert('StaleRoot');
      if (t.publicInputs[3] !== BigInt(c.leaves.length)) throw revert('WrongInsertionIndex');
      if ((c.balances.get(key(TOKEN, box)) || 0n) !== amount) throw revert('BadIntent');
      return () => {
        c.balances.set(key(TOKEN, box), 0n);
        c.counts.set(box, Number(n) + 1);
        insert(t.publicInputs);
        c.fund(TOKEN, t.relayer, t.fee);
      };
    }
    if (functionName === 'pool.transact') {
      const [, , , pub, recipient, ext, relayer, fee] = args;
      if (c.transactRevert) throw revert(c.transactRevert);
      const inserts = pub[9] !== 0n || pub[10] !== 0n;
      if (inserts && pub[1] !== zk.tree(c.leaves).root) throw revert('StaleRoot');
      return () => {
        if (inserts) insert(pub);
        if (ext < 0n) c.fund(TOKEN, recipient, -ext);
        c.fund(TOKEN, relayer, fee);
      };
    }
    if (functionName === 'withdrawAndCall' || functionName === 'withdrawToV1') {
      const [t, intent] = args;
      const box = functionName === 'withdrawAndCall' ? callEscrowAddress(intent, ROUTER) : c.boxOf('w', intent);
      if (t.extAmount >= 0n || t.recipient.toLowerCase() !== box.toLowerCase()) throw revert('BadIntent');
      if (c.callRevert) throw revert(c.callRevert);
      return () => { c.fund(TOKEN, t.relayer, t.fee); c.fund(TOKEN, box, -t.extAmount); };
    }
    const [intent, t] = args;
    if (functionName === 'completeDeposit') {
      const box = c.boxOf('d', intent);
      if (t.extAmount !== intent.amount || t.recipient !== ETH) throw revert('BadIntent');
      if (t.publicInputs[9] !== intent.outLeaf0 || t.publicInputs[10] !== intent.outLeaf1) throw revert('BadIntent');
      if (hex(keccak_256(Buffer.from(t.memo0.slice(2), 'hex'))) !== intent.memo0Hash) throw revert('BadIntent');
      if (t.publicInputs[1] !== zk.tree(c.leaves).root) throw revert('StaleRoot');
      if (t.publicInputs[3] !== BigInt(c.leaves.length)) throw revert('WrongInsertionIndex');
      if ((c.balances.get(key(TOKEN, box)) || 0n) < intent.amount) throw revert('TransferFailed');
      return () => {
        c.balances.set(key(TOKEN, box), c.balances.get(key(TOKEN, box)) - intent.amount);
        const firstIndex = BigInt(c.leaves.length);
        c.leaves.push(t.publicInputs[9], t.publicInputs[10]);
        assert.equal(zk.tree(c.leaves).root, t.publicInputs[2], 'newRoot must be the root after insertion');
        c.block += 1n;
        c.events.push({ firstIndex, outLeaf0: t.publicInputs[9], outLeaf1: t.publicInputs[10], blockNumber: c.block });
        c.fund(TOKEN, t.relayer, t.fee);
      };
    }
    if (functionName === 'completeWrap') {
      const box = c.boxOf('w', intent);
      const need = intent.amount + intent.tip;
      if ((c.balances.get(key(WRAP_TOKEN, box)) || 0n) < need) throw revert('TransferFailed');
      return () => { c.balances.set(key(WRAP_TOKEN, box), c.balances.get(key(WRAP_TOKEN, box)) - need); c.fund(WRAP_TOKEN, KEEPER, intent.tip); };
    }
    if (functionName === 'reclaimDeposit' || functionName === 'reclaimWrap') {
      const [tok, box] = functionName === 'reclaimDeposit' ? [t, c.boxOf('d', intent)] : [WRAP_TOKEN, c.boxOf('w', intent)];
      if (T0 + c.elapsed <= Number(intent.deadline)) throw revert('NotExpired');
      const bal = c.balances.get(key(tok, box)) || 0n;
      if (bal === 0n) throw revert('NothingToReclaim');
      return () => { c.balances.set(key(tok, box), 0n); c.fund(tok, intent.refund, bal); };
    }
    throw new Error(`unexpected ${functionName}`);
  };
  c.elapsed = 0;
  c.estimate = async (functionName, args) => {
    c.estimates++;
    if (c.beforeEstimate) c.beforeEstimate();
    if (c.estimateError) throw c.estimateError;
    exec(functionName, args);
    return functionName === 'completeDeposit' || functionName === 'sweepReceive' ? 400000n : functionName === 'pool.transact' ? 350000n : 150000n;
  };
  c.send = async (functionName, args, { gas }) => {
    const apply = exec(functionName, args);
    const hash = '0x' + String(c.sent.length + 1).padStart(64, '0');
    c.sent.push({ functionName, args, gas, hash });
    if (c.receiptMode !== 'revert') apply();
    c.receipts.set(hash, { status: c.receiptMode === 'revert' ? 'reverted' : 'success' });
    log.push(`sent ${functionName}`);
    return hash;
  };
  c.waitReceipt = async (hash) => (c.receiptMode === 'pending' ? null : c.receipts.get(hash));
  c.receipt = async (hash) => c.receipts.get(hash) || null;
  return c;
}

// Returns the public inputs the witness implies, as a real proof would.
function stubProver({ onProve } = {}) {
  const p = { calls: 0 };
  p.prove = async (input) => {
    p.calls++;
    const pub = [input.root, input.oldRoot, input.newRoot, input.startIndex, input.publicAmount, input.extDataHash, input.asset, ...input.nf, ...input.outLeaf].map(BigInt);
    if (onProve) onProve(p.calls);
    return { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n], publicInputs: pub };
  };
  return p;
}

function setup({ cfg: over = {}, onProve } = {}) {
  const cfg = mkCfg({ confirmations: 2n, ...over });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const prover = stubProver({ onProve: onProve && ((k) => onProve(k, chain)) });
  const clock = { t: T0 };
  chain.elapsed = 0;
  const now = () => clock.t;
  const leafSync = makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: cfg.confirmations, logChunk: 5n });
  const logs = [];
  const keeper = createKeeper({ store, chain, prover, zk, assetField, leafSync, cfg, now, log: (m) => logs.push(m) });
  const advance = (s) => { clock.t += s; chain.elapsed += s; };
  const add = (kind, parsed, box, token) => store.addIntent({ box, kind, intent: parsed.intent, hint: parsed.hint ?? null, reward: parsed.reward, token, deadline: parsed.intent.deadline, now: clock.t });
  return { cfg, store, chain, prover, keeper, clock, advance, add, logs, leafSync };
}
async function addDeposit(s, opts) {
  const d = makeDeposit(opts);
  const parsed = parseDepositSubmission(d.body, { zk, asset: assetField, now: s.clock.t, cfg: s.cfg });
  const box = await s.chain.depositBoxOf(parsed.intent);
  s.add('deposit', parsed, box, TOKEN);
  return { ...parsed, box };
}
async function addWrap(s, opts) {
  const parsed = parseWrapSubmission(makeWrap(opts), { now: s.clock.t, cfg: s.cfg });
  const box = await s.chain.wrapBoxOf(parsed.intent);
  s.add('wrap', parsed, box, WRAP_TOKEN);
  return { ...parsed, box };
}

// ── config ──

await test('disabled without both addresses; the keeper key comes only from EVM_POOL_KEEPER_PRIV', () => {
  assert.equal(loadKeeperConfig({ EVM_POOL_ADDR: POOL }).enabled, false);
  assert.equal(loadKeeperConfig({}).enabled, false);
  const relayKey = '0x' + '11'.repeat(32);
  const cfg = loadKeeperConfig({ ...baseEnv, RELAY_KEY: relayKey, SETTLE_KEY: relayKey });
  assert.equal(cfg.keeperKey, '');
  assert.ok(!JSON.stringify(cfg, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Map ? [...v] : v)).includes('11'.repeat(32)));
  assert.equal(loadKeeperConfig({ ...baseEnv, EVM_POOL_KEEPER_PRIV: relayKey }).keeperKey, relayKey);
  assert.equal(cfg.reclaim, false);
});

await test('a keeper key that derives to the shared relay EOA or the settle address is refused', () => {
  const cfg = loadKeeperConfig({ ...baseEnv, SETTLE_ADDRESS: REFUND });
  assert.throws(() => checkKeeperSigner(cfg, RELAY_EOA), /shared relay signer/);
  assert.throws(() => checkKeeperSigner(cfg, REFUND.toUpperCase().replace('0X', '0x')), /shared relay signer/);
  checkKeeperSigner(cfg, KEEPER);
});

await test('a receive fee floor above the canonical cap refuses to start', () => {
  assert.throws(() => loadKeeperConfig({ ...baseEnv, EVM_POOL_KEEPER_MIN_RECEIVE_FEE_BPS: '26' }), /canonical receive fee cap 25/);
  assert.equal(loadKeeperConfig({ ...baseEnv, EVM_POOL_KEEPER_MIN_RECEIVE_FEE_BPS: '25' }).minReceiveFeeBps, 25);
});

await test('token maps parse "eth" and addresses and reject junk', () => {
  const m = parseTokenMap(`eth:5,${TOKEN}:7`, 'X');
  assert.equal(m.get(ETH), 5n);
  assert.equal(m.get(TOKEN.toLowerCase()), 7n);
  assert.throws(() => parseTokenMap('eth:-1', 'X'), /bad entry/);
  assert.throws(() => parseTokenMap('nope:1', 'X'), /bad entry/);
});

await test('coverCheck: floor, gas price with margin, unknown token, gas cap', () => {
  const cfg = mkCfg({ minFees: new Map([[TOKEN.toLowerCase(), 10n]]), rates: new Map([[ETH, 10n ** 18n]]), marginBps: 1000n, gasCap: 1_000_000n });
  assert.equal(coverCheck({ reward: 9n, token: TOKEN, gas: 1n, gasPrice: 0n, cfg }).ok, false);
  assert.equal(coverCheck({ reward: 10n, token: TOKEN, gas: 1n, gasPrice: 0n, cfg }).ok, true);
  assert.equal(coverCheck({ reward: 109n, token: ETH, gas: 100n, gasPrice: 1n, cfg }).ok, false);
  const ok = coverCheck({ reward: 110n, token: ETH, gas: 100n, gasPrice: 1n, cfg });
  assert.equal(ok.ok, true);
  assert.equal(ok.gas, 130n);
  assert.match(coverCheck({ reward: 1n << 100n, token: WRAP_TOKEN, gas: 1n, gasPrice: 1n, cfg }).reason, /no minimum fee or price/);
  assert.equal(coverCheck({ reward: 1n << 100n, token: ETH, gas: 2_000_000n, gasPrice: 1n, cfg }).ok, false);
  assert.equal(coverCheck({ reward: 1n << 100n, token: ETH, gas: 900_000n, gasPrice: 1n, cfg }).gas, 1_000_000n);
});

// ── intake ──

await test('a deposit whose hint reproduces the intent is accepted; a tampered hint or memo is refused', () => {
  const cfg = mkCfg();
  const d = makeDeposit();
  const p = parseDepositSubmission(d.body, { zk, asset: assetField, now: T0, cfg });
  assert.equal(p.reward, 100n);
  assert.equal(p.intent.outLeaf0, d.intent.outLeaf0);
  const bump = structuredClone(d.body); bump.hint.outputs[0].v = '601';
  assert.throws(() => parseDepositSubmission(bump, { zk, asset: assetField, now: T0, cfg }), /does not produce the intent's leaves/);
  const memo = structuredClone(d.body); memo.hint.memo0 = '0xa11ce1';
  assert.throws(() => parseDepositSubmission(memo, { zk, asset: assetField, now: T0, cfg }), /memo/);
  const over = structuredClone(d.body); over.hint.outputs[1].v = '401';
  assert.throws(() => parseDepositSubmission(over, { zk, asset: assetField, now: T0, cfg }), /exceed/);
  const otherAsset = poolAsset({ chainId: 1n, pool: POOL, token: WRAP_TOKEN });
  assert.throws(() => parseDepositSubmission(d.body, { zk, asset: otherAsset, now: T0, cfg }), /leaves/);
});

await test('deposit intake bounds: amount, deadline window, memo size, refund, field ranges', () => {
  const cfg = mkCfg({ maxMemoBytes: 4 });
  const chk = (body, re) => assert.throws(() => parseDepositSubmission(body, { zk, asset: assetField, now: T0, cfg }), re);
  const d = makeDeposit();
  chk({ ...d.body, intent: { ...d.body.intent, amount: '0' } }, /amount/);
  chk({ ...d.body, intent: { ...d.body.intent, amount: (1n << 120n).toString() } }, /amount out of range/);
  chk({ ...d.body, intent: { ...d.body.intent, deadline: String(T0 + 10) } }, /deadline/);
  chk({ ...d.body, intent: { ...d.body.intent, deadline: String(T0 + 365 * 86400) } }, /deadline/);
  chk({ ...d.body, intent: { ...d.body.intent, refund: ETH } }, /refund/);
  chk({ ...d.body, intent: { ...d.body.intent, amount: '1.5' } }, /integer/);
  chk({ ...d.body, hint: { ...d.body.hint, memo0: '0x0102030405' } }, /longer than 4 bytes/);
  chk({ ...d.body, hint: { ...d.body.hint, outputs: [null, null, null] } }, /at most two/);
  chk({ ...d.body, hint: { ...d.body.hint, outputs: [{ v: '1', npk: '0x' + 'f'.repeat(64), rho: '1' }, null] } }, /npk out of range/);
});

await test('wrap intake: registered asset, non-zero commit, tip overflow', () => {
  const cfg = mkCfg();
  const w = makeWrap();
  assert.equal(parseWrapSubmission(w, { now: T0, cfg }).reward, 50n);
  assert.equal(parseWrapSubmission({ intent: { ...w.intent, tipTo: '0x' + '77'.repeat(20) } }, { now: T0, cfg }).reward, 0n, 'a tip bound elsewhere earns this keeper nothing');
  assert.throws(() => parseWrapSubmission({ intent: { ...w.intent, commit: '0x' + '0'.repeat(64) } }, { now: T0, cfg }), /commit/);
  assert.throws(() => parseWrapSubmission({ intent: { ...w.intent, amount: ((1n << 256n) - 1n).toString(), tip: '1' } }, { now: T0, cfg }), /overflow/);
});

await test('HTTP intake: accept, idempotent resubmit, status without the hint, 413 on big bodies, 400 on junk, 429', async () => {
  const cfg = mkCfg({ maxBody: 4096, ratePerMin: 4 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const logs = [];
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => T0, log: (m) => logs.push(m) });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/evm-pool/keeper`;
  const post = (path, body, ip = '1.1.1.1') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    const d = makeDeposit();
    let r = await post('/deposit', d.body);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'pending');
    assert.equal(j.reward, '100');
    assert.ok(!('hint' in j));
    r = await post('/deposit', d.body);
    assert.equal((await r.json()).box, j.box);
    assert.equal(store.pendingCount(), 1);
    const st = await (await fetch(`${base}/status/${j.box}`)).json();
    assert.deepEqual(Object.keys(st).sort(), ['box', 'kind', 'reward', 'status']);
    assert.equal((await post('/deposit', 'x'.repeat(5000), '2.2.2.2')).status, 413);
    assert.equal((await post('/deposit', '{not json', '2.2.2.2')).status, 400);
    const w = await post('/wrap', makeWrap(), '2.2.2.2');
    assert.equal(w.status, 200);
    assert.equal((await post('/wrap', { intent: { ...makeWrap().intent, assetId: '0x' + 'b2'.repeat(32) } }, '2.2.2.2')).status, 400);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post('/wrap', makeWrap({ nonce: BigInt(i + 10) }), '3.3.3.3')).status);
    assert.ok(codes.includes(429));
    // behind Render the right-most forwarded hop is a proxy's and changes per request; the address Cloudflare saw is the caller
    const viaCf = [];
    for (let i = 0; i < 6; i++) viaCf.push((await fetch(base + '/wrap', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '4.4.4.4', 'x-forwarded-for': `9.9.9.9, 4.4.4.4, 172.70.0.${i}, 10.0.0.1` }, body: JSON.stringify(makeWrap({ nonce: BigInt(i + 30) })) })).status);
    assert.ok(viaCf.includes(429), 'one caller behind a changing proxy hop is still limited');
    assert.equal((await fetch(base + '/wrap', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '5.5.5.5', 'x-forwarded-for': '9.9.9.9, 5.5.5.5, 172.70.0.9, 10.0.0.1' }, body: JSON.stringify(makeWrap({ nonce: 99n })) })).status, 200, 'another caller is not');
    const info = await (await fetch(`${base}/info`)).json();
    assert.equal(info.keeper, KEEPER);
    assert.ok(logs.every((m) => !m.includes(d.body.hint.outputs[0].npk)));
  } finally { server.close(); }
});

await test('HTTP intake refuses new intents at capacity', async () => {
  const cfg = mkCfg({ maxPending: 1 });
  const store = openKeeperStore(':memory:');
  const handler = createIntakeHandler({ store, chain: mockChain(), zk, assetField, cfg, now: () => T0 });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/evm-pool/keeper/deposit`;
  try {
    const first = await fetch(url, { method: 'POST', body: JSON.stringify(makeDeposit().body) });
    assert.equal(first.status, 200);
    const box = (await first.json()).box;
    // A box that has held funds is kept: the table is full for a newcomer.
    store.update(box, { funded_at: T0 });
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(makeDeposit({ nonce: 1n }).body) })).status, 503);
    // One that never held funds is the first to go, so registrations that never pay cannot lock out new users.
    store.update(box, { funded_at: null });
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(makeDeposit({ nonce: 1n }).body) })).status, 200);
    assert.ok(!store.get(box), 'the oldest unfunded intent made room');
  } finally { server.close(); }
});

await test('an IPv6 client is keyed by its /64; IPv4 and mapped addresses by themselves', async () => {
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('::ffff:1.2.3.4'), '::ffff:1.2.3.4');
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:DB8:1:2::5'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2:ffff::9'), ipKey('2001:db8:1:2:1::'));
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.notEqual(ipKey('2001:db8:1:3::1'), ipKey('2001:db8:1:2::1'));
});

// ── leaf sync ──

await test('the leaf sync names the confirmed tree\'s edge as a catch-up point, and /point serves it with the call that posts it', async () => {
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const sync = makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: 2n, logChunk: 3n });
  assert.equal(sync.point(), null, 'nothing before the first sync');
  for (let i = 0; i < 5; i++) chain.foreignTx();
  await sync.sync();
  const pt = sync.point();
  assert.equal(pt.size, 6, 'the persisted leaves, not the tail');
  assert.equal(pt.block, Number(chain.block) - 2);
  assert.equal(pt.filled.length, 32);
  assert.ok(pt.filled.every((x) => /^0x[0-9a-f]{64}$/.test(x)));
  const tree = zk.incTree(); tree.append(chain.leaves.slice(0, 6));
  assert.deepEqual(pt.filled, tree.toJSON().filled.map((x) => `0x${BigInt(x).toString(16).padStart(64, '0')}`), 'the edge of the tree over those leaves');
  const REG = '0x00000000C3267616ED5E0DAA6F6490D109d6844D', cfg = mkCfg();
  const handler = createIntakeHandler({ store, chain, zk, leafSync: sync, assetField, cfg: { ...cfg, pointsAddress: REG }, now: () => T0 });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/evm-pool/keeper/point`;
    const r = await fetch(url);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.registry, REG);
    assert.equal(j.size, 6);
    assert.equal(j.data.slice(0, 10), '0x' + viemKeccak(toHex('post(uint256,uint256,bytes32[32])')).slice(2, 10), 'the post call');
    assert.equal(j.data.length, 2 + 8 + 64 * 34, 'the size, the block and the 32 edge words');
    const off = createServer(createIntakeHandler({ store, chain, zk, leafSync: sync, assetField, cfg: { ...cfg, pointsAddress: null }, now: () => T0 }));
    await new Promise((r2) => off.listen(0, '127.0.0.1', r2));
    try { assert.equal((await fetch(`http://127.0.0.1:${off.address().port}/evm-pool/keeper/point`)).status, 404, 'no registry named: no point to post'); } finally { off.close(); }
  } finally { server.close(); }
});

await test('overlapping syncs over one store do not empty it: the keeper tick, the history loop and a relay request each call sync()', async () => {
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  // A node with latency: every read gives way, so two overlapping runs would both read a chunk before either stored it.
  const slow = (f) => async (...a) => { await new Promise((r) => setTimeout(r, 3)); return f(...a); };
  chain.transactLogs = slow(chain.transactLogs); chain.poolState = slow(chain.poolState); chain.blockNumber = slow(chain.blockNumber);
  const logs = [];
  const sync = makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: 2n, logChunk: 3n, log: (m) => logs.push(m) });
  for (let i = 0; i < 12; i++) chain.foreignTx();
  const runs = await Promise.all([sync.sync(), sync.sync(), sync.sync()]);
  for (const r of runs) assert.equal(r.nextIndex, BigInt(chain.leaves.length), 'every caller gets the pool at its head');
  assert.deepEqual(logs, [], 'no "leaf store inconsistent": nothing was emptied');
  assert.equal(store.leafCount(), 20, 'the ten confirmed events (blocks 101-110), once each');
  assert.deepEqual(store.leaves(), chain.leaves.slice(0, 20), 'the same leaves as the chain, in order');
  // and it goes on: new blocks, overlapping again
  for (let i = 0; i < 4; i++) chain.foreignTx();
  const more = await Promise.all([sync.sync(), sync.sync()]);
  for (const r of more) assert.equal(r.nextIndex, BigInt(chain.leaves.length));
  assert.deepEqual(logs, []);
  // a run that fails does not hold up the ones behind it
  const real = chain.blockNumber; let fail = true;
  chain.blockNumber = async () => { if (fail) { fail = false; throw new Error('node down'); } return real(); };
  const [bad, good] = await Promise.allSettled([sync.sync(), sync.sync()]);
  assert.equal(bad.status, 'rejected'); assert.match(String(bad.reason), /node down/);
  assert.equal(good.status, 'fulfilled', 'the next caller runs on its own');
});

await test('a caller that arrives while a long replay runs is told it is catching up at once; a short catch-up still queues', async () => {
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const slow = (f) => async (...a) => { await new Promise((r) => setTimeout(r, 4)); return f(...a); };
  chain.transactLogs = slow(chain.transactLogs); chain.poolState = slow(chain.poolState); chain.blockNumber = slow(chain.blockNumber);
  const logs = [];
  const sync = makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: 2n, logChunk: 2n, log: (m) => logs.push(m) });
  for (let i = 0; i < 60; i++) chain.foreignTx();                         // 60 blocks behind with a 2-block chunk: a replay (more than 6 chunks)
  const first = sync.sync();
  await new Promise((r) => setTimeout(r, 20));                            // the first run has read the head and started
  const t0 = Date.now();
  await assert.rejects(sync.sync(), (e) => e instanceof CatchingUp && /blocks behind/.test(e.message), 'refused with CatchingUp');
  assert.ok(Date.now() - t0 < 20, 'at once, not after the replay');
  const done = await first;
  assert.equal(done.nextIndex, BigInt(chain.leaves.length), 'the replay itself went on and finished');
  assert.deepEqual(logs, [], 'and nothing was emptied');
  // caught up: two new blocks, and two callers both get an answer (the second queues behind the first)
  chain.foreignTx(); chain.foreignTx();
  const [a, b] = await Promise.all([sync.sync(), sync.sync()]);
  assert.equal(a.nextIndex, BigInt(chain.leaves.length)); assert.equal(b.nextIndex, BigInt(chain.leaves.length));
});

await test('leaf sync persists confirmed leaves and events, re-reads the tail, and resets on a dropped block', async () => {
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const sync = makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: 2n, logChunk: 3n });
  for (let i = 0; i < 5; i++) chain.foreignTx();
  let s = await sync.sync();
  assert.equal(s.tree.size, 10);
  assert.equal(s.tree.root, zk.tree(chain.leaves).root);
  assert.equal(s.root, zk.tree(chain.leaves).root);
  assert.equal(store.leafCount(), 6); // blocks ≤ head − 2
  const feed = sync.eventsFrom(0, 100);
  assert.equal(feed.events.length, 3, 'the confirmed Transact events, for /events');
  assert.deepEqual(feed.events.map((e) => e.firstIndex), [0, 2, 4]);
  assert.equal(feed.through, Number(chain.block) - 2);
  const page = sync.eventsFrom(0, 2);
  assert.equal(page.events.length, 2);
  assert.equal(page.through, page.events[1].block, 'a page ends on a whole block');
  // A reorg drops the last (unpersisted) event: the tail is simply re-read.
  chain.leaves.splice(8); chain.events.pop(); chain.block -= 1n;
  s = await sync.sync();
  assert.equal(s.tree.size, 8);
  assert.equal(s.tree.root, zk.tree(chain.leaves).root);
  // A deeper reorg the store already holds: count exceeds the pool's, the store resets and the next sync rebuilds.
  chain.leaves.splice(4); chain.events.splice(2); chain.block = 102n;
  await assert.rejects(sync.sync(), LeafSyncError);
  assert.equal(store.leafCount(), 0);
  assert.equal(sync.eventsFrom(0, 100).events.length, 0, 'events reset with the leaves');
  assert.equal(sync.point(), null, 'no point once the store is reset');
  s = await sync.sync();
  assert.equal(s.tree.size, 4);
  assert.equal(s.tree.root, zk.tree(chain.leaves).root);
});

// A chain whose Transact logs carry every field: blocks 101..110, one transaction each; odd blocks' logs carry no
// timestamp (as on a node that does not give one); every third transaction went through the router.
function factsChain() {
  const c = { router: ROUTER, block: 112n, leaves: [], logs: [], calls: { tx: 0, time: 0, logs: 0 }, failTxAt: null };
  for (let b = 101n; b <= 110n; b++) {
    const firstIndex = BigInt(c.leaves.length), leaf = b * 7919n;
    c.leaves.push(leaf, 0n);
    c.logs.push({ firstIndex, outLeaf0: leaf, outLeaf1: 0n, blockNumber: b, logIndex: 0, tx: '0x' + b.toString(16).padStart(64, '0'),
      nf0: '0x' + b.toString(16).padStart(64, '0'), nf1: '0x' + '0'.repeat(64), memo0: '0x', memo1: '0x',
      recipient: REFUND, extAmount: b % 2n ? 1000n : -500n, relayer: KEEPER, fee: 5n, blockTimestamp: b % 2n ? null : 1_700_000_000n + b });
  }
  c.blockNumber = async () => c.block;
  c.poolState = async (blockNumber) => {
    const at = blockNumber === undefined ? c.block : BigInt(blockNumber);
    const n = c.logs.filter((l) => l.blockNumber <= at).length * 2;
    return { root: zk.tree(c.leaves.slice(0, n)).root, nextIndex: BigInt(n) };
  };
  c.transactLogs = async (from, to) => { c.calls.logs++; return c.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to); };
  c.txFacts = async (hash) => {
    if (c.failTxAt !== null && c.calls.tx++ === c.failTxAt) throw new Error('node down');
    if (c.failTxAt === null) c.calls.tx++;
    const b = BigInt(hash);
    return { from: '0x' + 'Bb'.repeat(20), to: b % 3n === 0n ? ROUTER : POOL, input: '0xc0ffee' + b.toString(16) };
  };
  c.blockTime = async (n) => { c.calls.time++; return 1_700_000_000 + Number(n); };
  return c;
}
const oldShape = (l) => ({ kind: 'transact', block: Number(l.blockNumber), tx: l.tx, firstIndex: Number(l.firstIndex), nf0: l.nf0, nf1: l.nf1,
  outLeaf0: l.outLeaf0.toString(), outLeaf1: l.outLeaf1.toString(), memo0: '0x', memo1: '0x' });

await test('history facts: new events keep their log fields, and the feed shows them only when asked', async () => {
  const store = openKeeperStore(':memory:'), chain = factsChain();
  const sync = makeLeafSync({ store, chain, zk, startBlock: 101n, confirmations: 2n, logChunk: 4n });
  await sync.sync();
  const plain = sync.eventsFrom(0, 100), full = sync.eventsFrom(0, 100, { facts: true });
  assert.equal(plain.events.length, 10);
  assert.deepEqual(Object.keys(plain.events[0]).sort(), ['block', 'firstIndex', 'kind', 'memo0', 'memo1', 'nf0', 'nf1', 'outLeaf0', 'outLeaf1', 'tx'], 'the shape the feed always had');
  assert.equal(plain.factsThrough, undefined);
  const e = full.events[1];                                                   // block 102: an even block, a withdrawal
  assert.deepEqual([e.recipient, e.ext, e.relayer, e.fee, e.ts], [REFUND.toLowerCase(), '-500', KEEPER.toLowerCase(), '5', 1_700_000_102]);
  assert.equal(full.events[0].ts, undefined, 'block 101 gave no time in its log');
  assert.equal(full.factsThrough, 100, 'no event has its sender yet');
});

await test('history facts: a store kept before facts is filled from the logs, then senders, targets and times, and resumes after a failure', async () => {
  const store = openKeeperStore(':memory:'), chain = factsChain();
  store.appendLeaves(chain.leaves.map((leaf, i) => ({ leaf, block: chain.logs[i >> 1].blockNumber })), 110, chain.logs.map((l) => ({ block: l.blockNumber, logIndex: 0, ev: oldShape(l) })));
  const facts = makeFactsSync({ store, chain, startBlock: 101n, logChunk: 4n, concurrency: 2 });
  assert.equal(await facts.step(0), true, 'no budget: nothing done, more to do');
  chain.failTxAt = 3;
  await assert.rejects(facts.step(60_000), /node down/);
  const midway = store.getMeta('facts_block');
  assert.equal(store.getMeta('facts_logs_block'), '110', 'the log fields were all filled before the failure');
  chain.failTxAt = null; chain.calls.time = 0;
  assert.equal(await facts.step(60_000), false, 'done');
  assert.ok(midway === null || Number(midway) < 110, 'the failed window was not marked done');
  const evs = store.eventsBetween(101, 110).map((r) => r.ev);
  for (const ev of evs) {
    const b = BigInt(ev.block);
    assert.equal(ev.ext, (b % 2n ? 1000n : -500n).toString());
    assert.equal(ev.from, '0x' + 'bb'.repeat(20));
    assert.equal(ev.to, (b % 3n === 0n ? ROUTER : POOL).toLowerCase());
    assert.equal(ev.input, b % 3n === 0n ? '0xc0ffee' + b.toString(16) : undefined, 'call data only for a router call');
    assert.equal(ev.ts, 1_700_000_000 + Number(b), 'the log time where given, the block time otherwise');
  }
  assert.equal(chain.calls.time, 5, 'the pass that finished read a block time only for the five blocks whose log had none');
  const sync = makeLeafSync({ store, chain, zk, startBlock: 101n, confirmations: 2n, logChunk: 4n });
  const feed = sync.eventsFrom(0, 100, { facts: true });
  assert.equal(feed.factsThrough, 110);
  assert.ok(sync.eventsFrom(0, 100).events.every((e) => FACT_KEYS.every((k) => e[k] === undefined)), 'and still hidden unless asked');
  store.resetLeaves();
  assert.equal(store.getMeta('facts_block'), null, 'a reset clears the marks with the leaves');
});

await test('history facts: a node that answers an old range with nothing is passed over for one that has the logs', async () => {
  const word = (h) => '0x' + h.replace(/^0x/, '').padStart(64, '0');
  const logEvent = {
    blockNumber: '0x65', blockHash: '0x' + '11'.repeat(32), transactionHash: '0x' + 'ab'.repeat(32), transactionIndex: '0x0', logIndex: '0x4b9', removed: false, address: POOL,
    topics: ['0xdf0ed29e998ac2f2ff0f0516cb9c1b95af189e00d55af3764b95bdd2a835e53a', word('07'), word('00')],
    data: '0x' + [1n, 0n, 6n, 9n, 0xabn, -500n, 0xcdn, 5n, 0x140n, 0x160n].map((v) => BigInt.asUintN(256, v).toString(16).padStart(64, '0')).join('') + '0'.repeat(128),
  };
  const serve = (logs, seen) => new Promise((res) => {
    const srv = createServer((req, rsp) => {
      let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
        const one = (x) => ({ jsonrpc: '2.0', id: x.id, result: x.method === 'eth_chainId' ? '0x1' : x.method === 'eth_getLogs' ? (seen.push(1), logs) : x.method === 'eth_call' ? word(POOL) : '0x0' });
        const j = JSON.parse(body); rsp.setHeader('content-type', 'application/json'); rsp.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
      });
    }).listen(0, () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
  const seenA = [], seenB = [], A = await serve([], seenA), B = await serve([logEvent], seenB);
  try {
    const chain = await makeKeeperChain({ cfg: { rpcUrls: [A.url, B.url], factsRpcUrls: [A.url, B.url], pool: POOL, router: ROUTER, chainId: 1, sendRpcUrls: [], allowPublicSend: false, minPriorityFee: 0n }, account: { address: KEEPER } });
    const expect = [{ block: 101, logIndex: 1209 }];
    const logs = await chain.factsLogs(100n, 110n, expect);
    assert.equal(logs.length, 1);
    assert.deepEqual([Number(logs[0].blockNumber), Number(logs[0].logIndex), logs[0].extAmount, logs[0].fee], [101, 1209, -500n, 5n]);
    assert.equal(seenA.length, 1, 'the first node was asked and had nothing');
    await assert.rejects(chain.factsLogs(100n, 110n, [{ block: 101, logIndex: 1 }]), /no Transact log at block 101 index 1/, 'a log no node has is an error, not an empty answer');
    const plain = await chain.transactLogs(100n, 110n);
    assert.equal(plain.length, 0, 'the relay path still reads through its fallback, as before: the first node answered, with nothing');
  } finally { A.srv.close(); B.srv.close(); }
});

await test('history facts: a node that gives a block time of 0 gives none, and a 0 an earlier version stored is read again from the block', async () => {
  const chain = factsChain();
  for (const l of chain.logs) l.blockTimestamp = 0n;                      // a node whose logs carry the field as 0 (Robinhood's)
  // New events do not keep the 0.
  const fresh = openKeeperStore(':memory:');
  await makeLeafSync({ store: fresh, chain, zk, startBlock: 101n, confirmations: 2n, logChunk: 4n }).sync();
  assert.ok(fresh.eventsBetween(101, 110).every((r) => r.ev.ts === undefined), 'no time kept for a 0');
  // A store that kept the 0 (events with every log fact, a sender and a time of 0, and the stages marked done) is made right.
  const old = openKeeperStore(':memory:');
  old.appendLeaves(chain.leaves.map((leaf, i) => ({ leaf, block: chain.logs[i >> 1].blockNumber })), 110, chain.logs.map((l) => ({ block: l.blockNumber, logIndex: 0, ev: { ...oldShape(l), recipient: REFUND.toLowerCase(), ext: l.extAmount.toString(), relayer: KEEPER.toLowerCase(), fee: '5', from: '0x' + 'bb'.repeat(20), to: POOL.toLowerCase(), ts: 0 } })));
  old.setMeta('facts_logs_block', 110); old.setMeta('facts_block', 110);
  chain.calls.time = 0;
  const facts = makeFactsSync({ store: old, chain, startBlock: 101n, logChunk: 4n });
  assert.equal(await facts.step(60_000), false);
  assert.equal(old.getMeta('facts_v'), '2');
  for (const r of old.eventsBetween(101, 110)) assert.equal(r.ev.ts, 1_700_000_000 + r.block, `block ${r.block} has its time`);
  assert.equal(chain.calls.time, 10, 'one block read for each block that had a 0');
  assert.equal(await facts.step(60_000), false);
  assert.equal(chain.calls.time, 10, 'and nothing is read again');
});

await test('leaf sync keeps no chunk the pool\'s own count at its last block does not confirm, so a node that has no old logs cannot leave a store marked synced and empty', async () => {
  const chain = factsChain();                                  // 10 blocks (101..110), one transaction each: 20 leaves by block 110
  const real = chain.transactLogs;
  chain.transactLogs = async (from, to) => (to < 108n ? [] : real(from, to));   // the node answers an old range with nothing, not an error
  const store = openKeeperStore(':memory:');
  const sync = makeLeafSync({ store, chain, zk, startBlock: 101n, confirmations: 2n, logChunk: 4n });
  await assert.rejects(sync.sync(), ChunkNotKept);
  assert.equal(store.syncedBlock(), null, 'no progress was marked');
  assert.equal(store.leafCount(), 0); assert.equal(store.eventsBetween(0, 1e9).length, 0);
  await assert.rejects(sync.sync(), ChunkNotKept, 'and the next sync asks for the same chunk again');
  // The same node with its old logs: the store fills, chunk by chunk, each confirmed by the pool's count.
  chain.transactLogs = real;
  const s = await sync.sync();
  assert.equal(s.tree.size, 20); assert.equal(store.leafCount(), 20); assert.equal(store.syncedBlock(), 110);
  // A node that cannot give the pool's state for an old block fails the sync the same way.
  const store2 = openKeeperStore(':memory:');
  const chain2 = factsChain(); chain2.poolState = async (b) => { if (b !== undefined && BigInt(b) < 108n) throw new Error('missing trie node'); return factsChain().poolState(b); };
  await assert.rejects(makeLeafSync({ store: store2, chain: chain2, zk, startBlock: 101n, confirmations: 2n, logChunk: 4n }).sync(), /missing trie node/);
  assert.equal(store2.syncedBlock(), null);
});

// ── loop ──

await test('an unfunded box is only watched, with backoff; no proof is made', async () => {
  const s = setup();
  const { box } = await addDeposit(s);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 0);
  const r = s.store.get(box);
  assert.equal(r.status, 'pending');
  assert.ok(r.next_check > T0 + 10);
  assert.equal(await s.keeper.tick(), 0); // not due yet
});

await test('a funded deposit is proven against the current leaves and completed; the keeper is the relayer and paid the fee', async () => {
  const s = setup();
  s.chain.foreignTx(); s.chain.foreignTx();
  const { box, intent } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 1);
  assert.equal(s.chain.sent.length, 1);
  const [sentIntent, tx] = s.chain.sent[0].args;
  assert.equal(tx.relayer, KEEPER);
  assert.equal(tx.recipient, ETH);
  assert.equal(tx.extAmount, 1000n);
  assert.equal(tx.fee, 100n);
  assert.equal(tx.publicInputs[3], 4n);
  assert.equal(sentIntent.outLeaf0, intent.outLeaf0);
  assert.equal(await s.chain.balanceOf(TOKEN, KEEPER), 100n);
  const r = s.store.get(box);
  assert.equal(r.status, 'completed');
  assert.equal(r.hint, null);
  assert.equal(r.tx_hash, s.chain.sent[0].hash);
});

await test('a proof made stale by another transaction is re-proven against the new root', async () => {
  const s = setup({ onProve: (k, chain) => { if (k === 1) chain.foreignTx(); } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 2);
  assert.equal(s.chain.sent.length, 1);
  assert.equal(s.chain.sent[0].args[1].publicInputs[3], 2n);
  assert.equal(s.store.get(box).status, 'completed');
  assert.ok(s.logs.some((m) => /StaleRoot/.test(m)));
});

await test('re-proving is bounded; the box stays pending for the next tick', async () => {
  const s = setup({ cfg: { staleRetries: 2 }, onProve: (_, chain) => chain.foreignTx() });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 3);
  assert.equal(s.chain.sent.length, 0);
  const r = s.store.get(box);
  assert.equal(r.status, 'pending');
  assert.equal(r.note, 'stale');
  assert.equal(r.attempts, 0);
});

await test('a box whose proofs keep going stale is looked at less and less often, up to a cap', async () => {
  const s = setup({ cfg: { staleRetries: 0, staleMaxBackoffSecs: 80, pollSecs: 10 }, onProve: (_, chain) => chain.foreignTx() });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  const waits = [];
  for (let i = 0; i < 6; i++) {
    const at = s.clock.t;
    await s.keeper.tick();
    const r = s.store.get(box);
    assert.equal(r.note, 'stale');
    waits.push(r.next_check - at);
    s.advance(r.next_check - at);
  }
  assert.deepEqual(waits, [10, 20, 40, 80, 80, 80], 'doubling from the poll interval, then held at the cap');
  assert.equal(s.prover.calls, 6, 'one proof for each look, not a proof every poll');
});

await test('a /quote answer is shared for a few seconds and a refusal is not kept', async () => {
  const cfg = mkCfg({ ratePerMin: 1000, quoteCacheMs: 60_000 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  let reads = 0;
  const price = chain.gasPrice;
  chain.gasPrice = async () => { reads++; return price(); };
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => T0 });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/evm-pool/keeper`;
  try {
    const first = await (await fetch(`${base}/quote`)).json();
    for (let i = 0; i < 5; i++) assert.deepEqual(await (await fetch(`${base}/quote`)).json(), first);
    const before = reads;
    chain.gas = 7n;   // the price moves: a cached answer is still the answer for the window
    assert.deepEqual(await (await fetch(`${base}/quote`)).json(), first);
    assert.equal(reads, before, 'no read behind a cached answer');
    const other = await (await fetch(`${base}/quote?gas=900000`)).json();
    assert.notEqual(other.gas, first.gas, 'another gas is its own answer');
  } finally { server.close(); }
});

await test('a keeper that starts again reads its tree from the store, not by hashing every leaf', async () => {
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  for (let i = 0; i < 5; i++) chain.foreignTx();
  const appended = [];
  const spyZk = { ...zk, incTree: (...a) => { const t = zk.incTree(...a); const orig = t.append; t.append = (ls, ...r) => { if (ls.length) appended.push(ls.length); return orig(ls, ...r); }; return t; } };
  const mk = () => makeLeafSync({ store, chain, zk: spyZk, startBlock: 0n, confirmations: 2n, logChunk: 3n });
  const first = await mk().sync();
  assert.equal(store.leafCount(), 6);
  assert.ok(store.getMeta('base_tree'), 'the tree is kept beside the leaves');
  appended.length = 0;
  const again = await mk().sync();      // a new process: nothing in memory, the same store
  assert.ok(!appended.includes(6), `the 6 stored leaves were hashed again at the start: ${appended}`);
  assert.equal(again.root, first.root, 'and it is the same tree');
  assert.equal(again.tree.root, zk.tree(chain.leaves).root);
  // a tree that does not agree with the leaves the store holds, in any of the ways it could, is not trusted: the leaves are hashed
  const good = JSON.parse(store.getMeta('base_tree'));
  assert.deepEqual(Object.keys(good).sort(), ['block', 'count', 'last', 'tree'], 'kept with the count, the block and the last leaf');
  const wrong = {
    'the leaf count': { ...good, count: 4 },
    'the block': { ...good, block: good.block - 1 },
    'the last leaf': { ...good, last: '12345' },
    'its own size': { ...good, tree: { ...good.tree, size: 4 } },
    'an older shape (the tree alone)': good.tree,
  };
  for (const [what, meta] of Object.entries(wrong)) {
    store.setMeta('base_tree', JSON.stringify(meta));
    appended.length = 0;
    const healed = await mk().sync();
    assert.ok(appended.includes(6), `a tree that disagrees in ${what} is rebuilt from the leaves`);
    assert.equal(healed.tree.root, zk.tree(chain.leaves).root, `and the tree is right (${what})`);
  }
  store.setMeta('base_tree', 'not json');
  appended.length = 0;
  const bad = await mk().sync();
  assert.ok(appended.includes(6), 'an unreadable tree is rebuilt from the leaves');
  assert.equal(bad.tree.root, zk.tree(chain.leaves).root);
});

await test('hashing the stored leaves in slices gives the same tree, and many syncs at once rebuild it once', async () => {
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  for (let i = 0; i < 5; i++) chain.foreignTx();
  await makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: 2n, logChunk: 3n }).sync();   // six leaves stored
  store.setMeta('base_tree', '');
  const appended = [];
  const spyZk = { ...zk, incTree: (...a) => { const t = zk.incTree(...a); const orig = t.append; t.append = (ls, ...r) => { if (ls.length) appended.push(ls.length); return orig(ls, ...r); }; return t; } };
  const sync = makeLeafSync({ store, chain, zk: spyZk, startBlock: 0n, confirmations: 2n, logChunk: 3n, rebuildChunk: 2 });
  const [a, b, c] = await Promise.all([sync.sync(), sync.sync(), sync.sync()]);
  assert.equal(a.tree.root, zk.tree(chain.leaves).root, 'slices of two leaves make the same tree');
  assert.equal(b.root, a.root);
  assert.equal(c.root, a.root);
  assert.deepEqual(appended.filter((n) => n === 2).length, 3, 'six leaves in three slices, once for all three syncs');
});

await test('an unprofitable deposit is skipped before proving', async () => {
  const s = setup({ cfg: { minFees: new Map([[TOKEN.toLowerCase(), 500n]]) } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 0);
  assert.equal(s.store.get(box).status, 'pending');
  assert.match(s.store.get(box).note, /below the 500 minimum/);
});

await test('gas priced in: a fee that covers the floor but not the estimated gas is skipped after the estimate', async () => {
  const s = setup({ cfg: { minFees: new Map(), rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), marginBps: 0n } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  s.chain.gas = 0n; // pre-check passes
  s.chain.beforeEstimate = () => { s.chain.gas = 1n; }; // 400k gas × 1 wei > the 100 fee
  await s.keeper.tick();
  assert.equal(s.prover.calls, 1);
  assert.equal(s.chain.sent.length, 0);
  assert.match(s.store.get(box).note, /below the .* wei cost/);
});

await test('a non-stale revert counts as an attempt; enough of them mark the box failed', async () => {
  const s = setup({ cfg: { maxAttempts: 2 } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  s.chain.estimateError = revert('BadProof');
  await s.keeper.tick();
  assert.equal(s.store.get(box).attempts, 1);
  s.advance(1000);
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'failed');
  assert.equal(s.store.get(box).hint, null);
});

await test('a submission with no receipt yet is left in flight and settled from its receipt later', async () => {
  const s = setup();
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  s.chain.receiptMode = 'pending';
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'pending');
  assert.ok(s.store.get(box).tx_hash);
  s.chain.receiptMode = 'success';
  s.advance(20);
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'completed');
  assert.equal(s.prover.calls, 1);
});

await test('a box emptied by someone else after funding is closed', async () => {
  const s = setup({ cfg: { minFees: new Map([[TOKEN.toLowerCase(), 500n]]) } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  await s.keeper.tick();
  s.chain.balances.clear();
  s.advance(1000);
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'closed-elsewhere');
});

await test('a funded wrap box is completed for its tip; an underfunded one is not', async () => {
  const s = setup();
  const w1 = await addWrap(s);
  const w2 = await addWrap(s, { nonce: 1n });
  s.chain.fund(WRAP_TOKEN, w1.box, 5050n);
  s.chain.fund(WRAP_TOKEN, w2.box, 5000n);
  await s.keeper.tick();
  assert.equal(s.store.get(w1.box).status, 'completed');
  assert.equal(s.store.get(w2.box).status, 'pending');
  assert.equal(s.chain.sent.length, 1);
  assert.equal(s.chain.sent[0].functionName, 'completeWrap');
  assert.equal(await s.chain.balanceOf(WRAP_TOKEN, KEEPER), 50n);
  assert.equal(s.prover.calls, 0);
});

await test('past the deadline and grace an unfunded box expires; reclaim is off by default', async () => {
  const s = setup({ cfg: { expireGraceSecs: 100 } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 10n); // underfunded
  s.advance(3600 + 50);
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'pending');
  s.advance(1000);
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'expired');
  assert.equal(s.chain.sent.length, 0);
});

await test('with reclaim on, a past-deadline underfunded box is reclaimed to its refund address', async () => {
  const s = setup({ cfg: { reclaim: true } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 10n);
  s.advance(3601);
  await s.keeper.tick();
  assert.equal(s.chain.sent[0].functionName, 'reclaimDeposit');
  assert.equal(s.store.get(box).status, 'reclaimed');
  assert.equal(await s.chain.balanceOf(TOKEN, REFUND), 10n);
});

// ── what a completed box still holds ──

const reclaims = (s) => s.chain.sent.filter((x) => x.functionName === 'reclaimDeposit');
// A deposit box funded `extra` above its amount (a swap that paid it over), completed by the keeper: the box keeps `extra`.
async function completedWithSurplus(s, extra, opts) {
  const d = await addDeposit(s, opts);
  s.chain.fund(TOKEN, d.box, 1000n + extra);
  await s.keeper.tick();
  assert.equal(s.store.get(d.box).status, 'completed');
  assert.equal(await s.chain.balanceOf(TOKEN, d.box), extra);
  return d;
}
// A completed deposit box that holds `extra`, without running its completion.
async function leftover(s, extra, { token = TOKEN, ...opts } = {}) {
  const d = makeDeposit(opts);
  const parsed = parseDepositSubmission(d.body, { zk, asset: assetField, now: s.clock.t, cfg: s.cfg });
  const box = await s.chain.depositBoxOf(parsed.intent);
  s.add('deposit', parsed, box, token);
  s.store.update(box, { status: 'completed' });
  s.chain.fund(token, box, extra);
  return box;
}

await test('with reclaim on, what a completed box holds above its amount goes to its refund once its deadline has passed, and only once', async () => {
  const s = setup({ cfg: { reclaim: true, sweepSurplusSecs: 0 } });
  const { box } = await completedWithSurplus(s, 700n);
  s.advance(100);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 0, 'not before the deadline: the router refuses it');
  s.advance(3600);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 1);
  assert.equal(await s.chain.balanceOf(TOKEN, REFUND), 700n);
  assert.equal(await s.chain.balanceOf(TOKEN, box), 0n);
  assert.equal(s.store.get(box).status, 'completed', 'only its leftover moved: the box stays completed');
  assert.equal(s.store.get(box).note, 'swept');
  s.advance(100);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 1, 'a swept box is not looked at again');
});

await test('a leftover not worth the send stays, and is marked so it is not looked at again: a token under its minimum fee, ETH under three times the gas', async () => {
  const s = setup({ cfg: { reclaim: true, sweepSurplusSecs: 0 } });
  const small = await leftover(s, 5n);                                          // the token's minimum fee is 10
  const ok = await leftover(s, 450_000n, { token: ETH, nonce: 1n });            // a reclaim estimates at 150,000 gas, 1 wei each: 450,000 is exactly three times
  const dust = await leftover(s, 449_999n, { token: ETH, nonce: 2n });
  s.advance(3601);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 1);
  assert.equal(reclaims(s)[0].args[1], ETH);
  assert.equal(await s.chain.balanceOf(ETH, REFUND), 450_000n);
  assert.equal(s.store.get(ok).note, 'swept');
  assert.equal(s.store.get(small).note, 'dust');
  assert.equal(s.store.get(dust).note, 'dust');
  assert.equal(await s.chain.balanceOf(TOKEN, small), 5n, 'the leftover is left where it is');
  s.advance(100);
  s.chain.gas = 0n;                                                             // gas is free now: they are not weighed again
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 1);
});

await test('the leftover sweep is off unless reclaim is on, looks at most every sweepSurplusSecs, and takes sweepSurplusBatch boxes at a time, oldest deadline first', async () => {
  const cfg = loadKeeperConfig({ ...baseEnv, EVM_POOL_KEEPER_RECLAIM: '1', EVM_POOL_KEEPER_SURPLUS_SECS: '30', EVM_POOL_KEEPER_SURPLUS_BATCH: '3' });
  assert.deepEqual([cfg.reclaim, cfg.sweepSurplusSecs, cfg.sweepSurplusBatch], [true, 30, 3]);
  const dflt = loadKeeperConfig(baseEnv);
  assert.deepEqual([dflt.reclaim, dflt.sweepSurplusSecs, dflt.sweepSurplusBatch], [false, 600, 10]);

  const off = setup({ cfg: { sweepSurplusSecs: 0 } });
  await leftover(off, 700n);
  off.advance(4000);
  await off.keeper.tick();
  assert.equal(reclaims(off).length, 0, 'reclaim is off by default');

  const s = setup({ cfg: { reclaim: true, sweepSurplusSecs: 600, sweepSurplusBatch: 1 } });
  const later = await leftover(s, 700n);                                        // deadline T0 + 3600
  const first = await leftover(s, 800n, { nonce: 1n, deadline: T0 + 3000 });
  s.advance(4000);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 1, 'one box to a look');
  assert.equal(s.store.get(first).note, 'swept', 'the one that lapsed first');
  assert.notEqual(s.store.get(later).note, 'swept');
  s.advance(100);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 1, 'not again within sweepSurplusSecs');
  s.advance(600);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 2);
  assert.equal(s.store.get(later).note, 'swept');
});

await test('a leftover sweep that finds the box empty, or emptied by another sender, closes it, as does one the router refuses for good; one it still calls early, or one not seen mined, is looked at again without a second send', async () => {
  const s = setup({ cfg: { reclaim: true, sweepSurplusSecs: 0 } });
  const none = await leftover(s, 0n, { deadline: T0 + 3000 });
  const bad = await leftover(s, 500n, { nonce: 4n, deadline: T0 + 3100 });
  const raced = await leftover(s, 700n, { nonce: 1n, deadline: T0 + 3600 });
  const early = await leftover(s, 900n, { nonce: 2n, deadline: T0 + 4200 });
  const slow = await leftover(s, 1100n, { nonce: 3n, deadline: T0 + 4800 });
  s.advance(3200);
  s.chain.estimateError = revert('BadIntent');                                  // a revert waiting does not change
  await s.keeper.tick();
  s.chain.estimateError = null;
  assert.equal(reclaims(s).length, 0, 'nothing in one, and the router refuses the other: nothing to send');
  assert.equal(s.store.get(none).note, 'swept');
  assert.equal(s.store.get(bad).note, 'refused');

  s.advance(600);
  s.chain.beforeEstimate = () => { s.chain.fund(TOKEN, raced, -700n); };        // another sender's reclaim lands between the read and the estimate
  await s.keeper.tick();
  s.chain.beforeEstimate = null;
  assert.equal(reclaims(s).length, 0);
  assert.equal(s.store.get(raced).note, 'swept');

  s.advance(600);
  s.chain.elapsed -= 400;                                                       // the chain's clock is behind: the router says NotExpired
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 0);
  assert.notEqual(s.store.get(early).note, 'swept');
  assert.ok(s.logs.some((m) => m.includes(early) && /surplus not sent yet \(NotExpired\)/.test(m)));
  s.chain.elapsed += 400;
  s.advance(600);
  s.chain.receiptMode = 'pending';                                              // sent, but no receipt yet
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 2, 'the early box and the slow one are sent');
  assert.notEqual(s.store.get(early).note, 'swept');
  assert.ok(s.logs.some((m) => /not seen mined yet/.test(m)));
  s.chain.receiptMode = 'success';
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 2, 'looked at again: the box is empty now, nothing is sent twice');
  assert.equal(s.store.get(early).note, 'swept');
  assert.equal(s.store.get(slow).note, 'swept');
  assert.equal(s.store.get(bad).note, 'refused', 'and the refused one stays so');
  assert.equal(await s.chain.balanceOf(TOKEN, bad), 500n);
  assert.equal(await s.chain.balanceOf(TOKEN, REFUND), 2000n);
});

await test('what a box is worth sending back: ETH at three times the gas of the send, a token at its minimum fee and its price, an unpriced token never', () => {
  const cfg = mkCfg(), est = 150_000n;
  assert.equal(reclaimWorth({ bal: 450_000n, token: ETH, est, price: 1n, cfg }), true);
  assert.equal(reclaimWorth({ bal: 449_999n, token: ETH, est, price: 1n, cfg }), false);
  assert.equal(reclaimWorth({ bal: 450_000n, token: ETH, est, price: 2n, cfg }), false, 'at twice the gas price it is not');
  assert.equal(reclaimWorth({ bal: 10n, token: TOKEN, est, price: 1n, cfg }), true, 'the token\'s minimum fee is 10');
  assert.equal(reclaimWorth({ bal: 9n, token: TOKEN, est, price: 1n, cfg }), false);
  assert.equal(reclaimWorth({ bal: 10n ** 30n, token: '0x9999999999999999999999999999999999999999', est, price: 1n, cfg }), false, 'a token the keeper has no minimum or price for');
  const priced = mkCfg({ minFees: new Map(), rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), marginBps: 0n });
  assert.equal(reclaimWorth({ bal: 150_000n, token: TOKEN, est, price: 1n, cfg: priced }), true);
  assert.equal(reclaimWorth({ bal: 149_999n, token: TOKEN, est, price: 1n, cfg: priced }), false, 'a token priced at a wei each: its balance against the gas');
});

await test('with reclaim on, a box whose balance is not worth sending back is left alone, watched as before, and expires after its grace', async () => {
  const s = setup({ cfg: { reclaim: true, expireGraceSecs: 100 } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 5n);                                                 // the token's minimum fee is 10
  s.advance(3601);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 0);
  assert.equal(s.store.get(box).status, 'pending');
  assert.equal(s.store.get(box).note, 'too little to send back');
  s.advance(200);
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'expired');
  assert.equal(reclaims(s).length, 0);
  assert.equal(await s.chain.balanceOf(TOKEN, box), 5n, 'left where it is');

  // an ETH pool's box: worth it from three times the gas of the send, 450,000 wei here
  const e = setup({ cfg: { reclaim: true } });
  const d = makeDeposit({ amount: 10n ** 18n });                                // (underfunded: it holds a few hundred thousand wei of the ETH it was to hold)
  const parsed = parseDepositSubmission(d.body, { zk, asset: assetField, now: e.clock.t, cfg: e.cfg });
  const ebox = await e.chain.depositBoxOf(parsed.intent);
  e.add('deposit', parsed, ebox, ETH);
  e.chain.fund(ETH, ebox, 449_999n);
  e.advance(3601);
  await e.keeper.tick();
  assert.equal(reclaims(e).length, 0);
  e.chain.fund(ETH, ebox, 1n);
  e.advance(100);
  await e.keeper.tick();
  assert.equal(reclaims(e).length, 1);
  assert.equal(await e.chain.balanceOf(ETH, REFUND), 450_000n);
  assert.equal(e.store.get(ebox).status, 'reclaimed');
});

await test('a box sent back is paid for out of the signer\'s day budget: the sweep subsidy\'s, and none set means no bound', async () => {
  const s = setup({ cfg: { reclaim: true, sweepSubsidyDaily: 200_000n } });
  s.chain.address = '0x7777777777777777777777777777777777770001';                // its own signer: the day\'s ledger is shared by the process
  const a = await addDeposit(s), b = await addDeposit(s, { nonce: 1n });
  s.chain.fund(TOKEN, a.box, 10n);
  s.chain.fund(TOKEN, b.box, 10n);
  s.advance(3601);
  await s.keeper.tick();                                                        // a reclaim costs 150,000 wei here: one fits in 200,000, the second does not
  assert.equal(reclaims(s).length, 1);
  const waiting = [a, b].find((x) => s.store.get(x.box).status === 'pending');
  assert.match(s.store.get(waiting.box).note, /day's budget/);
  s.advance(86_401);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 2, 'a day on, the budget is whole again');

  const free = setup({ cfg: { reclaim: true } });
  free.chain.address = '0x7777777777777777777777777777777777770002';
  const c = await addDeposit(free), d = await addDeposit(free, { nonce: 1n });
  free.chain.fund(TOKEN, c.box, 10n);
  free.chain.fund(TOKEN, d.box, 10n);
  free.advance(3601);
  await free.keeper.tick();
  assert.equal(reclaims(free).length, 2, 'with no budget set there is no bound');
});

await test('a leftover sent back comes out of the same day budget, and waits for it without being marked', async () => {
  const s = setup({ cfg: { reclaim: true, sweepSurplusSecs: 0, sweepSubsidyDaily: 200_000n } });
  s.chain.address = '0x7777777777777777777777777777777777770003';
  const a = await leftover(s, 700n), b = await leftover(s, 800n, { nonce: 1n });
  s.advance(3601);
  await s.keeper.tick();                                                        // 150,000 wei a send: one fits in 200,000
  assert.equal(reclaims(s).length, 1);
  const left = [a, b].find((x) => s.store.get(x).note !== 'swept');
  assert.notEqual(s.store.get(left).note, 'dust');
  assert.ok(s.logs.some((m) => /surplus waits: the day's budget/.test(m)));
  s.advance(86_401);
  await s.keeper.tick();
  assert.equal(reclaims(s).length, 2, 'a day on, it goes');
  assert.equal(s.store.get(left).note, 'swept');
});

await test('a funded box past its deadline is still completed (completion stays open while funded)', async () => {
  const s = setup();
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  s.advance(3700);
  await s.keeper.tick();
  assert.equal(s.store.get(box).status, 'completed');
});

await test('dry run proves and estimates but sends nothing', async () => {
  const s = setup({ cfg: { dryRun: true } });
  const { box } = await addDeposit(s);
  s.chain.fund(TOKEN, box, 1000n);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 1);
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.store.get(box).status, 'pending');
});

// ── receive boxes ──

const receiveNpk = receiveKeys(zk, alice, 0).npk;
async function addReceive(s, feeBps = 50) {
  const parsed = parseReceiveSubmission({ chainId: CHAIN_ID, npk: receiveNpk.toString(), feeBps }, { chainId: CHAIN_ID, cfg: s.cfg });
  const box = await s.chain.receiveBoxOf(parsed.intent.npk, parsed.intent.feeBps);
  s.store.addIntent({ box, kind: 'receive', intent: parsed.intent, reward: 0n, token: TOKEN, deadline: s.clock.t + s.cfg.receiveWatchSecs, now: s.clock.t });
  return box;
}

await test('receive intake: chain, npk range, fee cap floor', () => {
  const cfg = mkCfg({ minReceiveFeeBps: 5 });
  assert.throws(() => parseReceiveSubmission({ chainId: 8453, npk: '1', feeBps: 25 }, { chainId: CHAIN_ID, cfg }), /serves chain 1/);
  assert.throws(() => parseReceiveSubmission({ chainId: 1, npk: '0', feeBps: 25 }, { chainId: CHAIN_ID, cfg }), /non-zero/);
  assert.throws(() => parseReceiveSubmission({ chainId: 1, npk: (1n << 254n).toString(), feeBps: 25 }, { chainId: CHAIN_ID, cfg }), /out of range/);
  assert.throws(() => parseReceiveSubmission({ chainId: 1, npk: '7', feeBps: 10001 }, { chainId: CHAIN_ID, cfg }), /out of range/);
  assert.throws(() => parseReceiveSubmission({ chainId: 1, npk: '7', feeBps: 4 }, { chainId: CHAIN_ID, cfg }), /feeBps ≥ 5/);
  assert.deepEqual(parseReceiveSubmission({ chainId: '1', npk: '7', feeBps: 25 }, { chainId: CHAIN_ID, cfg }).intent, { npk: 7n, feeBps: 25 });
});

await test('a receive box is swept for its capped fee, stays watched, and is swept again after the next payment', async () => {
  const s = setup();
  const box = await addReceive(s, 50);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 0, 'an empty box is only watched');

  s.chain.fund(TOKEN, box, 100_000n);
  s.advance(s.cfg.maxBackoffSecs);
  await s.keeper.tick();
  assert.equal(s.chain.sent.length, 1);
  assert.equal(s.chain.sent[0].functionName, 'sweepReceive');
  assert.equal(await s.chain.balanceOf(TOKEN, box), 0n);
  assert.equal(await s.chain.balanceOf(TOKEN, KEEPER), 10n, 'the sweep\'s cost (the floor here), well under the 50 bps cap');
  assert.equal(s.store.get(box).status, 'pending');
  assert.equal(await s.chain.receiveCount(box), 1n);

  s.chain.fund(TOKEN, box, 40_000n);
  s.advance(s.cfg.pollSecs);
  await s.keeper.tick();
  assert.equal(s.chain.sent.length, 2);
  assert.equal(await s.chain.receiveCount(box), 2n);
  assert.equal(await s.chain.balanceOf(TOKEN, KEEPER), 20n);
});

await test('a sweep charges its cost, and the cap only when the cost is higher', async () => {
  const s = setup({ cfg: { minFees: new Map([[TOKEN.toLowerCase(), 40n]]), rates: new Map() } });
  const box = await addReceive(s, 50);
  s.chain.fund(TOKEN, box, 100_000n);
  await s.keeper.tick();
  assert.equal(await s.chain.balanceOf(TOKEN, KEEPER), 40n, 'cost 40, cap 500');
  const s2 = setup({ cfg: { minFees: new Map([[TOKEN.toLowerCase(), 600n]]), rates: new Map() } });
  const box2 = await addReceive(s2, 50);
  s2.chain.fund(TOKEN, box2, 100_000n);
  await s2.keeper.tick();
  assert.equal(s2.chain.sent.length, 0, 'cost 600 is above the 500 cap: not swept');
});

await test('a priced token\'s sweep charges its gas cost, not the relay minimum', async () => {
  const s = setup({ cfg: { minFees: new Map([[TOKEN.toLowerCase(), 10n ** 9n]]), rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), marginBps: 0n } });
  const box = await addReceive(s, 50);
  s.chain.fund(TOKEN, box, 200_000_000n);
  await s.keeper.tick();
  assert.equal(s.chain.sent.length, 1, 'swept although the 1,000,000 cap is below the relay minimum');
  assert.equal(await s.chain.balanceOf(TOKEN, KEEPER), s.cfg.sweepGas, 'charged its cost (gas at price 1), not the cap');
});

await test('a receive box whose capped fee does not cover gas waits for more funds; no proof is made', async () => {
  const s = setup();
  const box = await addReceive(s, 50);
  s.chain.fund(TOKEN, box, 1000n); // 5 in fees, below the 10 floor
  await s.keeper.tick();
  assert.equal(s.prover.calls, 0);
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.store.get(box).status, 'pending');
  s.chain.fund(TOKEN, box, 9000n);
  s.advance(s.cfg.maxBackoffSecs);
  await s.keeper.tick();
  assert.equal(s.chain.sent.length, 1);
});

await test('a sweep raced by another transaction or another sweep is re-proven with the fresh counter and root', async () => {
  const s = setup({ onProve: (k, chain) => { if (k === 1) chain.foreignTx(); } });
  const box = await addReceive(s, 50);
  s.chain.fund(TOKEN, box, 100_000n);
  await s.keeper.tick();
  assert.equal(s.prover.calls, 2);
  assert.equal(s.chain.sent.length, 1);

  // Someone else sweeps part of it between our proof and our estimate.
  const s2 = setup({ onProve: (k, chain) => { if (k === 1) { chain.counts.set(box.toLowerCase(), 1); chain.balances.set(`${TOKEN.toLowerCase()}:${box.toLowerCase()}`, 60_000n); } } });
  const box2 = await addReceive(s2, 50);
  assert.equal(box2, box);
  s2.chain.fund(TOKEN, box, 100_000n);
  await s2.keeper.tick();
  assert.equal(s2.prover.calls, 2);
  assert.equal(s2.chain.sent.length, 1);
  assert.equal(await s2.chain.balanceOf(TOKEN, KEEPER), 10n, 'one sweep\'s cost, on what was left');
});

await test('a receive box past its watch is still checked daily and swept when paid; at capacity a lapsed unfunded box makes room', async () => {
  const s = setup({ cfg: { receiveWatchSecs: 3000, receiveMaxBackoffSecs: 1000, receiveSlowSecs: 50000 } });
  const box = await addReceive(s, 50);
  for (let i = 0; i < 16; i++) { s.advance(60000); await s.keeper.tick(); }
  const r = s.store.get(box);
  assert.equal(r.status, 'pending');
  assert.ok(r.next_check - s.clock.t > 1000, 'lapsed boxes move to the slow check');
  s.chain.fund(TOKEN, box, 100_000n);
  s.advance(50000);
  await s.keeper.tick();
  assert.equal(s.chain.sent.length, 1, 'paid long after registration, still swept');
  assert.ok(s.store.get(box).deadline > s.clock.t, 'a sweep renews the watch');

  const idle = setup({ cfg: { receiveWatchSecs: 10 } });
  const old = await addReceive(idle, 50);
  idle.advance(100);
  assert.equal(idle.store.evictLapsedReceive(idle.clock.t), true);
  assert.equal(idle.store.get(old), undefined);
  assert.equal(idle.store.evictLapsedReceive(idle.clock.t), false);
});

await test('receive boxes back off to their own cap and do not count against deposit capacity', async () => {
  const s = setup({ cfg: { receiveMaxBackoffSecs: 1000, maxBackoffSecs: 100 } });
  const box = await addReceive(s, 50);
  for (let i = 0; i < 12; i++) { s.advance(2000); await s.keeper.tick(); }
  const r = s.store.get(box);
  assert.ok(r.next_check - s.clock.t > 100 && r.next_check - s.clock.t <= 1000);
  assert.equal(s.store.pendingCount(), 0);
  assert.equal(s.store.receiveCount(), 1);
});

// ── relay ──

function relayTx({ ext = -5000n, fee = 50n, relayer = KEEPER, recipient = REFUND, leaves = [0n, 0n] } = {}) {
  const s = (x) => x.toString();
  return {
    tx: {
      pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'],
      publicInputs: ['1', '1', '1', '0', '0', '0', s(assetField), '9', '0', s(leaves[0]), s(leaves[1])],
      recipient, extAmount: s(ext), relayer, fee: s(fee), memo0: '0x', memo1: '0x',
    },
  };
}

await test('relay parsing: pays this keeper, no deposits, field ranges, recipient for withdrawals', () => {
  const cfg = mkCfg();
  const ok = parseRelaySubmission(relayTx(), { keeper: KEEPER, cfg });
  assert.equal(ok.fee, 50n);
  assert.equal(ok.args[5], -5000n);
  assert.throws(() => parseRelaySubmission(relayTx({ relayer: REFUND }), { keeper: KEEPER, cfg }), /relayer must be this keeper/);
  assert.throws(() => parseRelaySubmission(relayTx({ ext: 1n }), { keeper: KEEPER, cfg }), /deposits are not relayed/);
  assert.throws(() => parseRelaySubmission(relayTx({ recipient: ETH }), { keeper: KEEPER, cfg }), /recipient/);
  const bigPub = relayTx(); bigPub.tx.publicInputs[7] = (1n << 254n).toString();
  assert.throws(() => parseRelaySubmission(bigPub, { keeper: KEEPER, cfg }), /out of range/);
  const short = relayTx(); short.tx.publicInputs.pop();
  assert.throws(() => parseRelaySubmission(short, { keeper: KEEPER, cfg }), /11 entries/);
  assert.equal(parseRelaySubmission(relayTx({ ext: 0n, recipient: ETH }), { keeper: KEEPER, cfg }).args[4], ETH);
});

await test('quoteFee: the smallest fee coverCheck accepts', () => {
  const cfg = mkCfg({ minFees: new Map([[ETH, 1000n]]), rates: new Map([[ETH, 10n ** 18n]]) });
  const q = quoteFee({ token: ETH, gas: 400000n, gasPrice: 10n, cfg });
  assert.equal(q, 4_800_000n);
  assert.ok(coverCheck({ reward: q, token: ETH, gas: 400000n, gasPrice: 10n, cfg }).ok);
  assert.ok(!coverCheck({ reward: q - 1n, token: ETH, gas: 400000n, gasPrice: 10n, cfg }).ok);
  assert.equal(quoteFee({ token: ETH, gas: 1n, gasPrice: 1n, cfg }), 1000n, 'never below the floor');
});

await test('a sweep subsidy lowers the smallest balance a receive box is moved in for, and a floor keeps dust out', async () => {
  // gas 600000 at price 1, margin 0, ETH at 1:1: a sweep costs 600000 wei, so its 25 bps cap needs 240,000,000 wei
  const base = { rates: new Map([[ETH, 10n ** 18n]]), minFees: new Map(), marginBps: 0n };
  const plain = mkCfg(base), sub = mkCfg({ ...base, sweepSubsidy: 500_000n }), floored = mkCfg({ ...base, sweepSubsidy: 500_000n, minReceive: new Map([[ETH, 10_000_000n]]) });
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 600_000n, cfg: plain }), 240_000_000n, 'unchanged with no subsidy');
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 600_000n, cfg: sub }), 40_000_000n, 'the cap pays only what the subsidy does not (100000 wei)');
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 600_000n, cfg: floored }), 40_000_000n, 'a floor under it changes nothing');
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 600_000n, cfg: mkCfg({ ...base, sweepSubsidy: 700_000n, minReceive: new Map([[ETH, 10_000_000n]]) }) }), 10_000_000n, 'a subsidy over the whole cost: the floor alone');
  assert.equal(subsidyOf({ token: TOKEN, cfg: sub }), 0n, 'nothing for a token with no price');
  assert.equal(subsidyOf({ token: ETH, cfg: sub }), 500_000n);
  // a box holding 50,000,000 (cap 125,000 wei): too little to be worth it plain, swept with the subsidy
  for (const [cfg, swept] of [[plain, 0], [sub, 1]]) {
    const s = setup({ cfg: { ...cfg, rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), minFees: new Map() } });
    const box = await addReceive(s, 25);
    s.chain.fund(TOKEN, box, 50_000_000n);
    await s.keeper.tick();
    assert.equal(s.chain.sent.length, swept, swept ? 'swept with the subsidy' : 'not swept without it');
  }
  // dust under the floor is left alone even with the subsidy
  const d = setup({ cfg: { ...floored, rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), minFees: new Map(), minReceive: new Map([[TOKEN.toLowerCase(), 10_000_000n]]) } });
  const dbox = await addReceive(d, 25);
  d.chain.fund(TOKEN, dbox, 1_000_000n);
  await d.keeper.tick();
  assert.equal(d.chain.sent.length, 0, 'a balance under the floor is not swept at a loss');
});

await test('a sweep whose estimate is above the gas assumed is sized on the estimate: it still lands, and the next quote and floor follow it', async () => {
  forgetSweepGas();
  // 1 wei per token unit and per gas; assumed 385,000 gas, the chain estimates 400,000 (4% more); margin 20%, subsidy 97.5%, floor 10x
  const base = { rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), minFees: new Map(), marginBps: 2000n, sweepGas: 385_000n, sweepSubsidy: 10n ** 9n, sweepSubsidyBps: 9750, receiveMinMult: 10 };
  const s = setup({ cfg: base });
  assert.equal(sweepGasOf({ chain: s.chain, cfg: s.cfg }), 385_000n);
  // cost at the assumed gas 462,000, at the estimate 480,000; a box of 12x the first: the 25 bps cap pays 13,860, the subsidy 468,000
  const box = await addReceive(s, 25);
  s.chain.fund(TOKEN, box, 5_544_000n);
  await s.keeper.tick();
  assert.equal(s.chain.sent.length, 1, 'swept: the subsidy follows the estimate (sized on the assumed gas it would have fallen 15,000 short)');
  assert.equal(sweepGasOf({ chain: s.chain, cfg: s.cfg }), 400_000n, 'the estimate is remembered');
  // 10.17x the assumed cost, but under the 10x floor of the cost it really has: now left alone before any proof is made
  const calls = s.prover.calls;
  const b2 = await addReceive(s, 26);
  s.chain.fund(TOKEN, b2, 4_700_000n);
  await s.keeper.tick();
  assert.equal(s.prover.calls, calls, 'no proof is made for a balance the learned cost puts under the floor');
  assert.equal(s.chain.sent.length, 1);
  assert.equal(s.logs.filter((m) => m.includes(b2) && /skipped/.test(m)).length, 1, 'and why is said');
  await s.keeper.tick();
  assert.equal(s.logs.filter((m) => m.includes(b2) && /skipped/.test(m)).length, 1, 'once');
  forgetSweepGas();
});

await test('a funded box that was skipped is looked at again within two minutes, and a start looks at every box left with a note', async () => {
  forgetSweepGas();
  // priced token, no subsidy, the cap pays less than the cost: skipped, again and again
  const cfg = { rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), minFees: new Map(), marginBps: 0n, sweepGas: 400_000n, pollSecs: 10, receiveMaxBackoffSecs: 1800 };
  const s = setup({ cfg });
  const box = await addReceive(s, 25);
  s.chain.fund(TOKEN, box, 1_000_000n);   // cap 2,500 against a cost of 400,000
  for (let i = 0; i < 12; i++) {
    await s.keeper.tick();
    const row = s.store.get(box);
    assert.ok(row.next_check - s.clock.t <= 120, `look ${i + 1}: next in ${row.next_check - s.clock.t} s`);
    s.advance(row.next_check - s.clock.t);
  }
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.logs.filter((m) => /skipped/.test(m)).length, 1, 'said once');
  // a long wait left by an earlier start (a note, a next check far off) is cut short by a start
  s.store.update(box, { next_check: s.clock.t + 1800, checks: 9, note: 'reward worth 1 wei is below the 2 wei cost' });
  const quiet = s.store.get(box).next_check;
  const logs = [];
  createKeeper({ store: s.store, chain: s.chain, prover: s.prover, zk, assetField, leafSync: s.leafSync, cfg: s.cfg, now: () => s.clock.t, log: (m) => logs.push(m) });
  assert.ok(s.store.get(box).next_check < quiet && s.store.get(box).next_check <= s.clock.t, 'due now');
  assert.equal(s.store.get(box).checks, 0);
  assert.match(logs.join(''), /1 receive box left with a note/);
  // swept boxes and boxes without a note keep their schedule
  s.store.update(box, { next_check: s.clock.t + 1800, note: 'swept' });
  createKeeper({ store: s.store, chain: s.chain, prover: s.prover, zk, assetField, leafSync: s.leafSync, cfg: s.cfg, now: () => s.clock.t, log: () => {} });
  assert.equal(s.store.get(box).next_check, s.clock.t + 1800);
});

await test('the subsidy is a bounded share of the live cost: it follows gas, is capped when gas spikes, and a signer\'s budget and reserve end it', async () => {
  const base = { rates: new Map([[ETH, 10n ** 18n]]), minFees: new Map(), marginBps: 0n, sweepSubsidy: 300_000n, sweepSubsidyBps: 9500, receiveMinMult: 20 };
  const cfg = mkCfg(base);
  // cost 100,000: 95% absorbed (95,000), the cap (25 bps) covers 5,000, so 2,000,000 by the cap; the 20x floor is 2,000,000 too
  assert.equal(subsidyOf({ token: ETH, cost: 100_000n, cfg }), 95_000n);
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 100_000n, cfg }), 2_000_000n, '20 times the cost, not 400 times');
  // gas ten times higher: the cap on the subsidy (300,000) binds and the minimum rises with it: the keeper's loss is bounded
  assert.equal(subsidyOf({ token: ETH, cost: 1_000_000n, cfg }), 300_000n);
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 1_000_000n, cfg }), 280_000_000n, '(1,000,000 - 300,000) x 400');
  // a priced token follows its rate: 1 token unit = 2 wei of value, so the same cost is half as many units
  const tcfg = mkCfg({ ...base, rates: new Map([[TOKEN.toLowerCase(), 2n * 10n ** 18n]]) });
  assert.equal(subsidyOf({ token: TOKEN, cost: 50_000n, cfg: tcfg }), 47_500n);
  assert.equal(receiveFloorOf({ token: TOKEN, cost: 50_000n, cfg: tcfg }), 1_000_000n);
  // a day's budget, one per signer: once spent, the minimum is the plain one until it rolls off
  let held = 10n ** 18n;
  const chain = { chainId: 1, address: '0x00000000000000000000000000000000000000AA', balanceOf: async () => held };
  const dcfg = mkCfg({ ...base, sweepSubsidyDaily: 150_000n }), dcfg2 = mkCfg({ ...base, sweepSubsidyDaily: 150_000n });
  const room = (c, at) => subsidyRoom({ chain, cfg: c, at, maxAgeMs: 0 });
  assert.equal(await room(dcfg, 1000), 150_000n);
  assert.equal(subsidyOf({ token: ETH, cost: 100_000n, cfg: dcfg, room: await room(dcfg, 1000) }), 95_000n);
  absorbed({ token: ETH, tokens: 95_000n, cfg: dcfg, chain, at: 1000 });
  assert.equal(await room(dcfg2, 1100), 55_000n, 'another pool of the same signer sees the same budget');
  assert.equal(subsidyOf({ token: ETH, cost: 100_000n, cfg: dcfg, room: await room(dcfg, 1100) }), 55_000n, 'what is left of the budget');
  absorbed({ token: ETH, tokens: 55_000n, cfg: dcfg2, chain, at: 1100 });
  assert.equal(subsidyOf({ token: ETH, cost: 100_000n, cfg: dcfg, room: await room(dcfg, 1200) }), 0n, 'the budget is spent');
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 100_000n, cfg: dcfg, room: await room(dcfg, 1200) }), 40_000_000n, 'back to 400 times the cost');
  assert.equal(await room(dcfg, 1100 + 86_401), 150_000n, 'a day later it is back');
  const other = { ...chain, address: '0x00000000000000000000000000000000000000BB' };
  assert.equal(await subsidyRoom({ chain: other, cfg: dcfg, at: 1200, maxAgeMs: 0 }), 150_000n, 'another signer has a budget of its own');
  // the reserve: only the ETH the signer holds beyond it may be taken on
  const rcfg = mkCfg({ ...base, subsidyReserve: 1_000_000n });
  held = 1_300_000n;
  assert.equal(await subsidyRoom({ chain, cfg: rcfg, at: 5000, maxAgeMs: 0 }), 300_000n);
  held = 900_000n;
  assert.equal(await subsidyRoom({ chain, cfg: rcfg, at: 5000, maxAgeMs: 0 }), 0n, 'under the reserve: none');
  assert.equal(receiveMinOf({ token: ETH, sweepFee: 100_000n, cfg: rcfg, room: 0n }), 40_000_000n, 'and the minimum is the plain one');
  assert.equal(await subsidyRoom({ chain: { ...chain, balanceOf: async () => { throw new Error("rpc down"); } }, cfg: rcfg, at: 5000, maxAgeMs: 0 }), 0n, 'a balance that cannot be read stops it');
  held = 1_300_000n;
  assert.equal(await subsidyRoom({ chain, cfg: mkCfg({ ...base, sweepSubsidyDaily: 100_000n, subsidyReserve: 1_000_000n }), at: 200_000, maxAgeMs: 0 }), 100_000n, 'the lesser of the budget and the spare ETH');
  assert.equal(await subsidyRoom({ chain, cfg: mkCfg(base), at: 200_000, maxAgeMs: 0 }), null, 'no bound when neither is set');
  assert.equal(subsidyOf({ token: ETH, cost: 100_000n, cfg: mkCfg({ ...base, sweepSubsidy: 0n }) }), 0n, 'off by default');
});

await test('a receive box just registered is looked at again in seconds, an old one after the poll interval doubled; the loop can ask when the next is due', async () => {
  const s = setup({ cfg: { pollSecs: 15, receiveFastSecs: 3, receiveFreshSecs: 300, receiveMaxBackoffSecs: 1800 } });
  assert.equal(s.store.nextDue(), null, 'nothing pending, nothing due');
  const box = await addReceive(s, 25);
  assert.equal(s.store.nextDue(), s.store.get(box).next_check, 'a box registered is due at once');
  const waits = [];
  for (let i = 0; i < 5; i++) {
    const at = s.clock.t;
    await s.keeper.tick();                                          // empty box: nothing to sweep, looked at again later
    const r = s.store.get(box);
    waits.push(r.next_check - at);
    assert.equal(s.keeper.nextDue(), r.next_check, 'the loop is told when it falls due');
    s.advance(r.next_check - at);
  }
  assert.deepEqual(waits, [3, 6, 12, 24, 48], 'fresh: 3 s, doubling');
  const old = setup({ cfg: { pollSecs: 15, receiveFastSecs: 3, receiveFreshSecs: 300, receiveMaxBackoffSecs: 1800 } });
  const oldBox = await addReceive(old, 25);
  old.advance(1000);                                                // registered over 300 s ago
  const at = old.clock.t;
  await old.keeper.tick();
  assert.equal(old.store.get(oldBox).next_check - at, 30, 'an old box: the poll interval doubled, as before');
  // asked about again (the deadline is renewed, as registering again does): fresh again
  old.store.update(oldBox, { status: 'pending', next_check: old.clock.t, checks: 0, deadline: old.clock.t + old.cfg.receiveWatchSecs });
  const again = old.clock.t;
  await old.keeper.tick();
  assert.equal(old.store.get(oldBox).next_check - again, 3, 'a box asked about again is looked at in seconds again');
});

await test('registering or asking again about a box wakes the keeper loop; a refused registration does not', async () => {
  const cfg = mkCfg({ ratePerMin: 1000 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  let woken = 0;
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => T0, log: () => {}, onDue: () => { woken++; } });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/evm-pool/keeper`;
  try {
    const bad = await fetch(base + '/receive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ npk: 'nope' }) });
    assert.ok(bad.status >= 400);
    assert.equal(woken, 0, 'nothing registered, nothing to look at');
    const body = JSON.stringify({ chainId: CHAIN_ID, npk: receiveNpk.toString(), feeBps: 25 });
    assert.equal((await fetch(base + '/receive', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 200);
    assert.equal(woken, 1, 'a box registered is looked at now');
    assert.equal((await fetch(base + '/receive', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 200);
    assert.equal(woken, 2, 'and so is one asked about again');
  } finally { server.close(); }
});

await test('a large answer is sent compressed to a client that takes it, whole and identical, and plain to one that does not', async () => {
  const cfg = mkCfg({ ratePerMin: 1000 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  for (let i = 0; i < 40; i++) chain.foreignTx();
  const leafSync = makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: 2n, logChunk: 50n });
  await leafSync.sync();
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => T0, log: () => {}, leafSync });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const get = (path, enc) => new Promise((resolve, reject) => http.get({ port, path: `/evm-pool/keeper${path}`, headers: { 'accept-encoding': enc } }, (res) => {
    const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject));
  try {
    const plain = await get('/events?from=0', 'identity');
    const packed = await get('/events?from=0', 'gzip');
    assert.ok(plain.body.length > 2048, `a page worth compressing (${plain.body.length} B)`);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(packed.headers['content-encoding'], 'gzip');
    assert.equal(packed.headers.vary, 'Accept-Encoding');
    assert.ok(packed.body.length < plain.body.length / 2, `smaller: ${packed.body.length} against ${plain.body.length}`);
    assert.equal(gunzipSync(packed.body).toString(), plain.body.toString(), 'the same answer');
    const small = await get('/info', 'gzip');
    assert.equal(small.headers['content-encoding'], undefined, 'a small one is not worth it');
  } finally { server.close(); }
});

await test('a quote a little old is given at once while a new one is made, so a slow node never makes a page wait', async () => {
  const cfg = mkCfg({ ratePerMin: 1000, quoteCacheMs: 40, quoteStaleMs: 60_000 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  let slow = 0;
  chain.canFront = async () => { if (slow) await new Promise((r) => setTimeout(r, slow)); return { ok: true }; };
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => T0, log: () => {} });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/evm-pool/keeper`;
  const ask = async () => { const t = Date.now(); const r = await fetch(`${base}/quote`); return { ms: Date.now() - t, status: r.status, body: await r.json() }; };
  try {
    const first = await ask();
    assert.equal(first.status, 200);
    await new Promise((r) => setTimeout(r, 80));                    // past the shared window, inside the stale one
    slow = 600;                                                      // the node behind the quote is now slow
    const second = await ask();
    assert.equal(second.status, 200);
    assert.ok(second.ms < 300, `answered from the last good quote at once (${second.ms} ms)`);
    assert.deepEqual(second.body, first.body);
    chain.gas = 9n;                                                  // the price moves while the renewal runs
    const during = await ask();
    assert.ok(during.ms < 300, 'a second ask while it renews is also at once');
    await new Promise((r) => setTimeout(r, 900));                    // the renewal is done
    slow = 0;
    const later = await ask();
    assert.equal(later.status, 200);
    // a refusal is shown, not hidden behind an old answer
    chain.canFront = async () => ({ ok: false });
    await new Promise((r) => setTimeout(r, 80));
    const refused = await ask();                                     // served stale once while the refusal is found …
    await new Promise((r) => setTimeout(r, 100));
    const then = await ask();
    assert.equal(then.status, 503, `the refusal shows once it is found (${refused.status} then ${then.status})`);
    chain.canFront = async () => ({ ok: true });
    assert.equal((await ask()).status, 200, 'and is gone as soon as it is');
  } finally { server.close(); }
});

await test('a read node that does not answer is left for the next after the timeout, and a list of dead nodes fails in bounded time', async () => {
  const listen = (handler) => new Promise((r) => { const sv = createServer(handler); sv.listen(0, '127.0.0.1', () => r(sv)); });
  const hung = [await listen(() => {}), await listen(() => {})];                                    // accept the request, never answer
  const good = await listen((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { const j = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: j.method === 'eth_chainId' ? '0x1' : '0x10' })); });
  });
  const url = (sv) => `http://127.0.0.1:${sv.address().port}`;
  try {
    const reader = readerFor([url(hung[0]), url(good)], { ms: 300, rankSecs: 0 });
    let t0 = Date.now();
    assert.equal(await reader.getBlockNumber(), 16n, 'answered by the second node');
    assert.ok(Date.now() - t0 < 1500, `after one timeout, not after viem's 10 s (${Date.now() - t0} ms)`);
    assert.equal(readerFor([url(hung[0]), url(good)], { ms: 300, rankSecs: 0 }), reader, 'one client for one list, shared by every keeper that reads it');
    const dead = readerFor([url(hung[0]), url(hung[1])], { ms: 300, rankSecs: 0 });
    t0 = Date.now();
    await assert.rejects(dead.getBlockNumber());
    assert.ok(Date.now() - t0 < 4000, `a list that never answers gives up in seconds, not minutes (${Date.now() - t0} ms)`);
  } finally { for (const sv of [...hung, good]) { sv.closeAllConnections?.(); sv.close(); } }
});

await test('HTTP relay and receive: quote, submit, stale → 409, low fee → needFee, receive watch + nudge', async () => {
  const cfg = mkCfg({ ratePerMin: 100 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const logs = [];
  let t = T0;
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => t, log: (m) => logs.push(m) });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/evm-pool/keeper`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const q = await (await fetch(`${base}/quote`)).json();
    assert.equal(q.relayer, KEEPER);
    assert.equal(q.fee, '10');
    assert.equal(q.sweepFee, '10');
    assert.equal(q.receiveMin, '4000', 'the smallest balance whose 25 bps covers a sweep');

    let r = await post('/relay', relayTx());
    assert.equal(r.status, 200);
    assert.match((await r.json()).txHash, /^0x/);
    assert.equal(await chain.balanceOf(TOKEN, REFUND), 5000n);
    assert.equal(await chain.balanceOf(TOKEN, KEEPER), 50n);

    r = await post('/relay', relayTx({ fee: 5n }));
    assert.equal(r.status, 400);
    const low = await r.json();
    assert.match(low.error, /fee too low/);
    assert.equal(low.needFee, '10');

    chain.transactRevert = 'StaleRoot';
    r = await post('/relay', relayTx());
    assert.equal(r.status, 409);
    assert.equal((await r.json()).stale, true);
    chain.transactRevert = 'AlreadyNullified';
    r = await post('/relay', relayTx());
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /AlreadyNullified/);
    chain.transactRevert = null;

    // The same spend twice while the first is in flight: the second is refused, not sent to revert.
    chain.receiptMode = 'pending';
    const again = relayTx({ ext: -100n });
    again.tx.publicInputs[7] = '4242';
    assert.equal((await post('/relay', again)).status, 200);
    const dup = await post('/relay', again);
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /already being relayed/);
    chain.receiptMode = 'success';

    r = await post('/receive', { chainId: CHAIN_ID, npk: receiveNpk.toString(), feeBps: 25 });
    assert.equal(r.status, 200);
    const w = await r.json();
    assert.equal(w.status, 'watching');
    assert.equal(w.box, await chain.receiveBoxOf(receiveNpk, 25));
    store.update(w.box, { next_check: t + 5000 });
    t += 10;
    await post('/receive', { chainId: CHAIN_ID, npk: receiveNpk.toString(), feeBps: 25 });
    assert.equal(store.get(w.box).next_check, t, 're-posting asks for a look now');
    assert.equal(store.get(w.box).deadline, t + cfg.receiveWatchSecs, 're-posting renews the watch');
    assert.equal(store.receiveCount(), 1);
    // A lapsed box comes back when posted again, even at capacity.
    store.update(w.box, { status: 'expired' });
    const full = createServer(createIntakeHandler({ store, chain, zk, assetField, cfg: { ...cfg, maxReceive: 0 }, now: () => t }));
    await new Promise((res) => full.listen(0, res));
    try {
      const again2 = await fetch(`http://127.0.0.1:${full.address().port}/evm-pool/keeper/receive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: CHAIN_ID, npk: receiveNpk.toString(), feeBps: 25 }) });
      assert.equal(again2.status, 200);
      assert.equal((await again2.json()).status, 'watching');
      store.update(w.box, { funded_at: t }); // a box that has held funds is kept; one that never did makes room
      const other = await fetch(`http://127.0.0.1:${full.address().port}/evm-pool/keeper/receive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: CHAIN_ID, npk: '99', feeBps: 25 }) });
      assert.equal(other.status, 503, 'a new box at capacity is refused');
    } finally { full.close(); }

    const off = createServer(createIntakeHandler({ store, chain, zk, assetField, cfg: { ...cfg, relay: false } }));
    await new Promise((res) => off.listen(0, res));
    try {
      assert.equal((await fetch(`http://127.0.0.1:${off.address().port}/evm-pool/keeper/relay`, { method: 'POST', body: '{}' })).status, 404);
    } finally { off.close(); }
  } finally { server.close(); }
});

// ── relay with a call or a wrap ──

const ZAP_TARGET = '0x8888888888888888888888888888888888888888';
const USDC = '0x9999999999999999999999999999999999999999';
function makeCall({ deadline = T0 + 600, to = REFUND } = {}) {
  return callIntent({
    calls: [v1ZapShieldedNoteCall({ confidentialRouter: ZAP_TARGET, value: 4000n, tokenOut: USDC, wrapAmount: 10n, commit: '0x' + 'c1'.repeat(32), zrSwapData: '0x1234' })],
    outputs: [{ token: USDC, min: 0n }], to, refund: REFUND, deadline, nonce: 5n,
  });
}

await test('call intents: the gateway\'s escrow salt is abi.encode(tag, intent) as viem encodes it for the router ABI', () => {
  const intent = makeCall();
  const salt = viemKeccak(encodeAbiParameters(
    [{ type: 'bytes32' }, ROUTER_ABI.find((f) => f.name === 'callEscrowOf').inputs[0]],
    [viemKeccak(toHex('tacit-evm-pool-call-escrow-v1')), intent],
  ));
  const r = ROUTER.slice(2).toLowerCase();
  const impl = viemKeccak(`0xd694${r}01`).slice(26);
  const init = viemKeccak(`0x602d5f8160095f39f35f5f365f5f37365f73${impl}5af43d5f5f3e6029573d5ffd5b3d5ff3`);
  const want = '0x' + viemKeccak(`0xff${r}${salt.slice(2)}${init.slice(2)}`).slice(26);
  assert.equal(callEscrowAddress(intent, ROUTER).toLowerCase(), want);
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'callEscrowOf', args: [intent] });
  assert.deepEqual(decodeFunctionData({ abi: ROUTER_ABI, data }).args[0].calls[0].data, intent.calls[0].data);
});

await test('relay parsing with a call: recipient must be the escrow, a withdrawal, a live deadline', () => {
  const cfg = mkCfg();
  const intent = makeCall();
  const escrow = callEscrowAddress(intent, ROUTER);
  const body = { ...relayTx({ recipient: escrow }), call: callIntentJson(intent) };
  const p = parseRelaySubmission(body, { keeper: KEEPER, cfg, router: ROUTER, now: T0 });
  assert.equal(p.functionName, 'withdrawAndCall');
  assert.equal(p.sendArgs[1].calls[0].value, 4000n);
  assert.equal(p.sendArgs[0].recipient.toLowerCase(), escrow.toLowerCase());
  assert.throws(() => parseRelaySubmission({ ...relayTx(), call: callIntentJson(intent) }, { keeper: KEEPER, cfg, router: ROUTER, now: T0 }), /escrow/);
  assert.throws(() => parseRelaySubmission({ ...relayTx({ recipient: escrow, ext: 0n }), call: callIntentJson(intent) }, { keeper: KEEPER, cfg, router: ROUTER, now: T0 }), /withdrawal/);
  assert.throws(() => parseRelaySubmission(body, { keeper: KEEPER, cfg, router: ROUTER, now: T0 + 601 }), /deadline/);
  const tampered = callIntentJson(intent); tampered.to = KEEPER;
  assert.throws(() => parseRelaySubmission({ ...relayTx({ recipient: escrow }), call: tampered }, { keeper: KEEPER, cfg, router: ROUTER, now: T0 }), /escrow/);
  const many = callIntentJson(intent); many.calls = Array(9).fill(many.calls[0]);
  assert.throws(() => parseRelaySubmission({ ...relayTx({ recipient: escrow }), call: many }, { keeper: KEEPER, cfg, router: ROUTER, now: T0 }), /1 to 8/);
  assert.throws(() => parseRelaySubmission({ ...body, wrap: makeWrap().intent }, { keeper: KEEPER, cfg, router: ROUTER, now: T0 }), /either/);
  assert.equal(parseRelaySubmission(relayTx(), { keeper: KEEPER, cfg, router: ROUTER, now: T0 }).functionName, 'pool.transact');
});

await test('HTTP relay sends withdrawAndCall and withdrawToV1 through the router', async () => {
  const cfg = mkCfg({ ratePerMin: 100 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => T0 });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/evm-pool/keeper/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const intent = makeCall();
    const escrow = callEscrowAddress(intent, ROUTER);
    const tx = relayTx({ recipient: escrow });
    tx.tx.publicInputs[7] = '777';
    let r = await post({ ...tx, call: callIntentJson(intent) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(chain.sent.at(-1).functionName, 'withdrawAndCall');
    assert.equal(await chain.balanceOf(TOKEN, escrow), 5000n);

    chain.callRevert = 'ShortOutput';
    const tx2 = relayTx({ recipient: escrow }); tx2.tx.publicInputs[7] = '778';
    r = await post({ ...tx2, call: callIntentJson(intent) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /ShortOutput/);
    chain.callRevert = null;

    const wrap = makeWrap().intent;
    const parsedWrap = parseWrapSubmission({ intent: wrap }, { now: T0, cfg: { ...cfg, minDeadlineSecs: 0 } }).intent;
    const box = await chain.wrapBoxOf(parsedWrap);
    const tw = relayTx({ recipient: box }); tw.tx.publicInputs[7] = '779';
    r = await post({ ...tw, wrap });
    assert.equal(r.status, 200);
    assert.equal(chain.sent.at(-1).functionName, 'withdrawToV1');
    const tw2 = relayTx(); tw2.tx.publicInputs[7] = '780';
    r = await post({ ...tw2, wrap });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /wrap intent's box/);
  } finally { server.close(); }
});

// The error viem raises when a node answers an estimate with `reply`: { error } is a JSON-RPC error, { status } an HTTP failure, { reset } a dropped line.
async function viemEstimateError(reply) {
  const node = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (reply.reset) return req.socket.destroy();
      if (reply.status) { res.writeHead(reply.status); return res.end('no'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(b).id, error: reply.error }));
    });
  });
  await new Promise((r) => node.listen(0, r));
  const client = createPublicClient({ transport: viemHttp(`http://127.0.0.1:${node.address().port}`, { retryCount: 0, timeout: 3000 }) });
  const intent = { amount: 1n, outLeaf0: 1n, outLeaf1: 2n, memo0Hash: '0x' + '11'.repeat(32), memo1Hash: '0x' + '22'.repeat(32), refund: REFUND, deadline: 1n, nonce: 1n };
  try { await client.estimateContractGas({ address: ROUTER, abi: ROUTER_ABI, functionName: 'reclaimDeposit', args: [intent, ETH], account: KEEPER }); }
  catch (e) { return e; }
  finally { node.closeAllConnections?.(); node.close(); }
  throw new Error('the stub node was meant to fail the estimate');
}

await test('a relay whose estimate fails says why: a revert is final and named, a node that did not answer is a try-again', async () => {
  const cfg = mkCfg({ ratePerMin: 100_000 });
  const intent = makeCall();
  const escrow = callEscrowAddress(intent, ROUTER);
  const timeout = Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' });
  const tryAgain = /could not check this transaction right now/;
  const cases = [
    [timeout, 503, tryAgain],
    [new Error('HTTP request failed. Status: 429 Too Many Requests'), 503, tryAgain],
    [revert('BadProof'), 400, /^the transaction reverts: BadProof$/],
    [new Error('execution reverted'), 400, /^the transaction reverts$/],
    [revert('StaleRoot'), 409, /StaleRoot/],
    // as viem shapes what a node says: a JSON-RPC internal error comes back as a ContractFunctionRevertedError too, and is not a revert
    [await viemEstimateError({ error: { code: 3, message: 'execution reverted: custom error 0xfddb35b3', data: '0xfddb35b3' } }), 400, /^the transaction reverts: NothingToReclaim$/],
    [await viemEstimateError({ error: { code: 3, message: 'execution reverted', data: '0x' } }), 400, /^the transaction reverts$/],
    [await viemEstimateError({ error: { code: -32000, message: 'execution reverted' } }), 400, /^the transaction reverts$/],
    [await viemEstimateError({ error: { code: -32603, message: 'internal error' } }), 503, tryAgain],
    [await viemEstimateError({ error: { code: -32603, message: 'backend error: failed to get account for 0x44: error sending request for url' } }), 503, tryAgain],
    [await viemEstimateError({ error: { code: -32005, message: 'rate limit exceeded' } }), 503, tryAgain],
    [await viemEstimateError({ status: 502 }), 503, tryAgain],
    [await viemEstimateError({ reset: true }), 503, tryAgain],
  ];
  // The two places a relay is checked: straight against the chain (a transaction that inserts nothing, or a keeper with no queue), and at the front of the queue (a call that inserts a note).
  for (const queued of [false, true]) {
    const chain = mockChain();
    const pipeline = queued ? { busy: async () => false, append: async (_tx, send) => send({ simulate: true }), size: () => 0 } : undefined;
    const server = createServer(createIntakeHandler({ store: openKeeperStore(':memory:'), chain, zk, assetField, pipeline, cfg, now: () => T0 }));
    await new Promise((r) => server.listen(0, r));
    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/evm-pool/keeper/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const body = (nf) => { const b = { ...relayTx({ recipient: escrow, leaves: queued ? [11n, 12n] : [0n, 0n] }), call: callIntentJson(intent) }; b.tx.publicInputs[7] = String(nf); return b; };
    try {
      for (const [error, status, text] of cases) {
        chain.estimateError = error;
        const r = await post(body(900));
        const j = await r.json();
        assert.equal(r.status, status, `${queued ? 'queued' : 'direct'}, ${error.message}: ${JSON.stringify(j)}`);
        assert.match(j.error, text);
      }
      assert.equal(chain.sent.length, 0, 'none of the refusals sent anything');
      chain.estimateError = null;
      const ok = await post(body(901));
      assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
      assert.equal(chain.sent.length, 1, 'and an answering node lets it through');
    } finally { server.close(); }
  }
});

await test('/quote carries what completing a deposit box costs, at the keeper\'s own deposit gas', async () => {
  const cfg = mkCfg({ ratePerMin: 1000, depositGas: 600_000n, rates: new Map([[TOKEN.toLowerCase(), 10n ** 18n]]), marginBps: 2000n });
  const chain = mockChain();
  chain.gas = 50n;
  const server = createServer(createIntakeHandler({ store: openKeeperStore(':memory:'), chain, zk, assetField, cfg, now: () => T0 }));
  await new Promise((r) => server.listen(0, r));
  try {
    const q = await (await fetch(`http://127.0.0.1:${server.address().port}/evm-pool/keeper/quote`)).json();
    assert.equal(q.depositGas, '600000');
    assert.equal(q.depositFee, String(600_000n * 50n * 12n / 10n), 'the gas at the gas price with the 20% margin, in a token worth a wei');
    assert.equal(q.depositFee, quoteFee({ token: TOKEN, gas: 600_000n, gasPrice: 50n, cfg }).toString());
    assert.notEqual(q.depositFee, q.fee, 'a relay\'s own fee is for its own gas');
  } finally { server.close(); }
});

await test('frontFees: full headroom when the balance covers it, less when it does not, refused below this block', () => {
  const g = 1_000_000n, base = 10n, prio = 1n;
  let f = frontFees({ base, prio, balance: 100_000_000n, gas: g });
  assert.deepEqual([f.ok, f.headroom, f.maxFeePerGas, f.maxPriorityFeePerGas], [true, true, 21n, 1n], 'twice the base fee plus the tip');
  f = frontFees({ base, prio, balance: 15_000_000n, gas: g });
  assert.deepEqual([f.ok, f.headroom, f.maxFeePerGas], [true, false, 15n], 'headroom comes down to what the balance fronts');
  f = frontFees({ base, prio, balance: 11_000_000n, gas: g });
  assert.deepEqual([f.ok, f.maxFeePerGas], [true, 11n], 'exactly this block still sends');
  f = frontFees({ base, prio, balance: 10_999_999n, gas: g });
  assert.deepEqual([f.ok, f.need], [false, 11_000_000n], 'below this block it cannot send at all');
});

await test('a keeper that cannot front a send says so on /quote and /relay (503) instead of taking the job', async () => {
  const cfg = mkCfg({ ratePerMin: 100 });
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  let room = { ok: false };
  chain.canFront = async () => room;
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, now: () => T0, log: () => {} });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/evm-pool/keeper`;
  try {
    let r = await fetch(`${base}/quote`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /relay is busy with other sends.*your own wallet/);
    r = await fetch(base + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relayTx()) });
    assert.equal(r.status, 503);
    assert.equal(chain.sent.length, 0, 'nothing was sent');
    room = { ok: true };
    assert.equal((await fetch(`${base}/quote`)).status, 200);
  } finally { server.close(); }
});

await test('a token pool with no price for its token and no fixed minimum quotes nothing (503), and quotes again once a price is read', async () => {
  const cfg = mkCfg({ ratePerMin: 100 });
  cfg.minFees.delete(TOKEN.toLowerCase()); cfg.rates.delete(TOKEN.toLowerCase());
  const handler = createIntakeHandler({ store: openKeeperStore(':memory:'), chain: mockChain(), zk, assetField, cfg, now: () => T0, log: () => {} });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/evm-pool/keeper`;
  try {
    const r = await fetch(`${base}/quote`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /can't price its fee/);
    cfg.rates.set(TOKEN.toLowerCase(), 5n * 10n ** 14n);
    const q = await (await fetch(`${base}/quote`)).json();
    assert.ok(BigInt(q.fee) > 0n, `a fee once priced (${q.fee})`);
  } finally { server.close(); }
});

// ── the private route (dapp/sealed-request.js): sealed requests, a forwarder in front of the keeper ──

const GATEWAY_SECRET = 'a1'.repeat(32);
const GATEWAY_PUB = Buffer.from(gatewayKeys(GATEWAY_SECRET).pub).toString('hex');
const listen = (server) => new Promise((r) => server.listen(0, r));

// A keeper's handler behind a real server, and a forwarder in front of it behind another; `sf` is a wallet's sealed fetch through it.
async function privateRoute({ cfg = {}, fetchImpl } = {}) {
  const store = openKeeperStore(':memory:');
  const logs = [];
  const handler = createIntakeHandler({ store, chain: mockChain(), zk, assetField, cfg: mkCfg({ gatewayKey: GATEWAY_SECRET, ...cfg }), now: () => T0, log: (m) => logs.push(m) });
  const keeper = createServer(handler);
  await listen(keeper);
  const base = `http://127.0.0.1:${keeper.address().port}/evm-pool/keeper`;
  const forwarded = [];
  const fwd = createServer(makeForwarder({ gateways: { 1: `${base}/sealed` }, fetchImpl: async (url, init) => { forwarded.push({ headers: init.headers, body: init.body }); return fetch(url, init); } }));
  await listen(fwd);
  const fwdUrl = `http://127.0.0.1:${fwd.address().port}`;
  const sf = makeSealedFetch({ keeper: base, chainId: 1, gateway: GATEWAY_PUB, forwarders: [fwdUrl], fetchImpl, now: () => T0 });
  return { store, logs, base, fwdUrl, forwarded, sf, close: () => { keeper.close(); fwd.close(); } };
}
const jsonInit = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

await test('wallets that ask for /head at once share one read, a failed read is not kept, and a read begun before the queue moved is not shared after', async () => {
  const chain = mockChain();
  const real = chain.poolState;
  const held = [];
  let fail = false;
  chain.poolState = async (b) => {
    await new Promise((r) => held.push(r));
    if (fail) throw new Error('node down');
    return real(b);
  };
  let size = 0;
  const pipeline = { size: () => size, head: async () => { const { root, nextIndex } = await chain.poolState(); return { root: String(root), size: String(nextIndex), pending: [], tail: {} }; } };
  const keeper = createServer(createIntakeHandler({ store: openKeeperStore(':memory:'), chain, zk, assetField, pipeline, cfg: mkCfg({ ratePerMin: 600 }), now: () => T0 }));
  await listen(keeper);
  const url = `http://127.0.0.1:${keeper.address().port}/evm-pool/keeper/head`;
  const settle = () => new Promise((r) => setTimeout(r, 40));
  try {
    fail = true;
    const failed = Array.from({ length: 5 }, () => fetch(url));
    await settle();
    assert.equal(held.length, 1, 'five at once, one read');
    held.shift()();
    assert.ok((await Promise.all(failed)).every((r) => r.status >= 500), 'all of them see the failure');
    fail = false;
    const before = fetch(url);
    await settle();
    assert.equal(held.length, 1, 'a failed read is not kept: the next one reads again');
    size = 1;
    const after = fetch(url);
    await settle();
    assert.equal(held.length, 2, 'a queue that moved does not join the read begun before it');
    held.shift()();
    held.shift()();
    assert.equal((await before).status, 200);
    assert.equal((await after).status, 200);
    assert.equal((await fetch(url)).status, 200);
    assert.equal(held.length, 0, 'the finished read is cached');
  } finally { keeper.close(); }
});

await test('the private route is off without a gateway key, a bad key stops the keeper without saying what it was, and /info names the key when on', async () => {
  assert.equal(loadKeeperConfig(baseEnv).gatewayKey, '');
  assert.equal(loadKeeperConfig({ ...baseEnv, EVM_POOL_KEEPER_GATEWAY_KEY: '0x' + GATEWAY_SECRET.toUpperCase() }).gatewayKey, GATEWAY_SECRET);
  for (const bad of ['nope', 'zz'.repeat(32), '00'.repeat(32)]) {
    assert.throws(() => loadKeeperConfig({ ...baseEnv, EVM_POOL_KEEPER_GATEWAY_KEY: bad }), (e) => /EVM_POOL_KEEPER_GATEWAY_KEY/.test(e.message) && !e.message.includes(bad), bad);
  }
  assert.deepEqual(loadKeeperConfig({ ...baseEnv, EVM_POOL_KEEPER_FORWARDERS: '1.1.1.1, 2.2.2.2' }).forwarders, ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(loadKeeperConfig(baseEnv).forwarders, []);
  const off = await privateRoute({ cfg: { gatewayKey: '' } });
  try {
    assert.equal((await fetch(`${off.base}/sealed`, { method: 'POST', body: new Uint8Array(4200) })).status, 404);
    assert.ok(!('sealed' in (await (await fetch(`${off.base}/info`)).json())));
  } finally { off.close(); }
  const on = await privateRoute();
  try {
    const info = await (await fetch(`${on.base}/info`)).json();
    assert.equal(info.sealed.key, GATEWAY_PUB);
    assert.match(info.sealed.kid, /^[0-9a-f]{8}$/);
    assert.ok(!JSON.stringify(info).includes(GATEWAY_SECRET));
  } finally { on.close(); }
});

await test('a sealed request reaches the same handler and gets the answer a direct one would', async () => {
  const r = await privateRoute();
  try {
    assert.deepEqual(await (await r.sf(`${r.base}/info`)).json(), await (await fetch(`${r.base}/info`)).json());
    const d = makeDeposit();
    const w = await r.sf(`${r.base}/deposit`, jsonInit('POST', d.body));
    assert.equal(w.status, 200);
    const j = await w.json();
    assert.equal(j.status, 'pending');
    assert.equal(r.store.pendingCount(), 1);
    const again = await (await fetch(`${r.base}/deposit`, jsonInit('POST', d.body))).json();
    assert.equal(again.box, j.box, 'the same box, whichever way it came');
    assert.equal(r.store.pendingCount(), 1);
    assert.deepEqual(Object.keys(await (await r.sf(`${r.base}/status/${j.box}`)).json()).sort(), ['box', 'kind', 'reward', 'status']);
    const junk = await r.sf(`${r.base}/deposit`, { method: 'POST', body: '{"intent":{}}' });
    assert.equal(junk.status, 400, 'the handler\'s own refusals come back as they are');
    assert.equal((await r.sf(`${r.base}/events?from=1`)).status, 404, 'a keeper with no feed says so the same way');
    assert.ok(r.logs.every((m) => !m.includes(d.body.hint.outputs[0].npk)));
  } finally { r.close(); }
});

await test('the forwarder is handed nothing readable and passes on nothing of the caller\'s, and a large answer comes back whole', async () => {
  const viaProxy = (u, init) => fetch(u, { ...init, headers: { ...init.headers, 'x-forwarded-for': '9.9.9.9', 'cf-connecting-ip': '9.9.9.9' } });
  const r = await privateRoute({ fetchImpl: viaProxy });
  try {
    const d = makeDeposit();
    assert.equal((await r.sf(`${r.base}/deposit`, jsonInit('POST', d.body))).status, 200);
    const sent = r.forwarded.at(-1);
    assert.deepEqual(Object.keys(sent.headers), ['content-type'], 'a content type and nothing else is sent on');
    assert.equal(sent.body.length, 4096 + 70);
    for (const text of ['deposit', 'outputs', 'intent', d.body.hint.outputs[0].npk.slice(0, 12)]) assert.ok(!Buffer.from(sent.body).includes(Buffer.from(text)), text);
    // a stored history long enough to be compressed and padded
    const store = openKeeperStore(':memory:');
    const chain = mockChain();
    for (let i = 0; i < 300; i++) chain.foreignTx();
    const sync = makeLeafSync({ store, chain, zk, startBlock: 0n, confirmations: 0n, logChunk: 50n });
    await sync.sync();
    const handler = createIntakeHandler({ store, chain, zk, leafSync: sync, assetField, cfg: mkCfg({ gatewayKey: GATEWAY_SECRET }), now: () => T0 });
    const keeper = createServer(handler);
    await listen(keeper);
    const base = `http://127.0.0.1:${keeper.address().port}/evm-pool/keeper`;
    try {
      const sf = makeSealedFetch({ keeper: base, chainId: 1, gateway: GATEWAY_PUB, forwarders: ['http://f.test'], now: () => T0,
        fetchImpl: (u, init) => fetch(`${base}/sealed`, init) });
      const direct = await (await fetch(`${base}/events?from=0`)).json();
      const sealed = await (await sf(`${base}/events?from=0`)).json();
      assert.ok(direct.events.length >= 300, `${direct.events.length} events`);
      assert.deepEqual(sealed, direct);
    } finally { keeper.close(); }
  } finally { r.close(); }
});

await test('sealed requests are limited as the sender of the envelope is, and a listed forwarder may send ten times as much', async () => {
  const codes = async (r, count) => {
    const out = [];
    for (let i = 0; i < count; i++) out.push((await r.sf(`${r.base}/wrap`, jsonInit('POST', makeWrap({ nonce: BigInt(i + 100) })))).status);
    return out;
  };
  const plain = await privateRoute({ cfg: { ratePerMin: 4 } });
  try { assert.ok((await codes(plain, 8)).includes(429), 'every caller behind one forwarder shares its allowance'); } finally { plain.close(); }
  const listed = await privateRoute({ cfg: { ratePerMin: 4, forwarders: ['127.0.0.1'] } });
  try { assert.deepEqual(await codes(listed, 8), Array(8).fill(200), 'a forwarder named to the keeper'); } finally { listed.close(); }
  const direct = await privateRoute({ cfg: { ratePerMin: 4 } });
  try {
    let nonce = 900n;
    const ask = (ip) => fetch(`${direct.base}/wrap`, { ...jsonInit('POST', makeWrap({ nonce: nonce++ })), headers: { 'content-type': 'application/json', 'x-forwarded-for': ip } });
    const first = []; for (let i = 0; i < 8; i++) first.push((await ask('7.7.7.7')).status);
    assert.ok(first.includes(429));
    assert.equal((await ask('8.8.8.8')).status, 200, 'the limit that holds a direct caller is unchanged, and per caller');
    // an envelope sent from a given address is limited under that address, so one sender cannot spend another's allowance
    const from = (ip) => makeSealedFetch({ keeper: direct.base, chainId: 1, gateway: GATEWAY_PUB, forwarders: ['http://f.test'], now: () => T0,
      fetchImpl: (u, init) => fetch(`${direct.base}/sealed`, { ...init, headers: { ...init.headers, 'x-forwarded-for': ip } }) });
    const sealedCodes = []; for (let i = 0; i < 8; i++) sealedCodes.push((await from('6.6.6.6')(`${direct.base}/wrap`, jsonInit('POST', makeWrap({ nonce: nonce++ })))).status);
    assert.ok(sealedCodes.includes(429), `${sealedCodes}`);
    assert.equal((await from('5.5.5.5')(`${direct.base}/wrap`, jsonInit('POST', makeWrap({ nonce: nonce++ })))).status, 200, 'another sender is not held by it');
  } finally { direct.close(); }
});

await test('the private route does not carry a reservation or anything a wallet does not use, and says so inside the envelope', async () => {
  const r = await privateRoute();
  try {
    for (const [method, path, body] of [['POST', '/reserve', { outLeaf0: '1', outLeaf1: '2', nfs: [] }], ['POST', '/cancel', { reservation: 'a'.repeat(24) }], ['GET', '/nope', null], ['GET', '/status/zz', null], ['POST', '/info', {}], ['GET', '/sealed', null]]) {
      const res = await r.sf(`${r.base}${path}`, { method, body: body ? JSON.stringify(body) : undefined });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.match((await res.json()).error, /not carried/);
    }
    assert.equal((await r.sf(`${r.base}/${'x'.repeat(600)}`)).status, 403);
  } finally { r.close(); }
});

await test('a bad envelope is refused the same way whatever is wrong with it, one seen before is refused, and a large one is turned away', async () => {
  const r = await privateRoute();
  try {
    const post = (bytes) => fetch(`${r.base}/sealed`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    const get = async (opts = {}) => (await sealRequest(opts.pub || GATEWAY_PUB, { method: 'GET', path: '/info' }, { now: () => opts.at ?? T0 })).bytes;
    const good = await get();
    const flipped = Uint8Array.from(good); flipped[1000] ^= 1;
    const answers = [];
    for (const bytes of [flipped, await get({ pub: Buffer.from(gatewayKeys('b2'.repeat(32)).pub).toString('hex') }), await get({ at: T0 - 1000 }), new Uint8Array(100), new Uint8Array(0)]) {
      const res = await post(bytes);
      const j = await res.json();
      answers.push([res.status, j.error]);
      assert.equal(j.t, T0, 'it says what time it has, so a caller whose clock is off can tell');
    }
    assert.deepEqual(answers, Array(5).fill([400, 'bad request']));
    assert.equal((await post(good)).status, 200);
    assert.equal((await post(good)).status, 400, 'the same envelope twice');
    assert.equal((await post(new Uint8Array(70000))).status, 413);
    assert.equal((await fetch(`${r.base}/sealed`)).status, 404, 'only POST');
  } finally { r.close(); }
});

await test('the forwarder serves only its chains, limits each caller, and says plainly when the keeper does not answer', async () => {
  let up = { status: 200, body: new Uint8Array([1, 2, 3]) };
  const fwd = createServer(makeForwarder({ gateways: { 1: 'http://keeper.test/sealed' }, ratePerMin: 2,
    fetchImpl: async () => { if (up === null) throw new Error('down'); return new Response(up.body, { status: up.status }); } }));
  await listen(fwd);
  const base = `http://127.0.0.1:${fwd.address().port}`;
  const post = (path, body = new Uint8Array(10), ip = '4.4.4.4') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-forwarded-for': ip }, body });
  try {
    const pre = await fetch(`${base}/f/1`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await post('/f/2')).status, 404, 'a chain it does not forward');
    assert.equal((await fetch(`${base}/f/1`)).status, 404, 'POST only');
    const ok = await post('/f/1', undefined, '5.5.5.5');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [1, 2, 3]);
    assert.equal((await post('/f/1', new Uint8Array(70000), '6.6.6.6')).status, 413);
    up = { status: 400, body: new Uint8Array(1) };
    assert.equal((await post('/f/1', undefined, '7.7.7.7')).status, 400);
    up = { status: 503, body: new Uint8Array(1) };
    assert.equal((await post('/f/1', undefined, '8.8.8.8')).status, 503);
    up = null;
    assert.equal((await post('/f/1', undefined, '9.9.9.9')).status, 502);
    const limited = [];
    for (let i = 0; i < 4; i++) limited.push((await post('/f/1', undefined, '3.3.3.3')).status);
    assert.ok(limited.includes(429), `${limited}`);
    assert.equal((await post('/f/1', undefined, '2.2.2.2')).status, 502, 'another caller is not held by it');
  } finally { fwd.close(); }
});

await test('the gateway\'s memory of envelopes is bounded, and when full it sheds its oldest rather than turn new ones away', async () => {
  const gateway = makeSealedGateway({ secret: GATEWAY_SECRET, prefix: '/evm-pool/keeper', now: () => T0, maxSeen: 10,
    handle: async (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); } });
  const server = createServer((req, res) => gateway.handle(req, res, (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }));
  await listen(server);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const post = (bytes) => fetch(url, { method: 'POST', body: bytes }).then((r) => r.status);
  try {
    const envelopes = await Promise.all(Array.from({ length: 25 }, async () => (await sealRequest(GATEWAY_PUB, { method: 'GET', path: '/info' }, { now: () => T0 })).bytes));
    const codes = []; for (const e of envelopes) codes.push(await post(e));
    assert.deepEqual(codes, Array(25).fill(200), 'a full memory never turns a new envelope away');
    assert.equal(await post(envelopes[24]), 400, 'a recent one is still remembered');
    assert.equal(await post(envelopes[0]), 200, 'an old one was shed, and a replay of it is answered afresh');
  } finally { server.close(); }
});


// ── the private route of the multi-keeper service: one POST /sealed for every pool, and a burst of reads in one envelope ──

// The service's handler as the multi-keeper service has it: /<id>/evm-pool/keeper/<route>, each keeper counting the sender by itself.
function fakeService({ perMin = 1000, big = 0 } = {}) {
  const seen = [];
  const limit = new Map();
  const serve = (req, res) => {
    const [path, query = ''] = req.url.split('?');
    const m = /^\/(\d+(?:-x[0-9a-f]+)?)\/evm-pool\/keeper(\/.*)$/.exec(path);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (!m) return send(404, { error: 'no such chain' });
    const [, id, route] = m;
    if (!limit.has(id)) limit.set(id, makeTokenBucket({ perMin, burst: perMin }));
    const ip = clientKey(req);
    if (!limit.get(id)(ip)) return send(429, { error: 'rate limited' }, { 'Retry-After': '10' });
    seen.push({ id, route, query, ip, method: req.method });
    if (big && route === '/events') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.alloc(big, 7 + Number(query.split('=')[1] || 0))); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => send(200, { id, route, query, body: body ? JSON.parse(body) : null }));
  };
  return { serve, seen };
}
const jsonTo = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

// A service behind a real server with the service route in front of it, a forwarder in front of that, and a wallet's sealed fetch through it.
async function serviceRoute({ perMin, big, forwarders = [], ratePerMin = 20, sfOpts = {} } = {}) {
  const svc = fakeService({ perMin, big });
  const take = makeServiceGateway({ secret: GATEWAY_SECRET, serve: svc.serve, json: jsonTo, forwarders, ratePerMin, now: () => T0 });
  const server = createServer((req, res) => (take(req, res) ? undefined : svc.serve(req, res)));
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const envelopes = [];
  const fwd = createServer(makeForwarder({ gateways: { k: `${base}/sealed`, '1-xdac17f958d': `${base}/sealed` }, ratePerMin: 100_000, fetchImpl: async (url, init) => { envelopes.push(init.body.length); return fetch(url, init); } }));
  await listen(fwd);
  const fwdUrl = `http://127.0.0.1:${fwd.address().port}`;
  const sf = makeSealedFetch({ keeper: base, chainId: 'k', gateway: GATEWAY_PUB, forwarders: [fwdUrl], now: () => T0, batchMs: 40, ...sfOpts });
  return { svc, take, base, fwdUrl, envelopes, sf, close: () => { server.close(); fwd.close(); } };
}

await test('the service route carries any pool\'s routes, and a burst of reads for a dozen pools is a few envelopes, each answer its keeper\'s own', async () => {
  const r = await serviceRoute();
  try {
    const ids = ['1', '8453', '4663', '1-xdac17f958d', '1-xa0b86991c6', '8453-x833589fcd6'];
    const paths = ids.flatMap((id) => [`/${id}/evm-pool/keeper/quote`, `/${id}/evm-pool/keeper/head`]);
    const answers = await Promise.all(paths.map((p) => r.sf(`${r.base}${p}`).then((x) => x.json())));
    assert.deepEqual(answers.map((a) => `/${a.id}/evm-pool/keeper${a.route}`), paths, 'each caller has its own pool\'s answer');
    assert.ok(r.envelopes.length <= 3, `${r.envelopes.length} envelopes for ${paths.length} reads`);
    assert.ok(r.envelopes.every((n) => n === 4096 + 70), 'each is the smallest size, so a burst does not show its size');
    // a write is carried too, alone, with its body
    const w = await r.sf(`${r.base}/1/evm-pool/keeper/receive`, jsonInit('POST', { chainId: 1, npk: '42' }));
    assert.deepEqual((await w.json()).body, { chainId: 1, npk: '42' });
    // the keepers saw the forwarder's address and not a caller's
    assert.equal(new Set(r.svc.seen.map((x) => x.ip)).size, 1);
  } finally { r.close(); }
});

await test('what the service route does not carry is refused inside the envelope while the rest of it is answered', async () => {
  const r = await serviceRoute();
  try {
    const status = (p, init) => r.sf(`${r.base}${p}`, init).then((x) => x.status);
    const results = await Promise.all([
      status('/1/evm-pool/keeper/quote'),
      status('/health'),
      status('/token-pools'),
      status('/chains'),
      status('/1/evm-pool/keeper/reserve', jsonInit('POST', {})),
      status('/1/evm-pool/keeper/cancel', jsonInit('POST', {})),
      status('/1/evm-pool/keeper/../../health'),
      status('/1/evm-pool/keeperx/quote'),
      status('/1/evm-pool/keeper/head'),
      status('/8453/evm-pool/keeper/status/0x' + 'ab'.repeat(20)),
    ]);
    assert.deepEqual(results, [200, 403, 403, 403, 403, 403, 403, 403, 200, 200]);
    assert.ok(r.svc.seen.every((x) => ['/quote', '/head', `/status/0x${'ab'.repeat(20)}`].includes(x.route)), 'a refused request never reached a keeper');
  } finally { r.close(); }
});

await test('each request in an envelope is counted by its keeper as if the sender had made it alone', async () => {
  const r = await serviceRoute({ perMin: 4 });
  try {
    const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => r.sf(`${r.base}/1/evm-pool/keeper/events?from=${i}`).then((x) => x.status)));
    assert.equal(codes.filter((c) => c === 200).length, 4);
    assert.equal(codes.filter((c) => c === 429).length, 4);
    const busy = await r.sf(`${r.base}/1/evm-pool/keeper/head`);
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '10', 'a keeper\'s Retry-After comes through');
    assert.equal((await r.sf(`${r.base}/8453/evm-pool/keeper/head`)).status, 200, 'another keeper counts for itself');
  } finally { r.close(); }
});

await test('an envelope is counted against its sender before it is opened, and a listed forwarder may send ten times as much', async () => {
  const post = (base, bytes) => fetch(`${base}/sealed`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  const fresh = () => sealRequest(GATEWAY_PUB, { method: 'GET', path: '/1/evm-pool/keeper/head' }, { now: () => T0 }).then((x) => x.bytes);
  const plain = await serviceRoute({ ratePerMin: 1 });
  try {
    const codes = []; for (let i = 0; i < 6; i++) codes.push((await post(plain.base, await fresh())).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429, 429], 'a burst of three, then the rate');
    const refused = await post(plain.base, await fresh());
    assert.equal(refused.headers.get('retry-after'), '10');
  } finally { plain.close(); }
  const listed = await serviceRoute({ ratePerMin: 1, forwarders: ['127.0.0.1'] });
  try {
    const codes = []; for (let i = 0; i < 12; i++) codes.push((await post(listed.base, await fresh())).status);
    assert.ok(codes.every((c) => c === 200), codes.join(','));
  } finally { listed.close(); }
});

await test('answers too large to share an envelope are told to come alone, and the sealed fetch asks for each again by itself', async () => {
  const r = await serviceRoute({ big: 3_500_000 });
  try {
    const bodies = await Promise.all([1, 2, 3].map((i) => r.sf(`${r.base}/1/evm-pool/keeper/events?from=${i}`).then(async (x) => ({ status: x.status, body: Buffer.from(await x.arrayBuffer()) }))));
    for (const [i, b] of bodies.entries()) {
      assert.equal(b.status, 200, `page ${i + 1}`);
      assert.equal(b.body.length, 3_500_000);
      assert.equal(b.body[0], 7 + i + 1, 'and it is its own page');
    }
  } finally { r.close(); }
});

await test('the service route is off without a key, a bad key stops the service without saying what it was, and only POST /sealed is taken', async () => {
  assert.throws(() => makeServiceGateway({ secret: 'nope-not-a-key', serve: () => {}, json: jsonTo }), (e) => /EVM_POOL_KEEPER_GATEWAY_KEY/.test(e.message) && !e.message.includes('nope'));
  const r = await serviceRoute();
  try {
    assert.equal((await fetch(`${r.base}/sealed`)).status, 404);
    assert.equal(r.take({ url: '/1/evm-pool/keeper/head', method: 'GET', headers: {} }, {}), false, 'any other path is left to the service');
    assert.equal((await fetch(`${r.base}/1/evm-pool/keeper/head`)).status, 200, 'and a direct read still works');
  } finally { r.close(); }
});

await test('the forwarder names a gateway by an id of its own and has no id that is not its own', async () => {
  const hits = [];
  const fwd = createServer(makeForwarder({ gateways: { 1: 'http://one.test/s', k: 'http://k.test/s', '1-xdac17f958d': 'http://pool.test/s' }, fetchImpl: async (url) => { hits.push(url); return new Response(new Uint8Array([1]), { status: 200 }); } }));
  await listen(fwd);
  const base = `http://127.0.0.1:${fwd.address().port}`;
  try {
    const post = (id) => fetch(`${base}/f/${id}`, { method: 'POST', body: new Uint8Array(10) }).then((x) => x.status);
    assert.deepEqual([await post('1'), await post('k'), await post('1-xdac17f958d')], [200, 200, 200]);
    assert.deepEqual(hits, ['http://one.test/s', 'http://k.test/s', 'http://pool.test/s']);
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope', 'k%20', 'a'.repeat(41)]) assert.equal(await post(id), 404, id);
    assert.equal(hits.length, 3);
  } finally { fwd.close(); }
});

console.log(`\n${n} passed`);

test('the nodes that serve logs can be named apart from the read fallbacks', () => {
  const c = loadKeeperConfig({ ...baseEnv, EVM_POOL_RPC_URL: 'https://a', EVM_POOL_RPC_URLS_FALLBACK: 'https://b', EVM_POOL_LOG_RPC_URLS: 'https://a' });
  assert.deepEqual(c.rpcUrls, ['https://a', 'https://b']);
  assert.deepEqual(c.logRpcUrls, ['https://a']);
  assert.deepEqual(loadKeeperConfig(baseEnv).logRpcUrls, []);
});
