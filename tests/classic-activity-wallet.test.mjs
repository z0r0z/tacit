// The classic page's Activity list is kept for the whole browser, Holdings for the wallet that is open.
//
// Each entry now carries the address of the wallet that was open when it was recorded; a row made with another wallet
// says so, and an empty Holdings says which wallet bought when the log lists purchases by another one. Older instant buys
// have no address: the buyer is read once from the buy's first output (the dust output a take pays to its own key).
//
// Run: `node tests/classic-activity-wallet.test.mjs`

import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM(`<!doctype html><html><body>
  <div class="tabs subtabs" data-group="wallet"><button class="tab" data-tab="wallet">Overview</button><button class="tab" data-tab="holdings">Holdings</button></div>
  <details class="wallet-manage"><summary>Manage wallet</summary></details>
  <div id="holdings-status"></div><div id="holdings-list"></div>
  <div id="activity-status"></div><button id="btn-activity-clear"></button><div id="activity-list"></div>
</body></html>`, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

const txs = new Map();         // txid -> esplora tx
const txCalls = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
  let m = /\/tx\/([0-9a-f]{64})$/.exec(url);
  if (m) { txCalls.push(m[1]); return txs.has(m[1]) ? json(txs.get(m[1])) : new Response('not found', { status: 404 }); }
  if (/\/address\/[a-z0-9]+$/.test(url)) return json({ chain_stats: { tx_count: 1 }, mempool_stats: { tx_count: 0 } });
  if (/\/blocks\/tip\/height$/.test(url)) return new Response('900000', { status: 200 });
  throw new Error('offline: ' + url);
};

const { secp, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
const T = await import('../dapp/tacit.js');
const { wallet } = T;
T.setTxReadSpacingMs(0);

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await tick(10); return !!f(); };

const open = (n) => {
  const priv = new Uint8Array(32); priv[31] = n;
  wallet.priv = priv; wallet.pub = secp.getPublicKey(priv, true); wallet.mode = null;
  return { pub: wallet.pub, addr: wallet.address() };
};
const log = () => JSON.parse(localStorage.getItem(T.activityKey()) || '[]');
const setLog = (a) => localStorage.setItem(T.activityKey(), JSON.stringify(a));
const hex = (i) => i.toString(16).padStart(64, '0');
const ASSET = 'ab'.repeat(32);
const buy = (txid, source, extra = {}) => ({
  kind: 'swap-buy', ticker: 'TAC', amount: 610000000000n, decimals: 8, assetId: ASSET, txid,
  extra: { price_sats: 1555500, source, ...extra },
});
const legacy = (txid, source) => ({ ...buy(txid, source), amount: '610000000000', ts: Date.now() - 40 * 86400_000 });
const dust0 = (pub) => ({ vout: [{ value: 546, scriptpubkey: '0014' + bytesToHex(T.hash160(pub)) }, { value: 1555500, scriptpubkey: '0014' + '11'.repeat(20) }] });
const text = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ');
const tag = (a) => a.slice(0, 10) + '…' + a.slice(-6);
const noScan = () => new Map();
T._testSetScanHoldingsOverride(noScan);

console.log('A new entry carries the wallet that was open');
const A = open(7);
T.recordActivity(buy(hex(1), 'preauth-take-batch'));
ok('the entry has the buyer\'s address', log()[0].addr === A.addr);
wallet.pub = null; wallet.priv = null;
T.recordActivity({ kind: 'etch', ticker: 'X', amount: 1n, decimals: 0, assetId: ASSET, txid: hex(9) });
ok('no wallet open: no address is invented', !('addr' in log()[0]));

console.log('\nA row made with another wallet says so, the open wallet\'s rows do not');
T.renderActivity();
ok('wallet A open: no wallet note on its own purchase', !/not the wallet open now/.test(text('#activity-list')));
const B = open(8);
T.renderActivity();
ok('wallet B open: the purchase names wallet A', text('#activity-list').includes(`made with wallet ${tag(A.addr)}, not the wallet open now`));
ok('the entry with no wallet recorded gets no note', (text('#activity-list').match(/not the wallet open now/g) || []).length === 1);

console.log('\nEmpty Holdings names the wallet that bought');
await T.renderHoldings();
let h = text('#holdings-list');
ok('headline is about the open wallet', /No tacit assets in the wallet that is open on mainnet/.test(h));
ok('it lists wallet A and the wallet open now', h.includes(tag(A.addr)) && h.includes(tag(B.addr)));
ok('it points at Manage wallet', !!document.querySelector('#holdings-list [data-act="note-manage-wallet"]'));
ok('it no longer says to buy a first token', !/buy your first token/.test(h));
let overviewClicks = 0;
document.querySelector('.subtabs .tab').addEventListener('click', () => overviewClicks++);
document.querySelector('#holdings-list [data-act="note-manage-wallet"]').onclick();
ok('the button opens the Overview tab, where Manage wallet is', overviewClicks === 1);
ok('and opens Manage wallet', await until(() => document.querySelector('details.wallet-manage').open === true));
document.querySelector('.subtabs').remove();
await T.renderHoldings();
document.querySelector('#holdings-list [data-act="note-manage-wallet"]').onclick();
ok('with no Overview button it falls back to the tab link', location.hash === '#tab=wallet');

console.log('\nNo purchases in the log: the first-time text is unchanged');
setLog([]);
await T.renderHoldings();
h = text('#holdings-list');
ok('first-time headline and prompt', /No tacit assets on mainnet yet\./.test(h) && /buy your first token/.test(h));
ok('no note', !document.getElementById('holdings-activity-note')?.textContent.trim());

console.log('\nOlder buys (no address): the buyer is read from the first output, once');
setLog([legacy(hex(2), 'preauth-take-batch'), legacy(hex(2), 'preauth-take-batch'), legacy(hex(3), 'atomic-take'), legacy(hex(4), 'preauth-take'), legacy(hex(5), 'preauth-take')]);
txs.set(hex(2), dust0(A.pub));
txs.set(hex(4), { vout: [{ value: 1000, scriptpubkey: '0014' + bytesToHex(T.hash160(A.pub)) }] });   // not a dust output: not a take's own output
txs.set(hex(3), dust0(A.pub));
txCalls.length = 0;
await T.renderHoldings();
h = text('#holdings-list');
ok('before the lookup: it says a different wallet may have made them', /If a different wallet made those/.test(h));
ok('the lookup lands and the note names wallet A', await until(() => text('#holdings-list').includes(tag(A.addr))));
ok('both entries of the batch got wallet A', log().filter((e) => e.txid === hex(2)).every((e) => e.addr === A.addr));
ok('an atomic take is not resolved (its first output is the maker\'s layout)', !log().find((e) => e.txid === hex(3)).addr && !txCalls.includes(hex(3)));
ok('a first output that is not the take\'s dust output is not resolved', !log().find((e) => e.txid === hex(4)).addr);
ok('a buy the chain does not know stays untagged', !log().find((e) => e.txid === hex(5)).addr);
ok('one read per txid', txCalls.filter((t) => t === hex(2)).length === 1);
ok('the Activity rows name wallet A too', await until(() => text('#activity-list').includes(`made with wallet ${tag(A.addr)}`)));
txCalls.length = 0;
await T._resolveActivityBuyers();
ok('a second pass reads nothing again', txCalls.length === 0);

console.log('\nThe wallet that bought is open but the scan found nothing');
open(7);
setLog([{ ...buy(hex(6), 'preauth-take'), amount: '5', addr: A.addr, ts: Date.now() }]);
await T.renderHoldings();
h = text('#holdings-list');
ok('it says the scan found no assets for this wallet', /made with this wallet, but the scan found no assets/.test(h));
ok('it offers a Rescan', !!document.querySelector('#holdings-list [data-act="note-rescan"]'));
ok('it does not send the reader to another wallet', !document.querySelector('#holdings-list [data-act="note-manage-wallet"]'));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
