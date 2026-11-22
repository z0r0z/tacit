// Before a swap or a liquidity add is paid for, compare the reserves it was built on with the ones the pool holds now. ConfidentialPool.settle
// takes a swap hop, a wrap-swap or a liquidity add only against the exact reserves its proof binds (PoolReserveMismatch, 0x29b3c833), and any
// trade on the pool in the minutes between the holder's build and the relay's settle moves them: the settle then reverts whatever it proves, and
// the proof was bought for nothing. A job whose reserves are already stale is failed without proving, with the selector in the ack so the pages
// read "the pool moved" and the holder's page builds it again at the new price within seconds, not after a proof.
// A liquidity REMOVE is not pinned to exact reserves but may take no more than its pro-rata share of the LIVE pool (the same selector when it takes more:
// a swap that moved the ratio the wrong way for one leg), so its amounts are checked against what the pool holds now. Anything unreadable or unusual lets the job through: a route
// that passes through one pool twice (its second hop binds the first hop's result), a pool with a protocol fee (its id differs), an op that does not
// parse. A node a block behind the page that built the op would show the older reserves, so a mismatch is read again a few seconds later before
// it is believed. The check only ever skips work that cannot succeed.
import { concat, keccak256, numberToHex, pad } from 'viem';

const POOLS_ABI = [{ type: 'function', name: 'pools', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [
  { type: 'bool' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'uint256' }] }];

export const POOL_RESERVE_MISMATCH = '0x29b3c833';
const LABEL = { route: 'swap', wrapswap: 'swap', wraplp: 'liquidity add', lp: 'liquidity add', lpbond: 'liquidity add', lpremove: 'liquidity removal' };

const word = (v) => pad(typeof v === 'string' && v.startsWith('0x') ? v : numberToHex(BigInt(v)), { size: 32 });

// The pool's id: keccak256(lower asset ‖ higher asset ‖ fee tier), as the contract, the guest and the page derive it.
export function poolIdOf(x, y, feeBps) {
  const [lo, hi] = BigInt(x) <= BigInt(y) ? [x, y] : [y, x];
  return keccak256(concat([word(lo), word(hi), word(feeBps)]));
}

// The pools an op binds, in order, with the reserves (and the share total, for an add) it was built on; null when the op is not one the pool pins
// exactly or not one this check can read.
export function pinsOf({ type, op }) {
  if (!op) return null;
  if (type === 'route') {
    if (!Array.isArray(op.hops) || !op.hops.length || op.asset0 == null) return null;
    let cur = op.asset0;
    const pins = op.hops.map((h) => {
      const pin = { id: poolIdOf(cur, h.assetNext, h.feeBps), a: BigInt(h.reserveAPre), b: BigInt(h.reserveBPre) };
      cur = h.assetNext;
      return pin;
    });
    return new Set(pins.map((p) => p.id)).size === pins.length ? pins : null;
  }
  if (type === 'wrapswap' || type === 'wraplp' || type === 'lp' || type === 'lpbond') {
    if (BigInt(op.protocolFeeBps ?? 0) !== 0n) return null;
    return [{ id: poolIdOf(op.assetA, op.assetB, op.feeBps), a: BigInt(op.reserveAPre), b: BigInt(op.reserveBPre), ...(type === 'wrapswap' ? {} : { shares: BigInt(op.sharesPre) }) }];
  }
  return null;
}

// A liquidity remove's withdrawal against the pool: the amounts it takes and the shares it burns, with the pool's id. null when the op is not a remove or not readable (a pool with a protocol fee has another id).
export function removeOf({ type, op }) {
  if (type !== 'lpremove' || !op) return null;
  if (BigInt(op.protocolFeeBps ?? 0) !== 0n) return null;
  const shares = op.share && op.share.dShares != null ? op.share.dShares : op.dShares;
  if (op.assetA == null || op.assetB == null || op.dA == null || op.dB == null || shares == null) return null;
  const dS = BigInt(shares);
  if (dS <= 0n) return null;
  return { id: poolIdOf(op.assetA, op.assetB, op.feeBps), dA: BigInt(op.dA), dB: BigInt(op.dB), dS };
}
// ConfidentialPool.settle's remove: dA·totalShares ≤ reserveA·dShares and the same for B, on what the pool holds now.
const takesTooMuch = (rm, now) => rm.dA * now.shares > now.a * rm.dS || rm.dB * now.shares > now.b * rm.dS;

const held = async (client, pool, id) => {
  const r = await client.readContract({ address: pool, abi: POOLS_ABI, functionName: 'pools', args: [id] });
  return { a: BigInt(r[3]), b: BigInt(r[4]), shares: BigInt(r[6]) };
};
const differs = (pin, now) => now.a !== pin.a || now.b !== pin.b || (pin.shares != null && now.shares !== pin.shares);

// The pools a job pins, by id; none for a job that pins no pool, or whose op does not parse (it is then never held back for another's sake).
export function poolIdsOf(job) {
  try { return (pinsOf(job) || []).map((p) => p.id); } catch { return []; }
}

// Jobs claimed together, split into the ones that can settle together and the ones that cannot. Two jobs pinned to the same pool's reserves never settle in one batch: the second's reserves are the
// first's result, not what the pool holds, so the batch's proof is bought for nothing and then every member is settled one by one (seen 11-22: two routes on one pool in a mixed batch). The first
// of a pool stays in `keep`, the rest come back in `later`, in the order they came, to be settled on their own once the batch is done, where the pool check refuses one the first moved the pool
// under, in seconds and with no proof.
export function splitByPool(jobs) {
  const taken = new Set(), keep = [], later = [];
  for (const j of jobs) {
    const ids = poolIdsOf(j);
    if (ids.some((id) => taken.has(id))) { later.push(j); continue; }
    for (const id of ids) taken.add(id);
    keep.push(j);
  }
  return { keep, later };
}

// The ack's error when the job's settle can only revert, else null. `lookAgainMs`: the pauses before each further reading of a mismatch. One look again, 2 s on, is enough for a node a block behind the
// page that built the op to catch up in most cases; a refusal that is wrong is cheap for the page to try again (its next build reads the pool afresh), and a right one should not keep the holder waiting.
export async function poolMovedAck({ type, op }, { client, pool, lookAgainMs = [2000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!LABEL[type]) return null;
  try {
    const pins = pinsOf({ type, op }), rm = pins ? null : removeOf({ type, op });
    if (!pins && !rm) return null;
    const ids = pins ? pins.map((p) => p.id) : [rm.id], stale = (now) => (pins ? pins.some((p, i) => differs(p, now[i])) : takesTooMuch(rm, now[0]));
    for (let look = 0; ; look++) {
      const now = await Promise.all(ids.map((id) => held(client, pool, id)));
      if (!stale(now)) return null;
      if (look >= lookAgainMs.length) break;
      await sleep(lookAgainMs[look]);
    }
  } catch { return null; }
  return `${LABEL[type]} not proved: the pool moved after this was built, so it was not proved and nothing was spent (${POOL_RESERVE_MISMATCH})`;
}
