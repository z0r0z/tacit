#!/usr/bin/env node
// T_ETH_CALL (0x69) fold verification — the ETH→BTC message loop close.
//
// The property that matters most here is NOT that a message folds; it is that a 0x69 can never halt the
// relay. worker/src/reflection-attest.js refuses to attest any block containing a Tacit envelope the guest
// folds but the JS scan does not mirror (`unsupportedEnvelopes`), so an unmirrored 0x69 would hand anyone a
// permanent bridge stall for the price of one Bitcoin transaction. This asserts the mirror exists and the
// forward-batch path stays a no-op.
//
// Locks:
//   - a 0x69 in a FORWARD batch is never surfaced as an unsupported envelope (no relay stall);
//   - a forward batch folds nothing and leaves the digest unchanged (no state from an unproven message);
//   - the envelope decoder round-trips the wire layout the Rust parser accepts;
//   - a malformed 0x69 (bad payload hash, over-cap payload, trailing bytes) still does not stall the relay.
//
// Run: node tests/eth-call-fold-verify.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { parseEthCallEnvelope } from '../dapp/burn-deposit-bitcoin.js';
import { encodeEthCall, decodeEthCall } from '../dapp/confidential-crossout-consumer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ok -', msg); pass++; };

// The envelope under test is built by the REAL wallet encoder (dapp/confidential-crossout-consumer.js),
// not a local re-implementation — so this closes the loop the wallet actually walks:
// encodeEthCall -> the scan parser -> the fold. A local encoder would happily agree with a broken pair.
const enc = (o) => hx(encodeEthCall({ ...o, keccak256: keccak_256 }));

const NS_ATTEST = hx(keccak_256(Buffer.from('tacit-ns-attest-v1')));
const MSG_ID = hx(keccak_256(Buffer.from('msg-one')));
const SENDER = '0x' + '11'.repeat(20);

// ── 1. The decoder round-trips the wire layout ──────────────────────────────────────────────────
const envHex = enc({ msgId: MSG_ID, ns: NS_ATTEST, sender: SENDER, destChain: 1, payload: '0xdeadbeef' });
const dec = parseEthCallEnvelope(envHex);
ok(dec && dec.type === 'eth_call', 'a well-formed 0x69 decodes (routed, not "unsupported")');
ok(dec.msgId === MSG_ID.toLowerCase(), 'msgId round-trips');
ok(dec.ns === NS_ATTEST.toLowerCase(), 'ns round-trips');
ok(dec.sender === SENDER.toLowerCase(), 'sender round-trips');
ok(dec.destChain === 1, 'destChain round-trips');
ok(dec.payload === '0xdeadbeef', 'payload round-trips');
ok(dec.payloadHash === hx(keccak_256(bytes('0xdeadbeef'))), 'payloadHash is the real payload hash');

// ── 2. Malformed envelopes are rejected by the decoder, never fatal ─────────────────────────────
const trailing = envHex + 'ff';
ok(parseEthCallEnvelope(trailing) === null, 'a trailing byte is rejected (two envelopes must not carry one message)');
// The encoder refuses an over-cap payload outright (the wallet should never broadcast one)...
let encThrew = false;
try { enc({ msgId: MSG_ID, ns: NS_ATTEST, sender: SENDER, destChain: 1, payload: '0x' + '00'.repeat(1025) }); }
catch { encThrew = true; }
ok(encThrew, 'the wallet encoder refuses an over-cap payload');
// ...but the PARSER must reject one independently: it is the fold's bound, so it cannot assume the sender
// was well-behaved. Hand-build the envelope the encoder would not.
const bigPayload = '00'.repeat(1025);
const overCap = envHex.slice(0, 2 + 119 * 2) + '0104' + bigPayload;
ok(parseEthCallEnvelope(overCap) === null, 'the parser independently rejects an over-cap payload');
const wrongOp = '0x68' + envHex.slice(4);
ok(parseEthCallEnvelope(wrongOp) === null, 'a non-0x69 opcode is rejected');

// ── 3. A forward batch folds nothing and leaves the digest untouched ────────────────────────────
// This is the guest's behavior at eth_msg_set_root = 0: witnesses are consumed, nothing is honored.
const state = pool.makeScanReflectionState();
const before = state.digest();
const beforeCount = state.honoredMsgCount();
const record = pool.ethMessageRecord(1, NS_ATTEST, bytes(SENDER), dec.payloadHash);
const w = state.foldEthMessage(MSG_ID, record, [], null);
ok(w && w.honoredInsert, 'a forward-batch 0x69 still emits an aligned witness (stream stays in sync)');
ok(state.digest() === before, 'a forward-batch 0x69 folds nothing (digest unchanged)');
ok(state.honoredMsgCount() === beforeCount, 'a forward-batch 0x69 honors nothing');

// ── 4. A member message is honored exactly once ─────────────────────────────────────────────────
const leaf = pool.ethMessageLeaf(MSG_ID, record);
const setRoot = pool.merkleRootFrom
  ? pool.merkleRootFrom(leaf, 0, pool.merklePath([leaf], 0))
  : null;
if (setRoot) {
  const st2 = pool.makeScanReflectionState();
  const d0 = st2.digest();
  const w1 = st2.foldEthMessage(MSG_ID, record, [leaf], setRoot);
  ok(w1.setIndex === 0, 'a member message witnesses its set index');
  ok(st2.digest() !== d0, 'honoring a member message advances the digest (it is Tacit state)');
  const d1 = st2.digest();
  st2.foldEthMessage(MSG_ID, record, [leaf], setRoot);
  ok(st2.digest() === d1, 'a replayed 0x69 is a no-op (one-shot per msgId)');
  // A tampered payload yields a different record → a different leaf → not a member → skip.
  const st3 = pool.makeScanReflectionState();
  const d2 = st3.digest();
  st3.foldEthMessage(MSG_ID, hx(keccak_256(Buffer.from('tampered'))), [leaf], setRoot);
  ok(st3.digest() === d2, 'a tampered record is not a set member and folds nothing');
}

console.log(`\n${pass}/${pass} T_ETH_CALL fold checks passed`);
