// How the site is used, as counts and nothing else: a name from a short fixed list, and how many times it happened on a UTC day. A page sends one name when something happens
// (the trade page opened, the Bitcoin lane chosen, the Buy button pressed, a lot checked, a trade done) and the API adds one to that day's total for it. There is no address, no
// identifier, no cookie and no log of who sent it: the request's own address is never read here. A browser that sends Do Not Track or Global Privacy Control is not counted (the
// pages do not send, and this refuses what arrives with them). A name that is not on the list is dropped, and so is more than `perMin` of one name in a minute, whoever sends them:
// a flood cannot grow the store or push a real count out of view.
//
//   POST /metrics/event   the body is the name (text/plain, so that a page's beacon needs no preflight); always answers 204
//   GET  /metrics         { days: [{ day, counts: { name: n } }, ...] }, newest first, the last `days` (up to 31) days that have any
//
// Counts are kept in memory and written together every few seconds, so a busy book page is one write per interval, not one per load.

export const CLIENT_EVENTS = [
  'trade_view', 'trade_via_menu', 'trade_via_chip', 'trade_via_lander', 'trade_via_assets', 'trade_via_share',
  'lane_btc', 'lane_eth', 'lane_cmp', 'lane_btc_link', 'btc_alt_click',
  'buy_btc_click', 'bid_btc_click', 'sell_btc_click', 'list_btc_click', 'btc_sheet_open',
  'lot_check_start', 'lot_check_pass', 'lot_check_fail', 'btc_bought', 'btc_sold', 'btc_listed',
];
export const SERVER_EVENTS = ['book_load'];
const CLIENT = new Set(CLIENT_EVENTS), ALL = new Set([...CLIENT_EVENTS, ...SERVER_EVENTS]);
export const metricsKey = (day) => `metrics:${day}`;
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const KEEP_SECS = 120 * 86400;

export function makeMetrics({ kv, now = () => Date.now(), flushMs = 10_000, perMin = 240, timer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; } }) {
  const pending = new Map();                 // day -> Map(name -> n), counted and not yet written
  const recent = new Map();                  // name -> [timestamps in the last minute]
  const chains = new Map();                  // day -> the write in progress for it (writes to one day go one after another)
  let scheduled = false;

  const allowed = (name) => {
    const t = now(), list = (recent.get(name) || []).filter((x) => t - x < 60_000);
    if (list.length >= perMin) { recent.set(name, list); return false; }
    list.push(t); recent.set(name, list); return true;
  };

  // 'ok' counted, 'unknown' not a name on the list (or a server name sent by a page), 'capped' too many of it this minute
  function record(name, { fromClient = true } = {}) {
    if (typeof name !== 'string' || !(fromClient ? CLIENT : ALL).has(name)) return 'unknown';
    if (!allowed(name)) return 'capped';
    const d = dayOf(now()); let m = pending.get(d); if (!m) pending.set(d, (m = new Map()));
    m.set(name, (m.get(name) || 0) + 1);
    if (!scheduled) { scheduled = true; timer(() => { scheduled = false; flush().catch(() => {}); }, flushMs); }
    return 'ok';
  }

  async function writeDay(day, counts) {
    const prev = chains.get(day) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      let cur = {}; try { cur = (await kv.get(metricsKey(day), 'json')) || {}; } catch { cur = {}; }
      if (typeof cur !== 'object' || Array.isArray(cur)) cur = {};
      for (const [k, n] of counts) if (ALL.has(k)) cur[k] = (Number(cur[k]) || 0) + n;
      await kv.put(metricsKey(day), JSON.stringify(cur), { expirationTtl: KEEP_SECS });
    });
    chains.set(day, run);
    try { await run; } finally { if (chains.get(day) === run) chains.delete(day); }
  }

  // What is counted is taken out of memory first and put back if the write fails (up to a day's worth: a store that is down for long loses the oldest, not the newest).
  async function flush() {
    const take = [...pending.entries()]; pending.clear();
    for (const [day, counts] of take) {
      try { await writeDay(day, counts); }
      catch {
        const m = pending.get(day) || new Map(); pending.set(day, m);
        for (const [k, n] of counts) m.set(k, Math.min(1_000_000, (m.get(k) || 0) + n));
        if (!scheduled) { scheduled = true; timer(() => { scheduled = false; flush().catch(() => {}); }, flushMs * 6); }
      }
    }
  }

  async function read(days = 14) {
    const n = Math.max(1, Math.min(31, Math.floor(Number(days)) || 14)), t = now(), out = [];
    for (let i = 0; i < n; i++) {
      const day = dayOf(t - i * 86400_000);
      let obj = null; try { obj = await kv.get(metricsKey(day), 'json'); } catch { obj = null; }
      const live = pending.get(day), counts = {};
      for (const k of ALL) { const v = (Number(obj && obj[k]) || 0) + (live ? live.get(k) || 0 : 0); if (v > 0) counts[k] = v; }
      if (Object.keys(counts).length) out.push({ day, counts });
    }
    return { days: out };
  }

  return { record, flush, read };
}

const CORS_PLAIN = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

// POST /metrics/event: always 204 (a page that is refused learns nothing it could use). A request that says it does not want to be counted is not.
export async function handleMetricEvent(req, metrics, cors = CORS_PLAIN) {
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  try {
    if (req.headers.get('DNT') === '1' || req.headers.get('Sec-GPC') === '1') return new Response(null, { status: 204, headers });
    // A name is under 32 characters: a body much longer than that is not one, and is not read.
    if (Number(req.headers.get('content-length') || 0) > 256) return new Response(null, { status: 204, headers });
    const text = await req.text();
    if (text.length <= 64) metrics.record(text.trim(), { fromClient: true });
  } catch { /* nothing to count */ }
  return new Response(null, { status: 204, headers });
}

export async function handleMetricsGet(url, metrics, cors = CORS_PLAIN) {
  const body = await metrics.read(url.searchParams.get('days'));
  return new Response(JSON.stringify({ ...body, note: 'counts of what pages and the API did, per UTC day; nothing identifies anyone' }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
}
