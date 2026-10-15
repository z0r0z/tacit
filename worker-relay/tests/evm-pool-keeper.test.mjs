// EVM pool box keeper (src/evm-pool-keeper.js) against a mocked router/pool and a stub prover: config and signer
// isolation, intake validation and body caps, leaf sync, and the completion loop (stale-root re-proving,
// profitability, wraps, expiry and reclaim). The real prover path is tests/evm-pool-keeper-prover.test.mjs.
//   node worker-relay/tests/evm-pool-keeper.test.mjs

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { keccak_256 } from '../../dapp/vendor/tacit-deps.min.js';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { encodeAbiParameters, keccak256 as viemKeccak, encodeFunctionData, decodeFunctionData, toHex } from 'viem';
import { depositIntent, receiveRho, receiveKeys, callIntent, callIntentJson, callEscrowAddress, v1ZapShieldedNoteCall } from '../../dapp/evm-pool-gateway.js';
import { ROUTER_ABI, frontFees } from '../src/lib/evm-pool-keeper-chain.js';
import { loadKeeperConfig, checkKeeperSigner, parseTokenMap, RELAY_EOA } from '../src/lib/evm-pool-keeper-config.js';
import { openKeeperStore } from '../src/lib/evm-pool-keeper-store.js';
import { makeLeafSync, makeFactsSync, LeafSyncError, FACT_KEYS } from '../src/lib/evm-pool-keeper-leaves.js';
import { createIntakeHandler, parseDepositSubmission, parseWrapSubmission, parseReceiveSubmission, parseRelaySubmission, ipKey } from '../src/lib/evm-pool-keeper-intake.js';
import { createKeeper, coverCheck, quoteFee } from '../src/lib/evm-pool-keeper-loop.js';
import { loadZk } from '../src/lib/evm-pool-keeper-prover.js';

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
  c.poolState = async () => ({ root: zk.tree(c.leaves).root, nextIndex: BigInt(c.leaves.length) });
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
      const [tok, box] = functionName === 'reclaimDeposit' ? [TOKEN, c.boxOf('d', intent)] : [WRAP_TOKEN, c.boxOf('w', intent)];
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
  c.poolState = async () => ({ root: zk.tree(c.leaves).root, nextIndex: BigInt(c.leaves.length) });
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

console.log(`\n${n} passed`);
