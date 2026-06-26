// Press-on harness: run the axintent T_AXFER take e2e against a LOCAL worker
// (wrangler dev on :8787) instead of the rate-limited production API. The local
// worker fetches signet txs from this machine's IP (not throttled), so the
// maker-side intent POST validation succeeds and the flow can reach the take
// phase where the new kernel check runs. Sets __TACIT_WORKER_BASE__ before the
// test imports the dapp.
globalThis.__TACIT_WORKER_BASE__ = process.env.LOCAL_WORKER_BASE || 'http://127.0.0.1:8787';
await import('./axintent-onchain-e2e-signet.mjs');
