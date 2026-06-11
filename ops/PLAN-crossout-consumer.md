# Scope — Bitcoin-side `CrossOut` consumer (ETH→Bitcoin mint)

The one real remaining build for cross-lane day-one: the component that honors an Ethereum
`CrossOutRecorded` (from a confidential-pool `bridge_burn`) by minting the destination **Bitcoin** Tacit
note. Scoped from a 3-way code map (tETH ETH→BTC mint flow · how the worker reads Ethereum · the
Bitcoin-side note model).

## The key finding: it's the mirror of the tETH deposit→mint flow

This is **not** a heavy new on-chain Bitcoin component. It's the same **wallet-broadcasts + worker-
validates** shape the live tETH bridge already uses for ETH→Bitcoin, run in the cross-lane direction —
so it's mostly reuse:

> **`bridge_burn` on Ethereum** emits `CrossOutRecorded(claimId, destChain=bitcoin, destCommitment, ν,
> assetId)`. → **The user's wallet** builds a Bitcoin `T_CXFER` whose output commitment **is** that
> `destCommitment` (carried verbatim, no re-commit) and broadcasts it. → **The worker** reads the
> Ethereum event (RPC), reads the Bitcoin tx (existing CXFER indexing), **binds** them
> (`T_CXFER` output leaf == `crossOut.destCommitment`), gates **one-mint-per-`claimId`**, and indexes the
> Bitcoin note — exactly the tETH `bridge_deposit_nullifier` lock, keyed by `claimId`.

Value correctness is free: the Ethereum `bridge_burn` already proved `Σ burned = Σ destCommitment` (its
kernel), and the commitment is **carried verbatim** to Bitcoin — so the Bitcoin note's value equals the
burned value by construction, no re-check (the same trick `bridge_mint` uses in the other direction).

## What it reuses (verbatim or small change)

- **Ethereum event decode — already exists.** `confidential-evm-log.js:77-86` `decodeLog` parses
  `CrossOutRecorded(bytes32 claimId, uint16 destChain, bytes32 destCommitment, bytes32 ν, bytes32 asset)`.
  TOPIC0 = `keccak256('CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)')`.
- **Ethereum RPC read — already exists.** `worker _ethRpcCall` (eth_call) + per-network fallback RPCs
  (`_TETH_ETH_RPCS`); adapts to `_ethGetLogs` with minimal change.
- **The anti-double-mint pattern — already exists.** tETH's `bridge_deposit_nullifier:{net}:{gen}{asset}:
  {denom}:{νHash}` KV lock generalizes to a `claimId` lock.
- **Bitcoin CXFER indexing + note model — already exists.** A Bitcoin note = a Taproot UTXO (outpoint =
  `keccak(txid‖vout)`), leaf = `keccak(asset‖Cx‖Cy‖owner)`, ν = `keccak(Cx‖Cy‖'spent')`; `destCommitment`
  **is** that leaf, and the reflection prover already re-derives it identically from CXFER outputs.
- **The broadcast actor — already the pattern.** "Ethereum→Bitcoin is a local wallet-built `T_CXFER` +
  broadcast" — the wallet that did `bridge_burn` knows the destination `(Cx, Cy)` (it chose them), so it
  builds the Bitcoin tx, exactly like the tETH user broadcasts the deposit envelope.

## The genuinely new work

**Worker (the consumer core):**
1. `_ethGetLogs(network, address, fromBlock, toBlock, topic0)` wrapper (adapt `_ethRpcCall`).
2. A **ConfidentialPool address registry** per network/gen (a `CROSSLANE_DEPLOYMENTS`-side mirror of
   `TETH_GENERATIONS`).
3. **Cron scan**: each tick, fetch `CrossOutRecorded` logs from `last_scanned → tip − confirmations`,
   `decodeLog` each, store under `crossout-recorded:{net}:{claimId}` with a **finality gate** (confirmation
   depth, the tETH `*_RETRY_DEPTH` pattern).
4. **Bind + gate at Bitcoin-CXFER index time**: when a `T_CXFER` output leaf matches a recorded
   `crossOut.destCommitment`, require the `claimId` be recorded-and-unconsumed, then set the `claimId`
   lock and index the Bitcoin note (mirroring `bridge_deposit` leaf indexing).

**Dapp (the broadcast half):**
5. After `bridge_burn`, build-and-broadcast the Bitcoin `T_CXFER` carrying the `destCommitment` output
   (reuse the existing CXFER envelope builder + the bridge `postHint` fast-track), and track status like a
   bridge note (`minted` once the worker binds it).

## The trust-model decision (the real design fork)

How does the worker trust that a `CrossOutRecorded` is genuinely on canonical Ethereum?

- **A — Trusted RPC + finality (day-one, tETH-parity).** The worker reads the event via RPC and waits a
  confirmation depth. The Bitcoin side trusts the worker's Ethereum read — **the same trust the live tETH
  bridge already runs on** (it confirms the deposit root via `eth_call`). §7's framing ("Bitcoin
  validators *read* Ethereum's `CrossOutRecorded`") is exactly this — a validator-software rule, not a
  consensus change. **Recommended for the pilot.**
- **B — Trustless Ethereum-state proof (follow-up).** A mirror of `BitcoinLightRelay`: an Ethereum light
  client / state proof on the Bitcoin/worker side proving the event is in canonical Ethereum. Trust-
  minimized but heavy (an Ethereum-consensus light client). The cross-lane's "in-guest accumulator is the
  target, the on-chain map is the bootstrap" logic applies: **A bootstraps, B is the destination.**

This mirrors `bridge_mint`'s posture (the Bitcoin-state proof is the box-gated trustless half there;
here the Ethereum-state proof is the symmetric trustless half) — so day-one is **A**, with **B** as the
trust-minimization follow-up that doesn't change the wallet/worker flow, only how the read is proven.

## Soundness notes

- **No unbacked mint via value:** `destCommitment` is carried verbatim and its value was kernel-proven on
  Ethereum; the consumer never re-commits, so it can't inflate.
- **No double-mint:** the `claimId` lock (one Bitcoin note per recorded crossOut) — the `bridgeMinted`
  mirror on the Bitcoin side.
- **The residual trust (mode A):** a malicious/buggy worker that fabricates a `CrossOutRecorded` read
  could mint an unbacked Bitcoin note — exactly the tETH bridge's existing RPC-trust surface, bounded by
  the pilot posture and closed by mode B.

## Open decisions

- **Owner field on the Bitcoin leaf.** The note model uses `owner = ZERO_OWNER` for the Bitcoin pool leaf;
  confirm the `bridge_burn` output's owner is emitted as `ZERO_OWNER` (so `destCommitment` matches the
  Bitcoin leaf hash), or reconcile the convention.
- **Finality depth for Ethereum** (reuse tETH's 36-block, or set per Ethereum finality semantics).
- **`claimId` ↔ Bitcoin-tx binding granularity** — one crossOut per `T_CXFER` output, or batch.
- **Stuck-claim recovery** — if the Bitcoin `T_CXFER` is broadcast but the Ethereum crossOut read lags,
  the wallet retries the hint (idempotent on the `claimId` lock); define the timeout/UX.
- **Who may broadcast** — the wallet in the happy path; allow a permissionless relayer (as with hints)?

## Build plan (phased)

1. ✅ **Worker read path** (DONE, `dapp/confidential-crossout-consumer.js` `makeCrossoutConsumer.scan` +
   `makeEthGetLogs`) — reuses the `CrossOutRecorded` decoder + `TOPIC0`; finality gate + cursor that never
   skips on RPC failure. `tests/confidential-crossout-consumer.mjs` (read checks).
2. ✅ **Worker bind + gate** (DONE, `bindBitcoinOutput`) — binds a Bitcoin output to a recorded crossOut by
   `claimId` iff the `destCommitment` matches, then consumes the `claimId` (one-mint-per-claimId). Bind
   checks in the same test (mint-once, dest-mismatch reject, unrecorded reject).
3. **Dapp broadcast** — `bridge_burn` → build/broadcast the Bitcoin `T_CXFER` carrying the `claimId` +
   `destCommitment` output + status tracking.
4. **Worker cron hook** — import + a gated `scan()` call each tick (inert until `CONFIDENTIAL_POOL_
   DEPLOYMENTS[net].pool` is set); lands with the pool deploy.
5. **Node round-trip test** — extend `confidential-crosslane-roundtrip.mjs`: the ETH→Bitcoin leg records a
   modeled `CrossOutRecorded`, broadcasts a `T_CXFER`, binds, and rejects a replay.
6. **(Follow-up) mode B** — the Ethereum-state proof, swapped in behind the same worker interface.

Reuses, not rebuilds: the event decode, RPC, CXFER indexing, the note model, and the nullifier-lock all
exist — the consumer is the glue + the dapp broadcast + the trust-mode choice.
