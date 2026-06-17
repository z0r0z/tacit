# PLAN — full Tacit cross-chain test suite on signet/sepolia ("do all the things")

Maximize the signet/sepolia test infra: validate the **entire** Tacit cross-chain protocol surface live,
not just the fast lane. The keystone (a signet-capable relay) is now unblocked, so the whole surface is
reachable. Ordered by dependency; each phase is live on-chain.

## Keystone — DONE 2026-06-17
The shared relay was on a dead signet fork AND a fresh relay from current source was blocked by the
mainnet `MAX_TARGET` (signet difficulty is *easier* → its target exceeds the mainnet cap → genesis
reverted). **Fixed:** `MAX_TARGET` is now a ctor immutable (`BitcoinLightRelay`) — mainnet passes the cap,
`TestnetLightRelay` passes the signet powLimit `0x00000377ae…`; `_bitsToTarget`/`_retargetTarget` →
`view`; `Deploy.s.sol` env `RELAY_MAX_TARGET`. Relay tests green. `DeployTestnet.s.sol` already deploys a
signet relay (`initTestnetGenesis` from `BTC_*` env) — now correct for current signet difficulty.

## The surface, ordered (each phase live on signet/sepolia)
- **A — relay + pool (foundation).** `DeployTestnet.s.sol`: deploy `TestnetLightRelay` seeded at a recent
  **canonical** signet block (`BTC_GENESIS_*` from a near-tip block; `RUNBOOK-fastlane-roundtrip-live.md`
  has the param recipe) → `advance-relay.sh` (canonical headers, no fork) → deploy the confidential pool
  anchored to it (the re-proven vkeys `0x0073ee38`/`0x003281ea`) → first `attestBitcoinStateProven`
  (= `BITCOIN_RELAY_VKEY` live on-chain + the Bitcoin pool root established).
- **B — settle op-set (single-chain, PROGRAM_VKEY live).** wrap (→ a note + `PROGRAM_VKEY` on-chain),
  transfer, withdraw, OP_SWAP, OP_LP_ADD/REMOVE, OP_OTC, OP_BID, OP_SWAP_ROUTE, the adaptor ops
  (LOCK/CLAIM/REFUND). Each: build witness → box groth16 → settle. Exercises every op the guest ships.
- **C — bridge BTC→ETH** (`bridge_burn` on Bitcoin → reflect into the burn set → `bridge_mint` on ETH).
- **D — fast lane** (a btcHomed note spent directly on ETH; needs C's reflected note). Finishes the
  **live fast-lane verification.** Uses the committed crosslane fixtures/harnesses + the contract bar.
- **E — bridge ETH→BTC + reverse bridge.** `crossOut` (CLI done) → `0x65` broadcast (#11) → reflect
  (`fold_crossout`, #12) → mint on Bitcoin; then **crossOut-into-an-op** (the instant reverse bridge,
  `PLAN-instant-reverse-bridge.md`).
- **F — cBTC.zk** (the self-custody lock-fold reflection + `cbtcBackingSats`) — already in the reflection
  guest; exercise the lock → fold → backing path live.
- **G — cross-chain AMM/orderbook** (btcHomed swap/LP into an ETH pool; both-Bitcoin OTC/BID fills). The
  one-settle versions ride the relaxed bar; the mixed-lane fill is the two-settle on-ramp.

## Gates + build gaps
- **Box** (vast 40707240) for all groth16; **relay advancing** (a header relayer / `advance-relay.sh`) for
  C-G's attests. Sepolia gas (funded `0xD5B7…`) + signet sats (funded `tb1qjpj…`).
- **Build gaps** (`PLAN-instant-reverse-bridge.md`): `0x65` broadcaster (#11), reflection `fold_crossout`
  fixture + bridge_mint witness (#12). crossOut settle CLI done (`a2c01f5`).

## Sequencing
Phases A-B are the immediate live validation (deploy + settle op-set + first attest) once the signet relay
is deployed. C-G layer the cross-chain surface. Everything guest-affecting folds into the **alpha re-prove
(A0, `PLAN-unified-twochain-rollout.md`)** with mainnet config — one coordinated rotation, then mainnet beta.
This is a multi-session program; the keystone + the runbooks make each phase turnkey.
