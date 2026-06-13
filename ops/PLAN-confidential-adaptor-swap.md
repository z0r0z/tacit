# PLAN — Confidential adaptor-signature cross-chain swap (PTLC)

> **The next confidential-trading primitive.** A cross-chain atomic swap whose linchpin is a
> **scalar revealed by signature adaptation**, not an on-chain hash preimage. One build yields
> **two products**: the **confidential fast-swap** (Route B *v2* — fast finality for a
> Bitcoin-homed note, amounts hidden end-to-end, supersedes the plain-leg HTLC of
> [`PLAN-confidential-htlc-fastswap.md`](./PLAN-confidential-htlc-fastswap.md) as the target) and
> the **cross-chain confidential orderbook** (a resting offer a taker completes). Companion to
> [`ARCH-tacit-chain-abstraction.md`](./ARCH-tacit-chain-abstraction.md) §"Fast-finality routes"
> + §"Confidential trading".
>
> **Why adaptor signatures over a hash-lock HTLC.** A visible `sha256(R)` hash-lock is a script
> that *advertises* "this is an atomic swap" and links the two legs by a common `H` — it leaks the
> swap as a pattern even with amounts hidden. An adaptor swap reveals its secret `t` by *adapting a
> signature*, so each leg is an ordinary confidential transfer, fully unlinkable. Tacit's notes are
> **secp256k1 + Schnorr (BIP-340)**, which is exactly what adaptor signatures want — this is the
> mature confidential-swap construction (Monero↔BTC, Lightning PTLCs).

## Adaptor signatures in one paragraph

A BIP-340 signature is `(R, s)` with `s·G = R + e·P`, `e = H(R_x ‖ P_x ‖ m)`. For a statement
`T = t·G`, the signer publishes a **pre-signature** `s̃` computed with the verification nonce
`R' = R + T`: `s̃ = k + e·x` where `R = k·G` and `e = H(R'_x ‖ P_x ‖ m)`. The pre-sig verifies as
`s̃·G == R + e·P` (it is "the signature minus `t`"). The **full** signature is `s = s̃ + t`, which
verifies as a normal BIP-340 sig under nonce `R'`. So **completing the signature requires `t`, and
publishing the completed `s` reveals `t = s − s̃`** to anyone holding the pre-sig `s̃`. No script, no
preimage — just a signature that looks normal once completed.

## The swap flow (Tacit-specific)

Alice holds a Bitcoin-homed note (asset X); Bob holds an Ethereum-native note (asset X — same asset,
so no price risk, the fee is the time-value). Alice wants Ethereum-native, Bob wants Bitcoin-homed.

```
setup: Alice picks t, T = t·G; agree (asset, v, fee, deadlines T_btc > T_eth, T) off-chain
1. Bitcoin leg  — Alice owns note X_btc → she ADAPTOR-pre-signs the kernel of "X_btc → Bob",
                  locked to T, and gives Bob s̃_btc. Bob cannot broadcast it (invalid without t).
                  Refund: a Taproot path returns X_btc to Alice after T_btc.
2. Ethereum leg — Bob owns note X_eth → he ADAPTOR-pre-signs the kernel of "X_eth → Alice",
                  locked to the SAME T, escrowed in ConfidentialPool. Refund to Bob after T_eth.
3. CLAIM        — Alice completes the Ethereum leg with t (she knows it), claiming X_eth before
                  T_eth. The settle exposes the completed kernel s_eth ⇒ t = s_eth − s̃_eth is public.
4. COUNTERCLAIM — Bob reads t off Ethereum, completes s_btc = s̃_btc + t, broadcasts "X_btc → Bob".
refund-on-abort: if Alice never claims (step 3), both legs refund after their timeouts. T_btc > T_eth
                 guarantees Bob has time to counterclaim after t is revealed.
```

Atomic by construction: Alice claiming reveals `t`; `t` lets Bob claim; if Alice never claims, nobody
does and both refund. The secret holder (Alice) must claim before `T_eth`, which reveals `t` in time
for Bob's `T_btc > T_eth` window.

## Per-chain primitives

### Bitcoin leg — mostly off-chain, one new refund path
- The claim artifact is a **normal confidential `T_CXFER`**: the `kernel_sig` is BIP-340, and an
  adaptor-completed `kernel_sig` is byte-indistinguishable from any other. So the **validator and the
  reflection prover need no change for the claim** — they already verify a Schnorr kernel; `t` is
  extracted off-chain from the published `kernel_sig` (visible in the envelope) and the shared `s̃`.
- **New:** a **timeout refund path** — the locked note's spend must be either (adaptor-claim by Bob,
  now) or (refund to Alice after `T_btc`). Realize as a Taproot script path `<T_btc> OP_CLTV <Alice>`
  alongside the key/adaptor spend, recognized as a pool op. This is the only Bitcoin-side surface
  (a validator/envelope recognition; coordinate with the reflection guest so the refund is reflected).

### Ethereum leg — a settle-guest adaptor op (rides a re-prove)
Because a confidential EVM note lives in `ConfidentialPool`, its spend goes through the settle guest —
so the EVM leg is a **new guest op**, not a standalone contract (mirrors how `OP_OTC` was pure-guest):
- **`OP_ADAPTOR_LOCK`** — escrow a note as a locked note encoding `(T, deadline T_eth, recipient,
  locker)`; conservation/range unchanged.
- **`OP_ADAPTOR_CLAIM`** — spend the locked note to `recipient` with the adaptor-completed kernel,
  before `T_eth`. The guest **commits the completed kernel `s` (or `t` directly) into the settle
  public values / an event**, so the Bitcoin-side counterparty can extract `t`. This s-exposure is
  the one genuinely new public output.
- **`OP_ADAPTOR_REFUND`** — return the note to `locker` after `T_eth`.
- **Timeout source:** the guest has no clock, so `ConfidentialPool.settle` passes `block.timestamp`
  in and the guest gates `CLAIM`/`REFUND` on it (the contract verifies the timestamp it supplied is
  real). A small contract + public-values addition, gated to the adaptor branches only.

So the EVM leg = a guest op-set + a `settle` timestamp input + the `s`-exposure → **one re-prove +
one redeploy** (no new contract for escrow — the pool already custodies the note).

## `t`-extraction, binding, and safety

- **Extraction:** `t = s_completed − s̃_shared`. The pre-sig `s̃` is shared off-chain at setup; the
  completed `s` is public on each chain (Bitcoin envelope; EVM committed value).
- **Binding (anti-replay/anti-cross-bind):** `T` and both kernels bind `(asset, v, recipient,
  locker, deadlines, chainid, pool/contract)` so a pre-sig is valid only for *this* swap and cannot
  be replayed or rebound to another note. Nonce `k` MUST be fresh per pre-sig (BIP-340 nonce-reuse
  rules); the adaptor adds `T` to the nonce, not to `k`.
- **Confidentiality:** no hash-lock and no shared `H` on-chain; both legs are ordinary confidential
  transfers with hidden amounts → the swap is unlinkable and amount-private end-to-end (the v1 plain-
  leg boundary reveal is gone).
- **Atomicity + timeouts:** `t`-reveal links the legs; `T_btc > T_eth` gives the counterparty its
  window; same-asset ⇒ no price risk, the fee is the time-value of the LP's fronted capital.
- **Reorg posture:** set `T_btc` past the bridge confirmation depth so Bob's counterclaim is buried
  before he settles; accept-and-document per asset/size, as elsewhere.

## The cross-chain confidential orderbook (same primitive)

A **resting cross-chain offer** is a posted pre-signature (or a pre-sig template) a taker completes:
the maker advertises "X for Y at price p, adaptor `T`", a taker on the other chain locks their leg
and completes, revealing `t`. So `OP_BID`/`OP_OTC` gain a cross-chain mode for free once the adaptor
op-set exists — the orderbook view (one book across chains) is then app-layer over the same
primitive, with cross-chain fills flagged as adaptor swaps.

## Reuse vs net-new

| Reused | Net-new |
|---|---|
| BIP-340 Schnorr (kernel sig) + the secp/Schnorr libs; `OP_OTC` as the same-chain confidential-swap base | The adaptor sign/verify/extract crypto (a small, well-specified primitive) |
| `ConfidentialPool.settle` proof path (`bridge_mint`/kernel/range unchanged) | `OP_ADAPTOR_{LOCK,CLAIM,REFUND}` guest ops + the `s`/`t` exposure + the `settle` timestamp input |
| Bitcoin `T_CXFER` validator + reflection (claim is a normal CXFER) | The Bitcoin Taproot timeout-refund path recognition |
| The cross-chain asset resolver (one asset, both venues) + the unified surface | The swap state machine + the maker/taker quote/discovery (app) |

## Surfaces

- **Guest / contract (parallel session; rides a re-prove + redeploy):** the EVM `OP_ADAPTOR_*` ops +
  the `settle` timestamp + the `s`-exposure; the Bitcoin refund-path recognition in the validator +
  the reflection guest. **Flag for the guest owner.**
- **App (this session):** the adaptor crypto module (`sign`/`verify`/`complete`/`extract`) + KATs;
  the swap orchestration state machine (setup → lock → claim → counterclaim → refund); the
  maker/taker quote + discovery endpoint; the orderbook view; entry from the unified surface.

## Open decisions

- **Adaptor on the kernel sig vs the opening sigma.** The kernel sig authorizes the whole transfer
  (recommended target); the opening sigma is per-note. Decide which carries `T` (kernel is cleaner —
  one adaptor per leg).
- **Reveal `t` via committed `s`, or commit `t` directly.** Committing `s` keeps it signature-native;
  committing `t` is simpler to consume but less elegant. Pick for the guest's public-values shape.
- **Locked-note encoding** for `OP_ADAPTOR_LOCK` (how `(T, T_eth, recipient, locker)` ride the note)
  and whether `LOCK`+`CLAIM` can be one settle (maker-side) or must straddle settles.
- **Timestamp granularity / source** — `block.timestamp` into `settle` vs a block-height deadline;
  the contract gate's exact shape.
- **2-party vs single-sig.** Single-sig adaptor on each owner's note is simplest; a MuSig/2P variant
  removes a round but adds key-agg complexity — single-sig first.
- **Deadline parameters** `(T_btc, T_eth)` per asset/size vs the bridge depth + reorg posture; quote
  TTL bounding an LP's committed-capital window.

## Phasing

1. **Crypto core — ✅ DONE, BIP-340-faithful.** `dapp/adaptor-signature.js`
   (`presign`/`verifyPresign`/`complete`/`completedSig`/`extract` + `evenSigningKey`) locks the EXACT
   kernel sig: it reuses `bulletproofs.js`'s `_taggedHash('BIP0340/challenge', Rx ‖ Px ‖ msg)`
   byte-for-byte and handles the `R'=R+T` even-y parity (σ = parity(R+T); `s = s̃ + σ·t`,
   `t = σ·(s − s̃)`). `tests/adaptor-signature.mjs` (5/5) — the decisive check is that the **real
   `verifySchnorr` accepts the completed adaptor signature, across both parities**; plus extraction,
   message-binding, wrong-`t` rejection, shape-indistinguishability from a normal `signSchnorr` sig,
   and the two-leg swap round-trip. App-layer, no re-prove.
2. **EVM guest op-set + contract timestamp + `s`-exposure** — `OP_ADAPTOR_{LOCK,CLAIM,REFUND}`;
   forge + node KATs; rides the next re-prove (coordinate with the guest owner).
3. **Bitcoin adaptor CXFER + Taproot refund** — the refund-path recognition + reflection reflect;
   the adaptor-pre-signed CXFER builder (off-chain).
4. **Orchestration — ✅ DONE (core).** `dapp/adaptor-swap.js` — the swap state machine
   (open → lock → verify → claim-reveals-`t` → counterclaim, + refund predicates) over the phase-1
   primitive, enforcing the timeout-ordering invariant (`farDeadline > nearDeadline`) and
   verify-before-commit. `tests/adaptor-swap.mjs` (4/4) drives a full swap (both completed legs pass
   the real `verifySchnorr`), the refund path, no-double-settle, and the safety rejections. The
   **cross-chain orderbook** is also built — `dapp/cross-chain-orderbook.js` (post / best-price match /
   partial-fill at exact price multiples / cancel / expiry; each fill yields a drivable adaptor swap;
   resolver-gated asset recognition), `tests/cross-chain-orderbook.mjs` (5/5) drives fill → swap →
   `verifySchnorr` end-to-end. Remaining (gated on the legs): the worker quote-discovery/relay endpoint
   + the dapp orderbook view from the unified surface.
5. **Re-prove + deploy** — fold the EVM ops into the next `ConfidentialPool` re-prove/redeploy; live
   on signet → mainnet.

The cryptographic core (phase 1) and the orchestration (phase 4) are mine and **DONE** (no re-prove);
the EVM guest op-set (phase 2) + the Bitcoin adaptor CXFER / refund recognition (phase 3) are the
parallel session's and ride the re-prove that v1/Mode B already takes.
