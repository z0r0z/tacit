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
- `ops/scripts/modeb-prover-loop.sh` is the production Mode-B loop (the durable sibling of
  `contracts/sp1/eth-reflection/prover-host/run-reflect-loop.sh`, which proves eth→bitcoin EVERY cycle). It
  polls the pool for a NEW Bitcoin-destined `CrossOutRecorded` (`eth_getLogs` from the last-folded block to
  tip − `CONFIRMATIONS`, `destChain==1`) and branches:
  - **a pending crossOut** → `eth_prove` (helios light-client + crossOut/consumed-ν witness against the live
    beacon/exec state) → `bitcoin_prove` `PROOF_MODE=groth16` with `mode_b=1` (recursively binds the eth inner
    proof; the `ETH_REFLECTION_VKEY` coherence guard at `bitcoin_prove.rs:48-57` runs here) → submit.
  - **no crossOut** → the cheap forward attest (`bitcoin_prove` groth16, no eth recursion; the `modeB=0`
    fixture's `crossout_set_root=0` sentinel makes every 0x65 skip) → submit. This keeps the on-chain
    Bitcoin-state digest current without paying the helios prove on an idle cycle.
  - Required env: `POOL=<deployed pool>`, `GENESIS_SLOT`, `SOURCE_CONSENSUS_RPC`, `SOURCE_CHAIN_ID`,
    `SOURCE_EXECUTION_RPC` (the poll + `eth_prove` use it). Optional: `SUBMIT_URL=<relay attest queue>`
    (unset ⇒ dry-run, proof left in `out/`), `DEPLOY_BLOCK`, `CONFIRMATIONS` (default 36), `INTERVAL`
    (default 600), `REGEN_MODEB_CMD` / `REGEN_FWD_CMD` (the reflection-indexer fixture builders).
  - Box prerequisites: the eth-reflection guest ELF at `/root/sp1-helios/target/.../release/eth_reflection`
    (its recursion vkey must match `reflect.rs ETH_REFLECTION_VKEY` — verified 2026-06-25), the Bitcoin
    reflection ELF, `$HOST/target/release/{eth_prove,bitcoin_prove}` built, a running `sp1-gpu-server`, and
    `cast`/`jq`/`curl`.
  - Install the `@reboot` cron from the script footer so the loop survives a box reboot.

### 4. Un-gate the consumer + assembler  *(single config seam, automated)*
- `tools/sync-deployment-config.mjs <manifest.json> --network <net> --deploy-block N --write` sets
  `CONFIDENTIAL_POOL_DEPLOYMENTS[net].pool` (+ `deployBlock`) in `dapp/confidential-crossout-consumer.js`
  from the DeployV1Suite manifest (it also writes `DEPLOY_OVERRIDES` for the dapp). Do NOT hand-edit an
  address. This is the **only** code gate: while `pool` is `null` the worker's `buildCrossoutConsumer`
  returns null and the `/hint` crossout endpoint replies "crossout bridge not active"
  (`worker/src/index.js:13730-13732`); the cron `crossoutConsumer.scanOnce()` is a no-op. Setting the
  address activates the read path (CrossOutRecorded scan), the worker bind/mint, and the dapp assembler
  (`dapp/crossout-broadcast.js`, dependency-injected — it takes `{assetId,claimId,cx,cy,owner}` from the
  burn flow, no pool of its own) together. No second mainnet gate exists. Both entries are held at
  `pool: null` (the fully-inert sentinel — a placeholder address would only HALF-gate: the factory would
  return a live consumer that scans a nonexistent pool every cron tick).

### 5. Smoke test  *(validation)*
- Run one live ETH→BTC crossOut and confirm the Bitcoin note mints and is spendable, per
  `RUNBOOK-confidential-modeb-roundtrip.md` (refresh its pool address / vkeys to the step-2 deploy first).

## Day-1 scope summary

| Piece | State |
|-------|-------|
| Reverse spend is bearer / permissionless (no original-bridger binding) | ✅ in source |
| `fold_crossout` + crossout op (0x65), worker T_CROSSOUT_MINT, dapp assembler | ✅ built, gated inert on pool address |
| `ops/scripts/modeb-prover-loop.sh` durable Mode-B loop (crossOut-gated forward/Mode-B switch) | ✅ built; needs production install (step 3) |
| eth-reflection guest vkey reconciled to the coordinated re-prove | ◻ step 1 — must be in the same round |
| Production beacon checkpoint anchor | ◻ step 2 (reflect.rs:286) |
| Pool address wired into the registry | ◻ step 4 (one line, post-deploy) |
