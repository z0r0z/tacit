// Confidential Swap tab — shielded AMM swap on the Ethereum lane. A swap is a 1-hop confidential route
// (confidential-route.js, OP_SWAP_ROUTE): the input note + final output stay notes, the trade clears
// against the pool's live on-chain reserves (read via ux.poolReserves), gasless through the relay.
//
// VERIFICATION: getAmountOut + reserve decode are deterministic and unit-checked; the op shape mirrors the
// guest's OP_SWAP_ROUTE. Pools appear as assets beyond cETH wrap into the pilot — until then the surface
// honestly reports "no pools yet" rather than faking a market.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}
const el = (id) => document.getElementById(id);

export async function renderSwapTab(wallet) {
  const body = el('cswap-body');
  if (!body) return;
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to swap shielded notes.</div>';
    return;
  }
  body.innerHTML = `
    <div class="tab-form">
    <div class="note-concept"><b>Swap, shielded.</b> Trade one note for another against the
      confidential AMM — amounts and balances stay private, the trade clears on the <span class="eth-word">Ethereum</span>
      lane and settles gasless. A swap is a single-hop confidential route.</div>
    <div id="cswap-notes" class="muted">Scanning your notes…</div>
    <div class="divider">
      <label class="field-label" for="cswap-from">From note</label>
      <select id="cswap-from"></select>
      <label class="field-label" for="cswap-toasset" style="margin-top:10px;">To asset id</label>
      <input id="cswap-toasset" type="text" placeholder="0x… (32-byte asset id)">
      <div class="field-row" style="margin-top:8px;">
        <input id="cswap-amount" type="number" min="0" step="1" placeholder="Amount in (note units)">
        <input id="cswap-fee" type="number" min="0" value="30" title="fee tier (bps)" style="flex:0 0 80px;width:80px;">
        <button id="cswap-quote">Quote</button>
      </div>
      <div id="cswap-quoteout" class="muted" style="font-size:12px;margin-top:8px;"></div>
      <button id="cswap-btn" class="primary" style="margin-top:8px;" disabled>Swap</button>
      <label class="check-row" style="margin-top:10px;">
        <input id="cswap-selfrelay" type="checkbox">
        <span>Self-relay (broadcast from your own EVM account if the relayer is unavailable — reveals that account on-chain)</span>
      </label>
      <div id="cswap-status" class="muted field-status"></div>
    </div>
    </div>`;

  let lastQuote = null;
  try {
    const { notes } = await ux.balance(wallet.priv);
    const sel = el('cswap-from');
    if (sel) sel.innerHTML = (notes || []).map((n) => `<option value="${n.leafIndex}">${n.value} ${ux.tickerOf(n.asset) || n.asset.slice(0, 8)} #${n.leafIndex}</option>`).join('');
    el('cswap-notes').textContent = (notes && notes.length) ? `${notes.length} note(s) available` : 'No notes — wrap into the pool first.';
    const byLeaf = new Map((notes || []).map((n) => [String(n.leafIndex), n]));

    const quoteBtn = el('cswap-quote');
    if (quoteBtn) quoteBtn.onclick = async () => {
      const out = el('cswap-quoteout');
      const n = byLeaf.get((el('cswap-from') || {}).value);
      const toAsset = ((el('cswap-toasset') || {}).value || '').trim();
      const amountIn = BigInt(Math.max(0, Math.floor(Number((el('cswap-amount') || {}).value || 0))));
      const feeBps = Number((el('cswap-fee') || {}).value || 30);
      if (!n || !/^0x[0-9a-fA-F]{64}$/.test(toAsset) || amountIn <= 0n) { if (out) out.textContent = 'Pick a note, a destination asset id, and an amount.'; return; }
      if (out) out.textContent = 'Reading pool reserves…';
      try {
        const q = await ux.quoteRoute({ asset0: n.asset, amountIn, path: [{ assetNext: toAsset, feeBps }] });
        if (!q) { if (out) out.textContent = 'No pool for that pair/fee tier yet.'; el('cswap-btn').disabled = true; return; }
        lastQuote = { note: n, toAsset, amountIn, feeBps, amountOut: q.amountOut };
        if (out) out.innerHTML = `Receive ≈ <strong>${q.amountOut}</strong> ${ux.tickerOf(toAsset) || toAsset.slice(0, 8)} <span class="muted">(min-out applies 1% slippage)</span>`;
        el('cswap-btn').disabled = false;
      } catch (e) { if (out) out.textContent = 'Quote failed: ' + (e && e.message || e); }
    };

    const swapBtn = el('cswap-btn');
    if (swapBtn) swapBtn.onclick = async () => {
      const st = el('cswap-status');
      if (!lastQuote) { if (st) st.textContent = 'Get a quote first.'; return; }
      const minOut = (lastQuote.amountOut * 99n) / 100n; // 1% slippage guard
      swapBtn.disabled = true;
      if (st) st.textContent = 'Building + settling your swap via the relayer…';
      try {
        const selfRelay = !!(el('cswap-selfrelay') && el('cswap-selfrelay').checked);
        const r = await ux.route({
          walletPriv: wallet.priv, inNote: lastQuote.note, amountIn: lastQuote.amountIn,
          path: [{ assetNext: lastQuote.toAsset, feeBps: lastQuote.feeBps }], minOut, selfRelay,
          waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Swap ${s.status}…`; } },
        });
        if (st) st.innerHTML = 'Swap settled'
          + (r && r.txHash ? ` (<code class="addr">${r.txHash}</code>)` : '') + '.';
        setTimeout(() => renderSwapTab(wallet), 1500);
      } catch (e) { if (st) st.textContent = 'Swap failed: ' + (e && e.message || e); swapBtn.disabled = false; }
    };
  } catch (e) {
    el('cswap-notes').textContent = 'Could not scan the pool: ' + (e && e.message || e);
  }
}
