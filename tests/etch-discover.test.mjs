// dapp/etch/find.js and eth.js's list: the order the registry's assets are shown in, and the factory's record read in spans the free nodes take.
//   node tests/etch-discover.test.mjs        (Node 22)
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
const { normalize } = await import('../dapp/etch/find.js');
const { listEtches, DEPLOY_BLOCK, FACTORY, POOL } = await import('../dapp/etch/eth.js');

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok' : 'FAIL'}  ${m}`); c ? pass++ : fail++; };
const id = (n) => String(n).padStart(64, '0');

// the registry gives some assets no height: they are placed by when they were etched, not read as the newest
{
  const list = normalize([
    { asset_id: id(1), ticker: 'OLD', etched_at: 1000, etched_at_height: null },
    { asset_id: id(2), ticker: 'NEW', etched_at: 3000, etched_at_height: 900 },
    { asset_id: id(3), ticker: 'MID', etched_at: 2000 },
    { asset_id: id(4), ticker: 'TIG', etched_at: 1500, etched_at_height: 800 },
    { asset_id: id(5), ticker: 'TIG', etched_at: 1400 },
  ]);
  ok(list.map((a) => a.ticker).join() === 'NEW,MID,TIG,TIG,OLD', 'newest first, an asset without a height among them by its time');
  const tig = list.filter((a) => a.ticker === 'TIG');
  ok(tig[0].id === id(4) && tig[0].later && !tig[1].later, 'of one ticker, the earlier etch is the first one, height or not');
}

// the factory's record: read from its deploy block to the head in spans, nothing past the head, the pool's own tokens left out
{
  const head = DEPLOY_BLOCK + 123_456, asked = [];
  const pad = (h, n = 64) => h.replace(/^0x/, '').padStart(n, '0');
  const symbol = Buffer.from('ZED').toString('hex');
  const data = '0x' + pad('0') + pad((18).toString(16)) + pad('0') + pad('3') + symbol.padEnd(64, '0');
  const log = (block, minter, token) => ({ blockNumber: '0x' + block.toString(16), transactionHash: '0x' + 'ab'.repeat(32), topics: ['0x0', '0x0', '0x' + pad(token), '0x' + pad(minter)], data });
  const read = async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + head.toString(16);
    if (m === 'eth_getLogs') {
      const f = parseInt(p[0].fromBlock, 16), t = parseInt(p[0].toBlock, 16);
      asked.push([f, t]);
      if (p[0].address !== FACTORY) throw new Error('wrong address');
      if (t - f + 1 > 50_000) throw new Error('exceed maximum block range: 50000');
      const out = [];
      if (f <= DEPLOY_BLOCK + 10 && DEPLOY_BLOCK + 10 <= t) out.push(log(DEPLOY_BLOCK + 10, POOL, '0x' + '11'.repeat(20)));
      if (f <= DEPLOY_BLOCK + 60_000 && DEPLOY_BLOCK + 60_000 <= t) out.push(log(DEPLOY_BLOCK + 60_000, '0x' + '22'.repeat(20), '0x' + '33'.repeat(20)));
      return out;
    }
    if (m === 'eth_call') return '0x' + pad((5n * 10n ** 18n).toString(16));
    if (m === 'eth_getBlockByNumber') return { timestamp: '0x6000' };
    throw new Error(m);
  };
  const list = await listEtches(read, []);
  asked.sort((x, y) => x[0] - y[0]);
  ok(asked.length === 3 && asked[0][0] === DEPLOY_BLOCK && asked.at(-1)[1] === head, 'three spans from the deploy block to the head');
  ok(asked.every(([f, t], i) => t - f + 1 <= 50_000 && (i === 0 || f === asked[i - 1][1] + 1)), 'each within 50,000 blocks, none missed or read twice');
  ok(list.length === 1 && list[0].ticker === 'ZED' && list[0].id === '0x' + '33'.repeat(20) && list[0].supply === 5n * 10n ** 18n, 'what the pool minted is left out, an etch is read with its symbol and supply');
  let threw = false;
  try { await listEtches(async (m) => { if (m === 'eth_blockNumber') return '0x' + head.toString(16); throw new Error('every node refused'); }, []); } catch { threw = true; }
  ok(threw, 'a span that no node reads fails the list (the page says so), never an empty list');
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
