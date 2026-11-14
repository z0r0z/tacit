// TAC's Bitcoin pool in TAC's home (dapp/tac/pool.js) in a DOM, under a page's key: its four tabs; Send pays through secret.js's payPrivately
// with the pool wallet of the page's key and the relay's fee capped at a quarter over the one shown, and stops above the balance with the fee
// before anything; Max leaves the fee; a claim link keeps its secret on this device before it pays, then lists the link; a claim someone sent
// is swept into the key's pool address; Shield and Withdraw tell the page its TAC on Bitcoin moved; a key change lets go of what was read.
// secret.js, claim.js, sats.js and tacit.js are stubs.
//   node tests/tac-pool-panel.test.mjs

import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div><div id="claim"></div></body></html>', { url: 'https://tacit.finance/' });
for (const k of ['window', 'document', 'localStorage', 'Event', 'MutationObserver', 'navigator', 'location']) {
  try { globalThis[k] = dom.window[k]; } catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
}
globalThis.confirm = () => true;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 30; i++) await tick(); };
globalThis.fetch = async (u) => (String(u).includes('/assets/') ? { ok: true, json: async () => ({ mark_price: { unit: 200 } }) } : { ok: false, json: async () => null });

const { makeTacPool, parseAmount, CLAIM_HASH } = await import('../dapp/tac/pool.js');

const ASSET = 'f0'.repeat(32), TAC = 100000000n;
const pw = { addressString: 'bp1qmine', network: 'mainnet' };
const notes = [{ nf: '01', value: String(30n * TAC), asset: ASSET }, { nf: '02', value: String(20n * TAC), asset: ASSET }];
const calls = { pay: [], exit: [], shield: [], create: [], sweep: [], hist: [] };
let histFail = false;
const Y = new Date().getUTCFullYear(), noon = (y, m, d) => Date.UTC(y, m, d, 12) / 1000;
const HIST = [
  { txid: '1a'.repeat(32), height: 973509, time: noon(Y, 0, 15), kind: 'for-sale', delta: -98707564851n, to: 'bc1qzwnfncdgxs0hx0rmsuhd0jhgat37rfvzttg50z' },
  { txid: '61'.repeat(32), height: 973499, time: noon(Y, 0, 14), kind: 'shielded', delta: 98700000000n },
  { txid: '93'.repeat(32), height: 973494, time: noon(Y, 0, 13), kind: 'withdrawn-home', delta: -98700000000n, to: 'bc1qsedwallet' },
  { txid: '0e'.repeat(32), height: 950000, time: noon(Y - 1, 5, 1), kind: 'received', delta: 2000000000n },
];
const S = {
  TAC_ASSET_MAINNET: ASSET, pool: { id: 'pool' },
  poolWalletFor: (priv) => { assert.ok(priv instanceof Uint8Array, 'the pool wallet is derived from the key’s bytes'); return pw; },
  pendingView: (ns) => ({ live: ns.filter((n) => !n.spent) }),
  poolNotes: async () => notes,
  combinePlan: () => null,
  poolClientFor: () => ({ relayInfo: async () => ({ address: 'bp1qrelay', fundAddress: 'bc1qrelayfund', fees: { ['0x' + ASSET]: String(2n * TAC) } }), allNotes: async () => [], walletNotes: async () => notes }),
  poolHistory: async (t, w, ns, o) => { calls.hist.push({ w, n: ns.length, o }); if (histFail) throw new Error('explorer 429'); return HIST; },
  payPrivately: async (t, o) => { calls.pay.push(o); return { revealTxid: 'aa'.repeat(32), relayed: true }; },
  exitToWallet: async (t, o) => { calls.exit.push(o); return { revealTxid: 'bb'.repeat(32) }; },
  shieldNote: async (t, o) => { calls.shield.push(o); return { revealTxid: 'cc'.repeat(32), poolNote: { value: o.note.amount } }; },
  recoverExitOpenings: async () => 0,
};
const C = {
  claimPoolWallet: () => ({ addressString: 'bp1qclaim' }),
  claimUrl: (o, p) => `${o}/#tacclaim=${p}`,
  encodeClaim: () => 'p1.x',
  decodeClaim: (x) => { assert.match(x, /^p1\./); return { secret32: new Uint8Array(32).fill(5), txid: 'dd'.repeat(32), network: 'mainnet', pinned: false }; },
  readClaim: async () => ({ total: 5n * TAC, seen: 1, indexed: true }),
  createClaim: async (t, o) => { calls.create.push(o); o.keep({ secret32: new Uint8Array(32).fill(9), pinned: !!o.pin, network: 'mainnet' }); return { revealTxid: 'ee'.repeat(32), link: 'https://tacit.finance/#tacclaim=p1.made' }; },
  sweepClaim: async (t, o) => { calls.sweep.push(o); return { revealTxid: 'ff'.repeat(32), relayed: true }; },
};
const pubNote = { utxo: { txid: '12'.repeat(32), vout: 1 }, amount: 7n * TAC, blinding: 5n };
const T = { wallet: { priv: new Uint8Array(32).fill(1) }, scanHoldings: async () => new Map([[ASSET, { utxos: [pubNote], ghosts: [] }]]), scanAssetForStealthReceipts: async () => ({ discovered: [] }), invalidateHoldingsCache() {} };
let key = { pubHex: '02' + 'ab'.repeat(32) }, changed = [], views = 0;
const tp = makeTacPool({
  key: () => key, priv: () => new Uint8Array(32).fill(1),
  ensureKey: async () => { if (!key) throw Object.assign(new Error('Open your Tacit wallet first.'), { said: true, quiet: true }); },
  withKey: async (fn) => fn(T), tacitAddress: () => 'tacit1example', toast: () => {},
  changed: (what) => changed.push(what || 'pool'), viewChanged: () => views++, usd: () => '',
  mods: { secret: S, claim: C, sats: { mount: (box) => { box.textContent = 'sats panel'; } } },
});
const host = document.getElementById('host');
const $ = (id) => host.querySelector('#' + id);
const st = (id) => ($(id) || document.getElementById(id))?.textContent || '';
const click = async (id) => { ($(id) || document.getElementById(id)).click(); await settle(); };
const type = (id, v) => { const i = $(id); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };

assert.equal(parseAmount('1,5', 8), 150000000n);
assert.ok(CLAIM_HASH.test('#tacclaim=p1.mainnet.x.y.0') && CLAIM_HASH.test('#send&tacclaim=p1.x') && !CLAIM_HASH.test('#claim=v1.x'), 'a claim link in a fragment is told apart');

tp.mount(host);
await settle();
assert.deepEqual([...host.querySelectorAll('[data-tp]')].map((b) => b.textContent), ['Shield', 'Send', 'Withdraw', 'Receive']);
assert.match(st('tp-bal'), /50 TAC shielded, in 2 notes/, 'the shielded balance is read for the key');
assert.deepEqual(tp.totals(), { shielded: 50n * TAC, public: 7n * TAC, forSale: null });
{
  // History, read only when asked for: each transaction, when, what it was and what it did to the balance, with its link
  assert.equal($('tp-hist').hidden, true, 'no history until asked for');
  assert.equal(calls.hist.length, 0, 'and nothing is read for it');
  await click('tp-hist-go');
  assert.equal(calls.hist.length, 1);
  assert.equal(calls.hist[0].w, pw); assert.equal(calls.hist[0].n, notes.length, 'read from all of the wallet’s notes');
  assert.deepEqual(calls.hist[0].o, { relayFund: 'bc1qrelayfund' }, 'with the relay’s funding address, to tell its fee output apart');
  const rows = [...$('tp-hist').querySelectorAll('.kv')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(rows.length, 4);
  assert.match(rows[0], /^Jan 15 · Taken out for sale, to bc1qzwnfncdg…ttg50z\s*−987\.07564851 TAC\s*1a1a1a1a1a…$/);
  assert.match(rows[1], /^Jan 14 · Shielded\s*\+987 TAC\s*6161616161…$/);
  assert.match(rows[2], /^Jan 13 · Withdrawn to your Bitcoin address\s*−987 TAC\s*9393939393…$/);
  assert.equal(rows[3].startsWith(`Jun 1, ${Y - 1} · Received`), true, `a past year is named: ${rows[3]}`);
  assert.equal($('tp-hist-go').textContent, 'Hide history');
  await click('tp-hist-go');
  assert.equal($('tp-hist').hidden, true, 'pressed again, it closes');
  await click('tp-hist-go');
  assert.equal(calls.hist.length, 1, 'opened again, the history already read is shown');
  await click('tp-hist-go');
  // a read that fails says so and can be tried again
  histFail = true;
  tp.keyChanged(); await settle();
  await click('tp-hist-go');
  assert.match(st('tp-hist'), /Could not read your history in the pool\. Retry/);
  histFail = false;
  $('tp-hist').querySelector('button').click(); await settle();
  assert.equal($('tp-hist').querySelectorAll('.kv').length, 4, 'tried again, it reads');
  await click('tp-hist-go');
}
assert.match($('tp-shield-pick').textContent, /^7 TAC/, 'the key’s TAC on Bitcoin is offered to shield');
assert.equal($('tp-shield-go').textContent, 'Shield', 'with a key the button shields');
assert.equal($('tp-shield-pick').closest('.amt').hidden, false, 'with a key the list of notes to shield shows');
assert.equal(host.querySelector('.tp-bal').hidden, false, 'with a key the balance line shows');

// Send: above the balance with the relay's fee, nothing is asked of the relay
await click('tp-t-send');
assert.equal(views, 1, 'a tab picked by hand is told to the page');
assert.deepEqual(tp.view(), ['send']);
type('tp-send-to', 'tacit1someone');
type('tp-send-amt', '49');
await click('tp-send-go');
assert.match(st('tp-st-send'), /More than your shielded balance with the relay’s 2 TAC fee/);
assert.equal(calls.pay.length, 0);
// Max leaves the fee
await click('tp-send-max');
assert.equal($('tp-send-amt').value, '48');
type('tp-send-amt', '10');
await click('tp-send-go');
assert.equal(calls.pay.length, 1);
assert.equal(calls.pay[0].poolWallet, pw, 'paid from the key’s pool wallet');
assert.equal(calls.pay[0].to, 'tacit1someone');
assert.equal(calls.pay[0].amount, 10n * TAC);
assert.equal(calls.pay[0].maxFee, (2n * TAC * 5n) / 4n, 'a fee up to a quarter over the one shown goes through');
assert.match(st('tp-st-send'), /Sent 10 TAC in aaaaaaaaaa…\. The relay posted it/);

// A claim link: its secret is kept on this device before the payment, then listed with its link
type('tp-claim-amt', '5');
await click('tp-claim-go');
assert.equal(calls.create.length, 1);
const kept = JSON.parse(localStorage.getItem('tacit-tac-claim-links-v1'));
assert.equal(kept.length, 1);
assert.equal(kept[0].link, 'https://tacit.finance/#tacclaim=p1.made');
assert.equal(kept[0].amount, String(5n * TAC));
assert.equal($('tp-links').hidden, false, 'Links made here shows it');
assert.match(st('tp-st-claim-make'), /5 TAC is under this link/);

// Withdraw to Bitcoin, and Shield: each tells the page its TAC on Bitcoin moved
await click('tp-t-withdraw');
type('tp-exit-amt', '3');
changed = [];
await click('tp-exit-go');
assert.equal(calls.exit.length, 1);
assert.equal(calls.exit[0].amount, 3n * TAC);
assert.ok(changed.includes('bitcoin'));
await click('tp-wt-sats');
assert.equal($('tp-sats').textContent, 'sats panel', 'To sats draws the sale panel');
assert.deepEqual(tp.view(), ['withdraw', 'sats']);
await click('tp-t-shield');
changed = [];
await click('tp-shield-go');
assert.equal(calls.shield.length, 1);
assert.equal(calls.shield[0].note.txid, pubNote.utxo.txid);
assert.equal(calls.shield[0].note.amount, String(7n * TAC));
assert.equal(calls.shield[0].note.blinding, '5'.padStart(64, '0'));
assert.ok(changed.includes('bitcoin'));

// Receive: the page's Tacit address and the key's pool address
await click('tp-t-receive');
assert.equal($('tp-recv-tacit').value, 'tacit1example');
assert.equal($('tp-recv-pool').value, 'bp1qmine');

// A claim someone sent: read, then swept into this key's pool address
const box = document.getElementById('claim');
await tp.claim(box, 'p1.mainnet.secret.txid.0');
await settle();
assert.match(box.textContent, /Waiting for you\s*5 TAC/);
const claimBtn = box.querySelector('button.btn');
assert.equal(claimBtn.disabled, false);
claimBtn.click(); await settle();
assert.equal(calls.sweep.length, 1);
assert.equal(calls.sweep[0].toAddress, 'bp1qmine', 'claimed into the key’s own pool address');
assert.match(box.textContent, /Claimed into your shielded TAC on Bitcoin/);
tp.stopClaim();

// No key: a press asks for one and does nothing
key = null;
let walletEvents = 0;
window.addEventListener('tac:wallet', () => walletEvents++);
tp.keyChanged();
await settle();
assert.equal(walletEvents, 1, 'the To sats panel hears of the key change');
assert.deepEqual(tp.totals(), { shielded: null, public: null, forSale: null }, 'what was read for the last key is let go of');
await click('tp-t-send');
type('tp-send-to', 'tacit1someone'); type('tp-send-amt', '1');
await click('tp-send-go');
assert.equal(st('tp-st-send'), 'Open your Tacit wallet first.');
assert.equal(calls.pay.length, 1, 'nothing paid without a key');
assert.match(st('tp-bal'), /Open your Tacit wallet/);
// with no key the card's head already says to sign in: the balance line and the empty list of notes wait, and the button opens the wallet
assert.equal(host.querySelector('.tp-bal').hidden, true, 'no balance line without a key');
assert.equal($('tp-shield-pick').closest('.amt').hidden, true, 'no list of notes without a key');
assert.equal($('tp-shield-pick').closest('.amt').previousElementSibling.hidden, true, 'nor its label');
assert.equal($('tp-shield-go').textContent, 'Sign in', 'the button says what the press does');

// the pool as anyone sees it, for TAC: another asset's notes are not its set, the last note's block is the latest one's, and a pool that stopped says so
{
  let stat = { leafCount: 5, height: 100, tip: 103, proofSystem: 'halo2-kzg-bn254', verifierEnabled: true, halted: null, lastError: null };
  const feed = [{ txid: 'a1', height: 90, asset: '0x' + ASSET }, { txid: 'a1', height: 90, asset: '0x' + ASSET }, { txid: 'b2', height: 95, asset: '0x' + ASSET }, { txid: 'c3', height: 99, asset: '0x' + '11'.repeat(32) }];
  const S2 = { ...S, poolClientFor: () => ({ status: async () => stat, allNotes: async () => feed }) };
  const t2 = makeTacPool({ key: () => null, priv: () => null, ensureKey: async () => {}, withKey: async (fn) => fn(T), tacitAddress: () => null, toast: () => {}, changed: () => {},
    viewChanged: () => {}, usd: () => '', mods: { secret: S2, claim: C, sats: { mount: () => {} } } });
  assert.deepEqual(await t2.stats(), { set: 3, height: 100, tip: 103, well: true, last: 95, proof: 'Halo2·KZG', txs: 2 });
  stat = { ...stat, halted: 'a block was not available' };
  assert.equal((await t2.stats()).well, false, 'a halted pool is not reading well');
}

// TAC taken out for a sale waits at a sale key, which the balance does not count: To sats' read gives it a line under the balance.
// The read starts when the page opens the panel with a key (mount runs for every visitor and starts nothing), and after a sign-in
// with the panel open.
{
  let k = { pubHex: '02' + 'cd'.repeat(32) }, mounts = 0, report = null, told = 0;
  const t3 = makeTacPool({ key: () => k, priv: () => new Uint8Array(32).fill(1), ensureKey: async () => {}, withKey: async (fn) => fn(T), tacitAddress: () => 'tacit1example',
    toast: () => {}, changed: () => { told++; }, viewChanged: () => {}, usd: () => '', mods: { secret: S, claim: C, sats: { mount: (box, c) => { mounts++; report = c.held; } } } });
  const h3 = document.createElement('div'); document.body.append(h3);
  const row = () => h3.querySelector('#tp-held-row'), line = () => h3.querySelector('#tp-held').textContent;
  t3.mount(h3); await settle();
  assert.equal(mounts, 0, 'mounting the panel reads no sale keys');
  assert.equal(row().hidden, true);
  t3.show('shield'); await settle();
  assert.equal(mounts, 1, 'the page opening the panel with a key starts the read');
  assert.equal(t3.totals().forSale, null, 'no amount for sale before the read reports');
  told = 0;
  report({ units: 97207564851n, count: 1, unread: 0 });
  assert.equal(row().hidden, false);
  assert.match(line(), /^972\.07564851 TAC taken out for sale$/);
  assert.equal(t3.totals().forSale, 97207564851n, 'the page’s list of where the TAC is gets the amount');
  assert.equal(told, 1, 'and is told once');
  report({ units: 97207564851n, count: 1, unread: 0 });
  assert.equal(told, 1, 'a redraw with the same amount tells it nothing');
  report({ units: 0n, count: 0, unread: 1 });
  assert.equal(line(), '1 output at a sale key not read', 'an output the read could not open is said, not left out');
  report({ units: 0n, count: 0, unread: 0 });
  assert.equal(row().hidden, true, 'nothing at the sale keys: no line');
  report(null);
  assert.equal(row().hidden, true, 'no line while a read runs or after one failed');
  report({ units: 5n * TAC, count: 1, unread: 0 });
  h3.querySelector('#tp-held-go').click(); await settle();
  assert.deepEqual(t3.view(), ['withdraw', 'sats'], 'the line leads to To sats');
  k = null; t3.keyChanged(); await settle();
  assert.equal(row().hidden, true, 'a key change lets go of the line');

  let k4 = null, mounts4 = 0;
  const t4 = makeTacPool({ key: () => k4, priv: () => new Uint8Array(32).fill(1), ensureKey: async () => {}, withKey: async (fn) => fn(T), tacitAddress: () => 'tacit1example',
    toast: () => {}, changed: () => {}, viewChanged: () => {}, usd: () => '', mods: { secret: S, claim: C, sats: { mount: () => { mounts4++; } } } });
  const h4 = document.createElement('div'); document.body.append(h4);
  t4.mount(h4); await settle();
  t4.show('withdraw'); await settle();
  assert.equal(mounts4, 0, 'opened with no key: nothing is read');
  k4 = { pubHex: '02' + 'ef'.repeat(32) }; t4.keyChanged(); await settle();
  assert.equal(mounts4, 1, 'signing in with the panel open reads the sale keys');
}
console.log('ok tac pool panel');
