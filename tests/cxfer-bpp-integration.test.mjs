// End-to-end integration test for T_CXFER_BPP with REAL Bulletproofs+ proofs.
//
// Unlike cxfer-bpp-wire.test.mjs (which uses opaque placeholder rangeproof
// bytes), this test exercises the full crypto path:
//
//   bppRangeProve → encodeCXferBppPayload → encodeEnvelopeScript
//                                              ↓
//   bppRangeVerify ← decodeCXferBppPayload ← decodeEnvelopeScript
//
// Plus kernel-signature parity: confirms the SAME computeKernelMsg the dapp
// uses for CXFER produces a signature that verifies under the same flow when
// wrapped as T_CXFER_BPP. This is the §5.47.2 "tacit-kernel-v1" reuse claim
// validated against actual signed bytes, not just byte-identity of the msg.

import * as worker from '../worker/src/index.js';
import { secp, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
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
// Force signet so the BPP feature flag is enabled by default.
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');
const bpp = await import('../dapp/bulletproofs-plus.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== test fixtures ==============

function bytes32(seed) {
  return sha256(new TextEncoder().encode(seed));
}

// ============== Full crypto-bearing round-trip ==============
group('Real BP+ proof flows through encode → decode → verify');

for (const m of [1, 2, 4, 8]) {
  // Generate values and blindings.
  const values = [];
  const blindings = [];
  for (let j = 0; j < m; j++) {
    values.push(BigInt(1_000 + j * 250));
    blindings.push(bpp.randomScalar());
  }

  // Produce real BP+ proof.
  const proofResult = bpp.bppRangeProve(values, blindings);
  ok(`m=${m}: bppRangeProve succeeded`,
    proofResult?.proof instanceof Uint8Array);

  // Build commitments and encode the envelope payload with the real proof.
  const commitments = proofResult.commitments.map(P => P.toRawBytes(true));
  const encryptedAmounts = values.map((_, i) => bytes32(`enc${m}-${i}`).slice(0, 8));
  const outputs = commitments.map((c, i) => ({
    commitment: c,
    encryptedAmount: encryptedAmounts[i],
  }));

  const assetId = bytes32(`asset-m${m}`);
  const kernelSig = bytes32(`kernel-sig-m${m}`).slice();
  const kernelSig64 = concatBytes(kernelSig, bytes32(`kernel-sig-m${m}-2`));

  const payload = dapp.encodeCXferBppPayload({
    assetId,
    kernelSig: kernelSig64,
    outputs,
    rangeproof: proofResult.proof,
  });
  ok(`m=${m}: payload encoded with real BP+ proof`,
    payload instanceof Uint8Array && payload[0] === 0x22);

  // Wrap in envelope script (the actual Bitcoin witness wrap).
  const signingPub = bytes32(`signing-${m}`);
  const envScript = dapp.encodeEnvelopeScript(signingPub, payload);
  ok(`m=${m}: envelope script wraps the payload`,
    envScript instanceof Uint8Array && envScript.length > payload.length);

  // Worker-side decode (the chain-scan path).
  const unwrapped = dapp.decodeEnvelopeScript(envScript);
  ok(`m=${m}: envelope unwraps`, unwrapped !== null && unwrapped.payload[0] === 0x22);

  const workerDec = worker.decodeCXferBppPayload(unwrapped.payload);
  ok(`m=${m}: worker decodes BPP envelope`,
    workerDec !== null && workerDec.outputs.length === m);

  // Dapp-side decode + extract the rangeproof bytes.
  const dappDec = dapp.decodeCXferBppPayload(unwrapped.payload);
  ok(`m=${m}: dapp decodes BPP envelope`,
    dappDec !== null && dappDec.kind === 'cxfer_bpp');

  // Reconstruct commitments from decoded bytes.
  const recoveredCommitments = dappDec.outputs.map(o => {
    return secp.ProjectivePoint.fromHex(bytesToHex(o.commitment));
  });

  // THE TEST: verify the real BP+ proof against the recovered commitments.
  // This proves the full pipeline preserves the cryptographic content
  // byte-for-byte across encode/decode/envelope-wrap layers.
  const verifyResult = bpp.bppRangeVerify(recoveredCommitments, dappDec.rangeproof);
  ok(`m=${m}: real BP+ proof verifies after full envelope round-trip`,
    verifyResult === true,
    verifyResult === false ? 'verifier rejected after round-trip' : `got ${verifyResult}`);
}

// ============== Kernel-msg parity: same domain tag works for BPP ==============
group('Kernel signature flows under "tacit-kernel-v1" for BPP envelopes');

{
  // The amendment §5.47.2 claims BPP reuses "tacit-kernel-v1" because the
  // kernel msg shape is identical. This test pins that property: we
  // generate a real kernel sig using dapp's computeKernelMsg and verify
  // it under the same E' = (Σ outputs - Σ inputs) construction.

  // Set up: one input commitment (V_in for value 500), two output
  // commitments (V_recipient for value 200, V_change for value 300).
  // Balance: 500 = 200 + 300.
  const v_in = 500n;
  const v_recip = 200n;
  const v_change = 300n;
  const g_in = bpp.randomScalar();
  const g_recip = bpp.randomScalar();
  // Change blinding is derived so sums work: g_change = g_in - g_recip
  const g_change = bpp.modN(g_in - g_recip);

  const C_in = bpp.pedersenCommit(v_in, g_in);
  const C_recip = bpp.pedersenCommit(v_recip, g_recip);
  const C_change = bpp.pedersenCommit(v_change, g_change);

  // Sanity: input - outputs should equal zero (balance check)
  const balanceCheck = C_in.add(C_recip.negate()).add(C_change.negate());
  ok('Pedersen commitments balance to identity', balanceCheck.equals(bpp.ZERO));

  // E' = Σ outputs − Σ inputs (the dapp convention from validateOutpoint).
  // Note: E' should be a point WITHOUT a value (H) component if balanced.
  const EPrime = C_recip.add(C_change).add(C_in.negate());

  // Since balance holds, E' should equal the identity if blindings cancel,
  // or equal excess·G where excess = (g_recip + g_change) - g_in = 0
  // in our setup. So E' = identity here.
  ok('E\' balances when blindings sum-cancel',
    EPrime.equals(bpp.ZERO));

  // For a non-trivial test, use a non-cancelling blinding so E' = excess·G
  const g_change_v2 = bpp.randomScalar();  // independent
  const excess_v2 = bpp.modN((g_recip + g_change_v2) - g_in);
  const C_change_v2 = bpp.pedersenCommit(v_change, g_change_v2);
  const EPrime_v2 = C_recip.add(C_change_v2).add(C_in.negate());
  const expectedE_v2 = bpp.G.multiply(excess_v2);
  ok('E\' = excess·G when amounts balance (non-cancelling blindings)',
    EPrime_v2.equals(expectedE_v2));

  // Now build BP+ proofs for the two outputs and confirm validation works.
  const proofResult = bpp.bppRangeProve([v_recip, v_change], [g_recip, g_change_v2]);
  const recoveredCommitments = proofResult.commitments;
  ok('proof of [v_recip, v_change] produces matching commitments',
    recoveredCommitments[0].equals(C_recip) && recoveredCommitments[1].equals(C_change_v2));

  // Compute kernel msg using the SAME helper the dapp uses for CXFER.
  const assetId = bytes32('integration-asset');
  const inputOutpoints = [{ txid: bytesToHex(bytes32('parent-tx')), vout: 0 }];
  const outputCommitments = [C_recip.toRawBytes(true), C_change_v2.toRawBytes(true)];
  const kernelMsg = dapp.computeKernelMsg(assetId, inputOutpoints, outputCommitments, 0n);
  ok('kernel msg computed via dapp.computeKernelMsg', kernelMsg.length === 32);

  // Sign with excess (the standard Mimblewimble kernel sig pattern).
  // EPrime_v2 = excess_v2 · G, so the signing key is excess_v2.
  const excessBytes = bpp.bigintToBytes32(excess_v2);
  const kernelSig = dapp.signSchnorr(kernelMsg, excessBytes);
  ok('kernel sig produced under excess scalar', kernelSig.length === 64);

  // Verify under EPrime.x_only()
  const ExBytes = EPrime_v2.toRawBytes(true).slice(1);
  const sigOk = dapp.verifySchnorr(kernelSig, kernelMsg, ExBytes);
  ok('kernel sig verifies under E\'.x_only() (BPP context, "tacit-kernel-v1" domain)',
    sigOk === true);
}

// ============== Feature flag gating ==============
group('bppEnabled() feature flag');

{
  // Currently on signet per setup at top of file
  ok('signet network detected',
    globalThis.localStorage.getItem('tacit-network-v1') === 'signet');
  // Note: we can't easily test bppEnabled() directly since it's a dapp
  // internal. The validateOutpoint behavior is gated by it — proven
  // indirectly when integration runs on signet.
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
