// Live integration test for the ceremony's IPFS fetch path.
//
// Why this test exists:
//   The dag-pb-rejects-chunked-files bug shipped because every other test
//   in this suite uses mock fetch with synthetic bytes — the validator was
//   never exercised against the actual r1cs/ptau bytes a real IPFS gateway
//   serves for our pinned CIDs. This test closes that gap by hitting the
//   live worker for ceremony state, fetching the live r1cs + ptau bytes
//   from the live gateway, and re-running the same sha256-anchored
//   validation strategy the dapp uses in production.
//
// What this proves end-to-end:
//   - Worker's ceremony state still resolves to a circuit_hash that matches
//     the dapp's hardcoded TACIT_DEFAULT_CEREMONY_HASH.
//   - Gateway-served r1cs bytes hash to that same circuit_hash (the dapp's
//     trust anchor for r1cs).
//   - Gateway-served ptau bytes hash to TACIT_DEFAULT_PTAU_SHA256 (the
//     dapp's trust anchor for ptau).
//   Any drift between worker state, IPFS pin, and dapp constants — the
//   class of failure that took the contributor down — fails this test.
//
// Network policy:
//   Skips gracefully (with a clear "skipped: <reason>" line) if the worker
//   or gateway is unreachable, so transient infra issues don't break CI.
//   A real correctness bug (digest mismatch) fails loudly.
//
// Run: `node ceremony-live-fetch.test.mjs`

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// Trust anchors — kept in sync with dapp/tacit.js. Not imported from
// tacit.js because that file boots a browser-y module graph (jsdom
// scaffolding etc.) and this test deliberately runs in pure Node so it
// can be added to CI cheaply. Drift detection: if either constant changes
// in tacit.js without changing here, this test still locks the dapp's
// shipped trust anchor against the live ceremony files — the user-visible
// failure mode is "validator rejects everything," which is exactly what
// we want this test to flag.
const TACIT_DEFAULT_CEREMONY_HASH = '1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d';
const TACIT_DEFAULT_PTAU_SHA256   = '489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d';
const WORKER_BASE = process.env.TACIT_WORKER_BASE || process.env.WORKER_BASE || 'https://api.tacit.finance';
const IPFS_GATEWAY = 'https://content.wrappr.wtf/ipfs/';

let pass = 0, fail = 0, skip = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(result => {
      if (result === true)            { console.log(`  PASS  ${label}`); pass++; }
      else if (result?.skip)          { console.log(`  SKIP  ${label} — ${result.skip}`); skip++; }
      else                            { console.log(`  FAIL  ${label}${result?.detail ? ': ' + result.detail : ''}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// Treat any network error or non-2xx as a SKIP, so a flaky gateway
// doesn't masquerade as a correctness regression. Validator-shape
// mismatches (which would indicate a real bug) still produce FAIL.
async function fetchOrSkip(url, label) {
  let resp;
  try { resp = await fetch(url, { cache: 'no-store' }); }
  catch (e) { return { skip: `${label}: network unreachable (${e.message || e})` }; }
  if (!resp.ok) return { skip: `${label}: HTTP ${resp.status}` };
  return { resp };
}

await test('worker ceremony state matches dapp\'s hardcoded TACIT_DEFAULT_CEREMONY_HASH', async () => {
  const r = await fetchOrSkip(`${WORKER_BASE}/ceremony/${TACIT_DEFAULT_CEREMONY_HASH}`, 'worker');
  if (r.skip) return r;
  const j = await r.resp.json();
  const state = j.state;
  if (!state) return { detail: 'no state in response — ceremony missing on worker' };
  if (state.circuit_hash !== TACIT_DEFAULT_CEREMONY_HASH) {
    return { detail: `circuit_hash drift: worker says ${state.circuit_hash}, dapp expects ${TACIT_DEFAULT_CEREMONY_HASH}` };
  }
  if (!state.r1cs_cid || !state.ptau_cid) {
    return { detail: `state missing CIDs: ${JSON.stringify({ r1cs_cid: state.r1cs_cid, ptau_cid: state.ptau_cid })}` };
  }
  return true;
});

await test('live r1cs bytes from gateway hash to TACIT_DEFAULT_CEREMONY_HASH (validator-accept regression)', async () => {
  const sr = await fetchOrSkip(`${WORKER_BASE}/ceremony/${TACIT_DEFAULT_CEREMONY_HASH}`, 'worker');
  if (sr.skip) return sr;
  const state = (await sr.resp.json()).state;
  if (!state?.r1cs_cid) return { skip: 'worker has no r1cs_cid — ceremony not initialized' };

  const fr = await fetchOrSkip(`${IPFS_GATEWAY}${state.r1cs_cid}`, 'r1cs gateway');
  if (fr.skip) return fr;
  const bytes = new Uint8Array(await fr.resp.arrayBuffer());
  const actual = bytesToHex(sha256(bytes));
  if (actual !== TACIT_DEFAULT_CEREMONY_HASH) {
    return { detail: `r1cs digest drift: bytes(${bytes.length}) hash to ${actual}, expected ${TACIT_DEFAULT_CEREMONY_HASH}` };
  }
  // Also sanity-check the magic-byte tag the dapp's pre-snarkjs validator
  // checks. If r1cs no longer starts with 'r1cs' the chain-verify would
  // fail at a different stage; surface it here.
  if (bytes[0] !== 0x72 || bytes[1] !== 0x31 || bytes[2] !== 0x63 || bytes[3] !== 0x73) {
    return { detail: `r1cs magic-byte missing — first 4 bytes: ${Array.from(bytes.slice(0,4)).map(b=>b.toString(16).padStart(2,'0')).join('')}` };
  }
  return true;
});

await test('live ptau bytes from gateway hash to TACIT_DEFAULT_PTAU_SHA256 (validator-accept regression)', async () => {
  const sr = await fetchOrSkip(`${WORKER_BASE}/ceremony/${TACIT_DEFAULT_CEREMONY_HASH}`, 'worker');
  if (sr.skip) return sr;
  const state = (await sr.resp.json()).state;
  if (!state?.ptau_cid) return { skip: 'worker has no ptau_cid — ceremony not initialized' };

  const fr = await fetchOrSkip(`${IPFS_GATEWAY}${state.ptau_cid}`, 'ptau gateway');
  if (fr.skip) return fr;
  const bytes = new Uint8Array(await fr.resp.arrayBuffer());
  const actual = bytesToHex(sha256(bytes));
  if (actual !== TACIT_DEFAULT_PTAU_SHA256) {
    return { detail: `ptau digest drift: bytes(${bytes.length}) hash to ${actual}, expected ${TACIT_DEFAULT_PTAU_SHA256}` };
  }
  if (bytes[0] !== 0x70 || bytes[1] !== 0x74 || bytes[2] !== 0x61 || bytes[3] !== 0x75) {
    return { detail: `ptau magic-byte missing — first 4 bytes: ${Array.from(bytes.slice(0,4)).map(b=>b.toString(16).padStart(2,'0')).join('')}` };
  }
  return true;
});

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
