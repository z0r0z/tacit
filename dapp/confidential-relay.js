
export const EXPIRY_TYPES = ['unwrap', 'sendunwrap', 'swap', 'swap_var', 'swap_route', 'route', 'wrapswap', 'wraplp',
  'lpadd', 'lp_add', 'lpbond', 'lp_bond', 'lpremove', 'lp_remove', 'stealthclaim', 'adaptorlock', 'adaptorclaim'];
export function opExpiry(type, op) {
  if (!EXPIRY_TYPES.includes(String(type))) return 0;
  const v = Number(op && (op.opDeadline ?? op.deadline) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function relayCanProve(st) {
  return !(st && (st.state === 'paused' || st.state === 'down'));
}

export function makeConfidentialRelay({ base, fetchImpl, guard, checkEmittedMemos, saveMismatchedMemos } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('confidential-relay: no fetch available');
  const root = (base || '').replace(/\/$/, '');

  const jobTypes = new Map();
  const jobBy = new Map();
  function announce(st) {
    try {
      if (!st || !st.jobId || typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
      const detail = { jobId: st.jobId, type: st.type || jobTypes.get(st.jobId) || null, status: st.status || 'unknown',
        txHash: st.txHash || null, error: st.error || null, lane: st.lane || null, sealed: !!st.sealed, at: Date.now(), ...(jobBy.get(st.jobId) ? { by: jobBy.get(st.jobId) } : {}) };
      globalThis.dispatchEvent(new CustomEvent('tacit:job', { detail }));
    } catch { }
  }

  async function asJson(res) {
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
      const e = new Error(`relay ${res.status}: ${body.error || text || res.statusText}`);
      e.httpStatus = res.status;
      if (body.code) e.code = body.code;
      if (body.class) e.class = body.class;
      if (body.hint) e.hint = body.hint;
      if (body.retryAfter != null) e.retryAfter = body.retryAfter;
      throw e;
    }
    return body;
  }

  let stateAt = 0, stateLast = null, stateReading = null;
  async function state() {
    if (stateReading) return stateReading;
    if (stateAt && Date.now() - stateAt < 15_000) return stateLast;
    stateReading = (async () => {
      try {
        const res = await f(`${root}/confidential/relay`);
        if (!res.ok) return null;
        const b = JSON.parse(await res.text());
        if (!b || typeof b.state !== 'string') return null;
        return { state: b.state, proving: !!b.proving, settling: !!b.settling, board: !!b.board };
      } catch { return null; }
    })();
    try {
      stateLast = await stateReading;
      stateAt = Date.now();
      return stateLast;
    } finally { stateReading = null; }
  }

  // Tacit's own provers stay off the proof pool's stock wraps for a little while (worker/src/proof-pool.js hold), so a proof about to be
  // asked of them does not wait out a stock wrap begun just before it (a proof cannot be stopped once it starts). A page asks it as soon
  // as an amount is typed that no kept proof covers, seconds before it asks for the proof. At most once in 20 s, never waited on.
  let heldAt = 0;
  function hold() {
    if (Date.now() - heldAt < 20_000) return;
    heldAt = Date.now();
    try { Promise.resolve(f(`${root}/prover/pool/hold`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).catch(() => {}); } catch { }
  }

  // `exit`: a relayed unwrap's ConfidentialRouter ExitRecipe, which the relay activates once the settle has paid its escrow (never sealed).
  // `ahead`: a prove-only job asked for before its press, which the API takes only while the prover board is up (it costs no credit)
  async function submitOp({ type, op, leaves = [], outputs = null, ephRand, memos = null, mode, feeAsset = null, lockMemos = null, depositTx = null, exit = null, ahead = false } = {}, waitOpts) {
    const onJob = waitOpts && waitOpts.onJob;
    const sealedMemos = sealFor({ leaves, outputs, ephRand, memos, lockMemos });
    const bigintSafe = (_, v) => typeof v === 'bigint' ? v.toString() : v;
    const sealing = sealer && !mode && !depositTx && !exit && !(waitOpts && waitOpts.viaRelay);
    const opKey = sealing ? JSON.stringify({ type, op }, bigintSafe) : null;
    if (opKey && sealedJobs.has(opKey)) {
      const jobId = sealedJobs.get(opKey);
      let st = null;
      try { st = await status(jobId); } catch { st = null; }
      if (st && st.status && st.status !== 'failed' && st.status !== 'unknown') {
        if (onJob) { try { onJob(jobId, type); } catch { } }
        return { ok: true, jobId, status: st.status, deduped: true, sealedMemos };
      }
      sealedJobs.delete(opKey);
    }
    const sealedIn = sealing ? await sealer({ type, op, memos: sealedMemos }) : null;
    const res = await f(`${root}/confidential/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sealedIn
        ? { type, mode: 'sealed', sealed: sealedIn, memos: sealedMemos, ...(feeAsset ? { feeAsset } : {}) }
        : { type, op, memos: sealedMemos, ...(mode ? { mode } : {}), ...(feeAsset ? { feeAsset } : {}), ...(depositTx ? { depositTx } : {}), ...(exit ? { exit } : {}), ...(ahead ? { ahead: true } : {}) }, bigintSafe),
    });
    const body = await asJson(res);
    if (body && body.jobId) {
      if (opKey) sealedJobs.set(opKey, body.jobId);
      jobTypes.set(body.jobId, type);
      const by = opExpiry(type, op) * 1000; if (by) jobBy.set(body.jobId, by);
      if (onJob) { try { onJob(body.jobId, type); } catch { } }
      // `proveOnly`: a proof alone, which the holder (or a voucher) sends; `early`: one asked for ahead of any press: a page lists neither as a relayed action
      announce({ ...body, type, status: body.status || 'pending', ...(mode === 'prove' ? { proveOnly: true } : {}), ...(ahead ? { early: true } : {}) });
    }
    return { ...body, sealedMemos };
  }

  function sealFor({ leaves = [], outputs = null, ephRand, memos = null, lockMemos = null } = {}) {
    let sealedMemos;
    if (lockMemos != null) {
      sealedMemos = lockMemos;
    } else if (outputs != null) {
      if (!guard) throw new Error('confidential-relay: `outputs` given but no recovery guard wired (pass `guard` to makeConfidentialRelay)');
      if (memos) {
        sealedMemos = memos;
      } else {
        if (typeof ephRand !== 'function') throw new Error('confidential-relay: an op with `outputs` needs an `ephRand` scalar source for the memo seal');
        sealedMemos = guard.sealMemosForOutputs({ outputs, ephRand });
      }
      guard.assertOutputsRecoverable({ leaves, outputs, memos: sealedMemos });
    } else {
      sealedMemos = memos || [];
      if (guard && sealedMemos.length) {
        throw new Error('confidential-relay: pass `outputs` (recovery descriptors) for any op that creates leaves — raw memos bypass the recovery guard');
      }
    }
    return sealedMemos;
  }

  async function verifyEmittedMemos(st, leaves, memos) {
    if (typeof checkEmittedMemos !== 'function' || !st || !leaves || !leaves.length) return st;
    if (!st.txHash) return { ...st, memoCheck: { ok: null, reason: 'no settle tx hash — emitted memos were never checked' } };
    const memoCheck = await checkEmittedMemos({ txHash: st.txHash, leaves, memos: memos || [] });
    if (memoCheck && memoCheck.ok === null && typeof saveMismatchedMemos === 'function') {
      try { await saveMismatchedMemos({ txHash: st.txHash, leaves, memos, memoCheck }); } catch { }
    }
    if (memoCheck && memoCheck.ok === false) {
      const e = new Error(`settled in ${st.txHash}, but the emitted memos differ from the sealed ones for leaf ${memoCheck.mismatched.map((m) => m.index).join(', ')}: keep this note's opening, the chain cannot recover it`);
      e.settleResult = st; e.memoCheck = memoCheck; e.sealedMemos = memos;
      if (typeof saveMismatchedMemos === 'function') {
        try { await saveMismatchedMemos({ txHash: st.txHash, leaves, memos, memoCheck }); } catch { }
      }
      throw e;
    }
    return { ...st, memoCheck };
  }

  async function status(jobId) {
    if (OWN_ID.test(String(jobId))) return ownJobs.get(jobId) || { jobId, status: 'unknown' };
    const res = await f(`${root}/confidential/status?id=${encodeURIComponent(jobId)}`);
    if (res.status === 404) return { jobId, status: 'unknown' };
    return asJson(res);
  }

  async function pollStatus(jobId, state, { wait, intervalMs, maxErrors = 8 } = {}) {
    for (;;) {
      try { const st = await status(jobId); state.errors = 0; return st; }
      catch (e) {
        state.errors = (state.errors || 0) + 1;
        if (state.errors >= maxErrors) throw new Error(`status polling for job ${jobId} failed ${state.errors} times in a row (${e && e.message || e}); the job may still be running`);
        await wait(intervalMs);
      }
    }
  }

  function openError(st) {
    const e = new Error(`settle held: proved and waiting for a sender (job ${st.jobId}); it can be sent from any account now`);
    e.code = 'open';
    e.open = { jobId: st.jobId, type: st.type || jobTypes.get(st.jobId) || null, publicValues: st.publicValues, proof: st.proof, memos: Array.isArray(st.memos) ? st.memos : null };
    return e;
  }

  async function waitForSettle(jobId, { intervalMs = 2000, timeoutMs = 5 * 60 * 1000, openGraceMs = 20_000, onUpdate, sleep } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null, openAt = 0;
    const pollState = {};
    for (;;) {
      const st = await pollStatus(jobId, pollState, { wait, intervalMs });
      if (st.status !== last) { last = st.status; announce(st); if (onUpdate) onUpdate(st); }
      if (st.status === 'settled') return st;
      if (st.status === 'failed') throw new Error(`settle failed: ${st.error || 'unknown'}`);
      if (st.status === 'unknown') throw new Error('relay lost the job (worker restart / KV miss)');
      if (st.status === 'open' && st.publicValues && st.proof) {
        if (!openAt) openAt = Date.now();
        if (Date.now() - openAt >= openGraceMs) throw openError(st);
      } else openAt = 0;
      if (Date.now() > deadline) {
        const e = new Error('settle timed out (box offline or backlogged)');
        if (st.status === 'open' && st.publicValues && st.proof) { e.code = 'open'; e.open = openError(st).open; }
        throw e;
      }
      await wait(intervalMs);
    }
  }

  async function settle(opSpec, waitOpts) {
    const { sealedMemos, ...sub } = await submitOp(opSpec, waitOpts);
    const { jobId, status: s } = sub;
    let st;
    try { st = s === 'settled' ? { ...sub, jobId, status: 'settled' } : await waitForSettle(jobId, waitOpts); }
    catch (e) {
      if (e && e.open) {
        const m = e.open.memos;
        if (!(Array.isArray(m) && m.length === sealedMemos.length && m.every((x, i) => String(x).toLowerCase() === String(sealedMemos[i]).toLowerCase()))) {
          e.open = null; e.code = undefined;
        } else e.open.memos = sealedMemos;
        if (e.open) e.open.leaves = opSpec.leaves || [];
      }
      throw e;
    }
    // A settled answer without its transaction is read again for any op, not only one that makes notes: a bridge burn makes none, and its record is
    // found and its claim checked from that transaction.
    if (!st.txHash && st.status === 'settled') {
      try { const rs = await status(jobId); if (rs && rs.txHash) st = { ...st, txHash: rs.txHash }; } catch { }
    }
    return verifyEmittedMemos(st, opSpec.leaves, sealedMemos);
  }

  async function waitForProof(jobId, { intervalMs = 1500, timeoutMs = 15 * 60 * 1000, onUpdate, sleep } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    const pollState = {};
    for (;;) {
      const st = await pollStatus(jobId, pollState, { wait, intervalMs });
      if (st.status !== last) { last = st.status; announce(st); if (onUpdate) onUpdate(st); }
      if (st.status === 'proven') return st;
      if (st.status === 'settled') return st;
      if (st.status === 'failed') throw new Error(`prove failed: ${st.error || 'unknown'}`);
      if (st.status === 'unknown') throw new Error('relay lost the job (worker restart / KV miss)');
      if (Date.now() > deadline) throw new Error('prove timed out (box offline or backlogged)');
      await wait(intervalMs);
    }
  }

  async function prove(opSpec, waitOpts = {}) {
    // A prover that declines this op type (a device prover takes only ops whose proofs pin no moving state) leaves it to the relay.
    // `waitOpts.prover`: this call's own prover, for one proof made with it though none is set (a fallback), not the one set for every call
    const own = waitOpts && waitOpts.viaRelay ? null : (waitOpts && waitOpts.prover) || ownProver;
    if (own && (typeof own.supports !== 'function' || own.supports(opSpec.type))) return proveOwn(own, opSpec, waitOpts);
    const r = await submitOp({ ...opSpec, mode: 'prove' }, waitOpts);
    const st = r.status === 'proven' || r.status === 'settled' ? { jobId: r.jobId, ...(await status(r.jobId)) } : await waitForProof(r.jobId, waitOpts);
    return st.status === 'proven' ? { ...st, memos: provenMemos(st, opSpec, r.sealedMemos) } : st;
  }

  function provenMemos(st, { leaves = [], outputs = null } = {}, sealed = []) {
    const m = Array.isArray(st.memos) ? st.memos : null;
    if (!m || (m.length === sealed.length && m.every((x, i) => String(x).toLowerCase() === String(sealed[i]).toLowerCase()))) return sealed;
    if (!guard || outputs == null) throw new Error('confidential-relay: the proof carries memos other than the ones sealed here, and there is nothing to check them against');
    guard.assertOutputsRecoverable({ leaves, outputs, memos: m });
    return m;
  }

  async function landed(jobId, txHash) {
    if (OWN_ID.test(String(jobId))) {
      const j = ownJobs.get(jobId);
      if (j) { ownJobs.set(jobId, { ...j, status: 'settled', txHash }); announce({ ...j, status: 'settled', txHash }); }
      return { ok: true, status: 'settled', txHash };
    }
    try {
      const res = await f(`${root}/confidential/landed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, txHash }) });
      const body = await asJson(res);
      if (body && body.status) announce({ jobId, status: body.status, txHash: body.txHash || txHash });
      return body;
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  async function openJobs({ limit } = {}) {
    const res = await f(`${root}/confidential/open${limit ? `?limit=${Number(limit)}` : ''}`);
    return asJson(res);
  }

  // `exit`: an unwrap's ConfidentialRouter ExitRecipe, which the relay that sends the proof activates once the settle has paid its escrow.
  async function postProof({ type, publicValues, proof, memos = [], exit = null }) {
    const res = await f(`${root}/confidential/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, mode: 'preproven', publicValues, proof, memos, ...(exit ? { exit } : {}) }),
    });
    const body = await asJson(res);
    if (body && body.jobId) { jobTypes.set(body.jobId, type); announce({ ...body, type }); }
    return body;
  }

  let ownProver = null;
  let sealer = null;
  const sealedJobs = new Map();
  function useSealer(fn) { sealer = typeof fn === 'function' ? fn : null; }
  const OWN_ID = /^spn:/;
  const ownJobs = new Map();
  function useProver(fn) { ownProver = typeof fn === 'function' ? fn : null; }
  async function proveOwn(own, { type, op, ...spec }, waitOpts = {}) {
    const sealedMemos = sealFor(spec);
    let jobId = null;
    const onUpdate = (u = {}) => {
      if (!jobId && u.requestId) {
        jobId = 'spn:' + u.requestId;
        jobTypes.set(jobId, type);
        if (waitOpts.onJob) { try { waitOpts.onJob(jobId, type); } catch { } }
      }
      if (!jobId) {
        if (waitOpts.onUpdate) { try { waitOpts.onUpdate({ jobId: null, type, status: u.status || 'proving', stage: u.stage || null, ...(u.public ? { inputPublic: true } : {}) }); } catch { } }
        return;
      }
      // a prover on this machine says its stage (core, shrink, wrap, groth16) and how long it has run, besides its estimate of the rest
      const st = { jobId, type, status: u.status || 'proving', stage: u.stage || null, error: u.error || null, ...(u.public ? { inputPublic: true } : {}), ...(u.eta != null ? { eta: u.eta } : {}),
        ...(u.phase ? { phase: u.phase } : {}), ...(u.secs != null ? { secs: u.secs } : {}) };
      ownJobs.set(jobId, st);
      announce(st);
      if (waitOpts.onUpdate) { try { waitOpts.onUpdate(st); } catch { } }
    };
    try {
      const r = await own({ type, op, memos: sealedMemos, onUpdate });
      if (!jobId) onUpdate({ requestId: r.requestId });
      const st = { jobId, type, status: 'proven', publicValues: r.publicValues, proof: r.proof, memos: sealedMemos, own: true, ...(r.private === false ? { inputPublic: true } : {}) };
      ownJobs.set(jobId, st);
      announce(st);
      return st;
    } catch (e) {
      if (jobId) { const st = { jobId, type, status: 'failed', error: String(e && e.message || e) }; ownJobs.set(jobId, st); announce(st); }
      throw e;
    }
  }

  return { submitOp, hold, sealFor, status, state, waitForSettle, settle, waitForProof, prove, provenMemos, verifyEmittedMemos, landed, openJobs, postProof, useProver, ownProving: () => !!ownProver, useSealer, sealing: () => !!sealer };
}
