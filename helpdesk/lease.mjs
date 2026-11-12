// Lease side of the community help desk. Nodes (tacit-prover's helpdesk.rs) pull jobs, run them on a small local model and submit the
// text, like the proof pool. Because the gateway knows who answered, it can check nodes: a known-answer canary question is mixed in
// among real ones, answers are vetted before a visitor sees them, and a client that keeps failing is paused. Credit goes to the address;
// strikes and bans key on the CLIENT (a hash of its IP), never the address, because anyone can name any address.
import { randomBytes, createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
export const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export const ipKey = hash;   // the client key: a hash of the IP, what strikes, bans and caps hang on

// What a node says about its machine, cut down to numbers and two words (no names, no free text): memory in GB, GPU memory in GB (0 with none),
// cores, system, chip family, and whether the memory is shared by CPU and GPU (Apple silicon). Anything else, or anything out of range, is dropped.
export function cleanHw(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  const n = (v, max) => { v = Math.round(Number(v)); return Number.isFinite(v) && v >= 0 && v <= max ? v : 0; };
  return { ram: n(h.ram, 4096), vram: n(h.vram, 1024), cores: n(h.cores, 1024), os: ['darwin', 'linux', 'windows'].includes(h.os) ? h.os : '', arch: ['arm64', 'x64'].includes(h.arch) ? h.arch : '', unified: h.unified === true };
}
// The size of model a node can hold WHOLE, from measurements of Qwen3.5-35B-A3B at 4 bits (22 GB, 3B active per token): on a 24 GB GPU it runs from VRAM (150 tokens/s);
// on a 12 GB GPU with the experts in system RAM it needs about 32 GB of RAM (60 tokens/s; a machine sold as 32 GB reports 30.5 to 31.9 GB to the system, so the line is 30); with everything but 4 GB of VRAM in RAM, 45 tokens/s; on the CPU alone 11.
// 'big' holds that model, 'small' holds the 4B (2.7 GB), 'unknown' has not said what it has.
export function tierOf(hw) {
  if (!hw) return 'unknown';
  if (hw.unified) return hw.ram >= 30 ? 'big' : 'small';
  if (hw.vram >= 24) return 'big';
  if (hw.vram >= 6 && hw.ram >= 30) return 'big';
  return 'small';
}

export function makeLeases(opts = {}) {
  const o = { leaseMs: 120000, waitMs: 20000, canaryEvery: 6, canaryMaxAgeMs: 86400000, strikeLimit: 3, strikeWindowMs: 3600000, banMs: 3600000, onlineMs: 60000, maxTries: 2,
    now: () => Date.now(), ledger: null, canary: null, vet: () => null, scan: null, scanPerHour: 12, sweepMs: 5000,
    points: { answer: 1, canary: 1, scan: 1 },      // credited per unit; the policy is the operator's, set by env in server.mjs
    clientMaxPerDay: 100,                           // points one client (IP hash) can earn in a UTC day, however many addresses it names
    persist: null, ...opts };   // persist: a file for bans, strikes and totals, so a restart does not clear them
  const queue = [];                 // real jobs waiting for a node
  const leased = new Map();         // id -> { job, token, addr, ck, expires }
  const clients = new Map();        // client key -> { seen, leases, strikes: [t], bannedUntil, scans: [t] }
  const miners = new Map();         // address -> { answered, canaryPass, canaryFail, errors, points, last }
  const waiters = [];               // long-poll lease requests waiting for work
  const dayNo = () => Math.floor(o.now() / 86400000);
  if (o.persist && existsSync(o.persist)) { try { const st = JSON.parse(readFileSync(o.persist, 'utf8')); for (const [k, v] of st.clients || []) clients.set(k, v); for (const [k, v] of st.miners || []) miners.set(k, v); } catch { /* a damaged state file is started over, the ledger is the record */ } }
  const save = () => { if (!o.persist) return; try { writeFileSync(o.persist + '.tmp', JSON.stringify({ clients: [...clients], miners: [...miners] })); renameSync(o.persist + '.tmp', o.persist); } catch {} };
  const client = (ck) => { if (!clients.has(ck)) clients.set(ck, { seen: 0, leases: 0, sinceCanary: 0, lastCanary: o.now(), strikes: [], bannedUntil: 0, scans: [], day: 0, dayPoints: 0, hw: null, ewmaMs: 0, timed: 0 }); return clients.get(ck); };
  const miner = (a) => { a = a.toLowerCase(); if (!miners.has(a)) miners.set(a, { answered: 0, canaryPass: 0, canaryFail: 0, errors: 0, points: 0, last: 0 }); return miners.get(a); };
  const log = (rec) => { if (o.ledger) try { appendFileSync(o.ledger, JSON.stringify({ t: o.now(), ...rec }) + '\n'); } catch {} };

  // Points for one unit of work: the configured amount, unless this client has reached its day's cap or is the very client that asked the
  // question (answering your own questions is not work). Returns what was actually credited.
  const credit = (ck, addr, kind, job) => {
    const c = client(ck), d = dayNo(); if (c.day !== d) { c.day = d; c.dayPoints = 0; }
    let pts = o.points[kind] ?? 1; if (job && job.askerCk && job.askerCk === ck) pts = 0; pts = Math.max(0, Math.min(pts, o.clientMaxPerDay - c.dayPoints));
    c.dayPoints += pts; const m = miner(addr); m.points += pts; return pts;
  };
  const strike = (ck, why) => { const c = client(ck), t = o.now(); c.strikes = c.strikes.filter((x) => t - x < o.strikeWindowMs); c.strikes.push(t); if (c.strikes.length >= o.strikeLimit) { c.bannedUntil = t + o.banMs; log({ ev: 'ban', client: ck, why }); } };
  const give = (id, job, who) => { if (!job.canary) client(who.ck).sinceCanary++; const token = randomBytes(16).toString('hex'); leased.set(id, { job, token, addr: who.addr.toLowerCase(), ck: who.ck, expires: o.now() + o.leaseMs, at: o.now() }); job.tries = (job.tries || 0) + 1;
    return { id, lease: token, kind: job.kind, messages: job.messages, max_tokens: job.max_tokens, temperature: job.temperature }; };

  function enqueue(kind, messages, { max_tokens = 300, temperature = 0.2, timeoutMs = 12000, ctxText = '', askerIp = null } = {}) {
    return new Promise((resolve, reject) => {
      const job = { id: randomBytes(8).toString('hex'), kind, messages, max_tokens, temperature, ctxText, resolve, reject, tries: 0, canary: false, askerCk: askerIp ? hash(askerIp) : null };
      job.timer = setTimeout(() => { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); leased.delete(job.id); reject(new Error('no node answered in time')); }, timeoutMs);
      queue.push(job); wake();
    });
  }
  function wake() { while (waiters.length && queue.length) { const w = waiters.shift(); clearTimeout(w.timer); const job = pickReal(w.kinds); if (!job) { waiters.unshift(w); w.timer = setTimeout(() => finish(w, null), 1000); break; } finish(w, give(job.id, job, w.who)); } }
  const pickReal = (kinds) => { const i = queue.findIndex((j) => kinds.includes(j.kind)); return i < 0 ? null : queue.splice(i, 1)[0]; };
  const finish = (w, v) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(v); };

  // A node asks for work. -> a job, null (nothing right now: the request was held open), or { banned: true }.
  // `closed` (an AbortSignal) is the node's connection: a node that goes away while it waits (a laptop that sleeps) is taken out of the line at once, so it is
  // never handed a question it cannot answer.
  async function lease({ miner: addr, ip, kinds = ['answer'], closed, hw }) {
    if (!isAddr(addr)) return { error: 'miner must be an address' };
    if (closed?.aborted) return null;   // the node is already gone: it takes nothing
    const ck = hash(ip), c = client(ck), t = o.now(); c.seen = t; miner(addr).last = t;
    if (hw !== undefined) c.hw = cleanHw(hw);   // a node that says nothing keeps what it said before
    if (c.bannedUntil > t) return { banned: true };
    kinds = kinds.filter((k) => k === 'answer' || k === 'scan'); if (!kinds.length) return null;
    const who = { addr, ck }; c.leases++;
    // A canary rides along with real work: one after every canaryEvery jobs this client has taken, or after a day without one (so a node
    // that is only ever idle is still checked now and then). Idle polls do not count, so an idle node is never woken just to be tested.
    const due = c.sinceCanary >= o.canaryEvery || t - c.lastCanary > o.canaryMaxAgeMs;
    if (o.canary && kinds.includes('answer') && due) {
      const cj = await o.canary(); c.sinceCanary = 0; c.lastCanary = t;
      if (cj) { const job = { id: randomBytes(8).toString('hex'), kind: 'answer', messages: cj.messages, max_tokens: 300, temperature: 0.2, canary: true, check: cj.check, ctxText: cj.ctxText || '' }; return give(job.id, job, who); }
    }
    const real = pickReal(kinds); if (real) return give(real.id, real, who);
    if (o.scan && kinds.includes('scan')) {
      c.scans = c.scans.filter((x) => t - x < 3600000);
      if (c.scans.length < o.scanPerHour) { const sj = await o.scan.next(); if (sj) { c.scans.push(t); return give(sj.id, { ...sj, scan: true }, who); } }
    }
    return new Promise((resolve) => { const w = { resolve, who, kinds }; w.timer = setTimeout(() => finish(w, null), o.waitMs); waiters.push(w); closed?.addEventListener('abort', () => finish(w, null), { once: true }); });
  }

  // How long this client takes from being handed a question to handing in the answer, smoothed (the gateway's own clock, not what a node says of itself):
  // what routing a question to the quickest node, or keeping a slow one off visitors' questions, will use.
  const timed = (ck, L) => { const c = client(ck), d = Math.max(1, o.now() - (L.at || o.now())); c.ewmaMs = (c.timed || 0) > 0 ? Math.round(0.8 * c.ewmaMs + 0.2 * d) : d; c.timed = (c.timed || 0) + 1; };

  // A node hands in its work. -> { ok, points } or { error }.
  async function submit({ id, lease: token, miner: addr, ip, text, error }) {
    const L = leased.get(id); const ck = hash(ip);
    if (!L || L.token !== token || L.ck !== ck || !isAddr(addr) || L.addr !== addr.toLowerCase()) return { error: 'no such lease' };
    leased.delete(id); const job = L.job, m = miner(addr);
    const requeue = () => { if (!job.canary && !job.scan && job.tries < o.maxTries && queue.indexOf(job) < 0) { queue.unshift(job); wake(); } else if (!job.canary && !job.scan) { clearTimeout(job.timer); job.reject?.(new Error('no node could answer')); } };
    if (error || typeof text !== 'string' || !text.trim()) { m.errors++; log({ ev: 'error', miner: addr, why: String(error || 'empty').slice(0, 80) }); requeue(); return { ok: true, points: 0 }; }   // a proof starting is not misbehaviour
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 4000);
    if (job.canary) {
      const pass = (() => { try { return !!job.check(text); } catch { return false; } })();
      const vetted = pass ? o.vet(text, job.ctxText) : null;
      if (!pass || vetted) { m.canaryFail++; strike(ck, 'canary'); log({ ev: 'canary', miner: addr, pass: false, why: pass ? 'vet: ' + vetted : 'known answer missing', sample: text.slice(0, 160) }); return { ok: true, points: 0 }; }
      m.canaryPass++; timed(ck, L); const pts = credit(ck, addr, 'canary', job); log({ ev: 'canary', miner: addr, pass: true, points: pts }); return { ok: true, points: pts };
    }
    if (job.scan) { try { await o.scan.onResult(job, text, addr); } catch {} const pts = credit(ck, addr, 'scan', job); log({ ev: 'scan', miner: addr, job: job.id, points: pts }); return { ok: true, points: pts }; }
    const bad = o.vet(text, job.ctxText);
    if (bad) { m.errors++; strike(ck, bad); log({ ev: 'rejected', miner: addr, why: bad }); requeue(); return { ok: true, points: 0 }; }
    clearTimeout(job.timer); m.answered++; timed(ck, L); const pts = credit(ck, addr, 'answer', job); log({ ev: 'answer', miner: addr, job: job.id, points: pts });
    job.resolve({ text, miner: addr }); return { ok: true, points: pts };
  }

  const sweep = setInterval(() => { const t = o.now(); for (const [id, L] of leased) if (L.expires < t) { leased.delete(id); const job = L.job; miner(L.addr).errors++; if (!job.canary && !job.scan) { if (job.tries < o.maxTries && queue.indexOf(job) < 0) { queue.unshift(job); wake(); } else { clearTimeout(job.timer); job.reject?.(new Error('lease expired')); } } } }, o.sweepMs); sweep.unref?.();

  const saver = setInterval(save, 20000); saver.unref?.();
  const online = () => [...clients.values()].filter((c) => o.now() - c.seen < o.onlineMs && c.bannedUntil <= o.now());
  const nodesOnline = () => online().length;
  // The nodes online by the size of model each can hold whole, and the memory they have in all: what the visitor-facing page and a plan for bigger models start from.
  const capacity = () => { const tiers = { big: 0, small: 0, unknown: 0 }; let ramGb = 0, vramGb = 0; for (const c of online()) { tiers[tierOf(c.hw)]++; if (c.hw) { ramGb += c.hw.ram; vramGb += c.hw.vram; } } return { tiers, ramGb, vramGb }; };
  const stats = () => ({ online: nodesOnline(), queued: queue.length, leased: leased.size, waiting: waiters.length,
    miners: [...miners.entries()].map(([a, m]) => ({ miner: a.slice(0, 8) + '…' + a.slice(-4), ...m })), banned: [...clients.values()].filter((c) => c.bannedUntil > o.now()).length,
    capacity: capacity(), nodes: online().map((c) => ({ tier: tierOf(c.hw), ...(c.hw || {}), ewmaMs: c.ewmaMs || null, timed: c.timed || 0, seenSecs: Math.round((o.now() - c.seen) / 1000) })) });
  return { enqueue, lease, submit, nodesOnline, capacity, stats, _queue: queue, _clients: clients, close: () => { clearInterval(sweep); clearInterval(saver); save(); } };
}

// What a visitor may be shown. A node can return anything, so an answer is checked against the documentation it was given:
// an address or a link that is not in those docs is how a bad node would try to send someone's funds or visit to a look-alike.
export function makeVet(corpusText) {
  const hay = corpusText.toLowerCase();
  return (text, ctxText = '') => {
    const t = text.toLowerCase(), known = hay + '\n' + ctxText.toLowerCase();
    for (const a of t.match(/0x[0-9a-f]{40}/g) || []) if (!known.includes(a)) return 'address not in the docs';
    for (const u of t.match(/https?:\/\/[^\s)>\]"']+/g) || []) { const host = u.replace(/^https?:\/\//, '').split(/[/?#:]/)[0]; if (host !== 'tacit.finance' && !host.endsWith('.tacit.finance') && !known.includes(host)) return 'link not in the docs'; }
    for (const m of t.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|xyz|app|finance|fi|co|dev|eth|wei|link|site|online|info|me|cc|ai)\b/g) || []) if (m !== 'tacit.finance' && !m.endsWith('.tacit.finance') && !known.includes(m)) return 'domain not in the docs';
    if (/(send|enter|paste|share|give)[^.\n]{0,40}(seed phrase|private key|recovery phrase|mnemonic)/i.test(text) && !/(never|don'?t|do not|not)[^.\n]{0,40}(send|enter|paste|share|give)/i.test(text)) return 'asks for secrets';
    return null;
  };
}

// The points service's contract (the proof pool's GET /prover/pool/credits): for a UTC day number, { day, over, miners: [{ miner, proofs, points }] }.
// Built from the append-only ledger. `over` is true only once the day has ended, and an address is capped at maxPerDay whatever it earned.
export function creditsFor(ledgerFile, day, { maxPerDay = 100, now = Date.now() } = {}) {
  const today = Math.floor(now / 86400000), by = new Map();
  if (existsSync(ledgerFile)) for (const l of readFileSync(ledgerFile, 'utf8').split('\n')) {
    if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; }
    if (!(e.points > 0) || !isAddr(e.miner) || Math.floor(e.t / 86400000) !== day) continue;
    const a = e.miner.toLowerCase(), r = by.get(a) || { miner: a, proofs: 0, points: 0 }; r.points += e.points; if (e.ev === 'answer') r.proofs++; by.set(a, r);
  }
  const miners = [...by.values()].map((r) => ({ ...r, points: Math.min(r.points, maxPerDay) })).filter((r) => r.points > 0).sort((x, y) => (x.miner < y.miner ? -1 : 1));
  return { day, over: day < today, miners };
}
