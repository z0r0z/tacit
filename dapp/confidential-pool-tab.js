// Confidential Pool tab — the dapp render over the LIVE Sepolia pilot pool. Presentational only; the
// read path (account + seed-only balance) lives in confidential-pool-ux.js (tested). The wrap/transfer
// write paths layer on later. Kept OUT of tacit.js (a thin hook calls this) to minimize the giant-file
// footprint while that file is concurrently edited.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatErr, notify, proveUpdater } from './confidential-deployments.js';
import { classifyFinality, finalityBadgeHtml, listProvisional } from './confidential-finality.js';
import { renderLanePanel } from './cross-chain-lane.js';

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

// Exact ETH-string → wei (no float).
function ethToWei(s) {
  s = String(s == null ? '' : s).trim();
  if (!s || !/^\d*\.?\d*$/.test(s)) return '0';
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  return (BigInt(i || '0') * (10n ** 18n) + BigInt(frac || '0')).toString();
}

// Wrap on-ramp: build + sign + broadcast the deposit from the user's (funded) Sepolia EVM account.
function wireWrap(wallet, ux) {
  const btn = el('cpool-wrap-btn');
  if (!btn) return;
  btn.onclick = async () => {
    const st = el('cpool-wrap-status');
    if (!wallet || !wallet.priv) { if (st) st.textContent = 'Unlock your wallet first.'; return; }
    const wei = ethToWei(el('cpool-wrap-amount') ? el('cpool-wrap-amount').value : '');
    if (!wei || wei === '0') { if (st) st.textContent = 'Enter an amount.'; return; }
    btn.disabled = true;
    if (st) st.textContent = 'Building + broadcasting the deposit…';
    try {
      // One-tx ConfidentialRouter wrap when the router is deployed (collapses approve+wrap); otherwise the
      // direct pool deposit. Same note commitment + recovery either way.
      const r = ux.cfg.router
        ? await ux.routerWrap({ walletPriv: wallet.priv, amountWei: wei })
        : await ux.wrap({ walletPriv: wallet.priv, amountWei: wei });
      if (st) st.innerHTML = `Deposit broadcast${ux.cfg.router ? ' (one-tx router)' : ''}: <code class="addr">${esc(r.txHash)}</code> — awaiting OP_WRAP settle; your cETH note appears once it settles.`;
      notify('Deposit broadcast — awaiting settle', 'ok');
    } catch (e) {
      const m = formatErr(e, 'Wrap');
      if (st) st.textContent = m; notify(m, 'error');
    } finally {
      btn.disabled = false;
    }
  };
}

// Gasless exit: render each recovered note as a whole-note exit row with a live fee preview, then submit
// the chosen note to the relay (the box settles on-chain + is paid the fee out of the withdrawal, so the
// user needs no ETH). The recipient + no-fee toggle are read at click time; no-fee builds a fee-0 exit.
function wireExit(wallet, ux, notes) {
  const listEl = el('cpool-exit-list');
  const statusEl = el('cpool-exit-status');
  if (!listEl) return;
  if (!notes || !notes.length) { listEl.textContent = 'No notes to exit yet.'; return; }

  const decOf = (assetId) => {
    const m = ux.assets.find((x) => x.assetId.toLowerCase() === String(assetId).toLowerCase());
    return m ? (m.tacitDecimals ?? m.decimals) : 8; // note values are in-system units
  };
  const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));

  listEl.innerHTML = notes.map((n) => {
    const ticker = ux.tickerOf(n.asset) || 'cETH';
    const dec = decOf(n.asset);
    let preview = '';
    try {
      const q = ux.quoteUnwrapFee(n.value, ticker);
      preview = q.net > 0n
        ? `→ receive ${fmtUnits(q.net, dec)} (fee ${fmtUnits(q.fee, dec)})`
        : '→ too small for a fee exit — tick “No fee”';
    } catch { /* leave preview blank */ }
    return `<div class="list-row">`
      + `<span>${fmtUnits(n.value, dec)} ${ticker} <span class="muted">${preview}</span></span>`
      + `<button data-leaf="${n.leafIndex}" class="cpool-exit-one" style="padding:4px 10px;font-size:10px;flex:0 0 auto;">Exit</button></div>`;
  }).join('');

  for (const btn of listEl.querySelectorAll('.cpool-exit-one')) {
    btn.onclick = async () => {
      const note = byLeaf.get(btn.getAttribute('data-leaf'));
      if (!note) return;
      const recInput = el('cpool-exit-recipient');
      const recipient = (recInput && recInput.value || '').trim() || undefined;
      const selfSettle = !!(el('cpool-exit-selfsettle') && el('cpool-exit-selfsettle').checked);
      const setBtns = (d) => listEl.querySelectorAll('.cpool-exit-one').forEach((b) => { b.disabled = d; });
      setBtns(true);
      if (statusEl) statusEl.textContent = 'Submitting your exit to the relayer…';
      try {
        const r = await ux.unwrap({
          note, walletPriv: wallet.priv, recipient, selfSettle,
          waitOpts: { onUpdate: proveUpdater(statusEl, 'Exiting') },
        });
        const dec = decOf(note.asset);
        const ticker = ux.tickerOf(note.asset) || 'cETH';
        if (statusEl) {
          statusEl.innerHTML = `Exit settled — ${fmtUnits(r.net, dec)} ${esc(ticker)} sent to <code class="addr">${esc(r.recipient)}</code>`
            + (r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '') + '.';
        }
        notify(`Exit settled — ${fmtUnits(r.net, dec)} ${ticker}`, 'ok');
        setTimeout(() => renderConfidentialPoolTab(wallet), 1500); // refresh balance + exitable notes
      } catch (e) {
        const msg = (e && e.message) || String(e);
        const full = 'Exit failed: ' + msg + (/too small/.test(msg) ? ' — tick “No fee” to exit this note.' : '');
        if (statusEl) statusEl.textContent = full; notify(full, 'error');
        setBtns(false);
      }
    };
  }
}

let _finalityTimer = null;

// Cross-chain finality indicator. Always shows the pool's finality model; for any provisional
// Bitcoin-arbitrated action a cross-chain flow registered (confidential-finality.trackProvisional), shows
// a live anchoring countdown that flips to "Bitcoin-final" once anchored. Ethereum-only actions (wrap /
// exit) are final in seconds and are deliberately NOT flagged here.
function renderFinality() {
  const box = el('cpool-finality');
  if (!box) return;
  const now = Date.now();
  const pending = listProvisional().map((a) => ({
    a, s: classifyFinality({ settledAtMs: a.settledAtMs, nowMs: now, anchored: a.anchored, anchorWindowMs: a.anchorWindowMs }),
  }));
  const model = 'Finality: Ethereum pool actions (wrap, transfer, exit) are final in seconds. '
    + 'Cross-chain (Bitcoin-homed) value is fast-final on Ethereum, then settles to Bitcoin over ~1 hr — '
    + 'reversible by a deep Bitcoin reorg until anchored.';
  const safeLabel = (l) => String(l == null ? 'Cross-chain action' : l).replace(/[<>&]/g, '');
  const rows = pending.map(({ a, s }) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;">`
    + `<span>${safeLabel(a.label)}</span>${finalityBadgeHtml(s)}</div>`
    + `<div class="muted" style="font-size:10px;margin-top:2px;">${s.detail}</div>`).join('');
  box.innerHTML = `<div class="muted" style="border:1px solid var(--hairline);padding:8px;">`
    + `<div>${model}</div>${rows}</div>`;

  // Keep the countdown live only while something is still provisional.
  if (_finalityTimer) { clearInterval(_finalityTimer); _finalityTimer = null; }
  if (pending.some(({ s }) => s.tone === 'pending')) _finalityTimer = setInterval(renderFinality, 30000);
}

// Build the pool body as the shared cross-chain lane panel: account/balance summary as the intro, then
// the Ethereum lane (wrap-in / exit-out) and a Bitcoin lane (value arrives as the same note), with a
// legacy-bridge escape hatch in the footer. Every cpool-* id is preserved so the wire* handlers bind.
function renderPoolPanel() {
  const intro =
    `<div class="note-concept"><b>One note, two chains.</b> Wrap <span class="eth-word">ETH</span> (or any token) into a shielded note here, or bring value over from <span class="btc-word">Bitcoin</span> — it becomes the same shielded note you can transfer, trade, or borrow against from either side.</div>`
    + `<div class="muted" style="font-size:11px;"><span style="color:var(--green)">●</span> Independently reviewed (GPT-5.5 Pro · Opus 4.8 Max) — no active fund-impacting findings · <a href="#tab=about">details →</a></div>`
    + `<div>Your confidential account: <code id="cpool-address" class="addr" style="font-size:11px;">—</code></div>`
    + `<div id="cpool-status" class="muted">—</div>`
    + `<div id="cpool-balance"></div>`
    + `<div id="cpool-finality" style="font-size:11px;"></div>`;

  const wrapBody =
    `<div class="field-row">`
    + `<input id="cpool-wrap-amount" type="number" step="0.0001" min="0" placeholder="0.001">`
    + `<span class="muted" style="font-size:12px;align-self:center;">ETH</span>`
    + `<button id="cpool-wrap-btn" class="primary">Wrap</button>`
    + `</div>`
    + `<div id="cpool-wrap-status" class="muted field-status" style="margin-top:6px;"></div>`
    + `<div class="muted" style="font-size:11px;margin-top:6px;">Fund your confidential account (above) with Sepolia ETH first. The deposit escrows ETH; your cETH note appears after the settle.</div>`;

  const exitBody =
    `<input id="cpool-exit-recipient" type="text" placeholder="Recipient address (default: your account)">`
    + `<label class="check-row" style="margin:8px 0;"><input id="cpool-exit-selfsettle" type="checkbox"> <span>No fee (relayer settles at no charge — for your own exits)</span></label>`
    + `<div id="cpool-exit-list" class="muted" style="font-size:12px;">Unlock + wrap to see your exitable notes.</div>`
    + `<div id="cpool-exit-status" class="muted field-status" style="margin-top:6px;"></div>`
    + `<div class="muted" style="font-size:11px;margin-top:6px;">Each exit spends one whole note. The relayer settles on-chain so you need no ETH for gas; by default a small fee is taken from your withdrawal. The full value exits to the recipient with no fee when the box settles at no charge.</div>`;

  const btcBody =
    `<div class="muted" style="font-size:11px;">Value bridged from Bitcoin lands as the same shielded note — transfer, trade, or borrow against it on either side. Bitcoin-homed value is fast-final on Ethereum, then settles to Bitcoin over ~1 hr.</div>`;

  return renderLanePanel({
    intro,
    lanes: [
      { key: 'eth', label: 'Ethereum lane', actions: [
        { title: 'Wrap ETH → cETH', dir: 'in', body: wrapBody },
        { title: 'Exit cETH → ETH', dir: 'out', meta: 'gasless — relayer settles for a small fee', body: exitBody },
      ] },
      { key: 'btc', label: 'Bitcoin lane', actions: [
        { title: 'Bring value from Bitcoin', dir: 'over', body: btcBody },
      ] },
    ],
    footer: `Holding legacy alpha tETH notes? <a href="#" id="cpool-legacy-bridge">Redeem or migrate them →</a>`,
  });
}

// Render the user's confidential account (derived Sepolia EVM address) + seed-only cETH balance into the
// panel. Safe to call with a locked wallet (shows the unlock prompt). `wallet` is the tacit.js wallet object.
export async function renderConfidentialPoolTab(wallet) {
  const body = el('cpool-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('The shielded pool'); return; }

  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock your wallet to view your confidential account and move value across chains.</div>';
    renderFinality();
    return;
  }

  const acct = ux.account(wallet.priv);
  body.innerHTML = renderPoolPanel();
  const addrEl = el('cpool-address');
  const statusEl = el('cpool-status');
  const balEl = el('cpool-balance');
  if (addrEl) addrEl.textContent = acct.address;
  const legacy = el('cpool-legacy-bridge');
  if (legacy) legacy.onclick = (e) => { e.preventDefault(); if (window._openBridgeModal) window._openBridgeModal(); };
  wireWrap(wallet, ux);
  if (statusEl) statusEl.textContent = 'Scanning the pool for your notes…';
  if (balEl) balEl.innerHTML = '';

  if (statusEl) statusEl.textContent = 'Scanning the pool…';
  try {
    // Seed-only recovery from the pool's log stream — no off-chain note storage. (The scan key aligns
    // with note ownership once the wrap path lands; an empty pool recovers nothing regardless.)
    const { byAsset, notes } = await ux.balance(wallet.priv);
    const assets = Object.values(byAsset);
    if (statusEl) {
      statusEl.textContent = notes.length
        ? `${notes.length} shielded note${notes.length === 1 ? '' : 's'} recovered`
        : 'No shielded notes yet — wrap ETH to mint your first cETH note.';
    }
    if (balEl) {
      balEl.innerHTML = assets.map((a) => {
        const meta = ux.assets.find((x) => x.assetId.toLowerCase() === a.asset);
        const dec = meta ? (meta.tacitDecimals ?? meta.decimals) : 8; // note values are in-system units
        return `<div class="list-row">`
          + `<span>${esc(a.ticker || (a.asset.slice(0, 10) + '…'))}</span><strong>${fmtUnits(a.value, dec)}</strong></div>`;
      }).join('');
    }
    wireExit(wallet, ux, notes);
    renderFinality();
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Could not scan the pool: ' + formatErr(e);
  }
}
