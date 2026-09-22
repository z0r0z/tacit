# cBTC.zk wrapper assets (legacy)

Canonical metadata and logo for the cBTC.zk self-custody slot asset on Bitcoin: BTC locked 1:1 at a key
derived from a mixer leaf, operated by the legacy slot ops `T_SLOT_MINT/BURN/ROTATE/SPLIT/MERGE`
(SPEC §3.8). Kept in-repo so anyone can check the canonical payload without trusting an off-band copy.

This is separate from cBTC, the confidential pool's collateral asset (ERC-20 tacBTC, SPEC §5.7).

## Files

- **`logo.svg`**: the wordmark. The tacit ring with a dashed outer ring and a double crossbar.
- **`metadata.json`**: JCS-canonical (RFC 8785) wrapper metadata. Declares
  `tacit_wrapper.custody.kind = "self_custody_slot"` with `denom_sats = 100_000`. Its IPFS CID is the
  CETCH envelope's `image_uri`, which is how indexers discover the asset as a wrapper.

## Etching a tier

1. Pin `logo.svg` to IPFS and check the CID resolves on at least two gateways.
2. Replace `__LOGO_CID__` in `metadata.json` with `ipfs://<logo CID>`. Do not reformat the file: keys
   stay sorted and the JSON compact, or the CID changes and discovery breaks.
3. Pin the updated `metadata.json` and take its CID.
4. CETCH from the dapp's Etch tab:
   - `ticker`: `tacBTC` (tier-suffixed for other tiers, e.g. `cBTC.zk-1M`)
   - `decimals`: `8`
   - `supply`: `2_100_000_000_000_000` (21M BTC in sats, the only supply ceiling; `max_supply` is null)
   - `image_uri`: `ipfs://<metadata CID>`
   - `mintable`: `false` (units come only from `T_SLOT_MINT`)
5. After confirmation and a worker cron tick, the asset appears under `/wrappers/<asset_id>` with
   `custody.kind = self_custody_slot`, and the Mixer tab lists its pool at its `denom_sats`.

Each `denom_sats` value is a separate asset id and a separate CETCH.

## Defaults

- `denom_sats = 100_000` (0.001 BTC): accessible, with the miner fee under 5% of slot value at 5 sat/vB.
  Frequent rotation suits larger tiers.
- `peg = 1 / 1`: one base unit backs one locked satoshi.
- `redemption.fee_bps = 0`: users pay only Bitcoin miner fees.

## Lost-note warning

Every surface that mints, rotates or burns a slot MUST show this before confirmation:

> Losing your slot record locks the backing sats permanently. There is
> no recovery path — same property native Bitcoin already has for lost
> keys. Back up your slot record (Copy JSON) before clearing browser
> data.

The Mixer tab's Wrap helper shows it via `tacitConfirm`.
