// The settle relay's market pass (worker-relay/src/lib/market-solver.js) with the chain and the prover stubbed. Run: node --test tests/proof-market-solver.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMarketSolver, marketHasRoom } from '../worker-relay/src/lib/market-solver.js';

const drain = () => new Promise((r) => setImmediate(r));
// the proof is made in the background: one pass starts it, a later one (once it is back) claims and fulfils
const run = async (s) => { let w = await s.pass(); if (!w) { await drain(); await drain(); w = await s.pass(); } return w; };
const ME = '0x' + '77'.repeat(20), OTHER = '0x' + '88'.repeat(20);
const mk = (id, extra = {}) => ({ publicValues: '0x', intent: { opId: id, payer: '0x' + 'cd'.repeat(20), floorFee: '1000', maxFee: '5000', start: '1000', rampSecs: '0', deadline: '9000', ...extra } });
function rig({ orders, doneSet = new Set(), holder = {}, proveMs = 0, claimLapses = false, deposit = 1 } = {}) {
  let t = 2_000_000; // ms
  const calls = [], cleared = [], claims = { ...holder };
  const s = makeMarketSolver({
    me: ME, now: () => t, retryMs: 120_000,
    listOrders: async () => orders,
    depositStatus: async () => deposit,
    done: async (id) => doneSet.has(id),
    claimOf: async (id) => claims[id] || null,
    claim: async (o) => { calls.push(['claim', o.intent.opId]); claims[o.intent.opId] = { solver: ME, until: claimLapses ? 1 : 3000 }; return '0xc1'; },
    prove: async (o) => { calls.push(['prove', o.intent.opId]); t += proveMs; return { publicValues: '0x01', proof: '0x02' }; },
    fulfil: async (o) => { calls.push(['fulfil', o.intent.opId]); return '0xf1'; },
    clear: async (id) => { cleared.push(id); },
  });
  return { s, calls, cleared, tick: (ms) => { t += ms; } };
}

test('claims and proves an open order together, then fulfils and clears it', async () => {
  const r = rig({ orders: [mk('0xa')] });
  assert.equal(await run(r.s), true);
  assert.deepEqual(r.calls.map((c) => c[0]).sort(), ['claim', 'fulfil', 'prove']);
  assert.equal(r.calls.at(-1)[0], 'fulfil', 'the fulfil goes last');
  assert.deepEqual(r.cleared, ['0xa']);
});

test('leaves an order another prover holds, one already settled (and clears it), and one too near its deadline or below the price floor', async () => {
  const r = rig({ orders: [mk('0xb'), mk('0xc'), mk('0xd', { deadline: '2010' }), mk('0xe')], doneSet: new Set(['0xc']), holder: { '0xb': { solver: OTHER, until: 3000 } } });
  assert.equal(await run(r.s), true, 'the last one is taken');
  assert.deepEqual(r.calls.filter((c) => c[0] === 'claim').map((c) => c[1]), ['0xe']);
  assert.deepEqual([...new Set(r.cleared)], ['0xc', '0xe'], 'a settled order is cleared (more than once is harmless)');
  const low = rig({ orders: [mk('0xf')] });
  const s2 = makeMarketSolver({ me: ME, depositStatus: async () => 1, now: () => 2_000_000, minPrice: 9000n, listOrders: async () => [mk('0xf')], done: async () => false, claimOf: async () => null, claim: async () => { throw new Error('no'); }, prove: async () => ({}), fulfil: async () => {}, clear: async () => {} });
  assert.equal(await s2.pass(), false, 'below the price the relay will work for');
  void low;
});

test('an order that two claims did not settle is left to expire (a claim costs gas), and the proof it made is kept between tries', async () => {
  let t = 2_000_000, proves = 0, claims = 0;
  const s = makeMarketSolver({ me: ME, now: () => t, retryMs: 120_000, sleep: async (ms) => { t += ms; }, depositStatus: async () => 1, listOrders: async () => [mk('0xg')], done: async () => false, claimOf: async () => null,
    claim: async () => { claims++; return '0xc'; }, prove: async () => { proves++; return { proof: '0x' }; }, fulfil: async () => { throw new Error('reverted'); }, clear: async () => {} });
  assert.equal(await run(s), true, 'first claim');
  t += 11_000;
  assert.equal(await s.pass(), true, 'a second claim, shortly after, with the proof it already has');
  t += 11_000;
  assert.equal(await s.pass(), false, 'no third claim');
  t += 400_000;
  assert.equal(await s.pass(), false, 'and not later either');
  assert.deepEqual([claims, proves], [2, 1]);
});

test('proving is budgeted per payer and for the board as a whole, so junk orders cannot drain the prover', async () => {
  let proves = 0, t = 2_000_000;
  const orders = Array.from({ length: 10 }, (_, i) => ({ publicValues: '0x', intent: { opId: '0x' + String(i).padStart(2, '0'), payer: '0x' + 'ab'.repeat(20), floorFee: '1', maxFee: '5', start: '1000', rampSecs: '0', deadline: '9000' } }));
  const s = makeMarketSolver({ me: ME, now: () => t, perPayerHour: 3, depositStatus: async () => 0, listOrders: async () => orders, done: async () => false, claimOf: async () => null,
    claim: async () => '0x', prove: async () => { proves++; return { proof: '0x' }; }, fulfil: async () => '0x', clear: async () => {} });
  for (let i = 0; i < 12; i++) { await s.pass(); await drain(); await drain(); }
  assert.equal(proves, 3, 'one payer gets three proofs an hour, however many orders it posts');
  t += 3_700_000;
  for (let i = 0; i < 4; i++) { await s.pass(); await drain(); await drain(); }
  assert.ok(proves > 3, 'and its budget comes back an hour on');
});

test('a failure in the proof is logged and the order waits out the retry gap; the board being down is not an error', async () => {
  const logs = [];
  const s = makeMarketSolver({ me: ME, depositStatus: async () => 1, now: () => 2_000_000, log: (m) => logs.push(m), listOrders: async () => [mk('0xh')], done: async () => false, claimOf: async () => null,
    claim: async () => '0x1', prove: async () => { throw new Error('the prover is out of credit'); }, fulfil: async () => {}, clear: async () => {} });
  assert.equal(await s.pass(), false, 'the proof starts in the background');
  await drain(); await drain();
  assert.equal(await s.pass(), false);
  assert.match(logs.join('\n'), /out of credit/);
  assert.equal(await s.pass(), false, 'not tried again at once');
  const down = makeMarketSolver({ me: ME, depositStatus: async () => 1, listOrders: async () => { throw new Error('502'); }, done: async () => false, claimOf: async () => null, claim: async () => {}, prove: async () => {}, fulfil: async () => {}, clear: async () => {} });
  assert.equal(await down.pass(), false);
});

test('a fulfil that fails because the deposit has not landed is tried again while the claim lasts, then given up', async () => {
  let t = 2_000_000, tries = 0;
  const mkS = (okAt) => makeMarketSolver({ me: ME, depositStatus: async () => 1, now: () => t, sleep: async (ms) => { t += ms; }, listOrders: async () => [mk('0xi')], done: async () => false,
    claimOf: async () => ({ solver: ME, until: 2040 }), claim: async () => '0x1', prove: async () => ({ proof: '0x' }), clear: async () => {},
    fulfil: async () => { tries++; if (tries < okAt) throw new Error('deposit missing'); return '0xf'; } });
  assert.equal(await run(mkS(3)), true);
  assert.equal(tries, 3, 'landed on the third try');
  tries = 0; t = 2_000_000;
  assert.equal(await run(mkS(99)), true);
  assert.ok(tries >= 3 && tries < 20, 'stopped before the claim ended');
});

test('an order whose deposit never lands is proved but never claimed (a claim costs gas); one proof at a time; it is claimed once the deposit is pending', async () => {
  let deposit = 0;
  const r = rig({ orders: [mk('0xj'), mk('0xk')], deposit: 0 });
  const s = makeMarketSolver({ me: ME, now: () => 2_000_000, listOrders: async () => [mk('0xj'), mk('0xk')], done: async () => false, claimOf: async () => null,
    depositStatus: async () => deposit, claim: async (o) => { r.calls.push(['claim', o.intent.opId]); return '0xc'; }, prove: async (o) => { r.calls.push(['prove', o.intent.opId]); await new Promise((x) => setTimeout(x, 5)); return { proof: '0x' }; },
    fulfil: async () => '0xf', clear: async () => {} });
  r.calls.length = 0;
  assert.equal(await s.pass(), false);
  assert.equal(s.hasOpen(), true, 'an order waiting on its deposit keeps the relay looking every few seconds');
  assert.deepEqual(r.calls, [['prove', '0xj']], 'proving starts at once, for one order only');
  assert.equal(await s.pass(), false, 'no deposit, no claim');
  assert.ok(!r.calls.some((c) => c[0] === 'claim'));
  deposit = 1;
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(await s.pass().catch(() => 'threw'), true);
  assert.ok(r.calls.some((c) => c[0] === 'claim' && c[1] === '0xj'), 'claimed once the deposit was pending');
});

test('the least price can be a function (the relay prices gas and proving each pass): an order under it is left, one over it is taken, and a pricing failure takes nothing', async () => {
  const mk2 = (floor) => makeMarketSolver({ me: ME, now: () => 2_000_000, depositStatus: async () => 1, minPrice: async () => floor, listOrders: async () => [mk('0xm', { floorFee: '1000', maxFee: '5000', rampSecs: '60', start: '1990' })],
    done: async () => false, claimOf: async () => null, claim: async () => '0xc', prove: async () => ({ proof: '0x' }), fulfil: async () => '0xf', clear: async () => {} });
  assert.equal(await mk2(9000n).pass(), false, 'above anything the order can pay');
  assert.equal(await run(mk2(1500n)), true, 'under what the price will be by the time the claim lands');
  const broken = makeMarketSolver({ me: ME, now: () => 2_000_000, depositStatus: async () => 1, minPrice: async () => { throw new Error('no TAC quote'); }, listOrders: async () => [mk('0xn')],
    done: async () => false, claimOf: async () => null, claim: async () => { throw new Error('must not claim'); }, prove: async () => ({}), fulfil: async () => {}, clear: async () => {} });
  assert.equal(await broken.pass(), false);
});

test('an order whose deposit has landed is worked before older ones that have none, and the newest of those before the oldest', async () => {
  const started = [];
  const orders = [mk('0xold', { deadline: '5000' }), mk('0xnew', { deadline: '8000' }), mk('0xdep', { deadline: '6000' })];
  const s = makeMarketSolver({ me: ME, now: () => 2_000_000, depositStatus: async (id) => (id === '0x' + '' ? 0 : 0), listOrders: async () => orders, done: async () => false, claimOf: async () => null,
    claim: async () => '0x', prove: async (o) => { started.push(o.intent.opId); await new Promise((x) => setTimeout(x, 50)); return { proof: '0x' }; }, fulfil: async () => '0x', clear: async () => {} });
  await s.pass();
  assert.equal(started[0], '0xnew', 'with no deposit anywhere, the newest first');
  // a deposit that has landed outranks everything
  const started2 = [];
  const dep = (o) => '0x' + (o.intent.opId === '0xdep' ? '11' : '22').repeat(32);
  const orders2 = orders.map((o) => ({ ...o, publicValues: '0x' + '00'.repeat(36 * 32) + dep(o).slice(2) }));
  const s2 = makeMarketSolver({ me: ME, now: () => 2_000_000, depositStatus: async (id) => (id === '0x' + '11'.repeat(32) ? 1 : 0), listOrders: async () => orders2, done: async () => false, claimOf: async () => null,
    claim: async () => '0x', prove: async (o) => { started2.push(o.intent.opId); await new Promise((x) => setTimeout(x, 50)); return { proof: '0x' }; }, fulfil: async () => '0x', clear: async () => {} });
  await s2.pass();
  assert.equal(started2[0], '0xdep');
});

test('no new proof is begun while the relay is busy with its own queue, and one is begun once it is not', async () => {
  let busyNow = true, proves = 0;
  const s = makeMarketSolver({ me: ME, now: () => 2_000_000, canStart: () => !busyNow, depositStatus: async () => 0, listOrders: async () => [mk('0xq')], done: async () => false, claimOf: async () => null,
    claim: async () => '0x', prove: async () => { proves++; return { proof: '0x' }; }, fulfil: async () => '0x', clear: async () => {} });
  await s.pass(); await s.pass();
  assert.equal(proves, 0, 'held back while the relay works its own jobs');
  busyNow = false;
  await s.pass();
  assert.equal(proves, 1);
});

test('a proof is kept when its order briefly drops off the board, and not made again', async () => {
  let listed = true, proves = 0, t = 2_000_000;
  const s = makeMarketSolver({ me: ME, now: () => t, depositStatus: async () => 0, listOrders: async () => (listed ? [mk('0xr')] : []), done: async () => false, claimOf: async () => null,
    claim: async () => '0x', prove: async () => { proves++; return { proof: '0x' }; }, fulfil: async () => '0x', clear: async () => {} });
  await s.pass(); await drain(); await drain();
  listed = false; await s.pass(); t += 60_000;
  listed = true; await s.pass();
  assert.equal(proves, 1, 'proved once');
});

test('a claim send that errors but landed on chain is not called failed: the fulfil goes ahead; one that did not land is', async () => {
  let landed = true, fulfils = 0, t = 2_000_000;
  const mkS = () => makeMarketSolver({ me: ME, now: () => t, sleep: async () => {}, depositStatus: async () => 1, listOrders: async () => [mk('0xs')], done: async () => false,
    claimOf: async () => (landed && fulfils === 0 && claimedOnce ? { solver: ME, until: 2000 + 60 } : null),
    claim: async () => { claimedOnce = true; throw new Error('HTTP request failed'); }, prove: async () => ({ proof: '0x' }), fulfil: async () => { fulfils++; return '0xf'; }, clear: async () => {} });
  let claimedOnce = false;
  const s = mkS();
  assert.equal(await run(s), true);
  assert.equal(fulfils, 1, 'the claim was on chain, so it was fulfilled');
  landed = false; claimedOnce = false; fulfils = 0;
  const s2 = mkS();
  assert.equal(await run(s2), true);
  assert.equal(fulfils, 0, 'a claim that is not on chain stops there');
});

test('the market spends only what the settle wallet holds above the relay\'s own floor: below it, relayed jobs come first and no order is taken', () => {
  const gasPrice = 700_000_000n, orderGas = 828_000n, need = 900_000_000_000_000n;            // 0.7 gwei; a settle's worst case 0.0009 ETH
  const order = (orderGas * gasPrice * 15n) / 10n;                                            // about 0.00087 ETH with the margin
  assert.equal(marketHasRoom({ held: 640_000_000_000_000n, need, orderGas, gasPrice }), false, 'the wallet is under its own floor: the market is off');
  assert.equal(marketHasRoom({ held: need + order - 1n, need, orderGas, gasPrice }), false, 'the floor kept and one order short: off');
  assert.equal(marketHasRoom({ held: need + order, need, orderGas, gasPrice }), true, 'the floor kept with an order on top: on');
  assert.equal(marketHasRoom({ held: 10n ** 18n, need, orderGas, gasPrice }), true);
});
