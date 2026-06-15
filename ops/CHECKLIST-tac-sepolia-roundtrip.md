# CHECKLIST — first TAC public round-trip on Sepolia

Fire and verify the first real end-to-end flow for a Tacit-native asset (TAC) on the
confidential pool: **bridge in → deploy + mint the public ERC20 → use it in the pool →
bridge back**. This is the post-re-prove smoke test — it validates the burn-deposit
onboarding dispatch against a live pool, with concrete on-chain assertions at every gate.

Each phase lists: the action, who drives it, the on-chain effect, and the `cast` assertion
that confirms it. STOP at any failed assertion — the gate is fail-closed by design, so a
revert means a witness/config problem, not a partial state to clean up.

> Executable companion: `scripts/tac-roundtrip-verify.sh` runs these assertions (exit-on-fail).
> `POOL=0x<pool> ./scripts/tac-roundtrip-verify.sh state` checks Phase 0/1/2 + invariants; the
> per-phase subcommands (`bridgemint <ν>`, `unwrap <recipient> <amount>`, `rewrap <depositId>`,
> `crossout <claimId> <destCommitment> <ν>`) verify the proof-driven transitions as they land.

## Parameters

```sh
export RPC=https://ethereum-sepolia-rpc.publicnode.com
export POOL=<new pool from the re-prove deploy>        # immutable; new BITCOIN_RELAY_VKEY ⇒ new pool
export FACTORY=$(cast call $POOL 'CANONICAL_FACTORY()(address)' --rpc-url $RPC)
export TAC=0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b   # TAC shared (Bitcoin) asset id
export TAC_CID=<TAC etch metadata cid, 0x0 if none>    # the IPFS metadata hash bound into the etch
```

## Phase 0 — Preconditions (no proof)

- [ ] Re-prove landed: `elf-vkey-pin.json` `program_vkey` / `bitcoin_relay_vkey` bumped, both ELF
      sha256s reconciled in the same commit, `verify-vkey-pin.sh` green. (The reflection vkey
      rotates on re-prove, so the **old pool `0x991726a5…` cannot verify the new proofs — a fresh
      pool deploy is required**, per `CHECKLIST-mainnet-reprove.md`.)
- [ ] New pool deployed; assert the deployed circuit == the pin:
  ```sh
  cast call $POOL 'PROGRAM_VKEY()(bytes32)' --rpc-url $RPC        # == pin.program_vkey
  cast call $POOL 'BITCOIN_RELAY_VKEY()(bytes32)' --rpc-url $RPC  # == pin.bitcoin_relay_vkey
  cast call $POOL 'CANONICAL_FACTORY()(address)' --rpc-url $RPC   # != 0 (auto-register enabled)
  cast call $POOL 'HEADER_RELAY()(address)' --rpc-url $RPC        # != 0 (reflection active)
  ```
- [ ] Prover box up (produces settle + reflection SP1 proofs against the pinned ELF), settler key
      funded with Sepolia ETH, worker crossout-consumer running.

## Phase 1 — Bootstrap reflection on the new pool

The first reflection batch resumes from the genesis anchor; it must publish non-zero roots
before any bridge_mint can prove membership.

- [ ] **Prover → settler**: produce the first reflection proof; submit
      `attestBitcoinStateProven(publicValues, proofBytes)`.
- [ ] Assert reflection advanced off genesis and the cross-chain roots are live:
  ```sh
  GEN=$(cast call $POOL 'REFLECTION_GENESIS_DIGEST()(bytes32)' --rpc-url $RPC)
  cast call $POOL 'knownReflectionDigest()(bytes32)' --rpc-url $RPC   # != $GEN
  cast call $POOL 'lastRelayHeight()(uint64)' --rpc-url $RPC          # > 0
  cast call $POOL 'knownBitcoinRoot(bytes32)(bool)' <attested pool root> --rpc-url $RPC  # true (from BitcoinRootAttested)
  cast call $POOL 'knownBitcoinBurnRoot()(bytes32)' --rpc-url $RPC    # != 0  (bridge_mint authority)
  cast call $POOL 'knownBitcoinSpentRoot()(bytes32)' --rpc-url $RPC   # != 0  (cross-lane gate)
  ```
  Gates exercised: relay-anchored header chain + PoW + maturity, monotone height, append-only
  digest chain, non-zero pool/spent/burn-root sentinels, `ethPoolReflected == this pool`.

## Phase 2 — Onboard TAC + deploy the canonical ERC20 (attest_meta)

- [ ] **Preflight**: compute the address the pool will deploy to and confirm nothing is there yet:
  ```sh
  PREDICTED=$(cast call $FACTORY 'predict(bytes32,address,string,uint8,bytes32)(address)' \
              $TAC $POOL "TAC" 18 $TAC_CID --rpc-url $RPC)
  cast call $POOL 'canonicalTokenFor(bytes32)(address)' $TAC --rpc-url $RPC   # == 0 (not yet onboarded)
  cast code $PREDICTED --rpc-url $RPC                                          # == 0x (not yet deployed)
  ```
- [ ] **Prover → settler**: prove TAC's etch metadata (`OP_ATTEST_META`); submit `settle` with
      `pv.assetMetas = [{assetId: TAC, ticker, tickerLen, decimals, cid}]`.
- [ ] Assert the ERC20 deployed at the predicted address, pool-backed, etch-bound:
  ```sh
  cast call $POOL 'canonicalTokenFor(bytes32)(address)' $TAC --rpc-url $RPC   # == $PREDICTED
  cast call $PREDICTED 'MINTER()(address)' --rpc-url $RPC                      # == $POOL  (sole mint authority)
  cast call $PREDICTED 'ASSET_ID()(bytes32)' --rpc-url $RPC                    # == $TAC
  cast call $PREDICTED 'symbol()(string)' --rpc-url $RPC                       # == "TAC"
  cast call $PREDICTED 'decimals()(uint8)' --rpc-url $RPC                      # == 18
  LOCAL=$(cast call $POOL 'localAssetOf(bytes32)(bytes32)' $TAC --rpc-url $RPC)  # != 0  (shared→local link)
  cast call $POOL 'getAsset(bytes32)((bool,address,uint256,bytes32,bool,string,string,uint8))' $LOCAL --rpc-url $RPC
  #   ↑ poolMinted == true; underlying == $PREDICTED; unitScale == 10^(18 − tacitDecimals)
  ```
  Idempotent — re-running attest_meta for TAC is a no-op (skipped once registered).

## Phase 3 — Bridge a TAC note in (bridge_mint)

- [ ] **On Bitcoin**: burn a TAC note for the bridge (`OP_ENV_CONF_BURN`), bound to the Ethereum
      destination commitment. For a **pre-existing** TAC note this uses the burn-deposit onboarding
      (provenance walk from the etch supply note `C_0`, the post-re-prove path). For a TAC note
      **created within the live reflection window**, the reflected-note bridge-out path applies.
- [ ] **Prover → settler**: produce the next reflection batch folding that burn; submit
      `attestBitcoinStateProven`. Assert `knownBitcoinBurnRoot` advanced (now includes ν → dest).
- [ ] **Prover → settler**: prove `OP_BRIDGE_MINT`; submit `settle` with
      `pv.bitcoinBurnsConsumed=[ν]`, `pv.bitcoinBurnRoot=<current burn root>`,
      `pv.bitcoinRootsUsed=[<pool root>]`, `pv.leaves=[dest_leaf]`.
- [ ] Assert the mint fired once, bound to the burn, and created an Ethereum-homed note:
  ```sh
  cast logs --address $POOL 'BridgeMinted(bytes32)' --from-block <settle blk> --rpc-url $RPC   # ν present
  cast call $POOL 'bridgeMinted(bytes32)(bool)' <ν> --rpc-url $RPC      # true (one-mint-per-burn)
  cast call $POOL 'nextLeafIndex()(uint256)' --rpc-url $RPC             # +1
  cast call $POOL 'isNullifierSpent(bytes32)(bool)' <ν> --rpc-url $RPC  # true (shared EVM namespace)
  ```
  In-proof (not re-checkable on-chain, enforced by the verified circuit): `v_mint == v_burn`,
  same asset, membership in the bridge-burn set with leaf binding `ν → dest_leaf`.

## Phase 4 — Unwrap to the public ERC20 (the "mint TAC on Ethereum" moment)

- [ ] **Prover → settler**: prove `OP_UNWRAP` spending the bridged note; submit `settle` with
      `pv.withdrawals = [{assetId: TAC, recipient, value}]` (the pool resolves the shared id to the
      local entry and pays `value · unitScale`).
- [ ] Assert the public ERC20 is now held and supply == the unwrapped value (no inflation):
  ```sh
  cast call $PREDICTED 'balanceOf(address)(uint256)' <recipient> --rpc-url $RPC   # == value · unitScale
  cast call $PREDICTED 'totalSupply()(uint256)' --rpc-url $RPC                     # == that amount
  cast logs --address $POOL 'Withdraw(bytes32,address,uint256)' --from-block <blk> --rpc-url $RPC
  ```
  The recipient now holds tradeable, Uniswap-able TAC ERC20.

## Phase 5 — Re-wrap (public → confidential, inside the pool)

- [ ] **User**: `wrap($LOCAL, amount, cx, cy, owner)` — for a pool-minted asset, `wrap` **burns** the
      ERC20 from the caller (no approve/escrow). Use `$LOCAL` (= `localAssetOf(TAC)`), since `wrap`
      reads the local registry key directly. `amount` must be a multiple of `unitScale`.
- [ ] Assert the ERC20 was burned and a deposit is pending:
  ```sh
  cast call $PREDICTED 'balanceOf(address)(uint256)' <caller> --rpc-url $RPC    # decreased by amount
  cast call $PREDICTED 'totalSupply()(uint256)' --rpc-url $RPC                   # decreased by amount
  # depositId = keccak256(abi.encode($LOCAL, amount/unitScale, cx, cy, owner))
  cast call $POOL 'depositStatus(bytes32)(uint8)' <depositId> --rpc-url $RPC      # == 1 (pending)
  ```
- [ ] **Prover → settler**: prove the deposit consumption; `settle` with
      `pv.depositsConsumed=[depositId]`, `pv.leaves=[note]`. Assert `depositStatus == 2` and
      `nextLeafIndex` +1. The value is now a confidential, Ethereum-homed note again.

## Phase 6 — Bridge back to Bitcoin (crossOut)

- [ ] **Prover → settler**: prove `OP_BRIDGE_BURN` spending the confidential note; `settle` with
      `pv.crossOuts=[{destChain, destCommitment, nullifier: ν, assetId: TAC, claimId}]` and ν in
      `pv.nullifiers`.
- [ ] Assert the burn-back instruction is recorded and the source note consumed:
  ```sh
  cast logs --address $POOL 'CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)' --from-block <blk> --rpc-url $RPC
  cast call $POOL 'crossOutCommitment(bytes32)(bytes32)' <claimId> --rpc-url $RPC   # == destCommitment
  cast call $POOL 'isNullifierSpent(bytes32)(bool)' <ν> --rpc-url $RPC              # true
  ```
  On-chain gates: `claimId` re-derived on-chain (non-malleable), ν must be spent in-batch, the
  source note must be Ethereum-homed (a bridged-in note qualifies after Phase 5).
- [ ] **Worker**: the crossout-consumer honors the claim on Bitcoin once past finality — confirm the
      destination note appears on the Bitcoin side and the round-trip value matches the original burn.

## Invariants to watch across the whole run

- [ ] `evmNullifiersSpent ≤ nextLeafIndex` holds after every settle (no-inflation floor).
- [ ] TAC ERC20 `totalSupply` at any moment == outstanding **unwrapped** value: 0 before Phase 4,
      `value` after Phase 4, 0 again after Phase 5 (the re-wrap burns it). No unbacked supply.
- [ ] Each nullifier appears spent exactly once; a replayed proof reverts (`NullifierAlreadySpent`
      / `BurnAlreadyMinted`).
- [ ] No `settle` carrying a Bitcoin-homed spend also moves value onto Ethereum
      (`BtcHomedValueExitMustBridge` is the backstop) — only the bridge_mint path crosses value in.

Related: `CHECKLIST-mainnet-reprove.md` (the re-prove ceremony this assumes), `DESIGN-trustless-asset-onboarding.md`
(the burn-deposit provenance dispatch), `RUNBOOK-confidential-modeb-roundtrip.md`.
