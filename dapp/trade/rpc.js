// One JSON-RPC read over a list of public nodes. The nodes are asked in order, but one that has not answered in `hedgeMs` is not waited on alone: the
// next is asked as well, once, and the first answer wins (a node that hangs used to cost its whole timeout before the next was tried), and the others
// are then cancelled. Only once, so that nodes which are all merely slow are not each sent the same heavy read. A node that answers with an error
// moves on to the next at once. A revert is the contract's answer, not a node's failure, so it ends the call. Never more requests than nodes.
// `hedgeMs` 0 asks one node at a time. A browser can set it: localStorage['tacit-trade-hedge-ms'] (milliseconds; 0 switches hedging off).
// A JSON-RPC body goes out as text/plain to the nodes that take it, so the browser does not ask first (see ../rpc-body.js).
// A node is a URL, or { id, usable?(method, params), send(method, params, signal) } for one that is not (the connected wallet's): `usable` says whether
// it can serve this call, and it is asked only when it is reached, so last in the list it is the last resort. `health` (nodeHealth, below) is what the page
// has learned of its nodes: those that failed lately are asked last, and what happens to each call is told to it. Neither is used unless asked for.
import { bodyType } from '../rpc-body.js';
import { refuses } from '../eth-nodes.js';
import { pace } from '../rpc-pace.js';
export { bodyType };
export const hedgeDelay = (fallback = 2500) => { try { const v = localStorage.getItem('tacit-trade-hedge-ms'); return v == null || v === '' || !Number.isFinite(Number(v)) ? fallback : Math.max(0, Number(v)); } catch { return fallback; } };
const idOf = (h) => (typeof h === 'string' ? h.replace(/^https?:\/\//, '') : h.id);
const LIMITED = /rate.?limit|usage limit|too many|\b429\b|compute units|capacity|quota|throttl|slow down/i;
// A shared public key that has used up what it may serve (every visitor reads through it) does not serve again for a while: it rests longer than one that is merely busy.
export const QUOTA = /api usage limit|usage limit|quota|daily limit/i;

// What a page has learned about its nodes. A node that does not answer rests: for 15 s when it limits the rate, 20 s when it hung, 30 s when it failed, doubled for
// each failure in a row (never over two minutes), and the calls that come while it rests ask the others first. It is never left out: a node that is resting is asked
// last, and once it answers it is forgiven. `store` (localStorage) carries the rests to the next page of the visit; `strict` counts a node's own refusal of a call
// (a gas cap on a heavy read) as a failure too, which a list of nodes asked only for what any node serves does not need. A node whose key has used up its quota
// rests a minute, doubling to five. `shared`: the readers that ask for the same `key` have one record, so a node one of them found refusing is not
// asked by the others (each would otherwise learn it by being refused, and the console lists every refusal). `shared` is true for the whole page, or an
// object (the fetch the readers use) to share among the readers of that one.
const SHARED = new WeakMap(), PAGE = {};
export function nodeHealth({ now = () => Date.now(), store = null, key = 'tacit-rpc-rest-v1', strict = false, shared = false } = {}) {
  const scope = shared ? (typeof shared === 'object' || typeof shared === 'function' ? shared : PAGE) : null;
  const records = scope ? SHARED.get(scope) || SHARED.set(scope, new Map()).get(scope) : null;
  if (records?.has(key)) return records.get(key);
  const REST = { limited: 15e3, slow: 20e3, down: 30e3, quota: 60e3 }, LONGEST = 120e3, QUOTA_LONGEST = 300e3, until = new Map(), strikes = new Map(), quota = new Set();
  // a quota rest is kept as `q!<node>` so that a stored rest of any other kind is still cut to two minutes
  try { for (const [k, t] of Object.entries(JSON.parse(store?.getItem(key) || 'null') || {})) { const q = k.startsWith('q!'), id = q ? k.slice(2) : k; if (t > now()) { until.set(id, Math.min(t, now() + (q ? QUOTA_LONGEST : LONGEST))); if (q) quota.add(id); } } } catch { }
  const save = () => { try { store?.setItem(key, JSON.stringify(Object.fromEntries([...until].filter(([, t]) => t > now()).map(([id, t]) => [quota.has(id) ? 'q!' + id : id, t])))); } catch { } };
  const health = {
    strict,
    order(hosts) { const t = now(), tired = (h) => (until.get(idOf(h)) || 0) > t; return [...hosts.filter((h) => !tired(h)), ...hosts.filter(tired)]; },
    fail(h, kind = 'down') { const id = idOf(h), n = Math.min((strikes.get(id) || 0) + 1, 4); strikes.set(id, n); if (kind === 'quota') quota.add(id); else quota.delete(id); until.set(id, now() + Math.min(REST[kind] * 2 ** (n - 1), kind === 'quota' ? QUOTA_LONGEST : LONGEST)); save(); },
    ok(h) { const id = idOf(h); strikes.delete(id); quota.delete(id); if (until.delete(id)) save(); },
    // whether the node is resting because its key's quota is used up: it will refuse until the rest ends, so a caller that has other ways to go does not ask it
    quotaRest(h) { const id = idOf(h); return quota.has(id) && (until.get(id) || 0) > now(); },
  };
  records?.set(key, health);
  return health;
}
// A node that is not a URL answers through its own `send`; a request cannot be taken back from it, so the call stops waiting when it is cancelled.
const sendVia = (h, method, params, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  Promise.resolve(h.send(method, params, signal)).then(resolve, (e) => reject(Object.assign(e instanceof Error ? e : new Error(e?.message || 'the node refused'), { rpc: true, revert: e?.code === 3 || /revert/i.test(e?.message || '') })));
});
export function hedgedRpc(hosts, method, params, { hedgeMs = hedgeDelay(), timeoutMs = 12e3, lastTimeoutMs = 30e3, fetchImpl = (...a) => fetch(...a), health = null } = {}) {
  return new Promise((resolve, reject) => {
    const usable = hosts.filter((h) => typeof h === 'string' || !h.usable || h.usable(method, params));
    if (!usable.length) return reject(new Error('no RPC answered'));
    const ordered = health ? health.order(usable) : usable;
    // A node known to refuse this read (eth-nodes.js) is not asked while there is another to ask: the browser lists every refused request, and the answer is known. When it is all
    // there is, it is asked. A node that is not a URL (the wallet's) keeps its place.
    const urls = ordered.filter((h) => typeof h === 'string'), fine = urls.filter((h) => !refuses(h, method, params));
    const list = fine.length ? ordered.filter((h) => typeof h !== 'string' || fine.includes(h)) : ordered;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ctrls = new Set();
    let next = 0, live = 0, over = false, last = null, hedge = 0, hedged = false;
    const finish = (f, v) => { if (over) return; over = true; clearTimeout(hedge); for (const c of ctrls) c.abort(); f(v); };
    const launch = () => {
      if (over || next >= list.length) return;
      const n = next++, h = list[n], ctrl = Object.assign(new AbortController(), { node: h, at: Date.now() }), timer = setTimeout(() => { ctrl.timedOut = true; ctrl.abort(); }, n === list.length - 1 ? lastTimeoutMs : timeoutMs);
      ctrls.add(ctrl); live++;
      clearTimeout(hedge); if (hedgeMs > 0 && !hedged && next < list.length) hedge = setTimeout(() => { hedged = true; launch(); }, hedgeMs);
      (async () => {
        if (typeof h !== 'string') return sendVia(h, method, params, ctrl.signal);
        const r = await pace(h, method, () => fetchImpl(h, { method: 'POST', headers: { 'content-type': bodyType(h) }, body, signal: ctrl.signal }), ctrl.signal);
        let j; try { j = await r.json(); } catch (e) { throw Object.assign(new Error(`${idOf(h)} answered ${r.status ?? 'with no JSON'}`), { status: r.status }); }
        if (j.error) throw Object.assign(new Error(j.error.message), { rpc: true, revert: j.error.code === 3 || /revert/i.test(j.error.message || ''), data: j.error.data });
        if (!('result' in j)) throw new Error('rpc: no result');
        return j.result;
      })().then(
        // a node still out that was asked a hedge ago has been beaten by the one that answered: it is slow, and rests
        (v) => { clearTimeout(timer); ctrls.delete(ctrl); health?.ok(h); if (hedgeMs > 0) for (const c of ctrls) if (Date.now() - c.at >= hedgeMs) health?.fail(c.node, 'slow'); finish(resolve, v); },
        (e) => {
          clearTimeout(timer); ctrls.delete(ctrl); live--; if (over) return;
          if (e.revert) return finish(reject, e);
          // a refusal in the node's own words (it answered) is no failure of the node, unless it says it is being limited or `health` is strict
          if (health && (!e.rpc || health.strict || LIMITED.test(e.message))) health.fail(h, ctrl.timedOut ? 'slow' : QUOTA.test(e.message) ? 'quota' : e.status === 429 || LIMITED.test(e.message) ? 'limited' : 'down');
          last = e; if (next < list.length) launch(); else if (!live) finish(reject, last);
        },
      );
    };
    launch();
  });
}
// A read asked for twice at once is asked once: a call for exactly what another is still waiting for takes that one's answer, so a page that asks for the same
// thing from two places (or again, as a quote is made again) sends one request to the nodes. Only reads of the chain; the nodes asked are part of what is the same.
const READS = new Set(['eth_call', 'eth_getBalance', 'eth_gasPrice', 'eth_blockNumber', 'eth_chainId', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_getProof']);
export function shareReads(rpc = hedgedRpc) {
  const out = new Map();
  return (hosts, method, params, o) => {
    if (!READS.has(method)) return rpc(hosts, method, params, o);
    const k = `${method}${JSON.stringify(params)}|${hosts.map(idOf).join()}`;
    let p = out.get(k);
    if (!p) out.set(k, p = rpc(hosts, method, params, o).finally(() => out.delete(k)));
    return p;
  };
}
// hedgedRpc over `hosts`, except that a read the page's head has already sent to the first of them (the inline script in trade/index.html keeps them in `__tradeEarly`, by method and
// params) is taken by the first call that asks for exactly it, once. That read stands for the first node: when it fails the rest are asked as usual, and when
// it is still out after the hedge time the next node is asked beside it, and no other unless that one fails (never more requests at once than hedgedRpc
// makes). A revert is the contract's answer, so it is the call's.
export function takeEarly(hosts, method, params, { hedgeMs = hedgeDelay(), store = globalThis.__tradeEarly, rpc = hedgedRpc } = {}) {
  const k = method + JSON.stringify(params), p = store?.get(k);
  if (!p) return rpc(hosts, method, params);
  store.delete(k);
  return new Promise((resolve, reject) => {
    let over = false, asked = false, timer = 0;
    const done = (f, v) => { if (!over) { over = true; clearTimeout(timer); f(v); } };
    const fall = (slow) => { if (asked || over) return; asked = true; rpc(hosts.slice(1), method, params, slow ? { hedgeMs: 0 } : {}).then((v) => done(resolve, v), (e) => done(reject, e)); };
    if (hedgeMs > 0) timer = setTimeout(() => fall(true), hedgeMs);
    p.then((v) => done(resolve, v), (e) => (e?.revert ? done(reject, e) : fall(false)));
  });
}
