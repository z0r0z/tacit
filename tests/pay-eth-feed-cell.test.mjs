// tacit pay keeps the pool's whole history for its activity view, read from the keeper's feed by a loop of the page's own. The
// page's source is run here with the modules it leans on stubbed: a page that has been away starts its first request at the start
// of the cell its stored place falls in, a page that is current (within ten minutes of the tip) starts at the place itself and is
// sent only what is new, a page that ends before the place is passed over, and what the page already holds is not added twice.
//   node tests/pay-eth-feed-cell.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { feedStart } from '../dapp/evm-pool-wallet.js';

const html = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
const src = html.match(/^async function poolEvents\([\s\S]*?^}$/m)?.[0];
assert.ok(src, 'the page has poolEvents');

const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
// One run of poolEvents on chain 1 (a cell is 7,200 blocks): the history held up to `through` (none when null), the keeper's
// events `chain`, its pages `page` blocks long, and the chain tip.
function run({ deployBlock = 1_000, through = null, held = [], tip, page = Infinity, chain }) {
  const asked = [], q = { gen: 0, base: through === null ? null : { through, src: 'index', evs: held, saved: held.length } };
  const ctx = vm.createContext({
    evq: () => q, S: { chainOnly: false }, chainKeeper: () => 'https://k.test', storedEvents: async () => null,
    mods: async () => ({ feedStart }), lc: (x) => String(x).toLowerCase(), POOL, ROUTER: '0x0', T_TRANSACT: 't', T_RECEIVED: 'r',
    fromFeed: (e) => e, saveEvents: async () => true,
    indexPage: async (_c, from) => {
      asked.push(from);
      const th = Math.min(tip, from + page - 1);
      return { chainId: 1, pool: POOL, through: th, events: chain.filter((e) => e.block >= from && e.block <= th) };
    },
    logs: async () => { throw new Error('the chain-log scan should not be needed'); },
    decodeTransact: () => { throw new Error('unused'); }, decodeReceived: () => { throw new Error('unused'); },
  });
  const poolEvents = vm.runInContext(`(${src})`, ctx);
  return poolEvents({ chainId: 1, deployBlock, confirmations: 0 }, null, tip, null, async () => {}, () => {}).then((r) => ({ blocks: Array.from(r.evs, (e) => e.block), source: r.source, asked }));
}

const ev = (block) => ({ kind: 'transact', block });
const chain = [1_500, 16_000, 19_000, 20_500, 24_000].map(ev);
const held = [1_500, 16_000, 19_000].map(ev);
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

await check('a page with a stored place asks from the start of that place\'s cell and adds only what is new', async () => {
  const one = await run({ through: 20_000, held, tip: 30_000, chain });
  assert.deepEqual(one.asked, [15_400], 'from 20,001 the cell starts at 1,000 + 2 x 7,200');
  assert.deepEqual(one.blocks, [1_500, 16_000, 19_000, 20_500, 24_000], 'the events the page held are not added again');
  assert.equal(one.source, 'index');
});

await check('a page that ends before the stored place is passed over, and the next request starts where it ended', async () => {
  const pages = await run({ through: 20_000, held, tip: 30_000, page: 2_000, chain });
  assert.deepEqual(pages.asked, [15_400, 17_400, 19_400, 21_400, 23_400, 25_400, 27_400, 29_400]);
  assert.deepEqual(pages.blocks, [1_500, 16_000, 19_000, 20_500, 24_000], 'the same history as one page gives');
});

await check('two stored places in one cell ask from the same block, and a new page asks from the pool\'s first block', async () => {
  const a = await run({ through: 16_000, held: held.slice(0, 2), tip: 30_000, chain });
  const b = await run({ through: 20_000, held, tip: 30_000, chain });
  assert.equal(a.asked[0], 15_400);
  assert.equal(b.asked[0], 15_400);
  assert.deepEqual(a.blocks, b.blocks, 'and both end with the same history');
  const fresh = await run({ tip: 30_000, chain });
  assert.equal(fresh.asked[0], 1_000);
  assert.deepEqual(fresh.blocks, [1_500, 16_000, 19_000, 20_500, 24_000]);
});

await check('a page whose stored place is within ten minutes of the tip asks from the place itself and is sent only what is new', async () => {
  const near = [...chain, ev(29_995)];
  const cur = await run({ through: 29_990, held: chain, tip: 30_000, chain: near });
  assert.deepEqual(cur.asked, [29_991], 'a poll asks for nothing it already holds');
  assert.deepEqual(cur.blocks, [1_500, 16_000, 19_000, 20_500, 24_000, 29_995], 'and adds the one new event');
  const quiet = await run({ through: 29_999, held: chain, tip: 30_000, chain });
  assert.deepEqual(quiet.asked, [30_000]);
  assert.deepEqual(quiet.blocks, [1_500, 16_000, 19_000, 20_500, 24_000]);
});

await check('ten minutes of blocks is the edge: 50 behind the tip is current on Ethereum, 51 asks from the cell', async () => {
  const edge = await run({ through: 29_949, held: chain, tip: 30_000, chain });
  assert.deepEqual(edge.asked, [29_950], 'the tip is 50 blocks on');
  const past = await run({ through: 29_948, held: chain, tip: 30_000, chain });
  assert.deepEqual(past.asked, [29_800], 'the tip is 51 blocks on: the cell that 29,949 falls in starts at 1,000 + 4 x 7,200');
  assert.deepEqual(edge.blocks, past.blocks, 'both end with the same history');
});

console.log(`\n${n} checks passed`);
