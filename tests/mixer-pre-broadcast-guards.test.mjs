// Mixer pre-broadcast safety guards — regression coverage for the audit
// findings that prompted SPEC §5.11.4 tightenings.
//
// What this validates that no other test does:
//
//   1. Stale-root pre-broadcast guard reads leaf-counts from the canonical
//      poolMerkleTrees map (via mixerGetPoolStats), not poolRegistry. An
//      earlier audit found buildAndBroadcastWithdraw read .tree.leaves off
//      a registry entry that doesn't carry that field — silently always
//      resolved to 0 and disabled the entire stale-root protection.
//
//   2. Canonical-pool gate (mixerIsPoolCanonical) returns true only when
//      BOTH vk_cid AND ceremony_cid match the dapp's CANONICAL_* constants.
//      Mismatch on either side returns false. A regression here re-opens
//      the "POOL_INIT with backdoored vk" attack documented in SPEC §5.11.3.
//
//   3. bind_hash recompute rejects per-field tampering across ALL covered
//      fields (asset_id, denomination, nullifier_hash, recipient_commitment,
//      r_leaf). The existing mixer-envelope test flips only one byte; this
//      one walks each covered region. SPEC §5.11.4 invariant 4.
//
//   4. POOL_RECENT_ROOTS_WINDOW constant exposed and matches §5.11.4 = 32.
//
// Run: `node --test tests/mixer-pre-broadcast-guards.test.mjs`

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
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

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// Deterministic per-test byte fixtures so we don't leak state across tests.
let _aidCounter = 100;
function nextAidHex() {
  _aidCounter++;
  return bytesToHex(new Uint8Array(32).fill(_aidCounter & 0xff));
}
function fixedBytes(seed, len = 32) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed * 17 + i * 7) & 0xff;
  return out;
}

// ---- Stale-root guard: leafCount source-of-truth regression ----

console.log('Stale-root pre-broadcast guard (regression for poolMerkleTrees source):');

await test('mixerGetPoolStats returns 0 totalLeaves for empty pool', async () => {
  const aidHex = nextAidHex();
  const denom = 100n;
  const vkCid  = new TextEncoder().encode(dapp.CANONICAL_VK_CID);
  const ceCid  = new TextEncoder().encode(dapp.CANONICAL_CEREMONY_CID);
  dapp.mixerRegisterPool(aidHex, denom, vkCid, ceCid, 100, 'aa'.repeat(32));
  const stats = dapp.mixerGetPoolStats(aidHex, denom);
  return stats !== null && stats.totalLeaves === 0;
});

await test('mixerGetPoolStats tracks leaf count after appends (stale-root guard data source)', async () => {
  const aidHex = nextAidHex();
  const denom = 100n;
  const vkCid  = new TextEncoder().encode(dapp.CANONICAL_VK_CID);
  const ceCid  = new TextEncoder().encode(dapp.CANONICAL_CEREMONY_CID);
  dapp.mixerRegisterPool(aidHex, denom, vkCid, ceCid, 100, 'aa'.repeat(32));
  // Append N synthetic leaves. Pre-fix this returned 0 because the inline
  // read in buildAndBroadcastWithdraw walked poolRegistry.tree.leaves
  // (poolRegistry doesn't carry .tree) — _growth always evaluated to 0 and
  // the stale-root guard never fired. mixerGetPoolStats reads from
  // poolMerkleTrees, which IS where leaves actually live.
  for (let i = 0; i < 5; i++) {
    dapp.mixerAppendLeaf(aidHex, denom, fixedBytes(i + 1));
  }
  const stats = dapp.mixerGetPoolStats(aidHex, denom);
  return stats !== null && stats.totalLeaves === 5;
});

await test('mixerGetPoolStats returns null for unregistered pool', async () => {
  const aidHex = nextAidHex();
  // Pool not registered.
  return dapp.mixerGetPoolStats(aidHex, 999n) === null;
});

// ---- Canonical-pool gate: fail-closed on vk/ceremony mismatch ----

console.log('\nCanonical-pool gate (SPEC §5.11.3 trust-anchor):');

await test('mixerIsPoolCanonical: returns false for unregistered pool', () => {
  return dapp.mixerIsPoolCanonical(nextAidHex(), 999n) === false;
});

await test('mixerIsPoolCanonical: returns true when vk_cid AND ceremony_cid match canonical', async () => {
  const aidHex = nextAidHex();
  const denom = 100n;
  const vkCid  = new TextEncoder().encode(dapp.CANONICAL_VK_CID);
  const ceCid  = new TextEncoder().encode(dapp.CANONICAL_CEREMONY_CID);
  dapp.mixerRegisterPool(aidHex, denom, vkCid, ceCid, 100, 'aa'.repeat(32));
  return dapp.mixerIsPoolCanonical(aidHex, denom) === true;
});

await test('mixerIsPoolCanonical: returns false when vk_cid is wrong', async () => {
  const aidHex = nextAidHex();
  const denom = 100n;
  const wrongVk = new TextEncoder().encode('bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const ceCid  = new TextEncoder().encode(dapp.CANONICAL_CEREMONY_CID);
  dapp.mixerRegisterPool(aidHex, denom, wrongVk, ceCid, 100, 'aa'.repeat(32));
  return dapp.mixerIsPoolCanonical(aidHex, denom) === false;
});

await test('mixerIsPoolCanonical: returns false when ceremony_cid is wrong', async () => {
  const aidHex = nextAidHex();
  const denom = 100n;
  const vkCid  = new TextEncoder().encode(dapp.CANONICAL_VK_CID);
  const wrongCe = new TextEncoder().encode('bafybeiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  dapp.mixerRegisterPool(aidHex, denom, vkCid, wrongCe, 100, 'aa'.repeat(32));
  return dapp.mixerIsPoolCanonical(aidHex, denom) === false;
});

await test('mixerIsPoolCanonical: returns false when BOTH are wrong', async () => {
  const aidHex = nextAidHex();
  const denom = 100n;
  const wrongVk = new TextEncoder().encode('bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const wrongCe = new TextEncoder().encode('bafybeiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  dapp.mixerRegisterPool(aidHex, denom, wrongVk, wrongCe, 100, 'aa'.repeat(32));
  return dapp.mixerIsPoolCanonical(aidHex, denom) === false;
});

// ---- Per-field bind_hash tamper matrix ----

console.log('\nbind_hash per-field tamper matrix (SPEC §5.11.4 invariant 4):');

// Fixed inputs for the canonical preimage. We construct a valid envelope,
// then flip a byte in EACH covered field's region and assert the decoder
// rejects every variant.
const ASSET = new Uint8Array(32).fill(0xAA);
const ROOT  = new Uint8Array(32).fill(0xBB);
const NULL  = new Uint8Array(32).fill(0xCC);
// recipient_commitment must be a 33-byte compressed secp256k1 point in form
// (the decoder doesn't validate point-on-curve here — bind_hash recompute
// covers the byte content regardless of whether it's a real point).
const RECP  = new Uint8Array(33);
RECP[0] = 0x02; // compressed-even prefix
for (let i = 1; i < 33; i++) RECP[i] = 0xDD;
const RLEAF = new Uint8Array(32).fill(0xEE);
const PROOF = new Uint8Array(192).fill(0x11);
const DENOM = 100000000n;

function makeValidWithdrawPayload() {
  const bindHash = dapp.computeWithdrawBindHash(ASSET, DENOM, NULL, RECP, RLEAF);
  return dapp.encodeTWithdrawPayload({
    assetId: ASSET, denomination: DENOM, merkleRoot: ROOT,
    nullifierHash: NULL, recipientCommitment: RECP, rLeaf: RLEAF,
    bindHash, proof: PROOF,
  });
}

await test('valid payload round-trips (sanity)', () => {
  const dec = dapp.decodeTWithdrawPayload(makeValidWithdrawPayload());
  return dec !== null && dec.kind === 'withdraw';
});

// Wire layout offsets:
//   1 (opcode)
// + 32 (asset_id)      → offset 1..33
// + 8  (denom_LE)      → offset 33..41
// + 32 (merkle_root)   → offset 41..73   (NOT in bind_hash — circuit-bound)
// + 32 (nullifier)     → offset 73..105
// + 33 (recip_commit)  → offset 105..138
// + 32 (r_leaf)        → offset 138..170
// + 32 (bind_hash)     → offset 170..202
const TAMPER_REGIONS = [
  { name: 'asset_id',              start: 1,   end: 33  },
  { name: 'denomination',          start: 33,  end: 41  },
  { name: 'nullifier_hash',        start: 73,  end: 105 },
  { name: 'recipient_commitment',  start: 105, end: 138 },
  { name: 'r_leaf',                start: 138, end: 170 },
];

for (const region of TAMPER_REGIONS) {
  await test(`decoder REJECTS tampered ${region.name} (bind_hash recompute fails)`, () => {
    const valid = makeValidWithdrawPayload();
    // Flip one byte in the middle of the field. The decoder recomputes
    // bind_hash over (asset_id, denom_LE, nullifier_hash, recipient_commit,
    // r_leaf) and compares to the on-wire bind_hash at offset 170 — a
    // single-byte flip in any covered region breaks the recompute.
    const flipOffset = Math.floor((region.start + region.end) / 2);
    const tampered = new Uint8Array(valid);
    tampered[flipOffset] ^= 0x01;
    return dapp.decodeTWithdrawPayload(tampered) === null;
  });
}

await test(`decoder ACCEPTS tampered merkle_root (NOT covered by bind_hash)`, () => {
  // merkle_root is bound by the Groth16 circuit's membership constraint
  // (NOT by bind_hash). The decoder must still accept structurally — only
  // the proof verifier catches a mismatched root. This confirms the bind_hash
  // field set in computeWithdrawBindHash matches SPEC §5.11 exactly.
  const valid = makeValidWithdrawPayload();
  const tampered = new Uint8Array(valid);
  tampered[41 + 16] ^= 0x01;
  const dec = dapp.decodeTWithdrawPayload(tampered);
  return dec !== null && dec.kind === 'withdraw';
});

// ---- Window-size constant pin ----

console.log('\nConstant pins:');

await test('POOL_RECENT_ROOTS_WINDOW === 32 (SPEC §5.11.4 invariant 2)', () => {
  return dapp.POOL_RECENT_ROOTS_WINDOW === 32;
});

await test('POOL_TREE_DEPTH === 20 (SPEC §3.6 fixed-depth invariant)', () => {
  return dapp.POOL_TREE_DEPTH === 20;
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
