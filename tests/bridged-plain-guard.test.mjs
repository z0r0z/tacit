// A token bridged from the pool to Bitcoin, other than TAC, is never listed or sold by an atomic sale on Bitcoin by the wallet (dapp/tacit.js
// _refuseBridgedPlain): the reflection folds the outputs of an atomic sale for TAC alone (cxfer-core LEGACY_BRIDGE_ASSETS), so the buyer's note could
// not return to Ethereum. It IS sent, split, combined and moved: the transfer builder makes those bound transfers (0x39), which the reflection folds for
// any asset (tests/bridged-bound-send.test.mjs shows the bytes). TAC and tokens native to Bitcoin are untouched. Every refusal comes before anything is
// read from the network.
//
//   node tests/bridged-plain-guard.test.mjs
import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
// Node 22 has its own read-only navigator: define it rather than assign it
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'mainnet');
// nothing here may reach the network: a fetch is a failure of the test, not a slow pass
globalThis.fetch = async (u) => { throw new Error(`network read in a guard test: ${String(u).slice(0, 80)}`); };

const dapp = await import('../dapp/tacit.js');
const secp = await import('@noble/secp256k1');
const { randomBytes } = await import('node:crypto');
// a throwaway key in memory, so the builders that open the wallet first reach the guard (with none, the wallet asks for one)
{ const priv = Uint8Array.from(randomBytes(32)); dapp.wallet.priv = priv; dapp.wallet.pub = secp.getPublicKey(priv, true); }

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };
// a call that goes past the guard reads the network (refused here) or waits on it: a timeout also means it was not refused by the guard
const errOf = async (f, ms = 20000) => { try { await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out past the guard')), ms))]); return null; } catch (e) { return e; } };
const LATER = Math.floor(Date.now() / 1000) + 3600;

const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const BRIDGED = {
  tETH: '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34',
  cBTC: '62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8',
  cUSD: '8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d',
  cUSDT: 'c50e8dd9666f64a23e5457d686382901f08aaea3554328fc4ac25d2f9fac6c00',
};
const SPX = '45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';
const NATIVE = 'ab'.repeat(32);   // an asset etched on Bitcoin, never bridged
const PUB = '02' + '11'.repeat(32), TXID = 'cd'.repeat(32);

const refused = (e, tk) => !!e && e.bridgedOnly === true && e.message.startsWith(`${tk} bridged to Bitcoin is sold into a buyer's bid`);
const past = (e) => !e?.bridgedOnly;

// ---- every way a note leaves its owner on Bitcoin, for each built-in bridged token: transfers go on, sales by listing are refused ----
for (const [tk, id] of Object.entries(BRIDGED)) {
  ok(past(await errOf(() => dapp.buildAndBroadcastCXfer({ assetIdHex: id, recipientPubHex: PUB, amount: 1n }))), `${tk}: a send goes past the guard (the builder binds it)`);
  ok(past(await errOf(() => dapp.buildAndBroadcastCXferMulti({ assetIdHex: '0x' + id, recipients: [{ pubHex: PUB, amount: 1n }] }))), `${tk}: a split or combine goes past the guard, 0x-prefixed or not`);
  ok(refused(await errOf(() => dapp.publishAxferIntent({ utxoTxid: TXID, utxoVout: 0, priceSats: 10000, expiry: LATER, preResolvedTarget: { amount: 1n, blinding: '1' }, preResolvedAssetIdHex: id })), tk), `${tk}: an atomic ask is refused`);
  ok(refused(await errOf(() => dapp.takePreauthSale({ assetIdHex: id, saleIdHex: TXID })), tk), `${tk}: buying a listed sale is refused (the buyer's note would not return)`);
  ok(refused(await errOf(() => dapp.publishBidIntent({ assetIdHex: id, amount: 1n, priceSats: 10000, expiry: LATER })), tk), `${tk}: a bid-intent (filled only by an atomic sale) is refused`);
}
for (const [tk, id] of Object.entries(BRIDGED)) { const e = await errOf(() => dapp.moveBridgedNote({ txid: TXID, vout: 0, assetIdHex: id })); ok(past(e) && !/can be moved here/.test(e?.message || ''), `${tk}: the move from the Taproot address to the key's own address goes past the guard`); }

// ---- a token bridged at run time (any ERC-20 the pool escrows) is treated the same way, by its own name ----
ok(dapp.addBridgedAsset({ assetId: SPX, ticker: 'SPX', capRaw: 10n ** 11n, minRaw: 0n, dec: 8 }) === true, 'SPX is added as a bridged token');
ok(past(await errOf(() => dapp.buildAndBroadcastCXfer({ assetIdHex: SPX, recipientPubHex: PUB, amount: 1n }))), 'SPX: a send goes past the guard');
ok(refused(await errOf(() => dapp.publishAxferIntent({ utxoTxid: TXID, utxoVout: 0, priceSats: 10000, expiry: LATER, preResolvedTarget: { amount: 1n, blinding: '1' }, preResolvedAssetIdHex: SPX })), 'SPX'), 'SPX: an atomic ask is refused, named as SPX');
ok(refused(await errOf(() => dapp.publishBidIntent({ assetIdHex: SPX, amount: 1n, priceSats: 10000, expiry: LATER })), 'SPX'), 'SPX: a bid-intent is refused');

// ---- TAC (the legacy asset, whose transfers fold) and a native Bitcoin token are never refused by the guard ----
for (const [what, id] of [['TAC', TAC], ['a native token', NATIVE]]) {
  const e1 = await errOf(() => dapp.buildAndBroadcastCXfer({ assetIdHex: id, recipientPubHex: PUB, amount: 1n }));
  ok(!e1?.bridgedOnly, `${what}: a plain send goes past the guard (${e1 ? String(e1.message).slice(0, 60) : 'no error'})`);
  const e2 = await errOf(() => dapp.publishBidIntent({ assetIdHex: id, amount: 1n, priceSats: 10000, expiry: LATER }));
  ok(!e2?.bridgedOnly, `${what}: a bid-intent goes past the guard`);
}
// ---- the bound path: a bridged token's bid-intent is allowed when it is a bound (watchtower) bid, which only a bound offer fills ----
{ const e = await errOf(() => dapp.publishBidIntent({ assetIdHex: BRIDGED.tETH, amount: 1n, priceSats: 10000, expiry: LATER, bound: true }));
  ok(!e?.bridgedOnly, `tETH: a bound bid-intent goes past the guard (${e ? String(e.message).slice(0, 60) : 'no error'})`); }
const eTac = await errOf(() => dapp.moveBridgedNote({ txid: TXID, vout: 0, assetIdHex: TAC }));
ok(!eTac?.bridgedOnly && !/only TAC/.test(eTac?.message || ''), 'TAC can still be moved to the trading address');

console.log(`\n${n} bridged-plain-guard checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
