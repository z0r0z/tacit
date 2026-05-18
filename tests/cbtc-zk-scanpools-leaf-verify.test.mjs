// SPEC §5.11.4 three-verifier model — defence-in-depth re-verify of
// cBTC.zk slot leaves during the dapp's scanPools sweep.
//
// What this guards against:
//   The dapp's pre-fix scanPools called verifyMixerDepositKernelOnChain for
//   every leaf returned by /pools/:asset_id/:denom. That function gates on
//   `env.opcode === T_DEPOSIT` (Mimblewimble conservation kernel), so any
//   cBTC.zk pool leaf — whose reveal tx carries a T_SLOT_MINT / ROTATE /
//   SPLIT / MERGE envelope, NOT T_DEPOSIT — was rejected as "unbacked" and
//   the local merkle tree stopped applying leaves for that pool. Result:
//   T_SLOT_BURN proof generation failed with "slot leaf is not in the local
//   pool tree" because buildMixerMerkleProof had no leaves to query.
//
// What this proves now:
//   verifySlotLeafOnChain pairs with verifyMixerDepositKernelOnChain to
//   cover the four slot-leaf kinds, mirroring the worker's slot-op gates
//   (asset_id + denom + leaf_hash match, inner Schnorr signature, vout
//   shape + value). Positive case + cryptographic-rejection cases.
//
// Run: `node tests/cbtc-zk-scanpools-leaf-verify.test.mjs`

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

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
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

const NETWORK_TAG_SIGNET = 0x01;
const ASSET_ID = sha256(new TextEncoder().encode('scanpools-test:asset-id'));
const DENOMINATION = 100_000n;
const CONFIRMED_HEIGHT = 100_000;

function bytes32(label) {
  return sha256(new TextEncoder().encode('scanpools-test:' + label));
}

// Wrap a slot-mint payload (or any envelope payload) into the on-chain
// reveal tx shape the dapp expects to see when it calls fetchTx. Only the
// fields verifySlotLeafOnChain reads are populated; everything else is
// noise the verifier ignores.
function fakeRevealTx({ envelopePayload, voutSpkHex, voutValueSats, signerXonly = bytes32('signer') }) {
  const envelopeScript = dapp.encodeEnvelopeScript(
    signerXonly.length === 32 ? signerXonly : signerXonly.slice(1, 33),
    envelopePayload,
  );
  return {
    txid: bytesToHex(bytes32('reveal-txid')),
    status: { confirmed: true, block_height: CONFIRMED_HEIGHT, block_time: 1_700_000_000 },
    vin: [{ witness: ['', bytesToHex(envelopeScript), ''] }],
    vout: [{ scriptpubkey: voutSpkHex, value: voutValueSats }],
  };
}

group('slot_mint — verifySlotLeafOnChain happy path + rejections');
{
  const minterPriv = bytes32('mint-priv');
  const secret = bytes32('mint-secret');
  const nullPre = bytes32('mint-null-preimage');
  const mintOut = await dapp.buildSlotMintEnvelope({
    networkTag: NETWORK_TAG_SIGNET,
    assetId: ASSET_ID,
    denomination: DENOMINATION,
    secret,
    nullifierPreimage: nullPre,
    paymentAssetId: new Uint8Array(32),
    paymentAmount: 0n,
    minterPriv,
  });
  ok('mint envelope built', !!mintOut && !!mintOut.payload);

  const tx = fakeRevealTx({
    envelopePayload: mintOut.payload,
    voutSpkHex: bytesToHex(mintOut.slotScriptPubKey),
    voutValueSats: Number(DENOMINATION),
    signerXonly: secp.getPublicKey(minterPriv, true).slice(1),
  });
  const leafRec = {
    kind: 'slot_mint',
    asset_id: bytesToHex(ASSET_ID),
    denomination: DENOMINATION.toString(),
    leaf_commitment: mintOut.slotRecord.leafCommitmentHex,
    deposit_txid: tx.txid,
    deposited_at_height: CONFIRMED_HEIGHT,
  };

  const fetchTx = async (id) => (id === tx.txid ? tx : null);
  const got = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    hexToBytes(leafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_mint leaf accepted by verifier', got === true);

  const wrongAid = bytesToHex(bytes32('wrong-asset-id'));
  const gotWrongAid = await dapp.verifySlotLeafOnChain(
    leafRec, wrongAid, DENOMINATION,
    hexToBytes(leafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_mint rejected on asset_id mismatch', gotWrongAid === false);

  const gotWrongDenom = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION + 1n,
    hexToBytes(leafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_mint rejected on denomination mismatch', gotWrongDenom === false);

  const wrongLeaf = bytes32('wrong-leaf-hash');
  const gotWrongLeaf = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    wrongLeaf, fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_mint rejected on leaf_hash mismatch', gotWrongLeaf === false);

  // Wrong vout value — tamper the reveal tx.
  const txBadValue = { ...tx, vout: [{ ...tx.vout[0], value: Number(DENOMINATION) - 1 }] };
  const fetchBadValue = async (id) => (id === tx.txid ? txBadValue : null);
  const gotBadValue = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    hexToBytes(leafRec.leaf_commitment), fetchBadValue, CONFIRMED_HEIGHT,
  );
  ok('slot_mint rejected on vout[0] value mismatch', gotBadValue === false);

  // Tamper the signature — last 64 bytes of the payload are minter_sig.
  // Flipping a byte invalidates the Schnorr verify.
  const tamperedPayload = new Uint8Array(mintOut.payload);
  const sigOffset = tamperedPayload.length - (32 /* k_btc */ + 1 /* maybe note tail */);
  // canonical 276-byte mint payload puts minter_sig at bytes 211..275 (before kBtc)
  // — simpler to just flip somewhere known-to-be in the sig blob (offset 200).
  tamperedPayload[200] ^= 0xff;
  const txBadSig = fakeRevealTx({
    envelopePayload: tamperedPayload,
    voutSpkHex: bytesToHex(mintOut.slotScriptPubKey),
    voutValueSats: Number(DENOMINATION),
    signerXonly: secp.getPublicKey(minterPriv, true).slice(1),
  });
  const fetchBadSig = async (id) => (id === tx.txid ? txBadSig : null);
  const gotBadSig = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    hexToBytes(leafRec.leaf_commitment), fetchBadSig, CONFIRMED_HEIGHT,
  );
  ok('slot_mint rejected on tampered signature', gotBadSig === false);

  // Transient fetch failure → null (caller retries next refresh, no warn).
  const gotMissing = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    hexToBytes(leafRec.leaf_commitment), async () => null, CONFIRMED_HEIGHT,
  );
  ok('slot_mint returns null when fetchTx yields no tx (transient)', gotMissing === null);

  // Height mismatch (worker lied about confirmation height).
  const gotWrongHeight = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    hexToBytes(leafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT + 1,
  );
  ok('slot_mint rejected on height pin mismatch', gotWrongHeight === false);
}

group('slot_rotate_new — verifySlotLeafOnChain on the new-leaf side');
{
  // For rotate, we need an existing slotRecord to feed into the builder.
  // The builder reads (secretHex, nullifierPreimageHex, assetIdHex, denomination)
  // from oldSlotRecord; we don't need it to be on-chain since the dapp's
  // rotate-side verifier only checks the new leaf.
  const oldOwnerPriv = bytes32('rotate-old-priv');
  const oldSecret = bytes32('rotate-old-secret');
  const oldNullPre = bytes32('rotate-old-null');
  const oldSlot = {
    assetIdHex: bytesToHex(ASSET_ID),
    denomination: DENOMINATION.toString(),
    secretHex: bytesToHex(oldSecret),
    nullifierPreimageHex: bytesToHex(oldNullPre),
  };
  const newSecret = bytes32('rotate-new-secret');
  const newNullPre = bytes32('rotate-new-null');
  const stubProof = new Uint8Array(192);
  for (let i = 0; i < stubProof.length; i++) stubProof[i] = (i * 11 + 5) & 0xff;

  const rotateOut = await dapp.buildSlotRotateEnvelope({
    networkTag: NETWORK_TAG_SIGNET,
    oldSlotRecord: oldSlot,
    oldMerkleRoot: new Uint8Array(32),
    oldProof: stubProof,
    newSecret,
    newNullifierPreimage: newNullPre,
    paymentAssetId: new Uint8Array(32),
    paymentAmount: 0n,
    oldOwnerPriv,
  });
  ok('rotate envelope built', !!rotateOut && !!rotateOut.payload);

  const tx = fakeRevealTx({
    envelopePayload: rotateOut.payload,
    voutSpkHex: bytesToHex(rotateOut.newSlotScriptPubKey),
    voutValueSats: Number(DENOMINATION),
    signerXonly: secp.getPublicKey(oldOwnerPriv, true).slice(1),
  });
  const leafRec = {
    kind: 'slot_rotate_new',
    asset_id: bytesToHex(ASSET_ID),
    denomination: DENOMINATION.toString(),
    leaf_commitment: rotateOut.newSlotRecord.leafCommitmentHex,
    deposit_txid: tx.txid,
    deposited_at_height: CONFIRMED_HEIGHT,
  };

  const fetchTx = async (id) => (id === tx.txid ? tx : null);
  const got = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    hexToBytes(leafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_rotate_new leaf accepted by verifier', got === true);

  const wrongLeaf = bytes32('rotate-wrong-leaf');
  const gotWrongLeaf = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, DENOMINATION,
    wrongLeaf, fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_rotate_new rejected on leaf_hash mismatch', gotWrongLeaf === false);
}

group('slot_split_new — verifySlotLeafOnChain per split output (vout index)');
{
  const oldOwnerPriv = bytes32('split-old-priv');
  const oldSlot = {
    assetIdHex: bytesToHex(ASSET_ID),
    denomination: (DENOMINATION * 4n).toString(),
    secretHex: bytesToHex(bytes32('split-old-secret')),
    nullifierPreimageHex: bytesToHex(bytes32('split-old-null')),
  };
  const stubProof = new Uint8Array(192);
  for (let i = 0; i < stubProof.length; i++) stubProof[i] = (i * 13 + 7) & 0xff;
  const outputs = [];
  for (let i = 0; i < 4; i++) {
    outputs.push({
      denomNew: DENOMINATION,
      secret: bytes32(`split-out-${i}-secret`),
      nullifierPreimage: bytes32(`split-out-${i}-null`),
    });
  }
  const splitOut = await dapp.buildSlotSplitEnvelope({
    networkTag: NETWORK_TAG_SIGNET,
    oldSlotRecord: oldSlot,
    oldMerkleRoot: new Uint8Array(32),
    oldProof: stubProof,
    outputs,
    oldOwnerPriv,
  });
  ok('split envelope built', !!splitOut && !!splitOut.payload);
  ok('split produced 4 newSlotRecords', splitOut.newSlotRecords.length === 4);

  const vouts = [];
  for (let i = 0; i < 4; i++) {
    vouts.push({
      scriptpubkey: splitOut.newSlotRecords[i].slotScriptPubKeyHex,
      value: Number(DENOMINATION),
    });
  }
  const envelopeScript = dapp.encodeEnvelopeScript(
    secp.getPublicKey(oldOwnerPriv, true).slice(1),
    splitOut.payload,
  );
  const tx = {
    txid: bytesToHex(bytes32('split-reveal-txid')),
    status: { confirmed: true, block_height: CONFIRMED_HEIGHT, block_time: 1_700_000_000 },
    vin: [{ witness: ['', bytesToHex(envelopeScript), ''] }],
    vout: vouts,
  };

  const fetchTx = async (id) => (id === tx.txid ? tx : null);
  // Verify each output's leaf entry from the worker's perspective.
  for (let i = 0; i < 4; i++) {
    const rec = splitOut.newSlotRecords[i];
    const leafRec = {
      kind: 'slot_split_new',
      asset_id: bytesToHex(ASSET_ID),
      denomination: DENOMINATION.toString(),
      leaf_commitment: rec.leafCommitmentHex,
      deposit_txid: tx.txid,
      tx_index: 0,
      deposited_at_height: CONFIRMED_HEIGHT,
      split_vout_index: i,
    };
    const got = await dapp.verifySlotLeafOnChain(
      leafRec, leafRec.asset_id, DENOMINATION,
      hexToBytes(leafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT,
    );
    ok(`slot_split_new output[${i}] accepted by verifier`, got === true);
  }

  // Cross-output mix-up: leaf_commitment from output 1, split_vout_index = 0
  // — verifier reads ss.outputs[0].newLeafHash, which doesn't match → false.
  const mixedLeafRec = {
    kind: 'slot_split_new',
    asset_id: bytesToHex(ASSET_ID),
    denomination: DENOMINATION.toString(),
    leaf_commitment: splitOut.newSlotRecords[1].leafCommitmentHex,
    deposit_txid: tx.txid,
    tx_index: 0,
    deposited_at_height: CONFIRMED_HEIGHT,
    split_vout_index: 0,
  };
  const gotMixed = await dapp.verifySlotLeafOnChain(
    mixedLeafRec, mixedLeafRec.asset_id, DENOMINATION,
    hexToBytes(mixedLeafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_split_new rejects mismatched split_vout_index', gotMixed === false);
}

group('slot_merge_new — verifySlotLeafOnChain on the merged-output side');
{
  const newOwnerPriv = bytes32('merge-new-priv');
  const oldSlotRecords = [];
  const oldMerkleRoots = [];
  const oldProofs = [];
  for (let i = 0; i < 3; i++) {
    oldSlotRecords.push({
      assetIdHex: bytesToHex(ASSET_ID),
      denomination: DENOMINATION.toString(),
      secretHex: bytesToHex(bytes32(`merge-in-${i}-secret`)),
      nullifierPreimageHex: bytesToHex(bytes32(`merge-in-${i}-null`)),
    });
    oldMerkleRoots.push(new Uint8Array(32));
    const p = new Uint8Array(192);
    for (let k = 0; k < p.length; k++) p[k] = (k * 17 + i * 3 + 1) & 0xff;
    oldProofs.push(p);
  }
  const newDenom = DENOMINATION * BigInt(oldSlotRecords.length);

  const mergeOut = await dapp.buildSlotMergeEnvelope({
    networkTag: NETWORK_TAG_SIGNET,
    oldSlotRecords,
    oldMerkleRoots,
    oldProofs,
    assetIdNewHex: bytesToHex(ASSET_ID),
    denomNew: newDenom,
    newSecret: bytes32('merge-new-secret'),
    newNullifierPreimage: bytes32('merge-new-null'),
    newOwnerPriv,
  });
  ok('merge envelope built', !!mergeOut && !!mergeOut.payload);

  const tx = fakeRevealTx({
    envelopePayload: mergeOut.payload,
    voutSpkHex: mergeOut.newSlotRecord.slotScriptPubKeyHex,
    voutValueSats: Number(newDenom),
    signerXonly: secp.getPublicKey(newOwnerPriv, true).slice(1),
  });
  const leafRec = {
    kind: 'slot_merge_new',
    asset_id: bytesToHex(ASSET_ID),
    denomination: newDenom.toString(),
    leaf_commitment: mergeOut.newSlotRecord.leafCommitmentHex,
    deposit_txid: tx.txid,
    deposited_at_height: CONFIRMED_HEIGHT,
  };

  const fetchTx = async (id) => (id === tx.txid ? tx : null);
  const got = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, newDenom,
    hexToBytes(leafRec.leaf_commitment), fetchTx, CONFIRMED_HEIGHT,
  );
  ok('slot_merge_new leaf accepted by verifier', got === true);

  // Wrong opcode (give it a mint envelope to chew on) → false.
  const minterPriv = bytes32('merge-vs-mint-priv');
  const mintOut = await dapp.buildSlotMintEnvelope({
    networkTag: NETWORK_TAG_SIGNET,
    assetId: ASSET_ID, denomination: DENOMINATION,
    secret: bytes32('merge-vs-mint-secret'),
    nullifierPreimage: bytes32('merge-vs-mint-null'),
    paymentAssetId: new Uint8Array(32), paymentAmount: 0n,
    minterPriv,
  });
  const txWrongOpcode = fakeRevealTx({
    envelopePayload: mintOut.payload,
    voutSpkHex: bytesToHex(mintOut.slotScriptPubKey),
    voutValueSats: Number(DENOMINATION),
    signerXonly: secp.getPublicKey(minterPriv, true).slice(1),
  });
  const fetchWrongOpcode = async () => txWrongOpcode;
  const gotWrongOpcode = await dapp.verifySlotLeafOnChain(
    leafRec, leafRec.asset_id, newDenom,
    hexToBytes(leafRec.leaf_commitment), fetchWrongOpcode, CONFIRMED_HEIGHT,
  );
  ok('slot_merge_new rejects when reveal envelope is T_SLOT_MINT', gotWrongOpcode === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
