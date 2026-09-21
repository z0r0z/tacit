// The settle proof commits to one memo root: keccak over keccak(memo_i) for every note leaf and then every lock
// leaf, in order (ConfidentialPool._settle recomputes it from the `memos` argument and reverts on any difference).
// The relay hands the prover the hash of each job memo, then submits the memos with the proof; these helpers check
// that the memos about to be submitted are the ones the proof commits to, before a settle is paid for.
import { keccak256, concat } from 'viem';

// PublicValues field 27 is `memoRoot`; every field occupies one head word of the ABI-encoded struct.
const MEMO_ROOT_FIELD = 27;
const ZERO32 = '0x' + '00'.repeat(32);

const asHex = (m) => (String(m).startsWith('0x') ? String(m) : `0x${m}`);

export function memoRootOf(memos) {
  let root = ZERO32;
  for (const m of memos || []) root = keccak256(concat([root, keccak256(asHex(m))]));
  return root;
}

export function publicValuesMemoRoot(publicValuesHex) {
  const hex = String(publicValuesHex || '').replace(/^0x/, '');
  const word = (i) => hex.slice(i * 64, i * 64 + 64);
  if (hex.length < 64) throw new Error('public values too short');
  const structOffset = Number(BigInt('0x' + word(0)));
  if (structOffset % 32 !== 0) throw new Error('public values: unaligned struct offset');
  const at = structOffset / 32 + MEMO_ROOT_FIELD;
  const w = word(at);
  if (w.length !== 64) throw new Error('public values too short');
  return '0x' + w;
}

// Throws unless `memos` hash to the memo root the proof commits to.
export function assertMemosMatchProof(publicValues, memos) {
  const committed = publicValuesMemoRoot(publicValues).toLowerCase();
  const actual = memoRootOf(memos).toLowerCase();
  if (committed !== actual) throw new Error(`memos do not match the proof's memo root (proof ${committed}, memos ${actual})`);
}
