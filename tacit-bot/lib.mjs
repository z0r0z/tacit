// The bot's decisions, with no network and no keys: its settings from the environment, the wait before the next action, the guards
// that hold it back, the day's fee budget, and which action comes next. bot.mjs does what these say.
import { hmac, sha256, keccak_256, secp } from '../dapp/vendor/tacit-deps.min.js';

export const T = 100_000_000n;                       // 1 TAC in chain units (1e-8 TAC)
export const UNIT = 10n ** 10n;                      // chain unit → TAC wei

/// TAC as a decimal string ("12.5") → units; a number of units → "12.5".
export function tac(s) {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`not a TAC amount: ${s}`);
  return BigInt(m[1]) * T + BigInt((m[2] || '').padEnd(8, '0'));
}
export function fmt(units) {
  const u = BigInt(units), neg = u < 0n, a = neg ? -u : u;
  const frac = (a % T).toString().padStart(8, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (a / T).toString() + (frac ? '.' + frac : '');
}

/// The settings, from the environment (amounts in TAC, times in minutes).
export function settings(env = process.env) {
  const n = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const t = (k, d) => tac(env[k] != null && env[k] !== '' ? env[k] : d);
  const s = {
    minWaitMin: n('BOT_MIN_WAIT_MIN', 20), maxWaitMin: n('BOT_MAX_WAIT_MIN', 40),
    maxInPlay: t('BOT_MAX_IN_PLAY_TAC', '300'),       // the most TAC kept on the chain (both wallets)
    lowWater: t('BOT_LOW_WATER_TAC', '40'),           // shield when the chain holds less than this
    shieldSize: t('BOT_SHIELD_TAC', '150'),           // what one shield takes in (never over the leader's cap)
    payMin: t('BOT_PAY_MIN_TAC', '0.5'), payMax: t('BOT_PAY_MAX_TAC', '15'),
    withdrawProb: n('BOT_WITHDRAW_PROB', 0.08),       // of a tick, when the chain holds enough
    withdrawMin: t('BOT_WITHDRAW_MIN_TAC', '5'), withdrawMax: t('BOT_WITHDRAW_MAX_TAC', '40'),
    reshieldMin: t('BOT_RESHIELD_MIN_TAC', '20'),     // EOA TAC worth taking back in
    reshieldProb: n('BOT_RESHIELD_PROB', 0.3),
    dailyFeeBudget: t('BOT_DAILY_FEE_TAC', '25'),
    maxFee: t('BOT_MAX_FEE_TAC', '1'),                // pause when the leader asks more a spend
    maxSweepFee: t('BOT_MAX_SWEEP_FEE_TAC', '2'),     // a permitted shield waits while the sweep fee is over this
    maxFailures: n('BOT_MAX_FAILURES', 5),
    stuckMin: n('BOT_STUCK_MIN', 90),                 // the leader holds spends and no block landed for this long: unhealthy
    landTimeoutMin: n('BOT_LAND_TIMEOUT_MIN', 30),
    identities: n('BOT_IDENTITIES', 12),              // chain wallets the value moves between (A and B are the first two)
    owedTimeoutMin: n('BOT_OWED_TIMEOUT_MIN', 120),   // a withdrawal the leader has not paid out for this long is logged
    exitDustTac: t('BOT_EXIT_DUST_TAC', '0.5'),       // an exit account holding less than this (and owed nothing) is no longer read
  };
  if (!(Number.isInteger(s.identities) && s.identities >= 2 && s.identities <= 64)) throw new Error('BOT_IDENTITIES: 2 to 64');
  if (!(s.minWaitMin > 0 && s.maxWaitMin >= s.minWaitMin)) throw new Error('BOT_MIN_WAIT_MIN / BOT_MAX_WAIT_MIN');
  if (s.payMin > s.payMax || s.withdrawMin > s.withdrawMax) throw new Error('a minimum over its maximum');
  return s;
}

/// The wait before the next action, in ms: uniform between the two bounds.
export const nextWait = (s, rand = Math.random) => Math.round((s.minWaitMin + rand() * (s.maxWaitMin - s.minWaitMin)) * 60e3);
/// A random amount of units in [lo, hi], whole hundredths of a TAC.
export function randomUnits(lo, hi, rand = Math.random) {
  const step = T / 100n, a = BigInt(lo) / step, b = BigInt(hi) / step;
  if (b <= a) return BigInt(lo);
  return (a + BigInt(Math.floor(rand() * Number(b - a + 1n)))) * step;
}

// ── keys: one seed, each key its own domain. Identities 0 and 1 (A and B) keep their first tags; the rest are "tacit-bot-id-v1-<i>". Each is
// a Tacit key (its chain wallet comes from it as the app's does). Exit accounts are Ethereum keys of their own path: account 0 is A's own key
// (the first account, so A's key alone opened in the app shows it), account i ≥ 1 is "tacit-bot-exit-v1-<i>", a fresh one per withdrawal.
const seedBytes = (seedHex) => {
  const seed = Uint8Array.from(Buffer.from(String(seedHex || '').replace(/^0x/, ''), 'hex'));
  if (seed.length !== 32) throw new Error('BOT_SEED: 32 bytes of hex');
  return seed;
};
const tagKey = (seed, tag) => hmac(sha256, seed, new TextEncoder().encode(tag));
export function identityKey(seedHex, i) {
  const seed = seedBytes(seedHex);
  return tagKey(seed, i === 0 ? 'tacit-bot-a-v1' : i === 1 ? 'tacit-bot-b-v1' : `tacit-bot-id-v1-${i}`);
}
export function exitAccount(seedHex, i) {
  const priv = i === 0 ? identityKey(seedHex, 0) : tagKey(seedBytes(seedHex), `tacit-bot-exit-v1-${i}`);
  return { index: i, priv, address: ethAddress(priv) };
}
/// The identity's name in logs: a, b, then i2, i3, …
export const idName = (i) => (i === 0 ? 'a' : i === 1 ? 'b' : `i${i}`);
export function identities(seedHex, n = 2) {
  const keys = Array.from({ length: Math.max(2, n) }, (_, i) => identityKey(seedHex, i));
  return { a: keys[0], b: keys[1], keys, eoa: exitAccount(seedHex, 0), exit: (i) => exitAccount(seedHex, i) };
}
export function ethAddress(priv) {
  const pub = secp.getPublicKey(priv, false).slice(1);
  return '0x' + Buffer.from(keccak_256(pub).slice(12)).toString('hex');
}

// ── the day's fees, by UTC day
export function makeBudget(limit, now = () => Date.now()) {
  let day = null, spent = 0n;
  const roll = () => { const d = new Date(now()).toISOString().slice(0, 10); if (d !== day) { day = d; spent = 0n; } };
  return {
    fits: (units) => { roll(); return spent + BigInt(units) <= limit; },
    add: (units) => { roll(); spent += BigInt(units); },
    left: () => { roll(); return limit > spent ? limit - spent : 0n; },
    spent: () => { roll(); return spent; },
    restore: (j) => { if (j?.day) { day = j.day; spent = BigInt(j.spent || 0); } roll(); },
    toJSON: () => { roll(); return { day, spent: String(spent) }; },
  };
}

/// Whether the chain and its leader are fit to use: { ok, why }. `status`: chainStatus (leader null when it did not answer); `leaderState`:
/// GET /state (null when it did not answer); `mempool`: the count of spends the leader holds.
export function health(s, { status, leaderState, mempool = 0, now = Date.now() }) {
  if (!status) return { ok: false, why: 'Ethereum could not be read' };
  if (!status.leader || !leaderState) return { ok: false, why: 'the leader does not answer' };
  if (Number(leaderState.height) < Number(status.height)) return { ok: false, why: `the leader is behind (${leaderState.height} < ${status.height})` };
  if (mempool > 0 && status.lastLanded && now / 1000 - status.lastLanded > s.stuckMin * 60) return { ok: false, why: `the leader holds ${mempool} spend(s) and no block landed for ${Math.round((now / 1000 - status.lastLanded) / 60)} min` };
  if (status.leader.fee > s.maxFee) return { ok: false, why: `the leader's fee ${fmt(status.leader.fee)} TAC is over ${fmt(s.maxFee)}`, fee: true };
  return { ok: true };
}

/// One of `xs` at random (null when empty).
const pick = (xs, rand) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))] : null);
/// The better of two random draws from `xs` by `better(x, y)` (true when x wins): a lean toward it, not a rule, so every one gets a turn.
const lean = (xs, better, rand) => { const x = pick(xs, rand), y = pick(xs, rand); return x == null ? null : better(y, x) ? y : x; };

/// The exit account a shield takes TAC from: the richest (when the chain runs low) or a random one holding enough (a reshield). Each shield
/// is one permit from one account, never a sum of several. `eoas`: [{ index, units }]. → the entry, or null.
export function pickSource(eoas, { min, richest = false }, rand = Math.random) {
  const ok = eoas.filter((e) => e.units >= min);
  if (!ok.length) return null;
  return richest ? ok.reduce((m, e) => (e.units > m.units ? e : m)) : pick(ok, rand);
}
/// A payment's ends: the sender leans to the richer of those able to pay, the receiver to the poorer of the others, so value spreads.
/// `sides`: [{ worth, most, settling }] by identity. → { from, to } or null.
export function pickPair(sides, payMin, rand = Math.random) {
  const able = sides.map((x, i) => i).filter((i) => !sides[i].settling && sides[i].most >= payMin);
  const from = lean(able, (x, y) => sides[x].worth > sides[y].worth, rand);
  if (from == null) return null;
  const to = lean(sides.map((x, i) => i).filter((i) => i !== from), (x, y) => sides[x].worth < sides[y].worth, rand);
  return to == null ? null : { from, to };
}

/// The next action, from what the bot holds now:
///   view: { ids: [{ worth, most (pay quote), outMost, settling }] by identity, eoas: [{ index, units }] (public TAC per exit account),
///           shieldCap (units|null), sweepFee (TAC wei), fee (units) }
/// → { kind: 'shield', units, eoa, to } | { kind: 'pay', from, to, units } | { kind: 'withdraw', from, units } | { kind: 'merge', from }
///   | { kind: 'idle', why }   (from / to: identity indexes; eoa: the exit account the permit is from)
export function decide(s, v, rand = Math.random) {
  const ids = v.ids, all = ids.map((x, i) => i);
  const onChain = ids.reduce((t, x) => t + x.worth, 0n);
  const sweepUnits = BigInt(v.sweepFee || 0n) / UNIT + 1n;
  const capShield = (want, held) => {
    let u = want;
    if (v.shieldCap != null && u > v.shieldCap) u = v.shieldCap;
    if (onChain + u > s.maxInPlay) u = s.maxInPlay > onChain ? s.maxInPlay - onChain : 0n;
    if (u + sweepUnits > held) u = held > sweepUnits ? held - sweepUnits : 0n;
    return (u / (T / 100n)) * (T / 100n);           // whole hundredths, so the permit is a round figure
  };
  // a shield lands in an identity leaning to the poorer
  const shieldTo = () => lean(all, (x, y) => ids[x].worth < ids[y].worth, rand);
  const shieldOk = BigInt(v.sweepFee || 0n) <= s.maxSweepFee * UNIT;
  // 1. too little on the chain: take in what the richest account holds
  if (onChain < s.lowWater) {
    if (!shieldOk) return { kind: 'idle', why: 'low on the chain, and the sweep fee is over its limit' };
    const src = pickSource(v.eoas, { min: 0n, richest: true }, rand);
    const u = src ? capShield(s.shieldSize, src.units) : 0n;
    if (u >= s.payMin * 4n) return { kind: 'shield', units: u, eoa: src.index, to: shieldTo() };
    if (onChain < s.payMin * 2n) return { kind: 'idle', why: 'nothing to move: fund the account with TAC' };
  }
  // 2. TAC back in an exit account from a withdrawal: take it in again, now and then, from one account
  if (shieldOk && onChain < s.maxInPlay) {
    const src = pickSource(v.eoas, { min: s.reshieldMin + sweepUnits }, rand);
    if (src && rand() < s.reshieldProb) {
      const u = capShield(src.units, src.units);
      if (u >= s.reshieldMin) return { kind: 'shield', units: u, eoa: src.index, to: shieldTo() };
    }
  }
  // 3. now and then out, from the richest that can
  if (onChain >= s.lowWater * 2n && rand() < s.withdrawProb) {
    const can = all.filter((i) => !ids[i].settling);
    const rich = can.length ? can.reduce((m, i) => (ids[i].worth > ids[m].worth ? i : m)) : null;
    if (rich != null) {
      const most = ids[rich].outMost ?? ids[rich].most;
      const hi = most < s.withdrawMax ? most : s.withdrawMax;
      if (hi >= s.withdrawMin) return { kind: 'withdraw', from: rich, units: randomUnits(s.withdrawMin, hi, rand) };
    }
  }
  // 4. a payment between two identities; one whose notes are too scattered to pay merges two of them first (by paying itself)
  const stuck = all.filter((i) => !ids[i].settling && ids[i].most < s.payMin && ids[i].worth >= s.payMin * 4n);
  const pair = pickPair(ids, s.payMin, rand);
  if (stuck.length && (!pair || rand() < 0.5)) return { kind: 'merge', from: pick(stuck, rand) };
  if (!pair) return { kind: 'idle', why: all.some((i) => ids[i].settling) ? 'the wallets that could pay are settling' : 'no wallet can pay now' };
  const w = ids[pair.from];
  if (w.worth >= s.payMax * 6n && w.most < w.worth / 4n && rand() < 0.3) return { kind: 'merge', from: pair.from };
  return { kind: 'pay', from: pair.from, to: pair.to, units: randomUnits(s.payMin, w.most < s.payMax ? w.most : s.payMax, rand) };
}

/// The exits the leader has not paid out yet: `pending` [{ index, address, units, since (ms), alerted? }], `owed` { address → token wei
/// still owed (null: unread) }. → { pending (still owed), paid (entries now paid out), alerts (entries owed past the timeout, once each) }.
/// It only reports: the withdrawal landed, the TAC is the account's on the contract, and anyone may send it out.
export function watchOwed(pending, owed, now, timeoutMin) {
  const keep = [], paid = [], alerts = [];
  for (const e of pending) {
    const o = owed[e.address.toLowerCase()];
    if (o == null) { keep.push(e); continue; }
    if (o === 0n) { paid.push(e); continue; }
    if (!e.alerted && now - e.since > timeoutMin * 60e3) { const x = { ...e, alerted: true }; keep.push(x); alerts.push({ ...x, owed: o }); continue; }
    keep.push(e);
  }
  return { pending: keep, paid, alerts };
}

/// Counts failures in a row; `stopped` once there are `max`.
export function makeFailures(max) {
  let n = 0;
  return { ok: () => { n = 0; }, fail: () => { n += 1; return n >= max; }, count: () => n, stopped: () => n >= max };
}
