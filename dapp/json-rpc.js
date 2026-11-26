import { refuses } from './eth-nodes.js';
import { pace } from './rpc-pace.js';

// A JSON-RPC reader over one or more URLs: each call tries them in turn, starting at the one that answered last, and
// fails only when all do (a revert is final at the first). The error thrown carries every node's error as `all`. A node
// gets `timeoutMs` to answer before the next is tried, so one that stops responding cannot stall every read behind it,
// and the next call starts after it even when none of the others answered either, so a retry does not wait on it again.
// `rpc.node` is the URL that answered last.
// A node that fails to answer at all (a 429 or 5xx, a CORS block that hides one, a refused connection) is rested for every reader of it and not asked again while another
// node can be: a minute the first time, twice as long for each failure in a row, at most ten minutes, and an answer clears the count (a good node that blinked once is
// back in a minute: the log scans that need it cannot be left to nodes that read a few hundred blocks). A timeout or a node's own error is not a rest: it may be this
// call. When every node is resting they are all asked, as before.
const RESTED = new Map(), STRIKES = new Map(), REST_BASE = 60e3, REST_MAX = 600e3;
export const restedUntil = (url) => RESTED.get(url) || 0;
export const forgetRests = () => { RESTED.clear(); STRIKES.clear(); };
const down = (e) => e?.name === 'TypeError' || /^http (429|5\d\d)$/.test(e?.message || '');
const rest = (url, e) => { if (!down(e)) return; const n = (STRIKES.get(url) || 0) + 1; STRIKES.set(url, n); RESTED.set(url, Date.now() + Math.min(REST_MAX, REST_BASE * 2 ** (n - 1))); };
export function jsonRpc(urls, fetchImpl = globalThis.fetch.bind(globalThis), { timeoutMs = 25_000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let id = 0, first = 0, head = list[0];
  // the list can change under it (eth-nodes.js ETH_NODES, when the reader turns their own node on or off): a new first node is where it starts again
  const begin = () => { if (list[0] !== head) { head = list[0]; first = 0; } return first; };
  const timedOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
  // `{ found: true }` for a record that is known to exist (a transaction in a deep block): a node that answers null for it does
  // not have it (one that keeps recent history only does), so the next is asked, and null comes back only when none has it.
  const single = async (method, params = [], { found = false } = {}) => {
    const all = [], start = begin(); let none = false;
    // a node known to refuse this read (eth-nodes.js) is not asked while there is another to ask, and is when it is all there is
    const turn = list.map((_, k) => (start + k) % list.length), refused = (i) => refuses(list[i], method, params), fine0 = turn.filter((i) => !refused(i)), calm = fine0.filter((i) => restedUntil(list[i]) <= Date.now()), fine = calm.length ? calm : fine0;
    for (const at of fine.length ? fine : turn) {
      const url = list[at];
      try {
        const signal = AbortSignal.timeout?.(timeoutMs);
        const r = await pace(url, method, () => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal }), signal);
        if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: j.error });
        if (j.result === undefined) throw new Error(`rpc: no result (HTTP ${r.status})`);
        if (found && j.result == null) { none = true; continue; }
        first = at; single.node = url; STRIKES.delete(url);
        return j.result;
      } catch (e) {
        if (e.rpc && /revert/i.test(e.message) && (method === 'eth_call' || method === 'eth_estimateGas')) throw e;
        if (timedOut(e)) first = (at + 1) % list.length;
        rest(url, e);
        all.push(e);
      }
    }
    if (none) return null;
    throw Object.assign(all[all.length - 1] || new Error('no rpc url'), { all });
  };
  // `calls` ([{ method, params }]) in one request, → the results in order: a result, null, or an Error for a call the node
  // answered with one. The nodes are tried as above; one that refuses batches as such (Invalid Request, Method not found, an
  // error that speaks of batches, or one answer for the lot) is not asked again, one that answers with anything else but an
  // array (busy, rate limited, failing) is passed over this time only, and one that answers every call with an error counts
  // as failed. Throws when no node takes it, and the caller asks one at a time.
  const noBatch = new Set();
  single.batch = async (calls) => {
    const all = [], start = begin();
    const order = Array.from({ length: list.length }, (_, k) => (start + k) % list.length), calm = order.filter((i) => restedUntil(list[i]) <= Date.now());
    for (const at of calm.length ? calm : order) {
      const url = list[at];
      if (noBatch.has(url)) continue;
      try {
        const base = id; id += calls.length;
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: c.method, params: c.params ?? [] }))), signal: AbortSignal.timeout?.(timeoutMs) });
        if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
        const j = await r.json();
        if (!Array.isArray(j)) {
          const err = j?.error, why = String(err?.message || j?.message || ''), status = r.status ?? 200;
          const busy = status === 429 || status >= 500 || /\brate\b|rate.?limit|\blimit|too many/i.test(why);
          if (!busy && (err?.code === -32600 || err?.code === -32601 || (status === 200 && (!err || /batch/i.test(why))))) noBatch.add(url);
          throw Object.assign(new Error(why || 'the node did not answer the batch'), err ? { rpc: err } : {});
        }
        const byId = new Map(j.map((x) => [x.id, x]));
        const out = calls.map((_, i) => {
          const x = byId.get(base + i + 1);
          return !x ? new Error('no answer') : x.error ? Object.assign(new Error(x.error.message || 'rpc error'), { rpc: x.error }) : x.result;
        });
        if (calls.length && out.every((x) => x instanceof Error)) throw out[0];
        first = at; single.node = url; STRIKES.delete(url);
        return out;
      } catch (e) { if (timedOut(e)) first = (at + 1) % list.length; rest(url, e); all.push(e); }
    }
    throw Object.assign(all[all.length - 1] || new Error('no node takes batches'), { all });
  };
  return single;
}
