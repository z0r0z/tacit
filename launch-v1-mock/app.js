// Converged V1 dapp bootstrap — turns launch-v1-mock/index.html from a static mock into the real dapp by
// loading the functional engine (the portable dapp/confidential-*.js modules) and mapping the mock's design
// to real engine ACTIONS. The mock keeps its look; this module supplies the behavior.
//
// STATUS: convergence scaffold. Wired now (SAFE, no funds): engine load + active network + the real V1
// asset/deployment config surfaced to the UI. Structured + gated (careful per-tab work): the fund actions
// (wrap/send/swap/mint/bridge) map to the engine but require a wallet + are wired tab-by-tab against the real
// modules. Nothing here moves funds until a tab handler is explicitly wired + a wallet is unlocked.
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
// swap / addLiquidity / bridge: same shape — map the tab's inputs to ux.route / ux.buildLpBondOp / the
// cross-lane action, gated on poolReady() + a wallet. Wired per-tab in the convergence pass.

// Boot: set mainnet + expose the API for the mock's inline handlers (window.TacitV1.*). The mock's tab
// switching + design stay as-is; its buttons call these instead of the mock toasts.
export function bootV1({ network = 'mainnet' } = {}) {
  setActiveNetwork(network);
  const api = { V1_ASSETS, V1_TABS, v1Assets, poolReady, deploymentStatus, setWallet, hasWallet, wrap, send, mintCbtc, engine, esc };
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

function setStatus(msg) { const s = $('send-status') || $('primary-status'); if (s) s.textContent = msg; else console.log('[V1]', msg); }

// Wallet: minimal unlock (import a 32-byte hex key). The passkey/PRF wallet (tacit.js) is the follow-on.
function wireWallet() {
  const opts = document.querySelectorAll('.wallet-option');
  opts.forEach((btn) => btn.addEventListener('click', () => {
    const hex = window.prompt('Import your V1 key (32-byte hex) to unlock:');
    if (!hex) return;
    try { setWallet(hex.trim()); setStatus('Wallet unlocked.'); const m = $('wallet-modal'); if (m) m.setAttribute('aria-hidden', 'true'); }
    catch (e) { setStatus('Unlock failed: ' + e.message); }
  }));
}

function populateAssets() {
  const sel = $('send-asset'); if (!sel) return;
  const assets = v1Assets();
  if (!assets.length) return; // keep the mock's placeholder if the deployment isn't loaded
  sel.innerHTML = assets.map((a) => `<option value="${esc(a.ticker)}">${esc(a.ticker)}</option>`).join('');
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
    // swap/liquidity/mint/bridge: same pattern → dispatch to TacitV1.<action> once each tab's inputs are mapped.
  }, true); // capture: run before the mock's toast handler for the send tab
}

function wireMockTabs() {
  try { wireWallet(); populateAssets(); wirePrimaryAction(); } catch (e) { console.warn('[V1] wire error', e); }
}

if (typeof window !== 'undefined') {
  bootV1();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMockTabs);
  else wireMockTabs();
}
