// The base fee of each of the last ~day of blocks, in gwei, oldest first: the norm lib/gas-pace.js measures a price against.
//
// eth_feeHistory serves 1,024 blocks a call, so a day (7,200 blocks) is seven calls. A block's base fee never changes, only the
// window moves, so it is read again every half hour, shared by every stage of the lane that asks, and a read that fails leaves
// the last good one standing (a stale norm is better than none). A node that will not serve older blocks gives a shorter history,
// which is used if it covers a couple of hours and otherwise not at all (null: the caller falls back to its fixed numbers).

import { MIN_HISTORY } from './gas-pace.js';

export function makeBaseFeeHistory(client, { blocks = 7200, chunk = 1024, ttlMs = 30 * 60_000, now = () => Date.now() } = {}) {
  let last = null;       // { at, gwei }
  let inflight = null;
  async function read() {
    const head = BigInt(await client.getBlockNumber());
    const out = [];      // newest chunk first; each chunk is oldest-first
    for (let newest = head; out.reduce((s, c) => s + c.length, 0) < blocks && newest > BigInt(chunk); newest -= BigInt(chunk)) {
      let h;
      try { h = await client.getFeeHistory({ blockCount: chunk, blockNumber: newest, rewardPercentiles: [] }); }
      catch { break; }                                       // an older range the node will not serve: keep what we have
      // the list ends with the base fee of the block after `newest`; the chunk is the blocks up to it
      const fees = (h?.baseFeePerGas || []).slice(0, -1).map((w) => Number(w) / 1e9).filter((v) => Number.isFinite(v));
      if (!fees.length) break;
      out.push(fees);
    }
    const all = out.reverse().flat();
    return all.length >= MIN_HISTORY ? all.slice(-blocks) : null;
  }
  return async function baseFeeHistory() {
    if (last && now() - last.at < ttlMs) return last.gwei;
    if (inflight) return inflight;
    inflight = read()
      .then((gwei) => { if (gwei) last = { at: now(), gwei }; else if (last) last.at = now() - ttlMs + 5 * 60_000; return gwei || last?.gwei || null; })
      .catch(() => { if (last) last.at = now() - ttlMs + 5 * 60_000; return last?.gwei || null; })
      .finally(() => { inflight = null; });
    return inflight;
  };
}
