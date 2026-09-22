# Tacit: Confidential Assets and DeFi on Bitcoin, Bridged by Zero-Knowledge Reflection

**z0r0z** · <https://tacit.finance> · 2026

> **Abstract.** Bitcoin can hold value without a trusted party, but issuing assets on it, hiding
> amounts, or trading them has meant accepting one: an off-chain proof courier, a federation, a rollup
> operator, or a custodian. Tacit removes that party in two steps.
>
> First, it is an indexer-validated metaprotocol. Assets live in Taproot envelopes, amounts are Pedersen
> commitments with range proofs, and conservation is a Schnorr signature over the excess. Any indexer
> running the specification reaches the same state from the chain alone.
>
> Second, Tacit reflects that state into an immutable confidential pool on Ethereum. Every pool
> transition is one SP1 zero-knowledge proof. Bitcoin blocks reach the pool through a full-proof-of-work
> header relay and an SP1 guest that folds every Tacit envelope. Pool state returns to Bitcoin through a
> light-client proof verified recursively inside the same guest. No signer stands between the chains.
>
> On this base the pool runs confidential DeFi:
> - AMM swaps, including prover-blind batches cleared by a ceremony-backed Groth16 circuit;
> - OTC trades, bids and adaptor-signature swaps;
> - stealth payments;
> - a CDP issuing cUSD;
> - cBTC backed by self-custody BTC locks;
> - farms;
> - gasless relaying with the fee bound inside the proof.
>
> Every balance recovers from a private key and public chain data. Bytes are reserved for the
> constructions that Bitcoin covenants will make fully trustless.

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

Tacit keeps every property, and it does so by composition rather than new consensus. Bitcoin orders
the data, and indexers read it (§2). Commitments hide amounts (§3). An immutable contract on Ethereum
accepts only state transitions that come with a zero-knowledge proof (§4). The two chains learn about
each other through proofs, not signatures (§5).

## 2. A metaprotocol on Bitcoin

A Tacit op is a commit/reveal pair. The commit pays to a Taproot output whose only script leaf is:

$$
\langle P \rangle\ \mathtt{OP\_CHECKSIG}\ \mathtt{OP\_FALSE}\ \mathtt{OP\_IF}\ \texttt{"TACIT"}\ \mathtt{0x01}\ \langle \mathit{payload} \rangle\ \mathtt{OP\_ENDIF}
$$

The reveal spends the commit by script path, so the payload rides in witness data. Bitcoin nodes do not
interpret it. Indexers do: a Tacit UTXO is valid iff the op that created it passes its rules and each of
its asset inputs is itself valid.

The rules are deterministic, so two indexers that see the same bytes reach the same verdict. There is no
quorum, no vote and no leader. This is the trust model Ordinals and Runes already rely on, carried over to
a much wider surface. The trust target is the published specification and its open reference
implementations, the same shape Bitcoin Core has at L1.

Tacit gives this determinism a second, independent check: the Bitcoin reflection guest (§5)
re-implements the rules for every op it folds. Its verdict is enforced by a verifying key that cannot be
changed.

Ops cover:
- **Issuance:** confidential supply, or fair-launch mints against a public cap.
- **Transfers:** confidential.
- **Trades:** atomic OTC trades against BTC, pre-signed bids, and a native AMM with uniform-price
  batch clearing and LP farms.
- **cBTC:** locks and redeems.
- **Cross-chain:** bridge burns, re-mints of notes crossing back from Ethereum, and value-free calls in
  both directions.

An unknown opcode creates no state, so the protocol grows by adding opcodes.

## 3. Confidential value

Every amount is a Pedersen commitment on secp256k1:

$$
C = v\cdot H + r\cdot G,
$$

where $G$ is Bitcoin's generator and $H$ is a nothing-up-my-sleeve point derived from
$\mathrm{SHA256}(\texttt{"tacit-generator-H-v1"})$. Commitments hide the value perfectly and add
homomorphically. A transaction balances iff its excess

$$
E = \textstyle\sum C_{\text{out}} + b\cdot H - \sum C_{\text{in}}
$$

carries no $H$ component, where $b$ is any public burn. Tacit proves this with a BIP-340 signature under
$E$, a Mimblewimble-style kernel. Only someone who knows every blinding can sign, and nobody can sign for
an excess containing value.

Range proofs bound every output to $[0, 2^{64})$, aggregated over up to eight outputs. New transfers use
Bulletproofs+, and classic Bulletproofs remain accepted. The recipient's
blinding and an 8-byte amount keystream come from an ECDH shared secret between sender and recipient,
anchored to the transaction's first input. A recipient therefore finds and opens every credit from its
own key and the chain: no share link, no sync server.

The same commitment, with the same $G$ and $H$, is the note in the Ethereum pool. One note format on
both chains lets value cross between them without changing representation.

## 4. The confidential pool

The pool is one immutable contract holding three depth-32 keccak Merkle trees: notes, locks and CDP
positions. It also holds three spent sets, an escrow for every wrapped asset, and the reflected state of
Bitcoin. It has no owner and no pause.

A note is $(\mathit{asset}, C, \mathit{owner})$. Its leaf is a keccak hash of those fields. Its nullifier
is derived from the leaf, and for owned notes also from the owner's nullifier key. The nullifier is unique
to its note but does not reveal which leaf was spent.

Every state change is a batch of up to 256 ops proven by one SP1 program. Per op, the program checks:
- that each input leaf is a member of a known root, without revealing which leaf;
- the range proofs;
- the kernel or opening proofs;
- the op's own rules.

It then commits the public effects: nullifiers, new leaves, payouts, fees, swaps and liquidity changes,
bridge claims and memos. The contract verifies the proof against a pinned verifying key and applies
exactly those effects.

A spend proves membership against any root the tree has ever had, so the anonymity set of a spend is
every note of its asset.

Nothing in the pool accumulates cost with use:
- an insert is 32 hashes at any fill;
- nullifier and root sets are constant-time maps that are never iterated;
- the guest touches history only through fixed-depth proofs.

The pool binds every proof to $\mathit{CHAIN\_BINDING} = \mathrm{keccak}(\mathit{chainid} \Vert
\mathit{address})$, so a proof for one deployment is worthless in any other.

## 5. Reflection: a bridge without signers

**Bitcoin to Ethereum.** Anyone may extend `BitcoinLightRelay`, a header relay that checks full
proof-of-work and follows the heaviest chain. The reflection guest proves a run of blocks on top of it.
For each block it:

1. re-hashes every transaction to the header's Merkle root;
2. nullifies every input that spends a reflected note;
3. re-verifies and folds each Tacit envelope;
4. extends a digest chain over the result.

The pool accepts an attestation only if its prior digest matches, its tip is buried at least 24 blocks
under the relay tip, and its counters match the pool's own. The pool then holds current roots of
Bitcoin's Tacit notes, of its spent set and of its bridge burns.

Value enters the pool from Bitcoin in two ways:

- **Bridge burn.** The note is destroyed on Bitcoin under a burn id that commits to the target
  deployment, and the pool mints it exactly once.
- **Fast lane.** A Bitcoin-homed note is spent directly on Ethereum. The proof must show that its
  nullifier is absent from the reflected Bitcoin spent set, and it must carry a signature from the note's
  Bitcoin key. The pool records the consumed source so that reflection retires the note on Bitcoin.

**Ethereum to Bitcoin.** A second guest, built on the sp1-helios sync-committee light client, proves
finalized pool storage:
- cross-out commitments,
- consumed sources,
- outbox messages.

The committee chains from period to period, with each step committed. The Bitcoin reflection guest
verifies this proof recursively and folds, by membership:
- re-mints of crossed-out notes on Bitcoin;
- outbox messages;
- retirements of fast-lane notes.

**Calls.** A value-free Bitcoin envelope can authorize an Ethereum call, which an executor contract runs
once it is reflected. Ethereum can post messages that reflection delivers to Bitcoin.

The bridge's soundness rests on Bitcoin proof-of-work, the Ethereum sync committee and SP1. There is no
multisig, attestor set or wrapped-asset IOU. Its liveness needs someone to run the provers. Anyone may,
and Ethereum-homed notes stay spendable if nobody does.

## 6. Confidential DeFi

**Swaps.** Pools are constant-product curves with a fee tier and an optional protocol-fee switch.
Reserves are public, and a plaintext AMM contract trades against the same reserves, so public and
confidential liquidity share one curve. An `OP_SWAP` batch clears many hidden-output intents at one
uniform price. Every trader in a batch pays the same price, so no trader can sandwich another. Routes
compose up to four pools atomically.

**Prover-blind swaps.** Whoever proves an `OP_SWAP` sees its amounts. `OP_SWAP_BLIND` keeps them out of
the SP1 witness: only the batcher that clears the batch and produces its Groth16 proof sees them.

Each trader commits to its input on BabyJubJub, the curve native to BN254. A 169-byte cross-curve sigma
proves that commitment equals the trader's secp256k1 note. The batch carries one Groth16 proof of the
`amm_swap_batch` circuit, which proves over hidden amounts that:
- the clearing price is correct;
- every fill is correct;
- every minimum output is met.

The circuit's verifying key comes from the AMM trusted-setup ceremony: Hermez Phase 1, and Phase 2 with
thousands of contributions sealed by a Bitcoin-block beacon. It is compiled into both SP1 guests, which
verify the pairing in-guest. The same key clears `T_SWAP_BATCH` on Bitcoin.

This is where the ceremony pays for itself. Uniform-price clearing over hidden amounts is a natural
circuit and an expensive program, and the guests' own verifying keys pin the key.

**Trades without a pool.**
- `OP_OTC` swaps two parties' notes directly.
- `OP_BID` is a limit order with a pre-signed grid of partial fills, so the buyer need not be online.
- Adaptor locks tie a claim to the revelation of a Schnorr signature scalar, which gives atomic swaps
  against the other chain.

**Stealth payments.** A payer locks a note under a one-time key derived from the recipient's published
key. The recipient claims it with a signature, and the payer may refund after a deadline. A Bitcoin bridge
burn can mint straight into such a lock.

**cUSD.** A CDP locks cBTC collateral and mints cUSD. The position's owner cannot be linked to it; its
amounts are visible to the controller that prices them.
- Minting requires 150% collateral, and a position can be liquidated below 130%.
- Liquidation burns the full accrued debt and seizes the basket.
- A stability fee and a savings rate are built in and dormant.
- Policy lives in a governed `CollateralEngine` that the pool consults only to accept or reject. Its
  ratios and fee are capped on-chain, and any change against borrowers takes effect only after notice.

**cBTC.** A user locks BTC on Bitcoin with a `T_CBTC_LOCK` envelope, which pre-commits to the note it
will mint. Reflection records the lock's value, and the pool mints cBTC once per lock. The locker holds
the lock's key, and a wstETH escrow (at least 1.5× the lock value today) makes spending it unprofitable:
- a spend without a matching redeem is visible to reflection, and anyone can slash the escrow;
- a proven redeem returns the escrow.

cBTC supply is bounded by reflected locks, with no oracle in the mint path. Custody is economic rather
than enforced, the one gap that covenants close (§11).

**Farms.** LP-share notes bond into a receipt note, and the farm controller records the reward-per-share at entry. Harvests mint
the accrued reward from a controller's escrow. Unbonding returns the shares.

## 7. Gasless and self-sovereign

Any op may be relayed. The relayer's fee is part of what the proof commits to, bound by the conservation
kernel, the opening proof, or the note's spend signature. The relayer pays gas and collects exactly that
fee. It cannot redirect a payout, raise the fee, or submit the proof after its deadline. Fees are quantized
to at most two significant digits.

A user never needs the settlement chain's gas token to move value.

The relayer is a convenience, not a gatekeeper. `settle` is open to anyone, proofs can be generated locally
or on an open prover network, and the three guest programs rebuild byte for byte from source. A user can prove locally,
settle directly, and involve no third party.

## 8. Immutable deployments, opt-in succession

The pool, its guests and their verifying keys cannot be upgraded, and that is the point. The protocol
improves by deploying a successor pool that users choose to enter.

A pool has one privileged governance call, which deploys its successor once and records it. Its only
other privileged callers are the public AMM and the farm controller, and neither can move user value.
After succession the old pool
refuses new value. Every exit and every release of value already committed stays open, as does its
reflection. The successor resumes the shared Bitcoin lane from a handoff record, so reflection has no gap.
Users move by exiting one pool and entering the next. Nothing moves value on their behalf, and a pool
deployed by anyone else is an isolated system that cannot touch the lineage.

## 9. Privacy

| | Hidden | Public |
|---|---|---|
| Bitcoin | amounts; stealth recipients | addresses, the transaction graph, asset ids, burn amounts |
| Pool | amounts; which note a spend consumes; blind-batch trade sizes (hidden from the SP1 prover) | the deposit and withdrawal boundary, AMM reserves, CDP amounts |
| Relay | your key, seed and blindings | the witness of the ops it proves (except blind-swap amounts) |

The pool's anonymity set is every note of an asset, not one denomination. A user who wants no one to see
a witness proves locally.

## 10. Trust and limits

**Relied on:**
- Bitcoin and Ethereum consensus;
- the soundness of SP1 and of Groth16;
- the sp1-helios sync committee;
- for the circuits in §6 only, at least one honest contributor to each ceremony;
- cUSD's oracle;
- the bounded governance of the collateral and farm controllers.

**Not relied on:** relayers, the hosted API, gateways and explorers.

Stated limits:
- Reflection halts, rather than rewrites, on a Bitcoin reorg deeper than its confirmation depth.
- Relayed settles can be front-run. This is the cost of a proof that works for any relayer.
- cBTC is economically secured, not custodially guaranteed.
- On-chain Bitcoin transfers carry a large witness. Tacit on Bitcoin is suited to settlement, and the
  pool is where frequent activity belongs.

## 11. Bitcoin covenants and the road ahead

Several constructions would be fully trustless if Bitcoin could restrict where an output may be spent.
Tacit reserves room for them now:

- **Covenant cBTC.** Pool op 5, `OP_COVENANT_MINT`, is held for cBTC minted against a lock whose sats can
  leave only through a redemption. It reuses the existing mint's value binding with no escrow. That makes
  cBTC trustless BTC, with no economic assumption left.
- **On-chain bid escrow.** A covenant can bind a buyer's pre-signed input to its bid template. That
  replaces the watchtower that guards today's offline bids, and it activates the reserved batch-fill and
  both-sides match bytes.
- **Fractional slots.** Reserved opcodes split a BTC slot into fungible shares and recombine them, with
  no shared vault at all.

Any of CTV, `OP_CAT`, `OP_CHECKSIGFROMSTACK`, `OP_VAULT` or an equivalent suffices. Each of these ships
as additive opcodes, or as a new pool deployment users opt into. None changes what is already live.

The same holds for cryptography: better range proofs replace old ones in place, as Bulletproofs+ did.
Proof systems verifiable in Bitcoin script would let parts of indexer validation move into consensus.

## 12. Conclusion

Tacit makes Bitcoin an asset layer without adding a trusted party:
- a deterministic metaprotocol with hidden amounts;
- an immutable, proof-gated pool that carries the same notes into confidential DeFi;
- a bridge made of proofs in both directions.

Where cryptography can enforce a property, it does. Where Bitcoin cannot yet enforce it, the gap is named,
bounded, and reserved for the covenant that will close it.

---

### References

1. Rodarmor, C. *Ordinals* (2023); *Runes* (2024).
2. Pedersen, T. P. *Non-interactive and information-theoretic secure verifiable secret sharing.* CRYPTO 1991.
3. Jedusor, T. E. *Mimblewimble* (2016); Poelstra, A. *Mimblewimble* (2016).
4. Bünz, B. et al. *Bulletproofs.* IEEE S&P 2018. Chung, H. et al. *Bulletproofs+.* 2020.
5. Wuille, P.; Nick, J.; Ruffing, T.; Towns, A. *BIP-340, BIP-341.* 2020.
6. Groth, J. *On the size of pairing-based non-interactive arguments.* EUROCRYPT 2016.
7. Succinct. *SP1 zkVM*; *sp1-helios.*
8. Pertsev, A.; Semenov, R.; Storm, R. *Tornado Cash* (2019).
9. Walras, L. *Éléments d'économie politique pure* (1874); Gnosis Protocol (2019); Penumbra ZSwap (2023).
10. Rubin, J. *BIP-119 (CTV)*; *OP_CAT* and *OP_CHECKSIGFROMSTACK* proposals.

*Specification: [`SPEC.md`](../SPEC.md). Deployments: [`docs/DEPLOYMENTS.md`](../docs/DEPLOYMENTS.md).*
