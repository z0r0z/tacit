// TacBuyback keeper (contracts/src/TacBuyback.sol). One pass per run, meant for a cron: if the contract holds ETH
// and its cooldown has passed, quote both venues at the largest size each allows, buy on the better one with a
// slippage-bounded minimum and a short deadline, and exit. Submitted through private endpoints only.
//
// Runs on its own key (BUYBACK_KEEPER_KEY), never the relay key: the keeper can only buy into the reserve, so a
// leak is bounded by the contract, and keeping it off the relay key keeps it off that key's nonce.
//   BUYBACK_DRY_RUN=1 quotes and logs without sending.

import { createPublicClient, createWalletClient, fallback, http } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { maxBuyFor, chooseBuy, cooldownLeft, VENUE_TACIT, VENUE_PRECISION } from './lib/buyback-plan.js';

const log = (...a) => console.log(`[buyback ${new Date().toISOString()}]`, ...a);
const env = process.env;

const BUYBACK = env.BUYBACK_ADDR || '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250';
const SLIPPAGE_BPS = Number(env.BUYBACK_SLIPPAGE_BPS || 50);
const MIN_BUY_WEI = BigInt(env.BUYBACK_MIN_BUY_WEI || '1000000000000000'); // 0.001 ETH: below this the gas isn't worth it
const DEADLINE_SECS = Number(env.BUYBACK_DEADLINE_SECS || 300);
const DRY_RUN = env.BUYBACK_DRY_RUN === '1';
const READ_RPCS = [env.RPC_URL, ...(env.RPC_URLS_FALLBACK || 'https://ethereum-rpc.publicnode.com').split(',')].filter(Boolean);
const SEND_RPCS = (env.SETTLE_RPC_URLS || 'https://rpc.flashbots.net,https://rpc.mevblocker.io').split(',').filter(Boolean);

const BUYBACK_ABI = [
  ...['AMM', 'PRECISION', 'KEEPER'].map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] })),
  ...['ETH_ASSET', 'TAC_ASSET', 'POOL_ID'].map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] })),
  ...['UNIT', 'MAX_PER_BUY', 'COOLDOWN', 'MAX_IMPACT_BPS', 'lastBuyAt'].map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] })),
  { type: 'function', name: 'FEE_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }], outputs: [{ type: 'uint256' }] },
];
const AMM_ABI = [
  { type: 'function', name: 'POOL', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'quoteSwap', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
];
const POOL_ABI = [{ type: 'function', name: 'pools', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [
  { type: 'bool' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'uint256' }] }];
const PRECISION_ABI = [
  { type: 'function', name: 'reserve0', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'quoteExactIn', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }, { type: 'bool' }] },
];

async function main() {
  const pub = createPublicClient({ chain: mainnet, transport: fallback(READ_RPCS.map((u) => http(u))) });
  const read = (functionName, address = BUYBACK, abi = BUYBACK_ABI, args = []) => pub.readContract({ address, abi, functionName, args });

  const [balance, lastBuyAt, cooldown, keeperAddr] = await Promise.all([
    pub.getBalance({ address: BUYBACK }), read('lastBuyAt'), read('COOLDOWN'), read('KEEPER'),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const wait = cooldownLeft({ lastBuyAt, cooldown, now });
  if (balance === 0n) { log('holds no ETH — nothing to buy'); return; }
  if (wait > 0) { log(`cooldown: ${wait}s left (holds ${balance} wei)`); return; }

  const [amm, precision, ethAsset, tacAsset, poolId, feeBps, unit, maxPerBuy, maxImpactBps] = await Promise.all([
    read('AMM'), read('PRECISION'), read('ETH_ASSET'), read('TAC_ASSET'), read('POOL_ID'), read('FEE_BPS'),
    read('UNIT'), read('MAX_PER_BUY'), read('MAX_IMPACT_BPS'),
  ]);
  const bounds = { balance, maxPerBuy, unit, maxImpactBps };
  const quotes = [];

  try {
    const pool = await read('POOL', amm, AMM_ABI);
    const [, assetA,, reserveA, reserveB] = await read('pools', pool, POOL_ABI, [poolId]);
    const ethReserveWei = (assetA.toLowerCase() === ethAsset.toLowerCase() ? reserveA : reserveB) * unit;
    const amountIn = maxBuyFor({ ...bounds, ethReserveWei });
    if (amountIn > 0n) {
      const tacOut = await read('quoteSwap', amm, AMM_ABI, [ethAsset, tacAsset, feeBps, amountIn]);
      quotes.push({ venue: VENUE_TACIT, amountIn, tacOut });
    }
  } catch (e) { log(`tacit venue unavailable: ${e.shortMessage || e.message}`); }

  if (precision !== '0x0000000000000000000000000000000000000000') {
    try {
      const ethReserveWei = await read('reserve0', precision, PRECISION_ABI);
      const amountIn = maxBuyFor({ ...bounds, ethReserveWei });
      if (amountIn > 0n) {
        const [tacOut, fits] = await read('quoteExactIn', precision, PRECISION_ABI, [BUYBACK, '0x0000000000000000000000000000000000000000', amountIn]);
        if (fits) quotes.push({ venue: VENUE_PRECISION, amountIn, tacOut });
      }
    } catch (e) { log(`precision venue unavailable: ${e.shortMessage || e.message}`); }
  }

  for (const q of quotes) log(`quote venue=${q.venue} ${q.amountIn} wei -> ${q.tacOut} TAC-wei`);
  const plan = chooseBuy(quotes, { minBuyWei: MIN_BUY_WEI, slippageBps: SLIPPAGE_BPS });
  if (!plan) { log(`no buy: nothing sized above ${MIN_BUY_WEI} wei on either venue (holds ${balance} wei)`); return; }
  const deadline = BigInt(now + DEADLINE_SECS);
  log(`plan: venue=${plan.venue} amountIn=${plan.amountIn} minTacOut=${plan.minTacOut} deadline=${deadline}`);
  if (DRY_RUN) { log('dry run — not sending'); return; }

  if (!env.BUYBACK_KEEPER_KEY) throw new Error('BUYBACK_KEEPER_KEY is not set');
  const account = privateKeyToAccount(env.BUYBACK_KEEPER_KEY);
  if (account.address.toLowerCase() !== keeperAddr.toLowerCase()) throw new Error(`BUYBACK_KEEPER_KEY is ${account.address}, the contract's keeper is ${keeperAddr}`);

  const args = [plan.venue, plan.amountIn, plan.minTacOut, deadline];
  await pub.simulateContract({ address: BUYBACK, abi: BUYBACK_ABI, functionName: 'buy', args, account });
  // Private submission only: a public buy with a known minimum is an invitation to be sandwiched down to it.
  for (const url of SEND_RPCS) {
    try {
      const wallet = createWalletClient({ account, chain: mainnet, transport: http(url) });
      const hash = await wallet.writeContract({ address: BUYBACK, abi: BUYBACK_ABI, functionName: 'buy', args });
      log(`sent ${hash} via ${new URL(url).host}`);
      const r = await pub.waitForTransactionReceipt({ hash, timeout: DEADLINE_SECS * 1000 });
      log(`${r.status} in block ${r.blockNumber}`);
      return;
    } catch (e) { log(`submit via ${url} failed: ${e.shortMessage || e.message}`); }
  }
  throw new Error('every private endpoint refused the buy');
}

main().catch((e) => { log('failed:', e?.stack || e); process.exit(1); });
