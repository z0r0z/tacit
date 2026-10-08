// Poseidon over the BN254 scalar field, by arity, as the EVM pool's trees and circuits use it (poseidon-lite). `hash([a, b])`
// takes field elements as bigints and returns one.
export async function loadHash() {
  const p = await import('poseidon-lite');
  const byArity = { 2: p.poseidon2, 3: p.poseidon3, 4: p.poseidon4, 5: p.poseidon5, 7: p.poseidon7 };
  return (xs) => {
    const f = byArity[xs.length];
    if (!f) throw new Error(`no Poseidon of arity ${xs.length}`);
    return f(xs);
  };
}
