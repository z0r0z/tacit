// Full-scan reflection indexer. The worker fetches every tx of each confirmed block (raw
// hex + vins + its protocol decode) and hands them here as ordered blocks; this transforms each
// into the assembler's tx spec and advances the canonical ScanReflection state, returning the
// full-scan prover input. Unlike the witnessed-effects indexer (makeReflectionIndexer), the
// canonical state advances by SCANNING every tx's vins against the live UTXO set — so a pool-UTXO
// spend can't be omitted (the spent-set completeness gap), and the same scan that advances the state produces
// the guest input. A confirmed CXFER's output note leaf is domain-separated (btcNoteLeaf /
// btcNoteLeafBound) and bound to that OUTPUT's own x-only Taproot key as its spend authority —
// mirroring the guest's bitcoin::output_p2tr_xonly derivation — not the zero-owner sentinel (that
// pairing is for OP_BRIDGE_MINT's Ethereum-side dest leaf only). The ZERO_OWNER constant below still
// applies to non-CXFER envelope types that carry no destination P2TR of their own.
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
import { txOutputScript } from './burn-deposit-bitcoin.js';

const ZERO_OWNER = '0x' + '00'.repeat(32);
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join(''); // display ↔ internal

// burnDepositKit (injected by the worker, which owns the Bitcoin tooling) enables the scan-free TAC
// burn-deposit / cmint-deposit onboarding. The scan uses two of its members:
//   assembler: makeBurnDepositAssembler({dsha256, cat, bytesToHex}) — buildBurnDepositStatic + blob serializer + merkle helpers
//   admitBurnDeposit({ burnTxHex, envAsset, envNu, blobHex, provHeaders, burnedCx, burnedCy, batchPrevHash })
//     -> { admitted, reason, burnedTxid, burnedVout, burnedNoteLeaf } — the guest's admission decision for a burn of a
//     non-live note, over the exact blob and header chain the prover will read (dapp/burn-deposit-bitcoin.js)
// Absent → burn-deposits are not assembled (a burn tx with a provenance bundle then throws in the scan).
export function makeScanReflectionIndexer({ secp, keccak256, sha256, ownerTag, burnDepositKit, swapBatchVk } = {}) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const OWNER = ownerTag || ZERO_OWNER;
  let state = pool.makeScanReflectionState();
  let coords = new Map(); // outpointKey (lowercased hex) → { cx, cy } for every live pool note

  const internal = (displayTxid) => '0x' + reverseHex(displayTxid);
  const withHex = (raw) => (raw.startsWith('0x') ? raw : '0x' + raw);
  // Raw-hex <-> bytes + Bitcoin's double-sha256, needed to derive the block-level wtxid/txid arrays that
  // authenticate ANY burn-classified tx's own witness-commitment proof (see burnWitnessCtx below) — a fact
  // computable from data the scan ALREADY has for every tx in the block, independent of any holder bundle.
  const hexToBytes = (h) => { const s = String(h).replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return out; };
  const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const dsha = (b) => sha256(sha256(b));

  // The batch's prev_hash — headers[0][4..36], internal byte order, exactly as the guest reads it
  // (reflect.rs: `let prev_hash = headers[0][4..36]`). Set per assembleBlocks call.
  let batchPrevHash = null;

  // Cut a holder-submitted provenance header chain so it ends exactly at the batch's prev block.
  // The guest requires verify_header_chain(provHeaders) == prev_hash, but a burn-deposit bundle is a
  // STATIC artifact while the batch boundary moves forward on every attest — so a chain pinned to one
  // batch's prev is dead the moment that batch is missed, and the burn is stranded for good (its block is
  // scanned once and the cursor never rewinds). Holders therefore submit a chain with headroom and it is
  // trimmed to fit here. Sound because verify_header_chain checks only per-header PoW and linkage and
  // returns its LAST header's hash: any prefix of a valid chain is itself a valid chain, so trimming can
  // never admit a chain the untrimmed one wouldn't have. No match (the chain tops out below prev, or is
  // for another fork) → pass through untouched, and the guest skips the fold exactly as it does today.
  function trimProvHeaders(provHeaders) {
    if (!batchPrevHash || !Array.isArray(provHeaders) || !provHeaders.length) return provHeaders || [];
    // A holder-submitted entry that is not an 80-byte header hex makes the chain unusable, never a scan stall:
    // an empty chain is refused by admission exactly as the guest refuses it.
    if (!provHeaders.every((h) => typeof h === 'string' && /^(0x)?[0-9a-fA-F]{160}$/.test(h))) return [];
    for (let i = provHeaders.length - 1; i >= 0; i--) {
      if (bytesToHex(dsha(hexToBytes(withHex(provHeaders[i])))) === batchPrevHash) {
        return i === provHeaders.length - 1 ? provHeaders : provHeaders.slice(0, i + 1);
      }
    }
    return provHeaders;
  }

  // Block-level witness data (blockTxids, blockWtxids, coinbase) for a burn tx's own BIP141 inclusion proof —
  // derived ONCE per block from data the scan already fetched for every tx (rawHex + the esplora-trusted
  // txidDisplay), no separate raw-block fetch needed. Every burn-classified tx gets this REGARDLESS of
  // whether a holder-traced provenance bundle exists for it: the tx's own confirmation is an objective,
  // universally-computable Bitcoin fact, never gated on "did our worker trace this specific coin's history."
  function blockWitnessCtx(blockTxs) {
    return {
      blockTxids: blockTxs.map((t) => hexToBytes(internal(t.txidDisplay))),
      blockWtxids: blockTxs.map((t) => dsha(hexToBytes(withHex(t.rawHex)))),
      coinbase: withHex(blockTxs[0].rawHex),
    };
  }

  // Build the burn-deposit fold context from a holder-traced provenance bundle (the worker assembles this
  // off-chain via the tracer + its Bitcoin tooling) and the burn tx's own facts (`burn` = { rawHex, env, vins }).
  // The bundle contributes only the provenance and the burned note's opening; the admission decision is the
  // guest's (admitBurnDeposit) and the canonical scan (foldBurnDepositTx) performs the fold.
  //   bundle = { burned:{cx,cy},
  //              etch:{tx,blockTxids,blockWtxids,coinbase,index}, provHeaders:[hex],
  //              cxfers:[{tx,txid,inputs:[{prevTxid,prevVout,commitment}],outputs:[{commitment,vout}],
  //                        rangeProof,kernelSig,blockTxids,blockWtxids,coinbase,index}],
  //              cmints:[{revealTx,commitTx,blockTxids,blockWtxids,coinbase,index}] } (cmints empty for fixed-supply)
  function buildBurnDepositCtx(bundle, burn) {
    if (!burnDepositKit) throw new Error('scan indexer: burn-deposit tx present but no burnDepositKit injected');
    const { assembler } = burnDepositKit;
    const Z = ZERO_OWNER;
    const hex32 = (h) => (typeof h === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(h) ? withHex(h).toLowerCase() : Z);
    // Cut to this batch's prev once, then use the SAME array for both the admission decision and the witness:
    // the guest verifies the very bytes it folds on, so these must not diverge.
    const provHeaders = trimProvHeaders(bundle.provHeaders);
    // The static provenance witness and its serialized blob. A malformed bundle (a record the witness builder
    // cannot place) is simply not admissible; it must never throw and stall the scan.
    let stat = null;
    let blob = '0x';
    try {
      stat = assembler.buildBurnDepositStatic({
        etch: bundle.etch, provHeaders, cxfers: bundle.cxfers || [], cmints: bundle.cmints || [],
        poolMemberships: bundle.poolMemberships || [],
      });
      blob = bytesToHex(assembler.serializeProvenanceBlob(stat));
    } catch { stat = null; blob = '0x'; }
    // The guest binds the burned outpoint to the burn tx's own first input and the ν / dest / target to its own
    // envelope, never to what a bundle claims. Admission is decided over exactly the blob and header chain that
    // will be emitted, with the guest's full set of checks.
    const vin0 = (burn.vins && burn.vins[0]) || { prevTxid: Z, vout: 0 };
    const verdict = (stat && !bundle.unbundled && burnDepositKit.admitBurnDeposit)
      ? burnDepositKit.admitBurnDeposit({
        burnTxHex: withHex(burn.rawHex), envAsset: burn.env.assetId, envNu: burn.env.nullifier, blobHex: blob, provHeaders,
        burnedCx: hex32(bundle.burned && bundle.burned.cx), burnedCy: hex32(bundle.burned && bundle.burned.cy), batchPrevHash,
      })
      : { admitted: false, burnedTxid: vin0.prevTxid, burnedVout: vin0.vout, burnedNoteLeaf: null };
    const valid = !!verdict.admitted;
    const bw = bundle.burnTxWitness ? assembler.witnessPath(bundle.burnTxWitness, 'burn') : { wtxidSiblings: [], coinbaseTxidSiblings: [] };
    return {
      valid,
      reason: verdict.reason,
      asset: hex32(burn.env.assetId),
      nu: hex32(burn.env.nullifier),
      dest: hex32(burn.env.dest),
      target: hex32(burn.env.target),
      // The burned note's Bitcoin outpoint: the burn tx's first spent input. It owns the burned note's leaf and keys
      // both the cross-lane consumed-outpoint check and the DEPOSIT-class bridge_burn_id.
      burnedTxid: verdict.burnedTxid || vin0.prevTxid,
      burnedVout: verdict.burnedTxid ? verdict.burnedVout : vin0.vout,
      burnedCx: valid ? hex32(bundle.burned.cx) : Z,
      burnedCy: valid ? hex32(bundle.burned.cy) : Z,
      burnedNoteLeaf: valid ? verdict.burnedNoteLeaf : Z,
      witness: {
        ...(stat || {}),
        // Only an admitted burn carries its header chain and DAG. Anything else emits both empty, which the guest's
        // blob parse refuses, so it folds nothing — the same outcome the guest reaches for a refused bundle.
        provHeaders: valid ? provHeaders : [],
        blob: valid ? blob : '0x',
        // The burn tx's OWN witness-commitment inclusion proof: the guest authenticates the 0x2B envelope with it
        // for every burn of a non-live note, admitted or not.
        burnWtxidSiblings: bw.wtxidSiblings,
        burnCbTxidSiblings: bw.coinbaseTxidSiblings,
      },
    };
  }

  // One worker block-tx → the assembler's tx spec. Plain txs carry only vins (their pool-UTXO
  // spends are detected by the scan); cxfer txs declare output notes; burn txs declare ν → dest.
  function txSpec(tx, burnDeposits, blockCtx, txIndex) {
    const vins = (tx.vins || []).map((vi) => ({ prevTxid: internal(vi.prevTxidDisplay), vout: vi.vout }));
    const txid = internal(tx.txidDisplay);
    let env = null;
    if (tx.decode && tx.decode.type === 'cxfer') {
      env = {
        type: 'cxfer',
        opcode: tx.decode.opcode, // env[0]: distinguishes pure CXFER (0x22/0x23) from the atomic-settlement family / bids
        // T_AXFER / T_AXFER_BPP: the kernel's asset inputs are vin[1..1+assetInputCount] (null for every other opcode).
        assetInputCount: tx.decode.assetInputCount == null ? null : tx.decode.assetInputCount,
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
          // A confirmed CXFER's reflected note leaf is domain-separated (btcNoteLeaf) and bound to the
          // OUTPUT'S OWN x-only Taproot key as its spend authority (cxfer-core::fold_cxfer / reflected_note_leaf
          // — the guest derives it the same way, from the confirmed tx's OWN output script at this vout via
          // bitcoin::output_p2tr_xonly, defaulting to zero for a non-P2TR output). NOT the plain native `leaf`
          // and NOT the zero-owner sentinel — that pairing is for OP_BRIDGE_MINT's Ethereum-side dest leaf only.
          const authKey = pool.p2trXonly(txOutputScript(tx.rawHex, vout)) || ZERO_OWNER;
          return { cx, cy, compressed: comm, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.btcNoteLeaf(tx.decode.assetId, cx, cy, authKey), vout };
        }),
      };
    } else if (tx.decode && tx.decode.type === 'cxfer_bound') {
      // A deployment-bound CXFER (0x39): onboard BOUND output notes. Same shape as cxfer with the envelope's
      // target_chain_binding surfaced (the assembler requires it == this deployment's chainBinding) and each
      // note leaf built over the bound domain (btcNoteLeafBound), mirroring the guest's fold_cxfer_bound.
      env = {
        type: 'cxfer_bound',
        opcode: tx.decode.opcode,
        target: tx.decode.target,
        assetId: tx.decode.assetId,
        kernelSig: tx.decode.kernelSig,
        rangeProof: tx.decode.rangeProof,
        outputs: tx.decode.commitments.map((comm, j) => {
          const { cx, cy } = pool.decompressCommitment(comm);
          const vout = (tx.decode.vouts && tx.decode.vouts[j] != null) ? tx.decode.vouts[j] : (j + (tx.decode.voutBase || 0));
          // Same output-own-key spend authority as the unbound path above (cxfer-core::fold_cxfer_bound /
          // reflected_note_leaf_bound) — NOT the zero-owner sentinel.
          const authKey = pool.p2trXonly(txOutputScript(tx.rawHex, vout)) || ZERO_OWNER;
          return { cx, cy, compressed: comm, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.btcNoteLeafBound(tx.decode.assetId, cx, cy, authKey, tx.decode.target), vout };
        }),
      };
    } else if (tx.decode && tx.decode.type === 'burn') {
      env = { type: 'burn', assetId: tx.decode.assetId || null, nullifier: tx.decode.nullifier || null, dest: tx.decode.dest, target: tx.decode.target || null };
      // BURN-DEPOSIT (scan-free TAC/cmint onboarding): a 0x2B burn of a pre-existing note (no live-set
      // spend). If the worker supplied this tx's holder-traced provenance bundle, assemble the fold
      // context (the canonical scan folds it iff the realness mirror admits it).
      const bundle = burnDeposits && burnDeposits.get(tx.txidDisplay);
      // The burn tx's OWN witness-commitment inclusion proof — a fact the guest checks UNCONDITIONALLY for
      // EVERY 0x2B burn (reflect.rs: "a real burn tx is always committed, so a failure is a bad prover
      // witness (abort)"), regardless of whether we have a holder-traced provenance bundle for the burned
      // coin. It is computable purely from THIS block's already-fetched tx data — never bundle-dependent.
      // Omitting it turns ANY burn of a coin we haven't traced into a hard guest panic: an ordinary 0x2B
      // burn of a note nobody has bundled, with no crafted transaction needed, would permanently halt the
      // reflection pipeline.
      const burnTxWitness = blockCtx ? { blockTxids: blockCtx.blockTxids, blockWtxids: blockCtx.blockWtxids, coinbase: blockCtx.coinbase, tx: withHex(tx.rawHex), index: txIndex } : null;
      const burnFacts = { rawHex: tx.rawHex, env, vins };
      if (bundle) {
        env.burnDeposit = buildBurnDepositCtx({ ...bundle, burnTxWitness: bundle.burnTxWitness || burnTxWitness }, burnFacts);
      } else if (burnTxWitness) {
        // No provenance bundle: build the minimal ("no admissible leaf") synthetic bundle. etch=null and
        // poolMemberships=[] make buildBurnDepositCtx naturally compute valid=false (no fold — the same
        // outcome as BD_SKIP_CTX), while still supplying the REAL, always-available witness-
        // commitment proof the guest unconditionally requires. Flagged `burnDepositUnbundled` so the
        // assembler can tell "nobody registered this burn" apart from "a bundle was checked and rejected" —
        // the two are indistinguishable from the ctx shape alone once built, since this fold's own fields
        // are opaque sentinels either way.
        env.burnDeposit = buildBurnDepositCtx({
          assetId: env.assetId, etch: null, cmints: [], cxfers: [], poolMemberships: [],
          burned: { cx: ZERO_OWNER, cy: ZERO_OWNER }, burnTxWitness, unbundled: true,
        }, burnFacts);
        env.burnDepositUnbundled = true;
      }
    } else if (tx.decode && (tx.decode.type === 'mint' || tx.decode.type === 'cmint')) {
      // A confidential-mint value-entry (T_MINT/cmint). The conservation-closed full-scan model does
      // NOT yet reflect it (no free-output deposit path); surface it so the assembler can flag the
      // un-onboarded value rather than silently treating the tx as plain.
      env = { type: 'mint', assetId: tx.decode.assetId };
    } else if (tx.decode && ['swap_var', 'swap_route', 'harvest', 'farm_refund', 'protocol_fee_claim', 'farm_init', 'swap_batch', 'lp_add', 'lp_remove', 'lp_bond', 'lp_unbond', 'cbtc_lock', 'cbtc_redeem', 'crossout_mint', 'eth_call'].includes(tx.decode.type)) {
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
    // Fail-loud on a routing gap: a classified Tacit envelope the guest reads a witness for, but no branch
    // above routed (env still null), is surfaced 'unsupported' so the attester refuses this batch rather than
    // emitting a witness-short stream (which the guest reads past → a silent wrong digest → permanent halt).
    // All currently-classified types are routed above; this stalls a FUTURE unrouted fold loudly instead of
    // letting it desync.
    if (tx.decode && env == null) env = { type: 'unsupported', opcode: tx.decode.opcode };
    return { txData: withHex(tx.rawHex), txid, txidDisplay: tx.txidDisplay, vins, env };
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
  async function assembleBlocks(input, { headers, anchorHeight, burnDeposits, ethBundle, consumedSources, chainBinding } = {}) {
    const streaming = input && typeof input.getRawBlock === 'function';
    const blockCount = streaming ? input.blockCount : ((input && input.length) || 0);
    const getRawBlock = streaming ? input.getRawBlock : ((i) => input[i]);
    // Pin this batch's prev block before any getBlock() runs — trimProvHeaders (called from the burn-deposit
    // path inside txSpec) cuts each holder-submitted chain to end here.
    batchPrevHash = (headers && headers.length) ? bytesToHex(hexToBytes(withHex(headers[0])).slice(4, 36)) : null;
    // Pending burn-deposits recorded by earlier batches whose provenance bundle is now registered: each is checked
    // against this batch's anchor with the same admission as a scanned burn, and only an admitted one is handed to
    // the assembler as a completion (the guest aborts on one that does not verify). A bundle that still fails stays
    // pending for a later batch.
    const depositCompletions = [];
    if (burnDepositKit && burnDeposits) {
      for (const rec of state.pendingDepositRecords()) {
        if (rec.completed || !rec.burnTxid || !rec.burnTxData) continue;
        const bundle = burnDeposits.get(rec.burnTxidDisplay || reverseHex(rec.burnTxid));
        if (!bundle) continue;
        // A completion is optional: one that cannot be built from its bundle is simply not offered this batch.
        try {
          const ctx = buildBurnDepositCtx({ ...bundle, burnTxWitness: null }, {
            rawHex: rec.burnTxData,
            env: { assetId: rec.asset, nullifier: rec.nu, dest: rec.dest, target: rec.target },
            vins: [{ prevTxid: rec.burnedTxid, vout: rec.burnedVout }],
          });
          if (ctx.valid) depositCompletions.push({ ...ctx, burnedTxid: rec.burnedTxid, burnedVout: rec.burnedVout });
        } catch { /* stays pending */ }
      }
    }
    const batch = {
      depositCompletions,
      // DEPLOYMENT BINDING: keccak(chainid ‖ poolAddress). The assembler reads it after the rebase flag and
      // commits it; the bound CXFER fold (0x39) requires the envelope target == this value. 0 when unset.
      chainBinding: chainBinding || null,
      anchorHeight, headers, blockCount,
      getBlock: async (i) => {
        const b = await getRawBlock(i);
        const blockTxs = b.txs || [];
        const bwc = blockTxs.length ? blockWitnessCtx(blockTxs) : null;
        return { txs: blockTxs.map((tx, ti) => txSpec(tx, burnDeposits, bwc, ti)) };
      },
    };
    // swap_batch (0x2F): the per-0x2F hook the assembler awaits — verifies the BN254 Groth16 against the pool's
    // fold-point reserves (vk == the guest's batch_vk.bin) then onboards the n receipts. Built per-call so it
    // captures the CURRENT `state` (load() may have replaced it). Absent vk ⇒ no hook ⇒ swap_batch surfaces as
    // unsupported and the attester refuses (liveness, never a wrong digest — see the assembler's swap_batch arm).
    if (swapBatchVk) batch.swapBatchFold = (env, txid, spends, opts = {}) => foldSwapBatch(pool, state, env, txid, spends, { vk: swapBatchVk, ...opts });
    // Mode-B reverse reflection (ETH→BTC): given the eth proof's attested sets (ethBundle — eth_prove emits it
    // alongside eth_pv.hex: { ethPv, crossouts:[{claimId,destCommitment,asset}], consumeds:[{nu,spendRoot}] })
    // plus the resolved Bitcoin source note per consumed ν (consumedSources), assemble the mode_b=1 witnesses:
    // the cross-out IMT (modeB.crossoutImt, which the assembler proves each 0x65 against) + the consumed-ν fast
    // lane. Absent ethBundle ⇒ a forward batch (mode_b=0) — every 0x65 skips against crossout_set_root=0.
    if (ethBundle) {
      const { modeB } = pool.buildModeBBatch(ethBundle, [], consumedSources || [], Number(state.getConsumedCount()));
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
      honoredMsgLinks: state.honoredMsgLinks(),
      foldedCrossoutCount: String(state.getFoldedCrossoutCount()),
      farmRewards: state.farmRewards.list(),
      farmEntries: state.farmEntries.list(),
      // CROSS-LANE DOUBLE-MINT GATE (rides digest(), last field): a cold restore after a fast-lane consume
      // must carry this or the resumed digest silently drops the consumed-outpoints set back to genesis and
      // diverges from knownReflectionDigest.
      consumedOutpointsLinks: state.consumedOutpointsLinks(),
      // The Mode-B sync-committee anchor and the pending burn-deposit set (both ride digest()), plus each pending
      // record's envelope fields and burn tx so a later batch can complete it.
      ethSyncCommittee: state.getEthSyncCommittee(),
      pendingDepositNodes: state.pendingDepositNodes(),
      pendingDepositRecords: state.pendingDepositRecords(),
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
    state._acc.live.load(snap.liveTriples || []); // the live UTXO set: (key, commitmentHash, asset, authKey, bound) tuples — O(n log n)
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
    if ((snap.honoredMsgLinks || []).length) state.setHonoredMsgLinks(snap.honoredMsgLinks);
    if (snap.foldedCrossoutCount != null) state.setFoldedCrossoutCount(snap.foldedCrossoutCount);
    if ((snap.farmRewards || []).length) state.farmRewards.load(snap.farmRewards);
    if ((snap.farmEntries || []).length) state.farmEntries.load(snap.farmEntries);
    if ((snap.consumedOutpointsLinks || []).length) state.setConsumedOutpointsLinks(snap.consumedOutpointsLinks);
    if (snap.ethSyncCommittee) state.setEthSyncCommittee(snap.ethSyncCommittee);
    if ((snap.pendingDepositNodes || []).length) state.setPendingDepositNodes(snap.pendingDepositNodes);
    if ((snap.pendingDepositRecords || []).length) state.setPendingDepositRecords(snap.pendingDepositRecords);
  }

  return {
    pool, assembleBlocks, snapshot, load,
    state: () => state,
    // Display txids of burns recorded pending and not yet completed — a caller fetches their registered bundles
    // alongside the batch's own txids so assembleBlocks can complete them.
    pendingBurnTxids: () => state.pendingDepositRecords().filter((r) => !r.completed && r.burnTxid).map((r) => r.burnTxidDisplay || reverseHex(r.burnTxid)),
    coords: () => coords,
    digest: () => state.digest(),
    roots: () => state.commit(),
    liveCount: () => state.counts().live,
  };
}
