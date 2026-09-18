// Calldata-based stealth lock-set scanner (ops/INTEGRATION-simple-wrap-send-claim-eth.md §5). Lock leaves
// are NEVER emitted in an event — LeavesInserted carries only the ordinary note tree's `pv.leaves`, and a
// pure OP_STEALTH_LOCK settle mints no note leaf at all. The only on-chain source for `pv.lockLeaves` /
// `pv.lockSetRoot` is a settle() call's own `publicValues` CALLDATA, decoded per
// contracts/src/ConfidentialPool.sol's `PublicValues` struct. This module is pure decoding (no I/O, no
// RPC) plus one small driver that walks a caller-supplied stream of settle-tx refs.
//
// A settle can reach the pool through more than one outer transaction shape: a direct `pool.settle(...)`
// call, OR a batched `TacitRelayer.relaySettle(...)` call (either overload — see worker/src/
// confidential-settle.js's `feeAsset`/"relaySettle path" comment: fee-bearing ops are routinely relayed
// this way, stealth locks/claims/refunds included, since they go through the same _dispatch as every other
// op). relaySettle's own calldata has a completely different ABI shape (a `SettleCall[]` array of inner
// (publicValues,proof,memos) tuples, not three top-level dynamic params), so a scanner that only recognizes
// direct settle() calldata silently drops every lock routed through the relayer batch. Route by the actual
// 4-byte selector rather than a blind try/catch, so an unrecognized shape is explicitly skipped instead of
// risking a coincidental misparse.
//
// Field indices below (0-based, matching PublicValues' declaration order in ConfidentialPool.sol):
//   4  = leaves        (bytes32[]  — the ordinary note tree's new leaves this settle)
//   16 = lockSetRoot   (bytes32    — 0 unless this settle read lock-set membership, e.g. a claim/refund)
//   17 = lockLeaves    (bytes32[]  — new locked notes THIS settle appended, e.g. a lock)
// An ABI tuple head is exactly one 32-byte word per field regardless of type (a static field's word IS its
// value; a dynamic field's word is an offset to its data in the tail) — so these three fields can be read
// without decoding any of PublicValues' other ~30 fields or their nested struct types.

// Selectors: settle(bytes,bytes,bytes[]); relaySettle((bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[]);
// relaySettle((bytes32,bytes32,uint32)[],(bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[]) (the
// found-and-seed overload). Computed from TacitRelayer.sol's own SettleCall/PairInit struct declarations.
const SELECTOR_SETTLE = '717fd7f2';
const SELECTOR_RELAY_SETTLE = 'fcccb833';
const SELECTOR_RELAY_SETTLE_SEEDED = 'e2b28725';

// Mainnet ConfidentialPool and TacitRelayer: a settle sent straight to either is exactly what that contract ran
// (see scanLockLeaves on provenance). Per-generation -- both real callers (confidential-pool-ux.js) rely on
// these as their only source, with no override, so a generation cutover MUST update these two constants or
// stealth-lock scanning silently keeps reading the retired generation's pool.
const MAINNET_POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const MAINNET_RELAYER = '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3';

export function makeConfidentialLockScan({ pool }) {
  const strip0x = (h) => String(h == null ? '' : h).replace(/^0x/, '');
  const hexWord = (data, byteOff) => (data.slice(byteOff * 2, byteOff * 2 + 64) || '').padEnd(64, '0');
  const u256At = (data, byteOff) => BigInt('0x' + hexWord(data, byteOff));

  // Decode `settle(bytes publicValues, bytes proofBytes, bytes[] memos)` calldata — the tx's raw `.input`,
  // WITH its 4-byte selector. Standard ABI head/tail for a 3-dynamic-param call: 3 head words, each an
  // offset relative to the start of the args (right after the selector).
  function decodeSettleCalldata(inputHex) {
    const data = strip0x(inputHex).slice(8); // drop the 4-byte selector (8 hex chars)
    const readBytes = (byteOff) => {
      const len = Number(u256At(data, byteOff));
      const start = (byteOff + 32) * 2;
      return '0x' + data.slice(start, start + len * 2).padEnd(len * 2, '0');
    };
    const offPv = Number(u256At(data, 0));
    const offProof = Number(u256At(data, 32));
    const offMemos = Number(u256At(data, 64));
    const publicValues = readBytes(offPv);
    const proof = readBytes(offProof);
    // bytes[] memos: [count]‖[offset_0..offset_{count-1}, each relative to the byte right after `count`]‖[bytes...]
    const count = Number(u256At(data, offMemos));
    const memos = [];
    for (let i = 0; i < count; i++) {
      const rel = Number(u256At(data, offMemos + 32 + i * 32));
      memos.push(readBytes(offMemos + 32 + rel));
    }
    return { publicValues, proof, memos };
  }

  // Decode one SettleCall (publicValues,proof,memos) tuple whose own head offsets are relative to
  // `byteOff` within `data` — structurally identical to settle()'s own 3-dynamic-param args encoding
  // (a dynamic tuple and a top-level dynamic-arg list share the same head/tail layout), so this is the
  // same logic as decodeSettleCalldata's body, just relative to an arbitrary offset instead of byte 0.
  function decodeSettleTuple(data, byteOff) {
    const local = data.slice(byteOff * 2);
    const readBytes = (o) => {
      const len = Number(u256At(local, o));
      const start = (o + 32) * 2;
      return '0x' + local.slice(start, start + len * 2).padEnd(len * 2, '0');
    };
    const offPv = Number(u256At(local, 0));
    const offProof = Number(u256At(local, 32));
    const offMemos = Number(u256At(local, 64));
    const publicValues = readBytes(offPv);
    const proof = readBytes(offProof);
    const count = Number(u256At(local, offMemos));
    const memos = [];
    for (let i = 0; i < count; i++) {
      const rel = Number(u256At(local, offMemos + 32 + i * 32));
      memos.push(readBytes(offMemos + 32 + rel));
    }
    return { publicValues, proof, memos };
  }

  // Decode a SettleCall[] array field (a dynamic array of the dynamic tuple above) at head offset
  // `headByteOff` within `data`. Each element's head word is itself an offset, relative to the byte right
  // after the array's length word — same convention bytes[]'s per-item offsets use in decodeSettleCalldata.
  function decodeSettleCallArray(data, headByteOff) {
    const arrOff = Number(u256At(data, headByteOff));
    const count = Number(u256At(data, arrOff));
    const out = [];
    for (let i = 0; i < count; i++) {
      const elOff = Number(u256At(data, arrOff + 32 + i * 32));
      out.push(decodeSettleTuple(data, arrOff + 32 + elOff));
    }
    return out;
  }

  // Decode TacitRelayer.relaySettle(...) calldata (either overload — the seeded variant's `calls` is its
  // 2nd param, right after `pairs`) into the array of inner SettleCall tuples it batches. Throws on any
  // other selector so a caller can branch on it explicitly.
  function decodeRelaySettleCalldata(inputHex) {
    const raw = strip0x(inputHex);
    const selector = raw.slice(0, 8).toLowerCase();
    const data = raw.slice(8);
    if (selector === SELECTOR_RELAY_SETTLE) return decodeSettleCallArray(data, 0);
    if (selector === SELECTOR_RELAY_SETTLE_SEEDED) return decodeSettleCallArray(data, 32);
    throw new Error(`decodeRelaySettleCalldata: unrecognized selector 0x${selector}`);
  }

  // A settle reached through some other contract — a batch executor, a smart account, a searcher resending the
  // relay's own settle through its contract to collect the fee — carries the same settle(bytes,bytes,bytes[])
  // calldata inside a `bytes` argument. Where that blob starts depends on what wraps it: word-aligned under one
  // outer selector, 4 bytes past a word boundary under two (an ERC-4337 handleOps carrying the account's
  // execute(pool, 0, settle(...)), a multicall of abi.encodeCall results), and so on. So every occurrence of the
  // settle selector past the outer one is a candidate, at any byte offset; none is trusted here — scanLockLeaves
  // counts a call only once an event of the same transaction corroborates it. A candidate is decoded only if its
  // three heads, both byte strings and every memo lie inside the calldata, so arbitrary bytes cannot make the
  // decoder loop or read past the input.
  function decodeNestedSettles(inputHex) {
    const raw = strip0x(inputHex).toLowerCase();
    const out = [];
    for (let i = raw.indexOf(SELECTOR_SETTLE, 8); i >= 0; i = raw.indexOf(SELECTOR_SETTLE, i + 1)) {
      if (i % 2) continue; // not on a byte boundary
      const data = raw.slice(i + 8);
      const size = BigInt(Math.floor(data.length / 2));
      const fits = (off) => off + 32n <= size && off + 32n + u256At(data, Number(off)) <= size; // a length word and its bytes
      const heads = [0, 32, 64].map((o) => u256At(data, o));
      if (heads.some((h) => h + 32n > size)) continue;
      if (!fits(heads[0]) || !fits(heads[1])) continue;
      const count = u256At(data, Number(heads[2]));
      if (heads[2] + 32n + count * 32n > size) continue;
      let memosFit = true;
      for (let k = 0n; k < count && memosFit; k++) memosFit = fits(heads[2] + 32n + u256At(data, Number(heads[2] + 32n + k * 32n)));
      if (!memosFit) continue;
      try { out.push(decodeSettleCalldata('0x' + raw.slice(i))); } catch { /* not a settle after all */ }
    }
    return out;
  }

  // Read a bytes32[] field given its HEAD byte offset within a tuple encoding (offset ⇒ jump to the tail).
  function readBytes32Array(data, headByteOff) {
    const arrOff = Number(u256At(data, headByteOff));
    const count = Number(u256At(data, arrOff));
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = '0x' + hexWord(data, arrOff + 32 + i * 32);
    return out;
  }

  // Decode the lock-relevant fields from a raw PublicValues tuple encoding (the `publicValues` bytes
  // decodeSettleCalldata returns). The contract does `abi.decode(publicValues, (PublicValues))` — decoding
  // a single dynamic struct as a ONE-ELEMENT TUPLE, which per ABI rules means these bytes open with an
  // extra offset word pointing at the struct's own encoding (always 0x20, i.e. right after itself) before
  // any of the struct's actual fields begin. Skipping that word is required, not optional: verified against
  // a real mainnet OP_STEALTH_LOCK settle tx, where the un-skipped version read the struct's own head words
  // as tail data and produced a bogus lockLeaves array.
  // Field indices: 3 = nullifiers, 4 = leaves, 16 = lockSetRoot, 17 = lockLeaves.
  function decodePublicValuesLockFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const structOff = Number(u256At(outer, 0)) * 2; // word offset -> hex-char offset
    const data = outer.slice(structOff);
    const nullifiers = readBytes32Array(data, 3 * 32);
    const leaves = readBytes32Array(data, 4 * 32);
    const lockSetRoot = '0x' + hexWord(data, 16 * 32);
    const lockLeaves = readBytes32Array(data, 17 * 32);
    return { leaves, leavesCount: leaves.length, lockSetRoot, lockLeaves, nullifiers };
  }

  // Walk a stream of settle-tx refs — `{ txHash, blockNumber, logIndex }`, exactly what
  // confidential-evm-log.js's decodeLogs already attaches to every decoded LeavesInserted/NullifiersSpent
  // event — and reconstruct the lock-set tree + the memo tail, in on-chain append order.
  //
  // LeavesInserted does NOT fire on every settle: ConfidentialPool.sol emits it only inside
  // `if (pv.leaves.length != 0)`. A lock-only settle that spends no note (no ordinary leaves, no
  // nullifiers — the pure OP_BRIDGE_STEALTH_MINT case) emits NO pool event at all, so no log-driven scan
  // can discover it; a lock-only settle that DOES spend a note still emits NullifiersSpent. So the tx
  // stream this function needs is "every LeavesInserted OR NullifiersSpent," not "every LeavesInserted" —
  // a caller's existing note scan already fetches both for the ordinary note flow, so in practice this
  // still needs no separate log filter, but do not assume LeavesInserted alone is sufficient.
  // `getTxInput(txHash)` is an injected `eth_getTransactionByHash(...).input` fetcher (RPC belongs to the
  // caller, not this module). A tx that fails to decode (not actually a settle-shaped call, or from a
  // different contract entirely if the caller merged streams) is skipped — a bad decode here must never
  // crash the scan, only skip a candidate.
  //
  // A relaySettle batch fires LeavesInserted once PER inner settle call, so several event rows can share
  // one txHash — group by txHash (fetching its input once) rather than keeping only the first row per tx,
  // then decode EVERY settle call the tx's calldata carries (one for a direct settle(), N for a relaySettle
  // batch) in their native array order, which is also their real execution/append order within that tx.
  //
  // CALLDATA ALONE IS NOT PROOF A CALL LANDED. TacitRelayer._relay wraps each inner POOL.settle() in
  // try/catch and silently skips a failed one ("a failed/late settle — its FeePayment simply never lands"),
  // so a relaySettle batch's calldata can carry a call that never actually executed. Trusting it anyway
  // would insert a phantom lock leaf, diverge the rebuilt lockSetRoot from the real one, and break every
  // later claim's membership proof. So each decoded call must be corroborated against an event this exact
  // tx actually emitted: a LeavesInserted with the SAME leaves+memos (pv.leaves.length != 0 — the contract
  // only emits it then), or, for a lock-only call (no ordinary leaves), a NullifiersSpent with the SAME
  // nullifiers. `events` already carries the full LeavesInserted/NullifiersSpent payloads (not just txHash),
  // since the caller's log decoder (confidential-evm-log.js) attaches them — group those per tx too.
  //
  // ONE GENUINE GAP THIS CANNOT CLOSE: a lock-only call that ALSO spends no note (e.g. a pure
  // OP_BRIDGE_STEALTH_MINT) emits NO pool event at all. Such a call is simply never corroborated here —
  // and in fact the transaction carrying it would not even appear in a log-driven `events` stream to begin
  // with, since there is nothing to filter on. Discovering that case needs scanning every tx to the pool
  // address directly, not a log-driven approach; this function does not attempt it (see the integration
  // guide's own note on this).
  //
  // PROVENANCE, AND THE POOL'S OWN LOCK ROOT. Corroboration shows a landed call had the note-tree effects its
  // calldata claims, not the lock-set ones: a contract can carry, ahead of the settle it actually makes, a second
  // settle blob with the same leaves, memos and nullifiers but different lockLeaves, and that blob wins the match.
  // What a transaction sent straight to the pool (settle) or to TacitRelayer (relaySettle) carries is exactly what
  // that contract tried, so those calls are TRUSTED; a call decoded out of any other contract's calldata is
  // UNTRUSTED. `getTx(txHash) -> { input, to }` (optional; used instead of getTxInput) classifies by where the
  // transaction was sent, against `poolAddress` / `relayerAddress` (mainnet by default); without it only the
  // selector is known, so a top-level settle or relaySettle counts as trusted and a nested one does not.
  // `getLockState() -> { count, root }` (optional) is the pool's lockNextLeafIndex and lockRoot at the head the
  // caller scanned to. With it the rebuilt set is checked against the pool: a match returns `verified: true`; on a
  // mismatch the set is rebuilt from the trusted calls alone, and if THAT matches it is returned `verified: true`
  // with what was dropped in `excluded` ([{ txHash, lockLeaves }]); otherwise the full rebuilt set comes back with
  // `verified: false`. Without getLockState, or if it fails, `verified` is null.
  async function scanLockLeaves({ events, getTxInput, getTx, getLockState, poolAddress = MAINNET_POOL, relayerAddress = MAINNET_RELAYER }) {
    const groups = new Map(); // txHash -> { blockNumber, logIndex (min), leavesEvents, nullifierEvents }
    for (const e of events || []) {
      if (!e || !e.txHash) continue;
      let g = groups.get(e.txHash);
      if (!g) {
        g = { txHash: e.txHash, blockNumber: e.blockNumber, logIndex: e.logIndex, leavesEvents: [], nullifierEvents: [] };
        groups.set(e.txHash, g);
      } else {
        g.blockNumber = Math.min(g.blockNumber, e.blockNumber);
        g.logIndex = Math.min(g.logIndex, e.logIndex);
      }
      if (e.type === 'LeavesInserted') g.leavesEvents.push({ leaves: e.leaves || [], memos: e.memos || [] });
      else if (e.type === 'NullifiersSpent') g.nullifierEvents.push({ nullifiers: e.nullifiers || [] });
    }
    const sameArray = (a, b) => a.length === b.length && a.every((x, i) => String(x).toLowerCase() === String(b[i]).toLowerCase());
    const rows = [...groups.values()].sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
    const poolTo = String(poolAddress).toLowerCase();
    const relayerTo = String(relayerAddress).toLowerCase();
    const found = []; // corroborated calls with lock leaves, in append order: { txHash, trusted, lockLeaves, lockMemos }
    for (const g of rows) {
      let input, to;
      try {
        if (getTx) { const tx = await getTx(g.txHash); input = tx && tx.input; to = tx && tx.to; }
        else input = await getTxInput(g.txHash);
      } catch { continue; }
      if (!input) continue;
      const selector = strip0x(input).slice(0, 8).toLowerCase();
      let calls, direct = true;
      if (selector === SELECTOR_SETTLE) {
        try { calls = [decodeSettleCalldata(input)]; } catch { continue; }
      } else if (selector === SELECTOR_RELAY_SETTLE || selector === SELECTOR_RELAY_SETTLE_SEEDED) {
        try { calls = decodeRelaySettleCalldata(input); } catch { continue; }
      } else {
        direct = false;
        calls = decodeNestedSettles(input); // a settle reached through another contract, or none at all
        if (!calls.length) continue;
      }
      const trusted = direct && (!getTx || String(to || '').toLowerCase() === (selector === SELECTOR_SETTLE ? poolTo : relayerTo));
      // Each candidate event can corroborate at most one call — track which are already claimed so two
      // calls with coincidentally-identical effects can't both match the same landed event.
      const usedLeavesEvent = new Set();
      const usedNullifierEvent = new Set();
      for (const decoded of calls) {
        let fields;
        try { fields = decodePublicValuesLockFields(decoded.publicValues); } catch { continue; }
        if (!fields.lockLeaves.length) continue;
        // Memo tail: settle() requires memos.length == pv.leaves.length + pv.lockLeaves.length, so the
        // first `leavesCount` memos are ordinary note memos (irrelevant here) and the remainder are lock
        // memos, in lockLeaves order.
        const ordinaryMemos = decoded.memos.slice(0, fields.leavesCount);
        const tail = decoded.memos.slice(fields.leavesCount);
        let landed = false;
        if (fields.leaves.length) {
          for (let i = 0; i < g.leavesEvents.length && !landed; i++) {
            if (usedLeavesEvent.has(i)) continue;
            const ev = g.leavesEvents[i];
            if (sameArray(ev.leaves, fields.leaves) && sameArray(ev.memos, ordinaryMemos)) { landed = true; usedLeavesEvent.add(i); }
          }
        } else if (fields.nullifiers.length) {
          for (let i = 0; i < g.nullifierEvents.length && !landed; i++) {
            if (usedNullifierEvent.has(i)) continue;
            if (sameArray(g.nullifierEvents[i].nullifiers, fields.nullifiers)) { landed = true; usedNullifierEvent.add(i); }
          }
        } // else: a lock-only, spend-nothing call — no event exists to corroborate it (see header comment).
        if (!landed) continue;
        found.push({ txHash: g.txHash, trusted, lockLeaves: fields.lockLeaves, lockMemos: fields.lockLeaves.map((_, i) => (tail[i] != null ? tail[i] : null)) });
      }
    }
    const build = (list) => {
      const tree = new pool.Tree();
      for (const c of list) for (const leaf of c.lockLeaves) tree.insert(leaf);
      return { tree, lockLeaves: list.flatMap((c) => c.lockLeaves), lockMemos: list.flatMap((c) => c.lockMemos), lockSetRoot: tree.root() };
    };
    const all = build(found);
    if (!getLockState) return { ...all, verified: null, excluded: [] };
    const word32 = (h) => '0x' + strip0x(h).toLowerCase().padStart(64, '0');
    let chain;
    try {
      const s = await getLockState();
      chain = { count: Number(BigInt(s.count)), root: word32(s.root) };
    } catch { return { ...all, verified: null, excluded: [] }; }
    const matches = (b) => b.lockLeaves.length === chain.count && word32(b.lockSetRoot) === chain.root;
    if (matches(all)) return { ...all, verified: true, excluded: [] };
    const untrusted = found.filter((c) => !c.trusted);
    if (untrusted.length) {
      const kept = build(found.filter((c) => c.trusted));
      if (matches(kept)) return { ...kept, verified: true, excluded: untrusted.map(({ txHash, lockLeaves }) => ({ txHash, lockLeaves })) };
    }
    return { ...all, verified: false, excluded: [] };
  }

  return { decodeSettleCalldata, decodeRelaySettleCalldata, decodeNestedSettles, decodePublicValuesLockFields, scanLockLeaves };
}
