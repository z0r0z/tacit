// Unit tests for the buyer-watchtower bid policy gate (fulfiller/bid-policy.mjs).
//
// This is the soundness core of the walk-away revamp. The watchtower is the
// online party that releases the buyer's sats only when a seller fill is
// acceptable. Bitcoin can't bind "sats released <=> asset delivered" for a
// Pedersen-hidden amount, so the daemon must enforce the buyer's terms itself:
//   1. delivery (handled by verifyAxferOffer in the dapp — Pedersen opening to
//      the buyer's recipient), and
//   2. price/size policy (this module): unit price <= ceiling, cumulative <= cap.
//
// The drain this guards against: the policy was originally checked only against
// the worker's LIST record, while settlement uses the GET-by-id record. A worker
// that lists an attractive price but serves a worse one on GET-by-id would slip
// past the stale gate and overpay from the bid wallet. The daemon now re-applies
// this exact gate to the record it is about to settle; the divergence cases
// below pin that the over-price / under-deliver records are rejected.
//
// Run: `node tests/buyer-watchtower-policy.test.mjs`

import { evalBidPolicy } from '../fulfiller/bid-policy.mjs';

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

// Baseline policy: 25 sats/unit ceiling, decimals=0, cap 300 base units, nothing
// filled yet. Mirrors the signet e2e harness daemon config.
const base = { maxUnitPriceSats: 25, decimals: 0, maxTotalFillBase: 300n, filledBase: 0n };

// ---- the honest fill (list == settled) ----
test('accepts a fill within price + fill caps', () => {
  const r = evalBidPolicy({ amount: '300', price_sats: 6000 }, base); // 20 sats/unit
  return r.ok === true && r.amt === 300n && r.price === 6000;
});

test('accepts exactly at the unit-price ceiling', () => {
  const r = evalBidPolicy({ amount: '300', price_sats: 7500 }, base); // 25.00 sats/unit
  return r.ok === true;
});

// ---- price ceiling ----
test('rejects a fill one tick over the unit-price ceiling', () => {
  const r = evalBidPolicy({ amount: '300', price_sats: 7501 }, base); // 25.003 sats/unit
  return r.ok === false && /unit price/.test(r.reason);
});

// ---- THE DRAIN: list passes, settled record over-prices ----
// Same intent_id, but GET-by-id serves a 10x price. The pre-filter saw the good
// list record; the settle-time re-check must reject this one.
test('rejects the divergent settled record that over-prices (the drain)', () => {
  const listRec    = { amount: '300', price_sats: 6000 };  // 20 sats/unit — passes
  const settledRec = { amount: '300', price_sats: 60000 }; // 200 sats/unit — must fail
  const a = evalBidPolicy(listRec, base);
  const b = evalBidPolicy(settledRec, base);
  return a.ok === true && b.ok === false && /unit price/.test(b.reason);
});

// ---- THE DRAIN: list passes, settled record under-delivers ----
// Same price_sats, far fewer tokens => the per-unit cost blows past the ceiling.
test('rejects the divergent settled record that under-delivers', () => {
  const listRec    = { amount: '300', price_sats: 6000 }; // 20 sats/unit — passes
  const settledRec = { amount: '30',  price_sats: 6000 }; // 200 sats/unit — must fail
  return evalBidPolicy(listRec, base).ok === true
      && evalBidPolicy(settledRec, base).ok === false;
});

// ---- cumulative fill cap ----
test('rejects a fill that would exceed the cumulative cap', () => {
  const r = evalBidPolicy({ amount: '300', price_sats: 6000 }, { ...base, filledBase: 100n });
  return r.ok === false && /max_total_fill/.test(r.reason);
});

test('cap of 0 means uncapped cumulative', () => {
  const r = evalBidPolicy({ amount: '999999', price_sats: 100 }, { ...base, maxTotalFillBase: 0n });
  return r.ok === true; // unit price 100/999999 well under ceiling, no cap
});

// ---- decimals scaling ----
test('applies decimals to the unit-price computation', () => {
  // 1.0 token at 8 decimals = 100_000_000 base units; 20 sats total => 20 sats/whole.
  // Cap lifted so this isolates the decimals/price path from the cumulative cap.
  const r = evalBidPolicy({ amount: '100000000', price_sats: 20 }, { ...base, decimals: 8, maxTotalFillBase: 0n });
  return r.ok === true;
});

test('rejects when decimals scaling pushes unit price over the ceiling', () => {
  // 0.5 token at 8 decimals for 20 sats => 40 sats/whole, over the 25 ceiling.
  const r = evalBidPolicy({ amount: '50000000', price_sats: 20 }, { ...base, decimals: 8, maxTotalFillBase: 0n });
  return r.ok === false && /unit price/.test(r.reason);
});

// ---- degenerate / malformed inputs fail closed ----
test('rejects a zero amount', () => {
  const r = evalBidPolicy({ amount: '0', price_sats: 6000 }, base);
  return r.ok === false && /non-positive/.test(r.reason);
});

test('rejects a non-positive price', () => {
  const r = evalBidPolicy({ amount: '300', price_sats: 0 }, base);
  return r.ok === false && /non-positive/.test(r.reason);
});

test('rejects an unparseable amount', () => {
  const r = evalBidPolicy({ amount: 'not-a-number', price_sats: 6000 }, base);
  return r.ok === false && /unparseable/.test(r.reason);
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
