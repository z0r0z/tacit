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
import { secp, sha256, keccak_256, bytesToHex, ripemd160, bech32 } from '../dapp/vendor/tacit-deps.min.js';
import { setActiveNetwork, activeNetwork, getConfidentialDeployment, confidentialPoolReady, esc } from '../dapp/confidential-deployments.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { prfRegister, prfLogin, prfTryRestore, isPasskeyAvailable, loadPrfMap, savePrfMap } from '../dapp/prf-wallet.js';
import { makeTacitAddress } from '../dapp/tacit-address.js';

// ── Unified Tacit address (tacit1…) — one handle, both lanes ──
// Derived deterministically from the one wallet key: BTC spend pubkey, BIP-352 scan pubkey (tagged-hash of
// the spend key), and the EVM confidential-note owner pubkey (== the compressed wallet pubkey). No new key
// material, no pool dependency. decodeTacitAddress resolves a Send recipient's EVM lane.
const { encodeTacitAddress, decodeTacitAddress } = makeTacitAddress({ secp });
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const _enc = new TextEncoder();
function _taggedHash(tag, msg) {
  const t = sha256(_enc.encode(tag));
  const m = new Uint8Array(t.length * 2 + msg.length);
  m.set(t, 0); m.set(t, t.length); m.set(msg, t.length * 2);
  return sha256(m);
}
function _scanPriv(spendPriv) {
  const h = _taggedHash('BIP0352/ScanKey', spendPriv);
  let n = 0n; for (const b of h) n = (n << 8n) | BigInt(b);
  n %= SECP_N; if (n === 0n) throw new Error('scan key derived as zero');
  const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}
export function myTacitAddress(network = activeNetwork()) {
  const w = requireWallet();
  const btcSpendPub = secp.getPublicKey(w.priv, true);
  const btcScanPub = secp.getPublicKey(_scanPriv(w.priv), true);
  return encodeTacitAddress({ network, btcSpendPub, btcScanPub, evmOwnerPub: btcSpendPub });
}
// Internal BTC wallet — the self-custody P2WPKH (bc1q…) funding/receive address derived from the same key
// (identical to tacit.js's p2wpkhAddress). This is the receive side; the tx/sign/UTXO/broadcast layer for
// cBTC-lock lives in the tacit.js monolith and is a separate extraction (and reflection-gated).
const _hash160 = (b) => ripemd160(sha256(b));
export function myBtcAddress() {
  const w = requireWallet();
  const pub = secp.getPublicKey(w.priv, true);
  return bech32.encode('bc', [0, ...bech32.toWords(_hash160(pub))]);
}

// ── External BTC wallet (UniSat) ──
// Dependency-free: talks to the injected window.unisat directly (no vendored bundle, unlike sats-connect for
// Xverse/Leather/OKX — those are the follow-on). Lets a user fund/send BTC from their own wallet for the
// cBTC-lock / bridge flows. Mainnet-only guard (UniSat 'livenet').
let _btcExt = null; // { provider:'unisat', address, pubHex }
export function btcExternal() { return _btcExt; }
export async function connectUnisat() {
  if (typeof window === 'undefined' || !window.unisat) throw new Error('UniSat not detected — install the UniSat extension.');
  const net = await window.unisat.getNetwork();
  if (net !== 'livenet') throw new Error(`UniSat is on "${net}" — switch it to livenet (mainnet) and retry.`);
  const accounts = await window.unisat.requestAccounts();
  const address = accounts && accounts[0];
  if (!address) throw new Error('UniSat returned no account.');
  let pubHex = null; try { pubHex = await window.unisat.getPublicKey(); } catch { /* optional */ }
  _btcExt = { provider: 'unisat', address, pubHex };
  try { window.unisat.on('accountsChanged', (a) => { _btcExt = (a && a[0]) ? { ..._btcExt, address: a[0] } : null; }); } catch { /* older UniSat */ }
  return _btcExt;
}
// sats-connect (Xverse / Leather / OKX) — the bundle is vendored + lazy-loaded (233KB), so it only costs a
// user who actually connects one of these wallets. Mirrors tacit.js's ensureSatsConnect / getAccounts flow.
let _satsMod = null, _satsLoadP = null;
function ensureSatsConnect() {
  if (_satsMod) return Promise.resolve(_satsMod);
  if (!_satsLoadP) {
    _satsLoadP = import('../dapp/vendor/tacit-satsconnect.min.js').then((m) => {
      if (!m?.satsConnect || typeof m.satsConnect.request !== 'function') throw new Error('sats-connect bundle malformed');
      _satsMod = m.satsConnect; return _satsMod;
    }).catch((e) => { _satsLoadP = null; throw e; });
  }
  return _satsLoadP;
}
function _satsConnectProviderPresent() {
  if (typeof window === 'undefined') return false;
  try {
    if (Array.isArray(window.btc_providers) && window.btc_providers.length > 0) return true;
    if (window.XverseProviders?.BitcoinProvider) return true;
    if (window.LeatherProvider) return true;
  } catch { /* ignore */ }
  return false;
}
export async function connectSatsConnect() {
  const SatsConnect = await ensureSatsConnect();
  const resp = await SatsConnect.request('getAccounts', {
    purposes: ['payment', 'ordinals'],
    message: 'Tacit needs your wallet address to fund confidential operations',
  });
  if (resp?.status !== 'success' || !Array.isArray(resp.result) || !resp.result.length) throw new Error('sats-connect getAccounts failed');
  const acct = resp.result.find((a) => a.purpose === 'payment') || resp.result[0];
  let network = acct.network || resp.result[0].network || null;
  if (!network) {
    try { const n = await SatsConnect.request('wallet_getNetwork', null); network = n?.result?.bitcoin?.name ?? n?.result?.name ?? n?.result ?? null; } catch { /* fall through */ }
  }
  if (!network && typeof acct.address === 'string' && acct.address.toLowerCase().startsWith('bc1')) network = 'mainnet';
  if (network && !/^main(net)?$/i.test(String(network))) throw new Error(`Wallet is on "${network}" — switch to mainnet and retry.`);
  _btcExt = { provider: 'sats-connect', address: acct.address, pubHex: acct.publicKey || null };
  return _btcExt;
}
// Unified connect: UniSat if injected, else a sats-connect provider (Xverse/Leather/OKX) if present.
export async function connectBtc() {
  if (typeof window !== 'undefined' && window.unisat) return connectUnisat();
  if (_satsConnectProviderPresent()) return connectSatsConnect();
  throw new Error('No Bitcoin wallet detected — install UniSat, Xverse, or Leather.');
}
// Send BTC from the connected external wallet. amountSats is an integer satoshi amount. Returns the txid.
export async function btcSend(toAddress, amountSats) {
  if (!_btcExt) throw new Error('Connect a Bitcoin wallet first.');
  if (_btcExt.provider === 'unisat') return window.unisat.sendBitcoin(String(toAddress), Number(amountSats));
  if (_btcExt.provider === 'sats-connect') {
    const SatsConnect = await ensureSatsConnect();
    const resp = await SatsConnect.request('sendTransfer', { recipients: [{ address: String(toAddress), amount: Number(amountSats) }] });
    if (resp?.status !== 'success') throw new Error('sendTransfer failed');
    return resp.result?.txid;
  }
  throw new Error('Unsupported BTC provider.');
}
// Resolve a Send recipient string → 0x-compressed shielded pubkey. Accepts a unified Tacit address
// (tacit1…, via its EVM lane) or a raw 0x-compressed pubkey. Throws with a user-facing message.
export function resolveRecipient(raw) {
  const s = String(raw || '').trim();
  if (/^tac(it|tt|rt)1/i.test(s)) {
    const d = decodeTacitAddress(s);
    if (!d.lanes.evm) throw new Error('This Tacit address carries no Ethereum lane.');
    return '0x' + bytesToHex(d.lanes.evm.ownerPub);
  }
  if (/^0x[0-9a-fA-F]{66}$/.test(s)) return s;
  throw new Error('Recipient must be a tacit1… address or an 0x… shielded pubkey.');
}

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
  const amt = BigInt(amount ?? amountWei);
  const f = BigInt(fee);
  // Prefer a pure shielded transfer when existing notes already cover amount+fee: cheaper and more private
  // (no public wrap event exposing the underlying deposit). Fall back to one-tx wrap-and-send otherwise.
  try {
    const assetId = v1Assets().find((a) => a.ticker === ticker)?.assetId;
    if (assetId) {
      const { byAsset } = await ux.balance(w.priv);
      const held = byAsset[String(assetId).toLowerCase()];
      if (held && held.value >= amt + f && held.notes.length) {
        const sorted = [...held.notes].sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
        const picked = []; let sum = 0n;
        for (const n of sorted) { picked.push(n); sum += BigInt(n.value); if (sum >= amt + f) break; }
        onProgress?.({ status: 'shielded transfer' });
        return ux.transfer({ walletPriv: w.priv, notes: picked, recipientPubHex, amount: amt, fee: f, waitOpts: { onUpdate: onProgress } });
      }
    }
  } catch { /* fall through to wrap-and-send */ }
  onProgress?.({ status: 'wrap + send' });
  return ux.wrapAndSend({ walletPriv: w.priv, ticker, recipientPubHex, amountWei, amount, fee, waitOpts: { onUpdate: onProgress } });
}
// mint cBTC from a reflection-recorded self-custody lock (③ of the Get-cBTC flow). Needs reflection live.
export async function mintCbtc({ outpoint, vBtc, blinding, onProgress }) {
  const ux = engine(); requireWallet();
  if (typeof ux.mintCbtc !== 'function') throw new Error('mintCbtc not exposed by this engine build');
  return ux.mintCbtc({ outpoint, vBtc, blinding, waitOpts: { onUpdate: onProgress } });
}
// balance: scan the wallet's shielded notes (the note-picker source shared by swap/liquidity/send-from-shielded).
export async function balance() { const ux = engine(); const w = requireWallet(); return ux.balance(w.priv); }

// addLiquidity / pool-init — plain OP_LP_ADD (farm-optional). Spends the provider's largest note of each
// asset (whole-note); first add to an empty pool sets the price at the two notes' ratio, so init at the market
// rate by sizing the notes accordingly (the Pool tab prefills the counter amount from live feeds).
export async function addLiquidity({ aTicker, bTicker, feeBps = 30, onProgress }) {
  const ux = engine(); const w = requireWallet();
  const a = v1Assets().find((x) => x.ticker === aTicker), b = v1Assets().find((x) => x.ticker === bTicker);
  if (!a || !b) throw new Error('unknown LP asset');
  if (String(a.assetId).toLowerCase() === String(b.assetId).toLowerCase()) throw new Error('pick two different assets');
  const { byAsset } = await ux.balance(w.priv);
  const ha = byAsset[String(a.assetId).toLowerCase()], hb = byAsset[String(b.assetId).toLowerCase()];
  if (!ha || !ha.notes.length) throw new Error(`No shielded ${aTicker} note — wrap ${aTicker} first.`);
  if (!hb || !hb.notes.length) throw new Error(`No shielded ${bTicker} note — wrap ${bTicker} first.`);
  const largest = (arr) => arr.reduce((p, c) => (BigInt(c.value) > BigInt(p.value) ? c : p));
  return ux.lpAdd({ walletPriv: w.priv, aNote: largest(ha.notes), bNote: largest(hb.notes), feeBps, waitOpts: { onUpdate: onProgress } });
}

// Fee tiers tried when routing a swap — highest-liquidity first (matches confidential-swap-tab planBestRoute).
const SWAP_FEE_TIERS = [30n, 5n, 100n, 1n];
const HUB_FEE_TIERS = [30n, 5n]; // bounded set for the 2-hop hub fallback (keeps live quotes snappy)
const HUB_TICKER = 'cETH';       // the routing hub — most pools pair against cETH
const SWAP_SLIPPAGE_BPS = 100n;  // default 1% slippage tolerance (min-out)
// quoteSwap: best route fromTicker→toTicker for amountIn (underlying-decimals). Tries every direct fee tier,
// then a 2-hop path via the cETH hub when no direct pool exists. Read-only, no wallet.
export async function quoteSwap({ fromTicker, toTicker, amountIn }) {
  const ux = engine();
  const assets = v1Assets();
  const from = assets.find((a) => a.ticker === fromTicker);
  const to = assets.find((a) => a.ticker === toTicker);
  if (!from || !to) throw new Error('unknown swap asset');
  const amt = BigInt(amountIn);
  let best = null;
  const tryPath = async (path) => {
    try {
      const q = await ux.quoteRoute({ asset0: from.assetId, amountIn: amt, path });
      if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = { amountOut: q.amountOut, out: to, path };
    } catch { /* no pool for this path */ }
  };
  for (const feeBps of SWAP_FEE_TIERS) await tryPath([{ assetNext: to.assetId, feeBps }]);
  if (!best) {
    const hub = assets.find((a) => a.ticker === HUB_TICKER);
    if (hub && from.ticker !== HUB_TICKER && to.ticker !== HUB_TICKER) {
      for (const f1 of HUB_FEE_TIERS) for (const f2 of HUB_FEE_TIERS)
        await tryPath([{ assetNext: hub.assetId, feeBps: f1 }, { assetNext: to.assetId, feeBps: f2 }]);
    }
  }
  // Price impact for a direct route: 1 − (out·reserveIn)/(in·reserveOut), decimal-agnostic (raw pool units).
  if (best && best.path.length === 1) {
    try {
      const feeBps = best.path[0].feeBps;
      const r = await ux.poolReserves(ux.routePoolId(from.assetId, to.assetId, feeBps));
      if (r) {
        const fromIsA = BigInt(from.assetId) < BigInt(to.assetId);
        const rIn = fromIsA ? BigInt(r.reserveA) : BigInt(r.reserveB);
        const rOut = fromIsA ? BigInt(r.reserveB) : BigInt(r.reserveA);
        const den = amt * rOut;
        if (den > 0n) best.impactBps = Number(10000n - (best.amountOut * rIn * 10000n) / den);
        best.feeBps = Number(feeBps);
      }
    } catch { /* impact optional */ }
  } else if (best) { best.multiHop = true; }
  return best; // { amountOut, out, path, impactBps?, feeBps?, multiHop? } or null
}
// swap: pick a shielded note of fromTicker covering amountIn, route to toTicker along the best path with slippage.
export async function swap({ fromTicker, toTicker, amountIn, slippageBps = Number(SWAP_SLIPPAGE_BPS), onProgress }) {
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
  return ux.route({ walletPriv: w.priv, inNote, amountIn: amt, path: best.path, minOut, waitOpts: { onUpdate: onProgress } });
}

// Boot: set mainnet + expose the API for the mock's inline handlers (window.TacitV1.*). The mock's tab
// switching + design stay as-is; its buttons call these instead of the mock toasts.
export function bootV1({ network = 'mainnet' } = {}) {
  setActiveNetwork(network);
  const api = { V1_ASSETS, V1_TABS, v1Assets, poolReady, deploymentStatus, setWallet, hasWallet, myTacitAddress, myBtcAddress, connectUnisat, connectSatsConnect, connectBtc, btcExternal, btcSend, resolveRecipient, wrap, send, swap, quoteSwap, balance, addLiquidity, mintCbtc, engine, esc };
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

// Wallet unlock. Prefers a passkey (WebAuthn PRF → deterministic priv, no raw-key handling); the same key
// derives the tacit1 / BTC / EVM identities. Falls back to a raw-hex import for dev / non-WebAuthn contexts.
// One Tacit identity backs all three wallet-option rows in the mock, so every row runs the same unlock.
async function unlockWallet() {
  if (isPasskeyAvailable()) {
    const restore = prfTryRestore();
    if (restore?.credentialId) {
      const r = await prfLogin({ credentialId: restore.credentialId });
      setWallet(r.priv);
      const map = loadPrfMap(); if (map[restore.label]) { map[restore.label].lastUsed = Date.now(); savePrfMap(map); }
      return { via: 'passkey', pubHex: r.pubHex };
    }
    const label = (window.prompt('Name this passkey wallet:', 'tacit') || 'tacit').trim();
    const r = await prfRegister(label);
    const map = loadPrfMap(); map[label] = { credentialId: r.credentialId, pubkey: r.pubHex, lastUsed: Date.now() }; savePrfMap(map);
    setWallet(r.priv);
    return { via: 'passkey (new)', pubHex: r.pubHex };
  }
  const hex = window.prompt('Import your V1 key (32-byte hex) to unlock:');
  if (!hex) throw new Error('cancelled');
  setWallet(hex.trim());
  return { via: 'imported key' };
}

function closeWalletModal() { const m = $('wallet-modal'); if (m) { m.setAttribute('aria-hidden', 'true'); m.classList.remove('open'); } }

function wireWallet() {
  const opts = document.querySelectorAll('.wallet-option');
  opts.forEach((btn) => btn.addEventListener('click', async () => {
    const label = btn.getAttribute('data-wallet-label') || '';
    try {
      // "Bitcoin wallet" row connects an external BTC wallet (UniSat, else Xverse/Leather/OKX) when one is
      // present; otherwise falls back to the passkey-derived internal BTC identity (the bc1q address).
      const hasExtBtc = typeof window !== 'undefined' && (window.unisat || _satsConnectProviderPresent());
      if (/BTC/i.test(label) && hasExtBtc) {
        setStatus('Connecting Bitcoin wallet…');
        const ext = await connectBtc();
        closeWalletModal();
        setStatus(`${ext.provider === 'unisat' ? 'UniSat' : 'Bitcoin wallet'} connected: ${ext.address.slice(0, 10)}…${ext.address.slice(-6)}`);
        return;
      }
      setStatus('Unlocking…');
      const res = await unlockWallet();
      closeWalletModal();
      const lbl = $('wallet-button')?.querySelector('.wallet-button-label'); if (lbl) lbl.textContent = 'Connected';
      setStatus(`Wallet unlocked (${res.via}) — scanning shielded balance…`);
      await renderBalance();
    } catch (e) { if (String(e.message) !== 'cancelled') setStatus('Connect failed: ' + e.message); }
  }));
}

// Scan + surface the wallet's real shielded balance (read-only). Updates the Send balance line + a status total.
async function renderBalance() {
  if (!hasWallet()) return;
  try {
    // Own tacit1 identity in the wallet-view card (deterministic from the key).
    try {
      const addr = myTacitAddress();
      const addrEl = document.querySelector('.wallet-address'); if (addrEl) { addrEl.textContent = addr; addrEl.title = addr; }
      const lane = $('send-recipient-lane'); if (lane) lane.textContent = 'tacit1 universal';
      // Internal BTC funding address (bc1q…) as a secondary line in the receive card.
      const btc = myBtcAddress();
      let btcEl = document.getElementById('v1-btc-address');
      if (!btcEl && addrEl) {
        btcEl = document.createElement('div');
        btcEl.id = 'v1-btc-address';
        btcEl.style.cssText = 'margin-top:6px;font:12px/1.4 ui-monospace,monospace;opacity:.72;word-break:break-all;cursor:pointer';
        btcEl.title = 'Your Bitcoin funding address (self-custody) — click to copy';
        btcEl.addEventListener('click', async () => { try { await navigator.clipboard.writeText(myBtcAddress()); setStatus('Bitcoin address copied.'); } catch {} });
        addrEl.after(btcEl);
      }
      if (btcEl) btcEl.textContent = '₿ ' + btc;
    } catch { /* address derivation needs the key; ignore pre-unlock */ }
    const { byAsset } = await balance();
    const noteCount = Object.values(byAsset).reduce((s, h) => s + (h.notes?.length || 0), 0);
    const nt = document.querySelectorAll('.wallet-total strong');
    if (nt[1]) nt[1].textContent = `${noteCount} live`;
    // Real balances into the holdings panel: match each row's asset name to a scanned confidential holding.
    const byTicker = {};
    for (const h of Object.values(byAsset)) {
      const dec = v1Assets().find((a) => a.assetId?.toLowerCase() === String(h.asset).toLowerCase())?.decimals || 8;
      if (h.ticker) byTicker[h.ticker] = Number(h.value) / 10 ** dec;
    }
    document.querySelectorAll('.holding-row').forEach((row) => {
      const name = row.querySelector('.holding-name')?.textContent?.trim();
      const strong = row.querySelector('.holding-balance strong');
      if (!name || !strong) return;
      if (Object.prototype.hasOwnProperty.call(byTicker, name)) {
        strong.textContent = byTicker[name].toLocaleString(undefined, { maximumFractionDigits: 8 });
        row.style.opacity = byTicker[name] > 0 ? '1' : '0.5';
      } else if (name.startsWith('c')) {
        strong.textContent = '0'; row.style.opacity = '0.5'; // a confidential asset we scanned but hold none of
      }
    });
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
  const confOpts = assets.map((a) => `<option value="${esc(a.ticker)}">${esc(a.ticker)}</option>`).join('');
  // Send also offers plain BTC (native sats) — a standard on-chain Bitcoin send via the connected external
  // wallet, distinct from cBTC (the confidential pool asset). Swap stays pool-only.
  const sendSel = $('send-asset'); if (sendSel) sendSel.innerHTML = confOpts + '<option value="BTC">BTC · on-chain</option>';
  for (const id of ['swap-in-asset', 'swap-out-asset', 'liq-asset-a', 'liq-asset-b']) { const sel = $(id); if (sel) sel.innerHTML = confOpts; }
  const so = $('swap-out-asset'); if (so && so.options.length > 1) so.selectedIndex = 1; // default out ≠ in
  // Pool defaults: asset-a = first day-1 asset, asset-b = cETH (the hub every pair backs against).
  const lb = $('liq-asset-b'); if (lb) { const eth = [...lb.options].find((o) => o.value === 'cETH'); if (eth) lb.value = 'cETH'; }
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
  const minChip = $('swap-minout'), impChip = $('swap-impact');
  try {
    const best = await quoteSwap({ fromTicker, toTicker, amountIn });
    if (seq !== _swapQuoteSeq) return; // a newer keystroke superseded this quote
    if (!best) {
      outBox.value = 'no route';
      if (minChip) minChip.textContent = 'min out'; if (impChip) { impChip.textContent = 'impact —'; impChip.className = 'chip'; }
      return;
    }
    const outDec = best.out.decimals || 8;
    outBox.value = (Number(best.amountOut) / 10 ** outDec).toLocaleString();
    // min-out at the default 1% slippage
    if (minChip) {
      const minOut = best.amountOut - (best.amountOut * BigInt(SWAP_SLIPPAGE_BPS)) / 10000n;
      minChip.textContent = `min ${(Number(minOut) / 10 ** outDec).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toTicker}`;
    }
    if (impChip) {
      if (best.multiHop) { impChip.textContent = `multi-hop · via ${HUB_TICKER}`; impChip.className = 'chip'; }
      else if (typeof best.impactBps === 'number') {
        const pct = Math.max(0, best.impactBps) / 100;
        impChip.textContent = `impact ${pct.toFixed(pct < 1 ? 2 : 1)}%`;
        impChip.className = 'chip ' + (best.impactBps < 100 ? 'good' : best.impactBps < 500 ? '' : 'warn');
      } else { impChip.textContent = 'impact —'; impChip.className = 'chip'; }
    }
  } catch { if (seq === _swapQuoteSeq) { outBox.value = 'no route'; if (impChip) impChip.textContent = 'impact —'; } }
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
// Standard on-chain BTC send (native sats) through the connected external wallet — same one-field Send UX,
// but the recipient is a bc1… address and it leaves the confidential pool entirely. Silent-payment sends are
// Tacit-native (internal signer) and stay gated; this covers the plain-BTC half now.
async function doBtcSend() {
  const ext = btcExternal();
  if (!ext) return setStatus('Connect a Bitcoin wallet (UniSat / Xverse / Leather) to send BTC.');
  const recip = ($('send-recipient')?.value || '').trim();
  if (!/^bc1[0-9a-z]{20,}$/i.test(recip)) {
    if (/^tac(it|tt|rt)1/i.test(recip) || /^sp1/i.test(recip))
      return setStatus('Silent-payment sends are Tacit-native (internal signer, queued) — standard BTC sends go to a bc1… address.');
    return setStatus('Enter a bc1… Bitcoin address for a standard on-chain BTC send.');
  }
  const amtStr = ($('send-amount')?.value || '').trim();
  let sats; try { sats = Math.round(Number(amtStr) * 1e8); } catch { return setStatus('Bad amount.'); }
  if (!(sats > 0)) return setStatus('Enter a positive BTC amount.');
  if (!window.confirm(`Send ${amtStr} BTC to ${recip.slice(0, 14)}… from your ${ext.provider} wallet (real funds)?`)) return;
  setStatus('Requesting signature from your Bitcoin wallet…');
  try {
    const txid = await btcSend(recip, sats);
    setStatus(`BTC send broadcast${txid ? ' (' + String(txid).slice(0, 12) + '…)' : ''}.`);
  } catch (e) { setStatus('BTC send failed: ' + e.message); }
}

async function doSend() {
  if (($('send-asset')?.value) === 'BTC') return doBtcSend(); // native sats → external wallet
  if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  const mockTicker = ($('send-asset')?.value) || 'ETH';
  const ticker = confTicker(mockTicker);
  const meta = v1Assets().find((a) => a.ticker === ticker);
  if (!meta) return setStatus(`${ticker} is not a registered V1 asset yet.`);
  const amtStr = ($('send-amount')?.value || '').trim();
  let recipientPubHex; try { recipientPubHex = resolveRecipient($('send-recipient')?.value); } catch (e) { return setStatus(e.message); }
  const dec = meta.decimals || 8;
  let amountWei; try { amountWei = BigInt(Math.round(Number(amtStr) * 10 ** dec)); } catch { return setStatus('Bad amount.'); }
  if (amountWei <= 0n) return setStatus('Enter a positive amount.');
  const recipLabel = ($('send-recipient')?.value || '').trim();
  if (!window.confirm(`Send ${amtStr} ${ticker} privately to ${recipLabel.slice(0, 16)}… (real funds)?`)) return;
  setStatus('Building + proving…');
  try {
    const r = await send({ ticker, recipientPubHex, amountWei, amount: amountWei, onProgress: (st) => setStatus(`send ${st?.status || ''}…`) });
    setStatus(`Sent ${amtStr} ${ticker}${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''} — recipient recovers it from their key.`);
  } catch (e) { setStatus('Send failed: ' + e.message); }
}

// ── Pool tab: live market-rate prefill + add-liquidity dispatch ──
// Cached USD prices (keyless Coinbase spot) for the empty-pool init rate; existing pools prefill from reserves.
let _usdPx = null, _usdPxAt = 0;
async function usdPrices() {
  if (_usdPx && (Date.now() - _usdPxAt) < 60000) return _usdPx;
  const spot = async (p) => { try { const r = await fetch(`https://api.coinbase.com/v2/prices/${p}/spot`); return Number((await r.json()).data.amount); } catch { return null; } };
  const [eth, btc] = await Promise.all([spot('ETH-USD'), spot('BTC-USD')]);
  _usdPx = { cETH: eth, cUSDC: 1, cUSDT: 1, cUSD: 1, cBTC: btc, cwstETH: eth ? eth * 1.24 : null, cTAC: null };
  _usdPxAt = Date.now();
  return _usdPx;
}
// b-per-a market price from live USD feeds (null if either side has no feed — e.g. cTAC).
async function marketPrice(aTicker, bTicker) { const p = await usdPrices(); const pa = p[aTicker], pb = p[bTicker]; return (pa && pb) ? pa / pb : null; }

let _liqSeq = 0;
async function refreshLiqPrefill() {
  const aT = $('liq-asset-a')?.value, bT = $('liq-asset-b')?.value, outB = $('liq-amount-b');
  if (!outB || !aT || !bT) return;
  if (aT === bT) { outB.value = '—'; return; }
  const a = v1Assets().find((x) => x.ticker === aT), b = v1Assets().find((x) => x.ticker === bT);
  if (!a || !b) return;
  const amtA = Number(($('liq-amount-a')?.value || '').replace(/,/g, ''));
  if (!(amtA > 0)) { outB.value = ''; return; }
  const seq = ++_liqSeq; outB.value = '…';
  const ux = engine();
  try {
    const res = await ux.poolReserves(ux.routePoolId(a.assetId, b.assetId, 30n));
    if (seq !== _liqSeq) return;
    if (res && BigInt(res.reserveA) > 0n) {
      const aIsCanonA = BigInt(a.assetId) < BigInt(b.assetId);
      const rA = BigInt(aIsCanonA ? res.reserveA : res.reserveB), rB = BigInt(aIsCanonA ? res.reserveB : res.reserveA);
      const amtBUnits = (BigInt(Math.round(amtA * 10 ** (a.decimals || 8))) * rB) / rA;
      outB.value = (Number(amtBUnits) / 10 ** (b.decimals || 8)).toLocaleString(undefined, { maximumFractionDigits: 8 }) + '  (ratio)';
    } else {
      const px = await marketPrice(aT, bT);
      if (seq !== _liqSeq) return;
      outB.value = px == null ? 'set both (no feed)' : (amtA * px).toLocaleString(undefined, { maximumFractionDigits: 8 }) + '  (market init)';
    }
  } catch { if (seq === _liqSeq) outB.value = ''; }
}

async function doAddLiquidity() {
  if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  const aT = $('liq-asset-a')?.value, bT = $('liq-asset-b')?.value;
  if (!aT || !bT || aT === bT) return setStatus('Pick two different assets to pool.');
  if (!window.confirm(`Add liquidity to ${aT}/${bT}? This spends your full ${aT} and ${bT} notes; the first add to an empty pool sets the price at their ratio. Real funds.`)) return;
  setStatus('Adding liquidity + proving…');
  try {
    const r = await addLiquidity({ aTicker: aT, bTicker: bT, onProgress: (st) => setStatus(`lp ${st?.status || ''}…`) });
    setStatus(`${r?.firstMint ? 'Pool initialized' : 'Liquidity added'} — LP note minted${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''}.`);
  } catch (e) { setStatus('Add liquidity failed: ' + e.message); }
}

// In-flight guard: a confidential op proves + settles over seconds-to-minutes. Block a second dispatch
// while one is running (no double-submit / double-spend), and reflect "proving" on the CTA. The do* handlers
// own their own try/catch + status; this only manages the busy state + button affordance.
let _busy = false;
async function runGuarded(fn) {
  if (_busy) { setStatus('An action is already in progress — hold on.'); return; }
  _busy = true;
  const btn = $('primary-action');
  const prevText = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.dataset.prevText = prevText || ''; btn.textContent = 'Proving…'; btn.style.opacity = '0.65'; }
  try { await fn(); }
  finally {
    _busy = false;
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = btn.dataset.prevText || prevText || 'Confirm'; btn.style.opacity = ''; }
  }
}

function wirePrimaryAction() {
  const btn = $('primary-action'); if (!btn) return;
  btn.addEventListener('click', (e) => {
    const tab = activeTab();
    if (tab === 'send') { e.stopImmediatePropagation(); runGuarded(doSend); }
    else if (tab === 'swap') { e.stopImmediatePropagation(); runGuarded(doSwap); }
    else if (tab === 'liquidity') { e.stopImmediatePropagation(); runGuarded(doAddLiquidity); }
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

// Create/etch surface: Bitcoin-native etch is an upcoming feature. Keep it VISIBLE (greyed "coming soon")
// rather than removing it, and make "Create draft" tell the truth instead of faking a ready draft. The whole
// Bitcoin-side asset-issuance/orderbook subsystem lives in the production tacit.js, not this launch dapp.
function wireCreateSurface() {
  const etched = document.querySelector('[data-create-mode="etched"]');
  if (etched && !etched.querySelector('.v1-soon')) {
    etched.style.opacity = '0.6';
    const badge = document.createElement('span');
    badge.className = 'v1-soon';
    badge.textContent = 'coming soon';
    badge.style.cssText = 'display:block;font-size:10px;letter-spacing:.04em;text-transform:uppercase;opacity:.85;margin-top:3px';
    etched.appendChild(badge);
  }
  const draft = $('create-draft');
  if (draft) draft.addEventListener('click', (e) => {
    e.stopImmediatePropagation(); // capture: pre-empt the mock's fake "draft ready" toast
    const mode = document.querySelector('.create-mode.active')?.dataset.createMode || 'etched';
    setStatus(mode === 'etched'
      ? 'Bitcoin-native etch is an upcoming feature — asset creation on Bitcoin lands post-launch.'
      : mode === 'bridge'
        ? 'Bridge-wrapper asset creation is coming after launch.'
        : 'Factory asset creation is coming after launch.');
    const cm = $('create-modal'); if (cm) { cm.classList.remove('open'); cm.setAttribute('aria-hidden', 'true'); }
  }, true);
}

// Live LP counter-amount prefill as the user edits the deposit amount or either pool asset.
function wireLiqPrefill() {
  for (const id of ['liq-amount-a', 'liq-asset-a', 'liq-asset-b']) {
    const el = $(id); if (el) el.addEventListener(id === 'liq-amount-a' ? 'input' : 'change', refreshLiqPrefill);
  }
}

function wireMockTabs() {
  try {
    wireWallet(); populateAssets(); wirePrimaryAction(); wireSwapQuote(); wireLiqPrefill(); wireCreateSurface();
    const sa = $('send-asset'); if (sa) sa.addEventListener('change', () => {
      const lane = $('send-recipient-lane'); const bal = $('send-balance');
      if (sa.value === 'BTC') {
        if (lane) lane.textContent = 'on-chain · bc1…';
        const ext = btcExternal();
        if (bal) bal.textContent = ext ? `via ${ext.provider} ${ext.address.slice(0, 8)}…` : 'connect a Bitcoin wallet';
      } else {
        if (lane) lane.textContent = 'tacit1 universal';
        if (hasWallet()) renderBalance();
      }
    });
    // Holdings-panel per-asset actions (delegated so it survives balance re-renders).
    document.addEventListener('click', (e) => {
      const sendBtn = e.target.closest('[data-wallet-action="send"]');
      if (sendBtn) {
        const asset = sendBtn.getAttribute('data-wallet-asset');
        document.querySelector('[data-tab="send"]')?.click();
        const sel = $('send-asset');
        if (sel && asset) {
          const want = [...sel.options].find((o) => o.value === asset || o.value === confTicker(asset) || o.value.replace(/^c/, '') === asset);
          if (want) { sel.value = want.value; sel.dispatchEvent(new Event('change')); }
        }
        return;
      }
      const recvBtn = e.target.closest('[data-wallet-action="receive"]');
      if (recvBtn) {
        if (!hasWallet()) return setStatus('Unlock a wallet first.');
        const asset = recvBtn.getAttribute('data-wallet-asset');
        try { const addr = asset === 'BTC' ? myBtcAddress() : myTacitAddress(); navigator.clipboard?.writeText(addr); setStatus(`Receive address copied: ${addr.slice(0, 16)}…`); }
        catch (err) { setStatus('Address unavailable: ' + err.message); }
      }
    });
    const cp = document.querySelector('[data-wallet-action="copy-address"]');
    if (cp) cp.addEventListener('click', async () => {
      if (!hasWallet()) return setStatus('Unlock a wallet first.');
      try { await navigator.clipboard.writeText(myTacitAddress()); setStatus('Tacit address copied.'); }
      catch (e) { setStatus('Copy failed: ' + e.message); }
    });
  } catch (e) { console.warn('[V1] wire error', e); }
}

if (typeof window !== 'undefined') {
  bootV1();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMockTabs);
  else wireMockTabs();
}
