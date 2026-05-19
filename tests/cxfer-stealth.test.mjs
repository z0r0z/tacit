// Unit tests for the stealth integration in dapp/tacit.js.
//
// These tests run today against tests/stealth-dapp-patch.mjs (the
// pre-staged code). Once Task 19 inlines that module into dapp/
// tacit.js, the tests pass unchanged — same function signatures,
// same semantics.
//
// Coverage:
//   - bech32m tcs/tcsts/tcsrt address codec roundtrip
//   - blinding determinism + ECDH symmetry (sender + recipient agree)
//   - commit construction: commit = P + b·G and (sk+b)·G == commit
//   - per-vout_index disambiguation (multi-output, same recipient)
//   - cross-sender independence (different senders → different commits)
//   - self-payment edge case
//   - §A.2.5 input classifier + aggregation rules
//   - §F.7 multi-sender refusal (audit 2.1)
//   - mixer-derived input exclusion (audit 2.2)
//   - tx_anchor LE byte-order per §C (audit 3.6)
//   - locked-vector ECDH x-only serialization (audit 1.2)

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  SECP_N,
  STEALTH_HRP, DOMAIN_CXFER_STEALTH, STEALTH_DOMAIN_BY_OPCODE,
  MIXER_EMITTING_OPCODES,
  encodeStealthAddress, decodeStealthAddress,
  deriveStealthEcdhBlinding, computeStealthCommit, computeStealthTweakedSk,
  classifyInput, isStealthEligibleKind,
  aggregateStealthEligibleInputPubkeys, isMixerDerivedInput,
  checkStealthEmissionSafety,
  senderComputeStealthCommit, recipientScanTxForStealth,
  stealthTxAnchorHead,
  p2wpkhScript, p2trScript, xOnly,
} from './stealth-dapp-patch.mjs';

const G = secp.ProjectivePoint.BASE;

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); console.log(`✓ ${name}`); pass++; } catch (e) { console.error(`✗ ${name}: ${e.message}`); fail++; } };
const assert = (c, m = 'assertion failed') => { if (!c) throw new Error(m); };
const assertEq = (a, b, m = '') => {
  const sa = a instanceof Uint8Array ? bytesToHex(a) : String(a);
  const sb = b instanceof Uint8Array ? bytesToHex(b) : String(b);
  if (sa !== sb) throw new Error(`${m}: ${sa} !== ${sb}`);
};
const newKp = () => {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  let d = BigInt('0x' + bytesToHex(priv)) % SECP_N;
  if (d === 0n) d = 1n;
  let h = d.toString(16); while (h.length < 64) h = '0' + h;
  const fixed = hexToBytes(h);
  return { priv: fixed, pub: secp.getPublicKey(fixed, true) };
};

// =============================================================================
// Address codec
// =============================================================================

test('bech32m: single-mode roundtrip on signet', () => {
  const { pub } = newKp();
  const addr = encodeStealthAddress({ network: 'signet', recipientPub: pub });
  assert(addr.startsWith('tcsts1'));
  const d = decodeStealthAddress(addr);
  assertEq(d.network, 'signet');
  assertEq(d.mode, 'single');
  assertEq(d.recipientPub, pub);
});

test('bech32m: dual-mode roundtrip on mainnet', () => {
  const a = newKp(), b = newKp();
  const addr = encodeStealthAddress({ network: 'mainnet', scanPub: a.pub, spendPub: b.pub });
  assert(addr.startsWith('tcs1'));
  const d = decodeStealthAddress(addr);
  assertEq(d.network, 'mainnet');
  assertEq(d.mode, 'dual');
  assertEq(d.scanPub, a.pub);
  assertEq(d.spendPub, b.pub);
});

test('bech32m: HRPs match network', () => {
  assertEq(STEALTH_HRP.mainnet, 'tcs');
  assertEq(STEALTH_HRP.signet, 'tcsts');
  assertEq(STEALTH_HRP.regtest, 'tcsrt');
});

test('bech32m: tampered checksum rejected', () => {
  const { pub } = newKp();
  const addr = encodeStealthAddress({ network: 'signet', recipientPub: pub });
  const sep = addr.lastIndexOf('1');
  const tampered = addr.slice(0, sep + 5) + (addr[sep + 5] === 'q' ? 'p' : 'q') + addr.slice(sep + 6);
  let threw = false;
  try { decodeStealthAddress(tampered); } catch { threw = true; }
  assert(threw);
});

test('bech32m: malformed pubkey rejected', () => {
  const fakePub = new Uint8Array(33);
  let threw = false;
  try {
    const addr = encodeStealthAddress({ network: 'signet', recipientPub: fakePub });
    decodeStealthAddress(addr);
  } catch { threw = true; }
  assert(threw);
});

// =============================================================================
// Blinding + commit
// =============================================================================

test('ECDH blinding: symmetric (sender + recipient agree)', () => {
  const alice = newKp(), bob = newKp();
  const txAnchor = crypto.getRandomValues(new Uint8Array(40));
  const bSender = deriveStealthEcdhBlinding({
    ourPriv: bob.priv, theirPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  const bRecipient = deriveStealthEcdhBlinding({
    ourPriv: alice.priv, theirPub: bob.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  assertEq(bSender.toString(16), bRecipient.toString(16));
});

test('locked-vector: ECDH x-only serialization (audit 1.2)', () => {
  const alice = { priv: hexToBytes('00'.repeat(31) + '01') };
  alice.pub = secp.getPublicKey(alice.priv, true);
  const bob = { priv: hexToBytes('00'.repeat(31) + '02') };
  bob.pub = secp.getPublicKey(bob.priv, true);
  const txAnchor = hexToBytes('00'.repeat(35) + 'ff' + '00'.repeat(4));
  const bSender = deriveStealthEcdhBlinding({
    ourPriv: bob.priv, theirPub: alice.pub,
    networkTag: 'mainnet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  // Verify x-only path explicitly.
  const sharedPt = secp.ProjectivePoint.fromHex(bytesToHex(alice.pub))
    .multiply(BigInt('0x' + bytesToHex(bob.priv)));
  const xOnlyForm = sha256(sharedPt.toRawBytes(true).slice(1));
  const compressedForm = sha256(sharedPt.toRawBytes(true));
  assert(bytesToHex(xOnlyForm) !== bytesToHex(compressedForm), 'sanity: forms differ');
  const macXonly = hmac(sha256, xOnlyForm, concatBytes(
    DOMAIN_CXFER_STEALTH, new Uint8Array([0x00]), txAnchor,
  ));
  const bXonly = BigInt('0x' + bytesToHex(macXonly)) % SECP_N;
  assertEq(bSender.toString(16), bXonly.toString(16),
    'deriveStealthEcdhBlinding MUST use x-only (§A.2 NORMATIVE)');
});

test('commit: commit = P + b·G', () => {
  const { pub } = newKp();
  const b = 12345n;
  const commit = computeStealthCommit({ underlyingPub: pub, blinding: b });
  const expected = secp.ProjectivePoint.fromHex(bytesToHex(pub))
    .add(G.multiply(b)).toRawBytes(true);
  assertEq(commit, expected);
});

test('commit + tweaked_sk: (sk + b)·G == commit', () => {
  const { priv, pub } = newKp();
  const b = 99999n;
  const commit = computeStealthCommit({ underlyingPub: pub, blinding: b });
  const tweakedSk = computeStealthTweakedSk({ underlyingPriv: priv, blinding: b });
  const tweakedPub = secp.getPublicKey(tweakedSk, true);
  assertEq(tweakedPub, commit);
});

// =============================================================================
// Per-vout_index disambiguation + cross-sender
// =============================================================================

test('per-vout_index: multi-output to same recipient → distinct commits', () => {
  const alice = newKp(), bob = newKp();
  const anchor = stealthTxAnchorHead(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), 0);
  const c0 = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv], recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchor, voutIndex: 0,
  });
  const c1 = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv], recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchor, voutIndex: 1,
  });
  assert(bytesToHex(c0.commit) !== bytesToHex(c1.commit),
    'distinct vout_index MUST yield distinct commits');
});

test('cross-sender: different senders → different commits for same recipient', () => {
  const alice = newKp(), bob = newKp(), carol = newKp();
  const anchor = stealthTxAnchorHead(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), 0);
  const cBob = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv], recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchor, voutIndex: 0,
  });
  const cCarol = senderComputeStealthCommit({
    senderEligibleInputPrivs: [carol.priv], recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchor, voutIndex: 0,
  });
  assert(bytesToHex(cBob.commit) !== bytesToHex(cCarol.commit));
});

test('self-payment: sender = recipient produces valid scannable commit', () => {
  const alice = newKp();
  const anchor = stealthTxAnchorHead(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), 0);
  const { commit } = senderComputeStealthCommit({
    senderEligibleInputPrivs: [alice.priv], recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchor, voutIndex: 0,
  });
  // Alice's scanner with classified input descriptors:
  const credits = recipientScanTxForStealth({
    classifiedInputs: [{ kind: 'p2wpkh', pub: alice.pub }],
    outputs: [{ script: p2wpkhScript(commit) }],
    walletPriv: alice.priv, walletPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchorHead: anchor,
  });
  assertEq(credits.length, 1);
});

// =============================================================================
// Input classifier (§A.2.5)
// =============================================================================

test('classifyInput: P2WPKH detected', () => {
  const { pub } = newKp();
  const sig = crypto.getRandomValues(new Uint8Array(71));
  const r = classifyInput({
    witness: [sig, pub],
    prevoutScript: concatBytes(new Uint8Array([0x00, 0x14]), crypto.getRandomValues(new Uint8Array(20))),
  });
  assertEq(r.kind, 'p2wpkh');
  assertEq(r.pub, pub);
});

test('classifyInput: P2WSH excluded', () => {
  const r = classifyInput({
    witness: [crypto.getRandomValues(new Uint8Array(50))],
    prevoutScript: concatBytes(new Uint8Array([0x00, 0x20]), crypto.getRandomValues(new Uint8Array(32))),
  });
  assertEq(r.kind, 'p2wsh');
  assert(r.pub === null);
});

test('isStealthEligibleKind classification', () => {
  assert(isStealthEligibleKind('p2wpkh'));
  assert(isStealthEligibleKind('p2tr-keypath'));
  assert(isStealthEligibleKind('tacit-envelope'));
  assert(!isStealthEligibleKind('p2wsh'));
  assert(!isStealthEligibleKind('p2tr-scriptpath'));
  assert(!isStealthEligibleKind('mixer-derived'));
});

// =============================================================================
// Aggregation
// =============================================================================

test('aggregate: P_sender = sum over eligible inputs', () => {
  const a = newKp(), b = newKp();
  const { aggregatePub, eligibleCount } = aggregateStealthEligibleInputPubkeys([
    { kind: 'p2wpkh', pub: a.pub },
    { kind: 'p2tr-keypath', pub: b.pub },
  ]);
  assertEq(eligibleCount, 2);
  const expected = secp.ProjectivePoint.fromHex(bytesToHex(a.pub))
    .add(secp.ProjectivePoint.fromHex(bytesToHex(b.pub)))
    .toRawBytes(true);
  assertEq(aggregatePub, expected);
});

test('aggregate: ineligible inputs filtered', () => {
  const a = newKp(), b = newKp();
  const { aggregatePub, eligibleCount } = aggregateStealthEligibleInputPubkeys([
    { kind: 'p2wpkh', pub: a.pub },
    { kind: 'p2wsh', pub: b.pub },
  ]);
  assertEq(eligibleCount, 1);
  assertEq(aggregatePub, a.pub);
});

test('aggregate: all ineligible → null', () => {
  const a = newKp(), b = newKp();
  const { aggregatePub, eligibleCount } = aggregateStealthEligibleInputPubkeys([
    { kind: 'p2wsh', pub: a.pub },
    { kind: 'p2tr-scriptpath', pub: b.pub },
  ]);
  assertEq(eligibleCount, 0);
  assert(aggregatePub === null);
});

// =============================================================================
// §F.7 refusal (audit 2.1)
// =============================================================================

test('§F.7 refusal: mixed-ownership eligible inputs MUST be refused', () => {
  const us = newKp(), them = newKp();
  const r = checkStealthEmissionSafety({
    inputs: [
      { kind: 'p2wpkh', pub: us.pub, ours: true },
      { kind: 'p2wpkh', pub: them.pub, ours: false },
    ],
    eachInputIsOurs: (inp) => inp.ours === true,
  });
  assert(!r.safe);
  assert(r.reason.includes('not wallet-owned'));
});

test('§F.7 refusal: all-wallet-owned eligible inputs is safe', () => {
  const a = newKp(), b = newKp();
  const r = checkStealthEmissionSafety({
    inputs: [
      { kind: 'p2wpkh', pub: a.pub, ours: true },
      { kind: 'p2tr-keypath', pub: b.pub, ours: true },
    ],
    eachInputIsOurs: (inp) => inp.ours === true,
  });
  assert(r.safe);
});

test('§F.7 refusal: ineligible inputs do not affect safety', () => {
  const ours = newKp(), foreign = newKp();
  const r = checkStealthEmissionSafety({
    inputs: [
      { kind: 'p2wpkh', pub: ours.pub, ours: true },
      { kind: 'p2wsh', pub: foreign.pub, ours: false },  // ineligible → ignored
    ],
    eachInputIsOurs: (inp) => inp.ours === true,
  });
  assert(r.safe);
});

// =============================================================================
// §A.2.5 rule 6 mixer-derived (audit 2.2)
// =============================================================================

test('mixer classifier: T_WITHDRAW prevout is mixer-derived', () => {
  const payload = new Uint8Array([0x2A, ...crypto.getRandomValues(new Uint8Array(40))]);
  const opReturnScript = new Uint8Array([0x6a, payload.length, ...payload]);
  assert(isMixerDerivedInput({
    prevoutTx: { outputs: [{ script: opReturnScript }] },
    prevoutVout: 0,
  }));
});

test('mixer classifier: T_SLOT_BURN prevout is mixer-derived', () => {
  const payload = new Uint8Array([0x44, ...crypto.getRandomValues(new Uint8Array(40))]);
  assert(isMixerDerivedInput({
    prevoutTx: { outputs: [{ script: new Uint8Array([0x6a, payload.length, ...payload]) }] },
    prevoutVout: 0,
  }));
});

test('mixer classifier: T_CXFER (non-mixer) prevout NOT mixer-derived', () => {
  const payload = new Uint8Array([0x23, ...crypto.getRandomValues(new Uint8Array(40))]);
  assert(!isMixerDerivedInput({
    prevoutTx: { outputs: [{ script: new Uint8Array([0x6a, payload.length, ...payload]) }] },
    prevoutVout: 0,
  }));
});

test('MIXER_EMITTING_OPCODES registry', () => {
  assert(MIXER_EMITTING_OPCODES.has(0x2A));
  assert(MIXER_EMITTING_OPCODES.has(0x44));
  assert(!MIXER_EMITTING_OPCODES.has(0x23));
  assert(!MIXER_EMITTING_OPCODES.has(0x26));
});

// =============================================================================
// Domain dispatch registry (§D.2)
// =============================================================================

test('STEALTH_DOMAIN_BY_OPCODE: CXFER opcodes map to DOMAIN_CXFER_STEALTH', () => {
  assertEq(STEALTH_DOMAIN_BY_OPCODE.get(0x23), DOMAIN_CXFER_STEALTH);
  assertEq(STEALTH_DOMAIN_BY_OPCODE.get(0x22), DOMAIN_CXFER_STEALTH);  // BPP twin
});

test('STEALTH_DOMAIN_BY_OPCODE: AXFER family maps to AXFER tag', () => {
  const dAxfer = STEALTH_DOMAIN_BY_OPCODE.get(0x26);
  const dAxferVar = STEALTH_DOMAIN_BY_OPCODE.get(0x37);
  assert(dAxfer);
  assert(dAxferVar);
  // Distinct domains for distinct opcode families.
  assert(bytesToHex(dAxfer) !== bytesToHex(dAxferVar));
});

// =============================================================================
// tx_anchor byte order (§C / audit 3.6)
// =============================================================================

test('tx_anchor head: txid bytes in LE wire order', () => {
  // Take a known txid hex and verify the anchor reverses it.
  const txidHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const anchor = stealthTxAnchorHead(txidHex, 0);
  // First 32 bytes should be reversed.
  const expected = hexToBytes('efcdab8967452301efcdab8967452301efcdab8967452301efcdab8967452301');
  assertEq(anchor.slice(0, 32), expected, 'txid bytes MUST be little-endian wire order');
  // Last 4 bytes: vout in LE
  assertEq(anchor.slice(32, 36), new Uint8Array([0, 0, 0, 0]));
});

test('tx_anchor head: vout LE encoding', () => {
  const txidHex = '00'.repeat(32);
  const anchor = stealthTxAnchorHead(txidHex, 0x01020304);
  assertEq(anchor.slice(32), new Uint8Array([0x04, 0x03, 0x02, 0x01]));
});

// =============================================================================
// End-to-end roundtrip
// =============================================================================

test('e2e: sender → recipient via dapp-patch helpers', () => {
  const alice = newKp(), bob = newKp();
  const addr = encodeStealthAddress({ network: 'signet', recipientPub: alice.pub });
  const decoded = decodeStealthAddress(addr);
  const anchor = stealthTxAnchorHead(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), 0);

  const { commit } = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv],
    recipientPub: decoded.recipientPub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchor, voutIndex: 0,
  });

  const credits = recipientScanTxForStealth({
    classifiedInputs: [{ kind: 'p2wpkh', pub: bob.pub }],
    outputs: [{ script: p2wpkhScript(commit) }],
    walletPriv: alice.priv, walletPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchorHead: anchor,
  });
  assertEq(credits.length, 1);
  // Verify tweaked_sk recovers correctly.
  const recoveredPub = secp.getPublicKey(credits[0].tweakedSk, true);
  assertEq(recoveredPub, commit);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
