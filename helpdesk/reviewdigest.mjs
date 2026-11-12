// The community reviewers' suggestions, to the team's private review channel. The scan feed (scanfeed.mjs) files each suggestion that applies exactly once and
// still parses; once a UTC day the best few of what came in since the last digest go to the API's /nudger/digest, where the bot posts each with Useful, Noise and
// Already known buttons and every click is stored as a label on that finding. A reviewer is named by its address. Nothing here applies or merges anything.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const squash = (s) => String(s).replace(/\s+/g, '');
const noComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
// A suggestion that only moves whitespace or edits a comment changes nothing the code does.
export const trivial = (o, n) => squash(o) === squash(n) || squash(noComments(o)) === squash(noComments(n));
export const shortAddr = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a)) ? `${a.slice(0, 6)}…${a.slice(-4)}`.toLowerCase() : '');
const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

// Which of the filed suggestions are worth a person's look: new ones (not already marked by a reviewer) that apply, parse and change what the code does.
// Ranked by how many different reviewers made the same finding (the same file, a line within three), then by being in code that just changed, then by the
// smaller change; at most `perFile` from one file and `max` in all.
export function pick(records, { max = 8, perFile = 2 } = {}) {
  const ok = records.filter((r) => r && r.status === 'syntax-ok' && r.review === 'new' && Number.isFinite(Number(r.line)) && String(r.why || '').trim() && typeof r.old === 'string' && typeof r.new === 'string' && !trivial(r.old, r.new));
  const agree = (r) => new Set(ok.filter((x) => x.file === r.file && Math.abs(Number(x.line) - Number(r.line)) <= 3).map((x) => x.miner)).size;
  const scored = ok.map((r) => ({ r, n: agree(r), s: agree(r) * 100 + (r.fresh ? 10 : 0) - Math.min(9, Math.floor((r.old.length + r.new.length) / 100)) }))
    .sort((a, b) => b.s - a.s || b.r.t - a.r.t);
  const out = [], per = new Map();
  for (const x of scored) {
    if (out.length >= max) break;
    if ((per.get(x.r.file) || 0) >= perFile) continue;
    if (out.some((y) => y.r.file === x.r.file && Math.abs(Number(y.r.line) - Number(x.r.line)) <= 3)) continue;   // the same spot is posted once
    per.set(x.r.file, (per.get(x.r.file) || 0) + 1);
    out.push(x);
  }
  return out;
}

// The digest the API takes: each pick as a finding from a community reviewer (the least trusted kind), `reviewed` the windows of code looked at.
export function toDigest(picked, { day, reviewed }) {
  const stamp = `n${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-`;
  return {
    day, reviewed, unit: 'window',
    findings: picked.map(({ r, n }, i) => ({
      id: `${stamp}${i + 1}`, file: r.file, line: Number(r.line), commit: r.commit, subject: `window ${r.window}`,
      claim: oneLine(r.why, 300), evidence: `suggested change: ${oneLine(r.old, 180)} -> ${oneLine(r.new, 180)}`,
      severity: 'low', status: 'candidate', by: `${shortAddr(r.miner)}${n > 1 ? ` +${n - 1} more` : ''}`.trim(),
    })),
  };
}

const readLines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

// Once a UTC day, from `hourUtc` on: everything filed since the last digest, the best few of it, to the API with the shared secret (the bot token stays there).
// A day already posted is not posted again, and a refusal leaves the day open for the next tick. → null (nothing due), { posted, reviewed } or { error }.
export function makeDigestPoster({ api, secret, inbox, results, stateFile, hourUtc = 0, max = 8, now = Date.now, fetchImpl = globalThis.fetch }) {
  const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  let busy = false;   // a tick that finds the last one still waiting on the API does nothing
  async function tick() {
    if (busy) return null;
    busy = true;
    try {
      const t = now(), d = new Date(t), day = d.toISOString().slice(0, 10), st = readState();
      if (st.lastDay === day || d.getUTCHours() < hourUtc) return null;
      const since = st.lastTs || 0;
      const picked = pick(readLines(inbox).filter((r) => r.t > since), { max });
      const reviewed = readLines(results).filter((r) => r.t > since).length;
      const res = await fetchImpl(`${api}/nudger/digest`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(toDigest(picked, { day, reviewed })), signal: AbortSignal.timeout(60_000) });
      const text = await res.text().catch(() => '');
      if (!res.ok) return { error: `HTTP ${res.status} ${text.slice(0, 120)}` };
      writeFileSync(stateFile, JSON.stringify({ lastDay: day, lastTs: t }));
      return { posted: picked.length, reviewed };
    } finally { busy = false; }
  }
  return { tick };
}
