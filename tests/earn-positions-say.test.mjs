// What the Earn card's "Yours" panel (dapp/index.html, hxPosPaint and its click handler) tells a person while they press Claim, Withdraw all or Exit, found by pressing every one of them live with a real
// wallet on 2026-11-23: an exit once ended on a blank line (the card was drawn again and the confirmation went with it), the last press's "Out: …" stayed up as the next exit began, nothing said how much
// came back, and the rewards an exit gives up (under the relay fee) were never mentioned. Each is pinned here against the page's source, since the handler lives inside the page.
//   node --test tests/earn-positions-say.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'dapp', 'index.html'), 'utf8');
const paint = src.slice(src.indexOf('function hxPosPaint()'), src.indexOf('function hxBwRows()'));
const handler = paint.slice(paint.indexOf('el.onclick = (e) => {'));

test('the panel exists where these tests look', () => {
  assert.ok(paint.length > 2000, 'hxPosPaint was found');
  assert.ok(handler.includes('data-pexit') && handler.includes('exitPosition('), 'its click handler was found');
});

test('a repaint puts the line a press ended on back, so a confirmation is not wiped before it is read', () => {
  const before = paint.slice(0, paint.indexOf('el.onclick = (e) => {'));
  assert.match(before, /\$\('#hx-pos-s'\)[^\n]*FLASH\['hx-pos-s'\][^\n]*mount\(said, FLASH\['hx-pos-s'\]\)/, 'an empty status line is filled from what say() kept for it');
  // say() keeps what it writes for an element with an id (FLASH[el.id]); the status line has one
  assert.match(src, /const say = \(el, view\) => \{[^\n]*FLASH\[el\.id\] = v/);
  assert.match(src, /<p class="q" id="hx-pos-s" aria-live="polite"><\/p>/);
});

test('a new press clears the last press\'s confirmation before it starts', () => {
  const i = handler.indexOf("busy(b, async (run) => {"), t = handler.indexOf("tell('');"), first = handler.indexOf('if (claim) {');
  assert.ok(i > 0 && t > i && t < first, "tell('') comes right after the press starts and before any branch says anything");
});

test('Exit says in figures what came back, and what it gave up', () => {
  const exit = handler.slice(handler.indexOf('const worth = sharesEth(r.p, big(r.pos.shares))'), handler.indexOf('} catch (e) {'));
  assert.match(exit, /Out: your liquidity\$\{worth != null \? ` \(\$\{aboutEth\(worth\)\}\)` : ''\} is private \$\{pairName\(r\.p\.pair\)\} notes again/, 'the liquidity\'s worth, as the row showed it, is in the line');
  assert.match(exit, /run\.left > 0n \? html` The \$\{unclaimed\} TAC it had earned was too small to collect, so it stayed in the farm\.`/, 'rewards under the relay fee are named, not dropped without a word');
  assert.match(exit, /const worth = [^\n]*unclaimed = r\.pos\.pendingTac;\n\s*const out = await exitPosition/, 'both are read before the exit changes the position');
  assert.match(exit, /Unbonded\.<\/span> The liquidity note has not shown up yet\./, 'the unseen case is still said');
});

test('Withdraw all says how much ETH and TAC it sent to the wallet, and the TAC it earned', () => {
  const wd = handler.slice(handler.indexOf("} else if (b.dataset.pwd != null) {"), handler.indexOf("} else if (b.dataset.pbond != null) {"));
  assert.match(wd, /const had = r\.pub\.mine, earned = earnedNow\(r\.pub\);\n\s*const h = await pubExitSend/, 'the stake is read before it is withdrawn');
  assert.match(wd, /Withdrawn to \$\{your\(\)\}: about \$\{fmt\(had\.eth, 18, 4\)\} ETH and \$\{fmt\(had\.tac, 18, 2\)\} TAC\$\{earned > 0n \? `, and the \$\{tacShort\(earned\)\} TAC it earned` : ''\}\./);
});

test('a row whose rewards are under the relay fee says so in the row, not only in the button\'s tooltip', () => {
  assert.match(paint, /\$\{earned \? `\+\$\{r\.pos\.pendingTac\} TAC\$\{dust \? ' · too small to collect yet' : ''\}` : 'farming'\}/);
  assert.match(paint, /Earned \$\{r\.pos\.pendingTac\} TAC, less than the relay fee to collect it\. It keeps growing\./, 'the tooltip still gives the reason in full');
});
