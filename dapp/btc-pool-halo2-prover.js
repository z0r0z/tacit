// Halo2-KZG proof system for the Bitcoin shielded pool spend relation (contracts/sp1/confidential/btc-pool-halo2),
// behind the same interface as btc-pool-zk-prover.js makeGroth16System:
//
//   system.prove(input, { onProgress }) → { wire, publicSignals }     input: buildWitness(...).input
//   system.verify(publics, wire)        → bool                        publics: 12 decimal strings
//
// PSE halo2_proofs v0.3.0, BN254, SHPLONK, BLAKE2b transcript, over params derived from the pinned Hermez pot18
// (no circuit-specific setup). Wire: the transcript bytes, exactly HALO2_PROOF_LEN.
//
// Artifacts (bytes or async loaders): `wasm` (btc-pool/btc_pool_halo2_bg.wasm), `params` (params-k13.bin) and
// `vk` (vk.bin). The proving key is rebuilt from params and vk on first use. `pinnedVkHash` is the BLAKE2b-512
// of vk.bin; a key that does not match refuses to prove or verify.
//
// Browser: proving runs in a module Web Worker (btc-pool/halo2-worker.js), one thread. Node: in process.

import { publicSignals as toPublicSignals, ZK_N_PUBLIC } from './btc-pool-zk.js';

export const HALO2_SYSTEM_ID = 'halo2-kzg-bn254';
export const HALO2_PROOF_LEN = 2080;

const GLUE_URL = new URL('./btc-pool/btc_pool_halo2.js', import.meta.url).href;
const WORKER_URL = new URL('./btc-pool/halo2-worker.js', import.meta.url);

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('btc-pool-halo2: bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const strip = (h) => String(h || '').replace(/^0x/, '').toLowerCase();

let glueP = null;
// The wasm module, instantiated once per realm.
function glue(wasmBytes) {
  return (glueP ||= (async () => {
    const m = await import(GLUE_URL);
    await m.default({ module_or_path: await wasmBytes() });
    return m;
  })().catch((e) => { glueP = null; throw e; }));
}

// In-process backend: a Verifier for verify-only use, a Prover (keygen from the vk) once something proves.
function localBackend(get) {
  let verifier = null, prover = null;
  const mod = () => glue(() => get('wasm'));
  return {
    async digest() {
      const m = await mod();
      verifier ||= new m.Verifier(await get('params'), await get('vk'));
      return verifier.vkDigest();
    },
    async verify(doc) {
      const m = await mod();
      verifier ||= new m.Verifier(await get('params'), await get('vk'));
      return verifier.verify(doc);
    },
    async prove(input) {
      const m = await mod();
      prover ||= m.Prover.withVk(await get('params'), await get('vk'));
      const out = prover.prove(input);
      if (!prover.verify(out)) throw new Error('btc-pool-halo2: fresh proof does not verify');
      return out;
    },
  };
}

// Worker backend: the wasm, params and vk are handed to the worker once; proving and its self-check run there.
function workerBackend(get, makeWorker) {
  let w = null, seq = 0, ready = null;
  const waiting = new Map();
  const call = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    w.postMessage({ ...msg, id }, transfer);
  });
  const start = () => (ready ||= (async () => {
    w = makeWorker();
    w.onmessage = ({ data }) => {
      const p = waiting.get(data.id);
      if (!p) return;
      waiting.delete(data.id);
      if (data.ok) p.resolve(data); else p.reject(new Error(data.error || 'btc-pool-halo2: worker failed'));
    };
    w.onerror = (e) => {
      const err = new Error(`btc-pool-halo2: worker error: ${e?.message || 'failed to start'}`);
      for (const p of waiting.values()) p.reject(err);
      waiting.clear();
      ready = null;
      w?.terminate?.();
    };
    // Copies: the caller's cached bytes stay usable.
    const [wasm, params, vk] = [(await get('wasm')).slice(), (await get('params')).slice(), (await get('vk')).slice()];
    const r = await call({ op: 'init', wasm, params, vk }, [wasm.buffer, params.buffer, vk.buffer]);
    return r.vkDigest;
  })().catch((e) => { ready = null; throw e; }));
  return {
    digest: () => start(),
    async verify(doc) { await start(); return (await call({ op: 'verify', doc })).valid === true; },
    async prove(input) { await start(); return (await call({ op: 'prove', input })).out; },
  };
}

const defaultWorker = () => (typeof Worker === 'function' && typeof window !== 'undefined'
  ? () => new Worker(WORKER_URL, { type: 'module' })
  : null);

// { wasm, params, vk }: bytes or async loaders. worker: a () => Worker factory, null for in process; the default
// is a module worker in browsers and in process elsewhere.
export function makeHalo2System({ wasm, params, vk, pinnedVkHash, worker = defaultWorker() } = {}) {
  const pin = strip(pinnedVkHash);
  if (!/^[0-9a-f]{128}$/.test(pin)) throw new Error('btc-pool-halo2: pinnedVkHash must be the BLAKE2b-512 of vk.bin');
  const src = { wasm, params, vk };
  const loaded = new Map();
  const get = async (name) => {
    if (!loaded.has(name)) {
      const x = src[name];
      const v = typeof x === 'function' ? x() : x;
      loaded.set(name, Promise.resolve(v).then((b) => {
        if (!b) throw new Error(`btc-pool-halo2: ${name} unavailable`);
        return b instanceof Uint8Array ? b : new Uint8Array(b);
      }));
      loaded.get(name).catch(() => loaded.delete(name));
    }
    return loaded.get(name);
  };
  const backend = worker ? workerBackend(get, worker) : localBackend(get);
  let checked = null;
  const checkKey = () => (checked ||= backend.digest().then((d) => {
    if (d !== pin) throw new Error(`btc-pool-halo2: verification key ${d.slice(0, 16)}… is not the pinned ${pin.slice(0, 16)}…`);
  }).catch((e) => { checked = null; throw e; }));

  return {
    id: HALO2_SYSTEM_ID,
    wireLen: HALO2_PROOF_LEN,
    vkHash: pin,
    ready: checkKey,
    async prove(input, { onProgress } = {}) {
      onProgress?.('loading');
      await checkKey();
      onProgress?.('proving');
      const out = JSON.parse(await backend.prove(JSON.stringify(input)));
      const wire = unhex(out.proof);
      if (wire.length !== HALO2_PROOF_LEN) throw new Error(`btc-pool-halo2: proof is ${wire.length} bytes, expected ${HALO2_PROOF_LEN}`);
      if (out.publics.length !== ZK_N_PUBLIC) throw new Error('btc-pool-halo2: unexpected public signal count');
      return { wire, publicSignals: out.publics };
    },
    async verify(publics, wire) {
      if (!(wire instanceof Uint8Array) || wire.length !== HALO2_PROOF_LEN) return false;
      let signals;
      try {
        signals = Array.isArray(publics) ? publics.map((x) => BigInt(x).toString()) : toPublicSignals(publics);
      } catch { return false; }
      if (signals.length !== ZK_N_PUBLIC) return false;
      await checkKey();
      try {
        return (await backend.verify(JSON.stringify({ proof: hex(wire), publics: signals }))) === true;
      } catch { return false; }
    },
  };
}
