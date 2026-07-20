// Converged V1 dapp bootstrap — turns launch-v1-mock/index.html from a static mock into the real dapp by
// loading the functional engine (the portable dapp/confidential-*.js modules) and mapping the mock's design
// to real engine ACTIONS. The mock keeps its look; this module supplies the behavior.
//
// STATUS: converging tab-by-tab.
//   LIVE (real engine actions, real funds, wallet-gated): Send (one-tx wrap-and-send), Swap (shielded
//     note-picker → best-tier route + live private estimate), wallet unlock + live shielded-balance readout.
//   HONEST-GATED (button tells the truth, no fake toast): Pool (needs ratio-matched note sizing), Mint
//     (Bitcoin-lock → reflection → mint pipeline), Bridge (both reflection-gated on the catch-up).
// Read paths (asset/deployment config) are SAFE and drive the UI. Nothing moves funds without an unlocked
// wallet + an explicit confirm.
//
// Load note: these relative paths resolve against dapp/ (served same-origin). If launch-v1-mock/ ships as the
// root, copy or symlink dapp/ alongside so `../dapp/*` resolves (static import paths must be string literals).
import { secp, sha256, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { setActiveNetwork, activeNetwork, getConfidentialDeployment, confidentialPoolReady, esc } from '../dapp/confidential-deployments.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

// ── V1 feature scope: the assets + surfaces the launch dapp exposes ──
export const V1_ASSETS = ['cETH', 'cUSDC', 'cUSDT', 'cwstETH', 'cBTC', 'cUSD', 'cTAC'];
export const V1_TABS = ['send', 'swap', 'liquidity', 'bridge', 'mint', 'wallet'];

// The functional engine, created once. makeConfidentialPoolUx wires the pool/router/relay/indexer against the
// active network's deployment. `wallet.priv` is supplied per-action (see setWallet); read paths need no wallet.
let _ux = null;
function engine() {
  if (!_ux) _ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256 });
  return _ux;
}

// Wallet: the engine actions take a privkey. The full passkey/PRF wallet lives in tacit.js; for the scoped V1
// surface a minimal in-memory wallet (import a 32-byte hex key or generate) is enough to drive the actions.
// Unlock UX + passkey integration is the wallet-tab wiring step.
let _wallet = null;
export function setWallet(privBytesOrHex) {
  const b = typeof privBytesOrHex === 'string'
    ? Uint8Array.from((privBytesOrHex.replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)))
    : privBytesOrHex;
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error('setWallet: need a 32-byte key');
  _wallet = { priv: b };
  return true;
}
export function hasWallet() { return !!(_wallet && _wallet.priv); }
function requireWallet() { if (!hasWallet()) throw new Error('Unlock a wallet first.'); return _wallet; }

// ── SAFE read paths (wired now) ──
// The real V1 assets for the active network, with their live metadata (assetId, decimals, permit strategy,
// live flag). The mock's asset lists / token pickers render from THIS, not hardcoded copy.
export function v1Assets() {
  const d = getConfidentialDeployment(activeNetwork());
  if (!d || !Array.isArray(d.assets)) return [];
  return d.assets
    .filter((a) => V1_ASSETS.includes(a.ticker))
    .map((a) => ({ ticker: a.ticker, assetId: a.assetId, underlying: a.underlying, decimals: a.tacitDecimals, permitType: a.permitType || (a.native ? 'native' : a.permitName ? 'eip2612' : 'permit2'), live: !!a.live }));
}
export function poolReady() { return confidentialPoolReady(activeNetwork()); }
export function deploymentStatus() {
  const d = getConfidentialDeployment(activeNetwork());
  return { network: activeNetwork(), pool: d?.pool || null, router: d?.router || null, ready: poolReady(), assets: v1Assets() };
}

// ── Fund actions (structured; each is the real engine call — wire a tab's button to it, tab by tab) ──
// wrap: public ERC20/ETH → shielded note. Smart per-token permit (native/eip2612/permit2) is already in the
// engine's routerWrap. amountWei is the underlying-decimals amount.
export async function wrap({ ticker, amountWei, onProgress }) {
  const ux = engine(); const w = requireWallet();
  return ux.routerConfigured()
    ? ux.routerWrap({ walletPriv: w.priv, amountWei, ticker })
    : ux.wrap({ walletPriv: w.priv, amountWei, ticker });
}
// send: shielded transfer if a note covers it, else one-tx wrap-and-send from public balance (gasless relay).
export async function send({ ticker, recipientPubHex, amountWei, amount, fee = 0n, onProgress }) {
  const ux = engine(); const w = requireWallet();
  return ux.wrapAndSend({ walletPriv: w.priv, ticker, recipientPubHex, amountWei, amount, fee,
    waitOpts: { onUpdate: onProgress } });
}
// mint cBTC from a reflection-recorded self-custody lock (③ of the Get-cBTC flow). Needs reflection live.
export async function mintCbtc({ outpoint, vBtc, blinding, onProgress }) {
  const ux = engine(); requireWallet();
  if (typeof ux.mintCbtc !== 'function') throw new Error('mintCbtc not exposed by this engine build');
  return ux.mintCbtc({ outpoint, vBtc, blinding, waitOpts: { onUpdate: onProgress } });
}
// balance: scan the wallet's shielded notes (the note-picker source shared by swap/liquidity/send-from-shielded).
export async function balance() { const ux = engine(); const w = requireWallet(); return ux.balance(w.priv); }

// Fee tiers tried when routing a swap — highest-liquidity first (matches confidential-swap-tab planBestRoute).
const SWAP_FEE_TIERS = [30n, 5n, 100n, 1n];
// quoteSwap: best single-pool route fromTicker→toTicker for amountIn (underlying-decimals). Read-only, no wallet.
export async function quoteSwap({ fromTicker, toTicker, amountIn }) {
  const ux = engine();
  const from = v1Assets().find((a) => a.ticker === fromTicker);
  const to = v1Assets().find((a) => a.ticker === toTicker);
  if (!from || !to) throw new Error('unknown swap asset');
  const amt = BigInt(amountIn);
  let best = null;
  for (const feeBps of SWAP_FEE_TIERS) {
    try {
      const q = await ux.quoteRoute({ asset0: from.assetId, amountIn: amt, path: [{ assetNext: to.assetId, feeBps }] });
      if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = { feeBps, amountOut: q.amountOut, out: to };
    } catch { /* no pool at this tier */ }
  }
  return best; // { feeBps, amountOut, out } or null
}
// swap: pick a shielded note of fromTicker covering amountIn, route to toTicker at the best tier with slippage.
export async function swap({ fromTicker, toTicker, amountIn, slippageBps = 100, onProgress }) {
  const ux = engine(); const w = requireWallet();
  const from = v1Assets().find((a) => a.ticker === fromTicker);
  if (!from) throw new Error(`${fromTicker} is not a V1 asset`);
  const amt = BigInt(amountIn);
  const { byAsset } = await ux.balance(w.priv);
  const held = byAsset[String(from.assetId).toLowerCase()];
  if (!held || !held.notes.length) throw new Error(`No shielded ${fromTicker} — wrap ${fromTicker} into the pool first.`);
  const inNote = held.notes.find((n) => BigInt(n.value) >= amt)
    || held.notes.reduce((a, b) => (BigInt(b.value) > BigInt(a.value) ? b : a));
  if (BigInt(inNote.value) < amt) throw new Error(`Largest ${fromTicker} note (${inNote.value}) is smaller than ${amt}.`);
  const best = await quoteSwap({ fromTicker, toTicker, amountIn: amt });
  if (!best) throw new Error(`No pool routes ${fromTicker}→${toTicker}.`);
  const minOut = best.amountOut - (best.amountOut * BigInt(slippageBps)) / 10000n;
  return ux.route({ walletPriv: w.priv, inNote, amountIn: amt,
    path: [{ assetNext: best.out.assetId, feeBps: best.feeBps }], minOut, waitOpts: { onUpdate: onProgress } });
}

// Boot: set mainnet + expose the API for the mock's inline handlers (window.TacitV1.*). The mock's tab
// switching + design stay as-is; its buttons call these instead of the mock toasts.
export function bootV1({ network = 'mainnet' } = {}) {
  setActiveNetwork(network);
  const api = { V1_ASSETS, V1_TABS, v1Assets, poolReady, deploymentStatus, setWallet, hasWallet, wrap, send, swap, quoteSwap, balance, mintCbtc, engine, esc };
  if (typeof window !== 'undefined') window.TacitV1 = api;
  return api;
}

// ── Tab wiring — map the mock's design to real engine actions, tab by tab ──────────────────────────────
// Additive + defensive: reads the mock's existing inputs, gates on poolReady()+wallet, and confirms before
// any real-fund action. The mock's look + tab switching stay as-is; its primary CTA calls these instead of
// the toast. Wired now: wallet unlock + asset list + Send (one-tx wrap-and-send). Swap/Mint/Bridge follow
// the same shape (read inputs → TacitV1.<action> → status).
const $ = (id) => document.getElementById(id);
const activeTab = () => (document.querySelector('[data-tab].active')?.dataset.tab) || 'send';
// mock tickers → confidential asset tickers
const TICKER_MAP = { ETH: 'cETH', USDC: 'cUSDC', USDT: 'cUSDT', wstETH: 'cwstETH', BTC: 'cBTC', TAC: 'cTAC' };
const confTicker = (t) => TICKER_MAP[t] || (t?.startsWith('c') ? t : `c${t}`);

// Visible status line. The mock has no dedicated status element, so inject a fixed toast once and reuse it.
function setStatus(msg) {
  if (typeof document === 'undefined') return;
  let s = $('v1-status');
  if (!s) {
    s = document.createElement('div');
    s.id = 'v1-status';
    s.setAttribute('role', 'status');
    s.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:92vw;'
      + 'padding:10px 16px;border-radius:12px;background:rgba(20,20,24,.94);color:#eaeaea;font:13px/1.4 system-ui,sans-serif;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:9999;transition:opacity .25s;pointer-events:none;text-align:center';
    document.body.appendChild(s);
  }
  s.textContent = msg;
  s.style.opacity = '1';
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => { s.style.opacity = '0'; }, 6000);
}

// Wallet: minimal unlock (import a 32-byte hex key). The passkey/PRF wallet (tacit.js) is the follow-on
// (ported deterministic derivation, no external-wallet dependency — see the wallet-tab convergence note).
function wireWallet() {
  const opts = document.querySelectorAll('.wallet-option');
  opts.forEach((btn) => btn.addEventListener('click', async () => {
    const hex = window.prompt('Import your V1 key (32-byte hex) to unlock:');
    if (!hex) return;
    try {
      setWallet(hex.trim());
      const m = $('wallet-modal'); if (m) { m.setAttribute('aria-hidden', 'true'); m.classList.remove('open'); }
      const wb = $('wallet-button'); const lbl = wb?.querySelector('.wallet-button-label'); if (lbl) lbl.textContent = 'Connected';
      setStatus('Wallet unlocked — scanning shielded balance…');
      await renderBalance();
    } catch (e) { setStatus('Unlock failed: ' + e.message); }
  }));
}

// Scan + surface the wallet's real shielded balance (read-only). Updates the Send balance line + a status total.
async function renderBalance() {
  if (!hasWallet()) return;
  try {
    const { byAsset } = await balance();
    const lines = Object.values(byAsset)
      .map((h) => ({ ticker: h.ticker || String(h.asset).slice(0, 8), value: h.value, dec: v1Assets().find((a) => a.assetId?.toLowerCase() === String(h.asset).toLowerCase())?.decimals || 8 }))
      .filter((x) => x.value > 0n)
      .map((x) => `${(Number(x.value) / 10 ** x.dec).toLocaleString()} ${x.ticker}`);
    const bal = $('send-balance');
    const sel = $('send-asset')?.value;
    if (bal) {
      const cur = lines.find((l) => l.endsWith(confTicker(sel || 'ETH')));
      bal.textContent = cur ? `Balance ${cur}` : (lines.length ? `Balance ${lines[0]}` : 'Balance 0');
    }
    setStatus(lines.length ? `Shielded: ${lines.join(' · ')}` : 'No shielded notes yet — wrap to fund.');
  } catch (e) { setStatus('Balance scan failed: ' + e.message); }
}

function populateAssets() {
  const assets = v1Assets();
  if (!assets.length) return; // keep the mock's placeholder if the deployment isn't loaded
  const opts = assets.map((a) => `<option value="${esc(a.ticker)}">${esc(a.ticker)}</option>`).join('');
  for (const id of ['send-asset', 'swap-in-asset', 'swap-out-asset']) { const sel = $(id); if (sel) sel.innerHTML = opts; }
  const so = $('swap-out-asset'); if (so && so.options.length > 1) so.selectedIndex = 1; // default out ≠ in
}

// Live swap estimate — fills the read-only output box as the user types. Read-only, no wallet, no funds.
let _swapQuoteSeq = 0;
async function refreshSwapQuote() {
  const inSel = $('swap-in-asset'), outSel = $('swap-out-asset'), outBox = $('swap-out-amount');
  if (!inSel || !outSel || !outBox) return;
  const fromTicker = inSel.value, toTicker = outSel.value;
  const amtStr = ($('swap-in-amount')?.value || '').replace(/,/g, '').trim();
  if (fromTicker === toTicker) { outBox.value = '—'; return; }
  const from = v1Assets().find((a) => a.ticker === fromTicker); if (!from) return;
  let amountIn; try { amountIn = BigInt(Math.round(Number(amtStr) * 10 ** (from.decimals || 8))); } catch { return; }
  if (amountIn <= 0n) { outBox.value = '0'; return; }
  const seq = ++_swapQuoteSeq;
  outBox.value = '…';
  try {
    const best = await quoteSwap({ fromTicker, toTicker, amountIn });
    if (seq !== _swapQuoteSeq) return; // a newer keystroke superseded this quote
    outBox.value = best ? (Number(best.amountOut) / 10 ** (best.out.decimals || 8)).toLocaleString() : 'no route';
  } catch { if (seq === _swapQuoteSeq) outBox.value = 'no route'; }
}

// Swap dispatch — pick a shielded note fromTicker → route toTicker at the best tier (1% slippage). Real funds.
async function doSwap() {
  if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  const fromTicker = $('swap-in-asset')?.value, toTicker = $('swap-out-asset')?.value;
  if (!fromTicker || !toTicker || fromTicker === toTicker) return setStatus('Pick two different assets to swap.');
  const from = v1Assets().find((a) => a.ticker === fromTicker); if (!from) return setStatus(`${fromTicker} is not a V1 asset.`);
  const amtStr = ($('swap-in-amount')?.value || '').replace(/,/g, '').trim();
  let amountIn; try { amountIn = BigInt(Math.round(Number(amtStr) * 10 ** (from.decimals || 8))); } catch { return setStatus('Bad amount.'); }
  if (amountIn <= 0n) return setStatus('Enter a positive amount.');
  if (!window.confirm(`Swap ${amtStr} ${fromTicker} → ${toTicker} privately (real funds)?`)) return;
  setStatus('Routing + proving…');
  try {
    const r = await swap({ fromTicker, toTicker, amountIn, onProgress: (st) => setStatus(`swap ${st?.status || ''}…`) });
    setStatus(`Swapped ${amtStr} ${fromTicker} → ${toTicker}${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''} — output is a shielded note.`);
  } catch (e) { setStatus('Swap failed: ' + e.message); }
}

// Send dispatch — one-tx wrap-and-send from public balance (gasless relay). Recipient = a shielded pubkey
// hex (0x…, 33 bytes). tacit1 decoding is the follow-on (needs the tacit.js bech32 decoder).
async function doSend() {
  if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  const mockTicker = ($('send-asset')?.value) || 'ETH';
  const ticker = confTicker(mockTicker);
  const meta = v1Assets().find((a) => a.ticker === ticker);
  if (!meta) return setStatus(`${ticker} is not a registered V1 asset yet.`);
  const amtStr = ($('send-amount')?.value || '').trim();
  const recip = ($('send-recipient')?.value || '').trim();
  if (!/^0x[0-9a-fA-F]{66}$/.test(recip)) return setStatus('Recipient must be a shielded pubkey (0x… 33 bytes) for now; tacit1 decoding is next.');
  const dec = meta.decimals || 8;
  let amountWei; try { amountWei = BigInt(Math.round(Number(amtStr) * 10 ** dec)); } catch { return setStatus('Bad amount.'); }
  if (amountWei <= 0n) return setStatus('Enter a positive amount.');
  if (!window.confirm(`Send ${amtStr} ${ticker} privately to ${recip.slice(0, 12)}… (real funds)?`)) return;
  setStatus('Building + proving…');
  try {
    const r = await send({ ticker, recipientPubHex: recip, amountWei, amount: amountWei, onProgress: (st) => setStatus(`send ${st?.status || ''}…`) });
    setStatus(`Sent ${amtStr} ${ticker}${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''} — recipient recovers it from their key.`);
  } catch (e) { setStatus('Send failed: ' + e.message); }
}

function wirePrimaryAction() {
  const btn = $('primary-action'); if (!btn) return;
  btn.addEventListener('click', (e) => {
    const tab = activeTab();
    if (tab === 'send') { e.stopImmediatePropagation(); doSend(); }
    else if (tab === 'swap') { e.stopImmediatePropagation(); doSwap(); }
    else if (tab === 'liquidity') { e.stopImmediatePropagation(); setStatus('Pool add is being wired with ratio-matched note sizing — swap + send are live now.'); }
    else if (tab === 'mint') { e.stopImmediatePropagation(); setStatus('cBTC mint runs Bitcoin-lock → reflection → mint; it unlocks once reflection catch-up completes.'); }
    else if (tab === 'bridge') { e.stopImmediatePropagation(); setStatus('Bridging needs reflection live — unlocks once the catch-up is attested.'); }
  }, true); // capture: run before the mock's toast handler for the wired tabs
}

// Live swap estimate as the user edits amount or either asset picker.
function wireSwapQuote() {
  for (const id of ['swap-in-amount', 'swap-in-asset', 'swap-out-asset']) {
    const el = $(id); if (el) el.addEventListener(id === 'swap-in-amount' ? 'input' : 'change', refreshSwapQuote);
  }
}

function wireMockTabs() {
  try {
    wireWallet(); populateAssets(); wirePrimaryAction(); wireSwapQuote();
    const sa = $('send-asset'); if (sa) sa.addEventListener('change', () => { if (hasWallet()) renderBalance(); });
  } catch (e) { console.warn('[V1] wire error', e); }
}

if (typeof window !== 'undefined') {
  bootV1();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMockTabs);
  else wireMockTabs();
}
