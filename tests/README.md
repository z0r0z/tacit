# tacit tests

Offline tests for the dapp, the worker and the JS mirrors of the settle and reflection guests, plus the
scripts that generate guest fixtures and drive live-network runs.

## Setup

```sh
npm install              # repo root: snarkjs, poseidon, noble
cd tests && npm install  # noble/scure pins + jsdom for the dapp-in-Node tests
```

Node 20+.

## Running

Every test file is self-running and exits non-zero on failure. Run one from the repo root or from `tests/`:

```sh
node tests/swap-route.test.mjs
cd tests && node swap-route.test.mjs
```

`cd tests && npm test` runs the core crypto, envelope, worker and dapp-parity set; `npm run test:fast` skips
the slow Bulletproofs+ fuzz suites; `npm run test:amm` and `npm run test:mixer` run those groups. Proving-heavy
suites (`bulletproofs*`, `composition`, `range-proof`, `swap-var`, `*-fuzz`) take minutes each.

## What's here

| Pattern | What it is |
| --- | --- |
| `*.test.mjs` | Unit, parity and property tests. Offline unless listed below. |
| `confidential-*.mjs`, `*-fold*.mjs`, `*-parity.mjs`, other plain `*.mjs` that print `ok`/`PASS` | Self-running round-trips of the confidential pool ops and the reflection folds against the dapp and worker. Offline. |
| `bulletproofs.mjs`, `composition.mjs`, `swap-route.mjs`, `swap-var.mjs`, `amm-*.mjs` (no `.test`), `range-proof.mjs`, `storage.mjs`, `indexer.mjs`, `stealth-primitives.mjs`, `btc-mini.mjs`, `cxfer-helpers.mjs`, `helpers/` | Reference implementations and helpers imported by the tests. |
| `gen-*.mjs` | Fixture generators for the Solidity and guest tests (most print JSON to stdout or write under `contracts/`). Run one only to regenerate its fixture on purpose. `confidential-bridge-burn.mjs` rewrites its two `bridge_burn.json` fixtures only with `WRITE_FIXTURES=1`. |
| `build-*.mjs`, `debug-*.mjs`, `_*.mjs`, `tools/` | Operator scripts for building or inspecting specific live transactions. Not tests. |
| `*.bench.mjs` | Benchmarks (`npm run bench`). |

## Network-gated

These need a live service, a funded wallet, or a prover box, and are not part of an offline run:

- Anything named `*-signet*`, `*-sepolia*`, `*-testnet*`, `*broadcast*`, `run-v1-testnet.mjs`,
  `v1-fund-wallets.mjs`, `live-evm-settle-sepolia.mjs`, `etch-asset.mjs`, `bridge-3a.mjs`, `bridge-3b.mjs`.
- Mainnet readers: `bridge-multigen.test.mjs`, `tac-bridge-bundle.mjs`, `tac-bridge-provenance-dag.mjs`.
- CLIs that need arguments or env: `amm-pool-init-cli.mjs` (`ASSET_A_HEX`, …), `e2e-confidential-settle.mjs`.
- `capacity-monitoring.test.mjs` has one live check against the reflection API; set `OFFLINE=1` to skip it.
- `box-setup.sh` (prover box), `evm-confidential-anvil-roundtrip.sh` (local anvil + forge build),
  `reflection-*.sh` (build and execute the reflection guest locally).

Some tests skip cases unless an env var points at a heavy artifact: `RUN_SWAPBATCH_GEN` with
`REFLECT_SWAPBATCH_ZKEY`, `AMM_CEREMONY_*`, `TEST_DATABASE_URL` (Postgres-backed store tests).

## Keeping mirrors in sync

The reference implementations here mirror production code byte-for-byte (`bulletproofs.mjs` ↔
`dapp/bulletproofs.js`, `swap-route.mjs` ↔ the dapp builder and the reflection guest's route fold, and so
on). When a wire format, message or fold rule changes in `dapp/`, `worker/` or the guest, update the mirror
and its tests in the same change.
