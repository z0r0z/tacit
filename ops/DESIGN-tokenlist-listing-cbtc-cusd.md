# Listing cBTC / cUSD / tETH on the onchain TokenList

Status: **ALL FIVE LIVE on mainnet** (2026-09-11) — tacBTC, tacUSD, cBTC
(shielded), cUSD (shielded), tETH. Both multisig bundles (the 8-call cBTC/cUSD
bundle and the 3-call tETH bundle) confirmed; `TokenList.total()` went 38→43.
Verified post-confirmation by reading `get()`/`tokenURI()` back from the
registry directly — every field (name, symbol, standard, decimals, color,
rank, logo) matches what was simulated pre-submission, byte for byte.

## What gets listed, and why

`cBTC` and `cUSD` are confidential note assets inside `ConfidentialPool` — no
`address`, no `balanceOf`, not something a token list can point at directly. Two
things are listable per asset:

1. The **public ERC20 bridge form** — `tacBTC` / `tacUSD` (`CanonicalBridgedERC20`,
   same family as `TAC`). Listed via `TokenList.list(token, ...)`, which reads
   `name`/`symbol`/`decimals` straight from the token (`synced = true`).
2. The **confidential form itself** — keyed by its 32-byte protocol asset id, not
   an address. Listed via `TokenList.listForeign(Kind.OTHER, chainId=0, assetId, ...)`
   + `setStandard(id, Standard.TACIT)`, exactly how the existing `TAC` listing
   pairs its EVM-bridged card with a `Kind.OTHER` / `Standard.TACIT` card for the
   native Bitcoin coin (id `104165018710067097353655755692819801489527232022561016148205125677286991358696`,
   already live on the list). `Standard.TACIT`'s own doc comment says it exists
   for exactly this: "a confidential asset whose amounts may be hidden, keyed by
   its 32-byte asset_id."

So: **four listings total**, two per asset, mirroring the TAC precedent exactly.

## Contract

`TokenList` (Solady `ERC721` + `Ownable` + `Multicallable`) at
`0x0000006013dF75A31678B786061C2B54bf531524`, owner (the admin multisig)
`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`. Full source pulled from Etherscan
(verified, compiler `0.8.36`) — see `src/utils/TokenList.sol` /
`TokenListRenderer.sol` for the exact rules referenced below.

Key constraints that shaped these payloads:
- `list`/`listForeign`/`setStandard`/`setArt`/`setAudit` are all `onlyOwner`.
- `logo` must be `data:image/...`, `https://`, or `ipfs://` and ASCII-clean (no
  `"`, `'`, `\`, `<`, `>`, `&`) — `LOGO_MAX` 24,576 bytes stored.
- `description`/`url` pass through `_clean` (same forbidden-character set,
  `DESC_MAX` 256 / `URL_MAX` 128) — it silently truncates/strips rather than
  reverting, so payloads below were pre-checked to fit and stay clean.
- `listForeign` always sets `url`/`description` to `""`; a separate `setArt`
  call is required to populate them (confirmed empirically: TAC's own foreign
  listing has this exact three-call history — `listForeign` → `setStandard` →
  `setArt`, plus a fourth `setAudit` it also carries that we deliberately did
  **not** replicate, see below).
- `list`/`_pull` reads `name()` from the token contract itself, and
  `CanonicalBridgedERC20.name()` is a hardcoded constant `"Tacit Token"` for
  every canonical asset (by design — no trustless per-asset name field
  onchain). So the tacBTC/tacUSD cards will show name **"Tacit Token"**,
  distinguished only by `symbol` (`tacBTC`/`tacUSD`), `logo`, and
  `description` — same as the already-live TAC ERC20 card, which also reads
  "Tacit Token" / symbol "TAC".

## Addresses / ids used (mainnet, gen4 pool `0x…98A73197`)

| | value |
|---|---|
| tacBTC (`CanonicalBridgedERC20`) | `0x5Fc0376DA9f1dE8dd68b50648779C83b79f7C50F` |
| tacUSD (`CanonicalBridgedERC20`) | `0xA70f3853D56c1fC3F5b800E44907c7AD885Ab905` |
| `CBTC_ZK_ASSET_ID` (fixed protocol constant, not per-generation) | `0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8` |
| cUSD confidential asset id (gen4 CollateralEngine-derived, **will change on redeploy**) | `0x4e8455a57c4a996ba6e40ee87f01c88421ecfdbbeac9762dcee0c5713363dacb` |

Verified via `cast call` against `ethereum-rpc.publicnode.com`: both tokens
deployed, `contractURI()` matches the pinned IPFS metadata baked into
`ConfidentialPool.sol`'s `CBTC_METADATA_CID`/`CUSD_METADATA_CID`; neither the
ERC20s nor the two confidential asset ids are listed yet
(`isListed` → `false` for all four candidate ids).

## Art

- `list()` for tacBTC / tacUSD reuses the **already-pinned** launch icons
  verbatim: `contracts/cbtc-tac-icon.svg` (solid ring = public ERC20, Bitcoin
  orange `#f7931a`) and `contracts/cusd-tac-icon.svg` (solid ring, money-green
  `#16a34a`). No new art, no new IPFS pin — base64-inlined as
  `data:image/svg+xml;base64,...` matching how the list already stores WETH/
  USDC/USDT/ETH/TAC (all inline SVG, none link out to IPFS).
- `listForeign()` for the two confidential legs uses **new** dashed-ring badge
  variants, both built the same way: take the already-locked-in glyph from the
  paired ERC20's own icon and swap only the ring from solid to dashed (solid =
  public ERC20, dashed = shielded/amounts-hidden — the distinction the wrapper
  docs already draw). `contracts/tokenlist-drafts/cbtc-zk-icon.svg` reuses the
  exact "b" stroke path from `contracts/cbtc-tac-icon.svg`;
  `contracts/tokenlist-drafts/cusd-zk-icon.svg` reuses the exact "$" stroke
  path from `contracts/cusd-tac-icon.svg`. **These two are the one thing here
  that is genuinely new art — review before it goes onchain**, everything else
  reuses already-shipped, already-reviewed assets.

  First pass on the cBTC badge mistakenly reused the glyph from
  `dapp/wrappers/cbtc-zk/logo.svg` instead — a visually different T+double-crossbar
  mark. That file turned out to be a stale 2026-05-16 design draft for an
  unrelated asset family (the worker's `tacit-cbtc-tac-variant-v1`
  multi-denomination self-custody slots, tracked by `worker/src/index.js`'s
  `slotCoverage*` code), not the `CBTC_ZK_ASSET_ID` reflection-lock asset
  listed here. Confirmed nothing for `CBTC_ZK_ASSET_ID` is minted or branded
  anywhere yet (cBTC locking hasn't started on gen4), so there was no
  onchain constraint either way — fixed to derive from the correct sibling
  asset's own icon instead.

## Ranks / colors

TAC sits at `rank = 988000`, `color = 0xf7931a`, between the seeded blue-chips
(`WETH 999000` / `USDC 995000` / `USDT 994000`) and open space below. Proposed:

| asset | rank | color |
|---|---|---|
| tacBTC / cBTC.zk (paired) | `987000` | `0xf7931a` (Bitcoin orange, matches `cbtc-tac.svg`) |
| tacUSD / confidential cUSD (paired) | `986000` | `0x16a34a` (money green, matches `cusd-tac.svg`) |

Purely curatorial — `setRank` can move either at any time later.

## Calldata

Individually (function-level), and as ready-to-sign `multicall(bytes[])`
bundles — all simulated via `eth_call --from 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`
against current mainnet state and confirmed to **not** revert (full 8-call
bundle returns a clean ABI-encoded 8-tuple of ids/no-ops). Full hex dumped to
`/private/tmp/claude-501/-Users-z-tacit/c98de8e3-2b78-4daa-9927-173c9e256a8b/scratchpad/multicall_v2.txt`
(scratch, corrected-badge version — regenerate from this doc's recipe rather
than relying on that path surviving).

Four independent multicalls (submit separately, or concatenate into one):

1. **ERC20 legs only** (`list()` × 2 — tacBTC, tacUSD): the safe, all-reused-art
   half. 2 calls.
2. **cBTC.zk confidential leg** (`listForeign` + `setStandard` + `setArt`): 3
   calls, new art.
3. **cUSD confidential leg** (same shape): 3 calls, new art.
4. **All 8 calls combined**: one multisig transaction, everything above.

Recipe to regenerate exact calldata (uses `cast`, values as above):

```
cast calldata "list(address,uint24,uint32,string,string,string)" \
  <tacBTC> 0xf7931a 987000 "<data-uri from cbtc-tac-icon.svg>" \
  "https://tacit.finance" "<description>"

cast calldata "listForeign(uint8,uint64,bytes32,string,string,uint8,uint24,uint32,string)" \
  2 0 <assetId> "<name>" "<symbol>" 8 <color> <rank> "<data-uri>"

cast calldata "setStandard(uint256,uint8)" <id> 5   # 5 = Standard.TACIT

cast calldata "setArt(uint256,uint24,uint32,string,string,string)" \
  <id> <color> <rank> "<data-uri>" "https://tacit.finance" "<description>"

cast calldata "multicall(bytes[])" "[<call1>,<call2>,...]"
```

## Deliberately NOT included

- **`setAudit`**: TAC's foreign listing carries `audit = "https://tacit.finance/verify"`.
  There is no equivalent verify page yet for cBTC.zk / cUSD proofs specifically —
  don't fabricate one. Add via `setAudit(id, url)` once (if) one exists.
- **`freeze`**: leaves all four listings owner-editable indefinitely (matches
  every existing listing on this registry — none are frozen).
- Reusing the plain `cbtc-tac-icon.svg`/`cusd-tac-icon.svg` (solid ring) for the
  confidential legs instead of drawing dashed-ring variants — rejected because
  the repo already treats solid-vs-dashed ring as the deliberate public/shielded
  visual distinction (`CanonicalBridgedERC20` doc comment, `cbtc-zk` README);
  reusing the public icon for the shielded card would erase that distinction on
  the one surface (a public token list) where it matters most for not
  conflating the two custody models.

## tETH — investigated separately (DRAFT, not submitted)

Asked: should tETH (Tacit's confidential/pooled ETH, the original bridged-mixer
asset) also get listed, given some naming tension with "cETH"?

**Finding: there is no ERC20 leg to pair against.** Read directly off gen4
mainnet:

```
$ cast call <pool> "assets(bytes32)(bool,address,uint256,bytes32,bool,uint8)" \
    0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34
true, 0x0000000000000000000000000000000000000000, 10000000000, 0x3cba71…, false, 18
#      registered   underlying=0x0 (native ETH)   unitScale   crossChainLink=self   poolMinted=false   decimals
```

`poolMinted = false` and `underlying = address(0)`: tETH wraps native ETH
directly, so no `CanonicalBridgedERC20` was ever deployed for it (unlike
TAC/cBTC/cUSD, which each mint a canonical token via `CanonicalAssetFactory`).
There is nothing for `list()` to point at — only the confidential leg exists,
so this is a single `listForeign` card, not a pair.

**cETH vs tETH, resolved.** The pool's own constructor registers this exact id
as `_register(address(0), 1e10, TETH_BITCOIN_ID, false, "Tacit ETH", "tETH", 18)`
— `"tETH"` is the trustless, on-chain-provable identity. `"cETH"` is a
dapp-only relabel (`dapp/confidential-deployments.js`) applied for naming
symmetry with cBTC/cUSD in the UI; it has no on-chain existence. Per the same
principle used for tacBTC/tacUSD (card fields follow the provable identity,
not a UI convenience label), the card lists as **tETH**, with the app alias
called out in the description text so a `cETH`-searcher isn't lost.

**Identity used**: `TETH_BITCOIN_ID` = `0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34`
— the same Bitcoin-side id carried across every generation since the original
launch (`launch-canonical-seeded.env` through `redeploy-v3.env`), confirmed
still wired into gen4 via `localAssetOf(TETH_BITCOIN_ID) == TETH_BITCOIN_ID`.
Listed via `listForeign(Kind.OTHER, chainId=0, TETH_BITCOIN_ID, ...)` +
`setStandard(id, TACIT)` + `setArt(...)`, exactly mirroring TAC's own
Bitcoin-side foreign card. `decimals = 18` (not 8, unlike cBTC.zk/cUSD) because
that is what `assets()` actually reports for this id — the pool's internal
8-decimal note scale is converted to ETH's native 18 via `unitScale = 1e10` at
this specific registration, so 18 is the provable fact here, not an assumption
carried over from the Bitcoin-native assets.

**Art: no redesign needed.** `contracts/teth-icon.svg` already exists,
purpose-built for tETH from the original mixer-bridge era (ETH-blue `#627eea`,
same tacit-T stroke family, solid ring). Solid ring is correct here too — the
dashed-ring convention is specific to the cBTC.zk/tacBTC self-custody-slot
*pair*; tETH has no pair, and TAC's own single native-asset card is solid-ring
for the same reason. Reused verbatim, base64-inlined, no new art.

**Rank/color**: `985000`, `#627eea` (ETH blue — same accent WETH/ETH already
use on this list, correctly signaling "this is a form of ETH").

**Calldata** (3 calls, `listForeign` + `setStandard` + `setArt`), simulated
clean via `eth_call` from the owner multisig:

```
cast calldata "listForeign(uint8,uint64,bytes32,string,string,uint8,uint24,uint32,string)" \
  2 0 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34 \
  "Tacit ETH" "tETH" 18 0x627eea 985000 "<data-uri from contracts/teth-icon.svg>"

cast calldata "setStandard(uint256,uint8)" 67178071788351857431590626042867162905939182382417439626360615243410997204626 5

cast calldata "setArt(uint256,uint24,uint32,string,string,string)" \
  67178071788351857431590626042867162905939182382417439626360615243410997204626 \
  0x627eea 985000 "<same data-uri>" "https://tacit.finance" \
  "Tacit confidential ETH, shown in the app as cETH. Originally the mixer-bridged wrapped ETH asset, redeemable via ZK Bitcoin inclusion proof; now the native ETH leg of the confidential pool itself. Wrap ETH to enter, unwrap to exit."
```

Full `multicall(bytes[])` bundle dumped to
`/private/tmp/claude-501/-Users-z-tacit/c98de8e3-2b78-4daa-9927-173c9e256a8b/scratchpad/teth_multicall.txt`
(scratch). Not yet requested for submission — separate action from the
cBTC/cUSD bundle already queued.
