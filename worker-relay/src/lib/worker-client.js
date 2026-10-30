// Thin client for the control-plane worker's prover routes:
// Bearer-token auth, tolerant of empty bodies, ack is best-effort (the worker
// re-serves on a lost ack; the on-chain digest-chain / nullifier makes it idempotent).

import { CFG } from './config.js';

// Built per call, not once at module load: CFG.boxToken is required-on-read, and evaluating it at module
// scope would make every importer of this file demand the control-plane token whether or not it calls one
// of these routes.
const auth = () => ({ authorization: `Bearer ${CFG.boxToken}` });

// `{}` when the API refuses; with `status`, `{ unavailable: <HTTP status> }`, for a caller that must tell a refusal from "nothing to do".
async function getJson(path, { status = false } = {}) {
  const res = await fetch(`${CFG.workerBase}${path}`, { headers: auth() });
  if (!res.ok) return status ? { unavailable: res.status } : {};
  try { return await res.json(); } catch { return {}; }
}
// `timeoutMs` bounds a call that something else is waiting behind. Left out, a call waits as long as the platform lets it
// (minutes), which is right for the routes whose answer is the work and wrong for one the next step does not depend on.
async function postJson(path, body, { timeoutMs = 0 } = {}) {
  const ctl = timeoutMs > 0 ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(`${CFG.workerBase}${path}`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
  } finally { if (timer) clearTimeout(timer); }
}

// ── Reflection ──
export async function reflectionJob({ maxBlocks = 0 } = {}) {
  // { input, jobId(newDigest), attestedTo, blocks, pending } | {} when caught up | { unavailable } when the API could not assemble one
  // maxBlocks (> 0) asks for a batch of at most that many blocks, under the API's own cap (lib/block-cap.js).
  const ask = maxBlocks > 0 ? `&maxBlocks=${Math.floor(maxBlocks)}` : '';
  return getJson(`/reflection/job?network=${encodeURIComponent(CFG.network)}${ask}`, { status: true });
}
// The height the API's attested cursor stands at (its persisted record, no assembly); null when it cannot be read, in which case a caller
// carries on as it did before it read this.
export async function reflectionAttestedHeight() {
  try {
    const h = Number((await getJson(`/reflection/state?network=${encodeURIComponent(CFG.network)}`))?.attestedHeight);
    return Number.isFinite(h) && h > 0 ? h | 0 : null;
  } catch { return null; }
}
export async function reflectionAck({ attestedTo, txHash, jobId }) {
  try {
    const res = await postJson('/reflection/ack', { network: CFG.network, attestedTo, txHash: txHash || '', jobId: jobId || '' });
    return { ok: res.ok, status: res.status };
  } catch { /* worker re-serves; on-chain idempotent via digest-chain */ return { ok: false, status: 0 }; }
}
// The API's stashed candidate for a digest the pool holds: { found, attestedTo } ({} from an API that predates the route).
export async function reflectionPending(digest) {
  return getJson(`/reflection/pending?network=${encodeURIComponent(CFG.network)}&digest=${encodeURIComponent(digest)}`);
}
// The small records the cron and the monitor cannot keep across fresh containers: { submitted, lastAck, driftStreak }.
export async function reflectionAttestState() {
  return getJson(`/reflection/attest-state?network=${encodeURIComponent(CFG.network)}`);
}
// Record an attest tx as submitted so a later run waits on it instead of proving the same batch again. Best-effort.
export async function reflectionSubmitted({ newDigest, txHash, attestedTo }) {
  try { await postJson('/reflection/attest-state', { network: CFG.network, submitted: { newDigest, txHash, attestedTo } }); }
  catch { /* the tx is on-chain regardless; the digest poll still finds it */ }
}
// Publish a proof this run has paid for, ahead of its own submit, so that another wallet can submit it when this one cannot
// (the proof is over public Bitcoin data and attestBitcoinStateProven takes no permission). Best-effort: the submit
// does not depend on it.
// The submit waits for this call, so it is bounded: a control plane that takes the connection and never answers costs a few
// seconds of the attest, not minutes of it, and the proof (already paid for) goes on to be submitted.
export const PROOF_PUBLISH_TIMEOUT_MS = 10_000;
export async function reflectionProofPublish({ priorDigest, newDigest, attestedTo, publicValues, proof }, { timeoutMs = PROOF_PUBLISH_TIMEOUT_MS } = {}) {
  try {
    const res = await postJson('/reflection/proof', { network: CFG.network, priorDigest, newDigest, attestedTo, publicValues, proof }, { timeoutMs });
    return res.ok;
  } catch { return false; }
}
export async function reflectionDriftSeen(driftSeen) {
  try {
    const res = await postJson('/reflection/attest-state', { network: CFG.network, driftSeen });
    return res.ok ? (await res.json()).driftStreak : null;
  } catch { return null; }
}
// Record whether this run saw the pool's crossOutCount ahead of reflection's folded count, and get back the
// timestamp the current unbroken run of such observations started (0 = no gap). The monitor is a cron with no
// disk of its own, so the "how long has this been true" state lives server-side, exactly like driftSeen.
export async function crossOutGapSeen(gapSeen) {
  try {
    const res = await postJson('/reflection/attest-state', { network: CFG.network, crossOutGapSeen: gapSeen });
    return res.ok ? (await res.json()).crossOutGapSince : null;
  } catch { return null; }
}
// The raw compressed eth-proof bytes behind a specific published eth-state candidate (identified by
// contentHash = keccak256(ethPv), which the caller derives from the job.input.ethPv it already has). Needed
// only for a Mode-B (modeB=1) job — bitcoin_prove's inner recursion verify loads these from disk, and they
// are deliberately not part of the plain /reflection/job or /reflection/eth-state responses (too large to
// carry on every poll). Returns {} (not throwing) on a miss so the caller can produce its own clear error.
export async function reflectionEthProof(contentHash) {
  return getJson(`/reflection/eth-state/proof?network=${encodeURIComponent(CFG.network)}&contentHash=${encodeURIComponent(contentHash)}`);
}

// The same fetch, told apart by outcome: a 404 means the candidate really was replaced and is final, while a 5xx or
// a dropped connection means the API is busy or restarting (it recycles while it builds a large job) and the blob is
// still there, so those are retried for up to `waitSecs`. Returns {} once the wait is over, like a miss.
export async function reflectionEthProofPatient(contentHash, {
  waitSecs = CFG.ethProofWaitSecs, pollMs = 10000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
} = {}) {
  const url = `${CFG.workerBase}/reflection/eth-state/proof?network=${encodeURIComponent(CFG.network)}&contentHash=${encodeURIComponent(contentHash)}`;
  const deadline = now() + waitSecs * 1000;
  for (;;) {
    let res = null;
    try { res = await fetchImpl(url, { headers: auth() }); } catch { res = null; }
    if (res && res.ok) { try { return await res.json(); } catch { /* a truncated body reads as transient */ } }
    else if (res && res.status === 404) return {};
    if (now() >= deadline) return {};
    await sleep(pollMs);
  }
}

// Register a fast-lane-consumed nullifier's real Bitcoin source note, so a later Mode-B fold can resolve
// {cx,cy,srcTxid,srcVout} for it without the eth-state sidecar having to derive it from Ethereum data alone
// (the settle proof only proves membership against the Bitcoin pool root, not the underlying outpoint). Call
// this once a fast-lane spend of a Bitcoin-homed note actually lands on-chain, with the note's own opening
// and origin outpoint — best-effort: a failed registration stalls the eventual Mode-B fold, never the spend
// itself, so callers should log and continue rather than treat this as fatal.
export async function reflectionConsumedSourceRegister({ nu, cx, cy, srcTxid, srcVout }) {
  const res = await postJson('/reflection/consumed-source', { network: CFG.network, nu, cx, cy, srcTxid, srcVout });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, body: json };
}

// ── Eth-state sidecar (Mode-B producer) ──
// { network, confirmed: {...}|null, pending: {contentHash,publishedAt,lastBlock,execBlock,finalizedSlot}|null }
export async function reflectionEthState() {
  return getJson(`/reflection/eth-state?network=${encodeURIComponent(CFG.network)}`);
}
// Publish a fresh candidate. 409 (pending already live and not stale) is a normal, expected outcome —
// it means another producer (or a prior run of this same sidecar) already fueled the next Bitcoin batch,
// not an error — so this returns the parsed body + status rather than throwing, and the caller decides.
export async function reflectionEthStatePublish(body) {
  const res = await postJson('/reflection/eth-state', { ...body, network: CFG.network });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, body: json };
}

// The books this relay last posted, for it to take back after a restart. null = the worker could not be asked (so try again later);
// {} = it has none stored; { ledger } = the books. Unlike getJson, a refusal is not read as "nothing there".
export async function relayBooks() {
  try {
    const res = await fetch(`${CFG.workerBase}/confidential/ledger?network=${encodeURIComponent(CFG.network)}`, { headers: auth(), signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return {};                 // a worker from before this route: nothing to take back
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Confidential settle ──
// `mode` ('prove' | 'settle') asks for jobs of that mode only. `openable` (with mode 'settle') asks only for a relayed job
// that may go on the open board once proved: a plain pool.settle with no exit recipe.
export async function confidentialJob({ mode = null, openable = false } = {}) {
  // { jobId, type, op, memos:[], mode } | {}
  const q = [mode ? `mode=${mode}` : '', openable ? 'openable=1' : ''].filter(Boolean).join('&');
  return getJson(q ? `/confidential/job?${q}` : '/confidential/job');
}
// Wait, while there is nothing to do, for the API's word that a job came in: { woke: true } at once on one, { woke: false } after `secs`;
// { unavailable } from an API without the route, so the caller pauses as it always did.
export async function confidentialWake(secs) {
  const wait = Math.max(1, Math.round(secs));
  const res = await fetch(`${CFG.workerBase}/confidential/wake?wait=${wait}`, { headers: auth(), signal: AbortSignal.timeout((wait + 10) * 1000) });
  if (!res.ok) return { unavailable: res.status };
  try { return await res.json(); } catch { return {}; }
}
// The open board as anyone reads it: [{ jobId, type, status, posted, publicValues, proof, memos, openSince, expiresAt,
// feeUsd, feeAsset }], oldest first. An older API without the board answers nothing.
// The proof market's order board (worker/src/proof-market-queue.js): the open orders, and clearing one the market reports settled.
export async function marketOrders(limit = 20) {
  const r = await getJson(`/market/orders?limit=${limit}`);
  return Array.isArray(r.orders) ? r.orders : [];
}
export const marketClear = (opId) => postJson('/market/done', { opId });
// A finished proof, kept for the order's holder to pick up (a holder who never sent the deposit keeps it as a voucher).
export const marketProofPost = (opId, publicValues, proof) => postJson('/market/proof', { opId, publicValues, proof });
// TacitGasRelay's order board (worker/src/gas-relay-queue.js): the open orders, and clearing one the contract reports used.
export async function gasOrders(limit = 20) {
  const r = await getJson(`/gas/orders?limit=${limit}`);
  return Array.isArray(r.orders) ? r.orders : [];
}
export const gasClear = (x) => postJson('/gas/done', { id: x.id, payer: x.order.payer, nonce: x.order.nonce });
export async function confidentialOpenList(limit = 32) {
  const r = await getJson(`/confidential/open?limit=${limit}`);
  return Array.isArray(r.jobs) ? r.jobs : [];
}
// Take one open job off the board to send it ({} when another sender took it first).
export async function confidentialOpenJob(jobId) {
  return getJson(`/confidential/job?mode=open&id=${encodeURIComponent(jobId)}`);
}
// Claim several jobs that can share one settle. Falls back to a single job when the worker is older (no
// `jobs` key) so the relay never wedges on a version skew.
// The settle queue as the API sees it: { pending, proving, open, oldestPendingSec, oldestProvingSec }, or null.
export async function confidentialQueue() {
  const r = await getJson('/confidential/queue');
  return r && typeof r.pending === 'number' ? r : null;
}
// The prover board (worker/src/prover-board.js): a job posted for a worker to prove, read, and given up.
export async function boardPost(body) {
  const r = await postJson('/prover/jobs', body, { timeoutMs: 20_000 });
  try { return await r.json(); } catch { return { ok: false, error: `HTTP ${r.status}` }; }
}
export async function boardStatus(jobId) {
  const r = await getJson(`/prover/jobs?id=${encodeURIComponent(jobId)}`);
  return r && r.status ? r : null;
}
// The board's public summary: { queued, claimed, proved, failed, workers: [{ name, lastSeenSeconds, … }] }, or null.
// The API's public quote for an asset (GET /confidential/quote): its ticker and the floor a relay fee in it must clear, gas-aware when the
// API can price the asset and static otherwise (cTAC, whose reference price is private). Read at most once a minute per asset.
const _quotes = new Map();
export async function quoteAsset(assetId) {
  const key = String(assetId || '').toLowerCase();
  const had = _quotes.get(key);
  if (had && Date.now() - had.at < 60_000) return had.v;
  let v = null;
  try {
    const res = await fetch(`${CFG.workerBase}/confidential/quote?asset=${encodeURIComponent(key)}`);
    if (res.ok) {
      const j = await res.json();
      if (j && j.relayFeeEligible && (j.gasAwareFloorUnits || j.staticFloorUnits)) v = { ticker: j.ticker, floorUnits: BigInt(j.gasAwareFloorUnits || j.staticFloorUnits), gasAware: !!j.gasAwareFloorUnits };
    }
  } catch { v = null; }
  _quotes.set(key, { at: Date.now(), v });
  return v;
}
export async function boardSummary() {
  try {
    const res = await fetch(`${CFG.workerBase}/prover/board`);
    if (!res.ok) return null;
    const j = await res.json();
    return j && Array.isArray(j.workers) ? j : null;
  } catch { return null; }
}
export async function boardCancel(jobId, reason) {
  try { await postJson('/prover/jobs/cancel', { jobId, reason }, { timeoutMs: 10_000 }); } catch { /* the job expires on its own */ }
}
// `mixed`: ops of different types too (the relay proves those from one program input; lib/prover.js proveMixed).
export async function confidentialBatch(max = 8, { mixed = false } = {}) {
  const r = await getJson(`/confidential/job?batch=${max}${mixed ? '&mixed=1' : ''}`);
  if (r && Array.isArray(r.jobs)) return r.jobs;
  return r && r.jobId ? [r] : [];
}
// A refused ack is not a lost message, it is a job the worker still believes is being proved: it stays
// claimed until the TTL, is re-served, and is then only resolved if the settle can still be found on chain.
// postJson does not throw on an error status and no caller reads the result, so a 401/429/500 read exactly
// like success. Retry the ones worth retrying, and say so loudly when the worker cannot be told at all.
// `settledBy` (a job found settled by a transaction on chain) is carried as such: the worker closes a job of any mode by
// it, where a bare txHash on a prove-mode job reads as a proof that never came. `publicValues`+`proof` hand a proof back
// (a prove-mode job, or with `open` a relayed one put on the board); `requeue` and `release` answer for an open job.
// A bridge mint the pool's burn root has moved past, made current by the API before the relay proves it (POST /confidential/refresh): the op's
// public half only. → { ok, op } | { ok: false, code }
export async function confidentialRefresh(jobId) {
  try {
    const res = await postJson('/confidential/refresh', { jobId }, { timeoutMs: 20_000 });
    const j = await res.json().catch(() => null);
    return j && typeof j === 'object' ? j : { ok: false, code: 'no_answer' };
  } catch { return { ok: false, code: 'no_answer' }; }
}
export async function confidentialAck({ jobId, txHash, error, broadcastHashes, settledBy, publicValues, proof, open, requeue, release, lane }) {
  const body = error
    ? { jobId, error, ...(broadcastHashes?.length ? { broadcastHashes } : {}), ...(requeue ? { requeue: true } : {}) }
    : settledBy ? { jobId, settledBy, txHash: txHash || settledBy }
    : publicValues && proof ? { jobId, publicValues, proof, ...(open ? { open: true } : {}) }
    : release ? { jobId, release: true }
    : { jobId, txHash: txHash || '', ...(lane ? { lane } : {}) };
  let status = 0;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await postJson('/confidential/ack', body);
      if (res.ok) return { ok: true, status: res.status };
      status = res.status;
      // A refusal is a verdict; only a blip or a rate limit is worth asking again.
      if (status >= 400 && status < 500 && status !== 429) break;
    } catch { status = 0; }
    if (i < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  console.error(`CRITICAL: /confidential/ack refused for job=${jobId} (status ${status}) — the worker still holds it as proving and will re-serve it after the claim TTL`);
  return { ok: false, status };
}
// The activateExit outcome for a settled exit that carried its recipe. A lost report only means the user's own
// activate path takes over; the escrow stays activatable by anyone until the recipe deadline.
export async function confidentialActivateAck({ jobId, txHash, error }) {
  const body = error ? { jobId, activateError: error } : { jobId, activateTx: txHash };
  try { await postJson('/confidential/ack', body); }
  catch { /* see above */ }
}

// Prover heartbeat (so /prover-health sees the Render worker as alive).
//
// /prover-heartbeat authenticates on a body `token`, NOT the bearer header, and answers 401 to anything
// else. The worker stores `note`, not `detail`, so the drift/error text the callers pass rides in that field.
// `kind` also rides as its own field — the worker keys heartbeats per kind (settle/reflection/eth-state
// are separate processes on separate schedules; a live one must never mask a dead one).
//
// Best-effort — a failed beat must never take down a prove — but a rejection is logged once per process.
let _hbWarned = false;
// The prover network credit this process last read (PROVE, as text), carried with every heartbeat it sends.
let _credit = null;
export const setProverCredit = (text) => { _credit = text; };
// The books this process keeps (lib/income-ledger.js snapshot), carried with each heartbeat so the API can show them. A function, read at
// each beat; one that throws is left out rather than costing the beat.
let _ledger = null;
export const setHeartbeatLedger = (fn) => { _ledger = fn; };
const ledgerField = () => { try { const l = _ledger && _ledger(); return l ? { ledger: l } : {}; } catch { return {}; } };
export async function heartbeat(kind, detail) {
  try {
    const res = await postJson('/prover-heartbeat', {
      ...(_credit ? { prover_credit: _credit } : {}),
      ...ledgerField(),
      token: CFG.heartbeatToken,
      network: CFG.network,
      kind,
      prover_alive: true,
      note: `${kind}: ${detail || ''}`.slice(0, 200),
    });
    if (!res.ok && !_hbWarned) {
      _hbWarned = true;
      console.warn(`[worker-client] prover heartbeat rejected (${res.status}) — /prover-health will report this service as DOWN`
        + `${res.status === 401 ? '; set PROVER_HEARTBEAT_TOKEN to the worker\'s value' : ''}`);
    }
  } catch (e) {
    if (!_hbWarned) { _hbWarned = true; console.warn('[worker-client] prover heartbeat failed:', String(e && e.message).slice(0, 120)); }
  }
}

// Idle-loop variant: a poll loop with nothing to do should still prove it's alive, but calling
// heartbeat() on every empty poll (as often as every few seconds) would just spam the KV write with no
// benefit. Throttle to at most once per minInterval per kind. Cron-mode services (one short-lived process
// per invocation, no state carries between runs) should call heartbeat() directly instead — the external
// schedule is already the rate limit, and this throttle would just suppress the one beat that run gets.
const _lastIdleBeatAt = new Map();
export async function heartbeatIdle(kind, detail, minIntervalMs = 120_000) {
  const last = _lastIdleBeatAt.get(kind) || 0;
  if (Date.now() - last < minIntervalMs) return;
  _lastIdleBeatAt.set(kind, Date.now());
  await heartbeat(kind, detail);
}
