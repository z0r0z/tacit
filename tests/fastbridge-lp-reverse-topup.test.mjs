// The tool that moves one plain coin of the provider's main address to its reverse address (tools/fastbridge-lp-reverse-topup.mjs): the coins it will touch, the plan, the token,
// and that it signs and sends only that plan.
//   node tests/fastbridge-lp-reverse-topup.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { parseOutpoint, planTopup, topupToken, executeTopup, describePlan, MIN_COIN, MAX_COIN, SEND_VB } from '../tools/fastbridge-lp-reverse-topup.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MAIN = 'bc1q8c9uenuwgj8w22mrd6lr50x7dxxfd9588gsx9f', REV = 'bc1qrw6hkydh4rqve2kvj62am2p9ne9yzn2kdsdp2c';
const SPK = '0014' + '11'.repeat(20), TX = 'ab'.repeat(32);
const bytesToHex = (b) => Buffer.from(b).toString('hex');
const world = (o = {}) => ({
  fetchJson: async (path) => {
    if (path === `/tx/${TX}`) return o.tx === undefined ? { status: { confirmed: true }, vout: [{ value: 48438, scriptpubkey_address: MAIN, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey: SPK }, { value: 20000, scriptpubkey_address: 'bc1qother', scriptpubkey_type: 'v0_p2wpkh', scriptpubkey: SPK }] } : (() => { if (!o.tx) throw new Error('x'); return o.tx; })();
    if (path === `/tx/${TX}/outspend/0`) return o.outspend === undefined ? { spent: false } : o.outspend;
    throw new Error('unexpected ' + path);
  },
});
const plan = (o = {}, coin = { txid: TX, vout: 0 }, rate) => planTopup({ coin, mainAddress: MAIN, reverseAddress: REV, fetchJson: world(o).fetchJson, ...(rate ? { rate } : {}) });

test('the coin argument: a txid and an output number', () => {
  assert.deepEqual(parseOutpoint(TX + ':3'), { txid: TX, vout: 3 }); assert.deepEqual(parseOutpoint(TX.toUpperCase() + ':0'), { txid: TX, vout: 0 });
  for (const bad of ['', null, TX, TX + ':', TX + ':x', 'zz:0', TX + ':12345']) assert.throws(() => parseOutpoint(bad), /--coin/, String(bad));
});

test('the plan: the whole coin less the fee (2 sat/vB at least), to the reverse address, and it adds up', async () => {
  const p = await plan();
  assert.equal(p.fee, SEND_VB * 2); assert.equal(p.out + p.fee, p.coin.value); assert.equal(p.to, REV);
  assert.equal((await plan({}, undefined, 5)).fee, SEND_VB * 5, 'a higher rate is followed');
  assert.equal((await plan({}, undefined, 0.3)).fee, SEND_VB * 2, 'a lower one is not');
  assert.match(describePlan(p, MAIN), /would move it whole to the reverse address bc1qrw6.*48218 sats arrive/);
});

test('it refuses what is not a plain, confirmed, unspent, mid-sized coin of the main address', async () => {
  await assert.rejects(() => plan({}, { txid: TX, vout: 1 }), /not a plain output of the provider's main address/);
  await assert.rejects(() => plan({}, { txid: TX, vout: 7 }), /could not be read/);
  await assert.rejects(() => plan({ tx: null }), /could not be read/);
  await assert.rejects(() => plan({ tx: { status: { confirmed: false }, vout: [{ value: 48438, scriptpubkey_address: MAIN, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey: SPK }] } }), /not confirmed/);
  await assert.rejects(() => plan({ tx: { status: { confirmed: true }, vout: [{ value: 48438, scriptpubkey_address: MAIN, scriptpubkey_type: 'v0_p2tr', scriptpubkey: SPK }] } }), /not a plain output/);
  for (const v of [546, MIN_COIN - 1, MAX_COIN + 1, 1_199_522]) await assert.rejects(() => plan({ tx: { status: { confirmed: true }, vout: [{ value: v, scriptpubkey_address: MAIN, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey: SPK }] } }), /moves coins of 10000 to 200000 sats only/, 'value ' + v);
  await assert.rejects(() => plan({ outspend: { spent: true } }), /already spent/);
  await assert.rejects(() => plan({ outspend: null }), /already spent, or its state could not be read/);
});

test('the token covers the coin, the destination and the fee', async () => {
  const a = await plan();
  assert.equal(topupToken(a), topupToken(await plan()));
  assert.notEqual(topupToken(a), topupToken(await plan({}, undefined, 6)));
  assert.notEqual(topupToken(a), topupToken({ ...a, to: 'bc1qother' }));
  assert.notEqual(topupToken(a), topupToken({ ...a, coin: { ...a.coin, vout: 1 } }));
});

const sender = () => {
  const sent = [];
  return { sent, tacit: { DUST: 546, p2wpkhScript: (pub) => Uint8Array.from([0, 20, ...pub.slice(1, 21)]),
    signP2wpkhInputWithKey: (tx, i, value, priv, pub) => ['sig' + i + ':' + value + ':' + priv[0]], serializeTx: (tx) => { sent.push(JSON.parse(JSON.stringify(tx, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v)))); return Uint8Array.from([1, 2]); },
    broadcastWithRetry: async () => null, txid: () => 'f'.repeat(64) } };
};
const mainPub = Uint8Array.from([2, ...Array(32).fill(0x11)]), revPub = Uint8Array.from([2, ...Array(32).fill(0x22)]), mainPriv = new Uint8Array(32).fill(9);

test('it signs and sends exactly the plan: one input, one output to the reverse key, nothing else', async () => {
  const p = await plan(), s = sender();
  assert.equal(await executeTopup({ tacit: s.tacit, plan: p, token: topupToken(p), mainPriv, mainPub, reversePub: revPub, bytesToHex }), 'f'.repeat(64));
  const tx = s.sent[0];
  assert.deepEqual(tx.inputs.map((i) => [i.txid, i.vout, i.sequence]), [[TX, 0, 0xfffffffd]]);
  assert.equal(tx.outputs.length, 1); assert.equal(tx.outputs[0].value, p.out);
  assert.equal(tx.outputs[0].script[2], 0x22, 'to the reverse key\'s script, not the main one');
  assert.equal(tx.inputs[0].witness[0], `sig0:${p.coin.value}:9`, 'signed with the main key over the coin\'s own value');
});

test('it sends nothing for a wrong token, a key that does not own the coin, or a plan that does not add up', async () => {
  const p = await plan(), s = sender();
  await assert.rejects(() => executeTopup({ tacit: s.tacit, plan: p, token: 'nope', mainPriv, mainPub, reversePub: revPub, bytesToHex }), /confirm token/);
  await assert.rejects(() => executeTopup({ tacit: s.tacit, plan: p, token: topupToken(p), mainPriv, mainPub: Uint8Array.from([2, ...Array(32).fill(0x33)]), reversePub: revPub, bytesToHex }), /not the one that owns that output/);
  const bad = { ...p, out: p.out + 1 };
  await assert.rejects(() => executeTopup({ tacit: s.tacit, plan: bad, token: topupToken(bad), mainPriv, mainPub, reversePub: revPub, bytesToHex }), /does not add up/);
  assert.equal(s.sent.length, 0);
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} reverse top-up checks passed`);
process.exit(process.exitCode || 0);
