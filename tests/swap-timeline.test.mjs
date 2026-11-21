// A private swap or send keeps a timeline of its steps (dapp/swap/private.js mark / timeline / marked), and waits for a freshly cut note with short pauses.
//
// 2026-11-19: a tETH to cUSD swap took 3 minutes, 50 s of it between the split landing and the swap being posted; the code alone did not say where. A read of the private balance takes
// 2-5 s (measured with the canary key on the live site: 8,676 leaves, new leaves included), and the loop that waits for the cut note slept 5 s after each read, so the pause is 1.5 s now:
// the same ceiling, asked about more often. Each step marks when it began, and `copy(tacitTimeline())` in the console shows them, so the next one says where its time went.
//
// Run: node tests/swap-timeline.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp/swap/private.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = (label, fn) => { try { fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };

// the timeline's own code, cut out and run on its own
const start = src.indexOf('  const TL = [];'), tail = src.indexOf('  const marked = ');
const markedEnd = src.indexOf('\n', tail);
ok(start > 0 && tail > start && markedEnd > tail, 'the timeline code is not where it should be');
const make = () => {
  const win = {};
  const logged = [];
  const fns = new Function('window', 'console', `${src.slice(start, markedEnd)}\nreturn { mark, timeline, marked, TL };`)(win, { debug: (...a) => logged.push(a.join(' ')) });
  return { ...fns, win, logged };
};

test('each step is marked with its time and how long since the one before, and listed oldest first', () => {
  const t = make();
  t.mark('swap begins'); t.mark('note in hand'); t.mark('route: begins');
  const l = t.timeline();
  ok(l.length === 3 && l[0].step === 'swap begins' && l[2].step === 'route: begins', JSON.stringify(l));
  ok(l[0].sinceMs === 0 && l.every((x) => Number.isFinite(x.sinceMs) && /^\d\d:\d\d:\d\d\.\d{3}$/.test(x.time)), `bad entries ${JSON.stringify(l)}`);
});

test('it is a hook on the page (copy(tacitTimeline()) in the console), written to the console, and never sent anywhere', () => {
  const t = make();
  ok(typeof t.win.tacitTimeline === 'function', 'no window.tacitTimeline');
  t.mark('x');
  ok(t.win.tacitTimeline().length === 1 && t.logged.some((x) => /tacit timeline/.test(x)), 'not in the console');
  const code = src.slice(start, markedEnd);
  ok(!/fetch\(|sendBeacon|XMLHttpRequest|localStorage|WebSocket/.test(code), 'the timeline code touches the network or storage');
});

test('only the last 60 steps are kept', () => {
  const t = make();
  for (let i = 0; i < 100; i++) t.mark(`s${i}`);
  ok(t.timeline().length === 60 && t.timeline()[0].step === 's40', `${t.timeline().length}`);
});

test('marking a job\'s posting wraps the wait object without changing what it does', () => {
  const t = make();
  const seen = [];
  const w = { timeoutMs: 5, onJob: (id, type) => { seen.push([id, type]); return 'x'; }, other: 1 };
  const m = t.marked(w, 'route');
  ok(m === w && m.other === 1 && m.timeoutMs === 5, 'the wait object was replaced');
  ok(m.onJob('0xabcdef0123456789', 'swap') === 'x' && JSON.stringify(seen) === '[["0xabcdef0123456789","swap"]]', 'the original onJob was not called with its arguments');
  ok(t.timeline().at(-1).step === 'route: job posted 0xabcdef0123', t.timeline().at(-1).step);
  const bare = t.marked({}, 'cut');
  ok(bare.onJob('0x1') === undefined, 'a wait object with no onJob must still work');
  ok(t.marked(null, 'x') === null && t.marked(undefined, 'x') === undefined, 'a missing wait object must pass through');
});

test('the wait for a freshly cut note, and for a swap\'s new note, asks every 1.5 s (a read is 2-5 s), up to 25 times', () => {
  const cut = src.slice(src.indexOf("mark('cut settled: looking for its note');"), src.indexOf("throw Object.assign(new Error('Your note was cut to size"));
  ok(/for \(let i = 0; i < 25; i\+\+\) \{/.test(cut) && /await sleep\(1500\);/.test(cut) && !/sleep\(5000\)/.test(cut), 'exactNote loop');
  const nn = src.slice(src.indexOf('async function newNote('), src.indexOf('async function newNote(') + 600);
  ok(/for \(let i = 0; i < 25; i\+\+\) \{/.test(nn) && /await sleep\(1500\);/.test(nn) && !/sleep\(5000\)/.test(nn), 'newNote loop');
});

test('the swap path marks where it is: begin, cut, note found, route begin, priced, posted', () => {
  for (const m of ["mark(`swap begins", "mark('cut settled: looking for its note')", 'its note shows (read', "mark('a note to spend is in hand')", "mark('route: begins')", "mark('route: priced')",
    "marked(run().wait(label, 15 * 60e3), 'route')", "'cut'"]) ok(src.includes(m), `missing ${m}`);
  ok(/TL\.length = 0;\n\s+mark\(`swap begins/.test(src), 'a new swap must start a new timeline');
  ok(/return \{\n\s+open, lock, reset, read, timeline, swap,/.test(src), 'timeline is not exported');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
