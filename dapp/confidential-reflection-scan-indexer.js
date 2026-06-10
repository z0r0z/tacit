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
//         | { type:'cxfer', assetId, commitments:[compressed-33 hex] }
//         | { type:'burn', dest }             // destCommitment (bound by the guest from the envelope)
// } ] }

import { makeConfidentialPool } from './confidential-pool.js';

const ZERO_OWNER = '0x' + '00'.repeat(32);
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join(''); // display ↔ internal

export function makeScanReflectionIndexer({ secp, keccak256, sha256, ownerTag } = {}) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const OWNER = ownerTag || ZERO_OWNER;
  let state = pool.makeScanReflectionState();
  let coords = new Map(); // outpointKey (lowercased hex) → { cx, cy } for every live pool note

  const internal = (displayTxid) => '0x' + reverseHex(displayTxid);
  const withHex = (raw) => (raw.startsWith('0x') ? raw : '0x' + raw);

  // One worker block-tx → the assembler's tx spec. Plain txs carry only vins (their pool-UTXO
  // spends are detected by the scan); cxfer txs declare output notes; burn txs a bridge-out dest.
  function txSpec(tx) {
    const vins = (tx.vins || []).map((vi) => ({ prevTxid: internal(vi.prevTxidDisplay), vout: vi.vout }));
    const txid = internal(tx.txidDisplay);
    let env = null;
    if (tx.decode && tx.decode.type === 'cxfer') {
      env = {
        type: 'cxfer',
        outputs: tx.decode.commitments.map((comm, j) => {
          const { cx, cy } = pool.decompressCommitment(comm);
          return { cx, cy, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.leaf(tx.decode.assetId, cx, cy, OWNER), vout: j };
        }),
      };
    } else if (tx.decode && tx.decode.type === 'burn') {
      env = { type: 'burn', dest: tx.decode.dest };
    }
    return { txData: withHex(tx.rawHex), txid, vins, env };
  }

  // Advance the canonical state over a batch of confirmed blocks (each `{ txs: [...] }`, in block
  // order) and return the full-scan prover input. `headers` = the batch's 80-byte block headers;
  // `anchorHeight` = headers[0]'s confirmed height. ADVANCES state + coords (the assembler scans
  // every tx's vins, folds the detected effects). Returns the input the box's exec harness writes.
  function assembleBlocks(blocks, { headers, anchorHeight }) {
    const batch = { anchorHeight, headers, blocks: blocks.map((b) => ({ txs: (b.txs || []).map(txSpec) })) };
    return pool.assembleReflectionScanInput(state, batch, coords);
  }

  // Serialize the canonical state for restart-durable persistence (the full accumulators — the
  // witnessed transitions need their leaves to build paths). Compact: the live set + coords are
  // O(live); the note/spent/burn histories grow with activity (a frontier compaction is a pilot
  // follow-up). load() replays it into a fresh state.
  function snapshot() {
    return {
      noteLeaves: state._acc.notes.leaves.map((l) => '0x' + Buffer.from(l).toString('hex')),
      spentLinks: state._acc.spent.links(),
      livePairs: state._acc.live.pairs(),
      burnNodes: state._acc.burns.nodes(),
      height: state.counts().height,
      coords: [...coords.entries()],
    };
  }
  function load(snap) {
    state = pool.makeScanReflectionState();
    coords = new Map();
    if (!snap) return;
    for (const leaf of (snap.noteLeaves || [])) state._acc.notes.insert(leaf);
    for (const [val] of (snap.spentLinks || []).slice(1)) state._acc.spent.insert(val); // skip the {0→0} sentinel
    for (const [key, , value] of (snap.burnNodes || []).slice(1)) state._acc.burns.insert(key, value);
    state._acc.live.load(snap.livePairs || []);
    if (snap.height) state.setHeight(snap.height);
    for (const [k, v] of (snap.coords || [])) coords.set(k, v);
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
