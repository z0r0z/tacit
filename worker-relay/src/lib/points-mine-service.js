// Proof mining as the points service pays it, off unless a feed, a schedule, a pocket and an end time are set.
//
// tacit-api's proof pool (worker/src/proof-pool.js) checks every proof a miner sends for a page's wrap (its public values are that
// wrap's, and the live SP1 verifier takes it) and keeps each UTC day's points per miner address, up to a number of proofs an address
// a day. Once a day is over, and the same grace the daily pot settles after has passed, this reads that day's tally from the API
// (GET /prover/pool/credits?day=<n>) and shares the day's amount between the miners by their points, no point paid more than `cap`
// (what the cap leaves unpaid stays in the pocket). A credit is an ordinary ledger adjustment, `pm:day:<day>:<address>`, so it adds to
// what an address is owed and touches no day's split: the daily pot, its ceilings and its groups are unchanged, and nobody already
// earning is paid less because of it. Credits wait, as the other campaigns' do, while the pocket would be overdrawn or the
// distributor's funding would stop covering the regular pot, and while the API cannot be read; what waits is credited later, never
// dropped. Each paid day keeps the terms and the tally it was paid from, with its hash (/mine/day/<n>).
//
// More than one feed (the proof pool's and the prover board's, GET /prover/board/credits, which credits community proofs the relay took)
// is one tally: each address's points summed across them, every feed read for the day before any of it is paid. Each feed caps an
// address's day on its own, so an address that proves for both may earn both caps.
//
// deps: store, cfg { schedule (lib/points-lp.js parseLpSchedule: daily, and cap as the most TAC one point earns), feedUrl (a URL, or a list), pocketWei,
// endSec, reserveDays? }, fetchJson(url) -> the parsed body (throws unless the API answered 200), fundingInputs() -> { heldWei,
// claimedWei, nextDay } | null, budgetFor(day), graceSecs, nowSec, log.
import { fundingStatus } from './points-funding.js';
import { WAD, lpTermsForDay, nextLpTerms, holdReason, reserveFor, dayOf, dayIsDone, allocateLpDay } from './points-lp.js';
import { RECORD_VERSION, hashRecord } from './points-lp-record.js';

const DAY = 86400;
const ADDR = /^0x[0-9a-f]{40}$/;
export const CREDIT_PREFIX = 'pm:';
export const dayId = (day, address) => `${CREDIT_PREFIX}day:${day}:${String(address).toLowerCase()}`;
// A guard against a feed gone wrong, not policy: an address with more points than this in a day stops the day.
export const MAX_DAY_POINTS = 1_000_000;
const short = (err) => String(err?.message || err).slice(0, 200);
class Hold extends Error { constructor(why) { super(why); this.why = why; } }

// A day's tally as the API gives it ({ day, over, miners: [{ miner, proofs, points }] }), checked: each miner once, an address, whole
// points. An answer for another day, or for a day the API does not yet call over, is not a tally to pay from.
export function readTally(body, day) {
  if (!body || typeof body !== 'object' || body.day !== day) throw new Error('the feed answered for another day');
  if (body.over !== true) throw new Error('the day is not over at the API yet');
  if (!Array.isArray(body.miners)) throw new Error('the feed has no miners list');
  const seen = new Set();
  return body.miners.map((m) => {
    const miner = String(m?.miner ?? '').toLowerCase(), points = Number(m?.points), proofs = Number(m?.proofs ?? 0);
    if (!ADDR.test(miner) || seen.has(miner)) throw new Error(`"${miner}" is not an address, or is listed twice`);
    if (!Number.isSafeInteger(points) || points < 0 || points > MAX_DAY_POINTS) throw new Error(`${miner} has ${m?.points} points`);
    seen.add(miner);
    return { miner, proofs: Number.isSafeInteger(proofs) && proofs >= 0 ? proofs : 0, points };
  }).filter((m) => m.points > 0).sort((a, b) => (a.miner < b.miner ? -1 : 1));
}

// Tallies from several feeds as one: each address once, its proofs and points summed.
export function mergeTallies(tallies) {
  const by = new Map();
  for (const m of tallies.flat()) {
    const have = by.get(m.miner);
    by.set(m.miner, have ? { miner: m.miner, proofs: have.proofs + m.proofs, points: have.points + m.points } : { ...m });
  }
  return [...by.values()].sort((a, b) => (a.miner < b.miner ? -1 : 1));
}

// The day's amount shared by points, no point paid more than `capWeiPerPoint`: lib/points-lp.js allocateLpDay with a point where it has
// a dollar, so it is rounded down and the campaign never pays more in a day than it says.
export function allocateMineDay({ tally, dailyWei, capWeiPerPoint }) {
  return allocateLpDay({ rows: tally.map((m) => ({ address: m.miner, valueUsdWei: BigInt(m.points) * WAD, weightBps: 10_000n })), dailyWei, capWeiPerUsdDay: capWeiPerPoint });
}

export function createMine({ store, cfg, fetchJson, fundingInputs, budgetFor, graceSecs = 0, nowSec = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  const feeds = [].concat(cfg.feedUrl || []).filter(Boolean);
  const enabled = feeds.length > 0 && cfg.pocketWei > 0n && cfg.endSec > 0 && (cfg.schedule ?? []).length > 0;
  const reserveDays = cfg.reserveDays ?? 2;
  const db = store.db;
  if (enabled) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pm_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pm_days (day INTEGER PRIMARY KEY, paid_at INTEGER NOT NULL, wei TEXT NOT NULL, sha256 TEXT NOT NULL, json TEXT NOT NULL);
    `);
  }
  const stmts = new Map();
  const q = (sql) => { if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql)); return stmts.get(sql); };
  const getMeta = (k) => q('SELECT v FROM pm_meta WHERE k = ?').get(k)?.v ?? null;
  const setMeta = (k, v) => q('INSERT INTO pm_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  let lastHold = '';
  const said = (why, text) => { if (why !== lastHold) { lastHold = why; log(`mining credits wait: ${why} (${text})`); } };

  // The day's credits, the mark that it is paid and its record go in together, and only while the pocket covers them.
  const applyAll = db.transaction((credits, day, t, record) => {
    const total = credits.reduce((s, c) => s + c.wei, 0n);
    if (store.creditedWithPrefix(CREDIT_PREFIX) + total > cfg.pocketWei) throw new Hold('pocket');
    for (const c of credits) store.applyAdjustment({ id: c.id, address: c.address, wei: c.wei });
    q('INSERT INTO pm_days (day, paid_at, wei, sha256, json) VALUES (?, ?, ?, ?, ?)').run(day, t, String(total), hashRecord(record), JSON.stringify(record));
    return total;
  });
  async function holdFor(wei, t) {
    const inputs = await fundingInputs().catch(() => null);
    const ledger = store.allRewards().reduce((s, r) => s + BigInt(r.cumulativeWei), 0n);
    const need = inputs ? reserveFor({ reserveDays, nextDay: inputs.nextDay, budgetFor }) : reserveDays;
    return holdReason({
      wei, creditedWei: store.creditedWithPrefix(CREDIT_PREFIX), pocketWei: cfg.pocketWei, nowSec: t, endSec: cfg.endSec, reserveDays: need,
      status: (extra) => (inputs ? fundingStatus({ heldWei: inputs.heldWei, claimedWei: inputs.claimedWei, ledgerWei: ledger + extra, budgetFor, nextDay: inputs.nextDay, graceSecs }) : null),
    });
  }

  // Days in order, each once it is over: a day that cannot be read or paid yet holds the ones after it.
  async function settle() {
    const lastPaid = q('SELECT MAX(day) AS d FROM pm_days').get()?.d;
    let day = lastPaid == null ? Math.max(dayOf(Number(getMeta('enabled_at') ?? nowSec())), cfg.schedule[0].fromDay) : lastPaid + 1;
    const t = nowSec();
    for (; dayIsDone(day, t, graceSecs); day++) {
      const terms = lpTermsForDay(cfg.schedule, day);
      let tally = [];
      if (terms) {
        try { const all = []; for (const f of feeds) all.push(readTally(await fetchJson(`${f}?day=${day}`), day)); tally = mergeTallies(all); }
        catch (err) { said('feed', `day ${day}: ${short(err)}`); return; }
      }
      const credits = terms
        ? allocateMineDay({ tally, dailyWei: terms.dailyWei, capWeiPerPoint: terms.capWeiPerUsdDay }).map((a) => ({ id: dayId(day, a.address), address: a.address, wei: a.wei }))
        : [];
      const record = {
        v: RECORD_VERSION, campaign: 'mine', day, feed: cfg.feedUrl,
        terms: terms ? { dailyWei: String(terms.dailyWei), capWeiPerPoint: String(terms.capWeiPerUsdDay) } : null,
        tally, credits: credits.map((c) => ({ id: c.id, address: c.address, wei: String(c.wei) })),
      };
      const total = credits.reduce((s, c) => s + c.wei, 0n);
      if (total > 0n) {
        // Whether the campaign has ended is asked of the day, not of now: a day is paid only after it is over.
        const why = await holdFor(total, day * DAY);
        if (why) { said(why, `day ${day}, ${credits.length} credit(s)`); return; }
      }
      try { applyAll(credits, day, t, record); } catch (err) { if (err instanceof Hold) { said(err.why, `day ${day}`); return; } throw err; }
      lastHold = '';
      if (total > 0n) log(`mining day ${day}: ${total} wei to ${credits.length} credit(s)`);
    }
  }

  async function cycle() {
    if (!enabled || nowSec() > cfg.endSec + 3 * DAY) return;
    if (getMeta('enabled_at') === null) setMeta('enabled_at', nowSec());
    try { await settle(); } catch (err) { log('mining credits failed:', short(err)); }
  }

  // ── what a page shows ──

  const likePrefix = CREDIT_PREFIX.replace(/[\\%_]/g, (c) => '\\' + c);
  const sumFor = (address) => db.prepare(`SELECT wei FROM reward_adjustments WHERE id LIKE ? ESCAPE '\\' AND address = ?`).all(`${likePrefix}%`, address).reduce((s, r) => s + BigInt(r.wei), 0n);
  function dayRecord(day) {
    const r = enabled && Number.isInteger(day) ? q('SELECT sha256, json FROM pm_days WHERE day = ?').get(day) : null;
    return r ? { sha256: r.sha256, record: JSON.parse(r.json) } : null;
  }
  function view({ address = null } = {}) {
    if (!enabled) return { enabled: false };
    const day = dayOf(nowSec()), credited = store.creditedWithPrefix(CREDIT_PREFIX);
    const termsOut = (e) => (!e ? null : e.off ? { fromDay: e.fromDay, off: true } : { fromDay: e.fromDay, dailyWei: String(e.dailyWei), capWeiPerPoint: String(e.capWeiPerUsdDay) });
    const me = address ? String(address).toLowerCase() : null;
    return {
      enabled: true, endSec: cfg.endSec, feed: cfg.feedUrl,
      pocket: { totalWei: String(cfg.pocketWei), creditedWei: String(credited), remainingWei: String(cfg.pocketWei > credited ? cfg.pocketWei - credited : 0n) },
      terms: termsOut(lpTermsForDay(cfg.schedule, day)), next: termsOut(nextLpTerms(cfg.schedule, day)),
      lastPaidDay: q('SELECT MAX(day) AS d FROM pm_days').get()?.d ?? null,
      ...(me && ADDR.test(me) ? { account: { address: me, creditedWei: String(sumFor(me)) } } : {}),
    };
  }

  return { enabled, name: 'mine', cycle, settle, view, dayRecord, endSec: cfg.endSec, pocketWei: cfg.pocketWei, credited: () => store.creditedWithPrefix(CREDIT_PREFIX) };
}
