// Worker-facing factory for the Bitcoin-side CrossOut consumer (Mode B reverse reflection, app glue).
// Wires the dependency-injected dapp/confidential-crossout-consumer.js to the deployment env: the KV
// (REGISTRY_KV → Postgres on Render, the default; CF KV is fallback), the Ethereum log reader + its
// RPC fallback list, and the CrossOutRecorded decoder. Mirrors the reflection attester's
// dependency-injected factory shape so it is testable + runtime-agnostic.
//
// Trust posture (Mode B): the worker is INDEXER/UX ONLY, never authoritative. The authority for a
// minted Bitcoin note is the reflection prover's recursive cross-out fold (the eth-reflection guest).
// scanOnce() records CrossOutRecorded as a liveness/UX accelerator; bindBitcoinOutput marks a hinted
// T_CROSSOUT_MINT 'minted' fast, but a note the worker hasn't bound is still 'pending-reflection' and
// becomes real when the reflection proof folds it. The worker cannot inflate or mislead — anyone
// re-derives from the reflected roots.
//
// INERT until a pool is deployed: CONFIDENTIAL_POOL_DEPLOYMENTS[network].pool is null today, so the
// factory returns null and the cron/dispatch are no-ops with zero hot-path cost.

import {
  makeCrossoutConsumer,
  makeEthGetLogs,
  CONFIDENTIAL_POOL_DEPLOYMENTS,
} from '../../dapp/confidential-crossout-consumer.js';
import { makeConfidentialEvmLog } from '../../dapp/confidential-evm-log.js';

// The Bitcoin pool note leaf = keccak(asset ‖ Cx ‖ Cy ‖ owner) — byte-identical to the dapp's
// confidential-pool `leaf` and the EVM guest leaf, so a T_CROSSOUT_MINT envelope's recomputed leaf
// matches the recorded destCommitment. No external deps (takes the @noble keccak256 as a param) so
// it resolves identically in the worker bundle and a node test.
const _b32 = (x) => {
  const h = String(x).replace(/^0x/, '').padStart(64, '0');
  const u = new Uint8Array(32);
  for (let i = 0; i < 32; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
  return u;
};
const _hex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
export function crossoutMintLeaf(keccak256, { assetId, cx, cy, owner }) {
  const c = new Uint8Array(128);
  c.set(_b32(assetId), 0); c.set(_b32(cx), 32); c.set(_b32(cy), 64); c.set(_b32(owner == null ? '0x0' : owner), 96);
  return _hex(keccak256(c));
}

// env.REGISTRY_KV — state persistence (required). `keccak256` = the worker's @noble keccak_256.
// `rpcsForNetwork(net) => string[]` — the per-network Ethereum RPC fallback list (the worker's
// _TETH_ETH_RPCS). `fetchFn` is injectable for tests (defaults to global fetch).
export function buildCrossoutConsumer(env, { network, keccak256, rpcsForNetwork, fetchFn = fetch, confirmations = 36 }) {
  if (!env || !env.REGISTRY_KV) return null;
  const deployment = CONFIDENTIAL_POOL_DEPLOYMENTS[network];
  if (!deployment || !deployment.pool) return null; // not deployed → inert, no scan

  const kvGet = (k) => env.REGISTRY_KV.get(k);
  const kvPut = (k, v) => env.REGISTRY_KV.put(k, v);
  const ethGetLogs = makeEthGetLogs({ fetchFn, rpcsForNetwork });
  const evmLog = makeConfidentialEvmLog({ keccak256 });
  const consumer = makeCrossoutConsumer({ ethGetLogs, kvGet, kvPut, evmLog, confirmations });

  // Current Ethereum block height via eth_blockNumber over the RPC fallback list. Null on total
  // failure (the caller then does not scan — the cursor stays put, the range is retried next tick).
  async function ethTip() {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    for (const rpc of (rpcsForNetwork(network) || [])) {
      try {
        const r = await fetchFn(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && typeof j.result === 'string') return parseInt(j.result, 16);
      } catch {}
    }
    return null;
  }

  // One incremental scan of CrossOutRecorded logs from the stored cursor to (tip − confirmations).
  // No-op-safe: a null tip or RPC failure leaves the cursor unmoved so nothing is skipped.
  async function scanOnce() {
    const tipHeight = await ethTip();
    if (tipHeight == null) return { network, skipped: 'eth-tip-unavailable' };
    const fromBlock = await consumer.nextFromBlock(network, deployment.pool, deployment.deployBlock);
    return consumer.scan({ network, pool: deployment.pool, tipHeight, fromBlock });
  }

  return { consumer, deployment, scanOnce, ethTip };
}
