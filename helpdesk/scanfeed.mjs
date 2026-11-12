// Code-check work for idle nodes: windows of the dapp's JavaScript at a pinned commit, handed out in rotation. A result is a list of
// suggested replacements; each is checked (does the old text occur exactly once, does the patched file still parse) and filed in an
// inbox for a human to review. Nothing here applies, publishes or merges anything.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SYSTEM, windows, parseFindings, applyPatch } from './codecheck/scan.mjs';

export function makeScanFeed({ repo, ref = 'origin/main', inbox, results = null, cursorFile, maxLines = Number(process.env.SCAN_MAXLINES || 1800), refreshMs = Number(process.env.SCAN_REFRESH_MS || 3600000), fetch = process.env.SCAN_FETCH === '1', paths = /^dapp\/[^/]+\.js$/ }) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120000 });
  const sync = () => { if (fetch) try { git('fetch', '--quiet', '--no-tags', 'origin'); } catch { /* offline or rate-limited: review what is already here */ } };
  let commit = null, units = null, lastCheck = 0; const cache = new Map(); const priority = []; let seen = null;
  const show = (c, f) => { const k = c + ':' + f; if (!cache.has(k)) { cache.set(k, git('show', k)); if (cache.size > 64) cache.delete(cache.keys().next().value); } return cache.get(k); };
  // the windows of every eligible file at one commit
  function build(c) {
    const out = [];
    for (const f of git('ls-tree', '-r', '--name-only', c).split('\n').filter((x) => paths.test(x) && !/\.min\.js$|generated|vendor/.test(x)).sort()) {
      let src; try { src = show(c, f); } catch { continue; } if (src.split('\n').length > maxLines) continue;
      for (const w of windows(src)) out.push({ file: f, start: w.start, end: w.end, text: w.text });
    }
    return out;
  }
  // Windows of files that changed between two commits go to the front, so new code is reviewed before the rotation reaches it (capped).
  function prioritise(prev, now) {
    let changed = []; try { changed = git('diff', '--name-only', prev, now).split('\n').filter((f) => paths.test(f)); } catch { return; }
    const set = new Set(changed); for (const u of units) if (set.has(u.file) && priority.length < 60) priority.push(u);
  }
  function load() {
    sync(); commit = git('rev-parse', ref).trim(); lastCheck = Date.now(); units = build(commit);
    try { const prev = JSON.parse(readFileSync(cursorFile, 'utf8')).commit; if (prev && prev !== commit) prioritise(prev, commit); } catch {}   // a restart picks up what changed while it was down
  }
  // Recurring: once an hour (SCAN_REFRESH_MS) the ref is looked up again; a new commit rebuilds the windows and puts the changed files first.
  function refresh() {
    if (Date.now() - lastCheck < refreshMs) return; lastCheck = Date.now(); sync();
    let c; try { c = git('rev-parse', ref).trim(); } catch { return; } if (c === commit) return;
    const prev = commit; commit = c; cache.clear(); units = build(c); prioritise(prev, c);
  }
  const getCursor = () => { try { return JSON.parse(readFileSync(cursorFile, 'utf8')).i || 0; } catch { return 0; } };
  async function next() {
    if (!units) load(); else refresh(); if (!units.length) return null;
    let u = priority.shift(); const fresh = !!u; const i = getCursor();
    if (!u) { u = units[i % units.length]; writeFileSync(cursorFile, JSON.stringify({ i: i + 1, commit })); } else writeFileSync(cursorFile, JSON.stringify({ i, commit }));
    return { id: randomBytes(8).toString('hex'), kind: 'scan', max_tokens: 500, temperature: 0, meta: { file: u.file, commit, start: u.start, end: u.end, fresh },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `File: ${u.file}\nLines ${u.start}-${u.end}\n\n${u.text}` }] };
  }
  // The same window reviewed again by the same model at temperature 0 says the same thing; a suggestion already filed (whatever a reviewer did
  // with it) is not filed again.
  const key = (file, f) => `${file}\u0001${f.old}\u0001${f.new}`;
  function loadSeen() { seen = new Set(); if (existsSync(inbox)) for (const l of readFileSync(inbox, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); seen.add(key(r.file, r)); } catch {} } }
  async function onResult(job, text, miner) {
    const { file, commit: c, start, end, fresh } = job.meta; let src; try { src = show(c, file); } catch { return; }
    if (!seen) loadSeen();
    const found = parseFindings(text);
    if (results) appendFileSync(results, JSON.stringify({ t: Date.now(), miner, n: found.length }) + '\n');   // one line per window looked at, what the digest counts as reviewed
    for (const f of found) {
      if (seen.has(key(file, f))) continue; seen.add(key(file, f));
      const patched = applyPatch(src, f); let status = 'no-apply';
      if (patched !== null) { const d = mkdtempSync(path.join(tmpdir(), 'scan-')); const p = path.join(d, 'x.mjs'); writeFileSync(p, patched); status = spawnSync('node', ['--check', p]).status === 0 ? 'syntax-ok' : 'syntax-error'; rmSync(d, { recursive: true, force: true }); }
      appendFileSync(inbox, JSON.stringify({ t: Date.now(), miner, file, commit: c.slice(0, 10), window: `${start}-${end}`, line: f.line, why: String(f.why || '').slice(0, 300), old: f.old, new: f.new, status, review: 'new', ...(fresh ? { fresh: true } : {}) }) + '\n');
    }
  }
  return { next, onResult, size: () => { if (!units) load(); return units.length; } };
}
