# Mode-B day-1 activation — ETH→BTC redemption

Ordered checklist to bring Mode-B reverse reflection (Ethereum→Bitcoin redemption) live for v1. This is the
path that lets any holder of TAC-on-Ethereum — including a secondary holder who received it via the airdrop,
a Uniswap buy, or a private transfer — bridge it back to a Bitcoin Tacit note and use it on the sats
orderbook. The reverse spend is bearer/permissionless (authority is note-opening knowledge, no
original-bridger binding); this checklist is purely about standing up the prover + wiring, not access.

The **forward** path (BTC→ETH bridge_mint, airdrop, public-ERC20 exit, wrap-back-to-confidential) is already
covered by the onboarding re-prove and needs none of the steps below.

For the manual E2E validation procedure (one live ETH→BTC→ETH round trip), see
`RUNBOOK-confidential-modeb-roundtrip.md`. This doc is the production activation ordering; that one is the
smoke test.

## Why this isn't covered by the onboarding re-prove

`fold_crossout` lives in the reflection ELF (whose `BITCOIN_RELAY_VKEY` the onboarding re-prove rotates), but
it consumes the Ethereum crossOutSet from a **second program**, the `eth-reflection` guest, recursively
verified against a separately pinned `ETH_REFLECTION_VKEY` (`contracts/sp1/confidential/src/reflect.rs:277`).
With `mode_b==0` a sentinel `crossout_set_root=0` makes every reverse fold fail — by design this lets the
forward bridge re-prove **without** standing up the eth guest (`reflect.rs:295-300`).

**Coupling to plan around:** rebuilding the eth-reflection guest rotates `ETH_REFLECTION_VKEY`, which changes
the reflection ELF, which rotates `BITCOIN_RELAY_VKEY` again. So if Mode-B is wanted day-1, the eth-guest
standup must be **folded into the same coordinated re-prove** — doing the onboarding re-prove first and
adding Mode-B later costs a second reflection re-prove **and** a second pool redeploy.

## Steps

### 1. Fold the eth-reflection guest into the coordinated re-prove  *(box / proving)*
- Rebuild the `eth-reflection` guest against the coordinated ELF set; derive its vkey.
- Re-pin `ETH_REFLECTION_VKEY` (`contracts/sp1/confidential/src/reflect.rs:277`) to the rebuilt guest.
- Re-anchor `ETH_GENESIS_SYNC_COMMITTEE` (`reflect.rs:286`) from the Sepolia checkpoint to the production
  beacon checkpoint.
- Re-prove the reflection ELF **once** so `BITCOIN_RELAY_VKEY` lands in its final Mode-B form. Update
  `contracts/sp1/confidential/elf-vkey-pin.json` and confirm both guest vkeys match the committed ELFs
  (a drifted ELF verifies locally but reverts on-chain).

### 2. Deploy the pool with the final vkeys  *(deploy)*
- Deploy `ConfidentialPool` carrying the final `PROGRAM_VKEY` + `BITCOIN_RELAY_VKEY`. Record the address —
  it is the single input the remaining steps need.

### 3. Stand up the production Mode-B prover loop  *(box / ops)*
- `contracts/sp1/eth-reflection/prover-host/run-reflect-loop.sh` is already durable (per-cycle GPU cleanup,
  heartbeat JSON for `/prover-health`, crash-surviving loop). Install it for reboot survival with the
  deployed pool + the relay attest endpoint:
  - `POOL=<deployed pool>`, `SUBMIT_URL=<relay attest queue>`, `GENESIS_SLOT`, `SOURCE_CONSENSUS_RPC`,
    `SOURCE_CHAIN_ID`, optional `REGEN_CMD` (reflection indexer) and `INTERVAL`.
  - Install the `@reboot` cron from the script footer so the loop survives a box reboot.
- Without `SUBMIT_URL` the loop is a dry-run (proof left in `out/`); set it to begin attesting.

### 4. Un-gate the consumer + assembler  *(single config seam)*
- Set `CONFIDENTIAL_POOL_DEPLOYMENTS.mainnet.pool = <deployed pool>` (+ `deployBlock`) in
  `dapp/confidential-crossout-consumer.js:21`. This is the **only** code gate: while `pool` is null the
  worker's `buildCrossoutConsumer` returns null and the `/hint` crossout endpoint replies "crossout bridge
  not active" (`worker/src/index.js:13731-13732`); the cron `crossoutConsumer.scanOnce()` is a no-op. Setting
  the address activates the read path (CrossOutRecorded scan), the worker bind/mint, and the dapp assembler
  (`dapp/crossout-broadcast.js`) together. No second mainnet gate exists.

### 5. Smoke test  *(validation)*
- Run one live ETH→BTC crossOut and confirm the Bitcoin note mints and is spendable, per
  `RUNBOOK-confidential-modeb-roundtrip.md` (refresh its pool address / vkeys to the step-2 deploy first).

## Day-1 scope summary

| Piece | State |
|-------|-------|
| Reverse spend is bearer / permissionless (no original-bridger binding) | ✅ in source |
| `fold_crossout` + crossout op (0x65), worker T_CROSSOUT_MINT, dapp assembler | ✅ built, gated inert on pool address |
| `run-reflect-loop.sh` durable prover loop | ✅ exists; needs production install (step 3) |
| eth-reflection guest vkey reconciled to the coordinated re-prove | ◻ step 1 — must be in the same round |
| Production beacon checkpoint anchor | ◻ step 2 (reflect.rs:286) |
| Pool address wired into the registry | ◻ step 4 (one line, post-deploy) |
