// Tests for tests/indexer.mjs::verifyDisclosure (mirrors dapp/tacit.js::verifyDisclosure).
// Covers SPEC §5.6 verifier requirements 1–4: K bound, per-UTXO ownership +
// envelope-decode + asset-id consistency, BIP-340 sig, bulletproof on
// C' = ΣC_i − K·H.
//
// We synthesise a CETCH parent and one P2WPKH UTXO owned by the prover, build
// a valid disclosure, then mutate one input at a time to confirm each
// rejection path.
//
// Run: `node disclosure.test.mjs`
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import {
  G, H, ZERO, modN,
  pedersenCommit, pointToBytes, bigintToBytes32,
  bpRangeAggProve,
} from './bulletproofs.mjs';
import {
  N_BITS, T_CETCH,
  reverseBytes, assetIdFor,
  deriveEtchBlinding, deriveEtchAmountKeystream,
  encryptAmount, signSchnorr,
  encodeCEtchPayload, disclosureMsg,
} from './composition.mjs';
import { encodeEnvelopeScript, verifyDisclosure } from './indexer.mjs';

const hash160 = b => ripemd160(sha256(b));
const enc = new TextEncoder();

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

// -- Test fixtures --
// Holder privkey (d=3 — a fixed BIP-340 vector).
const HOLDER_SK = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
const HOLDER_P = secp.ProjectivePoint.BASE.multiply(3n).toRawBytes(true);
const HOLDER_XONLY = HOLDER_P.slice(1); // x-only (BIP-340 has even Y here)
const HOLDER_HASH160 = bytesToHex(hash160(HOLDER_P));

// Pretend etch reveal tx (we synthesise its commit-anchor and envelope).
const ETCH_TXID = 'a'.repeat(64);
const COMMIT_TXID = 'b'.repeat(64);
const COMMIT_VOUT = 7;
const ASSET_ID = assetIdFor(ETCH_TXID, 0); // 32 bytes

// Reproducible commit anchor (etch reveal's vin[0] = commit P2TR; commit's vin[0] = funding utxo).
const commitAnchor = concatBytes(
  reverseBytes(hexToBytes(COMMIT_TXID)),
  (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, COMMIT_VOUT, true); return b; })(),
);

// Etch supply: 1000 base units, deterministic blinding from holder priv + anchor.
const SUPPLY = 1000n;
const etchBlinding = deriveEtchBlinding(HOLDER_SK, commitAnchor);
const etchAmountKs = deriveEtchAmountKeystream(HOLDER_SK, commitAnchor);
const etchEncryptedAmount = encryptAmount(SUPPLY, etchAmountKs);
const etchProofResult = bpRangeAggProve([SUPPLY], [etchBlinding]);
const etchCommitmentBytes = pointToBytes(etchProofResult.commitments[0]);
const etchPayload = encodeCEtchPayload({
  ticker: 'TEST',
  decimals: 0,
  commitment: etchCommitmentBytes,
  rangeproof: etchProofResult.proof,
  encryptedAmount: etchEncryptedAmount,
  mintAuthority: null, // fixed-supply
  imageUri: null,
});
const etchEnvelopeScript = encodeEnvelopeScript(HOLDER_XONLY, etchPayload);

// The etch reveal tx as the verifier sees it.
const p2wpkh = (h160) => concatBytes(new Uint8Array([0x00, 0x14]), h160);
const ETCH_TX = {
  vin: [
    // vin[0] is the commit P2TR script-path; envelope is at witness[1].
    { txid: COMMIT_TXID, vout: 0, witness: [
      'aa'.repeat(64),                         // schnorr sig (placeholder)
      bytesToHex(etchEnvelopeScript),          // envelope script
      'cc'.repeat(33),                         // control block (placeholder)
    ] },
  ],
  vout: [
    // vout[0] is the supply-bearing P2WPKH (controlled by holder).
    { scriptpubkey: bytesToHex(p2wpkh(hash160(HOLDER_P))), value: 546 },
  ],
};

// --- Build the canonical valid disclosure ---
//   K = 250 (we'll prove balance ≥ 250 against the 1000-unit holding)
//   v = a_sum − K = 1000 − 250 = 750  (in [0, 2^64), so the BP can prove it)
//   r_sum = etchBlinding (single UTXO)
const K = 250n;
const v = SUPPLY - K;
const rSum = etchBlinding;
const { proof: discProof } = bpRangeAggProve([v], [rSum]);
const utxos = [{ txid: ETCH_TXID, vout: 0 }];
const baseDiscMsg = disclosureMsg(ASSET_ID, utxos, K, discProof, HOLDER_P);
const baseSig = signSchnorr(baseDiscMsg, HOLDER_SK);

const validDisclosure = {
  asset_id: bytesToHex(ASSET_ID),
  utxos,
  threshold: K.toString(),
  rangeproof: bytesToHex(discProof),
  owner_pubkey: bytesToHex(HOLDER_P),
  sig: bytesToHex(baseSig),
};

// fetchTx mock: returns the synthesised etch tx for ETCH_TXID, null otherwise.
const fetchTx = async (txid) => txid === ETCH_TXID ? ETCH_TX : null;

console.log('verifyDisclosure happy path:');
await test('valid disclosure passes',
  async () => (await verifyDisclosure(validDisclosure, fetchTx)).ok === true);

console.log('\nThreshold bounds (SPEC §5.6 req 1):');
await test('K = 0 rejects', async () => {
  const d = { ...validDisclosure, threshold: '0' };
  return (await verifyDisclosure(d, fetchTx)).ok === false;
});
await test('K = 2^64 rejects', async () => {
  const d = { ...validDisclosure, threshold: ((1n << 64n)).toString() };
  return (await verifyDisclosure(d, fetchTx)).ok === false;
});
await test('K parses but is non-integer string rejects', async () => {
  const d = { ...validDisclosure, threshold: 'abc' };
  return (await verifyDisclosure(d, fetchTx)).ok === false;
});

console.log('\nUTXO ownership + asset-id consistency (SPEC §5.6 req 2):');
await test('owner_pubkey not controlling the UTXO rejects', async () => {
  // Replace the UTXO's scriptpubkey with hash160 of a different pubkey.
  const otherP = secp.ProjectivePoint.BASE.multiply(5n).toRawBytes(true);
  const fakeFetch = async (txid) => txid !== ETCH_TXID ? null : ({
    ...ETCH_TX,
    vout: [{ scriptpubkey: bytesToHex(p2wpkh(hash160(otherP))), value: 546 }],
  });
  const r = await verifyDisclosure(validDisclosure, fakeFetch);
  return r.ok === false && /does not control/.test(r.reason);
});
await test('parent envelope advertises a different asset_id rejects', async () => {
  // Re-encode an etch with a different commit_anchor so its derived asset_id
  // differs from the one in the disclosure (asset_id is sha256(reveal_txid_BE‖0_LE),
  // independent of envelope contents — so we just lie about the asset_id field
  // in the disclosure instead).
  const wrongAid = '00'.repeat(32);
  const msg = disclosureMsg(hexToBytes(wrongAid), utxos, K, discProof, HOLDER_P);
  const sig = signSchnorr(msg, HOLDER_SK);
  const d = { ...validDisclosure, asset_id: wrongAid, sig: bytesToHex(sig) };
  const r = await verifyDisclosure(d, fetchTx);
  return r.ok === false && /asset_id mismatch/.test(r.reason);
});
await test('non-P2WPKH vout rejects', async () => {
  const fakeFetch = async () => ({
    ...ETCH_TX,
    vout: [{ scriptpubkey: '5120' + 'cc'.repeat(32), value: 546 }], // P2TR shape
  });
  const r = await verifyDisclosure(validDisclosure, fakeFetch);
  return r.ok === false && /not P2WPKH/.test(r.reason);
});
await test('parent without envelope witness rejects', async () => {
  const fakeFetch = async () => ({
    ...ETCH_TX,
    vin: [{ txid: COMMIT_TXID, vout: 0, witness: ['00'] }],
  });
  const r = await verifyDisclosure(validDisclosure, fakeFetch);
  return r.ok === false && /no envelope witness/.test(r.reason);
});

console.log('\nSchnorr signature (SPEC §5.6 req 3):');
await test('tampered sig rejects', async () => {
  const bad = bytesToHex(baseSig).slice(0, -2) + 'ff';
  const d = { ...validDisclosure, sig: bad };
  const r = await verifyDisclosure(d, fetchTx);
  return r.ok === false && /Schnorr/.test(r.reason);
});
await test('different signer key rejects (sig verifies but not under owner)', async () => {
  const otherSk = hexToBytes('0000000000000000000000000000000000000000000000000000000000000005');
  const sig = signSchnorr(baseDiscMsg, otherSk);
  const d = { ...validDisclosure, sig: bytesToHex(sig) };
  const r = await verifyDisclosure(d, fetchTx);
  return r.ok === false && /Schnorr/.test(r.reason);
});

console.log('\nBulletproof binding (SPEC §5.6 req 4):');
await test('proof tampered → C\' check rejects', async () => {
  const bytes = new Uint8Array(discProof);
  bytes[10] ^= 0x01;
  const tamperedHex = bytesToHex(bytes);
  // re-sign so we isolate the bulletproof failure (sig bytes change because the
  // proof is part of the signed msg; this isolates the bp verify path).
  const msg = disclosureMsg(ASSET_ID, utxos, K, bytes, HOLDER_P);
  const sig = signSchnorr(msg, HOLDER_SK);
  const d = { ...validDisclosure, rangeproof: tamperedHex, sig: bytesToHex(sig) };
  const r = await verifyDisclosure(d, fetchTx);
  return r.ok === false && /rangeproof/.test(r.reason);
});
await test('proof for a different K rejects against this K', async () => {
  // Build a proof for v' = a_sum − K' where K' < K.
  const wrongK = 100n;
  const wrongV = SUPPLY - wrongK;
  const { proof: pWrong } = bpRangeAggProve([wrongV], [rSum]);
  const msg = disclosureMsg(ASSET_ID, utxos, K, pWrong, HOLDER_P);
  const sig = signSchnorr(msg, HOLDER_SK);
  const d = { ...validDisclosure, rangeproof: bytesToHex(pWrong), sig: bytesToHex(sig) };
  const r = await verifyDisclosure(d, fetchTx);
  return r.ok === false && /rangeproof/.test(r.reason);
});
await test('K = a_sum (boundary, v = 0) passes', async () => {
  const Kedge = SUPPLY;
  const vedge = 0n;
  const { proof: pEdge } = bpRangeAggProve([vedge], [rSum]);
  const msg = disclosureMsg(ASSET_ID, utxos, Kedge, pEdge, HOLDER_P);
  const sig = signSchnorr(msg, HOLDER_SK);
  const d = {
    ...validDisclosure,
    threshold: Kedge.toString(),
    rangeproof: bytesToHex(pEdge),
    sig: bytesToHex(sig),
  };
  return (await verifyDisclosure(d, fetchTx)).ok === true;
});
await test('K > a_sum rejects (no proof can be built; we attempt with v that overflows)', async () => {
  // Prover claims K = SUPPLY + 1. Then v = -1 ≡ N − 1 (mod N), which is not
  // in [0, 2^64); honest BP prover would refuse. Simulate a malicious prover
  // who tries to forge a proof for v = SUPPLY (open the same C' as if K = 0):
  // C' = C_sum − (SUPPLY+1)·H = (a_sum − SUPPLY − 1)·H + r_sum·G = -H + r_sum·G,
  // which has no opening (a, r) with a ∈ [0, 2^64). The bulletproof must reject.
  const Khigh = SUPPLY + 1n;
  // Honest prover *can't* build this; but a malicious prover can submit any
  // bp bytes — the verifier should reject regardless.
  const { proof: pHonest } = bpRangeAggProve([0n], [rSum]); // proof for v=0, opens 0·H + r_sum·G ≠ C'
  const msg = disclosureMsg(ASSET_ID, utxos, Khigh, pHonest, HOLDER_P);
  const sig = signSchnorr(msg, HOLDER_SK);
  const d = {
    ...validDisclosure,
    threshold: Khigh.toString(),
    rangeproof: bytesToHex(pHonest),
    sig: bytesToHex(sig),
  };
  const r = await verifyDisclosure(d, fetchTx);
  return r.ok === false && /rangeproof/.test(r.reason);
});

console.log('\nMalformed input shapes:');
await test('asset_id not 32 hex rejects', async () => {
  const r = await verifyDisclosure({ ...validDisclosure, asset_id: 'aa' }, fetchTx);
  return r.ok === false && /asset_id/.test(r.reason);
});
await test('owner_pubkey not 33-byte compressed rejects', async () => {
  const r = await verifyDisclosure({ ...validDisclosure, owner_pubkey: '04' + 'aa'.repeat(64) }, fetchTx);
  return r.ok === false && /owner_pubkey/.test(r.reason);
});
await test('utxos empty rejects', async () => {
  const r = await verifyDisclosure({ ...validDisclosure, utxos: [] }, fetchTx);
  return r.ok === false && /utxos count/.test(r.reason);
});
await test('utxos > 64 rejects', async () => {
  const big = new Array(65).fill({ txid: '00'.repeat(32), vout: 0 });
  const r = await verifyDisclosure({ ...validDisclosure, utxos: big }, fetchTx);
  return r.ok === false && /utxos count/.test(r.reason);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
