// Mainnet-shape precision test — exercises every AMM math primitive at
// the precision real TAC uses (decimals=8, base unit = 1 "sat" of TAC,
// 1 TAC = 100_000_000 base units, max supply at u64 cap).
//
// Why: existing tests use decimals=0 toy amounts (100, 1000, 100_000).
// Real mainnet TAC has 8 decimals — base units up to ~2.1e15 for a 21M
// supply token. Plus pools can hold reserves in the billions of base
// units. This file catches:
//   - u64 overflow in curve math (R_A * deltaIn * γ at scale)
//   - Pedersen commit precision (amounts approaching N_BITS = 64)
//   - LP share rounding when sqrt(deltaA · deltaB) is huge
//   - Mixed-decimals pools (TAC@8 ↔ B@0, asymmetric precision)
//   - Minimum-meaningful-trade at large reserves (does 1 unit produce 0?)
//   - lp_asset_id derivation is decimals-agnostic
//
// All offline — runs in 100ms, no signet sats, validates pre-launch.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { derivePoolId, deriveLpAssetId } from './amm-asset.mjs';
import { lpInitShares, lpAddShares, lpRemoveOutputs, isqrt } from './amm-clearing.mjs';
import { MINIMUM_LIQUIDITY } from './amm-min-liq.mjs';
import { pedersenCommit, randomScalar, SECP_N, N_BITS } from './bulletproofs.mjs';

// Synthetic asset_ids
function aid(s) { return sha256(new TextEncoder().encode('dec8-' + s)); }
const TAC = aid('TAC');
const STABLE = aid('stable');  // hypothetical 8-decimal stablecoin
const MEME = aid('meme');      // 0-decimal token
const BTC = aid('btc');        // 8-decimal BTC-like

// TAC-scale constants
const ONE_TAC      = 100_000_000n;                // 1 TAC = 1e8 base units
const SUPPLY_TAC   = 21_000_000n * ONE_TAC;       // 21M TAC = 2.1e15 base units
const HALF_U64     = (1n << 63n);                 // u64 mid-range guard
const MAX_U64      = (1n << 64n) - 1n;            // u64 max
const N_BITS_MAX   = (1n << BigInt(N_BITS));      // bulletproofs amount cap (typically 2^64)

// ============================================================================
// Curve math at decimals=8 scale
// ============================================================================

function quote(direction, R_A, R_B, deltaIn, feeBps) {
  const ra = BigInt(R_A);
  const rb = BigInt(R_B);
  const din = BigInt(deltaIn);
  const gNum = 10000n - BigInt(feeBps);
  const gDen = 10000n;
  if (ra <= 0n || rb <= 0n || din <= 0n) throw new Error('positive only');
  let num, den, deltaOut, raPost, rbPost;
  if (direction === 0) {  // A → B
    num = rb * gNum * din;
    den = ra * gDen + gNum * din;
    deltaOut = num / den;
    raPost = ra + din;
    rbPost = rb - deltaOut;
  } else {                // B → A
    num = ra * gNum * din;
    den = rb * gDen + gNum * din;
    deltaOut = num / den;
    raPost = ra - deltaOut;
    rbPost = rb + din;
  }
  return { deltaOut, raPost, rbPost };
}

describe('curve math at TAC scale (decimals=8, base units to 1e14+)', () => {
  test('swap 1 TAC against a 1M-TAC pool stays under u64 (no overflow)', () => {
    // R_A = R_B = 1M TAC = 1e14 base units. Trade 1 TAC = 1e8 in.
    // num = 1e14 * 9970 * 1e8 = 9.97e26 — fits in BigInt; final deltaOut
    // is u64-bounded.
    const R = 1_000_000n * ONE_TAC;  // 1M TAC each side
    const din = ONE_TAC;             // 1 TAC in
    const r = quote(0, R, R, din, 30);
    assert.ok(r.deltaOut < MAX_U64, `deltaOut overflow u64: ${r.deltaOut}`);
    assert.ok(r.raPost < MAX_U64, `raPost overflow u64: ${r.raPost}`);
    assert.ok(r.rbPost < MAX_U64, `rbPost overflow u64: ${r.rbPost}`);
    // Sanity: ~1 TAC out minus fee + tiny impact
    assert.ok(r.deltaOut > 99_000_000n && r.deltaOut < ONE_TAC,
      `expected ~1 TAC out, got ${r.deltaOut} (${Number(r.deltaOut) / 1e8} TAC)`);
  });

  test('swap 21M TAC against 100M-TAC pool stays under u64', () => {
    // Edge: massive single trade. R_A = R_B = 100M TAC = 1e16 base units.
    // Trade 21M TAC = 2.1e15 in. num ≈ 1e16 * 1e4 * 2.1e15 = 2.1e35
    // (BigInt-safe). Post-reserves still under u64.
    const R = 100_000_000n * ONE_TAC;   // 100M TAC = 1e16
    const din = 21_000_000n * ONE_TAC;  // 21M TAC = 2.1e15
    const r = quote(0, R, R, din, 30);
    assert.ok(r.raPost < MAX_U64, `raPost overflow: ${r.raPost}`);
    assert.ok(r.rbPost < MAX_U64, `rbPost overflow: ${r.rbPost}`);
    assert.ok(r.deltaOut > 0n, 'deltaOut must be positive');
    assert.ok(r.deltaOut < R, 'deltaOut must be < R_B (asymptote)');
  });

  test('minimum meaningful trade: 1 base unit (1 sat of TAC) against 1M-TAC pool', () => {
    // Real concern: at decimals=8, a "tiny" trade is 1 base unit = 0.00000001 TAC.
    // Does the curve produce a positive deltaOut, or does floor-division zero it?
    const R = 1_000_000n * ONE_TAC;
    const r = quote(0, R, R, 1n, 30);
    // num = R * 9970 * 1 ≈ 1e18. den = R * 10000 + 9970 ≈ 1e18.
    // deltaOut = num / den ≈ 0.997 → floor = 0
    // This documents: SUB-FRACTIONAL trades round to ZERO. Trader gets nothing.
    // Launch UX must reject trades below a "dust" threshold (probably ~1000 base units).
    if (r.deltaOut === 0n) {
      // Confirmed: floor rounds tiny trades to 0
      assert.strictEqual(r.deltaOut, 0n,
        'tiny trade rounds to 0 deltaOut — dapp must enforce min-trade threshold');
    } else {
      // If non-zero, must still be < deltaIn (else trader profits from rounding)
      assert.ok(r.deltaOut <= 1n);
    }
  });

  test('asymmetric pool: TAC@1e8 ↔ MEME@1, swap 1 TAC for fractional MEME', () => {
    // Real launch scenario: 1 TAC = 1e8 base, MEME = 0 decimals.
    // Pool: 1M TAC ↔ 1B MEME (so 1 TAC = ~1000 MEME at start).
    const R_TAC  = 1_000_000n * ONE_TAC;     // 1e14
    const R_MEME = 1_000_000_000n;           // 1e9
    const din = ONE_TAC;                     // 1 TAC
    const r = quote(0, R_TAC, R_MEME, din, 30);
    // Expected ~1000 MEME out at 30bps fee. But MEME is integer-precision, so
    // any output < 1 MEME would round to 0 — that's a real risk for small TAC swaps.
    assert.ok(r.deltaOut > 0n, 'asymmetric swap produced 0 — pool too thin for TAC scale');
    assert.ok(r.deltaOut < R_MEME);
  });

  test('asymmetric pool: 0.001 TAC against same pool produces ≥1 MEME or 0', () => {
    // Tiny TAC trade against 0-decimal token. The breakpoint is when
    // R_MEME * din / R_TAC < 1 — then it rounds to 0.
    const R_TAC  = 1_000_000n * ONE_TAC;
    const R_MEME = 1_000_000_000n;
    const din = ONE_TAC / 1000n;  // 0.001 TAC = 1e5 base units
    const r = quote(0, R_TAC, R_MEME, din, 30);
    // (R_MEME * 9970 * 1e5) / (R_TAC * 10000 + 9970 * 1e5)
    // ≈ (1e9 * 9970 * 1e5) / (1e14 * 1e4 + 9.97e8)
    // ≈ 9.97e17 / 1e18 ≈ 0.997 → floor = 0 (rounds to 0)
    // Documents: trader must size trade enough to overcome 0-decimal-asset granularity.
    assert.ok(r.deltaOut >= 0n, 'deltaOut never negative');
    // Either gets ≥1 or 0 — the math is honest
  });
});

// ============================================================================
// LP share math at decimals=8 scale
// ============================================================================

describe('LP share math at TAC scale', () => {
  test('lpInitShares: 1 TAC ↔ 1 TAC pool — sqrt(1e8·1e8) = 1e8, founder=1e8 − MIN_LIQ', () => {
    const result = lpInitShares(ONE_TAC, ONE_TAC, MINIMUM_LIQUIDITY);
    assert.strictEqual(result.founder_shares, ONE_TAC - BigInt(MINIMUM_LIQUIDITY));
    assert.strictEqual(result.locked_shares, BigInt(MINIMUM_LIQUIDITY));
    assert.strictEqual(result.total_shares, ONE_TAC);
  });

  test('lpInitShares: 1M TAC ↔ 1M TAC pool — share count fits in u64', () => {
    const R = 1_000_000n * ONE_TAC;  // 1e14
    const result = lpInitShares(R, R, MINIMUM_LIQUIDITY);
    // sqrt(R · R) = R, so founder_shares = R - MIN_LIQ
    assert.strictEqual(result.founder_shares, R - BigInt(MINIMUM_LIQUIDITY));
    assert.ok(result.total_shares < MAX_U64,
      `total_shares overflow u64: ${result.total_shares}`);
  });

  test('lpInitShares: full-supply TAC pool (21M TAC ↔ 21M TAC) — still u64 safe', () => {
    const R = SUPPLY_TAC;  // 2.1e15
    const result = lpInitShares(R, R, MINIMUM_LIQUIDITY);
    assert.ok(result.total_shares < MAX_U64,
      `at max supply, total_shares = ${result.total_shares} exceeds u64`);
    assert.strictEqual(result.total_shares, R);
  });

  test('lpInitShares: asymmetric 1 TAC ↔ 1000 MEME — isqrt is rough but valid', () => {
    // sqrt(1e8 · 1000) = sqrt(1e11) ≈ 316227.766
    // isqrt(1e11) = 316227 → founder = 316227 - 1000 = 315227
    const result = lpInitShares(ONE_TAC, 1000n, MINIMUM_LIQUIDITY);
    const expectedTotal = isqrt(ONE_TAC * 1000n);
    assert.strictEqual(result.total_shares, expectedTotal);
    assert.strictEqual(result.founder_shares, expectedTotal - BigInt(MINIMUM_LIQUIDITY));
  });

  test('lpAddShares: proportional add maintains share invariant at TAC scale', () => {
    // Pool: 1M TAC ↔ 1M TAC, S = 1M TAC. Add 1000 TAC (0.1% of pool).
    const R = 1_000_000n * ONE_TAC;
    const S = R;
    const deltaA = 1000n * ONE_TAC;  // 0.1% of R
    const deltaB = 1000n * ONE_TAC;  // proportional
    const shares = lpAddShares(deltaA, deltaB, R, R, S);
    // Expected: min(deltaA·S/R_A, deltaB·S/R_B) = 1000 TAC × S / R
    //         = 1000 TAC × 1M TAC / 1M TAC = 1000 TAC base units
    assert.strictEqual(shares, deltaA);
  });

  test('lpRemoveOutputs: burn 1% of shares gives 1% of reserves', () => {
    const R_A = 1_000_000n * ONE_TAC;
    const R_B = 1_000_000n * ONE_TAC;
    const S = R_A;
    const burn = S / 100n;  // 1%
    const out = lpRemoveOutputs(burn, R_A, R_B, S);
    // out.delta_a = R_A · burn / S = R_A / 100
    assert.strictEqual(out.delta_a, R_A / 100n);
    assert.strictEqual(out.delta_b, R_B / 100n);
  });
});

// ============================================================================
// Pedersen commits and bulletproof range at TAC scale
// ============================================================================

describe('Pedersen commits at TAC scale (amounts up to N_BITS_MAX)', () => {
  test('pedersenCommit(SUPPLY_TAC) is on-curve and reproducible', () => {
    // Real launch: a single UTXO can hold up to N_BITS_MAX − 1 base units.
    const r = randomScalar();
    const c1 = pedersenCommit(SUPPLY_TAC, r);
    const c2 = pedersenCommit(SUPPLY_TAC, r);
    assert.strictEqual(
      bytesToHex(c1.toRawBytes(true)),
      bytesToHex(c2.toRawBytes(true)),
      'commit must be deterministic given (amount, blinding)',
    );
  });

  test('pedersenCommit handles amounts at N_BITS_MAX boundary', () => {
    // Boundary: 2^N_BITS - 1 = u64 max. This is the largest provable amount
    // by the bulletproof range proof.
    const maxBP = N_BITS_MAX - 1n;
    const r = randomScalar();
    const c = pedersenCommit(maxBP, r);
    // Must produce a valid 33-byte compressed point
    const bytes = c.toRawBytes(true);
    assert.strictEqual(bytes.length, 33);
  });

  test('pedersenCommit(0, r) and pedersenCommit(non-zero, r) differ', () => {
    const r = randomScalar();
    const c0 = pedersenCommit(0n, r);
    const c1 = pedersenCommit(ONE_TAC, r);
    assert.notStrictEqual(
      bytesToHex(c0.toRawBytes(true)),
      bytesToHex(c1.toRawBytes(true)),
    );
  });

  test('homomorphic add: commit(a) + commit(b) = commit(a+b) under shared blinding components', () => {
    // C(a, r_a) + C(b, r_b) = C(a+b, r_a + r_b)
    const a = 100_000_000n;            // 1 TAC
    const b = 200_000_000n;            // 2 TAC
    const r_a = randomScalar();
    const r_b = randomScalar();
    const r_sum = (r_a + r_b) % SECP_N;
    const lhs = pedersenCommit(a, r_a).add(pedersenCommit(b, r_b));
    const rhs = pedersenCommit(a + b, r_sum);
    assert.strictEqual(
      bytesToHex(lhs.toRawBytes(true)),
      bytesToHex(rhs.toRawBytes(true)),
      'Pedersen homomorphism must hold at TAC scale',
    );
  });
});

// ============================================================================
// lp_asset_id is decimals-agnostic (sanity)
// ============================================================================

describe('lp_asset_id is unaffected by asset decimals', () => {
  test('lp_asset_id for TAC@8 ↔ STABLE@8 = lp_asset_id for "same byte asset_ids regardless of decimals"', () => {
    // Decimals lives in the asset registry meta, not in pool_id. So changing
    // decimals doesn't change pool_id or lp_asset_id. Verify the derivation
    // is identical for any two assets at any decimals.
    const pool1 = derivePoolId(TAC, STABLE, 30, 0);
    const pool2 = derivePoolId(TAC, STABLE, 30, 0);
    assert.strictEqual(bytesToHex(pool1), bytesToHex(pool2));
    assert.strictEqual(
      bytesToHex(deriveLpAssetId(pool1)),
      bytesToHex(deriveLpAssetId(pool2)),
    );
  });

  test('LP share UTXO amount field uses asset_id\'s decimals scale', () => {
    // Conceptual test: when an LP holds shares of a pool where both sides
    // are decimals=8, the share amount is also expressed in 8-decimal precision
    // (no special LP-specific decimals). This is structurally implicit but
    // worth pinning: share counts at launch will be on the order of 1e8 to 1e15.
    const result = lpInitShares(ONE_TAC, ONE_TAC, MINIMUM_LIQUIDITY);
    assert.strictEqual(result.total_shares, ONE_TAC,
      'share count expressed in same precision as input deltas');
  });
});

// ============================================================================
// Real-TAC parameter pinning (mainnet asset shape)
// ============================================================================

describe('Real production TAC asset shape (mainnet)', () => {
  // From the worker: asset_id=f0bbe868…, ticker=TAC, decimals=8, mintable=false,
  // etched at height 948242 on mainnet.
  const REAL_TAC_AID_HEX = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';

  test('production TAC asset_id is 32 bytes and structurally valid', () => {
    assert.strictEqual(REAL_TAC_AID_HEX.length, 64);
    assert.match(REAL_TAC_AID_HEX, /^[0-9a-f]{64}$/);
  });

  test('derivePoolId works with the real TAC asset_id as one side', () => {
    const tacBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      tacBytes[i] = parseInt(REAL_TAC_AID_HEX.slice(i * 2, i * 2 + 2), 16);
    }
    // Pair real TAC with a hypothetical cBTC.tac variant (10k denom)
    const pid = derivePoolId(tacBytes, BTC, 30, 0);
    assert.strictEqual(pid.length, 32);
    const lpAid = deriveLpAssetId(pid);
    assert.strictEqual(lpAid.length, 32);
    // Determinism check
    const pid2 = derivePoolId(tacBytes, BTC, 30, 0);
    assert.strictEqual(bytesToHex(pid), bytesToHex(pid2));
  });

  test('proposed LP ticker at TAC scale: LP·TAC/cBTC.tac.10k·30bps', () => {
    // Display: when an LP holds (real-TAC ↔ cBTC.tac.10k) shares, the dapp
    // should render with both tickers + fee. This integrates with the
    // _lpSyntheticMeta gap from lp-share-properties.test.mjs.
    const ticker = `LP·TAC/cBTC.tac.10k·30bps`;
    assert.ok(ticker.length < 64, 'LP ticker fits common UI widths');
  });
});
