// Read-only view of the launch farm program: the FarmManager singleton (one reward stream split across several
// LP-share pools by allocation weight) and the pool treasury that backs it. Everything is one JSON-RPC surface —
// `rpc(method, params)` — batched through Multicall3 (falling back to parallel eth_calls), so a dapp, a dashboard
// or an integrator can read the live emission, per-pool weights and idle state, and a position's pending yield,
// without any wallet or proof machinery.
//
// Standalone farms (`config.standalone`): a FarmController per LP-share pool, with its own wTAC treasury and rate, never
// sharing the launch farm's stream. They are listed with the manager's pools (each pool carries its `controller`, and a
// standalone one its own `epoch`), under pids from STANDALONE_PID up. A controller keeps each receipt's checkpoint but
// not its shares, so a standalone position's pending is computed here from the shares the holder knows:
// shares · (currentRps − entryRps) / 2^64.
//
// Units: the manager streams the reward in the pool's value units (`unitScale` base units of the reward token
// each — 1e10 for wTAC, i.e. 1e-8 TAC), so `rate` is value units per second. All money math here is BigInt; the
// only non-integer outputs are display strings.

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SEL = {
  gov: '12d43a51', pendingGov: '25240810', rate: '2c4e722e', periodFinish: 'ebe2b12b',
  totalAllocPoint: '17caf6f1', poolLength: '081e3eda', outstandingReward: '0efc9dc3',
  farmTreasury: '48aa7283', poolInfo: '1526fe27', pending: '1808eeb8', positions: '514ea4bf',
  pidOf: '3717b324', pools: 'b5217bb4', blockTimestamp: '0f28c97d', aggregate3: '82ad56cb',
  totalShares: '3a98ef39', currentRps: 'f98eb2b1', entryRps: '4c094ad8', entryStamped: 'fce4db90', lockUntil: '3c78929e',
};
export const STANDALONE_PID = 1000;
const RPS_PRECISION = 2n ** 64n;
const DAY = 86400n;
const YEAR = 365n * DAY;

const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => (typeof v === 'bigint' ? v.toString(16) : strip(v)).padStart(64, '0');
const addr = (a) => '0x' + strip(a).toLowerCase().padStart(40, '0').slice(-40);
const wordAt = (hex, i) => BigInt('0x' + (hex.slice(i * 64, i * 64 + 64) || '0'));
const isHex32 = (v) => /^0x[0-9a-fA-F]{64}$/.test(String(v || ''));

// aggregate3((address target, bool allowFailure, bytes callData)[]) — encoded by hand so the module has no ABI dependency.
function encodeAggregate3(calls) {
  const bodies = calls.map(({ to, data }) => {
    const d = strip(data);
    const padded = d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    return word(addr(to)) + word(1n) + word(0x60n) + word(BigInt(d.length / 2)) + padded;
  });
  let off = BigInt(calls.length) * 32n;
  const offsets = bodies.map((b) => { const o = off; off += BigInt(b.length / 2); return word(o); });
  return '0x' + SEL.aggregate3 + word(0x20n) + word(BigInt(calls.length)) + offsets.join('') + bodies.join('');
}

// Result[] = (bool success, bytes returnData)[] → each call's return hex ('' on failure).
function decodeAggregate3(result, n) {
  const hex = strip(result);
  const arr = Number(wordAt(hex, 0)) * 2;
  if (Number(wordAt(hex, arr / 64)) !== n) throw new Error('multicall: result length mismatch');
  const base = arr + 64;
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = base + Number(wordAt(hex, (arr + 64) / 64 + i)) * 2;
    const ok = wordAt(hex, at / 64) === 1n;
    const rel = Number(wordAt(hex, at / 64 + 1)) * 2;
    const len = Number(wordAt(hex, (at + rel) / 64)) * 2;
    out.push(ok ? hex.slice(at + rel + 64, at + rel + 64 + len) : '');
  }
  return out;
}

// units → decimal string of the reward token: units × unitScale base units, at `decimals`, trailing zeros trimmed.
export function formatUnits(units, unitScale = 10n ** 10n, decimals = 18) {
  const base = BigInt(units) * BigInt(unitScale);
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const pctString = (num, den) => {
  if (den === 0n) return '0.00';
  const bps = (num * 10000n) / den;
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, '0')}`;
};

export function makeConfidentialFarmProgram({ rpc, config, multicall = MULTICALL3 } = {}) {
  if (typeof rpc !== 'function') throw new Error('farm-program: rpc(method, params) required');
  if (!config || !config.manager) throw new Error('farm-program: farm config (manager) required');
  const manager = addr(config.manager);
  const pool = config.pool ? addr(config.pool) : null;
  const unitScale = BigInt(config.unitScale || 10n ** 10n);
  const decimals = Number(config.rewardDecimals ?? 18);
  const fmt = (units) => formatUnits(units, unitScale, decimals);
  const cfgPools = config.pools || [];
  const byLp = new Map(cfgPools.map((p) => [String(p.lpAsset).toLowerCase(), p]));
  const solo = (config.standalone || []).map((f, i) => ({ ...f, pid: STANDALONE_PID + i, controller: addr(f.controller), lpAsset: String(f.lpAsset).toLowerCase() }));
  const soloByLp = new Map(solo.map((f) => [f.lpAsset, f]));
  // the controller that holds positions in an LP-share asset: a standalone farm's own, else the manager
  const controllerOf = (lpAsset) => (soloByLp.get(String(lpAsset || '').toLowerCase())?.controller) || manager;

  const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

  // One Multicall3 round; falls back to parallel eth_calls if the aggregator is unavailable.
  async function batch(calls) {
    if (!calls.length) return [];
    try {
      const res = await ethCall(multicall, encodeAggregate3(calls));
      return decodeAggregate3(res, calls.length);
    } catch {
      return Promise.all(calls.map(async (c) => { try { return strip(await ethCall(addr(c.to), c.data)); } catch { return ''; } }));
    }
  }
  const need = (hex, what) => { if (!hex) throw new Error(`farm-program: ${what} read failed`); return hex; };
  const mgr = (sig, arg = '') => ({ to: manager, data: '0x' + SEL[sig] + arg });

  async function program() {
    const head = await batch([
      mgr('gov'), mgr('pendingGov'), mgr('rate'), mgr('periodFinish'), mgr('totalAllocPoint'),
      mgr('poolLength'), mgr('outstandingReward'),
      { to: multicall, data: '0x' + SEL.blockTimestamp },
      ...(pool ? [{ to: pool, data: '0x' + SEL.farmTreasury + word(manager) }] : []),
    ]);
    const [gov, pendingGov, rateH, finishH, allocH, lenH, outH, tsH, treasH] = head;
    const rate = wordAt(need(rateH, 'rate'), 0);
    const periodFinish = wordAt(need(finishH, 'periodFinish'), 0);
    const totalAlloc = wordAt(need(allocH, 'totalAllocPoint'), 0);
    const n = Number(wordAt(need(lenH, 'poolLength'), 0));
    const now = tsH ? wordAt(tsH, 0) : BigInt(Math.floor(Date.now() / 1000));
    const infos = await batch(Array.from({ length: n }, (_, pid) => mgr('poolInfo', word(BigInt(pid)))));
    const active = now < periodFinish;
    const remaining = active ? periodFinish - now : 0n;
    const perSec = active ? rate : 0n;

    const pools = infos.map((h, pid) => {
      need(h, `poolInfo(${pid})`);
      const lpAsset = '0x' + h.slice(0, 64);
      const totalShares = wordAt(h, 1);
      const allocPoint = wordAt(h, 4);
      const lockSeconds = Number(wordAt(h, 6));
      const meta = byLp.get(lpAsset.toLowerCase()) || {};
      const idle = totalShares === 0n;
      const unitsPerDay = idle || totalAlloc === 0n ? 0n : (perSec * DAY * allocPoint) / totalAlloc;
      return {
        pid, pair: meta.pair || null, poolId: meta.poolId || null, lpAsset,
        allocPoint: Number(allocPoint), sharePct: pctString(allocPoint, totalAlloc),
        totalShares: totalShares.toString(), idle, tacPerDayForPool: fmt(unitsPerDay), lockSeconds,
      };
    });
    for (const p of pools) p.controller = manager;
    pools.push(...(await soloPools(now)));
    const word0 = (h) => (h ? addr('0x' + h.slice(24, 64)) : null);
    return {
      manager, rewardAsset: config.rewardAsset || null, gov: word0(gov), pendingGov: word0(pendingGov),
      epoch: {
        active, rate: rate.toString(), ratePerDayTac: fmt(perSec * DAY), periodFinish: Number(periodFinish),
        remainingSeconds: Number(remaining),
        treasuryTac: treasH ? fmt(wordAt(treasH, 0)) : null,
        treasuryUnits: treasH ? wordAt(treasH, 0).toString() : null,
        outstandingTac: fmt(wordAt(need(outH, 'outstandingReward'), 0)),
        outstandingUnits: wordAt(outH, 0).toString(),
      },
      pools,
    };
  }

  // Each standalone farm, read as a pool row of its own: its stream, its treasury, its period.
  async function soloPools(now) {
    if (!solo.length) return [];
    const rows = await batch(solo.flatMap((f) => [
      { to: f.controller, data: '0x' + SEL.rate }, { to: f.controller, data: '0x' + SEL.periodFinish }, { to: f.controller, data: '0x' + SEL.totalShares },
      { to: f.controller, data: '0x' + SEL.lockUntil }, { to: f.controller, data: '0x' + SEL.outstandingReward },
      ...(pool ? [{ to: pool, data: '0x' + SEL.farmTreasury + word(f.controller) }] : [{ to: f.controller, data: '0x' + SEL.rate }]),
    ]));
    return solo.map((f, i) => {
      const [rateH, finH, tsH, lockH, outH, trH] = rows.slice(i * 6, i * 6 + 6);
      const rate = rateH ? wordAt(rateH, 0) : 0n, finish = finH ? wordAt(finH, 0) : 0n, totalShares = tsH ? wordAt(tsH, 0) : 0n;
      const active = now < finish, perSec = active ? rate : 0n, lockUntil = lockH ? Number(wordAt(lockH, 0)) : 0;
      return {
        pid: f.pid, pair: f.pair || null, poolId: f.poolId || null, lpAsset: f.lpAsset, controller: f.controller, standalone: true,
        allocPoint: null, sharePct: null, totalShares: totalShares.toString(), idle: totalShares === 0n,
        tacPerDayForPool: fmt(perSec * DAY), lockSeconds: Math.max(0, lockUntil - Number(now)),
        epoch: {
          active, rate: rate.toString(), ratePerDayTac: fmt(perSec * DAY), periodFinish: Number(finish),
          remainingSeconds: Number(active ? finish - now : 0n),
          treasuryTac: pool && trH ? fmt(wordAt(trH, 0)) : null, treasuryUnits: pool && trH ? wordAt(trH, 0).toString() : null,
          outstandingTac: outH ? fmt(wordAt(outH, 0)) : null, outstandingUnits: outH ? wordAt(outH, 0).toString() : null,
        },
      };
    });
  }

  // A standalone position: live while the controller holds its checkpoint; pending from the shares the holder knows.
  async function soloPosition(f, receiptLeaf, shares) {
    const [stH, eH, rpsH, lockH] = await batch([
      { to: f.controller, data: '0x' + SEL.entryStamped + word(receiptLeaf) }, { to: f.controller, data: '0x' + SEL.entryRps + word(receiptLeaf) },
      { to: f.controller, data: '0x' + SEL.currentRps }, { to: f.controller, data: '0x' + SEL.lockUntil },
    ]);
    need(stH, 'entryStamped'); need(eH, 'entryRps'); need(rpsH, 'currentRps');
    const live = wordAt(stH, 0) === 1n, entry = wordAt(eH, 0), rps = wordAt(rpsH, 0);
    const s = BigInt(shares || 0);
    const units = live && rps > entry ? (s * (rps - entry)) / RPS_PRECISION : 0n;
    return {
      receiptLeaf: '0x' + strip(receiptLeaf).toLowerCase(), live, entryRps: entry.toString(), shares: s.toString(),
      unlockAt: lockH ? Number(wordAt(lockH, 0)) : 0, pid: f.pid, controller: f.controller, standalone: true,
      pendingUnits: units.toString(), pendingTac: fmt(units),
    };
  }

  // Live yield of one position, keyed by its RECEIPT leaf (the manager's position key), in value units.
  async function pending(receiptLeaf) {
    if (!isHex32(receiptLeaf)) throw new Error('farm-program: receipt leaf must be a 32-byte hex');
    const h = need(strip(await ethCall(manager, '0x' + SEL.pending + word(receiptLeaf))), 'pending');
    const units = wordAt(h, 0);
    return { units: units.toString(), tac: fmt(units) };
  }

  // `opts.lpAsset` names a standalone farm's position, whose shares (`opts.shares`) the controller does not keep.
  async function position(receiptLeaf, opts = {}) {
    if (!isHex32(receiptLeaf)) throw new Error('farm-program: receipt leaf must be a 32-byte hex');
    const f = opts.lpAsset ? soloByLp.get(String(opts.lpAsset).toLowerCase()) : null;
    if (f) return soloPosition(f, receiptLeaf, opts.shares);
    const [p, q] = await batch([mgr('positions', word(receiptLeaf)), mgr('pending', word(receiptLeaf))]);
    need(p, 'positions');
    const units = wordAt(need(q, 'pending'), 0);
    return {
      receiptLeaf: '0x' + strip(receiptLeaf).toLowerCase(), live: wordAt(p, 4) === 1n,
      entryRps: wordAt(p, 0).toString(), shares: wordAt(p, 1).toString(), unlockAt: Number(wordAt(p, 2)),
      pid: Number(wordAt(p, 3)), controller: manager, pendingUnits: units.toString(), pendingTac: fmt(units),
    };
  }

  // The pid the manager assigned to an LP-share asset, or null when the manager has no pool for it.
  async function pidOf(lpAsset) {
    const f = soloByLp.get(String(lpAsset || '').toLowerCase());
    if (f) return f.pid;
    const h = need(strip(await ethCall(manager, '0x' + SEL.pidOf + word(lpAsset))), 'pidOf');
    return wordAt(h, 1) === 1n ? Number(wordAt(h, 0)) : null;
  }

  // The raw inputs an APR needs, without picking a price: each pool's emission over a year in value units, the
  // stake the manager holds, and the AMM's own reserves/supply so a UI can value one LP share in any numeraire.
  async function aprInputs() {
    const prog = await program();
    const perSec = BigInt(prog.epoch.active ? prog.epoch.rate : 0);
    const totalAlloc = prog.pools.filter((p) => !p.standalone).reduce((s, p) => s + BigInt(p.allocPoint), 0n);
    const withAmm = pool ? prog.pools.filter((p) => p.poolId) : [];
    const ammRows = await batch(withAmm.map((p) => ({ to: pool, data: '0x' + SEL.pools + word(p.poolId) })));
    const amm = new Map(withAmm.map((p, i) => [p.pid, ammRows[i]]));
    return {
      unitScale: unitScale.toString(), rewardDecimals: decimals, epochActive: prog.epoch.active,
      remainingSeconds: prog.epoch.remainingSeconds,
      pools: prog.pools.map((p) => {
        const h = amm.get(p.pid);
        const live = !!h && h.length >= 64 * 7 && wordAt(h, 0) !== 0n;
        const staked = BigInt(p.totalShares);
        const unitsPerYear = p.standalone ? (p.epoch.active && !p.idle ? BigInt(p.epoch.rate) * YEAR : 0n)
          : p.idle || totalAlloc === 0n ? 0n : (perSec * YEAR * BigInt(p.allocPoint)) / totalAlloc;
        return {
          pid: p.pid, pair: p.pair, poolId: p.poolId, lpAsset: p.lpAsset, idle: p.idle, controller: p.controller, standalone: !!p.standalone,
          stakedShares: p.totalShares, tacPerYearUnits: unitsPerYear.toString(), tacPerYear: fmt(unitsPerYear),
          amm: live ? {
            assetA: '0x' + h.slice(64, 128), assetB: '0x' + h.slice(128, 192),
            reserveA: wordAt(h, 3).toString(), reserveB: wordAt(h, 4).toString(),
            feeBps: Number(wordAt(h, 5)), totalShares: wordAt(h, 6).toString(),
            stakedPct: pctString(staked, wordAt(h, 6)),
          } : null,
        };
      }),
    };
  }

  return { program, pending, position, pidOf, aprInputs, controllerOf, standalone: solo };
}
