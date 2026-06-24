<p align="center">
  <img src="./assets/tacit.svg" alt="tacit" width="120">
</p>

# tacit

A meta-protocol on Bitcoin that scales the Runes/Ordinals pattern past
plain tokens — confidential value, anonymous spend, native AMM,
trustless wrapped BTC, trustless wrapped ETH, all enforced by indexers
anyone can run and reach the same verdict from chain alone. No
federation, no sidechain, no smart-contract runtime. Cryptographic
privacy and Groth16 circuits do the work a VM would do elsewhere.

> **Status:** signet + mainnet. Sign in with Xverse / UniSat /
> Leather, import a privkey, or — on signet — let the dApp generate
> one and grab faucet sats.
>
> **Live demo:** [tacit.finance](https://tacit.finance)
>
> **Protocol specs:**
> [`SPEC.md`](./SPEC.md) — canonical wire-format authority ·
> [`AMM.md`](./AMM.md) — confidential AMM architecture ·
> [`MIXER.md`](./MIXER.md) — shielded-pool architecture ·
> [`BRIDGE.md`](./BRIDGE.md) — tETH trustless ETH-Bitcoin bridge ·
> [`spec/CIRCUITS.md`](./spec/CIRCUITS.md) — how the ZK stack composes ·
> [`spec/GLOSSARY.md`](./spec/GLOSSARY.md) — terms that overlap across surfaces ·
> [`spec/amendments/`](./spec/amendments/) — cBTC.zk, cBTC.tac, farms, tETH, orderbook, governance.

---

## What it is

**Tacit is what Runes becomes when you push the indexer-validated
meta-protocol pattern past plain tokens.** Same trust model — token
rules aren't enforced by Bitcoin nodes, they're enforced by
indexers that anyone can run and reach the same verdict from chain
data alone. Tacit applies that pattern to a much wider surface:

- **Confidential value.** Every on-chain commitment is a Pedersen
  point with an aggregated bulletproof rangeproof and a
  Mimblewimble-style kernel signature. Supply conservation holds
  without ever revealing individual amounts.
- **Anonymous spend.** A Tornado-style shielded pool (Groth16 + a
  Poseidon-Merkle tree + nullifiers) lets any holder deposit a
  fixed-denomination UTXO and withdraw to a fresh address with no
  on-chain edge linking the two.
- **Native AMM.** A uniform-clearing-price block-batched AMM
  between any two tacit assets, with confidential per-trader
  amounts and mixer-composable LP shares. The pool reserves are
  public numbers the indexer tracks; no UTXO holds any pool's
  funds.
- **Trustless wrapped BTC.** `cBTC.zk` locks real BTC at a
  Taproot output whose spending key is derived from a mixer
  leaf's secret — one note, two locks, no federation and no
  co-signer. (Amendment shipped; the in-dApp slot-wrap is gated
  behind the AMM ceremony.)
- **Fungible wrapped BTC.** `cBTC.tac` composes a cBTC.zk anchor
  with an LP-share lien on the canonical (TAC, tETH) pool, so
  amount-granular wrapped BTC is itself a standard tacit asset:
  CXFER it, swap it, LP it, mix it. Trustless on the anchor side,
  over-collateralized by a (TAC, tETH) LP on the fungibility side.
  (Spec'd as an amendment; the fungibility layer ships with the AMM —
  ceremony pending.)
- **Trustless wrapped ETH.** `tETH` deposits ETH on Ethereum into
  a Poseidon-Merkle mixer contract, mints composable tETH on
  Bitcoin via Groth16 proof, and withdraws back to Ethereum via
  SP1-verified burn — no federation, no attestor, no multisig.
  Every mint is client-side verified: re-verify the Groth16 proof
  + check `ethRoot` against the Ethereum contract via `eth_call`.
  Notes and shielded UTXOs are deterministically derived from
  privkey alone. The mainnet contracts are live and Etherscan-verified;
  the in-dApp mainnet bridge is gated (not yet open to the public) while
  signet is open — see [`BRIDGE.md` § Live on Ethereum mainnet](./BRIDGE.md#live-on-ethereum-mainnet)
  for status + contract addresses.
- **Native marketplace.** Atomic OTC settlement of a confidential
  token against a BTC payment in one Bitcoin tx (`T_AXFER`), plus
  variable-amount partial fills (`T_AXFER_VAR`) and buyer-offline
  preauthorized bids (`T_PREAUTH_BID_VAR`) for walk-away flow.
- **Airdrops, fair-launches, drops.** `T_PETCH` / `T_PMINT` for
  permissionless-mint assets with publicly auditable caps;
  `T_DROP` / `T_DCLAIM` for ETH-gated public-claim pools;
  batched confidential CXFER airdrops for issuer-side
  distributions.

**The architectural move.** Indexer-validated meta-protocols
(Runes, Ordinals, BRC-20) trade real market value purely on
indexer agreement over chain state. Tacit leverages that same
consensus-of-indexers into a **collateral substrate**: TAC's
market-validated value (the same kind of value a Rune carries)
becomes the bond that makes wrapped BTC trustless without
federation. Cryptographic primitives (Pedersen, Groth16,
BabyJubJub-Pedersen, sigma binding) handle the parts that must
be cryptographic — custody of real BTC, amount confidentiality,
anonymous spend. The result is smart-contract-shaped properties
— AMM trading, collateralized wrapping, batched settlement —
delivered without a VM, without a sidechain, without leaving
Bitcoin L1.

See [`spec/CIRCUITS.md`](./spec/CIRCUITS.md) for how the two
Groth16 circuit families (`withdraw.circom` for anonymous spend
+ AMM circuits for amount-confidentiality) compose across these
surfaces.

What tacit doesn't do:

- Hide the address graph (sender/recipient Bitcoin addresses are
  visible — same as every Bitcoin-substrate protocol).
- Hide the asset ID (which token is moving is public).
- Run general-purpose code (no Turing-complete VM — the protocol
  grows by adding opcodes and circuits, not by executing user
  scripts).
- Eliminate issuer trust for confidential-supply assets unless
  the issuer publishes `(supply, blinding)`. The dApp publishes
  by default; opt-out is explicit.

---

## How tacit compares

Bitcoin's protocol surface sorts roughly along these axes: **where
validity is enforced**, **whether amounts are exposed**, **whether
the protocol does more than tokens**, and **whether wrapped BTC is
trustless**.

| | Substrate | Validity | Amounts | AMM | Trustless wBTC | Federation |
|---|---|---|---|---|---|---|
| Ordinals / BRC-20 | Bitcoin | Indexer | Public | — | — | None |
| Runes | Bitcoin | Indexer | Public | — | — | None |
| RGB | Bitcoin (anchor) | Off-chain client-side proofs | Hidden | — | — | None |
| Taproot Assets | Bitcoin (anchor) | Off-chain client-side proofs | Partial | — | — | None |
| Liquid CT + Liquid AMM | **Federated sidechain** | Sidechain consensus | Hidden | Yes | — | **15-of-N** |
| Citrea / Botanix / rollups | Bitcoin (rollup) | Rollup operator / fraud proofs | Varies | Yes | Varies | Operator set |
| **tacit** | **Bitcoin** | **Indexer** | **Hidden** | **Native** | **Yes (cBTC.zk)** | **None** |

What tacit does that nothing else does in one stack:

- **Confidential fungibles on Bitcoin proper.** Liquid CT uses the
  same Pedersen + Bulletproof primitives but lives on a federated
  sidechain. Tacit is just Bitcoin: every CXFER is a Bitcoin tx,
  every UTXO is a Bitcoin UTXO, no bridge.
- **Native AMM on Bitcoin L1.** Uniform-clearing-price block-batched
  AMM with confidential per-trader amounts and mixer-composable LP
  shares. No L2, no rollup, no smart-contract runtime — the
  "contract" is a Groth16 circuit + indexer rules fixed at pool
  init. AMMs on Bitcoin sidechains (Liquid SideSwap) inherit
  federation trust; AMMs on Bitcoin rollups (Citrea, Botanix)
  inherit operator-set / fraud-proof trust. Tacit has neither.
- **Trustless wrapped BTC.** `cBTC.zk` locks real BTC at a Taproot
  output `K_btc = r_leaf · G_secp256k1` derived from a mixer note's
  own secret. No federation, no co-signer, no oracle. WBTC,
  tBTC, RBTC: all federated or threshold-bonded. cBTC.zk is
  cryptographic.
- **Fungible wrapped BTC, also without federation.** `cBTC.tac`
  layers an LP-share lien on top of a cBTC.zk anchor with TAC
  over-collateral. Trust model: TAC stays valuable enough
  relative to BTC. Same shape as DAI's ETH-collateralization risk;
  not the same shape as wBTC's BitGo + auditors.
- **No off-chain proof exchange.** RGB and Taproot Assets push
  validity off-chain — the recipient must receive a proof chain
  from the sender, and losing it loses the balance. Tacit keeps
  everything on-chain; a wallet recovers full state from privkey
  + chain alone, even years later, with no surviving relationship
  to the sender.
- **Trustless wrapped ETH on Bitcoin L1.** `tETH` deposits ETH into
  an Ethereum mixer contract, mints composable tETH on tacit via
  Groth16, and withdraws via SP1-verified burn. No federation, no
  attestor set. Client-side Ethereum root verification on every mint.
- **OTC settlement in one Bitcoin tx (`T_AXFER`).** A confidential
  token transfer and the BTC payment that pays for it close in
  the same tx, atomically. `T_AXFER_VAR` adds partial fills;
  `T_PREAUTH_BID_VAR` adds buyer-offline walk-away bids.
  Ordinals atomic listings are the closest precedent, but they're
  public-amount; tacit gets the same atomicity over hidden balances.

Scope boundaries:

- **On-chain inscriptions (file bytes in Bitcoin witnesses).**
  Ordinals embeds the file directly into the witness; tacit
  carries only an `imageUri` on-chain and pins media to IPFS.
- **Lightning-native assets.** Taproot Assets is built into the
  LN stack; tacit is on-chain only.
- **Asset-graph privacy.** `asset_id` is visible in every
  envelope. Surjection proofs (on the roadmap) would hide this.
- **Address-graph privacy.** Same as every Bitcoin-substrate
  protocol. No CoinJoin; BIP-352 silent-payments
  composition is on the roadmap.

---

## Architecture in one screen

The protocol grows by applying a small number of primitives across
many surfaces. Two Groth16 circuit families and a uniform
out-of-circuit toolkit do all the cryptographic work; the indexer
does the accounting; Bitcoin holds the data.

```
                  Bitcoin L1 (substrate)
                          │
       ┌──────────────────┴───────────────────┐
       │      indexer-validated rules         │
       │   (same trust model as Runes; any    │
       │    party reaches the same verdict    │
       │    from chain data alone)            │
       └──────────────────┬───────────────────┘
                          │
       ┌──────────────────┴───────────────────┐
       │  out-of-circuit cryptographic stack  │
       │   secp256k1 Pedersen · bulletproofs  │
       │   BIP-340 Schnorr · 169-byte sigma   │
       │   cross-curve binding (secp ↔ BJJ)   │
       └─────┬─────────────────────────┬──────┘
             │                         │
       ┌─────┴─────┐             ┌─────┴─────┐
       │ withdraw  │             │    AMM    │
       │ .circom   │             │ circuits  │
       │           │             │           │
       │ Poseidon  │             │ BabyJubJub│
       │ leaf +    │             │ Pedersen +│
       │ Merkle +  │             │ range +   │
       │ nullifier │             │ in-circuit│
       │           │             │ AMM logic │
       └─────┬─────┘             └─────┬─────┘
   anonymous-spend                 amount-confidentiality
       │                                 │
   ┌───┴────┐                    ┌───────┴────────┐
   │ mixer  │                    │ T_LP_ADD/REMOVE│
   │ pool   │                    │ T_SWAP_BATCH   │
   │        │                    │ T_SWAP_VAR (*) │
   │ cBTC.zk│                    │ T_SWAP_ROUTE   │
   │ slot   │                    │ T_FARM_*       │
   │ ops    │                    │                │
   └────┬───┘                    └───────┬────────┘
        │                                │
        └────────────┬───────────────────┘
                     │
              ┌──────┴──────┐
              │  cBTC.tac   │  composes both families:
              │             │  cBTC.zk slot (cryptographic anchor)
              │             │  + AMM LP-share lien (indexer-enforced
              │             │  collateral, (TAC,tETH)-LP over-collateralized)
              └─────────────┘

(*) T_SWAP_VAR uses no Groth16 — Pedersen + bulletproof + kernel
    sig only. The "two trader paths" model picks circuits where
    confidentiality is load-bearing and skips them where amounts
    can be public.
```

The diagram and full primitive-by-primitive walkthrough live at
[`spec/CIRCUITS.md`](./spec/CIRCUITS.md). The single-image version
is [`tacit-circuits.svg`](./assets/tacit-circuits.svg).

**Why this stack matters.** Indexer-validated meta-protocols like
Runes already prove at scale that consensus-of-indexers can
underwrite real market value. Tacit takes the same consensus model
and **leverages indexer-validated value into the collateral
substrate for native-BTC wrapping** — TAC's market price (the same
kind of value a Rune carries) becomes the bond that makes cBTC.tac
trustless without a federation. Cryptographic primitives handle the
parts that must be cryptographic (real BTC custody at L1, amount
confidentiality, anonymous spend). Circuits handle privacy where
it's load-bearing, and stay out of the way where it isn't. The
result is smart-contract-shaped properties — AMM trading,
collateralized wrapping, batched settlement — delivered without a
VM, without a sidechain, without leaving Bitcoin L1.

---

## FAQ

**What is tacit?** Confidential tokens, a native AMM, trustless wrapped
BTC, a trustless ETH-Bitcoin bridge, and atomic marketplace settlement —
all on Bitcoin L1, no federation, no off-chain proofs, no third-party
trust. Issue a token with public or hidden initial supply (the dApp
publishes the supply opening to IPFS by default), or deploy a
fair-launch asset (`T_PETCH`) where supply is minted permissionlessly
against a publicly auditable cap. Send privately, swap on the AMM, LP,
farm, settle OTC atomically in a single Bitcoin tx, or route through the
mixer pool for full unlinkability. Your privkey plus the Bitcoin chain
are enough to recover your full balance years later.

**Why tacit and not Runes / Liquid / RGB?** Runes and BRC-20 publish
amounts in cleartext — anyone with a block explorer sees your balance.
Liquid CT hides amounts (and asset IDs too) but runs on a federated
sidechain with ~15 KYC'd functionaries; that's not Bitcoin and it's
not trustless. RGB and Taproot Assets keep the substrate clean but
push validation off-chain — the recipient has to receive and store a
proof chain from the sender, and losing it loses the asset. Tacit layers
privacy on Bitcoin L1 — shielded amounts by default, opt-in shielded
addresses for per-tx unique recipient markers, opt-in mixer pool for
full unlinkability — and recovers from privkey + chain alone, the way
Bitcoin itself works. See "How tacit compares" above for the longer
breakdown.

**How do I see my tacit balances?** In the dApp here, or in any
third-party tacit indexer that implements [SPEC.md](./SPEC.md). Tacit
envelopes ride in Bitcoin Taproot witnesses; the dApp decodes them
client-side, walks ancestry to each CETCH/MINT, and decrypts amounts via
ECDH — all from chain data alone, no server in the trust path. External
wallets like Xverse / UniSat / Leather connect for *funding* the tacit
wallet from your existing BTC; the tacit privkey itself stays in this
browser, encrypted and separate from your external wallet's seed.

**How much privacy do I get, and can I dial it?** Privacy is layered so
each user picks the level that fits the use case rather than forcing one
posture on everyone. Three orthogonal axes, composable:

1. **Shielded amount** — default on every transfer. Pedersen + bulletproofs
   hide the amount in every CETCH, T_MINT, CXFER, T_AXFER, and BURN-change
   commitment. BabyJubJub Pedersen + Groth16 inside `T_SWAP_BATCH` hide
   per-trader amounts during AMM settlement.
2. **Shielded address** — opt-in per receipt, live in production for CXFER.
   BIP-341-style blinded-pubkey commit `commit = recipient_pubkey +
   blinding·G` with `blinding = HMAC(ECDH(sender_priv, recipient_pub) ||
   domain || tx_anchor)`. On-chain recipient marker is a per-tx unique
   P2WPKH address with no apparent link to the recipient's published
   identity. Same crypto as BIP-340 / BIP-341 / BIP-352 silent payments;
   no new ceremony. Same scheme as Liquid CT's confidential addresses but
   on Bitcoin L1.
3. **Mixer pool** — opt-in per UTXO, live in production. T_DEPOSIT locks
   a fixed-denomination UTXO into a Poseidon Merkle tree; T_WITHDRAW
   proves unspent-leaf membership via Groth16 + nullifier without
   revealing which leaf. Breaks the on-chain link between deposit and
   withdrawal entirely. The mixer is
   the Bitcoin-only privacy option (fixed denominations, separate trusted
   setup) for assets that stay on Bitcoin; for amount-flexible privacy plus
   swap, borrow, and cross-chain flows the canonical surface is the
   `ConfidentialPool` shielded pool, which holds any amount as a single note
   and needs no ceremony.

Practical postures: a **merchant** keeps public transfers + shielded
balances (default — clean accounting + amount privacy on every line item).
A **privacy-conscious user** publishes a `tcs1…` shielded address for
receipts and routes outbound payments through the mixer pool (full
unlinkability at every endpoint). Asset-id privacy via asset surjection
proofs is on the roadmap; until then asset_id is public on chain.

**Am I locked into your platform?** No. The protocol spec is open (MIT,
[SPEC.md](./SPEC.md) is authoritative); any indexer in any language
reaches the same verdict from chain alone — re-implement it, audit it,
pin a copy of the dApp by IPFS CID. Asset metadata (images, descriptions,
supply openings) is pinned to IPFS by content hash, so the on-chain
reference is to the content (CID), not to anyone's server: anyone can
re-pin to a different IPFS service, any IPFS gateway can resolve. Both
`WORKER_BASE` and `IPFS_GATEWAY` are top-of-file constants in
`dapp/tacit.js`; setting `WORKER_BASE = ''` disables every worker
endpoint and the protocol still works for transfers, validation, and
recovery.

Ordinals takes the opposite tradeoff — content lives directly on-chain
in Taproot witnesses, no off-chain dependency at all but each inscription
carries the full file as Bitcoin fees (impractical beyond small images).
Runes encodes token state in OP_RETURN runestones but carries no image /
metadata convention in the protocol, so wallets and explorers usually
fetch "what does this rune look like" from a marketplace's centralized
API.

**Can I recover my balance from just my privkey?** Yes, for every
on-chain envelope. The dApp scans chain data, walks ancestry back to
each CETCH/MINT, decrypts amounts via ECDH, and reconstructs the wallet —
no share-link or sync server required. The one exception is atomic-intent
recipient UTXOs (SPEC §5.7.6 — listed with a uniform-random blinding so
browse-and-take can publish a cleartext amount without leaking via
baby-step-giant-step), which fall back to local cache or the worker's
24-hour fulfilment record.

**How do I trust the announced supply when amounts are hidden?** The
dApp ships supply attestation **on by default**. At etch time it pins
the `(supply, blinding)` opening into IPFS as part of the asset
metadata; anyone fetches the blob and verifies
`pedersenCommit(supply, blinding) == on-chain commitment` from chain
alone — no worker trust, no issuer trust beyond the one-time honest
publish. Issuers who want a centralized-stablecoin-style "trust me about
the supply" model can opt out explicitly. SPEC §7.3 spells out the
attestation flow; for non-mintable assets attested at etch, supply is
provably and permanently public.

**What's the cost per transfer?** ~10 KB witness per CXFER (m=2
aggregation), about 2,500–3,000 vBytes after the SegWit discount. At
10 sat/vB on mainnet that's ~25–30k sats per transfer; at low-fee
periods correspondingly less. Bulletproofs+ (`T_CXFER_BPP`) shaves ~14%
off the rangeproof. The witness carries the cryptographic proof that
amounts balance without revealing them — one aggregated bulletproof
for all outputs plus a kernel signature.

**Is the indexer trust-bearing? What if I don't trust the worker?**
The dApp's *indexer code* is the trust target — re-host it, pin it by
IPFS CID; two browsers running the same code reach the same verdict from
chain alone. The worker is a convenience cache, not part of the
trust-bearing protocol: it cannot make an invalid envelope appear valid
(clients re-verify rangeproofs, kernel sigs, mint sigs, and Pedersen
openings client-side). You can run your own in ~5 minutes on a free
Cloudflare account, or set `WORKER_BASE = ''` in `dapp/tacit.js` to
disable it entirely. SPEC §8 covers this.

**Is the code open?** Yes — MIT licensed, this repo is the canonical
source. The protocol spec ([SPEC.md](./SPEC.md)) is the authoritative
reference for indexer implementations; a re-implementation in any
language reaches the same verdict from chain alone.

---

## User stories

**Alice mints a token.** Alice opens the dApp and signs in with Xverse —
tacit derives a per-wallet identity in this browser and Alice clicks
"Top up tacit" to send a few thousand sats over from Xverse for tx fees.
She fills in ticker = `ALICE`, supply = 1000, decimals = 2, optionally
uploads an image or marks the asset Mintable, and clicks Etch. Two
transactions go on chain (commit + reveal). On chain, anyone can see a
new ALICE token exists and that its supply is some integer in `[0, 2⁶⁴)` —
but only Alice knows the supply is 1000. (On signet, Alice can skip the
wallet connect: the dApp generates a key and the faucet button funds it.)

**Alice sends 50 ALICE to Bob.** Alice pastes Bob's pubkey (Bob copied it
from his Wallet tab). The dApp builds a CXFER tx: input = Alice's supply
UTXO (commits to 1000), outputs = recipient (commits to 50, blinded with an
ECDH key only Alice and Bob can derive) + change (commits to 950, blinded
with Alice's own key). One aggregated bulletproof covers both output range
proofs (~754 B total). A kernel signature proves inputs − outputs balance
to zero. On chain: ALICE moved, neither amount visible.

**Bob recovers on a fresh device.** Bob enters his privkey on a clean
install. The dApp scans signet/mainnet for outputs paying his pubkey, walks
each one back through CXFER history to its CETCH ancestor, verifies every
rangeproof and kernel sig locally (no trust in any server), derives the ECDH
key with the sender, and decrypts the amount. **No share-link or sync server
required.** Privkey alone reconstructs the wallet.

**Carol browses what tokens exist.** Carol clicks Discover. The dApp hits
the Worker's `/assets` and `/petch-assets` endpoints, which have been
chain-scanning every 5 minutes for CETCH, T_CXFER, T_MINT, T_BURN,
T_AXFER, T_PETCH, and T_PMINT envelopes. **Every Discover card is
client-validated before render**: the dApp walks back to the on-chain
CETCH envelope, verifies the rangeproof, decodes the canonical ticker /
decimals / commitment, and checks attestation against the `tacit_attest`
field in the IPFS metadata blob (no worker trust — content-addressed). If
the worker tries to spoof a ticker, Carol sees a ⚠ MISMATCH badge. She
can't see anyone's balances, but for any attested asset she sees the
supply (✓ verified opening, IPFS) along with attested mint history and
public burn totals.

**Alice optionally pings Bob with a share-link.** After broadcasting, the
dApp emits a URL ending in `#recv=…` containing the opening (amount +
blinding). Alice DMs it to Bob; clicking it imports the opening directly,
skipping a chain scan. **This is purely UX — Bob's recovery story above
works regardless.** Share-links notify, they don't authorize.

**Bob lists 5,000 ALICE for sale on the public market.** From Holdings, Bob
clicks "List a UTXO for sale" → 250,000 sats, 7-day expiry. The listing
publishes the UTXO's `(amount, blinding)` opening + price + signed offer to
the worker. Anyone can browse it on the Market tab and click Verify, which
re-runs Pedersen + sig + liveness checks client-side. A taker pays Bob's
address out-of-band and Bob delivers via CXFER — OTC, trust required.

**Carol lists 1,000 ALICE with hidden total balance.** Carol holds a
treasury of ALICE across many UTXOs and doesn't want to dox the total.
"List (hidden balance)" → bulletproof showing `balance ≥ 1000` is published
alongside the offer. The Market tab shows it with a green ≥ badge. Same
OTC settlement, but Carol's exact balance stays confidential.

**Dave atomically swaps 10,000 GOLDC for 500K sats with Erin.** They
exchange pubkeys via Telegram. Dave clicks "Atomic (targeted)" on Holdings,
generates a partial reveal targeted at Erin's pubkey, copies the JSON.
Erin clicks "Take atomic offer," pastes the JSON, and the dApp appends her
BTC funding signed `SIGHASH_ALL`. **One Bitcoin tx settles both sides.**
Neither could grief the other — the maker's `SIGHASH_SINGLE_ACP` sigs bind
the BTC payment, the taker's `SIGHASH_ALL` sig binds the whole tx.

**Frank publishes an open atomic intent for anyone to claim.** "Atomic
intent (open)" on Holdings → 100 USDA for 50K sats, 1-day expiry. The
intent appears on the Market tab with a purple ⚡ badge. Helen clicks
Claim, locks for 5 minutes. Frank sees the claim on the Market tab and
clicks "Fulfil claim" — the dApp generates a partial reveal targeted at
Helen's pubkey and posts it. Helen clicks Take, broadcasts. **Discoverable
+ trustless atomic OTC**, no out-of-band coordination.

**Jack swaps TAC for USDA on the AMM.** Jack opens the Pool tab, picks the
TAC/USDA pool, enters 500 TAC. The dApp builds a `T_SWAP_VAR` envelope —
cleartext amounts against the constant-product curve, no Groth16 needed
for the per-trade path. One commit-reveal pair, ~10 seconds on signet.
Jack's USDA UTXO appears in Holdings. Pool reserves update for every
indexer watching the chain.

**Kim publishes a walk-away bid for GOLDC.** Kim wants to buy 5,000 GOLDC
at 100 sats/unit but doesn't want to keep the dApp open. She clicks
"Preauth bid" on Market, sets her price and range, and signs once. The
bid goes live on the Market tab. Any seller can fill — partially or
fully — by spinning up an atomic intent targeted at Kim's pubkey. Kim's
residual returns to her automatically if the fill is partial
(`T_PREAUTH_BID_VAR`). Kim can be offline the entire time.

**Greta airdrops 50,000 GRETA to ETH holders of an old token.** Greta has
an Etherscan CSV (320 addresses + balances). On the Drops tab she selects
GRETA, uploads the CSV (optional blacklist), clicks Build merged snapshot
— the dApp normalizes amounts, sorts by address, and computes the merkle
root. She pins the snapshot JSON to IPFS and shares the `(merkle_root, CID)`
pair via her usual channels. As claims arrive in the worker queue, she
pulls them in batches and the dApp broadcasts batched CXFERs (up to 7
confidential recipients per tx, all signed in one go from her treasury key).

**Ivy claims her share.** Ivy opens the Claim tab, pastes the merkle root
+ IPFS CID, clicks Load snapshot. The dApp fetches the JSON, recomputes
the merkle root locally, and shows Ivy her row. She connects MetaMask and
signs a canonical claim binding her tacit pubkey to the drop (off-chain
signature — no Eth tx, no gas). The resulting `(leaf_index, tacit_pubkey,
eth_sig)` tuple goes to the worker queue (or directly to Greta). When
Greta fulfils, the confidential GRETA UTXO appears in Ivy's Holdings via
the same ECDH recovery path as any other CXFER.

---

## Repository layout

```
tacit/
├── dapp/                  # THE dApp — pin this directory to IPFS
│   ├── index.html         # markup, meta-CSP, script tags
│   ├── tacit.js           # core: Pedersen, bulletproofs, kernel sigs,
│   │                      #  BIP-340/341, envelope encode/decode,
│   │                      #  recursive validator, wallet, UI, marketplace
│   ├── bulletproofs.js    # bulletproof rangeproof prover/verifier
│   ├── bulletproofs-plus.js # Bulletproofs+ (~14% smaller witnesses)
│   ├── amm-envelope.js    # AMM envelope builders (LP_ADD, LP_REMOVE, SWAP_BATCH…)
│   ├── amm-bjj.js         # BabyJubJub curve ops for in-circuit AMM math
│   ├── amm-kernel.js      # AMM kernel signature computation
│   ├── amm-sigma.js       # sigma cross-curve proofs (secp ↔ BJJ)
│   ├── amm-asset.js       # LP-share asset derivation
│   ├── amm-min-liq.js     # minimum liquidity tracking
│   ├── amm-receipt.js     # AMM receipt recovery
│   ├── amm-farm-ui.js     # yield farm UI
│   ├── amm-farm-actions.js # farm action builders (FARM_INIT, LP_BOND, LP_HARVEST)
│   ├── prf-wallet.js      # WebAuthn PRF key derivation
│   ├── preboot.js         # pre-initialization (localStorage, session setup)
│   ├── sw.js              # service worker
│   ├── _headers           # CF Pages HTTP headers (frame-ancestors, XCTO, Referrer)
│   └── vendor/
│       └── tacit-deps.min.js   # bundled @noble/secp256k1 + @noble/hashes
│                                #  + @scure/base + sats-connect
├── contracts/             # Solidity contracts: ConfidentialPool bridge/DeFi + legacy tETH mixer
│   ├── src/               # ConfidentialPool.sol, routers, asset factory, legacy TacitBridgeMixer.sol
│   ├── test/              # Forge tests
│   └── script/            # deployment scripts
├── worker/                # optional Cloudflare Worker (faucet, asset registry, IPFS pin)
│   ├── src/index.js
│   ├── wrangler.toml
│   └── README.md
├── fulfiller/             # auto-fulfilment service for atomic intents
│   └── auto-fulfil.mjs
├── verify-service/        # remote Groth16 proof verification server
│   ├── server.mjs
│   └── Dockerfile
├── tests/                 # offline test harness (160+ test files)
├── spec/                  # protocol specs + amendments
│   ├── CIRCUITS.md        # how the ZK stack composes
│   ├── GLOSSARY.md        # cross-surface term definitions
│   ├── amendments/        # 28 amendments (shipped + drafted)
│   ├── amm/               # AMM wire formats, ceremony, failure modes
│   └── design/            # design docs (channel UX, consensus, stealth)
├── build/                 # esbuild bundler for vendor deps (dev-time only)
├── assets/                # logos + architecture diagrams (README / docs imagery)
├── whitepaper/            # technical whitepaper (WHITEPAPER.md + .tex + .pdf)
├── discord/               # protocol monitoring bot
├── airdrop/               # CSV-based airdrop tooling
├── ops/                   # operational runbooks
├── scripts/               # utility scripts (relay, SP1 proofs,
│                          #  verify-tac-supply.mjs: trustless fixed-supply check)
├── SPEC.md                # canonical protocol specification
├── AMM.md                 # confidential AMM architecture
├── MIXER.md               # shielded-pool architecture
├── BRIDGE.md              # legacy tETH mixer bridge (sunset; historical/recovery)
├── AMENDMENTS.md          # amendment index + status
├── README.md              # you are here
└── LICENSE
```

`dapp/` loads `index.html` (markup + meta-CSP), `tacit.js` (core protocol +
wallet + UI, ESM module), and `vendor/tacit-deps.min.js` (noble + scure +
sats-connect, bundled — imported from `tacit.js`). The AMM, farm, and
Bulletproofs+ modules are separate ESM files imported by `tacit.js`. The
meta-CSP locks `script-src 'self' 'wasm-unsafe-eval'` (no `'unsafe-inline'`,
no `'unsafe-eval'`, no third-party origins). `'wasm-unsafe-eval'` permits
`WebAssembly.instantiate()` (snarkjs Groth16 prover/verifier) without
reopening the broader eval() surface. Pinning `dapp/` yields one CID
covering every byte of trust-bearing code. `connect-src` reaches only
`mempool.space`, `blockstream.info` (divergence watchdog), the worker, and
the IPFS gateway. `img-src` is `'self' data: https://content.wrappr.wtf` —
direct `https://` images in CETCH envelopes are rejected to avoid
IP-correlation beacons.

`contracts/` holds the active `ConfidentialPool` bridge/DeFi system plus the
legacy tETH mixer contracts. New bridge and Sepolia testing targets
`ConfidentialPool`; `TacitBridgeMixer.sol` is sunset alpha infrastructure for
existing-note recovery/migration. See [`ops/STATUS-confidential-system.md`](./ops/STATUS-confidential-system.md)
and [`ops/RUNBOOK-confidential-pool-deploy.md`](./ops/RUNBOOK-confidential-pool-deploy.md).

`build/` is dev-time only. Run `cd build && npm install && npm run build`
when you bump deps or want fresh SRI hashes. Editing `dapp/index.html`
or `dapp/tacit.js` directly does not require a build — both are served
as-is, and the runtime KAT catches any drift between the bundle and what
tacit expects.

The `worker/` directory holds an optional Cloudflare Worker (image pinning
to IPFS, signet faucet, asset directory, pool/farm state).
**The Worker holds no trust-bearing logic.** Setting `WORKER_BASE = ''`
at the top of `dapp/tacit.js` disables it entirely; the protocol still
works.

`fulfiller/` provides an auto-fulfilment service for atomic intents —
polls the worker for pending claims and settles them without manual
intervention. `verify-service/` exposes a remote Groth16 verifier
(Docker-ready).

---

## How the protocol works (one screen)

```
ETCH (one-time, mints a new asset)
─────────────────────────────────
 commit-tx → P2TR output committed to envelope
 reveal-tx → spends P2TR via script-path, exposes envelope in witness:

     CETCH || ticker || decimals || C(33B) || amount_ct(8B)
            || rangeproof(~688B m=1 bulletproof, n=64)
            || mint_authority(32B, all-zero = non-mintable)
            || image_uri(≤256B)

   C = supply·H + r·G        (Pedersen commitment to supply)
   amount_ct = supply ⊕ HMAC(etcher_priv, "tacit-etch-amount-v1" ‖ anchor)
   r          = HMAC(etcher_priv, "tacit-etch-v1" ‖ anchor)

   anchor = first input outpoint of commit-tx (so the etcher can recover
            the supply opening from chain + privkey alone)

   asset_id = sha256(reveal_txid ‖ vout=0)


TRANSFER
────────
 commit-tx → P2TR output committed to envelope
 reveal-tx → spends commit-tx + asset UTXO(s); envelope:

     CXFER || asset_id || kernel_sig(64B) || N
           || (C_i, amount_ct_i)*N
           || aggregated_rangeproof    (one bulletproof for all N outputs)

   N ∈ {1, 2, 4, 8} (power of 2 for aggregation)
   r_recipient = HMAC(ECDH(sender_priv, recipient_pub), "tacit-blind-v1" ‖ anchor ‖ vout)
   r_change    = HMAC(sender_priv,                       "tacit-change-v1" ‖ anchor ‖ vout)
   amount_ct   = amount ⊕ keystream  (ECDH-derived for recipient, self-derived for change)

   excess = (Σr_out − Σr_in) mod N
   E'     = ΣC_out − ΣC_in
   kernel_sig verifies under E'.xonly() — proves Σa_out = Σa_in without revealing amounts


MINT (mintable assets only)
───────────────────────────
 Same commit-reveal pattern, envelope:

     T_MINT || asset_id || etch_txid || C(33B) || amount_ct(8B)
            || rangeproof(~688B) || issuer_sig(64B)

   issuer_sig = BIP-340 over sha256("tacit-mint-v1" ‖ asset_id ‖ commit_anchor ‖ C ‖ amount_ct)
                under mint_authority's privkey
   (commit_anchor binding prevents envelope replay into a different commit/reveal pair)


BURN
────
 Same commit-reveal pattern, envelope:

     T_BURN || asset_id || burned_amount(8B, public) || kernel_sig(64B) || N
           || (C_i, amount_ct_i)*N        # change outputs (N=0 = full burn)
           || aggregated_rangeproof       # omitted if N=0

   E' = ΣC_out + burned_amount·H − ΣC_in
   kernel_sig verifies under E'.xonly()


T_AXFER (atomic OTC settlement — CXFER variant for marketplace use)
───────────────────────────────────────────────────────────────────
 Same shape as CXFER except the maker explicitly declares how many of
 vin[1..] are tacit asset inputs; the rest are aux BTC inputs the taker
 funds in the same Bitcoin tx:

     T_AXFER || asset_id || asset_input_count(1B) || kernel_sig(64B) || N
            || (C_i, amount_ct_i)*N
            || aggregated_rangeproof

   maker signs vin[0] (envelope) + vin[1..1+asset_input_count] with
   SIGHASH_SINGLE | ANYONECANPAY → taker can append BTC inputs/outputs
   without invalidating maker's sigs.
   taker's BTC funding inputs are SIGHASH_ALL → pin the whole tx.
   Both sides settle in one Bitcoin tx; neither can grief the other.


T_PETCH (permissionless-mint deployment record — fair-launch issuance)
──────────────────────────────────────────────────────────────────────
 Same commit-reveal pattern. Produces NO supply UTXO — deployer gets zero
 tokens; the only way to hold supply is to broadcast T_PMINT later.

     T_PETCH || ticker || decimals
             || cap_amount(8B) || mint_limit(8B)
             || mint_start_height(4B) || mint_end_height(4B)
             || image_uri(≤256B)

   asset_id = sha256(reveal_txid ‖ vout=0)            (same as CETCH)
   cap_amount % mint_limit == 0  (cap reachable; rejected if not)
   mint_start_height ≥ etch_height + 1  (deployer can't mint in own block)


T_PMINT (permissionless mint event — anyone may broadcast)
──────────────────────────────────────────────────────────
 Mints exactly mint_limit tokens against a T_PETCH ancestor.

     T_PMINT || asset_id || etch_txid
             || C(33B) || amount(8B, public) || blinding(32B, public)

   amount == petch.mint_limit       (validator rejects otherwise)
   confirmed_height ∈ [start, end]  (height-window check)
   credited only at depth ≥ 3       (Bitcoin reorg safety; SPEC §5.9)
   cap enforced from canonically-ordered chain history:
     prior_count × mint_limit + amount ≤ cap_amount

   No signature. (amount, blinding) are public — any wallet with the
   privkey for vout[0]'s output script recovers the UTXO from chain
   alone, no derivation needed. The first CXFER from such a UTXO
   re-blinds it back into confidential transfer mode.


T_DEPOSIT / T_WITHDRAW (shielded mixer pool)
────────────────────────────────────────────
 Tornado-style anonymity pool over any tacit asset at a fixed denomination.

 POOL_INIT (T_DEPOSIT with denomination = 0 sentinel):
     T_DEPOSIT || asset_id || denomination=0(8B)
               || pool_denom(8B) || vk_cid_len(1) || vk_cid
               || ceremony_cid_len(1) || ceremony_cid || init_sig(64B)

 DEPOSIT (T_DEPOSIT with denomination ≠ 0):
     T_DEPOSIT || asset_id || denomination(8B)
               || leaf_commitment(32B) || kernel_sig(64B)

   leaf_commitment = Poseidon(secret, nullifier_preimage, denomination)
   The (secret, nullifier_preimage) pair is held by the depositor —
   without it, the deposit cannot be withdrawn. Worker appends each
   deposit's leaf to a per-pool merkle tree in canonical order.

 WITHDRAW (T_WITHDRAW):
     T_WITHDRAW || asset_id || denomination(8B)
                || merkle_root(32B) || nullifier_hash(32B)
                || recipient_commitment(33B)
                || r_leaf(32B)        (public Pedersen blinding scalar)
                || bind_hash(32B)     SHA256-tagged commit to the tuple
                || proof_len(2B) || proof(Groth16, ~256B)

   Public inputs to the Groth16 verifier:
     [merkle_root, nullifier_hash, denomination, r_leaf, bind_hash]
   Witness (private): secret, nullifier_preimage, leaf merkle path.

   r_leaf is published in cleartext — same posture as T_PMINT's
   (amount, blinding). Privacy comes from Groth16 zero-knowledge over
   the leaf-membership statement, not from hiding r_leaf. Recovery is
   then trivial for both self-withdraw and tornado-flow-to-other
   (recipient reads r_leaf from chain).

   Validator extras beyond the proof:
     - bind_hash recompute matches (binds proof to the specific tuple)
     - external secp256k1 check: recipient_commitment == denom·H + r_leaf·G
       (closes the inflate-amount attack — circuit forces r_leaf =
        Poseidon(secret, ν), validator forces the Pedersen equation)
     - merkle_root in the last 32 canonical roots of this pool
     - nullifier_hash NOT in this pool's spent set

 Anonymity set = currently-unspent leaves at withdraw time. Wait for
 the pool to fill before withdrawing.

 v1 status: wire format, worker indexing, browser-side Groth16 prover +
 verifier, Phase 2 ceremony coordinator, and the public ceremony run
 (2,227 contributions + Bitcoin-block beacon) all shipped. Canonical
 bundle CID is hardcoded in the dapp. SPEC §5.10–§5.11 + §3.6–§3.8.


VALIDATION (recursive, browser-side)
────────────────────────────────────
 For each wallet UTXO:
   1. Decode envelope at parent_tx.vin[0].witness[1]
   2. If CETCH:    verify rangeproof; record metadata
   3. If T_MINT:   recursively validate the CETCH ancestor;
                   verify issuer_sig (with commit_anchor binding); verify rangeproof
   4. If CXFER/T_AXFER/BURN:
       a. recursively validate every asset input outpoint
          (T_AXFER: only vin[1..1+asset_input_count]; aux BTC inputs are skipped)
       b. verify aggregated rangeproof for outputs (skip if BURN with N=0)
       c. verify asset_id consistency across all asset-input parents
       d. verify kernel_sig under (ΣC_out + burned·H − ΣC_in).xonly()
   5. If T_PETCH:  not a UTXO — return false. Metadata recorded by indexer.
   6. If T_PMINT:  resolve T_PETCH parent metadata; verify amount == mint_limit,
                   confirmed_height ∈ window, depth ≥ 3, cap not exceeded,
                   pedersenCommit(amount, blinding) == commitment
   7. If T_DEPOSIT:  not a UTXO — vout[0] is BTC change, not tacit. Worker
                     records the leaf for pool merkle-tree state. Recovery
                     walks do not recurse through T_DEPOSIT envelopes.
   8. If T_WITHDRAW: verify merkle_root is in the pool's last 32 canonical
                     roots, nullifier_hash is unseen, bind_hash recomputes,
                     `recipient_commitment == denom·H + r_leaf·G` (external
                     secp256k1 Pedersen check), and the Groth16 proof verifies
                     under the pool's vk over [merkle_root, nullifier_hash,
                     denomination, r_leaf, bind_hash].
   9. Resolve own (amount, blinding) via local cache OR trial-decrypt amount_ct
      (T_PMINT and T_WITHDRAW: amount + blinding are in the envelope
       cleartext — no decrypt; just verify the Pedersen equation)

 Memoized; O(N) over chain depth N. Optimistically batches all rangeproofs
 across the walk into a single multi-scalar multiplication.


RECOVERY
────────
 Privkey + chain → full wallet state. No share-link required, no localStorage
 backup required. The wallet trial-decrypts every commitment it owns:
   - As recipient (ECDH against sender pubkey at vin[1].witness[1])
   - As own change      (self-derived keystream)
   - As own etched supply (self-derived from commit input outpoint anchor)
   - As own minted supply (same anchor pattern, different domain string)
   - As T_PMINT-minted supply (own or other) — (amount, blinding) are in the
     envelope cleartext; no derivation. Match P2WPKH(hash160(my_pub)) to
     vout[0] to claim ownership; verify pedersenCommit(amount, blinding) ==
     commitment to reject tampered envelopes.
   - As mixer-pool withdrawal (T_WITHDRAW) — `denomination` and `r_leaf`
     are both in the envelope cleartext (same posture as T_PMINT). Verify
     `pedersenCommit(denomination, r_leaf) == on_chain_commitment`. Works
     identically whether withdrawer === recipient or not — the public
     `r_leaf` makes share-links unnecessary for tornado-flow-to-other.

 (One exception: atomic-intent recipient UTXOs use a uniform-random blinding
  delivered ECDH-encrypted to the claimant at fulfilment time — recovery
  falls back to local cache or re-fetching the encrypted fulfilment from
  the worker within its 24h TTL. SPEC §5.7.6.)
```

For more detail, open the dApp and read the **About** tab — the on-page
docs spell out the wire format, attack vectors, blinding delivery, and
trust model.

---

## Running the dApp

The dApp is a single HTML file plus its vendored bundle.

### Locally (fastest path)

```sh
# any static file server works
cd tacit/dapp
python3 -m http.server 8000
# open http://localhost:8000/  (serves dapp/index.html)
```

CORS is allowlisted for `http://localhost:8000`, `:3000`, `:127.0.0.1:8000`,
and `null` (`file://`) in the deployed Worker, so local dev hits the live
endpoints out of the box.

### Hosted

Pin the `dapp/` directory to IPFS, or drop it on Cloudflare Pages, GitHub
Pages, Vercel, or any static host. There are no env vars or build flags —
the Worker URL and IPFS gateway are set at the top of the script:

```js
const WORKER_BASE  = 'https://tacit-pin.rosscampbell9.workers.dev';
const IPFS_GATEWAY = 'https://content.wrappr.wtf/ipfs/';
```

Once you know your hosted origin, narrow `ALLOWED_ORIGINS` in
`worker/wrangler.toml` to it, then `wrangler deploy`.

### Refreshing the vendor bundle

Run only when bumping crypto dep versions or wanting fresh SRI hashes.

```sh
cd tacit/build
npm install
npm run build
# prints SHA-384 of dapp/vendor/tacit-deps.min.js, dapp/tacit.js, and dapp/index.html
```

See `build/README.md` for details.

---

## Using the dApp

1. **Sign in / set up a wallet.** Pick whichever fits:
   - **Connect an Ethereum wallet** (MetaMask / Rabby / Rainbow / Coinbase) —
     tacit derives its identity from one `personal_sign` signature over a
     fixed message. RFC 6979 makes the signature deterministic, so the same
     ETH account re-derives the same tacit wallet on any device: recovery is
     just reconnecting and signing again — no seed, no passphrase, no stored
     secret. See `ops/DESIGN-eth-wallet-identity.md` for the derivation
     chain, security guards, and test coverage.
   - **Use a passkey** — the WebAuthn PRF extension derives the key from your
     platform authenticator (Face ID / fingerprint / security key); the same
     passkey reproduces the same wallet on any device it syncs to.
   - **Connect a Bitcoin wallet** (Xverse / UniSat / Leather) — wallets that
     prove deterministic message signing at enrollment derive a recoverable
     identity the same way; wallets that sign non-deterministically connect
     as funding-only with a local tacit key.
   - **Import a privkey** — paste the 64-hex from any source.
   - **Auto-generated** — the dApp creates a key on first load (handy for
     signet demos with the faucet).

   On the local-key paths (import / auto-generated / funding-only), the
   in-page privkey is **encrypted at rest in localStorage** — AES-GCM with a
   passphrase-derived key (PBKDF2-SHA256, 600k iterations per OWASP 2023),
   prompted to unlock on each load. Forgetting the passphrase = losing the
   wallet, so **export the privkey separately** via Wallet → Export key —
   that's the real recovery path, and mainnet gates every value-creating
   action behind a "have you exported the key?" acknowledgement. The
   signature-derived paths (Ethereum wallet, passkey, deterministic Bitcoin
   wallet) store no secret at all: the key is re-derived each session and
   recovery is reconnecting the same signer.
2. **Get sats.** On signet, click ⚡ Demo drip — single round trip, no
   captcha. (If the faucet is empty, the Manual faucet button opens public
   signet faucets.) On mainnet, click **Top up tacit** in the connect panel
   for one-click funding from your external wallet, or send sats to the
   tacit address shown on the Wallet tab from any Bitcoin wallet.
3. **Etch.** Pick a ticker, supply, decimals (0–8). Optionally upload an
   image and add description / external URL — the dApp pins a JSON
   metadata blob to IPFS and stores its CID in the envelope. Mark
   **Mintable** if the etcher pubkey should be allowed to issue more supply
   later (permanent decision; loss of the in-page privkey freezes supply
   forever). Click Preview, then Etch & broadcast. Two transactions go out
   (commit + reveal); the second confirms in ~10 minutes on signet.
4. **Transfer.** Pick an asset, paste recipient's pubkey (they read it off
   their own Wallet tab), enter an amount. Click Preview, then Transfer &
   broadcast. The recipient auto-discovers the balance on next scan via
   the on-chain encrypted-amount field.
5. **Mint.** Mintable asset only — issues additional supply, signed by the
   mint_authority key (the etcher's in-page privkey). Re-uses the
   commit-reveal flow.
6. **Fair-launch (T_PETCH / T_PMINT).** Deploy an asset whose supply is
   issued permissionlessly in fixed tranches, with a publicly auditable cap.
   On the **Etch · public mint** panel, set ticker, decimals, `cap_amount`,
   `mint_limit` (`mint_limit` must divide `cap_amount` so the cap is reachable), and an optional
   height window. Click Deploy public-mint asset — the deploy tx creates
   **zero tokens**; you (or anyone) mint a tranche later by clicking **Mint**
   on the asset's card in **Discover → Fair launch**. Cumulative supply,
   mints remaining, and per-mint status (pending / credited / revoked) are
   visible to everyone. Mints credit at Bitcoin confirmation depth ≥ 3.
7. **Burn.** Any holder. Destroys part or all of their balance with a
   public `burned_amount` so observers can audit supply reduction.
8. **Holdings.** Lists your assets with images, descriptions, balances.
   ↻ Rescan UTXOs forces re-validation. **Per-asset card actions** include:
   - **Send privately / Burn / Mint more** (core CXFER / BURN / MINT flows).
   - **Reveal supply / Reveal mints** — etcher / mint-authority publish their
     openings to the worker so anyone in Discover sees ✓ verified supply.
   - **Publish balance** — pin the per-UTXO `(amount, blinding)` openings to
     the worker; signed by your wallet so a CXFER counterparty who learned
     the opening can't dox you. Permanent — once on the worker, it's there.
   - **Prove ≥ threshold** — generate a bulletproof showing balance ≥ X
     without revealing the exact amount (range disclosure, SPEC §5.6).
   - **List a UTXO for sale** — public OTC listing with the per-UTXO
     opening + price + expiry + maker payment address.
   - **List (hidden balance)** — same shape but the proof is "`balance ≥ K`"
     instead of full opening; other UTXOs stay confidential.
   - **Atomic (targeted)** — partial-reveal-as-JSON for a specific known
     recipient pubkey. Settles atomically when the taker pastes + finalizes.
   - **Atomic intent (open)** — publish a generic atomic offer on the
     Market tab for any taker to claim and atomically settle.
9. **Discover.** Lists every asset on the active network in two sections:
   the main confidential-supply list (CETCH-rooted, supply hidden behind a
   Pedersen commitment plus issuer attestation), and a separate **fair
   launch · public-mint assets** panel (T_PETCH-rooted, permissionless-mint
   with public cumulative supply and per-mint status). Filter by ticker /
   asset_id; pills (`mintable` / `attested` / `recent` / `has mints` /
   `has burns` / `has transfers`) narrow the main list. Each card surfaces
   verified supply, mint history, burn totals, and — for fair-launch
   assets — cap progress and a Mint button.
10. **Market.** Aggregate marketplace across all assets. Listing kinds:
   - 🟢 **opening** — exact-amount listing (OTC settlement)
   - 🟢 **≥ range** — range-disclosed listing (OTC settlement, exact balance hidden)
   - 🟣 **⚡ atomic intent** — browse-and-take with single-Bitcoin-tx settlement
   - 🔵 **bid intent** — buyer publishes "I'd buy N at P"; sellers fill by
     spinning up an atomic intent targeted at the bidder
   - 🟠 **preauth bid** — buyer-offline walk-away bid (`T_PREAUTH_BID_VAR`);
     any seller can fill partially or fully while the buyer is offline
   Filters: ticker / asset_id, kind, price min/max, sort by recency or
   price. Take + Verify buttons run full client-side validation (sigs,
   ownership, Pedersen for openings / bulletproof for ranges, UTXO
   liveness) before any commitment. Atomic intent tiles surface the
   relevant button based on your role: Claim if untaken, Fulfil if it's
   yours and a claim is pending, Take when fulfilment is ready.
11. **Drops** *(issuer side)*. Batched 1:N confidential CXFER airdrops.
    Upload one or more snapshot CSVs (`eth_address,amount` — Etherscan
    holder exports work as-is), optionally blacklist addresses, Build
    merged snapshot to compute the merkle commitment, Pin to IPFS, Save
    the drop record. Then publish `(merkle_root, IPFS CID)` to recipients
    however you like (Twitter, Discord, blog). As claims arrive in the
    worker queue, Pull queued → Verify batch → Broadcast: up to 7
    recipients per CXFER, each verified for merkle inclusion + ETH-sig
    recovery to the listed address before broadcast. Drop records
    (including the local fulfilled-leaves ledger) live in localStorage;
    use Export JSON to back up. A Cross-check vs chain button walks the
    local ledger and verifies each fulfilled leaf actually confirmed
    on-chain.
12. **Mixer** *(production — Phase 2 finalized 2026-05-11)*.
    Tornado-style shielded pool over any tacit asset at a fixed
    denomination. Deposit a UTXO of the pool's exact denomination; the
    dApp generates a `(secret, nullifier_preimage)` pair and emits a
    Poseidon leaf commitment — back up the deposit record before
    broadcasting, without it the deposit cannot be withdrawn. Wait for
    the pool's anonymity set to grow, then withdraw to a fresh pubkey:
    the dApp generates a Groth16 proof of unspent-leaf membership and
    re-verifies it client-side, the worker rejects duplicate nullifiers,
    and the resulting UTXO is unlinkable to any specific deposit. Pool
    initialization is permissionless — declare a new `(asset_id,
    denomination)` pair with a verifying-key CID; the canonical
    Phase 2 ceremony bundle is hardcoded in the dapp at IPFS
    `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u`
    (2,227 community contributions + Bitcoin-block beacon, finalized
    chain). SPEC §5.10–§5.11; full status + caveats in
    [MIXER.md](./MIXER.md).
13. **Pool** *(AMM — ceremony pending)*. Uniform-clearing-price
    block-batched AMM between any two tacit assets. The Pool tab surfaces
    pool initialization, LP add/remove, and per-trade variable-amount
    swaps (`T_SWAP_VAR`). Per-trader amounts are confidential
    (BabyJubJub Pedersen + Groth16 inside `T_SWAP_BATCH`); pool reserves
    are public numbers the indexer tracks. The AMM Phase 2 ceremony is
    per-pool and not yet finalized — the dApp uses placeholder proofs
    until the ceremony CID is populated. Wire format and architecture:
    [`AMM.md`](./AMM.md); amendments in [`spec/amendments/`](./spec/amendments/).
14. **Farms** *(yield farming)*. LP-staking yield farms over AMM pool
    shares. `T_FARM_INIT` deploys a farm with a reward schedule;
    `T_LP_BOND` / `T_LP_HARVEST` stake LP shares and claim rewards.
    SPEC-AMM-FARM-AMENDMENT.
15. **Claim** *(recipient side)*. Paste the drop's merkle root + IPFS CID
    (from the issuer) → Load snapshot. The dApp fetches the JSON, refuses
    any blob whose rows don't match the root, and shows your row. Connect
    MetaMask (or any EIP-1193 provider) — the connection is purely for
    signing a canonical claim message; no Eth tx, no gas, the current
    chain doesn't matter. The signed tuple `(leaf_index, tacit_pubkey,
    eth_sig)` goes to the worker queue or straight to the issuer. When
    they fulfil, the confidential UTXO lands in your Holdings via the
    standard ECDH recovery path.

### Recovery sanity check

Open the dApp in a fresh incognito window. Import your privkey via the
Import key button. ↻ Rescan UTXOs. Your full balance — across received
transfers, your own etches, your own mints, and your change — should
reappear from chain data alone.

---

## Trust model

| What you trust                            | For what                                                                              | Mitigation if compromised                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bitcoin (signet / mainnet)                | Tx ordering, no double-spends, witness data integrity                                  | None — it's the bottom layer                                                              |
| `mempool.space` API (primary) + `blockstream.info` (watchdog) | Returning real chain data                            | A 5-min divergence watchdog cross-checks tip heights between the two endpoints; ≥3-block disagreement surfaces a top-of-page banner so a single-endpoint outage or tampering is visible. Swap either for any Esplora-compatible API by editing `NETWORKS` in `dapp/tacit.js`. |
| The dApp source (`dapp/index.html` + `dapp/tacit.js`) you loaded | Implementing the validation rules correctly                                            | Re-host, audit; pin by IPFS CID — the runtime KAT in `runStartupKAT()` is independent defense |
| `dapp/vendor/tacit-deps.min.js` (vendored) | Crypto code matching what was published                                                | Bundle is pinned alongside `dapp/index.html` and `dapp/tacit.js` under one IPFS CID; rebuild and re-pin if upstream npm packages change |
| The asset's etcher                        | *Confidential-supply assets only:* the supply they announced. *(Mintable assets:)* their use of the mint_authority key. | The dApp publishes `(supply, blinding)` to IPFS-embedded metadata by default; for attested assets supply is cryptographically verifiable from chain + IPFS alone. The "centralized-stablecoin" trust model only applies when the issuer explicitly opts out of attestation. Mintable assets retain mint-key trust regardless. |
| The in-page tacit privkey                 | Signing every tacit op (P2WPKH spend, taproot script-path, kernel sig, mint authority) — whichever path put a key in the page (auto, imported, or locally bound to an external wallet address) | **AES-GCM encrypted at rest** with a passphrase-derived key (PBKDF2-SHA256, 600k iterations); unlocked per session. Defends against localStorage exfiltration (malicious extensions, stolen unlocked devices). Export the raw privkey separately via Wallet → Export key — that's the recovery path if the passphrase is lost. Signature-derived modes (Ethereum wallet / passkey / deterministic Bitcoin wallet) persist no key at all — re-derived from the signer each session (`ops/DESIGN-eth-wallet-identity.md`). |

The Worker is a **convenience cache**, not a trust target. Setting
`WORKER_BASE = ''` disables it; the protocol still works (no auto-faucet,
no image upload, no asset directory, but every existing token still
validates and transfers correctly).

---

## Privacy scope

Tacit hides **amounts**. It does not hide:

- Address graph (sender/recipient bitcoin addresses are visible).
- Asset ID (the 32-byte asset_id is in every CXFER / T_AXFER / T_MINT / T_BURN / T_PMINT envelope).
- Sender pubkey (visible at `tx.vin[1].witness[1]` — the recipient needs it
  for ECDH blinding recovery).
- Tx graph (inputs and outputs are linkable like any UTXO chain).
- Burn amounts (T_BURN's `burned_amount` is public for auditability).

Same privacy scope as Liquid CT without surjection proofs: amount-hiding
on every transfer, with opt-in mixer for full unlinkability. Surjection
proofs for asset_id hiding are on the roadmap.

**The mixer pool (§5.10–§5.11)** layers an opt-in unlinkability primitive
on top: a holder who deposits a fixed-denomination UTXO into a pool and
later withdraws to a fresh pubkey breaks the *amount-to-address-to-amount*
link inside that pool. Pool participation itself is still public —
observers see *that* an address deposited or withdrew, just not which
deposit corresponds to which withdrawal. Phase 2 trusted setup finalized
2026-05-11 with 2,227 community contributions and a Bitcoin-block beacon.

---

## Design tradeoffs + roadmap

- **Witness size.** ~10 KB per CXFER (m=2), about 2,500–3,000 vBytes
  after the SegWit discount. The witness carries an aggregated bulletproof
  + kernel signature — the cryptographic cost of hiding amounts.
  Bulletproofs+ (`T_CXFER_BPP` / `T_AXFER_BPP`) shaves ~14%.
- **Recursive validation is O(chain depth) on cold cache.** Memoized within
  a session. A persistent validator cache is a production add for deep
  chains.
- **localStorage is the wallet — on local-key paths.** Where a path placed
  the privkey in the page (auto, imported, or locally bound to an external
  wallet address), `localStorage` is what persists it. Mainnet UX gates
  every value-creating op behind an explicit key-export acknowledgement;
  hardware-wallet integration for the protocol's signing paths (kernel sig,
  taproot script-path, HMAC-blinding) is the proper long-term mitigation but
  not yet shipped. The signature-derived modes (Ethereum wallet, passkey,
  deterministic Bitcoin wallet) sidestep this: nothing secret is persisted,
  and the signer re-derives the key each session.
- **Per-network wallet identities.** Signet and mainnet use independent
  localStorage keys (`tacit-wallet-v1:signet`, `tacit-wallet-v1:mainnet`,
  plus `:by:<extAddr>` variants when bound to a connected wallet). A
  signet test compromise does NOT blast-radius into mainnet, but it also
  means flipping networks shows a fresh empty wallet by default — the
  dApp surfaces a one-time toast on the first cross-network flip
  explaining this. Use `Import key` on the destination network to carry a
  single identity across both.
- **Lost mint key = permanent fixed supply.** No recovery mechanism for the
  mint authority. Mintable etches force a key-export step before broadcast.
- **Issuer trust** (*for confidential-supply assets only*). Pedersen hides
  the supply, so unless the issuer publishes `(supply, blinding)` there's
  nothing to verify the announcement against. The dApp ships with the
  "Publish supply opening" checkbox on by default — the opening is embedded
  into the asset's IPFS metadata blob (content-addressed, worker-
  independent) and also POSTed to the worker's `/attest` cache for fast
  Discover paint. Issuers who want the centralized-stablecoin trust model
  uncheck the box explicitly. Mints are auto-attested by default too (per-
  asset opt-out via `localStorage`). For attested non-mintable assets,
  total supply is provably and permanently public.
- **Single-asset transfers only.** No multi-asset CXFER (e.g.,
  USDA ↔ GOLDC swap in one envelope). The wire format would need a new
  opcode (e.g., `T_CXFER_MULTI`) with per-asset kernel sigs sharing one
  aggregated bulletproof. Follow-up territory.
- **Atomic intent fulfilment window.** Makers fulfil within a 5-min claim
  window after a taker locks. The `fulfiller/` directory provides an
  auto-fulfilment service for market-maker automation.
- **Abandoned commits aren't auto-reclaimed.** If an atomic intent
  expires unclaimed, the commit P2TR sits unspent on chain. The maker can
  reclaim manually by spending it via the script-path with the envelope as
  the leaf — the dApp doesn't yet expose a one-click button for this. Cost:
  the commit tx fee (~$0.10–1 mainnet).
- **T_PMINT reorg sensitivity.** Cap correctness for fair-launch
  (T_PETCH-rooted) assets requires complete, canonically-ordered T_PMINT
  history, so the indexer only credits a mint at confirmation depth ≥ 3. Wallets
  surface "pending" T_PMINT UTXOs as non-spendable until the depth
  threshold crosses. A reorg below depth 3 may revoke a previously-
  credited T_PMINT under new canonical ordering — indexers re-run the
  cap check on reorg. CETCH+T_MINT assets are unaffected (credit there
  depends only on the issuer's signature, not aggregate chain state).
  SPEC §5.9 + §10.
- **Reference-indexer KV.list cap.** The reference worker uses a single
  un-paginated `KV.list({ limit: 1000 })` in three places: per-asset
  `loadCanonicalPmints`, `/pools` aggregate counts, and
  `/pools/:asset_id/:denom` leaf + nullifier lists. Assets accruing more
  than 1000 T_PMINTs will under-count `cumulative_minted`; pools with
  more than 1000 deposits or withdrawals will return truncated state to
  clients consuming the worker view. Practical for now; larger schedules
  need pagination patches. The cap is operational, not cryptographic —
  the dapp's local `scanPools` reconstructs from chain regardless, so a
  worker truncation degrades freshness/UX, not soundness.
- **Mixer pool — production, Phase 2 finalized.** The shielded-pool wire
  format (`T_DEPOSIT` / `T_WITHDRAW`, SPEC §5.10–§5.11), worker indexing
  (`/pools`, canonical leaf order, nullifier set, reorg-safety depth
  gate), browser-side Groth16 prover + verifier (snarkjs vendored at
  `dapp/vendor/tacit-mixer.min.js`), Phase 2 ceremony coordinator (init
  / contribute / finalize), client-side `verifyFromInit` walk, and
  indexer rejection-path determinism are all shipped (150+ mixer tests
  across 10 files). Phase 1 ptau is the verified Polygon Hermez ceremony
  output, dual-hash-checked at build. Phase 2 was run publicly via the
  coordinator: 2,227 community contributions + Bitcoin-block-948824
  beacon (10 MiMC iterations), finalized 2026-05-11. The canonical
  bundle is pinned to IPFS at
  `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u` and
  hardcoded in the dapp as the trust anchor every pool init binds to.
  Full status + bundle contents: [MIXER.md](./MIXER.md).
- **Lost mixer note = permanent inaccessibility of the deposit.**
  `T_WITHDRAW` requires the depositor's `(secret, ν)` pair, generated
  by CSPRNG at deposit time and not derivable from chain alone. The
  dApp gates first deposits behind a note-export step and offers
  deposit-record export/import; deterministic `(secret, ν)` derivation
  from privkey is a future UX improvement. Same out-of-band-backup
  posture as Tornado / Privacy Pools.

---

## Future directions

Beyond the current dApp surface, the protocol opens onto several further
extensions. Wrapped BTC landed as the cBTC.zk / cBTC.tac amendments;
tETH landed as the trustless ETH-Bitcoin bridge
([`BRIDGE.md`](./BRIDGE.md), [`contracts/`](./contracts/)). See
[`spec/amendments/`](./spec/amendments/) for the normative specs.
What follows is what's still in flight.

### Receiver privacy — shipped for tacit tokens (CXFER)

Tacit's **shielded address** primitive (SPEC-BLINDED-PUBKEY amendment, class-2)
shipped for CXFER in production. Recipients publish a `tcs1…` / `tcsts1…` /
`tcsrt1…` bech32m address that opaquely encodes their pubkey. Senders who
paste that handle into the recipient field produce per-tx-unique on-chain
markers — `P2WPKH(hash160(commit))` where `commit = recipient_pubkey + b·G`
and `b = HMAC(ECDH(sender_priv, recipient_pub) || domain || tx_anchor || vout)`.
No recurring on-chain address links one payment to the next; observers see
a fresh recipient address on every receipt.

```
recipient publishes: tcs1<bech32m(recipient_pubkey)>     (one static handle)
sender derives:      shared = ECDH(sender_priv, recipient_pub)
                     b      = HMAC(sha256(shared.x), domain || network || tx_anchor || vout)
                     commit = recipient_pubkey + b·G
                     CXFER vout[0] → P2WPKH(hash160(commit))
recipient scans:     trial-derive commit for each eligible tx output;
                     match → tweaked_sk = recipient_priv + b mod n
```

The ECDH shared secret is reused for both pubkey-blinding (new) and the
existing amount-keystream (so no extra ECDH cost on the sender). Cryptography
is BIP-340 / BIP-341 family; no new ceremony. Recipient-side discovery uses
the worker's per-asset `xferseen` index — bounded scan, not the every-block
walk BIP-352 requires.

**Receiver privacy for plain BTC sats — BIP-352 Silent Payments (deferred).**

BIP-352 solves the same problem for plain bitcoin (not just tacit tokens).
A separate ceremony from the tacit shielded-address scheme: two-key wallet
(scan + spend), every-block scanner on the receiver side, P2TR(tweaked)
output type. The shielded-address scheme above doesn't apply to plain sats
because the receiver-side discovery corpus is bounded by tacit's xferseen
index — for sats there is no equivalent bounded corpus, so recipients would
need to walk every Bitcoin tx. That's BIP-352's job.

**Defer until** BIP-352 wallet adoption converges. Cake, Sparrow, Silentium
ship native support; once 5+ wallets ship and a public silent-payment
indexer landscape stabilizes, integration shifts from "invent a tacit-
flavored stealth-sats scheme" (which would compete with the standard) to
"use the standard." Likely 6–12 months out. Tacit users who want plain
shielded sats today route through the **mixer pool** (T_DEPOSIT / T_WITHDRAW,
live in production) for full anonymity-set unlinkability — a stronger
posture than BIP-352's per-payment unlinkability against a sophisticated
graph analyst.

### Asset_id privacy via Asset Surjection Proofs (ASPs)

Hide **which token** is moving. Currently every CXFER envelope publishes
the `asset_id` cleartext; an observer who looks up the asset in Discover
sees "this is a USDA transfer." ASPs replace the universal Pedersen value
generator `H` with a per-asset blinded generator `H_a`, and add a
ring-signature-style ZK proof that the output uses one of the input
assets' generators — without revealing which.

```
current commitment:  C = a·H + r·G          (universal H, asset_id cleartext)
ASP commitment:      C = a·H_a + r·G        (per-asset H_a derived from asset_id)
ASP envelope:        surjection_proof(33B + ~1.5KB) — proves output asset ∈ input assets
```

This is the Liquid CT mechanism. `libsecp256k1-zkp` has the reference
implementation we'd port, alongside whatever bulletproof migration we end
up doing for the witness-size story.

**Forward-compat for existing tokens: partial.**
- ✓ **Spendability is forever.** Existing tokens continue to work via the
  existing `CXFER` opcode against the universal `H`. The validator handles
  both opcodes (`CXFER` for current, `T_CXFER_PRIV` for ASP-enabled)
  interchangeably as ancestors of any future descendant.
- ✗ **No automatic privacy upgrade.** Current commitments use universal
  `H`; the math doesn't bridge. To gain ASP privacy, holders go through
  a burn-and-remint redemption — issuer of a mintable token offers a 1:1
  exchange. Same pattern Liquid uses for asset migrations. Etch mintable
  today if you want issuer-side optionality for a redemption flow later.

**Effort: ~6–8 weeks engineering.**

| Component | LOC | Time |
|---|---|---|
| Per-asset H_a derivation | ~100 | 2 days |
| Surjection prover + verifier (port from libsecp256k1-zkp) | ~700 | 3 weeks |
| Wire format + new opcode `T_CXFER_PRIV` | ~200 | 1 week |
| Validator + recovery + indexer changes | ~400 | 2 weeks |
| Tests + adversarial cases | ~500 | 2 weeks |

**Tradeoff vs current baseline.**
- **Privacy gain:** all transfers across all assets become
  indistinguishable at the asset-type level. Stablecoin issuer can no
  longer be pattern-matched ("USDV is moving 10× more than DAIA today");
  treasury holdings of which asset stay private.
- **Witness size grows ~1.5–2 KB** per CXFER → ~30–35k sats/tx at 10 sat/vB
  on mainnet, vs. ~25–30k sats today.
- **Recovery is slower:** the recipient no longer reads `asset_id` from
  the envelope cleartext; they trial-decrypt against asset_ids they know
  about. Acceptable for wallets holding 1–10 assets, slower for "scan
  every asset_id in the registry."
- **Marketplace listings have to publish asset_id cleartext** — listings
  inherently expose the asset (otherwise buyers can't filter). So ASPs
  hide *transfers* in the wild; they don't hide *listings*.

**Defer until.** A real issuer asks for asset_id privacy as a launch
requirement (for a privacy-focused stablecoin, mining-pool payouts, or
multi-asset market-maker desks who don't want flow-pattern leaks). Until
then the privacy axis most issuers actually want — and that the dApp
already provides — is amount privacy on transfer. The discovery channel
for ASPs is "first issuer who explicitly asks"; until then, building it
is speculative.

**Etching today is safe regardless.** Use mintable etches (with multisig
mint authority once we ship that UX, single-key today as a tradeoff) if
you want to leave the door open to offer a redemption later. Fixed-
supply etches stay on the current commitment scheme — they keep amount
privacy, they just don't gain asset_id privacy
later. For tokens treated as a public brand (most stablecoin / treasury
cases), this is no loss.

---

## Cloudflare Worker (optional but recommended for demos)

The Worker holds three secrets — `PINATA_JWT`, `FAUCET_PRIV` (signet only),
and the configured CORS allowlist. It exposes:

| Endpoint                          | Method | Purpose                                                            |
| --------------------------------- | ------ | ------------------------------------------------------------------ |
| `/pin`                            | POST   | Image upload to IPFS via Pinata                                    |
| `/pin-json`                       | POST   | Metadata-blob pin (used when etching with description / URL)        |
| `/pin-mixer-vk`                   | POST   | Pin a snarkjs Groth16 verifying-key JSON (mixer ceremony output)    |
| `/pin-airdrop-snapshot`           | POST   | Pin a tacit-airdrop-v1 snapshot JSON (≤16 MB, ≤100k rows)           |
| `/drip`                           | POST   | Send 20K signet sats to `{address}` — 1/IP/day, 1/addr/day         |
| `/balance`                        | GET    | Faucet wallet's signet balance + funding address                   |
| `/assets`                         | GET    | List of all etched assets + per-asset mint history (cron-populated) |
| `/assets/:id`                     | GET    | Single asset metadata + mint events + burn events                   |
| `/assets/hint`                    | POST   | Targeted index of a freshly broadcast envelope (CETCH, T_MINT, T_BURN, T_PETCH, T_PMINT) so it surfaces in `/assets` or `/petch-assets` immediately, pre-confirmation |
| `/assets/:id/attest`              | POST   | Discovery cache for etch attestation. Worker re-verifies `C == supply·H + r·G` before storing. **Primary** distribution is the IPFS metadata blob at the envelope's `image_uri` — see SPEC §7.3; this endpoint is just a cache for fast Discover paint. |
| `/assets/:id/mints/:txid/attest`  | POST   | Same shape, for T_MINT events. dApp auto-attests by default. |
| `/assets/:id/openings`            | GET    | List per-UTXO `(amount, blinding)` openings holders have voluntarily published (cache-only, optional). |
| `/utxos/:txid/:vout/opening`      | GET / POST | Single-UTXO opening: GET fetches; POST publishes (worker re-verifies BIP-340 sig + `pedersenCommit(amount, blinding) == on-chain commitment` before storing). |
| `/petch-assets`                   | GET    | T_PETCH-rooted asset registry — same envelope shape as `/assets` plus per-asset `cap_amount`, `mint_limit`, `mint_start_height`, `mint_end_height`, `cumulative_minted` (depth ≥ 3), and `mints_remaining`. SPEC §5.8. |
| `/petch-assets/:id`               | GET    | Single T_PETCH asset metadata + cap progress. |
| `/assets/:id/pmints`              | GET    | Confirmed T_PMINT events for a T_PETCH-rooted asset, in canonical (height, tx_index) order. Each entry carries `depth` and `status: 'credited' \| 'pending' \| 'revoked'`. SPEC §5.9. |
| `/assets/:id/disclosures`         | GET / POST | Range disclosures (`balance ≥ K` proofs) per SPEC §5.6. Worker verifies Schnorr sig + on-chain ownership before storing; consumers MUST re-verify the bulletproof client-side. |
| `/assets/:id/listings`            | GET / POST | Per-UTXO marketplace listings (opening-based). Worker stores listing terms + opening proof; settlement is OTC. |
| `/assets/:id/listings/:txid/:vout`             | DELETE | Maker cancels a listing (signed). |
| `/assets/:id/listings/:txid/:vout/claim`       | POST   | Taker locks a listing for 5 min so two takers can't both pay. |
| `/assets/:id/listings-range`      | GET / POST | Range-disclosed listings (`balance ≥ K`). Maker proves a lower bound on their balance without revealing the exact amount; other UTXOs stay confidential. OTC settlement, same as above. |
| `/assets/:id/listings-range/:owner_pubkey`     | DELETE | Maker cancels (signed). |
| `/assets/:id/listings-range/:owner_pubkey/claim` | POST   | Taker locks (5 min). |
| `/assets/:id/atomic-intents`      | GET / POST | Atomic intents — trustless single-Bitcoin-tx settlement (SPEC §5.7.6). Maker pre-broadcasts a commit tx + posts intent metadata; the recipient blinding stays on the maker's device. Browse-and-take. |
| `/assets/:id/atomic-intents/:intent_id`        | DELETE | Maker cancels (signed). |
| `/assets/:id/atomic-intents/:intent_id/claim`  | POST   | Taker locks for 5 min (signed; binds a specific funding UTXO ≥ price_sats — proof-of-funds gate). |
| `/assets/:id/atomic-intents/:intent_id/fulfilment` | GET / POST | Maker uploads a partial reveal targeted at the claimant's pubkey (signed) **plus the recipient blinding ECDH-encrypted to the claimant**. Taker fetches, decrypts, and broadcasts atomically. |
| `/assets/:id/bid-intents`         | GET / POST | Bid intents (buyer-initiated mirror of atomic intents — SPEC §5.7.7). Buyer publishes "I'd buy N units at P" off-chain; sellers spin up an atomic intent targeted at the bidder when they decide to accept. No on-chain lock at bid time. |
| `/assets/:id/bid-intents/:bid_id` | GET / DELETE | Fetch a single bid (with claim if any) / bidder cancels (signed). |
| `/assets/:id/bid-intents/:bid_id/claim` | POST | Seller locks a bid for 30 min, attaches the `axintent_id` of the freshly-published seller intent. |
| `/drops`                          | GET / POST | Drop announcements — discovery layer for airdrops. Issuer publishes `(merkle_root, IPFS CID, asset_id, ticker)` so claimants can find live drops. Lives entirely outside the on-chain protocol. |
| `/drops/:root`                    | GET / DELETE | Single drop announcement / issuer cancels (signed). |
| `/airdrops/:root/claims`          | GET / POST | Airdrop claim queue keyed by merkle root. Recipients POST `(leaf_index, tacit_pubkey, eth_sig)` tuples; issuers GET to pull batches and broadcast fulfilment CXFERs. Worker validates format only — it has no snapshot to verify against. Lives entirely outside the on-chain protocol; canonical truth is the resulting CXFER set. |
| `/airdrops/:root/claims/:leaf_index` | DELETE | Removes a queued claim. Unauthenticated by design (the queue is convenience, not authority — re-submission is also unauth, "latest wins"). |
| `/pools`                          | GET    | List initialized mixer pools (SPEC §5.10.1) with per-pool leaf and nullifier counts. dApp consumes this on Mixer-tab open. |
| `/pools/:asset_id/:denom`         | GET    | Full per-pool state — POOL_INIT record, all deposit leaves in canonical chain order (the order the dApp must apply to reproduce the merkle root), and the spent-nullifier set. |
| `/assets/:id/preauth-sales`       | GET / POST | Buyer-completable preauth sales (SPEC §5.7.8). Seller signs once; buyer completes later. |
| `/assets/:id/preauth-sales/:sale_id` | GET / DELETE | Single preauth sale / signed cancel. |
| `/farms`                          | GET    | List yield farms (`?pool=:pool_id` to filter by pool). |
| `/farm/:farm_id`                  | GET    | Single farm state with post-crystallization view. |
| `/farm/:farm_id/bonds`            | GET    | Bonds owned by a pubkey (`?bonder=:pubkey`). |
| `/bridge/eth-roots`               | GET / POST | Ethereum merkle roots for tETH bridge verification. |
| `/scan`                           | POST   | Manual scan trigger (debug)                                        |
| `/rescan`                         | POST   | Rewind `meta:last_scanned` to a given height (debug, `?from=<h>`)   |
| _scheduled_                       |        | `*/5 * * * *` — scan recent signet AND mainnet blocks for CETCH, T_CXFER, T_MINT, T_BURN, T_AXFER, T_PETCH, T_PMINT, T_DEPOSIT, T_WITHDRAW, T_BRIDGE_DEPOSIT, T_BRIDGE_BURN, T_BRIDGE_ROTATE, T_BRIDGE_EXPORT, T_BRIDGE_IMPORT envelopes |

Setup steps live in `worker/README.md`. Deploy your own (and update
`WORKER_BASE` in `dapp/tacit.js`) if you want isolated keys / quota.

---

## Cryptography credits

- Pedersen commitments + Mimblewimble kernel sigs — Maxwell,
  Poelstra, Jedusor.
- Aggregated Bulletproofs — Bünz, Bootle, Boneh, Poelstra, Wuille,
  Maxwell (2017).
- BIP-340 Schnorr / BIP-341 Taproot — Wuille, Nick, Towns.
- Tornado-style Poseidon-Merkle anonymity set + nullifier scheme —
  Pertsev, Storm, Semenov; Tornado.cash team (2019). Tacit's
  `withdraw.circom` adapts theirs; cBTC.zk's slot semantics reuse
  it without modification (see [`spec/CIRCUITS.md`](./spec/CIRCUITS.md)).
- Groth16 zk-SNARK over BN254 — Groth (2016); Phase 1 inherited
  from the Polygon Hermez ceremony.
- BabyJubJub (embedded curve over BN254 Fr) + Camenisch–Stadler
  sigma cross-curve binding — used for the AMM's amount-
  confidentiality circuits.
- Uniform-clearing-price batch auctions — Walras (1874); Gnosis
  Protocol (2019); Penumbra ZSwap (2023).
- Constant-product AMM curve — Uniswap V2 (2020); Bancor (2017).
- The "indexer-validated meta-protocol" framing comes from
  Runes / Ordinals; tacit is the same trust model applied to a
  wider surface (confidential value, anonymous spend, native AMM,
  trustless wrapped BTC).
- All primitives come from [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1)
  and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes),
  with [snarkjs](https://github.com/iden3/snarkjs) +
  [circomlib](https://github.com/iden3/circomlib) for the Groth16
  proving/verification path.

---

## License

See `LICENSE`.
