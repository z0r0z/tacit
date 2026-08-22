# Response to the Tacit V1 audit (four passes)

Thank you — this was a genuinely thorough sweep across the whole fund-safety surface, and the seam-level
findings (the late ownership change not traced through every consumer) are exactly right. Status per finding:

## Fixed
- **C-1 (burn-deposit mint unspendable).** Fixed at BOTH sites — `OP_BRIDGE_MINT` (main.rs:958) and
  `OP_BRIDGE_STEALTH_MINT` (:1083): class-0 now takes the leaf-bound `nullifier(&in_leaf)` the reflection
  recorded as `env_nu`, matching classes 1/2. Confirmed the leaf-bound ν of `leaf(asset,cx,cy,0)` lives in a
  different keccak domain from any native ν, so no collision.
- **cBTC / owner-zero bearer notes (fourth-pass finding, C-1 class).** Generalized the repair: `native_input`
  and `native_nu` now dispatch on `owner == 0` → leaf-bound ν (bearer: control is the blinding via the
  conservation kernel, not a spend key), else the secret-key ν. A real owner is a keccak image and is never
  zero, so the split is unambiguous. This unblocks `OP_CBTC_MINT` (:5096) and its escrow, the scan-free
  burn-deposit, and every owner-free note in one place.

## Accepted, in progress (executing on the prover box for reliable multi-ELF validation)
- **C-2 (owner overload across CDP/farm/adaptor/stealth).** Accepted as the largest blocker. We are keeping the
  secret-key nullifier's privacy rather than reverting, so the fix is the structural separation you describe:
  a distinct `auth_pubkey` bound into every position/lock/receipt leaf and sigma context, `owner = H(nk)` on
  every minted spendable note (witnessed and bound into each op's authorizing signature so a settler can't
  redirect it), owner-zero forbidden on spendable leaves. Includes the reflection farm folds that mint the same
  way. Ships with an executable round-trip test per mint→exit→spend chain on native, deposit and btcHomed inputs.
- **H-1/H-2/H-3/H-4 (reflection liveness).** Accepted. H-1: relax the crossOut gate to `<=` with defer-not-skip
  on a non-member 0x65 (this is what closes the dust-crossOut halt); the consume gate stays `==NOW` (an
  instant+atomic fast lane provably requires it; F-10 small batches keep it satisfiable). H-2: carry the
  sync-committee forward via contract state + PV output (eth-guest groundwork already landed). H-3: prefix
  batches (guest PoW-linkage from the pinned prev + burial, not blockHeight-burial) + a Merkleized live set for
  O(Δ) proof memory (also removes the O(n·m) insert cost you flagged). H-4: gate fast-lane spends on a spent
  root attested after the note's reflected creation + a margin. Prover block/live-set capacity will be measured
  before we set REFLECTION_FINALITY_WINDOW.
- **M-6 (swap-batch receipt range).** Adding the guest-side BP+ range proof over the secp receipt commitments in
  `fold_swap_batch`, the same primitive `OP_SWAP` uses — so Bitcoin-side receipt soundness no longer rests on
  the out-of-bundle circuit.

## Accepted with documentation (residual, immutable-deploy risk)
- M-1 relay genesis + resume-digest deploy trust (publishing reproducible derivations); M-2 ethPool on-chain-only
  gate (documented assembler requirement); M-4 cBTC margin-call armed or cBTC de-scoped at launch; M-5 dapp
  one-owner-per-note (moot for bearer notes; the BID path derives a dedicated funding owner); L-3 refund fallback
  for malformed CXFER/burn envelopes; L-4 documented; the 6-block reorg halt documented.
- Dropping the legacy `teth-tree` crate from the bundle (unused by any shipped ELF).

## Ask
The unread farm folds (reward-minting authority), `fold_lp_remove`/`fold_swap_route`/`fold_protocol_fee_claim`,
and the router zaps deserve the second pass you flagged. We'll re-bundle after C-2 + the liveness batch land and
would value a re-review of the changed surface, particularly the auth_pubkey separation and the new round-trip
tests.
