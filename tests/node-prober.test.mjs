// The community-node prober: probes and what they judge, scores, signed documents and the pinned key, the public-data allowlist, grouping of
// operators that share a machine, the service's registration, shadow period, list and relay.
//   /Users/z/.nvm/versions/node/v22.22.3/bin/node --test tests/node-prober.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { secp, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import * as L from '../dapp/nodes-list.js';
import { makeProber } from '../node-prober/src/probes.mjs';
import { addRecord, dayScore, standing, board, collapseGroups, RULES, DAY } from '../node-prober/src/score.mjs';
import { credits } from '../node-prober/src/credits.mjs';
import { makeService } from '../node-prober/src/service.mjs';
import { publicIp } from '../node-prober/src/net.mjs';

const T0 = 1_800_000_000;
const priv = (n) => new Uint8Array(32).fill(n);
const pub = (n) => bytesToHex(secp.getPublicKey(priv(n), true));
const h = (s) => '0x' + crypto.createHash('sha256').update(String(s)).digest('hex');
const hx = (n) => '0x' + n.toString(16);

// a small Ethereum and Bitcoin for the probes: every honest node answers the same, a node can be told to lag, lie or make things up
function world({ head = 26_100_000, btcTip = 900_000 } = {}) {
  const txs = new Set(), btxs = new Set();
  const eth = (opts = {}) => async (url, o) => {
    const { method, params } = JSON.parse(o.body);
    const hd = head - (opts.lag || 0);
    const ok = (result) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }), ms: 5, ip: opts.ip || '203.0.113.5' });
    if (opts.down) throw new Error('connection refused');
    if (method === 'eth_chainId') return ok('0x1');
    if (method === 'eth_blockNumber') return ok(hx(hd));
    if (method === 'eth_getBlockByNumber') {
      const n = parseInt(params[0], 16);
      if (n > hd) return ok(opts.invent ? { hash: h('x' + n), receiptsRoot: h('r'), stateRoot: h('s'), parentHash: h('p'), number: params[0], transactions: [] } : null);
      const salt = opts.lie ? 'lie' : '';
      txs.add(h('t' + n));
      return ok({ hash: h(salt + 'b' + n), receiptsRoot: h('r' + n), stateRoot: h('s' + n), parentHash: h('b' + (n - 1)), number: params[0], transactions: [h('t' + n)] });
    }
    if (method === 'eth_getTransactionReceipt') return ok(txs.has(params[0]) || opts.invent ? receiptOf(params[0]) : null);
    if (method === 'eth_getLogs') {
      if (params[0].address === '0x000000000Ed1eabD231Be41d93b719056F7febFC') { const from = parseInt(params[0].fromBlock, 16); return ok(opts.lie ? [] : [{ blockNumber: hx(from + 1), logIndex: '0x0', transactionHash: h('l' + from) }]); }
      return ok(opts.invent ? [{ blockNumber: '0x1', logIndex: '0x0', transactionHash: h('z') }] : []);
    }
    if (method === 'eth_getProof') return ok({ storageHash: h('st'), codeHash: h('ch'), nonce: '0x1' });
    if (method === 'eth_getBalance') return ok(opts.lie ? '0x1' : hx(parseInt(params[1], 16) * 7));
    throw new Error('method ' + method);
  };
  const receiptOf = (t) => ({ blockHash: h('b' + t.slice(2, 6)), status: '0x1', gasUsed: '0x5208', logs: [] });
  const btc = (opts = {}) => async (url, o) => {
    const path = new URL(url).pathname.replace(/^\/[a-z]+\/api/, '').replace(/^\/api/, '');
    const out = (status, body) => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body), ms: 5, ip: opts.ip || '203.0.113.9' });
    if (opts.down) throw new Error('connection refused');
    const tip = btcTip - (opts.lag || 0);
    if (path === '/blocks/tip/height') return out(200, String(tip));
    let m;
    if ((m = /^\/block-height\/(\d+)$/.exec(path))) return +m[1] > tip ? (opts.invent ? out(200, h('fake').slice(2)) : out(404, 'Block not found')) : out(200, h((opts.lie ? 'l' : '') + 'bh' + m[1]).slice(2));
    if ((m = /^\/block\/([0-9a-f]{64})\/txids$/.exec(path))) { const id = h('tx' + m[1]).slice(2); btxs.add(id); return out(200, [id]); }
    if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(path))) return btxs.has(m[1]) || opts.invent ? out(200, { txid: m[1], vin: [{}], vout: [{}], fee: 1, status: { block_height: 5, block_hash: 'aa' } }) : out(404, 'Transaction not found');
    if ((m = /^\/address\/(\w+)$/.exec(path))) return out(200, { chain_stats: { funded_txo_count: 60, spent_txo_count: 59, tx_count: opts.lie ? 1 : 61, funded_txo_sum: 5e9 } });
    return out(404, 'not found');
  };
  return { eth, btc };
}
const urlHost = (u) => new URL(u).host;
// route urls to node behaviours
const router = (table, kind) => (url, o) => { const e = table[urlHost(url)]; if (!e) throw new Error('no route ' + url); return (kind === 'eth' ? e.eth : e.btc)(url, o); };
const mkFetch = (nodes) => { const w = world(); return (url, o) => { const n = nodes[urlHost(url)]; if (!n) return Promise.reject(new Error('no route ' + urlHost(url))); return (n.kind === 'eth' ? w.eth(n.o) : w.btc(n.o))(url, o); }; };
void router;
const REFS = { eth: [{ url: 'https://own.example/eth', own: true }, { url: 'https://ref1.example' }, { url: 'https://ref2.example' }], btc: [{ url: 'https://own.example/btc/api', own: true }, { url: 'https://refb1.example/api' }, { url: 'https://refb2.example/api' }] };
const goodRefs = { 'own.example': { kind: 'eth', o: {} }, 'ref1.example': { kind: 'eth', o: {} }, 'ref2.example': { kind: 'eth', o: {} }, 'own.btc': { kind: 'btc', o: {} }, 'refb1.example': { kind: 'btc', o: {} }, 'refb2.example': { kind: 'btc', o: {} } };
// the eth and btc routes share the host `own.example`: split by path so one table serves both
const mkF = (extra) => { const w = world(); const t = { ...goodRefs, ...extra }; return (url, o) => { const u = new URL(url); const n = t[u.host === 'own.example' && o.method === 'GET' ? 'own.btc' : u.host]; if (!n) return Promise.reject(new Error('no route ' + u.host)); return (n.kind === 'eth' ? w.eth(n.o) : w.btc(n.o))(url, o); }; };
const rndSeq = (seed = 7) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const ethEp = (url, roles = ['eth-reads']) => ({ url, kind: 'eth', roles });
const btcEp = (url, roles = ['btc-esplora']) => ({ url, kind: 'btc', roles });
const run = async (fetch, ep, names) => { const p = makeProber({ fetch, refs: REFS, rnd: rndSeq() }); const out = []; for (const n of names) out.push(await (ep.kind === 'eth' ? p.eth : p.btc)[n](ep)); return out; };

// ── probes ──
test('an honest Ethereum node passes heads, blocks, receipts, logs, proofs and archive reads', async () => {
  const f = mkF({ 'good.example': { kind: 'eth', o: {} } });
  const ep = ethEp('https://good.example', ['eth-reads', 'eth-logs', 'eth-proofs', 'eth-archive']);
  for (const r of await run(f, ep, ['head', 'block+receipt', 'logs', 'proof', 'archive', 'honeypot'])) { assert.equal(r.answered, true, r.probe); assert.equal(r.ok, true, r.probe + ' ' + r.note); assert.equal(r.hard, false); }
  assert.equal((await run(f, ep, ['head']))[0].fresh, true);
});

test('a lying node fails hard when it stands alone against our node and the references', async () => {
  const f = mkF({ 'liar.example': { kind: 'eth', o: { lie: true } } });
  const ep = ethEp('https://liar.example', ['eth-reads', 'eth-logs', 'eth-archive']);
  for (const [n, role] of [['head', 'eth-reads'], ['logs', 'eth-logs'], ['archive', 'eth-archive']]) { const [r] = await run(f, ep, [n]); assert.equal(r.ok, false, n); assert.equal(r.hard, true, n); assert.equal(r.role, role); }
});

test('references that disagree give no verdict and charge nothing', async () => {
  const f = mkF({ 'node.example': { kind: 'eth', o: {} }, 'ref1.example': { kind: 'eth', o: { lie: true } }, 'ref2.example': { kind: 'eth', o: { lie: true, ip: '1.1.1.1' } }, 'own.example': { kind: 'eth', o: {} } });
  // own says one thing, the two references say another, the references agree with each other: the references carry it, the honest node is judged against them
  const [r] = await run(f, ethEp('https://node.example'), ['head']);
  assert.equal(r.hard, false, 'split sources are never a hard fail');
  // a three-way split: nothing is agreed
  const f2 = mkF({ 'node.example': { kind: 'eth', o: {} }, 'own.example': { kind: 'eth', o: {} }, 'ref1.example': { kind: 'eth', o: { lie: true } }, 'ref2.example': { kind: 'eth', o: { down: true } } });
  const [r2] = await run(f2, ethEp('https://node.example'), ['head']);
  assert.equal(r2.ok, null); assert.equal(r2.hard, false);
});

test('a node that is behind is not fresh, a node that is down is unanswered', async () => {
  const f = mkF({ 'slow.example': { kind: 'eth', o: { lag: 5 } }, 'dead.example': { kind: 'eth', o: { down: true } } });
  const [r] = await run(f, ethEp('https://slow.example'), ['head']);
  assert.equal(r.fresh, false);
  const [d] = await run(f, ethEp('https://dead.example'), ['head']);
  assert.equal(d.answered, false); assert.equal(d.ok, null); assert.equal(d.hard, false);
});

test('honeypots: a node that finds what does not exist fails hard; one that says not found passes', async () => {
  const bad = mkF({ 'faker.example': { kind: 'eth', o: { invent: true } } });
  let hard = 0;
  for (let s = 1; s < 9; s++) { const p = makeProber({ fetch: bad, refs: REFS, rnd: rndSeq(s) }); const r = await p.eth.honeypot(ethEp('https://faker.example')); if (r.hard) hard++; assert.equal(r.hard, r.ok === false); }
  assert.ok(hard >= 1);
  const good = mkF({ 'good.example': { kind: 'eth', o: {} } });
  for (let s = 1; s < 9; s++) { const p = makeProber({ fetch: good, refs: REFS, rnd: rndSeq(s) }); assert.equal((await p.eth.honeypot(ethEp('https://good.example'))).ok, true); }
  const bb = mkF({ 'faker.example': { kind: 'btc', o: { invent: true } } });
  let btcHard = 0;
  for (let s = 1; s < 12; s++) { const p = makeProber({ fetch: bb, refs: REFS, rnd: rndSeq(s) }); if ((await p.btc.honeypot(btcEp('https://faker.example/api'))).hard) btcHard++; }
  assert.ok(btcHard >= 1);
});

test('an honest Bitcoin node passes; one with the wrong history fails hard', async () => {
  const f = mkF({ 'btc.example': { kind: 'btc', o: {} }, 'lie.example': { kind: 'btc', o: { lie: true } } });
  for (const r of await run(f, btcEp('https://btc.example/api', ['btc-esplora', 'btc-index']), ['tip', 'tx', 'address', 'honeypot'])) assert.notEqual(r.ok, false, r.probe + ' ' + r.note);
  const [tip] = await run(f, btcEp('https://lie.example/api'), ['tip']); assert.equal(tip.hard, true);
  const [adr] = await run(f, btcEp('https://lie.example/api', ['btc-index']), ['address']); assert.equal(adr.hard, true);
});

test('a probe plan gives a head to every endpoint and a probe per claimed role', () => {
  const p = makeProber({ fetch: async () => { throw new Error('no'); }, refs: REFS, rnd: rndSeq(3) });
  const names = p.plan(ethEp('https://x.example', ['eth-logs', 'eth-archive'])).map((x) => x.name);
  assert.ok(names.includes('head') && names.includes('logs') && names.includes('archive'));
});

// ── scores ──
const ep = (over = {}) => ({ id: 'a'.repeat(16), url: 'https://a.example', kind: 'eth', roles: ['eth-reads'], operator: pub(1), firstSeen: T0 - 20 * DAY, agg: {}, strikes: [], ...over });
const feed = (e, n, f, at = T0 - DAY) => { for (let i = 0; i < n; i++) addRecord(e, { role: 'eth-reads', probe: 'head', answered: true, ok: true, hard: false, fresh: true, ms: 50, at: at + i, ...f(i) }, at + i); return e; };
const D = Math.floor((T0 - DAY) / DAY);

test('a perfect day scores the role weight; a hard fail, low uptime or no verdicts score nothing; partial lying hurts more than linearly', () => {
  assert.equal(dayScore(feed(ep(), 10, () => ({})), 'eth-reads', D), L.BASE['eth-reads']);
  assert.equal(dayScore(feed(ep(), 10, (i) => ({ hard: i === 3, ok: i !== 3 })), 'eth-reads', D), 0);
  assert.equal(dayScore(feed(ep(), 10, (i) => (i < 3 ? { answered: false, ok: null } : {})), 'eth-reads', D), 0);
  assert.equal(dayScore(feed(ep(), 10, () => ({ ok: null })), 'eth-reads', D), 0);
  assert.equal(dayScore(feed(ep(), 4, () => ({})), 'eth-reads', D), 0);
  const half = dayScore(feed(ep(), 10, (i) => ({ ok: i % 2 === 0 })), 'eth-reads', D);
  assert.ok(half < L.BASE['eth-reads'] * 0.5 + 1e-9 && half > 0);
});

test('shadow: nothing listed or scored in the first day; probation weight rises with clean days; strikes remove', () => {
  const young = ep({ firstSeen: T0 - 3600 }); feed(young, 10, () => ({}), T0 - 3000);
  assert.equal(standing(young, T0).state, 'shadow'); assert.equal(standing(young, T0).weight, 0);
  const two = ep({ firstSeen: T0 - 2 * DAY }); feed(two, 10, () => ({}), T0 - 3000);
  const s2 = standing(two, T0); assert.equal(s2.state, 'probation'); assert.ok(s2.weight > 0.1 && s2.weight < 0.4, String(s2.weight));
  const old = ep({ firstSeen: T0 - 30 * DAY }); feed(old, 10, () => ({}), T0 - 3000);
  assert.equal(standing(old, T0).state, 'listed'); assert.ok(standing(old, T0).weight > 0.9);
  const bad = ep({ firstSeen: T0 - 30 * DAY }); for (let i = 0; i < 3; i++) addRecord(bad, { role: 'eth-reads', probe: 'x', answered: true, ok: false, hard: true, at: T0 - 100 + i }, T0 - 100 + i);
  assert.equal(standing(bad, T0).state, 'removed'); assert.equal(standing(bad, T0).weight, 0);
  assert.equal(standing(bad, T0 + RULES.cooldown + 1000).state === 'removed', false);
  const hard = ep({ firstSeen: T0 - 30 * DAY }); feed(hard, 10, () => ({}), T0 - 3000); addRecord(hard, { role: 'eth-reads', probe: 'x', answered: true, ok: false, hard: true, at: T0 - 10 }, T0 - 10);
  assert.ok(standing(hard, T0).weight < 0.2, 'a hard fail resets the ramp');
});

test('a node that has not answered well for hours is not weighted', () => {
  const e = ep({ firstSeen: T0 - 30 * DAY }); feed(e, 10, () => ({}), T0 - 9 * 3600);
  assert.equal(standing(e, T0).weight, 0);
});

// ── grouping ──
test('endpoints on one /24 or one ASN collapse; operators with two machines get a quarter for the second', () => {
  const nodes = [
    { id: 'a', group: 'net10.1.1', operator: 'o1', weight: 1 }, { id: 'b', group: 'net10.1.1', operator: 'o2', weight: 1 },
    { id: 'c', group: 'net9.9.9', operator: 'o2', weight: 1 }, { id: 'd', group: 'net7.7.7', operator: 'o3', weight: 1 },
  ];
  const g = collapseGroups(nodes);
  assert.equal(new Set(g.map((n) => n.group)).size, 2, 'a, b, c are one class (shared /24, shared operator); d is its own');
  assert.equal(L.independent(g).length, 2);
  const d = L.diversity([{ url: 'a', ip: '10.1.1.4', score: 10 }, { url: 'b', ip: '10.1.1.9', score: 12 }, { url: 'c', ip: '9.9.9.1', score: 8 }, { url: 'd', ip: '5.5.5.5', score: 6 }, { url: 'e', ip: '6.6.6.6', score: 5 }]);
  assert.deepEqual(d.map((x) => [x.url, x.share]), [['b', 1], ['c', 0.25], ['d', 0.05], ['e', 0.05]]);
  assert.equal(L.diversity([{ url: 'a', ip: '1.1.1.1', asn: '64500', score: 1 }, { url: 'b', ip: '2.2.2.2', asn: '64500', score: 2 }]).length, 1);
  assert.equal(L.fronted('104.18.2.3'), true); assert.equal(L.fronted('8.8.8.8'), false);
});

test('the board ranks operators and leaves out a fronted or shadow endpoint', () => {
  const a = ep({ id: '1'.repeat(16), operator: pub(1), ip: '10.9.0.1' }), b = ep({ id: '2'.repeat(16), operator: pub(2), ip: '10.9.1.1', fronted: true }), c = ep({ id: '3'.repeat(16), operator: pub(3), firstSeen: T0 - 60 });
  for (const e of [a, b, c]) feed(e, 10, () => ({}), T0 - DAY);
  for (const e of [a, b, c]) feed(e, 10, () => ({}), T0 - 3000);
  const r = board([a, b, c], T0);
  assert.equal(r.operators[0].operator, pub(1)); assert.ok(r.operators[0].score > 0);
  assert.equal(r.operators.find((o) => o.operator === pub(2)).score, 0);
  assert.equal(r.operators.find((o) => o.operator === pub(3)).score, 0);
  assert.deepEqual(r.operators.map((o) => o.rank), [1, 2, 3]);
});

// ── signed documents, the pinned key ──
const A_NOW = T0;
const adFor = (n, over = {}) => L.signAd({ operator: pub(n), endpoints: [{ kind: 'eth', url: 'https://eth.node-' + n + '.example/', roles: ['eth-reads'] }], at: A_NOW, until: A_NOW + 86400, ...over }, priv(n));

test('an ad is checked: whole, https name, roles of its kind, signed by its operator, current', () => {
  assert.ok(L.checkAd(adFor(1), A_NOW));
  const bad = (ad, re) => assert.throws(() => L.checkAd(ad, A_NOW), re);
  bad({ ...adFor(1), endpoints: [{ kind: 'eth', url: 'http://x.example', roles: ['eth-reads'] }] }, /signed|https/);
  for (const url of ['http://x.example', 'https://127.0.0.1/', 'https://10.0.0.1/', 'https://[::1]/', 'https://u:p@x.example/', 'https://localhost/', 'https://x.example:8545/', 'https://nodot/']) bad(adFor(1, { endpoints: [{ kind: 'eth', url, roles: ['eth-reads'] }] }), /https name/);
  bad(adFor(1, { endpoints: [{ kind: 'eth', url: 'https://x.example', roles: ['btc-esplora'] }] }), /roles/);
  bad(adFor(1, { until: A_NOW - 5, at: A_NOW - 100 }), /run out/);
  bad(adFor(1, { until: A_NOW + 40 * 86400 }), /time/);
  bad(adFor(1, { extra: 1 }), /member/);
  bad(adFor(1, { payTo: 'nope' }), /payTo/);
  bad(adFor(1, { name: 'a<b' }), /name/);
  bad({ ...adFor(1), operator: pub(2) }, /signed by its operator/);
  bad({ ...adFor(1), endpoints: [{ kind: 'eth', url: 'https://other.example', roles: ['eth-reads'] }] }, /signed by its operator/);
  bad(adFor(1, { endpoints: Array.from({ length: 7 }, (_, i) => ({ kind: 'eth', url: `https://e${i}.example`, roles: ['eth-reads'] })) }), /too many/);
});

const signedList = (n, nodes, at = T0, until = T0 + 1500) => L.signDoc('list', { v: 1, at, until, signer: pub(n), nodes }, priv(n));
const NODE = { id: 'a'.repeat(16), url: 'https://x.example', kind: 'eth', roles: ['eth-reads'], operator: 'op', group: 'g1', weight: 0.5, reliability: 0.9, lastOk: T0 };

test('a list is believed only when signed by a pinned key, current, and shaped right; otherwise it is empty (fail closed)', () => {
  const P = [pub(9)];
  assert.equal(L.verifyList(signedList(9, [NODE]), T0, P).length, 1);
  assert.equal(L.verifyList(signedList(9, [NODE]), T0, []).length, 0, 'no key pinned');
  assert.deepEqual(L.verifyList(signedList(9, [NODE]), T0), [], 'the shipped build pins none yet');
  assert.equal(L.verifyList(signedList(8, [NODE]), T0, P).length, 0, 'another signer');
  const forged = { ...signedList(9, [NODE]), nodes: [{ ...NODE, url: 'https://evil.example' }] };
  assert.equal(L.verifyList(forged, T0, P).length, 0, 'tampered');
  const swapped = { ...signedList(8, [NODE]), signer: pub(9) };
  assert.equal(L.verifyList(swapped, T0, P).length, 0, 'a signature of another key under a pinned name');
  assert.equal(L.verifyList(signedList(9, [NODE], T0 - 4000, T0 - 10), T0, P).length, 0, 'expired');
  assert.equal(L.verifyList(signedList(9, [NODE], T0, T0 + 99999), T0, P).length, 0, 'too long-lived');
  assert.equal(L.verifyList(signedList(9, [NODE], T0 + 9999, T0 + 10500), T0, P).length, 0, 'from the future');
  assert.equal(L.verifyList(signedList(9, [{ ...NODE, weight: 5 }, { ...NODE, roles: ['mine'] }, { ...NODE, id: 'zz' }]), T0, P).length, 0, 'bad members dropped');
  for (const junk of [null, 1, 'x', {}, { v: 1, nodes: 'x' }]) assert.deepEqual(L.verifyList(junk, T0, P), []);
});

// ── public-data allowlist ──
test('a community node is asked public data only', () => {
  const ok = [['eth_blockNumber', []], ['eth_chainId', []], ['eth_gasPrice', []], ['eth_feeHistory', [10, 'latest', [25]]], ['eth_getBlockByNumber', ['latest', false]], ['eth_getBlockByNumber', ['0x10', false]],
    ['eth_getBlockByHash', [h('x'), false]], ['eth_getTransactionReceipt', [h('x')]], ['eth_getTransactionByHash', [h('x')]], ['eth_getBlockReceipts', ['0x10']],
    ['eth_getLogs', [{ fromBlock: '0x100', toBlock: '0x200', address: '0x000000000Ed1eabD231Be41d93b719056F7febFC', topics: [h('sig')] }]]];
  for (const [m, p] of ok) assert.equal(L.ethPublic(m, p), true, m);
  const no = [['eth_getBalance', ['0x00000000219ab540356cBB839Cbe05303d7705Fa', 'latest']], ['eth_getTransactionCount', ['0x00000000219ab540356cBB839Cbe05303d7705Fa', 'latest']], ['eth_getCode', ['0x0', 'latest']],
    ['eth_call', [{ to: '0x0' }, 'latest']], ['eth_getStorageAt', ['0x0', '0x0']], ['eth_getProof', ['0x0', [], 'latest']], ['eth_sendRawTransaction', ['0x00']], ['eth_estimateGas', [{}]],
    ['debug_traceTransaction', [h('x')]], ['eth_getTransactionReceipt', ['0xabc']], ['eth_getBlockByNumber', [{}, false]], ['eth_getBlockByNumber', ['latest', 'x']],
    // logs: not for another contract, not by a topic that can carry an address, not past the span, not without bounds, nothing extra
    ['eth_getLogs', [{ fromBlock: '0x100', toBlock: '0x200', address: '0x00000000219ab540356cBB839Cbe05303d7705Fa' }]],
    ['eth_getLogs', [{ fromBlock: '0x100', toBlock: '0x200', address: '0x000000000Ed1eabD231Be41d93b719056F7febFC', topics: [h('sig'), '0x' + '00'.repeat(12) + 'ab'.repeat(20)] }]],
    ['eth_getLogs', [{ fromBlock: '0x100', toBlock: '0x9999999', address: '0x000000000Ed1eabD231Be41d93b719056F7febFC' }]],
    ['eth_getLogs', [{ fromBlock: 'latest', toBlock: 'latest', address: '0x000000000Ed1eabD231Be41d93b719056F7febFC' }]],
    ['eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }]], ['eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2', address: '0x000000000Ed1eabD231Be41d93b719056F7febFC', extra: 1 }]],
    ['eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2', address: ['0x000000000Ed1eabD231Be41d93b719056F7febFC', '0x00000000219ab540356cBB839Cbe05303d7705Fa'] }]]];
  for (const [m, p] of no) assert.equal(L.ethPublic(m, p), false, m + JSON.stringify(p).slice(0, 60));
  assert.equal(L.ethPublic('eth_blockNumber', 'x'), false); assert.equal(L.ethPublic(7, []), false);
  const t = 'ab'.repeat(32);
  for (const p of ['/blocks/tip/height', '/blocks/tip/hash', '/block-height/100', `/block/${t}`, `/block/${t}/txids`, `/tx/${t}`, `/tx/${t}/status`, '/fee-estimates']) assert.equal(L.btcPublic(p), true, p);
  for (const p of ['/address/1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3', '/address/bc1q/utxo', '/scripthash/' + t, '/tx', `/tx/${t}/../../address/x`, '/mempool/recent', `/tx/${t}?x=1`, '//x', '', 5]) assert.equal(L.btcPublic(p), false, String(p));
});

// ── the service ──
const KEY = '07'.repeat(32);
const svcWith = (nodes, o = {}) => {
  let t = T0; const clock = () => t;
  const f = mkF({ ...nodes });
  const fetch = async (url, opts) => { const r = await f(url, opts); return { ...r, headers: { 'access-control-allow-origin': '*' } }; };
  const s = makeService({ key: KEY, fetch, now: clock, rnd: rndSeq(5), baseline: [], refs: REFS, intervalSecs: 600, ...o });
  return { s, advance: (d) => { t += d; }, clock };
};
const post = async (s, path, body) => { const chunks = []; const req = { method: 'POST', url: path, headers: {}, socket: { remoteAddress: '1.2.3.4' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }; let code, text; const res = { writeHead: (c) => { code = c; }, end: (b) => { text = b; } }; void chunks; await s.handler(req, res); return { code, json: JSON.parse(text || 'null') }; };
const get = async (s, path) => { let code, text; await s.handler({ method: 'GET', url: path, headers: {}, socket: { remoteAddress: '1.2.3.4' } }, { writeHead: (c) => { code = c; }, end: (b) => { text = b; } }); return { code, json: JSON.parse(text || 'null') }; };

test('registration, shadow, probation, the signed list, and the relay', async () => {
  const { s, advance } = svcWith({ 'good.example': { kind: 'eth', o: {} } });
  const ad = L.signAd({ operator: pub(1), payTo: '0x' + 'ab'.repeat(20), endpoints: [{ kind: 'eth', url: 'https://good.example', roles: ['eth-reads'] }], at: T0, until: T0 + 30 * DAY }, priv(1));
  const reg = await post(s, '/nodes/ad', ad); assert.equal(reg.code, 200, JSON.stringify(reg.json));
  assert.equal((await post(s, '/nodes/ad', { ...ad, name: 'forged' })).code, 400);
  // not yet listed: shadow
  assert.equal((await get(s, '/nodes/list')).json.nodes.length, 0);
  for (let i = 0; i < 60; i++) { advance(1800); await s.tick(); }
  const first = (await get(s, '/nodes/list')).json;
  assert.ok(first.nodes.length === 1, 'listed after the shadow day: ' + JSON.stringify(s.endpoints().map((e) => s.standing(e))));
  assert.ok(first.nodes[0].weight > 0 && first.nodes[0].weight < 1);
  assert.equal(L.verifyList(first, T0 + 60 * 1800, [s.signer]).length, 1, 'the list verifies under the prober key');
  assert.equal(L.verifyList(first, T0 + 60 * 1800, [pub(3)]).length, 0);
  // signed records and status
  const rec = (await get(s, '/nodes/records?id=' + first.nodes[0].id)).json.records;
  assert.ok(rec.length > 0 && rec.every((r) => L.sigOk('record', r, s.signer)));
  const st = (await get(s, '/nodes/status')).json;
  assert.ok(L.checkDoc('status', st, [s.signer]) && st.points === 'off');
  // the relay forwards public reads and refuses the rest
  const id = first.nodes[0].id;
  const sent = [];
  const { s: s2, advance: adv2 } = svcWith({ 'good.example': { kind: 'eth', o: {} } }, { relayFetch: async (url, o) => { sent.push([url, o]); return { status: 200, text: '{"result":"0x1"}' }; } });
  adv2(60 * 1800);
  s2.state().endpoints = s.state().endpoints; s2.state().ads = s.state().ads;
  const good = await post(s2, '/nodes/relay', { node: id, method: 'eth_blockNumber', params: [] });
  assert.equal(good.code, 200); assert.equal(sent.length, 1); assert.equal(sent[0][0], 'https://good.example'); assert.ok(!('origin' in sent[0][1].headers) && !('x-forwarded-for' in sent[0][1].headers));
  const noBal = await post(s2, '/nodes/relay', { node: id, method: 'eth_getBalance', params: ['0x' + 'ab'.repeat(20), 'latest'] });
  assert.equal(noBal.code, 403); assert.equal(sent.length, 1, 'an address read never leaves');
  assert.equal((await post(s2, '/nodes/relay', { node: 'f'.repeat(16), method: 'eth_blockNumber', params: [] })).code, 404);
  assert.equal((await post(s2, '/nodes/relay', { node: id, method: 'eth_sendRawTransaction', params: ['0x00'] })).code, 403);
});

test('the relay does not reach a baseline entry or a node still in shadow; a node that fails CORS or is not mainnet is not taken in', async () => {
  const { s } = svcWith({ 'good.example': { kind: 'eth', o: {} }, 'chain2.example': { kind: 'eth', o: {} } });
  const ad = L.signAd({ operator: pub(2), endpoints: [{ kind: 'eth', url: 'https://good.example', roles: ['eth-reads'] }], at: T0, until: T0 + DAY }, priv(2));
  await post(s, '/nodes/ad', ad);
  const id = s.endpoints()[0].id;
  assert.equal((await post(s, '/nodes/relay', { node: id, method: 'eth_blockNumber', params: [] })).code, 404, 'shadow');
  const bad = L.signAd({ operator: pub(3), endpoints: [{ kind: 'eth', url: 'https://nowhere.example', roles: ['eth-reads'] }], at: T0, until: T0 + DAY }, priv(3));
  assert.equal((await post(s, '/nodes/ad', bad)).code, 400);
  const dup = L.signAd({ operator: pub(4), endpoints: [{ kind: 'eth', url: 'https://good.example', roles: ['eth-reads'] }], at: T0, until: T0 + DAY }, priv(4));
  assert.equal((await post(s, '/nodes/ad', dup)).code, 409, 'one operator per endpoint');
  const noCors = (() => { const f = mkF({ 'cors.example': { kind: 'eth', o: {} } }); return makeService({ key: KEY, fetch: async (u, o) => ({ ...(await f(u, o)), headers: { 'access-control-allow-origin': 'https://elsewhere.example' } }), now: () => T0, baseline: [], refs: REFS }); })();
  const c = L.signAd({ operator: pub(5), endpoints: [{ kind: 'eth', url: 'https://cors.example', roles: ['eth-reads'] }], at: T0, until: T0 + DAY }, priv(5));
  const r = await post(noCors, '/nodes/ad', c); assert.equal(r.code, 400); assert.match(r.json.error, /CORS/);
});

test('an operator that starts to lie is struck and removed from the list', async () => {
  const nodes = { 'flip.example': { kind: 'eth', o: {} } };
  const { s, advance } = svcWith(nodes);
  await post(s, '/nodes/ad', L.signAd({ operator: pub(6), endpoints: [{ kind: 'eth', url: 'https://flip.example', roles: ['eth-reads'] }], at: T0, until: T0 + 30 * DAY }, priv(6)));
  for (let i = 0; i < 60; i++) { advance(1800); await s.tick(); }
  assert.equal((await get(s, '/nodes/list')).json.nodes.length, 1);
  nodes['flip.example'].o.lie = true; // the world table is shared by reference
  for (let i = 0; i < 40; i++) { advance(900); await s.tick(); }
  const e = s.endpoints()[0];
  assert.ok(e.strikes.length >= 1);
  assert.ok(s.standing(e).weight < 0.2, 'a hard fail resets the ramp: ' + JSON.stringify(s.standing(e)));
});

test('points are off by default and the feed says so; on, a payee is capped and ids are per day', () => {
  const e = ep({ firstSeen: T0 - 30 * DAY, payTo: '0x' + 'AB'.repeat(20) });
  for (let d = 1; d < 3; d++) feed(e, 10, () => ({}), T0 - d * DAY);
  assert.deepEqual(credits({ endpoints: [e], day: D, now: T0, enabled: false }), { enabled: false, day: D, credits: [] });
  const on = credits({ endpoints: [e], day: D, now: T0, enabled: true });
  assert.equal(on.credits.length, 1); assert.equal(on.credits[0].id, `pn:day:${D}:0x${'ab'.repeat(20)}`); assert.ok(on.credits[0].points > 0);
  assert.equal(credits({ endpoints: [e], day: Math.floor(T0 / DAY), now: T0, enabled: true }).credits.length, 0, 'a day not over pays nothing');
});

test('the prober never connects to a private address', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0', 'x']) assert.equal(publicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(publicIp(ip), true, ip);
});
