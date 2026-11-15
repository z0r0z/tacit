// Confidential-pool EVM log decoder — the worker/indexer side. Turns raw chain
// logs ({topics, data}) emitted by ConfidentialPool into the structured event
// stream that confidential-indexer.js consumes for seed-only recovery. The worker
// subscribes to the contract, decodes with this, and serves the ordered stream;
// the client recovers. No off-chain note storage — the chain is the source.
//
// Decodes: LeavesInserted, LockLeavesInserted, NullifiersSpent, CrossOutRecorded, Wrap, CdpPositionInserted, and the
// FarmManager's Bonded and Harvested.
// Minimal in-module ABI reading (no ethers/web3 dep), exactly the shapes these
// events use. keccak256 injected for the topic0 signature hashes.

export function makeConfidentialEvmLog({ keccak256 }) {
  const enc = new TextEncoder();
  // A pool's history is thousands of logs of kilobytes each, so these work per byte without a string or an array made for each.
  const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  const hex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
  const NIB = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);
  const toBytes = (h) => {
    const t = String(h).replace(/^0x/, ''), n = t.length >> 1, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const hi = NIB(t.charCodeAt(2 * i)), lo = NIB(t.charCodeAt(2 * i + 1));
      if (hi < 0 || lo < 0) return Uint8Array.from((t.match(/../g) || []).map((x) => parseInt(x, 16)));   // not plain hex: read as it always was
      out[i] = (hi << 4) | lo;
    }
    return out;
  };
  const hx = (b) => '0x' + hex(b);
  const topic = (sig) => '0x' + hex(keccak256(enc.encode(sig)));

  const SIGS = {
    LeavesInserted: 'LeavesInserted(uint256,bytes32[],bytes[])',
    LockLeavesInserted: 'LockLeavesInserted(uint256,bytes32[])',
    NullifiersSpent: 'NullifiersSpent(bytes32[])',
    CrossOutRecorded: 'CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)',
    Wrap: 'Wrap(bytes32,bytes32,uint256)',
    // FarmManager (a separate contract from the pool): a bonded position's receipt leaf, pool id, shares and unlock time.
    Bonded: 'Bonded(bytes32,uint256,uint256,uint256)',
    Harvested: 'Harvested(bytes32,uint256,uint256)',
    CdpPositionInserted: 'CdpPositionInserted(bytes32)',
  };
  const TOPIC0 = Object.fromEntries(Object.entries(SIGS).map(([k, s]) => [k, topic(s)]));
  const byTopic0 = Object.fromEntries(Object.entries(TOPIC0).map(([k, t]) => [t.toLowerCase(), k]));

  // ── minimal ABI reading over the `data` byte string ──
  const word = (b, i) => b.subarray(32 * i, 32 * i + 32);
  const uintAt = (b, byteOff) => BigInt('0x' + (hex(b.subarray(byteOff, byteOff + 32)) || '0'));
  const wordHexAt = (b, byteOff) => hx(b.subarray(byteOff, byteOff + 32));

  // bytes32[] living at byte offset `at`: [len][elem0..elemN]
  function readBytes32Array(b, at) {
    const len = Number(uintAt(b, at));
    const out = [];
    for (let i = 0; i < len; i++) out.push(wordHexAt(b, at + 32 + 32 * i));
    return out;
  }
  // bytes[] living at byte offset `at`: [len][off0..offN][ (len,data) per elem ]
  function readBytesArray(b, at) {
    const len = Number(uintAt(b, at));
    const base = at + 32; // element heads start after the length word, offsets relative to here
    const out = [];
    for (let i = 0; i < len; i++) {
      const off = Number(uintAt(b, base + 32 * i));
      const pos = base + off;
      const blen = Number(uintAt(b, pos));
      out.push(hx(b.subarray(pos + 32, pos + 32 + blen)));
    }
    return out;
  }

  // The same reading over the log's data as the hex string it arrives as: a field is cut out of it with slice, never turned into bytes and back into
  // hex, which is most of what decoding a pool's history cost. Plain hex only (any case, even length); anything else is read by decodeLogSlow, as it
  // always was. tests/confidential-evm-log.mjs holds the two to each other on random and on malformed logs.
  const PLAIN = /^[0-9a-f]*$/;
  const sU = (s, byteOff) => BigInt('0x' + (s.slice(2 * byteOff, 2 * byteOff + 64) || '0'));
  const sW = (s, byteOff) => '0x' + s.slice(2 * byteOff, 2 * byteOff + 64);
  function sBytes32Array(s, at) {
    const len = Number(sU(s, at));
    const out = [];
    for (let i = 0; i < len; i++) out.push(sW(s, at + 32 + 32 * i));
    return out;
  }
  function sBytesArray(s, at) {
    const len = Number(sU(s, at));
    const base = at + 32;
    const out = [];
    for (let i = 0; i < len; i++) {
      const pos = base + Number(sU(s, base + 32 * i));
      const blen = Number(sU(s, pos));
      out.push('0x' + s.slice(2 * (pos + 32), 2 * (pos + 32 + blen)));
    }
    return out;
  }
  // the log's data as lowercase hex without its 0x, or null when it is not plain hex of whole bytes
  function plainData(log) {
    const raw = log.data || '0x';
    if (typeof raw !== 'string') return null;
    const t = (raw.startsWith('0x') ? raw.slice(2) : raw).toLowerCase();
    return t.length % 2 === 0 && PLAIN.test(t) ? t : null;
  }

  // Decode one raw log. Returns a structured event, or null if not one of ours.
  function decodeLog(log) {
    const topics = log.topics || [];
    if (!topics.length) return null;
    const kind = byTopic0[String(topics[0]).toLowerCase()];
    if (!kind) return null;
    const t = plainData(log);
    if (t === null) return decodeLogSlow(log);
    if (kind === 'LeavesInserted') {
      return { type: 'LeavesInserted', firstLeafIndex: Number(BigInt(topics[1])), leaves: sBytes32Array(t, Number(sU(t, 0))), memos: sBytesArray(t, Number(sU(t, 32))) };
    }
    if (kind === 'LockLeavesInserted') return { type: 'LockLeavesInserted', firstLockIndex: Number(BigInt(topics[1])), lockLeaves: sBytes32Array(t, Number(sU(t, 0))) };
    if (kind === 'NullifiersSpent') return { type: 'NullifiersSpent', nullifiers: sBytes32Array(t, Number(sU(t, 0))) };
    if (kind === 'CrossOutRecorded') return { type: 'CrossOutRecorded', claimId: String(topics[1]), destChain: Number(sU(t, 0)), destCommitment: sW(t, 32), nullifier: sW(t, 64), assetId: sW(t, 96) };
    if (kind === 'Wrap') return { type: 'Wrap', depositId: String(topics[1]), assetId: String(topics[2]), amount: sU(t, 0) };
    if (kind === 'Bonded') return { type: 'Bonded', receipt: String(topics[1]), pid: Number(BigInt(topics[2])), shares: sU(t, 0), unlockAt: Number(sU(t, 32)) };
    if (kind === 'Harvested') return { type: 'Harvested', receipt: String(topics[1]), pid: Number(BigInt(topics[2])), reward: sU(t, 0) };
    if (kind === 'CdpPositionInserted') return { type: 'CdpPositionInserted', leaf: String(topics[1]) };
    return null;
  }

  // The reading over bytes: what every log was read by before, and still reads the ones that are not plain hex.
  function decodeLogSlow(log) {
    const topics = log.topics || [];
    if (!topics.length) return null;
    const kind = byTopic0[String(topics[0]).toLowerCase()];
    if (!kind) return null;
    const data = toBytes(log.data || '0x');

    if (kind === 'LeavesInserted') {
      // indexed: firstLeafIndex (topic1). data: (bytes32[] leaves, bytes[] memos)
      const offLeaves = Number(uintAt(data, 0));
      const offMemos = Number(uintAt(data, 32));
      return {
        type: 'LeavesInserted',
        firstLeafIndex: Number(BigInt(topics[1])),
        leaves: readBytes32Array(data, offLeaves),
        memos: readBytesArray(data, offMemos),
      };
    }
    if (kind === 'LockLeavesInserted') {
      // indexed: firstLockIndex (topic1). data: (bytes32[] lockLeaves). Lock-set tree order; no memos here.
      return {
        type: 'LockLeavesInserted',
        firstLockIndex: Number(BigInt(topics[1])),
        lockLeaves: readBytes32Array(data, Number(uintAt(data, 0))),
      };
    }
    if (kind === 'NullifiersSpent') {
      // data: (bytes32[] nullifiers)
      return { type: 'NullifiersSpent', nullifiers: readBytes32Array(data, Number(uintAt(data, 0))) };
    }
    if (kind === 'CrossOutRecorded') {
      // indexed: claimId (topic1). data: (uint16 destChain, bytes32 dest, bytes32 nu, bytes32 asset)
      return {
        type: 'CrossOutRecorded',
        claimId: String(topics[1]),
        destChain: Number(uintAt(data, 0)),
        destCommitment: wordHexAt(data, 32),
        nullifier: wordHexAt(data, 64),
        assetId: wordHexAt(data, 96),
      };
    }
    if (kind === 'Wrap') {
      // indexed: depositId (topic1), assetId (topic2). data: (uint256 amount). The commitment
      // coordinates + owner are NOT emitted (deposit-spend unlinkability); a seed-only recovery
      // re-derives them per index and matches its computed depositId against topic1.
      return {
        type: 'Wrap',
        depositId: String(topics[1]),
        assetId: String(topics[2]),
        amount: uintAt(data, 0),
      };
    }
    if (kind === 'Bonded') {
      // indexed: receipt (topic1), pid (topic2). data: (uint256 shares, uint256 unlockAt). Emitted by the FarmManager,
      // not the pool: the caller filters the log's address.
      return {
        type: 'Bonded',
        receipt: String(topics[1]),
        pid: Number(BigInt(topics[2])),
        shares: uintAt(data, 0),
        unlockAt: Number(uintAt(data, 32)),
      };
    }
    if (kind === 'Harvested') {
      // indexed: receipt (topic1), pid (topic2). data: (uint256 reward). Also the FarmManager's.
      return { type: 'Harvested', receipt: String(topics[1]), pid: Number(BigInt(topics[2])), reward: uintAt(data, 0) };
    }
    if (kind === 'CdpPositionInserted') {
      // indexed: the new position leaf (topic1). The position's fields are in the settle calldata of the same tx.
      return { type: 'CdpPositionInserted', leaf: String(topics[1]) };
    }
    return null;
  }

  // Decode a batch of raw logs (in chain order) into the structured stream the
  // client indexer consumes; non-pool logs are dropped.
  // Carry each log's provenance onto the decoded event. The note indexer ignores the extra fields, but a
  // stealth-lock scan needs the tx hash: lock leaves come from LockLeavesInserted, while their memos (which
  // LeavesInserted carries only when the settle also minted notes) are read from the settle transaction's
  // calldata; the block/log index orders events as the chain emitted them.
  // A log object is decoded once: the same logs are decoded again by every read of the pool's history (the quick pass and the full one of a balance, the
  // swap card's own, a lock scan), and each decode of a few thousand logs is a few hundred milliseconds. What comes back is a copy of the event, so a
  // caller that sets a field on one does not set it on the next caller's; the arrays inside are shared and are not changed by anyone.
  const decoded = new WeakMap();
  function decodeLogs(logs) {
    const out = [];
    for (const log of logs || []) {
      const keep = log !== null && typeof log === 'object';
      let ev = keep ? decoded.get(log) : undefined;
      if (ev === undefined) {
        ev = decodeLog(log);
        if (ev) {
          ev.txHash = log.transactionHash || null;
          ev.blockNumber = log.blockNumber == null ? null : Number(BigInt(log.blockNumber));
          ev.logIndex = log.logIndex == null ? null : Number(BigInt(log.logIndex));
        }
        if (keep) decoded.set(log, ev || null);
      }
      if (ev) out.push({ ...ev });
    }
    return out;
  }

  return { decodeLog, decodeLogs, decodeLogSlow, TOPIC0, SIGS };
}
