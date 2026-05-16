// SPEC-CBTC-ZK-AMENDMENT round-trip tests for T_SLOT_MINT / T_SLOT_BURN / T_SLOT_ROTATE.
//
// Coverage:
//   - Wire format encode/decode round-trip for all three opcodes
//   - K_btc derivation identity: K_btc = recipient_commit − denom·H = r_leaf·G
//   - P2TR scriptpubkey shape matches BIP-341 (OP_1 || OP_PUSHBYTES_32 || x-only)
//   - Bind-hash recompute is byte-deterministic (matches existing mixer §5.11 binding)
//   - Decoder rejects malformed inputs (wrong opcode, bad network tag, bad point, length errors)

import {
  T_SLOT_MINT, T_SLOT_BURN, T_SLOT_ROTATE,
  decodeTSlotMintPayload, decodeTSlotBurnPayload, decodeTSlotRotatePayload,
  deriveSlotKbtc, slotXOnly, slotScriptPubKey,
  pedersenCommit,
} from '../worker/src/index.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ---- Test fixtures ----

const NETWORK_TAG_SIGNET = 0x01;
const ASSET_ID = hexToBytes('1111111111111111111111111111111111111111111111111111111111111111');
const DENOM = 100_000n;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function leUint64(n) {
  const out = new Uint8Array(8);
  const v = new DataView(out.buffer);
  const b = BigInt(n);
  v.setUint32(0, Number(b & 0xffffffffn), true);
  v.setUint32(4, Number((b >> 32n) & 0xffffffffn), true);
  return out;
}

function numberToBytesBE32(n) {
  const out = new Uint8Array(32);
  let b = BigInt(n);
  for (let i = 31; i >= 0; i--) { out[i] = Number(b & 0xffn); b >>= 8n; }
  return out;
}
function synthLeafFor(seedStr) {
  const r_leaf_be = sha256(new TextEncoder().encode(seedStr));
  const r_leaf = ((BigInt('0x' + bytesToHex(r_leaf_be))) % SECP_N) || 1n;
  const commit = pedersenCommit(DENOM, r_leaf);
  return {
    r_leaf,
    r_leaf_bytes: numberToBytesBE32(r_leaf),
    recipient_commit_bytes: commit.toRawBytes(true),
  };
}

// ---- Group 1: Cryptographic identity ----
group('K_btc derivation identity');

// Compare by serializing to bytes — the worker's noble and the test's noble are
// different versions, so cross-class Point.equals() throws "Point expected".
function pointsEqualByBytes(a, b) {
  return bytesToHex(a.toRawBytes(true)) === bytesToHex(b.toRawBytes(true));
}

{
  const { r_leaf, recipient_commit_bytes } = synthLeafFor('test-leaf-1');
  const K_btc = deriveSlotKbtc(recipient_commit_bytes, DENOM.toString());
  const expected = secp.ProjectivePoint.BASE.multiply(r_leaf);
  ok('K_btc = recipient_commit − denom·H equals r_leaf · G',
    pointsEqualByBytes(K_btc, expected));

  const xOnly = slotXOnly(K_btc);
  ok('x-only key is 32 bytes', xOnly.length === 32);
  ok('x-only matches r_leaf·G\'s x-coordinate',
    bytesToHex(xOnly) === bytesToHex(expected.toRawBytes(true).slice(1)));
}

{
  // Test with multiple distinct leaves to make sure derivation is sound across the field
  for (let i = 0; i < 8; i++) {
    const { r_leaf, recipient_commit_bytes } = synthLeafFor(`fuzz-leaf-${i}`);
    const K_btc = deriveSlotKbtc(recipient_commit_bytes, DENOM.toString());
    const expected = secp.ProjectivePoint.BASE.multiply(r_leaf);
    ok(`fuzz round ${i}: K_btc matches r_leaf·G`, pointsEqualByBytes(K_btc, expected));
  }
}

// ---- Group 2: P2TR scriptpubkey shape ----
group('P2TR scriptpubkey format');

{
  const { recipient_commit_bytes } = synthLeafFor('test-leaf-spk');
  const K_btc = deriveSlotKbtc(recipient_commit_bytes, DENOM.toString());
  const spk = slotScriptPubKey(slotXOnly(K_btc));
  ok('scriptpubkey is 34 bytes', spk.length === 34);
  ok('starts with OP_1 (0x51)', spk[0] === 0x51);
  ok('OP_PUSHBYTES_32 (0x20) as length byte', spk[1] === 0x20);
  ok('rest equals x-only key',
    bytesToHex(spk.slice(2)) === bytesToHex(slotXOnly(K_btc)));
  ok('scriptpubkey hex begins with 5120',
    bytesToHex(spk).startsWith('5120'));
}

// ---- Group 3: T_SLOT_MINT wire format ----
group('T_SLOT_MINT decode round-trip');

function buildSlotMintPayload({ networkTag, assetId, denom, recipientCommit, leafHash, paymentAssetId, paymentAmount, minterPubkey, minterSig }) {
  return concatBytes(
    new Uint8Array([T_SLOT_MINT]),
    new Uint8Array([networkTag]),
    assetId,
    leUint64(denom),
    recipientCommit,
    leafHash,
    paymentAssetId,
    leUint64(paymentAmount),
    minterPubkey,
    minterSig,
  );
}

{
  const { recipient_commit_bytes } = synthLeafFor('mint-test-1');
  const leafHash = sha256(new TextEncoder().encode('leaf-hash-1'));
  const paymentAssetId = hexToBytes('2222222222222222222222222222222222222222222222222222222222222222');
  const minterPubkey = secp.ProjectivePoint.BASE.multiply(42n).toRawBytes(true);
  const minterSig = new Uint8Array(64); // placeholder; sig validation is in the cron handler

  const payload = buildSlotMintPayload({
    networkTag: NETWORK_TAG_SIGNET,
    assetId: ASSET_ID,
    denom: DENOM,
    recipientCommit: recipient_commit_bytes,
    leafHash,
    paymentAssetId,
    paymentAmount: 50_000n,
    minterPubkey,
    minterSig,
  });
  ok('payload size is 244 bytes', payload.length === 244);

  const decoded = decodeTSlotMintPayload(payload);
  ok('decode succeeds', decoded !== null);
  ok('kind = slot_mint', decoded?.kind === 'slot_mint');
  ok('network_tag round-trips', decoded?.network_tag === NETWORK_TAG_SIGNET);
  ok('asset_id round-trips', decoded?.asset_id === bytesToHex(ASSET_ID));
  ok('denomination round-trips', decoded?.denomination === DENOM.toString());
  ok('recipient_commit round-trips',
    decoded?.recipient_commitment === bytesToHex(recipient_commit_bytes));
  ok('leaf_hash round-trips', decoded?.leaf_hash === bytesToHex(leafHash));
  ok('payment_asset_id round-trips',
    decoded?.payment_asset_id === bytesToHex(paymentAssetId));
  ok('payment_amount round-trips', decoded?.payment_amount === '50000');
  ok('minter_pubkey round-trips', decoded?.minter_pubkey === bytesToHex(minterPubkey));
  ok('minter_sig round-trips', decoded?.minter_sig === bytesToHex(minterSig));
  ok('_msg() returns 32-byte digest',
    decoded?._msg().length === 32);
}

{
  // Rejection cases
  const { recipient_commit_bytes } = synthLeafFor('mint-reject-1');
  const leafHash = sha256(new TextEncoder().encode('leaf-hash-2'));
  const paymentAssetId = hexToBytes('3333333333333333333333333333333333333333333333333333333333333333');
  const minterPubkey = secp.ProjectivePoint.BASE.multiply(7n).toRawBytes(true);
  const minterSig = new Uint8Array(64);

  // Wrong opcode
  const wrongOp = buildSlotMintPayload({
    networkTag: NETWORK_TAG_SIGNET, assetId: ASSET_ID, denom: DENOM,
    recipientCommit: recipient_commit_bytes, leafHash, paymentAssetId,
    paymentAmount: 1000n, minterPubkey, minterSig,
  });
  wrongOp[0] = 0x99;
  ok('rejects wrong opcode', decodeTSlotMintPayload(wrongOp) === null);

  // Wrong length (truncated)
  const truncated = buildSlotMintPayload({
    networkTag: NETWORK_TAG_SIGNET, assetId: ASSET_ID, denom: DENOM,
    recipientCommit: recipient_commit_bytes, leafHash, paymentAssetId,
    paymentAmount: 1000n, minterPubkey, minterSig,
  }).slice(0, -1);
  ok('rejects truncated payload', decodeTSlotMintPayload(truncated) === null);

  // Wrong length (padded)
  const padded = concatBytes(buildSlotMintPayload({
    networkTag: NETWORK_TAG_SIGNET, assetId: ASSET_ID, denom: DENOM,
    recipientCommit: recipient_commit_bytes, leafHash, paymentAssetId,
    paymentAmount: 1000n, minterPubkey, minterSig,
  }), new Uint8Array([0x00]));
  ok('rejects padded payload', decodeTSlotMintPayload(padded) === null);

  // Invalid network tag
  const badNet = buildSlotMintPayload({
    networkTag: 0xFF, assetId: ASSET_ID, denom: DENOM,
    recipientCommit: recipient_commit_bytes, leafHash, paymentAssetId,
    paymentAmount: 1000n, minterPubkey, minterSig,
  });
  ok('rejects invalid network tag', decodeTSlotMintPayload(badNet) === null);

  // Bad recipient_commit (not a valid point)
  const badCommit = buildSlotMintPayload({
    networkTag: NETWORK_TAG_SIGNET, assetId: ASSET_ID, denom: DENOM,
    recipientCommit: new Uint8Array(33), // all zeros — invalid compressed point
    leafHash, paymentAssetId,
    paymentAmount: 1000n, minterPubkey, minterSig,
  });
  ok('rejects malformed recipient_commit', decodeTSlotMintPayload(badCommit) === null);

  // Zero denomination
  const zeroDenom = buildSlotMintPayload({
    networkTag: NETWORK_TAG_SIGNET, assetId: ASSET_ID, denom: 0n,
    recipientCommit: recipient_commit_bytes, leafHash, paymentAssetId,
    paymentAmount: 1000n, minterPubkey, minterSig,
  });
  ok('rejects denomination = 0', decodeTSlotMintPayload(zeroDenom) === null);
}

// ---- Group 4: T_SLOT_BURN wire format ----
group('T_SLOT_BURN decode round-trip');

function computeWithdrawBindHash(assetIdBytes, denom, nullifierBytes, recipientCommitBytes, rLeafBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-withdraw-bind-v1'),
    assetIdBytes,
    leUint64(denom),
    nullifierBytes,
    recipientCommitBytes,
    rLeafBytes,
  ));
}

function buildSlotBurnPayload({ networkTag, assetId, denom, merkleRoot, nullifierHash, recipientCommit, rLeaf, bindHash, proof }) {
  const proofLenBytes = new Uint8Array(2);
  new DataView(proofLenBytes.buffer).setUint16(0, proof.length, true);
  return concatBytes(
    new Uint8Array([T_SLOT_BURN]),
    new Uint8Array([networkTag]),
    assetId,
    leUint64(denom),
    merkleRoot,
    nullifierHash,
    recipientCommit,
    rLeaf,
    bindHash,
    proofLenBytes,
    proof,
  );
}

{
  const { r_leaf_bytes, recipient_commit_bytes } = synthLeafFor('burn-test-1');
  const merkleRoot = sha256(new TextEncoder().encode('mock-merkle-root'));
  const nullifierHash = sha256(new TextEncoder().encode('mock-nullifier'));
  const bindHash = computeWithdrawBindHash(
    ASSET_ID, DENOM, nullifierHash, recipient_commit_bytes, r_leaf_bytes,
  );
  const proof = new Uint8Array(256); // standard Groth16 size for snarkjs BN254 uncompressed

  const payload = buildSlotBurnPayload({
    networkTag: NETWORK_TAG_SIGNET,
    assetId: ASSET_ID,
    denom: DENOM,
    merkleRoot,
    nullifierHash,
    recipientCommit: recipient_commit_bytes,
    rLeaf: r_leaf_bytes,
    bindHash,
    proof,
  });

  const decoded = decodeTSlotBurnPayload(payload);
  ok('decode succeeds', decoded !== null);
  ok('kind = slot_burn', decoded?.kind === 'slot_burn');
  ok('network_tag round-trips', decoded?.network_tag === NETWORK_TAG_SIGNET);
  ok('asset_id round-trips', decoded?.asset_id === bytesToHex(ASSET_ID));
  ok('denomination round-trips', decoded?.denomination === DENOM.toString());
  ok('merkle_root round-trips', decoded?.merkle_root === bytesToHex(merkleRoot));
  ok('nullifier_hash round-trips', decoded?.nullifier_hash === bytesToHex(nullifierHash));
  ok('recipient_commit round-trips',
    decoded?.recipient_commitment === bytesToHex(recipient_commit_bytes));
  ok('r_leaf round-trips', decoded?.r_leaf === bytesToHex(r_leaf_bytes));
  ok('bind_hash round-trips', decoded?.bind_hash === bytesToHex(bindHash));
  ok('proof round-trips', decoded?.proof === bytesToHex(proof));
}

{
  // bind_hash mismatch must reject (indexer determinism — SPEC §5.11 invariant)
  const { r_leaf_bytes, recipient_commit_bytes } = synthLeafFor('burn-bind-1');
  const nullifierHash = sha256(new TextEncoder().encode('mock-nullifier-2'));
  const wrongBindHash = sha256(new TextEncoder().encode('wrong-bind-hash'));
  const proof = new Uint8Array(256);

  const payload = buildSlotBurnPayload({
    networkTag: NETWORK_TAG_SIGNET,
    assetId: ASSET_ID,
    denom: DENOM,
    merkleRoot: sha256(new TextEncoder().encode('mr')),
    nullifierHash,
    recipientCommit: recipient_commit_bytes,
    rLeaf: r_leaf_bytes,
    bindHash: wrongBindHash,
    proof,
  });
  ok('rejects bind_hash mismatch', decodeTSlotBurnPayload(payload) === null);
}

// ---- Group 5: T_SLOT_ROTATE wire format ----
group('T_SLOT_ROTATE decode round-trip');

function buildSlotRotatePayload({
  networkTag, assetId, denom,
  oldMerkleRoot, oldNullifier, oldRecipientCommit, oldRLeaf, oldBindHash, oldProof,
  newRecipientCommit, newLeafHash,
  paymentAssetId, paymentAmount,
  oldOwnerPubkey, oldOwnerSig,
}) {
  const proofLenBytes = new Uint8Array(2);
  new DataView(proofLenBytes.buffer).setUint16(0, oldProof.length, true);
  return concatBytes(
    new Uint8Array([T_SLOT_ROTATE]),
    new Uint8Array([networkTag]),
    assetId,
    leUint64(denom),
    oldMerkleRoot,
    oldNullifier,
    oldRecipientCommit,
    oldRLeaf,
    oldBindHash,
    proofLenBytes,
    oldProof,
    newRecipientCommit,
    newLeafHash,
    paymentAssetId,
    leUint64(paymentAmount),
    oldOwnerPubkey,
    oldOwnerSig,
  );
}

{
  const oldLeaf = synthLeafFor('rotate-old-1');
  const newLeaf = synthLeafFor('rotate-new-1');
  const oldNullifier = sha256(new TextEncoder().encode('rotate-old-nullifier'));
  const oldBindHash = computeWithdrawBindHash(
    ASSET_ID, DENOM, oldNullifier, oldLeaf.recipient_commit_bytes, oldLeaf.r_leaf_bytes,
  );
  const newLeafHash = sha256(new TextEncoder().encode('rotate-new-leaf'));
  const paymentAssetId = hexToBytes('4444444444444444444444444444444444444444444444444444444444444444');
  const oldOwnerPubkey = secp.ProjectivePoint.BASE.multiply(11n).toRawBytes(true);
  const oldOwnerSig = new Uint8Array(64);
  const oldProof = new Uint8Array(256);

  const payload = buildSlotRotatePayload({
    networkTag: NETWORK_TAG_SIGNET, assetId: ASSET_ID, denom: DENOM,
    oldMerkleRoot: sha256(new TextEncoder().encode('old-mr')),
    oldNullifier, oldRecipientCommit: oldLeaf.recipient_commit_bytes,
    oldRLeaf: oldLeaf.r_leaf_bytes, oldBindHash, oldProof,
    newRecipientCommit: newLeaf.recipient_commit_bytes,
    newLeafHash,
    paymentAssetId, paymentAmount: 25_000n,
    oldOwnerPubkey, oldOwnerSig,
  });

  const decoded = decodeTSlotRotatePayload(payload);
  ok('decode succeeds (with payment)', decoded !== null);
  ok('kind = slot_rotate', decoded?.kind === 'slot_rotate');
  ok('old_nullifier round-trips', decoded?.old_nullifier_hash === bytesToHex(oldNullifier));
  ok('old_recipient_commit round-trips',
    decoded?.old_recipient_commitment === bytesToHex(oldLeaf.recipient_commit_bytes));
  ok('new_recipient_commit round-trips',
    decoded?.new_recipient_commitment === bytesToHex(newLeaf.recipient_commit_bytes));
  ok('new_leaf_hash round-trips', decoded?.new_leaf_hash === bytesToHex(newLeafHash));
  ok('payment_amount round-trips', decoded?.payment_amount === '25000');
  ok('old_owner_pubkey round-trips',
    decoded?.old_owner_pubkey === bytesToHex(oldOwnerPubkey));
  ok('_msg() returns 32-byte digest', decoded?._msg().length === 32);
}

{
  // No-payment rotation (self-rekey use case)
  const oldLeaf = synthLeafFor('rotate-self-old');
  const newLeaf = synthLeafFor('rotate-self-new');
  const oldNullifier = sha256(new TextEncoder().encode('self-rotate-null'));
  const oldBindHash = computeWithdrawBindHash(
    ASSET_ID, DENOM, oldNullifier, oldLeaf.recipient_commit_bytes, oldLeaf.r_leaf_bytes,
  );

  const payload = buildSlotRotatePayload({
    networkTag: NETWORK_TAG_SIGNET, assetId: ASSET_ID, denom: DENOM,
    oldMerkleRoot: sha256(new TextEncoder().encode('mr-self')),
    oldNullifier, oldRecipientCommit: oldLeaf.recipient_commit_bytes,
    oldRLeaf: oldLeaf.r_leaf_bytes, oldBindHash, oldProof: new Uint8Array(256),
    newRecipientCommit: newLeaf.recipient_commit_bytes,
    newLeafHash: sha256(new TextEncoder().encode('self-new-leaf')),
    paymentAssetId: new Uint8Array(32), // all zeros = no payment
    paymentAmount: 0n,
    oldOwnerPubkey: secp.ProjectivePoint.BASE.toRawBytes(true),
    oldOwnerSig: new Uint8Array(64),
  });

  const decoded = decodeTSlotRotatePayload(payload);
  ok('decode succeeds (no payment / self-rekey)', decoded !== null);
  ok('payment_amount = 0', decoded?.payment_amount === '0');
  ok('payment_asset_id is all-zeros',
    decoded?.payment_asset_id === '0'.repeat(64));
}

// ---- Group 6: Dapp ↔ worker parity ----
// Critical: dapp encoders must produce bytes that worker decoders accept.
// JSDOM shim mirrors what dapp-parity.test.mjs does.
group('Dapp ↔ worker parity (round-trip via JSDOM-loaded dapp)');

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
const dapp = await import('../dapp/tacit.js');

{
  // T_SLOT_MINT parity: dapp encodes, worker decodes — every field round-trips.
  const { recipient_commit_bytes } = synthLeafFor('parity-mint-1');
  const leafHash = sha256(new TextEncoder().encode('parity-leaf'));
  const paymentAssetId = hexToBytes('5555555555555555555555555555555555555555555555555555555555555555');
  const minterPubkey = secp.ProjectivePoint.BASE.multiply(99n).toRawBytes(true);
  const minterSig = new Uint8Array(64).fill(0xab);

  const dappEncoded = dapp.encodeTSlotMintPayload({
    networkTag: NETWORK_TAG_SIGNET,
    assetId: ASSET_ID,
    denomination: DENOM,
    recipientCommit: recipient_commit_bytes,
    leafHash,
    paymentAssetId,
    paymentAmount: 75_000n,
    minterPubkey,
    minterSig,
  });
  ok('dapp encode produces 244-byte payload', dappEncoded.length === 244);
  ok('dapp encode starts with T_SLOT_MINT opcode', dappEncoded[0] === T_SLOT_MINT);

  const workerDecoded = decodeTSlotMintPayload(dappEncoded);
  ok('worker decodes dapp output', workerDecoded !== null);
  ok('parity: asset_id', workerDecoded?.asset_id === bytesToHex(ASSET_ID));
  ok('parity: denomination', workerDecoded?.denomination === DENOM.toString());
  ok('parity: recipient_commit',
    workerDecoded?.recipient_commitment === bytesToHex(recipient_commit_bytes));
  ok('parity: leaf_hash', workerDecoded?.leaf_hash === bytesToHex(leafHash));
  ok('parity: payment_amount', workerDecoded?.payment_amount === '75000');

  // Sig-message binding must be byte-identical across dapp and worker.
  const dappMsg = dapp.computeSlotMintMsg(
    NETWORK_TAG_SIGNET, ASSET_ID, DENOM, recipient_commit_bytes,
    leafHash, paymentAssetId, 75_000n,
  );
  const workerMsg = workerDecoded?._msg();
  ok('parity: slot_mint_msg byte-identical',
    workerMsg && bytesToHex(dappMsg) === bytesToHex(workerMsg));
}

{
  // T_SLOT_BURN parity
  const { r_leaf_bytes, recipient_commit_bytes } = synthLeafFor('parity-burn-1');
  const merkleRoot = sha256(new TextEncoder().encode('parity-mr'));
  const nullifierHash = sha256(new TextEncoder().encode('parity-null'));
  const bindHash = computeWithdrawBindHash(
    ASSET_ID, DENOM, nullifierHash, recipient_commit_bytes, r_leaf_bytes,
  );
  const proof = new Uint8Array(256).fill(0xcd);

  const dappEncoded = dapp.encodeTSlotBurnPayload({
    networkTag: NETWORK_TAG_SIGNET,
    assetId: ASSET_ID,
    denomination: DENOM,
    merkleRoot,
    nullifierHash,
    recipientCommitment: recipient_commit_bytes,
    rLeaf: r_leaf_bytes,
    bindHash,
    proof,
  });
  ok('dapp T_SLOT_BURN starts with opcode 0x44', dappEncoded[0] === T_SLOT_BURN);

  const workerDecoded = decodeTSlotBurnPayload(dappEncoded);
  ok('worker decodes dapp T_SLOT_BURN', workerDecoded !== null);
  ok('parity (burn): nullifier_hash',
    workerDecoded?.nullifier_hash === bytesToHex(nullifierHash));
  ok('parity (burn): r_leaf', workerDecoded?.r_leaf === bytesToHex(r_leaf_bytes));
  ok('parity (burn): bind_hash', workerDecoded?.bind_hash === bytesToHex(bindHash));
  ok('parity (burn): proof', workerDecoded?.proof === bytesToHex(proof));
}

{
  // K_btc derivation parity: dapp and worker must produce identical P2TR scriptpubkey
  const { r_leaf, recipient_commit_bytes } = synthLeafFor('parity-kbtc-1');
  const dappKbtc = dapp.deriveSlotKbtc(recipient_commit_bytes, DENOM.toString());
  const workerKbtc = deriveSlotKbtc(recipient_commit_bytes, DENOM.toString());
  ok('K_btc bytes identical across dapp + worker',
    bytesToHex(dappKbtc.toRawBytes(true)) === bytesToHex(workerKbtc.toRawBytes(true)));
  const dappSpk = dapp.slotScriptPubKeyFromKbtc(dappKbtc);
  const workerSpk = slotScriptPubKey(slotXOnly(workerKbtc));
  ok('P2TR scriptpubkey identical across dapp + worker',
    bytesToHex(dappSpk) === bytesToHex(workerSpk));
  ok('scriptpubkey hex shape is "5120" + 32 bytes',
    bytesToHex(dappSpk).startsWith('5120') && dappSpk.length === 34);
}

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
