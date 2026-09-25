// Bitcoin shielded pool, client-proved relation: note model, keys, tree, nullifier, body hash, EdDSA and
// the witness for dapp/circuits/btc-pool/spend.circom. Rust twin: contracts/sp1/confidential/btc-pool-zk-core.
// Vectors: tests/vectors/btc-pool-zk-vectors.json.
//
// Field p = BN254 Fr. Keys are BabyJubJub scalars mod l at circomlib's Base8. Stealth ECDH stays secp256k1:
// the caller supplies the 33-byte shared secret s from the existing wallet module.
//
//   a, n        = hsL("tacit-btc-pool-zk-wallet-{spend,nk}-v1", network ‖ seed)       A = a·B8, N = n·B8
//   t_a, t_n    = hsL("tacit-btc-pool-zk-{auth,nk}-tweak-v1", s)
//   rho         = hsP("tacit-btc-pool-zk-rho-v1", s)
//   Ak = A + t_a·B8   sk_note = a + t_a        NK = N + t_n·B8   nk_note = n + t_n      (mod l)
//   npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)
//   leaf = Poseidon(assetF, v, npk, rho)          assetF   = sha256("tacit-btc-pool-zk-asset-v1" ‖ asset) mod p
//   nf   = Poseidon(nk_note, leaf, index)         bodyHash = sha256("tacit-btc-pool-zk-body-v1" ‖ body) mod p
//
// hsX(tag, m) = (sha256(tag ‖ m ‖ 0x00) ‖ sha256(tag ‖ m ‖ 0x01)) as a 512-bit big-endian integer mod X;
// hsL rejects 0.
//
// EdDSA-Poseidon (circomlib verifier): R8 = r·B8, h = Poseidon(R8.x, R8.y, A.x, A.y, M), S = r + 8·h·sk mod l,
// r = hsL("tacit-btc-pool-zk-eddsa-nonce-v1", sk ‖ M).

import { sha256, concatBytes } from './vendor/tacit-deps.min.js';
import {
  P_FR, N_BJJ, ID, addPoint, mulScalar, eq as ptEq, onCurve, pedersenBJJ, packPoint, unpackPoint,
} from './amm-bjj.js';

export const ZK_TREE_DEPTH = 32;
export const ZK_N_IN = 2;
export const ZK_N_OUT = 3;
export const ZK_N_PUBLIC = 12;
export const BASE8 = Object.freeze([
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
]);
export const L_BJJ = N_BJJ;
const U64 = 1n << 64n;
const R_MAX = 1n << 251n;

const te = new TextEncoder();
export const TAG = Object.freeze({
  spend: 'tacit-btc-pool-zk-wallet-spend-v1',
  nk: 'tacit-btc-pool-zk-wallet-nk-v1',
  authTweak: 'tacit-btc-pool-zk-auth-tweak-v1',
  nkTweak: 'tacit-btc-pool-zk-nk-tweak-v1',
  rho: 'tacit-btc-pool-zk-rho-v1',
  asset: 'tacit-btc-pool-zk-asset-v1',
  body: 'tacit-btc-pool-zk-body-v1',
  nonce: 'tacit-btc-pool-zk-eddsa-nonce-v1',
  exitBjj: 'tacit-btc-pool-zk-exit-bjj-v1',
  exitSecp: 'tacit-btc-pool-zk-exit-secp-v1',
});

const bytesToBig = (b) => { let x = 0n; for (const c of b) x = (x << 8n) | BigInt(c); return x; };
export function be32(x) {
  const out = new Uint8Array(32);
  let v = BigInt(x);
  if (v < 0n || v >= (1n << 256n)) throw new Error('btc-pool-zk: value does not fit 32 bytes');
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
const asBytes = (x) => (typeof x === 'string' ? te.encode(x) : x);
const sha = (...parts) => sha256(concatBytes(...parts.map(asBytes)));

function wide(tag, ...parts) {
  const m = concatBytes(asBytes(tag), ...parts.map(asBytes));
  return bytesToBig(concatBytes(sha(m, Uint8Array.of(0)), sha(m, Uint8Array.of(1))));
}
export function hsL(tag, ...parts) {
  const x = wide(tag, ...parts) % L_BJJ;
  if (x === 0n) throw new Error('btc-pool-zk: zero scalar');
  return x;
}
export function hsP(tag, ...parts) { return wide(tag, ...parts) % P_FR; }

// Projective twisted-Edwards arithmetic (add-2008-bbjlp, complete on BabyJub), one inversion per multiply.
const A_TE = 168700n, D_TE = 168696n;
const fm = (x) => { const r = x % P_FR; return r < 0n ? r + P_FR : r; };
function pAdd([X1, Y1, Z1], [X2, Y2, Z2]) {
  const A = fm(Z1 * Z2), B = fm(A * A), C = fm(X1 * X2), D = fm(Y1 * Y2);
  const E = fm(D_TE * C % P_FR * D), F = fm(B - E), G = fm(B + E);
  return [fm(A * F % P_FR * fm((X1 + Y1) * (X2 + Y2) - C - D)), fm(A * G % P_FR * fm(D - A_TE * C)), fm(F * G)];
}
function inv(x) {
  let [a, b, u, v] = [fm(x), P_FR, 1n, 0n];
  while (a !== 0n) { const q = b / a; [a, b] = [b - q * a, a]; [u, v] = [v - q * u, u]; }
  return fm(v);
}
const toAffine = ([X, Y, Z]) => { const zi = inv(Z); return [fm(X * zi), fm(Y * zi)]; };
// k·P for an affine curve point P and k ≥ 0.
export function mulPoint(P, k) {
  let e = BigInt(k);
  if (e < 0n) throw new Error('btc-pool-zk: negative scalar');
  let r = [0n, 1n, 1n], acc = [P[0], P[1], 1n];
  while (e > 0n) {
    if (e & 1n) r = pAdd(r, acc);
    acc = pAdd(acc, acc);
    e >>= 1n;
  }
  return toAffine(r);
}
const B8_TABLE = (() => { const t = [[BASE8[0], BASE8[1], 1n]]; for (let i = 1; i < 253; i++) t.push(pAdd(t[i - 1], t[i - 1])); return t; })();
export const mulB8 = (k) => {
  let e = BigInt(k) % L_BJJ, r = [0n, 1n, 1n];
  for (let i = 0; e > 0n; i++, e >>= 1n) if (e & 1n) r = pAdd(r, B8_TABLE[i]);
  return toAffine(r);
};
export const assetField = (asset) => bytesToBig(sha(TAG.asset, checkLen(asset, 32, 'asset'))) % P_FR;
export const bodyHash = (body) => bytesToBig(sha(TAG.body, body)) % P_FR;
export { P_FR };

function checkLen(b, n, name) {
  if (!(b instanceof Uint8Array) || b.length !== n) throw new Error(`btc-pool-zk: ${name} must be ${n} bytes`);
  return b;
}
function checkU64(v, name) {
  const x = BigInt(v);
  if (x < 0n || x >= U64) throw new Error(`btc-pool-zk: ${name} must be a u64`);
  return x;
}

export function makeBtcPoolZk({ poseidon }) {
  if (typeof poseidon !== 'function') throw new Error('btc-pool-zk: poseidon(inputs[]) → bigint required');
  const H = (xs) => BigInt(poseidon(xs.map((x) => BigInt(x))));

  // ── keys ──
  function walletKeys(seed, network) {
    checkLen(seed, 32, 'seed');
    if (network !== 'mainnet' && network !== 'signet') throw new Error('btc-pool-zk: network');
    const a = hsL(TAG.spend, network, seed);
    const n = hsL(TAG.nk, network, seed);
    return { a, n, A: mulB8(a), N: mulB8(n) };
  }

  function noteTweaks(s) {
    checkLen(s, 33, 's');
    return { tA: hsL(TAG.authTweak, s), tN: hsL(TAG.nkTweak, s), rho: hsP(TAG.rho, s) };
  }

  const npkOf = (Ak, NK) => H([Ak[0], Ak[1], NK[0], NK[1]]);

  // Sender side: public keys of the recipient address and the shared secret.
  function outputKeys(A, N, s) {
    const { tA, tN, rho } = noteTweaks(s);
    const Ak = addPoint(A, mulB8(tA));
    const NK = addPoint(N, mulB8(tN));
    return { Ak, NK, npk: npkOf(Ak, NK), rho };
  }

  // Recipient side: the note's spend and nullifier scalars.
  function ownedKeys(wallet, s) {
    const { tA, tN, rho } = noteTweaks(s);
    const sk = (wallet.a + tA) % L_BJJ;
    const nk = (wallet.n + tN) % L_BJJ;
    if (sk === 0n || nk === 0n) throw new Error('btc-pool-zk: degenerate note key');
    const Ak = mulB8(sk);
    const NK = mulB8(nk);
    return { sk, nk, Ak, NK, npk: npkOf(Ak, NK), rho };
  }

  const leafOf = (assetF, v, npk, rho) => H([assetF, checkU64(v, 'v'), npk, rho]);

  function nullifier(nk, leaf, index) {
    const k = BigInt(nk);
    if (k < 0n || k >= L_BJJ) throw new Error('btc-pool-zk: nk_note must be canonical');
    const i = BigInt(index);
    if (i < 0n || i >= (1n << 32n)) throw new Error('btc-pool-zk: index must be < 2^32');
    return H([k, leaf, i]);
  }

  // ── tree ──
  const zeros = [0n];
  for (let i = 1; i <= ZK_TREE_DEPTH; i++) zeros.push(H([zeros[i - 1], zeros[i - 1]]));

  // Sparse append-only tree over `leaves` (array of field elements) at positions 0..len−1.
  function tree(leaves) {
    const layers = [leaves.map(BigInt)];
    for (let d = 0; d < ZK_TREE_DEPTH; d++) {
      const cur = layers[d];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        next.push(H([cur[i], i + 1 < cur.length ? cur[i + 1] : zeros[d]]));
      }
      layers.push(next);
    }
    const root = layers[ZK_TREE_DEPTH][0] ?? zeros[ZK_TREE_DEPTH];
    function path(index) {
      if (index < 0 || index >= leaves.length) throw new Error('btc-pool-zk: index out of range');
      const out = [];
      let i = index;
      for (let d = 0; d < ZK_TREE_DEPTH; d++) {
        const sib = i ^ 1;
        out.push(sib < layers[d].length ? layers[d][sib] : zeros[d]);
        i >>= 1;
      }
      return out;
    }
    return { root, path };
  }

  function rootFromPath(leaf, index, path) {
    let cur = BigInt(leaf);
    const idx = BigInt(index);
    for (let d = 0; d < ZK_TREE_DEPTH; d++) {
      cur = (idx >> BigInt(d)) & 1n ? H([path[d], cur]) : H([cur, path[d]]);
    }
    return cur;
  }

  // ── EdDSA-Poseidon ──
  function sign(sk, M) {
    const k = BigInt(sk) % L_BJJ;
    const m = BigInt(M);
    const A = mulB8(k);
    const r = hsL(TAG.nonce, be32(k), be32(m));
    const R8 = mulB8(r);
    const h = H([R8[0], R8[1], A[0], A[1], m]);
    const S = (r + 8n * h * k) % L_BJJ;
    return { R8, S };
  }

  function verify(A, M, { R8, S }) {
    if (BigInt(S) >= L_BJJ || !onCurve(A) || !onCurve(R8)) return false;
    const h = H([R8[0], R8[1], A[0], A[1], BigInt(M)]);
    return ptEq(mulB8(BigInt(S)), addPoint(R8, mulPoint(A, (8n * h) % (8n * L_BJJ))));
  }

  // ── witness ──
  // inputs[i]: { v, rho, nk, Ak, index, path, sig } for a real or zero-value note, or null for an empty slot.
  // outputs[k]: { v, npk, rho } or null. exit / dep: { v, r } or null.
  function buildWitness({ root, bodyHash: bh, assetF, inputs, outputs, exit = null, dep = null }) {
    if (inputs.length !== ZK_N_IN || outputs.length !== ZK_N_OUT) throw new Error('btc-pool-zk: arity');
    const dummyKey = 1n;
    const dummySig = sign(dummyKey, bh);
    const ins = inputs.map((x) => {
      if (!x) {
        return { v: 0n, rho: 0n, nk: 1n, Ak: mulB8(dummyKey), index: 0n, path: Array(ZK_TREE_DEPTH).fill(0n), sig: dummySig, nf: 0n };
      }
      const NK = mulB8(x.nk);
      const leaf = leafOf(assetF, x.v, npkOf(x.Ak, NK), x.rho);
      return { ...x, nf: nullifier(x.nk, leaf, x.index), leaf };
    });
    const outs = outputs.map((o) => (o ? { ...o, leaf: leafOf(assetF, o.v, o.npk, o.rho) } : { v: 0n, npk: 0n, rho: 0n, leaf: 0n }));
    const opening = (c, name) => {
      if (!c) return { v: 0n, r: 0n, C: ID };
      const v = checkU64(c.v, `${name}.v`);
      const r = BigInt(c.r);
      if (r <= 0n || r >= R_MAX || r >= L_BJJ) throw new Error(`btc-pool-zk: ${name}.r must be in (0, l)`);
      return { v, r, C: pedersenBJJ(v, r) };
    };
    const ex = opening(exit, 'exit');
    const dp = opening(dep, 'dep');
    const sumIn = ins.reduce((s, x) => s + BigInt(x.v), dp.v);
    const sumOut = outs.reduce((s, o) => s + BigInt(o.v), ex.v);
    if (sumIn !== sumOut) throw new Error('btc-pool-zk: value not conserved');

    const input = {
      root, bodyHash: bh, asset: assetF,
      nf: ins.map((x) => x.nf),
      outLeaf: outs.map((o) => o.leaf),
      exitC: ex.C, depC: dp.C,
      inV: ins.map((x) => x.v), inRho: ins.map((x) => x.rho), inNk: ins.map((x) => x.nk),
      inAk: ins.map((x) => x.Ak), inIndex: ins.map((x) => BigInt(x.index)), inPath: ins.map((x) => x.path),
      sigR8: ins.map((x) => x.sig.R8), sigS: ins.map((x) => x.sig.S),
      outV: outs.map((o) => o.v), outNpk: outs.map((o) => o.npk), outRho: outs.map((o) => o.rho),
      exitV: ex.v, exitR: ex.r, depV: dp.v, depR: dp.r,
    };
    return { input: stringify(input), publicSignals: publicSignals(input) };
  }

  return {
    H, walletKeys, noteTweaks, outputKeys, ownedKeys, npkOf, leafOf, nullifier, zeros, tree, rootFromPath,
    sign, verify, buildWitness,
  };
}

// Indexer rules outside the circuit: nullifiers in the field, non-zero ones pairwise distinct (the circuit
// allows the same note in both slots; distinctness is what stops it counting twice), and a spend with at
// least one non-empty input. A shield has none.
export function publicsAcceptable({ nf, shield = false }) {
  const xs = nf.map(BigInt);
  if (xs.some((x) => x < 0n || x >= P_FR)) return false;
  const live = xs.filter((x) => x !== 0n);
  if (new Set(live.map(String)).size !== live.length) return false;
  return shield ? live.length === 0 : live.length > 0;
}

// Public signal order of spend.circom: root, bodyHash, asset, nf[2], outLeaf[3], exitC[2], depC[2].
export function publicSignals({ root, bodyHash: bh, asset, nf, outLeaf, exitC, depC }) {
  return [root, bh, asset, ...nf, ...outLeaf, ...exitC, ...depC].map((x) => BigInt(x).toString());
}

// Public signals for an envelope as the indexer reads it: nullifiers and output leaves as on the wire, padded
// with 0 (empty slots); exitC / depC the boundary's BabyJub point, identity when absent. A shield passes
// root 0 and no nullifiers.
export function spendPublics({ root, body, asset, nullifiers = [], outLeaves = [], exitC = null, depC = null }) {
  if (nullifiers.length > ZK_N_IN || outLeaves.length > ZK_N_OUT) throw new Error('btc-pool-zk: arity');
  const pad = (xs, n) => [...xs.map(BigInt), ...Array(n - xs.length).fill(0n)];
  return publicSignals({
    root: BigInt(root), bodyHash: bodyHash(body), asset: assetField(asset),
    nf: pad(nullifiers, ZK_N_IN), outLeaf: pad(outLeaves, ZK_N_OUT), exitC: exitC || ID, depC: depC || ID,
  });
}

function stringify(x) {
  if (Array.isArray(x)) return x.map(stringify);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, stringify(v)]));
  return BigInt(x).toString();
}

// Packed BabyJub point (32 B, circomlib packPoint) ↔ public-signal pair.
export function commitmentSignals(packed) {
  const P = unpackPoint(checkLen(packed, 32, 'commitment'));
  if (!P) throw new Error('btc-pool-zk: commitment is not a subgroup point');
  return P;
}
export const packCommitment = packPoint;
export { pedersenBJJ, ID as BJJ_IDENTITY };
