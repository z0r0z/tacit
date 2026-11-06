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
    assert.equal(m.$('fx-go').textContent, 'Open wallet');
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
  assert.equal(m.$('fx-go').textContent, 'Open wallet');
  assert.equal(m.$('fx-form').hidden, true, 'no form before a key');
});

test('several providers: how many, the lowest fee, the widest range, and what the best of them can take now', async () => {
  const m = mount({ providers: [provider('Slow', { feeBps: 50 }), provider('Cheap', { feeBps: 20, minAmount: String(50n * TAC), maxAmount: String(5000n * TAC), available: String(800n * TAC) }), provider('Small', { feeBps: 40, maxAmount: String(200n * TAC) })] });
  await until(() => /online/.test(text(m.$('fx-lp'))), 'the summary');
  const t = text(m.$('fx-lp'));
  assert.match(t, /3 providers online/); assert.match(t, /from 0\.20% \+ 1 TAC fee/);
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
  assert.ok(first.classList.contains('mine')); assert.match(text(first), /^Mine You Fee 0\.01% \+ 1 TAC Takes 10 to/);
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
  assert.match(t, /2 providers online/); assert.match(t, /from 0\.40%/, 'the fee of the one that can take a bridge'); assert.match(t, /50 to 500 TAC now/);
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
  assert.equal(m.$('fx-out').hidden, false); assert.equal(m.$('fx-big').textContent, '98.7'); assert.match(text(m.$('fx-out')), /You receive, private/); assert.match(text(m.$('fx-recv')), /Fee 1\.3 TAC 1\.30%/);
  assert.match(text(m.$('fx-recv')), /Time about 15 minutes 1 Bitcoin confirmation, then a pool settle/);
  assert.doesNotMatch(text(m.$('fx-recv')), /Provider/, 'with one provider the receipt does not name it');
  assert.equal(m.$('fx-go').disabled, false); assert.equal(m.$('fx-st').textContent, '');
  typeIn(m, '101'); assert.equal(m.$('fx-recv').hidden, true, 'a changed amount drops the old quote'); assert.equal(m.$('fx-out').hidden, true); assert.equal(m.$('fx-go').disabled, true);
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
  assert.match(text(m.$('fx-recv')), /Provider Cheap/); assert.equal(m.$('fx-big').textContent, '98.8');
  await press(m);
  await until(() => m.st.calls.starts.length === 1, 'the start');
  assert.deepEqual(m.st.calls.starts[0].quotes.map((x) => x.provider.name), ['Cheap', 'Slow'], 'the best first, then the next to try');
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

test('a bridger who came by a provider\'s link is paired with it when it quotes, even when another is cheaper, and with the best when it does not', async () => {
  const ps = [provider('Linked', { feeBps: 50 }), provider('Cheap', { feeBps: 20 })];
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
  assert.match(m.$('fx-st').textContent, /locks 100 TAC on Bitcoin until Tacit has paid you 98\.7 private TAC in the pool/); assert.match(m.$('fx-st').textContent, /returns to your address after about a day/);
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
  assert.equal(m.$('fx-form').hidden, true); assert.equal(m.$('fx-go').textContent, 'Open wallet'); assert.match(m.$('fx-st').textContent, /locked/);
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
  await until(() => m.$('fx-go').textContent === 'Open wallet', 'the button');
  m.key.open();
  await until(() => !m.$('fx-form').hidden, 'the form');
  assert.equal(m.state.signIns, 0); assert.equal(m.state.opens, 1);
  assert.notEqual(m.$('fx-go').textContent, 'Open wallet');
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
  assert.equal(rows[0].querySelector('a[href="/assets/"]'), null); assert.ok(rows[1].querySelector('a[href="/assets/"]'), 'a finished bridge points to where the TAC is');
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
  assert.match(m.$('fx-st').textContent, /^High fee: Dear keeps 8 TAC \(8\.00%\)\. This locks 100 TAC/);
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

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} fast page checks passed`);
process.exit(process.exitCode || 0);
