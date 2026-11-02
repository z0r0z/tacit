#!/usr/bin/env node
// "Swap privately" (dapp/swap/later.js) end to end on a mainnet fork, with the live private ETH pool, its router, zRouter and zQuoter, and real
// proofs made here with the ceremony key: a wallet deposits the swap's ETH and an extra into the pool; later the pool wallet withdraws exactly
// the swap's ETH into a call intent's escrow (router.withdrawAndCall, sent by the signer) whose one call swaps it on zRouter, along the route
// routeOut finds with a stand-in address and then writes for the real one. The token lands at a fresh address, at least the route's floor;
// the extra stays a private note; nothing is left in the escrow. The relay's path (the keeper) is not exercised here.
//
//   node tests/swap-later-fork.mjs        (FORK=<rpc url>, QUOTE_RPC=<rpc url for zQuoter at the fork's block>; the pool's history is read from the keeper's feed)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { register } from 'node:module';

// later.js imports by site path (/zrouter-guard.js, /swap/aggregate.js?cb=…): those are answered from dapp/ here
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { callIntent } = await import('../dapp/evm-pool-gateway.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');
const { routeOut, routeOutTac, POOL, ROUTER, CHAIN } = await import('../dapp/swap/later.js');
const { makeEvmTradeVenues } = await import('../dapp/evm-trade-venues.js');
const { keccak_256 } = await import('@noble/hashes/sha3');

const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co';
const PORT = 24600 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', ZERO = '0x0000000000000000000000000000000000000000';
const FROM = '0x00000000000000000000000000000000000dE901', DEST = '0x00000000000000000000000000000000000De571';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { revert: /revert/i.test(j.error.message), data: j.error.data }); return j.result; };
const rpcA = (method, params = []) => post(RPC, method, params);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest'])));

const head = BigInt(await post(UP, 'eth_blockNumber', [])) - 2n, BLOCK = '0x' + head.toString(16);
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
await rpcA('anvil_impersonateAccount', [FROM]);
await rpcA('anvil_setBalance', [FROM, '0x' + (10n ** 18n).toString(16)]);

// the pool's tree is read from the fork's node; zQuoter's scans from the upstream node at the fork's block (a fork reads every pool slot by slot)
const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const times = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const keys = evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32)));
const rpc = jsonRpc([RPC]);
const signer = { address: FROM, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: FROM, to, data, value: '0x' + BigInt(value || 0).toString(16), gas: '0x7A1200' }]), rpc };
const W = makeEvmPoolWallet({ zk, keys, keeper: CHAIN.keeper, store: null, feed: true, prove, chain: { chainId: 1, pool: POOL, router: ROUTER, rpc, deployBlock: CHAIN.deployBlock, confirmations: 0, logChunk: 50000 } });
W.connect(signer);
const steps = [];
const t0 = Date.now();
await W.sync();
ok(true, `the pool's tree is read on the fork (${Math.round((Date.now() - t0) / 1000)} s, ${W.summary().leaves} leaves)`);

const swapWei = 2n * 10n ** 16n, extraWei = 10n ** 16n;
const h1 = await W.deposit({ amount: swapWei + extraWei, onStep: (s) => steps.push(s) });
ok(/^0x[0-9a-f]{64}$/.test(h1) && W.summary().balance === swapWei + extraWei, `the deposit of the swap's ETH and the extra is a private note (${W.summary().balance} wei)`);

const deadline = BigInt(Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp)) + 1200);
const upCall = (to, data, block, o = {}) => post(UP, 'eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK]);
const r = await routeOut({ ethCall: upCall, token: USDC, amount: swapWei, to: DEST, slippageBps: 100, deadline });
ok(!!r && r.callData.toLowerCase().includes(DEST.slice(2).toLowerCase()) && r.min > 0n, `the route is quoted with a stand-in and written for the real address (${r ? `${r.name}, at least ${r.min}` : 'none'})`);

const refund = await W.refundBox();
const intent = callIntent({ calls: [{ target: ZROUTER, value: swapWei, data: r.callData }], refund, deadline, nonce: 7n });
const u0 = await bal(USDC, DEST);
const h2 = await W.withdrawAndCall({ intent, amount: swapWei, via: 'self', onStep: (s) => steps.push(s) });
const rc = await rpcA('eth_getTransactionReceipt', [h2]);
ok(rc?.status === '0x1' && rc.to?.toLowerCase() === ROUTER.toLowerCase(), `the withdrawal into the swap runs, sent to the router (${BigInt(rc?.gasUsed || 0)} gas)`);
const got = (await bal(USDC, DEST)) - u0;
ok(got >= r.min, `the fresh address got ${Number(got) / 1e6} USDC, at least the floor ${Number(r.min) / 1e6}`);
await W.sync();
ok(W.summary().balance === extraWei, `the extra stays a private note (${W.summary().balance} wei)`);
ok((await bal(ZERO, (await import('../dapp/evm-pool-gateway.js')).callEscrowAddress(intent, ROUTER))) === 0n, 'nothing is left in the escrow');
ok(!(await rpcA('eth_getTransactionByHash', [h2])).input.toLowerCase().includes(FROM.slice(2).toLowerCase()), 'the swap out does not name the wallet that deposited');
console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);

// ── ETH → TAC: the route is the Precision pool or the Tacit pool, built as zRouter's calls with the address as recipient; the TAC lands there ──
{
  const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', DEST3 = '0x00000000000000000000000000000000000De573';
  const venues = makeEvmTradeVenues({ ethCall: (to, data, block) => upCall(to, data, block), keccak256: keccak_256 });
  const h3 = await W.deposit({ amount: swapWei + extraWei, onStep: () => {} });
  ok(/^0x[0-9a-f]{64}$/.test(h3), 'a second deposit for a swap into TAC');
  const dl = BigInt(Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp)) + 1200);
  const rt = await routeOutTac({ venues, amount: swapWei, to: DEST3, slippageBps: 100, deadline: dl });
  ok(!!rt && rt.callData.toLowerCase().includes(DEST3.slice(2).toLowerCase()) && !rt.standData.toLowerCase().includes(DEST3.slice(2).toLowerCase()) && rt.min > 0n, `the TAC route is built for the address, its copy for a stand-in (${rt ? `${rt.name}, at least ${rt.min}` : 'none'})`);
  const refund3 = await W.refundBox();
  const intent3 = callIntent({ calls: [{ target: ZROUTER, value: swapWei, data: rt.callData }], refund: refund3, deadline: dl, nonce: 9n });
  const t0 = await bal(TAC, DEST3);
  const h4 = await W.withdrawAndCall({ intent: intent3, amount: swapWei, via: 'self', onStep: () => {} });
  const rc4 = await rpcA('eth_getTransactionReceipt', [h4]);
  const got3 = (await bal(TAC, DEST3)) - t0;
  ok(rc4?.status === '0x1' && got3 >= rt.min, `the withdrawal into the TAC swap runs: the address got ${Number(got3) / 1e18} TAC, at least the ${Number(rt.min) / 1e18} shown`);
  ok((await bal(ZERO, (await import('../dapp/evm-pool-gateway.js')).callEscrowAddress(intent3, ROUTER))) === 0n, 'nothing is left in that escrow either');

  // into a private balance: the same route pays the key's own Tacit account, and the withdrawal hands it the gas to make the TAC private from there
  const ACCT = '0x00000000000000000000000000000000000ACc70', gasWei = 15n * 10n ** 14n;
  const h5 = await W.deposit({ amount: swapWei + gasWei + extraWei, onStep: () => {} });
  ok(/^0x[0-9a-f]{64}$/.test(h5), 'a deposit for a swap that ends private, the gas for the wrap inside it');
  const dl2 = BigInt(Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp)) + 1200);
  // priced from the fork as it stands: the swap above moved the pool, which the fork's original block does not show
  const venuesNow = makeEvmTradeVenues({ ethCall: (to, data) => rpcA('eth_call', [{ to, data }, 'latest']), keccak256: keccak_256 });
  const rt2 = await routeOutTac({ venues: venuesNow, amount: swapWei, to: ACCT, slippageBps: 100, deadline: dl2 });
  const refund4 = await W.refundBox();
  const intent4 = callIntent({ calls: [{ target: ZROUTER, value: swapWei, data: rt2.callData }, { target: ACCT, value: gasWei }], refund: refund4, deadline: dl2, nonce: 11n });
  const [tacc0, eth0] = [await bal(TAC, ACCT), await bal(ZERO, ACCT)];
  const h6 = await W.withdrawAndCall({ intent: intent4, amount: swapWei + gasWei, via: 'self', onStep: () => {} });
  const rc6 = await rpcA('eth_getTransactionReceipt', [h6]);
  ok(rc6?.status === '0x1' && (await bal(TAC, ACCT)) - tacc0 >= rt2.min && (await bal(ZERO, ACCT)) - eth0 === gasWei, `one withdrawal pays the account ${Number((await bal(TAC, ACCT)) - tacc0) / 1e18} TAC and ${Number(gasWei) / 1e18} ETH for the wrap`);
  ok((await bal(ZERO, (await import('../dapp/evm-pool-gateway.js')).callEscrowAddress(intent4, ROUTER))) === 0n, 'and leaves nothing in its escrow');
}

// ── the same through makeLater: what the card calls (plan kept, deposit, wait, a price shown, the swap out, a plan checked) ──
{
  const { makeLater, depositFor, readPlans } = await import('../dapp/swap/later.js');
  const SELF2 = '0x00000000000000000000000000000000000dE902', DEST2 = '0x00000000000000000000000000000000000De572';
  await rpcA('anvil_impersonateAccount', [SELF2]); await rpcA('anvil_setBalance', [SELF2, '0x' + (10n ** 18n).toString(16)]);
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const sg = { address: FROM, send: signer.send, rpc, ready: async () => {} };
  const privHex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const chain = { chainId: 1, rpc: [RPC], keeper: CHAIN.keeper, deployBlock: CHAIN.deployBlock, confirmations: 0, logChunk: 50000 };
  const L = makeLater({ keyHex: async () => privHex, signer: sg, ethCall: upCall, store, chain, prove });
  const swap = 2n * 10n ** 16n, fee = 3n * 10n ** 14n, { depositWei, extraWei } = depositFor({ swapWei: swap, feeWei: fee, pct: 40 });
  ok(depositWei > swap + 2n * fee && extraWei >= swap / 20n, `the deposit is not the swap: ${depositWei} for a swap of ${swap}`);
  await assert_rejects(() => L.start({ swapWei: swap, extraWei, token: USDC, sym: 'USDC', dec: 6, to: FROM, depositWei }), /another address/, 'a swap to the wallet that deposits is refused before anything is sent');
  const plan = await L.start({ swapWei: swap, extraWei, token: USDC, sym: 'USDC', dec: 6, to: DEST2, depositWei });
  ok(plan.state === 'waiting' && /^0x[0-9a-f]{64}$/.test(plan.depositTx) && readPlans(store).length === 1, `the deposit is made and the plan kept (${plan.state})`);
  ok(readPlans(store)[0].from === FROM.toLowerCase(), 'the plan names the wallet that deposited, so it is not used to send the swap out');
  const b = await L.blend(plan);
  ok(b.since === 0 && b.balance === depositWei, `the wait counts the pool's new notes since the deposit (${b.since}) and the balance is the deposit`);
  const shown = await L.offer(plan, { slippageBps: 100 });
  ok(shown.min > 0n && shown.callData && shown.standData && shown.standData !== shown.callData, `a price is shown: at least ${shown.min} via ${shown.name}`);
  await assert_rejects(() => L.swapOut(plan, { shown, via: 'self' }), /Not from the wallet that deposited/, 'the swap out is not sent from the wallet that deposited');
  sg.address = SELF2;                                           // another wallet connected
  sg.send = async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: SELF2, to, data, value: '0x' + BigInt(value || 0).toString(16), gas: '0x7A1200' }]);
  const u0 = await bal(USDC, DEST2);
  const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'self' });
  ok(done.state === 'done' && /^0x[0-9a-f]{64}$/.test(done.swapTx) && done.from === undefined, `the swap out is made from another wallet, and the plan forgets who deposited (${done.state})`);
  const got2 = (await bal(USDC, DEST2)) - u0;
  ok(got2 >= shown.min, `the address got ${Number(got2) / 1e6} USDC, at least the ${Number(shown.min) / 1e6} shown`);
  const doubt = { ...done, state: 'unsure', balBefore: String(depositWei), swapAt: Date.now() };
  const chk = await L.check({ ...doubt });
  ok(chk.state === 'done', `a plan left in doubt is read against the pool and found done (${chk.state})`);
  const recent = await L.check({ ...done, state: 'unsure', balBefore: String(depositWei - swap), swapAt: Date.now() });
  ok(recent.state === 'unsure', 'a swap sent a moment ago that the pool does not show yet stays in doubt, never offered again');
  const stuck = await L.check({ ...done, state: 'unsure', balBefore: String(depositWei - swap), swapAt: Date.now() - 21 * 60e3 });
  ok(stuck.state === 'waiting', 'and one whose swap did not spend the pool\'s ETH within twenty minutes goes back to waiting, not done');
  const NEWER = 10 ** 9;                                       // a plan begun after every note the pool has
  const gone = await L.check({ id: 'x', at: Date.now(), state: 'depositing', depositWei: String(7n * 10n ** 15n), swapWei: String(swap), to: DEST2, leaves0: NEWER });
  ok(gone.state === 'stopped', 'a deposit that never reached the pool is found stopped');
  const change = depositWei - swap;                            // the note the swap out left in the pool
  const old = await L.check({ id: 'y', at: Date.now(), state: 'depositing', depositWei: String(change), swapWei: String(swap), to: DEST2, leaves0: NEWER });
  ok(old.state === 'stopped', 'a note of the same size that the pool made before the plan began is not its deposit');
  const fresh = await L.check({ id: 'z', at: Date.now(), state: 'depositing', depositWei: String(change), swapWei: String(swap), to: DEST2, leaves0: Number(done.leaves0) });
  ok(fresh.state === 'waiting' && fresh.depositedAt, 'and one it made after is');
}
async function assert_rejects(fn, re, label) { let err = null; try { await fn(); } catch (e) { err = e; } ok(!!err && re.test(String(err.message)), label + (err ? '' : ' (it did not throw)')); }

console.log(`\n${n} passed, ${fails} failed`);
anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
