// The order a mixed batch's ops go in so that each memo lands on the leaf it was sealed for.
//
// A settle carries ONE memo list. The pool pairs its first `leaves.length` entries with the note leaves one for one, and the rest with the lock leaves; the guest commits
// a root over that list in the order it is handed the hashes, and the batch input is each op's hashes in op order (an op's own memos are its notes, then its locks). So an
// op that makes lock leaves, put in front of an op that makes notes, puts its lock memos in the note leaves' places and moves every note memo after it one place on: the
// pool takes the settle, and neither the recipient of the lock nor the owner of those notes can open what sits on their leaf.
//
// Whether the order is right can be seen from the op types alone. The guest makes lock leaves in four places (contracts/sp1/confidential/src/main.rs, `lock_leaves.push`),
// pinned by tests/memo-order.test.mjs:
//   stealth lock, stealth lock batch   lock leaves only
//   swap                               notes, and a lock for the protocol's cut when the pool takes one
//   adaptor lock, bridge stealth mint  (not types a mixed batch takes)
// Every other type makes notes only. A type this list does not know is treated like a swap, the careful way: at most one, and after the notes of the rest.
//
// The right batch is: the ops that make notes only, in the order they came; then at most one op that makes notes and locks; then the ops that make locks only. Any other
// op that makes locks does not wait to be right here: it goes alone, the way a lone op always has.

const NOTES_ONLY = new Set([
  'wrap', 'unwrap', 'transfer', 'route', 'lp', 'otc', 'bid', 'bridgeburn', 'cdpmint', 'farmbond', 'farmharvest', 'farmunbond',
  'cdpclose', 'cdpliquidate', 'cdptopup', 'stealthclaim', 'stealthrefund', 'sendunwrap', 'lpbond', 'lpremove',
]);
const LOCKS_ONLY = new Set(['stealthlock', 'stealthlockbatch']);

export const makesLocksOnly = (type) => LOCKS_ONLY.has(type);
export const makesNotesOnly = (type) => NOTES_ONLY.has(type);

// jobs: [{ type, ... }] in the order they were claimed. → { batch, alone }: the jobs to prove together, in the order whose memo list pairs right, and the jobs left out.
export function memoSafeOrder(jobs) {
  const notes = [], locks = [], both = [], alone = [];
  for (const j of jobs || []) {
    if (makesNotesOnly(j.type)) notes.push(j);
    else if (makesLocksOnly(j.type)) locks.push(j);
    else if (both.length) alone.push(j);
    else both.push(j);
  }
  return { batch: [...notes, ...both, ...locks], alone };
}
