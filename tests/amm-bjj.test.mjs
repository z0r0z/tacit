// BabyJubJub primitives + NUMS generator vectors for the tacit AMM.
//
// Pins the canonical H_BJJ / G_BJJ coordinates so any future drift in the
// derivation algorithm (typo in domain tag, wrong endianness, wrong sqrt sign
// rule) is caught immediately. The vectors here are the normative spec values
// once AMM ships; SPEC §3.9 will reference them.

import {
  P_FR, A_BJJ, D_BJJ, ORDER_BJJ, N_BJJ, COFACTOR_BJJ,
  mod, modPow, modInv, modSqrt,
  onCurve, isIdentity, eq, addPoint, mulScalar,
  packPoint, unpackPoint, pedersenBJJ, pedersenBJJStrict, inSubgroup,
  H_BJJ, G_BJJ, H_BJJ_meta, G_BJJ_meta, deriveBJJGenerator,
} from './amm-bjj.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

console.log('BabyJubJub field arithmetic');
test('modPow(2, 256, p) round-trip', () => {
  // 2^256 mod p, multiply by modInv(2^256 mod p), should be 1
  const x = modPow(2n, 256n, P_FR);
  return mod(x * modInv(x)) === 1n;
});
test('modSqrt 0 = 0', () => modSqrt(0n) === 0n);
test('modSqrt 1 = 1', () => modSqrt(1n) === 1n);
test('modSqrt 4 = 2', () => {
  const r = modSqrt(4n);
  return r === 2n || r === P_FR - 2n;
});
test('modSqrt rejects non-residue', () => {
  // Find a non-residue. 5 has Legendre symbol -1 for BN254 Fr.
  return modSqrt(5n) === null;
});
test('round-trip sqrt^2 = original', () => {
  const x = 12345678901234567890n;
  const r = modSqrt(x * x % P_FR);
  return r !== null && (r * r) % P_FR === (x * x) % P_FR;
});

console.log('\nBabyJubJub point operations');
test('identity (0, 1) is on curve', () => onCurve([0n, 1n]));
test('identity is identity', () => isIdentity([0n, 1n]));
test('NUMS H is on curve', () => onCurve(H_BJJ()));
test('NUMS G is on curve', () => onCurve(G_BJJ()));
test('NUMS H is in prime subgroup', () => isIdentity(mulScalar(H_BJJ(), N_BJJ)));
test('NUMS G is in prime subgroup', () => isIdentity(mulScalar(G_BJJ(), N_BJJ)));
test('NUMS H ≠ G', () => !eq(H_BJJ(), G_BJJ()));
test('NUMS H ≠ identity', () => !isIdentity(H_BJJ()));
test('NUMS G ≠ identity', () => !isIdentity(G_BJJ()));
test('addPoint(P, identity) = P', () => eq(addPoint(H_BJJ(), [0n, 1n]), H_BJJ()));
test('mulScalar by 0 = identity', () => isIdentity(mulScalar(H_BJJ(), 0n)));
test('mulScalar by 1 = self', () => eq(mulScalar(H_BJJ(), 1n), H_BJJ()));
test('2*P == P + P', () => {
  const dbl = mulScalar(H_BJJ(), 2n);
  const sum = addPoint(H_BJJ(), H_BJJ());
  return eq(dbl, sum);
});
test('(a+b)*P == a*P + b*P', () => {
  const a = 12345n, b = 67890n;
  const left  = mulScalar(H_BJJ(), a + b);
  const right = addPoint(mulScalar(H_BJJ(), a), mulScalar(H_BJJ(), b));
  return eq(left, right);
});
test('n_BJJ · P == identity for any prime-subgroup P', () => {
  const P = mulScalar(H_BJJ(), 12345n);
  return isIdentity(mulScalar(P, N_BJJ));
});

console.log('\nNUMS generator pinned vectors (any change = breaking spec change)');
//
// Canonical BabyJubJub NUMS generators for the tacit AMM, derived by
// try-and-increment per AMM.md §"BabyJubJub NUMS try-and-increment" with
// seeds "tacit-amm-bjj-H-v1" / "tacit-amm-bjj-G-v1" (UTF-8) and counter_LE(u32).
//
//   H_BJJ: counter = 2
//     u = 0x13969c921b0a36e78280a9ff5415b7756761b630fd5fa30d7537e3640cbf6da5
//     v = 0x1553d34ea48b8d61df6de5ca9ae5d95183746714ba21af253a46c18a6c2279e4
//   G_BJJ: counter = 2
//     u = 0x16b271021d857578ee55d438a32eed9081bfe28579f6e671c87c58a035b49b7b
//     v = 0x2447904d61713ffa77c624c908255001a5f369e2548764cb4adbc6e454ae9884
//
const H_PINNED_U = 0x13969c921b0a36e78280a9ff5415b7756761b630fd5fa30d7537e3640cbf6da5n;
const H_PINNED_V = 0x1553d34ea48b8d61df6de5ca9ae5d95183746714ba21af253a46c18a6c2279e4n;
const G_PINNED_U = 0x16b271021d857578ee55d438a32eed9081bfe28579f6e671c87c58a035b49b7bn;
const G_PINNED_V = 0x2447904d61713ffa77c624c908255001a5f369e2548764cb4adbc6e454ae9884n;
const H_PINNED_COUNTER = 2;
const G_PINNED_COUNTER = 2;

test('H_BJJ counter == 2', () => H_BJJ_meta().counter === H_PINNED_COUNTER);
test('H_BJJ.u matches pinned vector', () => H_BJJ()[0] === H_PINNED_U);
test('H_BJJ.v matches pinned vector', () => H_BJJ()[1] === H_PINNED_V);
test('G_BJJ counter == 2', () => G_BJJ_meta().counter === G_PINNED_COUNTER);
test('G_BJJ.u matches pinned vector', () => G_BJJ()[0] === G_PINNED_U);
test('G_BJJ.v matches pinned vector', () => G_BJJ()[1] === G_PINNED_V);

console.log('\nPoint encoding (circomlib packPoint parity)');
test('pack/unpack round-trip H', () => {
  const enc = packPoint(H_BJJ());
  const dec = unpackPoint(enc);
  return eq(dec, H_BJJ());
});
test('pack/unpack round-trip G', () => {
  const enc = packPoint(G_BJJ());
  const dec = unpackPoint(enc);
  return eq(dec, G_BJJ());
});
test('pack/unpack round-trip random scaled point', () => {
  const P = mulScalar(H_BJJ(), 0xdeadbeefcafef00dn);
  const enc = packPoint(P);
  const dec = unpackPoint(enc);
  return eq(dec, P);
});
test('packed form is 32 bytes', () => packPoint(H_BJJ()).length === 32);
test('unpack rejects out-of-field v', () => {
  // v = p_Fr (out of range)
  const buf = new Uint8Array(32);
  let v = P_FR;
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return unpackPoint(buf) === null;
});

// Subgroup-membership tests. BJJ has cofactor 8: small-order points
// (orders 2, 4, 8) and 2·n_BJJ-order points are ON the curve but NOT in
// the prime subgroup. Pedersen binding requires subgroup membership.
test('inSubgroup(identity) is true', () => inSubgroup([0n, 1n]));
test('inSubgroup(H_BJJ) is true (NUMS generator)', () => inSubgroup(H_BJJ()));
test('inSubgroup(G_BJJ) is true (NUMS generator)', () => inSubgroup(G_BJJ()));
test('inSubgroup(a·H_BJJ) is true for arbitrary a', () => {
  return inSubgroup(mulScalar(H_BJJ(), 0xfeedfacecafebabe1234567890abcdefn));
});
test('inSubgroup((0,-1)) is false (order-2 point)', () => {
  const order2 = [0n, mod(-1n)];
  return !inSubgroup(order2);
});
test('unpackPoint rejects packed order-2 point (small-order)', () => {
  const order2 = [0n, mod(-1n)];
  return unpackPoint(packPoint(order2)) === null;
});

console.log('\nBJJ Pedersen commitment');
test('pedersenBJJ(0, 0) = identity', () => isIdentity(pedersenBJJ(0n, 0n)));
test('pedersenBJJ homomorphism', () => {
  const a1 = 100n, r1 = 7n, a2 = 250n, r2 = 13n;
  const C1 = pedersenBJJ(a1, r1);
  const C2 = pedersenBJJ(a2, r2);
  const sum = addPoint(C1, C2);
  const direct = pedersenBJJ(a1 + a2, r1 + r2);
  return eq(sum, direct);
});
test('pedersenBJJ different blindings give different commits', () => {
  const C1 = pedersenBJJ(100n, 1n);
  const C2 = pedersenBJJ(100n, 2n);
  return !eq(C1, C2);
});
test('pedersenBJJ different amounts give different commits', () => {
  const C1 = pedersenBJJ(100n, 5n);
  const C2 = pedersenBJJ(101n, 5n);
  return !eq(C1, C2);
});

// Strict variant rejects blinding ≡ 0 (loses hiding property).
console.log('\nBJJ Pedersen strict-blinding rejection');
test('pedersenBJJStrict rejects blinding = 0n', () => {
  try { pedersenBJJStrict(100n, 0n); return false; }
  catch (e) { return /destroys hiding/.test(e.message); }
});
test('pedersenBJJStrict rejects blinding = N_BJJ (≡ 0 mod N_BJJ)', () => {
  try { pedersenBJJStrict(100n, N_BJJ); return false; }
  catch (e) { return /destroys hiding/.test(e.message); }
});
test('pedersenBJJStrict rejects blinding = 2·N_BJJ (≡ 0 mod N_BJJ)', () => {
  try { pedersenBJJStrict(100n, 2n * N_BJJ); return false; }
  catch (e) { return /destroys hiding/.test(e.message); }
});
test('pedersenBJJStrict accepts blinding = 1', () => {
  const C = pedersenBJJStrict(100n, 1n);
  return eq(C, pedersenBJJ(100n, 1n));
});
test('pedersenBJJ (non-strict) still accepts (0, 0) for padded slots', () =>
  isIdentity(pedersenBJJ(0n, 0n)));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
