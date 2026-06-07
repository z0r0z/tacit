// Bitcoin-root relay for bridge_mint (BTC → ETH). The relay is the trust root for
// cross-chain minting: it attests canonical, confirmed Bitcoin confidential-pool
// roots to ConfidentialPool.attestBitcoinRoot, so the guest's membership proof is
// against a root Ethereum trusts (the inflation-critical gate). Mirrors the live
// tETH SP1PoolRootVerifier relaying Bitcoin pool state onto Ethereum.
//
// Pilot model: a trusted operator runs the indexer, computes the Bitcoin
// confidential-pool root once it is buried ≥ K confirmations, and sends the
// attestation. This module is the operator's toolkit: compute the root (same
// keccak tree as the pool + the guest) and build the signed attestBitcoinRoot tx
// (reusing the Tacit-seed EVM signer — no MetaMask). The trustless model (an SP1
// proof of the root from Bitcoin headers, attested on-proof) reuses the same
// calldata; see ops/PLAN-confidential-btc-relay.md.
//
// Deps injected for Node + browser: { secp, keccak256, sha256 }.

import { makeConfidentialPool } from './confidential-pool.js';
import { makeEvmTx } from './evm-tx.js';

export function makeBtcRelay({ secp, keccak256, sha256 }) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const evmtx = makeEvmTx({ secp, keccak256 });
  const enc = new TextEncoder();
  const SELECTOR = '0x' + Buffer.from(keccak256(enc.encode('attestBitcoinRoot(bytes32)'))).slice(0, 4).toString('hex');

  // The canonical Bitcoin confidential-pool root from its leaves (slot order) —
  // the same keccak incremental Merkle the pool + guest use, so the root the relay
  // attests is exactly the one a bridge_mint proves membership against.
  function computeRoot(leaves) {
    const tree = new pool.Tree();
    for (const lf of leaves) tree.insert(lf);
    return tree.root();
  }

  // ABI calldata for attestBitcoinRoot(bytes32 root).
  function attestCalldata(root) {
    return SELECTOR + String(root).replace(/^0x/, '').padStart(64, '0');
  }

  // Build a signed EIP-1559 attestBitcoinRoot tx from the operator key. `fees` =
  // { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit }; `to` = the
  // ConfidentialPool address. Returns { raw, hash } ready to broadcast.
  function buildAttestTx(operatorPriv, poolAddress, root, fees) {
    return evmtx.signEip1559({
      chainId: fees.chainId,
      nonce: fees.nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit: fees.gasLimit,
      to: poolAddress,
      value: 0n,
      data: attestCalldata(root),
    }, operatorPriv);
  }

  return { computeRoot, attestCalldata, buildAttestTx, SELECTOR };
}
