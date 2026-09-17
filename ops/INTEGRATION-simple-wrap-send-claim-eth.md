# Integration handoff: wrap ETH → confidential stealth-send → claim → unwrap

Status: engineering handoff, ETH-only (no Bitcoin/cross-chain leg). Last reviewed against mainnet
2026-09-14 for the **gen4** pool. **Do not hardcode any address, vkey, or code pointer from this
document into long-lived config** — re-check the live manifest and this repo at actual integration
time (see §6, "Known limitations"). This project has redeployed multiple times; every generation is
a fresh, immutable address set.

**gen5 update (2026-09-18):** gen5 is now the live generation on mainnet (deploy block 25998736) —
see `docs/DEPLOYMENTS.md` for the current address/vkey table. The gen4 addresses and counters below
are a dated snapshot, kept for reference only; this document's own standing rule applies as always —
re-check the live manifest before hardcoding anything.

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

The **gen4** suite (live since 2026-09-08). Canonical source is the manifest
`contracts/deployments/1-createx.json`:

```
mainnet.pool              = 0x0000000098A73197B3255aD9db1ed8544410f5Ba
mainnet.router            = 0x00000000F104E2C1ebe9693eD19491b9897a8193
mainnet.collateralEngine  = 0x000000008cAD17f5BB485A7D521E89A9C4716cC0
mainnet.assetFactory      = 0x0000000042c2D57499Df64BAF81bfA2C6E100535
mainnet.relayer           = 0x00000000705D345449950e900271F27E7fEEABc5
mainnet.btcCallExecutor   = 0x00000000f448614cc7b5152f108471f020a97D13
```

`dapp/confidential-deployments.generated.js` is the dapp's own pointer at these addresses —
regenerate it with `node tools/sync-deployment-config.mjs contracts/deployments/1-createx.json
--network mainnet --write` (dry-run without `--write`) if it looks stale. Read the manifest, not
this document, as truth.

The `router` is the convenience entry point for wrapping native ETH in one tx
(`contracts/src/ConfidentialRouter.sol`); the `pool` is the canonical settlement contract
(`contracts/src/ConfidentialPool.sol`) that all proofs ultimately settle against.

### 2a. The native-ETH asset id — the single most common integration mistake

Native ETH is **tETH** on-chain: an escrow-backed asset carrying a Bitcoin cross-chain link. (The
current dapp UI labels this asset "cETH" — same id, same asset, purely a display relabel; the
trustless/on-chain name has stayed tETH since original launch and is what you'll see in the
contract's own events/errors.) This id is **stable across every generation**, so it does not change
on a redeploy the way the pool/router addresses above do. When an asset has a link, `_register` keys
the registry by the **shared link id**, NOT by the local `evmAssetId(0x0)`:

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
- Both routes accept requests from **any origin** (`corsHeaders` special-cases `/confidential/submit`
  and `/confidential/status`, commit 6e108796) — they are already permissionless (a bad witness just
  fails to prove) and IP rate-limited server-side, so a browser can call them directly with no backend
  proxy. **Live in production as of 2026-09-06** — the actual server is `tacit-api` on Render (a plain
  Node process running this same worker source, not Cloudflare — the `worker/` Cloudflare Worker in
  this repo is a legacy/optional standalone deploy, not what's live), which needed its own manual
  redeploy to pick this up; that redeploy has happened and both routes now answer any origin. Still
  worth a quick preflight check from your own origin before depending on it, since this is a manual
  deploy, not an auto-deploying one.
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
- **`GET /confidential/quote?asset=<ticker-or-0xassetId>`** — read the relay's current fee policy for
  one asset directly, instead of mirroring the worker's own `RELAY_FEE_ASSETS`/`QUOTE_RELAY_FEE_ASSETS`
  table client-side (which can drift out of sync with whatever the operator actually has configured).
  Response shape (`worker/src/index.js`'s `handleConfidentialQuote`):
  ```jsonc
  // Asset not relay-fee-eligible at all (caller must self-settle):
  { "ticker": "cTAC", "assetId": "0x...", "relayFeeEligible": false }
  // Asset IS eligible:
  {
    "ticker": "cUSD", "assetId": "0x...", "relayFeeEligible": true,
    "staticFloorUnits": "<in-system units>",   // the configured floor, in this asset's in-system units
    "gasAwareFloorUnits": null                 // non-null ONLY for cETH — a live, gas-price-derived floor
  }                                             // that can exceed staticFloorUnits when gas is elevated;
                                                 // for every other asset this is always null (no ETH→token
                                                 // oracle wired here, so only the static floor applies)
  ```
  Always use `max(staticFloorUnits, gasAwareFloorUnits ?? 0)` as the actual floor to quote a user — this
  mirrors `gasAwareMinFee` in `confidential-pool-ux.js` exactly, so a client reading this endpoint stays
  in lockstep with what the relay itself will actually accept. **Confirmed live in production
  2026-09-14** — e.g. `GET /confidential/quote?asset=cETH` currently returns
  `{"ticker":"cETH","assetId":"0x3cba71e1...","relayFeeEligible":true,"staticFloorUnits":"10000",
  "gasAwareFloorUnits":"5230"}`; cUSD/cTAC return a static-only floor (`gasAwareFloorUnits: null`, per
  the cETH-only gas-aware path described above).

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
- **The proving loop is a working, runnable script today — two variants:**
  - **`ops/scripts/confidential-settle-loop-lite.sh` (recommended for most self-hosters).** No GPU, no
    Rust/SP1/gnark toolchain — `ops/scripts/setup-relay-lite.sh` downloads the prebuilt
    `prover-bins-<N>` release binaries and that's the whole setup. Every proof runs against the
    Succinct NETWORK prover (real $PROVE cost per proof, no local heavy compute), so a plain ~2 vCPU /
    4GB box is enough. This is genuinely how Tacit runs its own fallback relay capacity, not a
    stripped-down demo version.
  - **`ops/scripts/confidential-settle-loop.sh` (build from source).** Rebuilds the harness for each
    job against your own local guest ELF via `cargo build`, so it's the right choice if you want to
    build the prover yourself rather than trust a released binary, or if you're running local CUDA
    proving instead of the network prover. Needs the full SP1 toolchain (`sp1up`, plus a native-gnark
    build chain if going the local-CPU-groth16 route: libclang, Go, protoc). If you go the network
    route with your own rebuilt harness, `NETWORK_RPC_URL` must be the auction endpoint
    (`https://rpc.mainnet.succinct.xyz`) — the Reserved endpoint returns `Unimplemented` for every
    network prove call.

Both poll the identical job queue and are safe to run side by side with each other or with Tacit's
own relay — jobs are claimed with a short race-narrowing window (a claim nonce + a brief re-read; see
`confidential-settle.js`), so more than one poller on one queue wastes at most an occasional duplicate
proof, never funds (the contract's own nullifier/deposit-status checks reject a duplicate settle
outright).

Put together — your own KV, the four HTTP routes, and a box running either loop with your own funded
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
(there is no cheap RPC filter for "all txs to X"; `eth_getLogs` only indexes event topics). But
`LeavesInserted` does **not** fire on every settle — `ConfidentialPool.sol` emits it only inside
`if (pv.leaves.length != 0)`. A lock-only settle that ALSO spends a note (no ordinary leaves, but a
nonzero `pv.nullifiers`) still emits `NullifiersSpent`, so the ordinary note-scan a client already runs
(`eth_getLogs` for **both** `LeavesInserted` and `NullifiersSpent` from the pool's deploy block) still
surfaces it. But a lock-only settle that spends NOTHING (no ordinary leaves, no nullifiers — the pure
`OP_BRIDGE_STEALTH_MINT` case, §6a's cross-chain variant) emits no pool event at all, so **no log-driven
scanner can discover that transaction**, full stop — the only way is scanning every tx to the pool
address directly, which nothing in this codebase does today.

For each transaction the log stream does surface: `eth_getTransactionByHash`, take `.input`. It carries
one of two shapes — a direct `settle(bytes,bytes,bytes[])` call (one `publicValues` blob), or a batched
`TacitRelayer.relaySettle(...)` call (either overload) carrying an ARRAY of `SettleCall{publicValues,
proof,memos}` tuples, since the relay can bundle several ops' settles into one tx. Route on the 4-byte
selector to tell them apart, then decode publicValues (one, or each element of the batch) the same way
either way: read the `PublicValues` tuple by field index — field 3 = `nullifiers`, field 4 = `leaves`,
field 16 = `lockSetRoot`, field 17 = `lockLeaves`, field 18 = `lockNullifiers` (an ABI tuple head is one slot per field, so this works
without decoding the nested struct types).

**Calldata alone does not prove a call landed.** `TacitRelayer._relay` wraps each inner
`POOL.settle(...)` in `try`/`catch` and silently skips a failed one — so a relaySettle batch's calldata
can carry a call that never actually executed, and trusting it anyway inserts a phantom lock leaf that
diverges the rebuilt `lockSetRoot` from the real one. Corroborate each decoded call against an event
that transaction actually emitted before counting its `lockLeaves`: a `LeavesInserted` with the exact
same `leaves` **and** `memos` (only possible when the call has ordinary leaves), or, for a lock-only
call, a `NullifiersSpent` with the exact same `nullifiers`. A lock-only call that also spends nothing
has no event to corroborate against at all — see the paragraph above; that's the same fundamental gap,
not a separate one. Reconstruct the lock-set tree by inserting every corroborated call's `lockLeaves`,
in the same block+logIndex order the note scan already walks in (`eth_getLogs` returns ascending order;
within one relaySettle tx, calls execute — and their corroborating events fire — in the batch's own
array order). A client can do this walk itself, once, over the same log stream it already fetches —
`dapp/confidential-lock-scan.js`'s `scanLockLeaves` implements exactly this (selector routing, batch
decoding, and corroboration) if you'd rather import it than reimplement it from this description — or
read it already walked from the relay:

**`GET https://api.tacit.finance/confidential/index?from=<seq>&limit=<≤1000>`** (CORS-open, rate-limited
like `/reflection/dump`) serves the mainnet pool's rows in chain order behind one cursor: `leaves`
(`first`, `leaves`, `memos`), `nullifiers`, `wrap` (`depositId`, `assetId`, `amount`), `crossOut`, and
`locks` (`first` = lock index of its first leaf, `lockLeaves`, `lockMemos`, and `lockNullifiers` — field
18, what a claim or refund spends), each with `block`, `tx`, `logIndex` and its `seq`. A `locks` row
follows the event that corroborated its call, so inserting `lockLeaves` in row order rebuilds the lock
tree. Page with `from = next` until `next == total`; `synced: false` means it is still catching up to
`headBlock` (it trails the head by 6 blocks) — read again. It re-serves public chain data with the same
one gap as above (a lock-only call that spends nothing is invisible to it too); a client that wants no
trust in it rebuilds the identical rows from the logs and calldata as described.

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
- **A full lock→claim and a full lock→refund have now settled for real on the live pool** (2026-09-05):
  [lock](https://etherscan.io/tx/0x20d46c1d47865dc8e906494c57b6d6abe9d2e7b577471864c93df5fd23ce2b0d) →
  [claim](https://etherscan.io/tx/0xa34ab7589fe37137d3859f1eefa625c4b8a4ef06932ea89641290f3887be3947),
  and a separate
  [lock](https://etherscan.io/tx/0x2cdc3e684d91344bedb7d4eaf688d78222bed866da2c75dd75e9a802f4b4ef38) →
  [refund](https://etherscan.io/tx/0xfbaf5e94adca4fb40bd5606e763ea88508a81e06eef044cf3d6c5ea3c4ef53e8)
  after the lock's deadline. Every op variant (lock, lockbatch, claim, refund) also has a genuine
  Groth16 proof verified on-chain against the live pool's pinned vkey in isolation
  (`contracts/test/ConfidentialStealthLock{,Batch}ProofReal.t.sol`,
  `ConfidentialStealthClaimProofReal.t.sol`, `ConfidentialStealthRefundProofReal.t.sol`).
  **Two real bugs surfaced only by that live round trip, both now fixed** — re-pull if you copied
  either piece before 2026-09-05:
  1. `dapp/confidential-lock-scan.js`'s `decodePublicValuesLockFields` misread `publicValues` — the
     contract does `abi.decode(publicValues, (PublicValues))`, and because `PublicValues` contains
     dynamic fields, ABI rules encode it as a one-element tuple: the bytes open with an extra offset
     word pointing at the struct's own encoding, before any of its fields. Skipping that word is
     required. Every synthetic test fixture (including this repo's own) passed regardless, because
     the encoder used to build them shared the same wrong assumption — if you wrote your own decoder
     from this document's §5 rather than importing `confidential-lock-scan.js` directly, check it
     against this exact gotcha.
  2. `stealthClaim`/`stealthRefund`'s BP+ range proof (`mRange`/`oRange`) must be hex-encoded before
     it's put on the wire — `buildStealthClaim`/`buildStealthRefund` in `confidential-stealth.js`
     return it as raw bytes (by design, matching every other op builder's convention), and it's the
     caller's job to hex it at the wire boundary, same as every other op's range proof already does.
     Sent as raw bytes, `JSON.stringify` silently turns it into a numeric-keyed object no box harness
     can parse as a proof witness.
  **More real bugs, found by an external integrator (zSwap) and fixed 2026-09-14 — re-pull if you
  copied any of these pieces before then:**
  3. `buildSendUnwrap` (`confidential-stealth.js`) dropped the spent note's `nk` when building its
     `input` object, forwarding only `secret` — the harness (`exec-sendunwrap.rs`) reads `inp["nk"]`
     and panics without it. Confirmed fixed via a real `MODE=execute` run against the released
     harness (no panic, correct payout).
  4. Every `exec-*.rs` settle harness except `stealthlock`/`stealthclaim`/`stealthrefund`/
     `stealthlockbatch`/`bridgestealthmint`/`batchtransfer`/`wrap` hard-coded `keccak256("")` memo
     hashes directly in source, relying on a separate deploy-time patch script
     (`patch-harnesses-network.sh`) to swap in the real ones. A self-hoster building any of the other
     ~30 ops from source (including `transfer`/`wraptransfer`/`sendunwrap`/`cbtcmint`) got
     `MemoLeafMismatch` on every settle. Fixed by committing the same real-memo-reading logic those
     seven harnesses already had directly into every remaining harness's source.
  5. `_dispatch`'s relay-settle path (`confidential-pool-ux.js`) built its own memos locally via
     `guard.sealMemosForOutputs` + `assertOutputsRecoverable` for every op with outputs, then never
     forwarded them into `relay.submitOp` — which resealed with a fresh ephemeral key before
     shipping. Both seals were valid/recoverable (sealing is deterministic in everything but the
     ephemeral randomness), so nothing was ever unspendable, but the locally-checked memo was never
     the one that actually settled. Fixed by passing the already-sealed memos through, matching what
     `wrapAndSend`'s calldata path already did.
  6. `confidential-lock-scan.js` only recognized direct `pool.settle()` calldata. A stealth
     lock/claim/refund settled through `TacitRelayer.relaySettle`'s batching (a real, live path —
     see `worker/src/confidential-settle.js`'s `feeAsset` comment) has a completely different outer
     ABI shape, so the scanner silently skipped it — and, separately, a batch of several lock-bearing
     calls in one relaySettle tx fired `LeavesInserted` once per inner call, which the scanner's
     per-txHash dedup then collapsed to just one anyway. Fixed by routing on the actual 4-byte
     selector (decoding every `SettleCall` a relaySettle batch carries) and grouping by tx for a
     single input fetch without dropping the rest of that tx's calls.
  7. `openStealthMemo` rejected anything but exactly 145 bytes, which blocked a sender from
     appending their own self-sealed tail (e.g. a refund-recovery record, so an unclaimed lock's
     refund is recoverable from the sender's key alone rather than local storage). Fixed to accept
     145+ bytes, decoding only the fixed-length prefix and ignoring any tail.
  8. `transfer`/`wrap-transfer`/`send-and-unwrap`'s change output, `stealthClaim`/`stealthRefund`'s
     claim/refund output, and LP add/remove/swap/route's minted outputs all reused the wallet-constant
     `identity().owner` instead of a fresh per-note key the way the recipient output already does —
     letting a relay link every one of a wallet's ops by that one constant owner. Fixed to derive a
     fresh owner per output everywhere (deterministically where an op already relies on deterministic
     retry-dedup, e.g. send-and-unwrap's change; randomly elsewhere). The LP/swap/route fixes
     (`buildWrapLpOp`/`buildWrapSwapOp`/`lpAdd`/`lpRemove`/`route` in `confidential-pool-ux.js`) were
     checked against the guest's own `intent_context` calls in `contracts/sp1/confidential/src/main.rs`
     before touching anything, since several of those bind `owner` into a sigma-proof context rather
     than a plain leaf hash — in every case the guest reuses the SAME free-choice output owner in its
     extra context tuple (e.g. wrap_lp's `(lp_asset, pid, s_owner)`), never a separate caller-identity
     binding, so varying it independently of `id.owner` is safe. `confidential-lp.js`/
     `confidential-route.js` themselves needed no changes — `shareOwner`/`aOwner`/`bOwner`/`outOwner`
     were already plain caller-supplied parameters; only their callers were reusing a constant.
- **A full Bitcoin→Ethereum bridge-mint has now settled for real on the live pool** (2026-09-14):
  a reflected note was burned on the Bitcoin side (`fold_burn`, recorded into `bitcoinBurnRoot`), then
  a separate `OP_BRIDGE_MINT` settle proved membership of that burn and credited the destination note
  on Ethereum —
  [settle](https://etherscan.io/tx/0x971a19bc13f8dbde456964eb22165f44154c15839b40f019df59bdbb8691adeb).
  The emitted `LeavesInserted`/`NullifiersSpent` events matched an independently-computed destination
  leaf and burn-membership nullifier exactly. The destination note in this run was seed-derived
  (`pool.deriveNote(walletPriv, asset, index)`), so its settle carried an **empty memo** — the guest
  commits `keccak256(memo_i)` into `pv.memoRoot` per output, and a seed-derived output that nobody
  needs a memo to recover is proved against `keccak256("")` the same way `contracts/sp1/confidential/harnesses/exec-bridgemint.rs`'s
  `CP-04` fixture convention already established; the same convention the dapp's own
  `confidential-recovery-guard.js` calls `seedDerived: true`. A bridge-mint crediting a
  freshly-random (not seed-derived) owner needs a real sealed memo instead — build it with
  `dapp/confidential-memo.js`'s `sealMemo(ownerPubHex, note, ephRand)` and feed its
  `keccak256(encodeMemo(...))` into the fixture's `memoHashes` array before proving, since the
  memo content must be committed by the guest at proof time — supplying a real memo to `settle()`
  against a proof that committed a *different* placeholder hash reverts with `MemoLeafMismatch()`,
  it cannot be swapped in after the fact.
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
- **Built 2026-09-14 — an owned-notes / membership-witness lookup for Bitcoin-side (reflected)
  notes**, the piece missing from the Bitcoin-lane counterpart of this doc's ETH-side note scan. A
  client already derives its own candidate `(asset, cx, cy, owner)` → leaf hash locally, from its own
  key material — the gap was that confirming a candidate exists and getting the tree membership
  witness needed to spend it required downloading `/reflection/dump`'s full snapshot (thousands of
  leaves) and reconstructing the notes tree client-side just to answer that one question.
  ```
  GET  /reflection/note-witness?leaf=0x...&network=mainnet   (single leaf)
  POST /reflection/note-witness {"leaves": ["0x...", ...]}    (batch, ≤64 per request)
  → { network, root, height, witnesses: { "<leaf>": { leafIndex, path } | null } }
  ```
  Same public/rate-limited posture as `/reflection/dump` (no box token needed; a null entry just
  means that leaf isn't in the current reflected note set yet, or ever). Spentness is deliberately
  NOT checked here — it doesn't need to be a new lookup, since `/reflection/dump`'s existing
  `spentLinks` (keyed by nullifier, which only the note's own key can derive) already answers it, and
  everything this endpoint returns is a pure function of a leaf hash the caller already computed, so
  it reveals nothing about who owns what. Reuses the exact same `Tree` class every other reflection
  membership check in this codebase already uses — cross-checked against a real fold: the `root` this
  endpoint computes from a live snapshot matched that fold's on-chain-verified `bitcoinPoolRoot`
  exactly.

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

The underlying rule, relevant to any pool generation: if an ETH→BTC `crossOut` ever lands while
`attestedBitcoinConsumedCount()` is still 0, the reflection fold **freezes permanently for that
pool** — unrecoverable without another full redeploy. The counter must first be seeded by one real
Bitcoin-homed fast-lane consume. Check both counters on whichever pool you're integrating against
before assuming a `crossOut` path is safe to expose in a UI:

```
attestedCrossOutCount()          // gen4, checked 2026-09-14: 6
attestedBitcoinConsumedCount()   // gen4, checked 2026-09-14: 1
```

**Gen4 has already passed this gate** — both counters are non-zero and the Mode-B Bitcoin-state
reflection lane is live and has folded real cross-chain activity. This is generation-specific,
though: a future redeploy resets both counters to zero again, and the same freeze risk applies fresh
until that new pool's own first fast-lane consume lands. Re-check live, don't assume from this doc.

This does not constrain anything else in this document: wrap / stealth-send / claim / unwrap never
touch that counter. It only matters if you're also adding a Bitcoin bridge button to the same UI.

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
