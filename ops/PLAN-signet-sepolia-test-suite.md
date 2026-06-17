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
- **A — relay + pool (foundation). ✅ DONE 2026-06-17, all live on Sepolia + signet.** Signet relay
  `0x70C8022e45728ccdCacA85eF57C74aD9E535cDe7` (`TestnetLightRelay`, genesis canonical blk 309247,
  advanced to 309263) → pool `0x3D38a00406d97Ba2F5df7d30246b810C90AC7444` (vkeys `0x0073ee38`/`0x003281ea`,
  anchor blk 309251) → first `attestBitcoinStateProven` tx `0x22d23ee9…539f58a8` (forward reflection
  groth16 over [309252..309257]; pool root `0x27ae5ba0…` now canonical, digest advanced to `0x95f38b9e…`,
  lastRelayHeight 309257). `BITCOIN_RELAY_VKEY` LIVE; guest↔JS digest parity confirmed end-to-end. Box
  build-gap lesson (rebuild host bins after a guest rebuild; wire `reflect-stdin`) recorded in memory.
- **B — settle op-set (single-chain, PROGRAM_VKEY live). IN PROGRESS 2026-06-17/18.** ✅ `PROGRAM_VKEY
  0x0073ee38` LIVE: **wrap** (register native ETH `0x2a0f3cb4…` → `wrap()` pending deposit → OP_WRAP
  settle tx 0x1bb59976…, leaf 0, root R1) + **transfer** (OP_TRANSFER tx 0xbea5d5c2…, nullifier spent,
  leaf 1, root 0x9068baf7) — the note lifecycle (create+spend) proven. **unwrap** (OP_UNWRAP, full ETH
  round-trip) proving. KEY FINDING: the deployed guest `0x0073ee38` implements ALL 15 ops (WRAP..UNWRAP..
  SWAP/LP/OTC/BID/SWAP_ROUTE + ADAPTOR_LOCK/CLAIM/REFUND=12/13/14) and the contract `settle()` handles
  them — so EVERY remaining op (incl. cross-chain bridge + adaptor atomic-swap) is supportable on the LIVE
  stack with **NO redeploy + NO reprove**; remaining work is validation-only (witness → prove vs the
  EXISTING vkey → settle; AMM ops just need a `createPair` direct call first). Builders: e2e-confidential-
  settle.mjs (wrap/transfer), build-unwrap-3D38.mjs + harnesses/exec-unwrap.rs (NEW), gen-confidential-
  {swap,lp,otc,bid}-fixture.mjs (unit-targeted, need live-state adaptation). Box harness fix per op:
  repoint ELF cxfer-guest→confidential-pool-prover + add the lock_set_root write.
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
