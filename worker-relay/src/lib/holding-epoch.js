// The fixed rules of a holding reward, shared by whoever proves and whoever verifies: which sizes of note can be claimed, how
// the day's snapshot moment is drawn, and what a claim is bound to. Pure.
//
// A day's snapshot is drawn after the day has ended, from the hash of an Ethereum block that did not exist until then, so nobody
// can time a deposit to it; each chain's snapshot is the last block at or before that moment of the same day.
import { encodeAbiParameters, encodePacked, keccak256, getAddress } from 'viem';

export const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DAY = 86400;
export const ETH = 10n ** 18n;

// Roughly geometric, so a claim names a size and not a balance: finer sizes would let a size stand for one depositor.
export const DEFAULT_BUCKETS_WEI = [ETH / 100n, ETH * 3n / 100n, ETH / 10n, ETH * 3n / 10n, ETH, ETH * 3n];

export function parseBuckets(spec, dflt = DEFAULT_BUCKETS_WEI) {
  if (!spec) return dflt;
  const out = String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(\d+)(?:\.(\d{1,18}))?$/);
    if (!m) throw new Error(`holding bucket "${s}" is not an ETH amount`);
    return BigInt(m[1]) * ETH + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
  }).filter((w) => w > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!out.length) throw new Error('no holding buckets');
  return [...new Set(out.map(String))].map(BigInt);
}

// The largest bucket a note of `valueWei` can claim, or null when it is below the smallest.
export function bucketFor(valueWei, buckets) {
  let best = null;
  for (const b of buckets) if (BigInt(valueWei) >= b) best = b;
  return best;
}

// The moment, in seconds, of `epoch`'s snapshot: a draw within the day from the randomness block's hash.
export function snapshotTime({ epoch, chainId, randomHash }) {
  const seed = BigInt(keccak256(encodePacked(['string', 'bytes32', 'uint256', 'uint256'], ['tacit-holding-snapshot', randomHash, BigInt(chainId), BigInt(epoch)])));
  return BigInt(epoch) * BigInt(DAY) + (seed % BigInt(DAY));
}

// What a claim's signature covers about its payout: the chain, the day and the address the points go to, as a field element.
export function claimHashOf({ chainId, epoch, claimAddress }) {
  const enc = encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }], ['tacit-holding-claim', BigInt(chainId), BigInt(epoch), getAddress(claimAddress)]);
  return BigInt(keccak256(enc)) % FIELD_P;
}

// The id a claim's credit is recorded under: one per tag per day, shaped like a transaction hash.
export function holdingTxHash({ chainId, epoch, retNf }) {
  return keccak256(encodePacked(['string', 'uint256', 'uint256', 'uint256'], ['tacit-holding-credit', BigInt(chainId), BigInt(epoch), BigInt(retNf)]));
}

// The UTC days whose snapshot can be drawn at `nowSec` (ended at least `delaySecs` ago) and are still claimable, newest first.
export function claimableEpochs({ nowSec, delaySecs = 1800, windowDays = 2 }) {
  const out = [];
  for (let e = Math.floor((nowSec - delaySecs) / DAY) - 1; e >= Math.floor((nowSec - delaySecs) / DAY) - windowDays; e--) out.push(e);
  return out;
}
