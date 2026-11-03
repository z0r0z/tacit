// The fast bridge page's logic (dapp/fast/ui.js) on a DOM, with the wallet, the key and the providers passed in: what it shows for
// each provider and key state, the amount's checks, the best of several quotes, the press, the bridges under way, and a key that locks.
//   node tests/fastbridge-ui.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountFast, fmtTac, parseTac } from '../dapp/fast/ui.js';
import { termsOf } from '../dapp/fastbridge-client.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 200; i++) { if (f()) return; await tick(3); } throw new Error(`timed out: ${what}`); };

const TAC = 10n ** 8n;
const TERMS = { claimPub: '02' + 'ab'.repeat(32), minAmount: String(10n * TAC), maxAmount: String(1000n * TAC), feeBps: 30, flatFee: String(1n * TAC) };
const provider = (name, over = {}) => ({ id: name, name, ref: { kind: 'http', base: `https://${name}.example`, claimPub: name }, terms: termsOf({ ...TERMS, ...over }) });

function page() {
  const dom = new JSDOM('<!doctype html><body><section id="gate"></section><section id="fx-tiles" hidden></section></body>');
  return { dom, doc: dom.window.document, root: dom.window.document.getElementById('gate') };
}
function keyStub() {
  const fns = new Set();
  const k = { unlocked: false, key: null, onChange: (f) => { fns.add(f); return () => fns.delete(f); },
    open(pubHex = '03' + 'cd'.repeat(32)) { k.unlocked = true; k.key = { pubHex }; fns.forEach((f) => f()); }, lock() { k.unlocked = false; k.key = null; fns.forEach((f) => f()); } };
  return k;
}
// a session the way fast/wire.js openFast gives one: every provider asked at once, the best payout first
function sessionStub({ balance = 12_345n * TAC, startError = null, failFor = new Set() } = {}) {
  const calls = { asked: [], starts: [], runs: 0, stops: 0 };
  let recs = [];
  const sess = {
    balance: async () => balance,
    quoteAll: async (providers, units) => {
      calls.asked.push({ names: providers.map((p) => p.name), units });
      const quotes = [], failed = [];
      for (const p of providers) {
        if (failFor.has(p.name)) { failed.push({ provider: p, error: new Error('the provider did not answer in time') }); continue; }
        const fee = (units * BigInt(p.terms.feeBps)) / 10000n + p.terms.flatFee;
        quotes.push({ provider: p, quote: { id: 'q' + p.name, btcValue: units, evmAmount: units - fee, fee, validUntil: Math.floor(Date.now() / 1000) + 600 } });
      }
      quotes.sort((a, b) => (a.quote.evmAmount > b.quote.evmAmount ? -1 : 1));
      return { quotes, failed };
    },
    start: async ({ quotes }) => {
      if (startError) throw startError;
      calls.starts.push({ quotes });
      const q = quotes[0].quote;
      recs = [rec({ id: 'aa'.repeat(36), phase: 'built', title: 'Locking on Bitcoin', amount: String(q.btcValue), receive: String(q.evmAmount) })];
      return { rec: {}, provider: quotes[0].provider };
    },
    records: async () => recs,
    run: ({ onChange }) => { calls.runs++; onChange(recs); return () => { calls.stops++; }; },
    recover: async () => [],
  };
  return { calls, setRecs: (r) => { recs = r; }, session: sess };
}
const STEPS = ['Lock on Bitcoin', 'Lock in the pool', 'Claim', 'Done'];
const rec = (o) => ({ phase: 'broadcast', title: 'Waiting for Bitcoin', detail: 'The lock needs one confirmation, about ten minutes.', at: 0, steps: STEPS, ended: false, returned: false, amount: String(100n * TAC), receive: String(99n * TAC), created: 1, lockTxid: 'bb'.repeat(32), error: null, recovered: false, ...o });

function mount(over = {}) {
  const p = page(), key = over.key || keyStub(), st = over.session || sessionStub();
  const state = { signIns: 0, opens: 0, says: [], discovers: 0 };
  const ui = mountFast({
    root: p.root, keyS: key, quoteDelayMs: 1, refreshMs: over.refreshMs ?? 30000,
    discover: over.discover || (async () => { state.discovers++; return over.providers ?? [provider('Tacit')]; }),
    signIn: over.signIn || (async () => { state.signIns++; key.open(); }),
    open: over.open || (async () => { state.opens++; return st.session; }), say: (t) => state.says.push(t),
  });
  return { ...p, key, st, state, ui, $: (id) => p.doc.getElementById(id) };
}
const text = (e) => { const out = [], w = e.ownerDocument.createTreeWalker(e, 4); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) out.push(n.nodeValue.trim()); return out.join(' '); };
const signIn = async (m) => { await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form'); };
const typeIn = (m, v) => { m.$('fx-amt').value = v; m.$('fx-amt').dispatchEvent(new m.dom.window.Event('input')); };

test('amounts: shown with thousands and up to four places, read back exactly, and refused when they are not amounts', () => {
  assert.equal(fmtTac(0n), '0'); assert.equal(fmtTac(5n * TAC), '5'); assert.equal(fmtTac(123_456_789_012n), '1,234.5678');
  assert.equal(fmtTac(1n), '0.00000001', 'a small amount shows as it is'); assert.equal(fmtTac(150_000_000n), '1.5');
  assert.equal(parseTac('12.5'), 1_250_000_000n); assert.equal(parseTac('1,000'), 100_000_000_000n); assert.equal(parseTac('.5'), 50_000_000n); assert.equal(parseTac('5.'), 500_000_000n);
  for (const bad of ['', '0', '0.0', 'abc', '1.123456789', '-1', '1e5', '1 2']) assert.equal(parseTac(bad), null, JSON.stringify(bad));
});

test('a key whose own offer is the only one is told it is the provider online, not that nobody is', async () => {
  const pub = '03' + 'cd'.repeat(32);
  const m = mount({ providers: [{ id: pub, name: 'Provider cdcdcd', ref: { kind: 'http', base: 'x' }, terms: { minAmount: 10n * 10n ** 8n, maxAmount: 20n * 10n ** 8n, feeBps: 30, flatFee: 10n ** 8n, available: null } }] });
  m.key.open(pub);
  await until(() => /You are the provider online/.test(text(m.$('fx-lp'))), 'the line for the provider');
  assert.doesNotMatch(text(m.$('fx-lp')), /No provider/);
  m.ui.destroy();
});

test('no provider listed, or none answering: the page says none is online and offers the regular bridge', async () => {
  for (const over of [{ providers: [] }, { discover: async () => { throw new Error('down'); } }]) {
    const m = mount(over);
    await until(() => /No provider is online/.test(text(m.$('fx-lp'))), 'the offline line');
    assert.ok(m.$('fx-lp').querySelector('a[href="/"]'), 'a way to the regular bridge');
    assert.equal(m.$('fx-go').hidden, false, 'with nobody providing, the wallet still opens: it is how the first provider starts');
    assert.equal(m.$('fx-go').textContent, 'Open wallet');
    assert.equal(m.$('fx-form').hidden, true);
    m.ui.destroy();
  }
});

test('a provider\'s terms are shown, and its name is text, not markup', async () => {
  const m = mount({ providers: [provider('<img src=x onerror=alert(1)>')] });
  await until(() => /Fee/.test(text(m.$('fx-lp'))), 'the terms');
  assert.equal(m.$('fx-lp').querySelector('img'), null);
  assert.match(text(m.$('fx-lp')), /<img src=x/);
  assert.match(text(m.$('fx-lp')), /Fee 0\.30% \+ 1 TAC/);
  assert.match(text(m.$('fx-lp')), /Amount 10 to 1,000 TAC/);
  assert.equal(m.$('fx-go').textContent, 'Open wallet');
  assert.equal(m.$('fx-form').hidden, true, 'no form before a key');
});

test('several providers: how many, the lowest fee, the widest range, and what the best of them can take now', async () => {
  const m = mount({ providers: [provider('Slow', { feeBps: 50 }), provider('Cheap', { feeBps: 20, minAmount: String(50n * TAC), maxAmount: String(5000n * TAC), available: String(800n * TAC) }), provider('Small', { feeBps: 40, maxAmount: String(200n * TAC) })] });
  await until(() => /online/.test(text(m.$('fx-lp'))), 'the summary');
  const t = text(m.$('fx-lp'));
  assert.match(t, /Providers 3 online/); assert.match(t, /Fee from 0\.20% \+ 1 TAC/); assert.match(t, /Amount 10 to 5,000 TAC/);
  assert.match(t, /Available now 1,000 TAC/, 'the most any one of them can take now, when it is under the most they take');
});

test('every provider online is a tile, the key\'s own first and marked, with its fee and what it takes', async () => {
  const mine = '03' + 'cd'.repeat(32);
  const m = mount({ providers: [provider('Other', { feeBps: 40 }), { ...provider('Mine', { feeBps: 1 }), id: mine }] });
  await until(() => !m.$('fx-tiles').hidden, 'the tiles');
  assert.equal(m.$('fx-tiles').querySelectorAll('.lp-tile').length, 2);
  assert.equal(m.$('fx-tiles').querySelector('.mine'), null, 'nothing is marked before a key');
  await signIn(m);
  await until(() => !!m.$('fx-tiles').querySelector('.mine'), 'the key\'s own marked');
  const first = m.$('fx-tiles').querySelector('.lp-tile');
  assert.ok(first.classList.contains('mine')); assert.match(text(first), /^Mine You Fee 0\.01% \+ 1 TAC Takes 10 to/);
  m.ui.destroy();
});

test('the key\'s own provider is not one to bridge with: it is left out of the summary and of the quotes', async () => {
  const mine = '03' + 'cd'.repeat(32);                                         // the pub keyStub opens
  const m = mount({ providers: [{ ...provider('Mine', { feeBps: 1 }), id: mine }, provider('Other', { feeBps: 40 })] });
  await until(() => /Providers 2 online/.test(text(m.$('fx-lp'))), 'both listed before a key');
  await signIn(m);
  await until(() => /Provider Other/.test(text(m.$('fx-lp'))), 'the summary without the key\'s own');
  assert.match(text(m.$('fx-lp')), /Fee 0\.40%/);
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  assert.deepEqual(m.st.calls.asked[0].names, ['Other']);
});

test('Open wallet: the key sheet, then the TAC on Bitcoin and an amount field', async () => {
  const m = mount();
  await signIn(m);
  await until(() => /12,345 TAC on Bitcoin/.test(text(m.$('fx-bal'))), 'the balance');
  assert.deepEqual([m.state.signIns, m.state.opens, m.st.calls.runs], [1, 1, 1]);
  assert.equal(m.$('fx-go').textContent, 'Bridge');
  assert.equal(m.$('fx-go').disabled, true, 'nothing typed yet');
  assert.equal(m.$('fx-max').hidden, false);
  const n = mount({ signIn: async () => { throw Object.assign(new Error('Cancelled.'), { unlockCancelled: true }); } });
  await until(() => !n.$('fx-go').hidden, 'the button');
  n.$('fx-go').click(); await tick(30);
  assert.equal(n.$('fx-st').textContent, ''); assert.equal(n.$('fx-form').hidden, true);
});

test('the amount: checked against the providers\' limits and the balance, quoted when it is fine, the fee shown', async () => {
  const m = mount({ session: sessionStub({ balance: 500n * TAC }) });
  await signIn(m);
  typeIn(m, '5'); await tick(10);
  assert.match(m.$('fx-st').textContent, /The least is 10 TAC/); assert.equal(m.$('fx-go').disabled, true); assert.equal(m.$('fx-recv').hidden, true);
  typeIn(m, '600'); await tick(10);
  assert.match(m.$('fx-st').textContent, /more than your TAC on Bitcoin/); assert.equal(m.$('fx-go').disabled, true);
  typeIn(m, '2000'); await tick(10);
  assert.match(m.$('fx-st').textContent, /The most is 1,000 TAC/);
  typeIn(m, 'abc'); await tick(10);
  assert.match(m.$('fx-st').textContent, /not an amount/);
  assert.deepEqual(m.st.calls.asked, [], 'nothing was asked of a provider for these');
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  assert.deepEqual(m.st.calls.asked, [{ names: ['Tacit'], units: 100n * TAC }]);
  assert.match(text(m.$('fx-recv')), /You pay 100 TAC/); assert.match(text(m.$('fx-recv')), /You receive, private 98\.7 TAC/); assert.match(text(m.$('fx-recv')), /Fee 1\.3 TAC 1\.30%/);
  assert.doesNotMatch(text(m.$('fx-recv')), /Provider/, 'with one provider the receipt does not name it');
  assert.equal(m.$('fx-go').disabled, false); assert.equal(m.$('fx-st').textContent, '');
  typeIn(m, '101'); assert.equal(m.$('fx-recv').hidden, true, 'a changed amount drops the old quote'); assert.equal(m.$('fx-go').disabled, true);
  await until(() => !m.$('fx-recv').hidden, 'the new quote');
  m.$('fx-max').click(); await until(() => m.st.calls.asked.at(-1).units === 500n * TAC, 'the quote for the whole balance');
  assert.equal(m.$('fx-amt').value, '500');
});

test('the best of several quotes is shown with its provider, every provider that can take the amount is asked, and all the quotes go to the press', async () => {
  const ps = [provider('Slow', { feeBps: 50 }), provider('Cheap', { feeBps: 20 }), provider('Small', { feeBps: 10, maxAmount: String(80n * TAC) }), provider('Down', { feeBps: 5 })];
  const m = mount({ providers: ps, session: sessionStub({ failFor: new Set(['Down']) }) });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  assert.deepEqual(m.st.calls.asked[0].names.sort(), ['Cheap', 'Down', 'Slow'], 'a provider that does not take 100 is not asked');
  assert.match(text(m.$('fx-recv')), /Provider Cheap/); assert.match(text(m.$('fx-recv')), /You receive, private 98\.8 TAC/);
  await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click();
  await until(() => m.st.calls.starts.length === 1, 'the start');
  assert.deepEqual(m.st.calls.starts[0].quotes.map((x) => x.provider.name), ['Cheap', 'Slow'], 'the best first, then the next to try');
});

test('providers that can take the amount only in pieces, or not at all: said, not quoted', async () => {
  const m = mount({ providers: [provider('Low', { minAmount: String(10n * TAC), maxAmount: String(50n * TAC) }), provider('High', { minAmount: String(100n * TAC), maxAmount: String(200n * TAC) })] });
  await signIn(m);
  typeIn(m, '75'); await until(() => /No provider can take that amount right now/.test(m.$('fx-st').textContent), 'no provider takes 75');
  assert.deepEqual(m.st.calls.asked, []);
  const n = mount({ session: sessionStub({ failFor: new Set(['Tacit']) }) });
  await signIn(n);
  typeIn(n, '50'); await until(() => n.$('fx-st').className === 'status err', 'the error');
  assert.match(n.$('fx-st').textContent, /did not answer in time/);
  assert.equal(n.$('fx-go').disabled, true);
});

test('Bridge: the quotes go to the client, the bridge appears with its steps, the amount is cleared', async () => {
  const m = mount();
  await signIn(m);
  typeIn(m, '100');
  await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click();
  await until(() => m.st.calls.starts.length === 1, 'the start');
  assert.equal(m.st.calls.starts[0].quotes[0].quote.btcValue, 100n * TAC);
  await until(() => !m.$('fx-list').hidden, 'the list');
  assert.match(text(m.$('fx-list')), /Locking on Bitcoin/); assert.match(text(m.$('fx-list')), /100 TAC → 98\.7 TAC/);
  assert.equal(m.$('fx-list').querySelectorAll('.fx-steps li').length, 4);
  assert.equal(m.$('fx-list').querySelectorAll('.fx-steps li.at').length, 1);
  assert.equal(m.$('fx-amt').value, ''); assert.match(m.$('fx-st').textContent, /Started/);
  assert.equal(m.$('fx-go').disabled, true);
});

test('a quote near its end is asked for again, from the providers that gave one, before the press goes out', async () => {
  const st = sessionStub();
  const quoteAll = st.session.quoteAll;
  st.session.quoteAll = async (ps, u) => { const r = await quoteAll(ps, u); if (st.calls.asked.length === 1) for (const x of r.quotes) x.quote.validUntil = Math.floor(Date.now() / 1000) + 30; return r; };
  const m = mount({ session: st });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click();
  await until(() => st.calls.starts.length === 1, 'the start');
  assert.equal(st.calls.asked.length, 2, 'asked again');
  assert.ok(Number(st.calls.starts[0].quotes[0].quote.validUntil) > Math.floor(Date.now() / 1000) + 300, 'the fresh quote is the one sent');
});

test('the bridges under way: where each is, finished ones in full, a return said as a return, a link to the lock', async () => {
  const m = mount();
  let onChange; m.st.session.run = (o) => { onChange = o.onChange; return () => {}; };
  await signIn(m);
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
  for (const [err, re] of [[new Error('fastbridge: this note is already part of a swap'), /already in a bridge/], [new Error('these notes do not cover the amount'), /does not cover that amount/], [new Error('the quote expired'), /ran out/], [new Error(''), /Something went wrong/], [new Error('x'.repeat(300)), /…$/],
    [new Error('the provider cannot hold that amount: the provider cannot take that amount right now'), /cannot take that amount right now. Try a smaller amount/]]) {
    const m = mount({ session: sessionStub({ startError: err }) });
    await signIn(m);
    typeIn(m, '50');
    await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click();
    await until(() => m.$('fx-st').className === 'status err', 'the error');
    assert.match(m.$('fx-st').textContent, re);
    assert.equal(m.$('fx-go').disabled, false, 'the press can be tried again');
    m.ui.destroy();
  }
});

test('a key that locks or changes drops the session: the form closes, the timer stops, the amount is gone', async () => {
  const m = mount();
  await signIn(m);
  typeIn(m, '50'); await until(() => !m.$('fx-recv').hidden, 'a quote');
  m.key.lock(); await tick(5);
  assert.equal(m.$('fx-form').hidden, true); assert.equal(m.$('fx-go').textContent, 'Open wallet'); assert.match(m.$('fx-st').textContent, /locked/);
  assert.equal(m.st.calls.stops, 1); assert.equal(m.$('fx-amt').value, '');
  assert.equal(m.$('fx-go').hidden, false); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form after a new key');
  assert.equal(m.state.opens, 2);
  m.key.open('03' + 'ee'.repeat(32)); await tick(10);
  assert.equal(m.st.calls.stops, 2);
  assert.equal(m.$('fx-form').hidden, true);
  m.ui.lock('Your wallet switched accounts.'); assert.match(m.$('fx-st').textContent, /switched accounts/);
});

test('what the providers can take now: the amount is capped by it, and the providers are read again as an amount is typed', async () => {
  let avail = String(300n * TAC);
  const m = mount({ discover: async () => [provider('Tacit', { available: avail })], refreshMs: 1, session: sessionStub({ balance: 900n * TAC }) });
  await until(() => /Available now/.test(text(m.$('fx-lp'))), 'the available row');
  assert.match(text(m.$('fx-lp')), /Available now 300 TAC/);
  await signIn(m);
  typeIn(m, '400'); await tick(10);
  assert.match(m.$('fx-st').textContent, /The provider can take up to 300 TAC right now/); assert.equal(m.$('fx-go').disabled, true);
  m.$('fx-max').click(); await until(() => m.$('fx-amt').value === '300', 'Max at what the provider can take');
  avail = String(50n * TAC); await tick(5);
  typeIn(m, '100'); await until(() => /up to 50 TAC/.test(m.$('fx-st').textContent), 'the refreshed limit');
  avail = '0'; await tick(5); typeIn(m, '20'); await until(() => /cannot take more right now/.test(m.$('fx-st').textContent), 'none left');
  const plain = mount();
  await until(() => /Fee/.test(text(plain.$('fx-lp'))), 'the terms');
  assert.doesNotMatch(text(plain.$('fx-lp')), /Available now/);
});

test('the providers are read again when a provider goes: the ones left stand, and none left says so', async () => {
  let list = [provider('A'), provider('B', { feeBps: 10 })];
  const m = mount({ discover: async () => list, refreshMs: 1 });
  await until(() => /Providers 2 online/.test(text(m.$('fx-lp'))), 'two providers');
  list = [provider('A')];
  m.$('fx-go').click(); await tick(5); await until(() => !m.$('fx-form').hidden, 'the form');
  typeIn(m, '20'); await until(() => /Provider Tacit|Provider A|Provider\s*A/.test(text(m.$('fx-lp'))) || /Provider A/.test(text(m.$('fx-lp'))), 'one provider now');
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
