# tacit AMM — failure-mode catalog

What happens when each component breaks and how to recover.
Operational reference; companion to [`AMM.md`](../../AMM.md).


What happens when X breaks, and how to recover.

## Worker offline

**Symptom:** Trader can't post intent; soft-confirm channel stops
publishing.

**Recovery:**
- Trader connects to alternate worker(s). Spec recommends ≥ 2 workers
  per dapp for redundancy.
- Settlement is independent of worker; hard-confirm path (settler RTT-1/RTT-2)
  still works if trader directly contacts a settler.
- Worker downtime DOES NOT affect existing pool state or in-flight
  settlements.

## Settler races (two settlers claim same batch)

**Symptom:** Two settlers publish overlapping `T_SWAP_BATCH` envelopes for
the same intent subset; only one confirms.

**Recovery:** Standard Bitcoin tx-fee race — higher-fee envelope confirms,
loser wastes proof work. Off-chain coordination (e.g., worker advertises
"next settler in rotation") reduces frequency. Not a soundness issue.
The narrow disjoint-subset variant where both Bitcoin-confirm is
documented at §"Caveats".

## Reorg during batch confirmation

**Symptom:** Batch confirmed at height H gets rolled back; chain reorgs
to alternate fork.

**Recovery:**
- `AMM_OP_CONFIRMATION_DEPTH = 3`: indexer waits 3 blocks before
  applying state changes. Shallow reorgs handled before state mutates.
- Deeper reorgs: indexer rolls back to last common ancestor, replays
  forward. See §"Indexer determinism rules" → §"Reorg safety" for the
  per-baseline depth-3 pinning table.

## Ceremony bug discovered post-launch

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

## cBTC bridge halt

**Symptom:** cBTC issuer multisig halts; no new wrap/unwrap available.

**Recovery:**
- Existing cBTC UTXOs continue to function in tacit (mixer, AMM,
  CXFER, orderbook). The protocol layer doesn't know or care about
  bridge state.
- AMM cBTC pools continue trading; LPs can exit; new LP_ADDs continue.
- Affects only the user's ability to bring fresh BTC in / move cBTC out
  to BTC. UX feature, not protocol failure.

## Settler abandons mid-RTT (after RTT-1, before RTT-2)

**Symptom:** Settler stops responding after collecting trader's RTT-1
encrypted opening blob; never produces the assembled batch.

**Recovery:**
- Trader's `intent_sig` and encrypted opening are still valid; trader
  can re-submit to a different settler.
- `AMM_RTT_TIMEOUT_MS = 5000` default; dapp times out and retries.
- `AMM_RESIGN_ATTEMPTS = 2` retries with fresh nonces.
- No funds at risk — trader's input UTXOs are not committed on-chain
  in this state. They remain spendable.

## Trader signs RTT-1 then refuses RTT-2 (griefing)

**Symptom:** Settler has built candidate batch with N intents; one
trader refuses to provide RTT-2 `SIGHASH_ALL` sig.

**Recovery:**
- Settler drops the refusing trader's intent from the subset, re-runs
  clearing solve, builds new candidate batch with N-1 traders,
  re-solicits RTT-2 from remaining.
- Trader who refused: their intent doesn't settle; they lose nothing
  but their tip is also not earned by the settler. Bounded griefing
  cost: re-collection round-trip latency.

## Indexer disagreement (two indexers see different pool state)

**Symptom:** Two indexers tracking the same chain produce different
pool state.

**Recovery:**
- §"Indexer determinism rules" defines the canonical state-transition
  function. Any disagreement indicates a bug in one indexer.
- Cross-impl test vectors (`ops/planning/CROSS-IMPL-TEST-VECTORS.md`)
  pin canonical (input → output) pairs for every state-mutating
  envelope; running them on any indexer reveals which side is broken.

## Equivocation by worker on `T_INTENT_ATTEST`

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

## Sigma cross-curve forgery (theoretical, ≈ 2^128 work)

**Symptom:** Adversary forges a 128-bit Fiat-Shamir challenge.

**Recovery:** Equivalent to breaking 128-bit SHA-256 preimage
resistance — well beyond any feasible adversary. If somehow achieved,
all tacit primitives using sigma protocols become suspect.

## BJJ subgroup attack

**Symptom:** Adversary submits non-subgroup BJJ commitment hoping to
exploit cofactor structure.

**Recovery:** `unpackPoint` enforces `n_BJJ · P == identity` check.
Non-subgroup points return null; envelope decode fails; rejected. No
attack surface.

## vk_cid pinning failure (indexer fetches wrong vk)

**Symptom:** Indexer's IPFS resolution returns wrong content for
pool's pinned `vk_cid`.

**Recovery:**
- **Cross-check (MUST):** indexer MUST verify
  `deriveVkCid(vk_bytes) == pool.vk_cid` (canonical V1 form: CIDv1 raw
  codec + sha2-256 multihash + multibase-base32, prefix `bafkrei...`)
  before passing vk bytes to snarkjs. Reference impl:
  `tests/amm-validator.mjs` exports `deriveVkCid(vkBytes)` and
  `verifyVkCidBinding(vkBytes, cidString)`. Wrong content fails this
  check and the validator rejects the envelope before any proof
  verification (also enforced at SPEC.md §5.16 validator step 8).
  Production indexers MUST pass `vkBytes` to `validateSwapBatch` /
  `validateLpAdd` / `validateLpRemove` to engage this check.
- Multiple IPFS gateways + content addressing: any working gateway
  returns the same canonical bytes (the cross-check above is the
  belt-and-suspenders that catches a gateway that returns wrong bytes
  anyway).
- Worst case: indexer can't reach any gateway. Indexer halts AMM
  processing for affected pool until vk is resolved. Pool state freezes
  rather than corrupting.

