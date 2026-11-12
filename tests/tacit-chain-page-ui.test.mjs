// The tacit chain's page (dapp/chain/ui.js) drawn on a DOM from a state: the one quiet line while the chain is not deployed, the chain's
// status as Ethereum and its leader give it, the key's side (its balance, its address with the publish button, what it has waiting), the
// links each waiting spend takes into the tile, and that nothing a stored entry holds is drawn as markup.
//   node tests/tacit-chain-page-ui.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountChain, keptView, hopView, hopsDue, fmtTac, sharePrice, ago, CARD } from '../dapp/chain/ui.js';

const TAC = 10n ** 8n, NOW = 1_800_000_000_000;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ok   ${name}`); };

function mount() {
  const dom = new JSDOM('<!doctype html><body><div id="chain"></div></body>', { url: 'https://tacit.finance/chain/' });
  const doc = dom.window.document, root = doc.getElementById('chain'), calls = [];
  const ui = mountChain({ root, actions: { signIn: () => calls.push('signIn'), copy: () => calls.push('copy'), publish: () => calls.push('publish'), lock: () => calls.push('lock') } });
  const text = (sel) => (root.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
  const rows = (sel) => Object.fromEntries([...root.querySelectorAll(`${sel} .kv`)].map((r) => [r.firstElementChild.textContent.trim(), r.lastElementChild.textContent.replace(/\s+/g, ' ').trim()]));
  return { dom, doc, root, ui, calls, text, rows };
}
const STATUS = { height: 1234, lastLanded: NOW / 1000 - 42, pool: 12_345n * TAC + 6_700_000n, shares: 12_300n * TAC, leader: { fee: 1_500_000n, shieldCap: 1000n * TAC, sweepFee: 4n * 10n ** 16n } };
const KEY = { address: 'tacit1' + 'q'.repeat(300), published: true, publishing: false, balance: 25n * TAC + 12_340_000n, kept: [], hops: [] };
const dep = { shares: '100', amount: '2500000000', cx: '0x' + '11'.repeat(32), cy: '0x' + '22'.repeat(32), body: '0x' + '33'.repeat(32) };

test('formatting: TAC, the share price, how long ago', () => {
  assert.equal(fmtTac(12_345n * TAC + 6_700_000n), '12,345.067');
  assert.equal(fmtTac(1_500_000n), '0.015');
  assert.equal(fmtTac(0n), '0');
  assert.equal(sharePrice(0n, 0n), '1.000000');
  assert.equal(sharePrice(1000n * TAC + 410_000n, 1000n * TAC), '1.000004');
  assert.equal(ago(3), 'just now');
  assert.equal(ago(42), '42 s ago');
  assert.equal(ago(600), '10 min ago');
  assert.equal(ago(7200), '2 h ago');
});

test('not deployed: one quiet line and nothing else', () => {
  const { root, ui } = mount();
  ui.render({ on: false, status: null, now: NOW, key: null });
  assert.equal(root.textContent.trim(), 'Not live yet');
  assert.equal(root.querySelectorAll('section, nav, a, button').length, 0);
});

test('live: the status rows, read from Ethereum and the leader', () => {
  const { ui, rows, root } = mount();
  ui.render({ on: true, status: null, now: NOW, key: null });
  assert.match(root.querySelector('#status').textContent, /Reading…/);
  ui.render({ on: true, status: STATUS, now: NOW, key: null });
  const r = rows('#status');
  assert.deepEqual(Object.keys(r), ['Status', 'Blocks', 'Last block', 'Share price', 'Pool', 'Leader fee', 'Shield cap']);
  assert.equal(r.Status, 'Live');
  assert.equal(r.Blocks, '1,234');
  assert.equal(r['Last block'], '42 s ago');
  assert.equal(r['Share price'], sharePrice(STATUS.pool, STATUS.shares));
  assert.equal(r.Pool, '12,345.067 TAC');
  assert.equal(r['Leader fee'], '0.015 TAC a move');
  assert.equal(r['Shield cap'], 'up to 1,000 TAC');
  assert.match(root.querySelector('#status [title]').getAttribute('title'), /What 1 TAC of shares from the start is worth now/);
  // the three ways into the tile, whatever the key
  assert.deepEqual([...root.querySelectorAll('#acts a')].map((a) => [a.textContent, a.getAttribute('href')]),
    [['Shield', CARD.shield], ['Send', CARD.send], ['Withdraw', CARD.out]]);
});

test('live: no blocks yet, no fee or cap, and a leader that does not answer', () => {
  const { ui, rows } = mount();
  ui.render({ on: true, status: { ...STATUS, lastLanded: 0, leader: { fee: 0n, shieldCap: null, sweepFee: 0n } }, now: NOW, key: null });
  let r = rows('#status');
  assert.equal(r['Last block'], 'none yet');
  assert.equal(r['Leader fee'], 'none');
  assert.equal(r['Shield cap'], 'none');
  ui.render({ on: true, status: { ...STATUS, leader: null }, now: NOW, key: null });
  r = rows('#status');
  assert.equal(r['Leader fee'], 'not answering');
  assert.equal(r['Shield cap'], 'not answering');
  assert.equal(r.Pool, '12,345.067 TAC');
});

test('live: the chain could not be read', () => {
  const { ui, root } = mount();
  ui.render({ on: true, status: 'error', now: NOW, key: null });
  assert.match(root.querySelector('#status').textContent, /Could not read the chain\. Try again in a moment\./);
  assert.equal(root.querySelectorAll('#status .kv').length, 0);
});

test('no key: a Sign in button that asks for one', () => {
  const { ui, root, calls } = mount();
  ui.render({ on: true, status: STATUS, now: NOW, key: null });
  const b = root.querySelector('#mine [data-act="signin"]');
  assert.equal(b.textContent, 'Open your wallet');
  b.click();
  assert.deepEqual(calls, ['signIn']);
});

test('a key: its balance and its address, copy and lock', () => {
  const { ui, root, rows, calls } = mount();
  ui.render({ on: true, status: STATUS, now: NOW, key: { ...KEY, balance: null, address: null } });
  let r = rows('#mine');
  assert.equal(r.Balance, 'Reading…');
  assert.match(r.Address, /Reading…/);
  assert.equal(root.querySelector('[data-act="copy"]'), null);
  ui.render({ on: true, status: STATUS, now: NOW, key: KEY });
  r = rows('#mine');
  assert.equal(r.Balance, '25.1234 TAC');
  assert.equal(root.querySelector('#mine .mono').textContent, KEY.address, 'the whole address stays in its row; the page shortens it to its ends');
  assert.equal(root.querySelector('#mine .mono .tv')?.getAttribute('tabindex'), '0', 'a tap or a focus opens the whole address');
  assert.match(r.Address, /Published/);
  assert.equal(root.querySelector('[data-act="publish"]'), null, 'no Publish once it is published');
  root.querySelector('[data-act="copy"]').click();
  root.querySelector('[data-act="lock"]').click();
  assert.deepEqual(calls, ['copy', 'lock']);
});

test('a key not yet published: Publish, then Publishing… while it goes', () => {
  const { ui, root, calls } = mount();
  ui.render({ on: true, status: STATUS, now: NOW, key: { ...KEY, published: null } });
  assert.equal(root.querySelector('[data-act="publish"]'), null, 'nothing while it is not known yet');
  ui.render({ on: true, status: STATUS, now: NOW, key: { ...KEY, published: false } });
  const b = root.querySelector('[data-act="publish"]');
  assert.equal(b.textContent, 'Publish');
  b.click();
  assert.deepEqual(calls, ['publish']);
  ui.render({ on: true, status: STATUS, now: NOW, key: { ...KEY, published: false, publishing: true }, note: 'Address copied.' });
  assert.equal(root.querySelector('[data-act="publish"]').textContent, 'Publishing…');
  assert.ok(root.querySelector('[data-act="publish"]').disabled);
  root.querySelector('[data-act="publish"]').click();
  assert.deepEqual(calls, ['publish'], 'a disabled Publish does nothing');
  assert.match(root.querySelector('#mine .status').textContent, /Address copied\./);
});

test('kept spends: what each is called, what it says and where its links go', () => {
  const now = NOW, old = now / 1000 - 8 * 86400;
  // a shield from the wallet whose deposit waits on Ethereum, past RECLAIM_AFTER
  let v = keptView({ kind: 'shield', units: '2500000000', deposit: dep, backAt: old + 7 * 86400 }, now);
  assert.equal(v.what, 'A shield of 25 TAC');
  assert.equal(v.say, 'has not landed.');
  assert.deepEqual(v.links, [{ label: 'Post it to Ethereum', href: CARD.shield }, { label: 'Take it back', href: CARD.shield }]);
  // not yet past it
  v = keptView({ kind: 'shield', units: '2500000000', deposit: dep, backAt: now / 1000 + 3600 }, now);
  assert.deepEqual(v.links.map((l) => l.label), ['Post it to Ethereum']);
  // a shield from the wallet through its inbox (a permit or a transfer)
  v = keptView({ kind: 'shield', units: '500000000', deposit: dep, inbox: '0x' + 'ab'.repeat(20), src: 'wallet', unswept: true, paid: false }, now);
  assert.equal(v.what, 'A shield of 5 TAC');
  assert.equal(v.say, 'is on its way to the Tacit chain.');
  assert.deepEqual(v.links, []);
  // a move from the private pool, its inbox paid and not swept
  v = keptView({ kind: 'shield', units: '4800000000', deposit: dep, inbox: '0x' + 'ab'.repeat(20), unswept: true, paid: true }, now);
  assert.equal(v.what, 'A move of 48 TAC from the private pool');
  assert.deepEqual(v.links, [{ label: 'Send it in', href: CARD.inbox }]);
  // swept, not landed: post it, or (once due) take it back into the pool
  v = keptView({ kind: 'shield', units: '4800000000', deposit: dep, inbox: '0x' + 'ab'.repeat(20), backAt: old }, now);
  assert.deepEqual(v.links, [{ label: 'Post it to Ethereum', href: CARD.inbox }, { label: 'Take it back', href: CARD.inbox }]);
  // a payment, posted to Ethereum already
  v = keptView({ kind: 'pay', units: '1000000000', forced: { tx: '0x' + '9'.repeat(64), at: 1 } }, now);
  assert.equal(v.what, 'A payment of 10 TAC');
  assert.equal(v.say, 'has not landed. Posted to Ethereum.');
  assert.deepEqual(v.links, []);
  // a withdrawal and a hop
  v = keptView({ kind: 'withdraw', units: '300000000' }, now);
  assert.equal(v.what, 'A withdrawal of 3 TAC');
  assert.deepEqual(v.links, [{ label: 'Post it to Ethereum', href: CARD.out }]);
  v = keptView({ kind: 'hop', units: '300000000' }, now);
  assert.equal(v.what, 'A move of 3 TAC to the private pool');
  assert.deepEqual(v.links, [{ label: 'Post it to Ethereum', href: CARD.hop }]);
  assert.equal(CARD.shield, '/#card=shield:wtac:chain');
  assert.equal(CARD.inbox, '/#card=shield:tac:chain');
  assert.equal(CARD.out, '/#card=shield:ctac:wallet');
  assert.equal(CARD.hop, '/#card=shield:ctac:defi');
  assert.equal(CARD.send, '/#card=send:ctac');
});

test('hops waiting: shown once they have waited five minutes', () => {
  const hs = [{ units: '700000000', commit: '0x' + '44'.repeat(32), at: NOW - 6 * 60e3 }, { units: '100000000', commit: '0x' + '55'.repeat(32), at: NOW - 60e3 }];
  assert.deepEqual(hopsDue(hs, NOW).map((h) => h.units), ['700000000']);
  assert.deepEqual(hopView(hs[0]), { what: 'A move of 7 TAC to the private pool', say: 'has not been sent on.', links: [{ label: 'Send it on', href: CARD.hop }] });
});

test('a key with something waiting: the list, with its links', () => {
  const { ui, root } = mount();
  ui.render({ on: true, status: STATUS, now: NOW, key: KEY });
  assert.equal(root.querySelector('#mine .kept'), null, 'nothing waiting, no list');
  const kept = [{ kind: 'shield', units: '2500000000', deposit: dep, backAt: NOW / 1000 - 10 }, { kind: 'pay', units: '1000000000', forced: { tx: '0x1', at: 1 } }];
  const hops = [{ units: '700000000', commit: '0x' + '44'.repeat(32), at: NOW - 6 * 60e3 }];
  ui.render({ on: true, status: STATUS, now: NOW, key: { ...KEY, kept, hops } });
  const items = [...root.querySelectorAll('#mine .kept li')];
  assert.equal(items.length, 3);
  assert.match(items[0].textContent, /A shield of 25 TAC has not landed\./);
  assert.deepEqual([...items[0].querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]), [['Post it to Ethereum', CARD.shield], ['Take it back', CARD.shield]]);
  assert.match(items[1].textContent, /A payment of 10 TAC has not landed\. Posted to Ethereum\./);
  assert.equal(items[1].querySelectorAll('a').length, 0);
  assert.match(items[2].textContent, /A move of 7 TAC to the private pool has not been sent on\./);
  assert.equal(items[2].querySelector('a').getAttribute('href'), CARD.hop);
});

test('what a stored entry holds is drawn as text, never as markup', () => {
  const { ui, root } = mount();
  const evil = '<img src=x onerror="window.__x=1">';
  ui.render({ on: true, status: STATUS, now: NOW, key: { ...KEY, address: `tacit1${evil}`, kept: [{ kind: 'pay', units: `1${evil}` }] }, note: evil });
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.ok(root.textContent.includes('<img'), 'the text shows as written');
});

test('a redraw of the same state leaves the page as it was', () => {
  const { ui, root } = mount();
  ui.render({ on: true, status: STATUS, now: NOW, key: KEY });
  const b = root.querySelector('[data-act="copy"]');
  ui.render({ on: true, status: STATUS, now: NOW, key: KEY });
  assert.equal(root.querySelector('[data-act="copy"]'), b, 'the same button, so its focus stays');
});

console.log(`\n${n} ok`);
