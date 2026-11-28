// The front page's points nudge for the week's multiplier (hxWeek in dapp/index.html) against the program that scores it: the
// same rule as worker-relay/src/lib/points-engagement.js, run on random histories and compared with the service's own
// countedRows, plus the wording of each step it names.
//   node tests/hx-points.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countedRows, KIND_OF } from '../worker-relay/src/lib/points-engagement.js';
import { frontPage } from './lib/front-page.mjs';

const page = frontPage(new URL('../dapp/index.html', import.meta.url));
const src = page.match(/function hxWeek\(sp, rows, today, kindOf, wt, kind, add\) \{[\s\S]*?\n\}\n/)?.[0];
assert.ok(src, 'hxWeek is in the page');
const hxWeek = new Function(`${src}; return hxWeek;`)();
const kindOf = (a) => KIND_OF[a] ?? a;
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const SPEC = { kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 };
const TODAY = 20737, DAY = 86400;
const row = (daysAgo, activity, points) => ({ block_time: String((TODAY - daysAgo) * DAY + 3600), activity, points });
const one = () => 1;

await test('the page and the service agree on the multiplier for random weeks', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const acts = Object.keys(KIND_OF);
  for (let i = 0; i < 4000; i++) {
    const spec = { kindStep: [0, 0.1, 0.25, 0.5][Math.floor(rnd() * 4)], returnStep: [0, 0.25, 0.5][Math.floor(rnd() * 3)], maxKinds: Math.floor(rnd() * 5), minPoints: [0, 10, 25, 100][Math.floor(rnd() * 4)] };
    const history = Array.from({ length: Math.floor(rnd() * 14) }, () => row(Math.floor(rnd() * 10), acts[Math.floor(rnd() * acts.length)], rnd() < 0.2 ? 0 : Math.round(rnd() * 200)));
    const act = rnd() < 0.5 ? 'wrap' : 'zswapeth', add = Math.round(rnd() * 150), weights = rnd() < 0.3 ? { [acts[Math.floor(rnd() * acts.length)]]: [0, 0.5, 2][Math.floor(rnd() * 3)] } : {};
    const wt = (a) => weights[a] ?? 1;
    // The service's reading: the day's rows (those of today, and this deposit) and the week's (the seven days ending today).
    const all = [...history.map((r) => ({ address: 'a', day: Math.floor(Number(r.block_time) / DAY), activity: r.activity, points: r.points })), { address: 'a', day: TODAY, activity: act, points: add }];
    const week = all.filter((r) => r.day > TODAY - 7 && r.day <= TODAY), dayRows = week.filter((r) => r.day === TODAY);
    const want = countedRows({ dayRows, weekRows: week, weights, spec }).find((r) => r.address === 'a').factor;
    const got = hxWeek(spec, history, TODAY, kindOf, wt, kindOf(act), add * wt(act)).f;
    assert.equal(got, want, `${JSON.stringify({ spec, history, act, add, weights })}: page ${got}, service ${want}`);
  }
});

await test('a first deposit of the week counts x1 and points to a second kind of activity', () => {
  const r = hxWeek(SPEC, [], TODAY, kindOf, one, 'private', 80);
  assert.equal(r.f, 1);
  assert.match(r.tip, /^Counts 1× toward today’s pot\. A swap or a loan this week lifts it to 1\.25×\.$/);
});

await test('another kind and a second day are each worth a step, and the tip names the next one', () => {
  const r = hxWeek(SPEC, [row(1, 'zswapeth', 100)], TODAY, kindOf, one, 'private', 80);
  assert.equal(r.f, 1.5);
  assert.match(r.tip, /^Counts 1\.5× toward today’s pot\. A loan or a \.wei name this week lifts it to 1\.75×\.$/);
  const same = hxWeek(SPEC, [row(0, 'wrap', 100)], TODAY, kindOf, one, 'private', 80);
  assert.equal(same.f, 1);
  const two = hxWeek({ ...SPEC, maxKinds: 0 }, [], TODAY, kindOf, one, 'private', 80);
  assert.match(two.tip, /^Counts 1× toward today’s pot\. Activity on a second day this week lifts it to 1\.25×\.$/);
});

await test('with every bonus in reach the tip says so, and says nothing where there is nothing to gain', () => {
  const full = hxWeek(SPEC, [row(1, 'zswapeth', 100), row(2, 'cusdmint', 100)], TODAY, kindOf, one, 'private', 80);
  assert.equal(full.f, 1.75);
  assert.equal(full.tip, 'This week counts 1.75× toward today’s pot, as much as it gets.');
  assert.equal(hxWeek({ ...SPEC, kindStep: 0, returnStep: 0 }, [], TODAY, kindOf, one, 'private', 80).tip, '');
});

await test('a deposit too small to count as its kind gets no tip, and the days outside the week are not counted', () => {
  assert.equal(hxWeek(SPEC, [row(1, 'zswapeth', 100)], TODAY, kindOf, one, 'private', 3).tip, '');
  const old = hxWeek(SPEC, [row(7, 'zswapeth', 100), row(8, 'cusdmint', 100)], TODAY, kindOf, one, 'private', 80);
  assert.equal(old.f, 1, 'seven days back is outside the window of the seven ending today');
  const edge = hxWeek(SPEC, [row(6, 'zswapeth', 100)], TODAY, kindOf, one, 'private', 80);
  assert.equal(edge.f, 1.5, 'six days back is inside it');
});

await test('an activity the program weights at 0 is neither a kind nor a day', () => {
  const wt = (a) => (a === 'zswapeth' ? 0 : 1);
  assert.equal(hxWeek(SPEC, [row(1, 'zswapeth', 100)], TODAY, kindOf, wt, 'private', 80).f, 1);
});

await test('the page takes the service\'s kinds of activity, and starts from the same list', () => {
  const start = new Function('return ' + page.match(/kinds: (\{ wrap: 'private'[^}]*\}),/)[1])();
  assert.deepEqual(start, KIND_OF, 'the page\'s starting kinds are the service\'s');
});

console.log(`${n} passed`);
