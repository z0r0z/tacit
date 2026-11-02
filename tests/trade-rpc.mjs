#!/usr/bin/env node
// dapp/trade/rpc.js: the nodes are asked in order, a slow one is hedged with the next, a failing one is skipped at once, a revert ends the call,
// and the losers are cancelled; with `health` a node that failed rests and is asked last; a wallet is a node of last resort; reads asked twice at once are asked once. A scripted `fetch` stands in for the nodes; hedgeMs is shortened so it runs in milliseconds.
import assert from 'node:assert';
import { hedgedRpc, hedgeDelay, bodyType, takeEarly, nodeHealth, shareReads } from '../dapp/trade/rpc.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const HOSTS = ['https://a', 'https://b', 'https://c'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// plan: host → { wait: ms before answering, result | error | throws | hang }
function nodes(plan) {
  const log = { asked: [], aborted: [], types: {} };
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const p = plan[url] || {}, i = log.asked.push(url) - 1; log.types[url] = init.headers['content-type'];
    const abort = () => { log.aborted.push(url); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    if (init.signal.aborted) return abort();
    init.signal.addEventListener('abort', abort);
    if (p.hang) return;
    setTimeout(() => (p.throws ? reject(new Error(p.throws)) : resolve({ json: async () => (p.bare ? p.bare : p.error ? { jsonrpc: '2.0', id: 1, error: p.error } : { jsonrpc: '2.0', id: 1, result: p.result ?? url }) })), p.wait ?? 0);
  });
  return { log, fetchImpl };
}
const rpc = (plan, o = {}) => { const x = nodes(plan); return hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 40, fetchImpl: x.fetchImpl, ...o }).then((v) => ({ v, log: x.log }), (e) => Promise.reject(Object.assign(e, { log: x.log }))); };

{
  const { v, log } = await rpc({});
  assert.equal(v, 'https://a'); assert.deepEqual(log.asked, ['https://a']);
  ok('a node that answers in time is the only one asked');
}
{
  const { v, log } = await rpc({ 'https://a': { bare: { code: 429, message: 'rate limited' } } });
  assert.equal(v, 'https://b'); assert.deepEqual(log.asked, ['https://a', 'https://b']);
  ok('a reply with neither a result nor an error is a node that failed, not an answer: the next node is asked');
}
{
  const { v, log } = await rpc({ 'https://a': { wait: 15 } });
  assert.equal(v, 'https://a'); assert.equal(log.asked.length, 1);
  ok('an answer that arrives before the hedge starts nothing else');
}
{
  const t0 = Date.now();
  const { v, log } = await rpc({ 'https://a': { hang: true } });
  assert.equal(v, 'https://b'); assert.deepEqual(log.asked, ['https://a', 'https://b']);
  assert.ok(Date.now() - t0 < 400, `the next node is asked after the hedge, not after the timeout (${Date.now() - t0} ms)`);
  await sleep(10); assert.deepEqual(log.aborted, ['https://a'], 'and the one that hung is cancelled');
  ok('a node that hangs is hedged with the next after hedgeMs, and cancelled once another has answered');
}
{
  const { v, log } = await rpc({ 'https://a': { wait: 200, result: 'late' }, 'https://b': { wait: 5, result: 'quick' } });
  assert.equal(v, 'quick'); await sleep(10); assert.ok(log.aborted.includes('https://a'));
  ok('the first answer wins, even from a later node');
}
{
  const t0 = Date.now();
  const { v, log } = await rpc({ 'https://a': { throws: 'network down' } }, { hedgeMs: 5000 });
  assert.equal(v, 'https://b'); assert.deepEqual(log.asked, ['https://a', 'https://b']); assert.ok(Date.now() - t0 < 200, 'no waiting on the hedge');
  ok('a node that fails is skipped at once, with no wait');
}
{
  const { v, log } = await rpc({ 'https://a': { error: { code: -32005, message: 'archive requests need a token' } }, 'https://b': { error: { code: 403, message: 'forbidden' } } });
  assert.equal(v, 'https://c'); assert.equal(log.asked.length, 3);
  ok('nodes that answer with an error are passed over until one answers');
}
{
  await assert.rejects(rpc({ 'https://a': { error: { code: 3, message: 'execution reverted: NoRoute' } } }), (e) => /reverted/.test(e.message) && e.revert === true && e.log.asked.length === 1);
  await assert.rejects(rpc({ 'https://a': { error: { code: -32000, message: 'Execution reverted' } } }), (e) => e.revert === true && e.log.asked.length === 1);
  ok('a revert ends the call at once and is marked as one (no other node is asked)');
}
{
  await assert.rejects(rpc({ 'https://a': { throws: 'one' }, 'https://b': { error: { message: 'two' } }, 'https://c': { throws: 'three' } }), (e) => e.message === 'three' && e.log.asked.length === 3);
  await assert.rejects(hedgedRpc([], 'eth_call', []), /no RPC answered/);
  ok('when every node fails the last failure is the answer, and with no nodes there is one at once');
}
{
  // one hedge, not a cascade: nodes that are all slow are not each sent the same heavy read
  const x = nodes({ 'https://a': { hang: true }, 'https://b': { hang: true }, 'https://c': { wait: 5, result: 'third' } });
  const done = hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 40, timeoutMs: 400, fetchImpl: x.fetchImpl });
  await sleep(220); assert.deepEqual(x.log.asked, ['https://a', 'https://b'], 'the second node is the hedge, and no third is asked while those two are still out');
  assert.equal(await done, 'third'); assert.deepEqual(x.log.asked, ['https://a', 'https://b', 'https://c']);
  ok('there is one hedge: with two hung nodes the third is asked only when the first has timed out, never more requests than nodes');
}
{
  const x = nodes({ 'https://a': { hang: true } });
  const done = hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 0, timeoutMs: 120, fetchImpl: x.fetchImpl });
  await sleep(80); assert.deepEqual(x.log.asked, ['https://a'], 'with the hedge off one node is asked at a time');
  assert.equal(await done, 'https://b');
  ok('a hedge of 0 asks one node at a time, as before');
}
{
  const set = (v) => { globalThis.localStorage = { getItem: () => v }; };
  assert.equal(hedgeDelay(), 2500, 'no storage at all');
  set(null); assert.equal(hedgeDelay(), 2500); set('0'); assert.equal(hedgeDelay(), 0); set('800'); assert.equal(hedgeDelay(), 800); set('abc'); assert.equal(hedgeDelay(), 2500); set('-5'); assert.equal(hedgeDelay(), 0);
  set(null); assert.equal(hedgeDelay(1000), 1000, 'a caller that knows its reads are light or heavy names its own default');
  set('300'); assert.equal(hedgeDelay(1000), 300, 'and the browser\'s setting still wins'); set('0'); assert.equal(hedgeDelay(1000), 0);
  delete globalThis.localStorage;
  ok('the delay is 2.5 s, and a browser can set it (0 switches hedging off)');
}
{
  const { log } = await rpc({ 'https://a': { hang: true }, 'https://b': { hang: true }, 'https://c': { hang: true } }, { timeoutMs: 60, lastTimeoutMs: 80 }).catch((e) => ({ log: e.log, err: e }));
  assert.equal(log.asked.length, 3); assert.equal(log.aborted.length, 3, 'each hung request times out and is cancelled');
  ok('requests that never answer time out');
}
{
  assert.equal(bodyType('https://ethereum-rpc.publicnode.com'), 'text/plain;charset=UTF-8'); assert.equal(bodyType('https://eth.drpc.org'), 'text/plain;charset=UTF-8'); assert.equal(bodyType('https://mainnet.gateway.tenderly.co'), 'text/plain;charset=UTF-8');
  assert.equal(bodyType('https://1rpc.io/eth'), 'application/json', 'a node that refuses text/plain is sent JSON'); assert.equal(bodyType('not a url'), 'application/json');
  for (const u of ['https://rpc.mevblocker.io', 'https://eth-mainnet.public.blastapi.io', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']) assert.equal(bodyType(u), 'text/plain;charset=UTF-8', `${u} takes a plain body`);
  assert.equal(bodyType('https://rpc.mainnet.chain.robinhood.com'), 'application/json', 'https://rpc.mainnet.chain.robinhood.com wants JSON');
  const { log } = await rpc({ 'https://a': { throws: 'down' } });
  assert.equal(log.types['https://a'], 'application/json', 'an unknown node is sent JSON, as before');
  ok('the nodes that take a plain-text body are sent one (no preflight request); the rest are sent JSON');
}
// ── takeEarly: a read the page's head sent to the first node is taken once, by the call that asks for exactly it ──
{
  const later = (ms, v, fail) => new Promise((res, rej) => setTimeout(() => (fail ? rej(fail) : res(v)), ms));
  const calls = [], rpc = (hosts, method, params, o = {}) => { calls.push({ hosts: hosts.join(), method, o: JSON.stringify(o) }); return Promise.resolve(`nodes:${hosts.length}`); };
  const store = new Map([['eth_call[{"to":"0x1"},"latest"]', later(5, 'early')], ['eth_gasPrice[]', later(5, null, new Error('down'))],
    ['eth_chainId[]', later(5, null, Object.assign(new Error('execution reverted'), { revert: true }))], ['eth_blockNumber[]', new Promise(() => {})]]);
  const o = { hedgeMs: 40, store, rpc };
  assert.equal(await takeEarly(HOSTS, 'eth_call', [{ to: '0x1' }, 'latest'], o), 'early'); assert.equal(calls.length, 0, 'its answer, no node asked');
  assert.equal(await takeEarly(HOSTS, 'eth_call', [{ to: '0x1' }, 'latest'], o), 'nodes:3', 'once: the next call asks all the nodes');
  assert.equal(await takeEarly(HOSTS, 'eth_call', [{ to: '0x2' }, 'latest'], o), 'nodes:3', 'another call is not given it');
  calls.length = 0;
  assert.equal(await takeEarly(HOSTS, 'eth_gasPrice', [], o), 'nodes:2', 'a failed early read: the other nodes are asked');
  assert.deepEqual(calls[0], { hosts: 'https://b,https://c', method: 'eth_gasPrice', o: '{}' }, 'as usual, the first (which the head asked) left out');
  await assert.rejects(takeEarly(HOSTS, 'eth_chainId', [], o), /reverted/, 'a revert is the answer');
  assert.equal(calls.length, 1, 'a revert is not asked again');
  const t0 = Date.now();
  assert.equal(await takeEarly(HOSTS, 'eth_blockNumber', [], o), 'nodes:2');
  assert.ok(Date.now() - t0 < 300, 'an early read still out after the hedge time: the next node is asked beside it');
  assert.deepEqual(calls[1], { hosts: 'https://b,https://c', method: 'eth_blockNumber', o: '{"hedgeMs":0}' }, 'and no other unless it fails: never more requests at once than hedgedRpc makes');
  assert.equal(store.size, 0, 'each is taken once');
  assert.equal(await takeEarly(HOSTS, 'eth_call', [], { store: undefined, rpc }), 'nodes:3', 'no early reads at all: the nodes');
}
ok('a read sent from the head is taken once by the call that asks for exactly it; a failed one falls to the other nodes, a slow one is hedged once (no more requests at once than before), a revert is the answer');

// ── what the page learns of its nodes (health), the wallet as a node, and reads asked twice ──
{
  let t = 1e6; const now = () => t, store = new Map(), kv = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const health = nodeHealth({ now, store: kv });
  const via = (plan, o = {}) => { const x = nodes(plan); return hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 40, fetchImpl: x.fetchImpl, health, ...o }).then((v) => ({ v, log: x.log })); };
  assert.deepEqual(health.order(HOSTS), HOSTS, 'nothing is known: the order given');
  let r = await via({ 'https://a': { throws: 'reset' } });
  assert.equal(r.v, 'https://b'); assert.deepEqual(r.log.asked, ['https://a', 'https://b']);
  r = await via({ 'https://a': { throws: 'reset' } });
  assert.deepEqual(r.log.asked, ['https://b'], 'the node that failed rests: the next call does not ask it first');
  assert.deepEqual(health.order(HOSTS), ['https://b', 'https://c', 'https://a'], 'and it is asked last, not left out');
  t += 31e3; r = await via({});
  assert.deepEqual(r.log.asked, ['https://a'], 'when its rest is over (30 s) it is first again'); assert.equal(r.v, 'https://a');
  ok('a node that failed rests and is asked last, never left out, and is first again when its rest is over');

  // failures in a row lengthen the rest, up to two minutes; one answer forgives them
  for (let i = 0; i < 6; i++) health.fail('https://c', 'down');
  assert.deepEqual(health.order(HOSTS).at(-1), 'https://c');
  t += 119e3; assert.deepEqual(health.order(HOSTS).at(-1), 'https://c', 'still resting after 119 s');
  t += 2e3; assert.deepEqual(health.order(HOSTS), HOSTS, 'never more than two minutes');
  health.fail('https://a', 'limited'); t += 16e3; assert.deepEqual(health.order(HOSTS), HOSTS, 'a rate limit rests 15 s');
  health.fail('https://a', 'down'); health.ok('https://a'); assert.deepEqual(health.order(HOSTS), HOSTS, 'an answer forgives');
  ok('rests double with each failure in a row (15 s for a rate limit, 20 s hung, 30 s failed), to two minutes at most, and an answer forgives them');
}
{
  let t = 5e6; const now = () => t, store = new Map(), kv = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const a = nodeHealth({ now, store: kv }); a.fail('https://a', 'slow');
  const b = nodeHealth({ now, store: kv });
  assert.deepEqual(b.order(HOSTS), ['https://b', 'https://c', 'https://a'], 'the next page of the visit starts with what this one learned');
  t += 21e3; assert.deepEqual(nodeHealth({ now, store: kv }).order(HOSTS), HOSTS, 'and not for longer than the rest');
  store.set('tacit-rpc-rest-v1', JSON.stringify({ a: t + 9e9 })); assert.deepEqual(nodeHealth({ now, store: kv }).order(HOSTS), ['https://b', 'https://c', 'https://a']);
  t += 121e3; store.set('tacit-rpc-rest-v1', JSON.stringify({ a: t + 9e9 })); const c = nodeHealth({ now, store: kv }); t += 121e3; assert.deepEqual(c.order(HOSTS), HOSTS, 'a stored rest is cut to two minutes');
  store.set('tacit-rpc-rest-v1', '{not json'); assert.deepEqual(nodeHealth({ now, store: kv }).order(HOSTS), HOSTS, 'a store that is not readable is no knowledge');
  assert.deepEqual(nodeHealth({ now, store: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } }).order(HOSTS), HOSTS);
  assert.doesNotThrow(() => nodeHealth({ now, store: { getItem: () => null, setItem() { throw new Error('denied'); } } }).fail('https://a'), 'a store that refuses is no failure');
  ok('what a page learned is kept for the next page (short, clamped, and no matter what the store does)');
}
{
  let t = 1e6; const health = nodeHealth({ now: () => t }), strict = nodeHealth({ now: () => t, strict: true });
  const via = (plan, h) => { const x = nodes(plan); return hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 5000, fetchImpl: x.fetchImpl, health: h }).then((v) => ({ v, log: x.log })); };
  await via({ 'https://a': { error: { code: -32000, message: 'out of gas: gas required exceeds: 50000000' } } }, health);
  assert.deepEqual(health.order(HOSTS), HOSTS, 'a node that answers with a refusal of its own has not failed: it serves other calls');
  await via({ 'https://a': { error: { code: -32000, message: 'out of gas: gas required exceeds: 50000000' } } }, strict);
  assert.deepEqual(strict.order(HOSTS), ['https://b', 'https://c', 'https://a'], 'strict: for a call only some nodes serve, a refusal rests the node');
  const limited = nodeHealth({ now: () => t });
  await via({ 'https://a': { error: { code: -32000, message: 'out of gas' } }, 'https://b': { error: { code: 429, message: 'rate limit exceeded' } } }, limited);
  assert.deepEqual(limited.order(HOSTS), ['https://a', 'https://c', 'https://b'], 'a node that says it is limiting the rate rests either way (one that only refused the call does not)');
  const h2 = nodeHealth({ now: () => t }); await via({ 'https://a': { error: { code: 3, message: 'execution reverted' } } }, h2).catch(() => {});
  assert.deepEqual(h2.order(HOSTS), HOSTS, 'a revert is the contract\'s answer and says nothing of the node');
  ok('a refusal is a failure only for a strict list or when the node says it is rate limited; a revert never is');
}
{
  const health = nodeHealth({ now: () => 1e6 });
  const x = nodes({ 'https://a': { hang: true }, 'https://b': { wait: 5 } });
  assert.equal(await hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 30, fetchImpl: x.fetchImpl, health }), 'https://b');
  assert.deepEqual(health.order(HOSTS), ['https://b', 'https://c', 'https://a'], 'a node beaten by its hedge rests: it was slow');
  const y = nodes({ 'https://a': { wait: 60, result: 'late' }, 'https://b': { wait: 1 } }), h2 = nodeHealth({ now: () => 1e6 });
  assert.equal(await hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 30, fetchImpl: y.fetchImpl, health: h2 }), 'https://b');
  const z = nodes({ 'https://a': { wait: 20 } }), h3 = nodeHealth({ now: () => 1e6 });
  await hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 5000, fetchImpl: z.fetchImpl, health: h3 }); assert.deepEqual(h3.order(HOSTS), HOSTS);
  const h4 = nodeHealth({ now: () => 1e6 }), w = nodes({ 'https://a': { hang: true } });
  await hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 5000, timeoutMs: 40, fetchImpl: w.fetchImpl, health: h4 });
  assert.deepEqual(h4.order(HOSTS), ['https://b', 'https://c', 'https://a'], 'a node that times out rests');
  ok('a node that hangs rests, whether it was beaten by its hedge or timed out; one that answered in time does not');
}
{
  const wallet = (o = {}) => { const seen = []; return { seen, id: 'wallet', usable: o.usable ?? (() => true), send: async (m, p) => { seen.push([m, p]); if (o.fail) throw o.fail; return o.result ?? 'from the wallet'; } }; };
  const via = (hosts, plan, o = {}) => { const x = nodes(plan); return hedgedRpc(hosts, 'eth_call', [{ to: '0x1' }, 'latest'], { hedgeMs: 5000, fetchImpl: x.fetchImpl, ...o }).then((v) => ({ v, log: x.log }), (e) => Promise.reject(Object.assign(e, { log: x.log }))); };
  const w = wallet();
  let r = await via([...HOSTS, w], {});
  assert.equal(r.v, 'https://a'); assert.equal(w.seen.length, 0, 'last in the list, the wallet is not asked while a node answers');
  r = await via([...HOSTS, w], { 'https://a': { throws: 'x' }, 'https://b': { throws: 'x' }, 'https://c': { throws: 'x' } });
  assert.equal(r.v, 'from the wallet'); assert.deepEqual(w.seen, [['eth_call', [{ to: '0x1' }, 'latest']]], 'the last resort: asked once every node has failed');
  const off = wallet({ usable: () => false });
  await assert.rejects(via([...HOSTS, off], { 'https://a': { throws: 'x' }, 'https://b': { throws: 'x' }, 'https://c': { throws: 'three' } }), /three/);
  assert.equal(off.seen.length, 0, 'a wallet that says it cannot serve this call is not asked');
  assert.equal((await via([off], {}).catch((e) => e.message)), 'no RPC answered', 'and when it is all there is');
  await assert.rejects(via([...HOSTS, wallet({ fail: Object.assign(new Error('execution reverted'), { code: 3 }) })], { 'https://a': { throws: 'x' }, 'https://b': { throws: 'x' }, 'https://c': { throws: 'x' } }), (e) => e.revert === true);
  const odd = wallet({ fail: { code: 4001, message: 'User rejected the request.' } });          // a wallet's errors are plain objects
  await assert.rejects(via([...HOSTS, odd], { 'https://a': { throws: 'x' }, 'https://b': { throws: 'x' }, 'https://c': { throws: 'x' } }), /rejected/);
  const slow = { id: 'wallet', send: () => new Promise(() => {}) };
  const t0 = Date.now(); await assert.rejects(via(['https://a', slow], { 'https://a': { throws: 'x' } }, { lastTimeoutMs: 60 })); assert.ok(Date.now() - t0 < 400, 'a wallet that never answers times out like a node');
  const health = nodeHealth({ now: () => 1e6 }); await via([...HOSTS, w], { 'https://a': { throws: 'x' }, 'https://b': { throws: 'x' }, 'https://c': { throws: 'x' } }, { health });
  assert.deepEqual(health.order([...HOSTS, w]).map((h) => (typeof h === 'string' ? h : h.id)), ['wallet', 'https://a', 'https://b', 'https://c'], 'the nodes that failed rest behind the wallet that answered');
  ok('the wallet is a node of last resort: asked after the others, only when it says it can serve the call, its reverts are reverts, it times out like a node');
}
{
  let asked = 0; const gate = []; const rpc = (hosts, method, params) => { asked++; return new Promise((res, rej) => gate.push({ res, rej, method, params })); };
  const share = shareReads(rpc);
  const p1 = share(HOSTS, 'eth_call', [{ to: '0x1', data: '0x01' }, 'latest']), p2 = share(HOSTS, 'eth_call', [{ to: '0x1', data: '0x01' }, 'latest']);
  assert.equal(asked, 1, 'asked for twice at once, asked once'); assert.equal(p1, p2);
  share(HOSTS, 'eth_call', [{ to: '0x1', data: '0x02' }, 'latest']); share(HOSTS, 'eth_call', [{ to: '0x1', data: '0x01' }, 'latest'].concat([{}])); share(HOSTS.slice(1), 'eth_call', [{ to: '0x1', data: '0x01' }, 'latest']);
  assert.equal(asked, 4, 'another call, another state override, another set of nodes: not the same read');
  share(HOSTS, 'eth_sendRawTransaction', ['0xaa']); share(HOSTS, 'eth_sendRawTransaction', ['0xaa']); assert.equal(asked, 6, 'a send is never shared');
  gate[0].res('0xanswer'); assert.equal(await p1, '0xanswer');
  share(HOSTS, 'eth_call', [{ to: '0x1', data: '0x01' }, 'latest']); assert.equal(asked, 7, 'once answered, the next ask goes to the nodes again (nothing is kept)');
  const f = share(HOSTS, 'eth_blockNumber', []), g = share(HOSTS, 'eth_blockNumber', []); assert.equal(asked, 8);
  gate.at(-1).rej(new Error('down')); await assert.rejects(f, /down/); await assert.rejects(g, /down/);
  share(HOSTS, 'eth_blockNumber', []); assert.equal(asked, 9, 'a failure is shared by those that waited for it, and not kept');
  ok('a read asked for twice at once is asked once (same nodes, same call), its answer or failure goes to each, and nothing is kept after');
}
console.log(`\n${n} trade-rpc checks passed`);
