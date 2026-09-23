// Thin client for the control-plane worker's prover routes:
// Bearer-token auth, tolerant of empty bodies, ack is best-effort (the worker
// re-serves on a lost ack; the on-chain digest-chain / nullifier makes it idempotent).

import { CFG } from './config.js';

// Built per call, not once at module load: CFG.boxToken is required-on-read, and evaluating it at module
// scope would make every importer of this file demand the control-plane token whether or not it calls one
// of these routes.
const auth = () => ({ authorization: `Bearer ${CFG.boxToken}` });

async function getJson(path) {
  const res = await fetch(`${CFG.workerBase}${path}`, { headers: auth() });
  if (!res.ok) return {};
  try { return await res.json(); } catch { return {}; }
}
async function postJson(path, body) {
  const res = await fetch(`${CFG.workerBase}${path}`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

// ── Reflection ──
export async function reflectionJob() {
  // { input, jobId(newDigest), attestedTo, pending } | {}
  return getJson(`/reflection/job?network=${encodeURIComponent(CFG.network)}`);
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

// ── Confidential settle ──
export async function confidentialJob() {
  // { jobId, type, op, memos:[], mode } | {}
  return getJson('/confidential/job');
}
// Claim several jobs that can share one settle. Falls back to a single job when the worker is older (no
// `jobs` key) so the relay never wedges on a version skew.
export async function confidentialBatch(max = 8) {
  const r = await getJson(`/confidential/job?batch=${max}`);
  if (r && Array.isArray(r.jobs)) return r.jobs;
  return r && r.jobId ? [r] : [];
}
export async function confidentialAck({ jobId, txHash, error }) {
  const body = error ? { jobId, error } : { jobId, txHash: txHash || '' };
  try { await postJson('/confidential/ack', body); }
  catch { /* worker reclaims the stale claim after its TTL */ }
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
export async function heartbeat(kind, detail) {
  try {
    const res = await postJson('/prover-heartbeat', {
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
