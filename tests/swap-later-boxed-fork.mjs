#!/usr/bin/env node
// A token start whose gas the relay pays (dapp/swap/later.js startBoxed, dapp/gas-relay.js placeOrder) on a mainnet fork, with the REAL keeper
// (worker-relay/src/evm-pool-keeper.js as its own process, the live pool and the ceremony's key) and the LIVE gas relay and zRouter.
// A wallet with no ETH and USDC (and TAC) signs one order and one permit; the relay (played by an impersonated account that sends TacitGasRelay.execute with the settle
// relay's own encoding) sells the USDC for exactly the ETH a deposit box of the ETH pool holds; the keeper completes the box into the plan's note, paying itself the box's fee;
// then the swap out is the usual one (a proof made here, the keeper sends router.withdrawAndCall) and pays DAI to a fresh address, naming neither the wallet nor the box.
// Then the paths that must cost nothing: an order that would revert is refused before it is posted, a funder that fails before any order, a relay that never sends it (the order
// lapses and the contract refuses it afterwards), and a keeper that has not completed the box when the page stops waiting (the plan checks itself later).
//
//   node tests/swap-later-boxed-fork.mjs
//   FORK=http://127.0.0.1:<proxy> QUOTE_RPC=http://127.0.0.1:<proxy> FORK_BLOCK=<n> node tests/swap-later-boxed-fork.mjs     (a caching proxy in front of an archive node, see the notes on fork runs)
//   ONLY=main,tac,neg,usdt   (parts; each needs only the setup above it)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { privateKeyToAccount } = require('viem/accounts');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { makeLater, depositFor, sizeBoxed, BOX_GAS, POOL, ROUTER, CHAIN } = await import('../dapp/swap/later.js');
const { bestRoute } = await import('../dapp/swap/aggregate.js');
const GR = await import('../dapp/gas-relay.js');
const { encodeExecute: relayEncode } = await import('../worker-relay/src/lib/gas-calls.js');

const ROOT = new URL('../', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', UP = process.env.QUOTE_RPC || FORK;
const ONLY = process.env.ONLY || '';
const want = (k) => !ONLY || ONLY.split(',').includes(k);
const PORT = 25200 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, KPORT = PORT + 400;
const KEEPER = `http://127.0.0.1:${KPORT}/evm-pool/keeper`;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7', DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F', TAC = GR.TAC;
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', RELAY = GR.GAS_RELAY[1];
const RELAYER = '0x000000000000000000000000000000000007a0f0';
const DEST = '0x00000000000000000000000000000000000de581', DEST2 = '0x00000000000000000000000000000000000de582', REFUND = '0x00000000000000000000000000000000000de5a0';
// (a made-up key of its own: a pattern key such as 0xd4e5f6a7…d4e5f6a7 is an address Tether has blacklisted, which cannot receive USDT)
const payer = privateKeyToAccount('0x' + createHash('sha256').update('tacit swap-later-boxed-fork payer v1').digest('hex')), PAYER = payer.address;
const keeperKey = '0x' + '5b'.repeat(32), keeperAddr = privateKeyToAccount(keeperKey).address;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data }); return j.result; };
const rpcA = async (method, params = []) => {
  try {
    const r = await post(RPC, method, params);
    if (process.env.DEBUG_RPC && method === 'eth_getLogs') console.log(`    [rpc] ${method} ${JSON.stringify(params)} -> ${Array.isArray(r) ? r.length + ' logs' : JSON.stringify(r)}`);
    return r;
  } catch (e) { if (process.env.DEBUG_RPC && method === 'eth_getLogs') console.log(`    [rpc] ${method} ${JSON.stringify(params)} FAILED ${e.message}`); throw e; }
};
const hex = (v) => '0x' + BigInt(v).toString(16);
const A32 = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + A32(who) }, 'latest'])));
const fmt = (v, d) => (Number(v) / 10 ** d).toString();
const eth = (v) => (Number(v) / 1e18).toFixed(6);
const M = {};                                   // what was measured, printed at the end

const BLOCK_N = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : BigInt(await post(UP, 'eth_blockNumber', [])) - 2n, BLOCK = hex(BLOCK_N);
const procs = [], tmp = mkdtempSync(join(tmpdir(), 'swap-later-boxed-'));
const stop = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(BLOCK_N), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 4500) throw new Error('anvil did not start'); await sleep(200); } }
// a cold scan of the pool's logs through the fork can take longer than the wallet's 25 s for a read: reads of the fork's node get five minutes
{ const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => (String(url) === RPC && init ? realFetch(url, { ...init, signal: AbortSignal.timeout(300_000) }) : realFetch(url, init)); }
for (const a of [RELAYER, keeperAddr]) await rpcA('anvil_setBalance', [a, hex(10n ** 18n)]);
await rpcA('anvil_impersonateAccount', [RELAYER]);
// the wallet: USDC and TAC and NO ETH
await rpcA('anvil_dealERC20', [PAYER, USDC, hex(2000n * 10n ** 6n)]);
await rpcA('anvil_dealERC20', [PAYER, TAC, hex(500n * 10n ** 18n)]);
ok((await bal(USDC, PAYER)) === 2000n * 10n ** 6n && (await bal(TAC, PAYER)) === 500n * 10n ** 18n && (await bal(ZERO, PAYER)) === 0n, 'a wallet with 2000 USDC, 500 TAC and no ETH');
ok(String(await rpcA('eth_getCode', [RELAY, 'latest'])).length > 2, `the gas relay is on the fork at ${RELAY}`);

// the keeper: the service as it runs in production (worker-relay/src/evm-pool-keepers.js, here with the one pool), the live pool and router on the fork, the ceremony's key.
// A fresh keeper replays the pool's logs from its first block, which a public node will not serve for long ranges: it is seeded from the live keeper's public event feed cut at
// the fork's block (so the tree is the pool's at the fork, and the seed is root-checked against the fork's own state before it is taken)
const LIVE_FEED = process.env.LIVE_FEED || 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper';
const feedShim = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/events') { res.writeHead(404).end(); return; }
    const j = await (await fetch(`${LIVE_FEED}/events${u.search}`)).json();
    const cut = { ...j, events: j.events.filter((e) => BigInt(e.block) <= BLOCK_N), through: Math.min(j.through, Number(BLOCK_N)) };
    if (Number.isInteger(j.factsThrough)) cut.factsThrough = Math.min(j.factsThrough, Number(BLOCK_N));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cut));
  } catch (e) { res.writeHead(502).end(String(e.message)); }
}).listen(KPORT + 400, '127.0.0.1');
procs.push({ kill: () => feedShim.close() });
const ART = join(ROOT, 'dapp/evm-pool/');
const klog = [];
const keeper = spawn('node', ['src/evm-pool-keepers.js'], {
  cwd: join(ROOT, 'worker-relay'),
  env: {
    ...process.env, EVM_POOL_CHAINS: '1', EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: RPC, EVM_POOL_KEEPER_PRIV: keeperKey,
    EVM_POOL_KEEPER_DB: join(tmp, 'keeper.db'), PORT: String(KPORT), EVM_POOL_START_BLOCK: String(CHAIN.deployBlock), EVM_POOL_LOG_CHUNK: '50000',
    EVM_POOL_SEED_FEED_1: `http://127.0.0.1:${KPORT + 400}`,
    EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_KEEPER_MIN_FEES: 'eth:1000', EVM_POOL_KEEPER_SEND_RPC_URLS: RPC,
    EVM_POOL_KEEPER_POINTS: '0', EVM_POOL_KEEPER_FACTS: '0',
    EVM_POOL_WASM: ART + 'transact.wasm', EVM_POOL_ZKEY: ART + 'transact_final.zkey', EVM_POOL_VK: ART + 'transact_vk.json',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(keeper);
process.on('uncaughtException', (e) => { console.error(e); console.error('--- the keeper\'s log\n' + klog.join('').split('\n').slice(-40).join('\n')); process.exit(1); });
keeper.stdout.on('data', (d) => klog.push(String(d))); keeper.stderr.on('data', (d) => klog.push(String(d)));
const t0 = Date.now();
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://127.0.0.1:${KPORT}/health`)).ok) break; } catch {}
  if (i > 2400) { console.error(klog.join('').split('\n').slice(-20).join('\n')); throw new Error('the keeper did not become ready'); }
  await sleep(500);
}
ok(true, `the keeper runs against the fork's pool and is ready (${Math.round((Date.now() - t0) / 1000)} s)`);
const q = await (await fetch(`${KEEPER}/quote?gas=1000000`)).json();
const qd = await (await fetch(`${KEEPER}/quote?gas=${BOX_GAS}`)).json();
ok(q.relayer?.toLowerCase() === keeperAddr.toLowerCase() && BigInt(q.fee) > 0n && BigInt(qd.fee) > 0n && BigInt(qd.fee) < BigInt(q.fee), `its quotes: ${q.fee} wei for 1M gas, ${qd.fee} wei for ${BOX_GAS} (a deposit)`);
ok(qd.depositFee === undefined || (qd.depositGas === String(BOX_GAS) && qd.depositFee === qd.fee), `and it says what a deposit box costs itself: ${qd.depositFee} wei at ${qd.depositGas} gas`);

// the wallet the card builds, pointed at the local keeper and the fork's node
const times = [];
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const upCall = (to, data, _block, o = {}) => post(UP, 'eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK]);
const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { jsonRpc } = await import('../dapp/evm-pool-wallet.js');
const rpc = jsonRpc([RPC]);
const sg = { address: PAYER, rpc, ready: async () => {}, send: async () => { throw new Error('this wallet has no ETH to send with'); } };
const privHex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
// the wallet reads at the page's own depth (CHAIN.confirmations = 3: the newest blocks are re-read each time, held apart from the kept state). At 0 a read that lands as a block is
// mined can keep the block without its logs (the node's log index a moment behind its head) and the wallet then never sees that leaf: seen on anvil, a note the keeper had completed
// missing for ten minutes, while at 3 every round of the same run found it.
const chain = { chainId: 1, rpc: [RPC], keeper: KEEPER, deployBlock: CHAIN.deployBlock, confirmations: Number(process.env.WALLET_CONF ?? CHAIN.confirmations), logChunk: 50000 };
const L = makeLater({ keyHex: async () => privHex, signer: sg, ethCall: upCall, store, chain, prove });

// ── the funder: what the card does with a box, with the wallet's signatures made by the key above ──
const strip = (t) => ({ domain: t.domain, types: Object.fromEntries(Object.entries(t.types).filter(([k]) => k !== 'EIP712Domain')), primaryType: t.primaryType, message: t.message });
const signTyped = (t) => payer.signTypedData(strip(t));
const runs = [], posted = [], steps = [], tClock = Date.now();
const say = (s) => { steps.push(s); if (!process.env.QUIET) console.log(`    [${((Date.now() - tClock) / 1000).toFixed(0).padStart(4)} s] ${s}`); };
// the settle relay: simulates and sends the order as the board hands it over, with its own encoding of the call
const relayPlays = async ({ order: x }) => {
  posted.push(x);
  const cd = relayEncode(x);
  let gas;
  try { gas = BigInt(await rpcA('eth_estimateGas', [{ from: RELAYER, to: RELAY, data: cd }])); } catch (e) { return { ok: false, error: `the relay's own simulation: ${e.message}` }; }
  const h = await rpcA('eth_sendTransaction', [{ from: RELAYER, to: RELAY, data: cd, gas: hex((gas * 12n) / 10n) }]);
  runs.push(h);
  return { ok: true };
};
const relayIdle = async ({ order: x }) => { posted.push(x); return { ok: true }; };      // takes the order and never sends it
// stand-ins and the route's deadline are fixed here, so a rerun asks a caching node the same questions (the page draws a random stand-in and a deadline twenty minutes out)
const STAND = '0x00000000000000000000000000000000005a11d0';
const DL = BigInt((await rpcA('eth_getBlockByNumber', [BLOCK, false])).timestamp) + 7n * 86400n;
const rnd = () => STAND;
const nothing = (m) => Object.assign(new Error(m), { nothingSpent: true });
// the first look at a token's route (what the card quotes before the press): `amountIn` of it into ETH
const look = async (tokenIn, amountIn) => {
  const q0 = await bestRoute({ ethCall: upCall, to: rnd(), refundTo: RELAY, tokenIn, tokenOut: ZERO, amountIn, slippageBps: 50, deadline: DL });
  if (!q0) throw new Error(`no route for ${tokenIn}`);
  return { amountIn: BigInt(amountIn), out: q0.out };
};
function funderFor({ tokenIn, sym, first, feeToken = tokenIn, fee, minOutMul = 1n, ttlSecs = 600, funder = relayPlays, minWait = 60, pollMs = 400, seen = {} }) {
  return async ({ box, amount }) => {
    const dl = DL;
    const routeTo = (to) => (a) => bestRoute({ ethCall: upCall, to, refundTo: RELAY, tokenIn, tokenOut: ZERO, amountIn: a, slippageBps: 50, deadline: dl });
    const sized = await sizeBoxed({ route: routeTo(rnd()), amountIn: first.amountIn, out: first.out, needWei: amount });
    if (!sized) throw nothing(`No onchain route sells ${sym} for the deposit right now. Nothing was spent.`);
    const real = await routeTo(box)(sized.amountIn);                       // the route as it will run, paying the box
    if (!real || real.out < amount) throw nothing('The price moved while the deposit box was made. Nothing was spent; press again.');
    Object.assign(seen, { sized: sized.amountIn, out: real.out, min: real.min, name: real.name, amount, box });
    const { order, data } = GR.buildOrder({ payer: PAYER, tokenIn, amountIn: sized.amountIn, feeToken, fee, tokenOut: ZERO, minOut: amount * minOutMul, recipient: box, target: ZROUTER, data: real.callData, ttlSecs });
    Object.assign(seen, { order });
    const hash = await GR.placeOrder({ order, data, from: PAYER, symbol: sym, sign: { typed: signTyped }, rpc: rpcA, step: (s) => say(`relay: ${s}`), post: funder, pollMs, minWait });
    return { hash, amountIn: sized.amountIn, route: real.name };
  };
}
const plan0 = async (extra = {}) => {
  const fee = (BigInt(q.fee) * 3n) / 2n, swap = 2n * 10n ** 16n;
  return { ...depositFor({ swapWei: swap, feeWei: fee, pct: 40 }), swap, ...extra };
};
const keeperGas = async (fromBlock, toBlock) => {
  let gas = 0n, txs = [];
  for (let b = fromBlock; b <= toBlock; b++) {
    const blk = await rpcA('eth_getBlockByNumber', [hex(b), true]);
    for (const t of blk.transactions) if (t.from.toLowerCase() === keeperAddr.toLowerCase()) { const rc = await rpcA('eth_getTransactionReceipt', [t.hash]); gas += BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice); txs.push({ hash: t.hash, to: t.to, gasUsed: BigInt(rc.gasUsed), status: rc.status }); }
  }
  return { gas, txs };
};

// ═══ main: a USDC start, the fee in USDC, to DAI ═══
const nextIndex = async () => BigInt(await rpcA('eth_call', [{ to: POOL, data: '0xfc7e9c6f' }, 'latest']));
const waitUntil = async (f, ms, every = 1500) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const hasNo = (txt, ...who) => who.every((w) => !String(txt).toLowerCase().includes(w.replace(/^0x/, '').toLowerCase()));
const swapOutOf = async (plan, to, label) => {
  const shown = await L.offer(plan, { slippageBps: 100 });
  ok(shown.min > 0n && shown.callData, `${label}: a price is shown for the swap out: at least ${fmt(shown.min, 18)} DAI via ${shown.name}`);
  const d0 = await bal(DAI, to), k0 = await bal(ZERO, keeperAddr), tS = Date.now();
  const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'relay', onStep: (s) => say(`swap out: ${s}`) });
  const rc = await rpcA('eth_getTransactionReceipt', [done.swapTx]), tx = await rpcA('eth_getTransactionByHash', [done.swapTx]);
  ok(done.state === 'done' && rc?.status === '0x1' && rc.to?.toLowerCase() === ROUTER.toLowerCase() && rc.from.toLowerCase() === keeperAddr.toLowerCase(), `${label}: the swap out is relayed: sent by the keeper to the router (${done.state}, ${BigInt(rc?.gasUsed || 0)} gas, ${((Date.now() - tS) / 1000).toFixed(0)} s with the proof)`);
  const got = (await bal(DAI, to)) - d0;
  ok(got >= shown.min, `${label}: the fresh address got ${fmt(got, 18)} DAI, at least the ${fmt(shown.min, 18)} shown`);
  ok(hasNo(tx.input + JSON.stringify(rc.logs), PAYER), `${label}: nothing in the swap out names the wallet that paid`);
  ok(hasNo(tx.input + JSON.stringify(rc.logs), plan.box), `${label}: nor the deposit box`);
  ok(tx.from.toLowerCase() !== PAYER.toLowerCase(), `${label}: and it was not sent from the wallet`);
  ok((await bal(ZERO, keeperAddr)) - k0 > 0n, `${label}: the keeper is paid more than its gas for it`);
  return { done, got, rc };
};

const first = await look(USDC, 50n * 10n ** 6n);
ok(first.out > 0n, `a first look: 50 USDC sells for ${eth(first.out)} ETH`);
const feeUsdc = 1_300_000n;
if (want('main')) {
const A = await plan0();
const seenA = {};
const usdc0 = await bal(USDC, PAYER), relayerUsdc0 = await bal(USDC, RELAYER), keeper0 = await bal(ZERO, keeperAddr), idx0 = await nextIndex();
const blk0 = BigInt(await rpcA('eth_blockNumber'));
const tStart = Date.now();
const planA = await L.startBoxed({ swapWei: A.swap, extraWei: A.extraWei, token: DAI, sym: 'DAI', dec: 18, to: DEST, depositWei: A.depositWei, refund: REFUND, pollMs: 1000,
  pay: { token: USDC, sym: 'USDC', dec: 6, amountIn: first.amountIn }, fund: funderFor({ tokenIn: USDC, sym: 'USDC', first, fee: feeUsdc, seen: seenA }), onStep: (s) => say(`plan: ${s}`) });
M.mainSecs = (Date.now() - tStart) / 1000;
ok(planA.state === 'waiting' && planA.boxed === true && !planA.err, `the plan waits once the keeper has completed the box (${planA.state}, ${M.mainSecs.toFixed(0)} s from the press to the note)`);
ok((await nextIndex()) === idx0 + 2n, `the pool took the deposit: two leaves more (${idx0} to ${await nextIndex()})`);
{
  const rc = await rpcA('eth_getTransactionReceipt', [planA.depositTx]);
  M.relayGas = BigInt(rc.gasUsed);
  ok(rc.status === '0x1' && rc.to.toLowerCase() === RELAY.toLowerCase() && rc.from.toLowerCase() === RELAYER.toLowerCase() && planA.depositTx === runs[0], `the plan holds the gas relay's transaction, sent by the settle relay's address (${M.relayGas} gas)`);
  const sold = BigInt(planA.pay.amountWei), usdc1 = await bal(USDC, PAYER);
  ok(sold === seenA.sized && planA.pay.route === seenA.name, `the plan's sold amount and route are the ones the funder found (${fmt(sold, 6)} USDC via ${planA.pay.route})`);
  ok(usdc0 - usdc1 === sold + feeUsdc, `the wallet paid ${fmt(sold, 6)} USDC for the sale and ${fmt(feeUsdc, 6)} USDC for the relay, and nothing else (${fmt(usdc0 - usdc1, 6)})`);
  ok((await bal(ZERO, PAYER)) === 0n, 'and still holds no ETH');
  ok((await bal(USDC, RELAYER)) - relayerUsdc0 === feeUsdc, 'the relay earned its fee in USDC');
  const boxAmount = BigInt(planA.boxWei), boxFee = boxAmount - A.depositWei, left = await bal(ZERO, planA.box);
  M.boxFee = boxFee; M.boxLeftPct = (Number(left) * 100) / Number(boxAmount); M.boxLeft = left; M.soldUsdc = sold;
  ok(boxFee >= (BigInt(qd.fee) * 14n) / 10n && boxFee <= (BigInt(qd.fee) * 16n) / 10n, `the keeper's fee for the box is a half over its quote: ${eth(boxFee)} ETH (${eth(boxFee)} ETH against its quote of ${eth(qd.fee)} at ${BOX_GAS} gas)`);
  ok(left * 100n < boxAmount, `what the sale paid above the box stays in it for a refund: ${eth(left)} ETH, ${M.boxLeftPct.toFixed(2)}% of the box`);
  const { gas: kGas, txs } = await keeperGas(blk0 + 1n, BigInt(await rpcA('eth_blockNumber')));
  const kDelta = (await bal(ZERO, keeperAddr)) - keeper0;
  M.keeperGas = txs.reduce((a, t) => a + t.gasUsed, 0n); M.keeperTxs = txs.length;
  ok(txs.length >= 1 && txs.every((t) => t.status === '0x1' && t.to.toLowerCase() === ROUTER.toLowerCase()), `the keeper completed the box with ${txs.length} transaction to the router (${M.keeperGas} gas)`);
  ok(kDelta + kGas === boxFee, `the keeper took exactly the box's fee: +${eth(kDelta)} ETH after ${eth(kGas)} ETH of gas, ${eth(boxFee)} ETH fee`);
  ok(!/skipp|not covered|below the/i.test(klog.join('')), "the keeper's own log has no skipped completion");
}
{
  const r = await swapOutOf(planA, DEST, 'main');
  M.swapOutGas = BigInt(r.rc.gasUsed);
  const after = await L.check(L.plans().find((p) => p.id === planA.id));
  ok(after.state === 'done', `the swap out is seen as done by a check (${after.state})`);
}
}

// ═══ the same, the fee in TAC: the order carries two permits, the input's and TAC's ═══
if (want('tac')) {
  const B = await plan0(), feeTac = 40n * 10n ** 18n, seenB = {};
  const tac0 = await bal(TAC, PAYER), usdcB0 = await bal(USDC, PAYER), relayerTac0 = await bal(TAC, RELAYER), nB = posted.length;
  const planB = await L.startBoxed({ swapWei: B.swap, extraWei: B.extraWei, token: DAI, sym: 'DAI', dec: 18, to: DEST2, depositWei: B.depositWei, refund: REFUND, pollMs: 1000,
    pay: { token: USDC, sym: 'USDC', dec: 6, amountIn: first.amountIn }, fund: funderFor({ tokenIn: USDC, sym: 'USDC', first, feeToken: TAC, fee: feeTac, seen: seenB }), onStep: (s) => say(`tac plan: ${s}`) });
  ok(planB.state === 'waiting' && planB.boxed, `the TAC-fee plan waits once the box is completed (${planB.state})`);
  const sold = BigInt(planB.pay.amountWei);
  ok(tac0 - (await bal(TAC, PAYER)) === feeTac, `the wallet paid the fee in TAC: ${fmt(feeTac, 18)} TAC`);
  ok(usdcB0 - (await bal(USDC, PAYER)) === sold, `and no USDC fee: ${fmt(sold, 6)} USDC left it, all of it sold`);
  ok((await bal(TAC, RELAYER)) - relayerTac0 === feeTac, 'the relay earned its fee in TAC');
  ok((await bal(ZERO, PAYER)) === 0n, 'and the wallet still holds no ETH');
  const x = posted[posted.length - 1];
  ok(posted.length === nB + 1 && BigInt(x.inPermit.value) === sold && BigInt(x.feePermit.value) === feeTac && BigInt(x.feePermit.deadline) > 0n && !x.p2.use, 'the order was posted with two permits: USDC for the sale alone, TAC for the fee');
  ok(x.order.feeToken.toLowerCase() === TAC.toLowerCase() && x.order.tokenOut === ZERO && x.order.recipient.toLowerCase() === planB.box.toLowerCase() && BigInt(x.order.minOut) === BigInt(planB.boxWei), 'and it names the box as the recipient, ETH out, and the box\'s amount as the least');
  const r = await swapOutOf(planB, DEST2, 'tac');
  M.tacSwapOutGas = BigInt(r.rc.gasUsed);
}

// ═══ what must cost nothing ═══
let lapsedOrder = null;
if (want('neg')) {
  const attempt = async (mkFund, { waitMs = 600_000 } = {}) => {
    const P = await plan0(), u0 = await bal(USDC, PAYER), t0 = await bal(TAC, PAYER), nPosted = posted.length, nRuns = runs.length;
    let err = null;
    try { await L.startBoxed({ swapWei: P.swap, extraWei: P.extraWei, token: DAI, sym: 'DAI', dec: 18, to: DEST, depositWei: P.depositWei, refund: REFUND, pollMs: 500, waitMs,
      pay: { token: USDC, sym: 'USDC', dec: 6, amountIn: first.amountIn }, fund: mkFund(), onStep: (s) => say(`neg plan: ${s}`) }); } catch (e) { err = e; }
    const plan = L.plans()[0];
    return { err, plan, usdc: u0 - (await bal(USDC, PAYER)), tac: t0 - (await bal(TAC, PAYER)), posted: posted.length - nPosted, ran: runs.length - nRuns, boxEth: plan?.box ? await bal(ZERO, plan.box) : null };
  };
  // (a) an order whose least is more than any route can pay is refused by the page's own run of it, before it is posted
  const a = await attempt(() => funderFor({ tokenIn: USDC, sym: 'USDC', first, fee: feeUsdc, minOutMul: 2n }));
  ok(a.err?.nothingSpent === true && /would not go through, so nothing was sent/.test(a.err.message), `an order asking more than the route can pay is refused by the page's own run of it: ${a.err?.message?.slice(0, 90)}`);
  ok(a.plan.state === 'stopped' && a.usdc === 0n && a.tac === 0n && a.posted === 0 && a.ran === 0 && a.boxEth === 0n, 'the plan is stopped, no USDC or TAC left the wallet, nothing was posted or sent, and the box holds nothing');
  // (b) a funder that fails before any order: stopped when it says nothing was spent, unsure when it cannot say
  const b1 = await attempt(() => async () => { throw nothing('No onchain route sells USDC for the deposit right now. Nothing was spent.'); });
  ok(b1.plan.state === 'stopped' && b1.usdc === 0n && b1.posted === 0 && /No onchain route/.test(b1.plan.err), `a funder that says nothing was spent leaves the plan stopped (${b1.plan.state})`);
  const b2 = await attempt(() => async () => { throw new Error('socket hang up'); });
  ok(b2.plan.state === 'unsure' && b2.usdc === 0n, `a funder that fails some other way leaves it unsure, to be checked (${b2.plan.state})`);
  // (c) a relay that takes the order and never sends it: the page stops waiting once it has lapsed, saying nothing was spent; the contract then refuses it
  const tc = Date.now();
  const c = await attempt(() => funderFor({ tokenIn: USDC, sym: 'USDC', first, fee: feeUsdc, funder: relayIdle, ttlSecs: 3, minWait: 1, pollMs: 200 }));
  ok(c.err?.nothingSpent === true && /did not send it before the order lapsed/.test(c.err.message) && Date.now() - tc > 10_000, `a relay that never sends the order: the page waits until it has lapsed (${Math.round((Date.now() - tc) / 1000)} s), then says nothing was spent`);
  ok(c.plan.state === 'stopped' && c.usdc === 0n && c.posted === 1 && c.ran === 0 && c.boxEth === 0n, 'the plan is stopped; the order was posted once, never sent, and nothing left the wallet');
  lapsedOrder = posted[posted.length - 1];
  // (d) the page stops waiting before the keeper has completed the box: depositing with the reason; a later check finds the note
  const d = await attempt(() => funderFor({ tokenIn: USDC, sym: 'USDC', first, fee: feeUsdc }), { waitMs: 1 });
  ok(d.err?.pending === true && /its deposit is on its way/.test(d.err.message) && d.plan.state === 'depositing' && d.plan.depositTx === runs[runs.length - 1] && d.ran === 1 && d.err.message, `the page stops waiting before the keeper is done: the plan is depositing, the order ran once (${d.plan.state})`);
  let seenState = '';
  const got = await waitUntil(async () => { const r = await L.check(L.plans().find((x) => x.id === d.plan.id)); if (r.state !== seenState) { seenState = r.state; say(`check: ${r.state}${r.err ? ` (${r.err})` : ''}`); } return r.state === 'waiting' ? r : null; }, 180_000, 2000);
  ok(!!got && got.depositedAt > 0 && !got.err, `a check a little later finds the note the keeper made, and the plan waits (${got?.state})`);
}

// ═══ a token with no permit: USDT through one Permit2 batch ═══
if (want('usdt')) {
  // USDT's balance slot is one anvil cannot find: a holder (an exchange wallet that holds billions) sends it, with ETH only for that transfer
  const HOLDER = '0x5a52E96BAcdaBb82fd05763E25335261B270Efcb';
  await rpcA('anvil_setBalance', [HOLDER, hex(10n ** 18n)]); await rpcA('anvil_impersonateAccount', [HOLDER]);
  await rpcA('eth_sendTransaction', [{ from: HOLDER, to: USDT, data: '0xa9059cbb' + A32(PAYER) + (2000n * 10n ** 6n).toString(16).padStart(64, '0'), gas: '0x30000' }]);
  ok((await bal(USDT, PAYER)) >= 2000n * 10n ** 6n, 'the wallet holds 2000 USDT');
  const firstT = await look(USDT, 50n * 10n ** 6n);
  const U = await plan0(), feeUsdt = 1_300_000n, seenU = {};
  const mk = () => funderFor({ tokenIn: USDT, sym: 'USDT', first: firstT, fee: feeUsdt, seen: seenU });
  const args = (P) => ({ swapWei: P.swap, extraWei: P.extraWei, token: DAI, sym: 'DAI', dec: 18, to: DEST, depositWei: P.depositWei, refund: REFUND, pollMs: 1000, pay: { token: USDT, sym: 'USDT', dec: 6, amountIn: firstT.amountIn } });
  const t0 = await bal(USDT, PAYER);
  const err = await L.startBoxed({ ...args(U), fund: mk() }).then(() => null, (e) => e);
  ok(err?.nothingSpent === true && /has not been approved for Permit2/.test(err.message) && (await bal(USDT, PAYER)) === t0, `without Permit2's approval the order is refused before it is posted, nothing spent: ${err?.message?.slice(0, 80)}`);
  // the one thing the wallet needs ETH for: approving Permit2 once, done here with a loan of ETH that is taken back
  await rpcA('anvil_setBalance', [PAYER, hex(10n ** 17n)]); await rpcA('anvil_impersonateAccount', [PAYER]);
  await rpcA('eth_sendTransaction', [{ from: PAYER, to: USDT, data: '0x095ea7b3' + A32(GR.PERMIT2) + 'f'.repeat(64), gas: '0x30000' }]);
  await rpcA('anvil_setBalance', [PAYER, '0x0']);
  const nU = posted.length, relayerU0 = await bal(USDT, RELAYER);
  const planU = await L.startBoxed({ ...args(await plan0()), fund: mk(), onStep: (s) => say(`usdt plan: ${s}`) });
  ok(planU.state === 'waiting' && planU.boxed, `a USDT start through Permit2 waits once the box is completed (${planU.state})`);
  const x = posted[posted.length - 1], sold = BigInt(planU.pay.amountWei);
  ok(posted.length === nU + 1 && x.p2.use === true && BigInt(x.inPermit.deadline) === 0n && x.p2.batch.spender.toLowerCase() === RELAY.toLowerCase(), 'the order carries one Permit2 batch and no ERC-2612 permit');
  ok(t0 - (await bal(USDT, PAYER)) === sold + feeUsdt && (await bal(USDT, RELAYER)) - relayerU0 === feeUsdt, `the wallet paid ${fmt(sold, 6)} USDT for the sale and ${fmt(feeUsdt, 6)} USDT for the relay, which earned it`);
  ok((await bal(ZERO, PAYER)) === 0n, 'and holds no ETH again');
}

// ═══ the contract refuses an order once it has lapsed (the last thing: it moves the chain's clock three hours on, and the chain is not used again) ═══
if (lapsedOrder) {
  await rpcA('evm_increaseTime', [3 * 3600]); await rpcA('evm_mine');
  const late = await rpcA('eth_call', [{ from: RELAYER, to: RELAY, data: relayEncode(lapsedOrder) }, 'latest']).then(() => 'ran', (e) => e.message);
  ok(late !== 'ran' && /execution reverted/.test(late), `once it has lapsed the contract refuses the order, so nothing can still be spent (${String(late).slice(0, 70)})`);
}
console.log('  steps:', steps.length);
if (fails) { console.error(klog.join('').split('\n').slice(-25).join('\n')); }
console.log(`\n${n} passed, ${fails} failed`);
console.log('MEASURED', JSON.stringify(M, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);
stop();
process.exit(fails ? 1 : 0);
