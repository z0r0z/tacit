// Vendor bundle entry — re-exports exactly the symbols tacit.html imports today.
// esbuild traces the dependency graph from this file and produces ONE minified
// ESM bundle. Pinning that one file (by SRI or by inlining into the HTML) gives
// you real integrity on every byte of crypto code that handles a private key.
//
// Re-export shape mirrors the existing imports in tacit.html so the rewritten
// imports stay 1:1 — no other code changes required.
export * as secp from '@noble/secp256k1';
export { sha256 } from '@noble/hashes/sha256';
export { ripemd160 } from '@noble/hashes/ripemd160';
export { hmac } from '@noble/hashes/hmac';
export { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
export { bech32 } from '@scure/base';

// Sats-Connect (Xverse / Leather / OKX provider abstraction). Vendored here so
// that no JS in the wallet origin loads from a third-party CDN at runtime —
// any imported module shares the JS realm with `wallet.priv`, so CDN fetches
// would expand the wallet's TCB to whoever serves them. The dApp only uses
// `default.request('getAccounts'|'sendTransfer', …)` so the rest of the
// surface is unused; tree-shaking trims what it can.
export { default as satsConnect } from 'sats-connect';
