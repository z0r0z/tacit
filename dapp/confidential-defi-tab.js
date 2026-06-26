// Confidential DeFi tab — borrow against a shielded note. Renders over the LIVE pool's seed-only note scan
// (confidential-pool-ux.js) and drives the REAL CDP/cBTC builders (confidential-cdp.js) through the gasless
// relay (confidential-defi-actions.js). Kept OUT of tacit.js (a thin hook calls renderCdpTab) to keep the
// giant file thin, mirroring confidential-pool-tab.js.
//
// VERIFICATION STATUS: OPEN (mint cUSD), cBTC-mint, and CLOSE assemble the exact guest witnesses and submit
// to the relay; they go live the moment a CollateralEngine is configured (cfg.collateralEngine) and the
// coordinated re-prove/redeploy lands. CLOSE rebuilds the CDP position tree from the CdpPositionInserted
// event to prove membership. (Top-up is the same machinery; not surfaced yet.)

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { makeConfidentialCdp } from './confidential-cdp.js';
import { makeConfidentialFarm } from './confidential-farm.js';
import { makeConfidentialDefiActions } from './confidential-defi-actions.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}

const el = (id) => document.getElementById(id);
const ZERO32 = '0x' + '00'.repeat(32);

function rand32Hex() {
  const b = new Uint8Array(32);
  (globalThis.crypto || {}).getRandomValues
    ? globalThis.crypto.getRandomValues(b)
    : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); }); // never hit in a real browser
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function fmtUnits(v, decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals) || '0';
  const f = s.slice(-decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// Persist the opening of each position so it can be closed later (the CDP position tree is not yet scanned
// client-side; this descriptor carries everything buildCdpCloseOp needs except the live membership path).
const POS_KEY = 'tacit-cdp-positions-v1';
function loadPositions() { try { return JSON.parse(localStorage.getItem(POS_KEY) || '[]'); } catch { return []; } }
function savePosition(p) {
  const all = loadPositions();
  all.push(p);
  try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch {}
}

function decOf(ux, assetId) {
  const m = ux.assets.find((x) => x.assetId.toLowerCase() === String(assetId).toLowerCase());
  return m ? (m.tacitDecimals ?? m.decimals) : 8; // note values are in-system units
}

// Open a CDP: lock the selected collateral notes → mint a cUSD debt note (gasless via the relay).
function wireOpen(wallet, ux, notes) {
  const btn = el('cdp-open-btn');
  if (!btn) return;
  const cfg = ux.cfg;
  const controller = cfg.collateralEngine;
  const statusEl = el('cdp-open-status');
  if (!controller) {
    btn.disabled = true;
    if (statusEl) statusEl.innerHTML = 'CDP minting goes live once a CollateralEngine is deployed for this pool. '
      + 'Your collateral notes are listed below and ready.';
  }
  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    if (!controller) return;
    const checked = [...document.querySelectorAll('.cdp-collat-pick:checked')].map((c) => c.getAttribute('data-leaf'));
    const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));
    const collateral = checked.map((lf) => {
      const n = byLeaf.get(lf);
      return { asset: n.asset, cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path };
    });
    if (!collateral.length) { if (statusEl) statusEl.textContent = 'Select at least one collateral note.'; return; }
    const debtStr = (el('cdp-debt-amount') && el('cdp-debt-amount').value || '').trim();
    const debtValue = BigInt(Math.max(0, Math.floor(Number(debtStr) || 0)));
    if (debtValue <= 0n) { if (statusEl) statusEl.textContent = 'Enter a cUSD amount to borrow.'; return; }
    const root = byLeaf.get(checked[0]).root;
    // Fresh per-position owner (the unlinkable leaf owner the guest publishes for keeper liquidation); nonce
    // is fixed to 0 (the guest enforces it). The borrower recovers the debt/released notes via the memo.
    const positionOwner = rand32Hex();
    const debtBlinding = rand32Hex();
    const rateSnapshot = ZERO32; // fee-free v1 controller
    const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool });
    const defi = makeConfidentialDefiActions({
      pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
      id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
    });
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Building + settling your position via the relayer…';
    try {
      const r = await defi.openCdp({
        controller, debtValue, rateSnapshot, fee: 0n, collateral,
        spendRoot: root, debtBlinding, positionOwner,
        waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `Open ${st.status}…`; } },
      });
      savePosition({
        controller, debtValue: debtValue.toString(), nonce: ZERO32, positionOwner, rateSnapshot, debtBlinding,
        basket: collateral.map((c) => ({ asset: c.asset, value: String(BigInt(c.value)) })),
        openedAt: r && r.txHash || null,
      });
      if (statusEl) statusEl.innerHTML = `Position opened — borrowed ${debtValue} cUSD`
        + (r && r.txHash ? ` (<code style="font-size:10px;word-break:break-all;">${r.txHash}</code>)` : '') + '.';
      setTimeout(() => renderCdpTab(wallet), 1500);
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Open failed: ' + (e && e.message || e);
      btn.disabled = false;
    }
  };
}

// Mint a cBTC.zk bearer note against a reflection-recorded self-custody Bitcoin lock.
function wireCbtc(wallet, ux) {
  const btn = el('cdp-cbtc-btn');
  if (!btn) return;
  const statusEl = el('cdp-cbtc-status');
  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    const outpoint = (el('cdp-cbtc-outpoint') && el('cdp-cbtc-outpoint').value || '').trim();
    const vBtcStr = (el('cdp-cbtc-vbtc') && el('cdp-cbtc-vbtc').value || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(outpoint)) { if (statusEl) statusEl.textContent = 'Enter the 32-byte lock outpoint (0x…).'; return; }
    const vBtc = BigInt(Math.max(0, Math.floor(Number(vBtcStr) || 0)));
    if (vBtc <= 0n) { if (statusEl) statusEl.textContent = 'Enter the locked sats amount.'; return; }
    const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool });
    const defi = makeConfidentialDefiActions({
      pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
      id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
    });
    const blinding = rand32Hex();
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Minting your cBTC note via the relayer…';
    try {
      const r = await defi.mintCbtc({
        outpoint, vBtc, blinding,
        waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `cBTC mint ${st.status}…`; } },
      });
      if (statusEl) statusEl.innerHTML = `cBTC note minted — ${vBtc} sats`
        + (r && r.txHash ? ` (<code style="font-size:10px;word-break:break-all;">${r.txHash}</code>)` : '') + '.';
      btn.disabled = false;
    } catch (e) {
      if (statusEl) statusEl.textContent = 'cBTC mint failed: ' + (e && e.message || e);
      btn.disabled = false;
    }
  };
}

export async function renderCdpTab(wallet) {
  const body = el('cdp-body');
  if (!body) return;
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to open a collateralized position.</div>';
    return;
  }
  const acct = ux.account(wallet.priv);
  body.innerHTML = `
    <div class="note-concept" style="margin-bottom:12px;"><b>Borrow against a shielded note.</b> Lock a confidential
      note as collateral and mint <span class="eth-word">cUSD</span> — or mint <span class="btc-word">cBTC</span> against a
      self-custody Bitcoin lock. The debt note is itself confidential and spends like any other note.</div>
    <div style="margin-bottom:8px;">Account: <code style="font-size:11px;word-break:break-all;">${acct.address}</code></div>
    <div id="cdp-status" class="muted" style="margin-bottom:12px;">Scanning the pool for collateral…</div>

    <div style="border-top:1px solid var(--hairline,#eee);padding-top:12px;margin-top:8px;">
      <div style="font-weight:600;margin-bottom:6px;">Open a position — mint cUSD</div>
      <div id="cdp-collat-list" class="muted" style="font-size:12px;margin-bottom:8px;">—</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <input id="cdp-debt-amount" type="number" min="0" step="1" placeholder="cUSD to borrow" style="flex:1;padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;">
        <button id="cdp-open-btn" style="padding:6px 14px;font-size:13px;cursor:pointer;">Open</button>
      </div>
      <div id="cdp-open-status" class="muted" style="font-size:11px;"></div>
    </div>

    <div style="border-top:1px solid var(--hairline,#eee);padding-top:12px;margin-top:14px;">
      <div style="font-weight:600;margin-bottom:6px;">Mint cBTC <span class="muted" style="font-weight:400;font-size:11px;">· against a self-custody Bitcoin lock</span></div>
      <input id="cdp-cbtc-outpoint" type="text" placeholder="Lock outpoint (0x… 32 bytes)" style="width:100%;box-sizing:border-box;padding:6px;font-size:12px;border:1px solid var(--ink,#ccc);border-radius:4px;margin-bottom:6px;">
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="cdp-cbtc-vbtc" type="number" min="0" step="1" placeholder="Locked sats" style="flex:1;padding:6px;font-size:13px;border:1px solid var(--ink,#ccc);border-radius:4px;">
        <button id="cdp-cbtc-btn" style="padding:6px 14px;font-size:13px;cursor:pointer;">Mint cBTC</button>
      </div>
      <div id="cdp-cbtc-status" class="muted" style="font-size:11px;margin-top:6px;"></div>
    </div>

    <div id="cdp-positions" style="border-top:1px solid var(--hairline,#eee);padding-top:12px;margin-top:14px;"></div>`;

  wireCbtc(wallet, ux);

  try {
    const { notes } = await ux.balance(wallet.priv);
    const statusEl = el('cdp-status');
    const collat = el('cdp-collat-list');
    if (!notes || !notes.length) {
      if (statusEl) statusEl.textContent = 'No notes to use as collateral — wrap into the pool first.';
      if (collat) collat.textContent = 'No collateral notes yet.';
    } else {
      if (statusEl) statusEl.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'} available as collateral`;
      if (collat) {
        collat.innerHTML = notes.map((n) => {
          const ticker = ux.tickerOf(n.asset) || 'note';
          const dec = decOf(ux, n.asset);
          return `<label style="display:flex;gap:8px;align-items:center;padding:4px 0;cursor:pointer;">
            <input type="checkbox" class="cdp-collat-pick" data-leaf="${n.leafIndex}">
            <span>${fmtUnits(n.value, dec)} ${ticker} <span class="muted">#${n.leafIndex}</span></span></label>`;
        }).join('');
      }
    }
    wireOpen(wallet, ux, notes || []);
  } catch (e) {
    const statusEl = el('cdp-status');
    if (statusEl) statusEl.textContent = 'Could not scan the pool: ' + (e && e.message || e);
  }

  // Locally-tracked positions, each closable: the CDP position tree is rebuilt from CdpPositionInserted to
  // prove membership, the debt is repaid from the user's cUSD notes, and the basket is released.
  const posBox = el('cdp-positions');
  const positions = loadPositions().filter((p) => p.controller && ux.cfg.collateralEngine
    && p.controller.toLowerCase() === ux.cfg.collateralEngine.toLowerCase());
  if (posBox && positions.length) {
    posBox.innerHTML = `<div style="font-weight:600;margin-bottom:6px;">Your positions</div>`
      + positions.map((p, i) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--hairline,#eee);font-size:12px;">
          <span>${p.debtValue} cUSD borrowed · ${p.basket.length} collateral leg${p.basket.length === 1 ? '' : 's'}</span>
          <button class="cdp-close-one" data-pos="${i}" style="padding:3px 10px;font-size:11px;cursor:pointer;">Close</button></div>`).join('')
      + `<div id="cdp-close-status" class="muted" style="font-size:11px;margin-top:6px;"></div>`;
    wireClose(wallet, ux, positions);
  } else if (posBox) {
    posBox.innerHTML = '';
  }
}

// Close a CDP: rebuild the position tree (CdpPositionInserted), prove the position's membership, repay the
// debt from the user's cUSD notes, and release the collateral basket. Drives the REAL buildCdpCloseOp via
// confidential-defi-actions.closeCdp.
function wireClose(wallet, ux, positions) {
  const statusEl = el('cdp-close-status');
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool });
  const defi = makeConfidentialDefiActions({
    pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
    id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
  });
  const id = ux.identity(wallet.priv);
  for (const btn of document.querySelectorAll('.cdp-close-one')) {
    btn.onclick = async () => {
      const p = positions[Number(btn.getAttribute('data-pos'))];
      if (!p) return;
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Rebuilding the position tree + gathering repayment notes…';
      try {
        const controller = p.controller;
        const debtAsset = cdp.debtAssetId(controller);
        const debtValue = BigInt(p.debtValue);
        // The position leaf the proof must prove membership for (same derivation buildCdpCloseOp uses).
        const sortedBasket = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
        const basketRootHex = cdp.basketRoot(sortedBasket.map((l) => cdp.basketLeg(l.asset, l.value)));
        const pOwner = p.positionOwner || id.owner; // fresh per-position owner (legacy fallback)
        const pNonce = p.nonce || ZERO32;
        const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRootHex, debtValue, p.rateSnapshot, pOwner, pNonce);
        const posTree = await ux.cdpPositionTree();
        const positionIndex = posTree.indexOf(positionLeaf);
        if (positionIndex < 0) { if (statusEl) statusEl.textContent = 'Position not found on-chain yet (still settling?).'; btn.disabled = false; return; }
        const positionPath = posTree.pathFor(positionIndex).path;
        // Repay: pick cUSD notes summing to the gross debt.
        const { notes } = await ux.balance(wallet.priv);
        const debtNotes = [];
        let sum = 0n;
        for (const n of (notes || []).filter((x) => x.asset.toLowerCase() === debtAsset.toLowerCase())) {
          debtNotes.push({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner });
          sum += BigInt(n.value);
          if (sum >= debtValue) break;
        }
        if (sum < debtValue) { if (statusEl) statusEl.textContent = `Need ${debtValue} cUSD to repay; you hold ${sum}.`; btn.disabled = false; return; }
        const root = (notes.find((x) => x.asset.toLowerCase() === debtAsset.toLowerCase()) || {}).root;
        const releaseBlindings = sortedBasket.map(() => rand32Hex());
        if (statusEl) statusEl.textContent = 'Building + settling the close via the relayer…';
        await defi.closeCdp({
          controller, debtValue, rateSnapshot: p.rateSnapshot, positionOwner: pOwner,
          basket: sortedBasket, positionIndex, positionPath, spendRoot: root, cdpPositionRoot: posTree.root,
          fee: 0n, releaseBlindings, debtNotes,
          waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `Close ${st.status}…`; } },
        });
        // Drop the local descriptor on success.
        const all = loadPositions().filter((x) => !(x.nonce === p.nonce && x.controller === p.controller));
        try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch {}
        if (statusEl) statusEl.textContent = 'Position closed — collateral released to your notes.';
        setTimeout(() => renderCdpTab(wallet), 1500);
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Close failed: ' + (e && e.message || e);
        btn.disabled = false;
      }
    };
  }
}
