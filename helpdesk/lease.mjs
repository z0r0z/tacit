// Lease side of the community help desk. Nodes (tacit-prover's helpdesk.rs) pull jobs, run them on a small local model and submit the
// text, like the proof pool. Because the gateway knows who answered, it can check nodes: a known-answer canary question is mixed in
// among real ones, answers are vetted before a visitor sees them, and a client that keeps failing is paused. Credit goes to the address;
// strikes and bans key on the CLIENT (a hash of its IP), never the address, because anyone can name any address.
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { shape as verdictShape } from './codecheck/roles.mjs';
import { looseFindings } from './codecheck/scan.mjs';
export const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export const ipKey = hash;   // the client key: a hash of the IP, what strikes, bans and caps hang on
// the model a node says it runs: a short name made of letters, digits and . _ : - only (it is shown, so nothing else is kept)
export const cleanModel = (m) => (typeof m === 'string' && /^[A-Za-z0-9._:-]{1,40}$/.test(m) ? m : null);

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
    now: () => Date.now(), ledger: null, canary: null, vet: () => null, scan: null, check: null, checkShare: 1, rand: Math.random, payable: null, scanPerHour: 12, sweepMs: 5000,
    points: { answer: 1, canary: 1, scan: 1, check: 1, agent: 0 },      // credited per unit; the policy is the operator's, set by env in server.mjs
    clientMaxPerDay: 100,                           // points one client (IP hash) can earn in a UTC day, however many addresses it names
    clientIdleMs: 3 * 86400000, statsMiners: 50,    // a client unheard of this long (not banned, no recent strikes) is forgotten; /stats names this many miners, the most points first
    agentModels: [], agentLeaseMs: 600000,   // agentModels: the model-name prefixes a node must run to be handed agent turns (none: agent jobs are off); a turn can run for minutes, so its lease is long
    persist: null, ipSalt: '', ...opts };   // persist: a file for bans, strikes and totals, so a restart does not clear them; ipSalt: keys the client hash (empty: a plain hash)
  const ckOf = (ip) => (o.ipSalt ? createHmac('sha256', String(o.ipSalt)).update(String(ip)).digest('hex').slice(0, 16) : hash(ip));
  const queue = [];                 // real jobs waiting for a node
  const leased = new Map();         // id -> { job, token, addr, ck, expires }
  const clients = new Map();        // client key -> { seen, leases, strikes: [t], bannedUntil, scans: [t] }
  const miners = new Map();         // address -> { answered, canaryPass, canaryFail, errors, points, last }
  const nodes = new Map();          // client key + address -> { ck, seen, hw, ewmaMs, timed }: one per machine, so two behind one IP are two (runtime only: a node says what it has with its next request)
  const waiters = [];               // long-poll lease requests waiting for work
  const dayNo = () => Math.floor(o.now() / 86400000);
  if (o.persist && existsSync(o.persist)) { try { const st = JSON.parse(readFileSync(o.persist, 'utf8')); for (const [k, v] of st.clients || []) clients.set(k, v); for (const [k, v] of st.miners || []) miners.set(k, v); } catch { /* a damaged state file is started over, the ledger is the record */ } }
  const save = () => { if (!o.persist) return; try { writeFileSync(o.persist + '.tmp', JSON.stringify({ clients: [...clients], miners: [...miners] })); renameSync(o.persist + '.tmp', o.persist); } catch {} };
  const client = (ck) => { if (!clients.has(ck)) clients.set(ck, { seen: 0, leases: 0, sinceCanary: 0, lastCanary: o.now(), strikes: [], bannedUntil: 0, scans: [], day: 0, dayPoints: 0, hw: null, ewmaMs: 0, timed: 0 }); return clients.get(ck); };
  const nodeKey = (ck, a) => hash(`${ck}|${String(a).toLowerCase()}`);
  const node = (ck, a) => { const k = nodeKey(ck, a); if (!nodes.has(k)) nodes.set(k, { ck, seen: 0, hw: null, ewmaMs: 0, timed: 0 }); return nodes.get(k); };
  const miner = (a) => { a = a.toLowerCase(); if (!miners.has(a)) miners.set(a, { answered: 0, canaryPass: 0, canaryFail: 0, errors: 0, points: 0, last: 0 }); return miners.get(a); };
  // An agent turn goes only to a node that asked for it, holds a big model whole (tierOf), and says it runs one of the allowed models: the operator names those, nothing else is trusted.
  const agentOk = (nd) => !!(o.agentModels.length && nd && nd.model && tierOf(nd.hw) === 'big' && o.agentModels.some((p) => nd.model.startsWith(p)));
  const log = (rec) => { if (o.ledger) try { appendFileSync(o.ledger, JSON.stringify({ t: o.now(), ...rec }) + '\n'); } catch {} };

  // Points for one unit of work: the configured amount, unless this client has reached its day's cap or is the very client that asked the
  // question (answering your own questions is not work). Returns what was actually credited.
  const credit = (ck, addr, kind, job) => {
    const c = client(ck), d = dayNo(); if (c.day !== d) { c.day = d; c.dayPoints = 0; }
    let pts = o.points[kind] ?? 1; if (job && job.askerCk && job.askerCk === ck) pts = 0; pts = Math.max(0, Math.min(pts, o.clientMaxPerDay - c.dayPoints));
    c.dayPoints += pts; const m = miner(addr); m.points += pts; return pts;
  };
  const strike = (ck, why) => { const c = client(ck), t = o.now(); c.strikes = c.strikes.filter((x) => t - x < o.strikeWindowMs); c.strikes.push(t); if (c.strikes.length >= o.strikeLimit) { c.bannedUntil = t + o.banMs; log({ ev: 'ban', client: ck, why }); } };
  // A canary follows work a client has handed in (an answer taken, a review or a check that was paid), not jobs it was handed: a client that
  // takes jobs and lets them lapse is not working, and must not be able to call up canaries (each pays a point) by asking.
  const delivered = (ck) => { client(ck).sinceCanary++; };
  const give = (id, job, who) => { const token = randomBytes(16).toString('hex'); leased.set(id, { job, token, addr: who.addr.toLowerCase(), ck: who.ck, expires: o.now() + (job.leaseMs || o.leaseMs), at: o.now() }); job.tries = (job.tries || 0) + 1;
    return { id, lease: token, kind: job.scan ? 'scan' : job.kind, messages: job.messages, max_tokens: job.max_tokens, temperature: job.temperature, ...(job.kind === 'agent' ? { tools: job.tools, seed: job.seed } : {}) }; };   // a skeptic's job goes out as a scan: a node cannot tell the roles apart

  function enqueue(kind, messages, { max_tokens = 300, temperature = 0.2, timeoutMs = 12000, ctxText = '', askerIp = null, tools, seed } = {}) {
    return new Promise((resolve, reject) => {
      const job = { id: randomBytes(8).toString('hex'), kind, messages, max_tokens, temperature, ctxText, resolve, reject, tries: 0, canary: false, askerCk: askerIp ? ckOf(askerIp) : null, ...(kind === 'agent' ? { tools, seed, leaseMs: o.agentLeaseMs } : {}) };
      job.timer = setTimeout(() => { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); leased.delete(job.id); reject(new Error('no node answered in time')); }, timeoutMs);
      queue.push(job); wake();
    });
  }
  // each waiter in turn takes a job its kinds fit; one whose kinds fit nothing queued (a scan-only node) is passed over for the next, not made to wait for
  function wake() { for (let i = 0; i < waiters.length && queue.length;) { const w = waiters[i], job = pickReal(w.kinds); if (!job) { i++; continue; } finish(w, give(job.id, job, w.who)); } }
  const pickReal = (kinds) => { const i = queue.findIndex((j) => kinds.includes(j.kind)); return i < 0 ? null : queue.splice(i, 1)[0]; };
  const finish = (w, v) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(v); };

  // A node asks for work. -> a job, null (nothing right now: the request was held open), or { banned: true }.
  // `closed` (an AbortSignal) is the node's connection: a node that goes away while it waits (a laptop that sleeps) is taken out of the line at once, so it is
  // never handed a question it cannot answer.
  async function lease({ miner: addr, ip, kinds = ['answer'], closed, hw, model }) {
    if (!isAddr(addr)) return { error: 'miner must be an address' };
    if (closed?.aborted) return null;   // the node is already gone: it takes nothing
    const ck = ckOf(ip), c = client(ck), t = o.now(); c.seen = t; { const mm = miners.get(addr.toLowerCase()); if (mm) mm.last = t; }       // (an address is filed once it has work to its name, not by asking)
    const nd = node(ck, addr); nd.seen = t;
    if (hw !== undefined) nd.hw = cleanHw(hw);   // a node that says nothing keeps what it said before
    if (model !== undefined) nd.model = cleanModel(model);
    if (c.bannedUntil > t) return { banned: true };
    kinds = kinds.filter((k) => k === 'answer' || k === 'scan' || (k === 'agent' && agentOk(nd))); if (!kinds.length) return null;
    const who = { addr, ck }; c.leases++;
    // A canary rides along with real work: one after every canaryEvery jobs this client has taken, or after a day without one (so a node
    // that is only ever idle is still checked now and then). Idle polls do not count, so an idle node is never woken just to be tested.
    const due = c.sinceCanary >= o.canaryEvery || t - c.lastCanary > o.canaryMaxAgeMs;
    if (o.canary && kinds.includes('answer') && due) {
      const cj = await o.canary(); c.sinceCanary = 0; c.lastCanary = t;
      if (cj) { const job = { id: randomBytes(8).toString('hex'), kind: 'answer', messages: cj.messages, max_tokens: 300, temperature: 0.2, canary: true, check: cj.check, ctxText: cj.ctxText || '' }; return give(job.id, job, who); }
    }
    const real = pickReal(kinds); if (real) return give(real.id, real, who);
    // Review work: a node that takes `scan` is offered, in turn, a finding to check (another machine's, never its own) and then a snippet to review or an exam. The
    // feeds are told which machine is asking, how big it is and which model it runs, so the work can be matched to it and a panel kept varied.
    if ((o.check || o.scan) && kinds.includes('scan')) {
      c.scans = c.scans.filter((x) => t - x < 3600000);
      if (c.scans.length < o.scanPerHour) {
        const ctx = { node: nodeKey(ck, addr), tier: tierOf(nd.hw), model: nd.model || null };
        // checkShare of the asks try checking first and the rest scouting first, so a backlog of findings to check does not stop new ones being found (or the reverse)
        const order = o.check && o.scan && o.rand() >= o.checkShare ? [o.scan, o.check] : [o.check, o.scan];
        for (const feed of order) { if (!feed) continue; const sj = await feed.next({ miner: addr, ...ctx }); if (sj) { c.scans.push(t); return give(sj.id, { ...sj, scan: true, feed, ctx }, who); } }
      }
    }
    return new Promise((resolve) => { const w = { resolve, who, kinds }; w.timer = setTimeout(() => finish(w, null), o.waitMs); waiters.push(w); closed?.addEventListener('abort', () => finish(w, null), { once: true }); });
  }

  // How long this client takes from being handed a question to handing in the answer, smoothed (the gateway's own clock, not what a node says of itself):
  // what routing a question to the quickest node, or keeping a slow one off visitors' questions, will use.
  const timed = (ck, L) => { const nd = node(ck, L.addr), d = Math.max(1, o.now() - (L.at || o.now())); nd.ewmaMs = nd.timed > 0 ? Math.round(0.8 * nd.ewmaMs + 0.2 * d) : d; nd.timed++; };

  // A node hands in its work. -> { ok, points } or { error }.
  async function submit({ id, lease: token, miner: addr, ip, text, error }) {
    const L = leased.get(id); const ck = ckOf(ip);
    if (!L || L.token !== token || L.ck !== ck || !isAddr(addr) || L.addr !== addr.toLowerCase()) return { error: 'no such lease' };
    leased.delete(id); const job = L.job, m = miner(addr);
    const requeue = () => { if (!job.canary && !job.scan && job.tries < o.maxTries && queue.indexOf(job) < 0) { queue.unshift(job); wake(); } else if (!job.canary && !job.scan) { clearTimeout(job.timer); job.reject?.(new Error('no node could answer')); } };
    if (error || typeof text !== 'string' || !text.trim()) { m.errors++; log({ ev: 'error', miner: addr, why: String(error || 'empty').slice(0, 80) }); requeue(); return { ok: true, points: 0 }; }   // a proof starting is not misbehaviour
    if (job.kind === 'agent') {
      // an agent turn is a model's whole reply (words and/or tool calls) as JSON; it is not shown to anyone and not vetted like a visitor's answer, but it must have the shape asked for
      const msg = agentMessage(text);
      if (!msg) { m.errors++; log({ ev: 'agent-invalid', miner: addr, sample: String(text).slice(0, 120) }); requeue(); return { ok: true, points: 0 }; }
      clearTimeout(job.timer); m.answered++; timed(ck, L); const pts = credit(ck, addr, 'agent', job); if (pts > 0) log({ ev: 'agent', miner: addr, job: job.id, points: pts });
      job.resolve({ message: msg, miner: addr, node: { tier: tierOf(node(ck, addr).hw), model: node(ck, addr).model || null } }); return { ok: true, points: pts };
    }
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 4000);
    if (job.canary) {
      const pass = (() => { try { return !!job.check(text); } catch { return false; } })();
      const vetted = pass ? o.vet(text, job.ctxText) : null;
      if (!pass || vetted) { m.canaryFail++; strike(ck, 'canary'); log({ ev: 'canary', miner: addr, pass: false, why: pass ? 'vet: ' + vetted : 'known answer missing', sample: text.slice(0, 160) }); return { ok: true, points: 0 }; }
      m.canaryPass++; timed(ck, L); const pts = credit(ck, addr, 'canary', job); log({ ev: 'canary', miner: addr, pass: true, points: pts }); return { ok: true, points: pts };
    }
    if (job.scan) {
      // a review is the JSON the prompt asks for (a findings list, empty when there is nothing to report; for a skeptic, a verdict); a reply that is not that is not one, and earns nothing
      const checking = job.kind === 'check';
      if (!(checking ? verdictShape(text) : reviewed(text))) {
        m.errors++;
        try { await (job.feed || o.scan).onInvalid?.(job, text, addr, job.ctx); } catch {}   // the feed keeps what came back, to see which prompts a model cannot follow
        return { ok: true, points: 0 };
      }
      try { await (job.feed || o.scan).onResult(job, text, addr, job.ctx); } catch {}
      // Review work earns points only while the machine's exam record shows it does the work (payable); a review that earns nothing is not written to the ledger,
      // which then grows with what is paid, not with every job.
      const kind = checking ? 'check' : 'scan', paid = !o.payable || o.payable(kind, job.ctx || {}) !== false;
      const pts = paid ? credit(ck, addr, kind, job) : 0; if (pts > 0) log({ ev: kind, miner: addr, job: job.id, points: pts });
      if (paid) delivered(ck);
      return { ok: true, points: pts, ...(paid ? {} : { unpaid: true }) };
    }
    const bad = o.vet(text, job.ctxText);
    if (bad) {
      // an answer that repeats what the visitor wrote is not shown, but it is not the node's doing: only what the question does not account for counts against it
      const asked = (job.messages || []).filter((x) => x && x.role === 'user').map((x) => String(x.content || '')).join('\n');
      const echoed = !!bad && !!o.vet.last && asked.toLowerCase().includes(o.vet.last);
      m.errors++; if (!echoed) strike(ck, bad); log({ ev: 'rejected', miner: addr, why: bad, ...(echoed ? { echoed: true } : {}) }); requeue(); return { ok: true, points: 0 };
    }
    clearTimeout(job.timer); m.answered++; timed(ck, L); delivered(ck); const pts = credit(ck, addr, 'answer', job); log({ ev: 'answer', miner: addr, job: job.id, points: pts });
    job.resolve({ text, miner: addr }); return { ok: true, points: pts };
  }

  const sweep = setInterval(() => { const t = o.now(); for (const [id, L] of leased) if (L.expires < t) { leased.delete(id); const job = L.job; miner(L.addr).errors++; if (!job.canary && !job.scan) { if (job.tries < o.maxTries && queue.indexOf(job) < 0) { queue.unshift(job); wake(); } else { clearTimeout(job.timer); job.reject?.(new Error('lease expired')); } } } }, o.sweepMs); sweep.unref?.();

  const prune = () => { const t = o.now(); for (const [k, c] of clients) if (t - c.seen > o.clientIdleMs && c.bannedUntil <= t && !c.strikes.some((x) => t - x < o.strikeWindowMs)) clients.delete(k); };
  const saver = setInterval(() => { prune(); save(); }, 20000); saver.unref?.();
  const online = () => { for (const [k, n] of nodes) if (o.now() - n.seen > 86400000) nodes.delete(k); return [...nodes.values()].filter((n) => o.now() - n.seen < o.onlineMs && (clients.get(n.ck)?.bannedUntil || 0) <= o.now()); };
  const nodesOnline = () => online().length;
  // The nodes online by the size of model each can hold whole, and the memory they have in all: what the visitor-facing page and a plan for bigger models start from.
  const capacity = () => { const tiers = { big: 0, small: 0, unknown: 0 }; let ramGb = 0, vramGb = 0; for (const c of online()) { tiers[tierOf(c.hw)]++; if (c.hw) { ramGb += c.hw.ram; vramGb += c.hw.vram; } } return { tiers, ramGb, vramGb }; };
  const stats = () => ({ online: nodesOnline(), queued: queue.length, leased: leased.size, waiting: waiters.length,
    minerCount: miners.size, miners: [...miners.entries()].sort((x, y) => y[1].points - x[1].points).slice(0, o.statsMiners).map(([a, m]) => ({ miner: a.slice(0, 8) + '…' + a.slice(-4), ...m })), banned: [...clients.values()].filter((c) => c.bannedUntil > o.now()).length,
    capacity: capacity(), agentNodes: online().filter(agentOk).length, nodes: online().map((c) => ({ tier: tierOf(c.hw), ...(c.hw || {}), model: c.model || null, ewmaMs: c.ewmaMs || null, timed: c.timed || 0, seenSecs: Math.round((o.now() - c.seen) / 1000) })) });
  return { enqueue, lease, submit, nodesOnline, capacity, stats, _queue: queue, _clients: clients, _prune: prune, close: () => { clearInterval(sweep); clearInterval(saver); save(); } };
}

// An agent turn's reply, as a node sends it: JSON text of an assistant message, { content, tool_calls }. Returns the cleaned message or null. Tool calls are kept to
// what a chat server returns (a name made of letters and underscores, arguments as a JSON string); nothing in it is run here.
export function agentMessage(text) {
  let m; try { m = JSON.parse(String(text)); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const content = typeof m.content === 'string' ? m.content.slice(0, 20000) : '';
  const calls = [];
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length > 4) return null;
    for (const c of m.tool_calls) {
      const f = c && c.function; if (!f || typeof f.name !== 'string' || !/^[A-Za-z_]{1,40}$/.test(f.name)) return null;
      const args = typeof f.arguments === 'string' ? f.arguments : (f.arguments && typeof f.arguments === 'object' ? JSON.stringify(f.arguments) : '{}');
      if (args.length > 12000) return null;
      calls.push({ id: typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.id) ? c.id : 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name: f.name, arguments: args } });
    }
  }
  if (!content.trim() && !calls.length) return null;
  return { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) };
}

// Whether a scan reply has the shape asked for: an object holding a `findings` list (found as the scan feed finds it, among any prose around it).
const reviewed = (t) => { try { const m = String(t).match(/\{[\s\S]*\}/); if (m && Array.isArray(JSON.parse(m[0]).findings)) return true; } catch { /* not JSON: read the fields one by one */ } return looseFindings(t).length > 0; };

// What a visitor may be shown. A node can return anything, so an answer is checked against the documentation it was given:
// an address or a link that is not in those docs is how a bad node would try to send someone's funds or visit to a look-alike.
// A link is read as a browser reads it (a name before an @ is not the host, a backslash is refused), its host has to be exactly one the docs
// name, and where the docs link a host by full address the path has to lie under one of those; a host the docs only mention by name may carry
// any path. Hosts are compared whole, so "acit.finance" is not "tacit.finance".
const TLDS = 'com|net|org|io|xyz|app|finance|fi|co|dev|eth|wei|link|site|online|info|me|cc|ai|top|click|live|pro|cloud|tech|store|shop|vip|icu|gg|network|exchange|money|wallet|swap|trade|market|zone|world|today|digital|systems|capital|ventures|page|pages|space|fun|art|fund|bio|bid|win|loan|work|tools|run|wtf|lol|bot|ink|pw|tk|ml|ga|cf|gq|ru|cn|biz|us|uk|de|club|one|win|team|support|help|claim|airdrop';
const URL_RE = /https?:\/\/[^\s)>\]"'`]+/g;
const DOMAIN_RE = new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b`, 'g');
const isTacit = (h) => h === 'tacit.finance' || h.endsWith('.tacit.finance');
const trimUrl = (u) => u.replace(/[.,;:!?]+$/, '');
const parsed = (raw) => { try { const u = new URL(trimUrl(raw)); return u; } catch { return null; } };
const norm = (u) => u.origin + u.pathname.replace(/\/+$/, '');
// An ask is a verb followed by a secret within the sentence; each verb is read on its own, and one counts as denied only when a denial governs it
// directly ("never share", "no one will ever ask you to enter"), not when a denial merely appears earlier in the sentence ("don't worry, just paste").
const ASK_VERB = /\b(send|enter|paste|share|give|type|submit|provide|input|reveal|tell|post|upload|dm|email)\b/gi;
const ASK_AT = /(send|enter|paste|share|give|type|submit|provide|input|reveal|tell|post|upload|dm|email)\b[^.\n]{0,60}(seed phrase|private key|recovery phrase|mnemonic|secret key|secret recovery|seed words?|keystore|wallet password|spend key|view key|signing key|backup phrase|secret phrase|(?:12|24|twelve|twenty[- ]four)[- ]words)/iy;
const DENIED = /\b(never|don'?t|do not|not|no one|nobody|should not|must not|won'?t|will not|cannot|can'?t)\b(?:[\s,]+(?:ever|you|to|anyone|anybody|should|will|would|need|needs|have|has|ask|asks|asked|be|required|we|they|us|or|and|the|a|your|any|one|from|tacit|support|under|circumstances|anywhere|it|them)\b){0,8}[\s,]*$/i;
const asksForSecret = (sentence) => {
  for (const m of sentence.matchAll(ASK_VERB)) { ASK_AT.lastIndex = m.index; if (ASK_AT.test(sentence) && !DENIED.test(sentence.slice(0, m.index))) return true; }
  return false;
};
export function makeVet(corpusText) {
  const hay = corpusText.toLowerCase();
  const readKnown = (text) => {
    const hosts = new Set(), urls = [];
    for (const raw of text.match(URL_RE) || []) { const u = parsed(raw); if (u && !u.username && !u.password) { hosts.add(u.hostname.replace(/\.$/, '')); urls.push(norm(u)); } }
    for (const m of text.match(DOMAIN_RE) || []) hosts.add(m);
    return { hosts, urls };
  };
  const base = readKnown(hay);
  const urlKnown = (u, known) => {
    const mine = known.urls.filter((k) => k.startsWith(u.origin));
    if (!mine.length) return true;                          // the docs only name this host: any path
    const n = norm(u);
    return mine.some((k) => n === k || n.startsWith(k + '/') || (k === u.origin && n === u.origin));
  };
  const vet = (text, ctxText = '') => {
    vet.last = null;
    const t = text.toLowerCase(), ctx = ctxText.toLowerCase(), knownText = hay + '\n' + ctx;
    const known = ctx ? (() => { const c = readKnown(ctx); return { hosts: new Set([...base.hosts, ...c.hosts]), urls: [...base.urls, ...c.urls] }; })() : base;
    const refuse = (why, token) => { vet.last = String(token || '').toLowerCase(); return why; };
    for (const a of t.match(/0x[0-9a-f]{40}/g) || []) if (!knownText.includes(a)) return refuse('address not in the docs', a);
    for (const raw of t.match(URL_RE) || []) {
      const u = parsed(raw);
      if (!u || u.username || u.password || raw.includes('\\')) return refuse('link not in the docs', raw);
      const host = u.hostname.replace(/\.$/, '');
      if (isTacit(host)) continue;
      if (!known.hosts.has(host) || !urlKnown(u, known)) return refuse('link not in the docs', host);
    }
    for (const m of t.match(DOMAIN_RE) || []) if (!isTacit(m) && !known.hosts.has(m)) return refuse('domain not in the docs', m);
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) if (asksForSecret(sentence)) return refuse('asks for secrets', '');
    return null;
  };
  vet.last = null;
  return vet;
}

// A day's credits kept, so a page asking again and again does not read the ledger each time: a reading of a day still running lasts `ttlMs`; a reading
// that says the day is over (`over: true`, made after the day ended, so it has everything) is final and kept. A reading made while the day was running is
// never kept past its time, however old the day has since become: the points service refuses a day that is not over and would be held on it.
export function makeCreditCache({ ttlMs = 30000, max = 400, now = Date.now } = {}) {
  const kept = new Map();
  return (day, load) => {
    const t = now(), hit = kept.get(day);
    if (hit && (hit.v.over === true || t - hit.at < ttlMs)) return hit.v;
    const v = load();
    if (kept.size >= max) kept.clear();
    kept.set(day, { at: t, v });
    return v;
  };
}

// The points service's contract (the proof pool's GET /prover/pool/credits): for a UTC day number, { day, over, miners: [{ miner, proofs, points }] }.
// Built from the append-only ledger. `over` is true only once the day has ended, and an address is capped at maxPerDay whatever it earned.
// An address that earned fewer than minPoints in the day is not credited (a single point is dust, and a day of them is a ledger entry each),
// and the day's points together never pass `budget` (0: no budget): over it, each address's points are scaled down to fit, rounded down, so
// review work is a fixed share of the mining pot that more machines divide between them and never enlarge (as the salt pool's day is).
// Both are rules for the days from `fromDay` on: a day before it is credited exactly as it was earned, so a change of rules never takes back points
// that were earned under the old ones.
export function creditsFor(ledgerFile, day, { maxPerDay = 100, minPoints = 0, budget = 0, fromDay = 0, now = Date.now() } = {}) {
  if (!(day >= fromDay)) { minPoints = 0; budget = 0; }
  const today = Math.floor(now / 86400000), by = new Map();
  if (existsSync(ledgerFile)) for (const l of readFileSync(ledgerFile, 'utf8').split('\n')) {
    if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; }
    if (!(e.points > 0) || !isAddr(e.miner) || Math.floor(e.t / 86400000) !== day) continue;
    const a = e.miner.toLowerCase(), r = by.get(a) || { miner: a, proofs: 0, points: 0 }; r.points += e.points; if (e.ev === 'answer') r.proofs++; by.set(a, r);
  }
  let miners = [...by.values()].map((r) => ({ ...r, points: Math.min(r.points, maxPerDay) })).filter((r) => r.points > 0 && r.points >= minPoints);
  const total = miners.reduce((a, r) => a + r.points, 0);
  if (budget > 0 && total > budget) miners = miners.map((r) => ({ ...r, points: Math.floor((r.points * budget) / total) })).filter((r) => r.points > 0);
  miners.sort((x, y) => (x.miner < y.miner ? -1 : 1));
  return { day, over: day < today, miners };
}
