# Secret Sats Join: equal-denomination joins over real sats

Status: DESIGN. No opcode, no envelope, no coordinator, and no change to any guest, contract or indexer
rule. Companion to `DESIGN-btc-shielded-pool.md` ("pool §N") and `DESIGN-btc-pool-native-peg.md`
("peg §N").

The shielded pool hides Tacit asset value. The join hides real sats. On today's Bitcoin, sats cannot sit
in a shared pool without a key-holder (pool introduction), so the join holds nothing. Participants each
bring one confirmed coin and meet on an untrusted bulletin board. They shuffle their output keys among
themselves with a DC-net, and each builds the same transaction. That transaction pays every participant
one output of the same value. Each participant signs only after it finds its own output in the
transaction. No party assembles, holds or orders anything. Anyone can run a board, and anyone can join.

| Property | Mechanism |
|---|---|
| No custody | Each input is signed by its owner only after the owner has rebuilt the transaction and found its own output in it (§7). |
| Nobody can link | Output keys are collected with a DC-net shuffle (§4). The board and the other participants learn the set of outputs, not who owns which. |
| No trusted party | The board only forwards signed messages (§5). Round membership, the transaction and every exclusion follow deterministically from those messages (§6, §8). |
| Uniform outputs | One tier and one allowance per round, one output per input, every output P2TR key-path at the same exact value (§2). |
| Key-only recovery | Every output is a silent payment, found by scanning the join transaction with the scan key (§3). |

---

## 1. Parties and goals

- **Participants.** Hold one confirmed coin per input, run the client (dapp or CLI), stay online for one
  round. A client with several inputs runs one participant per input.
- **Board.** A relay that stores and forwards signed messages for a topic (§5). It holds no key that
  matters to funds or privacy, and it runs no protocol logic.
- **Observers.** See the chain.

| Goal | Holds against | Assumptions |
|---|---|---|
| **J1. No theft.** A participant's coin leaves only in a transaction that pays it its output. | Board, all other participants, observers | BIP-340/ECDSA unforgeability; BIP-341/BIP-143 sighash commits to every output |
| **J2. Unlinkability.** No party learns which output belongs to which input beyond a uniform guess over the round's honest participants. | Board, other participants, observers | DC-net pads (§4) under CDH on secp256k1 and the PRF; at least two honest participants in the final run |
| **J3. Liveness.** A round with at least `k_min` honest, online participants completes. | Participants that disrupt | Each failed run excludes at least one disrupter (§4.5); the board delivers messages. A board that does not is replaced by another (§5). |

## 2. Tiers and transaction shape

### 2.1 Tiers, fee buckets and the allowance

A round is fixed by a tier `d` and a fee bucket `fr`. Every output of the round has value `o = d + a(fr)`.

| Tier | `d` (sats) | Enabled |
|---|---|---|
| 0 | 100,000 | Day one |
| 1 | 1,000,000 | Day one |
| 2 | 10,000,000 | After tier 0–1 rounds fill on mainnet |
| 3 | 100,000,000 | When tier 2 rounds fill |

- `d` is a power of ten of sats. Tiers 1–3 equal the peg denominations (peg §2.11).
- `fr` is taken from the bucket grid `{1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120}` sat/vB. It is both the
  join's fee rate and the input of the allowance.
- `a(fr)` is the **spend allowance**. It pays one follow-on key-path spend of exactly `d` with one input,
  one P2TR output and one pay-to-anchor output (124 vB), plus the anchor's 240 sats. It lets one join
  output fund a peg-in of `d` with no second input (§11.3):

```
a(fr) = max(1,000, ⌈(240 + 124·fr) / 500⌉ · 500)
```

| `fr` (sat/vB) | 1 | 2 | 3 | 5 | 8 | 12 | 20 | 30 | 50 | 80 | 120 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `a(fr)` (sats) | 1,000 | 1,000 | 1,000 | 1,000 | 1,500 | 2,000 | 3,000 | 4,000 | 6,500 | 10,500 | 15,500 |

The coarse grid concentrates participants into few topics, and the 500-sat step leaves few distinct
output values on the chain.

**Choosing a bucket.** The client takes its own estimate `fr_own` for confirmation within six blocks and
joins the topic (§6.1) of the smallest bucket `≥ fr_own`. If an open topic of the next bucket up already
has more JOINs, it joins that one instead. It never joins a bucket above `2·fr_own`.

| Parameter | Mainnet | Signet |
|---|---|---|
| `k_min` | 10 | 3 |
| `k_max` | 100 | 20 |

### 2.2 The join transaction

| Field | Value |
|---|---|
| `nVersion` | 2 |
| `nLockTime` | `h_ref`, the topic's reference height (§6.1) |
| Inputs | The final input set `P`, `k_min ≤ |P| ≤ k_max`, sorted by outpoint (`txid` in serialization byte order, then `vout` LE), each `nSequence = 0xfffffffd` |
| Input types | P2TR key-path (BIP-341 output key, 64-byte `SIGHASH_DEFAULT` signature) or P2WPKH with a compressed key. Nothing else. |
| Outputs | Exactly `|P|` outputs, each P2TR at value `o`, sorted by `scriptPubKey` ascending |
| Change | None |
| Fee | `Σ v_in − |P|·o` |

**Why these input types.** Both are single-key and BIP-352-eligible, and both let the ownership proof
(§6.2) be one BIP-340 signature. Script-path spends, P2WSH, P2SH and legacy inputs are refused: they are
not uniform, and some are not BIP-352-eligible, which would change `A_sum` (§3). P2TR is preferred. The
dapp's P2WPKH wallet coins enter through the entry transaction (§2.4), whose outputs are P2TR.

**Size.** A P2TR key-path input is 230 WU, a P2WPKH input 272 WU, a P2TR output 172 WU, and the fixed
overhead 42 WU. At `k_max = 100` with all P2WPKH inputs the transaction is about 44,500 WU, under the
400,000 WU standardness limit. Every output is above the 330-sat P2TR dust limit. All inputs are
confirmed, so the transaction has no unconfirmed ancestors.

**Join-shaped.** A transaction is **join-shaped** iff it has `nVersion = 2`, at least 3 outputs, as many
outputs as inputs, and every input is P2TR key-path or P2WPKH. Every output must also be P2TR at one value
`d + a(fr)` for a tier `d` and a bucket `fr`. Wallets use this rule to find join transactions (§3.2,
§11.4). Remix admission (§2.3) uses it too.

### 2.3 Inputs: fresh and remix

Each input pays its own bytes, plus a share of the fixed bytes, at `fr`:

```
f_in(fr, P2TR)   = ⌈fr × (57.5 + 43 + s)⌉
f_in(fr, P2WPKH) = ⌈fr × (68   + 43 + s)⌉        s = ⌈11 / k_min⌉
```

On mainnet `s = 2`, so `f_in` is `⌈fr × 102.5⌉` for P2TR and `⌈fr × 113⌉` for P2WPKH.

| Class | Admitted iff | Pays |
|---|---|---|
| **Fresh** | `v_in ≥ o + f_in(fr, type)` | Its own `f_in`. Its excess `v_in − o − f_in` funds remix inputs, and whatever is left goes to the miner. |
| **Remix** | P2TR; the prevout is an output of a confirmed join-shaped transaction at the same `d`; `v_in ≥ o` | Its own surplus `v_in − o`, up to its `f_in`. The rest of its `f_in` comes from fresh excess. |

**Round funding rule.** With `Φ` the fresh inputs and `R` the remix inputs of the final set:

```
|R| ≤ |Φ|        and        Σ_{P} (v_in − o)  ≥  Σ_{P} f_in(fr, type)
```

The second inequality says that the fee meets `fr`, with every output exactly `o`. Each fresh input brings
a margin (§2.4), and those margins are what pay for remixes. Remix inputs pay no fee beyond what their own
allowance covers. The cap `|R| ≤ |Φ|` bounds how far a remixing sybil rides on fresh fees (§10.1).

**Ceiling.** The client refuses to register a coin whose excess `v_in − o − f_in(fr, type)` exceeds
`max(f_in(fr, type), 5,000)` sats. A remix coin whose allowance is far above `a(fr)` registers in a higher
bucket.

### 2.4 Entry transaction

A participant's coin rarely falls in the window by chance. The client first makes an **entry
transaction** from its own coins. The entry transaction has `k` outputs, each of value
`o + f_in(fr, P2TR) + margin`, paid to its own silent address with the existing sender derivation
(`senderComputeSilentPaymentOutput`, `k = 0..`), and one change output of its own. The entry transaction
confirms before its outputs register.

- It is the participant's own transaction and links the source coins to its `k` entry outputs. The join
  breaks the link from there.
- **One entry output per round.** Round formation admits at most one fresh input per `txid` (§6.2). The
  client registers entry outputs in separate rounds. The rule does not apply to remix inputs: outputs of
  one join have independent owners.
- The margin covers fee-rate movement and funds remixers (§2.3). `margin = f_in(fr_est, P2TR)` by default.
- **Change policy.** Change lives only in entry transactions, never in the join. Entry change is linked to
  the source coins and stays in the wallet's unmixed class (§9.2).

## 3. Output keys

### 3.1 Own outputs

A participant's own output is a BIP-352 payment to its **own** silent address, derived from the run's
input set `P_r` (§6.3). The receiver side of BIP-352 needs no sender secret. So a participant derives its
own output without any other participant's cooperation.

With `(b_scan, B_spend)` from `deriveSilentPaymentKeys(wallet.priv)`:

```
A_sum      = Σ over P_r of each input's BIP-352 public key
             (P2TR: 0x02 ‖ x-only output key; P2WPKH: the registered compressed key)
op_L       = lexicographically smallest outpoint in P_r (36 bytes, txid serialization order ‖ vout LE)
input_hash = H_tag("BIP0352/Inputs", op_L ‖ ser_P(A_sum))
ecdh       = (b_scan · input_hash) · A_sum
t_k        = H_tag("BIP0352/SharedSecret", ser_P(ecdh) ‖ ser_32be(k))
P_k        = B_spend + t_k·G                         output scriptPubKey = OP_1 ‖ x(P_k)
sk_k       = b_spend + t_k                          silentPaymentSpendingKey(spendPriv, t_k)
```

`k = 0` for a participant's first output in the transaction, and `k` increments for each further
participant it runs in that round. This reuses the dapp's code as it stands:
`aggregateStealthEligibleInputPubkeys`, `_bip352SmallestOutpoint`, `_bip352OutpointBytes`, `_taggedHash`,
`_bip352U32be`, `deriveSilentPaymentKeys`, `silentPaymentSpendingKey`. The one new helper is the
receiver-side forward derivation of `P_k` for a given `k`. The completed join is recorded with
`recordSpCredit`.

- Only the holder of `b_scan` can compute `P_k`.
- `P_r` changes in every run, including a rerun without excluded participants, so a key revealed in a
  failed run (§4.5) is never used again.
- The output is recoverable from the seed with `receiverScanTxForSilentPayments`, exactly as any
  silent-payment receipt.
- A wallet refuses the run if `A_sum = ∞` or `input_hash mod n = 0`. Neither can be forced by another
  participant: each input key was fixed when its coin confirmed, and cancelling `A_sum` requires the
  discrete log of the negated sum of the others.

### 3.2 Join silent payments: paying someone else

A participant may make its output a payment to a third party's silent address `(B_scan, B_spend)`. The
sender uses a **join silent payment**, which derives the output key from the sender's own input alone.
It needs no share from any other input owner.

With `a_i` the private key of the sender's input (P2TR: the output key's secret, negated if its point has
odd y, as in BIP-352; P2WPKH: the key) and `A_i = a_i·G`:

```
H_P        = SHA-256(outpoint_1 ‖ … ‖ outpoint_|P_r|)                  P_r's outpoints in transaction order
input_hash = H_tag("TacitJoinSP/Inputs", H_P ‖ outpoint_i ‖ ser_P(A_i))
ecdh       = (a_i · input_hash) · B_scan        = (b_scan · input_hash) · A_i
t_k        = H_tag("TacitJoinSP/SharedSecret", ser_P(ecdh) ‖ ser_32be(k))
P_k        = B_spend + t_k·G                         output scriptPubKey = OP_1 ‖ x(P_k)
```

- The tags are the join's own. A join silent payment never equals a BIP-352 output for the same keys,
  and a standard BIP-352 scanner does not find it.
- `H_P` binds the key to the run's input set. A rerun therefore yields a fresh key, and no script is
  registered twice (§4.5). `H_P` is read from the transaction's inputs, so the recipient has it.
- `k` counts the sender's payments to the same recipient from the same input in one transaction. Labels
  work as in BIP-352, with `B_spend` replaced by `B_spend + label·G`.
- The recipient's spending key is `b_spend + t_k` (plus the label tweak).
- The sender refuses if `A_i = ∞` or `input_hash mod n = 0`.

**Scanning.** For each join-shaped transaction (§2.2), the recipient computes, for each input `i` in turn,
`ecdh_i = (b_scan · input_hash_i) · A_i` and `P_0`, and compares `x(P_0)` against the outputs. On a match
it tries `k = 1, 2, …` until one misses. The cost is one ECDH per input, so at most `k_max` ECDHs per join
transaction.

**Who learns what.** The recipient learns which input paid it, which is inherent in a payment it can
detect alone. Observers, the board and the other participants cannot link: without `b_scan`, `P_k` is
indistinguishable from any other output key of the transaction.

**How the dapp scans.**

- **At the tip.** For each new block, the dapp fetches the block's transactions, keeps the join-shaped
  ones and scans each as above. A board's optional txid log (§11.4) narrows this to logged transactions.
- **By link.** The recipient publishes an invoice link `tacit.finance/sats#sp=<silent address>`. After the
  join confirms, the sender's dapp returns `tacit.finance/sats#jtx=<txid>`, and the recipient's dapp scans
  that one transaction.
- **From the seed.** The dapp rescans join-shaped transactions from the wallet's birth height.

## 4. Output collection: a DC-net shuffle with exclusion

Output keys are collected in a DC-net. Every participant broadcasts a vector that is its message plus
pairwise pads that cancel in the sum, so the sum reveals the set of messages and nothing about who sent
which. Messages are encoded as power sums, so one broadcast carries every message with no slot
reservation. A failed run reveals the run's ephemeral keys. That identifies every disrupter, who is
excluded, and the rest rerun with fresh keys.

### 4.1 Encoding

The field is `F_p`, `p = 2^256 − 2^32 − 977`, the base field of secp256k1. Participant `i`'s message is
`x_i`, the x-coordinate of its output key (§3). It is an element of `F_p` by definition. With `n = |P_r|`,
participant `i`'s clear vector is `(x_i, x_i^2, …, x_i^n)`. The sum over all participants gives the power
sums `S_j = Σ x_i^j`. Newton's identities (`j·e_j = Σ_{m=1..j} (−1)^{m−1} e_{j−m} S_m`) give the
elementary symmetric polynomials, hence:

```
f(X) = Π (X − x_i) = Σ_{j=0..n} (−1)^j e_j X^{n−j}
```

Decoding succeeds iff `f` has `n` distinct roots in `F_p`, that is iff `gcd(f, X^p − X) = f`. The roots
are found by randomized splitting: `gcd(f, (X + δ)^((p−1)/2) − 1)` for random `δ`, recursively. The cost
is `O(n² log p)` field operations, run in a Worker in the dapp.

### 4.2 Keys and pads

Each participant has a **session key** `S_i` (BIP-340, fresh per round), which its JOIN binds to its coin
(§6.2). Every message it sends is signed under `S_i`. Participants are ordered by `S_i` (32 bytes,
ascending).

In each run `r`, each participant samples an ephemeral key `e_i` and publishes `E_i = e_i·G`. Every pair
then shares:

```
k_il       = H_tag("TacitJoin/dh", topic ‖ ser_32be(r) ‖ ser_P(e_i·E_l))           (= k_li)
pad_il[j]  = int(H_tag("TacitJoin/pad", k_il ‖ ser_32be(j) ‖ 0x00) ‖ H_tag("TacitJoin/pad", k_il ‖ ser_32be(j) ‖ 0x01)) mod p
σ_il       = +1 if S_i < S_l, else −1
DC_i[j]    = x_i^j + Σ_{l ≠ i} σ_il · pad_il[j]        mod p,  j = 1..n
```

The pads cancel pairwise, so `Σ_i DC_i[j] = S_j`.

### 4.3 Run steps

Every message is `(topic, r, step, body, view, sig)`. `sig` is a BIP-340 signature under `S_i` over
`H_tag("TacitJoin/msg", topic ‖ ser_32be(r) ‖ step ‖ SHA-256(body) ‖ view)`. `view` is the SHA-256 of
the sorted `(S_l ‖ SHA-256(msg_l))` of the previous step's messages that the sender used. Each step has a
deadline `T_step = 30 s`.

| Step | Body | Receiver checks |
|---|---|---|
| **KE** | `E_i`, `H_P = SHA-256` of `P_r`'s sorted outpoints | `E_i` on curve, not `∞`; `H_P` equals its own |
| **CM** | `C_i = H_tag("TacitJoin/cm", topic ‖ ser_32be(r) ‖ DC_i)` | `view` equals its own |
| **DC** | `DC_i` (n elements of 32 bytes) | Opens `C_i`; `view` equals its own |
| **OK / BLAME** | `OK`, or `BLAME` | `view` equals its own |
| **SIG** | Its input's witness on `T` | Verifies against `T` |
| **REVEAL** (on `BLAME`) | `e_i`, and every signed DC message it received | `e_i·G = E_i` |

- A participant computes `x_i` from `P_r` (§3) after KE and before DC. The commitment in CM fixes every
  vector before any vector is seen. A participant that posted last would otherwise know every honest
  power sum before choosing its own vector.
- After DC, the participant decodes. It posts `OK` iff decoding gives `n` distinct keys, each a valid
  x-only key and none equal to an input's prevout key, and its own `x_i` is among them. Otherwise it posts
  `BLAME`.
- SIG runs only after every member of `P_r` has posted `OK`. So no signature exists for a transaction
  whose run reveals keys.
- The KE signature over `H_P` is the participants' agreement on the input set: a run proceeds only among
  peers that signed the same `H_P`.

### 4.4 Building `T`

Every participant builds `T` itself from `P_r`, the decoded keys, `o` and `h_ref` under §2.2's canonical
ordering, so all honest participants build the identical `T`. Once it holds every witness, any
participant assembles and broadcasts `T`.

### 4.5 Blame and exclusion

A run ends early when a peer misses a deadline, when a received `view` differs from the receiver's own,
when a commitment fails to open, or when someone posts `BLAME`. The next run's set is:

```
P_{r+1} = P_r − (excluded in run r)
```

It is then trimmed to satisfy §2.3's funding rule by dropping remix inputs of highest rank (§6.2). A run
with `|P_{r+1}| < k_min` ends the round.

| Cause | Excluded | Evidence (§8) |
|---|---|---|
| Missing message at a deadline, or a mismatched `view` | The peer whose message is missing, or whose view differs | None (may be the board's fault) |
| Two different signed messages for one step | The signer | The two messages |
| Commitment does not open | The signer | `C_i` and `DC_i` |
| After REVEAL: `DC_l − pads` is not `(y, y², …, y^n)` for a valid x-only `y` | `l` | The run's KE, DC and REVEAL messages |
| After REVEAL: two participants' `y` are equal | Both | The same |
| After REVEAL: every vector is consistent | Every participant that posted `BLAME` | The same |
| No REVEAL by the deadline | The peer | None |
| Missing witness in SIG | The peer | None |

- REVEAL discloses `e_i`, so everyone learns each participant's `x_i` for that run. Those keys are never
  used: `P_{r+1} ≠ P_r`, so §3 yields a fresh key for every participant.
- A run excludes at least one peer whenever it fails, so `f` disrupters cost at most `f + 1` runs.
- After SIG fails, an honest signer's witness for `T_r` exists. If `T_r` is later completed, it pays
  every output correctly and no key was revealed, so it is a valid join. The next run's `T_{r+1}` spends
  the same coin. Whichever confirms first is the round's result, and the wallet tracks both candidate
  outputs.

**Complexity.** One run takes five broadcast steps, plus REVEAL on failure. Each step is `n` broadcasts,
each delivered to `n` peers, so a run is `O(n²)` messages. The DC step sends each participant `n` vectors
of `n` elements: 320 KB at `n = 100`. Pads cost `n²` hashes per participant.

**Anonymity.** For honest `i` and `l` the pads `pad_il` are pseudorandom to everyone else. With at least
two honest participants, the board and all other participants see only the sum of the honest vectors,
and that sum is symmetric in the honest `x`. This holds against the board: it only forwards signed
messages.

## 5. Bulletin board and transport

### 5.1 Board

A board is an HTTP service that stores and forwards signed messages by topic:

| Endpoint | Function |
|---|---|
| `POST /join/v1/<topic>` | Append a message. The board checks the size limit and the signature (JOIN: `own_sig`; others: the session key bound by a JOIN in the topic). |
| `GET /join/v1/<topic>?since=<seq>` | Long-poll messages after `seq`. |
| `GET /join/v1/topics` | Open topics with their JOIN counts. |
| `GET /join/v1/log` | Optional: txids of completed joins per topic. |

The board has a long-term key `K_board`. It signs one message per topic, `CLOSE(topic, last_seq)`,
posted at the first block after `h_ref` plus 60 s. Messages are kept for 24 h.

- **It cannot steal.** Each participant rebuilds `T` and signs only if its output is present (§7).
- **It cannot link.** Output keys exist only inside the DC-net sum (§4).
- **It can deny service.** It can withhold, delay or selectively deliver messages. Those faults surface as
  missing messages or mismatched views. They cost runs and can exclude honest peers, and the round can
  fail. A client that sees a board fail repeatedly moves to another.
- **It can split a round.** An equivocating `CLOSE`, or selective delivery, can leave participants with
  different input sets. Peers proceed only with those that signed the same `H_P` (§4.3), so each part is a
  separate round and must meet `k_min` on its own.

Anyone can run a board. Tacit runs one on `worker-relay`. A round is scoped to one board, because the
topic commits `K_board`. The dapp ships a board list, `join-boards.json`, pinned with the dapp bundle.
Each entry gives `(K_board, clearnet URL, onion URL, tiers)`, and the user can add others.

### 5.2 Transport

- **Tor recommended.** A board sees the network address of each connection, and so learns the addresses
  of the input owners. It never learns output ownership: the shuffle hides that regardless of transport.
  The dapp connects to a board's onion URL when it runs in Tor Browser, and otherwise warns that the
  board will see the user's IP address beside the user's inputs.
- **One connection per participant suffices** for unlinkability. A client running several participants
  over one connection lets the board link those inputs to one owner. It does not let the board link
  their outputs. For hardening, the CLI isolates each participant on its own SOCKS credential
  (`IsolateSOCKSAuth`), and the dapp uses a separate onion connection per participant when the board
  publishes several onion URLs.
- Requests carry no cookies, no credentials and no client identifiers (`credentials: 'omit'`, no custom
  headers).
- **Timing.** A client's participants post their JOINs at independent delays, each uniform in the time
  remaining before the expected close. Within a run, each message is posted at an independent uniform
  delay in `[0, 0.3·T_step]`.

## 6. Round protocol

### 6.1 Topics

```
topic = H_tag("TacitJoin/topic", network ‖ d(8) ‖ fr(2) ‖ h_ref(4) ‖ K_board(32))
```

`h_ref` is the height of the chain tip when the participant posts its JOIN. At the round's close, clients
still waiting for a round repost their JOINs under the next `h_ref`. Every other parameter follows from
`(d, fr)` and the constants in §2: `o`, `f_in`, `k_min`, `k_max`, `T_step`.

### 6.2 JOIN and formation

```
JOIN    = (topic, outpoint, prevout_value(8), prevout_spk, pubkey33 if P2WPKH, S_i, own_sig)
own_sig = BIP-340 over H_tag("TacitJoin/own", topic ‖ outpoint(36) ‖ prevout_spk ‖ S_i)
```

`own_sig` is made under the coin's key: the x-only P2TR output key, or the P2WPKH compressed pubkey, which
must satisfy `HASH160(pubkey33) = spk[2..22]`. It proves control of the coin and binds the coin to this
topic and this session key.

**Formation.** Each participant computes `P_1` from the JOINs with sequence up to the board's `CLOSE`:

1. **Valid.** The signature verifies. The prevout is unspent, has at least one confirmation, and matches
   value and spk. The type is allowed. The input meets §2.3's admission rule for its class. The outpoint
   is unique among the JOINs and has no verified evidence on this board (§8).
2. **Rank.** `ρ = H_tag("TacitJoin/rank", topic ‖ outpoint)`, ascending.
3. **Fresh pass.** Walk fresh JOINs by rank. Add each one whose `txid` is not already among the chosen
   fresh inputs, up to `k_max`.
4. **Remix pass.** Walk remix JOINs by rank. Add each one while `|P| < k_max` and §2.3's funding rule
   still holds.
5. If `|P_1| < k_min`, there is no round in this topic.

Run 1 begins with KE, whose `H_P` commits `P_1`.

### 6.3 Runs

| Phase | Duration | Content |
|---|---|---|
| Gathering | Until `CLOSE` | JOINs |
| Run `r` | ≤ 6 × `T_step` | KE, CM, DC, OK/BLAME, SIG (+ REVEAL) (§4.3) |
| Broadcast | Immediate | Any participant broadcasts `T` and may post its txid to the board's log |

A round ends when `T` is broadcast, or when `|P_r| < k_min`.

## 7. What a client verifies before signing

The client builds `T` itself (§4.4) and signs only if every check passes:

1. `T.nVersion = 2`, `T.nLockTime = h_ref`, every `nSequence = 0xfffffffd`.
2. `T`'s inputs are exactly `P_r`, and `P_r` satisfies §2.3's funding rule and `|R| ≤ |Φ|`.
3. `T` has exactly `|P_r|` outputs, each P2TR at value `o`.
4. **Each of its own outputs is present exactly once, at value `o`, with the scriptPubKey it derived.**
5. `k_eff(P_r) ≥ k_min_client` (§10.1).
6. Its own excess is within §2.3's ceiling, and `fr ≤ 2·fr_own`.
7. `T` is at most 400,000 WU and its fee rate is at least `fr`.

It then signs its input: `SIGHASH_DEFAULT` for P2TR (BIP-341 commits every input's amount and
scriptPubKey and every output), `SIGHASH_ALL` for P2WPKH (BIP-143 commits its own amount and every output).

**J1 follows.** A participant's signature is valid only on `T`. `T` pays its output (check 4). Its outlay
is `v_in − o`, which it fixed itself when it chose the coin. What the miner or anyone else receives from
other inputs does not change it.

## 8. DoS and exclusion

There is no central ban list. Each client keeps a **local exclusion list** of outpoints. Offense `m` of an
outpoint excludes it for `24 h × 2^(m−1)`, at most 30 days. An exclusion extends one hop, to every output
of a later transaction that spends the excluded outpoint. The client declines to sign a KE whose `H_P`
includes a coin on its list. It then continues with the peers that share its view.

**Evidence** is a message any participant may post to the board:
`EVIDENCE(outpoint, kind, bundle)`. Every client verifies it independently before acting on it. Verified
evidence on a board removes the coin from formation on that board (§6.2), deterministically for everyone
who sees it.

| Kind | Bundle | Verification |
|---|---|---|
| Equivocation | The JOIN and two differently signed messages for one step | Both signatures verify under the JOIN's `S_i` |
| Bad vector | The run's JOINs, KE, DC and REVEAL messages | Recompute the pads; the vector is inconsistent (§4.5) |
| False blame | The same | Every vector is consistent, and the peer posted `BLAME` |
| Double-spend after signing | The peer's signed witness on `T` and the confirmed conflicting transaction | The witness verifies on `T`; the conflict spends the coin |

A missing message or witness is never evidence, because the board may have withheld it. It excludes the
peer from the next run only, and the client adds it to its own local list.

| Vector | Handling |
|---|---|
| Flood JOINs | Each JOIN needs `own_sig` over a confirmed coin of the tier's value. A coin JOINs a topic once. |
| Disrupt a run | Excluded by §4.5, with evidence where it is attributable. Each disrupting slot needs its own confirmed coin. |
| Withhold after signing, or double-spend | Excluded. Double-spending is evidence. The rest rerun. |
| Malicious board | Denial of service only (§5.1). |

## 9. Fees

### 9.1 Mining

There is no protocol fee and no coordinator fee. Each fresh input pays its own bytes and its share of the
fixed bytes at `fr` (§2.3). Remix inputs pay from their own allowance surplus, and fresh margins cover
the rest. A stuck `T` is bumped by any participant spending its own output (CPFP). That spend is a
post-mix spend and falls under §9.2.

### 9.2 Participant costs and post-mix rules

A participant's full cost per mixed output is its entry transaction's share, `f_in`, its margin, and the
allowance `a(fr)` it keeps in the output. The wallet enforces:

- Mixed outputs form their own coin class. They are never co-spent with unmixed coins or entry change.
- Two mixed outputs are co-spent only when the user confirms it. The wallet warns that co-spending links
  them to one owner.
- A mixed output pays one destination per spend by default. A peg-in of `d` spends one mixed output with
  no change (§11.3).

## 10. Leakage and assumptions

| Hidden | Public |
|---|---|
| Which output belongs to which input | That `T` is a join: `n` equal P2TR outputs at a tier value |
| Output keys' relation to any address the participant publishes | Every input: outpoint, value, type, and its entry transaction's other outputs and change |
| | Tier, fee bucket, `n`, time |

**What the board learns.** Every JOIN and its timing, which peers completed which steps, and the set of
output keys. With clearnet access it also learns the connecting addresses (§5.2). Nothing links an output
to an input.

### 10.1 Sybils

A participant's anonymity set is the number of honest participants in the final run, not `n`. An
adversary that fills a round deanonymizes the honest remainder, and nobody can detect it. Its cost per
round is set by fees alone. For `s` sybil slots against `h_f` honest fresh inputs, the cap `|R| ≤ |Φ|`
forces `s_f ≥ ⌈(s − h_f)/2⌉` of them to be fresh:

```
C_sybil(s) ≥ s_f · (f_in(fr, P2TR) + e(fr)),     e(fr) = ⌈43 · fr⌉  (one entry output)
```

It must also lock `s·o` for the round and hold confirmed coins aged `age_min` blocks beforehand. At
`fr = 10` and `n = 50`, isolating one fresh participant costs at least 24 × 1,455 ≈ 35,000 sats per
round.

The client limits this exposure three ways:

- **`k_min`.** The client counts
  `k_eff(P) = |{distinct txid among fresh inputs aged ≥ age_min}| + |{distinct parent txid among remix inputs aged ≥ age_min}|`,
  with `age_min = 6`, and signs only if `k_eff ≥ k_min_client`. `k_min_client` defaults to `k_min`, and the
  user can raise it.
- **Round preference.** Among open topics of its tier and bucket, the client prefers the one with more
  valid JOINs from distinct, aged txids, across every board on its list.
- **Rotation and remixing.** A coin remixes through rounds on different boards chosen at random from the
  board list, and never on the same board twice in a row. Linking a coin's final output to its origin
  requires sybilling every round on its path. The adversary's cost therefore adds up round by round, and
  it must keep up that dominance on every board the coin passes through.

### 10.2 Other limits

- **Transport.** Against a global passive adversary that watches the board's traffic, timing links a
  connection's JOIN to its later messages. Those messages carry no output-to-input information, so the
  shuffle still hides the mapping.
- **Post-mix behaviour.** Co-spending, consolidating, spend timing and amount patterns after the round
  link outputs again. The output value `o` identifies a coin as a join output.
- **Several inputs, one client.** A client with several inputs in one round reveals nothing to the chain.
  Their outputs are linked to one owner if they are later co-spent.
- **Liveness.** A board or a disrupter can delay a round. Neither can take a coin.
- **Cryptography.** BIP-340 and ECDSA unforgeability over secp256k1; CDH on secp256k1 and the tagged hash
  as a PRF for the pads; BIP-352's own assumptions for output privacy.

## 11. Relationship to the rest of Tacit

### 11.1 Tacit notes never enter a join

A join transaction carries no envelope, so every Tacit UTXO it spends is destroyed (SPEC §3.2). The client
refuses to JOIN any coin that `validateOutpoint` marks as a Tacit UTXO, any envelope commit output, and
any coin the wallet knows to carry another protocol's value.

### 11.2 Join and shielded pool

| | Join | Shielded pool |
|---|---|---|
| Holds | Real sats, in the participants' own outputs | Tacit asset value (cBTC, pBTC, any asset) |
| Amounts | Tier values, public | Arbitrary, hidden, including at the boundary |
| Anonymity set | Honest participants of one round, compounding across remixes | Every note of the asset in the tree |
| Trust for funds | Bitcoin consensus and each participant's own check | The relation, SP1 and Groth16, and the asset's backing |
| Interaction | Every participant online for one round | None; one party proves a spend |
| Post-mix discipline | Required | None inside the pool |
| On-chain footprint | A recognizable join transaction, no envelope | Tacit envelopes |
| Cost | Entry share, about 103–113 vB of fee, margin, allowance `a(fr)` | Carrier fees, proof |

They are complementary. The join gives unlinkable real sats at fixed sizes with no asset trust. The pool
gives full unlinkability at any amount for value that is a Tacit asset. The join is a clean on-ramp to the
pool's boundary.

### 11.3 Join outputs at the pool's boundary

- **Buy-and-shield** (peg §1.1). A mixed output is the BTC input that pays a pre-authorized lot inside a
  `T_BTC_SHIELD` carrier. The lot's price is public, but the payer's history before the join is not.
- **Key-share swap** (peg §1.2). A mixed output funds `lock`. The BTC leg then has no history.
- **Peg-in** (peg §2.4). A tier 1–3 output of value `d + a(fr)` funds the deposit transaction:

| Field | Value |
|---|---|
| `nVersion` | 3 (BIP-431) |
| Input | The mixed output, key-path |
| Output 0 | `d` to `spk_dep` |
| Output 1 | 240 sats to the pay-to-anchor script `OP_1 0x4e73` |
| Fee | `a(fr) − 240`: `fr` at 124 vB |

The deposit's `txid` is fixed before signing, so the committee presigns against it as peg §2.4 requires.
Output 1 is the deposit's anchor, matching the anchor outputs on the peg's presigned transactions (peg
§1.2). When fees have risen since the join, anyone bumps the deposit by CPFP through the anchor: the
depositor, an operator or a relayer. The `txid` the graph commits does not change. The canonical wallet
funds the child from a mixed coin only, and warns that the child links that coin to the deposit.
Otherwise it leaves the bump to a relayer.

### 11.4 Envelope marking: none

A round is not recorded in a Tacit envelope. An envelope needs a script-path `vin[0]` spending a commit
output that someone funds. That input is not uniform, is not BIP-352-eligible, and links its funder to
the round. It would add nothing the chain does not already show. A recovering wallet scans join-shaped
transactions (§2.2) with its scan key: for own outputs with `receiverScanTxForSilentPayments`, and for
join silent payments per input (§3.2). The board's optional txid log narrows the scan. The log is
unsigned and needs no trust, because every entry is checked against the chain. The Tacit indexer treats
join transactions as plain Bitcoin transactions and creates no state for them.

The legacy fixed-denomination mixer (`T_DEPOSIT`/`T_WITHDRAW`, SPEC §3.8) mixes Tacit notes under a
ceremony circuit. The join is unrelated to it and uses no Tacit opcode.

## 12. Rollout

1. **Client module** `dapp/secret-sats-join.js`: tier and bucket tables, window and funding math, entry
   builder, formation, the DC-net (pads, commitments, power-sum decoding in a Worker, blame), forward
   BIP-352 derivation over `P_r`, join silent payments (send and scan), pre-signing checks, signing, and
   the local exclusion list. Tests: BIP-352 reference vectors through the forward path, join-SP vectors,
   DC-net encode/decode vectors at `n = 3..k_max`, and an adversarial suite in which the client must
   refuse, exclude the right peer, or both, every time. The suite covers an inconsistent vector, false
   blame, duplicated keys, a commitment that fails to open, equivocation, selective delivery, a split
   `CLOSE`, a missing output, an altered output value or script, an extra input, and a funding-rule
   violation.
2. **Bulletin board** `worker-relay/src/join-board.js`: the §5.1 endpoints, signature and size checks,
   `CLOSE` at block arrival, 24 h retention, the optional txid log, and an onion service beside the
   clearnet endpoint. It holds no funds and no participant key, and is packaged so anyone can run it.
   Tacit hosts one on the `worker-relay` stack.
3. **Signet.** `k_min = 3`, `k_max = 20`. Drive complete rounds, reruns after every §4.5 exclusion cause,
   remix rounds, join silent payments and a peg-in with an anchor bump, all with real transactions. Then
   recover every output from the seed.
4. **Dapp flow** on `tacit.finance/sats`: a Join panel with board choice, tier and bucket choice, entry
   transaction, live run status, the verification summary before signing, the mixed-coin class in the
   wallet, the send-to-silent-address option, and invoice links. The post-mix actions offered are remix,
   buy-and-shield, key-share swap and peg-in.
5. **Reference CLI** in `tools/` with per-participant SOCKS isolation.
6. Independent review of the client checks and the shuffle, then mainnet with tiers 0 and 1. Tier 2
   follows once tier 0–1 rounds fill at `k_min`, and tier 3 after that.
