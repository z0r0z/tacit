// Proof system for dapp/circuits/btc-pool/spend.circom behind one interface, so the envelope layout, the
// indexer rules and the wallet never name it:
//
//   system.prove(input, { onProgress }) → { wire, publicSignals }     input: buildWitness(...).input
//   system.verify(publics, wire)        → bool                        publics: 12 decimal strings
//
// Groth16 (BN254) here. Wire: A(64) ‖ B(128) ‖ C(64), big-endian 32-byte limbs, G2 as (x_c0, x_c1, y_c0, y_c1) in
// snarkjs order, the layout btc-pool-zk-core/src/verify.rs reads.
//
// Browser: snarkjs from ./vendor/tacit-mixer.min.js, wasm + zkey as bytes or async loaders. Node (indexer,
// relayer, tests): the same bundle, or pass the snarkjs module.

import { sha256 } from './vendor/tacit-deps.min.js';
import { publicSignals as toPublicSignals, ZK_N_PUBLIC } from './btc-pool-zk.js';

export const PROOF_WIRE_LEN = 256;
export const GROTH16_SYSTEM_ID = 'groth16-bn254';

async function loadSnarkjs(snarkjs) {
  if (snarkjs) return snarkjs;
  const mod = await import('./vendor/tacit-mixer.min.js');
  return mod.snarkjs;
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// input: the object from makeBtcPoolZk().buildWitness(...).input
export async function proveSpend(input, { wasm, zkey, snarkjs, singleThread = false } = {}) {
  const s = await loadSnarkjs(snarkjs);
  const opts = singleThread ? { singleThread: true } : undefined;
  const { proof, publicSignals } = await s.groth16.fullProve(input, wasm, zkey, undefined, undefined, opts);
  if (publicSignals.length !== ZK_N_PUBLIC) throw new Error('btc-pool-zk: unexpected public signal count');
  return { proof, publicSignals, wire: encodeProof(proof) };
}

// publics: array of decimal strings (see btc-pool-zk.js publicSignals) or the named object.
export async function verifySpend(vk, publics, proof, { snarkjs } = {}) {
  const s = await loadSnarkjs(snarkjs);
  const signals = Array.isArray(publics) ? publics.map((x) => BigInt(x).toString()) : toPublicSignals(publics);
  if (signals.length !== ZK_N_PUBLIC) return false;
  const p = proof instanceof Uint8Array ? decodeProof(proof) : proof;
  if (!p) return false;
  try {
    return await s.groth16.verify(vk, signals, p, quiet);
  } catch {
    return false;
  }
}

const be32 = (dec) => {
  const hex = BigInt(dec).toString(16);
  if (hex.length > 64) throw new Error('btc-pool-zk: field overflow');
  const out = new Uint8Array(32);
  const h = hex.padStart(64, '0');
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const rd = (b, o) => { let x = 0n; for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(b[o + i]); return x.toString(); };

export function encodeProof(proof) {
  const out = new Uint8Array(PROOF_WIRE_LEN);
  const put = (o, v) => out.set(be32(v), o);
  put(0, proof.pi_a[0]); put(32, proof.pi_a[1]);
  put(64, proof.pi_b[0][0]); put(96, proof.pi_b[0][1]); put(128, proof.pi_b[1][0]); put(160, proof.pi_b[1][1]);
  put(192, proof.pi_c[0]); put(224, proof.pi_c[1]);
  return out;
}

export function decodeProof(b) {
  if (!(b instanceof Uint8Array) || b.length !== PROOF_WIRE_LEN) return null;
  return {
    protocol: 'groth16',
    curve: 'bn128',
    pi_a: [rd(b, 0), rd(b, 32), '1'],
    pi_b: [[rd(b, 64), rd(b, 96)], [rd(b, 128), rd(b, 160)], ['1', '0']],
    pi_c: [rd(b, 192), rd(b, 224), '1'],
  };
}

// SHA-256 over alpha1 ‖ beta2 ‖ gamma2 ‖ delta2 ‖ IC as big-endian limbs (G2 in snarkjs order): the pin both
// this module and btc-pool-zk-core `vk_hash` compute.
export function vkHash(vk) {
  if (vk?.protocol !== 'groth16' || vk?.curve !== 'bn128' || Number(vk?.nPublic) !== ZK_N_PUBLIC) throw new Error('btc-pool-zk: not a spend.circom Groth16 key');
  const parts = [...vk.vk_alpha_1.slice(0, 2)];
  for (const g of [vk.vk_beta_2, vk.vk_gamma_2, vk.vk_delta_2]) parts.push(g[0][0], g[0][1], g[1][0], g[1][1]);
  for (const p of vk.IC) parts.push(p[0], p[1]);
  const buf = new Uint8Array(parts.length * 32);
  parts.forEach((x, i) => buf.set(be32(x), 32 * i));
  return Array.from(sha256(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

// The Groth16 system. `vk` is the verification key JSON; `wasm` / `zkey` are bytes or async loaders, read only
// when proving. `pinnedVkHash` refuses a key that does not match the pin.
export function makeGroth16System({ vk, wasm = null, zkey = null, snarkjs = null, singleThread = false, pinnedVkHash = null } = {}) {
  if (!vk) throw new Error('btc-pool-zk: verification key required');
  const hash = vkHash(vk);
  if (pinnedVkHash && hash !== String(pinnedVkHash).replace(/^0x/, '').toLowerCase()) throw new Error(`btc-pool-zk: verification key ${hash} is not the pinned ${pinnedVkHash}`);
  const load = async (x, name) => {
    const v = typeof x === 'function' ? await x() : x;
    if (!v) throw new Error(`btc-pool-zk: ${name} unavailable`);
    return v;
  };
  return {
    id: GROTH16_SYSTEM_ID,
    wireLen: PROOF_WIRE_LEN,
    vkHash: hash,
    async prove(input, { onProgress } = {}) {
      onProgress?.('loading');
      const [w, z] = [await load(wasm, 'circuit wasm'), await load(zkey, 'proving key')];
      onProgress?.('proving');
      const { wire, publicSignals } = await proveSpend(input, { wasm: w, zkey: z, snarkjs: await loadSnarkjs(snarkjs), singleThread });
      if (!(await verifySpend(vk, publicSignals, wire, { snarkjs: await loadSnarkjs(snarkjs) }))) throw new Error('btc-pool-zk: fresh proof does not verify');
      return { wire, publicSignals };
    },
    async verify(publics, wire) {
      const b = wire instanceof Uint8Array ? wire : null;
      if (!b || b.length !== PROOF_WIRE_LEN) return false;
      return verifySpend(vk, publics, b, { snarkjs: await loadSnarkjs(snarkjs) });
    },
  };
}
