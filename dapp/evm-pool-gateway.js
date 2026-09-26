// Client side of contracts/src/TacitEvmPoolRouter.sol: deposit-box intents, the proof a keeper builds to complete
// one, and withdrawals whose recipient is a box or an exit-recipe escrow. Box and escrow addresses come from the
// contracts' own views (depositBoxOf / wrapBoxOf / escrowAddressFor), never computed here.
//
// A deposit intent fixes the amount, both output leaves and both memo hashes. Its hint (each output's v, npk,
// rho) is what a keeper needs to prove the deposit. It tells the keeper how the deposit splits across the two
// outputs, which the leaves hide; it cannot link later spends, which need the owner's nk. The keeper's fee is
// amount − Σ v.

import { keccak_256 } from './vendor/tacit-deps.min.js';
import { extDataHash, EVM_N_OUT, EVM_VALUE_BITS } from './evm-pool-zk.js';

const VALUE_MAX = 1n << EVM_VALUE_BITS;

const ZERO = '0x0000000000000000000000000000000000000000';
const toBytes = (m) => {
  if (typeof m !== 'string') return m ?? new Uint8Array();
  const s = m.replace(/^0x/, '');
  if (s.length % 2) throw new Error('evm-pool-gateway: odd hex');
  return Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16));
};
const hex32 = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// outputs: up to two { v, npk, rho } (null for an empty slot). Returns the on-chain intent and the keeper hint.
export function depositIntent(zk, { asset, amount, outputs, memo0 = new Uint8Array(), memo1 = new Uint8Array(), refund, deadline, nonce = 0n }) {
  if (outputs.length > EVM_N_OUT) throw new Error('evm-pool-gateway: at most two outputs');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(refund)) || BigInt(refund) === 0n) throw new Error('evm-pool-gateway: a non-zero refund address is required to recover an unfinished box');
  if (BigInt(amount) <= 0n || BigInt(amount) >= VALUE_MAX) throw new Error('evm-pool-gateway: amount must be in (0, 2^120)');
  const outs = [...outputs, ...Array(EVM_N_OUT - outputs.length).fill(null)];
  const total = outs.reduce((s, o) => s + (o ? BigInt(o.v) : 0n), 0n);
  if (total > BigInt(amount)) throw new Error('evm-pool-gateway: outputs exceed the deposit');
  const leaves = outs.map((o) => (o ? zk.leafOf(asset, o.v, o.npk, o.rho) : 0n));
  const m0 = toBytes(memo0);
  const m1 = toBytes(memo1);
  return {
    intent: {
      amount: BigInt(amount), outLeaf0: leaves[0], outLeaf1: leaves[1],
      memo0Hash: hex32(keccak_256(m0)), memo1Hash: hex32(keccak_256(m1)),
      refund, deadline: BigInt(deadline), nonce: BigInt(nonce),
    },
    hint: { outputs: outs, fee: BigInt(amount) - total, memo0: m0, memo1: m1 },
  };
}

// The completing keeper's proof input: a deposit of exactly intent.amount into `leaves` (the pool's current
// leaves) that pays `relayer` the fee. Rebuild against fresh leaves if the pool moves before submission.
export function completionWitness(zk, { intent, hint, asset, leaves, chainId, pool, relayer }) {
  const eh = extDataHash({ chainId, pool, recipient: ZERO, extAmount: intent.amount, relayer, fee: hint.fee, memo0: hint.memo0, memo1: hint.memo1 });
  const w = zk.buildWitness({ asset, leaves, inputs: [null, null], outputs: hint.outputs, extAmount: intent.amount, fee: hint.fee, extDataHash: eh });
  if (w.outLeaf[0] !== BigInt(intent.outLeaf0) || w.outLeaf[1] !== BigInt(intent.outLeaf1)) throw new Error('evm-pool-gateway: hint does not match the intent');
  return { ...w, tx: { recipient: ZERO, extAmount: intent.amount, relayer, fee: hint.fee, memo0: hint.memo0, memo1: hint.memo1 } };
}

// A withdrawal of `amount` to `recipient` (a wrap box for withdrawToV1, an exit-recipe escrow, or any address),
// paying `fee` to `relayer`. inputs / change follow evm-pool-zk.js buildWitness; change is an optional output.
export function withdrawalWitness(zk, { asset, leaves, inputs, change = null, amount, recipient, relayer = ZERO, fee = 0n, memo0 = new Uint8Array(), memo1 = new Uint8Array(), chainId, pool }) {
  if (BigInt(fee) > 0n && BigInt(relayer) === 0n) throw new Error('evm-pool-gateway: a fee needs a relayer address');
  if (BigInt(recipient) === 0n) throw new Error('evm-pool-gateway: a withdrawal needs a recipient');
  const extAmount = -BigInt(amount);
  const m0 = toBytes(memo0);
  const m1 = toBytes(memo1);
  const eh = extDataHash({ chainId, pool, recipient, extAmount, relayer, fee, memo0: m0, memo1: m1 });
  const w = zk.buildWitness({ asset, leaves, inputs, outputs: [change, null], extAmount, fee, extDataHash: eh });
  return { ...w, tx: { recipient, extAmount, relayer, fee: BigInt(fee), memo0: m0, memo1: m1 } };
}
