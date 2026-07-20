// seed-pool-planner — plan minimal cETH-backed seeds for the day-1 confidential pools at live market prices.
//
// For each day-1 asset we want a live cX/cETH pool. First-mint sets the price (shares = isqrt(dA·dB)), so
// seeding at the market ratio establishes the correct starting price. This reads live USD prices (keyless
// Coinbase spot) + the wstETH on-chain ratio, computes reserveX for a chosen cETH seed, and checks which
// pools already exist on-chain so we only seed the empty ones.
//
//   reserveX_tokens = seedEth · ETH_usd / X_usd     (pool spot ETH-per-X == market X_usd/ETH_usd)
//
// Run:  SEED_CETH=0.002 node tools/seed-pool-planner.mjs
import { secp, sha256, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { setActiveNetwork, getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const SEED_CETH = Number(process.env.SEED_CETH || '0.002'); // cETH per pool (in ETH)
const FEE_BPS = 30n;

async function coinbaseSpot(pair) {
  const r = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
  if (!r.ok) throw new Error(`coinbase ${pair} ${r.status}`);
  return Number((await r.json()).data.amount);
}

// wstETH → ETH ratio via stEthPerToken() on the wstETH token (fallback to a static ratio if RPC is down).
async function wstEthPerToken(rpc) {
  const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
  try {
    const data = '0x' + keccakSelector('stEthPerToken()');
    const res = await rpc('eth_call', [{ to: WSTETH, data }, 'latest']);
    if (res && res !== '0x') return Number(BigInt(res)) / 1e18;
  } catch { /* fall through */ }
  return 1.2; // conservative fallback
}
function keccakSelector(sig) {
  return Array.from(keccak_256(new TextEncoder().encode(sig)).slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  setActiveNetwork('mainnet');
  const d = getConfidentialDeployment('mainnet');
  const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256 });
  const cETH = ux.assetByTicker?.['cETH'];
  if (!cETH) throw new Error('cETH not resolved');

  const [ethUsd, btcUsd] = await Promise.all([coinbaseSpot('ETH-USD'), coinbaseSpot('BTC-USD')]);
  const wstRatio = await wstEthPerToken(ux.rpc);
  const wstUsd = ethUsd * wstRatio;
  console.log(`live: ETH $${ethUsd}  BTC $${btcUsd}  wstETH $${wstUsd.toFixed(0)} (ratio ${wstRatio.toFixed(4)})  USDC/USDT/cUSD $1`);
  console.log(`seed: ${SEED_CETH} cETH per pool @ ${FEE_BPS}bps\n`);

  // Target USD price per unit of each asset's underlying.
  const priceUsd = { cUSDC: 1, cUSDT: 1, cUSD: 1, cBTC: btcUsd, cwstETH: wstUsd };
  const decOf = (t) => (ux.assetByTicker?.[t]?.tacitDecimals) || 8;
  const ethDec = decOf('cETH');
  const seedEthUnits = BigInt(Math.round(SEED_CETH * 10 ** ethDec));

  for (const ticker of ['cUSDC', 'cUSDT', 'cwstETH', 'cBTC', 'cUSD', 'cTAC']) {
    const a = ux.assetByTicker?.[ticker];
    if (!a) { console.log(`${ticker.padEnd(8)} — not resolved (skip)`); continue; }
    let reserves = null;
    try { reserves = await ux.poolReserves(ux.routePoolId(a.assetId, cETH.assetId, FEE_BPS)); } catch { /* ignore */ }
    const live = reserves && (BigInt(reserves.reserveA) > 0n || BigInt(reserves.reserveB) > 0n);
    if (ticker === 'cTAC') { // no external feed; report existing pool state only
      console.log(`${ticker.padEnd(8)} ${live ? `LIVE (A=${reserves.reserveA} B=${reserves.reserveB})` : 'empty'} — protocol token, price from pool`);
      continue;
    }
    const px = priceUsd[ticker];
    const tokens = (SEED_CETH * ethUsd) / px;               // reserveX in whole tokens
    const units = BigInt(Math.round(tokens * 10 ** decOf(ticker)));
    console.log(`${ticker.padEnd(8)} ${live ? 'LIVE (skip)' : 'SEED'}  → ${tokens.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${ticker} (${units} units)  +  ${SEED_CETH} cETH (${seedEthUnits} units)`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
