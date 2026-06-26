// Confidential Send tab — shielded note-to-note transfer on the Ethereum lane. Drives the REAL transfer
// assembler (confidential-pool-ux.buildTransferOp → confidential-transfer.js: aggregated BP+ range proof +
// conservation kernel + Keccak membership), then settles gasless through the relay (type 'transfer'). The
// recipient note is sealed to their confidential pubkey so they recover the blinding and spend it.
//
// VERIFICATION: commitXY ≡ ct.commit (verified), and the op shape is byte-identical to the guest fixture
// (contracts/sp1/confidential/fixtures/transfer_op.json), so a built op is what the settle guest re-checks.
// Goes fully live once the coordinated re-prove/redeploy pins the matching settle vkey.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
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

// Coin-select: greedily pick notes (largest first) of one asset to cover amount + fee.
function selectNotes(notes, asset, need) {
  const pool = notes.filter((n) => n.asset === asset).sort((a, b) => (BigInt(b.value) - BigInt(a.value) > 0n ? 1 : -1));
  const picked = [];
  let sum = 0n;
  for (const n of pool) { picked.push(n); sum += BigInt(n.value); if (sum >= need) break; }
  return sum >= need ? picked : null;
}

function wireSend(wallet, ux, notes) {
  const btn = el('csend-btn');
  if (!btn) return;
  const statusEl = el('csend-status');
  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    const recipient = (el('csend-recipient') && el('csend-recipient').value || '').trim();
    if (!/^0x0[23][0-9a-fA-F]{64}$/.test(recipient)) {
      if (statusEl) statusEl.textContent = 'Enter the recipient’s shielded address (33-byte compressed pubkey, 0x02…/0x03…).';
      return;
    }
    const assetSel = el('csend-asset');
    const asset = assetSel && assetSel.value;
    const ticker = ux.tickerOf(asset) || 'cETH';
    const meta = ux.assetByTicker[ticker] || {};
    // Note values + transfer amounts are in IN-SYSTEM units (tacitDecimals ≤8); the underlying wei precision
    // (meta.decimals, 18 for ETH) only governs the wrap deposit boundary. Parse the user's entry as in-system.
    const dec = meta.tacitDecimals ?? meta.decimals ?? 8;
    const amtStr = (el('csend-amount') && el('csend-amount').value || '').trim();
    const amount = (() => {
      try {
        const [i, f = ''] = amtStr.split('.');
        const frac = (f + '0'.repeat(dec)).slice(0, dec);
        return BigInt(i || '0') * (10n ** BigInt(dec)) + BigInt(frac || '0');
      } catch { return 0n; }
    })();
    if (amount <= 0n) { if (statusEl) statusEl.textContent = 'Enter an amount to send.'; return; }

    // One-tx wrap-and-send: fund the whole send from the user's public ETH / token in a SINGLE transaction
    // (OP_WRAP_TRANSFER) — no pre-existing shielded note required. The deposit is consumed straight into the
    // recipient note; the user broadcasts router.wrapAndSettle* themselves (fee-free). Available only when the
    // ConfidentialRouter is configured.
    const wantWrap = !!(el('csend-wrap') && el('csend-wrap').checked);
    if (wantWrap) {
      if (!(ux.routerConfigured && ux.routerConfigured())) { if (statusEl) statusEl.textContent = 'One-tx wrap-and-send needs the ConfidentialRouter (not deployed on this network yet).'; return; }
      const unitScale = BigInt(meta.unitScale || '1');
      const amountWei = amount * unitScale; // in-system → underlying (wei) for the deposit boundary
      btn.disabled = true;
      if (statusEl) statusEl.textContent = `Proving + sending ${fmtUnits(amount, dec)} ${ticker} in one transaction…`;
      try {
        const r = await ux.wrapAndSend({
          walletPriv: wallet.priv, amountWei, ticker, recipientPubHex: recipient,
          amount, // in-system recipient value (no change leg)
          waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `Wrap-and-send ${st.status}…`; } },
        });
        if (statusEl) statusEl.innerHTML = `Wrapped + sent ${fmtUnits(amount, dec)} ${ticker} in one tx`
          + (r && r.txHash ? ` (<code style="font-size:10px;word-break:break-all;">${r.txHash}</code>)` : '')
          + ' — the recipient recovers it from their key alone.';
        setTimeout(() => renderSendTab(wallet), 1500);
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Wrap-and-send failed: ' + (e && e.message || e);
        btn.disabled = false;
      }
      return;
    }

    const fee = 0n; // relay fee carving for transfers ships with the matcher; self-settle for now
    const picked = selectNotes(notes, asset, amount + fee);
    if (!picked) { if (statusEl) statusEl.textContent = 'Insufficient shielded balance — tick “pay from my wallet” to wrap and send in one transaction.'; return; }
    btn.disabled = true;
    if (statusEl) statusEl.textContent = `Building a ${picked.length}-input transfer + settling via the relayer…`;
    try {
      const selfRelay = !!(el('csend-selfrelay') && el('csend-selfrelay').checked);
      const r = await ux.transfer({
        walletPriv: wallet.priv, notes: picked, recipientPubHex: recipient, amount, fee, selfRelay,
        waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `Send ${st.status}…`; } },
      });
      if (statusEl) statusEl.innerHTML = `Sent ${fmtUnits(amount, dec)} ${ticker}`
        + (r && r.txHash ? ` (<code style="font-size:10px;word-break:break-all;">${r.txHash}</code>)` : '')
        + ' — the recipient recovers it from their key.';
      setTimeout(() => renderSendTab(wallet), 1500);
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Send failed: ' + (e && e.message || e);
      btn.disabled = false;
    }
  };
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
        + (r && r.txHash ? ` (<code style="font-size:10px;word-break:break-all;">${r.txHash}</code>)` : '')
        + ' — the recipient’s note settles after the deposit confirms.';
    } catch (e) { if (st) st.textContent = 'Payment failed: ' + (e && e.message || e); }
    payBtn.disabled = false;
  };
}

export async function renderSendTab(wallet) {
  const body = el('csend-body');
  if (!body) return;
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to send a shielded note.</div>';
    return;
  }
  const id = ux.identity(wallet.priv);
  body.innerHTML = `
    <div class="note-concept" style="margin-bottom:12px;"><b>Send a shielded note.</b> Transfer value note-to-note on the
      <span class="eth-word">Ethereum</span> lane — amounts stay hidden, the recipient recovers it from their key alone.
      Same note model as the <span class="btc-word">Bitcoin</span> side.</div>
    <div style="margin-bottom:10px;">Your shielded address <span class="muted">(share to receive)</span>:
      <code id="csend-myaddr" style="font-size:10px;word-break:break-all;">${id.pubHex}</code></div>
    <div id="csend-balance" class="muted" style="font-size:12px;margin-bottom:12px;">Scanning your notes…</div>

    <div style="border-top:1px solid var(--hairline,#eee);padding-top:12px;">
      <label style="font-size:11px;color:var(--ink-mid);">Recipient shielded address</label>
      <input id="csend-recipient" type="text" placeholder="0x02… / 0x03… (33-byte pubkey)" style="width:100%;box-sizing:border-box;padding:6px;font-size:12px;border:1px solid var(--ink,#ccc);border-radius:4px;margin:4px 0 8px;">
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="csend-asset" style="padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;">
          ${ux.assets.map((a) => `<option value="${a.assetId}">${a.ticker}</option>`).join('')}
        </select>
        <input id="csend-amount" type="number" min="0" step="0.0001" placeholder="Amount" style="flex:1;padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;">
        <button id="csend-btn" style="padding:6px 14px;font-size:13px;cursor:pointer;">Send</button>
      </div>
      <label style="display:flex;gap:6px;align-items:center;font-size:11px;color:var(--ink-mid);margin-top:8px;cursor:pointer;">
        <input id="csend-wrap" type="checkbox">
        Pay from my wallet in one transaction (wrap public ETH/token → confidential send, no shielded balance needed)
      </label>
      <label style="display:flex;gap:6px;align-items:center;font-size:11px;color:var(--ink-mid);margin-top:8px;cursor:pointer;">
        <input id="csend-selfrelay" type="checkbox">
        Self-relay (broadcast from your own EVM account if the relayer is unavailable — reveals that account on-chain)
      </label>
      <div id="csend-status" class="muted" style="font-size:11px;margin-top:8px;"></div>
    </div>

    <details style="border-top:1px solid var(--hairline,#eee);margin-top:14px;padding-top:10px;">
      <summary style="cursor:pointer;font-weight:600;font-size:12px;">Receive by invoice <span class="muted" style="font-weight:400;">· request a confidential payment</span></summary>
      <div style="padding-top:8px;">
        <div class="muted" style="font-size:11px;margin-bottom:6px;">Generate an invoice and hand it to a payer. They wrap public funds straight into a note only you can spend — they never learn your blinding.</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="csend-inv-asset" style="padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;">
            ${ux.assets.map((a) => `<option value="${a.ticker}">${a.ticker}</option>`).join('')}
          </select>
          <input id="csend-inv-amount" type="number" min="0" step="0.0001" placeholder="Amount" style="flex:1;padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;">
          <button id="csend-inv-btn" style="padding:6px 14px;font-size:13px;cursor:pointer;">Create invoice</button>
        </div>
        <textarea id="csend-inv-out" rows="4" readonly placeholder="Your invoice appears here to copy + share" style="width:100%;box-sizing:border-box;margin-top:6px;padding:6px;font-size:10px;font-family:var(--mono);border:1px solid var(--ink,#ccc);border-radius:4px;"></textarea>
        <div id="csend-inv-status" class="muted" style="font-size:11px;margin-top:4px;"></div>
      </div>
    </details>

    <details style="border-top:1px solid var(--hairline,#eee);margin-top:8px;padding-top:10px;">
      <summary style="cursor:pointer;font-weight:600;font-size:12px;">Pay an invoice <span class="muted" style="font-weight:400;">· settle a confidential request</span></summary>
      <div style="padding-top:8px;">
        <textarea id="csend-pay-input" rows="4" placeholder="Paste an invoice JSON" style="width:100%;box-sizing:border-box;padding:6px;font-size:10px;font-family:var(--mono);border:1px solid var(--ink,#ccc);border-radius:4px;"></textarea>
        <button id="csend-pay-btn" style="padding:6px 14px;font-size:13px;cursor:pointer;margin-top:6px;">Verify + pay</button>
        <div id="csend-pay-status" class="muted" style="font-size:11px;margin-top:4px;"></div>
      </div>
    </details>`;

  wireInvoice(wallet, ux);

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
        : 'No shielded notes yet — wrap into the pool first.';
    }
    wireSend(wallet, ux, notes || []);
  } catch (e) {
    const balEl = el('csend-balance');
    if (balEl) balEl.textContent = 'Could not scan the pool: ' + (e && e.message || e);
  }
}
