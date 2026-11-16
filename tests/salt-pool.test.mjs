// Salt mining (worker/src/salt-pool.js): the CREATE3 address of a salt is the one CreateX computes; a share counts once, for the first
// address that sends it, only if it is Tacit's deployer's, ground today, and has its zero bits; one send per client at a time; a day's
// points are shared by weight once it is over; salts good enough are banked, best first.
//   node --test tests/salt-pool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeSaltPool, saltAddress, marketAddress, SALT_POOL, saltPoolConfig, softwareLabel } from '../worker/src/salt-pool.js';

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
  assert.equal(s.maxWeightBits, SALT_POOL.maxWeightBits, 'the cap on a find\'s weight is told, so a page can say what a find is worth');
});

test('config: env sets the share size, the points and the bank; nonsense keeps the defaults', () => {
  assert.equal(saltPoolConfig({ SALT_MIN_BITS: '30', POINTS_SALT_DAILY: '900', SALT_BANK_BITS: '44' }).minBits, 30);
  assert.equal(saltPoolConfig({ SALT_MIN_BITS: '2' }).minBits, SALT_POOL.minBits);
  assert.equal(saltPoolConfig({ POINTS_SALT_DAILY: 'lots' }).pointsPerDay, SALT_POOL.pointsPerDay);
});

test('config: the most a share can weigh is a setting, 2^20 unless it is given', async () => {
  assert.equal(saltPoolConfig({}).maxWeightBits, 20);
  assert.equal(saltPoolConfig({ SALT_MAX_WEIGHT_BITS: '4' }).maxWeightBits, 4);
  assert.equal(saltPoolConfig({ SALT_MAX_WEIGHT_BITS: '0' }).maxWeightBits, 0, 'none: every share weighs the same');
  for (const bad of ['-1', '41', '2.5', 'x', '']) assert.equal(saltPoolConfig({ SALT_MAX_WEIGHT_BITS: bad }).maxWeightBits, 20, `"${bad}" keeps the default`);
  // the same three shares (8, 12 and 16 zero bits, against a share size of 8) under three caps
  let t = 400 * DAY + 5000; const day = Math.floor(t / DAY);
  const s8 = (() => { for (;;) { const g = grind(day, 8); if (g.bits === 8) return g; } })(), s12 = (() => { for (;;) { const g = grind(day, 12); if (g.bits === 12) return g; } })(), s16 = (() => { for (;;) { const g = grind(day, 16); if (g.bits === 16) return g; } })();
  const weigh = async (maxWeightBits) => { const pool = makeSaltPool({ kv: kvStore(), cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0, maxWeightBits }, now: () => t }); const r = await pool.submit({ miner: A, salts: [s8.salt, s12.salt, s16.salt], client: 'c' }); return { weight: r.body.weight, cap: (await pool.summary()).body.maxWeightBits }; };
  assert.deepEqual(await weigh(20), { weight: 1 + 16 + 256, cap: 20 }, 'uncapped here: a share weighs two to the bits past the share size');
  assert.deepEqual(await weigh(4), { weight: 1 + 16 + 16, cap: 4 }, 'capped at four bits: the best share weighs 16, not 256');
  assert.deepEqual(await weigh(0), { weight: 3, cap: 0 }, 'at none every share weighs one, and the page is told the cap');
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

test('the salt floor: a day the proofs filled still pays the salts at least the floor, never past their own most, and a floor of 0 is the old rule', async () => {
  const t = 500 * DAY + 1000, kv = kvStore(), used = new Map();
  const potOf = (cfg, pot = 5000) => makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0, ...cfg }, now: () => t, potPoints: async () => pot, proofPoints: async (d) => used.get(d) || 0 });
  const at = async (pool) => (await pool.credits(500)).body.pointsPerDay;
  const pool = potOf({ floorPoints: 3000 });
  used.set(500, 1500); assert.equal(await at(pool), 3500, 'room above the floor: what the proofs leave');
  used.set(500, 4800); assert.equal(await at(pool), 3000, 'a busy day: the floor, not the 200 left');
  used.set(500, 6000); assert.equal(await at(pool), 3000, 'proofs past the whole pot: still the floor');
  assert.equal(await at(potOf({ floorPoints: 3000, pointsPerDay: 1000 })), 1000, 'the floor never passes their own most');
  assert.equal(await at(potOf({ floorPoints: 0 })), 0, 'a floor of 0 pays nothing once the proofs took the pot');
  const blind = makeSaltPool({ kv, cfg: { ...SALT_POOL, floorPoints: 3000 }, now: () => t, potPoints: async () => { throw new Error('down'); }, proofPoints: async () => { throw new Error('down'); } });
  assert.equal((await blind.credits(500)).body.pointsPerDay, SALT_POOL.potPoints, 'nothing readable: the default pot, the floor is under it');
  assert.equal((await pool.summary()).body.pointsPerDay, 3000, 'the page\'s live row says the same');
});

test('a day\'s pot is the one the paying service names for it: once the daily amount changes, a finished day is not shared out of the new pot', async () => {
  const t = 500 * DAY + 1000, kv = kvStore(), used = new Map([[500, 52_000]]);
  let campaign = 30_000;                                           // the campaign's daily points now
  const pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0, pointsPerDay: 15_000, floorPoints: 3000 }, now: () => t + DAY, potPoints: async () => campaign, proofPoints: async (d) => used.get(d) || 0 });
  await makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0 }, now: () => t, potPoints: async () => 5000 }).submit({ miner: A, salts: [grind(500, 8).salt], client: 'c1' });
  const at = async (opts) => (await pool.credits(500, opts)).body.pointsPerDay;
  assert.equal(await at(), 3000, 'the day was shared out of a 30,000 pot that the proofs had used up: the floor');
  campaign = 60_000;                                               // the daily amount doubles for the days after
  assert.equal(await at(), 8000, 'asked without the day\'s pot, a finished day takes the new terms (what the points service must not rely on)');
  assert.equal(await at({ pot: 30_000 }), 3000, 'with the pot the day had, it is the same as it was');
  assert.equal(await at({ pot: 60_000 }), 8000, 'and a pot that really was 60,000 shares what the proofs left of it');
  for (const bad of [0, -5, 1.5, NaN, null, undefined, 200_000_000, '30000']) assert.equal(await at({ pot: bad }), 8000, `a pot of ${String(bad)} is not taken: the campaign's terms stand`);
});

test('the salt floor config: POINTS_SALT_FLOOR within its bounds, bad values keep the default', () => {
  assert.equal(saltPoolConfig({}).floorPoints, 3000);
  assert.equal(saltPoolConfig({ POINTS_SALT_FLOOR: '500' }).floorPoints, 500);
  assert.equal(saltPoolConfig({ POINTS_SALT_FLOOR: '0' }).floorPoints, 0, '0 turns the floor off');
  for (const bad of ['-1', '2.5', 'lots', '2000000']) assert.equal(saltPoolConfig({ POINTS_SALT_FLOOR: bad }).floorPoints, 3000, `"${bad}" keeps the default`);
});

test('the salts share what the day\'s proofs leave of the campaign\'s daily points, up to their own most', async () => {
  let t = 500 * DAY + 1000;
  const kv = kvStore(), used = new Map([[500, 1500]]);
  const pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0, floorPoints: 0 }, now: () => t, potPoints: async () => 5000, proofPoints: async (d) => used.get(d) || 0 });
  await pool.submit({ miner: A, salts: [grind(500, 8).salt], client: 'c1' });
  assert.equal((await pool.summary()).body.pointsPerDay, 3500, 'today so far: 5000 less the 1500 the proofs took');
  used.set(500, 4800);
  t += DAY;
  const c = (await pool.credits(500)).body;
  assert.equal(c.pointsPerDay, 200, 'a busy day leaves the salts less');
  assert.equal(c.miners[0].points, 200);
  used.set(500, 6000);
  assert.equal((await pool.credits(500)).body.pointsPerDay, 0, 'and nothing once the proofs took the pot');
  const capped = makeSaltPool({ kv, cfg: { ...SALT_POOL, pointsPerDay: 1000, floorPoints: 0 }, now: () => t, potPoints: async () => 5000, proofPoints: async () => 0 });
  assert.equal((await capped.credits(500)).body.pointsPerDay, 1000, 'never past their own most');
  const blind = makeSaltPool({ kv, cfg: SALT_POOL, now: () => t, potPoints: async () => { throw new Error('down'); }, proofPoints: async () => 0 });
  assert.equal((await blind.credits(500)).body.pointsPerDay, SALT_POOL.potPoints, 'the campaign\'s terms unread: the default pot');
});

test('the bank is the best salts found so far, capped: a better find enters it, a weaker one once it is full does not; each miner keeps its best salt', async () => {
  let t = 600 * DAY + 1000;
  const kv = kvStore(), writes = [];
  const put = kv.put; kv.put = async (k, v, o) => { if (k === 'sl:bank') writes.push(k); return put(k, v, o); };
  const pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, bankBits: 9, bankKeep: 2, sendEveryMs: 0 }, now: () => t });
  const a = grind(600, 11), b = grind(600, 12), weak = (() => { for (;;) { const g = grind(600, 9); if (g.bits < 11) return g; } })();
  await pool.submit({ miner: A, salts: [a.salt, b.salt], client: 'c1' });
  assert.equal(writes.length, 1);
  await pool.submit({ miner: A, salts: [weak.salt], client: 'c1' });
  assert.equal(writes.length, 1, 'a weaker find than the full bank holds writes nothing');
  assert.deepEqual((await pool.bank()).body.bank.map((x) => x.salt).sort(), [a.salt, b.salt].sort());
  const better = grind(600, Math.max(a.bits, b.bits) + 1);
  await pool.submit({ miner: B, salts: [better.salt], client: 'c2' });
  assert.equal(writes.length, 2);
  assert.ok((await pool.bank()).body.bank.some((x) => x.salt === better.salt), 'a better one enters');
  assert.equal(JSON.parse(kv.m.get(`sl:m:600:${A}`)).best.salt, [a, b].sort((x, y) => y.bits - x.bits)[0].salt, 'the miner\'s best is kept with its salt');
});

test('good finds go on a ring for the activity feed, newest first and capped; weaker finds, repeats and rejected salts do not; the house is marked', async () => {
  let t = 700 * DAY + 1000;
  const kv = kvStore();
  const pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, bankBits: 20, goodBits: 10, recentKeep: 3, sendEveryMs: 0, house: [B] }, now: () => t });
  const weak = (() => { for (;;) { const g = grind(700, 8); if (g.bits < 10) return g; } })();
  const g1 = grind(700, 10), g2 = grind(700, 10), g3 = grind(700, 10), g4 = grind(700, 10);
  await pool.submit({ miner: A, salts: [weak.salt], client: 'c1' });
  assert.deepEqual((await pool.summary()).body.recent, [], 'a find under goodBits is not on the ring');
  assert.equal(kv.m.has('sl:recent'), false, 'and writes nothing');
  await pool.submit({ miner: A, salts: [g1.salt], client: 'c1' });
  t += 1000;
  await pool.submit({ miner: B, salts: [g2.salt], client: 'c2' });
  t += 1000;
  await pool.submit({ miner: A, salts: [g1.salt, 'not a salt'], client: 'c1' });
  let r = (await pool.summary()).body.recent;
  assert.deepEqual(r.map((x) => x.address), [g2.address, g1.address], 'newest first; a salt sent again is counted once and is not listed twice');
  assert.deepEqual(r[0], { address: g2.address, bits: g2.bits, miner: B, at: t - 1000, house: true });
  assert.equal(r[1].house, undefined);
  t += 1000;
  await pool.submit({ miner: A, salts: [g3.salt], client: 'c1' });
  t += 1000;
  await pool.submit({ miner: A, salts: [g4.salt], client: 'c1' });
  r = (await pool.summary()).body.recent;
  assert.deepEqual(r.map((x) => x.address), [g4.address, g3.address, g2.address], 'the ring keeps the newest recentKeep');
  assert.ok(r.every((x) => Object.keys(x).every((k) => ['address', 'bits', 'miner', 'at', 'house'].includes(k))), 'no salt text leaves the API');
});

test('config: SALT_GOOD_BITS sets the feed\'s bar; nonsense keeps the default', () => {
  assert.equal(saltPoolConfig({}).goodBits, SALT_POOL.goodBits);
  assert.equal(SALT_POOL.goodBits, 32, 'four leading zero bytes');
  assert.equal(saltPoolConfig({ SALT_GOOD_BITS: '36' }).goodBits, 36);
  assert.equal(saltPoolConfig({ SALT_GOOD_BITS: '3' }).goodBits, SALT_POOL.goodBits);
  assert.equal(saltPoolConfig({ SALT_GOOD_BITS: 'x' }).goodBits, SALT_POOL.goodBits);
});

test('a miner can say what software it is: the label is cleaned, shown next to it while it sends, and counted', async () => {
  assert.equal(softwareLabel('tacit-prover/v0.6.4'), 'tacit-prover/v0.6.4');
  assert.equal(softwareLabel('  my miner 2.0 '), 'my miner 2.0');
  assert.equal(softwareLabel('<script>alert(1)</script>x'), 'scriptalert1/scriptx', 'angle brackets, quotes and the rest are dropped');
  assert.equal(softwareLabel('x'.repeat(100)).length, 40, 'cut to 40');
  assert.deepEqual(['', null, undefined, 7, {}, ['a']].map(softwareLabel), ['', '', '', '', '', ''], 'only a string is a label');
  let t = 400 * DAY + 1000;
  const kv = kvStore(), pool = makeSaltPool({ kv, cfg: { ...SALT_POOL, minBits: 8, sendEveryMs: 0, house: [SALT_POOL.deployer] }, now: () => t });
  const C = '0x' + 'c3'.repeat(20), D = '0x' + 'd4'.repeat(20), E = '0x' + 'e5'.repeat(20);
  await pool.submit({ miner: A, salts: [grind(400, 8).salt], client: 'c1', software: 'tacit-prover/v0.6.4', ua: 'ignored' });
  await pool.submit({ miner: B, salts: [grind(400, 8).salt], client: 'c2', ua: 'ureq/2.12.1' });
  await pool.submit({ miner: C, salts: [grind(400, 8).salt], client: 'c3' });
  await pool.submit({ miner: D, salts: [grind(400, 8).salt], client: 'c4', software: 'tacit-prover/v0.6.3' });
  await pool.submit({ miner: E, salts: [grind(400, 8).salt], client: 'c5', software: 'tacit-prover/v0.6.4' });
  await pool.submit({ miner: SALT_POOL.deployer, salts: [grind(400, 8).salt], client: 'house', software: 'tacit-house' });
  const s = (await pool.summary()).body, sw = Object.fromEntries(s.live.map((l) => [l.miner, l.sw]));
  assert.equal(sw[A], 'tacit-prover/v0.6.4', 'the label the miner sent wins over its User-Agent');
  assert.equal(sw[B], 'ureq/2.12.1', 'with none sent, the User-Agent is the label');
  assert.equal(C in sw && sw[C] === undefined, true, 'with neither, no label is kept');
  assert.deepEqual(s.software, { 'tacit-prover/v0.6.4': 2, 'tacit-prover/v0.6.3': 1, 'ureq/2.12.1': 1, unknown: 1 }, 'counted by software, most first; Tacit\'s own machine is not counted');
  assert.deepEqual(Object.keys(s.software)[0], 'tacit-prover/v0.6.4');
  // a miner that changes software is shown with the newest label
  await pool.submit({ miner: C, salts: [grind(400, 8).salt], client: 'c3', software: 'tacit-metal-salt/1' });
  assert.equal(Object.fromEntries((await pool.summary()).body.live.map((l) => [l.miner, l.sw]))[C], 'tacit-metal-salt/1');
});

// ---- the vanity-address market's salts (contracts/src/VanityShop.sol) ----
const SHOP = '0x' + 'aa'.repeat(20);
const MARKET_CFG = { ...SALT_POOL, minBits: 8, bankBits: 10, sendEveryMs: 0, schemes: ['createx', 'market'], shop: SHOP };
// A salt of the shop for `day` whose address at `nonce` has at least `bits` zero bits.
function grindMarket(day, bits, nonce = 0) {
  for (;;) {
    const s = '0x' + SHOP.slice(2) + '00' + (day % 65536).toString(16).padStart(4, '0') + randomBytes(9).toString('hex');
    const a = marketAddress(s, nonce);
    if (a.bits >= bits) return { salt: s, nonce, ...a };
  }
}

test('a market salt\'s address is the one VanityMarket.computeAddress answers, for every way a nonce is written in RLP', () => {
  // tests/fixtures/vanity-market-vectors.txt: `cast call 0x000000000000b361194cfe6312EE3210d53C15AA computeAddress(bytes32,uint8)` on mainnet, "id nonce address"
  const rows = readFileSync(new URL('./fixtures/vanity-market-vectors.txt', import.meta.url), 'utf8').trim().split('\n').map((l) => l.split(' '));
  assert.equal(rows.length, 21);
  for (const [id, n, want] of rows) assert.equal(marketAddress(id, Number(n)).address, want.toLowerCase(), `${id.slice(0, 12)}… nonce ${n}`);
  assert.deepEqual(rows.map((r) => Number(r[1])).filter((n, i) => i < 7), [0, 1, 126, 127, 128, 253, 254], 'nonce + 1 on both sides of 0x7f and at the top');
  assert.equal(marketAddress('0x' + '00'.repeat(32), 0).bits, 0);
  assert.equal(marketAddress('0x' + '00'.repeat(31) + 'ff').address, '0x7bb5fe004ab6521f5d2a4ab08fd5f29383a50a95', 'a nonce left out is 0');
});

test('config: SALT_SCHEMES names the kinds of salt taken; market needs a shop address, anything else keeps CreateX alone', () => {
  const shop = '0x' + 'ab'.repeat(20);
  assert.deepEqual(saltPoolConfig({}).schemes, ['createx']);
  assert.equal(saltPoolConfig({}).shop, null);
  assert.deepEqual(saltPoolConfig({ SALT_SCHEMES: 'createx,market', SALT_SHOP: shop }).schemes, ['createx', 'market']);
  assert.deepEqual(saltPoolConfig({ SALT_SCHEMES: 'market,createx', SALT_SHOP: shop }).schemes, ['market', 'createx'], 'the first is the one new miners grind');
  assert.deepEqual(saltPoolConfig({ SALT_SCHEMES: 'market', SALT_SHOP: shop }).schemes, ['market']);
  assert.deepEqual(saltPoolConfig({ SALT_SCHEMES: 'createx,market' }).schemes, ['createx'], 'no shop, no market salts');
  assert.deepEqual(saltPoolConfig({ SALT_SCHEMES: 'market', SALT_SHOP: 'nope' }).schemes, ['createx'], 'a shop that is not an address is no shop');
  assert.deepEqual(saltPoolConfig({ SALT_SCHEMES: 'nonsense' }).schemes, ['createx']);
  assert.equal(saltPoolConfig({ SALT_SHOP: shop.toUpperCase().replace('0X', '0x') }).shop, shop, 'case does not matter');
  assert.equal(saltPoolConfig({}).market, '0x000000000000b361194cfe6312ee3210d53c15aa');
  assert.equal(saltPoolConfig({ SALT_MARKET: '0x' + '12'.repeat(20) }).market, '0x' + '12'.repeat(20));
});

test('market salts: counted once per id whatever the nonce, which rides on the share; every other share is refused with its reason', async () => {
  const t = 300 * DAY + 5000;
  const kv = kvStore(), pool = makeSaltPool({ kv, cfg: MARKET_CFG, now: () => t });
  const a = grindMarket(300, 8), b = grindMarket(300, 8, 5);
  const r = await pool.submit({ miner: A, salts: [a.salt, `${b.salt}:5`], client: 'c1' });
  assert.equal(r.body.accepted, 2, JSON.stringify(r.body.rejected));
  assert.equal(r.body.today.best.address, (a.bits >= b.bits ? a : b).address, 'the best is judged at the nonce named');
  // one id good at two nonces is still one token: the second send names it again and is refused
  const lax = makeSaltPool({ kv: kvStore(), cfg: { ...MARKET_CFG, minBits: 4 }, now: () => t });
  const two = (() => { for (;;) { const g = grindMarket(300, 4, 0); if (marketAddress(g.salt, 7).bits >= 4) return g; } })();
  assert.equal((await lax.submit({ miner: A, salts: [two.salt], client: 'c1' })).body.accepted, 1);
  assert.equal((await lax.submit({ miner: B, salts: [`${two.salt}:7`], client: 'c2' })).body.rejected[0].why, 'already counted', 'the same id at another nonce is the same token');
  const dep = grind(300, 8), weak = (() => { for (;;) { const g = grindMarket(300, 0); if (g.bits < 8) return g; } })();
  const out = await pool.submit({ miner: A, salts: [`${dep.salt}:1`, `${grindMarket(300, 8).salt}:255`, `${grindMarket(300, 8).salt}:300`, grindMarket(295, 8).salt, weak.salt,
    '0x' + '33'.repeat(20) + '00' + '012c' + 'aa'.repeat(9), `${a.salt}:x`], client: 'c1' });
  assert.deepEqual(out.body.rejected.map((x) => x.why.split(',')[0].replace(/\d+ zero bits/, 'bits')), [
    'a nonce is for market salts only', 'nonce over 254', 'nonce over 254', 'not ground today', 'bits',
    'not a salt of Tacit\'s deployer or shop', 'not a salt of Tacit\'s deployer or shop',
  ]);
  assert.equal(out.body.accepted, 0);
  assert.equal((await pool.submit({ miner: A, salts: [dep.salt], client: 'c1' })).body.accepted, 1, 'the deployer\'s own salts are still taken while CreateX is on');
});

test('market salts have their own bank, nonce included; CreateX\'s bank is not touched; the page summary says which kinds are taken', async () => {
  const t = 301 * DAY + 5000;
  const kv = kvStore(), pool = makeSaltPool({ kv, cfg: MARKET_CFG, now: () => t });
  const m = grindMarket(301, 10, 3), c = grind(301, 10);
  await pool.submit({ miner: A, salts: [`${m.salt}:3`, c.salt], client: 'c1' });
  const bank = (await pool.bank()).body;
  assert.deepEqual(bank.bank.map((x) => x.salt), [c.salt], 'CreateX\'s bank holds only its own');
  assert.equal(bank.marketBank.length, 1);
  assert.deepEqual({ salt: bank.marketBank[0].salt, nonce: bank.marketBank[0].nonce, address: bank.marketBank[0].address, bits: bank.marketBank[0].bits }, { salt: m.salt, nonce: 3, address: m.address, bits: m.bits });
  const sum = (await pool.summary()).body;
  assert.deepEqual(sum.schemes, ['createx', 'market']);
  assert.equal(sum.shop, SHOP); assert.equal(sum.market, SALT_POOL.market); assert.equal(sum.nonceMax, 254);
  assert.equal(sum.marketBanked, 1); assert.equal(sum.marketBank[0].address, m.address); assert.equal(sum.marketBank[0].nonce, 3);
  assert.equal(sum.marketBank[0].salt, undefined, 'the page list names addresses, not ids (as the CreateX list)');
});

test('with CreateX alone nothing changes: a market salt is not taken, and neither bank list nor summary mentions the market', async () => {
  const t = 302 * DAY + 5000;
  const pool = makeSaltPool({ kv: kvStore(), cfg: { ...MARKET_CFG, schemes: ['createx'] }, now: () => t });
  const out = await pool.submit({ miner: A, salts: [grindMarket(302, 8).salt], client: 'c1' });
  assert.equal(out.body.rejected[0].why, 'not a salt of Tacit\'s deployer');
  assert.equal('marketBank' in (await pool.bank()).body, false);
  const sum = (await pool.summary()).body;
  assert.deepEqual(sum.schemes, ['createx']);
  assert.equal('shop' in sum, false); assert.equal('marketBank' in sum, false);
});

test('only the market: the deployer\'s salts are refused, the market\'s are taken', async () => {
  const t = 303 * DAY + 5000;
  const pool = makeSaltPool({ kv: kvStore(), cfg: { ...MARKET_CFG, schemes: ['market'] }, now: () => t });
  const out = await pool.submit({ miner: A, salts: [grind(303, 8).salt, grindMarket(303, 8).salt], client: 'c1' });
  assert.equal(out.body.accepted, 1);
  assert.equal(out.body.rejected[0].why, 'not a salt of Tacit\'s deployer or shop');
});

test('market named but no shop: nothing of the market is taken, not even a salt that leads with the zero address', async () => {
  const t = 304 * DAY + 5000;
  const pool = makeSaltPool({ kv: kvStore(), cfg: { ...MARKET_CFG, shop: null }, now: () => t });
  const zero = '0x' + '00'.repeat(20) + '00' + (304 % 65536).toString(16).padStart(4, '0') + 'aa'.repeat(9);
  const out = await pool.submit({ miner: A, salts: [zero], client: 'c1' });
  assert.equal(out.body.accepted, 0);
  assert.equal(out.body.rejected[0].why, 'not a salt of Tacit\'s deployer');
  assert.equal('marketBank' in (await pool.bank()).body, false);
  assert.equal('shop' in (await pool.summary()).body, false);
});
