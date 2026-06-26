// Press-on harness: run the preauth-sale e2e (exercises takePreauthSale's
// opening-match check, hardening #3) against a LOCAL worker (wrangler dev on
// :8787) — api.tacit.finance's POST path still 429s on the shared signet
// explorer. Keys come from PREAUTH_SELLER_SK / PREAUTH_BUYER_SK / PREAUTH_ASSET_ID
// (env). Sets __TACIT_WORKER_BASE__ before the test imports the dapp.
globalThis.__TACIT_WORKER_BASE__ = process.env.LOCAL_WORKER_BASE || 'http://127.0.0.1:8787';
await import('./preauth-sale-e2e-signet.mjs');
