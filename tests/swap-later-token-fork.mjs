#!/usr/bin/env node
// "Swap privately" from a token (dapp/swap/later.js, start({ pay })) on a mainnet fork, with the live private ETH pool, the zap
// (TacitEvmPoolZap), zRouter, zQuoter and the Precision pool, and real proofs made here with the ceremony key: a wallet's USDC (taken by an
// EIP-2612 permit signed for the zap) and another wallet's TAC (taken by an approval, sold through the Precision pool) are each sold in one
// transaction for exactly the deposit's ETH, which goes into the pool with the proof; later the swap's ETH is withdrawn into a swap that pays a
// fresh address (sent by another wallet). The card's quote (quoteThrough) is checked against what lands. The relay's path is not exercised.
//
//   node tests/swap-later-token-fork.mjs        (FORK=<rpc url>, QUOTE_RPC=<rpc url for zQuoter at the fork's block>)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';

// later.js imports by site path (/zrouter-guard.js, /swap/aggregate.js?cb=…): those are answered from dapp/ here
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { privateKeyToAccount } = require('viem/accounts');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { makeEvmTradeVenues } = await import('../dapp/evm-trade-venues.js');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { makeLater, depositFor, readPlans, quoteThrough, ZAP, POOL, CHAIN } = await import('../dapp/swap/later.js');
const { ZQUOTER } = await import('../dapp/swap/route.js');

const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co';
const PORT = 24900 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const ZERO = '0x0000000000000000000000000000000000000000', TAC_HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const SELF2 = '0x00000000000000000000000000000000000dE912', DEST = '0x00000000000000000000000000000000000De581', DEST2 = '0x00000000000000000000000000000000000De582';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || '').toLowerCase();
const hx = (v) => '0x' + BigInt(v).toString(16);
const pad = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { revert: /revert/i.test(j.error.message), data: j.error.data }); return j.result; };
const rpcA = (method, params = []) => post(RPC, method, params);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + pad(who) }, 'latest'])));
async function assert_rejects(fn, re, label) { let err = null; try { await fn(); } catch (e) { err = e; } ok(!!err && re.test(String(err.message)), label + (err ? '' : ' (it did not throw)')); }

const head = BigInt(await post(UP, 'eth_blockNumber', [])) - 2n, BLOCK = '0x' + head.toString(16);
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }

// zQuoter's scans are asked of the upstream node at the fork's block (a fork reads every pool slot by slot); every other read (balances,
// allowances, permits, the Precision pool) of the fork, which holds what this test gave the wallets
const ethCall = (to, data, block, o = {}) => (lc(to) === lc(ZQUOTER)
  ? post(UP, 'eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK])
  : rpcA('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value != null ? { value: hx(o.value) } : {}), ...(o.gas ? { gas: o.gas } : {}) }, 'latest', ...(o.state ? [o.state] : [])]));
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });

const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const times = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const chain = { chainId: 1, rpc: [RPC], keeper: null, deployBlock: CHAIN.deployBlock, confirmations: 0, logChunk: 50000 };
const receipt = async (h) => { for (let i = 0; i < 100; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
// a wallet: a fresh key (for typed data) whose address the fork lets this test send from
async function walletFor({ typed = true } = {}) {
  const acct = privateKeyToAccount('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'));
  await rpcA('anvil_impersonateAccount', [acct.address]); await rpcA('anvil_setBalance', [acct.address, hx(10n ** 18n)]);
  const steps = [];
  const sg = { address: acct.address, rpc: (m, p) => rpcA(m, p), ready: async () => {}, receipt,
    send: async ({ to, data, value }) => { steps.push(`send:${lc(to)}`); return rpcA('eth_sendTransaction', [{ from: sg.address, to, data, value: hx(value || 0), gas: '0x7A1200' }]); } };
  // viem signs typed data with the uint fields as numbers, and builds the domain type itself
  if (typed) sg.signTyped = async ({ types, primaryType, domain, message }) => {
    steps.push(`sign:${primaryType}`);
    const big = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, big(x)])) : v);
    const { EIP712Domain, ...rest } = types;
    return acct.signTypedData({ domain: { ...domain, chainId: BigInt(domain.chainId) }, types: rest, primaryType, message: big(message) });
  };
  return { sg, steps, acct };
}
const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const privHex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const now = async () => Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp));
const FEE = 3n * 10n ** 14n;
await rpcA('anvil_impersonateAccount', [SELF2]); await rpcA('anvil_setBalance', [SELF2, hx(10n ** 18n)]);
const sendFromSelf2 = async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: SELF2, to, data, value: hx(value || 0), gas: '0x7A1200' }]);

// ── USDC, by a permit signed for the zap ──
{
  const { sg, steps } = await walletFor();
  // USDC's balances live at slot 9 (FiatTokenV2_2 balanceAndBlacklistStates), the top bit the blacklist flag
  const slot = '0x' + Buffer.from(keccak_256(Buffer.from(pad(sg.address) + pad(9), 'hex'))).toString('hex');
  await rpcA('anvil_setStorageAt', [USDC, slot, '0x' + pad(hx(1000n * 10n ** 6n))]);
  ok((await bal(USDC, sg.address)) === 1000n * 10n ** 6n, 'the wallet holds 1,000 USDC on the fork');
  const L = makeLater({ keyHex: async () => privHex, signer: sg, ethCall, venues, store, chain, prove });
  const amountIn = 150n * 10n ** 6n, dl = BigInt((await now()) + 1200);
  const q = await quoteThrough({ ethCall, venues, pay: USDC, get: WBTC, amountIn, slippageBps: 100, deadline: dl });
  ok(!!q && q.r0.min > 0n && q.ethWei > 0n && q.ethWei <= q.r0.out && q.r1.out > 0n, `the card's quote: 150 USDC → ${q ? Number(q.ethWei) / 1e18 : '?'} ETH (${q?.r0.name}) → ${q ? Number(q.r1.out) / 1e8 : '?'} WBTC (${q?.r1.name})`);
  ok(String(q.ethWei).replace(/0+$/, '').length <= 3, `the swap's ETH is three significant figures (${q.ethWei})`);
  const { depositWei, extraWei } = depositFor({ swapWei: q.ethWei, feeWei: FEE, pct: 30 });
  const est = (amountIn * depositWei * 10020n + q.r0.min * 10000n - 1n) / (q.r0.min * 10000n), most = (est * 10100n) / 10000n;
  const pay = { token: USDC, sym: 'USDC', dec: 6, amountIn, min: q.r0.min, most, slippageBps: 100 };

  const u0 = await bal(USDC, sg.address);
  await assert_rejects(() => L.start({ swapWei: q.ethWei, extraWei, token: WBTC, sym: 'WBTC', dec: 8, to: DEST, depositWei, pay: { ...pay, most: est / 2n } }), /price moved/, 'a deposit that would take more USDC than the card showed is refused');
  ok(readPlans(store).length === 0 && (await bal(USDC, sg.address)) === u0 && !steps.length, 'and nothing was signed, sent or kept');
  await assert_rejects(() => L.start({ swapWei: q.ethWei, extraWei, token: WBTC, sym: 'WBTC', dec: 8, to: sg.address, depositWei, pay }), /another address/, 'a swap to the wallet that deposits is refused');

  const e0 = await bal(ZERO, sg.address), p0 = await bal(ZERO, POOL);
  const plan = await L.start({ swapWei: q.ethWei, extraWei, token: WBTC, sym: 'WBTC', dec: 8, to: DEST, depositWei, pay, onStep: (s) => steps.push(s) });
  const spent = u0 - (await bal(USDC, sg.address));
  ok(plan.state === 'waiting' && /^0x[0-9a-f]{64}$/.test(plan.depositTx), `the deposit is made from USDC and the plan kept (${plan.state})`);
  ok(steps.includes('sign:Permit') && !steps.some((s) => s === `send:${lc(USDC)}`), 'the zap took the USDC by a permit signed for it, with no approval sent');
  ok(spent === BigInt(plan.pay.amountWei) && spent <= most && spent >= amountIn, `it spent exactly what the plan says, ${Number(spent) / 1e6} USDC, within the ${Number(most) / 1e6} shown`);
  const rc = await rpcA('eth_getTransactionReceipt', [plan.depositTx]);
  ok(rc.status === '0x1' && lc(rc.to) === lc(ZAP), `one transaction, to the zap (${BigInt(rc.gasUsed)} gas)`);
  ok((await bal(ZERO, POOL)) - p0 === depositWei, `the pool took exactly the deposit, ${Number(depositWei) / 1e18} ETH`);
  const back = (await bal(ZERO, sg.address)) - e0 + BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
  ok(back >= 0n && back < depositWei / 20n, `what the swap paid over the deposit came back to the wallet (${Number(back) / 1e18} ETH)`);
  ok((await bal(ZERO, ZAP)) === 0n && (await bal(USDC, ZAP)) === 0n, 'the zap holds nothing after');
  const b = await L.blend(plan);
  ok(b.balance === depositWei, `the deposit is a private note of exactly its amount (${b.balance})`);
  // a deposit makes two leaves: the plan's mark from before it is two under the one kept after
  ok((await L.check({ ...plan, state: 'unsure', depositedAt: undefined, depositTx: undefined, leaves0: Number(plan.leaves0) - 2 })).state === 'waiting', 'a plan in doubt finds its zapped deposit in the pool');

  // the swap out, from another wallet: WBTC to a fresh address, at least the price shown
  const shown = await L.offer(plan, { slippageBps: 100 });
  ok(shown.min > 0n, `a price is shown for the swap out: at least ${Number(shown.min) / 1e8} WBTC`);
  const depositor = sg.address;
  sg.address = SELF2; sg.send = sendFromSelf2;
  const w0 = await bal(WBTC, DEST);
  const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'self' });
  const got = (await bal(WBTC, DEST)) - w0;
  ok(done.state === 'done' && got >= shown.min, `the address got ${Number(got) / 1e8} WBTC, at least the ${Number(shown.min) / 1e8} shown`);
  ok(got >= (q.r1.min * 97n) / 100n, `close to the card's quote (${Number(q.r1.out) / 1e8} WBTC)`);
  ok((await L.blend(done)).balance === depositWei - q.ethWei, 'the rest of the deposit stays a private note');
  ok(!(await rpcA('eth_getTransactionByHash', [done.swapTx])).input.toLowerCase().includes(lc(depositor).slice(2)), 'the swap out does not name the wallet that deposited');
}

// ── the other ways the zap takes a token: a Permit2 transfer (USDT, approved to Permit2 already, has no EIP-2612 permit), and DAI, whose own
// permit the zap has no door for, so no permit is asked and an approval goes first ──
for (const [sym, token, dec, wantSign, wantApprove] of [['USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 'sign:PermitTransferFrom', false], ['DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18, null, true]]) {
  const { sg, steps } = await walletFor();
  // both keep balances in a mapping at slot 2
  const slot = '0x' + Buffer.from(keccak_256(Buffer.from(pad(sg.address) + pad(2), 'hex'))).toString('hex');
  await rpcA('anvil_setStorageAt', [token, slot, '0x' + pad(hx(500n * 10n ** BigInt(dec)))]);
  if (sym === 'USDT') await receipt(await rpcA('eth_sendTransaction', [{ from: sg.address, to: token, data: '0x095ea7b3' + pad('0x000000000022D473030F116dDEE9F6B43aC78BA3') + 'f'.repeat(64), gas: '0x30000' }]));
  const L = makeLater({ keyHex: async () => privHex, signer: sg, ethCall, venues, store, chain, prove });
  const amountIn = 100n * 10n ** BigInt(dec), dl = BigInt((await now()) + 1200);
  const q = await quoteThrough({ ethCall, venues, pay: token, get: ZERO, amountIn, slippageBps: 100, deadline: dl });
  const { depositWei, extraWei } = depositFor({ swapWei: q.ethWei, feeWei: FEE, pct: 20 });
  const est = (amountIn * depositWei * 10020n + q.r0.min * 10000n - 1n) / (q.r0.min * 10000n);
  const b0 = await bal(token, sg.address), p0 = await bal(ZERO, POOL);
  const plan = await L.start({ swapWei: q.ethWei, extraWei, token: ZERO, sym: 'ETH', dec: 18, to: DEST, depositWei, pay: { token, sym, dec, amountIn, min: q.r0.min, most: (est * 10100n) / 10000n, slippageBps: 100 }, onStep: (x) => steps.push(x) });
  const spent = b0 - (await bal(token, sg.address));
  ok(plan.state === 'waiting' && (await bal(ZERO, POOL)) - p0 === depositWei && spent === BigInt(plan.pay.amountWei), `${sym}: ${Number(spent) / 10 ** dec} ${sym} became a deposit of exactly ${Number(depositWei) / 1e18} ETH`);
  ok(wantSign ? steps.includes(wantSign) && !steps.includes('approve') : !steps.some((x) => /^sign:/.test(x)) && steps.includes('approve'),
    `${sym}: ${wantSign ? 'taken by a Permit2 transfer signed for the zap, with no approval' : 'no permit asked, one approval of exactly the amount'} (${steps.filter((x) => /^sign:|^approve$/.test(x)).join(', ')})`);
  ok((await bal(token, ZAP)) === 0n && (await bal(ZERO, ZAP)) === 0n, `${sym}: the zap holds nothing after`);
}

// ── a token with no permit and no Permit2 allowance (WBTC): the approval and the zap in one batch where the wallet sends batches (EIP-5792);
// a wallet that says it does and then will not: the approval mined first, then the deposit alone ──
for (const refuse of [false, true]) {
  const WB = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
  const { sg, steps } = await walletFor();
  await rpcA('anvil_dealERC20', [sg.address, WB, hx(10n ** 7n)]);
  sg.canBatch = async () => true;
  // the test's wallet runs a batch's calls one after another and hands back the last one's hash
  sg.batch = async (calls, sent) => {
    steps.push(`batch:${calls.map((c) => lc(c.to) === lc(ZAP) ? 'zap' : 'approve').join('+')}`);
    if (refuse) throw Object.assign(new Error('Your wallet does not send these together.'), { noBatch: true });
    let h; for (const c of calls) h = await rpcA('eth_sendTransaction', [{ from: sg.address, to: c.to, data: c.data, value: hx(c.value || 0), gas: '0x7A1200' }]);
    sent?.(); return h;
  };
  const L = makeLater({ keyHex: async () => privHex, signer: sg, ethCall, venues, store, chain, prove });
  const amountIn = 3n * 10n ** 5n, dl = BigInt((await now()) + 1200);
  const q = await quoteThrough({ ethCall, venues, pay: WB, get: ZERO, amountIn, slippageBps: 100, deadline: dl });
  const { depositWei, extraWei } = depositFor({ swapWei: q.ethWei, feeWei: FEE, pct: 20 });
  const est = (amountIn * depositWei * 10020n + q.r0.min * 10000n - 1n) / (q.r0.min * 10000n);
  const p0 = await bal(ZERO, POOL), b0 = await bal(WB, sg.address);
  const plan = await L.start({ swapWei: q.ethWei, extraWei, token: ZERO, sym: 'ETH', dec: 18, to: DEST, depositWei, pay: { token: WB, sym: 'WBTC', dec: 8, amountIn, min: q.r0.min, most: (est * 10100n) / 10000n, slippageBps: 100 }, onStep: (x) => steps.push(x) });
  ok(plan.state === 'waiting' && (await bal(ZERO, POOL)) - p0 === depositWei && b0 - (await bal(WB, sg.address)) === BigInt(plan.pay.amountWei), `WBTC${refuse ? ', batch refused' : ''}: the deposit landed, exactly ${Number(depositWei) / 1e18} ETH`);
  ok(refuse ? steps.includes('batch:approve+zap') && steps.includes('approve') && steps.filter((x) => /^send:/.test(x)).join() === `send:${lc(WB)},send:${lc(ZAP)}`
    : steps.includes('batch:approve+zap') && !steps.includes('approve') && !steps.some((x) => /^send:/.test(x)),
  refuse ? 'the wallet would not batch: the approval went first, then the deposit alone' : `the approval and the zap went in one batch, one confirmation (${steps.filter((x) => /^batch|^send|^approve/.test(x)).join(', ')})`);
  ok(BigInt(await rpcA('eth_call', [{ to: WB, data: '0xdd62ed3e' + pad(sg.address) + pad(ZAP) }, 'latest'])) === 0n && (await bal(WB, ZAP)) === 0n, 'and the zap keeps no allowance and holds nothing');
}

// ── TAC, by its EIP-2612 permit signed for the zap, through the Precision pool or both pools: one transaction in, none out (the swap out is sent for it) ──
{
  const { sg, steps } = await walletFor();
  await rpcA('anvil_impersonateAccount', [TAC_HOLDER]); await rpcA('anvil_setBalance', [TAC_HOLDER, hx(10n ** 18n)]);
  await receipt(await rpcA('eth_sendTransaction', [{ from: TAC_HOLDER, to: TAC, data: '0xa9059cbb' + pad(sg.address) + pad(hx(5000n * 10n ** 18n)), gas: '0x30000' }]));
  ok((await bal(TAC, sg.address)) === 5000n * 10n ** 18n, 'another wallet holds 5,000 TAC on the fork');
  const L = makeLater({ keyHex: async () => privHex, signer: sg, ethCall, venues, store, chain, prove });
  const amountIn = 1500n * 10n ** 18n, dl = BigInt((await now()) + 1200);
  const q = await quoteThrough({ ethCall, venues, pay: TAC, get: USDC, amountIn, slippageBps: 100, deadline: dl });
  ok(!!q && /^(Precision|Both) pools?$/.test(q.r0.name) && q.r1.out > 0n, `the card's quote: 1,500 TAC → ${q ? Number(q.ethWei) / 1e18 : '?'} ETH (${q?.r0.name}) → ${q ? Number(q.r1.out) / 1e6 : '?'} USDC`);
  const { depositWei, extraWei } = depositFor({ swapWei: q.ethWei, feeWei: FEE, pct: 20 });
  const est = (amountIn * depositWei * 10020n + q.r0.min * 10000n - 1n) / (q.r0.min * 10000n), most = (est * 10100n) / 10000n;
  const t0 = await bal(TAC, sg.address), p0 = await bal(ZERO, POOL);
  const plan = await L.start({ swapWei: q.ethWei, extraWei, token: USDC, sym: 'USDC', dec: 6, to: DEST2, depositWei, pay: { token: TAC, sym: 'TAC', dec: 18, amountIn, min: q.r0.min, most, slippageBps: 100 }, onStep: (s) => steps.push(s) });
  const spent = t0 - (await bal(TAC, sg.address));
  ok(plan.state === 'waiting' && plan.pay?.route === q.r0.name, `the deposit is made from TAC through the route quoted, ${q.r0.name} (${plan.state})`);
  ok(steps.includes('sign:Permit') && !steps.includes('approve') && steps.filter((s) => /^send:/.test(s)).join() === `send:${lc(ZAP)}`, `TAC's permit signed for the zap, and one transaction, to the zap (${steps.filter((s) => /^send:|^sign:/.test(s)).join(', ')})`);
  ok(spent === BigInt(plan.pay.amountWei) && spent <= most, `it spent exactly ${Number(spent) / 1e18} TAC, within the ${Number(most) / 1e18} shown`);
  ok(BigInt(await rpcA('eth_call', [{ to: TAC, data: '0xdd62ed3e' + pad(sg.address) + pad(ZAP) }, 'latest'])) === 0n, 'and the zap keeps no allowance');
  ok((await bal(ZERO, POOL)) - p0 === depositWei && (await bal(TAC, ZAP)) === 0n && (await bal(ZERO, ZAP)) === 0n, `the pool took exactly ${Number(depositWei) / 1e18} ETH, the zap holds nothing`);
  const shown = await L.offer(plan, { slippageBps: 100 });
  sg.address = SELF2; sg.send = sendFromSelf2;
  const u0 = await bal(USDC, DEST2);
  const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'self' });
  const got = (await bal(USDC, DEST2)) - u0;
  ok(done.state === 'done' && got >= shown.min, `the address got ${Number(got) / 1e6} USDC from TAC, privately, at least the ${Number(shown.min) / 1e6} shown`);
}
console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);
console.log(`\n${n} passed, ${fails} failed`);
anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
