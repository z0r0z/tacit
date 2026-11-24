// The Earn card's private Exit (dapp/index.html exitPosition): after the unbond lands, the liquidity note may take a while to show in the scan (the off-market pools' took
// minutes). The exit looks again for about a minute, saying so, before it ends on 'unseen', and that ending says what happens next.
//   node --test tests/exit-unseen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
const cut = (a, b) => { const s = html.indexOf(a), e = html.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the page has ${a}`); return html.slice(s, e); };
const src = cut('async function exitPosition(', '\nconst lpShare');
function world({ appearsOnScan = null, appearsOnUnbond = false } = {}) {
  const w = { notes: [], scans: 0, slept: 0, said: [], took: 0, unbonded: 0 };
  const P = { get scan() { return { notes: w.notes }; } };
  const stubs = {
    takePosition() {}, getUx: async () => ({}), big: (x) => BigInt(x || 0), HARVEST_WORTH: 10n ** 30n, rewardWorth: async () => false, stepHarvest: async () => {},
    samePos: (x) => x, stepOf: (tell) => tell, freeNotes: (n) => n, P, isLp: () => () => true, kNote: (n) => n.id,
    stepUnbond: async () => { w.unbonded++; if (appearsOnUnbond) w.notes = [{ id: 'new', value: '5' }]; },
    stepTakeOut: async () => { w.took++; return true; },
    scanPrivate: async () => { w.scans++; if (appearsOnScan != null && w.scans >= appearsOnScan) w.notes = [{ id: 'new', value: '5' }]; },
    sleep: async () => { w.slept++; },
  };
  const { exitPosition } = new Function(...Object.keys(stubs), `${src}\nreturn { exitPosition };`)(...Object.values(stubs));
  return { w, run: () => exitPosition({ run: {}, take() {} }, { pair: 'cETH/cUSD' }, { pendingUnits: '0' }, (m) => w.said.push(String(m)), null) };
}
test('a note that shows up on the third look ends the exit with the take-out, not "unseen"', async () => {
  const { w, run } = world({ appearsOnScan: 3 });
  assert.equal(await run(), 'out');
  assert.deepEqual([w.unbonded, w.scans, w.took], [1, 3, 1]);
  assert.match(w.said[0], /Waiting for your liquidity note to show up/, 'and the status line said it was waiting');
});
test('a note that never shows is looked for about a minute (12 looks, 5 s apart), then reported as unseen', async () => {
  const { w, run } = world();
  assert.equal(await run(), 'unseen');
  assert.deepEqual([w.scans, w.slept, w.took], [12, 12, 0]);
});
test('a note that is there as the unbond completes is taken out at once, with no waiting', async () => {
  const { w, run } = world({ appearsOnUnbond: true });
  assert.equal(await run(), 'out');
  assert.deepEqual([w.scans, w.slept, w.took], [0, 0, 1]);
  assert.equal(w.said.length, 0, 'nothing about waiting was said');
});
test('a note that was already in the scan before the unbond is not taken for the new one', async () => {
  const { w, run } = world();
  w.notes = [{ id: 'old', value: '5' }];
  assert.equal(await run(), 'unseen');
  assert.equal(w.took, 0);
});
test('the unseen ending says what comes next', () => {
  assert.match(html, /Its liquidity note is still being found: in a minute this row reads LP only, and Take out gives you both coins\./);
  assert.doesNotMatch(html, /The liquidity note has not shown up yet\./);
});
