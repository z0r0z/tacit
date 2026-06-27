# Tacit Farm-Hardening Audit Pass - 2026-06-27

This is a focused fund-critical pass over the farm-hardening / reflection-readiness surface requested in
`AUDIT-2026-06-27-ultracode-opus48-farm-hardening.md`. It is **not a final mainnet sign-off**: the pass found
deployment-blocking reflection artifact drift that must be fixed and re-tested before any release candidate can be
considered.

## Scope

| Group | Scope Read | Result |
| --- | --- | --- |
| A. Solidity value authority | `ConfidentialPool.sol`, `CollateralEngine.sol`, `FarmController.sol`, deploy scripts, `BitcoinLightRelay.sol`, size config | One high deployment-script gap; cross-lane / bridge-mint / CDP / cBTC gates tested clean |
| B. SP1 settle guest | `contracts/sp1/confidential/src/main.rs` public values and bridge/cross-lane arms | PublicValues ABI matches Solidity; bridge mint/stealth gates traced |
| C. SP1 reflection guest | `contracts/sp1/confidential/src/reflect.rs` farm resume + Mode-B read order | **Blocking stale ELF/vkey vs current source/serializer** |
| D. `cxfer-core` | `ScanReflection::digest/genesis`, farm reward state, farm owner auth, bridge helpers | Genesis pins pass; farm owner auth now binds output blinding |
| E. Prover host / serializers / pins | `reflect-stdin`, `reflect-exec`, `elf-vkey-pin.json`, pin scripts, fixtures | Pin script passes but misses source->ELF drift; execute-mode farm fixture fails |
| F. Crypto primitives | BP+/BIP340/AMM/farm JS math sampled; dedicated `/audit-bpp` skill was unavailable in this session | No BP+ sign-off in this pass |
| G. JS mirror | `confidential-pool.js`, farm lifecycle fixture generator, AMM/farm tests | JS farm/AMM tests pass; mirror matches current source, not pinned ELF |

## Findings

### 1. FUND-CRITICAL: Pinned reflection ELF/vkey is stale against current farm-resume serializer; farm-state reflection proofs brick

**Evidence**

- Current reflection guest reads resumed farm entries with `launcher_pubkey` and `lp_asset` before `mode_b`:
  `contracts/sp1/confidential/src/reflect.rs:198-207`.
- Current shared serializer writes the same extra farm fields:
  `contracts/sp1/reflect-stdin/src/lib.rs:279-311`, then writes `modeB` at `:314-343`.
- Current JS assembler emits `farmRewards` in the prior state and `modeB: 0` for forward batches:
  `dapp/confidential-pool.js:1398-1409` and `:1727-1733`.
- The pinned ELF was not rotated when this ABI changed. `git log` shows `reflect-stdin` changed in `02fce0d`
  without `contracts/sp1/confidential/elf/reflection-prover`; the ELF/pin last changed at `82ee3ef`.
- Strict pin check still passes:
  `VERIFY_VKEY_STRICT=1 bash verify-vkey-pin.sh` passed both ELF sha pins and Groth16 fixture vkeys.
- But execute-mode parity fails against both the committed and regenerated farm lifecycle fixture:
  `cargo run --release --manifest-path contracts/sp1/reflect-exec/Cargo.toml --bin reflect-execute -- contracts/sp1/confidential/fixtures/reflection_farm_lifecycle.json`
  panics at `reflect.rs:310` with `eth-reflection public values too short`. The same failure occurs for a regenerated
  `/tmp/reflection_farm_lifecycle.regen.json`.

**Exploit / brick scenario**

Once the reflected Bitcoin state contains a farm reward entry (`n_farms >= 1`), the current prover host writes the
new farm-resume fields, but the pinned reflection ELF apparently does not consume them. The ELF then reads leftover
farm bytes as `mode_b != 0`, attempts to read an eth-reflection PV that was never written for the forward batch, and
panics. That makes `attestBitcoinStateProven` proofs unproducible for farm-bearing states. Under the stated threat
model, a wedged reflection attester halts settlement and bridge withdrawals, so this is fund-critical.

**Fix**

Pick one ABI and make all immutable artifacts agree:

- Preferred: rebuild/re-prove `reflection-prover` from current `reflect.rs` + `cxfer-core` source, update
  `contracts/sp1/confidential/elf/reflection-prover`, `reflection_elf_sha256`, `bitcoin_relay_vkey`, and all
  reflection Groth16 fixtures in one commit; redeploy `ConfidentialPool` with the new `BITCOIN_RELAY_VKEY`.
- Also add a readiness gate that runs `reflect-exec` over `reflection_farm_lifecycle.json` and any other non-empty
  resume fixtures, and make `verify-vkey-pin.sh` strict mode derive or otherwise bind source->ELF/vkey, not only
  ELF->pin.
- Alternative: revert `reflect.rs`, `reflect-stdin`, JS mirror, and farm fixtures to the old pinned ELF ABI.

**Verified**

Reproduced end-to-end with the pinned ELF and the shared stdin serializer. The failure occurs before public values are
committed (`pv_bytes=0`), so this is not a Solidity decode issue.

### 2. HIGH: Mainnet V1 deploy path can omit immutable tETH link / reflection guards

**Status:** Remediated after this pass in `contracts/script/DeployV1Suite.s.sol` and
`contracts/deploy-v1-suite-mainnet.sh`. The original evidence below records the pre-fix state.

**Evidence**

- `DeployV1Suite.s.sol` only checks `BITCOIN_RELAY_VKEY` against the pin when it is nonzero:
  `contracts/script/DeployV1Suite.s.sol:222-224`.
- Its defaults include a stale program vkey, zero relay vkey, and zero `TETH_BITCOIN_ID`:
  `contracts/script/DeployV1Suite.s.sol:241-251`.
- The CreateX deploy script has the missing mainnet fail-closed guards for `TETH_BITCOIN_ID` and reflection:
  `contracts/script/DeployV1SuiteCreateX.s.sol:111-123`.
- The documented mainnet shell uses `DeployV1Suite.s.sol`, requires no `TETH_BITCOIN_ID`, and does not export it:
  `contracts/deploy-v1-suite-mainnet.sh:22-25`, `:34-44`.
- `ConfidentialPool` pins native ETH's cross-chain link only in the constructor:
  `contracts/src/ConfidentialPool.sol:767-775`; later native-ETH registration rejects nonzero links at `:834-838`.

**Exploit / brick scenario**

A mainnet operator can run the non-CreateX V1 deploy path without `TETH_BITCOIN_ID`; the immutable pool then has no
tETH<->cETH/native-ETH link. If the tETH lane is later exposed operationally, users can end up with a deployment that
cannot resolve the intended native ETH bridge lane without redeploying a new generation. Direct use of
`DeployV1Suite.s.sol` can also deploy mainnet with reflection disabled (`BITCOIN_RELAY_VKEY == 0`) unless external
scripts happen to set it.

**Fix**

Port the CreateX guards into `DeployV1Suite.s.sol`: on `chainid == 1`, require nonzero pinned
`BITCOIN_RELAY_VKEY` unless `ALLOW_NO_REFLECTION=1`, and require nonzero `TETH_BITCOIN_ID` unless
`ALLOW_NO_TETH_LINK=1`. Add `TETH_BITCOIN_ID` to `deploy-v1-suite-mainnet.sh` required env and export
`VERIFY_VKEY_STRICT=1` for the pin check. Update stale defaults to the current pin or remove them from mainnet paths.

**Verified**

Side-by-side read of both deploy scripts and the pool constructor/registration path.

### 3. INFORMATIONAL: Pool EIP-170 margin is now 17 bytes, and the size comment is stale

**Status:** Comment remediated after this pass in `contracts/foundry.toml`. A CI gate that parses deployable contract
sizes explicitly remains a recommended follow-up.

**Evidence**

- `contracts/foundry.toml:5-10` says the pool is 24,557 B, 19 B under EIP-170 at optimizer runs 1.
- `forge build --sizes` reports `ConfidentialPool` runtime size **24,559 B**, margin **17 B**.
- The command exits nonzero because standalone `PoseidonT3`/`PoseidonT4` artifacts exceed EIP-170; the pool itself
  still fits.

**Impact**

Not an exploit, but any tiny pool edit can make the immutable value authority undeployable. A readiness gate that only
looks at `forge build --sizes` exit status may also fail because of non-deployed oversized library artifacts.

**Fix**

Update the comment and CI gate to parse the `ConfidentialPool` runtime size explicitly and fail on a small threshold
or any negative margin for deployable contracts.

**Verified**

`forge build --sizes` completed and printed the current byte sizes.

## Verified Closures

- **PublicValues ABI:** Solidity `PublicValues` order at `ConfidentialPool.sol:557-588` matches the Rust `sol!`
  struct at `main.rs:143-173`.
- **btcHomed cross-lane gate:** `_settle` resolves Bitcoin-homed roots and pins the current spent root at
  `ConfidentialPool.sol:1672-1688`; it bars bridge burns at `:1708`; it enumerates value-bearing fields and records
  every consumed nullifier into `bitcoinConsumed` / `bitcoinConsumedAt` at `:1736-1785`.
- **Bridge mint inflation gate:** guest bridge mint proves Bitcoin pool membership, dedicated burn-set membership
  keyed by `nu -> dest_leaf`, range, and conservation at `main.rs:567-650`; stealth mint does the same for lock leaves
  at `main.rs:652-761`. The contract pins current burn root at `ConfidentialPool.sol:1802-1805`, enforces one-mint per
  burn and burn/root alignment at `:1971-1983`, and reserve floor accounting at `:1940-2002`.
- **Fast-lane / Mode-B freshness:** source-level checks are present: guest Mode-B anchoring at `reflect.rs:310-373`,
  consumed fold completeness at `:418-442`, JS mirror at `confidential-pool.js:1404-1433`, and contract freshness at
  `ConfidentialPool.sol:1485-1531`. This closure is conditional on fixing Finding 1.
- **Reflection storage slots:** `bash sp1/confidential/verify-reflection-slots.sh` passed and matched
  `CROSSOUT_SLOT_INDEX=76`, `CONSUMED_SLOT_INDEX=119`, `CONSUMED_COUNT_SLOT_INDEX=120`,
  `CONSUMED_AT_SLOT_INDEX=163`.
- **Vkey pin file:** `VERIFY_VKEY_STRICT=1 bash verify-vkey-pin.sh` passed for committed ELF hashes, pinned vkeys, and
  committed Groth16 fixture vkeys. This does not close source->ELF drift; see Finding 1.
- **BitcoinLightRelay:** constructor/advance/retarget/finality tests passed: `forge test --match-path
  test/BitcoinLightRelay.t.sol` => 23/23.
- **CDP / cBTC contract gates:** `forge test --match-path test/ConfidentialCdpCbtcSettle.t.sol` => 34/34.
- **AMM / farm JS math:** `node tests/amm-clearing.test.mjs` => 31/31, `node tests/amm-clearing-properties.test.mjs`
  => 13/13, `node tests/amm-farm.test.mjs` => 100/100.
- **Cross-lane Solidity tests:** targeted `ConfidentialPool.t.sol` regex for PublicValues, bridge mint, btc-homed, and
  fast-lane tests => 26/26.
- **Genesis pin:** `cargo test genesis_digest_matches_contract_constant` and
  `cargo test scan_reflection_genesis_digest` both passed in `cxfer-core`.

## Residual Risk / Sign-Off

No deployment sign-off yet. Finding 1 is a release blocker and must rotate the reflection ELF/vkey or revert the
serializer ABI before any mainnet deployment; this was intentionally left for the pending reprove. Finding 2 was fixed
in the non-CreateX V1 deploy path. BP+ and the full crypto layer were not exhaustively re-audited here because the
requested `/audit-bpp` skill was unavailable in this session; run that dedicated review before final fund-critical
sign-off.
