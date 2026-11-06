// Salt mining (worker/src/salt-pool.js): the CREATE3 address of a salt is the one CreateX computes; a share counts once, for the first
// address that sends it, only if it is Tacit's deployer's, ground today, and has its zero bits; one send per client at a time; a day's
// points are shared by weight once it is over; salts good enough are banked, best first.
//   node --test tests/salt-pool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { makeSaltPool, saltAddress, SALT_POOL, saltPoolConfig } from '../worker/src/salt-pool.js';

const DAY = 86_400_000;
function kvStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
}
// A salt of the deployer for `day` with at least `bits` zero bits at the front of its address.
function grind(day, bits) {
  for (;;) {
    const s = '0x' + SALT_POOL.deployer.slice(2) + '00' + (day % 65536).toString(16).padStart(4, '0') + randomBytes(9).toString('hex');
    const a = saltAddress(s);
    if (a.bits >= bits) return { salt: s, ...a };
  }
}
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);

test('a salt\'s address is the one CreateX deployed Tacit\'s contracts to', () => {
  // contracts/deployments/launch-v1-final.env: the EthCallOutbox's and the engine's salts, and where CreateX put them
  assert.deepEqual(saltAddress('0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7000326fb99fa8e9a005a64b9'), { address: '0x00000000a26a6e291972666a9687741dba11af46', bits: 32 });
  assert.deepEqual(saltAddress('0x68575b073de49a94e3e3acf6f3a0d6e3b66267c700ec177948ae55d401e57fc1'), { address: '0x000000003f608bddf0ca45934003ffb9dbdf70db', bits: 34 });
});

test('a share counts once, for the first address that sends it; other salts are refused with the reason', async () => {
  let t = 100 * DAY + 5000;
  const kv = kvStore(), pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0 }, now: () => t });
  const day = 100, good = grind(day, 8);
  const r = await pool.submit({ miner: A, salts: [good.salt], client: 'c1' });
  assert.equal(r.body.accepted, 1);
  assert.equal((await pool.submit({ miner: B, salts: [good.salt], client: 'c2' })).body.rejected[0].why, 'already counted');
  const other = '0x' + '33'.repeat(20) + '00' + '0064' + 'aa'.repeat(9);
  const old = grind(day - 5, 8);
  const weak = (() => { for (;;) { const g = grind(day, 0); if (g.bits < 8) return g; } })();
  const out = await pool.submit({ miner: A, salts: [other, old.salt, weak.salt], client: 'c1' });
  assert.deepEqual(out.body.rejected.map((x) => x.why.split(',')[0].replace(/\d+ zero bits/, 'bits')), ['not a salt of Tacit\'s deployer', 'not ground today', 'bits']);
  assert.equal((await pool.submit({ miner: 'nope', salts: [good.salt], client: 'c1' })).status, 400);
});

test('one send per client at a time', async () => {
  let t = 100 * DAY;
  const pool = makeSaltPool({ kv: kvStore(), cfg: { ...SALT_POOL, minBits: 8 }, now: () => t });
  assert.equal((await pool.submit({ miner: A, salts: [grind(100, 8).salt], client: 'c1' })).status, 200);
  assert.equal((await pool.submit({ miner: A, salts: [grind(100, 8).salt], client: 'c1' })).status, 429);
  t += SALT_POOL.sendEveryMs;
  assert.equal((await pool.submit({ miner: A, salts: [grind(100, 8).salt], client: 'c1' })).status, 200);
});

test('a day\'s points are shared by weight once it is over, and good salts are banked best first', async () => {
  let t = 200 * DAY + 1000;
  const kv = kvStore(), pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, bankBits: 10, sendEveryMs: 0, pointsPerDay: 1000 }, now: () => t });
  const a = [grind(200, 8), grind(200, 8)], b = [grind(200, 10)];
  await pool.submit({ miner: A, salts: a.map((x) => x.salt), client: 'c1' });
  await pool.submit({ miner: B, salts: b.map((x) => x.salt), client: 'c2' });
  const live = (await pool.credits(200)).body;
  assert.equal(live.over, false);
  t += DAY;
  const c = (await pool.credits(200)).body;
  assert.equal(c.over, true);
  const w = (g) => 2 ** (g.bits - 8);
  const wa = a.reduce((s, g) => s + w(g), 0), wb = b.reduce((s, g) => s + w(g), 0);
  assert.deepEqual(c.miners.find((m) => m.miner === A), { miner: A, proofs: 2, points: Math.floor((1000 * wa) / (wa + wb)) });
  assert.ok(c.miners.reduce((s, m) => s + m.points, 0) <= 1000, 'never more than the day\'s points');
  const bank = (await pool.bank()).body.bank;
  assert.ok(bank.length >= 1 && bank.every((x) => x.bits >= 10) && bank.every((x, i) => i === 0 || bank[i - 1].bits >= x.bits));
  const s = (await pool.summary()).body;
  assert.equal(s.deployer, SALT_POOL.deployer);
});

test('config: env sets the share size, the points and the bank; nonsense keeps the defaults', () => {
  assert.equal(saltPoolConfig({ SALT_MIN_BITS: '30', POINTS_SALT_DAILY: '900', SALT_BANK_BITS: '44' }).minBits, 30);
  assert.equal(saltPoolConfig({ SALT_MIN_BITS: '2' }).minBits, SALT_POOL.minBits);
  assert.equal(saltPoolConfig({ POINTS_SALT_DAILY: 'lots' }).pointsPerDay, SALT_POOL.pointsPerDay);
});

test('Tacit\'s own machines bank what they find and never share the day\'s points', async () => {
  let t = 300 * DAY + 1000;
  const kv = kvStore(), pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, bankBits: 9, sendEveryMs: 0, pointsPerDay: 1000, house: [SALT_POOL.deployer] }, now: () => t });
  const h = grind(300, 9), c = grind(300, 8);
  const r = await pool.submit({ miner: SALT_POOL.deployer, salts: [h.salt], client: 'house' });
  assert.equal(r.body.accepted, 1);
  assert.equal(r.body.today, null);
  await pool.submit({ miner: A, salts: [c.salt], client: 'c1' });
  t += DAY;
  const credits = (await pool.credits(300)).body.miners;
  assert.deepEqual(credits.map((m) => m.miner), [A], 'only the community address shares the day');
  assert.equal(credits[0].points, 1000);
  const bank = (await pool.bank()).body.bank;
  assert.ok(bank.some((b) => b.miner === SALT_POOL.deployer && b.house === true), 'the house salt is banked, marked');
  assert.equal(saltPoolConfig({}).house[0], SALT_POOL.deployer, 'the deployer is the house by default');
});

test('who is grinding now and how fast: every address that sent shares lately, Tacit\'s named so, and the last hour\'s shares as a rate', async () => {
  let t = 400 * DAY + 3 * 3_600_000 + 600_000;
  const pool = makeSaltPool({ kv: kvStore(), cfg: { ...SALT_POOL, minBits: 8, bankBits: 9, sendEveryMs: 0, house: [SALT_POOL.deployer] }, now: () => t });
  await pool.submit({ miner: A, salts: [grind(400, 8).salt, grind(400, 8).salt], client: 'c1' });
  await pool.submit({ miner: SALT_POOL.deployer, salts: [grind(400, 9).salt], client: 'house' });
  let s = (await pool.summary()).body;
  assert.deepEqual(s.live.map((l) => [l.miner, !!l.house]).sort(), [[A, false], [SALT_POOL.deployer, true]].sort());
  assert.equal(s.rate, Math.round((3 * 2 ** 8) / ((3_600_000 + 600_000) / 1000)), 'three shares of 2^8 salts over the hour and ten minutes they span');
  t += SALT_POOL.liveMs + 1;
  s = (await pool.summary()).body;
  assert.deepEqual(s.live, [], 'nobody once they stop sending');
});

test('the salts share what the day\'s proofs leave of the campaign\'s daily points, up to their own most', async () => {
  let t = 500 * DAY + 1000;
  const kv = kvStore(), used = new Map([[500, 1500]]);
  const pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0 }, now: () => t, potPoints: async () => 5000, proofPoints: async (d) => used.get(d) || 0 });
  await pool.submit({ miner: A, salts: [grind(500, 8).salt], client: 'c1' });
  assert.equal((await pool.summary()).body.pointsPerDay, 3500, 'today so far: 5000 less the 1500 the proofs took');
  used.set(500, 4800);
  t += DAY;
  const c = (await pool.credits(500)).body;
  assert.equal(c.pointsPerDay, 200, 'a busy day leaves the salts less');
  assert.equal(c.miners[0].points, 200);
  used.set(500, 6000);
  assert.equal((await pool.credits(500)).body.pointsPerDay, 0, 'and nothing once the proofs took the pot');
  const capped = makeSaltPool({ kv, cfg: { ...SALT_POOL, pointsPerDay: 1000 }, now: () => t, potPoints: async () => 5000, proofPoints: async () => 0 });
  assert.equal((await capped.credits(500)).body.pointsPerDay, 1000, 'never past their own most');
  const blind = makeSaltPool({ kv, cfg: SALT_POOL, now: () => t, potPoints: async () => { throw new Error('down'); }, proofPoints: async () => 0 });
  assert.equal((await blind.credits(500)).body.pointsPerDay, SALT_POOL.potPoints, 'the campaign\'s terms unread: the default pot');
});
