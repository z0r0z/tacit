// The fast bridge page's logic (dapp/fast/ui.js) on a DOM, with the wallet, the key and the providers passed in: what it shows for
// each provider and key state, the amount's checks, the best of several quotes, the press, the bridges under way, and a key that locks.
//   node tests/fastbridge-ui.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountFast, fmtTac, parseTac } from '../dapp/fast/ui.js';
import { termsOf } from '../dapp/fastbridge-client.js';
import { pairId } from '../dapp/fast/fmt.js';

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
    root: p.root, keyS: key, quoteDelayMs: 1, refreshMs: over.refreshMs ?? 30000, wants: over.wants ?? null, notify: over.notify, pinned: over.pinned,
    discover: over.discover || (async () => { state.discovers++; return over.providers ?? [provider('Tacit')]; }),
    signIn: over.signIn || (async () => { state.signIns++; key.open(); }),
    open: over.open || (async () => { state.opens++; return st.session; }), say: (t) => state.says.push(t),
  });
  return { ...p, key, st, state, ui, $: (id) => p.doc.getElementById(id) };
}
const text = (e) => { const out = [], w = e.ownerDocument.createTreeWalker(e, 4); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) out.push(n.nodeValue.trim()); return out.join(' '); };
const signIn = async (m) => { await until(() => !m.$('fx-go').hidden, 'the button'); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form'); };
// the first press says what the bridge does and what happens if the provider stops; the same press again goes
const press = async (m) => { await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click(); await until(() => m.$('fx-go').textContent === 'Press again to bridge', 'the confirmation'); m.$('fx-go').click(); };
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

test('no provider listed, or none answering: the page says none is online and that one can be waited for', async () => {
  for (const over of [{ providers: [] }, { discover: async () => { throw new Error('down'); } }]) {
    const m = mount(over);
    await until(() => /No provider is online/.test(text(m.$('fx-lp'))), 'the offline line');
    assert.match(text(m.$('fx-lp')), /Open your wallet to wait for one, or to provide/);
    assert.equal(m.$('fx-go').hidden, false, 'with nobody providing, the wallet still opens: it is how the first provider starts');
    assert.equal(m.$('fx-go').textContent, 'Sign in');
    assert.equal(m.$('fx-form').hidden, true);
    m.ui.destroy();
  }
});

test('waiting for a provider: an amount nobody takes is waited for, kept for the key, told once when a provider can take it, and dropped by a bridge', async () => {
  const kept = new Map(), told = [];
  const wants = {
    asks: 0, ask: async () => { wants.asks++; },
    kept: (pub) => kept.get(pub) || null,
    start: async (pub, amount) => { kept.set(pub, { amount, at: 1, until: 2 }); return kept.get(pub); },
    stop: async (pub) => { kept.delete(pub); },
  };
  let online = [];
  const m = mount({ wants, notify: (t) => told.push(t), refreshMs: 20, discover: async () => online });
  await until(() => /No provider is online/.test(text(m.$('fx-lp'))), 'the offline line');
  await signIn(m);
  assert.match(text(m.$('fx-lp')), /Enter an amount to wait for one, or provide below/);
  typeIn(m, '1000');
  await until(() => m.$('fx-go').textContent === 'Wait for a provider', 'the wait button');
  assert.equal(m.$('fx-go').disabled, false);
  typeIn(m, '20000');
  await until(() => m.$('fx-go').textContent === 'Bridge' && m.$('fx-go').disabled, 'more than is held is not waited for');
  typeIn(m, '1000');
  await until(() => m.$('fx-go').textContent === 'Wait for a provider', 'the wait button again');
  m.$('fx-go').click();
  const pub = m.key.key.pubHex;
  await until(() => kept.has(pub), 'the want kept');
  assert.equal(kept.get(pub).amount, 1000n * TAC);
  assert.equal(wants.asks, 1, 'notifications are asked for with the press');
  await until(() => !m.$('fx-wait').hidden && /Waiting for a provider for 1,000 TAC/.test(text(m.$('fx-wait'))), 'the waiting line');
  assert.equal(told.length, 0, 'nothing told while nobody can take it');
  online = [provider('Tacit')];
  await until(() => told.length === 1, 'told once a provider can take it');
  assert.match(told[0], /A provider can take your 1,000 TAC now/);
  await until(() => m.$('fx-go').textContent === 'Bridge' && !m.$('fx-go').disabled, 'the quote for it');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(told.length, 1, 'told once, not on every look');
  await press(m);
  await until(() => m.st.calls.starts.length === 1 && !kept.has(pub), 'the bridge starts and the want is dropped');
  m.ui.destroy();
});

test('a want kept from an earlier visit is shown, and Stop waiting takes it down', async () => {
  const pub = '03' + 'cd'.repeat(32), kept = new Map([[pub, { amount: 500n * TAC, at: 1, until: 2 }]]);
  const wants = { kept: (p) => kept.get(p) || null, start: async () => null, stop: async (p) => { kept.delete(p); } };
  const m = mount({ wants, discover: async () => [] });
  await signIn(m);
  await until(() => !m.$('fx-wait').hidden, 'the waiting line');
  assert.match(text(m.$('fx-wait')), /Waiting for a provider for 500 TAC/);
  assert.equal(m.$('fx-go').hidden, true, 'nothing to press while it waits and nothing is typed');
  m.$('fx-unwait').click();
  await until(() => m.$('fx-wait').hidden && !kept.has(pub), 'taken down');
  m.ui.destroy();
});

test('a provider\'s terms are shown, and its name is text, not markup', async () => {
  const m = mount({ providers: [provider('<img src=x onerror=alert(1)>')] });
  await until(() => /fee/.test(text(m.$('fx-lp'))), 'the terms');
  assert.equal(m.$('fx-lp').querySelector('img'), null);
  assert.match(text(m.$('fx-lp')), /<img src=x/);
  assert.match(text(m.$('fx-lp')), /0\.30% \+ 1 TAC fee/);
  assert.match(text(m.$('fx-lp')), /10 to 1,000 TAC/);
  assert.equal(m.$('fx-go').textContent, 'Sign in');
  assert.equal(m.$('fx-form').hidden, true, 'no form before a key');
});

test('several providers: how many, the lowest fee, the widest range, and what the best of them can take now', async () => {
  const m = mount({ providers: [provider('Slow', { feeBps: 50 }), provider('Cheap', { feeBps: 20, minAmount: String(50n * TAC), maxAmount: String(5000n * TAC), available: String(800n * TAC) }), provider('Small', { feeBps: 40, maxAmount: String(200n * TAC) })] });
  await until(() => /online/.test(text(m.$('fx-lp'))), 'the summary');
  const t = text(m.$('fx-lp'));
  assert.match(t, /3 providers online/); assert.match(t, /cheapest 0\.20% \+ 1 TAC fee/);
  assert.match(t, /10 to 1,000 TAC now/, 'the most any one of them can take now, when it is under the most they take');
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
  assert.ok(first.classList.contains('mine')); assert.match(text(first), /^Mine \S+ You Fee 0\.01% \+ 1 TAC Takes 10 to/);
  m.ui.destroy();
});

test('a provider that cannot take even its least is full, not a range that ends below where it starts', async () => {
  const tileOf = (m, name) => [...m.$('fx-tiles').querySelectorAll('.lp-tile')].find((t) => t.querySelector('.lp-top b').textContent === name);
  for (const available of ['0', String(5n * TAC)]) {
    const m = mount({ providers: [provider('Empty', { available }), provider('Other', { feeBps: 50 })] });
    await until(() => !m.$('fx-tiles').hidden, 'the tile');
    assert.match(text(tileOf(m, 'Empty')), /Takes full right now/, `available ${available}`);
    assert.doesNotMatch(text(m.$('fx-tiles')), /to (0|5) TAC/);
    // the summary's range is the one the providers with room take: not the full one's least
    assert.match(text(m.$('fx-lp')), /10 to 1,000 TAC/); assert.doesNotMatch(text(m.$('fx-lp')), /to (0|5) TAC/);
  }
  const m = mount({ providers: [provider('Some', { available: String(300n * TAC) }), provider('Other', { feeBps: 50 })] });
  await until(() => !m.$('fx-tiles').hidden, 'the tile');
  assert.match(text(tileOf(m, 'Some')), /Takes 10 to 300 TAC/, 'a provider with room says its range');
  // a lone provider is the summary line already: no tile repeats it
  const one = mount({ providers: [provider('Alone')] });
  await until(() => /Alone/.test(text(one.$('fx-lp'))), 'the summary');
  assert.equal(one.$('fx-tiles').hidden, true);
});

test('a full provider\'s least is not the summary\'s: the range is what the providers with room take, and the lowest fee among them', async () => {
  const m = mount({ providers: [provider('Full', { feeBps: 5, minAmount: String(5n * TAC), available: String(2n * TAC) }), provider('Room', { feeBps: 40, minAmount: String(50n * TAC), available: String(500n * TAC) })] });
  await until(() => /online/.test(text(m.$('fx-lp'))), 'the summary');
  const t = text(m.$('fx-lp'));
  assert.match(t, /2 providers online/); assert.match(t, /1 with room.*0\.40%/, 'the fee of the one that can take a bridge'); assert.doesNotMatch(t, /cheapest/, 'one with room is not the cheapest of any'); assert.match(t, /50 to 500 TAC now/);
  assert.doesNotMatch(t, /5 to 2 TAC|5 to 500/);
});

test('every provider full: Max is what the key holds, to wait with, not nothing', async () => {
  const wants = { kept: () => null, start: async () => null, stop: async () => {} };
  const m = mount({ wants, providers: [provider('Empty', { available: '0' })], session: sessionStub({ balance: 42n * TAC }) });
  await signIn(m);
  m.$('fx-max').click(); await tick(5);
  assert.equal(m.$('fx-amt').value, '42');
  assert.equal(m.$('fx-go').textContent, 'Wait for a provider');
  m.ui.destroy();
});

test('providers gone: one empty read keeps the providers read (a board may not have answered), two in a row say none is online', async () => {
  let list = [provider('A')];
  const m = mount({ discover: async () => list, refreshMs: 1 });
  await until(() => /^A\b/.test(text(m.$('fx-lp'))), 'the provider');
  await signIn(m);
  list = [];
  typeIn(m, '20'); await tick(10);
  assert.match(text(m.$('fx-lp')), /^A\b/, 'one empty read: the provider stands');
  typeIn(m, '21'); await until(() => /No provider is online/.test(text(m.$('fx-lp'))), 'none online after a second empty read');
  m.ui.destroy();
});

test('the key\'s own provider is not one to bridge with: it is left out of the summary and of the quotes', async () => {
  const mine = '03' + 'cd'.repeat(32);                                         // the pub keyStub opens
  const m = mount({ providers: [{ ...provider('Mine', { feeBps: 1 }), id: mine }, provider('Other', { feeBps: 40 })] });
  await until(() => /2 providers online/.test(text(m.$('fx-lp'))), 'both listed before a key');
  await signIn(m);
  await until(() => /Other/.test(text(m.$('fx-lp'))), 'the summary without the key\'s own');
  assert.match(text(m.$('fx-lp')), /0\.40%/);
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  assert.deepEqual(m.st.calls.asked[0].names, ['Other']);
});

test('Sign in: the key sheet, then the TAC on Bitcoin and an amount field', async () => {
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

test('before a key: the amount can be typed, the cheapest provider with room is the estimate, and the amount is quoted once signed in', async () => {
  const m = mount({ providers: [provider('Full', { feeBps: 10, flatFee: '0', available: '0' }), provider('Dear', { feeBps: 300, flatFee: String(10n * TAC) }), provider('Mid', { feeBps: 150, flatFee: String(2n * TAC) })] });
  await until(() => /providers online/.test(text(m.$('fx-lp'))), 'the summary');
  const t = text(m.$('fx-lp'));
  assert.match(t, /3 providers online/); assert.match(t, /2 with room/); assert.match(t, /cheapest 1\.50% \+ 2 TAC fee/, 'the cheapest of the ones with room, not the full one');
  assert.equal(m.$('fx-pre').hidden, false, 'the amount comes first'); assert.equal(m.$('fx-form').hidden, true); assert.equal(m.$('fx-go').textContent, 'Sign in');
  m.$('fx-pre-amt').value = '100'; m.$('fx-pre-amt').dispatchEvent(new m.dom.window.Event('input'));
  await until(() => !m.$('fx-pre-out').hidden, 'the estimate');
  assert.equal(m.$('fx-pre-big').textContent, '96.5', '100 less 1.5 and 2 TAC');
  assert.match(text(m.$('fx-pre-recv')), /Fee 3\.5 TAC/); assert.match(text(m.$('fx-pre-recv')), /Mid/); assert.doesNotMatch(text(m.$('fx-pre-recv')), /Full/);
  assert.equal(m.$('fx-go').textContent, 'Sign in to bridge');
  assert.deepEqual(m.st.calls.asked, [], 'nothing is asked of a provider before a key');
  m.$('fx-pre-amt').value = '5'; m.$('fx-pre-amt').dispatchEvent(new m.dom.window.Event('input')); await tick(2);
  assert.equal(m.$('fx-pre-out').hidden, true); assert.match(m.$('fx-pre-st').textContent, /least is 10 TAC/);
  m.$('fx-pre-amt').value = '100'; m.$('fx-pre-amt').dispatchEvent(new m.dom.window.Event('input')); await tick(2);
  await signIn(m);
  assert.equal(m.$('fx-pre').hidden, true);
  await until(() => m.st.calls.asked.length > 0, 'the quote');
  assert.equal(m.$('fx-amt').value, '100', 'the amount typed before the key is the form\'s');
  assert.equal(m.st.calls.asked[0].units, 100n * TAC);
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
  assert.equal(m.$('fx-out').hidden, false); assert.equal(m.$('fx-big').textContent, '98.7'); assert.match(text(m.$('fx-out')), /You receive, private/); assert.match(text(m.$('fx-recv')), /Fee 1\.3 TAC 1\.30%/);
  assert.match(text(m.$('fx-recv')), /Time about 15 minutes 1 Bitcoin confirmation, then a pool settle/);
  assert.doesNotMatch(text(m.$('fx-recv')), /Provider/, 'with one provider the receipt does not name it');
  assert.equal(m.$('fx-go').disabled, false); assert.equal(m.$('fx-st').textContent, '');
  typeIn(m, '101'); assert.equal(m.$('fx-recv').hidden, true, 'a changed amount drops the old quote'); assert.equal(m.$('fx-out').hidden, true); assert.equal(m.$('fx-go').disabled, true);
  await until(() => !m.$('fx-recv').hidden, 'the new quote');
  m.$('fx-max').click(); await until(() => m.st.calls.asked.at(-1).units === 500n * TAC, 'the quote for the whole balance');
  assert.equal(m.$('fx-amt').value, '500');
});

test('the best of several quotes is shown with its provider, every provider that can take the amount is asked, and only quotes no worse than the one confirmed go to the press', async () => {
  const ps = [provider('Slow', { feeBps: 50 }), provider('Cheap', { feeBps: 20 }), provider('Small', { feeBps: 10, maxAmount: String(80n * TAC) }), provider('Down', { feeBps: 5 })];
  const m = mount({ providers: ps, session: sessionStub({ failFor: new Set(['Down']) }) });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  assert.deepEqual(m.st.calls.asked[0].names.sort(), ['Cheap', 'Down', 'Slow'], 'a provider that does not take 100 is not asked');
  assert.match(text(m.$('fx-recv')), /Provider Cheap/); assert.equal(m.$('fx-big').textContent, '98.8');
  await press(m);
  await until(() => m.st.calls.starts.length === 1, 'the start');
  assert.deepEqual(m.st.calls.starts[0].quotes.map((x) => x.provider.name), ['Cheap'], 'the confirmed quote; one that pays less is not tried without another press');
});

test('the confirmed provider cannot hold the payout: one that pays less is shown with its terms and needs another press, and is not started', async () => {
  const st = sessionStub(), start = st.session.start;
  st.session.start = async (a) => { if (a.quotes[0].provider.name === 'Cheap') throw new Error('the provider cannot hold that amount'); return start(a); };
  const m = mount({ providers: [provider('Slow', { feeBps: 500 }), provider('Cheap', { feeBps: 20 })], session: st });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  await press(m);
  await until(() => /The quote changed/.test(m.$('fx-st').textContent), 'the new terms said');
  assert.equal(st.calls.starts.length, 0, 'nothing locked on the dearer quote');
  assert.match(text(m.$('fx-recv')), /Provider Slow/);
  m.$('fx-go').click();
  await until(() => st.calls.starts.length === 1, 'the start once pressed again');
  assert.equal(st.calls.starts[0].quotes[0].provider.name, 'Slow');
});

test('a quote asked again at the press that pays less than the one confirmed is shown, not locked: the next press locks on it', async () => {
  const st = sessionStub(), quoteAll = st.session.quoteAll;
  let round = 0;
  st.session.quoteAll = async (providers, units) => {
    const r = await quoteAll(providers, units);
    round++;
    // the first quote ends within the minute and a half the press asks again in; the one asked again keeps 3%, more than the 1.3% confirmed
    if (round === 1) for (const x of r.quotes) x.quote.validUntil = Math.floor(Date.now() / 1000) + 30;
    else for (const x of r.quotes) { x.quote.fee = units * 300n / 10000n; x.quote.evmAmount = units - x.quote.fee; x.quote.id = 'q2'; }
    return r;
  };
  const m = mount({ session: st });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  await press(m);
  m.$('fx-go').click();
  await until(() => /The quote changed/.test(m.$('fx-st').textContent), 'the new figure said');
  assert.equal(st.calls.starts.length, 0, 'nothing was locked on the lower quote');
  assert.match(m.$('fx-st').textContent, /paid you 97 private TAC/);
  m.$('fx-go').click();
  await until(() => st.calls.starts.length === 1, 'the start on the new quote');
  assert.equal(st.calls.starts[0].quotes[0].quote.evmAmount, 97n * TAC);
});

test('a bridger who came by a provider\'s link is paired with it when its quote is about as good as the best, and with the best when it is not or does not quote', async () => {
  const dear = mount({ providers: [provider('Linked', { feeBps: 50 }), provider('Cheap', { feeBps: 20 })], pinned: () => pairId('Linked') });
  await signIn(dear);
  typeIn(dear, '100'); await until(() => !dear.$('fx-recv').hidden, 'the quote');
  assert.match(text(dear.$('fx-recv')), /Provider Cheap/, 'a paired provider that asks more is not put first');
  assert.match(text(dear.$('fx-recv')), /The provider you paired with asks more than the best quote now/);
  const ps = [provider('Linked', { feeBps: 25 }), provider('Cheap', { feeBps: 20 })];
  const m = mount({ providers: ps, pinned: () => pairId('Linked') });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-recv').hidden, 'the quote');
  assert.match(text(m.$('fx-recv')), /Provider Linked/);
  await press(m); await until(() => m.st.calls.starts.length === 1, 'the start');
  assert.deepEqual(m.st.calls.starts[0].quotes.map((x) => x.provider.name), ['Linked', 'Cheap'], 'the linked one first, the others behind it');
  const gone = mount({ providers: [provider('Cheap', { feeBps: 20 }), provider('Slow', { feeBps: 50 })], pinned: () => pairId('Linked') });
  await signIn(gone);
  typeIn(gone, '100'); await until(() => !gone.$('fx-recv').hidden, 'the quote');
  assert.match(text(gone.$('fx-recv')), /Provider Cheap/, 'a linked provider that is not online leaves the best');
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
  await until(() => m.$('fx-go').textContent === 'Press again to bridge', 'the confirmation');
  assert.equal(m.st.calls.starts.length, 0, 'the first press starts nothing');
  assert.match(m.$('fx-st').textContent, /locks 100 TAC on Bitcoin until Tacit(?: \(\w+\))? has paid you 98\.7 private TAC in the pool/); assert.match(m.$('fx-st').textContent, /returns to your address after about a day/);
  m.$('fx-go').click();
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
  typeIn(m, '100'); await press(m);
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
    await press(m);
    await until(() => m.$('fx-st').className === 'status err', 'the error');
    assert.match(m.$('fx-st').textContent, re);
    assert.equal(m.$('fx-go').disabled, false, 'the press can be tried again');
    m.ui.destroy();
  }
});

test('a key that locks or changes drops the session: the form closes, the timer stops, the amount is gone; another key is read at once', async () => {
  const m = mount();
  await signIn(m);
  typeIn(m, '50'); await until(() => !m.$('fx-recv').hidden, 'a quote');
  m.key.lock(); await tick(5);
  assert.equal(m.$('fx-form').hidden, true); assert.equal(m.$('fx-go').textContent, 'Sign in'); assert.match(m.$('fx-st').textContent, /locked/);
  assert.equal(m.st.calls.stops, 1); assert.equal(m.$('fx-amt').value, '');
  assert.equal(m.$('fx-go').hidden, false); m.$('fx-go').click(); await until(() => !m.$('fx-form').hidden, 'the form after a new key');
  assert.equal(m.state.opens, 2, 'one read for the key opened by the press');
  typeIn(m, '60');
  m.key.open('03' + 'ee'.repeat(32)); await tick(10);
  assert.equal(m.st.calls.stops, 2, 'the first key\'s session is stopped');
  assert.equal(m.$('fx-amt').value, '', 'its amount is gone');
  await until(() => !m.$('fx-form').hidden, 'the other key read without a press');
  assert.equal(m.state.opens, 3);
  m.ui.lock('Your wallet switched accounts.'); assert.match(m.$('fx-st').textContent, /switched accounts/);
});

test('a key opened elsewhere on the page (the provider panel) is read here too: the card never asks to open a wallet that is open', async () => {
  const m = mount();
  await until(() => m.$('fx-go').textContent === 'Sign in', 'the button');
  m.key.open();
  await until(() => !m.$('fx-form').hidden, 'the form');
  assert.equal(m.state.signIns, 0); assert.equal(m.state.opens, 1);
  assert.notEqual(m.$('fx-go').textContent, 'Sign in');
  m.ui.destroy();
});

test('a key the tab already holds when the page loads is opened at once, with or without a provider online: its bridges are listed and taken on', async () => {
  const key = keyStub(); key.open();
  const st = sessionStub();
  st.setRecs([rec({ id: 'aa'.repeat(36), phase: 'offered', title: 'Waiting for the pool lock', detail: 'The provider is locking TAC in the pool for you.', at: 1 })]);
  const m = mount({ key, session: st, providers: [] });
  await until(() => m.state.opens === 1 && !m.$('fx-list').hidden, 'the session and the list');
  assert.equal(m.state.signIns, 0, 'no sign-in was asked for');
  assert.match(text(m.$('fx-list')), /Your bridges Keep this page open until it is done Waiting for the pool lock/, 'the bridge under way is listed, with the word to keep the page open over it');
  m.ui.destroy();
});

test('what the providers can take now: the amount is capped by it, and the providers are read again as an amount is typed', async () => {
  let avail = String(300n * TAC);
  const m = mount({ discover: async () => [provider('Tacit', { available: avail })], refreshMs: 1, session: sessionStub({ balance: 900n * TAC }) });
  await until(() => /to 300 TAC now/.test(text(m.$('fx-lp'))), 'the available figure');
  await signIn(m);
  typeIn(m, '400'); await tick(10);
  assert.match(m.$('fx-st').textContent, /The provider can take up to 300 TAC right now/); assert.equal(m.$('fx-go').disabled, true);
  m.$('fx-max').click(); await until(() => m.$('fx-amt').value === '300', 'Max at what the provider can take');
  avail = String(50n * TAC); await tick(5);
  typeIn(m, '100'); await until(() => /up to 50 TAC/.test(m.$('fx-st').textContent), 'the refreshed limit');
  avail = '0'; await tick(5); typeIn(m, '20'); await until(() => /cannot take more right now/.test(m.$('fx-st').textContent), 'none left');
  const plain = mount();
  await until(() => /fee/.test(text(plain.$('fx-lp'))), 'the terms');
  assert.doesNotMatch(text(plain.$('fx-lp')), / now/);
});

test('the providers are read again when a provider goes: the ones left stand, and none left says so', async () => {
  let list = [provider('A'), provider('B', { feeBps: 10 })];
  const m = mount({ discover: async () => list, refreshMs: 1 });
  await until(() => /2 providers online/.test(text(m.$('fx-lp'))), 'two providers');
  list = [provider('A')];
  m.$('fx-go').click(); await tick(5); await until(() => !m.$('fx-form').hidden, 'the form');
  typeIn(m, '20'); await until(() => /^A\b/.test(text(m.$('fx-lp'))), 'one provider now');
});

test('a provider with nothing to take is full, not a range that ends at nothing; and with no provider the regular bridge is pointed to', async () => {
  const m = mount({ providers: [provider('Empty', { available: '0' })] });
  await until(() => /fee/.test(text(m.$('fx-lp'))), 'the summary');
  assert.match(text(m.$('fx-lp')), /full right now/); assert.doesNotMatch(text(m.$('fx-lp')), /to 0 TAC/);
  assert.equal(m.$('fx-tiles').hidden, true, 'a lone provider is the summary line, not a tile as well');
  const n = mount({ providers: [] });
  await until(() => /No provider is online/.test(text(n.$('fx-lp'))), 'the offline line');
  assert.equal(n.$('fx-alt').querySelector('a').getAttribute('href'), '/#card=bridge', 'the regular bridge is one click away');
  assert.match(text(n.$('fx-alt')), /regular bridge/);
});

test('what the lock costs on Bitcoin is read before the press: the fee shown, and an address that cannot pay it stops the press and says what to add', async () => {
  const st = sessionStub();
  let cost = { fee: 3100, take: 8046, total: 11146, have: 50000, short: false };
  st.session.cost = async ({ quote }) => { (st.calls.costs ||= []).push(quote.btcValue); return cost; };
  const m = mount({ session: st, discover: async () => [provider('Tacit')] });
  await signIn(m);
  typeIn(m, '100'); await until(() => /Bitcoin fee/.test(text(m.$('fx-recv'))), 'the fee row');
  assert.match(text(m.$('fx-recv')), /Bitcoin fee ≈ 11,146 sats/); assert.match(text(m.$('fx-recv')), /8,046 of it is the provider's take/); assert.deepEqual(st.calls.costs, [100n * TAC], 'priced for the amount quoted');
  assert.equal(m.$('fx-go').disabled, false);
  cost = { fee: 3100, take: 8046, total: 11146, have: 1200, need: 11146, short: true };
  typeIn(m, '101'); await until(() => /holds 1,200 sats for fees/.test(m.$('fx-st').textContent), 'the shortfall said');
  assert.match(m.$('fx-st').textContent, /needs about 11,146/); assert.equal(m.$('fx-go').disabled, true, 'a press that would fail is not offered');
  assert.equal(m.$('fx-st').className, 'status err');
  // a fee that cannot be read does not stop a bridge
  st.session.cost = async () => { throw new Error('no explorer answered'); };
  typeIn(m, '102'); await until(() => !m.$('fx-go').disabled, 'the quote without a cost'); await tick(10); assert.doesNotMatch(text(m.$('fx-recv')), /Bitcoin fee/, 'a fee that was not read is not made up'); assert.equal(m.$('fx-go').disabled, false);
});

test('TAC a provider would refuse (out of the shielded pool) is not offered: the page says so before the press, and a read that failed does not stop the press', async () => {
  const st = sessionStub();
  const lineage = (code, extra = {}) => Object.assign(new Error('fastbridge: ' + code), { code, ...extra });
  let release = null, mode = 'refuse';
  st.session.cost = async () => {
    await new Promise((r) => { release = r; });
    if (mode === 'refuse') throw lineage('lineage', { refused: [{ txid: 'a'.repeat(64), vout: 0, amount: 5000n * TAC, state: 'unprovable', through: 'shielded' }], left: 800n * TAC });
    if (mode === 'unread') throw lineage('lineage_unread', { unread: ['x:0'] });
    return { fee: 3100, take: 8046, total: 11146, have: 50000, short: false };
  };
  const m = mount({ session: st, discover: async () => [provider('Tacit')] });
  await signIn(m);
  typeIn(m, '100'); await until(() => release, 'the check under way');
  assert.match(m.$('fx-st').textContent, /Checking your TAC/, 'the wait is said');
  release(); release = null;
  await until(() => /Nothing was locked/.test(m.$('fx-st').textContent), 'the refusal said');
  assert.match(m.$('fx-st').textContent, /5,000 TAC of yours has a history that includes a move through Bitcoin’s shielded pool, which the bridge’s proof does not follow, and no provider online takes it right now/);
  assert.match(m.$('fx-st').textContent, /Your other TAC on Bitcoin, 800, can still go: try a smaller amount/);
  assert.equal(m.$('fx-st').className, 'status err');
  assert.equal(m.$('fx-recv').hidden, true, 'no quote is shown for a lock that would be refused');
  assert.equal(m.$('fx-go').disabled, true);
  // a history that could not be read is said, and the quote stays: the press looks again
  mode = 'unread'; typeIn(m, '101'); await until(() => release, 'the second check'); release(); release = null;
  await until(() => /Could not read this TAC’s history/.test(m.$('fx-st').textContent), 'the read said');
  assert.equal(m.$('fx-recv').hidden, false, 'the quote stands'); assert.equal(m.$('fx-go').disabled, false);
  // and a lock that passes is offered as before
  mode = 'fine'; typeIn(m, '102'); await until(() => release, 'the third check'); release(); release = null;
  await until(() => /Bitcoin fee/.test(text(m.$('fx-recv'))), 'the fee row'); assert.doesNotMatch(m.$('fx-st').textContent, /Checking|Nothing was locked/);
});

test('the page shows the best quote whose provider takes the TAC to be locked, and says nothing of kinds of TAC while one does', async () => {
  const st = sessionStub();
  const costed = [];
  st.session.cost = async ({ provider }) => {
    costed.push(provider.name);
    if (!provider.terms.anyTac) throw Object.assign(new Error('fastbridge: lineage'), { code: 'lineage', refused: [{ amount: 100n * TAC, through: 'shielded' }], left: 0n });
    return { fee: 3100, take: 8046, total: 11146, have: 50000, short: false };
  };
  // Cheap screens its locks, Open takes any TAC and charges more: Cheap pays the holder more, and cannot take what must be locked
  const m = mount({ session: st, discover: async () => [provider('Cheap', { feeBps: 10, flatFee: '0' }), provider('Open', { feeBps: 50, anyTac: true })] });
  await signIn(m);
  typeIn(m, '100'); await until(() => /Bitcoin fee/.test(text(m.$('fx-recv'))), 'the fee row');
  assert.deepEqual(costed, ['Cheap', 'Open'], 'the better quote was tried first');
  assert.match(text(m.$('fx-recv')), /Provider Open/, 'and the one that takes the TAC is the one shown');
  assert.doesNotMatch(m.$('fx-st').textContent, /history|shielded|Nothing was locked/, 'no word of kinds of TAC');
  assert.equal(m.$('fx-go').disabled, false);
  m.$('fx-go').click(); await until(() => /Press again/.test(m.$('fx-st').textContent), 'the first press');
  m.$('fx-go').click(); await until(() => st.calls.starts.length === 1, 'the bridge');
  assert.equal(st.calls.starts[0].quotes[0].provider.name, 'Open', 'the lock is begun with the provider that takes it');
});

test('while a history is read for the first time the press waits and the page says how far it is; the quote is there meanwhile', async () => {
  const st = sessionStub();
  let release = null, progress = null;
  st.session.cost = async ({ onProgress }) => { progress = onProgress; await new Promise((r) => { release = r; }); return { fee: 3100, take: 8046, total: 11146, have: 50000, short: false }; };
  const m = mount({ session: st, discover: async () => [provider('Tacit')] });
  await signIn(m);
  typeIn(m, '100'); await until(() => release, 'the check under way');
  assert.equal(m.$('fx-go').disabled, true, 'nothing is pressed while it is looked at');
  assert.equal(m.$('fx-go').textContent, 'Checking…');
  assert.equal(m.$('fx-recv').hidden, false, 'the quote is shown meanwhile');
  progress(120); progress(240);
  assert.match(m.$('fx-st').textContent, /Checking your TAC… 240 transfers read so far/);
  m.$('fx-go').click(); await tick(10);
  assert.equal(m.st.calls.starts.length, 0); assert.doesNotMatch(m.$('fx-st').textContent, /Press again/, 'a press while it is looked at does nothing');
  release(); release = null;
  await until(() => !m.$('fx-go').disabled, 'the press after the check');
  assert.equal(m.$('fx-go').textContent, 'Bridge'); assert.doesNotMatch(m.$('fx-st').textContent, /Checking/);
  // typing again ends the wait of the amount before it
  typeIn(m, '101'); await until(() => release, 'the second check'); typeIn(m, '102'); assert.equal(m.$('fx-go').disabled, true);
  release(); release = null; await until(() => release, 'the third check'); release(); await until(() => !m.$('fx-go').disabled, 'the last check ends it');
});

test('a holder whose lock must spend TAC the bridge\'s proof does not follow waits for a provider that takes any TAC, and is told only when one can', async () => {
  const kept = new Map(), told = [];
  const wants = { ask: async () => {}, kept: (pub) => kept.get(pub) || null, start: async (pub, amount) => { kept.set(pub, { amount, at: 1, until: 2 }); return kept.get(pub); }, stop: async (pub) => { kept.delete(pub); } };
  const st = sessionStub();
  st.session.cost = async () => { throw Object.assign(new Error('fastbridge: lineage'), { code: 'lineage', refused: [{ amount: 500n * TAC, through: 'shielded' }], left: 0n }); };
  st.session.reach = async () => 'any';
  let online = [provider('Screens')];
  const m = mount({ session: st, wants, notify: (t) => told.push(t), refreshMs: 20, discover: async () => online });
  await signIn(m);
  typeIn(m, '100');
  await until(() => m.$('fx-go').textContent === 'Wait for a provider', 'the wait is offered, the provider that screens is no taker');
  assert.match(m.$('fx-st').textContent, /no provider online takes it right now/);
  m.$('fx-go').click(); await until(() => kept.has(m.key.key.pubHex), 'the want kept');
  await tick(120);
  assert.equal(told.length, 0, 'a provider that screens is online and takes the amount, but not this TAC: nothing is told');
  online = [provider('Screens'), provider('Open', { anyTac: true })];
  await until(() => told.length === 1, 'told once a provider that takes any TAC is online');
  assert.match(told[0], /A provider can take your 100 TAC now/);
  m.ui.destroy();
});

test('a lock refused at the press (the check passed before, and not now) is said in the same words, and nothing starts', async () => {
  const st = sessionStub({ startError: Object.assign(new Error('fastbridge: lineage'), { code: 'lineage', refused: [{ amount: 3n * TAC, through: 'pool' }], left: 0n }) });
  const m = mount({ session: st, discover: async () => [provider('Tacit')] });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-go').disabled, 'the quote');
  m.$('fx-go').click(); await until(() => /Press again/.test(m.$('fx-st').textContent), 'the first press');
  m.$('fx-go').click(); await until(() => /Nothing was locked/.test(m.$('fx-st').textContent), 'the refusal');
  assert.match(m.$('fx-st').textContent, /3 TAC of yours has a history that includes a pool or farm trade on Bitcoin.*no provider online takes it/);
  assert.equal(st.calls.starts.length, 0);
});

test('the sats the builder lacks, as it says them, are put in the page\'s words', async () => {
  const m = mount({ session: sessionStub({ startError: new Error('adaptor-btc-tx: not enough sats to fund the commit (need 9000, have 250)') }) });
  await signIn(m);
  typeIn(m, '50'); await press(m);
  await until(() => m.$('fx-st').className === 'status err', 'the error');
  assert.match(m.$('fx-st').textContent, /holds 250 sats for fees and this bridge needs about 9,000/);
});

test('a bridge says how long ago it began and, when it is done, where the TAC is; a bridge under way says to keep the page open', async () => {
  const m = mount();
  let onChange; m.st.session.run = (o) => { onChange = o.onChange; return () => {}; };
  await signIn(m);
  const now = Math.floor(Date.now() / 1000);
  const want = [rec({ id: '01'.repeat(36), phase: 'offered', title: 'Waiting for the pool lock', at: 1, created: now - 600 }), rec({ id: '02'.repeat(36), phase: 'done', title: 'Done', at: 3, ended: true, created: now - 7200 })];
  onChange(want); await tick(5);
  const rows = [...m.$('fx-list').querySelectorAll('.fx-rec')];
  assert.match(text(rows[0]), /10 minutes ago/); assert.match(text(rows[1]), /2 hours ago/);
  assert.equal(rows[0].querySelector('a[href="/"]'), null); assert.ok(rows[1].querySelector('a[href="/"]'), 'a finished bridge points to where the TAC is');
  assert.match(text(m.$('fx-list')), /Keep this page open until it is done/);
  onChange([want[1]]); await tick(5);
  assert.doesNotMatch(text(m.$('fx-list')), /Keep this page open/, 'with nothing under way it is not said');
});

test('the first press says what the bridge does and goes no further; a changed amount asks again', async () => {
  const m = mount();
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-go').disabled, 'a quote'); m.$('fx-go').click();
  await until(() => m.$('fx-go').textContent === 'Press again to bridge', 'the confirmation');
  typeIn(m, '120'); assert.equal(m.$('fx-go').textContent, 'Bridge', 'a new amount is a new question');
  await until(() => !m.$('fx-go').disabled, 'the new quote'); m.$('fx-go').click();
  await until(() => m.$('fx-go').textContent === 'Press again to bridge', 'asked again');
  assert.equal(m.st.calls.starts.length, 0); assert.match(m.$('fx-st').textContent, /locks 120 TAC/);
});

test('a fee over 5% is quoted with a plain warning, in the receipt and again at the first press; a fair fee has none', async () => {
  const m = mount({ providers: [provider('Dear', { feeBps: 800, flatFee: '0' })] });
  await signIn(m);
  typeIn(m, '100'); await until(() => !m.$('fx-go').disabled, 'a quote');
  assert.match(text(m.$('fx-recv')), /High fee: this provider keeps 8 TAC \(8\.00%\) of your 100 TAC, and you receive 92\./);
  assert.equal(m.$('fx-big').textContent, '92');
  m.$('fx-go').click(); await until(() => m.$('fx-go').textContent === 'Press again to bridge', 'the confirmation');
  assert.match(m.$('fx-st').textContent, /^High fee: Dear(?: \(\w+\))? keeps 8 TAC \(8\.00%\)\. This locks 100 TAC/);
  const fair = mount({ providers: [provider('Fair', { feeBps: 100, flatFee: '0' })] });
  await signIn(fair);
  typeIn(fair, '100'); await until(() => !fair.$('fx-go').disabled, 'a quote');
  assert.equal(fair.$('fx-high'), null, 'no warning for a fee within 5%');
  fair.$('fx-go').click(); await until(() => fair.$('fx-go').textContent === 'Press again to bridge', 'the confirmation');
  assert.doesNotMatch(fair.$('fx-st').textContent, /High fee/);
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

// ── a bridge no one provider can take, split across several ──

// three providers that take any TAC: A 500 at 1%, B 400 at 2%, C 300 at 4% (and 1 TAC flat each)
const splitProviders = () => [provider('A', { available: String(500n * TAC), feeBps: 100, anyTac: true }), provider('B', { available: String(400n * TAC), feeBps: 200, anyTac: true }), provider('C', { available: String(300n * TAC), feeBps: 400, anyTac: true })];
// a session that can split: the offer it gives is the one the test says, its start does what the test says
function splitSession({ names = ['A', 'B', 'C'], amounts = [500n, 400n, 100n], stale = false, sweepError = null, notes = null, failed = [], unsent = 0, why = null, short = null, dearer = false } = {}) {
  const base = sessionStub(), calls = { ...base.calls, offers: [], sweeps: [] };
  const offerFor = (providers, units, over = {}) => {
    const legs = (over.names || names).map((n, i) => {
      const p = providers.find((x) => x.name === n), amount = (over.amounts || amounts)[i] * TAC, fee = (amount * BigInt(p.terms.feeBps)) / 10000n + p.terms.flatFee;
      return { provider: p, amount, notes: [], quote: { id: 'q' + n, btcValue: amount, evmAmount: amount - fee - (dearer && over.fresh ? TAC : 0n), fee: fee + (dearer && over.fresh ? TAC : 0n), validUntil: Math.floor(Date.now() / 1000) + (stale && !over.fresh ? 20 : 600), minConfs: 1 } };
    });
    const fee = legs.reduce((s, l) => s + l.quote.fee, 0n);
    return { ok: true, amount: units, legs, fee, receive: units - fee, minConfs: 1, cost: { total: 1200 * legs.length, take: 546 * legs.length, short: !!short, at: short ? short.at : null, need: short ? 1500 : null, have: short ? 700 : null }, high: { fee: false, take: false } };
  };
  const session = {
    ...base.session,
    sweepOffer: async (providers, units, o = {}) => {
      calls.offers.push({ units, exclude: o.exclude ? [...o.exclude] : [] });
      if (why) return { ok: false, ...why };
      if (o.exclude && o.exclude.size) return offerFor(providers, units, { names: names.filter((n) => !providers.some((p) => p.name === n && o.exclude.has(p.id))), amounts: [600n, 400n], fresh: true });
      return offerFor(providers, units, { fresh: calls.offers.length > 1 });
    },
    startSweep: async (offer) => {
      calls.sweeps.push(offer);
      if (sweepError) throw sweepError;
      const started = offer.legs.slice(0, offer.legs.length - failed.length).map((l, i) => ({ rec: { id: 'swap' + i }, provider: l.provider, leg: i, ...(i < unsent ? { unsent: true } : {}) }));
      base.setRecs(started.map((s, i) => rec({ id: String(i + 1).repeat(72).slice(0, 72), phase: 'built', title: 'Locking on Bitcoin', amount: String(offer.legs[i].amount), receive: String(offer.legs[i].quote.evmAmount), sweep: { id: 's1', part: i + 1, of: offer.legs.length } })));
      return { id: 's1', started, failed: failed.map((error, k) => ({ leg: offer.legs.length - failed.length + k, provider: offer.legs[offer.legs.length - failed.length + k].provider, amount: offer.legs[offer.legs.length - failed.length + k].amount, error })) };
    },
  };
  return { calls, session, setRecs: base.setRecs };
}
const waitsStub = () => ({ ask: async () => {}, kept: () => null, start: async () => null, stop: async () => {} });

test('no one provider takes the amount but the providers do between them: the page offers a split, with each part, the fee, the Bitcoin fee and the time, and does not offer to wait', async () => {
  const st = splitSession(), m = mount({ session: st, providers: splitProviders(), wants: waitsStub() });
  await signIn(m);
  assert.match(text(m.$('fx-lp')), /3 providers online.*cheapest 1\.00% \+ 1 TAC fee.*10 to 1,200 TAC$/, 'the line says what can be had by splitting');
  typeIn(m, '1000');
  await until(() => !m.$('fx-go').disabled && /parts/.test(m.$('fx-go').textContent), 'the offer');
  assert.equal(m.$('fx-go').textContent, 'Bridge in 3 parts');
  assert.deepEqual(st.calls.asked, [], 'no single quote was asked: no provider takes it whole');
  assert.deepEqual(st.calls.offers, [{ units: 1000n * TAC, exclude: [] }]);
  const r = text(m.$('fx-recv'));
  assert.match(r, /Split 3 parts no one provider takes it whole/);
  for (const [n, a] of [['A', '500'], ['B', '400'], ['C', '100']]) assert.match(r, new RegExp(`${n} ${a} TAC fee \\d+ \\(\\d+\\.\\d\\d%\\) · \\S+`), `${n}'s part, its fee and its key`);
  assert.ok(!m.$('fx-recv').querySelector('.kv > span small'), 'the key sits on the detail line, where the page styles it, not run into the name');
  assert.match(r, /Fee 20 TAC/, '5 + 1, 8 + 1 and 4 + 1 TAC'); assert.match(r, /Bitcoin fee ≈ 3,600 sats 3 locks, each with its own fee; 1,638 sats of it is the providers' take/);
  assert.match(r, /Time about 15 minutes/); assert.match(r, /Each part is a bridge of its own/);
  assert.equal(m.$('fx-big').textContent, '980', 'what is received is the amount less every part\'s fee');
  assert.notEqual(m.$('fx-go').textContent, 'Wait for a provider', 'a bridge that can be split is not one to wait for');
  assert.equal(m.$('fx-recv').hidden, false);
  m.ui.destroy();
});

test('pressing a split bridge: the first press says what it locks and what happens if a part stops, the second starts every part, and each is listed as a part of the whole', async () => {
  const st = splitSession(), m = mount({ session: st, providers: splitProviders() });
  await signIn(m);
  typeIn(m, '1000');
  await until(() => !m.$('fx-go').disabled, 'the offer');
  m.$('fx-go').click();
  await until(() => m.$('fx-go').textContent === 'Press again to bridge', 'the confirmation');
  assert.match(m.$('fx-st').textContent, /locks 1,000 TAC on Bitcoin in 3 separate locks, one for each of A, B, C/);
  assert.match(m.$('fx-st').textContent, /A part that does not go through returns its lock to your address after about a day, and the others carry on/);
  assert.equal(st.calls.sweeps.length, 0, 'nothing started on the first press');
  m.$('fx-go').click();
  await until(() => st.calls.sweeps.length === 1, 'the start');
  assert.deepEqual(st.calls.sweeps[0].legs.map((l) => [l.provider.name, l.amount / TAC]), [['A', 500n], ['B', 400n], ['C', 100n]]);
  await until(() => /Started in 3 parts/.test(m.$('fx-st').textContent), 'the note');
  assert.equal(m.$('fx-amt').value, '', 'the amount is cleared');
  await until(() => /Part 1 of 3/.test(text(m.$('fx-list'))), 'the list');
  const list = text(m.$('fx-list'));
  assert.match(list, /Part 1 of 3 · Locking on Bitcoin 500 TAC/); assert.match(list, /Part 3 of 3 · Locking on Bitcoin 100 TAC/);
  m.ui.destroy();
});

test('a split bridge that could only be started in part says how much was not, and why; one signed but not sent says so', async () => {
  const st = splitSession({ failed: [new Error('not started: the part before it could not be'), new Error('not started: the part before it could not be')] }), m = mount({ session: st, providers: splitProviders() });
  // (the first of the two failed parts is the one that errored; the one after it was not tried)
  await signIn(m); typeIn(m, '1000');
  await press(m);
  await until(() => /parts started/.test(m.$('fx-st').textContent), 'the partial note');
  assert.match(m.$('fx-st').textContent, /^1 of 3 parts started\. The other 500 TAC was not: /);
  assert.match(m.$('fx-st').textContent, /Bridge it again once the first locks have confirmed/);
  assert.equal(m.$('fx-st').className, 'status err');
  m.ui.destroy();
  const u = splitSession({ unsent: 2 }), n = mount({ session: u, providers: splitProviders() });
  await signIn(n); typeIn(n, '1000');
  await press(n);
  await until(() => /Signed, but Bitcoin has not taken 2 of the 3 locks yet/.test(n.$('fx-st').textContent), 'the unsent note');
  n.ui.destroy();
});

test('a provider that cannot hold its part stops the bridge before anything is locked, and the split is planned again without it', async () => {
  const B = splitProviders()[1];
  const st = splitSession({ sweepError: Object.assign(new Error('B cannot hold its part of the bridge: the provider cannot take that amount right now'), { code: 'sweep-hold', provider: B }) });
  const m = mount({ session: st, providers: splitProviders() });
  await signIn(m); typeIn(m, '1000');
  await press(m);
  await until(() => /could not hold its part, so the split was planned again without it/.test(m.$('fx-st').textContent), 'the replan');
  assert.deepEqual(st.calls.offers.map((o) => o.exclude), [[], [B.id]], 'planned again, with B left out');
  assert.match(m.$('fx-st').textContent, /^B could not hold its part/);
  assert.match(m.$('fx-st').textContent, /Press again to bridge/, 'the new split is confirmed before it goes');
  assert.match(m.$('fx-go').textContent, /Press again to bridge/);
  assert.doesNotMatch(text(m.$('fx-recv')), /\bB\b.*TAC fee/, 'B is not among the parts now');
  assert.equal(st.calls.sweeps.length, 1, 'only the first attempt started anything, and it started nothing');
  m.ui.destroy();
});

test('quotes that are about to run out are asked for again at the second press; a dearer split is shown first and needs another press', async () => {
  const st = splitSession({ stale: true }), m = mount({ session: st, providers: splitProviders() });
  await signIn(m); typeIn(m, '1000');
  await until(() => !m.$('fx-go').disabled, 'the offer');
  m.$('fx-go').click(); await until(() => m.$('fx-go').textContent === 'Press again to bridge', 'the confirmation');
  m.$('fx-go').click();
  await until(() => st.calls.sweeps.length === 1, 'the start');
  assert.equal(st.calls.offers.length, 2, 'the split was planned again for fresh quotes');
  assert.ok(st.calls.sweeps[0].legs.every((l) => l.quote.validUntil > Math.floor(Date.now() / 1000) + 300), 'and it is the fresh one that was started');
  m.ui.destroy();
  const d = splitSession({ stale: true, dearer: true }), n = mount({ session: d, providers: splitProviders() });
  await signIn(n); typeIn(n, '1000');
  await until(() => !n.$('fx-go').disabled, 'the offer');
  n.$('fx-go').click(); await until(() => n.$('fx-go').textContent === 'Press again to bridge', 'the confirmation');
  n.$('fx-go').click();
  await until(() => /The quote changed\./.test(n.$('fx-st').textContent), 'the changed quote');
  assert.equal(d.calls.sweeps.length, 0, 'a dearer split is not started on the press that found it');
  assert.match(n.$('fx-go').textContent, /Press again to bridge/);
  n.ui.destroy();
});

test('a split that cannot be had says why in words: the notes cannot be shared out, a provider did not answer, the providers cannot take it, the address cannot pay the fees', async () => {
  const run = async (opts, re, amount = '1000') => {
    const m = mount({ session: splitSession(opts), providers: splitProviders(), wants: waitsStub() });
    await signIn(m); typeIn(m, amount);
    await until(() => re.test(m.$('fx-st').textContent), String(re));
    assert.equal(m.$('fx-go').disabled, true, 'it cannot be pressed');
    assert.notEqual(m.$('fx-go').textContent, 'Wait for a provider', 'waiting would not help: the providers have the room');
    m.ui.destroy();
  };
  await run({ why: { why: 'notes', parts: 3, notes: 1 } }, /Your TAC on Bitcoin is in 1 note, and a lock spends a note whole, so 3 parts need 3 notes\. Split a note first \(Chains, then Notes\), or bridge less\./);
  await run({ why: { why: 'notes', parts: 2, notes: 1 } }, /in 1 note, .* so 2 parts need 2 notes/);
  await run({ why: { why: 'busy' } }, /A provider did not answer with its part/);
  await run({ why: { why: 'size' } }, /The providers cannot take 1,000 TAC between them right now/);
  await run({ short: { at: 1 } }, /can pay the Bitcoin fee for 1 of the 3 parts, one coin for each lock\. Add some sats from Receive in the Bitcoin tab on the front page \(about 1,500 for a part\), or bridge less\./);
  // over what the providers hold together: said as it always was, with the sum
  const m = mount({ session: splitSession(), providers: splitProviders() });
  await signIn(m); typeIn(m, '1500');
  await until(() => /The most is 1,200 TAC\./.test(m.$('fx-st').textContent), 'the sum');
  assert.equal(m.$('fx-go').disabled, true);
  m.ui.destroy();
});

test('a session that cannot split, or providers that screen, leave the page as it was: the single provider\'s room is the most, and waiting is offered', async () => {
  // no sweepOffer: after the key opens the page is the one it always was
  const m = mount({ providers: splitProviders(), wants: waitsStub() });
  await signIn(m);
  assert.match(text(m.$('fx-lp')), /10 to 500 TAC now/);
  typeIn(m, '1000');
  await until(() => /take up to 500 TAC right now/.test(m.$('fx-st').textContent), 'the old answer');
  m.ui.destroy();
  // providers that screen are not asked to take a part
  const screening = [provider('A', { available: String(500n * TAC) }), provider('B', { available: String(400n * TAC) })];
  const st = splitSession(), n = mount({ session: st, providers: screening, wants: waitsStub() });
  await signIn(n);
  assert.match(text(n.$('fx-lp')), /10 to 500 TAC now/, 'two that screen cannot be split across');
  typeIn(n, '800');
  await until(() => /take up to 500 TAC right now/.test(n.$('fx-st').textContent), 'the single room');
  assert.deepEqual(st.calls.offers, [], 'no split was planned');
  n.ui.destroy();
});

// ── a want that names the most its holder will pay ──

// every provider is full, so an amount of 100 TAC is waited for; the wants stub keeps what it is given, price included
function pricedWants() {
  const kept = new Map(), starts = [], told = [];
  return { kept, starts, told, wants: {
    ask: async () => {}, kept: (pub) => kept.get(pub) || null,
    start: async (pub, amount, o) => { starts.push(o); kept.set(pub, { amount, maxFeeBps: o && o.maxFeeBps != null ? o.maxFeeBps : null, at: 1, until: 2 }); return kept.get(pub); },
    stop: async (pub) => { kept.delete(pub); },
  } };
}
const full = (name, over = {}) => provider(name, { available: '0', ...over });

test('waiting with a price: the field is there only while waiting is what is offered, says what the providers keep of this amount, and sends the price with the want', async () => {
  const w = pricedWants();
  const m = mount({ wants: w.wants, discover: async () => [full('Tacit'), full('Cheap', { feeBps: 10, flatFee: '0' })] });
  await signIn(m);
  assert.equal(m.$('fx-price').hidden, true, 'nothing to wait for yet');
  typeIn(m, '100');
  await until(() => m.$('fx-go').textContent === 'Wait for a provider', 'the wait button');
  assert.equal(m.$('fx-price').hidden, false);
  assert.equal(m.$('fx-maxfee').placeholder, 'any', 'blank is any fee');
  assert.match(text(m.$('fx-price')), /Optional\. Providers see the most you would pay, and you are told when one can take it for no more\. The providers online keep 0\.10% to 1\.30% of this amount\./, 'a full provider still says what it keeps');
  m.$('fx-maxfee').value = '1.5';
  m.$('fx-go').click();
  const pub = m.key.key.pubHex;
  await until(() => w.kept.has(pub), 'the want kept');
  assert.deepEqual(w.starts, [{ maxFeeBps: 150 }], 'the price goes with the want, in hundredths of a percent');
  await until(() => /Waiting for a provider for 100 TAC, at up to 1\.50%/.test(text(m.$('fx-wait'))), 'the waiting line says the price');
  assert.equal(m.$('fx-price').hidden, true, 'the field goes once it is waiting');
  assert.match(m.$('fx-st').textContent, /You are told here, and on the front page, when one can take it for no more than 1\.50%\./);
  // stopping brings the field back, to wait again with another price
  m.$('fx-unwait').click();
  await until(() => !w.kept.has(pub) && !m.$('fx-price').hidden, 'the field again');
  m.ui.destroy();
});

test('a blank price is any fee, as it always was; a price that is not a percentage the page can quote is refused in words and nothing is kept', async () => {
  const w = pricedWants();
  const m = mount({ wants: w.wants, discover: async () => [full('Tacit')] });
  await signIn(m);
  typeIn(m, '100');
  await until(() => m.$('fx-go').textContent === 'Wait for a provider', 'the wait button');
  for (const bad of ['abc', '95', '-1', '1.234', '5%%']) {
    m.$('fx-maxfee').value = bad;
    m.$('fx-go').click();
    await until(() => /The most fee is a percentage from 0 to 90, or leave it blank for any\./.test(m.$('fx-st').textContent), `refused: ${bad}`);
    assert.equal(m.$('fx-st').className, 'status err');
    assert.equal(w.kept.size, 0, 'nothing kept');
    assert.equal(m.$('fx-go').disabled, false, 'and it can be pressed again');
  }
  assert.deepEqual(w.starts, []);
  // 0 is a price (no fee at all), 90 is the most, a percent sign is allowed, blank is none
  for (const [typed, want] of [['0', 0], ['90', 9000], ['2%', 200], ['', null]]) {
    m.$('fx-maxfee').value = typed;
    m.$('fx-go').click();
    await until(() => w.kept.size === 1, `kept: ${typed}`);
    assert.deepEqual(w.starts.at(-1), { maxFeeBps: want }, typed || 'blank');
    assert.equal(w.kept.get(m.key.key.pubHex).maxFeeBps, want);
    if (typed === '') assert.doesNotMatch(text(m.$('fx-wait')), /at up to/, 'a want with no price says none');
    m.$('fx-unwait').click();
    await until(() => w.kept.size === 0, 'stopped');
  }
  m.ui.destroy();
});

test('a priced want is told of the providers that keep no more than its price, and says so when the ones that could take it all keep more', async () => {
  const w = pricedWants();
  let online = [full('Tacit')];
  const m = mount({ wants: w.wants, notify: (t) => w.told.push(t), refreshMs: 20, discover: async () => online });
  await signIn(m);
  typeIn(m, '100');
  await until(() => m.$('fx-go').textContent === 'Wait for a provider', 'the wait button');
  m.$('fx-maxfee').value = '1.5';
  m.$('fx-go').click();
  await until(() => w.kept.size === 1, 'the want kept');
  // a provider with room keeps 5.00% of 100 TAC (4% and 1 TAC): it takes the size, and not at this price
  online = [full('Tacit'), provider('Dear', { feeBps: 400 })];
  await until(() => /Providers that can take it keep at least 5\.00% of it, above the 1\.50% you set\./.test(text(m.$('fx-wait-note'))), 'the page says why it is not told');
  assert.match(text(m.$('fx-wait-note')), /Stop waiting and wait again with a higher limit, or bridge at their fee\./);
  assert.equal(m.$('fx-wait-note').hidden, false);
  await tick(100);
  assert.equal(w.told.length, 0, 'told of nothing: the one that could take it asks more than the price');
  // one that keeps 1.00% of 100 TAC (flat 0, 100 bps) is within it
  online = [full('Tacit'), provider('Dear', { feeBps: 400 }), provider('Fair', { feeBps: 100, flatFee: '0' })];
  await until(() => w.told.length === 1, 'told once a provider within the price can take it');
  assert.match(w.told[0], /^A provider can take your 100 TAC now, for no more than the 1\.50% you set\.$/);
  assert.equal(m.$('fx-wait-note').hidden, true, 'the page stops saying why not');
  m.ui.destroy();
  // a want with no price is told of any provider that takes the size, in the old words
  const v = pricedWants(); let there = [full('Tacit')];
  const n = mount({ wants: v.wants, notify: (t) => v.told.push(t), refreshMs: 20, discover: async () => there });
  await signIn(n); typeIn(n, '100');
  await until(() => n.$('fx-go').textContent === 'Wait for a provider', 'the wait button');
  n.$('fx-go').click(); await until(() => v.kept.size === 1, 'kept');
  there = [full('Tacit'), provider('Dear', { feeBps: 400 })];
  await until(() => v.told.length === 1, 'told of the dear one: no price was named');
  assert.equal(v.told[0], 'A provider can take your 100 TAC now.');
  assert.equal(n.$('fx-wait-note').hidden, true);
  n.ui.destroy();
});

// ── the depth ladder: what each size costs, and who is waiting ──

const openDepth = (m) => { m.$('fx-depth').open = true; m.$('fx-depth').dispatchEvent(new m.dom.window.Event('toggle')); };
const closeDepth = (m) => { m.$('fx-depth').open = false; m.$('fx-depth').dispatchEvent(new m.dom.window.Event('toggle')); };

test('the depth ladder: there when providers are, with no key, closed until it is opened; drawn then with what each size costs and the most that can be had', async () => {
  const m = mount({ providers: [provider('Tacit')] });
  assert.equal(m.$('fx-depth').hidden, true, 'not before the providers are read');
  await until(() => !m.$('fx-depth').hidden, 'the ladder');
  assert.equal(m.key.unlocked, false, 'no key was needed');
  assert.equal(m.$('fx-depth').open, false);
  assert.equal(m.$('fx-depth-in').innerHTML, '', 'nothing is drawn while it is closed');
  assert.match(text(m.$('fx-depth')), /Cost by size, and who is waiting/);
  openDepth(m);
  const t = text(m.$('fx-depth-in'));
  assert.match(t, /What it costs, by size/);
  assert.match(t, /Each is the way it would be bridged now\./);
  // 0.30% and 1 TAC: 1.03 of 10, 1.3 of 100, 4 of 1,000; one provider, so nothing is split
  assert.match(t, /10 TAC 1\.03 TAC 10\.30% · Tacit/);
  assert.match(t, /100 TAC 1\.3 TAC 1\.30% · Tacit/);
  assert.match(t, /1,000 TAC 4 TAC 0\.40% · Tacit/);
  assert.match(t, /The most that can be bridged now is 1,000 TAC\./);
  assert.doesNotMatch(t, /split/);
  assert.doesNotMatch(t, /Waiting for a provider/, 'a page with no way to read the wants says nothing of them');
  m.ui.destroy();
});

test('a size no one provider takes is shown split, across whom; providers that are full leave a line saying so; none listed, no ladder', async () => {
  const split = [provider('A', { available: String(500n * TAC), anyTac: true }), provider('B', { available: String(400n * TAC), anyTac: true })];
  const m = mount({ providers: split });
  await until(() => !m.$('fx-depth').hidden, 'the ladder');
  openDepth(m);
  const t = text(m.$('fx-depth-in'));
  assert.match(t, /900 TAC .* split in 2: A 500, B 400/);
  assert.match(t, /The most that can be bridged now is 900 TAC\. A size no one provider takes is split across several, each part a bridge of its own\./);
  m.ui.destroy();
  const f = mount({ providers: [provider('Tacit', { available: '0' })] });
  await until(() => !f.$('fx-depth').hidden, 'the ladder, with the providers full');
  openDepth(f);
  assert.match(text(f.$('fx-depth-in')), /Every provider is full right now\./);
  f.ui.destroy();
  const none = mount({ providers: [] });
  await until(() => /No provider is online/.test(text(none.$('fx-lp'))), 'the offline line');
  assert.equal(none.$('fx-depth').hidden, true, 'no ladder with no providers');
  none.ui.destroy();
});

test('the ladder lists who is waiting by the price they will pay, reads the wants when it opens and each minute while it stays open, and stops when it closes or the page ends', async () => {
  const item = (tac, maxFeeBps) => ({ pub: 'p' + tac, amount: BigInt(tac) * TAC, maxFeeBps });
  let waits = { count: 3, total: 0n, items: [item(7999, null), item(3873, 150), item(100, 150)] };
  let reads = 0;
  const wants = { ask: async () => {}, kept: () => null, start: async () => null, stop: async () => {}, waiting: async () => { reads++; return waits; } };
  const sets = [], clears = [], realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms, ...a) => { const id = realSet(fn, ms, ...a); if (ms === 60000) sets.push({ id, fn }); return id; };
  globalThis.clearInterval = (id) => { clears.push(id); return realClear(id); };
  try {
    const m = mount({ providers: [provider('Tacit')], wants });
    await until(() => !m.$('fx-depth').hidden, 'the ladder');
    assert.equal(reads, 0, 'nothing is read while it is closed');
    openDepth(m);
    await until(() => /Waiting for a provider/.test(text(m.$('fx-depth-in'))), 'the waiting bridges');
    assert.equal(reads, 1);
    const t = text(m.$('fx-depth-in'));
    assert.match(t, /Waiting for a provider 3/);
    assert.match(t, /any fee 1 bridge 7,999 TAC/);
    assert.match(t, /up to 1\.50% 2 bridges 3,973 TAC/);
    assert.ok(t.indexOf('any fee') < t.indexOf('up to 1.50%'), 'the ones that name no price first');
    assert.equal(sets.length, 1, 'read again each minute while it is open');
    waits = { count: 0, total: 0n, items: [] };
    await sets[0].fn();
    assert.equal(reads, 2);
    assert.match(text(m.$('fx-depth-in')), /No one is waiting\./);
    closeDepth(m);
    assert.ok(clears.includes(sets[0].id), 'closing it stops the reads');
    m.ui.destroy();
    // a board that does not answer leaves the ladder as it was, with no waiting section
    const down = mount({ providers: [provider('Tacit')], wants: { ...wants, waiting: async () => { throw new Error('down'); } } });
    await until(() => !down.$('fx-depth').hidden, 'the ladder');
    openDepth(down);
    await tick(30);
    assert.match(text(down.$('fx-depth-in')), /What it costs, by size/);
    assert.doesNotMatch(text(down.$('fx-depth-in')), /Waiting for a provider/);
    down.ui.destroy();
    // the page ending while it is open stops the reads too
    const last = mount({ providers: [provider('Tacit')], wants });
    await until(() => !last.$('fx-depth').hidden, 'the ladder');
    openDepth(last);
    const id = sets.at(-1).id;
    last.ui.destroy();
    assert.ok(clears.includes(id), 'destroy stops the reads');
  } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
});

test('the ladder follows the providers: a refresh redraws it while it is open, with the new cost and the new most', async () => {
  let online = [provider('Tacit')];
  const m = mount({ refreshMs: 20, discover: async () => online });
  await until(() => !m.$('fx-depth').hidden, 'the ladder');
  openDepth(m);
  assert.match(text(m.$('fx-depth-in')), /The most that can be bridged now is 1,000 TAC\./);
  online = [provider('Tacit', { feeBps: 10, flatFee: '0', available: String(200n * TAC) }), provider('Other', { available: String(300n * TAC) })];
  await tick(40);                                  // past the page's refresh interval, so the next look reads the providers again
  m.$('fx-amt').dispatchEvent(new m.dom.window.Event('input'));
  await until(() => /The most that can be bridged now is 300 TAC\./.test(text(m.$('fx-depth-in'))), 'the new most');
  assert.match(text(m.$('fx-depth-in')), /100 TAC 0\.1 TAC 0\.10% · Tacit/, 'the cheaper provider is the one for 100');
  // (that a toggle which changes nothing reads the boards and starts a timer only once is held by the reads and timers counted in the test above:
  // JSDOM sends a toggle of its own as well as the one sent here)
  assert.equal(m.$('fx-depth').open, true, 'it stayed open through the refreshes');
  m.ui.destroy();
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} fast page checks passed`);
process.exit(process.exitCode || 0);
