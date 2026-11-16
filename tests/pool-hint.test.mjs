// dapp/pool-hint.js, what a deposit's receipt says of a pool thin enough that a trade can land while the deposit is being proved: how far a 0.1 ETH trade moves it, for pools
// that a small trade does move, and nothing for the rest.
//   node tests/pool-hint.test.mjs
import assert from 'node:assert/strict';
import { smallPool, TRADE_ETH, SHOW_AT, TIP } from '../dapp/pool-hint.js';

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
console.log('pool-hint: all checks passed');
