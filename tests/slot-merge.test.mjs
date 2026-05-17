// SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT §5.25 wire-format round-trip tests for
// T_SLOT_MERGE. Inverse of slot-split.test.mjs: 4 input slots → 1 new slot,
// with conservation Σ denom_old ≥ denom_new and Bitcoin paying its fee from
// the difference.

import {
  T_SLOT_MERGE,
  decodeTSlotMergePayload as workerDecode,
  pedersenCommit,
} from '../worker/src/index.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

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

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

const NET_SIGNET = 0x01;
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
function rLeafFrom(seedStr) {
  const r_be = sha256(new TextEncoder().encode(seedStr));
  const r = ((BigInt('0x' + bytesToHex(r_be))) % SECP_N) || 1n;
  return { r, bytes: numberToBytesBE32(r) };
}
function leafFor(seedStr, denom) {
  const { bytes } = rLeafFrom(seedStr);
  const rBig = (BigInt('0x' + bytesToHex(bytes))) % SECP_N || 1n;
  const commit = pedersenCommit(BigInt(denom), rBig).toRawBytes(true);
  const leafHash = sha256(concatBytes(
    new TextEncoder().encode(seedStr),
    leUint64(denom),
  ));
  return { r_bytes: bytes, recipient_commit: commit, leaf_hash: leafHash };
}

function buildFixture() {
  const assetIdShared = sha256(new TextEncoder().encode('test-merge-asset'));
  // 4 input slots of 250_000 each → output slot of 1_000_000
  // (zero Bitcoin fee in this fixture; real usage would have denom_new
  // slightly less than the sum to fund the merge tx's miner fee).
  const inputs = [];
  for (let i = 0; i < 4; i++) {
    const denomOld = 250_000n;
    const l = leafFor(`test-merge-input-${i}`, denomOld);
    const oldNullifierHash = sha256(new TextEncoder().encode(`test-merge-null-${i}`));
    const oldMerkleRoot = sha256(new TextEncoder().encode(`test-merge-root-${i}`));
    const oldBindHash = dapp.computeWithdrawBindHash(
      assetIdShared, denomOld, oldNullifierHash, l.recipient_commit, l.r_bytes,
    );
    const oldProof = new Uint8Array(192);
    for (let j = 0; j < oldProof.length; j++) oldProof[j] = ((j * 7 + i * 31 + 13) & 0xff);
    inputs.push({
      assetIdOld: assetIdShared,
      denomOld,
      oldMerkleRoot,
      oldNullifierHash,
      oldRecipientCommitment: l.recipient_commit,
      oldRLeaf: l.r_bytes,
      oldBindHash,
      oldProof,
    });
  }

  const denomNew = 1_000_000n;
  const newLeaf = leafFor('test-merge-output', denomNew);

  const ownerPriv = sha256(new TextEncoder().encode('test-merge-owner-priv'));
  const ownerPub = new Uint8Array(33);
  ownerPub[0] = 0x02;
  ownerPub.set(ownerPriv, 1);
  const ownerSig = new Uint8Array(64);
  for (let i = 0; i < 64; i++) ownerSig[i] = (i * 11 + 17) & 0xff;

  return {
    networkTag: NET_SIGNET,
    inputs,
    assetIdNew: assetIdShared,
    denomNew,
    newRecipientCommit: newLeaf.recipient_commit,
    newLeafHash: newLeaf.leaf_hash,
    newOwnerPubkey: ownerPub,
    newOwnerSig: ownerSig,
  };
}

// ============== Group 1: dapp encode → worker decode parity ==============
group('T_SLOT_MERGE encode/decode round-trip');
{
  const fx = buildFixture();
  const payload = dapp.encodeTSlotMergePayload(fx);

  ok('payload starts with opcode 0x47', payload[0] === T_SLOT_MERGE);
  ok('payload network_tag is signet', payload[1] === NET_SIGNET);
  ok('payload n_inputs == 4', payload[2] === 4);

  const dappDecoded = dapp.decodeTSlotMergePayload(payload);
  ok('dapp self-decode produces non-null', dappDecoded !== null);
  if (dappDecoded) {
    ok('dapp: kind === slot_merge', dappDecoded.kind === 'slot_merge');
    ok('dapp: denomNew matches', dappDecoded.denomNew === fx.denomNew);
    ok('dapp: nInputs === 4', dappDecoded.nInputs === 4);
    ok('dapp: assetIdNew bytes match',
      bytesToHex(dappDecoded.assetIdNew) === bytesToHex(fx.assetIdNew));
    const sumOld = dappDecoded.inputs.reduce((a, i) => a + i.denomOld, 0n);
    ok('dapp: Σ denom_old ≥ denom_new (conservation)', sumOld >= fx.denomNew);
  }

  const workerDecoded = workerDecode(payload);
  ok('worker decode produces non-null', workerDecoded !== null);
  if (workerDecoded) {
    ok('worker: kind === slot_merge', workerDecoded.kind === 'slot_merge');
    ok('worker: denom_new matches', workerDecoded.denom_new === fx.denomNew.toString());
    ok('worker: n_inputs === 4', workerDecoded.n_inputs === 4);
    ok('worker: asset_id_new matches',
      workerDecoded.asset_id_new === bytesToHex(fx.assetIdNew));
    ok('worker: inputs length === 4', workerDecoded.inputs.length === 4);
    const sumOld = workerDecoded.inputs.reduce((a, i) => a + BigInt(i.denom_old), 0n);
    ok('worker: Σ denom_old ≥ denom_new', sumOld >= fx.denomNew);
  }
}

// ============== Group 2: dapp ↔ worker field parity ==============
group('dapp ↔ worker field parity');
{
  const fx = buildFixture();
  const payload = dapp.encodeTSlotMergePayload(fx);
  const d = dapp.decodeTSlotMergePayload(payload);
  const w = workerDecode(payload);
  if (d && w) {
    ok('parity: nInputs', d.nInputs === w.n_inputs);
    ok('parity: denomNew', d.denomNew.toString() === w.denom_new);
    ok('parity: assetIdNew', bytesToHex(d.assetIdNew) === w.asset_id_new);
    ok('parity: newLeafHash', bytesToHex(d.newLeafHash) === w.new_leaf_hash);
    ok('parity: input[0].assetIdOld',
      bytesToHex(d.inputs[0].assetIdOld) === w.inputs[0].asset_id_old);
    ok('parity: input[0].oldRLeaf',
      bytesToHex(d.inputs[0].oldRLeaf) === w.inputs[0].old_r_leaf);
    ok('parity: input[0].oldBindHash',
      bytesToHex(d.inputs[0].oldBindHash) === w.inputs[0].old_bind_hash);
    ok('parity: input[3].oldNullifierHash',
      bytesToHex(d.inputs[3].oldNullifierHash) === w.inputs[3].old_nullifier_hash);
    ok('parity: newOwnerPubkey', bytesToHex(d.newOwnerPubkey) === w.new_owner_pubkey);
    ok('parity: newOwnerSig', bytesToHex(d.newOwnerSig) === w.new_owner_sig);
  } else {
    ok('parity: both decoders returned non-null', false,
      'd=' + (d === null ? 'null' : 'ok') + ' w=' + (w === null ? 'null' : 'ok'));
  }
}

// ============== Group 3: computeSlotMergeMsg ==============
group('computeSlotMergeMsg deterministic + binding');
{
  const fx = buildFixture();
  const m1 = dapp.computeSlotMergeMsg(
    NET_SIGNET, fx.inputs, fx.assetIdNew, fx.denomNew, fx.newRecipientCommit, fx.newLeafHash);
  const m2 = dapp.computeSlotMergeMsg(
    NET_SIGNET, fx.inputs, fx.assetIdNew, fx.denomNew, fx.newRecipientCommit, fx.newLeafHash);
  ok('determinism: same inputs → same hash', bytesToHex(m1) === bytesToHex(m2));

  // Tamper an input's nullifier — merge_msg must change (inputs are bound)
  const mutInputs = fx.inputs.map(i => ({ ...i }));
  mutInputs[0] = { ...mutInputs[0], oldNullifierHash: sha256(new TextEncoder().encode('different')) };
  const m3 = dapp.computeSlotMergeMsg(
    NET_SIGNET, mutInputs, fx.assetIdNew, fx.denomNew, fx.newRecipientCommit, fx.newLeafHash);
  ok('binding: mutating input nullifier changes msg', bytesToHex(m1) !== bytesToHex(m3));

  // Tamper the output's denom — must change msg
  const m4 = dapp.computeSlotMergeMsg(
    NET_SIGNET, fx.inputs, fx.assetIdNew, fx.denomNew - 1n, fx.newRecipientCommit, fx.newLeafHash);
  ok('binding: mutating denom_new changes msg', bytesToHex(m1) !== bytesToHex(m4));
}

// ============== Group 4: decoder negative cases ==============
group('Decoder negative cases (security boundaries)');
{
  const fx = buildFixture();
  const valid = dapp.encodeTSlotMergePayload(fx);

  const wrongOpcode = new Uint8Array(valid); wrongOpcode[0] = 0x46;
  ok('wrong opcode → null (dapp)', dapp.decodeTSlotMergePayload(wrongOpcode) === null);
  ok('wrong opcode → null (worker)', workerDecode(wrongOpcode) === null);

  const badNet = new Uint8Array(valid); badNet[1] = 0x05;
  ok('network_tag > 2 → null (dapp)', dapp.decodeTSlotMergePayload(badNet) === null);
  ok('network_tag > 2 → null (worker)', workerDecode(badNet) === null);

  const truncated = valid.slice(0, valid.length - 1);
  ok('truncated → null (dapp)', dapp.decodeTSlotMergePayload(truncated) === null);
  ok('truncated → null (worker)', workerDecode(truncated) === null);

  // Tamper input[0]'s bind_hash: starts after opcode(1) + net(1) + n_inputs(1)
  // + 32(asset) + 8(denom) + 32(merkle) + 32(null) + 33(recipient) + 32(r_leaf) = 171
  // So bind_hash[0] is at offset 1+1+1+32+8+32+32+33+32 = 172.
  const tamperedBind = new Uint8Array(valid);
  tamperedBind[172] ^= 0x01;
  ok('tampered input[0] bind_hash → null (dapp)',
    dapp.decodeTSlotMergePayload(tamperedBind) === null);
  ok('tampered input[0] bind_hash → null (worker)',
    workerDecode(tamperedBind) === null);
}

// ============== Group 5: encoder validation ==============
group('Encoder input validation');
{
  const fx = buildFixture();
  let threw;

  try { threw = false; dapp.encodeTSlotMergePayload({ ...fx, inputs: [fx.inputs[0]] }); }
  catch (e) { threw = String(e.message || e); }
  ok('n=1 inputs rejected (min is 2)', typeof threw === 'string' && threw.includes('2..16'));

  try { threw = false; dapp.encodeTSlotMergePayload({ ...fx, inputs: new Array(17).fill(fx.inputs[0]) }); }
  catch (e) { threw = String(e.message || e); }
  ok('n=17 inputs rejected (max is 16)', typeof threw === 'string' && threw.includes('2..16'));

  try { threw = false; dapp.encodeTSlotMergePayload({ ...fx, networkTag: 5 }); }
  catch (e) { threw = String(e.message || e); }
  ok('network_tag > 2 rejected', typeof threw === 'string' && threw.includes('network_tag'));

  try { threw = false; dapp.encodeTSlotMergePayload({ ...fx, denomNew: 0n }); }
  catch (e) { threw = String(e.message || e); }
  ok('denom_new = 0 rejected', typeof threw === 'string' && threw.includes('denom_new'));
}

// ============== Group 6: conservation enforcement ==============
group('Conservation enforcement (Σ denom_old ≥ denom_new)');
{
  const fx = buildFixture();
  // Construct an envelope where denom_new > Σ denom_old (over-mint).
  // 4 inputs of 250_000 each = 1_000_000; try denom_new = 1_500_000.
  const overMint = dapp.encodeTSlotMergePayload({
    ...fx,
    denomNew: 1_500_000n,
    // Recompute new_recipient_commit at the new denom so the wire format is consistent
    // (decoder doesn't enforce K_btc derivation; the conservation check is what catches it).
    newRecipientCommit: leafFor('test-merge-output-over', 1_500_000n).recipient_commit,
    newLeafHash: leafFor('test-merge-output-over', 1_500_000n).leaf_hash,
  });
  ok('over-mint (Σ denom_old < denom_new) → null (dapp)',
    dapp.decodeTSlotMergePayload(overMint) === null);
  ok('over-mint → null (worker)',
    workerDecode(overMint) === null);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
