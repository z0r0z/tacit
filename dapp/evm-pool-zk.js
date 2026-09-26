// EVM shielded pool: witness and public signals for dapp/circuits/evm-pool/transact.circom, and the values the
// pool contract (contracts/src/TacitEvmPool.sol) derives on-chain. Keys, notes, nullifiers and EdDSA are
// the Bitcoin pool's (./btc-pool-zk.js); only values widen to 120 bits and the asset is the pool's own field.
//
//   asset        = keccak256(abi.encode(chainId, pool, token)) mod p
//   extDataHash  = keccak256(abi.encode(chainId, pool, recipient, extAmount, relayer, fee,
//                                       keccak256(memo0), keccak256(memo1))) mod p
//   publicAmount = extAmount − fee mod p
//   M            = Poseidon(asset, nf0, nf1, outLeaf0, outLeaf1, publicAmount, extDataHash)

import { keccak_256, concatBytes } from './vendor/tacit-deps.min.js';
import { makeBtcPoolZk, mulB8, L_BJJ, P_FR, be32 } from './btc-pool-zk.js';

export const EVM_TREE_DEPTH = 32;
export const EVM_N_IN = 2;
export const EVM_N_OUT = 2;
export const EVM_VALUE_BITS = 120n;
const VMAX = 1n << EVM_VALUE_BITS;
const U256 = 1n << 256n;

const bytesToBig = (b) => { let x = 0n; for (const c of b) x = (x << 8n) | BigInt(c); return x; };
const hexToBytes = (h) => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2) throw new Error('evm-pool-zk: odd hex');
  return Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16));
};
const word = (x) => be32(((BigInt(x) % U256) + U256) % U256);
const addr = (a) => {
  const b = hexToBytes(a);
  if (b.length !== 20) throw new Error('evm-pool-zk: address must be 20 bytes');
  return word(bytesToBig(b));
};
const randomBig = (n) => bytesToBig(crypto.getRandomValues(new Uint8Array(n)));
const keccakField = (...words) => bytesToBig(keccak_256(concatBytes(...words))) % P_FR;
const memoHash = (m) => keccak_256(typeof m === 'string' ? hexToBytes(m) : m);

export function poolAsset({ chainId, pool, token }) {
  return keccakField(word(chainId), addr(pool), addr(token));
}

export function extDataHash({ chainId, pool, recipient, extAmount, relayer, fee, memo0 = new Uint8Array(), memo1 = new Uint8Array() }) {
  const ext = BigInt(extAmount);
  if (ext <= -VMAX || ext >= VMAX) throw new Error('evm-pool-zk: extAmount out of range');
  if (BigInt(fee) < 0n || BigInt(fee) >= VMAX) throw new Error('evm-pool-zk: fee out of range');
  return keccakField(word(chainId), addr(pool), addr(recipient), word(ext), addr(relayer), word(fee),
    memoHash(memo0), memoHash(memo1));
}

export const publicAmount = (extAmount, fee) => ((BigInt(extAmount) - BigInt(fee)) % P_FR + P_FR) % P_FR;

// Public signal order of transact.circom.
export function publicSignals({ root, oldRoot, newRoot, startIndex, publicAmount: pa, extDataHash: eh, asset, nf, outLeaf }) {
  return [root, oldRoot, newRoot, startIndex, pa, eh, asset, ...nf, ...outLeaf].map((x) => BigInt(x).toString());
}

export function makeEvmPoolZk({ poseidon }) {
  const base = makeBtcPoolZk({ poseidon });
  const { H, npkOf, nullifier, zeros, sign } = base;

  const checkV = (v, name) => {
    const x = BigInt(v);
    if (x < 0n || x >= VMAX) throw new Error(`evm-pool-zk: ${name} must be < 2^120`);
    return x;
  };
  const leafOf = (asset, v, npk, rho) => H([asset, checkV(v, 'v'), npk, rho]);

  // Append-only tree over `leaves` (field elements at 0..len−1), empty leaf 0.
  function tree(leaves) {
    const layers = [leaves.map(BigInt)];
    for (let d = 0; d < EVM_TREE_DEPTH; d++) {
      const cur = layers[d];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) next.push(H([cur[i], i + 1 < cur.length ? cur[i + 1] : zeros[d]]));
      layers.push(next);
    }
    const root = layers[EVM_TREE_DEPTH][0] ?? zeros[EVM_TREE_DEPTH];
    // Siblings of node `index` at `level`, up to the root.
    const siblings = (level, index) => {
      const out = [];
      let i = index;
      for (let d = level; d < EVM_TREE_DEPTH; d++) {
        const sib = i ^ 1;
        out.push(sib < layers[d].length ? layers[d][sib] : zeros[d]);
        i >>= 1;
      }
      return out;
    };
    const path = (index) => {
      if (index < 0 || index >= leaves.length) throw new Error('evm-pool-zk: index out of range');
      return siblings(0, index);
    };
    return { root, path, siblings, size: leaves.length };
  }

  // Root after appending `pair` at leaves start, start + 1 of a tree whose level-1 siblings are `insPath`.
  function insert(pair, start, insPath) {
    let cur = H([BigInt(pair[0]), BigInt(pair[1])]);
    let i = BigInt(start) >> 1n;
    for (let d = 0; d < EVM_TREE_DEPTH - 1; d++) {
      cur = (i >> BigInt(d)) & 1n ? H([insPath[d], cur]) : H([cur, insPath[d]]);
    }
    return cur;
  }

  const message = ({ asset, nf, outLeaf, publicAmount: pa, extDataHash: eh }) =>
    H([asset, ...nf, ...outLeaf, pa, eh]);

  // leaves: the pool's inserted leaves in order; membership is proven against their root. inputs[i]:
  // { v, rho, nk, sk, index } for an owned note, { dummy: true } for a zero-value filler with fresh random keys
  // (so its nullifier is unique and unlinkable), or null for an empty slot. outputs[k]: { v, npk, rho } or null.
  // With both outputs null the proof inserts nothing.
  function buildWitness({ asset, leaves, inputs, outputs, extAmount, fee, extDataHash: eh }) {
    if (inputs.length !== EVM_N_IN || outputs.length !== EVM_N_OUT) throw new Error('evm-pool-zk: arity');
    const t = tree(leaves);
    if (t.size % 2) throw new Error('evm-pool-zk: pool size must be even');
    const pa = publicAmount(extAmount, fee);

    const ins = inputs.map((x) => {
      if (!x) return { empty: true, v: 0n, rho: 0n, nk: 1n, sk: 1n, index: 0n, path: Array(EVM_TREE_DEPTH).fill(0n), nf: 0n };
      if (x.dummy) {
        const sk = 1n + (randomBig(64) % (L_BJJ - 1n));
        const nk = 1n + (randomBig(64) % (L_BJJ - 1n));
        const rho = randomBig(64) % P_FR;
        const index = randomBig(4);
        const leaf = leafOf(asset, 0n, npkOf(mulB8(sk), mulB8(nk)), rho);
        return { v: 0n, rho, nk, sk, index, path: Array(EVM_TREE_DEPTH).fill(0n), leaf, nf: nullifier(nk, leaf, index) };
      }
      const NK = mulB8(x.nk);
      const leaf = leafOf(asset, x.v, npkOf(mulB8(x.sk), NK), x.rho);
      if (BigInt(leaves[Number(x.index)] ?? -1n) !== leaf) throw new Error('evm-pool-zk: input is not the leaf at its index');
      return { ...x, v: BigInt(x.v), leaf, path: t.path(Number(x.index)), nf: nullifier(x.nk, leaf, x.index) };
    });
    const outs = outputs.map((o) => (o ? { v: checkV(o.v, 'out.v'), npk: BigInt(o.npk), rho: BigInt(o.rho), leaf: leafOf(asset, o.v, o.npk, o.rho) }
      : { v: 0n, npk: 0n, rho: 0n, leaf: 0n }));

    const sumIn = ins.reduce((s, x) => s + x.v, 0n) + BigInt(extAmount) - BigInt(fee);
    const sumOut = outs.reduce((s, o) => s + o.v, 0n);
    if (sumIn !== sumOut) throw new Error('evm-pool-zk: value not conserved');
    const live = ins.filter((x) => x.nf !== 0n).map((x) => x.nf);
    if (new Set(live.map(String)).size !== live.length) throw new Error('evm-pool-zk: duplicate nullifier');

    const nf = ins.map((x) => x.nf);
    const outLeaf = outs.map((o) => o.leaf);
    const M = message({ asset, nf, outLeaf, publicAmount: pa, extDataHash: eh });
    const sigs = ins.map((x) => sign(x.sk, M));

    const start = BigInt(t.size);
    const insPath = t.siblings(1, t.size >> 1);
    const newRoot = insert(outLeaf, start, insPath);

    const input = {
      root: t.root, oldRoot: t.root, newRoot, startIndex: start, publicAmount: pa, extDataHash: eh, asset,
      nf, outLeaf,
      inV: ins.map((x) => x.v), inRho: ins.map((x) => BigInt(x.rho)), inNk: ins.map((x) => BigInt(x.nk)),
      inAk: ins.map((x) => mulB8(x.sk)), inIndex: ins.map((x) => BigInt(x.index)), inPath: ins.map((x) => x.path),
      sigR8: sigs.map((s) => s.R8), sigS: sigs.map((s) => s.S),
      outV: outs.map((o) => o.v), outNpk: outs.map((o) => o.npk), outRho: outs.map((o) => o.rho),
      insPath,
    };
    return { input: stringify(input), publicSignals: publicSignals(input), newRoot, nf, outLeaf };
  }

  return { ...base, leafOf, tree, insert, message, buildWitness };
}

function stringify(x) {
  if (Array.isArray(x)) return x.map(stringify);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, stringify(v)]));
  return BigInt(x).toString();
}
