// The help page's logic (dapp/help/ui.js) on the page's own HTML, with the network passed in: the machines online, a question and its answer,
// what is shown for the gateway's own replies, the errors, a second press while one question is out, the example questions, and that nothing a model
// writes is ever read as markup.
//   node tests/help-ui.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountHelp, MAX_Q, EXAMPLES } from '../dapp/help/ui.js';

const PAGE = readFileSync(new URL('../dapp/help/index.html', import.meta.url), 'utf8');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 200; i++) { if (f()) return; await tick(3); } throw new Error(`timed out: ${what}`); };

function setup({ ask, health = async () => ({ nodes: 3 }), examples } = {}) {
  const dom = new JSDOM(PAGE);   // scripts do not run: the page's HTML is the DOM the module draws in
  const doc = dom.window.document;
  const calls = { ask: [], health: 0 };
  const h = { get: (id) => doc.getElementById(id), win: dom.window, calls };
  h.ui = mountHelp({
    root: doc.querySelector('main'),
    ask: async (q) => { calls.ask.push(q); return (ask || (async () => ({ answer: 'ok' })))(q); },
    health: async () => { calls.health++; return health(); },
    ...(examples ? { examples } : {}),
  });
  return h;
}
const text = (e) => e.textContent.replace(/\s+/g, ' ').trim();

test('the page has the one form, the question, the answer area and the count', () => {
  const h = setup();
  for (const id of ['f', 'q', 'go', 'out', 'nodes', 'eg']) assert.ok(h.get(id), `#${id}`);
  assert.equal(h.get('q').getAttribute('maxlength'), String(MAX_Q));
  assert.equal(h.get('f').getAttribute('autocomplete'), 'off');
  assert.ok(h.get('q').labels.length === 1, 'the question has a label');
  assert.equal(h.get('out').textContent, '');
});

test('the count of machines online reads for one, several, none, and is left out when it cannot be read', async () => {
  for (const [nodes, want, warn] of [[3, '3 community machines online', false], [1, '1 community machine online', false], [0, 'no community machine online', true]]) {
    const h = setup({ health: async () => ({ nodes }) });
    await until(() => text(h.get('nodes')) !== '', 'the count');
    assert.equal(text(h.get('nodes')), want);
    assert.equal(h.get('nodes').classList.contains('warn'), warn);
  }
  for (const health of [async () => { throw new Error('down'); }, async () => ({}), async () => ({ nodes: 'x' })]) {
    const h = setup({ health }); await until(() => h.calls.health >= 1, 'health'); await tick(10);
    assert.equal(text(h.get('nodes')), '');
  }
});

test('the example questions are buttons that ask themselves', async () => {
  const h = setup({ ask: async () => ({ answer: 'No.' }) });
  const buttons = [...h.get('eg').querySelectorAll('button')];
  assert.deepEqual(buttons.map(text), EXAMPLES);
  assert.ok(buttons.every((b) => b.type === 'button'), 'none of them submits the form');
  buttons[1].click();
  await until(() => text(h.get('out')).includes('No.'), 'the answer');
  assert.deepEqual(h.calls.ask, [EXAMPLES[1]]);
  assert.equal(h.get('q').value, EXAMPLES[1]);
});

test('an answer from the docs shows its text, where it came from, and that a small model can be wrong', async () => {
  const h = setup({ ask: async () => ({ answer: 'Two audits.\nBoth are public.', sources: ['Security > Audits', 'FAQ > Audit'] }) });
  h.get('q').value = '  Has Tacit been audited?  ';
  h.get('go').click();
  await until(() => h.get('out').querySelector('.a'), 'the answer');
  assert.deepEqual(h.calls.ask, ['Has Tacit been audited?'], 'the question is sent trimmed');
  assert.equal(h.get('out').querySelector('.a').textContent, 'Two audits.\nBoth are public.', 'line breaks kept');
  assert.equal(text(h.get('out').querySelector('.src')), 'From the docs: Security > Audits · FAQ > Audit');
  assert.match(text(h.get('out').querySelector('.fine')), /small open model.*can be wrong/);
});

test("the gateway's own replies show no sources and no caution", async () => {
  for (const reply of [{ answer: 'Nobody is answering right now.', sources: [], unavailable: true }, { answer: 'That is not in the docs.', sources: [], gated: true },
    { answer: 'Never share a seed phrase.', sources: ['x'], guarded: true }, { answer: 'No sources at all.' }, { answer: 'Down, with sources.', sources: ['x'], unavailable: true }]) {
    const h = setup({ ask: async () => reply });
    h.get('q').value = 'anything'; h.get('go').click();
    await until(() => h.get('out').querySelector('.a'), 'the reply');
    assert.equal(text(h.get('out').querySelector('.a')), reply.answer);
    assert.equal(h.get('out').querySelector('.src'), null, JSON.stringify(reply));
    assert.equal(h.get('out').querySelector('.fine'), null, JSON.stringify(reply));
  }
});

test('while a question is out the button is off and a second press asks nothing; the answer turns it back on', async () => {
  let release; const gate = new Promise((r) => (release = r));
  const h = setup({ ask: async () => { await gate; return { answer: 'late', sources: ['a'] }; } });
  h.get('q').value = 'first';
  h.get('go').click();
  await until(() => h.get('go').disabled, 'the button off');
  assert.equal(h.get('out').getAttribute('aria-busy'), 'true');
  assert.match(text(h.get('out')), /Asking the community machines/);
  h.get('go').disabled = false; h.get('go').click(); h.ui.submit('second');
  await tick(10);
  assert.deepEqual(h.calls.ask, ['first']);
  release();
  await until(() => !h.get('go').disabled && h.get('out').querySelector('.a'), 'the answer');
  assert.equal(h.get('out').getAttribute('aria-busy'), null);
});

test('a failed question shows the message it failed with, in the error colour, and can be asked again', async () => {
  let n = 0;
  const h = setup({ ask: async () => { if (n++ === 0) throw new Error('Too many questions, try again in a minute.'); return { answer: 'fine now', sources: ['a'] }; } });
  h.get('q').value = 'one'; h.get('go').click();
  await until(() => h.get('out').querySelector('.status.err'), 'the error');
  assert.equal(text(h.get('out')), 'Too many questions, try again in a minute.');
  assert.equal(h.get('go').disabled, false);
  h.get('go').click();
  await until(() => h.get('out').querySelector('.a'), 'the second answer');
  assert.equal(text(h.get('out').querySelector('.a')), 'fine now');
  assert.equal(h.get('out').querySelector('.status'), null, 'the error is gone');
  const h2 = setup({ ask: async () => { throw new Error(''); } });
  h2.get('q').value = 'x'; h2.get('go').click();
  await until(() => h2.get('out').querySelector('.status.err'), 'the default error');
  assert.match(text(h2.get('out')), /could not be reached/);
});

test('an empty or blank reply is an error, not an empty answer', async () => {
  for (const reply of [{ answer: '' }, { answer: '   ' }, {}, null]) {
    const h = setup({ ask: async () => reply });
    h.get('q').value = 'x'; h.get('go').click();
    await until(() => h.get('out').querySelector('.status.err'), 'the error');
    assert.match(text(h.get('out')), /No answer came back/);
  }
});

test('a blank question asks nothing and puts the cursor back in the box', async () => {
  const h = setup();
  h.get('q').value = '   \n  ';
  h.get('go').click();
  await tick(10);
  assert.deepEqual(h.calls.ask, []);
  assert.equal(h.get('out').textContent, '');
  assert.equal(h.win.document.activeElement, h.get('q'));
});

test('a question is cut to the limit the gateway reads', async () => {
  const h = setup();
  h.get('q').value = 'a'.repeat(MAX_Q + 300);
  h.get('go').click();
  await until(() => h.calls.ask.length === 1, 'the ask');
  assert.equal(h.calls.ask[0].length, MAX_Q);
});

test('control or command with enter asks; enter alone does not', async () => {
  const h = setup();
  const press = (init) => { const e = new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }); h.get('q').dispatchEvent(e); return e; };
  h.get('q').value = 'hello';
  assert.equal(press({}).defaultPrevented, false);
  await tick(10);
  assert.deepEqual(h.calls.ask, []);
  assert.equal(press({ ctrlKey: true }).defaultPrevented, true);
  await until(() => h.calls.ask.length === 1, 'ctrl+enter');
  await until(() => !h.get('go').disabled, 'done');
  press({ metaKey: true });
  await until(() => h.calls.ask.length === 2, 'cmd+enter');
});

test('the form never leaves the page on submit', async () => {
  const h = setup();
  const e = new h.win.Event('submit', { cancelable: true, bubbles: true });
  h.get('f').dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
});

test('what an answer or a source says is drawn as text, never as markup', async () => {
  const evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script><b>bold</b>';
  const h = setup({ ask: async () => ({ answer: evil, sources: [evil] }), health: async () => ({ nodes: 2 }) });
  h.get('q').value = 'x'; h.get('go').click();
  await until(() => h.get('out').querySelector('.a'), 'the answer');
  assert.equal(h.get('out').querySelector('img, script, b'), null);
  assert.equal(h.get('out').querySelector('.a').textContent, evil);
  assert.ok(text(h.get('out').querySelector('.src')).includes(evil));
  const e2 = setup({ ask: async () => { throw new Error(evil); } });
  e2.get('q').value = 'x'; e2.get('go').click();
  await until(() => e2.get('out').querySelector('.status.err'), 'the error');
  assert.equal(e2.get('out').querySelector('img, script, b'), null);
});

test('the count is read again after each question', async () => {
  const h = setup();
  await until(() => h.calls.health === 1, 'the first read');
  h.get('q').value = 'x'; h.get('go').click();
  await until(() => h.calls.health === 2, 'the read after the answer');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.stack?.split('\n').slice(0, 4).join('\n    ')}`); }
}
console.log(`${tests.length - failed}/${tests.length} help page checks passed`);
process.exit(failed ? 1 : 0);
