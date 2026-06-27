// Minimal Bitcoin tx/block helpers for confidential bridge_mint test witnesses.
// Byte-for-byte compatible with cxfer-core::bitcoin (the guest's verifier): segwit
// txid (witness-stripped), double-sha256 merkle, nBits→target, and an easy-target
// miner so a test block carries valid PoW the guest accepts. Test-only.

import { createHash } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(Buffer.from(b)).digest();
export const dsha256 = (b) => sha256(sha256(b)); // Buffer(32), internal byte order
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
export const cat = (arr) => Buffer.concat(arr.map((x) => Buffer.from(x)));

export function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return cat([[0xfd], u16le(n)]);
  return cat([[0xfe], u32le(n)]);
}

// read a varint at pos → [value, bytesConsumed]
function readVarint(buf, pos) {
  const f = buf[pos];
  if (f < 0xfd) return [f, 1];
  if (f === 0xfd) return [buf.readUInt16LE(pos + 1), 3];
  if (f === 0xfe) return [buf.readUInt32LE(pos + 1), 5];
  return [Number(buf.readBigUInt64LE(pos + 1)), 9];
}

// segwit txid = double_sha256(version ‖ inputs ‖ outputs ‖ locktime), witness stripped
// (mirror of cxfer-core::bitcoin::compute_txid).
export function computeTxid(tx) {
  const segwit = tx.length > 5 && tx[4] === 0x00 && tx[5] === 0x01;
  if (!segwit) return dsha256(tx);
  const version = tx.subarray(0, 4);
  let pos = 6;
  const inputsStart = pos;
  const [inCount, vl] = readVarint(tx, pos); pos += vl;
  for (let i = 0; i < inCount; i++) {
    pos += 36;
    const [sl, vl2] = readVarint(tx, pos); pos += vl2 + sl + 4;
  }
  const [outCount, vl3] = readVarint(tx, pos); pos += vl3;
  for (let i = 0; i < outCount; i++) {
    pos += 8;
    const [sl, vl4] = readVarint(tx, pos); pos += vl4 + sl;
  }
  const outputsEnd = pos;
  // locktime is the final 4 bytes
  const locktime = tx.subarray(tx.length - 4);
  return dsha256(cat([version, tx.subarray(inputsStart, outputsEnd), locktime]));
}

// merkle root of txids (Buffers) — Bitcoin duplicates the odd leaf.
export function computeMerkleRoot(txids) {
  if (txids.length === 1) return Buffer.from(txids[0]);
  let layer = txids.map((t) => Buffer.from(t));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const l = layer[i], r = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(dsha256(cat([l, r])));
    }
    layer = next;
  }
  return layer[0];
}

// nBits → 256-bit big-endian target (mirror of cxfer-core::bitcoin::bits_to_target).
export function bitsToTarget(bits) {
  const exp = bits >>> 24;
  const mantissa = bits & 0x7fffff;
  const t = Buffer.alloc(32);
  if (exp <= 3) {
    const val = mantissa >>> (8 * (3 - exp));
    t.writeUInt32BE(val >>> 0, 28);
  } else {
    const shift = exp - 3;
    if (shift + 4 <= 32) t.writeUInt32BE(mantissa >>> 0, 32 - shift - 4);
  }
  return t;
}

const reverse = (b) => Buffer.from(b).reverse();
const lte = (a, b) => Buffer.compare(a, b) <= 0;

// Build an 80-byte header for merkleRoot and grind the nonce to valid PoW.
// Easy nBits (e.g. 0x1f00ffff) → ~2^16 hashes, sub-second. `prevHash` (32B, internal byte order =
// dsha256 of the previous header) chains a multi-block batch so verify_header_chain links; default zero.
export function mineHeader(merkleRoot, bits = 0x1f00ffff, prevHash = null) {
  const target = bitsToTarget(bits);
  const header = Buffer.alloc(80);
  header.writeUInt32LE(0x20000000, 0);        // version
  if (prevHash) Buffer.from(prevHash).copy(header, 4); // prev block hash (chains the batch)
  Buffer.from(merkleRoot).copy(header, 36);    // merkle root
  header.writeUInt32LE(1700000000, 68);        // time (fixed)
  header.writeUInt32LE(bits, 72);              // nBits
  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    header.writeUInt32LE(nonce, 76);
    if (lte(reverse(dsha256(header)), target)) return header;
  }
  throw new Error('no nonce found');
}

// Build a coinbase tx (block tx 0) with a valid BIP141 witness commitment over a single envelope tx.
// The reflection guest extracts Taproot envelopes ONLY for ti != 0 (tx 0 is the coinbase), so any
// envelope-bearing tx MUST be a later tx — a single-tx block (`txs: [envSpec]`) makes the guest treat the
// envelope tx as the coinbase and skip it, diverging from the JS assembler (which folds by explicit env type).
// witnessRoot = dSHA256(coinbaseWtxid=0 ‖ envWtxid), envWtxid = dSHA256(full env tx); commitment =
// dSHA256(witnessRoot ‖ reserved). Use as: blocks: [{ txs: [coinbaseSpec, envSpec] }], header over [cbTxid, envTxid].
export function makeCoinbaseForEnvTx(envTx) {
  const reserved = Buffer.alloc(32, 7);
  const wcommit = dsha256(cat([dsha256(cat([Buffer.alloc(32), dsha256(envTx)])), reserved]));
  const coinbase = cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],                                  // version, marker, flag
    [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff], // 1 coinbase input
    [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,        // 1 output: commitment
    [0x01], [0x20], reserved,                                                // witness: 32-byte reserved value
    Buffer.alloc(4),                                                         // locktime
  ]);
  const cbTxid = computeTxid(coinbase);
  return {
    coinbaseSpec: { txData: '0x' + coinbase.toString('hex'), txid: '0x' + Buffer.from(cbTxid).toString('hex'), vins: [], env: null },
    cbTxid,
  };
}

// Build a P2TR script-path reveal tx embedding `payload` (the Tacit envelope body)
// via the "TACIT"||v1 frame + OP_PUSHDATA2, matching extract_taproot_envelope.
export function buildRevealTx(payload) {
  const script = cat([
    [0x20], Buffer.alloc(32),       // PUSH32 xonly
    [0xac],                          // OP_CHECKSIG
    [0x00, 0x63],                    // OP_FALSE OP_IF
    [0x05], Buffer.from('TACIT'),    // PUSH5 "TACIT"
    [0x01, 0x01],                    // PUSH1 v1
    [0x4d], Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff]), payload, // OP_PUSHDATA2
    [0x68],                          // OP_ENDIF
  ]);
  return cat([
    [0x02, 0x00, 0x00, 0x00],        // version 2
    [0x00, 0x01],                    // segwit marker+flag
    [0x01],                          // 1 input
    Buffer.alloc(32), Buffer.alloc(4), [0x00], [0xfd, 0xff, 0xff, 0xff], // prevout, empty scriptSig, sequence
    [0x01],                          // 1 output
    Buffer.alloc(8), [0x00],         // 0 value, empty scriptPubKey
    [0x03],                          // 3 witness items
    [0x40], Buffer.alloc(0x40),      // signature (64B)
    varint(script.length), script,   // script item
    [0x21], Buffer.alloc(0x21, 0xc0),// control block (33B)
    Buffer.alloc(4),                 // locktime
  ]);
}
