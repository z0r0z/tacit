// The Earn card's "Yours" panel listed a public stake for a moment after a successful "Withdraw all" (found pressing it live with a real wallet on 2026-11-23): the page waits for the withdrawal's
// receipt and then reads the farm again at 'latest', and that read goes to the project's own light node first (dapp/trade/rpc.js: cheap reads of the newest state), which runs a block or two behind the chain
// (measured that day over 70 s against the page's ten nodes: behind in every sample, two blocks behind in a quarter of them), while the receipt came from a node that is not. So the first read after a
// transaction showed the state from before it.
// Now the block a transaction of ours was mined in is kept for two minutes (dapp/index.html: receipt() -> sawBlock), and the farm read (loadPrecision) asks Multicall3 for the block it was answered from;
// an answer from before that block is read again AT that block, which the light node takes no read of (so a node that has the block answers, at once), and if no node takes a numbered-block read the
// newest block is asked for again, a moment apart (readFrom). Pinned here by running the page's own functions against stand-in nodes.
//   node --test tests/farm-read-fresh.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';

const store = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, configurable: true });
const { ETH_NODES } = await import('../dapp/eth-nodes.js');
const { hedgedRpc } = await import('../dapp/trade/rpc.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, '..', 'dapp', 'index.html'), 'utf8');
const between = (from, to) => {
  const a = page.indexOf(from), b = page.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)} .. ${JSON.stringify(to)} in dapp/index.html`);
  return page.slice(a, b);
};
const run = (src, scope, expose) => new Function('scope', `with (scope) { ${src}\nreturn { ${expose} }; }`)(new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t }));

const helperSrc = between('const SEEN = { block: 0, at: 0 };', 'async function multicall(calls');
const loadSrc = between('let precisionSeq = 0;', 'function loadProgram()');
const receiptSrc = between('const RECEIPTS = new Map();', "const NOTIFY_KEY = 'tacit-lite-notify-v1';");
const SELSRC = between('const SEL = {', '\n};');
const SEL = Object.fromEntries([...SELSRC.matchAll(/(\w+): '([0-9a-f]{8})'/g)].map((m) => [m[1], m[2]]));

const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const ME = addr(0xabc);
const ADDR = { precisionPool: addr(1), precisionFarm: addr(2), multicall: addr(3), tac: addr(4), tacbtc: addr(5), tacusd: addr(6), tacd: addr(7), tace: addr(8) };
const HELD = { [ADDR.tac]: 7, [ADDR.tacbtc]: 8, [ADDR.tacusd]: 9, [ADDR.tacd]: 10, [ADDR.tace]: 11 };
const T = (n) => '0x' + n.toString(16);

// The page's own helpers (and, with `load`, its farm read) on a stand-in clock and stand-in nodes.
//   `answers`: what each successive read of the NEWEST block gives (the last repeating), { block, staked, earned }: the light node, a block or two behind.
//   `pinned`:  what a read of a numbered block gives: 'ok' = the state at that block (`state`, taken from a node that has it), 'refused' = every node errors, 'old' = a node that ignores the tag and answers from block 100.
function world({ answers = [{ block: 100, staked: 0 }], pinned = 'ok', state = { staked: 0, earned: 0 }, load = false } = {}) {
  const clock = { t: 1_800_000_000_000 }, log = { reads: 0, tags: [], sleeps: [] };
  const FakeDate = { now: () => clock.t };
  let latest = 0;
  const multicall = async (calls, block = 'latest') => {
    log.reads++; log.tags.push(block);
    let a;
    if (block === 'latest') a = answers[Math.min(latest++, answers.length - 1)];
    else if (pinned === 'refused') throw new Error('no RPC answered');
    else if (pinned === 'old') a = { block: 100, staked: 5n * 10n ** 18n };
    else a = { ...state, block: parseInt(block, 16) };
    return calls.map(({ to, data }) => {
      const sel = data.slice(0, 8);
      if (sel === SEL.blockNumber) return a.block == null ? null : hex(a.block);
      if (sel === SEL.staked) return hex(a.staked ?? 0);
      if (sel === SEL.earned) return hex(a.earned ?? 0);
      if (sel === SEL.timestamp) return hex(1_800_000_000 + (a.block || 0) * 12);
      if (sel === SEL.totalSupply) return hex(1000);
      if (sel === SEL.reserve0) return hex(10n ** 18n);
      if (sel === SEL.reserve1) return hex(2n * 10n ** 18n);
      if (sel === SEL.sqrtPrice) return hex(10n ** 18n);
      if (sel === SEL.periodFinish) return hex(2_000_000_000);
      if (sel === SEL.balanceOf && HELD[to.toLowerCase()]) return hex(HELD[to.toLowerCase()]);
      if (data.startsWith('4d2301cc')) return hex(10n ** 18n);
      return hex(0);
    });
  };
  const scope = {
    Date: FakeDate, sleep: async (ms) => { log.sleeps.push(ms); clock.t += ms; },
    SEL, ADDR, multicall, S: { address: ME, wallet: ME, acct: null }, FARM: {}, TACB: {}, PUBX: {}, CLOCK: {},
    addrWord: (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0'),
    wordAt: (h, i) => BigInt('0x' + String(h).replace(/^0x/, '').slice(i * 64, i * 64 + 64)),
    gasNow: async () => 1n, now: () => Math.floor(clock.t / 1000), dashSoon: () => {},
  };
  const fns = run(helperSrc + (load ? '\n' + loadSrc : ''), scope, `SEEN, blockOf, sawBlock, seenFloor, readFrom${load ? ', loadPrecision' : ''}`);
  return { ...fns, scope, clock, log };
}
const E18 = 10n ** 18n;

test('Multicall3 getBlockNumber() is the selector the page asks with', () => {
  assert.equal(SEL.blockNumber, Buffer.from(keccak_256('getBlockNumber()')).subarray(0, 4).toString('hex'));
});

test('ethCall and multicall read the newest block unless they are given another, and pass it on', () => {
  assert.match(page, /const ethCall = \(to, data, extra = \{\}, block = 'latest'\) => rpc\('eth_call', \[\{ to, data: '0x' \+ strip\(data\), \.\.\.extra \}, block\]\);/);
  assert.match(page, /async function multicall\(calls, block = 'latest'\) \{/);
  assert.match(page, /await ethCall\(ADDR\.multicall, SEL\.aggregate3 \+ word\(0x20\) \+ word\(calls\.length\) \+ heads\.join\(''\) \+ bodies\.join\(''\), \{\}, block\)/);
});

test('the premise: a read of the newest state goes to the light node first, a read of a numbered block never does (nor to the other node that has no old state)', async () => {
  const OURS = ETH_NODES.find((u) => u.includes('tacit-node-gw'));
  const asked = async (block) => {
    const hits = [];
    const fetchImpl = async (u) => { hits.push(u); return { status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }; };
    await hedgedRpc(ETH_NODES, 'eth_call', [{ to: addr(3), data: '0x42cbb15c' }, block], { fetchImpl, hedgeMs: 0 });
    return hits;
  };
  assert.equal((await asked('latest'))[0], OURS, 'newest block: the light node is the first node asked');
  const numbered = await asked('0x1940877');
  assert.ok(!numbered.includes(OURS), 'a numbered block is not asked of the light node');
  assert.ok(!numbered.some((u) => u.includes('publicnode')), 'nor of publicnode, which has no old state');
  assert.ok(numbered[0], 'and some other node is asked');
});

test('readFrom: no block to reach, one read of the newest block and no wait', async () => {
  const w = world();
  const tags = [];
  const got = await w.readFrom(0, async (b) => { tags.push(b); return { at: 50 }; });
  assert.equal(got.at, 50);
  assert.deepEqual(tags, ['latest']);
  assert.deepEqual(w.log.sleeps, []);
});

test('readFrom: an answer from before the block is read again AT that block, at once, and that answer is taken', async () => {
  const w = world();
  const tags = [];
  const got = await w.readFrom(101, async (b) => { tags.push(b); return { at: b === 'latest' ? 100 : 101, b }; });
  assert.equal(got.at, 101);
  assert.equal(got.b, '0x65', 'block 101, lower-case hex');
  assert.deepEqual(tags, ['latest', '0x65']);
  assert.deepEqual(w.log.sleeps, [], 'no wait: a node that has the block answers now');
});

test('readFrom: when no node takes a read of a numbered block it asks for the newest again, a moment apart, until one answers from the block', async () => {
  const w = world();
  const tags = [], latest = [100, 100, 101];
  let n = 0;
  const got = await w.readFrom(101, async (b) => { tags.push(b); if (b !== 'latest') throw new Error('no RPC answered'); return { at: latest[n++] }; });
  assert.equal(got.at, 101);
  assert.deepEqual(tags, ['latest', '0x65', 'latest', 'latest'], 'once the numbered read is refused it is not tried again');
  assert.deepEqual(w.log.sleeps, [1500, 1500]);
});

test('readFrom: a node that never catches up costs eight tries, then the last answer comes back (nothing throws, the card still draws)', async () => {
  const w = world();
  let n = 0;
  const got = await w.readFrom(101, async () => ({ at: 100, n: ++n }));
  assert.equal(n, 9, 'the first read and eight more');
  assert.equal(got.n, 9, 'the last answer');
  assert.equal(w.log.sleeps.length, 7, 'the first retry is at once, the rest a moment apart');
});

test('readFrom: an answer whose block is not known is taken as it is (nothing to compare)', async () => {
  const w = world();
  let n = 0;
  const got = await w.readFrom(101, async () => ({ at: null, n: ++n }));
  assert.equal(n, 1);
  assert.equal(got.n, 1);
});

test('readFrom: a failure on the first read is the caller\'s; one on a retry keeps the earlier answer', async () => {
  const w = world();
  await assert.rejects(w.readFrom(101, async () => { throw new Error('unreachable'); }), /unreachable/);
  let n = 0;
  const got = await w.readFrom(101, async () => { n++; if (n === 2) throw new Error('node down'); return { at: 100, n }; });
  assert.equal(got.n, 9, 'the failed numbered read left the earlier answer, and the newest block was asked again to the end');
});

test('sawBlock keeps the newest block of a mined transaction for two minutes, and ignores a receipt without one', () => {
  const w = world();
  assert.equal(w.seenFloor(), 0, 'nothing seen: no block to wait for');
  w.sawBlock({ status: '0x0', replaced: true, transactionHash: '0xaa' });
  w.sawBlock(null);
  w.sawBlock({ blockNumber: null });
  w.sawBlock({ blockNumber: 'not a number' });
  assert.equal(w.seenFloor(), 0, 'a replaced transaction, nothing and garbage leave no floor');
  w.sawBlock({ blockNumber: '0x65' });
  assert.equal(w.seenFloor(), 101);
  w.sawBlock({ blockNumber: '0x64' });
  assert.equal(w.seenFloor(), 101, 'an older block does not lower it');
  w.sawBlock({ blockNumber: '0x66' });
  assert.equal(w.seenFloor(), 102);
  w.clock.t += 119e3;
  assert.equal(w.seenFloor(), 102, 'still kept just under two minutes');
  w.clock.t += 2e3;
  assert.equal(w.seenFloor(), 0, 'gone after two minutes: a read is never held up for a transaction long past');
  w.sawBlock({ blockNumber: '0x10' });
  assert.equal(w.seenFloor(), 16, 'and a later transaction sets a floor again, even at a lower block than the expired one');
});

test('receipt() records the block of a mined mainnet transaction, and only a mainnet one', async () => {
  const mined = { status: '0x1', blockNumber: '0x65', transactionHash: '0xabc' };
  const scope = (w) => ({
    ...w.scope, RPCS: [], DEVICE_CHAINS: [{ chainId: 8453, rpc: [] }], rpc: async () => mined,
    landedHash: () => null, JRN: {}, lookReplaced: async () => ({}),
  });
  const w = world();
  const { receipt, seenFloor } = run(helperSrc + '\n' + receiptSrc, scope(w), 'receipt, seenFloor');
  assert.equal(seenFloor(), 0);
  assert.equal(await receipt('0xabc', 8453), mined);
  assert.equal(seenFloor(), 0, 'a receipt from another chain says nothing about mainnet\'s blocks');
  assert.equal(await receipt('0xabc'), mined);
  assert.equal(seenFloor(), 101);
});

test('the farm read after a withdrawal: the light node still at the block before it is not believed, the stake that comes back is the one after it', async () => {
  const w = world({ load: true, answers: [{ block: 100, staked: 5n * E18, earned: 3n * E18 }], state: { staked: 0, earned: 0 } });
  w.sawBlock({ blockNumber: '0x65' });                  // the withdrawal was mined in block 101
  const x = await w.loadPrecision();
  assert.equal(x.staked, 0n, 'the stake is gone');
  assert.equal(x.earned, 0n);
  assert.equal(w.scope.FARM.precision, x, 'and that is what the card is drawn from');
  assert.deepEqual(w.log.tags, ['latest', '0x65'], 'the second read is at the block the withdrawal was mined in');
  assert.deepEqual(w.log.sleeps, [], 'and it did not wait');
});

test('the farm read, before this page has sent anything: one read of the newest block, no wait (a page opening is not slowed)', async () => {
  const w = world({ load: true, answers: [{ block: 100, staked: 5n * E18 }] });
  const x = await w.loadPrecision();
  assert.equal(x.staked, 5n * E18);
  assert.deepEqual(w.log.tags, ['latest']);
  assert.deepEqual(w.log.sleeps, []);
});

test('the farm read when no node takes a numbered-block read: it asks for the newest again and draws from the first answer that is not behind', async () => {
  const w = world({ load: true, pinned: 'refused', answers: [{ block: 100, staked: 5n * E18 }, { block: 100, staked: 5n * E18 }, { block: 101, staked: 0 }] });
  w.sawBlock({ blockNumber: '0x65' });
  const x = await w.loadPrecision();
  assert.equal(x.staked, 0n);
  assert.deepEqual(w.log.tags, ['latest', '0x65', 'latest', 'latest']);
  assert.deepEqual(w.log.sleeps, [1500, 1500]);
});

test('the farm read when nothing reaches the block: it draws from the last answer after the tries rather than failing', async () => {
  const w = world({ load: true, pinned: 'old', answers: [{ block: 100, staked: 5n * E18 }] });
  w.sawBlock({ blockNumber: '0x65' });
  const x = await w.loadPrecision();
  assert.equal(x.staked, 5n * E18);
  assert.equal(w.log.reads, 9);
});

test('the farm read when the block cannot be read: it is not held up', async () => {
  const w = world({ load: true, answers: [{ block: null, staked: 5n * E18 }] });
  w.sawBlock({ blockNumber: '0x65' });
  const x = await w.loadPrecision();
  assert.equal(x.staked, 5n * E18);
  assert.equal(w.log.reads, 1);
});

test('the block call is the last one in the batch, so the token balances the read hands to the wallet card are still read from the right slots', async () => {
  const w = world({ load: true });
  await w.loadPrecision();
  const { TACB, PUBX } = w.scope;
  assert.equal(TACB.erc, 7n, 'TAC held');
  assert.equal(PUBX.tacbtc, 8n);
  assert.equal(PUBX.tacusd, 9n);
  assert.equal(PUBX.tacd, 10n);
  assert.equal(PUBX.tace, 11n);
  const body = loadSrc.slice(loadSrc.indexOf('const balAt ='), loadSrc.indexOf('const w = (i)'));
  assert.ok(body.indexOf('const blkAt = calls.push(') > body.indexOf('const balAt =') && body.indexOf('readFrom(seenFloor()') > body.indexOf('const blkAt'), 'blkAt is pushed after balAt, then read');
  assert.match(body, /readFrom\(seenFloor\(\), async \(block\) => \{ const r = await multicall\(calls, block\);/, 'and the block the read is asked at reaches the node');
});

test('Claim, Withdraw all and the stake button read the farm again only after the receipt that sets the floor', () => {
  const claim = between("if (claim) {\n          const got = tacShort(earnedNow(r.pub))", "} else if (b.dataset.pbond != null) {");
  const i = claim.indexOf('await waitTx(h);'), j = claim.indexOf('await loadFarms(true);'), k = claim.lastIndexOf('await waitTx(h);'), l = claim.lastIndexOf('await loadFarms(true);');
  assert.ok(i > 0 && j > i && k > j && l > k, 'in each: waitTx, then loadFarms(true)');
  const stake = between('const hash = await pubSend(pq.x, pq.q, mode, HX.zs);', 'hxEarnAfter();');
  assert.ok(stake.indexOf('await waitTx(hash);') > 0 && stake.indexOf('await loadFarms(true);') > stake.indexOf('await waitTx(hash);'));
});
