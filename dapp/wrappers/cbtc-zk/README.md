# tacBTC — canonical wrapper assets (cBTC.zk note model)

Static-payload assets the first minter uses to CETCH the canonical
cBTC.zk asset on Bitcoin mainnet (and signet for testing). Kept in-repo
so anyone can audit the canonical metadata + logo without trusting an
off-band copy.

## Files

- **`logo.svg`** — the canonical wordmark. Riff on `tacit.svg`: same
  outer ring + orange stroke language, with two visual cues that
  distinguish it from plain tacit. Outer ring is dashed (zk / shielded
  wrapper). Two crossbars instead of one (Bitcoin ₿-style double-strike
  → "wrapped BTC"). Self-explanatory at any size; copies the parent
  brand's recognizability.
- **`metadata.json`** — JCS-canonical wrapper metadata blob (per SPEC
  §3.X + SPEC-WRAPPER-AMENDMENT §4.2.1). Declares `tacit_wrapper.custody.kind
  = "self_custody_slot"` with `denom_sats = 100_000`. The blob's IPFS
  CID will be referenced by the CETCH envelope's `image_uri` field so
  indexers can auto-discover it as a wrapper and the dapp can render
  the Wrap/Unwrap surface.

## Deploy sequence (first minter)

1. **Pin `logo.svg` to IPFS**, capture its CID. Verify the CID resolves
   correctly across at least two gateways before continuing.
2. **Substitute `__LOGO_CID__` in `metadata.json`** with the logo's CID
   (e.g. `ipfs://bafkr...`). The metadata.json's JCS-canonical encoding
   is byte-stable — don't reformat. Keep the keys alphabetically sorted
   and the JSON compact (no whitespace, no trailing newline beyond the
   one this file ships with). Implementations canonicalise per RFC 8785;
   any deviation changes the CID and breaks discovery.
3. **Pin the updated `metadata.json` to IPFS**, capture its CID. This
   is the value used as the CETCH's `image_uri` parameter.
4. **CETCH from the dapp's Etch tab.** Recommended parameters:
   - `ticker`: `tacBTC`
   - `decimals`: `8`
   - `supply`: `2_100_000_000_000_000` (21M BTC expressed at 8 decimals
     = total sat-granularity cap; matches Bitcoin's hard cap and is the
     theoretical maximum the wrapper could ever wrap. Practical
     circulating supply will be much smaller, growing as users mint.)
   - `image_uri`: `ipfs://<metadata-CID-from-step-3>`
   - `mintable`: `false` (no issuer can mint additional supply; new
     cBTC.zk units only come from T_SLOT_MINT calls per the amendment)
5. **Verify discovery.** After confirmation + worker cron tick, the
   asset should appear under `/wrappers/<asset_id>` with custody.kind
   detected as `self_custody_slot`. The Mixer tab's pool list should
   surface the cBTC.zk pool at `denom_sats = 100_000`; the eventual
   asset-page swap UI will render Wrap/Unwrap when this metadata is
   pinned correctly.

## Adding denomination tiers

Each `denom_sats` value is a separate `asset_id` (separate CETCH).
v1 ships with the **100k-sat tier** (≈ 0.001 BTC) as the canonical
launch denomination. Future tiers (1M sats / ≈ 0.01 BTC, 10M sats /
≈ 0.1 BTC) can be CETCHed via the same procedure, swapping the
`denom_sats` value and CETCHing under a tier-suffixed ticker (e.g.
`cBTC.zk-1M`, `cBTC.zk-10M`). T_SLOT_SPLIT / T_SLOT_MERGE (planned
for a follow-up amendment) will let users move between tiers atomically.

## Why these specific defaults

- `denom_sats = 100_000` is **0.001 BTC** — fee-economic at typical
  mainnet rates (Bitcoin miner fee is < 5% of slot value at 5 sat/vB)
  while small enough to be accessible. SPEC §"Bitcoin fee handling"
  warns that 100k-sat slots can be uneconomic for repeated rotation;
  this tier is the entry-level / general-purpose tier. Larger tiers
  are recommended for high-frequency-rotation use cases.
- `max_supply = null` (uncapped) — the protocol-level cap is the CETCH
  envelope's `supply` field. We leave `max_supply` null and rely on
  the CETCH supply (2.1 × 10¹⁵ base units = the theoretical BTC cap)
  as the only ceiling.
- `peg = 1 / 1` — exact 1:1 with sats. One cBTC.zk base unit backs one
  satoshi of locked Bitcoin. Conservation is exact, no fractional sats.
- `redemption.fee_bps = 0` — no protocol fee. Users pay only Bitcoin
  miner fees on each operation (mint/burn/rotate/etc).

## Self-custody warning surface

Every dapp surface that mints, rotates, or burns a slot MUST display
the lost-note warning before user confirmation:

> Losing your slot record locks the backing sats permanently. There is
> no recovery path — same property native Bitcoin already has for lost
> keys. Back up your slot record (Copy JSON) before clearing browser
> data.

The current Mixer-tab Wrap helper does this via `tacitConfirm`.
Future asset-page swap UI and rotate-send flow MUST preserve the
equivalent warning.
