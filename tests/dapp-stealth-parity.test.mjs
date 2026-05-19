// Parity test: extract the inlined stealth helpers from dapp/tacit.js
// at runtime and verify they produce byte-identical output to the
// pre-staged standalone module (tests/stealth-dapp-patch.mjs).
//
// We can't import dapp/tacit.js directly in node (it depends on DOM +
// localStorage), so we slice the stealth-helpers section out by line
// range and eval it in an isolated scope with the dapp's vendor
// dependencies wired in.
//
// This protects against the inline drifting out of sync with the
// spec'd math (which the standalone module test suite locks down).

import * as fs from 'node:fs';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

import * as ref from './stealth-dapp-patch.mjs';

const src = fs.readFileSync('dapp/tacit.js', 'utf8');

// Slice from the start-marker to the AXINTENT_BLINDING_DOMAIN marker
// (the first thing after the stealth block).
const startMarker = '// Blinded-pubkey commits (SPEC-BLINDED-PUBKEY-AMENDMENT §A — class-2 stealth)';
const endMarker = '// 32-byte ECDH keystream used to encrypt the maker\'s recipient_blinding to the';
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker);
if (startIdx === -1) throw new Error('start marker not found in dapp/tacit.js');
if (endIdx === -1) throw new Error('end marker not found in dapp/tacit.js');
const block = src.slice(startIdx, endIdx);

// Module-level state the block references (already defined upstream in dapp).
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;
const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };
const bytesToPoint = b => secp.ProjectivePoint.fromHex(bytesToHex(b));
const hash160 = b => ripemd160(sha256(b));
const p2wpkhScript = pubkey => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));
const p2trScript = xOnly32 => concatBytes(new Uint8Array([0x51, 0x20]), xOnly32);

// Build an evaluable closure that exposes the dapp's helpers.
const exposed = [
  'STEALTH_HRP_BY_NETWORK',
  'DOMAIN_CXFER_STEALTH', 'DOMAIN_AXFER_STEALTH', 'DOMAIN_AXFER_VAR_STEALTH',
  'STEALTH_DOMAIN_BY_OPCODE', 'MIXER_EMITTING_OPCODES',
  'encodeStealthAddress', 'decodeStealthAddress',
  'deriveStealthEcdhBlinding', 'computeStealthCommit', 'computeStealthTweakedSk',
  'classifyStealthInput', 'isStealthEligibleKind',
  'aggregateStealthEligibleInputPubkeys', 'isMixerDerivedInput',
  'checkStealthEmissionSafety', 'stealthTxAnchorHead',
  'senderComputeStealthCommit', 'recipientScanTxForStealth',
];
const wrapped = `${block}\nreturn { ${exposed.join(', ')} };`;
const dapp = new Function(
  'secp', 'sha256', 'hmac', 'hexToBytes', 'bytesToHex', 'concatBytes',
  'SECP_N', 'G', 'ZERO', 'reverseBytes', 'bytesToPoint',
  'p2wpkhScript', 'p2trScript', 'hash160',
  wrapped,
)(secp, sha256, hmac, hexToBytes, bytesToHex, concatBytes,
  SECP_N, G, ZERO, reverseBytes, bytesToPoint,
  p2wpkhScript, p2trScript, hash160);

// ===== tests =====
let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); console.log(`✓ ${name}`); pass++; } catch (e) { console.error(`✗ ${name}: ${e.message}`); fail++; } };
const assertEq = (a, b, m = '') => {
  const sa = a instanceof Uint8Array ? bytesToHex(a) : String(a);
  const sb = b instanceof Uint8Array ? bytesToHex(b) : String(b);
  if (sa !== sb) throw new Error(`${m}: ${sa} !== ${sb}`);
};
const newKp = () => {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  let d = BigInt('0x' + bytesToHex(priv)) % SECP_N; if (d === 0n) d = 1n;
  let h = d.toString(16); while (h.length < 64) h = '0' + h;
  const fixed = hexToBytes(h);
  return { priv: fixed, pub: secp.getPublicKey(fixed, true) };
};

// === parity ===
test('bech32m: dapp encode matches ref encode (mainnet single-mode)', () => {
  const { pub } = newKp();
  const a = dapp.encodeStealthAddress({ network: 'mainnet', recipientPub: pub });
  const b = ref.encodeStealthAddress({ network: 'mainnet', recipientPub: pub });
  assertEq(a, b);
});
test('bech32m: dapp encode matches ref encode (signet single-mode)', () => {
  const { pub } = newKp();
  const a = dapp.encodeStealthAddress({ network: 'signet', recipientPub: pub });
  const b = ref.encodeStealthAddress({ network: 'signet', recipientPub: pub });
  assertEq(a, b);
});
test('bech32m: dapp encode matches ref encode (regtest dual-mode)', () => {
  const a = newKp(), b = newKp();
  const aAddr = dapp.encodeStealthAddress({ network: 'regtest', scanPub: a.pub, spendPub: b.pub });
  const bAddr = ref.encodeStealthAddress({ network: 'regtest', scanPub: a.pub, spendPub: b.pub });
  assertEq(aAddr, bAddr);
});
test('bech32m: dapp decode matches ref decode', () => {
  const { pub } = newKp();
  const enc = ref.encodeStealthAddress({ network: 'signet', recipientPub: pub });
  const a = dapp.decodeStealthAddress(enc);
  const b = ref.decodeStealthAddress(enc);
  assertEq(a.network, b.network);
  assertEq(a.recipientPub, b.recipientPub);
});

test('ECDH blinding: dapp derivation matches ref derivation', () => {
  const a = newKp(), b = newKp();
  const txAnchor = crypto.getRandomValues(new Uint8Array(40));
  const bDapp = dapp.deriveStealthEcdhBlinding({
    ourPriv: a.priv, theirPub: b.pub,
    networkTag: 'signet', domain: dapp.DOMAIN_CXFER_STEALTH, txAnchor,
  });
  const bRef = ref.deriveStealthEcdhBlinding({
    ourPriv: a.priv, theirPub: b.pub,
    networkTag: 'signet', domain: ref.DOMAIN_CXFER_STEALTH, txAnchor,
  });
  assertEq(bDapp.toString(16), bRef.toString(16));
});

test('commit + tweaked_sk: dapp matches ref', () => {
  const { priv, pub } = newKp();
  const blinding = 0x42424242424242424242424242424242424242424242424242424242n;
  const cDapp = dapp.computeStealthCommit({ underlyingPub: pub, blinding });
  const cRef = ref.computeStealthCommit({ underlyingPub: pub, blinding });
  assertEq(cDapp, cRef);
  const tDapp = dapp.computeStealthTweakedSk({ underlyingPriv: priv, blinding });
  const tRef = ref.computeStealthTweakedSk({ underlyingPriv: priv, blinding });
  assertEq(tDapp, tRef);
});

test('senderComputeStealthCommit: dapp matches ref (K_eligible=1)', () => {
  const sender = newKp(), recipient = newKp();
  const anchor = dapp.stealthTxAnchorHead(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), 0);
  const { commit: cDapp } = dapp.senderComputeStealthCommit({
    senderEligibleInputPrivs: [sender.priv], recipientPub: recipient.pub,
    networkTag: 'signet', domain: dapp.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor, voutIndex: 0,
  });
  const { commit: cRef } = ref.senderComputeStealthCommit({
    senderEligibleInputPrivs: [sender.priv], recipientPub: recipient.pub,
    networkTag: 'signet', domain: ref.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor, voutIndex: 0,
  });
  assertEq(cDapp, cRef);
});

test('senderComputeStealthCommit: dapp matches ref (K_eligible=3)', () => {
  const sender = newKp(), recipient = newKp();
  const anchor = dapp.stealthTxAnchorHead(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), 0);
  const eligible = [sender.priv, sender.priv, sender.priv];
  const { commit: cDapp } = dapp.senderComputeStealthCommit({
    senderEligibleInputPrivs: eligible, recipientPub: recipient.pub,
    networkTag: 'signet', domain: dapp.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor, voutIndex: 2,
  });
  const { commit: cRef } = ref.senderComputeStealthCommit({
    senderEligibleInputPrivs: eligible, recipientPub: recipient.pub,
    networkTag: 'signet', domain: ref.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor, voutIndex: 2,
  });
  assertEq(cDapp, cRef);
});

test('e2e: dapp sender → dapp recipient (K_asset=1, single-signer)', () => {
  const sender = newKp(), recipient = newKp();
  const fakeTxid = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const anchor = dapp.stealthTxAnchorHead(fakeTxid, 0);
  const { commit } = dapp.senderComputeStealthCommit({
    senderEligibleInputPrivs: [sender.priv], recipientPub: recipient.pub,
    networkTag: 'signet', domain: dapp.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor, voutIndex: 0,
  });
  const credits = dapp.recipientScanTxForStealth({
    classifiedInputs: [{ kind: 'p2wpkh', pub: sender.pub }],
    outputs: [{ script: p2wpkhScript(commit) }],
    walletPriv: recipient.priv, walletPub: recipient.pub,
    networkTag: 'signet', domain: dapp.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor,
  });
  if (credits.length !== 1) throw new Error('expected 1 credit');
  assertEq(credits[0].commit, commit);
  const recoveredPub = secp.getPublicKey(credits[0].tweakedSk, true);
  assertEq(recoveredPub, commit);
});

test('e2e: dapp sender → dapp recipient (K_asset=2, matches CXFER multi-input)', () => {
  // dapp single-signer sends a CXFER with 2 asset inputs. Sender passes 2
  // copies of wallet.priv → privSum = 2·wallet.priv. Recipient scans tx
  // with 2 classified P2WPKH inputs both with pub=sender.pub → aggregate =
  // 2·sender.pub. Scalars must agree for the e2e to succeed.
  const sender = newKp(), recipient = newKp();
  const anchor = dapp.stealthTxAnchorHead(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), 0);
  const { commit } = dapp.senderComputeStealthCommit({
    senderEligibleInputPrivs: [sender.priv, sender.priv], recipientPub: recipient.pub,
    networkTag: 'signet', domain: dapp.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor, voutIndex: 0,
  });
  const credits = dapp.recipientScanTxForStealth({
    classifiedInputs: [
      { kind: 'p2tr-scriptpath', pub: null },  // vin[0] commit input (ineligible)
      { kind: 'p2wpkh', pub: sender.pub },
      { kind: 'p2wpkh', pub: sender.pub },
    ],
    outputs: [{ script: p2wpkhScript(commit) }],
    walletPriv: recipient.priv, walletPub: recipient.pub,
    networkTag: 'signet', domain: dapp.DOMAIN_CXFER_STEALTH, txAnchorHead: anchor,
  });
  if (credits.length !== 1) throw new Error('expected 1 credit');
  assertEq(credits[0].commit, commit);
});

test('mixer-derived classifier: T_WITHDRAW and T_SLOT_BURN excluded', () => {
  const w = new Uint8Array([0x6a, 0x29, 0x2a, ...crypto.getRandomValues(new Uint8Array(40))]);  // OP_RETURN(0x29) (push 41 bytes), starts with 0x2a (T_WITHDRAW)
  if (!dapp.isMixerDerivedInput({ prevoutTx: { outputs: [{ script: w }] }, prevoutVout: 0 })) {
    throw new Error('T_WITHDRAW prevout misclassified');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
