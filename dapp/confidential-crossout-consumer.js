// Bitcoin-side CrossOut consumer — PHASE 1: the read path.
//
// Scans the Ethereum ConfidentialPool for CrossOutRecorded(claimId, destChain, destCommitment, ν, asset)
// logs (emitted by a confidential-pool bridge_burn) and records each Bitcoin-destined crossOut — PAST A
// FINALITY GATE — under `crossout-recorded:{net}:{claimId}`, so the phase-2 bind+mint can honor it exactly
// once. Trusted-RPC + finality (mode A; see ops/PLAN-crossout-consumer.md). This is the mirror of the tETH
// deposit→mint flow's worker side, generalized to any asset and keyed by claimId instead of a deposit ν.
//
// Dependency-injected: the worker wires the real eth_getLogs (makeEthGetLogs) + its KV; node tests pass
// mocks + the real makeConfidentialEvmLog decoder. Nothing here touches the live indexer until a pool
// address is set in CONFIDENTIAL_POOL_DEPLOYMENTS and the worker calls scan() from its cron.

// ConfidentialPool deployment registry — GATED (pool:null until deployed; the worker skips the scan while
// null). Mirrors the dapp CROSSLANE_DEPLOYMENTS / the worker TETH_GENERATIONS.
export const CONFIDENTIAL_POOL_DEPLOYMENTS = {
  signet:  { pool: null, deployBlock: 0 },
  mainnet: { pool: null, deployBlock: 0 },
};

export function makeCrossoutConsumer({ ethGetLogs, kvGet, kvPut, evmLog, confirmations = 36, maxRange = 5000 }) {
  const DEST_BITCOIN = 1; // destChain selector (1=bitcoin, 2=ethereum) — only Bitcoin-destined crossOuts mint a Bitcoin note
  const TOPIC0 = evmLog.TOPIC0.CrossOutRecorded;
  const lc = (h) => String(h).toLowerCase();
  const recKey = (net, claimId) => `crossout-recorded:${net}:${lc(claimId)}`;
  const cursorKey = (net, pool) => `crossout-scan-cursor:${net}:${lc(pool)}`;

  // Scan [fromBlock, min(tip − confirmations, fromBlock + maxRange − 1)] for Bitcoin-destined
  // CrossOutRecorded and record each unseen claimId. The cursor advances ONLY on a successful read; an
  // RPC failure (ethGetLogs → null) is a no-op that leaves the cursor put, so the same range is retried —
  // a skipped range would strand a user's burned value (the tETH "never skip on RPC failure" invariant).
  async function scan({ network, pool, tipHeight, fromBlock }) {
    const base = { network, pool: lc(pool), fromBlock };
    const safeTip = tipHeight - confirmations;
    if (!(safeTip >= fromBlock)) {
      return { ...base, toBlock: fromBlock - 1, scanned: 0, recorded: 0, advancedCursorTo: null, reason: 'nothing-final-yet' };
    }
    const toBlock = Math.min(safeTip, fromBlock + maxRange - 1);
    const logs = await ethGetLogs(network, pool, fromBlock, toBlock, TOPIC0);
    if (logs == null) {
      return { ...base, toBlock, scanned: 0, recorded: 0, advancedCursorTo: null, rpcFailed: true };
    }
    let recorded = 0;
    for (const log of logs) {
      const ev = evmLog.decodeLog(log);
      if (!ev || ev.type !== 'CrossOutRecorded' || ev.destChain !== DEST_BITCOIN) continue;
      const key = recKey(network, ev.claimId);
      if (await kvGet(key)) continue; // dedup — already recorded
      await kvPut(key, JSON.stringify({
        claimId: lc(ev.claimId), destCommitment: ev.destCommitment, nullifier: ev.nullifier,
        assetId: ev.assetId, blockNumber: Number(log.blockNumber ?? 0), pool: lc(pool),
        network, status: 'recorded',
      }));
      recorded++;
    }
    await kvPut(cursorKey(network, pool), String(toBlock + 1));
    return { ...base, toBlock, scanned: logs.length, recorded, advancedCursorTo: toBlock + 1 };
  }

  // Next fromBlock for an incremental scan: the stored cursor, else the pool's deployBlock.
  async function nextFromBlock(network, pool, deployBlock) {
    const c = await kvGet(cursorKey(network, pool));
    return c != null ? Number(c) : Number(deployBlock || 0);
  }

  // Phase-2 lookup: a recorded crossOut by claimId (null if unseen / not yet final).
  async function getRecorded(network, claimId) {
    const v = await kvGet(recKey(network, claimId));
    return v ? JSON.parse(v) : null;
  }

  // Phase 2 — bind + gate. A Bitcoin T_CXFER output that carries a recorded crossOut's claimId is a
  // cross-lane MINT: bind it iff the recorded destCommitment matches the broadcast output leaf, then
  // CONSUME the claimId (one-mint-per-claimId — the bridgeMinted mirror; a replay sees 'consumed' and is
  // rejected). Anyone may broadcast/trigger the mint, but only the rightful owner can spend the minted
  // note (its blinding is the burn output's secret) and the value is fixed (destCommitment carried
  // verbatim), so the open trigger is safe. The caller indexes the Bitcoin note only on { bound:true }.
  async function bindBitcoinOutput({ network, claimId, outputLeaf }) {
    const rec = await getRecorded(network, claimId);
    if (!rec) return { bound: false, reason: 'no-recorded-crossout' };          // unknown or not yet final
    if (lc(rec.destCommitment) !== lc(outputLeaf)) return { bound: false, rejected: 'dest-mismatch' };
    if (rec.status === 'consumed') return { bound: false, rejected: 'already-consumed' };
    rec.status = 'consumed';
    await kvPut(recKey(network, claimId), JSON.stringify(rec));
    return { bound: true, claimId: lc(claimId), record: rec };
  }

  return { scan, nextFromBlock, getRecorded, bindBitcoinOutput, recKey, cursorKey, DEST_BITCOIN, TOPIC0 };
}

// The eth_getLogs reader the worker wires — fetch + the per-network RPC fallback list (the worker passes
// its _TETH_ETH_RPCS). Returns the decoded-ready raw logs, or null on total RPC failure (the caller must
// then NOT advance the cursor). Mirror of the worker's _ethCall fallback loop.
export function makeEthGetLogs({ fetchFn, rpcsForNetwork, timeoutMs = 8000 }) {
  const hexBlock = (n) => '0x' + Number(n).toString(16);
  return async function ethGetLogs(network, address, fromBlock, toBlock, topic0) {
    const params = [{ address, fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock), topics: [topic0] }];
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params });
    for (const rpc of (rpcsForNetwork(network) || [])) {
      try {
        const r = await fetchFn(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.result)) {
          return j.result.map((l) => ({ topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber) }));
        }
      } catch {}
    }
    return null;
  };
}
