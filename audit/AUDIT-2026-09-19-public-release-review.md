# Tacit — Public-Release Review, gen5 live immutable surface (Claude Opus 5)

**Model / mode:** Claude **Opus 5**, one continuous single-reviewer session, 1M context — the whole surface read
in one window rather than fanned out to sub-reviewers, so every claim below was reached and re-checked by the
same reader. Where a prior round's verdict was available it was deliberately *not* consulted before forming an
independent one; prior notes were read only afterwards, to reconcile.
**Date:** 2026-09-19 · **Branch:** `main` at `f3917087`, plus the five off-chain fixes this review landed
(uncommitted, for maintainer review) · **Posture:** the surface is already **deployed and live on Ethereum
mainnet**. This review asks one question the earlier rounds did not: *is this safe to publish?*

Every prior round reviewed source on its way to a deployment. This one starts from the deployment and works
backwards to the source.

## Scope

- **Immutable, deployed:** `ConfidentialPool.sol` (2673 lines) and the `ReflectionLib` it delegatecalls, read in
  full; the SP1 settle guest `contracts/sp1/confidential/src/main.rs` (5516 lines), read in full, every one of
  its 34 opcodes; the `cxfer-core` cryptographic core — conservation kernels, opening sigmas, the BP+ and
  classic aggregated range verifiers, BIP-340, the Keccak-Merkle and indexed-Merkle accumulators; the Bitcoin
  reflection guest `reflect.rs`, focused on the Mode-B recursion gate, the header/block-completeness chain, and
  the burn/consume/cross-out folds.
- **Deployment identity:** the live mainnet bytecode at `0x000000000Ed1eabD231Be41d93b719056F7febFC`, its linked
  library, its 19 immutables, and the guest ELF ↔ vkey ↔ deployed-immutable chain.
- **Off-chain, mutable:** the Cloudflare worker API (`worker/src/index.js`, ~27.8k lines — routing, auth,
  proxies, rate limits), the settle relay and its prover wrapper (`worker-relay/src`), the dapp's randomness,
  XSS and CSP posture, and the repository's secret-leak exposure under publication.

**Bar applied:** no value created or destroyed across the Bitcoin↔Ethereum boundary without its counterpart; no
taking, redirecting or double-spending another holder's balance; a holder with only their keys can always exit;
no permanent brick reachable by an unprivileged party; no privileged party can freeze or redirect funds beyond a
narrow and stated scope; and — new to this round — nothing in the repository or its history that publication
itself would expose.

## Verdict

**Clear to publish.**

No double-spend, insolvency, theft, or bricking path was found in the immutable surface. The live mainnet
bytecode was proven byte-identical to this tree. Five hardening items were found off-chain, all fixed here; one
of them is the only finding in this review with live operational consequence, and it is a cost-of-service issue
for the relay operator, not a risk to user funds.

The immutable surface needs no change and gets none. Nothing in this review alters a contract, a guest, or a
vkey.

**One deploy gate:** finding **O-1** (relay submit metering) is fixed in this tree but is a worker change, so it
takes effect only on `wrangler deploy`. Until that deploy lands, `/confidential/submit` accepts relayed settles
at any fee including zero. Deploy the worker before the endpoint is advertised publicly, or set
`RELAY_FEE_FLOOR = "1"`, or both.

## Method

The load-bearing part of this review is a verification most audits cannot perform, because they run before
deployment: **proving that the code reviewed is the code running.**

1. Fetched the live runtime from mainnet. Took the compiler's own `linkReferences` and `immutableReferences`
   maps from a fresh local `forge build`, zeroed those byte ranges in *both* the live code and the local
   artifact, and compared. This neutralises exactly the two things that legitimately differ between an artifact
   and a deployment — the library address chosen at link time and the constructor-written immutables — and
   nothing else.
2. Read the 19 immutables directly out of the live bytecode at their compiler-reported offsets, rather than
   through getters (most are `internal` and have none), and checked each against the pin files and the
   deployment manifest.
3. Re-derived `CHAIN_BINDING` independently as `keccak256(abi.encodePacked(uint256(1), pool))` and compared.
4. Read the immutable surface adversarially: for each candidate attack, construct it concretely, then find the
   specific line that refuses it, or conclude it works.
5. Ran the full on-chain test suite and every pin-verification script.
6. Scanned the repository *and its full git history* for material that publication would expose.

## Deployment identity — verified

| Check | Result |
|---|---|
| Live pool runtime vs. local build (link refs + immutables normalised) | **byte-identical**, 24290 bytes (12 link refs, 19 immutable slots) |
| Live `ReflectionLib` at `0x141e653de94438258fdab245896c189f56522554` vs. local build | **byte-identical**, 12957 bytes |
| `PROGRAM_VKEY` in live bytecode vs. `elf-vkey-pin.json` | `0x006cd47f…d6e3` — match |
| `BITCOIN_RELAY_VKEY` in live bytecode vs. pin | `0x00bb158b…4bc5` — match |
| `CHAIN_BINDING` in live bytecode vs. independently recomputed | `0x382a65d3…c73d` — match |
| `REFLECTION_CONFIRMATIONS` | 24 |
| `PREDECESSOR` | `0x0` — gen5 resumed by attested resume-digest, not by the `createNextGen` lineage path |
| `HEADER_RELAY` / `CANONICAL_FACTORY` / `COLLATERAL_ENGINE` / `PUBLIC_AMM` | all match the deployment manifest |
| `reflect.rs` pinned `ETH_CALL_OUTBOX` vs. deployed `ethCallOutbox` | `0x00000000a26a…af46` — match |
| Committed guest ELF sha256s vs. pin | both match (settle 1681088 B, reflection 1340080 B) |
| Foundry suite | **884/884 pass**, 88 suites, including the real-Groth16 `*ProofReal` fixtures and 6 invariant runs at 128k calls each |
| `verify-vkey-pin.sh` | PASS — incl. all 35 settle + 2 reflection Groth16 fixtures binding to a pinned vkey |
| `verify-lockstep-pins.sh` | PASS — checkpoint `c06108e6…` |
| `verify-storage-slots.sh` / `verify-guest-slots.sh` / `verify-reflection-slots.sh` | PASS — slots 77/120/121/165/171/172 coherent guest↔contract |
| Live `tacit.js` vs. repo copy | sha256-identical; cache-bust token `1b38089a` matches |
| Live `confidential-deployments.generated.js` | already serves gen5 addresses |

The last two lines retire a deferred item from the gen5 cutover checklist: the live dapp is **not** serving
stale gen4-pointing JS. It is current.

**What this does not prove.** The guest ELF↔source binding is not independently reproducible by a third party.
The committed ELFs' sha256s match the pin, and the pin's vkeys match the deployed immutables, so the chain is
tight from *binary* to *chain*. But going from *source* to *binary* still means trusting the maintainer's
prover-host build, and `reflection_elf_built_from_src_commit` currently reads `8fea213d (…, uncommitted)`. A
reader who wants to verify the guest from source must rebuild it on the SP1 toolchain and compare. This is the
single largest gap between "audited" and "independently verifiable" in the whole system, and it is worth saying
so plainly in the public materials rather than letting a reader discover it. See *Recommendations*.

## Findings

No Critical, High, or Medium finding in the immutable surface. All findings are off-chain.

### O-1 — Relayed settles were unmetered when the profitability gate is off *(the material one)*

`handleConfidentialSubmit` rate-limited only `mode:'prove'`, on the stated ground that *"relayed settle jobs are
fee-gated."* They are not. `buildRelayFeeGate` returns `null` unless `RELAY_FEE_FLOOR == '1'`, and that variable
is commented out in `worker/wrangler.toml`; even when set, the gate can only price a cETH fee leg and passes
every other asset through. So a public, unauthenticated POST reached the relay's job queue with no cost to the
sender, and each accepted job costs the relay a `$PROVE` cycle plus mainnet gas. The only backstop was
`MAX_PENDING_JOBS = 512`.

**Not a user-funds issue.** `settle` is permissionless, the fee is bound inside the proof, and the relay never
custodies user value — it can only earn the bound fee. What a flood exhausts is the relay's own gas and prove
budget, and the relay is optional (any user can self-settle). But "the optional convenience layer stops working
on day one of public exposure" is a real availability outcome.

**Fixed:** relayed submits are now metered on the same per-IP token bucket whenever the profitability gate is
not actually enforcing a floor. Setting `RELAY_FEE_FLOOR = "1"` restores the unmetered fast path for fee-paying
submits, which is the intended steady state.

### O-2 — Prover-fixture path built from an unvalidated job field

`proveSettle` built `path.join(CFG.fixtureDir, `${type}_op.json`)` and wrote attacker-supplied JSON to it
*before* consulting the `PEROP` allowlist that constrains `type`. A `type` containing `../` would write outside
the fixture directory.

Not reachable today — the worker allowlists `type` at submit — so this is a defence-in-depth gap rather than a
live vulnerability. It is worth closing anyway: a relay must not depend on an upstream validator to decide where
it writes files, and the two components deploy independently.

**Fixed:** `PEROP` hoisted to module scope; `type` is resolved and rejected before anything touches the
filesystem.

### O-3 — CDP key material could fall back to `Math.random()`

`rand32Hex()` in the confidential DeFi tab fell back to `Math.random()` when `crypto.getRandomValues` was
absent, with the comment *"never hit in a real browser."* Those 32 bytes become a CDP position's debt-note
blinding, its nullifier key, and the released-collateral blindings and nullifier keys — spend authority over
real collateral. `getRandomValues` is absent precisely outside a secure context (plain HTTP, a legacy WebView),
which is the situation in which failing open is least acceptable: it would mint guessable keys silently and
hand the position's collateral to anyone who can reproduce the PRNG state.

**Fixed:** throws, matching `bulletproofs-plus.js randomScalar`, which already refused to proceed without a
CSPRNG. Note this module is a separate ES module rather than part of the `tacit.js` bundle, served with
`max-age=0, s-maxage=300`, so the fix propagates on deploy without a cache-bust rotation.

### O-4 — One bearer gate compared in non-constant time

Every bearer gate in the worker — `checkDebugAuth`, `checkConfidentialAuth`, `ceremonyAuthOk`,
`checkBearerConstantTime` — uses a length-then-XOR compare. `/prover-heartbeat` was the exception, using `!==`
on the raw secret. Forging a heartbeat only fakes prover liveness (a monitoring-blindness grief, not a funds
path), but the token is shared with the prover box's environment and should not be the one secret with a timing
side-channel.

**Fixed:** extracted a shared `constantTimeEqual()`, applied it there, and refactored `checkBearerConstantTime`
onto it.

### O-5 — Path traversal in the IPFS proxy sub-path

`/ipfs/<cid><sub>` validated the CID strictly (CIDv0/v1 format, plus raw-block digest re-verification) but
accepted any `sub` matching `(\/[^?#]*)?`. Since the sub-path is concatenated onto the gateway base and `fetch`
normalises `..`, a request could resolve off the gateway's `/ipfs/` prefix and proxy an arbitrary path on a
whitelisted gateway host back through the worker's permissive CORS and 24-hour edge cache.

Bounded — the gateway list is fixed and the hosts are public read-only IPFS gateways — but it is cache
poisoning under the worker's own origin.

**Fixed:** `.` and `..` segments rejected. Directory CIDs only ever need forward segments.

## Attacks constructed and refuted

Recorded so a later reviewer does not re-derive them, and so a reader can check the refutation against the named
guard rather than taking the verdict on trust.

| Attack | Why it fails |
|---|---|
| Register a future bridged asset's canonical ERC-20 as an *escrow* asset, so `_autoRegisterFromMeta`'s heal branch poisons an escrow-backed entry | `ReflectionLib.register` does `try MINTER() { if (mtr == address(this)) revert CanonicalAsset(); }`. A pool-minted token can never be registered escrow-mode, so the heal branch only ever touches a `poolMinted` entry — exactly what its comment claims |
| Mint unbacked farm rewards through a self-deployed `ICdpController` | MINT mode can only ever mint `cdp_debt_asset_id(controller)`, which is unregistered ⇒ no payout path, and `ensurePair` refuses it ⇒ no AMM path. Inert. ESCROW mode requires a `farmTreasury` the attacker funded with real value first. Break-even |
| Reach the *real* engine's cUSD id from a hostile controller | Requires grinding a contract address whose `keccak("tacit-cdp-debt-v1"‖addr)` equals a target — a 256-bit preimage |
| Open a CDP, then self-liquidate with a controller that always reports unhealthy | Basket legs are opening-proven against genuinely spent notes; liquidation pays back exactly those legs. Attacker recovers their own collateral. Conserved |
| Front-run a victim's `wrap` to seize their `depositId` | Same id requires the same `(assetId, value, commit)`, so the front-runner escrows the same amount against the *victim's* note commitment — which only the victim can open. The attacker donates |
| Collide `intent_context` across two witness shapes (variable `notes`/`amounts` vectors, no length prefix) | Shapes are fixed per domain tag; the two genuinely variable ops bind their counts explicitly (`LP_ADD` binds `n_a`/`n_b`, `SWAP`'s note count determines its own length class). No cross-shape collision within a tag |
| Smuggle `OP_SWAP_BLIND` / `OP_LP_BOND` / `OP_BID` into a Bitcoin-homed batch to spend a reflected note without its BIP-340 authorisation | Those ops build native leaves and never push `bitcoin_consumed_sources`, so the guest's `sources.len() == nullifiers.len()` assert fails, and the contract's own length check fails behind it. Closed twice |
| Pass an internal Merkle node off as an IMT leaf (second preimage) | Fixed depth-32 path fold: a node at height *d* has only 32−*d* real levels above it, so no 32-element path reaches the root from it |
| Re-enter `settle` from a malicious `ICdpController` callback | `settle` is `nonReentrant` (solady transient). The only unguarded state-changing entrypoints are `createPair` and `advanceReflectionAncestry`, both benign mid-settle |
| Grief `advanceReflectionAncestry` to stall a lagging reflection lane | The cursor only descends toward a target fixed by chain state, promotes only on arrival, and resets when its anchor stales. No caller can move it backwards or substitute a worse checkpoint |

## Design decisions recorded, not findings

- **Relayed settles are front-runnable, and this is the right trade.** `pv.fees` pay `msg.sender`, and the proof
  does not bind a relayer, so anyone watching the public mempool can copy the calldata and land it first. The
  closest comparables (Tornado, Railgun, GSN) solve this by binding the relayer address into the signed or
  proven payload — so a reader *will* ask why Tacit does not. The answer is that binding makes the proof
  relayer-specific: the user must choose a relayer before proving, a chosen relayer can censor by sitting on the
  proof, and a relayer outage kills a proof that costs real money to regenerate. Tacit keeps the proof
  relayer-agnostic and permissionless and pays for it elsewhere: private submission (Flashbots Protect) on the
  relay's own path, and `TacitRelayer`'s `minOut` guard, which reverts a whole batch whose fees did not
  materialise — so a front-run relayer loses the proof cost but **not** the gas. The user is never harmed either
  way; their effects land whoever submits. Worth stating in the public materials as a deliberate trade, not
  omitting.
- **`LINEAGE_STEWARD` is a 2-of-4 multisig** (`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`). Its only power is
  `createNextGen`: it names the successor's code and nothing else. It cannot touch escrow, freeze an exit, or
  redirect a payout. The worst a compromised steward achieves is closing new external-asset entry to this
  generation and pointing `successor` at code nobody is obliged to use. Publish the signer set.
- **Reflection liveness is not permissionless in practice.** `attestBitcoinStateProven` is permissionless, but
  producing its proof needs the reflection prover and a full Bitcoin block witness set. If nobody runs it, the
  Bitcoin lane halts: no new bridge mints, no new cBTC lock registrations. EVM-side notes stay fully spendable
  and exitable throughout. This is the honest shape of the decentralisation claim and should be stated that way.
- **A Bitcoin reorg deeper than `REFLECTION_CONFIRMATIONS` (24) halts reflection permanently.** Fail-closed and
  deliberate; the contract's own comment explains why re-anchoring would convert a halt into silent inflation.
  The deepest Bitcoin reorg since 2015 is 4 blocks.
- **CDP liquidation safety rests on the mutable `CollateralEngine`.** The immutable layer proves structure and
  conservation; all pricing and health policy is the controller's, and `onCdpLiquidate` reverting is the only
  thing that protects a healthy position. This is stated in the contract and is the intended split, but it means
  the engine — owner-governed, with a stated `MIN_ESCROW_GRACE_WINDOW` floor and a fee cap — is inside the trust
  boundary for cUSD in a way the pool is not.

## Publication exposure

Scanned the working tree **and the full git history** — publishing a repository exposes every commit ever made,
not just `HEAD`.

- `.env`, `.env.mainnet`, `.env.render`, `.env.tacit-api-render` are gitignored **and were never committed**
  (verified by `git log --all --diff-filter=A` over all added paths, not just by checking `HEAD`).
- No provider credential formats anywhere in history: `sk-`, `ghp_`, `AKIA`, `xox[baprs]-`, JWT.
- One hardcoded private key, `827aee34…`, in `tests/bridge-3a.mjs` and `tests/amm-teth-tac-pool-signet.mjs`. It
  is a **signet** burner (its Bitcoin address is `tb1qc0tjnm…`), and its Ethereum derivation
  `0x5145e7D0a12B36Db79a2F9eE089c4590BBcC8a82` has **balance 0 and nonce 0 on both mainnet and Sepolia**. Not a
  leak. Label it as a burner in the file so neither a secret scanner nor a reader misreads it.
  *Not verified:* the Bitcoin-mainnet balance for that key (tooling blocked during the session). The Ethereum
  evidence, the `tb1q` prefix and the signet-only call sites make it conclusive, but the check is cheap and
  someone should run it before publication.

### Dapp posture

- **CSP** (`dapp/index.html`): `script-src 'self' 'wasm-unsafe-eval'` — no `unsafe-inline`, no `unsafe-eval`, no
  third-party script origins; `object-src 'none'`; `base-uri 'self'`; `form-action 'none'`; `frame-ancestors`
  delivered as a real header via `_headers` (the one directive `<meta>` cannot carry). Sound.
- **XSS:** 528 `innerHTML` sites were scanned programmatically for interpolation of attacker-controlled fields
  (etch tickers, IPFS metadata names and descriptions, external URLs). Every such site routes through
  `escapeHtml`, and external URLs additionally through `safeExternalUrl`. No unescaped untrusted sink found.
- **Randomness:** `randomScalar` is CSPRNG-only with rejection sampling and throws if unavailable. O-3 was the
  one helper that did not follow it.
- **Worker proxies:** `/chain/*` is a strict regex whitelist of read-only Esplora paths — no SSRF. `/ipfs/*`
  validates CID format and re-hashes raw blocks against the CID; O-5 was its one gap.
- **Worker auth:** every mutating reflection and confidential endpoint is behind a constant-time bearer gate and
  returns 404 rather than 401 when unconfigured, so the surface is not enumerable.

## Recommendations before publishing

1. **Deploy the worker** (the O-1 gate), and set `RELAY_FEE_FLOOR = "1"` so the profitability gate is doing real
   work rather than being metered around.
2. **Say plainly that the guest ELFs are not yet reproducibly buildable**, and give the rebuild recipe. This is
   the most likely question from a serious reader and the answer is better volunteered than extracted. A
   containerised, pinned-toolchain guest build that a third party can run to reproduce the pinned sha256s would
   close it, and is the highest-value follow-up in this report.
3. **Publish the steward and engine-owner signer sets**, and any timelock.
4. **State the three honest limitations** — reflection liveness, the deep-reorg halt, relay front-running — in
   the integration materials rather than only in this file. Each has a good answer; omitting them reads worse
   than stating them.
5. **Label the signet burner key** in the two test files, and run its Bitcoin-mainnet balance check.

## Evidence

- Bytecode identity, immutables, and live pool state read from mainnet via `ethereum-rpc.publicnode.com`;
  normalisation driven by the compiler's own `linkReferences` / `immutableReferences` maps from
  `out/ConfidentialPool.sol/ConfidentialPool.json`.
- `forge test`: 884 passed, 0 failed, 88 suites, 175s.
- `verify-pool-size.sh`, `verify-vkey-pin.sh`, `verify-lockstep-pins.sh`, `verify-storage-slots.sh`,
  `verify-guest-slots.sh`, `verify-reflection-slots.sh`: all PASS.
- `node build/build.mjs --verify-only`: dapp bundle current; live `tacit.js` sha256 matches the repo copy.
- JS suites re-run after the fixes: `confidential-settle`, `confidential-relay`, `confidential-relay-fee`,
  `relay-quote`, `settle-relay-nonce`, `mixer-worker`, `governance-worker` — all pass.

## Files changed by this review

No contract, guest, vkey, or pin is touched.

| File | Change |
|---|---|
| `worker/src/index.js` | O-1 relayed-submit metering; O-4 shared `constantTimeEqual()`; O-5 IPFS sub-path traversal |
| `worker-relay/src/lib/prover.js` | O-2 `PEROP` hoisted to module scope; `type` validated before any filesystem write |
| `dapp/confidential-defi-tab.js` | O-3 `rand32Hex()` fails closed without a CSPRNG |
