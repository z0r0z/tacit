// How patient work that can wait should be, given the gas price now and what recent blocks paid.
//
// Two jobs wait for gas: the header feeder (a header is worth the same a few hours late, and a batch costs the same gas whenever it
// is sent) and the reflection attest (the same, once the blocks it covers have matured). What they save by waiting is the price,
// so the rule is a bar on the price and a bound on the wait.
//
// The bar. A fixed ceiling (HEADER_MAX_GAS_GWEI) is the right rule while gas sits in its usual range and the wrong one when gas
// settles above it for good. Replayed on 21 days of real base fees (median 0.07 gwei, over 0.3 gwei 11% of the time, a typical
// episode above it about ten minutes) the fixed ceiling and the staleness bound alone were as cheap as anything tried; with every
// base fee six times higher, the ceiling was never met, the relay waited out the whole 24-hour bound each time (10 hours behind
// on average, 25 at the 95th percentile) and paid a random price at the end of each wait. So the bar follows gas: it is the
// ceiling, or, once the last day's 30th percentile is above the ceiling, that percentile. In a usual market nothing changes; in a
// new normal the relay goes in the cheaper third of the day and stays about two hours behind instead of ten.
//
// The bound. The oldest waiting header goes at `maxWaitMin` whatever the bar says, unless the price is a spike (above spikeGwei
// and above spikeMult x the last day's median), when it keeps holding: a spike is hours at most, and a header sent into one costs
// fifty times what it does in a usual market. `staleBlocks` stays the last resort, at any price.
//
// Everything is gwei as a number. `history` is the base fee of each of the last ~day of blocks (lib/base-fee-history.js); with none,
// or too little of it to be a norm, only the fixed numbers apply, which is how the feeder behaved before the history was read.

// The p-th percentile (0..100) of a list of numbers; null for an empty list.
export function percentile(values, p) {
  const xs = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.floor(((xs.length - 1) * Number(p)) / 100)))];
}

// A norm needs about two hours of blocks behind it; fewer and only the fixed numbers are used.
export const MIN_HISTORY = 600;

// → { known, median, ceil, cheap, spike, basis }
//   ceil    the price above which a batch holds: Infinity when no ceiling is set (ceilGwei <= 0), else the ceiling or the followPct
//           percentile of the history, whichever is higher. `basis` says which ('ceiling' | 'the last day').
//   cheap   the price under which gas is cheap: cheapGwei, or the cheapPct percentile when that is higher.
//   spike   the price above which a bounded wait still holds: spikeGwei, or spikeMult x the median when that is higher.
export function paceBars(history, p = {}) {
  const hs = Array.isArray(history) ? history.filter((v) => Number.isFinite(v)) : [];
  const known = hs.length >= MIN_HISTORY;
  const median = known ? percentile(hs, 50) : null;
  const rel = (pct) => (known && pct > 0 ? percentile(hs, pct) : 0);
  const ceilGwei = Number(p.ceilGwei) || 0;
  const followed = rel(p.followPct);
  const ceil = ceilGwei > 0 ? Math.max(ceilGwei, followed) : Infinity;
  return {
    known, median, ceil,
    basis: ceilGwei > 0 && followed > ceilGwei ? 'the last day' : 'ceiling',
    cheap: Math.max(Number(p.cheapGwei) || 0, rel(p.cheapPct)),
    spike: Math.max(Number(p.spikeGwei) || 0, known ? (Number(p.spikeMult) || 0) * median : 0),
  };
}

// The header feeder's decision for the headers now pending.
//   params  { ceilGwei, followPct, cheapGwei, cheapPct, minBatch, minCheap, maxWaitMin, staleBlocks, spikeGwei, spikeMult }
// → { cheap, minBatch, dear, force, aged, stale, waitBlocks, bars }
//   minBatch  how many pending before a batch goes (the small one while gas is cheap)
//   dear      the price is over the bar: hold
//   force     send now whatever the bar says: the oldest header has waited its bound (and the price is no spike), or the relay is at the
//             last resort. A Bitcoin block is ten minutes, so the oldest pending header's age is its count x 10 minutes.
export function headerPace({ price, pending, history, params: p }) {
  const bars = paceBars(history, p);
  const cheap = price < bars.cheap;
  const minBatch = Math.max(1, cheap ? Math.min(p.minBatch, p.minCheap) : p.minBatch);
  const dear = price > bars.ceil;
  const waitBlocks = p.maxWaitMin > 0 ? Math.ceil(p.maxWaitMin / 10) : 0;
  const stale = p.staleBlocks > 0 && pending >= p.staleBlocks;
  const aged = waitBlocks > 0 && pending >= waitBlocks && price <= bars.spike;
  return { cheap, minBatch, dear, force: aged || stale, aged, stale, waitBlocks, bars };
}

// The base fee of the block after `blk` (what a transaction sent now pays), by the same rule eth_feeHistory applies: it moves by up to
// an eighth toward the block's fullness. Bigint in, bigint out; null when the block does not carry the figures.
export function nextBaseFee(blk) {
  if (!blk || blk.baseFeePerGas == null || blk.gasUsed == null || !blk.gasLimit) return null;
  const base = BigInt(blk.baseFeePerGas), used = BigInt(blk.gasUsed), target = BigInt(blk.gasLimit) / 2n;
  if (target === 0n || used === target) return base;
  if (used > target) { const d = (base * (used - target)) / target / 8n; return base + (d > 0n ? d : 1n); }
  return base - (base * (target - used)) / target / 8n;
}

const g = (v) => (Number(v) >= 100 ? Number(v).toFixed(0) : Number(v) >= 1 ? Number(v).toFixed(2) : Number(v).toFixed(3));
const mins = (m) => (m >= 120 ? `${Math.round(m / 60)} h` : `${Math.max(1, Math.round(m))} min`);

// The line the feeder logs while it holds for gas: what it waits for and the latest it goes.
export function headerHoldText({ price, pending, pace, params: p }) {
  const { bars } = pace;
  const bar = `the ${g(bars.ceil)} gwei bar (${bars.basis === 'ceiling' ? 'HEADER_MAX_GAS_GWEI' : `the ${p.followPct}th percentile of the last day`})`;
  const n = `${pending} header${pending === 1 ? '' : 's'}`;
  if (pace.waitBlocks > 0 && pending >= pace.waitBlocks) {
    return `gas ${g(price)} gwei is over ${bar} and over the ${g(bars.spike)} gwei spike line, so the ${n} that have waited ${mins(pending * 10)} keep holding — they go when gas falls under the spike line${p.staleBlocks > 0 ? `, or at ${p.staleBlocks} headers` : ''}`;
  }
  const left = pace.waitBlocks > 0 ? ` and go within ${mins((pace.waitBlocks - pending) * 10)} at the latest (the ${mins(p.maxWaitMin)} bound)` : '';
  return `gas ${g(price)} gwei is over ${bar} — holding ${n} for a cheaper block${left}`;
}

// The attest's decision for the blocks now matured and not yet attested.
//   params  { minBlocks, waitMin, cheapGwei, cheapPct, spikeGwei, spikeMult }
//   matured how many blocks the relay's tip has matured past the attested height; ageMin how long the oldest has been waiting
// → { go, reason }
// An attest costs the same gas whatever number of blocks it covers (and a proof request its base fee), so while gas is dear a few
// blocks wait for company, for at most waitMin; while it is cheap they go as they come, as before. An absolute spike guard
// (MAX_GAS_GWEI) is the folder's own and is read separately.
export function attestPace({ price, matured, ageMin, history, params: p }) {
  const m = Math.floor(Number(matured)) || 0;
  if (m < 1) return { go: false, reason: 'no block has matured yet' };
  if (!(p.minBlocks > 1) || !(p.waitMin > 0)) return { go: true, reason: 'batching is off' };
  const bars = paceBars(history, p);
  if (price < bars.cheap) return { go: true, reason: `gas ${g(price)} gwei is cheap` };
  if (m >= p.minBlocks) return { go: true, reason: `${m} blocks have matured` };
  if (Number(ageMin) >= p.waitMin) return { go: true, reason: `the oldest has waited ${mins(ageMin)}` };
  const left = Math.max(1, Math.ceil(p.waitMin - (Number(ageMin) || 0)));
  return { go: false, reason: `${m} of ${p.minBlocks} blocks matured with gas at ${g(price)} gwei (cheap is under ${g(bars.cheap)}) — attesting at ${p.minBlocks} blocks, or cheap gas, or in ${mins(left)} at the latest` };
}

// Whether to ask for an attest job now, from where the relay and the attested cursor stand. Pure; the folder reads the chain and
// the API and keeps `since` (when the oldest matured block was first seen, ms) and `probedAt` between calls.
//   relayTip / attested / confirmations   the relay's tip, the API's attested height, the pool's maturity depth
//   price, history, params                as attestPace
// → null when there is nothing to go on (the folder proceeds as before), else
//   { go, matured, since, probedAt, key?, text?, beat?, why? }   `since`/`probedAt` are the state to keep
// With nothing matured no job is built (the relay is behind), except one probe every `probeEveryMs` so the folder's drift and
// lost-ack checks, which live behind the job, still run.
export function attestGate({ relayTip, attested, confirmations, price, history, now, since = null, probedAt = 0, probeEveryMs = 10 * 60_000, params }) {
  if (attested == null || !(Number(relayTip) > 0) || !Number.isFinite(Number(attested))) return null;
  const matured = Number(relayTip) - Number(confirmations) - Number(attested);
  if (matured < 1) {
    if (now - probedAt >= probeEveryMs) return { go: true, probe: true, matured, since: null, probedAt: now };
    const need = Number(attested) + 1 + Number(confirmations);
    return { go: false, matured, since: null, probedAt, key: 'relay', text: `no block has matured past the attested ${attested}: the relay's tip is ${relayTip} and the next batch needs ${need} — waiting for the header feeder`, beat: `waiting for relay tip ${need} (now ${relayTip})` };
  }
  const first = since ?? now;
  if (!Number.isFinite(price)) return { go: true, matured, since: first, probedAt };
  const pace = attestPace({ price, matured, ageMin: (now - first) / 60_000, history, params });
  if (pace.go) return { go: true, matured, since: first, probedAt, why: pace.reason };
  return { go: false, matured, since: first, probedAt, key: 'dear', text: pace.reason, beat: `holding ${matured} matured block(s) for company while gas is dear` };
}
