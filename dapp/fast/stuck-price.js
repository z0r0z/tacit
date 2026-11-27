// Stuck TAC pricing rule (docs/STUCK-TAC-BOUNTY.md, entry C).
//
// A provider that takes any TAC (`anyTac`) ends up holding Bitcoin TAC the regular bridge cannot carry home: a note whose history the
// bridge's proof does not follow (a pool exit, verdict 'unprovable') or one with too long a history (verdict 'long'). This rule lets such a
// provider take those notes only at a fee that covers the haircut it expects on them, by class, and only up to a cap on what it holds.
//
// It is a `policy.screen` like `lineageScreen` (wire.js), so it plugs in where that one does and needs no change to quotes, ads or pages:
//   screen(inputs, ctx) -> null to go on, or { why, retry } to refuse the lock.
// `ctx` is { value, amount } of the offer in base units (the TAC locked on Bitcoin and the TAC paid on Ethereum); a caller that passes no ctx
// gets the plain lineage screen's answer for anything not clean (refuse), so the rule is never looser than the screen it replaces.
//
// Classes, from the lineage verdicts (burndep-ux.js `lineage`):
//   clean     'tracked' or 'traced'            the regular bridge carries it home
//   long      'long'                           history over the proof's bound
//   poolExit  'unprovable'                     a history the proof does not follow (a pool exit and the like)
//   unread    no verdict or 'unread'           not known now: refused with retry, as lineageScreen does
// A lock is priced by its worst input: the whole value carries the haircut of its worst note, which is safe when notes are mixed.

const CLASS_OF = { tracked: 'clean', traced: 'clean', long: 'long', unprovable: 'poolExit' };
const RANK = { clean: 0, long: 1, poolExit: 2 };
const BPS = 10_000n;

export function classOf(verdict) {
  if (!verdict || verdict.state === 'unread') return 'unread';
  return CLASS_OF[verdict.state] || 'unread';
}

// The worst class among the verdicts of a lock's inputs ('unread' wins over all: nothing is priced on a guess).
export function worstClass(inputs, verdicts) {
  let worst = 'clean';
  for (const n of inputs) {
    const c = classOf(verdicts.get(`${n.txid}:${n.vout}`));
    if (c === 'unread') return 'unread';
    if (RANK[c] > RANK[worst]) worst = c;
  }
  return worst;
}

// Checks and normalizes the rule's config. Every limit is the provider's own and readable in its config; a class with no haircut set is not taken.
//   baseFeeBps   the provider's ordinary fee (its quote's feeBps); the class surcharge is on top of it
//   haircutBps   { long, poolExit }: the surcharge in basis points for each class; omitted or null = refuse that class
//   maxStuck     the most stuck TAC (base units) the provider will hold; a lock that would pass it is refused
export function makeRule({ baseFeeBps = 0, haircutBps = {}, maxStuck = 0 } = {}) {
  const int = (x, name) => { const n = Number(x); if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error(`stuck-price: ${name} must be whole basis points 0..10000`); return n; };
  const hc = {};
  for (const k of ['long', 'poolExit']) if (haircutBps[k] != null) hc[k] = int(haircutBps[k], `haircutBps.${k}`);
  const cap = BigInt(maxStuck);
  if (cap < 0n) throw new Error('stuck-price: maxStuck must not be negative');
  return Object.freeze({ baseFeeBps: int(baseFeeBps, 'baseFeeBps'), haircutBps: Object.freeze(hc), maxStuck: cap });
}

// The fee a lock of `value` in `cls` must pay, in base units (rounded up, so a provider is never short by a unit), or null when the class is not taken.
export function requiredFee(rule, cls, value) {
  if (cls === 'clean') return (BigInt(value) * BigInt(rule.baseFeeBps) + BPS - 1n) / BPS;
  const h = rule.haircutBps[cls];
  if (h == null) return null;
  return (BigInt(value) * BigInt(rule.baseFeeBps + h) + BPS - 1n) / BPS;
}

// The screen. `vet` is as for `lineageScreen`. `stuckHeld()` resolves to the stuck TAC the provider holds now (base units); with none given the cap
// counts only what this screen has let through since it was made (kept in memory), which is the safe side after a restart only if the provider
// passes its real holding, so a daemon should pass it.
export function stuckPriceScreen(vet, ruleIn, { stuckHeld = null } = {}) {
  const rule = ruleIn && Object.isFrozen(ruleIn) ? ruleIn : makeRule(ruleIn);
  let letThrough = 0n;
  return async (inputs, ctx = null) => {
    const verdicts = await vet(inputs);
    const cls = worstClass(inputs, verdicts);
    if (cls === 'unread') return { why: 'the history of a note could not be read just now', retry: true };
    if (cls === 'clean') return null;
    if (!ctx || ctx.value == null || ctx.amount == null) return { why: 'a note this lock spends cannot go home over the regular bridge, and no price was given to weigh it against' };
    const value = BigInt(ctx.value), amount = BigInt(ctx.amount);
    const need = requiredFee(rule, cls, value);
    if (need == null) return { why: `this provider does not take ${cls === 'long' ? 'TAC with a history over the bridge\'s bound' : 'TAC that left the shielded pool'}` };
    const fee = value - amount;
    if (fee < need) return { why: `TAC of this kind (${cls}) is taken at a fee of at least ${rule.baseFeeBps + rule.haircutBps[cls]} bps; this lock pays ${fee * BPS / (value || 1n)} bps` };
    const held = stuckHeld ? BigInt(await stuckHeld()) : letThrough;
    if (held + value > rule.maxStuck) return { why: 'this provider holds as much TAC that cannot go home as it takes for now', retry: true };
    if (!stuckHeld) letThrough += value;
    return null;
  };
}

// What a provider holds after `n` bridges with and without the rule, for the write-up: a plain model, not a forecast.
//   share       fraction of bridged value that is stuck (0.05 = the 2026-11-22 count)
//   size        TAC per bridge; fee: base fee bps; haircut: what stuck TAC fetches below par when sold (bps)
export function model({ n, size, share, baseFeeBps, haircutBps, surchargeBps, maxStuck = Infinity }) {
  const out = { without: { stuck: 0, pnl: 0 }, with: { stuck: 0, pnl: 0, refused: 0 } };
  for (let i = 0; i < n; i++) {
    const stuck = Math.floor((i + 1) * share) > Math.floor(i * share); // spreads the stuck ones evenly
    const fee = size * baseFeeBps / 1e4;
    out.without.pnl += fee;
    if (stuck) { out.without.stuck += size; out.without.pnl -= size * haircutBps / 1e4; }
    if (!stuck) out.with.pnl += fee;
    else if (out.with.stuck + size <= maxStuck) { out.with.stuck += size; out.with.pnl += size * (baseFeeBps + surchargeBps - haircutBps) / 1e4; }
    else out.with.refused += size;
  }
  return out;
}
