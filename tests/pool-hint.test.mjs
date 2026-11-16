// dapp/pool-hint.js, what a deposit's receipt says of a pool in which a trade can land while the deposit is being proved: how far a 0.1 ETH trade moves it, for pools that a small
// trade does move, and how often the server has seen it change (the `activity` that comes with the farm program), spoken only while that is fresh and long enough kept.
//   node tests/pool-hint.test.mjs
import assert from 'node:assert/strict';
import { smallPool, recentMoves, poolNote, TRADE_ETH, SHOW_AT, BUSY_AT, MIN_SPAN_MS, MAX_AGE_MS, TIP, MOVES_TIP } from '../dapp/pool-hint.js';

// constant product, half the pool's worth on the ETH side: a trade of d ETH into reserve R takes the price to ((R + d) / R)^2 of what it was
const move = (worth, d = TRADE_ETH) => ((1 + d / (worth / 2)) ** 2 - 1) * 100;

// the live tETH / TAC pool, about 17.5 ETH in all (11-16): a tenth of an ETH moves it about two percent
{
  const h = smallPool(17.5);
  assert.ok(Math.abs(h.move - move(17.5)) < 1e-9); assert.ok(h.move > 2.2 && h.move < 2.4, `2.3% (${h.move})`);
  assert.deepEqual(h.row, ['Small pool', 'a 0.1 ETH trade moves its price 2.3%', '', TIP]);
  assert.match(h.time, /^, longer if the pool trades meanwhile$/);
}
// the thinner the pool the more a trade moves it, and the figure is said in the digits that mean something
assert.equal(smallPool(2.5).row[1], 'a 0.1 ETH trade moves its price 17%', 'two figures and up are whole percents');
assert.equal(smallPool(5).row[1], 'a 0.1 ETH trade moves its price 8.2%');
assert.equal(smallPool(60).row[1], 'a 0.1 ETH trade moves its price 0.67%', 'under one percent keeps two places');
assert.ok(smallPool(2).move > smallPool(20).move && smallPool(20).move > smallPool(60).move);
// where it begins: a pool that a tenth of an ETH moves by less than half a percent is not small
{
  const edge = 2 * TRADE_ETH / (Math.sqrt(1 + SHOW_AT / 100) - 1);      // the worth at which the move is SHOW_AT: R = d / (sqrt(1 + s) - 1), worth = 2R
  assert.ok(Math.abs(move(edge) - SHOW_AT) < 1e-9, `the edge is where the move is ${SHOW_AT}% (${edge})`);
  assert.ok(smallPool(edge * 0.99), 'just under it, the hint is there'); assert.equal(smallPool(edge * 1.01), null, 'just over it, there is none');
  assert.ok(edge > 70 && edge < 90, `about 80 ETH (${edge})`);
}
assert.equal(smallPool(1000), null, 'a deep pool says nothing');
// a pool whose size is not known says nothing rather than something wrong
for (const bad of [null, undefined, 0, -3, NaN, Infinity, '', 'x']) assert.equal(smallPool(bad), null, `no hint for ${String(bad)}`);
assert.ok(smallPool('17.5'), 'a size given as text is read');
// the live pools as the program lists them (11-16, ETH side doubled): all thin, the SPX / cETH one thinnest
{
  const live = { 'tETH/TAC': 17.5, 'tETH/cUSD': 3.6, 'tETH/cBTC': 2.4, 'SPX/cETH': 0.23 };
  for (const [name, w] of Object.entries(live)) assert.ok(smallPool(w), `${name} is a small pool`);
  assert.ok(smallPool(0.23).move > 100, 'a tenth of an ETH more than doubles the price of the thinnest');
}

// ── how often it has changed ──
const NOW = 1_800_000_000_000, MIN = 60e3;
const act = (o = {}) => ({ at: NOW - 2 * MIN, since: NOW - 300 * MIN, hour: 4, day: 31, lastMoveAt: NOW - 12 * MIN, ...o });
{
  const r = recentMoves(act(), NOW);
  assert.deepEqual(r, { n: 4, busy: true, text: '4 in the last hour, the last 12 min ago' }, 'counted to the server\'s last reading, the last move told from now');
  assert.equal(recentMoves(act({ hour: 2 }), NOW).busy, false); assert.equal(recentMoves(act({ hour: BUSY_AT }), NOW).busy, true, 'three is busy');
  assert.equal(recentMoves(act({ hour: 1, lastMoveAt: NOW - 30 * 1000 }), NOW).text, '1 in the last hour, the last 1 min ago', 'never under a minute');
  assert.equal(recentMoves(act({ hour: 1, lastMoveAt: NOW - 200 * MIN }), NOW).text, '1 in the last hour, the last 3 h ago', 'hours past an hour and a half');
  assert.equal(recentMoves(act({ hour: 0, lastMoveAt: null }), NOW).text, 'none in the last hour', 'a quiet hour');
  assert.equal(recentMoves(act({ hour: 3, lastMoveAt: null }), NOW).text, '3 in the last hour', 'without a time for the last, none is told');
  // a record that has only been kept a while says so, and says nothing before MIN_SPAN_MS
  assert.equal(recentMoves(act({ since: NOW - 2 * MIN - 40 * MIN, hour: 2 }), NOW).text, '2 in the last 40 min, the last 12 min ago');
  assert.equal(recentMoves(act({ since: NOW - 2 * MIN - MIN_SPAN_MS }), NOW).n, 4, 'at the shortest it is told'); assert.equal(recentMoves(act({ since: NOW - 2 * MIN - MIN_SPAN_MS + 1 }), NOW), null, 'a shade under, it is not');
  // a stale record is not told; nor is anything that is not a summary
  assert.ok(recentMoves(act({ at: NOW - MAX_AGE_MS }), NOW), 'at its oldest it is still told'); assert.equal(recentMoves(act({ at: NOW - MAX_AGE_MS - 1 }), NOW), null, 'a shade older, not');
  for (const bad of [null, undefined, {}, { at: NOW }, 'x', { at: 'a', since: 1, hour: 1 }, { at: NOW, since: NOW - 3600e3, hour: NaN }]) assert.equal(recentMoves(bad, NOW), null, 'no words from ' + JSON.stringify(bad));
  assert.equal(recentMoves(act({ hour: 2.4 }), NOW).n, 2, 'whole counts');
}
// poolNote: depth and activity together
{
  const busySmall = poolNote(17.5, act(), NOW);
  assert.equal(busySmall.rows.length, 2); assert.equal(busySmall.rows[0][0], 'Small pool'); assert.equal(busySmall.rows[1][0], 'Busy pool');
  assert.equal(busySmall.rows[1][1], '4 in the last hour, the last 12 min ago'); assert.equal(busySmall.rows[1][3], MOVES_TIP); assert.equal(busySmall.rows[0][3], TIP);
  assert.equal(busySmall.time, ', longer if the pool trades meanwhile'); assert.ok(busySmall.move > 2);
  const calm = poolNote(17.5, act({ hour: 1 }), NOW);
  assert.equal(calm.rows[1][0], 'Recent moves', 'one or two moves is not busy');
  const quietSmall = poolNote(17.5, act({ hour: 0, lastMoveAt: null }), NOW);
  assert.deepEqual(quietSmall.rows.map((r) => r[0]), ['Small pool', 'Recent moves']); assert.equal(quietSmall.rows[1][1], 'none in the last hour'); assert.equal(quietSmall.time, '', 'a quiet hour does not warn of a wait');
  // a deep pool: said only when it has been changing
  assert.equal(poolNote(1000, act({ hour: 0, lastMoveAt: null }), NOW), null, 'deep and quiet: nothing');
  assert.equal(poolNote(1000, null, NOW), null, 'deep and no record: nothing');
  const deepBusy = poolNote(1000, act({ hour: 5 }), NOW);
  assert.deepEqual(deepBusy.rows.map((r) => r[0]), ['Busy pool']); assert.equal(deepBusy.move, null);
  // no record, or a stale one: the depth alone, as before
  for (const a of [null, undefined, act({ at: NOW - 60 * MIN }), act({ since: NOW - 5 * MIN })]) {
    const n = poolNote(17.5, a, NOW);
    assert.deepEqual(n.rows, [smallPool(17.5).row]); assert.equal(n.time, ', longer if the pool trades meanwhile');
  }
  assert.equal(poolNote(null, act(), NOW).rows[0][0], 'Busy pool', 'a pool whose size is not known is still told its moves');
  assert.equal(poolNote(null, null, NOW), null);
  assert.equal(poolNote(17.5, act()).rows.length >= 1, true, 'now defaults to the clock');
}
console.log('pool-hint: all checks passed');
