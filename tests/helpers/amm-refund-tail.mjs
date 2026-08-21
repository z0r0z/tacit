// Canonical refund tail for the AMM envelope + kernel builders.
//
// lp-add (both variants), farm-init and lp-bond bind a refund destination into the signed kernel
// message: refund_expiry(4 LE) ‖ refund_dest_xonly(32) ‖ refund_blinding(32). A losing or expired
// leg returns its funding to that destination instead of being skipped after its inputs are retired.
// The builders reject a missing tail, so every test that constructs one of those envelopes spreads
// this object. The worker spells the deadline `expiryHeight` and the dapp spells it `refundExpiry`;
// both names carry the same value here so the object spreads into either API.
const dest = new Uint8Array(32);
const blinding = new Uint8Array(32);
for (let i = 0; i < 32; i++) { dest[i] = i + 1; blinding[i] = 0x40 + i; }

// The two families spell the tail differently and are NOT interchangeable:
//   farm-init / lp-bond : refund_expiry ‖ refund_dest_xonly(32) ‖ refund_blinding(32)  — one funded side.
//   lp-add / POOL_INIT  : expiry_height ‖ refund_a_blinding(32) ‖ refund_b_blinding(32) — both sides, each
//                         bound by its own kernel; the destination rides the kernel, not the envelope.
const blindingB = new Uint8Array(32);
for (let i = 0; i < 32; i++) blindingB[i] = 0x80 + i;

export const TEST_REFUND_EXPIRY = 900000;

export const TEST_REFUND_TAIL = Object.freeze({
  refundExpiry: TEST_REFUND_EXPIRY,
  expiryHeight: TEST_REFUND_EXPIRY,
  refundDestXonly: dest,
  refundBlinding: blinding,
});

export const TEST_LP_ADD_REFUND_TAIL = Object.freeze({
  expiryHeight: TEST_REFUND_EXPIRY,
  refundABlinding: blinding,
  refundBBlinding: blindingB,
});
