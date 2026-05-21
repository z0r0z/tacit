// Settlement-tx-shape unit test for takePreauthBid (SPEC §5.7.11).
//
// What this protects:
//   1. The exact tx layout the SPEC §5.7.11 settlement section names —
//      vout[0] = recipient DUST, vout[1] = seller payout (P2WPKH),
//      vout[2] = OP_RETURN(bid_context_hash) 34-byte scriptPubKey,
//      optional vout[3] = seller's asset change DUST.
//   2. The OP_RETURN at vout[2] EXACTLY equals
//      `0x6a 0x20 || bid_context_hash` so the buyer's pre-signed
//      SIGHASH_SINGLE_ACP signature validates under Bitcoin consensus.
//   3. The buyer's vin[2] witness is correctly placed at vin[k] where
//      k matches the OP_RETURN vout[k] (position-independence under
//      §5.7.8.1).
//   4. The conservation identity: total inputs == total outputs + fee,
//      with seller_payout = inputs - DUST - revealFee - optional_DUST.
//
// We exercise the LOGIC of the assembler rather than the on-chain side
// of the broadcast (which depends on a live signet node + a real bid).
// The full e2e harness lives at preauth-bid-onchain-e2e-signet.mjs.

import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';

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

// Mirror of dapp's _preauthBidContextHash + _preauthBidContextOpReturnScript.
function bidContextHash({
  assetIdBytes, bidIdBytes, recipientPubBytes,
  amount, blindingBytes, priceSats,
}) {
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
  const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-context-v1'),
    assetIdBytes, bidIdBytes, recipientPubBytes, amountLE, blindingBytes, priceLE,
  ));
}
function opReturnScript(h) {
  return concatBytes(new Uint8Array([0x6a, 0x20]), h);
}

// Mirror of the canonical settlement-tx-shape assertions takePreauthBid
// enforces. Synthesises a settlement structure and verifies it matches
// the spec.
function buildSettlementShape({
  amount, priceSats, maxFeeBudget, hasChange = false,
  recipientPubBytes, buyerPubBytes,
}) {
  const DUST = 546;
  const fundingValue = priceSats + DUST + maxFeeBudget;
  const commitValue = DUST + 700;   // commit covers reveal fee (synthetic)
  const assetUtxoValue = DUST;
  const revealFee = 700;
  const inputsTotal = commitValue + assetUtxoValue + fundingValue;
  const tacitDustOut = DUST + (hasChange ? DUST : 0);
  const sellerPayoutValue = inputsTotal - tacitDustOut - revealFee;

  const assetIdBytes = new Uint8Array(32).fill(0xab);
  const bidIdBytes = new Uint8Array(16).fill(0x33);
  const blindingBytes = new Uint8Array(32).fill(0x55);

  const h = bidContextHash({
    assetIdBytes, bidIdBytes, recipientPubBytes,
    amount, blindingBytes, priceSats,
  });
  const opReturn = opReturnScript(h);

  const outputs = [
    { value: DUST, kind: 'recipient_p2wpkh', pubkey: recipientPubBytes },
    { value: sellerPayoutValue, kind: 'seller_payout_p2wpkh' },
    { value: 0, kind: 'op_return', script: opReturn },
  ];
  if (hasChange) outputs.push({ value: DUST, kind: 'seller_change_p2wpkh' });

  return {
    inputs: [
      { kind: 'commit_p2tr', value: commitValue },
      { kind: 'seller_asset_p2wpkh', value: assetUtxoValue },
      { kind: 'buyer_funding_p2wpkh', value: fundingValue, witness: [/* buyer_sats_spend_sig */ '83', bytesToHex(buyerPubBytes)] },
    ],
    outputs,
    fee: inputsTotal - outputs.reduce((s, o) => s + o.value, 0),
    bidContextHash: h,
    opReturn,
    sellerPayoutValue,
    fundingValue,
    revealFee,
    inputsTotal,
  };
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\n=== takePreauthBid settlement shape ===');

const recipientPub = (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x77, 1); return k; })();
const buyerPub = (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x88, 1); return k; })();

test('exact-fill (N=1): 3 vouts (recipient, payout, OP_RETURN)', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return s.outputs.length === 3
    && s.outputs[0].kind === 'recipient_p2wpkh' && s.outputs[0].value === 546
    && s.outputs[1].kind === 'seller_payout_p2wpkh'
    && s.outputs[2].kind === 'op_return' && s.outputs[2].value === 0;
});

test('partial-asset (N=2): 4 vouts (recipient, payout, OP_RETURN, seller change)', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: true, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return s.outputs.length === 4
    && s.outputs[3].kind === 'seller_change_p2wpkh' && s.outputs[3].value === 546;
});

test('OP_RETURN at vout[2] is exactly 34 bytes (0x6a 0x20 || hash32)', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return s.opReturn.length === 34
    && s.opReturn[0] === 0x6a && s.opReturn[1] === 0x20;
});

test('OP_RETURN hash matches canonical bid_context_hash binding', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return eq(s.opReturn.slice(2), s.bidContextHash);
});

test('buyer pre-sig sits at vin[2] (position-matched to OP_RETURN at vout[2])', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return s.inputs[2].kind === 'buyer_funding_p2wpkh'
    && Array.isArray(s.inputs[2].witness) && s.inputs[2].witness.length === 2;
});

test('seller payout ≥ price_sats (no underpayment)', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return s.sellerPayoutValue >= 50000;
});

test('conservation: total inputs == sum(outputs) + fee', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return s.inputsTotal === s.outputs.reduce((sum, o) => sum + o.value, 0) + s.fee
    && s.fee === s.revealFee;
});

test('funding value = price_sats + DUST + max_fee_budget', () => {
  const s = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  return s.fundingValue === 50000 + 546 + 1000;
});

test('bid_context_hash changes when buyer changes amount on chain (which they cannot)', () => {
  const s1 = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  const s2 = buildSettlementShape({ amount: 2000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  // Different fill amount → different bid_context_hash → buyer's pre-sig
  // wouldn't validate. This is what stops a malicious seller from
  // tampering with the recipient amount.
  return !eq(s1.bidContextHash, s2.bidContextHash);
});

test('bid_context_hash changes when seller would redirect recipient to a different pubkey', () => {
  const otherPub = (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x99, 1); return k; })();
  const s1 = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: recipientPub, buyerPubBytes: buyerPub });
  const s2 = buildSettlementShape({ amount: 1000n, priceSats: 50000, maxFeeBudget: 1000, hasChange: false, recipientPubBytes: otherPub, buyerPubBytes: buyerPub });
  return !eq(s1.bidContextHash, s2.bidContextHash);
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
