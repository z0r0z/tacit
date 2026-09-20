# Tacit — V1 Launch Review, gen5 live surface (Claude Opus 5)

**Model / mode:** Claude **Opus 5**, one continuous single-reviewer session, 1M context — the immutable surface
read in one window rather than fanned out, so every claim below was reached by the same reader.
**Date:** 2026-09-20 · **Branch:** `main`, starting at `e29a83e4` · **Posture:** gen5 is live on Ethereum
mainnet and has been exercised in production; this review asks whether it is safe to open to the public.

The 2026-09-19 public-release review asked *is this safe to publish?* and proved the deployed bytecode is this
tree. This round asks the narrower operational question — *is it safe for strangers to use* — and therefore
weights the surfaces a stranger actually touches: the public API, the live cross-out path, and the addresses
the outside world is pointed at.

## Scope

- **Immutable:** `ConfidentialPool.sol` (2673 lines) and `ReflectionLib.sol` (770), read in full; the SP1 settle
  guest `contracts/sp1/confidential/src/main.rs` (5516 lines), read in full — all 34 live opcodes; the
  cross-lane folds in `cxfer-core` (`fold_consumed`, `fold_crossout`, `fold_cbtc_lock`, `fold_cxfer`) and the
  Mode-B recursion gate in `reflect.rs`.
- **Verification chain:** the vkey/slot/lockstep pin gates, the full Forge suite, and the guest↔guest recursion
  binding that governs whether the bridge can bootstrap.
- **Off-chain:** the API (`worker/src/index.js`, ~27.8k lines) route-by-route auth and resource model, the Node
  serving harness (`server/`), the settle relay (`worker-relay/src`), and the dapp's randomness sources.
- **Published surface:** every mainnet address and asset id the repository, its docs and the on-chain token
  list hand to an integrator.

**Bar applied:** no value created or destroyed across the Bitcoin↔Ethereum boundary without its counterpart; no
taking, redirecting or double-spending another holder's balance; a holder with only their keys can always exit;
no permanent brick reachable by an unprivileged party; no unauthenticated party can take the public service
down cheaply; and nothing published that routes a newcomer to the wrong contract.

## Verdict

**Green-lit for V1 launch.** The immutable surface is sound; everything outstanding is off-chain and
operational: a deploy to land (**L-1**, already fixed in this tree), a multisig action (**L-2**), and two
items that gate the *Bitcoin-lane* surface specifically — **L-4** (fast-lane consumed-source registration)
and **L-5** (the wallet cannot see generation-bound notes). If the BTC→ETH on-ramp stays non-user-facing at
launch, L-4 and L-5 are low-exposure; if it does not, they are prerequisites.

The immutable surface needs no change and gets none. No double-spend, inflation, theft, or brick path was
found; the cross-out brick vector that bit earlier generations was verified *closed in the gen5 guest*, by
following the pin chain rather than by trusting the note that said so. All 884 Forge tests pass and all five
pin gates are green on this tree.

Every launch item is outside the proof system:

| | Finding | Severity | Status |
|---|---|---|---|
| **L-1** | Unauthenticated request-body DoS on the public API | High (availability) | **Fixed here**, needs an API redeploy |
| **L-2** | Three of five live token-list entries point at the retired gen4 suite | Medium (misrouting) | Needs a multisig refresh |
| **L-3** | Published manifests and integration guides carried retired-generation addresses | Medium (misrouting) | **Fixed here** |
| **L-4** | Nothing registers a fast-lane consumed source, so the next fast-lane spend stalls reflection | Medium (liveness) | Needs a decision — see below |
| **L-5** | The wallet scanner has no branch for `T_CXFER_BOUND` (0x39), so generation-bound Bitcoin notes are not discovered | Medium (recoverability) | Pre-existing, repo-tracked — not patched here |
| **D-1** | Relayed swaps reveal their amounts to the relay operator | Disclosure, by construction | Recorded, not changed |

---

## L-1 — Unauthenticated request-body DoS on the public API (High, availability)

**Fixed in this tree (`868fd143`); takes effect on the next `tacit-api` deploy.**

The API was written for Cloudflare Workers, where the platform caps an inbound body at 100 MB before the
worker ever runs. Production is now Render/Node (`server/harness.mjs` → `worker/src/index.js`), and **nothing
in that path capped a body at all**. `toWebRequest` handed `Readable.toWeb(nodeReq)` straight to `Request`, so
the first `req.json()` / `req.formData()` / `req.text()` in any route buffered the entire body into the V8
heap *before* that route's own size check could run.

Every handler-side limit is post-parse and therefore too late: `/pin` checks `file.size` only after
`req.formData()` resolves, `/pin-json` checks `json.length` only after `req.json()` resolves, and
`/confidential/submit` — unauthenticated by design — has no size check at all.

The instance is 512 MB with an armed memory guard (`server/memory-guard.mjs`) that gracefully shuts down at
90% pressure. So a single `curl` with a few hundred MB of body, to any POST route, recycles the process; a
loop of them keeps the public API permanently down. No authentication, no cost to the attacker, no on-chain
footprint.

This is availability only. User funds are never at risk: `settle` is permissionless, the relay holds no user
keys, and anyone can self-settle without the API at all. But "any stranger can hold the public API down with
one command" is not a launch posture.

**Fix.** A ceiling in the harness, so it covers every route at once rather than route-by-route:

- reject on `Content-Length` before a byte is read, and
- cap the stream itself, so a chunked body or an under-declared `Content-Length` cannot get past it either.

The streaming cap counts inside a `Transform` rather than a `data` listener on the socket — a listener would
flip the socket into flowing mode and lose the body before `Readable.toWeb` read it. On trip, the request is
flagged, unpiped and drained rather than destroyed, so the client receives a clean `413` instead of a bare
connection reset. `MAX_REQUEST_BYTES` tunes it; the 32 MiB default sits above every legitimate body (the
largest handler-side cap in the tree is the 16 MB reflection snapshot).

Verified end-to-end against the real `createTacitServer` path with a stub worker that swallows its own parse
errors, exactly as `/confidential/submit` does:

| case | result |
|---|---|
| 500 B body | `200`, round-trips intact |
| body exactly at the cap | `200` |
| oversize, honest `Content-Length` | `413`, body never read |
| oversize, chunked (no `Content-Length`) | `413`, at most the ceiling buffered |
| under-cap chunked | `200` |
| normal request after the abuse | `200` — process alive |

**Action:** redeploy `tacit-api` before the endpoint is advertised. It does not auto-deploy from git.

## L-2 — The public token list points at the retired generation (Medium, misrouting)

**Not fixable from this tree — `TokenList.list()/listForeign()/setArt()` are `onlyOwner`.**

The five Tacit entries on the on-chain TokenList (`0x0000006013dF75A31678B786061C2B54bf531524`) were listed on
2026-09-11 against gen4. Gen5 replaced gen4 on 2026-09-18, and **three of the five are now stale**:

| entry | listed | current (gen5) |
|---|---|---|
| tacBTC (ERC-20) | `0x5Fc0376DA9f1dE8dd68b50648779C83b79f7C50F` | `0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696` |
| tacUSD (ERC-20) | `0xA70f3853D56c1fC3F5b800E44907c7AD885Ab905` | `0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564` |
| cUSD (shielded id) | `0x4e8455a5…3dacb` | `0x8f4490dd…8a9679d` |
| cBTC (shielded id) | `0x62a20d98…cf0679c8` | unchanged — correct |
| tETH | `0x3cba71e1…03126f34` | unchanged — correct |

Canonical ERC20s are minter-bound, so each generation deploys its own; the cUSD id is
`keccak("tacit-cdp-debt-v1" ‖ engine)` and moves with the engine. Nothing here is a protocol defect — the gen4
contracts are real and their holders can still exit — but the token list is precisely the surface a newcomer
discovers Tacit through, and today it hands them a generation that accepts no new value.

**Action:** re-point the three stale entries at the gen5 values (same art, same ranks) before launch. The
recipe and calldata pattern are in `ops/DESIGN-tokenlist-listing-cbtc-cusd.md`, updated here to record which
entries are stale and why.

## L-3 — Published addresses pointed at retired generations (Medium, misrouting)

**Fixed in this tree (`38653995`, `5e764d50`).**

- `contracts/deployments/1.json` — the hand-maintained manifest the README offered as *the* machine-readable
  one — still described the **2026-07-24 V2 suite**: three generations of stale addresses and all three stale
  vkeys. The deploy script's own `1-createx.json` was current, so the two disagreed and the README pointed at
  the wrong one. Partially maintained, which made it more misleading rather than less: its beacon-genesis
  fields *had* been updated in the 09-17 reprove, so it did not look abandoned. Rebuilt from
  `1-createx.json` (addresses), `launch-v1-final.env` (reflection + beacon genesis) and `elf-vkey-pin.json`
  (vkeys); the two manifests now agree on every shared field, and the README names both and says which is
  authoritative for what.
- `ops/INTEGRATION-simple-wrap-send-claim-eth.md` listed gen4 addresses under "Contracts in use (mainnet)",
  with the gen5 notice relegated to a header paragraph — the wrong way round for a handoff document.
- `ops/INTEGRATION-l2-bridging-base-robinhood.md` listed **gen3** addresses, and a gen3
  `router.executorImpl` under a comment telling the reader never to hardcode it.
- `ops/AUDIT-RESPONSE-gen1-launch.md` named a superseded pool inline, contradicting its own stated policy of
  referring to retired generations generically.

Each now carries the live gen5 suite, with the historical results kept and labelled as historical.

## L-4 — Nothing registers a fast-lane consumed source (Medium, liveness)

**Not changed here — the clean fix moves an auth boundary on the live API, which is the maintainer's call.**

A Mode-B reflection batch that folds a fast-lane-consumed ν needs that note's own
`{cx, cy, srcTxid, srcVout}`. The settle proof cannot supply it: it proves membership against the Bitcoin
pool root, never the underlying outpoint. So the spender has to hand it over. Today nobody does.

The chain, each link confirmed in the tree:

1. `worker-relay/src/eth-state-sidecar.js` publishes `{ ethPv, crossouts, consumeds, ethCompressedProof,
   lastBlock, execBlock }` — no `consumedSources`.
2. `handleReflectionEthStatePost` therefore stores `consumedSources: []` every time.
3. `ethBundleSource` falls back to the holder-registered KV registry
   (`reflection:consumedsrc:<network>:<nu>`), written only by `POST /reflection/consumed-source`.
4. The one client for that endpoint, `reflectionConsumedSourceRegister` in
   `worker-relay/src/lib/worker-client.js:49`, is **exported and never called** — a repo-wide search returns
   only its own definition.
5. `buildModeBBatch` does not skip an unresolved entry, it **throws**:
   `mode-b: consumed ν has no resolved Bitcoin source note`.

So the first fast-lane spend past `alreadyFoldedConsumedCount` wedges Mode-B assembly, and once any
cross-out or new consume exists Mode-B is the only way the lane advances. The existing `tools/modeb-*.mjs`
and `reflection-headrebuild.mjs` scripts all **hardcode** `consumedSources` — that is how previous consumes
were handled, by hand.

Bounded, and not a brick: one authenticated `POST /reflection/consumed-source` with the note's
`{nu, cx, cy, srcTxid, srcVout}` unblocks it, and the guest re-verifies membership in-zkVM, so a wrong entry
makes the fold skip rather than mis-attest. No funds are at risk in any case. But the dapp exposes
`fastlaneExit`, so this is a user-reachable stall, and it will be hit the first time someone uses the fast
lane for real.

There is also a contradiction worth resolving on its own terms: the handler's comment says "whoever spent
the note via the fast lane registers it here", but the endpoint is `checkConfidentialAuth`-gated, so the one
party that actually knows the outpoint — the user — cannot call it.

Two ways out, both small:

- **Open the endpoint** (validated + rate-limited, keeping the passthrough-store posture its own comment
  already argues for) and have `dapp/confidential-pool-ux.js` register the source right after a successful
  `fastlaneExit`. This matches the stated design and needs no operator in the loop.
- **Keep it gated** and have the relay register it after settling a `fastlane` job — but the relay would
  need the outpoint passed through the job envelope, since the settle witness does not carry it.

I did not pick one: moving an auth boundary on the live public API at launch is a decision, not a cleanup.
Until it is wired, treat a fast-lane spend as an operator-assisted action.

## L-5 — The wallet scanner does not recognize generation-bound Bitcoin notes (Medium, recoverability)

**Pre-existing and already tracked by the repo's own guard test; not patched here.**

`tests/recovery-parity.test.mjs` asserts that every declared opcode either has a `scanHoldings` branch or an
explicit allowlist entry with a documented reason. It reports one gap, and has been reporting it before this
review:

```
0x39 T_CXFER_BOUND — declared in dapp/worker but scanHoldings does not recognize it.
Summary: 19 scanned, 21 allowlisted, 1 GAPS
```

`T_CXFER_BOUND` (0x39) is the **generation-bound** CXFER — the opcode that produces a Bitcoin-side note homed
to this deployment, whose leaf is `btc_note_leaf_bound(asset‖Cx‖Cy‖auth_key‖chain_binding)`. That is precisely
the note class the fast lane can spend on Ethereum: an ordinary `T_CXFER`/`T_CXFER_BPP` (0x23/0x22) output
folds as legacy-domain `bound = 0` and is *not* fast-lane-authenticatable. `dapp/tacit.js` has scan branches
for 0x23 and 0x22 but none for 0x39.

Consequence: a holder who receives a generation-bound note does not see it in their wallet balance. The note
is not lost — it exists in the reflected pool and its opening is recoverable from the memo / seed — but
nothing surfaces it, so in practice the holder has no way to find or spend it through the dapp.

I did not add the branch. It touches `dapp/tacit.js`, which auto-deploys from `main`, and a scanner branch
for the bound domain has to get the leaf domain, the chain-binding check and the holdings record's auth key
right; there is no real 0x39 note available here to test against, and a fail-closed mistake on a live wallet
path is the exact regression shape this repo has been bitten by before. It should be written and exercised
against a real bound note, or 0x39 should be allowlisted with a reason if the intent is that bound notes are
surfaced some other way.

This pairs with the note recorded elsewhere that the BTC→ETH on-ramp is not yet user-facing: if that stays
true at launch, the exposure is small. If it does not, this is the gap that decides whether a bridged holder
can see their money.

## D-1 — Relayed swaps reveal their amounts to the relay operator (disclosure)

Not a defect, and not changed here — but it should be stated plainly rather than left for a user to infer.

`OP_SWAP`'s witness carries `amount_in`, `amount_out`, `min_out` and `fee` in cleartext, because the guest
*computes the clearing* and therefore must see them. Everything else about the trade stays private, and
nothing is published on-chain beyond the net reserve move — but whoever proves the batch learns that user's
trade size. For a self-settling user that is nobody. For a user who submits to the hosted relay, it is the
relay operator.

`OP_SWAP_BLIND` (opcode 31) is exactly the fix: prover-blind clearing via the in-guest BN254 Groth16 circuit,
so the box never reads a cleartext amount. It is **armed in the deployed guest** and **built by the dapp**
(`dapp/confidential-swapblind.js`), and a prover harness exists (`exec-swapblind.rs`) — but it is wired into
neither the API's submit allowlist (`worker/src/confidential-settle.js`) nor the relay's op→binary map
(`worker-relay/src/lib/prover.js`). **So every relayed swap today is `OP_SWAP`.**

I did not wire it. Turning on a path that has never run through the live prove/settle pipeline is not a change
to make at launch on an untested basis, and I cannot exercise the prover box from here. It is a small change
(one allowlist entry, one `PEROP` entry) once someone can run a real swapblind job end-to-end.

One nuance that is easy to state wrongly: `selfRelay: true` does **not** remove the relay from the picture.
`_dispatch` still calls `relay.prove(...)` and only changes who submits the settle — so the relay still
receives the witness and still sees the amounts. What self-relaying avoids is the fee and having the relay's
address on the transaction. Genuinely removing it means proving locally (native-gnark on CPU, which the stack
supports). Both `FEATURES.md` and the new build guide were corrected to say this precisely rather than
implying self-settle is sufficient.

The honest launch statement: *amounts are hidden from the chain and from every other user; a swap proven by
Tacit's relay is visible to Tacit's relay; prove locally, or wait for the prover-blind path, if that matters.*
The same applies to IP metadata — the dapp talks to the API directly, so the relay sees a submitting user's
address alongside their op.

---

## What was verified, and how

### The cross-out brick vector is closed on gen5 — verified, not assumed

This is the item that most deserved re-checking, because it is a *permanent* brick and it has actually
happened on this codebase before (a self-inflicted freeze on `0x…f88564`, 2026-07-12).

The mechanism: `crossOut` bumps `crossOutCount` unconditionally through the permissionless `settle`. A forward
reflection batch commits zero for that counter, and `attest` gates the committed value against the live one —
so from the first cross-out on, only a Mode-B batch can advance the lane. Mode-B's Ethereum-state proof reads
`bitcoinConsumedCount`; if that counter is still 0 it lives in an *unwritten* slot, which cannot be
*inclusion*-proven. On the old guest a cross-out recorded before the first Bitcoin-homed fast-lane spend
therefore froze forward bridging, reverse bridging and every reflection-dependent op, permanently.

Gen5 has `crossOutCount == 0` and `bitcoinConsumedCount == 0`. If the old guest were deployed, **the first
user to bridge ETH→BTC would brick the bridge** — a stranger performing a legitimate operation. So the fix had
to be confirmed on *this* deployment, not on the generation where it was first shipped:

1. `verify_storage_slot_proofs_allow_zero` is present in `contracts/sp1/eth-reflection/src/main.rs` (defined
   at line 144, used at line 271). It verifies a zero-valued counter slot by **exclusion** — a never-written
   slot is genuinely absent from the storage trie, and a `++`-only counter cannot be legitimately absent once
   non-zero, so proven-absent is a sound proof of true zero. Mode-B bootstraps from zero.
2. That guest builds to `eth_reflection_vkey = 0x00ca8171…`, pinned in `elf-vkey-pin.json`.
3. Its recursion digest `[1698740370, 761725306, 1843717690, 1218893588, 786585592, 423901230, 1310805602,
   795535986]` is pinned into `reflect.rs`'s `ETH_REFLECTION_VKEY` (line 856) and enforced at line 919 via
   `verify_sp1_proof` — so the reflection guest accepts a Mode-B proof from *only* that eth-reflection guest.
4. `reflect.rs` builds to `bitcoin_relay_vkey = 0x00bb158b…`, which the 09-19 review proved equals the
   immutable `BITCOIN_RELAY_VKEY` in gen5's live bytecode.
5. `verify-vkey-pin.sh` and `verify-lockstep-pins.sh` both pass on this tree, so no link in that chain has
   drifted.
6. Independently, the live pool reports `attestedBitcoinConsumedCount() == 1` — the counter is written, so
   the unwritten-slot case the old guest could not prove does not arise on gen5 at all.

**Conclusion: a cross-out is safe on gen5 in any counter order.**

Live mainnet state, read during this review, makes it doubly safe — the old operational precondition ("seed
the consume counter before any cross-out") is *already satisfied* on gen5, so even the pre-fix guest would
not have frozen here:

```
pool 0x000000000Ed1eabD231Be41d93b719056F7febFC
  nextLeafIndex                 24
  attestedBitcoinConsumedCount   1     <- slot already written; cold-start window closed
  attestedCrossOutCount          0
  successor                      0     <- active generation, not retired
```

The remaining consequence is economic, not safety — from the first cross-out on, every attest must be Mode-B
and therefore carries an Ethereum-state proof cost. `ops/INTEGRATION-simple-wrap-send-claim-eth.md` §6a said the opposite (it still described the
pre-fix hazard and told integrators to treat counter order as a gate) and has been corrected.

### Conservation and spend-once, across all 34 opcodes

Read every opcode arm. The properties hold uniformly, and the structure is what makes that checkable:

- **One nullifier scheme per note.** Every native-leaf spend routes through `native_input` / `native_nu`, so a
  note can never carry two different nullifiers. Non-zero owner ⇒ `owner == keccak(nk ‖ dom)` and ν binds the
  secret `nk` (published leaf cannot reproduce ν); `owner == 0` ⇒ bearer note, leaf-bound ν. No value hashes
  to zero, so the branch is unambiguous.
- **Distinctness at three levels:** within an op's input set, batch-wide over `nullifiers` and `lockNullifiers`
  (`main.rs:5464-5465`), and again contract-side via set-then-check on `nullifierSpent`. The guest's own
  conservation therefore does not depend on the contract as sole guard.
- **Delegated-prover safety is uniform.** Every op that mints an output binds the destination into a signed
  transcript the box cannot forge: opening sigmas / blind PoKs over an `intent_context`, leaf-bound
  conservation kernels (`verify_kernel_with_fee_bound`), and BIP-340 owner signatures on the paths where
  knowledge of a blinding is no longer proof of ownership (stealth refund, adaptor refund, CDP close/top-up,
  farm harvest/unbond). The two refund paths carry a locker signature specifically because the *blind claim
  conveys `r_L` to the recipient* — a subtlety that is correctly handled.
- **Fail-closed op composition.** Ops that cannot support a Bitcoin-homed input (`OP_SWAP_BLIND`, `OP_BID`,
  `OP_LP_BOND`, bridge mints) simply never push to `bitcoin_consumed_sources`; the batch-wide
  `sources.len() == nullifiers.len()` assert then rejects them inside a btcHomed batch. `OP_OTC` rejects it
  explicitly, with the right reason (its outputs would be keyed by an x-only Taproot key that no `nk` hashes
  to, so they would be unspendable while the Bitcoin source was retired).

### Cross-lane value conservation

The invariant — *a Bitcoin-homed note's value reaches Ethereum only if the note is also retired on Bitcoin* —
is enforced on both sides and the two sides reconstruct the same object:

- The pool records `keccak(spendRoot ‖ sourceLeaf)` per consumed ν, where `sourceLeaf` is the **full
  authenticated leaf** (`asset ‖ Cx ‖ Cy ‖ auth_key ‖ chain_binding`), not the bare asset.
- `fold_consumed` rebuilds that leaf from the **live outpoint's own** asset and Bitcoin auth key, recomputes ν
  from it, and requires both the ν and the keccak to match before retiring it. A same-commitment note of a
  cheaper asset, or a clone under an attacker's key, reconstructs differently and cannot be retired in place
  of the valuable one.
- The retired outpoint is additionally inserted into a permanent consumed-outpoint set, which is what stops
  the same Bitcoin UTXO later minting again through the scan-free burn-deposit path (disjoint ν domains, so
  the spent set alone would not catch it).
- `fold_crossout` rejects a zero destination key (a non-P2TR mint output), reconstructs the destination leaf
  from the burner-named key, and requires IMT **membership or non-membership** — a lying witness is
  unprovable, so a prover can neither skip a real cross-out nor fold a fake one.

The btcHomed branch in `_settle` enumerates every value-bearing field of `PublicValues` and either bars it or
gates it to a pool-minted asset with its source ν recorded. That enumeration is the right shape for a frozen
contract: a new value-bearing field fails the width-pinning test until someone revisits it.

### Compromised-guest floors

The contract does not merely trust the proof. Independently of the guest it enforces: the no-inflation reserve
floor (`evmNullifiersSpent > nextLeafIndex`), constant-product non-decrease on every swap, pro-rata share
bounds on LP add and remove, the `MINIMUM_LIQUIDITY` floor, u64 re-bounding at every public boundary,
one-mint-per-`burnId`, ν-distinctness across cross-outs and bridge-burns *and* across the two arrays, and a
duplicate-position-leaf guard. These are the right set: each one corresponds to a property the guest also
proves, so a guest compromise has to beat both.

### Verification state on this tree

| gate | result |
|---|---|
| `forge test` | **884 passed, 0 failed** (88 suites, incl. real-Groth16 fixtures + invariants) |
| `verify-vkey-pin.sh` | PASS |
| `verify-lockstep-pins.sh` | PASS |
| `verify-storage-slots.sh` | PASS |
| `verify-guest-slots.sh` | PASS |
| `verify-reflection-slots.sh` | PASS |

The JavaScript suite is **not** a clean gate in this environment and should not be read as one: of 199 files,
**173 pass, 17 fail and 9 block on network I/O** past a 90s limit. Every one of the 17 failures was
reproduced at the pre-review commit `e29a83e4` in a separate worktree, so none is introduced here. They fall
into three groups: a missing optional dev dependency (`circomlibjs`) for the **sunset** mixer's Groth16
sample; ceremony tests that need a live worker/KV for a ceremony that is already complete; and legacy
Bitcoin-lane AMM harness shape drift (`receipt[0].rangeProof must be Uint8Array`). The one that is not
cosmetic is `recovery-parity`, which is finding L-5 above. Two environment traps worth recording: `timeout`
does not exist on this macOS, so a runner loop built on it reports every test as exit 127, and two concurrent
full-suite runs make tests fail spuriously by starving each other.

### Off-chain, re-checked

- **Route auth is complete.** Every `/admin/*` and `/debug/*` route is `checkDebugAuth`-gated and default-denies
  with `404` when `DEBUG_TOKEN` is unset. Every box route (`/reflection/*`, `/confidential/job|ack`) is
  `checkConfidentialAuth`-gated. Every gate is constant-time. `/pin*` is per-IP per-day quota'd and
  size-bounded. The unauthenticated `/confidential/submit` is metered whenever the fee floor is not enforced
  (the 09-19 hardening) and the queue is bounded at 512.
- **`checkConfidentialAuth` accepts `DEBUG_TOKEN` as a fallback** for `CONFIDENTIAL_BOX_TOKEN`. That conflates
  two roles with different blast radii. Not a defect, but worth setting both explicitly in the production
  environment so the fallback never engages.
- **Randomness.** All four `randomScalar`/`rand32Hex` implementations across the dapp are CSPRNG-backed and
  fail closed without one. `amm-farm-actions.js` reduces mod *n* instead of rejection-sampling — a bias of
  order 2⁻¹²⁷, cryptographically irrelevant. Every `Math.random` in the tree is a UI id, an analytics sample,
  or a cosmetic display scramble; none is key material.
- **Relay trust model holds.** The relay never sees a spending key — only opening sigmas — and can only earn
  the proof-bound fee. Its `PEROP` map resolves and validates the op type before anything touches the
  filesystem (the 09-19 fix).

## Hypotheses tested and refuted

Recorded so they are not re-derived. These are *this* round's; the 09-19 review's refuted set still stands.

- *First public ETH→BTC bridge bricks the lane (cold-start freeze)* → closed in the gen5 guest; pin chain
  verified end-to-end above.
- *A bridge-mint smuggled into a btcHomed batch duplicates value* → a bridge mint pushes ν without a consumed
  source, so the batch-wide length assert rejects it; the contract bars `bitcoinBurnsConsumed` on a btcHomed
  batch independently.
- *Two dest commitments on one burn mint twice on Bitcoin* → the guest asserts `m_out == 1` and rejects
  duplicate dest commitments; the contract enforces ν-distinctness across cross-outs and rejects a ν that also
  rides a bridge-burn.
- *A relayer redirects a CDP close's released collateral* → each released leg's opening sigma binds
  `(cx, cy, rel_owner)` in its context, and the relayer cannot produce it without the blinding.
- *`OP_BID` seller under-delivers or re-prices* → the buyer's pre-signed sigma binds `chosen_f` and the grid;
  the seller's binds its own notes and the fee. Conservation is checked per asset.
- *A protocol-fee pool strands its own skim* → the recipient key is on-curve-checked at both funding
  (`OP_LP_ADD`/`OP_WRAP_LP`/`OP_LP_BOND`) and at skim time, and the fee-lock blinding is derived
  deterministically from public swap data so the recipient can always recompute and claim it.
- *Oversize body is caught by a handler's own limit* → **not refuted; this is L-1.** Every such limit is
  post-parse.

## Design decisions recorded, not findings

- **Relay front-running.** A copycat can take a relayed settle's fee from the public mempool. The user's
  effects still land, `TacitRelayer`'s per-settle try/catch skips a lost race, and the `minOut` guard reverts
  the batch unless fees materialise — so a front-run relayer loses the proof cost, not the gas. Tacit keeps
  proofs relayer-agnostic (binding a relayer into the proof would let it censor by sitting on it, and an
  outage would kill a proof that cost real money) and pays for that with private submission.
- **Reflection liveness depends on someone running the prover.** EVM-side notes stay spendable regardless.
- **A Bitcoin reorg deeper than 24 confirmations halts reflection permanently and deliberately.**
- **`LINEAGE_STEWARD` (`0x006CD14F…`) is 2-of-4** and its only power is `createNextGen`: it names successor
  code. It cannot touch escrow, freeze exits, or redirect payouts.
- **From the first cross-out on, every attest is Mode-B** and carries an Ethereum-state proof cost. This is
  the intended design, and it is a real per-attest operating expense worth planning for.
- **Concurrent cross-outs thrash.** Each bumps `crossOutCount`, staling any in-flight Mode-B proof. An event
  where many users bridge back at once will re-prove repeatedly. Not a safety issue; measure before promoting
  a flow that produces bursts.

## Launch checklist

1. **Redeploy `tacit-api`** from a commit containing `868fd143` (L-1). It does not auto-deploy from git.
2. **Refresh the three stale token-list entries** via the owner multisig (L-2).
3. Set `CONFIDENTIAL_BOX_TOKEN` and `DEBUG_TOKEN` to distinct values in the production environment.
4. Confirm `RELAY_FEE_FLOOR` in the `tacit-api` environment — carried over from the 09-19 review, still
   unread from here.
5. Decide on `OP_SWAP_BLIND` (D-1): wire it after a real end-to-end prover run, or launch on `OP_SWAP` and
   state the relay-visibility property plainly in user-facing material.
6. Wire fast-lane consumed-source registration (L-4), or gate `fastlaneExit` behind an operator step until
   it is wired.
7. Add the `T_CXFER_BOUND` scan branch, or allowlist it with a reason (L-5) — required before the BTC→ETH
   on-ramp is made user-facing.
