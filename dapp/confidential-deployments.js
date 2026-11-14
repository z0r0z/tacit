import { sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { ETH_NODES, ETH_LOG_NODES } from './eth-nodes.js';

const SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://1rpc.io/sepolia',
  'https://sepolia.drpc.org',
  'https://sepolia.gateway.tenderly.co',
];
const MAINNET_RPCS = ETH_NODES;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
const TAC_ASSET_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const CBTC_ASSET_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
const MAINNET_TAC_POOL_ASSET_ID = TAC_ASSET_ID;
const MAINNET_CBTC_POOL_ASSET_ID = CBTC_ASSET_ID;

function _hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function _addrBytes(addr) {
  const s = String(addr || '').replace(/^0x/, '').padStart(40, '0');
  if (!/^[0-9a-fA-F]{40}$/.test(s)) throw new Error('bad EVM address');
  return Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
}

function _utf8(s) {
  return new TextEncoder().encode(String(s));
}

function _concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function nativeEvmAssetId(chainId, underlying = '0x0000000000000000000000000000000000000000') {
  const tag = new TextEncoder().encode('tacit-evm-token-v1');
  const b = new Uint8Array(46);
  b.set(tag, 0);
  new DataView(b.buffer).setBigUint64(18, BigInt(chainId), false);
  b.set(_addrBytes(underlying), 26);
  return '0x' + _hex(sha256(b));
}

function cdpDebtAssetId(collateralEngine) {
  if (!collateralEngine) return null;
  return '0x' + _hex(keccak_256(_concat(_utf8('tacit-cdp-debt-v1'), _addrBytes(collateralEngine))));
}

const EXTERNAL_ERC20_MAINNET = [
  { ticker: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { ticker: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  { ticker: 'wstETH', address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18 },
];
const EXTERNAL_ERC20_SEPOLIA = [
  { ticker: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 },
];

function day1ConfidentialAssets(cEthId, cEthScale, tethBitcoinLink, tacBitcoinLink) {
  return [
    { ticker: 'cETH', assetId: cEthId, bitcoinLink: tethBitcoinLink || null, underlying: '0x0000000000000000000000000000000000000000', unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: true, live: false,
      description: 'Confidential ETH in the Tacit pool. Wrap ETH → cETH; bridges to Bitcoin (tETH) and back.', imageUri: 'ipfs://bafkreid55b3c2w6swyjl3lec66a23subiolwwsd6tof2wticoj6d7vnv4i' },
    { ticker: 'cTAC', assetId: null, bitcoinLink: tacBitcoinLink || null, underlying: null, unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: false, live: false,
      description: 'Confidential TAC — the Tacit protocol token, shielded in the pool.' },
    { ticker: 'cBTC', assetId: null, bitcoinLink: CBTC_ASSET_ID, underlying: null, unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: false, live: false,
      description: 'Confidential Bitcoin minted 1:1 from SP1-reflected Bitcoin locks, with a slashable wstETH escrow per lock.', imageUri: 'ipfs://bafkreifqbhoqbnho2d22bpy5s2qfsnc5ta3uxktvg4q4xn2zumxsweserq' },
    { ticker: 'cUSD', assetId: null, underlying: null, unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: false, live: false,
      description: 'Confidential USD — a cBTC-collateralized stablecoin (CDP).' },
  ];
}

const EXTERNAL_WRAP_META = {
  USDC: { ticker: 'cUSDC', tacitDecimals: 6, permitType: 'eip2612', permitName: 'USD Coin', permitVersion: '2',
    description: 'Confidential USDC in the Tacit pool.' },
  USDT: { ticker: 'cUSDT', tacitDecimals: 6, permitType: 'permit2',
    description: 'Confidential USDT in the Tacit pool. Tether has no EIP-2612 permit, so wraps route through Permit2 (or a one-time approval).' },
  WSTETH: { ticker: 'cwstETH', tacitDecimals: 8, unitScale: '10000000000', permitType: 'eip2612',
    permitName: 'Wrapped liquid staked Ether 2.0', permitVersion: '1',
    description: 'Confidential wstETH (Lido wrapped staked ETH) in the Tacit pool.' },
};

function registeredExternalPoolAssets(d) {
  const out = [];
  if (!d || d.chainId !== 1) return out;
  const enabled = new Set((d._externalTickers || []).map((t) => String(t).toUpperCase()));
  for (const t of (d.externalErc20 || [])) {
    if (!enabled.has(String(t.ticker || '').toUpperCase())) continue;
    const m = EXTERNAL_WRAP_META[String(t.ticker || '').toUpperCase()];
    if (!m) continue;
    out.push({
      ticker: m.ticker,
      assetId: nativeEvmAssetId(d.chainId, t.address),
      underlying: t.address,
      unitScale: m.unitScale || '1',
      decimals: t.decimals,
      tacitDecimals: m.tacitDecimals,
      native: false,
      live: false,
      permitType: m.permitType,
      ...(m.permitName ? { permitName: m.permitName, permitVersion: m.permitVersion } : {}),
      description: m.description,
    });
  }
  return out;
}

const MAINNET_FARM = {
  manager: '0x000031C47Cb61faB1CE2790a69625FABB71EDE24',
  rewardAsset: '0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832',
  rewardToken: '0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf',
  tac: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279',
  funder: '0x7fc40b13c7a99a1d2c41f8b5382978363d18525a',
  unitScale: '10000000000',
  rewardDecimals: 18,
  pools: [
    { pid: 0, pair: 'TAC/cETH', poolId: '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00', lpAsset: '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99', feeBps: 30, allocPoint: 50, lockSeconds: 0 },
    { pid: 1, pair: 'cETH/cUSD', poolId: '0x5925c0c2954c5b11bedd20e444f0cb22f3827f6197814f97d193e7a44e909da7', lpAsset: '0xd608b0c3806e782cc213e2d52245c3c2fbef455a10410a1f5ccc61ba45262571', feeBps: 30, allocPoint: 30, lockSeconds: 0 },
    { pid: 2, pair: 'cETH/cBTC', poolId: '0x8359cd1f812e3a9040129e186e1477f60f2188bad1bd6a56e5506b22bf5cd331', lpAsset: '0x0a0cce175bc483945822c8de3d3926e813269f5e1bbe1f9c853e09ed48b68254', feeBps: 30, allocPoint: 20, lockSeconds: 0 },
  ],
};
const MAINNET_FARM_CONTROLLERS = Object.fromEntries(MAINNET_FARM.pools.map((p) => [p.poolId, MAINNET_FARM.manager]));

export const CONFIDENTIAL_DEPLOYMENTS = {
  signet: {
    chainId: 11155111,
    pool: '0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79',
    router: '0x0000000000000000000000000000000000000Ace',
    collateralEngine: null,
    cbtcEscrowHelper: null,
    cbtcEscrowHelpersRetired: [],
    farmControllers: {},
    farm: null,
    assetFactory: null,
    permit2: PERMIT2,
    zRouter: ZROUTER,
    deployBlock: 11057316,
    rpcs: SEPOLIA_RPCS,
    relayBase: 'https://api.tacit.finance',
    evmNetwork: 'mainnet',
    externalErc20: EXTERNAL_ERC20_SEPOLIA,
    assets: day1ConfidentialAssets('0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2', '10000000000', '0xd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b'),
  },
  mainnet: {
    chainId: 1,
    pool: null,
    router: null,
    collateralEngine: null,
    cbtcEscrowHelper: '0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA',
    cbtcEscrowHelpersRetired: ['0x00000000689c71e690e5842df088af97f9d4f71b'],
    crossOutPoolsRetired: ['0x0000000098A73197B3255aD9db1ed8544410f5Ba'],
    headerRelay: '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0',
    farmControllers: MAINNET_FARM_CONTROLLERS,
    farm: MAINNET_FARM,
    assetFactory: null,
    permit2: PERMIT2,
    zRouter: ZROUTER,
    deployBlock: 0,
    rpcs: MAINNET_RPCS,
    logRpcs: ETH_LOG_NODES,
    relayBase: 'https://api.tacit.finance',
    // Other relays running the same API (docs/RUN-A-RELAY.md), tried in order while relayBase is not proving
    // and sending. Each is an https origin; adding one here also adds it to the pages' connect-src (tests/relay-list.test.mjs checks).
    relays: [],
    evmNetwork: 'mainnet',
    externalErc20: EXTERNAL_ERC20_MAINNET,
    assets: [
      { ticker: 'TAC', assetId: MAINNET_TAC_POOL_ASSET_ID, bitcoinLink: TAC_ASSET_ID, underlying: null, unitScale: '10000000000', decimals: 18, tacitDecimals: 8, native: false, live: false, permitName: 'Tacit Token', permitVersion: '1' },
      ...day1ConfidentialAssets(null, '10000000000', '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC_ASSET_ID),
    ],
  },
};

import { DEPLOY_OVERRIDES } from './confidential-deployments.generated.js';
for (const [net, o] of Object.entries(DEPLOY_OVERRIDES || {})) {
  const d = CONFIDENTIAL_DEPLOYMENTS[net];
  if (!d || !o) continue;
  if (o.pool) d.pool = o.pool;
  if (o.router) d.router = o.router;
  if (o.collateralEngine) d.collateralEngine = o.collateralEngine;
  if (o.farmControllers) d.farmControllers = o.farmControllers;
  if (o.farm) d.farm = o.farm;
  if (o.assetFactory) d.assetFactory = o.assetFactory;
  if (o.deployBlock != null) d.deployBlock = o.deployBlock;
  const ids = o.assetIds || {};
  const byTicker = { cETH: ids.cEth, cTAC: ids.cTac, cBTC: ids.cBtc, cUSD: ids.cUsd };
  const liveSet = Array.isArray(o.live) ? new Set(o.live) : null;
  if (liveSet) d._liveTickers = liveSet;
  if (Array.isArray(o.externalErc20)) d._externalTickers = o.externalErc20;
  for (const a of d.assets) {
    const id = byTicker[a.ticker];
    if (id) a.assetId = id;
    if ((a.ticker === 'cTAC' || a.ticker === 'TAC') && o.tac) { a.underlying = o.tac; a.permitName = 'Tacit Token'; a.permitVersion = '1'; }
    if (a.ticker === 'cBTC' && o.cBtcToken) { a.underlying = o.cBtcToken; a.permitName = 'Tacit Token'; a.permitVersion = '1'; }
    if (a.ticker === 'cUSD' && o.cUsdToken) { a.underlying = o.cUsdToken; a.permitName = 'Tacit Token'; a.permitVersion = '1'; }
    if (liveSet && liveSet.has(a.ticker)) a.live = true;
  }
}

for (const d of Object.values(CONFIDENTIAL_DEPLOYMENTS)) {
  const cEth = d && Array.isArray(d.assets) ? d.assets.find((a) => a.ticker === 'cETH') : null;
  if (cEth && !cEth.assetId && d.chainId) cEth.assetId = cEth.bitcoinLink || nativeEvmAssetId(d.chainId, cEth.underlying);
  const cBtc = d && Array.isArray(d.assets) ? d.assets.find((a) => a.ticker === 'cBTC') : null;
  if (cBtc && d.chainId === 1 && (!cBtc.assetId || cBtc.assetId.toLowerCase() === CBTC_ASSET_ID.toLowerCase())) {
    cBtc.assetId = MAINNET_CBTC_POOL_ASSET_ID;
    cBtc.bitcoinLink = CBTC_ASSET_ID;
    cBtc.permitName = 'Tacit Token';
    cBtc.permitVersion = '1';
  }
  const cUsd = d && Array.isArray(d.assets) ? d.assets.find((a) => a.ticker === 'cUSD') : null;
  const cUsdDebtId = d && d.chainId === 1 && d.collateralEngine ? cdpDebtAssetId(d.collateralEngine) : null;
  if (cUsd && d.chainId === 1 && cUsdDebtId && (!cUsd.assetId || cUsd.assetId.toLowerCase() === cUsdDebtId.toLowerCase())) {
    cUsd.assetId = cUsdDebtId;
    cUsd.bitcoinLink = cUsdDebtId;
    cUsd.permitName = 'Tacit Token';
    cUsd.permitVersion = '1';
  }
  const cTac = d && Array.isArray(d.assets) ? d.assets.find((a) => a.ticker === 'cTAC') : null;
  if (cTac && d.chainId === 1 && !cTac.assetId) {
    cTac.assetId = MAINNET_TAC_POOL_ASSET_ID;
    cTac.bitcoinLink = TAC_ASSET_ID;
    cTac.permitName = 'Tacit Token';
    cTac.permitVersion = '1';
  }
  for (const a of registeredExternalPoolAssets(d)) {
    if (!d.assets.some((x) => x.ticker === a.ticker || (x.assetId && x.assetId.toLowerCase() === a.assetId.toLowerCase()))) {
      if (d._liveTickers && d._liveTickers.has(a.ticker)) a.live = true;
      d.assets.push(a);
    }
  }
}

let _active = 'signet';
export function setActiveNetwork(net) { if (net && CONFIDENTIAL_DEPLOYMENTS[net]) _active = net; }
export function activeNetwork() { return _active; }
export function getConfidentialDeployment(net) {
  const d = CONFIDENTIAL_DEPLOYMENTS[net || _active] || null;
  if (d && typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname || '') && d.relayBase && /tacit\.finance/.test(d.relayBase)) {
    return { ...d, relayBase: location.origin };
  }
  return d;
}

export function confidentialPoolReady(net) {
  const d = getConfidentialDeployment(net);
  return !!(d && d.pool);
}

export function confidentialUnavailableHTML(what, alt) {
  const net = activeNetwork();
  const where = net === 'mainnet' ? 'Ethereum mainnet' : net;
  const elsewhere = net === 'mainnet' ? 'the Bitcoin network and the Sepolia testnet' : 'the Bitcoin network';
  return `<div class="note-concept" style="margin-bottom:10px;"><b>${what} is coming to ${where}.</b> `
    + `The confidential pool and its EVM + cross-chain features go live once the Tacit V1 suite and prover are `
    + `deployed on this network. Available now on ${elsewhere}.${alt ? ' ' + alt : ''}</div>`;
}

export function lockedWalletHTML(action, btnId) {
  return `<div class="tab-locked-empty">
    <div class="tab-locked-empty-icon">\u{1F512}</div>
    <div class="tab-locked-empty-title">Unlock your wallet to ${action}</div>
    <div class="tab-locked-empty-sub">Same wallet as the Bitcoin lane — one identity, both chains. Your keys stay in this browser.</div>
    <button type="button" id="${btnId}" class="primary tab-locked-empty-cta">Unlock wallet</button>
  </div>`;
}

export function wireUnlockButton(btnId, helpers) {
  const btn = document.getElementById(btnId);
  if (!btn || !helpers || !helpers.unlock) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    try {
      await helpers.unlock();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Unlock wallet';
      if (!helpers.isUnlockCancelled || !helpers.isUnlockCancelled(e)) {
        notify('Unlock failed: ' + (e?.message || String(e)), 'error');
      }
    }
  });
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function shownTicker(ticker) {
  return ticker === 'cETH' ? 'tETH' : ticker;
}

export function decOf(ux, assetId) {
  const m = (ux.assets || []).find((x) => x.assetId && String(x.assetId).toLowerCase() === String(assetId).toLowerCase());
  return m ? Number(m.tacitDecimals ?? m.decimals ?? 8) : 8;
}

export function formatErr(e, verb) {
  const msg = (e && e.message) ? e.message : String(e || 'unknown error');
  return (verb ? verb + ' failed: ' : '') + msg;
}

const _SPEC_ERROR_HINTS = [
  [/AmountNotAligned|not aligned to unitScale/i, "amount isn't divisible by this asset's unit scale — check the decimal places"],
  [/DepositNotPending/i, "the wrap transaction isn't mined yet, or this deposit was already consumed"],
  [/UnknownRoot/i, "this note's membership proof is against a root the pool has since moved past — rescan and retry"],
  [/NullifierAlreadySpent/i, 'this note was already spent — rescan to refresh your balance and retry'],
  [/DepositExists/i, 'this exact asset, amount and wrap index is already a pending deposit — retry to pick the next index'],
  [/MemoLeafMismatch/i, "the sealed memos don't match what settled — rescan and retry"],
];
export function formatSpecErr(e, verb) {
  const base = formatErr(e, verb);
  const hit = _SPEC_ERROR_HINTS.find(([re]) => re.test(base));
  return hit ? `${base} — ${hit[1]}` : base;
}

export function evmAccountHint() {
  return `<div class="muted" style="font-size:10.5px;margin:2px 0 6px;">Derived from your Tacit wallet key — no separate wallet connection needed. Send ETH (or any supported asset) here to use it.</div>`;
}

export function notify(msg, kind = '', title = '') {
  try { if (typeof window !== 'undefined' && window.__tacitToast) window.__tacitToast(msg, kind, 4000, title); } catch {}
}

const _PROVE_PHASES = [
  { label: 'Submitted' },
  { label: 'Proving', hint: 'on the Succinct network · ~30–60s' },
  { label: 'Settling', hint: 'on-chain' },
  { label: 'Done' },
];
function _provePhaseIndex(status) {
  switch (String(status || '').toLowerCase()) {
    case 'settled': return 4;
    case 'proven': case 'settling': return 2;
    case 'failed': return -1;
    default: return 1;
  }
}
let _proveCssInjected = false;
function _injectProveCss() {
  if (_proveCssInjected || typeof document === 'undefined') return;
  _proveCssInjected = true;
  const s = document.createElement('style');
  s.textContent = '.prove-steps{display:flex;align-items:center;gap:0;margin:.45rem 0 .3rem;list-style:none;padding:0;font-size:.82em;flex-wrap:wrap}'
    + '.prove-step{display:flex;align-items:center;gap:.4em;color:var(--l2,#8a8f98)}'
    + '.prove-step + .prove-step::before{content:"";width:1.3em;height:2px;margin:0 .5em;background:currentColor;opacity:.35;border-radius:2px}'
    + '.prove-step .prove-dot{width:.6em;height:.6em;border-radius:50%;border:2px solid currentColor;box-sizing:border-box;flex:0 0 auto}'
    + '.prove-step.done{color:var(--green,#10b981)}'
    + '.prove-step.done .prove-dot{background:var(--green,#10b981);border-color:var(--green,#10b981)}'
    + '.prove-step.active{color:var(--amber,#f59e0b);font-weight:600}'
    + '.prove-step.active .prove-dot{border-color:var(--amber,#f59e0b);animation:prove-pulse 1.1s ease-in-out infinite}'
    + '.prove-steps.fail .prove-step{color:var(--red,#ef4444)}'
    + '.prove-hint{font-size:.76em;color:var(--l2,#8a8f98);opacity:.85;margin-bottom:.15rem}'
    + '@keyframes prove-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,.5)}50%{box-shadow:0 0 0 .28em rgba(245,158,11,.16)}}';
  document.head.appendChild(s);
}
export function provingProgressHTML(status, verb) {
  const idx = _provePhaseIndex(status);
  const dot = (cls) => `<li class="prove-step ${cls}"><span class="prove-dot"></span>%L</li>`;
  if (idx === -1) {
    const steps = _PROVE_PHASES.map((p) => dot('').replace('%L', esc(p.label))).join('');
    return `<ol class="prove-steps fail">${steps}</ol><div class="prove-hint">proving failed — you can retry.</div>`;
  }
  const steps = _PROVE_PHASES.map((p, i) => dot(i < idx ? 'done' : i === idx ? 'active' : '').replace('%L', esc(p.label))).join('');
  const active = _PROVE_PHASES[Math.min(idx, _PROVE_PHASES.length - 1)];
  const hint = idx >= _PROVE_PHASES.length ? 'settled on-chain ✓' : (active && active.hint ? `${verb ? esc(verb) + ' · ' : ''}${active.hint}` : '');
  return `<ol class="prove-steps">${steps}</ol>${hint ? `<div class="prove-hint">${hint}</div>` : ''}`;
}
export function renderProvingProgress(el, status, verb) {
  if (!el) return;
  _injectProveCss();
  el.innerHTML = provingProgressHTML(status, verb);
}
export function proveUpdater(el, verb) {
  return (st) => renderProvingProgress(el, st && st.status, verb);
}

export async function copyToClipboard(text, btn) {
  const restore = btn ? btn.textContent : null;
  try {
    await navigator.clipboard.writeText(text == null ? '' : String(text));
    if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = restore; }, 1200); }
    return true;
  } catch {
    if (btn) { btn.textContent = 'Copy failed'; setTimeout(() => { btn.textContent = restore; }, 1400); }
    return false;
  }
}


const _PROTECTED_OUTPOINTS_KEY = 'tacit-protected-outpoints-v1';
// Read from storage each time: a lock made on another page or in another tab is seen here, and a write adds to what is there.
// Where storage cannot be read, what this page set is kept in memory.
let _protectedOutpoints = new Map();
const _outpointKey = (txid, vout) => `${String(txid).replace(/^0x/, '').toLowerCase()}:${vout | 0}`;
function _loadProtectedOutpoints() {
  try {
    const raw = JSON.parse(localStorage.getItem(_PROTECTED_OUTPOINTS_KEY) || '{}'), m = new Map();
    if (Array.isArray(raw)) for (const k of raw) m.set(String(k), '0');
    else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) m.set(String(k), String(v ?? '0'));
    _protectedOutpoints = m;
  } catch { }
  return _protectedOutpoints;
}
function _saveProtectedOutpoints(m) {
  _protectedOutpoints = m;
  try { localStorage.setItem(_PROTECTED_OUTPOINTS_KEY, JSON.stringify(Object.fromEntries(m))); } catch {}
}
export function isProtectedOutpoint(txid, vout) {
  return _loadProtectedOutpoints().has(_outpointKey(txid, vout));
}
export function protectOutpoint(txid, vout, vBtc = 0) {
  const m = _loadProtectedOutpoints();
  const k = _outpointKey(txid, vout);
  const sats = BigInt(vBtc || 0);
  m.set(k, (sats > 0n ? sats : BigInt(m.get(k) || 0)).toString());
  _saveProtectedOutpoints(m);
}
export function unprotectOutpoint(txid, vout) {
  const m = _loadProtectedOutpoints();
  if (!m.delete(_outpointKey(txid, vout))) return;
  _saveProtectedOutpoints(m);
}
export function listProtectedOutpoints() { return [..._loadProtectedOutpoints().keys()]; }
export function listReservedLocks() {
  return [..._loadProtectedOutpoints()].map(([k, v]) => {
    const i = k.lastIndexOf(':');
    return { txid: k.slice(0, i), vout: Number(k.slice(i + 1)), sats: BigInt(v || 0) };
  });
}
export function reservedLockSats() {
  let t = 0n;
  for (const v of _loadProtectedOutpoints().values()) t += BigInt(v || 0);
  return t;
}
export async function syncProtectedOutpoints({ lockOutputs, lockState } = {}) {
  if (typeof lockState !== 'function') throw new Error('confidential-deployments: syncProtectedOutpoints needs lockState(txid, vout)');
  const reserved = [], released = [];
  const outs = lockOutputs || [], states = await Promise.all(outs.map((o) => lockState(o.txid, o.vout)));
  for (const [i, o] of outs.entries()) {
    const st = states[i] || {};
    const vBtc = BigInt(st.vBtc || 0);
    if (vBtc <= 0n) continue;
    if (st.spent || st.redeemed) { unprotectOutpoint(o.txid, o.vout); released.push({ txid: o.txid, vout: o.vout }); continue; }
    protectOutpoint(o.txid, o.vout, vBtc);
    reserved.push({ txid: o.txid, vout: o.vout, sats: vBtc });
  }
  return { reserved, released };
}
