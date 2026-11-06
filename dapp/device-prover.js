// The prover on the holder's own machine (tacit-prover, contracts/sp1/confidential/device-prover/) as a relay.useProver prover, beside
// self-prover.js for the holder's Succinct credit. The page builds the program input byte for byte (sp1-stdin.js), the machine proves
// it on 127.0.0.1, and nothing about the op leaves the device. It takes the ops whose proofs pin no state that moves while it works
// (a wrap, a transfer, an unwrap, a stealth send, a farm bond: the pool takes any root it has had, and a bond's nonce is the key's
// own), so a proof that takes minutes is as good as one that takes seconds.
//
// A browser asks the user before a site first reaches the local network, so a page calls health() only once the holder has chosen
// this prover, never on load.
import { stdinFor, batchStdin, SELF_PROVE_TYPES } from './sp1-stdin.js';

export const DEVICE_PROVER_BASE = 'http://127.0.0.1:47815';
export const DEVICE_TYPES = Object.freeze(['wrap', 'wraptransfer', 'transfer', 'unwrap', 'sendunwrap', 'stealthlock', 'stealthclaim', 'stealthrefund', 'farmbond']
  .filter((t) => SELF_PROVE_TYPES.includes(t)));
// Ops that pin a pool's reserves: a proof made over minutes holds only while nobody trades in that pool. They are taken only once the
// page allows them (allowLive), for an action the holder asked this computer to prove, and one that went stale is built and proved again.
export const DEVICE_LIVE_TYPES = Object.freeze(['swap', 'route', 'lp', 'lpremove', 'lpbond', 'wrapswap', 'wraplp']
  .filter((t) => SELF_PROVE_TYPES.includes(t)));
const POOL_VKEY = '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3';

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = String(h).replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16); return out; };

export function makeDeviceProver({ keccak256, base = DEVICE_PROVER_BASE, fetchImpl = (...a) => globalThis.fetch(...a), pollMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${base}${path}`, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `this computer's prover answered ${res.status}`), { code: 'device_prover' });
    return body;
  };

  // { ok, vkey, busy, queued, gpu } from a prover proving for this pool, or null when none answers.
  async function health({ timeoutMs = 2500 } = {}) {
    try {
      const h = await call('/health', { signal: AbortSignal.timeout(timeoutMs) });
      return h && h.ok && String(h.vkey).toLowerCase() === POOL_VKEY ? h : null;
    } catch { return null; }
  }

  let live = false;
  const supports = (type) => DEVICE_TYPES.includes(type) || (live && DEVICE_LIVE_TYPES.includes(type));
  const allowLive = (on) => { live = !!on; };

  async function prove({ type, op, memos = [], onUpdate = () => {} }) {
    if (!supports(type)) throw Object.assign(new Error(`this computer's prover does not take ${type}: its proof would go stale while it works`), { code: 'device_prover' });
    const memoHashes = memos.map((m) => hex(keccak256(unhex(m))));
    const stdin = stdinFor(type, { ...op, memoHashes });
    const { id } = await call('/prove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, stdin: hex(stdin) }) });
    onUpdate({ requestId: `device-${id}`, status: 'proving', stage: 'queued' });
    return follow(id, onUpdate);
  }
  prove.supports = supports;

  // Several ops in one proof (sp1-stdin.js batchStdin): the machine pays a proof's fixed stages, most of its time, once for all of them. Each
  // item is { type, op, memos }, of the types it takes. On 8 GB a batch must stay inside one shard (about 4.2M cycles: nine whole-note
  // unwraps), or the machine runs out of memory.
  async function proveBatch(items, { onUpdate = () => {} } = {}) {
    for (const it of items) if (!supports(it.type)) throw Object.assign(new Error(`this computer's prover does not take ${it.type}: its proof would go stale while it works`), { code: 'device_prover' });
    const b = batchStdin(items.map((it) => ({ type: it.type, op: { ...it.op, memoHashes: (it.memos || []).map((m) => hex(keccak256(unhex(m)))) } })));
    const { id } = await call('/prove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'batch', stdin: hex(b.stdin) }) });
    onUpdate({ requestId: `device-${id}`, status: 'proving', stage: 'queued' });
    return follow(id, onUpdate);
  }

  // A job followed to its proof. Updates carry the prover's own stage (core, shrink, wrap, groth16) as `phase` and `eta`, the
  // seconds the rest took on this machine last time.
  async function follow(id, onUpdate) {
    const requestId = `device-${id}`;
    for (;;) {
      await sleep(pollMs);
      const j = await call(`/job?id=${encodeURIComponent(id)}`);
      if (j.status === 'done') return { requestId, publicValues: j.publicValues, proof: j.proof, private: true, secs: j.secs };
      if (j.status === 'failed') throw Object.assign(new Error(j.error || 'this computer could not make the proof'), { code: 'device_prover' });
      onUpdate({ requestId, status: 'proving', stage: j.status === 'queued' ? 'queued' : 'device', secs: j.secs, ...(j.stage ? { phase: j.stage } : {}), ...(j.eta != null ? { eta: j.eta } : {}) });
    }
  }

  // A proof asked for before (by its requestId), picked up again after a reload: the prover keeps working on its own.
  const resume = (requestId, { onUpdate = () => {} } = {}) => follow(String(requestId).replace(/^device-/, ''), onUpdate);

  return { health, supports, allowLive, prove, proveBatch, resume };
}
