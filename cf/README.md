# Competitive Findings (cf)

Factual, sourced notes comparing Tacit to other Bitcoin/crypto protocols, for use
when drafting public comparisons.

Rules for this doc:
- Separate **verified fact** (with a source/receipt) from **inference** (label it).
- Prefer primary sources (their own specs/repos/on-chain state) over marketing pages.
- Date anything that can change (on-chain state, frontends, roadmaps).
- Keep claims defensible — note the rebuttals a knowledgeable critic would make.

Last updated: 2026-05-28

---

## TAP Protocol / Taparooswap (Trac Systems)

**What it is:** TAP is a Bitcoin metaprotocol (an improved BRC-20, ordinals/inscription
based, indexer-validated via Trac Network). Taparooswap is its AMM/DEX, marketed as
"Bitcoin's first L1 AMM" (launched Nov 2024).

### Key finding — the AMM settles on a trusted authority signature, not Bitcoin-verified proofs

- TAP's only programmable-payout primitive is `token-auth`: a 3rd-party **authority**
  signs `redeem` inscriptions (secp256k1). Indexers verify **only** the signature +
  that the ticker was pre-authorized + hash uniqueness + not-cancelled — **not** the
  math, **not** any binding to what a user is owed. The spec states it *"relies solely
  on message signatures and does not require sequencers or L2 mediators"* and explicitly
  contrasts itself with zk-rollups. So TAP has **no** trustless primitive that could
  enforce AMM math.
- The Taparooswap AMM is implemented as an **ICP canister acting as that authority.**
  Direct quote from the launch article:
  > "The smart contract for the swap/amm has been implemented using ICP as a TAP
  > Protocol authority."

### Canister — verified on-chain (NOT blackholed)

- Canister ID: `5ez4n-ayaaa-aaaah-qdqua-cai`
- Dashboard: https://dashboard.internetcomputer.org/canister/5ez4n-ayaaa-aaaah-qdqua-cai
- Status **as of 2026-05-23** (IC dashboard API): **not blackholed.** Controllers:
  - `4sseg-viaaa-aaaah-qdqra-cai` (a controller canister)
  - `ddzwg-ass7o-h75ug-mbxqf-xu7zv-gqqix-7bbdw-wnguc-yuqln-sgqi4-7qe` (a **personal
    principal** — an individual's identity key)
  - `language: typescript` (Azle); `module_hash` `c7bb4f33c1505e35f8e56a2b3cbdb75dd1f002b6724197c8d22660af6d2027ec`
- **Implication:** a personal key can upgrade the canister (the AMM/authority code) at
  will. Trust reduces to the controllers — ultimately a dev key.

### Can the dev rug the AMM? — mechanically yes (capability, not accusation)

- **Proven:** the canister is not blackholed (above). On ICP, controllers act
  **independently** (not an N-of-M multisig) — any single controller can unilaterally
  `upgrade` / `reinstall` / `stop` the canister. So the personal-principal controller
  alone can swap out the code. And that canister is the authority that signs swap
  settlements.
- **Inference (well-grounded, label it):** under `token-auth`, pooled tokens are
  redeemed by the authority's signature, so upgraded code could sign `redeem`s that
  **drain the pool**, or the controller could **stop the canister / withhold sigs** to
  **freeze** withdrawals. Drain = "very likely possible"; freeze = "almost certainly
  possible" (stopping a canister you control is trivial).
- **Unverified:** Taparooswap's exact deposit/custody flow (limits, time-locks, user
  co-signing?). Standard token-auth has no such guardrails and none were observed, but
  an undocumented mitigation can't be ruled out.
- **Fairness:** say "could," not "will" — it's a *visible* capability (a canister
  upgrade changes the on-chain `module_hash`; redeems land on Bitcoin), not proof of
  intent; don't call it a scam. This risk class is common (most EVM bridges/L2s have
  admin keys). The sharp contrast: **Tacit has no controller in the settlement path**
  (immutable verifiers, no admin/owner/signer) — there's no key that *could* do this.

### Current frontend (observed 2026-05)

- `taparooswap.com` is Next.js on Vercel behind Cloudflare. The live bundles contain
  **no client-side ICP references**; the only backend the client calls is
  `inscribe.tapscope.io` (`/tap/transfer`, `/tap/mint`, `/tap/deploy`, `/text`,
  `/files`). The client does **no cryptographic verification** — only "inscribe."
- Direction: Trac is building its own P2P stack — "Trac Network" + "Main Settlement
  Bus" (Pear/Holepunch/Hypercore: `trac-peer`, `trac-network`, `main_settlement_bus`,
  `autobase`), with `$TRAC` slated to become that network's native asset (~Q1 2025
  target per roadmap). So the signer appears to be moving in-house, but it's still a
  signer.

### Be fair — what IS trustless in TAP

- `deploy` / `mint` / `transfer`, `token-send` (mass transfer), and `token-trade`
  (a P2P atomic order-fill) are genuinely trustless and indexer-validated.
- `token-auth` / `privilege-auth` / **the AMM** are authority-based (trusted signer).

### Defensible public claims

- **Airtight (cite spec + repo + dashboard):** "TAP's only programmable-settlement
  primitive, `token-auth`, is signature-based; their own boilerplate
  (`tap-icp-azle-boilerplate-canister`) builds DeFi as a canister acting as that
  authority; the Taparooswap canister isn't blackholed — a personal principal can
  upgrade it (2026-05-23)."
- **Inference (label it):** "Therefore the AMM settles on a trusted signer, not
  Bitcoin-verified proofs."
- **Avoid (overreach):** "custodial" / "not on Bitcoin." It's non-custodial in the
  wallet sense, and assets + settlement records do land on L1. The precise, stronger
  critique: *correctness isn't enforced by Bitcoin — it's authorized by a signer.*
- **Anticipated rebuttal:** "it's an ICP canister with threshold signatures across a
  subnet, not a dev key." True at one layer — but the **non-blackholed** fact defeats
  it: a personal key can rewrite the canister regardless.

### Tacit contrast

- **No trusted signer in the settlement path.** Swaps/transfers/withdrawals settle on
  proofs (Pedersen + bulletproof for `T_SWAP_VAR`; Groth16 batch for `T_SWAP_BATCH`)
  plus the user's **own** kernel signature, re-checked by every indexer from Bitcoin.
- Bridge contracts (`contracts/src/`): no `Ownable`/`onlyOwner`/admin/pause/upgrade;
  verifier dependencies are `immutable`. Worker (`worker/src/index.js`) only *verifies*
  Schnorr sigs — no signing key, no authority.
- **Honesty guardrails:** don't say "zero trust" — Tacit relies on a one-time
  trusted-setup **ceremony** (setup-time assumption, not a runtime signer); asset
  issuers may optionally retain a mint key (asset-level, not protocol); the AMM
  ceremony is per-pool and not yet finalized (pre-launch — frame the trustless AMM as
  design/spec, not "live today").

### Sources

- Launch article (via Wayback): https://web.archive.org/web/2025id_/https://medium.com/trac-systems/taparooswap-launch-5ce811cc82c4
- Boilerplate: https://github.com/Trac-Systems/tap-icp-azle-boilerplate-canister
- Specs (`token-auth`): https://github.com/Trac-Systems/tap-protocol-specs
- Canister: https://dashboard.internetcomputer.org/canister/5ez4n-ayaaa-aaaah-qdqua-cai

---

## Template for new entries

```
## <Project / Feature>

**What it is:** <one line>

### Key finding
- <claim> — <source/receipt>

### Verified facts (dated)
- <on-chain / observed state> (as of YYYY-MM-DD)

### Be fair
- <what's legitimately good / trustless about it>

### Defensible public claims
- Airtight: <...>
- Inference (label): <...>
- Avoid: <...>

### Tacit contrast
- <...>

### Sources
- <...>
```
