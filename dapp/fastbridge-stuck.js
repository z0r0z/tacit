// Pricing and policy for TAC that cannot go home. A fast bridge provider lends private TAC on Ethereum and takes TAC on Bitcoin in
// return, and carries the Bitcoin TAC home over the regular bridge to lend again. Two kinds of note cannot make that trip: one whose
// history the burn proof does not follow (it came out of the Bitcoin shielded pool, opcode 0x6d, or through a pool or farm trade), and
// one with more transfers behind it than the proof folds (255). A provider that takes such a note at its ordinary fee is left holding
// Bitcoin TAC worth less than the TAC it lent, and its Ethereum-side capacity shrinks by that much with every such bridge.
//
// This file is the rule a provider prices that by. Notes are classed by the same verdicts the bridge's own trace gives (burndep-ux.js
// lineage, read through `vet` as in fast/wire.js): clean (tracked or traced), long (a history past the fold), pool (a history the proof
// does not follow). A stuck class is taken only at a fee whose premium over the ordinary fee covers the class's expected haircut — the
// share of its face the provider expects to lose when the note is sold on Bitcoin, where stuck TAC can still be traded — plus a margin,
// and only while the provider's stuck holdings stay under a stated share of what it holds on Bitcoin. Every number is the provider's
// own policy, read from its own config; nothing here reaches the network. No imports, so a page, a test and the daemon's image take it
// alike (as fastbridge-price.js, whose fee sum this stands beside).

// The classes, worst last. A lock is priced by the worst note in it: one stuck note strands its share of the take either way, and a
// provider that priced the lock as clean would carry that share unpriced.
export const STUCK_CLASSES = ['clean', 'long', 'pool'];
const RANK = { clean: 0, long: 1, pool: 2 };

// A verdict's class. A verdict that could not be read ('unread', or none) has no class: what cannot be read cannot be priced, and a
// lock built on a guess costs the same as one built on a reading.
export function classOfState(state) {
  if (state === 'tracked' || state === 'traced') return 'clean';
  if (state === 'long') return 'long';
  if (state === 'unprovable') return 'pool';
  return null;
}

// The class of a whole lock from its notes' verdict states: the worst class present, or null when any note's verdict is missing or
// unread.
export function lockClass(states) {
  let worst = 'clean';
  for (const s of states) {
    const c = classOfState(s);
    if (c === null) return null;
    if (RANK[c] > RANK[worst]) worst = c;
  }
  return worst;
}

// The defaults a provider starts from, before it has its own numbers. The haircuts are assumptions, stated so they can be argued with:
// long TAC is ordinary TAC on Bitcoin with a long past — it trades, at a discount for the smaller set of takers, put at 5 in 100; pool
// TAC can never be followed, even by a proof that folds further, and its takers are fewer, put at 10 in 100. The margin over the
// haircut is 2 in 100, and stuck TAC is never let past a fifth of what the provider holds on Bitcoin. A provider that has watched its
// own sales puts its own haircuts here; the rule only asks that the fee cover them.
export const DEFAULT_STUCK_POLICY = {
  haircutBps: { long: 500, pool: 1000 },
  marginBps: 200,
  maxStuckBps: 2000,
  take: { long: true, pool: true },
};

function policyOf(policy) {
  const p = policy || {};
  return {
    haircutBps: { ...DEFAULT_STUCK_POLICY.haircutBps, ...(p.haircutBps || {}) },
    marginBps: p.marginBps ?? DEFAULT_STUCK_POLICY.marginBps,
    maxStuckBps: p.maxStuckBps ?? DEFAULT_STUCK_POLICY.maxStuckBps,
    take: { ...DEFAULT_STUCK_POLICY.take, ...(p.take || {}) },
  };
}

// The premium a class adds to the ordinary fee, in basis points of the amount: its expected haircut plus the margin. Clean adds none.
export function premiumBps(cls, policy) {
  if (cls === 'clean') return 0;
  const p = policyOf(policy);
  return p.haircutBps[cls] + p.marginBps;
}

// What a provider advertises of this rule in its terms, as an optional field beside { feeBps, flatFee }: the premium each stuck class
// adds. A reader that does not know the field leaves it out, and a provider that names none is read as naming the defaults' premiums
// only by a reader that prices stuck TAC at all — the field states the provider's prices, it does not change what an old quote meant.
export function advertisedStuckFees(policy) {
  return { long: premiumBps('long', policy), pool: premiumBps('pool', policy) };
}

// The premium on an amount, in base units, rounded down like the fee itself: the least the provider must keep over its ordinary fee for
// taking this amount of this class to expect to be whole.
export function premiumFor(amount, cls, policy) {
  return (BigInt(amount) * BigInt(premiumBps(cls, policy))) / 10000n;
}

// What the provider keeps of an amount whose lock is of this class: the ordinary fee (fastbridge-price.js `feeOf`: a rate on the
// amount, rounded down, and a flat part) plus the class's premium. For clean this is the ordinary fee, unchanged.
export function feeOfClass(terms, amount, cls, policy) {
  const base = (BigInt(amount) * BigInt(terms.feeBps ?? 0)) / 10000n + BigInt(terms.flatFee ?? 0);
  return base + premiumFor(amount, cls, policy);
}

// Whether a fee kept on an amount of this class covers the class's expected haircut: the part of the fee over the ordinary fee is at
// least the haircut's share of the amount. The margin is what the premium adds beyond this line.
export function coversHaircut(terms, amount, cls, policy) {
  if (cls === 'clean') return true;
  const p = policyOf(policy);
  const haircut = (BigInt(amount) * BigInt(p.haircutBps[cls])) / 10000n;
  return feeOfClass(terms, amount, cls, policy) - feeOfClass(terms, amount, 'clean', policy) >= haircut;
}

// The rule in one place, for a lock whose notes' verdicts are in hand. `held` is what the provider holds on Bitcoin before this lock:
// { stuck, total } in base units, the stuck part counted at face. Answers { ok, cls, fee } for a take, or { ok: false, why, retry }
// against it, in the shape a refusal is already given in. A take is refused when a note could not be read (retry: the reading may
// succeed later), when the provider does not take the lock's class at any price, or when taking it would put the provider's stuck
// holdings past its stated share — a provider close to its limit keeps lending clean TAC and turns stuck TAC away, rather than
// discovering the limit from the far side.
export function judgeStuck({ states, amount, terms, policy, held }) {
  const p = policyOf(policy);
  const cls = lockClass(states);
  if (cls === null) return { ok: false, retry: true, why: 'the history of a note could not be read just now' };
  if (cls !== 'clean' && !p.take[cls]) return { ok: false, why: `this provider does not take TAC with ${cls === 'pool' ? 'a history the bridge\u2019s proof does not follow' : 'a history longer than the bridge\u2019s proof folds'}` };
  if (cls !== 'clean' && held) {
    const stuckAfter = BigInt(held.stuck) + BigInt(amount), totalAfter = BigInt(held.total) + BigInt(amount);
    if (stuckAfter * 10000n > totalAfter * BigInt(p.maxStuckBps)) return { ok: false, why: 'taking this would put more of this provider\u2019s Bitcoin TAC in notes that cannot go home than its limit' };
  }
  return { ok: true, cls, fee: feeOfClass(terms, amount, cls, p) };
}

// The rule as a provider machine's `policy.screen` (fastbridge-el.js), built from a `vet` as `lineageScreen` in fast/wire.js is: null
// to go on, { why, retry } to refuse the lock. Where lineageScreen refuses every note the proof cannot follow, this screen refuses by
// the provider's policy instead — a class it does not take, and (when `held` is given, a function of the lock's inputs answering
// { stuck, total, amount } in base units) a take past its stuck limit. The fee itself is charged at the quote, from the same numbers:
// the page reads a lock's notes before it builds the lock, and the provider's terms carry the premiums (advertisedStuckFees), so the
// take a lock pays is the fee of its worst class. A provider that names no policy gets the defaults.
export function stuckScreen(vet, { policy, held } = {}) {
  return async (inputs) => {
    const verdicts = await vet(inputs);
    const at = (n) => verdicts.get(`${n.txid}:${n.vout}`);
    const states = inputs.map((n) => at(n)?.state);
    const h = held ? await held(inputs) : null;
    const j = judgeStuck({ states, amount: h?.amount ?? 0, terms: { feeBps: 0, flatFee: 0 }, policy, held: h });
    if (j.ok) return null;
    return j.retry ? { why: j.why, retry: true } : { why: j.why };
  };
}
