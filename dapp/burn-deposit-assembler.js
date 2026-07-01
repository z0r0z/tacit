// Assembles the TAC burn-deposit witness (the reflect.rs `burnDeposit` field) from the provenance data the
// worker traces off Bitcoin: the asset's CETCH (committing C_0), the conserving cxfer DAG from the note back
// to C_0, the pre-anchor header chain, the burned note, and the bridge-out (ν → dest). Reuses the pool's IMT
// (foldSpent/foldBurn) for the insert witnesses + a Bitcoin merkle-path builder for inclusion.
//
// Division of labour: the reflection guest's dispatch VALIDATES this witness (verify_provenance over the
// canonical chain); the liveness mirror (burn-deposit-provenance.js) decides WHICH burn-deposits to assemble;
// the LIVE provenance tracing (walking the cxfer graph back to C_0 via the reflection indexer + fetching the
// pre-anchor headers) is the worker's job. This module builds the witness GIVEN that data — the same shape
// gen-reflection-burn-deposit.mjs produces synthetically, so the generator's native-exec exercises it.
//
// The guest's burn_deposit.rs binds each
// provenance/etch/cmint step to the ACTUAL confirmed tx: it derives the txid (computed, not free), the
// CXFER/CETCH/CMINT envelope, and the input outpoints FROM the tx bytes, and authenticates the witness via the
// BIP141 commitment (wtxid merkle path + the same-block coinbase). So each provenance tx now needs, instead of
// a free txid + separately-witnessed inputs/outputs/kernel/range: the full `tx` bytes, the spent-note
// `inputCommitments` (points only; Bitcoin records just the outpoint), the produced `outputVouts`, and the
// witness-commitment proof — `wtxidSiblings` (over the block's wtxids, coinbase wtxid := 0), `coinbase` (the
// tx carrying the 6a24aa21a9ed commitment + reserved-value witness), and `coinbaseTxidSiblings` (the coinbase
// at txid index 0). The worker's tracer must therefore fetch each provenance block's coinbase + wtxids. This
// module, the SP1-stdin serializer + foldBurnDepositTx mirror in confidential-pool.js, and the generator use
// this same shape. A record's `blockWtxids` is the full ordered wtxid list; its coinbase leaf MUST be the
// BIP141 zero sentinel (the helper enforces that instead of trusting a fetched coinbase wtxid).
//
// Deps (injected so the worker + the test generator each supply their own Bitcoin helpers):
//   dsha256(Uint8Array) -> Uint8Array     (double-SHA256, internal order)
//   cat([Uint8Array]) -> Uint8Array
//   bytesToHex(Uint8Array) -> "0x…"       (0x-prefixed, as the guest/harness reads via hexv)
export function makeBurnDepositAssembler({ dsha256, cat, bytesToHex }) {
  // Bitcoin merkle inclusion path (siblings, 0x-hex) for the tx at `index` among `txids` (internal-order
  // bytes). Empty for a single-tx block. Mirrors compute_merkle_root's odd-leaf duplication.
  function merkleSiblings(txids, index) {
    const sibs = [];
    let layer = txids.map((t) => Uint8Array.from(t));
    let idx = index >>> 0;
    while (layer.length > 1) {
      const sibIdx = (idx ^ 1) < layer.length ? (idx ^ 1) : idx;
      sibs.push(bytesToHex(layer[sibIdx]));
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const l = layer[i];
        const r = i + 1 < layer.length ? layer[i + 1] : layer[i];
        next.push(dsha256(cat([l, r])));
      }
      layer = next;
      idx = idx >>> 1;
    }
    return sibs;
  }
  function merkleRoot(txids) {
    if (!txids.length) throw new Error('merkleRoot: empty block');
    let layer = txids.map((t) => Uint8Array.from(t));
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const l = layer[i];
        const r = i + 1 < layer.length ? layer[i + 1] : layer[i];
        next.push(dsha256(cat([l, r])));
      }
      layer = next;
    }
    return bytesToHex(layer[0]);
  }

  const ZERO32 = new Uint8Array(32);
  function witnessPath(record, label) {
    if (!Array.isArray(record.blockTxids) || !Array.isArray(record.blockWtxids)) {
      throw new Error(`${label}: blockTxids and blockWtxids required`);
    }
    if (record.blockTxids.length !== record.blockWtxids.length || record.index <= 0 || record.index >= record.blockTxids.length) {
      throw new Error(`${label}: witness arrays/index invalid (protocol tx must follow coinbase)`);
    }
    if (typeof record.coinbase !== 'string' || !record.coinbase.startsWith('0x')) {
      throw new Error(`${label}: raw coinbase required`);
    }
    const wtxids = record.blockWtxids.map((x, i) => i === 0 ? ZERO32 : x);
    return {
      wtxidSiblings: merkleSiblings(wtxids, record.index),
      coinbase: record.coinbase,
      coinbaseTxidSiblings: merkleSiblings(record.blockTxids, 0),
    };
  }

  // Build the burnDeposit witness.
  //   etch:       { tx:"0x…", blockTxids:[bytes], blockWtxids:[bytes], coinbase:"0x…", index }
  //   provHeaders:["0x…"] (the pre-anchor chain whose tip == the batch anchor's prev_hash)
  //   cxfers:     [{ txid:"0x…", inputs:[{prevTxid,prevVout,commitment}], outputs:[{commitment,vout}],
  //                  rangeProof:"0x…", kernelSig:"0x…", blockTxids:[bytes], index }]
  //   burned:     { cx:"0x…", cy:"0x…" }
  //   burnedNoteLeaf: "0x…" — leaf(asset, cx, cy, ZERO_OWNER); the proven-real note appended to the pool
  //                   tree so OP_BRIDGE_MINT binds v_mint == v_burn (caller computes via pool.leaf)
  //   nu, dest:   "0x…" (the burned note's nullifier + the bridge-out destination commitment)
  //   scanState:  pool.makeScanReflectionState() positioned at the batch's prior (advances on fold*)
  // The STATE-INDEPENDENT part of the witness: the etch + cxfers + cmints with their Bitcoin merkle paths
  // resolved. The live worker builds this from the holder-traced provenance; the canonical scan
  // (foldBurnDepositTx) then appends the state-dependent IMT inserts at the fold point.
  function buildBurnDepositStatic({ etch, provHeaders, cxfers, cmints = [] }) {
    const ew = witnessPath(etch, 'etch');
    return {
      etchTx: etch.tx,
      etchIndex: etch.index,
      etchSiblings: merkleSiblings(etch.blockTxids, etch.index),
      etchWtxidSiblings: ew.wtxidSiblings,
      etchCoinbase: ew.coinbase,
      etchCoinbaseTxidSiblings: ew.coinbaseTxidSiblings,
      provHeaders,
      cxfers: cxfers.map((c, i) => {
        const w = witnessPath(c, `cxfer[${i}]`);
        return {
          tx: c.tx,
          inputCommitments: c.inputs.map((x) => x.commitment),
          outputVouts: c.outputs.map((x) => x.vout),
          burnedAmount: c.burnedAmount || 0,
          merkleSiblings: merkleSiblings(c.blockTxids, c.index),
          merkleIndex: c.index,
          confirmedBlockRoot: merkleRoot(c.blockTxids),
          wtxidSiblings: w.wtxidSiblings,
          coinbase: w.coinbase,
          coinbaseTxidSiblings: w.coinbaseTxidSiblings,
        };
      }),
      // mintable: issuer-authorized cmints in the lineage (revealTx + commitTx + reveal merkle inclusion).
      // Empty for fixed-supply. cm: { revealTx, commitTx, blockTxids, index }.
      cmints: cmints.map((cm, i) => {
        const w = witnessPath(cm, `cmint[${i}]`);
        return {
          revealTx: cm.revealTx,
          commitTx: cm.commitTx,
          merkleSiblings: merkleSiblings(cm.blockTxids, cm.index),
          merkleIndex: cm.index,
          revealWtxidSiblings: w.wtxidSiblings,
          revealCoinbase: w.coinbase,
          revealCoinbaseTxidSiblings: w.coinbaseTxidSiblings,
        };
      }),
    };
  }

  // Serialize the provenance DAG (the static part of the witness) to the byte blob the burn tx's Taproot
  // witness carries (appended after the 129-byte burn envelope) and the guest reads via
  // burn_deposit::ProvenanceBlob::parse(env[129..]). Mirrors cxfer-core/src/burn_deposit.rs serialize()
  // byte-for-byte: length-prefixed, little-endian counts. `static` is buildBurnDepositStatic's output.
  function serializeProvenanceBlob(stat) {
    const hexToBytes = (h) => {
      h = h.startsWith('0x') ? h.slice(2) : h;
      const a = new Uint8Array(h.length / 2);
      for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
      return a;
    };
    const parts = [];
    const u32 = (v) => { const b = new Uint8Array(4); b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; b[2] = (v >>> 16) & 0xff; b[3] = (v >>> 24) & 0xff; parts.push(b); };
    const u64 = (v) => { const b = new Uint8Array(8); let n = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } parts.push(b); };
    const raw = (h) => { const b = hexToBytes(h); parts.push(b); return b; };
    const bytes = (h) => { const b = hexToBytes(h); u32(b.length); parts.push(b); }; // pb_bytes
    const fixed = (h, n) => { const b = hexToBytes(h); if (b.length !== n) throw new Error(`blob: expected ${n} bytes`); parts.push(b); };
    const v32 = (arr) => { u32(arr.length); for (const x of arr) fixed(x, 32); };  // pb_v32
    const v33 = (arr) => { u32(arr.length); for (const x of arr) fixed(x, 33); };  // pb_v33
    const vu32 = (arr) => { u32(arr.length); for (const x of arr) u32(x >>> 0); }; // pb_vu32

    // headers (Vec<Vec<u8>>)
    u32(stat.provHeaders.length);
    for (const h of stat.provHeaders) bytes(h);
    // etch
    bytes(stat.etchTx);
    u32(stat.etchIndex >>> 0);
    v32(stat.etchSiblings);
    v32(stat.etchWtxidSiblings);
    bytes(stat.etchCoinbase);
    v32(stat.etchCoinbaseTxidSiblings);
    // cmints
    u32(stat.cmints.length);
    for (const c of stat.cmints) {
      bytes(c.revealTx);
      bytes(c.commitTx);
      v32(c.merkleSiblings);
      u32(c.merkleIndex >>> 0);
      v32(c.revealWtxidSiblings);
      bytes(c.revealCoinbase);
      v32(c.revealCoinbaseTxidSiblings);
    }
    // prov (ProvenanceWitness)
    u32(stat.cxfers.length);
    for (const p of stat.cxfers) {
      bytes(p.tx);
      v33(p.inputCommitments);
      vu32(p.outputVouts);
      u64(p.burnedAmount || 0);
      u32(p.merkleIndex >>> 0);
      v32(p.merkleSiblings);
      fixed(p.confirmedBlockRoot, 32);
      v32(p.wtxidSiblings);
      bytes(p.coinbase);
      v32(p.coinbaseTxidSiblings);
    }
    return cat(parts);
  }

  function assembleBurnDeposit({ burnWtxidSiblings, burnCbTxidSiblings, burned, burnedNoteLeaf, nu, dest, scanState }) {
    return {
      // The burn tx's witness-commitment proof: the wtxid path (over the scan block's witness tree) + the
      // coinbase-txid path (the guest authenticates the burn tx's witness, which carries the provenance blob).
      burnWtxidSiblings,
      burnCbTxidSiblings,
      burnedCx: burned.cx,
      burnedCy: burned.cy,
      // Fold order mirrors the guest dispatch: fold_spent → fold_note_append → fold_burn (independent
      // accumulators, but kept in lockstep). foldNoteAppend onboards the burned note as a pool member.
      spentInsert: scanState.foldSpent(nu),
      notePath: scanState.foldNoteAppend(burnedNoteLeaf).notePath,
      burnInsert: scanState.foldBurn(nu, dest),
    };
  }

  return { assembleBurnDeposit, buildBurnDepositStatic, serializeProvenanceBlob, merkleSiblings, merkleRoot, witnessPath };
}
