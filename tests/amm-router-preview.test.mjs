// Unit test for the dapp's router preview helper.
//
// previewSwapRoute({ fromAid, toAid, amountIn, pools }) returns one of:
//   { kind: 'direct',   pool, direction, deltaOut, raPost, rbPost }
//   { kind: 'multihop', route }       // findSwapRoutePath output
//   null
//
// The Swap tile (dapp/tacit.js _wirePoolSwapForm) dispatches the matching
// builder (T_SWAP_VAR vs T_SWAP_ROUTE) based on `.kind`. This test pins
// the dispatch decision across the four interesting topologies:
//
//   T1. Direct only          → returns 'direct'
//   T2. Multihop only        → returns 'multihop'
//   T3. Both, direct better  → returns 'direct'  (also ties)
//   T4. Both, multihop better → returns 'multihop'
//
// Plus boundary cases:
//   T5. Same asset           → returns null
//   T6. Zero amountIn        → returns null
//   T7. Disconnected graph   → returns null
//
// Run: `node tests/amm-router-preview.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');
const { previewSwapRoute, findSwapRoutePath } = dapp;

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}  (returned ${typeof ok === 'object' ? JSON.stringify(ok) : ok})`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// Asset-id constants ordered so canonicalization matches lex order.
const A   = 'aa' + '11'.repeat(31);
const B   = 'bb' + '22'.repeat(31);
const C   = 'cc' + '33'.repeat(31);
const X   = '11' + '99'.repeat(31);   // lex-smaller than A, so X is the bridge

function mkPool({ id, a, b, ra, rb, fee = 30, validation = 'verified' }) {
  return {
    pool_id: id,
    asset_a: a, asset_b: b,
    reserve_a: ra, reserve_b: rb,
    fee_bps: fee,
    validation,
    lp_total_shares: '100000',
  };
}

// =========================================================================
// T1: direct only — pool exists for (A, B)
// =========================================================================
console.log('T1: direct only — pool (A, B) exists');
{
  const pools = [
    mkPool({ id: 'pool_AB',
      a: A < B ? A : B,                // canonical_asset_a = lex-smaller
      b: A < B ? B : A,
      ra: '1000000', rb: '2000000' }),
  ];
  test('returns direct', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r !== null && r.kind === 'direct';
  });
  test('direct.deltaOut > 0', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r.deltaOut > 0n;
  });
  test('direction is computed canonically', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    // canonical_asset_a is A (since A < B). Trader pays A → direction = 0.
    return r.direction === 0;
  });
}

// =========================================================================
// T2: multihop only — pools (A, X) and (X, B) exist, no (A, B)
// =========================================================================
console.log('\nT2: multihop only — only (A, X) and (X, B) pools');
{
  const pools = [
    mkPool({ id: 'pool_AX',
      a: X < A ? X : A, b: X < A ? A : X,
      ra: '1000000', rb: '1000000' }),
    mkPool({ id: 'pool_XB',
      a: X < B ? X : B, b: X < B ? B : X,
      ra: '1000000', rb: '1000000' }),
  ];
  test('returns multihop', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r !== null && r.kind === 'multihop';
  });
  test('multihop.route.hops.length == 2', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r.route.hops.length === 2;
  });
  test('multihop.route.deltaOutLast > 0', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r.route.deltaOutLast > 0n;
  });
}

// =========================================================================
// T3: both, direct strictly better — picks 'direct'
// =========================================================================
console.log('\nT3: both routes exist, direct wins on quote');
{
  const pools = [
    // Direct (A, B) pool: very deep on B side, gives a great quote
    mkPool({ id: 'pool_AB',
      a: A < B ? A : B, b: A < B ? B : A,
      ra: '1000000', rb: '10000000' }),
    // Indirect bridge — same depth as direct but the 2 × 30bps fees compound
    mkPool({ id: 'pool_AX',
      a: X < A ? X : A, b: X < A ? A : X,
      ra: '1000000', rb: '1000000' }),
    mkPool({ id: 'pool_XB',
      a: X < B ? X : B, b: X < B ? B : X,
      ra: '1000000', rb: '10000000' }),
  ];
  test('returns direct (direct strictly better)', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r !== null && r.kind === 'direct';
  });
}

// =========================================================================
// T4: both, multihop strictly better — picks 'multihop'
// =========================================================================
console.log('\nT4: both routes exist, multihop wins on quote');
{
  const pools = [
    // Asymmetric, shallow B side on the direct pool → ugly slippage
    // at this amountIn. Trader pays 1000 A; direct returns ~91 B.
    mkPool({ id: 'pool_AB',
      a: A < B ? A : B, b: A < B ? B : A,
      ra: '10000', rb: '1000' }),
    // Deep symmetric bridge through X → ~992 B out for the same input.
    // Despite the 2 × 30bps fee compound, the depth advantage dominates.
    mkPool({ id: 'pool_AX',
      a: X < A ? X : A, b: X < A ? A : X,
      ra: '10000000', rb: '10000000' }),
    mkPool({ id: 'pool_XB',
      a: X < B ? X : B, b: X < B ? B : X,
      ra: '10000000', rb: '10000000' }),
  ];
  test('returns multihop (deeper bridge beats shallow asymmetric direct)', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r !== null && r.kind === 'multihop';
  });
}

// =========================================================================
// T5: same asset → null
// =========================================================================
console.log('\nT5: same asset');
{
  const pools = [
    mkPool({ id: 'pool_AB',
      a: A < B ? A : B, b: A < B ? B : A,
      ra: '1000000', rb: '1000000' }),
  ];
  test('returns null on same-asset request', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: A, amountIn: 100n, pools });
    return r === null;
  });
}

// =========================================================================
// T6: zero amountIn → null
// =========================================================================
console.log('\nT6: zero / negative amountIn');
{
  const pools = [
    mkPool({ id: 'pool_AB',
      a: A < B ? A : B, b: A < B ? B : A,
      ra: '1000000', rb: '1000000' }),
  ];
  test('amountIn == 0 returns null', () => previewSwapRoute({ fromAid: A, toAid: B, amountIn: 0n, pools }) === null);
}

// =========================================================================
// T7: disconnected — no path exists
// =========================================================================
console.log('\nT7: disconnected graph (no path A → B)');
{
  // Only pools (X, C) — A and B are isolated.
  const pools = [
    mkPool({ id: 'pool_XC',
      a: X < C ? X : C, b: X < C ? C : X,
      ra: '1000000', rb: '1000000' }),
  ];
  test('returns null when no path exists', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r === null;
  });
}

// =========================================================================
// T8: pool with validation != 'verified' or 'xcurve-verified' is skipped
// =========================================================================
console.log('\nT8: unverified pools are filtered out');
{
  const pools = [
    mkPool({ id: 'pool_AB',
      a: A < B ? A : B, b: A < B ? B : A,
      ra: '1000000', rb: '1000000',
      validation: 'unverified' }),
  ];
  test('returns null when only candidate is unverified', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r === null;
  });
}

// =========================================================================
// T9: max-hop cap (N_HOPS_MAX = 4) — a path requiring 5 hops is rejected
// =========================================================================
console.log('\nT9: path requiring > N_HOPS_MAX hops rejected');
{
  // Build a 5-bridge chain A → m1 → m2 → m3 → m4 → B. findSwapRoutePath
  // caps at SWAP_ROUTE_HOPS_MAX (= 4), so this should return null because
  // the 5th hop exceeds the depth budget.
  const m1 = '01' + '00'.repeat(31);
  const m2 = '02' + '00'.repeat(31);
  const m3 = '03' + '00'.repeat(31);
  const m4 = '04' + '00'.repeat(31);
  const pools = [
    mkPool({ id: 'p_A_m1',  a: A  < m1 ? A  : m1, b: A  < m1 ? m1 : A,  ra:'1000000', rb:'1000000' }),
    mkPool({ id: 'p_m1_m2', a: m1 < m2 ? m1 : m2, b: m1 < m2 ? m2 : m1, ra:'1000000', rb:'1000000' }),
    mkPool({ id: 'p_m2_m3', a: m2 < m3 ? m2 : m3, b: m2 < m3 ? m3 : m2, ra:'1000000', rb:'1000000' }),
    mkPool({ id: 'p_m3_m4', a: m3 < m4 ? m3 : m4, b: m3 < m4 ? m4 : m3, ra:'1000000', rb:'1000000' }),
    mkPool({ id: 'p_m4_B',  a: m4 < B  ? m4 : B,  b: m4 < B  ? B  : m4, ra:'1000000', rb:'1000000' }),
  ];
  test('5-hop path exceeds N_HOPS_MAX → null', () => {
    const r = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 1000n, pools });
    return r === null;
  });
}

console.log(`\n${pass}/${pass + fail} router-preview checks passed`);
// Force exit — the dapp module triggers background network fetches at
// load that would otherwise keep Node alive past the tests' completion.
process.exit(fail > 0 ? 1 : 0);
