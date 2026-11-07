// Live implementation of dapp/burn-deposit-tracer.js's `getCxferByOutput` dependency — the piece that never
// existed (see ops/DESIGN-burndep-live-tracer.md for the full design rationale). Every burn-deposit that has
// actually landed (1000 TAC, 100 TAC, 250k, 1M) was built by hand from pre-computed JSON files; this is the
// automated equivalent, built from public esplora data alone.
//
// classifyConfidentialTx only decodes what a transaction PRODUCES (its own output commitments + their real
// vouts). It says nothing about which commitment each of the transaction's INPUTS spent — that's only knowable
// by resolving the input's own producing transaction, one hop further back. This module does exactly that one
// hop per input; the recursion ACROSS hops is burn-deposit-tracer.js's own job (its outer queue/loop), not
// this module's.
//
// Returns the FULL shape burn-deposit-tracer.js's own doc comment specifies (tx + inputs + outputs +
// block-level merkle data) by default — lets a caller run the SAME local verification the scratchpad scripts
// that built every real burn already do (re-deriving the guest's own checks before ever submitting). The
// block-level portion of that shape costs a full raw-block download+parse per hop, on top of the per-tx
// fetches, so a caller that only needs the minimal {tx, blockHash} shape /reflection/burndep's registration
// door actually requires (the server fills in the rest automatically at fold time via enrichBurnDeposit/
// blockWitness — see reflection-attest.js) can skip it via `fullBlockWitness: false` — the only lever that
// shortens total trace time, since a DAG walk is inherently sequential (each hop's inputs are unknown until
// the hop before it resolves). traceBurnDepositProvenance, the one real caller today, defaults to skipping it.

import { classifyConfidentialTx, extractTaprootEnvelope, parseCetch } from '../../dapp/burn-deposit-bitcoin.js';
import { splitBlockTxs } from './bitcoin-block-parse.js';

const stripHexPrefix = (h) => String(h).replace(/^0x/, '');
const withHexPrefix = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + h);
const hexToBytes = (h) => { const s = stripHexPrefix(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const reverseBytes = (b) => Uint8Array.from(b).reverse();
const SHALLOW_V = 2;

// A transaction's raw bytes rebuilt from esplora's JSON for it (version, each input's outpoint, scriptSig, sequence and
// witness, each output's value and script, locktime), or null unless the rebuilt bytes hash to `txidDisplay`. The witness
// is not covered by the txid, but esplora gives each witness item's exact bytes, and the reflection's fold reads every
// provenance transaction from its block anyway (burndep-admission.js withInclusion), so what it proves is the block's own.
export function rebuiltRawTx(j, txidDisplay, dsha256) {
  try {
    const le = (n, bytes) => { let h = '', v = BigInt(n); for (let i = 0; i < bytes; i++) { h += Number(v & 0xffn).toString(16).padStart(2, '0'); v >>= 8n; } return h; };
    const vi = (n) => (n < 0xfd ? le(n, 1) : n <= 0xffff ? 'fd' + le(n, 2) : n <= 0xffffffff ? 'fe' + le(n, 4) : 'ff' + le(n, 8));
    const field = (h) => { const s = stripHexPrefix(h || '').toLowerCase(); if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error('hex'); return vi(s.length / 2) + s; };
    const rev = (h) => stripHexPrefix(h).match(/../g).reverse().join('');
    const vin = j.vin || [], vout = j.vout || [];
    if (!Number.isInteger(j.version) || !Number.isInteger(j.locktime) || !vin.length) return null;
    let body = vi(vin.length);
    for (const v of vin) body += rev(v.txid) + le(v.vout >>> 0, 4) + field(v.scriptsig) + le(v.sequence >>> 0, 4);
    body += vi(vout.length);
    for (const o of vout) body += le(o.value, 8) + field(o.scriptpubkey);
    const version = le(j.version >>> 0, 4), locktime = le(j.locktime >>> 0, 4);
    const txid = rev(Array.from(dsha256(hexToBytes(version + body + locktime)), (b) => b.toString(16).padStart(2, '0')).join(''));
    if (txid !== stripHexPrefix(txidDisplay).toLowerCase()) return null;
    // An input spending a segwit output carries a witness. JSON with none for it (a mirror that left witnesses out) would rebuild
    // a transaction with its envelope missing, which the txid cannot catch, so the raw hex is asked for instead.
    const witnessed = (v) => Array.isArray(v.witness) && v.witness.length > 0;
    if (vin.some((v) => !witnessed(v) && (!v.prevout || /^v\d_/.test(String(v.prevout.scriptpubkey_type || ''))))) return null;
    if (!vin.some(witnessed)) return version + body + locktime;
    let witness = '';
    for (const v of vin) { const w = Array.isArray(v.witness) ? v.witness : []; witness += vi(w.length) + w.map(field).join(''); }
    return version + '0001' + body + witness + locktime;
  } catch { return null; }
}

// outpointKey(txidDisplayHex-or-0x, vout) — the same function `dapp/confidential-pool.js`'s makeConfidentialPool
// exports (keccak(txid ‖ vout_le), mirroring cxfer-core::outpoint_key). Injected so this module never has an
// opinion about which secp/keccak/sha256 implementation the caller is already using.
export function makeLiveBurnDepositTracer({ env, apiText, apiRawBytes, network, outpointKey, sha256, fullBlockWitness = true }) {
  if (typeof apiText !== 'function' || typeof apiRawBytes !== 'function') throw new Error('burndep-live-tracer: apiText and apiRawBytes required');
  if (typeof outpointKey !== 'function') throw new Error('burndep-live-tracer: outpointKey required (from makeConfidentialPool)');
  if (!env) throw new Error('burndep-live-tracer: env required (apiText/apiRawBytes read env.MAINNET_API/SIGNET_API for upstream selection)');
  const dsha256 = (b) => sha256(sha256(b));
  const fetchText = (path) => apiText(env, path, {}, network);
  const fetchRawBytes = (path) => apiRawBytes(env, path, network);

  // Per-block cache: coinbase + every tx's wtxid, needed once per block regardless of how many DAG hops it
  // contains. Mirrors reflection-attest.js's own blockWitnessCache exactly (same shape), but this module keeps
  // its own copy rather than importing reflection-attest.js's internal closure — this is liveness tooling with
  // no business depending on, or being depended on by, the live scanning path.
  const blockCache = new Map(); // blockHash (no 0x) -> { coinbase, blockTxids: [bytes], blockWtxids: [bytes] }
  async function fetchBlockWitness(blockHash) {
    const key = stripHexPrefix(blockHash).toLowerCase();
    let rec = blockCache.get(key);
    if (rec) return rec;
    const raw = await fetchRawBytes(`/block/${key}/raw`);
    const parsed = splitBlockTxs(raw, dsha256);
    rec = {
      coinbase: parsed[0].rawHex,
      blockTxids: parsed.map((t) => reverseBytes(hexToBytes(t.txidDisplay))),
      blockWtxids: parsed.map((t) => reverseBytes(hexToBytes(t.wtxidDisplay))),
    };
    blockCache.set(key, rec);
    return rec;
  }

  // What a txid IS, for burn-deposit provenance purposes, never changes once it's confirmed — so the answer is
  // cached in the registry KV forever, not just for this one request. A cxfer's own inputs are not always all
  // confidential — a P2WPKH-homed note's reveal needs a separate, leading non-confidential funding input to
  // pay for the reveal tx (the assembler's own `inputSkip` field exists for exactly this — see
  // buildBurnDepositStatic's comment) — and that input's producing tx carries no envelope at all, which is
  // exactly how classifyConfidentialTx reports a genuine leaf too (it only recognizes cxfer/burn/AMM fold
  // types, not CETCH/CMINT). So resolution has five possible outcomes, tagged here so both this module's own
  // forward walk (getCxferByOutput) and its backward input-classification (classifyInput) can share one cache
  // and one esplora fetch per txid, whether they reach it via a direct DAG hop or via an input one hop earlier:
  //   cxfer                — a confidential transfer; carries its OWN shape (outputs + raw vins), unresolved.
  //   cetch                — the asset's own supply note (opcode 0x21); carries its commitment.
  //   funding              — no envelope at all — a plain, non-confidential input paying for a reveal tx.
  //   other-fold           — a recognized-but-different fold type (amm/farm/bid/…) — not resolvable here.
  //   unrecognized-envelope — an envelope this module doesn't parse (opcode noted) — likely CMINT/bound-asset.
  // Deliberately SHALLOW: a cxfer's own vins are returned raw (txid/vout only), never further resolved here.
  // The recursion ACROSS hops belongs to burn-deposit-tracer.js's outer walk (mirrored, for a hop's OWN inputs,
  // by getCxferByOutput below) — resolveShallow must not do it too. It first did, transitively: classifyInput
  // called what was then a single merged resolver, which itself called classifyInput for ITS OWN inputs, so
  // resolving hop 1 silently resolved the WHOLE lineage before the outer BFS's maxDepth counter ever ran —
  // turning maxDepth into a check that fires only after the very work it exists to cap has already happened.
  // Splitting the shallow, cacheable "what is this txid" fact from the one-hop "resolve this cxfer's inputs"
  // step (now in getCxferByOutput, still cheap for a repeat call since it only re-reads already-cached shallow
  // facts, never re-fetches) keeps each outer BFS step doing exactly one hop's worth of fresh resolution again.
  // Scope stays plain cxfer + CETCH leaves only — not CMINT (a separate provenance branch the assembler tracks
  // via its own `cmints[]` array, not through a cxfer's inputs) and not cxfer_bound (0x39, deployment-bound
  // assets). TAC — the only asset burn-deposit has moved so far — is non-mintable (fixed supply, confirmed via
  // its own /assets/:id record) and folds unbound (SPEC.md §6.2), so its lineage should never contain a cmint
  // or a bound hop; a DAG that does throws rather than silently mis-resolving it.
  const shallowCacheKey = (txidDisplay) => `burndepshallow:${network}:${stripHexPrefix(txidDisplay).toLowerCase()}`;
  const shallowCache = new Map(); // txidDisplay (no 0x, lowercase) -> the tagged shallow resolution
  const shallowInflight = new Map(); // the same, while its one request is out: two hops reaching one tx share it
  async function resolveShallow(txidDisplay) {
    const key = stripHexPrefix(txidDisplay).toLowerCase();
    const rec = shallowCache.get(key);
    if (rec) return rec;
    if (!shallowInflight.has(key)) shallowInflight.set(key, resolveShallowOnce(key).finally(() => shallowInflight.delete(key)));
    return shallowInflight.get(key);
  }
  async function resolveShallowOnce(key) {
    let rec;
    if (env.REGISTRY_KV) {
      const cached = await env.REGISTRY_KV.get(shallowCacheKey(key), 'json');
      // A transfer or the etch was read from its envelope, so its reading stands. Any other reading kept before SHALLOW_V may
      // come from a rebuild that lacked its witness (a transfer read as plain funding), which refuses every history through it
      // for good: those are read once more.
      if (cached && (cached.kind === 'cxfer' || cached.kind === 'cetch' || Number(cached.v) >= SHALLOW_V)) { shallowCache.set(key, cached); return cached; }
    }
    // One request per transaction: its JSON carries everything, and the raw bytes are rebuilt from it and checked against
    // the txid asked for; only a transaction that does not rebuild exactly costs a second request for its hex.
    const json = JSON.parse(await fetchText(`/tx/${key}`));
    const hexTrimmed = rebuiltRawTx(json, key, dsha256) || (await fetchText(`/tx/${key}/hex`)).trim();
    const decode = classifyConfidentialTx(withHexPrefix(hexTrimmed));
    if (decode && decode.type === 'cxfer') {
      if (!json.status || !json.status.confirmed) throw new Error(`burndep-live-tracer: ${key} is not yet confirmed`);
      rec = {
        kind: 'cxfer', tx: withHexPrefix(hexTrimmed),
        vins: (json.vin || []).map((v) => ({ txid: v.txid, vout: v.vout })),
        outputs: decode.vouts.map((v, i) => ({ vout: v, commitment: decode.commitments[i] })),
        rangeProof: decode.rangeProof, kernelSig: decode.kernelSig, blockHash: json.status.block_hash,
      };
    } else if (decode) {
      rec = { kind: 'other-fold', foldType: decode.type };
    } else {
      const envHex = extractTaprootEnvelope(hexTrimmed);
      const cetch = envHex && parseCetch(envHex);
      rec = cetch ? { kind: 'cetch', commitment: cetch.c0Compressed, tx: withHexPrefix(hexTrimmed), blockHash: json.status && json.status.block_hash }
        : envHex ? { kind: 'unrecognized-envelope', opcode: envHex.slice(2, 4) }
        : { kind: 'funding' };
    }
    rec.v = SHALLOW_V;
    shallowCache.set(key, rec);
    // Confirmed, classified, immutable — safe to cache forever. Any caller sharing this KV (a future request,
    // or an offline crawler warming it ahead of time) reads it back with zero esplora calls.
    if (env.REGISTRY_KV) await env.REGISTRY_KV.put(shallowCacheKey(key), JSON.stringify(rec));
    return rec;
  }

  // A cxfer record's atomic-settlement asset-input count (null for an ordinary transfer). Read from the transaction itself
  // rather than carried on the record, so records cached before this was tracked classify the same as new ones.
  function assetInputCountOf(rec) {
    if (rec.assetInputCount !== undefined) return rec.assetInputCount;
    const d = rec.tx ? classifyConfidentialTx(rec.tx) : null;
    return d && d.type === 'cxfer' && d.assetInputCount != null ? d.assetInputCount : null;
  }

  async function classifyInput(prevTxidDisplay, prevVout) {
    const rec = await resolveShallow(prevTxidDisplay);
    if (rec.kind === 'cxfer') {
      const o = rec.outputs.find((x) => x.vout === prevVout);
      if (!o) throw new Error(`burndep-live-tracer: ${prevTxidDisplay} has no cxfer output at vout ${prevVout}`);
      return { kind: 'cxfer', commitment: o.commitment };
    }
    if (rec.kind === 'cetch') {
      if (prevVout !== 0) throw new Error(`burndep-live-tracer: ${prevTxidDisplay} is a CETCH but was spent at vout ${prevVout}, not 0`);
      return { kind: 'cetch', commitment: rec.commitment };
    }
    if (rec.kind === 'funding') return { kind: 'funding' };
    if (rec.kind === 'unrecognized-envelope') {
      // 0x6c shields a note into the Bitcoin shielded pool and 0x6d spends from it (the note an exit makes). The guest takes only
      // transfer envelopes as a hop (parse_cxfer_envelope_full) and checks each one's kernel; a pool spend is proved by a Halo2
      // circuit the reflection does not run, so a history through one is not provable and this is not a hop left unwritten.
      const pool = /^6[cd]$/i.test(rec.opcode);
      throw new Error(`burndep-live-tracer: ${prevTxidDisplay}:${prevVout} carries an envelope this module does not `
        + `recognize as a resolvable leaf (opcode 0x${rec.opcode}) — `
        + (pool ? 'a Bitcoin shielded-pool shield or exit: the reflection proof does not follow notes through the pool, '
          + 'so a history through it cannot be bridged to Ethereum, and no change to this tracer alters that; see ops/DESIGN-burndep-live-tracer.md'
          : 'likely a CMINT or bound-asset hop, neither implemented; see ops/DESIGN-burndep-live-tracer.md'));
    }
    throw new Error(`burndep-live-tracer: input ${prevTxidDisplay}:${prevVout} classified as '${rec.foldType}', `
      + 'which this module does not resolve a commitment for');
  }

  // The dapp/burn-deposit-tracer.js dependency itself. `op` is always an outpointKey hash the caller either
  // seeded (the note being bridged) or that THIS function itself produced from a prior tx's real vin data —
  // never an arbitrary hash from nowhere — so `seen` (populated by every call) always has a plaintext answer.
  const seen = new Map(); // outpointKeyHex -> { txidDisplay, vout }
  function seed(txidDisplay, vout) {
    const key = outpointKey(withHexPrefix(txidDisplay), vout);
    seen.set(key.toLowerCase(), { txidDisplay: withHexPrefix(txidDisplay), vout });
    return key;
  }

  async function getCxferByOutput(op) {
    const plain = seen.get(String(op).toLowerCase());
    if (!plain) throw new Error(`burndep-live-tracer: getCxferByOutput called with an outpoint this tracer never seeded or discovered: ${op}`);
    const { txidDisplay, vout } = plain;
    const rec = await resolveShallow(txidDisplay);
    if (rec.kind !== 'cxfer') return null; // not produced by a cxfer — tracer treats as unprovable unless it's a leaf
    if (!rec.outputs.some((o) => o.vout === vout)) return null;
    // Resolve THIS hop's own inputs — one hop back each, via classifyInput (which itself only ever calls
    // resolveShallow, never recurses further) — so a lineage's total depth is still driven by the outer BFS
    // loop in traceBurnDepositProvenance, one hop per iteration, exactly where maxDepth is enforced.
    // Which of this tx's vins are confidential asset inputs (the ones the kernel covers, and so the ones the guest
    // is handed commitments for), and how many leading vins are skipped (`inputSkip`, witnessed to the guest):
    //  - an atomic settlement (T_AXFER / T_AXFER_BPP, what a taker of a Bitcoin order-book listing signs) lays its vins
    //    out as [the taker's commit, the seller's asset input(s), the taker's sats...]: the kernel covers exactly
    //    vin[1..1+asset_input_count], the skip is 1, and everything after the asset inputs is the taker's own funding
    //    (cxfer-core burn_deposit.rs: "atomic settlement asset inputs are not vin[1..1+count]");
    //  - any other cxfer takes every vin after its LEADING non-confidential ones (a P2WPKH-homed note's reveal needs one
    //    funding input to commit its envelope; a P2TR-homed note's own address is the commit and needs none). A funding
    //    input after a confidential one is not a shape the guest accepts there, so it is refused rather than guessed at.
    const axferCount = assetInputCountOf(rec);
    let inputSkip, assetVins, classified;
    if (axferCount != null) {
      if (1 + axferCount > rec.vins.length) {
        throw new Error(`burndep-live-tracer: ${txidDisplay} is an atomic settlement naming ${axferCount} asset input(s) but has only ${rec.vins.length} input(s)`);
      }
      inputSkip = 1;
      assetVins = rec.vins.slice(1, 1 + axferCount);
      classified = await Promise.all(assetVins.map((v) => classifyInput(v.txid, v.vout)));
      classified.forEach((c, i) => {
        if (c.kind === 'funding') {
          throw new Error(`burndep-live-tracer: ${txidDisplay} is an atomic settlement whose asset input ${i + 1} (${assetVins[i].txid}:${assetVins[i].vout}) is not a confidential note`);
        }
      });
    } else {
      const all = await Promise.all(rec.vins.map((v) => classifyInput(v.txid, v.vout)));
      inputSkip = 0;
      while (inputSkip < all.length && all[inputSkip].kind === 'funding') inputSkip++;
      for (let i = inputSkip; i < all.length; i++) {
        if (all[i].kind === 'funding') {
          throw new Error(`burndep-live-tracer: ${txidDisplay} has a non-confidential input at index ${i}, `
            + `after a confidential one at a lower index — funding inputs are expected to be leading only`);
        }
      }
      assetVins = rec.vins.slice(inputSkip);
      classified = all.slice(inputSkip);
    }
    const inputs = assetVins.map((v, i) => ({
      prevTxid: withHexPrefix(v.txid), prevVout: v.vout, commitment: classified[i].commitment,
    }));
    // Seed every one of THIS tx's own REAL inputs into `seen` so the tracer's next hop (which will call
    // getCxferByOutput with outpointKey(inp.prevTxid, inp.prevVout), computed inside burn-deposit-tracer.js
    // itself) resolves to a plaintext txid/vout this module already knows, without needing to invert a hash.
    // Funding inputs are never seeded: nothing should ever ask this tracer to resolve one further.
    for (const inp of inputs) seed(inp.prevTxid, inp.prevVout);
    // fetchBlockWitness downloads and parses the FULL raw block (every tx in it) — real bandwidth/CPU cost per
    // hop, needed only for the merkle-proof fields (blockTxids/blockWtxids/coinbase/index). The minimal
    // /reflection/burndep registration shape needs none of those, only blockHash — already on `rec` for free
    // — so a caller building that shape skips this fetch entirely via `fullBlockWitness: false`. A DAG this
    // deep is sequential by nature (each hop's inputs are unknown until the hop before it resolves), so
    // trimming per-hop cost is the only lever that shortens the total trace time.
    let blockWitness = null, index;
    if (fullBlockWitness) {
      blockWitness = await fetchBlockWitness(rec.blockHash);
      // This tx's position within its own block, by matching internal-order txid bytes (blockTxids is already
      // in that form, per bitcoin-block-parse.js) — needed for witnessPath's merkle-siblings index.
      const txidBytes = reverseBytes(hexToBytes(txidDisplay));
      index = blockWitness.blockTxids.findIndex((t) => t.length === txidBytes.length && t.every((b, i2) => b === txidBytes[i2]));
      if (index < 0) throw new Error(`burndep-live-tracer: ${txidDisplay} not found in its own reported block ${rec.blockHash} — reorg mid-trace?`);
    }
    return {
      txid: withHexPrefix(txidDisplay),
      tx: rec.tx,
      inputs,
      inputSkip,
      outputs: rec.outputs,
      rangeProof: rec.rangeProof,
      kernelSig: rec.kernelSig,
      // blockHash alongside the full merkle-proof data: a caller assembling a MINIMAL /reflection/burndep
      // registration bundle (which only needs {tx, blockHash|blockHeight} per hop — the server enriches the
      // rest at fold time, see reflection-attest.js's enrichBurnDeposit) doesn't need blockTxids/blockWtxids/
      // coinbase/index at all, but does need this.
      blockHash: rec.blockHash,
      blockTxids: blockWitness && blockWitness.blockTxids,
      blockWtxids: blockWitness && blockWitness.blockWtxids,
      coinbase: blockWitness && blockWitness.coinbase,
      index,
    };
  }

  // Exposed so a caller that needs a txid's own data outside the DAG walk (e.g. the asset's etch/leaf tx,
  // never fetched by trace() itself — see traceBurnDepositProvenance's own leaf comment) can share this same
  // cache instead of fetching it separately and uncached on every call.
  return { getCxferByOutput, seed, resolveShallow, outpointKeyOf: (txidDisplay, vout) => outpointKey(withHexPrefix(txidDisplay), vout) };
}

// Top-level entry point: given a note's own outpoint and the asset's supply leaf(ves), produce the full
// provenance DAG (dapp/burn-deposit-tracer.js's own `trace()` output) ready for
// dapp/burn-deposit-assembler.js's buildBurnDepositStatic. Ties makeLiveBurnDepositTracer (this file) to
// makeBurnDepositTracer (the existing, tested DAG walk) — neither needs the other to change.
//   note        : { txid, vout } — display-hex txid, the note being bridged
//   leaves      : [{ txid, vout }, ...] — the asset's C_0 (and any authorized cmint reveals); at least one
//                 required, or every lineage throws as unprovable
//   deadline    : a Date.now() past which the walk stops and throws `trace_pending` (with `hops` read so far) instead of
//                 running into a gateway's timeout; every transaction it read stays in the KV, so asking again goes on
//                 from there, each answer it already has costing one KV read
//   concurrency : outpoints resolved at once (the inputs of a merge are independent); kept small, since each one is an
//                 explorer request the whole service shares
export async function traceBurnDepositProvenance({ env, apiText, apiRawBytes, network, outpointKey, sha256, trace, note, leaves, maxDepth = 256, fullBlockWitness = false, deadline = null, concurrency = 2 } = {}) {
  if (typeof trace !== 'function') throw new Error('traceBurnDepositProvenance: trace required (dapp/burn-deposit-tracer.js makeBurnDepositTracer({outpointKey}).trace)');
  if (!note || note.txid == null || note.vout == null) throw new Error('traceBurnDepositProvenance: note {txid, vout} required');
  if (!Array.isArray(leaves) || !leaves.length) throw new Error('traceBurnDepositProvenance: at least one leaf (the asset\'s C_0) required');
  const live = makeLiveBurnDepositTracer({ env, apiText, apiRawBytes, network, outpointKey, sha256, fullBlockWitness });
  const noteOutpoint = live.seed(note.txid, note.vout);
  const leafOutpoints = leaves.map((l) => live.seed(l.txid, l.vout));
  // trace()'s own contract (dapp/burn-deposit-tracer.js, unit-tested against an in-memory mock) is a
  // SYNCHRONOUS getCxferByOutput — tests/tac-bridge-bundle.mjs and tests/tac-bridge-provenance-dag.mjs already
  // establish the pattern for a real, network-backed producer: resolve the whole DAG with the async fetcher
  // first, then hand trace() a synchronous lookup over the already-resolved graph. live.getCxferByOutput does
  // a real esplora round-trip per hop, so it cannot be passed to trace() directly.
  const leafSet = new Set(leafOutpoints);
  const graph = new Map();
  const queue = [noteOutpoint];
  const queued = new Set(queue);
  // `maxDepth` bounds the HOPS (distinct transfers) in the lineage, the thing the registration door caps (the guest's own 256). The walk
  // visits outpoints, and a transfer that spends several outputs of one earlier transaction (a split put back together) is several
  // outpoints for one hop, so counting visits instead would refuse a note well inside the limit as "too deep". The visits get a bound of
  // their own.
  const MAX_VISITS = 4096;
  const hops = new Set();
  let steps = 0;
  while (queue.length) {
    if (deadline != null && Date.now() > deadline) {
      throw Object.assign(new Error(`burn-deposit trace: still reading this note's history (${hops.size} transfer${hops.size === 1 ? '' : 's'} so far)`), { code: 'trace_pending', hops: hops.size });
    }
    const wave = [];
    while (queue.length && wave.length < Math.max(1, concurrency)) {
      if (++steps > MAX_VISITS) throw new Error('burn-deposit trace: provenance exceeded ' + MAX_VISITS + ' outpoints');
      const op = queue.shift();
      if (!leafSet.has(op) && !graph.has(op)) wave.push(op);
    }
    const found = await Promise.all(wave.map((op) => live.getCxferByOutput(op)));
    wave.forEach((op, i) => {
      const cx = found[i];
      graph.set(op, cx || null);
      if (!cx) return;
      hops.add(cx.txid);
      for (const inp of cx.inputs) {
        const inOp = outpointKey(inp.prevTxid, inp.prevVout);
        if (!leafSet.has(inOp) && !queued.has(inOp)) { queue.push(inOp); queued.add(inOp); }
      }
    });
    if (hops.size > maxDepth) throw new Error('burn-deposit trace: provenance exceeded maxDepth (' + maxDepth + ')');
  }
  const cxfers = await trace({ getCxferByOutput: (op) => graph.get(op) || null, noteOutpoint, leafOutpoints, maxDepth: MAX_VISITS });
  return { cxfers, live }; // `live` exposed so a caller can inspect its tx/block caches (e.g. for a local re-verify) without re-fetching
}
