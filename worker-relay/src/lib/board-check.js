// What a board proof must be to be taken for a public job (lib/prover.js proveSettle): pure, so it is tested without the relay's clients.
import { readWrapStdin, wrapExpect, proofFits } from './wrap-expect.js';

// The deposits a settle's public values consume (abi.encode of ConfidentialPool.PublicValues: word 6 points at depositsConsumed), lower-case
// hex, or null when they cannot be read.
export function pvDeposits(publicValues) {
  try {
    const h = String(publicValues).replace(/^0x/, '').toLowerCase(), n = h.length / 64;
    if (!h.length || h.length % 64 || !/^[0-9a-f]+$/.test(h)) return null;
    const w = (i) => { if (!(i >= 0 && i < n)) throw new Error('short'); return BigInt('0x' + h.slice(i * 64, i * 64 + 64)); };
    if (w(0) !== 32n || w(6) % 32n) return null;
    const at = 1 + Number(w(6) / 32n), len = Number(w(at));
    if (at + 1 + len > n) return null;
    return Array.from({ length: len }, (_, k) => '0x' + h.slice((at + 1 + k) * 64, (at + 2 + k) * 64));
  } catch { return null; }
}
// A community machine races a public job holding its input, memos and all, so it could prove an op of its own (its own small deposit) that
// carries the same memos and passes the settle check; settling that would leave the user's op unproved. A deposit can only be consumed by an
// op its owner signed, so a community proof is taken only when it consumes exactly the job's deposits. Tacit's own workers prove the input they
// were given and are checked as before.
export const consumesJobDeposits = (publicValues, want) => {
  const got = pvDeposits(publicValues);
  if (!got || !want.length || got.length !== want.length) return false;
  const w = new Set(want.map((x) => String(x).toLowerCase()));
  return got.every((d) => w.has(d));
};

// What a plain wrap's proof must commit to, read from the job's own input the way the proof pool reads a wrap's (its deposit, leaf, chain binding and memo
// root), or null for any other op and for an input that cannot be read.
export function wrapExpectation(type, stdin) {
  if (type !== 'wrap') return null;
  try { return wrapExpect(readWrapStdin(stdin)); } catch { return null; }
}

// A board proof made before its deposit is in the pool (a wrap, wrap-swap or wrap-and-send proved first and sent with its deposit through the router): the
// pool's settle simulation can only refuse it, so the SP1 verifier (`verify`) judges whether it is sound. That holds for Tacit's own worker, which proved the
// input it was given, and for a community machine alike, so the first sound proof wins the race whoever made it. A community proof is first held to the
// job: it consumes exactly the job's deposits and, for a plain wrap (`expect`), its public values are exactly the job's wrap's, which is what
// keeps a sound proof of someone else's op, or of this one against any root, from passing. → true, 'unchecked' (the verifier could not be asked) or false.
export async function judgeNodeposit({ community = false, publicValues, proof, want, expect = null, verify }) {
  if (community) {
    if (!consumesJobDeposits(publicValues, want || [])) return false;
    if (expect && !proofFits(publicValues, expect)) return false;
  }
  return verify({ publicValues, proof });
}
