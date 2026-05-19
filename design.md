# Tacit Finance — orderbook page redesign

Two iterations of a redesign for the TAC market page. Both preserve Tacit's existing aesthetic (cream background, monospace, dashed dividers) and apply structural improvements.

## files

- `tacit_redesign_v1.png` / `.html` — first pass
- `tacit_redesign_v2.png` / `.html` — second pass (tighter, recommended)

Open the `.html` files in any modern browser to see the live version. PNGs are 2x retina renders for quick review.

## what changed from the current production page

**Hierarchy & layout**
- Single coherent token hero (icon, name, verified, id, price, sparkline, stats) instead of three stacked cards
- Promoted depth chart with one-line plain-language explanation of "CROSSED" — the most novel thing on the page is no longer unexplained
- Removed the duplicate price chart (sparkline next to price replaces the larger one; depth chart is now the primary visualization)

**Asks and bids**
- Parallel tabular treatment for both — same columns, same row height, same styling (current production has asks as compact tables and bids as tall cards, breaking visual symmetry)
- Micro depth bars behind each row showing qty as % of column max — asks grow leftward, bids grow rightward (mirrored, standard pro orderbook pattern)
- Grouped levels collapse with `≤price ×N` / `≥price ×N` notation
- Secondary actions ("list for sale", "place a bid") moved to column headers

**Swap form**
- Helper text collapsed from 4 lines to 1, with `details ▾` disclosure for the rest
- Single dominant primary CTA, no competing buttons in the form
- Removed redundant info (e.g. duplicate avg-price hint in YOU RECEIVE box)

**Color discipline**
- Green reserved for "best in class" or positive (best ask/bid, verified, CTA, +%)
- Red reserved for asks above mid and negative %
- Orange reserved for brand moments only (wordmark, ceremony, id chip)
- Yellow only for CROSSED warning state
- All row background tints removed; color now encodes signal, not decoration

**Other**
- Ticker shows full strings (no mid-word truncation at edges)
- MAINNET selector got more presence (solid black) — on a Bitcoin product, network confusion is a real risk
- AMM ceremony collapsed from full-section list to single line at bottom of page
- Recent trades reduced to a tight one-line tape
- Footer, ceremony, and protocol citations merged into one strip

## what's intentionally similar to current production

- Cream background, monospace everywhere, dashed dividers, italic serif wordmark — the aesthetic is good and was preserved
- Per-listing orderbook structure (vs. combined price ladder) — matches Tacit's actual market model
- Confidential token narrative kept prominent in the header
- All numerical precision preserved (the trader needs full decimals available)

## suggested next iterations (not yet built)

- Hover state on ask/bid rows revealing inline BUY/SELL button at right edge
- Expanded `details ▾` panel state for the swap form (showing slippage controls + "raise max to ±50%" upsell)
- Mobile / narrow-viewport layout
- Dark mode pass