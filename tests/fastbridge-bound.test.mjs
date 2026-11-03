// The "ready for Ethereum" panel's logic (dapp/fast/bound.js) on a DOM, with the key and the session passed in: when it shows, the
// amounts it takes, a bind, the bound notes it lists (waiting or ready), a move, and what it hides.
//   node tests/fastbridge-bound.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountBound } from '../dapp/fast/bound.js';

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
function sessionStub({ bal = 500n * TAC, notes = [] } = {}) {
  const calls = { binds: [], moves: [] };
  const s = { bal, notes: notes.slice() };
  return {
    calls, s,
    session: {
      balance: async () => s.bal,
      bound: async () => s.notes.map((n) => ({ ...n })),
      bind: async ({ amount }) => { calls.binds.push(amount); s.bal -= amount; s.notes.push({ txid: 'b'.repeat(64), vout: 0, amount, state: 'waiting', etaMins: 280 }); return { txid: 'b'.repeat(64) }; },
      move: async (n) => { calls.moves.push(n); s.notes = s.notes.map((x) => (x.txid === n.txid && x.vout === n.vout ? { ...x, state: 'moved' } : x)); },
    },
  };
}
function mount(over = {}) {
  const dom = new JSDOM('<!doctype html><body><details id="ready"></details></body>', { url: over.url || 'https://tacit.finance/fast/#ready' });
  const doc = dom.window.document, root = doc.getElementById('ready'), key = keyStub(), stub = over.stub || sessionStub();
  const state = { opens: 0 };
  mountBound({ root, keyS: key, refreshMs: 60000, open: async () => { state.opens++; return stub.session; } });
  const $ = (id) => doc.getElementById(id);
  const type = (v) => { $('bd-amt').value = v; $('bd-amt').dispatchEvent(new dom.window.Event('input')); };
  return { dom, doc, root, key, stub, state, $, type, load: async () => { key.open(); root.open = true; root.dispatchEvent(new dom.window.Event('toggle')); await until(() => state.opens && !$('bd-list').textContent.includes('Reading'), 'the panel'); } };
}
const text = (e) => e.textContent.replace(/\s+/g, ' ').trim();

test('unlisted: hidden without /fast/#ready even with a key open, shown when the address names it', async () => {
  const m = mount({ url: 'https://tacit.finance/fast/' });
  m.key.open();
  assert.equal(m.root.hidden, true);
  await tick();
  assert.equal(m.state.opens, 0, 'nothing read');
  m.dom.window.location.hash = '#ready';
  await until(() => !m.root.hidden && m.state.opens === 1, 'shown and read');
  assert.equal(m.root.open, true);
});

test('with /fast/#ready: hidden until a key is open, then read; hidden again when it locks', async () => {
  const m = mount();
  assert.equal(m.root.hidden, true);
  m.key.open();
  assert.equal(m.root.hidden, false);
  await until(() => m.state.opens === 1, 'opened');
  m.key.lock();
  assert.equal(m.root.hidden, true);
});

test('the amount: 10 to 1,000 TAC at a time and no more than the key holds', async () => {
  const m = mount({ stub: sessionStub({ bal: 50n * TAC }) });
  await m.load();
  m.type('5'); assert.match(text(m.$('bd-st')), /least is 10 TAC/); assert.equal(m.$('bd-go').disabled, true);
  m.type('1001'); assert.match(text(m.$('bd-st')), /most at a time is 1,000 TAC/);
  m.type('60'); assert.match(text(m.$('bd-st')), /more than your TAC on Bitcoin/);
  m.type('x'); assert.match(text(m.$('bd-st')), /not an amount/);
  m.type('25'); assert.equal(m.$('bd-go').disabled, false); assert.equal(text(m.$('bd-st')), '');
});

test('a bind sends, links its transaction, and the note is listed as waiting with its time', async () => {
  const m = mount();
  await m.load();
  m.type('100');
  m.$('bd-go').click();
  await until(() => m.stub.calls.binds.length === 1 && /ready in about 4 hours/i.test(text(m.$('bd-st'))), 'the bind');
  assert.equal(m.stub.calls.binds[0], 100n * TAC);
  assert.ok(m.$('bd-st').querySelector('a[href$="' + 'b'.repeat(64) + '"]'), 'a link to the transaction');
  await until(() => /100 TAC/.test(text(m.$('bd-list'))), 'the note listed');
  assert.match(text(m.$('bd-list')), /Ready in about 5 hours/);
  assert.equal(m.$('bd-list').querySelector('[data-move]'), null, 'nothing to move yet');
  assert.equal(m.$('bd-amt').value, '');
});

test('a ready note moves in one press and then leaves the list; spent and moved notes are not listed', async () => {
  const m = mount({ stub: sessionStub({ notes: [
    { txid: 'a'.repeat(64), vout: 0, amount: 40n * TAC, state: 'ready', etaMins: 0 },
    { txid: 'c'.repeat(64), vout: 1, amount: 7n * TAC, state: 'spent', etaMins: 0 },
    { txid: 'd'.repeat(64), vout: 0, amount: 9n * TAC, state: 'moved', etaMins: 0 },
  ] }) });
  await m.load();
  await until(() => m.$('bd-list').querySelector('[data-move]'), 'the ready note');
  assert.doesNotMatch(text(m.$('bd-list')), /7 TAC|9 TAC/);
  m.$('bd-list').querySelector('[data-move]').click();
  await until(() => m.stub.calls.moves.length === 1 && /moved to your private balance/.test(text(m.$('bd-st'))), 'the move');
  assert.equal(m.stub.calls.moves[0].amount, 40n * TAC);
  await until(() => !/40 TAC/.test(text(m.$('bd-list'))), 'gone from the list');
});


let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.stack?.split('\n').slice(0, 3).join('\n    ')}`); }
}
console.log(`${tests.length - failed}/${tests.length} ready-for-Ethereum panel checks passed`);
process.exit(failed ? 1 : 0);
