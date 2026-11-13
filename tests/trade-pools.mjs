#!/usr/bin/env node
// dapp/trade/pools.js: the Ethereum pools read as an order book. The Precision pool's part against what its own lens quoted at one mainnet block
// (tests/fixtures/precision-curve-2026-11-13.json: the pool's price, range and reserves, and the quotes for a few sizes each way), then the arithmetic
// of a level, of two pools added up, and of the amount a row hands the ticket.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { precisionPool, tacitPool, askOf, bidOf, buyTo, sellTo, poolBook, perLevel, roundDown, LADDER_STEPS, CHART_STEPS } from '../dapp/trade/pools.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const fx = JSON.parse(readFileSync(new URL('./fixtures/precision-curve-2026-11-13.json', import.meta.url)));
const near = (a, b, rel, what) => assert.ok(Math.abs(a / b - 1) <= rel, `${what}: ${a} against ${b} (${((a / b - 1) * 1e4).toFixed(2)} bps apart, ${rel * 1e4} allowed)`);

// What a pool pays for an amount in: the curve the levels are cut from, written out the plain way.
const out = (p, x, y, amount) => { const a = amount * (1 - p.fee); return (y * a) / (x + a); };

// ── the Precision pool, against its lens ──
{
  const p = precisionPool({ ...fx, feePpm: fx.buys[0][2] });
  assert.ok(p && p.name === 'precision' && p.fee === 0.003);
  near(p.y / p.x, (Number(fx.sqrt) / 1e18) ** 2, 1e-12, 'the reserves the curve runs on stand at the pool’s price');
  assert.ok(p.x > Number(fx.reserve0) / 1e18 && p.y > Number(fx.reserve1) / 1e18, 'and are larger than what it holds (its range is finite)');
  for (const [wei, got] of fx.buys) near(out(p, p.x, p.y, Number(wei) / 1e18), Number(got) / 1e18, 0.002, `buying with ${Number(wei) / 1e18} ETH`);
  for (const [wei, got] of fx.sells) near(out(p, p.y, p.x, Number(wei) / 1e18), Number(got) / 1e18, 0.002, `selling ${Number(wei) / 1e18} TAC`);
  ok(`the Precision pool, from its price, range and reserves, pays what its lens quoted (${fx.buys.length} purchases and ${fx.sells.length} sales within 0.2%)`);
  assert.equal(precisionPool({ ...fx, sqrt: fx.low }), null); assert.equal(precisionPool({ ...fx, sqrt: String(BigInt(fx.high) + 1n) }), null); assert.equal(precisionPool({ ...fx, reserve0: '0' }), null);
  ok('a pool at or past the end of its range, or holding nothing of one side, is left out');
}

// ── one level of one pool ──
{
  const p = precisionPool(fx);
  const ask = askOf(p), bid = bidOf(p);
  near(ask / bid, 1 / (1 - p.fee) ** 2, 1e-12, 'ask over bid is the fee, twice');
  assert.deepEqual(buyTo(p, ask), { tac: 0, eth: 0 }); assert.deepEqual(sellTo(p, bid), { tac: 0, eth: 0 }); assert.deepEqual(buyTo(p, ask * 0.9), { tac: 0, eth: 0 });
  ok('at its own price a pool sells and takes nothing, and nothing under its ask');
  for (const step of [0.01, 0.05, 0.25]) {
    const b = buyTo(p, ask * (1 + step));
    near(out(p, p.x, p.y, b.eth), b.tac, 1e-9, `the TAC a level names is what its ETH buys (+${step * 100}%)`);
    // the price for the next TAC once that much is bought is the level's own
    const x1 = p.x + b.eth * (1 - p.fee), k = p.x * p.y;
    near((x1 * x1) / (k * (1 - p.fee)), ask * (1 + step), 1e-9, 'and it leaves the pool at the level’s price');
    const s = sellTo(p, bid * (1 - step));
    near(out(p, p.y, p.x, s.tac), s.eth, 1e-9, `the ETH a level names is what its TAC sells for (−${step * 100}%)`);
    const y1 = p.y + s.tac * (1 - p.fee);
    near(((1 - p.fee) * k) / (y1 * y1), bid * (1 - step), 1e-9, 'and it leaves the pool at the level’s price');
  }
  ok('a level holds exactly what moves the pool to its price, bought or sold');
  const small = { ...p, capY: 1000, capX: 0.1 };
  assert.ok(buyTo(small, ask * 50).tac <= 1000 + 1e-9 && sellTo(small, bid / 50).eth <= 0.1 + 1e-12);
  ok('a pool never sells more TAC, or pays more ETH, than it holds');
}

// ── two pools added up ──
{
  const a = precisionPool(fx), t = tacitPool({ rEth: 12n * 10n ** 8n, rTac: 78000n * 10n ** 8n, feeBps: 30 });
  assert.ok(t && t.name === 'tacit' && t.fee === 0.003 && t.x === 12 && t.y === 78000);
  assert.equal(tacitPool({ rEth: 0n, rTac: 5n, feeBps: 30 }), null);
  const both = poolBook([a, t]), alone = poolBook([a]);
  assert.equal(both.ask, Math.min(askOf(a), askOf(t))); assert.equal(both.bid, Math.max(bidOf(a), bidOf(t)));
  ok('the book’s best prices are the cheaper pool’s ask and the dearer pool’s bid');
  for (const side of ['asks', 'bids']) {
    const L = both[side];
    assert.ok(L.length >= 8 && L.every((l, i) => i === 0 || (l.tac > L[i - 1].tac && l.eth > L[i - 1].eth)), `${side} grow level by level`);
    assert.ok(L.every((l, i) => i === 0 || (side === 'asks' ? l.price > L[i - 1].price : l.price < L[i - 1].price)), `${side} run away from the best price`);
  }
  ok('levels are running totals: each holds more than the one before it, further from the best price');
  // a level is the two pools taken to one price, so it is each pool's own level at that price, added
  const lvl = both.asks[4], parts = [a, t].map((p) => buyTo(p, lvl.price));
  near(lvl.tac, parts[0].tac + parts[1].tac, 1e-12, 'a level’s TAC'); near(lvl.eth, parts[0].eth + parts[1].eth, 1e-12, 'a level’s ETH');
  // and no other way of spending that ETH across the two buys more: the split at one price is the best one
  const spend = lvl.eth, best = lvl.tac;
  for (const share of [0, 0.2, 0.4, 0.6, 0.8, 1]) assert.ok(out(a, a.x, a.y, spend * share) + out(t, t.x, t.y, spend * (1 - share)) <= best * (1 + 1e-9), `no ${share * 100}/${100 - share * 100} split beats it`);
  ok('a level is what the best split of its amount gets: both pools left at one price');
  assert.ok(both.asks[4].tac > alone.asks[4].tac && both.bids[4].eth > alone.bids[4].eth);
  ok('two pools hold more at a price than one');
  const cheap = tacitPool({ rEth: 10n * 10n ** 8n, rTac: 80000n * 10n ** 8n, feeBps: 30 }), mixed = poolBook([a, cheap]);
  assert.ok(askOf(cheap) < askOf(a));
  const first = mixed.asks[0], only = buyTo(cheap, first.price);
  assert.ok(buyTo(a, first.price).tac === 0 && Math.abs(first.tac - only.tac) < 1e-9);
  ok('with one pool cheaper, the first levels are that pool’s alone, until the price reaches the other');
  assert.equal(poolBook([null, null]), null); assert.equal(poolBook([]), null);
  assert.ok(poolBook([null, t]).asks.length > 0);
  ok('one pool unread still makes a book of the other; none, no book');
}

// ── what a chart and a ticket take from it ──
{
  const b = poolBook([precisionPool(fx)], CHART_STEPS), per = perLevel(b.asks);
  near(per.reduce((s, l) => s + l.dTac, 0), b.asks.at(-1).tac, 1e-12, 'what each level adds, added up, is the last total');
  assert.ok(per.every((l) => l.dTac > 0 && l.dEth > 0));
  assert.ok(b.bids.every((l) => l.step < 1 && l.price > 0));
  assert.ok(LADDER_STEPS.every((s, i) => i === 0 || s > LADDER_STEPS[i - 1]) && CHART_STEPS.length >= 40);
  ok('the chart’s finer levels add up to the same totals, and no bid is at or under nothing');
  assert.equal(roundDown(0.465678), '0.4656'); assert.equal(roundDown(1.3769), '1.376'); assert.equal(roundDown(0.0419349), '0.04193'); assert.equal(roundDown(13402.7), '13402');
  assert.equal(roundDown(288.25), '288.2'); assert.equal(roundDown(5), '5'); assert.equal(roundDown(0), '0'); assert.equal(roundDown(NaN), '0'); assert.equal(roundDown(0.5), '0.5');
  for (const v of [0.123456, 7.77777, 999.999, 43210.9]) assert.ok(Number(roundDown(v)) <= v && Number(roundDown(v)) > v * 0.999);
  ok('an amount handed to the ticket is cut to four figures and never rounded up past what the level holds');
}

console.log(`\n${n} trade-pools checks passed`);
