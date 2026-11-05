// What a board proof must be to be taken for a public job (lib/prover.js proveSettle): pure, so it is tested without the relay's clients.

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
