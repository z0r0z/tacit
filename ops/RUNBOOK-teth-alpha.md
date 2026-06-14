# tETH alpha (generation 1) — ship runbook

Execution checklist for deploying the alpha bridge generation. Design rationale
is in `PLAN-teth-fresh-deployment.md`; this is the ordered operational sequence.
Roles: **(you)** = Docker build env + mainnet deployer keys; **(me)** = code I
land on the branch / on main when its inputs are ready.

Preconditions (done): LOCK-4 + LOCK-3 on branch `teth-gen1`, guest compiles, 11
unit tests pass, two independent security reviews clean, recovery-path fix in.

## Step 1 — §8 Stage-1 security gate (you, Docker) — the must-pass

Run the real-proof suite against the alpha guest. It must pass, including the
two new behaviours:
- a real proof carrying a **fabricated recent-roots window is rejected**
  on-chain (the LOCK-4 anchor);
- a **cross-denom redeem** (same preimage, two denominations) is **accepted**
  for both (the LOCK-3 fix).

The unit checks in the guest pin the logic; this proves it end-to-end. **Do not
proceed past this step until it's green** — it's the gate before blessing the
vkey.

**Status (2026-06-06, run on `teth-gen1` @ 48c6720):**
- ✅ real-proof suites (`Groth16VerifierReal` + `BridgeWithdrawRealProof`): 6/6
- ✅ full contract suite (`forge test --no-match-test invariant`): 96/96
- ✅ guest §8 unit checks (LOCK-3 cross-denom spendability, LOCK-4 window
  anchoring/push + genesis-window, mint-only reserve, dispatch seams): 11/11
- ✅ ELF sha pin (`0733309b…`); ELF→vkey binding confirmed transitively (the
  box-derived vkey `0x000d5dfb…` is the deployed verifier's constructor arg
  in the broadcast record)
- The fabricated-window rejection is pinned at the guest layer (unit checks)
  plus the verifier's state-commitment chain in the contract suite; a literal
  adversarial SP1 proof against the live verifier is not automated — the
  tiny-cap live stage (step 5) is the remaining end-to-end exercise.

## Step 2 — canonical ELF + vkey (you, Docker)

`cd contracts/sp1 && ./build-guest.sh` (needs Docker, per the script header).
Record the printed **vkey**; confirm the committed ELF sha256 matches
`elf-vkey-pin.json`. The vkey feeds the verifier constructor.

## Step 3 — deploy alpha contracts (you, mainnet)

Deploy, in order, recording each address:
1. `BitcoinLightRelay` — fresh genesis anchor at a retarget-safe BTC block.
2. `SP1PoolRootVerifier` — constructor args: the step-2 vkey, the canonical
   Groth16 burn-verifier, **`ASSET_ID = 3cba71e1…`** (same asset), the relay,
   the mixer (deploy order / CREATE2 as the existing deploy script handles).
3. `TacitBridgeMixer` — bound to the verifier; `ASSET_ID = 3cba71e1…`.

Verify all three on Etherscan. Keep deposits **closed** at this point (no ops
yet). Hand me the three addresses + the deploy BTC block + the vkey.

## Step 4 — multigen continuity (me, then you deploy) — BEFORE any alpha op

This is the gen-0 safety gate: alpha reuses the asset_id, so the indexer must
distinguish generations before alpha generates a single bridge op. Today the
bridge pool key is `pool:${network}:${aid}:${denom}` (worker `index.js:913`) —
no generation dimension — so alpha's first op would write to **gen-0's exact KV
record** and break gen-0 redeem-proof building.

The change (all backward-compatible — gen-0/pilot maps to a falsy `gen`, so its
keys stay byte-identical and it indexes unchanged):
- a **generation registry** `{verifier, mixer, chain_id, genesis, label}` for
  pilot + alpha;
- a **`gen` segment** in the pool / leaf / nullifier keys, falsy for pilot;
- **attribution by authoritative on-chain state, not hash replication**: a new
  deposit is attributed to the generation whose mixer accumulator recognizes its
  `eth_root` (one cached `eth_call` per candidate mixer — robust, and avoids
  re-deriving the contract's exact bind-hash preimage). The pool it creates is
  tagged with that generation; every later op on that pool inherits the
  generation by matching its `poolRoot` to that pool's proven-root history.
- the dapp `TETH_DEPLOYMENTS` registry + routing + merged tETH balance.

Why this lands at step 4, not earlier: attribution must be **tested against the
real alpha accumulator** (its `eth_root` membership), which doesn't exist until
step 3 deploys the mixer. Building it blind against a not-yet-deployed contract
is exactly the untestable-code risk we avoid — so the design is locked here, the
implementation + its unit/integration test run once alpha's address is in hand.

- **(me)** implement + test against the deployed alpha mixer.
- **(you)** deploy that worker **before opening alpha deposits**.
- Confirm gen-0 still indexes unchanged (byte-identical keys) and `/pools` now
  carries a generation per pool.

**Status: worker side DONE.** Attribution landed differently than sketched
above — every bridge envelope's `bind_hash` already commits to
`(chain_id, mixer_address)` (it is the guest's own first routing gate), so the
worker recomputes the guest's exact bind hash per registry generation and
routes on the match; deposits are additionally confirmed against the matched
mixer's `isKnownDepositRoot` (transient RPC failure stops the scan before the
block and retries next tick rather than skipping a leaf). This replaced the
burn decoder's older bind-hash variant, which used a narrower preimage — so
burn records start indexing with this deploy. Validated against every live
mainnet deposit/export envelope and both mixers:
`node tests/bridge-multigen.test.mjs` (26 checks).

Post-deploy sequence — **DONE 2026-06-06** (versions f0e89757 + f91f2810):
1. ✅ `wrangler deploy`; gen-0 `/pools` confirmed unchanged (4 leaves / 3
   nullifiers).
2. ✅ Historical burn backfill — done via the hint path instead of a rescan
   (mainnet scans 1 block/tick, so a 430-block rewind would have paused new-op
   indexing for ~36h). The hint endpoint now indexes burn nullifiers with the
   same attribution + dedup as the cron scan; the one mainnet burn
   (`a22fbe52…`, height 952190, recovered from the claim calldata on the
   gen-0 mixer) is indexed. Future missed ops can be hinted the same way.
3. ✅ `tests/bridge-multigen.test.mjs` re-run green against the deployed
   worker (26/26).

**Dapp routing status: DONE** (op layer + UI surfaces). Generation context
threads through bind hashes, pool trees, scanPools, all five builders, the
ETH claim, recovery, and supply stats; records are stamped and stored under
per-mixer keys; the bridge modal / note lists / resume / repair surfaces read
the merged generation views and write records at their home generation;
rotate/import note recovery is per-generation; a manually-resumed burn
recovers its generation from the envelope bind hash. Active generation stays
the pilot, so behavior is unchanged until the step-6 flip — which is now a
registry edit (alpha `live: true`, top-level fields → alpha) plus the
blessed-vkey set.

## Step 5 — live tiny-cap round-trip (you + me)

Open alpha with **tiny caps** (a few dollars total). Run end-to-end:
deposit → mint → export → import → redeem (exercises the window). Then the
**cross-generation test**: a deposit on alpha + a redeem on gen-0 in the same
client — confirm the routing table + merged tETH balance.

## Step 6 — bless + open

Only after steps 1 + 5 are green: add alpha's vkey to the recognized
(blessed) set, set pilot to redeem-only, point deposits at alpha, raise caps.

## Standing rules

- **Gen-0 stays redeemable** throughout — its prover must remain runnable (run
  both, or on demand; it's permissionless). Its tETH is unaffected by alpha.
- **Multigen before first alpha op** (step 4 before step 5) — non-negotiable
  given the shared asset_id.
- **Rollback**: a bug found live is bounded by the tiny caps and superseded by
  the next generation (append to the registry, abandon the small balance). No
  in-place fix needed; that's the per-generation model working.
