# Tacit: A Confidential, Self-Custodial Asset Protocol on Bitcoin

**z0r0z** · <https://tacit.finance> · 2026

> **Abstract.** A purely on-chain version of confidential value, anonymous
> spend, shielded recipient addresses, automated market making, and
> wrapped Bitcoin would let users hold and exchange programmable assets
> on Bitcoin L1 without trusting a federation, sidechain, or bridge.
> Signatures and rangeproofs solve part of the problem; the main benefits
> are lost if a trusted party still enforces token rules or custodies value.
> The unlock is a **composition of self-custodial primitives**: two Groth16
> circuit families (anonymous unique-spend and amount confidentiality), a
> Runes-style indexer-validated meta-protocol, and a fixed-supply tacit
> asset (TAC). TAC's market value lets indexer-validated state enforce
> economic constraints, and its intrinsic privacy value as a
> confidential, self-custodial asset justifies its existence alongside
> Bitcoin.
> Any indexer running the specification reaches the same verdict from
> chain data alone. Wrapped Bitcoin is locked cryptographically at a
> Taproot key derived from a mixer note's own secret: one leaf, two
> locks. Amount-granular fungible BTC instead replaces the federation
> with an LP-share lien on a half-exogenous (TAC, tETH) AMM-pool bond,
> over-collateralized and risk-priced by a governable ratio. **Together these primitives compose
> into real Bitcoin DeFi as a self-custodial layer** — confidential
> assets, native AMM, yield farms, atomic-OTC marketplace, wrapped BTC —
> anchored to Bitcoin L1, recoverable from each user's private key,
> and free of federation, custodian, or operator-set trust.
> The cryptographic claims hold under standard assumptions; the economic
> claims hold conditional on TAC market depth and an active liquidator
> population, both enumerated explicitly.

---

## 1. Introduction

Bitcoin solved double-spend over a peer-to-peer network. Doing more than
moving sats — confidential transfers, anonymous spend, automated market
making, wrapping Bitcoin into programmable form — has historically required
either off-chain proof exchange (RGB, Taproot Assets), a federated sidechain
(Liquid), a rollup or sidechain with an operator set (Citrea, Botanix), or a
custodial or threshold-bonded wrapper (WBTC, tBTC). Each reintroduces a
trusted party.

What is needed is a layer that (i) keeps every byte of state on Bitcoin L1,
(ii) hides amounts cryptographically, (iii) supports anonymous spend without
a coordinator, (iv) lets Bitcoin be wrapped into a fungible asset without a
federation, and (v) recovers entirely from a private key. Tacit is that
layer — a composition of self-custodial primitives that delivers DeFi on
Bitcoin L1 without a runtime, custodian, or operator set.

## 2. Indexer-validated meta-protocol

**Tacit is an indexer-validated layer on Bitcoin L1.** Envelopes ride
inside Bitcoin Taproot script-path witnesses; Bitcoin nodes do not
interpret them. **Indexers** — open-source clients anyone can run —
scan confirmed transactions and reach the same verdict from chain data
alone. This is the trust model Runes and Ordinals
already use to underwrite market value [^runes]: two indexers seeing
the same byte sequence reach the same accept/reject decision,
byte-for-byte. There is no voting, no quorum, no leader. Determinism is
the substrate.

The trust target is therefore not "indexer determinism in the abstract"
but the **published specification and its open-source reference
implementations** — the same shape Bitcoin Core has at L1. Contested
edge cases resolve via SPEC clarification and cross-implementation test
vectors, not by quorum vote. This is a softer property than a federation
and a stronger one than off-chain proof distribution, but it is not a
solved problem in the abstract: it depends on the protocol's open-source
process remaining contestable. §13 enumerates the limits this implies.

The contribution is to use that substrate for more than tokens. The
same consensus-of-indexers that enforces who-owns-what can also enforce
who-bonded-what and who-equivocated-when, *provided* there exists a
tacit asset the protocol can natively slash. TAC is that asset: a
fair-launched tacit asset with a fixed $21{,}000{,}000$-base-unit cap
[^cap], deployed via the same permissionless `T_PETCH` / `T_PMINT`
mechanism any other auditable-supply token uses. The protocol uses TAC
as the bond layer for cBTC.tac (§6), workers (§9), and bounded
governance.

**Indexer determinism + a fixed-cap tacit asset together replace both
the federation and the smart-contract VM.** Sidechains keep the
federation (Liquid, ~11-of-15 multisig); rollups and Bitcoin L2s keep a
VM but inherit an operator set (Citrea, Botanix); each reintroduces a
trust party tacit avoids. Where cryptography can enforce a property
directly — custody of BTC at L1, amount confidentiality, anonymous
spend — the protocol uses cryptography. Where it cannot — fungibility
of wrapped BTC, soft-confirms before Bitcoin confirmation — TAC stake
fills the gap. Because the cap is fixed and slashed TAC burns against
it, the bonded layer's strength compounds: each burn permanently
shrinks the circulating float against a fixed cap, so every remaining
holder's relative share strengthens and every future bond stacks
against a smaller supply. Slashing schemes that recycle proceeds into
recoverable treasuries, or that coexist with continuous issuance, do
not have this monotone property.

## 3. Confidential value

Every on-chain amount is a Pedersen commitment on secp256k1 [^pedersen]:

$$
C \;=\; a \cdot H \;+\; r \cdot G,
$$

where $G$ is Bitcoin's generator, $H$ is a NUMS generator (no known
$\log_G H$), $a$ is the amount, and $r$ is a blinding scalar. Commitments
are perfectly hiding and additively homomorphic, so supply conservation
holds across a transaction by checking

$$
\sum_{\text{out}} C \;-\; \sum_{\text{in}} C \;=\; r_{\text{ex}} \cdot G,
$$

where $r_{\text{ex}}$ is the excess. A BIP-340 Schnorr signature [^bip340]
under $r_{\text{ex}} \cdot G$ — a Mimblewimble-style **kernel signature**
[^mw] — proves $\sum_{\text{out}} a = \sum_{\text{in}} a$ without revealing
any $a$. Range is enforced by one aggregated Bulletproof [^bulletproofs]
covering all outputs at $n = 64$ bits, $m \in \{1,2,4,8\}$.

The recipient's blinding and amount-keystream are both derived from
the ECDH shared secret of the sender's private key and the recipient's
public key, with domain-separated HMAC-SHA256. The sender's pubkey
appears in the input witness; the recipient re-derives every credit
from their private key and chain alone. **No share-link, no sync
server.**

## 4. Anonymous unique-spend

Amount privacy alone leaves the address graph visible. Tacit's mixer adds
a Tornado-style shielded pool per $(asset\_id, \mathrm{denom})$ pair.
Deposit appends a Poseidon-hash leaf [^poseidon]
$\mathrm{leaf} = \mathrm{Poseidon}_3(s, \nu, \mathrm{denom})$
to a depth-$20$ Merkle tree the indexer maintains. Withdrawal produces a
Groth16 proof over BN254 [^groth16] of the statement

$$
\exists\, (s, \nu, \pi) \;:\; \mathrm{leaf}(s,\nu,d) \in \mathrm{root},\;
\mathrm{Poseidon}_1(\nu) = \mathrm{null},\;
r_{\text{leaf}} = \mathrm{Poseidon}_2(s,\nu),
$$

with public inputs $(\mathrm{root},\,\mathrm{null},\,d,\,r_{\text{leaf}},\,
\mathrm{bind})$, where $\mathrm{bind}$ is SHA-256 over withdrawal-specific data (asset
id, denomination, nullifier, recipient commitment, $r_{\text{leaf}}$)
reduced to a BN254 Fr element. The validator recomputes it externally;
because the circuit constrains $\mathrm{bind}$ as a public input,
Groth16's input-commitment vector binds the proof to that specific
value, and any reuse against a different recomputed tuple fails
verification — preventing replay or front-running. Indexers reject any reused $\mathrm{null}$. The
deposit and withdrawal are unlinkable inside the anonymity set of unspent
leaves. The same circuit underpins cBTC.zk slot operations (§5), where
leaf-level privacy holds but each slot's backing BTC UTXO is still a
visible Bitcoin chain-graph element — protocol-layer privacy without
BTC-layer privacy [^glossary].

## 5. cBTC.zk: one leaf, two locks

BN254 Fr scalars (order $\approx 2^{254}$) embed into secp256k1's scalar
field (order $\approx 2^{256}$) without reduction, so $r_{\text{leaf}}\cdot
G_{\text{secp256k1}}$ is a valid Bitcoin public key. We lock real BTC at a
key-path Taproot output

$$
K_{\text{btc}} \;=\; r_{\text{leaf}} \cdot G_{\text{secp256k1}}
\;=\; C \;-\; d\cdot H ,
$$

derivable by any indexer from the on-chain Pedersen commitment $C$.
**The same scalar that proves set membership inside the SNARK is the
spending key of the backing UTXO.** A user who can withdraw the note can
spend the BTC; nobody else can. No federation, no co-signer, no oracle,
no escape script — one leaf, two locks. We call this asset **cBTC.zk**.

**Transfer rekeys atomically.** Moving a cBTC.zk slot to a new holder
spends the old $K_{\text{btc}}$ and creates a new $K_{\text{btc}}' =
r_{\text{leaf}}' \cdot G_{\text{secp256k1}}$ in the same Bitcoin
transaction (`T_SLOT_ROTATE`, `T_SLOT_SPLIT`, or `T_SLOT_MERGE`). The
new key is derived from a secret the recipient controls (the sender
never learns it), so the previous holder retains no spending authority
over the backing BTC UTXO. cBTC.zk
is therefore transferable as a first-class slot asset, not merely a
self-held vault note.

**Non-upgradability is the price of trustlessness.** The slot layer has
no escape script and no break-glass. The same cryptography
that excludes federations from custody also excludes recovery if a
circuit bug is ever found. A successor pool with a new circuit ships as
a separate $(asset\_id,\,\mathrm{denom})$ surface; existing slots stay
on their original key and migrate slot-by-slot through the standard
withdraw-and-redeposit flow. This is the same trade Bitcoin itself makes
at L1 — cryptographic rigidity in exchange for the absence of an upgrade
party.

Any spend of $K_{\text{btc}}$ without a matching $\mathrm{T\_SLOT\_BURN}$
envelope is observable from chain alone (the slot's nullifier is missing
from the consumed set). This $\mathrm{SLASH\_DETECTED}$ event is the
primitive on which later economic constructions rest.

## 6. cBTC.tac: bonded fungibility

cBTC.zk is unit-granular at fixed denominations and trustless. DeFi
expects amount-granular fungible assets. **cBTC.tac** composes a cBTC.zk
slot with an LP-share lien on the canonical $(\mathrm{TAC},\,
\mathrm{tETH})$ AMM pool. Minting requires the depositor to LP both sides;
the indexer records a lien on the resulting LP-share UTXO and mints
fungible cBTC.tac equal to the slot's BTC value. The slot is the BTC
backing; the bond is a separate, half-exogenous insurance overlay. The lien is enforced by
the wallet's universal $\mathrm{commitmentForUtxo}$ resolver: any
unauthorized spend is treated as nonexistent, so AMM swaps, transfers,
and farms refuse to consume liened collateral [^lien].

If the depositor rugs the underlying slot ($\mathrm{SLASH\_DETECTED}$),
their bond LP moves to a shared insurance pool that compensates
all outstanding cBTC.tac holders pro rata. With a governable,
IL-aware-floored bond ratio (default $2.5\times$, floor $2.0\times$)
relative to slot BTC value and force-close defending at
$1.2\times$, the rug is negative expected value while the liquidator
population operates as designed. **cBTC.tac is trustless on the BTC anchor side
(cryptographic) and over-collateralized on the fungibility side
(economic) — the same shape as DAI but with no smart-contract runtime.**
This makes cBTC.tac a first-class tacit asset: it transfers via standard
CXFER, swaps in any pool, deposits into the mixer, and stakes into yield
farms. Bitcoin gets a fungible BTC-denominated asset inside a DeFi stack
anchored to L1, without a custodian.

**Stress behavior — half-exogenous, ratio-priced.** The bond is a
$(\mathrm{TAC},\,\mathrm{tETH})$ LP, so only ~half its value is the
native token; the **tETH leg is exogenous** — a Tacit-specific stress
event does not move ETH — which directly dilutes the reflexivity a
TAC-only bond would carry. The residual (the TAC half, plus the LP's
impermanent loss in a one-sided crash) is priced by a single
governable, **IL-aware-floored** over-collateralization ratio. And the
primary backing is the self-custodied cBTC.zk slot (real BTC); the bond
is only rug-insurance on top, not the backing itself. The
2.0× initial cushion, the permissionless force-close path triggered
when LP-share BTC value falls below 1.2× the slot, and the shared
insurance pool bound the damage. Non-bond TAC demand (AMM
market-making, payments, governance) is what mitigates the reflexivity
in practice. The trust model under stress is "rational liquidators
arrive in time," the same shape Maker has. Maker collateralizes
against ETH's mature exogenous demand; TAC's parallel demand develops
through the non-bond uses enumerated in §13 — worker bonding,
governance, AMM denomination, protocol-fee revenue (§8), farm rewards,
and TAC's role as a native confidential asset.

## 7. Three privacy capabilities, composable and optional

Privacy is exposed as three orthogonal capabilities, each opt-in at a
different granularity. Users pick the posture that fits their use case
instead of forcing one stance on everyone.

| Capability | Default | Technique | What it hides |
|---|---|---|---|
| **Shielded amount** | On (every transfer) | Pedersen commit $C = aH + rG$, aggregated Bulletproof for $a \in [0, 2^{64})$, kernel signature on the excess; ECDH-derived recipient keystream | Per-output amounts. Only `T_BURN`'s `burned_amount` is intentionally public for supply auditability. |
| **Shielded address** | Opt-in per receipt | Blinded-pubkey commit $\mathrm{commit} = P_{\text{recipient}} + b\cdot G$ with $b = \mathrm{HMAC}(\mathrm{ECDH}\,\Vert\,\mathrm{anchor}\,\Vert\,\mathrm{vout})$. Static handle (`tcs1…` / `tcsts1…` bech32m) opaquely encodes the recipient pubkey. | The recipient's on-chain identity. Each receipt lands at a per-transaction unique `P2WPKH(hash160(commit))` with no apparent link to the published handle. Same key-tweak primitive as BIP-341 [^bip341] / BIP-352 [^bip352]; no new ceremony. |
| **Mixer pool** | Opt-in per UTXO | Tornado-style Poseidon-Merkle commitment + Groth16 proof of unspent-leaf membership + nullifier reveal (§4) | The link between deposit and withdraw, inside the pool's anonymity set on the same $(asset\_id, \mathrm{denom})$ surface. |

The three layers are **orthogonal** because each operates at a different
position in the wire: shielded amount on the commitment value,
shielded address on the output script, mixer pool on the protocol-tree
leaf. A given UTXO can carry any subset independently, and a wallet can
dial privacy up or down per-payment without giving up recovery.

**Practical postures.** A *merchant* keeps default shielded amounts and
a static public identity — balances are private but counterparties
remain identifiable for invoicing and reconciliation. *Payroll* runs a
batched CXFER from one treasury key to $N$ employees, each of whom
publishes a `tcs1…` shielded address: every employee's on-chain pay
line lands at a fresh, unlinkable marker, and the employee re-derives
the tweaked signing key from their wallet seed alone. A
*privacy-conscious user* routes outbound flow through the mixer pool
and receives inbound at a shielded address — unlinkable at both
endpoints, with full unlinkability inside the chosen anonymity set.
Each posture composes **the same three primitives** differently; the
protocol itself does not change between them.

## 8. Native AMM and LP-bonded farms

The AMM follows the same virtual-pool pattern as the mixer: a pool of
$(R_A, R_B, S)$ is **just numbers** that the indexer reconstructs from
chain. Two trader paths:

- **$\mathrm{T\_SWAP\_VAR}$** — per-trade against the spot curve
  $\Delta_{\text{out}} = R_B\,\gamma\,\Delta /(R_A\,\gamma_d + \gamma\,\Delta)$
  ($\gamma$ and $\gamma_d$ are the per-pool fee numerator and
  denominator, e.g. $\gamma=997$, $\gamma_d=1000$ for a 30 bps pool)
  using only Pedersen + Bulletproof + kernel sig. **No Groth16, no
  ceremony, and per-trade $\Delta$ is cleartext on chain** — the
  explicit trade-off for skipping the SNARK. Variable-amount $[Y, X]$
  semantics, immediate settlement. Privacy-sensitive flow routes
  through $\mathrm{T\_SWAP\_BATCH}$ instead.
- **$\mathrm{T\_SWAP\_BATCH}$** — uniform-clearing-price batch
  [^walras] over $N$ hidden per-trader amounts, settled by one Groth16
  proof. Intra-batch sandwich attacks are structurally impossible
  because every trader in a batch clears at the same $P_{\text{clear}}$.

LP shares are themselves confidential tacit assets, so they compose with
the mixer (anonymous LP positions) and with cBTC.tac (LP-share-lien
collateral). Yield farms ($\mathrm{T\_LP\_BOND}$) stream reward emissions
to bonded LP shares without a smart contract: the farm treasury is a
virtual indexer-attested quantity; bond receipts are P2WPKH dust markers
keyed to per-bond accrual snapshots; the launcher's reward asset enters
via kernel-sig closure and exits when the validator credits a fresh
reward output at unbond. Bootstrap depth is incentivized without an
on-chain treasury or custody role [^farm].

**Optional protocol-fee skim.** Pools may pin a fee skim at
`POOL_INIT`, directing a portion of trade revenue to a configurable
recipient. Canonical pools direct it to the TAC treasury, so AMM
volume accrues structural revenue to TAC holders alongside organic LP
fees. **TAC is the protocol's DAO-governed DeFi-native unit** —
canonical to the AMM, bonding, and governance from launch, not a
generic asset adapted to collateral after the fact. The same trade
activity that prices cBTC.tac through TWAP collateralization also
accrues value at the bond layer. With the full DeFi primitive set on
one stack — fungible wrapped BTC, AMM, LP yield, farm incentives,
snapshot airdrops, future stablecoin variants — pool counterparties
span TAC, cBTC.tac, and any other tacit asset, so depth compounds
within the protocol's value-accrual surface rather than fragmenting to
external venues. A structural difference from MakerDAO, where the AMM
that prices ETH/DAI runs on external venues and its fees flow
elsewhere.

## 9. Validator honesty and bonded diversity

The channel layer ($\mathrm{T\_INTENT\_ATTEST}$) lets workers offer ~30s
soft-confirmations on pending intents — pre-broadcast trade commitments
that haven't yet settled on Bitcoin. Limit orders that never match cost
zero on-chain; matched orders amortize into batched settlement. The
construct is only useful if equivocation is costly.

A worker who wants traders to honor its attestations posts a TAC bond
via $\mathrm{T\_WORKER\_BOND\_OPEN}$. The bond UTXO is an ordinary
TAC-bearing UTXO carrying an **indexer-recorded lien** — no covenant
needed; tacit-aware wallets refuse to consume liened TAC. Any party who
observes two attestations signed by the same $\mathrm{worker\_pubkey}$ at
the same $(\mathrm{scope\_id}, \mathrm{height})$ with conflicting
$\mathrm{intent\_pool\_hash}$ can submit them as evidence; the indexer
reattributes a configurable bounty fraction to the reporter and **burns
the remainder**, contracting circulating TAC against its fixed
21M-base-unit cap. Any observer has positive-EV incentive to report.
The structure mirrors Ethereum's PoS slashing [^pos] but is enforced by
indexer consensus rather than a smart contract, and inherits the
monotone-deterrent property from §2.

Workers cannot make invalid envelopes valid; honest competition for
intent flow plus burn-on-equivocation suffices to align worker behavior.
Anyone can run a worker, and the dapp's **tacit-mesh** cross-checker
turns that diversity into evidence: a worker that quietly omits an intent
from its published list while signing an attestation committing to the
omitted set is caught by a SHA-256 comparison across $\geq 2$ subscribed
workers. The mesh produces evidence; the bond turns it into a slash.

**Bond-class accounting.** Worker bonds (raw TAC) and the **TAC leg**
of cBTC.tac's (TAC, tETH) bond share the same TAC float, both recorded
as indexer liens against the fixed cap (the bond's tETH leg is
exogenous and sits outside the TAC cap). A system-wide governance parameter caps the bonded fraction
of circulating TAC, and burns from either class contract supply for
the other. The classes compete for float but compose cleanly: one TAC,
one cap, one ledger of liens.

## 10. Self-custody and recovery

A wallet recovers full state from its private key and the Bitcoin chain
alone. The derivation paths by primitive:

- **Confidential transfers:** trial-decrypt outputs via ECDH against the
  sender pubkey carried in the input witness.
- **Own etches and mints:** re-derive supply blinding/keystream from the
  commit-tx anchor and the wallet's own key.
- **Permissionless mints and mixer withdrawals:** the opening $(a, r)$
  is published cleartext in the envelope (verified via the Pedersen
  equation).
- **AMM and farm positions:** the public amount (`share_amount`,
  $\Delta_a$, $\Delta_b$) sits in the envelope; the chain commitment
  uses a deterministic blinding derived from the wallet key plus a
  per-tx anchor.
- **Shielded-address receipts:** scan a bounded `xferseen` index per
  asset and re-derive the per-tx tweak $b$ from ECDH and the anchor;
  the spending key is $sk_{\text{recipient}} + b \bmod n$.

**Shielded-pool deposits and cBTC.zk slots.** Each deposit's
$(\textit{secret}, \nu)$ pair is wallet-derived at deposit time and
consumed at withdraw time. Standard tacit wallets derive the pair
deterministically from the wallet seed (a BIP-32-style sub-key seeds
the per-deposit CSPRNG, anchored on the deposit tx), so recovery
re-derives candidate notes and scans the pool's leaf set for matches —
privkey-only, same as the rest of the protocol. The protocol consumes
any valid $(\textit{secret}, \nu)$ pair without distinguishing how it
was generated, so a wallet may also choose per-deposit CSPRNG with
out-of-band note backup (the Tornado / Privacy Pools posture); both
paths produce identical on-chain leaves and identical withdraws.
**Fungible cBTC.tac balances** held as ordinary tacit-asset UTXOs
recover from the wallet key alone like any other tacit asset.

A user who loses every device and every backup except their private
key reconstructs every asset class from the chain alone — the property
native Bitcoin already has, extended to a full confidential DeFi stack.

## 11. Fee-aware cryptography

Witness bytes are the dominant cost. The protocol economizes by picking
the lightest primitive that proves the necessary property:

- **Bulletproofs+** replaces Bulletproofs for CXFER and AXFER — same
  Pedersen, same kernel sig, $\sim 14\%$ smaller witness across every
  transfer [^bppp].
- **Sigma cross-curve binding** (169 bytes, microseconds) links a
  secp256k1 chain commitment to a BabyJubJub in-circuit commitment,
  avoiding the $\sim 10^6$-constraint cost of doing secp256k1 EC math
  inside a BN254 SNARK.
- **$\mathrm{T\_SWAP\_VAR}$ carries no Groth16.** Variable-amount fills
  against a known curve are checkable from public data; ceremonies are
  reserved for the surfaces where set-membership privacy or multi-party
  amount confidentiality is load-bearing.
- **Multi-hop routing ($\mathrm{T\_SWAP\_ROUTE}$)** and **batched
  preauth-take** atomically settle $N$ legs in one Bitcoin tx,
  amortizing the ~10 KB witness floor across many fills.
- **Lazy accrual** of LP and farm rewards uses a fixed-point per-share
  accumulator (Q.96), so reward crystallization is $O(1)$ per
  state-touching event rather than $O(\text{LPs})$, matching
  MasterChef [^masterchef].

The composition gives smart-contract-shaped properties — AMM trading,
collateralized wrapping, batched settlement, programmatic yield farms —
delivered without a VM, without a sidechain, without leaving Bitcoin L1.

## 12. The protocol as one ecosystem

The primitives fit together as a single system. Any tacit asset works
in any primitive uniformly, so the surfaces below compose into one
self-consistent stack rather than a menu of disconnected products.

- **Fair-launched native asset.** TAC, 21M-base-unit cap, deployed via
  permissionless `T_PETCH` / `T_PMINT`. Wire-format-wise a regular
  tacit asset (amount-private, shielded-address-compatible,
  mixer-composable); structurally canonical to the AMM, bonding, and
  governance from launch.
- **Asset-creation arm.** `CETCH` issues confidential-supply assets
  (optionally mintable); `T_PETCH` + `T_PMINT` covers fair-launch
  capped issuance with publicly auditable cumulative supply and a
  height window; `T_DROP` + `T_DCLAIM` distributes existing supply
  via snapshot-based merkle claims with optional ETH-signature gating.
- **Confidential AMM and yield farms.** Constant-product pools
  between any two tacit assets, two trader paths (`T_SWAP_VAR`
  cleartext-amount, `T_SWAP_BATCH` Groth16-private uniform clearing),
  `T_LP_BOND` / `T_LP_HARVEST` farm-reward layer over virtual
  treasuries.
- **Cryptographic BTC slots and collateralized fungible BTC.** cBTC.zk
  for cryptographic 1:1 wrapping (fixed-denomination slots), cBTC.tac
  for fungible BTC-denominated DeFi (amount-granular,
  TAC-collateralized) — both first-class tacit assets that transfer,
  swap, mix, and farm like any other.
- **Atomic OTC marketplace.** `T_AXFER`, `T_AXFER_VAR`,
  `T_SWAP_ROUTE`, batched preauth-take: single-tx
  confidential-asset-vs-BTC settlement with maker/taker pre-signing
  that prevents either side from griefing.
- **Bonded soft-confirm layer.** `T_INTENT_ATTEST` preconfirmations,
  `T_WORKER_SLASH` equivocation slashing on cryptographic evidence,
  tacit-mesh cross-worker evidence production.
- **Bounded governance.** `T_GOV_*` opcodes for TAC-weighted parameter
  votes within explicit safety bands; load-bearing mechanics remain
  immutable without a formal amendment.

**Smart-contract-shaped without a VM.** Smart contracts give Ethereum
users programmable assets, automated market making, collateralized
issuance, atomic multi-leg settlement, yield distribution, governance,
and snapshot-based airdrops. Tacit delivers the same outcomes by
composing the primitives above. Each opcode is a deterministic
state-transition rule any indexer reaches the same verdict on; the
trade-off is real (no arbitrary user-written logic) and the gains are
commensurate (no VM attack surface, no operator set, no L1 change to
add new primitives).

| Smart-contract pattern | Tacit primitive(s) |
|---|---|
| ERC-20 transfer + optional mint/burn | `CETCH` + `CXFER` + `T_MINT` + `T_BURN` (Pedersen-committed amounts; mintable if elected at etch; burn amount is public for auditability). |
| Fair-launch capped permissionless mint | `T_PETCH` + `T_PMINT` + `T_BURN` (publicly auditable cap, height window, depth-3 reorg gate). |
| Uniswap V2 AMM | `T_LP_ADD` / `T_LP_REMOVE` / `T_SWAP_VAR` / `T_SWAP_BATCH` (virtual pool, optional per-trader amount confidentiality). |
| MakerDAO CDP | cBTC.tac via `T_CBTC_TAC_DEPOSIT` (slot + TAC lien, $2\times$ cushion, $1.2\times$ force-close, shared insurance pool). |
| Tornado Cash privacy pool | `T_DEPOSIT` / `T_WITHDRAW` (Poseidon-Merkle + Groth16 + nullifier set). |
| MasterChef yield farm | `T_FARM_INIT` / `T_LP_BOND` / `T_LP_HARVEST` (virtual treasury, Q.96 lazy accrual). |
| Merkle Distributor airdrop | `T_DROP` / `T_DCLAIM` (Merkle-snapshot eligibility, per-claim cap, expiry height). |
| 1inch-style multi-leg router | `T_SWAP_ROUTE` (atomic 2–4-hop AMM routing in one Bitcoin tx). |
| Optimistic-rollup fraud proof | `T_WORKER_SLASH` (cryptographic two-attestation evidence, burn against fixed cap). |
| Compound / Aragon governance | `T_GOV_PROPOSAL` / `T_GOV_VOTE` / `T_GOV_VETO` / `T_GOV_EXECUTE` (TAC-weighted, safety-band-bounded). |

**Primitives are immutable; composition is uniform.** Each row above is
an immutable state machine fixed at SPEC time (or governance-bounded
within explicit safety bands). Users compose primitives; they cannot
redefine them. Any tacit asset — `CETCH`'d tokens, LP shares, cBTC.tac,
TAC — transfers via `CXFER`, swaps in any pool, deposits into the
mixer, and bonds into farms or worker positions. This is the
ERC-20-shape composability that gave Ethereum DeFi its compounding
effect, ported to Bitcoin L1 without a VM.

**The stack strengthens with use.** Adoption on any axis lifts the
others: wider TAC use increases shielded-transfer volume and mixer
anonymity sets; deeper AMM liquidity tightens cBTC.tac's TWAP-based
collateral signal and widens the channel back to plain BTC; a larger
bonded base against the fixed cap raises the deterrent for every
future bond; richer farm emissions deepen LP positions that feed the
same liquidity. The same indexer determinism and the same fixed-cap
asset underwrite all of it, and the same primitives compose across all
of it. The ecosystem reinforces itself by being used.

What this misses: arbitrary user-written contracts. A new primitive
requires a new opcode (and a new circuit if cryptography is
load-bearing), shipped as an additive opcode under SPEC §5.5. The bar is higher than
deploying a smart contract — but the surface area subject to bugs is
the protocol specification, not every user-written script, and the
soundness argument shrinks accordingly. Tacit is an algebra of
primitives, not an execution environment.

## 13. Trust model and limits

The protocol's load-bearing assumptions deserve naming.

**Indexer reference implementation.** The trust target at the indexer
layer is the published specification and the open-source reference
implementations that converge on it, the same shape Bitcoin Core has at
L1. Two indexers running the same code over the same bytes reach the
same verdict; achieving *the same code* is a social process. Contested
edge cases (which have occurred for Runes / Ordinals indexers in
production) resolve via SPEC clarification and cross-implementation
test vectors, not by quorum vote. After the beta phase stabilizes the
wire format under market testing, the TAC DAO (§12) takes on bounded
stewardship of future protocol versions and reference-implementation
maintenance, under the same safety-band governance that scopes all
other parameter changes. Load-bearing mechanics — conservation,
slashing semantics, cryptographic primitives — remain immutable without
a formal SPEC amendment.

**TAC bootstrap and market reality.** TAC's initial distribution went
via airdrop to members of the Ethereum-rooted zOrg DeFi DAO — a
protocol that has operated on Ethereum for over a year — with snapshot
CSVs preserved at [`airdrop/`](https://github.com/z0r0z/tacit/tree/main/airdrop) in the repo. TAC shares
have circulated on the open DeFi market since the airdrop. The
distribution carried real economic cost on both sides: zOrg
eligibility was earned through ETH spending (share purchase, protocol
fees, or LP farming on Ethereum), and airdrop fulfillment paid Bitcoin
fees to broadcast the on-chain envelopes. On Bitcoin, TAC is etched
via the public-mint `T_PETCH` / `T_PMINT` mechanism with a fixed
21M-base-unit cap auditable from chain alone. An active OTC market
for TAC operates on the protocol itself — settling asset-vs-BTC trades
atomically at [tacit.finance](https://tacit.finance) through `T_AXFER`
/ `T_AXFER_VAR` and the atomic-intent flow — so market liquidity is
already in place, not theoretical.

**Persistent utility and reflexive collateral.** The protocol's
security gains weight as TAC market depth grows, and the protocol
structures multiple persistent uses to support that growth: bonding
workers against equivocation, weighting bounded governance,
denominating the canonical $(\mathrm{cBTC.zk}, \mathrm{TAC})$ and
$(\mathrm{cBTC.tac}, \mathrm{TAC})$ AMM pools that route every
BTC-paired trade, receiving protocol-fee revenue from those pools
(§8), paying out yield-farm rewards, and circulating as a confidential
native asset with full shielded-amount and shielded-address support.
The collateral is partially **reflexive** — a stress event that
strains cBTC.tac can also strain TAC — and the 2.0× cushion, 1.2×
force-close, and shared insurance pool bound the damage. The non-bond
uses above mitigate the reflexivity by spreading TAC's value across
multiple correlated demand sources; only its open-market trading and
standalone confidential-asset utility are truly exogenous to cBTC.tac
stress.

**Network effects on privacy.** TAC's confidential-asset properties
give adoption a self-reinforcing component at every privacy layer, and
the protocol enters this loop with an active wallet base in the
thousands already transacting through TAC's shielded primitives.
Every TAC transfer is amount-hidden by default and any receipt can
land at a per-transaction-unique shielded-address marker, so wider
adoption directly increases the volume of shielded activity on chain —
more cover traffic for an observer to sift through. Mixer use compounds
this further: anonymity sets in TAC mixer pools grow as a fraction of
holders route through the shielded path. Deeper liquidity in the
canonical $(\mathrm{cBTC.zk}, \mathrm{TAC})$ and $(\mathrm{cBTC.tac},
\mathrm{TAC})$ pools widens the channel between confidential balances
and plain BTC sats — exits to Bitcoin clear larger sums with less
price impact and, when routed through the mixer, with stronger
unlinkability. cBTC.tac's TWAP-based collateral check benefits from
the same depth. Economic-security gains and privacy gains move
together at every layer of the stack.

**Bitcoin L1 fee regime.** A confidential transfer carries ~10 KB
witness, settling at ~2,500–3,000 vBytes after the SegWit discount.
Tacit is a high-value-transfer instrument, not a low-value payments
rail. Bulletproofs+ (~14% smaller) and multi-leg routing
(`T_SWAP_ROUTE`, batched preauth-take) amortize the cost across more
fills, and Bitcoin covenant upgrades (§14) compress further, but no
design choice eliminates the L1 witness floor.

**Reorg discipline.** Per-pool deposits, fair-launch mints, and AMM
operations credit only at Bitcoin confirmation depth $\geq 3$ — a
transient L1 spend that gets reorged out is rolled back along with its
tacit-asset effect. cBTC.zk slot spends are confirmed by Bitcoin
itself; the indexer-tracked nullifier set rolls back with the chain, so
the same $r_{\text{leaf}}$ is re-usable after a reorg iff the
corresponding L1 spend also reorged out. Worker slashes follow the same
rule: an evidence transaction reorged out reverses the slash, and the
dapp's mesh continues to surface the original conflict regardless.

**Cross-batch curation MEV.** `T_SWAP_BATCH`'s uniform clearing price
defeats *intra-batch* sandwich attacks by construction. Cross-batch
exclusion — a settler omitting intents from a batch they assemble — is
currently bounded by tip economics, `T_INTENT_ATTEST`
preconf-equivocation evidence, and arbitrage realignment in the next
batch. The reserved `T_EXCLUSION_CLAIM` opcode (drafted) closes this
surface in a follow-up amendment via consensus-level slashing of
demonstrable exclusion.

**Ceremony surface.** The mixer's `withdraw.circom` runs on one global
Phase 2 ceremony (canonical bundle content-addressed and hardcoded in
the dapp); cBTC.zk reuses it without modification. The AMM's three
sub-circuits share Phase 1 (`pot18`) and run independent Phase 2 chains
anchored to one Bitcoin-block beacon at finalization — a single
ceremony for the AMM, not a per-pool one. The proof system's zero-knowledge property protects witness privacy
unconditionally; soundness depends on $\geq 1$ honest contributor
across the ceremony's participants.

**Composable compliance.** The mixer pool composes with association-set
techniques (the construction Privacy Pools shipped to address Tornado's
regulatory failure mode) without modifying the protocol — an
association-set indexer is an additive client-side filter on the same
on-chain envelope set. Tacit ships the cryptographic primitive;
downstream operators choose the policy.

**Threat-model summary.** *In scope:* indexer-spec correctness
(auditable and reproducible from chain), Bitcoin consensus, Groth16 /
Pedersen / Schnorr soundness under standard assumptions, and rational
worker and liquidator behavior. *Out of scope:* state-level adversaries
that compromise Bitcoin itself, dominant reference-implementation
collusion that violates the SPEC, and tail-correlated TAC/BTC collapse
beyond the bounded-defense surface above. The cryptographic claims hold
under standard assumptions; the economic claims hold conditional on TAC
market depth and an active liquidator population.

## 14. Upgrade path

Tacit is built to absorb improvements in three independent dimensions:
new Bitcoin opcodes, new cryptography, and adjacent privacy protocols.
Each new tacit opcode is purely additive: indexers that don't yet
recognize it skip the envelope; indexers that do recognize it apply the
new rule (SPEC §5.5 unknown-opcode rule). Upgrades land without breaking
existing state or requiring users to migrate value.

**Bitcoin covenants.** A covenant-style primitive — a CTV-style
template check, an `OP_CAT`-enabled introspection construction, an
`OP_VAULT`-successor design, or a TLUV-style equivalent — activates
several already-reserved opcodes and tightens existing ones:

- **Trustless fractional cBTC.zk** (`T_SLOT_FRACTIONALIZE` /
  `T_SLOT_RECONSOLIDATE`, opcodes `0x4D` / `0x4E`, drafted) splits a
  cBTC.zk slot into fungible shares and recombines them without a TAC
  bond. The cryptographic spec is complete; only the Bitcoin-side
  enforcement is missing. cBTC.tac remains for users who prefer the
  economic-collateral path; the fractional opcodes become the
  structurally-trustless fungible BTC path.
- **Aggregated cBTC.zk mixing.** Multiple slots share one Bitcoin
  UTXO, giving cBTC.zk slot operations real BTC-chain-graph privacy
  on top of the protocol-tree privacy they already have (§4).
- **On-chain bid escrow.** Today's bid layer is off-chain because
  Bitcoin script cannot bind a buyer's pre-signed sats input to an
  unknown future asset outpoint; a CTV-style template check closes
  that gap, removing one of the last off-chain trust surfaces.
- **Covenant-restricted swap inputs** close the residual intent-race
  window that currently relies on ~3-block depth gating in the AMM.

**ZK in Bitcoin script.** Recent work on Shielded CSV [^shieldedcsv]
and `OP_CAT`-enabled SNARK verifiers would let some validation move
from the indexer to Bitcoin consensus itself. Tacit's Groth16 stack is
already aligned: `withdraw.circom`'s verifying key is content-addressed
and ceremony-anchored, so a proof a worker accepts today verifies
under a script-level checker tomorrow without re-running the ceremony.

**Schnorr improvements.** MuSig2 / FROST give multisig
mint-authority with no wire-format change — the `mint_authority` field
is just a 32-byte x-only pubkey. Cross-Input Signature Aggregation
(CISA), if it lands at consensus, would shrink batched settlements
where each fill carries its own signature today.

**Interim privacy composition.** Before covenants land, two neighboring
techniques compose with tacit's existing surfaces:

- **CoinJoin upstream of mixer deposits or cBTC.zk mints.** A
  Bitcoin-layer CoinJoin breaks the fee-source-UTXO clustering that
  operationally weakens self-mix unlinkability — a wallet that funds
  its deposit from a CoinJoin output has no chain-graph trail back to
  its previous identity.
- **BIP-352 silent payments for the plain-BTC funding leg.** Silent
  payments compose orthogonally with the shielded address: tacit hides
  the recipient marker on tacit-asset receipts; BIP-352 hides it on
  plain-sats receipts. Tacit defers a tacit-flavored stealth-sats
  scheme rather than competing with the BIP-352 standard, and uses the
  mixer pool for the same use case until BIP-352 wallet adoption
  converges.

**Why additivity holds.** Cryptographic primitives replace in place —
Bulletproofs → Bulletproofs+ shipped this way, same Pedersen, same
kernel sig, ~14% smaller witness. New Bitcoin primitives add
cryptographic *options* alongside existing economic ones rather than
displacing them: covenants enable fractional cBTC.zk alongside
cBTC.tac, so users can choose either trust model. TAC's structural
roles persist and compound as the protocol surface grows — bond layer
for workers, weight in governance, denominator and unit of account in
canonical AMM pools (with optional protocol-fee accrual), reward asset
for yield farms, and a confidential native asset in its own right
(shielded amounts and addresses, mixer-composable, privkey-recoverable).
New surfaces — additional pool families, stablecoin variants,
channel-layer service economies — broaden the role set without changing
what already ships. The indexer-validated
meta-protocol pattern is a substrate that carries more powerful
primitives as Bitcoin gains them, without ever asking users to migrate
value out and back in.

## 15. Conclusion

We have proposed a self-custodial DeFi layer on Bitcoin L1, built from a
composition of primitives. Two Groth16 circuit families — anonymous
unique-spend ($\mathrm{withdraw.circom}$) and amount confidentiality
(AMM) — compose across every privacy-bearing surface. The indexer-validated meta-protocol
pattern that already underwrites Runes and Ordinals is extended into a
**collateral substrate**: TAC, a fixed 21M-base-unit asset,
bonds workers against equivocation and backs fungible cBTC.tac; cBTC.zk's
"one leaf, two locks" construction gives trustless fixed-denomination
BTC slots without a federation. Shielded amounts hide on-chain values, shielded
addresses break recipient clustering at the output script, and the
mixer breaks deposit–withdrawal linkage at the protocol-tree leaf —
composed at the user's choice of granularity, the three deliver full
privacy across the tacit-asset surface. Merchants opt in only to shielded amounts and keep a
public identity for accounting; payroll adds shielded addresses for
unlinkable per-employee receipts; privacy-conscious users route through
the mixer for unlinkability at every endpoint within the chosen
anonymity set. Wallets reconstruct
from the private key and Bitcoin chain alone.

The cryptographic claims hold under standard assumptions. The economic
claims hold conditional on TAC market depth and an active liquidator
population; limits are stated explicitly in §13. Every load-bearing
property is either cryptographically enforced from chain alone, or
bounded by an economic mechanism the protocol states in the open.
Where Bitcoin already provides a primitive, tacit uses it. Where
Bitcoin does not, tacit composes indexer-validated state and a
fixed-cap bonded asset to fill the gap. As Bitcoin acquires more script
primitives, the cryptographic surface widens; TAC continues to bond
workers, weight governance, denominate canonical AMM pools (with
protocol-fee accrual), reward yield farms, and carry its own
confidential value — the structural roles compound as the protocol
surface grows (§14).

---

### References

[^runes]: Rodarmor, C. *Runes Protocol.* 2024.
[^cap]: SPEC-WORKER-BOND-AMENDMENT §"Why burn the slashed TAC instead of pooling it" — TAC fixed cap, burn-on-slash semantics.
[^pedersen]: Pedersen, T. P. *Non-interactive and information-theoretic secure verifiable secret sharing.* CRYPTO 1991.
[^bip340]: Wuille, P.; Nick, J.; Ruffing, T. *BIP-340: Schnorr signatures for secp256k1.* 2020.
[^mw]: Jedusor, T. E. *Mimblewimble.* 2016; Poelstra, A. *Mimblewimble.* 2016.
[^bulletproofs]: Bünz, B.; Bootle, J.; Boneh, D.; Poelstra, A.; Wuille, P.; Maxwell, G. *Bulletproofs: Short proofs for confidential transactions and more.* IEEE S&P 2018.
[^poseidon]: Grassi, L.; Khovratovich, D.; Rechberger, C.; Roy, A.; Schofnegger, M. *Poseidon: A new hash function for zero-knowledge proof systems.* USENIX Security 2021.
[^groth16]: Groth, J. *On the size of pairing-based non-interactive arguments.* EUROCRYPT 2016.
[^bip341]: Wuille, P.; Nick, J.; Towns, A. *BIP-341: Taproot.* 2020.
[^bip352]: *BIP-352: Silent Payments.* 2023.
[^walras]: Walras, L. *Éléments d'économie politique pure.* 1874; Gnosis Protocol uniform-clearing-price batches. 2019; Penumbra ZSwap. 2023.
[^pos]: Buterin, V., et al. *Ethereum Proof-of-Stake / Casper FFG.* 2020.
[^bppp]: Chung, H., et al. *Bulletproofs+.* 2020.
[^masterchef]: SushiSwap. *MasterChef contract.* 2020.
[^lien]: SPEC-CBTC-TAC-AMENDMENT §5.47 — lien model (trustless collateral without covenants).
[^farm]: SPEC-AMM-FARM-AMENDMENT — virtual-treasury MasterChef-style farms.
[^glossary]: `spec/GLOSSARY.md` — *Two privacy layers, not one* — protocol-tree-layer vs. Bitcoin-chain-graph-layer privacy.
[^shieldedcsv]: Nick et al., 2024, *Shielded CSV: Private and Efficient Client-Side Validation,* and the broader `OP_CAT`-enabled SNARK verifier line of research.

*Canonical specs: [`SPEC.md`](./SPEC.md), [`AMM.md`](./AMM.md),
[`MIXER.md`](./MIXER.md), [`spec/CIRCUITS.md`](./spec/CIRCUITS.md),
[`spec/amendments/`](./spec/amendments/).*
