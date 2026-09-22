// Earn tab — confidential LP + TAC farms on the Ethereum pools. The day-1 incentivized pools pair TAC
// against cETH, cBTC, and cUSD; an LP adds liquidity (OP_LP_ADD) into a shielded LP-share note and bonds it
// into a farm (OP_FARM_BOND) to earn TAC emissions. The one-click path (OP_LP_BOND, op 29) fuses add+bond
// into a single settle — the airdrop golden path: claim TAC → wrap → LP → farm.
//
// This surface reads live pool reserves (ux.poolReserves) and the user's shielded notes (ux.balance) to show
// real positions, and drives ux.lpBond for a one-click farm entry when the FarmController is configured. APR
// is derived from emissions ÷ TVL where the farm emission rate is published; otherwise it reports the
// position without a yield number.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML } from './confidential-deployments.js';

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

// The launch farm's pools come straight from the deployment config: each carries its poolId and fee tier, and the
// pair's assets are read back from the pool itself, so a re-weighted or added pool needs no code change here.
function farmPairs(ux) {
  const farm = ux.cfg && ux.cfg.farm;
  return farm ? (farm.pools || []).map((p) => ({ label: String(p.pair).replace('/', ' / '), poolId: p.poolId, feeBps: p.feeBps })) : [];
}

export async function renderEarnTab(wallet) {
  const body = el('earn-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Earn (LP + farms)'); return; }
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to provide liquidity and farm TAC rewards.</div>';
    return;
  }
  body.innerHTML = `
    <div class="note-concept" style="margin-bottom:12px;"><b>Earn TAC, shielded.</b> Provide liquidity to a
      confidential pool and farm <span class="eth-word">TAC</span> rewards. Your LP shares sit in a shielded note; the
      liquidity you add shows in the pool's public reserves.
      Start from TAC you claimed, a note bridged from Bitcoin, or raw ETH; one click adds liquidity and bonds
      the shares into the farm in a single settle.</div>
    <div id="earn-pools" class="muted" style="font-size:12px;">Reading pools…</div>
    <div id="earn-status" class="muted" style="font-size:11px;margin-top:10px;"></div>`;

  const launch = farmPairs(ux);
  const pairs = launch.length ? launch : dayOnePairs(ux);
  const wrap = el('earn-pools');
  if (!pairs.length) {
    if (wrap) wrap.innerHTML = `<div class="muted" style="font-size:12px;line-height:1.6;">
      The TAC farms (cETH/TAC · cBTC/TAC · cUSD/TAC) appear here once their pools are seeded.
      Meanwhile you can wrap into the <a href="#tab=confidential-pool">confidential pool</a>, claim your
      <a href="#tab=claim">airdrop</a>, or bring value over from <span class="btc-word">Bitcoin</span>.</div>`;
    return;
  }
  const farms = (ux.cfg && ux.cfg.farmControllers) || {};
  const controllerFor = (a, b, feeBps) => farms[String(ux.routePoolId(a, b, feeBps)).toLowerCase()] || null;

  let prog = null;
  if (launch.length) { try { prog = await ux.farmProgram().program(); } catch {} }
  const emissionLine = (p) => {
    const q = prog && p.poolId && prog.pools.find((x) => x.poolId && x.poolId.toLowerCase() === p.poolId.toLowerCase());
    if (!q) return 'APR — derived once the farm emission rate is published for this pool.';
    return q.idle ? 'No one is farming this pool yet — its whole share of the emission is unclaimed.'
      : `${q.tacPerDayForPool} TAC per day, shared by everyone farming this pool.`;
  };

  let notes = [];
  try { notes = (await ux.balance(wallet.priv)).notes || []; } catch {}
  // The largest note of each asset: the bond spends both notes whole, so the smaller side sets the size.
  const noteFor = (assetId) => notes.filter((n) => n.asset && assetId && n.asset.toLowerCase() === assetId.toLowerCase())
    .sort((x, y) => (BigInt(y.value) > BigInt(x.value) ? 1 : -1))[0];

  const rows = await Promise.all(pairs.map(async (p, i) => {
    // The day-1 pools are no-skim (fee 0); fall back to the 30-bps tier if a fee pool was added. The reserves
    // read returns the live fee tier so the bond targets the same poolId.
    let reserves = null, feeBps = 0;
    if (p.poolId) {
      try {
        reserves = await ux.poolReserves(p.poolId);
        if (reserves) { feeBps = reserves.feeBps ?? p.feeBps; p.a = reserves.assetA; p.b = reserves.assetB; p.ta = ux.tickerOf(p.a) || 'asset A'; p.tb = ux.tickerOf(p.b) || 'asset B'; }
      } catch {}
    } else {
      for (const tier of [0, 30]) {
        try { const r = await ux.poolReserves(ux.routePoolId(p.a, p.b, tier)); if (r) { reserves = r; feeBps = r.feeBps ?? tier; break; } } catch {}
      }
    }
    const controller = reserves ? controllerFor(p.a, p.b, feeBps) : null;
    const init = !!(reserves && reserves.totalShares > 0n);
    const aNote = noteFor(p.a), bNote = noteFor(p.b);
    const canBond = !!(controller && init && aNote && bNote);
    const why = !reserves ? 'pool not deployed on this network yet'
      : !controller ? 'farm not deployed for this pool yet'
      : !init ? 'pool not initialized'
      : (!aNote || !bNote) ? `need a ${p.ta} note and a ${p.tb} note (wrap into the pool first)`
      : 'add liquidity & bond into the farm in one transaction';
    p._feeBps = feeBps; p._controller = controller; p._reserves = reserves;
    const tvl = init ? `${reserves.reserveA} / ${reserves.reserveB}` : '—';
    return `
      <div style="border:1px solid var(--hairline,#eee);border-radius:6px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${p.label}</strong>
          <span class="muted" style="font-size:11px;">${init ? 'reserves ' + tvl : 'not yet initialized'}</span>
        </div>
        <div class="muted" style="font-size:11px;margin:6px 0;">${emissionLine(p)}</div>
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
      if (!aNote || !bNote || !p._controller || !p._reserves) { if (st) st.textContent = 'Notes/farm changed — reopen Earn and retry.'; return; }
      btn.disabled = true;
      try {
        // OP_LP_BOND spends both notes whole and the pool keeps anything off-ratio, so size the larger side down to
        // the pool ratio first (a split transfer) and show both amounts before anything is spent.
        const rA = BigInt(p._reserves.reserveA), rB = BigInt(p._reserves.reserveB);
        const a = BigInt(aNote.value), b = BigInt(bNote.value);
        const aLimited = a * rB <= b * rA;
        const wantA = aLimited ? a : (b * rA + rB - 1n) / rB;
        const wantB = aLimited ? (a * rB + rA - 1n) / rA : b;
        const dec = (t) => Number((ux.assetByTicker[t] || {}).tacitDecimals ?? 8);
        const ok = window.confirm(`Add ${fmtUnits(wantA, dec(p.ta))} ${p.ta} + ${fmtUnits(wantB, dec(p.tb))} ${p.tb} to ${p.label} and bond the shares into the farm?`
          + ((aLimited ? wantB !== b : wantA !== a) ? `\n\nYour ${aLimited ? p.tb : p.ta} note is split first so only the in-ratio amount is added; the rest stays in your wallet.` : ''));
        if (!ok) { btn.disabled = false; return; }
        let sizedA = aNote, sizedB = bNote;
        if (st) st.textContent = 'Sizing your notes to the pool ratio…';
        if (wantA !== a) sizedA = (await ux.ensureExactNote({ walletPriv: wallet.priv, asset: p.a, amount: wantA, notes })).note;
        if (wantB !== b) sizedB = (await ux.ensureExactNote({ walletPriv: wallet.priv, asset: p.b, amount: wantB, notes })).note;
        if (st) st.textContent = `Adding liquidity + bonding ${p.label} into the farm…`;
        const r = await ux.lpBond({
          walletPriv: wallet.priv, controller: p._controller, aNote: sizedA, bNote: sizedB, feeBps: p._feeBps ?? 0,
          // Fee-free bond: the box proves (prove-only) and the user broadcasts settle() from their own EVM
          // account, so there's no relay fee to carve from the bonded liquidity (the relayed path's fee-gate
          // would reject a zero-fee job). The account is already on-chain from the wrap deposits.
          selfRelay: true,
          waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Farm entry ${s.status}…`; } },
        });
        // Remember the position locally so harvest/unbond can find it without a scan. Nothing secret is stored:
        // the receipt key re-derives from the wallet key + (controller, lpAsset, anchorLeaf) via ux.lpBondPosition.
        try {
          const k = 'tacit-lp-bond-positions';
          const list = JSON.parse(localStorage.getItem(k) || '[]');
          list.push({ controller: p._controller, lpAsset: r.lpAsset, anchorLeaf: r.anchorLeaf, receiptLeaf: r.receiptLeaf, receiptOwner: r.receiptOwner, bondNonce: r.bondNonce, shares: String(r.dShares) });
          localStorage.setItem(k, JSON.stringify(list));
        } catch { /* storage unavailable: the position is still recoverable from chain + key */ }
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
