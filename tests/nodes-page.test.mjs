// The nodes page (dapp/nodes/ui.js) on the page's own HTML: the leaderboard and the node list drawn from a status, what is said of the signature, a status
// that does not verify shown as nothing, the filter, the switch, and that nothing a status carries is read as markup.
//   /Users/z/.nvm/versions/node/v22.22.3/bin/node --test tests/nodes-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from './_jsdom.mjs';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { signDoc, checkDoc } from '../dapp/nodes-list.js';
import { mountNodes, trust, operatorName } from '../dapp/nodes/ui.js';

const PAGE = readFileSync(new URL('../dapp/nodes/index.html', import.meta.url), 'utf8');
const T = 1_800_000_000;
const priv = (n) => new Uint8Array(32).fill(n);
const pub = (n) => bytesToHex(secp.getPublicKey(priv(n), true));
const role = (r, o = {}) => ({ role: r, uptime: 0.99, correct: 1, fresh: 0.97, latency: 120, probes: 30, hard: 0, score: 9, ...o });
const node = (o) => ({ id: 'a'.repeat(16), url: 'https://eth.example.org', kind: 'eth', name: null, operator: pub(1), baseline: false, own: false, fronted: false, net: '1.2.3', state: 'listed', weight: 0.8, reliability: 0.99, cleanDays: 20, strikes: 0, lastOk: T - 60, roles: [role('eth-reads')], score: 9, ...o });
const op = (o) => ({ operator: pub(1), baseline: false, own: false, name: null, endpoints: 1, roles: ['eth-reads'], uptime: 0.99, correct: 1, fresh: 0.97, score: 9, rank: 1, ...o });
const STATUS = {
  v: 1, at: T - 120, day: Math.floor(T / 86400), signer: pub(9), points: 'off',
  nodes: [node({}), node({ id: 'b'.repeat(16), url: 'https://ethereum-rpc.publicnode.com', baseline: true, operator: 'baseline-public', name: 'PublicNode', roles: [role('eth-reads'), role('eth-logs', { correct: 0.8 })] }),
    node({ id: 'c'.repeat(16), url: 'https://node.tacit.finance/eth', baseline: true, own: true, operator: 'baseline-tacit', name: 'Tacit node' }), node({ id: 'd'.repeat(16), url: 'https://new.example.org', state: 'shadow', weight: 0, operator: pub(2) })],
  operators: [op({}), op({ operator: 'baseline-tacit', baseline: true, own: true, rank: 2, score: 0 }), op({ operator: 'baseline-public', baseline: true, rank: 3, score: 0, correct: 0.9 }), op({ operator: pub(2), rank: 4, score: 0, name: '<img src=x onerror=alert(1)>' })],
};
const signed = (s = STATUS, k = 9) => signDoc('status', { ...s, signer: pub(k) }, priv(k));
function setup({ status, pubs = [pub(9)], nodesOnly = null } = {}) {
  const dom = new JSDOM(PAGE);
  const doc = dom.window.document;
  const ui = mountNodes({ root: doc.querySelector('main'), load: async () => (status instanceof Error ? Promise.reject(status) : status), pubs, check: (s) => checkDoc('status', s, pubs), now: () => T, nodesOnly });
  return { dom, doc, ui, rows: (id) => [...doc.querySelectorAll(`#${id} tr`)].map((r) => [...r.children].map((td) => [...td.childNodes].map((n) => n.textContent).join(' ')).join(' ').replace(/\s+/g, ' ').trim()) };
}

test('a verified status draws the operators in rank order and every node with its state', async () => {
  const h = setup({ status: signed() });
  await h.ui.refresh();
  assert.match(h.doc.getElementById('sig').textContent, /^Signed by .*Verified\.$/);
  const ops = h.rows('ops-body');
  assert.equal(ops.length, 4);
  assert.match(ops[0], /^1 Operator 0[23][0-9a-f]{6}…[0-9a-f]{4} Ethereum reads 99% 97% 100% 9\.0$/);
  assert.match(ops[1], /^2 Tacit nodes .* –$/); assert.match(ops[2], /^3 Public services .* 90% –$/);
  const nodes = h.rows('nodes-body');
  assert.equal(nodes.length, 4);
  assert.match(nodes[0], /eth\.example\.org .*listed 0\.80 120 ms/);
  assert.match(nodes[1], /ethereum-rpc\.publicnode\.com PublicNode · Ethereum reads 99%\/100% · Ethereum logs 99%\/80% up – 120 ms/);
  assert.match(nodes[3], /new\.example\.org .*testing 0 /);
  assert.equal(h.doc.getElementById('ops').hidden, false); assert.equal(h.doc.getElementById('ops-empty').hidden, true);
});

test('a status that does not verify against the pinned key is not shown (fail closed)', async () => {
  for (const status of [signed(STATUS, 8), { ...signed(), nodes: [] }, { ...signed(), operators: [{ ...STATUS.operators[0], score: 99999 }] }]) {
    const h = setup({ status });
    await h.ui.refresh();
    assert.match(h.doc.getElementById('sig').textContent, /does not verify/);
    assert.equal(h.rows('ops-body').length, 0); assert.equal(h.rows('nodes-body').length, 0);
    assert.equal(h.doc.getElementById('ops').hidden, true); assert.equal(h.doc.getElementById('ops-empty').hidden, false);
  }
});

test('with no key pinned the figures are shown and the page says they are not verified', async () => {
  const h = setup({ status: STATUS, pubs: [] });
  await h.ui.refresh();
  assert.match(h.doc.getElementById('sig').textContent, /^Not verified: this build pins no signing key/);
  assert.equal(h.rows('ops-body').length, 4);
});

test('an unreadable or missing status shows a plain line and no rows', async () => {
  for (const status of [new Error('down'), null, { v: 2 }, { v: 1, nodes: 'x', operators: [] }]) {
    const h = setup({ status });
    await h.ui.refresh();
    assert.match(h.doc.getElementById('sig').textContent, /could not be loaded|not readable/);
    assert.equal(h.rows('ops-body').length, 0);
  }
});

test('a name or url in the status is text, never markup', async () => {
  const h = setup({ status: signed() });
  await h.ui.refresh();
  assert.equal(h.doc.querySelectorAll('main img').length, 0);
  assert.ok(h.doc.getElementById('ops-body').textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(operatorName({ name: 'x'.repeat(100), operator: pub(1) }).length, 40);
});

test('the filter narrows both lists and marks the pressed button', async () => {
  const h = setup({ status: signed() });
  await h.ui.refresh();
  const press = (f) => h.doc.querySelector(`#filter button[data-f="${f}"]`).click();
  press('community'); assert.equal(h.rows('ops-body').length, 2); assert.equal(h.rows('nodes-body').length, 2);
  press('tacit'); assert.equal(h.rows('ops-body').length, 1); assert.match(h.rows('nodes-body')[0], /node\.tacit\.finance/);
  press('public'); assert.equal(h.rows('nodes-body').length, 1);
  assert.equal(h.doc.querySelector('#filter button[data-f="public"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.querySelector('#filter button[data-f="all"]').getAttribute('aria-pressed'), 'false');
  press('all'); assert.equal(h.rows('nodes-body').length, 4);
});

test('the browser switch is stored and says what it does', async () => {
  let on = false; const store = { get: () => on, set: (v) => { on = v; } };
  const h = setup({ status: signed(), nodesOnly: store });
  const box = h.doc.getElementById('only');
  assert.equal(box.checked, false); assert.match(h.doc.getElementById('only-note').textContent, /may answer fee reads/);
  box.checked = true; box.dispatchEvent(new h.dom.window.Event('change'));
  assert.equal(on, true); assert.match(h.doc.getElementById('only-note').textContent, /are off in this browser/);
  assert.equal(setup({ status: signed(), nodesOnly: store }).doc.getElementById('only').checked, true, 'remembered');
});

test('the page keeps to its contract: a title, a strict CSP naming only the API, the sections the owner asked for, no hype', () => {
  const doc = new JSDOM(PAGE).window.document;
  assert.equal(doc.title, 'tacit nodes');
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(csp, /connect-src 'self' https:\/\/api\.tacit\.finance;/); assert.doesNotMatch(csp, /connect-src[^;]*\shttps:(\s|;)/); assert.match(csp, /script-src 'self';/);
  assert.deepEqual([...doc.querySelectorAll('main h2')].map((h) => h.textContent), ['Run a node', 'How the app uses them']);
  assert.ok(doc.getElementById('lb') && doc.getElementById('only'));
  const text = doc.querySelector('main').textContent;
  assert.match(text, /no payouts/); assert.doesNotMatch(text, /\bAPY\b|revolution|moon|!/);
  assert.match(text, /never asked for a balance/);
});

test('trust: a signature older than an hour is flagged, a missing key is flagged', () => {
  const c = (s) => checkDoc('status', s, [pub(9)]);
  assert.equal(trust(signed({ ...STATUS, at: T - 7200 }), { check: c, pubs: [pub(9)], now: T }).stale, true);
  assert.equal(trust(signed(), { check: c, pubs: [pub(9)], now: T }).stale, false);
  assert.equal(trust(STATUS, { check: c, pubs: [], now: T }).preview, true);
});

test('the page links to the swap-provider guide and the own-nodes runbook', () => {
  const doc = new JSDOM(PAGE).window.document;
  assert.ok(doc.querySelector('main a[href="/btc/#be"]'));
  assert.ok(doc.querySelector('main a[href$="/tree/main/own-nodes"]'));
});
