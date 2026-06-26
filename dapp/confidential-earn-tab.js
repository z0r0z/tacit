// Earn tab — confidential LP + TAC farms on the Ethereum pools. The day-1 incentivized pools pair TAC
// against cETH, cBTC, and cUSD; an LP adds liquidity (OP_LP_ADD) into a shielded LP-share note and bonds it
// into a farm (OP_FARM_BOND) to earn TAC emissions. The one-click path (OP_LP_BOND, op 29) fuses add+bond
// into a single settle — the airdrop golden path: claim TAC → wrap → LP → farm.
//
// This surface reads live pool reserves (ux.poolReserves) and the user's shielded notes (ux.balance) to show
// real positions, and drives ux.lpBond for a one-click farm entry when the FarmController is configured. APR
// is derived from emissions ÷ TVL where the farm emission rate is published; until that lands it reports the
// position honestly rather than faking a yield number.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256 }));
}
const el = (id) => document.getElementById(id);

function fmtUnits(v, decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals) || '0';
  const f = s.slice(-decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// The day-1 incentivized pools: TAC paired against each core asset. Asset ids come from the deployment
// manifest (ux.cfg.assetIds). Returns [] when the manifest hasn't pinned the ids yet.
function dayOnePairs(ux) {
  const ids = (ux.cfg && ux.cfg.assetIds) || {};
  const tac = ids.cTac;
  if (!tac) return [];
  return [
    { label: 'cETH / TAC', a: ids.cEth, b: tac, ta: 'cETH', tb: 'TAC' },
    { label: 'cBTC / TAC', a: ids.cBtc, b: tac, ta: 'cBTC', tb: 'TAC' },
    { label: 'cUSD / TAC', a: ids.cUsd, b: tac, ta: 'cUSD', tb: 'TAC' },
  ].filter((p) => p.a && p.b);
}

export async function renderEarnTab(wallet) {
  const body = el('earn-body');
  if (!body) return;
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to provide liquidity and farm TAC rewards.</div>';
    return;
  }
  body.innerHTML = `
    <div class="note-concept" style="margin-bottom:12px;"><b>Earn TAC, shielded.</b> Provide liquidity to a
      confidential pool and farm <span class="eth-word">TAC</span> rewards — your position size stays private.
      Start from TAC you claimed, a note bridged from Bitcoin, or raw ETH; one click adds liquidity and bonds
      the shares into the farm in a single settle.</div>
    <div id="earn-pools" class="muted" style="font-size:12px;">Reading pools…</div>
    <div id="earn-status" class="muted" style="font-size:11px;margin-top:10px;"></div>`;

  const pairs = dayOnePairs(ux);
  const wrap = el('earn-pools');
  if (!pairs.length) {
    if (wrap) wrap.textContent = 'No incentivized pools configured for this network yet.';
    return;
  }
  const controller = ux.cfg && ux.cfg.farmController;

  let notes = [];
  try { notes = (await ux.balance(wallet.priv)).notes || []; } catch {}
  const noteFor = (assetId) => notes.find((n) => n.asset && assetId && n.asset.toLowerCase() === assetId.toLowerCase());

  const rows = await Promise.all(pairs.map(async (p, i) => {
    let reserves = null;
    try { reserves = await ux.poolReserves(ux.routePoolId(p.a, p.b, 30)); } catch {}
    const init = !!(reserves && reserves.totalShares > 0n);
    const aNote = noteFor(p.a), bNote = noteFor(p.b);
    const canBond = !!(controller && init && aNote && bNote);
    const why = !controller ? 'farm not deployed on this network yet'
      : !init ? 'pool not initialized'
      : (!aNote || !bNote) ? `need a ${p.ta} note and a ${p.tb} note (wrap into the pool first)`
      : 'add liquidity & bond into the farm in one transaction';
    const tvl = init ? `${reserves.reserveA} / ${reserves.reserveB}` : '—';
    return `
      <div style="border:1px solid var(--hairline,#eee);border-radius:6px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${p.label}</strong>
          <span class="muted" style="font-size:11px;">${init ? 'reserves ' + tvl : 'not yet initialized'}</span>
        </div>
        <div class="muted" style="font-size:11px;margin:6px 0;">APR — derived once the farm emission rate is published for this pool.</div>
        <button class="earn-bond-btn" data-i="${i}" ${canBond ? '' : 'disabled'} title="${why}"
          style="padding:6px 12px;font-size:13px;cursor:${canBond ? 'pointer' : 'not-allowed'};">Add liquidity &amp; farm</button>
        ${canBond ? '' : `<span class="muted" style="font-size:10px;margin-left:8px;">${why}</span>`}
      </div>`;
  }));
  if (wrap) wrap.outerHTML = `<div id="earn-pools">${rows.join('')}</div>`;

  // Wire the one-click bond buttons.
  document.querySelectorAll('.earn-bond-btn').forEach((btn) => {
    if (btn.disabled) return;
    btn.onclick = async () => {
      const p = pairs[Number(btn.dataset.i)];
      const aNote = noteFor(p.a), bNote = noteFor(p.b);
      const st = el('earn-status');
      if (!aNote || !bNote) { if (st) st.textContent = 'Notes changed — reopen Earn and retry.'; return; }
      btn.disabled = true;
      if (st) st.textContent = `Adding liquidity + bonding ${p.label} into the farm…`;
      try {
        const r = await ux.lpBond({
          walletPriv: wallet.priv, controller, aNote, bNote, feeBps: 30,
          waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Farm entry ${s.status}…`; } },
        });
        if (st) st.innerHTML = `Bonded into ${p.label}`
          + (r && r.txHash ? ` (<code style="font-size:10px;word-break:break-all;">${r.txHash}</code>)` : '')
          + ` — ${r.dShares} LP shares earning TAC.`;
        setTimeout(() => renderEarnTab(wallet), 1500);
      } catch (e) {
        if (st) st.textContent = 'Farm entry failed: ' + (e && e.message || e);
        btn.disabled = false;
      }
    };
  });
}
