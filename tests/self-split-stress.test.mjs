// Stress test for the "split airdrop into 100 batches by sending to self"
// failure mode reported on the dapp. Builds 100 sequential self-CXFER
// transactions — each consuming the prior tx's leftmost asset output and
// producing 7 self-recipient outputs + 1 self-change (m=8 aggregation).
// After every step we verify:
//   1. bulletproof rangeproof verifies over the 8 output commitments.
//   2. kernel sig over E' = ΣC_out − ΣC_in verifies (Pedersen conservation).
//   3. amounts decrypt + Pedersen commitments open via ECDH/self derivations.
// If the protocol math is sound, all 100 steps + every recovered amount pass.
// Any failure isolates a real encoder/prover/verifier bug, not a UI flake.
//
// Run: `node self-split-stress.test.mjs`
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';
import {
  G, H, ZERO, modN, randomScalar,
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
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const enc = new TextEncoder();
const ASSET_ID = sha256(enc.encode('SELF_SPLIT_STRESS_ASSET'));

// Single self-wallet (sender == every recipient).
const SELF_PRIV = hexToBytes('beef'.padEnd(64, '0').slice(0, 64));
const SELF_PUB = secp.getPublicKey(SELF_PRIV, true);

// Fake-but-unique anchor per step (= prior tx's first asset outpoint).
function makeAnchor(txidHex, vout) {
  return concatBytes(
    reverseBytes(hexToBytes(txidHex)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, vout >>> 0, true); return b; })(),
  );
}
function fakeTxid(seed) {
  // Deterministic txid from seed so the chain is reproducible.
  return bytesToHex(sha256(enc.encode(`tx-${seed}`)));
}

// Build one self-CXFER step.
//   input UTXO:  { txid, vout, amount, blinding } at some earlier point
//   output:      m=8 outputs all to SELF_PUB; K=7 recipients + 1 change + 0 padding
// Returns the on-chain payload + the recipient/change opening tables so the
// next step can pick any output to spend.
function buildSelfCxferStep(inputUtxo, stepTxid, stepName) {
  const K = 7;                       // 7 self-recipients
  const m = 8;                       // change at vout=7, no padding
  const anchor = makeAnchor(inputUtxo.txid, inputUtxo.vout);

  // Realistic "airdrop fulfillment" split: 7 small recipient amounts (1 unit
  // each as a placeholder for "one airdrop allocation per leaf") and a fat
  // change UTXO that carries the rest. The chain advances by consuming the
  // change at vout=K each step — same topology as an issuer fulfilling 100
  // separate airdrop batches, where every batch is bounded by the issuer's
  // remaining treasury but never drains it.
  const recipientAmounts = Array.from({ length: K }, () => 1n);
  const totalSendAmt = recipientAmounts.reduce((s, a) => s + a, 0n);
  if (inputUtxo.amount <= totalSendAmt) {
    throw new Error(`step ${stepName}: input ${inputUtxo.amount} too small for K=7 distribution`);
  }
  const changeAmt = inputUtxo.amount - totalSendAmt;

  // Output amounts + blindings (sender == recipient == self).
  const amounts = [];
  const blindings = [];
  const keystreams = [];
  for (let i = 0; i < K; i++) {
    amounts.push(recipientAmounts[i]);
    blindings.push(deriveBlinding(SELF_PRIV, SELF_PUB, anchor, i));
    keystreams.push(deriveAmountKeystreamECDH(SELF_PRIV, SELF_PUB, anchor, i));
  }
  // Change at vout=K
  amounts.push(changeAmt);
  blindings.push(deriveChangeBlinding(SELF_PRIV, anchor, K));
  keystreams.push(deriveAmountKeystreamSelf(SELF_PRIV, anchor, K));

  // Aggregated bulletproof over all m=8 outputs.
  const { proof: aggProof, commitments } = bpRangeAggProve(amounts, blindings);
  const commitmentBytesList = commitments.map(pointToBytes);

  // Kernel sig
  const blindingSum = blindings.reduce((s, b) => modN(s + b), 0n);
  const excess = modN(blindingSum - inputUtxo.blinding);
  const inputOutpoints = [{ txid: inputUtxo.txid, vout: inputUtxo.vout }];
  const kernelMsg = computeKernelMsg(ASSET_ID, inputOutpoints, commitmentBytesList);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));

  // Per-output ciphertexts.
  const cts = amounts.map((a, i) => encryptAmount(a, keystreams[i]));

  // Wire payload + decode for round-trip sanity.
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
    stepName,
    inputUtxo,
    txid: stepTxid,
    payload,
    amounts,
    blindings,
    commitments,
    commitmentBytesList,
    aggProof,
    kernelSig,
    inputOutpoints,
    // The 8 output UTXOs become eligible inputs for downstream steps.
    outputs: amounts.map((amount, vout) => ({
      txid: stepTxid, vout, amount, blinding: blindings[vout],
    })),
  };
}

// =========== ROOT: pretend CETCH emitted a single 10000-unit UTXO ===========
const ROOT_TXID = fakeTxid('cetch-root');
// Big treasury so 100 batches of 7-unit distributions never run out.
const ROOT_AMOUNT = 1_000_000n;
const ROOT_BLINDING = randomScalar();
let currentUtxo = {
  txid: ROOT_TXID,
  vout: 0,
  amount: ROOT_AMOUNT,
  blinding: ROOT_BLINDING,
};

const TARGET_STEPS = 100;
console.log(`${TARGET_STEPS} sequential self-CXFER batches:`);
const steps = [];
for (let i = 0; i < TARGET_STEPS; i++) {
  const stepTxid = fakeTxid(`step-${i}`);
  const step = buildSelfCxferStep(currentUtxo, stepTxid, `step-${i}`);
  steps.push(step);
  // Consume the change output (vout=K=7) as input for the next step. This
  // linearises ancestry — every leaf-recipient output sits at the tip of a
  // chain whose length equals the number of fulfilment batches the issuer
  // has broadcast so far. Worst-case topology for the BFS validator.
  currentUtxo = step.outputs[7];
}
console.log(`  built ${steps.length} self-CXFER steps; chain depth = ${steps.length}`);
console.log(`  final change = ${currentUtxo.amount} of ${ROOT_AMOUNT} (sent ${ROOT_AMOUNT - currentUtxo.amount})`);

// =========== Per-step protocol verification ===========
console.log('\nPer-step rangeproof verify:');
test(`all ${steps.length} rangeproofs verify`, () => {
  for (let i = 0; i < steps.length; i++) {
    if (!bpRangeAggVerify(steps[i].commitments, steps[i].aggProof)) {
      console.log(`    step ${i} rangeproof FAILED`);
      return false;
    }
  }
  return true;
});

console.log('\nPer-step Pedersen conservation + kernel sig:');
test(`all ${steps.length} kernel sigs verify under E' = ΣC_out − ΣC_in`, () => {
  // Walk in order; ΣC_in = inputUtxo's commitment (recomputed from amount+blinding).
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const inputCommit = pedersenCommit(s.inputUtxo.amount, s.inputUtxo.blinding);
    let EPrime = ZERO;
    for (const C of s.commitments) EPrime = EPrime.add(C);
    EPrime = EPrime.add(inputCommit.negate());
    if (EPrime.equals(ZERO)) { console.log(`    step ${i} E' = ZERO`); return false; }
    const xonly = EPrime.toRawBytes(true).slice(1);
    const msg = computeKernelMsg(ASSET_ID, s.inputOutpoints, s.commitmentBytesList);
    if (!verifySchnorr(s.kernelSig, msg, xonly)) {
      console.log(`    step ${i} kernel sig FAILED`);
      return false;
    }
  }
  return true;
});

console.log('\nPer-step decode round-trip:');
test(`all ${steps.length} payloads decode + N=8`, () => {
  for (let i = 0; i < steps.length; i++) {
    const dec = decodeCXferPayload(steps[i].payload);
    if (!dec) { console.log(`    step ${i} decode failed`); return false; }
    if (dec.outputs.length !== 8) { console.log(`    step ${i} N=${dec.outputs.length}`); return false; }
    if (bytesToHex(dec.assetId) !== bytesToHex(ASSET_ID)) { console.log(`    step ${i} asset_id mismatch`); return false; }
  }
  return true;
});

console.log('\nRecipient-side recovery (sender == recipient == self):');
test(`every output at every step recovers via ECDH or self-derivation`, () => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const anchor = makeAnchor(s.inputUtxo.txid, s.inputUtxo.vout);
    for (let v = 0; v < 8; v++) {
      const onChainC = s.commitments[v];
      // Try as recipient (ECDH against own pubkey since sender == self).
      let recovered = null;
      {
        const ks = deriveAmountKeystreamECDH(SELF_PRIV, SELF_PUB, anchor, v);
        const candidate = decryptAmount(_extractCt(s.payload, v), ks);
        if (candidate >= 0n && candidate < (1n << 64n)) {
          const r = deriveBlinding(SELF_PRIV, SELF_PUB, anchor, v);
          if (pedersenCommit(candidate, r).equals(onChainC)) recovered = { amount: candidate, blinding: r, path: 'ecdh' };
        }
      }
      if (!recovered) {
        const ks = deriveAmountKeystreamSelf(SELF_PRIV, anchor, v);
        const candidate = decryptAmount(_extractCt(s.payload, v), ks);
        if (candidate >= 0n && candidate < (1n << 64n)) {
          const r = deriveChangeBlinding(SELF_PRIV, anchor, v);
          if (pedersenCommit(candidate, r).equals(onChainC)) recovered = { amount: candidate, blinding: r, path: 'self' };
        }
      }
      if (!recovered) { console.log(`    step ${i} vout ${v}: NEITHER ecdh NOR self-derivation recovered the opening`); return false; }
      if (recovered.amount !== s.amounts[v]) { console.log(`    step ${i} vout ${v}: amount mismatch ${recovered.amount} vs ${s.amounts[v]}`); return false; }
    }
  }
  return true;
});

// Extract the encryptedAmount ciphertext for vout from a CXFER payload.
// Mirrors decodeCXferPayload's structure but pulled out so the test reads as
// a single linear pass rather than calling decode + re-extracting.
function _extractCt(payload, vout) {
  const dec = decodeCXferPayload(payload);
  return dec.outputs[vout].encryptedAmount;
}

console.log('\nConservation: total balance preserved through the chain:');
test(`Σ outputs at every step = input amount`, () => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const sumOut = s.amounts.reduce((a, b) => a + b, 0n);
    if (sumOut !== s.inputUtxo.amount) {
      console.log(`    step ${i}: ΣC_out amount = ${sumOut} but input = ${s.inputUtxo.amount}`);
      return false;
    }
  }
  return true;
});

console.log('\n----');
console.log(`${pass} passed, ${fail} failed.`);
if (fail > 0) process.exitCode = 1;
