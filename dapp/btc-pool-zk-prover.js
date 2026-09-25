// Groth16 prove / verify for dapp/circuits/btc-pool/spend.circom, and the 256-byte proof wire form.
//
// Browser: snarkjs from ./vendor/tacit-mixer.min.js, wasm + zkey as Uint8Array fetched by pinned CID.
// Node (indexer, relayer, tests): pass the snarkjs module; verify is snarkjs/ffjavascript native.
//
// Wire: A(64) ‖ B(128) ‖ C(64), big-endian 32-byte limbs, G2 as (x_c0, x_c1, y_c0, y_c1) in snarkjs order,
// the layout groth16.rs / parseGroth16Proof256 read.

import { publicSignals as toPublicSignals, ZK_N_PUBLIC } from './btc-pool-zk.js';

export const PROOF_WIRE_LEN = 256;

async function loadSnarkjs(snarkjs) {
  if (snarkjs) return snarkjs;
  const mod = await import('./vendor/tacit-mixer.min.js');
  return mod.snarkjs;
}

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
    return await s.groth16.verify(vk, signals, p, { info() {}, warn() {}, error() {}, debug() {} });
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
