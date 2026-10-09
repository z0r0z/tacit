// Route search and direct quote in dapp/tacit.js (findSwapRoutePath / previewSwapRoute):
//   - a route never uses the same pool twice (the guest rejects a repeated pool) and never hops straight back;
//   - the direct quote takes the best of every pool for the pair, whatever order the list has;
//   - a dense pool graph is searched within a bounded number of curve evaluations.
//
// Run: node tests/amm-route-search.test.mjs

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const { previewSwapRoute, findSwapRoutePath } = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};
const id = (n) => n.toString(16).padStart(2, '0').repeat(32);
const pool = (pid, a, b, ra, rb, fee = 30) => ({
  pool_id: id(pid), asset_a: a < b ? a : b, asset_b: a < b ? b : a,
  reserve_a: String(a < b ? ra : rb), reserve_b: String(a < b ? rb : ra), fee_bps: fee, validation: 'verified',
});

const A = id(0x10), B = id(0x20), C = id(0x30);

console.log('Route search:');
{
  // Two A/B pools and a deep B/C pool: A → B → A → B → C would reuse nothing but hops straight back; a
  // shallow second B/C pool tempts a route through the same pool twice.
  const pools = [
    pool(1, A, B, 1_000_000, 1_000_000), pool(2, A, B, 900_000, 1_100_000),
    pool(3, B, C, 5_000_000, 5_000_000), pool(4, B, C, 10_000, 10_000),
  ];
  const r = findSwapRoutePath({ assetInHex: A, assetOutHex: C, amountIn: 50_000n, pools });
  const ids = r.hops.map(h => h.poolId);
  ok('a route is found', !!r && r.hops.length >= 2);
  ok('no pool appears twice on the route', new Set(ids).size === ids.length, ids.join(','));
  let back = false;
  let at = A;
  for (const h of r.hops) {
    const p = pools.find(x => x.pool_id === h.poolId);
    const next = h.direction === 0 ? p.asset_b : p.asset_a;
    if (next === at) back = true;
    at = next;
  }
  ok('the route ends at the output asset', at === C);
  ok('the route never returns to the asset it just left', !back);
  ok('the B→C hop takes the deeper pool', ids.includes(id(3)) && !ids.includes(id(4)));
}

{
  // A dense graph: 12 assets, every pair joined by two pools. The search stays bounded and still routes.
  const assets = Array.from({ length: 12 }, (_, i) => id(0x40 + i));
  const pools = [];
  let n = 0x80;
  for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) {
    pools.push(pool(n++, assets[i], assets[j], 1_000_000 + i, 1_000_000 + j));
    pools.push(pool(n++, assets[i], assets[j], 2_000_000 + j, 2_000_000 + i, 100));
  }
  const t0 = Date.now();
  const r = findSwapRoutePath({ assetInHex: assets[0], assetOutHex: assets[11], amountIn: 10_000n, pools });
  const ms = Date.now() - t0;
  ok(`a dense graph (${pools.length} pools) routes within the search bound (${ms} ms)`, !!r && ms < 2000);
  ok('dense-graph route has no repeated pool', !!r && new Set(r.hops.map(h => h.poolId)).size === r.hops.length);
}

console.log('\nDirect quote:');
{
  const shallow = pool(5, A, B, 10_000, 10_000, 30);
  const deep = pool(6, A, B, 10_000_000, 10_000_000, 30);
  const highFee = pool(7, A, B, 10_000_000, 10_000_000, 1000);
  for (const order of [[shallow, deep, highFee], [highFee, deep, shallow], [deep, shallow, highFee]]) {
    const q = previewSwapRoute({ fromAid: A, toAid: B, amountIn: 5_000n, pools: order });
    ok(`best pool for the pair is quoted (list order ${order.map(p => p.pool_id.slice(0, 2)).join(',')})`,
      q && q.kind === 'direct' && q.pool.pool_id === deep.pool_id, q && q.pool && q.pool.pool_id.slice(0, 2));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
