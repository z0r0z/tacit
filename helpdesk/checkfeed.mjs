// The skeptics' side of the review. A finding a scout filed is handed to other machines, one at a time and never to the machine that proposed it, each asked to
// try to refute it and to quote the line it relied on (codecheck/roles.mjs). The gateway reads the votes: a verdict whose quote is not in the code counts as
// unsure, each machine's vote is weighed by how it has done on planted bugs, and a finding is CONFIRMED once enough weight says real and more says real than
// false. Only confirmed findings go to the review channel.
//
// Now and then a skeptic is given an EXAM instead: a claim built from a bug the gateway planted (true: the code has the bug and the claim puts the original line
// back) or from the original code with the bug as the "fix" (false). Which it was is known, so the answer is marked right or wrong with nobody reading, per lens
// and per size of machine; a machine that cannot tell the two apart carries little weight.
import { readFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { snippet } from './codecheck/lenses.mjs';
import { plant } from './codecheck/mutate.mjs';
import { skepticMessages, voteOf, examClaim, findingId, fits } from './codecheck/roles.mjs';
import { plain } from './codecheck/scan.mjs';

const cached = new Map();   // file -> { sig, rows }: a file is read again only when it has changed
export function readRows(file) {
  if (!file || !existsSync(file)) return [];
  const st = statSync(file), sig = `${st.size}:${st.mtimeMs}`, c = cached.get(file);
  if (c && c.sig === sig) return c.rows;
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  cached.set(file, { sig, rows }); return rows;
}

// How much a machine's vote counts, from its skeptic exams: nothing is assumed of a machine with fewer than minExam answers (1), a big machine starts a little higher,
// and then it is how often it was right when it gave a verdict. A machine at or below chance (always yes, always no, guessing) counts for little or nothing.
export function skillTable(examRows, minExam = 6) {
  const by = new Map();
  for (const r of examRows) { if (r.role !== 'skeptic' || !r.node) continue; const s = by.get(r.node) || { right: 0, wrong: 0 }; if (r.outcome === 'right') s.right++; else if (r.outcome === 'wrong') s.wrong++; by.set(r.node, s); }
  const out = new Map();
  for (const [node, s] of by) { const n = s.right + s.wrong; if (n < minExam) continue; const acc = s.right / n; out.set(node, acc >= 0.8 ? 1.5 : acc >= 0.6 ? 1 : acc > 0.5 ? 0.5 : 0); }
  return out;
}
export const weightOf = (row, skill) => (row.tier === 'big' ? 1.5 : 1) * (skill.get(row.node) ?? 1);

// The state of one finding from its votes (the latest of each machine): CONFIRMED, REFUTED, UNCLEAR (a full panel and no decision) or PENDING.
export function decide(voteRows, skill, { panel = 3, quorum = 2 } = {}) {
  const latest = new Map(); for (const r of voteRows) latest.set(r.node || r.miner, r);
  let yes = 0, no = 0; const counts = { real: 0, false: 0, unsure: 0 };
  for (const r of latest.values()) { const w = weightOf(r, skill); if (r.vote === 'real') { yes += w; counts.real++; } else if (r.vote === 'false') { no += w; counts.false++; } else counts.unsure++; }
  const n = latest.size;
  const state = yes >= quorum && yes > no ? 'confirmed' : no >= quorum && no >= yes ? 'refuted' : n >= panel ? 'unclear' : 'pending';
  return { state, yes, no, n, counts };
}

export function makeCheckFeed({ source, sample, inbox, checks, exam, panel = 3, quorum = 2, examEvery = 4, minExam = 6, context = 15, rand = Math.random, now = Date.now, say = () => {} }) {
  const findings = () => readRows(inbox).map((r) => ({ ...r, id: r.id || findingId(r.file, r.old, r.new) }));
  // Whether this machine proposed the finding. A finding filed before machines were recorded names only the address, so the address stands in for the machine.
  const proposedBy = (r, who) => (r.node ? !!who.node && r.node === who.node : !!r.miner && !!who.miner && String(r.miner).toLowerCase() === String(who.miner).toLowerCase());
  // the votes on each finding, the proposer's own never among them
  const votesFor = () => {
    const by = new Map(), owner = new Map(); for (const r of findings()) owner.set(r.id, r);
    for (const v of readRows(checks)) { const f = owner.get(v.id); if (f && proposedBy(f, { node: v.node, miner: v.miner })) continue; if (!by.has(v.id)) by.set(v.id, []); by.get(v.id).push(v); }
    return by;
  };
  const skill = () => skillTable(readRows(exam), minExam);
  const decision = (id) => decide(votesFor().get(id) || [], skill(), { panel, quorum });
  const append = (file, row) => { try { appendFileSync(file, JSON.stringify(row) + '\n'); } catch { /* a full disk loses a vote, not the service */ } };

  // A finding that still needs votes, for this machine: not decided, not full, not proposed by it, not already voted on by it. Findings in code that just changed
  // first, those a model like this one has not voted on before those it has, then the ones already part-way to a decision, then the oldest.
  function realJob(who) {
    const votes = votesFor(), sk = skill(); const open = [];
    for (const r of findings()) {
      if (r.status !== 'syntax-ok' || r.review !== 'new') continue;
      const vs = votes.get(r.id) || [];
      if (proposedBy(r, who)) continue;
      if (vs.some((v) => v.node === who.node)) continue;
      if (decide(vs, sk, { panel, quorum }).state !== 'pending') continue;
      open.push({ r, vs, seen: who.model ? vs.some((v) => v.model === who.model) : false });
    }
    if (!open.length) return null;
    open.sort((a, b) => (a.seen - b.seen) || ((b.r.fresh ? 1 : 0) - (a.r.fresh ? 1 : 0)) || (b.vs.length - a.vs.length) || (a.r.t - b.r.t));
    for (const { r } of open) {
      let src; try { src = source(r.commit, r.file); } catch { continue; }
      const [ws, we] = String(r.window || '').split('-').map(Number), at = Number.isInteger(r.line) ? r.line : ws;
      const codeText = snippet(src, Math.min(at - context, ws || at), Math.max(at + context, we || at));
      const messages = skepticMessages(r, codeText); if (!fits(messages)) continue;
      return { id: randomBytes(8).toString('hex'), kind: 'check', max_tokens: 300, temperature: 0, meta: { check: true, fid: r.id, codeText }, messages };
    }
    return null;
  }
  function examJob() {
    for (let t = 0; t < 6; t++) {
      const s = sample(); if (!s) return null; let src; try { src = source(s.commit, s.file); } catch { continue; }
      const p = plant(src, { start: s.start, end: s.end, lens: s.lens, strict: true, rand }); if (!p) continue;
      const truth = rand() < 0.5, ex = examClaim({ ...p, file: s.file }, truth, src);
      const codeText = snippet(ex.code, p.line - context, p.line + context);
      const messages = skepticMessages(ex.claim, codeText); if (!fits(messages)) continue;
      return { id: randomBytes(8).toString('hex'), kind: 'check', max_tokens: 300, temperature: 0, meta: { check: true, exam: { truth, lens: s.lens, kind: p.kind }, codeText }, messages };
    }
    return null;
  }
  // -> a job for the machine described by `who` ({ node, tier, model }), or null. One ask in examEvery is an exam.
  async function next(who = {}) {
    const wantExam = examEvery > 0 && rand() < 1 / examEvery;
    if (wantExam) return examJob() || realJob(who);
    return realJob(who);
  }
  async function onResult(job, text, miner, who = {}) {
    const v = voteOf(text, job.meta.codeText); if (!v) return;
    const base = { t: now(), miner, node: who.node, tier: who.tier, model: who.model };
    if (job.meta.exam) {
      const ex = job.meta.exam, outcome = v.vote === 'unsure' ? 'unsure' : (v.vote === 'real') === ex.truth ? 'right' : 'wrong';
      append(exam, { ...base, role: 'skeptic', lens: ex.lens, kind: ex.kind, truth: ex.truth, outcome, grounded: v.ok }); return;
    }
    append(checks, { ...base, id: job.meta.fid, verdict: v.verdict, vote: v.vote, grounded: v.ok });
  }
  // a reply that was not a verdict: kept beside the exam results as invalid (not graded), with the start of what came back
  function onInvalid(job, text, miner, who = {}) {
    const sample = plain(text).slice(0, 160);
    append(exam, { t: now(), role: 'skeptic', lens: job.meta.exam?.lens, exam: !!job.meta.exam, miner, node: who.node, tier: who.tier, model: who.model, outcome: 'invalid', sample });
    say(`invalid skeptic reply (${who.tier || '?'}, ${who.model || '?'}): ${JSON.stringify(sample)}`);
  }
  // how the findings stand, for /stats: counts by state, and the exam results by role, lens and size of machine
  function summary() {
    const votes = votesFor(), sk = skill(), states = { confirmed: 0, refuted: 0, unclear: 0, pending: 0 };
    for (const r of findings()) if (r.status === 'syntax-ok') states[decide(votes.get(r.id) || [], sk, { panel, quorum }).state]++;
    return { findings: states, exam: examSummary(readRows(exam)) };
  }
  return { next, onResult, onInvalid, decision, summary };
}

// The exam results as counts: scouts by outcome (restored, near, miss, and findings elsewhere), skeptics by outcome (right, wrong, unsure), each overall, by lens and by
// tier. `invalid` counts replies that were not the JSON asked for, in any job (they are not graded, so they are not in n).
export function examSummary(rows) {
  const out = { scout: { n: 0, invalid: 0, restored: 0, near: 0, miss: 0, fp: 0, byLens: {}, byTier: {}, byKind: {} }, skeptic: { n: 0, invalid: 0, right: 0, wrong: 0, unsure: 0, byLens: {}, byTier: {}, byKind: {}, byTruth: {} } };
  const bump = (bucket, key, field) => { const b = bucket[key] ||= { n: 0 }; if (field !== 'invalid') b.n++; b[field] = (b[field] || 0) + 1; };
  for (const r of rows) {
    const role = out[r.role]; if (!role) continue;
    if (r.outcome === 'invalid') { role.invalid++; bump(role.byLens, r.lens || '?', 'invalid'); bump(role.byTier, r.tier || 'unknown', 'invalid'); continue; }
    role.n++; role[r.outcome] = (role[r.outcome] || 0) + 1; if (r.role === 'scout') role.fp += r.fp || 0;
    bump(role.byLens, r.lens || '?', r.outcome); bump(role.byTier, r.tier || 'unknown', r.outcome); bump(role.byKind, r.kind || '?', r.outcome);
    if (r.role === 'skeptic' && typeof r.truth === 'boolean') bump(role.byTruth, String(r.truth), r.outcome);   // right on true claims and on false ones: a machine that says yes to everything shows here
  }
  return out;
}
