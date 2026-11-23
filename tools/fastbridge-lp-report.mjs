#!/usr/bin/env node
// READ-ONLY: what the house fast bridge provider (or any provider on Render) did over the last hours, read from its own logs: the swaps it took and how each
// ended, what it held and had promised, what it shielded, the offers it took or declined, and anything that went wrong. Nothing is sent or changed.
//
//   ! node tools/fastbridge-lp-report.mjs [--hours 12] [--service srv-…] [--owner tea-…] [--json]
//
// The Render key is read from RENDER_API_KEY, else from the macOS keychain item `tacit-render-api-key`; it is sent only to api.render.com and never printed.
// (It has to be run from your own shell: a script run for you cannot read the keychain.) Defaults are the house provider.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const HOUSE = { service: 'srv-dbolvgpsrm7s73cdbepg', owner: 'tea-d6v0ghf5gffc73d1n4k0' };
const TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);
const ONE = 10n ** 8n;

// TAC as people read it, from base units (8 places) given as a string
export function tac(v) {
  if (v == null) return '?';
  let n; try { n = BigInt(v); } catch { return '?'; }
  const whole = n / ONE, frac = (n % ONE).toString().padStart(8, '0').slice(0, 2).replace(/0+$/, '');
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? '.' + frac : ''}`;
}
// the refill's amounts are the token's own (18 places), not the pool's (8)
export function tacWei(v) { try { return tac(BigInt(v) / 10n ** 10n); } catch { return '?'; } }
const mins = (ms) => (ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : `${Math.floor(ms / 3600e3)} h ${Math.round((ms % 3600e3) / 60e3)} min`);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

// Render's log rows ({ timestamp, message }) as the provider printed them: a JSON line, or text that is kept as it is
export function parseLines(rows) {
  const out = [];
  for (const r of rows || []) {
    const message = String((r && r.message) ?? '').trim();
    let j = null;
    try { j = JSON.parse(message); } catch { /* not a JSON line */ }
    const at = Date.parse((j && j.ts) || (r && r.timestamp) || '');
    if (j && typeof j === 'object' && !Array.isArray(j)) out.push({ at: Number.isFinite(at) ? at : null, level: j.level || 'info', msg: String(j.msg || ''), ...j });
    else if (message) out.push({ at: Number.isFinite(at) ? at : null, level: /error|exception|unhandled/i.test(message) ? 'error' : 'info', msg: 'unstructured', raw: message.slice(0, 200) });
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const bump = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by);

export function summarize(entries, { hours = null } = {}) {
  const swaps = new Map(), capacity = [], refills = [], offers = { accepted: 0, declined: new Map() }, trouble = new Map(), troubleLast = new Map(), swapErrors = new Map();
  let first = null, last = null;
  for (const e of entries) {
    if (e.at != null) { first = first == null ? e.at : Math.min(first, e.at); last = last == null ? e.at : Math.max(last, e.at); }
    if (e.msg === 'swap' && e.id) {
      const s = swaps.get(e.id) || { id: e.id, phases: [], firstAt: e.at, why: null };
      s.phases.push({ phase: e.to, at: e.at }); s.phase = e.to; s.lastAt = e.at; if (e.why) s.why = String(e.why).slice(0, 160);
      swaps.set(e.id, s);
    } else if (e.msg === 'capacity') capacity.push({ at: e.at, held: e.held, promised: e.promised, open: e.open, holds: e.holds });
    else if (e.msg === 'refill: shielded') refills.push({ at: e.at, amount: e.amount, pulled: !!e.pulled });
    else if (e.msg === 'offer accepted') offers.accepted++;
    else if (e.msg === 'offer declined') bump(offers.declined, String(e.why || 'no reason given').slice(0, 90));
    if (e.level === 'error' || e.level === 'alert' || e.level === 'warn') {
      const k = e.msg === 'unstructured' ? `unstructured: ${String(e.raw).slice(0, 60)}` : e.msg || '(no message)';
      bump(trouble, k); troubleLast.set(k, { at: e.at, error: e.error || e.why || e.raw || null, id: e.id || null });
      if (e.id && e.error) swapErrors.set(e.id, { error: String(e.error).slice(0, 160), at: e.at });      // the last error a swap was given
    }
  }
  const all = [...swaps.values()];
  const ended = {}, open = {};
  const taken = [];
  for (const s of all) {
    if (TERMINAL.has(s.phase)) { ended[s.phase] = (ended[s.phase] || 0) + 1; if (s.phase === 'done' && s.firstAt != null && s.lastAt != null) taken.push(s.lastAt - s.firstAt); }
    else open[s.phase] = (open[s.phase] || 0) + 1;
  }
  const lost = all.filter((s) => s.phase === 'lost' || s.phase === 'refunded' || s.phase === 'aborted');
  return {
    window: { from: first, to: last, hours, lines: entries.length },
    swaps: { seen: all.length, ended, open, openCount: all.length - Object.values(ended).reduce((a, b) => a + b, 0), medianMs: median(taken), slowestMs: taken.length ? Math.max(...taken) : null, finished: taken.length,
      notDone: lost.slice(-8).map((s) => ({ id: s.id, phase: s.phase, why: s.why })),
      // the swaps not over, longest in their phase first, each with the last error it was given
      openList: all.filter((s) => !TERMINAL.has(s.phase)).sort((a, b) => (a.lastAt ?? 0) - (b.lastAt ?? 0)).map((s) => ({ id: s.id, phase: s.phase, since: s.lastAt, error: (swapErrors.get(s.id) || {}).error || null })) },
    capacity: { samples: capacity.length, first: capacity[0] || null, last: capacity.at(-1) || null,
      lowestHeld: capacity.reduce((m, c) => { try { const v = BigInt(c.held); return m == null || v < m ? v : m; } catch { return m; } }, null) },
    refills, offers: { accepted: offers.accepted, declined: [...offers.declined].sort((a, b) => b[1] - a[1]) },
    trouble: [...trouble].sort((a, b) => b[1] - a[1]).map(([msg, n]) => ({ msg, n, last: troubleLast.get(msg) })),
  };
}

export function render(r) {
  const L = [];
  const w = r.window;
  L.push(`Provider report${w.hours ? `, last ${w.hours} h` : ''}: ${w.lines} log lines${w.from ? `, ${new Date(w.from).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(w.to).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`);
  const s = r.swaps, endedTxt = Object.entries(s.ended).map(([k, n]) => `${n} ${k}`).join(', ') || 'none ended', openTxt = Object.entries(s.open).map(([k, n]) => `${n} ${k}`).join(', ');
  L.push(`\nSwaps seen: ${s.seen}. Ended: ${endedTxt}.${s.openCount ? ` Still open: ${s.openCount} (${openTxt}).` : ''}`);
  if (s.finished) L.push(`  finished ones took a median of ${mins(s.medianMs)} from the first log line to done (slowest ${mins(s.slowestMs)})`);
  for (const n of s.notDone) L.push(`  ${n.phase}: ${n.id.slice(0, 12)}…${n.why ? ` (${n.why})` : ''}`);
  if (s.openList.length) {
    L.push('  not over (longest in its phase first):');
    for (const o of s.openList.slice(0, 12)) L.push(`    ${o.phase.padEnd(9)} ${o.id.slice(0, 12)}…  since ${o.since ? hhmm(o.since) : '?'} UTC${o.error ? `  last error: ${o.error}` : ''}`);
    if (s.openList.length > 12) L.push(`    … and ${s.openList.length - 12} more`);
  }
  const c = r.capacity;
  if (c.samples) L.push(`\nCapacity (the 'capacity' lines, ${c.samples} of them): first held ${tac(c.first.held)} TAC, promised ${tac(c.first.promised)} TAC, ${c.first.open} open${c.samples > 1 ? `; last held ${tac(c.last.held)} TAC, promised ${tac(c.last.promised)} TAC, ${c.last.open} open, ${c.last.holds} holds; lowest held ${tac(c.lowestHeld)} TAC` : ''}`);
  else L.push('\nCapacity: no capacity lines in the window.');
  L.push(r.refills.length ? `Shielded by the provider itself: ${r.refills.map((x) => `${tacWei(x.amount)} TAC at ${hhmm(x.at)}`).join(', ')}` : 'Shielded by the provider itself: nothing in the window.');
  L.push(`\nOffers: ${r.offers.accepted} accepted${r.offers.declined.length ? `, ${r.offers.declined.reduce((a, [, n]) => a + n, 0)} declined (${r.offers.declined.slice(0, 4).map(([why, n]) => `${n}x ${why}`).join('; ')})` : ', none declined'}`);
  if (r.trouble.length) {
    L.push('\nWarnings and errors (count, what, the last one):');
    for (const t of r.trouble.slice(0, 12)) L.push(`  ${String(t.n).padStart(4)}  ${t.msg}${t.last && t.last.error ? `  -> ${String(t.last.error).slice(0, 110)}` : ''}${t.last && t.last.at ? `  [${hhmm(t.last.at)}]` : ''}`);
  } else L.push('\nWarnings and errors: none.');
  const bad = r.trouble.filter((t) => /waited long|claimed without revealing|cannot be read|swap step threw|tick failed/.test(t.msg));
  if (bad.length || s.ended.lost) L.push(`\nLOOK AT THESE FIRST: ${[...bad.map((t) => `${t.n}x "${t.msg}"`), s.ended.lost ? `${s.ended.lost} lost swap(s)` : ''].filter(Boolean).join(', ')}`);
  return L.join('\n');
}

// All the app log rows of a service for the last `hours`, newest page first (Render gives 100 at a time and says where the next page starts).
export async function fetchLogs({ key, service = HOUSE.service, owner = HOUSE.owner, hours = 12, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), maxPages = 400, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const startTime = new Date(now() - hours * 3600e3).toISOString();
  let endTime = new Date(now()).toISOString();
  const rows = [], seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ ownerId: owner, type: 'app', direction: 'backward', limit: '100', startTime, endTime });
    q.append('resource', service);
    let res = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      res = await fetchImpl(`https://api.render.com/v1/logs?${q}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (res.status !== 429) break;
      await sleep(1500 * (attempt + 1));
    }
    if (!res.ok) throw new Error(`Render answered ${res.status} for the logs${res.status === 401 || res.status === 403 ? ' (the key was not accepted)' : ''}: ${String(await res.text().catch(() => '')).slice(0, 160)}`);
    const j = await res.json();
    for (const r of j.logs || []) { const id = r.id || `${r.timestamp}|${r.message}`; if (!seen.has(id)) { seen.add(id); rows.push(r); } }
    if (!j.hasMore || !j.nextEndTime || j.nextEndTime === endTime) break;
    endTime = j.nextEndTime;
  }
  return rows;
}

const keyFromEnvOrKeychain = () => {
  const env = String(process.env.RENDER_API_KEY || '').trim();
  if (env) return env;
  try { return execFileSync('security', ['find-generic-password', '-s', 'tacit-render-api-key', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

async function main() {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const hours = Number(arg('--hours', 12));
  if (!(hours > 0 && hours <= 168)) { console.log('--hours must be between 1 and 168'); process.exit(1); }
  const key = keyFromEnvOrKeychain();
  if (!key) { console.log('no Render key: set RENDER_API_KEY, or run this on the Mac that has the keychain item tacit-render-api-key'); process.exit(1); }
  const rows = await fetchLogs({ key, service: arg('--service', HOUSE.service), owner: arg('--owner', HOUSE.owner), hours });
  const summary = summarize(parseLines(rows), { hours });
  console.log(process.argv.includes('--json') ? JSON.stringify(summary, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) : render(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(String((e && e.message) || e).slice(0, 300)); process.exit(1); });
