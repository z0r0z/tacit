// EVM pool box keeper (src/evm-pool-keeper.js) against a mocked router/pool and a stub prover: config and signer
// isolation, intake validation and body caps, leaf sync, and the completion loop (stale-root re-proving,
// profitability, wraps, expiry and reclaim). The real prover path is tests/evm-pool-keeper-prover.test.mjs.
//   node worker-relay/tests/evm-pool-keeper.test.mjs

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { keccak_256 } from '../../dapp/vendor/tacit-deps.min.js';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { depositIntent } from '../../dapp/evm-pool-gateway.js';
import { loadKeeperConfig, checkKeeperSigner, parseTokenMap, RELAY_EOA } from '../src/lib/evm-pool-keeper-config.js';
import { openKeeperStore } from '../src/lib/evm-pool-keeper-store.js';
import { makeLeafSync, LeafSyncError } from '../src/lib/evm-pool-keeper-leaves.js';
import { createIntakeHandler, parseDepositSubmission, parseWrapSubmission } from '../src/lib/evm-pool-keeper-intake.js';
import { createKeeper, coverCheck } from '../src/lib/evm-pool-keeper-loop.js';
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
  const exec = (functionName, [intent, t]) => {
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
    return functionName === 'completeDeposit' ? 400000n : 150000n;
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
  const leafSync = makeLeafSync({ store, chain, startBlock: 0n, confirmations: cfg.confirmations, logChunk: 5n });
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
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(makeDeposit().body) })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(makeDeposit({ nonce: 1n }).body) })).status, 503);
  } finally { server.close(); }
});

// ── leaf sync ──

await test('leaf sync persists confirmed leaves, re-reads the tail, and resets on a dropped block', async () => {
  const store = openKeeperStore(':memory:');
  const chain = mockChain();
  const sync = makeLeafSync({ store, chain, startBlock: 0n, confirmations: 2n, logChunk: 3n });
  for (let i = 0; i < 5; i++) chain.foreignTx();
  let s = await sync.sync();
  assert.equal(s.leaves.length, 10);
  assert.equal(s.root, zk.tree(chain.leaves).root);
  assert.equal(store.leafCount(), 6); // blocks ≤ head − 2
  // A reorg drops the last (unpersisted) event: the tail is simply re-read.
  chain.leaves.splice(8); chain.events.pop(); chain.block -= 1n;
  s = await sync.sync();
  assert.equal(s.leaves.length, 8);
  // A deeper reorg the store already holds: count exceeds the pool's, the store resets and the next sync rebuilds.
  chain.leaves.splice(4); chain.events.splice(2); chain.block = 102n;
  await assert.rejects(sync.sync(), LeafSyncError);
  assert.equal(store.leafCount(), 0);
  s = await sync.sync();
  assert.equal(s.leaves.length, 4);
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

console.log(`\n${n} passed`);
