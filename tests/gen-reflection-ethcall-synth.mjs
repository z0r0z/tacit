#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC ETH→BTC authenticated message (T_ETH_CALL, 0x69) and
// assert the guest lands on the JS assembler's newDigest — the reflect-exec guest<->JS parity check for the
// honored-message fold. The 0x69 envelope authenticates that `sender` called EthCallOutbox.send on Ethereum;
// authority is the message's membership in the eth-reflection message set (mode_b=1), NOT a Bitcoin key.
// Honoring records msg_id in the honored set — that IS the effect for an attestation handler, and it doubles
// as the one-shot replay gate. No note, no mint, no value.
//
// The pinned ETH_CALL_OUTBOX const in the guest is [0u8;20] until the CREATE3 salt is mined, so the eth proof's
// surfaced ethOutbox word is left zero here (buildEthPv outbox=null) on both the assembler pin and the guest
// const — the assert_eq in reflect.rs passes, otherwise a Mode-B proof would abort fail-closed.
//
// ETHCALL_SCENARIO selects the vector:
//   forward         forward-only batch (mode_b=0): a parseable 0x69 that is NOT in a Mode-B cycle. Witnesses
//                   are read (bogus) but eth_msg_set_root=0 → membership fails → no fold. honored unchanged.
//   member          mode_b=1, the 0x69's message IS a set member → honored_msg_count +1, digest advances.
//   replay          mode_b=1, the SAME message in two txs → first honors, the dup is a membership-gated no-op.
//   payload-mismatch mode_b=1 member set, but the envelope's payload does not hash to its payload_hash → the
//                   guest re-derives keccak(payload) and skips. honored unchanged.
//   wrong-destchain mode_b=1 member set, but dest_chain != Bitcoin → not honored. honored unchanged.
//   batched         mode_b=1: a 0x69 (member) + a 0x65 crossout mint (member) + a 0x2B reflected bridge burn in
//                   ONE block → all three fold, digest matches (the mixed-envelope stream-sync guard).
//   node tests/gen-reflection-ethcall-synth.mjs > /tmp/ethcall-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, dsha256, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16le = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');

const SCENARIO = process.env.ETHCALL_SCENARIO || 'member';
const BLOCK_HEIGHT = 319000;
const EMPTY_ETH_SET_ROOT = '0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757'; // KeccakTreeAccumulator::new().root()
const ETH_POOL = '0x' + '5a'.repeat(20); // eth ConfidentialPool the synthetic proof attests (word2); gated on-chain == address(this)
const DEST_BITCOIN = pool.DEST_CHAIN_BITCOIN;

// ── The message fields (mirror EthCallOutbox.send): the record binds dest_chain ‖ ns ‖ sender ‖ keccak(payload). ──
const NS = hx(keccak_256(Buffer.from('tacit-ns-attest-v1')));
const SENDER = Buffer.from('000000000000000000000000000000000000a11c', 'hex');
const PAYLOAD = Buffer.from('hello');
const PAYLOAD_HASH = hx(keccak_256(PAYLOAD));
const MSG_ID = hx(keccak_256(Buffer.from('ethcall-fixture-msgid')));

// Build the 0x69 witness envelope: opcode ‖ msg_id(32) ‖ ns(32) ‖ sender(20) ‖ dest_chain(2 BE) ‖
// payload_hash(32) ‖ payload_len(2 LE) ‖ payload(N) — matching bitcoin::parse_eth_call_envelope.
function ethCallEnvelope({ msgId, ns, sender, destChain, payloadHash, payload }) {
  return cat([[0x69], hb(msgId), hb(ns), sender, Buffer.from([(destChain >> 8) & 0xff, destChain & 0xff]), hb(payloadHash), u16le(payload.length), payload]);
}
// Wrap an envelope in a Taproot script-path reveal tx spending `prevTxid:prevVout` (matches extract_taproot_envelope).
function envRevealTx(envelope, prevTxid, prevVout) {
  const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], u16le(envelope.length), envelope, [0x68]]);
  const inputsBuf = cat([hb(prevTxid), u32le(prevVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  return cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
}
// Coinbase carrying the BIP141 witness commitment over N envelope txs (coinbase wtxid = 0).
function coinbaseForEnvTxs(envTxs) {
  const reserved = Buffer.alloc(32, 7);
  const wtxids = [Buffer.alloc(32), ...envTxs.map((t) => dsha256(t))];
  const witnessRoot = computeMerkleRoot(wtxids);
  const wcommit = dsha256(cat([witnessRoot, reserved]));
  const coinbase = cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
    [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
    [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
    [0x01], [0x20], reserved,
    Buffer.alloc(4),
  ]);
  const cbTxid = computeTxid(coinbase);
  return { coinbaseSpec: { txData: hx(coinbase), txid: hx(cbTxid), vins: [], env: null }, cbTxid };
}

// Assemble the mode_b bundle for a set of honored messages (+ optional crossout). ethOutbox stays zero so the
// guest's pinned [0;20] const matches; a nonzero outbox would abort the Mode-B gate.
function buildModeB(messages, crossouts) {
  const coImt = pool.makeImtAccumulator();
  for (const c of (crossouts || [])) coImt.insert(pool.ethCrossoutLeaf(c.claimId, DEST_BITCOIN, c.destCommitment, c.asset));
  const coRoot = coImt.root();
  const msgLeaves = messages.map((m) => pool.ethMessageLeaf(m.msgId, m.record));
  const msgRoot = msgLeaves.length ? pool.merkleRootFrom(msgLeaves[0], 0, pool.merklePath(msgLeaves, 0)) : EMPTY_ETH_SET_ROOT;
  const ethPv = pool.buildEthPv(coRoot, EMPTY_ETH_SET_ROOT, 0, (crossouts || []).length, ETH_POOL, msgRoot, msgLeaves.length, null);
  const ethBundle = { ethPv, crossouts: crossouts || [], consumeds: [], messages };
  return pool.buildModeBBatch(ethBundle, [], []).modeB;
}

const msgRecord = (over = {}) => {
  const f = { destChain: DEST_BITCOIN, ns: NS, sender: SENDER, payloadHash: PAYLOAD_HASH, ...over };
  return pool.ethMessageRecord(f.destChain, f.ns, f.sender, f.payloadHash);
};
const msgEnv = (over = {}) => ({ type: 'eth_call', msgId: MSG_ID, ns: NS, sender: hx(SENDER), destChain: DEST_BITCOIN, payloadHash: PAYLOAD_HASH, payload: hx(PAYLOAD), ...over });

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const coords = new Map();
const beforeHonored = state.honoredMsgCount();

let batch, txSpecs, expectHonor;

if (SCENARIO === 'forward') {
  // Forward-only: parseable 0x69 with NO mode_b cycle. The assembler emits bogus witnesses, the guest skips.
  const envelope = ethCallEnvelope({ msgId: MSG_ID, ns: NS, sender: SENDER, destChain: DEST_BITCOIN, payloadHash: PAYLOAD_HASH, payload: PAYLOAD });
  const tx = envRevealTx(envelope, hx(Buffer.alloc(32, 0x69)), 0);
  const txid = computeTxid(tx);
  const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
  const header = mineHeader(computeMerkleRoot([cbTxid, computeTxid(tx)]));
  txSpecs = [coinbaseSpec, { txData: hx(tx), txid: hx(txid), vins: [{ prevTxid: hx(Buffer.alloc(32, 0x69)), vout: 0 }], env: msgEnv() }];
  batch = { anchorHeight: BLOCK_HEIGHT, headers: [hx(header)], blocks: [{ txs: txSpecs }] };
  expectHonor = 0;
} else if (SCENARIO === 'member' || SCENARIO === 'payload-mismatch' || SCENARIO === 'wrong-destchain') {
  const bad = SCENARIO !== 'member';
  // The set always carries the WELL-FORMED message; the envelope is what varies (a mismatched payload / wrong
  // dest chain fails the guest's re-derivation and folds nothing even though the member is present).
  const messages = [{ msgId: MSG_ID, record: msgRecord() }];
  const modeB = buildModeB(messages, []);
  const env = SCENARIO === 'payload-mismatch'
    ? msgEnv({ payload: hx(Buffer.from('goodbye')) })     // keccak(payload) != payload_hash
    : SCENARIO === 'wrong-destchain'
      ? msgEnv({ destChain: 2 })                          // not Bitcoin
      : msgEnv();
  const envelope = ethCallEnvelope({ msgId: env.msgId, ns: env.ns, sender: hb(env.sender), destChain: env.destChain, payloadHash: env.payloadHash, payload: hb(env.payload) });
  const tx = envRevealTx(envelope, hx(Buffer.alloc(32, 0x69)), 0);
  const txid = computeTxid(tx);
  const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
  const header = mineHeader(computeMerkleRoot([cbTxid, txid]));
  txSpecs = [coinbaseSpec, { txData: hx(tx), txid: hx(txid), vins: [{ prevTxid: hx(Buffer.alloc(32, 0x69)), vout: 0 }], env }];
  batch = { anchorHeight: BLOCK_HEIGHT, headers: [hx(header)], blocks: [{ txs: txSpecs }], modeB };
  expectHonor = bad ? 0 : 1;
} else if (SCENARIO === 'replay') {
  const messages = [{ msgId: MSG_ID, record: msgRecord() }];
  const modeB = buildModeB(messages, []);
  const envelope = ethCallEnvelope({ msgId: MSG_ID, ns: NS, sender: SENDER, destChain: DEST_BITCOIN, payloadHash: PAYLOAD_HASH, payload: PAYLOAD });
  // Two txs carrying the SAME message; the second is a one-shot no-op.
  const txA = envRevealTx(envelope, hx(Buffer.alloc(32, 0x6a)), 0);
  const txB = envRevealTx(envelope, hx(Buffer.alloc(32, 0x6b)), 0);
  const { coinbaseSpec, cbTxid } = coinbaseForEnvTxs([txA, txB]);
  const idA = computeTxid(txA), idB = computeTxid(txB);
  const header = mineHeader(computeMerkleRoot([cbTxid, idA, idB]));
  txSpecs = [coinbaseSpec,
    { txData: hx(txA), txid: hx(idA), vins: [{ prevTxid: hx(Buffer.alloc(32, 0x6a)), vout: 0 }], env: msgEnv() },
    { txData: hx(txB), txid: hx(idB), vins: [{ prevTxid: hx(Buffer.alloc(32, 0x6b)), vout: 0 }], env: msgEnv() }];
  batch = { anchorHeight: BLOCK_HEIGHT, headers: [hx(header)], blocks: [{ txs: txSpecs }], modeB };
  expectHonor = 1; // honored once, the dup does not advance the set
} else if (SCENARIO === 'batched') {
  // A 0x69 message + a 0x65 crossout mint + a 0x2B reflected bridge burn in ONE block — the mixed-envelope
  // stream-sync guard: every fold reads its own witnesses in order and the digest still matches.
  const ASSET_CO = '0x' + 'a1'.repeat(32), CLAIM = '0x' + 'c1'.repeat(32), OWNER = '0x' + '00'.repeat(32);
  const { cx: coCx, cy: coCy } = pool.commitXY(50000n, 0xC0DEn);
  const destCommitment = pool.leaf(ASSET_CO, coCx, coCy, OWNER);
  const messages = [{ msgId: MSG_ID, record: msgRecord() }];
  const modeB = buildModeB(messages, [{ claimId: CLAIM, destCommitment, asset: ASSET_CO }]);

  // Seed a live btc-note for the reflected bridge burn to spend.
  const ASSET_BURN = '0x' + 'b2'.repeat(32), AUTH = '0x' + 'e7'.repeat(32), DEST = '0x' + 'de'.repeat(32), TARGET = '0x' + '7c'.repeat(32);
  const noteXY = pool.commitXY(5000n, 0x9a9an);
  const seedTxid = Buffer.alloc(32, 0x7b);
  const noteLeaf = pool.btcNoteLeaf(ASSET_BURN, noteXY.cx, noteXY.cy, AUTH);
  const nu = pool.nullifier(noteLeaf);
  const inOutpoint = pool.outpointKey(hx(seedTxid), 0);
  state.foldOutput(noteLeaf, inOutpoint, pool.commitmentHash(noteXY.cx, noteXY.cy), ASSET_BURN, AUTH);
  coords.set(inOutpoint.toLowerCase(), { cx: noteXY.cx, cy: noteXY.cy });

  // 0x69 message tx
  const msgEnvelope = ethCallEnvelope({ msgId: MSG_ID, ns: NS, sender: SENDER, destChain: DEST_BITCOIN, payloadHash: PAYLOAD_HASH, payload: PAYLOAD });
  const msgTx = envRevealTx(msgEnvelope, hx(Buffer.alloc(32, 0x69)), 0);
  // 0x65 crossout mint tx (opcode ‖ asset ‖ claim ‖ Cx ‖ Cy ‖ owner = 161B)
  const coEnvelope = cat([[0x65], hb(ASSET_CO), hb(CLAIM), hb(coCx), hb(coCy), hb(OWNER)]);
  const coTx = envRevealTx(coEnvelope, hx(Buffer.alloc(32, 0x65)), 0);
  // 0x2B reflected bridge burn (opcode ‖ asset ‖ poolRoot ‖ nu ‖ dest ‖ target = 161B)
  const burnEnvelope = cat([[0x2b], hb(ASSET_BURN), Buffer.alloc(32), hb(nu), hb(DEST), hb(TARGET)]);
  const burnTx = envRevealTx(burnEnvelope, hx(seedTxid), 0);

  const { coinbaseSpec, cbTxid } = coinbaseForEnvTxs([burnTx, coTx, msgTx]);
  const idBurn = computeTxid(burnTx), idCo = computeTxid(coTx), idMsg = computeTxid(msgTx);
  const header = mineHeader(computeMerkleRoot([cbTxid, idBurn, idCo, idMsg]));
  txSpecs = [coinbaseSpec,
    { txData: hx(burnTx), txid: hx(idBurn), vins: [{ prevTxid: hx(seedTxid), vout: 0 }], env: { type: 'burn', assetId: ASSET_BURN, nullifier: nu, dest: DEST, target: TARGET } },
    { txData: hx(coTx), txid: hx(idCo), vins: [{ prevTxid: hx(Buffer.alloc(32, 0x65)), vout: 0 }], env: { type: 'crossout_mint', asset: ASSET_CO, claimId: CLAIM, cx: coCx, cy: coCy, owner: OWNER } },
    { txData: hx(msgTx), txid: hx(idMsg), vins: [{ prevTxid: hx(Buffer.alloc(32, 0x69)), vout: 0 }], env: msgEnv() }];
  batch = { anchorHeight: BLOCK_HEIGHT, headers: [hx(header)], blocks: [{ txs: txSpecs }], modeB };
  expectHonor = 1;
} else {
  console.error(`unknown ETHCALL_SCENARIO: ${SCENARIO}`);
  process.exit(1);
}

const input = await pool.assembleReflectionScanInput(state, batch, coords);
const afterHonored = state.honoredMsgCount();
const honored = afterHonored - beforeHonored;

if (honored !== expectHonor) {
  console.error(`FATAL[${SCENARIO}]: honored delta ${honored} != expected ${expectHonor} (${beforeHonored}->${afterHonored})`);
  process.exit(1);
}
if (expectHonor && !state.honoredMsgs.contains(MSG_ID)) {
  console.error(`FATAL[${SCENARIO}]: message honored but msg_id absent from the honored set`);
  process.exit(1);
}
if (SCENARIO === 'batched') {
  if (state.counts().burn === 0) { console.error('FATAL[batched]: bridge burn did not record'); process.exit(1); }
}
console.error(`ethcall[${SCENARIO}]: modeB=${input.modeB} honored ${beforeHonored}->${afterHonored} (Δ${honored}) newDigest=${input.newDigest}`);
console.log(JSON.stringify(input));
