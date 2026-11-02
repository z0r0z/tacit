// The fast bridge page's logic (dapp/fast/ui.js) on a DOM, with the wallet, the key and the provider passed in: what it shows
// for each provider and key state, the amount's checks, the quote, the press, the bridges under way, and a key that locks.
//   node tests/fastbridge-ui.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountFast, fmtTac, parseTac } from '../dapp/fast/ui.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 200; i++) { if (f()) return; await tick(3); } throw new Error(`timed out: ${what}`); };

const TAC = 10n ** 8n;
const TERMS = { claimPub: '02' + 'ab'.repeat(32), minAmount: String(10n * TAC), maxAmount: String(1000n * TAC), feeBps: 30, flatFee: String(1n * TAC) };

function page() {
  const dom = new JSDOM('<!doctype html><body><section id="gate"></section></body>');
  return { dom, doc: dom.window.document, root: dom.window.document.getElementById('gate') };
}
function keyStub() {
  const fns = new Set();
  const k = { unlocked: false, key: null, onChange: (f) => { fns.add(f); return () => fns.delete(f); },
    open(pubHex = '03' + 'cd'.repeat(32)) { k.unlocked = true; k.key = { pubHex }; fns.forEach((f) => f()); }, lock() { k.unlocked = false; k.key = null; fns.forEach((f) => f()); } };
  return k;
}
// a session the way fast/wire.js gives one
function sessionStub({ balance = 12_345n * TAC, quoteOver = {}, startError = null } = {}) {
  const calls = { quotes: [], starts: [], runs: 0, stops: 0 };
  let recs = [];
  const fb = {
    quote: async (units) => { calls.quotes.push(units); const fee = (units * 30n) / 10000n + TAC; return { id: 'q' + calls.quotes.length, btcValue: units, evmAmount: units - fee, fee, validUntil: Math.floor(Date.now() / 1000) + 600, ...quoteOver }; },
    start: async (a) => { if (startError) throw startError; calls.starts.push(a); recs = [rec({ id: 'aa'.repeat(36), phase: 'built', title: 'Locking on Bitcoin', amount: String(a.quote.btcValue), receive: String(a.quote.evmAmount) })]; return {}; },
    records: async () => recs,
    run: ({ onChange }) => { calls.runs++; onChange(recs); return () => { calls.stops++; }; },
    recover: async () => [],
  };
  return { calls, setRecs: (r) => { recs = r; }, session: { fb, notes: async () => [{ txid: 'ee'.repeat(32), vout: 0, value: 546, amount: balance, blinding: 7n }], balance: async () => balance } };
}
const STEPS = ['Lock on Bitcoin', 'Lock in the pool', 'Claim', 'Done'];
const rec = (o) => ({ phase: 'broadcast', title: 'Waiting for Bitcoin', detail: 'The lock needs one confirmation, about ten minutes.', at: 0, steps: STEPS, ended: false, returned: false, amount: String(100n * TAC), receive: String(99n * TAC), created: 1, lockTxid: 'bb'.repeat(32), error: null, recovered: false, ...o });

function mount(over = {}) {
  const p = page(), key = over.key || keyStub(), st = over.session || sessionStub();
  const state = { signIns: 0, opens: 0, says: [] };
  const ui = mountFast({
    root: p.root, providers: over.providers ?? [{ name: 'Tacit', base: 'https://lp.example', claimPub: TERMS.claimPub }], keyS: key, quoteDelayMs: 1,
    signIn: over.signIn || (async () => { state.signIns++; key.open(); }),
    open: over.open || (async () => { state.opens++; return st.session; }),
    info: over.info || (async () => TERMS), say: (t) => state.says.push(t),
  });
  return { ...p, key, st, state, ui, $: (id) => p.doc.getElementById(id) };
}
const text = (e) => { const out = [], w = e.ownerDocument.createTreeWalker(e, 4); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) out.push(n.nodeValue.trim()); return out.join(' '); };

test('amounts: shown with thousands and up to four places, read back exactly, and refused when they are not amounts', () => {
  assert.equal(fmtTac(0n), '0'); assert.equal(fmtTac(5n * TAC), '5'); assert.equal(fmtTac(123_456_789_012n), '1,234.5678');
  assert.equal(fmtTac(1n), '0.00000001', 'a small amount shows as it is'); assert.equal(fmtTac(150_000_000n), '1.5');
  assert.equal(parseTac('12.5'), 1_250_000_000n); assert.equal(parseTac('1,000'), 100_000_000_000n); assert.equal(parseTac('.5'), 50_000_000n); assert.equal(parseTac('5.'), 500_000_000n);
  for (const bad of ['', '0', '0.0', 'abc', '1.123456789', '-1', '1e5', '1 2']) assert.equal(parseTac(bad), null, JSON.stringify(bad));
});

test('no provider listed, or none answering, or one with another key than the page pinned: the page says none is online', async () => {
  for (const over of [{ providers: [] }, { info: async () => { throw new Error('down'); } }, { info: async () => ({ ...TERMS, claimPub: '02' + 'ff'.repeat(32) }) }]) {
    const m = mount(over);
    await until(() => /No provider is online/.test(text(m.$('fx-lp'))), 'the offline line');
    assert.ok(m.$('fx-lp').querySelector('a[href="/"]'), 'a way to the regular bridge');
    assert.equal(m.$('fx-go').hidden, true);
    assert.equal(m.$('fx-form').hidden, true);
    m.ui.destroy();
  }
  const second = mount({ providers: [{ name: 'Down', base: 'https://a.example' }, { name: 'Up', base: 'https://b.example' }], info: async (p) => { if (p.name === 'Down') throw new Error('x'); return TERMS; } });
  await until(() => /Up/.test(text(second.$('fx-lp'))), 'the second provider');
});

test('a provider\'s terms are shown, and its name is text, not markup', async () => {
  const m = mount({ providers: [{ name: '<img src=x onerror=alert(1)>', base: 'https://lp.example' }] });
  await until(() => /Fee/.test(text(m.$('fx-lp'))), 'the terms');
  assert.equal(m.$('fx-lp').querySelector('img'), null);
  assert.match(text(m.$('fx-lp')), /<img src=x/);
  assert.match(text(m.$('fx-lp')), /Fee 0\.30% \+ 1 TAC/);
  assert.match(text(m.$('fx-lp')), /Amount 10 to 1,000 TAC/);
  assert.equal(m.$('fx-go').textContent, 'Open wallet');
  assert.equal(m.$('fx-form').hidden, true, 'no form before a key');
});

test('Open wallet: the key sheet, then the TAC on Bitcoin and an amount field', async () => {
  const m = mount();
  await until(() => !m.$('fx-go').hidden, 'the button');
  m.$('fx-go').click();
  await until(() => !m.$('fx-form').hidden && /12,345 TAC on Bitcoin/.test(text(m.$('fx-bal'))), 'the balance');
  assert.deepEqual([m.state.signIns, m.state.opens, m.st.calls.runs], [1, 1, 1]);
  assert.equal(m.$('fx-go').textContent, 'Bridge');
  assert.equal(m.$('fx-go').disabled, true, 'nothing typed yet');
  assert.equal(m.$('fx-max').hidden, false);
  // a sheet that is closed without a key leaves the page as it was
  const n = mount({ signIn: async () => { throw Object.assign(new Error('Cancelled.'), { unlockCancelled: true }); } });
  await until(() => !n.$('fx-go').hidden, 'the button');
  n.$('fx-go').click(); await tick(30);
  assert.equal(n.$('fx-st').textContent, ''); assert.equal(n.$('fx-form').hidden, true);
});

test('the amount: checked against the provider\'s limits and the balance, quoted when it is fine, the fee shown', async () => {
  const m = mount({ session: sessionStub({ balance: 500n * TAC }) });
  await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click();
  await until(() => !m.$('fx-form').hidden, 'the form');
  const type = (v) => { m.$('fx-amt').value = v; m.$('fx-amt').dispatchEvent(new m.dom.window.Event('input')); };
  type('5'); await tick(10);
  assert.match(m.$('fx-st').textContent, /The least is 10 TAC/); assert.equal(m.$('fx-go').disabled, true); assert.equal(m.$('fx-recv').hidden, true);
  type('600'); await tick(10);
  assert.match(m.$('fx-st').textContent, /more than your TAC on Bitcoin/); assert.equal(m.$('fx-go').disabled, true);
  type('2000'); await tick(10);
  assert.match(m.$('fx-st').textContent, /The most is 1,000 TAC/);
  type('abc'); await tick(10);
  assert.match(m.$('fx-st').textContent, /not an amount/);
  assert.deepEqual(m.st.calls.quotes, [], 'nothing was asked of the provider for these');
  type('100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  assert.deepEqual(m.st.calls.quotes, [100n * TAC]);
  assert.match(text(m.$('fx-recv')), /You pay 100 TAC/); assert.match(text(m.$('fx-recv')), /You receive, private 98\.7 TAC/); assert.match(text(m.$('fx-recv')), /Fee 1\.3 TAC 1\.30%/);
  assert.equal(m.$('fx-go').disabled, false); assert.equal(m.$('fx-st').textContent, '');
  type('101'); assert.equal(m.$('fx-recv').hidden, true, 'a changed amount drops the old quote'); assert.equal(m.$('fx-go').disabled, true);
  await until(() => !m.$('fx-recv').hidden, 'the new quote');
  m.$('fx-max').click(); await until(() => m.st.calls.quotes.at(-1) === 500n * TAC, 'the quote for the whole balance');
  assert.equal(m.$('fx-amt').value, '500');
});

test('a quote the provider\'s client refuses is said, in the page\'s words', async () => {
  const st = sessionStub();
  st.session.fb.quote = async () => { throw new Error('the quote\'s fee is above the limit this page accepts'); };
  const m = mount({ session: st });
  await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form');
  m.$('fx-amt').value = '50'; m.$('fx-amt').dispatchEvent(new m.dom.window.Event('input'));
  await until(() => /above what this page accepts/.test(m.$('fx-st').textContent), 'the refusal');
  assert.equal(m.$('fx-go').disabled, true);
  assert.equal(m.$('fx-st').className, 'status err');
});

test('Bridge: the quote and the key\'s notes go to the client, the bridge appears with its steps, the amount is cleared', async () => {
  const m = mount();
  await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form');
  m.$('fx-amt').value = '100'; m.$('fx-amt').dispatchEvent(new m.dom.window.Event('input'));
  await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click();
  await until(() => m.st.calls.starts.length === 1, 'the start');
  const a = m.st.calls.starts[0];
  assert.deepEqual([a.quote.btcValue, a.notes.length, a.notes[0].amount], [100n * TAC, 1, 12_345n * TAC]);
  await until(() => !m.$('fx-list').hidden, 'the list');
  assert.match(text(m.$('fx-list')), /Locking on Bitcoin/); assert.match(text(m.$('fx-list')), /100 TAC → 98\.7 TAC/);
  assert.equal(m.$('fx-list').querySelectorAll('.fx-steps li').length, 4);
  assert.equal(m.$('fx-list').querySelectorAll('.fx-steps li.at').length, 1);
  assert.equal(m.$('fx-amt').value, ''); assert.match(m.$('fx-st').textContent, /Started/);
  assert.equal(m.$('fx-go').disabled, true);
});

test('the bridges under way: where each is, finished ones in full, a return said as a return, a link to the lock', async () => {
  const m = mount();
  let onChange; m.st.session.fb.run = (o) => { onChange = o.onChange; return () => {}; };
  await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form');
  const want = [
    rec({ id: '01'.repeat(36), phase: 'offered', title: 'Waiting for the pool lock', at: 1 }),
    rec({ id: '02'.repeat(36), phase: 'done', title: 'Done', at: 3, ended: true }),
    rec({ id: '03'.repeat(36), phase: 'refund-wait', title: 'Returning to Bitcoin', detail: 'The lock returns to your Bitcoin address when its timelock ends.', at: 0, returned: true }),
    rec({ id: '04'.repeat(36), phase: 'refunded', title: 'Returned', at: 3, ended: true, returned: true, lockTxid: null }),
  ];
  m.st.setRecs(want);
  onChange(want); await tick(5);
  const rows = [...m.$('fx-list').querySelectorAll('.fx-rec')];
  assert.equal(rows.length, 4);
  const lit = (r) => [...r.querySelectorAll('.fx-steps li')].map((li) => li.className || '-').join(' ');
  assert.equal(lit(rows[0]), 'on at - -');
  assert.equal(lit(rows[1]), 'on on on on', 'a finished bridge has every step lit');
  assert.equal(rows[2].querySelector('.fx-steps'), null, 'a return is not a step of the bridge');
  assert.equal(rows[3].querySelector('.fx-steps'), null);
  assert.ok(rows[0].querySelector('a[href="https://mempool.space/tx/' + 'bb'.repeat(32) + '"]'));
  assert.equal(rows[3].querySelector('a'), null);
  assert.match(text(rows[2]), /Returning to Bitcoin/);
});

test('errors from the start are said plainly: a note already in a bridge, notes that do not cover, a failure with no words', async () => {
  for (const [err, re] of [[new Error('fastbridge: this note is already part of a swap'), /already in a bridge/], [new Error('these notes do not cover the amount'), /does not cover that amount/], [new Error('the quote expired'), /ran out/], [new Error(''), /Something went wrong/], [new Error('x'.repeat(300)), /…$/]]) {
    const m = mount({ session: sessionStub({ startError: err }) });
    await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form');
    m.$('fx-amt').value = '50'; m.$('fx-amt').dispatchEvent(new m.dom.window.Event('input'));
    await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click();
    await until(() => m.$('fx-st').className === 'status err', 'the error');
    assert.match(m.$('fx-st').textContent, re);
    assert.equal(m.$('fx-go').disabled, false, 'the press can be tried again');
    m.ui.destroy();
  }
});

test('a key that locks or changes drops the session: the form closes, the timer stops, the amount is gone', async () => {
  const m = mount();
  await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form');
  m.$('fx-amt').value = '50'; m.$('fx-amt').dispatchEvent(new m.dom.window.Event('input')); await until(() => !m.$('fx-recv').hidden, 'a quote');
  m.key.lock(); await tick(5);
  assert.equal(m.$('fx-form').hidden, true); assert.equal(m.$('fx-go').textContent, 'Open wallet'); assert.match(m.$('fx-st').textContent, /locked/);
  assert.equal(m.st.calls.stops, 1); assert.equal(m.$('fx-amt').value, '');
  assert.equal(m.$('fx-go').hidden, false); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form after a new key');
  assert.equal(m.state.opens, 2);
  m.key.open('03' + 'ee'.repeat(32)); await tick(10);   // another account: the old session is dropped and a new one is not opened until the press
  assert.equal(m.st.calls.stops, 2);
  assert.equal(m.$('fx-form').hidden, true);
  m.ui.lock('Your wallet switched accounts.'); assert.match(m.$('fx-st').textContent, /switched accounts/);
});

test('the wallet failing to open is said and the page can be pressed again', async () => {
  let n = 0;
  const m = mount({ open: async () => { n++; if (n === 1) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.'); return sessionStub().session; } });
  await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click();
  await until(() => m.$('fx-st').className === 'status err', 'the error');
  assert.match(m.$('fx-st').textContent, /not the one the wallet reads/);
  assert.equal(m.$('fx-form').hidden, true);
  m.$('fx-go').click();
  await until(() => !m.$('fx-form').hidden, 'the form on the second press');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} fast page checks passed`);
process.exit(process.exitCode || 0);
