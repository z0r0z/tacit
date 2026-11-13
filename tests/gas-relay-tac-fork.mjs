#!/usr/bin/env node
// TAC sold for ETH by the gas relay for a wallet with no ETH, as the Swap card sends a deposit for "Swap privately" (dapp/swap/later.js sellTac,
// dapp/gas-relay.js buildOrder), on a mainnet fork with the live TacitGasRelay, zRouter and both TAC pools: the wallet signs an order and a
// permit and pays nothing else; a relay sends TacitGasRelay.execute; the ETH lands at the box address, at least the floor; the relay earns
// its fee in TAC; and the gas the relay burns stays inside what the card's fee pays for by the relay's own rule (fee >= gas x 1.2, the
// fee priced at 1.5x the units it names), for a sale through both pools and through one.
//
//   node tests/gas-relay-tac-fork.mjs        (FORK=<rpc url for anvil>, QUOTE_RPC=<rpc url for the head block>)
import { spawn } from 'node:child_process';
import { createRequire, register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { privateKeyToAccount } = require('viem/accounts');
const { sellTac } = await import('../dapp/swap/later.js');
const { makeEvmTradeVenues, SPLIT_EXTRA_GAS, ZROUTER } = await import('../dapp/evm-trade-venues.js');
const GR = await import('../dapp/gas-relay.js');
const { encodeExecute } = await import('../worker-relay/src/lib/gas-calls.js');
const { keccak_256 } = await import('@noble/hashes/sha3');

const FORK = process.env.FORK || 'https://rpc.mevblocker.io', UP = process.env.QUOTE_RPC || 'https://rpc.mevblocker.io';
const PORT = 25000 + Math.floor(Math.random() * 400), RPC = `http://127.0.0.1:${PORT}`;
const TAC = GR.TAC, RELAY = GR.GAS_RELAY[1], ZERO = '0x0000000000000000000000000000000000000000';
const TAC_HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', RELAYER = '0x00000000000000000000000000000000000Ee1a7';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
const rpcA = (method, params = []) => post(RPC, method, params);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0'), hx = (v) => '0x' + BigInt(v).toString(16);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + pad(who) }, 'latest'])));
const receipt = async (h) => { for (let i = 0; i < 100; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
const fmt = (v, d = 18, p = 6) => (Number(v) / 10 ** d).toFixed(p);

const head = BigInt(await post(UP, 'eth_blockNumber', [])) - 2n;
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }

const payer = privateKeyToAccount('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'));
await rpcA('anvil_impersonateAccount', [TAC_HOLDER]); await rpcA('anvil_setBalance', [TAC_HOLDER, hx(10n ** 18n)]);
await receipt(await rpcA('eth_sendTransaction', [{ from: TAC_HOLDER, to: TAC, data: '0xa9059cbb' + pad(payer.address) + pad(hx(11000n * 10n ** 18n)), gas: '0x30000' }]));
await rpcA('anvil_impersonateAccount', [RELAYER]); await rpcA('anvil_setBalance', [RELAYER, hx(10n ** 18n)]);
ok((await bal(TAC, payer.address)) === 11000n * 10n ** 18n && (await bal(ZERO, payer.address)) === 0n, `a wallet with 11,000 TAC and no ETH (${payer.address})`);

const venues = makeEvmTradeVenues({ ethCall: (to, data) => rpcA('eth_call', [{ to, data }, 'latest']), keccak256: keccak_256 });
const strip = (t) => { const { EIP712Domain, ...types } = t.types; return { ...t, types }; };
const chainNow = async () => Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp));

// what the card does in relayFundRun: route, fee for the units the route burns, order, permit for the sale and the fee together
async function relayedSale({ amount, gasPrice, label, want }) {
  const box = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex'), now = await chainNow(), dl = BigInt(now + 1200);
  const r = await sellTac({ venues, amount, account: RELAY, to: box, slippageBps: 50, deadline: dl, gasPrice });
  ok(!!r && r.name === want && r.callData.includes(pad(box)) && r.amountIn === amount, `${label}: the route is ${r?.name}${r?.legs ? ` (${r.legs.map((l) => `${fmt(l.amountIn, 18, 0)} TAC in the ${l.venue} pool`).join(', ')})` : ''}, paying the box at least ${r ? fmt(r.min) : '?'} ETH`);
  if (!r) return;
  const units = GR.GAS_UNITS + (r.legs ? SPLIT_EXTRA_GAS.TAC_TO_ETH : 0n), fee = 3n * 10n ** 18n;
  const { order, data } = GR.buildOrder({ payer: payer.address, tokenIn: TAC, amountIn: amount, feeToken: TAC, fee, tokenOut: ZERO, minOut: r.min, recipient: box, target: ZROUTER, data: r.callData, ttlSecs: 240, now });
  const signature = await payer.signTypedData(strip(GR.orderTypedData(order)));
  const nonce = BigInt(await rpcA('eth_call', [{ to: TAC, data: '0x7ecebe00' + pad(payer.address) }, 'latest']));
  const pdl = BigInt(now + 600), ps = GR.splitSig(await payer.signTypedData(strip(GR.permitTypedData({ token: TAC, owner: payer.address, value: amount + fee, nonce, deadline: pdl }))));
  const NONE = { value: '0', deadline: '0', v: 0, r: '0x' + '0'.repeat(64), s: '0x' + '0'.repeat(64) };
  const call = encodeExecute({ order, signature, data, inPermit: { value: String(amount + fee), deadline: String(pdl), ...ps }, feePermit: NONE, p2: null });
  const t0 = await bal(TAC, payer.address), rt0 = await bal(TAC, RELAYER);
  const gas = BigInt(await rpcA('eth_estimateGas', [{ from: RELAYER, to: RELAY, data: call }]));
  const rc = await receipt(await rpcA('eth_sendTransaction', [{ from: RELAYER, to: RELAY, data: call, gas: hx((gas * 13n) / 10n) }]));
  const used = BigInt(rc?.gasUsed || 0), got = await bal(ZERO, box);
  ok(rc?.status === '0x1' && got >= r.min, `${label}: the relay's execute lands (${used} gas) and the box got ${fmt(got)} ETH, at least the ${fmt(r.min)} floor`);
  ok(t0 - (await bal(TAC, payer.address)) === amount + fee && (await bal(TAC, RELAYER)) - rt0 === fee && (await bal(TAC, RELAY)) === 0n && (await bal(ZERO, payer.address)) === 0n,
    `${label}: the wallet paid exactly the sale and the 3 TAC fee, the relay earned the fee, the relay contract keeps nothing, and the wallet still holds no ETH`);
  // the relay sends an order only when the fee is worth 1.2x the gas; the card prices the fee at 1.5x `units`
  ok(gas * 12n <= units * 15n, `${label}: the gas the relay is quoted (${gas}) is inside what the card's fee pays for, ${(units * 15n) / 12n} (${units} units at 1.5x, over 1.2x)`);
  return { r, used };
}
const both = await relayedSale({ amount: 5000n * 10n ** 18n, gasPrice: 10n ** 9n, label: '5,000 TAC', want: 'Both pools' });
const one = await relayedSale({ amount: 5000n * 10n ** 18n, gasPrice: 5000n * 10n ** 9n, label: '5,000 TAC at 5,000 gwei', want: 'Precision pool' });
if (both && one) ok(both.r.out > one.r.out, `through both pools the box is paid ${fmt(both.r.out)} ETH, through the Precision pool alone ${fmt(one.r.out)}`);
console.log(`\n${n} passed, ${fails} failed.`);
process.exit(fails ? 1 : 0);
