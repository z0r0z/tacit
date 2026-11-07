// The tile after a press: what it leaves standing and what it stops saying. Read from the sources (card.js and index.html need a page to run).
//   node --test tests/tile-press-state.test.mjs
// (1) The card's clear() lets go of a quote in flight and tells the page the amount is gone: a Shield of all the wallet holds left the old amount
//     typed in the page, and the next quote (a balance read, a new private note) priced it against what the press left and warned "More ETH than your
//     wallet holds" over an empty card.
// (2) While a press is under way the page does not price the amount again when its notes are taken (a Send said "You hold 0 tETH" mid-send).
// (3) A relay result is drawn on the tile's own status line when the job settles (the Etherscan link stays), not only on a sheet's.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const card = readFileSync(new URL('../dapp/swap/card.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
const body = (src, head, end = '\n}\n') => { const i = src.indexOf(head); assert.ok(i >= 0, `${head} is in the source`); return src.slice(i, src.indexOf(end, i) + end.length); };

test('the card clears its move quote and tells the page the amount is gone', () => {
  const clear = card.match(/^ {4}clear: \(\) => \{.*\},$/m)?.[0];
  assert.ok(clear, 'the card has clear()');
  assert.match(clear, /clearTimeout\(qTimer\)/, 'a quote timer waiting is dropped');
  assert.match(clear, /S\.seq\+\+/, 'a quote already out is let go (its callback checks the sequence)');
  assert.match(clear, /H\.moves\?\.cleared\?\.\(mk\)/, 'and the page is told');
});

test('the page forgets the amount when the card is cleared', () => {
  const cleared = page.match(/^ {2}cleared: \(key\) => \{.*\},$/m)?.[0];
  assert.ok(cleared, 'the move host has cleared()');
  assert.match(cleared, /HX\.seq\+\+/, 'a quote still in flight for the old amount is dropped');
  assert.match(cleared, /hxMoveSet\(key, ''\)/, 'and the amount is empty here too');
});

test('a press under way is not priced again when its balance changes', () => {
  const sync = body(page, 'function hxSync() {');
  const guard = sync.indexOf('if (HX.sending || SWC.card?.busy) return;');
  assert.ok(guard > 0, 'hxSync stops while the Send tab or the card is pressing');
  for (const trigger of ['hxHeld() !== HX.held', 'hxSendHeld() !== HX.heldSend', 'hxHeldTac() !== HX.heldTac']) {
    assert.ok(sync.indexOf(trigger) > guard, `${trigger} is read after the guard`);
  }
});

test('a settled relay job is written on the tile\'s status line too', () => {
  assert.match(page, /const STATUS_AT = '\.status, #hx-ss, #hx-mz, #hx-zs';/);
  assert.ok(!/closest\('\.status'\)/.test(page), 'no line looks only for a sheet\'s status box');
  assert.match(body(page, 'function actSaid(it, prev) {'), /\[data-op="\$\{it\.id\}"\]`\)\?\.closest\(STATUS_AT\)/);
  for (const id of ['hx-ss', 'hx-mz', 'hx-zs']) assert.match(page, new RegExp(`className: 'q', id: '${id}'`), `${id} is a line the tile says its steps in`);
});
