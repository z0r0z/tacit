// One JSON-RPC read over a list of public nodes. The nodes are asked in order, but one that has not answered in `hedgeMs` is not waited on alone: the
// next is asked as well, once, and the first answer wins (a node that hangs used to cost its whole timeout before the next was tried), and the others
// are then cancelled. Only once, so that nodes which are all merely slow are not each sent the same heavy read. A node that answers with an error
// moves on to the next at once. A revert is the contract's answer, not a node's failure, so it ends the call. Never more requests than nodes.
// `hedgeMs` 0 asks one node at a time. A browser can set it: localStorage['tacit-trade-hedge-ms'] (milliseconds; 0 switches hedging off).
// A JSON-RPC body goes out as text/plain to the nodes that take it, so the browser does not ask first (see ../rpc-body.js).
import { bodyType } from '../rpc-body.js';
export { bodyType };
export const hedgeDelay = () => { try { const v = localStorage.getItem('tacit-trade-hedge-ms'); return v == null || v === '' || !Number.isFinite(Number(v)) ? 2500 : Math.max(0, Number(v)); } catch { return 2500; } };
export function hedgedRpc(hosts, method, params, { hedgeMs = hedgeDelay(), timeoutMs = 12e3, lastTimeoutMs = 30e3, fetchImpl = (...a) => fetch(...a) } = {}) {
  return new Promise((resolve, reject) => {
    if (!hosts.length) return reject(new Error('no RPC answered'));
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ctrls = new Set();
    let next = 0, live = 0, over = false, last = null, hedge = 0, hedged = false;
    const finish = (f, v) => { if (over) return; over = true; clearTimeout(hedge); for (const c of ctrls) c.abort(); f(v); };
    const launch = () => {
      if (over || next >= hosts.length) return;
      const n = next++, ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), n === hosts.length - 1 ? lastTimeoutMs : timeoutMs);
      ctrls.add(ctrl); live++;
      clearTimeout(hedge); if (hedgeMs > 0 && !hedged && next < hosts.length) hedge = setTimeout(() => { hedged = true; launch(); }, hedgeMs);
      (async () => {
        const j = await (await fetchImpl(hosts[n], { method: 'POST', headers: { 'content-type': bodyType(hosts[n]) }, body, signal: ctrl.signal })).json();
        if (j.error) throw Object.assign(new Error(j.error.message), { revert: j.error.code === 3 || /revert/i.test(j.error.message || '') });
        if (!('result' in j)) throw new Error('rpc: no result');
        return j.result;
      })().then(
        (v) => { clearTimeout(timer); ctrls.delete(ctrl); finish(resolve, v); },
        (e) => { clearTimeout(timer); ctrls.delete(ctrl); live--; if (over) return; if (e.revert) return finish(reject, e); last = e; if (next < hosts.length) launch(); else if (!live) finish(reject, last); },
      );
    };
    launch();
  });
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
