import { MULTICALL3, TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID, _internal } from '/evm-trade-venues.js?cb=196b14fb';
import { keccak_256 } from '/vendor/tacit-deps.min.js';
import { ETH_LOG_NODES } from '/eth-nodes.js';
import { ethCall, rpc, wordAt, word, strip } from '/trade/util.js?cb=1d2cd8d3';
import { POOL, heldHistory } from '/teth/read.js?cb=44f2673f';
import { ENGINE, SPAN, filterFor, withTimes, eventsOf } from '/cbtc/events.js?cb=c1f0389c';
import { BASE } from '/cbtc/history-base.js?cb=e10ff809';

export { ENGINE };
export const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
export const CBTC_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
export const CUSD_ID = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d';
export const TAC_ID = TAC_POOL_ASSET_ID, CETH_ID = CETH_POOL_ASSET_ID;
const SEL = { cdpRatioBps: '0x4827ecb3', liqRatioBps: '0x1432d93f', btcToUsd: '0xd5901347', wstEthForBtc: '0x7dd55c2b', stEthPerWst: '0xbb2952fc', requiredEscrow: '0x034448ed',
  escrowSufficient: '0x058e18b0', cbtcLockVBtc: '0x7cea1c1a', cbtcMinted: '0xe2c2a40c', lockSpent: '0x993ed045', lockRedeemed: '0xb5229671', escrowTotal: '0xe06e89c9', pools: '0xb5217bb4' };
const BTC1 = 10n ** 8n;
const big = (x) => BigInt(x != null && typeof x === 'object' && '$n' in x ? x.$n : x ?? 0);

const batch = async (calls) => _internal.decAggregate3(await ethCall(MULTICALL3, _internal.encAggregate3(calls)), calls.length);

export function totalsOf(j) {
  const b = j?.btc;
  if (!b) return null;
  return { locked: big(b.locked), locks: Number(b.nLocked) || 0, minted: big(b.mint), mints: Number(b.nMint) || 0, bond: big(b.bonds), bonds: Number(b.nBonds) || 0,
    borrowed: big(b.borrowed), repaid: big(b.repaid), liquidated: big(b.liq), out: big(b.out), open: Number(b.open) || 0, redeemed: Number(b.redeemed) || 0, unlocked: Number(b.unlocked) || 0,
    waiting: Number(b.waiting) || 0, tacbtc: big(b.tacbtc), tacusd: big(b.tacusd) };
}

export async function readEngine() {
  const r = await batch([{ to: ENGINE, data: SEL.cdpRatioBps }, { to: ENGINE, data: SEL.liqRatioBps }, { to: ENGINE, data: SEL.btcToUsd + word(BTC1) },
    { to: ENGINE, data: SEL.wstEthForBtc + word(BTC1) }, { to: WSTETH, data: SEL.stEthPerWst + word(10n ** 18n) }]);
  const n = (i) => (r[i] ? wordAt(r[i], 0) : null);
  const wst = n(4) != null ? Number(n(4)) / 1e18 : null;
  return { ratio: n(0) != null ? Number(n(0)) / 100 : null, liq: n(1) != null ? Number(n(1)) / 100 : null, usdBtc: n(2) != null ? Number(n(2)) / 1e8 : null,
    ethBtc: n(3) != null && wst ? (Number(n(3)) / 1e18) * wst : null, wstEth: wst };
}
export async function sizeBond(sats) {
  const [need, rate] = await batch([{ to: ENGINE, data: SEL.requiredEscrow + word(sats) }, { to: WSTETH, data: SEL.stEthPerWst + word(10n ** 18n) }]);
  if (!need) return null;
  const wst = wordAt(need, 0), per = rate ? wordAt(rate, 0) : null;
  return { wst, eth: per != null ? (wst * per) / 10n ** 18n : null };
}

export function coverage(t, { ethUsd, usdBtc, wstEth }) {
  if (!t || !(t.locked > 0n) || !ethUsd || !usdBtc || !wstEth) return null;
  const bondUsd = Number(t.bond) / 1e18 * wstEth * ethUsd, lockUsd = Number(t.locked) / 1e8 * usdBtc;
  return { bondUsd, lockUsd, ratio: lockUsd > 0 ? bondUsd / lockUsd : null };
}

const hexBytes = (h) => Uint8Array.from(strip(h).match(/../g).map((x) => parseInt(x, 16)));
export function poolId(a, b, fee) {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a], u = new Uint8Array(96);
  u.set(hexBytes(lo), 0); u.set(hexBytes(hi), 32); u.set(hexBytes(word(fee)), 64);
  return Array.from(keccak_256(u), (x) => x.toString(16).padStart(2, '0')).join('');
}
const TIERS = [30, 5, 100, 1], OTHERS = [['tETH', CETH_ID], ['TAC', TAC_ID], ['cUSD', CUSD_ID]];
export async function readPools() {
  const asks = OTHERS.flatMap(([name, id]) => TIERS.map((fee) => ({ name, id, fee })));
  const r = await batch(asks.map((x) => ({ to: POOL, data: SEL.pools + poolId(CBTC_ID, x.id, x.fee) })));
  const out = [];
  asks.forEach((x, i) => {
    const h = r[i];
    if (!h || strip(h).length < 64 * 7 || wordAt(h, 0) === 0n) return;
    const a = wordAt(h, 3), b = wordAt(h, 4), total = wordAt(h, 6);
    if (a === 0n || b === 0n) return;
    const cbtcIsA = BigInt(CBTC_ID) < BigInt(x.id);
    out.push({ other: x.name, otherId: x.id, fee: x.fee, cbtc: Number(cbtcIsA ? a : b) / 1e8, side: Number(cbtcIsA ? b : a) / 1e8, lpTotal: Number(total) });
  });
  return out.filter((p, i, all) => all.findIndex((q) => q.other === p.other) === i);
}
export function poolRows(pools, program, { ethUsd, usdBtc, tacEth }) {
  return pools.map((p) => {
    const per = p.cbtc > 0 ? p.side / p.cbtc : null;
    const usd = per == null ? null : p.other === 'tETH' ? (ethUsd ? per * ethUsd : null) : p.other === 'TAC' ? (tacEth && ethUsd ? per * tacEth * ethUsd : null) : per;
    const sideUsd = p.other === 'tETH' ? ethUsd : p.other === 'TAC' ? (tacEth && ethUsd ? tacEth * ethUsd : null) : 1;               // dollars in one of the other side
    const depth = usdBtc && sideUsd != null ? p.cbtc * usdBtc + p.side * sideUsd : null;                                              // both sides, each at its own price
    const farm = (program?.pools || []).find((f) => String(f.pair).split('/').sort().join('/') === ['cBTC', p.other === 'tETH' ? 'cETH' : p.other].sort().join('/')) || null;
    return { ...p, name: `cBTC / ${p.other}`, per, usd, gap: usd != null && usdBtc ? usd / usdBtc - 1 : null, depthUsd: depth, farm: farm ? { pid: Number(farm.pid), perDay: Number(farm.tacPerDayForPool) || 0, shares: Number(farm.totalShares) || 0 } : null };
  });
}
export function farmApr(row, program, { ethUsd, tacEth }) {
  if (!row.farm || !(row.farm.perDay > 0) || !row.depthUsd || !ethUsd || !tacEth || !(row.lpTotal > 0)) return null;
  const bondedUsd = row.depthUsd * row.farm.shares / row.lpTotal;
  return bondedUsd > 0 ? (row.farm.perDay * 365 * tacEth * ethUsd) / bondedUsd * 100 : null;
}

// The engine's events are written down up to a settled block (history-base.js); the page reads the blocks after it, in ranges every node that serves old
// logs takes, three at a time, each kept in its place.
async function tailEvents(from) {
  const head = Number(BigInt(await rpc('eth_blockNumber', [], ETH_LOG_NODES))), spans = [];
  for (let f = from; f <= head; f += SPAN) spans.push([f, Math.min(f + SPAN - 1, head)]);
  const out = new Array(spans.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, spans.length) }, async () => {
    for (let j = next++; j < spans.length; j = next++) out[j] = await rpc('eth_getLogs', [filterFor(...spans[j])], ETH_LOG_NODES);
  }));
  return eventsOf(await withTimes(out.flat(), async (b) => Number(BigInt((await rpc('eth_getBlockByNumber', [b, false], ETH_LOG_NODES)).timestamp))));
}
// `partial` is set when the newest events could not be read: the history stops where the written-down part does, and `live` (read for the locks it knows) may miss a lock.
export async function readHistory({ locked, out }) {
  let tail = { posted: [], loans: [] }, partial = false;
  try { tail = await tailEvents(BASE.block + 1); } catch { partial = true; }
  const first = new Map();
  for (const [t, op] of [...BASE.posted, ...tail.posted]) if (!first.has(op)) first.set(op, t);
  const loans = [...BASE.loans, ...tail.loans].map(([t, v]) => [t, BigInt(v)]);
  const ops = [...first.keys()], reads = [];
  const per = [{ to: POOL, sel: SEL.cbtcLockVBtc }, { to: POOL, sel: SEL.lockSpent }, { to: POOL, sel: SEL.lockRedeemed }, { to: POOL, sel: SEL.cbtcMinted }, { to: ENGINE, sel: SEL.escrowTotal }];
  for (let i = 0; i < ops.length; i += 20) reads.push(...await batch(ops.slice(i, i + 20).flatMap((o) => per.map((x) => ({ to: x.to, data: x.sel + strip(o) })))));
  const w = (k) => (reads[k] ? wordAt(reads[k], 0) : 0n);
  const live = { locked: 0n, locks: 0, minted: 0n, mints: 0, bond: 0n, bonds: 0 };
  const locks = ops.flatMap((o, i) => {
    const v = w(5 * i);
    if (!(v > 0n) || w(5 * i + 1) !== 0n || w(5 * i + 2) !== 0n) return [];
    live.locked += v; live.locks++;
    if (w(5 * i + 3) === 1n) { live.minted += v; live.mints++; }
    const bond = w(5 * i + 4); if (bond > 0n) { live.bond += bond; live.bonds++; }
    return [[first.get(o), v]];
  }).sort((x, y) => x[0] - y[0]);
  return { locked: heldHistory(locks, locked), out: heldHistory(loans, out), live, partial };
}

export const lockStep = (l) => (l.minted ? 'minted' : !l.bonded ? 'post its bond' : !l.recorded ? 'waiting for its proof' : 'ready to mint');
export async function readLocks({ ux, priv, hist }) {
  const all = (await hist.locks(priv)).filter((l) => !l.spentBy);                // a lock whose output Bitcoin has spent is gone, before the pool records it
  if (!all.length) return [];
  const op = (l) => strip(ux.pool.outpointKey('0x' + l.lockTxid.match(/../g).reverse().join(''), l.lockVout));
  // one batch for every lock: what the pool records of it, whether it is spent or redeemed (those are left out), its bond and its mint
  const r = await batch(all.flatMap((l) => [{ to: POOL, data: SEL.cbtcLockVBtc + op(l) }, { to: POOL, data: SEL.lockSpent + op(l) }, { to: POOL, data: SEL.lockRedeemed + op(l) },
    { to: ENGINE, data: SEL.escrowSufficient + op(l) + word(l.vBtc) }, { to: POOL, data: SEL.cbtcMinted + op(l) }, { to: ENGINE, data: SEL.escrowTotal + op(l) }]));
  const w = (i) => (r[i] ? wordAt(r[i], 0) : 0n);
  // `bond` is what is posted (null when it could not be read): a lock short of its bond may still hold one, which is taken back before the lock
  return all.flatMap((l, i) => (w(6 * i + 1) !== 0n || w(6 * i + 2) !== 0n ? [] : [{ ...l, sats: BigInt(l.vBtc), recorded: w(6 * i) === BigInt(l.vBtc), bonded: w(6 * i + 3) === 1n, minted: w(6 * i + 4) === 1n, bond: r[6 * i + 5] ? wordAt(r[6 * i + 5], 0) : null }]));
}
export async function readLoans({ ux, priv }) {
  const cdp = await ux.recoverCdpPositions({ walletPriv: priv });
  const id = CBTC_ID.toLowerCase();
  return (cdp?.positions || []).filter((p) => p.live !== false).map((p) => ({ debt: BigInt(p.debtValue || 0), cbtc: (p.basket || []).filter((l) => String(l.asset).toLowerCase() === id).reduce((a, l) => a + BigInt(l.value), 0n), pos: p }));
}
export async function readHeld({ ux, priv }) {
  const r = await ux.balance(priv, { cbtc: true, bridge: false, positions: true });
  const of = (id) => { const g = r.byAsset?.[String(id).toLowerCase()]; return { value: g ? BigInt(g.value) : 0n, notes: g?.notes?.length || 0, list: g?.notes || [] }; };
  return { cbtc: of(CBTC_ID), cusd: of(CUSD_ID), positions: Array.isArray(r.farmPositions) && !r.diag?.errors?.farm ? r.farmPositions : null, partial: Object.keys(r.diag?.errors || {}).length > 0 };
}
export function positionsIn(rows, positions) {
  const by = new Map();
  for (const pos of positions || []) {
    const row = rows.find((r) => r.farm && r.farm.pid === Number(pos.pid));
    if (!row || !(row.lpTotal > 0)) continue;
    const sh = Number(pos.shares), cur = by.get(row.farm.pid) || { n: 0, cbtc: 0, side: 0, earned: 0, perDay: 0 };
    cur.n++; cur.cbtc += sh * row.cbtc / row.lpTotal; cur.side += sh * row.side / row.lpTotal; cur.earned += Number(pos.pendingTac) || 0; cur.perDay += row.farm.shares > 0 ? row.farm.perDay * sh / row.farm.shares : 0;
    by.set(row.farm.pid, cur);
  }
  return by;
}
