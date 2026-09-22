// Launch-farm state and health — pure, dependency-free, shared by the API (GET /farm/program, /farm/health),
// the balance monitor, and tools/farm-monitor.mjs so all three read the same numbers the same way.
//
// The FarmManager streams one budget across many LP pools. What matters operationally is whether the escrow
// treasury can pay every reward already earned plus everything still to be emitted, how long the program has
// left, and whether any funded weight is streaming into a pool nobody has staked in.
//
// Money is BigInt end to end. A reward "value unit" is 1e-8 TAC (the reward wrapper's pool unit scale is 1e10
// against an 18-decimal token), so TAC amounts are decimal strings with up to eight places.

export const FARM_MANAGER_MAINNET = '0x000031C47Cb61faB1CE2790a69625FABB71EDE24';
export const FARM_RPCS_MAINNET = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth.merkle.io'];

export const UNIT_DECIMALS = 8;
export const PRECISION = 1n << 64n;
export const DAY = 86400;
export const RUNWAY_WARN_SECS = 14 * DAY;
export const RUNWAY_CRITICAL_SECS = 3 * DAY;

// Launch pools by LP share asset id. Anything else falls back to "pid N".
export const LAUNCH_POOLS = {
  '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99': 'TAC/cETH',
  '0xd608b0c3806e782cc213e2d52245c3c2fbef455a10410a1f5ccc61ba45262571': 'cETH/cUSD',
  '0x0a0cce175bc483945822c8de3d3926e813269f5e1bbe1f9c853e09ed48b68254': 'cETH/cBTC',
};
// The confidential pool each launch LP asset belongs to (lpAsset = keccak(poolId ‖ "lp")); the manager stores only the
// LP asset, so the pool id that its reserves are read under comes from here.
export const LAUNCH_POOL_IDS = {
  '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99': '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00',
  '0xd608b0c3806e782cc213e2d52245c3c2fbef455a10410a1f5ccc61ba45262571': '0x5925c0c2954c5b11bedd20e444f0cb22f3827f6197814f97d193e7a44e909da7',
  '0x0a0cce175bc483945822c8de3d3926e813269f5e1bbe1f9c853e09ed48b68254': '0x8359cd1f812e3a9040129e186e1477f60f2188bad1bd6a56e5506b22bf5cd331',
};

const SEL = {
  gov: '0x12d43a51', pendingGov: '0x25240810', rate: '0x2c4e722e', periodFinish: '0xebe2b12b',
  totalAllocPoint: '0x17caf6f1', poolLength: '0x081e3eda', poolInfo: '0x1526fe27',
  POOL: '0x7535d246', REWARD_ASSET: '0xf7b87410', REWARD_TOKEN: '0x99248ea7',
  farmTreasury: '0x48aa7283', pools: '0xb5217bb4',
};
export const FARM_SELECTORS = SEL;

const pad32 = (n) => n.toString(16).padStart(64, '0');
const wordOf = (hex, i) => {
  const h = String(hex || '').slice(2);
  if (h.length < 64 * (i + 1)) throw new Error('short eth_call result');
  return h.slice(64 * i, 64 * (i + 1));
};
const uintOf = (hex, i = 0) => BigInt('0x' + wordOf(hex, i));
const addrOf = (hex) => '0x' + wordOf(hex, 0).slice(24);
const bytes32Of = (hex) => '0x' + wordOf(hex, 0);

// Decimal string of `v` scaled by 10^decimals, trailing zeros trimmed ("1234.5", "0", "0.00000001").
export function fmtUnits(v, decimals = UNIT_DECIMALS) {
  v = BigInt(v);
  const neg = v < 0n;
  if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

// JSON-RPC over an ordered list of endpoints: each request goes to the first that answers, so one provider
// being slow or rate-limiting does not fail the read. A request pinned to a block an endpoint has not seen
// yet errors there and falls through to the next.
export function makeRpc(urls, fetchFn = (...a) => globalThis.fetch(...a), timeoutMs = 8000) {
  let id = 0;
  async function rpc(method, params) {
    let last = 'no endpoints';
    for (const url of urls) {
      try {
        const r = await fetchFn(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) { last = `${url} HTTP ${r.status}`; continue; }
        const j = await r.json();
        if (j && j.error) { last = `${url} ${j.error.message || j.error.code}`; continue; }
        if (j && j.result !== undefined && j.result !== null) return j.result;
        last = `${url} empty result`;
      } catch (e) { last = `${url} ${e?.message || e}`; }
    }
    throw new Error(`rpc ${method} failed: ${last}`);
  }
  return {
    latestBlock: async () => {
      const b = await rpc('eth_getBlockByNumber', ['latest', false]);
      return { number: BigInt(b.number), timestamp: BigInt(b.timestamp) };
    },
    call: (to, data, blockHex) => rpc('eth_call', [{ to, data }, blockHex]),
    getCode: (addr, blockHex) => rpc('eth_getCode', [addr, blockHex]),
  };
}

// Read everything the checks need at ONE block, so treasury, liabilities and the clock agree with each other.
export async function readFarmRaw(rpc, manager = FARM_MANAGER_MAINNET) {
  const blk = await rpc.latestBlock();
  const tag = '0x' + blk.number.toString(16);
  const code = await rpc.getCode(manager, tag);
  if (!code || code === '0x') return { manager, blockNumber: blk.number, timestamp: blk.timestamp, codeMissing: true };
  const c = (data, to = manager) => rpc.call(to, data, tag);
  const [gov, pendingGov, rate, periodFinish, totalAllocPoint, poolLength, pool, rewardAsset, rewardToken] = await Promise.all([
    c(SEL.gov), c(SEL.pendingGov), c(SEL.rate), c(SEL.periodFinish), c(SEL.totalAllocPoint), c(SEL.poolLength),
    c(SEL.POOL), c(SEL.REWARD_ASSET), c(SEL.REWARD_TOKEN),
  ]);
  const poolAddr = addrOf(pool);
  const n = Number(uintOf(poolLength));
  if (!Number.isSafeInteger(n) || n > 64) throw new Error('implausible poolLength');
  const [treasury, ...infos] = await Promise.all([
    c(SEL.farmTreasury + pad32(BigInt(manager)), poolAddr),
    ...Array.from({ length: n }, (_, pid) => c(SEL.poolInfo + pad32(BigInt(pid)))),
  ]);
  // Reserves of each known launch pool, at the same block. Best effort: a pool that cannot be read reports none.
  const amms = await Promise.all(infos.map(async (h) => {
    const poolId = LAUNCH_POOL_IDS[bytes32Of(h)];
    if (!poolId) return null;
    try {
      const r = await c(SEL.pools + poolId.slice(2), poolAddr);
      if (String(r || '').length < 2 + 64 * 7 || uintOf(r, 0) === 0n) return { poolId, reserves: null };
      return { poolId, feeBps: Number(uintOf(r, 5)), reserves: {
        assetA: '0x' + wordOf(r, 1), assetB: '0x' + wordOf(r, 2), reserveA: uintOf(r, 3), reserveB: uintOf(r, 4), lpTotalShares: uintOf(r, 6),
      } };
    } catch { return { poolId, reserves: null }; }
  }));
  return {
    manager, blockNumber: blk.number, timestamp: blk.timestamp, codeMissing: false,
    gov: addrOf(gov), pendingGov: addrOf(pendingGov),
    rate: uintOf(rate), periodFinish: uintOf(periodFinish), totalAllocPoint: uintOf(totalAllocPoint),
    pool: poolAddr, rewardAsset: bytes32Of(rewardAsset), rewardToken: addrOf(rewardToken),
    treasury: uintOf(treasury),
    pools: infos.map((h, i) => ({
      stakeAsset: bytes32Of(h), totalShares: uintOf(h, 1), rps: uintOf(h, 2), totalRewardDebt: uintOf(h, 3),
      allocPoint: uintOf(h, 4), lastUpdate: uintOf(h, 5), lockDuration: uintOf(h, 6), amm: amms[i],
    })),
  };
}

// Reward every live position could claim at `now`: the contract's stored per-pool accumulator advanced to the
// present exactly as its own accrual does, rounded up per pool.
function outstandingAt(raw, now) {
  const applicable = now < raw.periodFinish ? now : raw.periodFinish;
  let total = 0n;
  for (const p of raw.pools) {
    let rps = p.rps;
    if (p.totalShares !== 0n && raw.totalAllocPoint !== 0n && p.allocPoint !== 0n && applicable > p.lastUpdate) {
      rps += (raw.rate * p.allocPoint * (applicable - p.lastUpdate) * PRECISION) / (raw.totalAllocPoint * p.totalShares);
    }
    const x = rps * p.totalShares - p.totalRewardDebt;
    total += (x + PRECISION - 1n) / PRECISION;
  }
  return total;
}

const bps2 = (num, den) => (den === 0n ? '0' : fmtUnits((num * 10000n) / den, 2));

// The public program document (all money as decimal strings). Every amount is TAC unless the name says Units.
export function buildProgram(raw, { network = 'mainnet' } = {}) {
  const now = raw.timestamp;
  const remaining = raw.periodFinish > now ? raw.periodFinish - now : 0n;
  const active = raw.rate > 0n && remaining > 0n;
  const outstanding = outstandingAt(raw, now);
  const owed = outstanding + raw.rate * remaining;
  const surplus = raw.treasury > outstanding ? raw.treasury - outstanding : 0n;
  const dayUnits = raw.rate * BigInt(DAY);
  const poolDayUnits = (p) => (raw.totalAllocPoint === 0n ? 0n : (dayUnits * p.allocPoint) / raw.totalAllocPoint);
  return {
    network,
    manager: raw.manager,
    rewardAsset: raw.rewardAsset,
    rewardToken: raw.rewardToken,
    gov: raw.gov,
    pendingGov: raw.pendingGov,
    epoch: {
      active,
      ratePerSecUnits: raw.rate.toString(),
      ratePerDayTac: fmtUnits(dayUnits),
      periodFinish: Number(raw.periodFinish),
      remainingSeconds: Number(remaining),
      treasuryTac: fmtUnits(raw.treasury),
      outstandingTac: fmtUnits(outstanding),
      requiredTac: fmtUnits(owed),
      fundedRunwaySeconds: raw.rate === 0n ? null : Number(surplus / raw.rate),
    },
    pools: raw.pools.map((p, pid) => ({
      pid,
      pair: LAUNCH_POOLS[p.stakeAsset] || `pid ${pid}`,
      lpAsset: p.stakeAsset,
      allocPoint: Number(p.allocPoint),
      sharePct: bps2(p.allocPoint, raw.totalAllocPoint),
      totalShares: p.totalShares.toString(),
      idle: p.totalShares === 0n,
      tacPerDayForPool: fmtUnits(poolDayUnits(p)),
      lockSeconds: Number(p.lockDuration),
      // The confidential pool behind the LP asset. Reserves are in pool units (8 decimals), read at `block`.
      poolId: p.amm ? p.amm.poolId : null,
      feeBps: p.amm && p.amm.reserves ? p.amm.feeBps : null,
      reserves: p.amm && p.amm.reserves ? {
        assetA: p.amm.reserves.assetA, assetB: p.amm.reserves.assetB,
        reserveA: p.amm.reserves.reserveA.toString(), reserveB: p.amm.reserves.reserveB.toString(),
        lpTotalShares: p.amm.reserves.lpTotalShares.toString(),
      } : null,
    })),
    block: Number(raw.blockNumber),
    // Internal, stripped before serving: exact integers the health checks compare.
    _n: { now, remaining, active, outstanding, owed, treasury: raw.treasury, rate: raw.rate, totalAlloc: raw.totalAllocPoint,
          poolDay: raw.pools.map(poolDayUnits) },
  };
}

export const publicProgram = ({ _n, ...rest }) => rest;

const ZERO_ADDR = '0x' + '0'.repeat(40);
const dur = (s) => {
  s = Number(s);
  if (s >= 2 * DAY) return `${(s / DAY).toFixed(1)}d`;
  if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${s}s`;
};

const RANK = { ok: 0, warn: 1, critical: 2 };
const worst = (checks) => checks.reduce((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'ok');

// checks[] and an overall status from a built program (or the codeMissing marker of a manager with no code).
export function farmHealth(program) {
  if (program.codeMissing) {
    const checks = [{ name: 'manager', status: 'critical', detail: `no contract code at ${program.manager}` }];
    return { status: 'critical', checks };
  }
  const n = program._n;
  const checks = [{ name: 'manager', status: 'ok', detail: `${program.manager} at block ${program.block}` }];

  const short = n.owed - n.treasury;
  checks.push(short > 0n
    ? { name: 'solvency', status: 'critical', detail: `treasury ${fmtUnits(n.treasury)} TAC is short of ${fmtUnits(n.owed)} TAC owed (earned ${fmtUnits(n.outstanding)} + remaining emission) by ${fmtUnits(short)} TAC` }
    : { name: 'solvency', status: 'ok', detail: `treasury ${fmtUnits(n.treasury)} TAC covers ${fmtUnits(n.owed)} TAC owed` });

  const ended = n.remaining === 0n;
  let runway;
  if (ended) runway = { status: 'warn', detail: n.rate === 0n && program.epoch.periodFinish === 0 ? 'no epoch has been started — top-up needed' : 'epoch finished — top-up needed' };
  else if (Number(n.remaining) < RUNWAY_CRITICAL_SECS) runway = { status: 'critical', detail: `${dur(n.remaining)} of emission left (< 3d) — top up now` };
  else if (Number(n.remaining) < RUNWAY_WARN_SECS) runway = { status: 'warn', detail: `${dur(n.remaining)} of emission left (< 14d) — schedule a top-up` };
  else runway = { status: 'ok', detail: `${dur(n.remaining)} of emission left` };
  checks.push({ name: 'runway', ...runway });

  checks.push(n.rate === 0n && !ended
    ? { name: 'emission', status: 'critical', detail: 'rate is 0 while the epoch is still running — nothing is streaming' }
    : { name: 'emission', status: 'ok', detail: `${program.epoch.ratePerDayTac} TAC/day${n.active ? '' : ' (not active)'}` });

  const idle = program.pools.filter((p) => p.allocPoint > 0 && p.idle);
  if (idle.length) {
    const wasted = idle.reduce((a, p) => a + (n.active ? n.poolDay[p.pid] : 0n), 0n);
    checks.push({ name: 'idle-pools', status: 'warn',
      detail: `${idle.map((p) => `${p.pair} (pid ${p.pid})`).join(', ')} funded with no stake${n.active ? `; ${fmtUnits(wasted)} TAC/day going unearned` : ''}` });
  } else checks.push({ name: 'idle-pools', status: 'ok', detail: 'every weighted pool has stake' });

  checks.push(program.pendingGov !== ZERO_ADDR
    ? { name: 'governor', status: 'warn', detail: `governor handover awaiting acceptance by ${program.pendingGov}` }
    : { name: 'governor', status: 'ok', detail: `governor ${program.gov}` });

  return { status: worst(checks), checks };
}

// One call for the CLI and the monitor: read, build, judge.
export async function checkFarm({ rpc, manager = FARM_MANAGER_MAINNET, network = 'mainnet' }) {
  const raw = await readFarmRaw(rpc, manager);
  const program = raw.codeMissing ? raw : buildProgram(raw, { network });
  return { program, health: farmHealth(program) };
}
