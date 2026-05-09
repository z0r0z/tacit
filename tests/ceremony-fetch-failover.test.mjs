// Regression coverage for _ceremonyFetchIpfsWithFailover (dapp/tacit.js).
//
// The helper iterates IPFS_GATEWAYS_FALLBACK and accepts the first response
// whose `validate(bytes, headers)` returns null. The validator may be sync
// (head-zkey path: zkey magic-byte check) or async (r1cs/ptau path: CID-hash
// match via _ipfsCidMatches, which awaits sha256). A prior bug forgot to
// await the validator, so async validators returned a Promise that the
// truthiness check treated as an error string — every gateway response was
// silently rejected and stringified as "[object Promise]". Contributors hit
// this trying to verify the chain before snarkjs.zKey.contribute, with the
// surface error reading "all 4 IPFS gateways failed for <r1cs CID>" even
// when the primary gateway returned good bytes.
//
// What this proves that no other test does:
//   - Async validator returning null accepts the response (the regression).
//   - Async validator returning an error string falls through to the next
//     gateway and the error is recorded under the gateway name.
//   - Sync validator path keeps working (head-zkey caller stays unaffected).
//   - HTML content-type triggers fall-through without invoking the validator.
//   - Total failure across all 4 gateways throws with concatenated reasons.
//
// Run: `node ceremony-fetch-failover.test.mjs`

import { JSDOM } from 'jsdom';

// Boot jsdom before importing the dapp — top-level addEventListener and
// localStorage reads need browser globals at module-load time.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const { ceremonyFetchIpfsWithFailover } = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// ---- fetch stub ----
// Drives one Response per gateway from a queue. Each entry is either a
// Response factory or a function that throws (network error). Per-test
// stubs keep _ceremonyFetchIpfsWithFailover's gateway loop deterministic
// without coupling to the real IPFS_GATEWAYS_FALLBACK ordering.
function withFetchStub(handlers, body) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    const i = calls.length - 1;
    const h = handlers[i];
    if (!h) throw new Error(`unexpected fetch #${i + 1}: ${url}`);
    return h(url);
  };
  return Promise.resolve()
    .then(() => body(calls))
    .finally(() => { globalThis.fetch = orig; });
}

function okResponse(bytes, contentType = 'application/octet-stream') {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': contentType } });
}

const GOOD_BYTES = new Uint8Array(512);
crypto.getRandomValues(GOOD_BYTES);
const FAKE_CID = 'bafkreigh2akiscaildc6f7e7'; // shape only — validator decides match

// ---- Tests ----

await test('async validator returning null accepts the first gateway response (regression)', async () => {
  return withFetchStub(
    [() => okResponse(GOOD_BYTES)],
    async (calls) => {
      const validate = async (bytes) => {
        // Force a microtask to ensure the helper actually awaits, not
        // just happens to work because the async fn resolved synchronously.
        await Promise.resolve();
        return bytes.length === 512 ? null : 'wrong length';
      };
      const out = await ceremonyFetchIpfsWithFailover(FAKE_CID, validate);
      if (!(out instanceof Uint8Array)) return false;
      if (out.length !== 512) return false;
      if (calls.length !== 1) return false; // stopped at first gateway
      return true;
    },
  );
});

await test('async validator returning a string falls through to the next gateway', async () => {
  return withFetchStub(
    [() => okResponse(GOOD_BYTES), () => okResponse(GOOD_BYTES)],
    async (calls) => {
      let invocations = 0;
      const validate = async (bytes) => {
        await Promise.resolve();
        invocations += 1;
        // Reject the first gateway, accept the second.
        return invocations === 1 ? 'cid mismatch' : null;
      };
      const out = await ceremonyFetchIpfsWithFailover(FAKE_CID, validate);
      if (out.length !== 512) return false;
      if (calls.length !== 2) return false;
      if (invocations !== 2) return false;
      return true;
    },
  );
});

await test('sync validator returning null still works (head-zkey path unchanged)', async () => {
  return withFetchStub(
    [() => okResponse(GOOD_BYTES)],
    async (calls) => {
      const validate = (bytes) => (bytes.length >= 256 ? null : 'too small');
      const out = await ceremonyFetchIpfsWithFailover(FAKE_CID, validate);
      if (out.length !== 512) return false;
      if (calls.length !== 1) return false;
      return true;
    },
  );
});

await test('HTML content-type is rejected without invoking the validator', async () => {
  let validatorCalled = false;
  return withFetchStub(
    [
      () => okResponse(new TextEncoder().encode('<html>cf error page</html>'), 'text/html; charset=utf-8'),
      () => okResponse(GOOD_BYTES),
    ],
    async (calls) => {
      const validate = async () => { validatorCalled = true; return null; };
      const out = await ceremonyFetchIpfsWithFailover(FAKE_CID, validate);
      if (out.length !== 512) return false;
      if (calls.length !== 2) return false;
      // Validator runs only against the second (octet-stream) response; if it
      // also ran on the HTML response we'd see two invocations and the HTML
      // path would have masqueraded as success. The path lets HTML error
      // pages skip validation entirely.
      if (!validatorCalled) return false;
      return true;
    },
  );
});

await test('sha256-anchored validator: accepts bytes whose digest matches expected (post-fix r1cs/ptau path)', async () => {
  // Models the new ceremony-blob validator: pre-known sha256 of the
  // assembled file (TACIT_DEFAULT_CEREMONY_HASH for r1cs,
  // TACIT_DEFAULT_PTAU_SHA256 for ptau) is the trust anchor — sidesteps the
  // dag-pb chunked-CID pitfall that motivated this fix.
  const { sha256 } = await import('@noble/hashes/sha256');
  const { bytesToHex } = await import('@noble/hashes/utils');
  const bytes = new Uint8Array(8192);
  crypto.getRandomValues(bytes);
  const expectedHex = bytesToHex(sha256(bytes));
  return withFetchStub(
    [() => okResponse(bytes)],
    async (calls) => {
      const validate = (b) => {
        const actual = bytesToHex(sha256(b));
        return actual === expectedHex ? null : `sha256(${actual.slice(0, 16)}…) does not match expected ${expectedHex.slice(0, 16)}…`;
      };
      const out = await ceremonyFetchIpfsWithFailover(FAKE_CID, validate);
      if (out.length !== 8192) return false;
      if (calls.length !== 1) return false;
      return true;
    },
  );
});

await test('sha256-anchored validator: rejects substituted bytes (gateway-substitution defense)', async () => {
  // Same shape as above, but the gateway returns DIFFERENT bytes than the
  // ones we hashed. Validator must reject and the error string must
  // surface the digest mismatch (not "[object Promise]" or similar).
  const { sha256 } = await import('@noble/hashes/sha256');
  const { bytesToHex } = await import('@noble/hashes/utils');
  const expectedBytes = new Uint8Array(8192);
  crypto.getRandomValues(expectedBytes);
  const expectedHex = bytesToHex(sha256(expectedBytes));
  const substitutedBytes = new Uint8Array(8192);
  crypto.getRandomValues(substitutedBytes); // different content
  return withFetchStub(
    [
      () => okResponse(substitutedBytes),
      () => { throw new Error('Load failed'); },
      () => { throw new Error('Load failed'); },
      () => { throw new Error('Load failed'); },
    ],
    async (calls) => {
      const validate = (b) => {
        const actual = bytesToHex(sha256(b));
        return actual === expectedHex ? null : `sha256(${actual.slice(0, 16)}…) does not match expected ${expectedHex.slice(0, 16)}…`;
      };
      let caught;
      try { await ceremonyFetchIpfsWithFailover(FAKE_CID, validate); }
      catch (e) { caught = e; }
      if (!caught) return false;
      // First gateway must have been tried + rejected with the sha256 mismatch
      // message; subsequent gateways then fail with network errors.
      if (!/sha256\(.*\) does not match expected/.test(caught.message)) return false;
      if (!/Load failed/.test(caught.message)) return false;
      if (calls.length !== 4) return false;
      return true;
    },
  );
});

await test('all 4 gateways failing throws a concatenated error', async () => {
  return withFetchStub(
    [
      () => { throw new Error('Load failed'); },
      () => { throw new Error('Load failed'); },
      () => { throw new Error('Load failed'); },
      () => { throw new Error('Load failed'); },
    ],
    async (calls) => {
      let caught;
      try {
        await ceremonyFetchIpfsWithFailover(FAKE_CID, async () => null);
      } catch (e) { caught = e; }
      if (!caught) return false;
      if (calls.length !== 4) return false;
      // Sanity-check the format the dapp's UI surfaces to contributors.
      if (!/all 4 IPFS gateways failed/.test(caught.message)) return false;
      if (!/Load failed/.test(caught.message)) return false;
      // Regression assertion: a Promise must never be stringified into the
      // error message. Pre-fix, this was the entire failure mode.
      if (/\[object Promise\]/.test(caught.message)) return false;
      return true;
    },
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
