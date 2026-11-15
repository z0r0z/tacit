#!/usr/bin/env node
// The Bridge tab's wallet sources (USDT, a token the pool holds, TAC, ETH) are made private before they cross to Bitcoin. The
// relay settles that step in its own time, and the box's amount is cleared when it is handed off; after it the page used to stop at
// "Make … private: done" with no bridge. hxThenBridge waits for that step to settle, reads the private balance, puts the amount
// back and shows the bridge's own review (one more press bridges it: a burn is never sent without it). Its source is taken from the
// front page and run against stand-ins for the page's globals:
//   · a wrap handed to the relay: waits while it is pending, then restores the amount and shows the review with "Your USDT is private."
//   · a wrap that finished in place (never handed off) goes straight on
//   · a failed wrap, a short private balance, a new source, a new amount, another key, a busy button, a long wait: nothing is shown
//   · each of the four wallet sources starts it after its wrap, with the asset it bridges
//   node tests/bridge-then-bridge.test.mjs
import { readFileSync } from 'node:fs';
const PAGE = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const start = PAGE.indexOf('async function hxThenBridge('), end = PAGE.indexOf('\nasync function hxDepositGo(', start);
ok(start > 0 && end > start, 'hxThenBridge is on the front page');
const SRC = PAGE.slice(start, end);

// a world for one run: `steps` are applied one per sleep (the page's 4-second poll), so a test can change things mid-wait
function world({ op = { status: 'pending' }, away = true, held = 11110000n, steps = [], quote = { needPrivate: false }, goBusy = false } = {}) {
  const w = { calls: [], typed: 0, scans: 0, clock: 0, ops: { op1: op } };
  w.S = { key: { pubHex: 'pk1' } };
  w.HX = { tab: 'bridge', sf: 'wusdt', from: 'wusdt', mode: 'xo', amt: '', q: null };
  w.box = { value: '' };
  const env = {
    S: w.S, HX: w.HX,
    actGet: (id) => w.ops[id] || null,
    okStatus: (s) => s === 'settled' || s === 'confirmed', badStatus: (s) => s === 'failed' || s === 'unknown',
    scanPrivate: async () => { w.scans++; },
    spendable: (k) => (k === 'cusdt' ? held : 0n),
    hxTyped: () => { w.typed++; w.HX.q = { busy: false, ...quote }; },
    hxBridgeOutGo: async (a, units, lead) => { w.calls.push({ a: a.key, units, lead }); },
    $: (sel) => (sel === '#hx-amt' ? w.box : sel === '#hx-go' ? { getAttribute: () => (goBusy ? 'true' : null) } : null),
    sleep: async () => { w.clock += 4000; const f = steps.shift(); if (f) f(w); },
  };
  const realNow = Date.now;
  w.run = async (run, a, units, amt, sym, covered) => {
    Date.now = () => 1e12 + w.clock;
    try {
      const fn = new Function(...Object.keys(env), `${SRC}\nreturn hxThenBridge;`)(...Object.values(env));
      await (covered ? fn(run, a, units, amt, sym, covered) : fn(run, a, units, amt, sym));
    } finally { Date.now = realNow; }
  };
  return w;
}
const CUSDT = { key: 'cusdt', k: 'cusdt' };

{ // handed off, pending for two polls, then settled
  const w = world({ steps: [() => {}, (w) => { w.ops.op1.status = 'settled'; }] });
  await w.run({ op: 'op1', away: true }, CUSDT, 11110000n, '11.11', 'USDT');
  ok(w.calls.length === 1 && w.calls[0].a === 'cusdt' && w.calls[0].units === 11110000n, 'once the wrap settles, the bridge review is shown for the same amount');
  ok(w.calls[0]?.lead === 'Your USDT is private. ', 'and it leads with what just happened');
  ok(w.HX.amt === '11.11' && w.box.value === '11.11' && w.typed === 1, 'the amount the handoff cleared is put back, and quoted');
  ok(w.scans === 1 && w.clock >= 8000, 'it waited for the settle and read the private balance once');
}
{ // finished in place
  const w = world({ op: null, away: false });
  await w.run({ op: null, away: false }, CUSDT, 11110000n, '11.11', 'USDT');
  ok(w.calls.length === 1 && w.clock === 0, 'a wrap that finished in place goes straight to the review');
}
{ // the amount still in the box: no re-typing
  const w = world({ op: { status: 'settled' } });
  w.HX.amt = '11.11';
  await w.run({ op: 'op1', away: true }, CUSDT, 11110000n, '11.11', 'USDT');
  ok(w.calls.length === 1 && w.HX.amt === '11.11' && w.typed === 1, 'an amount still in the box is kept, and quoted afresh against the new private balance');
}
const none = async (label, opts, tweak, args = {}) => {
  const w = world(opts);
  tweak?.(w);
  await w.run(args.run === undefined ? { op: 'op1', away: true } : args.run, CUSDT, 11110000n, args.amt ?? '11.11', 'USDT');
  ok(w.calls.length === 0, label);
  return w;
};
await none('a wrap that failed shows nothing', { op: { status: 'failed' } });
{ const w = await none('a private balance short of the amount shows nothing', { op: { status: 'settled' }, held: 11109999n }); ok(w.HX.amt === '' && w.typed === 0, 'and the box is left empty'); }
await none('another source picked during the wait ends it', { steps: [(w) => { w.HX.sf = 'cusdt'; w.ops.op1.status = 'settled'; }] });
await none('a new amount typed during the wait ends it', { steps: [(w) => { w.HX.amt = '5'; w.ops.op1.status = 'settled'; }] });
await none('another key opened during the wait ends it', { steps: [(w) => { w.S.key = { pubHex: 'pk2' }; w.ops.op1.status = 'settled'; }] });
await none('leaving the Bridge tab ends it', { steps: [(w) => { w.HX.tab = 'swap'; w.ops.op1.status = 'settled'; }] });
await none('a busy button shows nothing', { op: { status: 'settled' }, goBusy: true });
await none('a quote that still asks to make it private shows nothing', { op: { status: 'settled' }, quote: { needPrivate: true } });
await none('no run (the wrap never started) shows nothing', {}, null, { run: null });
await none('no amount shows nothing', { op: { status: 'settled' } }, null, { amt: '' });
{ // never settles: gives up after half an hour
  const w = world({ steps: Array.from({ length: 1000 }, () => () => {}) });
  await w.run({ op: 'op1', away: true }, CUSDT, 11110000n, '11.11', 'USDT');
  ok(w.calls.length === 0 && w.clock > 30 * 60e3 && w.clock < 31 * 60e3, 'a wrap still pending after 30 minutes is left to Activity');
}
{ // ETH: its own test for "covered"
  const w = world({ op: { status: 'settled' }, quote: {} });
  let two = true;
  w.HX.sf = 'ether'; w.HX.from = 'ether'; w.HX.mode = 'btc';
  const env2 = w; env2.ops.op1.status = 'settled';
  two = false;
  await w.run({ op: 'op1', away: true }, { key: 'cusdt', k: 'cusdt' }, 11110000n, '11.11', 'ETH', () => !two);
  ok(w.calls.length === 1 && w.calls[0].lead === 'Your ETH is private. ', 'the ETH source uses its own test of being covered');
}

// the four wallet sources start it after their wrap
const body = (name) => { const s = PAGE.indexOf(`async function ${name}(`); return PAGE.slice(s, PAGE.indexOf('\n}\n', s)); };
for (const [name, want] of [['hxBridgeUsdtWrapGo', "hxThenBridge(job, XA.cusdt, units, amt, 'USDT')"], ['hxBridgeTokenWrapGo', 'hxThenBridge(job, a, units, amt, r.sym)'],
  ['hxBridgeTacWrapGo', "hxThenBridge(job, XA.tac, units, amt, 'TAC')"], ['hxBridgeWrapGo', "hxThenBridge(job, XA.teth, units, amt, 'ETH', () => !hxTwo(units))"]]) {
  const b = body(name);
  ok(b.includes(want) && b.indexOf(want) > b.lastIndexOf('await hxSendRun('), `${name} starts it after its wrap, not awaited`);
  ok(/const [^;]*amt = HX\.amt/.test(b) && /job = run/.test(b), `${name} keeps the amount and the run before the handoff clears the box`);
}
ok(/async function hxBridgeOutGo\(a, units, lead = ''\)/.test(PAGE) && (body('hxBridgeOutGo').match(/html`\$\{lead\}/g) || []).length === 2, 'the bridge review takes the lead in both of its forms');

console.log(`\n${n} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
