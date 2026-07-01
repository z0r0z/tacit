<p align="center">
  <img src="./assets/tacit.svg" alt="tacit" width="120">
</p>

# tacit

**A confidential DeFi layer rooted on Bitcoin.** Tacit scales the
Runes/Ordinals indexer-validated pattern past plain tokens — to
confidential value, anonymous spend, a native AMM, an atomic marketplace,
and trustless wrapped BTC. Token rules are enforced by indexers anyone can
run, each reaching the same verdict from the chain alone; cryptography does
the work a smart-contract VM does elsewhere.

**v1 extends the same confidential note onto an Ethereum lane** by
trustless zero-knowledge reflection: one note across both chains, a
confidential pool, a confidential dollar (cUSD), and gasless settlement —
with no federation, sidechain, or multisig bridge.

> **Status:** signet + mainnet. Sign in with an Ethereum wallet, a passkey,
> Xverse / UniSat / Leather, import a privkey, or — on signet — let the
> dApp generate one and grab faucet sats. The Bitcoin↔Ethereum bridge is
> live as a gated pilot (small fixed deposits) while limits widen.
>
> **Live demo:** [tacit.finance](https://tacit.finance)
>
> **Security:** multiple independent reviews (GPT-5.5 Pro · Claude Opus 4.8
> Max), no fund-critical findings — reports + responses in [`audit/`](./audit/AUDITS.md).
>
> **Protocol specs:**
> [`SPEC.md`](./SPEC.md) — canonical wire-format authority ·
> [`AMM.md`](./AMM.md) — confidential AMM architecture ·
> [`MIXER.md`](./MIXER.md) — Bitcoin mixer (secondary privacy option) ·
> [`BRIDGE.md`](./BRIDGE.md) — legacy tETH bridge (sunset; recovery only) ·
> [`spec/CIRCUITS.md`](./spec/CIRCUITS.md) — how the ZK stack composes ·
> [`spec/GLOSSARY.md`](./spec/GLOSSARY.md) — cross-surface terms ·
> [`spec/amendments/`](./spec/amendments/) — cBTC, cUSD, pool, reflection, farms, governance ·
> [`whitepaper/`](./whitepaper/WHITEPAPER.pdf) — the technical whitepaper.
>
> **Deployed contracts:**
> [`docs/DEPLOYMENTS.md`](./docs/DEPLOYMENTS.md) — immutable mainnet addresses
> (Etherscan-verified) · [`contracts/deployments/1.json`](./contracts/deployments/1.json) — machine-readable manifest.

---

## What it is

The trick is the same one Runes and Ordinals use: token rules aren't
enforced by Bitcoin nodes, they're enforced by open-source indexers, and
because the rules are deterministic every indexer reaches the same verdict
from chain data alone. No federation, no consensus change. Tacit applies
that to a much wider surface — and v1 carries the resulting confidential
note onto a second chain. The two parts:

**The Bitcoin core:**

- **Confidential value.** Amounts are hidden on every transfer, yet supply
  still provably balances — via Pedersen commitments, aggregated
  bulletproofs, and a Mimblewimble-style kernel signature.
- **Anonymous spend.** Break the link between two of your own UTXOs: deposit
  into a fixed-denomination mixer pool and withdraw to a fresh address, with
  no on-chain edge connecting them (Groth16 + Poseidon-Merkle + nullifiers).
  This is the *secondary*, Bitcoin-only privacy option; the cross-chain
  confidential pool below is the primary, amount-flexible one.
- **Native AMM + farms.** A uniform-clearing-price, block-batched AMM
  between any two tacit assets, with confidential per-trader amounts and
  LP-staking farms. Pool reserves are public numbers the indexer tracks;
  no UTXO holds any pool's funds. The trusted-setup ceremony is sealed and
  its artifacts are published.
- **Trustless wrapped BTC.** `cBTC.zk` locks real BTC at a Taproot output
  whose spending key is derived from a mixer leaf's own secret — one leaf,
  two locks, no federation and no co-signer.
- **Atomic marketplace.** Atomic OTC settlement of a confidential token
  against a BTC payment in one Bitcoin tx (`T_AXFER`), variable-amount
  partial fills (`T_AXFER_VAR`), and buyer-offline preauthorized bids
  (`T_PREAUTH_BID_VAR`) for walk-away flow. No MEV by construction.
- **Fair-launches + drops.** `T_PETCH` / `T_PMINT` for permissionless-mint
  assets with publicly auditable caps; `T_DROP` / `T_DCLAIM` for ETH-gated
  claim pools; batched confidential CXFER airdrops for issuer distributions.

**The v1 Ethereum lane:**

- **One note, two chains.** A wrap on Bitcoin, or a wrap through the
  Ethereum-side `ConfidentialRouter`, produces the same shielded note — a
  secp256k1 Pedersen note spendable by knowledge of its blinding. From
  there it transfers, trades, borrows, or exits on either side. The
  Ethereum-lane pool is setup-free (Bulletproofs+ and SP1, no ceremony).
- **Trustless cross-chain reflection.** Value crosses by burn→mint under
  conservation: an SP1 proof reflects a burn on one chain as exactly one
  matching mint on the other, with a one-time nullifier, full provenance
  to a real supply leaf, and a reorg-finality gate. No multisig, no
  attestor set, no wrapped-asset IOU.
- **Fungible wrapped BTC (`cBTC.tac`).** A fungible claim on real BTC held
  in `cBTC.zk` locks — a **trustless, oracle-free conservation peg** (total
  cBTC.tac ≤ total live locked sats, by construction; no price in the mint
  path). `tacBTC` is its ERC-20 form. The only residual trust is BTC
  custody, covenant-upgradeable to fully trustless (a covenant vault is the
  endgame; a protocol/MPC vault plus an Ethereum insurance backstop is the
  launch posture).
- **cUSD — a confidential dollar.** Borrow the protocol's own
  over-collateralized stablecoin against a shielded note, with both the
  collateral and the debt hidden (Pedersen-committed positions, proven
  healthy in zero knowledge, MakerDAO-style rate accumulator + liquidation
  ratio; stability fee shipped dormant). This is the oracle-priced CDP that
  cBTC.tac deliberately is *not*.
- **Gasless by relay.** Any op can be settled by a relayer, with the fee
  bound inside the conservation kernel — the relayer can pay gas and take
  its fee but cannot redirect a payout or pad the fee. You never need the
  settlement chain's gas token to move value.
- **One unified address.** A single `tacit1…` address resolves to your
  Bitcoin or shielded-Ethereum endpoint, so a sender doesn't need to know
  which lane you're on.

See [`spec/CIRCUITS.md`](./spec/CIRCUITS.md) for how the Groth16 circuit
families (Bitcoin side) and the Bulletproofs+/SP1 stack (Ethereum lane)
compose across these surfaces.

**What tacit doesn't do:**

- Hide the address graph (sender/recipient Bitcoin addresses are visible —
  same as every Bitcoin-substrate protocol).
- Hide the asset ID (which token is moving is public; surjection proofs are
  a follow-up).
- Run general-purpose code. There is no Turing-complete VM: the protocol
  grows by adding opcodes and circuits, and the Ethereum lane is a
  verifier-gated reflection surface, not a runtime for arbitrary contracts.
- Eliminate issuer trust for confidential-supply assets unless the issuer
  publishes `(supply, blinding)`. The dApp publishes by default; opt-out is
  explicit.

---

## How tacit compares

| | Substrate | Validity | Amounts | AMM | Trustless wBTC | Federation |
|---|---|---|---|---|---|---|
| Ordinals / BRC-20 | Bitcoin | Indexer | Public | — | — | None |
| Runes | Bitcoin | Indexer | Public | — | — | None |
| RGB / Taproot Assets | Bitcoin (anchor) | Off-chain client-side proofs | Hidden / partial | — | — | None |
| Liquid CT + AMM | **Federated sidechain** | Sidechain consensus | Hidden | Yes | — | **15-of-N** |
| Citrea / Botanix / rollups | Bitcoin (rollup) | Operator / fraud proofs | Varies | Yes | Varies | Operator set |
| **tacit** | **Bitcoin (+ ETH lane)** | **Indexer + ZK proofs** | **Hidden** | **Native** | **Yes (cBTC)** | **None** |

What tacit does that nothing else does in one stack:

- **Confidential fungibles on Bitcoin proper.** Liquid CT uses the same
  Pedersen + Bulletproof primitives but lives on a federated sidechain.
  Every tacit CXFER is a Bitcoin tx, every UTXO a Bitcoin UTXO.
- **Native AMM on Bitcoin L1.** Uniform-clearing-price, block-batched, with
  confidential per-trader amounts — no L2, rollup, or smart-contract
  runtime. Sidechain/rollup AMMs inherit federation or operator trust;
  tacit has neither.
- **Trustless wrapped BTC.** `cBTC.zk` locks BTC at a key derived from a
  mixer note's own secret (no federation, co-signer, or oracle); `cBTC.tac`
  makes it fungible as an oracle-free conservation peg on real locked BTC.
  WBTC/tBTC/RBTC are federated or threshold-bonded.
- **Trustless cross-chain without a bridge multisig.** Bitcoin↔Ethereum
  value moves by SP1 reflection (burn→mint, one-time, provenance-checked),
  not a signing committee.
- **No off-chain proof exchange.** RGB / Taproot Assets push validity
  off-chain (lose the proof, lose the balance). Tacit keeps everything
  on-chain; a wallet recovers full state from privkey + chain alone.

Not in scope: on-chain inscriptions (tacit pins media to IPFS and carries
only a URI on-chain) and Lightning-native assets (tacit is on-chain only).

---

## Architecture in one screen

Two Groth16 circuit families and a uniform out-of-circuit toolkit do the
Bitcoin-side cryptographic work; the indexer does the accounting; Bitcoin
holds the data. The Ethereum lane reaches the same note format through a
setup-free Bulletproofs+/SP1 stack.

```
                  Bitcoin L1 (substrate)
                          │
       ┌──────────────────┴───────────────────┐
       │      indexer-validated rules          │
       │   (same trust model as Runes; any     │
       │    party reaches the same verdict      │
       │    from chain data alone)              │
       └──────────────────┬───────────────────┘
                          │
       ┌──────────────────┴───────────────────┐
       │  out-of-circuit cryptographic stack   │
       │   secp256k1 Pedersen · bulletproofs   │
       │   BIP-340 Schnorr · 169-byte sigma    │
       │   cross-curve binding (secp ↔ BJJ)    │
       └─────┬─────────────────────────┬───────┘
             │                         │
       ┌─────┴─────┐             ┌─────┴─────┐
       │ withdraw  │             │    AMM    │
       │ .circom   │             │ circuits  │
       │ Poseidon  │             │ BabyJubJub│
       │ leaf +    │             │ Pedersen +│
       │ Merkle +  │             │ range +   │
       │ nullifier │             │ AMM logic │
       └─────┬─────┘             └─────┬─────┘
   anonymous-spend                amount-confidentiality
       │                                │
   ┌───┴────┐                   ┌───────┴────────┐
   │ mixer  │                   │ T_LP_ADD/REMOVE│
   │ pool   │                   │ T_SWAP_BATCH   │
   │ cBTC.zk│                   │ T_SWAP_VAR (*) │
   │ slots  │                   │ T_SWAP_ROUTE   │
   └────────┘                   └────────────────┘
                          │
       ┌──────────────────┴───────────────────┐
       │  Ethereum lane (setup-free)           │
       │   secp256k1 note · Bulletproofs+ ·    │
       │   SP1 reflection · ConfidentialPool   │
       │   → cBTC.tac · cUSD · gasless relay   │
       └───────────────────────────────────────┘

(*) T_SWAP_VAR uses no Groth16 — Pedersen + bulletproof + kernel sig only.
    Circuits are used where confidentiality is load-bearing and skipped
    where amounts can be public.
```

Full primitive-by-primitive walkthrough: [`spec/CIRCUITS.md`](./spec/CIRCUITS.md)
(single-image version: [`tacit-circuits.svg`](./assets/tacit-circuits.svg)).

---

## Privacy & trust

Tacit hides **amounts**. It does not hide the address graph (Bitcoin
addresses are visible), the asset ID (the 32-byte `asset_id` is in every
non-pool envelope), the sender pubkey (needed for ECDH blinding recovery),
the tx graph, or `T_BURN`'s public `burned_amount`. Same scope as Liquid CT
without surjection proofs, plus opt-in unlinkability.

Two unlinkability surfaces, in order of generality:

- **Confidential pool (primary).** The cross-chain shielded pool holds any
  amount as one note, needs no trusted setup, and is where DeFi lives
  (transfer, swap, borrow, bridge).
- **Bitcoin mixer (secondary).** Bitcoin-only, fixed-denomination, with its
  own trusted setup — for value that never leaves Bitcoin. Deposit a
  fixed-denomination UTXO, withdraw to a fresh pubkey; pool participation is
  public, but which deposit maps to which withdrawal is not. Phase 2
  ceremony finalized with 2,227 contributions and a Bitcoin-block beacon
  (details in [`MIXER.md`](./MIXER.md)).

The code has had multiple independent security reviews (GPT-5.5 Pro and
Claude Opus 4.8 Max) with **no fund-critical findings**; every report and
maintainer response is committed in [`audit/`](./audit/AUDITS.md).

| What you trust | For what | Mitigation if compromised |
| --- | --- | --- |
| Bitcoin (signet / mainnet) | Tx ordering, no double-spends, witness integrity | None — it's the bottom layer |
| Ethereum (for the lane) | Settlement + finality of Ethereum-side ops; SP1 verifier soundness | The reflection bridge acts only on source blocks past a reorg-finality depth; an SP1 proof, not a committee, authorizes each mint |
| `mempool.space` (primary) + `blockstream.info` (watchdog) | Returning real chain data | A 5-min divergence watchdog cross-checks tip heights; ≥3-block disagreement surfaces a banner. Swap either for any Esplora-compatible API in `NETWORKS` |
| The dApp source you loaded | Implementing the validation rules correctly | Re-host / pin by IPFS CID; the runtime KAT in `runStartupKAT()` is independent defense |
| `dapp/vendor/tacit-deps.min.js` | Crypto code matching what was published | Bundle is pinned alongside `index.html` + `tacit.js` under one IPFS CID; rebuild + re-pin if upstream npm changes |
| The asset's etcher | *Confidential-supply assets only:* the announced supply; *(mintable):* their mint_authority key | The dApp publishes `(supply, blinding)` by default → attested supply is verifiable from chain + IPFS alone; opt-out is explicit |
| cBTC.tac BTC custody (launch) | That locked sats aren't moved out of redemption | Bounded, insured by the (TAC, tETH) backstop, and covenant-upgradeable to no-trust; the peg itself is conservation, so a custody failure can't mint unbacked cBTC.tac |
| The in-page tacit privkey | Signing every tacit op | AES-GCM encrypted at rest (PBKDF2-SHA256, 600k iters), unlocked per session. Export the raw privkey via Wallet → Export key. Signature-derived modes (ETH wallet / passkey / deterministic BTC wallet) persist no key — re-derived each session |

The Worker is a **convenience cache**, not a trust target. Setting
`WORKER_BASE = ''` disables it; the protocol still validates and transfers.

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

CORS is allowlisted for `http://localhost:8000`, `:3000`, `127.0.0.1:8000`,
and `null` (`file://`) in the deployed Worker, so local dev hits the live
endpoints out of the box.

### Hosted

Pin the `dapp/` directory to IPFS, or drop it on Cloudflare Pages, GitHub
Pages, Vercel, or any static host. No env vars or build flags — the Worker
URL and IPFS gateway are set at the top of the script:

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

1. **Sign in / set up a wallet.** Connect an Ethereum wallet
   (MetaMask / Rabby / Rainbow — identity derived from one deterministic
   `personal_sign`, recover by reconnecting), a passkey (WebAuthn PRF), a
   Bitcoin wallet (Xverse / UniSat / Leather), import a 64-hex privkey, or
   let the dApp auto-generate one (handy for signet). On local-key paths the
   privkey is AES-GCM-encrypted at rest; **export it** via Wallet → Export
   key — that's the recovery path. See `ops/DESIGN-eth-wallet-identity.md`.
2. **Get funds.** On signet, click ⚡ Demo drip. On mainnet, **Top up tacit**
   funds from your external wallet, or send sats to your tacit address.
3. **Etch / mint.** Pick ticker, supply, decimals (0–8), optional image/metadata
   (pinned to IPFS). Mark **Mintable** to allow later issuance under the
   etcher key. Two txs (commit + reveal). Burn destroys supply with a public
   `burned_amount` for auditability.
4. **Fair-launch (`T_PETCH` / `T_PMINT`).** Deploy a capped, permissionless-mint
   asset (the deploy creates zero tokens); anyone mints a tranche later.
   Cumulative supply and per-mint status are public; mints credit at depth ≥ 3.
5. **Transfer.** Pick an asset, paste the recipient's pubkey (or a `tacit1…`
   unified address), enter an amount. The recipient auto-discovers the balance
   via the on-chain encrypted-amount field.
6. **Confidential pool (primary).** Wrap value from Bitcoin or Ethereum into
   one shielded note, then transfer, swap, borrow against it, or exit on
   either side. Cross-chain moves settle by trustless SP1 reflection, and any
   op can be relayed **gaslessly**.
7. **DeFi — cUSD & cBTC.** Borrow cUSD against a shielded note (collateral and
   debt both hidden), or mint cBTC.tac against a self-custody Bitcoin lock at
   the oracle-free 1:1 peg.
8. **Trade.** A confidential AMM (swap + multi-hop route + LP), an atomic
   marketplace (OTC `T_AXFER`, variable-amount `T_AXFER_VAR`, buyer-offline
   `T_PREAUTH_BID_VAR`), and LP-staking **farms** (`T_FARM_INIT` /
   `T_LP_BOND` / `T_LP_HARVEST`). Take + Verify run full client-side
   validation before any commitment. The AMM ceremony is sealed; artifacts
   are published (Docs → Ceremony artifacts).
9. **Bitcoin mixer (secondary).** For value that stays on Bitcoin: deposit a
   fixed-denomination UTXO, back up the deposit record, then withdraw to a
   fresh pubkey under a Groth16 unspent-leaf proof. SPEC §5.10–§5.11.
10. **Drops / Claim.** Issuers run batched 1:N confidential CXFER airdrops
    from snapshot CSVs (Merkle-committed, ETH-sig-gated); recipients load the
    root + CID, sign a claim, and the UTXO lands via ECDH recovery.

### Recovery sanity check

Open the dApp in a fresh incognito window, Import your privkey, ↻ Rescan
UTXOs. Your full balance — received transfers, your etches, your mints, your
change, and your shielded-pool notes — should reappear from chain data alone.

---

## Repository layout

```
tacit/
├── dapp/                  # THE dApp — pin this directory to IPFS
│   ├── index.html         # markup, meta-CSP, script tags
│   ├── tacit.js           # core: Pedersen, bulletproofs, kernel sigs,
│   │                      #  BIP-340/341, envelope encode/decode,
│   │                      #  recursive validator, wallet, UI, marketplace
│   ├── bulletproofs.js / bulletproofs-plus.js   # rangeproof provers/verifiers
│   ├── amm-*.js           # AMM envelopes, BabyJubJub ops, kernel, sigma, farms
│   ├── confidential-*.js  # Ethereum-lane pool, router, transfers, cross-chain
│   ├── prf-wallet.js      # WebAuthn PRF key derivation
│   ├── sw.js / preboot.js # service worker, pre-init
│   └── vendor/tacit-deps.min.js   # @noble/secp256k1 + hashes + @scure/base + sats-connect
├── contracts/             # Solidity: ConfidentialPool (bridge/DeFi) + legacy tETH mixer
│   ├── src/               # ConfidentialPool.sol, CollateralEngine, routers, factory
│   ├── sp1/               # SP1 guest programs (settle + reflection)
│   ├── test/ · script/    # Forge tests · deployment scripts
├── worker/                # optional Cloudflare Worker (faucet, registry, IPFS pin)
├── fulfiller/             # auto-fulfilment service for atomic intents
├── verify-service/        # remote Groth16 proof verification server (Docker)
├── tests/                 # offline test harness (160+ test files)
├── spec/                  # protocol specs + amendments
│   ├── CIRCUITS.md · GLOSSARY.md · amm/ · design/ · amendments/
├── audit/                 # independent security reviews + maintainer responses
├── whitepaper/            # technical whitepaper (.md + .tex + .pdf)
├── build/ · assets/ · discord/ · airdrop/ · ops/ · scripts/
├── SPEC.md · AMM.md · MIXER.md · BRIDGE.md · AMENDMENTS.md
├── README.md              # you are here
└── LICENSE
```

`dapp/` loads `index.html` (markup + meta-CSP), `tacit.js` (core protocol +
wallet + UI), and `vendor/tacit-deps.min.js` (bundled noble + scure +
sats-connect). The meta-CSP locks `script-src 'self' 'wasm-unsafe-eval'`
(no `'unsafe-inline'`, no `'unsafe-eval'`, no third-party origins);
`'wasm-unsafe-eval'` permits the snarkjs Groth16 prover without reopening
the broader eval surface. Pinning `dapp/` yields one CID covering every byte
of trust-bearing code.

`contracts/` holds the active `ConfidentialPool` bridge/DeFi system and its
SP1 guest programs; `TacitBridgeMixer.sol` is sunset infrastructure for
existing-note recovery. `build/` is dev-time only. The `worker/` directory
holds no trust-bearing logic — `WORKER_BASE = ''` disables it entirely.

---

## Protocol details

The wire format is the canonical authority for everything on-chain: every
opcode's envelope layout, validation rules, recovery derivation, and the
indexer's recursive-validation algorithm live in [`SPEC.md`](./SPEC.md),
with the confidential AMM in [`AMM.md`](./AMM.md) and the feature
amendments (cBTC, cUSD, pool, cross-chain reflection, farms, governance) in
[`spec/amendments/`](./spec/amendments/). The [whitepaper](./whitepaper/WHITEPAPER.pdf)
covers the design and trust model end to end.

In one paragraph: every op is a commit/reveal Bitcoin transaction pair (or,
on the Ethereum lane, a proof verified by `ConfidentialPool`). Amounts are
Pedersen commitments bounded by aggregated bulletproofs; conservation is a
kernel signature over the excess. Anonymous spend and the confidential AMM
are Groth16 circuits on the Bitcoin side; the Ethereum lane uses the same
secp256k1 note with Bulletproofs+ and SP1 reflection. Any indexer running
the open spec reaches the same verdict from chain data alone, and a wallet
rebuilds its full balance from its private key plus the chain.

---

## Follow-ups

Post-launch directions, none required for v1:

- **Asset-graph privacy** via Asset Surjection Proofs — hide `asset_id`, not
  just amounts (design sketch in `spec/amendments/`).
- **Funding-leg privacy** via BIP-352 silent-payment composition for the
  plain-sats side, complementing the shielded address.
- **Trustless cBTC custody** — a covenant vault (CTV / OP_VAULT) retires the
  launch-phase MPC custody entirely, making the cBTC.tac peg fully trustless.
- **Bitcoin covenant primitives** — on-chain bid escrow, fractional cBTC.zk,
  and covenant-restricted swap inputs as Bitcoin gains the script support.

---

## Cryptography credits

- Pedersen commitments + Mimblewimble kernel sigs — Maxwell, Poelstra, Jedusor.
- Aggregated Bulletproofs — Bünz, Bootle, Boneh, Poelstra, Wuille, Maxwell (2017);
  Bulletproofs+ — Chung et al. (2020).
- BIP-340 Schnorr / BIP-341 Taproot — Wuille, Nick, Towns.
- Tornado-style Poseidon-Merkle anonymity set + nullifier scheme — Pertsev,
  Storm, Semenov; Tornado.cash team (2019). Tacit's `withdraw.circom` adapts theirs.
- Groth16 zk-SNARK over BN254 — Groth (2016); Phase 1 from the Polygon Hermez ceremony.
- BabyJubJub (embedded curve over BN254 Fr) + Camenisch–Stadler sigma cross-curve
  binding — for the AMM's amount-confidentiality circuits.
- SP1 zkVM (Succinct) — the proof system behind the cross-chain reflection bridge.
- Uniform-clearing-price batch auctions — Walras (1874); Gnosis Protocol (2019);
  Penumbra ZSwap (2023). Constant-product AMM curve — Bancor (2017), and the
  V2-style design space.
- The "indexer-validated meta-protocol" framing comes from Runes / Ordinals.
- Primitives from [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1)
  and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes), with
  [snarkjs](https://github.com/iden3/snarkjs) + [circomlib](https://github.com/iden3/circomlib)
  for the Groth16 path.

---

## License

See `LICENSE`.
