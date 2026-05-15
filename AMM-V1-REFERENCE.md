# AMM V1 Reference

Three companion sections for evaluators, dapp implementers, and operators:

1. **Security properties** — one-page summary of what V1 protects against and
   the specific cryptographic mechanism for each attack vector.
2. **Dapp implementer's checklist** — consolidated normative
   `MUST` / `SHOULD` requirements scattered across AMM.md, in one place.
3. **Failure-mode catalog** — what breaks when, and how to recover.

These are *informative reference docs* — the normative spec is AMM.md and the
SPEC-*-AMENDMENT.md files. This file collects derived guidance for
implementers and operators.

---

## 1. Security properties

Each row: attack vector → specific defense.

| Attack | Defense |
|---|---|
| **Settler steals trader funds** | Trader's `SIGHASH_ALL` sig binds to `vout[0] OP_RETURN = SHA256(envelope_payload)`. Settler cannot alter the envelope post-sign without invalidating every trader's sig. |
| **Settler substitutes per-trader amount** | Per-intent BJJ Pedersen opening enforces `C_in_BJJ = (amount_in_swap + tip)·H + r·G` in-circuit; sigma cross-curve binds to chain-side `C_in_secp`. Settler cannot claim a different amount than the trader committed. |
| **Settler fakes `P_clear`** | `P_clear_num` / `P_clear_den` derived in-circuit from private aggregates `X`, `Y` + public `Δa_net`, `Δb_net`, `R_A_pre`, `R_B_pre`. Chain-side aggregate Pedersen identity binds the totals. Settler has no pricing freedom. |
| **Settler computes wrong `amount_out`** | Division-with-remainder constraint `amount_in_swap · multiplier ≡ amount_out · divisor + rem` with `rem < divisor` (`Num2Bits(69)` range proofs on both). Forced to the deterministic `P_clear` solve. |
| **Settler claims wrong tip** | Per-intent `tip_amount_witness === tip_amount` (public, BIP-340-signed in `intent_msg`). Aggregate `tip_A` / `tip_B` checked in-circuit. |
| **Settler swaps two traders' commitments** | Each intent's `cInSecp`/`cInBjj` is part of the signed `intent_msg`. Re-ordering breaks intent_sig verification. |
| **Settler exploits padding slots (N<16)** | Padded slots use BJJ identity `(0, 1)` and zero amounts; non-identity in a padded slot is rejected by adversarial test 28. Indexer matches each non-padded slot to a signed intent. |
| **Settler burn-griefs trader UTXO** (broadcasts Bitcoin-valid but tacit-invalid tx) | Mandatory `vout[0] OP_RETURN(envelope_hash)` + trader's `SIGHASH_ALL` over their inputs commits the trader to a specific envelope. A different envelope breaks the sig. |
| **Settler double-init pool** | Indexer rejects `T_LP_ADD variant=1` against an existing `pool_id`. |
| **Settler cross-pool replay** | `pool_id_fr` is a public-signal in every Groth16 proof; verifies against the pool's pinned `vk_cid`. A proof against pool A's vk cannot verify against pool B's. |
| **Intra-batch sandwich / priority-fee MEV** | Uniform clearing — every intent in a batch settles at the same `P_clear`. Intent ordering is by `intent_id`, not tip. Frontrun gets the same price as the victim. |
| **Cross-batch curation MEV** (settler excludes intents for own benefit) | Bounded, not eliminated. Defenses: (a) tip economics — excluded intents leave tip revenue for less-curating competitors; (b) opt-in m-of-n arbiter — pools that pin arbiters require mandatory-inclusion of qualifying-set under m-of-n signed list; (c) arbitrage realignment — curation-induced spot drift creates arbitrage in next batch. |
| **Subset-selection MEV** (settler picks adversarial subset) | Tip economics + arbiter (above). Worst case is delayed inclusion + bounded slippage drift, never value extraction or burn. |
| **First-LP misprice attack** (malicious founder seeds bad ratio) | Protocol-level: `AMM_INITIAL_LP_LOCK_BLOCKS = 6` window rejects all variant-0 `T_LP_ADD` after `POOL_INIT`. Swaps continue → arbitrage corrects bad ratio. Founder bears arbitrage cost on their own seed. Dapp-level: warns on low-TVL pools; orderbook cross-check; future oracle. |
| **Solo-batch privacy collapse** (N=1) | Dapp MUST warn the user that solo-batched amounts are inferable from public deltas. |
| **Worker DoS** (drops, reorders, delays intents) | Cannot decrypt openings or forge sigs. Bounded to delaying soft-confirm UX, not soundness. Mitigation: traders register with ≥ 2 workers. |
| **Worker equivocation** (signs two `T_INTENT_ATTEST` roots at same scope/height) | Indexer flags worker as equivocator on detection at depth-1. Soft-confirm clients reject equivocator's attestations. |
| **Arbiter compromise** (single key) | m-of-n threshold (m ≥ 2) requires quorum collusion. m=1 is liveness-only, NOT BFT — dapp warns at pool creation. MuSig2 off-chain pattern available for compact m-of-n. |
| **Sigma cross-curve forgery** | 128-bit Fiat-Shamir soundness (≈ 2^128 SHA256 evals for forgery). Symmetric with rest of stack. Upgraded from 80-bit pre-V1. |
| **Non-subgroup BJJ Pedersen attack** | `unpackPoint` enforces `n_BJJ · P == identity` check on every BJJ commitment unpack. Cofactor-coset (small-order, 2·n_BJJ-order) points rejected — defeats binding attacks via co-factor torsion. |
| **Duplicate `intent_id` in batch** | Strict-ascending check in validator + encoder. Defense in depth: Bitcoin's UTXO model already prevents two intents from consuming the same outpoint, but validator enforces explicitly. |
| **Stale Groth16 proof reuse** | Pool's `vk_cid` pinned at `POOL_INIT`, immutable. Each pool's proofs verify only under that vk. Different ceremony → different vk → no replay. |
| **Mandatory-inclusion bypass** (arbiter-pinned pool) | Validator fail-closed: rejects envelope if `qualifyingSetResolver` is null or list-bytes mismatch the on-chain `qualifying_set_hash`. Every qualifying `intent_id` MUST appear in batch. |
| **Bridge attack on cBTC** | OUT OF AMM SCOPE — handled by the cBTC wrapper's own trust model (`SPEC-WRAPPER-AMENDMENT.md`, `CBTC-ISSUER-DESIGN.md`). AMM treats cBTC as a generic tacit asset. |

### Cryptographic strength summary

| Primitive | Strength |
|---|---|
| BIP-340 Schnorr | ≈128-bit DLP |
| Pedersen binding (secp256k1) | ≈128-bit DLP |
| Pedersen binding (BabyJubJub) | ≈125-bit DLP (n_BJJ ≈ 2^251) |
| Bulletproof range proofs | ≈128-bit |
| Sigma cross-curve binding | 128-bit Fiat-Shamir + ≈128-bit statistical ZK |
| Groth16 over BN254 | ≈100-110-bit knowledge-soundness in AGM |
| SHA-256 (domain tags, commitments) | ≈128-bit collision |

No primitive sits below ~100 bits. The weakest link is Groth16-BN254's
knowledge-soundness (AGM, ~100-110 bits); upgrading to a stronger curve
(BLS12-381) is a V2 ceremony.

---

## 2. Dapp implementer's checklist

Every `MUST` / `SHOULD` requirement the spec places on the trader-facing
dapp, consolidated. Implementers building a V1 dapp use this as their
acceptance checklist.

### Pool browser / discovery

- [ ] **MUST** surface `pool_id`, `asset_A`, `asset_B`, `fee_bps`,
      `reserve_A`, `reserve_B`, `lp_total_shares` at minimum.
- [ ] **MUST** show `init_height` and "minutes until LP unlock" countdown
      for pools younger than `AMM_INITIAL_LP_LOCK_BLOCKS` (~1 hour).
- [ ] **SHOULD** parse and surface `pool_meta_uri` if present (name,
      description, logo, website — informational only).
- [ ] **SHOULD** surface protocol-fee status: if `protocol_fee_bps > 0`,
      show the recipient and accrued amount.
- [ ] **SHOULD** surface arbiter posture: if `inclusion_arbiter_pubkeys.length > 0`,
      show `m-of-n` and signer identities (if known).
- [ ] **SHOULD** display pool age, recent volume, recent settler-tip
      averages (if known to indexer).

### Pool creation (`POOL_INIT`)

- [ ] **SHOULD** default `inclusion_arbiter_pubkeys` to `[]` (no arbiter) —
      arbiter-pinned pools are an opt-in deliberate choice.
- [ ] **MUST** warn at pool-creation time if `inclusion_arbiter_pubkeys.length == 1`
      ("fragile: single key compromise kills mandatory-inclusion").
- [ ] **MUST** explain `AMM_INITIAL_LP_LOCK_BLOCKS` to the founder (no
      external LPs for the first ~1 hour).
- [ ] **SHOULD** offer `pool_meta_uri` field for cosmetic metadata.

### Intent posting (`T_SWAP_BATCH` trader path)

- [ ] **MUST** surface the chosen settler's operator identity (pubkey +
      human-readable label) before the trader signs RTT-1.
- [ ] **MUST** surface a hard warning if the chosen settler's operator
      matches the worker operator the trader is connected to ("this settler
      can see your cleartext amount") and require explicit confirmation.
- [ ] **SHOULD** prefer a settler distinct from the worker operator as
      the default selection when ≥ 2 settlers are registered.
- [ ] **MUST** surface a hard warning when the candidate batch's
      `n_intents == 1` (solo-batch privacy collapse — trader's amount is
      publicly inferable from batch deltas).
- [ ] **MUST** display `min_out` and the expected fill at current
      `P_clear`; offer slippage tolerance input.
- [ ] **SHOULD** offer settler-tip input with a recommended default
      based on indexer-tracked recent tip-revenue averages.
- [ ] **MUST** enforce that trader's input UTXOs sum exactly to
      `amount_in_swap + tip_amount` (no change-output support in
      `T_SWAP_BATCH`). If trader's available UTXO is larger, dapp **MUST**
      pre-split via CXFER before posting.
- [ ] **SHOULD** respect dapp-level pool-maturity filter (don't surface
      low-TVL or pre-mature pools by default; warn if user navigates to
      one).
- [ ] **SHOULD** surface low-TVL warning ("initial price may be
      mispriced; check against orderbook/oracle") below dapp-configured
      threshold.

### LP_ADD / LP_REMOVE

- [ ] **MUST** reject `LP_ADD variant=0` against a pool where
      `currentHeight < init_height + AMM_INITIAL_LP_LOCK_BLOCKS`. The
      indexer will reject too; the dapp **MUST** surface this clearly to
      avoid wasted Bitcoin fees.
- [ ] **MUST** show the at-the-ratio share calculation and the resulting
      `lp_asset_id` UTXO before submission.
- [ ] **SHOULD** offer mixer composability prompt: "anonymize your LP
      shares before withdrawal" (deposit `lp_asset_id` UTXO into the
      mixer pool of matching denomination).
- [ ] **MUST** warn LPs joining pools with protocol fees that they must
      query the indexer's current `k_last` and `protocol_fee_accrued`
      pre-compute the crystallized `S` themselves.

### T_INTENT_ATTEST consumption

- [ ] **SHOULD** maintain a "trusted workers" list (user-configurable);
      reject attestations from non-trusted workers.
- [ ] **MUST** track equivocator-flagged workers and reject their
      attestations.
- [ ] **MUST** check attestation timestamp freshness against a
      configurable TTL (default 5 min); surface "stale" status if older.
- [ ] **SHOULD** verify membership inclusion via the sorted intent-id
      list fetched from the worker's `snapshot_uri`; hash to confirm
      against on-chain `intent_pool_hash`.

### T_RANGE_ATTEST production (optional power-user feature)

- [ ] **SHOULD** offer a "publish range attestation" UI for advanced users
      who want to build reputation, KYC tier proofs, etc.
- [ ] **MUST** explain the privacy trade-off: `commitment_outpoints` link
      the holder's UTXOs to the attestation publisher. Users wanting
      unlinkable attestations should mix UTXOs first.

### Settler selection

- [ ] **SHOULD** auto-rotate the default settler across batches to avoid
      single-operator concentration.
- [ ] **SHOULD** show settler reputation indicators (recent fill rate,
      published `settler_meta_uri` metadata, batches settled in last
      24 h) if indexer surfaces them.

---

## 3. Failure-mode catalog

What happens when X breaks, and how to recover.

### Worker offline

**Symptom:** Trader can't post intent; soft-confirm channel stops
publishing.

**Recovery:**
- Trader connects to alternate worker(s). Spec recommends ≥ 2 workers
  per dapp for redundancy.
- Settlement is independent of worker; hard-confirm path (settler RTT-1/RTT-2)
  still works if trader directly contacts a settler.
- Worker downtime DOES NOT affect existing pool state or in-flight
  settlements.

### Settler races (two settlers claim same batch)

**Symptom:** Two settlers publish overlapping `T_SWAP_BATCH` envelopes for
the same intent subset; only one confirms.

**Recovery:** Standard Bitcoin tx-fee race — higher-fee envelope confirms,
loser wastes proof work. Off-chain coordination (e.g., worker advertises
"next settler in rotation") reduces frequency. Not a soundness issue.

### Reorg during batch confirmation

**Symptom:** Batch confirmed at height H gets rolled back; chain reorgs
to alternate fork.

**Recovery:**
- `AMM_OP_CONFIRMATION_DEPTH = 3`: indexer waits 3 blocks before
  applying state changes. Shallow reorgs handled before state mutates.
- Deeper reorgs: indexer rolls back to last common ancestor, replays
  forward. Spec §"Reorg handling" details the deterministic replay rule.
- For arbiter pools: `qualifying_set_hash` + `arbiter_sigs` are
  height-bound but reorg-stable (claims about state at H). Re-applied
  envelope at new height H' may need fresh signatures from arbiters.

### Arbiter key compromise

**Symptom:** Pool's arbiter quorum has a compromised key (m-of-n with
m ≥ 2 still has m-1 honest keys).

**Recovery:**
- If m=1: compromised key can curate. Pool's mandatory-inclusion
  guarantee is broken. Pool launcher SHOULD rotate by initializing a
  new pool with replacement keys (existing pool's arbiter is
  immutable at POOL_INIT). LPs drain to new pool.
- If m ≥ 2: single key compromise is bounded — adversary needs
  m-1 additional keys to curate. m=⌈n/2⌉+1 gives BFT defense.
- Spec considers stake-based slashing for arbiter equivocation as V2+
  amendment.

### Ceremony bug discovered post-launch

**Symptom:** Vulnerability in `amm_swap_batch.circom` is found after V1
ceremony.

**Recovery:**
- All existing pools using the affected vk_cid are at risk; depending
  on bug severity, pools may need to be drained.
- Drain procedure: LPs use `T_LP_REMOVE` (still verifies via existing
  vk) to exit at current reserves. Pool reaches empty state and is
  effectively retired.
- A fresh Phase 2 ceremony produces a new vk_cid; pools created against
  the new vk_cid are unaffected.
- `drift-guard.test.mjs` pins source + R1CS hashes pre-launch to
  prevent accidental drift from ceremony source.

### cBTC bridge halt

**Symptom:** cBTC issuer multisig halts; no new wrap/unwrap available.

**Recovery:**
- Existing cBTC UTXOs continue to function in tacit (mixer, AMM,
  CXFER, orderbook). The protocol layer doesn't know or care about
  bridge state.
- AMM cBTC pools continue trading; LPs can exit; new LP_ADDs continue.
- Affects only the user's ability to bring fresh BTC in / move cBTC out
  to BTC. UX feature, not protocol failure.

### Settler abandons mid-RTT (after RTT-1, before RTT-2)

**Symptom:** Settler stops responding after collecting trader's RTT-1
encrypted opening blob; never produces the assembled batch.

**Recovery:**
- Trader's `intent_sig` and encrypted opening are still valid; trader
  can re-submit to a different settler.
- `AMM_RTT_TIMEOUT_MS = 5000` default; dapp times out and retries.
- `AMM_RESIGN_ATTEMPTS = 2` retries with fresh nonces.
- No funds at risk — trader's input UTXOs are not yet committed
  on-chain. They remain spendable.

### Trader signs RTT-1 then refuses RTT-2 (griefing)

**Symptom:** Settler has built candidate batch with N intents; one
trader refuses to provide RTT-2 `SIGHASH_ALL` sig.

**Recovery:**
- Settler drops the refusing trader's intent from the subset, re-runs
  clearing solve, builds new candidate batch with N-1 traders,
  re-solicits RTT-2 from remaining.
- Trader who refused: their intent doesn't settle; they lose nothing
  but their tip is also not earned by the settler. Bounded griefing
  cost: re-collection round-trip latency.

### Indexer disagreement (two indexers see different pool state)

**Symptom:** Two indexers tracking the same chain produce different
pool state.

**Recovery:**
- Spec §"Indexer determinism rules" defines the canonical state-transition
  function. Any disagreement indicates a bug in one indexer.
- Cross-impl test vectors (`ops/planning/CROSS-IMPL-TEST-VECTORS.md`)
  pin canonical (input → output) pairs for every state-mutating
  envelope; running them on any indexer reveals which side is broken.

### Equivocation by worker on `T_INTENT_ATTEST`

**Symptom:** Worker signs two attestations with same
`(scope_id, worker_pubkey, observed_height)` but different
`intent_pool_hash`.

**Recovery:**
- Indexer detects on second attestation arrival, flags worker as
  equivocator.
- Dapp clients with equivocator-aware checks reject all subsequent
  attestations from the flagged worker.
- Soft-confirm UX from that worker becomes unavailable; hard-confirm
  settlement path is unaffected.

### Sigma cross-curve forgery (theoretical, ≈ 2^128 work)

**Symptom:** Adversary forges a 128-bit Fiat-Shamir challenge.

**Recovery:** Equivalent to breaking 128-bit SHA-256 preimage
resistance — well beyond any feasible adversary. If somehow achieved,
all tacit primitives using sigma protocols become suspect.

### BJJ subgroup attack

**Symptom:** Adversary submits non-subgroup BJJ commitment hoping to
exploit cofactor structure.

**Recovery:** `unpackPoint` enforces `n_BJJ · P == identity` check.
Non-subgroup points return null; envelope decode fails; rejected. No
attack surface.

### vk_cid pinning failure (indexer fetches wrong vk)

**Symptom:** Indexer's IPFS resolution returns wrong content for
pool's pinned `vk_cid`.

**Recovery:**
- Cross-check: indexer SHOULD verify `SHA-256(vk_bytes) == vk_cid` (CIDv1
  encodes the hash directly). Wrong content fails this check.
- Multiple IPFS gateways + content addressing: any working gateway
  returns the same canonical bytes.
- Worst case: indexer can't reach any gateway. Indexer halts AMM
  processing for affected pool until vk is resolved. Pool state freezes
  rather than corrupting.

---

End of reference.
