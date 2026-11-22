// Before a swap or a liquidity add is paid for, compare the reserves it was built on with the ones the pool holds now. ConfidentialPool.settle
// takes a swap hop, a wrap-swap or a liquidity add only against the exact reserves its proof binds (PoolReserveMismatch, 0x29b3c833), and any
// trade on the pool in the minutes between the holder's build and the relay's settle moves them: the settle then reverts whatever it proves, and
// the proof was bought for nothing. A job whose reserves are already stale is failed without proving, with the selector in the ack so the pages
// read "the pool moved" and the holder's page builds it again at the new price within seconds, not after a proof.
// A liquidity REMOVE settles against the live reserves (no pin), so it is never checked. Anything unreadable or unusual lets the job through: a route
// that passes through one pool twice (its second hop binds the first hop's result), a pool with a protocol fee (its id differs), an op that does not
// parse. A node a block behind the page that built the op would show the older reserves, so a mismatch is read again a few seconds later before
// it is believed. The check only ever skips work that cannot succeed.
import { concat, keccak256, numberToHex, pad } from 'viem';

const POOLS_ABI = [{ type: 'function', name: 'pools', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [
  { type: 'bool' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'uint256' }] }];

export const POOL_RESERVE_MISMATCH = '0x29b3c833';
const LABEL = { route: 'swap', wrapswap: 'swap', wraplp: 'liquidity add' };

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
  if (type === 'wrapswap' || type === 'wraplp') {
    if (BigInt(op.protocolFeeBps ?? 0) !== 0n) return null;
    return [{ id: poolIdOf(op.assetA, op.assetB, op.feeBps), a: BigInt(op.reserveAPre), b: BigInt(op.reserveBPre), ...(type === 'wraplp' ? { shares: BigInt(op.sharesPre) } : {}) }];
  }
  return null;
}

const held = async (client, pool, id) => {
  const r = await client.readContract({ address: pool, abi: POOLS_ABI, functionName: 'pools', args: [id] });
  return { a: BigInt(r[3]), b: BigInt(r[4]), shares: BigInt(r[6]) };
};
const differs = (pin, now) => now.a !== pin.a || now.b !== pin.b || (pin.shares != null && now.shares !== pin.shares);

// The ack's error when the job's settle can only revert, else null. `lookAgainMs`: the pauses before each further reading of a mismatch.
export async function poolMovedAck({ type, op }, { client, pool, lookAgainMs = [3000, 3000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!LABEL[type]) return null;
  try {
    const pins = pinsOf({ type, op });
    if (!pins) return null;
    for (let look = 0; ; look++) {
      const now = await Promise.all(pins.map((p) => held(client, pool, p.id)));
      if (!pins.some((p, i) => differs(p, now[i]))) return null;
      if (look >= lookAgainMs.length) break;
      await sleep(lookAgainMs[look]);
    }
  } catch { return null; }
  return `${LABEL[type]} not proved: the pool moved after this was built, so it was not proved and nothing was spent (${POOL_RESERVE_MISMATCH})`;
}
