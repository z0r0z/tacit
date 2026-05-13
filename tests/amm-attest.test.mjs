// T_AMM_ATTEST + preconfirmation layer correctness suite.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  OpenIntentSMT, verifySMTProof, SMT_DEPTH, EMPTY_LEAF,
  encodeAttest, decodeAttest, verifyAttestSig, signAttestation,
  buildPinningBlob,
  validateAmmAttest, newIndexerAttestState,
  verifySoftConfirm,
  OPCODE_T_AMM_ATTEST,
} from './amm-attest.mjs';
import { canonicalize } from './amm-jcs.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- Sparse Merkle Tree ----

console.log('Sparse Merkle Tree (open-intent set)');

test('empty tree root equals canonical empty subtree at depth 0', () => {
  const t = new OpenIntentSMT();
  const root = t.getRoot();
  let expected = EMPTY_LEAF;
  for (let d = SMT_DEPTH - 1; d >= 0; d--) expected = sha256(concatBytes(expected, expected));
  return eq(root, expected);
});

test('insert single leaf changes root', () => {
  const t = new OpenIntentSMT();
  const r0 = t.getRoot();
  const id = sha256(new TextEncoder().encode('intent1'));
  const h = sha256(new TextEncoder().encode('hash1'));
  t.insert(id, h);
  const r1 = t.getRoot();
  return !eq(r0, r1);
});

test('inclusion proof verifies for inserted leaf', () => {
  const t = new OpenIntentSMT();
  const id = sha256(new TextEncoder().encode('intent2'));
  const h = sha256(new TextEncoder().encode('hash2'));
  t.insert(id, h);
  const root = t.getRoot();
  const proof = t.getProof(id);
  return verifySMTProof({ intentId: id, intentMsgHash: h, proof, root });
});

test('inclusion proof fails for wrong msg hash', () => {
  const t = new OpenIntentSMT();
  const id = sha256(new TextEncoder().encode('intent3'));
  const h = sha256(new TextEncoder().encode('hash3'));
  t.insert(id, h);
  const root = t.getRoot();
  const proof = t.getProof(id);
  const wrongH = sha256(new TextEncoder().encode('wrong'));
  return !verifySMTProof({ intentId: id, intentMsgHash: wrongH, proof, root });
});

test('inclusion proof fails for wrong root', () => {
  const t = new OpenIntentSMT();
  const id = sha256(new TextEncoder().encode('intent4'));
  const h = sha256(new TextEncoder().encode('hash4'));
  t.insert(id, h);
  const proof = t.getProof(id);
  const wrongRoot = new Uint8Array(32).fill(0xaa);
  return !verifySMTProof({ intentId: id, intentMsgHash: h, proof, root: wrongRoot });
});

test('many inserts → each has valid proof against final root', () => {
  const t = new OpenIntentSMT();
  const entries = [];
  for (let i = 0; i < 10; i++) {
    const id = sha256(new TextEncoder().encode(`many-${i}`));
    const h = sha256(new TextEncoder().encode(`hash-${i}`));
    t.insert(id, h);
    entries.push({ id, h });
  }
  const root = t.getRoot();
  for (const { id, h } of entries) {
    const proof = t.getProof(id);
    if (!verifySMTProof({ intentId: id, intentMsgHash: h, proof, root })) return false;
  }
  return true;
});

test('remove (cancel) restores tree size and changes root', () => {
  const t = new OpenIntentSMT();
  const id = sha256(new TextEncoder().encode('removable'));
  const h = sha256(new TextEncoder().encode('rh'));
  const r0 = t.getRoot();
  t.insert(id, h);
  const r1 = t.getRoot();
  t.remove(id);
  const r2 = t.getRoot();
  return !eq(r0, r1) && eq(r0, r2) && !t.has(id) && t.size === 0;
});

test('has() reports presence correctly', () => {
  const t = new OpenIntentSMT();
  const id = sha256(new TextEncoder().encode('has'));
  const other = sha256(new TextEncoder().encode('other'));
  t.insert(id, sha256(new TextEncoder().encode('hh')));
  return t.has(id) && !t.has(other);
});

test('insert with non-bytes intentId throws', () => {
  const t = new OpenIntentSMT();
  try { t.insert(new Uint8Array(31), sha256(new TextEncoder().encode('x'))); return false; }
  catch (e) { return /32 bytes/.test(e.message); }
});

// ---- T_AMM_ATTEST envelope codec ----

console.log('\nT_AMM_ATTEST envelope codec');

// Generate a deterministic worker keypair.
const workerSk = new Uint8Array(32);
for (let i = 0; i < 32; i++) workerSk[i] = (i + 1) ^ 0x77;
const workerPk = secp.ProjectivePoint.fromPrivateKey(workerSk).toRawBytes(true);

const samplePoolId = sha256(new TextEncoder().encode('pool-attest-sample'));
const sampleRoot   = sha256(new TextEncoder().encode('root-1'));

test('encode → decode round-trip', () => {
  const enc = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 850123, timestamp: 1_700_000_000n, intentCount: 5,
    ipfsCid: 'bafybeigsamplecid', workerPrivkey: workerSk,
  });
  const dec = decodeAttest(enc);
  return eq(dec.poolId, samplePoolId)
    && eq(dec.root, sampleRoot)
    && dec.height === 850123
    && dec.timestamp === 1_700_000_000n
    && dec.intentCount === 5
    && dec.ipfsCid === 'bafybeigsamplecid'
    && eq(dec.workerPubkey, workerPk);
});

test('opcode byte is 0x30', () => {
  const enc = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 1, timestamp: 1n, intentCount: 0,
    ipfsCid: 'cid', workerPrivkey: workerSk,
  });
  return enc[0] === OPCODE_T_AMM_ATTEST;
});

test('worker_sig verifies honestly', () => {
  const enc = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 850123, timestamp: 1_700_000_000n, intentCount: 5,
    ipfsCid: 'bafybeigsamplecid', workerPrivkey: workerSk,
  });
  const dec = decodeAttest(enc);
  return verifyAttestSig(dec);
});

test('mutated root ⇒ sig fails', () => {
  const enc = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 850123, timestamp: 1_700_000_000n, intentCount: 5,
    ipfsCid: 'bafybeigsamplecid', workerPrivkey: workerSk,
  });
  const bad = new Uint8Array(enc);
  bad[1 + 32 + 5] ^= 0x01;  // flip a byte in root
  const dec = decodeAttest(bad);
  return !verifyAttestSig(dec);
});

test('mutated height ⇒ sig fails', () => {
  const enc = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 850123, timestamp: 1_700_000_000n, intentCount: 5,
    ipfsCid: 'bafybeigsamplecid', workerPrivkey: workerSk,
  });
  const bad = new Uint8Array(enc);
  bad[1 + 32 + 32] ^= 0x01;  // height byte
  const dec = decodeAttest(bad);
  return !verifyAttestSig(dec);
});

test('rejects too-long ipfs_cid', () => {
  try {
    encodeAttest({
      poolId: samplePoolId, root: sampleRoot,
      height: 1, timestamp: 1n, intentCount: 0,
      ipfsCid: 'x'.repeat(65), workerPrivkey: workerSk,
    });
    return false;
  } catch (e) { return /ipfsCid length/.test(e.message); }
});

test('rejects empty ipfs_cid', () => {
  try {
    encodeAttest({
      poolId: samplePoolId, root: sampleRoot,
      height: 1, timestamp: 1n, intentCount: 0,
      ipfsCid: '', workerPrivkey: workerSk,
    });
    return false;
  } catch (e) { return /ipfsCid length/.test(e.message); }
});

test('decode rejects truncated payload', () => {
  const enc = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 1, timestamp: 1n, intentCount: 0,
    ipfsCid: 'cid', workerPrivkey: workerSk,
  });
  try { decodeAttest(enc.slice(0, enc.length - 5)); return false; }
  catch (e) { return /truncated/.test(e.message); }
});

test('decode rejects wrong opcode', () => {
  const enc = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 1, timestamp: 1n, intentCount: 0,
    ipfsCid: 'cid', workerPrivkey: workerSk,
  });
  enc[0] = 0xff;
  try { decodeAttest(enc); return false; }
  catch (e) { return /expected opcode/.test(e.message); }
});

// ---- IPFS pinning blob ----

console.log('\nIPFS pinning blob (JCS-canonical)');

test('buildPinningBlob produces canonical bytes', () => {
  const t = new OpenIntentSMT();
  const id1 = sha256(new TextEncoder().encode('p1'));
  const id2 = sha256(new TextEncoder().encode('p2'));
  const h1 = sha256(new TextEncoder().encode('h1'));
  const h2 = sha256(new TextEncoder().encode('h2'));
  t.insert(id1, h1);
  t.insert(id2, h2);
  const blob = buildPinningBlob({
    poolId: samplePoolId, root: t.getRoot(),
    height: 850000, timestamp: 1_700_000_000,
    intentMap: new Map([
      [bytesToHex(id1), bytesToHex(h1)],
      [bytesToHex(id2), bytesToHex(h2)],
    ]),
  });
  // Round-trip: parse + re-canonicalize → bytes match.
  const parsed = JSON.parse(new TextDecoder().decode(blob));
  const recanonical = canonicalize(parsed);
  return blob.length === recanonical.length
    && [...blob].every((b, i) => b === recanonical[i]);
});

// ---- Indexer validation ----

console.log('\nIndexer validation: validateAmmAttest');

test('honest attestation accepted', () => {
  const state = newIndexerAttestState();
  const payload = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cid', workerPrivkey: workerSk,
  });
  const r = validateAmmAttest({ payload, envelopeHeight: 101, indexerState: state });
  return r.valid && state.attestationChain.size === 1;
});

test('claimed height > envelope height rejected (future-state claim)', () => {
  const state = newIndexerAttestState();
  const payload = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 200, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cid', workerPrivkey: workerSk,
  });
  const r = validateAmmAttest({ payload, envelopeHeight: 100, indexerState: state });
  return !r.valid && /claimed height/.test(r.reason);
});

test('duplicate identical attestation accepted idempotently', () => {
  const state = newIndexerAttestState();
  const payload = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cid', workerPrivkey: workerSk,
  });
  validateAmmAttest({ payload, envelopeHeight: 100, indexerState: state });
  const r = validateAmmAttest({ payload, envelopeHeight: 100, indexerState: state });
  return r.valid && r.idempotent;
});

test('EQUIVOCATION: same worker, pool, height — different roots ⇒ flagged', () => {
  const state = newIndexerAttestState();
  const rootA = sha256(new TextEncoder().encode('rootA'));
  const rootB = sha256(new TextEncoder().encode('rootB'));
  const pA = encodeAttest({
    poolId: samplePoolId, root: rootA,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cidA', workerPrivkey: workerSk,
  });
  const pB = encodeAttest({
    poolId: samplePoolId, root: rootB,
    height: 100, timestamp: 1_700_000_001n, intentCount: 0,
    ipfsCid: 'cidB', workerPrivkey: workerSk,
  });
  validateAmmAttest({ payload: pA, envelopeHeight: 101, indexerState: state });
  const r = validateAmmAttest({ payload: pB, envelopeHeight: 101, indexerState: state });
  return !r.valid && r.equivocation === true
    && state.equivocationFlags.has(bytesToHex(workerPk));
});

test('different pool, same worker, same height ⇒ both valid (no equivocation)', () => {
  const state = newIndexerAttestState();
  const otherPoolId = sha256(new TextEncoder().encode('otherPool'));
  const pA = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cidA', workerPrivkey: workerSk,
  });
  const pB = encodeAttest({
    poolId: otherPoolId, root: sampleRoot,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cidB', workerPrivkey: workerSk,
  });
  const rA = validateAmmAttest({ payload: pA, envelopeHeight: 101, indexerState: state });
  const rB = validateAmmAttest({ payload: pB, envelopeHeight: 101, indexerState: state });
  return rA.valid && rB.valid && state.attestationChain.size === 2 && state.equivocationFlags.size === 0;
});

test('MULTI-WORKER: different workers, same pool & height ⇒ both valid (no equivocation)', () => {
  const state = newIndexerAttestState();
  const otherSk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) otherSk[i] = (i + 1) ^ 0x33;
  const otherRoot = sha256(new TextEncoder().encode('otherRoot'));
  const pA = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cidA', workerPrivkey: workerSk,
  });
  const pB = encodeAttest({
    poolId: samplePoolId, root: otherRoot,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cidB', workerPrivkey: otherSk,
  });
  const rA = validateAmmAttest({ payload: pA, envelopeHeight: 101, indexerState: state });
  const rB = validateAmmAttest({ payload: pB, envelopeHeight: 101, indexerState: state });
  return rA.valid && rB.valid && state.attestationChain.size === 2 && state.equivocationFlags.size === 0;
});

test('forged signature rejected', () => {
  const state = newIndexerAttestState();
  const payload = encodeAttest({
    poolId: samplePoolId, root: sampleRoot,
    height: 100, timestamp: 1_700_000_000n, intentCount: 0,
    ipfsCid: 'cid', workerPrivkey: workerSk,
  });
  // Corrupt the signature.
  payload[payload.length - 5] ^= 0x01;
  const r = validateAmmAttest({ payload, envelopeHeight: 101, indexerState: state });
  return !r.valid && /worker_sig/.test(r.reason);
});

// ---- Soft-confirm verification (trader side) ----

console.log('\nSoft-confirm verification (trader side)');

function buildSoftConfirmBundle({ poolId, height, timestamp, workerSk, intents }) {
  const t = new OpenIntentSMT();
  for (const { id, msgHash } of intents) t.insert(id, msgHash);
  const root = t.getRoot();
  const wpk = secp.ProjectivePoint.fromPrivateKey(workerSk).toRawBytes(true);
  const ipfsCid = 'bafybeisoftconfirm';
  const intentCount = intents.length;
  const sig = signAttestation({
    poolId, root, height, timestamp, intentCount, ipfsCid, workerPrivkey: workerSk,
  });
  return { tree: t, root, ipfsCid, intentCount, workerPubkey: wpk, workerSig: sig };
}

test('honest soft-confirm bundle verifies as soft_confirmed', () => {
  const id1 = sha256(new TextEncoder().encode('s1'));
  const h1 = sha256(new TextEncoder().encode('sh1'));
  const id2 = sha256(new TextEncoder().encode('s2'));
  const h2 = sha256(new TextEncoder().encode('sh2'));
  const ts = Math.floor(Date.now() / 1000);
  const bundle = buildSoftConfirmBundle({
    poolId: samplePoolId, height: 100, timestamp: BigInt(ts),
    workerSk, intents: [{ id: id1, msgHash: h1 }, { id: id2, msgHash: h2 }],
  });
  const proof = bundle.tree.getProof(id1);
  const r = verifySoftConfirm({
    intentId: id1, intentMsgHash: h1, merkleProof: proof,
    poolId: samplePoolId, root: bundle.root, height: 100,
    timestamp: ts, intentCount: bundle.intentCount, ipfsCid: bundle.ipfsCid,
    workerPubkey: bundle.workerPubkey, workerSig: bundle.workerSig,
    trustedWorkers: new Set([bytesToHex(bundle.workerPubkey)]),
    equivocators: new Set(),
    ttlSeconds: 300,
  });
  return r.ok && r.status === 'soft_confirmed';
});

test('stale timestamp ⇒ status=stale', () => {
  const id = sha256(new TextEncoder().encode('stale'));
  const h = sha256(new TextEncoder().encode('staleH'));
  const oldTs = Math.floor(Date.now() / 1000) - 3600;        // 1 hour ago
  const bundle = buildSoftConfirmBundle({
    poolId: samplePoolId, height: 100, timestamp: BigInt(oldTs),
    workerSk, intents: [{ id, msgHash: h }],
  });
  const proof = bundle.tree.getProof(id);
  const r = verifySoftConfirm({
    intentId: id, intentMsgHash: h, merkleProof: proof,
    poolId: samplePoolId, root: bundle.root, height: 100,
    timestamp: oldTs, intentCount: 1, ipfsCid: bundle.ipfsCid,
    workerPubkey: bundle.workerPubkey, workerSig: bundle.workerSig,
    trustedWorkers: new Set([bytesToHex(bundle.workerPubkey)]),
    equivocators: new Set(),
    ttlSeconds: 300,
  });
  return !r.ok && r.status === 'stale';
});

test('forged sig ⇒ status=forged', () => {
  const id = sha256(new TextEncoder().encode('forged'));
  const h = sha256(new TextEncoder().encode('forgedH'));
  const ts = Math.floor(Date.now() / 1000);
  const bundle = buildSoftConfirmBundle({
    poolId: samplePoolId, height: 100, timestamp: BigInt(ts),
    workerSk, intents: [{ id, msgHash: h }],
  });
  const proof = bundle.tree.getProof(id);
  // Corrupt the sig.
  const badSig = new Uint8Array(bundle.workerSig); badSig[0] ^= 0xff;
  const r = verifySoftConfirm({
    intentId: id, intentMsgHash: h, merkleProof: proof,
    poolId: samplePoolId, root: bundle.root, height: 100,
    timestamp: ts, intentCount: 1, ipfsCid: bundle.ipfsCid,
    workerPubkey: bundle.workerPubkey, workerSig: badSig,
    trustedWorkers: new Set([bytesToHex(bundle.workerPubkey)]),
    equivocators: new Set(),
    ttlSeconds: 300,
  });
  return !r.ok && r.status === 'forged';
});

test('untrusted worker ⇒ status=untrusted_worker', () => {
  const id = sha256(new TextEncoder().encode('untrust'));
  const h = sha256(new TextEncoder().encode('untrustH'));
  const ts = Math.floor(Date.now() / 1000);
  const bundle = buildSoftConfirmBundle({
    poolId: samplePoolId, height: 100, timestamp: BigInt(ts),
    workerSk, intents: [{ id, msgHash: h }],
  });
  const proof = bundle.tree.getProof(id);
  const r = verifySoftConfirm({
    intentId: id, intentMsgHash: h, merkleProof: proof,
    poolId: samplePoolId, root: bundle.root, height: 100,
    timestamp: ts, intentCount: 1, ipfsCid: bundle.ipfsCid,
    workerPubkey: bundle.workerPubkey, workerSig: bundle.workerSig,
    trustedWorkers: new Set(),                                // empty: no trusted
    equivocators: new Set(),
    ttlSeconds: 300,
  });
  return !r.ok && r.status === 'untrusted_worker';
});

test('equivocator-flagged worker ⇒ status=equivocator', () => {
  const id = sha256(new TextEncoder().encode('equiv'));
  const h = sha256(new TextEncoder().encode('equivH'));
  const ts = Math.floor(Date.now() / 1000);
  const bundle = buildSoftConfirmBundle({
    poolId: samplePoolId, height: 100, timestamp: BigInt(ts),
    workerSk, intents: [{ id, msgHash: h }],
  });
  const proof = bundle.tree.getProof(id);
  const r = verifySoftConfirm({
    intentId: id, intentMsgHash: h, merkleProof: proof,
    poolId: samplePoolId, root: bundle.root, height: 100,
    timestamp: ts, intentCount: 1, ipfsCid: bundle.ipfsCid,
    workerPubkey: bundle.workerPubkey, workerSig: bundle.workerSig,
    trustedWorkers: new Set([bytesToHex(bundle.workerPubkey)]),
    equivocators: new Set([bytesToHex(bundle.workerPubkey)]),
    ttlSeconds: 300,
  });
  return !r.ok && r.status === 'equivocator';
});

test('Merkle proof of an intent NOT in the tree ⇒ status=forged', () => {
  const id = sha256(new TextEncoder().encode('absent'));
  const h = sha256(new TextEncoder().encode('absentH'));
  const otherId = sha256(new TextEncoder().encode('other'));
  const otherH = sha256(new TextEncoder().encode('otherH'));
  const ts = Math.floor(Date.now() / 1000);
  const bundle = buildSoftConfirmBundle({
    poolId: samplePoolId, height: 100, timestamp: BigInt(ts),
    workerSk, intents: [{ id: otherId, msgHash: otherH }],  // tree contains OTHER intent
  });
  // Build a proof for `id` (which isn't in the tree) — but the leaf hash
  // would be EMPTY_LEAF or wrong. Verifier sees mismatch.
  const proof = bundle.tree.getProof(id);                    // proof against current root
  const r = verifySoftConfirm({
    intentId: id, intentMsgHash: h, merkleProof: proof,
    poolId: samplePoolId, root: bundle.root, height: 100,
    timestamp: ts, intentCount: 1, ipfsCid: bundle.ipfsCid,
    workerPubkey: bundle.workerPubkey, workerSig: bundle.workerSig,
    trustedWorkers: new Set([bytesToHex(bundle.workerPubkey)]),
    equivocators: new Set(),
    ttlSeconds: 300,
  });
  return !r.ok && r.status === 'forged';
});

console.log(`\n${pass}/${pass + fail} preconf tests passed`);
if (fail > 0) process.exit(1);
