// Thin client for the control-plane worker routes the box loops already use.
// Mirrors ops/scripts/reflection-relay-loop.sh + confidential-settle-loop.sh:
// Bearer-token auth, tolerant of empty bodies, ack is best-effort (the worker
// re-serves on a lost ack; the on-chain digest-chain / nullifier makes it idempotent).

import { CFG } from './config.js';

const auth = { authorization: `Bearer ${CFG.boxToken}` };

async function getJson(path) {
  const res = await fetch(`${CFG.workerBase}${path}`, { headers: auth });
  if (!res.ok) return {};
  try { return await res.json(); } catch { return {}; }
}
async function postJson(path, body) {
  const res = await fetch(`${CFG.workerBase}${path}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
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
    await postJson('/reflection/ack', { network: CFG.network, attestedTo, txHash: txHash || '', jobId: jobId || '' });
  } catch { /* worker re-serves; on-chain idempotent via digest-chain */ }
}

// ── Confidential settle ──
export async function confidentialJob() {
  // { jobId, type, op, memos:[], mode } | {}
  return getJson('/confidential/job');
}
export async function confidentialAck({ jobId, txHash, error }) {
  const body = error ? { jobId, error } : { jobId, txHash: txHash || '' };
  try { await postJson('/confidential/ack', body); }
  catch { /* worker reclaims the stale claim after its TTL */ }
}

// Prover heartbeat (so /prover-health sees the Render worker as alive, same as the box).
export async function heartbeat(kind, detail) {
  try {
    await postJson('/prover-heartbeat', { kind, detail, ts: new Date().toISOString(), host: 'render-relay' });
  } catch { /* non-fatal */ }
}
