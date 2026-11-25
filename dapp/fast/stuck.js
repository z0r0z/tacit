// Stuck TAC: what a fast bridge provider charges for the TAC the regular bridge cannot carry home, and why.
//
// A provider lends private TAC on Ethereum and is paid TAC on Bitcoin. It carries the Bitcoin TAC home over the regular bridge to lend it
// again, and the burn's proof can only carry some notes (docs/STUCK-TAC-BOUNTY.md, docs/FAST-BRIDGE.md "Which notes a provider can take"):
// a note whose history the proof follows is `clean`; one with more than 255 transfers behind it is `long` (the proof's walk is bounded and
// splitting inherits the whole history); one the proof does not follow at all is `poolExit` (a shielded-pool exit, a pool or farm trade, TAC
// that came over from Ethereum). The last two stay on Bitcoin, so a provider that takes them holds value it cannot lend again: it can only
// recover the note's Bitcoin-side price, `1 - haircut`, and must charge a fee that covers that haircut. That is the whole rule.
//
// The classes are the ones the code tells apart already: `lineageScreen` (dapp/fast/wire.js) and `policy.screen` (dapp/fastbridge-el.js) read
// a note's verdict from the bridge's own trace (`lineage` in dapp/burndep-ux.js) and this module names it, prices it, and keeps a quote to it.
//
// Four rules that make it safe by default:
//  1. The schedule is the provider's own config, read once at start. A schedule that would take a class it has no haircut for throws, so a
//     provider cannot take stuck TAC at the clean price by forgetting a field.
//  2. A quote is priced for one class and says which (`class`). Nothing a user sends can change the price of a class.
//  3. At offer time the lock's own class is read again from the chain, and a quote priced below the class it would spend is refused. The
//     provider never sells below the floor it read in its config, whatever a page said when it asked.
//  4. A class that is not taken at all is refused as it was before (`take`), and a history that could not be read is a retry, not a guess.
//
// An old page or provider is unchanged: a quote request with no `class` is the clean class, which is the price it was, to the base unit.

// worst last: a lock's class is the worst of the notes it spends
export const CLASSES = ['clean', 'long', 'poolExit'];
export const WORDS = {
  clean: 'TAC the bridge can carry home',
  long: 'TAC with more than 255 transfers behind it',
  poolExit: 'TAC whose history the bridge\'s proof does not follow',
};
export const classRank = (klass) => CLASSES.indexOf(klass);
export const isClass = (klass) => CLASSES.includes(klass);
export const worst = (a, b) => (classRank(a) >= classRank(b) ? a : b);

// The class of one verdict, as `lineage` (dapp/burndep-ux.js) gives it: 'tracked' and 'traced' are followed back to the etch and are clean;
// 'long' is traced but past the proof's bound; 'unprovable' is a history the proof cannot follow (`through` says how: 'shielded', 'pool',
// 'arrived', 'other' — every one of them stuck, and every one of them priced the same). A verdict that is missing or 'unread' has no class
// yet: a provider waits for it rather than guess.
export function classOf(verdict) {
  const s = verdict && verdict.state;
  if (s === 'tracked' || s === 'traced') return 'clean';
  if (s === 'long') return 'long';
  if (s === 'unprovable') return 'poolExit';
  return null;
}

// The class of a lock that spends `notes`: the worst class among them, the note that carries it, and the notes whose history could not be
// read (a class is only known when every note's is). `verdicts` is `lineageScreen`'s map, keyed `txid:vout`.
export function classesOf(verdicts, notes) {
  let klass = 'clean', at = null;
  const unknown = [];
  for (const n of notes || []) {
    const v = verdicts && verdicts.get(`${n.txid}:${n.vout}`);
    const c = classOf(v);
    if (!c) { unknown.push(`${n.txid}:${n.vout}`); continue; }
    if (classRank(c) > classRank(klass)) { klass = c; at = n; }
  }
  return { klass, at, unknown, known: !unknown.length };
}

const intBps = (v) => Number.isInteger(v) && v >= 0 && v < 10000;

// The rule for one provider, from its own config: `quote` is the provider's price as it was ({ feeBps, flatFee }), `stuck` is the optional
// schedule (`{ take: ['clean','long'], haircutBps: { long: 900, poolExit: 2500 }, marginBps: 100 }`). Returns null when the provider has no
// schedule, which is the provider it was: it takes any TAC at its old price, or screens, as its terms say.
export function makeStuck({ quote = {}, stuck = null } = {}) {
  if (stuck == null) return null;
  if (typeof stuck !== 'object' || Array.isArray(stuck)) throw new Error('stuck: the schedule must be an object');
  const take = stuck.take ?? ['clean'];
  if (!Array.isArray(take) || !take.length || take.some((k) => !isClass(k))) throw new Error(`stuck: take must name classes among ${CLASSES.join(', ')}`);
  if (!take.includes('clean')) throw new Error('stuck: a provider that prices stuck TAC still takes clean TAC (take must list \'clean\')');
  const haircutBps = stuck.haircutBps ?? {};
  if (typeof haircutBps !== 'object' || Array.isArray(haircutBps)) throw new Error('stuck: haircutBps must be an object of class -> basis points');
  for (const [k, v] of Object.entries(haircutBps)) if (!isClass(k) || !Number.isInteger(v) || !intBps(v)) throw new Error(`stuck: haircutBps.${k} must be whole basis points under 10000`);
  const marginBps = stuck.marginBps ?? 0;
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10000) throw new Error('stuck: marginBps must be whole basis points under 10000');
  // a class it takes must carry a haircut the provider chose: no field forgotten, no stuck TAC at the clean price
  for (const k of take) if (k !== 'clean' && haircutBps[k] == null) throw new Error(`stuck: taking ${k} needs haircutBps.${k} (what the provider expects to lose on it)`);
  const baseBps = Number(quote.feeBps ?? 0), flat = BigInt(quote.flatFee ?? 0);
  if (!Number.isInteger(baseBps) || baseBps < 0 || baseBps >= 10000) throw new Error('stuck: the quote\'s feeBps must be whole basis points under 10000');
  const bpsOf = (klass) => (klass === 'clean' ? baseBps : baseBps + haircutBps[klass] + marginBps);
  for (const k of CLASSES) if (bpsOf(k) >= 10000) throw new Error(`stuck: ${k} priced at ${bpsOf(k)} bps leaves the holder nothing`);

  const takes = (klass) => isClass(klass) && take.includes(klass);
  const feeBpsFor = (klass) => { if (!isClass(klass)) throw new Error(`stuck: no such class ${klass}`); return bpsOf(klass); };
  // The fee for `amount` at `klass`. The clean price is the price it was, floored to the base unit as makeQuoter floors it, so a quote with
  // no class is unchanged; a stuck price is rounded up, since it is a floor the provider will not go under.
  function feeFor(amount, klass = 'clean') {
    if (!takes(klass)) throw Object.assign(new Error(`this provider does not take ${WORDS[klass] || klass}`), { status: 400 });
    const a = BigInt(amount), bps = BigInt(feeBpsFor(klass));
    const fee = (klass === 'clean' ? (a * bps) / 10000n : (a * bps + 9999n) / 10000n) + flat;
    if (a <= fee) throw Object.assign(new Error(`the amount does not cover the fee for ${WORDS[klass]}`), { status: 400 });
    return fee;
  }
  // a quote priced for `quoted` pays for a lock of class `actual` only when it was priced for one at least as bad
  const covers = (quoted, actual) => isClass(actual) && classRank(actual) <= classRank(quoted);
  // what the provider says of itself, so a page can price a lock before it asks: the classes it takes and what each one costs over its base
  const terms = () => ({ take: [...take], haircutBps: Object.fromEntries(Object.entries(haircutBps).filter(([k]) => takes(k))), marginBps });
  // the words for a receipt, a refusal or a page: the class itself, without a clause, so a caller can say what it likes about it
  const words = (klass) => WORDS[klass] || String(klass);
  return { CLASSES, take: [...take], haircutBps, marginBps, baseBps, flat, feeBpsFor, feeFor, takes, covers, terms, words, classOf, classesOf };
}

// The class a quote was priced for, and a check on one that came from somewhere else (a board, a stored record): a quote that names no
// class is the clean one, which is what every page that predates this sends.
export const quotedClass = (quote) => (quote && isClass(quote.class) ? quote.class : 'clean');

// The provider machine's `policy.screen` (dapp/fastbridge-el.js, called as `screen(notes, { quote })`), over a `vet(notes)` that answers with
// each note's verdict (`lineage` in dapp/burndep-ux.js, and the daemon's own read of the bridge's trace): null to take the lock, { why } to
// refuse it, { why, retry } to ask again.
//
// Without a schedule it is the screen the fast bridge had: a note the proof does not follow is refused, and one whose history could not be read
// is asked again. With one it is the floor: the class of the notes the lock spends is named, a class the provider does not take is refused, and
// a lock whose class is worse than the class its quote was priced for is refused. So a provider never takes TAC below the floor it read in its
// own config, whatever a page said when it asked for the quote.
export function stuckScreen(vet, { stuck = null } = {}) {
  return async (inputs, { quote = null } = {}) => {
    const verdicts = await vet(inputs);
    const at = (n) => verdicts && verdicts.get(`${n.txid}:${n.vout}`);
    if (!stuck) {
      if (inputs.some((n) => at(n)?.state === 'unprovable')) return { why: 'a note this lock spends has a history the bridge\'s proof does not follow, which this provider does not take' };
      if (inputs.some((n) => !at(n) || at(n).state === 'unread')) return { why: 'the history of a note could not be read just now', retry: true };
      return null;
    }
    const { klass, known, unknown } = classesOf(verdicts, inputs);
    // the class is the worst of the notes: while one of them is unread the class is not known, and a lock is not taken on a guess
    if (!known) return { why: 'the history of a note could not be read just now', retry: true, unknown };
    if (!stuck.takes(klass)) return { why: `a note this lock spends is ${stuck.words(klass)}, which this provider does not take` };
    const priced = quotedClass(quote);
    if (!stuck.covers(priced, klass)) return { why: `a note this lock spends is ${stuck.words(klass)}, and the quote was priced for ${stuck.words(priced)}: ask again and it is priced for what the lock spends` };
    return null;
  };
}
