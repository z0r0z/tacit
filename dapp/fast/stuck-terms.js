// Pricing and policy for TAC the regular bridge cannot carry home (docs/STUCK-TAC-BOUNTY.md, option C).
//
// A fast bridge provider lends private TAC on Ethereum and takes TAC on Bitcoin in return, and carries what it took home over
// the regular bridge to lend again. Two kinds of Bitcoin TAC cannot make that trip: TAC that left Bitcoin's shielded pool (a
// pool exit; the burn proof does not follow a history through the pool) and TAC with more transfers behind it than the proof
// walks. A provider that takes such a note at its ordinary fee holds value it cannot lend again: its capacity drains by the
// note's whole amount, whatever the fee was. Before this file a provider had two choices, both blunt: take any TAC the
// validator accepts (`anyTac`, no screen at all) and eat that loss whole, or screen with lineageScreen (fast/wire.js) and
// refuse every note the proof does not follow, at any price.
//
// This file is the priced middle: a provider takes a stuck class only at a fee that covers its expected haircut for that
// class, and says so in its terms. The classes are the ones the lineage vet (dapp/burndep-ux.js) already tells apart:
//
//   clean       a verdict of 'tracked' or 'traced': the proof follows the note's history, so it bridges home like any TAC.
//   long        a verdict of 'long': more transfers behind the note than the source walk allows (the proof's bound is 256),
//               so it cannot go home either, though nothing but its length is wrong with it.
//   pool-exit   a verdict of 'unprovable' whose history the trace lost through a shielded-pool leaf (opcode 0x6c or 0x6d):
//               the brief's pool exit.
//   unprovable  a verdict of 'unprovable' through anything else (a pool or farm trade, a cross-out mint, another construct
//               the trace does not follow). Just as unbridgeable, less well understood, and not taken unless a provider
//               prices it on purpose.
//
// A verdict the vet could not reach ('unread', or none) is no class at all: as in lineageScreen, a lock built on a guess
// costs the same as a lock built on knowledge, so the screen asks for a retry instead of deciding.
//
// The fee binds where fees bind in this system: at the quote. A quote's amounts are sealed and a lock is answered only at
// the quote's amounts (dapp/fastbridge-el.js), so no screen can reprice a lock after the fact. What happens instead: the
// client, which vets its own notes before it builds a lock (followed, fast/wire.js), names the worst class it will spend in
// its quote request (an optional `cls` field an old provider ignores); the provider's quoter prices that quote at the
// class's fee and keeps the class on the quote; and pricedScreen, the provider machine's `policy.screen`, checks the lock
// it is shown against the class its quote was priced at. A lock that spends worse TAC than its quote paid for is refused
// with the reason, and the client asks again at the right class. A provider with no stuck terms is untouched by all of it:
// its quoter prices as it always did and pricedScreen with no terms decides exactly as lineageScreen does.
//
// The haircut a class's fee must cover is an expectation, stated in the provider's own config so the floor it sells at is
// one it can read (the brief, section 3): of the notes of a class the provider takes, a share `neverBps` (of 10,000) never
// becomes lendable again and loses everything but `recoveryBps` of its value; the rest is unstuck at a cost of `costBps`
// of its value plus a flat `flatCost` (the desk's published price, btcswap-desk: 30 bps and a flat 1 TAC, is the default
// calibration). The fee a class is taken at is the provider's standing fee plus an uplift of at least the haircut, and the
// flat part of the expected cost; by construction the uplift a taker pays is the expected haircut, no more and no less.
// The defaults below are assumptions, not measurements: they are conservative (a tenth of long-history notes and a fifth
// of pool exits written off whole) and every provider sets its own. Nothing here holds anyone's funds, moves a deployed
// contract, or adds a dependency; amounts are BigInt base units throughout (1 TAC = 10^8).

// The classes a lock can be priced under, best first: the order is the fee order, so a lock is worse than its quote when
// its worst class stands later here than the class the quote named.
export const STUCK_CLASSES = ['clean', 'long', 'pool-exit', 'unprovable'];
const ORDER = { clean: 0, long: 1, 'pool-exit': 2, unprovable: 3 };

// The refusal words of lineageScreen, kept: with no stuck terms the priced screen is the lineage screen, word for word.
const UNPROVABLE_WHY = 'a note this lock spends has a history the bridge\'s proof does not follow, which this provider does not take';
const UNREAD_WHY = 'the history of a note could not be read just now';

// The class of one lineage verdict (dapp/burndep-ux.js): 'clean', 'long', 'pool-exit', 'unprovable', or 'unread' when the
// vet has no verdict or one that could not be read. An unrecognised state is 'unread': not taken on a guess.
export function classOf(v) {
  if (!v || typeof v.state !== 'string') return 'unread';
  switch (v.state) {
    case 'tracked': case 'traced': return 'clean';
    case 'long': return 'long';
    case 'unprovable': return v.through === 'shielded' ? 'pool-exit' : 'unprovable';
    default: return 'unread';
  }
}

// The worst of a lock's classes, in fee order; 'unread' is not a class and is not weighed here (the screen retries on it
// separately, after the classes it refuses, as lineageScreen does). An empty lock weighs 'clean'.
export function worstClass(classes) {
  let worst = 'clean';
  for (const c of classes) if (c !== 'unread' && ORDER[c] > ORDER[worst]) worst = c;
  return worst;
}

// The haircut parameters of a class: the config's over the defaults. The defaults are the assumptions named in the header:
// the unstuck cost is the desk's published 30 bps plus a flat 1 TAC a note; a long-history note is written off whole a
// tenth of the time, a pool exit a fifth, an unprovable note of any other kind half; nothing is recovered of one that
// never unsticks (it is still TAC on Bitcoin, but as lendable capacity it is gone).
const CLASS_DEFAULTS = {
  clean: { neverBps: 0, costBps: 0, flatCost: 0n, recoveryBps: 10000 },
  long: { neverBps: 1000, costBps: 30, flatCost: 100_000_000n, recoveryBps: 0 },
  'pool-exit': { neverBps: 2000, costBps: 30, flatCost: 100_000_000n, recoveryBps: 0 },
  unprovable: { neverBps: 5000, costBps: 30, flatCost: 100_000_000n, recoveryBps: 0 },
};
const classParams = (cls, cfg) => ({ ...CLASS_DEFAULTS[cls], ...((cfg && cfg.classes && cfg.classes[cls]) || {}) });

// The expected haircut of taking one note of a class, in basis points of its value, rounded up: the share that never
// unsticks loses what is not recovered, and the share that does pays the proportional unstuck cost. 'clean' has none.
export function haircutBps(cls, cfg) {
  if (cls === 'clean') return 0;
  const p = classParams(cls, cfg);
  const num = BigInt(p.neverBps) * BigInt(10000 - p.recoveryBps) + BigInt(10000 - p.neverBps) * BigInt(p.costBps);
  return Number((num + 9999n) / 10000n);
}

// The expected flat unstuck cost of one note of a class, in base units, rounded up: the flat cost, paid by the share of
// notes that do unstick.
export function expectedFlat(cls, cfg) {
  if (cls === 'clean') return 0n;
  const p = classParams(cls, cfg);
  return (BigInt(10000 - p.neverBps) * BigInt(p.flatCost) + 9999n) / 10000n;
}

// Whether the provider takes a class at all under these terms. With no stuck terms at all (cfg null, or no classes in
// it) the standing behaviour stands: 'long' is taken at the ordinary fee, as the lineage screen passes it today, and the
// unprovable classes are not taken. With stuck terms, a class is taken when its entry says so; the defaults once a
// provider has written terms are that 'long' and 'pool-exit' are taken priced, and 'unprovable' is not.
export function takesClass(cls, cfg) {
  if (cls === 'clean') return true;
  const terms = cfg && cfg.classes;
  if (!terms) return cls === 'long';
  const t = terms[cls];
  if (t && typeof t.take === 'boolean') return t.take;
  return cls === 'long' || cls === 'pool-exit';
}

// The terms a class is taken at: the provider's standing fee (cfg.base, the quote's own feeBps and flatFee; the defaults
// are PROVIDER_DEFAULTS in dapp/fast/discover.js) plus, for a stuck class, an uplift of at least its expected haircut and
// the expected flat unstuck cost. A config may set a higher upliftBps for a class; a lower one is raised to the haircut,
// so the fee a class is taken at never falls below the floor the provider's own numbers give.
export function classTerms(cls, cfg) {
  const base = { feeBps: Number((cfg && cfg.base && cfg.base.feeBps) ?? 30), flatFee: BigInt((cfg && cfg.base && cfg.base.flatFee) ?? 10_000_000n) };
  if (cls === 'clean') return { feeBps: base.feeBps, flatFee: base.flatFee };
  const t = (cfg && cfg.classes && cfg.classes[cls]) || {};
  const uplift = Math.max(Number(t.upliftBps ?? 0), haircutBps(cls, cfg));
  return { feeBps: base.feeBps + uplift, flatFee: base.flatFee + expectedFlat(cls, cfg) };
}

// The fee a quote of `amount` at a class's terms carries, in base units, in the quoter's own shape (the proportional part
// rounded down, as dapp/fastbridge-provider.js prices it, plus the flat part).
export function classFee(amount, cls, cfg) {
  const t = classTerms(cls, cfg);
  return (BigInt(amount) * BigInt(t.feeBps)) / 10000n + t.flatFee;
}

// The smallest amount a class can be quoted at all: the smallest whose fee is less than the amount itself, so the swap
// can pay its fee and still deliver something. (A desk that set its minimum under its own fee could never quote at its
// minimum; a class whose terms cannot pay their fee at an amount is not quoted at that amount.) 0 for 'clean', whose fee
// is the standing one and is bounded by the provider's own minimum as it always was.
export function minAmountFor(cls, cfg) {
  if (cls === 'clean') return 0n;
  const t = classTerms(cls, cfg);
  if (t.feeBps >= 10000) return null;                     // a fee of the whole amount or more pays at no amount
  // fee(a) < a  <=>  floor(a*feeBps/10000) + flatFee < a; the crossing is within a few units of flatFee/(1 - feeBps/10000)
  let a = (t.flatFee * 10000n) / BigInt(10000 - t.feeBps);
  const fee = (x) => (x * BigInt(t.feeBps)) / 10000n + t.flatFee;
  while (fee(a) >= a) a += 1n;
  while (a > 0n && fee(a - 1n) < a - 1n) a -= 1n;
  return a;
}

// Whether taking `addStuck` more of stuck TAC (on a lock of `addTotal`) keeps the stuck share of what a provider holds
// at or under cfg.maxStuckShareBps (of 10,000; 2000 unless set): a pure predicate over the held totals, for a host that
// tracks what it holds by class. The priced screen uses it when its cfg carries `held`, a function returning
// { stuck, total } in base units; a host that does not track held-by-class leaves it out and the cap is not the screen's.
export function stuckShareOk(heldStuck, heldTotal, addStuck, addTotal, cfg) {
  const cap = BigInt((cfg && cfg.maxStuckShareBps) ?? 2000);
  const stuck = BigInt(heldStuck) + BigInt(addStuck), total = BigInt(heldTotal) + BigInt(addTotal);
  if (total <= 0n) return true;
  return stuck * 10000n <= cap * total;
}

// The priced screen: a drop-in sibling of lineageScreen (dapp/fast/wire.js), the provider machine's `policy.screen`.
// `vet(notes)` is as for lineageScreen; the screen it returns is called with the lock's note inputs and, when the caller
// passes it, the quote the lock was made under (dapp/fastbridge-el.js passes it; a caller that does not leaves the class
// of the quote at 'clean', the only class an unpriced quote can carry). It resolves to { why, retry } to refuse the lock,
// null to go on, in lineageScreen's shapes and, with no stuck terms, its very words and decisions.
//
// With stuck terms, in order: a lock whose worst class the provider does not take is refused, naming the class; a lock
// whose history could not be read retries, as today; a lock that spends a worse class than its quote was priced at is
// refused, naming both, so the client asks again at that class's fee; a lock that would take the provider's held stuck
// share past its cap (when cfg.held is given) is refused; the rest go on.
export function pricedScreen(vet, cfg) {
  const terms = (cfg && cfg.classes) || null;
  return async (inputs, quote) => {
    const verdicts = await vet(inputs);
    const classes = inputs.map((n) => classOf(verdicts.get(`${n.txid}:${n.vout}`)));
    const worst = worstClass(classes);
    if (!takesClass(worst, cfg)) {
      if (!terms && worst !== 'long') return { why: UNPROVABLE_WHY };
      return { why: `a note this lock spends is ${worst === 'pool-exit' ? 'TAC that left the shielded pool' : worst === 'long' ? 'TAC with more transfers behind it than the bridge\'s proof follows' : 'TAC whose history the bridge\'s proof does not follow'}, which this provider does not take` };
    }
    if (classes.includes('unread')) return { why: UNREAD_WHY, retry: true };
    if (terms && worst !== 'clean') {
      const priced = quote && typeof quote.cls === 'string' && STUCK_CLASSES.includes(quote.cls) ? quote.cls : 'clean';
      if (ORDER[worst] > ORDER[priced]) return { why: `this lock spends ${worst} TAC, which this provider takes at its ${worst} fee; the quote it was made under was priced as ${priced}: ask for a quote at the ${worst} fee` };
      if (cfg && typeof cfg.held === 'function' && quote && quote.btcValue != null) {
        const h = await cfg.held();
        if (h && !stuckShareOk(h.stuck, h.total, BigInt(quote.btcValue), BigInt(quote.btcValue), cfg)) return { why: 'this lock would take the share of stuck TAC this provider holds past the limit in its own terms' };
      }
    }
    return null;
  };
}

// The schedule a provider advertises (its /info answer and its ad, as new optional fields an old page ignores): the fee
// and the least amount of each class, beside the standing terms. Amounts are decimal strings, as the wire carries them.
export function stuckSchedule(cfg, base) {
  const c = { ...(cfg || {}), base: base || (cfg && cfg.base) };
  const out = {};
  for (const cls of STUCK_CLASSES) {
    if (cls === 'clean') continue;
    const t = classTerms(cls, c), min = minAmountFor(cls, c);
    out[cls] = { take: takesClass(cls, c), feeBps: t.feeBps, flatFee: String(t.flatFee), minAmount: min == null ? null : String(min) };
  }
  return out;
}
