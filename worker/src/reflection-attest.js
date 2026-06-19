// Worker-side reflection attestation: maintains the canonical Bitcoin confidential-pool reflection state
// via the FULL-SCAN model (every tx of every confirmed block, F4-complete) and assembles the prover batches
// the self-hosted GPU box proves + submits to ConfidentialPool.attestBitcoinStateProven (the box-poll relay).
// Dependency-injected (deps={secp,keccak256,sha256}, storage, getBlockTxs/getHeaders, classifyTx,
// burnDepositKit) so it is testable + deployment-agnostic. The persisted SNAPSHOT (advanced only on ack,
// after the on-chain attestation lands) is the source of truth, so a restart/redeploy is always consistent.

import { makeScanReflectionIndexer } from '../../dapp/confidential-reflection-scan-indexer.js';
import { makeBurnDepositKit } from '../../dapp/burn-deposit-bitcoin.js';
import { SWAP_BATCH_VK } from '../../dapp/confidential-swapbatch-vk.js';

// ── Full-scan reflection attester (the worker's Bitcoin-state relay; the superseded witnessed-effects
// attester was removed at the scan-attester cutover) ──
// The canonical state is a SNAPSHOT (the full-scan ScanReflection: live set + accumulators +
// coords) persisted at the ATTESTED height. A cycle assembles the un-attested block range by
// fetching EVERY tx of each block (so the guest's merkle-completeness check holds — no pool spend
// can be omitted), advancing a copy of the snapshot, and proving; the persisted snapshot only
// advances on ack (after the on-chain attestation), so a failed prove/submit is a safe retry.
//
//   deps          : { secp, keccak256, sha256 }
//   storage       : { load(): {snapshot, attestedHeight, tipHeight} | null, save(state) }
//   getBlockTxs   : (height) => Promise<{ txs: [...] }>  — every tx of the block (the worker block-tx shape)
//   getHeaders    : (heights[]) => Promise<hex[]>        — the 80-byte headers, in height order
//   burnDepositKit: (optional) the TAC burn-deposit / cmint-deposit onboarding tooling the scan indexer
//                   needs to assemble a 0x2B burn of a PRE-existing (never-reflected) note — see
//                   makeScanReflectionIndexer's burnDepositKit contract. Absent ⇒ onboarding is inert
//                   (and getBurnDeposits is never consulted, so the indexer can never see a bundle
//                   without its verifier — which would throw).
//   getBurnDeposits: (optional) (txidsDisplay[]) => Promise<Map(txidDisplay → holder-traced bundle)> for
//                   any burn-deposit in the batch. Looked up by the burn's display txid (a bundle is bound
//                   to the burn tx, not a block height). Only consulted when burnDepositKit is wired.
//   prove/submit as above. batchSize caps blocks per cycle (a huge backlog proves in chunks).
export function makeScanReflectionAttester({ deps, storage, prove, submit, getBlockTxs, getHeaders, genesisHeight, batchSize = 16, burnDepositKit, getBurnDeposits, ethBundleSource }) {
  const range = (from, to) => { const a = []; for (let h = from; h <= to; h++) a.push(h); return a; };
  // attestedHeight = the last block folded into the persisted snapshot; the next batch starts at
  // attestedHeight+1. Genesis: nothing attested, so attestedHeight = genesisHeight-1 (the first
  // scanned block is genesisHeight, matching GENESIS_REFLECTION_ANCHOR).
  const base = (genesisHeight | 0) - 1;
  const init = () => ({ snapshot: null, attestedHeight: base, tipHeight: base });

  async function loadState() { return (await storage.load()) || init(); }

  // Record the latest CONFIRMED (finality-buried) tip so cycles know how far to attest. Monotonic.
  async function setTip(height) {
    const s = await loadState();
    if (height > s.tipHeight) await storage.save({ ...s, tipHeight: height });
    return Math.max(height, s.tipHeight);
  }

  // Assemble the next un-attested block range into a prover input WITHOUT advancing the persisted
  // anchor (the box proves + submits, then acks). Returns null if caught up. The returned
  // `newSnapshot` is the post-batch canonical state ackJob will persist.
  async function assembleJob() {
    const s = await loadState();
    if (s.tipHeight <= s.attestedHeight) return null;
    const from = s.attestedHeight + 1;
    const to = Math.min(s.tipHeight, from + batchSize - 1);
    const heights = range(from, to);
    const idx = makeScanReflectionIndexer({ ...deps, burnDepositKit, swapBatchVk: SWAP_BATCH_VK });
    idx.load(s.snapshot);
    const blocks = await Promise.all(heights.map((h) => getBlockTxs(h)));
    const headers = await getHeaders(heights);
    // Holder-submitted TAC burn-deposit / cmint-deposit provenance bundles for any 0x2B burn of a
    // pre-existing note in this range, keyed by the burn's display txid. Only consulted when a kit is
    // wired (the indexer throws if handed a bundle without one), so this stays a no-op pre-onboarding.
    let burnDeposits;
    if (burnDepositKit && getBurnDeposits) {
      const txids = blocks.flatMap((b) => (b.txs || []).map((t) => t.txidDisplay));
      burnDeposits = await getBurnDeposits(txids);
    }
    // Mode-B reverse reflection (ETH→BTC): if an eth-reflection bundle source is wired, fetch the eth
    // proof's attested sets for this range (+ the resolved Bitcoin source note per consumed ν) and assemble
    // a mode_b=1 batch — each 0x65 mint onboards against the crossOutSet, the consumed-ν fast lane folds.
    // Absent (the steady state until Mode-B is operational) ⇒ a forward batch (mode_b=0; every 0x65 skips).
    const modeB = ethBundleSource ? await ethBundleSource({ from, to, blocks }) : null;
    const input = await idx.assembleBlocks(blocks, {
      headers, anchorHeight: from, burnDeposits,
      ethBundle: modeB && modeB.ethBundle, consumedSources: modeB && modeB.consumedSources,
    });
    // Fail-loud: if any tx in this range carries a Tacit envelope the guest folds but the JS scan does
    // not yet mirror (AMM / cBTC / farm / bid / protocol-fee / crossout / AXFER), the guest would read
    // fold witnesses this assembler never emitted — the prover input is desynced. REFUSE rather than
    // attest a divergent root; the relay halts at this height until the fold is mirrored (the guest is
    // authoritative, so this is liveness, never soundness — no wrong attestation can land).
    if (input.unsupportedEnvelopes && input.unsupportedEnvelopes.length) {
      const ops = [...new Set(input.unsupportedEnvelopes.map((u) => '0x' + (u.opcode || 0).toString(16)))].join(',');
      throw new Error(`reflection: ${input.unsupportedEnvelopes.length} unmirrored guest-folded envelope(s) [${ops}] in blocks ${from}..${to}; mirror the fold in the JS scan before attesting (fail-loud, no divergent attestation)`);
    }
    return { jobId: input.newDigest, input, newSnapshot: idx.snapshot(), attestedTo: to, blocks: heights.length };
  }

  // Advance the attested anchor after the on-chain attestation lands. Idempotent: a stale ack
  // (attestedTo <= attestedHeight) is a no-op, so a retried submit can't skip or re-fold blocks.
  async function ackJob(attestedTo, newSnapshot) {
    const s = await loadState();
    if (attestedTo > s.attestedHeight) await storage.save({ snapshot: newSnapshot, attestedHeight: attestedTo, tipHeight: s.tipHeight });
    return { attestedHeight: Math.max(attestedTo, s.attestedHeight) };
  }

  // All-in-worker synchronous model (prove + submit via injected URLs). No-op if caught up.
  async function runCycle() {
    const job = await assembleJob();
    if (!job) return null;
    const { vkey, publicValues, proofBytes } = await prove(job.input);
    const txHash = await submit(publicValues, proofBytes);
    await ackJob(job.attestedTo, job.newSnapshot);
    return { txHash, vkey, newDigest: job.input.newDigest, attestedTo: job.attestedTo, blocks: job.blocks };
  }

  return { setTip, assembleJob, ackJob, runCycle, loadState };
}

// Worker-facing factory for the FULL-SCAN attester. Wires getBlockTxs/getHeaders to esplora and
// the canonical-state snapshot to KV. Returns null if reflection attestation isn't configured.
//   env.REFLECTION_ATTEST          = '1'                — enable flag
//   env.REGISTRY_KV                                     — snapshot persistence
//   env.REFLECTION_GENESIS_HEIGHT                       — the first block the reflection scans
//                                                         (= GENESIS_REFLECTION_ANCHOR's height)
// `classifyTx({ txid, vin, vout, rawHex }) => null | {type:'cxfer',assetId,commitments[],kernelSig,
// rangeProof} | {type:'burn',dest}` classifies a tx's confidential envelope, injected so the attester
// stays decode-agnostic. It MUST mirror the guest's reflect.rs classification (the guest re-parses txData
// + is authoritative), and a cxfer MUST surface its kernelSig (64-byte BIP-340 hex) + rangeProof (BP+ hex)
// — the assembler re-verifies value conservation before folding the outputs (REFLECT-1). The worker wires
// `classifyConfidentialTx` (dapp/burn-deposit-bitcoin.js), a faithful cxfer-core port (NOT the lossy
// decodeCXferBppPayload, which drops the kernel sig + range proof). `api` is the esplora text fetcher.
//
// `burnDepositKit` (optional) enables the scan-free TAC burn-deposit / cmint-deposit onboarding (a 0x2B
// burn of a PRE-existing, never-reflected note). It is the raw-tx Bitcoin tooling the scan indexer needs
// — { mirror: makeBurnDepositProvenance(...), assembler: makeBurnDepositAssembler(...),
// parseEtchAnchor(etchTxHex, assetHex), computeTxidInternal(txHex) } (see makeScanReflectionIndexer).
// Absent ⇒ onboarding stays inert (holder bundles are never read, the indexer never throws). When wired,
// holders submit their traced provenance bundle under reflection:burndep:{net}:{burnTxidDisplay}.
export function buildScanReflectionAttester(env, { deps, api, network, classifyTx, burnDepositKit }) {
  if (!env || env.REFLECTION_ATTEST !== '1' || !env.REGISTRY_KV) return null;
  const genesisHeight = parseInt(env.REFLECTION_GENESIS_HEIGHT || '0', 10);
  if (!genesisHeight) return null;
  // Build the real TAC burn-deposit / cmint-deposit onboarding kit from the same crypto deps (so the worker
  // can assemble a holder-traced provenance bundle into the prover input). Overridable for tests; default is
  // the production kit. Onboarding stays inert until a holder actually submits a bundle (getBurnDeposits).
  const kit = burnDepositKit || makeBurnDepositKit(deps);
  const KEY = `reflection:scan:${network}`;
  const storage = {
    load: async () => { const s = await env.REGISTRY_KV.get(KEY); return s ? JSON.parse(s) : null; },
    save: async (s) => env.REGISTRY_KV.put(KEY, JSON.stringify(s)),
  };
  // Holder-traced burn-deposit bundles, keyed by the burn tx's display txid. Returns the subset present
  // for this batch's txids. Only invoked by the attester when burnDepositKit is wired.
  const burnDepKey = (txidDisplay) => `reflection:burndep:${network}:${txidDisplay.replace(/^0x/, '')}`;
  const hexBytes = (h) => {
    const s = String(h).replace(/^0x/, '');
    if (s.length % 2) throw new Error('reflection: odd hex');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
  };
  const reverse = (b) => Uint8Array.from(b).reverse();
  const dsha = (b) => deps.sha256(deps.sha256(b));
  const blockWitnessCache = new Map();
  async function blockWitness(record, txHex) {
    let hash = record.blockHash;
    if (!hash && record.blockHeight != null) hash = (await api(env, `/block-height/${record.blockHeight}`, {}, network)).trim();
    if (!hash) throw new Error('burn-deposit provenance record requires blockHash or blockHeight');
    let block = blockWitnessCache.get(hash);
    if (!block) {
      const displays = JSON.parse(await api(env, `/block/${hash}/txids`, {}, network));
      const raws = await Promise.all(displays.map((id) => api(env, `/tx/${id}/hex`, {}, network).then((x) => x.trim())));
      block = {
        coinbase: '0x' + raws[0],
        blockTxids: displays.map((id) => reverse(hexBytes(id))),
        blockWtxids: raws.map((raw) => dsha(hexBytes(raw))),
      };
      blockWitnessCache.set(hash, block);
    }
    const txid = kit.computeTxidInternal(txHex).toLowerCase();
    const index = block.blockTxids.findIndex((id) => '0x' + [...id].map((x) => x.toString(16).padStart(2, '0')).join('') === txid);
    if (index <= 0) throw new Error('burn-deposit protocol tx absent from block or at coinbase index');
    return { ...block, index };
  }
  async function enrichBurnDeposit(bundle) {
    const etch = { ...bundle.etch, ...(await blockWitness(bundle.etch, bundle.etch.tx)) };
    const cxfers = await Promise.all((bundle.cxfers || []).map(async (c) => ({
      ...c, ...(await blockWitness(c, c.tx)),
    })));
    const cmints = await Promise.all((bundle.cmints || []).map(async (cm) => ({
      ...cm, ...(await blockWitness(cm, cm.revealTx)),
    })));
    return { ...bundle, etch, cxfers, cmints };
  }
  const getBurnDeposits = async (txidsDisplay) => {
    const map = new Map();
    for (const txid of txidsDisplay) {
      const raw = await env.REGISTRY_KV.get(burnDepKey(txid));
      if (raw) map.set(txid, await enrichBurnDeposit(JSON.parse(raw)));
    }
    return map;
  };
  const prove = async (input) => {
    const r = await fetch(env.REFLECTION_PROVE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!r.ok) throw new Error('reflection prove failed: ' + r.status);
    return r.json();
  };
  const submit = async (publicValues, proofBytes) => {
    if (!env.REFLECTION_SUBMIT_URL) return null;
    const r = await fetch(env.REFLECTION_SUBMIT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicValues, proofBytes }) });
    return r.ok ? (await r.json()).txHash : null;
  };
  const getHeaders = async (heights) => Promise.all(heights.map(async (h) => {
    const hash = (await api(env, `/block-height/${h}`, {}, network)).trim();
    return '0x' + (await api(env, `/block/${hash}/header`, {}, network)).trim();
  }));
  // EVERY tx of the block (in order) with its raw bytes, vins, and protocol classification — the
  // full-scan completeness input. For the pilot's small blocks the per-tx fetch is fine; a mainnet
  // build would page /block/{hash}/txs (25/page) and /block/{hash}/raw instead.
  const getBlockTxs = async (h) => {
    const hash = (await api(env, `/block-height/${h}`, {}, network)).trim();
    const txids = JSON.parse(await api(env, `/block/${hash}/txids`, {}, network)); // display order
    const txs = await Promise.all(txids.map(async (txidDisplay) => {
      const rawHex = (await api(env, `/tx/${txidDisplay}/hex`, {}, network)).trim();
      const txJson = JSON.parse(await api(env, `/tx/${txidDisplay}`, {}, network));
      const vins = (txJson.vin || []).map((vi) => ({ prevTxidDisplay: vi.txid, vout: vi.vout }));
      const decode = classifyTx ? classifyTx({ txid: txidDisplay, vin: txJson.vin || [], vout: txJson.vout || [], rawHex }) : null;
      return { txidDisplay, rawHex, vins, decode };
    }));
    return { txs };
  };
  return makeScanReflectionAttester({ deps, storage, prove, submit, getBlockTxs, getHeaders, genesisHeight, burnDepositKit: kit, getBurnDeposits });
}
