# PLAN — generational shielded pools (iterate Ethereum, continuity via Tacit + reflection)

> The design principle behind `PLAN-teth-subsumption.md` §Generational continuity, made first-class.
> **Ethereum shielded pools are disposable execution layers; Bitcoin/Tacit is the durable state layer.** You
> deploy a new immutable `ConfidentialPool` generation whenever you want to harden / rotate vkeys / add ops,
> and assets carry across generations via the canonical Bitcoin id + reflection — **never** via an upgrade
> authority or shared mutable custody (the tETH lesson). This is the rollup shape
> (`PLAN-confidential-token-rollup`) applied to the pool's own lifecycle: Bitcoin = DA/continuity, Ethereum
> gens = execution.

## What a "generation" is
An immutable `ConfidentialPool` deploy with its own note tree, nullifier set, escrow, and pinned vkeys. You
spin up gen-N+1 to: rotate the settle/reflection vkeys (new guest features), fix a bug, harden the relay
anchor, or add ops — **none of which an immutable contract can do in place**, by design. mixer = gen-0,
the current `ConfidentialPool` = gen-1, future hardening = gen-2.

## Continuity is per-ASSET, not per-GENERATION
The thing that persists is the **canonical Bitcoin asset id** (and the Bitcoin confidential-pool reflection
state), both generation-independent:
- The Bitcoin pool is ONE multi-asset tree; its root (`bitcoinPoolRoot`) commits every asset's notes. Every
  generation attests that same root.
- A new gen **registers the same canonical assets** (same ids) and **anchors to the same reflection** — it's
  a client of one durable Bitcoin-anchored ledger, not a fork with its own asset namespace.
- So "your TAC / tETH" is an asset-level fact at the Tacit layer; *which* Ethereum gen you currently hold it
  in is incidental.

### How a new gen joins the shared reflection (near-tip anchor)
The reflection is a resume-digest chain; a gen seeded at the protocol genesis digest would have to re-fold
all Bitcoin history to catch up (the 73-block bootstrap OOM). So a new gen deploys with its
`REFLECTION_GENESIS_DIGEST` / `genesisReflectionAnchor` set to the **current** Bitcoin reflection state
(near-tip) — the same launch pattern used for gen-1. Because `bitcoinPoolRoot` at the anchor already commits
all prior notes, the new gen can `bridge_mint` ANY existing Bitcoin note from day one; it just trusts the
anchored root as its starting point (a deploy-time, explorer-verifiable anchor, exactly like genesis). No
history replay, no loss of reachable assets.

## Migration paths (value moving gen-N → gen-N+1)

### A. Via the Bitcoin hub — the trust-minimized default
`crossOut` (gen-N → Bitcoin) → fast-lane / `bridge_mint` (Bitcoin → gen-N+1), the SAME machinery that
bridges Bitcoin↔Ethereum, with the canonical id making it the same asset. **Crucially this is the safe path
when gen-N+1 exists *because* gen-N had a problem:** value routes through Bitcoin (the trust root), so
gen-N+1 never has to trust gen-N's (possibly buggy) state. Cost: a Bitcoin round-trip (confirmations).

### B. Direct gen-to-gen — an optimization, only between TRUSTED gens
The Mode-B eth-reflection already reads another Ethereum contract's storage via `eth_getProof` (it reads the
pool's `crossOutCommitment`). The same primitive can read a **sibling generation**: gen-N+1 `bridge_mint`s
directly from a proven gen-N burn, no Bitcoin round-trip — fast, Ethereum-native. **But it couples gen-N+1
to gen-N's soundness** (it trusts gen-N's vkey/state). So it is allowed ONLY between generations with no
security relationship (a feature-add gen, not a bug-fix gen); **never** use it to escape a gen you're
replacing because it's broken. Default to path A; offer B as an opt-in fast lane between healthy gens.

## Two asset classes, two migration costs
- **Pure-Tacit assets (TAC, …): trustless and frictionless.** No physical underlying — gen-N+1 mints against
  the reflected Bitcoin state. Migration is just a value move via the hub.
- **Underlying-backed assets (tETH = ETH, external ERC20s): user-paced redeem + redeposit.** The escrow is
  physical, so the value migrates by **redeem-from-gen-N + deposit-into-gen-N+1** — user-initiated,
  trustless, and with **NO shared vault and NO authorized-spender handoff.** A shared ETH vault with a
  mutable "which gen may spend it" is precisely the owner-upgradeable component we refuse; so each gen is
  self-custodial for its own escrow, the old gen stays redeemable, and users migrate at their pace.

## Migration UX
Behind one **"Migrate to gen-N"** affordance in the dapp:
- pure-Tacit → a single hub move (or the direct path B between healthy gens);
- underlying-backed → chain redeem-old + deposit-new so it reads as one tap.
Surface it as opt-in, never forced — the old gen keeps working. Show "this asset lives in gen-(N-1); move it
to gen-N?" rather than breaking anything.

## The discipline (the rules that keep it clean)
1. **No upgrade authority, ever.** No proxy, no owner-mutable verifier/custodian on the value path (the tETH
   lesson). A "new version" is a new immutable deploy.
2. **No shared mutable custody.** Each gen holds its own escrow; continuity is the canonical id + reflection
   + user-paced migration, not a contract anyone can re-point.
3. **Old gens stay self-custodially redeemable** — deprecate, don't brick. Users move on their own clock.
4. **Cross-gen value defaults to the Bitcoin hub** (trust-minimized); the direct gen-to-gen path is opt-in
   and only between gens with no security relationship.
5. **New gens near-tip-anchor** to the shared reflection — no history replay.

## Who maintains generations? — nobody needs to (the trust model)
**For soundness: neither an operator nor a consensus.** A generation is a fresh immutable deploy whose
correctness is self-verifying:
- it verifies SP1 proofs against IMMUTABLE pinned vkeys (no operator can change them post-deploy);
- it anchors to the PoW-validated Bitcoin relay + the shared reflection (**Bitcoin is the trust root**);
- its escrow / mint accounting is enforced by the immutable contract.

Every deploy-time parameter — the vkeys, the relay, the genesis/near-tip anchor, the resume digest — is
**publicly verifiable**: the vkey must equal the published audited guest ELF; the anchor must be a real
Bitcoin block / the real reflected state. A malicious deployer **cannot hide a backdoor** — it shows as a
non-canonical vkey or a forged anchor, and users / the dapp simply don't adopt that gen. So no one has to
"trust the operator" for safety, and there is nothing for a consensus to decide.

**What IS social / operator — and it touches only liveness + coordination, never funds:**
- **Which gen is "current" is a Schelling point.** The dapp points at one; users verify its params and
  choose. Deliberately NOT enforced on-chain — an on-chain "current generation" pointer would be exactly the
  upgrade authority we refuse. The cost of disagreement is split liquidity / anonymity set, NOT unsoundness:
  competing gens are each individually sound.
- **The reflection prover must run.** Someone proves Bitcoin state and submits attests — permissionless for
  soundness (the proof is verified on-chain; anyone can submit a valid one), a single availability
  dependency today, decentralizable later.
- **Funds are always user-custodial.** No operator controls notes/escrow; the old gen stays self-custodially
  redeemable; migration is user-initiated. Nobody can strand or seize value on a gen rollover.

Same trust model as the rest of Tacit (Bitcoin is the root; the dapp suggests, the user verifies; the worker
is discovery/liveness-only). Generations *inherit* it rather than add anything — which is the whole payoff of
refusing an upgrade authority: a "new version" is a self-verifying deploy, not a trusted act.

## Status (2026-06-17) — gating fact VERIFIED + the one blocker FIXED
- **Confidential continuity holds by construction.** A canonical asset's identity is the Bitcoin id (the
  `crossChainLink` / etch), gen-independent, and the Bitcoin reflection is ONE multi-asset tree
  (`bitcoinPoolRoot` commits every asset). A fresh gen registering the same ids reaches the same assets.
- **Public ERC20 is gen-specific — and that's the trustless price.** `CanonicalAssetFactory._slot` binds the
  **minter** (the pool gen) into the CREATE2 salt, so gen-1's TAC ERC20 ≠ gen-2's. The *confidential* asset
  is continuous; only the *public* ERC20 fragments per gen. **Moot for tETH** (subsumed → native ETH, no
  ERC20). For pure-Tacit ERC20s it's documented, not fixed (a shared minter authority would be exactly the
  upgrade authority we refuse).
- **The one real blocker — FIXED.** `REFLECTION_GENESIS_DIGEST` was a compile-pinned `constant` that the
  ctor hard-seeded into `knownReflectionDigest`, so a fresh gen would resume from protocol genesis (replay
  the whole Bitcoin history → OOM). **Landed:** a `reflectionResumeDigest_` ctor param (0 ⇒ genesis for
  gen-1; non-zero ⇒ near-tip resume for gen-N), the `DeployConfidentialPool` env `REFLECTION_RESUME_DIGEST`,
  and `test_generational_reflection_resume_digest`. Full pool suite green. A new gen can now near-tip-anchor.

## What this needs (mostly already built)
- **Reused:** the canonical Bitcoin id + etch; the multi-asset Bitcoin reflection (`bitcoinPoolRoot` commits
  all assets); `crossOut` + `bridge_mint` + the fast lane; the near-tip-anchor launch pattern; immutable
  per-deploy contracts (the no-flag / no-upgrade decisions we already made — those weren't just hygiene,
  they're what makes this story possible).
- **New / to confirm:** that registering the SAME canonical assets in a fresh gen + a near-tip reflection
  anchor "just works" (it should — assets are id-keyed, the root commits history); the dapp "migrate"
  affordance; (optional, later) the direct gen-to-gen path B reusing eth-reflection against a sibling.

## Phasing
1. **Document + verify the invariant:** a fresh gen deployed with the same canonical asset ids + a near-tip
   anchor can `bridge_mint` existing Bitcoin notes (no asset-namespace divergence, no history replay).
2. **Ship the dapp migrate affordance** (path A for everything; redeem+deposit for underlying-backed).
3. **Treat mixer→pool as gen-0→gen-1** — the first real exercise of the pattern (pilot ETH is trivial).
4. **(Later) path B** — direct gen-to-gen via eth-reflection, gated to healthy-gen pairs only.

The payoff: you can iterate the Ethereum confidential pool as fast as you can prove + deploy a new ELF, with
zero migration drama and zero upgrade-authority risk — because the asset graph lives at the Tacit layer and
Bitcoin is the continuity hub, not any one Ethereum contract.
