# Maintainer response — GPT greenlight audit, round 10 (bundle @ `1f7c7d3`)

Tenth pass — the confirmatory round. It did **not** come back clean: it reopened the round-8 Bitcoin 64-byte
reflection fix and found it **incomplete** (F-01, Critical). The OP_PUSHDATA4 / LP exact-length /
FarmController receipt-mode fixes were independently re-verified (V-01/02/03). F-01 is now fixed and
independently reviewed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | 64-byte reflection fix still permits a self-mined-block merge that hides a real Tacit spend | Critical | **Real** | **Fixed + adversarially reviewed** |
| V-01 | OP_PUSHDATA4 parsing doesn't overflow/over-read | — | **Confirmed safe** | — |
| V-02 | LP envelope exact-length rejects trailing bytes | — | **Confirmed safe** | — |
| V-03 | FarmController receipt-mode gate separates receipt/bare correctly | — | **Confirmed safe** | — |

## F-01 — 64-byte merkle-merge still hid a Tacit spend — FIXED

The round-8 fix admitted a 64-byte tx if it *parsed* as a well-formed tx, which I argued was safe because a
foreign-mined block gives the attacker no control over the txids. **That reasoning was wrong for a
self-mined block.** A miner can mine a real `[coinbase L, spend R]` block (R spends a live Tacit Bitcoin
output), then present a fake one-tx reflection (`n_tx = 1`) whose sole "tx" `C = txid_L ‖ txid_R`: since the
attacker controls L (grindable coinbase extranonce) and R, they grind `C` to parse (~2³⁰), so
`compute_txid(C) = H(C)` equals the real header merkle root. `C` is treated as the sole coinbase, envelope
extraction is skipped for `ti == 0`, and the real `R` is never scanned — its spend is hidden from
`knownBitcoinSpentRoot`, enabling a cross-chain double-spend (the BTC UTXO is spent on Bitcoin while the
Tacit note still looks unspent on Ethereum). Forward-only, so an honest later reflection can't repair it.

**Fixed** by authenticating the block-body shape, not only the merkle root: the full-scan now requires
`n_tx > 0`, `is_coinbase(txs[0])` (exactly one input whose prevout is the null outpoint — txid 32 zero bytes,
vout `0xffffffff`), and `!is_coinbase` for every later tx. The fake `C` is ≈random hash bytes, so its prevout
is not the null outpoint (~2²⁵⁶-hard to force) → `is_coinbase(C)` is false → the fake can't be proven; only
the real block can, which scans `R`. The complementary `n_tx ≥ 2` merge (which must keep the real coinbase to
match the root) is caught by the pre-existing BIP-141 witness-commitment check: keeping the real coinbase pins
its committed wtxid root, and collapsing any subtree into one 64-byte leaf changes the wtxid tree shape (a
leaf where an internal node belongs) → the commitment fails. This holds whether the hidden tx is segwit or
legacy.

**Adversarially reviewed** (n_tx=1 grind incl. the segwit-marker branch; n_tx≥2 merge keeping the coinbase
incl. legacy-R, only-segwit-is-R, and force-`None` sub-cases; whether every Tacit spend is segwit; liveness
over a genuine one-tx coinbase block; `is_coinbase` panic-safety) — verdict SOUND, and the guarantee is
broader than first stated (the load-bearing invariant is "a kept coinbase pins the wtxid root," not "R is
segwit"; the comments were corrected accordingly). cxfer-core 154/154 incl. an `is_coinbase` test; the
reflection DIGEST_MATCH gate is green (all real fixtures' coinbases are accepted; only the ceremony-zkey
`swapbatch` regenerates on the box).

## V-01 / V-02 / V-03 — round-9 fixes re-verified
The auditor independently re-checked the round-9 work and confirmed: `OP_PUSHDATA4` parsing is bounds-safe
(no overflow/over-read), LP envelope exact-length rejects trailing-byte bypasses (add v0/v1 + remove), and the
FarmController receipt-mode gate cleanly separates receipt sentinels from bare CDP positions in both modes.

## Net
F-01 (the reopened Critical) is closed and independently reviewed; the round-9 fixes are confirmed safe.
cxfer-core 154/154; the reflection DIGEST_MATCH gate is green. **This round did not come back clean** — a
further confirmatory round on the F-01-fixed commit is warranted before the re-prove + immutable lock.
