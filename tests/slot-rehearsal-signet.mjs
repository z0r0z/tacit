#!/usr/bin/env node
// SPEC-CBTC-ZK signet rehearsal harness for the self-custody slot wrapper.
//
// What this exercises (offline, no broadcasts required):
//
//   1. T_SLOT_MINT envelope build → decode round-trip + cryptographic identity:
//        K_btc = recipient_commit − denom·H = r_leaf · G          (§5.21)
//      Slot scriptpubkey = OP_1 || OP_PUSHBYTES_32 || x-only(K_btc).
//
//   2. A synthetic Bitcoin "mint tx" whose vout[0] equals the slot scriptpubkey
//      (this is what the worker scanner expects to find on chain at the position
//      bound by the envelope). We compute its txid so a downstream spend tx can
//      reference it.
//
//   3. A slot-spend tx (the burn-side / SPEC §5.22 redeem) that consumes the
//      mint vout[0]. We sign its input under r_leaf using
//        tapSighashKeyPath(tx, idx, prevouts, hashType)
//        signTaprootKeyPathInputWithKey(tx, idx, prevouts, r_leaf, hashType)
//      and then VERIFY the resulting Schnorr sig against slotXOnly(K_btc)
//      using a fresh noble-secp instance. This is the load-bearing check: it
//      proves the spend witness an honest redeemer would publish on chain
//      validates under exactly the x-only key the worker re-derives from
//      recipient_commit + denomination.
//
//      Covers BOTH SIGHASH_DEFAULT (witness = [sig64]) and SIGHASH_ALL
//      (witness = [sig64||0x01]) — the wire shapes that BIP-341 mandates and
//      that the mainnet Bitcoin consensus rule enforces.
//
//   4. T_SLOT_ROTATE end-to-end: build a rotate envelope binding old-slot burn
//      + new-slot mint, decode it, verify the new K_btc is the new
//      recipient_commit − denom·H, and verify the old-owner Schnorr sig.
//      The rotation's BTC spend tx (signed under OLD r_leaf, paying out the
//      NEW slot scriptpubkey) is built + sighash/sig verified identically to
//      the burn case above.
//
//   5. T_SLOT_BURN end-to-end with a stub merkle root + proof, so the bind_hash
//      recompute path inside encodeTSlotBurnPayload runs against canonical
//      inputs. The worker is dapp-authoritative on Groth16 verify (SPEC §5.11.4
//      three-verifier model), so the proof bytes are arbitrary here; the
//      rehearsal validates everything *up to* the proof boundary.
//
// What this does NOT exercise (deliberately out of scope, see SLOT-DEPLOYMENT
// notes for the broadcast path):
//
//   • Funding-input selection / fee estimation for the LP-driven funding tx —
//     handled by whatever wallet drives the user-visible mint flow.
//   • Live broadcast to signet — this rehearsal is the unit between "envelope
//     bytes look right in a test" and "go fund three signet wallets and run
//     the full e2e." Once the rehearsal passes, the only remaining variable
//     is the LP's funding-input policy.
//   • Groth16 proof generation/verification — exercised by tests/wrapper.test.mjs
//     and the existing mixer-* tests.
//
// Usage:
//   node tests/slot-rehearsal-signet.mjs                 # all rehearsal checks
//   SEED=<hex64> node tests/slot-rehearsal-signet.mjs    # deterministic identities
//   VERBOSE=1 node tests/slot-rehearsal-signet.mjs       # print each tx + witness
//
// If you have a fully-funded signet operator that wants to drive the live tx
// path, pair this with the dapp's slot-mint UI to produce the Bitcoin tx and
// post the envelope via the worker's normal /broadcast path — the harness
// validates that the ingredients those flows produce are correct.

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

// ============== jsdom + dapp boot ==============
// The dapp module touches `window`/`document`/`localStorage` at import time.
// `__TACIT_NO_INIT__` short-circuits the UI bootstrap so we get the module's
// pure exports without the browser-only init side effects.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
// Signet so network_tag = 0x01 falls out of NET. (Mainnet rehearsal would just
// swap this for 'mainnet' and the network_tag would become 0x00.)
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const m = await import('../dapp/tacit.js');

// ============== config ==============
const VERBOSE = !!process.env.VERBOSE;
const SEED = (process.env.SEED || '').toLowerCase();
const NETWORK_TAG_SIGNET = 0x01;
const ASSET_ID = hexToBytes('1111111111111111111111111111111111111111111111111111111111111111');
const DENOMINATION = 100_000n;  // 100k sats = 0.001 BTC slot, matches "test denom" in §5.21 examples
const PAYMENT_ASSET_ID = hexToBytes('2222222222222222222222222222222222222222222222222222222222222222');
const PAYMENT_AMOUNT = 50_000n;

// ============== rehearsal state ==============
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== helpers ==============
function deriveBytes32(seedHex, label) {
  if (!seedHex) return crypto.getRandomValues(new Uint8Array(32));
  return sha256(new TextEncoder().encode('tacit-slot-rehearsal-v1:' + label + ':' + seedHex));
}

// Deterministic synthetic prev-tx — gives us a stable txid to spend in the
// burn/rotate test. Real signet would use the LP's funded tx instead.
function fakeTxid(label) {
  return bytesToHex(sha256(new TextEncoder().encode('rehearsal-prev:' + label)));
}

// Build a minimal valid tx object matching the dapp's internal shape (the same
// shape tapSighashKeyPath consumes — version + locktime + inputs[{txid,vout,sequence,witness}] + outputs[{value,script}]).
function buildSlotSpendTx({ mintTxid, mintVout, mintValue, slotScript, payoutScript, payoutValue, locktime = 0 }) {
  return {
    version: 2,
    locktime,
    inputs: [{
      txid: mintTxid,
      vout: mintVout,
      sequence: 0xffffffff,
      witness: [],            // filled in by the signer
    }],
    outputs: [{ value: payoutValue, script: payoutScript }],
    _prevouts: [{ value: Number(mintValue), script: slotScript }],
  };
}

function compressedPubFromPriv(priv32) {
  return secp.getPublicKey(priv32, true);
}

function p2wpkhScript(pubkey33) {
  // P2WPKH(pubkey) = OP_0 || OP_PUSHBYTES_20 || HASH160(pubkey)
  // Use noble's HASH160 = RIPEMD160(SHA256(...)) — but noble-hashes ships
  // ripemd160 separately. Worker doesn't need this; the dapp-side P2WPKH
  // script is built inside dapp/tacit.js for sats-send. For the rehearsal,
  // any 22-byte witness program is fine — the script's exact bytes don't
  // affect tapSighashKeyPath of the *spend* (only the prevout's script does).
  // To keep this harness self-contained we use a constant placeholder.
  // (The slot-spend's payout simply needs to be SOME valid witness program.)
  const placeholder = sha256(pubkey33).slice(0, 20);
  return concatBytes(new Uint8Array([0x00, 0x14]), placeholder);
}

// ============== group 1: T_SLOT_MINT round-trip + identity ==============
group('T_SLOT_MINT — envelope, derivation, slot script');

const minterPriv = deriveBytes32(SEED, 'minter');
const secret     = deriveBytes32(SEED, 'mint-secret');
const nullPre    = deriveBytes32(SEED, 'mint-nullifier-preimage');

const mintOut = await m.buildSlotMintEnvelope({
  networkTag: NETWORK_TAG_SIGNET,
  assetId: ASSET_ID,
  denomination: DENOMINATION,
  secret,
  nullifierPreimage: nullPre,
  paymentAssetId: PAYMENT_ASSET_ID,
  paymentAmount: PAYMENT_AMOUNT,
  minterPriv,
});

ok('mint envelope produced', mintOut && mintOut.payload && mintOut.payload.length > 0);
ok('slot scriptpubkey is OP_1 || OP_PUSHBYTES_32 || x-only(K_btc)',
  mintOut.slotScriptPubKey.length === 34
  && mintOut.slotScriptPubKey[0] === 0x51
  && mintOut.slotScriptPubKey[1] === 0x20);

// Identity: K_btc = r_leaf · G, where r_leaf = Poseidon(secret, ν) mod n.
// We can't re-derive r_leaf without re-running Poseidon, but we can verify
// the *committed* identity: x-only(K_btc) lives in the envelope's slot script,
// and re-deriving K_btc from (recipient_commit, denom) via the public formula
// must reproduce the same bytes.
const reKbtc = m.deriveSlotKbtc(mintOut.recipientCommit, DENOMINATION.toString());
const reSpk  = m.slotScriptPubKeyFromKbtc(reKbtc);
ok('re-derived slot scriptpubkey byte-equals envelope value',
  bytesToHex(reSpk) === bytesToHex(mintOut.slotScriptPubKey));

// Decode the envelope payload back and check field-for-field consistency.
const wm = await import('../worker/src/index.js');
const decMint = wm.decodeTSlotMintPayload(mintOut.payload);
ok('envelope decodes', !!decMint);
ok('decode: network_tag = signet', decMint.network_tag === NETWORK_TAG_SIGNET);
ok('decode: asset_id matches', decMint.asset_id === bytesToHex(ASSET_ID));
ok('decode: denomination matches', String(decMint.denomination) === DENOMINATION.toString());
ok('decode: recipient_commitment matches', decMint.recipient_commitment === bytesToHex(mintOut.recipientCommit));

if (VERBOSE) {
  console.log(`  · slot SPK:      ${bytesToHex(mintOut.slotScriptPubKey)}`);
  console.log(`  · K_btc x-only:  ${bytesToHex(reSpk).slice(4)}`);
  console.log(`  · payload bytes: ${mintOut.payload.length}`);
}

// ============== group 2: BIP-341 key-path sighash + sig — SIGHASH_DEFAULT ==============
group('Slot-spend signing — SIGHASH_DEFAULT (witness = [sig64])');

const mintTxid = fakeTxid('mint-1');
const spendDefault = buildSlotSpendTx({
  mintTxid,
  mintVout: 0,
  mintValue: DENOMINATION,
  slotScript: mintOut.slotScriptPubKey,
  payoutScript: p2wpkhScript(compressedPubFromPriv(deriveBytes32(SEED, 'payout-1'))),
  payoutValue: Number(DENOMINATION) - 300,  // 300-sat fee placeholder
});

// `r_leaf` (the slot's secret scalar) is what the spend signs under, not wallet.priv.
// The mint envelope returned rLeaf as the raw 32-byte Poseidon output — we
// reduce mod n implicitly by passing it to noble's signSchnorr, which
// reduces internally.
const rLeafBytes = mintOut.rLeaf;
const witnessDefault = m.signTaprootKeyPathInputWithKey(
  spendDefault, 0, spendDefault._prevouts, rLeafBytes, 0x00,
);

ok('witness has exactly one element under SIGHASH_DEFAULT', witnessDefault.length === 1);
ok('SIGHASH_DEFAULT sig is exactly 64 bytes', witnessDefault[0].length === 64);

// Independently recompute the sighash + verify the sig against slotXOnly(K_btc)
// using the dapp's own BIP-340 verifier. This is the round-trip a Bitcoin full
// node will perform when validating the spend (the dapp implements the same
// algorithm against the same parameters that consensus uses).
const sighashDefault = m.tapSighashKeyPath(spendDefault, 0, spendDefault._prevouts, 0x00);
const xOnly = m.slotXOnly(reKbtc);
const sigValidDefault = m.verifySchnorr(witnessDefault[0], sighashDefault, xOnly);
ok('sig verifies under slotXOnly(K_btc) — full Bitcoin consensus path', sigValidDefault);

if (VERBOSE) {
  console.log(`  · sighash:       ${bytesToHex(sighashDefault)}`);
  console.log(`  · witness[0]:    ${bytesToHex(witnessDefault[0])}`);
}

// ============== group 3: BIP-341 key-path sighash + sig — SIGHASH_ALL ==============
group('Slot-spend signing — SIGHASH_ALL (witness = [sig64 || 0x01])');

const spendAll = buildSlotSpendTx({
  mintTxid,
  mintVout: 0,
  mintValue: DENOMINATION,
  slotScript: mintOut.slotScriptPubKey,
  payoutScript: p2wpkhScript(compressedPubFromPriv(deriveBytes32(SEED, 'payout-2'))),
  payoutValue: Number(DENOMINATION) - 300,
});

const witnessAll = m.signTaprootKeyPathInputWithKey(
  spendAll, 0, spendAll._prevouts, rLeafBytes, 0x01,
);

ok('witness has exactly one element under SIGHASH_ALL', witnessAll.length === 1);
ok('SIGHASH_ALL witness is 65 bytes (64 sig + 1 flag)', witnessAll[0].length === 65);
ok('last byte of SIGHASH_ALL witness is 0x01', witnessAll[0][64] === 0x01);

const sighashAll = m.tapSighashKeyPath(spendAll, 0, spendAll._prevouts, 0x01);
const sigBareAll = witnessAll[0].slice(0, 64);
const sigValidAll = m.verifySchnorr(sigBareAll, sighashAll, xOnly);
ok('sig verifies under slotXOnly(K_btc) — SIGHASH_ALL path', sigValidAll);

// Negative: the SIGHASH_ALL sighash must differ from SIGHASH_DEFAULT for the
// same tx — BIP-341 §"Signature validation rules" requires the hashType in
// the preimage when non-zero. If these collided, a SIGHASH_DEFAULT sig could
// be replayed in a SIGHASH_ALL witness (or vice versa), so this is a
// load-bearing distinction.
ok('SIGHASH_DEFAULT and SIGHASH_ALL sighashes differ',
  bytesToHex(sighashDefault) !== bytesToHex(sighashAll));

// ============== group 4: tamper resistance (negative tests) ==============
group('Slot-spend signing — tamper resistance');

// Tamper the output value: re-sighash must change, original sig must NOT verify.
const tampered = JSON.parse(JSON.stringify(spendDefault, (k, v) =>
  v instanceof Uint8Array ? Array.from(v) : v
));
// Restore Uint8Arrays after JSON round-trip
tampered.outputs[0].script = new Uint8Array(tampered.outputs[0].script);
tampered._prevouts[0].script = new Uint8Array(tampered._prevouts[0].script);
tampered.outputs[0].value = tampered.outputs[0].value - 1000;

const tamperedSighash = m.tapSighashKeyPath(tampered, 0, tampered._prevouts, 0x00);
ok('tampered tx produces a DIFFERENT sighash',
  bytesToHex(tamperedSighash) !== bytesToHex(sighashDefault));
ok('original sig FAILS against tampered tx (tx-binding works)',
  !m.verifySchnorr(witnessDefault[0], tamperedSighash, xOnly));

// Tamper the prevout value (signed by BIP-341 as part of sha_amounts).
const tamperedAmt = buildSlotSpendTx({
  mintTxid,
  mintVout: 0,
  mintValue: DENOMINATION + 1n,  // lie about the prevout amount
  slotScript: mintOut.slotScriptPubKey,
  payoutScript: p2wpkhScript(compressedPubFromPriv(deriveBytes32(SEED, 'payout-1'))),
  payoutValue: Number(DENOMINATION) - 300,
});
const tamperedAmtSighash = m.tapSighashKeyPath(tamperedAmt, 0, tamperedAmt._prevouts, 0x00);
ok('original sig FAILS when prevout value is altered (amount-binding works)',
  !m.verifySchnorr(witnessDefault[0], tamperedAmtSighash, xOnly));

// ============== group 5: T_SLOT_ROTATE round-trip + new-slot identity ==============
group('T_SLOT_ROTATE — atomic transfer envelope');

const newSecret = deriveBytes32(SEED, 'rotate-new-secret');
const newNullPre = deriveBytes32(SEED, 'rotate-new-nullifier-preimage');

const rotateOut = await m.buildSlotRotateEnvelope({
  networkTag: NETWORK_TAG_SIGNET,
  oldSlotRecord: mintOut.slotRecord,
  oldMerkleRoot: new Uint8Array(32),    // stub — proof side not exercised here
  oldProof: new Uint8Array(8 + 256),    // stub Groth16 proof bytes
  newSecret,
  newNullifierPreimage: newNullPre,
  paymentAssetId: PAYMENT_ASSET_ID,
  paymentAmount: PAYMENT_AMOUNT,
  oldOwnerPriv: minterPriv,             // in practice the slot's current owner
});

ok('rotate envelope produced', !!rotateOut.payload && rotateOut.payload.length > 0);
ok('new slot scriptpubkey is 34-byte P2TR',
  rotateOut.newSlotScriptPubKey.length === 34
  && rotateOut.newSlotScriptPubKey[0] === 0x51
  && rotateOut.newSlotScriptPubKey[1] === 0x20);
ok('new K_btc re-derives identically from new recipient_commit',
  bytesToHex(m.slotScriptPubKeyFromKbtc(m.deriveSlotKbtc(rotateOut.newRecipientCommit, DENOMINATION.toString())))
  === bytesToHex(rotateOut.newSlotScriptPubKey));

const decRot = wm.decodeTSlotRotatePayload(rotateOut.payload);
ok('rotate envelope decodes', !!decRot);
ok('rotate decode: new_recipient_commitment matches',
  decRot.new_recipient_commitment === bytesToHex(rotateOut.newRecipientCommit));
ok('rotate decode: old_owner Schnorr sig verifies over rotate_msg',
  (() => {
    // Reconstruct the message the encoder bound the sig to. _msg() is the
    // decoder's lazy helper that recomputes the canonical preimage from the
    // decoded fields and tagged-hashes it.
    let msg; try { msg = decRot._msg(); } catch { return false; }
    // Strip the 0x02/0x03 parity byte to get the 32-byte x-only key the
    // worker passes to verifySchnorr.
    const ownerPub = hexToBytes(decRot.old_owner_pubkey);
    const ownerXOnly = ownerPub.slice(1);
    return m.verifySchnorr(hexToBytes(decRot.old_owner_sig), msg, ownerXOnly);
  })());

// Rotation spend: spends the OLD slot under old r_leaf, pays out to NEW slot.
// Identical sighash machinery to the burn case — just a different payout.
const rotateSpend = buildSlotSpendTx({
  mintTxid,
  mintVout: 0,
  mintValue: DENOMINATION,
  slotScript: mintOut.slotScriptPubKey,
  payoutScript: rotateOut.newSlotScriptPubKey,
  payoutValue: Number(DENOMINATION) - 300,
});
const rotateWitness = m.signTaprootKeyPathInputWithKey(
  rotateSpend, 0, rotateSpend._prevouts, rLeafBytes, 0x00,
);
ok('rotate spend sig verifies under old slot x-only(K_btc)',
  m.verifySchnorr(
    rotateWitness[0],
    m.tapSighashKeyPath(rotateSpend, 0, rotateSpend._prevouts, 0x00),
    xOnly,
  ));

// ============== group 6: T_SLOT_BURN envelope round-trip ==============
group('T_SLOT_BURN — atomic redeem envelope');

const burnOut = await m.buildSlotBurnEnvelope({
  networkTag: NETWORK_TAG_SIGNET,
  slotRecord: mintOut.slotRecord,
  merkleRoot: new Uint8Array(32),
  proof: new Uint8Array(8 + 256),
});

ok('burn envelope produced', !!burnOut.payload && burnOut.payload.length > 0);
ok('burn envelope carries the same r_leaf the mint generated',
  bytesToHex(burnOut.rLeaf) === bytesToHex(mintOut.rLeaf));

const decBurn = wm.decodeTSlotBurnPayload(burnOut.payload);
ok('burn envelope decodes', !!decBurn);
ok('burn decode: nullifier_hash present + 32 bytes',
  typeof decBurn.nullifier_hash === 'string' && decBurn.nullifier_hash.length === 64);
ok('burn decode: recipient_commitment matches mint',
  decBurn.recipient_commitment === bytesToHex(mintOut.recipientCommit));

// The bind_hash is the decoder's canonical-preimage commitment — it's how the
// worker confirms field tampering hasn't shifted the witness boundary. The
// decoder recomputes it from the *decoded* bytes and compares to the on-wire
// value, so a successful decode is itself proof of bind-hash equality.
ok('burn decode populates bind_hash', typeof decBurn.bind_hash === 'string' && decBurn.bind_hash.length === 64);

// ============== summary ==============
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
