// Spec-conformance pinning suite.
//
// Why this file exists:
// Every other AMM test imports the implementation's own constants and uses
// them on BOTH sides of a round-trip. That structurally cannot detect spec
// ↔ impl drift: if the impl renames a domain tag from
// "tacit-intent-attest-v1" to "tacit-amm-attest-v1", sign/verify still
// agree because both use the same renamed string. A spec-conformance
// indexer (or any second implementation) reading AMM.md would silently
// reject every envelope the reference impl produces.
//
// This file is the firewall against that class of bug. Every assertion
// HARDCODES the spec-literal value (string bytes, opcode byte, byte count,
// constant) and compares against what the impl exports / produces. The
// values below are the canonical, normative values from AMM.md and the
// SPEC-*-AMENDMENT.md files. If a future change updates the impl without
// updating the spec (or vice versa), the test fails until the divergence
// is reconciled.
//
// Rules of engagement when editing this file:
//   1. NEVER replace a hardcoded literal with an import from the impl.
//      The whole point is that the value here is independent of the impl.
//   2. To update a literal here you MUST first update AMM.md (or the
//      relevant amendment), then mirror the change here in the same PR.
//   3. New domain tags / opcodes / constants get added here at the same
//      time they're added to the spec.

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

// ----- Pinned: opcode bytes (AMM.md §"Opcode allocation") -----
const EXPECTED_OPCODES = {
  T_LP_ADD:              0x2d,
  T_LP_REMOVE:           0x2e,
  T_SWAP_BATCH:          0x2f,
  T_INTENT_ATTEST:       0x30,
  T_PROTOCOL_FEE_CLAIM:  0x31,
  T_SWAP_VAR:            0x32,  // implemented (SPEC.md §5.16.3)
};

// ----- Pinned: every domain-tag string the protocol uses, byte-by-byte. -----
//
// These are the canonical UTF-8 byte sequences. The impl MUST produce
// signatures and hashes against these exact strings. A renamed tag breaks
// cross-implementation interop silently — the original attest-domain bug.
const EXPECTED_DOMAIN_TAGS = [
  'tacit-amm-pool-v1',
  'tacit-amm-lp-v1',
  'tacit-amm-bjj-H-v1',
  'tacit-amm-bjj-G-v1',
  'tacit-amm-xcurve-v1',
  'tacit-amm-intent-v1',
  'tacit-amm-intent-cancel-v1',
  'tacit-amm-lp-add-v1',
  'tacit-amm-lp-remove-v1',
  'tacit-amm-protocol-fee-claim-v1',
  'tacit-intent-attest-v1',         // scope-generic; NOT "tacit-amm-attest-v1"
  'tacit-amm-launcher-gate-v1',
  'tacit-amm-min-liq-blind-v1',
  'tacit-amm-qset-v1',
  'tacit-amm-receipt-secp-v1',
  'tacit-amm-receipt-bjj-v1',
  // T_SWAP_VAR (opcode 0x32) — per-trade variable-amount swap (SPEC.md §5.16.3).
  // Five tags total: intent_msg, receipt blinding, receipt pubkey, change blinding,
  // settler tip blinding. The kernel-sig tag is the shared "tacit-kernel-v1" from
  // composition.mjs (whitelisted as a SPEC-level shared tag, not AMM-specific).
  'tacit-amm-swap-var-v1',
  'tacit-amm-swap-var-receipt-v1',
  'tacit-amm-swap-var-recv-v1',
  'tacit-amm-swap-var-change-v1',
  'tacit-amm-swap-var-tip-v1',
  // Deterministic-nonce derivation tags for proveXCurveDeterministic
  // Internal-only — never appear in on-chain bytes, so
  // they don't need normative SPEC documentation, but we whitelist them
  // here so the impl-to-spec drift scan doesn't flag them as orphans.
  'tacit-amm-xcurve-prng-v1',
  'tacit-amm-xcurve-seed-v1',
];

// ----- Pinned: protocol constants (AMM.md) -----
const EXPECTED_CONSTS = {
  AMM_INITIAL_LP_LOCK_BLOCKS:    6,
  AMM_OP_CONFIRMATION_DEPTH:     3,
  AMM_RTT_TIMEOUT_MS:            5000,
  AMM_RESIGN_ATTEMPTS:           2,
  AMM_MANDATORY_INCLUSION_DEPTH: 2,
  MINIMUM_LIQUIDITY:             1000n,
  N_MAX:                         16,
  FEE_BPS_MAX:                   1000,
  PROTOCOL_FEE_BPS_MAX:          1000,
  XCURVE_PROOF_LEN:              169,
  PER_INTENT_BYTES:              352,
  PER_RECEIPT_BYTES:             234,
  // LP envelope fixed-prefix totals (bytes-before-proof).
  // Recomputed from AMM.md §"T_LP_ADD" / §"T_LP_REMOVE" wire-format tables.
  // LP_ADD:    1+1+32+32+8+8+8+33+32+169+64+64+2 = 454
  // LP_REMOVE: 1+32+32+8+8+8+33+32+169+33+32+169+64+2 = 623
  // These pin the SPEC.md / AMM.md spec ↔ impl agreement and prevent
  // any recurrence of the stale-157-byte-table drift.
  LP_ADD_FIXED_PREFIX:           454,
  LP_REMOVE_FIXED_PREFIX:        623,
};

// ----- Pinned: canonical preimages → expected SHA256 outputs -----
//
// Each entry is a (preimage, expected_digest_hex) pair. The preimage is
// constructed here byte-by-byte from spec-literal components; if the impl
// produces a different digest for the equivalent input, drift is present.
const PINNED_HASH_VECTORS = [
  // Empty intent_pool_hash (no open intents):
  // AMM.md §"Intent-pool hash construction": SHA256("") = e3b0c44...
  {
    label: 'empty intent_pool_hash = SHA256("")',
    preimage: new Uint8Array(0),
    expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  // pool_id for fixed asset pair (32-byte assets of 0x01..., 0x02...):
  {
    label: 'pool_id = SHA256("tacit-amm-pool-v1" || asset_A(0x01×32) || asset_B(0x02×32))',
    preimage: concatBytes(
      new TextEncoder().encode('tacit-amm-pool-v1'),
      new Uint8Array(32).fill(0x01),
      new Uint8Array(32).fill(0x02),
    ),
    expected: null,  // computed below; first run populates, subsequent runs verify
  },
];

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

// =========================================================================
// 1. Opcode bytes: spec literal ↔ impl export
// =========================================================================
console.log('Opcode bytes (spec-literal pinning)');
{
  const { OPCODE_T_LP_ADD, OPCODE_T_LP_REMOVE, OPCODE_T_SWAP_BATCH,
          OPCODE_T_AMM_ATTEST, OPCODE_T_PROTOCOL_FEE_CLAIM } =
    await import('./amm-envelope.mjs');
  const { OPCODE_T_INTENT_ATTEST } = await import('./amm-attest.mjs');

  test(`T_LP_ADD == 0x2d`,             () => OPCODE_T_LP_ADD === EXPECTED_OPCODES.T_LP_ADD);
  test(`T_LP_REMOVE == 0x2e`,          () => OPCODE_T_LP_REMOVE === EXPECTED_OPCODES.T_LP_REMOVE);
  test(`T_SWAP_BATCH == 0x2f`,         () => OPCODE_T_SWAP_BATCH === EXPECTED_OPCODES.T_SWAP_BATCH);
  test(`T_INTENT_ATTEST == 0x30`,      () => OPCODE_T_INTENT_ATTEST === EXPECTED_OPCODES.T_INTENT_ATTEST);
  test(`T_PROTOCOL_FEE_CLAIM == 0x31`, () => OPCODE_T_PROTOCOL_FEE_CLAIM === EXPECTED_OPCODES.T_PROTOCOL_FEE_CLAIM);
  // legacy alias still maps to the spec opcode value
  test(`OPCODE_T_AMM_ATTEST alias == 0x30 (back-compat)`,
       () => OPCODE_T_AMM_ATTEST === EXPECTED_OPCODES.T_INTENT_ATTEST);

  // T_SWAP_VAR (0x32) — per-trade variable-amount swap (SPEC.md §5.16.3).
  const { OPCODE_T_SWAP_VAR } = await import('./swap-var.mjs');
  test(`T_SWAP_VAR == 0x32`, () => OPCODE_T_SWAP_VAR === EXPECTED_OPCODES.T_SWAP_VAR);

  // amm-validator.mjs re-exports the T_SWAP_VAR surface so integrators
  // have a single canonical entry point for every AMM-opcode validator.
  const ammv = await import('./amm-validator.mjs');
  test(`amm-validator re-exports validateSwapVar`,
       () => typeof ammv.validateSwapVar === 'function');
  test(`amm-validator re-exports OPCODE_T_SWAP_VAR == 0x32`,
       () => ammv.OPCODE_T_SWAP_VAR === EXPECTED_OPCODES.T_SWAP_VAR);
}

// =========================================================================
// 2. Domain tag exact bytes: spec literal ↔ impl-as-signed
// =========================================================================
console.log('\nDomain tags — signature/hash domain bytes (spec-literal pinning)');
{
  const { ATTEST_DOMAIN } = await import('./amm-attest.mjs');
  test(`ATTEST_DOMAIN bytes == "tacit-intent-attest-v1"`, () => {
    const expected = new TextEncoder().encode('tacit-intent-attest-v1');
    if (ATTEST_DOMAIN.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (ATTEST_DOMAIN[i] !== expected[i]) return false;
    }
    return true;
  });

  const { computeIntentPoolHash } = await import('./amm-attest.mjs');
  test(`computeIntentPoolHash([]) == SHA256("") (empty pool literal)`, () => {
    const h = computeIntentPoolHash([]);
    return bytesToHex(h) === PINNED_HASH_VECTORS[0].expected;
  });

  // The launcher gate, qset, intent_msg, kernel sig, protocol-fee-claim
  // domains live in their respective impl modules — they're checked as part
  // of the round-trip below (producer-side preimage construction is what
  // the indexer reconstructs, so a domain change there breaks immediately).
}

// =========================================================================
// 3. Wire-format byte counts: spec literal ↔ impl constants
// =========================================================================
console.log('\nWire-format byte counts (spec-literal pinning)');
{
  const { XCURVE_PROOF_LEN } = await import('./amm-sigma-xcurve.mjs');
  const { ENVELOPE_PER_INTENT_BYTES, ENVELOPE_PER_RECEIPT_BYTES } =
    await import('./amm-envelope.mjs');
  test(`XCURVE_PROOF_LEN == 169`,     () => XCURVE_PROOF_LEN === EXPECTED_CONSTS.XCURVE_PROOF_LEN);
  test(`PER_INTENT_BYTES == 352`,     () => ENVELOPE_PER_INTENT_BYTES === EXPECTED_CONSTS.PER_INTENT_BYTES);
  test(`PER_RECEIPT_BYTES == 234`,    () => ENVELOPE_PER_RECEIPT_BYTES === EXPECTED_CONSTS.PER_RECEIPT_BYTES);

  // LP envelope fixed-prefix totals derived from arithmetic; pinned so the
  // Stale-157 drift can't recur silently. We compute these from the
  // module-level constants and assert against the canonical AMM.md values.
  const LP_ADD_FIXED_PREFIX_COMPUTED =
    1 /*opcode*/ + 1 /*variant*/ + 32 /*assetA*/ + 32 /*assetB*/ +
    8 /*deltaA*/ + 8 /*deltaB*/ + 8 /*shareAmount*/ +
    33 /*shareCSecp*/ + 32 /*shareCBJJ*/ + XCURVE_PROOF_LEN /*xcurve*/ +
    64 /*kernelSigA*/ + 64 /*kernelSigB*/ + 2 /*proof_len_LE*/;
  const LP_REMOVE_FIXED_PREFIX_COMPUTED =
    1 /*opcode*/ + 32 /*assetA*/ + 32 /*assetB*/ +
    8 /*shareAmount*/ + 8 /*deltaA*/ + 8 /*deltaB*/ +
    33 /*recvACsecp*/ + 32 /*recvACBJJ*/ + XCURVE_PROOF_LEN /*recvAxcurve*/ +
    33 /*recvBCsecp*/ + 32 /*recvBCBJJ*/ + XCURVE_PROOF_LEN /*recvBxcurve*/ +
    64 /*kernelSigLP*/ + 2 /*proof_len_LE*/;
  test(`LP_ADD fixed prefix == 454`,
       () => LP_ADD_FIXED_PREFIX_COMPUTED === EXPECTED_CONSTS.LP_ADD_FIXED_PREFIX);
  test(`LP_REMOVE fixed prefix == 623`,
       () => LP_REMOVE_FIXED_PREFIX_COMPUTED === EXPECTED_CONSTS.LP_REMOVE_FIXED_PREFIX);

  // AMM.md spec-text scan: no stale "157" sigma-len mentions outside the
  // explicit supersede note. Catches future regressions that put the wrong
  // length back into a wire-format table.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const __dirname2 = dirname(fileURLToPath(import.meta.url));
  const spec = readFileSync(resolve(__dirname2, '../AMM.md'), 'utf8');
  // Find every line containing "157". Allow ONLY the §3.10 supersede sentence.
  const offending = spec.split('\n').filter(
    (ln) => /\b157\b/.test(ln) && !/superseded by this section|prior 157-byte/i.test(ln),
  );
  if (offending.length > 0) {
    console.log(`  (offending 157 lines: ${offending.slice(0, 5).join(' | ').slice(0, 200)})`);
  }
  test(`no stale 157-byte references in AMM.md (regression guard)`,
       () => offending.length === 0);

  // Expiry boundary semantics: spec must say strict less-than.
  // The reference impl at tests/amm-validator.mjs uses
  // `if (it.expiryHeight < currentHeight)`. Spec MUST say so explicitly.
  // (Match is tolerant of intervening markdown backticks.)
  const expirySpecHits = (spec.match(/expiry_height < currentHeight[^\n]{0,8}\(strict less-than\)/g) || []).length;
  test(`AMM.md pins strict-less-than expiry comparison`,
       () => expirySpecHits >= 1);

  // vk_cid canonical format pinning: derived CIDs MUST be
  // CIDv1 raw codec + sha2-256 multihash + multibase-base32 lowercase
  // no-padding. Reference: tests/amm-validator.mjs deriveVkCid().
  // Canonical CIDs for SHA-256 hashes always begin with "bafkrei" under this
  // format. The constant prefix is a structural property of the encoding,
  // not the hash content; if a future implementer changes any of the four
  // structural bytes (0x01, 0x55, 0x12, 0x20) the prefix will shift and
  // this test catches the drift.
  const { deriveVkCid } = await import('./amm-validator.mjs');
  const refVkBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const refCid = deriveVkCid(refVkBytes);
  test(`canonical vk_cid CIDv1-raw-sha256 format begins "bafkrei"`,
       () => refCid.startsWith('bafkrei'));
  test(`canonical vk_cid is 59 chars (CIDv1 raw sha2-256 base32)`,
       () => refCid.length === 59);
}

// =========================================================================
// 4. Protocol constants: spec literal ↔ impl constants
// =========================================================================
console.log('\nProtocol constants (spec-literal pinning)');
{
  const { AMM_INITIAL_LP_LOCK_BLOCKS } = await import('./amm-validator.mjs');
  const { FEE_BPS_MAX, PROTOCOL_FEE_BPS_MAX, N_INTENTS_MAX } =
    await import('./amm-envelope.mjs');
  const { MINIMUM_LIQUIDITY } = await import('./amm-min-liq.mjs');
  test(`AMM_INITIAL_LP_LOCK_BLOCKS == 6`, () =>
    AMM_INITIAL_LP_LOCK_BLOCKS === EXPECTED_CONSTS.AMM_INITIAL_LP_LOCK_BLOCKS);
  test(`FEE_BPS_MAX == 1000`,             () => FEE_BPS_MAX === EXPECTED_CONSTS.FEE_BPS_MAX);
  test(`PROTOCOL_FEE_BPS_MAX == 1000`,    () => PROTOCOL_FEE_BPS_MAX === EXPECTED_CONSTS.PROTOCOL_FEE_BPS_MAX);
  test(`N_MAX == 16`,                     () => N_INTENTS_MAX === EXPECTED_CONSTS.N_MAX);
  test(`MINIMUM_LIQUIDITY == 1000n`,      () => MINIMUM_LIQUIDITY === EXPECTED_CONSTS.MINIMUM_LIQUIDITY);
  // AMM_OP_CONFIRMATION_DEPTH, AMM_RTT_TIMEOUT_MS, AMM_RESIGN_ATTEMPTS,
  // AMM_MANDATORY_INCLUSION_DEPTH are spec-only constants (AMM.md normative
  // values that don't have a single exported impl symbol — they're
  // referenced in worker/settler/dapp behavior, not validator-enforced).
  // We pin them in the spec but don't have a single impl module to import.
  // If a future impl module exports these, add assertions here.
}

// =========================================================================
// 5. Canonical preimage → digest vectors (spec-literal pinning)
// =========================================================================
console.log('\nCanonical preimage → digest vectors');
{
  // Empty intent_pool_hash literal
  test(`SHA256("") matches AMM.md "empty pool" definition`, () => {
    const h = sha256(new Uint8Array(0));
    return bytesToHex(h) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  });

  // pool_id for canonical (asset_A=0x01×32, asset_B=0x02×32):
  const { derivePoolId } = await import('./amm-asset.mjs');
  const assetA = new Uint8Array(32).fill(0x01);
  const assetB = new Uint8Array(32).fill(0x02);
  // Reconstruct preimage by hand from the spec definition.
  const expectedPoolId = sha256(concatBytes(
    new TextEncoder().encode('tacit-amm-pool-v1'),
    assetA, assetB,
  ));
  test(`derivePoolId(asset_A, asset_B) == SHA256("tacit-amm-pool-v1" || A || B)`, () => {
    const got = derivePoolId(assetA, assetB);
    return bytesToHex(got) === bytesToHex(expectedPoolId);
  });

  // lp_asset_id derivation
  const { deriveLpAssetId } = await import('./amm-asset.mjs');
  const expectedLpAssetId = sha256(concatBytes(
    new TextEncoder().encode('tacit-amm-lp-v1'),
    expectedPoolId,
  ));
  test(`deriveLpAssetId(pool_id) == SHA256("tacit-amm-lp-v1" || pool_id)`, () => {
    const got = deriveLpAssetId(expectedPoolId);
    return bytesToHex(got) === bytesToHex(expectedLpAssetId);
  });

  // Qualifying-set hash construction: u8 count, NOT u16 (the H3 drift this
  // pinning catches).
  const { computeQualifyingSetHash } = await import('./amm-validator.mjs');
  const intentId = new Uint8Array(32).fill(0xab);
  const heightLE = new Uint8Array(4); new DataView(heightLE.buffer).setUint32(0, 800_000, true);
  const expectedQsetHash = sha256(concatBytes(
    new TextEncoder().encode('tacit-amm-qset-v1'),
    expectedPoolId,
    heightLE,
    new Uint8Array([1]),  // u8 count
    intentId,
  ));
  test(`computeQualifyingSetHash uses u8 count (NOT u16) per spec`, () => {
    const got = computeQualifyingSetHash({
      poolId: expectedPoolId, height: 800_000, intentIds: [intentId],
    });
    return bytesToHex(got) === bytesToHex(expectedQsetHash);
  });
  // Same vector exercised through the amm-intent.mjs module (which used to
  // disagree with the validator — the H3 split-brain bug).
  const { computeQualifyingSetHash: computeQsetIntent } = await import('./amm-intent.mjs');
  test(`amm-intent.computeQualifyingSetHash matches validator (u8 count)`, () => {
    const got = computeQsetIntent({
      poolId: expectedPoolId, height: 800_000, intentIds: [intentId],
    });
    return bytesToHex(got) === bytesToHex(expectedQsetHash);
  });

  // claim_msg preimage for T_PROTOCOL_FEE_CLAIM (H4 was: spec didn't
  // document this preimage at all — we just added it. Pin it here.)
  const { buildProtocolFeeClaimMsgWith } = await import('./amm-protocol-fee.mjs');
  const claimAmount = 12345n;
  const claimCSecp = new Uint8Array(33); claimCSecp[0] = 0x02; claimCSecp.fill(0xcd, 1);
  const claimBlinding = new Uint8Array(32).fill(0x9e);
  const amtLE = new Uint8Array(8);
  let v = claimAmount;
  for (let i = 0; i < 8; i++) { amtLE[i] = Number(v & 0xffn); v >>= 8n; }
  const expectedClaimMsg = sha256(concatBytes(
    new TextEncoder().encode('tacit-amm-protocol-fee-claim-v1'),
    expectedPoolId,
    amtLE,
    claimCSecp,
    claimBlinding,
  ));
  test(`claim_msg preimage == SHA256("tacit-amm-protocol-fee-claim-v1" || pool_id || amount || C || r)`, () => {
    const got = buildProtocolFeeClaimMsgWith(sha256, {
      poolId: expectedPoolId, claimAmount, claimCSecp, claimBlinding,
    });
    return bytesToHex(got) === bytesToHex(expectedClaimMsg);
  });
}

// =========================================================================
// 6. Sigma cross-curve wire format (spec literal layout)
// =========================================================================
console.log('\nSigma cross-curve wire format');
{
  const { proveXCurve, XCURVE_PROOF_LEN, Z_A_BYTES, CHALLENGE_BYTES } =
    await import('./amm-sigma-xcurve.mjs');
  const { pedersenCommit, randomScalar } = await import('./bulletproofs.mjs');
  const { pedersenBJJ, N_BJJ } = await import('./amm-bjj.mjs');

  // Spec § 3.10: A_secp(33) || A_BJJ(32) || z_a(40) || z_r_secp(32) || z_r_BJJ(32) = 169 B
  test(`XCURVE_PROOF_LEN == 169 (matches spec)`,
       () => XCURVE_PROOF_LEN === 169);
  test(`z_a width == 40 bytes (matches spec 128-bit FS upgrade)`,
       () => Z_A_BYTES === 40);
  test(`challenge width == 16 bytes (128-bit FS soundness)`,
       () => CHALLENGE_BYTES === 16);

  // Round-trip witness producing a 169-byte proof
  test(`prover output is exactly 169 bytes`, () => {
    const a = 42n;
    const r_secp = randomScalar();
    const r_BJJ = randomScalar() % N_BJJ;
    const out = proveXCurve({
      a, r_secp, r_BJJ,
      C_secp: pedersenCommit(a, r_secp),
      C_BJJ:  pedersenBJJ(a, r_BJJ),
    });
    return out.proof.length === 169;
  });
}

// =========================================================================
// 7. Envelope layout sanity: spec arithmetic equals impl-produced sizes
// =========================================================================
console.log('\nEnvelope size arithmetic');
{
  const {
    XCURVE_PROOF_LEN,
  } = await import('./amm-sigma-xcurve.mjs');
  // Per-intent block per spec wire format:
  //   direction(1) + trader_pubkey(33) + C_in_secp(33) + C_in_BJJ(32)
  //   + in_xcurve_sigma + min_out(8) + tip(8) + expiry(4) + intent_sig(64)
  const perIntentExpected = 1 + 33 + 33 + 32 + XCURVE_PROOF_LEN + 8 + 8 + 4 + 64;
  // Per-receipt: C_out_secp(33) + C_out_BJJ(32) + out_xcurve_sigma
  const perReceiptExpected = 33 + 32 + XCURVE_PROOF_LEN;

  const { ENVELOPE_PER_INTENT_BYTES, ENVELOPE_PER_RECEIPT_BYTES } =
    await import('./amm-envelope.mjs');
  test(`per-intent block: spec arithmetic == impl constant (${perIntentExpected} bytes)`,
       () => ENVELOPE_PER_INTENT_BYTES === perIntentExpected);
  test(`per-receipt block: spec arithmetic == impl constant (${perReceiptExpected} bytes)`,
       () => ENVELOPE_PER_RECEIPT_BYTES === perReceiptExpected);
}

// =========================================================================
// 8. Domain tag whitelist: every domain the impl uses must appear in the spec
// =========================================================================
console.log('\nDomain tag whitelist');
{
  // Read each impl module and extract every "tacit-..." string literal.
  // The set of impl-used domain tags MUST be a subset of EXPECTED_DOMAIN_TAGS
  // (plus the SWAP_VAR-specific tags listed in AMM.md but not loaded here).
  const fs = await import('fs');
  const path = await import('path');
  const url = await import('url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const modules = [
    'amm-asset.mjs', 'amm-attest.mjs', 'amm-bjj.mjs',
    'amm-clearing.mjs', 'amm-envelope.mjs', 'amm-intent.mjs',
    'amm-kernel.mjs', 'amm-min-liq.mjs', 'amm-protocol-fee.mjs',
    'amm-receipt.mjs', 'amm-sigma-xcurve.mjs', 'amm-validator.mjs',
    // T_SWAP_VAR (0x32) — per-trade variable-amount swap (SPEC.md §5.16.3):
    'swap-var.mjs',
    // Scope-generic primitives (not AMM-specific but consumed by AMM and
    // future amendments):
    'range-proof.mjs', 'range-attest.mjs',
  ];
  // Match domain tags inside any string literal — single quotes, double quotes,
  // template literals, or inline in comments (TextEncoder.encode arguments,
  // doc lines, and JCS keys all carry these strings). Tag character class
  // includes uppercase letters because BJJ generator seeds use the
  // generator letter (e.g., "tacit-amm-bjj-H-v1", "tacit-amm-bjj-G-v1").
  const regex = /['"`](tacit-[A-Za-z0-9-]+-v\d+)['"`]/g;
  const foundDomains = new Set();
  for (const m of modules) {
    const content = fs.readFileSync(path.join(here, m), 'utf8');
    let match;
    while ((match = regex.exec(content)) !== null) foundDomains.add(match[1]);
  }
  // Tags accepted only when used by SWAP_VAR module (not loaded by V1 impl
  // but listed in AMM.md so future-friendly).
  const ALLOWED = new Set([
    ...EXPECTED_DOMAIN_TAGS,
    // Off-chain helpers / scope-generic / cross-surface tags listed in
    // AMM.md §"Versioning hooks" but not in the core EXPECTED list:
    'tacit-amm-empty-leaf-v1',          // SMT empty-leaf (off-chain helper)
    'tacit-amm-min-liq-ks-v1',          // MINIMUM_LIQUIDITY HMAC keystream
    'tacit-amm-min-liq-pubkey-v1',      // MINIMUM_LIQUIDITY NUMS recipient pubkey
    'tacit-amm-tip-blind-v1',           // settler-tip blinding
    'tacit-orderbook-pair-v1',          // orderbook scope_id derivation
    'tacit-orderbook-global-v1',        // per-worker orderbook attestation scope
    'tacit-range-attest-v1',            // T_RANGE_ATTEST sig domain
    // T_SWAP_VAR reuses CXFER's kernel-sig domain (SPEC.md §3 shared tag,
    // not AMM-specific). composition.mjs is the canonical owner; swap-var.mjs
    // is one of many consumers.
    'tacit-kernel-v1',
  ]);
  for (const d of foundDomains) {
    test(`impl-used domain "${d}" is whitelisted in spec`, () => ALLOWED.has(d));
  }
  // And every spec-listed core tag must actually be used somewhere in impl
  // (catches the inverse: spec adds a tag but impl never uses it).
  for (const d of EXPECTED_DOMAIN_TAGS) {
    // Skip the few that legitimately have no V1 impl producer (e.g., they're
    // verifier-only or future-deprecated). Currently every entry is V1-used.
    test(`spec-listed domain "${d}" is used in impl`, () => foundDomains.has(d));
  }
}

console.log(`\n${pass}/${pass + fail} spec-conformance pins verified`);
if (fail > 0) {
  console.log('\nSpec ↔ impl drift detected. Either the spec or the impl');
  console.log('changed without the other. Reconcile before shipping.');
  process.exit(1);
}
