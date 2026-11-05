// Where the settle wallet's ETH goes each replenish pass: a plan over the three things the relay must keep funded, reckoned in days
// of runway so the shortest one is fed first. Pure, tested to the wei (tests/treasury-plan.test.mjs).
//
//   settle wallet ETH — pays settle gas, and earns every fee leg.
//   relay wallet ETH  — pays Bitcoin headers and attests (the bridge lane) and the PROVE deposits; earns only its splitter share.
//   prover credit     — PROVE on the network; every proof spends it, the bridge's attests included.
//
// Only the settle wallet gives: ETH to the relay wallet by a transfer, ETH to the prover by a swap. It keeps its own floor (the next
// settles), and it never leaves itself a shorter runway than what it feeds: the plan finds the one level of days every short runway is
// raised to, the settle wallet's own included (water-filling), and no taker is fed past `targetDays` of its burn. A burn that is not
// known (0) falls back to the floors alone: a wallet under its floor is brought up to twice it, a credit under its floor to the floor. A
// move under its minimum (gas would be a real share of it) waits for the next pass.
//
//   settle: { wei, burnPerDayWei, floorWei }   relay: { wei, burnPerDayWei, floorWei, hardMinWei }   prove: { wei, burnPerDayWei, floorWei, urgentBelowWei, urgentToWei } in PROVE wei
//   proveWeiPerEth: PROVE wei one ETH buys now (null = PROVE cannot be priced, so nothing is swapped)
//   → { toRelayWei, toProveWei, urgentWei, runway: { settleDays, relayDays, proveDays }, after: {...}, notes }
//
// The credit is the one shortage that stops the bridge outright: a reflection proof needs its reserve (about 17 to 30 PROVE) free on the
// account before the network will take it, so a credit under that line stops every attest while the wallets still hold ETH. Under
// `urgentBelowWei` it is therefore fed first, from everything the settle wallet holds above its floor, up to `urgentToWei`, ahead of the
// levelling below and past the ordinary minimum swap (`urgentMinSwapWei`, smaller). What is left is levelled as before. The relay wallet is
// not starved for it: once under its own `hardMinWei` (a few attests of gas) it is brought back to its floor first, since a relay wallet with
// no gas stops the same attests from the other side. To the floor, not to the minimum: the minimum counts attests alone, not the header
// batches the same wallet sends, and filling only to it left the wallet just under it after every pass, fed again in slivers of a few
// millionths of an ETH (each transfer's gas more than it carried) while the rest of the room went to PROVE (2026-10-30..11-04).

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
const big = (x) => (x == null ? 0n : BigInt(x));
const ONE_ETH = 10n ** 18n;

export const runwayDays = (wei, burnPerDay) => (big(burnPerDay) > 0n ? Number(big(wei)) / Number(big(burnPerDay)) : Infinity);

// Days as a short number for a log line or a heartbeat: whole days past a year read as "a year or more".
export const daysText = (d) => (!Number.isFinite(d) ? '∞' : d >= 365 ? '365+' : d >= 10 ? String(Math.round(d)) : d.toFixed(1));

export function planTreasury({ settle, relay, prove, targetDays = 3, minMoveWei = 0n, minSwapWei = 0n, urgentMinSwapWei = null, maxSwapWei = null, proveWeiPerEth = null } = {}) {
  const s = { wei: big(settle?.wei), burn: big(settle?.burnPerDayWei), floor: big(settle?.floorWei) };
  const r = { wei: big(relay?.wei), burn: big(relay?.burnPerDayWei), floor: big(relay?.floorWei), hardMin: big(relay?.hardMinWei) };
  const p = { wei: big(prove?.wei), burn: big(prove?.burnPerDayWei), floor: big(prove?.floorWei) };
  const urgentBelow = big(prove?.urgentBelowWei), urgentTo = max(big(prove?.urgentToWei), max(urgentBelow, p.floor));
  const target = Math.max(0, Number(targetDays) || 0);
  const notes = [];
  const runway = { settleDays: runwayDays(s.wei, s.burn), relayDays: runwayDays(r.wei, r.burn), proveDays: runwayDays(p.wei, p.burn) };
  const priced = proveWeiPerEth != null && big(proveWeiPerEth) > 0n, price = priced ? big(proveWeiPerEth) : 0n;
  const toEth = (proveWei) => (priced ? (proveWei * ONE_ETH + price - 1n) / price : 0n);
  const settle0 = s.wei, prove0 = p.wei, relay0 = r.wei;

  // Tier one: a credit under its urgent line is bought up first with whatever the settle wallet holds above its floor (the most a swap
  // may take, and no more than the credit needs to reach its urgent target). The settle wallet and the credit are then levelled as if
  // that ETH had always been PROVE, so the rest of the plan sees them as they will stand.
  let urgentWei = 0n, relayFirstWei = 0n;
  const urgentMin = urgentMinSwapWei != null ? big(urgentMinSwapWei) : big(minSwapWei);
  if (priced && urgentBelow > 0n && p.wei < urgentBelow) {
    let room = s.wei > s.floor ? s.wei - s.floor : 0n;
    if (r.hardMin > r.wei) { relayFirstWei = min(max(r.hardMin, r.floor) - r.wei, room); room -= relayFirstWei; }
    let want = toEth(urgentTo - p.wei);
    if (maxSwapWei != null) want = min(want, big(maxSwapWei));
    urgentWei = min(want, room);
    if (urgentWei > 0n && urgentWei < urgentMin) { notes.push(`prover credit is under its urgent line: ${urgentWei} wei of ETH is all the settle wallet can give, under the ${urgentMin} wei minimum swap — waits`); urgentWei = 0n; }
    else if (urgentWei > 0n) notes.push(`prover credit is under its urgent line: ${urgentWei} wei of ETH goes to PROVE first`);
    else if (room === 0n) notes.push('prover credit is under its urgent line, but the settle wallet holds nothing above its floor');
  }
  if (relayFirstWei > 0n) notes.push(`relay wallet: under its minimum, ${relayFirstWei} wei of ETH goes to it before the credit is bought`);
  s.wei -= relayFirstWei + urgentWei; r.wei += relayFirstWei;
  if (urgentWei > 0n) p.wei += (urgentWei * price) / ONE_ETH;
  const spare = s.wei > s.floor ? s.wei - s.floor : 0n;

  // The takers, each in ETH wei: what it holds, what it burns a day, and the most it is ever fed to (its target, or its floor when
  // its burn is unknown). The prover's figures are its PROVE at the swap price.
  const takers = [
    { key: 'relay', wei: r.wei, burn: r.burn, want: r.burn > 0n ? max(r.floor, r.burn * BigInt(Math.floor(target))) : (r.wei < r.floor ? r.floor * 2n : 0n) },
    priced ? { key: 'prove', wei: toEth(p.wei), burn: toEth(p.burn), want: p.burn > 0n ? toEth(max(p.floor, p.burn * BigInt(Math.floor(target)))) : (p.wei < p.floor ? toEth(p.floor) : 0n) } : null,
  ].filter(Boolean);
  if (!priced && p.burn > 0n && p.wei < max(p.floor, p.burn * BigInt(Math.floor(target)))) notes.push('prover credit is short but PROVE cannot be priced — nothing swapped');

  // Water-filling: the level L (days) every taker is raised to, as far as its want allows, that leaves the settle wallet exactly L days
  // itself. Found by bisection, since what the takers need is monotone in L. A taker whose burn is unknown is simply brought to its want.
  const needAt = (t, L) => {
    const level = t.burn > 0n ? BigInt(Math.floor(L * Number(t.burn))) : t.want;
    const to = min(level, t.want);
    return to > t.wei ? to - t.wei : 0n;
  };
  const totalAt = (L) => takers.reduce((a, t) => a + needAt(t, L), 0n);
  let L;
  if (s.burn > 0n) {
    let lo = 0, hi = Math.max(target, runway.settleDays, ...takers.map((t) => runwayDays(t.wei, t.burn)).filter(Number.isFinite));
    if (!Number.isFinite(hi)) hi = target;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2, left = s.wei - totalAt(mid);
      if (left < s.floor || Number(left) / Number(s.burn) < mid) hi = mid; else lo = mid;
    }
    L = lo;
  } else L = Number.MAX_SAFE_INTEGER; // the settle wallet's burn is unknown: every taker is brought to its want, floor permitting
  const amounts = takers.map((t) => ({ t, wei: needAt(t, L) }));
  // The floor is exact: what the bisection could not fit under it is trimmed from the last taker first.
  let over = amounts.reduce((a, x) => a + x.wei, 0n) - spare;
  for (let i = amounts.length - 1; i >= 0 && over > 0n; i--) { const cut = min(over, amounts[i].wei); amounts[i].wei -= cut; over -= cut; }

  let toRelayWei = amounts.find((x) => x.t.key === 'relay')?.wei ?? 0n;      // the levelled part; what the relay's minimum took first is added after its own minimum move
  // What the levelling adds to the urgent purchase is one swap with it; the urgent part has its own, smaller minimum.
  let toProveWei = (amounts.find((x) => x.t.key === 'prove')?.wei ?? 0n) + urgentWei;
  if (toRelayWei > 0n && toRelayWei < big(minMoveWei)) { notes.push(`relay wallet: ${toRelayWei} wei due, under the ${minMoveWei} wei minimum move — waits`); toRelayWei = 0n; }
  toRelayWei += relayFirstWei;                                              // a refill under its hard minimum is a need, not a convenience: no minimum move
  if (maxSwapWei != null && toProveWei > big(maxSwapWei)) toProveWei = big(maxSwapWei);
  const swapMin = urgentWei > 0n ? urgentMin : big(minSwapWei);
  if (toProveWei > 0n && toProveWei < swapMin) { notes.push(`prover credit: ${toProveWei} wei of ETH due, under the ${swapMin} wei minimum swap — waits`); toProveWei = 0n; urgentWei = 0n; }
  if (urgentWei > toProveWei) urgentWei = toProveWei;

  const after = {
    settleDays: runwayDays(settle0 - toRelayWei - toProveWei, s.burn),
    relayDays: runwayDays(relay0 + toRelayWei, r.burn),
    proveDays: priced ? runwayDays(prove0 + (toProveWei * price) / ONE_ETH, p.burn) : runway.proveDays,
  };
  return { toRelayWei, toProveWei, urgentWei, spareWei: spare - toRelayWei - (toProveWei - urgentWei), levelDays: s.burn > 0n ? L : null, runway, after, notes };
}

// The least a swap is worth making: its gas a small share of it. `gasWei` is what the swap costs now (its gas at the live price); the
// least is that cost times `multiple`, held between `floorWei` and `ceilWei` (the old fixed minimum, which a dear gas price keeps).
export function swapMinWei({ gasWei, multiple = 25, floorWei = 0n, ceilWei }) {
  const cost = big(gasWei) * BigInt(Math.max(1, Math.round(Number(multiple) || 1)));
  const ceil = big(ceilWei), floor = min(big(floorWei), ceil);
  return min(max(cost, floor), ceil);
}

// What the ledger's books say the relay burns a day, from the days it has: settle gas (ETH a day) and PROVE put in (a day's deposits
// are what a day's proofs spent, in steady state). Today counts as the part of it that has passed, never less than a quarter day, so a
// fresh day does not read as a quiet one. Null for a figure the books cannot give yet.
export function burnFromBooks(days, { now = Date.now(), maxDays = 7 } = {}) {
  const keys = Object.keys(days || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-maxDays);
  if (!keys.length) return { gasEthPerDay: null, provePerDay: null, settlesPerDay: null, days: 0 };
  const today = new Date(now).toISOString().slice(0, 10);
  let span = 0, gas = 0, prove = 0, settled = 0;
  for (const k of keys) {
    const b = days[k] || {};
    span += k === today ? Math.max(0.25, ((now - Date.parse(`${k}T00:00:00Z`)) / 86_400_000)) : 1;
    gas += Number(b.gasEth) || 0; prove += Number(b.proveIn) || 0; settled += Number(b.settled) || 0;
  }
  if (!(span > 0)) return { gasEthPerDay: null, provePerDay: null, settlesPerDay: null, days: keys.length };
  return { gasEthPerDay: gas / span, provePerDay: prove / span, settlesPerDay: settled / span, days: keys.length };
}
