// Confidential Pool tab — the dapp render over the LIVE Sepolia pilot pool. Presentational only; the
// read path (account + seed-only balance) lives in confidential-pool-ux.js (tested). The wrap/transfer
// write paths layer on later. Kept OUT of tacit.js (a thin hook calls this) to minimize the giant-file
// footprint while that file is concurrently edited.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'sepolia' }));
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
      const r = await ux.wrap({ walletPriv: wallet.priv, amountWei: wei });
      if (st) st.innerHTML = `Deposit broadcast: <code style="font-size:10px;word-break:break-all;">${r.txHash}</code> — awaiting OP_WRAP settle; your cETH note appears once it settles.`;
    } catch (e) {
      if (st) st.textContent = 'Wrap failed: ' + (e && e.message || e);
    } finally {
      btn.disabled = false;
    }
  };
}

// Render the user's confidential account (derived Sepolia EVM address) + seed-only cETH balance into the
// panel. Safe to call with a locked wallet (shows the unlock prompt). `wallet` is the tacit.js wallet object.
export async function renderConfidentialPoolTab(wallet) {
  const addrEl = el('cpool-address');
  const statusEl = el('cpool-status');
  const balEl = el('cpool-balance');
  if (!addrEl) return;

  const ux = getUx();
  if (!wallet || !wallet.priv) {
    addrEl.textContent = '—';
    if (statusEl) statusEl.textContent = 'Unlock your wallet to view your confidential account.';
    if (balEl) balEl.innerHTML = '';
    return;
  }

  const acct = ux.account(wallet.priv);
  addrEl.textContent = acct.address;
  wireWrap(wallet, ux);
  if (statusEl) statusEl.textContent = 'Scanning the pool for your notes…';
  if (balEl) balEl.innerHTML = '';

  try {
    // Seed-only recovery from the pool's log stream — no off-chain note storage. (The scan key aligns
    // with note ownership once the wrap path lands; an empty pool recovers nothing regardless.)
    const { byAsset, notes } = await ux.balance(wallet.priv);
    const assets = Object.values(byAsset);
    if (statusEl) {
      statusEl.textContent = notes.length
        ? `${notes.length} note${notes.length === 1 ? '' : 's'} recovered`
        : 'No confidential notes yet — wrap ETH to mint your first cETH note.';
    }
    if (balEl) {
      balEl.innerHTML = assets.map((a) => {
        const meta = ux.cfg.assets.find((x) => x.assetId.toLowerCase() === a.asset);
        const dec = meta ? meta.decimals : 18;
        return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--hairline,#eee);font-size:13px;">`
          + `<span>${a.ticker || (a.asset.slice(0, 10) + '…')}</span><strong>${fmtUnits(a.value, dec)}</strong></div>`;
      }).join('');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Could not scan the pool: ' + (e && e.message || e);
  }
}
