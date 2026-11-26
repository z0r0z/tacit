// The front page's loan repayment (dapp/index.html, BWX.repay): the engine takes a burn of the debt up to 1% over it and refuses more (CollateralEngine.onCdpClose:
// `repaid > owed + owed / 100` is BadRepayment), so the notes burned must be the exact debt unless the extra is inside that band. The real method is cut out of the
// page and run against stand-ins: a note larger than the loan by more than the band is cut to the loan (combining notes where one cannot pay the cut's fee), however the
// cut's fee compares with the extra; an extra inside the band is the old 'Repay anyway'; an exact note goes straight through.
//   node --test tests/cdp-repay-exact-note.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
const start = page.indexOf('  async repay(run, where, btn, pos) {'), end = page.indexOf('\n  },\n', start);
assert.ok(start > 0 && end > start, 'the page has BWX.repay');
const SRC = page.slice(start, end + 4);
const NAMES = ['LOCK', 'LN', 'getUx', 'walletPriv', 'lockKey', 'say', 'fmt', 'freeNotes', 'scanPrivate', 'noteFor', 'proveOr', 'html', 'txLink', 'toast', 'settleBorrow', 'store', 'kNote', 'sayErr', 'your'];
const U = 10n ** 8n, cusd = (x) => BigInt(Math.round(x * 1e8)), ASSET = '0xc0';

function rig({ notes, debt = 6.11, split = 0.57 }) {
  const log = { say: [], err: [], cut: [], burned: null, proved: 0, btn: { textContent: 'Repay and close' } };
  const note = (v, i) => ({ asset: ASSET, value: String(cusd(v)), leaf: `0x${i}` });
  const own = notes.map(note);
  const stub = {
    LOCK: { state: { pos: { debtValue: String(cusd(debt)) }, rec: { vBtc: '20000' } }, repayOver: null },
    LN: { positions: async () => [], ownerKey: async () => 'owner', positionLeaf: () => ({ leaf: 'L', basket: [], debtAsset: ASSET }), repayArgs: (t, priv, a) => { log.burned = a.picked.map((n) => BigInt(n.value)); return a; }, repaid() {} },
    getUx: async () => ({ cdpPositionTree: async () => ({ indexOf: () => 1 }), balance: async () => ({ notes: own }), quoteOpFee: async () => String(cusd(split)), defiActions: () => ({}) }),
    walletPriv: () => 'priv', lockKey: () => 'k', say: (e, v) => { log.say.push(String(v?.s ?? v)); }, fmt: (v, d, n) => (Number(v) / 10 ** d).toFixed(n),
    freeNotes: (ns) => ns, scanPrivate: async () => ({ cusd: { id: ASSET } }),
    noteFor: async (run, t, priv, amount) => { log.cut.push(amount); return { asset: ASSET, value: String(amount), leaf: '0xcut' }; },
    proveOr: async (o) => { log.proved++; return { txHash: '0xabc' }; },
    html: (s, ...v) => ({ s: s.reduce((a, x, i) => a + (v[i - 1]?.s ?? v[i - 1] ?? '') + x) }), txLink: () => '', toast() {}, settleBorrow: async () => {},
    store: { get: () => null, set() {} }, kNote: (n) => `n:${n.leaf}`, sayErr: (e, err) => { log.err.push(err.message); }, your: () => 'your wallet',
  };
  const api = new Function(...NAMES, `const BWX = ({ ${SRC} });\nreturn BWX;`)(...NAMES.map((k) => stub[k]));
  const run = { take() {}, wait: () => ({}) };
  return { log, press: () => api.repay(run, () => ({ textContent: '' }), log.btn), stub };
}

test('a single note far over the loan is cut to the loan, not burned whole (the engine would refuse 6.55 for 6.11)', async () => {
  const r = rig({ notes: [6.55, 0.53] });
  await r.press();
  assert.deepEqual(r.log.err, [], 'no prompt to repay anyway');
  assert.deepEqual(r.log.cut, [cusd(6.11)], 'the exact loan is cut once (noteFor, which combines notes where one cannot pay the cut’s fee)');
  assert.deepEqual(r.log.burned, [cusd(6.11)], 'and the burned note is exactly the loan');
  assert.equal(r.log.proved, 1);
  assert.equal(r.log.btn.textContent, 'Repay and close', 'the button keeps its label');
});

test('the cut is made even when its fee is more than the extra it saves (0.44 extra, 0.57 fee)', async () => {
  const r = rig({ notes: [6.55] });
  await r.press();
  assert.equal(r.log.cut.length, 1); assert.deepEqual(r.log.burned, [cusd(6.11)]);
});

test('an extra inside the 1% band is the old Repay anyway: asked once, then the note is burned as it is', async () => {
  const r = rig({ notes: [6.15] });                                  // 0.04 over 6.11, under 1% of it (0.0611) and under the cut's fee
  await r.press();
  assert.equal(r.log.proved, 0, 'the first press asks');
  assert.match(r.log.err[0], /extra 0\.04 is not returned/);
  assert.equal(r.log.btn.textContent, 'Repay anyway');
  assert.deepEqual(r.log.cut, [], 'nothing is cut');
  await r.press();
  assert.equal(r.log.proved, 1); assert.deepEqual(r.log.burned, [cusd(6.15)], 'the second press burns the note as it is, inside the band');
});

test('an extra over the cut’s fee is cut, as before', async () => {
  const r = rig({ notes: [8.0] });
  await r.press();
  assert.deepEqual(r.log.cut, [cusd(6.11)]); assert.deepEqual(r.log.burned, [cusd(6.11)]); assert.deepEqual(r.log.err, []);
});

test('an exact note goes straight through, and a balance short of the loan is said', async () => {
  const r = rig({ notes: [6.11] });
  await r.press();
  assert.deepEqual(r.log.cut, []); assert.deepEqual(r.log.burned, [cusd(6.11)]); assert.equal(r.log.proved, 1);
  const s = rig({ notes: [3.0, 2.0] });
  await s.press();
  assert.equal(s.log.proved, 0); assert.match(s.log.err[0], /A loan is repaid whole, and this one needs 6\.11 cUSD held privately\. You hold 5\.00: 1\.11 more is needed/);
});

test('with a note a hair over the loan and the cut dearer than the extra, only the band decides', async () => {
  // exactly at the band: 6.11 + 1% = 6.1711: still asked once; one unit over it is cut
  const inBand = rig({ notes: [Number(cusd(6.11) + cusd(6.11) / 100n) / 1e8] });
  await inBand.press();
  assert.equal(inBand.log.cut.length, 0); assert.match(inBand.log.err[0] || '', /Repay anyway|extra/);
  const over = rig({ notes: [Number(cusd(6.11) + cusd(6.11) / 100n + 1000000n) / 1e8] });
  await over.press();
  assert.equal(over.log.cut.length, 1, 'past the band the exact note is cut');
});
