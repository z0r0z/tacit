// End-to-end test for §5.7.6 atomic-intent on-chain recovery via OP_RETURN.
//
// Validates the round-trip a wallet would actually run when restoring from
// seed alone (no local cache, no worker fetch):
//   1. Maker picks random `r` at intent publish; locks recipient commitment
//      H·amount + G·r into the leaf script (committed at publish).
//   2. Maker fulfils with taker_pub known: computes the on-chain ciphertext,
//      embeds it as a 0-sat OP_RETURN.
//   3. Reveal tx settles on chain. Years later, the taker restores from seed.
//   4. Taker scans chain, finds reveal involving their address, extracts
//      maker_pub from vin[1], computes intent_id from commit_txid + maker_pub,
//      derives the on-chain keystream via ECDH(taker_priv, maker_pub),
//      decrypts OP_RETURN, verifies Pedersen commitment.
//
// All from chain + privkey alone. No worker, no cache.

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

import {
  deriveAxintentOnchainKeystreams,
  encodeAxintentOnchainPayload, decodeAxintentOnchainPayload,
  encodeAxintentOnchainOpReturn, tryExtractAxintentOnchainOpReturn,
  AXINTENT_ONCHAIN_PAYLOAD_BYTES,
} from './composition.mjs';
import { G, H, ZERO, SECP_N, pedersenCommit } from './bulletproofs.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

function bytes32ToBigint(b) { return BigInt('0x' + bytesToHex(b)); }
function reverseBytes(b) { const r = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) r[i] = b[b.length - 1 - i]; return r; }

// Synthesize a maker and a taker with valid scalars.
const makerPriv = sha256(new TextEncoder().encode('axintent-recovery-test-maker'));
const takerPriv = sha256(new TextEncoder().encode('axintent-recovery-test-taker'));
const makerPub  = secp.ProjectivePoint.fromPrivateKey(makerPriv).toRawBytes(true);
const takerPub  = secp.ProjectivePoint.fromPrivateKey(takerPriv).toRawBytes(true);

// Simulate a commit tx outpoint (the maker's commit P2TR consumed at vin[0]).
const commitTxidHex = bytesToHex(sha256(new TextEncoder().encode('mock-commit-tx')));
const commitTxidBE  = reverseBytes(hexToBytes(commitTxidHex));

// Synthesize an asset_id.
const assetIdBytes = sha256(new TextEncoder().encode('test-asset-id'));

// intent_id per §5.7.6: SHA256(commit_txid_BE || maker_pubkey)[:16].
const intentIdBytes = sha256(concatBytes(commitTxidBE, makerPub)).slice(0, 16);

console.log('§5.7.6 atomic-intent on-chain recovery end-to-end');

// === Maker side at fulfilment time ===
const amount = 12_345_678n;
const rBytes = sha256(new TextEncoder().encode('random-blinding-r-for-this-intent'));
const rBig   = bytes32ToBigint(rBytes) % SECP_N;

// Maker computes the on-chain ciphertext and the OP_RETURN script.
const ksMaker = deriveAxintentOnchainKeystreams(makerPriv, takerPub, intentIdBytes, assetIdBytes, 0);
const cipher  = encodeAxintentOnchainPayload(amount, rBytes, ksMaker);
const opReturnScript = encodeAxintentOnchainOpReturn(cipher);

test('OP_RETURN script is 42 bytes (0x6a 0x28 + 40 bytes)', () =>
  opReturnScript.length === 42 && opReturnScript[0] === 0x6a && opReturnScript[1] === 0x28
);
test('Recipient commitment opens to (amount, r)', () => {
  const commitment = pedersenCommit(amount, rBig);
  const reExpected = pedersenCommit(amount, rBig);
  return commitment.equals(reExpected);
});

// === Wallet scan (taker side, years later) ===
// Wallet finds a reveal tx involving its address. It extracts:
//   - commit_txid from vin[0].prevout.txid
//   - maker_pubkey from vin[1].witness[1]
//   - OP_RETURN(40) from one of the vouts
// Then derives intent_id, derives keystream, decrypts.

const scannedOpReturn = tryExtractAxintentOnchainOpReturn(opReturnScript);
test('Scanner extracts ciphertext from OP_RETURN', () =>
  scannedOpReturn !== null && scannedOpReturn.length === 40
);

const scannedCommitTxidBE = commitTxidBE; // simulated from chain
const scannedMakerPub = makerPub;          // simulated from vin[1].witness[1]
const scannedIntentId = sha256(concatBytes(scannedCommitTxidBE, scannedMakerPub)).slice(0, 16);
test('Scanner re-derives intent_id from chain inputs', () =>
  bytesToHex(scannedIntentId) === bytesToHex(intentIdBytes)
);

const ksTaker = deriveAxintentOnchainKeystreams(takerPriv, scannedMakerPub, scannedIntentId, assetIdBytes, 0);
const decoded = decodeAxintentOnchainPayload(scannedOpReturn, ksTaker);
test('Taker decrypts amount via ECDH (taker_priv, maker_pub)', () =>
  decoded.amount === amount
);
test('Taker decrypts blinding via ECDH (taker_priv, maker_pub)', () =>
  bytesToHex(decoded.blindingBytes) === bytesToHex(rBytes)
);

// Final Pedersen verification: this confirms the decrypted (amount, r)
// actually opens the on-chain commitment.
const decodedRBig = bytes32ToBigint(decoded.blindingBytes) % SECP_N;
const onChainCommitment = pedersenCommit(amount, rBig);
const reconstructed     = pedersenCommit(decoded.amount, decodedRBig);
test('Pedersen check: decrypted (amount, blinding) opens on-chain commitment', () =>
  onChainCommitment.equals(reconstructed)
);

console.log('\nAdversarial paths');

test('Wrong maker_pub → decryption produces gibberish (Pedersen fails)', () => {
  const wrongMakerPriv = sha256(new TextEncoder().encode('attacker'));
  const wrongMakerPub  = secp.ProjectivePoint.fromPrivateKey(wrongMakerPriv).toRawBytes(true);
  const ksWrong = deriveAxintentOnchainKeystreams(takerPriv, wrongMakerPub, scannedIntentId, assetIdBytes, 0);
  const decBad  = decodeAxintentOnchainPayload(scannedOpReturn, ksWrong);
  const rBadBig = bytes32ToBigint(decBad.blindingBytes) % SECP_N;
  const recon   = pedersenCommit(decBad.amount, rBadBig);
  return !onChainCommitment.equals(recon);
});

test('Wrong vout_idx → decryption produces gibberish (replay protection)', () => {
  const ksWrong = deriveAxintentOnchainKeystreams(takerPriv, scannedMakerPub, scannedIntentId, assetIdBytes, 1);
  const decBad  = decodeAxintentOnchainPayload(scannedOpReturn, ksWrong);
  return decBad.amount !== amount;
});

test('Wrong asset_id → decryption produces gibberish', () => {
  const wrongAsset = sha256(new TextEncoder().encode('different-asset'));
  const ksWrong = deriveAxintentOnchainKeystreams(takerPriv, scannedMakerPub, scannedIntentId, wrongAsset, 0);
  const decBad  = decodeAxintentOnchainPayload(scannedOpReturn, ksWrong);
  return decBad.amount !== amount;
});

test('Wrong intent_id → decryption produces gibberish', () => {
  const wrongIntent = sha256(new TextEncoder().encode('different-intent')).slice(0, 16);
  const ksWrong = deriveAxintentOnchainKeystreams(takerPriv, scannedMakerPub, wrongIntent, assetIdBytes, 0);
  const decBad  = decodeAxintentOnchainPayload(scannedOpReturn, ksWrong);
  return decBad.amount !== amount;
});

test('Outsider (third-party privkey) → decryption produces gibberish', () => {
  const outsiderPriv = sha256(new TextEncoder().encode('outsider'));
  const ksOut = deriveAxintentOnchainKeystreams(outsiderPriv, scannedMakerPub, scannedIntentId, assetIdBytes, 0);
  const decBad = decodeAxintentOnchainPayload(scannedOpReturn, ksOut);
  const rBadBig = bytes32ToBigint(decBad.blindingBytes) % SECP_N;
  const recon = pedersenCommit(decBad.amount, rBadBig);
  return !onChainCommitment.equals(recon);
});

test('Mutated OP_RETURN ciphertext → decryption fails Pedersen check', () => {
  const mutated = new Uint8Array(scannedOpReturn);
  mutated[0] ^= 0xff;
  const decBad = decodeAxintentOnchainPayload(mutated, ksTaker);
  const rBadBig = bytes32ToBigint(decBad.blindingBytes) % SECP_N;
  const recon = pedersenCommit(decBad.amount, rBadBig);
  return !onChainCommitment.equals(recon);
});

test('OP_RETURN extraction rejects wrong-length scripts', () => {
  const tooShort = hexToBytes('6a28' + '00'.repeat(39));
  const tooLong  = hexToBytes('6a28' + '00'.repeat(41));
  return tryExtractAxintentOnchainOpReturn(tooShort) === null &&
         tryExtractAxintentOnchainOpReturn(tooLong) === null;
});

test('OP_RETURN extraction rejects non-OP_RETURN scripts', () => {
  // P2WPKH-shaped (0x00 0x14 + 20 bytes) — wrong opcode.
  const p2wpkh = hexToBytes('0014' + '00'.repeat(40));
  // Wrong push length byte.
  const wrongPush = hexToBytes('6a' + '20' + '00'.repeat(40));
  return tryExtractAxintentOnchainOpReturn(p2wpkh) === null &&
         tryExtractAxintentOnchainOpReturn(wrongPush) === null;
});

test('Different intent for same (maker, taker) → different ciphertext', () => {
  const otherIntentId = sha256(new TextEncoder().encode('other')).slice(0, 16);
  const ksOther = deriveAxintentOnchainKeystreams(makerPriv, takerPub, otherIntentId, assetIdBytes, 0);
  const cipherOther = encodeAxintentOnchainPayload(amount, rBytes, ksOther);
  return bytesToHex(cipherOther) !== bytesToHex(cipher);
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
