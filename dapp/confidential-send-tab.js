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
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatErr, notify, proveUpdater } from './confidential-deployments.js';
import { makeConfidentialInvoice } from './confidential-invoice.js';

let _ux = null;
let _pendingSend = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}
const el = (id) => document.getElementById(id);

function short(s, n = 10) {
  const x = String(s || '');
  return x.length <= (n * 2 + 3) ? x : `${x.slice(0, n)}…${x.slice(-n)}`;
}

const SVG_USDC = `<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="none"><circle fill="#3E73C4" cx="16" cy="16" r="16"/><g fill="#FFF"><path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z"/><path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z"/></g></g></svg>`;
const SVG_ETH = `<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="none" fill-rule="evenodd"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#FFF" fill-rule="nonzero"><path fill-opacity=".602" d="M16.498 4v8.87l7.497 3.35z"/><path d="M16.498 4L9 16.22l7.498-3.35z"/><path fill-opacity=".602" d="M16.498 21.968v6.027L24 17.616z"/><path d="M16.498 27.995v-6.028L9 17.616z"/><path fill-opacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z"/><path fill-opacity=".602" d="M9 16.22l7.498 4.353v-7.701z"/></g></g></svg>`;

const SVG_WSTETH = `<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="none"><circle fill="#00A3FF" cx="16" cy="16" r="16"/><path d="M9.437 14.864l-.181.275c-2.048 3.097-1.603 7.253 1.034 9.824 1.561 1.521 3.622 2.353 5.683 2.353 0 0 0 0-6.536-12.452z" fill="#FFF"/><path opacity=".6" d="M15.997 18.611l-6.56-3.747c6.56 12.452 6.56 12.452 6.56 12.452 0-2.683 0-5.623 0-8.705z" fill="#FFF"/><path opacity=".6" d="M22.563 14.864l.181.275c2.048 3.097 1.603 7.253-1.034 9.824-1.561 1.521-3.622 2.353-5.683 2.353 0 0 0 0 6.536-12.452z" fill="#FFF"/><path opacity=".2" d="M16.003 18.611l6.56-3.747c-6.56 12.452-6.56 12.452-6.56 12.452 0-2.683 0-5.623 0-8.705z" fill="#FFF"/><path opacity=".2" d="M16.004 10.239v6.459l5.654-3.23-5.654-3.229z" fill="#FFF"/><path opacity=".6" d="M16.005 10.239l-5.655 3.229 5.655 3.23v-6.46z" fill="#FFF"/><path d="M16.005 4.805l-5.655 8.668 5.655-3.233V4.805z" fill="#FFF"/><path opacity=".6" d="M16.004 10.238l5.658 3.23-5.658-8.674v5.444z" fill="#FFF"/></g></svg>`;
const SVG_USDT = `<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="none"><circle cx="16" cy="16" r="16" fill="#26A17B"/><path fill="#FFF" d="M17.922 17.383v-.002c-.11.008-.677.042-1.942.042-1.01 0-1.721-.03-1.971-.042v.003c-3.888-.171-6.79-.848-6.79-1.658 0-.809 2.902-1.486 6.79-1.66v2.644c.254.018.982.061 1.988.061 1.207 0 1.812-.05 1.925-.06v-2.643c3.88.173 6.775.85 6.775 1.658 0 .81-2.895 1.485-6.775 1.657m0-3.59v-2.366h5.414V7.819H8.595v3.608h5.414v2.365c-4.4.202-7.709 1.074-7.709 2.118 0 1.044 3.309 1.915 7.709 2.118v7.583h3.913v-7.585c4.393-.202 7.694-1.073 7.694-2.116 0-1.043-3.301-1.914-7.694-2.117"/></g></svg>`;

function assetIcon(ticker) {
  if (ticker === 'cUSDC' || ticker === 'USDC') return SVG_USDC;
  if (ticker === 'cUSDT' || ticker === 'USDT') return SVG_USDT;
  if (ticker === 'cwstETH' || ticker === 'wstETH') return SVG_WSTETH;
  if (ticker === 'cETH' || ticker === 'ETH' || ticker === 'tETH') return SVG_ETH;
  return '';
}

function assetMark(ticker) {
  const icon = assetIcon(ticker);
  if (icon) return `<span class="csend-coin">${icon}</span>`;
  const label = ticker === 'cBTC' ? 'BTC' : ticker === 'cUSD' ? 'USD' : publicAssetLabel(ticker).slice(0, 3).toUpperCase();
  return `<span class="csend-coin csend-coin-text">${esc(label)}</span>`;
}

function publicAssetLabel(ticker) {
  return ({
    cETH: 'ETH',
    cUSDC: 'USDC',
    cBTC: 'tacBTC',
    cUSD: 'tacUSD',
    TAC: 'TAC',
  })[ticker] || String(ticker || '').replace(/^c/, '') || 'asset';
}

function amountPlaceholder(ticker) {
  return `${publicAssetLabel(ticker)} amount`;
}

function amountStep(ticker) {
  return ticker === 'cUSDC' ? '0.000001' : '0.00000001';
}

function evmAssetId(chainId, underlying) {
  const tag = new TextEncoder().encode('tacit-evm-token-v1');
  const addr = String(underlying || '').replace(/^0x/, '').padStart(40, '0');
  if (!/^[0-9a-fA-F]{40}$/.test(addr)) return null;
  const b = new Uint8Array(46);
  b.set(tag, 0);
  new DataView(b.buffer).setBigUint64(18, BigInt(chainId), false);
  b.set(Uint8Array.from(addr.match(/../g).map((h) => parseInt(h, 16))), 26);
  return '0x' + Array.from(sha256(b), (x) => x.toString(16).padStart(2, '0')).join('');
}

async function isPoolAssetRegistered(ux, assetId) {
  const selector = Array.from(keccak_256(new TextEncoder().encode('assets(bytes32)')).slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
  const data = '0x' + selector + String(assetId).replace(/^0x/, '').padStart(64, '0');
  const out = await ux.ethCall(ux.cfg.pool, data);
  return /^0x0*1[0-9a-f]*$/i.test(String(out || '').slice(0, 66));
}

async function attachRegisteredExternalSendAssets(ux) {
  const erc20s = Array.isArray(ux.cfg.externalErc20) ? ux.cfg.externalErc20 : [];
  const added = [];
  for (const t of erc20s) {
    if (String(t.ticker || '').toUpperCase() !== 'USDC') continue;
    const assetId = evmAssetId(ux.cfg.chainId, t.address);
    if (!assetId || ux.assetByTicker.cUSDC) continue;
    let registered = false;
    try { registered = await isPoolAssetRegistered(ux, assetId); } catch {}
    if (!registered) continue;
    const meta = {
      ticker: 'cUSDC', assetId, underlying: t.address, unitScale: '1', decimals: 6, tacitDecimals: 6,
      native: false, live: false, permitName: 'USD Coin', permitVersion: '2',
      description: 'Confidential USDC in the Tacit pool.',
    };
    ux.assetByTicker.cUSDC = meta;
    ux.assets.push(meta);
    added.push(meta);
  }
  return added;
}

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
  if (asset === '__btc__') return { asset, ticker: 'BTC', meta: {}, dec: 8, amount: 0n };
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
  const reviewBtn = el('csend-review-btn');
  const btn = el('csend-btn');
  const previewEl = el('csend-preview');
  if (!btn || !reviewBtn) return;
  const statusEl = el('csend-status');

  const invalidate = () => {
    _pendingSend = null;
    btn.disabled = true;
    if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
    if (statusEl) statusEl.textContent = '';
  };
  ['csend-recipient', 'csend-amount', 'csend-asset', 'csend-forcewrap', 'csend-selfrelay'].forEach((id) => {
    const x = el(id);
    if (x) x.addEventListener(id === 'csend-asset' || id === 'csend-forcewrap' || id === 'csend-selfrelay' ? 'change' : 'input', invalidate);
  });

  function readIntent() {
    if (!wallet || !wallet.priv) throw new Error('Unlock your wallet first.');
    const rawRecipient = (el('csend-recipient') && el('csend-recipient').value || '').trim();
    let recipient;
    if (helpers && typeof helpers.resolveRecipient === 'function') {
      const r = helpers.resolveRecipient(rawRecipient);
      if (r.error) throw new Error(r.error);
      recipient = r.pubHex;
    } else {
      if (!/^0x0[23][0-9a-fA-F]{64}$/.test(rawRecipient)) {
        throw new Error('Enter a Tacit address (tacit1…) or the recipient’s shielded pubkey (0x02…/0x03…).');
      }
      recipient = rawRecipient;
    }
    const sel = readAssetAmount(ux, 'csend-asset', 'csend-amount');
    if (sel && sel.asset === '__btc__') throw new Error('That asset is sent on the Bitcoin lane — use the Bitcoin send.');
    if (!sel || sel.amount <= 0n) throw new Error('Enter an amount to send.');
    const { asset, ticker, meta, dec, amount } = sel;

    const fee = 0n; // relay fee carving for transfers ships with the matcher; self-settle for now
    const forceWrap = !!(el('csend-forcewrap') && el('csend-forcewrap').checked);
    const selfRelay = !!(el('csend-selfrelay') && el('csend-selfrelay').checked);
    const routerOK = !!(ux.routerConfigured && ux.routerConfigured());
    const picked = forceWrap ? null : selectNotes(notes, asset, amount + fee);
    const source = picked ? 'shielded' : 'wrap';
    if (!picked && !routerOK) {
      throw new Error(forceWrap
        ? 'Fresh wallet sends need the ConfidentialRouter on this network. Turn off “Always pay from my wallet”, or wrap first and send from shielded balance.'
        : 'No shielded balance for this asset yet, and the one-tx ConfidentialRouter is not deployed on this network.');
    }
    const unitScale = BigInt(meta.unitScale || '1');
    const amountWei = amount * unitScale;
    return { asset, ticker, meta, dec, amount, amountWei, fee, forceWrap, selfRelay, routerOK, picked, recipient, source };
  }

  reviewBtn.onclick = () => {
    try {
      const intent = readIntent();
      const acct = ux.account(wallet.priv);
      _pendingSend = intent;
      if (previewEl) {
        const pathRows = intent.source === 'shielded'
          ? `<div class="row"><span class="label">Path</span> note-to-note transfer from your existing shielded notes</div>
             <div class="row"><span class="label">Settlement</span> ${intent.selfRelay ? 'self-relayed from your EVM account' : 'relayed pool settlement'}</div>`
          : `<div class="row"><span class="label">Path</span> wrap public ${esc(publicAssetLabel(intent.ticker))} + mint Alice a shielded note</div>
             <div class="row"><span class="label">Public wallet</span> <code class="addr">${esc(short(acct.address, 10))}</code></div>
             <div class="row"><span class="label">Router</span> <code class="addr">${esc(short(ux.cfg.router, 10))}</code></div>`;
        previewEl.style.display = 'block';
        previewEl.innerHTML = `
          <div class="tx-preview" style="margin-top:12px;">
            <h4>Review ${esc(intent.ticker)} note send</h4>
            <div class="row"><span class="label">Send</span> ${fmtUnits(intent.amount, intent.dec)} ${esc(intent.ticker)}</div>
            <div class="row"><span class="label">To</span> <code class="addr">${esc(short(intent.recipient, 12))}</code></div>
            <div class="row"><span class="label">Source</span> ${intent.source === 'shielded'
              ? 'your existing shielded balance'
              : `public ${esc(publicAssetLabel(intent.ticker))} from your Ethereum account`}</div>
            ${pathRows}
            <div class="row" style="color:var(--ink-mid);margin-top:8px;">The recipient receives a shielded note. Amount and recipient note details are hidden inside the pool settlement.</div>
          </div>`;
      }
      btn.disabled = false;
      if (statusEl) statusEl.textContent = '';
    } catch (e) {
      _pendingSend = null;
      btn.disabled = true;
      if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
      if (statusEl) statusEl.textContent = e.message || String(e);
    }
  };

  btn.onclick = async () => {
    if (!_pendingSend) {
      if (statusEl) statusEl.textContent = 'Review the send first.';
      return;
    }
    const { asset, ticker, dec, amount, amountWei, fee, picked, recipient, selfRelay } = _pendingSend;

    btn.disabled = true;
    reviewBtn.disabled = true;
    try {
      if (picked) {
        // Pay from the shielded balance already in the pool — note-to-note transfer.
        if (statusEl) statusEl.textContent = `Sending ${fmtUnits(amount, dec)} ${ticker} from your shielded balance…`;
        const r = await ux.transfer({
          walletPriv: wallet.priv, notes: picked, recipientPubHex: recipient, amount, fee, selfRelay,
          waitOpts: { onUpdate: proveUpdater(statusEl, 'Sending') },
        });
        if (statusEl) statusEl.innerHTML = `Sent ${fmtUnits(amount, dec)} ${esc(ticker)}`
          + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '')
          + ' — the recipient recovers it from their key.';
        notify(`Sent ${fmtUnits(amount, dec)} ${ticker}`, 'ok');
        setTimeout(() => renderSendTab(wallet, helpers), 1500);
        return;
      }
      // No (usable) shielded balance → wrap from the wallet and send in one transaction.
      if (statusEl) statusEl.textContent = `No shielded balance yet — wrapping + sending ${fmtUnits(amount, dec)} ${ticker} from your wallet in one transaction…`;
      const r = await ux.wrapAndSend({
        walletPriv: wallet.priv, amountWei, ticker, recipientPubHex: recipient, amount,
        waitOpts: { onUpdate: proveUpdater(statusEl, 'Wrap-and-send') },
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
      reviewBtn.disabled = false;
    }
  };
}

// "Just hold it privately": wrap public ETH/token into a confidential note the user owns — no recipient,
// no send. Gasless one-tx router wrap when the router is live; direct pool deposit otherwise (native ETH).
function wireHold(wallet, ux, helpers) {
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
      setTimeout(() => renderSendTab(wallet, helpers), 2000);
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
  const badge = el('csend-asset-badge');
  const amount = el('csend-amount');
  if (!sel || !evm || !btc) return;
  const apply = () => {
    const isBtc = sel.value === '__btc__';
    evm.style.display = isBtc ? 'none' : '';
    btc.style.display = isBtc ? '' : 'none';
    const ticker = isBtc ? 'BTC' : (sel.options[sel.selectedIndex]?.dataset?.ticker || 'cETH');
    if (amount) {
      amount.placeholder = amountPlaceholder(ticker);
      amount.step = amountStep(ticker);
    }
    if (badge) {
      badge.innerHTML = isBtc ? '' : `${assetMark(ticker)}<span>${esc(ticker)}</span>`;
      badge.style.display = isBtc ? 'none' : 'inline-flex';
    }
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
  _pendingSend = null;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Confidential Send'); return; }
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to send a shielded note.</div>';
    return;
  }
  const id = ux.identity(wallet.priv);
  const myTacit = helpers.tacitAddress || null;
  await attachRegisteredExternalSendAssets(ux);
  // Show the example prefix for the active network (tacit1… mainnet / tactt1… signet / tacrt1… regtest),
  // derived from the holder's own address so it always matches what they'll receive.
  const addrPrefix = (myTacit && myTacit.split('1')[0]) || 'tacit';
  const sendAssets = ux.assets.filter((a) => a.assetId && /^c[A-Za-z0-9]/.test(a.ticker || ''));
  const preferred = ['cETH', 'cUSDC', 'cUSDT', 'cwstETH', 'cBTC', 'cUSD'];
  const orderedSendAssets = [
    ...preferred.map((t) => sendAssets.find((a) => a.ticker === t)).filter(Boolean),
    ...sendAssets.filter((a) => !preferred.includes(a.ticker)),
  ];
  const assetOptions = orderedSendAssets.map((a) => `<option value="${a.assetId}" data-ticker="${esc(a.ticker)}">${a.ticker}</option>`).join('');
  if (!orderedSendAssets.length) {
    body.innerHTML = '<div class="muted">No Ethereum confidential assets are registered for this network yet.</div>';
    return;
  }
  body.innerHTML = `
    <div class="tab-form">
    <div class="note-concept"><b>EVM pool send.</b> Paste Alice's Tacit address, choose ETH, USDC,
      tacBTC, or tacUSD, then review before signing. The composer spends matching shielded notes first; if needed,
      it wraps public wallet funds through the ConfidentialRouter. For Bitcoin-native assets or sats, use
      <a href="#tab=transfer">Bitcoin send</a>.</div>
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
      <div id="csend-asset-badge" style="display:none;align-items:center;gap:6px;margin-top:8px;font-weight:600;"></div>
      <div class="muted" style="font-size:10px;margin-top:3px;">Pick what you're sending — the lane follows the asset.</div>

      <div id="csend-evm-controls" style="margin-top:12px;">
        <label class="field-label" for="csend-recipient">To</label>
        <input id="csend-recipient" type="text" placeholder="${addrPrefix}1… address or 0x02…/0x03… shielded pubkey">
        <div class="field-row" style="margin-top:8px;">
          <input id="csend-amount" type="number" min="0" step="0.00000001" placeholder="ETH amount">
          <button id="csend-review-btn">Review</button>
          <button id="csend-btn" class="primary" disabled>Send note</button>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px;">Alice receives a shielded note recoverable from her Tacit identity; the public token wrapper stays on your side of the transaction.</div>
        <div id="csend-preview" style="display:none;"></div>
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
      <div class="muted" style="font-size:11px;margin-bottom:6px;">Turn public ETH, USDC, tacBTC, or tacUSD into a shielded note you own — nothing is sent, your balance just becomes private.</div>
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
            ${orderedSendAssets.map((a) => `<option value="${a.ticker}">${a.ticker}</option>`).join('')}
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
  wireHold(wallet, ux, helpers);
  wireAssetLane();

  const copyBtn = el('csend-copyaddr');
  if (copyBtn && myTacit) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(myTacit); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200); }
    catch { copyBtn.textContent = 'Copy failed'; }
  };

  const bridgeLink = el('csend-bridge-link');
  if (bridgeLink && typeof helpers.openBridge === 'function') bridgeLink.onclick = (e) => { e.preventDefault(); helpers.openBridge(); };

  if (el('csend-balance')) el('csend-balance').textContent = 'Scanning the pool…';
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
            return `<div style="padding:2px 0;">${fmtUnits(a.value, dec)} ${esc(a.ticker || a.asset.slice(0, 10) + '…')}</div>`;
          }).join('')
        : 'No shielded notes yet — “Send privately” will wrap from your wallet automatically, or use “Hold it privately” to just make funds private.';
    }
    wireSend(wallet, ux, notes || [], helpers);
  } catch (e) {
    const balEl = el('csend-balance');
    if (balEl) balEl.textContent = 'Could not scan existing notes. Fresh ETH wrap-and-send is still available.';
    wireSend(wallet, ux, [], helpers);
  }
}
