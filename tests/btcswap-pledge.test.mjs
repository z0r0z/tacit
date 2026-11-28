// The stuck-TAC desk (btcswap-desk/pledges.mjs, dapp/btcswap-desk.js): pledges of tracked TAC that fund swaps the desk
// cannot fund alone, the bounded discount per class of stuck note, floors, and the provider loop. Real transactions, the
// real note validator, a simulated Bitcoin on one virtual clock (tests/lib/btcswap-world.mjs).
//   node tests/btcswap-pledge.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as S from '../dapp/btcswap.js';
import { hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { partyKeys } from './lib/chain-sim.mjs';
import { world, HELD, PLEDGER_NOTE } from './lib/btcswap-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const keyOf = (n) => `${n.txid}:${n.vout}`;
// A 50,000 swap at the pool-exit discount (300bps) and the desk's fee (30bps + 10): out 48,340, return 241, owed 48,581.
const OUT = HELD - (HELD * 30n) / 10000n - 10n - (HELD * 300n) / 10000n;
const OWED = OUT + (OUT * 50n) / 10000n;

test('a pledge funds: the pledger locks tracked TAC to the joint key, and the desk counts it', async () => {
  const w = world();
  const id = await w.pledge();
  const p = await w.pledges.get(id);
  assert.equal(p.phase, 'funded', 'the pledge is funded once its lock confirms');
  assert.equal(p.amount, String(PLEDGER_NOTE));
  assert.ok(BigInt(p.expiryHeight) > BigInt(p.fundedAt), 'the refund opens after the pledge wait');
  const info = await w.pledges.info();
  assert.equal(info.pledged, String(PLEDGER_NOTE), 'the desk publishes what pledgers put up');
  assert.equal(info.available, String(PLEDGER_NOTE));
  assert.equal(info.borrowed, '0');
  // the desk never holds the pledger's TAC under its own key: the lock pays the joint key, not the desk's wallet
  const deskScript = Buffer.from(w.dW.prims.p2wpkhScript(w.dW.wallet.pub)).toString('hex');
  assert.notEqual(p.joint.spk, deskScript, 'the pledge lock is not the desk\'s own address');
});

test('a pledge whose lock is not the offer is refused: the desk checks the lock on the chain', async () => {
  const w = world();
  const o = await w.desk.handle({ method: 'POST', path: '/pledge', body: { pledgerPub: Buffer.from(w.pW.prims.wallet.pub).toString('hex'), pledgerXonly: Buffer.from(w.pW.prims.wallet.pub.slice(1)).toString('hex'), amount: String(PLEDGER_NOTE), maxDiscountBps: 500 } });
  const bad = await w.pledges.fund({ id: o.body.pledgeId, lock: { txid: '00'.repeat(32), vout: 0 } });
  assert.equal(bad.ok, false, 'a lock that is not on the chain funds nothing');
  const p = await w.pledges.get(o.body.pledgeId);
  assert.equal(p.phase, 'offered', 'the pledge stays offered');
});

test('the provider loop: a stuck note swaps at the desk for tracked TAC, which bridges home', async () => {
  const w = world();
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  w.deskNotes = []; // the desk holds no tracked TAC of its own: the pledge funds this swap
  const id = await w.pledge();
  await w.start(HELD, w.holderNote);
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
  const h = await w.h(), d = await w.d();
  assert.equal(h.deskOffer.lock.amount, String(OUT), 'the holder is paid the amount less the fee and the pool-exit discount');
  assert.equal(d.class, 'pool-exit', 'the swap records the note\'s class');
  assert.equal(d.discountBps, 300, 'the discount is stated on the record');
  const mine = await w.noteOf(h.claim.txid, 0);
  assert.ok(mine, 'the holder\'s claimed note is valid');
  // the claim is a one-signature key-path spend of the desk's lock: a key-path claim keeps the note tracked, so it
  // bridges in one burn (a script-path claim would not)
  assert.equal(w.reveals.get(h.claim.txid).inputs[1].witness.length, 1);
  assert.ok(await w.noteOf(d.take.txid, 0), 'the desk took the holder\'s stuck note');
  const p = await w.pledges.get(id);
  assert.equal(p.drawn, String(OUT), 'the desk drew exactly what the swap needed');
  assert.equal(p.owed, String(OWED), 'the desk owes the drawn amount plus the stated return');
  // the draw spent the whole lock note and returned the rest as change, so the pledge still holds 51,660 and its lock
  // has moved to the change note: a second draw spends that, not the note already spent
  assert.equal(p.phase, 'funded');
  assert.equal(p.lock.amount, String(100000n - OUT), 'the change is what is left of the pledge');
  assert.ok(await w.noteOf(p.lock.txid, p.lock.vout), 'the change note is valid');
  // a second draw, driven straight at the pledges module: it spends the change note and leaves 21,660
  const swap2 = '22'.repeat(32);
  await w.deskStore.put({ id: swap2, phase: 'accepted', discountBps: 300 });
  const alloc2 = await w.pledges.allocate({ swapId: swap2, want: 30000n, discountBps: 300 });
  assert.ok(alloc2, 'the change funds a second draw');
  const built2 = await w.pledges.buildDraw({ pledge: alloc2[0].pledge, swapId: swap2, amount: alloc2[0].take, index: alloc2[0].index });
  const signed2 = await w.pledges.signDraw({ pledge: alloc2[0].pledge, swapId: swap2, amount: alloc2[0].take, discountBps: 300, built: built2 });
  assert.ok(signed2, 'the pledger signs the second draw');
  await w.dBtc.broadcast({ ...signed2, revealTxid: built2.pair.revealTxid });
  w.btc.mine(1);
  await w.pledges.confirmDraw({ pledge: await w.pledges.get(id), draw: { swapId: swap2, index: alloc2[0].index, txid: built2.pair.revealTxid, amount: String(alloc2[0].take), rLock: built2.rLock, changeRLock: built2.changeRLock, changeAmount: built2.changeAmount, value: built2.value }, height: w.btc.tip });
  const p2 = await w.pledges.get(id);
  assert.equal(p2.drawn, String(OUT + 30000n), 'both draws are counted');
  assert.equal(p2.lock.amount, String(100000n - OUT - 30000n), 'the second change is what is left');
  assert.ok(await w.noteOf(built2.pair.revealTxid, 0), 'the second drawn note is valid');
  assert.ok(await w.noteOf(p2.lock.txid, p2.lock.vout), 'the second change note is valid');
});

test('a drawn pledge is repaid once the desk is topped up, from what the desk owns', async () => {
  const w = world();
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  w.deskNotes = [];
  const id = await w.pledge();
  await w.start(HELD, w.holderNote);
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
  let p = await w.pledges.get(id);
  assert.equal(p.owed, String(OWED), 'the desk owes the pledger, and holds nothing owned to repay with');
  // the operator moves a tracked note into the desk: the next tick repays the pledge from it
  w.deskNotes.push(w.reserveNote);
  await w.run(async () => (await w.pledges.get(id)).phase === 'repaid');
  p = await w.pledges.get(id);
  assert.equal(p.owed, '0');
  assert.equal(p.repaid, String(OWED), 'the pledger is repaid the drawn amount plus the return');
  // the repayment is a real transfer to the pledger's address, on the ECDH channel
  const paid = [...w.reveals.values()].find((tx) => tx.outputs.some((o) => Buffer.from(o.script).toString('hex') === Buffer.from(w.pW.prims.p2wpkhScript(w.pW.wallet.pub)).toString('hex')));
  assert.ok(paid, 'a transfer to the pledger is on the chain');
});

test('a pledge whose refund has opened is given back, not drawn on', async () => {
  const w = world();
  const id = await w.pledge();
  const p0 = await w.pledges.get(id);
  w.btc.mine(Number(BigInt(p0.expiryHeight) - BigInt(w.btc.tip)) + 1);
  await w.desk.tick();
  const p = await w.pledges.get(id);
  assert.equal(p.phase, 'expired', 'the pledge is marked expired once its refund opens');
  assert.equal(await w.pledges.available(), 0n, 'an expired pledge funds nothing');
  // the swap runs on the desk's own TAC: the expired pledge is never drawn on
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  await w.start(HELD, w.holderNote);
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
  assert.equal((await w.pledges.get(id)).drawn, '0', 'nothing was drawn from the expired pledge');
});

test('expiry mid-swap: a pledge that runs out before its draw is built is given back and the swap is funded from the rest', async () => {
  const w = world({ pledge: { csvPledge: 20 } });
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  w.deskNotes = [];
  const a = await w.pledge(PLEDGER_NOTE, 500, w.pledgerNote);
  w.btc.mine(8); // the second pledge is funded later, so it runs out later
  const b = await w.pledge(PLEDGER_NOTE, 500, w.pledgerNote2);
  w.deskOnline = false; // drive the desk by hand, so the tip can move between the allocation and the build
  await w.start(HELD, w.holderNote);
  await w.run(async () => (await w.h())?.phase === 'offered');
  await w.desk.step(await w.d());
  let d = await w.d();
  assert.equal(d.draws[0].pledgeId, a, 'the first pledge funds the swap');
  // move the tip until the first pledge's refund opens, but the second's has not
  const aRec = await w.pledges.get(a);
  w.btc.mine(Math.max(1, Number(BigInt(aRec.expiryHeight) - BigInt(w.btc.tip) - 6n)));
  await w.desk.step(await w.d());
  d = await w.d();
  assert.equal(d.draws[0].pledgeId, b, 'the swap is funded from the second pledge instead');
  assert.equal(d.draws[0].phase, 'requested');
  w.deskOnline = true;
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
  assert.equal((await w.pledges.get(a)).drawn, '0', 'nothing was drawn from the pledge that ran out');
  assert.equal((await w.pledges.get(b)).drawn, String(OUT), 'the second pledge funded the swap');
});

test('discount-cap refusal: a pool-exit note at a discount over the cap is refused, a long-history note is not', async () => {
  const w = world({ desk: { discountMaxBps: 200 } });
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  const q = await w.desk.handle({ method: 'POST', path: '/quote', body: { amount: String(HELD), note: { txid: w.holderNote.txid, vout: w.holderNote.vout } } });
  assert.equal(q.body.ok, false, 'the desk refuses a discount over its cap');
  assert.match(q.body.why, /over this desk's cap/);
  w.traceClass[keyOf(w.holderNote)] = 'long-history';
  const q2 = await w.desk.handle({ method: 'POST', path: '/quote', body: { amount: String(HELD), note: { txid: w.holderNote.txid, vout: w.holderNote.vout } } });
  assert.equal(q2.body.ok, undefined, 'a quote that clears the cap is the quote itself, not an ok wrapper');
  assert.equal(q2.body.discountBps, 150);
  assert.equal(q2.body.class, 'long-history');
  assert.equal(q2.body.discount, String((HELD * 150n) / 10000n), 'the quote states the discount in plain numbers');
});

test('a quote taken without the note assumes clean, and a stuck note does not fit it', async () => {
  const w = world();
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  const q = await w.desk.handle({ method: 'POST', path: '/quote', body: { amount: String(HELD) } });
  assert.equal(q.body.ok, undefined, 'a quote without a note is the quote itself, not an ok wrapper');
  assert.equal(q.body.discountBps, 0);
  await w.holder.start({ asset: hexToBytes(w.asset), amount: HELD, notes: [w.holderNote], quote: q.body });
  await w.run(async () => (await w.h())?.phase === 'refund-wait' || (await w.h())?.phase === 'refunded');
  const h = await w.h();
  assert.match(h.why, /does not fit/, 'the desk refuses the offer and tells the holder to re-quote with the note');
});

test('floor matching: a holder\'s standing sell offer is matched when the discount covers it', async () => {
  const w = world();
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  const note = { txid: w.holderNote.txid, vout: w.holderNote.vout };
  const f = await w.desk.handle({ method: 'POST', path: '/floor', body: { holderPub: Buffer.from(w.hW.prims.wallet.pub).toString('hex'), amount: String(HELD), maxDiscountBps: 300, note } });
  assert.ok(f.body.floorId, 'the floor stands');
  const q = await w.desk.handle({ method: 'POST', path: '/quote', body: { amount: String(HELD), note } });
  assert.equal(q.body.floor, f.body.floorId, 'a pool-exit discount of 300bps meets a 300bps floor');
  const f2 = await w.desk.handle({ method: 'POST', path: '/floor', body: { holderPub: Buffer.from(w.hW.prims.wallet.pub).toString('hex'), amount: String(HELD), maxDiscountBps: 150, note: { txid: '11'.repeat(32), vout: 0 } } });
  const q2 = await w.desk.handle({ method: 'POST', path: '/quote', body: { amount: String(HELD), note } });
  assert.equal(q2.body.floor, f.body.floorId, 'a 150bps floor on another note does not match this one');
  assert.ok(f2.body.floorId);
});

test('a pledger who will not sign is not spent: the desk funds the swap elsewhere', async () => {
  const w = world();
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  w.deskNotes = [];
  const a = await w.pledge(PLEDGER_NOTE, 500, w.pledgerNote);
  const b = await w.pledge(PLEDGER_NOTE, 500, w.pledgerNote2);
  w.refuseSign.add(a); // the first pledger's signer refuses every draw
  await w.start(HELD, w.holderNote);
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
  assert.equal((await w.pledges.get(a)).drawn, '0', 'nothing was drawn from the pledge that would not sign');
  assert.equal((await w.pledges.get(b)).drawn, String(OUT), 'the second pledge funded the swap');
});

test('the holder abandons after the desk locks: the desk refunds its lock, and the pledges are repaid', async () => {
  const w = world({ desk: { csvDesk: 12, acceptWaitSecs: 3600 } });
  w.traceClass[keyOf(w.holderNote)] = 'pool-exit';
  w.deskNotes = [];
  const id = await w.pledge();
  await w.start(HELD, w.holderNote);
  await w.run(async () => (await w.d())?.phase === 'offered');
  w.holderOnline = false; // the holder never claims
  await w.run(async () => (await w.d())?.phase === 'refunded');
  const d = await w.d();
  assert.ok(d.refund, 'the desk took its lock back once the timelock ran');
  w.deskNotes.push(w.reserveNote);
  await w.run(async () => (await w.pledges.get(id)).phase === 'repaid');
  const p = await w.pledges.get(id);
  assert.equal(p.repaid, String(OWED), 'the pledges are repaid from the desk once the swap has ended');
});

test('the desk publishes pledged, borrowed, owed and available separately', async () => {
  const w = world();
  await w.pledge();
  const info = await w.desk.handle({ method: 'GET', path: '/info' });
  assert.equal(info.body.pledges.pledged, String(PLEDGER_NOTE));
  assert.equal(info.body.pledges.available, String(PLEDGER_NOTE));
  assert.equal(info.body.pledges.borrowed, '0');
  assert.equal(info.body.pledges.owed, '0');
  assert.deepEqual(info.body.discountBps, { clean: 0, 'long-history': 150, 'pool-exit': 300 });
  assert.equal(info.body.discountMaxBps, 500);
  assert.ok(BigInt(info.body.available) >= BigInt(PLEDGER_NOTE), 'the desk\'s available counts what pledgers put up');
});

let failed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log(`not ok - ${name}: ${e.message}\n  ${String(e.stack || '').split('\n').slice(1, 4).join('\n  ')}`); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
