// The points a page estimates for an ETH deposit, against the program that scores it (worker-relay/src/lib/config.js,
// points-indexer.js): the pages carry the same constants, and read the TAC-holder tier the way the program does, from the
// lowest balance over the trailing 7,200 blocks.
//   node tests/points-estimate.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const cfg = read('worker-relay/src/lib/config.js'), pay = read('dapp/pay/eth/index.html'), weld = read('dapp/index.html');
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const weldTiers = new Function('return ' + weld.match(/tiers: (\[\[.*?\]\]),/)[1])();   // the TAC tiers the front page starts from, before the service's own
const def = (key, env) => Number(cfg.match(new RegExp(`${key}: num\\('${env}', ([0-9.]+)\\)`))?.[1]);

await test('the pages score 1,000 per ETH, the early bonus 1 + 4 / (1 + deposits / 200), x1.25 for a tETH wrap, x1.2 Privacy Pools', () => {
  assert.equal(def('pointsBasePerEth', 'POINTS_BASE_PER_ETH'), 1000);
  assert.equal(def('pointsBonusScale', 'POINTS_BONUS_SCALE'), 4);
  assert.equal(def('pointsBonusHalfLife', 'POINTS_BONUS_HALF_LIFE'), 200);
  assert.equal(def('tethWrapBoostMultiplier', 'TETH_WRAP_BOOST_MULTIPLIER'), 1.25);
  assert.equal(def('ppBoostMultiplier', 'PP_BOOST_MULTIPLIER'), 1.2);
  assert.ok(pay.includes('1 + 4 / (1 + n / 200)'), 'pay: the early bonus');
  assert.ok(/\* 1000 \*/.test(pay), 'pay: 1,000 points per ETH');
  // The front page takes the program's terms from the service, and starts from these.
  const pgm = weld.match(/const PGM = \{([\s\S]*?)\};\n/)?.[1] || '';
  assert.ok(/early: \{ max: 5, half: 200 \}/.test(pgm), 'weld: the early bonus 1 + 4 / (1 + deposits / 200) it starts from');
  assert.ok(weld.includes('1 + (PGM.early.max - 1) / (1 + n / PGM.early.half)'), 'weld: the early bonus formula');
  assert.ok(/evmpooldeposit: 1000/.test(pgm), 'weld: 1,000 points per ETH');
  assert.ok(/wrapBoost: 1\.25/.test(pgm), 'weld: the tETH wrap factor');
  assert.ok(pay.includes('pp = PTS.v?.pp ? 1.2 : 1'), 'pay: the Privacy Pools factor');
});

await test('both pages map a TAC balance to the live tiers: 100, 1,000 and 10,000 TAC give x1.25, x1.5 and x2', () => {
  for (const [name, src] of [['pay', pay], ['weld', weld]]) {
    const m = src.match(/const tierOf = \(wei\) => \{([^}]*)\};/);
    assert.ok(m, `${name}: tierOf`);
    const fn = new Function('PGM', 'wei', m[1]), tierOf = (wei) => fn({ tiers: weldTiers }, wei);
    const E = 10n ** 18n;
    assert.deepEqual([99n, 100n, 999n, 1000n, 9999n, 10000n].map((t) => tierOf(t * E)), [1, 1.25, 1.25, 1.5, 1.5, 2], name);
    assert.equal(tierOf(0n), 1);
  }
});

// The page's own readTier, run with the node stubbed: a wallet's TAC transfers over the last day are replayed backwards
// from its balance now, and the tier it has HELD is the lowest point.
const E = 10n ** 18n, ME = '0x' + 'ab'.repeat(20), me32 = '0x' + '00'.repeat(12) + 'ab'.repeat(20), other = '0x' + '00'.repeat(12) + 'cd'.repeat(20);
const log = (bn, li, from, to, v) => ({ blockNumber: '0x' + bn.toString(16), logIndex: '0x' + li.toString(16), topics: ['0xddf2', from, to], data: '0x' + (v * E).toString(16).padStart(64, '0') });
const HISTORIES = {
  'TAC bought an hour ago': [10000n, [log(100, 1, other, me32, 10000n)], { now: 2, held: 1 }],
  'held all day': [10000n, [], { now: 2, held: 2 }],
  'dipped to 50 and back': [10000n, [log(100, 1, me32, other, 9950n), log(101, 1, other, me32, 9950n)], { now: 2, held: 1 }],
  'held 2,000, bought 8,000 more': [10000n, [log(100, 1, other, me32, 8000n)], { now: 2, held: 1.5 }],
  'moved to itself only': [500n, [log(100, 1, me32, me32, 500n)], { now: 1.25, held: 1.25 }],
};
const stub = (bal, logs) => async (method, params) => method === 'eth_call' ? '0x' + (bal * E).toString(16) : method === 'eth_blockNumber' ? '0x2000000'
  : (params[0].topics[1] === me32 ? logs.filter((l) => l.topics[1] === me32) : logs.filter((l) => l.topics[2] === me32));

await test('pay: readTier gives the tier now and the tier held all day', async () => {
  const a = pay.indexOf("const TAC_TOKEN = '0xA1313"), b = pay.indexOf('function holderBoost()');
  for (const [name, [bal, logs, want]] of Object.entries(HISTORIES)) {
    const readTier = new Function('CHAINS', 'rpcApart', pay.slice(a, b) + '; return readTier;')([{ chainId: 1, rpc: [] }], async () => stub(bal, logs));
    assert.deepEqual(await readTier(ME), want, name);
  }
});

await test('weld: readTier gives the same answers', async () => {
  const a = weld.indexOf('const tierOf = (wei)'), b = weld.indexOf('function holderTier(addr)');
  for (const [name, [bal, logs, want]] of Object.entries(HISTORIES)) {
    const rpc = stub(bal, logs);
    const readTier = new Function('ADDR', 'ethCall', 'rpc', 'addrWord', 'wordAt', 'PGM', weld.slice(a, b) + '; return readTier;')(
      { tac: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279' }, async (to, data) => rpc('eth_call', [{ to, data }]), rpc, (x) => x.replace(/^0x/, '').toLowerCase().padStart(64, '0'), (h) => BigInt(h), { tiers: weldTiers });
    assert.deepEqual(await readTier(ME), want, name);
  }
});

await test('a transfer history the node cannot give promises the lower tier, never the higher', async () => {
  const a = pay.indexOf("const TAC_TOKEN = '0xA1313"), b = pay.indexOf('function holderBoost()');
  const failing = async (method) => { if (method === 'eth_getLogs') throw new Error('range too large'); return method === 'eth_call' ? '0x' + (10000n * E).toString(16) : '0x2000000'; };
  const readTier = new Function('CHAINS', 'rpcApart', pay.slice(a, b) + '; return readTier;')([{ chainId: 1, rpc: [] }], async () => failing);
  assert.deepEqual(await readTier(ME), { now: 2, held: 1 });
});

console.log(`\n${n} passed`);
