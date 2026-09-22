# tacit build

Dev-time tooling for the dapp in `../dapp/`. It is not part of the pinned dapp.

`npm run build`:

- bundles the vendor dependencies into `../dapp/vendor/`:
  - `tacit-deps.min.js` (`@noble/secp256k1`, `@noble/hashes`, `@scure/base`, `poseidon-lite`) from `entry.mjs`
  - `tacit-mixer.min.js` (snarkjs), lazy-loaded, from `entry-mixer.mjs`
  - `tacit-satsconnect.min.js` (sats-connect), lazy-loaded, from `entry-satsconnect.mjs`
- rewrites the `?cb=` cache-bust tokens for `tacit.js` and `preboot.js` in `../dapp/index.html`
  (a short sha256 prefix of each file)
- writes a brotli-q11 copy of `tacit.js` to `build/out/tacit.js.br` for the API's `/tacit.js`
  edge route, and prints the `wrangler kv key put` command that uploads it
- prints SHA-384 integrity hashes for every bundle, `tacit.js` and `index.html`

`npm run verify` reads the existing bundles and prints their hashes without rebuilding or rewriting
anything.

## When to run

```bash
cd build
npm install     # first time, or after a dependency bump
npm run build
```

Run it after any change to `dapp/tacit.js` or `dapp/preboot.js`, so the `?cb=` token in
`index.html` changes and clients fetch the new bytes, and after bumping a bundled dependency.

## Integrity

All code runs same-origin from the pinned `dapp/` directory; the CSP in `dapp/index.html` allows
`script-src 'self'` (plus `'wasm-unsafe-eval'`), so nothing loads from a third-party CDN. The
runtime known-answer tests (`runStartupKAT` in `tacit.js`) check the bundled primitives against
published vectors at startup, independently of the bundle hashes.

The build is deterministic: the same `node_modules/`, entry files and esbuild version give a
byte-identical bundle and the same SHA-384.

## Pinning to IPFS

```bash
ipfs add -r dapp
```
