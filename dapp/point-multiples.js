// v·P for a public point P (the amount generator H) and many amounts v, much cheaper than P.multiply(v) for each.
//
// P.multiply is built to take the same time whatever the scalar is (the curve library's point multiplication is for secret scalars), about a millisecond a call, and the wrap walk
// (confidential-recovery.js) wants the multiple of H for every amount any wrap in the pool has been made with, a few hundred of them. Nothing here is secret (H and the amounts are
// on chain), so an amount below 2^64 is read a hex digit at a time and added up from a table of d·16^j·P, at most sixteen additions. The table is built the first time it is needed,
// and what is worked out is kept: the multiple of H for an amount is the same for every asset and every walk. An amount of 2^64 or more, or none, is left to P.multiply.
const BITS = 64, DIGITS = BITS / 4, KEPT = 50000;

export function makeMultiples(P) {
  let table = null;
  const kept = new Map();
  const build = () => {
    table = [];
    let base = P;
    for (let j = 0; j < DIGITS; j++) {
      const row = new Array(16);
      row[1] = base;
      for (let d = 2; d < 16; d++) row[d] = row[d - 1].add(base);
      table.push(row);
      base = row[15].add(base);
    }
  };
  return function multiple(v) {
    const n = BigInt(v);
    let p = kept.get(n);
    if (p) return p;
    if (n <= 0n || n >> BigInt(BITS) !== 0n) p = P.multiply(n);
    else {
      if (!table) build();
      const hex = n.toString(16).padStart(DIGITS, '0');
      for (let j = 0; j < DIGITS; j++) {
        const d = parseInt(hex[DIGITS - 1 - j], 16);
        if (d) p = p ? p.add(table[j][d]) : table[j][d];
      }
    }
    if (kept.size >= KEPT) kept.clear();
    kept.set(n, p);
    return p;
  };
}
