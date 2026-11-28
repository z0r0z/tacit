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
//   finished swap's next steps (Send BTC with the amount that arrived, to a Taproot address; the Bitcoin order book; the wallet sheet). One press of BTC (from a
//   Bitcoin wallet in the browser): one payment, the lock made from it before its block, a declined payment starting nothing, "Receive as" with the relay's fee
//   said first and addresses checked (EIP-55), the ETH withdrawn once claimed, and a finished swap's "Send to an Ethereum address". Send BTC (btc/panel.js and btc/send.js, the real modules,
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
import * as XN from '../dapp/trade/ext-notes.js';
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
const session = { get unlocked() { return W.unlocked; }, get key() { return W.unlocked ? { pubHex: '02' + 'ab'.repeat(32), mode: W.mode, address: W.mode === 'eth' ? '0x' + '12'.repeat(20) : undefined } : null; }, get T() { return T; }, get address() { return W.unlocked ? 'bc1qtestaddress0000000000000000000000000' : null; }, load: async () => T, turn: async (fn) => fn() };
// (a Bitcoin wallet in the browser when W.canSend: its payment to the key's address is recorded, or declined with W.declineSend)
export function makeBitcoin({ onChange }) { W.change = onChange; return { session, lock: () => { W.unlocked = false; W.locks = (W.locks || 0) + 1; onChange?.(); }, signIn: async () => { W.unlocked = true; W.signIns++; onChange?.(); }, fund: (o) => { W.funds++; W.fundAsk = o || null; },
  // (as trade/btc.js sendIn: a wallet whose coins may carry TAC, or that could not be checked, is never asked; W.asked counts the wallet's prompts)
  canSendIn: () => !!W.canSend, sendIn: async (sats) => {
    if (W.carriers) throw Object.assign(new Error('Your Bitcoin wallet holds TAC on some of its coins.'), { carriers: 1 });
    if (W.scanFail) throw Object.assign(new Error('The coins of your Bitcoin wallet could not be checked for TAC just now, so nothing was sent. Try again in a moment.'), { scanFailed: true });
    (W.sent ||= []).push(sats); if (W.declineSend) throw new Error('User rejected the request.'); return { txid: 'f0'.repeat(32), wallet: 'UniSat' }; } }; }`;
// the pool module (trade/poolux.js): what the page asks of it, the relay's fee of a withdrawal and the withdrawal itself
const UX_STUB = `
const U = window.__ux = { unwraps: [], notes: [], fee: 30000n, fail: false };
const ux = { useWallet() {}, fetchEvents: async () => [], warmWrapLogs: async () => {},
  quoteOpFee: async () => U.fee, quoteUnwrapFee: (v, t, o) => ({ fee: o.minFee, net: BigInt(v) - o.minFee, value: BigInt(v) }),
  // (the pool module names an asset with its 0x, as the real one does: a lookup by the bare id found no note on the canary of 11-25)
  balance: async () => ({ byAsset: { '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34': { notes: U.notes } } }),
  sendUnwrap: async ({ note, recipient, amount }) => { U.unwraps.push({ value: String(note.value), amount: String(amount), recipient }); return { status: 'settled', txHash: '0x' + 'ed'.repeat(32), fee: U.fee, net: BigInt(amount) - U.fee }; },
  unwrap: async ({ note, recipient }) => { U.unwraps.push({ value: String(note.value), recipient }); if (U.fail) throw new Error('the relay is paused'); return { status: 'settled', txHash: '0x' + 'ef'.repeat(32), fee: U.fee, net: BigInt(note.value) - U.fee }; } };
export async function getUx() { return ux; }
export async function forgetUx() {}`;
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
  return { state, restore: async () => { if (A.restored) { state.account = A.account; return true; } return false; }, available: () => (A.noWallet ? [] : [{ info: { name: 'Test wallet', uuid: 'w1' }, provider: {} }]),
    connect: async () => { state.account = A.account; A.connects++; return true; },
    sendTx: async (tx) => { A.asked.push({ to: tx.to, value: String(tx.value), from: tx.from }); if (A.reject) throw new UserStopped(); return '0x' + 'ab'.repeat(32); },
    receipt: async (h) => { if (A.holdReceipt) await new Promise((r) => { A.mine = r; }); return { status: '0x1', transactionHash: h }; } };
}`;
const FAKE = `
(() => {
  const now = () => Math.floor(Date.now() / 1000);
  const calls = { quote: [], start: [], pump: 0, records: 0, recover: 0 };
  const TITLES = { b2e: ['You send BTC', 'They send ETH', 'You get ETH', 'They get BTC'], e2b: ['They send BTC', 'You send ETH', 'They confirm', 'You get BTC'] };
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
    arriving: async (txid) => (S.arrive === false ? [] : [{ txid, vout: 0, value: Number(window.__btc.sent?.at(-1) || 0) }]),
    start: async (q, o) => { calls.start.push(q); (calls.coming ||= []).push(o && o.coming != null ? String(o.coming) : null); (calls.coins ||= []).push(o && o.coins ? o.coins : null);
      if (q.dir === 'b2e' && o && o.coins) { S.recs = [{ id: 'swB', dir: 'b2e', state: 'working', title: 'Waiting for Bitcoin', detail: 'Your lock waits for a Bitcoin block, about ten minutes, some sooner, some later.', pay: q.pay, get: q.get, steps: steps('b2e', 0, 'working'), etaSecs: 1080, at: now(), refundAt: now() + 86000, backBy: null }, ...S.recs]; return { id: 'swB' }; }
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

console.log('trade/ext-notes.js: a Bitcoin wallet outside Tacit is read for coins that may carry a note before it is asked to send');
{
  const hx = (s) => Buffer.from(s).toString('hex');
  const env = '20' + 'aa'.repeat(32) + 'ac' + '00' + '63' + '05' + hx('TACIT') + '01' + '01' + '03' + 'b1b2b3' + '68';
  const inscription = '20' + 'aa'.repeat(32) + 'ac' + '00' + '63' + '03' + hx('ord') + '01' + '01' + '68';
  ok(XN.isEnvelopeScript(Buffer.from(env, 'hex')) && !XN.isEnvelopeScript(Buffer.from(inscription, 'hex')), 'a Tacit envelope is told from another script (an inscription)');
  const txs = { ['a1'.repeat(32)]: { vin: [{ witness: ['11'.repeat(64), env, 'c0' + 'bb'.repeat(32)] }] }, ['b2'.repeat(32)]: { vin: [{ witness: ['11'.repeat(71), '02' + 'cc'.repeat(32)] }] }, ['c3'.repeat(32)]: { vin: [{ witness: ['11'.repeat(71), '02' + 'cc'.repeat(32)] }, { witness: ['11'.repeat(64), env, 'c0' + 'dd'.repeat(32)] }] } };
  const res = (b) => ({ ok: true, json: async () => b });
  const fake = (utxos, { failTx = null, failAll = false } = {}) => async (url) => {
    if (failAll) throw new Error('offline');
    const m = /\/address\/[^/]+\/utxo$/.test(url) ? 'utxo' : (/\/tx\/([0-9a-f]{64})$/.exec(url) || [])[1];
    if (m === 'utxo') return res(utxos);
    if (m === failTx) return { ok: false, status: 503, json: async () => null };
    return res(txs[m]);
  };
  const addr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const withNote = await XN.notesAt(addr, { fetchImpl: fake([{ txid: 'a1'.repeat(32), vout: 0, value: 546 }, { txid: 'b2'.repeat(32), vout: 1, value: 90000 }, { txid: 'c3'.repeat(32), vout: 2, value: 1000 }]), bases: ['https://x'] });
  ok(JSON.stringify(withNote.carriers.map((c) => c.txid.slice(0, 2))) === '["a1","c3"]' && withNote.coins === 3, `coins of transactions that carry a Tacit envelope (in any input) are named; a plain payment's are not (${JSON.stringify(withNote.carriers)})`);
  const clean = await XN.notesAt(addr, { fetchImpl: fake([{ txid: 'b2'.repeat(32), vout: 1, value: 90000 }]), bases: ['https://x'] });
  ok(clean.carriers.length === 0, 'an address of plain coins only: nothing in the way');
  let thrown = null;
  try { await XN.notesAt(addr, { fetchImpl: fake([{ txid: 'a1'.repeat(32), vout: 0, value: 546 }, { txid: 'b2'.repeat(32), vout: 1, value: 90000 }], { failTx: 'b2'.repeat(32) }), bases: ['https://x'] }); } catch (e) { thrown = e; }
  ok(thrown && thrown.scanFailed, 'one coin that cannot be read fails the whole check: nothing is sent');
  thrown = null;
  try { await XN.notesAt(addr, { fetchImpl: fake([], { failAll: true }), bases: ['https://x', 'https://y'] }); } catch (e) { thrown = e; }
  ok(thrown && thrown.scanFailed, 'no explorer answers: the check fails, closed');
  thrown = null;
  try { await XN.notesAt('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', { fetchImpl: fake([]) }); } catch (e) { thrown = e; }
  ok(thrown && thrown.scanFailed, 'a test-network address is not read as one to send from');
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
// (the sections under the tile are closed disclosures until opened: reading one's text opens it, as a visitor would to read it. The disclosure checks use `raw`.)
const text = async (page, sel) => { await page.evaluate((q) => { const d = document.querySelector(q)?.closest('details'); if (d && !d.open) { d.open = true; return new Promise((r) => setTimeout(r, 340)); } }, sel).catch(() => {});
  let t = '';
  for (let i = 0; i < 12 && !t; i++) { t = (await page.innerText(sel).catch(() => '')) || ''; if (!t) { if (!(await page.$eval(sel, (e) => e.closest('details[open]') && e.textContent.trim()).catch(() => ''))) break; await sleep(80); } }
  return t.replace(/\s+/g, ' ').trim(); };
const raw = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const SHOT = async (page, name, full = true) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: full }); };

// what the public nodes say of the Ethereum wallet (a test sets it): its balance, the gas price and the deposit's gas, a deposit's receipt
const RPCV = { balance: 10n ** 18n, receipt: { status: '0x1' } };
const hex = (v) => '0x' + BigInt(v).toString(16);
// the house provider's /info, with what its upkeep adds (fastbridge-lp/lib/automation.mjs): null answers 404, as a provider without it does
const HOUSE = 'https://tacit-fastbridge-pair-lp.onrender.com';
let houseInfo = { v: 1, stats: { since: 1795608000, swaps: 4, swapsForward: 3, swapsReverse: 1, refunds: 0, volumeSwaps: 4, volumeForward: 3, volumeReverse: 1, volumeSince: 1795608000, volumeSats: '1500000', volumeEth: '6500000', medianSecs: 1320, reinvestedEth: '1234567', netEth: '1234567', capacity: { eth: '320000000', sats: '1500000', valueEth: '365000000' } }, target: { eth: '1000000000', btcAsEth: '1000000000', reached: false }, skewBps: 0, buyback: { on: false, startedAt: null, routedEth: '0', tacBought: '0', sends: 0 } };
const BAD = [], FLAKY = { on: false, asked: [] };
// the network: the board and the public nodes are answered here, everything else off the machine is refused
async function wire(page, { ads, boardDelayMs = 0 }) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request(), url = req.url();
    if (url === `${HOUSE}/info`) return houseInfo ? route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(houseInfo) }) : route.fulfill({ status: 404, body: '{}' });
    if (url === `${BOARD}/ads`) { if (ads === null) return route.abort('connectionrefused').catch(() => {}); if (boardDelayMs) await sleep(boardDelayMs); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ads }) }).catch(() => {}); }
    // nodes that answer a browser with a 429 that carries no CORS headers (a CORS block, a console line for each request): the page must never ask them. FLAKY: publicnode refuses like that when a test sets it
    if (/mevblocker|buidlguidl/.test(url) || (FLAKY.on && /publicnode/.test(url))) { (/publicnode/.test(url) ? FLAKY.asked : BAD).push(url); return route.abort('failed'); }
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
  await page.route(/\/trade\/poolux\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: UX_STUB }));
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
  ok(/Bridge/.test(await text(page, '#sec-head h1')) && /BTC\s*⇄\s*ETH/.test(await text(page, '#sec-head [aria-current="page"]')) && /Swap Bitcoin for ETH or back/.test(await text(page, '#sec-head .sh-n')) && !(await page.$eval('.hero h1', (e) => e.offsetParent !== null)), 'the Bridge head names this page; the page keeps one heading, not two');
  ok(await page.isVisible('#atomic #a-go') && /Sign in to swap/.test(await text(page, '#a-go')) && /From.*Bitcoin/.test(await text(page, '#a-pay')) && /To.*Ethereum, private/.test(await text(page, '#a-get')), 'the lane is mounted, BTC to ETH, and asks for the wallet');

  console.log('providers, read with no wallet open');
  await listed(page);
  const live = await text(page, '#live');
  ok(/1 BTC = 30\.62 ETH/.test(live) && /1 provider online/.test(live) && /up to 0\.30 BTC now/.test(live), `the line under the heading: the market, who is online, what can be swapped now, to two figures (${live})`);
  ok(await page.$$eval('#live > span', (ss) => ss.length === 3 && ss.every((s) => s.getClientRects().length === 1)), 'each part of that line is kept whole');
  const row = await text(page, '#pv-list li');
  ok(/Provider [0-9a-f]{12}\b/.test(row) && /BTC → ETH 0\.0005 to 1 BTC 0\.3 BTC available now fee 0\.4% \+ 800 sats \(2\.0% at the minimum\)/.test(row), `the forward terms: limits, available, the fee and what it is at the minimum (${row})`);
  ok(/ETH → BTC not offered/.test(row), 'ETH to BTC is not shown for a provider the site does not name (a board ad from any key), though its ad has the terms');
  ok(/up to 0\.3 BTC for ETH, and no ETH for BTC/.test(await text(page, '#cap')), `the totals (${await text(page, '#cap')})`);

  await page.waitForFunction(() => !document.querySelector('#pv-fund').hidden, null, { timeout: 10000 });
  const fundLine = await text(page, '#pv-fund');
  ok(/back into its capacity until it holds 10 ETH and as much in BTC\. Past that, they go to TAC buybacks\./.test(fundLine) && /3\.6 of 20 ETH/.test(fundLine) && /0\.01234567 ETH of fees reinvested since Nov 2\d/.test(fundLine) && !/TAC bought/.test(fundLine), `the house provider's fees: the rule, capacity against its target, what was reinvested; no buyback figure before buybacks start (${fundLine})`);
  ok(/Tacit’s provider has finished 4 swaps \(3 BTC to ETH, 1 ETH to BTC\) since Nov 2\d\./.test(fundLine) && !/refunded/.test(fundLine), `the track record: swaps finished by direction, without a refund counter (${fundLine.slice(0, 140)})`);
  await page.waitForFunction(() => !document.querySelector('#rec').hidden, null, { timeout: 10000 });
  const recTxt = await text(page, '#rec');
  ok(/4\s*swaps finished\s*3\s*BTC → ETH\s*1\s*ETH → BTC\s*0\.015\s*BTC traversed\s*0\.065\s*ETH traversed\s*~22\s*min, typical swap/.test(recTxt) && !/refunded/.test(recTxt), `the track record at the top: swaps, both assets traversed, and no refund counter (${recTxt})`);
  ok(await page.$eval('#rec', (e) => getComputedStyle(e).display === 'grid' && getComputedStyle(e).gridTemplateColumns.split(' ').length === 3), 'the track record uses a balanced three-column grid');
  const tint = await page.evaluate(() => [...document.querySelectorAll('#rec .rt')].map((e) => getComputedStyle(e).borderTopColor));
  ok(tint[1] === 'rgb(247, 147, 26)' && tint[2] === 'rgb(98, 126, 234)', `BTC → ETH is orange and ETH → BTC is blue (${tint.join(' | ')})`);
  const barW = await page.$eval('#pv-fund .bar i', (e) => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width);
  ok(Math.abs(barW - 0.1825) < 0.01, `the bar is at 18% of the target (${barW.toFixed(3)})`);

  console.log('becoming a provider');
  const be0 = await text(page, '#be');
  ok(/Three steps/i.test(be0) && be0.indexOf('node fastbridge-lp/setup.mjs') > 0 && be0.indexOf('node fastbridge-lp/setup.mjs') < be0.indexOf('git clone') && /Send ETH to the pool account it prints/.test(be0) && /It checks the nodes, the explorers, the price and a test quote/.test(be0), 'three steps, the one command first');
  ok(/What you earn, what you risk/i.test(be0) && /up to about 16 hours/.test(be0) && /bounded by the most you allow per swap/.test(be0) && /Tacit never holds your funds/.test(be0) && /Nothing here is a promise of income/.test(be0) && !/guarantee|passive income|APY/i.test(be0), 'what you earn and what you risk, plainly, with no promise');
  ok(await page.$eval('#be details.by', (d) => !d.open), 'the details start folded under the steps');
  await page.evaluate(() => { document.querySelector('#be details.by').open = true; }); await sleep(400);
  const be = await text(page, '#be');
  ok(/What you need/i.test(be) && /Your terms/i.test(be) && /More providers add room to each swap/.test(be) && /openssl rand -hex 32/.test(be) && /fastbridge-lp-shield\.mjs <ETH> --eth --index 0 --send/.test(be) && /config\.btc-eth\.example\.json/.test(be) && /--dry-run/.test(be) && /tacit-lp setup/.test(be) && /tacit-lp run/.test(be) && /setup\.mjs status/.test(be), 'what is needed, the terms, the Docker pair, the health check and the exact commands by hand');
  ok((await page.$$('#be .cmd button')).length >= 7 && (await page.getAttribute('#be a[href*="README.md#a-provider"]', 'href')).includes('pair-mode') && (await page.getAttribute('#be a[href*="quick-start"]', 'href')).includes('quick-start-a-bitcoin-for-eth-provider'), 'each command has a copy button, and the guide is linked at its pair-mode and quick-start sections');

  console.log('an estimate before the wallet opens');
  await page.fill('#a-amt', '0.01');
  await page.waitForFunction(() => /^≈/.test(document.querySelector('#a-out').textContent), null, { timeout: 8000 });
  const est = await text(page, '#a-out'), rc = await text(page, '#a-rcpt');
  ok(/^≈ 0\.30\d+$/.test(est) && (await page.$eval('#a-out', (e) => e.classList.contains('est'))), `the amount out is an estimate, marked as one (${est})`);
  ok(/Market\s*1 BTC = 30\.62 ETH/.test(rc) && /Limits\s*0\.0005\u2060–\u20600\.3 BTC/.test(rc) && /Price\s*after you sign in/.test(rc), `with the market, the limits and what is available (${rc})`);
  ok((await atom(page, 'A.calls.quote.length')) === 0, 'no provider is asked for a quote before the wallet is open');
  await SHOT(page, 'desktop-light');

  console.log('the wallet opens: the swaps');
  ok(/Sign in above/.test(await text(page, '#mine-say')) && await page.isHidden('#mine-keep'), `before: the swaps section says how to see them (${await text(page, '#mine-say')}, ${await page.isHidden('#mine-keep')})`);
  ok(/^Sign in$/.test(await text(page, '#wallet')) && await page.isVisible('#wallet') && !(await page.$eval('#wallet-dot', (e) => e.classList.contains('on'))), 'the header has a Sign in chip while no wallet is open');
  await page.click('#wallet');
  await page.waitForFunction(() => window.__btc.unlocked && /tacit1/.test(document.querySelector('#wallet').textContent), null, { timeout: 15000 });
  ok((await atom(page, '0') , await page.$eval('#wallet-dot', (e) => e.classList.contains('on'))) && (await page.evaluate(() => window.__btc.signIns)) === 1, 'the chip opens the same sign-in, and then shows the wallet with its dot on');
  await page.waitForFunction(() => !/Sign in to swap/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(!/Sign in to swap/.test(await text(page, '#a-go')), 'the card reflects the same signed-in state');
  await page.click('#wallet');
  ok(/^tacit1\w{10}…\w{6}$/.test(await text(page, '#wallet-label')) && /^tacit1/.test(await text(page, '#acct-tacit')) && /^bc1q/.test(await text(page, '#acct-id')) && /lands here/.test(await text(page, '#acct-pop')) && (await page.$$('#acct-pop [data-copy]')).length === 2, 'the chip names the key by its tacit1 address; the menu lists it and the Bitcoin address, each with Copy');
  await SHOT(page, 'chip-open', false);
  await page.click('#acct-pop [data-acct=out]');
  await page.waitForFunction(() => /^Sign in$/.test(document.querySelector('#wallet').textContent) && /Sign in to swap/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(true, 'Sign out from the chip locks it: the chip and the card both ask to sign in again');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && !document.querySelector('#mine-list').hidden, null, { timeout: 30000 });
  ok(await page.isHidden('#a-sent') && (await page.$$('#mine-list > div')).length === 2, 'the swaps are listed in their own section, not under the lane');
  const mine = await text(page, '#mine-list');
  ok(/Claiming your ETH/.test(mine) && /0\.01 BTC → about 0\.304 ETH/.test(mine) && (await page.$$('#mine-list .wait .stp li')).length === 4 && (await page.$$('#mine-list .wait .stp li.done')).length === 2, 'a swap under way: its amounts and its four steps, two done');
  ok(/Keep this page open\. If you close it, come back by \d{1,2}:\d\d(?: [AP]M)? (today|tomorrow) to receive your ETH; otherwise your BTC returns after about a day\./.test(mine), `it says when to be back, and what happens if not (${mine.slice(0, 400)})`);
  ok(/If it stops, your BTC returns in 2\d h/.test(mine) && /Done/.test(await text(page, '#mine-list .ok')), 'its refund time, and a finished swap marked done');
  ok(await page.isVisible('#keep-save') && (await text(page, '#mine-say')) === '', 'a copy of the swaps can be saved');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('#keep-save')]);
  ok(!!dl && /^tacit-btc-eth-swaps-\d{4}-\d\d-\d\d\.json$/.test(dl.suggestedFilename()), `Back up downloads the swaps (${dl && dl.suggestedFilename()})`);
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
    const A = window.__atom, steps = ['They send BTC', 'You send ETH', 'They confirm', 'You get BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'todo' }));
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
  await sleep(3000);
  // (the test's provider is a board ad from a key the site does not name, so ETH to BTC is not offered by it: fastbridge-pair.js namedProvider)
  ok(!/^≈/.test(await text(page, '#a-out')) && !/Limits\s*0\.01 to 30 ETH/.test(await text(page, '#a-rcpt')), `and gives no estimate the other way from a provider the site does not name (${await text(page, '#a-out')})`);
  await page.close();
  const two = await fresh({ path: '/btc/?from=ETH&to=BTC' });
  ok(/From.*Ethereum, private/.test(await text(two.page, '#a-pay')), 'the card\'s own words (?from=ETH&to=BTC) open it the same way');
  await two.page.close();
}

console.log('the house provider past its target, buying back; and one that does not say');
{
  houseInfo = { ...houseInfo, stats: { ...houseInfo.stats, capacity: { eth: '1100000000', sats: '40000000', valueEth: '2300000000' } }, target: { ...houseInfo.target, reached: true }, buyback: { on: true, startedAt: 1795608000, routedEth: '25000000', tacBought: '1234500000000000000000', sends: 1 } };
  const { page } = await fresh();
  await page.waitForFunction(() => /TAC bought/.test(document.querySelector('#pv-fund').textContent), null, { timeout: 10000 });
  const f = await text(page, '#pv-fund');
  ok(/23 ETH, at its target/.test(f) && /1,235 TAC bought/.test(f), `past the target: the capacity and the TAC bought (${f})`);
  ok(Math.abs(await page.$eval('#pv-fund .bar i', (e) => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width) - 1) < 0.01, 'the bar is full');
  await page.close();
  houseInfo = null;
  const quiet = await fresh();
  await listed(quiet.page);
  await sleep(1500);
  ok(await quiet.page.isHidden('#pv-fund'), 'a provider whose /info says nothing of it: no line');
  await quiet.page.close();
}

console.log('no provider online');
{
  const { page } = await fresh({ ads: [] });
  await page.waitForFunction(() => /No provider is online/.test(document.querySelector('#cap').textContent), null, { timeout: 20000 });
  ok((await page.$$('#pv-list li')).length === 0 && /no provider online/.test(await text(page, '#live')), 'the list says so, and the line under the heading too');
  await page.close();
}

console.log('the providers cannot be reached (a network that blocks them)');
{
  const { page } = await fresh({ ads: null });
  await page.waitForFunction(() => /could not be reached/.test(document.querySelector('#cap').textContent), null, { timeout: 20000 });
  ok(/providers not reached just now/.test(await text(page, '#live')) && !/no provider online/.test(await text(page, '#live')), `not "none online" when nothing answered (${await text(page, '#live')})`);
  ok(/not reached just now/.test(await text(page, '#atomic')) && !/none online/.test(await text(page, '#atomic')), 'the card says the same');
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

console.log('One press: the connected wallet\u2019s own ETH is shown, counted by Max, and checked');
{
  RPCV.balance = 14n * 10n ** 15n;
  const { page, errs } = await fresh({ path: '/btc/?dir=e2b', init: 'window.__add.restored = true; window.__atom.bal.eth = 0n;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance 0 ETH private · 0\.014 ETH in your wallet/.test(document.querySelector('#a-bal').textContent), null, { timeout: 15000 });
  ok(true, 'the From box says what is private and what the wallet holds');
  await page.click('#a-quick [data-quick]:last-child');
  const mx = await page.inputValue('#a-amt');
  ok(mx === '0.011', `Max is the wallet\u2019s ETH less the 0.003 kept for gas and fees (${mx})`);
  await page.waitForFunction(() => /^Swap 0\.011 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await SHOT(page, 'w-1280-light'); await page.emulateMedia({ colorScheme: 'dark' }); await SHOT(page, 'w-1280-dark'); await page.setViewportSize({ width: 390, height: 900 }); await SHOT(page, 'w-390-dark'); await page.emulateMedia({ colorScheme: 'light' }); await SHOT(page, 'w-390-light'); await page.setViewportSize({ width: 1200, height: 1000 });
  ok(/^Adds 0\.011 ETH from your wallet first, then swaps\./.test(await text(page, '#a-q')), 'the note says the press adds ETH from the wallet first');
  await page.fill('#a-amt', '0.013'); await page.dispatchEvent('#a-amt', 'input');
  await page.waitForFunction(() => /^Not enough ETH: you have 0\.014 in your wallet and 0 private; need 0\.016 including fees$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  ok(await page.$eval('#a-go', (e) => e.disabled), 'too little ETH in the wallet says so, with the numbers');
  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
  await page.close();
  RPCV.balance = 10n ** 18n;
}

console.log('One press: a swap of ETH the private balance is short of (the ETH made private first, then swapped)');
{
  const { page, errs, csp } = await fresh({ path: '/btc/?dir=e2b&amt=0.05', init: 'window.__atom.bal.eth = 0n;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap 0\.05 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  ok(!(await page.$eval('#a-go', (e) => e.disabled)), 'with no private ETH the one button swaps the amount, which it first makes private as one note of exactly it');
  const hint = await text(page, '#a-q');
  ok(/^One transaction from your wallet adds your ETH, then swaps\./.test(hint) && /The deposit is public\. Nothing on chain links it to the swap or your Bitcoin address\./.test(hint), `under the button: what one press does, and what its deposit shows on chain (${hint})`);
  ok((await atom(page, 'A.calls.quote.length')) >= 1, 'the quote is asked for before the press: the button swaps on it');
  const unit = await page.evaluate(async () => { const m = await import('/btc/add-eth.js'); const a = await import('/swap/atomic.js'); return [m.addUnits(5000000n, 0n), m.addUnits(5000000n, 3000000n), m.addUnits(5000000n, 5000000n), m.addUnits(5000000n, null), a.addUnits(5000000n, 1n), m.leastFor(100000000000000n)].map(String); });
  ok(JSON.stringify(unit) === JSON.stringify(['5000000', '2000000', '0', '5000000', '4999999', '200000']), `the shortfall math: the amount with nothing available, else what is short, nothing when covered; the lane's copy agrees; the least deposit a tip allows (${unit})`);
  const spans = await page.evaluate(async () => { const a = await import('/swap/atomic.js'); return [a.etaSpan(1770), a.etaSpan(1410), a.etaSpan(600)]; });
  ok(JSON.stringify(spans) === JSON.stringify(['20\u2060–\u206030 min', '15\u2060–\u206025 min', 'about 10 min']), `the time a swap of ETH has left: a range while two Bitcoin blocks are ahead, one figure nearer the end (${spans})`);
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
  ok(steps.length === 5 && steps[0] === 'Adding ETH:active' && steps[1] === 'They send BTC:active', `one view of the whole swap: its ETH being made private, alongside the provider's lock (${steps})`);
  ok(/20\u2060–\u206030 min/.test(card) && /The provider is locking BTC for you/.test(card), `one time for all of it, as a range (${card.slice(0, 160)})`);
  ok(/Can’t be cancelled now\./.test(card) && !(await page.$('#mine-list [data-press-cancel]')) && !(await page.$('#a-q [data-press-cancel]')), 'the provider has been asked: no Cancel, and the card says it is locked in');
  ok((await page.inputValue('#a-amt')) === '' && /^Adding ETH…$/.test(await text(page, '#a-go')), 'the lane is cleared for the next swap, which waits while the deposit lands');
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
  ok(/Adding ETH/.test(press) && /20\u2060–\u206030 min/.test(press) && (await page.$$('#mine-list [data-rec="press"] .stp li')).length === 5 && !!(await page.$('#mine-list [data-rec="press"] [data-press-cancel]')), `while the deposit waits for a block: one card for the whole swap, its first step under way, with a Cancel (${press.slice(0, 140)})`);
  ok(/Deposit sent/.test(await text(page, '#a-q')) && /^Adding ETH…$/.test(await text(page, '#a-go')), 'the line says where the deposit is; the button waits');
  await SHOT(page, 'oneclick-cancel-offered-dark');
  await page.click('#a-q [data-press-cancel]');
  ok(/Cancelled\. The deposit is sent, so its ETH lands in your private balance/.test(await text(page, '#a-q')) && !(await page.$('[data-press-cancel]')), 'cancelled: no swap will start, and the deposit is said to stay in the private balance');
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
  const { page, errs, csp } = await fresh({ init: `window.__atom.recs = [{ id: 'swD', dir: 'e2b', state: 'done', title: 'Done', detail: 'The BTC is at your Bitcoin address.', pay: 4000000n, get: 111000n, got: 110500n, steps: ['They send BTC', 'You send ETH', 'They confirm', 'You get BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'done' })), etaSecs: 0, at: Math.floor(Date.now() / 1000) - 60, refundAt: null, backBy: null },
    { id: 'swL', dir: 'e2b', state: 'working', title: 'Waiting for the provider to claim', detail: 'The provider is claiming the ETH you locked.', pay: 4000000n, get: 111000n, steps: ['They send BTC', 'You send ETH', 'They confirm', 'You get BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: i < 2 ? 'done' : i === 2 ? 'active' : 'todo' })), etaSecs: 840, at: Math.floor(Date.now() / 1000) - 900, refundAt: Math.floor(Date.now() / 1000) + 3 * 3600, backBy: Math.floor(Date.now() / 1000) + 3 * 3600 }];` });
  await page.click('#a-go');
  await page.waitForFunction(() => document.querySelector('#mine-list [data-rec="swD"] .nx'), null, { timeout: 15000 });
  const done = await text(page, '#mine-list [data-rec="swD"]');
  ok(/0\.04 ETH → 0\.001105 BTC/.test(done) && /Send it to any wallet or exchange/.test(done), `done: what arrived, the lock less the take's fee (${done.slice(0, 120)})`);
  ok((await page.getAttribute('#mine-list [data-rec="swD"] [data-next="book"]', 'href')) === '/trade/tac/?lane=btc' && (await page.getAttribute('#mine-list [data-rec="swD"] [data-next="elsewhere"]', 'href')) === '/#wallet', 'next: the Bitcoin order book of TAC, and the wallet sheet for the key to use elsewhere');
  const locked = await text(page, '#mine-list [data-rec="swL"]');
  ok(/Can’t be cancelled now\. It finishes, or your ETH returns to your private balance by \d{1,2}:\d\d(?: [AP]M)? (today|tomorrow)\./.test(locked) && !/If it stops/.test(locked), `once the ETH is locked: locked in, and when the ETH comes back if the provider does not claim (${locked.slice(0, 260)})`);
  await page.$eval('#mine', (e) => e.scrollIntoView());
  await SHOT(page, 'done-next', false);
  await page.click('#mine-list [data-rec="swD"] [data-next="send"]');
  await page.waitForFunction(() => document.querySelector('#mybtc').open, null, { timeout: 5000 });
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

console.log('One press of BTC: paid in from a Bitcoin wallet and swapped, the ETH kept private or sent on to an Ethereum address');
{
  const { page, errs, csp } = await fresh({ init: 'window.__atom.bal.sats = 0n;' });
  await page.evaluate(() => { window.__btc.canSend = true; });
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance 0 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 15000 });
  await page.fill('#a-amt', '0.002');
  await page.waitForFunction(() => /^Swap 0\.002 BTC → ETH$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  const hint = await text(page, '#a-q');
  ok(/^One payment from your Bitcoin wallet starts the swap\./.test(hint) && /Bitcoin payments are public\. Your ETH arrives private\./.test(hint), `with a Bitcoin wallet here and nothing at the address, one press pays in and swaps (${hint})`);
  const checks = await page.evaluate(async () => { const m = await import('/btc/payout.js'); const c = (t) => { const r = m.checkAddress(t); return r.ok ? r.address : `no: ${r.why}`; };
    return [c('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), c('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), c('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), c('0x' + '0'.repeat(40)), c('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), c('vitalik.eth'), c('0x1234')]; });
  ok(checks[0] === '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' && checks[1] === checks[0] && /checksum/.test(checks[2]) && /zero address/.test(checks[3]) && /Bitcoin address/.test(checks[4]) && /not a name/.test(checks[5]) && /40 letters/.test(checks[6]), `Ethereum addresses: EIP-55 checked when in mixed case, one case taken and checksummed, the zero address, a Bitcoin address, a name and a short one refused (${checks.join(' | ')})`);
  // receive as: the Tacit key's Ethereum address, with the relay's fee said first
  ok(!(await page.isHidden('#a-payto')) && (await page.$eval('input[name="a-pt"][value="private"]', (e) => e.checked)), 'the ETH is kept private unless asked otherwise');
  await page.click('input[name="a-pt"][value="tacit"]');
  await page.waitForFunction(() => /arrives at 0x/.test(document.querySelector('#a-pt-say').textContent), null, { timeout: 15000 });
  const say = await text(page, '#a-pt-say'), own = await page.getAttribute('#a-pt-own', 'title');
  ok(/Fee ≈ 0\.0003 ETH\. About 0\.0605 ETH arrives at 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\./.test(say) && /public from that address on/.test(say) && /easy to match/.test(say), `sent to the key's own Ethereum address: the fee and what arrives, and what it shows (${say})`);
  await page.click('input[name="a-pt"][value="other"]');
  ok(/^Enter an Ethereum address$/.test(await text(page, '#a-go')) && await page.$eval('#a-go', (e) => e.disabled), 'another address: none yet, so nothing can be pressed');
  await page.fill('#a-pt-addr', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD');
  ok(/checksum/.test(await text(page, '#a-pt-say')) && await page.$eval('#a-go', (e) => e.disabled), 'a mistyped address fails its checksum and is not taken');
  await page.click('input[name="a-pt"][value="tacit"]');
  await page.waitForFunction(() => /^Swap 0\.002 BTC → ETH$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await SHOT(page, 'btc-press-ask');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length === 1 && document.querySelector('#mine-list [data-rec="swB"]'), null, { timeout: 15000 });
  const sent = await page.evaluate(() => window.__btc.sent), coins = await atom(page, 'A.calls.coins[0]');
  ok(JSON.stringify(sent) === '[201800]', `one payment from the Bitcoin wallet: the amount and the lock's fee with half of it again in hand (${sent})`);
  ok(coins && coins.length === 1 && coins[0].txid === 'f0'.repeat(32) && coins[0].value === 201800, 'the lock is made from that payment as soon as it shows, not after its block');
  const card = await text(page, '#mine-list [data-rec="swB"]');
  ok(/Then sent to 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}, once the ETH has arrived\./.test(card) && /1\d⁠–⁠\d\d min/.test(card), `the card says where the ETH goes, and the time as a range (${card.slice(0, 220)})`);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('tacit-btc-payout-v1:02' + 'ab'.repeat(32)) || '{}'));
  ok(kept.swB && kept.swB.to === own && kept.swB.state === 'waiting', 'the choice is kept by key and swap, so a page opened again carries it out');
  await SHOT(page, 'btc-press-started');
  // the claim settles: the ETH is in the private balance as one note of the swap's amount, and the relay sends it on
  await page.evaluate(() => { const A = window.__atom, r = A.recs.find((x) => x.id === 'swB'); window.__ux.notes = [{ value: r.get, asset: '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34' }]; Object.assign(r, { state: 'done', title: 'Done', detail: 'The ETH is in your private balance.', steps: r.steps.map((x) => ({ ...x, state: 'done' })), refundAt: null }); });
  await page.waitForFunction(() => /Sent to 0x/.test(document.querySelector('#mine-list [data-rec="swB"]')?.textContent || ''), null, { timeout: 20000 });
  const un = await page.evaluate(() => window.__ux.unwraps);
  ok(un.length === 1 && un[0].recipient === own && un[0].value === '6080000', `once claimed, the swap's ETH is withdrawn to the address chosen, by the relay (${JSON.stringify(un)})`);
  ok(/Sent to 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}: 0\.0605 ETH\. Etherscan ↗/.test(await text(page, '#mine-list [data-rec="swB"]')) && (await page.$$('#mine-list [data-rec="swB"] a[href^="https://etherscan.io/tx/0xefef"]')).length === 1 && !(await page.$('#mine-list [data-rec="swB"] [data-next="withdraw"]')), 'the card says it was sent, with what arrived and the Etherscan link; no second send is offered');
  await SHOT(page, 'btc-press-sent');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}
{
  // the payment declined in the Bitcoin wallet: nothing is started
  const { page } = await fresh({ init: 'window.__atom.bal.sats = 0n;' });
  await page.evaluate(() => { window.__btc.canSend = true; window.__btc.declineSend = true; });
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance 0 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 15000 });
  await page.fill('#a-amt', '0.002');
  await page.waitForFunction(() => /^Swap 0\.002 BTC → ETH$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await page.click('#a-go');
  await page.waitForFunction(() => /^Nothing was sent\.$/.test(document.querySelector('#a-q').textContent), null, { timeout: 15000 });
  ok((await atom(page, 'A.calls.start.length')) === 0 && (await page.evaluate(() => window.__btc.sent.length)) === 1 && !(await page.$('#mine-list [data-rec="press"]')) && /^Swap 0\.002 BTC → ETH$/.test(await text(page, '#a-go')), 'declined: nothing was sent, no swap was started, and the button offers it again');
  await page.close();
}
{
  // a Bitcoin wallet whose coins may carry TAC: never asked to send; the safe ways are said, and sats sent the safe way go on into the swap by themselves
  const { page, errs } = await fresh({ init: 'window.__atom.bal.sats = 0n;' });
  await page.evaluate(() => { window.__btc.canSend = true; window.__btc.carriers = true; });
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance 0 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 15000 });
  await page.fill('#a-amt', '0.002');
  await page.waitForFunction(() => /^Swap 0\.002 BTC → ETH$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await page.click('#a-go');
  await page.waitForFunction(() => /holds TAC on some of its coins/.test(document.querySelector('#a-q').textContent), null, { timeout: 15000 });
  const said = await text(page, '#a-q');
  ok(!(await page.evaluate(() => window.__btc.sent)) && (await atom(page, 'A.calls.start.length')) === 0, 'the wallet was never asked to send, and nothing started');
  ok(/Sending from it now could spend them as plain sats and lose the TAC/.test(said) && /Send exactly 201,800 sats \(0\.002018 BTC\) to your Tacit wallet’s Bitcoin address from a wallet or account that holds no TAC: bc1q/.test(said) && /once Bitcoin confirms the payment/.test(said) && /move the TAC to your Tacit wallet first, in the classic app/.test(said), `the safe ways: the exact sats from a wallet with no TAC (address and amount to copy), or the TAC moved first (${said})`);
  ok((await page.$$('#a-q [data-copy]')).length === 2 && (await page.$$('#a-q a[href="/classic.html"]')).length === 1, 'with the address and the amount to copy, and the classic app linked');
  await SHOT(page, 'btc-press-tac-held', false);
  // the sats arrive at the Tacit address the safe way and are confirmed: the swap goes on by itself
  await page.evaluate(() => { window.__atom.bal.sats = 201800n; });
  await page.waitForFunction(() => window.__atom.calls.start.length === 1, null, { timeout: 30000 });
  ok(true, 'once the sats sent the safe way are confirmed at the address, the swap pressed goes on by itself');
  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
  await page.close();
}
{
  // the wallet's coins could not be checked: nothing is asked of it either
  const { page } = await fresh({ init: 'window.__atom.bal.sats = 0n;' });
  await page.evaluate(() => { window.__btc.canSend = true; window.__btc.scanFail = true; });
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance 0 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 15000 });
  await page.fill('#a-amt', '0.002');
  await page.waitForFunction(() => /^Swap 0\.002 BTC → ETH$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  await page.click('#a-go');
  await page.waitForFunction(() => /could not be checked for TAC just now, so nothing was sent/.test(document.querySelector('#a-q').textContent), null, { timeout: 15000 });
  ok(!(await page.evaluate(() => window.__btc.sent)) && (await atom(page, 'A.calls.start.length')) === 0 && /^Swap 0\.002 BTC → ETH$/.test(await text(page, '#a-go')), 'a check that cannot be made sends nothing, and the button offers it again');
  await page.close();
}
{
  // with no Bitcoin wallet in the browser, the way to add BTC is offered as before
  const { page } = await fresh({ init: 'window.__atom.bal.sats = 0n;' });
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance 0 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 15000 });
  await page.fill('#a-amt', '0.002');
  await page.waitForFunction(() => /^Add 0\.002\d* BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  ok(true, 'no Bitcoin wallet here: the button adds BTC (the address, its QR and a copy)');
  await page.close();
}
{
  // the real sequence of the canary of 11-25, opened again: a swap of BTC done while the page was closed, its ETH to go to an address chosen at the start.
  // Opened, the page sends it by itself; a note not there yet is said on the card from the second try, and Try again sends it once it is.
  const pub = '02' + 'ab'.repeat(32), to = '0x15fbF9F529190bBB0D35E0E9a59bc437cBB1F9c7'.toLowerCase();
  const { page, errs } = await fresh({ init: `window.__atom.recs = [{ id: 'swR', dir: 'b2e', state: 'done', title: 'Done', detail: 'The ETH is in your private balance.', pay: 130000n, get: 4632297n, steps: ['You send BTC', 'They send ETH', 'You get ETH', 'They get BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'done' })), etaSecs: 0, at: Math.floor(Date.now() / 1000) - 1200, refundAt: null, backBy: null }];
    localStorage.setItem('tacit-btc-payout-v1:${pub}', JSON.stringify({ swR: { at: Date.now() - 1200e3, to: '${to}', state: 'waiting', tries: 1 } }));` });
  await page.click('#a-go');
  await page.waitForFunction(() => /Couldn’t send to 0x15fb…f9c7 yet: The swap’s ETH is not in your private balance yet\. Trying again by itself\./.test(document.querySelector('#mine-list [data-rec="swR"]')?.textContent || ''), null, { timeout: 20000 });
  ok(true, 'opened again with the swap done: the send is tried at once, and a note not there yet is said plainly on the card, with Try again now');
  await page.evaluate(() => { window.__ux.notes = [{ value: 4632297n }]; });
  await page.click('#mine-list [data-rec="swR"] [data-pay-retry]');
  await page.waitForFunction(() => /Sent to 0x15fb…f9c7: 0\.04602297 ETH\. Etherscan/.test(document.querySelector('#mine-list [data-rec="swR"]')?.textContent || ''), null, { timeout: 20000 });
  const un = await page.evaluate(() => window.__ux.unwraps);
  ok(un.length === 1 && un[0].value === '4632297' && un[0].recipient.toLowerCase() === to, `the note of the swap's amount, found under the pool's 0x name, withdrawn to the address chosen (${JSON.stringify(un)})`);
  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
  await page.close();
}
{
  // a swap of BTC found again from the key does not know its ETH amount (the live check of 11-25): its Done card still offers the send, the amount chosen up
  // to the largest private amount (Max); and "Your ETH" sends any of the private balance the same way
  const { page, errs, csp } = await fresh({ init: `window.__atom.bal.eth = 5632297n; window.__atom.recs = [{ id: 'swQ', dir: 'b2e', state: 'done', title: 'Done', detail: 'The ETH is in your private balance, and the provider collected the BTC.', pay: 130000n, get: 0n, steps: ['You send BTC', 'They send ETH', 'You get ETH', 'They get BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'done' })), etaSecs: 0, at: Math.floor(Date.now() / 1000) - 3600, refundAt: null, backBy: null }];` });
  await page.click('#a-go');
  await page.waitForFunction(() => document.querySelector('#mine-list [data-rec="swQ"] [data-next="withdraw"]') && !document.querySelector('#ye-box').hidden, null, { timeout: 15000 });
  ok(!(await page.$eval('#mine', (e) => e.open)) && /1 done/.test(await raw(page, '#mine-sum')), 'a swap found again, never seen under way here, is a collapsed line: "1 done"');
  await page.evaluate(() => { document.querySelector('#mine').open = true; document.querySelector('#myeth').open = true; });
  await sleep(400);
  await page.evaluate(() => { window.__ux.notes = [{ value: 4632297n }, { value: 1000000n }]; });
  ok(/^0\.05632297 ETH$/.test(await text(page, '#ye-bal')) && !(await page.$eval('#ye-send', (e) => e.disabled)) && /public from that address on/.test(await text(page, '#myeth')), '"Your ETH": the private balance, a Send ETH, and what sending shows');
  await page.$eval('#mine', (e) => e.scrollIntoView());
  await SHOT(page, 'btc-recovered-done-send', false);
  await page.click('#mine-list [data-rec="swQ"] [data-next="withdraw"]');
  await page.waitForFunction(() => document.querySelector('.bsheet [data-max]') && !document.querySelector('.bsheet [data-max]').disabled, null, { timeout: 15000 });
  ok(/Up to 0\.04632297 ETH goes in one send\./.test(await text(page, '.bsheet [data-say]')), `with no amount known, the most one send takes is said (${await text(page, '.bsheet [data-say]')})`);
  await page.fill('.bsheet [data-amt]', '0.05');
  await page.waitForFunction(() => /At most 0\.04632297 ETH goes in one send/.test(document.querySelector('.bsheet [data-say]').textContent), null, { timeout: 15000 });
  ok(await page.$eval('.bsheet [data-go]', (e) => e.disabled), 'more than one send takes is refused, with the reason');
  await page.click('.bsheet [data-max]');
  await page.waitForFunction(() => /about 0\.04602297 ETH arrives at 0x/.test(document.querySelector('.bsheet [data-say]').textContent) && !document.querySelector('.bsheet [data-go]').disabled, null, { timeout: 15000 });
  await SHOT(page, 'btc-send-eth-dialog', false);
  await page.click('.bsheet [data-go]');
  await page.waitForFunction(() => /Sent: about 0\.04602297 ETH to 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\. Etherscan ↗/.test(document.querySelector('.bsheet [data-say]').textContent), null, { timeout: 20000 });
  let un = await page.evaluate(() => window.__ux.unwraps);
  ok(un.length === 1 && un[0].value === '4632297' && !un[0].amount, `Max sends the largest private amount whole, to the key's own Ethereum address by default (${JSON.stringify(un)})`);
  ok((await page.$$('.bsheet [data-say] a[href^="https://etherscan.io/tx/0xefef"]')).length === 1, 'and links the withdrawal on Etherscan');
  await page.click('.bsheet [data-x]');
  // "Your ETH": part of an amount, to an address typed and checked
  await page.click('#ye-send');
  await page.waitForFunction(() => document.querySelector('.bsheet [data-amt]'), null, { timeout: 15000 });
  await page.fill('.bsheet [data-amt]', '0.005');
  await page.click('.bsheet input[value="other"]');
  await page.fill('.bsheet [data-addr]', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD');
  ok(/checksum/.test(await text(page, '.bsheet [data-say]')), 'a mistyped address is refused');
  await page.fill('.bsheet [data-addr]', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  await page.waitForFunction(() => /about 0\.0047 ETH arrives at 0x5aAe…eAed/.test(document.querySelector('.bsheet [data-say]').textContent) && !document.querySelector('.bsheet [data-go]').disabled, null, { timeout: 15000 });
  await page.click('.bsheet [data-go]');
  await page.waitForFunction(() => /Sent:/.test(document.querySelector('.bsheet [data-say]').textContent), null, { timeout: 20000 });
  un = await page.evaluate(() => window.__ux.unwraps);
  ok(un.length === 2 && un[1].amount === '500000' && un[1].recipient === '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', `part of an amount is sent from the smallest that holds it, the rest stays private (${JSON.stringify(un[1])})`);
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}
{
  // a finished swap of BTC whose ETH was kept private: "Send to an Ethereum address" asks where, says the fee, and sends
  const { page, errs, csp } = await fresh({ scheme: 'dark', viewport: { width: 390, height: 900 }, init: `window.__atom.recs = [{ id: 'swP', dir: 'b2e', state: 'done', title: 'Done', detail: 'The ETH is in your private balance.', pay: 200000n, get: 6080000n, steps: ['You send BTC', 'They send ETH', 'You get ETH', 'They get BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'done' })), etaSecs: 0, at: Math.floor(Date.now() / 1000) - 60, refundAt: null, backBy: null }];
    window.__ux_notes = [{ value: 6080000n }];` });
  await page.click('#a-go');
  await page.waitForFunction(() => document.querySelector('#mine-list [data-rec="swP"] [data-next="withdraw"]'), null, { timeout: 15000 });
  await page.evaluate(() => { window.__ux.notes = window.__ux_notes; });
  await page.evaluate(() => { document.querySelector('#mine').open = true; });
  await sleep(400);
  await page.$eval('#mine', (e) => e.scrollIntoView());
  await SHOT(page, 'btc-done-withdraw-390-dark', false);
  await page.click('#mine-list [data-rec="swP"] [data-next="withdraw"]');
  await page.waitForFunction(() => document.querySelector('.bsheet [data-say]') && /arrives/.test(document.querySelector('.bsheet [data-say]').textContent), null, { timeout: 15000 });
  ok(/The relay’s fee is about 0\.0003 ETH: about 0\.0605 ETH arrives at 0x/.test(await text(page, '.bsheet [data-say]')), 'the fee and what arrives are said before anything is sent');
  await page.click('.bsheet input[value="other"]');
  await page.fill('.bsheet [data-addr]', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD');
  ok(/checksum/.test(await text(page, '.bsheet [data-say]')) && await page.$eval('.bsheet [data-go]', (e) => e.disabled), 'a mistyped address is refused there too');
  await page.fill('.bsheet [data-addr]', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
  await SHOT(page, 'btc-withdraw-dialog-390-dark', false);
  await page.click('.bsheet [data-go]');
  await page.waitForFunction(() => window.__ux.unwraps.length === 1 && /Sent to 0x5aAe…eAed/.test(document.querySelector('#mine-list [data-rec="swP"]').textContent), null, { timeout: 20000 });
  ok((await page.evaluate(() => window.__ux.unwraps[0].recipient)) === '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'sent to the address typed, in its checksummed form');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('Send BTC: the Tacit wallet\'s own bitcoin to any address');
{
  const { page, errs, csp } = await fresh();
  ok(/Sign in above to see your Bitcoin address/.test(await text(page, '#mybtc')) && await page.isHidden('#yb-box'), 'before the wallet opens the panel says how to see it');
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
  await page.waitForFunction(() => document.querySelector('#a-go') && /Sign in to swap/.test(document.querySelector('#a-go').textContent), null, { timeout: 30000 });
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

console.log('the sections under the tile: closed lines that open (disclosures)');
{
  const { page, errs, csp } = await fresh({ viewport: { width: 390, height: 800 } });
  await listed(page);
  ok((await page.$$eval('details.dd', (ds) => ds.map((d) => d.id + (d.open ? '+' : '-')).join(','))) === 'mine-,mybtc-,myeth-,pv-,be-', 'all five sections start closed');
  ok(/^1 online · up to 0\.30 BTC$/.test(await raw(page, '#pv-at')) && (await raw(page, '#mine-sum')) === 'sign in', `the one line of Providers carries what is live (${await raw(page, '#pv-at')}) and of Your swaps says how to see them`);
  ok((await page.$$eval('details.dd > summary', (ss) => ss.map((s) => s.getBoundingClientRect().height))).every((h) => h >= 40), 'each line is a tap target of 40 px or more');
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), 'no sideways scroll at a phone width, all closed');
  ok(await page.$$eval('details.dd > summary h2', (hs) => hs.length === 5), 'each summary holds its heading, so the section is still found by its name');
  // keyboard: the summary takes focus, Enter and Space open and close it
  await page.focus('#pv > summary');
  ok(await page.$eval('#pv > summary', (e) => e === document.activeElement), 'a line takes keyboard focus');
  await page.keyboard.press('Enter');
  ok(await page.$eval('#pv', (e) => e.open), 'Enter opens it');
  await page.keyboard.press('Space');
  ok(!(await page.$eval('#pv', (e) => e.open)), 'Space closes it');
  await page.keyboard.press('Enter');
  await page.click('#be > summary');
  await sleep(150);
  // remembered: what the visitor opened stays open on a reload, what they left closed stays closed
  ok(await page.evaluate(() => { const o = JSON.parse(localStorage.getItem('tacit-btc-open') || '{}'); return o.be === 1 && o.pv === 1; }), 'a choice is kept in this browser');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#a-go') && document.querySelector('#a-go').textContent !== 'Loading…', null, { timeout: 30000 });
  ok(await page.$eval('#be', (e) => e.open) && await page.$eval('#pv', (e) => e.open) && !(await page.$eval('#mybtc', (e) => e.open)), 'after a reload the sections open and closed are as the visitor left them');
  ok(errs.length === 0 && csp.length === 0, `no page or CSP errors (${errs.join(' | ')} ${csp.join(' | ')})`);
  await page.close();
}
{
  // a link to a section opens it and goes there; storage that throws costs nothing
  const { page, errs } = await fresh({ path: '/btc/#be', init: 'Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });' });
  await page.waitForFunction(() => document.querySelector('#be').open, null, { timeout: 5000 });
  await sleep(500);
  ok(await page.$eval('#be', (e) => e.open) && (await page.$eval('#be', (e) => Math.abs(e.getBoundingClientRect().top))) < 200, '/btc/#be opens Run a provider and scrolls to it, with browser storage blocked');
  await page.evaluate(() => { location.hash = '#pv'; });
  await page.waitForFunction(() => document.querySelector('#pv').open, null, { timeout: 5000 });
  ok(await page.$eval('#pv', (e) => e.open), 'a later link to #pv opens Providers');
  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
  await page.close();
}
{
  // the wallet opens with a swap under way: Your swaps opens by itself, the wallet panels stay closed with their balances in the line
  const { page, errs } = await fresh();
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && document.querySelector('#mine').open, null, { timeout: 30000 });
  ok(!(await page.$eval('#mybtc', (e) => e.open)) && !(await page.$eval('#myeth', (e) => e.open)), 'a swap under way opens Your swaps; the wallet panels stay closed');
  await page.waitForFunction(() => /0\.5 BTC/.test(document.querySelector('#yb-sum').textContent) && /private/.test(document.querySelector('#ye-sum').textContent), null, { timeout: 15000 });
  ok(/^1 in progress · 1 done$/.test(await raw(page, '#mine-sum')) && (await raw(page, '#yb-sum')) === '0.5 BTC' && (await raw(page, '#ye-sum')) === '4 private', `the lines say it: ${await raw(page, '#mine-sum')}, ${await raw(page, '#yb-sum')}, ${await raw(page, '#ye-sum')}`);
  ok(/restore one you made yourself/.test(await text(page, '#mine-keep')) && await page.isVisible('#mine-list [data-rec="sw1"] .stay'), 'the warning and the swap\'s "keep this page open" are in the open section, in view');
  await page.click('#mine > summary');
  await sleep(150);
  ok(!(await page.$eval('#mine', (e) => e.open)), 'Your swaps closes when the visitor closes it');
  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
  await page.close();
}
{
  // a swap that needs attention opens its section even when the visitor had closed it
  const init = `localStorage.setItem('tacit-btc-open', '{"mine":0}'); window.__atom.recs = [{ id: 'swS', dir: 'b2e', state: 'working', title: 'Waiting for the provider', detail: 'The provider has not answered.', pay: 1000000n, get: 30400000n, steps: [{ key: 'lock', title: 'You lock BTC', state: 'active' }], etaSecs: 0, at: Math.floor(Date.now() / 1000) - 7200, refundAt: null, backBy: null, stuck: true, slow: 'This is taking longer than usual.' }];`;
  const { page } = await fresh({ init });
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && document.querySelector('#mine-list [data-rec="swS"]'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#mine').open, null, { timeout: 5000 });
  await sleep(450);
  ok(/need/.test(await raw(page, '#mine-sum')) && await page.isVisible('#mine-list .slow'), `a stuck swap forces its section open, the line says so (${await raw(page, '#mine-sum')})`);
  await page.close();
}

{
  const html = readFileSync(new URL('../dapp/btc/index.html', import.meta.url), 'utf8');
  ok(/Running a node also helps:[^<]*<a href="\/nodes\/">\/nodes\/<\/a> and ranked by uptime and accuracy/.test(html), 'the provider area points at /nodes/');
}

console.log('the console stays clean: nodes that refuse a browser are not asked');
{
  BAD.length = 0; FLAKY.on = true;
  const { page, errs } = await fresh();
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked, null, { timeout: 30000 });
  await page.fill('#a-amt', '0.01');
  await sleep(4000);
  await page.fill('#a-amt', '0.02');
  await sleep(4000);
  FLAKY.on = false;
  ok(BAD.length === 0, `mevblocker and BuidlGuidl are not asked on load, sign-in or a quote (${BAD.join(' ')})`);
  ok(FLAKY.asked.length <= 2, `a node that refused is not asked again in the page (${FLAKY.asked.length} asks)`);
  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
  await page.close();
}

await b.close();
server.close();
console.log(`\n${n} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
