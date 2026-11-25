// The ceremony's points feed, in the shape the points service reads for a day of proof mining
// (worker-relay/src/lib/points-mine-service.js readTally): GET /api/credits?day=<UTC day number> ->
// { day, over, miners: [{ miner, proofs, points }] }.
//
// Each accepted contribution whose handle (or, failing that, name) is a 0x address credits that address once over the whole
// ceremony, on the UTC day of its receipt: later contributions from the same address earn nothing more. Only receipts that
// are signed by the pinned coordinator key and chain from the pinned base count (trustedFiles), so a transcript changed on the
// way from the coordinator credits nobody. Addresses in `exclude` (Tacit's own machines) are never credited.
import { trustedFiles } from './mirror.mjs';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const DAY_MS = 86_400_000;

export function addressOf(r) {
  for (const v of [r.handle, r.name]) if (typeof v === 'string' && ADDR.test(v.trim())) return v.trim().toLowerCase();
  return null;
}

// every credited contribution: { miner, day, index }, the first per address
export async function credited(t, { exclude = [], key, base } = {}) {
  const { files } = await trustedFiles(t, key, base);
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const r of files.slice(1)) {                       // files[0] is the base, not a contribution
    const a = addressOf(r);
    const at = Date.parse(r.at);
    if (!a || skip.has(a) || seen.has(a) || !Number.isFinite(at)) continue;
    seen.add(a);
    out.push({ miner: a, day: Math.floor(at / DAY_MS), index: r.index });
  }
  return out;
}

export async function dayTally(t, day, { points = 100, exclude = [], nowMs = Date.now(), key, base } = {}) {
  const miners = (await credited(t, { exclude, key, base }))
    .filter((c) => c.day === day)
    .map((c) => ({ miner: c.miner, proofs: 1, points }))
    .sort((a, b) => (a.miner < b.miner ? -1 : 1));
  return { day, over: day < Math.floor(nowMs / DAY_MS), miners };
}
