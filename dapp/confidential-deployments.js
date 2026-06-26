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
// parameters maintained here (ops/PLAN-day1-assets-and-incentives.md); the manifest only supplies addresses
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
const MAINNET_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.drpc.org',
  'https://cloudflare-eth.com',
];
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'; // Uniswap Permit2 singleton (same on every chain)
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4'; // pinned zRouter aggregator

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

// Day-1 confidential asset templates (ops/PLAN-day1-assets-and-incentives.md). assetId is filled by the
// deploy sync; everything else is the launch economics the wrap/scale math depends on.
//   cETH  — native ETH slot, in-system 8-dec (18→scale 1e10 once re-pinned; pilot used scale 1).
//   cTAC  — escrow-wrapped TAC (underlying = the TAC ERC20, set by sync), 8-dec.
//   cBTC  — pool-minted against a slashable escrow (no ERC20 underlying until exit to tacBTC), 8-dec.
//   cUSD  — pool-minted CDP debt (no underlying), 8-dec.
function day1ConfidentialAssets(cEthId, cEthScale) {
  return [
    // live = the cross-lane holdings/bridge gate (flipped deliberately per surface at launch, playbook §7);
    // the pool surfaces use `assetId` (not live), so cETH is usable in the pool regardless.
    { ticker: 'cETH', assetId: cEthId, underlying: '0x0000000000000000000000000000000000000000', unitScale: cEthScale, decimals: 18, native: true, live: false },
    { ticker: 'cTAC', assetId: null, underlying: null, unitScale: '1', decimals: 8, native: false, live: false },
    { ticker: 'cBTC', assetId: null, underlying: null, unitScale: '1', decimals: 8, native: false, live: false },
    { ticker: 'cUSD', assetId: null, underlying: null, unitScale: '1', decimals: 8, native: false, live: false },
  ];
}

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
    farmController: null,    // FarmController (OP_LP_BOND / farm bond target). null ⇒ Earn bonding disabled.
    assetFactory: null,      // CanonicalAssetFactory (EVM-etch new tacit-compatible assets). null ⇒ Create→Asset disabled.
    permit2: PERMIT2,
    zRouter: ZROUTER,
    deployBlock: 11057316,
    rpcs: SEPOLIA_RPCS,
    relayBase: 'https://api.tacit.finance',
    evmNetwork: 'mainnet', // deriveEvmAccount domain tag — DO NOT change (would orphan derived EVM accounts)
    externalErc20: EXTERNAL_ERC20_SEPOLIA,
    assets: day1ConfidentialAssets('0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2', '1'),
  },
  mainnet: {
    chainId: 1,
    pool: null,
    router: null,
    collateralEngine: null,
    farmController: null,
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
      { ticker: 'TAC', assetId: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', underlying: null, unitScale: '1', decimals: 8, native: false, live: false },
      ...day1ConfidentialAssets(null, '10000000000'),
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
  if (o.farmController) d.farmController = o.farmController;
  if (o.deployBlock != null) d.deployBlock = o.deployBlock;
  const ids = o.assetIds || {};
  const byTicker = { cETH: ids.cEth, cTAC: ids.cTac, cBTC: ids.cBtc, cUSD: ids.cUsd };
  const liveSet = Array.isArray(o.live) ? new Set(o.live) : null; // opt-in --live <tickers>; absent ⇒ leave the static gate
  for (const a of d.assets) {
    const id = byTicker[a.ticker];
    if (id) a.assetId = id;
    if (a.ticker === 'cTAC' && o.tac) a.underlying = o.tac; // escrow-wrapped TAC pulls the TAC ERC20
    if (liveSet && liveSet.has(a.ticker)) a.live = true;
  }
}

// Active network — set once by tacit.js from currentNetworkName() so the standalone confidential tab
// modules resolve the right deployment without threading the network through every render call.
let _active = 'signet';
export function setActiveNetwork(net) { if (net && CONFIDENTIAL_DEPLOYMENTS[net]) _active = net; }
export function activeNetwork() { return _active; }
export function getConfidentialDeployment(net) { return CONFIDENTIAL_DEPLOYMENTS[net || _active] || null; }
