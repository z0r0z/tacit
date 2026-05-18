// Farms tab UI render logic. Read-only for v1 — list farms + your bonds
// with live pending rewards. The action buttons (Bond / Harvest / Unbond /
// Refund) call the builders in dapp/amm-farm-actions.js; the UI wiring
// for those buttons lands in a follow-up dapp build.
//
// Init: tacit.js calls initFarmsTab() at startup. Activation of the tab
// (when the user clicks Farms) calls refreshFarmsTab() to re-poll.

import {
  fetchAllFarms, fetchBondsForBonder,
} from './amm-farm-actions.js';
import { wallet } from './tacit.js';
import { bytesToHex } from './vendor/tacit-deps.min.js';

const FARM_ACC_FIXED_POINT_SHIFT = 96n;

function fmtBigInt(s) {
  if (s === null || s === undefined) return '—';
  try {
    const n = BigInt(s);
    if (n === 0n) return '0';
    // Group thousands for readability.
    const str = n.toString();
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } catch { return String(s); }
}

function fmtHexShort(h, len = 12) {
  if (!h) return '—';
  return h.length > len + 4 ? h.slice(0, len) + '…' + h.slice(-4) : h;
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') e.style.cssText = v;
    else if (k === 'className') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v === false || v === null || v === undefined) {} // skip
    else e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function renderFarmCard(farm) {
  const treasury = BigInt(farm.treasury_remaining || '0');
  const totalBonded = BigInt(farm.total_bonded || '0');
  const rewardPerBlock = BigInt(farm.reward_per_block || '0');
  const rewardTotal = BigInt(farm.reward_total || '0');
  const paid = rewardTotal - treasury;
  const refundUnlock = (farm.end_height || 0) + 1008;

  let phaseLabel = 'unknown';
  if (farm.refunded) phaseLabel = 'refunded';
  else if (farm.start_height && farm.end_height && farm.current_height) {
    if (farm.current_height < farm.start_height) phaseLabel = 'pre-start';
    else if (farm.current_height <= farm.end_height) phaseLabel = 'active';
    else if (farm.current_height < refundUnlock) phaseLabel = 'post-end (grace)';
    else phaseLabel = 'refundable';
  }

  return el('div', {
    style: 'border:1px solid #ddd;border-radius:6px;padding:12px;background:#fafafa;',
  }, [
    el('div', { style: 'display:flex;justify-content:space-between;font-family:monospace;font-size:11px;margin-bottom:6px;' }, [
      el('span', {}, [`farm_id: ${fmtHexShort(farm.farm_id, 16)}`]),
      el('span', { style: 'color:#666;' }, [phaseLabel]),
    ]),
    el('div', { style: 'font-size:11px;line-height:1.6;' }, [
      el('div', {}, [`pool: ${fmtHexShort(farm.pool_id, 12)}`]),
      el('div', {}, [`reward asset: ${fmtHexShort(farm.reward_asset_id, 12)}`]),
      el('div', {}, [`reward per block: ${fmtBigInt(rewardPerBlock)}`]),
      el('div', {}, [`treasury remaining: ${fmtBigInt(treasury)} / ${fmtBigInt(rewardTotal)} (paid: ${fmtBigInt(paid)})`]),
      el('div', {}, [`total bonded: ${fmtBigInt(totalBonded)}`]),
      el('div', {}, [`start → end: ${farm.start_height || '—'} → ${farm.end_height || '—'}`]),
      el('div', { style: 'color:#888;font-size:10px;margin-top:4px;' }, [`refund unlock at block ${refundUnlock}`]),
    ]),
  ]);
}

function renderBondCard(bond, farm) {
  const bondAmount = BigInt(bond.bond_amount || '0');
  const pending = BigInt(bond.pending_reward || '0');
  const claimable = BigInt(bond.claimable_now || '0');
  const entryAcc = BigInt(bond.entry_acc_per_share || '0');
  return el('div', {
    style: 'border:1px solid #ddd;border-radius:6px;padding:10px;background:#f5fff5;font-size:11px;line-height:1.6;',
  }, [
    el('div', { style: 'font-family:monospace;font-size:11px;color:#666;margin-bottom:4px;' }, [
      `bond_id: ${fmtHexShort(bond.bond_id, 16)}`,
    ]),
    el('div', {}, [`farm: ${fmtHexShort(bond.farm_id, 12)}`]),
    el('div', {}, [`staked: ${fmtBigInt(bondAmount)} LP shares (bonded at block ${bond.bond_height})`]),
    el('div', { style: 'font-weight:600;color:#0a6;' }, [
      `claimable now: ${fmtBigInt(claimable)} reward-asset units`,
      pending > claimable
        ? ` (pending ${fmtBigInt(pending)}; capped at treasury)`
        : '',
    ]),
    bond.last_harvest_height
      ? el('div', { style: 'color:#888;font-size:10px;' }, [
          `last harvested at block ${bond.last_harvest_height}`,
        ])
      : null,
  ]);
}

let _renderInflight = false;

export async function refreshFarmsTab() {
  if (_renderInflight) return;
  _renderInflight = true;
  const status = document.getElementById('farms-status');
  const list = document.getElementById('farms-list');
  const empty = document.getElementById('farms-empty');
  const bondsList = document.getElementById('farms-bonds-list');
  const bondsEmpty = document.getElementById('farms-bonds-empty');
  if (!list || !empty || !bondsList || !bondsEmpty) {
    _renderInflight = false;
    return;
  }
  try {
    if (status) status.textContent = 'loading…';
    const { farms = [] } = await fetchAllFarms({ limit: 100 });

    // Farms list.
    list.innerHTML = '';
    if (farms.length === 0) {
      empty.style.display = '';
    } else {
      empty.style.display = 'none';
      for (const farm of farms) {
        list.appendChild(renderFarmCard(farm));
      }
    }

    // Your bonds across all farms. Worker exposes
    // /farm/<id>/bonds?bonder=<pubkey>; we fan-out per farm and merge.
    bondsList.innerHTML = '';
    let myBonds = [];
    if (wallet?.pub) {
      const bonderHex = bytesToHex(wallet.pub);
      const perFarm = await Promise.all(farms.map(async (f) => {
        const r = await fetchBondsForBonder(f.farm_id, bonderHex);
        return { farm: f, bonds: r?.bonds || [] };
      }));
      for (const { farm, bonds } of perFarm) {
        for (const b of bonds) myBonds.push({ ...b, _farm: farm });
      }
    }
    if (myBonds.length === 0) {
      bondsEmpty.style.display = '';
    } else {
      bondsEmpty.style.display = 'none';
      for (const b of myBonds) {
        bondsList.appendChild(renderBondCard(b, b._farm));
      }
    }
    if (status) status.textContent = `${farms.length} farm${farms.length === 1 ? '' : 's'}; ${myBonds.length} of your bond${myBonds.length === 1 ? '' : 's'}`;
  } catch (e) {
    if (status) status.textContent = `error: ${e?.message || e}`;
    console.error('farms tab refresh failed', e);
  } finally {
    _renderInflight = false;
  }
}

export function initFarmsTab() {
  // Wire the Refresh button.
  const btn = document.getElementById('farms-refresh-btn');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', () => refreshFarmsTab());
  }
  // Auto-refresh on first activation of the Farms tab.
  const tab = document.querySelector('button.tab[data-tab="farms"]');
  if (tab && !tab._farmsWired) {
    tab._farmsWired = true;
    tab.addEventListener('click', () => {
      // Defer one tick so the panel becomes visible first.
      setTimeout(() => refreshFarmsTab(), 50);
    });
  }
}
