// The Earn card's "Yours" panel listed a public stake for a moment after a successful "Withdraw all" (found pressing it live with a real wallet on 2026-11-23): the page waits for the withdrawal's
// receipt and then reads the farm again at 'latest', and that read goes to the project's own light node first (dapp/trade/rpc.js: cheap reads of the newest state), which runs a block or two behind the chain
// (measured that day over 70 s against the page's ten nodes: behind in every sample, two blocks behind in a quarter of them), while the receipt came from a node that is not. So the first read after a
// transaction showed the state from before it.
// Now the block a transaction of ours was mined in is kept for two minutes (dapp/index.html: receipt() -> sawBlock), and the farm read (loadPrecision) asks Multicall3 for the block it was answered from.
// An answer from before that block is read again (readFrom): first the newest block from the nodes that are not the light one (publicnode and the others keep up: one more round trip), then block `floor`
// itself (a node still short of it errors and the read goes on; the light node and publicnode take no read of a numbered block), then those two again a moment apart. Pinned here by running the page's
// own functions against stand-in nodes.
//   node --test tests/farm-read-fresh.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';

const store = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, configurable: true });
const ETHN = await import('../dapp/eth-nodes.js');
const { ETH_NODES } = ETHN;
const { hedgedRpc } = await import('../dapp/trade/rpc.js');
const LIGHT = ETH_NODES.find((u) => u.includes('tacit-node-gw'));

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
const E18 = 10n ** 18n;

// The page's own helpers (and, with `load`, its farm read) on a stand-in clock and stand-in nodes. The chain is at block 101 and the stake is gone from it (`state`); the light node is a block behind and still
// lists it (`lightState`). What the other nodes say when asked for the newest block: `fresh` 'ok' = block 101, 'stale' = behind like the light node, 'down' = they all error. What a read of a numbered block gives:
// `pinned` 'ok' = the state at that block (from a node that has it), 'refused' = every node errors, 'old' = a node that ignores the tag and answers from block 100.
function world({ lightState = { block: 100, staked: 5n * E18, earned: 3n * E18 }, state = { staked: 0, earned: 0 }, head = 101, fresh = 'ok', pinned = 'ok', load = false } = {}) {
  const clock = { t: 1_800_000_000_000 }, log = { reads: 0, asks: [], sleeps: [] }, timers = [];
  const FakeDate = { now: () => clock.t };
  const RPCS = ETH_NODES;
  const multicall = async (calls, block = 'latest', urls = RPCS) => {
    const withLight = urls.includes(LIGHT);
    log.reads++; log.asks.push({ block, light: withLight });
    let a;
    if (block !== 'latest') {
      if (pinned === 'refused') throw new Error('no RPC answered');
      a = pinned === 'old' ? lightState : { ...state, block: parseInt(block, 16) };
    } else if (withLight) a = lightState;               // the light node is first for a read of the newest block
    else if (fresh === 'down') throw new Error('no RPC answered');
    else a = fresh === 'stale' ? lightState : { ...state, block: head };
    return calls.map(({ to, data }) => {
      const sel = data.slice(0, 8);
      if (sel === SEL.blockNumber) return a.block == null ? null : hex(a.block);
      if (sel === SEL.staked) return hex(a.staked ?? 0);
      if (sel === SEL.earned) return hex(a.earned ?? 0);
      if (sel === SEL.timestamp) return hex(1_800_000_000 + (a.block || 0) * 12);
      if (sel === SEL.totalSupply) return hex(1000);
      if (sel === SEL.reserve0) return hex(E18);
      if (sel === SEL.reserve1) return hex(2n * E18);
      if (sel === SEL.sqrtPrice) return hex(E18);
      if (sel === SEL.periodFinish) return hex(2_000_000_000);
      if (sel === SEL.balanceOf && HELD[to.toLowerCase()]) return hex(HELD[to.toLowerCase()]);
      if (data.startsWith('4d2301cc')) return hex(E18);
      return hex(0);
    });
  };
  const scope = {
    Date: FakeDate, sleep: async (ms) => { log.sleeps.push(ms); clock.t += ms; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },   // a timer fires only when the test says so (`fire`): the deadline of a read
    RPCS, ETHN, SEL, ADDR, multicall, S: { address: ME, wallet: ME, acct: null }, FARM: {}, TACB: {}, PUBX: {}, CLOCK: {},
    addrWord: (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0'),
    wordAt: (h, i) => BigInt('0x' + String(h).replace(/^0x/, '').slice(i * 64, i * 64 + 64)),
    gasNow: async () => 1n, now: () => Math.floor(clock.t / 1000), dashSoon: () => {},
  };
  const fns = run(helperSrc + (load ? '\n' + loadSrc : ''), scope, `SEEN, blockOf, sawBlock, seenFloor, notLight, readFrom${load ? ', loadPrecision' : ''}`);
  const fire = () => { for (const t of timers.splice(0)) { clock.t += t.ms; t.fn(); } };
  return { ...fns, scope, clock, log, fire };
}
const T = (n) => '0x' + n.toString(16);

test('Multicall3 getBlockNumber() is the selector the page asks with', () => {
  assert.equal(SEL.blockNumber, Buffer.from(keccak_256('getBlockNumber()')).subarray(0, 4).toString('hex'));
});

test('ethCall and multicall read the newest block from every node unless told otherwise, and pass the block and the nodes on', () => {
  assert.match(page, /const ethCall = \(to, data, extra = \{\}, block = 'latest', urls = RPCS\) => rpc\('eth_call', \[\{ to, data: '0x' \+ strip\(data\), \.\.\.extra \}, block\], urls\);/);
  assert.match(page, /async function multicall\(calls, block = 'latest', urls = RPCS\) \{/);
  assert.match(page, /await ethCall\(ADDR\.multicall, SEL\.aggregate3 \+ word\(0x20\) \+ word\(calls\.length\) \+ heads\.join\(''\) \+ bodies\.join\(''\), \{\}, block, urls\)/);
  assert.match(page, /import \* as ETHN from '\/eth-nodes\.js';/, 'the node list module is also imported as a namespace (a stale cached copy of it must not break the page)');
});

test('the premise: the light node is first for a read of the newest block; the other nodes (publicnode first) are the ones notLight() leaves; a numbered block is asked of neither the light node nor publicnode', async () => {
  const w = world();
  const asked = async (hosts, block) => {
    const hits = [];
    const fetchImpl = async (u) => { hits.push(u); return { status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }; };
    await hedgedRpc(hosts, 'eth_call', [{ to: addr(3), data: '0x42cbb15c' }, block], { fetchImpl, hedgeMs: 0 });
    return hits;
  };
  assert.equal((await asked(ETH_NODES, 'latest'))[0], LIGHT, 'newest block: the light node is the first node asked');
  const others = w.notLight();
  assert.ok(!others.includes(LIGHT), 'notLight() leaves the light node out');
  assert.equal(others.length, ETH_NODES.length - 1, 'and only that one');
  assert.ok(others.some((u) => u.includes('publicnode')), 'publicnode stays');
  assert.ok(others.length > 3, 'with several nodes to go to');
  assert.ok(others.includes(ETH_NODES.find((u) => u.includes('publicnode'))));
  assert.ok(!(await asked(others, 'latest')).includes(LIGHT) && (await asked(others, 'latest'))[0].includes('publicnode'), 'a read of the newest block over them goes to publicnode first');
  const numbered = await asked(ETH_NODES, '0x1940877');
  assert.ok(!numbered.includes(LIGHT), 'a numbered block is not asked of the light node');
  assert.ok(!numbered.some((u) => u.includes('publicnode')), 'nor of publicnode, which has no old state');
});

test('notLight() with an older node list module that has no logSpan: every node stays (no throw, the retry is then a plain second read)', () => {
  const w = world();
  const old = run(helperSrc, { ...w.scope, ETHN: {} }, 'notLight');
  assert.deepEqual(old.notLight(), ETH_NODES);
});

test('readFrom: no block to reach, one read of the newest block and no wait', async () => {
  const w = world();
  const asks = [];
  const got = await w.readFrom(0, async (b, f) => { asks.push([b, f]); return { at: 50 }; });
  assert.equal(got.at, 50);
  assert.deepEqual(asks, [['latest', false]]);
  assert.deepEqual(w.log.sleeps, []);
});

test('readFrom: an answer from before the block is read again at once from the nodes that are not the light one, and that answer is taken', async () => {
  const w = world();
  const asks = [];
  const got = await w.readFrom(101, async (b, f) => { asks.push([b, f]); return { at: f ? 101 : 100, f }; });
  assert.equal(got.at, 101);
  assert.deepEqual(asks, [['latest', false], ['latest', true]]);
  assert.deepEqual(w.log.sleeps, []);
});

test('readFrom: if those nodes are behind too, the next read is AT the block itself, still at once', async () => {
  const w = world();
  const asks = [];
  const got = await w.readFrom(101, async (b, f) => { asks.push([b, f]); return { at: b === T(101) ? 101 : 100 }; });
  assert.equal(got.at, 101);
  assert.deepEqual(asks, [['latest', false], ['latest', true], ['0x65', false]], 'block 101, lower-case hex, from every node (the light node and publicnode refuse it by themselves)');
  assert.deepEqual(w.log.sleeps, []);
});

test('readFrom: when neither kind of read is taken it goes on a moment apart, the two in turn, until one answers from the block', async () => {
  const w = world();
  const asks = [];
  let n = 0;
  // the first read is behind; the next two (the other nodes, then the block itself) error; after a moment the other nodes are still behind; then the block itself answers
  const got = await w.readFrom(101, async (b, f) => { asks.push(b + (f ? '*' : '')); n++; if (n === 2 || n === 3) throw new Error('no RPC answered'); return { at: n === 5 ? 101 : 100 }; });
  assert.equal(got.at, 101);
  assert.deepEqual(asks, ['latest', 'latest*', '0x65', 'latest*', '0x65'], '* = the nodes that are not the light one');
  assert.deepEqual(w.log.sleeps, [1500, 1500], 'the first two retries are at once, the rest a moment apart');
});

test('readFrom: a node that never catches up costs eight tries, then the last answer comes back (nothing throws, the card still draws)', async () => {
  const w = world();
  let n = 0;
  const got = await w.readFrom(101, async () => ({ at: 100, n: ++n }));
  assert.equal(n, 9, 'the first read and eight more');
  assert.equal(got.n, 9, 'the last answer');
  assert.equal(w.log.sleeps.length, 6);
});

test('readFrom: a retry that hangs (nodes that never answer) is given up on at the deadline, and the last answer comes back instead of holding the page for minutes', async () => {
  const w = world();
  let asked = 0;
  const p = w.readFrom(101, () => { asked++; return asked === 1 ? Promise.resolve({ at: 100, n: 1 }) : new Promise(() => {}); });
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 2, 'the first retry is out and does not answer');
  w.fire();                                              // the deadline passes
  const got = await p;
  assert.equal(got.n, 1, 'the answer it already had');
  assert.equal(asked, 2, 'and it does not go on asking');
  assert.equal(w.log.sleeps.length, 0);
});

test('readFrom: the retries add at most `within` ms to the first answer, however many tries are left', async () => {
  const w = world();
  let n = 0;
  const got = await w.readFrom(101, async () => ({ at: 100, n: ++n }), { within: 3000 });
  assert.equal(n, 5, 'the first read, two retries at once, two after a moment each');
  assert.deepEqual(w.log.sleeps, [1500, 1500]);
  assert.equal(got.n, 5);
  const defaults = between('async function readFrom(', 'async function multicall(');
  assert.match(defaults, /within = 12e3/, 'twelve seconds by default');
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
  assert.equal(got.n, 9, 'the failed retry left the earlier answer, and the reads went on to the end');
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

test('the farm read after a withdrawal: the light node, a block behind, is not believed; the next read is from the other nodes and the stake that comes back is the one after the withdrawal', async () => {
  const w = world({ load: true });
  w.sawBlock({ blockNumber: '0x65' });                  // the withdrawal was mined in block 101
  const x = await w.loadPrecision();
  assert.equal(x.staked, 0n, 'the stake is gone');
  assert.equal(x.earned, 0n);
  assert.equal(w.scope.FARM.precision, x, 'and that is what the card is drawn from');
  assert.deepEqual(w.log.asks, [{ block: 'latest', light: true }, { block: 'latest', light: false }], 'the second read is of the newest block, with the light node left out');
  assert.deepEqual(w.log.sleeps, [], 'and it did not wait');
});

test('the farm read when the other nodes are behind too: it is asked again at the block itself', async () => {
  const w = world({ load: true, fresh: 'stale' });
  w.sawBlock({ blockNumber: '0x65' });
  const x = await w.loadPrecision();
  assert.equal(x.staked, 0n);
  assert.deepEqual(w.log.asks, [{ block: 'latest', light: true }, { block: 'latest', light: false }, { block: '0x65', light: true }]);
  assert.deepEqual(w.log.sleeps, []);
});

test('the farm read, before this page has sent anything: one read of the newest block, light node first, no wait (a page opening is not slowed)', async () => {
  const w = world({ load: true });
  const x = await w.loadPrecision();
  assert.equal(x.staked, 5n * E18);
  assert.deepEqual(w.log.asks, [{ block: 'latest', light: true }]);
  assert.deepEqual(w.log.sleeps, []);
});

test('the farm read when nothing but the light node answers: it draws from the last answer after the tries rather than failing', async () => {
  const w = world({ load: true, fresh: 'down', pinned: 'refused' });
  w.sawBlock({ blockNumber: '0x65' });
  const x = await w.loadPrecision();
  assert.equal(x.staked, 5n * E18);
  assert.equal(w.log.reads, 9);
});

test('the farm read when the block cannot be read: it is not held up', async () => {
  const w = world({ load: true, lightState: { block: null, staked: 5n * E18 } });
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
  assert.match(body, /readFrom\(seenFloor\(\), async \(block, fresh\) => \{ const r = await multicall\(calls, block, fresh \? notLight\(\) : RPCS\);/, 'and the block and the choice of nodes reach the read');
});

test('Claim, Withdraw all and the stake button read the farm again only after the receipt that sets the floor', () => {
  const claim = between("if (claim) {\n          const got = tacShort(earnedNow(r.pub))", "} else if (b.dataset.pbond != null) {");
  const i = claim.indexOf('await waitTx(h);'), j = claim.indexOf('await loadFarms(true);'), k = claim.lastIndexOf('await waitTx(h);'), l = claim.lastIndexOf('await loadFarms(true);');
  assert.ok(i > 0 && j > i && k > j && l > k, 'in each: waitTx, then loadFarms(true)');
  const stake = between('const hash = await pubSend(pq.x, pq.q, mode, HX.zs);', 'hxEarnAfter();');
  assert.ok(stake.indexOf('await waitTx(hash);') > 0 && stake.indexOf('await loadFarms(true);') > stake.indexOf('await waitTx(hash);'));
});
