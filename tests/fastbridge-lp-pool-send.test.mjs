// The tool that sends a little private TAC from the provider's pool account to a test identity (tools/fastbridge-lp-pool-send.mjs): the amount and recipient it accepts,
// the note it picks, and that it sends only the plan whose token it is given.
//   node tests/fastbridge-lp-pool-send.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { parseTac, parsePub, planSend, sendToken, executeSend, describePlan, MAX_TAC_UNITS } from '../tools/fastbridge-lp-pool-send.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const PUB = '02' + 'ab'.repeat(32), T = 10n ** 8n;
const ux = (notes, fee = 5000000n, ticker = 'TAC') => ({
  balance: async () => ({ byAsset: { a: { ticker, asset: '0xasset', notes: notes.map((v, i) => ({ value: String(v), leaf: 'L' + i })) } } }),
  quoteOpFee: async () => fee,
  sent: [],
  stealthSend: async function (o) { this.sent.push(o); return { txHash: '0xabc' }; },
});

test('the amount: whole or up to 8 places, more than 0, no more than 5 TAC; the recipient: a 66-hex compressed key', () => {
  assert.equal(parseTac('1.6'), 160000000n); assert.equal(parseTac('5'), MAX_TAC_UNITS); assert.equal(parseTac('0.00000001'), 1n);
  for (const bad of ['0', '5.00000001', '6', '-1', '1e3', '', null, '1.123456789', 'abc']) assert.throws(() => parseTac(bad), /--tac/, String(bad));
  assert.equal(parsePub(PUB), PUB); assert.equal(parsePub('0x' + PUB.toUpperCase()), PUB);
  for (const bad of ['', '04' + 'ab'.repeat(32), '02' + 'ab'.repeat(31), 'zz' + 'ab'.repeat(32), null]) assert.throws(() => parsePub(bad), /--to/, String(bad));
});

test('the plan picks the smallest note that covers the amount and the fee, and says what is left as change', async () => {
  const p = await planSend({ ux: ux([5000n * T, 2n * T, 100n * T, T]), key: new Uint8Array(32), amount: 160000000n, toPub: PUB });
  assert.equal(p.noteValue, 2n * T, 'the 2 TAC note: the 1 TAC one is too small, the others larger');
  assert.equal(p.fee, 5000000n);
  assert.match(describePlan(p, '0xfrom'), /would lock 1\.6 TAC privately for the identity .*split fee 0\.05 TAC.*0\.35 TAC\) stays with the provider/);
});

test('it refuses in words when the provider holds no private TAC or no note covers it', async () => {
  await assert.rejects(() => planSend({ ux: ux([T], 0n, 'cETH'), key: new Uint8Array(32), amount: T, toPub: PUB }), /holds no private TAC/);
  await assert.rejects(() => planSend({ ux: ux([T, 2n * T]), key: new Uint8Array(32), amount: 3n * T, toPub: PUB }), /no single note/);
  await assert.rejects(() => planSend({ ux: ux([160000000n]), key: new Uint8Array(32), amount: 160000000n, toPub: PUB }), /no single note/, 'the fee has to be covered too');
});

test('the token covers the amount, the fee, the recipient and the note', async () => {
  const base = { ux: ux([2n * T]), key: new Uint8Array(32), amount: 160000000n, toPub: PUB };
  const a = await planSend(base);
  assert.equal(sendToken(a), sendToken(await planSend(base)));
  assert.notEqual(sendToken(a), sendToken(await planSend({ ...base, amount: 150000000n })));
  assert.notEqual(sendToken(a), sendToken(await planSend({ ...base, toPub: '03' + 'ab'.repeat(32) })));
  assert.notEqual(sendToken(a), sendToken(await planSend({ ...base, ux: ux([2n * T], 6000000n) })));
  assert.notEqual(sendToken(a), sendToken(await planSend({ ...base, ux: ux([3n * T]) })));
});

test('it sends exactly the plan, once, with its own note, to the named identity; a wrong token sends nothing', async () => {
  const u = ux([2n * T]), key = new Uint8Array(32).fill(3);
  const p = await planSend({ ux: u, key, amount: 160000000n, toPub: PUB });
  await assert.rejects(() => executeSend({ ux: u, key, plan: p, token: 'nope' }), /confirm token/);
  assert.equal(u.sent.length, 0);
  assert.equal(await executeSend({ ux: u, key, plan: p, token: sendToken(p) }), '0xabc');
  assert.equal(u.sent.length, 1);
  const o = u.sent[0];
  assert.deepEqual([o.recipientPubHex, o.amount, o.fee, o.notes.length, String(o.notes[0].value), o.walletPriv === key], [PUB, 160000000n, undefined, 1, String(2n * T), true]);
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} pool-send checks passed`);
process.exit(process.exitCode || 0);
