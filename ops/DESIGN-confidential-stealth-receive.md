# Confidential stealth-receive (non-interactive send-to-address)

Lets a sender pay a recipient's **published static address** so that only the recipient can spend it (the
sender cannot, even though they created the note), and the recipient can scan for it — with **no interaction**
and **no guest change to any existing spend path**. It reuses the adaptor **lock-set** machinery with a
disjoint domain, so it is a contained, well-precedented addition (3 ops mirroring adaptor lock/claim/refund).

## Why a guest change is unavoidable (and why this is the clean one)

Notes are bearer: spend = knowledge of the blinding `r` (`verify_opening_sigma`, cxfer-core:187). Creating a
*conserving* note requires the sender to know the output blinding (the opening/kernel proof is over `r`). So
if the sender knows `r`, "knowledge of `r`" cannot be the ownership gate — the sender could spend too. Secure
non-interactive stealth therefore needs a spend-auth check **separate from the value blinding**; no blinding
trick avoids it. (Interactive secure-send already works today via recipient-made invoices / ConfidentialWrapRouter.)

The clean form is **not** a universal owner-key gate retrofitted into every spend path (the `owner` field is
polymorphic — bearer=0, farm-receipt=blinded commit, intent-binding — so blanket-gating breaks farm receipts).
Instead: lock the value into the **domain-separated lock-set** (where it is unreachable by transfer/swap), and
gate the **claim** with a BIP-340 signature under the recipient's one-time key. This touches nothing existing.

## Mechanism

Stealth keys (standard one-time address, sender-side only — no guest involvement):
- Recipient publishes a static spend pubkey `B = b·G`.
- Sender draws ephemeral `(e, E=e·G)`, shared secret `s = H(e·B)`, one-time pubkey `O = B + s·G` (x-only).
  The recipient's one-time private key is `b + s` — the recipient computes `s = H(b·E)` from the published
  `E` (memo); the **sender knows `O` and `s` but not `b`, so not the private key `b+s`**.

Reuses the shared lock-set: `lock_leaves` append → `lockLeaves` PublicValues → the contract's lock-set tree;
`lock_set_root` membership; `lock_nullifiers` spend-once. Domain separation keeps adaptor and stealth locks
unconfusable.

- `STEALTH_LOCK_DOMAIN = "tacit-stealth-lock-v1"`, `STEALTH_CLAIM_DOMAIN = "tacit-stealth-claim-v1"`.
- `stealth_lock_leaf(asset, cx, cy, owner_pub, amount, deadline, locker)` — binds the locked commitment, the
  recipient one-time pubkey `owner_pub`, the **cleartext `amount`** (prover-visible; pins conservation), and
  `deadline`/`locker` (the refund path).

### Ops (23 lock / 24 claim / 25 refund), mirroring adaptor 12/13/14

**OP_STEALTH_LOCK (23)** — like OP_ADAPTOR_LOCK, minus the adaptor point:
- Spend note `N` (locker's): membership in `spend_root`, ν_N, opening for `amount` (the locker authorizes).
- Locked note `L = commit(amount, r_L)`: opening for `amount` (value carry).
- Context binds `N(locker)`, `L(owner_pub)`, `amount`, `deadline`. Effect: ν_N; append
  `stealth_lock_leaf(asset, L_cx, L_cy, owner_pub, amount, deadline, locker)` to `lock_leaves`.

**OP_STEALTH_CLAIM (24)** — the recipient claims, gated by the one-time-key signature:
- Reconstruct `stealth_lock_leaf(...)` with the witnessed `amount` → membership in `lock_set_root` (pins
  asset/`owner_pub`/`amount`/deadline/locker); ν_L once.
- Output `M = commit(amount − fee, r_M)` → the recipient's chosen owner; `verify_opening_sigma(M, amount − fee, …)`.
- **`bip340_verify(owner_sig, stealth_claim_msg(chain_binding, lock_leaf, M_cx, M_cy, M_owner, amount, fee), owner_pub)`**
  — proves the claimer holds `owner_pub`'s one-time key, bound to THIS output + fee (no redirect, no fee-bump
  by a relayer). Conservation: `amount` (leaf-pinned) = `(amount − fee)` (M) + `fee` (leg) — **no kernel
  needed**. `fee = 0` ⇒ self-claim; `fee > 0` ⇒ gasless relay (the recipient nets `amount − fee`).
- Bind `deadline` into the ≤ claim-window gate (contract: `block.timestamp ≤ deadline`).

**OP_STEALTH_REFUND (25)** — typo/dead-address safety, identical to OP_ADAPTOR_REFUND but over the stealth leaf:
- Reconstruct the stealth leaf, membership, ν_L; output to `locker` (locker's opening), optional fee
  (`verify_kernel_with_fee`); `deadline` into the ≥ refund-window gate. The locker reclaims if never claimed.

### Security argument
- **Sender can't spend.** `L` lives in the lock-set (not the note tree) → unreachable by transfer/swap despite
  the sender knowing `r_L`; the only spend is the claim, which needs `owner_pub`'s key. The sender knows `O`
  and `s` but not `b` → not `b+s` → can't sign → can't claim. The refund goes only to `locker` (the sender),
  so a sender *reclaiming their own unclaimed funds* after the deadline is the intended path, not theft.
- **Nobody else can spend.** Membership pins `owner_pub`; the claim sig is under it.
- **No inflation.** `amount` is leaf-pinned (membership) and `M` opens to `amount − fee` with the `fee` leg;
  a malicious claimer can neither reconstruct the leaf with a different `amount` nor over-mint `M`.
- **Relayer-safe.** The claim sig binds `M` + `fee`, so a settler can neither redirect the output nor pad the
  fee; `amount`/commitments stay prover-visible (never in PublicValues) — confidential throughout.

### Scan / discovery (off-chain, no guest change)
The recipient scans the lock-set: for each stealth lock's published `E`, derive `s = H(b·E)`,
`O' = B + s·G`; if `O'` matches the leaf's `owner_pub`, it's theirs — decrypt the `amount` from the memo and
claim. Recipient-agnostic indexer scan already exists; this adds the `E`-trial-decrypt per stealth lock.

## Relay / wiring
Lock + claim + refund are relayable (claim/refund carry an optional fee; lock is fee-less value-locking, like
adaptor lock). Add `stealthlock`/`stealthclaim`/`stealthrefund` to the allowlist + `harness_for` + the box
harnesses + `relay-quote` fee-leg map (lock/fee-less; claim/refund single fee leg). Dapp: a
`confidential-stealth.js` mirror (leaf, claim-msg, one-time-key derivation, scan, op builders).

## Status
Folds into the coordinated re-prove (3 new ops → new vkey). **NO contract change** — the stealth claim/refund
reuse the existing lock-set `lockSpent`/deadline settle gating (confirmed by the adversarial review).

**DONE:** cxfer-core primitives + 2 unit tests; the 3 guest ops + an `owner_pub` curve-validity guard at lock
(compile clean); the JS mirror (`dapp/confidential-stealth.js`) incl. the op-assemblers
(`buildStealthLock/Claim/Refund`); two tests — `tests/confidential-stealth.mjs` (3/3: byte-parity +
one-time-address round-trip + claim-sig round-trip) and `tests/confidential-stealth-op.mjs` (3/3:
lock/claim openings + claim sig + refund conservation); relay wiring (allowlist + `relay-quote` fee-leg +
`harness_for` + 3 box harnesses `exec-stealth*.rs`). **Adversarial review: SAFE** — two independent passes
found no theft/inflation/double-spend/replay/redirect/cross-domain hole; the one recoverable residual (a
non-curve `owner_pub` self-grief) is now plugged by the lock-time guard.

**REMAINING:** box-validate the 3 harnesses (`MODE=execute`, the exact `net = amount − fee` opening context);
wire the dapp send/receive UI + the lock-set scan; then the re-prove rotates the vkey.
