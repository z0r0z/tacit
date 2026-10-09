// Confidential DeFi tab — borrow against a shielded note. Renders over the LIVE pool's seed-only note scan
// (confidential-pool-ux.js) and drives the REAL CDP/cBTC builders (confidential-cdp.js) through the gasless
// relay (confidential-defi-actions.js). Kept out of tacit.js (a thin hook calls renderCdpTab), mirroring
// confidential-pool-tab.js.
//
// OPEN (mint cUSD), cBTC-mint and CLOSE assemble the exact guest witnesses and submit to the relay. CLOSE
// rebuilds the CDP position tree from the CdpPositionInserted event to prove membership. Top-up uses the
// same machinery and is not surfaced in the UI.

import { secp, sha256, keccak_256, hmac } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatErr, formatSpecErr, notify, proveUpdater, protectOutpoint, listProtectedOutpoints, listReservedLocks, reservedLockSats, evmAccountHint, decOf, lockedWalletHTML, wireUnlockButton, shownTicker } from './confidential-deployments.js';
import { makeConfidentialCdp } from './confidential-cdp.js';
import { makeConfidentialFarm } from './confidential-farm.js';
import { makeConfidentialDefiActions } from './confidential-defi-actions.js';
import { signSchnorr, G } from './bulletproofs.js';
import { makeCbtcLockMint } from './cbtc-lock-mint.js';
import { makeCbtcNoteRecovery } from './cbtc-note-recovery.js';
import { makeBtcHistoryProvider } from './confidential-recovery-btc.js';
import { makeCdpPositionStore } from './confidential-secret-store.js';
import { scanHealth, scanHealthHtml, inboundBadgeHtml, inboundSummaryHtml } from './confidential-scan-health.js';
import { parseUnits, formatUnits } from './confidential-payout.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}

const el = (id) => document.getElementById(id);
const ZERO32 = '0x' + '00'.repeat(32);

// A CDP position's owner is a ONE-TIME x-only pubkey (the guest validates it + verifies a close sig). The
// matching priv is persisted in the (already local-only) position descriptor so the close can re-sign.
const xOnly = (priv) => '0x' + [...G.multiply(BigInt(priv)).toRawBytes(true).slice(1)].map((x) => x.toString(16).padStart(2, '0')).join('');

// The position's own auth key (positionOwnerPriv) lives in a SEPARATE tree from the note pool — collateral
// legs are spent and the position itself is not a note leaf, so unlike every owned note in the pool it has NO
// memo channel to ride for recovery (see confidential-defi-actions.js's header comment). A random key here
// means a wiped localStorage permanently strands the ability to close the position and reclaim collateral,
// even though the underlying debt note itself stays recoverable (it IS memo-sealed — see `owned()` in
// confidential-defi-actions.js, which already carries debtNk + debtBlinding to the borrower's pubkey). Derive
// it instead so any wallet holding the identity key can re-derive every position it has ever opened against a
// given controller, purely from key + chain: HMAC(identityPriv, domain ‖ controller ‖ keyNonce_be32), reduced
// mod N. `keyNonce` here is just "the Nth position opened against this controller" — recovering after a wipe
// means walking keyNonce = 0, 1, 2, … and matching each derived positionOwner against on-chain
// CdpPositionInserted events, the same style of scan scanCbtc already does for cBTC locks.
const toBytes = (v) => v instanceof Uint8Array ? v : Uint8Array.from((String(v).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
function derivePositionOwnerPriv(walletPriv, controller, keyNonce) {
  const domain = new TextEncoder().encode('tacit-cdp-position-v1');
  const controllerBytes = toBytes(controller);
  const nonceBytes = new Uint8Array(4);
  new DataView(nonceBytes.buffer).setUint32(0, keyNonce >>> 0, false);
  const msg = new Uint8Array(domain.length + controllerBytes.length + nonceBytes.length);
  msg.set(domain); msg.set(controllerBytes, domain.length); msg.set(nonceBytes, domain.length + controllerBytes.length);
  const raw = hmac(sha256, toBytes(walletPriv), msg);
  let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
  b %= secp.CURVE.n;
  return '0x' + (b === 0n ? 1n : b).toString(16).padStart(64, '0');
}

// Persist the opening of each position so it can be closed later. This descriptor is a CACHE, not the record:
// ux.recoverCdpPositions rebuilds positions from key + chain, and the renderer merges anything it finds that
// has no local descriptor. What the descriptor buys is not having to walk the chain to close a position you
// opened in this browser.
//
// It holds no keys. The close key is the Nth position key against this controller (derivePositionOwnerPriv),
// so the descriptor keeps the nonce and the key is derived — and checked against the owner the position was
// opened under — at close time. The debt note's nullifier key and blinding derive from the anchor the settle
// makes public, so the anchor is kept in their place. confidential-secret-store.js owns both rules, and seals
// anything a descriptor written by an older build carries that does not re-derive.
const _posStore = makeCdpPositionStore({ sha256, hmac, secp, curveOrder: secp.CURVE.n });
const loadPositions = () => _posStore.list();
// The next position key index for a controller. It only ever grows: counting the saved positions would hand a
// new position the key of a still-open one as soon as an earlier one was closed and its descriptor dropped.
//
// CHAIN FIRST, storage only as a floor. Every input here used to be local: with storage cleared — a new
// device, a private window, a user who cleared site data — the counter read 0 and loadPositions() was empty,
// so a new position derived the SAME owner key as a still-open one. That is the same shape as the wrap-index
// bug that was fixed by making nextWrapIndex throw instead of falling back to 0, and the same remedy applies:
// `recoverCdpPositions` already walks the chain for this exact number and returns it as `nextKeyNonce`, so
// take that as the authority and never silently fall back to 0. A walk that could not read every loan
// transaction (`skipped`) may undercount, so it does not count either.
//
// The floor is kept per key, in the same slot the weld page uses: another key's loans in this browser must not
// push this key's index past the gap a key-only recovery walks, so only this key's own descriptors count toward it.
const KEY_NONCE_PREFIX = 'tacit-cdp-next-key-nonce:';
function keyNonceSlot(walletPriv, controller) {
  const pub = [...secp.getPublicKey(toBytes(walletPriv), true)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${KEY_NONCE_PREFIX}${String(controller).toLowerCase()}:${pub}`;
}
function localKeyNonceFloor(walletPriv, controller) {
  const c = String(controller).toLowerCase();
  let n = 0;
  try { n = Math.max(0, parseInt(localStorage.getItem(keyNonceSlot(walletPriv, c)), 10) || 0); } catch {}
  for (const p of loadPositions()) {
    if (String(p.controller).toLowerCase() !== c || !Number.isInteger(p.keyNonce)) continue;
    const mine = xOnly(derivePositionOwnerPriv(walletPriv, controller, p.keyNonce)).toLowerCase();
    if (String(p.positionOwner || '').toLowerCase() === mine) n = Math.max(n, p.keyNonce + 1);
  }
  return n;
}
async function nextKeyNonce(ux, walletPriv, controller) {
  const local = localKeyNonceFloor(walletPriv, controller);
  let onchain = null;
  try {
    const r = await ux.recoverCdpPositions({ walletPriv });
    if (r && Number.isInteger(r.nextKeyNonce) && !(r.skipped || []).length) onchain = r.nextKeyNonce;
  } catch { /* handled below */ }
  if (onchain == null && local === 0) {
    throw new Error('cannot establish the next CDP position key index: the chain walk failed and this browser '
      + 'has no saved positions. Opening one now could reuse the key of a position that is still open — retry '
      + 'once the RPC is reachable rather than proceeding.');
  }
  const n = Math.max(local, onchain ?? 0);
  try { localStorage.setItem(keyNonceSlot(walletPriv, controller), String(n + 1)); } catch {}
  return n;
}

// Persist a broadcast-but-not-yet-minted cBTC lock, keyed with the exact blinding the lock committed to —
// cbtcLockCommitment[outpoint] is fixed at lock time (ConfidentialPool.sol's OP_CBTC_MINT gate), so the mint
// must reuse it rather than pick a fresh one. Cleared once minted.
const CBTC_PENDING_KEY = 'tacit-cbtc-pending-locks-v1';
function loadPendingCbtcLocks() { try { return JSON.parse(localStorage.getItem(CBTC_PENDING_KEY) || '[]'); } catch { return []; } }
function savePendingCbtcLocks(list) { try { localStorage.setItem(CBTC_PENDING_KEY, JSON.stringify(list)); } catch {} }
function addPendingCbtcLock(rec) { const all = loadPendingCbtcLocks(); all.push(rec); savePendingCbtcLocks(all); }
function removePendingCbtcLock(lockTxid) { savePendingCbtcLocks(loadPendingCbtcLocks().filter((r) => r.lockTxid !== lockTxid)); }

// The reflection guest's outpoint key hashes the RAW (internal-order) txid, the opposite byte order from the
// display/explorer hex bitcoin-taproot-wallet.js's txid() returns — see cxfer-core::outpoint_key /
// confidential-pool.js's outpointKey (`keccak(txid ‖ vout_le)`, mirrored 1:1 here) and
// confidential-reflection-scan-indexer.js's computeTxidInternal comment for the same reversal.
function reverseHex(hex) {
  const h = String(hex).replace(/^0x/, '').match(/../g) || [];
  return h.reverse().join('');
}
function cbtcOutpoint(pool, lockTxidDisplay, lockVout) {
  return pool.outpointKey('0x' + reverseHex(lockTxidDisplay), lockVout);
}

// Open a CDP: lock the selected collateral notes → mint a cUSD debt note (gasless via the relay).
function wireOpen(wallet, ux, notes) {
  const btn = el('cdp-open-btn');
  if (!btn) return;
  const cfg = ux.cfg;
  const controller = cfg.collateralEngine;
  const statusEl = el('cdp-open-status');
  const ratioEl = el('cdp-ratio-readout');
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
  // cUSD has its own decimals (8) like any other asset here — a plain BigInt(debtStr) would read a typed
  // "100" as 100 base units (0.000001 cUSD) instead of 100 cUSD, so amounts go through the same decimal
  // parser every other amount field in the dapp uses.
  const debtDecimals = controller ? decOf(ux, cdp.debtAssetId(controller)) : 8;
  if (!controller) {
    btn.disabled = true;
    if (statusEl) statusEl.innerHTML = 'CDP minting goes live once a CollateralEngine is deployed for this pool. '
      + 'Your collateral notes are listed below and ready.';
  }

  // Live collateralization-ratio readout. The engine's own thresholds (mint floor, liquidation trigger) are
  // fetched once and cached; selected collateral is re-priced through the engine's own oracle (btcToUsd) on
  // every checkbox/amount change, so what's shown here is never a locally-guessed number. Undercollateralized
  // is the same check onCdpMint makes on-chain — showing it before submit turns an opaque revert into a
  // plain-language stop.
  const hexWord = (bi) => bi.toString(16).padStart(64, '0');
  let ratioParams = null;
  async function fetchRatioParams() {
    if (ratioParams || !controller) return ratioParams;
    try {
      const [mintWord, liqWord] = await Promise.all([
        ux.ethCall(controller, '0x4827ecb3'), // cdpRatioBps()
        ux.ethCall(controller, '0x1432d93f'), // liqRatioBps()
      ]);
      ratioParams = { mintBps: Number(BigInt(mintWord)), liqBps: Number(BigInt(liqWord)) };
    } catch { /* readout just stays quiet until it can price */ }
    return ratioParams;
  }
  async function selectedCollateralSats() {
    const checked = [...document.querySelectorAll('.cdp-collat-pick:checked')].map((c) => c.getAttribute('data-leaf'));
    const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));
    return checked.reduce((s, lf) => s + BigInt(byLeaf.get(lf)?.value || 0), 0n);
  }
  async function refreshRatio() {
    if (!ratioEl || !controller) return;
    const collatSats = await selectedCollateralSats();
    if (collatSats <= 0n) { ratioEl.textContent = ''; return; }
    const [params, collateralUsdWord] = await Promise.all([
      fetchRatioParams(),
      ux.ethCall(controller, '0xd5901347' + hexWord(collatSats)).catch(() => null), // btcToUsd(uint256)
    ]);
    if (!params || collateralUsdWord == null) { ratioEl.textContent = ''; return; }
    const collateralUsd = BigInt(collateralUsdWord);
    const debtStr = (el('cdp-debt-amount') && el('cdp-debt-amount').value || '').trim();
    let debtUnits = 0n;
    try { debtUnits = debtStr ? parseUnits(debtStr, debtDecimals) : 0n; } catch { /* shown as invalid by the submit path */ }
    const collateralTxt = `${formatUnits(collateralUsd, debtDecimals)} cUSD of collateral`;
    if (debtUnits <= 0n) {
      ratioEl.textContent = `${collateralTxt} selected · needs ≤ ${(10000 / params.mintBps * 100).toFixed(0)}% of that as debt to mint (liquidates at ${(params.liqBps / 100).toFixed(0)}%)`;
      ratioEl.style.color = '';
      return;
    }
    const ratioPct = Number(collateralUsd * 10000n / debtUnits) / 100;
    const safe = ratioPct * 100 >= params.mintBps;
    ratioEl.textContent = `${collateralTxt} → ${ratioPct.toFixed(0)}% ratio`
      + (safe ? ` (mint needs ≥ ${(params.mintBps / 100).toFixed(0)}%, liquidates at ${(params.liqBps / 100).toFixed(0)}%)`
              : ` — below the ${(params.mintBps / 100).toFixed(0)}% mint floor; borrow less or add collateral`);
    ratioEl.style.color = safe ? '' : 'var(--red, #b3261e)';
  }
  document.querySelectorAll('.cdp-collat-pick').forEach((cb) => cb.addEventListener('change', refreshRatio));
  el('cdp-debt-amount')?.addEventListener('input', refreshRatio);
  refreshRatio();

  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    if (!controller) return;
    const checked = [...document.querySelectorAll('.cdp-collat-pick:checked')].map((c) => c.getAttribute('data-leaf'));
    const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));
    const idNow = ux.identity(wallet.priv);
    const collateral = checked.map((lf) => {
      const n = byLeaf.get(lf);
      // Each collateral leg spends a note: the guest reconstructs its leaf under the note's OWN owner and
      // nullifies it under the note's secret nullifier key, so both ride the witness (the prover harness reads
      // `leg.owner` / `leg.nk` and refuses to prove without them).
      return { asset: n.asset, cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner || idNow.owner, nk: n.secret };
    });
    if (!collateral.length) { if (statusEl) statusEl.textContent = 'Select at least one collateral note.'; return; }
    const debtStr = (el('cdp-debt-amount') && el('cdp-debt-amount').value || '').trim();
    let debtValue;
    try { debtValue = parseUnits(debtStr, debtDecimals); } catch (e) { if (statusEl) statusEl.textContent = e.message; return; }
    if (debtValue <= 0n) { if (statusEl) statusEl.textContent = 'Enter a cUSD amount to borrow.'; return; }
    // Same check the engine makes on-chain (onCdpMint's Undercollateralized revert) — catch it here so a
    // guaranteed-to-fail open never leaves the wallet to a relay round trip first.
    const collatSatsNow = collateral.reduce((s, c) => s + BigInt(c.value), 0n);
    const params = await fetchRatioParams();
    if (params) {
      try {
        const collateralUsdWord = await ux.ethCall(controller, '0xd5901347' + hexWord(collatSatsNow));
        const collateralUsd = BigInt(collateralUsdWord);
        if (debtValue * BigInt(params.mintBps) > collateralUsd * 10000n) {
          if (statusEl) statusEl.textContent = `That would open below the ${(params.mintBps / 100).toFixed(0)}% mint floor `
            + `(this basket supports up to ${formatUnits(collateralUsd * 10000n / BigInt(params.mintBps), debtDecimals)} cUSD). `
            + `Borrow less or select more collateral.`;
          return;
        }
      } catch { /* fall through — worst case the chain re-checks and reverts with the same message */ }
    }
    const root = byLeaf.get(checked[0]).root;
    // Fresh per-position owner (the unlinkable leaf owner the guest publishes for keeper liquidation); the
    // guest's own position-tree nonce is fixed to 0 (unrelated to keyNonce below). Deterministically derived
    // (see derivePositionOwnerPriv) so this position stays recoverable from the identity key alone; keyNonce
    // is simply "the Nth position opened against this controller" so far, taken from the chain (see nextKeyNonce).
    const keyNonce = await nextKeyNonce(ux, wallet.priv, controller);
    const positionOwnerPriv = derivePositionOwnerPriv(wallet.priv, controller, keyNonce);
    const positionOwner = xOnly(positionOwnerPriv);
    // The debt note's blinding and nullifier key derive from the wallet key and the first collateral note's nullifier (the
    // settle spends it), so the note is re-derivable from the key alone as well as through its sealed memo. They are distinct
    // from positionOwner, which authorizes the POSITION, not the debt note (H(debtNk) is the note's leaf owner, per
    // cxfer-core's bearer-note convention). debtNk must still be kept: it is what later spends the note.
    const c0 = collateral[0];
    const anchor = ux.pool.nativeNu(c0.owner, c0.nk, ux.pool.leaf(c0.asset, c0.cx, c0.cy, c0.owner));
    const debtKeys = ux.deriveOutput(wallet.priv, anchor, 'cdpDebt', 0);
    const debtBlinding = debtKeys.blindingHex;
    const debtNk = debtKeys.nk;
    // The engine accepts a snapshot in [RAY, rate()] and charges interest from it, so the live rate is the only
    // value that is both accepted and free of back-interest (RAY while the stability fee is dormant).
    const rateWord = await ux.ethCall(controller, '0x2c4e722e'); // rate()
    if (!/^0x[0-9a-f]{64}$/i.test(String(rateWord || '')) || BigInt(rateWord) < 10n ** 27n) {
      if (statusEl) statusEl.textContent = 'Could not read the engine rate; retry in a moment.';
      return;
    }
    const rateSnapshot = String(rateWord).toLowerCase();
    const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
    const defi = makeConfidentialDefiActions({
      pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
      id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
    });
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Building + settling your position via the relayer…';
    try {
      // Settled from the wallet's own Ethereum account, the mint is credited to it by the points program.
      const selfSettle = el('cdp-self-settle')?.checked ? (x) => ux.submitSettle({ settlerPriv: wallet.priv, ...x }) : null;
      const r = await defi.openCdp({
        controller, debtValue, rateSnapshot, fee: 0n, collateral,
        spendRoot: root, debtBlinding, positionOwner, debtNk, selfSettle,
        waitOpts: { onUpdate: proveUpdater(statusEl, 'Opening CDP') },
      });
      // Locators only: `keyNonce` re-derives positionOwnerPriv, `debtAnchor` re-derives the debt note's
      // (nk, blinding). Neither secret is written. A descriptor that could not be saved costs nothing but a
      // chain walk — recoverCdpPositions rebuilds the position from the wallet key — so it is not fatal.
      await _posStore.add(wallet.priv, {
        controller, debtValue: debtValue.toString(), nonce: ZERO32, keyNonce, positionOwner, rateSnapshot, debtAnchor: anchor,
        basket: collateral.map((c) => ({ asset: c.asset, value: String(BigInt(c.value)) })),
        openedAt: r && r.txHash || null,
      });
      if (statusEl) statusEl.innerHTML = `Position opened — borrowed ${formatUnits(debtValue, debtDecimals)} cUSD`
        + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '') + '.';
      notify(`Position opened — borrowed ${formatUnits(debtValue, debtDecimals)} cUSD`, 'ok');
      setTimeout(() => renderCdpTab(wallet), 1500);
    } catch (e) {
      // The pre-submit check above catches the common case; this remains for a price move between that
      // check and settle, or the rare feed-just-changed grace window — decode the engine's own revert names
      // rather than show a bare selector/string.
      const m = formatSpecErr(e, 'Open');
      const hint = /Undercollateralized/i.test(m)
        ? `${m} — the collateral's price moved, or another action against it settled first. Refresh and try again.`
        : /BadSnapshot/i.test(m)
        ? `${m} — the engine's rate moved between build and settle. Retry.`
        : /FeedChangeGrace/i.test(m)
        ? `${m} — the price feed just changed; the engine pauses new mints briefly after that. Retry shortly.`
        : m;
      if (statusEl) statusEl.textContent = hint; notify(hint, 'error');
      btn.disabled = false;
    }
  };
}

// Mint a cBTC.zk bearer note against a reflection-recorded self-custody Bitcoin lock.
function renderPendingCbtcLocks() {
  const list = el('cdp-cbtc-pending');
  if (!list) return;
  const pending = loadPendingCbtcLocks();
  if (!pending.length) { list.innerHTML = ''; return; }
  list.innerHTML = pending.map((p, i) => `
    <div class="check-row" style="padding:5px 0;display:flex;justify-content:space-between;gap:8px;align-items:center;">
      <span style="font-size:11.5px;">Locked <code class="addr">${esc(p.lockTxid.slice(0, 12))}…:${p.lockVout}</code> — ${esc(p.vBtc)} sats
        <span class="cbtc-step" data-i="${i}" style="display:block;opacity:.75;">Checking the lock…</span>
        <span class="cbtc-fund" data-i="${i}" style="display:none;opacity:.75;"></span></span>
      <button class="cbtc-mint-pending-btn" data-i="${i}" style="font-size:11.5px;" disabled>Mint</button>
    </div>`).join('');
}

// What posting a lock's bond takes from this wallet's Tacit account, the address postBond pays from: the ETH staked
// for the wstETH still owed, plus the gas the node holds back for it (sendPreparedTx's 450k limit at twice the gas
// price plus the tip), against what the account holds. Null when any of it cannot be read.
async function bondFunding(ux, wallet, pr) {
  try {
    const gap = pr.want > pr.have ? pr.want - pr.have : 0n;
    const addr = ux.account(wallet.priv).address;
    const wsteth = '0x' + String(await ux.ethCall(ux.cfg.cbtcEscrowHelper, '0xd9fb643a')).replace(/^0x/, '').slice(-40); // WSTETH()
    const [eth, bal, price, tip] = await Promise.all([
      ux.ethCall(wsteth, '0xbb2952fc' + gap.toString(16).padStart(64, '0')), // getStETHByWstETH(uint256)
      ux.rpc('eth_getBalance', [addr, 'latest']), ux.rpc('eth_gasPrice', []),
      ux.rpc('eth_maxPriorityFeePerGas', []).catch(() => '0x5f5e100'),
    ]);
    const payEth = BigInt(eth && eth !== '0x' ? eth : '0x0');
    if (payEth === 0n) return null;
    const t = BigInt(tip || '0x0'), prio = t > 0n && t < 1500000000n ? t : t > 0n ? 1500000000n : 100000000n;
    return { addr, payEth, bal: BigInt(bal), need: payEth + 450000n * (BigInt(price) * 2n + prio) };
  } catch { return null; }
}

// Where a pending lock stands on its way to a mint, all read from chain. The pool records the lock once the
// reflection folds its Bitcoin block, and the mint gate also wants the lock's wstETH bond at the collateral
// engine (escrowSufficient). The bond can be posted first: the engine takes it for any live outpoint and
// refunds it until a mint. It aims at 1.1x the requirement, so a small price move does not undo it.
const wei6 = (x) => { const [i, f = ''] = formatUnits(x, 18).split('.'); const d = f.slice(0, 6).replace(/0+$/, ''); return d ? `${i}.${d}` : i; };
async function cbtcLockProgress(ux, rec) {
  const { pool, collateralEngine } = ux.cfg;
  const word = (x) => BigInt(x).toString(16).padStart(64, '0');
  const uint = (r) => BigInt(r && r !== '0x' ? r : '0x0');
  const outpoint = cbtcOutpoint(ux.pool, rec.lockTxid, rec.lockVout);
  const op = word(outpoint);
  const [lock, minted, have, need] = await Promise.all([
    ux.cbtcLockState(rec.lockTxid, rec.lockVout),
    ux.ethCall(pool, '0xe2c2a40c' + op).then(uint), // cbtcMinted(bytes32)
    ux.ethCall(collateralEngine, '0xe06e89c9' + op).then(uint), // escrowTotal(bytes32)
    // requiredEscrow(uint256) prices the lock, so it reverts while the BTC price feed is stale
    ux.ethCall(collateralEngine, '0x034448ed' + word(rec.vBtc)).then(uint).catch(() => null),
  ]);
  return {
    outpoint, recorded: lock.vBtc, retired: lock.spent || lock.redeemed, minted: minted !== 0n, have, need,
    want: need == null ? null : need * 11n / 10n, bonded: need != null && have >= need,
  };
}

// Bond news, each told once per account: a bond forfeit to the insurance reserve, and one that can come back. The Borrow
// tab shows both for as long as they hold; this is the nudge that sends someone there. `r` is pool-ux cbtcBonds.
export function announceCbtcBonds(r, { tacit, ext = null } = {}) {
  if (!tacit) return;
  const key = `tacit-cbtc-bonds-seen-v1:${String(tacit).toLowerCase()}`;
  let seen;
  try { seen = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { seen = new Set(); }
  const mine = new Set([tacit, ext].filter(Boolean).map((a) => String(a).toLowerCase()));
  const news = [];
  for (const l of (r && r.locks) || []) {
    if (l.state === 'forfeit' && !seen.has(`lost:${l.op}`)) news.push([`lost:${l.op}`, `A cBTC lock was spent on Bitcoin before its cBTC was redeemed, so its ${wei6(l.total)} wstETH bond goes to the insurance reserve. See Borrow.`, 'error']);
    const back = l.bonds.filter((b) => b.take && mine.has(b.account));
    if (back.length && !seen.has(`take:${l.op}`)) news.push([`take:${l.op}`, `A cBTC bond of ${wei6(back.reduce((t, b) => t + b.share, 0n))} wstETH can come back to you. Take it back under Borrow.`, 'ok']);
  }
  for (const [id, msg, kind] of news) { notify(msg, kind); seen.add(id); }
  if (news.length) { try { localStorage.setItem(key, JSON.stringify([...seen].slice(-200))); } catch { /* told again next time */ } }
}

// Sats sitting in live locks are still the user's Bitcoin, but they are not spendable change: coin selection
// skips them, so without this line the wallet simply looks smaller than the chain says it is.
function renderReservedCbtcLocks() {
  const box = el('cdp-cbtc-reserved');
  if (!box) return;
  const locks = listReservedLocks();
  const total = reservedLockSats();
  box.innerHTML = !locks.length ? '' : `${locks.length} live cBTC lock${locks.length === 1 ? '' : 's'}`
    + (total > 0n ? ` — ${esc(total.toString())} sats reserved as collateral` : ' — reserved as collateral')
    + `, held out of ordinary spending until redeemed.`;
}

function wireCbtc(wallet, ux, helpers = {}) {
  const lockBtn = el('cdp-cbtc-lock-btn');
  const statusEl = el('cdp-cbtc-status');
  const pendingList = el('cdp-cbtc-pending');
  const progress = new Map();
  let refreshing = 0, fundPoll = null;
  refreshPending();
  renderReservedCbtcLocks();
  // The local reservation set is browser-scoped; the pool's cbtcLock* records are not. Refresh from chain so
  // a second device, a private window or a cleared cache still knows which outputs must never be spent.
  if (wallet && wallet.priv) {
    ux.syncCbtcLockReservations(wallet.priv).then(renderReservedCbtcLocks).catch(() => {});
    recoverLocks().catch(() => {});
    renderBonds();
  }

  // Every lock this wallet made and every bond its accounts posted, however posted (pool-ux cbtcBonds): what each bond does
  // now, a way to take back each one that can come back, and a notice for one forfeit to the insurance reserve.
  async function renderBonds() {
    const box = el('cdp-cbtc-bonds');
    if (!box || !wallet || !wallet.priv) return;
    const ext = helpers.ethAccount ? helpers.ethAccount() : null;
    let r;
    try { r = await ux.cbtcBonds(wallet.priv, { accounts: [ext].filter(Boolean) }); } catch { return; }
    const tacit = String(ux.account(wallet.priv).address).toLowerCase();
    const via = (a) => (a === tacit ? 'tacit' : ext && a === String(ext).toLowerCase() ? 'wallet' : null);
    const locks = r.locks.filter((l) => l.total > 0n || l.bonds.length);
    const what = { pending: 'not minted yet, can come back', backing: 'backs your cBTC until you redeem', free: 'can come back', forfeit: 'forfeit', slashed: 'in the insurance reserve' };
    const link = (l) => (l.txid ? `<a href="https://mempool.space/tx/${esc(l.txid)}" target="_blank" rel="noopener">${esc(l.txid.slice(0, 10))}…</a>` : `<code>${esc(l.op.slice(0, 12))}…</code>`);
    const note = (text) => `<div style="border-left:2px solid var(--red);padding:6px 10px;margin:4px 0;font-size:12px;">${text}</div>`;
    box.innerHTML = !locks.length ? '' : '<div style="font-weight:600;margin:12px 0 4px;font-size:12.5px;">Your bonds</div>'
      + locks.filter((l) => l.state === 'forfeit').map((l) => note(`Lock ${link(l)} was spent on Bitcoin before its cBTC was redeemed, so its ${wei6(l.total)} wstETH bond can't come back. It goes to the insurance reserve, which backs the ${esc(String(l.vBtc))} sats of cBTC minted on it.`)).join('')
      + locks.filter((l) => l.health && !l.health.healthy).map((l) => note(`Lock ${link(l)}: its bond is ${wei6(l.health.want - l.health.have)} wstETH short of what the engine asks for${l.health.due ? `. Top it up by ${esc(new Date(Number(l.health.due) * 1000).toLocaleString())}` : ''}, or it can go to the insurance reserve.`)).join('')
      + locks.map((l, i) => `<div class="muted" style="font-size:12px;display:flex;justify-content:space-between;gap:10px;margin:4px 0;"><span>${l.vBtc ? `${esc(String(l.vBtc))} sats` : 'Lock'} · ${link(l)}${l.everyday ? ' · everyday address' : ''}</span><span${l.state === 'forfeit' ? ' style="color:var(--red)"' : ''}>${wei6(l.total)} wstETH · ${what[l.state]}</span></div>`
        + l.bonds.map((b, j) => (b.take && via(b.account) ? `<button class="cbtc-bond-take" data-l="${i}" data-b="${j}" style="margin:0 0 6px;">Take back ${wei6(b.share)} wstETH to your ${via(b.account) === 'tacit' ? 'Tacit account' : 'wallet'}</button>` : '')).join('')).join('')
      + (locks.some((l) => l.everyday) ? '<div class="muted" style="font-size:11.5px;margin-top:4px;">Some locks hold their BTC at your everyday Bitcoin address, where early locks put it. This app never spends it, but another Bitcoin wallet using this key would see it as spendable, and spending it gives up its bond. Keep this key out of other Bitcoin wallets until you redeem.</div>' : '')
      + (locks.length ? '<div class="muted" style="font-size:11.5px;margin-top:4px;">A bond comes back to the account that posted it before its lock is minted against, or once the lock is redeemed. Spending a lock\'s BTC any other way gives its bond to the insurance reserve.</div>' : '');
    box.querySelectorAll('.cbtc-bond-take').forEach((btn) => btn.onclick = async () => {
      const l = locks[Number(btn.dataset.l)], b = l && l.bonds[Number(btn.dataset.b)];
      if (!b || !b.take) return;
      btn.disabled = true;
      try {
        if (statusEl) statusEl.textContent = `Taking back a ${wei6(b.share)} wstETH bond…`;
        let txHash;
        if (via(b.account) === 'tacit') ({ txHash } = await ux.sendPreparedTx({ walletPriv: wallet.priv, to: b.take.to, value: 0n, gasLimit: 300000n, calldata: b.take.data }));
        else if (helpers.ethSend) txHash = await helpers.ethSend({ to: b.take.to, data: b.take.data });
        else throw new Error('connect the wallet that posted this bond to take it back');
        const rcpt = await ux.waitReceipt(txHash);
        if (rcpt.status !== '0x1') throw new Error(`the take-back reverted (${txHash})`);
        if (statusEl) statusEl.innerHTML = `Bond taken back as wstETH (<code class="addr">${esc(txHash)}</code>).`;
        notify('cBTC bond taken back', 'ok');
      } catch (e) {
        const m = formatSpecErr(e, 'cBTC bond');
        if (statusEl) statusEl.textContent = m; notify(m, 'error');
      } finally {
        renderBonds();
      }
    });
    announceCbtcBonds(r, { tacit, ext });
  }

  // Locks this key made that this browser holds no record of (another device, cleared storage, or a lock made on weld)
  // come back from its Bitcoin history, each note's blinding re-derived from the lock's anchor the way the lock itself
  // derived it, so every lock can still be bonded and minted here.
  async function recoverLocks() {
    const found = await makeBtcHistoryProvider({ sha256, hrp: Number(ux.cfg.chainId) === 1 ? 'bc' : 'tb' }).locks(wallet.priv);
    const have = new Set(loadPendingCbtcLocks().map((r) => `${r.lockTxid}:${r.lockVout}`));
    const rec = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
    let added = 0;
    for (const l of found.filter((x) => !have.has(`${x.lockTxid}:${x.lockVout}`))) {
      const pr = await cbtcLockProgress(ux, l);
      if (pr.minted || pr.retired) continue;
      const blinding = rec.deriveCbtcNoteBlinding({ privkey: wallet.priv, anchorOutpoint: rec.anchorBytes(l.anchor.txid, l.anchor.vout), outputIndex: 0 });
      addPendingCbtcLock({ lockTxid: l.lockTxid, lockVout: l.lockVout, vBtc: l.vBtc, blinding: '0x' + BigInt(blinding).toString(16).padStart(64, '0') });
      added++;
    }
    if (added) refreshPending();
  }

  function makeDefi() {
    const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
    return makeConfidentialDefiActions({
      pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
      id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
    });
  }

  async function mintPending(rec, btn) {
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Minting your cBTC note via the relayer…';
    try {
      const outpoint = cbtcOutpoint(ux.pool, rec.lockTxid, rec.lockVout);
      const r = await makeDefi().mintCbtc({
        outpoint, vBtc: BigInt(rec.vBtc), blinding: rec.blinding,
        waitOpts: { onUpdate: proveUpdater(statusEl, 'Minting cBTC') },
      });
      removePendingCbtcLock(rec.lockTxid);
      if (statusEl) statusEl.innerHTML = `cBTC note minted — ${rec.vBtc} sats`
        + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '') + '.';
      notify(`cBTC note minted — ${rec.vBtc} sats`, 'ok');
    } catch (e) {
      // Mint is only offered once the lock is recorded and bonded, and the relay reads the same gate before it
      // proves, so its message names whatever changed in between. The pending record stays for a retry.
      const m = formatSpecErr(e, 'cBTC mint');
      if (statusEl) statusEl.textContent = m; notify(m, 'error');
    } finally {
      refreshPending();
    }
  }

  // Posts the lock's bond through CbtcEscrowHelper.postEscrowWithETH: ETH from this wallet's Tacit account is
  // staked to wstETH and posted for the lock in one transaction, refundable to that account until a mint.
  async function postBond(rec, btn, pr) {
    const helper = ux.cfg.cbtcEscrowHelper;
    btn.disabled = true;
    try {
      if (!helper || !pr || pr.want == null) throw new Error('the bond cannot be sized right now; try again in a few minutes');
      const addr = (r) => '0x' + String(r || '').replace(/^0x/, '').slice(-40).toLowerCase();
      const [engine, wsteth] = await Promise.all([
        ux.ethCall(helper, '0x3d5030a3').then(addr), // COLLATERAL_ENGINE()
        ux.ethCall(helper, '0xd9fb643a').then(addr), // WSTETH()
      ]);
      // A helper bound to another engine would post the bond where the mint gate never looks.
      if (engine !== String(ux.cfg.collateralEngine).toLowerCase()) throw new Error('the bond helper is not bound to this collateral engine');
      const gap = pr.want > pr.have ? pr.want - pr.have : 0n;
      if (gap === 0n) return;
      const r = await ux.ethCall(wsteth, '0xbb2952fc' + gap.toString(16).padStart(64, '0')); // getStETHByWstETH(uint256)
      const payEth = BigInt(r && r !== '0x' ? r : '0x0');
      if (payEth === 0n) throw new Error('the bond size could not be read; try again in a few minutes');
      if (statusEl) statusEl.textContent = `Posting the bond: ${wei6(payEth)} ETH from your Tacit account, staked to wstETH…`;
      // The helper stakes through Lido and writes the engine's escrow records, about 305k gas; only gas used is paid.
      const { txHash } = await ux.sendPreparedTx({
        walletPriv: wallet.priv, to: helper, value: payEth, gasLimit: 450000n,
        calldata: '0xc0e2d9a1' + BigInt(pr.outpoint).toString(16).padStart(64, '0'), // postEscrowWithETH(bytes32)
      });
      const rcpt = await ux.waitReceipt(txHash);
      if (rcpt.status !== '0x1') throw new Error(`the bond transaction reverted (${txHash})`);
      if (statusEl) statusEl.innerHTML = `Bond posted (<code class="addr">${esc(txHash)}</code>).`;
      notify('cBTC bond posted', 'ok');
      renderBonds();
    } catch (e) {
      const m = /insufficient ETH/i.test(String(e && e.message))
        ? `Your Tacit account ${ux.account(wallet.priv).address} needs more ETH for the bond and its gas. Send ETH to it on Ethereum from any wallet or exchange, then post the bond again.`
        : formatSpecErr(e, 'cBTC bond');
      if (statusEl) statusEl.textContent = m; notify(m, 'error');
    } finally {
      refreshPending();
    }
  }

  // One wallet prompt for a Tacit account without the ETH: the connected browser wallet sends what the bond still needs,
  // with a little room for gas moving, and once that lands the bond is posted from the Tacit account as usual, so the
  // bond and its refund stay with this wallet's key.
  async function topUpAndBond(rec, btn, pr) {
    btn.disabled = true;
    try {
      const f = pr && await bondFunding(ux, wallet, pr);
      if (!f) throw new Error('the bond cannot be sized right now; try again in a few minutes');
      const gap = (f.need * 105n) / 100n - f.bal;
      if (gap > 0n) {
        if (statusEl) statusEl.textContent = `Confirm ${wei6(gap)} ETH to your Tacit account in your wallet…`;
        const hash = await helpers.ethPay({ to: f.addr, value: gap });
        if (statusEl) statusEl.innerHTML = `Topping up your Tacit account (<code class="addr">${esc(hash)}</code>)…`;
        await ux.waitReceipt(hash);
      }
      await postBond(rec, btn, pr);
    } catch (e) {
      const m = /reject|denied|cancel/i.test(String(e && e.message)) ? 'Top-up cancelled.' : formatSpecErr(e, 'Top-up');
      if (statusEl) statusEl.textContent = m; notify(m, 'error');
      refreshPending();
    }
  }

  // Redraws the pending locks and sets each one's next step from chain: post its bond, wait for the reflection to
  // record it, or mint. A lock already minted or retired leaves the list.
  async function refreshPending() {
    const run = ++refreshing;
    renderPendingCbtcLocks();
    const pending = loadPendingCbtcLocks();
    if (!pending.length || !wallet || !wallet.priv || !ux.cfg.collateralEngine) return;
    const at = Number(ux.cfg.chainId) === 1
      ? fetch(`${ux.cfg.relayBase}/reflection/status?network=mainnet`).then((r) => r.json()).then((j) => j.attestedHeight).catch(() => null)
      : Promise.resolve(null);
    const step = (i, text, action = '', label = 'Mint') => {
      const s = pendingList && pendingList.querySelector(`.cbtc-step[data-i="${i}"]`);
      const b = pendingList && pendingList.querySelector(`.cbtc-mint-pending-btn[data-i="${i}"]`);
      if (s) s.textContent = text;
      if (b) { b.textContent = label; b.dataset.step = action; b.disabled = !action; }
    };
    // Where the Tacit account's ETH comes from, under a lock waiting on it: its address, to send ETH to from anywhere.
    const fund = (i, addr) => {
      const f = pendingList && pendingList.querySelector(`.cbtc-fund[data-i="${i}"]`);
      if (!f) return;
      f.style.display = addr ? 'block' : 'none';
      f.innerHTML = addr ? `Your Tacit account: <code class="addr">${esc(addr)}</code> <button class="cbtc-fund-copy" type="button" data-addr="${esc(addr)}" style="font-size:10.5px;padding:1px 6px;">Copy</button>` : '';
    };
    let short = false;
    const done = [];
    await Promise.all(pending.map(async (rec, i) => {
      let pr;
      try { pr = await cbtcLockProgress(ux, rec); } catch { if (run === refreshing) step(i, 'Could not read this lock from chain; reopen the tab to retry.'); return; }
      if (run !== refreshing) return;
      progress.set(i, pr);
      if (pr.minted || pr.retired) { done.push(rec.lockTxid); return; }
      const vBtc = BigInt(rec.vBtc);
      if (pr.recorded > 0n && pr.recorded !== vBtc) step(i, `The pool records ${pr.recorded} sats for this lock, not ${vBtc}.`);
      else if (pr.need == null) step(i, 'The BTC price feed is updating; the bond can be sized again in a few minutes.');
      else if (!pr.bonded) {
        const f = await bondFunding(ux, wallet, pr);
        if (run !== refreshing) return;
        if (f && f.bal < f.need) {
          short = true;
          const top = helpers.ethPay ? ['topup', 'Top up from wallet'] : ['', 'Post bond'];
          step(i, `Needs its bond: ${wei6(f.payEth)} ETH, staked as wstETH, paid from your Tacit account, the Ethereum address this wallet's key controls. It holds ${wei6(f.bal)} ETH.${helpers.ethPay ? ' Top it up from a connected wallet and the bond posts in the same go, or' : ''} send it at least ${wei6(f.need - f.bal)} ETH on Ethereum from any wallet or exchange${helpers.ethPay ? ' and post it once that arrives' : ', and Post bond opens once it arrives'}.`, ...top);
          fund(i, f.addr);
        } else {
          step(i, `Needs its bond: ${f ? `${wei6(f.payEth)} ETH, staked as wstETH,` : `${wei6(pr.want - pr.have)} wstETH,`} paid from your Tacit account.`, 'bond', 'Post bond');
          fund(i, null);
        }
      }
      else if (pr.recorded === 0n) {
        const h = await at;
        if (run === refreshing) step(i, `Bonded. Minting opens once the reflection records this lock${h ? ` (it has reached Bitcoin block ${h})` : ''}.`, '', 'Waiting');
      } else step(i, 'Recorded and bonded.', 'mint', 'Mint');
    }));
    if (run === refreshing && done.length) {
      for (const txid of done) removePendingCbtcLock(txid);
      refreshPending();
    }
    // A lock waiting on ETH for its bond: look again shortly, so Post bond opens on its own once the ETH lands.
    clearTimeout(fundPoll);
    if (run === refreshing && short) fundPoll = setTimeout(() => { if (pendingList && pendingList.isConnected) refreshPending(); }, 20000);
  }

  if (lockBtn) {
    lockBtn.onclick = async () => {
      if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
      const satsStr = (el('cdp-cbtc-sats') && el('cdp-cbtc-sats').value || '').trim();
      const amountSats = /^[0-9]+$/.test(satsStr) ? BigInt(satsStr) : 0n;
      if (amountSats <= 0n) { if (statusEl) statusEl.textContent = 'Enter the sats amount to lock.'; return; }
      lockBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Broadcasting your self-custody Bitcoin lock…';
      try {
        const hrp = Number(ux.cfg.chainId) === 1 ? 'bc' : 'tb';
        // Never let a lock fund itself out of an outpoint that is already reserved — above all, an earlier
        // cBTC lock. Spending one of those is read by the fold as a rug and slashes its escrow, and there is
        // no cure path. cbtc-lock-mint also excludes the dust band on its own; this adds what only the tab
        // knows.
        // Refreshed from chain first, not read straight from local storage: on a device that has never held
        // this wallet's locks the cached set is empty, and an empty exclude set is exactly how a new lock
        // funds itself out of an older one. Better to refuse the lock than to build it half-blind.
        try { await ux.syncCbtcLockReservations(wallet.priv); } catch (e) {
          throw new Error(`cannot confirm which of your Bitcoin outputs are live cBTC locks (${(e && e.message) || e}) — `
            + 'retry once Bitcoin history is reachable rather than funding a lock from an unchecked set.');
        }
        const lm = makeCbtcLockMint({
          priv: wallet.priv, pool: ux.pool, cbtcAsset: ux.pool.CBTC_ZK_ASSET_ID, hrp,
          excludeOutpoints: listProtectedOutpoints(),
        });
        const res = await lm.lock({ amountSats });
        // Reserve the lock output from ordinary coin selection as soon as it is broadcast. The lock is a plain
        // spendable UTXO, and spending it outside a redemption retires it against its escrow. Registered here
        // rather than at mint time because the broadcast-to-mint window is when other payments are most likely.
        try { protectOutpoint(res.lockTxid, res.lockVout, res.vBtc); renderReservedCbtcLocks(); } catch {}
        // blinding comes back as a BigInt (deriveCbtcNoteBlinding); JSON.stringify can't serialize that, so
        // store it as hex and convert back to BigInt at mint time.
        addPendingCbtcLock({ ...res, blinding: '0x' + BigInt(res.blinding).toString(16).padStart(64, '0') });
        refreshPending();
        if (statusEl) statusEl.innerHTML = `Locked <code class="addr">${esc(res.lockTxid)}</code>. Post its bond below; `
          + 'minting opens once the reflection records the lock.';
        notify(`cBTC lock broadcast — ${res.vBtc} sats`, 'ok');
      } catch (e) {
        const m = formatSpecErr(e, 'cBTC lock');
        if (statusEl) statusEl.textContent = m; notify(m, 'error');
      } finally {
        lockBtn.disabled = false;
      }
    };
  }

  if (pendingList) {
    pendingList.addEventListener('click', (ev) => {
      const cp = ev.target.closest('.cbtc-fund-copy');
      if (cp) {
        Promise.resolve().then(() => navigator.clipboard.writeText(cp.dataset.addr))
          .then(() => { cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1500); }, () => { cp.textContent = 'Select it above'; });
        return;
      }
      const btn = ev.target.closest('.cbtc-mint-pending-btn');
      if (!btn || btn.disabled) return;
      const i = Number(btn.getAttribute('data-i'));
      const rec = loadPendingCbtcLocks()[i];
      if (!rec) return;
      if (btn.dataset.step === 'bond') postBond(rec, btn, progress.get(i));
      else if (btn.dataset.step === 'topup') topUpAndBond(rec, btn, progress.get(i));
      else if (btn.dataset.step === 'mint') mintPending(rec, btn);
    });
  }
}

export async function renderCdpTab(wallet, helpers = {}) {
  const body = el('cdp-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Borrowing (CDP)'); return; }
  const ux = getUx();
  const conceptHtml = `<div class="note-concept"><b>Two steps: get cBTC, then borrow cUSD against it.</b>
      <b>cBTC</b> is minted 1:1 from a Bitcoin lock only your key can spend; tacBTC is its ERC-20 form. Minting
      needs an ETH bond too — about 1.5× the lock's value, staked as wstETH and refundable — which deters
      spending the lock outside a valid exit; it does not back the peg.
      <b>cUSD</b> is the <span class="btc-word">bitcoin-backed dollar</span>: lock cBTC as collateral and mint a
      cUSD note. A position's amounts are public so it can be priced, but its owner is not linked to it.
      Both are ordinary shielded notes that transfer, trade and exit like anything else in the pool.</div>`;
  if (!wallet || !wallet.priv) {
    // Same wallet as the Bitcoin lane — no separate "connect an Ethereum
    // wallet" step. Keeps the concept blurb visible even locked, so the tab
    // explains itself instead of reading as a single dead-end sentence.
    body.innerHTML = conceptHtml + lockedWalletHTML('borrow', 'cdp-unlock-btn');
    wireUnlockButton('cdp-unlock-btn', helpers);
    return;
  }
  const acct = ux.account(wallet.priv);
  body.innerHTML = `
    <div class="tab-form">
    ${conceptHtml}
    <div>Account: <code class="addr" style="font-size:11px;">${acct.address}</code></div>
    ${evmAccountHint()}
    <div id="cdp-status" class="muted">Scanning the pool for collateral…</div>

    <div class="divider">
      <div style="font-weight:600;margin-bottom:2px;">① Get cBTC <span class="muted" style="font-weight:400;font-size:11px;">· lock BTC → 1:1 cBTC, redeemable, no custodian</span></div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">Your Bitcoin stays in a lock only your key can spend. Needs two things: the BTC to lock, and — before it can mint — ETH for a bond (about 1.5× the lock's value, staked as wstETH). The bond is refundable and just deters spending the lock outside a valid exit; it doesn't back cBTC's value. Three steps:</div>
      <ol class="cbtc-flow" style="list-style:none;padding:0;margin:0 0 10px;font-size:12.5px;">
        <li style="display:flex;gap:.55em;margin-bottom:7px;"><span class="cbtc-step-n">①</span><span><b>Lock</b> — broadcast a self-custody Bitcoin lock for the amount you want as cBTC.</span></li>
        <li style="display:flex;gap:.55em;margin-bottom:7px;"><span class="cbtc-step-n">②</span><span><b>Bond</b> — once the lock is ~6 confirmations deep, post the ETH bond from this wallet's Tacit account.</span></li>
        <li style="display:flex;gap:.55em;"><span class="cbtc-step-n">③</span><span><b>Mint</b> — a cBTC note lands in your wallet, gasless. Optionally externalize it to <b>tacBTC</b> (ERC-20) via the factory.</span></li>
      </ol>
      <div style="font-weight:600;margin:6px 0 6px;font-size:12.5px;">Lock BTC</div>
      <div class="field-row">
        <input id="cdp-cbtc-sats" type="number" min="0" step="1" placeholder="Sats to lock → cBTC 1:1">
        <button id="cdp-cbtc-lock-btn" class="primary">Lock BTC</button>
      </div>
      <div id="cdp-cbtc-pending" style="margin-top:4px;"></div>
      <div id="cdp-cbtc-reserved" class="muted" style="font-size:11.5px;margin-top:4px;"></div>
      <div id="cdp-cbtc-bonds"></div>
      <div id="cdp-cbtc-status" class="muted field-status" style="margin-top:6px;"></div>
    </div>

    <div class="divider">
      <div style="font-weight:600;margin-bottom:8px;">② Mint cUSD <span class="muted" style="font-weight:400;font-size:11px;">· the bitcoin-backed dollar · borrow against your cBTC</span></div>
      <div id="cdp-collat-list" class="muted" style="font-size:12px;margin-bottom:8px;">—</div>
      <div class="field-row">
        <input id="cdp-debt-amount" type="number" min="0" step="any" placeholder="cUSD to borrow, e.g. 100.5">
        <button id="cdp-open-btn" class="primary">Open</button>
      </div>
      <div id="cdp-ratio-readout" class="muted field-status"></div>
      <label class="muted" style="display:flex;gap:6px;align-items:flex-start;font-size:11px;margin-top:6px;cursor:pointer;"><input id="cdp-self-settle" type="checkbox" style="margin:1px 0 0;"> Earn points: send the loan from this wallet's Ethereum account, which pays its gas and is linked to it. Relayed, it earns none.</label>
      <div id="cdp-open-status" class="muted field-status"></div>
    </div>

    <div id="cdp-positions" class="divider"></div>
    </div>`;

  wireCbtc(wallet, ux, helpers);

  if (el('cdp-status')) el('cdp-status').textContent = 'Scanning the pool…';
  try {
    const { notes, diag } = await ux.balance(wallet.priv);
    const statusEl = el('cdp-status');
    const collat = el('cdp-collat-list');
    // Collateral is picked from this list, so a channel that did not answer is named before the list, not
    // left to read as "you have nothing to post".
    const health = scanHealth(diag);
    const banner = scanHealthHtml(diag, { style: 'margin:6px 0;' });
    // Only cBTC backs a position — CollateralEngine._basketUsd reverts NotCbtcCollateral on anything else —
    // so filter here rather than let the picker offer a note that would fail after a full build + relay round
    // trip with an opaque revert.
    const cbtcAssetId = ux.pool.CBTC_ZK_ASSET_ID;
    const allNotes = notes || [];
    const collatNotes = allNotes.filter((n) => n.asset && n.asset.toLowerCase() === cbtcAssetId.toLowerCase());
    if (!collatNotes.length) {
      if (statusEl) statusEl.textContent = allNotes.length
        ? 'You hold shielded notes, but none are cBTC — only cBTC can back a position. Lock BTC below to get some.'
        : (health.ok
          ? 'No shielded notes to use as collateral — wrap into the pool first.'
          : 'No collateral notes found in the channels this scan could finish.');
      if (collat) collat.innerHTML = banner + '<span class="muted">No cBTC collateral notes yet.</span>';
    } else {
      if (statusEl) statusEl.textContent = `${collatNotes.length} cBTC note${collatNotes.length === 1 ? '' : 's'} available as collateral`;
      if (collat) {
        collat.innerHTML = banner + collatNotes.map((n) => {
          const ticker = ux.tickerOf(n.asset) || 'note';
          const dec = decOf(ux, n.asset);
          return `<label class="check-row" style="padding:5px 0;">
            <input type="checkbox" class="cdp-collat-pick" data-leaf="${n.leafIndex}">
            <span>${formatUnits(n.value, dec)} ${esc(shownTicker(ticker))} <span class="muted">#${n.leafIndex}</span>${inboundBadgeHtml(n)}</span></label>`;
        }).join('') + inboundSummaryHtml(collatNotes);
      }
    }
    wireOpen(wallet, ux, collatNotes);
  } catch (e) {
    const statusEl = el('cdp-status');
    if (statusEl) statusEl.textContent = 'Could not scan the pool: ' + formatErr(e);
  }

  // Positions, each closable: the CDP position tree is rebuilt from CdpPositionInserted to prove membership,
  // the debt is repaid from the user's cUSD notes, and the basket is released.
  //
  // The chain is the source of truth, this browser's descriptors are a cache. Listing only the local ones
  // meant a user who cleared site data, switched laptops or opened a private window saw NO positions at all,
  // while their collateral sat locked behind cUSD debt with no import path in the UI. `recoverCdpPositions`
  // rebuilds them from key + chain — it is already folded into ux.recover() and covered by tests — so a
  // recovered position that has no local descriptor is merged in and shown rather than silently dropped.
  // Descriptors an older build wrote carry the position's close key (and the debt note's nullifier key) in
  // the clear: rewrite them first — derived where the nonce reproduces them, sealed where it does not.
  if (wallet && wallet.priv) { try { await _posStore.migrate(wallet.priv); } catch { /* left as they were; retried next render */ } }
  const posBox = el('cdp-positions');
  const local = loadPositions().filter((p) => p.controller && ux.cfg.collateralEngine
    && p.controller.toLowerCase() === ux.cfg.collateralEngine.toLowerCase());
  const positions = local.slice();
  try {
    const rec = await ux.recoverCdpPositions({ walletPriv: wallet.priv });
    const seen = new Set(local.map((p) => String(p.positionOwner || '').toLowerCase()));
    for (const p of (rec && rec.positions) || []) {
      const key = String(p.positionOwner || '').toLowerCase();
      if (key && !seen.has(key)) { positions.push({ ...p, recovered: true }); seen.add(key); }
    }
  } catch (e) {
    // A failed walk must not be reported as "no positions": say the list may be incomplete instead.
    const statusEl = el('cdp-status');
    if (statusEl) statusEl.textContent = 'Showing locally-saved positions only — the chain walk failed: ' + formatErr(e);
  }
  if (posBox && positions.length) {
    posBox.style.display = '';
    const posCdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
    const posDebtDecimals = decOf(ux, posCdp.debtAssetId(ux.cfg.collateralEngine));
    posBox.innerHTML = `<div style="font-weight:600;margin-bottom:6px;">Your positions</div>`
      + positions.map((p, i) => `<div class="list-row">
          <span>${formatUnits(BigInt(p.debtValue), posDebtDecimals)} cUSD borrowed · ${p.basket.length} collateral leg${p.basket.length === 1 ? '' : 's'}${p.recovered ? ' · recovered from chain' : ''}</span>
          <span style="flex:0 0 auto;display:inline-flex;gap:6px;">
            <button class="cdp-topup-toggle" data-pos="${i}" style="padding:3px 10px;font-size:10px;">Add collateral</button>
            <button class="cdp-close-one" data-pos="${i}" style="padding:3px 10px;font-size:10px;">Close</button>
          </span></div>
        <div class="cdp-topup-form" data-pos="${i}" style="display:none;padding:6px 0 10px;">
          <div class="cdp-topup-collat-list muted" data-pos="${i}" style="font-size:11.5px;margin-bottom:6px;">loading your cBTC notes…</div>
          <button class="cdp-topup-confirm" data-pos="${i}" style="font-size:10px;padding:3px 10px;">Confirm add</button>
          <div class="cdp-topup-status muted field-status" data-pos="${i}" style="margin-top:4px;"></div>
        </div>`).join('')
      + `<div id="cdp-close-status" class="muted field-status" style="margin-top:6px;"></div>`;
    wireClose(wallet, ux, positions);
    wireTopup(wallet, ux, positions);
  } else if (posBox) {
    // Empty: collapse so the bare .divider top-border doesn't render a stray rule.
    posBox.innerHTML = '';
    posBox.style.display = 'none';
  }
}

// Close a CDP: rebuild the position tree (CdpPositionInserted), prove the position's membership, repay the
// debt from the user's cUSD notes, and release the collateral basket. Drives the REAL buildCdpCloseOp via
// confidential-defi-actions.closeCdp.
function wireClose(wallet, ux, positions) {
  const statusEl = el('cdp-close-status');
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
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
        const debtDecimals = decOf(ux, debtAsset);
        const debtValue = BigInt(p.debtValue);
        // The position leaf the proof must prove membership for (same derivation buildCdpCloseOp uses).
        const sortedBasket = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
        const basketRootHex = cdp.basketRoot(sortedBasket.map((l) => cdp.basketLeg(l.asset, l.value)));
        const pOwner = p.positionOwner || id.owner; // fresh per-position owner (legacy fallback)
        // The one-time key that signs the owner-authorized close, re-derived from this position's key nonce
        // (and only accepted when it reproduces the owner the position was opened under). A descriptor an
        // older build wrote, or one recoverCdpPositions handed back in memory, still answers from its own copy.
        const pOwnerPriv = await _posStore.ownerPrivFor(wallet.priv, p);
        if (!pOwnerPriv) { if (statusEl) statusEl.textContent = 'This position predates owner-authorized close (no saved key); it can only be liquidated.'; btn.disabled = false; return; }
        const pNonce = p.nonce || ZERO32;
        const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRootHex, debtValue, p.rateSnapshot, pOwner, pNonce);
        const posTree = await ux.cdpPositionTree();
        const positionIndex = posTree.indexOf(positionLeaf);
        if (positionIndex < 0) { if (statusEl) statusEl.textContent = 'Position not found on-chain yet (still settling?).'; btn.disabled = false; return; }
        const positionPath = posTree.pathFor(positionIndex).path;
        // Repay: every burned debt note is consumed whole and anything above the debt is not returned, so take the
        // smallest single note that covers it, or else the largest notes first (fewest notes, least overshoot).
        const { notes } = await ux.balance(wallet.priv);
        const own = (notes || []).filter((x) => x.asset.toLowerCase() === debtAsset.toLowerCase());
        const byValue = (x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : BigInt(x.value) > BigInt(y.value) ? 1 : 0);
        const single = own.filter((n) => BigInt(n.value) >= debtValue).sort(byValue)[0];
        const picked = [];
        let sum = 0n;
        for (const n of (single ? [single] : own.sort(byValue).reverse())) {
          picked.push(n);
          sum += BigInt(n.value);
          if (sum >= debtValue) break;
        }
        // The burned debt note is spent under its own secret nullifier key (the harness reads `nk`).
        const debtNotes = picked.map((n) => ({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner, nk: n.secret }));
        if (sum > debtValue && !window.confirm(`Repaying ${formatUnits(debtValue, debtDecimals)} cUSD uses notes worth ${formatUnits(sum, debtDecimals)}; the extra ${formatUnits(sum - debtValue, debtDecimals)} is not returned. Split a note to the exact amount first to avoid that. Continue anyway?`)) { btn.disabled = false; return; }
        if (sum < debtValue) { if (statusEl) statusEl.textContent = `Need ${formatUnits(debtValue, debtDecimals)} cUSD to repay; you hold ${formatUnits(sum, debtDecimals)} privately. tacUSD in your account turns back into cUSD under Send → Just hold it privately.`; btn.disabled = false; return; }
        const root = (notes.find((x) => x.asset.toLowerCase() === debtAsset.toLowerCase()) || {}).root;
        // One blinding and nk per released leg, derived from the wallet key and the closed position's nullifier — the leaf owner
        // is H(nk), which is what the guest publishes. The opening (including this nk) also rides the sealed memo, so the notes
        // stay recoverable from the wallet key alone even if this browser's localStorage is wiped.
        const posNullifier = cdp.positionNullifier(positionLeaf);
        const releaseKeys = sortedBasket.map((_leg, i) => ux.deriveOutput(wallet.priv, posNullifier, 'cdpRelease', i));
        const releaseBlindings = releaseKeys.map((k) => k.blindingHex);
        const releaseNks = releaseKeys.map((k) => k.nk);
        if (statusEl) statusEl.textContent = 'Building + settling the close via the relayer…';
        await defi.closeCdp({
          controller, debtValue, rateSnapshot: p.rateSnapshot, positionOwner: pOwner, positionOwnerPriv: pOwnerPriv,
          basket: sortedBasket, positionIndex, positionPath, spendRoot: root, cdpPositionRoot: posTree.root,
          fee: 0n, releaseBlindings, releaseNks, debtNotes,
          waitOpts: { onUpdate: proveUpdater(statusEl, 'Closing') },
        });
        // Drop the local descriptor on success.
        // Every position's tree nonce is 0, so the per-position owner is what identifies this one.
        _posStore.remove((x) => x.controller === p.controller && (x.positionOwner || '') === (p.positionOwner || '') && x.debtValue === p.debtValue);
        if (statusEl) statusEl.textContent = 'Position closed — collateral released to your notes.';
        notify('Position closed — collateral released', 'ok');
        setTimeout(() => renderCdpTab(wallet), 1500);
      } catch (e) {
        const m = formatSpecErr(e, 'Close');
        if (statusEl) statusEl.textContent = m; notify(m, 'error');
        btn.disabled = false;
      }
    };
  }
}

// Add collateral to an open position (topupCdp). Same membership-proof shape as close (rebuild the position
// tree, prove the CURRENT leaf), but the position is REPLACED rather than spent: onCdpTopup requires the new
// basket to be worth strictly more than the old one and re-checks the health ratio against it, then the guest
// folds any added leg of an asset the basket already holds into that same leg rather than appending a second
// one (cxfer-core::cdp_topup — v1 only ever has one leg since only cBTC is accepted collateral). Both the old
// and new position leaves use nonce = 0: the wallet-key recovery walk (confidential-recovery.js:walkCdpPositions)
// hardcodes nonce = 0 for every leaf it tries to match, mint or topup alike, because the basket/debt/rate
// differences already make each leaf in a position's lineage unique — a topup that used a different nonce
// would compute a leaf recovery could never find after a wiped browser. Confirmed against the real fixture
// (contracts/sp1/confidential/fixtures/cdp_topup_op.json): oldNonce and newNonce are both zero there too.
function wireTopup(wallet, ux, positions) {
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
  const defi = makeConfidentialDefiActions({
    pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
    id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
  });
  const cbtcAssetId = ux.pool.CBTC_ZK_ASSET_ID;
  // Per-row cache of the fresh cBTC notes fetched when that row's form first opens, so Confirm doesn't have
  // to re-scan (and so the checked leaves stay stable while the user is picking).
  const rowNotes = new Map();
  for (const btn of document.querySelectorAll('.cdp-topup-toggle')) {
    btn.onclick = async () => {
      const i = btn.getAttribute('data-pos');
      const form = document.querySelector(`.cdp-topup-form[data-pos="${i}"]`);
      if (!form) return;
      const opening = form.style.display === 'none';
      form.style.display = opening ? '' : 'none';
      if (!opening || rowNotes.has(i)) return;
      const listEl = document.querySelector(`.cdp-topup-collat-list[data-pos="${i}"]`);
      try {
        const { notes } = await ux.balance(wallet.priv);
        const cbtcNotes = (notes || []).filter((n) => n.asset && n.asset.toLowerCase() === cbtcAssetId.toLowerCase());
        rowNotes.set(i, cbtcNotes);
        if (!listEl) return;
        // Radio, not checkbox: OP_CDP_TOPUP reads one added leg per distinct asset (strictly asset-sorted,
        // no duplicates — contracts/sp1/confidential/src/main.rs's added-legs loop), and v1 has exactly one
        // collateral asset (cBTC), so at most one note can ever be added per top-up. Checking two would always
        // fail deep in proof-building with no clear message, after "Confirm" was already clicked.
        listEl.innerHTML = cbtcNotes.length ? cbtcNotes.map((n) => `<label class="check-row" style="padding:3px 0;">
            <input type="radio" name="cdp-topup-pick-${i}" class="cdp-topup-pick" data-pos="${i}" data-leaf="${n.leafIndex}">
            <span>${formatUnits(n.value, decOf(ux, n.asset))} cBTC <span class="muted">#${n.leafIndex}</span></span></label>`).join('')
          : `<span class="muted">No spare cBTC notes — lock more BTC above first.</span>`;
      } catch (e) {
        if (listEl) listEl.textContent = 'Could not load collateral: ' + formatErr(e);
      }
    };
  }
  for (const btn of document.querySelectorAll('.cdp-topup-confirm')) {
    btn.onclick = async () => {
      const i = btn.getAttribute('data-pos');
      const p = positions[Number(i)];
      const statusEl = document.querySelector(`.cdp-topup-status[data-pos="${i}"]`);
      if (!p) return;
      const checked = [...document.querySelectorAll(`.cdp-topup-pick[data-pos="${i}"]:checked`)].map((c) => c.getAttribute('data-leaf'));
      if (!checked.length) { if (statusEl) statusEl.textContent = 'Select at least one cBTC note to add.'; return; }
      const notes = rowNotes.get(i) || [];
      const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));
      const idNow = ux.identity(wallet.priv);
      const addedCollateral = checked.map((lf) => {
        const n = byLeaf.get(lf);
        return { asset: n.asset, cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner || idNow.owner, nk: n.secret };
      });
      const root = byLeaf.get(checked[0]).root;
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Rebuilding the position tree…';
      try {
        const controller = p.controller;
        const debtAsset = cdp.debtAssetId(controller);
        const debtValue = BigInt(p.debtValue);
        const sortedBasket = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
        const basketRootHex = cdp.basketRoot(sortedBasket.map((l) => cdp.basketLeg(l.asset, l.value)));
        const pOwner = p.positionOwner || idNow.owner;
        const pOwnerPriv = await _posStore.ownerPrivFor(wallet.priv, p);
        if (!pOwnerPriv) { if (statusEl) statusEl.textContent = 'This position predates owner-authorized actions (no saved key) — cannot top up.'; btn.disabled = false; return; }
        const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRootHex, debtValue, p.rateSnapshot, pOwner, ZERO32);
        const posTree = await ux.cdpPositionTree();
        const positionIndex = posTree.indexOf(positionLeaf);
        if (positionIndex < 0) { if (statusEl) statusEl.textContent = 'Position not found on-chain yet (still settling?).'; btn.disabled = false; return; }
        const positionPath = posTree.pathFor(positionIndex).path;
        if (statusEl) statusEl.textContent = 'Building + settling the top-up via the relayer…';
        await defi.topupCdp({
          controller, debtValue, rateSnapshot: p.rateSnapshot, oldBasket: sortedBasket, addedCollateral,
          positionIndex, positionPath, spendRoot: root, cdpPositionRoot: posTree.root,
          positionOwner: pOwner, positionOwnerPriv: pOwnerPriv, oldNonce: ZERO32, newNonce: ZERO32,
          waitOpts: { onUpdate: proveUpdater(statusEl, 'Adding collateral') },
        });
        // Same-asset legs fold into one (mirrors buildCdpTopupOp's merge) — v1 collateral is cBTC-only so this
        // is always a single leg in practice, but the merge is written general.
        const merged = new Map(sortedBasket.map((l) => [l.asset.toLowerCase(), BigInt(l.value)]));
        for (const c of addedCollateral) {
          const k = c.asset.toLowerCase();
          merged.set(k, (merged.get(k) || 0n) + BigInt(c.value));
        }
        const newBasket = [...merged.entries()].map(([asset, value]) => ({ asset, value: value.toString() }));
        _posStore.remove((x) => x.controller === p.controller && (x.positionOwner || '') === (p.positionOwner || '') && x.debtValue === p.debtValue);
        await _posStore.add(wallet.priv, {
          controller, debtValue: p.debtValue, nonce: ZERO32, keyNonce: p.keyNonce, positionOwner: pOwner,
          rateSnapshot: p.rateSnapshot, debtAnchor: p.debtAnchor, basket: newBasket, openedAt: p.openedAt,
        });
        if (statusEl) statusEl.textContent = 'Collateral added ✓';
        notify('Collateral added to position', 'ok');
        setTimeout(() => renderCdpTab(wallet), 1500);
      } catch (e) {
        const m = formatSpecErr(e, 'Add collateral');
        if (statusEl) statusEl.textContent = m; notify(m, 'error');
        btn.disabled = false;
      }
    };
  }
}
