#!/usr/bin/env node
// The BTC and ETH page (dapp/btc/) in a real browser, under its own CSP, and the front page's link into the swap card's lane. The page, the lane (swap/atomic.js),
// the market read (swap/atomic-market.js) and the card are the real files; the wallet module (/trade/btc.js), the pair opener (/fast/pair-wire.js openPair) and the pair
// client behind it are stand-ins of the shape fastbridge-pair.js gives, as in tests/swap-atomic-lane.test.mjs. The board is answered by the test with an ad that is
// really signed, and the public nodes with Chainlink's ETH / BTC answer, so the real check of ads and the real price read run. Nothing reaches Bitcoin or Ethereum.
//   checks: the page (title, the two marks, one line, the lane), the providers (each way's limits, what is available, the fee, the totals), becoming a provider,
//   an estimate before the wallet opens, the swaps after it opens (steps, when to be back, a copy to save), links (?dir=e2b&amt=, ?from=ETH&to=BTC) and the address,
//   stepping while the tab is hidden, the leave guard, a phone width and the dark scheme; the front page's ?from=BTC&to=ETH&from-at=btc opens the lane.
//   One press (btc/add-eth.js, the real module, over stand-ins of the deposit (teth/wrap.js), the relay's quote (teth/read.js) and the Ethereum wallet (trade/wallet.js)):
//   the swap as the button when the private balance is short, one wallet transaction, the swap started once the deposit is mined (named as coming) and its first step
//   done once it lands, one card and one time for all of it, Cancel only before the provider is asked and "locked in" after, a renewed quote that gives less waiting
//   for a yes, a wallet that holds too little, a declined transaction and no wallet at all starting nothing, a deposit kept across a reload that is finished, and a
//   finished swap's next steps (Send BTC with the amount that arrived, to a Taproot address; the Bitcoin order book; the wallet sheet). Send BTC (btc/panel.js and btc/send.js, the real modules,
//   signing with a test key that holds nothing): addresses refused and why, the fee choices, Max, the review, the signed transaction's outputs, coins of a swap under
//   way left out, a refused broadcast, the sent list across a reload. And, with no browser, btc/send.js: address checksums (BIP 173 and 350 vectors, base58check),
//   the coins a send may take, the fee and Max, the transaction signed, and the ETH a swap is short of.
//
//   node tests/btc-page.test.mjs        (SHOTS=<dir> saves screenshots; PLAYWRIGHT=<path to playwright-core>)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { signAd } from '../dapp/fastbridge-board.js';
import { G } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import * as SEND from '../dapp/btc/send.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makePairClient } from '../dapp/fastbridge-pair.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const SATS = '0'.repeat(64), ETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const BOARD = 'https://tacit-fast-board.onrender.com';
const CHAINLINK = '0xac559f25b1619171cbc396a50854a3240b6a4e99';

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// a provider of the pair, both ways: 0.0005 to 1 BTC (0.3 available) at 0.4% + 800 sats, and 0.01 to 30 ETH (2 available) at 0.2% + 0.0003 ETH
const priv = 0x1d2c3b4a5968778695a4b3c2d1e0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8cn;
const pub = (k) => bytesToHex(G.multiply(k).toRawBytes(true));
const ad = () => {
  const at = Math.floor(Date.now() / 1000);
  return signAd({ claimPub: pub(priv), gateway: pub(priv + 1n), name: 'Test provider', btcAsset: SATS, evmAsset: ETH, minAmount: '50000', maxAmount: '100000000', available: '30000000', flatFee: '800', feeBps: 40, csvBlocks: 144, evmWindowSecs: 14400,
    reverse: { minAmount: '1000000', maxAmount: '3000000000', available: '200000000', feeBps: 20, flatFee: '30000', csvBlocks: 96, evmWindowSecs: 14400 }, at, until: at + 300 }, priv);
};
// Chainlink's aggregator: 18 places, BTC per ETH of 1/30.62
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const chainlink = (data) => {
  if (data.startsWith('0x313ce567')) return `0x${word(18)}`;
  const now = Math.floor(Date.now() / 1000), answer = BigInt(Math.round(1e18 / 30.62));
  return `0x${word(5)}${word(answer)}${word(now - 60)}${word(now - 60)}${word(5)}`;
};

const BTC_STUB = `
const W = window.__btc = { unlocked: false, signIns: 0, funds: 0, fundAsk: null, mode: 'eth' };
const T = { wallet: { priv: new Uint8Array(32).fill(7), address: () => 'bc1qtestaddress0000000000000000000000000' } };
const session = { get unlocked() { return W.unlocked; }, get key() { return W.unlocked ? { pubHex: '02' + 'ab'.repeat(32), mode: W.mode, address: W.mode === 'eth' ? '0x' + '12'.repeat(20) : undefined } : null; }, get T() { return T; }, load: async () => T, turn: async (fn) => fn() };
export function makeBitcoin({ onChange }) { W.change = onChange; return { session, signIn: async () => { W.unlocked = true; W.signIns++; onChange?.(); }, fund: (o) => { W.funds++; W.fundAsk = o || null; } }; }`;
// (the address's own sats: a test key that holds nothing signs, the real signer; coins, the swaps' held coins, locks, fee rates and the broadcast are the test's)
const WIRE_STUB = `import { makeBtcWallet } from '/bitcoin-taproot-wallet.js';
const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const B = window.__bit;
const bitcoin = { address: prims.wallet.address(), prims, coins: async () => ({ coins: B.coins, pending: 0 }), held: async () => B.held.slice(), locks: async () => B.locks, holdings: async () => B.holdings,
  feeRates: async () => B.rates, broadcast: async (hex) => { B.posted.push(hex); if (B.refuse) throw new Error('broadcast refused: min relay fee not met'); }, status: async (txid) => { B.status.push(txid); return { confirmations: B.confirmed ? 1 : 0, height: 0 }; } };
export async function openPair(o) { window.__atom.opened.push(o.pubHex); return { pair: window.__atom.pair, address: () => ({ btc: 'bc1qtest' }), run: () => () => {}, keep: { save: () => ({ v: 1, kind: 'tacit-btc-eth-swaps', prefix: 'p', at: 1, items: { 'p:sw1': '{}' } }), load: () => 1 }, bitcoin }; }`;
// stand-ins under btc/add-eth.js: the deposit and its relay (teth/wrap.js), the relay's quote (teth/read.js), the Ethereum wallet (trade/wallet.js)
const WRAP_STUB = `
const A = window.__add;
export async function wrapEth({ priv, wei, tip, to, from, wallet, say }) {
  A.wraps.push({ wei: String(wei), tip: String(tip), to, from, priv: priv().length });
  say('prepare');
  const hash = await wallet.sendTx({ to: '0x000000D218B03db5837943b0b05DeA2965AE956e', data: '0xfc24c435' + '11'.repeat(96), value: wei + tip, from });
  say('sent', hash);
  await wallet.receipt(hash);
  say('proving', hash);
  if (A.hold) await new Promise((r) => { A.release = r; });
  window.__atom.bal.eth += wei / 10000000000n;
  return { hash, built: {} };
}
export async function readHeld() { return { pending: A.pending || [] }; }
export async function finish({ pending }) { A.finished.push(pending.length); for (const p of pending) window.__atom.bal.eth += p.value; return { done: pending.length, err: null, left: [] }; }
export const relayWords = (e) => String(e && e.message || e);`;
const READ_STUB = `export async function wrapQuote(wei) { window.__add.quotes.push(String(wei)); return { tip: 100000000000000n, proveTip: 100000000000000n, to: '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9', floor: 0n }; }`;
const WALLET_STUB = `
const A = window.__add;
export class UserStopped extends Error { constructor() { super('Nothing was sent.'); this.userStopped = true; } }
export function makeWallet() {
  const state = { account: null };
  return { state, restore: async () => false, available: () => (A.noWallet ? [] : [{ info: { name: 'Test wallet', uuid: 'w1' }, provider: {} }]),
    connect: async () => { state.account = A.account; A.connects++; return true; },
    sendTx: async (tx) => { A.asked.push({ to: tx.to, value: String(tx.value), from: tx.from }); if (A.reject) throw new UserStopped(); return '0x' + 'ab'.repeat(32); },
    receipt: async (h) => { if (A.holdReceipt) await new Promise((r) => { A.mine = r; }); return { status: '0x1', transactionHash: h }; } };
}`;
const FAKE = `
(() => {
  const now = () => Math.floor(Date.now() / 1000);
  const calls = { quote: [], start: [], pump: 0, records: 0, recover: 0 };
  const TITLES = { b2e: ['You lock BTC', 'They lock ETH', 'You claim ETH', 'They take BTC'], e2b: ['They lock BTC', 'You lock ETH', 'They claim ETH', 'You take BTC'] };
  const steps = (dir, at, state) => TITLES[dir].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: state === 'done' ? 'done' : i < at ? 'done' : i === at && state === 'working' ? 'active' : 'todo' }));
  window.__add = { wraps: [], quotes: [], asked: [], finished: [], connects: 0, account: '0x' + '12'.repeat(20), reject: false, noWallet: false, hold: false, pending: [] };
  window.__bit = { coins: [{ txid: 'a1'.repeat(32), vout: 0, value: 30000000 }, { txid: 'b2'.repeat(32), vout: 1, value: 19000000 }, { txid: 'd4'.repeat(32), vout: 0, value: 1000000 }, { txid: 'c3'.repeat(32), vout: 2, value: 546 }],
    held: ['d4'.repeat(32) + ':0'], locks: [{ spk: '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' }], holdings: new Map(), rates: { fast: 12, normal: 6, slow: 2 }, posted: [], status: [], confirmed: false, refuse: false };
  const S = window.__atom = { calls, opened: [], bal: { sats: 50000000n, eth: 400000000n },
    recs: [
      { id: 'sw1', dir: 'b2e', state: 'working', title: 'Claiming your ETH', detail: 'Your claim is being settled in the pool.', pay: 1000000n, get: 30400000n, steps: steps('b2e', 2, 'working'), etaSecs: 120, at: now() - 900, refundAt: now() + 86000, backBy: now() + 3 * 3600 },
      { id: 'sw0', dir: 'e2b', state: 'done', title: 'Done', detail: 'The BTC is at your Bitcoin address.', pay: 5000000n, get: 160000n, steps: steps('e2b', 4, 'done'), etaSecs: 0, at: now() - 86400, refundAt: null, backBy: null },
    ] };
  S.pair = {
    providers: async () => [{ id: 'p1', name: 'Test provider', dirs: ['b2e', 'e2b'], b2e: { min: 50000n, max: 100000000n, available: 30000000n }, e2b: { min: 1000000n, max: 3000000000n, available: 200000000n } }],
    reference: async () => ({ ethPerBtc: 30.62, at: now(), source: 'test' }),
    balances: async () => ({ sats: S.bal.sats, eth: S.bal.eth, ethHeld: S.bal.eth, pendingSats: 0n }),
    // (S.cut: quotes give 1% less from then on; S.ttl: how long a quote lasts)
    quote: async ({ dir, amount }) => { calls.quote.push({ dir, amount: String(amount) }); const b2e = dir === 'b2e', get = b2e ? (amount * 304n) / 10n : (amount * 10n) / 304n;
      return { dir, provider: { id: 'p1', name: 'Test provider' }, pay: amount, get: S.cut ? (get * 99n) / 100n : get, rate: 30.4, market: 30.62, vsMarketBps: -72, feeBps: 72, etaSecs: 1500, networkFeeSats: b2e ? 1200 : null, takeFeeSats: b2e ? null : 500, expiresAt: now() + (S.ttl || 300), warnings: [], blocked: null, ref: {} }; },
    // (a start of ETH for BTC lists its swap, as the pair client does; what was coming into the private balance at the start is kept)
    start: async (q, o) => { calls.start.push(q); (calls.coming ||= []).push(o && o.coming != null ? String(o.coming) : null);
      if (q.dir === 'e2b') S.recs = [{ id: 'sw9', dir: 'e2b', state: 'working', title: 'The provider is locking BTC for you', detail: 'Its lock goes out first and waits for one Bitcoin confirmation, about ten minutes. Your ETH is locked only after that.', pay: q.pay, get: q.get, steps: steps('e2b', 0, 'working'), etaSecs: 1710, at: now(), refundAt: null, backBy: null }, ...S.recs];
      return { id: 'sw9' }; },
    pump: async () => { calls.pump++; return S.recs; },
    records: async () => { calls.records++; return S.recs; },
    // (recoverHold: the look for earlier swaps waits for S.release(); recoverFail: that many looks fail first)
    recover: async () => { calls.recover++; if (S.recoverFail > 0) { S.recoverFail--; throw new Error('the explorers did not answer'); } if (S.recoverHold) await new Promise((r) => { S.release = r; }); return 0; },
  };
})();`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('btc/send.js: addresses (BIP 173 and 350 vectors, base58check), mainnet only');
{
  const P = SEND.parseAddress, spk = (a) => { const r = P(a); return r.ok ? `${r.type}:${SEND.scriptHex(r.script)}` : `no:${r.why}`; };
  ok(spk('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4') === 'p2wpkh:0014751e76e8199196d454941c45d1b3a323f1433bd6', 'a P2WPKH address in capitals (BIP 173)');
  ok(spk('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3') === 'p2wsh:00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262', 'a P2WSH address');
  ok(spk('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0') === 'p2tr:512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'a Taproot address (bech32m, BIP 350/86)');
  ok(spk('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2') === 'p2pkh:76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac' && spk('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy') === 'p2sh:a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87', 'P2PKH and P2SH (base58check)');
  ok(spk('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.1').startsWith('p2wpkh:'), 'a bitcoin: link is read for its address');
  const why = (a) => P(a).why || '';
  ok(/checksum/.test(why('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')) && /checksum/.test(why('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3')), 'one wrong character fails the checksum, bech32 and base58');
  ok(/checksum/.test(why('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'.replace('p5d7', 'p5d8'))), 'a Taproot address with a wrong character');
  ok(/checksum/.test(why('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh')) && /checksum/.test(why('bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4')), 'a v0 program in bech32m, and a v1 in bech32, are refused (BIP 350)');
  ok(/checksum/.test(why('bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')), 'mixed case is refused');
  ok(/test-network/.test(why('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')) && /test-network/.test(why('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')) && /test-network/.test(why('2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc')), 'testnet addresses are refused: bech32, P2PKH and P2SH');
  ok(/does not send to that kind/.test(why('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y')) && /does not send to that kind/.test(why('BC1SW50QGDZ25J')), 'a later segwit version (or a v1 program not of 32 bytes) is not sent to');
  ok(/Ethereum/.test(why('0x' + 'ab'.repeat(20))) && /Lightning/.test(why('lnbc1500n1p')) && /Enter a Bitcoin address/.test(why('  ')), 'an Ethereum address, an invoice, nothing: each said');
}

console.log('btc/send.js: the coins a send may take, the fee and Max, in integer sats');
{
  const c = (t, v, value) => ({ txid: t.repeat(32), vout: v, value });
  const coins = [c('b2', 1, 50000), c('a1', 0, 100000), c('c3', 2, 546), c('d4', 0, 70000), c('e5', 0, 600)];
  const held = new Set(['d4'.repeat(32) + ':0']), notes = SEND.holdingOutpoints(Object.assign(new Map([['x', { utxos: [{ utxo: { txid: 'e5'.repeat(32), vout: 0 } }] }]]), { unclassified: new Set() }));
  const sp = SEND.spendable(coins, { held, holdings: notes });
  ok(JSON.stringify(sp.map((x) => x.value)) === '[100000,50000]', `a swap's coin, a coin with a note, and a dust coin are never taken; the rest largest first (${sp.map((x) => x.value)})`);
  ok(SEND.vsizeOf(1, [22, 22]) === 141 && SEND.vsizeOf(2, [22]) === 178 && SEND.vsizeOf(1, [34, 22]) === 153, 'the vsize of one input and two outputs is 141 vB, as measured; a Taproot output 12 more');
  const a = SEND.planSend({ coins: sp, amount: 120000n, rate: 10, scriptLen: 22 });
  ok(a.inputs.length === 2 && a.fee === 2090n && a.change === 27910n && a.send + a.fee + a.change === 150000n && typeof a.fee === 'bigint', `120,000 sats at 10 sat/vB: both coins, 2,090 fee, 27,910 change, all BigInt (${a.fee}, ${a.change})`);
  const nochange = SEND.planSend({ coins: [c('a1', 0, 100000)], amount: 98500n, rate: 10, scriptLen: 22 });
  ok(nochange.change === 0n && nochange.fee === 1500n && nochange.extra === 400n, `change of dust size is not made: it goes to the fee, and is said (${nochange.fee}, extra ${nochange.extra})`);
  const max = SEND.planSend({ coins: [...sp, c('f6', 0, 600)], max: true, rate: 10, scriptLen: 22 });
  ok(max.inputs.length === 2 && max.send === 150000n - 1780n && max.change === 0n, `Max: all the coins worth spending, one output, less the fee (${max.send})`);
  ok(SEND.planSend({ coins: sp, amount: 545n, rate: 2, scriptLen: 22 }).error === 'dust' && SEND.planSend({ coins: sp, amount: 149000n, rate: 10, scriptLen: 22 }).error === 'short', 'an amount under dust, and more than the coins pay with the fee, are refused');
  ok(SEND.planSend({ coins: sp, amount: 1000n, rate: 1.5, scriptLen: 22 }).error === 'rate' && SEND.planSend({ coins: [c('a1', 0, 700)], max: true, rate: 10, scriptLen: 22 }).error === 'short', 'a rate that is not a whole number, and a Max that is all fee, are refused');
}

console.log('btc/send.js: the transaction, signed by the key\'s P2WPKH signer');
{
  const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 });
  const to = SEND.parseAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0');
  const plan = SEND.planSend({ coins: [{ txid: 'a1'.repeat(32), vout: 3, value: 100000 }, { txid: 'b2'.repeat(32), vout: 0, value: 50000 }], amount: 120000n, rate: 7, scriptLen: to.script.length });
  const s = SEND.signSend({ prims, plan, script: to.script });
  const raw = hexToBytes(s.hex);
  ok(SEND.outputScript(s.hex, 0) === SEND.scriptHex(to.script) && SEND.outputScript(s.hex, 1) === bytesToHex(prims.p2wpkhScript(prims.wallet.pub)), 'the recipient first, the change to the key\'s own address');
  ok(s.tx.outputs[0].value + s.tx.outputs[1].value + Number(plan.fee) === 150000 && s.tx.inputs.every((i) => i.sequence === SEND.RBF_SEQ) && s.tx.version === 2, 'what goes in is what comes out plus the fee; every input signals replacement; version 2');
  ok(s.vsize <= plan.vsize && Math.ceil(Number(plan.fee) / s.vsize) >= 7 && s.tx.inputs.every((i) => i.witness.length === 2 && i.witness[1].length === 33), `the signed transaction (${s.vsize} vB) is no heavier than planned (${plan.vsize} vB), so its rate is at least the one chosen`);
  ok(/^[0-9a-f]{64}$/.test(s.txid) && raw[4] === 0 && raw[5] === 1, 'a segwit transaction with its id');
  let thrown = '';
  try { SEND.signSend({ prims, plan: { ...plan, fee: plan.fee + 1n }, script: to.script }); } catch (e) { thrown = e.message; }
  ok(/do not add up/.test(thrown), 'a plan whose amounts do not add up is not signed');
  try { thrown = ''; SEND.signSend({ prims, plan: { ...plan, send: 500n, change: plan.change + plan.send - 500n }, script: to.script }); } catch (e) { thrown = e.message; }
  ok(/dust/.test(thrown), 'an output under dust is not signed');

  console.log('fastbridge-pair.js: the coins a swap under way holds, and the key\'s own swap locks');
  const mem = (rs) => ({ list: async () => rs, get: async () => null, put: async () => {} });
  const pc = makePairClient({ btc: { wallet: { pub: new Uint8Array(33) } }, evm: {}, seed: new Uint8Array(32), discover: async () => [], counterFor: () => null, reverseCallFor: () => null, feed: {},
    stores: { fwd: mem([{ id: 'f1', phase: 'broadcast', feeInputs: [{ txid: 'aa'.repeat(32), vout: 1 }], lock: { txid: s.txid, vout: 0, revealHex: s.hex } }, { id: 'f0', phase: 'done', feeInputs: [{ txid: 'bb'.repeat(32), vout: 0 }] }]),
      index: mem([]), swaps: (id) => mem(id === 'recovered' ? [{ id: 'r1', lockSpk: '0x5120' + 'cd'.repeat(32) }] : []), quotes: () => mem([]) } });
  const heldNow = await pc.heldCoins(), locksNow = (await pc.lockOutputs()).map((l) => l.spk || SEND.outputScript(l.hex, l.vout));
  ok(JSON.stringify(heldNow) === JSON.stringify(['aa'.repeat(32) + ':1']), `a swap under way holds its coins; a finished one does not (${heldNow})`);
  ok(locksNow.length === 2 && locksNow[0] === SEND.scriptHex(to.script) && locksNow[1] === '5120' + 'cd'.repeat(32), 'the lock of a swap of BTC (read from its kept transaction) and the provider\'s lock of a swap of ETH');
}

const b = await chromium.launch();
const text = async (page, sel) => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const SHOT = async (page, name, full = true) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: full }); };

// what the public nodes say of the Ethereum wallet (a test sets it): its balance, the gas price and the deposit's gas, a deposit's receipt
const RPCV = { balance: 10n ** 18n, receipt: { status: '0x1' } };
const hex = (v) => '0x' + BigInt(v).toString(16);
// the network: the board and the public nodes are answered here, everything else off the machine is refused
async function wire(page, { ads, boardDelayMs = 0 }) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request(), url = req.url();
    if (url === `${BOARD}/ads`) { if (boardDelayMs) await sleep(boardDelayMs); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ads }) }).catch(() => {}); }
    if (req.method() === 'POST' && /publicnode|drpc|1rpc|tenderly|mevblocker|blastapi|buidlguidl|thirdweb|stakely|nodereal|flashbots|tacit-node-gw/.test(url)) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* not JSON */ }
      const answer = { eth_getBalance: () => hex(RPCV.balance), eth_gasPrice: () => hex(10n ** 9n), eth_estimateGas: () => hex(120000n), eth_getTransactionReceipt: () => RPCV.receipt, eth_getTransactionByHash: () => ({ hash: '0x' }), eth_blockNumber: () => '0x1500000' };
      const one = (x) => (x.method === 'eth_call' && String(x.params?.[0]?.to || '').toLowerCase() === CHAINLINK ? { jsonrpc: '2.0', id: x.id, result: chainlink(String(x.params[0].data)) }
        : answer[x.method] ? { jsonrpc: '2.0', id: x.id, result: answer[x.method]() } : { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'offline in this test' } });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    }
    return route.abort();
  });
}
async function fresh({ path = '/btc/', ads = [ad()], viewport = { width: 1200, height: 1000 }, scheme = 'light', init = '' } = {}) {
  const page = await b.newPage({ viewport, colorScheme: scheme, acceptDownloads: true });
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); });
  await wire(page, { ads });
  await page.addInitScript(FAKE);
  if (init) await page.addInitScript(init);
  await page.route(/\/trade\/btc\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: BTC_STUB }));
  await page.route(/\/fast\/pair-wire\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: WIRE_STUB }));
  await page.route(/\/teth\/wrap\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: WRAP_STUB }));
  await page.route(/\/teth\/read\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: READ_STUB }));
  await page.route(/\/trade\/wallet\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: WALLET_STUB }));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#a-go') && document.querySelector('#a-go').textContent !== 'Loading…', null, { timeout: 30000 });
  return { page, errs, csp };
}
const listed = (page) => page.waitForFunction(() => document.querySelectorAll('#pv-list li').length > 0 && /1 BTC =/.test(document.querySelector('#live').textContent), null, { timeout: 20000 });
const atom = (page, expr) => page.evaluate((e) => new Function('A', `return (${e})`)(window.__atom), expr);

console.log('the page: the marks, the line, the lane');
{
  const { page, errs, csp } = await fresh();
  ok((await page.title()) === 'tacit btc', `the title is "tacit btc" (${await page.title()})`);
  const marks = await page.$$eval('.hero .mk use', (us) => us.map((u) => u.getAttribute('href')));
  const size = await page.$eval('.hero .mk .tk', (e) => e.getBoundingClientRect().width);
  ok(JSON.stringify(marks) === JSON.stringify(['#tk-btc', '#tk-eth']) && size >= 64, `the hero has the front page's BTC and ETH marks, large (${JSON.stringify(marks)}, ${Math.round(size)} px)`);
  ok(/BTC\s*⇄\s*ETH/.test(await text(page, 'h1')) && /Swap BTC and ETH with a provider\. Private on the Ethereum side\./.test(await text(page, '.hero .sub')), 'one heading and one line');
  ok(await page.isVisible('#atomic #a-go') && /Open your Tacit wallet/.test(await text(page, '#a-go')) && /From.*Bitcoin/.test(await text(page, '#a-pay')) && /To.*Ethereum, private/.test(await text(page, '#a-get')), 'the lane is mounted, BTC to ETH, and asks for the wallet');

  console.log('providers, read with no wallet open');
  await listed(page);
  const live = await text(page, '#live');
  ok(/1 BTC = 30\.62 ETH/.test(live) && /1 provider online/.test(live) && /up to 0\.30 BTC or 2\.0 ETH now/.test(live), `the line under the heading: the market, who is online, what can be swapped now, to two figures (${live})`);
  ok(await page.$$eval('#live > span', (ss) => ss.length === 3 && ss.every((s) => s.getClientRects().length === 1)), 'each part of that line is kept whole');
  const row = await text(page, '#pv-list li');
  ok(/Provider [0-9a-f]{12}\b/.test(row) && /BTC → ETH 0\.0005 to 1 BTC 0\.3 BTC available now fee 0\.4% \+ 800 sats \(2\.0% at the minimum\)/.test(row), `the forward terms: limits, available, the fee and what it is at the minimum (${row})`);
  ok(/ETH → BTC 0\.01 to 30 ETH 2 ETH available now fee 0\.2% \+ 0\.0003 ETH \(3\.2% at the minimum\)/.test(row), 'the reverse terms, in ETH');
  ok(/up to 0\.3 BTC for ETH, and up to 2 ETH for BTC/.test(await text(page, '#cap')), `the totals (${await text(page, '#cap')})`);

  console.log('becoming a provider');
  const be = await text(page, '#be');
  ok(/What you need/i.test(be) && /Your terms/i.test(be) && /openssl rand -hex 32/.test(be) && /fastbridge-lp-shield\.mjs <ETH> --eth --index 0 --send/.test(be) && /config\.btc-eth\.example\.json/.test(be) && /--dry-run/.test(be), 'what is needed, the terms and the exact commands');
  ok((await page.$$('#be .cmd button')).length >= 5 && (await page.getAttribute('#be a[href*="README.md"]', 'href')).includes('pair-mode'), 'each command has a copy button, and the guide is linked at its pair-mode section');

  console.log('an estimate before the wallet opens');
  await page.fill('#a-amt', '0.01');
  await page.waitForFunction(() => /^≈/.test(document.querySelector('#a-out').textContent), null, { timeout: 8000 });
  const est = await text(page, '#a-out'), rc = await text(page, '#a-rcpt');
  ok(/^≈ 0\.30\d+$/.test(est) && (await page.$eval('#a-out', (e) => e.classList.contains('est'))), `the amount out is an estimate, marked as one (${est})`);
  ok(/Market\s*1 BTC = 30\.62 ETH/.test(rc) && /Limits\s*0\.0005 to 1 BTC/.test(rc) && /Available now\s*up to 0\.3 BTC/.test(rc) && /Firm price\s*once your wallet is open/.test(rc), `with the market, the limits and what is available (${rc})`);
  ok((await atom(page, 'A.calls.quote.length')) === 0, 'no provider is asked for a quote before the wallet is open');
  await SHOT(page, 'desktop-light');

  console.log('the wallet opens: the swaps');
  ok(/Open your Tacit wallet above/.test(await text(page, '#mine-say')) && await page.isHidden('#mine-keep'), 'before: the swaps section says how to see them');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && !document.querySelector('#mine-list').hidden, null, { timeout: 30000 });
  ok(await page.isHidden('#a-sent') && (await page.$$('#mine-list > div')).length === 2, 'the swaps are listed in their own section, not under the lane');
  const mine = await text(page, '#mine-list');
  ok(/Claiming your ETH/.test(mine) && /0\.01 BTC → about 0\.304 ETH/.test(mine) && (await page.$$('#mine-list .wait .stp li')).length === 4 && (await page.$$('#mine-list .wait .stp li.done')).length === 2, 'a swap under way: its amounts and its four steps, two done');
  ok(/Keep this page open until it is done\. If you close it, come back by \d{1,2}:\d\d(?: [AP]M)? (today|tomorrow): the ETH has to be claimed by then, or your BTC returns by itself after about a day\./.test(mine), `it says when to be back, and what happens if not (${mine.slice(0, 400)})`);
  ok(/If it stops, your BTC returns in 2\d h/.test(mine) && /Done/.test(await text(page, '#mine-list .ok')), 'its refund time, and a finished swap marked done');
  ok(await page.isVisible('#keep-save') && (await text(page, '#mine-say')) === '', 'a copy of the swaps can be saved');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('#keep-save')]);
  ok(!!dl && /^tacit-btc-eth-swaps-\d{4}-\d\d-\d\d\.json$/.test(dl.suggestedFilename()), `Save a copy downloads the swaps (${dl && dl.suggestedFilename()})`);
  await page.waitForFunction(() => /Balance 0\.5 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await page.fill('#a-amt', '0.02');
  await page.waitForFunction(() => /^Swap BTC → ETH$/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(!/^≈/.test(await text(page, '#a-out')) && (await atom(page, 'A.calls.quote.at(-1).amount')) === '2000000', 'with the wallet open, the amount is the provider\'s quote');
  await SHOT(page, 'desktop-light-open');

  console.log('a hidden tab still steps the swap; leaving asks first');
  const before = await atom(page, 'A.calls.pump');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(6500);
  ok((await atom(page, 'A.calls.pump')) > before, `with the tab hidden the swap under way is stepped (${before} → ${await atom(page, 'A.calls.pump')} passes)`);
  ok(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; }), 'leaving the page while a swap is under way is asked about');

  console.log('both amounts of each swap; the steps on one line each');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
  // a swap of BTC found again from the key: only its Bitcoin lock is seen, so its ETH amount is not known
  await page.evaluate(() => { const A = window.__atom, r = A.recs.find((x) => x.dir === 'b2e'); A.recs.push({ ...r, id: 'sw2', state: 'done', title: 'Done', detail: 'The ETH is in your private balance, and the provider collected the BTC.', pay: 150000n, get: 0n, steps: r.steps.map((s) => ({ ...s, state: 'done' })), refundAt: null, backBy: null }); });
  await page.waitForFunction(() => document.querySelectorAll('#mine-list > div').length === 3, null, { timeout: 12000 });
  const rows = await page.$$eval('#mine-list .what', (ws) => ws.map((w) => w.textContent));
  ok(rows.includes('0.01 BTC → about 0.304 ETH') && rows.includes('0.05 ETH → 0.0016 BTC') && rows.includes('0.0015 BTC → ETH'), `each way names both sides, with the amounts it knows (${rows.join(' | ')})`);
  for (const width of [540, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const lines = await page.$$eval('#mine-list .stp li', (ls) => ls.map((li) => { const r = document.createRange(); r.selectNodeContents(li.lastChild); return [li.textContent, r.getClientRects().length, li.scrollWidth <= li.clientWidth + 1]; }));
    ok(lines.length === 12 && lines.every(([, n, fits]) => n === 1 && fits), `at ${width} px each step is one line and stays in its column (${lines.map(([t, n]) => `${t}:${n}`).join(', ')})`);
    await page.$eval('#mine', (e) => e.scrollIntoView());
    await SHOT(page, `swaps-${width}`, false);
  }
  await page.setViewportSize({ width: 1200, height: 1000 });

  console.log('the address follows the lane');
  await page.click('#a-flip');
  ok(/\?dir=e2b/.test(page.url()) && /From.*Ethereum, private/.test(await text(page, '#a-pay')), `the flip turns the lane and the address (${page.url()})`);
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('a new browser: the swaps of an earlier visit are looked for, listed as found, and the list never says there are none meanwhile');
{
  const { page, errs, csp } = await fresh({ init: 'window.__atom.recs = []; window.__atom.recoverHold = true;' });
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && window.__atom.calls.recover === 1, null, { timeout: 15000 });
  await sleep(400);
  ok(/^Looking for your past swaps on Bitcoin and Ethereum\. This can take a minute or two\.$/.test(await text(page, '#mine-say')) && await page.isHidden('#mine-list'), `while the look runs it says so, not "No swaps yet" (${await text(page, '#mine-say')})`);
  await page.waitForFunction(() => /Balance 0\.5 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  ok(true, 'the balance is read while the look runs');
  // a swap found partway (the look has stored it and still reads what became of it): listed at once, as being checked
  await page.evaluate(() => {
    const A = window.__atom, steps = ['They lock BTC', 'You lock ETH', 'They claim ETH', 'You take BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'todo' }));
    A.recs = [{ id: 'swF', dir: 'e2b', state: 'working', title: 'Checking', detail: 'This swap was found again from your key. What became of it is being read from the chains.', pay: 4500000n, get: 125898n, steps, etaSecs: 0, at: Math.floor(Date.now() / 1000) - 86400, refundAt: null, backBy: null }];
  });
  await page.waitForFunction(() => document.querySelectorAll('#mine-list > div').length === 1, null, { timeout: 8000 });
  ok(/Checking/.test(await text(page, '#mine-list')) && /^Looking for more of your past swaps…$/.test(await text(page, '#mine-say')), `a swap found partway is listed while the look goes on (${await text(page, '#mine-say')})`);
  ok((await atom(page, 'A.calls.pump')) === 0, 'nothing is stepped by the lane while the look steps what it finds');
  // the look ends: the swap as the chains say, and the line goes
  await page.evaluate(() => { const A = window.__atom; A.recs = [{ ...A.recs[0], state: 'done', title: 'Done', detail: 'The BTC is at your Bitcoin address.', steps: A.recs[0].steps.map((s) => ({ ...s, state: 'done' })) }]; A.release(); });
  await page.waitForFunction(() => document.querySelector('#mine-say').textContent === '' && /Done/.test(document.querySelector('#mine-list').textContent), null, { timeout: 8000 });
  ok(/0\.045 ETH → 0\.00125898 BTC/.test(await text(page, '#mine-list .ok')), 'when the look ends the list is painted again: the swap is done, with both amounts');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}
{
  const { page } = await fresh({ init: 'window.__atom.recoverFail = 1;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /could not be looked for just now\. Trying again\./.test(document.querySelector('#mine-say').textContent), null, { timeout: 15000 });
  ok((await page.$$('#mine-list > div')).length === 2 && /^Your other past swaps could not/.test(await text(page, '#mine-say')), 'a look that fails says so, and the swaps this browser keeps are still listed');
  await page.waitForFunction(() => window.__atom.calls.recover === 2 && document.querySelector('#mine-say').textContent === '', null, { timeout: 25000 });
  ok(true, 'the lane\'s refresh looks again, and once that look ends the line goes');
  await page.close();
}

console.log('links');
{
  const { page } = await fresh({ path: '/btc/?dir=e2b&amt=0.05' });
  ok(/From.*Ethereum, private/.test(await text(page, '#a-pay')) && (await page.inputValue('#a-amt')) === '0.05', '/btc/?dir=e2b&amt=0.05 opens ETH to BTC with the amount');
  await listed(page);
  await page.waitForFunction(() => /^≈/.test(document.querySelector('#a-out').textContent), null, { timeout: 8000 });
  ok(/^≈ 0\.0016\d+$/.test(await text(page, '#a-out')) && /Limits\s*0\.01 to 30 ETH/.test(await text(page, '#a-rcpt')), `and estimates it the other way, with that way's limits (${await text(page, '#a-out')})`);
  await page.close();
  const two = await fresh({ path: '/btc/?from=ETH&to=BTC' });
  ok(/From.*Ethereum, private/.test(await text(two.page, '#a-pay')), 'the card\'s own words (?from=ETH&to=BTC) open it the same way');
  await two.page.close();
}

console.log('no provider online');
{
  const { page } = await fresh({ ads: [] });
  await page.waitForFunction(() => /No provider is online/.test(document.querySelector('#cap').textContent), null, { timeout: 20000 });
  ok((await page.$$('#pv-list li')).length === 0 && /no provider online/.test(await text(page, '#live')), 'the list says so, and the line under the heading too');
  await page.close();
}

console.log('a phone width, light and dark');
for (const scheme of ['light', 'dark']) {
  const { page, errs, csp } = await fresh({ viewport: { width: 390, height: 860 }, scheme });
  await listed(page);
  await page.fill('#a-amt', '0.01');
  await page.waitForFunction(() => /^≈/.test(document.querySelector('#a-out').textContent), null, { timeout: 8000 });
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${scheme}: no sideways scroll at 390 px`);
  const mk = await page.$eval('.hero .mk', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
  ok(mk, `${scheme}: the marks fit the width`);
  await SHOT(page, `phone-${scheme}`);
  if (scheme === 'dark') { await page.setViewportSize({ width: 1200, height: 1000 }); await SHOT(page, 'desktop-dark'); }
  ok(errs.length === 0 && csp.length === 0, `${scheme}: no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('One press: a swap of ETH the private balance is short of (the ETH made private first, then swapped)');
{
  const { page, errs, csp } = await fresh({ path: '/btc/?dir=e2b&amt=0.05', init: 'window.__atom.bal.eth = 0n;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap 0\.05 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  ok(!(await page.$eval('#a-go', (e) => e.disabled)), 'with no private ETH the one button swaps the amount, which it first makes private as one note of exactly it');
  const hint = await text(page, '#a-q');
  ok(/^One wallet transaction\. Your ETH is made private first\./.test(hint) && /deposit from your wallet is public\. The swap and your Bitcoin address are not linked to it on chain\./.test(hint), `under the button: what one press does, and what its deposit shows on chain (${hint})`);
  ok((await atom(page, 'A.calls.quote.length')) >= 1, 'the quote is asked for before the press: the button swaps on it');
  const unit = await page.evaluate(async () => { const m = await import('/btc/add-eth.js'); const a = await import('/swap/atomic.js'); return [m.addUnits(5000000n, 0n), m.addUnits(5000000n, 3000000n), m.addUnits(5000000n, 5000000n), m.addUnits(5000000n, null), a.addUnits(5000000n, 1n), m.leastFor(100000000000000n)].map(String); });
  ok(JSON.stringify(unit) === JSON.stringify(['5000000', '2000000', '0', '5000000', '4999999', '200000']), `the shortfall math: the amount with nothing available, else what is short, nothing when covered; the lane's copy agrees; the least deposit a tip allows (${unit})`);
  const spans = await page.evaluate(async () => { const a = await import('/swap/atomic.js'); return [a.etaSpan(1770), a.etaSpan(1410), a.etaSpan(600)]; });
  ok(JSON.stringify(spans) === JSON.stringify(['about 20\u2060–\u206030 minutes', 'about 15\u2060–\u206025 minutes', 'about 10 minutes']), `the time a swap of ETH has left: a range while two Bitcoin blocks are ahead, one figure nearer the end (${spans})`);
  await SHOT(page, 'oneclick-ask');
  // the relay holds the deposit after it is mined: the swap is started on it meanwhile
  await page.evaluate(() => { window.__add.hold = true; });
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length === 1 && document.querySelector('#mine-list [data-rec="sw9"]'), null, { timeout: 15000 });
  const add = await page.evaluate(() => window.__add);
  ok(add.wraps.length === 1 && add.wraps[0].wei === '50000000000000000' && add.asked.length === 1 && add.asked[0].value === '50100000000000000', `one wallet transaction: 0.05 ETH and the relay's tip, from the key the lane opened (${JSON.stringify(add.asked)})`);
  await page.waitForFunction(() => window.__add.release, null, { timeout: 15000 });
  ok((await atom(page, 'A.calls.coming[0]')) === '5000000' && (await page.evaluate(() => window.__atom.bal.eth)) === 0n, `once the deposit is mined the swap starts, while the relay is still settling it: the deposit is named as coming (${await atom(page, 'A.calls.coming[0]')})`);
  const card = await text(page, '#mine-list [data-rec="sw9"]');
  const steps = await page.$$eval('#mine-list [data-rec="sw9"] .stp li', (ls) => ls.map((l) => `${l.textContent}:${l.className}`));
  ok(steps.length === 5 && steps[0] === 'Made private:active' && steps[1] === 'They lock BTC:active', `one view of the whole swap: its ETH being made private, alongside the provider's lock (${steps})`);
  ok(/about 20\u2060–\u206030 minutes/.test(card) && /The provider is locking BTC for you/.test(card), `one time for all of it, as a range (${card.slice(0, 160)})`);
  ok(/Locked in: the provider has been asked, so this swap can no longer be cancelled\./.test(card) && !(await page.$('#mine-list [data-press-cancel]')) && !(await page.$('#a-q [data-press-cancel]')), 'the provider has been asked: no Cancel, and the card says it is locked in');
  ok((await page.inputValue('#a-amt')) === '' && /^Adding ETH to your private balance…$/.test(await text(page, '#a-go')), 'the lane is cleared for the next swap, which waits while the deposit lands');
  await SHOT(page, 'oneclick-started');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.$eval('#mine', (e) => e.scrollIntoView());
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'at 390 px the five steps fit, with no sideways scroll');
  await SHOT(page, 'oneclick-started-390', false);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.evaluate(() => window.__add.release());
  await page.waitForFunction(() => document.querySelector('#mine-list [data-rec="sw9"] .stp li')?.className === 'done', null, { timeout: 15000 });
  ok(!(await page.evaluate(() => localStorage.getItem('tacit-btc-add-eth-v1:02' + 'ab'.repeat(32)))), 'once it lands its step is done, and the kept deposit is let go');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}
{
  // some private ETH already: the shortfall only; a wallet that holds too little, and a deposit declined, start nothing
  const { page } = await fresh({ path: '/btc/?dir=e2b&amt=0.05', init: 'window.__atom.bal.eth = 3000000n;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap 0\.05 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  RPCV.balance = 10n ** 16n;
  await page.click('#a-go');
  await page.waitForFunction(() => document.querySelector('#a-q').classList.contains('err'), null, { timeout: 15000 });
  const said = await text(page, '#a-q');
  ok(/Your wallet 0x1212…1212 holds 0\.01 ETH\. This needs 0\.0201 ETH and about 0\.00012 ETH network fee\. Nothing was sent\./.test(said), `with 0.03 ETH private, the press adds 0.02: a wallet that holds too little says how much it holds, and what this needs (${said})`);
  ok((await page.evaluate(() => window.__add.asked.length)) === 0 && (await atom(page, 'A.calls.start.length')) === 0 && /^Swap 0\.05 ETH → BTC$/.test(await text(page, '#a-go')), 'the wallet was never asked, no swap was started, and the button offers it again');
  RPCV.balance = 10n ** 18n;
  await page.evaluate(() => { window.__add.reject = true; });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Nothing was sent\.$/.test(document.querySelector('#a-q').textContent), null, { timeout: 15000 });
  ok((await page.evaluate(() => window.__add.asked.length)) === 1 && (await atom(page, 'A.calls.start.length')) === 0 && !(await page.evaluate(() => localStorage.getItem('tacit-btc-add-eth-v1:02' + 'ab'.repeat(32)))), 'declined in the wallet: nothing was sent, nothing is kept, and no swap was started');
  await page.close();
}
{
  // Cancel, while it costs the provider nothing: the deposit sent but not mined, so the provider has not been asked
  const { page } = await fresh({ path: '/btc/?dir=e2b&amt=0.05', scheme: 'dark', init: 'window.__atom.bal.eth = 0n; window.__add.holdReceipt = true;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap 0\.05 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await page.click('#a-go');
  await page.waitForFunction(() => window.__add.mine && document.querySelector('#a-q [data-press-cancel]'), null, { timeout: 15000 });
  const press = await text(page, '#mine-list [data-rec="press"]');
  ok(/Adding your ETH privately/.test(press) && /about 20\u2060–\u206030 minutes/.test(press) && (await page.$$('#mine-list [data-rec="press"] .stp li')).length === 5 && !!(await page.$('#mine-list [data-rec="press"] [data-press-cancel]')), `while the deposit waits for a block: one card for the whole swap, its first step under way, with a Cancel (${press.slice(0, 140)})`);
  ok(/The deposit is sent/.test(await text(page, '#a-q')) && /^Adding your ETH privately…$/.test(await text(page, '#a-go')), 'the line says where the deposit is; the button waits');
  await SHOT(page, 'oneclick-cancel-offered-dark');
  await page.click('#a-q [data-press-cancel]');
  ok(/Cancelled: no swap starts\. The deposit is already sent, so its ETH lands in your private balance/.test(await text(page, '#a-q')) && !(await page.$('[data-press-cancel]')), 'cancelled: no swap will start, and the deposit is said to stay in the private balance');
  await page.evaluate(() => window.__add.mine());
  await page.waitForFunction(() => /Your ETH is in your private balance\. No swap was started\./.test(document.querySelector('#a-q').textContent), null, { timeout: 20000 });
  ok((await atom(page, 'A.calls.start.length')) === 0 && !(await page.$('#mine-list [data-rec="press"]')), 'mined and landed: the provider was never asked');
  await page.close();
}
{
  // the quote ran out while the deposit was mined, and the new one gives less: nothing starts until the new price is accepted
  const { page } = await fresh({ path: '/btc/?dir=e2b&amt=0.05', viewport: { width: 390, height: 900 }, scheme: 'dark', init: 'window.__atom.bal.eth = 0n; window.__add.holdReceipt = true; window.__atom.ttl = 100;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap 0\.05 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await page.click('#a-go');
  await page.waitForFunction(() => window.__add.mine, null, { timeout: 15000 });
  await page.evaluate(() => { window.__atom.cut = true; window.__add.mine(); });
  await page.waitForFunction(() => /^Accept the new price$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  const said = await text(page, '#a-q');
  ok((await atom(page, 'A.calls.start.length')) === 0 && /The price moved while your ETH was made private: 0\.00163973 → 0\.00162328 BTC\. Accept the new price to go on/.test(said) && !!(await page.$('#a-q [data-press-cancel]')), `a renewed quote that gives less is not swapped on: old and new are shown, with a way to keep the ETH private instead (${said})`);
  await SHOT(page, 'oneclick-worse-390-dark', false);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length === 1, null, { timeout: 15000 });
  ok((await atom(page, 'String(A.calls.start[0].get)')) === String((5000000n * 10n * 99n) / 304n / 100n), 'accepted: the swap starts on the new quote');
  await page.close();
}
{
  // a finished swap of ETH for BTC: what to do with the BTC, in its card
  const { page, errs, csp } = await fresh({ init: `window.__atom.recs = [{ id: 'swD', dir: 'e2b', state: 'done', title: 'Done', detail: 'The BTC is at your Bitcoin address.', pay: 4000000n, get: 111000n, got: 110500n, steps: ['They lock BTC', 'You lock ETH', 'They claim ETH', 'You take BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'done' })), etaSecs: 0, at: Math.floor(Date.now() / 1000) - 60, refundAt: null, backBy: null },
    { id: 'swL', dir: 'e2b', state: 'working', title: 'Waiting for the provider to claim', detail: 'The provider is claiming the ETH you locked.', pay: 4000000n, get: 111000n, steps: ['They lock BTC', 'You lock ETH', 'They claim ETH', 'You take BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: i < 2 ? 'done' : i === 2 ? 'active' : 'todo' })), etaSecs: 840, at: Math.floor(Date.now() / 1000) - 900, refundAt: Math.floor(Date.now() / 1000) + 3 * 3600, backBy: Math.floor(Date.now() / 1000) + 3 * 3600 }];` });
  await page.click('#a-go');
  await page.waitForFunction(() => document.querySelector('#mine-list [data-rec="swD"] .nx'), null, { timeout: 15000 });
  const done = await text(page, '#mine-list [data-rec="swD"]');
  ok(/0\.04 ETH → 0\.001105 BTC/.test(done) && /Send it to any wallet \(UniSat/.test(done), `done: what arrived, the lock less the take's fee (${done.slice(0, 120)})`);
  ok((await page.getAttribute('#mine-list [data-rec="swD"] [data-next="book"]', 'href')) === '/trade/tac/?lane=btc' && (await page.getAttribute('#mine-list [data-rec="swD"] [data-next="elsewhere"]', 'href')) === '/#wallet', 'next: the Bitcoin order book of TAC, and the wallet sheet for the key to use elsewhere');
  const locked = await text(page, '#mine-list [data-rec="swL"]');
  ok(/Locked in: it goes through, or if the provider has not claimed by \d{1,2}:\d\d(?: [AP]M)? (today|tomorrow), your ETH returns to your private balance\./.test(locked) && !/If it stops/.test(locked), `once the ETH is locked: locked in, and when the ETH comes back if the provider does not claim (${locked.slice(0, 260)})`);
  await page.$eval('#mine', (e) => e.scrollIntoView());
  await SHOT(page, 'done-next', false);
  await page.click('#mine-list [data-rec="swD"] [data-next="send"]');
  await page.waitForFunction(() => !document.querySelector('#yb-form').hidden && document.querySelector('#yb-amt').value, null, { timeout: 15000 });
  ok((await page.inputValue('#yb-amt')) === '0.001105' && /110,500 sats/.test(await text(page, '#yb-amt-say')), `Send BTC opens the send with the amount that arrived (${await page.inputValue('#yb-amt')})`);
  await page.fill('#yb-to', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297');
  await page.$eval('#yb-to', (e) => e.blur());
  await sleep(150);
  ok(!/checksum|kind/.test(await text(page, '#yb-to-say')), `a UniSat Taproot address (bc1p) is taken (${await text(page, '#yb-to-say')})`);
  await page.click('#yb-review');
  await page.waitForFunction(() => !document.querySelector('#yb-rv').hidden, null, { timeout: 15000 });
  ok(/To bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297/.test(await text(page, '#yb-dl')) && /Amount 0\.001105 BTC/.test(await text(page, '#yb-dl')), 'and reviewed for it');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}
{
  const { page } = await fresh({ path: '/btc/?dir=e2b&amt=0.05', init: 'window.__atom.bal.eth = 0n; window.__add.noWallet = true;' });
  await page.evaluate(() => { window.__btc.mode = 'passkey'; });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap 0\.05 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await page.click('#a-go');
  await page.waitForFunction(() => /no Ethereum wallet/.test(document.querySelector('#a-q').textContent), null, { timeout: 15000 });
  ok(/Your Tacit wallet opened with a passkey, and this browser has no Ethereum wallet to add ETH from\. Open this page in your wallet app’s browser, or shield ETH into this same Tacit wallet on the tETH page/.test(await text(page, '#a-q')) && (await page.$$('#a-q a[href="/teth/"]')).length === 1 && (await atom(page, 'A.calls.start.length')) === 0, 'a passkey wallet with no Ethereum wallet here: the way to add ETH, linked, and nothing started');
  await SHOT(page, 'add-eth-passkey');
  await page.close();
}
{
  // a reload while the relay finished the deposit: the kept deposit is found among the key's and finished
  const pub = '02' + 'ab'.repeat(32), hash = '0x' + 'cd'.repeat(32);
  const { page } = await fresh({ path: '/btc/?dir=e2b&amt=0.05', init: `window.__atom.bal.eth = 0n; window.__add.pending = [{ index: 4, value: 5000000n, txHash: '${hash}', depositId: null }]; window.__add.hold = true; localStorage.setItem('tacit-btc-add-eth-v1:${pub}', JSON.stringify({ v: 1, wei: '50000000000000000', from: '0x${'12'.repeat(20)}', at: Date.now(), hash: '${hash}' }));` });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 20000 });
  const add = await page.evaluate(() => window.__add);
  ok(add.finished.length === 1 && add.finished[0] === 1 && add.wraps.length === 0 && add.asked.length === 0, 'opened again, the kept deposit is finished by the relay, and the wallet is not asked again');
  ok(!(await page.evaluate((k) => localStorage.getItem(k), `tacit-btc-add-eth-v1:${pub}`)), 'and is let go once it has landed');
  await page.close();
}

console.log('Send BTC: the Tacit wallet\'s own bitcoin to any address');
{
  const { page, errs, csp } = await fresh();
  ok(/Open your Tacit wallet above to see its Bitcoin address/.test(await text(page, '#mybtc')) && await page.isHidden('#yb-box'), 'before the wallet opens the panel says how to see it');
  await page.click('#a-go');
  await page.waitForFunction(() => !document.querySelector('#yb-box').hidden && /0\.5 BTC/.test(document.querySelector('#yb-bal').textContent), null, { timeout: 15000 });
  const own = await text(page, '#yb-addr');
  ok(/^bc1q[0-9a-z]{38}$/.test(own), `its own address and balance (${own})`);
  await sleep(200);
  ok(await page.evaluate(() => { document.querySelector('#yb-send').click(); return document.querySelectorAll('#yb-tiers input:not([disabled])').length === 3; }), 'the fee estimates were read when the address showed: the form opens with them');
  await page.waitForFunction(() => document.querySelectorAll('#yb-tiers input:not([disabled])').length === 3 && document.querySelector('#yb-held').textContent, null, { timeout: 15000 });
  const tiers = await text(page, '#yb-tiers');
  ok(/Fast next block 12 sat\/vB/.test(tiers) && /Normal about 30 min 6 sat\/vB/.test(tiers) && /Slow about an hour 2 sat\/vB/.test(tiers) && (await page.$eval('input[name=yb-tier]:checked', (e) => e.value)) === 'normal', `three fee choices from the explorers' estimates, Normal chosen (${tiers})`);
  ok(/0\.01 BTC of it is in a swap under way, and is not sent from here\./.test(await text(page, '#yb-held')), 'the coin of a swap under way is said, and left out');
  const tryTo = async (a) => { await page.fill('#yb-to', a); await page.$eval('#yb-to', (e) => e.blur()); await sleep(150); return text(page, '#yb-to-say'); };
  ok(/test-network/.test(await tryTo('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')), 'a testnet address is refused');
  ok(/checksum/.test(await tryTo('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')), 'a mistyped address is refused');
  ok(/one of your own swap locks/.test(await tryTo('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0')), 'the address of one of the key\'s own swap locks is refused');
  ok(/this wallet’s own address/.test(await tryTo(own)), 'its own address is said, not refused');
  await tryTo('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  await page.click('#yb-max');
  ok((await page.inputValue('#yb-amt')) === '0.48998932' && /48,998,932 sats: all you can send, after the fee/.test(await text(page, '#yb-amt-say')), `Max: the two coins it may take, less the fee at 6 sat/vB (${await page.inputValue('#yb-amt')})`);
  await page.click('label.yb-t:has(input[value=fast])');
  ok((await page.inputValue('#yb-amt')) === '0.48997864', `Max follows a dearer fee (${await page.inputValue('#yb-amt')})`);
  await page.click('label.yb-t:has(input[value=normal])');
  await page.fill('#yb-amt', '0.1');
  ok(/10,000,000 sats/.test(await text(page, '#yb-amt-say')) && /6 sat\/vB · 846 sats/.test(await text(page, '#yb-tiers')), 'an amount is said in sats, and each fee choice in sats for it');
  await SHOT(page, 'send-form');
  await page.click('#yb-review');
  await page.waitForFunction(() => !document.querySelector('#yb-rv').hidden, null, { timeout: 15000 });
  const rv = await text(page, '#yb-dl');
  ok(/To bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4/.test(rv) && /Amount 0\.1 BTC \(10,000,000 sats\)/.test(rv) && /Network fee 846 sats \(6 sat\/vB, 141 vB\)/.test(rv) && /Leaves your balance 10,000,846 sats/.test(rv) && /Change back to you 19,999,154 sats/.test(rv) && /Coins spent 1/.test(rv) && /replace-by-fee/.test(rv), `the review: exactly what is signed (${rv})`);
  await SHOT(page, 'send-review');
  await page.click('#yb-sign');
  await page.waitForFunction(() => document.querySelectorAll('#yb-sent li').length === 1, null, { timeout: 15000 });
  const posted = await page.evaluate(() => window.__bit.posted);
  ok(posted.length === 1 && SEND.outputScript(posted[0], 0) === '0014751e76e8199196d454941c45d1b3a323f1433bd6' && SEND.outputScript(posted[0], 2) === null, 'one transaction broadcast: the recipient first, then change');
  // the key's session stirs (it closes and opens again with the same key) and the lane opens its pair client again: the panel keeps what it showed meanwhile
  const kept = await page.evaluate(() => { const W = window.__btc; W.unlocked = false; W.change(); W.unlocked = true; W.change(); return [document.querySelector('#yb-box').hidden, document.querySelector('#yb-sent').children.length, document.querySelector('#yb-bal').textContent]; });
  ok(kept[0] === false && kept[1] === 1 && /^0\.5 BTC/.test(kept[2]), `while the pair client opens again for the same key, the address, the balance and the send stay shown (${kept})`);
  ok(posted[0].includes('a1'.repeat(32)) && !posted[0].includes('d4'.repeat(32)) && posted[0].includes('fdffffff'), 'it spends the largest coin, never the swap\'s, and signals replacement');
  ok(/Waiting for a confirmation/.test(await text(page, '#yb-sent')) && (await page.$$('#yb-sent a[href^="https://mempool.space/tx/"]')).length === 1 && await page.isHidden('#yb-rv') && await page.isHidden('#yb-form'), 'the send is listed with its explorer link, waiting for a confirmation; the form closes');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.click('#yb-send');
  await page.waitForFunction(() => document.querySelectorAll('#yb-tiers input:not([disabled])').length === 3, null, { timeout: 15000 });
  await page.fill('#yb-to', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'); await page.fill('#yb-amt', '0.02');
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'at 390 px the form fits, with no sideways scroll');
  await page.$eval('#mybtc', (e) => e.scrollIntoView());
  await SHOT(page, 'send-form-390', false);
  await page.click('#yb-review');
  await page.waitForFunction(() => !document.querySelector('#yb-rv').hidden, null, { timeout: 15000 });
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'and the review too');
  await page.$eval('#mybtc', (e) => e.scrollIntoView());
  await SHOT(page, 'send-review-390', false);
  await page.evaluate(() => { window.__bit.refuse = true; });
  await page.click('#yb-sign');
  await page.waitForFunction(() => document.querySelector('#yb-rv-say').classList.contains('err'), null, { timeout: 60000 });
  ok(/The explorers refused it: min relay fee not met\. Nothing was sent\./.test(await text(page, '#yb-rv-say')) && (await page.$$('#yb-sent li')).length === 1, 'a broadcast the explorers refuse is said, and nothing is listed');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  // opened again: the send is still listed, and its status read
  await page.evaluate(() => { window.__bit.confirmed = true; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#a-go') && /Open your Tacit wallet/.test(document.querySelector('#a-go').textContent), null, { timeout: 30000 });
  await page.evaluate(() => { window.__bit.confirmed = true; });
  await page.click('#a-go');
  await page.waitForFunction(() => /Confirmed/.test(document.querySelector('#yb-sent').textContent), null, { timeout: 15000 });
  ok(true, 'after a reload the send is listed again, and reads as confirmed once Bitcoin has it in a block');
  await page.close();
}

// The front page reads the boards a moment after it draws: a link that names the pair waits for them and opens the lane, rather than being read as another pair
console.log('the front page: a link for BTC and ETH opens the lane');
for (const [path, dir] of [['/?from=BTC&to=ETH&from-at=btc', 'b2e'], ['/?from=ETH&to=BTC&to-at=btc&amt=0.05', 'e2b']]) {
  const page = await b.newPage({ viewport: { width: 1200, height: 1000 } });
  await wire(page, { ads: [ad()], boardDelayMs: 2500 });
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  const early = await page.waitForFunction(() => document.querySelector('#hx-swap.swc'), null, { timeout: 60000 }).then(() => page.url());
  ok(/from=(BTC|ETH)/.test(early) && !/tETH|TAC/.test(early), `${dir}: while the boards are read the address keeps the link (${early.replace(BASE, '')})`);
  const opened = await page.waitForFunction(() => document.querySelector('#atomic:not([hidden]) #a-go'), null, { timeout: 60000 }).then(() => true, () => false);
  ok(opened && (await page.isVisible('#atomic')), `${path}: the lane opens once the boards answer`);
  ok(dir === 'b2e' ? /From.*Bitcoin/.test(await text(page, '#a-pay')) : /From.*Ethereum, private/.test(await text(page, '#a-pay')) && (await page.inputValue('#a-amt')) === '0.05', `${dir}: the way round${dir === 'e2b' ? ' and the amount' : ''} the link names`);
  ok(dir === 'b2e' ? /from=BTC/.test(page.url()) && /to=ETH/.test(page.url()) : /from=ETH/.test(page.url()) && /to=BTC/.test(page.url()), `${dir}: the address is the lane's (${page.url().replace(BASE, '')})`);
  await page.close();
}

await b.close();
server.close();
console.log(`\n${n} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
