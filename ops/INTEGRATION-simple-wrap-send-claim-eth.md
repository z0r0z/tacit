# Integration handoff: wrap ETH → confidential stealth-send → claim → unwrap

Status: engineering handoff, ETH-only (no Bitcoin/cross-chain leg). Addresses and registry
facts below were re-verified against mainnet on 2026-09-04 for the **gen1** pool. Do not
copy any address/vkey into long-lived config without re-checking this repo at
integration time — see "Known limitations" at the bottom.

ETH-only integration does NOT depend on the Bitcoin reflection lane. Wrap / stealth-send /
claim / unwrap settle against the settle guest alone, so they are unaffected by reflection
height or catch-up state. The Bitcoin lane has its own gate — see "Known limitations".

## 1. The flow, in plain English

A sender wraps plain ETH into the confidential pool (this is a normal public deposit tx).
A relayer (or the sender's own second tx) then proves and submits a **stealth lock**: the
ETH's value is moved into a separate "lock-set" tied to a one-time public key derived from
the recipient's published static address — the recipient does not need to be online, and
the sender cannot spend it back out even though they created it. Later, the recipient scans
the lock-set, recognizes a lock addressed to them, and submits a **stealth claim** (a
BIP-340 signature under the derived one-time key) that mints a normal private note under
their own key. From there they **unwrap** that note back to plain ETH to any EVM address.
Every proving step (lock, claim, unwrap) requires an SP1 Groth16 proof; those proofs can be
generated locally on CPU (native-gnark, no GPU, no Succinct network payment) or requested
from Tacit's existing relay API, which proves and/or submits on the caller's behalf.

## 2. Contracts in use (mainnet)

The **gen1** suite, live on mainnet (deployed block 25892003, verified on-chain 2026-09-04).
Canonical source is the manifest `contracts/deployments/1-createx.json`:

```
mainnet.pool              = 0x0000000000047DD77CeCEfE5Dc015EB7bFa9C677
mainnet.router            = 0x000000004c5BF191225F9049b385d6F3820E09BC
mainnet.collateralEngine  = 0x00000000005b13bAFbf951Ff58cCbAa29de8B51A
mainnet.assetFactory      = 0x0000000042c2D57499Df64BAF81bfA2C6E100535
mainnet.relayer           = 0x0000000031e3b085713DfC2A64f85789278710ea
mainnet.btcCallExecutor   = 0x000000002A11496d860f0d06f92B71B1d1979600
```

⚠️ `dapp/confidential-deployments.generated.js` may still point at an EARLIER generation:
pointing the dapp at a new pool is a deliberate, separate gate from deploying it. Regenerate
with `node tools/sync-deployment-config.mjs contracts/deployments/1-createx.json --network
mainnet --write` (dry-run without `--write`). Read the manifest, not this document, as truth —
this project has redeployed several times and every generation is a fresh, immutable address set.

The `router` is the convenience entry point for wrapping native ETH in one tx
(`contracts/src/ConfidentialRouter.sol`); the `pool` is the canonical settlement contract
(`contracts/src/ConfidentialPool.sol`) that all proofs ultimately settle against.

### 2a. The native-ETH asset id — the single most common integration mistake

Native ETH on gen1 is **tETH**: an escrow-backed asset carrying a Bitcoin cross-chain link.
When an asset has a link, `_register` keys the registry by the **shared link id**, NOT by the
local `evmAssetId(0x0)`:

```solidity
if (crossChainLink != bytes32(0)) { assetId = crossChainLink; ... }   // ConfidentialPool.sol
```

So the id to use everywhere (wrap commitments, `exitedAsset`, note derivation) is:

```
ETH assetId = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34
```

Verified live: `assets(<that id>)` → `registered=true, underlying=0x0, unitScale=1e10,
poolMinted=false, decimals=18`. Computing `evmAssetId(0x0)` instead yields
`0x62c4c604…`, for which `assets()` returns `registered=false` — an integrator who does that
will wrongly conclude ETH is unsupported, or worse, build against an unregistered id.

`unitScale = 1e10` because ETH is 18-dec on Ethereum and 8-dec on the Tacit/Bitcoin side:
**note values are in 8-dp units** (1 ETH = 1e8), while the `wrapETH` tx carries wei. Divide by
`unitScale` going in, multiply coming out.

## 3. Contract calls / ABI, step by step

### Step A — wrap: deposit plain ETH as a pending confidential deposit

`ConfidentialRouter.sol`:
```solidity
function wrapETH(bytes32 commit) external payable;
```
- `commit = keccak256(Cx ‖ Cy ‖ owner)` — a Pedersen-style commitment to the note the
  wrap will register (built client-side; see `dapp/confidential-pool-ux.js:227` for the
  exact selector/calldata construction, `pool.wrap(bytes32 assetId, uint256 amount, bytes32 commit)`,
  called via router for native ETH).
- `msg.value` is the plain-ETH amount being wrapped.
- This alone only registers a **pending public deposit** on-chain — it does not create a
  private note yet. The note leaf and stealth lock leaf are only emitted once a `settle()`
  proof consuming this deposit lands (see Step B).

There is also `ConfidentialPool.wrap(bytes32 assetId, uint256 amount, bytes32 commit)`
(`contracts/src/ConfidentialPool.sol:1233`), the underlying entry the router forwards to for
non-native assets; for plain ETH use the router's `wrapETH`.

### Step B — settle: submit the SP1 proof that turns the deposit into a stealth lock

`ConfidentialPool.sol`:
```solidity
function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
```
This single entry point is used for every proof-carrying op in the protocol, including the
stealth lock. The guest op used here is `OP_STEALTH_LOCK` (opcode 23,
`contracts/sp1/confidential/src/main.rs:116`, handler at line 5137):
- Spends the sender's just-wrapped note (`N`), proves conservation of `amount`.
- Emits a locked note `L` into the shared **lock-set** (not the ordinary note tree) under
  the recipient's one-time public key `owner_pub`, with a `deadline` after which the
  sender ("locker") can reclaim it if never claimed.
- `owner_pub` is derived client-side from the recipient's published static spend pubkey `B`
  plus a fresh ephemeral key the sender generates — see §5 below and
  `dapp/confidential-stealth.js:116` (`buildStealthLock`).

`publicValues`/`proofBytes` are the SP1 Groth16 proof output; `memos` carry the encrypted
recovery data (including the ephemeral pubkey `E` the recipient needs to detect the payment
— see §5). The JS builder for this op is `buildStealthLock` in
`dapp/confidential-stealth.js:116`.

### Step C — claim: recipient spends the stealth lock into their own note

Guest op `OP_STEALTH_CLAIM` (opcode 24, `contracts/sp1/confidential/src/main.rs:117`,
handler at line 5226), submitted the same way — a `pool.settle()` call carrying a new SP1
proof:
- Recipient proves membership of the lock leaf under `owner_pub` and a BIP-340 signature
  under the one-time private key `b + s` (`b` = recipient's static spend key, `s` = shared
  secret they derive from the sender's published ephemeral key `E`).
- Mints an ordinary note `M = amount − fee` under a key the recipient chooses (their own
  ordinary spend key, not the one-time key) — `fee = 0` for a self-submitted claim, `fee > 0`
  if relayed.
- JS builder: `buildStealthClaim` in `dapp/confidential-stealth.js:140`.

There is also `OP_STEALTH_REFUND` (opcode 25, `buildStealthRefund` at
`dapp/confidential-stealth.js:158`) — lets the **sender** reclaim the locked value after
`deadline` if the recipient never claims (typo/dead-address safety net). Not part of the
happy path but worth knowing about for a v0 test.

### Step D — unwrap: recipient converts their private note back to plain ETH

Guest op `OP_UNWRAP` (opcode 2, `contracts/sp1/confidential/src/main.rs:70`, handler at
line 1184). JS: `unwrap({ note, walletPriv, recipient, feeOpts })` in
`dapp/confidential-pool-ux.js:1497` (thin wrapper around `buildUnwrap`,
`dapp/confidential-pool-ux.js:1412`), which also submits via `settle()`. This burns the note
and pays plain ETH to `recipient` (any EVM address), optionally paying a relayer fee for
gasless exit.

(Note: `OP_WRAP_TRANSFER` (opcode 27) and `OP_SEND_AND_UNWRAP` (opcode 28) exist and are
useful for a normal, *interactive* private send/exit, but they are **not** what a
non-interactive send-to-a-possibly-offline-recipient needs — that specifically requires the
stealth lock/claim ops above, because they gate spending on a signature the sender cannot
produce, rather than merely on knowledge of a blinding factor the sender does know.)

## 4. Generating proofs: fully local, no Succinct network required

Checked the actual harnesses used for these ops:

- `contracts/sp1/confidential/harnesses/exec-stealthlock.rs`
- `contracts/sp1/confidential/harnesses/exec-stealthclaim.rs`
- `contracts/sp1/confidential/harnesses/exec-stealthrefund.rs`

All three build the prover client with `ProverClient::builder().cpu().build()` — **`.cpu()`,
not `.network()`** — and prove with `.groth16().run()`. There is no `NETWORK_PRIVATE_KEY` or
Succinct payment involved in this path; it is native-gnark on the local CPU. Run mode is
selected by an env var:

```
MODE=execute   # default — just executes + prints cycle count, no proof
MODE=groth16   # actually proves; writes proof artifacts
```

This is real Rust/SP1 tooling — a third party integrating this needs to build and run these
harness binaries (`cargo run --release --bin exec-stealthlock`, etc., with `MODE=groth16`),
not just call a REST endpoint, **if** they want to prove entirely themselves. RAM: this
repo's own prover-ops notes (`ops/PROVER-FAILOVER-DESIGN.md`) reference a GPU-capable box as
the *fast* path but confirm the CPU/native-gnark path is a genuine, self-contained fallback
requiring no GPU — budget on the order of 20–30GB RAM for a comfortable Groth16 run; no exact
figure is pinned in-repo for these specific ops, so validate on your own hardware before
relying on it (`MODE=execute` first to sanity-check the circuit executes, then `MODE=groth16`).

### Alternative: use Tacit's existing relay API (no local prover needed)

`worker/src/index.js` and `worker/src/confidential-settle.js` implement a real, currently
wired REST relay:

```
POST /confidential/submit  {type, op, memos?, mode?}
```
- `type` must be one of the allowlisted op names, which explicitly includes
  `'stealthlock'`, `'stealthclaim'`, `'stealthrefund'`, `'wrap'`, `'unwrap'`
  (`worker/src/confidential-settle.js:41`).
- `mode: 'settle'` (default) — the relay's own prover box proves AND submits `settle()`
  on-chain for you.
- `mode: 'prove'` — the relay box proves only and hands back `{publicValues, proofBytes}`
  for you to embed in your own `ConfidentialRouter`/`ConfidentialPool` transaction.
- Endpoint is explicitly documented as **permissionless** ("a bad witness just fails to
  prove") but is rate-limited per source IP for the free prove-only path
  (`PROVE_RL_BURST=5`, refill one token/40s — see `worker/src/index.js` around
  `proveRateLimit`).
- Gated overall on the worker's `CONFIDENTIAL_SETTLE=1` config flag. **Verified enabled in
  production on 2026-09-04** (`tacit-api` service env). Re-check before depending on it, but
  as of that date this is a live endpoint, not just an available code path.
- **Relay tips** are armed per-asset in the deployed settle guest: the tip is read per intent
  and bound into the PoK context, then paid to `msg.sender` on settle. That is what makes the
  `mode: 'settle'` path economically self-sustaining rather than a favour — the relayer is
  paid in-proof, from the settled note, with no separate on-chain approval from the user.
  (`contracts/sp1/confidential/src/main.rs`, the per-asset `tip_*` reads.) A self-submitted
  proof simply sets tip 0.

This is the practical path for a low-stakes integration test: build the `op`/`memos` payload
client-side using the same JS builders referenced above (`dapp/confidential-stealth.js`,
`dapp/confidential-pool-ux.js`), then POST to `/confidential/submit` instead of running your
own SP1 toolchain.

## 5. How a recipient detects a payment (stealth scan)

Design doc: `ops/DESIGN-confidential-stealth-receive.md`. Mechanism (standard one-time
address / dual-key stealth scheme):

- Recipient publishes a static spend pubkey `B = b·G`.
- Sender draws an ephemeral keypair `(e, E = e·G)` per payment, computes shared secret
  `s = H(e·B)`, and the one-time pubkey `O = B + s·G`. `O` is what actually receives the
  stealth lock; `E` is published in the op's memo.
- The recipient's one-time private key is `b + s`, but only the recipient can compute `s`
  (as `H(b·E)`, using their private `b`) — the sender knows `E` and `s` but never learns `b`,
  so they cannot derive `b + s` and cannot claim their own lock.
- **Scanning**: the recipient watches the pool's shared lock-set (already indexed — "the
  recipient-agnostic indexer scan already exists" per the design doc), and for every stealth
  lock's published `E`, computes `s = H(b·E)`, `O' = B + s·G`, and checks whether `O'`
  matches the lock leaf's `owner_pub`. A match means it's theirs; they then decrypt the
  `amount` from the memo and submit `OP_STEALTH_CLAIM`.
- Client-side helper: `dapp/confidential-stealth.js` (op assemblers) is where this trial
  decryption / one-time-key derivation logic already lives. There is no separately
  documented indexer endpoint specific to stealth-lock scanning found in this session's
  research — TODO: confirm with the Tacit team which indexer/worker endpoint currently
  serves the lock-set for third-party scanning (e.g. under `worker/`), since the design doc
  references it as already existing but this pass did not locate its route name.

## 6. Known limitations for a v0/low-stakes test

- This touches **live mainnet contracts** handling real ETH, against an **immutable**,
  previously-audited pool contract. Keep test amounts small; there is no way to patch the
  deployed contract if something is wrong.
- **Do not hardcode any address or vkey long-term.** This project has gone through multiple
  contract-generation redeploys (the project's own history references several "V1 seeded
  redeploy", "V2 redeploy", vkey rotations, etc.) — re-pull
  `dapp/confidential-deployments.generated.js` (or ask the Tacit team for the current live
  address) at actual integration time, not from this document.
- The relay's `/confidential/submit` being "permissionless" means a malformed witness simply
  fails to prove — it does not mean funds are at risk from a bad request, but also means
  there is no support contract backing that endpoint's uptime; treat it as best-effort for a
  kick-the-tires integration, not a production dependency, unless the Tacit team confirms
  otherwise.
- `OP_STEALTH_REFUND` exists precisely because sends can go unclaimed (wrong pubkey, offline
  recipient forever, etc.) — plan your test flow to also exercise/verify the refund path
  before the `deadline`, in case the "happy path" claim doesn't get exercised in time.
- This document covers Ethereum only, per the request; the same stealth-lock/claim
  machinery is also used for a Bitcoin→Ethereum cross-chain variant
  (`OP_BRIDGE_STEALTH_MINT`, opcode 26) which is explicitly out of scope here.

### 6a. Bitcoin-lane gate — matters even though this doc is ETH-only

Do not enable an ETH→BTC `crossOut` path on gen1 yet, and do not let a UI expose one.

`bitcoinConsumedCount` and `crossOutCount` are both `0` on gen1 (read 2026-09-04). If a
`crossOut` lands while `bitcoinConsumedCount` is still 0, the reflection fold **freezes
permanently for that pool** — unrecoverable without another full redeploy. The counter is
seeded by one real Bitcoin-homed fast-lane consume, which must happen first.

This does not constrain anything in this document: wrap / stealth-send / claim / unwrap never
touch that counter. It only constrains adding a Bitcoin bridge button to the same UI.

## 7. Exiting to an L2 (Base and other OP-Stack chains)

A shielded note can exit directly into a canonical L2 bridge in one atomic transaction —
no new contract, using the existing `ConfidentialRouter.exitAndExecute` recipe escrow:

```js
const recipe = router.buildBridgeExit({
  exitedAsset: ETH_ASSET_ID,       // the linked id from §2a
  amount,                          // wei (native) — rides as the bridge call's value
  l2Recipient,                     // credited on the L2
  chainId: 8453,                   // Base; or pass { bridge } for another OP-Stack chain
  deadline, nonce,
});
// build the settle proof so withdrawals[0].recipient == router.exitRecipeEscrow(impl, recipe, routerAddr)
// then send router.exitAndExecuteCalldata({ publicValues, proof, memos, recipe })
```

Base L1StandardBridge `0x3154Cf16ccdb4C6d922629664174b904d80F2C35` (verified on-chain: its
`OTHER_BRIDGE()` is the L2 predeploy `0x42…0010`). L1→L2 credit lands in ~1–3 minutes.

Three things that will bite:
- `depositETH`/`depositERC20` are `onlyEOA` and **revert for a contract caller**. The escrow is
  a contract, so only the `…To` variants work. `buildBridgeExit` uses those.
- `l2Token` is per-chain and is never defaulted — a wrong value is a permanent misdelivery.
  Source it from that chain's token list / `OptimismMintableERC20Factory`.
- Never use the ephemeral escrow as a refund address. It is a one-shot clone at
  `keccak(recipe)`; anything refunded there later needs a separate `reclaimExit` to rescue.
  (Relevant for Arbitrum-style retryables, which do refund; OP deposits do not.)

**Privacy boundary:** the exit, the amount, and the L2 recipient are all public on L1. This is
"shielded accumulation, then exit anywhere" — not a private cross-chain transfer. Do not
describe it to users as the latter.
