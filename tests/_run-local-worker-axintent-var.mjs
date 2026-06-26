// Press-on harness: run the axintent-var T_AXFER_VAR take e2e (exercises the
// Step 6c kernel-conservation check in finalizeAxferVarTake) against a LOCAL
// worker (wrangler dev on :8787) instead of the rate-limited production API.
// Sets __TACIT_WORKER_BASE__ before the test imports the dapp.
globalThis.__TACIT_WORKER_BASE__ = process.env.LOCAL_WORKER_BASE || 'http://127.0.0.1:8787';
await import('./axintent-var-onchain-e2e-signet.mjs');
