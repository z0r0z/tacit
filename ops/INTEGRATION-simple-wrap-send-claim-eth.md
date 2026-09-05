# Integration handoff: wrap ETH → confidential stealth-send → claim → unwrap

Status: engineering handoff, ETH-only (no Bitcoin/cross-chain leg). Last reviewed against mainnet
2026-09-06 for the **gen1** pool. **Do not hardcode any address, vkey, or code pointer from this
document into long-lived config** — re-check the live manifest and this repo at actual integration
time (see §6, "Known limitations"). This project has redeployed multiple times; every generation is
a fresh, immutable address set.

ETH-only integration does NOT depend on the Bitcoin reflection lane. Wrap / stealth-send / claim /
unwrap settle against the settle guest alone, unaffected by reflection height or catch-up state. The
Bitcoin lane has its own gate — see §6a.

## 1. The flow, in plain English

A sender wraps plain ETH into the confidential pool (a normal public deposit tx). A relayer (or the
sender's own second tx) then proves and submits a **stealth lock**: the ETH's value moves into a
separate "lock-set" tied to a one-time public key derived from the recipient's published static
address — the recipient does not need to be online, and the sender cannot spend it back out even
though they created it. Later, the recipient scans the lock-set, recognizes a lock addressed to
them, and submits a **stealth claim** (a BIP-340 signature under the derived one-time key) that
mints a normal private note under their own key. From there they **unwrap** that note back to plain
ETH to any EVM address. Every proving step (lock, claim, unwrap) requires an SP1 Groth16 proof;
those proofs can be generated locally on CPU (native-gnark, no GPU, no Succinct network payment) or
requested from Tacit's relay API, which proves and/or submits on the caller's behalf.

## 2. Contracts in use (mainnet)

The **gen1** suite. Canonical source is the manifest `contracts/deployments/1-createx.json`:

```
mainnet.pool              = 0x0000000000047DD77CeCEfE5Dc015EB7bFa9C677
mainnet.router            = 0x000000004c5BF191225F9049b385d6F3820E09BC
mainnet.collateralEngine  = 0x00000000005b13bAFbf951Ff58cCbAa29de8B51A
mainnet.assetFactory      = 0x0000000042c2D57499Df64BAF81bfA2C6E100535
mainnet.relayer           = 0x0000000031e3b085713DfC2A64f85789278710ea
mainnet.btcCallExecutor   = 0x000000002A11496d860f0d06f92B71B1d1979600
```

`dapp/confidential-deployments.generated.js` is the dapp's own pointer at these addresses —
regenerate it with `node tools/sync-deployment-config.mjs contracts/deployments/1-createx.json
--network mainnet --write` (dry-run without `--write`) if it looks stale. Read the manifest, not
this document, as truth.

The `router` is the convenience entry point for wrapping native ETH in one tx
(`contracts/src/ConfidentialRouter.sol`); the `pool` is the canonical settlement contract
(`contracts/src/ConfidentialPool.sol`) that all proofs ultimately settle against.

### 2a. The native-ETH asset id — the single most common integration mistake

Native ETH on gen1 is **tETH**: an escrow-backed asset carrying a Bitcoin cross-chain link. When an
asset has a link, `_register` keys the registry by the **shared link id**, NOT by the local
`evmAssetId(0x0)`:

```solidity
if (crossChainLink != bytes32(0)) { assetId = crossChainLink; ... }   // ConfidentialPool.sol
```

So the id to use everywhere (wrap commitments, `exitedAsset`, note derivation) is:

```
ETH assetId = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34
```

`assets(<that id>)` → `registered=true, underlying=0x0, unitScale=1e10, poolMinted=false,
decimals=18`. Computing `evmAssetId(0x0)` instead yields a DIFFERENT id for which `assets()` returns
`registered=false` — an integrator who does that will wrongly conclude ETH is unsupported, or worse,
build against an unregistered id.

`unitScale = 1e10` because ETH is 18-dec on Ethereum and 8-dec on the Tacit/Bitcoin side: **note
values are in 8-dp units** (1 ETH = 1e8), while the `wrapETH` tx carries wei. Divide by `unitScale`
going in, multiply coming out.

## 3. Contract calls / ABI, step by step

### Step A — wrap: deposit plain ETH as a pending confidential deposit

`ConfidentialRouter.sol`:
```solidity
function wrapETH(bytes32 commit) external payable;
```
- `commit = keccak256(Cx ‖ Cy ‖ owner)` — a Pedersen-style commitment to the note the wrap will
  register (built client-side; see `dapp/confidential-pool-ux.js` `buildWrap` for the exact
  selector/calldata construction, `pool.wrap(bytes32 assetId, uint256 amount, bytes32 commit)`,
  called via router for native ETH).
- `msg.value` is the plain-ETH amount being wrapped.
- This alone only registers a **pending public deposit** on-chain — it does not create a private
  note yet. The note leaf and stealth lock leaf are only emitted once a `settle()` proof consuming
  this deposit lands (see Step B).

There is also `ConfidentialPool.wrap(bytes32 assetId, uint256 amount, bytes32 commit)`
(`contracts/src/ConfidentialPool.sol`), the underlying entry the router forwards to for non-native
assets; for plain ETH use the router's `wrapETH`.

### Step B — settle: submit the SP1 proof that turns the deposit into a stealth lock

`ConfidentialPool.sol`:
```solidity
function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
```
This single entry point is used for every proof-carrying op in the protocol, including the stealth
lock. The guest op used here is `OP_STEALTH_LOCK` (opcode 23, `contracts/sp1/confidential/src/
main.rs`):
- Spends the sender's just-wrapped note (`N`), proves conservation of `amount`.
- Emits a locked note `L` into the shared **lock-set** (not the ordinary note tree) under the
  recipient's one-time public key `owner_pub`, with a `deadline` after which the sender ("locker")
  can reclaim it if never claimed.
- `owner_pub` is derived client-side from the recipient's published static spend pubkey `B` plus a
  fresh ephemeral key the sender generates — see §5.

`publicValues`/`proofBytes` are the SP1 Groth16 proof output; `memos` carry the encrypted recovery
data (including the ephemeral pubkey `E` the recipient needs to detect the payment — see §5). The JS
builder for this op is `buildStealthLock` in `dapp/confidential-stealth.js`. It requires
`nNote.secret` (the spent note's own nullifier key) and returns `nk` and the exact `lockLeaf` it
binds in the kernel — build a submission straight from its return value; nothing needs to be
reattached.

### Step C — claim: recipient spends the stealth lock into their own note

Guest op `OP_STEALTH_CLAIM` (opcode 24), submitted the same way — a `pool.settle()` call carrying a
new SP1 proof:
- Recipient proves membership of the lock leaf under `owner_pub` and a BIP-340 signature under the
  one-time private key `b + s` (`b` = recipient's static spend key, `s` = shared secret they derive
  from the sender's published ephemeral key `E`).
- Mints an ordinary note `M = amount − fee` under a key the recipient chooses (their own ordinary
  spend key, not the one-time key) — `fee = 0` for a self-submitted claim, `fee > 0` if relayed.
- JS builder: `buildStealthClaim` in `dapp/confidential-stealth.js`.

There is also `OP_STEALTH_REFUND` (opcode 25, `buildStealthRefund`) — lets the **sender** reclaim
the locked value after `deadline` if the recipient never claims (typo/dead-address safety net). Not
part of the happy path but worth exercising in any test flow.

### Step D — unwrap: recipient converts their private note back to plain ETH

Guest op `OP_UNWRAP` (opcode 2). JS: `unwrap({ note, walletPriv, recipient, feeOpts })` in
`dapp/confidential-pool-ux.js` (a thin wrapper around `buildUnwrap`), which also submits via
`settle()`. This burns the note and pays plain ETH to `recipient` (any EVM address), optionally
paying a relayer fee for a gasless exit.

`OP_WRAP_TRANSFER` (opcode 27) and `OP_SEND_AND_UNWRAP` (opcode 28) also exist, for a normal,
*interactive* private send/exit — but they are **not** what a non-interactive
send-to-a-possibly-offline-recipient needs. That specifically requires the stealth lock/claim ops
above, because they gate spending on a signature the sender cannot produce, rather than merely on
knowledge of a blinding factor the sender does know.

## 4. Generating and submitting proofs

**Not in the browser, for any op in this document — wrap, stealth lock/claim/refund, unwrap, or an
L2 exit (§7).** Every one of them needs an SP1 Groth16 proof, and this stack's prover goes through
native Rust + gnark (a Go library with FFI bindings), needing on the order of 20–30GB RAM even in
CPU-only mode — there is no WASM/browser build of it, and gnark isn't realistically portable to one.
The browser's role is only witness assembly (the JS kernel/commitment/PoK math in
`dapp/confidential-*.js`); the proof itself always comes from a native process, one of the two below.

### Fully local, no Succinct network required

The box harnesses for these ops —
`contracts/sp1/confidential/harnesses/exec-stealthlock.rs`, `exec-stealthclaim.rs`,
`exec-stealthrefund.rs` — build the prover client with `ProverClient::builder().cpu().build()`
(**`.cpu()`, not `.network()`**) and prove with `.groth16().run()`. There is no
`NETWORK_PRIVATE_KEY` or Succinct payment involved; it is native-gnark on the local CPU. Run mode is
an env var: `MODE=execute` (default — executes + prints cycle count, no proof) or `MODE=groth16`
(actually proves; writes proof artifacts).

This is real Rust/SP1 tooling — proving entirely yourself means building and running these harness
binaries (`cargo run --release --bin exec-stealthlock`, etc., with `MODE=groth16`), not just calling
a REST endpoint. RAM: the CPU/native-gnark path needs no GPU but budget on the order of 20–30GB for a
comfortable Groth16 run; validate on your own hardware (`MODE=execute` first to sanity-check the
circuit executes, then `MODE=groth16`).

### Using Tacit's relay instead of a local prover

`worker/src/index.js` and `worker/src/confidential-settle.js` implement the relay:

```
POST /confidential/submit  {type, op, memos?, mode?}
GET  /confidential/status?id=
```

- `type` must be one of the allowlisted op names, which includes `'stealthlock'`, `'stealthclaim'`,
  `'stealthrefund'`, `'wrap'`, `'unwrap'` (`worker/src/confidential-settle.js`).
- `mode: 'settle'` (default) — the relay's own prover box proves AND submits `settle()` on-chain for
  you.
- `mode: 'prove'` — the relay box proves only; `GET /confidential/status?id=` then answers
  `status: 'proven'` with `{publicValues, proof}` (the field is named `proof`, not `proofBytes` —
  `proofBytes` is only the name of `settle()`'s Solidity parameter) for you to embed in your own
  `ConfidentialRouter`/`ConfidentialPool` transaction (rate-limited per source IP on this path,
  since it prepays a prove cycle with no on-chain footprint to recover it from). Job ids are the
  hash of `{type, op, mode}`, so re-submitting the same witness returns the same job rather than
  proving twice.
- Both routes accept requests from **any origin** in the worker source (`corsHeaders` special-cases
  `/confidential/submit` and `/confidential/status`, commit 6e108796) — they are already
  permissionless (a bad witness just fails to prove) and IP rate-limited server-side, so a browser
  can call them directly with no backend proxy. **That change ships with the next `wrangler
  deploy`:** as of 2026-09-06 production still answers the preflight with
  `access-control-allow-origin: https://tacit.finance`, so a third-party page's fetch is blocked
  until the worker is redeployed. Check the preflight from your own origin before assuming either
  state.
- Gated on the worker's `CONFIDENTIAL_SETTLE=1` config flag — confirm with the operator that it's
  set for the environment you're calling before depending on it.
- **Relay tips** are armed per-asset in the deployed settle guest: the tip is read per intent and
  bound into the PoK context, then paid to `msg.sender` on settle. That is what makes `mode:
  'settle'` economically self-sustaining rather than a favor — the relayer is paid in-proof, with no
  separate on-chain approval from the user. A self-submitted proof simply sets tip 0.
- **Fee floor:** there isn't an enforced one by default. `submitJob`'s profitability gate
  (`worker/src/relay-quote.js`'s `floorWei`/`passesFloor`) is wired in but OFF unless the operator
  sets `RELAY_FEE_FLOOR="1"` in the worker's config, so a `mode:'settle'` submit is accepted at any
  offered fee — including zero — until that's turned on. If it is turned on, the exact formula is
  `floorWei = (300000 + 30000×effects) × gasPrice × (1+marginBps/10000)` (default margin 1000 =
  10%), gating `transfer`/`unwrap`/`sendunwrap`/`bridgeburn`/`lp`/`lpremove`/`lpbond`/`route` paid in
  cETH specifically; every other op type or fee asset stays ungated regardless. Confirm the current
  setting with the operator rather than assuming either state.

This is the practical path for a low-stakes integration test: build the `op`/`memos` payload
client-side using the JS builders referenced above (`dapp/confidential-stealth.js`,
`dapp/confidential-pool-ux.js`), then POST to `/confidential/submit` instead of running your own SP1
toolchain.

### Running your own relayer, not just using Tacit's

Self-proving a single op (above) covers a client submitting its own ops. Standing up an equivalent
*service* — a queue other users can submit to, with something else proving and settling on a
schedule — is a different, larger thing, but every piece for it already exists in this repo:

- **The job queue is portable, not Cloudflare-specific.** `worker/src/confidential-settle.js`'s
  `makeConfidentialSettler({ storage, hash, now, feeGate })` only needs a KV-shaped `storage`
  (`getPending/putPending/getJob/putJob`) — swap in any key-value store and the queue logic
  (submit/dedup/claim/TTL-reclaim/ack, plus the optional fee gate from `relay-quote.js`) comes with
  it unmodified.
- **The HTTP surface is a thin, copyable pattern.** `worker/src/index.js`'s
  `handleConfidentialSubmit`/`handleConfidentialJob`/`handleConfidentialAck`/`handleConfidentialStatus`
  are each parse-JSON/call-one-settler-method/return-JSON — straightforward to reimplement over any
  HTTP framework if Cloudflare Workers isn't your stack. The box-only routes (`job`/`ack`) gate on a
  static bearer token; your own deployment picks its own.
- **The proving loop is a working, runnable script today:** `ops/scripts/confidential-settle-loop.sh`.
  It polls `/confidential/job`, drops the op JSON into the matching harness fixture (the same
  `exec-*` binaries above), proves, and either `cast send`s `settle()` directly (`mode:'settle'`) or
  acks the proof back for the caller to self-submit (`mode:'prove'`). As written it assumes an NVIDIA
  GPU box; every `exec-*` harness defaults to `.cpu()` already, so a CPU-only version of the same loop
  is the same script with the GPU-specific bootstrap (`fresh_gpu`) removed — just slower per proof.

Put together — your own KV, the four HTTP routes, and a box running that loop with your own funded
settle key — you have a relayer with zero dependency on Tacit's, proving the exact same guest and
verified by the exact same on-chain `PROGRAM_VKEY`, so it settles interoperably with Tacit's own
relay from day one.

## 5. How a recipient detects a payment (stealth scan)

Standard one-time address / dual-key stealth scheme:

- Recipient publishes a static spend pubkey `B = b·G`.
- Sender draws an ephemeral keypair `(e, E = e·G)` per payment, computes shared secret `s = H(e·B)`,
  and the one-time pubkey `O = B + s·G`. `O` is what actually receives the stealth lock; `E` is
  published in the op's memo.
- The recipient's one-time private key is `b + s`, but only the recipient can compute `s` (as
  `H(b·E)`, using their private `b`) — the sender knows `E` and `s` but never learns `b`, so they
  cannot derive `b + s` and cannot claim their own lock.
- The recipient watches the pool's shared lock-set, and for every stealth lock's published `E`,
  computes `s = H(b·E)`, `O' = B + s·G`, and checks whether `O'` matches the lock leaf's
  `owner_pub`. A match means it's theirs; they then decrypt the payload from the memo and submit
  `OP_STEALTH_CLAIM`. Client-side helper: `dapp/confidential-stealth.js` (op assemblers) is where
  this trial-decryption / one-time-key derivation logic lives.

### There is no lock-set event — scan `settle()` calldata instead

`ConfidentialPool` never emits a lock event. `LeavesInserted(firstLeafIndex, bytes32[] leaves,
bytes[] memos)` carries only the ordinary note tree's `pv.leaves` — a pure `OP_STEALTH_LOCK` settle
mints no note leaf, so `leaves` is empty for it. Lock leaves (`pv.lockLeaves`) and the lock-set root
(`pv.lockSetRoot`) live only in the `settle()` transaction's `publicValues` **calldata**, decoded via
`abi.decode` into the contract's `PublicValues` struct. A scanner has to walk `settle()` transactions
and decode that struct, not filter logs for a lock event that doesn't exist.

**Finding which transactions to decode** doesn't need scanning every transaction to the pool address
(there is no cheap RPC filter for "all txs to X"; `eth_getLogs` only indexes event topics).
`LeavesInserted` fires on **every** `settle()`, including a lock-only one with an empty `leaves`
array and only lock-memos in its `memos` tail — so the ordinary note-scan a client already runs
(`eth_getLogs` for `LeavesInserted`/`NullifiersSpent` from the pool's deploy block) already surfaces
every relevant transaction hash, even though it says nothing about locks itself. For each such tx
hash: `eth_getTransactionByHash`, take `.input`, decode it as `settle(bytes,bytes,bytes[])`'s first
argument (`publicValues`), then read the `PublicValues` tuple by field index — field 4 = `leaves`,
field 16 = `lockSetRoot`, field 17 = `lockLeaves` (an ABI tuple head is one slot per field, so this
works without decoding the nested struct types). Reconstruct the lock-set tree by inserting every
settle's `lockLeaves` in the same block+logIndex order the note scan already walks in (`eth_getLogs`
returns ascending order). There's no worker/relay endpoint that does this walk server-side today — a
client does it itself, once, over the same log stream it already fetches.

**The memo tail:** `settle()` requires `memos.length == pv.leaves.length + pv.lockLeaves.length` —
so per settle, the first `leaves.length` memos are ordinary note memos (what a note scan already
consumes) and the remainder are lock memos, in `lockLeaves` order. The memo **byte layout inside
that tail is a pure dapp/off-chain convention** — the contract only checks memo *count* and a
hash-of-memos commitment, never memo content — so different senders could in principle use different
memo formats, and a generic scanner can't assume one without also knowing (or trying) the format the
sender used. The only implemented sender in this repo, `dapp/confidential-airdrop.js`
(`sealStealthMemo`/`openStealthMemo`), uses wire form `ephemeralPub(33) ‖ ciphertext(112)`,
ciphertext = `xor(asset(32) ‖ amount_be8(8) ‖ lBlinding(32) ‖ deadline_be8(8) ‖ refundPub(32))` — it
carries `lBlinding`, which is what actually lets a claim spend the lock (not just discover it).

## 6. Known limitations and open gaps

- This touches **live mainnet contracts** handling real ETH, against an **immutable**,
  previously-audited pool contract. Keep test amounts small; there is no way to patch the deployed
  contract if something is wrong.
- **Do not hardcode any address or vkey long-term.** Re-pull
  `dapp/confidential-deployments.generated.js` (or ask the Tacit team for the current live address)
  at actual integration time, not from this document. See "Detecting a new generation" below for how
  to notice a redeploy without hand-tracking every pinned constant.
- **No stealth lock has ever settled on the live pool.** Every crypto primitive in this document is
  verified against synthetic fixtures and the real, currently-deployed guest ELF — the box harnesses
  in §4 print `EXECUTE_OK` for lock, lockbatch, claim, and refund, matching the live pool's pinned
  vkey — but prove one small real lock→claim before routing meaningful value through this path,
  exactly as you would for any code path with zero production mileage.
- **The dapp's own "Confidential Send" tab now implements this flow directly** — pasting a third
  party's Tacit address there routes through the exact same `dapp/confidential-pool-ux.js`
  `stealthSend`/`scanStealthLocks`/`stealthClaim`/`stealthRefund` functions this document describes,
  with a "Claim payments sent to you" panel (scan + claim) and a "Your pending sends" panel (refund
  after the deadline). This document is still the right reference if you're building your own
  integration rather than driving tacit.finance directly — the wire formats and functions are the
  same either way, just called from your own UI instead of the dapp's.
- The relay's `/confidential/submit` being "permissionless" means a malformed witness simply fails
  to prove — it does not put funds at risk from a bad request, but also means there is no support
  contract backing the endpoint's uptime; treat it as best-effort for a kick-the-tires integration,
  not a production dependency, unless the Tacit team confirms otherwise.
- `OP_STEALTH_REFUND` exists precisely because sends can go unclaimed (wrong pubkey, offline
  recipient forever, etc.) — plan your test flow to also exercise/verify the refund path before the
  `deadline`, in case the "happy path" claim doesn't get exercised in time.
- This document covers Ethereum only; the same stealth-lock/claim machinery is also used for a
  Bitcoin→Ethereum cross-chain variant (`OP_BRIDGE_STEALTH_MINT`, opcode 26), out of scope here.
- **Not built yet, if you're looking for either:** a read-only leaves/nullifiers endpoint on the
  worker (to escape public-RPC `eth_getLogs` limits — the calldata-scan algorithm above works
  without one, just against a client's own log fetches) and an "activator watch" service that would
  auto-complete a relayed L2 exit without the user needing to return and press activate (see §7).
  Both are reasonable additions; neither is a client-side blocker today.

### Invoices: a separate, already-working third-party payment path

Not stealth-send, but worth knowing about as the alternative when the recipient can publish a
request first: `dapp/confidential-invoice.js` lets a recipient derive a note and publish an
**invoice** — the commitment, deposit/leaf ids, a memo sealed to themselves, and a pre-signed
consume witness, with no raw blinding or secret. The payer wraps public funds straight to the
invoice's commit; the recipient's note settles without the payer ever learning the note's opening.
`invoice.v` is a version field (`verifyInvoice` rejects anything but `v:1`) — treat the current field
set (`chainBinding, assetId, underlying, ticker, amount, value, cx, cy, owner, commit, depositId,
leaf, memo, witness`) as stable; a breaking change would bump to `v:2` rather than reshape `v:1` in
place. There is no separate deep-link/URL encoding — an invoice today is a plain JSON object, shared
as text. If you need a URL form, wrap the same `v:1` object rather than inventing a parallel shape,
to stay interoperable with other frontends doing the same.

### Detecting a new generation without hand-tracking every pinned constant

Rather than diffing a list of hash-domain strings by hand, use the fact that `chainBinding =
keccak256(chainId ‖ poolAddress)` is already baked into every sigma/kernel/PoK context this pool
checks (wrap, transfer, unwrap, stealth lock/claim/refund — all of them). A new generation always
means a new pool address, so every previously-valid `chainBinding` — and everything built against it
— stops verifying automatically the moment the address changes; there's no scenario where a
generation changes silently under a fixed address. So "has anything pinned changed" reduces to "has
`cfg.pool` changed," which is exactly what `dapp/confidential-deployments.generated.js` records per
redeploy. Watch that file (or just the pool address) for your change notice. If you want to read the
actual pinned formulas directly: note/owner/nullifier derivation and every `intentContext` tag are
in `dapp/confidential-pool.js`; the kernel/range-proof domain in `dapp/confidential-transfer.js`; the
note-memo byte layout in `dapp/confidential-memo.js`; the stealth-lock domains and lock-memo layout
in `dapp/confidential-stealth.js`; the leaf hash and exit-recipe ABI encoding in
`contracts/src/ConfidentialPool.sol` and `dapp/confidential-router.js`'s `encodeExitRecipe`.

### 6a. Bitcoin-lane gate — matters even though this doc is ETH-only

Do not enable an ETH→BTC `crossOut` path on gen1 yet, and do not let a UI expose one.

`bitcoinConsumedCount` and `crossOutCount` both read zero on gen1. If a `crossOut` lands while
`bitcoinConsumedCount` is still 0, the reflection fold **freezes permanently for that pool** —
unrecoverable without another full redeploy. The counter is seeded by one real Bitcoin-homed
fast-lane consume, which must happen first.

This does not constrain anything else in this document: wrap / stealth-send / claim / unwrap never
touch that counter. It only constrains adding a Bitcoin bridge button to the same UI.

## 7. Exiting to an L2 (Base and other OP-Stack or Arbitrum-Orbit chains)

This is another `settle()`-proved op underneath — the same "not in the browser, self-hosted prover
or Tacit's relay in prove-only mode" constraint from §4 applies here too, not just to wrap/lock/
claim/unwrap.

A shielded note can exit directly into a canonical L2 bridge in one atomic transaction — no new
contract, using the existing `ConfidentialRouter.exitAndExecute` recipe escrow:

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

Base L1StandardBridge `0x3154Cf16ccdb4C6d922629664174b904d80F2C35` (its `OTHER_BRIDGE()` is the L2
predeploy `0x42…0010`). L1→L2 credit lands in ~1–3 minutes.

Three things that will bite:
- `depositETH`/`depositERC20` are `onlyEOA` and **revert for a contract caller**. The escrow is a
  contract, so only the `…To` variants work. `buildBridgeExit` uses those.
- `l2Token` is per-chain and is never defaulted — a wrong value is a permanent misdelivery. Source
  it from that chain's token list / `OptimismMintableERC20Factory`.
- Never use the ephemeral escrow as a refund address. It is a one-shot clone at `keccak(recipe)`;
  anything refunded there later needs a separate `reclaimExit` to rescue. (Relevant for
  Arbitrum-style retryables, which do refund; OP deposits do not.)

For an Arbitrum-Orbit destination (e.g. Robinhood Chain) via `buildArbitrumBridgeExit`, the retryable
ticket's gas parameters (`gasLimit`, `maxSubmissionCost`, `maxFeePerGas`) should come from a live
quote against the chain's own `NodeInterface.estimateRetryableTicket` and the `Inbox`'s submission-fee
function — see `scripts/confidential-exit-robinhood.mjs`'s `quoteRetryableGas`. That estimate call
can use an approximate `l2CallValue` rather than the final one (the script itself estimates against
roughly half the note's net value, since the final value isn't known until after the estimate and fee
overhead are subtracted from it): `estimateRetryableTicket`'s gas figure is about L2 execution cost
for a plain value-transfer destination, not sensitive to the exact amount. Only the final recipe
construction needs the exact `l2CallValue`.

One thing the estimate IS sensitive to: `estimateRetryableTicket(sender, deposit, to, l2CallValue,
…)` simulates the ticket as if `sender`'s L2 alias had just been credited `deposit`, and the node
rejects the simulation with `insufficient funds for max submission fee` / `insufficient balance for
transfer` when `deposit` does not cover `l2CallValue` plus the submission fee. The script passes
`deposit = l2CallValue`, which only works because the router's alias
(`0x111100004C5Bf191225F9049b385d6F3820e1aCD`) happens to hold ETH on Robinhood Chain from earlier
tests. A client with no such balance should do what the Arbitrum SDK does and pass a large pretend
deposit (`1 ETH + l2CallValue`); the gas figure is the same either way (~21.2k for a plain credit).

**Privacy boundary:** the exit, the amount, and the L2 recipient are all public on L1. This is
"shielded accumulation, then exit anywhere" — not a private cross-chain transfer. Do not describe it
to users as the latter.
