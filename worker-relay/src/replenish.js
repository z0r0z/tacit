// ─────────────────────────────────────────────────────────────────────────────
// Replenish — the self-subsidizing flywheel (ops/PRICING-RELAY-ECONOMICS.md).
//
// Render service type: Cron Job (e.g. every 30-60 min). Runs once and exits.
//
//   1. Read accumulated fee-asset balances (the proof-bound fees the relay collected).
//   2. zQuoter → best route fee-asset -> PROVE and fee-asset -> ETH.
//   3. zRouter (Uniswap V4) → execute the swaps, keeping an ETH gas buffer.
//   4. approve + deposit(PROVE) to the Succinct vApp → top up the network prover balance.
//
// Also exports quoteRelayFee() — the dynamic fee the dapp shows at quote time and the
// settle feeGate uses. Self-sustaining iff fee_collected ≥ PROVE_cost + gas_cost per op.
// ─────────────────────────────────────────────────────────────────────────────

import { getAddress, maxUint256 } from 'viem';
import { CFG, OP_GAS, DEFAULT_OP_GAS, OP_PROVE } from './lib/config.js';
import {
  publicClient, relayWallet, ERC20_ABI, VAPP_ABI, ZQUOTER_ABI, ZROUTER_ABI,
  PROVE, VAPP, ZQUOTER, ZROUTER,
} from './lib/chain.js';

const log = (...a) => console.log(`[replenish ${new Date().toISOString()}]`, ...a);

// ── Dynamic fee math (PRICING-RELAY-ECONOMICS.md §Pricing recommendation) ──
//   per_op_cost = live_gas_cost(op) + live_PROVE_cost(op)
//   fee         = max(MIN_FLOOR, per_op_cost * (1 + OPS_MARGIN))
//   displayed_bps = fee / trade_size, capped at BPS_CAP
// gas dominates (~100x PROVE); the fee is really a dynamic gas-abstraction fee.
export function quoteRelayFee({ op, tradeSizeUsd = 0, liveGasGwei, provePriceUsd }) {
  const gas = OP_GAS[op] ?? DEFAULT_OP_GAS;
  const gwei = Number(liveGasGwei ?? 1);
  const provePx = Number(provePriceUsd ?? CFG.provePriceUsd);
  const ethPx = CFG.ethPriceUsd;

  // gas cost USD = gas * gwei * 1e-9 ETH/gas * ethPriceUsd
  const gasCostUsd = Number(gas) * gwei * 1e-9 * ethPx;
  const proveCostUsd = OP_PROVE * provePx;
  const costUsd = gasCostUsd + proveCostUsd;

  const marginedUsd = costUsd * (1 + CFG.opsMargin);
  let feeUsd = Math.max(CFG.minFloorUsd, marginedUsd);

  // Cap the DISPLAYED bps for mid/large trades (never overcharge). Above the size where
  // cost/size < cap, the fee is just cost+margin (fractions of a bp).
  let displayedBps = tradeSizeUsd > 0 ? (feeUsd / tradeSizeUsd) * 10_000 : Infinity;
  if (tradeSizeUsd > 0 && displayedBps > CFG.bpsCap) {
    // Honor the cap only when it still covers cost; if the cap can't cover cost (tiny trade),
    // the floor already applies and self-settle is the honest option (flagged below).
    const cappedFeeUsd = (CFG.bpsCap / 10_000) * tradeSizeUsd;
    if (cappedFeeUsd >= costUsd) { feeUsd = Math.max(CFG.minFloorUsd, cappedFeeUsd); displayedBps = CFG.bpsCap; }
  }

  return {
    op, tradeSizeUsd,
    gasCostUsd, proveCostUsd, costUsd,
    feeUsd,
    displayedBps: tradeSizeUsd > 0 ? (feeUsd / tradeSizeUsd) * 10_000 : null,
    belowFloor: marginedUsd < CFG.minFloorUsd, // caller may recommend self-settle
  };
}

// Fee assets the relay accumulates. Configure via env FEE_ASSETS as a comma list of
// ERC20 addresses (the confidential wrappers: cUSDC / cETH / …). PROVE and ETH are the
// targets, not sources.
function feeAssets() {
  const raw = process.env.FEE_ASSETS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map(getAddress);
}

async function erc20Balance(token, owner) {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
}

// Split an accumulated fee-asset balance between PROVE top-up and ETH gas, then swap.
// PROVE_SPLIT_BPS of value goes to PROVE, the rest to ETH (default 50/50).
const PROVE_SPLIT_BPS = Number(process.env.PROVE_SPLIT_BPS || 5000);

async function ensureApproval(token, spender, amount) {
  const owner = relayWallet.account.address;
  const cur = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
  if (cur >= amount) return;
  log(`approving ${spender} for token ${token}`);
  const h = await relayWallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
  await publicClient.waitForTransactionReceipt({ hash: h });
}

const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || 100); // 1%
const WETH = getAddress(process.env.WETH_ADDR || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');

// zQuoter.buildBestSwap returns ready-to-fire zRouter callData + msgValue for the best route
// (V4/V3/V2/curve — auto-selected). exactOut=false ⇒ exact-in. `to` = the swap recipient.
async function quote(tokenIn, tokenOut, amountIn, recipient) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const [best, callData, amountLimit, msgValue] = await publicClient.readContract({
    address: ZQUOTER, abi: ZQUOTER_ABI, functionName: 'buildBestSwap',
    args: [recipient, false, tokenIn, tokenOut, amountIn, SLIPPAGE_BPS, deadline],
  });
  return { amountOut: best.amountOut, callData, amountLimit, msgValue };
}

// Fire the quoted route: approve tokenIn to zRouter, then send the zQuoter callData straight at
// zRouter (to: zRouter, data: callData, value: msgValue). No manual route/fee-tier picking.
async function swap(tokenIn, tokenOut, amountIn, quoted, _recipient) {
  await ensureApproval(tokenIn, ZROUTER, amountIn);
  const h = await relayWallet.sendTransaction({ to: ZROUTER, data: quoted.callData, value: quoted.msgValue || 0n });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
  if (rcpt.status !== 'success') throw new Error(`zRouter swap reverted ${h}`);
  return h;
}

async function depositProveToVApp() {
  const owner = relayWallet.account.address;
  const bal = await erc20Balance(PROVE, owner);
  if (bal === 0n) { log('no PROVE to deposit'); return; }
  await ensureApproval(PROVE, VAPP, bal);
  log(`depositing ${bal} PROVE to vApp ${VAPP}`);
  const h = await relayWallet.writeContract({ address: VAPP, abi: VAPP_ABI, functionName: 'deposit', args: [bal] });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
  if (rcpt.status !== 'success') throw new Error(`vApp deposit reverted ${h}`);
  log(`vApp deposit ok: tx=${h}`);
}

async function main() {
  const owner = relayWallet.account.address;
  log(`replenish start — relay=${owner}`);

  // 1. ETH gas buffer check.
  const ethBal = await publicClient.getBalance({ address: owner });
  const needEth = ethBal < CFG.ethGasBufferWei;
  log(`ETH balance=${ethBal} buffer=${CFG.ethGasBufferWei} ${needEth ? '(BELOW buffer — will top up)' : '(ok)'}`);

  // 2. For each fee asset, split → PROVE + (if needed) ETH.
  for (const asset of feeAssets()) {
    const bal = await erc20Balance(asset, owner);
    if (bal === 0n) continue;
    log(`fee asset ${asset} balance=${bal}`);
    const toProve = (bal * BigInt(PROVE_SPLIT_BPS)) / 10_000n;
    const toEth = bal - toProve;
    try {
      if (toProve > 0n) {
        const q = await quote(asset, PROVE, toProve, owner);
        log(`  ${toProve} ${asset} -> ~${q.amountOut} PROVE`);
        await swap(asset, PROVE, toProve, q, owner);
      }
      if (toEth > 0n && needEth) {
        const q = await quote(asset, WETH, toEth, owner);
        log(`  ${toEth} ${asset} -> ~${q.amountOut} ETH (gas buffer)`);
        // recipient=owner; TODO: confirm zRouter unwraps WETH->ETH or emit an unwrap leg.
        await swap(asset, WETH, toEth, q, owner);
      }
    } catch (e) {
      log(`  swap for ${asset} failed (continuing): ${e.message}`);
    }
  }

  // 3. Deposit all accumulated PROVE to the vApp (top up the network prover balance).
  try { await depositProveToVApp(); }
  catch (e) { log(`vApp deposit failed: ${e.message}`); }

  log('replenish done');
}

// Run only when invoked directly (also imported by settle-relay for quoteRelayFee).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
