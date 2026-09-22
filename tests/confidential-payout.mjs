// Public payout from a shielded balance (dapp/confidential-payout.js): address validation, strict amounts, the
// exact-amount fee arithmetic over sendUnwrap (checked against the real fee quote, per asset scale), note
// selection, the recipient-balance confirmation poll on a fake clock, and the wording that must never claim
// success from the relay's status. The last block builds real sendUnwrap and merge ops to show the numbers the
// panel reviews are the numbers the op carries.
// Run: node tests/confidential-payout.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import * as P from '../dapp/confidential-payout.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };

const quietFetch = async () => ({ ok: true, status: 200, json: async () => ({ result: '0x0' }), text: async () => '{"result":"0x0"}' });
const ux0 = makeConfidentialPoolUx({ ...deps, fetchImpl: quietFetch });

// ── recipient ──

// The four mixed-case vectors of EIP-55, and its all-caps / all-lower ones.
const CHECKSUMMED = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];
const ALL_CAPS = ['0x52908400098527886E0F7030069857D2E4169EE7', '0x8617E340B3D01FA5F11F306F4090FD50E238070D'];
const ALL_LOWER = ['0xde709f2102306220921060314715629080e2fb77', '0x27b1fdb04752bbc536007a920d24acb045561c26'];
const parse = (s, opts = {}) => P.parseRecipient(s, { keccak256: keccak_256, ...opts });

test('address: a correct EIP-55 checksum is accepted and reported as verified', () => {
  for (const a of CHECKSUMMED) {
    const r = parse(a);
    assert.equal(r.ok, true, a);
    assert.equal(r.hasChecksum, true);
    assert.equal(r.address, a.toLowerCase());
    assert.equal(r.checksummed, a);
  }
});

test('address: all-lower and all-upper carry no checksum and are accepted as such', () => {
  for (const a of [...ALL_CAPS, ...ALL_LOWER, ...CHECKSUMMED.map((x) => x.toLowerCase()), ...CHECKSUMMED.map((x) => '0x' + x.slice(2).toUpperCase())]) {
    const r = parse(a);
    assert.equal(r.ok, true, a);
    assert.equal(r.hasChecksum, false, `${a} has no checksum to verify`);
    assert.equal(r.address, a.toLowerCase());
  }
  assert.equal(parse('  ' + ALL_LOWER[0] + '  ').ok, true, 'surrounding whitespace is trimmed');
  assert.equal(parse('0x' + '1234567890'.repeat(4)).ok, true, 'digits only: nothing to case');
});

test('address: a mixed-case address whose checksum fails is refused', () => {
  for (const a of CHECKSUMMED) {
    const i = [...a.slice(2)].findIndex((c) => /[a-fA-F]/.test(c));
    const flip = (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
    const bad = '0x' + a.slice(2, 2 + i) + flip(a[2 + i]) + a.slice(3 + i);
    const r = parse(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.code, 'bad-checksum');
    assert.equal(r.checksummed, a, 'the correct form is offered');
    assert.match(r.message, /checksum/);
  }
});

test('address: wrong length, prefix or characters are not addresses', () => {
  for (const s of ['', '0x', '0x1234', '0x' + 'a'.repeat(39), '0x' + 'a'.repeat(41), 'a'.repeat(40), '0X' + 'a'.repeat(40), '0x' + 'g'.repeat(40),
    '0x02' + 'ab'.repeat(32), 'tacit1qq', 'vitalik.eth']) {
    const r = parse(s);
    assert.equal(r.ok, false, JSON.stringify(s));
    assert.equal(r.code, 'not-address');
    assert.equal(P.looksLikeAddress(s), false);
  }
  assert.equal(P.looksLikeAddress(ALL_LOWER[0]), true);
  assert.equal(P.looksLikeAddress(CHECKSUMMED[0].replace(/[a-f]/, 'Z')), false);
});

test('address: the zero address and denied contracts are refused', () => {
  assert.equal(parse('0x' + '0'.repeat(40)).code, 'zero-address');
  const pool = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
  const r = parse(pool.toLowerCase(), { deny: [{ address: pool, reason: 'the pool' }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'denied');
  assert.equal(r.message, 'the pool');
  assert.equal(parse(CHECKSUMMED[0], { deny: [{ address: pool }] }).ok, true, 'an address not on the list passes');
});

// ── amounts ──

test('amounts: exact at each asset scale, strict about places', () => {
  assert.equal(P.parseUnits('0.5', 8), 50_000_000n);
  assert.equal(P.parseUnits('1', 8), 100_000_000n);
  assert.equal(P.parseUnits('0.00000001', 8), 1n, 'ETH: one in-system unit is 1e-8 ETH');
  assert.equal(P.parseUnits('10.5', 6), 10_500_000n, 'a 6-decimal asset');
  assert.equal(P.parseUnits('.5', 6), 500_000n);
  assert.equal(P.parseUnits('5.', 6), 5_000_000n);
  assert.equal(P.parseUnits('007', 8), 700_000_000n);
  assert.throws(() => P.parseUnits('0.000000001', 8), (e) => e.code === 'too-many-decimals' && /8 decimal/.test(e.message));
  assert.throws(() => P.parseUnits('0.0000001', 6), (e) => e.code === 'too-many-decimals');
  assert.throws(() => P.parseUnits('1.5', 0), (e) => e.code === 'too-many-decimals');
  for (const bad of ['', '.', '-1', '+1', '1e-7', '1,5', '0x10', 'abc', '1.2.3', ' ']) {
    assert.throws(() => P.parseUnits(bad, 8), (e) => e instanceof P.PayoutError && e.code === 'bad-amount', JSON.stringify(bad));
  }
  assert.equal(P.parseUnits('0', 8), 0n);
});

test('amounts: format is the inverse of parse', () => {
  for (const [v, d, s] of [[50_160_000n, 8, '0.5016'], [1n, 8, '0.00000001'], [0n, 8, '0'], [100_000_000n, 8, '1'], [10_500_000n, 6, '10.5'], [7n, 0, '7']]) {
    assert.equal(P.formatUnits(v, d), s);
    assert.equal(P.parseUnits(s, d), v);
  }
});

test('amounts: a payout delivers value x unitScale of the public token', () => {
  assert.equal(P.underlyingUnits(50_000_000n, 10n ** 10n), 5n * 10n ** 17n, '0.5 ETH is 5e17 wei');
  assert.equal(P.underlyingUnits(10_000_000n, 1n), 10_000_000n, 'USDC has scale 1');
  assert.equal(P.underlyingUnits(100_000_000n, '10000000000'), 10n ** 18n, 'a string scale from the asset table');
});

// ── the fee model: exact amount for the recipient ──

// An independent statement of the relay fee: at most two significant digits, rounded up, floored at minFee and
// capped at the amount. quoteUnwrapFee in the pool client must agree with it everywhere.
function refLadder(x) {
  if (x <= 0n) return 0n;
  const s = x.toString();
  if (s.length <= 2) return x;
  const unit = 10n ** BigInt(s.length - 2);
  return ((x + unit - 1n) / unit) * unit;
}
function refFee(v, minFee, bps = 30n) {
  const pct = (v * bps + 9999n) / 10000n;
  const f = refLadder(pct > minFee ? pct : minFee);
  return f > v ? v : f;
}
const feeOfFor = (ticker, minFee) => (g) => ux0.quoteUnwrapFee(g, ticker, { minFee }).fee;

test('fee model: the pool client quote agrees with the independent statement of it', () => {
  let s = 12345n;
  const rnd = () => { s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return s; };
  for (const minFee of [1n, 100n, 10_000n, 33_000n, 42_193n, 300_000n, 30_000_000n, 116_016_638n]) {
    for (let i = 0; i < 400; i++) {
      const v = 1n + rnd() % (10n ** BigInt(2 + Number(rnd() % 14n)));
      assert.equal(ux0.quoteUnwrapFee(v, 'cETH', { minFee }).fee, refFee(v, minFee), `v=${v} minFee=${minFee}`);
    }
  }
});

test('fee model: literal anchors for ETH (1e10 scale), an 8-decimal stable and USDC', () => {
  // ETH, floor 10,000 units (0.0001 ETH). Pay 0.5 ETH: the fee is 160,000 (0.0016 ETH, the 0.30% step above the floor).
  let r = P.grossForNet({ net: 50_000_000n, feeOf: feeOfFor('cETH', 10_000n), minFee: 10_000n });
  assert.deepEqual(r, { gross: 50_160_000n, fee: 160_000n, net: 50_000_000n });
  assert.equal(P.underlyingUnits(r.net, 10n ** 10n), 5n * 10n ** 17n, 'exactly 0.5 ETH in wei reaches the recipient');
  // Percentage-dominated: 10 ETH pays 0.31%.
  r = P.grossForNet({ net: 1_000_000_000n, feeOf: feeOfFor('cETH', 10_000n), minFee: 10_000n });
  assert.deepEqual(r, { gross: 1_003_100_000n, fee: 3_100_000n, net: 1_000_000_000n });
  // An 8-decimal dollar asset with a $0.30 floor: 1.00 pays a flat 0.30.
  r = P.grossForNet({ net: 100_000_000n, feeOf: feeOfFor('cUSD', 30_000_000n), minFee: 30_000_000n });
  assert.deepEqual(r, { gross: 130_000_000n, fee: 30_000_000n, net: 100_000_000n });
  // USDC, 6 decimals, $0.30 floor.
  r = P.grossForNet({ net: 10_000_000n, feeOf: feeOfFor('cUSDC', 300_000n), minFee: 300_000n });
  assert.deepEqual(r, { gross: 10_300_000n, fee: 300_000n, net: 10_000_000n });
});

test('fee model: the recipient receives exactly what was typed, over a wide sweep of amounts and floors', () => {
  for (const minFee of [10_000n, 33_000n, 42_193n, 300_000n, 30_000_000n]) {
    const feeOf = feeOfFor('cETH', minFee);
    let net = minFee;
    while (net < 5n * 10n ** 12n) {
      const r = P.grossForNet({ net, feeOf, minFee });
      assert.equal(r.gross - r.fee, net, `net ${net} floor ${minFee}`);
      assert.equal(feeOf(r.gross), r.fee, 'the fee on the gross is the fee that was subtracted');
      net = net * 3n + 7n;
    }
  }
});

test('fee model: the gross is the least one, checked against a brute-force search across the ladder jumps', () => {
  const minFee = 100;
  const feeNum = (g) => Number(refFee(BigInt(g), BigInt(minFee)));
  const feeOf = (g) => refFee(BigInt(g), BigInt(minFee));
  let checked = 0;
  for (let net = 1; net <= 260_000; net += 97) {
    let least = null;
    for (let g = net; g <= net + 900_000; g++) { if (g - feeNum(g) === net) { least = g; break; } }
    if (least === null) continue;
    let got;
    try { got = P.grossForNet({ net: BigInt(net), feeOf, minFee: BigInt(minFee) }); } catch (e) {
      // Only an amount at or below the fee's own rounding step may be refused.
      assert.equal(e.code, 'below-fee', `net ${net}`);
      assert.ok(net < 100, `net ${net} refused above the floor`);
      continue;
    }
    assert.equal(Number(got.gross), least, `net ${net}: least gross`);
    checked++;
  }
  assert.ok(checked > 2000, `${checked} amounts checked`);
});

test('fee model: an amount the fee would swallow is refused; zero is refused', () => {
  // A floor of 42,193 rounds up to 43,000 on the ladder, so a net of 807 or less is smaller than the rounding step
  // itself and the fee would swallow the whole amount.
  assert.throws(() => P.grossForNet({ net: 500n, feeOf: feeOfFor('cETH', 42_193n), minFee: 42_193n }), (e) => e.code === 'below-fee');
  // Above that step a payment smaller than its fee is allowed (the panel warns); the arithmetic stays exact.
  const small = P.grossForNet({ net: 500n, feeOf: feeOfFor('cETH', 43_000n), minFee: 43_000n });
  assert.deepEqual(small, { gross: 43_500n, fee: 43_000n, net: 500n });
  assert.throws(() => P.grossForNet({ net: 0n, feeOf: () => 1n, minFee: 1n }), (e) => e.code === 'zero-amount');
  // A fee that flips with the parity of the amount has no fixed point; the iteration gives up rather than loop.
  assert.throws(() => P.grossForNet({ net: 1000n, feeOf: (g) => (g % 2n === 0n ? 5n : 6n), minFee: 1n }), (e) => e.code === 'fee-unstable');
});

// ── notes ──

const ETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const USDC = '0x' + 'aa'.repeat(32);
const note = (value, leafIndex, asset = ETH) => ({ asset, value: BigInt(value), leafIndex, cx: '0x1', cy: '0x2', owner: '0x3', secret: '0x4', blinding: '0x5', path: [], root: '0x6' });
const eth = (minFee = 10_000n) => ({ feeOf: feeOfFor('cETH', minFee), minFee });

test('notes: a payout spends the smallest single note that covers amount plus fee', () => {
  const notes = [note(30_000_000, 4), note(80_000_000, 9), note(60_000_000, 2), note(90_000_000, 1, USDC)];
  const p = P.planPayout({ notes, asset: ETH, net: 50_000_000n, ...eth() });
  assert.equal(p.ok, true);
  assert.equal(p.gross, 50_160_000n);
  assert.equal(p.fee, 160_000n);
  assert.equal(p.note.leafIndex, 2, 'the 0.6 note, not the 0.8, and never the USDC one');
  assert.equal(p.change, 60_000_000n - 50_160_000n);
  assert.equal(p.wholeNote, false);
  assert.equal(p.total, 170_000_000n, 'the total counts only this asset');
});

test('notes: a note exactly the size of amount plus fee is a whole-note payout with no change', () => {
  const p = P.planPayout({ notes: [note(50_160_000, 3)], asset: ETH, net: 50_000_000n, ...eth() });
  assert.equal(p.ok, true);
  assert.equal(p.change, 0n);
  assert.equal(p.wholeNote, true);
  const short = P.planPayout({ notes: [note(50_159_999, 3)], asset: ETH, net: 50_000_000n, ...eth() });
  assert.equal(short.ok, false, 'one unit short is not covered');
});

test('notes: equal candidates resolve to the older note', () => {
  const n = P.pickNote([note(5, 40), note(5, 12), note(5, 90)], ETH, 5n);
  assert.equal(n.leafIndex, 12);
  assert.equal(P.pickNote([note(4, 1)], ETH, 5n), null);
  assert.equal(P.pickNote([note(9, 1, USDC)], ETH.toUpperCase().replace('0X', '0x'), 5n), null, 'another asset never counts');
  assert.equal(P.pickNote([{ ...note(9, 1), asset: ETH.toUpperCase().replace('0X', '0x') }], ETH, 5n).leafIndex, 1, 'asset ids compare case-insensitively');
});

test('notes: no balance, not enough in total, and enough only across several notes are told apart', () => {
  assert.deepEqual(P.planPayout({ notes: [note(9, 1, USDC)], asset: ETH, net: 5_000_000n, ...eth() }), { ok: false, code: 'no-balance', total: 0n });
  assert.deepEqual(P.planPayout({ notes: [], asset: ETH, net: 5_000_000n, ...eth() }), { ok: false, code: 'no-balance', total: 0n });

  const poor = P.planPayout({ notes: [note(2_000_000, 1), note(1_000_000, 2)], asset: ETH, net: 5_000_000n, ...eth() });
  assert.equal(poor.code, 'insufficient');
  assert.equal(poor.total, 3_000_000n);
  assert.equal(poor.short, poor.gross - 3_000_000n);

  const spread = P.planPayout({ notes: [note(3_000_000, 1), note(3_000_000, 2), note(3_000_000, 3)], asset: ETH, net: 5_000_000n, ...eth() });
  assert.equal(spread.ok, false);
  assert.equal(spread.code, 'no-single-note');
  assert.equal(spread.total, 9_000_000n);
  assert.equal(spread.largest, 3_000_000n);
  assert.equal(spread.gross, 5_016_000n, '0.30% of 5,000,000 is 15,000, which the ladder rounds up to 16,000');
  assert.equal(spread.fee, 16_000n);
});

test('notes: a merge takes the fewest largest notes that reach the need after its own fee', () => {
  const held = [note(3_000_000, 1), note(3_000_000, 2), note(1_000_000, 3), note(3_000_000, 4)];
  const m = P.planMerge({ notes: held, need: 5_010_000n, mergeFee: 20_000n });
  assert.equal(m.ok, true);
  assert.equal(m.count, 2, 'two 3,000,000 notes leave 5,980,000 after the fee');
  assert.equal(m.sum, 6_000_000n);
  assert.equal(m.merged, 5_980_000n);
  assert.equal(m.covers, true);
  assert.deepEqual(m.notes.map((n) => n.leafIndex).sort(), [1, 2]);
  // Not reachable by any merge of what is held: says so, and still returns the largest notes.
  const big = P.planMerge({ notes: held, need: 20_000_000n, mergeFee: 20_000n });
  assert.equal(big.ok, true);
  assert.equal(big.covers, false);
  assert.equal(big.count, 4);
  assert.equal(P.planMerge({ notes: [note(9, 1)], need: 5n, mergeFee: 1n }).code, 'single-note');
  assert.equal(P.planMerge({ notes: [note(5, 1), note(5, 2)], need: 5n, mergeFee: 50n }).code, 'fee-exceeds-notes');
  const many = P.planMerge({ notes: Array.from({ length: 30 }, (_, i) => note(1_000, i)), need: 1_000_000n, mergeFee: 10n });
  assert.equal(many.count, 16, 'at most sixteen inputs in one step');
});

test('notes: held balances by asset, and the cover a note has had', () => {
  const held = P.heldByAsset([note(3, 1), note(7, 2), note(5, 3, USDC)]);
  assert.deepEqual(held.get(ETH), { total: 10n, count: 2, largest: 7n });
  assert.deepEqual(held.get(USDC), { total: 5n, count: 1, largest: 5n });
  assert.equal(P.coverSince({ note: note(1, 100), poolStats: { totalNotesCreated: 130 } }), 29);
  assert.equal(P.coverSince({ note: note(1, 129), poolStats: { totalNotesCreated: 130 } }), 0);
  assert.equal(P.coverSince({ note: note(1, 200), poolStats: { totalNotesCreated: 130 } }), 0, 'never negative');
  assert.equal(P.coverSince({ note: note(1, 1), poolStats: null }), null);
});

test('assets: only pool assets the relay can take a fee in and that have a public token, one row per id', () => {
  const rows = [
    { ticker: 'TAC', assetId: '0xF0BB', native: false, underlying: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', unitScale: '10000000000', decimals: 18, tacitDecimals: 8 },
    { ticker: 'cETH', assetId: ETH, native: true, underlying: '0x0000000000000000000000000000000000000000', unitScale: '10000000000', decimals: 18, tacitDecimals: 8 },
    { ticker: 'cTAC', assetId: '0xf0bb', native: false, underlying: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', unitScale: '10000000000', decimals: 18, tacitDecimals: 8 },
    { ticker: 'cUSDC', assetId: USDC, native: false, underlying: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', unitScale: '1', decimals: 6, tacitDecimals: 6 },
    { ticker: 'cwstETH', assetId: '0x' + 'bb'.repeat(32), native: false, underlying: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', unitScale: '10000000000', decimals: 18, tacitDecimals: 8 },
    { ticker: 'cBTC', assetId: '0x' + 'cc'.repeat(32), native: false, underlying: null, unitScale: '10000000000', decimals: 18, tacitDecimals: 8 },
    { ticker: 'cUSD', assetId: '0x' + 'dd'.repeat(32), native: false, underlying: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564', unitScale: '10000000000', decimals: 18, tacitDecimals: 8 },
  ];
  const a = P.payoutAssets({ assets: rows, relayFeeEligible: (t) => ux0.relayFeeEligible(t) });
  assert.deepEqual(a.map((x) => x.ticker), ['cETH', 'cUSDC', 'cUSD', 'cTAC'], 'wstETH is not fee-eligible, cBTC has no token here, TAC and cTAC are one asset');
  const e = a.find((x) => x.ticker === 'cETH');
  assert.equal(e.token, null, 'ETH is paid natively');
  assert.equal(e.label, 'ETH');
  assert.equal(e.decimals, 8);
  assert.equal(e.unitScale, 10n ** 10n);
  const u = a.find((x) => x.ticker === 'cUSDC');
  assert.equal(u.token, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(u.decimals, 6);
  assert.equal(u.unitScale, 1n);
  assert.equal(a.find((x) => x.ticker === 'cUSD').label, 'tacUSD');
});

// ── confirmation: the recipient's public balance is the only proof ──

const fakeClock = () => {
  const c = { t: 1_000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
};

test('poll: paid only once the recipient balance has risen by the expected amount', async () => {
  const c = fakeClock();
  const seen = [];
  let calls = 0;
  const r = await P.waitForPayout({
    readBalance: async () => { calls++; return calls < 4 ? 1_000n : 1_000n + 500n; },
    baseline: 1_000n, expected: 500n, now: c.now, sleep: c.sleep, timeoutMs: 600_000, intervalMs: 5_000,
    onTick: (t) => seen.push(t.delta),
  });
  assert.equal(r.status, 'paid');
  assert.equal(r.delta, 500n);
  assert.equal(calls, 4);
  assert.deepEqual(c.sleeps, [5000, 5000, 5000]);
  assert.deepEqual(seen, [0n, 0n, 0n], 'a tick before each wait, none after success');
});

test('poll: a smaller rise is not payment; a larger rise (other inflow) still is', async () => {
  const c = fakeClock();
  const short = await P.waitForPayout({ readBalance: async () => 1_499n, baseline: 1_000n, expected: 500n, now: c.now, sleep: c.sleep, timeoutMs: 30_000, intervalMs: 10_000 });
  assert.equal(short.status, 'timeout');
  assert.equal(short.delta, 499n);
  const more = await P.waitForPayout({ readBalance: async () => 9_999n, baseline: 1_000n, expected: 500n, now: fakeClock().now, sleep: async () => {}, timeoutMs: 1 });
  assert.equal(more.status, 'paid');
});

test('poll: times out on the fake clock and never invents success', async () => {
  const c = fakeClock();
  let reads = 0;
  const r = await P.waitForPayout({ readBalance: async () => { reads++; return 1_000n; }, baseline: 1_000n, expected: 500n, now: c.now, sleep: c.sleep, timeoutMs: 60_000, intervalMs: 10_000 });
  assert.equal(r.status, 'timeout');
  assert.equal(reads, 7, 'polls at t=0,10,...,60 seconds, the last read at the deadline');
  assert.equal(c.t, 1_000 + 60_000);
});

test('poll: a relay that says settled proves nothing while the balance has not moved', async () => {
  const c = fakeClock();
  let jobReads = 0;
  const r = await P.waitForPayout({
    readBalance: async () => 42n, baseline: 42n, expected: 10n,
    readJob: async () => { jobReads++; return { status: 'settled', txHash: '0x' + 'ab'.repeat(32) }; },
    now: c.now, sleep: c.sleep, timeoutMs: 120_000, intervalMs: 10_000,
  });
  assert.equal(r.status, 'timeout', 'settled from the relay alone is still unconfirmed');
  assert.ok(jobReads > 3, 'the job was read every round');
  assert.notEqual(r.status, 'paid');
  assert.equal(r.job.txHash, '0x' + 'ab'.repeat(32), 'the settle tx is carried for display');
});

test('poll: a failed or lost job stops the wait, but the balance is read first', async () => {
  const c = fakeClock();
  const failed = await P.waitForPayout({ readBalance: async () => 5n, baseline: 5n, expected: 1n, readJob: async () => ({ status: 'failed', error: 'proof failed' }), now: c.now, sleep: c.sleep });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'proof failed');
  const lost = await P.waitForPayout({ readBalance: async () => 5n, baseline: 5n, expected: 1n, readJob: async () => ({ status: 'unknown' }), now: c.now, sleep: c.sleep });
  assert.equal(lost.status, 'lost');
  // One unknown read is not a lost job: a job stored moments ago can read as unknown from another edge.
  let reads = 0;
  const blip = await P.waitForPayout({
    readBalance: async () => (reads >= 3 ? 9n : 5n), baseline: 5n, expected: 4n,
    readJob: async () => ({ status: (reads++ === 0 ? 'unknown' : 'proving') }), now: c.now, sleep: c.sleep,
  });
  assert.equal(blip.status, 'paid');
  // A failure report does not override money that arrived.
  const arrived = await P.waitForPayout({ readBalance: async () => 6n, baseline: 5n, expected: 1n, readJob: async () => ({ status: 'failed' }), now: c.now, sleep: c.sleep });
  assert.equal(arrived.status, 'paid');
});

test('poll: read errors are tolerated and reported at the timeout', async () => {
  const c = fakeClock();
  let n = 0;
  const r = await P.waitForPayout({ readBalance: async () => { if (n++ < 2) throw new Error('rpc down'); return 9n; }, baseline: 4n, expected: 5n, now: c.now, sleep: c.sleep, timeoutMs: 100_000 });
  assert.equal(r.status, 'paid', 'recovers once the node answers');
  const dead = await P.waitForPayout({ readBalance: async () => { throw new Error('rpc down'); }, baseline: 4n, expected: 5n, now: c.now, sleep: c.sleep, timeoutMs: 20_000, intervalMs: 10_000 });
  assert.equal(dead.status, 'timeout');
  assert.match(dead.lastError.message, /rpc down/);
  await assert.rejects(P.waitForPayout({ readBalance: async () => 0n, baseline: 0n, expected: 0n }), (e) => e.code === 'zero-amount');
});

test('balance reader: ETH through eth_getBalance, a token through balanceOf of the padded address', async () => {
  const addr = '0x' + 'ab'.repeat(20);
  const calls = [];
  const rpc = async (m, p) => { calls.push([m, p]); return '0x' + (5n * 10n ** 17n).toString(16); };
  assert.equal(await P.makeBalanceReader({ rpc, address: addr })(), 5n * 10n ** 17n);
  assert.deepEqual(calls[0], ['eth_getBalance', [addr, 'latest']]);
  const token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const ethCall = async (to, data) => { calls.push([to, data]); return '0x' + (123_456n).toString(16).padStart(64, '0'); };
  assert.equal(await P.makeBalanceReader({ ethCall, token, address: addr.toUpperCase().replace('0X', '0x') })(), 123_456n);
  assert.deepEqual(calls[1], [token, '0x70a08231' + '0'.repeat(24) + 'ab'.repeat(20)]);
  await assert.rejects(P.makeBalanceReader({ ethCall: async () => '0x', token, address: addr })(), (e) => e.code === 'unreadable');
  await assert.rejects(P.makeBalanceReader({ rpc: async () => null, address: addr })(), (e) => e.code === 'unreadable');
  assert.throws(() => P.makeBalanceReader({ rpc, address: '0x12' }), (e) => e.code === 'not-address');
});

// ── wording ──

test('wording: the privacy note says what is hidden, what is public, that the pool is small, and what to do', () => {
  const all = P.PRIVACY_POINTS.join(' ').toLowerCase();
  assert.match(all, /hides who sent/);
  assert.match(all, /address and the amount are public|address and the amount/);
  assert.match(all, /small/);
  assert.match(all, /do not treat it as anonymous/);
  assert.match(all, /does not match a recent deposit/);
  assert.match(all, /wait between depositing and paying/);
  assert.match(P.poolSizeLine(1200), /about 1,200 shielded notes/);
  assert.match(P.poolSizeLine(1200), /small/);
  assert.doesNotMatch(P.poolSizeLine(200_000), /crowd you hide in is small/);
  assert.equal(P.poolSizeLine(0), null);
  assert.match(P.coverLine(3), /very little cover/);
  assert.doesNotMatch(P.coverLine(400), /very little/);
  assert.equal(P.coverLine(null), null);
});

test('wording: only the paid phase says the payment arrived, and a timeout says so with the job id', () => {
  const base = { amountText: '0.5', label: 'ETH', address: '0x' + 'ab'.repeat(20), jobId: '0xjob1234', receivedText: '0.5' };
  const say = (phase, extra = {}) => P.activityView({ ...base, phase, ...extra });
  assert.equal(say('paid').tone, 'ok');
  assert.match(say('paid').text, /^Paid: /);
  for (const phase of ['submitted', 'timeout', 'failed', 'lost']) {
    const v = say(phase, { relayStatus: 'settled', error: 'x' });
    assert.notEqual(v.tone, 'ok', phase);
    assert.doesNotMatch(v.text, /^Paid|arrived\./, `${phase} does not claim arrival`);
  }
  assert.match(say('timeout').text, /Submitted, not yet confirmed/);
  assert.match(say('timeout').text, /0xjob1234/);
  assert.match(say('submitted', { relayStatus: 'settled' }).text, /the relay says settled/);
  assert.match(say('failed').text, /Nothing was paid/);
  assert.equal(P.activityView(null), null);
  assert.equal(P.activityView({ ...base, phase: 'unknown' }), null);
  assert.equal(P.publicAssetLabel('cETH'), 'ETH');
  assert.equal(P.publicAssetLabel('cUSD'), 'tacUSD');
  assert.equal(P.publicAssetLabel('cBTC'), 'tacBTC');
});

// ── the numbers reviewed are the numbers the op carries ──

const RECIPIENT = '0x' + '12'.repeat(20);

function makeNotes(ux, walletPriv, values) {
  // One wrap deposit per note, all in a single tree, as a scan of the pool would return them.
  const built = values.map((v, index) => ux.buildWrap({ walletPriv, amountWei: (BigInt(v) * 10n ** 10n).toString(), ticker: 'cETH', index }));
  const events = built.map((w, i) => ({ type: 'LeavesInserted', firstLeafIndex: i, leaves: [w.leaf], memos: [w.memo] }));
  const recovered = ux.indexer.recover(events, walletPriv);
  const tree = new ux.pool.Tree();
  const idx = built.map((w) => tree.insert(w.leaf));
  const root = tree.root();
  return recovered.map((n, i) => ({ ...n, root, path: tree.rootAndPath(idx[i]).path, leafIndex: idx[i] }));
}

async function relayCapture() {
  const seen = { submits: [] };
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    let obj;
    if (String(url).includes('/confidential/submit')) { seen.submits.push(body); obj = { jobId: '0xjob' + seen.submits.length, status: 'pending' }; }
    else obj = { result: body && body.method === 'eth_gasPrice' ? '0x3b9aca00' : '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
  return { seen, ux: makeConfidentialPoolUx({ ...deps, fetchImpl }) };
}

test('sendUnwrap with the planned gross: the op pays the recipient exactly what was typed, fee as quoted, change back', async () => {
  const { seen, ux } = await relayCapture();
  const walletPriv = '0x' + '5e'.repeat(32);
  const [n] = makeNotes(ux, walletPriv, [10_000_000]);
  const minFee = 33_000n;
  const feeOf = (g) => ux.quoteUnwrapFee(g, 'cETH', { minFee }).fee;
  const plan = P.planPayout({ notes: [n], asset: n.asset, net: 5_000_000n, feeOf, minFee });
  assert.equal(plan.ok, true);
  assert.equal(plan.gross, 5_033_000n);
  assert.equal(plan.fee, 33_000n);
  const r = await ux.sendUnwrap({ note: plan.note, walletPriv, recipient: RECIPIENT, amount: plan.gross, feeOpts: { minFee }, wait: false });
  assert.equal(r.payout, 5_000_000n, 'the recipient is paid the typed amount');
  assert.equal(r.fee, 33_000n);
  assert.equal(r.change, 10_000_000n - 5_033_000n);
  assert.equal(r.jobId, '0xjob1');
  const { type, op } = seen.submits[0];
  assert.equal(type, 'sendunwrap');
  assert.equal(op.payout, 5_000_000);
  assert.equal(op.fee, 33_000);
  assert.equal(op.recipient, RECIPIENT);
  assert.equal(op.payout + op.fee, Number(plan.gross));
  assert.equal(P.underlyingUnits(BigInt(op.payout), 10n ** 10n), 5_000_000n * 10n ** 10n, 'wei the recipient receives');
});

test('sendUnwrap on a note the size of the gross: the whole-note exit carries the same fee and the same net', async () => {
  const { seen, ux } = await relayCapture();
  const walletPriv = '0x' + '5f'.repeat(32);
  const [n] = makeNotes(ux, walletPriv, [10_000_000]);
  const minFee = 33_000n;
  const feeOf = (g) => ux.quoteUnwrapFee(g, 'cETH', { minFee }).fee;
  const plan = P.planPayout({ notes: [n], asset: n.asset, net: 9_967_000n, feeOf, minFee });
  assert.equal(plan.wholeNote, true);
  assert.equal(plan.gross, 10_000_000n);
  const r = await ux.sendUnwrap({ note: plan.note, walletPriv, recipient: RECIPIENT, amount: plan.gross, feeOpts: { minFee }, wait: false });
  assert.equal(seen.submits[0].type, 'unwrap', 'no change to make, so the whole-note exit');
  assert.equal(seen.submits[0].op.fee, '33000');
  assert.equal(r.net, 9_967_000n, 'value minus the same fee');
  assert.equal(r.fee, plan.fee);
});

test('sendUnwrap refuses a gross beyond the note, and a pinned floor overrides the live quote', async () => {
  const { ux } = await relayCapture();
  const walletPriv = '0x' + '60'.repeat(32);
  const [n] = makeNotes(ux, walletPriv, [1_000_000]);
  await assert.rejects(ux.sendUnwrap({ note: n, walletPriv, recipient: RECIPIENT, amount: 1_000_001n, feeOpts: { minFee: 1n }, wait: false }), /exceeds the note/);
  const { seen, ux: ux2 } = await relayCapture();
  const [m] = makeNotes(ux2, walletPriv, [1_000_000]);
  await ux2.sendUnwrap({ note: m, walletPriv, recipient: RECIPIENT, amount: 500_000n, feeOpts: { minFee: 7_000n }, wait: false });
  assert.equal(seen.submits[0].op.fee, 7_000, 'the reviewed floor, not a fresh quote, sets the fee');
  assert.equal(seen.submits[0].op.payout, 493_000);
});

test('merge: several notes fold into one relayed self-transfer of the total minus its flat fee', async () => {
  const { ux } = await relayCapture();
  const walletPriv = '0x' + '61'.repeat(32);
  const notes = makeNotes(ux, walletPriv, [3_000_000, 3_000_000, 1_000_000]);
  const m = P.planMerge({ notes, need: 5_010_000n, mergeFee: 20_000n });
  assert.equal(m.ok, true);
  const me = ux.identity(walletPriv);
  const b = ux.buildTransferOp({ walletPriv, notes: m.notes, recipientPubHex: me.pubHex, amount: m.merged, fee: m.fee });
  assert.equal(b.op.inputs.length, m.count);
  assert.equal(b.op.outputs.length, 1, 'one merged note, no change');
  assert.equal(b.op.fee, '20000');
  assert.equal(b.amount, 5_980_000n);
  assert.equal(b.change, 0n);
});
