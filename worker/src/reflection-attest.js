// Worker-side reflection attestation (Phase 4.4 wiring). Maintains the canonical confidential-pool
// reflection state from the worker's confirmed-CXFER scan, and runs attestation cycles: assemble a
// prover batch → prove on the GPU box → submit ConfidentialPool.attestBitcoinStateProven.
//
// Dependency-injected so it is testable + deployment-agnostic. The deployment provides:
//   deps      : { secp, keccak256, sha256 } (the @noble crypto)
//   storage   : { load(): Promise<{ effectLog, attestedCount }>, save(state): Promise<void> } (KV/Postgres)
//   prove     : (input) => Promise<{ vkey, publicValues, proofBytes }>  — the GPU box (tETH-style loop:
//               the worker enqueues `input`, the box proves exec-reflect-prove.rs, returns the proof)
//   submit    : (publicValues, proofBytes) => Promise<txHash>  — attestBitcoinStateProven via RPC + relay key
//   getHeaders: (blockHeights) => Promise<hex[]>  — the 80-byte headers for the batch's blocks
//
// The confirmed effect log is the source of truth: state is rebuilt by replaying it (the canonical
// Bitcoin pool effects, ordered by block + tx index), so a restart/redeploy is always consistent.

import { makeReflectionIndexer } from '../../dapp/confidential-reflection-indexer.js';

export function makeReflectionAttester({ deps, storage, prove, submit, getHeaders }) {
  // Replay the persisted effect log into a fresh indexer → the current canonical state.
  async function rebuild() {
    const { effectLog = [], attestedCount = 0 } = (await storage.load()) || {};
    const idx = makeReflectionIndexer(deps);
    // deposits first (notes entering), then the ordered transfers/burns that spend them.
    const resolved = [];
    for (const eff of effectLog) {
      if (eff.kind === 'deposit') {
        idx.applyDeposits([idx.recordDeposit(eff.deposit)], eff.height);
      } else if (eff.kind === 'transfer') {
        resolved.push({ raw: eff, spec: idx.resolveTransfer(eff.raw) });
      } else if (eff.kind === 'burn') {
        resolved.push({ raw: eff, spec: idx.resolveBurn(eff.raw) });
      }
    }
    return { idx, effectLog, attestedCount, resolved };
  }

  // The scan calls this when a confirmed pool effect lands (ordered by block + tx index).
  async function ingest(eff) {
    const { effectLog = [], attestedCount = 0 } = (await storage.load()) || {};
    effectLog.push(eff);
    await storage.save({ effectLog, attestedCount });
  }

  // The cron calls this. Assemble the un-attested batch → prove → submit → advance the attested
  // cursor. No-op if nothing is pending. Returns the attestation tx hash (or null).
  async function runCycle() {
    const { idx, effectLog, attestedCount, resolved } = await rebuild();
    const pending = resolved.slice(attestedCount); // transfers/burns not yet attested
    if (pending.length === 0) return null;

    // advance the canonical state past the already-attested effects (so `prior` is the attested anchor)
    const attested = resolved.slice(0, attestedCount);
    if (attested.length) idx.assembleBatch(attested.map((r) => r.spec), { headers: [], anchorHeight: 0 });

    const blocks = [...new Set(pending.map((r) => r.spec.blockIndex))];
    const headers = await getHeaders(blocks);
    const anchorHeight = Math.min(...pending.map((r) => r.raw.height));
    // re-key block indices to the batch's header array
    const specs = pending.map((r) => ({ ...r.spec, blockIndex: blocks.indexOf(r.spec.blockIndex) }));

    const input = idx.assembleBatch(specs, { headers, anchorHeight });
    const { vkey, publicValues, proofBytes } = await prove(input);
    const txHash = await submit(publicValues, proofBytes);

    await storage.save({ effectLog, attestedCount: resolved.length });
    return { txHash, vkey, newDigest: input.newDigest, attested: pending.length };
  }

  return { ingest, runCycle, rebuild };
}

// Worker-facing factory: build an attester from env bindings, or null if reflection attestation
// isn't configured (inert — no hot-path cost). Config (all required to enable):
//   env.REFLECTION_ATTEST   = '1'                     — the enable flag
//   env.REFLECTION_PROVE_URL                          — the GPU box prove endpoint (POST input → proof)
//   env.REFLECTION_SUBMIT_URL                         — the attest relay (POST {publicValues, proofBytes})
//   env.REGISTRY_KV                                   — state persistence
// `api` is the worker's esplora text fetcher (for getHeaders); `deps` = { secp, keccak256, sha256 }.
export function buildReflectionAttester(env, { deps, api, network }) {
  if (!env || env.REFLECTION_ATTEST !== '1' || !env.REFLECTION_PROVE_URL || !env.REGISTRY_KV) return null;
  const KEY = `reflection:state:${network}`;
  const storage = {
    load: async () => { const s = await env.REGISTRY_KV.get(KEY); return s ? JSON.parse(s) : null; },
    save: async (s) => env.REGISTRY_KV.put(KEY, JSON.stringify(s)),
  };
  const prove = async (input) => {
    const r = await fetch(env.REFLECTION_PROVE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!r.ok) throw new Error('reflection prove failed: ' + r.status);
    return r.json(); // { vkey, publicValues, proofBytes }
  };
  const submit = async (publicValues, proofBytes) => {
    if (!env.REFLECTION_SUBMIT_URL) return null; // prove-only mode until the relay is wired
    const r = await fetch(env.REFLECTION_SUBMIT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicValues, proofBytes }) });
    return r.ok ? (await r.json()).txHash : null;
  };
  const getHeaders = async (heights) => Promise.all(heights.map(async (h) => {
    const hash = (await api(env, `/block-height/${h}`, {}, network)).trim();
    return '0x' + (await api(env, `/block/${hash}/header`, {}, network)).trim();
  }));

  const att = makeReflectionAttester({ deps, storage, prove, submit, getHeaders });
  const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join(''); // display → internal

  // Build + ingest a confirmed CXFER from the block scan. tx (esplora: .txid, .vin[]), dx (decoded
  // outputs with .commitment compressed-hex), txs (the block's txs in order), h (height).
  att.ingestConfirmedCxfer = async (tx, dx, txs, h, assetId) => {
    const rawTx = await api(env, `/tx/${tx.txid}/hex`, {}, network);
    const eff = {
      kind: 'transfer', height: h,
      raw: {
        txid: '0x' + reverseHex(tx.txid), assetId, height: h, blockIndex: h,
        txData: rawTx.trim(), txIndex: txs.findIndex((t) => t.txid === tx.txid),
        txids: txs.map((t) => '0x' + reverseHex(t.txid)),
        spentVins: (tx.vin || []).map((vi) => ({ prevTxid: '0x' + reverseHex(vi.txid), vout: vi.vout })),
        outputCommitments: (dx.outputs || []).map((o) => o.commitment),
      },
    };
    return att.ingest(eff);
  };
  return att;
}
