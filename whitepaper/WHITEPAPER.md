# Tacit: Confidential Assets and DeFi on Bitcoin, Bridged by Zero-Knowledge Reflection

**z0r0z** · <https://tacit.finance> · Version 1 · 2026

> **Abstract.** Bitcoin secures value without a trusted party, yet every way to issue assets on it, hide
> their amounts or trade them has brought one back: a proof courier, a federation, a rollup operator or a
> custodian. Tacit is a confidential asset layer for Bitcoin that needs none of them.
>
> Tacit assets live on Bitcoin in Taproot envelopes, with amounts hidden in Pedersen commitments, and any
> indexer derives the same state from the chain alone. The same assets extend into an immutable pool on
> Ethereum, which accepts a private transaction only with an SP1 zero-knowledge proof. Each chain proves
> its state to the other, Bitcoin by proof-of-work and Ethereum by its light client, so value and calls
> cross between them with no signer, multisig or custodian.
>
> In the pool, users send, swap, borrow and earn with amounts hidden, and never need ETH for gas. cBTC, a
> token backed by real BTC in self-custody locks, brings bitcoin itself into the pool, and every balance
> recovers from a single key. The core is immutable, so nobody can change the rules under a user's funds,
> yet the protocol keeps improving, pool by pool, toward a V2 built on Bitcoin covenants.

---

## 1. Introduction

A useful asset layer on Bitcoin needs five properties:

1. its state is public data anyone can check;
2. amounts are hidden;
3. value can move to where computation is cheap without trusting a bridge;
4. BTC itself can back a fungible asset;
5. a user can recover everything from a key.

Existing designs each give up one:

| Design | What it gives up |
|---|---|
| Ordinals, Runes | Amounts are public. |
| RGB, Taproot Assets | Validity moves off-chain, so losing a proof means losing the balance. |
| Liquid | Relies on a federation. |
| Rollups and Bitcoin L2s | Rely on an operator set. |
| Wrapped BTC | Relies on a custodian or a threshold group. |

Tacit delivers all five by combining existing systems, with no new consensus:

| Part | What it offers |
|---|---|
| Bitcoin metaprotocol (§2, §3) | Issue, send and trade Bitcoin assets with hidden amounts. |
| Confidential pool (§4, §6) | Private sends, swaps, loans and farms on Ethereum, gas-free. |
| Reflection (§5) | Each chain proves its state to the other; notes and calls cross, no signer. |
| cBTC (§6) | Real BTC in self-custody locks, private on both chains. |
| Lineage (§8, §11) | An immutable core that improves by succession, toward covenants. |

One property Bitcoin cannot yet enforce on its own: custody of the BTC behind cBTC. Tacit secures it
economically until covenants make it absolute (§11).

A typical path shows how the parts fit. A holder burns a TAC note on Bitcoin, paying only BTC, and the
pool mints the same hidden amount on Ethereum. There they swap it privately for cBTC, borrow cUSD against
it, and pay or withdraw to any address, never holding ETH. Later they cross cBTC back to Bitcoin, where
it is again an ordinary Tacit note. Every step is proven; none waits on a signer.

## 2. A metaprotocol on Bitcoin

A Tacit op is a commit/reveal pair. The commit pays to a Taproot output with one script leaf:

$$
\langle P \rangle\ \mathtt{OP\_CHECKSIG}\ \mathtt{OP\_FALSE}\ \mathtt{OP\_IF}\ \texttt{"TACIT"}\ \mathtt{0x01}\ \langle \mathit{payload} \rangle\ \mathtt{OP\_ENDIF}
$$

The reveal spends it, so the payload rides in witness data. Bitcoin nodes ignore it; indexers read it. A
Tacit UTXO is valid iff its op follows the rules and each of its inputs is valid.

The rules are deterministic, so every indexer that reads the same chain reaches the same state. There is
no quorum, vote or leader, the same trust model as Ordinals and Runes. The reflection guest (§5) checks
the rules a second time, under a verifying key that cannot change.

Ops cover issuance (TAC, the native asset, has a fixed supply of 21 million), transfers with optional
stealth addresses, atomic trades against BTC, bids that fill while the buyer is offline, a native AMM,
cBTC locks, and cross-chain burns, re-mints and calls. An unknown opcode creates no state, so the
protocol grows by adding opcodes.

## 3. Confidential value

Every amount is a Pedersen commitment on secp256k1:
$$
C = v\cdot H + r\cdot G,
$$
where $G$ is Bitcoin's generator and $H$ is a second generator nobody knows the discrete log of. An
amount of an asset held this way is a *note*. Commitments hide the value and can be added together. A
transaction balances iff its excess
$$
E = \textstyle\sum C_{\text{out}} + b\cdot H - \sum C_{\text{in}}
$$
has no $H$ component, where $b$ is any public burn. A Schnorr signature under $E$ proves it: only someone
who knows every blinding can sign, and nobody can sign for an excess that hides value.

Range proofs (Bulletproofs+) keep every amount in $[0, 2^{64})$. The recipient's blinding and encrypted
amount come from a shared secret between sender and recipient, so a recipient finds every payment with
its own key and the chain alone.

The Ethereum pool uses the same commitment, so value crosses between the chains unchanged.

## 4. The confidential pool

The pool is one immutable contract with no owner and no pause. It keeps Merkle trees of notes, locks and
loan positions, a spent set for each, escrow for ETH and outside tokens, and the reflected state of
Bitcoin.

**Notes.** A note is $(\mathit{asset}, C, \mathit{owner})$. Spending one reveals its nullifier, which
marks it spent. An owned note's nullifier uses the owner's secret key, so nobody can tell which note was
spent: it hides among every owned note of its asset. Notes that came from Bitcoin stay bound to their
Bitcoin key.

**Entry and exit.** `wrap` deposits ETH or any ERC-20, and one transaction can wrap and immediately send,
swap, add liquidity or borrow (§6). TAC, cBTC and cUSD have ERC-20s that only the pool mints:
unwrapping mints them and wrapping burns them. A note can exit in full or in part, leaving hidden change.

**Settlement.** Every change to notes and positions is a batch of up to 256 ops proven by one SP1
program. The program checks membership, range proofs, balances and each op's rules, then commits only the
public effects: nullifiers, new notes, payouts and fees. The contract verifies the proof and applies
exactly those effects. Proofs never go stale, costs do not grow with use, and each proof binds to one
deployment.

## 5. Reflection: a bridge without signers

**Bitcoin to Ethereum.** Anyone may extend `BitcoinLightRelay`, a header relay that checks full
proof-of-work and follows the heaviest chain. The reflection guest proves a run of blocks on top of it:
it re-hashes every transaction, marks spent any input that spends a Tacit note, and re-verifies every
Tacit envelope. The pool accepts the result once it is buried 24 blocks deep. Value then enters in two
ways:
- **Bridge burn.** A note is destroyed on Bitcoin under an id naming the target pool, which mints it
  exactly once.
- **Fast lane.** A Bitcoin note bound to the pool is spent directly on Ethereum, with a signature from its
  Bitcoin key and proof that it is unspent on Bitcoin. Reflection then retires it on Bitcoin.

A burn moves a note into the pool for good. The fast lane lets a note stay on Bitcoin until the moment
it is spent in the pool, with no separate bridge step.

**Ethereum to Bitcoin.** A second guest, built on the sp1-helios light client, proves the pool's
finalized state. The Bitcoin guest verifies that proof inside its own and acts on it: notes that left the
pool are re-minted on Bitcoin, and fast-lane notes are retired.

**Cross-chain calls.** Reflection also carries calls, which move no value:
- **Bitcoin to Ethereum.** A Bitcoin key signs a `T_BTC_CALL`: a target contract and its calldata. The
  pool records it in an inbox, and `BtcCallExecutor` fires it once. The target sees which Bitcoin key
  signed, so a Bitcoin key can run an Ethereum smart account, vault or governance module with no
  Ethereum key.
- **Ethereum to Bitcoin.** Any Ethereum contract can post to `EthCallOutbox`. Reflection delivers the
  message to Bitcoin's inbox as a `T_ETH_CALL`, stamped with the sender's address, so an Ethereum DAO,
  timelock or oracle can direct Bitcoin-side applications.

The bridge rests on Bitcoin proof-of-work, the Ethereum sync committee and SP1. There is no multisig,
attestor set or IOU. Anyone may run the provers, and Ethereum-side notes stay spendable even if nobody
does. A full round trip, from the pool to Bitcoin and back, has settled on mainnet.

## 6. Confidential DeFi

**Swaps.** Pools are constant-product curves with public reserves. `OP_SWAP_ROUTE` swaps a hidden note
through up to four pools. `OP_SWAP` clears many hidden orders at one price, so nobody in a batch can be
sandwiched. `TacitPublicAmm` trades the same reserves in the clear, so public and private liquidity share
one curve.

**Prover-blind swaps.** `OP_SWAP_BLIND` hides trade sizes even from the SP1 prover. Traders commit to
their inputs on a curve suited to a Groth16 circuit, which proves the batch's price and fills over hidden
amounts; only the batcher that builds the proof sees them. The circuit's key comes from a public ceremony of over 5,000 contributions, and the same circuit clears
the equivalent batch trade on Bitcoin.

**Trades without a pool.** `OP_OTC` swaps two parties' notes directly. `OP_BID` is a limit order that a
watchtower fills while the buyer is offline. Adaptor locks give atomic swaps with the other chain.

**Stealth payments.** A payer locks a note to a one-time key only the recipient can derive. The recipient
claims it, or the payer takes it back after a deadline.

**cBTC.** A user locks BTC on Bitcoin with a `T_CBTC_LOCK`, and the pool mints exactly that much cBTC,
once. The locker keeps the lock's key. An escrow in wstETH worth at least 1.5× the lock, which anyone may
fund, makes spending the lock a loss: a lock spent without a redeem shows up in reflection and anyone can
slash its escrow. The amount minted never depends on an oracle; a price feed only sizes the escrow.

**cUSD.** A loan locks cBTC and mints cUSD, with 150% collateral to mint and liquidation below 130%. The
borrower is hidden; the position's amounts are public so they can be priced. Policy lives in a governed
`CollateralEngine` with on-chain caps, and a delay before a feed change or a stricter liquidation ratio
applies.

**Farms.** LP shares bond into a receipt note that earns rewards. A running reward program can never be
cut short or have its total rate lowered.

## 7. Gasless, self-sovereign, recoverable

**Gasless.** Any op may be relayed. The relayer's fee is bound inside the proof, so it cannot redirect a
payout, raise the fee or act after the user's deadline. Once value is in the pool, a user never needs
ETH. A Bitcoin-only user needs none at all: they enter and exit paying only BTC and act through
relayers. Minting cBTC is the one exception, because its escrow is posted on Ethereum.

**Self-sovereign.** The relayer is optional. Anyone can call `settle`, proofs can be made locally, and
all three guest programs rebuild byte for byte from source.

**Recoverable.** A wallet rebuilds every balance and position from its key and public chain data. There
is no backup file to lose and no server to ask.

## 8. An immutable core that keeps improving

The pool, its guests and their verifying keys cannot be upgraded, so nobody can change the rules under a
note that already exists. The protocol still improves in two ways.

**At the edges.** New Bitcoin opcodes, new tokens, new debt assets and reward programs, and better
clients, relayers and provers all plug in without touching the core. V1 deepens as its market grows,
with no migration.

**By succession.** What the fixed core cannot do, such as a new op or proof system, arrives in a new
pool. The pool live today is the root of the V1 lineage. Each pool can deploy its successor once, through
`createNextGen`, held by the ops multisig, which chooses the new code and nothing else: it cannot touch
escrow, freeze an exit or redirect a payout. The successor continues the Bitcoin lane with no gap and
keeps every asset's identity. The old pool takes no new value but keeps every exit open, and users move
on their own schedule.

## 9. Privacy

| | Hidden | Public |
|---|---|---|
| Bitcoin | amounts; stealth recipients; batch trade sizes | addresses, the transaction graph, asset ids, burn amounts, AMM reserves |
| Pool | amounts; which owned note a spend consumes | deposits and withdrawals, AMM reserves, loan amounts |
| Relay | your key and blindings | the witness of the ops it proves |

An owned note hides among every owned note of its asset, so privacy grows as the pool is used. Proving
locally keeps the witness on one device.

## 10. Trust and limits

**Relied on:**
- Bitcoin and Ethereum consensus;
- the soundness of SP1 and Groth16;
- the sp1-helios sync committee;
- for the swap circuit only, one honest ceremony contributor;
- price feeds: BTC/USD for cUSD, and BTC per wstETH for cBTC escrow;
- the ops multisig (2-of-4, one-hour delay), within on-chain bounds;
- for walk-away bids on Bitcoin only, a watchtower holding a capped, dedicated key.

**Not relied on:** relayers, the hosted API, gateways and explorers.

**Limits:**
- Reflection halts, rather than rewrites, on a Bitcoin reorg deeper than 24 blocks.
- cBTC custody is economic until covenants.
- Bitcoin transfers carry a large witness: Bitcoin suits settlement, the pool frequent use.

## 11. Covenants, V2 and the road ahead

Bitcoin cannot yet restrict where an output may be spent. Once it can, through CTV, `OP_CAT`, `OP_CHECKSIGFROMSTACK`, `OP_VAULT` or an equivalent, three
constructions Tacit reserves room for become trustless: cBTC locks whose sats can leave only through a
redemption, bids escrowed on-chain instead of by a watchtower, and BTC split into fungible shares with no
shared vault.

**V2.** V1 is built to hand off to this covenant generation, which it deploys through its own
`createNextGen` and hands the Bitcoin lane to. cBTC then moves to enforced custody one lock at a time: a
locker redeems a V1 lock, which frees its escrow, and re-locks the sats in a covenant vault that mints in
V2 with no escrow. Every V1 note keeps its exits throughout.

**A shielded pool on Bitcoin.** The companion paper *Secret Sats* describes a shielded pool that lives on
Bitcoin alone. It holds Tacit assets, not BTC, so nobody holds the pool. Each payment carries a small
zero-knowledge proof, made on the payer's own device, that hides the amount and unlinks sender from
receiver, and every node checks it from Bitcoin alone. cBTC is its path to BTC, and sats also move in and
out by atomic swap, and by covenant once Bitcoin allows one.

## 12. Conclusion

Tacit is an asset layer on Bitcoin with no bridge signer and no custodian:
- a metaprotocol with hidden amounts;
- an immutable, proof-gated pool that carries the same notes into confidential DeFi;
- a bridge of proofs in both directions, for value and for calls;
- cBTC, which carries real BTC into that DeFi and back to Bitcoin;
- a lineage of pools that improves with its market and hands off to V2 with covenants.

Where cryptography can enforce a property, it does. Where Bitcoin cannot yet enforce one, the gap is
stated, bounded, and reserved for a covenant to close.

---

### References

1. Rodarmor, C. *Ordinals* (2023); *Runes* (2024).
2. Pedersen, T. P. *Non-interactive and information-theoretic secure verifiable secret sharing.* CRYPTO '91.
3. Jedusor, T. E. *Mimblewimble* (2016); Poelstra, A. *Mimblewimble* (2016).
4. Bünz, B. et al. *Bulletproofs.* IEEE S&P 2018. Chung, H. et al. *Bulletproofs+.* 2020.
5. Wuille, P.; Nick, J.; Ruffing, T.; Towns, A. *BIP-340, BIP-341.* 2020.
6. Groth, J. *On the size of pairing-based non-interactive arguments.* EUROCRYPT 2016.
7. Succinct. *SP1 zkVM*; *sp1-helios.*
8. Pertsev, A.; Semenov, R.; Storm, R. *Tornado Cash* (2019).
9. Walras, L. *Éléments d'économie politique pure* (1874); Gnosis Protocol (2019); Penumbra ZSwap (2023).
10. Rubin, J. *BIP-119 (CTV)*; *OP_CAT* and *OP_CHECKSIGFROMSTACK* proposals.
11. Tacit. *Secret Sats* (2026), companion paper.

*Specification: [`SPEC.md`](../SPEC.md). Deployments: [`docs/DEPLOYMENTS.md`](../docs/DEPLOYMENTS.md).
Companion paper: [*Secret Sats*](./secret-sats.pdf).*
