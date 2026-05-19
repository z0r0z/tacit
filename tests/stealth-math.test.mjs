// Unit tests for the blinded-pubkey commit primitives in
// tests/stealth-primitives.mjs. Pure math — no chain, no network.
//
// Verifies:
//   - bech32m address encode/decode roundtrip + tamper rejection
//   - Self-derived blinding determinism
//   - ECDH-derived blinding symmetry (sender + recipient land on same b)
//   - Commit construction: commit = P + b·G
//   - Tweaked-sk: (sk + b) · G = commit
//   - Per-vout_index anchor produces distinct commits in same tx
//   - Cross-sender same-recipient produces distinct commits
//   - aggregateEligibleInputPubkeys eligibility rules
//   - matchesCommit P2WPKH + P2TR shapes
//   - End-to-end sender-side senderComputeStealthCommit + recipient-side
//     recipientCheckOutputForStealth roundtrip

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  SECP_N,
  STEALTH_HRP,
  encodeStealthAddress, decodeStealthAddress,
  deriveSelfBlinding, deriveEcdhBlinding,
  computeCommit, computeTweakedSk,
  matchesCommit, p2wpkhScript, p2trScript, xOnly,
  aggregateEligibleInputPubkeys, isEligibleKind,
  checkStealthEmissionSafety,
  isMixerDerivedInput, MIXER_EMITTING_OPCODES,
  senderComputeStealthCommit, recipientCheckOutputForStealth,
  recipientScanTxForStealth,
  DOMAIN_CXFER_STEALTH,
} from './stealth-primitives.mjs';

const G = secp.ProjectivePoint.BASE;

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`✓ ${name}`); pass++; }
  catch (e) { console.error(`✗ ${name}: ${e.message}`); fail++; }
};
const assert = (cond, msg = 'assertion failed') => { if (!cond) throw new Error(msg); };
const assertEq = (a, b, msg = '') => {
  const sa = a instanceof Uint8Array ? bytesToHex(a) : String(a);
  const sb = b instanceof Uint8Array ? bytesToHex(b) : String(b);
  if (sa !== sb) throw new Error(`${msg}: ${sa} !== ${sb}`);
};
const newKeypair = () => {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  // Ensure scalar in valid range
  let d = BigInt('0x' + bytesToHex(priv)) % SECP_N;
  if (d === 0n) d = 1n;
  let hex = d.toString(16); while (hex.length < 64) hex = '0' + hex;
  const fixed = hexToBytes(hex);
  return { priv: fixed, pub: secp.getPublicKey(fixed, true) };
};

// =============================================================================
//                         Address codec tests
// =============================================================================

test('bech32m address: single-mode roundtrip on signet', () => {
  const { pub } = newKeypair();
  const addr = encodeStealthAddress({ network: 'signet', recipientPub: pub });
  assert(addr.startsWith('tcsts1'), `expected tcsts prefix, got ${addr}`);
  const dec = decodeStealthAddress(addr);
  assertEq(dec.network, 'signet');
  assertEq(dec.mode, 'single');
  assertEq(dec.recipientPub, pub);
});

test('bech32m address: dual-mode roundtrip on mainnet', () => {
  const a = newKeypair(), b = newKeypair();
  const addr = encodeStealthAddress({
    network: 'mainnet', scanPub: a.pub, spendPub: b.pub,
  });
  assert(addr.startsWith('tcs1'), `expected tcs prefix, got ${addr}`);
  const dec = decodeStealthAddress(addr);
  assertEq(dec.network, 'mainnet');
  assertEq(dec.mode, 'dual');
  assertEq(dec.scanPub, a.pub);
  assertEq(dec.spendPub, b.pub);
});

test('bech32m address: HRPs match network', () => {
  assertEq(STEALTH_HRP.mainnet, 'tcs');
  assertEq(STEALTH_HRP.signet, 'tcsts');
  assertEq(STEALTH_HRP.regtest, 'tcsrt');
});

test('bech32m address: classical segwit HRPs rejected', () => {
  // Construct a payload that looks valid but uses a Bitcoin segwit HRP.
  let threw = false;
  try {
    decodeStealthAddress('bc1q....'); // garbage but with non-tacit HRP
  } catch (e) { threw = true; }
  assert(threw, 'should reject non-stealth HRP or bad data');
});

test('bech32m address: tampered checksum rejected', () => {
  const { pub } = newKeypair();
  const addr = encodeStealthAddress({ network: 'signet', recipientPub: pub });
  // Flip a character in the data portion (not the HRP).
  const sepIdx = addr.lastIndexOf('1');
  const ch = addr[sepIdx + 5];
  const otherCh = ch === 'q' ? 'p' : 'q';
  const tampered = addr.slice(0, sepIdx + 5) + otherCh + addr.slice(sepIdx + 6);
  let threw = false;
  try { decodeStealthAddress(tampered); } catch (e) { threw = true; }
  assert(threw, 'should reject tampered address');
});

test('bech32m address: malformed pubkey rejected', () => {
  // Encode an address whose 33-byte payload is not a valid curve point.
  // Use the helper's bypass — we want to test the decoder's curve check.
  // Construct a "pubkey" that's all zeros (point at infinity-ish, invalid for compressed).
  const fakePub = new Uint8Array(33); // all-zero — invalid compressed point
  let threw = false;
  try {
    const addr = encodeStealthAddress({ network: 'signet', recipientPub: fakePub });
    decodeStealthAddress(addr);
  } catch (e) { threw = true; }
  assert(threw, 'should reject all-zero pubkey');
});

// =============================================================================
//                       Blinding derivation tests
// =============================================================================

test('self-derived blinding: determinism', () => {
  const { priv } = newKeypair();
  const anchor = sha256(new TextEncoder().encode('test-anchor'));
  const b1 = deriveSelfBlinding({
    walletPriv: priv, networkTag: 'signet',
    domain: DOMAIN_CXFER_STEALTH, anchor,
  });
  const b2 = deriveSelfBlinding({
    walletPriv: priv, networkTag: 'signet',
    domain: DOMAIN_CXFER_STEALTH, anchor,
  });
  assertEq(b1.toString(16), b2.toString(16));
});

test('self-derived blinding: different anchors → different b', () => {
  const { priv } = newKeypair();
  const a1 = sha256(new TextEncoder().encode('anchor-1'));
  const a2 = sha256(new TextEncoder().encode('anchor-2'));
  const b1 = deriveSelfBlinding({
    walletPriv: priv, networkTag: 'signet',
    domain: DOMAIN_CXFER_STEALTH, anchor: a1,
  });
  const b2 = deriveSelfBlinding({
    walletPriv: priv, networkTag: 'signet',
    domain: DOMAIN_CXFER_STEALTH, anchor: a2,
  });
  assert(b1 !== b2, 'different anchors must yield different blindings');
});

test('ECDH-derived blinding: symmetric (sender & recipient land on same b)', () => {
  const alice = newKeypair();  // recipient
  const bob   = newKeypair();  // sender
  const txAnchor = crypto.getRandomValues(new Uint8Array(40)); // tx_anchor_head + vout
  // Sender side: ECDH(bob.priv, alice.pub)
  const bSender = deriveEcdhBlinding({
    ourPriv: bob.priv, theirPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  // Recipient side: ECDH(alice.priv, bob.pub)
  const bRecipient = deriveEcdhBlinding({
    ourPriv: alice.priv, theirPub: bob.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  assertEq(bSender.toString(16), bRecipient.toString(16),
    'ECDH symmetry: sender and recipient must derive the same b');
});

test('ECDH-derived blinding: different tx_anchor → different b', () => {
  const alice = newKeypair();
  const bob = newKeypair();
  const a1 = crypto.getRandomValues(new Uint8Array(40));
  const a2 = crypto.getRandomValues(new Uint8Array(40));
  const b1 = deriveEcdhBlinding({
    ourPriv: bob.priv, theirPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor: a1,
  });
  const b2 = deriveEcdhBlinding({
    ourPriv: bob.priv, theirPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor: a2,
  });
  assert(b1 !== b2, 'different tx_anchors must yield different blindings');
});

test('ECDH-derived blinding: different senders → different b for same recipient + anchor', () => {
  const alice = newKeypair();
  const bob = newKeypair();
  const carol = newKeypair();
  const txAnchor = crypto.getRandomValues(new Uint8Array(40));
  const bFromBob = deriveEcdhBlinding({
    ourPriv: bob.priv, theirPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  const bFromCarol = deriveEcdhBlinding({
    ourPriv: carol.priv, theirPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  assert(bFromBob !== bFromCarol, 'different senders must yield different blindings');
});

// =============================================================================
//                       Commit construction tests
// =============================================================================

test('commit construction: commit = P + b·G', () => {
  const { pub } = newKeypair();
  const b = 12345n;
  const commit = computeCommit({ underlyingPub: pub, blinding: b });
  // Verify manually: commit point should equal P + b·G
  const Pt = secp.ProjectivePoint.fromHex(bytesToHex(pub));
  const expected = Pt.add(G.multiply(b)).toRawBytes(true);
  assertEq(commit, expected);
});

test('commit + tweaked_sk: (sk + b)·G = commit', () => {
  const { priv, pub } = newKeypair();
  const b = 99999n;
  const commit = computeCommit({ underlyingPub: pub, blinding: b });
  const tweakedSk = computeTweakedSk({ underlyingPriv: priv, blinding: b });
  const tweakedPub = secp.getPublicKey(tweakedSk, true);
  assertEq(tweakedPub, commit,
    'tweaked_sk · G must equal commit (so signer with tweaked_sk can spend commit-derived output)');
});

test('commit: different blindings → different commits for same pubkey', () => {
  const { pub } = newKeypair();
  const c1 = computeCommit({ underlyingPub: pub, blinding: 100n });
  const c2 = computeCommit({ underlyingPub: pub, blinding: 200n });
  assert(bytesToHex(c1) !== bytesToHex(c2), 'distinct blindings must yield distinct commits');
});

// =============================================================================
//                       Output-script matching tests
// =============================================================================

test('matchesCommit: P2WPKH hit', () => {
  const { pub } = newKeypair();
  const commit = computeCommit({ underlyingPub: pub, blinding: 42n });
  const script = p2wpkhScript(commit);
  const r = matchesCommit({ outputScript: script, commit33: commit });
  assert(r.match);
  assertEq(r.scriptKind, 'p2wpkh');
});

test('matchesCommit: P2TR hit', () => {
  const { pub } = newKeypair();
  const commit = computeCommit({ underlyingPub: pub, blinding: 42n });
  const script = p2trScript(xOnly(commit));
  const r = matchesCommit({ outputScript: script, commit33: commit });
  assert(r.match);
  assertEq(r.scriptKind, 'p2tr');
});

test('matchesCommit: no match for unrelated script', () => {
  const { pub } = newKeypair();
  const commit = computeCommit({ underlyingPub: pub, blinding: 42n });
  const wrongScript = p2wpkhScript(crypto.getRandomValues(new Uint8Array(33)));
  // Actually this might collide on the curve check; better use a script with a different hash.
  const unrelatedHash = crypto.getRandomValues(new Uint8Array(20));
  const unrelatedScript = concatBytes(new Uint8Array([0x00, 0x14]), unrelatedHash);
  const r = matchesCommit({ outputScript: unrelatedScript, commit33: commit });
  assert(!r.match);
});

// =============================================================================
//                       Aggregation rule tests (§A.2.5)
// =============================================================================

test('aggregate: P2WPKH + P2TR-keypath both eligible', () => {
  const a = newKeypair(), b = newKeypair();
  const { aggregatePub, eligibleCount } = aggregateEligibleInputPubkeys([
    { kind: 'p2wpkh', pub: a.pub },
    { kind: 'p2tr-keypath', pub: b.pub },
  ]);
  assertEq(eligibleCount, 2);
  // Verify: aggregate = a.pub + b.pub
  const expected = secp.ProjectivePoint.fromHex(bytesToHex(a.pub))
    .add(secp.ProjectivePoint.fromHex(bytesToHex(b.pub)))
    .toRawBytes(true);
  assertEq(aggregatePub, expected);
});

test('aggregate: P2WSH excluded', () => {
  const a = newKeypair(), b = newKeypair();
  const { aggregatePub, eligibleCount } = aggregateEligibleInputPubkeys([
    { kind: 'p2wpkh', pub: a.pub },
    { kind: 'p2wsh', pub: b.pub },  // excluded
  ]);
  assertEq(eligibleCount, 1);
  assertEq(aggregatePub, a.pub, 'only the P2WPKH input contributes');
});

test('aggregate: all ineligible → null', () => {
  const a = newKeypair(), b = newKeypair();
  const { aggregatePub, eligibleCount } = aggregateEligibleInputPubkeys([
    { kind: 'p2wsh', pub: a.pub },
    { kind: 'p2tr-scriptpath', pub: b.pub },
  ]);
  assertEq(eligibleCount, 0);
  assert(aggregatePub === null, 'no eligible inputs → null aggregate');
});

test('aggregate: tacit-envelope eligible', () => {
  const a = newKeypair();
  const { aggregatePub, eligibleCount } = aggregateEligibleInputPubkeys([
    { kind: 'tacit-envelope', pub: a.pub },
  ]);
  assertEq(eligibleCount, 1);
  assertEq(aggregatePub, a.pub);
});

test('isEligibleKind classification', () => {
  assert(isEligibleKind('p2wpkh'));
  assert(isEligibleKind('p2tr-keypath'));
  assert(isEligibleKind('tacit-envelope'));
  assert(!isEligibleKind('p2wsh'));
  assert(!isEligibleKind('p2tr-scriptpath'));
  assert(!isEligibleKind('unknown'));
});

// =============================================================================
//             End-to-end: sender computes, recipient detects + spends
// =============================================================================

test('e2e: sender→recipient round-trip (single eligible input, P2WPKH output)', () => {
  // Setup: Alice (recipient) publishes a stealth address; Bob (sender)
  // sends a payment. Verify Alice's scanner finds the receipt and that
  // the tweaked_sk corresponds to the commit pubkey.
  const alice = newKeypair();
  const bob = newKeypair();
  const aliceAddr = encodeStealthAddress({ network: 'signet', recipientPub: alice.pub });
  const decoded = decodeStealthAddress(aliceAddr);
  assertEq(decoded.recipientPub, alice.pub);

  // Sender computes commit using Bob's input priv + Alice's published pub.
  const txAnchorHead = crypto.getRandomValues(new Uint8Array(36));
  const voutIndex = 1; // dust output at vout[1]
  const { commit, blinding: bSender } = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv],
    recipientPub: decoded.recipientPub,
    networkTag: 'signet',
    domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
    voutIndex,
  });

  // Sender emits dust output at P2WPKH(hash160(commit)).
  const outputScript = p2wpkhScript(commit);

  // Recipient scans the tx (which has Bob's P2WPKH input).
  const tx = {
    inputs: [{ kind: 'p2wpkh', pub: bob.pub }],
    outputs: [
      { script: new Uint8Array([0x00, 0x14, ...crypto.getRandomValues(new Uint8Array(20))]) }, // vout[0] unrelated
      { script: outputScript }, // vout[1] stealth marker
    ],
  };
  const credits = recipientScanTxForStealth({
    tx, walletPriv: alice.priv, walletPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
  });
  assertEq(credits.length, 1);
  assertEq(credits[0].voutIndex, 1);
  assertEq(credits[0].scriptKind, 'p2wpkh');

  // Verify tweaked_sk corresponds to commit.
  const tweakedPub = secp.getPublicKey(credits[0].tweakedSk, true);
  assertEq(tweakedPub, commit, 'recipient-derived tweaked_sk · G = commit');

  // Sender's blinding == recipient's blinding (sanity check on ECDH symmetry).
  assertEq(credits[0].blinding.toString(16), bSender.toString(16));
});

test('e2e: multi-output to same recipient, distinct commits per vout_index', () => {
  const alice = newKeypair();
  const bob = newKeypair();
  const txAnchorHead = crypto.getRandomValues(new Uint8Array(36));

  // Sender emits two outputs to Alice at different vout positions.
  const c0 = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv],
    recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead, voutIndex: 0,
  });
  const c1 = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv],
    recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead, voutIndex: 1,
  });
  assert(bytesToHex(c0.commit) !== bytesToHex(c1.commit),
    'different vout_index must yield different commits in same tx');

  const tx = {
    inputs: [{ kind: 'p2wpkh', pub: bob.pub }],
    outputs: [
      { script: p2wpkhScript(c0.commit) },
      { script: p2wpkhScript(c1.commit) },
    ],
  };
  const credits = recipientScanTxForStealth({
    tx, walletPriv: alice.priv, walletPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
  });
  assertEq(credits.length, 2);
  assertEq(credits[0].voutIndex, 0);
  assertEq(credits[1].voutIndex, 1);
});

test('e2e: cross-sender same-recipient produce distinct commits (no clustering)', () => {
  const alice = newKeypair();
  const bob = newKeypair();
  const carol = newKeypair();
  const txAnchorHead = crypto.getRandomValues(new Uint8Array(36));
  const cBob = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv],
    recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead, voutIndex: 0,
  });
  const cCarol = senderComputeStealthCommit({
    senderEligibleInputPrivs: [carol.priv],
    recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead, voutIndex: 0,
  });
  assert(bytesToHex(cBob.commit) !== bytesToHex(cCarol.commit),
    'different senders to same recipient → different commits');
});

test('e2e: self-payment (sender = recipient) works correctly', () => {
  // Alice pays herself.
  const alice = newKeypair();
  const txAnchorHead = crypto.getRandomValues(new Uint8Array(36));
  const { commit, blinding } = senderComputeStealthCommit({
    senderEligibleInputPrivs: [alice.priv],
    recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead, voutIndex: 0,
  });
  const tx = {
    inputs: [{ kind: 'p2wpkh', pub: alice.pub }],
    outputs: [{ script: p2wpkhScript(commit) }],
  };
  const credits = recipientScanTxForStealth({
    tx, walletPriv: alice.priv, walletPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
  });
  assertEq(credits.length, 1);
  // Tweaked_sk should derive to commit even in self-pay case.
  const tweakedPub = secp.getPublicKey(credits[0].tweakedSk, true);
  assertEq(tweakedPub, commit);
});

test('e2e: scanner skips tx with no eligible inputs (P2WSH-only)', () => {
  const alice = newKeypair();
  const bob = newKeypair();
  const txAnchorHead = crypto.getRandomValues(new Uint8Array(36));
  // Sender computes commit anyway (assume dapp tried to emit stealth).
  const { commit } = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv],
    recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead, voutIndex: 0,
  });
  // But the tx ends up with only P2WSH inputs (per §A.2.5, ineligible).
  const tx = {
    inputs: [{ kind: 'p2wsh', pub: bob.pub }],
    outputs: [{ script: p2wpkhScript(commit) }],
  };
  const credits = recipientScanTxForStealth({
    tx, walletPriv: alice.priv, walletPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
  });
  assertEq(credits.length, 0, 'P2WSH-only tx is ineligible; recipient skips');
});

// §F.7 fund-critical refusal check: an emitter MUST refuse to produce a
// stealth output for a tx where no eligible input exists. The reference
// implementation here surfaces this via aggregateEligibleInputPubkeys
// returning {aggregatePub: null, eligibleCount: 0}; a real builder
// inspects that result before emitting and aborts. This test asserts
// the underlying aggregation rule reports the empty case correctly so
// builders can rely on it.
test('refusal-path: aggregation flags fully-ineligible input sets', () => {
  const a = newKeypair(), b = newKeypair();
  const { aggregatePub, eligibleCount } = aggregateEligibleInputPubkeys([
    { kind: 'p2wsh', pub: a.pub },
    { kind: 'p2tr-scriptpath', pub: b.pub },
  ]);
  assertEq(eligibleCount, 0);
  assert(aggregatePub === null,
    'fully-ineligible input set MUST yield null aggregate — builders depend on this signal to refuse stealth emission');
});

test('refusal-path: aggregation flags empty input list', () => {
  const { aggregatePub, eligibleCount } = aggregateEligibleInputPubkeys([]);
  assertEq(eligibleCount, 0);
  assert(aggregatePub === null);
});

// Audit 2.1: refusal-path covers MIXED-OWNERSHIP eligible inputs.
// The most dangerous case: emitter wallet owns one input, external party
// owns another. Aggregate P_sender = P_emitter + P_external. Emitter
// only knows sk_emitter; the recipient's derivation needs the full
// scalar sum to match. If the emitter naively emits, recipient misses
// the receipt → fund loss.
test('refusal-path: §F.7 — mixed-ownership eligible inputs MUST be refused', () => {
  const emitterKp = newKeypair();
  const externalKp = newKeypair();
  // Mark which inputs the emitter owns. In a real wallet this is a
  // lookup against wallet.utxos; here we tag inputs explicitly.
  const inputs = [
    { kind: 'p2wpkh', pub: emitterKp.pub, ours: true },
    { kind: 'p2wpkh', pub: externalKp.pub, ours: false },
  ];
  const r = checkStealthEmissionSafety({
    inputs,
    eachInputIsOurs: (inp) => inp.ours === true,
  });
  assert(!r.safe, `emitter MUST refuse mixed-ownership: ${r.reason}`);
  assert(r.reason.includes('not wallet-owned'),
    'refusal reason names the offending input');
});

test('refusal-path: §F.7 — all-wallet-owned eligible inputs is safe', () => {
  const emitterKp1 = newKeypair();
  const emitterKp2 = newKeypair();
  const inputs = [
    { kind: 'p2wpkh', pub: emitterKp1.pub, ours: true },
    { kind: 'p2tr-keypath', pub: emitterKp2.pub, ours: true },
  ];
  const r = checkStealthEmissionSafety({
    inputs, eachInputIsOurs: (inp) => inp.ours === true,
  });
  assert(r.safe, `all-owned should be safe: ${r.reason}`);
});

// Audit 2.2: mechanical mixer-input classification per §A.2.5 rule 6.
// Both sender and recipient must classify identically; the rule walks
// the prevout's source tx and checks the OP_RETURN opcode against a
// fixed set of mixer-emitting opcodes.
test('mixer classifier: T_WITHDRAW (0x2A) prevout is mixer-derived', () => {
  // Construct a fake prevout tx whose vout[0] is an OP_RETURN with
  // the T_WITHDRAW opcode in its payload.
  const opcode = 0x2A;
  const payload = new Uint8Array([opcode, ...crypto.getRandomValues(new Uint8Array(40))]);
  const opReturnScript = new Uint8Array([0x6a, payload.length, ...payload]);
  const prevoutTx = {
    outputs: [
      { script: opReturnScript },                          // vout[0]: OP_RETURN with envelope
      { script: p2wpkhScript(newKeypair().pub) },          // vout[1]: actual asset output
    ],
  };
  assert(isMixerDerivedInput({ prevoutTx, prevoutVout: 1 }),
    'T_WITHDRAW (0x2A) prevout MUST classify as mixer-derived');
});

test('mixer classifier: T_SLOT_BURN (0x44) prevout is mixer-derived', () => {
  const payload = new Uint8Array([0x44, ...crypto.getRandomValues(new Uint8Array(40))]);
  const opReturnScript = new Uint8Array([0x6a, payload.length, ...payload]);
  const prevoutTx = { outputs: [{ script: opReturnScript }, { script: p2wpkhScript(newKeypair().pub) }] };
  assert(isMixerDerivedInput({ prevoutTx, prevoutVout: 1 }),
    'T_SLOT_BURN (0x44) prevout MUST classify as mixer-derived');
});

test('mixer classifier: non-mixer opcode prevout NOT classified as mixer-derived', () => {
  // T_CXFER = 0x23 (not in MIXER_EMITTING_OPCODES)
  const payload = new Uint8Array([0x23, ...crypto.getRandomValues(new Uint8Array(40))]);
  const opReturnScript = new Uint8Array([0x6a, payload.length, ...payload]);
  const prevoutTx = { outputs: [{ script: opReturnScript }, { script: p2wpkhScript(newKeypair().pub) }] };
  assert(!isMixerDerivedInput({ prevoutTx, prevoutVout: 1 }),
    'T_CXFER (0x23) is not mixer-emitting');
});

test('mixer classifier: pure Bitcoin tx (no OP_RETURN) NOT classified as mixer-derived', () => {
  const prevoutTx = {
    outputs: [
      { script: p2wpkhScript(newKeypair().pub) },          // vout[0]: regular P2WPKH, no envelope
      { script: p2wpkhScript(newKeypair().pub) },
    ],
  };
  assert(!isMixerDerivedInput({ prevoutTx, prevoutVout: 0 }),
    'plain Bitcoin tx is not mixer-derived');
});

test('mixer classifier: empty/malformed tx returns false', () => {
  assert(!isMixerDerivedInput({ prevoutTx: null, prevoutVout: 0 }));
  assert(!isMixerDerivedInput({ prevoutTx: { outputs: [] }, prevoutVout: 0 }));
  assert(!isMixerDerivedInput({ prevoutTx: { outputs: [{ script: new Uint8Array([]) }] }, prevoutVout: 0 }));
});

test('mixer classifier: registry is the single source of truth', () => {
  // Sanity: the set is what we documented in the spec.
  assert(MIXER_EMITTING_OPCODES.has(0x2A));  // T_WITHDRAW
  assert(MIXER_EMITTING_OPCODES.has(0x44));  // T_SLOT_BURN
  assert(!MIXER_EMITTING_OPCODES.has(0x23)); // T_CXFER (not mixer)
  assert(!MIXER_EMITTING_OPCODES.has(0x26)); // T_AXFER (not mixer)
});

test('refusal-path: §F.7 — ineligible inputs are filtered before ownership check', () => {
  const emitterKp = newKeypair();
  const externalKp = newKeypair();
  // P2WSH external input is ineligible per §A.2.5 — doesn't contribute
  // to P_sender, so its ownership is irrelevant. Emitter's eligible P2WPKH
  // is wallet-owned, so emission is safe.
  const inputs = [
    { kind: 'p2wpkh', pub: emitterKp.pub, ours: true },
    { kind: 'p2wsh', pub: externalKp.pub, ours: false },
  ];
  const r = checkStealthEmissionSafety({
    inputs, eachInputIsOurs: (inp) => inp.ours === true,
  });
  assert(r.safe,
    'P2WSH excluded from §A.2.5 aggregation; ownership of ineligible inputs does not affect emission safety');
});

test('locked-vector: ECDH x-only serialization (audit 1.2)', () => {
  // Locks the §A.2 normative choice: shared = SHA256(x_only(sharedPt)).
  // Any future refactor that switches to compressed (33-byte) or
  // uncompressed (65-byte) serialization will break this test, which
  // is the intended cross-check against drift.
  //
  // Test vector: deterministic privkeys 0x01... and 0x02... ECDH, then
  // verify the derived blinding is the expected value.
  const alice = {
    priv: hexToBytes('0000000000000000000000000000000000000000000000000000000000000001'),
    pub:  secp.getPublicKey(hexToBytes('0000000000000000000000000000000000000000000000000000000000000001'), true),
  };
  const bob = {
    priv: hexToBytes('0000000000000000000000000000000000000000000000000000000000000002'),
    pub:  secp.getPublicKey(hexToBytes('0000000000000000000000000000000000000000000000000000000000000002'), true),
  };
  const txAnchor = hexToBytes(
    '00000000000000000000000000000000000000000000000000000000000000ff00000000'
  );
  const bSender = deriveEcdhBlinding({
    ourPriv: bob.priv, theirPub: alice.pub,
    networkTag: 'mainnet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  const bRecipient = deriveEcdhBlinding({
    ourPriv: alice.priv, theirPub: bob.pub,
    networkTag: 'mainnet', domain: DOMAIN_CXFER_STEALTH, txAnchor,
  });
  // ECDH symmetry must hold under the chosen serialization.
  assertEq(bSender.toString(16), bRecipient.toString(16),
    'ECDH symmetry under x-only serialization');
  // Lock the actual derived value. If this changes, the serialization
  // changed — verify intentionally before updating.
  const bHex = bSender.toString(16).padStart(64, '0');
  // Expected value derived from x-only serialization (NOT compressed).
  // Re-derived if this test breaks: confirm it differs from the
  // compressed-form derivation before accepting the new value.
  console.log(`  [locked vector b = 0x${bHex.slice(0,16)}…]`);
  // Sanity: b must NOT match what compressed-form derivation would give.
  // Compute compressed-form for comparison.
  const sharedPt = secp.ProjectivePoint.fromHex(bytesToHex(alice.pub))
    .multiply(BigInt('0x' + bytesToHex(bob.priv)));
  const compressedForm = sha256(sharedPt.toRawBytes(true));
  const xOnlyForm      = sha256(sharedPt.toRawBytes(true).slice(1));
  assert(bytesToHex(compressedForm) !== bytesToHex(xOnlyForm),
    'sanity: compressed and x-only forms must differ');
  // The function under test must be using x-only.
  const networkTag = new Uint8Array([0x00]);
  const macXonly = hmac(sha256, xOnlyForm, concatBytes(
    DOMAIN_CXFER_STEALTH, networkTag, txAnchor,
  ));
  const bXonly = BigInt('0x' + bytesToHex(macXonly)) % SECP_N;
  assertEq(bSender.toString(16), bXonly.toString(16),
    'deriveEcdhBlinding MUST use x-only serialization (§A.2 normative)');
});

test('e2e: P2TR output also detected (dual-match)', () => {
  const alice = newKeypair();
  const bob = newKeypair();
  const txAnchorHead = crypto.getRandomValues(new Uint8Array(36));
  const { commit } = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bob.priv],
    recipientPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead, voutIndex: 0,
  });
  // Sender emits as P2TR instead of P2WPKH.
  const tx = {
    inputs: [{ kind: 'p2wpkh', pub: bob.pub }],
    outputs: [{ script: p2trScript(xOnly(commit)) }],
  };
  const credits = recipientScanTxForStealth({
    tx, walletPriv: alice.priv, walletPub: alice.pub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
  });
  assertEq(credits.length, 1);
  assertEq(credits[0].scriptKind, 'p2tr');
});

// =============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
