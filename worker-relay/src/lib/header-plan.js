// What the header feeder does with the headers it could submit right now. Pure, so the cadence rules are
// testable without a chain, and so the defaults are provably the behaviour the feeder always had.
//
//   pending    headers between the relay's tip and the target (`to - base`).
//   minBatch   wait until at least this many are pending (1 = submit as soon as any block exists).
//   maxStale   when > 0, a pending count at or above it forces a submit even while the gas ceiling is exceeded
//              or the batch is short; it is the bound on how far behind the relay may be left.
//   restore    the relay is off the canonical chain: restoring it outranks the batching wait (it still honours the gas
//              ceiling, exactly as before).
//
// Returns { action: 'idle' } | { action: 'wait', reason: 'batching' | 'gas', pending } |
//         { action: 'advance', from, to, forced }.
export function planHeaderAdvance({ base, to, minBatch = 1, maxStale = 0, maxBatch, gasDear = false, restore = false }) {
  const pending = to - base;
  if (!(pending > 0)) return { action: 'idle', pending: 0 };
  const forced = maxStale > 0 && pending >= maxStale;
  if (!forced && !restore && pending < Math.max(1, minBatch)) return { action: 'wait', reason: 'batching', pending };
  if (!forced && gasDear) return { action: 'wait', reason: 'gas', pending };
  const from = base + 1;
  const end = Math.min(to, from + maxBatch - 1);
  return { action: 'advance', from, to: end, forced };
}
