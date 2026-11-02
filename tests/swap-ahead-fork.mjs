#!/usr/bin/env node
// A deposit proved before it is asked for, on a mainnet fork with the live private ETH pool and real proofs made here with the ceremony key: the
// pool accepts a proof made ahead when its head has not moved, the press then proves nothing; when another deposit has moved the head the press
// proves again and the pool accepts that one. Then the same through makeLater (what the card calls): ahead, then start.
//
// The pool's history is read from the keeper's feed, as the card reads it.
//
//   node tests/swap-ahead-fork.mjs        (FORK=<rpc url>, default publicnode: it serves the fork's block for a couple of minutes)
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
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');
const { makeLater, POOL, ROUTER, CHAIN } = await import('../dapp/swap/later.js');

const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com';
const PORT = 24900 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FROM = '0x00000000000000000000000000000000000dE901', OTHER = '0x00000000000000000000000000000000000dE902', DEST = '0x00000000000000000000000000000000000De571';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
const rpcA = (method, params = []) => post(RPC, method, params);

const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n;
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [FROM, OTHER]) { await rpcA('anvil_impersonateAccount', [a]); await rpcA('anvil_setBalance', [a, '0x' + (10n ** 19n).toString(16)]); }

const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const times = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const rpc = jsonRpc([RPC]);
let asked = 0;                                                  // when the wallet was last asked to send
const signerOf = (from) => ({ address: from, send: async ({ to, data, value }) => (asked = Date.now(), rpcA('eth_sendTransaction', [{ from, to, data, value: '0x' + BigInt(value || 0).toString(16), gas: '0x7A1200' }])), rpc, ready: async () => {} });
const walletOf = (from) => {
  const keys = evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32)));
  const w = makeEvmPoolWallet({ zk, keys, keeper: CHAIN.keeper, store: null, feed: true, prove, chain: { chainId: 1, pool: POOL, router: ROUTER, rpc, deployBlock: CHAIN.deployBlock, confirmations: 0, logChunk: 50000 } });
  w.connect(signerOf(from));
  return w;
};
const A = 2n * 10n ** 16n, B = 3n * 10n ** 16n, C = 4n * 10n ** 16n;
const W = walletOf(FROM), W2 = walletOf(OTHER);

await W.sync();
ok(true, `the live pool is read on the fork (${W.summary().leaves} leaves)`);

// ── the proof made ahead is accepted by the pool; the press proves nothing ──
{
  const t0 = Date.now();
  await W.prepareDeposit(A);
  const ahead = Date.now() - t0, proved = times.length;
  ok(proved === 1, `a deposit is proved ahead (${(ahead / 1000).toFixed(1)} s)`);
  const steps = [], t1 = Date.now();
  const h = await W.deposit({ amount: A, onStep: (s) => steps.push(s) });
  const press = Date.now() - t1;
  ok(times.length === proved && !steps.includes('proving on this device'), 'the press proved nothing');
  const rc = await rpcA('eth_getTransactionReceipt', [h]);
  ok(rc?.status === '0x1' && rc.to?.toLowerCase() === POOL.toLowerCase(), 'the pool accepted the proof made ahead');
  ok(W.summary().balance === A, `the note is the wallet's (${W.summary().balance} wei)`);
  console.log(`  the press: ${((asked - t1) / 1000).toFixed(2)} s until the wallet is asked, ${(press / 1000).toFixed(2)} s until the note is seen (the proof took ${(ahead / 1000).toFixed(1)} s)`);
}

// ── another deposit moves the head after the proof: the press proves again, and the pool accepts that proof ──
{
  await W.prepareDeposit(B);
  await W2.deposit({ amount: C });
  const proved = times.length, steps = [];
  const h = await W.deposit({ amount: B, onStep: (s) => steps.push(s) });
  ok(times.length === proved + 1 && steps.includes('proving on this device'), 'the head moved, so the press proved on the new head');
  const rc = await rpcA('eth_getTransactionReceipt', [h]);
  ok(rc?.status === '0x1', 'and the pool accepted it');
  ok(W.summary().balance === A + B, `the wallet holds both deposits (${W.summary().balance} wei)`);
}

// ── through makeLater: ahead while the button waits, then start ──
{
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const chain = { chainId: 1, rpc: [RPC], keeper: CHAIN.keeper, deployBlock: CHAIN.deployBlock, confirmations: 0, logChunk: 50000 };
  const priv = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const L = makeLater({ keyHex: async () => priv, signer: signerOf(FROM), ethCall: async () => '0x', store, chain, prove });
  const swap = 2n * 10n ** 16n, depositWei = 3n * 10n ** 16n;
  const before = times.length;
  await L.ahead({ depositWei, hop: null });
  ok(times.length === before + 1, 'the card\'s ask proves the deposit it shows');
  const t1 = Date.now(), steps = [];
  const plan = await L.start({ swapWei: swap, extraWei: depositWei - swap, token: USDC, sym: 'USDC', dec: 6, to: DEST, depositWei, onStep: (s) => steps.push(s) });
  ok(times.length === before + 1 && !steps.includes('proving on this device'), 'start proved nothing');
  ok(plan.state === 'waiting' && /^0x[0-9a-f]{64}$/.test(plan.depositTx), `the deposit is made and the plan kept (${plan.state}; the wallet is asked ${((asked - t1) / 1000).toFixed(2)} s after the press)`);
  const rc = await rpcA('eth_getTransactionReceipt', [plan.depositTx]);
  ok(rc?.status === '0x1', 'and the pool accepted it');
}

console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);
console.log(`\n${n} passed, ${fails} failed`);
anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
