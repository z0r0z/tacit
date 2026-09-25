# BTC at the shielded pool's boundary: atomic trades and a BitVM2 peg

Status: DESIGN. Proposes opcodes `0x6E`–`0x71` from the free range (SPEC §3.9). Nothing here is enabled.
Depends on `DESIGN-btc-shielded-pool.md` ("pool §N") and SPEC §2–§3.

The shielded pool holds Tacit asset value, not BTC (pool introduction; security analysis §0). This
document specifies how real sats meet it. No multisig, federation or attestor set holds or releases BTC in
it (SPEC §1). The peg has a fixed roster whose every member must co-sign each peg-in: the roster cannot
release reserves and the peg is safe with one honest member, and any member can halt peg-ins. The boundary
has two layers, each stated with the trust it needs:

| Layer | What moves | Custody | Status |
|---|---|---|---|
| **No-custody boundary** (§1) | BTC for pool value, by atomic trade between two parties | None. Sats never leave their owner except as the paid side of a trade. | Design, on existing ops |
| **BitVM2 peg** (§2) | BTC for pBTC 1:1, minus a fee | An n-of-n presigned graph. Safe if one presigner is honest; claims are open to any challenger. | Design |

Covenant soft forks would remove the presigners and the operators (§3.1); none is active on mainnet.
Witness-encryption-gated keys are research (§3.2). Both slot in as another peg `kind` with no change to the
pool guest.

---

## 1. No-custody boundary

Value crosses between BTC and the pool only by trades that settle atomically on Bitcoin. Nothing holds sats
on anyone's behalf.

**Trust.** Bitcoin consensus, SP1 and Groth16 soundness for the pool relation, and the pool's own
assumptions (A1–A10 of `DESIGN-btc-shielded-pool-security.md`). No third party holds value.

**Limit.** It is a market. Price and depth come from makers. It gives no right to redeem a note for a
fixed number of sats.

### 1.1 Buy-and-shield and exit-then-sell

Both use the pre-authorized sale: a `T_AXFER` (0x26) lot whose seller signs only its own input and its BTC
payout under `SIGHASH_SINGLE|ANYONECANPAY`, and publishes the lot's opening. The Tacit worker lists sales
and the buyer completes one alone (`publishPreauthSale` and `takePreauthSale` in `dapp/tacit.js`).

- **Buy-and-shield** (pool §9). The buyer's carrier is a `T_BTC_SHIELD`: the envelope at `vin[0]`, the lot
  at `vin[1]`, the seller's signed payout at `vout[1]`, the buyer's BTC inputs after. The shield kernel is
  signed from the published opening. One transaction: the seller is paid, the buyer holds a pool note.
- **Exit-then-sell.** A `T_BTC_SPEND` exits to a transparent note at the holder's fresh script. The holder
  lists that note as a lot. The buyer completes it.

Leakage: the lot's opening is public, so the traded amount is public and linked to the shield or the exit
outpoint. The pool path between shield and exit stays hidden.

### 1.2 Key-share swap: pool note for BTC, no exit

A two-party atomic swap of a pool note for BTC. The pool leg never leaves the pool, and the BTC leg is
plain P2TR key-path spends with no Tacit envelope. It needs no new opcode and no change to the relation.

**Why the direct adaptor form does not work.** In the EVM pool, `OP_ADAPTOR_CLAIM` (SPEC §5.3) commits the
completed kernel scalar `s` as a public value, and its lock set enforces a deadline. The Bitcoin pool has
neither:

- A spend's BIP-340 signature under `spend_key` is a private witness of `btc-pool-prover`. The public
  values are `(1, root, keccak(body))`. An accepted spend reveals no signature, so it cannot carry an
  adaptor secret to the other leg.
- A pool note has no timelock and no script. It cannot be locked to "counterparty with secret, or me after
  a deadline".

So the pool leg cannot be the side that reveals, and it cannot hold a refund branch.

**What does work.** The relation checks a BIP-340 signature under whatever x-only key a note's `spend_key`
names, and places no rule on how that key was produced (pool §4, rule 4). A note can therefore be paid to
the sum of two parties' key shares. Bitcoin carries every timelock, and a Bitcoin signature reveals a key
share. This is the construction used between Bitcoin and scriptless chains. Here both legs are on
secp256k1, so the adaptor point is the key share itself and no cross-group proof is needed.

**Parties.** `N` holds the pool note. `B` holds BTC. The roles are fixed by asset, not by who quotes: the BTC
side always locks first, because only Bitcoin has timelocks.

**Keys.**

| Secret | Public | Use |
|---|---|---|
| `x_N`, `x_B` | `X_N`, `X_B` | Pool key shares. The joint note's `spend_key = x(X_N + X_B)`. |
| `k_N`, `k_B` | `K_N`, `K_B` | Bitcoin keys. `K = KeyAgg(K_N, K_B)` (BIP-327). |
| `nk` | `NK = nk·G` | Joint note's nullifier key, chosen by `N`, shared with `B`. |

Each party proves knowledge of its pool share with a BIP-340 signature over
`SHA-256("tacit-kss-pok-v1" ‖ X_N ‖ X_B ‖ K_N ‖ K_B)`. Without it, `N` could publish
`X_N = X' − X_B` and hold the joint key alone.

**Bitcoin transactions.** All key-path spends of `K`:

| Tx | Spends | Pays | Condition |
|---|---|---|---|
| `lock` | `B`'s coins | `P2TR(K)`, the price | — |
| `redeem` | `lock` | `N` | — |
| `cancel` | `lock` | `P2TR(K)` | `nSequence = t1` |
| `refund` | `cancel` | `B` | — |
| `punish` | `cancel` | `N` | `nSequence = t2` |

`redeem` and `refund` carry adaptor pre-signatures: `redeem` is encrypted under `X_N`, `refund` under
`X_B`. Completing a pre-signature under `X` with its secret `x` gives `s = s' + x`, so whoever sees the
completed signature and holds `s'` learns `x`.

Each presigned transaction carries an anchor output that either party can spend, so its fee is raised by
child-pays-for-parent (CPFP) without re-signing.

**Protocol.**

1. Exchange `X_N`, `X_B`, `K_N`, `K_B`, the proofs of knowledge, `nk`; agree the asset, the note amount
   `v`, the price, `t1`, `t2` and a margin `Δ`. `N`'s redeem deadline is `t_r = t1 − Δ`.
2. `N` gives `B` its partial signature on `cancel` and a pre-signature on `refund` under `X_B`. `B` gives
   `N` its partial signatures on `cancel` and `punish`.
3. `B` broadcasts `lock`. `N` waits for it to confirm to its chosen depth.
4. `N` spends its note with an ordinary `T_BTC_SPEND` into the **joint note**: `spend_key = x(X_N + X_B)`,
   `nk_pub = compress(NK)`, commitment to `v`, with change to itself. `N` sends `B` the opening `(v, r)`
   and the leaf index.
5. `B` checks, from its own replay, that the leaf is accepted at its chosen depth, is of the agreed asset,
   opens to `v`, and carries exactly the agreed `spend_key` and `nk_pub`. `B` then gives `N` a
   pre-signature on `redeem` under `X_N`.
6. `N` completes it with `x_N`, adds its own partial signature, and broadcasts `redeem` before `t_r`. After
   `t_r`, `N` never broadcasts `redeem`, and treats a missing pre-signature as an abort.
7. `B` reads the completed signature, extracts `x_N`, and spends the joint note with `x_N + x_B` into its
   own address.

**Outcomes.** `redeem` and `cancel` spend the same output, so exactly one of `x_N` (to `B`) or `x_B` (to
`N`) is ever revealed.

| Case | Result |
|---|---|
| `B` never locks | Nothing is at stake. |
| `N` never funds the joint note | After `t1`, `B` broadcasts `cancel` then `refund`. Revealing `x_B` is harmless: no joint note exists. |
| `B` never sends the `redeem` pre-signature before `t_r` | `N` aborts. After `t1`, either party broadcasts `cancel`. `B` refunds, revealing `x_B`. `N` spends the joint note back with `x_N + x_B`. |
| `B` cancels but never refunds | After `t2`, `N` broadcasts `punish` and takes the BTC. The joint note stays locked. `N` has in effect sold it. |
| `N` redeems | `N` has the BTC. `B` learns `x_N` and alone holds `x_N + x_B`. `N` cannot spend the joint note: it lacks `x_B`. |
| `redeem` races `cancel` | Both spend `lock`, and one confirms. A broadcast `redeem` reveals `x_N` even if `cancel` wins, after which `B` can both refund and sweep the joint note. `t_r` and fee-bumping `redeem` keep `N` out of this race: `redeem` confirms before `cancel` is valid. |

`B` has no deadline for step 7: once `redeem` confirms, only `B` can sign for the joint note.

**Liveness duties.** `N` stays online to redeem before `t_r`, and to punish after `t2` if `B` cancels
without refunding. `B` stays online from `lock` until `redeem` or `refund` confirms: once `cancel`
confirms, `B` broadcasts `refund` before `t2`, fee-bumping it through its anchor output, or `N` may punish.

**Soundness.** Spending the joint note without both shares is a BIP-340 forgery under `X_N + X_B` (A5b),
and the proofs of knowledge rule out a rogue share. Conservation of the joint note's value is the pool's own
(G3). Everything on Bitcoin is standard two-party adaptor-signature swap reasoning under BIP-340.

**Leakage.** The pool side is two ordinary spends, funding and sweep, with hidden amounts; either can be
relayed (pool §6). The counterparty learns `v`. Both parties know the joint note's leaf and nullifier, so
each sees its funding and its sweep. On Bitcoin, `lock` and `redeem` are single-key P2TR outputs and
key-path spends carrying no envelope, and the price is public. The timing of `lock`, the funding spend
and `redeem` can correlate them. The failure paths show a relative-timelocked spend. Neither leg's
amount appears in a pool envelope, and the BTC leg names no pool leaf.

**Wallet state.** The joint note is not received under pool §2's receipt rule. Each wallet keeps a swap
record (keys, transactions, pre-signatures, opening) until it ends. After the sweep, the note is ordinary
and recoverable from the key.

### 1.3 Answer: a trustless pool-note ↔ BTC adaptor swap on Bitcoin

Yes, as §1.2 specifies: Bitcoin holds the timelocks, a Bitcoin signature reveals a pool key share, and the
pool leg is a note paid to the sum of the shares. The pool-reveals direction does not exist under the
current relation, since spend signatures are never public.

---

## 2. BitVM2 peg: pBTC

pBTC is a Tacit asset minted on Bitcoin against BTC paid into a presigned transaction graph, and redeemed
1:1 minus a fee. It has no Ethereum dependency. In the pool it is one more asset.

### 2.0 Model

- **Reserve outputs.** Each deposit is one Taproot output of one denomination under a fresh, single-use
  n-of-n aggregate key `K_dep`. Before the deposit is broadcast, its **committee** presigns a fixed graph of
  transactions that spend it, and each member deletes its share. The output can only ever leave through
  that graph.
- **Committee.** Every roster member (fixed by the peg's declaration) and every extra the depositor names.
  The depositor may name itself. Each member contributes a fresh key share per deposit and endorses the
  deposit with its long-lived identity key.
- **Burns.** Each burn names one reserve output and a claim key. Burns and reserve outputs map 1:1, and the
  fee is fixed at the burn.
- **Operators.** Named per deposit. An operator pays a burn from its own BTC, then reclaims the burn's
  reserve output through its branch of the graph.
- **Challengers.** Anyone. A reclaim that is not backed by a valid payout is disproved on Bitcoin by a
  Groth16 verifier split into script chunks.

**Safety** (no reserve output leaves except to reimburse a valid payout of its burn) holds if, for every
deposit, at least one committee member deleted its share and presigned only the canonical graph, and at
least one honest challenger is online in each challenge window. pBTC is fungible, so a holder relies on this
for every deposit, not only the one it came from. One honest roster member covers all of them.

**Liveness** (burns get paid) holds while at least one operator of the named reserve output is online with
capital. §2.9 covers what happens otherwise.

### 2.1 Asset and declaration

The peg is created by a `T_PEG_DECLARE`. `asset_id = SHA-256(txid_BE ‖ 0x00000000)` of the declaring
transaction (SPEC §3.3). Ticker `pBTC`, 8 decimals, 1 unit = 1 sat. No mint authority, no etch supply:
supply exists only through `T_PEG_IN` and burn reclaims.

The declaration carries no signature and grants no authority. Every parameter is fixed for the peg's life.
A changed parameter, roster or peg-state guest is a new peg and a new asset. The canonical client pins one
peg's asset id. `kind` selects how reserve outputs are released (§3); the burn, the reserve bookkeeping and
the peg-state statement (§2.7) are the same for every kind.

### 2.2 Opcodes

All integers little-endian. Each op rides `vin[0]` of the standard carrier (SPEC §3.1).

| Byte | Op | Effect |
|---|---|---|
| 0x6E | `T_PEG_DECLARE` | Create a peg and fix its parameters |
| 0x6F | `T_PEG_IN` | Mint pBTC against one confirmed, endorsed reserve output |
| 0x70 | `T_PEG_BURN` | `kind 0`: burn transparent pBTC for one denomination against one named reserve output. `kind 1`: reclaim an unpaid burn. |
| 0x71 | `T_PEG_PAY` | An operator's payout of one burn |

**`T_PEG_DECLARE` (0x6E).** Variable.

```
0x6E ‖ kind(1) ‖ n_roster(1) ‖ roster_key(32)×n_roster ‖ n_denom(1) ‖ (denom(8) ‖ fee(8))×n_denom
     ‖ groth16_vk_hash(32) ‖ peg_vkey(32) ‖ checkpoint(32) ‖ min_work(32)
     ‖ d_in(2) ‖ d_out(2) ‖ d_tip(2) ‖ w_burn(2) ‖ w_chal(2) ‖ w_assert(2) ‖ w_disprove(2) ‖ op_bond(8)
```

- `kind = 0`: BitVM2 graph (§2.3). Other values are reserved (§3).
- `roster_key`: long-lived x-only identity keys, sorted, distinct, `1 ≤ n_roster ≤ 32`.
- `(denom, fee)`: reserve output size and its peg-out fee, in sats. Denominations strictly increasing,
  `1 ≤ n_denom ≤ 8`, `fee < denom`.
- `groth16_vk_hash`: SHA-256 of the SP1 Groth16 verifying key the chunked verifier hard-codes.
  `peg_vkey`: the peg-state guest's program key (§2.7).
- `checkpoint`: the block hash the peg-state guest's header chain starts from. `min_work`: the least
  cumulative work over it that a statement may claim, big-endian. Under `kind 0` challengers enforce the
  heaviest chain and `min_work` is a floor; a kind without challengers depends on it (§3.2).
- Depths `d_in`, `d_out`, `d_tip` and windows `w_*` are in blocks. `op_bond`: the bond each kickoff locks.

Rules: `d_in, d_out ≥ 1`; `d_tip ≥ 6`; `w_burn > d_out`.

### 2.3 Deposit graph

A reserve output is `spk_dep = OP_1 ‖ taproot_output_key(internal = K_dep, no script tree)`: key path only.
`K_dep = KeyAgg(sorted ephemeral shares)` (BIP-327), one fresh share per committee member. For each operator
`o` of the deposit, the committee presigns:

| Tx | Spends | Effect |
|---|---|---|
| `kickoff_o` | `o`'s funds | Commits `burn_id` with a hash-based one-time signature under a key fixed in the graph. Locks `op_bond`. Creates the connectors below. |
| `take1_o` | reserve output, kickoff connector | After `w_chal` with no challenge: the reserve output to `o`. |
| `challenge_o` | kickoff connector | Presigned `SIGHASH_SINGLE\|ANYONECANPAY`: anyone funds it, paying `o` a fee that covers an assertion. Blocks `take1_o`. |
| `assert_o` | challenge output | Within `w_assert`: `o` commits the peg-state proof, the statement's fields and the verifier's intermediate values with one-time signatures, over several transactions. Missing it forfeits the bond. |
| `disprove_o` | assert connector | Any Taproot leaf whose verifier chunk fails on the committed values. Pays part of the bond to the disprover and burns the rest. Blocks `take2_o`. |
| `take2_o` | reserve output, assert connector | After `w_disprove` with no disprove: the reserve output to `o`. |

A chain-work branch is part of the same graph: within `w_chal`, a challenger may commit the work of a header
chain from `checkpoint`. `disprove_o` also succeeds if the asserted work is below it. That makes a privately
mined fork carrying a fake payout disprovable. `d_tip` is the fallback bound: forging `d_tip` blocks at
mainnet difficulty costs more than the largest denomination.

Every reserve output has one graph per operator. They all spend the same output, so at most one operator
reclaims it. The canonical graph template is a function of the declaration, the deposit outpoint, its value
and its operator keys. `graph_root` is the SHA-256 of the serialized, fully signed graph, including every
one-time-signature public key and every disprove leaf.

### 2.4 Peg-in

**Why it is not one transaction.** Tacit's envelope rides `vin[0]` and spends a commit output whose script
contains the payload. Every graph transaction spends the deposit outpoint, so it commits the deposit's
txid. If the mint envelope were in the deposit transaction, its payload would carry `graph_root` and the
endorsement, which commit that txid, which commits the commit output, which commits the payload. That is a
hash cycle. The mint is therefore a second transaction that names the deposit.

Nothing is at risk in between. Every input of the deposit transaction is segwit, so its txid is fixed before
it is signed, and the whole graph is presigned against it before the depositor broadcasts.

**Flow.**

1. **Build.** The depositor picks its operators and extras. Each committee member generates a fresh share.
   The depositor builds, unsigned, a transaction paying exactly one denomination to `spk_dep`.
2. **Presign.** The committee builds the canonical graph for that outpoint and runs n-of-n signing sessions
   for every graph transaction. Each member:
   - checks every transaction against the template;
   - publishes the complete signed graph, addressed by `graph_root`;
   - deletes its share;
   - joins the endorsement (below) with its identity key.
3. **Deposit.** The depositor signs and broadcasts the deposit transaction. It already holds the graph and
   the endorsement. If any member refused, the depositor never broadcasts, and nothing is lost.
4. **Mint.** Once the deposit has `d_in` confirmations, anyone holding the endorsement broadcasts
   `T_PEG_IN`.

**`T_PEG_IN` (0x6F).** Variable.

```
0x6F ‖ asset(32) ‖ dep_txid(32) ‖ dep_vout(4) ‖ r(32) ‖ K_dep(32) ‖ n_extra(1) ‖ extra_key(32)×n_extra
     ‖ n_op(1) ‖ op_key(32)×n_op ‖ graph_root(32) ‖ endorse_sig(64)
```

`endorse_sig` is a BIP-340 signature under `KeyAgg(sorted(roster ∪ extras))`, the identity keys, over:

```
SHA-256("tacit-peg-in-v1" ‖ asset ‖ dep_txid ‖ dep_vout ‖ v(8) ‖ K_dep ‖ r ‖ SHA-256(spk of vout 0)
        ‖ n_op ‖ op_key×n_op ‖ graph_root)
```

An honest member endorses only a `K_dep` that contains its own deleted share, so the endorsement carries the
one-honest-member guarantee to the indexer. The mint note is output 0 of the mint transaction, at a script
the depositor chose: `C = v·H + r·G`. The amount is public on Bitcoin, so the opening is published, as for
`T_PMINT`.

**Acceptance in block `H`:**

1. Canonical parse. `asset` is a peg. `extra_key` and `op_key` are each sorted and distinct, with
   `0 ≤ n_extra ≤ 8` and `1 ≤ n_op ≤ 16`.
2. `(dep_txid, dep_vout)` is unspent and has at least `d_in` confirmations. Its scriptPubKey is `spk_dep`
   for this `K_dep`, and its value `v` is a declared denomination.
3. **Single use.** `K_dep` has not appeared in any earlier accepted `T_PEG_IN` of any peg.
4. `endorse_sig` verifies.

On acceptance: record the reserve output `(outpoint, v, op_keys, graph_root, H)`, free; add `v` to
`minted`; and create the transparent note `(asset, C)` at `(txid, 0)`. `validateOutpoint` learns the op, so
the note works with `T_CXFER`, `T_BTC_SHIELD` and every other op.

Only the first minted output at a `K_dep` counts. BTC paid to a reserve key without an accepted mint, or a
second payment to a used one, mints nothing and has no graph. The canonical wallet never reuses a key.

### 2.5 Burn

Peg-out starts from a transparent pBTC note. From the pool, it is an ordinary exit (pool §3), relayed so the
holder needs no BTC wallet. The relayer's carrier also pays a small BTC output to the holder's fresh key,
covered by the in-pool fee, to fund the burn carrier.

**`T_PEG_BURN` (0x70), `kind = 0`.** 198 or 210 bytes.

```
0x70 ‖ asset(32) ‖ 0x00 ‖ n_in(1) ‖ amount(8) ‖ dep_txid(32) ‖ dep_vout(4) ‖ claim_key(32)
     ‖ spk_len(1) ‖ dest_spk(spk_len) ‖ kernel_sig(64)
```

`vin[1..n_in]` are transparent pBTC notes, `1 ≤ n_in ≤ 8`. `amount` is a denomination `denom[j]`, and
`(dep_txid, dep_vout)` names the reserve output the burn is redeemed against. `claim_key` is an x-only key
whose secret only the burner holds; the canonical wallet uses the output key of `dest_spk` when it is P2TR,
and a fresh key otherwise. `dest_spk` is P2WPKH (22 bytes), P2WSH or P2TR (34). With
`E = amount·H − ΣC_in`, `E ≠ ∞` and `kernel_sig` is a BIP-340 signature under `x(E)` over:

```
SHA-256("tacit-peg-burn-v1" ‖ asset ‖ n_in(1) ‖ (txid ‖ vout_LE)×n_in
        ‖ amount(8) ‖ dep_txid ‖ dep_vout ‖ claim_key ‖ spk_len(1) ‖ dest_spk)
```

This is SPEC §2.4's kernel with no outputs and `burned = amount`, under its own domain. Each `txid` is in the
kernel's byte order. The carrier creates no transparent outputs of `asset`. `burn_id` is the carrier's txid.
Every input is a valid `u64` note and `n_in ≤ 8`, so the `H` component of `E` is the exact integer
`amount − Σ v_in`, and a valid `kernel_sig` with `Σ v_in ≠ amount` yields `log_G H`.

**Acceptance in block `H`:**

1. Canonical parse. The carrier has at least `n_in + 1` inputs.
2. Each `vin[1..n_in]` is valid under `validateOutpoint`, including pool-exit outputs. On unavailable data
   the indexer halts, never rejects.
3. `E ≠ ∞` and `kernel_sig` verifies.
4. `amount = denom[j]` for some `j`, and `burned + amount ≤ minted − destroyed`.

On acceptance: add `amount` to `burned` and record the burn `(amount, owed = denom[j] − fee[j], dep outpoint,
claim_key, dest_spk, H)`. If the named reserve output is minted, free, unspent and of value `amount`, the burn
**holds** it: the output is no longer free. Otherwise the burn is recorded **void**. It holds nothing and is
reclaimable at once. A burn is never rejected for naming a taken output, so two burns racing for one output
cannot destroy the loser's pBTC.

The fee is fixed here, at the burn, by the declaration. Nothing chosen at payout time can change it.

**Reclaim, `kind = 1`.** 162 bytes.

```
0x70 ‖ asset(32) ‖ 0x01 ‖ burn_id(32) ‖ r(32) ‖ sig(64)
```

Valid in block `H` when the burn is recorded, unpaid and unreclaimed, it is void or `H ≥ H_burn + w_burn`,
and `sig` verifies under `claim_key` over
`SHA-256("tacit-peg-reclaim-v1" ‖ asset ‖ burn_id ‖ r ‖ SHA-256(spk of vout 0))`. It creates the note
`amount·H + r·G` at output 0, subtracts `amount` from `burned`, closes the burn, and frees the reserve
output it held. A burn nobody pays returns to its holder as pBTC.

### 2.6 Payout and reimbursement

**`T_PEG_PAY` (0x71).** 165 bytes.

```
0x71 ‖ asset(32) ‖ burn_id(32) ‖ op_key(32) ‖ pay_vout(4) ‖ op_sig(64)
```

`op_sig` is a BIP-340 signature under `op_key` over
`SHA-256("tacit-peg-pay-v1" ‖ asset ‖ burn_id ‖ pay_vout)`.

**Acceptance in block `H`:**

1. The burn holds a reserve output, is unpaid and unreclaimed, `H − H_burn + 1 ≥ d_out`, and
   `H < H_burn + w_burn`.
2. `op_key` is an operator of that reserve output.
3. Output `pay_vout` pays exactly `dest_spk` with value `≥ owed`.
4. `op_sig` verifies.

On acceptance: mark the burn paid by `op_key`. Only the first accepted pay of a burn counts. A later pay of
the same burn is rejected, and its operator has paid for nothing. Pay and reclaim are exclusive by height.

**Reimbursement.** The operator broadcasts `kickoff_o` of the held reserve output, committing `burn_id`,
and waits `w_chal`. Unchallenged, `take1_o` returns the output: `denom[j]`, of which `owed` went to the
holder and `fee[j]` is the operator's. Challenged, it asserts and waits `w_disprove`, then `take2_o`.

### 2.7 The peg-state statement

The assertion is a Groth16 proof of a fifth SP1 guest, `peg-state`, with program key `peg_vkey`. Its public
values are one hash over the payout facts:

```
facts = SHA-256("tacit-peg-facts-v1" ‖ checkpoint(32) ‖ work(32, BE) ‖ burn_id(32) ‖ amount(8)
                ‖ dep_txid(32) ‖ dep_vout(4) ‖ claimant(32))
public values = abi.encode(uint16 1, bytes32 facts)
```

The guest proves that:

1. A header chain from `checkpoint` to some tip is valid: linkage, proof of work, retargeting, cumulative
   work `work ≥ min_work`, as the reflection guest proves (SPEC §6.2). Each block's transactions match its
   merkle root and its witness commitment.
2. Replaying every block from `checkpoint` under this document and the pool's rules gives a state in which
   `burn_id` is an accepted burn of `amount`, holding `(dep_txid, dep_vout)`, at least `d_tip` blocks below
   the tip, and `claimant` is the key entitled to that output:
   - under `kind 0`, the `op_key` of the burn's accepted `T_PEG_PAY`, also at least `d_tip` deep;
   - under a claimant-direct kind (§3), the burn's `claim_key`.

That implies everything the release needs: the burn's inputs were valid transparent pBTC with full ancestry
through any pool exit; the reserve output was minted and held by this burn alone; and, under `kind 0`, the
holder was paid at least `owed`.

The statement is a function of public chain data. It names who may take the output but cannot on its own
stop someone else from proving it. The release mechanism binds the claimant: under `kind 0` the graph fixes
`claimant = op_key` for `o`'s branch, and only `o` can sign `kickoff_o`; a kind without a graph must require
knowledge of `log_G(claimant)` as well (§3.2).

The replay is incremental. Each step proves a range of blocks, verifies the previous step's proof
recursively, and carries a state root over the transparent pBTC live set, the pool's tree, roots and
nullifiers, and the peg state (§2.8). Pool spends are accepted exactly as pool §5 does, including
verification of each `btc-pool-prover` proof, because the pool's roots depend on every asset's spends, not
only pBTC's. Operators keep the step proofs current. The outer wrap is produced only when a claim needs it.

**One verifier.** `btc-pool-prover` and `peg-state` are both SP1 programs proved under the same Groth16 wrap.
That wrap's verifying key is the one the pool already pins (`elf-vkey-pin.json`) and the immutable mainnet
leaf embeds. The program key and the public-values digest are public inputs of that verifier, together with
SP1's fixed version inputs. So one chunked Bitcoin-script verifier of that key serves any SP1 program. In
`o`'s branch the graph fixes the program key to `peg_vkey`, and fixes `checkpoint`, `amount`, `dep_txid`,
`dep_vout` and `claimant = op_key`. `assert_o` commits the facts' fields and the proof. `disprove_o`
succeeds when:

- a chunk of the Groth16 verification fails;
- `facts` does not hash the committed fields, or a committed field differs from the graph's constant or from
  the `burn_id` committed in `kickoff_o`; or
- the committed `work` is below a challenger's committed chain work.

The statement does not depend on the wrap. A release mechanism that needs a different outer proof system
wraps the same guest and checks the same `facts`. The pool guest, its key and the pool's replay rules never
change for it.

The indexer never runs this guest. Its peg rules need no proof beyond the pool's own.

### 2.8 Peg state and invariants

Every indexer that follows pBTC keeps:

| State | Meaning |
|---|---|
| Reserve outputs | `outpoint → (v, K_dep, op_keys, graph_root, H, free / held by burn_id, spent)` |
| Used keys | Every `K_dep` of an accepted mint |
| Burns | `burn_id → (amount, owed, outpoint or void, claim_key, dest_spk, H, open / paid by op_key / reclaimed)` |
| `minted`, `burned`, `destroyed` | Σ mints; Σ open and paid burn amounts; Σ pBTC removed by `T_BURN` |
| Breaches | A reserve output spent while free, or while held by a burn that no accepted pay paid |

All of it is a function of Bitcoin data, applied in the pool's canonical order and rolled back by its undo
log.

- `burned ≤ minted − destroyed` is checked at every burn, so a soundness failure upstream, the pool's proofs
  included, cannot pay out more than was deposited.
- Burns and reserve outputs map 1:1: a burn holds at most one output, an output is held by at most one burn
  at a time, and a paid burn's output is released only once.
- A breach does not change pBTC validity. It makes a successful unchallenged fraud, or committee collusion,
  visible to every indexer in the block it happens.

### 2.9 Liveness

| Failure | Effect |
|---|---|
| A committee member is offline at deposit time | That deposit is not made. Nothing is lost. |
| No operator pays a burn | After `w_burn`, the holder reclaims the burn as pBTC (§2.5), and burns again against another output. The holder can also sell pBTC under §1. |
| Every operator of one reserve output is gone for good | That output's BTC is frozen: no key and no path can move it. Burns naming it are never paid and are reclaimed. Its pBTC is still redeemable against other outputs, so the frozen value is borne by the last redeemers. |
| Every operator is gone | pBTC stays valid and transferable, and is not redeemable 1:1. |
| No challenger online during a fraudulent kickoff | The fraud succeeds for one reserve output, and is recorded as a breach. |

There is no depositor reclaim path after the mint. It would let a depositor take the BTC after paying the
pBTC away. There is none before the mint either, because presigning happens before the deposit is
broadcast. Every timelock in the graph protects a challenger or an operator, and the graph has no timeout
that releases a reserve output to a fixed party.

Mitigations are structural. A depositor names itself as an operator, so it can always redeem its own
deposit: it burns pBTC against it to itself, pays itself, and reclaims the output. That fronts `owed` from
pay to take, about `d_tip + w_chal` blocks (about 7 days at the proposed parameters), plus `op_bond` for
the kickoff. Deposits name many operators. Anyone may run an operator and be named on new deposits.
Existing outputs' operator sets are fixed. The canonical wallet names, in each burn, a free output whose operators
are live.

### 2.10 Fees and capital

| Fee | Paid by | Rule |
|---|---|---|
| Deposit and mint carriers | Depositor | Ordinary Bitcoin fees. No protocol fee on peg-in. |
| Exit and burn carriers | Holder, or the exit's relayer (pool §6) | — |
| Peg-out fee | Holder | `fee[j]` of the denomination, fixed by the declaration and taken at the burn: the holder is owed `denom[j] − fee[j]` |
| Pay, kickoff and take carriers | Operator | Covered by `fee[j]` |
| Challenge | Challenger, crowdfundable | Pays the operator's assertion cost. A successful disprove pays the disprover from `op_bond`. |

**Operator capital.** An operator fronts `owed` from pay to take: `d_tip + w_chal` blocks unchallenged
(about 7 days at the proposed parameters), plus `w_assert + w_disprove` when challenged. Each kickoff also
locks `op_bond` for the same period. Its margin is `fee[j] − carrier fees − capital cost over that
period`. The unhappy path's assertion is large, so its cost at the fee rate the parameters assume sets a
floor on `denom[0]`: below it, a challenge costs more than the output it protects.

### 2.11 Parameters

| Parameter | Proposed |
|---|---|
| Roster members and `n_roster` | Open |
| Denominations | 0.01, 0.1, 1 BTC; `denom[0]` above the dispute-cost floor |
| `fee[j]`, `op_bond` | Open |
| `checkpoint`, `min_work` | The pool's activation block; work of `d_tip` blocks beyond it at declaration |
| `d_in`, `d_out` | 6 |
| `d_tip` | 6, with the chain-work branch enabled |
| `w_burn` | 1008 |
| `w_chal` | 1008 |
| `w_assert`, `w_disprove` | 144, 432 |
| Operators per deposit | Up to 16, the depositor included by the canonical wallet |

### 2.12 Engineering status

Realistic, and large:

- Open BitVM2 bridge implementations run on test networks with a BN254 Groth16 verifier split into script
  chunks, hash-based one-time commitments for assertions, and n-of-n presigned graphs. Mainnet deployments
  are early.
- SP1's Groth16 wrap is BN254 Groth16, the shape those verifiers target. Using one needs its verifying key
  pinned to `groth16_vk_hash` and its public-input layout matched to SP1 v6.
- New here: the `peg-state` guest (reusing `cxfer-core`, `btc-pool-core` and the reflection guest's header
  code), the graph template and presigning service, operator software, and challenger and chain-work
  watchers.
- Graph size grows with operators per deposit, and presigning is interactive per deposit.

### 2.13 Leakage

| Public | Hidden |
|---|---|
| Deposit amount (a denomination), time, funding inputs, committee and operators | Which pool leaf a minted note's value ends up in |
| That a mint note was shielded, and so its amount | Pool payments between shield and exit |
| The burn: its inputs, and so the exit it follows; its amount, reserve output, `dest_spk`, time | Which leaves funded the exit |
| The payout and its operator | The holder's Bitcoin wallet, when the exit is relayed |

Denominations make every deposit and burn of a size look alike. The canonical wallet also waits a randomized
number of blocks between shield and exit and between exit and burn, relays every exit over an anonymizing
transport, and uses a fresh key for every exit script, `dest_spk`, `claim_key` and mint output. Operators
learn nothing beyond the chain: a burn is a public on-chain request.

---

## 3. Other release mechanisms

Each is a new `kind` of `T_PEG_DECLARE`, so a new peg. The burn format, the 1:1 reserve bookkeeping, the
peg-state guest's statement and the pool are shared. Holders move between pegs by redeeming and depositing,
or by swapping. A **claimant-direct** kind is one where the burner takes the reserve output itself, with no
operator: `claimant` is the burn's `claim_key`, and since the whole output goes to the claimant, the kind
charges `fee[j]` as an additional pBTC amount burned with it.

### 3.1 Covenants

A covenant lets a Bitcoin output restrict the transaction that spends it (SPEC §10). None is active on
mainnet.

| Primitive | What it changes |
|---|---|
| `OP_CHECKTEMPLATEVERIFY` | The reserve output commits its spending templates in script, so the graph needs no presigning and no committee. Proof verification is still off-chain with BitVM-style disproves, and operators still front. |
| `OP_CHECKSIGFROMSTACK` | Script verifies a signature over stack data. Assertions commit values with 64-byte signatures instead of hash-based one-time signatures, so the unhappy path is much smaller. With CTV, a template can be chosen by a signature at spend time. |
| `OP_CAT` | Concatenation gives transaction introspection through Schnorr signature checks, so a general covenant, and lets script verify a proof directly across a chain of transactions. A claimant-direct release: the holder spends its reserve output against a proof of `facts` and a signature by `claim_key`. No committee, no operators, no fronting, no challenge window. With no challenger, the chain-work bound is `min_work`, so each output's value must stay below the cost of forging that work. A pairing-based Groth16 check is too costly in script; a hash-based proof fits, which means a different outer wrap of the same guest. |

With a covenant that verifies proofs, the peg's trust reduces to Bitcoin consensus, proof soundness and the
`min_work` bound.

### 3.2 Witness-encryption-gated keys (research)

A reserve output is paid to an ordinary key whose secret is published only as a witness encryption under an
NP statement: whoever holds a witness decrypts the secret and signs. On chain it is a plain key-path output
and spend. The statement would be "a proof of `facts` with `claimant = Q`, `work ≥ min_work`, for this
output, and knowledge of `log_G Q`". Without the last clause the statement is over public data, and anyone
could decrypt.

The design above already has what such a kind needs: one `facts` hash, a claim key in every burn, 1:1
burn-to-output mapping with the fee taken at the burn, and single-use reserve keys. A decrypted secret signs
anything and releases the whole output once, so each key must guard exactly one output of one denomination
and must never be paid twice. It needs no change to the pool guest.

Status: watch, not build. The published construction:

- rests on heuristic, non-falsifiable assumptions, with no reduction to standard ones;
- is estimated, from a model rather than an implementation, at hundreds of terabytes of ciphertext per
  reserve output, and has been implemented only at toy scale;
- needs a trusted setup of each ciphertext, or an MPC that has not been specified, plus a circuit-specific
  ceremony for its own SNARK;
- cannot gate on SP1's Groth16 proof directly, and needs another outer wrap of the peg-state guest;
- has no challenger, so its only chain-state bound is `min_work`, which caps each output's value;
- freezes an output whose ciphertext is lost, and makes whoever decrypts the holder of the key.

Its trust, if built: Bitcoin; the witness-encryption assumption; the setup; the SNARK's ceremony and
soundness; ciphertext availability; and the `min_work` bound.

---

## 4. Trust comparison

| | No-custody boundary | BitVM2 peg (pBTC) | cBTC (SPEC §5.7) | Covenant peg |
|---|---|---|---|---|
| Who holds the sats | Their owner, until a trade settles | A presigned graph; keys deleted | The locker | A covenant script |
| Safety needs | Bitcoin; SP1 and Groth16 soundness | One honest presigner per deposit (one honest roster member covers all); one honest challenger online per window; SP1, Groth16 and the chunked verifier's correctness; published graphs | Locker's wstETH escrow of at least the escrow ratio (1.5× today) and its slashing; the engine's price feed; reflection; Ethereum consensus and the sync committee | Bitcoin; proof soundness; `min_work` bound |
| Liveness needs | A counterparty | One live operator of the named output, with capital | The locker to redeem | Nobody |
| Redemption | Market price | 1:1 minus a fixed fee, in denominations | None for holders; escrow slashed on a breach | 1:1 minus a fixed fee, in denominations |
| Ethereum dependency | None | None | Yes | None |
| Status | Design | Design | Live | Needs a soft fork |

The document introduces no multisig, federation, attestor set or `k`-of-`n` key that holds or releases BTC.
The committee is `n`-of-`n` and safe with one honest member. Its shares are deleted before any BTC is at
risk, and its identity keys only endorse mints. Neither can move a reserve output outside the presigned
graph. The roster is fixed by the declaration and every member co-signs each `T_PEG_IN`, so any member can
halt peg-ins; it cannot release reserves.

---

## 5. Rollout

1. The key-share swap (§1.2) in the reference wallet: joint-note funding and sweep, adaptor pre-signatures,
   the timelock watcher. Signet round trips of every outcome in §1.2.
2. Indexer peg state, `T_PEG_IN`, `T_PEG_BURN` and `T_PEG_PAY` in `validateOutpoint`, with adversarial
   tests. No change to the pool guest.
3. The `peg-state` guest, incremental, with a proof over a signet range.
4. The graph template, presigning, operator and challenger software, and a chunked verifier for SP1's
   Groth16 key. A signet run: deposit, mint, shield, pay, exit, burn, payout, unchallenged take, a
   challenged honest take, a disproved fraudulent kickoff, a void burn and a reclaimed unpaid burn.
5. SPEC §3.9 claims `0x6E`–`0x71`.
6. Roster chosen, independent review, then mainnet with the smallest denominations only.
