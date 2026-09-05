// Calldata-based stealth lock-set scanner (ops/INTEGRATION-simple-wrap-send-claim-eth.md §5). Lock leaves
// are NEVER emitted in an event — LeavesInserted carries only the ordinary note tree's `pv.leaves`, and a
// pure OP_STEALTH_LOCK settle mints no note leaf at all. The only on-chain source for `pv.lockLeaves` /
// `pv.lockSetRoot` is the settle() transaction's own `publicValues` CALLDATA, decoded per
// contracts/src/ConfidentialPool.sol's `PublicValues` struct. This module is pure decoding (no I/O, no
// RPC) plus one small driver that walks a caller-supplied stream of settle-tx refs.
//
// Field indices below (0-based, matching PublicValues' declaration order in ConfidentialPool.sol):
//   4  = leaves        (bytes32[]  — the ordinary note tree's new leaves this settle)
//   16 = lockSetRoot   (bytes32    — 0 unless this settle read lock-set membership, e.g. a claim/refund)
//   17 = lockLeaves    (bytes32[]  — new locked notes THIS settle appended, e.g. a lock)
// An ABI tuple head is exactly one 32-byte word per field regardless of type (a static field's word IS its
// value; a dynamic field's word is an offset to its data in the tail) — so these three fields can be read
// without decoding any of PublicValues' other ~30 fields or their nested struct types.

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

  // Read a bytes32[] field given its HEAD byte offset within a tuple encoding (offset ⇒ jump to the tail).
  function readBytes32Array(data, headByteOff) {
    const arrOff = Number(u256At(data, headByteOff));
    const count = Number(u256At(data, arrOff));
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = '0x' + hexWord(data, arrOff + 32 + i * 32);
    return out;
  }

  // Decode just the three lock-relevant fields from a raw PublicValues tuple encoding (the `publicValues`
  // bytes decodeSettleCalldata returns — a plain abi.encode of the struct, not further wrapped).
  function decodePublicValuesLockFields(publicValuesHex) {
    const data = strip0x(publicValuesHex);
    const leaves = readBytes32Array(data, 4 * 32);
    const lockSetRoot = '0x' + hexWord(data, 16 * 32);
    const lockLeaves = readBytes32Array(data, 17 * 32);
    return { leavesCount: leaves.length, lockSetRoot, lockLeaves };
  }

  // Walk a stream of settle-tx refs — `{ txHash, blockNumber, logIndex }`, exactly what
  // confidential-evm-log.js's decodeLogs already attaches to every decoded LeavesInserted/NullifiersSpent
  // event — and reconstruct the lock-set tree + the memo tail, in on-chain append order. LeavesInserted
  // fires on EVERY settle (even a lock-only one with an empty `leaves` array), so a caller's existing note
  // scan already surfaces every tx worth checking here — this never needs its own separate log filter.
  // `getTxInput(txHash)` is an injected `eth_getTransactionByHash(...).input` fetcher (RPC belongs to the
  // caller, not this module). Settles with no locks, or a tx that fails to decode (not actually a
  // `settle()` call, or from a different contract entirely if the caller merged streams), are skipped —
  // a bad decode here must never crash the scan, only skip a candidate.
  async function scanLockLeaves({ events, getTxInput }) {
    const seen = new Set();
    const rows = (events || [])
      .filter((e) => e && e.txHash && !seen.has(e.txHash) && seen.add(e.txHash))
      .sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
    const tree = new pool.Tree();
    const lockLeaves = [];
    const lockMemos = [];
    for (const ev of rows) {
      let input;
      try { input = await getTxInput(ev.txHash); } catch { continue; }
      if (!input) continue;
      let decoded;
      try { decoded = decodeSettleCalldata(input); } catch { continue; }
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
    return { tree, lockLeaves, lockMemos, lockSetRoot: tree.root() };
  }

  return { decodeSettleCalldata, decodePublicValuesLockFields, scanLockLeaves };
}
