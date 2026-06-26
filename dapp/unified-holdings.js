// Unified cross-chain holdings — the merge that realizes "one Tacit balance per asset" across both
// settlement lanes (ops/ARCH-tacit-chain-abstraction.md, the unified-surface contract). A Tacit asset's
// Bitcoin-lane balance and Ethereum-lane balance (confidential-pool notes, tETH, canonical ERC20) merge
// into ONE row keyed by the shared asset_id; the per-lane breakdown is auditable but secondary.
//
// UNIT CONTRACT: every input balance MUST be in the asset's IN-SYSTEM base units (the value a note/UTXO
// commits to — Bitcoin/Tacit's ≤8-dec convention), so lanes are directly summable. A canonical-ERC20
// balance is 18-dec, so the EVM reader divides by the asset's unitScale (10^(18−d)) BEFORE handing it
// here. Balances accept bigint | integer-Number | decimal-string; everything is summed as BigInt.

const _big = (x) => {
  if (typeof x === 'bigint') return x;
  if (x == null || x === '') return 0n;
  if (typeof x === 'number') return BigInt(Math.trunc(x));
  const s = String(x).trim();
  return BigInt(s.includes('.') ? s.slice(0, s.indexOf('.')) : s); // truncate any fractional tail
};

const BITCOIN = 'bitcoin';
const ETHEREUM = 'ethereum';

// Merge a flat list of per-lane holdings into one entry per asset_id.
//   holdings: Array<{ assetId, ticker?, decimals?, balance, lane: 'bitcoin'|'ethereum', source? }>
//   `lane` is coarse (which chain settles it); `source` is the fine origin (e.g. 'btc-utxo',
//   'eth-confidential', 'eth-canonical', 'eth-teth') kept in byLane for the auditable breakdown.
// Returns Map<assetIdHex(lowercased), {
//   assetId, ticker, decimals, total: bigint, lanes: { bitcoin: bigint, ethereum: bigint },
//   byLane: [{ lane, source, balance: bigint }] }>.
export function mergeUnifiedHoldings(holdings) {
  const out = new Map();
  for (const h of (holdings || [])) {
    const id = String(h.assetId || '').toLowerCase();
    if (!id) continue;
    let e = out.get(id);
    if (!e) { e = { assetId: id, ticker: h.ticker || null, decimals: h.decimals ?? null, external: !!h.external, total: 0n, lanes: { [BITCOIN]: 0n, [ETHEREUM]: 0n }, byLane: [] }; out.set(id, e); }
    if (h.external) e.external = true;
    const bal = _big(h.balance);
    const lane = h.lane === BITCOIN ? BITCOIN : ETHEREUM;
    e.total += bal;
    e.lanes[lane] += bal;
    e.byLane.push({ lane, source: h.source || lane, balance: bal });
    // First non-empty wins for the label fields (the abstraction surfaces ONE ticker/decimals per id).
    if (!e.ticker && h.ticker) e.ticker = h.ticker;
    if (e.decimals == null && h.decimals != null) e.decimals = h.decimals;
  }
  return out;
}

// DI scan: merge the existing Bitcoin scanHoldings() with the EVM-lane readers into the unified map.
//   scanBitcoin() => Map<assetIdHex, { ticker, decimals, balance, ... }> | object  (the existing scanHoldings)
//   readEvmLanes() => Array<{ assetId, ticker?, decimals?, balance, source? }>  (already unit-normalized;
//     lane defaults to 'ethereum'). Optional — omit for a Bitcoin-only view (degrades cleanly).
// A failing EVM read does NOT sink the Bitcoin holdings (the unified view still shows the BTC lane).
// `canonicalId(id) => id` (optional) folds a cross-chain alias to its canonical id BEFORE the merge, so a
// legacy Bitcoin-lane asset (e.g. tETH) and its Ethereum counterpart (cETH) collapse into ONE row even
// though their raw ids differ. Identity by default (no aliasing).
export async function scanHoldingsUnified({ scanBitcoin, readEvmLanes, canonicalId }) {
  const canon = typeof canonicalId === 'function' ? canonicalId : (x) => x;
  const btc = await scanBitcoin();
  const btcEntries = btc instanceof Map ? [...btc.entries()] : Object.entries(btc || {});
  const holdings = btcEntries.map(([assetId, h]) => ({
    assetId: canon(assetId), ticker: h.ticker, decimals: h.decimals, balance: h.balance, lane: BITCOIN, source: 'btc-utxo',
  }));
  let evm = [];
  if (readEvmLanes) {
    try { evm = (await readEvmLanes()) || []; }
    catch { evm = []; } // EVM lane unavailable → Bitcoin-only, never throws away the BTC view
  }
  for (const h of evm) holdings.push({ ...h, assetId: canon(h.assetId), lane: h.lane === BITCOIN ? BITCOIN : ETHEREUM });
  return mergeUnifiedHoldings(holdings);
}

// Portfolio total across all assets + lanes, for the portfolio bar. `markFor(assetId, decimals) => bigint`
// (optional) converts an asset's total to a common quote unit (e.g. sats); without it, returns per-asset
// totals only. Always returns the per-lane split so the headline total stays auditable.
export function unifiedPortfolioTotals(unified, markFor) {
  let bitcoin = 0n, ethereum = 0n, quoted = 0n;
  const perAsset = [];
  for (const e of unified.values()) {
    // External watch-tokens (USDC/USDT/wstETH) are display-only and denominated in their own units —
    // they must not pollute the in-system (≤8-dec) lane totals or the quoted portfolio mark.
    if (e.external) continue;
    bitcoin += e.lanes[BITCOIN];
    ethereum += e.lanes[ETHEREUM];
    const q = markFor ? _big(markFor(e.assetId, e.decimals, e.total)) : 0n;
    quoted += q;
    perAsset.push({ assetId: e.assetId, ticker: e.ticker, total: e.total, lanes: e.lanes, quoted: markFor ? q : null });
  }
  return { lanes: { bitcoin, ethereum }, total: bitcoin + ethereum, quoted: markFor ? quoted : null, perAsset };
}
