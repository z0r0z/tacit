// The Borrow card's note about bonds (dapp/index.html bondNotes): a bond just posted on a lock that is still pending is not told as "can come back to you".
//   node --test tests/borrow-bond-note.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frontPage } from './lib/front-page.mjs';
const html = frontPage(new URL('../dapp/index.html', import.meta.url));
const cut = (a, b) => { const s = html.indexOf(a), e = html.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the page has ${a}`); return html.slice(s, e); };
const { bondNotes, bondQuiet } = new Function('bondsNow', 'bondVia', `${cut('// a bond that can be taken back', '\nconst bondDue')}\nreturn { bondNotes, bondQuiet };`)(() => ({ locks: [] }), () => true);
const lock = (state, extra = {}) => ({ op: 'o1', state, bonds: [{ take: true, share: 4_700_000_000_000_000n, account: '0xa' }], total: 1n, health: null, ...extra });
test('a bond that can be taken back while the lock is pending is not shown on the card', () => {
  const notes = bondNotes({ locks: [lock('pending')] });
  assert.equal(notes.length, 1, 'it is a take note');
  assert.equal(bondQuiet(notes[0]), true);
  assert.equal(notes.find((n) => !bondQuiet(n)), undefined, 'so the card has nothing to say');
});
test('a bond that can come back after the lock is done, or one that is short or lost, is still said', () => {
  const done = bondNotes({ locks: [lock('redeemed')] });
  assert.equal(done.find((n) => !bondQuiet(n))?.kind, 'take');
  const short = bondNotes({ locks: [lock('pending', { bonds: [], health: { healthy: false, want: 10n, have: 4n, flaggedAt: 1 } })] });
  assert.equal(short.find((n) => !bondQuiet(n))?.kind, 'short');
  const lost = bondNotes({ locks: [lock('forfeit', { bonds: [] })] });
  assert.equal(lost.find((n) => !bondQuiet(n))?.kind, 'lost');
});
test('the card and the toast use the same rule', () => {
  assert.match(html, /const note = bondNotes\(\)\.find\(\(n\) => !bondQuiet\(n\)\);/);
  assert.match(html, /fresh = bondNotes\(r\)\.filter\(\(n\) => !seen\.has\(n\.id\) && !bondQuiet\(n\)\);/);
});
