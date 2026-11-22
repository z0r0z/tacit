// tab-key.js: the 30 minutes a Tacit wallet says it stays open for are kept by the page that holds it, not only at the next page load. After IDLE with no
// pointer, key, wheel or touch the page is told (onIdle) and the tab's saved key is let go; a running action counts as use; coming back to a tab
// that has sat idle locks it at once.
//   node tests/tab-key-idle.test.mjs
import assert from 'node:assert/strict';

let now = 1_700_000_000_000;
Date.now = () => now;
const handlers = {}, docHandlers = {}, timers = [];
const store = new Map();
globalThis.addEventListener = (ev, fn) => { (handlers[ev] ||= []).push(fn); };
globalThis.document = { hidden: false, addEventListener: (ev, fn) => { (docHandlers[ev] ||= []).push(fn); } };
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
const { tabKeyWatch, tabKeyWrite, tabKeyRead, IDLE, IDLE_WHY } = await import('../dapp/tab-key.js');

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n' + e.stack); } };
const PRIV = 'a'.repeat(64);
const minutes = (m) => { now += m * 60e3; };
const tick = () => timers.forEach((f) => f());
const fire = (ev) => (handlers[ev] || []).forEach((f) => f({}));

let idled = [], working = false, check;
check = tabKeyWatch({ onIdle: (why) => idled.push(why), busy: () => working });
tabKeyWrite({ mode: 'eth', priv: PRIV, pubHex: '02' + 'b'.repeat(64), address: '0x' + 'c'.repeat(40) });

await test('a wallet used within the half hour is left open', async () => {
  minutes(29); tick();
  assert.deepEqual(idled, []);
  assert.ok(tabKeyRead(), 'the saved key is still there');
});
await test('a touch, key, wheel or pointer press starts the half hour again', async () => {
  fire('pointerdown'); minutes(29); tick();
  assert.deepEqual(idled, [], 'twenty-nine minutes after the press');
  fire('wheel'); minutes(29); tick(); fire('keydown'); minutes(29); tick(); fire('touchstart'); minutes(29); tick();
  assert.deepEqual(idled, []);
});
await test('after IDLE with no use the page is told, with the words to show, and the saved key is let go', async () => {
  tabKeyWrite({ mode: 'eth', priv: PRIV, pubHex: '02' + 'b'.repeat(64), address: '0x' + 'c'.repeat(40) });
  minutes(31); tick();
  assert.deepEqual(idled, [IDLE_WHY]);
  assert.match(IDLE_WHY, /30 minutes/);
  assert.equal(tabKeyRead(), null, 'the tab no longer holds the key');
});
await test('it is told once, not every thirty seconds', async () => {
  minutes(1); tick(); tick();
  assert.equal(idled.length, 1);
});
await test('an action that is running is use: the key is not locked out from under it', async () => {
  idled = []; working = true;
  fire('pointerdown');
  minutes(45); tick();
  assert.deepEqual(idled, [], 'forty-five minutes into a running action');
  working = false; minutes(29); tick();
  assert.deepEqual(idled, [], 'and the half hour starts when it ends');
  minutes(2); tick();
  assert.equal(idled.length, 1, 'then it is locked');
});
await test('coming back to a tab that sat idle locks it at once, with no wait for the timer', async () => {
  idled = [];
  fire('pointerdown');
  document.hidden = true; minutes(120); document.hidden = false;
  (docHandlers.visibilitychange || []).forEach((f) => f());
  assert.equal(idled.length, 1);
});
await test('a page that gives no onIdle just has the saved key let go', async () => {
  const quiet = tabKeyWatch({});
  fire('pointerdown'); tabKeyWrite({ mode: 'eth', priv: PRIV, pubHex: '02' + 'b'.repeat(64) });
  minutes(31); quiet();
  assert.equal(tabKeyRead(), null);
});

await test('a pasted key is held by the tab like any other until the idle time, and the pages say so', async () => {
  const { readFileSync } = await import('node:fs');
  fire('pointerdown');
  tabKeyWrite({ mode: 'key', priv: PRIV, pubHex: '02' + 'b'.repeat(64) });
  minutes(10);
  assert.equal(tabKeyRead()?.mode, 'key', 'a reload within the half hour reads it back');
  for (const f of ['front/sheets.js', 'pay/index.html', 'pay/eth/index.html']) {
    const src = readFileSync(new URL('../dapp/' + f, import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => /k\.mode === 'key' \? '/.test(l)) || '';
    assert.doesNotMatch(line, /closing the tab forgets/, f);
    assert.match(line, /30 minutes without use/, f);
  }
});

console.log(failed ? `\n${failed} failed` : '\nall tab-key idle checks passed');
process.exit(failed ? 1 : 0);
