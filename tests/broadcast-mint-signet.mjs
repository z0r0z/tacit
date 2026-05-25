#!/usr/bin/env node
/**
 * Broadcasts a T_BRIDGE_DEPOSIT OP_RETURN on signet.
 * Builds a minimal P2WPKH → OP_RETURN + change transaction.
 */
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { randomBytes } from 'crypto';

const PRIVKEY = '827aee3498ebbf5f4374387dc9937741ac87ec58a7a67c8091241d0797589222';
const MEMPOOL_API = 'https://mempool.space/signet/api';
const NETWORK_TAG = 0x01;
const ASSET_ID = 'd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b';
const DENOM_WEI = '00000000000000000000000000000000000000000000000000038d7ea4c68000';

function hex(b) { return Buffer.from(b).toString('hex'); }
function unhex(s) { return Buffer.from(s, 'hex'); }
function sha256d(data) { return sha256(sha256(data)); }
function hash160(data) { return ripemd160(sha256(data)); }

function compressedPubkey(privHex) {
  return secp.getPublicKey(privHex, true);
}

function p2wpkhScript(pubkey) {
  const h = hash160(pubkey);
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.from(h)]);
}

function writeVarInt(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}

function writeU32LE(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function writeU64LE(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

function buildMintEnvelope() {
  const buf = Buffer.alloc(517);
  let o = 0;
  buf[o++] = 0x60; // T_BRIDGE_DEPOSIT
  buf[o++] = NETWORK_TAG;
  unhex(ASSET_ID).copy(buf, o); o += 32;
  unhex(DENOM_WEI).copy(buf, o); o += 32;
  // eth_root — placeholder
  buf[o + 31] = 0x01; o += 32;
  // nullifier_hash
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;
  // recipient_commit (33)
  buf[o] = 0x02; o += 33;
  // leaf_hash
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;
  // r_leaf
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;
  // bind_hash — placeholder (mock verifier)
  o += 32;
  // proof_length LE = 256
  buf[o++] = 0x00; buf[o++] = 0x01;
  // proof = 256 zeros (mock)
  return buf;
}

async function main() {
  console.log('=== Broadcast T_BRIDGE_DEPOSIT on Signet ===\n');

  const pubkey = compressedPubkey(PRIVKEY);
  const pubkeyHash = hash160(pubkey);
  const address = 'tb1qc0tjnm339uu89as6lhauegpc340m747n3jnsu5';
  console.log(`Address: ${address}`);
  console.log(`Pubkey: ${hex(pubkey)}`);

  // Get confirmed UTXO
  const resp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
  const utxos = await resp.json();
  const utxo = utxos.find(u => u.status.confirmed);
  if (!utxo) throw new Error('No confirmed UTXO');
  console.log(`UTXO: ${utxo.txid}:${utxo.vout} = ${utxo.value} sats\n`);

  // Build envelope
  const envelope = buildMintEnvelope();
  console.log(`Envelope: ${envelope.length} bytes`);

  // Build OP_RETURN script
  const opRetScript = Buffer.concat([
    Buffer.from([0x6a, 0x4d]),
    writeU32LE(envelope.length).slice(0, 2), // 2-byte LE length
    envelope
  ]);

  // Fee estimate: ~300 vbytes * 2 sat/vb = 600 sats
  const fee = 1000;
  const change = utxo.value - fee;
  if (change < 546) throw new Error('Not enough sats for change');

  // Change output: P2WPKH back to self
  const changeScript = p2wpkhScript(pubkey);

  // === Build unsigned transaction ===
  const version = writeU32LE(2);
  const marker = Buffer.from([0x00, 0x01]); // segwit

  // Input
  const prevTxid = Buffer.from(utxo.txid, 'hex').reverse();
  const prevVout = writeU32LE(utxo.vout);
  const sequence = writeU32LE(0xfffffffd);

  // Outputs: OP_RETURN + change
  const outputs = Buffer.concat([
    writeVarInt(2),
    // Output 0: OP_RETURN (value = 0)
    writeU64LE(0),
    writeVarInt(opRetScript.length),
    opRetScript,
    // Output 1: change
    writeU64LE(change),
    writeVarInt(changeScript.length),
    changeScript,
  ]);

  const locktime = writeU32LE(0);

  // === BIP143 sighash for P2WPKH ===
  const hashPrevouts = sha256d(Buffer.concat([prevTxid, prevVout]));
  const hashSequence = sha256d(sequence);
  const hashOutputs = sha256d(outputs.slice(1)); // skip varint count

  // Actually hashOutputs needs all outputs serialized without the count varint
  const allOutputsSerialized = Buffer.concat([
    writeU64LE(0), writeVarInt(opRetScript.length), opRetScript,
    writeU64LE(change), writeVarInt(changeScript.length), changeScript,
  ]);
  const hashOutputsFinal = sha256d(allOutputsSerialized);

  // scriptCode for P2WPKH = OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  const scriptCode = Buffer.concat([
    Buffer.from([0x19, 0x76, 0xa9, 0x14]),
    Buffer.from(pubkeyHash),
    Buffer.from([0x88, 0xac])
  ]);

  const sighashPreimage = Buffer.concat([
    version,
    Buffer.from(hashPrevouts),
    Buffer.from(hashSequence),
    prevTxid, prevVout,
    scriptCode,
    writeU64LE(utxo.value),
    sequence,
    Buffer.from(hashOutputsFinal),
    locktime,
    writeU32LE(1), // SIGHASH_ALL
  ]);

  const sighash = sha256d(sighashPreimage);
  console.log(`Sighash: ${hex(sighash)}`);

  // Sign
  const sig = await secp.signAsync(sighash, PRIVKEY, { lowS: true });
  const compact = sig.toCompactRawBytes();
  const r = compact.slice(0, 32);
  const s = compact.slice(32, 64);
  function derInt(buf) {
    let b = Buffer.from(buf);
    if (b[0] >= 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.slice(1);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  }
  const derR = derInt(r);
  const derS = derInt(s);
  const derBody = Buffer.concat([derR, derS]);
  const derBytes = Buffer.concat([Buffer.from([0x30, derBody.length]), derBody]);
  const derSig = Buffer.concat([derBytes, Buffer.from([0x01])]); // + SIGHASH_ALL

  // === Assemble final tx ===
  const rawTx = Buffer.concat([
    version,
    marker,
    writeVarInt(1), // 1 input
    prevTxid, prevVout,
    writeVarInt(0), // empty scriptsig (segwit)
    sequence,
    outputs,
    // Witness
    writeVarInt(2), // 2 witness items
    writeVarInt(derSig.length), derSig,
    writeVarInt(pubkey.length), Buffer.from(pubkey),
    locktime,
  ]);

  console.log(`\nRaw tx: ${rawTx.length} bytes`);
  console.log(`Tx hex: ${hex(rawTx).slice(0, 80)}...`);

  // Broadcast
  console.log('\nBroadcasting...');
  const broadcastResp = await fetch(`${MEMPOOL_API}/tx`, {
    method: 'POST',
    body: hex(rawTx),
  });
  const result = await broadcastResp.text();
  if (broadcastResp.ok) {
    console.log(`✅ Broadcast successful! TXID: ${result}`);
  } else {
    console.log(`❌ Broadcast failed: ${result}`);
    console.log(`\nFull raw tx hex for manual broadcast:`);
    console.log(hex(rawTx));
  }
}

main().catch(console.error);
