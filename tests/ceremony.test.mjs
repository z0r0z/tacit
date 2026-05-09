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

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
