// The skeptics' side of the review. A finding a scout filed is handed to other machines, one at a time and never to the machine that proposed it, each asked to
// try to refute it and to quote the line it relied on (codecheck/roles.mjs). The gateway reads the votes: a verdict whose quote is not in the code counts as
// unsure, each machine's vote is weighed by how it has done on planted bugs, and a finding is CONFIRMED once enough weight says real and more says real than
// false. Only confirmed findings go to the review channel.
//
// Now and then a skeptic is given an EXAM instead: a claim built from a bug the gateway planted (true: the code has the bug and the claim puts the original line
// back) or from the original code with the bug as the "fix" (false). Which it was is known, so the answer is marked right or wrong with nobody reading, per lens
// and per size of machine; a machine that cannot tell the two apart carries little weight.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { plant } from './codecheck/mutate.mjs';
import { skepticMessages, proposedSide, voteOf, examClaim, findingId, fits, blindView } from './codecheck/roles.mjs';
import { sampleOf } from './codecheck/scan.mjs';
import { makeExamBook, makeVoteBook, makeTailRows, weightFor, examSummary } from './swarmbook.mjs';
export { examSummary };

const cached = new Map();   // file -> { sig, rows }: a file is read again only when it has changed
export function readRows(file) {
  if (!file || !existsSync(file)) return [];
  const st = statSync(file), sig = `${st.size}:${st.mtimeMs}`, c = cached.get(file);
  if (c && c.sig === sig) return c.rows;
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  cached.set(file, { sig, rows }); return rows;
}

// How much a machine's vote counts, from its skeptic exams (all of the rows given): nothing is assumed of a machine with fewer than minExam answers (1), a big machine
// starts a little higher, and then it is how often it was right when it gave a verdict. A machine at or below chance (always yes, always no, guessing) counts for
// little or nothing. The running gateway takes the same measure over each machine's most recent answers (swarmbook.mjs).
export function skillTable(examRows, minExam = 6) {
  const by = new Map();
  for (const r of examRows) { if (r.role !== 'skeptic' || !r.node) continue; const s = by.get(r.node) || { right: 0, wrong: 0 }; if (r.outcome === 'right') s.right++; else if (r.outcome === 'wrong') s.wrong++; by.set(r.node, s); }
  const out = new Map();
  for (const [node, s] of by) { const w = weightFor(s.right, s.wrong, minExam); if (w !== null) out.set(node, w); }
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

// `exam` and `checks` are the exam and vote books (swarmbook.mjs) the gateway shares between its feeds, or the paths of their files. `pool`, when given, is where
// planted bugs come from (made ahead of time, codecheck/mutate.mjs); without it one is made for each exam.
export function makeCheckFeed({ source, sample, inbox, checks, exam, pool = null, panel = 3, quorum = 2, examEvery = 4, minExam = 6, context = 15, rand = Math.random, now = Date.now, say = () => {} }) {
  const book = exam && typeof exam === 'object' ? exam : makeExamBook({ file: exam, minExam });
  const votes = checks && typeof checks === 'object' ? checks : makeVoteBook({ file: checks });
  // the inbox is read a piece at a time as scouts add to it (makeTailRows); the findings list grows with it, and is built again only when the file was rewritten
  const inboxRows = makeTailRows(inbox);
  let fc = { rows: null, n: 0, list: [], owner: new Map() };
  const findings = () => {
    const rows = inboxRows.rows();
    if (rows !== fc.rows) fc = { rows, n: 0, list: [], owner: new Map() };
    for (; fc.n < rows.length; fc.n++) { const r = { ...rows[fc.n], id: rows[fc.n].id || findingId(rows[fc.n].file, rows[fc.n].old, rows[fc.n].new) }; fc.list.push(r); fc.owner.set(r.id, r); }
    return fc.list;
  };
  // Whether this machine proposed the finding. A finding filed before machines were recorded names only the address, so the address stands in for the machine.
  const proposedBy = (r, who) => (r.node ? !!who.node && r.node === who.node : !!r.miner && !!who.miner && String(r.miner).toLowerCase() === String(who.miner).toLowerCase());
  // the votes on a finding, the proposer's own never among them (from what was last read: the callers read the inbox and the votes once, then look at many findings)
  const votesOf = (id) => { const f = fc.owner.get(id); return votes.peek(id).filter((v) => !(f && proposedBy(f, { node: v.node, miner: v.miner }))); };
  const fresh = () => { const list = findings(); votes.sync(); return list; };
  // a finding's votes are weighed by each machine's record on the finding's own lens (swarmbook.mjs weights)
  const lensView = (W, lens) => ({ get: (node) => W.get(node, lens) });
  const decision = (id) => { fresh(); return decide(votesOf(id), lensView(book.weights(), fc.owner.get(id)?.lens), { panel, quorum }); };

  // A finding that still needs votes, for this machine: not decided, not full, not proposed by it, not already voted on by it. Findings in code that just changed
  // first, those a model like this one has not voted on before those it has, then the ones already part-way to a decision, then the oldest.
  function realJob(who) {
    const list = fresh(), W = book.weights(); const open = [];
    for (const r of list) {
      if (r.status !== 'syntax-ok' || r.review !== 'new') continue;
      if (proposedBy(r, who)) continue;
      // a machine whose vote on this lens would count for nothing is not asked: the finding waits for one that judges this kind of mistake well
      const mine = W.get(who.node, r.lens); if (mine === 0) continue;
      const vs = votesOf(r.id);
      if (vs.some((v) => v.node === who.node)) continue;
      if (decide(vs, lensView(W, r.lens), { panel, quorum }).state !== 'pending') continue;
      open.push({ r, vs, w: mine ?? 1, seen: who.model ? vs.some((v) => v.model === who.model) : false });
    }
    if (!open.length) return null;
    // the lenses this machine judges best first, then those a model like it has not voted on, code that just changed, the ones part-way to a decision, the oldest
    open.sort((a, b) => (b.w - a.w) || (a.seen - b.seen) || ((b.r.fresh ? 1 : 0) - (a.r.fresh ? 1 : 0)) || (b.vs.length - a.vs.length) || (a.r.t - b.r.t));
    for (const { r } of open) {
      let src; try { src = source(r.commit, r.file); } catch { continue; }
      const [ws] = String(r.window || '').split('-').map(Number), view = blindView(src, { ...r, line: Number.isInteger(r.line) ? r.line : ws }, context); if (!view) continue;
      const flip = rand() < 0.5, messages = skepticMessages({ ...r, line: view.line, old: view.old, new: view.new }, view.codeText, flip); if (!fits(messages)) continue;
      return { id: randomBytes(8).toString('hex'), kind: 'check', max_tokens: 300, temperature: 0, meta: { check: true, fid: r.id, codeText: view.codeText, shown: `${view.codeText}\n${view.old}\n${view.new}`, side: proposedSide(flip) }, messages };
    }
    return null;
  }
  // a planted bug: from the pool, or made here -> { s (where), src (the original file), p (the plant, with the changed file) } or null
  function planted() {
    if (pool) {
      const e = pool.take(); if (!e) return null; let src; try { src = source(e.commit, e.file); } catch { return null; }
      const lines = src.split('\n'); if (lines[e.line - 1] !== e.orig) return null; lines[e.line - 1] = e.mut;
      return { s: e, src, p: { ...e, src: lines.join('\n') } };
    }
    const s = sample(); if (!s) return null; let src; try { src = source(s.commit, s.file); } catch { return null; }
    const p = plant(src, { start: s.start, end: s.end, lens: s.lens, strict: true, rand }); return p ? { s, src, p } : null;
  }
  function examJob() {
    for (let t = 0; t < 6; t++) {
      const got = planted(); if (!got) { if (pool) return null; continue; }
      const { s, src, p } = got, truth = rand() < 0.5, ex = examClaim({ ...p, file: s.file }, truth, src);
      const view = blindView(ex.code, ex.claim, context); if (!view) continue;
      const flip = rand() < 0.5, messages = skepticMessages({ ...ex.claim, line: view.line, old: view.old, new: view.new }, view.codeText, flip); if (!fits(messages)) continue;
      return { id: randomBytes(8).toString('hex'), kind: 'check', max_tokens: 300, temperature: 0, meta: { check: true, exam: { truth, lens: s.lens, kind: p.kind }, codeText: view.codeText, shown: `${view.codeText}\n${view.old}\n${view.new}`, side: proposedSide(flip) }, messages };
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
    const v = voteOf(text, job.meta.shown, job.meta.side); if (!v) return;
    const base = { t: now(), miner, node: who.node, tier: who.tier, model: who.model };
    if (job.meta.exam) {
      const ex = job.meta.exam, outcome = v.vote === 'unsure' ? 'unsure' : (v.vote === 'real') === ex.truth ? 'right' : 'wrong';
      book.add({ ...base, role: 'skeptic', lens: ex.lens, kind: ex.kind, truth: ex.truth, outcome, choice: v.choice, side: job.meta.side, grounded: v.ok }); return;
    }
    votes.add({ ...base, id: job.meta.fid, choice: v.choice, side: job.meta.side, vote: v.vote, grounded: v.ok });
  }
  // a reply that was not a verdict: kept beside the exam results as invalid (not graded), with the start of what came back
  function onInvalid(job, text, miner, who = {}) {
    book.add({ t: now(), role: 'skeptic', lens: job.meta.exam?.lens, exam: !!job.meta.exam, miner, node: who.node, tier: who.tier, model: who.model, outcome: 'invalid', sample: sampleOf(text) });
    say(`invalid skeptic reply (${who.tier || '?'}, ${who.model || '?'}): ${JSON.stringify(sampleOf(text, 600))}`);
  }
  // how the findings stand, for /stats: counts by state, the exam results by role, lens and size of machine, and each address's recent record. Worked out again only
  // when a finding, a vote or an exam answer has come in since.
  let sc = { key: null, out: null };
  function summary() {
    const list = fresh(), key = `${fc.list.length}:${votes.version()}:${book.version()}`;
    if (sc.key === key && sc.rows === fc.rows) return sc.out;
    const W = book.weights(), states = { confirmed: 0, refuted: 0, unclear: 0, pending: 0 };
    for (const r of list) if (r.status === 'syntax-ok') states[decide(votesOf(r.id), lensView(W, r.lens), { panel, quorum }).state]++;
    sc = { key, rows: fc.rows, out: { findings: states, exam: book.summary(), reviewers: book.standings() } }; return sc.out;
  }
  return { next, onResult, onInvalid, decision, summary };
}
