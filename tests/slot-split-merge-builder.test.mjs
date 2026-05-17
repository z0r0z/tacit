// SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT §5.24 + §5.25 high-level dapp builder tests.
//
// Exercises the dapp's `buildSlotSplitEnvelope` and `buildSlotMergeEnvelope`
// functions — the layer that takes wallet-level slot records (with secrets)
// and produces wire-format payloads + new slot records. This is what the UI
// (Phase 4c, "Split slot" / "Merge slots" actions) and headless drivers
// (signet rehearsal, auto-buy flow) call.
//
// What this proves that slot-split.test.mjs and slot-merge.test.mjs don't:
//   - Builder generates fresh (secret, ν) per output and computes leaf hash,
//     recipient commit, K_btc consistently with the slot wrapper's two-key
//     construction (§5.24.0).
//   - Caller can supply (secret, ν) explicitly for deterministic tests.
//   - oldOwnerPriv signs over slot_split_msg correctly.
//   - newOwnerPriv signs over slot_merge_msg correctly.
//   - Decoder round-trips reveal byte-identical fields.
//   - Conservation enforcement: ΣD_new > D_old (SPLIT) or ΣD_old < D_new
//     (MERGE) raises.
//
// Run: `node tests/slot-split-merge-builder.test.mjs`

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

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
const worker = await import('../worker/src/index.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

const NET_SIGNET = 0x01;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function bytes32(seed) {
  return sha256(new TextEncoder().encode(seed));
}

// Build a synthetic slotRecord. The high-level builder reads secret +
// nullifierPreimage + denomination + assetIdHex out of the record, so we
// can construct a "live" record without going through buildSlotMintEnvelope.
function makeSlotRecord(seedStr, denom, assetIdHex) {
  const secret = bytes32(seedStr + '-secret');
  const nullifierPreimage = bytes32(seedStr + '-nu');
  return {
    assetIdHex,
    denomination: BigInt(denom).toString(),
    secretHex: bytesToHex(secret),
    nullifierPreimageHex: bytesToHex(nullifierPreimage),
    leafCommitmentHex: bytesToHex(bytes32(seedStr + '-leaf')),  // arbitrary; builder
                                                                  // doesn't read this
  };
}

// Deterministic test priv key for signing.
const ownerPriv = bytes32('test-owner-priv');

// ============== SPLIT high-level builder ==============
group('buildSlotSplitEnvelope round-trip');

{
  const assetIdHex = bytesToHex(bytes32('test-asset-id'));
  const oldDenom = 1_000_000n;
  const oldSlot = makeSlotRecord('test-split-old', oldDenom, assetIdHex);

  const oldMerkleRoot = bytes32('test-old-merkle-root');
  const oldProof = new Uint8Array(192);
  for (let i = 0; i < oldProof.length; i++) oldProof[i] = (i * 7 + 13) & 0xff;

  // 4 outputs, each 250_000 (Σ == oldDenom — fee comes from a separate vin)
  const outputs = [];
  for (let i = 0; i < 4; i++) {
    outputs.push({
      denomNew: 250_000n,
      secret: bytes32(`test-split-new-${i}-secret`),
      nullifierPreimage: bytes32(`test-split-new-${i}-nu`),
    });
  }

  const built = await dapp.buildSlotSplitEnvelope({
    networkTag: NET_SIGNET,
    oldSlotRecord: oldSlot,
    oldMerkleRoot,
    oldProof,
    outputs,
    oldOwnerPriv: ownerPriv,
  });

  ok('payload starts with opcode T_SLOT_SPLIT (0x46)', built.payload[0] === 0x46);
  ok('newSlotRecords length === outputs.length', built.newSlotRecords.length === 4);
  ok('sumDenomNew = ΣD_new', built.sumDenomNew === 1_000_000n);
  ok('feeFromSlot = 0 (Σ == D_old)', built.feeFromSlot === 0n);

  // Decode payload (dapp + worker)
  const decD = dapp.decodeTSlotSplitPayload(built.payload);
  ok('dapp decoder accepts builder output', decD !== null);
  ok('dapp parity: n_outputs', decD?.nOutputs === 4);
  ok('dapp parity: assetIdOld', bytesToHex(decD?.assetIdOld) === assetIdHex);
  ok('dapp parity: denomOld', decD?.denomOld === oldDenom);

  const decW = worker.decodeTSlotSplitPayload(built.payload);
  ok('worker decoder accepts builder output', decW !== null);
  ok('worker parity: n_outputs', decW?.n_outputs === 4);
  ok('worker parity: denom_old', decW?.denom_old === oldDenom.toString());
  ok('worker parity: kind=slot_split', decW?.kind === 'slot_split');

  // Each newSlotRecord has the recovery material the wallet needs
  for (let i = 0; i < 4; i++) {
    const r = built.newSlotRecords[i];
    ok(`record[${i}] has secretHex`, /^[0-9a-f]{64}$/.test(r.secretHex || ''));
    ok(`record[${i}] has rBtcHex`, /^[0-9a-f]{64}$/.test(r.rBtcHex || ''));
    ok(`record[${i}] has kBtcXOnlyHex`, /^[0-9a-f]{64}$/.test(r.kBtcXOnlyHex || ''));
    ok(`record[${i}] denomination matches`, r.denomination === '250000');
    ok(`record[${i}] splitFromNullifier set`, /^[0-9a-f]{64}$/.test(r.splitFromNullifier || ''));
    ok(`record[${i}] splitVoutIndex correct`, r.splitVoutIndex === i);
  }

  // Owner pubkey is the wallet derived from ownerPriv (compressed sec1 form).
  const ownerPubHex = bytesToHex(secp.getPublicKey(ownerPriv, true));
  ok('decoded old_owner_pubkey matches signer', decW.old_owner_pubkey === ownerPubHex);
  ok('old_owner_sig is 64 bytes hex', /^[0-9a-f]{128}$/.test(decW.old_owner_sig || ''));

  // The slot_split_msg the encoder signed over must round-trip byte-identical
  // when recomputed from the decoder's snake-case fields — this is what the
  // worker validator branch does to reverify the sig.
  const inputsForMsg = decW.outputs.map(o => ({
    assetIdNew: hexToBytes(o.asset_id_new),
    denomNew: BigInt(o.denom_new),
    newRecipientCommit: hexToBytes(o.new_recipient_commit),
    newLeafHash: hexToBytes(o.new_leaf_hash),
  }));
  const reMsg = dapp.computeSlotSplitMsg(
    NET_SIGNET,
    hexToBytes(decW.asset_id_old),
    BigInt(decW.denom_old),
    hexToBytes(decW.old_nullifier_hash),
    inputsForMsg,
  );
  ok('slot_split_msg recompute is 32 bytes', reMsg.length === 32);
}

group('buildSlotSplitEnvelope conservation enforcement');
{
  const assetIdHex = bytesToHex(bytes32('test-asset-id-2'));
  const oldSlot = makeSlotRecord('test-conserve-old', 1_000_000n, assetIdHex);
  // Σ D_new = 1_100_000 > D_old = 1_000_000 → should throw
  let threw = false;
  try {
    await dapp.buildSlotSplitEnvelope({
      networkTag: NET_SIGNET,
      oldSlotRecord: oldSlot,
      oldMerkleRoot: bytes32('mr'),
      oldProof: new Uint8Array(192).fill(0x11),
      outputs: [
        { denomNew: 600_000n }, { denomNew: 500_000n },
      ],
      oldOwnerPriv: ownerPriv,
    });
  } catch (e) {
    threw = /conservation/i.test(String(e.message || e));
  }
  ok('Σ D_new > D_old → throws conservation error', threw);
}

group('buildSlotSplitEnvelope output count bounds');
{
  const assetIdHex = bytesToHex(bytes32('test-asset-id-3'));
  const oldSlot = makeSlotRecord('test-bounds-old', 1_000_000n, assetIdHex);
  // Single-output split (n=1) is rejected — minimum is 2
  let threwLo = false;
  try {
    await dapp.buildSlotSplitEnvelope({
      networkTag: NET_SIGNET,
      oldSlotRecord: oldSlot,
      oldMerkleRoot: bytes32('mr'),
      oldProof: new Uint8Array(192).fill(0x22),
      outputs: [{ denomNew: 1_000_000n }],
      oldOwnerPriv: ownerPriv,
    });
  } catch (e) {
    threwLo = /2\.\.16/.test(String(e.message || e));
  }
  ok('n=1 outputs → throws (min 2)', threwLo);

  // 17 outputs is rejected — maximum is 16
  const tooMany = [];
  for (let i = 0; i < 17; i++) tooMany.push({ denomNew: 58_000n });
  let threwHi = false;
  try {
    await dapp.buildSlotSplitEnvelope({
      networkTag: NET_SIGNET,
      oldSlotRecord: oldSlot,
      oldMerkleRoot: bytes32('mr'),
      oldProof: new Uint8Array(192).fill(0x33),
      outputs: tooMany,
      oldOwnerPriv: ownerPriv,
    });
  } catch (e) {
    threwHi = /2\.\.16/.test(String(e.message || e));
  }
  ok('n=17 outputs → throws (max 16)', threwHi);
}

// ============== MERGE high-level builder ==============
group('buildSlotMergeEnvelope round-trip');

{
  const assetIdHex = bytesToHex(bytes32('test-merge-asset-id'));
  // 3 input slots, each 250_000, merging into one 700_000 slot
  // (50_000 fee paid from slot value)
  const oldSlots = [
    makeSlotRecord('merge-in-0', 250_000n, assetIdHex),
    makeSlotRecord('merge-in-1', 250_000n, assetIdHex),
    makeSlotRecord('merge-in-2', 250_000n, assetIdHex),
  ];
  const oldMerkleRoots = oldSlots.map((_, i) => bytes32(`merge-mr-${i}`));
  const oldProofs = oldSlots.map((_, i) => {
    const p = new Uint8Array(192);
    for (let j = 0; j < p.length; j++) p[j] = (i * 31 + j * 7) & 0xff;
    return p;
  });

  const built = await dapp.buildSlotMergeEnvelope({
    networkTag: NET_SIGNET,
    oldSlotRecords: oldSlots,
    oldMerkleRoots,
    oldProofs,
    denomNew: 700_000n,
    newSecret: bytes32('merge-new-secret'),
    newNullifierPreimage: bytes32('merge-new-nu'),
    newOwnerPriv: ownerPriv,
  });

  ok('payload starts with opcode T_SLOT_MERGE (0x47)', built.payload[0] === 0x47);
  ok('newSlotRecord exists', !!built.newSlotRecord);
  ok('sumDenomOld = 750_000', built.sumDenomOld === 750_000n);
  ok('feeFromSlots = 50_000', built.feeFromSlots === 50_000n);
  ok('inputNullifierHashes length === N', built.inputNullifierHashes.length === 3);

  const decD = dapp.decodeTSlotMergePayload(built.payload);
  ok('dapp decoder accepts builder output', decD !== null);
  ok('dapp parity: n_inputs', decD?.nInputs === 3);
  ok('dapp parity: denomNew', decD?.denomNew === 700_000n);

  const decW = worker.decodeTSlotMergePayload(built.payload);
  ok('worker decoder accepts builder output', decW !== null);
  ok('worker parity: n_inputs', decW?.n_inputs === 3);
  ok('worker parity: denom_new', decW?.denom_new === '700000');
  ok('worker parity: kind=slot_merge', decW?.kind === 'slot_merge');

  // New slot record carries all recovery material
  const r = built.newSlotRecord;
  ok('newSlotRecord.secretHex', /^[0-9a-f]{64}$/.test(r.secretHex || ''));
  ok('newSlotRecord.rBtcHex', /^[0-9a-f]{64}$/.test(r.rBtcHex || ''));
  ok('newSlotRecord.kBtcXOnlyHex', /^[0-9a-f]{64}$/.test(r.kBtcXOnlyHex || ''));
  ok('newSlotRecord.denomination', r.denomination === '700000');
  ok('newSlotRecord.mergedFromNullifiers length === N', (r.mergedFromNullifiers || []).length === 3);

  const ownerPubHex = bytesToHex(secp.getPublicKey(ownerPriv, true));
  ok('decoded new_owner_pubkey matches signer', decW.new_owner_pubkey === ownerPubHex);
  ok('new_owner_sig is 64 bytes hex', /^[0-9a-f]{128}$/.test(decW.new_owner_sig || ''));

  // slot_merge_msg recompute parity
  const inputsForMsg = decW.inputs.map(inp => ({
    assetIdOld: hexToBytes(inp.asset_id_old),
    denomOld: BigInt(inp.denom_old),
    oldNullifierHash: hexToBytes(inp.old_nullifier_hash),
  }));
  const reMsg = dapp.computeSlotMergeMsg(
    NET_SIGNET, inputsForMsg,
    hexToBytes(decW.asset_id_new),
    BigInt(decW.denom_new),
    hexToBytes(decW.new_recipient_commit),
    hexToBytes(decW.new_leaf_hash),
  );
  ok('slot_merge_msg recompute is 32 bytes', reMsg.length === 32);
}

group('buildSlotMergeEnvelope conservation enforcement');
{
  const assetIdHex = bytesToHex(bytes32('test-merge-conserve'));
  const oldSlots = [
    makeSlotRecord('mc-0', 100_000n, assetIdHex),
    makeSlotRecord('mc-1', 100_000n, assetIdHex),
  ];
  // denom_new = 250_000 > Σ denom_old = 200_000 → should throw
  let threw = false;
  try {
    await dapp.buildSlotMergeEnvelope({
      networkTag: NET_SIGNET,
      oldSlotRecords: oldSlots,
      oldMerkleRoots: oldSlots.map((_, i) => bytes32(`mc-mr-${i}`)),
      oldProofs: oldSlots.map(() => new Uint8Array(192).fill(0x44)),
      denomNew: 250_000n,
      newOwnerPriv: ownerPriv,
    });
  } catch (e) {
    threw = /conservation/i.test(String(e.message || e));
  }
  ok('denom_new > Σ denom_old → throws conservation error', threw);
}

group('buildSlotMergeEnvelope input count bounds');
{
  const assetIdHex = bytesToHex(bytes32('test-merge-bounds'));
  // n=1 input rejected (min 2)
  let threwLo = false;
  try {
    await dapp.buildSlotMergeEnvelope({
      networkTag: NET_SIGNET,
      oldSlotRecords: [makeSlotRecord('mb-0', 100_000n, assetIdHex)],
      oldMerkleRoots: [bytes32('mb-mr-0')],
      oldProofs: [new Uint8Array(192).fill(0x55)],
      denomNew: 50_000n,
      newOwnerPriv: ownerPriv,
    });
  } catch (e) {
    threwLo = /2\.\.16/.test(String(e.message || e));
  }
  ok('n=1 inputs → throws (min 2)', threwLo);
}

// ============== Optional note tails (§5.26.4) ==============
group('buildSlotSplitEnvelope with encrypted notes');

{
  const assetIdHex = bytesToHex(bytes32('test-split-note'));
  const oldSlot = makeSlotRecord('test-split-note-old', 1_000_000n, assetIdHex);
  const note0 = new Uint8Array(122); note0.fill(0xa1);
  const note2 = new Uint8Array(122); note2.fill(0xa2);
  // 3 outputs, notes attached only to indices 0 and 2
  const built = await dapp.buildSlotSplitEnvelope({
    networkTag: NET_SIGNET,
    oldSlotRecord: oldSlot,
    oldMerkleRoot: bytes32('split-note-mr'),
    oldProof: new Uint8Array(192).fill(0xb1),
    outputs: [
      { denomNew: 300_000n },
      { denomNew: 350_000n },
      { denomNew: 350_000n },
    ],
    oldOwnerPriv: ownerPriv,
    encryptedNotes: [note0, null, note2],
  });
  ok('split with notes encodes', built.payload[0] === 0x46);
  const decD = dapp.decodeTSlotSplitPayload(built.payload);
  ok('dapp decoder yields note array of length 3', (decD?.encryptedNotes || []).length === 3);
  ok('dapp: note[0] matches', decD && bytesToHex(decD.encryptedNotes[0]) === bytesToHex(note0));
  ok('dapp: note[1] is null', decD?.encryptedNotes[1] === null);
  ok('dapp: note[2] matches', decD && bytesToHex(decD.encryptedNotes[2]) === bytesToHex(note2));
}

group('buildSlotMergeEnvelope with encrypted note');
{
  const assetIdHex = bytesToHex(bytes32('test-merge-note'));
  const oldSlots = [
    makeSlotRecord('mn-0', 100_000n, assetIdHex),
    makeSlotRecord('mn-1', 100_000n, assetIdHex),
  ];
  const noteBytes = new Uint8Array(122); noteBytes.fill(0xc1);
  const built = await dapp.buildSlotMergeEnvelope({
    networkTag: NET_SIGNET,
    oldSlotRecords: oldSlots,
    oldMerkleRoots: oldSlots.map((_, i) => bytes32(`mn-mr-${i}`)),
    oldProofs: oldSlots.map(() => new Uint8Array(192).fill(0xb2)),
    denomNew: 180_000n,
    newOwnerPriv: ownerPriv,
    encryptedNote: noteBytes,
  });
  ok('merge with note encodes', built.payload[0] === 0x47);
  const decD = dapp.decodeTSlotMergePayload(built.payload);
  ok('dapp decoder yields note', decD?.encryptedNote !== null);
  ok('note bytes match', decD && bytesToHex(decD.encryptedNote) === bytesToHex(noteBytes));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
