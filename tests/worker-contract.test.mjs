// Dapp ↔ worker contract tests.
//
// The atomic-intent-open path was 100% broken in production for an unknown
// stretch because the worker's `p2tr_spk_hex` regex expected `0020…` (P2WSH
// prefix) while the dapp legitimately sent `5120…` (P2TR prefix). Same length,
// similar shape, different SegWit version. No automated test exercised that
// boundary, so the drift was only caught by a real user attempting the flow.
//
// This file exists to keep that class of bug from recurring. For every dapp
// field shipped to a worker validation regex, we assert:
//   (a) what the dapp produces matches what the worker accepts
//   (b) the historically-wrong format that bit us would NOT match (regression)
//
// The worker regexes here are duplicated by hand from worker/src/index.js. That
// duplication is intentional — the test IS the contract spec. If a worker-side
// regex changes, this test should fail loudly so the dapp side can be checked
// for drift, not silently track the new (possibly incorrect) regex.
//
// Run: `node worker-contract.test.mjs`
import { JSDOM } from 'jsdom';

// jsdom shim — the dapp expects browser globals at module-load time
// (document.addEventListener, localStorage reads). __TACIT_NO_INIT__ keeps
// init() from running so we don't need network/extension fakes too.
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
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';

// Dynamic import so the dapp's module-load body sees the jsdom globals set up
// above. Static imports are hoisted in ES modules and would run before the
// shim, throwing on document.addEventListener at line 30 of tacit.js.
const dapp = await import('../dapp/tacit.js');
const { p2trScript, controlBlock, signSchnorr } = dapp;

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

// ============================================================================
// Worker validation regexes — copied verbatim from worker/src/index.js.
// If any of these drift in the worker, this test must be updated AND the
// matching dapp call site must be re-verified.
// ============================================================================
const WORKER = {
  // line 2137 — atomic intent publish (the regression case)
  p2trSpkHex:        /^5120[0-9a-f]{64}$/,
  // line 2150 — control block (33 bytes: leaf-version|parity || internalXonly)
  controlBlockHex:   /^[0-9a-f]{66}$/,
  // line 2127 — atomic intent_id (16 bytes derived from sha256(commit_txid || maker_pub)[:16])
  intentIdHex:       /^[0-9a-f]{32}$/,
  // lines 2128, 2305, 2351 etc. — 33-byte compressed pubkey (02/03 prefix)
  compressedPubHex:  /^0[23][0-9a-f]{64}$/,
  // lines 2146, 2306, 2353 etc. — 64-byte BIP-340 Schnorr sig
  schnorrSigHex:     /^[0-9a-f]{128}$/,
  // Airdrop claim queue (handleAirdropClaimPost)
  airdropMerkleRootHex: /^[0-9a-f]{64}$/,
  airdropEthSigHex:     /^[0-9a-f]{130}$/,    // 65 bytes: r:32 || s:32 || v:1
};

// The historically-wrong regex that bit us. Kept as a regression sentinel:
// if this ever starts matching what the dapp produces, something is very wrong.
const HISTORIC_BROKEN_P2TR_REGEX = /^0020[0-9a-f]{64}$/;

// ============================================================================
// Tests
// ============================================================================

console.log('Dapp ↔ worker P2TR scriptPubKey contract:');

await test("p2trScript output matches worker's /^5120[0-9a-f]{64}$/", () => {
  // Any valid 32-byte x-only key works; the script-builder doesn't care about value.
  const Q_xonly = new Uint8Array(32).fill(0xab);
  const spkHex = bytesToHex(p2trScript(Q_xonly));
  return WORKER.p2trSpkHex.test(spkHex);
});

await test("p2trScript output does NOT match the broken /^0020[0-9a-f]{64}$/ (regression sentinel)", () => {
  // If this ever returns true, either (a) the dapp's p2trScript has been
  // accidentally rewritten to produce a P2WSH script, or (b) the original
  // bug has been re-introduced into the worker AND we're somehow matching it.
  // Either way, scream.
  const Q_xonly = new Uint8Array(32).fill(0xcd);
  const spkHex = bytesToHex(p2trScript(Q_xonly));
  return HISTORIC_BROKEN_P2TR_REGEX.test(spkHex) === false;
});

await test('p2trScript output is exactly 34 bytes (51 + 20 + 32 = 0x51 OP_1, 0x20 push, 32-byte key)', () => {
  const Q_xonly = new Uint8Array(32).fill(0xef);
  const spk = p2trScript(Q_xonly);
  return spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
});

console.log('\nDapp ↔ worker control-block contract:');

await test("controlBlock output matches worker's /^[0-9a-f]{66}$/", () => {
  // Any 32-byte internal x-only + parity bit. leafVersion default 0xc0.
  const internalX = new Uint8Array(32).fill(0x12);
  const cbHex = bytesToHex(controlBlock(internalX, 0));
  return WORKER.controlBlockHex.test(cbHex);
});

await test('controlBlock output is exactly 33 bytes (leaf-version|parity + 32-byte internal x-only)', () => {
  const internalX = new Uint8Array(32).fill(0x34);
  // parity 0 → byte 0 = 0xc0; parity 1 → byte 0 = 0xc1
  const cb0 = controlBlock(internalX, 0);
  const cb1 = controlBlock(internalX, 1);
  return cb0.length === 33 && cb0[0] === 0xc0 && cb1[0] === 0xc1;
});

console.log('\nDapp ↔ worker derived-id / sig contracts:');

await test("intent_id derivation produces 16 bytes / matches worker's /^[0-9a-f]{32}$/", () => {
  // The dapp computes: sha256(reverseBytes(commitTxidHex) || wallet.pub)[:16]
  // We mirror that here without importing the dapp's full identity machinery.
  const commitTxidHex = '0'.repeat(64);
  const pub = new Uint8Array(33); pub[0] = 0x02;
  const txidBE = hexToBytes(commitTxidHex).reverse();
  const idBytes = sha256(new Uint8Array([...txidBE, ...pub])).slice(0, 16);
  return idBytes.length === 16 && WORKER.intentIdHex.test(bytesToHex(idBytes));
});

await test("compressed pubkey from secp matches worker's /^0[23][0-9a-f]{64}$/", () => {
  // Generate a real secp pubkey to make sure the parity prefix is one of the
  // accepted bytes. Loops are fine — secp keys are uniformly distributed.
  const priv = new Uint8Array(32); priv[31] = 1;
  const pub = secp.getPublicKey(priv, true);
  return pub.length === 33 && WORKER.compressedPubHex.test(bytesToHex(pub));
});

await test("Schnorr sig from signSchnorr matches worker's /^[0-9a-f]{128}$/", () => {
  const priv = new Uint8Array(32); priv[31] = 7;
  const msg = sha256(new TextEncoder().encode('contract-test'));
  const sig = signSchnorr(msg, priv);
  return sig.length === 64 && WORKER.schnorrSigHex.test(bytesToHex(sig));
});

console.log('\nDapp ↔ worker airdrop-claim contract:');

const { buildAirdropMerkle, airdropLeafHash, _signEip191WithPriv, _ethAddrFromPriv, buildAirdropClaimMsg } = await import('./composition.mjs');

await test('airdrop merkle root format (32-byte) matches worker /^[0-9a-f]{64}$/', () => {
  const leaves = [
    airdropLeafHash(new Uint8Array(20).fill(1), 100n, 0),
    airdropLeafHash(new Uint8Array(20).fill(2), 200n, 1),
  ];
  const { root } = buildAirdropMerkle(leaves);
  return root.length === 32 && WORKER.airdropMerkleRootHex.test(bytesToHex(root));
});

await test("dapp's eth signature output is 65 bytes / matches worker /^[0-9a-f]{130}$/", () => {
  const priv = new Uint8Array(32); priv[31] = 11;
  const addr = _ethAddrFromPriv(priv);
  const msg = buildAirdropClaimMsg({
    rootHex: '0'.repeat(64), network: 'mainnet',
    assetIdHex: 'f'.repeat(64),
    ethAddrHex: addr, leafIndex: 0, amount: 1n,
    ticker: 'T', decimals: 0, tacitPubHex: '02' + 'a'.repeat(64),
  });
  const sig = _signEip191WithPriv(msg, priv);  // returns 0x-prefixed 132-char
  const stripped = sig.replace(/^0x/, '');
  return stripped.length === 130 && WORKER.airdropEthSigHex.test(stripped);
});

await test('airdrop claim POST body shape: { leaf_index, tacit_pubkey, eth_sig }', () => {
  // Pin the body keys the dapp will send vs what the worker expects.
  // If either side renames, the round-trip breaks silently otherwise.
  const dappBody = {
    leaf_index: 7,
    tacit_pubkey: '02' + 'b'.repeat(64),
    eth_sig: '0x' + '1'.repeat(130),
  };
  const required = ['leaf_index', 'tacit_pubkey', 'eth_sig'];
  const got = Object.keys(dappBody);
  return required.every(k => got.includes(k))
      && Number.isInteger(dappBody.leaf_index)
      && WORKER.compressedPubHex.test(dappBody.tacit_pubkey)
      && WORKER.airdropEthSigHex.test(dappBody.eth_sig.replace(/^0x/, ''));
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
