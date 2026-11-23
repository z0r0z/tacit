// The newest TacProvenOracle proof, passed from the prover box to whoever records it (the vault keeper) and whoever reads it (the vault page).
//
//   POST /oracle/proof { publicValues, proof }   kept when the SP1 verifier takes it for the oracle's program key and its interval is newer
//                                                 than the one held; nothing else is kept
//   GET  /oracle/proof                           { publicValues, proof, vkey, x, at } as tac-oracle-host writes it, 404 while there is none
//
// Anyone may post: a proof is checked by the verifier contract (an eth_call, as the proof pool checks its wraps), so only a proof of the
// pinned program can be kept, and posting one that is not newer changes nothing. What reads it records it through the oracle (which checks
// it again) after its own eth_call, so this holds a copy and is trusted with nothing. One post per client per RATE_MS bounds the calls.
//
// Storage (KV): op:latest ({ publicValues, proof, vkey, x, at }), op:rate:<client> (when it last posted, kept a minute).
export const ORACLE_PROOF = Object.freeze({
  // contracts/sp1/tac-oracle/elf-vkey-pin.json: the program every TacProvenOracle is deployed with
  vkey: '0x00a80a91f18c8fe571603e39957eb27194c2bfac027b1c894d399f513204e0fb',
  verifier: '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2',   // SP1 v6.1.0 Groth16, the immutable leaf
  // what SP1's verifyProof wants before the 288 bytes the oracle takes: its selector, the exit code (0) and the circuit's vk root, which the oracle adds itself
  prefix: '0x4388a21c' + '00'.repeat(32) + '002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352',
  proofHex: 576,                                              // 288 bytes, what the page and the keeper expect
  maxPublicValuesHex: 2048,
  rateMs: 15_000,
});

const HEX = /^[0-9a-f]*$/;
const WORD = /^0x[0-9a-f]{64}$/;

export function oracleProofConfig(env = {}) {
  const vkey = String(env.ORACLE_PROOF_VKEY || '').toLowerCase();
  return { ...ORACLE_PROOF, ...(WORD.test(vkey) ? { vkey } : {}) };
}

// The interval a proof is for: the low 32 bits of the public values' second word.
export const proofInterval = (publicValues) => Number(BigInt('0x' + publicValues.slice(64, 128)) & 0xffffffffn);

// kv: { get, put(key, value, { expirationTtl }?) }. verify({ publicValues, proof (with the verifier's prefix in front), vkey, verifier }) → { ok } | { ok: false, definite? } as ethCallVerdict
// answers: `definite` only when the chain said the proof is bad (a node that could not answer is not a verdict). Every call answers { status, body }.
export function makeOracleProof({ kv, cfg = ORACLE_PROOF, verify, now = () => Date.now(), lock = (fn) => fn() }) {
  async function latest() {
    const raw = await kv.get('op:latest');
    try { return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { return null; }
  }
  return {
    async get() {
      const p = await latest();
      return p ? { status: 200, body: p } : { status: 404, body: { ok: false, error: 'no proof posted yet' } };
    },
    async submit({ publicValues, proof, client = 'anon' }) {
      const norm = (x) => String(x ?? '').toLowerCase().replace(/^0x/, '');
      const pv = norm(publicValues), pf = norm(proof);
      if (!HEX.test(pv) || !HEX.test(pf) || pv.length < 128 || pv.length % 64 || pv.length > cfg.maxPublicValuesHex || pf.length !== cfg.proofHex) {
        return { status: 400, body: { ok: false, error: 'not a proof' } };
      }
      const x = proofInterval(pv);
      const held = await latest();
      if (held && x <= held.x) return { status: 409, body: { ok: false, error: `interval ${x} is not newer than ${held.x}`, x: held.x } };
      const last = Number(await kv.get(`op:rate:${client}`)) || 0;
      if (now() - last < cfg.rateMs) return { status: 429, body: { ok: false, error: 'too soon' } };
      await kv.put(`op:rate:${client}`, String(now()), { expirationTtl: 60 });
      const v = await verify({ publicValues: '0x' + pv, proof: cfg.prefix + pf, vkey: cfg.vkey, verifier: cfg.verifier });
      if (!v?.ok) {
        return v?.definite
          ? { status: 400, body: { ok: false, error: 'the verifier does not take this proof' } }
          : { status: 503, body: { ok: false, error: 'could not check the proof, try again' } };
      }
      return lock(async () => {
        const again = await latest();
        if (again && x <= again.x) return { status: 409, body: { ok: false, error: `interval ${x} is not newer than ${again.x}`, x: again.x } };
        const rec = { publicValues: '0x' + pv, proof: '0x' + pf, vkey: cfg.vkey, x, at: Math.floor(now() / 1000) };
        await kv.put('op:latest', JSON.stringify(rec));
        return { status: 200, body: { ok: true, x } };
      });
    },
  };
}

const kvLocks = new WeakMap();
export function buildOracleProof(env, { verify } = {}) {
  const kv = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (!kv || !verify) return null;
  if (!kvLocks.has(kv)) {
    let tail = Promise.resolve();
    kvLocks.set(kv, (fn) => { const p = tail.then(fn, fn); tail = p.then(() => {}, () => {}); return p; });
  }
  return makeOracleProof({ kv, cfg: oracleProofConfig(env), verify, lock: kvLocks.get(kv) });
}
