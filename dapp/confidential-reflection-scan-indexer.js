// Full-scan reflection indexer (F4). The worker fetches every tx of each confirmed block (raw
// hex + vins + its protocol decode) and hands them here as ordered blocks; this transforms each
// into the assembler's tx spec and advances the canonical ScanReflection state, returning the
// full-scan prover input. Unlike the witnessed-effects indexer (makeReflectionIndexer), the
// canonical state advances by SCANNING every tx's vins against the live UTXO set — so a pool-UTXO
// spend can't be omitted (the gap F4 named), and the same scan that advances the state produces
// the guest input. The owner tag for a Bitcoin pool note's tree leaf is the protocol-wide ZERO
// owner (the note's authority is its bearer secret, not an owner field), matching the worker's
// confirmed-CXFER decode.
//
// The worker block-tx shape (getBlockTxs output), per block: { txs: [ {
//   txidDisplay,                              // esplora display-order txid
//   rawHex,                                   // the canonical tx bytes (the guest recomputes txid + merkle)
//   vins: [{ prevTxidDisplay, vout }],        // every input (display-order prev txid)
//   decode: null                              // a plain tx (its pool spends are caught by the scan)
//         | { type:'cxfer', assetId, commitments:[compressed-33 hex], kernelSig, rangeProof }
//         | { type:'burn', assetId, nullifier, dest } // bridge-burn envelope fields (ν binds live bridge-outs)
//         | { type:'mint', assetId }          // T_MINT/cmint value-entry — surfaced, NOT yet reflected
// } ] }
// A cxfer decode MUST surface kernelSig (64-byte BIP-340 hex) + rangeProof (BP+ hex): the assembler
// re-verifies value conservation (REFLECT-1) before folding the outputs, mirroring the guest.

import { makeConfidentialPool } from './confidential-pool.js';
import { foldSwapBatch } from './confidential-swapbatch.js';

const ZERO_OWNER = '0x' + '00'.repeat(32);
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join(''); // display ↔ internal

// burnDepositKit (injected by the worker, which owns the Bitcoin tooling) enables the scan-free TAC
// burn-deposit / cmint-deposit onboarding. It carries:
//   mirror:    makeBurnDepositProvenance({...crypto, cmint parsers}) — verifyProvenanceLeaves + verifyCmintAuthorized
//   assembler: makeBurnDepositAssembler({dsha256, cat, bytesToHex}) — buildBurnDepositStatic + merkle helpers
//   parseEtchAnchor(etchTxHex, assetHex) -> { c0Compressed, mintAuthority } | null  (worker's verify_etch_anchor port)
//   computeTxidInternal(txHex) -> "0x…"  (internal-order txid == the guest's compute_txid)
// Absent → burn-deposits are not assembled (a burn tx with a provenance bundle then throws in the scan).
export function makeScanReflectionIndexer({ secp, keccak256, sha256, ownerTag, burnDepositKit, swapBatchVk } = {}) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const OWNER = ownerTag || ZERO_OWNER;
  let state = pool.makeScanReflectionState();
  let coords = new Map(); // outpointKey (lowercased hex) → { cx, cy } for every live pool note

  const internal = (displayTxid) => '0x' + reverseHex(displayTxid);
  const withHex = (raw) => (raw.startsWith('0x') ? raw : '0x' + raw);

  // Build the burn-deposit fold context from a holder-traced provenance bundle (the worker assembles this
  // off-chain via the tracer + its Bitcoin tooling). Routes the lineage through the JS realness mirror
  // (verifyProvenanceLeaves over valid_leaves = C_0 ∪ issuer-authorized cmints) and the static-witness
  // builder; the canonical scan (foldBurnDepositTx) performs the actual fold. The criterion self-routes:
  // a fixed-supply etch has mint_authority = 0 → verifyCmintAuthorized rejects every cmint → leaves = [C_0].
  //   bundle = { assetId, nu, dest, burned:{cx,cy}, burnedInput:{prevTxid,prevVout},
  //              etch:{tx,blockTxids,blockWtxids,coinbase,index}, provHeaders:[hex],
  //              cxfers:[{tx,txid,inputs:[{prevTxid,prevVout,commitment}],outputs:[{commitment,vout}],
  //                        rangeProof,kernelSig,blockTxids,blockWtxids,coinbase,index}],
  //              cmints:[{revealTx,commitTx,blockTxids,blockWtxids,coinbase,index}] } (cmints empty for fixed-supply)
  function buildBurnDepositCtx(bundle) {
    if (!burnDepositKit) throw new Error('scan indexer: burn-deposit tx present but no burnDepositKit injected');
    const { mirror, assembler, parseEtchAnchor, computeTxidInternal } = burnDepositKit;
    const asset = bundle.assetId;
    let valid = false;
    const anchor = parseEtchAnchor(bundle.etch.tx, asset); // { c0Compressed, mintAuthority } | null
    if (anchor) {
      const chOf = (compressed) => { const { cx, cy } = pool.decompressCommitment(compressed); return pool.commitmentHash(cx, cy); };
      const validLeaves = [[pool.outpointKey(computeTxidInternal(bundle.etch.tx), 0), chOf(anchor.c0Compressed)]];
      for (const cm of (bundle.cmints || [])) {
        const lf = mirror.verifyCmintAuthorized(asset, anchor.mintAuthority, cm.revealTx, cm.commitTx);
        if (lf) validLeaves.push(lf); // null = unauthorized/non-mintable → not a leaf
      }
      const cxfersForMirror = (bundle.cxfers || []).map((c) => ({
        txid: c.txid,
        inputOutpoints: c.inputs.map((i) => [i.prevTxid, i.prevVout]),
        inputCommitments: c.inputs.map((i) => i.commitment),
        outputCommitments: c.outputs.map((o) => o.commitment),
        outputVouts: c.outputs.map((o) => o.vout),
        burnedAmount: c.burnedAmount || 0, // 0 for a transfer; > 0 for a CBURN step
        rangeProof: c.rangeProof,
        kernelSig: c.kernelSig,
        merkleSiblings: assembler.merkleSiblings(c.blockTxids, c.index),
        merkleIndex: c.index,
        confirmedBlockRoot: assembler.merkleRoot(c.blockTxids),
      }));
      const burnedOutpoint = pool.outpointKey(bundle.burnedInput.prevTxid, bundle.burnedInput.prevVout);
      const burnedCh = pool.commitmentHash(bundle.burned.cx, bundle.burned.cy);
      valid = mirror.verifyProvenanceLeaves(asset, validLeaves, burnedOutpoint, burnedCh, cxfersForMirror);
    }
    return {
      valid,
      nu: bundle.nu,
      dest: bundle.dest,
      burnedCx: bundle.burned.cx,
      burnedCy: bundle.burned.cy,
      burnedNoteLeaf: pool.leaf(asset, bundle.burned.cx, bundle.burned.cy, OWNER),
      witness: assembler.buildBurnDepositStatic({
        etch: bundle.etch, provHeaders: bundle.provHeaders, cxfers: bundle.cxfers || [], cmints: bundle.cmints || [],
      }),
    };
  }

  // One worker block-tx → the assembler's tx spec. Plain txs carry only vins (their pool-UTXO
  // spends are detected by the scan); cxfer txs declare output notes; burn txs declare ν → dest.
  function txSpec(tx, burnDeposits) {
    const vins = (tx.vins || []).map((vi) => ({ prevTxid: internal(vi.prevTxidDisplay), vout: vi.vout }));
    const txid = internal(tx.txidDisplay);
    let env = null;
    if (tx.decode && tx.decode.type === 'cxfer') {
      env = {
        type: 'cxfer',
        assetId: tx.decode.assetId,
        kernelSig: tx.decode.kernelSig,     // 64-byte BIP-340 kernel sig (conservation)
        rangeProof: tx.decode.rangeProof,   // BP+ range proof over the output commitments
        outputs: tx.decode.commitments.map((comm, j) => {
          const { cx, cy } = pool.decompressCommitment(comm);
          // Notes are keyed at their REAL Bitcoin vout, supplied per-opcode by classifyConfidentialTx
          // (canonicalOutputVout / canonicalBidOutputVout — identity for plain cxfers, the {0->0,1->2}
          // interleave for AXFER_VAR, the bid layout for 0x5B/0x5C), so the indexer's live set matches the
          // guest's fold and a later spend is detected at the right outpoint. Legacy decode w/o vouts → j.
          const vout = (tx.decode.vouts && tx.decode.vouts[j] != null) ? tx.decode.vouts[j] : (j + (tx.decode.voutBase || 0));
          return { cx, cy, compressed: comm, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.leaf(tx.decode.assetId, cx, cy, OWNER), vout };
        }),
      };
    } else if (tx.decode && tx.decode.type === 'burn') {
      env = { type: 'burn', assetId: tx.decode.assetId || null, nullifier: tx.decode.nullifier || null, dest: tx.decode.dest };
      // BURN-DEPOSIT (scan-free TAC/cmint onboarding): a 0x2B burn of a pre-existing note (no live-set
      // spend). If the worker supplied this tx's holder-traced provenance bundle, assemble the fold
      // context (the canonical scan folds it iff the realness mirror admits it).
      const bundle = burnDeposits && burnDeposits.get(tx.txidDisplay);
      if (bundle) env.burnDeposit = buildBurnDepositCtx(bundle);
    } else if (tx.decode && (tx.decode.type === 'mint' || tx.decode.type === 'cmint')) {
      // A confidential-mint value-entry (T_MINT/cmint). The conservation-closed full-scan model does
      // NOT yet reflect it (no free-output deposit path); surface it so the assembler can flag the
      // un-onboarded value rather than silently treating the tx as plain.
      env = { type: 'mint', assetId: tx.decode.assetId };
    } else if (tx.decode && ['swap_var', 'swap_route', 'harvest', 'farm_refund', 'protocol_fee_claim', 'farm_init', 'swap_batch', 'lp_add', 'lp_remove', 'cbtc_lock', 'cbtc_redeem', 'crossout_mint'].includes(tx.decode.type)) {
      // Track-B/C AMM + cBTC ops whose fold data is fully on-chain (classifyConfidentialTx parsed it, incl. the
      // option-a opening blindings for lp_add/lp_remove/cbtc_lock) — the assembler's fold advances the pool/lock
      // registry + onboards the receipt(s). The decode IS the env shape those folds read. (swap_batch's BN254
      // Groth16 is verified by the injected hook against the fold-point reserves — see assembleBlocks.)
      env = tx.decode;
    } else if (tx.decode && tx.decode.type === 'unsupported') {
      // A Tacit envelope the guest folds but the JS scan does not yet route (crossout) — surface it so the
      // assembler flags the batch + the attester refuses, rather than emit a witness short the paths the guest
      // reads (a desync). Liveness, never a wrong digest (the guest is authoritative).
      env = { type: 'unsupported', opcode: tx.decode.opcode };
    }
    return { txData: withHex(tx.rawHex), txid, vins, env };
  }

  // Advance the canonical state over a batch of confirmed blocks (each `{ txs: [...] }`, in block
  // order) and return the full-scan prover input. `headers` = the batch's 80-byte block headers;
  // `anchorHeight` = headers[0]'s confirmed height. ADVANCES state + coords (the assembler scans
  // every tx's vins, folds the detected effects). Returns the input the box's exec harness writes
  // (its `.nonConserving` lists any cxfer whose outputs were skipped for failing value conservation).
  // `burnDeposits` (optional): Map(txidDisplay → holder-traced provenance bundle) for any 0x2B burn of a
  // pre-existing note in this batch — see buildBurnDepositCtx for the bundle shape.
  // `input` is either an eager array of raw blocks ([{ txs }]) OR a streaming source
  // ({ blockCount, getRawBlock(i) → {txs} | Promise<{txs}> }). Both deliver blocks to the fold ONE at a time
  // via batch.getBlock — txSpec runs per block at fold-time, so a streaming caller (fetch+fold+discard) holds
  // only one raw block at once. Byte-identical fixture either way (same block order, same txSpec, same folds).
  async function assembleBlocks(input, { headers, anchorHeight, burnDeposits, ethBundle, consumedSources } = {}) {
    const streaming = input && typeof input.getRawBlock === 'function';
    const blockCount = streaming ? input.blockCount : ((input && input.length) || 0);
    const getRawBlock = streaming ? input.getRawBlock : ((i) => input[i]);
    const batch = {
      anchorHeight, headers, blockCount,
      getBlock: async (i) => {
        const b = await getRawBlock(i);
        return { txs: (b.txs || []).map((tx) => txSpec(tx, burnDeposits)) };
      },
    };
    // swap_batch (0x2F): the per-0x2F hook the assembler awaits — verifies the BN254 Groth16 against the pool's
    // fold-point reserves (vk == the guest's batch_vk.bin) then onboards the n receipts. Built per-call so it
    // captures the CURRENT `state` (load() may have replaced it). Absent vk ⇒ no hook ⇒ swap_batch surfaces as
    // unsupported and the attester refuses (liveness, never a wrong digest — see the assembler's swap_batch arm).
    if (swapBatchVk) batch.swapBatchFold = (env, txid, spends) => foldSwapBatch(pool, state, env, txid, spends, { vk: swapBatchVk });
    // Mode-B reverse reflection (ETH→BTC): given the eth proof's attested sets (ethBundle — eth_prove emits it
    // alongside eth_pv.hex: { ethPv, crossouts:[{claimId,destCommitment,asset}], consumeds:[{nu,spendRoot}] })
    // plus the resolved Bitcoin source note per consumed ν (consumedSources), assemble the mode_b=1 witnesses:
    // the cross-out IMT (modeB.crossoutImt, which the assembler proves each 0x65 against) + the consumed-ν fast
    // lane. Absent ethBundle ⇒ a forward batch (mode_b=0) — every 0x65 skips against crossout_set_root=0.
    if (ethBundle) {
      const { modeB } = pool.buildModeBBatch(ethBundle, [], consumedSources || []);
      batch.modeB = modeB;
    }
    return pool.assembleReflectionScanInput(state, batch, coords);
  }

  // Serialize the canonical state for restart-durable persistence (the full accumulators — the
  // witnessed transitions need their leaves to build paths). Compact: the live set + coords are
  // O(live); the note/spent/burn histories grow with activity (a frontier compaction is a pilot
  // follow-up). load() replays it into a fresh state.
  function snapshot() {
    return {
      noteLeaves: state._acc.notes.leaves.map((l) => '0x' + Array.from(l, (x) => x.toString(16).padStart(2, '0')).join('')),
      spentLinks: state._acc.spent.links(),
      cbtcLockTriples: state.cbtcLocks.triples(),
      cbtcBackingSats: String(state.getCbtcBackingSats()),
      liveTriples: state._acc.live.triples(),
      burnNodes: state._acc.burns.nodes(),
      pools: state.pools.list(),
      height: state.counts().height,
      coords: [...coords.entries()],
      // Mode-B accumulators (ride digest()): a cold restore after a Mode-B fold must carry these or the
      // resumed digest drops back to the forward-only genesis and diverges from knownReflectionDigest.
      consumedCount: String(state.getConsumedCount()),
      ethReflDigest: state.getEthReflDigest(),
      consumedCrossoutLinks: state.consumedCrossoutLinks(),
      foldedCrossoutCount: String(state.getFoldedCrossoutCount()),
      farmRewards: state.farmRewards.list(),
    };
  }
  function load(snap) {
    state = pool.makeScanReflectionState();
    coords = new Map();
    if (!snap) return;
    for (const leaf of (snap.noteLeaves || [])) state._acc.notes.insert(leaf); // notes tree: O(1) push each
    // Adopt the pre-computed accumulator structures directly (O(n)) instead of re-inserting each item
    // (O(n) predecessor-scan/sort each → O(n²)) — the snapshot arrays ARE the internal state, so this
    // reconstructs identical roots/witnesses. Critical for a SEEDED pool (thousands of live/spent entries).
    if ((snap.spentLinks || []).length) state._acc.spent.setLinks(snap.spentLinks);
    if ((snap.burnNodes || []).length) state._acc.burns.setNodes(snap.burnNodes);
    state._acc.live.load(snap.liveTriples || []); // the live UTXO set: (key, commitmentHash, asset) triples — O(n log n)
    state.cbtcLocks.load(snap.cbtcLockTriples || []); // cBTC.zk locks — restore (rides digest())
    if (snap.cbtcBackingSats) state.setCbtcBackingSats(snap.cbtcBackingSats); // cBTC backing total (rides digest())
    state.pools.load(snap.pools || []); // the per-pool reserve registry (empty until AMM envelopes are folded)
    if (snap.height) state.setHeight(snap.height);
    for (const [k, v] of (snap.coords || [])) coords.set(k, v);
    // Mode-B accumulators — restore so a cold resume after a Mode-B fold reproduces the on-chain digest
    // (older snapshots omit these; they default to the forward-only genesis, which is correct for them).
    if (snap.consumedCount != null) state.setConsumedCount(snap.consumedCount);
    if (snap.ethReflDigest) state.setEthReflDigest(snap.ethReflDigest);
    if ((snap.consumedCrossoutLinks || []).length) state.setConsumedCrossoutLinks(snap.consumedCrossoutLinks);
    if (snap.foldedCrossoutCount != null) state.setFoldedCrossoutCount(snap.foldedCrossoutCount);
    if ((snap.farmRewards || []).length) state.farmRewards.load(snap.farmRewards);
  }

  return {
    pool, assembleBlocks, snapshot, load,
    state: () => state,
    coords: () => coords,
    digest: () => state.digest(),
    roots: () => state.commit(),
    liveCount: () => state.counts().live,
  };
}
