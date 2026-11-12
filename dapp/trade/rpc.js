import { bodyType } from '../rpc-body.js';
import { refuses } from '../eth-nodes.js';
import { pace } from '../rpc-pace.js';
export { bodyType };
export const hedgeDelay = (fallback = 2500) => { try { const v = localStorage.getItem('tacit-trade-hedge-ms'); return v == null || v === '' || !Number.isFinite(Number(v)) ? fallback : Math.max(0, Number(v)); } catch { return fallback; } };
const idOf = (h) => (typeof h === 'string' ? h.replace(/^https?:\/\//, '') : h.id);
const LIMITED = /rate.?limit|usage limit|too many|\b429\b|compute units|capacity|quota|throttl|slow down/i;
export const QUOTA = /api usage limit|usage limit|quota|daily limit/i;

const SHARED = new WeakMap(), PAGE = {};
export function nodeHealth({ now = () => Date.now(), store = null, key = 'tacit-rpc-rest-v1', strict = false, shared = false } = {}) {
  const scope = shared ? (typeof shared === 'object' || typeof shared === 'function' ? shared : PAGE) : null;
  const records = scope ? SHARED.get(scope) || SHARED.set(scope, new Map()).get(scope) : null;
  if (records?.has(key)) return records.get(key);
  const REST = { limited: 15e3, slow: 20e3, down: 30e3, quota: 60e3 }, LONGEST = 120e3, QUOTA_LONGEST = 300e3, until = new Map(), strikes = new Map(), quota = new Set();
  try { for (const [k, t] of Object.entries(JSON.parse(store?.getItem(key) || 'null') || {})) { const q = k.startsWith('q!'), id = q ? k.slice(2) : k; if (t > now()) { until.set(id, Math.min(t, now() + (q ? QUOTA_LONGEST : LONGEST))); if (q) quota.add(id); } } } catch { }
  const save = () => { try { store?.setItem(key, JSON.stringify(Object.fromEntries([...until].filter(([, t]) => t > now()).map(([id, t]) => [quota.has(id) ? 'q!' + id : id, t])))); } catch { } };
  const health = {
    strict,
    order(hosts) { const t = now(), tired = (h) => (until.get(idOf(h)) || 0) > t; return [...hosts.filter((h) => !tired(h)), ...hosts.filter(tired)]; },
    fail(h, kind = 'down') { const id = idOf(h), n = Math.min((strikes.get(id) || 0) + 1, 4); strikes.set(id, n); if (kind === 'quota') quota.add(id); else quota.delete(id); until.set(id, now() + Math.min(REST[kind] * 2 ** (n - 1), kind === 'quota' ? QUOTA_LONGEST : LONGEST)); save(); },
    ok(h) { const id = idOf(h); strikes.delete(id); quota.delete(id); if (until.delete(id)) save(); },
    quotaRest(h) { const id = idOf(h); return quota.has(id) && (until.get(id) || 0) > now(); },
  };
  records?.set(key, health);
  return health;
}
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
        (v) => { clearTimeout(timer); ctrls.delete(ctrl); health?.ok(h); if (hedgeMs > 0) for (const c of ctrls) if (Date.now() - c.at >= hedgeMs) health?.fail(c.node, 'slow'); finish(resolve, v); },
        (e) => {
          clearTimeout(timer); ctrls.delete(ctrl); live--; if (over) return;
          if (e.revert) return finish(reject, e);
          if (health && (!e.rpc || health.strict || LIMITED.test(e.message))) health.fail(h, ctrl.timedOut ? 'slow' : QUOTA.test(e.message) ? 'quota' : e.status === 429 || LIMITED.test(e.message) ? 'limited' : 'down');
          last = e; if (next < list.length) launch(); else if (!live) finish(reject, last);
        },
      );
    };
    launch();
  });
}
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
