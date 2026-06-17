// Audit fix coverage — nullifier owner-conflict re-verification (SPEC §5.11.4
// invariant 3, Non-double-spend; griefing/availability hardening).
//
// Background: scanPools mirrors worker-supplied nullifier records INCLUDING the
// recorded canonical owner (withdraw txid), with no on-chain re-verification
// (unlike leaves, which are kernel-re-verified). A stale (reorged-out) or
// forged owner-txid would then trip mixerIsNullifierSpentByOther and brick the
// legitimate owner's withdraw forever (first-write-wins owner sticks).
//
// The fix: the validator routes the double-spend gate through
// mixerWithdrawConflictBlocks, which re-verifies the conflicting owner on chain
// (verifyWithdrawOwnerOnChain) and:
//   - keeps blocking iff the owner is a genuine confirmed matching T_WITHDRAW,
//   - FAILS CLOSED (keeps blocking) on any transient/unverifiable result,
//   - resolves in our favor (re-points ownership) only when the recorded owner
//     is definitively NOT a real on-chain claim (clean 404 = reorged/forged, or
//     a tx that isn't a matching withdraw).
//
// This is the load-bearing safety property: a network blip must NEVER relax the
// double-spend gate, and a genuine prior spend must NEVER be overridden.
//
// Run: node tests/mixer-owner-conflict.test.mjs

import { JSDOM } from 'jsdom';
import { strict as assert } from 'node:assert';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); failed++; }
}

const te = new TextEncoder();
function b(n, fill) { const u = new Uint8Array(n); u.fill(fill); return u; }
function bigFromBytes(u) { let v = 0n; for (const x of u) v = (v << 8n) | BigInt(x); return v; }

// Register a CANONICAL pool (vk_cid + ceremony_cid match the trust anchors) so
// verifyWithdrawOwnerOnChain's canonical-pool gate passes.
function registerCanonicalPool(aidHex, denom) {
  return dapp.mixerRegisterPool(
    aidHex, denom,
    te.encode(dapp.CANONICAL_VK_CID),
    te.encode(dapp.CANONICAL_CEREMONY_CID),
    0, 'f'.repeat(64),
  );
}

// Build a structurally-VALID, Pedersen-consistent, bind_hash-correct T_WITHDRAW
// envelope and wrap it in a fake confirmed tx the mock fetchTx can return.
function makeGenuineWithdrawTx(aidHex, denom, nullifierHash, ownerTxid) {
  const assetId = dapp.hexToBytes(aidHex);
  const rLeaf = b(32, 7);
  const rLeafBig = bigFromBytes(rLeaf) % dapp.SECP_N;
  const recipientCommitment = dapp.pedersenCommit(denom, rLeafBig).toRawBytes(true); // 33 B
  const merkleRoot = b(32, 9);
  const bindHash = dapp.computeWithdrawBindHash(assetId, denom, nullifierHash, recipientCommitment, rLeaf);
  const proof = b(256, 0); // verifyWithdrawOwnerOnChain does NOT re-run Groth16 (see fn comment)
  const payload = dapp.encodeTWithdrawPayload({
    assetId, denomination: denom, merkleRoot, nullifierHash,
    recipientCommitment, rLeaf, bindHash, proof,
  });
  const scriptHex = dapp.bytesToHex(dapp.encodeEnvelopeScript(b(32, 3), payload));
  return {
    txid: ownerTxid,
    status: { confirmed: true, block_height: 100, block_hash: 'a'.repeat(64) },
    vin: [{ witness: ['00', scriptHex, '00'] }],
  };
}

const AID = '11'.repeat(32);
const DENOM = 100n;
const NH = b(32, 0x42);
const OUR_TXID = 'c'.repeat(64);
const OTHER_TXID = 'd'.repeat(64);

// ---- verifyWithdrawOwnerOnChain tri-state ----

await test('genuine confirmed matching withdraw → true (double-spend gate holds)', async () => {
  registerCanonicalPool(AID, DENOM);
  const tx = makeGenuineWithdrawTx(AID, DENOM, NH, OTHER_TXID);
  const r = await dapp.verifyWithdrawOwnerOnChain(OTHER_TXID, AID, DENOM, NH, async () => tx);
  assert.equal(r, true);
});

await test('owner tx exists but is NOT a T_WITHDRAW → false (forged owner-txid)', async () => {
  const r = await dapp.verifyWithdrawOwnerOnChain(OTHER_TXID, AID, DENOM, NH, async () => ({
    txid: OTHER_TXID, status: { confirmed: true }, vin: [{ witness: ['00', '00', '00'] }],
  }));
  assert.equal(r, false);
});

await test('owner withdraw for a DIFFERENT nullifier → false (forged attribution)', async () => {
  const tx = makeGenuineWithdrawTx(AID, DENOM, b(32, 0x99), OTHER_TXID); // different NH baked in
  const r = await dapp.verifyWithdrawOwnerOnChain(OTHER_TXID, AID, DENOM, NH, async () => tx);
  assert.equal(r, false);
});

await test('clean 404 (reorged-out / forged) → false (allow our re-broadcast)', async () => {
  dapp.txMarkNotFound(OTHER_TXID.toLowerCase());
  const r = await dapp.verifyWithdrawOwnerOnChain(OTHER_TXID, AID, DENOM, NH, async () => null);
  assert.equal(r, false);
});

await test('transient fetch failure (null, not 404-marked) → null (FAIL CLOSED)', async () => {
  const fresh = 'e'.repeat(64);
  assert.equal(dapp.txIsRecentlyNotFound(fresh), false, 'precondition: not negative-cached');
  const r = await dapp.verifyWithdrawOwnerOnChain(fresh, AID, DENOM, NH, async () => null);
  assert.equal(r, null);
});

await test('unconfirmed owner tx → null (FAIL CLOSED)', async () => {
  const r = await dapp.verifyWithdrawOwnerOnChain('a'.repeat(64), AID, DENOM, NH, async () => ({
    txid: 'a'.repeat(64), status: { confirmed: false }, vin: [{ witness: ['00', '00', '00'] }],
  }));
  assert.equal(r, null);
});

await test('empty / malformed owner string → false (not a real claim)', async () => {
  assert.equal(await dapp.verifyWithdrawOwnerOnChain('', AID, DENOM, NH, async () => null), false);
  assert.equal(await dapp.verifyWithdrawOwnerOnChain('nothex', AID, DENOM, NH, async () => null), false);
});

// ---- mixerWithdrawConflictBlocks end-to-end ----

await test('no conflict (owner == our tx) → false (proceed), no fetch performed', async () => {
  const aid = '21'.repeat(32);
  registerCanonicalPool(aid, DENOM);
  dapp.mixerMarkNullifierSpent(aid, DENOM, NH, OUR_TXID);
  let fetched = false;
  const blocked = await dapp.mixerWithdrawConflictBlocks(aid, DENOM, NH, OUR_TXID, async () => { fetched = true; return null; });
  assert.equal(blocked, false);
  assert.equal(fetched, false, 'must not fetch when there is no by-other conflict');
});

await test('conflict + genuine owner → true (block), ownership unchanged', async () => {
  const aid = '22'.repeat(32);
  registerCanonicalPool(aid, DENOM);
  dapp.mixerMarkNullifierSpent(aid, DENOM, NH, OTHER_TXID);
  const tx = makeGenuineWithdrawTx(aid, DENOM, NH, OTHER_TXID);
  const blocked = await dapp.mixerWithdrawConflictBlocks(aid, DENOM, NH, OUR_TXID, async () => tx);
  assert.equal(blocked, true);
  assert.equal(dapp.mixerGetNullifierOwner(aid, DENOM, NH), OTHER_TXID.toLowerCase(), 'genuine owner must NOT be overwritten');
});

await test('conflict + clean-404 owner → false (resolve), ownership re-pointed to us', async () => {
  const aid = '23'.repeat(32);
  registerCanonicalPool(aid, DENOM);
  dapp.mixerMarkNullifierSpent(aid, DENOM, NH, OTHER_TXID);
  dapp.txMarkNotFound(OTHER_TXID.toLowerCase());
  const blocked = await dapp.mixerWithdrawConflictBlocks(aid, DENOM, NH, OUR_TXID, async () => null);
  assert.equal(blocked, false);
  assert.equal(dapp.mixerGetNullifierOwner(aid, DENOM, NH), OUR_TXID.toLowerCase(), 'stale owner must be re-pointed to our confirmed withdraw');
});

await test('conflict + transient → true (FAIL CLOSED), ownership unchanged', async () => {
  const aid = '24'.repeat(32);
  registerCanonicalPool(aid, DENOM);
  dapp.mixerMarkNullifierSpent(aid, DENOM, NH, OTHER_TXID);
  // OTHER_TXID is NOT negative-cached for this fresh aid path; use a fresh owner.
  const freshOwner = '1'.repeat(64);
  dapp.mixerForceNullifierOwner(aid, DENOM, NH, freshOwner);
  assert.equal(dapp.txIsRecentlyNotFound(freshOwner), false);
  const blocked = await dapp.mixerWithdrawConflictBlocks(aid, DENOM, NH, OUR_TXID, async () => null);
  assert.equal(blocked, true, 'transient owner-fetch failure must keep the gate strict');
  assert.equal(dapp.mixerGetNullifierOwner(aid, DENOM, NH), freshOwner, 'must not re-point on a transient result');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
