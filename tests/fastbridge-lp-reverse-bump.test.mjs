// The tool that speeds up a stuck transfer of the reverse key (tools/fastbridge-lp-reverse-bump.mjs): the fee arithmetic, what it refuses to touch, and what it sends.
//   node tests/fastbridge-lp-reverse-bump.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { childFee, planBump, bumpToken, executeBump, describePlan, CHILD_VB, MAX_FEE, TAC } from '../tools/fastbridge-lp-reverse-bump.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ADDR = 'bc1qrw6hkydh4rqve2kvj62am2p9ne9yzn2kdsdp2c', SPK = '0014' + '11'.repeat(20);
const P = 'a1'.repeat(32), COIN = 'c2'.repeat(32);
const bytesToHex = (b) => Buffer.from(b).toString('hex');

const parentTx = (o = {}) => ({ status: { confirmed: false }, fee: 150, weight: 1611, vout: [{ value: 546, scriptpubkey_address: ADDR, scriptpubkey: SPK }, { value: 546, scriptpubkey_address: ADDR, scriptpubkey: SPK }], ...o });
const world = (o = {}) => {
  const parent = o.parent === undefined ? parentTx() : o.parent;
  return {
    fetchJson: async (path) => {
      if (path === `/tx/${P}`) { if (!parent) throw new Error('x'); return parent; }
      if (path === `/tx/${P}/outspend/1`) return o.outspend === undefined ? { spent: false } : o.outspend;
      throw new Error('unexpected ' + path);
    },
    tacit: {
      DUST: 546,
      scanHoldings: async () => new Map([[TAC, { utxos: o.utxos || [{ utxo: { txid: P, vout: 0 }, amount: 300000000n }] }]]),
      getUtxos: async () => o.coins || [{ txid: COIN, vout: 3, value: 16840, status: { confirmed: true } }, { txid: P, vout: 1, value: 546, status: { confirmed: false } }],
      selectSatsUtxosSafe: (all) => all,
    },
  };
};
const plan = (o, extra = {}) => { const w = world(o); return planBump({ tacit: w.tacit, parentTxid: P, address: ADDR, fetchJson: w.fetchJson, ...extra }); };

test('the fee makes parent and child together reach the rate, and the child alone never pays under 1 sat/vB', () => {
  const f = childFee({ parentFee: 150, parentVsize: 403, rate: 2 });
  assert.equal(f, Math.ceil(2 * (403 + CHILD_VB)) - 150);
  assert.ok((150 + f) / (403 + CHILD_VB) >= 2);
  assert.equal(childFee({ parentFee: 5000, parentVsize: 403, rate: 1 }), CHILD_VB, 'a parent that already pays enough: the child still pays for itself');
});

test('the plan: spends output 1 and one confirmed coin, the change adds up, the package reaches the rate', async () => {
  const p = await plan({});
  assert.deepEqual([p.spend.txid, p.spend.vout, p.spend.value], [P, 1, 546]);
  assert.deepEqual([p.coin.txid, p.coin.vout], [COIN, 3]);
  assert.equal(p.spend.value + p.coin.value - p.change, p.fee);
  assert.ok(p.packageRate >= 2 && p.packageRate < 2.1, 'the package rate is the asked one: ' + p.packageRate);
  assert.match(describePlan(p, ADDR), /output 0, which is not touched/);
});

test('it refuses what is not exactly the stuck move: confirmed, unreadable, output 1 elsewhere or spent, TAC at output 1 or none at output 0', async () => {
  await assert.rejects(() => plan({ parent: parentTx({ status: { confirmed: true } }) }), /already confirmed/);
  await assert.rejects(() => plan({ parent: null }), /could not be read/);
  await assert.rejects(() => plan({ parent: parentTx({ vout: [{ value: 546, scriptpubkey_address: ADDR }, { value: 546, scriptpubkey_address: 'bc1qother' }] }) }), /does not pay the reverse address/);
  await assert.rejects(() => plan({ outspend: { spent: true } }), /already spent/);
  await assert.rejects(() => plan({ outspend: null }), /already spent, or its state could not be read/);
  await assert.rejects(() => plan({ utxos: [{ utxo: { txid: P, vout: 0 }, amount: 3n }, { utxo: { txid: P, vout: 1 }, amount: 1n }] }), /other than output 0/);
  await assert.rejects(() => plan({ utxos: [] }), /does not see TAC at output 0/);
  await assert.rejects(() => plan({ utxos: [{ utxo: { txid: P, vout: 0 }, amount: 0n }] }), /does not see TAC at output 0/);
  await assert.rejects(() => plan({ utxos: [{ utxo: { txid: 'ee'.repeat(32), vout: 0 }, amount: 3n }] }), /does not see TAC at output 0/, 'a note of another transaction does not count');
});

test('the coin: confirmed, not the stuck transaction\'s own output, big enough; none is a refusal in words', async () => {
  await assert.rejects(() => plan({ coins: [{ txid: COIN, vout: 3, value: 16840, status: { confirmed: false } }] }), /no confirmed plain-sat coin/);
  await assert.rejects(() => plan({ coins: [{ txid: P, vout: 1, value: 20000, status: { confirmed: true } }] }), /no confirmed plain-sat coin/);
  await assert.rejects(() => plan({ coins: [{ txid: COIN, vout: 3, value: 600, status: { confirmed: true } }] }), /large enough/);
  const two = await plan({ coins: [{ txid: 'd3'.repeat(32), vout: 0, value: 9000, status: { confirmed: true } }, { txid: COIN, vout: 3, value: 2500, status: { confirmed: true } }] });
  assert.equal(two.coin.value, 2500, 'the smallest coin that covers it');
});

test('the rate and the fee are bounded', async () => {
  await assert.rejects(() => plan({}, { rate: 0.5 }), /--rate must be between/);
  await assert.rejects(() => plan({}, { rate: 11 }), /--rate must be between/);
  await assert.rejects(() => plan({ parent: parentTx({ fee: 1, weight: 40000 }) }, { rate: 10 }), new RegExp(`above the ${MAX_FEE}`));
  await assert.rejects(() => planBump({ tacit: world().tacit, parentTxid: 'zz', address: ADDR, fetchJson: world().fetchJson }), /64-hex/);
});

test('the token covers what is spent, the fee and the change', async () => {
  const a = await plan({}), b = await plan({}, { rate: 3 }), c = await plan({ coins: [{ txid: COIN, vout: 4, value: 16840, status: { confirmed: true } }] });
  assert.equal(bumpToken(a), bumpToken(await plan({})));
  assert.notEqual(bumpToken(a), bumpToken(b)); assert.notEqual(bumpToken(a), bumpToken(c));
});

const sender = () => {
  const sent = [];
  return { sent, tacit: { DUST: 546, wallet: { pub: Uint8Array.from([2, ...Array(32).fill(0x11)]), priv: new Uint8Array(32).fill(7) }, p2wpkhScript: () => Uint8Array.from(Buffer.from(SPK, 'hex')),
    signP2wpkhInputWithKey: (tx, i, value) => ['sig' + i + ':' + value], serializeTx: (tx) => { sent.push(JSON.parse(JSON.stringify(tx))); return Uint8Array.from([1, 2]); },
    broadcastWithRetry: async () => null, txid: () => 'f'.repeat(64) } };
};

test('what it sends: one transaction, the output 1 and the coin signed with their own values, one output back to the key, the fee as planned', async () => {
  const p = await plan({}), s = sender();
  assert.equal(await executeBump({ tacit: s.tacit, plan: p, token: bumpToken(p), bytesToHex }), 'f'.repeat(64));
  const tx = s.sent[0];
  assert.deepEqual(tx.inputs.map((i) => [i.txid, i.vout, i.sequence]), [[P, 1, 0xfffffffd], [COIN, 3, 0xfffffffd]]);
  assert.deepEqual(tx.inputs.map((i) => i.witness[0]), ['sig0:546', 'sig1:16840'], 'each input signed with the value it spends');
  assert.equal(tx.outputs.length, 1); assert.equal(tx.outputs[0].value, p.change);
  assert.ok(!tx.inputs.some((i) => i.txid === P && i.vout === 0), 'the output that holds the notes is never spent');
});

test('it sends nothing for a wrong token, a wallet that is not the key, or a plan that does not add up', async () => {
  const p = await plan({}), s = sender();
  await assert.rejects(() => executeBump({ tacit: s.tacit, plan: p, token: 'nope', bytesToHex }), /confirm token/);
  const other = sender(); other.tacit.p2wpkhScript = () => Uint8Array.from(Buffer.from('0014' + '22'.repeat(20), 'hex'));
  await assert.rejects(() => executeBump({ tacit: other.tacit, plan: p, token: bumpToken(p), bytesToHex }), /not the key that owns that output/);
  const bad = { ...p, change: p.change + 1 };
  await assert.rejects(() => executeBump({ tacit: s.tacit, plan: bad, token: bumpToken(bad), bytesToHex }), /does not add up/);
  assert.equal(s.sent.length + other.sent.length, 0);
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} stuck-transfer bump checks passed`);
process.exit(process.exitCode || 0);
