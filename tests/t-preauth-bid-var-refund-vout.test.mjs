// Unit tests for the SPEC §5.7.12 refund-vout enforcement rule
// (validator rule 7). Mirrors the parallel-impl pattern of the other
// t-preauth-bid* tests — the production implementations are in:
//
//   • dapp/tacit.js:scanHoldings T_PREAUTH_BID_VAR branch (the
//     _isVarSettlementValid IIFE around the recovery block)
//   • worker/src/index.js:_validatePreauthBidVarRefundVout
//
// The rule: a T_PREAUTH_BID_VAR settlement is valid iff EITHER
//   (a) fill_amount == max_fill  (no refund needed — rule skipped), OR
//   (b) some vout pays exactly (max_fill - fill_amount) × price_per_unit
//       to P2WPKH(refund_script_hash) at any index.
// Settlements that violate this are griefing attempts; indexers + dapps
// silently skip them so the buyer's wallet doesn't surface a stolen
// partial fill and the seller's asset is treated as burnt.

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

// Parallel implementation mirroring worker/src/index.js:_validatePreauthBidVarRefundVout.
function validateRefundVout(decoded, tx) {
  if (!decoded || !tx) return false;
  let fillBig, maxBig, priceBig;
  try {
    fillBig = BigInt(decoded.fill_amount);
    maxBig = BigInt(decoded.max_fill);
    priceBig = BigInt(decoded.price_per_unit);
  } catch { return false; }
  if (fillBig <= 0n || maxBig <= 0n || priceBig <= 0n || fillBig > maxBig) return false;
  if (fillBig === maxBig) return true;
  const expectedRefundBig = (maxBig - fillBig) * priceBig;
  if (expectedRefundBig > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const expectedRefund = Number(expectedRefundBig);
  const refundScriptHashHex = String(decoded.refund_script_hash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(refundScriptHashHex)) return false;
  const expectedSpkHex = '0014' + refundScriptHashHex;
  for (const ov of tx.vout || []) {
    const spk = String(ov.scriptpubkey || '').toLowerCase();
    if (spk !== expectedSpkHex) continue;
    if (Number(ov.value) === expectedRefund) return true;
  }
  return false;
}

// Helper: synth a decoded payload + matching tx with the refund vout at
// a chosen index. The refund_script_hash is fixed at '11...11' (20 bytes),
// and the script is P2WPKH (0014 || hash).
function synth({ fillAmount = '500', maxFill = '1000', pricePerUnit = '12345',
                 refundScriptHash = '11'.repeat(20),
                 refundVoutIndex = 3, refundOverride = null, includeRefund = true,
                 extraVouts = [] } = {}) {
  const fillBig = BigInt(fillAmount), maxBig = BigInt(maxFill), priceBig = BigInt(pricePerUnit);
  const expectedRefund = Number((maxBig - fillBig) * priceBig);
  const refundScriptHex = '0014' + refundScriptHash;
  const vouts = [];
  // Pad with non-refund vouts up to the chosen index, then add the refund
  // vout (if includeRefund), then any extras.
  for (let i = 0; i < refundVoutIndex; i++) {
    vouts.push({ scriptpubkey: '0014' + 'aa'.repeat(20), value: 546 + i });
  }
  if (includeRefund) {
    const v = refundOverride != null ? refundOverride : expectedRefund;
    vouts.push({ scriptpubkey: refundScriptHex, value: v });
  }
  for (const v of extraVouts) vouts.push(v);
  return {
    decoded: {
      fill_amount: fillAmount,
      max_fill: maxFill,
      price_per_unit: pricePerUnit,
      refund_script_hash: refundScriptHash,
    },
    tx: { vout: vouts },
  };
}

console.log('\n=== refund-vout enforcement ===');

test('accepts valid settlement with correct refund vout', () => {
  const { decoded, tx } = synth({ fillAmount: '500', maxFill: '1000', pricePerUnit: '100', refundVoutIndex: 3 });
  // expected refund = (1000 - 500) × 100 = 50000
  return validateRefundVout(decoded, tx) === true;
});

test('accepts full-fill (fill == max) with NO refund vout', () => {
  const { decoded, tx } = synth({
    fillAmount: '1000', maxFill: '1000', pricePerUnit: '100',
    includeRefund: false, refundVoutIndex: 3,
  });
  return validateRefundVout(decoded, tx) === true;
});

test('accepts full-fill regardless of whether a stray refund-like vout exists', () => {
  // Spec §375: when fill == max, the refund-vout rule is SKIPPED — extra
  // P2WPKH outputs at the refund script don't matter.
  const { decoded, tx } = synth({
    fillAmount: '1000', maxFill: '1000', pricePerUnit: '100',
    includeRefund: true, refundOverride: 999999, refundVoutIndex: 3,
  });
  return validateRefundVout(decoded, tx) === true;
});

test('rejects when refund vout is missing entirely', () => {
  const { decoded, tx } = synth({ includeRefund: false });
  return validateRefundVout(decoded, tx) === false;
});

test('rejects when refund vout has wrong value (one sat low)', () => {
  const { decoded, tx } = synth({
    fillAmount: '500', maxFill: '1000', pricePerUnit: '100',
    refundOverride: 49999,  // expected 50000
  });
  return validateRefundVout(decoded, tx) === false;
});

test('rejects when refund vout has wrong value (one sat high)', () => {
  const { decoded, tx } = synth({
    fillAmount: '500', maxFill: '1000', pricePerUnit: '100',
    refundOverride: 50001,  // expected 50000
  });
  return validateRefundVout(decoded, tx) === false;
});

test('rejects when refund vout pays to wrong P2WPKH', () => {
  const { decoded, tx } = synth({ refundScriptHash: '11'.repeat(20) });
  // Patch the vout to a different P2WPKH but keep the value.
  const refundVoutIdx = tx.vout.findIndex(v => v.scriptpubkey.endsWith('11'.repeat(20)));
  tx.vout[refundVoutIdx].scriptpubkey = '0014' + 'bb'.repeat(20);
  return validateRefundVout(decoded, tx) === false;
});

test('accepts refund vout at vout[0] (position-independence)', () => {
  const { decoded, tx } = synth({
    fillAmount: '500', maxFill: '1000', pricePerUnit: '100',
    refundVoutIndex: 0,
  });
  return validateRefundVout(decoded, tx) === true;
});

test('accepts refund vout at vout[5] (deep position)', () => {
  const { decoded, tx } = synth({
    fillAmount: '500', maxFill: '1000', pricePerUnit: '100',
    refundVoutIndex: 5,
  });
  return validateRefundVout(decoded, tx) === true;
});

test('accepts refund vout when extra non-refund vouts trail it', () => {
  const { decoded, tx } = synth({
    fillAmount: '500', maxFill: '1000', pricePerUnit: '100',
    refundVoutIndex: 3,
    extraVouts: [
      { scriptpubkey: '0014' + 'cc'.repeat(20), value: 546 },  // seller asset change
      { scriptpubkey: '6a20' + 'dd'.repeat(32), value: 0 },     // OP_RETURN
    ],
  });
  return validateRefundVout(decoded, tx) === true;
});

test('rejects when fill_amount == 0 (malformed)', () => {
  const { decoded, tx } = synth({ fillAmount: '0', maxFill: '1000', pricePerUnit: '100' });
  return validateRefundVout(decoded, tx) === false;
});

test('rejects when fill_amount > max_fill (malformed)', () => {
  const { decoded, tx } = synth({ fillAmount: '2000', maxFill: '1000', pricePerUnit: '100' });
  return validateRefundVout(decoded, tx) === false;
});

test('rejects when refund_script_hash is malformed (not 20 bytes hex)', () => {
  const { decoded, tx } = synth();
  decoded.refund_script_hash = 'not-hex';
  return validateRefundVout(decoded, tx) === false;
});

test('rejects when refund value would overflow safe integer', () => {
  // (max_fill - fill_amount) × price_per_unit = (2^53 - 1)
  // Pick big numbers that exceed Number.MAX_SAFE_INTEGER.
  const { decoded, tx } = synth({
    fillAmount: '1', maxFill: '1000000000000', pricePerUnit: '1000000000',
  });
  return validateRefundVout(decoded, tx) === false;
});

test('exact refund value match — no rounding tolerance', () => {
  // Pin: even a 1-sat difference in the refund value invalidates the
  // settlement. No "close enough" semantics — this is consensus-grade
  // enforcement (Bitcoin-side OP_RETURN forces fill_amount; indexer
  // forces refund_value).
  const { decoded, tx } = synth({
    fillAmount: '777', maxFill: '12345', pricePerUnit: '666',
  });
  // expected = (12345 - 777) × 666 = 11568 × 666 = 7704288
  return validateRefundVout(decoded, tx) === true;
});

test('multiple refund-script-matching vouts: at least one with correct value validates', () => {
  // If a seller for some reason includes TWO P2WPKH(refund_script_hash)
  // vouts (e.g. one wrong-value, one correct-value), the rule accepts as
  // long as ONE matches. The buyer just claims the correct one off-chain.
  const { decoded, tx } = synth({
    fillAmount: '500', maxFill: '1000', pricePerUnit: '100',
    refundVoutIndex: 3, refundOverride: 99999,  // wrong-value at vout[3]
    extraVouts: [
      { scriptpubkey: '0014' + '11'.repeat(20), value: 50000 },  // correct at vout[4]
    ],
  });
  return validateRefundVout(decoded, tx) === true;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
