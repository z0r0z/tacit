// /tac Withdraw → "To sats" (dapp/tac/sats.js) in a DOM: the take-out goes through exitToSaleKey to the next free sale
// key, the listing is signed by the sale key that holds the note (the wallet's key is put back after, and the sale
// key's bytes are wiped), the payout cannot be this wallet's own address or a sale key, and only bc1q/bc1p payouts
// are taken. tacit.js, secret.js and the worker are stubs.
//   node tests/tac-sats-panel.test.mjs

import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';
import { secp, sha256, ripemd160, bech32, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://tacit.finance/tac/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

const { mount } = await import('../dapp/tac/sats.js');
const shared = await import('../dapp/sats/secret.js');   // the panel's decoder and listing are secret.js's

const p2wpkh = (pub) => Uint8Array.from([0x00, 0x14, ...ripemd160(sha256(pub))]);
const addr = (ver, prog) => bech32.encode('bc', [ver, ...bech32.toWords(prog)]);
const mainPriv = new Uint8Array(32).fill(3), mainPub = secp.getPublicKey(mainPriv, true);
const salePriv = '11'.repeat(32), salePub = bytesToHex(secp.getPublicKey(hexToBytes(salePriv), true));
const saleSpk = bytesToHex(p2wpkh(hexToBytes(salePub)));
const saleKey = { counter: 0, priv: salePriv, pub: salePub, scriptPubKey: saleSpk, address: addr(0, hexToBytes(saleSpk).slice(2)) };
const NOTE = { txid: 'ee'.repeat(32), vout: 1, value: 250000000000n, confirmed: true };
const fresh = addr(0, new Uint8Array(20).fill(9));
const own = addr(0, p2wpkh(mainPub).slice(2));
const wsh = addr(0, new Uint8Array(32).fill(4));

let listed = [], outs = [], invalidated = 0;
const T = {
  NET: { api: 'https://esplora.test/api' },
  wallet: { priv: mainPriv, pub: mainPub },
  p2wpkhScript: p2wpkh,
  invalidateHoldingsCache: () => { invalidated++; },
  publishPreauthSale: async (o) => {
    listed.push({ ...o, pub: bytesToHex(T.wallet.pub), priv: bytesToHex(T.wallet.priv), privRef: T.wallet.priv });
    return { sale_id: 'ab'.repeat(16) };
  },
};
const pw = { addressString: 'bp1qtest', network: 'mainnet' };
let free = 1;
const S = {
  TAC_ASSET_MAINNET: 'f0'.repeat(32),
  payoutScriptFor: shared.payoutScriptFor,
  listFromSaleKey: shared.listFromSaleKey,
  saleKeys: async (t, w, notes, asset, opts) => { assert.equal(t, T); assert.equal(w, pw); assert.ok(Array.isArray(notes)); assert.deepEqual(opts.addresses, ['bp1qrelay'], 'the relay’s address is passed'); return { keys: [{ ...saleKey, notes: [NOTE] }], free }; },
  saleKey: (w, c) => ({ ...saleKey, counter: c, marker: `key${c}` }),
  poolClientFor: () => ({ relayInfo: async () => ({ address: 'bp1qrelay' }), exit: async (txid, vout) => ({ exists: txid === NOTE.txid && vout === NOTE.vout }) }),
  exitToSaleKey: async (t, o) => { outs.push(o); return { revealTxid: 'cd'.repeat(32), exitVout: 0, amount: o.amount, fee: 1500000000n }; },
};
globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.includes('/preauth-sales')) return ok({ count: 124, sales: [] });
  if (u.includes('/assets/')) return ok({ mark_price: { unit: 168 } });
  if (u.includes('/address/')) return ok({ chain_stats: { tx_count: u.endsWith(fresh) ? 0 : 3 }, mempool_stats: { tx_count: 0 } });
  throw new Error('unexpected fetch ' + u);
};

const fmt = (u) => (Number(u) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
const parseUnits = (s) => { const n = Number(String(s).trim()); if (!Number.isFinite(n) || n < 0) throw new Error('bad amount'); return BigInt(Math.round(n * 1e8)); };
const said = {};
const host = document.getElementById('host');
const ctx = {
  T, S, poolWallet: pw, notes: [{ nf: '0x01', value: '9000000000' }],
  ensureKey: async () => {}, loadShielded: async () => {},
  shieldedTotal: () => 9000000000n, relayFeeUnits: () => 1500000000n,
  turn: (fn) => fn(),
  busy: async (btn, id, fn) => { try { await fn(); } catch (e) { said[id] = 'ERR ' + e.message; } },
  say: (id, ...n) => { said[id] = n.map((x) => (typeof x === 'string' ? x : x?.textContent || '')).join(''); },
  fmt, parseUnits, txLink: (t) => { const a = document.createElement('a'); a.textContent = t.slice(0, 10); return a; },
};
mount(host, ctx);
await settle();

const text = host.textContent;
assert.doesNotMatch(text, /null|undefined/, 'a part that is not shown writes no text');
assert.ok(!/nothing links it to the wallet on this page/i.test(text), 'the old claim is gone');
assert.ok(!/null|undefined/.test(text), 'a part the panel leaves out is not written as the word null');
assert.match(text, /This wallet’s address takes no part/);
assert.match(text, /The relay sees your connection when it takes the TAC out and the market when you list, so Tor or a VPN for the listing keeps the two apart/, 'the panel says what each side sees');
assert.match(text, /The relay’s fee is 15 TAC/);
assert.match(text, /2,500 TAC\s*ready to list/, 'the note at the sale key shows, ready');
{
  // under it, where it sits: the sale key's address and the take-out that paid it, each to look up
  const where = host.querySelector('.sats-where');
  assert.ok(where, 'the held note says where it is');
  const a = where.querySelector('a[href]');
  assert.equal(a.getAttribute('href'), `https://mempool.space/address/${saleKey.address}`, 'the sale key’s address links to an explorer');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.textContent, `${saleKey.address.slice(0, 12)}…${saleKey.address.slice(-6)}`);
  assert.equal(where.textContent, `at ${a.textContent}, taken out in ${NOTE.txid.slice(0, 10)}`, 'and the take-out, through the page’s transaction link');
}
{
  // what is at the sale keys leads the panel, before the form that starts at the shielded balance; Step 2 keeps only the list button
  const before = (x, y) => !!(x && y && x.compareDocumentPosition(y) & 4);
  const lead = host.querySelector('.eyebrow');
  assert.equal(lead.textContent, 'Taken out for sale', 'the first thing in the panel');
  assert.equal(host.firstElementChild, lead);
  const row = host.querySelector('.sats-where').parentElement;
  assert.ok(before(lead, row) && before(row, host.querySelector('#sats-amt')), 'the lot comes before the amount field');
  const eyebrows = [...host.querySelectorAll('.eyebrow')].map((e) => e.textContent);
  assert.deepEqual(eyebrows, ['Taken out for sale', 'Step 1: take it out', 'Step 2: list for sats']);
  const step2 = [...host.querySelectorAll('.eyebrow')][2];
  assert.equal(host.querySelectorAll('.sats-where').length, 1, 'shown once, not again under Step 2');
  assert.ok(before(host.querySelector('.sats-where'), step2));
  assert.match(lead.parentElement.textContent, /Put back returns it to your shielded balance\. To list it, set the price and address below/, 'with what each button does');
}
assert.equal(host.querySelector('#sats-price').value, '168', 'priced at the mark');
const [btnOut, btnList] = [...host.querySelectorAll('button.btn')];
assert.equal(btnList.disabled, false);

const list = async (to) => {
  host.querySelector('#sats-payout').value = to;
  delete said['st-sats-2'];
  btnList.click(); await settle();
  return said['st-sats-2'] || '';
};

// The payout must be another wallet's bc1q/bc1p address.
assert.match(await list(own), /ERR That is this wallet’s own address/);
assert.match(await list(saleKey.address), /ERR That is a key this page made for a sale/);
assert.match(await list(wsh), /ERR Use a bc1q… or bc1p…/);
assert.equal(listed.length, 0, 'none of those signed anything');

// A fresh address: the sale key signs, for the note it holds, paying that address; the wallet's key comes back.
invalidated = 0;
const done = await list(fresh);
assert.match(done, /Listed 2,500 TAC for 420,000 sats, for 3 days/);
assert.equal(listed.length, 1);
const l = listed[0];
assert.equal(l.pub, salePub, 'signed by the sale key');
assert.equal(l.priv, salePriv);
assert.equal(l.utxoTxid, NOTE.txid); assert.equal(l.utxoVout, NOTE.vout);
assert.equal(l.minPriceSats, 420000);
assert.equal(bytesToHex(l.sellerPayoutScript), bytesToHex(Uint8Array.from([0, 20, ...new Uint8Array(20).fill(9)])));
const days = Math.round((l.expiry - Date.now() / 1000) / 86400);
assert.equal(days, 3, 'lasts the chosen three days');
assert.equal(T.wallet.priv, mainPriv, 'the wallet’s key is back'); assert.equal(T.wallet.pub, mainPub);
assert.ok(l.privRef.every((x) => x === 0), 'the sale key’s bytes are wiped');
assert.ok(invalidated >= 2, 'holdings caches dropped on the way in and out');

// The payout hint flags an address with history.
const pay = host.querySelector('#sats-payout');
pay.value = own; pay.dispatchEvent(new dom.window.Event('change')); await settle();
assert.match(host.querySelector('#sats-payout-hint').textContent, /used before/);
pay.value = fresh; pay.dispatchEvent(new dom.window.Event('change')); await settle();
assert.equal(host.querySelector('#sats-payout-hint').textContent, '');

// Take out: above the balance with the fee is refused; otherwise the next free sale key, through exitToSaleKey.
host.querySelector('#sats-amt').value = '80';
btnOut.click(); await settle();
assert.match(said['st-sats-1'], /ERR More than your shielded balance with the relay’s 15 TAC fee/);
assert.equal(outs.length, 0);
host.querySelector('#sats-amt').value = '10';
free = 4;
btnOut.click(); await settle();
assert.equal(outs.length, 1);
assert.equal(outs[0].amount, 1000000000n);
assert.equal(outs[0].key.marker, 'key4', 'the free counter saleKeys named');
assert.equal(outs[0].poolWallet, pw);
assert.match(said['st-sats-1'], /on its way to a new key, posted by the relay in cdcdcdcdcd/);

// A tab left open through the pool's wait: the note turns ready on its own, and only the waiting notes are asked about.
{
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });   // jsdom reports a page nobody can see
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { intervals.push(fn); return 0; };
  let counted = false;
  const asked = [];
  const host2 = document.createElement('div');
  document.body.append(host2);
  const S2 = { ...S, poolClientFor: () => ({ relayInfo: async () => ({ address: 'bp1qrelay' }), exit: async (txid, vout) => { asked.push(`${txid.slice(0, 4)}:${vout}`); return { exists: counted }; } }) };
  mount(host2, { ...ctx, S: S2 });
  globalThis.setInterval = realSetInterval;
  await settle();
  const listBtn = () => [...host2.querySelectorAll('button.btn')][1];
  assert.match(host2.textContent, /2,500 TAC\s*waiting for the pool to count it/);
  assert.equal(listBtn().disabled, true, 'nothing to list yet');
  assert.equal(intervals.length, 1, 'one timer for the panel');
  asked.length = 0;
  await intervals[0](); await settle();
  assert.deepEqual(asked, ['eeee:1'], 'the waiting note is asked about, once');
  assert.match(host2.textContent, /waiting for the pool to count it/, 'still waiting while the pool has not counted it');
  counted = true;
  await intervals[0](); await settle();
  assert.match(host2.textContent, /2,500 TAC\s*ready to list/, 'ready with no reload');
  assert.equal(listBtn().disabled, false);
  asked.length = 0;
  await intervals[0](); await settle();
  assert.deepEqual(asked, [], 'a note that is ready is not asked about again');
}

// A read that fails says so, and a retry reads again: an empty panel would look like TAC that is gone.
{
  let calls = 0;
  const host3 = document.createElement('div');
  document.body.append(host3);
  const S3 = { ...S, saleKeys: async () => { calls++; if (calls === 1) throw new Error('explorer down'); return { keys: [{ ...saleKey, notes: [NOTE] }], free }; } };
  mount(host3, { ...ctx, S: S3 });
  await settle();
  assert.match(host3.textContent, /Could not read what you have taken out\. Nothing is lost/);
  assert.equal(host3.firstElementChild.textContent, 'Taken out for sale', 'a failed read leads the panel as well');
  const retry3 = [...host3.querySelectorAll('button.link')].find((b) => b.textContent === 'Retry');
  assert.ok(retry3 && (retry3.compareDocumentPosition(host3.querySelector('#sats-amt')) & 4), 'with its Retry before the form');
  assert.doesNotMatch(host3.textContent, /2,500 TAC/, 'no note is shown for a read that failed');
  [...host3.querySelectorAll('button.link')].find((b) => b.textContent === 'Retry').click();
  await settle();
  assert.equal(calls, 2, 'retry reads again');
  assert.doesNotMatch(host3.textContent, /Could not read/);
  assert.match(host3.textContent, /2,500 TAC\s*ready to list/);
}

// A take-out that went through stays said when the read that follows it fails.
{
  let calls = 0;
  const host4 = document.createElement('div');
  document.body.append(host4);
  // reads: at mount, before the take-out (it needs the next free key), then the one after it, which fails
  const S4 = { ...S, saleKeys: async () => { calls++; if (calls >= 3) throw new Error('explorer down'); return { keys: [], free: 5 }; } };
  const before = outs.length;
  mount(host4, { ...ctx, S: S4 });
  await settle();
  host4.querySelector('#sats-amt').value = '10';
  [...host4.querySelectorAll('button.btn')][0].click();
  await settle();
  assert.equal(outs.length, before + 1, 'the take-out went to the relay');
  assert.match(said['st-sats-1'], /on its way to a new key/, 'and is still said as done');
  assert.doesNotMatch(said['st-sats-1'], /^ERR/);
  assert.match(host4.textContent, /Could not read what you have taken out/, 'the failed read says so beside Step 2');
}

// What the panel tells the pool panel's balance line: the TAC at the sale keys once a read has finished, nothing before it, nothing
// after a read that failed.
{
  const reports = [];
  const h = document.createElement('div'); document.body.append(h);
  mount(h, { ...ctx, held: (s) => reports.push(s) });
  assert.equal(reports[0], null, 'nothing is claimed before the read has finished');
  await settle();
  assert.deepEqual(reports[reports.length - 1], { units: NOTE.value, count: 1, unread: 0 });

  const bad = [];
  const hb = document.createElement('div'); document.body.append(hb);
  mount(hb, { ...ctx, S: { ...S, saleKeys: async () => { throw new Error('explorer down'); } }, held: (s) => bad.push(s) });
  await settle();
  assert.ok(bad.length && bad.every((s) => s === null), 'a read that failed claims nothing');
}

// A read that finds nothing says so, but only once it has finished; an output it could not open is named with a retry, and is never
// "nothing".
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const reports = [];
  const h = document.createElement('div'); document.body.append(h);
  mount(h, { ...ctx, S: { ...S, saleKeys: async () => { await gate; return { keys: [], free: 0, unread: [] }; } }, held: (s) => reports.push(s) });
  await settle();
  assert.doesNotMatch(h.textContent, /Found no TAC/, 'not said while the read is under way');
  release(); await settle();
  assert.match(h.textContent, /Found no TAC at this wallet’s sale keys\./);
  assert.deepEqual(reports[reports.length - 1], { units: 0n, count: 0, unread: 0 });

  let calls = 0;
  const miss = { txid: 'ab'.repeat(32), vout: 0 };
  const hu = document.createElement('div'); document.body.append(hu);
  const S5 = { ...S, saleKeys: async () => { calls++; return calls === 1 ? { keys: [{ ...saleKey, notes: [] }], free: 0, unread: [miss] } : { keys: [{ ...saleKey, notes: [NOTE] }], free: 0, unread: [] }; } };
  mount(hu, { ...ctx, S: S5, held: (s) => reports.push(s) });
  await settle();
  assert.match(hu.textContent, /Could not read one output at your sale keys: abababab…:0\./);
  assert.doesNotMatch(hu.textContent, /Found no TAC/, 'an output it could not open is not "nothing"');
  assert.deepEqual(reports[reports.length - 1], { units: 0n, count: 0, unread: 1 });
  [...hu.querySelectorAll('button.link')].find((b) => b.textContent === 'Retry').click();
  await settle();
  assert.equal(calls, 2, 'retry reads again');
  assert.doesNotMatch(hu.textContent, /Could not read/);
  assert.match(hu.textContent, /2,500 TAC\s*ready to list/);
}

// Put back: a note the pool has counted goes back into the pool through shieldFromSaleKey, with the sale key that holds it and this
// wallet's pool, in the page's turn; then the sale keys are read again. A note still waiting for the pool offers nothing; a listed note
// says its listing ends with it.
{
  const shields = [];
  let turns = 0, reads = 0, gone = false;
  const S6 = { ...S,
    saleKeys: async () => { reads++; return { keys: [{ ...saleKey, notes: gone ? [] : [NOTE] }], free: 0, unread: [] }; },
    shieldFromSaleKey: async (t, o) => { shields.push({ t, ...o }); gone = true; return { revealTxid: 'fa'.repeat(32) }; },
  };
  const h = document.createElement('div'); document.body.append(h);
  mount(h, { ...ctx, S: S6, turn: (fn) => { turns++; return fn(); } });
  await settle();
  const back = [...h.querySelectorAll('button.link')].find((b) => b.textContent === 'Put back');
  assert.ok(back, 'a counted note offers Put back');
  back.click(); await settle();
  assert.equal(shields.length, 1);
  const o = shields[0];
  assert.equal(o.t, T);
  assert.equal(o.key.pub, salePub, 'with the sale key that holds it');
  assert.deepEqual([o.note.txid, o.note.vout, o.note.value], [NOTE.txid, NOTE.vout, NOTE.value]);
  assert.equal(o.poolWallet, pw, 'back to this wallet’s pool');
  assert.equal(o.asset, S.TAC_ASSET_MAINNET);
  assert.ok(turns >= 1, 'in the page’s turn');
  assert.match(said['st-sats-2'], /2,500 TAC put back in the pool in fafafafafa/);
  assert.ok(reads >= 2, 'the sale keys are read again');
  assert.doesNotMatch(h.textContent, /ready to list/, 'the note has left the list');
  assert.match(h.textContent, /Found no TAC at this wallet’s sale keys/);
}
{
  const h = document.createElement('div'); document.body.append(h);
  mount(h, { ...ctx, S: { ...S, poolClientFor: () => ({ relayInfo: async () => ({ address: 'bp1qrelay' }), exit: async () => ({ exists: false }) }) } });
  await settle();
  assert.match(h.textContent, /waiting for the pool to count it/);
  assert.ok(![...h.querySelectorAll('button.link')].some((b) => /put back/i.test(b.textContent)), 'nothing to put back before the pool counts it');
}
{
  const realFetch = globalThis.fetch;
  const live = { expired: false, asset_outpoint: { txid: NOTE.txid, vout: NOTE.vout }, min_price_sats: 420000, expiry: Math.floor(Date.now() / 1000) + 86400 };
  globalThis.fetch = async (url) => (String(url).includes('/preauth-sales') ? { ok: true, status: 200, json: async () => ({ count: 1, sales: [live] }) } : realFetch(url));
  const h = document.createElement('div'); document.body.append(h);
  mount(h, ctx);
  await settle();
  globalThis.fetch = realFetch;
  assert.match(h.textContent, /listed for 420,000 sats until/);
  assert.ok([...h.querySelectorAll('button.link')].some((b) => b.textContent === 'Cancel and put back'), 'a listed note says its listing ends with it');
}

console.log('tac-sats-panel: all checks passed');
process.exit(0);   // the panel keeps a timer for the page it lives in
