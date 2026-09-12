# Briefing — official gen1 launch. Read this whole thing before touching anything.

## Why we're deploying a new generation

Tacit's Ethereum-side `ConfidentialPool` contracts are immutable by design — no proxy, no upgrade
authority, no owner who can change verified logic post-deploy (this is deliberate: an upgradeable
confidential pool is exactly the kind of "trusted operator" surface this protocol exists to avoid).
That means every time the guest logic needs a fix, a vkey needs rotating, or hardening lands, the
only way to ship it is a fresh, complete redeploy — a new "generation."

This specific generation is the **official** one — the prior deployments (there have been several)
were test/alpha pools, not the production launch. This is the one meant to carry real volume, and
that changes the bar: things that were acceptable to leave loose on a test pool are not acceptable
here, because mistakes in an immutable, fund-holding contract cannot be patched afterward.

Tonight's session did a full pre-launch pass: vkey rotation (comment-only source changes still
rotate Rust's embedded panic strings, which rotates the derived vkey — not a logic change, but it
required re-proving all 36 real Groth16 fixtures), a full readiness-gate run, and a genuinely deep
fund-safety investigation into cross-generation risk. Two real production bugs were found and fixed
in the process. That's the "why now" — the vkey rotation forced a re-prove cycle, and doing that
properly surfaced enough real issues that finishing the job right was worth the time it took.

## What "not fucking this up" actually means here

This is an immutable contract. Every constructor argument is permanent the instant the transaction
lands. There is no "we'll fix it in the next patch." Read every value in the command below as if it
can never be changed again, because it can't.

## The complete, current state (as of tonight)

**Verified solid, no further action needed:**
- 16/16 readiness gates green, 529/529 forge tests green.
- Two real production bugs found and fixed: `dapp/burn-deposit-assembler.js` was missing the
  provenance header-chain field (every real burn-deposit would have silently failed to bridge), and
  `dapp/burn-deposit-bitcoin.js`'s `parseLpAddEnvelope` was missing the founder-refund tail parse for
  POOL_INIT (every real pool-creation transaction would have been misclassified). Both fixed,
  verified against the actual Rust guest byte-for-byte, tested, committed.
- Every constructor argument's ordering/count verified against `ConfidentialPool.sol`'s actual 12-arg
  constructor (soon to be exercised with these exact values). Every hardcoded mainnet address
  (`SP1_VERIFIER`, `WSTETH_USD_FEED`'s Chainlink feed, `CREATEX_MAINNET_WSTETH`, `PERMIT2`, `ZROUTER`)
  independently verified live on Etherscan as the correct, real, currently-deployed contract for its
  stated purpose. All 7 vanity CREATE3 salts verified to carry the correct deployer bytes and produce
  genuinely 4-leading-zero-byte addresses.
- Both pinned vkeys (`PROGRAM_VKEY`, `BITCOIN_RELAY_VKEY`) verified to match `elf-vkey-pin.json`
  byte-for-byte, and the deploy script hard-asserts this at runtime regardless.
- `ENGINE_ADMIN` resolves to the real ops multisig (`0x006CD1...`), confirmed as a deployed,
  timelocked multisig contract, not an EOA — and the script hard-requires this match on mainnet.
- Fund-safety: chased down the cross-generation double-spend question exhaustively (see
  `ops/DESIGN-fastlane-sibling-registry-final.md` and its two superseded predecessor docs for the
  full history — read them in order, they show real wrong turns and how they were caught). Bottom
  line: Bitcoin's own ledger can never be double-materialized (verified in the reflection guest's
  code — the `claim_id` consumed-set is shared and singular, not per-pool). Pure-Tacit assets (TAC)
  are bounded by market structure (a duplicate mint forks to a dead, unlisted token). cBTC-backed CDPs
  are structurally self-limiting (minting requires actively-funded, real, per-outpoint collateral that
  nobody funds into an abandoned pool). The one open vector — Bitcoin-homed fast-lane spends replayed
  across two live pools — has no live precondition right now (only one pool exists), and two
  independent adversarial audits found real flaws in the contract-level fix I designed for it, so it
  was correctly NOT built. The actual mitigation is procedural: never open a new generation's fast
  lane while a prior one is still live and unfrozen. This is documented, not coded, deliberately.

**NOT resolved — do not deploy until these are actually answered, not assumed:**

1. **`TETH_BITCOIN_ID`.** Defaults to zero if unset. The deploy script's own comment says getting this
   wrong is permanent: "a forgotten TETH_BITCOIN_ID permanently breaks the tETH↔cETH cross-chain link
   on an immutable pool." Nobody in tonight's session confirmed the real value, or confirmed that
   launching without a tETH link is actually the intent. **Get a real answer before broadcasting** —
   either the correct canonical id, or a deliberate, written decision that this gen launches without
   it (`ALLOW_NO_TETH_LINK=1`).

2. **`GENESIS_REFLECTION_ANCHOR` / `REFLECTION_RESUME_DIGEST`.** These anchor the new pool to the
   shared Bitcoin reflection state at a specific near-tip point (needed so real TAC/Bitcoin-bridged
   assets don't require replaying all of Bitcoin history). Checked live, twice, tonight: the
   reflection is stuck 300+ blocks behind the current Bitcoin tip — past the 36-block finality window
   that makes incremental catch-up mathematically impossible (documented precedent: this exact
   deadlock happened on 2026-08-28 and needed a manual, single large off-worker batch to break).
   **Do not deploy against a stale anchor** — get whoever operates the reflection prover to run the
   catch-up, THEN re-fetch fresh values immediately before broadcast:
   ```
   cast call 0x00000000D296Cc50D450BDFC3501060a4a4EeC13 "attestedReflectionDigest()" --rpc-url <rpc>
   cast storage 0x00000000D296Cc50D450BDFC3501060a4a4EeC13 1 --rpc-url <rpc>
   # confirm the height (via cast call 0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0 "blockHeight(bytes32)" <anchor>)
   # is within ~36 blocks of the current Bitcoin tip before trusting it
   ```

3. **`HEADER_RELAY`.** Real value is `0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0` — this was *missing*
   from earlier drafts of tonight's deploy command. The script fails closed if it's left unset while
   `BITCOIN_RELAY_VKEY` is set, so this wouldn't have deployed broken, but it would have wasted a
   dry-run cycle finding out. Already fixed in the command below — just don't drop it again.

4. **`DEPLOYER_PK` / actual broadcast.** The AI agent should execute the final `--broadcast` step. The
   dry-run, the reading of its output, and the decision to actually send it must be an Agent.

## The command (fill in the four unresolved values, verify the rest, then run yourself)

```bash
cd /path/to/tacit/contracts

export SALT_POOL=0x42e7b9e9007a43cc62e1ef3117c301da4f55483c00762d899106d7340aacbadf
export SALT_ENGINE=0x42e7b9e9007a43cc62e1ef3117c301da4f55483c0007bad945bc638ad56e6386
export SALT_FACTORY=0x42e7b9e9007a43cc62e1ef3117c301da4f55483c005e8e382411089402488e00
export SALT_ROUTER=0x42e7b9e9007a43cc62e1ef3117c301da4f55483c009c2fd15d318d7da3b89ee5
export SALT_RELAYER=0x42e7b9e9007a43cc62e1ef3117c301da4f55483c000fedd29404268612e3796c
export SALT_BTC_CALL_EXECUTOR=0x42e7b9e9007a43cc62e1ef3117c301da4f55483c003374b30ba2861a714bc43b
export SALT_ETH_CALL_OUTBOX=0x42e7b9e9007a43cc62e1ef3117c301da4f55483c0033645f5196e2a63e48fb5e
export SP1_VERIFIER=0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2
export WSTETH_USD_FEED=0x8B6851156023f4f5A66F68BEA80851c3D905Ac93
export HEADER_RELAY=0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0
export MAINNET_RPC=<a reliable mainnet RPC — https://ethereum-rpc.publicnode.com worked tonight>

export TETH_BITCOIN_ID=<RESOLVE — see item 1 above>
export GENESIS_REFLECTION_ANCHOR=<RESOLVE — re-fetch fresh, see item 2 above>
export REFLECTION_RESUME_DIGEST=<RESOLVE — re-fetch fresh, see item 2 above>

# dry-run — read every line of the output before proceeding
forge script script/DeployV1SuiteCreateX.s.sol:DeployV1SuiteCreateX \
  --rpc-url "$MAINNET_RPC" --private-key "$DEPLOYER_PK"

# only a human, only after reading the dry-run output:
forge script script/DeployV1SuiteCreateX.s.sol:DeployV1SuiteCreateX \
  --rpc-url "$MAINNET_RPC" --private-key "$DEPLOYER_PK" --broadcast
```

## After broadcast

Confirm the printed pool address matches `predict()`'s output for the salts above (the script
self-verifies this and reverts on mismatch, but confirm it yourself too). Update
`deployments/1.json` and `docs/DEPLOYMENTS.md`. Do not point the dapp at the new pool, and do not open
its fast lane to real users, until the reflection has caught up past the anchor height and stayed
current for at least one full cycle — deploying into a fresh deadlock on day one is avoidable, and
avoiding it is cheap.
