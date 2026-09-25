<p align="center">
  <img src="./assets/tacit.svg" alt="tacit" width="120">
</p>

# tacit

**Tokenization and confidential DeFi on Bitcoin, with a zero-knowledge bridge to a confidential zone on
Ethereum.**

Live on Ethereum mainnet since 2026-09-18 ([contracts and addresses](./docs/DEPLOYMENTS.md)). The first
Bitcoin-native AMM pool, founded directly on Bitcoin with no Ethereum contract, is live in the indexer as
of 2026-09-25 ([pool and reserves](./docs/DEPLOYMENTS.md#bitcoin-native-amm-pool)).

Tacit is a Bitcoin metaprotocol. Assets are issued and transferred in Taproot envelopes. Amounts are
hidden by Pedersen commitments and range proofs, and any indexer running the spec reaches the same state
from the chain alone.

The same confidential note also lives in an immutable pool on Ethereum. There it can be:
- swapped, lent against, farmed or paid privately;
- relayed without gas;
- moved back to Bitcoin.

SP1 zero-knowledge proofs carry state between the two chains in both directions. No multisig, federation
or attestor set signs a bridge message.

- **App:** [tacit.finance](https://tacit.finance)
- **Spec:** [`SPEC.md`](./SPEC.md), the normative protocol
- **Whitepaper:** [`whitepaper/`](./whitepaper/WHITEPAPER.md), design and rationale
- **Contracts:** [`docs/DEPLOYMENTS.md`](./docs/DEPLOYMENTS.md), mainnet addresses and verifying keys
- **Verify it yourself:** [`docs/VERIFY-LIVE.md`](./docs/VERIFY-LIVE.md), `node tools/verify-live.mjs` checks the
  live deployment against this repository
- **Build on it:** [`docs/BUILD-A-TACIT-DAPP.md`](./docs/BUILD-A-TACIT-DAPP.md)
- **Security:** [`audit/AUDITS.md`](./audit/AUDITS.md) — full review history. The v1 release's agentic audits:
  [Fable 5.1 lock checkpoint](./audit/AUDIT-2026-09-16-17-fable51-lock-checkpoint.md) (the review that gated
  the deploy), an [external automated review](./audit/AUDIT-2026-09-21-gpt-astra-external-review.md), and the
  [Pashov `solidity-auditor` v4 round](./audit/AUDIT-2026-09-24-pashov-solidity-auditor-v4.md) (24-agent,
  post-deploy, extended to the zkVM guest) — run after a week of live mainnet use.

---

## What it does

**On Bitcoin**
- **Issue assets** with hidden or fair-launch supply (`T_CETCH`, `T_PETCH`/`T_PMINT`). The issuer can
  publish its supply opening so anyone can audit it. TAC, the native asset, was issued with `T_CETCH`
  and a zero mint authority, so its supply is fixed ([genesis, supply and its Ethereum
  ERC-20](./docs/DEPLOYMENTS.md#tac)).
- **Transfer confidentially.** Amounts are hidden, conservation is proven by a kernel signature, and
  range proofs are Bulletproofs+. Recipients recover credits from their key alone.
- **Trade atomically.**
  - **Atomic offers:** sell an asset directly for BTC in one transaction. A maker lists a lot, any taker
    completes it.
  - Bids that a watchtower fills while the buyer is offline, matched off-chain and settled atomically on
    the first fill. The on-chain preauth opcode this could also use is reserved for now (signet only).
  - A native AMM: per-trade swaps, routes over up to four pools, and batch clearing at a uniform price.
  - LP farms.
- **Lock BTC for cBTC.** A self-custody lock on Bitcoin backs fungible cBTC in the pool.
- **Send value-free calls.** A Bitcoin-signed message can authorize an Ethereum call, and Ethereum can
  send messages back.

**In the confidential pool (Ethereum)**
- Wrap ETH or ERC-20s into notes, transfer privately, and unwrap to any address.
- Trade on a confidential AMM: swaps, routes and liquidity. OTC also runs here. `OP_BID` is a real,
  guest-verified op with a complete, tested wallet-side implementation (`confidential-bid.js`); it has no
  dedicated UI tab yet.
- Pay by stealth: the recipient gets a one-time key, claims it, and the sender can refund if unclaimed.
- Use adaptor locks for atomic cross-chain swaps — the primitives are guest-verified; no dapp module
  assembles the op yet.
- Borrow **cUSD** against cBTC collateral. Mint **cBTC** against reflected BTC locks.
- Earn farm rewards on LP positions, paid in wTAC (a 1:1 TAC wrapper).
- Relay any op without gas, with the relayer's fee bound inside the proof. Anyone can also prove and
  settle their own ops.

**Between the chains**
- **Bitcoin → Ethereum.** A full-proof-of-work header relay feeds an SP1 guest. The guest folds Tacit
  envelopes into roots that the pool accepts after 24 confirmations.
- **Fast lane.** A Bitcoin-homed note can be spent directly on Ethereum right away, instead of waiting for
  the header relay and reflection to confirm it first — the pool only needs to see that the note hasn't
  already been reflected as spent. Bitcoin catches up later, through the same reverse-reflection proof, so
  the note can never be spent twice. Proven live:
  [`0x548d52cb…4940fd0c84`](https://etherscan.io/tx/0x548d52cbae38d8e60c278ec919e6cbe8bdb5a370d36a04fe5ca0e64940fd0c84).
- **Ethereum → Bitcoin.** An SP1 light-client guest proves pool storage. The Bitcoin guest verifies that
  proof recursively, so crossed-out notes are re-minted on Bitcoin.
- **One note, two chains.** The note commitment is the same secp256k1 Pedersen commitment on both sides.

## How it is built

```
            Bitcoin L1                                  Ethereum L1
  ┌───────────────────────────┐              ┌────────────────────────────────┐
  │ Taproot envelopes         │  headers +   │ BitcoinLightRelay (full PoW)   │
  │  issue · transfer · trade │  SP1 proof   │ ConfidentialPool (immutable)   │
  │  AMM · farms · cBTC locks │ ───────────▶ │  note tree · nullifiers        │
  │  bridge burns · calls     │              │  settle(SP1 proof)             │
  │                           │  SP1 light-  │  AMM · CDP · farms · stealth   │
  │ indexers (dapp, worker)   │ ◀─────────── │ CollateralEngine · FarmManager │
  └───────────────────────────┘ client proof └────────────────────────────────┘
        secp256k1 Pedersen · BP+ range proofs · Schnorr kernels · keccak IMTs
```

**Three layers, not two.** The Bitcoin metaprotocol and the Ethereum confidential pool are each a full,
independently-derivable ledger; reflection is the zero-knowledge layer that reconciles them, not a
custody bridge. Bitcoin-homed notes carry their own leaf and nullifier, derived from the note's actual
Bitcoin output key, so Bitcoin-side state stands on its own before any reflection proof runs.

**Three SP1 programs:**
- the **settle guest**, which proves pool ops;
- the **Bitcoin reflection guest**, which proves Bitcoin blocks;
- the **Ethereum reflection guest**, which proves pool storage via sp1-helios.

Each is pinned by ELF hash to an immutable verifying key, and each
[rebuilds byte for byte](./docs/REPRODUCIBLE-BUILDS.md).

**Ceremonies.** The transparent stack needs no trusted setup. Two finalized ceremonies supply Groth16
keys for circuits that are expensive to express otherwise:
- the **AMM ceremony**, whose `amm_swap_batch` key is compiled into both guests for blind batch swaps
  (`T_SWAP_BATCH` on Bitcoin, `OP_SWAP_BLIND` in the pool);
- the **mixer ceremony**, for the legacy fixed-denomination mixer on Bitcoin.

Details are in [SPEC §2.8](./SPEC.md#28-circuits-and-ceremonies); every artifact, with its CID and hash,
is in [`docs/CEREMONY.md`](./docs/CEREMONY.md).

**Room for Bitcoin covenants.** Some op codes and opcode bytes are held for constructions Bitcoin cannot
yet enforce. The main one is covenant-locked cBTC with no escrow. The others are on-chain bid escrow and
fractional BTC slots. See [SPEC §10](./SPEC.md#10-extensions-and-covenant-placeholders).

## Privacy and trust

- **Hidden:** amounts, which owned note a pool spend consumes, and stealth recipients.
  `OP_SWAP_BLIND` also hides trade sizes from the SP1 prover; it is enabled in the guest, but no client
  emits it yet.
- **Public:** Bitcoin addresses and the transaction graph, asset ids on Bitcoin, the pool's deposit and
  withdrawal boundary, AMM reserves and their changes, and CDP position amounts. A position's owner stays
  unlinkable.
- **You trust:** Bitcoin and Ethereum consensus, SP1 and Groth16 soundness, the sp1-helios sync
  committee, and the ceremonies (only for the circuits that use them).
  - cUSD relies on its oracle.
  - cBTC is secured economically, by the locker's wstETH escrow (at least the engine's escrow ratio,
    1.5× today).
  - The periphery (CollateralEngine, FarmManager) is governed by a 2-of-4 ops multisig with a built-in
    one-hour delay, within on-chain bounds.
- **You don't trust:** relayers, the hosted API or IPFS gateways. The pool, its guests and their keys
  cannot be changed, and every balance recovers from your key plus chain data.
- **You do depend on someone proving.** Nobody can take or forge a balance, but Bitcoin state only reaches
  Ethereum when a prover runs, and once a cross-out has been recorded every Bitcoin-side attest carries an
  Ethereum-state proof with it. If nothing is proving, Bitcoin-side folds wait rather than going wrong —
  reflected state stops advancing instead of advancing incorrectly. Exits on the Ethereum side need no
  prover but your own. The proving lane is permissionless by design: the inputs are public chain data, so
  it is a liveness dependency on someone, not a trust dependency on us.

The protocol evolves by deploying successor pools that users opt into by exiting one pool and entering
the next. A retired pool keeps every exit open ([SPEC §8](./SPEC.md#8-deployment-lineage)).

## Run the dapp

The dapp is static files: `dapp/index.html`, `tacit.js` and a vendored crypto bundle.

```sh
cd dapp && python3 -m http.server 8000     # http://localhost:8000
```

Pin `dapp/` to IPFS or any static host. To rebuild the vendored bundle and print its SRI hashes:
`cd build && npm install && npm run build`.

Sign in with an Ethereum wallet, a passkey, a Bitcoin wallet or an imported key. A wallet identity comes
from one deterministic signature over the Tacit identity message, the same in every Tacit app, so
reconnecting anywhere restores it. Anyone holding that signature controls the funds, so sign it only in a
Tacit app you trust.

To check recovery, import your key in a fresh browser and rescan: every balance and position should
return from chain data alone.

## Repository

```
dapp/            the app: protocol core (tacit.js), pool client (confidential-*.js), circuits, ceremony bundle
contracts/       Solidity (src/, script/, test/) and SP1 guests (sp1/confidential, sp1/eth-reflection)
worker/          indexer + API (served by server/ on Node); reads Bitcoin from public Esplora endpoints
                 with fallbacks; never proves, never holds funds
worker-relay/    hosted relay: settle, reflection, header relay, monitoring
tests/           cross-implementation vectors and test suites
tools/ scripts/  operational and verification tools
docs/            integrator guides: build a dapp, deployments, ceremony artifacts, farms, airdrop, recovery,
                 reproducible builds, live verification
audit/           security reviews
whitepaper/      whitepaper (.md, .tex, .pdf)
```

## Brand assets

32×32 SVG marks, each the same file already used on-chain or in a token listing — published as static
assets under `dapp/`, so they deploy with the app and resolve at a stable URL for external submissions
(exchange listings, token-logo registries, etc.).

| Asset | Live URL | Source in repo |
| --- | --- | --- |
| TAC | [tacit.finance/brand/logo.svg](https://tacit.finance/brand/logo.svg) | [`assets/tac-onchain.svg`](./assets/tac-onchain.svg) — mirrors the mark inlined on-chain in [TAC's token.list.wei listing](https://token.list.wei.limo) |
| tETH / cETH | [tacit.finance/brand/teth.svg](https://tacit.finance/brand/teth.svg) | [`contracts/teth-icon.svg`](./contracts/teth-icon.svg) |
| cBTC | [tacit.finance/brand/cbtc.svg](https://tacit.finance/brand/cbtc.svg) | [`contracts/tokenlist-drafts/cbtc-zk-icon.svg`](./contracts/tokenlist-drafts/cbtc-zk-icon.svg) |
| cUSD | [tacit.finance/brand/cusd.svg](https://tacit.finance/brand/cusd.svg) | [`contracts/tokenlist-drafts/cusd-zk-icon.svg`](./contracts/tokenlist-drafts/cusd-zk-icon.svg) |
| Tacit (protocol mark, 48×48) | [tacit.finance/brand/mark.svg](https://tacit.finance/brand/mark.svg) | [`assets/tacit-mark.svg`](./assets/tacit-mark.svg) |

## Points and farms

A time-limited launch program, not a protocol feature.

- **Points.** Wrapping ETH, posting wstETH collateral toward a cBTC mint, and minting cUSD each earn points
  toward 100,000 TAC distributed over 90 days (2026-09-23 to 2026-12-22). Every deposit gets an
  early-adopter bonus that decays as more of that same activity accrues — not a one-time reward for
  whoever is first. cUSD mints earn roughly 5x more per dollar than cBTC collateral posts; wrapping ETH
  from an address that has ever received a Privacy Pools withdrawal earns an extra 1.2x. Claims run
  through [`PointsDistributor`](https://etherscan.io/address/0x000000C918e44A3a443937fA7594eA4f7C95D6b9).
- **Farms.** LP positions in the confidential pool earn wTAC from
  [`FarmManager`](https://etherscan.io/address/0x000031C47Cb61faB1CE2790a69625FABB71EDE24) — 99,700 TAC over
  90 days from 2026-09-21, split across three pools ([`docs/FARMS.md`](./docs/FARMS.md)). A public TAC/ETH
  farm also runs on
  [PrecisionFarm](https://etherscan.io/address/0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0), paying
  ~554 TAC/day through 2026-12-19.

## Credits

- Pedersen commitments and Mimblewimble kernels: Pedersen; Jedusor; Poelstra.
- Bulletproofs: Bünz, Bootle, Boneh, Poelstra, Wuille, Maxwell. Bulletproofs+: Chung et al.
- BIP-340/341: Wuille, Nick, Ruffing, Towns.
- SP1 and sp1-helios: Succinct. Groth16: Groth.
- The Tornado-style mixer circuit is adapted from Tornado Cash.
- Uniform-price batch clearing follows Walras, Gnosis Protocol and Penumbra.
- The indexer-validated metaprotocol pattern comes from Ordinals and Runes.
- Libraries: [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1),
  [`@noble/hashes`](https://github.com/paulmillr/noble-hashes), [snarkjs](https://github.com/iden3/snarkjs),
  [circomlib](https://github.com/iden3/circomlib), [Solady](https://github.com/Vectorized/solady).

## License

See [`LICENSE`](./LICENSE).
