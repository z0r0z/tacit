// Tests for the multi-UTXO consolidate-and-list path added to the dapp's
// "Publish listing" handler. Two layers:
//   1. Pure UTXO-selection algorithm — given a fragmented wallet, the picker
//      must return the right input set for every (amount, holdings) case the
//      dapp form can produce.
//   2. End-to-end CXFER cryptography at K=1, m=2, multi-input — the actual
//      shape the dapp's `buildAndBroadcastCXferMulti` produces for a list-
//      sized carve. Verifies the rangeproof, kernel sig, decode round-trip,
//      and recipient-side opening recovery still hold when:
//        a) the change output is 0 (Σinputs == listAmount exactly), and
//        b) the input set has many inputs (4, 16) feeding a single recipient.
//
// Run: `node list-consolidate.test.mjs`
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';
import {
  ZERO, modN, randomScalar,
  pedersenCommit, pointToBytes, bigintToBytes32,
  bpRangeAggProve, bpRangeAggVerify,
} from './bulletproofs.mjs';
import {
  reverseBytes,
  deriveBlinding, deriveChangeBlinding,
  deriveAmountKeystreamECDH, deriveAmountKeystreamSelf,
  encryptAmount, decryptAmount,
  signSchnorr, verifySchnorr,
  encodeCXferPayload, decodeCXferPayload,
  computeKernelMsg,
} from './composition.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}\n${e.stack || ''}`); fail++;
  }
}

const enc = new TextEncoder();
const ASSET_ID = sha256(enc.encode('LIST_CONSOLIDATE_TEST_ASSET'));
const SELF_PRIV = hexToBytes('cafe'.padEnd(64, '0').slice(0, 64));
const SELF_PUB = secp.getPublicKey(SELF_PRIV, true);

// ============== PART 1: UTXO selection algorithm ==============
// Mirrors the picker in dapp/tacit.js (renderHoldings → list-sale form).
// availableUtxos must be sorted descending by amount and already filtered
// for listed/intent-locked tags.
function pickCoverUtxos(availableUtxos, amount) {
  const availLargest = availableUtxos[0]?.amount || 0n;
  if (amount <= availLargest) {
    const single = [...availableUtxos].reverse().find(u => u.amount >= amount);
    if (!single) throw new Error('no UTXO large enough');
    return [single];
  }
  const out = [];
  let sum = 0n;
  for (const u of availableUtxos) {
    out.push(u);
    sum += u.amount;
    if (sum >= amount) break;
  }
  return out;
}
function makeUtxos(amounts) {
  // Returns descending-sorted UTXOs (matches sortedUtxos in the dapp).
  return amounts
    .map((a, i) => ({ amount: BigInt(a), tag: `u${i}` }))
    .sort((a, b) => a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0);
}
function tagsOf(picked) { return picked.map(u => u.tag); }

console.log('UTXO-selection algorithm:');

test('exact-match path is handled upstream — picker returns smallest covering single', () => {
  const utxos = makeUtxos([10, 7, 5, 3]);
  const picked = pickCoverUtxos(utxos, 7n);
  // amount=7 ≤ largest=10 → single-cover branch. Smallest ≥7 is the 7-UTXO.
  return picked.length === 1 && picked[0].amount === 7n;
});

test('single UTXO covers (amount < largest, no consolidation)', () => {
  const utxos = makeUtxos([20, 7, 5, 3]);
  const picked = pickCoverUtxos(utxos, 15n);
  // Smallest single covering 15 is the 20-UTXO. Existing behavior preserved.
  return picked.length === 1 && picked[0].amount === 20n;
});

test('user-reported example: 3,5,7,8 → list 23 picks all 4 (sum=23, exact)', () => {
  const utxos = makeUtxos([8, 7, 5, 3]);
  const picked = pickCoverUtxos(utxos, 23n);
  return picked.length === 4 &&
         picked.reduce((s, u) => s + u.amount, 0n) === 23n &&
         JSON.stringify(tagsOf(picked).sort()) === JSON.stringify(['u0', 'u1', 'u2', 'u3'].sort());
});

test('greedy descending picks smallest input count (list 15 of [3,5,7,8] → [8,7])', () => {
  const utxos = makeUtxos([8, 7, 5, 3]);
  const picked = pickCoverUtxos(utxos, 15n);
  return picked.length === 2 && picked[0].amount === 8n && picked[1].amount === 7n;
});

test('over-cover with change (list 14 of [3,5,7,8] → [8,7], sum 15, change 1)', () => {
  const utxos = makeUtxos([8, 7, 5, 3]);
  const picked = pickCoverUtxos(utxos, 14n);
  const sum = picked.reduce((s, u) => s + u.amount, 0n);
  return picked.length === 2 && sum === 15n && sum > 14n;
});

test('many tiny UTXOs (16 × 1 unit, list 16) — picks all 16', () => {
  const utxos = makeUtxos(Array(16).fill(1));
  const picked = pickCoverUtxos(utxos, 16n);
  return picked.length === 16 && picked.reduce((s, u) => s + u.amount, 0n) === 16n;
});

test('insufficient holdings caller-guarded — picker walks all if sum < amount', () => {
  const utxos = makeUtxos([3, 2, 1]);
  // amount=10, availTotal=6. The dapp's outer code blocks this via the
  // `amount > availTotal` check; the picker itself just exhausts.
  const picked = pickCoverUtxos(utxos, 10n);
  return picked.length === 3 && picked.reduce((s, u) => s + u.amount, 0n) === 6n;
});

// ============== PART 2: end-to-end CXFER crypto at K=1, m=2 ==============
// This is the actual shape the dapp produces when listing a fragmented
// wallet: many inputs → one exact-size recipient (vout 0, for listing) +
// one change (vout 1, possibly 0). Build it like buildAndBroadcastCXferMulti
// does, then verify every protocol invariant.
function makeAnchor(txidHex, vout) {
  return concatBytes(
    reverseBytes(hexToBytes(txidHex)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, vout >>> 0, true); return b; })(),
  );
}
function fakeTxid(seed) {
  return bytesToHex(sha256(enc.encode(`utxo-${seed}`)));
}
// Mint a synthetic asset UTXO with known opening (amount, blinding). Stands
// in for the wallet's existing pre-fragmentation holdings.
function mintInputUtxo(seed, amount) {
  return {
    utxo: { txid: fakeTxid(seed), vout: 0 },
    amount: BigInt(amount),
    blinding: randomScalar(),
  };
}
// Build a K=1, m=2 CXFER from N inputs (all owned by self) to a single
// self-recipient of amount=listAmount, with change at vout=1.
function buildMultiInputCxfer(pickedInputs, listAmount) {
  const K = 1;
  const m = 2;
  const inAmt = pickedInputs.reduce((s, u) => s + u.amount, 0n);
  const inBlindingSum = pickedInputs.reduce((s, u) => modN(s + BigInt(u.blinding)), 0n);
  const changeAmt = inAmt - listAmount;
  if (changeAmt < 0n) throw new Error('test setup: insufficient inputs');

  // Anchor = first asset input's outpoint (matches dapp).
  const firstIn = pickedInputs[0].utxo;
  const anchor = makeAnchor(firstIn.txid, firstIn.vout);

  // Output 0 = list-sized recipient (ECDH-derived, since recipient == self).
  // Output 1 = change (self-derived).
  const amounts = [listAmount, changeAmt];
  const blindings = [
    deriveBlinding(SELF_PRIV, SELF_PUB, anchor, 0),
    deriveChangeBlinding(SELF_PRIV, anchor, 1),
  ];
  const keystreams = [
    deriveAmountKeystreamECDH(SELF_PRIV, SELF_PUB, anchor, 0),
    deriveAmountKeystreamSelf(SELF_PRIV, anchor, 1),
  ];

  const { proof: aggProof, commitments } = bpRangeAggProve(amounts, blindings);
  const commitmentBytesList = commitments.map(pointToBytes);
  const blindingSum = blindings.reduce((s, b) => modN(s + b), 0n);
  const excess = modN(blindingSum - inBlindingSum);
  const inputOutpoints = pickedInputs.map(u => ({ txid: u.utxo.txid, vout: u.utxo.vout }));
  const kernelMsg = computeKernelMsg(ASSET_ID, inputOutpoints, commitmentBytesList);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));
  const cts = amounts.map((a, i) => encryptAmount(a, keystreams[i]));
  const payload = encodeCXferPayload({
    assetId: ASSET_ID,
    kernelSig,
    outputs: amounts.map((_, i) => ({
      commitment: commitmentBytesList[i],
      encryptedAmount: cts[i],
    })),
    rangeproof: aggProof,
  });
  return {
    payload, amounts, blindings, commitments, commitmentBytesList,
    aggProof, kernelSig, inputOutpoints, inAmt, anchor, K, m,
  };
}
// Re-do the verifier's check that all pickedInputs sum to a consistent
// blinding+amount via E' = Σout − Σin.
function verifyCxfer(built, pickedInputs) {
  // Rangeproof.
  if (!bpRangeAggVerify(built.commitments, built.aggProof)) return 'rangeproof fail';
  // Decode round-trip.
  const dec = decodeCXferPayload(built.payload);
  if (!dec) return 'decode null';
  if (dec.outputs.length !== built.m) return `N=${dec.outputs.length} != ${built.m}`;
  if (bytesToHex(dec.assetId) !== bytesToHex(ASSET_ID)) return 'asset_id mismatch';
  // Kernel sig under E' = ΣC_out − ΣC_in.
  let EPrime = ZERO;
  for (const C of built.commitments) EPrime = EPrime.add(C);
  for (const u of pickedInputs) {
    const Cin = pedersenCommit(u.amount, u.blinding);
    EPrime = EPrime.add(Cin.negate());
  }
  if (EPrime.equals(ZERO)) return 'E_prime is identity (no scalar to verify)';
  const xonly = EPrime.toRawBytes(true).slice(1);
  const msg = computeKernelMsg(ASSET_ID, built.inputOutpoints, built.commitmentBytesList);
  if (!verifySchnorr(built.kernelSig, msg, xonly)) return 'kernel sig fail';
  // Output[0] (the listing UTXO) recovers via ECDH from self->self.
  const ks0 = deriveAmountKeystreamECDH(SELF_PRIV, SELF_PUB, built.anchor, 0);
  const amt0 = decryptAmount(dec.outputs[0].encryptedAmount, ks0);
  if (amt0 !== built.amounts[0]) return `vout 0 amount recover ${amt0} vs ${built.amounts[0]}`;
  const r0 = deriveBlinding(SELF_PRIV, SELF_PUB, built.anchor, 0);
  if (!pedersenCommit(amt0, r0).equals(built.commitments[0])) return 'vout 0 commit mismatch';
  // Output[1] (change) recovers via self-keystream.
  const ks1 = deriveAmountKeystreamSelf(SELF_PRIV, built.anchor, 1);
  const amt1 = decryptAmount(dec.outputs[1].encryptedAmount, ks1);
  if (amt1 !== built.amounts[1]) return `vout 1 amount recover ${amt1} vs ${built.amounts[1]}`;
  const r1 = deriveChangeBlinding(SELF_PRIV, built.anchor, 1);
  if (!pedersenCommit(amt1, r1).equals(built.commitments[1])) return 'vout 1 commit mismatch';
  return null;
}

console.log('\nMulti-input CXFER (K=1, m=2) cryptography:');

test('single-cover (1 input, change > 0) — old auto-split path still works', () => {
  const inputs = [mintInputUtxo('single-20', 20)];
  const built = buildMultiInputCxfer(inputs, 15n);
  const err = verifyCxfer(built, inputs);
  if (err) { console.log(`    ${err}`); return false; }
  return built.amounts[0] === 15n && built.amounts[1] === 5n;
});

test('4 inputs summing exactly to listAmount (3+5+7+8=23) — change = 0', () => {
  const inputs = [
    mintInputUtxo('exact-8', 8),
    mintInputUtxo('exact-7', 7),
    mintInputUtxo('exact-5', 5),
    mintInputUtxo('exact-3', 3),
  ];
  const built = buildMultiInputCxfer(inputs, 23n);
  const err = verifyCxfer(built, inputs);
  if (err) { console.log(`    ${err}`); return false; }
  return built.amounts[0] === 23n && built.amounts[1] === 0n;
});

test('4 inputs with non-zero change (list 20 of [3,5,7,8], picked [8,7,5]=20, change 0)', () => {
  // Greedy descending: 8 → 15 → 20. Sum exactly 20, change 0.
  const inputs = [
    mintInputUtxo('chg-a-8', 8),
    mintInputUtxo('chg-a-7', 7),
    mintInputUtxo('chg-a-5', 5),
  ];
  const built = buildMultiInputCxfer(inputs, 20n);
  const err = verifyCxfer(built, inputs);
  if (err) { console.log(`    ${err}`); return false; }
  return built.amounts[1] === 0n;
});

test('multi-input with non-zero change (list 14 of [8,7], change 1)', () => {
  const inputs = [
    mintInputUtxo('chg-b-8', 8),
    mintInputUtxo('chg-b-7', 7),
  ];
  const built = buildMultiInputCxfer(inputs, 14n);
  const err = verifyCxfer(built, inputs);
  if (err) { console.log(`    ${err}`); return false; }
  return built.amounts[1] === 1n;
});

test('16 inputs of 1 unit each, list 16 — sum exact, change 0', () => {
  const inputs = Array.from({ length: 16 }, (_, i) => mintInputUtxo(`tiny-${i}`, 1));
  const built = buildMultiInputCxfer(inputs, 16n);
  const err = verifyCxfer(built, inputs);
  if (err) { console.log(`    ${err}`); return false; }
  return built.amounts[0] === 16n && built.amounts[1] === 0n;
});

test('payload tampering (flip listing amount ct) is detected', () => {
  const inputs = [
    mintInputUtxo('tamper-8', 8),
    mintInputUtxo('tamper-7', 7),
    mintInputUtxo('tamper-5', 5),
    mintInputUtxo('tamper-3', 3),
  ];
  const built = buildMultiInputCxfer(inputs, 23n);
  // Flip one bit inside the encrypted amount of vout 0 to simulate corruption.
  // The on-chain kernel sig is over the COMMITMENTS, not the encrypted
  // amounts, so flipping the ct doesn't break the kernel sig — but the
  // recipient-side recovery (decrypt → pedersen.open) must catch it.
  const dec = decodeCXferPayload(built.payload);
  const ctMut = new Uint8Array(dec.outputs[0].encryptedAmount);
  ctMut[0] ^= 0xff;
  const ks0 = deriveAmountKeystreamECDH(SELF_PRIV, SELF_PUB, built.anchor, 0);
  const recoveredWrong = decryptAmount(ctMut, ks0);
  const r0 = deriveBlinding(SELF_PRIV, SELF_PUB, built.anchor, 0);
  // Either the decrypted amount is now wrong, or it falsely "decrypts" but
  // doesn't open the Pedersen commitment. Either way the recipient detects.
  if (recoveredWrong === 23n) return false; // surprise: tamper round-tripped
  if (pedersenCommit(recoveredWrong, r0).equals(built.commitments[0])) return false;
  return true;
});

test('balance: Σoutputs (incl. 0-change) = Σinputs at every shape', () => {
  for (const [holdings, want] of [
    [[20], 15n],
    [[8, 7, 5, 3], 23n],
    [[8, 7, 5, 3], 18n],
    [[1, 1, 1, 1, 1, 1, 1, 1], 8n],
  ]) {
    const inputs = holdings.map((a, i) => mintInputUtxo(`bal-${holdings.join('-')}-${i}`, a));
    const built = buildMultiInputCxfer(inputs, want);
    const inSum = inputs.reduce((s, u) => s + u.amount, 0n);
    const outSum = built.amounts.reduce((s, a) => s + a, 0n);
    if (inSum !== outSum) {
      console.log(`    holdings=${holdings} want=${want}: in=${inSum} out=${outSum}`);
      return false;
    }
  }
  return true;
});

// ============== Combined integration: picker → CXFER → verify ==============
console.log('\nIntegration: picker output → CXFER build → full verification:');

test('user-reported example end-to-end: holdings [3,5,7,8], list 23', () => {
  const utxos = makeUtxos([8, 7, 5, 3]).map(u => ({
    ...mintInputUtxo(`integ-${u.amount}`, Number(u.amount)),
    amount: u.amount,
  }));
  // Treat as "available", sorted descending. picker returns selected inputs.
  const availableUtxos = utxos.map(u => ({ amount: u.amount, _u: u }));
  const pickedRefs = pickCoverUtxos(availableUtxos, 23n);
  const pickedInputs = pickedRefs.map(p => p._u);
  if (pickedInputs.length !== 4) return false;
  const built = buildMultiInputCxfer(pickedInputs, 23n);
  return verifyCxfer(built, pickedInputs) === null;
});

console.log('\n----');
console.log(`${pass} passed, ${fail} failed.`);
if (fail > 0) process.exitCode = 1;
