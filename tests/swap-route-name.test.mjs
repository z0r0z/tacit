#!/usr/bin/env node
// What the swap card's Route row says for a swap inside Tacit's pool, the way out of it and ETH through the Pay pool (dapp/swap/route-name.js): the coins
// crossed under the pool's name, the exit and the sale that pays a token, and nothing for a deposit that swaps nothing.
//
// Run: node tests/swap-route-name.test.mjs

import assert from 'node:assert';
import { privateRoute, hopRoute, routeLine, ROUTE_TIPS } from '../dapp/swap/route-name.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

const SYM = { eth: 'tETH', tac: 'TAC', cusd: 'cUSD', cbtc: 'cBTC' };
const sym = (k) => SYM[k];
const cross = (a, b) => ({ a, b });

// ── inside the pool ──
{
  assert.strictEqual(privateRoute({ pools: [cross('eth', 'cbtc')] }, sym), 'Tacit pool · tETH → cBTC');
  assert.strictEqual(privateRoute({ pools: [cross('tac', 'eth'), cross('eth', 'cbtc')] }, sym), 'Tacit pool · TAC → tETH → cBTC', 'a swap between two coins that are not tETH crosses it');
  assert.strictEqual(privateRoute({ pools: [cross('cbtc', 'eth'), cross('eth', 'cusd')] }, sym), 'Tacit pool · cBTC → tETH → cUSD');
  assert.ok(!privateRoute({}, sym), 'a deposit that swaps nothing (ETH made private) has no route');
  assert.ok(!privateRoute({ pools: [] }, sym));
  ok('a private swap names the coins it crosses under the pool, through tETH where it has to');
}

// ── out of the pool ──
{
  assert.strictEqual(privateRoute({ pout: true }, sym), 'Out of the pool', 'tETH paid as ETH');
  assert.strictEqual(privateRoute({ pools: [cross('tac', 'eth')], pout: true }, sym), 'Tacit pool · TAC → tETH, out of the pool');
  assert.strictEqual(privateRoute({ pout: true, sale: 'Uniswap v3 0.05%' }, sym), 'Out of the pool → Uniswap v3 0.05%');
  assert.strictEqual(privateRoute({ pools: [cross('tac', 'eth')], pout: true, sale: 'Uniswap v3 0.05%' }, sym), 'Tacit pool · TAC → tETH, out of the pool → Uniswap v3 0.05%');
  ok('an exit adds the way out, and the pool that sells the ETH for a token');
}

// ── through the Pay pool ──
{
  assert.strictEqual(hopRoute('Uniswap v3 0.01%'), 'Pay pool → Uniswap v3 0.01%');
  assert.deepStrictEqual(routeLine({ r: { name: 'Uniswap v3 0.01%' }, hop: true }, sym), { text: 'Pay pool → Uniswap v3 0.01%', tip: ROUTE_TIPS.hop });
  assert.match(ROUTE_TIPS.hop, /No outside solver is asked/, 'the tip says what the hop gives up');
  ok('ETH through the Pay pool names it before the pool that sells the ETH, and its tip says no outside solver is asked');
}

// ── the row's line ──
{
  const priv = (r, pools) => routeLine({ r: { priv: true, ...r }, pools }, sym);
  assert.deepStrictEqual(priv({}, [cross('eth', 'tac')]), { text: 'Tacit pool · tETH → TAC', tip: ROUTE_TIPS.private });
  assert.deepStrictEqual(priv({ pout: true }), { text: 'Out of the pool', tip: ROUTE_TIPS.out });
  assert.deepStrictEqual(priv({ pout: true, sale: 'Curve' }), { text: 'Out of the pool → Curve', tip: ROUTE_TIPS.sale });
  assert.strictEqual(priv({}), null, 'Made private has no line');
  assert.strictEqual(routeLine({ r: { name: 'Uniswap v3 0.05%', agg: {} } }, sym), null, 'a public row is left to its own name');
  for (const t of Object.values(ROUTE_TIPS)) assert.ok(t.length < 260 && !/\s{2}/.test(t), t);
  ok('each route has its line and its tip; a public row and a plain deposit have none');
}

console.log(`\n${n} swap route checks passed.`);
