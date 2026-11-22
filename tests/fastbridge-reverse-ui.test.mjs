// The fast bridge page's "Send TAC to Bitcoin" panel (dapp/fast/reverse.js) on a DOM, with the key, the providers and the session passed in: when it shows,
// what it says for each key state, the amount's checks, which provider it asks and what it does when one cannot quote, the press, the swaps under way,
// and a key that locks.
//   node tests/fastbridge-reverse-ui.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountReverse } from '../dapp/fast/reverse.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 300; i++) { if (f()) return; await tick(3); } throw new Error(`timed out: ${what}`); };

const TAC = 10n ** 8n;
const rv = (over = {}) => ({ feeBps: 30, flatFee: 1n * TAC, minAmount: 10n * TAC, maxAmount: 1000n * TAC, available: 500n * TAC, csvBlocks: 72, evmWindowSecs: 14400, ...over });
const seller = (name, over = {}) => ({ id: name, name, ref: { kind: 'mailbox', boardBase: 'https://board.example', gateway: '02' + 'ee'.repeat(32), claimPub: name }, reverse: rv(over) });
const onlyForward = (name) => ({ id: name, name, ref: { kind: 'mailbox' }, terms: {} });

function page() {
  const dom = new JSDOM('<!doctype html><body><details id="send" hidden></details></body>');
  return { dom, doc: dom.window.document, root: dom.window.document.getElementById('send') };
}
function keyStub() {
  const fns = new Set();
  const k = { unlocked: false, key: null, onChange: (f) => { fns.add(f); return () => fns.delete(f); },
    open(pubHex = '03' + 'cd'.repeat(32)) { k.unlocked = true; k.key = { pubHex }; fns.forEach((f) => f()); }, lock() { k.unlocked = false; k.key = null; fns.forEach((f) => f()); } };
  return k;
}
// a session the way fast/wire.js openReverse gives one
function sessionStub({ bal = 500n * TAC, quoteFor = null, startError = null } = {}) {
  const calls = { quotes: [], starts: [], runs: 0, stops: 0, opened: 0 };
  let recs = [], onChange = () => {};
  const session = {
    available: async () => bal,
    quote: async ({ provider, units }) => {
      calls.quotes.push({ name: provider.name, units });
      if (quoteFor) return quoteFor(provider, units);
      const fee = (units * BigInt(provider.reverse.feeBps)) / 10000n + provider.reverse.flatFee;
      return { id: 'q' + provider.name, evmAmount: units, btcValue: units - fee, fee, highFee: fee * 10000n > units * 500n, csvBlocks: 72, takeSats: 1000 };
    },
    start: async ({ provider, quote }) => {
      if (startError) throw startError;
      calls.starts.push({ provider: provider.name, quote });
      recs = [{ id: 'ab'.repeat(36), phase: 'accepted', title: 'Waiting for the Bitcoin lock', detail: 'The provider’s lock is on Bitcoin.', ended: false, amount: String(quote.evmAmount), receive: String(quote.btcValue), provider: provider.name, created: 1 }];
      return { swapId: 'ab'.repeat(36) };
    },
    records: async () => recs,
    run: (o) => { calls.runs++; onChange = o.onChange; o.onChange(recs); return () => { calls.stops++; }; },
  };
  return { calls, session, setRecs: (r) => { recs = r; onChange(recs); } };
}

function mount({ providers = [seller('A')], sess = sessionStub(), unlocked = true, signIn = () => {} } = {}) {
  const { dom, doc, root } = page(), keyS = keyStub();
  let list = providers;
  const panel = mountReverse({ root, keyS, signIn, quoteDelayMs: 1, refreshMs: 600000, tendMs: 600000, providers: async () => list, open: async () => { sess.calls.opened++; return sess.session; } });
  const $ = (id) => doc.getElementById(id);
  const t = {
    dom, doc, root, keyS, panel, sess, $, setList: (l) => { list = l; },
    type: async (text) => { const el = $('rv-amt'); el.value = text; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await tick(12); },
    openPanel: async () => { root.open = true; root.dispatchEvent(new dom.window.Event('toggle')); await tick(10); },
    text: () => root.textContent.replace(/\s+/g, ' '),
  };
  if (unlocked) keyS.open();
  return t;
}
const ready = async (o) => { const t = mount(o); await tick(8); await t.openPanel(); await until(() => t.sess.calls.runs === 1, 'the swaps are tended'); await until(() => /Private TAC you can send now/.test(t.$('rv-bal').textContent), 'the balance is read'); return t; };

test('it shows only when a provider sells the other way (or a swap of this key is under way), and a provider that sells one way does not count', async () => {
  const none = mount({ providers: [onlyForward('F')] }); await tick(10);
  assert.equal(none.root.hidden, true, 'no provider lists it: nothing on the page');
  const some = mount({ providers: [onlyForward('F'), seller('A')] }); await tick(10);
  assert.equal(some.root.hidden, false);
  assert.match(some.$('rv-go').textContent, /Send/);
  const late = mount({ providers: [] }); await tick(10);
  assert.equal(late.root.hidden, true);
  const failing = mountReverse({ root: page().root, keyS: keyStub(), open: async () => null, providers: async () => { throw new Error('the board is down'); } }); await tick(10);
  assert.equal(typeof failing.busy, 'function', 'a board that does not answer leaves the panel hidden and is not an error');
});

test('with the wallet locked nothing is read, and the button asks to open it', async () => {
  let asked = 0;
  const t = mount({ unlocked: false, signIn: () => { asked++; } }); await tick(10);
  await t.openPanel();
  assert.equal(t.sess.calls.opened, 0, 'no session is opened for a locked key');
  assert.equal(t.$('rv-go').textContent, 'Open your wallet'); assert.equal(t.$('rv-go').disabled, false);
  t.$('rv-go').click();
  assert.equal(asked, 1);
  t.keyS.open(); await until(() => t.sess.calls.opened === 1, 'the key opens and the session loads'); await until(() => /Private TAC you can send now: 500/.test(t.$('rv-bal').textContent), 'the balance shows');
  assert.equal(t.$('rv-go').textContent, 'Send'); assert.equal(t.$('rv-go').disabled, true, 'there is nothing to send until an amount is quoted');
});

test('the amount: what is wrong with it is said before anyone is asked, and the cheapest provider with room is the one asked', async () => {
  const t = await ready({ providers: [seller('Dear', { feeBps: 100 }), seller('Cheap', { feeBps: 20 }), seller('Small', { feeBps: 1, flatFee: 0n, maxAmount: 50n * TAC }), seller('Empty', { feeBps: 5, available: 0n })] });
  await t.type('abc'); assert.match(t.$('rv-quote').textContent, /not an amount/); assert.equal(t.sess.calls.quotes.length, 0);
  await t.type('600'); assert.match(t.$('rv-quote').textContent, /more than the 500 private TAC/); assert.equal(t.sess.calls.quotes.length, 0);
  await t.type('5'); assert.match(t.$('rv-quote').textContent, /least a provider takes is 10 TAC/);
  await t.type('200'); await until(() => t.sess.calls.quotes.length > 0, 'a quote is asked');
  assert.deepEqual(t.sess.calls.quotes.map((q) => q.name), ['Cheap'], 'not the dear one, not the one too small for it, not the one with nothing to sell');
  assert.match(t.$('rv-quote').textContent, /You send 200 TAC and get 198\.6 TAC on Bitcoin\. Cheap keeps 1\.4 \(0\.7%\)/);
  assert.equal(t.$('rv-go').disabled, false, 'a quote makes the press possible');
  await t.type('20'); await until(() => /You send 20 TAC/.test(t.$('rv-quote').textContent), 'the small amount is quoted');
  assert.equal(t.sess.calls.quotes.at(-1).name, 'Small', 'the cheapest that takes 20 is the small one');
});

test('nothing sells that much: the page says what the most is, or that nothing is for sale', async () => {
  const t = await ready({ providers: [seller('A', { maxAmount: 100n * TAC, available: 80n * TAC })], sess: sessionStub({ bal: 5000n * TAC }) });
  await t.type('90'); assert.match(t.$('rv-quote').textContent, /most a provider can take now is 80 TAC/);
  const e = await ready({ providers: [seller('A', { available: 0n })] });
  await e.type('50'); assert.match(e.$('rv-quote').textContent, /no TAC on Bitcoin to sell right now/);
  assert.equal(e.sess.calls.quotes.length, 0);
});

test('a provider that cannot quote is passed over for the next; when none can, the reason is shown and nothing can be pressed', async () => {
  const quoteFor = (p, units) => { if (p.name === 'Cheap') throw new Error('the provider has no TAC on Bitcoin for that amount right now'); const fee = (units * 50n) / 10000n; return { id: 'q', evmAmount: units, btcValue: units - fee, fee, highFee: false, csvBlocks: 72 }; };
  const t = await ready({ providers: [seller('Cheap', { feeBps: 1 }), seller('Next', { feeBps: 50 })], sess: sessionStub({ quoteFor }) });
  await t.type('100'); await until(() => /Next keeps/.test(t.$('rv-quote').textContent), 'the next provider quotes');
  assert.deepEqual(t.sess.calls.quotes.map((q) => q.name), ['Cheap', 'Next']);
  const bad = await ready({ providers: [seller('X')], sess: sessionStub({ quoteFor: () => { throw new Error('the provider did not answer'); } }) });
  await bad.type('100'); await until(() => /did not answer/.test(bad.$('rv-quote').textContent), 'the reason shows');
  assert.equal(bad.$('rv-go').disabled, true);
});

test('a fee over the page\'s limit is said plainly, and a quote that comes after the amount changed does not replace the newer one', async () => {
  const t = await ready({ providers: [seller('Dear', { feeBps: 100, flatFee: 20n * TAC })] });
  await t.type('100'); await until(() => /keeps 21/.test(t.$('rv-quote').textContent), 'quoted');
  assert.match(t.$('rv-quote').textContent, /That fee is high\./); assert.match(t.$('rv-quote').className, /err/);
  // a slow first quote and a fast second: the second stands
  let release;
  const slow = new Promise((r) => { release = r; });
  const quoteFor = async (p, units) => { if (units === 100n * TAC) await slow; const fee = TAC; return { id: 'q' + units, evmAmount: units, btcValue: units - fee, fee, highFee: false, csvBlocks: 72 }; };
  const u = await ready({ providers: [seller('A')], sess: sessionStub({ quoteFor }) });
  await u.type('100'); await u.type('200'); await until(() => /You send 200 TAC/.test(u.$('rv-quote').textContent), 'the newer amount is quoted');
  release(); await tick(20);
  assert.match(u.$('rv-quote').textContent, /You send 200 TAC/, 'the older answer, arriving late, is dropped');
  // the same when the slow one fails: its reason does not replace the newer quote, and does not take the press away
  let fail;
  const slowFail = new Promise((r) => { fail = r; });
  const quoteFor2 = async (p, units) => { if (units === 100n * TAC) { await slowFail; throw new Error('the provider did not answer in time'); } return { id: 'q' + units, evmAmount: units, btcValue: units - TAC, fee: TAC, highFee: false, csvBlocks: 72 }; };
  const v = await ready({ providers: [seller('A')], sess: sessionStub({ quoteFor: quoteFor2 }) });
  await v.type('100'); await v.type('200'); await until(() => /You send 200 TAC/.test(v.$('rv-quote').textContent), 'the newer amount is quoted');
  fail(); await tick(20);
  assert.match(v.$('rv-quote').textContent, /You send 200 TAC/, 'the older failure, arriving late, is dropped');
  assert.doesNotMatch(v.$('rv-quote').textContent, /did not answer/); assert.equal(v.$('rv-go').disabled, false);
});

test('what the quote says of the wait: the provider\'s lock needs more Bitcoin confirmations for a larger amount, and one is said in the singular', async () => {
  const t = await ready({ providers: [seller('A', { maxAmount: 50000n * TAC, available: 50000n * TAC })], sess: sessionStub({ bal: 50000n * TAC }) });
  // the wait follows what the provider locks, which is the amount less its fee (1 TAC and 0.3%): 1,000 sent is 995.7 locked, so one confirmation; 1,010 is over 1,000
  for (const [amount, words] of [['100', /needs 1 confirmation first/], ['1000', /needs 1 confirmation first/], ['1010', /needs 2 confirmations first/], ['10000', /needs 2 confirmations first/], ['10040', /needs 3 confirmations first/], ['20000', /needs 3 confirmations first/]]) {
    await t.type(amount); await until(() => new RegExp(`You send ${Number(amount).toLocaleString('en-US')} TAC`).test(t.$('rv-quote').textContent), `quoted ${amount}`);
    assert.match(t.$('rv-quote').textContent, words, amount);
  }
});

test('the press: the provider and the quote are the ones shown, the amount clears, the swap is listed, and a refusal is said and keeps the quote', async () => {
  const t = await ready({ providers: [seller('A')] });
  await t.type('100'); await until(() => !t.$('rv-go').disabled, 'a quote is there');
  t.$('rv-go').click();
  await until(() => t.sess.calls.starts.length === 1, 'started');
  assert.equal(t.sess.calls.starts[0].provider, 'A'); assert.equal(t.sess.calls.starts[0].quote.evmAmount, 100n * TAC);
  await until(() => /Started\. The provider is locking its Bitcoin/.test(t.$('rv-st').textContent), 'the note is said');
  assert.equal(t.$('rv-amt').value, '', 'the amount is cleared'); assert.equal(t.$('rv-quote').textContent, '');
  assert.match(t.text(), /100 TAC → 98\.7 on Bitcoin/); assert.match(t.text(), /Waiting for the Bitcoin lock/);
  assert.equal(t.panel.busy(), true, 'a swap is not over: the page says so before it is closed');
  // a provider that refuses
  const r = await ready({ providers: [seller('A')], sess: sessionStub({ startError: Object.assign(new Error('the provider cannot lock that amount: it has all the sends it takes at once'), { retry: true }) }) });
  await r.type('100'); await until(() => !r.$('rv-go').disabled, 'quoted');
  r.$('rv-go').click(); await until(() => /all the sends it takes at once/.test(r.$('rv-st').textContent), 'the refusal is shown');
  assert.match(r.$('rv-st').className, /err/); assert.equal(r.$('rv-amt').value, '100', 'what was typed stays so it can be tried again');
  await until(() => !r.$('rv-go').disabled, 'the quote is still there to press'); assert.equal(r.panel.busy(), false);
});

test('a swap that is over no longer holds the page, and what a provider chose to call itself cannot put markup on the page', async () => {
  const t = await ready({ providers: [seller('<img src=x onerror=alert(1)>')] });
  t.sess.setRecs([{ id: 'cd'.repeat(36), phase: 'done', title: 'Done', detail: 'The TAC is at your Bitcoin address.', ended: true, amount: String(100n * TAC), receive: String(98n * TAC), provider: '<img src=x onerror=alert(1)>', created: 2, lockTxid: 'ee'.repeat(32), takeTxid: 'ff'.repeat(32) }]);
  await tick(10);
  assert.equal(t.panel.busy(), false, 'done is over');
  assert.equal(t.root.querySelectorAll('img').length, 0, 'the name is text, not markup');
  assert.match(t.text(), /<img src=x/, 'it is shown as the text it is');
  const links = [...t.root.querySelectorAll('a')].map((a) => a.href);
  assert.deepEqual(links, ['https://mempool.space/tx/' + 'ee'.repeat(32), 'https://mempool.space/tx/' + 'ff'.repeat(32)], 'the provider\'s lock and the user\'s Bitcoin each link to their transaction');
});

test('a key that locks takes the session away: the tending stops, the balance and the quote go, and opening again reads it afresh', async () => {
  const t = await ready({ providers: [seller('A')] });
  await t.type('100'); await until(() => !t.$('rv-go').disabled, 'quoted');
  t.keyS.lock();
  await tick(10);
  assert.equal(t.sess.calls.stops, 1, 'the tending is stopped');
  assert.equal(t.$('rv-bal').textContent, ''); assert.equal(t.$('rv-quote').textContent, '');
  assert.equal(t.$('rv-go').textContent, 'Open your wallet');
  t.keyS.open('02' + '11'.repeat(32));
  await until(() => t.sess.calls.opened === 2, 'a session is opened again, for the new key');
  await until(() => t.sess.calls.runs === 2, 'and tended');
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} send-to-Bitcoin panel checks passed`);
process.exit(process.exitCode || 0);
