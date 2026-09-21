# Runbook — ETH→BTC cross-out rehearsal (gen5)

One small TAC crossing from the Ethereum pool to a Bitcoin note, watched end to end: recording a cross-out,
folding it through Mode-B, minting the Bitcoin note, and spending it on Bitcoin. The full TAC round trip has
since run on gen5 (its first cross-out is
[`0xc7bfc7ce…a8f`](https://etherscan.io/tx/0xc7bfc7cec938e59c5d256d1c44c2aea5269eb7c237ac018878f21b2a93c29a8f)),
so this runbook is now the checklist for repeating a crossing, and its gates still apply.

**Run `tools/crossout-rehearsal-preflight.mjs` first and again immediately before step 3. Do not proceed on a NO-GO.**

## 0. Hard gates

| Gate | Why |
|---|---|
| Reflection within ~12 blocks of the Bitcoin tip | A cross-out increments `crossOutCount`. Until a Mode-B batch folds it, every forward-only batch reverts on-chain and the proof behind it is wasted. |
| `REFLECTION_MODEB_REQUIRED=1` on `tacit-api` | With `0`, the worker keeps assembling forward-only batches. That flag is deliberately `0` during a catch-up drain — **do not flip it early, and do not cross out while it is `0`.** |
| The Bitcoin mint's block is scanned by a **Mode-B** batch | A forward batch that scans a real `0x65` skips it without error. The claim is not consumed, so it is recoverable, but it costs a second mint transaction. |
| `tacit-eth-state` live (`DRY_RUN=0`) with a published candidate | The Ethereum-side proof of the cross-out comes from this sidecar. |
| Relay wallet funded; no other cross-out or fast-lane spend in flight | Each moves a counter that any in-flight proof must equal. |

## 1. Choices — make both before touching anything

**Amount: 1.23456789 TAC** (`123456789` units, `1234567890000000000` wei). Small, and the distinct digits make
any scale error (10^k off) visible on sight rather than hiding behind a round number. It must be a multiple of
`unitScale` (1e10 wei); this amount is by construction.

**A cross-out sends the whole note.** `OP_BRIDGE_BURN` has no change output, so the crossing size is the size
of the note you burn. Wrap exactly the rehearsal amount; do not wrap more and expect change.

**Destination key K — the one irreversible choice.** K is the x-only Taproot **output key** the Bitcoin note
will land at. It is committed into the recorded cross-out at burn time and can never be changed. A wrong K, or a
K whose private key is lost, strands the value permanently.
- Derive K from a P2TR address you control and can key-path-spend.
- **Back up its private key and produce a test signature under it before step 3.**
- `--dest-xonly` on the preflight checks it is a real, non-zero curve point. It cannot check you hold the key.

## 2. Steps

**1 — Fund the rehearsal wallet.** A fresh EOA `E` needs the TAC plus ETH for two transactions. The 250,000 TAC
sits with the ops multisig (2-of-4); a multisig transfer of 1.23456789 TAC to `E` is the simplest source.

**2 — Wrap.** From `E`, wrap exactly the amount through the dapp pool tab (creates a pending deposit, consumed
by an `OP_WRAP` settle). Verify: `LeavesInserted` for the new leaf; note value `123456789`.

**3 — Burn.** `ux.crossOut({ walletPriv, notes: [note], destOwner: K, fee: 0n, selfRelay: true })`
(`dapp/confidential-pool-ux.js`). `selfRelay` proves off-box then submits from `E`, so it does not depend on
the relay's fee gate. The builder rejects a zero or label-shaped key and derives a recoverable destination
blinding from your identity key and the note's nullifier.

Verify from chain, **using the event and not the builder's return value** (the builder's `claimId` is a
prediction that it corrects from the receipt, but confirm independently):

```
CrossOutRecorded(claimId, destChain=1, destCommitment, nullifier, assetId=TAC)
attestedCrossOutCount() == 1
crossOutCommitment[claimId] == destCommitment      # slot 77:  keccak(claimId ‖ uint256(77))
crossOutAt[0]            == claimId                # slot 172: keccak(uint256(0) ‖ uint256(172))
```

Record: `claimId`, `destCommitment`, `cx`, `cy`, `destBlinding`, `K`, the burn tx hash.

**4 — Wait for the fold.** Ethereum finality (~13 min), then the eth-state sidecar proves the finalized slot and
publishes a candidate, then the next reflection batch is Mode-B and folds the cross-out. Evidence: a new
`attestBitcoinStateProven` after the burn block with a changed digest, and `GET /reflection/eth-state`
(box token) showing the candidate confirmed with `crossOutCount 1`. **Do not build the mint until this is seen.**

**5 — Build the Bitcoin mint.** Needs one plain P2WPKH UTXO of ≥ ~2,000 sats (about 1,200 sats of fees at 3 sat/vB).

```
WALLET_JSON=… CLAIM_ID=<from event> CX=… CY=… DEST_XONLY=<K> \
FEE_TXID=… FEE_VOUT=… FEE_VALUE=… node tools/build-crossout-mint.mjs
```

It writes both transactions and **does not broadcast**. Check every printed parameter against the event and your
burn record. The reveal's vout 0 is a P2TR output paying `K` — the guest reads the destination from exactly that
output and folds nothing, silently, if it is anything else. Run `testmempoolaccept` on the pair, then broadcast the
commit, then the reveal.

**6 — Keep `REFLECTION_MODEB_REQUIRED=1` until reflection has scanned past the reveal's block.** Then verify the
note exists in reflected state (worker `/reflection/note-witness`, or by the spend below).

**7 — Spend it on Bitcoin.** Send the note to a second address with an ordinary confidential transfer. This is the
step that proves the round trip is usable rather than merely recorded.

## 3. What can go wrong, and what it costs

| Symptom | Cause | Recoverable? |
|---|---|---|
| Attest reverts `ConsumedCountStale` / proof rejected | A counter moved after the proof was built | Yes — regenerate the proof |
| Mint confirms but the note never appears | vout 0 not P2TR(K); wrong `claimId`, `cx` or `cy`; or scanned by a forward batch | **Yes** — the claim is unconsumed; build and broadcast a corrected mint |
| Note appears but cannot be spent | Wrong blinding, or you do not hold K | Blinding: re-derive it. **K lost: no** |
| Value sent to the wrong K | K was wrong at burn time | **No** — K is fixed at burn |

The mint side is forgiving; the burn side is not. Everything irreversible happens in step 3.

## 4. What this does and does not prove

Proves: `fold_crossout` against gen5's chain binding, the Mode-B automation on a real cross-out, the mint
builder, and that a bridged-back note is spendable on Bitcoin.

Does not prove: several cross-outs at once. Each moves `crossOutCount`, so an in-flight Mode-B proof goes stale if
another cross-out lands first — that throughput limit matters for an airdrop and should be measured separately.

**Open question this answers — record it.** After the first fold, does reflection return to forward-only
batches, or does every later attest need an eth-state proof? gen4's experience says the latter, which is an
ongoing per-attest proving cost from the first cross-out onward, not a one-off. Note what actually happens.

## 5. After

Append the burn, attest, mint and spend transaction hashes to the mainnet proof index, and record the outcome
of the open question above.

## 6. What the first real cross-outs taught (2026-09-20) — read before running one

Two cross-outs ran on gen5 (TAC 1.23456789, and native ETH as tETH at 30,010 units). Every item below cost a proof, a
delay or funds the first time.

**Answer to the open question in section 4.** With `REFLECTION_MODEB_REQUIRED=1` every reflection job needs an
eth-state candidate, and the sidecar republishes on its own whenever its pending slot is free (each attest frees it),
so Mode-B batches self-sustain. The cost is an eth-state proof per attest for as long as the flag stays at 1.

**The stale-candidate window (this is what wastes proofs).** A cross-out changes `crossOutCount` on-chain. Until the
eth-state candidate covers it, any Mode-B attest reverts `ConsumedCountStale()` (selector `0x55a09618`,
`ReflectionLib.sol`, reused for the cross-out count) after the proof has already been bought. Procedure:
1. Suspend the reflection cron (Render `POST /services/{id}/suspend`) BEFORE the cross-out.
2. Cross out; verify the event, `crossOutCount`, and storage slots 77 and 172 from chain.
3. Wait until Ethereum's FINALIZED head passes the cross-out block (`cast block finalized`). Finality advances an epoch
   (32 blocks) at a time, so it jumps rather than creeps. Clearing earlier makes the sidecar prove a candidate that
   misses the cross-out and re-wedges it.
4. Only when the sidecar is idle (not mid-prove), `POST /reflection/eth-state/clear` drops the stale pending candidate
   (box token). Otherwise the sidecar waits `ETH_STATE_PENDING_STALE_SECS` (4 h) on its own candidate.
5. The next candidate appears within ~2 minutes. Check the served job's `input.ethPv` words: word 3 is the
   crossOutSetRoot, **word 4 is crossOutCount**, word 10 is the consumed count. Require the new count, a new
   contentHash and `execBlock` at or past the cross-out block. Then resume the cron.

**Return leg: no migration hop.** A cross-out mint note is a tracked class-1 leaf. Burn it directly with the ordinary
class-1 burn (a two-input tx: a fresh envelope-commit input, then the note key-path spent with K; the 161-byte envelope
lives inside the tapscript, so any node relays it: no private-miner submission, no provenance bundle). Do NOT insert a
v1 CXFER hop for anything but TAC: opcodes 0x22 and 0x23 are allowed only for TAC (`LEGACY_BRIDGE_ASSETS`), and for any
other asset the hop nullifies the input and mints nothing.

**Native ETH.** `assets(0x3cba71e1…)` reads registered, native, linked to itself, unitScale 1e10; there is no
per-asset gate in the guest. `tools/build-crossout-mint.mjs` defaults `ASSET_ID` to TAC, so pass the ETH id or the mint
folds nothing. Amounts are note units, so any unit count crosses; wrap the exact amount first (a cross-out burns the
whole note) and pin the note by leaf index when other operators share the wallet key.

**Bitcoin tx hygiene.** After building ANY Bitcoin transaction, parse its serialized outputs and compare each script to
what you intended before broadcasting. The mint builder once sent every commit change to a double-hashed address (13,746
sats lost); `tests/crossout-mint-builder.test.mjs` now pins the change and destination scripts. Keep a free plain coin
for each pending Bitcoin step, and never spend a coin that is an input of a queued burn.

**Timing.** The mint is scanned only after 24 Bitcoin confirmations and only by a Mode-B batch, so budget hours, and
more when blocks are slow. Keep `REFLECTION_MODEB_REQUIRED=1` until reflection has scanned past the mint's block.
