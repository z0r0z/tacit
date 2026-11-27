// After a shield from the landing card, the swap tab shows the new private tETH without a reload.
//
// The swap card keeps its own read of the private balance (PV.held, read once and kept). A shield from the landing card (dapp/index.html wrapNow, sheet '') used to leave it
// as it was, so the swap tab said 0 until a reload. Now: hxMoveAfter asks the card (privateChanged -> privAgain in dapp/swap/card.js) to read it again, and again a few times
// while the figure has not changed (the new note can be a moment behind); wrapNow repaints once more when the scan its sends start has finished; and noteLanded is not
// limited to the wallet sheet.
//
// Run: node tests/front-shield-refresh.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frontPage } from './lib/front-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = frontPage(join(ROOT, 'dapp/index.html'));
const card = readFileSync(join(ROOT, 'dapp/swap/card.js'), 'utf8');

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const cut = (text, from, to) => {
  const a = text.indexOf(from), b = text.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)} .. ${JSON.stringify(to)}`);
  return text.slice(a, b);
};
const run = (src, scope, expose) => new Function('scope', `with (scope) { ${src}\nreturn { ${expose} }; }`)(new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t }));

await test('the landing card tells the swap card its private funds moved', () => {
  ok(/const hxMoveAfter = \(\) => \{[^\n]*SWC\.card\?\.privateChanged\?\.\(\)/.test(page), 'hxMoveAfter does not call privateChanged');
  ok(/privateChanged: \(\) => privAgain\(\)/.test(card), 'the card does not expose privateChanged');
});

await test('noteLanded is not limited to the wallet sheet', () => {
  ok(!/sheet === 'eth'\) noteLanded/.test(page), 'a landing-card shield (sheet "") still skips noteLanded');
  ok(page.split('if (!token) noteLanded(').length === 3, 'both wrap paths should call noteLanded for any surface');
});

// privAgain, with a stand-in for the private reader: `reads` is the figure each read finds, in turn.
function reader(reads, { unlocked = true } = {}) {
  const log = { reads: 0, paints: 0, timers: [] };
  let held = reads[0] === undefined ? null : { v: 0n };
  const PV = { read: async () => { held = { v: reads[Math.min(log.reads++, reads.length - 1)] }; return held; } };
  const scope = {
    PV, H: { key: { session: { unlocked } } }, privBal: () => (held ? held.v : null), paint: () => { log.paints++; },
    setTimeout: (f, ms) => { log.timers.push({ f, ms }); return log.timers.length; },
  };
  return { ...run(cut(card, 'let privGen = 0;', 'async function openPrivate'), scope, 'privAgain'), log, set: (v) => { held = { v }; } };
}
const flush = () => new Promise((r) => setImmediate(r));

await test('a shield that shows at once reads once and paints the new figure', async () => {
  const r = reader([5n]); r.set(0n);
  r.privAgain(); await flush();
  ok(r.log.reads === 1 && r.log.paints === 1, `reads ${r.log.reads}, paints ${r.log.paints}`);
  ok(r.log.timers.length === 0, 'it kept asking after the figure changed');
});

await test('a note that is not in yet is asked for again, 8 s then 16 s then 24 s, then left', async () => {
  const r = reader([0n]); r.set(0n);
  r.privAgain(); await flush();
  for (let i = 0; i < 6 && r.log.timers.length > i; i++) { r.log.timers[i].f(); await flush(); }
  ok(r.log.timers.map((t) => t.ms).join() === '8000,16000,24000', `waits ${r.log.timers.map((t) => t.ms)}`);
  ok(r.log.reads === 4, `reads ${r.log.reads}`);
});

await test('a later read that finds the note stops the asking', async () => {
  const r = reader([0n, 5n]); r.set(0n);
  r.privAgain(); await flush();
  r.log.timers[0].f(); await flush();
  ok(r.log.reads === 2 && r.log.timers.length === 1, `reads ${r.log.reads}, timers ${r.log.timers.length}`);
});

await test('a newer press replaces an older one still waiting', async () => {
  const r = reader([0n]); r.set(0n);
  r.privAgain(); await flush();
  const p = r.log.paints;
  r.privAgain(); await flush();
  r.log.timers[0].f(); await flush();
  ok(r.log.paints === p + 1, 'the older chain painted after being replaced');
});

await test('nothing is read while the key is locked', async () => {
  const r = reader([5n], { unlocked: false });
  r.privAgain(); await flush();
  ok(r.log.reads === 0, 'read with no key');
});

// wrapNow's repaint: now, and again when the scan that sendVouchers started has finished.
await test('wrapNow repaints again when the scan its send started finishes', async () => {
  const head = cut(page, "async function wrapNow({", '  if (Date.now() - x.at');
  let paints = 0, done;
  const P = { scanning: new Promise((r) => { done = r; }) };
  const after = new Function('P', 'paint', head.replace(/^async function wrapNow\([^\n]*\n/, '').replace(/^\s*\/\/[^\n]*\n/, '') + '\nreturn after;')(P, () => { paints++; });
  after();
  ok(paints === 1, 'no immediate repaint');
  done(); await flush();
  ok(paints === 2, `paints ${paints}`);
});

// The deposit wrapNow sends pays the tip the form showed, and nothing in wrapNow puts another tip in its place.
await test('wrapNow deposits with the tip the form showed', async () => {
  const body = cut(page, 'async function wrapNow({', '\nconst getNames = ');
  ok(/value: x\.wei \+ x\.tip,/.test(body), 'the deposit is the amount and the shown tip');
  ok(!/\bx = \{/.test(body) && !/x\.tip = /.test(body), 'the shown tip is not replaced');
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
