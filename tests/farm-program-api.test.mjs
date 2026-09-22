// GET /farm/program and /farm/health, the shared farm health logic, and the CLI, against a mocked chain.
// Offline: node tests/farm-program-api.test.mjs
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fmtUnits, buildProgram, farmHealth, publicProgram, FARM_SELECTORS as S, FARM_MANAGER_MAINNET, LAUNCH_POOLS, LAUNCH_POOL_IDS, DAY } from '../worker-relay/src/lib/farm-health.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const GOV = '0x' + '11'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const [LP0, LP1, LP2] = Object.keys(LAUNCH_POOLS);
const NOW = 1_800_000_000n;
const TAC = 100_000_000n; // value units per TAC
const RATE = 128_225n; // ~1107.8 TAC/day

const base = () => ({
  code: '0x6080', ts: NOW, block: 26_000_000n,
  gov: GOV, pendingGov: ZERO, rate: RATE, periodFinish: NOW + 90n * BigInt(DAY), totalAlloc: 100n,
  treasury: 0n, pool: POOL, rewardAsset: '0x' + '10'.repeat(32), rewardToken: '0x' + '20'.repeat(20),
  pools: [
    { stake: LP0, shares: 5_000_000n, rps: 0n, debt: 0n, alloc: 50n, last: NOW, lock: 0n },
    { stake: LP1, shares: 700n, rps: 0n, debt: 0n, alloc: 30n, last: NOW, lock: 604800n },
    { stake: LP2, shares: 900n, rps: 0n, debt: 0n, alloc: 20n, last: NOW, lock: 1209600n },
  ],
});
let st = base();
st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;

const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrW = (a) => '0'.repeat(24) + a.slice(2).toLowerCase();
function answerCall(to, data) {
  const sel = data.slice(0, 10);
  if (sel === S.farmTreasury) return '0x' + w(st.treasury);
  if (sel === S.gov) return '0x' + addrW(st.gov);
  if (sel === S.pendingGov) return '0x' + addrW(st.pendingGov);
  if (sel === S.rate) return '0x' + w(st.rate);
  if (sel === S.periodFinish) return '0x' + w(st.periodFinish);
  if (sel === S.totalAllocPoint) return '0x' + w(st.totalAlloc);
  if (sel === S.poolLength) return '0x' + w(st.pools.length);
  if (sel === S.POOL) return '0x' + addrW(st.pool);
  if (sel === S.REWARD_ASSET) return '0x' + st.rewardAsset.slice(2);
  if (sel === S.REWARD_TOKEN) return '0x' + addrW(st.rewardToken);
  if (sel === S.pools) {
    // The confidential pool's pools(poolId) struct: init, assetA, assetB, reserveA, reserveB, feeBps, totalShares.
    const id = '0x' + data.slice(10);
    if (to.toLowerCase() !== st.pool.toLowerCase()) throw new Error('pools() read from the wrong contract');
    if (st.ammDown === id) throw new Error('pool read failed');
    const i = Object.values(LAUNCH_POOL_IDS).indexOf(id);
    return '0x' + w(1n) + '0a'.repeat(32) + '0b'.repeat(32) + w(1000n + BigInt(i)) + w(2000n + BigInt(i)) + w(30n) + w(500n + BigInt(i));
  }
  if (sel === S.poolInfo) {
    const p = st.pools[Number(BigInt('0x' + data.slice(10)))];
    return '0x' + p.stake.slice(2) + w(p.shares) + w(p.rps) + w(p.debt) + w(p.alloc) + w(p.last) + w(p.lock);
  }
  throw new Error('unstubbed selector ' + sel);
}
let calls = 0, down = false;
function rpcAnswer(body) {
  calls++;
  if (down) return { status: 500 };
  const { method, params, id } = body;
  let result;
  if (method === 'eth_getBlockByNumber') result = { number: '0x' + st.block.toString(16), timestamp: '0x' + st.ts.toString(16) };
  else if (method === 'eth_getCode') result = st.code;
  else if (method === 'eth_call') result = answerCall(params[0].to, params[0].data);
  else return { body: { jsonrpc: '2.0', id, error: { message: 'unsupported ' + method } } };
  return { body: { jsonrpc: '2.0', id, result } };
}
globalThis.fetch = async (url, init) => {
  const r = rpcAnswer(JSON.parse(init.body));
  if (r.status) return new Response('down', { status: r.status });
  return new Response(JSON.stringify(r.body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const worker = await import('../worker/src/index.js');
const { _resetFarmCache } = await import('../worker/src/farm-program.js');
const env = { REGISTRY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
const get = (path) => worker.default.fetch(new Request('https://api.test' + path, { headers: { Origin: 'https://example.org' } }), env, { waitUntil() {} });
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const byName = (h, n) => h.checks.find((c) => c.name === n);
const fresh = () => { _resetFarmCache(); calls = 0; down = false; };

console.log('\nselectors match the contract signatures:');
for (const [name, sig] of Object.entries({ gov: 'gov()', pendingGov: 'pendingGov()', rate: 'rate()', periodFinish: 'periodFinish()', totalAllocPoint: 'totalAllocPoint()', poolLength: 'poolLength()', poolInfo: 'poolInfo(uint256)', POOL: 'POOL()', REWARD_ASSET: 'REWARD_ASSET()', REWARD_TOKEN: 'REWARD_TOKEN()', farmTreasury: 'farmTreasury(address)', pools: 'pools(bytes32)' })) {
  ok(sig, S[name] === '0x' + bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8));
}

console.log('\nnormal state:');
{
  fresh();
  const r = await get('/farm/program?network=mainnet');
  const b = await r.json();
  ok('200, CORS-open, cacheable', r.status === 200 && r.headers.get('Access-Control-Allow-Origin') === '*' && /max-age=15/.test(r.headers.get('Cache-Control')));
  ok('manager, reward asset and token come from the chain', b.manager === FARM_MANAGER_MAINNET && b.rewardAsset === st.rewardAsset && b.rewardToken === st.rewardToken);
  ok('governor and no pending governor', b.gov === GOV && b.pendingGov === ZERO);
  ok('rate per second is the raw unit rate', b.epoch.ratePerSecUnits === '128225');
  ok('rate per day in TAC is exact', b.epoch.ratePerDayTac === '110.7864');
  ok('remaining seconds is 90 days', b.epoch.remainingSeconds === 90 * 86400 && b.epoch.active === true);
  ok('treasury is a decimal string', b.epoch.treasuryTac === fmtUnits(st.treasury));
  ok('nothing earned yet at the start of the epoch', b.epoch.outstandingTac === '0');
  ok('funded runway is the surplus over the rate', b.epoch.fundedRunwaySeconds === (90 * 86400) + Math.floor(Number(10n * TAC) / Number(RATE)));
  ok('three pools with launch labels', b.pools.length === 3 && b.pools.map((p) => p.pair).join() === 'TAC/cETH,cETH/cUSD,cETH/cBTC');
  ok('share percent and per-pool TAC/day', b.pools[0].sharePct === '50' && b.pools[1].sharePct === '30' && b.pools[2].tacPerDayForPool === fmtUnits((RATE * 86400n * 20n) / 100n));
  ok('lock seconds and shares reported', b.pools[1].lockSeconds === 604800 && b.pools[0].totalShares === '5000000' && b.pools.every((p) => p.idle === false));
  ok('no internal fields leak', !('_n' in b) && typeof b.updatedAt === 'string' && b.stale === false);
  ok('each launch pool carries its pool id, fee tier and reserves', b.pools.every((p, i) => p.poolId === LAUNCH_POOL_IDS[p.lpAsset]
    && p.feeBps === 30 && p.reserves && p.reserves.reserveA === String(1000 + i) && p.reserves.reserveB === String(2000 + i)
    && p.reserves.lpTotalShares === String(500 + i) && p.reserves.assetA === '0x' + '0a'.repeat(32)), JSON.stringify(b.pools[0]));
  ok('every launch pool id derives its LP asset', Object.entries(LAUNCH_POOL_IDS).every(([lp, id]) =>
    '0x' + bytesToHex(keccak_256(new Uint8Array([...Buffer.from(id.slice(2), 'hex'), ...Buffer.from('lp')]))) === lp));
  const before = calls;
  await get('/farm/program?network=mainnet'); await get('/farm/health?network=mainnet');
  ok('repeat calls inside the window reuse one read', calls === before);
  const h = await (await get('/farm/health?network=mainnet')).json();
  ok('health ok with every check present', h.status === 'ok' && h.checks.map((c) => c.name).join() === 'manager,solvency,runway,emission,idle-pools,governor', JSON.stringify(h));
  const s = await get('/farm/program?network=signet');
  ok('signet is a clean 404', s.status === 404);
}

console.log('\nan unreadable pool reports no reserves and the program still answers:');
{
  fresh();
  st.ammDown = Object.values(LAUNCH_POOL_IDS)[1];
  const r = await get('/farm/program');
  const b = await r.json();
  ok('200 with the other pools intact', r.status === 200 && b.pools[0].reserves && b.pools[2].reserves);
  ok('the unreadable pool keeps its id but has no reserves', b.pools[1].poolId === Object.values(LAUNCH_POOL_IDS)[1] && b.pools[1].reserves === null && b.pools[1].feeBps === null);
  st.ammDown = null;
}

console.log('\nunknown pool falls back to pid N:');
{
  fresh();
  st.pools[2].stake = '0x' + 'ab'.repeat(32);
  const b = await (await get('/farm/program')).json();
  ok('an unknown LP asset has no pool id or reserves', b.pools[2].poolId === null && b.pools[2].reserves === null);
  ok('label', b.pools[2].pair === 'pid 2');
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nidle pool:');
{
  fresh();
  st.pools[1].shares = 0n; st.pools[2].shares = 0n;
  const p = await (await get('/farm/program')).json();
  const h = await (await get('/farm/health')).json();
  ok('pools flagged idle', p.pools[1].idle && p.pools[2].idle && !p.pools[0].idle);
  const c = byName(h, 'idle-pools');
  const wasted = (RATE * 86400n * 30n) / 100n + (RATE * 86400n * 20n) / 100n;
  ok('warns and names the wasted TAC/day', h.status === 'warn' && c.status === 'warn' && c.detail.includes('cETH/cUSD') && c.detail.includes(fmtUnits(wasted) + ' TAC/day'), c.detail);
  ok('an unweighted empty pool is not idle-warned', (() => { const q = base(); q.pools[1].shares = 0n; q.pools[1].alloc = 0n; const raw = rawOf(q); return byName(farmHealth(buildProgram(raw)), 'idle-pools').status === 'ok'; })());
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nfinished epoch:');
{
  fresh();
  st.periodFinish = NOW - 5n; st.pools[0].last = NOW - 5n;
  const b = await (await get('/farm/program')).json();
  const h = await (await get('/farm/health')).json();
  ok('remaining is zero and not active', b.epoch.remainingSeconds === 0 && b.epoch.active === false);
  ok('warns that a top-up is needed', h.status === 'warn' && /top-up needed/.test(byName(h, 'runway').detail));
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nnever-started program:');
{
  fresh();
  st.rate = 0n; st.periodFinish = 0n; st.treasury = 0n;
  const h = await (await get('/farm/health')).json();
  ok('warn, not critical', h.status === 'warn' && /no epoch has been started/.test(byName(h, 'runway').detail), JSON.stringify(h));
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\ninsolvency:');
{
  fresh();
  st.treasury = RATE * 90n * BigInt(DAY) - 1n;
  const h = await (await get('/farm/health')).json();
  ok('one unit short is critical', h.status === 'critical' && byName(h, 'solvency').status === 'critical' && /short .* by 0.00000001 TAC/.test(byName(h, 'solvency').detail), byName(h, 'solvency').detail);
  fresh();
  st.treasury = RATE * 90n * BigInt(DAY);
  const h2 = await (await get('/farm/health')).json();
  ok('exactly enough is ok', byName(h2, 'solvency').status === 'ok');
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nearned reward counts as owed:');
{
  // 1000s into the epoch with one staker: stored accumulator is stale, the live figure must include the accrual.
  fresh();
  st.ts = NOW + 1000n; st.periodFinish = NOW + 90n * BigInt(DAY);
  st.pools = [{ stake: LP0, shares: 1_000_000n, rps: 0n, debt: 0n, alloc: 100n, last: NOW, lock: 0n }];
  st.totalAlloc = 100n;
  const P = 1n << 64n;
  const rpsNow = (RATE * 100n * 1000n * P) / (100n * 1_000_000n);
  const expected = (rpsNow * 1_000_000n + P - 1n) / P; // ceil
  st.treasury = expected + RATE * (90n * BigInt(DAY) - 1000n);
  const b = await (await get('/farm/program')).json();
  ok('outstanding matches the contract accrual, rounded up', b.epoch.outstandingTac === fmtUnits(expected), b.epoch.outstandingTac + ' vs ' + fmtUnits(expected));
  const h = await (await get('/farm/health')).json();
  ok('treasury exactly at earned + remaining is ok', byName(h, 'solvency').status === 'ok', byName(h, 'solvency').detail);
  fresh(); st.treasury -= 1n;
  ok('one unit less is critical', byName(await (await get('/farm/health')).json(), 'solvency').status === 'critical');
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nrunway thresholds:');
{
  const at = async (secs) => {
    fresh(); st.periodFinish = NOW + BigInt(secs); st.treasury = RATE * BigInt(secs) + TAC; st.pools.forEach((p) => { p.last = NOW; });
    const h = await (await get('/farm/health')).json();
    return byName(h, 'runway').status;
  };
  ok('14d exactly is ok', await at(14 * 86400) === 'ok');
  ok('14d minus a second warns', await at(14 * 86400 - 1) === 'warn');
  ok('3d exactly warns', await at(3 * 86400) === 'warn');
  ok('3d minus a second is critical', await at(3 * 86400 - 1) === 'critical');
  ok('one second left is critical', await at(1) === 'critical');
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nrate zero mid-epoch:');
{
  fresh(); st.rate = 0n;
  const h = await (await get('/farm/health')).json();
  ok('critical', h.status === 'critical' && byName(h, 'emission').status === 'critical');
  const p = await (await get('/farm/program')).json();
  ok('funded runway is null with no rate', p.epoch.fundedRunwaySeconds === null && p.epoch.ratePerDayTac === '0');
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\npending governor:');
{
  fresh(); st.pendingGov = '0x' + '22'.repeat(20);
  const h = await (await get('/farm/health')).json();
  ok('warns awaiting acceptance', h.status === 'warn' && /awaiting acceptance/.test(byName(h, 'governor').detail));
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nmanager code missing:');
{
  fresh(); st.code = '0x';
  const h = await (await get('/farm/health')).json();
  ok('critical', h.status === 'critical' && byName(h, 'manager').status === 'critical');
  const p = await get('/farm/program');
  ok('program is a 503', p.status === 503);
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC;
}

console.log('\nRPC failure and stale-if-error:');
{
  fresh();
  const first = await get('/farm/program');
  ok('warm the cache', first.status === 200);
  clock += 20_000; down = true;
  const s = await get('/farm/program');
  const sb = await s.json();
  ok('an expired entry is served stale on failure', s.status === 200 && sb.stale === true && s.headers.get('X-Farm-Stale') === '1');
  const sh = await (await get('/farm/health')).json();
  ok('health serves stale too', sh.stale === true && sh.status === 'ok');
  clock += 120_000;
  const e = await get('/farm/program');
  const eb = await e.json();
  ok('past the grace window: 503 with a clear error', e.status === 503 && eb.error === 'farm program unavailable' && /rpc/.test(eb.detail) && e.headers.get('Cache-Control') === 'no-store', JSON.stringify(eb));
  const eh = await get('/farm/health');
  const ehb = await eh.json();
  ok('health fails closed as critical', eh.status === 503 && ehb.status === 'critical' && ehb.checks[0].name === 'rpc');
  fresh(); down = true;
  const cold = await get('/farm/program');
  ok('cold start with the chain down is a 503', cold.status === 503);
  down = false;
  const back = await get('/farm/program');
  ok('recovers when the chain returns', back.status === 200 && (await back.json()).stale === false);
}

console.log('\ndecimal math at the boundaries:');
{
  ok('zero', fmtUnits(0n) === '0');
  ok('one unit', fmtUnits(1n) === '0.00000001');
  ok('one TAC', fmtUnits(TAC) === '1');
  ok('trailing zeros trimmed', fmtUnits(150_000_000n) === '1.5');
  ok('past 2^53 stays exact', fmtUnits(9_007_199_254_740_993n) === '90071992.54740993');
  ok('uint64-max rate over a day stays exact', fmtUnits(18_446_744_073_709_551_615n * 86400n) === '15937986879685052.59536');
  ok('two-decimal share pct floors', (() => { const q = base(); q.totalAlloc = 3n; q.pools = [{ ...q.pools[0], alloc: 1n }]; return publicProgram(buildProgram(rawOf(q))).pools[0].sharePct === '33.33'; })());
  ok('a share never rounds up to 100', (() => { const q = base(); q.totalAlloc = 30001n; q.pools = [{ ...q.pools[0], alloc: 30000n }]; return publicProgram(buildProgram(rawOf(q))).pools[0].sharePct === '99.99'; })());
}

// The CLI: the same logic over a local HTTP endpoint, exit code and --json.
console.log('\nCLI:');
{
  const srv = http.createServer((req, res) => {
    let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => {
      const r = rpcAnswer(JSON.parse(s));
      res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(r.status ? 'down' : JSON.stringify(r.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const run = (args = []) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['tools/farm-monitor.mjs', ...args], { env: { ...process.env, RPC: url }, cwd: new URL('..', import.meta.url).pathname });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('close', (code) => resolve({ code, out }));
  });
  st = base(); st.treasury = RATE * 90n * BigInt(DAY) + 10n * TAC; down = false;
  let r = await run(['--json']);
  ok('healthy: exit 0 and JSON', r.code === 0 && JSON.parse(r.out).status === 'ok');
  st.pendingGov = '0x' + '22'.repeat(20);
  r = await run();
  ok('warn: exit 1 and a table', r.code === 1 && /WARN\s+governor/.test(r.out) && /TAC\/cETH/.test(r.out));
  st.treasury = 1n;
  r = await run(['--json']);
  ok('insolvent: exit 2', r.code === 2 && JSON.parse(r.out).status === 'critical');
  down = true;
  r = await run();
  ok('unreadable chain: exit 2', r.code === 2 && /unreadable/.test(r.out));
  srv.close();
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

function rawOf(q) {
  return {
    manager: FARM_MANAGER_MAINNET, blockNumber: q.block, timestamp: q.ts, codeMissing: false,
    gov: q.gov, pendingGov: q.pendingGov, rate: q.rate, periodFinish: q.periodFinish, totalAllocPoint: q.totalAlloc,
    pool: q.pool, rewardAsset: q.rewardAsset, rewardToken: q.rewardToken, treasury: q.treasury,
    pools: q.pools.map((p) => ({ stakeAsset: p.stake, totalShares: p.shares, rps: p.rps, totalRewardDebt: p.debt, allocPoint: p.alloc, lastUpdate: p.last, lockDuration: p.lock })),
  };
}
