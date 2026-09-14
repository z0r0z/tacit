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

  // Read a bytes32[] field given its HEAD byte offset within a tuple encoding (offset ⇒ jump to the tail).
  function readBytes32Array(data, headByteOff) {
    const arrOff = Number(u256At(data, headByteOff));
    const count = Number(u256At(data, arrOff));
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = '0x' + hexWord(data, arrOff + 32 + i * 32);
    return out;
  }

  // Decode just the three lock-relevant fields from a raw PublicValues tuple encoding (the `publicValues`
  // bytes decodeSettleCalldata returns). The contract does `abi.decode(publicValues, (PublicValues))` —
  // decoding a single dynamic struct as a ONE-ELEMENT TUPLE, which per ABI rules means these bytes open
  // with an extra offset word pointing at the struct's own encoding (always 0x20, i.e. right after
  // itself) before any of the struct's actual fields begin. Skipping that word is required, not
  // optional: verified against a real mainnet OP_STEALTH_LOCK settle tx, where the un-skipped version
  // read the struct's own head words as tail data and produced a bogus lockLeaves array.
  function decodePublicValuesLockFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const structOff = Number(u256At(outer, 0)) * 2; // word offset -> hex-char offset
    const data = outer.slice(structOff);
    const leaves = readBytes32Array(data, 4 * 32);
    const lockSetRoot = '0x' + hexWord(data, 16 * 32);
    const lockLeaves = readBytes32Array(data, 17 * 32);
    return { leavesCount: leaves.length, lockSetRoot, lockLeaves };
  }

  // Walk a stream of settle-tx refs — `{ txHash, blockNumber, logIndex }`, exactly what
  // confidential-evm-log.js's decodeLogs already attaches to every decoded LeavesInserted/NullifiersSpent
  // event — and reconstruct the lock-set tree + the memo tail, in on-chain append order. LeavesInserted
  // fires on EVERY settle CALL (even a lock-only one with an empty `leaves` array), so a caller's existing
  // note scan already surfaces every tx worth checking here — this never needs its own separate log filter.
  // `getTxInput(txHash)` is an injected `eth_getTransactionByHash(...).input` fetcher (RPC belongs to the
  // caller, not this module). A tx that fails to decode (not actually a settle-shaped call, or from a
  // different contract entirely if the caller merged streams) is skipped — a bad decode here must never
  // crash the scan, only skip a candidate.
  //
  // A relaySettle batch fires LeavesInserted once PER inner settle call, so several event rows can share
  // one txHash — group by txHash (fetching its input once) rather than keeping only the first row per tx,
  // then decode EVERY settle call the tx's calldata carries (one for a direct settle(), N for a relaySettle
  // batch) in their native array order, which is also their real execution/append order within that tx.
  async function scanLockLeaves({ events, getTxInput }) {
    const groups = new Map(); // txHash -> { blockNumber, logIndex (min, for cross-tx ordering) }
    for (const e of events || []) {
      if (!e || !e.txHash) continue;
      const g = groups.get(e.txHash);
      if (!g) groups.set(e.txHash, { txHash: e.txHash, blockNumber: e.blockNumber, logIndex: e.logIndex });
      else {
        g.blockNumber = Math.min(g.blockNumber, e.blockNumber);
        g.logIndex = Math.min(g.logIndex, e.logIndex);
      }
    }
    const rows = [...groups.values()].sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
    const tree = new pool.Tree();
    const lockLeaves = [];
    const lockMemos = [];
    for (const ev of rows) {
      let input;
      try { input = await getTxInput(ev.txHash); } catch { continue; }
      if (!input) continue;
      const selector = strip0x(input).slice(0, 8).toLowerCase();
      let calls;
      if (selector === SELECTOR_SETTLE) {
        try { calls = [decodeSettleCalldata(input)]; } catch { continue; }
      } else if (selector === SELECTOR_RELAY_SETTLE || selector === SELECTOR_RELAY_SETTLE_SEEDED) {
        try { calls = decodeRelaySettleCalldata(input); } catch { continue; }
      } else {
        continue; // some other contract/call the caller's merged event stream happened to include
      }
      for (const decoded of calls) {
        let fields;
        try { fields = decodePublicValuesLockFields(decoded.publicValues); } catch { continue; }
        if (!fields.lockLeaves.length) continue;
        // Memo tail: settle() requires memos.length == pv.leaves.length + pv.lockLeaves.length, so the
        // first `leavesCount` memos are ordinary note memos (irrelevant here) and the remainder are lock
        // memos, in lockLeaves order.
        const tail = decoded.memos.slice(fields.leavesCount);
        for (let i = 0; i < fields.lockLeaves.length; i++) {
          tree.insert(fields.lockLeaves[i]);
          lockLeaves.push(fields.lockLeaves[i]);
          lockMemos.push(tail[i] != null ? tail[i] : null);
        }
      }
    }
    return { tree, lockLeaves, lockMemos, lockSetRoot: tree.root() };
  }

  return { decodeSettleCalldata, decodeRelaySettleCalldata, decodePublicValuesLockFields, scanLockLeaves };
}
