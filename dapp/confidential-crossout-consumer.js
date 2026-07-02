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

// ConfidentialPool deployment registry — GATED (pool:null until deployed; the worker's buildCrossoutConsumer
// returns null while pool is null, so the cron scan + the /hint crossout endpoint + the dapp burn flow are
// no-ops with zero hot-path cost). Mirrors the dapp CROSSLANE_DEPLOYMENTS / the worker TETH_GENERATIONS.
// tools/sync-deployment-config.mjs sets pool (+ deployBlock) per network post-deploy from the DeployV1Suite
// manifest — that single edit un-gates the consumer; do NOT hardcode an address here. Keep both entries
// pool:null (NOT a placeholder address — a non-null placeholder is only HALF inert: it makes the factory
// return a live consumer that scans a nonexistent pool every cron tick; only null is fully no-op).
export const CONFIDENTIAL_POOL_DEPLOYMENTS = {
  // Keyed by the BITCOIN network bridged to; the address is the EVM ConfidentialPool the consumer scans for
  // CrossOutRecorded. Held inert pending the coordinated re-prove + pool redeploy (prior Sepolia validation
  // pools 0x3D38a004/0x991726A5/0xdcFccAf3 were retired). sync-deployment-config writes the real address.
  signet:  { pool: '0x000000003eD19c48531bd397F66800004F8A18c2', deployBlock: 11175726 },
  mainnet: { pool: '0x0000000000630fC2DDc169Bc1862683577e9D610', deployBlock: 25444513, headerRelay: '0x1677A5A3669a6D365431e916678566DAaa2e9094' },
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

// ── T_CROSSOUT_MINT envelope (the Bitcoin wire format the wallet broadcasts) ──
// After a bridge_burn the wallet knows the destination note (Cx, Cy, owner) and the claimId (from the
// CrossOutRecorded log), and broadcasts this 161-byte payload as a Taproot envelope (reuse the existing
// encodeEnvelopeScript + commit/reveal + postHint). The worker decodes it, recomputes the leaf
// keccak(asset‖Cx‖Cy‖owner), and binds it to the recorded crossOut (one-mint-per-claimId). No proof: the
// value was kernel-proven on Ethereum and the destCommitment is carried verbatim. Opcode 0x65 is free
// (the bridge family runs 0x60-0x64). Sits alongside T_BRIDGE_DEPOSIT in the worker opcode dispatch.
export const T_CROSSOUT_MINT = 0x65;

const _fromHex = (h) => {
  h = String(h).replace(/^0x/, '');
  if (h.length % 2) h = '0' + h;
  const u = new Uint8Array(h.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
  return u;
};
const _toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const _field32 = (h) => {
  const raw = _fromHex(h);
  if (raw.length > 32) throw new Error('crossout-mint: field over 32 bytes');
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length); // right-align (left-pad), matching bytes32
  return out;
};

export function encodeCrossoutMint({ assetId, claimId, cx, cy, owner }) {
  const out = new Uint8Array(161);
  out[0] = T_CROSSOUT_MINT;
  out.set(_field32(assetId), 1);
  out.set(_field32(claimId), 33);
  out.set(_field32(cx), 65);
  out.set(_field32(cy), 97);
  out.set(_field32(owner == null ? '0x0' : owner), 129);
  return out;
}

export function decodeCrossoutMint(payload) {
  const u = payload instanceof Uint8Array ? payload : _fromHex(payload);
  if (!u || u.length !== 161 || u[0] !== T_CROSSOUT_MINT) return null;
  const at = (i) => _toHex(u.subarray(i, i + 32));
  return { assetId: at(1), claimId: at(33), cx: at(65), cy: at(97), owner: at(129) };
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
