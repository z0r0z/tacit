# Competitive Findings (cf)

Factual, sourced notes comparing Tacit to other Bitcoin/crypto protocols, for use
when drafting public comparisons.

Rules for this doc:
- Separate **verified fact** (with a source/receipt) from **inference** (label it).
- Prefer primary sources (their own specs/repos/on-chain state) over marketing pages.
- Date anything that can change (on-chain state, frontends, roadmaps).
- Keep claims defensible — note the rebuttals a knowledgeable critic would make.

Last updated: 2026-06-05

---

## Zcash Orchard counterfeiting bug (June 2026) — "privacy coins" vs. fixed-supply + protocol-layer privacy

**What it is:** On 2026-05-29 Taylor Hornby (audit for Shielded Labs) found a soundness
bug in Zcash's Orchard shielded-pool circuit (`halo2_gadgets`): an under-constrained
elliptic-curve multiplication let arbitrary false inputs pass verification, enabling
**unlimited, undetectable counterfeit ZEC** inside Orchard. Live since Orchard's May 2022
activation (~4 years). Emergency soft fork disabled Orchard 2026-06-02; NU6.2 hard fork
shipped a corrected circuit 2026-06-03. Found with help from Anthropic's Opus 4.8.

### Key finding — the supply rule lived *inside* the zk circuit, so a soundness bug = silent inflation

- Shielded Labs' own words: *"there is no definitive way to determine using only
  cryptography whether such exploitation occurred before the vulnerability was discovered
  and fixed"* — and users *"should not rely on our assessment, or anyone else's."*
- Their proposed remedy is a new shielded pool + **turnstile accounting so anyone can
  verify the ZEC supply** — i.e. today, nobody can. (Monero is structurally worse on this
  axis: everything is shielded by default, so there is no turnstile and supply integrity
  rests on range-proof/key-image soundness forever.)
- This is Zcash's **second** unlimited-counterfeiting bug (BCTV14, disclosed Feb 2019).

### Tacit contrast — TAC's supply enforcement is *outside* any circuit

Two independent, publicly checkable facts. Neither lives in a zk circuit, so there is no
gadget to under-constrain:

1. **Issuance is provably closed.** TAC's etch (a CETCH envelope on Bitcoin) carries a
   32-byte `mint_authority`. For TAC it is all-zero (the protocol's non-mintable value);
   a `T_MINT` requires a Schnorr sig under that key, and the zero key signs nothing.
   `mint_authority` is permanent — no rotate/transfer short of a protocol hard fork
   (SPEC.md §5.1, line ~750).
2. **The one issuance is provably 21M.** The etch commits to supply as a Pedersen
   commitment `C = supply·H + blinding·G`. The `(supply, blinding)` opening is published
   to IPFS, content-addressed by the same `image_uri` the on-chain etch points to. Anyone
   checks `pedersenCommit(supply, blinding) == on_chain_commitment` — one line, no worker,
   no setup. Pedersen binding makes a forged "21M" opening infeasible.

Net: total supply = 21M, **monotonically non-increasing** (the only supply-changing op is
`T_BURN`, which reveals its amount in the clear). Transfers can't inflate either —
conservation is a Mimblewimble kernel signature (`Σout (+burn·H) − Σin` must commit to
zero), an algebraic identity, not a bespoke circuit (the same CT/Bulletproofs family
Monero has run since 2018).

### Verified facts (the receipts) — real live TAC, as of 2026-06-05

Asset `f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b` (ticker `TAC`,
mainnet; `CANONICAL_TAC_ASSET_ID_HEX` in `worker/src/index.js`):

- **asset_id binds to the etch tx (local, trustless):**
  `SHA256(etch_txid_internalLE ‖ vout_LE4(0)) == f0bbe868…762b`, where etch_txid =
  `e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e`. Recomputed —
  **matches**. So TAC is that one etch, by construction; no indexer can relabel it.
- **on-chain etch fields** (worker `/assets/<id>?network=mainnet`, 2026-06-05): `mintable:
  false`, `mint_authority: 0000…0000`, `commitment:
  02f5a454ee1e79c29e746e945143d12a19607f4b7188e6d9c00573824bd12ffc64`, `image_uri:
  ipfs://bafkreig7m5j66zlaewjvo6bipk723udgdhnyl7ve5k2suofuvhi2mmb3ai`, `decimals: 8`.
- **IPFS attestation blob** (`bafkreig7m5j66…mmb3ai`): `tacit_attest.supply =
  2100000000000000`, `blinding =
  ce741e62560579ae264c942e1575df86fe2b52884f92303ae9666fe3138b7e48`.
- **Pedersen opening verifies (local, using the dapp's own secp256k1 + NUMS-H):**
  `pedersenCommit(2100000000000000, 0xce741e62…7e48)` reproduces
  `02f5a454…ffc64` byte-for-byte. `2100000000000000 / 10^8 = 21,000,000 TAC`. ✓

Reproduce: (1) recompute the asset_id hash; (2) read `mint_authority` + `commitment` from
the etch reveal tx `e2d10be1…` (fully trustless: decode the Taproot-witness CETCH envelope
yourself; or read the worker, which only relays public chain data); (3) fetch the IPFS
opening; (4) check it opens the commitment.

### Be fair / honesty guardrails

- **Proves total issuance, not who-holds-what.** TAC amounts are confidential, so you do
  NOT audit supply by summing balances — you prove issuance is closed (mint key = 0) and
  the one issuance opens to 21M. That's the point: the cap is enforced at issuance, so a
  *transfer*-layer bug can't inflate it.
- **Shielding (sender/receiver unlinkability) is opt-in and relies on a one-time MPC
  ceremony** (mixer ceremony finalized 2026-05-11). Amount-confidentiality is default and
  ceremony-free (Pedersen + Bulletproofs, transparent setup); linkage-privacy needs the
  shielded layer. Don't conflate the two.
- **"Fairdropped" needs its own receipt.** A CETCH mints the full 21M to the etcher at
  genesis (one supply UTXO), which is NOT itself a fairdrop. Any "fair distribution" claim
  is about what happened *after* etch (a public `T_DROP`/claim, LP seeding, no-team-alloc,
  etc.) and must be backed separately — it is orthogonal to the no-inflation proof above.

### Defensible public claims

- **Airtight (verified above):** "TAC's on-chain etch is non-mintable (`mint_authority =
  0`) and its supply commitment provably opens to exactly 21,000,000 — checkable from
  Bitcoin + IPFS, no circuit, no trusted setup, no indexer. Re-verified 2026-06-05."
- **Strong contrast (Zcash's own admission):** "Zcash can't rule out prior inflation
  because its supply rule lives inside the Orchard circuit; TAC's lives in a public
  mint-authority byte + a one-line Pedersen check."
- **Avoid (overreach):** "fully anonymous by default" (linkage-privacy is opt-in);
  "audit the supply by summing balances" (amounts are hidden); unbacked "fairdrop"
  framing.

### Sources

- The Orchard Counterfeiting Vulnerability (Zcash community forum): https://forum.zcashcommunity.com/t/the-orchard-counterfeiting-vulnerability-and-next-steps/56015
- CoinDesk: https://www.coindesk.com/markets/2026/06/05/zcash-plummets-30-as-developer-reveals-a-major-bug-that-went-undetected-for-four-years
- The Defiant (turnstile / prove-supply proposal): https://thedefiant.io/news/blockchains/shielded-labs-proposes-new-zcash-upgrade-to-prove-zec-supply-after-orchard-bug
- TAC etch on-chain + attestation: asset `f0bbe868…762b`, etch tx `e2d10be1…ca481e`, IPFS `bafkreig7m5j66…mmb3ai` (verified 2026-06-05)

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
