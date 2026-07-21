// Converged V1 dapp bootstrap — turns launch-v1-mock/index.html from a static mock into the real dapp by
// loading the functional engine (the portable dapp/confidential-*.js modules) and mapping the mock's design
// to real engine ACTIONS. The mock keeps its look; this module supplies the behavior.
//
// STATUS: every day-1 tab wired to real mainnet engine actions (no honest-gates left).
//   Send  — confidential (shielded-first transfer / wrap-and-send) + native on-chain BTC.
//   Swap  — live pools, multi-hop via cETH, min-out + price impact.
//   Pool  — lpAdd (market-rate init + add).                                       [needs one box-settle test]
//   Mint  — cBTC: ① real BTC lock → ② reflection → ③ mint;  cUSD: openCdp (cBTC collateral → cUSD debt).
//           cUSD lifecycle: publish → tacUSD ERC20, close → release cBTC.          [cBTC lock: small-lock test]
//   Bridge— ETH→BTC crossOut (whole-holding burn → Bitcoin note after reflection). [needs one crossout test]
//   Wallet— passkey unlock + tacit1 / bc1 identities + UniSat/Xverse/Leather/OKX + real holdings.
// The three "needs test" ops are structurally complete + assemble/serialize/reach proving; the op TYPES all
// settled live on mainnet before — a small live settle confirms this dapp's op-shape parity (fails safe).
// Read paths (asset/deployment config) drive the UI. Nothing moves funds without an unlocked wallet + a confirm.
//
// Load note: these relative paths resolve against dapp/ (served same-origin). If launch-v1-mock/ ships as the
// root, copy or symlink dapp/ alongside so `../dapp/*` resolves (static import paths must be string literals).
import { secp, sha256, keccak_256, bytesToHex, hexToBytes, ripemd160, bech32 } from '../dapp/vendor/tacit-deps.min.js';
import { setActiveNetwork, activeNetwork, getConfidentialDeployment, confidentialPoolReady, esc } from '../dapp/confidential-deployments.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { prfRegister, prfLogin, prfTryRestore, isPasskeyAvailable, loadPrfMap, savePrfMap, prfBytesToScalar } from '../dapp/prf-wallet.js';
import { makeTacitAddress } from '../dapp/tacit-address.js';
import { makeCbtcLockMint } from '../dapp/cbtc-lock-mint.js';
import { makeEvmWallet } from '../dapp/evm-wallet.js';

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
  // A 20-byte EVM address can't own a shielded note (notes are owned by a 33-byte pubkey, which isn't
  // recoverable from an address). Tell the user to get the recipient's tacit1 address instead.
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error('That’s an Ethereum address — shielded notes are owned by a pubkey, not an address. Ask the recipient for their tacit1… address (it encodes their shielded pubkey).');
  throw new Error('Recipient must be a tacit1… address (or a raw 0x shielded pubkey, 66 hex).');
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

// External Ethereum wallet — onboarding (derive tacit1 identity) + funding (top up a tacit1 note from the
// connected EOA). One instance; discovery listeners wire at first use.
let _evm = null;
function evmWallet() {
  if (!_evm) _evm = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: activeNetwork() });
  return _evm;
}
// The connected external funder kept after onboarding: { address, label }. The provider lives inside _evm.
let _evmFunder = null;

// Onboard via an external Ethereum wallet: personal_sign → deterministic tacit1 identity, and keep the EOA
// as a funding source. Returns { address, pubHex, label }.
export async function connectEvm({ pick } = {}) {
  const r = await evmWallet().deriveIdentity({ pick });
  setWallet(r.priv);
  _evmFunder = { address: r.address, label: r.label };
  return { address: r.address, pubHex: r.pubHex, label: r.label };
}
export function evmFunder() { return _evmFunder; }
export function evmFunderReady() { return !!(_evmFunder && evmWallet().available()); }

// Top up a tacit1 note by funding the wrap from the connected external wallet (msg.value = ETH), instead of
// the tacit-derived EVM account. The minted cETH note is owned by the tacit1 identity (owner is in the wrap
// commit), so the external wallet never holds the note. Native-ETH wraps only for now (ERC20 needs approve).
export async function wrapExternal({ ticker = 'cETH', amountWei, onProgress } = {}) {
  const ux = engine(); const w = requireWallet();
  if (!_evmFunder) throw new Error('connect an Ethereum wallet first');
  const meta = v1Assets().find((a) => a.ticker === ticker);
  if (meta && meta.native === false && meta.ticker !== 'cETH') throw new Error(`external top-up currently supports native ETH → cETH; ${ticker} needs a token approval path`);
  // Pure wrap → OP_WRAP settle (the op that has a deployed prover, exec-wrap). Order: (1) build the deposit,
  // (2) the external wallet broadcasts pool.wrap() to escrow the ETH, (3) once mined, submit the OP_WRAP
  // witness to the relay → exec-wrap proves + settle() consumes the deposit into the note leaf.
  const built = ux.buildWrap({ walletPriv: w.priv, amountWei: BigInt(amountWei), ticker });
  onProgress?.({ status: 'confirm in your wallet' });
  const txHash = await evmWallet().fundTx({ from: _evmFunder.address, to: built.to, data: built.calldata, valueWei: BigInt(built.amount) });
  onProgress?.({ status: 'confirming on-chain', txHash });
  await waitForReceipt(txHash);
  onProgress?.({ status: 'proving wrap', txHash });
  const settled = await ux.submitWrapSettle({ built, waitOpts: { onUpdate: (st) => onProgress?.({ status: 'proving wrap', txHash, jobStatus: st?.status }) } });
  onProgress?.({ status: 'wrap confirmed', txHash });
  return { ...built, from: _evmFunder.address, txHash, settleTx: settled?.txHash };
}

// Poll a wrap/deposit tx to a mined receipt (the note only exists once the pool.wrap() tx is in a block).
async function waitForReceipt(txHash, { tries = 40, delayMs = 3000 } = {}) {
  const ux = engine();
  for (let i = 0; i < tries; i++) {
    try {
      const r = await ux.rpc('eth_getTransactionReceipt', [txHash]);
      if (r && r.blockNumber) {
        if (r.status != null && BigInt(r.status) === 0n) throw new Error('wrap transaction reverted on-chain');
        return r;
      }
    } catch (e) { if (/reverted/.test(e.message)) throw e; }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new Error('wrap not mined yet — it may still confirm; refresh balance in a moment');
}

// After a fresh wrap, the note appears once our windowed log scan reaches the mined block (public RPCs can
// lag the newest logs a block or two). Re-scan a few times until the note count grows.
async function pollForNote(priorCount = 0, { tries = 8, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const { byAsset } = await balance(); const n = Object.values(byAsset).reduce((s, h) => s + (h.notes?.length || 0), 0); if (n > priorCount) return n; } catch { /* keep polling */ }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
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
    .map((a) => ({ ticker: a.ticker, assetId: a.assetId, underlying: a.underlying, decimals: a.tacitDecimals, unitScale: a.unitScale || '1', underlyingDecimals: a.decimals, permitType: a.permitType || (a.native ? 'native' : a.permitName ? 'eip2612' : 'permit2'), live: !!a.live }));
}
// Convert a display amount (e.g. "0.001") to the pool's on-chain wrap amount: underlying wei that is a whole
// multiple of unitScale. tacitValue = amount × 10^tacitDecimals; amountWei = tacitValue × unitScale — aligned
// by construction (the buildWrap check `amountWei % unitScale === 0` always passes).
function amountToWei(meta, amtStr) {
  const tacitDec = meta.decimals; // v1Assets exposes tacitDecimals here
  const unitScale = BigInt(meta.unitScale || '1');
  const tacitValue = BigInt(Math.round(Number(amtStr) * 10 ** tacitDec));
  if (tacitValue <= 0n) throw new Error('Enter a positive amount');
  return tacitValue * unitScale;
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

// ── Smart Send router ───────────────────────────────────────────────────────────────────────────────
// One recipient box → the cheapest, most private route. The lane is read from the recipient string; the
// source is chosen from your shielded balance (notes first, else fund a wrap). classifyRecipient is sync
// (drives the live route preview); planSend is async (checks balance) and returns an execute() the Send
// button calls on confirm.
export function classifyRecipient(raw) {
  const s = String(raw || '').trim();
  if (!s) return { lane: null };
  if (/^tac(it|tt|rt)1/i.test(s)) return { lane: 'tacit1', label: 'tacit1 address', shielded: true };
  if (/^0x[0-9a-fA-F]{66}$/.test(s)) return { lane: 'tacit1', label: 'shielded pubkey', shielded: true };
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { lane: 'evm', label: 'Ethereum address', shielded: false, evmAddr: s };
  if (/^(bc1|tb1|bcrt1)[0-9ac-hj-np-z]{6,}$/i.test(s)) return { lane: 'btc', label: 'Bitcoin address', shielded: false, btcAddr: s };
  return { lane: null };
}

// Route preview from the recipient lane alone (no balance / no funds moved). balance-aware refinement
// (transfer vs wrap+settle) happens in planSend; this is the instant chip as the user types.
export function previewRoute(recipient, ticker = 'cETH') {
  const c = classifyRecipient(recipient); const t = confTicker(ticker);
  if (!c.lane) return { route: null, exitsShield: false, note: 'Enter a tacit1, 0x, or bc1 recipient.' };
  if (c.lane === 'tacit1') return { route: 'shielded send', exitsShield: false, note: `Private ${t} → recipient note. Fully shielded.` };
  if (c.lane === 'evm') return { route: 'private payout', exitsShield: true, note: 'Private sender, public payout to an Ethereum address.' };
  return { route: 'to Bitcoin', exitsShield: true, note: 'Bridges out to Bitcoin — use the Bridge tab.' };
}

// Balance-aware plan + execute(). tacit1 → shielded transfer (or wrap+settle); evm → unwrap-to-address
// (or wrap+payout); btc → directed to the Bridge tab (crossOut needs the bridge destination flow).
export async function planSend({ recipient, ticker = 'cETH', amount, amountWei }) {
  const ux = engine(); const w = requireWallet();
  const t = confTicker(ticker);
  const meta = v1Assets().find((a) => a.ticker === t);
  if (!meta) throw new Error(`${t} is not a V1 asset`);
  const amt = amountWei != null ? BigInt(amountWei) : amountToWei(meta, amount);
  if (amt <= 0n) throw new Error('Enter a positive amount');
  const c = classifyRecipient(recipient);
  if (!c.lane) throw new Error('Enter a tacit1 address, an 0x address, or a bc1 Bitcoin address.');

  const { byAsset } = await ux.balance(w.priv);
  const held = byAsset[String(meta.assetId).toLowerCase()];
  const notes = held?.notes?.length ? held.notes : null;
  const covers = notes && held.value >= amt;

  if (c.lane === 'tacit1') {
    const recipientPubHex = resolveRecipient(recipient);
    return {
      route: covers ? 'shielded transfer' : 'wrap + settle', exitsShield: false,
      plan: covers ? 'Spend an existing note → recipient note. Fully shielded.' : 'Wrap funds into a note, then settle privately to the recipient.',
      execute: (onProgress) => send({ ticker: t, recipientPubHex, amountWei: amt, amount: amt, onProgress }),
    };
  }
  if (c.lane === 'evm') {
    const single = covers ? [...notes].sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1)).find((n) => BigInt(n.value) >= amt) : null;
    return {
      route: single ? 'private payout' : 'wrap + payout', exitsShield: true,
      plan: `Pay ${t.replace(/^c/, '')} to ${c.evmAddr.slice(0, 8)}…${c.evmAddr.slice(-4)} — private sender, public payout (a relay fee is deducted from the note).`,
      execute: async (onProgress) => {
        let payNote = single;
        if (!payNote) {
          onProgress?.({ status: 'wrap' });
          await (evmFunderReady() ? wrapExternal({ ticker: t, amountWei: amt, onProgress }) : wrap({ ticker: t, amountWei: amt, onProgress }));
          const { byAsset: b2 } = await ux.balance(w.priv);
          payNote = b2[String(meta.assetId).toLowerCase()]?.notes?.sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1)).find((n) => BigInt(n.value) >= amt);
          if (!payNote) throw new Error('wrap settled but the fresh note is not scannable yet — retry in a moment');
        }
        return ux.unwrap({ note: payNote, walletPriv: w.priv, recipient: c.evmAddr, waitOpts: { onUpdate: onProgress } });
      },
    };
  }
  // btc: the send-to-Bitcoin path is the bridge (crossOut → Mode-B), which needs the Bridge tab's flow.
  throw new Error('To send to a Bitcoin address, use the Bridge tab — it routes your shielded note out to sats.');
}

// ── Guided cBTC (① self-custody Bitcoin lock → ② reflection → ③ mint) ──
// The cBTC.zk asset id (0x62a20d98…) — the lock envelope + the minted note commit to it.
function cbtcAssetId() {
  const cbtc = v1Assets().find((a) => a.ticker === 'cBTC');
  return cbtc?.assetId || cbtc?.underlying; // == bitcoinLink == CBTC_ZK_ASSET_ID on mainnet
}
// Pending-lock persistence: after ① the note isn't mintable until ② reflection records the lock (~1hr). Keep
// the lock's {lockTxid,lockVout,vBtc,blinding} so the user can come back and ③ mint.
const _PENDING_LOCK_KEY = 'tacit-v1-pending-cbtc-lock';
function savePendingLock(l) { try { localStorage.setItem(_PENDING_LOCK_KEY, JSON.stringify({ lockTxid: l.lockTxid, lockVout: l.lockVout, vBtc: String(l.vBtc), blinding: l.blinding })); } catch { /* ignore */ } }
function loadPendingLock() { try { return JSON.parse(localStorage.getItem(_PENDING_LOCK_KEY) || 'null'); } catch { return null; } }
function clearPendingLock() { try { localStorage.removeItem(_PENDING_LOCK_KEY); } catch { /* ignore */ } }
export { loadPendingLock };

// ① Lock: broadcast a REAL Bitcoin self-custody lock of `amountSats` from the wallet's bc1q → {lock details}.
export async function lockCbtc({ amountSats }) {
  const ux = engine(); const w = requireWallet();
  const asset = cbtcAssetId();
  if (!asset) throw new Error('cBTC asset not resolved on this network');
  const lm = makeCbtcLockMint({ priv: w.priv, pool: ux.pool, cbtcAsset: asset });
  const res = await lm.lock({ amountSats: BigInt(amountSats) });
  savePendingLock(res);
  return res;
}
// ③ Mint: open the cBTC bearer note 1:1 against the reflection-recorded lock. outpoint = keccak(txid‖voutLE).
export async function mintCbtc({ lockTxid, lockVout, vBtc, blinding, onProgress } = {}) {
  const ux = engine(); const w = requireWallet();
  const pending = (lockTxid && vBtc && blinding) ? { lockTxid, lockVout, vBtc, blinding } : loadPendingLock();
  if (!pending) throw new Error('no pending cBTC lock — lock BTC first');
  const outpoint = ux.pool.outpointKey(pending.lockTxid, pending.lockVout);
  const r = await ux.mintCbtc({ walletPriv: w.priv, outpoint, vBtc: BigInt(pending.vBtc), blinding: pending.blinding, waitOpts: { onUpdate: onProgress } });
  clearPendingLock();
  return r;
}
// balance: scan the wallet's shielded notes (the note-picker source shared by swap/liquidity/send-from-shielded).
export async function balance() { const ux = engine(); const w = requireWallet(); return ux.balance(w.priv); }

// ── Bridge: ETH→BTC crossOut (burn a confidential ETH note → mint a Bitcoin note after reflection) ──
// Whole-holding bridge (a bridge_burn has no ETH change): burns ALL notes of `ticker`, value → Bitcoin.
// destOwner defaults to the user's own owner (self-bridge); destBlinding is persisted so the Bitcoin note is
// recoverable. UNVERIFIED end-to-end — needs a small live crossOut proving the Bitcoin note mints.
export async function bridgeToBtc({ ticker, onProgress } = {}) {
  const ux = engine(); const w = requireWallet();
  const a = v1Assets().find((x) => x.ticker === ticker);
  if (!a) throw new Error(`${ticker} is not a V1 asset`);
  const { byAsset } = await ux.balance(w.priv);
  const held = byAsset[String(a.assetId).toLowerCase()];
  if (!held || !held.notes.length) throw new Error(`No shielded ${ticker} to bridge — wrap ${ticker} first.`);
  const r = await ux.crossOut({ walletPriv: w.priv, notes: held.notes, fee: 0n, waitOpts: { onUpdate: onProgress } });
  try {
    const all = JSON.parse(localStorage.getItem('tacit-v1-crossouts') || '[]');
    all.push({ ticker, amount: r.amount, destOwner: r.destOwner, destBlinding: r.destBlinding, crossOuts: r.crossOuts, at: Date.now() });
    localStorage.setItem('tacit-v1-crossouts', JSON.stringify(all));
  } catch { /* ignore */ }
  return r;
}
export function loadCrossOuts() { try { return JSON.parse(localStorage.getItem('tacit-v1-crossouts') || '[]'); } catch { return []; } }

// ── cUSD CDP (lock cBTC collateral → mint cUSD; publish → tacUSD; close reverses) ──
const _ZERO32 = '0x' + '00'.repeat(32);
function _rand32Hex() { const b = new Uint8Array(32); (globalThis.crypto || crypto).getRandomValues(b); return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
const _xOnly = (privHex) => '0x' + Array.from(secp.getPublicKey(Uint8Array.from(privHex.replace(/^0x/, '').match(/../g).map((h) => parseInt(h, 16))), true).slice(1), (x) => x.toString(16).padStart(2, '0')).join('');
// Persist the CDP position (fresh owner priv + basket) so the borrower can later closeCdp.
function _saveCdpPosition(p) { try { const all = JSON.parse(localStorage.getItem('tacit-v1-cdp-positions') || '[]'); all.push(p); localStorage.setItem('tacit-v1-cdp-positions', JSON.stringify(all)); } catch { /* ignore */ } }
export function loadCdpPositions() { try { return JSON.parse(localStorage.getItem('tacit-v1-cdp-positions') || '[]'); } catch { return []; } }

// Publish: convert a cUSD debt note → tacUSD public ERC20 at `recipient` (default: the borrower's EVM address).
// Unwrap is BEARER (opening sigma over the note blinding), so the borrower just spends the recovered cUSD note.
export async function publishCusd({ recipient, onProgress } = {}) {
  const ux = engine(); const w = requireWallet();
  const cusd = v1Assets().find((a) => a.ticker === 'cUSD');
  if (!cusd) throw new Error('cUSD not resolved');
  const { byAsset } = await ux.balance(w.priv);
  const held = byAsset[String(cusd.assetId).toLowerCase()];
  if (!held || !held.notes.length) throw new Error('No cUSD note to publish — mint cUSD first.');
  const note = held.notes.reduce((a, b) => (BigInt(b.value) > BigInt(a.value) ? b : a));
  const to = recipient || ux.account(w.priv).address;
  return ux.unwrap({ note, walletPriv: w.priv, recipient: to, waitOpts: { onUpdate: onProgress } });
}

// Close a CDP: burn cUSD debt notes → release the cBTC collateral (reverse of openCdp). Needs the saved
// position (fresh owner priv) + the on-chain position membership (cdpPositionTree).
export async function closeCusd({ onProgress } = {}) {
  const ux = engine(); const w = requireWallet(); const cdp = ux.cdp;
  const positions = loadCdpPositions();
  if (!positions.length) throw new Error('No open CDP position to close.');
  const p = positions[0];
  const controller = p.controller;
  const debtAsset = cdp.debtAssetId(controller);
  const debtValue = BigInt(p.debtValue);
  const sortedBasket = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
  const basketRootHex = cdp.basketRoot(sortedBasket.map((l) => cdp.basketLeg(l.asset, l.value)));
  const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRootHex, debtValue, p.rateSnapshot, p.positionOwner, p.nonce || _ZERO32);
  const posTree = await ux.cdpPositionTree();
  const positionIndex = posTree.indexOf(positionLeaf);
  if (positionIndex < 0) throw new Error('Position not found on-chain yet (still settling?).');
  const positionPath = posTree.pathFor(positionIndex).path;
  const { notes } = await ux.balance(w.priv);
  const debtNotes = []; let sum = 0n;
  for (const n of notes.filter((x) => x.asset.toLowerCase() === debtAsset.toLowerCase())) {
    debtNotes.push({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner });
    sum += BigInt(n.value); if (sum >= debtValue) break;
  }
  if (sum < debtValue) throw new Error(`Need ${debtValue} cUSD to repay; you hold ${sum}.`);
  const root = notes.find((x) => x.asset.toLowerCase() === debtAsset.toLowerCase()).root;
  const releaseBlindings = sortedBasket.map(() => _rand32Hex());
  const r = await ux.defiActions(w.priv).closeCdp({
    controller, debtValue, rateSnapshot: p.rateSnapshot, positionOwner: p.positionOwner, positionOwnerPriv: p.positionOwnerPriv,
    basket: sortedBasket, positionIndex, positionPath, spendRoot: root, cdpPositionRoot: posTree.root,
    fee: 0n, releaseBlindings, debtNotes, waitOpts: { onUpdate: onProgress },
  });
  try { localStorage.setItem('tacit-v1-cdp-positions', JSON.stringify(positions.filter((x) => x.positionOwner !== p.positionOwner))); } catch { /* ignore */ }
  return r;
}

// Open a CDP: lock ALL held cBTC notes as collateral → mint `debtValueCusd` (8-dec cUSD units) as a debt note.
// rateSnapshot=ZERO32 (fee-free v1 controller, RAY dormant). Keep it collateralized (~150%+) to avoid liquidation.
export async function openCusd({ debtValueCusd, onProgress } = {}) {
  const ux = engine(); const w = requireWallet();
  const controller = ux.cfg.collateralEngine;
  if (!controller) throw new Error('CDP not enabled on this network');
  const cbtc = v1Assets().find((a) => a.ticker === 'cBTC');
  if (!cbtc) throw new Error('cBTC not resolved');
  const { byAsset } = await ux.balance(w.priv);
  const held = byAsset[String(cbtc.assetId).toLowerCase()];
  if (!held || !held.notes.length) throw new Error('No cBTC notes to collateralize — mint cBTC first.');
  const collateral = held.notes.map((n) => ({ asset: n.asset, cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path }));
  const spendRoot = held.notes[0].root;
  const positionOwnerPriv = _rand32Hex();
  const positionOwner = _xOnly(positionOwnerPriv);
  const debtBlinding = _rand32Hex();
  const r = await ux.defiActions(w.priv).openCdp({ controller, debtValue: BigInt(debtValueCusd), rateSnapshot: _ZERO32, fee: 0n, collateral, spendRoot, debtBlinding, positionOwner, waitOpts: { onUpdate: onProgress } });
  _saveCdpPosition({ controller, debtValue: String(debtValueCusd), nonce: _ZERO32, positionOwner, positionOwnerPriv, rateSnapshot: _ZERO32, debtBlinding, basket: collateral.map((c) => ({ asset: c.asset, value: String(BigInt(c.value)) })) });
  return r;
}

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
  const api = { V1_ASSETS, V1_TABS, v1Assets, poolReady, deploymentStatus, setWallet, hasWallet, myTacitAddress, myBtcAddress, connectUnisat, connectSatsConnect, connectBtc, connectEvm, evmFunder, evmFunderReady, wrapExternal, btcExternal, btcSend, resolveRecipient, classifyRecipient, previewRoute, planSend, wrap, send, swap, quoteSwap, balance, addLiquidity, lockCbtc, mintCbtc, openCusd, publishCusd, closeCusd, loadCdpPositions, bridgeToBtc, loadCrossOuts, engine, esc };
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
// Block explorer for the active network (mainnet only surface for now).
function explorerTxUrl(txHash) { return `https://etherscan.io/tx/${txHash}`; }
// Status toast. Optional txHash appends a clickable Etherscan link (and keeps the toast up longer so it's
// usable). pointer-events re-enable when there's a link.
function setStatus(msg, txHash) {
  if (typeof document === 'undefined') return;
  let s = $('v1-status');
  if (!s) {
    s = document.createElement('div');
    s.id = 'v1-status';
    s.setAttribute('role', 'status');
    s.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:92vw;'
      + 'padding:10px 16px;border-radius:12px;background:rgba(20,20,24,.94);color:#eaeaea;font:13px/1.4 system-ui,sans-serif;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:9999;transition:opacity .25s;text-align:center';
    document.body.appendChild(s);
  }
  if (txHash) {
    s.innerHTML = `${esc(msg)} &nbsp;<a href="${explorerTxUrl(txHash)}" target="_blank" rel="noopener" style="color:#8fd0ff;text-decoration:underline">view tx ↗</a>`;
    s.style.pointerEvents = 'auto';
  } else {
    s.textContent = msg;
    s.style.pointerEvents = 'none';
  }
  s.style.opacity = '1';
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => { s.style.opacity = '0'; }, txHash ? 20000 : 6000);
}
// Current shielded note count (for detecting when a fresh wrap's note has settled).
async function noteCountNow() {
  try { const { byAsset } = await balance(); return Object.values(byAsset).reduce((s, h) => s + (h.notes?.length || 0), 0); } catch { return 0; }
}

// ── Progress overlay ────────────────────────────────────────────────────────────────────────────────
// A confirmation-of-activity modal for multi-step ops (prove → wallet → on-chain → settle) so the user is
// never staring at a frozen button. Steps light up as onProgress statuses arrive; an elapsed timer + optional
// tx link show it's alive even through the (slow) proving stage.
const progress = (() => {
  let el, timer, t0, stepEls = {};
  function ensure() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'v1-progress';
    el.style.cssText = 'position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;background:rgba(12,12,16,.55);backdrop-filter:blur(3px)';
    el.innerHTML = `<div style="background:#fbf7ee;color:#1a1a1e;border:3px solid #111;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.35);max-width:420px;width:92vw;padding:22px 24px;font:14px/1.5 system-ui,sans-serif">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div class="v1-spin" style="width:18px;height:18px;border:3px solid #d8cfbe;border-top-color:#e8792b;border-radius:50%;animation:v1spin 0.8s linear infinite"></div><strong id="v1-prog-title" style="font-size:16px">Working…</strong><span id="v1-prog-elapsed" style="margin-left:auto;font:12px ui-monospace,monospace;opacity:.6">0s</span></div>
      <div id="v1-prog-steps" style="margin:14px 0 6px"></div>
      <div id="v1-prog-foot" style="font-size:12px;opacity:.75;min-height:18px"></div>
      <button id="v1-prog-close" type="button" style="display:none;margin-top:14px;width:100%;padding:9px;border:2px solid #111;border-radius:10px;background:#111;color:#fff;font-weight:700;cursor:pointer">Done</button>
    </div>`;
    document.body.appendChild(el);
    const st = document.createElement('style'); st.textContent = '@keyframes v1spin{to{transform:rotate(360deg)}}'; document.head.appendChild(st);
    el.querySelector('#v1-prog-close').addEventListener('click', hide);
  }
  function renderSteps(steps, activeIdx, failedIdx) {
    const c = el.querySelector('#v1-prog-steps'); c.innerHTML = '';
    steps.forEach((s, i) => {
      const done = i < activeIdx, active = i === activeIdx, failed = i === failedIdx;
      const mark = failed ? '✕' : done ? '✓' : active ? '●' : '○';
      const col = failed ? '#c0392b' : done ? '#2e7d32' : active ? '#e8792b' : '#b9b0a0';
      const row = document.createElement('div');
      row.style.cssText = `display:flex;gap:9px;align-items:center;padding:3px 0;color:${active || failed ? '#1a1a1e' : done ? '#4a4a4a' : '#9a9284'}`;
      row.innerHTML = `<span style="color:${col};font-weight:700;width:14px;text-align:center">${mark}</span><span>${esc(s)}</span>`;
      c.appendChild(row);
    });
  }
  let _steps = [];
  function show(title, steps) {
    ensure(); _steps = steps; t0 = Date.now();
    el.querySelector('#v1-prog-title').textContent = title;
    el.querySelector('#v1-prog-foot').innerHTML = '';
    el.querySelector('#v1-prog-close').style.display = 'none';
    el.querySelector('.v1-spin').style.display = '';
    renderSteps(steps, 0, -1);
    el.style.display = 'flex';
    clearInterval(timer);
    timer = setInterval(() => { const s = el.querySelector('#v1-prog-elapsed'); if (s) s.textContent = `${Math.floor((Date.now() - t0) / 1000)}s`; }, 500);
  }
  function step(idx, footHtml) {
    if (!el) return; renderSteps(_steps, idx, -1);
    if (footHtml != null) el.querySelector('#v1-prog-foot').innerHTML = footHtml;
  }
  function foot(html) { if (el) el.querySelector('#v1-prog-foot').innerHTML = html; }
  function done(msg) {
    if (!el) return; clearInterval(timer);
    renderSteps(_steps, _steps.length, -1);
    el.querySelector('#v1-prog-title').textContent = 'Done';
    el.querySelector('.v1-spin').style.display = 'none';
    el.querySelector('#v1-prog-foot').innerHTML = esc(msg || 'Complete.');
    el.querySelector('#v1-prog-close').style.display = '';
  }
  function fail(idx, msg) {
    if (!el) return; clearInterval(timer);
    renderSteps(_steps, idx, idx);
    el.querySelector('#v1-prog-title').textContent = 'Failed';
    el.querySelector('.v1-spin').style.display = 'none';
    el.querySelector('#v1-prog-foot').innerHTML = `<span style="color:#c0392b">${esc(msg || 'Something went wrong.')}</span>`;
    el.querySelector('#v1-prog-close').style.display = '';
  }
  function hide() { if (el) { el.style.display = 'none'; clearInterval(timer); } }
  const txLink = (h) => h ? ` <a href="${explorerTxUrl(h)}" target="_blank" rel="noopener" style="color:#c46a12;text-decoration:underline">view tx ↗</a>` : '';
  return { show, step, foot, done, fail, hide, txLink };
})();

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
  // The inline mock already opens the wallet-option modal on the Connect button; app.js only owns the
  // real unlock behavior on the option rows below.
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
      // tacit1 row: unlock the identity directly from a 32-byte hex key (the raw tacit1 secret),
      // bypassing passkey so an existing identity (e.g. the pool-loop wallet) can be entered as-is.
      if (/tacit1/i.test(label)) {
        const hex = (window.prompt('Enter your tacit1 key (32-byte hex):') || '').trim().replace(/^0x/, '');
        if (!hex) throw new Error('cancelled');
        if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('expected 64 hex chars');
        setWallet(hex);
        closeWalletModal(); $('wallet-button')?.setAttribute('aria-expanded', 'false');
        const lbl = $('wallet-button')?.querySelector('.wallet-button-label'); if (lbl) lbl.textContent = 'Connected';
        setStatus('Wallet unlocked (tacit1 key) — scanning shielded balance…');
        await renderBalance();
        return;
      }
      // Ethereum wallet row: connect an external EOA (MetaMask/Rabby/Rainbow/Coinbase), personal_sign →
      // deterministic tacit1 identity, and keep the EOA as a funding source for top-ups.
      if (/EVM|ethereum/i.test(label)) {
        setStatus('Connecting Ethereum wallet — approve the signature to derive your tacit1 identity…');
        const r = await connectEvm({ pick: async (list) => list[0]?.uuid });
        closeWalletModal(); $('wallet-button')?.setAttribute('aria-expanded', 'false');
        const lbl = $('wallet-button')?.querySelector('.wallet-button-label'); if (lbl) lbl.textContent = 'Connected';
        setStatus(`${r.label} linked (0x${r.address.slice(0, 6)}…${r.address.slice(-4)}) → tacit1 identity derived — scanning…`);
        await renderBalance();
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
    // Neutralize the remaining mock header figures until USD pricing is wired: private value + linked lanes.
    const laneCount = (hasWallet() ? 1 : 0) + (evmFunderReady() ? 1 : 0);
    if (nt[2]) nt[2].textContent = `${laneCount} linked`;
    if (nt[0]) nt[0].textContent = noteCount ? '—' : '$0';
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
    renderCusdPanel(byAsset);
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
    // Only surface a positive shielded summary; the empty state is already visible in the holdings panel, so
    // don't re-nag "no notes" on every background refresh.
    if (lines.length) setStatus(`Shielded: ${lines.join(' · ')}`);
  } catch (e) { setStatus('Balance scan failed: ' + e.message); }
}

// cUSD position panel — injected into the wallet-view when the user holds a cUSD note or has an open CDP.
// Publish converts cUSD → tacUSD ERC20; Close burns cUSD to release the cBTC collateral.
function renderCusdPanel(byAsset) {
  const cusd = v1Assets().find((a) => a.ticker === 'cUSD');
  const cusdBal = cusd ? (byAsset[String(cusd.assetId).toLowerCase()]?.value || 0n) : 0n;
  const positions = loadCdpPositions();
  const card = document.querySelector('.wallet-address-card');
  let panel = document.getElementById('v1-cusd-panel');
  if (!(cusdBal > 0n || positions.length) || !card) { if (panel) panel.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'v1-cusd-panel';
    panel.style.cssText = 'margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.05);font:13px/1.6 system-ui,sans-serif';
    card.after(panel);
  }
  panel.innerHTML = '<div style="opacity:.6;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">cUSD position</div>'
    + (cusdBal > 0n ? `<div>Confidential <b>$${(Number(cusdBal) / 1e8).toLocaleString()} cUSD</b> <button id="v1-publish-cusd" class="mini-button" style="margin-left:6px">Publish → tacUSD</button></div>` : '')
    + (positions.length ? `<div style="margin-top:4px">${positions.length} open CDP · <button id="v1-close-cusd" class="mini-button">Close (release cBTC)</button></div>` : '');
  $('v1-publish-cusd')?.addEventListener('click', doPublishCusd);
  $('v1-close-cusd')?.addEventListener('click', doCloseCusd);
}

async function doPublishCusd() {
  if (!hasWallet()) return setStatus('Unlock a wallet first.');
  const to = (window.prompt('Publish cUSD → tacUSD ERC20 to which address? (blank = your own EVM address)', '') || '').trim();
  if (to && !/^0x[0-9a-fA-F]{40}$/.test(to)) return setStatus('Enter a valid 0x… address (or blank for your own).');
  if (!window.confirm('Publish your cUSD note to tacUSD public ERC20 (real funds)?')) return;
  setStatus('Publishing cUSD → tacUSD…');
  try {
    const r = await publishCusd({ recipient: to || undefined, onProgress: (st) => setStatus(`publish ${st?.status || ''}…`) });
    setStatus(`Published to tacUSD${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''}.`);
    renderBalance();
  } catch (e) { setStatus('Publish failed: ' + e.message); }
}

async function doCloseCusd() {
  if (!hasWallet()) return setStatus('Unlock a wallet first.');
  if (!window.confirm('Close your CDP — burn cUSD to release the cBTC collateral (real funds)?')) return;
  setStatus('Closing CDP…');
  try {
    const r = await closeCusd({ onProgress: (st) => setStatus(`close ${st?.status || ''}…`) });
    setStatus(`CDP closed${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''} — cBTC released.`);
    renderBalance();
  } catch (e) { setStatus('Close failed: ' + e.message); }
}

function populateAssets() {
  const assets = v1Assets();
  if (!assets.length) return; // keep the mock's placeholder if the deployment isn't loaded
  const confOpts = assets.map((a) => `<option value="${esc(a.ticker)}">${esc(a.ticker)}</option>`).join('');
  // Send also offers plain BTC (native sats) — a standard on-chain Bitcoin send via the connected external
  // wallet, distinct from cBTC (the confidential pool asset). Swap stays pool-only.
  const sendSel = $('send-asset'); if (sendSel) sendSel.innerHTML = confOpts + '<option value="BTC">BTC · on-chain</option>';
  for (const id of ['swap-in-asset', 'swap-out-asset', 'liq-asset-a', 'liq-asset-b', 'bridge-source-asset']) { const sel = $(id); if (sel) sel.innerHTML = confOpts; }
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
  const recipRaw = ($('send-recipient')?.value || '').trim();
  // A bc1 recipient with a confidential asset selected = send-to-Bitcoin (bridge), not a native BTC send.
  if (/^(bc1|tb1|bcrt1)/i.test(recipRaw) && btcExternal()) return doBtcSend();
  if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  const ticker = confTicker(($('send-asset')?.value) || 'ETH');
  const amtStr = ($('send-amount')?.value || '').trim();
  let plan; try { plan = await planSend({ recipient: recipRaw, ticker, amount: amtStr }); } catch (e) { return setStatus(e.message); }
  const warn = plan.exitsShield ? '\n\n⚠ This exits the shield — the payout to the recipient is public.' : '';
  if (!window.confirm(`${plan.route}: send ${amtStr} ${ticker} to ${recipRaw.slice(0, 16)}… (real funds)?\n\n${plan.plan}${warn}`)) return;
  setStatus(`${plan.route} — building + proving…`);
  try {
    const r = await plan.execute((st) => setStatus(`${plan.route} ${st?.status || ''}…`));
    setStatus(`${plan.route} done${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''}.`);
    await renderBalance();
  } catch (e) { setStatus('Send failed: ' + e.message); }
}

// Live route preview: as the recipient/amount changes, show the lane-based route + an exits-shield badge in
// the route line + send chips (no funds, no balance scan — that refinement happens at submit).
function refreshSendRoute() {
  const recip = ($('send-recipient')?.value || '').trim();
  const ticker = confTicker(($('send-asset')?.value) || 'ETH');
  const pv = previewRoute(recip, ticker);
  const rs = $('route-summary');
  if (rs) rs.innerHTML = pv.route ? `<b>Route:</b> ${esc(pv.note)}` : `<b>Route:</b> ${esc(pv.note)}`;
  const chips = $('send-chips');
  if (chips && pv.route) {
    chips.innerHTML = `<span class="chip dark">${esc(pv.route)}</span>`
      + (pv.exitsShield ? `<span class="chip" style="background:#f6d47a;color:#4a3500">exits shield</span>` : `<span class="chip good">fully shielded</span>`);
  }
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

// Guided cBTC Mint dispatch — two phase. If a lock is pending, ③ mint it (needs reflection to have recorded
// it, ~1hr post-lock). Otherwise ① lock the BTC amount (a REAL Bitcoin tx from the wallet's bc1q).
async function doMintCbtc() {
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  const route = document.querySelector('.mint-route.active')?.dataset.mintRoute || 'cBTC';
  if (route === 'cUSD') return doOpenCusd();
  const pending = loadPendingLock();
  if (pending) {
    const btc = Number(pending.vBtc) / 1e8;
    if (!window.confirm(`Mint cBTC from your lock ${String(pending.lockTxid).slice(0, 12)}… (${btc} BTC)? Reflection must have recorded it (~1hr after the lock confirmed).`)) return;
    setStatus('Minting cBTC…');
    try {
      const r = await mintCbtc({ onProgress: (st) => setStatus(`mint ${st?.status || ''}…`) });
      setStatus(`cBTC minted${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''} — bearer note recovered from your key.`);
      if (hasWallet()) renderBalance();
    } catch (e) { setStatus('Mint failed (lock may not be reflected yet — wait ~1hr): ' + e.message); }
    return;
  }
  const amtBtc = Number(($('mint-primary-amount')?.value || '').trim());
  if (!(amtBtc > 0)) return setStatus('Enter a BTC amount to lock.');
  const sats = Math.round(amtBtc * 1e8);
  if (!window.confirm(`Lock ${amtBtc} BTC (${sats} sats) to mint cBTC?\n\nThis broadcasts a REAL Bitcoin tx from your bc1q wallet (must be funded). After ~1hr (reflection records the lock), return to Mint to complete.`)) return;
  setStatus('Broadcasting Bitcoin lock…');
  try {
    const res = await lockCbtc({ amountSats: sats });
    setStatus(`Locked ${amtBtc} BTC (tx ${String(res.lockTxid).slice(0, 12)}…). Reflection records it in ~1hr — return to Mint to complete ③.`);
  } catch (e) { setStatus('Lock failed: ' + e.message); }
}

// Bridge dispatch — burn the whole confidential holding of the selected asset → Bitcoin (crossOut). The
// Bitcoin note mints after reflection (~1hr); the user recovers it from their key (destBlinding persisted).
async function doBridge() {
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
  const ticker = $('bridge-source-asset')?.value || 'cETH';
  if (!window.confirm(`Bridge your entire ${ticker} holding to Bitcoin?\n\nThis burns it on Ethereum; the matching Bitcoin note mints after reflection (~1hr). Whole-note bridge (no partial amounts yet). Real funds.`)) return;
  setStatus('Bridging to Bitcoin…');
  try {
    const r = await bridgeToBtc({ ticker, onProgress: (st) => setStatus(`bridge ${st?.status || ''}…`) });
    setStatus(`Bridged ${ticker} → Bitcoin${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''}. Bitcoin note mints after reflection (~1hr) — recover it from your key.`);
    if (hasWallet()) renderBalance();
  } catch (e) { setStatus('Bridge failed: ' + e.message); }
}

// cUSD CDP dispatch — lock the held cBTC as collateral → mint cUSD (mint-primary-amount = the $ cUSD to mint).
async function doOpenCusd() {
  if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
  if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
  const usd = Number(($('mint-primary-amount')?.value || '').trim());
  if (!(usd > 0)) return setStatus('Enter a cUSD amount to mint.');
  const debtValue = Math.round(usd * 1e8); // cUSD is 8-dec
  if (!window.confirm(`Mint $${usd} cUSD against your cBTC collateral?\n\nThis locks your cBTC notes into a CDP — keep it ~150%+ collateralized or it can be liquidated. Real funds.`)) return;
  setStatus('Opening CDP + minting cUSD…');
  try {
    const r = await openCusd({ debtValueCusd: debtValue, onProgress: (st) => setStatus(`cusd ${st?.status || ''}…`) });
    setStatus(`Minted $${usd} cUSD${r?.txHash ? ' (' + String(r.txHash).slice(0, 12) + '…)' : ''} — a confidential debt note (publish → tacUSD next).`);
    if (hasWallet()) renderBalance();
  } catch (e) { setStatus('cUSD mint failed: ' + e.message); }
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
  let ok = false;
  try { await fn(); ok = true; }
  finally {
    _busy = false;
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = btn.dataset.prevText || prevText || 'Confirm'; btn.style.opacity = ''; }
    // Re-scan after a completed op — the note set changed, so holdings/balance were stale. Best-effort.
    if (ok && hasWallet()) { try { await renderBalance(); } catch { /* ignore */ } }
  }
}

function wirePrimaryAction() {
  const btn = $('primary-action'); if (!btn) return;
  btn.addEventListener('click', (e) => {
    const tab = activeTab();
    if (tab === 'send') { e.stopImmediatePropagation(); runGuarded(doSend); }
    else if (tab === 'swap') { e.stopImmediatePropagation(); runGuarded(doSwap); }
    else if (tab === 'liquidity') { e.stopImmediatePropagation(); runGuarded(doAddLiquidity); }
    else if (tab === 'mint') { e.stopImmediatePropagation(); runGuarded(doMintCbtc); }
    else if (tab === 'bridge') { e.stopImmediatePropagation(); runGuarded(doBridge); }
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
      refreshSendRoute();
    });
    // Live smart-route preview as the recipient/amount change.
    $('send-recipient')?.addEventListener('input', refreshSendRoute);
    $('send-amount')?.addEventListener('input', refreshSendRoute);
    refreshSendRoute();
    // Holdings-panel per-asset actions (delegated so it survives balance re-renders).
    document.addEventListener('click', (e) => {
      // Top up = wrap-and-send-to-self: fund your own tacit1 note. Prefers the connected external wallet
      // (private, no pre-funding an address); falls back to the derived EVM account.
      const topBtn = e.target.closest('[data-wallet-action="topup"]');
      if (topBtn) {
        e.stopPropagation(); // capture-phase: preempt the mock's per-button handler (it would jump tabs)
        if (!poolReady()) return setStatus('Confidential pool not live on this network yet.');
        if (!hasWallet()) return setStatus('Unlock a wallet first (Connect wallet).');
        const asset = topBtn.getAttribute('data-wallet-asset') || 'ETH';
        const ticker = confTicker(asset);
        const meta = v1Assets().find((a) => a.ticker === ticker);
        if (!meta) return setStatus(`${ticker} is not a registered V1 asset yet.`);
        const via = evmFunderReady() ? 'your connected wallet' : 'your account';
        const amtStr = (window.prompt(`Top up how much ${asset}? Funds your private ${ticker} from ${via}.`, '0.01') || '').trim();
        if (!amtStr) return;
        let amountWei; try { amountWei = amountToWei(meta, amtStr); } catch (err) { return setStatus(err.message); }
        runGuarded(async () => {
          const priorCount = await noteCountNow();
          // Map wrapExternal's onProgress statuses to overlay steps.
          const STEPS = ['Confirm the deposit in your wallet', 'Confirming the deposit on-chain', 'Proving the private wrap (zero-knowledge)', 'Settling your private note'];
          const STEP_OF = { 'confirm in your wallet': 0, 'confirming on-chain': 1, 'proving wrap': 2, 'wrap confirmed': 3, 'building wrap': 0 };
          progress.show(`Top up ${amtStr} ${asset}`, STEPS);
          progress.foot('After you confirm the deposit, proving can take a minute or two — you can leave this open.');
          try {
            const doWrap = evmFunderReady() ? wrapExternal : wrap;
            const r = await doWrap({ ticker, amountWei, onProgress: (st) => {
              const i = STEP_OF[st?.status]; if (i != null) progress.step(i, st?.txHash ? `Submitted.${progress.txLink(st.txHash)}` : (i === 0 ? 'Proving can take a couple of minutes — you can leave this open.' : null));
            } });
            progress.step(3, `Deposit confirmed — waiting for your ${ticker} note to settle…${progress.txLink(r?.txHash)}`);
            const n = await pollForNote(priorCount);
            await renderBalance();
            if (n != null) { progress.done(`Topped up ${amtStr} ${ticker} — now in your private balance.`); setStatus(`Topped up ${amtStr} ${ticker}.`, r?.txHash); }
            else { progress.done(`Deposit is on-chain; your note is still settling and will appear shortly.`); }
          } catch (err) {
            const failStep = /wallet|rejected|denied|user/i.test(err.message) ? 0 : /timed out|box|prove|settle/i.test(err.message) ? 2 : 1;
            progress.fail(failStep, err.message);
            setStatus('Top up failed: ' + err.message);
          }
        });
        return;
      }
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
        e.stopPropagation();
        if (!hasWallet()) return setStatus('Unlock a wallet first.');
        const asset = recvBtn.getAttribute('data-wallet-asset');
        try { const addr = asset === 'BTC' ? myBtcAddress() : myTacitAddress(); navigator.clipboard?.writeText(addr); setStatus(`Receive address copied: ${addr.slice(0, 16)}…`); }
        catch (err) { setStatus('Address unavailable: ' + err.message); }
      }
    }, true);
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
  window.__V1_BOOTED = true;
}
