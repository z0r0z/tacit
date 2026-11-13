import { refuses } from './eth-nodes.js';
import { pace } from './rpc-pace.js';

// A JSON-RPC reader over one or more URLs: each call tries them in turn, starting at the one that answered last, and
// fails only when all do (a revert is final at the first). The error thrown carries every node's error as `all`. A node
// gets `timeoutMs` to answer before the next is tried, so one that stops responding cannot stall every read behind it,
// and the next call starts after it even when none of the others answered either, so a retry does not wait on it again.
// `rpc.node` is the URL that answered last.
export function jsonRpc(urls, fetchImpl = globalThis.fetch.bind(globalThis), { timeoutMs = 25_000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let id = 0, first = 0;
  const timedOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
  // `{ found: true }` for a record that is known to exist (a transaction in a deep block): a node that answers null for it does
  // not have it (one that keeps recent history only does), so the next is asked, and null comes back only when none has it.
  const single = async (method, params = [], { found = false } = {}) => {
    const all = [], start = first; let none = false;
    // a node known to refuse this read (eth-nodes.js) is not asked while there is another to ask, and is when it is all there is
    const turn = list.map((_, k) => (start + k) % list.length), refused = (i) => refuses(list[i], method, params), fine = turn.filter((i) => !refused(i));
    for (const at of fine.length ? fine : turn) {
      const url = list[at];
      try {
        const signal = AbortSignal.timeout?.(timeoutMs);
        const r = await pace(url, method, () => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal }), signal);
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: j.error });
        if (j.result === undefined) throw new Error(`rpc: no result (HTTP ${r.status})`);
        if (found && j.result == null) { none = true; continue; }
        first = at; single.node = url;
        return j.result;
      } catch (e) {
        if (e.rpc && /revert/i.test(e.message) && (method === 'eth_call' || method === 'eth_estimateGas')) throw e;
        if (timedOut(e)) first = (at + 1) % list.length;
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
    const all = [], start = first;
    for (let k = 0; k < list.length; k++) {
      const at = (start + k) % list.length, url = list[at];
      if (noBatch.has(url)) continue;
      try {
        const base = id; id += calls.length;
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: c.method, params: c.params ?? [] }))), signal: AbortSignal.timeout?.(timeoutMs) });
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
        first = at; single.node = url;
        return out;
      } catch (e) { if (timedOut(e)) first = (at + 1) % list.length; all.push(e); }
    }
    throw Object.assign(all[all.length - 1] || new Error('no node takes batches'), { all });
  };
  return single;
}
