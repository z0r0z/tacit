// The tool that sends a few thousand sats of the reverse key's fee coin to a test wallet (tools/fastbridge-lp-reverse-sats.mjs): the amounts and addresses it accepts, the coin it picks,
// and that it sends only the plan whose token it is given.
//   node tests/fastbridge-lp-reverse-sats.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { parseSats, planSats, satsToken, executeSats, describePlan, MAX_SATS } from '../tools/fastbridge-lp-reverse-sats.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const OWN = 'bc1qrw6hkydh4rqve2kvj62am2p9ne9yzn2kdsdp2c', DEST = 'bc1qgscyvwsatkuhelul03wn522galpdu7glzyj703';
const coin = (n, value, confirmed = true) => ({ txid: String(n).repeat(64), vout: 0, value, status: { confirmed } });
const bytesToHex = (b) => Buffer.from(b).toString('hex');
const tacit = (coins, over = {}) => ({
  DUST: 546,
  decodeP2wpkhAddress: (a) => (/^(bc|tb)1q[a-z0-9]{38}$/.test(a) ? { hrp: a.slice(0, 2), program: Uint8Array.from({ length: 20 }, (_, i) => i + 1) } : null),
  scanHoldings: async () => new Map(),
  getUtxos: async () => coins,
  getFeeRate: async () => 1,
  estSatsSendVb: (n, change) => 11 + n * 68 + 31 + (change ? 31 : 0),
  selectSatsUtxosSafe: (all) => all,
  sent: [],
  wallet: { pub: Uint8Array.from([2, ...Array(32).fill(0x11)]), priv: new Uint8Array(32).fill(7) },
  p2wpkhScript: () => Uint8Array.from([0, 20, ...Array(20).fill(0xaa)]),
  signP2wpkhInputWithKey: (tx, i, value) => ['sig' + i + ':' + value],
  serializeTx: function (tx) { this.sent.push(JSON.parse(JSON.stringify(tx, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v)))); return Uint8Array.from([1, 2]); },
  broadcastWithRetry: async () => null,
  txid: () => 'f'.repeat(64),
  ...over,
});

test('the amount: a whole number from 1,000 to 5,000 sats; the address: a mainnet bech32 one that is not the key\'s own', async () => {
  assert.equal(parseSats('3000'), 3000); assert.equal(parseSats('1000'), 1000); assert.equal(parseSats('5000'), MAX_SATS);
  for (const bad of ['999', '5001', '0', '-1', '3e3', '30.5', '', null, 'abc', '100000']) assert.throws(() => parseSats(bad), /--sats/, String(bad));
  await assert.rejects(() => planSats({ tacit: tacit([coin(1, 12000)]), address: OWN, to: 'tb1qgscyvwsatkuhelul03wn522galpdu7glzyj703', sats: 3000 }), /mainnet bech32/);
  await assert.rejects(() => planSats({ tacit: tacit([coin(1, 12000)]), address: OWN, to: 'not an address', sats: 3000 }), /mainnet bech32/);
  await assert.rejects(() => planSats({ tacit: tacit([coin(1, 12000)]), address: OWN, to: OWN, sats: 3000 }), /own address/);
});

test('the plan picks the smallest confirmed plain coin that covers the amount, the fee and a change above dust, and adds up', async () => {
  const p = await planSats({ tacit: tacit([coin(1, 12716), coin(2, 6000), coin(3, 20000), coin(4, 3600), coin(5, 4000, false)]), address: OWN, to: DEST, sats: 3000 });
  assert.equal(p.coin.value, 6000, 'the 3,600 one is too small (3,000 + a fee of 141 + dust is 3,687), the unconfirmed one that would fit is not counted');
  assert.equal(p.coin.value, p.sats + p.fee + p.change);
  assert.ok(p.change > 546, 'a change that is not dust');
  assert.match(describePlan(p, OWN), /would send 3000 sats to bc1qgscy.*change/);
});

test('the fee follows the rate, never under 2 sat/vB (so a few thousand sats do not sit unconfirmed when blocks floor above 1)', async () => {
  const slow = await planSats({ tacit: tacit([coin(1, 12000)], { getFeeRate: async () => 0.2 }), address: OWN, to: DEST, sats: 3000 });
  const fast = await planSats({ tacit: tacit([coin(1, 12000)], { getFeeRate: async () => 5 }), address: OWN, to: DEST, sats: 3000 });
  assert.equal(slow.rate, 2); assert.equal(fast.rate, 5); assert.deepEqual([slow.fee, fast.fee], [282, 705], 'a 141 vB send at 2 and at 5 sat/vB');
});

test('no coin that fits is a refusal in words', async () => {
  await assert.rejects(() => planSats({ tacit: tacit([coin(1, 3500)]), address: OWN, to: DEST, sats: 3000 }), /no confirmed plain coin/);
  await assert.rejects(() => planSats({ tacit: tacit([coin(1, 50000, false)]), address: OWN, to: DEST, sats: 3000 }), /no confirmed plain coin/);
  await assert.rejects(() => planSats({ tacit: tacit([]), address: OWN, to: DEST, sats: 3000 }), /no confirmed plain coin/);
});

test('the token covers the destination, the amount, the coin and the fee', async () => {
  const base = { address: OWN, to: DEST, sats: 3000 };
  const a = await planSats({ ...base, tacit: tacit([coin(1, 12000)]) });
  assert.equal(satsToken(a), satsToken(await planSats({ ...base, tacit: tacit([coin(1, 12000)]) })));
  assert.notEqual(satsToken(a), satsToken(await planSats({ ...base, sats: 2000, tacit: tacit([coin(1, 12000)]) })));
  assert.notEqual(satsToken(a), satsToken(await planSats({ ...base, to: 'bc1qrw6hkydh4rqve2kvj62am2p9ne9yzn2kdsdp2c'.replace('rw6', 'rw7'), tacit: tacit([coin(1, 12000)]) })));
  assert.notEqual(satsToken(a), satsToken(await planSats({ ...base, tacit: tacit([coin(2, 12000)]) })));
  assert.notEqual(satsToken(a), satsToken(await planSats({ ...base, tacit: tacit([coin(1, 12000)], { getFeeRate: async () => 3 }) })));
});

test('it sends exactly the plan, once, to the named address; a wrong token sends nothing', async () => {
  const t = tacit([coin(1, 12000)]);
  const p = await planSats({ tacit: t, address: OWN, to: DEST, sats: 3000 });
  await assert.rejects(() => executeSats({ tacit: t, plan: p, token: 'nope', bytesToHex }), /confirm token/);
  assert.equal(t.sent.length, 0);
  // the token does not cover the change, so a plan whose change was altered keeps its token: the arithmetic is what refuses it
  const bent = { ...p, change: p.change + 1 };
  assert.equal(satsToken(bent), satsToken(p));
  await assert.rejects(() => executeSats({ tacit: t, plan: bent, token: satsToken(bent), bytesToHex }), /does not add up/);
  assert.equal(t.sent.length, 0);
  assert.equal(await executeSats({ tacit: t, plan: p, token: satsToken(p), bytesToHex }), 'f'.repeat(64));
  assert.equal(t.sent.length, 1);
  const tx = t.sent[0];
  assert.deepEqual(tx.inputs.map((i) => [i.txid, i.vout, i.sequence]), [[p.coin.txid, 0, 0xfffffffd]], 'one input, the plan\'s coin, replaceable');
  assert.equal(tx.outputs.length, 2);
  assert.deepEqual([tx.outputs[0].value, tx.outputs[0].script.slice(0, 2).join(), tx.outputs[0].script.length], [3000, '0,20', 22], 'the amount, to a P2WPKH script');
  assert.equal(tx.outputs[0].script[2], 1, 'the script carries the named address\'s program');
  assert.equal(tx.outputs[1].value, p.change, 'the rest back to the key');
  assert.equal(p.coin.value - tx.outputs[0].value - tx.outputs[1].value, p.fee, 'the whole of the fee is the plan\'s');
  assert.equal(tx.inputs[0].witness[0], 'sig0:' + p.coin.value, 'signed with the value it spends');
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} reverse sats-send checks passed`);
process.exit(process.exitCode || 0);
