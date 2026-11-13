// The review's running record. Every exam answer and every vote is appended to a file and folded into counts kept in memory, so a busy gateway answers each lease
// from those counts instead of reading its files again. A file that changed under it (another writer, a test, a restore: its size or its time moved) is read again; the exam file is cut back
// to its newest `keep` rows once it holds twice that many.
//
// How much a machine's vote counts, and whether its review work earns points, come from its most recent answers only: a prompt or a model that changed is judged
// on what it does now.
import { readFileSync, appendFileSync, existsSync, statSync, writeFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs';

// right and wrong answers to planted claims -> a vote weight: nothing on record below minExam answers (null), then by how often it was right; at or below chance, 0
export function weightFor(right, wrong, minExam = 6) {
  const n = right + wrong; if (n < minExam) return null;
  const acc = right / n; return acc >= 0.8 ? 1.5 : acc >= 0.6 ? 1 : acc > 0.5 ? 0.5 : 0;
}

export const emptySummary = () => ({
  scout: { n: 0, invalid: 0, restored: 0, near: 0, miss: 0, fp: 0, byLens: {}, byTier: {}, byKind: {} },
  skeptic: { n: 0, invalid: 0, right: 0, wrong: 0, unsure: 0, byLens: {}, byTier: {}, byKind: {}, byTruth: {}, choices: {} },
});
const bump = (bucket, key, field) => { const b = bucket[key] ||= { n: 0 }; if (field !== 'invalid') b.n++; b[field] = (b[field] || 0) + 1; };
// One exam row into the counts: scouts by outcome (restored, near, miss, and findings elsewhere), skeptics by outcome (right, wrong, unsure), each overall, by lens,
// by tier and by kind of bug; skeptics also by whether the claim was true and by the letter picked. `invalid` counts replies that were not the JSON asked for (they
// are not graded, so they are not in n).
export function examAdd(out, r) {
  const role = out[r.role]; if (!role) return out;
  if (r.outcome === 'invalid') { role.invalid++; bump(role.byLens, r.lens || '?', 'invalid'); bump(role.byTier, r.tier || 'unknown', 'invalid'); return out; }
  role.n++; role[r.outcome] = (role[r.outcome] || 0) + 1; if (r.role === 'scout') role.fp += r.fp || 0;
  bump(role.byLens, r.lens || '?', r.outcome); bump(role.byTier, r.tier || 'unknown', r.outcome); bump(role.byKind, r.kind || '?', r.outcome);
  if (r.role === 'skeptic' && r.choice) role.choices[r.choice] = (role.choices[r.choice] || 0) + 1;   // always A or always B is a machine that does not read
  if (r.role === 'skeptic' && typeof r.truth === 'boolean') bump(role.byTruth, String(r.truth), r.outcome);   // a machine that says yes to everything shows here
  return out;
}
export const examSummary = (rows) => rows.reduce(examAdd, emptySummary());

const parse = (txt) => txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// a file's size and time together: a rewrite to the same size still moves the time
const sigOf = (file) => { if (!file || !existsSync(file)) return '0'; const st = statSync(file); return `${st.size}:${st.mtimeMs}`; };
const short = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a)) ? `${a.slice(0, 8)}…${a.slice(-4)}`.toLowerCase() : '?');

export function makeExamBook({ file, keep = 100_000, window = 200, lensWindow = 100, scoutWindow = 40, minExam = 6, scoutProbation = 20 }) {
  let sig = null, lines = 0, version = 0, sum, skeptic, scout, byMiner, byLens;
  const reset = () => { sum = emptySummary(); skeptic = new Map(); scout = new Map(); byMiner = new Map(); byLens = new Map(); lines = 0; };
  const push = (map, k, v, n) => { let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(v); if (a.length > n) a.shift(); };
  function take(r) {
    examAdd(sum, r); lines++;
    const graded = r.role === 'skeptic' ? r.outcome === 'right' || r.outcome === 'wrong' : r.role === 'scout' && ['restored', 'near', 'miss'].includes(r.outcome);
    if (!graded) return;
    const ok = r.role === 'skeptic' ? r.outcome === 'right' : r.outcome !== 'miss';
    if (r.node) push(r.role === 'skeptic' ? skeptic : scout, r.node, ok, r.role === 'skeptic' ? window : scoutWindow);
    if (r.node && r.lens && r.role === 'skeptic') push(byLens, `${r.node}\u0001${r.lens}`, ok, lensWindow);   // the same machine, on one kind of mistake
    if (r.miner) { const m = byMiner.get(r.miner) || { skeptic: [], scout: [] }; byMiner.set(r.miner, m); m[r.role].push(ok); if (m[r.role].length > (r.role === 'skeptic' ? window : scoutWindow)) m[r.role].shift(); }
  }
  function load() {
    reset();
    if (file && existsSync(file)) {
      let rows = parse(readFileSync(file, 'utf8'));
      if (rows.length > keep) { rows = rows.slice(-keep); writeFileSync(file + '.tmp', rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); renameSync(file + '.tmp', file); }
      for (const r of rows) take(r);
    }
    sig = sigOf(file); version++;
  }
  const sync = () => { if (sigOf(file) !== sig) load(); };
  function add(row) {
    sync();
    try { appendFileSync(file, JSON.stringify(row) + '\n'); sig = sigOf(file); } catch { /* a full disk loses a row, not the service */ }
    take(row); version++;
    if (lines > 2 * keep) load();
  }
  let skillCache = { v: -1, m: null };
  function skill() {
    sync(); if (skillCache.v === version) return skillCache.m;
    const m = new Map(); for (const [node, a] of skeptic) { const right = a.filter(Boolean).length, w = weightFor(right, a.length - right, minExam); if (w !== null) m.set(node, w); }
    skillCache = { v: version, m }; return m;
  }
  // How much each machine's vote counts on a finding of one lens: its record on that lens once it has minExam answers there (a small model can judge a missing
  // await well and a boundary not at all), its record overall until then. The book is read once, then any number of machines and lenses are looked up.
  // -> { get(node, lens) }: a weight, or undefined for a machine with nothing on record.
  let lensCache = { v: -1, m: new Map() };
  function weights() {
    const overall = skill();
    if (lensCache.v !== version) lensCache = { v: version, m: new Map() };
    const m = lensCache.m;
    return {
      get(node, lens) {
        if (!node) return undefined;
        if (lens) {
          const k = `${node}\u0001${lens}`;
          if (!m.has(k)) { const a = byLens.get(k); let w = null; if (a) { const right = a.filter(Boolean).length; w = weightFor(right, a.length - right, minExam); } m.set(k, w); }
          if (m.get(k) !== null) return m.get(k);
        }
        return overall.get(node);
      },
    };
  }
  // Whether review work of this kind earns points for this machine: a skeptic whose recent answers are at chance or worse does not; nor a scout that has found none
  // of its last scoutProbation planted bugs or more. A machine without that much on record is paid.
  function payable(kind, node) {
    if (!node) return true;
    if (kind === 'check') { const w = skill().get(node); return w === undefined || w > 0; }
    if (kind === 'scan') { sync(); const a = scout.get(node) || []; return a.length < scoutProbation || a.some(Boolean); }
    return true;
  }
  // each address's recent record, for the public stats: skeptic answers right of graded, planted bugs found of graded; the busiest first
  function standings(limit = 50) {
    sync();
    return [...byMiner.entries()].map(([miner, m]) => ({ miner: short(miner), skeptic: { n: m.skeptic.length, right: m.skeptic.filter(Boolean).length }, scout: { n: m.scout.length, found: m.scout.filter(Boolean).length } }))
      .sort((x, y) => y.skeptic.n + y.scout.n - (x.skeptic.n + x.scout.n)).slice(0, limit);
  }
  load();
  return { add, sync, skill, weights, payable, standings, summary: () => { sync(); return sum; }, version: () => { sync(); return version; }, lines: () => lines };
}

// The skeptics' votes, by finding. A finding gets a few at most, so the file stays small; it is read again only when it changed under the book.
export function makeVoteBook({ file }) {
  let sig = null, version = 0, byId = new Map();
  const put = (r) => { if (!r || !r.id) return; let a = byId.get(r.id); if (!a) byId.set(r.id, (a = [])); a.push(r); };
  function load() { byId = new Map(); if (file && existsSync(file)) for (const r of parse(readFileSync(file, 'utf8'))) put(r); sig = sigOf(file); version++; }
  const sync = () => { if (sigOf(file) !== sig) load(); };
  function add(row) {
    sync();
    try { appendFileSync(file, JSON.stringify(row) + '\n'); sig = sigOf(file); } catch { /* as above */ }
    put(row); version++;
  }
  load();
  // `peek` is `of` without looking at the file first: for a caller that has just synced and looks at many findings in a row
  return { add, sync, of: (id) => { sync(); return byId.get(id) || []; }, peek: (id) => byId.get(id) || [], version: () => { sync(); return version; }, count: () => { sync(); let n = 0; for (const a of byId.values()) n += a.length; return n; } };
}

// A file other code appends lines to (the inbox of findings), read a piece at a time: each call reads only what was added since the last, so a file that grows
// all day costs nothing to look at again. A file rewritten (the inbox tool marks findings), cut short or replaced is read from the start; it is told apart from
// an append by the last bytes read no longer being where they were. -> rows(): the rows so far (a new array after a read from the start), and gen(): how
// many times it started over.
export function makeTailRows(file) {
  let rows = [], size = 0, ino = null, mtime = 0, rest = Buffer.alloc(0), probe = null, gen = 0;
  const startOver = () => { rows = []; size = 0; rest = Buffer.alloc(0); probe = null; gen++; };
  const bytes = (fd, from, to) => { const b = Buffer.alloc(Math.max(0, to - from)); if (b.length) readSync(fd, b, 0, b.length, from); return b; };
  function read() {
    if (!file || !existsSync(file)) { if (size || rows.length) startOver(); return rows; }
    const st = statSync(file);
    if (st.ino !== ino || st.size < size || (st.size === size && st.mtimeMs !== mtime)) { if (size || ino !== null) startOver(); ino = st.ino; }
    if (st.size === size) { mtime = st.mtimeMs; return rows; }
    const fd = openSync(file, 'r');
    try {
      if (probe && !bytes(fd, size - probe.length, size).equals(probe)) startOver();
      const all = Buffer.concat([rest, bytes(fd, size, st.size)]), cut = all.lastIndexOf(10);
      rest = cut < 0 ? all : all.subarray(cut + 1);
      if (cut >= 0) for (const l of all.subarray(0, cut).toString('utf8').split('\n')) { if (!l) continue; try { rows.push(JSON.parse(l)); } catch { /* a torn or foreign line */ } }
      size = st.size; mtime = st.mtimeMs; probe = bytes(fd, Math.max(0, size - 64), size);
    } finally { closeSync(fd); }
    return rows;
  }
  return { rows: read, gen: () => gen };
}
