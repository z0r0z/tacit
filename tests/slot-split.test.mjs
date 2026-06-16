// SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT §5.24 wire-format round-trip tests for
// T_SLOT_SPLIT. Mirrors slot-wrapper.test.mjs pattern: synthesize fixtures
// from deterministic seeds via pedersenCommit, validate dapp↔worker parity,
// exercise decoder boundary cases.

import {
  T_SLOT_SPLIT,
  decodeTSlotSplitPayload as workerDecode,
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
  const { r, bytes } = rLeafFrom(seedStr);
  const commit = pedersenCommit(BigInt(denom), r).toRawBytes(true);
  // For the wire test we just need a 32-byte leaf-hash placeholder; the spec
  // defines new_leaf_hash = Poseidon₃(secret, ν, denom) but the wire decoder
  // treats it as opaque 32 bytes. Use SHA256(seed||denom) deterministic.
  const leafHash = sha256(concatBytes(
    new TextEncoder().encode(seedStr),
    leUint64(denom),
  ));
  return { r_bytes: bytes, recipient_commit: commit, leaf_hash: leafHash };
}

function buildFixture() {
  const denomOld = 1_000_000n;
  const assetIdOld = sha256(new TextEncoder().encode('test-asset-id-old'));
  const old = leafFor('test-slot-split-old', denomOld);
  const oldNullifierHash = sha256(new TextEncoder().encode('test-null-old'));

  // Use the dapp's computeWithdrawBindHash so the decoder's bind-hash recompute
  // matches.
  const oldBindHash = dapp.computeWithdrawBindHash(
    assetIdOld, denomOld, oldNullifierHash, old.recipient_commit, old.r_bytes,
  );
  const oldMerkleRoot = sha256(new TextEncoder().encode('test-merkle-root'));
  const oldProof = new Uint8Array(192);
  for (let i = 0; i < oldProof.length; i++) oldProof[i] = (i * 7 + 13) & 0xff;

  // 4 new slots, denom 250_000 each (sum = denom_old). §5.24.6: each output
  // wrapper MUST be the canonical self-custody variant for its OWN denom — so a
  // 250k-denom output carries ctacVariantAssetId(250_000), not the 1M input's
  // id. (Re-tiering within the BTC variant family is exactly what SPLIT is for.)
  const outputs = [];
  for (let i = 0; i < 4; i++) {
    const denomNew = 250_000n;
    const l = leafFor(`test-slot-split-new-${i}`, denomNew);
    outputs.push({
      assetIdNew: hexToBytes(dapp.ctacVariantAssetId(denomNew)),
      denomNew,
      newRecipientCommit: l.recipient_commit,
      newLeafHash: l.leaf_hash,
    });
  }

  // Deterministic 33-byte pubkey + 64-byte sig (decoder treats both as opaque).
  const ownerPriv = sha256(new TextEncoder().encode('test-owner-priv'));
  const ownerPub = new Uint8Array(33);
  ownerPub[0] = 0x02;
  ownerPub.set(ownerPriv, 1);
  const ownerSig = new Uint8Array(64);
  for (let i = 0; i < 64; i++) ownerSig[i] = (i * 11 + 7) & 0xff;

  return {
    networkTag: NET_SIGNET,
    assetIdOld,
    denomOld,
    oldMerkleRoot,
    oldNullifierHash,
    oldRecipientCommitment: old.recipient_commit,
    oldRLeaf: old.r_bytes,
    oldBindHash,
    oldProof,
    outputs,
    oldOwnerPubkey: ownerPub,
    oldOwnerSig: ownerSig,
  };
}

// ============== Group 1: dapp encode → worker decode parity ==============
group('T_SLOT_SPLIT encode/decode round-trip');
{
  const fx = buildFixture();
  const payload = dapp.encodeTSlotSplitPayload(fx);

  ok('payload starts with opcode 0x46', payload[0] === T_SLOT_SPLIT);
  ok('payload network_tag is signet', payload[1] === NET_SIGNET);

  const dappDecoded = dapp.decodeTSlotSplitPayload(payload);
  ok('dapp self-decode produces non-null', dappDecoded !== null);
  if (dappDecoded) {
    ok('dapp: kind === slot_split', dappDecoded.kind === 'slot_split');
    ok('dapp: denomOld matches', dappDecoded.denomOld === fx.denomOld);
    ok('dapp: nOutputs === 4', dappDecoded.nOutputs === 4);
    ok('dapp: assetIdOld bytes match',
      bytesToHex(dappDecoded.assetIdOld) === bytesToHex(fx.assetIdOld));
    ok('dapp: oldNullifierHash matches',
      bytesToHex(dappDecoded.oldNullifierHash) === bytesToHex(fx.oldNullifierHash));
    const sumNew = dappDecoded.outputs.reduce((a, o) => a + o.denomNew, 0n);
    ok('dapp: Σ denom_new === denom_old (conservation)', sumNew === fx.denomOld);
  }

  const workerDecoded = workerDecode(payload);
  ok('worker decode produces non-null', workerDecoded !== null);
  if (workerDecoded) {
    ok('worker: kind === slot_split', workerDecoded.kind === 'slot_split');
    ok('worker: denom_old matches', workerDecoded.denom_old === fx.denomOld.toString());
    ok('worker: n_outputs === 4', workerDecoded.n_outputs === 4);
    ok('worker: asset_id_old matches',
      workerDecoded.asset_id_old === bytesToHex(fx.assetIdOld));
    ok('worker: outputs length === 4', workerDecoded.outputs.length === 4);
    const sumNew = workerDecoded.outputs.reduce((a, o) => a + BigInt(o.denom_new), 0n);
    ok('worker: Σ denom_new === denom_old', sumNew === fx.denomOld);
  }
}

// ============== Group 2: dapp ↔ worker field parity ==============
group('dapp ↔ worker field parity');
{
  const fx = buildFixture();
  const payload = dapp.encodeTSlotSplitPayload(fx);
  const d = dapp.decodeTSlotSplitPayload(payload);
  const w = workerDecode(payload);
  if (d && w) {
    ok('parity: nOutputs', d.nOutputs === w.n_outputs);
    ok('parity: denomOld', d.denomOld.toString() === w.denom_old);
    ok('parity: assetIdOld', bytesToHex(d.assetIdOld) === w.asset_id_old);
    ok('parity: oldRLeaf', bytesToHex(d.oldRLeaf) === w.old_r_leaf);
    ok('parity: oldBindHash', bytesToHex(d.oldBindHash) === w.old_bind_hash);
    ok('parity: output[0].denom_new',
      d.outputs[0].denomNew.toString() === w.outputs[0].denom_new);
    ok('parity: output[3].new_leaf_hash',
      bytesToHex(d.outputs[3].newLeafHash) === w.outputs[3].new_leaf_hash);
    ok('parity: oldOwnerPubkey', bytesToHex(d.oldOwnerPubkey) === w.old_owner_pubkey);
    ok('parity: oldOwnerSig', bytesToHex(d.oldOwnerSig) === w.old_owner_sig);
  } else {
    ok('parity: both decoders returned non-null', false,
      'd=' + (d === null ? 'null' : 'ok') + ' w=' + (w === null ? 'null' : 'ok'));
  }
}

// ============== Group 3: computeSlotSplitMsg determinism ==============
group('computeSlotSplitMsg deterministic + binding');
{
  const fx = buildFixture();
  const m1 = dapp.computeSlotSplitMsg(
    NET_SIGNET, fx.assetIdOld, fx.denomOld, fx.oldNullifierHash, fx.outputs);
  const m2 = dapp.computeSlotSplitMsg(
    NET_SIGNET, fx.assetIdOld, fx.denomOld, fx.oldNullifierHash, fx.outputs);
  ok('determinism: same inputs → same hash', bytesToHex(m1) === bytesToHex(m2));

  // Tamper one output's denom — message must change (output set is bound)
  const mutOutputs = fx.outputs.map(o => ({ ...o }));
  mutOutputs[0] = { ...mutOutputs[0], denomNew: 251_000n };
  const m3 = dapp.computeSlotSplitMsg(
    NET_SIGNET, fx.assetIdOld, fx.denomOld, fx.oldNullifierHash, mutOutputs);
  ok('binding: mutating output denom changes msg', bytesToHex(m1) !== bytesToHex(m3));
}

// ============== Group 4: decoder negative cases ==============
group('Decoder negative cases (security boundaries)');
{
  const fx = buildFixture();
  const valid = dapp.encodeTSlotSplitPayload(fx);

  const wrongOpcode = new Uint8Array(valid); wrongOpcode[0] = 0x45;
  ok('wrong opcode → null (dapp)', dapp.decodeTSlotSplitPayload(wrongOpcode) === null);
  ok('wrong opcode → null (worker)', workerDecode(wrongOpcode) === null);

  const badNet = new Uint8Array(valid); badNet[1] = 0x05;
  ok('network_tag > 2 → null (dapp)', dapp.decodeTSlotSplitPayload(badNet) === null);
  ok('network_tag > 2 → null (worker)', workerDecode(badNet) === null);

  const truncated = valid.slice(0, valid.length - 1);
  ok('truncated → null (dapp)', dapp.decodeTSlotSplitPayload(truncated) === null);
  ok('truncated → null (worker)', workerDecode(truncated) === null);

  // bind_hash sits at offset 1+1+32+8+32+32+33+32 = 171
  const tamperedBind = new Uint8Array(valid);
  tamperedBind[171] ^= 0x01;
  ok('tampered old_bind_hash → null (dapp)',
    dapp.decodeTSlotSplitPayload(tamperedBind) === null);
  ok('tampered old_bind_hash → null (worker)',
    workerDecode(tamperedBind) === null);
}

// ============== Group 5: encoder input-validation ==============
group('Encoder input validation');
{
  const fx = buildFixture();

  let threw;
  try { threw = false; dapp.encodeTSlotSplitPayload({ ...fx, outputs: [fx.outputs[0]] }); }
  catch (e) { threw = String(e.message || e); }
  ok('n=1 outputs rejected (min is 2)', typeof threw === 'string' && threw.includes('2..16'));

  try { threw = false; dapp.encodeTSlotSplitPayload({ ...fx, outputs: new Array(17).fill(fx.outputs[0]) }); }
  catch (e) { threw = String(e.message || e); }
  ok('n=17 outputs rejected (max is 16)', typeof threw === 'string' && threw.includes('2..16'));

  try { threw = false; dapp.encodeTSlotSplitPayload({ ...fx, networkTag: 5 }); }
  catch (e) { threw = String(e.message || e); }
  ok('network_tag > 2 rejected', typeof threw === 'string' && threw.includes('network_tag'));

  try {
    threw = false;
    dapp.encodeTSlotSplitPayload({ ...fx, oldProof: new Uint8Array(0) });
  } catch (e) { threw = String(e.message || e); }
  ok('empty proof rejected', typeof threw === 'string' && threw.includes('old_proof'));
}

// ============== Group 6: optional encrypted-notes tail ==============
// Per SPEC-CBTC-ZK-FUNGIBILITY §5.26.4 — SPLIT supports one note per output
// via a packed bitmap (LSB-first, ⌈n/8⌉ bytes) followed by N notes for
// outputs with has_note bit set.
group('Optional encrypted-notes tail (§5.26.4)');
{
  const fx = buildFixture();
  const noTail = dapp.encodeTSlotSplitPayload(fx);

  // All-null array → emits 1-byte bitmap of zeros, no notes
  const allNullArr = new Array(fx.outputs.length).fill(null);
  const explicitNoNotes = dapp.encodeTSlotSplitPayload({ ...fx, encryptedNotes: allNullArr });
  ok('encryptedNotes=[null,null,null,null] adds 1-byte zero bitmap',
    explicitNoNotes.length === noTail.length + 1 && explicitNoNotes[noTail.length] === 0x00);

  // Two notes attached at outputs 0 and 2
  const note0 = new Uint8Array(122);
  for (let i = 0; i < 122; i++) note0[i] = (i * 7 + 3) & 0xff;
  const note2 = new Uint8Array(122);
  for (let i = 0; i < 122; i++) note2[i] = (i * 13 + 17) & 0xff;
  const mixedNotes = [note0, null, note2, null];
  const withNotes = dapp.encodeTSlotSplitPayload({ ...fx, encryptedNotes: mixedNotes });
  ok('two notes attached → tail = 1 byte bitmap + 2*122 bytes notes',
    withNotes.length === noTail.length + 1 + 2 * 122);
  ok('bitmap has bits 0 and 2 set (LSB-first → 0b00000101 = 0x05)',
    withNotes[noTail.length] === 0x05);

  // Decoder round-trips
  const d0 = dapp.decodeTSlotSplitPayload(noTail);
  ok('decoder: no tail → encryptedNotes === null', d0 && d0.encryptedNotes === null);

  const d1 = dapp.decodeTSlotSplitPayload(explicitNoNotes);
  ok('decoder: zero bitmap → encryptedNotes === [null, null, null, null]',
    d1 && Array.isArray(d1.encryptedNotes) && d1.encryptedNotes.every(n => n === null));

  const d2 = dapp.decodeTSlotSplitPayload(withNotes);
  ok('decoder: mixed notes → array of correct length',
    d2 && Array.isArray(d2.encryptedNotes) && d2.encryptedNotes.length === fx.outputs.length);
  ok('decoder: output[0] has note',
    d2 && d2.encryptedNotes[0] !== null && bytesToHex(d2.encryptedNotes[0]) === bytesToHex(note0));
  ok('decoder: output[1] has no note',
    d2 && d2.encryptedNotes[1] === null);
  ok('decoder: output[2] has note', d2 && bytesToHex(d2.encryptedNotes[2]) === bytesToHex(note2));
  ok('decoder: output[3] has no note', d2 && d2.encryptedNotes[3] === null);

  // Worker parity
  const w2 = workerDecode(withNotes);
  ok('worker: encrypted_notes is array of length 4',
    w2 && Array.isArray(w2.encrypted_notes) && w2.encrypted_notes.length === 4);
  ok('worker: output[0] note hex matches', w2 && w2.encrypted_notes[0] === bytesToHex(note0));
  ok('worker: output[1] note is null', w2 && w2.encrypted_notes[1] === null);

  // Bitmap with bit set beyond nOutputs → null (ambiguity)
  // n=4 means valid bits are 0-3 (lower nibble). Bit 4 (0x10) is invalid.
  const badBitmap = new Uint8Array(noTail.length + 1);
  badBitmap.set(noTail); badBitmap[noTail.length] = 0x10;
  ok('bitmap bit beyond n_outputs → null (dapp)',
    dapp.decodeTSlotSplitPayload(badBitmap) === null);
  ok('bitmap bit beyond n_outputs → null (worker)',
    workerDecode(badBitmap) === null);

  // Truncated tail → null
  const truncTail = withNotes.slice(0, withNotes.length - 50);
  ok('truncated note tail → null (dapp)',
    dapp.decodeTSlotSplitPayload(truncTail) === null);
  ok('truncated note tail → null (worker)', workerDecode(truncTail) === null);

  // Encoder validation
  let threw = false;
  try { dapp.encodeTSlotSplitPayload({ ...fx, encryptedNotes: [null, null, null] }); }
  catch (e) { threw = String(e.message || e).includes('length === outputs.length'); }
  ok('encoder: wrong-length encryptedNotes array rejected', threw);

  threw = false;
  try { dapp.encodeTSlotSplitPayload({ ...fx, encryptedNotes: [null, new Uint8Array(100), null, null] }); }
  catch (e) { threw = String(e.message || e).includes('122-byte'); }
  ok('encoder: non-122-byte note element rejected', threw);
}

// ============== Group: §5.24.6 cross-asset rule enforcement ==============
// An output wrapper that is NOT the canonical variant for its denomination
// (a value-conserving relabel onto a foreign / wrong-denom asset) MUST be
// rejected by both decoders. This is the §5.24.6 anti-inflation gate.
group('§5.24.6 — cross-asset relabel rejected');
{
  // (a) Output asset_id is a foreign id (not ctacVariantAssetId of any tier).
  const foreign = { ...buildFixture() };
  foreign.outputs = foreign.outputs.map(o => ({
    ...o, assetIdNew: sha256(new TextEncoder().encode('foreign-wrapper-not-a-variant')),
  }));
  const pForeign = dapp.encodeTSlotSplitPayload(foreign);
  ok('foreign output asset → null (dapp)', dapp.decodeTSlotSplitPayload(pForeign) === null);
  ok('foreign output asset → null (worker)', workerDecode(pForeign) === null);

  // (b) Output asset_id is a VALID variant id but for the WRONG denom (the
  // 1M-tier id stamped on a 250k-denom output) — the exact relabel §5.24.6 bars.
  const wrongTier = { ...buildFixture() };
  wrongTier.outputs = wrongTier.outputs.map(o => ({
    ...o, assetIdNew: hexToBytes(dapp.ctacVariantAssetId(1_000_000n)), // denom is 250_000
  }));
  const pWrong = dapp.encodeTSlotSplitPayload(wrongTier);
  ok('wrong-denom variant → null (dapp)', dapp.decodeTSlotSplitPayload(pWrong) === null);
  ok('wrong-denom variant → null (worker)', workerDecode(pWrong) === null);

  // (c) The canonical cross-TIER split (250k variants from a 1M input) is still
  // ACCEPTED — re-tiering within the family is exactly what SPLIT is for.
  const ok250 = dapp.encodeTSlotSplitPayload(buildFixture());
  ok('canonical cross-tier split still accepted (dapp)', dapp.decodeTSlotSplitPayload(ok250) !== null);
  ok('canonical cross-tier split still accepted (worker)', workerDecode(ok250) !== null);

  // (d) Builder fails fast on a caller-supplied non-variant output asset.
  let threwBuild = false;
  try {
    await dapp.buildSlotSplitEnvelope({
      networkTag: NET_SIGNET,
      oldSlotRecord: {
        assetIdHex: dapp.ctacVariantAssetId(1_000_000n),
        denomination: '1000000',
        secretHex: bytesToHex(sha256(new TextEncoder().encode('s'))),
        nullifierPreimageHex: bytesToHex(sha256(new TextEncoder().encode('n'))),
      },
      oldMerkleRoot: new Uint8Array(32),
      oldProof: new Uint8Array(192),
      outputs: [
        { denomNew: 250_000n, assetIdHex: 'aa'.repeat(32) }, // foreign asset
        { denomNew: 750_000n },
      ],
      oldOwnerPriv: sha256(new TextEncoder().encode('p')),
    });
  } catch (e) { threwBuild = String(e.message || e).includes('§5.24.6'); }
  ok('builder rejects non-variant output asset', threwBuild);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
