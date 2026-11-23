// The leader's block timing (tacit-leader/fees.mjs blockReady): at once while gas is cheap, a short wait for company when it is not.
import assert from 'node:assert/strict';
import { blockReady, landCover } from '../tacit-leader/fees.mjs';

const gwei = (g) => BigInt(Math.round(g * 1e9));
const at = (o) => blockReady({ now: 100_000, firstSeen: 100_000, minSpends: 1, maxWaitMs: 20e3, batchGwei: 0.5, target: 4, waitMs: 90e3, ...o });

assert.equal(at({ waiting: 0, baseFee: gwei(0.05) }), false, 'nothing waiting: no block');
assert.equal(at({ waiting: 1, baseFee: gwei(0.05) }), true, 'cheap gas: one payment lands at once');
assert.equal(at({ waiting: 1, baseFee: gwei(0.5) }), true, 'at the threshold: at once');
assert.equal(at({ waiting: 1, baseFee: gwei(3) }), false, 'dear gas: one payment waits for company');
assert.equal(at({ waiting: 3, baseFee: gwei(3) }), false, '... three still wait');
assert.equal(at({ waiting: 4, baseFee: gwei(3) }), true, '... four go');
assert.equal(at({ waiting: 1, baseFee: gwei(3), firstSeen: 100_000 - 90_000 }), true, '... and one goes once it waited the longest wait');
assert.equal(at({ waiting: 0, forced: 1, baseFee: gwei(30) }), true, 'a forced entry goes at once whatever the gas');
assert.equal(at({ waiting: 1, baseFee: gwei(0.05), minSpends: 3 }), false, 'the leader\'s own floor still holds');
assert.equal(at({ waiting: 1, baseFee: gwei(0.05), minSpends: 3, firstSeen: 100_000 - 20_000 }), true, '... until its own wait');
// a block is proved only when its landing can be paid for
const ether = (e) => BigInt(Math.round(e * 1e18));
assert.equal(landCover({ have: ether(0.001), base: gwei(0.1), tip: gwei(0.1) }), null, 'enough for a landing');
const short = landCover({ have: 36_214_599_838_752n, base: gwei(0.1), tip: gwei(0.1) });
assert.ok(short && short.need === 500_000n * (2n * gwei(0.1) + gwei(0.1)) && short.have === 36_214_599_838_752n, 'the wallet that ran short: what it has and what it needs');
assert.equal(landCover({ have: ether(0.0001), base: gwei(0.1), tip: gwei(0.1) }) !== null, true, '0.0001 ETH is not a landing at this price');
assert.equal(landCover({ have: 0, base: 0n, tip: 0n }), null, 'a free landing needs nothing');
console.log('tacit-leader-batch: ok');

// A spend whose deposit is already on Ethereum is not refused for a fee that moved a little (fees.mjs desk.check / admitPaying). 2026-11-17: a
// deploy restarted the leader just after it swept a pool move's inbox (360 TAC out of the private pool); the restarted fee desk knew only its one
// fresh quote, 0.76% over the spend's fee, refused the spend for good, and the TAC sat in the contract with nothing to land it.
{
  const { makeFeeDesk, feeTerms, fundedFloor, admitPaying } = await import('../tacit-leader/fees.mjs');
  const terms = feeTerms({});
  const mk = () => makeFeeDesk({ seed: '0x' + '07'.repeat(32), chain: '0x' + '11'.repeat(32), asset: 12345n, terms });
  const now = 1_000_000, price = [1_000_000n, 10n ** 18n];
  const desk = mk();
  const quote = BigInt(desk.quote({ now, baseFee: gwei(0.2), price }).fee);
  const paidOld = quote * 9924n / 10_000n;                 // what a spend made under the quote before the fee rose 0.76% paid
  assert.equal(desk.judge(quote, now).ok, true, 'a spend that pays the quote pays');
  assert.equal(desk.judge(paidOld, now).ok, false, 'one 0.76% under is refused as the rule always was');
  assert.equal(desk.judge(paidOld, now, { funded: true }).ok, true, 'but not when its deposit is already on Ethereum');
  assert.equal(fundedFloor(quote, terms), (quote * 10_000n + 10_000n + terms.marginBps - 1n) / (10_000n + terms.marginBps), 'the floor is the quote less its margin');
  assert.ok(desk.judge(quote * 7n / 10n, now, { funded: true }).ok === false, 'a spend far under the cost is still refused');
  assert.ok(desk.judge(0n, now, { funded: true }).ok === false, 'one that pays nothing is refused');
  assert.equal(mk().judge(10n ** 18n, now, { funded: true }).ok, false, 'a desk with no quote yet accepts nothing');

  // admitPaying: the funded question is asked of a spend with a deposit only, and a read that fails answers no
  const spends = [{ id: 'a', memos: [1], deposit: '0x01' }, { id: 'b', memos: [1], deposit: '0x02' }, { id: 'c', memos: [1] }, { id: 'd', memos: [1], deposit: '0x04' }];
  const asked = [], judged = [], dropped = [];
  const stub = { check: (s, _rate, _now, o) => { judged.push([s.id, o.funded]); return { ok: o.funded, paid: 1n, need: 2n }; } };
  const node = async (m, path, body) => (path === '/pending' ? { spends } : path === '/state' ? { pool: '1', shares: '1' } : (dropped.push(...body.ids), {}));
  const funded = async (s) => { asked.push(s.id); if (s.id === 'd') throw new Error('rpc down'); return s.id === 'a'; };
  const out = await admitPaying({ desk: stub, node, paying: new Set(), ids: ['a', 'b', 'c', 'd'], funded, now });
  assert.deepEqual(asked, ['a', 'b', 'd'], 'asked of spends with a deposit, not of a payment');
  assert.deepEqual(judged, [['a', true], ['b', false], ['c', false], ['d', false]], 'a funded spend is judged funded; a failed read is not');
  assert.deepEqual(out, ['b', 'c', 'd'], 'the rest are refused as before');
  assert.deepEqual(dropped, ['b', 'c', 'd']);
  console.log('tacit-leader-batch: funded spends ok');
}
