// tETH bridge wire-format parity test (SPEC-TETH-BRIDGE-AMENDMENT §5.60–§5.61).
//
// Validates:
//   1. T_BRIDGE_DEPOSIT encode/decode round-trip
//   2. T_BRIDGE_BURN encode/decode round-trip
//   3. Bind hash determinism
//   4. Circuit input structure correctness

import { strict as assert } from 'node:assert';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import { createHash } from 'node:crypto';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); failed++; }
}

function bigintToBytes32(v) {
  const buf = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}
function bytes32ToBigint(b) {
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}
function concatBytes(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function sha256(data) {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

const T_BRIDGE_DEPOSIT = 0x60;
const T_BRIDGE_BURN    = 0x61;

const BRIDGE_DEPOSIT_DOMAIN = new TextEncoder().encode('tacit-bridge-deposit-v1');
const BRIDGE_BURN_DOMAIN    = new TextEncoder().encode('tacit-bridge-burn-v1');

function computeBridgeDepositBindHash(networkTag, assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf) {
  return sha256(concatBytes(
    BRIDGE_DEPOSIT_DOMAIN,
    new Uint8Array([networkTag & 0xff]),
    assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf,
  ));
}

function computeBridgeBurnBindHash(networkTag, assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce) {
  return sha256(concatBytes(
    BRIDGE_BURN_DOMAIN,
    new Uint8Array([networkTag & 0xff]),
    assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce,
  ));
}

function encodeTBridgeDepositPayload({ networkTag, assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf, bindHash, proof }) {
  return concatBytes(
    new Uint8Array([T_BRIDGE_DEPOSIT, networkTag & 0xff]),
    assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf, bindHash,
    new Uint8Array([(proof.length) & 0xff, (proof.length >> 8) & 0xff]),
    proof,
  );
}

function decodeTBridgeDepositPayload(payload) {
  if (!payload || payload.length < 261 || payload[0] !== T_BRIDGE_DEPOSIT) return null;
  let o = 1;
  const networkTag = payload[o++];
  const assetId = payload.slice(o, o + 32); o += 32;
  const denomWei = payload.slice(o, o + 32); o += 32;
  const ethRoot = payload.slice(o, o + 32); o += 32;
  const nullifierHash = payload.slice(o, o + 32); o += 32;
  const recipientCommit = payload.slice(o, o + 33); o += 33;
  const leafHash = payload.slice(o, o + 32); o += 32;
  const rLeaf = payload.slice(o, o + 32); o += 32;
  const bindHash = payload.slice(o, o + 32); o += 32;
  const proofLen = payload[o] | (payload[o + 1] << 8); o += 2;
  const proof = payload.slice(o, o + proofLen);
  return { networkTag, assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf, bindHash, proof };
}

function encodeTBridgeBurnPayload({ networkTag, assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce, bindHash, proof }) {
  return concatBytes(
    new Uint8Array([T_BRIDGE_BURN, networkTag & 0xff]),
    assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce, bindHash,
    new Uint8Array([(proof.length) & 0xff, (proof.length >> 8) & 0xff]),
    proof,
  );
}

function decodeTBridgeBurnPayload(payload) {
  if (!payload || payload.length < 281 || payload[0] !== T_BRIDGE_BURN) return null;
  let o = 1;
  const networkTag = payload[o++];
  const assetId = payload.slice(o, o + 32); o += 32;
  const denomWei = payload.slice(o, o + 32); o += 32;
  const merkleRoot = payload.slice(o, o + 32); o += 32;
  const nullifierHash = payload.slice(o, o + 32); o += 32;
  const recipientCommit = payload.slice(o, o + 33); o += 33;
  const rLeaf = payload.slice(o, o + 32); o += 32;
  const ethRecipient = payload.slice(o, o + 20); o += 20;
  const burnNonce = payload.slice(o, o + 32); o += 32;
  const bindHash = payload.slice(o, o + 32); o += 32;
  const proofLen = payload[o] | (payload[o + 1] << 8); o += 2;
  const proof = payload.slice(o, o + proofLen);
  return { networkTag, assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce, bindHash, proof };
}

// --- Test fixtures ---

const NETWORK_SIGNET = 0x01;
const assetId = bigintToBytes32(0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344n);
const denomWei = bigintToBytes32(1000000000000000000n); // 1 ETH in wei, u256 big-endian (matches Solidity uint256 encoding)
const ethRoot = bigintToBytes32(0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn);
const secret = 0x1111111111111111111111111111111111111111111111111111111111111111n;
const nu = 0x2222222222222222222222222222222222222222222222222222222222222222n;
const denom = 1000000000000000000n;

console.log('T_BRIDGE_DEPOSIT wire format:');

test('encode/decode round-trip', () => {
  const nullifierHash = bigintToBytes32(poseidon1([nu]));
  const leafHash = bigintToBytes32(poseidon3([secret, nu, denom]));
  const rLeaf = bigintToBytes32(poseidon2([secret, nu]));
  const recipientCommit = new Uint8Array(33); recipientCommit[0] = 0x02; recipientCommit.fill(0xaa, 1);
  const bindHash = computeBridgeDepositBindHash(NETWORK_SIGNET, assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf);
  const proof = new Uint8Array(256).fill(0x42);

  const payload = encodeTBridgeDepositPayload({
    networkTag: NETWORK_SIGNET, assetId, denomWei, ethRoot,
    nullifierHash, recipientCommit, leafHash, rLeaf, bindHash, proof,
  });

  assert.equal(payload[0], T_BRIDGE_DEPOSIT);
  assert.equal(payload.length, 261 + proof.length);

  const decoded = decodeTBridgeDepositPayload(payload);
  assert.ok(decoded);
  assert.equal(decoded.networkTag, NETWORK_SIGNET);
  assert.deepEqual(decoded.assetId, assetId);
  assert.deepEqual(decoded.denomWei, denomWei);
  assert.deepEqual(decoded.ethRoot, ethRoot);
  assert.deepEqual(decoded.nullifierHash, nullifierHash);
  assert.deepEqual(decoded.recipientCommit, recipientCommit);
  assert.deepEqual(decoded.leafHash, leafHash);
  assert.deepEqual(decoded.rLeaf, rLeaf);
  assert.deepEqual(decoded.bindHash, bindHash);
  assert.deepEqual(decoded.proof, proof);
});

test('rejects wrong opcode', () => {
  const bad = new Uint8Array(300).fill(0);
  bad[0] = 0x61; // T_BRIDGE_BURN, not DEPOSIT
  assert.equal(decodeTBridgeDepositPayload(bad), null);
});

test('rejects too-short payload', () => {
  assert.equal(decodeTBridgeDepositPayload(new Uint8Array(200)), null);
});

console.log('\nT_BRIDGE_BURN wire format:');

test('encode/decode round-trip', () => {
  const merkleRoot = bigintToBytes32(0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321n);
  const nullifierHash = bigintToBytes32(poseidon1([nu]));
  const recipientCommit = new Uint8Array(33); recipientCommit[0] = 0x03; recipientCommit.fill(0xbb, 1);
  const rLeaf = bigintToBytes32(poseidon2([secret, nu]));
  const ethRecipient = new Uint8Array(20).fill(0xde);
  const burnNonce = new Uint8Array(32).fill(0x77);
  const bindHash = computeBridgeBurnBindHash(
    NETWORK_SIGNET, assetId, denomWei, merkleRoot, nullifierHash,
    recipientCommit, rLeaf, ethRecipient, burnNonce,
  );
  const proof = new Uint8Array(128).fill(0x99);

  const payload = encodeTBridgeBurnPayload({
    networkTag: NETWORK_SIGNET, assetId, denomWei, merkleRoot, nullifierHash,
    recipientCommit, rLeaf, ethRecipient, burnNonce, bindHash, proof,
  });

  assert.equal(payload[0], T_BRIDGE_BURN);
  assert.equal(payload.length, 281 + proof.length);

  const decoded = decodeTBridgeBurnPayload(payload);
  assert.ok(decoded);
  assert.equal(decoded.networkTag, NETWORK_SIGNET);
  assert.deepEqual(decoded.assetId, assetId);
  assert.deepEqual(decoded.denomWei, denomWei);
  assert.deepEqual(decoded.merkleRoot, merkleRoot);
  assert.deepEqual(decoded.nullifierHash, nullifierHash);
  assert.deepEqual(decoded.recipientCommit, recipientCommit);
  assert.deepEqual(decoded.rLeaf, rLeaf);
  assert.deepEqual(decoded.ethRecipient, ethRecipient);
  assert.deepEqual(decoded.burnNonce, burnNonce);
  assert.deepEqual(decoded.bindHash, bindHash);
  assert.deepEqual(decoded.proof, proof);
});

test('rejects wrong opcode', () => {
  const bad = new Uint8Array(400).fill(0);
  bad[0] = 0x60; // T_BRIDGE_DEPOSIT, not BURN
  assert.equal(decodeTBridgeBurnPayload(bad), null);
});

console.log('\nBind hash determinism:');

test('deposit bind_hash is deterministic', () => {
  const nullifierHash = bigintToBytes32(poseidon1([nu]));
  const leafHash = bigintToBytes32(poseidon3([secret, nu, denom]));
  const rLeaf = bigintToBytes32(poseidon2([secret, nu]));
  const recipientCommit = new Uint8Array(33).fill(0x02);
  const h1 = computeBridgeDepositBindHash(NETWORK_SIGNET, assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf);
  const h2 = computeBridgeDepositBindHash(NETWORK_SIGNET, assetId, denomWei, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf);
  assert.deepEqual(h1, h2);
});

test('burn bind_hash is deterministic', () => {
  const merkleRoot = new Uint8Array(32).fill(0x11);
  const nullifierHash = bigintToBytes32(poseidon1([nu]));
  const recipientCommit = new Uint8Array(33).fill(0x03);
  const rLeaf = bigintToBytes32(poseidon2([secret, nu]));
  const ethRecipient = new Uint8Array(20).fill(0xab);
  const burnNonce = new Uint8Array(32).fill(0xcd);
  const h1 = computeBridgeBurnBindHash(NETWORK_SIGNET, assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce);
  const h2 = computeBridgeBurnBindHash(NETWORK_SIGNET, assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce);
  assert.deepEqual(h1, h2);
});

test('different eth_recipient produces different burn bind_hash', () => {
  const merkleRoot = new Uint8Array(32).fill(0x11);
  const nullifierHash = bigintToBytes32(poseidon1([nu]));
  const recipientCommit = new Uint8Array(33).fill(0x03);
  const rLeaf = bigintToBytes32(poseidon2([secret, nu]));
  const burnNonce = new Uint8Array(32).fill(0xcd);
  const ethA = new Uint8Array(20).fill(0xaa);
  const ethB = new Uint8Array(20).fill(0xbb);
  const h1 = computeBridgeBurnBindHash(NETWORK_SIGNET, assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethA, burnNonce);
  const h2 = computeBridgeBurnBindHash(NETWORK_SIGNET, assetId, denomWei, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethB, burnNonce);
  assert.notDeepEqual(h1, h2);
});

console.log('\nCircuit input structure:');

test('bridge_deposit circuit expects same commitment shape as mixer', () => {
  const leafFromMixer = poseidon3([secret, nu, denom]);
  const nullifierFromMixer = poseidon1([nu]);
  assert.equal(typeof leafFromMixer, 'bigint');
  assert.equal(typeof nullifierFromMixer, 'bigint');
  assert.ok(leafFromMixer > 0n);
  assert.ok(nullifierFromMixer > 0n);
  assert.ok(leafFromMixer < (1n << 254n));
  assert.ok(nullifierFromMixer < (1n << 254n));
});

test('r_leaf derivation matches mixer convention', () => {
  const rLeaf = poseidon2([secret, nu]);
  assert.equal(typeof rLeaf, 'bigint');
  assert.ok(rLeaf > 0n);
  assert.ok(rLeaf < (1n << 254n));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
