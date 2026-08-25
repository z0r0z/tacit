# TACIT V1 CUTOVER RUNBOOK — freeze-ready state (2026-08-25)

Both substantive code/crypto blockers are **closed and on main** (`28b19dbe`). This runbook sequences the
only remaining work: the deploy ceremony itself. Everything below the "Frozen" line is finalized; everything
in "Cutover sequence" is done live at the deploy moment. For the full deploy body (prover-bins, worker
repoint, dapp/IPFS), this defers to `ops/RUNBOOK-redeploy-v3.md` §POST-DEPLOY — that mechanics is unchanged;
only the crypto/config values below supersede it.

---

## FROZEN — finalized, do not touch (verify, don't regenerate)

| Thing | Value |
|---|---|
| Commit | `28b19dbe` (main) |
| `PROGRAM_VKEY` (settle) | `0x006d3829f26c02ff743f291fce38de9997ef619c0c3d820792cc89d98a942dcf` |
| `BITCOIN_RELAY_VKEY` (reflection) | `0x0072c95703e5bd1d6aaa167ec5296f4ba8030a61b066eaee7aa77d97867b9037` |
| `eth_reflection_vkey` | `0x00d5e2a31b22a8f7741bf1d8ae6823e3b162b842be1c42a1fe5ea7f837827ea4` |
| `ETH_CALL_OUTBOX` | `0x00000000002c40c367ed873136e17151652de080` (salt in `vanity-salts-launch-permissioned.env`) |
| Reflection ELF sha256 | `4a7651698a83171e281dcfa5ef96fcf943f8707377a0b2ec2e3a702f0df36711` |
| `lockstep_checkpoint` | `244880529bcfdce37d263305bde8249c3c9cc67431134ed11eba31be045fcf24` |
| Pool size | 24,003 B (573 under EIP-170) |
| Engine owner | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` (Safe, verified live) |
| Chainlink feeds | ETH/USD `0x5f4eC3Df…8419`, BTC/USD `0xF4030086…E88c`; staleness 3900s (verified live) |
| Ratios | escrow 1.5× / cdp 1.5× / liq 1.3×; deviation + stability-fee + enforcement all **dormant** |

**Green gates (all currently pass, re-run before broadcast):**
```sh
cd contracts/sp1/confidential && bash verify-lockstep-pins.sh && bash verify-vkey-pin.sh   # no ALLOW_UNPINNED_OUTBOX
cd ../../.. && cd contracts && forge test --match-path "test/Confidential*ProofReal.t.sol" \
  --no-match-test "tampered|wrong_vkey|rejected|selector"                                  # 92/92
```

---

## PRE-FLIGHT — no chain writes (T-minus)

```sh
export RPC=https://ethereum-rpc.publicnode.com
export DEPLOYER=0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7
export PRED=0x00000000000f5DE1295Ab2F0649fDE3855b66020    # currently-live pool (superseded on cutover)
```

**P-1. Pick the canonical deploy env + salt set.** `redeploy-v3.env` (round-3 salts) vs
`vanity-salts-launch-permissioned.env` (V1-launch salts) — confirm which is the intended launch set with the
team. Whichever it is: its `PROGRAM_VKEY`/`BITCOIN_RELAY_VKEY` MUST already equal the FROZEN values above
(the deploy `require`s `PROGRAM_VKEY == elf-vkey-pin.json`). `SALT_ETH_CALL_OUTBOX` is present + address-verified.

**P-2. Dry-run (asserts vanity addresses, O-1/L-1, EIP-170 headroom):**
```sh
cd contracts && source deployments/<chosen>.env
forge script script/DeployV1SuiteCreateX.s.sol:DeployV1SuiteCreateX --rpc-url $RPC --sender $DEPLOYER
```
Must print all core vanity addresses matching the salts file and "Script ran successfully." Eyeball each
0x0000000000… prefix (the script's hard guard is only 4 zero bytes; the exact addresses are the real check).

---

## CUTOVER SEQUENCE — ordered, chain-touching

### 1 — Predecessor-inert gate (do FIRST; the only gate that can force a wait)
The successor accepts value only after every superseded pool is drained (one-funded-generation, C-01/C-02).
Publicly checkable. Per registered asset on **each** pool in the lineage (`$PRED` and any earlier live pool):
```sh
cast call <underlying> "balanceOf(address)(uint256)" $PRED --rpc-url $RPC   # == 0
cast balance $PRED --rpc-url $RPC                                           # native-ETH escrow == 0
cast call <canonicalToken> "totalSupply()(uint256)" --rpc-url $RPC          # == 0 (incl. predecessor-engine cUSD)
cast call $PRED "farmTreasury(address)(uint256)" <controller> --rpc-url $RPC # == 0
```
ALL zero ⇒ proceed. Any non-zero ⇒ STOP and drain first.

### 2 — Re-derive the near-tip reflection seed (guest changed this round → indexer parity first)
The `@958735` values in `redeploy-v3.env` are stale-dated. At cutover, against the LIVE relay tip:
- The outbox change rotates only the vkey — it does NOT affect forward-scan digests (confirmed: `reflect-local`
  MATCH on the forward + burn-deposit fixtures). So the seed-derivation method is unchanged; only the height moves.
- Still, confirm guest↔JS indexer agree on the seed digest at the chosen near-tip BEFORE baking it:
  fold `nearseed-kv-*.json` forward the small delta to `relay tip − 6`, then set
  `REFLECTION_RESUME_DIGEST` + `GENESIS_REFLECTION_ANCHOR` in the env to match. The anchor must be a
  relay-KNOWN header (`DeployV1SuiteCreateX` asserts `RELAY.blockHeight(anchor) != 0`).

### 3 — seedAnchorHistory cross-check
Cross-check the BTC genesis anchor + its 10 ancestor hashes/timestamps (`ANCHOR_*` env) against **two**
independent explorers before broadcast. The deploy-time genesis-timestamp / target / tip-hash consistency
`require`s (`Deploy.s.sol:43-46`) fire automatically, but the ancestor set is operator-supplied — verify it.

### 4 — Broadcast
```sh
forge script script/DeployV1SuiteCreateX.s.sol:DeployV1SuiteCreateX \
  --rpc-url $RPC --broadcast --slow --private-key <box NETWORK_PRIVATE_KEY> --verify
```
One broadcast lands: ReflectionLib (forge auto-deploy + link; the script `require`s it carries code before
the pool deploy, since a mis-link would leave the immutable pool's attest path inert forever) → engine + adapter → pool → `setFeeds`/`setParams`/`setPool`/
`transferOwnership` → router + relayer + btcCallExecutor + ethCallOutbox. Writes
`contracts/deployments/1-createx.json`.

### 5 — Post-deploy pins + confirm + bootstrap
```sh
export POOL=<new pool> ENGINE=<new engine>
cast storage $POOL 80 --rpc-url $RPC                  # == REFLECTION_RESUME_DIGEST (knownReflectionDigest)
cast call $ENGINE "POOL()(address)" --rpc-url $RPC    # == $POOL  (M-01 reciprocal bind)
cast call $ENGINE "owner()(address)" --rpc-url $RPC   # == 0x006CD14F…
```
- **Record the ReflectionLib address** from the broadcast (forge deploys and links it from the broadcaster's
  nonce — it is the one core address that is NOT CREATE3'd, so it differs per chain and per rerun) and put it
  in `foundry.toml` `libraries` for reproducible verification builds. `verify-pool-size.sh` needs no re-pin:
  it hashes the LINK-NORMALIZED runtime plus the pinned link-reference set, so it is green both before and
  after linking, and a change to WHAT the pool links fails it loudly.
- **Reflection bootstrap** (`ops/RUNBOOK-redeploy-v3.md` §14): edit `tools/reflection-bootstrap-v2.mjs`
  top-of-file consts (POOL / GENESIS_HEIGHT / RESUME_DIGEST / GENESIS_ANCHOR) to the new pool + this round's
  near-tip seed, then `--dry-run` → `--batches=1` → `--to=<tip>`. **First attest must be the ≤6-block
  incremental fold**, never the multi-hundred-block trap, or it reverts `StaleReflectionDigest`.
- Then §15-18: worker repoint, manifest + dapp regen (`tools/sync-deployment-config.mjs`), dapp bundle + IPFS
  pin, commit env + manifest + generated config + docs together.

---

## GO/NO-GO — all green before broadcast
- [ ] `verify-lockstep-pins.sh` green (no `ALLOW_UNPINNED_OUTBOX`) · `verify-vkey-pin.sh` green
- [ ] 92/92 `*ProofReal` on-chain verify · `verify-pool-size.sh` green (size + link references + identity)
- [ ] Dry-run prints exact vanity addresses + O-1 (real relay, not PoW-disabled subclass) + L-1 (MAX_TARGET, genesis)
- [ ] Predecessor lineage fully drained (step 1)
- [ ] Near-tip seed re-derived at live tip, guest↔indexer agree, anchor is relay-known (step 2)
- [ ] seedAnchorHistory cross-checked on 2 explorers (step 3)
- [ ] Deploy env `PROGRAM_VKEY`/`BITCOIN_RELAY_VKEY` == FROZEN values

Immutable pool has no owner/pause/upgrade: a wrong vkey or wrong outbox is a full redeploy, never a fix.
That is why every FROZEN value above is independently re-derivable and gate-checked before the one broadcast.
