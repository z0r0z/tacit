import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  classifyVerdict, classifyInputs, normalizeStuckPolicy, effectiveStuckCap,
  evaluateClassPricing, priceWithClass, advertiseStuckPolicy, makeClassPolicyScreen,
  encodeSealedQuoteV2, decodeSealedQuoteV2, SEALED_QUOTE_V2,
} from '../dapp/fastbridge-stuck-policy.js';

const TAC = 100_000_000n;
const samplePolicy = () => normalizeStuckPolicy({
  enabled: true, maxStuckShare: 0.15, maxStuckUnits: String(1500n * TAC),
  classes: {
    long: { enabled: true, minHaircutBps: 200, extraBps: 350, utilizationSlopeBps: 100, extraFlatFee: '0', maxAmount: String(500n * TAC) },
    pool_exit: { enabled: true, minHaircutBps: 400, extraBps: 650, utilizationSlopeBps: 150, extraFlatFee: String(5_000_000n), maxAmount: String(250n * TAC) },
  },
});

test('classifyVerdict maps lineage states and fails closed on unread', () => {
  assert.equal(classifyVerdict({ state: 'tracked' }), 'clean');
  assert.equal(classifyVerdict({ state: 'traced', hops: 12 }), 'clean');
  assert.equal(classifyVerdict({ state: 'long', hops: 256, max: 255 }), 'long');
  assert.equal(classifyVerdict({ state: 'unprovable', through: 'opcode 0x6d' }), 'pool_exit');
  assert.equal(classifyVerdict({ state: 'unread' }), null);
});

test('classifyInputs uses worst-input class and fails closed on unread', () => {
  const inputs = [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: 'bb'.repeat(32), vout: 1 }];
  const mixed = classifyInputs(inputs, new Map([
    [`${'aa'.repeat(32)}:0`, { state: 'tracked' }],
    [`${'bb'.repeat(32)}:1`, { state: 'unprovable', through: 'opcode 0x6d' }],
  ]));
  assert.equal(mixed.ok, true);
  assert.equal(mixed.noteClass, 'pool_exit');
  const unread = classifyInputs(inputs, new Map([
    [`${'aa'.repeat(32)}:0`, { state: 'tracked' }],
    [`${'bb'.repeat(32)}:1`, { state: 'unread' }],
  ]));
  assert.equal(unread.ok, false);
  assert.equal(unread.retry, true);
});

test('normalizeStuckPolicy is safe by default and rejects floorless/capless configs', () => {
  assert.equal(normalizeStuckPolicy(undefined).enabled, false);
  assert.throws(() => normalizeStuckPolicy({ enabled: true, classes: { long: { enabled: true, extraBps: 300 } } }), /hard cap/i);
  assert.throws(() => normalizeStuckPolicy({ enabled: true, maxStuckShare: 0.1, classes: { long: { enabled: true, minHaircutBps: 250, extraBps: 100 } } }), /below configured floor/i);
});

test('priceWithClass and hard inventory cap enforce class haircuts and keep clean open', () => {
  const policy = samplePolicy();
  const inv = { totalUnits: 10000n * TAC, stuckUnits: 0n, pendingStuckUnits: 0n };
  const clean = priceWithClass({ policy, noteClass: 'clean', amount: 100n * TAC, minAmount: 1n * TAC, maxAmount: 1000n * TAC, baseFeeBps: 30, baseFlatFee: 10_000_000n, inventory: inv });
  assert.equal(clean.feeBps, 30);
  const longQ = priceWithClass({ policy, noteClass: 'long', amount: 100n * TAC, minAmount: 1n * TAC, maxAmount: 1000n * TAC, baseFeeBps: 30, baseFlatFee: 10_000_000n, inventory: inv });
  assert.equal(longQ.feeBps, 387);
  assert.equal(effectiveStuckCap(policy, 8000n * TAC), 1200n * TAC);
  const blocked = evaluateClassPricing({ policy, noteClass: 'long', amount: 250n * TAC, baseFeeBps: 30, inventory: { totalUnits: 8000n * TAC, stuckUnits: 1000n * TAC, pendingStuckUnits: 0n } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'stuck_cap_reached');
});

test('makeClassPolicyScreen blocks bait-and-switch and cap race', async () => {
  const policy = samplePolicy();
  const txid = '11'.repeat(32);
  const screen = makeClassPolicyScreen({
    vet: async () => new Map([[`${txid}:0`, { state: 'unprovable', through: 'opcode 0x6d' }]]),
    policy,
    getInventory: async () => ({ totalUnits: 10000n * TAC, stuckUnits: 0n, pendingStuckUnits: 0n }),
  });
  const bait = await screen([{ txid, vout: 0 }], { noteClass: 'clean', btcValue: String(100n * TAC) });
  assert.ok(bait && bait.retry === false);
});

test('sealed quote v2 binds noteClass under HMAC', () => {
  const macKey = crypto.randomBytes(32);
  const params = { claimPub: '02' + 'ab'.repeat(32), btcAsset: 'f0'.repeat(32), evmAsset: '0x' + 'f0'.repeat(32), csvBlocks: 144, evmWindowSecs: 14400, minConfsFor: () => 1 };
  const macOf = (body) => crypto.createHmac('sha256', macKey).update(body).digest('hex').slice(0, 32);
  const id = encodeSealedQuoteV2({ quote: { noteClass: 'pool_exit', created: 1795700000, validUntil: 1795700600, takeSats: 2546, btcValue: String(100n * TAC), evmAmount: String(93n * TAC) }, macOf, randomHex: (n) => crypto.randomBytes(n).toString('hex') });
  assert.ok(SEALED_QUOTE_V2.test(id));
  assert.equal(decodeSealedQuoteV2({ id, macOf, params }).noteClass, 'pool_exit');
  assert.equal(decodeSealedQuoteV2({ id: '0200' + id.slice(4), macOf, params }), null);
});

test('advertiseStuckPolicy omits field when disabled', () => {
  assert.equal(advertiseStuckPolicy({ policy: normalizeStuckPolicy(null), baseFeeBps: 30 }), undefined);
});
