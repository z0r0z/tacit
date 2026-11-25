import assert from 'node:assert/strict';
import { makePledge, makePledgedFunding } from '../btcswap-desk/pledge.mjs';
import { makeBtcSwapDesk } from '../dapp/btcswap-desk.js';
import { makeMemoryStore } from '../fastbridge-lp/lib/store.mjs';
import { world, HELD } from './lib/btcswap-world.mjs';
import { tacit } from './lib/btc-sim.mjs';

const cases = [];
const test = (name, run) => cases.push({ name, run });
const idOf = (note) => `${note.txid}:${note.vout}`;
const config = (outpoints, more) => ({ outpoints, minDiscountBps: 400, maxDiscountBps: 600, maxMinerFeeSats: 10_000, ...more });
const key = (n) => n.toString(16).padStart(64, '0');
const quote = (desk, amount) => desk.handle({ method: 'POST', path: '/quote', body: { amount: String(amount) } }).then((r) => r.body);

test('the two bounds include the flat fee and compare exact base units', () => {
  const pledge = makePledge(config([]));
  assert.equal(pledge.permits('10000', '9600'), true);
  assert.equal(pledge.permits('10000', '9400'), true);
  assert.equal(pledge.permits('10000', '9601'), false);
  assert.equal(pledge.permits('10000', '9399'), false);
  assert.equal(pledge.permits('3', '3'), false);
  assert.equal(pledge.permits('3', '2'), false);
  assert.equal(makePledge(undefined), null);
  for (const bad of [null, {}, config(['abc']), config([key(1) + ':4294967296']), config([key(1) + ':0', key(1) + ':0']),
    config([], { maxDiscountBps: 399 }), config([], { maxDiscountBps: 10000 }), config([], { minDiscountBps: '400' }), config([], { maxMinerFeeSats: 0 })]) {
    assert.throws(() => makePledge(bad), /pledge/);
  }
});

test('only explicit roots and their funded, tracked change can contribute again', () => {
  const note = (n, vout = 0) => ({ txid: key(n), vout, amount: 100n });
  const first = note(1), second = note(2), change = note(3, 1), later = note(4, 1);
  const roots = [idOf(first), idOf(second)];
  const paid = { phase: 'done', lockPair: { txid: key(3) }, noteInputs: [first, second], pledgeRoots: roots };
  const next = { phase: 'refunded', lockPair: { txid: key(4) }, noteInputs: [change], pledgeRoots: roots };
  const legacy = { phase: 'done', lockPair: { txid: key(5) }, noteInputs: [note(6)] };
  const notes = [first, second, change, later, later, note(3, 0), note(4, 0), note(5, 1), note(7), note(8)];
  const records = [next, legacy, paid];
  assert.deepEqual(makePledge(config(roots)).inventory(notes, records), [{ ...later, pledgeRoots: roots }]);
  assert.deepEqual(makePledge(config([roots[0]])).inventory(notes, records), []);
  assert.deepEqual(makePledge(config([idOf(later)])).inventory(notes, records), [{ ...later, pledgeRoots: [idOf(later)] }]);
});

function pledgedWorld() {
  const w = world({ desk: { feeBps: 500, flatFee: 0n, validSecs: 3600 } });
  const root = idOf(w.deskNote), fetchTx = w.dBtc.fetchTx;
  const spk = Buffer.from(w.dW.prims.p2wpkhScript(w.dW.wallet.pub)).toString('hex');
  const fees = [11, 12, 13].map((i) => ({ txid: key(i), vout: 0, value: 120_000 }));
  w.dBtc.satsUtxos = async () => fees;
  w.dBtc.fetchTx = async (id) => fees.some((c) => c.txid === id)
    ? { txid: id, status: { confirmed: true }, vin: [{ witness: [] }], vout: [{ value: 120_000, scriptpubkey: spk }] } : fetchTx(id);
  const funding = makePledgedFunding(w.dBtc, tacit.txOutputEnvelope);
  w.configure = (settings) => { w.desk = w.makeDesk({ pledge: makePledge(settings), pledgedFunding: funding }); };
  w.configure(config([root]));
  return w;
}

test('the miner ceiling counts omitted dust change and excludes note-bearing fee parents', async () => {
  const spk = '0014' + '12'.repeat(20);
  const coins = [21, 22, 23, 24].map((i) => ({ txid: key(i), vout: 0, value: 10_000 }));
  const [envelope, busy, spent, plain] = coins;
  const btc = {
    wallet: {}, prims: { p2wpkhScript: () => Buffer.from(spk, 'hex') }, satsUtxos: async () => coins,
    fetchTx: async (id) => ({ txid: id, status: { confirmed: true }, vin: [{}], vout: [{ scriptpubkey: spk, value: 10_000 }] }),
    outspend: async (id) => id === spent.txid ? key(30) : null, feeRate: async () => 2,
    tx: { lockTransfer: ({ satsUtxos }) => {
      assert.deepEqual(satsUtxos, [plain]);
      return { commitTx: { inputs: [plain], outputs: [{ value: 9_500 }] }, revealTx: { outputs: [{ value: 9_246 }] } };
    } },
  };
  const fund = makePledgedFunding(btc, (tx) => tx.txid === envelope.txid ? { opcode: 0x6d } : null);
  const args = { notes: [{ value: 546 }] }, records = [{ lockPair: { feeInputs: [idOf(busy)] } }];
  // 10,000 + 546 enter the package, 9,246 leave. The stripped 500 sats of change are a real fee.
  await assert.rejects(fund('lockTransfer', args, 1299, records), /1300/);
  assert.deepEqual((await fund('lockTransfer', args, 1300, records)).feeInputs, [idOf(plain)]);
});

test('the API quotes only available tracked pledges and the configured total discount', async () => {
  const w = pledgedWorld(), root = idOf(w.deskNote);
  const info = () => w.desk.handle({ method: 'GET', path: '/info' }).then((r) => r.body);
  assert.equal((await info()).available, String(w.deskNote.amount));
  for (const status of ['bound', 'untracked', 'new']) {
    w.trackingOf = { desk: () => status };
    assert.equal((await info()).available, '0');
  }
  w.trackingOf = {};
  w.configure(config([]));
  assert.equal((await info()).available, '0');
  assert.equal((await quote(w.desk, HELD)).ok, false);
  w.configure(config([root], { minDiscountBps: 501 }));
  assert.match((await quote(w.desk, HELD)).why, /discount/);
  w.configure(config([root], { maxDiscountBps: 499 }));
  assert.match((await quote(w.desk, HELD)).why, /discount/);
  w.desk = w.makeDesk();
  assert.equal((await info()).pledge, undefined);
  assert.equal((await quote(w.desk, HELD)).out, String(HELD * 95n / 100n));
});

test('a stricter price after acceptance stops an unfunded lock', async () => {
  const w = pledgedWorld();
  await w.start();
  w.deskOnline = false;
  await w.run(async () => (await w.d())?.phase === 'accepted');
  w.configure(config([idOf(w.deskNote)], { minDiscountBps: 501 }));
  await w.desk.tick();
  assert.equal((await w.d()).phase, 'aborted');
  assert.equal((await w.d()).lockPair, undefined);
});

test('removing the pledge before a persisted offer is funded cannot draw on the rest of the wallet', async () => {
  const w = pledgedWorld();
  await w.start();
  w.deskOnline = false;
  await w.run(async () => (await w.d())?.phase === 'accepted');
  w.configure(undefined);
  await w.desk.tick();
  assert.match((await w.d()).why, /withdrew its pledge/);
  assert.equal((await w.d()).lockPair, undefined);
});

test('both parties settle through the API after a restart, with distinct capped fee coins', async () => {
  const w = pledgedWorld();
  await w.start();
  await w.run(async () => (await w.d())?.phase === 'locked');
  const locked = await w.d();
  assert.deepEqual(locked.pledgeRoots, [idOf(w.deskNote)]);
  assert.deepEqual(locked.noteInputs.map(idOf), [idOf(w.deskNote)]);
  w.configure(config([]));
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
  const h = await w.h(), d = await w.d();
  assert.equal(h.note.amount, String(HELD * 95n / 100n));
  assert.ok(await w.noteOf(h.note.txid, 0));
  assert.ok(await w.noteOf(d.take.txid, 0));
  assert.equal(d.maxMinerFeeSats, 10_000);
  assert.equal(d.take.feeInputs.length, 1);
  assert.ok(!d.lockPair.feeInputs.includes(d.take.feeInputs[0]));
  w.configure(config([idOf(w.deskNote)]));
  assert.equal(await w.desk.available(), 0n, 'a stale inventory scan cannot pledge the consumed note again');
});

test('a signed pair above the miner limit stays out of the journal and off the chain', async () => {
  const w = pledgedWorld();
  w.configure(config([idOf(w.deskNote)], { maxMinerFeeSats: 1 }));
  await w.start();
  await w.run(async () => /miner fee/.test((await w.d())?.lastError || ''));
  assert.equal((await w.d()).lockPair, undefined);
  assert.equal(await w.dBtc.outspend(w.deskNote.txid, w.deskNote.vout), null);
});

test('a silent holder leaves a capped refund and cannot turn it into pledged inventory', async () => {
  const w = pledgedWorld();
  await w.start();
  await w.run(async () => (await w.d())?.phase === 'offered');
  w.holderOnline = false;
  await w.run(async () => (await w.d())?.phase === 'refunded');
  const rec = await w.d();
  assert.ok(await w.noteOf(rec.refund.txid, 0));
  assert.equal(rec.refund.feeInputs.length, 1);
  assert.ok(!rec.lockPair.feeInputs.includes(rec.refund.feeInputs[0]));
  w.deskNotes = [{ ...w.deskNote, txid: rec.refund.txid, vout: 0 }];
  w.trackingOf = { desk: () => 'tracked' };
  assert.equal(await w.desk.available(), 0n);
});

test('wallet accounting after twenty bridges, including a desk that runs out of pledges', async () => {
  const unit = 100_000_000n, amount = 100n * unit, payout = 95n * unit;
  for (const funded of [0, 1, 2]) {
    const notes = Array.from({ length: funded }, (_, i) => ({ txid: key(i + 1), vout: 0, amount: payout }));
    const store = makeMemoryStore();
    const desk = makeBtcSwapDesk({ btc: { wallet: { pub: new Uint8Array(33) } }, now: () => 1,
      policy: { asset: key(20), minAmount: 1n, maxAmount: amount, feeBps: 500, flatFee: 0n }, store, quotes: makeMemoryStore(),
      inventory: { notes: async () => notes }, tracking: async (ns) => new Map(ns.map((n) => [idOf(n), 'tracked'])), pledge: makePledge(config(notes.map(idOf))) });
    let lendable = 1000n * unit, providerStuck = 0n, deskStuck = 0n, filled = 0;
    for (let i = 1; i <= 20; i++) {
      lendable -= amount;
      if (i !== 10 && i !== 20) { lendable += amount; continue; }
      const q = await quote(desk, amount);
      if (!q.id) { providerStuck += amount; continue; }
      const n = notes[filled++];
      await store.put({ id: String(i), phase: 'done', noteInputs: [{ txid: n.txid, vout: n.vout }], lockPair: { txid: key(100 + i) }, pledgeRoots: [idOf(n)] });
      lendable += BigInt(q.out);
      deskStuck += BigInt(q.value);
    }
    assert.equal(filled, funded);
    assert.equal(lendable, 800n * unit + BigInt(funded) * payout);
    assert.equal(providerStuck, BigInt(2 - funded) * amount);
    assert.equal(deskStuck, BigInt(funded) * amount);
    assert.equal(await desk.available(), 0n);
    assert.equal(lendable + providerStuck + deskStuck, 1000n * unit + BigInt(funded) * payout);
  }
});

for (const { name, run } of cases) {
  await run();
  console.log('ok -', name);
}
process.exit(0);
