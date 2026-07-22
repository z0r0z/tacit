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
export function quoteRelayFee({ op, tradeSizeUsd = 0, liveGasGwei, provePriceUsd, ethPriceUsd }) {
  const gas = OP_GAS[op] ?? DEFAULT_OP_GAS;
  const gwei = Number(liveGasGwei ?? 1);
  const provePx = Number(provePriceUsd ?? CFG.provePriceUsd);
  const ethPx = Number(ethPriceUsd ?? CFG.ethPriceUsd); // live feed when the caller supplies one

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

// Native-ETH sentinel for zQuoter/zRouter (address(0) = ETH in-route).
const ETH = '0x0000000000000000000000000000000000000000';

// Fee assets the relay accumulates. The settle fee is paid to msg.sender via the pool's
// _payout, which delivers the *underlying* — native ETH (force-sent), the escrow ERC20
// (USDC/USDT/wstETH), or a pool-minted canonical ERC20 — never a confidential note. So
// there is NO unwrap leg: FEE_ASSETS is just the list of underlying tokens we convert to
// PROVE. address(0) (or "eth") = native ETH. TAC is deliberately omitted — we hold the
// platform token rather than dump it.
function feeAssets() {
  const raw = process.env.FEE_ASSETS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
    .map((a) => (/^0x0{40}$/i.test(a) || a.toLowerCase() === 'eth') ? ETH : getAddress(a));
}

async function erc20Balance(token, owner) {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
}

// Don't sweep ETH dust (the swap gas would exceed the value). Only the surplus above the
// gas buffer + this floor is converted to PROVE; the buffer stays as native gas.
const MIN_ETH_SWEEP = BigInt(process.env.MIN_ETH_SWEEP_WEI || '5000000000000000'); // 0.005 ETH

async function ensureApproval(token, spender, amount) {
  const owner = relayWallet.account.address;
  const cur = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
  if (cur >= amount) return;
  log(`approving ${spender} for token ${token}`);
  const h = await relayWallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
  await publicClient.waitForTransactionReceipt({ hash: h });
}

const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || 100); // 1%

// One-time max approvals so every subsequent sweep is a bare swap (no per-swap approve tx):
// each ERC20 fee asset -> zRouter, and PROVE -> vApp for the deposit. Native ETH needs none.
async function maxPreApprove(assets) {
  const owner = relayWallet.account.address;
  const pairs = assets.filter((a) => a !== ETH).map((a) => [a, ZROUTER]);
  pairs.push([PROVE, VAPP]);
  for (const [token, spender] of pairs) {
    const cur = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
    if (cur >= maxUint256 / 2n) continue; // already effectively unlimited
    log(`pre-approving ${spender} for ${token}`);
    const h = await relayWallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
}

// zQuoter.buildSwapAuto returns ready-to-fire zRouter callData + msgValue for the best route,
// multihopping through the ETH/WETH hub when a token's PROVE liquidity sits behind it
// (UniV2/Sushi/zAMM/UniV3/UniV4/Curve/Lido). exactOut=false ⇒ exact-in. `to` = recipient.
async function quote(tokenIn, tokenOut, amountIn, recipient, exactOut = false) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const [best, callData, amountLimit, msgValue] = await publicClient.readContract({
    address: ZQUOTER, abi: ZQUOTER_ABI, functionName: 'buildSwapAuto',
    args: [recipient, exactOut, tokenIn, tokenOut, amountIn, SLIPPAGE_BPS, deadline],
  });
  return { amountIn: best.amountIn, amountOut: best.amountOut, callData, amountLimit, msgValue };
}

// Fire the quoted route: send the zQuoter callData straight at zRouter (to: zRouter,
// data: callData, value: msgValue). Approvals are set once up front (maxPreApprove);
// native-ETH routes carry their input in msgValue. No manual route/fee-tier picking.
async function fireSwap(quoted) {
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
  const assets = feeAssets();
  if (assets.length === 0) { log('FEE_ASSETS empty — nothing to sweep (manual PROVE top-up mode)'); return; }

  // One-time max approvals (zRouter + vApp) so the loop is pure swaps.
  await maxPreApprove(assets);

  const buffer = CFG.ethGasBufferWei;

  // Bias: keep native ETH as gas (only the surplus over the buffer goes to PROVE); convert the
  // stablecoins/wstETH fully to PROVE to cover network basis. Hold TAC (never in FEE_ASSETS).
  for (const asset of assets) {
    try {
      if (asset === ETH) {
        const ethBal = await publicClient.getBalance({ address: owner });
        const surplus = ethBal > buffer ? ethBal - buffer : 0n;
        if (surplus < MIN_ETH_SWEEP) { log(`ETH ${ethBal} ≤ buffer+dust — keeping as gas`); continue; }
        const q = await quote(ETH, PROVE, surplus, owner);
        log(`  ETH surplus ${surplus} -> ~${q.amountOut} PROVE`);
        await fireSwap(q);
        continue;
      }

      const bal = await erc20Balance(asset, owner);
      if (bal === 0n) continue;
      log(`fee asset ${asset} balance=${bal}`);

      // If ETH is below the gas buffer, first buy just enough ETH from this asset (exact-out),
      // then convert whatever's left to PROVE.
      const ethBal = await publicClient.getBalance({ address: owner });
      if (ethBal < buffer) {
        const need = buffer - ethBal;
        try {
          const qe = await quote(asset, ETH, need, owner, /* exactOut */ true);
          if (qe.amountIn > 0n && qe.amountIn <= bal) {
            log(`  gas top-up: ~${qe.amountIn} ${asset} -> ${need} ETH`);
            await fireSwap(qe);
          }
        } catch (e) { log(`  gas top-up quote failed (continuing to PROVE): ${e.message}`); }
      }

      const rem = await erc20Balance(asset, owner);
      if (rem > 0n) {
        const q = await quote(asset, PROVE, rem, owner);
        log(`  ${rem} ${asset} -> ~${q.amountOut} PROVE`);
        await fireSwap(q);
      }
    } catch (e) {
      log(`  sweep for ${asset} failed (continuing): ${e.message}`);
    }
  }

  // Deposit all accumulated PROVE to the vApp (top up the network prover balance).
  try { await depositProveToVApp(); }
  catch (e) { log(`vApp deposit failed: ${e.message}`); }

  log('replenish done');
}

// Run only when invoked directly (also imported by settle-relay for quoteRelayFee).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
