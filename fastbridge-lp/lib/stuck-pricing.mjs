// A pricing and policy rule for TAC a provider cannot bridge home (stuck TAC bounty, entry C).
//
// The daemon today takes any TAC the validator accepts (anyTac) at one fee for every note. Two kinds of
// note it takes cannot go home over the regular bridge: a note that left the Bitcoin shielded pool
// (opcode 0x6d, the burn proof does not follow a history through the pool) and a note with more than
// 255 transfers behind it (the proof is bounded, ncx > 256). Every such note a provider takes at the
// clean fee is a quiet loss: it pays out lendable TAC on Ethereum and holds Bitcoin TAC it can only
// realise at a discount, so its Ethereum-side capacity drains with every stuck bridge.
//
// This module prices that, by class, and nothing else. It is a pure rule: it reads a note's class, the
// amount, and a snapshot of what the provider already holds, and it answers accept or refuse, the fee
// it would keep, and why. It moves nothing, sells nothing and holds no key. A daemon wires it in front
// of its quoter: the class of a lock is the worst class of the notes it spends, told apart by the same
// reads the screens already make (the reflection trace, as in lineageScreen in dapp/fast/wire.js and
// policy.screen in dapp/fastbridge-el.js). A provider that does not load it quotes as it always did,
// and a quote made with it carries no new field: the fee is the fee, in the members a quote already has.
//
// The rule, in one line per class: a provider takes a stuck note only at a fee that covers the haircut
// it expects on that class, and only while the limits in its config leave room for it.
//
//   feeBps(class) = baseFeeBps + haircutBps(class) + lockupBps(class)
//   haircutBps    = 10000 - recoveryBps(class)     (the share of face the provider does not expect back)
//   lockupBps     = lockupBpsPerDay * expectedDaysStuck(class)
//
// Break-even, by construction: the provider pays out amount - fee and holds a note it expects to
// realise recoveryBps of. fee >= amount * (1 - recovery) + lockup cost is exactly the condition for
// the payout not to exceed what the note is expected to be worth once the wait is paid for.
//
// Safe by default, as the rest of the daemon is:
//   - a note whose history could not be read is refused (retry), never guessed at — the same answer
//     lineageScreen gives today;
//   - a class whose expected recovery is under the floor in the config is refused outright, however
//     large a fee a holder would pay: some notes are not priced, they are declined;
//   - stuck takes stop at a per-note cap, a per-day cap and a share of the provider's inventory, so a
//     bad recovery guess can only cost a bounded slice, never the book;
//   - a fee that would pass what a bridger's client will quote at all (90%, dapp/fast/fmt.js) is
//     refused rather than quoted.
// Amounts are base units (1 TAC = 1e8), as everywhere in the daemon; money is BigInt, rates are bps.

export const HISTORY_LIMIT = 255; // transfers; the burn proof folds at most this many (ncx > 256 refuses)

export const CLASS = Object.freeze({
  CLEAN: 'clean',               // the proof follows the note home: it bridges like any other
  LONG_HISTORY: 'long-history', // more than HISTORY_LIMIT transfers behind it
  POOL_EXIT: 'pool-exit',       // left the Bitcoin shielded pool (opcode 0x6d)
  UNKNOWN: 'unknown',           // the trace could not be read, or read as none of the above
});

// The classes in the order a lock takes the worst of: a lock that spends one pool-exit note is a
// pool-exit take, whatever else it spends.
const WORST_FIRST = [CLASS.POOL_EXIT, CLASS.LONG_HISTORY, CLASS.CLEAN];

// Safe defaults. recoveryBps is the share of face a provider expects to realise for a stuck note by
// selling it on Bitcoin (the order book, or a desk), read from what stuck TAC trades at, not wished
// at. A long history can be read in full, so a buyer can price it; a pool exit's history cannot be
// followed at all, so it is priced lower and waited on longer. Both are config: a provider that sees
// worse prices raises the haircut or lowers the floor and refuses the class.
// maxFeeBps is the most a bridger's client will quote (a fee over 90% is not quoted, FAST-BRIDGE.md).
export const DEFAULT_STUCK_POLICY = Object.freeze({
  enabled: true,
  baseFeeBps: 30,          // the provider's ordinary fee rate, as in config.example.json's quote
  flatFee: '10000000',     // base units (0.1 TAC), the ordinary flat part of the fee
  recoveryBps: Object.freeze({ [CLASS.LONG_HISTORY]: 6500, [CLASS.POOL_EXIT]: 6000 }),
  expectedDaysStuck: Object.freeze({ [CLASS.LONG_HISTORY]: 30, [CLASS.POOL_EXIT]: 45 }),
  lockupBpsPerDay: 5,      // the cost of capital while a stuck note waits to be sold
  floorRecoveryBps: 5000,  // a class expected to realise less than half its face is refused, not priced
  maxStuckShareBps: 2000,  // stuck face held stays at or under 20% of the provider's TAC inventory
  maxStuckPerNote: '10000000000',   // 100 TAC in one stuck take
  maxStuckPerDay: '20000000000',    // 200 TAC of stuck takes in a day
  maxFeeBps: 9000,
});

// Reads a config's stuck section (the `stuck` member of a fastbridge-lp config) over the defaults and
// checks it is one this rule can run: every rate a whole number in range, every amount a base-unit
// string, no class priced to recover more than its face. A bad config throws, as a bad quote config
// does in the daemon: a provider that cannot state its prices does not take stuck TAC at all.
export function stuckPolicy(config = {}) {
  const p = { ...DEFAULT_STUCK_POLICY, ...(config || {}) };
  const recoveryBps = { ...DEFAULT_STUCK_POLICY.recoveryBps, ...(config?.recoveryBps || {}) };
  const expectedDaysStuck = { ...DEFAULT_STUCK_POLICY.expectedDaysStuck, ...(config?.expectedDaysStuck || {}) };
  const out = { ...p, recoveryBps, expectedDaysStuck, flatFee: BigInt(p.flatFee), maxStuckPerNote: BigInt(p.maxStuckPerNote), maxStuckPerDay: BigInt(p.maxStuckPerDay) };
  for (const k of ['baseFeeBps', 'lockupBpsPerDay', 'floorRecoveryBps', 'maxStuckShareBps', 'maxFeeBps'])
    if (!Number.isInteger(out[k]) || out[k] < 0) throw new Error(`stuck policy: ${k} must be a whole number at or over 0`);
  if (out.maxFeeBps > 10000 || out.maxStuckShareBps > 10000) throw new Error('stuck policy: a bps cap over 10000 is not a cap');
  for (const c of [CLASS.LONG_HISTORY, CLASS.POOL_EXIT]) {
    if (!Number.isInteger(recoveryBps[c]) || recoveryBps[c] < 0 || recoveryBps[c] > 10000)
      throw new Error(`stuck policy: recoveryBps.${c} must be whole bps of face, 0 to 10000`);
    if (!Number.isInteger(expectedDaysStuck[c]) || expectedDaysStuck[c] < 0)
      throw new Error(`stuck policy: expectedDaysStuck.${c} must be a whole number of days at or over 0`);
  }
  return out;
}

// The class of one note, from the reads a screen already has: whether the trace followed it, whether
// it came out of the shielded pool, and how many transfers stand behind it. A note the trace could not
// read — or one handed in with no reading at all — is unknown, and unknown is refused, never priced.
//   note = { trace: 'tracked' | 'unprovable' | 'unread', poolExit: bool, transfers: number }
export function classifyNote(note) {
  if (!note || note.trace === 'unread' || note.trace == null) return CLASS.UNKNOWN;
  if (note.poolExit || note.trace === 'pool-exit') return CLASS.POOL_EXIT;
  if (Number(note.transfers) > HISTORY_LIMIT) return CLASS.LONG_HISTORY;
  if (note.trace === 'tracked' || note.trace === 'unprovable') {
    // 'unprovable' with no pool exit and a history within the limit is a history the proof does not
    // follow for another reason (a pool or farm trade, TAC that came over from Ethereum): it cannot
    // go home either, and its lineage is readable, so it is priced as the long-history class is.
    return note.trace === 'tracked' ? CLASS.CLEAN : CLASS.LONG_HISTORY;
  }
  return CLASS.UNKNOWN;
}

// The class of a whole lock: the worst class among the notes it spends, as a screen refuses a lock
// for its worst note today.
export function classifyLock(notes) {
  if (!Array.isArray(notes) || !notes.length) return CLASS.UNKNOWN;
  const classes = notes.map(classifyNote);
  if (classes.includes(CLASS.UNKNOWN)) return CLASS.UNKNOWN;
  return WORST_FIRST.find((c) => classes.includes(c)) || CLASS.UNKNOWN;
}

// The fee rate a class is taken at, in bps of the amount, before the flat part. Clean notes are the
// provider's ordinary business and carry no haircut and no lockup.
export function feeBpsFor(cls, policy) {
  if (cls === CLASS.CLEAN) return policy.baseFeeBps;
  const haircut = 10000 - policy.recoveryBps[cls];
  const lockup = policy.lockupBpsPerDay * policy.expectedDaysStuck[cls];
  return policy.baseFeeBps + haircut + lockup;
}

// The decision for one take. Pure: the caller brings the snapshot, this brings the rule.
//   ask = {
//     notes,                 // the notes the lock spends, as classifyNote reads them
//     amount,                // base units the lock takes (BigInt or string)
//     inventoryTac,          // base units of TAC the provider holds, both sides, now
//     stuckTac,              // base units of stuck face it already holds
//     stuckTodayTac,         // base units of stuck face it has taken today
//   }
// Answers { accept, class, feeBps, fee, evmOut, why, retry? } with money as BigInt. On a refusal the
// fee fields are null: a refused take is not a quote, and no page or provider has to change to carry
// one — the refusal is the { why, retry } shape the screens already answer with.
export function decideTake(ask, policy = stuckPolicy()) {
  const amount = BigInt(ask?.amount ?? 0);
  const no = (why, retry) => ({ accept: false, class: null, feeBps: null, fee: null, evmOut: null, why, ...(retry ? { retry: true } : {}) });
  if (!policy.enabled) return no('this provider does not price stuck TAC: its rule is off');
  if (amount <= 0n) return no('the amount is not a positive number of base units');

  const cls = classifyLock(ask?.notes);
  if (cls === CLASS.UNKNOWN) return no('the history of a note could not be read just now', true);

  const feeBps = feeBpsFor(cls, policy);
  const fee = (amount * BigInt(feeBps)) / 10000n + policy.flatFee;
  if (cls !== CLASS.CLEAN) {
    if (policy.recoveryBps[cls] < policy.floorRecoveryBps)
      return no(`a ${cls} note is expected to realise under the floor in this provider's config, so it is refused, not priced`);
    if (feeBps > policy.maxFeeBps)
      return no(`the fee a ${cls} note needs passes what a bridger's client will quote, so it is refused, not priced`);
    if (amount > policy.maxStuckPerNote)
      return no(`a stuck take is capped at ${policy.maxStuckPerNote} base units by this provider's config`);
    const stuckAfter = BigInt(ask?.stuckTac ?? 0) + amount;
    const inventory = BigInt(ask?.inventoryTac ?? 0);
    if (inventory <= 0n || stuckAfter * 10000n > inventory * BigInt(policy.maxStuckShareBps))
      return no('this take would put stuck TAC over the share of inventory this provider allows itself');
    if (BigInt(ask?.stuckTodayTac ?? 0) + amount > policy.maxStuckPerDay)
      return no('this provider has taken its day of stuck TAC');
  }
  if (amount <= fee) return no('the amount does not cover the fee');
  return { accept: true, class: cls, feeBps, fee, evmOut: amount - fee, why: null };
}
