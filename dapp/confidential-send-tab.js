// Confidential Send tab — the shielded payment surface on the Ethereum lane. One intent: pay a recipient
// privately. The tab decides HOW automatically:
//   - enough shielded balance → note-to-note transfer (confidential-transfer.js: aggregated BP+ range proof
//     + conservation kernel + Keccak membership), settled gasless through the relay (type 'transfer');
//   - no note yet → one-tx wrap-and-send from the user's public ETH/token (OP_WRAP_TRANSFER), gasless permit
//     for ERC20 (USDC = one click, no approve), the deposit consumed straight into the recipient note.
// "Just hold it privately" wraps into a note the user owns (no recipient). Receiving is a Tacit address
// (one handle, both chains) or an invoice.
//
// VERIFICATION: commitXY ≡ ct.commit (verified), and the op shape is byte-identical to the guest fixtures,
// so a built op is what the settle guest re-checks. Goes fully live once the coordinated re-prove/redeploy
// pins the matching settle vkey.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatErr, notify } from './confidential-deployments.js';
import { makeConfidentialInvoice } from './confidential-invoice.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}
const el = (id) => document.getElementById(id);

function fmtUnits(v, decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals) || '0';
  const f = s.slice(-decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// Parse a decimal entry into in-system base units at `dec` decimals. Returns 0n on any malformed input.
function parseAmount(amtStr, dec) {
  try {
    const [i, f = ''] = String(amtStr || '').trim().split('.');
    const frac = (f + '0'.repeat(dec)).slice(0, dec);
    return BigInt(i || '0') * (10n ** BigInt(dec)) + BigInt(frac || '0');
  } catch { return 0n; }
}

// Coin-select: greedily pick notes (largest first) of one asset to cover amount + fee.
function selectNotes(notes, asset, need) {
  const pool = notes.filter((n) => n.asset === asset).sort((a, b) => (BigInt(b.value) - BigInt(a.value) > 0n ? 1 : -1));
  const picked = [];
  let sum = 0n;
  for (const n of pool) { picked.push(n); sum += BigInt(n.value); if (sum >= need) break; }
  return sum >= need ? picked : null;
}

// Resolve the chosen asset + amount from the form. Returns { asset, ticker, meta, dec, amount } or null.
function readAssetAmount(ux, assetElId, amountElId) {
  const asset = (el(assetElId) || {}).value;
  if (!asset) return null;
  const ticker = ux.tickerOf(asset) || 'cETH';
  const meta = ux.assetByTicker[ticker] || {};
  // Note values + amounts are IN-SYSTEM units (tacitDecimals ≤8); underlying wei precision (meta.decimals,
  // 18 for ETH) only governs the wrap deposit boundary.
  const dec = meta.tacitDecimals ?? meta.decimals ?? 8;
  const amount = parseAmount((el(amountElId) || {}).value, dec);
  return { asset, ticker, meta, dec, amount };
}

// Auto pay: spend existing notes when they cover the amount, else wrap-and-send from the wallet in one tx.
// The user never chooses the mechanism; the status line reports which path ran.
function wireSend(wallet, ux, notes, helpers) {
  const btn = el('csend-btn');
  if (!btn) return;
  const statusEl = el('csend-status');
  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    const rawRecipient = (el('csend-recipient') && el('csend-recipient').value || '').trim();
    // Accept a unified Tacit address (tacit1…, resolved to its Ethereum lane) or a raw shielded pubkey.
    // resolveRecipient keeps parsing identical to the rest of the dapp.
    let recipient;
    if (helpers && typeof helpers.resolveRecipient === 'function') {
      const r = helpers.resolveRecipient(rawRecipient);
      if (r.error) { if (statusEl) statusEl.textContent = r.error; return; }
      recipient = r.pubHex;
    } else {
      if (!/^0x0[23][0-9a-fA-F]{64}$/.test(rawRecipient)) {
        if (statusEl) statusEl.textContent = 'Enter a Tacit address (tacit1…) or the recipient’s shielded pubkey (0x02…/0x03…).';
        return;
      }
      recipient = rawRecipient;
    }
    const sel = readAssetAmount(ux, 'csend-asset', 'csend-amount');
    if (sel && sel.asset === '__btc__') { if (statusEl) statusEl.textContent = 'That asset is sent on the Bitcoin lane — use the Bitcoin send.'; return; }
    if (!sel || sel.amount <= 0n) { if (statusEl) statusEl.textContent = 'Enter an amount to send.'; return; }
    const { asset, ticker, meta, dec, amount } = sel;

    const fee = 0n; // relay fee carving for transfers ships with the matcher; self-settle for now
    const forceWrap = !!(el('csend-forcewrap') && el('csend-forcewrap').checked);
    const routerOK = !!(ux.routerConfigured && ux.routerConfigured());
    const picked = forceWrap ? null : selectNotes(notes, asset, amount + fee);

    btn.disabled = true;
    try {
      if (picked) {
        // Pay from the shielded balance already in the pool — note-to-note transfer.
        if (statusEl) statusEl.textContent = `Sending ${fmtUnits(amount, dec)} ${ticker} from your shielded balance…`;
        const selfRelay = !!(el('csend-selfrelay') && el('csend-selfrelay').checked);
        const r = await ux.transfer({
          walletPriv: wallet.priv, notes: picked, recipientPubHex: recipient, amount, fee, selfRelay,
          waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `Send ${st.status}…`; } },
        });
        if (statusEl) statusEl.innerHTML = `Sent ${fmtUnits(amount, dec)} ${esc(ticker)}`
          + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '')
          + ' — the recipient recovers it from their key.';
        notify(`Sent ${fmtUnits(amount, dec)} ${ticker}`, 'ok');
        setTimeout(() => renderSendTab(wallet, helpers), 1500);
        return;
      }
      // No (usable) shielded balance → wrap from the wallet and send in one transaction.
      if (!routerOK) {
        if (statusEl) statusEl.textContent = 'No shielded balance for this yet — use “Hold it privately” below to wrap in first (the one-tx router isn’t deployed on this network).';
        btn.disabled = false;
        return;
      }
      const unitScale = BigInt(meta.unitScale || '1');
      const amountWei = amount * unitScale; // in-system → underlying (wei) for the deposit boundary
      if (statusEl) statusEl.textContent = `No shielded balance yet — wrapping + sending ${fmtUnits(amount, dec)} ${ticker} from your wallet in one transaction…`;
      const r = await ux.wrapAndSend({
        walletPriv: wallet.priv, amountWei, ticker, recipientPubHex: recipient, amount,
        waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `Wrap-and-send ${st.status}…`; } },
      });
      if (statusEl) statusEl.innerHTML = `Wrapped + sent ${fmtUnits(amount, dec)} ${esc(ticker)} in one tx`
        + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '')
        + ' — the recipient recovers it from their key alone.';
      notify(`Wrapped + sent ${fmtUnits(amount, dec)} ${ticker}`, 'ok');
      setTimeout(() => renderSendTab(wallet, helpers), 1500);
    } catch (e) {
      const m = formatErr(e, 'Send');
      if (statusEl) statusEl.textContent = m; notify(m, 'error');
      btn.disabled = false;
    }
  };
}

// "Just hold it privately": wrap public ETH/token into a confidential note the user owns — no recipient,
// no send. Gasless one-tx router wrap when the router is live; direct pool deposit otherwise (native ETH).
function wireHold(wallet, ux) {
  const btn = el('csend-hold-btn');
  if (!btn) return;
  const statusEl = el('csend-hold-status');
  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    const sel = readAssetAmount(ux, 'csend-hold-asset', 'csend-hold-amount');
    if (!sel || sel.amount <= 0n) { if (statusEl) statusEl.textContent = 'Enter an amount to wrap.'; return; }
    const { ticker, meta, dec, amount } = sel;
    const routerOK = !!(ux.routerConfigured && ux.routerConfigured());
    if (!routerOK && !meta.native) { if (statusEl) statusEl.textContent = 'Wrapping this token needs the ConfidentialRouter (not deployed on this network yet).'; return; }
    const unitScale = BigInt(meta.unitScale || '1');
    const amountWei = amount * unitScale;
    btn.disabled = true;
    if (statusEl) statusEl.textContent = `Wrapping ${fmtUnits(amount, dec)} ${ticker} into a private note you own…`;
    try {
      const r = routerOK
        ? await ux.routerWrap({ walletPriv: wallet.priv, amountWei, ticker })
        : await ux.wrap({ walletPriv: wallet.priv, amountWei, ticker });
      if (statusEl) statusEl.innerHTML = `Wrap broadcast${routerOK ? ' (one-tx router)' : ''}`
        + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '')
        + ` — your ${esc(ticker)} note appears once the deposit settles.`;
      notify('Wrap broadcast — awaiting settle', 'ok');
      setTimeout(() => renderSendTab(wallet), 2000);
    } catch (e) {
      const m = formatErr(e, 'Wrap');
      if (statusEl) statusEl.textContent = m; notify(m, 'error');
      btn.disabled = false;
    }
  };
}

// Asset-first lane toggle: the asset dropdown chooses the lane. Ethereum/pool assets show the inline
// shielded-send controls; the Bitcoin option swaps in a handoff to the mature Bitcoin send surface (that
// live flow is not reimplemented here — see the module header).
function wireAssetLane() {
  const sel = el('csend-asset');
  const evm = el('csend-evm-controls');
  const btc = el('csend-btc-handoff');
  if (!sel || !evm || !btc) return;
  const apply = () => {
    const isBtc = sel.value === '__btc__';
    evm.style.display = isBtc ? 'none' : '';
    btc.style.display = isBtc ? '' : 'none';
  };
  sel.onchange = apply;
  apply();
}

// Invoice receive (create a shareable request) + pay (wrap public funds into the recipient's note).
function wireInvoice(wallet, ux) {
  const inv = makeConfidentialInvoice({ ux });
  const createBtn = document.getElementById('csend-inv-btn');
  if (createBtn) createBtn.onclick = () => {
    const st = document.getElementById('csend-inv-status');
    const ticker = (document.getElementById('csend-inv-asset') || {}).value || 'cETH';
    const meta = ux.assetByTicker[ticker];
    const dec = meta ? meta.decimals : 18;
    const amtStr = (document.getElementById('csend-inv-amount') || {}).value || '';
    let amountWei;
    try {
      const [i, f = ''] = String(amtStr).split('.');
      amountWei = (BigInt(i || '0') * (10n ** BigInt(dec)) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0')).toString();
    } catch { amountWei = '0'; }
    if (!amountWei || amountWei === '0') { if (st) st.textContent = 'Enter an amount.'; return; }
    try {
      const { invoice } = inv.createInvoice({ recipientPriv: wallet.priv, ticker, amountWei, index: Date.now() % 1000000 });
      const out = document.getElementById('csend-inv-out');
      if (out) out.value = JSON.stringify(invoice);
      if (st) st.textContent = 'Invoice ready — copy + share it with your payer.';
    } catch (e) { if (st) st.textContent = 'Could not create invoice: ' + (e && e.message || e); }
  };

  const payBtn = document.getElementById('csend-pay-btn');
  if (payBtn) payBtn.onclick = async () => {
    const st = document.getElementById('csend-pay-status');
    const raw = (document.getElementById('csend-pay-input') || {}).value || '';
    let invoice;
    try { invoice = JSON.parse(raw.trim()); } catch { if (st) st.textContent = 'Invoice is not valid JSON.'; return; }
    if (!inv.verifyInvoice(invoice)) { if (st) st.textContent = 'Invoice failed verification (malformed / not claimable).'; return; }
    payBtn.disabled = true;
    if (st) st.textContent = 'Paying the invoice…';
    try {
      const r = await ux.payInvoice({ payerPriv: wallet.priv, invoice });
      if (st) st.innerHTML = 'Paid'
        + (r && r.txHash ? ` (<code class="addr">${r.txHash}</code>)` : '')
        + ' — the recipient’s note settles after the deposit confirms.';
    } catch (e) { if (st) st.textContent = 'Payment failed: ' + (e && e.message || e); }
    payBtn.disabled = false;
  };
}

export async function renderSendTab(wallet, helpers = {}) {
  const body = el('csend-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Confidential Send'); return; }
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to send a shielded note.</div>';
    return;
  }
  const id = ux.identity(wallet.priv);
  const myTacit = helpers.tacitAddress || null;
  // Show the example prefix for the active network (tacit1… mainnet / tactt1… signet / tacrt1… regtest),
  // derived from the holder's own address so it always matches what they'll receive.
  const addrPrefix = (myTacit && myTacit.split('1')[0]) || 'tacit';
  const assetOptions = ux.assets.map((a) => `<option value="${a.assetId}">${a.ticker}</option>`).join('');
  body.innerHTML = `
    <div class="tab-form">
    <div class="note-concept"><b>Pay privately.</b> Send value on the <span class="eth-word">Ethereum</span> lane —
      amounts stay hidden and the recipient recovers it from their key alone. It pays from your shielded balance,
      or wraps public <span class="eth-word">ETH</span>/tokens from your wallet in one transaction if you have no note
      yet (for tokens like <b>USDC</b>, no approval step — a single gasless permit). To move value between chains
      (e.g. cETH ⇄ tETH on <span class="btc-word">Bitcoin</span>), use the bridge; for <span class="btc-word">real
      sats</span> or Bitcoin-native assets, use the <a href="#tab=transfer">Bitcoin send</a>.</div>
    <div>Your Tacit address <span class="muted">(one handle, both chains — share to receive)</span>:
      ${myTacit
        ? `<code id="csend-myaddr" class="addr">${myTacit}</code>
           <button id="csend-copyaddr" type="button" class="btn-copy" style="font-size:10px;padding:2px 8px;margin-left:6px;">Copy</button>
           <div class="muted" style="font-size:10px;margin-top:2px;">Pays you on <span class="btc-word">Bitcoin</span> or <span class="eth-word">Ethereum</span> from a single string. <details style="display:inline;"><summary style="display:inline;cursor:pointer;list-style:none;">Ethereum-only pubkey ▾</summary> <code class="addr" style="font-size:10px;">${id.pubHex}</code></details></div>
           <div class="muted" style="font-size:10px;margin-top:2px;">Sharing this links your own two lanes to whoever receives it (inherent to a “pay me anywhere” handle) — it doesn’t weaken anyone else’s unlinkability. Want lane isolation? Use a per-lane address instead.</div>`
        : `<code id="csend-myaddr" class="addr">${id.pubHex}</code>`}
    </div>
    <div id="csend-balance" class="muted">Scanning your notes…</div>

    <div class="divider">
      <label class="field-label" for="csend-asset">Asset</label>
      <select id="csend-asset">
        <optgroup label="Ethereum · shielded pool">${assetOptions}</optgroup>
        <optgroup label="Bitcoin">
          <option value="__btc__">Bitcoin-native asset or plain sats…</option>
        </optgroup>
      </select>
      <div class="muted" style="font-size:10px;margin-top:3px;">Pick what you're sending — the lane follows the asset.</div>

      <div id="csend-evm-controls" style="margin-top:12px;">
        <label class="field-label" for="csend-recipient">To</label>
        <input id="csend-recipient" type="text" placeholder="${addrPrefix}1… address or 0x02…/0x03… shielded pubkey">
        <div class="field-row" style="margin-top:8px;">
          <input id="csend-amount" type="number" min="0" step="0.0001" placeholder="Amount">
          <button id="csend-btn" class="primary">Send privately</button>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px;">Pays automatically — from your shielded balance if you have it, otherwise wrapped from your wallet in one tx. The recipient ends up holding a <b>shielded note</b>.</div>
        <div id="csend-status" class="muted field-status"></div>
        <details style="margin-top:8px;">
          <summary class="muted" style="font-size:11px;cursor:pointer;list-style:none;">Options ▾</summary>
          <label class="check-row" style="margin-top:8px;">
            <input id="csend-forcewrap" type="checkbox">
            <span>Always pay from my wallet — wrap fresh public funds, don’t spend existing notes.</span>
          </label>
          <label class="check-row" style="margin-top:8px;">
            <input id="csend-selfrelay" type="checkbox">
            <span>Self-relay (broadcast from your own EVM account if the relayer is unavailable — reveals that account on-chain).</span>
          </label>
        </details>
        ${helpers.crosslaneLive ? `
        <div class="muted" style="font-size:11px;margin-top:10px;padding-top:8px;border-top:1px dashed var(--ink-faint);">
          Moving value to <span class="btc-word">Bitcoin</span>? cETH bridges 1:1 to <b>tETH</b> and back —
          <a href="#" id="csend-bridge-link">open the bridge →</a>
        </div>` : ''}
      </div>

      <div id="csend-btc-handoff" style="display:none;margin-top:12px;padding:10px 12px;border:1px dashed var(--ink-faint);font-size:12px;line-height:1.5;">
        <b>Bitcoin lane.</b> Bitcoin-native tacit assets — shielded amounts by default, with the option to send to a
        <span class="btc-word">shielded / stealth address</span> to hide the recipient too — and plain sats are sent on the
        Bitcoin side. <a href="#tab=transfer">Continue on the Bitcoin send →</a>
      </div>
    </div>

    <div class="divider">
      <div style="font-weight:600;margin-bottom:4px;">Just hold it privately <span class="muted" style="font-weight:400;font-size:11px;">· wrap in, no recipient</span></div>
      <div class="muted" style="font-size:11px;margin-bottom:6px;">Turn public <span class="eth-word">ETH</span> or a token into a shielded note you own — nothing is sent, your balance just becomes private.</div>
      <div class="field-row">
        <select id="csend-hold-asset">${assetOptions}</select>
        <input id="csend-hold-amount" type="number" min="0" step="0.0001" placeholder="Amount">
        <button id="csend-hold-btn">Wrap</button>
      </div>
      <div id="csend-hold-status" class="muted field-status" style="margin-top:6px;"></div>
    </div>

    <details class="divider">
      <summary>Receive by invoice <span class="muted" style="font-weight:400;">· request a confidential payment</span></summary>
      <div class="details-body">
        <div class="muted" style="font-size:11px;margin-bottom:8px;">Generate an invoice and hand it to a payer. They wrap public funds straight into a note only you can spend — they never learn your blinding.</div>
        <div class="field-row">
          <select id="csend-inv-asset">
            ${ux.assets.map((a) => `<option value="${a.ticker}">${a.ticker}</option>`).join('')}
          </select>
          <input id="csend-inv-amount" type="number" min="0" step="0.0001" placeholder="Amount">
          <button id="csend-inv-btn">Create invoice</button>
        </div>
        <textarea id="csend-inv-out" rows="4" readonly placeholder="Your invoice appears here to copy + share" style="margin-top:8px;font-size:10px;font-family:var(--mono);"></textarea>
        <div id="csend-inv-status" class="muted field-status" style="margin-top:4px;"></div>
      </div>
    </details>

    <details class="divider">
      <summary>Pay an invoice <span class="muted" style="font-weight:400;">· settle a confidential request</span></summary>
      <div class="details-body">
        <textarea id="csend-pay-input" rows="4" placeholder="Paste an invoice JSON" style="font-size:10px;font-family:var(--mono);"></textarea>
        <button id="csend-pay-btn" style="margin-top:8px;">Verify + pay</button>
        <div id="csend-pay-status" class="muted field-status" style="margin-top:4px;"></div>
      </div>
    </details>
    </div>`;

  wireInvoice(wallet, ux);
  wireHold(wallet, ux);
  wireAssetLane();

  const copyBtn = el('csend-copyaddr');
  if (copyBtn && myTacit) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(myTacit); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200); }
    catch { copyBtn.textContent = 'Copy failed'; }
  };

  const bridgeLink = el('csend-bridge-link');
  if (bridgeLink && typeof helpers.openBridge === 'function') bridgeLink.onclick = (e) => { e.preventDefault(); helpers.openBridge(); };

  try {
    const { byAsset, notes } = await ux.balance(wallet.priv);
    const balEl = el('csend-balance');
    const assets = Object.values(byAsset || {});
    if (balEl) {
      balEl.innerHTML = assets.length
        ? '<div style="font-weight:600;color:var(--ink);margin-bottom:4px;">Shielded balance</div>'
          + assets.map((a) => {
            const m = ux.assets.find((x) => x.assetId.toLowerCase() === a.asset) || {};
            const dec = m.tacitDecimals ?? m.decimals ?? 8; // note values are in-system units
            return `<div style="padding:2px 0;">${fmtUnits(a.value, dec)} ${a.ticker || a.asset.slice(0, 10) + '…'}</div>`;
          }).join('')
        : 'No shielded notes yet — “Send privately” will wrap from your wallet automatically, or use “Hold it privately” to just make funds private.';
    }
    wireSend(wallet, ux, notes || [], helpers);
  } catch (e) {
    const balEl = el('csend-balance');
    if (balEl) balEl.textContent = 'Could not scan the pool: ' + (e && e.message || e);
  }
}
