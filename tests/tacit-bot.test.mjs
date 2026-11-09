// The chain bot's decisions with no network: settings, the wait, keys, the day's budget, the health guard, which action comes next, and
// the failure count that stops it.   node tests/tacit-bot.test.mjs
import assert from 'node:assert';
import { settings, nextWait, randomUnits, identities, ethAddress, makeBudget, health, decide, makeFailures, tac, fmt, T, UNIT } from '../tacit-bot/lib.mjs';
import { signPermit } from '../tacit-bot/bot.mjs';
import { secp, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';

const s = settings({});
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

// amounts
assert.equal(tac('1.5'), 150_000_000n); assert.equal(fmt(150_000_000n), '1.5'); assert.equal(fmt(tac('0.00000001')), '0.00000001');
assert.throws(() => tac('1e3'));
// the wait: within the bounds, both ends reachable
assert.equal(nextWait(s, () => 0), 20 * 60e3); assert.equal(nextWait(s, () => 1), 40 * 60e3);
for (let i = 0; i < 200; i++) { const w = nextWait(s); assert.ok(w >= 20 * 60e3 && w <= 40 * 60e3); }
assert.throws(() => settings({ BOT_MIN_WAIT_MIN: '30', BOT_MAX_WAIT_MIN: '10' }));
for (let i = 0; i < 200; i++) { const u = randomUnits(tac('0.5'), tac('15')); assert.ok(u >= tac('0.5') && u <= tac('15') && u % (T / 100n) === 0n); }

// keys: deterministic, distinct, the account A's own
const seed = 'ab'.repeat(32), ids = identities(seed);
assert.deepEqual(identities(seed).a, ids.a);
assert.notDeepEqual(ids.a, ids.b);
assert.equal(ids.eoa.address, ethAddress(ids.a));
assert.equal(ethAddress(Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex')), '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'anvil account 0');
assert.throws(() => identities('ab'));

// a permit recovers to its signer
{
  const priv = ids.eoa.priv, dom = '11'.repeat(32), sig = await signPermit({ priv, domainSeparator: dom, owner: ids.eoa.address, spender: '0x' + '22'.repeat(20), value: 5n, nonce: 0n, deadline: 9n });
  assert.ok(sig.v === 27 || sig.v === 28);
  assert.ok(/^0x[0-9a-f]{64}$/.test(sig.r) && /^0x[0-9a-f]{64}$/.test(sig.s));
}

// the budget: per UTC day
{
  let t = Date.parse('2026-11-09T23:00:00Z');
  const b = makeBudget(tac('1'), () => t);
  assert.ok(b.fits(tac('1'))); b.add(tac('0.8')); assert.ok(!b.fits(tac('0.3'))); assert.equal(b.left(), tac('0.2'));
  const j = JSON.parse(JSON.stringify(b)); const b2 = makeBudget(tac('1'), () => t); b2.restore(j); assert.equal(b2.spent(), tac('0.8'), 'kept across a restart');
  t += 2 * 3600e3; assert.ok(b.fits(tac('1')), 'a new day'); assert.equal(b.spent(), 0n);
}

// health
{
  const now = 1_800_000_000_000, st = { height: 10, lastLanded: now / 1000 - 60, leader: { fee: tac('0.25') } };
  assert.ok(health(s, { status: st, leaderState: { height: 10 }, now }).ok);
  assert.ok(!health(s, { status: null, leaderState: { height: 10 }, now }).ok);
  assert.ok(!health(s, { status: { ...st, leader: null }, leaderState: null, now }).ok);
  assert.match(health(s, { status: st, leaderState: { height: 9 }, now }).why, /behind/);
  assert.match(health(s, { status: { ...st, lastLanded: now / 1000 - 3 * 3600 }, leaderState: { height: 10 }, mempool: 2, now }).why, /no block landed/);
  assert.ok(health(s, { status: { ...st, lastLanded: now / 1000 - 3 * 3600 }, leaderState: { height: 10 }, mempool: 0, now }).ok, 'a quiet chain with nothing waiting is fine');
  assert.match(health(s, { status: { ...st, leader: { fee: tac('2') } }, leaderState: { height: 10 }, now }).why, /fee/);
}

// decide
const side = (worth, o = {}) => ({ worth: tac(worth), most: tac(o.most ?? worth), outMost: tac(o.out ?? o.most ?? worth), settling: !!o.settling, holders: 200_000n });
const view = (a, b, eoa, o = {}) => ({ a, b, eoa: tac(eoa), fee: tac('0.25'), shieldCap: o.cap === undefined ? tac('1000') : o.cap, sweepFee: o.sweep ?? 454_358_580_000_000_000n });
{
  // empty chain, funded account: a shield of the set size
  let d = decide(s, view(side('0'), side('0'), '500'), () => 0.9);
  assert.equal(d.kind, 'shield'); assert.equal(d.units, tac('150'));
  // never over the leader's cap, the in-play cap, nor what the account holds less the sweep fee
  assert.equal(decide({ ...s, shieldSize: tac('5000'), maxInPlay: tac('9000') }, view(side('0'), side('0'), '6000'), () => 0.9).units, tac('1000'));
  assert.equal(decide({ ...s, shieldSize: tac('5000') }, view(side('10'), side('10'), '6000'), () => 0.9).units, tac('280'));
  assert.equal(decide(s, view(side('0'), side('0'), '50'), () => 0.9).units, tac('49.54'));
  // the sweep fee over its limit: no shield
  d = decide(s, view(side('0'), side('0'), '500', { sweep: tac('3') * UNIT }), () => 0.9);
  assert.equal(d.kind, 'idle');
  // nothing anywhere
  assert.equal(decide(s, view(side('0'), side('0'), '0'), () => 0.9).kind, 'idle');
  // enough on the chain: a payment, mostly from the richer, never over what it can pay nor payMax
  for (let i = 0; i < 300; i++) {
    const x = decide({ ...s, withdrawProb: 0, reshieldProb: 0 }, view(side('100', { most: '8' }), side('20'), '0'));
    assert.ok(x.kind === 'pay' || x.kind === 'merge', x.kind);
    if (x.kind === 'pay') assert.ok(x.units >= s.payMin && x.units <= (x.from === 'a' ? tac('8') : tac('15')));
  }
  assert.equal(decide(s, view(side('100'), side('20'), '0'), seq(0.5, 0.5, 0.1)).from, 'a');
  // a settling payer waits; a payer that cannot pay but holds enough merges
  assert.equal(decide({ ...s, withdrawProb: 0 }, view(side('100', { settling: true }), side('20'), '0'), () => 0.1).kind, 'idle');
  assert.deepEqual(decide({ ...s, withdrawProb: 0 }, view(side('100', { most: '0.1' }), side('20'), '0'), () => 0.1), { kind: 'merge', from: 'a' });
  // a withdrawal now and then, to the account, within its bounds
  d = decide(s, view(side('100'), side('20'), '0'), () => 0.01);
  assert.equal(d.kind, 'withdraw'); assert.ok(d.units >= s.withdrawMin && d.units <= s.withdrawMax);
  // TAC back in the account goes in again
  d = decide(s, view(side('100'), side('20'), '30'), () => 0.1);
  assert.equal(d.kind, 'shield'); assert.equal(d.units, tac('29.54'));
  // the in-play cap holds back a reshield
  assert.notEqual(decide(s, view(side('250'), side('50'), '30'), () => 0.1).kind, 'shield');
}

// failures in a row stop it; a success resets the count
{
  const f = makeFailures(3);
  f.fail(); f.fail(); f.ok(); assert.equal(f.count(), 0);
  assert.ok(!f.fail()); assert.ok(!f.fail()); assert.ok(f.fail()); assert.ok(f.stopped());
}
console.log(JSON.stringify({ ok: true }));
