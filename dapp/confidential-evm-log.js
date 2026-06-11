// Confidential-pool EVM log decoder — the worker/indexer side. Turns raw chain
// logs ({topics, data}) emitted by ConfidentialPool into the structured event
// stream that confidential-indexer.js consumes for seed-only recovery. The worker
// subscribes to the contract, decodes with this, and serves the ordered stream;
// the client recovers. No off-chain note storage — the chain is the source.
//
// Decodes: LeavesInserted, NullifiersSpent, CrossOutRecorded, BridgeMinted, Wrap.
// Minimal in-module ABI reading (no ethers/web3 dep), exactly the shapes these
// events use. keccak256 injected for the topic0 signature hashes.

export function makeConfidentialEvmLog({ keccak256 }) {
  const enc = new TextEncoder();
  const hex = (b) => Buffer.from(b).toString('hex');
  const toBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
  const hx = (b) => '0x' + hex(b);
  const topic = (sig) => '0x' + hex(keccak256(enc.encode(sig)));

  const SIGS = {
    LeavesInserted: 'LeavesInserted(uint256,bytes32[],bytes[])',
    NullifiersSpent: 'NullifiersSpent(bytes32[])',
    CrossOutRecorded: 'CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)',
    BridgeMinted: 'BridgeMinted(bytes32)',
    Wrap: 'Wrap(bytes32,bytes32,uint256,bytes32,bytes32,bytes32)',
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

  // Decode one raw log. Returns a structured event, or null if not one of ours.
  function decodeLog(log) {
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
    if (kind === 'BridgeMinted') {
      return { type: 'BridgeMinted', claimId: String(topics[1]) };
    }
    if (kind === 'Wrap') {
      // indexed: depositId (topic1), assetId (topic2). data: (uint256 amount, bytes32 cx, bytes32 cy, bytes32 owner)
      return {
        type: 'Wrap',
        depositId: String(topics[1]),
        assetId: String(topics[2]),
        amount: uintAt(data, 0),
        cx: wordHexAt(data, 32),
        cy: wordHexAt(data, 64),
        owner: wordHexAt(data, 96),
      };
    }
    return null;
  }

  // Decode a batch of raw logs (in chain order) into the structured stream the
  // client indexer consumes; non-pool logs are dropped.
  function decodeLogs(logs) {
    return (logs || []).map(decodeLog).filter(Boolean);
  }

  return { decodeLog, decodeLogs, TOPIC0, SIGS };
}
