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
