// Read-only view of everything the ops multisig controls, for the dapp's Govern tab: who holds each role,
// the live parameters behind it, and anything queued to change. GET /governance/oversight?network=mainnet.
//
// Nothing here can move or change anything. It exists so holders can see what governance is overseeing,
// and propose against it, without reading contracts by hand. Values come straight from chain reads;
// a read that fails shows as null rather than a guess.

const MAINNET = {
  ops: '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2',
  pool: '0x000000000Ed1eabD231Be41d93b719056F7febFC',
  engine: '0x000000003f608BDdF0ca45934003ffb9DbDF70DB',
  farmManager: '0x000031C47Cb61faB1CE2790a69625FABB71EDE24',
  farmDeployBlock: 26021083,
  airdrop: '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8',
  tac: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279',
  buyback: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250',
  pointsDistributor: '0x000000C918e44A3a443937fA7594eA4f7C95D6b9',
  relay: '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7',
  // The points program: 100,000 TAC over 90 days (README "Points and farms").
  pointsTacPerDay: 100_000 / 90,
  pointsEndsAt: Date.UTC(2026, 11, 22) / 1000,
};
const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
const CACHE_MS = 60_000;
const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

export function buildOversight({ ethCall, ethGetBalance, keccak256, jsonResponse, fetchImpl = fetch }) {
  const enc = (s) => new TextEncoder().encode(s);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const sel = (sig) => '0x' + hex(keccak256(enc(sig))).slice(0, 8);
  const word = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const cache = new Map(); // network -> { at, body }

  async function uint(network, to, sig, arg = null) {
    const r = await ethCall(network, to, sel(sig) + (arg ? word(arg) : ''));
    if (!r || !/^0x[0-9a-fA-F]+$/.test(r) || r === '0x') return null;
    try { return BigInt(r.slice(0, 66)); } catch { return null; }
  }
  async function addr(network, to, sig) {
    const v = await uint(network, to, sig);
    return v === null ? null : '0x' + v.toString(16).padStart(40, '0');
  }
  const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const units = (v, dec, dp = 2) => {
    if (v === null) return null;
    const s = v.toString().padStart(dec + 1, '0');
    const whole = s.slice(0, -dec) || '0', frac = s.slice(-dec).slice(0, dp);
    return `${BigInt(whole).toLocaleString('en-US')}${dp ? '.' + frac : ''}`;
  };
  const bps = (v) => (v === null ? null : `${(Number(v) / 100).toFixed(2)}%`);
  const date = (t) => (t === null || t === 0n ? null : new Date(Number(t) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
  function apy(perSecondRay) {
    if (perSecondRay === null) return null;
    if (perSecondRay === 0n || perSecondRay === RAY) return 'off (0%)';
    // From the per-second excess over 1, which a double holds precisely; (1 + r)^year via log1p/expm1.
    const r = Number(perSecondRay - RAY) / 1e27;
    return `${(Math.expm1(Math.log1p(r) * SECONDS_PER_YEAR) * 100).toFixed(2)}% a year`;
  }

  // FarmManager's queue lives in ConfigQueued events; an entry still counts only while queuedAt(id) is set.
  async function farmQueue(network, c) {
    try {
      const out = [];
      const res = await fetchImpl(`${BLOCKSCOUT}/addresses/${c.farmManager}/logs`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const items = (await res.json()).items || [];
      for (const it of items) {
        if (!it.decoded || !String(it.decoded.method_call).startsWith('ConfigQueued(')) continue;
        if (Number(it.block_number) < c.farmDeployBlock) continue;
        const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
        const eta = await uint(network, c.farmManager, 'queuedAt(bytes32)', p.id);
        if (eta && eta > 0n) out.push({ label: `Queued config ${String(p.id).slice(0, 10)}…`, value: `executable from ${date(eta)}`, tx: it.transaction_hash });
      }
      return out;
    } catch { return null; }
  }

  // Every page of a Blockscout listing, bounded. Null when the listing cannot be read at all.
  async function pages(url, max = 10) {
    const out = [];
    let q = '';
    for (let i = 0; i < max; i++) {
      const res = await fetchImpl(url + q, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return i === 0 ? null : out;
      const j = await res.json();
      out.push(...(j.items || []));
      if (!j.next_page_params) break;
      q = (url.includes('?') ? '&' : '?') + new URLSearchParams(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)])).toString();
    }
    return out;
  }

  // TAC coming back to the reserve: TacBuyback purchases (its Bought events) and relay fees paid in TAC (TAC
  // transfers from the relay wallet to the reserve). All time and the last 7 days.
  async function tacFlows(c) {
    try {
      const weekAgo = Date.now() / 1000 - 7 * 86400;
      const [logs, transfers] = await Promise.all([
        pages(`${BLOCKSCOUT}/addresses/${c.buyback}/logs`),
        pages(`${BLOCKSCOUT}/addresses/${c.relay}/token-transfers?type=ERC-20&token=${c.tac}`),
      ]);
      if (logs === null || transfers === null) return null;
      const f = { bought: 0n, bought7: 0n, buys: 0, swept: 0n, swept7: 0n };
      for (const it of logs) {
        if (!it.decoded || !String(it.decoded.method_call).startsWith('Bought(')) continue;
        const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
        const v = BigInt(p.tacOut || 0);
        f.bought += v; f.buys += 1;
        if (Date.parse(it.block_timestamp) / 1000 >= weekAgo) f.bought7 += v;
      }
      for (const t of transfers) {
        if (!eq(t.from?.hash, c.relay) || !eq(t.to?.hash, c.ops)) continue;
        const v = BigInt(t.total?.value || 0);
        f.swept += v;
        if (Date.parse(t.timestamp) / 1000 >= weekAgo) f.swept7 += v;
      }
      return f;
    } catch { return null; }
  }

  async function snapshot(network) {
    const c = MAINNET;
    const [
      engineOwner, escrowRatio, cdpRatio, liqRatio, maxStale, maxDev, sfps, outstanding, surplus, savingsShares,
      insurance, escrowMaint, graceWindow, enforcement, feedChangeAt, wstEthBtcFeed, btcUsdFeed,
      farmGov, farmPendingGov, farmRate, farmFinish, farmPools, farmUnitScale,
      airdropGuardian, airdropPaused, airdropDeadline, airdropTac,
      successor,
      opsTac, opsEth, buybackEth, lastBuyAt, pointsTac,
      queue,
    ] = await Promise.all([
      addr(network, c.engine, 'owner()'), uint(network, c.engine, 'escrowRatioBps()'), uint(network, c.engine, 'cdpRatioBps()'),
      uint(network, c.engine, 'liqRatioBps()'), uint(network, c.engine, 'maxStaleness()'), uint(network, c.engine, 'maxDeviationBps()'),
      uint(network, c.engine, 'stabilityFeePerSecond()'), uint(network, c.engine, 'outstandingCusd()'), uint(network, c.engine, 'surplusFeeCusd()'),
      uint(network, c.engine, 'totalSavingsShares()'), uint(network, c.engine, 'insuranceReserve()'), uint(network, c.engine, 'escrowMaintenanceBps()'),
      uint(network, c.engine, 'escrowGraceWindow()'), addr(network, c.engine, 'escrowEnforcementModule()'), uint(network, c.engine, 'lastFeedChangeAt()'),
      addr(network, c.engine, 'wstEthBtcFeed()'), addr(network, c.engine, 'btcUsdFeed()'),
      addr(network, c.farmManager, 'gov()'), addr(network, c.farmManager, 'pendingGov()'), uint(network, c.farmManager, 'rate()'),
      uint(network, c.farmManager, 'periodFinish()'), uint(network, c.farmManager, 'poolLength()'), uint(network, c.farmManager, 'UNIT_SCALE()'),
      addr(network, c.airdrop, 'GUARDIAN()'), uint(network, c.airdrop, 'paused()'), uint(network, c.airdrop, 'CLAIM_DEADLINE()'),
      uint(network, c.tac, 'balanceOf(address)', c.airdrop),
      addr(network, c.pool, 'successor()'),
      uint(network, c.tac, 'balanceOf(address)', c.ops), ethGetBalance(network, c.ops), ethGetBalance(network, c.buyback),
      uint(network, c.buyback, 'lastBuyAt()'), uint(network, c.tac, 'balanceOf(address)', c.pointsDistributor),
      farmQueue(network, c),
    ]);
    const flows = await tacFlows(c);
    const zero = '0x' + '0'.repeat(40);
    const farmTacPerDay = farmRate !== null && farmUnitScale !== null ? units(farmRate * farmUnitScale * 86400n, 18, 0) : null;

    const nowS = Date.now() / 1000;
    const pointsLive = nowS < c.pointsEndsAt;
    const farmPerDay = farmRate !== null && farmUnitScale !== null && farmFinish !== null && Number(farmFinish) > nowS
      ? Number(farmRate * farmUnitScale * 86400n / 10n ** 18n) : 0;
    const emitted7 = Math.round((farmPerDay + (pointsLive ? c.pointsTacPerDay : 0)) * 7);
    const tac0 = (v) => (v === null ? null : `${units(v, 18, 0)} TAC`);
    const sections = [
      {
        id: 'flows', title: 'TAC flows', category: 'treasury', target: c.buyback, informational: true,
        summary: 'TAC paid out as rewards, against TAC coming back to the reserve through buybacks and relay fees paid in TAC.',
        items: [
          { label: 'Farm rewards', value: farmPerDay ? `${Math.round(farmPerDay).toLocaleString('en-US')} TAC a day` : 'none running' },
          { label: 'Points rewards', value: pointsLive ? `${Math.round(c.pointsTacPerDay).toLocaleString('en-US')} TAC a day until ${date(BigInt(c.pointsEndsAt))}` : 'program ended' },
          { label: 'Bought back, all time', value: flows ? `${tac0(flows.bought)} (${flows.buys} buy${flows.buys === 1 ? '' : 's'})` : null, address: c.buyback },
          { label: 'Relay fees paid in TAC, to the reserve', value: flows ? tac0(flows.swept) : null },
          { label: 'Rewards at current rates', value: `≈ ${emitted7.toLocaleString('en-US')} TAC a week` },
          { label: 'Back to the reserve, last 7 days', value: flows ? tac0(flows.bought7 + flows.swept7) : null },
        ],
      },
      {
        id: 'treasury', title: 'Treasury and reserve', category: 'treasury', target: c.ops,
        controller: c.ops, controllerIsOps: true,
        summary: 'Protocol TAC and ETH, held by the ops multisig. Relay fees paid in TAC and TacBuyback purchases land here.',
        items: [
          { label: 'TAC held', value: opsTac === null ? null : `${units(opsTac, 18, 0)} TAC` },
          { label: 'ETH held', value: opsEth === null ? null : `${units(opsEth, 18, 4)} ETH` },
          { label: 'TacBuyback ETH waiting to buy', value: buybackEth === null ? null : `${units(buybackEth, 18, 4)} ETH`, address: c.buyback },
          { label: 'Last buyback', value: lastBuyAt === null ? null : (lastBuyAt === 0n ? 'none yet' : date(lastBuyAt)) },
          { label: 'Points rewards held for claims', value: pointsTac === null ? null : `${units(pointsTac, 18, 0)} TAC`, address: c.pointsDistributor },
        ],
      },
      {
        id: 'engine', title: 'CollateralEngine (cBTC and cUSD)', category: 'collateral-engine', target: c.engine,
        controller: engineOwner, controllerIsOps: eq(engineOwner, c.ops),
        summary: 'Prices, collateral ratios and the cUSD stability fee. Changes against borrowers wait out a notice period.',
        items: [
          { label: 'cBTC escrow ratio', value: bps(escrowRatio) },
          { label: 'cUSD mint ratio', value: bps(cdpRatio) },
          { label: 'cUSD liquidation ratio', value: bps(liqRatio) },
          { label: 'Stability fee', value: apy(sfps) },
          { label: 'cUSD outstanding', value: outstanding === null ? null : `${units(outstanding, 8)} cUSD` },
          { label: 'Stability-fee surplus', value: surplus === null ? null : `${units(surplus, 8)} cUSD` },
          { label: 'cUSD in the savings rate', value: savingsShares === null ? null : `${units(savingsShares, 8)} cUSD` },
          { label: 'Insurance reserve', value: insurance === null ? null : `${units(insurance, 18, 4)} wstETH` },
          { label: 'Escrow maintenance floor', value: escrowMaint === null ? null : (escrowMaint === 0n ? 'off' : bps(escrowMaint)) },
          { label: 'Escrow grace window', value: graceWindow === null ? null : `${(Number(graceWindow) / 86400).toFixed(1)} days` },
          { label: 'Escrow enforcement module', value: enforcement === null ? null : (enforcement === zero ? 'none (off)' : enforcement) },
          { label: 'Price feed staleness limit', value: maxStale === null ? null : `${Number(maxStale) / 60} min` },
          { label: 'Feed deviation bound', value: maxDev === null ? null : (maxDev === 0n ? 'off' : bps(maxDev)) },
          { label: 'wstETH/BTC feed', value: wstEthBtcFeed },
          { label: 'BTC/USD feed', value: btcUsdFeed },
          { label: 'Last feed change', value: feedChangeAt === null ? null : (feedChangeAt === 0n ? 'never' : date(feedChangeAt)) },
        ],
      },
      {
        id: 'farms', title: 'FarmManager (LP rewards)', category: 'parameter', target: c.farmManager,
        controller: farmGov, controllerIsOps: eq(farmGov, c.ops),
        summary: 'Reward weights across farm pools. A reweight is queued publicly for 7 days, moves a weight at most 25%, and can happen once every 30 days.',
        items: [
          { label: 'Rewards', value: farmTacPerDay === null ? null : `${farmTacPerDay} TAC a day` },
          { label: 'Current program ends', value: date(farmFinish) },
          { label: 'Pools', value: farmPools === null ? null : String(farmPools) },
          { label: 'Pending governor handover', value: farmPendingGov === null ? null : (farmPendingGov === zero ? 'none' : farmPendingGov) },
        ],
        pending: queue,
      },
      {
        id: 'airdrop', title: 'TacAirdrop', category: 'treasury', target: c.airdrop,
        controller: airdropGuardian, controllerIsOps: eq(airdropGuardian, c.ops),
        summary: 'The guardian can pause claims and sweep what is left after the deadline. It cannot change who is owed what.',
        items: [
          { label: 'Claims', value: airdropPaused === null ? null : (airdropPaused === 1n ? 'paused' : 'open') },
          { label: 'Claim deadline', value: date(airdropDeadline) },
          { label: 'Unclaimed TAC', value: airdropTac === null ? null : `${units(airdropTac, 18, 0)} TAC` },
        ],
      },
      {
        id: 'lineage', title: 'Pool succession', category: 'spec-amendment', target: c.pool,
        controller: c.ops, controllerIsOps: true,
        summary: 'The ops multisig can deploy the next pool once and choose its code. It cannot touch this pool’s funds, and users move over themselves.',
        items: [
          { label: 'Successor', value: successor === null ? null : (successor === zero ? 'none (this pool is current)' : successor) },
        ],
      },
    ];
    return {
      network, generated_at: Math.floor(Date.now() / 1000), ops_multisig: c.ops,
      note: 'Read-only. Proposals are advisory; the ops multisig carries out passed proposals.',
      sections,
    };
  }

  async function handle(req, env, url, network, cors) {
    if (url.pathname !== '/governance/oversight' || req.method !== 'GET') return null;
    if (network !== 'mainnet') return jsonResponse({ error: 'oversight is mainnet-only' }, 404, cors);
    const hit = cache.get(network);
    if (hit && Date.now() - hit.at < CACHE_MS) return jsonResponse(hit.body, 200, { ...cors, 'Cache-Control': 'public, max-age=60' });
    const body = await snapshot(network);
    cache.set(network, { at: Date.now(), body });
    return jsonResponse(body, 200, { ...cors, 'Cache-Control': 'public, max-age=60' });
  }

  return { handle, snapshot, MAINNET };
}
