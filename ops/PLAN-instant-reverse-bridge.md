# PLAN — instant(-ish) reverse bridge (ETH→BTC) via crossOut-into-an-op

The cheap, clever alternative to a full reverse fast lane. Lets an Ethereum-homed note (tETH, or any
canonical asset) land on Bitcoin **already spent into a Bitcoin-side operation** — a swap, an order fill,
or a send — in one user action, reusing machinery we already have.

## The insight
`crossOut → Mode-B reflection` already moves value ETH→BTC: a settle on Ethereum burns the note and
records `crossOutCommitment[claimId] = destCommitment`; a signet `0x65` (`T_CROSSOUT_MINT`) mints the
Bitcoin note; the Bitcoin reflection guest folds it (`fold_crossout`, gated on eth crossOutSet membership)
into `bitcoinPoolRoot`. Today the minted note is **passive** — the user then separately spends it.

**Enrich the `destCommitment` to be a note already bound to a Bitcoin operation**, so when the `0x65`
mint lands and reflection folds it, the value is *already traded/sent* on Bitcoin. One action, not two.

## Why this beats a full reverse fast lane
A true reverse fast lane (spend an Ethereum note *directly inside* a Bitcoin tx) would need (a) the **full
Ethereum pool state reflected onto Bitcoin** so an ETH note's membership is provable Bitcoin-side, and (b)
a **Bitcoin-side ETH-note-spend validator** in the reflection guest — recurring proving cost that grows
with chain age. crossOut-into-an-op needs **neither**: it rides the existing `crossOut → Mode-B` path and
only enriches the `destCommitment` + the `0x65` envelope semantics. Fraction of the cost, same UX win.

## Mechanism (sketch)
- **At crossOut (Ethereum):** the user picks the destination Bitcoin op (mint-and-swap into a Bitcoin
  pool / mint-and-send to recipient R). The `destCommitment` + the `0x65` envelope encode the op intent.
- **On signet:** the `0x65` broadcast mints the note and (chained, or in-envelope) executes the op.
- **Reflection:** `fold_crossout` folds the mint (eth-crossOutSet-gated); the value is on Bitcoin, traded.

## The shared dependency (this work also verifies the fast lane on-chain)
Both this reverse bridge **and** the live fast-lane round-trip verification (`RUNBOOK-confidential-modeb-
roundtrip.md`) need the same currently-missing CLIs — the runbook's documented build gaps:
- crossOut settle witness CLI (the bridge-burn-with-crossOut op-JSON for the box harness),
- the `0x65` broadcast CLI (`buildAndBroadcastEnvelope` over the signet wallet),
- the reflection fixture extension that marks a `0x65` tx as a `crossout_mint` so `fold_crossout` runs,
- bridge_mint witness CLI (`exec-bridgemint.rs` op-JSON).

A live btcHomed note is necessarily **ETH-origin** (fresh signet `cmint` is not reflected — conservation-
closed model), so closing these gaps is *exactly* what lets us prove a btcHomed note end-to-end:
ETH→(crossOut)→BTC→(reflect)→fast-spend back on ETH. **Build the gaps once → verify the fast lane live AND
ship the reverse bridge.**

## Re-prove implications (folds into the alpha re-prove)
- The Ethereum crossOut side is already in the settle guest.
- The op-binding (destCommitment ↔ Bitcoin op intent; `fold_crossout` binding the op, or a new `0x65`
  envelope parse) **may rotate `BITCOIN_RELAY_VKEY`** → fold into the alpha re-prove alongside the fast
  lane. Exact guest delta is TBD by the op-binding design.

## Latency / safety
Bounded by Bitcoin block time + the reflection cycle: instant on the ETH source (the burn), matured on the
Bitcoin landing. Not truly instant on Bitcoin (impossible), but **one action + race-free** (consume-source-
first, the safer direction), and far cheaper than the full reverse fast lane.

## Phasing (into the alpha re-prove)
1. **Close the crossOut/Mode-B CLIs** (the build gaps) — unblocks the live ETH→BTC→ETH round-trip (the
   fast-lane on-chain verification) and is the foundation for the reverse bridge.
2. **Design + implement the op-binding** (destCommitment ↔ Bitcoin op intent).
3. **Fold the guest delta (if any) into the alpha re-prove** (coordinated with the fast lane).
4. **Validate live:** the round-trip + the op-binding on the Sepolia/signet pilot.

Design-of-record; implementation follows the alpha sanity/cleanup. Completes the "one wallet, two chains"
loop in the cheap direction.
