// The 4-byte selector a settle reverts with, so the relay's ack can name the error.
//
// Some providers answer a reverting eth_call with "execution reverted" and no data, and viem then calls it a revert
// "for an unknown reason". The pages map known selectors to words (dapp/index.html REVERTS, matched on "(0x…)" in
// the ack), so a selector that is lost leaves the holder with "the pool refused it" where the pool said why. When the
// error itself carries none, the same call is asked of public nodes (mainnet only) for theirs.
export const REVERT_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth.drpc.org'];

const SEL = /^0x[0-9a-f]{8}/i;

// A selector the error chain already carries: viem keeps the revert data on the error or one of its causes.
export function selectorIn(e) {
  for (let x = e, d = 0; x && d < 8; x = x.cause, d++) {
    for (const v of [x.data, x.data?.data, x.raw, x.error?.data]) if (typeof v === 'string' && SEL.test(v)) return v.slice(0, 10).toLowerCase();
    const m = String(x.message || '').match(/reverted with the following signature:\s*(0x[0-9a-f]{8})/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// `call` is { from, to, data }. Null when no node names one.
export async function revertSelector(e, call, { chainId = 1, rpcs = REVERT_RPCS, fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const own = selectorIn(e);
  if (own || Number(chainId) !== 1 || !call?.to || !call?.data) return own;
  for (const url of rpcs) {
    try {
      const r = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: call.from, to: call.to, data: call.data }, 'latest'] }),
      });
      const d = (await r.json())?.error?.data;
      if (typeof d === 'string' && SEL.test(d)) return d.slice(0, 10).toLowerCase();
    } catch { /* the next node */ }
  }
  return null;
}

// An op's own expiry, for the op types whose `deadline` the guest folds into the batch's min_deadline (the pool's
// `Expired()` gate: settle at or before it). Others carry a deadline that means something else, a lock's refund time
// among them, which is only valid AFTER it, so they are never read here. 0 or absent = no expiry.
const EXPIRY_TYPES = new Set(['unwrap', 'sendunwrap', 'swap', 'swap_var', 'swap_route', 'route', 'wrapswap', 'wraplp',
  'lpadd', 'lp_add', 'lpbond', 'lp_bond', 'lpremove', 'lp_remove', 'stealthclaim', 'adaptorlock', 'adaptorclaim']);
export function opExpiry(job) {
  if (!job || !EXPIRY_TYPES.has(String(job.type))) return 0;
  const v = Number(job.op?.opDeadline ?? job.op?.deadline ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
