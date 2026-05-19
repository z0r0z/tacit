// SPEC §5.11.3 — Phase 2 ceremony coordinator endpoints.
//
// Coordinator state lives behind /ceremony/init, /ceremony/:hash/contribute,
// /ceremony/:hash/finalize, /ceremony/:hash/reset, /ceremony/:hash (state),
// /ceremony/:hash/attestations. Together these implement an append-only
// contribution chain: init writes a genesis record at index 0, each
// contribute advances head_cid under CAS on prev_cid, finalize applies the
// beacon and locks the chain.
//
// What this proves that no other test does:
//   - Auth gate distinguishes "no token configured on worker" (503) from
//     "wrong/missing token" (401). A misconfiguration must not silently
//     open the init path; a request with wrong creds must not 503 (which
//     would mask the brute-force attempt as misconfig).
//   - First-write-wins on /ceremony/init: a second init on the same
//     circuit_hash returns 409 with the existing state, never overwrites.
//     This is the gate that prevents an attacker from racing the legitimate
//     coordinator with a poisoned ptau.
//   - CAS on prev_cid in /contribute: two contributors holding the same
//     prev_cid both pin to IPFS, but only the first to KV-write lands.
//     The loser gets 409 with a stale-prev_cid error.
//   - /finalize locks the chain: subsequent /contribute returns 409 with a
//     "finalized" error. /finalize itself is also one-shot.
//   - /attestations returns the full chain in reverse-chronological order
//     including the index-0 genesis and the beacon record at the top.
//   - /reset is auth-gated and wipes both head state and per-index contrib
//     records.
//   - /contribute is publicly reachable (no token gate); rate limiting is
//     per-IP via the upload KV, separate from the auth gate.
//
// Approach: drive the worker's default fetch handler with constructed
// Request objects against a stubbed REGISTRY_KV / UPLOAD_KV pair, with a
// global fetch mock that returns canned Pinata IpfsHash responses. No real
// IPFS, no real network — the test is deterministic.
//
// Run: `node ceremony.test.mjs`

// Cloudflare Workers expose a `caches` API the worker uses to memoize the
// /atomic-intents and /market list endpoints. Node has no such global, so
// stub a no-op cache that always misses (`match` returns undefined) and
// silently accepts puts/deletes. Lets the contribute + finalize paths
// drive through their cache-invalidation hooks without throwing
// "caches is not defined" and masking the actual assertion.
if (typeof globalThis.caches === 'undefined') {
  globalThis.caches = {
    default: {
      async match() { return undefined; },
      async put() {},
      async delete() { return false; },
    },
  };
}

const worker = await import('../worker/src/index.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`);
    fail++;
  }
}

// ---- KV stub ----
function makeKv() {
  const data = new Map();
  return {
    _data: data,
    async get(key, kind) {
      const v = data.get(key);
      if (v === undefined) return null;
      if (kind === 'json') return JSON.parse(v);
      return v;
    },
    async put(key, value /* opts ignored — TTLs not material to ceremony */) {
      data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) { data.delete(key); },
    async list({ prefix, limit = 1000 }) {
      const keys = [];
      for (const k of data.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      keys.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      return { keys: keys.slice(0, limit), list_complete: true };
    },
  };
}

// ---- Pinata fetch stub ----
// Each call increments a counter so we can hand out distinct CIDs; lets
// CAS-race tests confirm the loser's pin still happened (we don't hide the
// wasted-pin cost — see worker handleCeremonyContribute comment) but didn't
// land in KV state.
let _pinCount = 0;
const _pinLog = [];
function mockPinataFetch() {
  globalThis.fetch = async (urlOrReq /*, init */) => {
    const url = typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url;
    if (url.includes('api.pinata.cloud/pinning/pinFileToIPFS')) {
      _pinCount += 1;
      const cid = `bafkreitestcid${String(_pinCount).padStart(48, '0')}`;
      _pinLog.push(cid);
      return new Response(JSON.stringify({ IpfsHash: cid }), { status: 200 });
    }
    throw new Error(`unmocked fetch: ${url}`);
  };
}
mockPinataFetch();

// ---- Env builder ----
// Use `_NO_TOKEN_` sentinel rather than `undefined` so callers can explicitly
// request the not-configured branch — destructuring defaults treat undefined
// as "use the default", which would mask the 503 case.
const _NO_TOKEN = Symbol('no-token');
function makeEnv({ token } = {}) {
  if (token === undefined) token = 'test-init-token-with-enough-length';
  const env = {
    REGISTRY_KV: makeKv(),
    UPLOAD_KV: makeKv(),
    PINATA_JWT: 'fake-jwt',
    DAILY_LIMIT: '1000',
    ALLOWED_ORIGINS: '*',
  };
  if (token !== _NO_TOKEN) env.CEREMONY_INIT_TOKEN = token;
  return env;
}

// ---- Request helpers ----
function makeFile(bytes, name = 'blob.bin', type = 'application/octet-stream') {
  return new File([bytes], name, { type });
}
function rand(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}
// snarkjs file format magic-byte tags at offset 0. The worker validates these
// before pinning to reject garbage uploads (see _hasCeremonyMagic). Tests
// produce files that prepend the right magic so the validator accepts them.
const _ZKEY_MAGIC = new Uint8Array([0x7a, 0x6b, 0x65, 0x79]);
const _R1CS_MAGIC = new Uint8Array([0x72, 0x31, 0x63, 0x73]);
const _PTAU_MAGIC = new Uint8Array([0x70, 0x74, 0x61, 0x75]);
function magicBlob(magic, len = 64) {
  const out = new Uint8Array(len);
  out.set(magic, 0);
  crypto.getRandomValues(out.subarray(magic.length));
  return out;
}
const CIRCUIT_HASH = 'a'.repeat(64);
// Worker requires beacon_block_hash to be exactly 64 hex chars (Bitcoin block
// hash). Default for tests that don't care about the specific value.
const BEACON_HASH_64 = '0123abcd'.repeat(8);

async function postInit(env, { token, circuit_hash = CIRCUIT_HASH, files = true, initiator = 'tester' } = {}) {
  const fd = new FormData();
  fd.append('circuit_hash', circuit_hash);
  fd.append('initiator_name', initiator);
  if (files) {
    fd.append('zkey0', makeFile(magicBlob(_ZKEY_MAGIC), 'a.zkey'));
    fd.append('r1cs', makeFile(magicBlob(_R1CS_MAGIC), 'a.r1cs'));
    fd.append('ptau', makeFile(magicBlob(_PTAU_MAGIC), 'a.ptau'));
  }
  const headers = {};
  if (token) headers['x-tacit-init-token'] = token;
  return worker.default.fetch(
    new Request('http://localhost/ceremony/init', { method: 'POST', body: fd, headers }),
    env,
  );
}
async function getState(env, hash = CIRCUIT_HASH) {
  return worker.default.fetch(new Request(`http://localhost/ceremony/${hash}`), env);
}
async function postContribute(env, { hash = CIRCUIT_HASH, prev_cid, contributor = 'alice', contrib_hash = 'abc' } = {}) {
  const fd = new FormData();
  fd.append('zkey', makeFile(magicBlob(_ZKEY_MAGIC), 'c.zkey'));
  fd.append('prev_cid', prev_cid);
  fd.append('contributor_name', contributor);
  fd.append('contribution_hash', contrib_hash);
  return worker.default.fetch(
    new Request(`http://localhost/ceremony/${hash}/contribute`, { method: 'POST', body: fd }),
    env,
  );
}
async function postFinalize(env, { token, hash = CIRCUIT_HASH, beacon = BEACON_HASH_64, iters = 10 } = {}) {
  const fd = new FormData();
  fd.append('zkey', makeFile(magicBlob(_ZKEY_MAGIC), 'f.zkey'));
  fd.append('beacon_block_hash', beacon);
  fd.append('beacon_iterations', String(iters));
  const headers = {};
  if (token) headers['x-tacit-init-token'] = token;
  return worker.default.fetch(
    new Request(`http://localhost/ceremony/${hash}/finalize`, { method: 'POST', body: fd, headers }),
    env,
  );
}
async function postReset(env, { token, hash = CIRCUIT_HASH } = {}) {
  const headers = {};
  if (token) headers['x-tacit-init-token'] = token;
  return worker.default.fetch(
    new Request(`http://localhost/ceremony/${hash}/reset`, { method: 'POST', headers }),
    env,
  );
}
async function getAttestations(env, hash = CIRCUIT_HASH) {
  return worker.default.fetch(new Request(`http://localhost/ceremony/${hash}/attestations`), env);
}

// ============================================================
// Auth gate — distinguishes "not configured" from "wrong creds"
// ============================================================

await test('init: 503 when CEREMONY_INIT_TOKEN not configured on worker', async () => {
  const env = makeEnv({ token: _NO_TOKEN });
  const res = await postInit(env, { token: 'anything' });
  return res.status === 503;
});

await test('init: 401 when token configured but request omits the header', async () => {
  const env = makeEnv();
  const res = await postInit(env, { token: undefined });
  return res.status === 401;
});

await test('init: 401 when presented token has wrong length (constant-time guard)', async () => {
  const env = makeEnv();
  const res = await postInit(env, { token: 'too-short' });
  return res.status === 401;
});

await test('init: 401 when presented token has correct length but wrong bytes', async () => {
  const env = makeEnv({ token: 'X'.repeat(40) });
  const res = await postInit(env, { token: 'Y'.repeat(40) });
  return res.status === 401;
});

// ============================================================
// Init validation + first-write-wins
// ============================================================

await test('init: 400 when circuit_hash is not 64 hex chars', async () => {
  const env = makeEnv();
  const res = await postInit(env, { token: env.CEREMONY_INIT_TOKEN, circuit_hash: 'not-hex' });
  return res.status === 400;
});

await test('init: 400 when files are missing from the form', async () => {
  const env = makeEnv();
  const res = await postInit(env, { token: env.CEREMONY_INIT_TOKEN, files: false });
  return res.status === 400;
});

await test('init: 400 when zkey0 lacks the snarkjs "zkey" magic-byte tag', async () => {
  const env = makeEnv();
  const fd = new FormData();
  fd.append('circuit_hash', CIRCUIT_HASH);
  fd.append('initiator_name', 'tester');
  fd.append('zkey0', makeFile(rand(64), 'bad.zkey')); // random — no magic prefix
  fd.append('r1cs', makeFile(magicBlob(_R1CS_MAGIC), 'a.r1cs'));
  fd.append('ptau', makeFile(magicBlob(_PTAU_MAGIC), 'a.ptau'));
  const res = await worker.default.fetch(
    new Request('http://localhost/ceremony/init', {
      method: 'POST', body: fd, headers: { 'x-tacit-init-token': env.CEREMONY_INIT_TOKEN },
    }),
    env,
  );
  if (res.status !== 400) return false;
  const body = await res.json();
  return /zkey/i.test(body.error || '') && /magic/i.test(body.error || '');
});

await test('init: 400 when r1cs lacks the snarkjs "r1cs" magic-byte tag', async () => {
  const env = makeEnv();
  const fd = new FormData();
  fd.append('circuit_hash', CIRCUIT_HASH);
  fd.append('initiator_name', 'tester');
  fd.append('zkey0', makeFile(magicBlob(_ZKEY_MAGIC), 'a.zkey'));
  fd.append('r1cs', makeFile(rand(64), 'bad.r1cs')); // random — no magic prefix
  fd.append('ptau', makeFile(magicBlob(_PTAU_MAGIC), 'a.ptau'));
  const res = await worker.default.fetch(
    new Request('http://localhost/ceremony/init', {
      method: 'POST', body: fd, headers: { 'x-tacit-init-token': env.CEREMONY_INIT_TOKEN },
    }),
    env,
  );
  return res.status === 400;
});

await test('init: success records state with contribution_count=0 and a genesis record', async () => {
  const env = makeEnv();
  const res = await postInit(env, { token: env.CEREMONY_INIT_TOKEN, initiator: 'alice' });
  if (res.status !== 200) return false;
  const body = await res.json();
  if (body.state.contribution_count !== 0) return false;
  if (body.state.initiator !== 'alice') return false;
  if (body.state.last_contributor !== 'alice') return false;
  if (!body.state.head_cid) return false;
  if (body.state.circuit_hash !== CIRCUIT_HASH) return false;
  // Confirm a contrib record was written for the genesis (index 0).
  const ar = await (await getAttestations(env)).json();
  return ar.attestations.length === 1 && ar.attestations[0].index === 0;
});

await test('init: second init on same circuit_hash returns 409 (no overwrite)', async () => {
  const env = makeEnv();
  const first = await postInit(env, { token: env.CEREMONY_INIT_TOKEN, initiator: 'alice' });
  if (first.status !== 200) return false;
  const firstBody = await first.json();
  const second = await postInit(env, { token: env.CEREMONY_INIT_TOKEN, initiator: 'mallory' });
  if (second.status !== 409) return false;
  // State must still be alice's.
  const stateRes = await getState(env);
  const state = (await stateRes.json()).state;
  return state.head_cid === firstBody.state.head_cid && state.initiator === 'alice';
});

// ============================================================
// Contribute — public access + CAS + state advancement
// ============================================================

await test('contribute: 404 when ceremony not initialized', async () => {
  const env = makeEnv();
  const res = await postContribute(env, { prev_cid: 'whatever' });
  return res.status === 404;
});

await test('contribute: is publicly reachable (no token gate)', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const initBody = await init.json();
  // Note: no x-tacit-init-token header passed.
  const res = await postContribute(env, { prev_cid: initBody.state.head_cid, contributor: 'bob' });
  return res.status === 200;
});

await test('contribute: 400 when zkey lacks the snarkjs "zkey" magic-byte tag', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const initBody = await init.json();
  const fd = new FormData();
  fd.append('zkey', makeFile(rand(64), 'bad.zkey')); // random bytes
  fd.append('prev_cid', initBody.state.head_cid);
  fd.append('contributor_name', 'mallory');
  fd.append('contribution_hash', 'abc');
  const res = await worker.default.fetch(
    new Request(`http://localhost/ceremony/${CIRCUIT_HASH}/contribute`, { method: 'POST', body: fd }),
    env,
  );
  return res.status === 400;
});

await test('contribute: 409 on stale prev_cid (does not match current head_cid)', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  await init.json();
  const res = await postContribute(env, { prev_cid: 'bafkreireallyoldsubmission', contributor: 'bob' });
  return res.status === 409;
});

await test('contribute: success advances head_cid and increments contribution_count', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const initBody = await init.json();
  const c1 = await postContribute(env, { prev_cid: initBody.state.head_cid, contributor: 'bob' });
  if (c1.status !== 200) return false;
  const c1Body = await c1.json();
  if (c1Body.state.contribution_count !== 1) return false;
  if (c1Body.state.last_contributor !== 'bob') return false;
  if (c1Body.state.head_cid === initBody.state.head_cid) return false;
  // A second sequential contribute against the new head should also land.
  const c2 = await postContribute(env, { prev_cid: c1Body.state.head_cid, contributor: 'carol' });
  if (c2.status !== 200) return false;
  const c2Body = await c2.json();
  return c2Body.state.contribution_count === 2 && c2Body.state.last_contributor === 'carol';
});

await test('contribute: CAS — two contributors against the same head, second loses 409', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const initBody = await init.json();
  // Both contributors hold initBody.state.head_cid as their prev_cid.
  const a = await postContribute(env, { prev_cid: initBody.state.head_cid, contributor: 'a' });
  const b = await postContribute(env, { prev_cid: initBody.state.head_cid, contributor: 'b' });
  if (a.status !== 200 || b.status !== 409) return false;
  const state = (await (await getState(env)).json()).state;
  return state.contribution_count === 1 && state.last_contributor === 'a';
});

// ============================================================
// Finalize — locks the chain
// ============================================================

await test('finalize: 401 without token', async () => {
  const env = makeEnv();
  await (await postInit(env, { token: env.CEREMONY_INIT_TOKEN })).json();
  const res = await postFinalize(env, { token: undefined });
  return res.status === 401;
});

await test('finalize: 400 when beacon_block_hash is shorter than 64 hex chars', async () => {
  const env = makeEnv();
  await (await postInit(env, { token: env.CEREMONY_INIT_TOKEN })).json();
  const res = await postFinalize(env, { token: env.CEREMONY_INIT_TOKEN, beacon: 'deadbeef' });
  if (res.status !== 400) return false;
  const body = await res.json();
  return /64 hex/i.test(body.error || '');
});

await test('finalize: 400 when beacon_block_hash contains non-hex characters', async () => {
  const env = makeEnv();
  await (await postInit(env, { token: env.CEREMONY_INIT_TOKEN })).json();
  const res = await postFinalize(env, { token: env.CEREMONY_INIT_TOKEN, beacon: 'z'.repeat(64) });
  return res.status === 400;
});

await test('finalize: success sets finalized=true and records beacon fields', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const initBody = await init.json();
  await postContribute(env, { prev_cid: initBody.state.head_cid, contributor: 'bob' });
  const beacon = 'deadbeef'.repeat(8); // 64 hex
  const res = await postFinalize(env, { token: env.CEREMONY_INIT_TOKEN, beacon, iters: 12 });
  if (res.status !== 200) return false;
  const body = await res.json();
  if (body.state.finalized !== true) return false;
  if (body.state.beacon_block_hash !== beacon) return false;
  if (body.state.beacon_iterations !== 12) return false;
  if (body.state.last_contributor !== 'beacon') return false;
  return body.contribution.is_beacon === true;
});

await test('finalize: contribute against a finalized ceremony returns 409', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const initBody = await init.json();
  await postFinalize(env, { token: env.CEREMONY_INIT_TOKEN });
  const stale = await postContribute(env, { prev_cid: initBody.state.head_cid });
  if (stale.status !== 409) return false;
  const body = await stale.json();
  return /finalized/i.test(body.error || '');
});

await test('finalize: second finalize is rejected (one-shot)', async () => {
  const env = makeEnv();
  await (await postInit(env, { token: env.CEREMONY_INIT_TOKEN })).json();
  const f1 = await postFinalize(env, { token: env.CEREMONY_INIT_TOKEN });
  if (f1.status !== 200) return false;
  const f2 = await postFinalize(env, { token: env.CEREMONY_INIT_TOKEN });
  return f2.status === 409;
});

// ============================================================
// Attestations — full chain in reverse-chronological order
// ============================================================

await test('attestations: returns full chain (genesis + contribs + beacon) in reverse order', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN, initiator: 'alice' });
  const initBody = await init.json();
  const c1 = await postContribute(env, { prev_cid: initBody.state.head_cid, contributor: 'bob' });
  const c1Body = await c1.json();
  await postContribute(env, { prev_cid: c1Body.state.head_cid, contributor: 'carol' });
  await postFinalize(env, { token: env.CEREMONY_INIT_TOKEN, beacon: 'cafe'.repeat(16) });
  const res = await getAttestations(env);
  const body = await res.json();
  if (body.attestations.length !== 4) return false;
  // Reverse order: beacon (index 3) first, genesis (index 0) last.
  const idxs = body.attestations.map(a => a.index);
  if (JSON.stringify(idxs) !== JSON.stringify([3, 2, 1, 0])) return false;
  if (body.attestations[0].is_beacon !== true) return false;
  if (body.attestations[3].contributor_name !== 'alice') return false;
  return true;
});

// ============================================================
// Reset — auth-gated, wipes everything
// ============================================================

await test('reset: 401 without token', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const res = await postReset(env, { token: undefined });
  return res.status === 401;
});

await test('reset: with auth wipes head state and all contribution records', async () => {
  const env = makeEnv();
  const init = await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const initBody = await init.json();
  await postContribute(env, { prev_cid: initBody.state.head_cid, contributor: 'bob' });
  const res = await postReset(env, { token: env.CEREMONY_INIT_TOKEN });
  if (res.status !== 200) return false;
  const stateRes = await getState(env);
  if (stateRes.status !== 404) return false;
  const ar = await (await getAttestations(env)).json();
  return ar.attestations.length === 0;
});

await test('reset: a fresh init on the same circuit_hash succeeds after reset', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN, initiator: 'first' });
  await postReset(env, { token: env.CEREMONY_INIT_TOKEN });
  const second = await postInit(env, { token: env.CEREMONY_INIT_TOKEN, initiator: 'second' });
  if (second.status !== 200) return false;
  const body = await second.json();
  return body.state.initiator === 'second' && body.state.contribution_count === 0;
});

// ============================================================
// /reserve DoS hardening (NFTDADE23 botted-queue report)
//
// The /reserve endpoint used to accept anonymous queue joins, letting
// one bot fill the FIFO queue with thousands of random UUIDs from a
// single IP and push honest contributors to the back of a fake queue.
// The fix layers three gates: (1) Schnorr sig binds each entry to a
// pubkey; (2) one queue slot per pubkey at a time; (3) per-IP cap of
// 20 fresh joins/day. Tests below exercise each gate.
// ============================================================

import * as _secp from '@noble/secp256k1';
import { sha256 as _sha256 } from '@noble/hashes/sha256';
import { hexToBytes as _hexToBytes, bytesToHex as _bytesToHex, concatBytes as _concatBytes } from '@noble/hashes/utils';

// Minimal BIP-340 Schnorr signer. Ported from the dapp's signSchnorr
// (dapp/tacit.js:5165) so test sigs verify byte-for-byte against
// worker.verifySchnorr — same primitive pair production uses. Importing
// the full dapp module would require JSDOM shims; this avoids that.
const _SECP_N = _secp.CURVE.n;
const _G = _secp.ProjectivePoint.BASE;
const _b32n = (b) => _secp.etc.bytesToNumberBE(b);
const _n32b = (n) => _secp.etc.numberToBytesBE(n, 32);
const _xor32 = (a, b) => { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = a[i] ^ b[i]; return r; };
function _tagged(tag, ...msgs) {
  const th = _sha256(new TextEncoder().encode(tag));
  return _sha256(_concatBytes(th, th, ...msgs));
}
function _signSchnorr(msgHash, priv32) {
  const dPrime = _b32n(priv32);
  if (dPrime <= 0n || dPrime >= _SECP_N) throw new Error('schnorr: invalid privkey');
  const P = _G.multiply(dPrime);
  const Pbytes = P.toRawBytes(true);
  const Px = Pbytes.slice(1);
  const d = (Pbytes[0] === 0x02) ? dPrime : (_SECP_N - dPrime);
  const aux = crypto.getRandomValues(new Uint8Array(32));
  const t = _xor32(_n32b(d), _tagged('BIP0340/aux', aux));
  const rand = _tagged('BIP0340/nonce', t, Px, msgHash);
  let kPrime = _b32n(rand) % _SECP_N;
  if (kPrime === 0n) throw new Error('schnorr: nonce zero');
  const R = _G.multiply(kPrime);
  const Rbytes = R.toRawBytes(true);
  const Rx = Rbytes.slice(1);
  const k = (Rbytes[0] === 0x02) ? kPrime : (_SECP_N - kPrime);
  const e = _b32n(_tagged('BIP0340/challenge', Rx, Px, msgHash)) % _SECP_N;
  const s = (k + e * d) % _SECP_N;
  return _concatBytes(Rx, _n32b(s));
}

function genKeypair() {
  let priv;
  do { priv = crypto.getRandomValues(new Uint8Array(32)); }
  while (!_secp.utils.isValidPrivateKey(priv));
  const pubXY = _secp.getPublicKey(priv, true);  // 33-byte compressed
  return { priv, pubHex: _bytesToHex(pubXY) };
}
const _CER_DOMAIN = new TextEncoder().encode('tacit-ceremony-reserve-v1');
function reserveSig(circuitHash, pubHex, priv, queueToken) {
  const msg = _sha256(_concatBytes(
    _CER_DOMAIN,
    _hexToBytes(circuitHash),
    _hexToBytes(pubHex),
    new TextEncoder().encode(queueToken || ''),
  ));
  return _bytesToHex(_signSchnorr(msg, priv));
}
async function postReserve(env, { hash = CIRCUIT_HASH, name = 'alice', pubHex, priv, queueToken = '', ip = '1.2.3.4' } = {}) {
  const body = { contributor_name: name };
  if (pubHex) body.contributor_pubkey = pubHex;
  if (queueToken) body.queue_token = queueToken;
  if (pubHex && priv) body.sig = reserveSig(hash, pubHex, priv, queueToken);
  return worker.default.fetch(
    new Request(`http://localhost/ceremony/${hash}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify(body),
    }),
    env,
  );
}

await test('reserve: 400 when contributor_pubkey is missing', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const res = await postReserve(env, {});
  if (res.status !== 400) return false;
  const j = await res.json();
  return /contributor_pubkey/i.test(j.error || '');
});

await test('reserve: 400 when sig is missing', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const { pubHex } = genKeypair();
  const res = await worker.default.fetch(
    new Request(`http://localhost/ceremony/${CIRCUIT_HASH}/reserve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contributor_pubkey: pubHex, contributor_name: 'x' }),
    }), env,
  );
  if (res.status !== 400) return false;
  const j = await res.json();
  return /sig required/i.test(j.error || '');
});

await test('reserve: 403 when sig does not verify against the supplied pubkey', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const a = genKeypair();
  const b = genKeypair();
  // Sign with B's privkey but submit A's pubkey — must fail at verify.
  const res = await worker.default.fetch(
    new Request(`http://localhost/ceremony/${CIRCUIT_HASH}/reserve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contributor_pubkey: a.pubHex,
        contributor_name: 'mismatched',
        sig: reserveSig(CIRCUIT_HASH, b.pubHex, b.priv, ''),
      }),
    }), env,
  );
  return res.status === 403;
});

await test('reserve: valid sig joins the queue and returns a token', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const k = genKeypair();
  const res = await postReserve(env, { pubHex: k.pubHex, priv: k.priv });
  if (res.status !== 200) return false;
  const j = await res.json();
  return typeof j.queue_token === 'string' && j.queue_token.length > 0 && j.is_head === true;
});

await test('reserve: same pubkey + same token re-poll is treated as a refresh, not duplicated', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const k = genKeypair();
  const first = await (await postReserve(env, { pubHex: k.pubHex, priv: k.priv })).json();
  const second = await (await postReserve(env, { pubHex: k.pubHex, priv: k.priv, queueToken: first.queue_token })).json();
  return second.queue_token === first.queue_token && second.total === 1;
});

await test('reserve: 409 when the same pubkey tries to claim a second slot under a fresh token', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const k = genKeypair();
  await postReserve(env, { pubHex: k.pubHex, priv: k.priv });
  // Second join with same pubkey but no queue_token → worker would mint a
  // new token. The pubkey-uniqueness gate must reject it.
  const res = await postReserve(env, { pubHex: k.pubHex, priv: k.priv });
  if (res.status !== 409) return false;
  const j = await res.json();
  return /pubkey already in queue/i.test(j.error || '');
});

await test('reserve: per-IP cap rejects > 20 fresh joins/day from the same IP', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  // 20 fresh joins succeed (each with a distinct pubkey so the per-pubkey
  // gate doesn't fire first). 21st must 429.
  for (let i = 0; i < 20; i++) {
    const k = genKeypair();
    const res = await postReserve(env, { pubHex: k.pubHex, priv: k.priv, ip: '9.9.9.9' });
    if (res.status !== 200) return false;
  }
  const k21 = genKeypair();
  const r = await postReserve(env, { pubHex: k21.pubHex, priv: k21.priv, ip: '9.9.9.9' });
  return r.status === 429;
});

await test('reserve: per-IP cap does NOT count existing-token polls toward the limit', async () => {
  const env = makeEnv();
  await postInit(env, { token: env.CEREMONY_INIT_TOKEN });
  const k = genKeypair();
  const first = await (await postReserve(env, { pubHex: k.pubHex, priv: k.priv, ip: '5.5.5.5' })).json();
  // Poll 50 times with the same token — must all 200 OK despite the cap.
  for (let i = 0; i < 50; i++) {
    const r = await postReserve(env, { pubHex: k.pubHex, priv: k.priv, queueToken: first.queue_token, ip: '5.5.5.5' });
    if (r.status !== 200) return false;
  }
  return true;
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
