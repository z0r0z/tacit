// Off-chain SP1 Groth16 verification for the Bitcoin-native shielded pool (DESIGN-btc-shielded-pool.md).
//
// This pool has no EVM contract of its own — the whole design point is staying entirely on Bitcoin — so it
// can't reuse ConfidentialPool.sol's on-chain `SP1_VERIFIER.verifyProof(...)` call the way settle/reflection
// do. But that verifier is itself just a deployed, immutable, stateless Groth16 leaf
// (docs/DEPLOYMENTS.md: "SP1 verifier (immutable Groth16 leaf)", 0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2)
// that Tacit's live pool already trusts for every settle and reflection proof — its `verifyProof` is `view`
// and simply reverts on an invalid proof rather than returning a bool, so calling it is a free, read-only
// `eth_call`, not a transaction: no gas, no new trust assumption, no contract of our own needed. This module
// makes that call directly.
//
// The public inputs a Groth16 proof of the btc-pool-prover guest verifies against are the ABI-encoded
// `BtcPoolSpendValues` struct the guest commits (src/btc_pool.rs, alloy `sol!` macro) — that struct isn't
// carried on the wire in T_BTC_SPEND's envelope (§3's byte layout is the raw fields, not a serialized
// struct), so the caller reconstructs it field-by-field from the envelope/replay state before calling
// `verifyProof`. Reconstructing it independently, rather than trusting a value the prover hands back, is
// what makes this a real check: if the encoding here doesn't match the guest's, a genuinely valid proof
// just fails to verify (safe, a liveness bug) — it can never make an invalid proof appear to pass.

import { encodeAbiParameters, encodeFunctionData } from 'viem';
import { publicClient } from './chain.js';

// docs/DEPLOYMENTS.md "SP1 verifier (immutable Groth16 leaf)" — the same immutable, non-upgradeable
// verifier ConfidentialPool.sol already hard-wires. Not configurable: pinning any other address here would
// mean trusting something the rest of this protocol doesn't already trust.
export const SP1_VERIFIER_ADDRESS = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';

// contracts/sp1/confidential/elf-vkey-pin.json:btc_pool_vkey — the cargo-prove-derived verifying key for
// the committed elf/btc-pool-prover. Update this alongside that pin file if the guest is ever rebuilt.
export const BTC_POOL_VKEY = '0x00c1dcd867bb0877d23400b1059db31f144daedb9452c9bd6f0b56fc35babd66';

const VERIFY_PROOF_ABI = [{
  type: 'function',
  name: 'verifyProof',
  stateMutability: 'view',
  inputs: [
    { name: 'programVKey', type: 'bytes32' },
    { name: 'publicValues', type: 'bytes' },
    { name: 'proofBytes', type: 'bytes' },
  ],
  outputs: [],
}];

// Mirrors contracts/sp1/confidential/src/btc_pool.rs's `sol! { struct BtcPoolNote { ... } }` field-for-field
// (name, order, and type) — this is the ONE place that mapping must stay exact, so any change to the Rust
// struct needs the matching change here in the same commit.
const BTC_POOL_NOTE_COMPONENTS = [
  { name: 'cx', type: 'bytes32' },
  { name: 'cy', type: 'bytes32' },
  { name: 'pkEph', type: 'bytes32' },
  { name: 'spendKey', type: 'bytes32' },
  { name: 'ctNote', type: 'bytes' },
];

// Mirrors `sol! { struct BtcPoolSpendValues { ... } }` field-for-field. `version` is the guest's own
// `PV_VERSION` constant (currently 1) — not derived from anything in the envelope, just the struct's own
// schema version, so a future guest change that alters this struct's shape can be told apart from one
// that doesn't.
const BTC_POOL_SPEND_VALUES_PARAM = {
  type: 'tuple',
  components: [
    { name: 'version', type: 'uint16' },
    { name: 'asset', type: 'bytes32' },
    { name: 'root', type: 'bytes32' },
    { name: 'hAnchor', type: 'uint32' },
    { name: 'outKind', type: 'uint8' },
    { name: 'nullifiers', type: 'bytes32[]' },
    { name: 'outputs', type: 'tuple[]', components: BTC_POOL_NOTE_COMPONENTS },
    { name: 'hasExitVout', type: 'bool' },
    { name: 'exitVout', type: 'uint32' },
    { name: 'exitValue', type: 'uint64' },
    { name: 'destSpkHash', type: 'bytes32' },
  ],
};

/**
 * ABI-encodes a BtcPoolSpendValues statement exactly as the guest's `sol!`-generated `.abi_encode()` would
 * (Alloy encodes a single struct argument as one ABI tuple parameter, which is exactly what
 * `encodeAbiParameters([tupleType], [values])` produces — same encoding, different toolchains).
 *
 * `statement` shape: { version?: number (defaults 1), asset, root: 32-byte hex, hAnchor: number,
 * outKind: 0|1, nullifiers: hex[], outputs: [{cx,cy,pkEph,spendKey,ctNote}] (hex fields, ctNote a hex
 * byte string), hasExitVout: boolean, exitVout: number, exitValue: bigint|number, destSpkHash: hex }.
 */
export function encodeBtcPoolSpendPublicValues(statement) {
  const s = statement;
  const values = {
    version: s.version ?? 1,
    asset: s.asset,
    root: s.root,
    hAnchor: s.hAnchor,
    outKind: s.outKind,
    nullifiers: s.nullifiers ?? [],
    outputs: (s.outputs ?? []).map((o) => ({ cx: o.cx, cy: o.cy, pkEph: o.pkEph, spendKey: o.spendKey, ctNote: o.ctNote })),
    hasExitVout: !!s.hasExitVout,
    exitVout: s.exitVout ?? 0,
    exitValue: BigInt(s.exitValue ?? 0),
    destSpkHash: s.destSpkHash ?? ('0x' + '00'.repeat(32)),
  };
  return encodeAbiParameters([BTC_POOL_SPEND_VALUES_PARAM], [values]);
}

/**
 * Real off-chain Groth16 verification via a free `eth_call` against the live, immutable SP1 verifier —
 * `verifyProof` is `view` and simply doesn't revert on success (it has no return value to check), so "the
 * call didn't throw" IS the pass signal; any revert (wrong proof, wrong public values, malformed bytes)
 * is a reject.
 *
 * Fails closed on ambiguity: a network/RPC failure is NOT treated as "invalid proof" (that would let a
 * flaky endpoint silently reject real spends) — it re-throws, so the caller can retry, distinct from a
 * genuine on-chain revert (proof/statement actually invalid), which resolves to `false`.
 */
export async function verifyBtcPoolSpendProof(statement, proofHex, { client = publicClient, vkey = BTC_POOL_VKEY } = {}) {
  const publicValues = encodeBtcPoolSpendPublicValues(statement);
  try {
    await client.call({
      to: SP1_VERIFIER_ADDRESS,
      data: encodeFunctionData({ abi: VERIFY_PROOF_ABI, functionName: 'verifyProof', args: [vkey, publicValues, proofHex] }),
    });
    return true;
  } catch (err) {
    if (isOnChainRevert(err)) return false;
    throw err; // network/RPC failure — not a verdict, don't silently treat as reject
  }
}

// A revert from the verifier (invalid proof/statement) surfaces as a viem ContractFunctionExecutionError /
// CallExecutionError wrapping an RPC "execution reverted" — distinguish that from a genuine transport
// failure (timeout, DNS, 5xx) by checking viem's own error shape rather than string-matching a message.
function isOnChainRevert(err) {
  // Prefer viem's own structured signal: a real `eth_call` revert surfaces as a
  // ContractFunctionExecutionError/CallExecutionError wrapping an RpcRequestError with `cause.data` set to
  // the revert data — that shape can't be produced by a transport failure. The regex fallback is a real
  // ambiguity (a proxy error page or a wrapped transport error could coincidentally contain the string
  // "execution reverted" without being one), so it only fires when the structured check doesn't, and even
  // then only paired with an error name viem actually uses for on-chain reverts.
  if (err?.cause?.data !== undefined) return true;
  const name = String(err?.name || err?.cause?.name || '');
  const looksLikeRevertError = /ContractFunctionExecutionError|ContractFunctionRevertedError|CallExecutionError/.test(name);
  return looksLikeRevertError && /execution reverted/i.test(String(err?.shortMessage || err?.message || ''));
}
