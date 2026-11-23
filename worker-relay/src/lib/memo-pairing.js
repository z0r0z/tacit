// Checks that a settle's memos sit where the pool will pair them, before the settle is paid for.
//
// The pool pairs one memo list with the proof's leaves by place: the first `leaves.length` memos with the note leaves, the rest with the lock leaves (ConfidentialPool._settle).
// The proof commits a root over the list in the order it was handed the hashes, and cannot tell which memo is for which leaf, so a list in the wrong order is taken by the
// pool: a stealth send's memo once landed on a transfer's note leaf and the transfer's own memos moved up by one (lib/memo-order.js is the rule that orders a batch right; this
// is the check on what it produced, made from the memos and the proof alone, so it does not depend on that rule being right).
//
// Two things are checked. A memo's size says what it is for: a note's memo is 169 bytes, a stealth lock's 145 or, with the sender's tail, 322, and a lock the pool takes a cut
// into (a swap's) has none. So a note place holding a stealth-sized memo, or a lock place holding a note-sized one, is a memo on the wrong leaf. That holds for every settle on
// mainnet but the one that went wrong (read on 2026-11-23 from the whole public index: 9,670 settles with note leaves, whose memos were 0, 169 or, once, 322 bytes, and all 337
// lock places, whose memos were 0, 322 or, once, 169 bytes).
// And for an op that names the lock leaf it makes (stealth lock, and each op of a batch of them), the memo at that lock's place in the proof must be its own.

const NOTE_MEMO_BYTES = 169;
const STEALTH_MEMO_BYTES = new Set([145, 322]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const strip = (h) => String(h == null ? '' : h).replace(/^0x/, '');
const bytesOf = (m) => strip(m).length / 2;
const norm = (m) => strip(m).toLowerCase();
const short = (h) => `${String(h).slice(0, 10)}…`;

// PublicValues head words (ConfidentialPool.PublicValues): 4 = leaves, 17 = lockLeaves; each dynamic array's head word is its offset from the struct's start.
const LEAVES_FIELD = 4;
const LOCK_LEAVES_FIELD = 17;

// → { leaves: ['0x…'], lockLeaves: ['0x…'] }, or null when the bytes are not public values of that shape (the pool judges those, not this).
export function settleLeafSets(publicValues) {
  try {
    const hex = strip(publicValues).toLowerCase();
    if (!/^[0-9a-f]*$/.test(hex) || hex.length < 64) return null;
    const word = (byteOff) => hex.slice(byteOff * 2, byteOff * 2 + 64);
    const num = (byteOff) => { const w = word(byteOff); if (w.length !== 64) throw new Error('short'); const v = BigInt('0x' + w); if (v > 0xffffffffn) throw new Error('large'); return Number(v); };
    const base = num(0);
    const array = (field) => {
      const at = base + num(base + field * 32), count = num(at);
      if ((at + 32 + count * 32) * 2 > hex.length) throw new Error('past the end');
      return Array.from({ length: count }, (_, i) => '0x' + word(at + 32 + i * 32));
    };
    return { leaves: array(LEAVES_FIELD), lockLeaves: array(LOCK_LEAVES_FIELD) };
  } catch { return null; }
}

// The lock leaves a job's op names, each with the memo that job sealed for it. Only what the job declares: an op that names none (sealed ones, other clients) is not guessed at.
function declaredLocks(job) {
  const op = job && job.op, memos = job && Array.isArray(job.memos) ? job.memos : [];
  if (!op || typeof op !== 'object') return [];
  const one = (o, memo) => (o && typeof o.lockLeaf === 'string' && HEX32.test(o.lockLeaf) && memo != null ? [{ leaf: o.lockLeaf.toLowerCase(), memo }] : []);
  if (job.type === 'stealthlock') return memos.length === 1 ? one(op, memos[0]) : [];
  if (job.type === 'stealthlockbatch' && Array.isArray(op.ops) && memos.length === op.ops.length) return op.ops.flatMap((o, i) => one(o, memos[i]));
  return [];
}

// → null when the memos pair with the proof's leaves, else a sentence saying which memo is where it should not be.
export function memoPairingProblem(publicValues, memos, jobs = []) {
  const sets = settleLeafSets(publicValues);
  if (!sets) return null;
  const list = Array.isArray(memos) ? memos : [];
  const notes = sets.leaves.length;
  for (let i = 0; i < list.length; i++) {
    const b = bytesOf(list[i]);
    if (i < notes && STEALTH_MEMO_BYTES.has(b)) return `memo ${i} is ${b} bytes, a stealth lock's, but the pool will put it on note leaf ${i}`;
    if (i >= notes && b === NOTE_MEMO_BYTES) return `memo ${i} is ${b} bytes, a note's, but the pool will put it on lock leaf ${i - notes}`;
  }
  const locks = sets.lockLeaves.map((l) => l.toLowerCase());
  for (const job of jobs || []) {
    for (const { leaf, memo } of declaredLocks(job)) {
      const k = locks.indexOf(leaf);
      if (k < 0) continue;   // a leaf this proof does not hold says nothing about the pairing
      if (norm(list[notes + k]) !== norm(memo)) return `the ${job.type} job's lock ${short(leaf)} is lock ${k} of this proof, but the memo it sealed for it is not the one the pool will put there`;
    }
  }
  return null;
}

// The error a settle is refused with when the memos would land on the wrong leaves.
export function assertMemoPairing(publicValues, memos, jobs = []) {
  const problem = memoPairingProblem(publicValues, memos, jobs);
  if (problem) throw Object.assign(new Error(`memos would land on the wrong leaves: ${problem}`), { code: 'memo_pairing' });
}

// The same question asked of a batch's memos before it is proved, from the memos alone: the pool puts every lock's memo after every note's, so in the list a batch will be
// proved with, no note-sized memo may come after a stealth-sized one. → null, or a sentence.
export function memoClassOrderProblem(memos) {
  let lockAt = -1;
  const list = Array.isArray(memos) ? memos : [];
  for (let i = 0; i < list.length; i++) {
    const b = bytesOf(list[i]);
    if (STEALTH_MEMO_BYTES.has(b) && lockAt < 0) lockAt = i;
    else if (b === NOTE_MEMO_BYTES && lockAt >= 0) return `a note's memo (${i}) comes after a stealth lock's (${lockAt}) in the batch's list`;
  }
  return null;
}
