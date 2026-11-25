// The desk's HTTP face and its safety state machine (dapp/btcswap-desk.js), through its own handler and the simulated
// chains: quote and fee math, what an offer must prove, and what aborts a swap. The claim's signing sessions and the
// full swap to 'done' are covered by the same file's later tests; the whole swap itself is tests/btcswap-sim.test.mjs.
//   node tests/btcswap-desk.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import * as S from '../dapp/btcswap.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { partyKeys } from './lib/chain-sim.mjs';
import { world } from './lib/btcswap-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const quote = (w, amount) => w.desk.handle({ method: 'POST', path: '/quote', body: { amount: String(amount) } });
const offerOf = (w, rec) => {
  const sec = X.deriveSwapSecrets({ seed: partyKeys('holder').seed, swapId: hexToBytes(rec.id) });
  return S.makeHolderOffer({ swapId: hexToBytes(rec.id), asset: rec.asset, value: BigInt(rec.amount), rLock: sec.rLock, txid: rec.lock.txid, vout: rec.lock.vout, csvBlocks: rec.csvBlocks, holderPub: w.hW.wallet.pub, T: sec.T, deskPub: rec.deskPub, out: BigInt(rec.out) });
};
const postOffer = (w, q, offer) => w.desk.handle({ method: 'POST', path: '/offer', body: { quoteId: q.id, offer } });

// a quote and the holder's lock for it, built but not broadcast; `quoteOver` overrides fields of the quote the holder sees
async function built(w, amount = 1000, quoteOver = {}) {
  const r = await quote(w, amount);
  assert.ok(r.body.id, 'a quote for ' + amount + ': ' + JSON.stringify(r.body));
  const q = { ...r.body, ...quoteOver };
  const rec = await w.holder.start({ asset: hexToBytes(q.asset), amount, notes: [w.holderNote], quote: q });
  return { q, rec };
}
// the lock broadcast and mined `mineN` blocks (the holder's note is spent once, so one locked swap per world)
async function locked(w, amount = 1000, quoteOver = {}, mineN = 1) {
  const { q, rec } = await built(w, amount, quoteOver);
  await w.holder.step(rec);
  if (mineN) w.btc.mine(mineN);
  return { q, rec, offer: offerOf(w, rec) };
}

test('quote: the fee is 30 bps plus the flat 10, rounding down, and the quote carries its terms', async () => {
  const w = world();
  for (const [amount, out] of [[1000, '987'], [1001, '988'], [3333, '3314'], [1003, '990']]) {
    const r = await quote(w, amount);
    assert.equal(r.status, 200);
    assert.equal(r.body.out, out, `quote ${amount}`);
    assert.equal(r.body.value, String(amount));
    assert.equal(r.body.deskPub, bytesToHex(w.dW.wallet.pub));
    assert.equal(r.body.csvHolder, 288);
    assert.equal(r.body.validUntil, w.clock.now() + 600);
    assert.match(r.body.id, /^[0-9a-f]{32}$/);
  }
  const belowMin = await quote(w, 999);
  assert.equal(belowMin.body.ok, false);
  assert.equal(belowMin.body.why, 'amount outside this desk\'s limits');
});

test('quote: the example config\'s minimum is below the fee\'s own break-even', async () => {
  // the shipped example config: min 100,000,000, fee 30 bps + flat 100,000,000. A quote at that minimum can never
  // pay its fee, so the desk must refuse it; the first amount that clears the fee is 100,300,903.
  const w = world({ desk: { minAmount: 100000000n, maxAmount: 100000000000n, feeBps: 30, flatFee: 100000000n } });
  w.deskNotes.push({ txid: 'dd'.repeat(32), vout: 0, value: 546, amount: 200_000_000_000n, blinding: 3n, height: 1 });
  w.follows.add(`${'dd'.repeat(32)}:0`);
  const min = await quote(w, 100000000);
  assert.equal(min.body.why, 'the amount does not cover the fee');
  const below = await quote(w, 100300902);
  assert.equal(below.body.why, 'the amount does not cover the fee');
  const edge = await quote(w, 100300903);
  assert.ok(edge.body.id, 'the break-even quote is issued: ' + JSON.stringify(edge.body));
  assert.equal(edge.body.out, '1');
});

test('quote: outside the limits, and more than the desk holds, are refused', async () => {
  const w = world();
  for (const amount of [0, 999, 10000001]) {
    const r = await quote(w, amount);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.why, 'amount outside this desk\'s limits', `quote ${amount}`);
  }
  const big = await quote(w, 10000000);
  assert.equal(big.body.ok, false);
  assert.equal(big.body.why, 'this desk does not hold that much just now');
});

test('info: the desk publishes its key, limits, fee and tracked TAC; malformed requests are 400s and unknown paths 404', async () => {
  const w = world();
  const info = await w.desk.handle({ method: 'GET', path: '/info' });
  assert.equal(info.status, 200);
  assert.equal(info.body.deskPub, bytesToHex(w.dW.wallet.pub));
  assert.equal(info.body.asset, w.asset.replace(/^0x/, ''));
  assert.equal(info.body.minAmount, '1000');
  assert.equal(info.body.maxAmount, '10000000');
  assert.equal(info.body.feeBps, 30);
  assert.equal(info.body.flatFee, '10');
  assert.equal(info.body.csvHolder, 288);
  assert.equal(info.body.csvDesk, 144);
  assert.equal(info.body.available, '950000');
  for (const bad of ['abc', '1.5', '', '-5']) {
    const r = await quote(w, bad);
    assert.equal(r.status, 400, `quote ${JSON.stringify(bad)}`);
    assert.equal(r.body.error, 'amount must be a whole number');
  }
  const nope = await w.desk.handle({ method: 'GET', path: '/nope' });
  assert.equal(nope.status, 404);
  assert.equal(nope.body.error, 'not found');
  const offer = await w.desk.handle({ method: 'POST', path: '/offer', body: {} });
  assert.equal(offer.status, 400);
  assert.equal(offer.body.error, 'quoteId and offer are required');
  const unknown = await w.desk.handle({ method: 'GET', path: `/swap/${'00'.repeat(36)}` });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'unknown swap');
});

test('offer: the valid offer is accepted, and a second post answers with the stored record', async () => {
  const w = world();
  const { q, rec, offer } = await locked(w);
  const first = await postOffer(w, q, offer);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, phase: 'accepted' });
  const stored = await w.deskStore.get(rec.id);
  assert.equal(stored.phase, 'accepted');
  assert.equal(stored.quoteId, q.id);
  const second = await postOffer(w, q, offer);
  assert.deepEqual(second.body, { ok: true, phase: 'accepted' });
});

test('offer: an unknown or expired quote is refused before the chain is read', async () => {
  const w = world();
  const { q, offer } = await locked(w);
  const unknown = await postOffer(w, { id: 'nope' }, offer);
  assert.equal(unknown.body.ok, false);
  assert.equal(unknown.body.why, 'unknown quote');
  const w2 = world();
  const b = await built(w2);
  w2.clock.advance(601);
  const expired = await postOffer(w2, b.q, offerOf(w2, b.rec));
  assert.equal(expired.body.ok, false);
  assert.equal(expired.body.why, 'quote expired');
});

test('offer: a malformed swap id is refused', async () => {
  const w = world();
  const { q, offer } = await locked(w);
  const bad = await postOffer(w, q, { ...offer, swapId: 'zz' });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.why, 'malformed offer: the swap id');
});

test('offer: a lock that is not on the chain is refused, and the desk says to retry', async () => {
  const w = world();
  const { q, rec } = await built(w);
  const r = await postOffer(w, q, offerOf(w, rec));
  assert.equal(r.body.ok, false);
  assert.equal(r.body.retry, true);
  assert.equal(r.body.why, 'the lock transaction is not on the chain');
});

test('offer: an opening, amount, script or swap id that does not match the lock or the quote is refused', async () => {
  { // the blinding: only the opening fails
    const w = world();
    const { q, offer } = await locked(w);
    const bad = structuredClone(offer);
    bad.lock.rLock = bad.lock.rLock.slice(0, -1) + (bad.lock.rLock.slice(-1) === '0' ? '1' : '0');
    const r = await postOffer(w, q, bad);
    assert.equal(r.body.why, 'the opening does not match the note');
  }
  { // the amount out: only the amounts fail
    const w = world();
    const { q, offer } = await locked(w);
    const bad = structuredClone(offer);
    bad.out = String(BigInt(bad.out) + 1n);
    const r = await postOffer(w, q, bad);
    assert.equal(r.body.why, 'the amounts differ from the quote');
  }
  { // a timelock above the floor: only the script fails
    const w = world();
    const { q, offer } = await locked(w);
    const bad = structuredClone(offer);
    bad.lock.csvBlocks = 300;
    const r = await postOffer(w, q, bad);
    assert.equal(r.body.why, 'the output does not pay the lock these terms make');
  }
  { // a swap id that is not the lock's spent outpoint
    const w = world();
    const { q, offer } = await locked(w);
    const bad = structuredClone(offer);
    bad.swapId = '00'.repeat(36);
    const r = await postOffer(w, q, bad);
    assert.equal(r.body.why, 'the swap id is not the outpoint the lock transaction spends');
  }
});

test('offer: a lock whose refund opens under the desk\'s floor is refused', async () => {
  // the holder locks with its own 288 blocks, so an offer naming 100 names a timelock the lock does not have:
  // the desk refuses it for the floor and for the script, and names both.
  const w = world();
  const { q, rec, offer } = await locked(w, 1000, {}, 0);
  const bad = structuredClone(offer);
  bad.lock.csvBlocks = 100;
  const r = await postOffer(w, q, bad);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.why, 'refund timelock under 288 blocks; the output does not pay the lock these terms make');
});

test('offer: a lock keyed to another desk is refused', async () => {
  // the holder locks to the desk key its quote names; a quote naming another key makes a lock for that desk.
  const w = world();
  const { q, rec } = await locked(w, 1000, { deskPub: bytesToHex(w.hW.wallet.pub) }, 1);
  const r = await postOffer(w, q, offerOf(w, rec));
  assert.equal(r.body.ok, false);
  assert.equal(r.body.why, 'the lock is not keyed to this desk');
});

test('offer: a lock confirmed so long ago that its refund opens too soon is refused', async () => {
  // 200 blocks pass without the clock moving, so the quote is still live but the lock is old.
  const w = world();
  const { q, rec } = await built(w);
  await w.holder.step(rec);
  w.btc.mine(200, { advance: false });
  const r = await postOffer(w, q, offerOf(w, rec));
  assert.equal(r.body.ok, false);
  assert.equal(r.body.why, 'the lock\'s refund opens too soon for the desk to lock against it');
});

test('offer: a spent lock, and a note already consumed on Ethereum, are refused', async () => {
  {
    const w = world();
    const { q, rec, offer } = await locked(w);
    w.btc.spends.set(`${rec.lock.txid}:0`, 'ff'.repeat(32));
    const r = await postOffer(w, q, offer);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.why, 'the lock is spent');
  }
  {
    const w = world();
    const { q, rec, offer } = await locked(w);
    w.btc.consumed.add(`${w.holderNote.txid}:${w.holderNote.vout}`);
    const r = await postOffer(w, q, offer);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.why, 'a spent note is already consumed on Ethereum: ' + `${w.holderNote.txid}:${w.holderNote.vout}`);
  }
});

test('desk: an accepted swap aborts when the holder\'s lock never confirms', async () => {
  const w = world({ desk: { acceptWaitSecs: 60 } });
  const { q, rec } = await built(w);
  await w.holder.step(rec); // broadcasts, 0 confirmations
  const r = await postOffer(w, q, offerOf(w, rec));
  assert.equal(r.body.ok, true);
  w.clock.advance(61);
  await w.desk.tick();
  const d = await w.deskStore.get(rec.id);
  assert.equal(d.phase, 'aborted');
  assert.equal(d.why, 'the holder\'s lock did not confirm');
});

test('desk: an accepted swap aborts when the holder\'s lock is spent', async () => {
  const w = world();
  const { q, rec, offer } = await locked(w);
  const r = await postOffer(w, q, offer);
  assert.equal(r.body.ok, true);
  w.btc.spends.set(`${rec.lock.txid}:0`, 'ff'.repeat(32));
  await w.desk.tick();
  const d = await w.deskStore.get(rec.id);
  assert.equal(d.phase, 'aborted');
  assert.equal(d.why, 'the holder\'s lock was spent');
});

test('desk: an accepted swap aborts when the holder\'s refund opens too soon to lock against', async () => {
  const w = world();
  const { q, rec, offer } = await locked(w);
  const r = await postOffer(w, q, offer);
  assert.equal(r.body.ok, true);
  w.btc.mine(200, { advance: false });
  await w.desk.tick();
  const d = await w.deskStore.get(rec.id);
  assert.equal(d.phase, 'aborted');
  assert.equal(d.why, 'the holder\'s refund opens too soon to lock against');
});

let failed = 0;
for (const [name, fn] of tests.filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY))) {
  const t0 = Date.now();
  try { await fn(); console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.stack || e).split('\n').slice(0, 6).join('\n  ')}`); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
