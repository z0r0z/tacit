// Code-check work for idle nodes: windows of the dapp's JavaScript at a pinned commit, handed out in rotation. A result is a list of
// suggested replacements; each is checked (does the old text occur exactly once, does the patched file still parse) and filed in an
// inbox for a human to review. Nothing here applies, publishes or merges anything.
//
// With `lenses` on, most of the work is a lens SNIPPET instead of a whole window: seventeen lines around code that can hold one kind of Tacit-specific mistake
// (units, BigInt, promises, byte order, boundaries, untrusted text, stored state, networks), with one question about it (codecheck/lenses.mjs). And one job in
// eight is an EXAM: a snippet with a bug the gateway planted in it (codecheck/mutate.mjs), which no node can tell from the rest; what a node does with it
// is scored, never filed.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SYSTEM, windows, parseFindings, applyPatch } from './codecheck/scan.mjs';
import { sites, snippet } from './codecheck/lenses.mjs';
import { plant } from './codecheck/mutate.mjs';
import { scoutMessages, findingId, fits } from './codecheck/roles.mjs';

// the order work is handed out in when lenses are on: mostly lens snippets, some whole windows, and now and then an exam (when exams are on)
const PLAN = ['site', 'site', 'window', 'site', 'site', 'window', 'site', 'exam'];

export function makeScanFeed({ repo, ref = 'origin/main', inbox, results = null, cursorFile, maxLines = Number(process.env.SCAN_MAXLINES || 1800), refreshMs = Number(process.env.SCAN_REFRESH_MS || 3600000), fetch = process.env.SCAN_FETCH === '1', paths = /^dapp\/[^/]+\.js$/,
  lenses = false, examFile = null, rand = Math.random }) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120000 });
  const sync = () => { if (fetch) try { git('fetch', '--quiet', '--no-tags', 'origin'); } catch { /* offline or rate-limited: review what is already here */ } };
  let commit = null, units = null, siteUnits = null, lastCheck = 0; const cache = new Map(); const priority = [], sitePriority = []; let seen = null;
  const show = (c, f) => { const k = c + ':' + f; if (!cache.has(k)) { cache.set(k, git('show', k)); if (cache.size > 64) cache.delete(cache.keys().next().value); } return cache.get(k); };
  const eligible = (c) => git('ls-tree', '-r', '--name-only', c).split('\n').filter((x) => paths.test(x) && !/\.min\.js$|generated|vendor/.test(x)).sort();
  // the windows of every eligible file at one commit
  function build(c) {
    const out = [];
    for (const f of eligible(c)) {
      let src; try { src = show(c, f); } catch { continue; } if (src.split('\n').length > maxLines) continue;
      for (const w of windows(src)) out.push({ file: f, start: w.start, end: w.end, text: w.text });
    }
    return out;
  }
  // the lens snippets of every eligible file at one commit, the ones several lenses meet first
  function buildSites(c) {
    const out = [];
    for (const f of eligible(c)) {
      let src; try { src = show(c, f); } catch { continue; } if (src.split('\n').length > maxLines) continue;
      for (const s of sites(src)) out.push({ file: f, ...s });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }
  const getSites = () => (siteUnits ??= buildSites(commit));
  // Windows of files that changed between two commits go to the front, so new code is reviewed before the rotation reaches it (capped).
  function prioritise(prev, now) {
    let changed = []; try { changed = git('diff', '--name-only', prev, now).split('\n').filter((f) => paths.test(f)); } catch { return; }
    const set = new Set(changed); for (const u of units) if (set.has(u.file) && priority.length < 60) priority.push(u);
    if (lenses) for (const u of getSites()) if (set.has(u.file) && sitePriority.length < 120) sitePriority.push(u);
  }
  function load() {
    sync(); commit = git('rev-parse', ref).trim(); lastCheck = Date.now(); units = build(commit); siteUnits = null;
    try { const prev = JSON.parse(readFileSync(cursorFile, 'utf8')).commit; if (prev && prev !== commit) prioritise(prev, commit); } catch {}   // a restart picks up what changed while it was down
  }
  // Recurring: once an hour (SCAN_REFRESH_MS) the ref is looked up again; a new commit rebuilds the windows and puts the changed files first.
  function refresh() {
    if (Date.now() - lastCheck < refreshMs) return; lastCheck = Date.now(); sync();
    let c; try { c = git('rev-parse', ref).trim(); } catch { return; } if (c === commit) return;
    const prev = commit; commit = c; cache.clear(); units = build(c); siteUnits = null; prioritise(prev, c);
  }
  const state = () => { try { return JSON.parse(readFileSync(cursorFile, 'utf8')); } catch { return {}; } };
  const keep = (s) => writeFileSync(cursorFile, JSON.stringify({ ...s, commit }));
  const job = (meta, messages, max_tokens = 500) => ({ id: randomBytes(8).toString('hex'), kind: 'scan', max_tokens, temperature: 0, meta, messages });

  function windowJob(st) {
    let u = priority.shift(); const fresh = !!u; const i = st.i || 0;
    if (!u) { u = units[i % units.length]; keep({ ...st, i: i + 1 }); } else keep(st);
    return job({ file: u.file, commit, start: u.start, end: u.end, fresh }, [{ role: 'system', content: SYSTEM }, { role: 'user', content: `File: ${u.file}\nLines ${u.start}-${u.end}\n\n${u.text}` }]);
  }
  function siteJob(st) {
    const all = getSites(); if (!all.length) return null;
    let si = st.si || 0, u = null, fresh = false, messages = null;
    for (let t = 0; t < 12 && !u; t++) {   // a snippet too big for a node (a very long line) is passed over
      let c = sitePriority.shift(); const f = !!c; if (!c) { c = all[si % all.length]; si++; }
      const m = scoutMessages(c.lens, c.file, c.start, c.end, c.text);
      if (fits(m)) { u = c; fresh = f; messages = m; }
    }
    keep({ ...st, si }); if (!u) return null;
    return job({ file: u.file, commit, start: u.start, end: u.end, lens: u.lens, site: true, fresh }, messages, 400);
  }
  // A snippet with a planted bug of its lens's own kind, picked at random. null if none of a few tries finds a line it can change.
  function examJob() {
    const all = getSites(); if (!all.length) return null;
    for (let t = 0; t < 6; t++) {
      const u = all[Math.floor(rand() * all.length)]; let src; try { src = show(commit, u.file); } catch { continue; }
      const p = plant(src, { start: u.start, end: u.end, lens: u.lens, strict: true, rand }); if (!p) continue;
      const exam = { line: p.line, orig: p.orig, mut: p.mut, kind: p.kind, lens: u.lens }, messages = scoutMessages(u.lens, u.file, u.start, u.end, snippet(p.src, u.start, u.end));
      if (!fits(messages)) continue;
      return job({ file: u.file, commit, start: u.start, end: u.end, lens: u.lens, site: true, exam }, messages, 400);
    }
    return null;
  }
  async function next() {
    if (!units) load(); else refresh(); if (!units.length) return null;
    const st = state();
    if (!lenses) return windowJob(st);
    const k = st.k || 0, step = PLAN[k % PLAN.length]; st.k = k + 1;
    if (step === 'exam' && examFile) { const j = examJob(); if (j) { keep(st); return j; } }
    if (step !== 'window') { const j = siteJob(st); if (j) return j; }
    return windowJob(st);
  }

  // The same window reviewed again by the same model at temperature 0 says the same thing; a suggestion already filed (whatever a reviewer did
  // with it) is not filed again.
  const key = (file, f) => `${file}\u0001${f.old}\u0001${f.new}`;
  function loadSeen() { seen = new Set(); if (existsSync(inbox)) for (const l of readFileSync(inbox, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); seen.add(key(r.file, r)); } catch {} } }

  // What a scout did with a snippet that had a bug planted in it: 'restored' (a patch that puts the original code back), 'near' (a finding within two lines), or
  // 'miss'; and how many findings were somewhere else.
  function scoreExam(job, text, miner, who) {
    const { file, commit: c, exam } = job.meta; let src; try { src = show(c, file); } catch { return; }
    const lines = src.split('\n'); lines[exam.line - 1] = exam.mut; const mutSrc = lines.join('\n');
    let outcome = 'miss', fp = 0; const found = parseFindings(text).slice(0, 1);
    for (const f of found) {
      if (applyPatch(mutSrc, f) === src) outcome = 'restored';
      else if (f.line != null && Math.abs(f.line - exam.line) <= 2) { if (outcome !== 'restored') outcome = 'near'; }
      else fp++;
    }
    try { appendFileSync(examFile, JSON.stringify({ t: Date.now(), role: 'scout', lens: exam.lens, kind: exam.kind, miner, ...who, outcome, fp, n: found.length }) + '\n'); } catch {}
  }

  async function onResult(job, text, miner, who = {}) {
    if (job.meta.exam) { if (examFile) scoreExam(job, text, miner, who); return; }   // a planted bug is scored, never filed
    const { file, commit: c, start, end, fresh, lens } = job.meta; let src; try { src = show(c, file); } catch { return; }
    if (!seen) loadSeen();
    const found = parseFindings(text).slice(0, lens ? 1 : 3);
    if (results) appendFileSync(results, JSON.stringify({ t: Date.now(), miner, n: found.length }) + '\n');   // one line per window looked at, what the digest counts as reviewed
    for (const f of found) {
      if (seen.has(key(file, f))) continue; seen.add(key(file, f));
      const patched = applyPatch(src, f); let status = 'no-apply';
      if (patched !== null) { const d = mkdtempSync(path.join(tmpdir(), 'scan-')); const p = path.join(d, 'x.mjs'); writeFileSync(p, patched); status = spawnSync('node', ['--check', p]).status === 0 ? 'syntax-ok' : 'syntax-error'; rmSync(d, { recursive: true, force: true }); }
      appendFileSync(inbox, JSON.stringify({ t: Date.now(), id: findingId(file, f.old, f.new), miner, file, commit: c.slice(0, 10), window: `${start}-${end}`, line: f.line, why: String(f.why || '').slice(0, 300), old: f.old, new: f.new, status, review: 'new',
        ...(lens ? { lens } : {}), ...(who.node ? { node: who.node, tier: who.tier, model: who.model } : {}), ...(fresh ? { fresh: true } : {}) }) + '\n');
    }
  }
  // what the check feed needs: the code at a commit, and a snippet to plant a bug in
  const sample = () => { if (!units) load(); const all = getSites(); if (!all.length) return null; const u = all[Math.floor(rand() * all.length)]; return { ...u, commit }; };
  return { next, onResult, source: show, sample, size: () => { if (!units) load(); return units.length; } };
}
