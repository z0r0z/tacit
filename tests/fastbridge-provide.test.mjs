// The provider panel's logic (dapp/fast/provide.js) on a DOM, with the key and the provider session passed in: when it shows, what it
// reads of the key, the fee and size it takes, the switch, the swaps that are tended when the key opens, and what the page is told
// about closing.
//   node tests/fastbridge-provide.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountProvide } from '../dapp/fast/provide.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 200; i++) { if (f()) return; await tick(3); } throw new Error(`timed out: ${what}`); };
const TAC = 10n ** 8n;

function keyStub() {
  const fns = new Set();
  const k = { unlocked: false, key: null, onChange: (f) => { fns.add(f); return () => fns.delete(f); },
    open(pubHex = '03' + 'cd'.repeat(32)) { k.unlocked = true; k.key = { pubHex }; fns.forEach((f) => f()); }, lock() { k.unlocked = false; k.key = null; fns.forEach((f) => f()); } };
  return k;
}
function sessionStub({ pool = 5000n * TAC, open = 0 } = {}) {
  const calls = { starts: [], stops: 0 };
  const st = { running: false, accepting: false, open, done: 0, earned: 0n, lastError: null };
  return {
    calls, st,
    session: {
      inventory: async () => ({ pool, address: 'bc1qexampleaddress0000000000000000000000', claimPub: '02' + 'ab'.repeat(32) }),
      start: async (a) => { calls.starts.push(a); st.running = true; st.accepting = a.accept !== false; },
      stop: () => { calls.stops++; st.running = false; st.accepting = false; },
      status: async () => ({ ...st }),
    },
  };
}
function mount(over = {}) {
  const dom = new JSDOM('<!doctype html><body><details id="pv"></details></body>', { url: over.url || 'https://tacit.finance/fast/' });
  const doc = dom.window.document, root = doc.getElementById('pv'), key = over.key || keyStub(), stub = over.stub || sessionStub();
  const kept = new Map(over.kept || []), saved = [];
  const state = { opens: 0 };
  const ui = mountProvide({
    root, keyS: key, refreshMs: over.refreshMs ?? 5000,
    open: async () => { state.opens++; return stub.session; }, hasOpen: over.hasOpen || (() => false),
    settings: { get: (p) => kept.get(p) || null, set: (p, v) => { kept.set(p, v); saved.push(v); } },
    waiting: over.waiting || null, notify: over.notify, ask: over.ask, waitMs: over.waitMs ?? 60000, signIn: over.signIn || null,
  });
  return { dom, doc, root, key, stub, ui, state, saved, $: (id) => doc.getElementById(id), load: async () => { key.open(); root.open = true; root.dispatchEvent(new dom.window.Event('toggle')); await until(() => !root.querySelector('#pv-go').hidden, 'the panel'); } };
}
const text = (e) => { const out = [], w = e.ownerDocument.createTreeWalker(e, 4); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) out.push(n.nodeValue.trim()); return out.join(' '); };

test('with a way to open the key, the panel is there before a key too: Open wallet, then what the key can provide', async () => {
  let asked = 0;
  const key = keyStub();
  const m = mount({ key, signIn: async () => { asked++; key.open(); } });
  assert.equal(m.root.hidden, false, 'a visitor finds that anyone can provide');
  assert.equal(m.$('pv-go').hidden, false); assert.equal(m.$('pv-go').textContent, 'Open wallet'); assert.equal(m.$('pv-go').disabled, false);
  assert.equal(m.$('pv-set').hidden, true, 'no fee or size before a key');
  m.root.open = true; m.root.dispatchEvent(new m.dom.window.Event('toggle'));
  assert.equal(m.state.opens, 0, 'nothing is read before a key');
  m.$('pv-go').click();
  await until(() => /Your private TAC/.test(text(m.$('pv-inv'))), 'the inventory once the key opens');
  assert.equal(asked, 1); assert.equal(m.$('pv-go').textContent, 'Start providing');
  assert.equal(m.stub.calls.starts.length, 0, 'opening the key starts nothing');
  key.lock();
  assert.equal(m.root.hidden, false); assert.equal(m.$('pv-go').textContent, 'Open wallet');
  // the sheet closed without a key: nothing said, nothing read
  const n = mount({ signIn: async () => { throw Object.assign(new Error('Cancelled.'), { unlockCancelled: true }); } });
  n.$('pv-go').click(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(n.$('pv-st').textContent, ''); assert.equal(n.state.opens, 0);
  const bad = mount({ signIn: async () => { throw new Error('the wallet refused'); } });
  bad.$('pv-go').click(); await until(() => /refused/.test(bad.$('pv-st').textContent), 'the error');
});

test('the copy link is drawn as the page\'s link button, not a bare button', async () => {
  const m = mount();
  await m.load();
  assert.equal(m.$('pv-link').className, 'linkbtn');
});

test('the panel shows when a key is open, reads what the key can provide only when it is opened, and offers a fee and a size', async () => {
  const m = mount();
  assert.equal(m.root.hidden, true);
  m.key.open();
  assert.equal(m.root.hidden, false);
  assert.equal(m.state.opens, 0, 'nothing is read for a visitor who only bridges');
  m.root.open = true; m.root.dispatchEvent(new m.dom.window.Event('toggle'));
  await until(() => /Your private TAC/.test(text(m.$('pv-inv'))), 'the inventory');
  assert.match(text(m.$('pv-inv')), /Your private TAC 5,000 TAC/); assert.doesNotMatch(text(m.$('pv-inv')), /Bitcoin|sats/, 'nothing is asked of a provider on Bitcoin');
  assert.equal(m.$('pv-fee').value, '0.30'); assert.equal(m.$('pv-most').value, '1000', 'the most is a thousand, or what the key has');
  assert.equal(m.$('pv-go').textContent, 'Start providing');
  m.key.lock(); assert.equal(m.root.hidden, true);
  const small = mount({ stub: sessionStub({ pool: 250n * TAC }) });
  await small.load();
  assert.equal(small.$('pv-most').value, '250');
  const odd = mount({ stub: sessionStub({ pool: 1_043_867_355n }) });
  await odd.load();
  assert.equal(odd.$('pv-most').value, '10.4386', 'what is held, down to four places: never more than is held, and whole in the field');
});

test('what is asked of a provider before it starts: private TAC, a fee that is a percentage, a size it can fill (no Bitcoin: each lock pays the take)', async () => {
  const poor = mount({ stub: sessionStub({ pool: 5n * TAC }) });
  await poor.load();
  assert.equal(poor.$('pv-go').disabled, true, 'too little private TAC for the smallest bridge: there is nothing to start');
  assert.match(text(poor.$('pv-inv')), /Providing takes at least 10 private TAC/);
  assert.equal(poor.$('pv-most').value, '5', 'the most offered is what is held');
  const spent = mount({ stub: sessionStub({ pool: 146860000n + 12345n }), kept: [['03' + 'cd'.repeat(32), { feeBps: 30, maxAmount: String(1043867355n) }]] });
  await spent.load();
  assert.equal(spent.$('pv-most').value, '1.4687', 'a kept most over what is held now is brought down to it');
  const m = mount();
  await m.load();
  for (const [fee, most, re] of [['6', '100', /fee is a percentage from 0 to 5/], ['abc', '100', /fee is a percentage/], ['0.3', '5', /at least 10 TAC/], ['0.3', 'x', /at least 10 TAC/], ['0.3', '6000', /more private TAC/], ['4.5', '100', /At 10 TAC that fee is 0\.55 TAC, over the 5% the front page's Bridge tab prefers \(the fast page quotes more, with a warning\)\. Use at most 4\.00%/]]) {
    m.$('pv-fee').value = fee; m.$('pv-most').value = most;
    m.$('pv-go').click(); await tick(5);
    assert.match(m.$('pv-st').textContent, re, `${fee} / ${most}`);
    assert.equal(m.stub.calls.starts.length, 0);
  }
});

test('Start providing: the fee and the size go to the provider as they were typed, are kept for the key, and the panel shows the work', async () => {
  const m = mount({ refreshMs: 20 });
  await m.load();
  m.$('pv-fee').value = '0.25'; m.$('pv-most').value = '500';
  m.$('pv-go').click();
  await until(() => m.stub.calls.starts.length === 1, 'the start');
  assert.deepEqual(m.stub.calls.starts[0], { settings: { feeBps: 25, maxAmount: 500n * TAC }, accept: true });
  assert.deepEqual(m.saved, [{ feeBps: 25, maxAmount: String(500n * TAC) }]);
  await until(() => m.$('pv-go').textContent === 'Stop providing', 'the switch');
  assert.equal(m.$('pv-set').hidden, true, 'the fee is not changed while it provides');
  assert.match(text(m.$('pv-run')), /Providing on/); assert.match(text(m.$('pv-run')), /Open bridges 0/);
  assert.match(m.$('pv-st').textContent, /Keep this page open/);
  assert.equal(m.ui.busy(), true, 'closing the page now would stop it taking bridges');
  m.stub.st.open = 2; m.stub.st.done = 7; m.stub.st.earned = 3n * TAC + 50_000_000n;
  m.stub.session.status = async () => ({ ...m.stub.st });
  await until(() => /Done 7/.test(text(m.$('pv-run'))), 'the poll');
  assert.match(text(m.$('pv-run')), /Open bridges 2/); assert.match(text(m.$('pv-run')), /Earned 3\.5 TAC/);
});

test('Stop providing: no new bridges, the open ones still seen to their end; with none open it simply stops', async () => {
  const m = mount();
  await m.load();
  m.$('pv-go').click(); await until(() => m.$('pv-go').textContent === 'Stop providing', 'on');
  m.stub.st.open = 1;
  m.$('pv-go').click();
  await until(() => m.stub.calls.starts.length === 2, 'the winding down');
  assert.deepEqual(m.stub.calls.starts[1], { accept: false });
  assert.equal(m.stub.calls.stops >= 1, true);
  assert.match(text(m.$('pv-run')), /Finishing no new bridges/); assert.match(m.$('pv-st').textContent, /Keep this page open until the open ones are done/);
  assert.equal(m.ui.busy(), true, 'a swap is still open');
  assert.equal(m.$('pv-go').textContent, 'Start providing');
  const n = mount();
  await n.load();
  n.$('pv-go').click(); await until(() => n.$('pv-go').textContent === 'Stop providing', 'on');
  n.$('pv-go').click(); await until(() => /Stopped/.test(n.$('pv-st').textContent), 'stopped');
  assert.equal(n.stub.calls.starts.length, 1); assert.equal(n.ui.busy(), false);
});

test('swaps left open by an earlier visit are tended as soon as the key opens, without the panel being opened', async () => {
  const m = mount({ hasOpen: () => true, stub: sessionStub({ open: 2 }) });
  m.key.open();
  await until(() => m.stub.calls.starts.length === 1, 'the winding down');
  assert.deepEqual(m.stub.calls.starts[0], { accept: false });
  assert.equal(m.root.open, true);
  assert.match(m.$('pv-st').textContent, /still open/);
  assert.equal(m.ui.busy(), true);
});

test('a key that locks stops the provider and clears the panel', async () => {
  const m = mount();
  await m.load();
  m.$('pv-go').click(); await until(() => m.$('pv-go').textContent === 'Stop providing', 'on');
  const stops = m.stub.calls.stops;
  m.key.lock();
  assert.equal(m.stub.calls.stops, stops + 1); assert.equal(m.root.hidden, true);
  await m.load();
  assert.equal(m.state.opens, 2, 'a new session for the next key');
  assert.equal(m.$('pv-go').textContent, 'Start providing');
});

test('the last take stays linked once providing has stopped, for a claim that names it', async () => {
  const m = mount({ stub: sessionStub() });
  m.stub.st.lastTake = 'ab'.repeat(32);
  await m.load();
  const a = m.$('pv-run').querySelector('a');
  assert.equal(m.$('pv-run').hidden, false);
  assert.equal(a.href, `https://mempool.space/tx/${'ab'.repeat(32)}`);
  assert.equal(text(m.$('pv-run')).includes('Open bridges'), false, 'nothing of a running provider is shown');
});

test('bridges waiting for a provider: counted beside the panel title and in it, read again while the page is open', async () => {
  let w = { count: 0, total: 0n };
  const m = mount({ waiting: async () => w, waitMs: 20 });
  m.key.open();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(m.$('pv-want').hidden, true, 'nothing waiting: nothing said');
  assert.equal(m.$('pv-waiting').textContent, '');
  w = { count: 2, total: 1500n * 10n ** 8n };
  await until(() => !m.$('pv-want').hidden, 'the waiting line');
  assert.match(text(m.$('pv-want')), /Waiting for a provider 2 bridges, 1,500 TAC/);
  assert.equal(m.$('pv-waiting').textContent, ' · 2 waiting');
});

test('the bridges waiting are listed by size with how many this key can take, and one that starts waiting that it can take is told once', async () => {
  const item = (pub, tac) => ({ pub, amount: BigInt(tac) * TAC });
  let w = { count: 2, total: 47_896n * TAC, items: [item('a', 10), item('b', 47_886)] };
  const told = [];
  const m = mount({ waiting: async () => w, waitMs: 20, notify: (t) => told.push(t) });
  await m.load();
  await until(() => /you can take/.test(text(m.$('pv-want'))), 'the sizes');
  assert.match(text(m.$('pv-want')), /Waiting for a provider 10 · 47,886 TAC \(you can take 1\)/);
  assert.deepEqual(told, [], 'what was there at the first look is not news');
  w = { count: 3, total: 0n, items: [item('a', 10), item('c', 250), item('b', 47_886), item('d', 5)] };
  await until(() => told.length > 0, 'the notice');
  assert.deepEqual(told, ['A bridge of 250 TAC is waiting for a provider you can be.']);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(told.length, 1, 'told once');
});

test('the key\'s pairing link is offered with what it can provide, and Start providing asks leave to tell it of waiting bridges', async () => {
  let asked = 0;
  const m = mount({ ask: async () => { asked++; } });
  await m.load();
  const b = m.$('pv-link');
  assert.equal(b.dataset.link, 'https://tacit.finance/fast/#with=' + 'ab'.repeat(8));
  m.$('pv-fee').value = '0.3'; m.$('pv-most').value = '100';
  m.$('pv-go').click(); await tick(5);
  assert.equal(asked, 1);
});

test('/fast/#provide opens the panel, which reads the key as soon as it is unlocked', async () => {
  const m = mount({ url: 'https://tacit.finance/fast/#provide' });
  assert.equal(m.root.open, true);
  assert.equal(m.state.opens, 0, 'nothing is read before a key is open');
  m.key.open();
  await until(() => m.state.opens === 1 && m.$('pv-go').textContent === 'Start providing', 'read');
  assert.equal(m.root.hidden, false);
});

test('while it provides, or a bridge it provides is open, the screen is kept awake; a hidden tab with a bridge open says so in its title', async () => {
  const m = mount(), win = m.dom.window, locks = [];
  Object.defineProperty(win.navigator, 'wakeLock', { configurable: true, value: { request: async (type) => { const l = { type, released: false, release: async () => { l.released = true; }, addEventListener: () => {} }; locks.push(l); return l; } } });
  let hidden = false;
  Object.defineProperty(m.doc, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(m.doc, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  m.doc.title = 'tacit fast';
  await m.load();
  assert.equal(locks.length, 0, 'nothing is kept awake for a key that does not provide');
  m.$('pv-go').click();
  await until(() => locks.length === 1, 'the wake lock');
  assert.equal(locks[0].type, 'screen');
  // a bridge taken on, then the tab hidden: the title says to keep it open
  m.stub.st.open = 1; hidden = true; m.doc.dispatchEvent(new win.Event('visibilitychange'));
  m.ui.refresh?.(); await tick(20);
  await until(() => /Keep this open: a bridge is under way/.test(m.doc.title), 'the title');
  hidden = false; m.doc.dispatchEvent(new win.Event('visibilitychange'));
  await until(() => m.doc.title === 'tacit fast', 'the title back');
  // stopped with nothing open: the screen may sleep again
  m.stub.st.open = 0;
  m.$('pv-go').click();
  await until(() => locks.every((l) => l.released), 'the lock let go');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} provider panel checks passed`);
process.exit(process.exitCode || 0);
