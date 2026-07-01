// Bitcoin-state relay for the confidential pool (BTC → ETH). The relay carries
// Bitcoin confidential-pool STATE onto Ethereum: the note-tree root (so a
// bridge_mint can prove membership against a root Ethereum trusts) AND the
// spent-nullifier IMT root (the cross-lane non-membership freshness root that the
// cross-lane gate pins). Mirrors the live tETH SP1PoolRootVerifier.
//
// Trust model: NO trusted oracle. The only attestation path is
// ConfidentialPool.attestBitcoinStateProven(publicValues, proofBytes), which
// verifies an SP1 reflection proof against BITCOIN_RELAY_VKEY. This module is the
// relayer's submission toolkit — it does NOT mint trust; it relays a proof anyone
// can produce. The reflection prover (a sibling of the bridge_mint guest, reusing
// cxfer-core::bitcoin + the IMT) emits the publicValues + proof; this builds and
// signs the attest tx from a Tacit seed (no MetaMask). See
// ops/PLAN-confidential-btc-relay.md and ops/PLAN-confidential-cross-chain.md §9.
//
// SAFETY INVARIANT (matches the contract): the reflected spent-set root is NEVER
// zero. An empty Bitcoin spent set has a non-zero empty-IMT sentinel root; a zero
// root would re-open the cross-lane bypass (the guest skips its non-membership
// check when bitcoin_spent_root == 0), so the contract rejects it on attest and on
// any Bitcoin-homed settle — and so does encodeRelayPublicValues() below.
//
// Deps injected for Node + browser: { secp, keccak256, sha256 }.

import { makeConfidentialPool } from './confidential-pool.js';
import { makeEvmTx } from './evm-tx.js';

export function makeBtcRelay({ secp, keccak256, sha256 }) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const evmtx = makeEvmTx({ secp, keccak256 });
  const enc = new TextEncoder();
  // ConfidentialPool.attestBitcoinStateProven(bytes publicValues, bytes proofBytes)
  const SELECTOR = '0x' + Array.from(keccak256(enc.encode('attestBitcoinStateProven(bytes,bytes)')).slice(0, 4), (x) => x.toString(16).padStart(2, ''+'0')).join('');
  const ZERO32 = '0x' + '00'.repeat(32);

  const strip = (h) => String(h).replace(/^0x/, '');
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const padR = (h) => { const r = h.length % 64; return r ? h + '0'.repeat(64 - r) : h; };
  // ABI tail for a dynamic `bytes`: 32-byte length word + right-padded data.
  const abiBytes = (h) => word(strip(h).length / 2) + padR(strip(h));

  // The canonical Bitcoin confidential-pool note-tree root from its leaves (slot
  // order) — the same keccak incremental Merkle the pool + guest use, so the root
  // the relay carries is exactly the one a bridge_mint proves membership against.
  // (Operator cross-check; the reflection proof is the authority.)
  function computeRoot(leaves) {
    const tree = new pool.Tree();
    for (const lf of leaves) tree.insert(lf);
    return tree.root();
  }

  // The Bitcoin spent-set IMT root from its sorted low-nullifier links — the operator's
  // cross-check of the reflection proof's bitcoinSpentRoot. `emptySpentRoot` is the
  // non-zero sentinel the set is seeded to (and never goes below); both mirror
  // cxfer-core::imt_root / imt_empty_root.
  const computeSpentRoot = (links) => pool.imtRoot(links);
  const emptySpentRoot = () => pool.imtEmptyRoot();

  // Encode BitcoinRelayPublicValues{ bytes32 bitcoinPoolRoot; bytes32 bitcoinSpentRoot;
  // uint64 bitcoinHeight } exactly as ConfidentialPool.abi.decode expects (a struct of
  // static fields → three inline 32-byte words, no offset). The reflection prover emits
  // these bytes as its committed public values; this helper builds/verifies the layout.
  function encodeRelayPublicValues({ poolRoot, spentRoot, height }) {
    if (!spentRoot || strip(spentRoot).toLowerCase() === strip(ZERO32)) {
      throw new Error('spentRoot must be the non-zero empty-IMT sentinel, never 0 (cross-lane invariant)');
    }
    return '0x' + strip(poolRoot).padStart(64, '0') + strip(spentRoot).padStart(64, '0') + word(height);
  }

  function decodeRelayPublicValues(pv) {
    const h = strip(pv);
    return {
      poolRoot: '0x' + h.slice(0, 64),
      spentRoot: '0x' + h.slice(64, 128),
      height: BigInt('0x' + h.slice(128, 192)),
    };
  }

  // ABI calldata for attestBitcoinStateProven(bytes publicValues, bytes proofBytes):
  // selector ‖ offset(pv)=0x40 ‖ offset(proof) ‖ tail(pv) ‖ tail(proof).
  function attestCalldata(publicValues, proofBytes) {
    const pvTail = abiBytes(publicValues);
    const offB = 0x40 + pvTail.length / 2;
    return SELECTOR + word(0x40) + word(offB) + pvTail + abiBytes(proofBytes);
  }

  // Build a signed EIP-1559 attestBitcoinStateProven tx from the operator key.
  // `fees` = { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit };
  // `to` = the ConfidentialPool address. Returns { raw, hash } ready to broadcast.
  function buildAttestTx(operatorPriv, poolAddress, publicValues, proofBytes, fees) {
    return evmtx.signEip1559({
      chainId: fees.chainId,
      nonce: fees.nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit: fees.gasLimit,
      to: poolAddress,
      value: 0n,
      data: attestCalldata(publicValues, proofBytes),
    }, operatorPriv);
  }

  return { computeRoot, computeSpentRoot, emptySpentRoot, encodeRelayPublicValues, decodeRelayPublicValues, attestCalldata, buildAttestTx, SELECTOR };
}
