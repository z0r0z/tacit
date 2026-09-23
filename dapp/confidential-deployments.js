import { sha256, keccak_256 } from './vendor/tacit-deps.min.js';

// Single source of truth for the confidential / cross-lane deployment per network. Both the cross-chain
// holdings resolver (tacit.js) and every confidential surface (confidential-pool-ux.js → pool/DeFi/OTC/
// send/swap tabs) read from here, so one `tools/sync-deployment-config.mjs` run lights up the whole dapp
// from a DeployV1Suite manifest.
//
// `tools/sync-deployment-config.mjs <manifest> --network <net> --write` patches, per network:
//   pool · router · collateralEngine · deployBlock · each asset's `assetId` (by ticker).
// It does NOT touch any asset's `live` flag — advertising a DeFi/cross-lane route is a separate, conscious
// gate (the sync's opt-in `--live <tickers>` writes it, default OFF; otherwise it stays a hand-edit here).
// It NEVER invents asset economics — `decimals` / `unitScale` / `native` / `underlying` are launch
// parameters maintained here; the manifest only supplies addresses
// + the keccak asset ids. An asset with `assetId: null` is "declared but not yet deployed" — the
// confidential UX filters those out, and the resolver ignores them.
//
// Network keys match the dapp's currentNetworkName(): 'signet' (testnet — Sepolia EVM) and 'mainnet'.

const SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://1rpc.io/sepolia',
  'https://sepolia.drpc.org',
  'https://sepolia.gateway.tenderly.co',
];
// Browser-facing, keyless. Ordered by what actually serves CORS + a 2000-block windowed eth_getLogs (incl.
// archive windows back to the pool deploy block) from a page origin: tenderly + drpc handle it; 1rpc caps at
// 50 blocks and publicnode wants a token for old logs, so they trail as read-only fallbacks (eth_call/head).
const MAINNET_RPCS = [
  'https://mainnet.gateway.tenderly.co',
  'https://eth.drpc.org',
  'https://1rpc.io/eth',
  'https://cloudflare-eth.com',
];
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'; // canonical Permit2 singleton (same on every chain)
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4'; // pinned zRouter aggregator
const TAC_ASSET_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const CBTC_ASSET_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
// Bridged/pool-minted canonical assets are keyed in the pool registry by their shared cross-chain id, so
// the pool asset id equals the asset's shared id (a bridged note and an ERC20-wrapped note are one asset).
const MAINNET_TAC_POOL_ASSET_ID = TAC_ASSET_ID;
const MAINNET_CBTC_POOL_ASSET_ID = CBTC_ASSET_ID;
// The cUSD id is keyed by the CollateralEngine (cdpDebtAssetId below), and the canonical TAC / tacBTC / tacUSD
// ERC20s are minter-bound to the pool — all four change with every deployment, so they come from the deploy
// sync (confidential-deployments.generated.js: assetIds.cUsd, tac, cBtcToken, cUsdToken), never from a copy here.

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

function nativeEvmAssetId(chainId, underlying = '0x0000000000000000000000000000000000000000') {
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

// Display-only external ERC20 watchlist — surfaced as standalone rows in the unified Wallet (NOT tacit
// assets, NOT merged into any cross-lane assetId sum). These are the public tokens a user is most likely
// to wrap into the pool (the Send one-tx wrap-and-send reads balances against the same list). `decimals`
// is the token's own ERC20 precision (used purely for display formatting).
const EXTERNAL_ERC20_MAINNET = [
  { ticker: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { ticker: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  { ticker: 'wstETH', address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18 },
];
const EXTERNAL_ERC20_SEPOLIA = [
  { ticker: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 }, // Circle Sepolia test USDC
];

// Day-1 confidential asset templates. assetId is filled by the
// deploy sync; everything else is the launch economics the wrap/scale math depends on.
//   cETH  — native ETH slot, in-system 8-dec (18-dec ETH at scale 1e10).
//   cTAC  — escrow-wrapped TAC (underlying = the TAC ERC20, set by sync), 8-dec.
//   cBTC  — pool-minted against a slashable escrow (no ERC20 underlying until exit to tacBTC), 8-dec.
//   cUSD  — pool-minted CDP debt (no underlying), 8-dec.
function day1ConfidentialAssets(cEthId, cEthScale, tethBitcoinLink, tacBitcoinLink) {
  return [
    // live = the cross-lane holdings/bridge gate (set deliberately per surface);
    // the pool surfaces use `assetId` (not live), so cETH is usable in the pool regardless.
    // bitcoinLink = the legacy tETH Bitcoin asset id (the pool's on-chain TETH_BITCOIN_ID / localAssetOf
    // key). MUST equal the TETH_BITCOIN_ID the live pool was deployed with, so a legacy tETH note merges
    // into the cETH row. cETH's own id is _evmAssetId(0) = sha256(tag‖chainid‖0) — pool-independent.
    // imageUri = the pinned canonical IPFS metadata (also the on-chain contractURI source); the dapp renders
    // a matching inline brand mark for instant display (assetImageFallback), so the cids stay authoritative
    // without gating first paint on a gateway.
    { ticker: 'cETH', assetId: cEthId, bitcoinLink: tethBitcoinLink || null, underlying: '0x0000000000000000000000000000000000000000', unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: true, live: false,
      description: 'Confidential ETH in the Tacit pool. Wrap ETH → cETH; bridges to Bitcoin (tETH) and back.', imageUri: 'ipfs://bafkreid55b3c2w6swyjl3lec66a23subiolwwsd6tof2wticoj6d7vnv4i' },
    // bitcoinLink = the Bitcoin-native TAC asset id; the bridged TAC ERC20 commits it (ASSET_ID==link), so
    // registerWrapped pins localAssetOf[link]=cTAC. Lets a Bitcoin-lane TAC holding merge with the cTAC row.
    { ticker: 'cTAC', assetId: null, bitcoinLink: tacBitcoinLink || null, underlying: null, unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: false, live: false,
      description: 'Confidential TAC — the Tacit protocol token, shielded in the pool.' },
    // bitcoinLink = CBTC_ZK_ASSET_ID — a CONSTANT pinned at the pool ctor (localAssetOf[0x62a20d98]=tacBTC is
    // always set, no deploy env), so the resolver merges the cBTC.zk(BTC) + tacBTC(ETH) lanes. Same on every chain.
    { ticker: 'cBTC', assetId: null, bitcoinLink: CBTC_ASSET_ID, underlying: null, unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: false, live: false,
      description: 'Confidential Bitcoin minted 1:1 from SP1-reflected Bitcoin locks, with a slashable wstETH escrow per lock.', imageUri: 'ipfs://bafkreifqbhoqbnho2d22bpy5s2qfsnc5ta3uxktvg4q4xn2zumxsweserq' },
    { ticker: 'cUSD', assetId: null, underlying: null, unitScale: cEthScale, decimals: 18, tacitDecimals: 8, native: false, live: false,
      description: 'Confidential USD — a cBTC-collateralized stablecoin (CDP).' },
  ];
}

// Per external ERC20 → confidential-asset template, keyed by public ticker. `permitType` selects the
// gasless-approval path the router wrap uses: 'eip2612' (native EIP-2612 permit — single-tx, e.g. USDC)
// or 'permit2' (token has no EIP-2612, so wrap via the canonical Permit2 singleton — one-time Permit2
// approval, then signature-per-wrap; falls back to a standard approve+wrap if Permit2 isn't approved).
const EXTERNAL_WRAP_META = {
  USDC: { ticker: 'cUSDC', tacitDecimals: 6, permitType: 'eip2612', permitName: 'USD Coin', permitVersion: '2',
    description: 'Confidential USDC in the Tacit pool.' },
  USDT: { ticker: 'cUSDT', tacitDecimals: 6, permitType: 'permit2',
    description: 'Confidential USDT in the Tacit pool. Tether has no EIP-2612 permit, so wraps route through Permit2 (or a one-time approval).' },
  // wstETH is 18-dec → scale 1e10 to 8-dec in-system (same scheme as cETH); it supports EIP-2612.
  // Key MUST be upper-case — the lookup does EXTERNAL_WRAP_META[ticker.toUpperCase()] (as USDC/USDT do).
  WSTETH: { ticker: 'cwstETH', tacitDecimals: 8, unitScale: '10000000000', permitType: 'eip2612',
    permitName: 'Wrapped liquid staked Ether 2.0', permitVersion: '1',
    description: 'Confidential wstETH (Lido wrapped staked ETH) in the Tacit pool.' },
};

function registeredExternalPoolAssets(d) {
  const out = [];
  if (!d || d.chainId !== 1) return out;
  // Only the ERC20s the deploy sync marked registered on THIS pool (`--external`): registration is per
  // deployment, and advertising a wrap the pool would reject is worse than not listing it yet.
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

// Launch farm program (mainnet): the FarmManager singleton streams one wTAC reward across the three launch LP
// pools by allocation weight. Rewards pay in value units of the wTAC pool asset (unitScale base units each, so
// 1e-8 TAC); `tac` is the plain TAC ERC20 that wTAC unwraps 1:1 into, and `funder` tops up the treasury in one tx.
// farmControllers maps each pool to the manager so the Earn tab's one-click bond targets it.
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

// Cross-lane / confidential-pool deployment registry. FLIP-ON CHECKLIST for going live per network
// (all config-only — the dapp surfaces gate off `_crosslaneConfigured` = pool set + an asset live:true):
//   1. Deploy the ConfidentialPool + ConfidentialRouter; set `pool` (+ `router`) here via the
//      DeployV1Suite sync (tools/sync-deployment-config.mjs) — do NOT hand-edit a placeholder address.
//   2. Register the cross-chain link on-chain (localAssetOf[bitcoinLink] = the pool asset) so bridged /
//      legacy notes merge into the right row.
//   3. Pin the settle vkey of the deployed guest — the dapp builds are guest-exact; live settlement
//      needs the matching vkey.
//   4. Mark the intended asset(s) `live:true` — this un-gates holdings merge, the bridge affordance, and
//      Ethereum-side sends. Leave others live:false.
// Steps 1–2–3 are on-chain/prover; step 4 + the address writes are this file. No dapp code change.
export const CONFIDENTIAL_DEPLOYMENTS = {
  signet: {
    chainId: 11155111,
    // Sepolia pilot pool (overwritten by the DeployV1Suite sync at launch).
    pool: '0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79',
    // ConfidentialRouter — one-tx wrap / wrap-and-settle / public-AMM / zaps. PLACEHOLDER on signet so the
    // batching path is wired + exercisable behind the live gate; the DeployV1Suite sync overwrites it with
    // the real broadcast address. Still inert in the UI until an asset is flipped live (_crosslaneConfigured).
    router: '0x0000000000000000000000000000000000000Ace',
    collateralEngine: null, // CollateralEngine (CDP controller / sole cUSD minter). null ⇒ CDP disabled.
    farmControllers: {},     // poolId → FarmController (OP_LP_BOND bond target), per pool. {} ⇒ Earn bonding disabled.
    farm: null,              // launch farm program (FarmManager + reward asset + pools). null ⇒ no program on this network.
    assetFactory: null,      // CanonicalAssetFactory (EVM-etch new tacit-compatible assets). null ⇒ Create→Asset disabled.
    permit2: PERMIT2,
    zRouter: ZROUTER,
    deployBlock: 11057316,
    rpcs: SEPOLIA_RPCS,
    relayBase: 'https://api.tacit.finance',
    evmNetwork: 'mainnet', // deriveEvmAccount domain tag — DO NOT change (would orphan derived EVM accounts)
    externalErc20: EXTERNAL_ERC20_SEPOLIA,
    // cETH scale 1e10 matches the V1 pool's native-ETH registration (_register(0, 10**10,…) → 18-dec ETH to
    // 8-dec in-system). The relay fee floor (RELAY_MIN_FEE, in wei ÷ unitScale) + display/entry (tacitDecimals
    // vs decimals) are scale-aware, so 1e10 is coherent end-to-end.
    assets: day1ConfidentialAssets('0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2', '10000000000', '0xd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b'),
  },
  mainnet: {
    chainId: 1,
    pool: null,
    router: null,
    collateralEngine: null,
    farmControllers: MAINNET_FARM_CONTROLLERS,
    farm: MAINNET_FARM,
    assetFactory: null,
    permit2: PERMIT2,
    zRouter: ZROUTER,
    deployBlock: 0,
    rpcs: MAINNET_RPCS,
    relayBase: 'https://api.tacit.finance',
    evmNetwork: 'mainnet',
    externalErc20: EXTERNAL_ERC20_MAINNET,
    // The canonical bridged TAC (public ERC20) is recognized for cross-lane holdings even pre-pool.
    assets: [
      { ticker: 'TAC', assetId: MAINNET_TAC_POOL_ASSET_ID, bitcoinLink: TAC_ASSET_ID, underlying: null, unitScale: '10000000000', decimals: 18, tacitDecimals: 8, native: false, live: false, permitName: 'Tacit Token', permitVersion: '1' },
      ...day1ConfidentialAssets(null, '10000000000', '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC_ASSET_ID),
    ],
  },
};

// Merge the deploy-sync overrides (confidential-deployments.generated.js) over the static defaults, so a
// DeployV1Suite manifest lights up pool/router/engine/asset-ids without hand-editing this file.
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
  const liveSet = Array.isArray(o.live) ? new Set(o.live) : null; // opt-in --live <tickers>; absent ⇒ leave the static gate
  // Kept on the deployment because the registered-external assets (cUSDC/cUSDT/cwstETH) are appended
  // later, after this loop has already run — without it their `live` would always read false and the
  // sync's --live gate would silently do nothing for them.
  if (liveSet) d._liveTickers = liveSet;
  if (Array.isArray(o.externalErc20)) d._externalTickers = o.externalErc20;
  for (const a of d.assets) {
    const id = byTicker[a.ticker];
    if (id) a.assetId = id;
    // escrow-wrapped TAC pulls the TAC ERC20; the canonical bridged token is EIP-2612 ('Tacit Token'),
    // so its wrap is a single-tx gasless-approval permit (not the Permit2 fallback).
    if ((a.ticker === 'cTAC' || a.ticker === 'TAC') && o.tac) { a.underlying = o.tac; a.permitName = 'Tacit Token'; a.permitVersion = '1'; }
    // The pool-minted canonical ERC20s (wrap-back targets for cBTC / cUSD) are minter-bound to this pool.
    if (a.ticker === 'cBTC' && o.cBtcToken) { a.underlying = o.cBtcToken; a.permitName = 'Tacit Token'; a.permitVersion = '1'; }
    if (a.ticker === 'cUSD' && o.cUsdToken) { a.underlying = o.cUsdToken; a.permitName = 'Tacit Token'; a.permitVersion = '1'; }
    if (liveSet && liveSet.has(a.ticker)) a.live = true;
  }
}

// Native ETH's pool asset id is deterministic (`_evmAssetId(address(0))`) and does not need a manifest
// write. Keep it available for the cETH send surface even when the generated deployment only carries the
// pool/router addresses.
for (const d of Object.values(CONFIDENTIAL_DEPLOYMENTS)) {
  const cEth = d && Array.isArray(d.assets) ? d.assets.find((a) => a.ticker === 'cETH') : null;
  // A bridge-linked native asset carries its SHARED (tETH) bitcoinLink as the note asset id — the id the
  // pool's notes use (localAssetOf maps it to the local _evmAssetId) and the id that keeps cETH fungible
  // cross-chain + bridgeable. Only fall back to the local id on a network with no tETH link.
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
  // cTAC — the live TAC pool registers the shared cross-chain TAC id (MAINNET_TAC_POOL_ASSET_ID == the
  // Bitcoin-native TAC id); the canonical TAC ERC20 it wraps comes from the sync (`tac`). The generated
  // manifest may not carry a cTac id, so pin it here (mirrors the cBTC/cUSD mainnet fallbacks) — without it
  // the TAC/cETH pool is unreachable (the engine drops assets with a null id).
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

// Active network — set once by tacit.js from currentNetworkName() so the standalone confidential tab
// modules resolve the right deployment without threading the network through every render call.
let _active = 'signet';
export function setActiveNetwork(net) { if (net && CONFIDENTIAL_DEPLOYMENTS[net]) _active = net; }
export function activeNetwork() { return _active; }
export function getConfidentialDeployment(net) {
  const d = CONFIDENTIAL_DEPLOYMENTS[net || _active] || null;
  // Local dev: the production relay only allows the tacit.finance origin, so route relay calls through the
  // dev server's same-origin /confidential proxy (see the local static server). No effect off localhost.
  if (d && typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname || '') && d.relayBase && /tacit\.finance/.test(d.relayBase)) {
    return { ...d, relayBase: location.origin };
  }
  return d;
}

// True when the confidential pool is deployed on `net` (default active). Every confidential / EVM tab checks
// this BEFORE instantiating the pool UX (makeConfidentialPoolUx throws on an undeployed network), so an
// undeployed network shows a clean notice instead of a blank panel + console error.
export function confidentialPoolReady(net) {
  const d = getConfidentialDeployment(net);
  return !!(d && d.pool);
}

// Shared "this surface isn't live on this network yet" panel — rendered when the V1 suite / prover isn't
// deployed on the active network (mainnet today). `what` names the feature; `alt` is optional trailing HTML.
export function confidentialUnavailableHTML(what, alt) {
  const net = activeNetwork();
  const where = net === 'mainnet' ? 'Ethereum mainnet' : net;
  const elsewhere = net === 'mainnet' ? 'the Bitcoin network and the Sepolia testnet' : 'the Bitcoin network';
  return `<div class="note-concept" style="margin-bottom:10px;"><b>${what} is coming to ${where}.</b> `
    + `The confidential pool and its EVM + cross-chain features go live once the Tacit V1 suite and prover are `
    + `deployed on this network. Available now on ${elsewhere}.${alt ? ' ' + alt : ''}</div>`;
}

// Shared UI helpers for every confidential surface (pool/send/swap/otc/defi/govern tabs), so error strings
// and HTML escaping are consistent across the confidential lane rather than reimplemented per module.

// HTML-escape a value before interpolating it into innerHTML. Use for anything derived from note/pool/tx
// data or user input.
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Normalize a caught error into a short human string. `verb` (e.g. "Swap") yields "Swap failed: <reason>".
export function formatErr(e, verb) {
  const msg = (e && e.message) ? e.message : String(e || 'unknown error');
  return (verb ? verb + ' failed: ' : '') + msg;
}

// Surface a terminal success/failure in the app's shared toast + notification bell, so confidential-tab
// actions are logged like the core flows. `kind` is '' | 'ok' | 'error' (matches tacit.js toast()). No-op
// if the host bundle hasn't wired the hook yet (e.g. under node tests).
export function notify(msg, kind = '', title = '') {
  try { if (typeof window !== 'undefined' && window.__tacitToast) window.__tacitToast(msg, kind, 4000, title); } catch {}
}

// ── Shared proving-progress stepper ─────────────────────────────────────────────────────────────
// A confidential op is async: the relay proves it on the Succinct network, then settles on-chain. This
// renders a 4-phase stepper (Submitted → Proving → Settling → Done) from the relay status string that
// waitForSettle's onUpdate emits ('queued'|'proving'|'proven'|'settling'|'settled'|'failed'). Reused by
// every tab (send/pool/DeFi) so the wait looks the same everywhere. Self-contained: injects its CSS once
// and uses the dapp's :root tokens (--green/--amber/--red/--l2) with safe fallbacks.
const _PROVE_PHASES = [
  { label: 'Submitted' },
  { label: 'Proving', hint: 'on the Succinct network · ~30–60s' },
  { label: 'Settling', hint: 'on-chain' },
  { label: 'Done' },
];
function _provePhaseIndex(status) {
  switch (String(status || '').toLowerCase()) {
    case 'settled': return 4;                 // all phases done
    case 'proven': case 'settling': return 2; // proof in hand → settling on-chain
    case 'failed': return -1;                 // error
    default: return 1;                        // queued / proving / unknown → proving
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
// The stepper markup for a given relay status. `verb` (e.g. 'Sending', 'Wrapping') labels the hint line.
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
// Render the stepper into `el` for a relay status. Injects the CSS on first use.
export function renderProvingProgress(el, status, verb) {
  if (!el) return;
  _injectProveCss();
  el.innerHTML = provingProgressHTML(status, verb);
}
// Convenience: an onUpdate handler for waitForSettle/waitForProven that renders the stepper into `el`.
export function proveUpdater(el, verb) {
  return (st) => renderProvingProgress(el, st && st.status, verb);
}

// Copy `text` to the clipboard and give transient feedback on `btn` (label flips to "Copied", then back).
// One helper so every confidential surface's copy affordance behaves identically. Returns true on success.
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


// ── Protected outpoints: live cBTC self-custody locks, never spendable by coin selection ──────────────
//
// A cBTC lock is a plain Bitcoin output carrying a 0x66 envelope; nothing on Bitcoin prevents it from being
// spent (covenant-enforced locks are held behind the reserved OP_COVENANT_MINT opcode). This registry keeps
// such outputs out of coin selection, and is consumed by tacit.js's getUtxos filter and by cbtc-lock-mint's
// own funding guard.
//
// The AUTHORITATIVE record is the pool's own: cbtcLockVBtc[outpoint] is the lock's value, and
// cbtcLockSpent / cbtcLockRedeemed are its two terminal states. `syncProtectedOutpoints` rebuilds the set
// from those reads, so a reload, a second device or a private window converges on the same reservations
// instead of starting empty. Local storage is a cache in front of that — it also carries the window between
// broadcasting a lock and the reflection recording it, when no chain record exists to rebuild from.
//
// A lock is released only in a state the chain itself reports as terminal: redeemed, or already spent. That
// is also where redemption unreserves — there is no separate client-side hand-off to miss.
//
// WHAT THIS ACTUALLY REACHES — read before relying on it.
//
// tacit.js's getUtxos is only ever called with the wallet's P2WPKH address, while a lock output is a
// key-path P2TR. Those two sets are disjoint, so that filter alone can never see a lock outpoint: its real
// job there is the general "do not spend a reserved outpoint" rule, not lock protection specifically. Lock
// protection is enforced where lock-adjacent funding is actually chosen — cbtc-lock-mint's guarded
// fetchUtxos, which this set is passed into.
//
// It cannot reach an EXTERNAL wallet at all. The lock sits at a key-path P2TR under the same seed, so any
// other wallet restored from that seed sees an ordinary spendable UTXO and may sweep it — which the fold
// reads as a rug and which slashes the escrow with no cure path. No client-side registry can fix that; it is
// a property of a lock being a plain output rather than a covenant.
const _PROTECTED_OUTPOINTS_KEY = 'tacit-protected-outpoints-v1';
// outpoint key -> reserved sats as a decimal string ('0' where the value isn't known yet, which is every
// entry written before the pool has recorded the lock).
let _protectedOutpoints = null;
const _outpointKey = (txid, vout) => `${String(txid).replace(/^0x/, '').toLowerCase()}:${vout | 0}`;
function _loadProtectedOutpoints() {
  if (_protectedOutpoints) return _protectedOutpoints;
  _protectedOutpoints = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(_PROTECTED_OUTPOINTS_KEY) || '{}');
    // Entries written before locks carried their value are a bare array of keys.
    if (Array.isArray(raw)) for (const k of raw) _protectedOutpoints.set(String(k), '0');
    else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) _protectedOutpoints.set(String(k), String(v ?? '0'));
  } catch { /* an unreadable cache is an empty one; the chain sync refills it */ }
  return _protectedOutpoints;
}
function _saveProtectedOutpoints() {
  try { localStorage.setItem(_PROTECTED_OUTPOINTS_KEY, JSON.stringify(Object.fromEntries(_loadProtectedOutpoints()))); } catch {}
}
export function isProtectedOutpoint(txid, vout) {
  return _loadProtectedOutpoints().has(_outpointKey(txid, vout));
}
/** Register a cBTC lock output as unspendable by ordinary coin selection. Idempotent. */
export function protectOutpoint(txid, vout, vBtc = 0) {
  const m = _loadProtectedOutpoints();
  const k = _outpointKey(txid, vout);
  // A later registration without a value must not erase a value an earlier one carried.
  const sats = BigInt(vBtc || 0);
  m.set(k, (sats > 0n ? sats : BigInt(m.get(k) || 0)).toString());
  _saveProtectedOutpoints();
}
/** Release a lock outpoint — call ONLY once it is genuinely retired (redeemed, or already spent). */
export function unprotectOutpoint(txid, vout) {
  if (!_loadProtectedOutpoints().delete(_outpointKey(txid, vout))) return;
  _saveProtectedOutpoints();
}
/** The live protected set, as `txid:vout` strings — the exclude set coin selection is handed. */
export function listProtectedOutpoints() { return [..._loadProtectedOutpoints().keys()]; }
/** The same set with the sats each lock holds, for UI that wants to show why a balance is reserved. */
export function listReservedLocks() {
  return [..._loadProtectedOutpoints()].map(([k, v]) => {
    const i = k.lastIndexOf(':');
    return { txid: k.slice(0, i), vout: Number(k.slice(i + 1)), sats: BigInt(v || 0) };
  });
}
/** Total sats held in live cBTC locks, as far as the pool has told us. */
export function reservedLockSats() {
  let t = 0n;
  for (const v of _loadProtectedOutpoints().values()) t += BigInt(v || 0);
  return t;
}
/**
 * Rebuild the reserved set from the pool's own lock records, so it survives a cache clear or a new device.
 * `lockOutputs` are the wallet's candidate lock outpoints (confidential-recovery-btc's history walk);
 * `lockState(txid, vout)` reads cbtcLockVBtc / cbtcLockSpent / cbtcLockRedeemed for one of them.
 * Entries the chain has not recorded yet are left alone — the local pre-confirmation reservation is the
 * only thing protecting a freshly broadcast lock.
 */
export async function syncProtectedOutpoints({ lockOutputs, lockState } = {}) {
  if (typeof lockState !== 'function') throw new Error('confidential-deployments: syncProtectedOutpoints needs lockState(txid, vout)');
  const reserved = [], released = [];
  for (const o of lockOutputs || []) {
    const st = await lockState(o.txid, o.vout) || {};
    const vBtc = BigInt(st.vBtc || 0);
    if (vBtc <= 0n) continue;
    if (st.spent || st.redeemed) { unprotectOutpoint(o.txid, o.vout); released.push({ txid: o.txid, vout: o.vout }); continue; }
    protectOutpoint(o.txid, o.vout, vBtc);
    reserved.push({ txid: o.txid, vout: o.vout, sats: vBtc });
  }
  return { reserved, released };
}
