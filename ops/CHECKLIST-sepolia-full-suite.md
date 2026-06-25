# CHECKLIST — Sepolia ConfidentialPool Full-Suite Testing

Goal: begin Sepolia testing with `ConfidentialPool` as the canonical bridge and DeFi surface.
The old `TacitBridgeMixer` tETH bridge is sunset alpha infrastructure for recovery/migration only.

## 0. Pin And Artifact Coherence

- [ ] `contracts/sp1/confidential/elf-vkey-pin.json` top-level fields are the deploy authority:
  `program_vkey`, `bitcoin_relay_vkey`, `elf_sha256`, `reflection_elf_sha256`.
- [ ] `contracts/script/DeployConfidentialPool.s.sol` `DEFAULT_VKEY` equals `.program_vkey`.
- [ ] `contracts/sp1/confidential/verify-vkey-pin.sh` passes.
- [ ] ProofReal fixtures match the pinned vkeys.
- [ ] No deploy uses historical `deployed_*` fields from `elf-vkey-pin.json`.

## 1. Deploy Fresh Sepolia Generation

- [ ] Deploy or select `CanonicalAssetFactory`.
- [ ] Deploy or select `BitcoinLightRelay`.
- [ ] Pick `GENESIS_REFLECTION_ANCHOR` at the near-tip matured signet relay tip.
- [ ] Deploy `ConfidentialPool` with:
  - `SP1_VERIFIER=<Sepolia immutable Groth16 leaf>`
  - `BITCOIN_RELAY_VKEY=$(jq -r .bitcoin_relay_vkey sp1/confidential/elf-vkey-pin.json)`
  - `CANONICAL_FACTORY=<factory>`
  - `HEADER_RELAY=<relay>`
  - `GENESIS_REFLECTION_ANCHOR=<near-tip block hash>`
  - `EXPECTED_CHAIN_ID=11155111`
  - `ACK_REFLECTION_ANCHORED=1`
- [ ] If testing native tETH, set `TETH_BITCOIN_ID=<canonical tETH Bitcoin asset id>` at deploy.
- [ ] If testing cBTC/cUSD, wire `COLLATERAL_ENGINE` and complete the engine pool pointer handoff.

## 2. Register Launch Assets

- [ ] Native ETH/tETH link is constructor-pinned, not permissionless `registerWrapped`.
- [ ] TAC canonical asset link registered through guest-proven metadata or controlled test registration.
- [ ] cBTC/cUSD test assets registered and controller/engine gates checked fail-closed.
- [ ] External ERC20 test assets use escrow mode only and have sane `unitScale`.

## 3. Start Services

- [ ] Worker: `CONFIDENTIAL_SETTLE=1`, `CONFIDENTIAL_KV` or `REGISTRY_KV`, `CONFIDENTIAL_BOX_TOKEN`.
- [ ] Worker: `REFLECTION_ATTEST=1`, `REGISTRY_KV`, `REFLECTION_GENESIS_HEIGHT`.
- [ ] Box: reflection loop proves and submits `attestBitcoinStateProven`.
- [ ] Box: settle loop claims jobs and submits `settle`.
- [ ] Monitor queue depth, failed proofs, `knownReflectionDigest`, `lastRelayHeight`,
  `knownBitcoinSpentRoot`, and `bitcoinConsumedCount`.

## 4. Dapp Flip

- [ ] `dapp/tacit.js` `TETH_DEPLOYMENTS.*.live` remains `false` unless doing explicit legacy recovery.
- [ ] Set `CROSSLANE_DEPLOYMENTS.signet.pool` to the fresh Sepolia pool and mark test assets `live:true`.
- [ ] Wire `scanHoldingsCrossChain()` with the derived EVM account before advertising unified holdings.
- [ ] Set `CONFIDENTIAL_POOL_DEPLOYMENTS.signet.pool` in `dapp/confidential-crossout-consumer.js`.
- [ ] Redeploy dapp + worker together.

## 5. Test Matrix

- [ ] Native wrap -> settle -> seed-only recover -> unwrap.
- [ ] Transfer note -> recover on recipient seed.
- [ ] Swap, route, LP add/remove.
- [ ] OTC and BID fill/refund paths.
- [ ] Farm bond/harvest/unbond.
- [ ] Bitcoin reflection attest from signet.
- [ ] `bridge_mint` from reflected Bitcoin state.
- [ ] `bridge_burn` / `crossOut` and reverse-consumer indexing.
- [ ] Fast-lane consumed-nullifier case: consume on Ethereum, reflect consumed set, reject stale attest.
- [ ] cBTC mint path and cUSD CDP mint/topup/close/liquidate.

## 6. Stop Conditions

- [ ] Any guest source change: stop, re-prove, rotate pin/default/fixtures together.
- [ ] Any pin mismatch: do not deploy.
- [ ] Reflection not advancing: do not flip cross-lane UI.
- [ ] Settle queue failing proofs: do not advertise DeFi routes.
- [ ] Legacy mixer path appears as active bridge UI: stop and re-check `TETH_DEPLOYMENTS.*.live`.
