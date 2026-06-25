# Competitive Findings (cf)

Factual, sourced notes comparing Tacit to other Bitcoin/crypto protocols, for use
when drafting public comparisons, documentation, and marketing.

Rules for this doc:
- Separate **verified fact** (with a source/receipt) from **inference** (label it).
- Prefer primary sources (their own specs/repos/on-chain state) over marketing pages.
- Date anything that can change (on-chain state, frontends, roadmaps).
- Keep claims defensible — note the rebuttals a knowledgeable critic would make.
- Competitor names belong **here** (this is the comparison doc); keep shipped code + public
  docs subtle (categories, not names).

Last updated: 2026-06-22

This doc has two layers: a **landscape survey** (where Tacit sits across the privacy-DeFi and
cross-chain-BTC field) and **per-project deep findings** (sourced, dated, with receipts).

---

## Landscape survey — privacy-DeFi & cross-chain BTC (2026-06-22)

Grounded survey of the field and where Tacit fits, plus a prioritized roadmap. Point-in-time
figures (TVL/volume) drift — treat them as orders of magnitude.

### Bottom line

No live competitor combines what Tacit does: an EVM **shielded-note pool** with, in the *same*
set, a **confidential AMM** (hidden amounts vs public reserves) + a **confidential orderbook**
(OTC, partial-fill limit bids, cross-chain adaptor swaps) + a **CDP stablecoin** (cUSD) +
**farms/savings** + a **Bitcoin↔Ethereum cross-chain abstraction** (both-side confidential
pools, self-custody cBTC, a fast lane that spends a Bitcoin-homed note on Ethereum) +
**relay-for-every-op** (gasless, fee bound in the proof).

Each rival is strong on one axis and absent on most others. Tacit's real risk isn't "someone
already built this" — it's **maturity and traction** vs Railgun/Penumbra, and the **structural
novelty** of cross-chain shielded spend (no prior art cuts both ways). The defensible, citable
claim: **no production system shields amounts *and* parties across BTC↔ETH** — Maya records
"amounts in clear," Zcash×NEAR intents were de-anon'd at the transparent refund leg,
Penumbra/Namada leak at the IBC boundary.

### The field (grounded)

**Private DeFi on EVM / L1s**
- **Railgun** — the live incumbent to beat: shielded EVM balances, ~$82M TVL, >$2B lifetime,
  10+ audits. But its "private DeFi" is **unshield → act on public DeFi → re-shield** (Relay
  Adapt) — every swap's tokens, amounts, and counterparty contract **leak mid-tx**. Its
  **Broadcaster** (gasless, fee in the transacted token, deducted in-proof) is the closest analog
  to Tacit's relay; **PPOI** (private proofs of innocence) is a compliance moat Vitalik publicly
  praised. No native AMM/orderbook/stablecoin, no Bitcoin, per-chain isolated sets.
  [docs.railgun.org], [defillama.com/protocol/railgun]
- **Penumbra** — the architectural sibling: Zcash-lineage shielded multi-asset pool, a
  **sealed-bid batch-auction DEX**, shielded staking. But on mainnet the **swap amount +
  direction are public** (flow encryption never shipped), LP positions are public, **no
  stablecoin/lending, no relayer, IBC-only (no ETH/BTC)**, network economically near-dead (~$11K
  TVL, Labs winding down). Its batch-auction (uniform price per block, kills sandwiching) is the
  one idea worth borrowing. [protocol.penumbra.zone/main/dex.html]
- **Aztec** — the most general private platform (Noir, client-side proving, **FPC** fee
  abstraction). But **no mainnet, no shipped confidential AMM** (per-user notes vs shared reserves
  is still research), no BTC. The long-term platform threat, not a current product. [aztec.network]
- **Renegade** — best-in-class **hidden-order matching** (MPC dark pool, crosses at the Binance
  midpoint). Single-purpose: spot crosses only, no AMM/LP/stablecoin/BTC, external price oracle.
  [docs.renegade.fi]
- **Namada / Aleo / FHE (Zama/Fhenix/Inco)** — Namada is a shielding hub (unified MASP set,
  shielded rewards) with **no DEX**; a ~$600K MASP drain hit it June 2026. Aleo has institutional
  stablecoins (USDCx/USAD) but thin DeFi. **FHE's trust model differs fundamentally**: state is an
  encrypted ciphertext a **threshold-decryption committee can decrypt by colluding** — in a
  zk-shielded design *no quorum can unmask a note*. Zama is the only live FHE mainnet (~121M USDT
  shielded in weeks). [specs.namada.net], [docs.zama.org]

**Cross-chain BTC & Bitcoin privacy**
- **THORChain / Maya** — native (bridgeless) BTC↔ETH swaps, but **custodial bonded TSS vaults**;
  THORChain suffered a **realized ~$11M key-reconstruction drain (May 2026)**. Maya (Zcash-leaning)
  still **records amounts in clear** on its chain — no private path. Dominant liquidity and a
  powerful **affiliate program** (the growth engine). [docs.thorchain.org]
- **wBTC / tBTC / Rootstock / Lombard / BitVM bridges** — all **transparent** wrapped/staked BTC
  with a custodian, a federation (Rootstock 5-of-9, Lombard 14-member), a 100-node honest-majority
  (tBTC), or a new 1-of-N BitVM operator-liveness model (Bitlayer live July 2025). None private.
- **Adaptor-signature atomic swaps** — the cryptography is proven (publishing the completed sig
  leaks the secret `t` cross-chain), but the **only live production swap is XMR↔BTC** (eigenwallet),
  and it dies on liquidity / online-counterparty / 20–60 min latency. Boltz is HTLC-based, not
  adaptor. [conduition.io/scriptless/adaptorsigs]
- **Bitcoin privacy post-2024** — Wasabi/Samourai coinjoins shut down; statechains (Mercury), Ark
  (Bark live June 2026), ecash (Cashu/Fedimint, but custodial/federated), Silent Payments
  (receiver-only) remain. **Bitcoin L1 has no native shielded pool.** The closest shielded-BTC
  product, strkBTC, runs a 5-member federation at the wrap. [bitcoinops.org]

**The universal pattern:** shielded pools are private *within one domain*; the cross-chain hop is
transparent and timing/amount correlation re-links the parties. That seam is where Tacit lives.

### Where Tacit stands

**Superior (combinations nobody ships)**
1. **In-pool confidential DeFi** — hidden-amount AMM + orderbook in one shielded set, vs Railgun's
   leak-everything exit-and-return, Penumbra's public swap amounts, Aztec's not-yet-shipped AMM.
2. **Breadth in one set** — AMM + orderbook + CDP stablecoin + farms/savings; no rival combines these.
3. **Self-custody, federation-free, shielded BTC** — every shielded-BTC product on the market is
   custodial/federated; an SP1-proven self-custody cBTC with hidden amounts has no live peer.
4. **Cross-chain shielded fast lane** — spending a Bitcoin-homed note on Ethereum via a shared
   nullifier set is unoccupied territory (Aztec/Namada/Anoma sets are per-chain).
5. **Relay-for-every-op, fee bound in the proof** — a *uniform* gasless relay across
   swap/LP/OTC/bid/CDP/bridge, broader than Railgun's Broadcaster or Aztec's FPC.
6. **No decryption committee** — unlike FHE, no quorum can ever unmask a note; privacy doesn't
   degrade under collusion. The sharpest institutional pitch in the space.

**Parity** — the shielded-pool cryptography (Pedersen + range proofs + nullifiers) is the
Zcash/Railgun family; secp256k1 + Bulletproofs+ is competitive and trusted-setup-free but not
categorically novel. Gasless-relay mechanics match Railgun's Broadcaster. Adaptor-swap atomicity is
the same primitive everyone has; the novelty is wrapping it in shielded, aggregated liquidity.

**Behind (and what closes it)** — **maturity/TVL/audit depth** (Railgun's years + $82M is the
single biggest gap; closes only with time, traction, and review); **general programmability**
(Aztec — don't chase it, be a complete vertical product); **pure order-resting privacy**
(Renegade's MPC; a batch/sealed-bid clearing narrows it); **stablecoin distribution** (Zama/Aleo
have partners — but cUSD is *natively private and self-issued*, which their wrapped institutional
stables are not).

### Improvement roadmap

**Shipped this cycle**
- Relay-for-every-op (gasless privacy across swap/LP/OTC/bid/route/transfer/CDP/farm/bridge); see
  [DESIGN-confidential-relay-fees.md](../ops/DESIGN-confidential-relay-fees.md).
- Gas-priced quote + profitability guard (`worker/src/relay-quote.js`) — the undercut lever.
- `TacitRelayer.sol` — permissionless batching, atomic `minOut` profitability guard, and **native
  affiliate fee-split** (`recipients`/`bps`) so a wallet/front-end earns a share for routing flow.
- Gasless cross-chain entry — `bridge_mint` + `cbtc_mint` relay-routed (BTC → ETH / BTC → cBTC with
  **zero user ETH**); self-funding entry (mint fee-less, fee rides a bundled cBTC spend).

**Fast-follow (high value, tractable)**
1. **Non-interactive stealth-receive** (one published shielded address, unlinkable per-payment,
   recipient-scannable). The blinded-pubkey commit primitive already exists; a guest owner-key gate
   makes it static. The single biggest payments-UX moat; table-stakes for private *payments*.
2. **Affiliate program wiring** — the contract support now exists; wire the dapp to route flow to
   affiliate-split relayers (the proven distribution engine; "private BTC swaps" is a differentiated
   thing for a wallet to offer post-Wasabi/Samourai).
3. **Universal fee abstraction** — a user holding *only* cBTC opens a cUSD CDP / swaps / LPs without
   ever touching the gas or base asset. Mostly there via the relay; make it a first-class "enter
   once with BTC, do anything" flow.
4. **Adaptor-swap-as-liquidity-aggregator** — make the shielded pool the always-online counterparty
   for cross-chain atomic swaps, solving the "maker must be online + no order book" constraint that
   has capped every adaptor swap. The most differentiated cross-chain move available.

**Later (bigger lifts, strong moats)**
5. **Optional viewing keys** — user-held selective disclosure for opt-in audit/reporting, paired
   with the "no decryption committee" pitch (sharper than FHE's).
6. **Pluggable proofs-of-innocence on entry** — optional association-set membership on shield/bridge
   entry (esp. the BTC lane), de-risking listings without weakening honest-user privacy.
7. **Per-block sealed-bid batch clearing for the AMM** — extend the existing uniform-price intent
   clearing to cross-user batches: hidden-amount *and* MEV-resistant swaps.
8. **BitVM-style fraud-proof fallback for the cBTC peg** — a 1-of-N honest-watcher challenge
   alongside the slashable escrow, the strongest *advertised* trust model while keeping self-custody.

### Defensible positioning claims (citable)

- "The only system that keeps **amounts and parties shielded across BTC↔ETH**." (Maya/Zashi×NEAR/
  Penumbra/Namada all leak at the seam.)
- "**In-pool** confidential DeFi" — trade without ever unshielding (vs exit-and-return).
- "**Self-custody BTC, no federation or bonded vault**" (vs TSS vaults, custodians, 100-node /
  federated pegs).
- "**No decryption committee** can ever unmask your note" (vs FHE threshold quorums).
- "**Gasless across every op** — enter once with BTC or ETH, stay private throughout."

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
