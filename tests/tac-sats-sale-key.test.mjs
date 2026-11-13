// "To sats" sale keys (dapp/sats/secret.js saleKey, saleKeys, exitToSaleKey): shielded TAC leaves the pool through the
// relay to a new P2WPKH key of the pool wallet, so the wallet's own Bitcoin address never funds or signs anything.
// The relay, the explorer and the prover are stubbed; a post from the wallet's address is seen as tacit.wallet.xonly()
// being reached, which broadcastCarrier calls first.
//   node tests/tac-sats-sale-key.test.mjs

import assert from 'node:assert/strict';
import { secp, sha256, ripemd160, bech32, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';

const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);       // the relay's five-minute wait, at once
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const secret = await import('../dapp/sats/secret.js');
const { pool } = secret;
const client = secret.poolClientFor('mainnet');
const ASSET = secret.TAC_ASSET_MAINNET;
const pw = secret.poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const relayAddr = secret.poolWalletFor(new Uint8Array(32).fill(8), 'mainnet').addressString;

// ── saleKey: a P2WPKH key the wallet can recover, and an address that pays its script ──
const k0 = secret.saleKey(pw, 0), k1 = secret.saleKey(pw, 1);
assert.equal(k0.pub, bytesToHex(secp.getPublicKey(hexToBytes(k0.priv), true)), 'pub is the priv’s point');
assert.equal(k0.scriptPubKey, '0014' + bytesToHex(ripemd160(sha256(hexToBytes(k0.pub)))), 'P2WPKH of that point');
const dec = bech32.decode(k0.address);
assert.equal(dec.prefix, 'bc'); assert.equal(dec.words[0], 0, 'witness version 0, bech32 (not bech32m)');
assert.equal(bytesToHex(bech32.fromWords(dec.words.slice(1))), k0.scriptPubKey.slice(4), 'the address pays the script');
assert.notEqual(k0.address, k1.address, 'one key per counter');
assert.deepEqual(secret.saleKey(pw, 0), k0, 'the same counter gives the same key: recoverable from the backup');
assert.equal(pool.deriveExitKey(pw, 0, 'p2tr').priv.replace(/^0x/, ''), k0.priv, 'P2TR and P2WPKH of one counter share a secret, so a counter serves one script only');
const tbKey = secret.saleKey(secret.poolWalletFor(new Uint8Array(32).fill(7), 'signet'), 0);
assert.ok(tbKey.address.startsWith('tb1q'), 'signet keys are tb1q');

// ── saleKeys: walks the chain for used keys, opens the exits at them, finds the first free counter ──
const API = 'https://esplora.test/api';
const p2trAddr = (c) => secret.p2trAddress(pool.deriveExitKey(pw, c, 'p2tr').scriptPubKey, 'mainnet');
function chain({ wpkh = {}, tr = new Set() } = {}) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const p = String(url).slice(API.length);
    let m;
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if ((m = p.match(/^\/address\/([^/]+)\/utxo$/))) return ok(Object.entries(wpkh).find(([c]) => secret.saleKey(pw, +c).address === m[1])?.[1] || []);
    if ((m = p.match(/^\/address\/([^/]+)$/))) {
      seen.push(m[1]);
      const c = Object.keys(wpkh).find((c) => secret.saleKey(pw, +c).address === m[1]);
      const hit = c != null || [...tr].some((t) => p2trAddr(t) === m[1]);
      return ok({ chain_stats: { tx_count: hit ? 1 : 0 }, mempool_stats: { tx_count: 0 } });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return seen;
}
const recorded = [];
const tx = (id, opcode) => ({ id, opcode });
const tacitScan = {
  NET: { api: API },
  getTx: async (id) => tx(id, id.startsWith('ee') ? 0x6d : 0x39),
  txOutputEnvelope: (t) => ({ opcode: t.opcode, payload: new Uint8Array([1]) }),
  recordOpening: (...a) => recorded.push(a),
};
let wantAddrs = [relayAddr], failOpen = false;
pool.recoverExit = (wallet, payload, notes, opts) => { if (failOpen && payload[0] === 2) throw new Error('btc-pool: exit opening not recovered'); assert.equal(wallet, pw); assert.ok(Array.isArray(notes)); assert.deepEqual(opts?.addresses, wantAddrs, 'the relay’s address opens the fee note'); return { exitVout: 1, value: '250000000', blinding: '0x' + '05'.padStart(64, '0') }; };

{
  const seen = chain({
    wpkh: { 0: [
      { txid: 'ee'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },   // a take-out
      { txid: 'ee'.repeat(31) + 'ef', vout: 0, value: 546, status: { confirmed: false } },   // an exit at another output than the one it opens
      { txid: '39'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },   // not a pool exit
    ] },
    tr: new Set([1]),
  });
  recorded.length = 0;
  const r = await secret.saleKeys(tacitScan, pw, [], ASSET, { addresses: [relayAddr] });
  assert.equal(r.keys.length, 1);
  assert.equal(r.keys[0].counter, 0);
  assert.deepEqual(r.keys[0].notes, [{ txid: 'ee'.repeat(32), vout: 1, value: 250000000n, confirmed: true }]);
  assert.deepEqual(recorded, [['ee'.repeat(32), 1, ASSET, 250000000n, 5n]], 'the opening is recorded for the holdings scan');
  assert.equal(r.free, 2, 'counter 1 is skipped: its P2TR key has history');
  assert.ok(seen.includes(secret.saleKey(pw, 7).address) && !seen.includes(secret.saleKey(pw, 8).address), 'six quiet counters end the walk');
  assert.deepEqual(r.unread, [], 'another output of an exit and a coin that is no exit are nothing to report');
}
{
  chain();
  const r = await secret.saleKeys(tacitScan, pw, [], ASSET);
  assert.deepEqual(r, { keys: [], free: 0, unread: [] }, 'a new wallet starts at counter 0');
}
// an output at a sale key the read cannot open is named as unread, never dropped: a transaction that did not load, and a pool
// exit whose opening cannot be rebuilt (its fee note unreadable); the output that does open is still found
{
  chain({ wpkh: { 0: [
    { txid: 'ee'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },
    { txid: 'aa'.repeat(32), vout: 0, value: 546, status: { confirmed: true } },
    { txid: 'bb'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },
    { txid: '39'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },
  ] } });
  const scan = {
    ...tacitScan,
    getTx: async (id) => { if (id.startsWith('aa')) throw new Error('explorer 429'); return tx(id, /^(ee|bb)/.test(id) ? 0x6d : 0x39); },
    txOutputEnvelope: (t) => ({ opcode: t.opcode, payload: new Uint8Array([t.id.startsWith('bb') ? 2 : 1]) }),
  };
  failOpen = true;
  const r = await secret.saleKeys(scan, pw, [], ASSET, { addresses: [relayAddr] });
  failOpen = false;
  assert.deepEqual(r.keys[0].notes.map((n) => n.txid), ['ee'.repeat(32)], 'the output that opens is found');
  assert.deepEqual(r.unread, [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: 'bb'.repeat(32), vout: 1 }], 'the two it could not open are named');
}

// ── a first explorer that is down or erroring: the dapp's second explorer answers; both down is a failure, not "none" ──
{
  const two = { ...tacitScan, NET: { api: 'https://down.test/api', api2: API } };
  for (const kind of ['throws', '503']) {
    chain();
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://down.test')) {
        if (kind === 'throws') throw new TypeError('fetch failed');
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return inner(url, init);
    };
    assert.deepEqual(await secret.saleKeys(two, pw, [], ASSET, { addresses: [relayAddr] }), { keys: [], free: 0, unread: [] }, `first explorer ${kind}: the second one answers`);
  }
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(secret.saleKeys(two, pw, [], ASSET), /fetch failed/, 'no explorer answering is a failed read, never "no take-outs"');
}

// ── exitToSaleKey ──
const NOT_NOW = 'The relay can’t take this one right now. Nothing was sent. Try again in a few minutes.';
const SLOW = 'The relay hasn’t posted it yet and may still. Nothing else was sent; once it posts, the TAC shows here, ready to list.';
const TOTAL = 10_000_000_000n;   // 100 TAC: the 2.5 TAC taken out, the 15 TAC fee and the change
const notes = [{ asset: '0x' + ASSET, value: TOTAL.toString(), nf: '0x01', txid: 'aa'.repeat(32), leafIndex: 0 }];
const FEE = 1500000000n;
let log;
function stub({ fee = FEE, quoteFee = fee, quote = 'ok', submit = [], status = (n) => (n === 2 ? { carrier: 'cc'.repeat(32) } : { state: 'queued' }), wait = null } = {}) {
  log = { quotes: [], submits: 0, statuses: 0, proofs: 0, builds: [], posts: 0, opened: [] };
  client.relayInfo = async () => (fee == null ? null : { fees: { ['0x' + ASSET]: fee.toString() } });
  client.quote = async (body) => {
    log.quotes.push(body);
    if (quote === 'fail') throw new Error('quote table full');
    return { fee: quoteFee.toString(), address: relayAddr, bind: { txid: 'bb'.repeat(32), vout: 0 }, quoteId: 'q' + log.quotes.length, exitVout: 0 };
  };
  client.submit = async () => { const e = submit[log.submits++]; if (e) throw e; return { id: 's1' }; };
  client.relayStatus = async () => status(++log.statuses);
  client.walletNotes = async () => notes;
  client.anchorAndPaths = async (inputs) => (wait ? { wait, tip: 900010 } : { hAnchor: 900000, root: '0x00', notes: inputs, tip: 900010 });
  secret.poolClient.artifactBytes = async () => 0;
  secret.poolClient.system = async () => ({});
  pool.selectInputs = (live) => ({ inputs: live, total: live.reduce((t, x) => t + BigInt(x.value), 0n) });
  pool.buildSpendBody = (a) => { log.builds.push(a); return { exit: { exitVout: a.exit.exitVout, blinding: '0x' + '09'.padStart(64, '0') } }; };
  pool.prove = async () => { log.proofs++; return { payload: new Uint8Array(4), payloadHex: '00000000' }; };
}
const tacit = { DUST: 546, recordOpening: (...a) => log.opened.push(a), wallet: { pub: new Uint8Array(33), xonly() { log.posts++; throw new Error('SELF_POST'); } } };
const key = secret.saleKey(pw, 3);
const out = (opts = {}) => secret.exitToSaleKey(tacit, { poolWallet: pw, amount: 250000000n, asset: ASSET, key, ...opts });
const declined = (p, msg) => assert.rejects(p, (e) => e.relayDeclined === true && e.said === true && e.message === msg);
const conflict = (exitVout) => Object.assign(new Error('exit_vout is not free in the open carrier; re-sign with exitVout'), { status: 409, body: { exitVout } });

// The relay takes it out: the exit pays the sale key, the relay's fee is a pool output, the bind is the quote's.
stub();
store.clear();
let r = await out();
assert.deepEqual(r, { revealTxid: 'cc'.repeat(32), exitVout: 0, amount: 250000000n, fee: FEE });
assert.deepEqual(log.quotes, [{ asset: '0x' + ASSET, exitScriptPubKey: key.scriptPubKey }], 'the quote names the sale key’s script');
const b = log.builds[0];
assert.deepEqual(b.exit, { exitVout: 0, scriptPubKey: '0x' + key.scriptPubKey, value: 250000000n });
assert.equal(b.outputs.length, 3, 'padded to three pool outputs');
assert.deepEqual(b.outputs[0], { address: relayAddr, value: FEE }, 'the relay’s fee, paid in the pool');
assert.deepEqual(b.outputs.slice(1), [{ address: pw.internalAddress, network: 'mainnet', value: TOTAL - 250000000n - FEE }, { address: pw.internalAddress, network: 'mainnet', value: 0n }], 'change and padding to the internal address');
assert.equal(b.outputs.reduce((t, o) => t + o.value, 0n) + b.exit.value, TOTAL, 'outputs plus the exit are the inputs, exactly');
assert.deepEqual(b.bind, { txid: 'bb'.repeat(32), vout: 0 });
assert.equal(b.wallet, pw, 'change and padding go to the pool wallet');
assert.deepEqual(log.opened, [['cc'.repeat(32), 0, ASSET, 250000000n, 9n]], 'the exit’s opening is recorded under its outpoint');
assert.equal(log.posts, 0, 'nothing from the wallet’s address');
assert.ok(JSON.parse(store.get('tacit-pool-sale-keys-v1'))[pw.addressString.slice(-16)][3] > 0, 'the counter is held');
{
  chain();
  const r2 = await secret.saleKeys(tacitScan, pw, [], ASSET);
  assert.equal(r2.free, 0, 'counters below a held one stay free');
  stub(); store.clear();
  await secret.exitToSaleKey(tacit, { poolWallet: pw, amount: 250000000n, asset: ASSET, key: secret.saleKey(pw, 0) });
  chain();
  assert.equal((await secret.saleKeys(tacitScan, pw, [], ASSET)).free, 1, 'a held counter is skipped until its take-out shows on chain');
}

// No relay, a quote that fails twice, a fee far above the listed one: nothing is proved or posted.
stub({ fee: null }); await declined(out(), NOT_NOW);
assert.equal(log.proofs, 0); assert.equal(log.posts, 0); assert.equal(log.quotes.length, 0);
stub({ quote: 'fail' }); await declined(out(), NOT_NOW);
assert.equal(log.quotes.length, 2, 'asked once more after a moment'); assert.equal(log.proofs, 0); assert.equal(log.posts, 0);
stub({ quoteFee: FEE * 2n }); await assert.rejects(out(), (e) => e.feeMoved === FEE * 2n);
assert.equal(log.proofs, 0);

// The newest note is too young: { wait }, nothing proved.
stub({ wait: 2 });
assert.deepEqual(await out(), { wait: 2, tip: 900010 });
assert.equal(log.proofs, 0);

// The relay's carrier filled the assigned output first: the same spend, re-signed for the output it names.
stub({ submit: [conflict(2)] });
r = await out();
assert.equal(r.exitVout, 2);
assert.deepEqual(log.builds.map((x) => x.exit.exitVout), [0, 2]);
assert.equal(log.proofs, 2); assert.equal(log.submits, 2);
assert.deepEqual(log.opened[0].slice(0, 2), ['cc'.repeat(32), 2]);

// The quote ran out while proving: asked once more, with the same notes.
stub({ submit: [new Error('quote expired')] });
r = await out();
assert.equal(log.quotes.length, 2); assert.equal(log.proofs, 2); assert.equal(r.revealTxid, 'cc'.repeat(32));
assert.equal(log.builds[1].inputs, log.builds[0].inputs, 'the same notes');

// The relay never posts it: ends after its sixty polls, and never from the wallet.
stub({ status: () => ({ state: 'queued' }) });
await declined(out(), SLOW);
assert.equal(log.statuses, 60); assert.equal(log.posts, 0); assert.equal(log.opened.length, 0);

// The relay drops it because the notes are spent elsewhere, or for another reason.
stub({ status: () => ({ state: 'rejected', reason: 'nullifier already spent' }) });
await assert.rejects(out(), /already being spent by another payment/);
stub({ status: () => ({ state: 'dropped', reason: 'anchor expired' }) });
await assert.rejects(out(), /could not post it \(anchor expired\)\. Nothing was sent\./);
assert.equal(log.posts, 0);

// Confirmed with no carrier reported: done, and saleKeys finds the note from the chain.
stub({ status: () => ({ state: 'confirmed' }) });
r = await out();
assert.equal(r.revealTxid, null); assert.equal(log.opened.length, 0);

// ── payoutScriptFor: bc1q / bc1p with their own checksums; everything else refused ──
{
  const wpkh = secret.saleKey(pw, 0);
  assert.equal(bytesToHex(secret.payoutScriptFor(wpkh.address)), wpkh.scriptPubKey, 'bc1q… → its P2WPKH script');
  assert.equal(bytesToHex(secret.payoutScriptFor(wpkh.address.toUpperCase())), wpkh.scriptPubKey, 'upper case reads the same');
  const trSpk = pool.deriveExitKey(pw, 0, 'p2tr').scriptPubKey.replace(/^0x/, '');
  assert.equal(bytesToHex(secret.payoutScriptFor(secret.p2trAddress(trSpk, 'mainnet'))), trSpk, 'bc1p… → its P2TR script');
  const wsh = bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(32).fill(4))]);
  const bad = wpkh.address.slice(0, -1) + (wpkh.address.endsWith('q') ? 'p' : 'q');
  for (const [addr, re] of [[wsh, /bc1q… or bc1p…/], [bad, /did not check out/], [wpkh.address.slice(0, 10) + wpkh.address.slice(10).toUpperCase(), /mixes upper and lower/],
    [tbKey.address, /bc1q… or bc1p…/], ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', /bc1q… or bc1p…/], ['', /bc1q… or bc1p…/]]) {
    assert.throws(() => secret.payoutScriptFor(addr), re, `refused: ${addr.slice(0, 14)}`);
  }
}

// ── saleQuote: 2% under the cheapest live ask, or under the mark with an empty book ──
{
  const now = Math.floor(Date.now() / 1000);
  const sale = (amountTac, sats, extra = {}) => ({ asset_opening: { amount: String(Math.round(amountTac * 1e8)) }, min_price_sats: sats, expiry: now + 3600, expired: false, ...extra });
  const serve = (sales, mark, ts) => { globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('/preauth-sales')) return { ok: sales != null, json: async () => ({ sales }) };
    return { ok: mark != null, json: async () => ({ mark_price: { unit: mark, ...(ts != null ? { ts } : {}) } }) };
  }; };
  serve([sale(100, 20000), sale(10, 1680), sale(10, 1500, { expired: true }), sale(10, 1000, { expiry: now - 5 })], 170);
  let q = await secret.saleQuote(100000n);
  assert.equal(q.ask, 168, 'the cheapest LIVE ask: expired ones are left out');
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9, '2% under it');
  assert.equal(q.units, BigInt(Math.ceil(100000 * 1e8 / (168 * 0.98))), 'TAC that sells for exactly the sats');
  serve([], 170);
  q = await secret.saleQuote(100000n);
  assert.equal(q.ask, null); assert.ok(Math.abs(q.unit - 170 * 0.98) < 1e-9, 'an empty book prices off the mark');
  serve(null, null);
  assert.equal(await secret.saleQuote(100000n), null, 'no price, no quote');
  // Faster: under the last trade when that is below the cheapest ask and recent
  serve([sale(10, 1680)], 150, now - 3600);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 150 * 0.98) < 1e-9 && q.basis === 'trade', 'under the last trade, below the cheapest ask');
  assert.equal(q.units, BigInt(Math.ceil(100000 * 1e8 / (150 * 0.98))), 'and it takes more TAC for the same sats');
  q = await secret.saleQuote(100000n);
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9 && q.basis === 'ask', 'standard is unchanged: under the cheapest ask');
  serve([sale(10, 1680)], 180, now - 3600);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9 && q.basis === 'ask', 'a last trade above the cheapest ask leaves it under the ask');
  serve([sale(10, 1680)], 150, now - 8 * 86400);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9 && q.basis === 'ask', 'a last trade older than a week is left out');
  serve([sale(10, 1680)], 150);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.equal(q.basis, 'ask', 'a last trade with no time is left out');
  serve([], 150, now - 3600);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 150 * 0.98) < 1e-9 && q.basis === 'trade', 'an empty book prices off the recent trade');
}

// ── lotsToBuy: live, not our own, within the budget, cheapest per TAC first, one of each size and price ──
{
  const now = Math.floor(Date.now() / 1000);
  const mine = new Uint8Array(33).fill(3);
  const lot = (id, tac, sats, extra = {}) => ({ sale_id: id, asset_opening: { amount: String(Math.round(tac * 1e8)) }, min_price_sats: sats, expiry: now + 7200, expired: false, seller_pubkey: '02' + 'aa'.repeat(32), ...extra });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sales: [
    lot('a', 145, 30_160), lot('b', 145, 30_160), lot('c', 48, 8_064), lot('d', 4285, 745_714),
    lot('e', 10, 1_000, { expired: true }), lot('f', 10, 1_100, { expiry: now + 60 }), lot('g', 10, 1_200, { seller_pubkey: bytesToHex(mine) }),
  ] }) });
  let r = await secret.lotsToBuy({ wallet: { pub: mine } }, { budget: 90_000 });
  assert.deepEqual(r.lots.map((x) => x.sale_id), ['c', 'a'], 'cheapest per TAC first, within the budget, one of each size and price');
  assert.ok(Math.abs(r.lots[0].unit - 168) < 1e-9);
  assert.equal(r.smallest.sale_id, 'c', 'expired, expiring and our own listings are left out');
  r = await secret.lotsToBuy({ wallet: { pub: mine } }, { budget: 5_000 });
  assert.equal(r.lots.length, 0); assert.equal(r.smallest.sale_id, 'c', 'with nothing affordable it still names the smallest lot');
  r = await secret.lotsToBuy({ wallet: { pub: mine } });
  assert.deepEqual(r.lots.map((x) => x.sale_id), ['c', 'd', 'a'], 'with no budget, the three cheapest per TAC');
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await secret.lotsToBuy({ wallet: { pub: mine } }), null, 'no answer from the market, no list');
}

// ── listFromSaleKey: the sale key signs, the wallet's key comes back, the sale key's bytes are wiped ──
{
  const mainPriv = new Uint8Array(32).fill(9), mainPub = new Uint8Array(33).fill(2);
  const k = secret.saleKey(pw, 4), script = secret.payoutScriptFor(secret.saleKey(pw, 5).address);
  let seen = null, invalidated = 0;
  const t = { wallet: { priv: mainPriv, pub: mainPub }, invalidateHoldingsCache: () => { invalidated++; },
    publishPreauthSale: async (o) => { seen = { ...o, pub: bytesToHex(t.wallet.pub), privRef: t.wallet.priv, priv: bytesToHex(t.wallet.priv) }; return { sale_id: 'ab'.repeat(16) }; } };
  const r = await secret.listFromSaleKey(t, { key: k, note: { txid: 'ee'.repeat(32), vout: 1 }, sats: 3300n, expiry: 1234567890, payoutScript: script });
  assert.equal(r.sale_id, 'ab'.repeat(16));
  assert.deepEqual([seen.pub, seen.priv], [k.pub, k.priv], 'signed by the sale key');
  assert.deepEqual([seen.utxoTxid, seen.utxoVout, seen.minPriceSats, seen.expiry], ['ee'.repeat(32), 1, 3300, 1234567890]);
  assert.equal(seen.sellerPayoutScript, script);
  assert.equal(t.wallet.priv, mainPriv); assert.equal(t.wallet.pub, mainPub);
  assert.ok(seen.privRef.every((x) => x === 0), 'the sale key bytes are wiped'); assert.ok(invalidated >= 2);
  t.publishPreauthSale = async () => { throw new Error('market said no'); };
  await assert.rejects(secret.listFromSaleKey(t, { key: k, note: { txid: 'ee'.repeat(32), vout: 1 }, sats: 3300n, expiry: 1, payoutScript: script }), /market said no/);
  assert.equal(t.wallet.priv, mainPriv, 'the key comes back after a refusal too');
}

// ── saleSettlement: unspent, paid to the recipient, or spent some other way ──
{
  const script = secret.payoutScriptFor(secret.saleKey(pw, 6).address), note = { txid: 'ee'.repeat(32), vout: 0 };
  let spend = { spent: false };
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => spend });
  const t = { NET: { api: API }, getTx: async () => ({ vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }, { scriptpubkey: bytesToHex(script), value: 3300 }], status: { confirmed: true } }) };
  assert.equal(await secret.saleSettlement(t, { note, payoutScript: script, sats: 3300n }), null, 'unspent: not yet');
  spend = { spent: true, txid: 'aa'.repeat(32), status: { confirmed: false } };
  assert.deepEqual(await secret.saleSettlement(t, { note, payoutScript: script, sats: 3300n }), { txid: 'aa'.repeat(32), paid: true, confirmed: false });
  assert.equal((await secret.saleSettlement(t, { note, payoutScript: script, sats: 3301n })).paid, false, 'less than the price is not paid');
  assert.equal((await secret.saleSettlement(t, { note, payoutScript: secret.payoutScriptFor(secret.saleKey(pw, 7).address), sats: 1n })).paid, false, 'another script is not paid');
}

console.log('tac-sats-sale-key: all checks passed');
