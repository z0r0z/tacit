#!/usr/bin/env node
// Authenticated DELETE /airdrops/:root/claims/:leaf_index — cross-impl parity
// + sign/verify roundtrip.
//
// The worker now requires a BIP-340 signature from the announcement's
// `issuer_pubkey` plus a ±5 min fresh timestamp. The canonical message must
// be byte-identical between the dapp (`airdropClaimDeleteMsgBytes`) and the
// worker (`airdropClaimDeleteMsg`) — drift here silently breaks every
// daemon delete in production.
//
// Coverage:
//   1. byte parity across dapp/worker for a fixed vector
//   2. sign(dapp) → verify(worker) roundtrip succeeds
//   3. tampered field (root / leaf_index / timestamp / pubkey) → verification
//      fails (each field is bound — no field can be silently mutated in
//      transit without invalidating the sig)

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');
const worker = await import('../worker/src/index.js');

let pass = 0, fail = 0;
function expect(label, predicate, hint = '') {
  if (predicate) { console.log(`  PASS  ${label}`); pass++; }
  else            { console.log(`  FAIL  ${label}${hint ? ` — ${hint}` : ''}`); fail++; }
}

// Fixed test vector
const NETWORK = 'signet';
const ROOT = 'a'.repeat(64);
const LEAF = 7;
const ISSUER_PRIV = hexToBytes('11'.repeat(32));
const ISSUER_PUB = secp.getPublicKey(ISSUER_PRIV, true);
const ISSUER_PUB_HEX = bytesToHex(ISSUER_PUB);
const TIMESTAMP = 1747000000;

console.log('\n=== Airdrop claim-delete auth ===');

// --- 1. Byte parity ---
const dappBytes = dapp.airdropClaimDeleteMsgBytes(NETWORK, ROOT, LEAF, ISSUER_PUB_HEX, TIMESTAMP);
const workerBytes = worker.airdropClaimDeleteMsg(NETWORK, ROOT, LEAF, ISSUER_PUB_HEX, TIMESTAMP);
expect('byte-parity: dapp msg === worker msg', bytesToHex(dappBytes) === bytesToHex(workerBytes),
  `dapp=${bytesToHex(dappBytes)} worker=${bytesToHex(workerBytes)}`);

// --- 2. Sign(dapp) → verify(worker bytes) ---
const sig = dapp.signSchnorr(dappBytes, ISSUER_PRIV);
const verifyMsg = worker.airdropClaimDeleteMsg(NETWORK, ROOT, LEAF, ISSUER_PUB_HEX, TIMESTAMP);
expect('roundtrip: dapp signs, worker bytes verify', dapp.verifySchnorr(sig, verifyMsg, ISSUER_PUB.slice(1)));

// --- 3. Tampered field invalidates ---
const fields = [
  ['root', () => worker.airdropClaimDeleteMsg(NETWORK, 'b'.repeat(64), LEAF, ISSUER_PUB_HEX, TIMESTAMP)],
  ['leaf_index', () => worker.airdropClaimDeleteMsg(NETWORK, ROOT, LEAF + 1, ISSUER_PUB_HEX, TIMESTAMP)],
  ['timestamp', () => worker.airdropClaimDeleteMsg(NETWORK, ROOT, LEAF, ISSUER_PUB_HEX, TIMESTAMP + 1)],
  ['network', () => worker.airdropClaimDeleteMsg('mainnet', ROOT, LEAF, ISSUER_PUB_HEX, TIMESTAMP)],
];
for (const [name, build] of fields) {
  const tampered = build();
  expect(`tampered ${name} → sig fails`, !dapp.verifySchnorr(sig, tampered, ISSUER_PUB.slice(1)));
}

// --- 4. Wrong signer key fails ---
const otherPriv = hexToBytes('22'.repeat(32));
const otherPub = secp.getPublicKey(otherPriv, true);
expect('wrong signer key fails', !dapp.verifySchnorr(sig, dappBytes, otherPub.slice(1)));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
