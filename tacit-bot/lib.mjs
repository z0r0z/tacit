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
  };
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

// ── keys: one seed, three keys, each its own domain. A and B are Tacit keys (their chain wallets come from them as the app's do); the
// Ethereum account that holds public TAC is A's own, so A's key alone opened in the app shows the account, A's chain wallet and the
// confidential notes a shield that never landed goes back to.
export function identities(seedHex) {
  const seed = Uint8Array.from(Buffer.from(String(seedHex || '').replace(/^0x/, ''), 'hex'));
  if (seed.length !== 32) throw new Error('BOT_SEED: 32 bytes of hex');
  const k = (tag) => hmac(sha256, seed, new TextEncoder().encode(tag));
  const a = k('tacit-bot-a-v1'), b = k('tacit-bot-b-v1');
  return { a, b, eoa: { priv: a, address: ethAddress(a) } };
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

/// The next action, from what the bot holds now:
///   view: { a, b (each: worth, most (pay quote), settling), eoa (units), shieldCap (units|null), sweepFee (TAC wei), fee (units) }
/// → { kind: 'shield', units } | { kind: 'pay', from, to, units } | { kind: 'withdraw', from, units } | { kind: 'merge', from } | { kind: 'idle', why }
export function decide(s, v, rand = Math.random) {
  const onChain = v.a.worth + v.b.worth;
  const sweepUnits = BigInt(v.sweepFee || 0n) / UNIT + 1n;
  const capShield = (want) => {
    let u = want;
    if (v.shieldCap != null && u > v.shieldCap) u = v.shieldCap;
    if (onChain + u > s.maxInPlay) u = s.maxInPlay > onChain ? s.maxInPlay - onChain : 0n;
    if (u + sweepUnits > v.eoa) u = v.eoa > sweepUnits ? v.eoa - sweepUnits : 0n;
    return (u / (T / 100n)) * (T / 100n);           // whole hundredths, so the permit is a round figure
  };
  const shieldOk = BigInt(v.sweepFee || 0n) <= s.maxSweepFee * UNIT;
  // 1. too little on the chain: take in what the account holds
  if (onChain < s.lowWater) {
    if (!shieldOk) return { kind: 'idle', why: 'low on the chain, and the sweep fee is over its limit' };
    const u = capShield(s.shieldSize);
    if (u >= s.payMin * 4n) return { kind: 'shield', units: u };
    if (onChain < s.payMin * 2n) return { kind: 'idle', why: 'nothing to move: fund the account with TAC' };
  }
  // 2. TAC back in the account from a withdrawal: take it in again, now and then
  if (shieldOk && v.eoa >= s.reshieldMin + sweepUnits && onChain < s.maxInPlay && rand() < s.reshieldProb) {
    const u = capShield(v.eoa);
    if (u >= s.reshieldMin) return { kind: 'shield', units: u };
  }
  const order = v.a.worth >= v.b.worth ? ['a', 'b'] : ['b', 'a'];
  const [rich, poor] = order;
  // 3. now and then out to the account
  if (onChain >= s.lowWater * 2n && rand() < s.withdrawProb) {
    const most = v[rich].outMost ?? v[rich].most;
    const hi = most < s.withdrawMax ? most : s.withdrawMax;
    if (!v[rich].settling && hi >= s.withdrawMin) return { kind: 'withdraw', from: rich, units: randomUnits(s.withdrawMin, hi, rand) };
  }
  // 4. a payment between the two, mostly from the richer; a wallet whose notes are too scattered to pay merges two of them first
  const from = rand() < 0.75 ? rich : poor, to = from === 'a' ? 'b' : 'a';
  const w = v[from];
  if (w.settling) return { kind: 'idle', why: `${from}'s last spend is settling` };
  if (w.most < s.payMin) {
    if (w.worth >= s.payMin * 4n) return { kind: 'merge', from };
    const other = v[to];
    if (!other.settling && other.most >= s.payMin) return { kind: 'pay', from: to, to: from, units: randomUnits(s.payMin, other.most < s.payMax ? other.most : s.payMax, rand) };
    return { kind: 'idle', why: 'neither wallet can pay now' };
  }
  if (w.worth >= s.payMax * 6n && w.most < w.worth / 4n && rand() < 0.3) return { kind: 'merge', from };
  return { kind: 'pay', from, to, units: randomUnits(s.payMin, w.most < s.payMax ? w.most : s.payMax, rand) };
}

/// Counts failures in a row; `stopped` once there are `max`.
export function makeFailures(max) {
  let n = 0;
  return { ok: () => { n = 0; }, fail: () => { n += 1; return n >= max; }, count: () => n, stopped: () => n >= max };
}
