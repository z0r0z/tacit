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
import { CFG, OP_GAS, DEFAULT_OP_GAS, OP_PROVE, MAINTENANCE_RUNS_PER_DAY } from './lib/config.js';
import {
  publicClient, relayWallet, fundedWallets, ERC20_ABI, VAPP_ABI, ZQUOTER_ABI, ZROUTER_ABI,
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

  // The maintenance lane's share. Bitcoin header attestation (and the reflection folding that rides the
  // same wallet) is what keeps the bridge working in both directions and the fast lane usable, but no user
  // pays a fee for it — so if it is left out of the cost model the relay prices every op below its true
  // cost and bleeds exactly as fast as it works. Amortise the daily maintenance burn across the ops we
  // expect to serve in a day.
  //
  // At low volume this term dominates, which is not a modelling artefact: it is the real reason a quiet
  // relay cannot fund itself, and it should be visible in the quote rather than discovered in the balance.
  const maintenanceUsdPerDay = MAINTENANCE_RUNS_PER_DAY * Number(OP_GAS.maintenance) * gwei * 1e-9 * ethPx;
  const maintenanceCostUsd = maintenanceUsdPerDay / Math.max(1, CFG.expectedOpsPerDay);

  const costUsd = gasCostUsd + proveCostUsd + maintenanceCostUsd;

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
    gasCostUsd, proveCostUsd, maintenanceCostUsd, costUsd,
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

async function ensureApproval(token, spender, amount, wallet = relayWallet) {
  const owner = wallet.account.address;
  const cur = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
  if (cur >= amount) return;
  log(`approving ${spender} for token ${token} (owner ${owner})`);
  const h = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
  await publicClient.waitForTransactionReceipt({ hash: h });
}

const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || 100); // 1%

// One-time max approvals so every subsequent sweep is a bare swap (no per-swap approve tx):
// each ERC20 fee asset -> zRouter, and PROVE -> vApp for the deposit. Native ETH needs none.
async function maxPreApprove(assets, wallet = relayWallet) {
  const owner = wallet.account.address;
  const pairs = assets.filter((a) => a !== ETH).map((a) => [a, ZROUTER]);
  pairs.push([PROVE, VAPP]);
  for (const [token, spender] of pairs) {
    const cur = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
    if (cur >= maxUint256 / 2n) continue; // already effectively unlimited
    log(`pre-approving ${spender} for ${token} (owner ${owner})`);
    const h = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
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

// Live PROVE price in USD, via the same router the relay actually buys PROVE through: quote PROVE -> ETH
// and convert at the live ETH price. That makes the cost model track what replenishing genuinely costs
// rather than a constant. Probe size is batch-representative, so the quote carries the price impact a real
// top-up would pay. Clamped to a band around the static value: PROVE is ~10% of per-op cost, but a broken or
// manipulated quote should never be able to swing the fee gate wildly in either direction.
let _provePx = { at: 0, v: null };
const PROVE_PROBE = 100_000_000_000_000_000_000n; // 100 PROVE (18dp)
export async function provePriceUsd(ethPriceUsd) {
  if (Date.now() - _provePx.at < 300_000 && _provePx.v) return _provePx.v;
  const fallback = CFG.provePriceUsd;
  try {
    const ethPx = Number(ethPriceUsd ?? CFG.ethPriceUsd);
    const q = await quote(PROVE, ETH, PROVE_PROBE, relayWallet.account.address);
    if (!q?.amountOut || q.amountOut <= 0n) return fallback;
    const ethOut = Number(q.amountOut) / 1e18;          // ETH received for the probe
    const usd = (ethOut * ethPx) / (Number(PROVE_PROBE) / 1e18); // USD per PROVE
    if (!Number.isFinite(usd) || usd <= 0) return fallback;
    const clamped = Math.min(Math.max(usd, fallback / 10), fallback * 10);
    _provePx = { at: Date.now(), v: clamped };
    return clamped;
  } catch { return fallback; }
}

// Fire the quoted route: send the zQuoter callData straight at zRouter (to: zRouter,
// data: callData, value: msgValue). Approvals are set once up front (maxPreApprove);
// native-ETH routes carry their input in msgValue. No manual route/fee-tier picking.
async function fireSwap(quoted, wallet = relayWallet) {
  const h = await wallet.sendTransaction({ to: ZROUTER, data: quoted.callData, value: quoted.msgValue || 0n });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
  if (rcpt.status !== 'success') throw new Error(`zRouter swap reverted ${h}`);
  return h;
}

// Deposits the wallet's PROVE into the vApp. DEPOSIT_AMOUNT_WEI caps how much goes in (default: the
// whole balance, the sweep-loop behaviour) — a bounded deposit keeps the rest of the treasury out of
// the prover account when topping up for one known job.
async function depositProveToVApp(wallet = relayWallet) {
  const owner = wallet.account.address;
  const bal = await erc20Balance(PROVE, owner);
  if (bal === 0n) { log('no PROVE to deposit'); return; }
  const cap = process.env.DEPOSIT_AMOUNT_WEI ? BigInt(process.env.DEPOSIT_AMOUNT_WEI) : bal;
  const amt = cap < bal ? cap : bal;
  if (amt === 0n) { log('DEPOSIT_AMOUNT_WEI=0 — nothing to deposit'); return; }
  await ensureApproval(PROVE, VAPP, amt, wallet);
  log(`depositing ${amt} PROVE to vApp ${VAPP} from ${owner} (wallet balance ${bal})`);
  const h = await wallet.writeContract({ address: VAPP, abi: VAPP_ABI, functionName: 'deposit', args: [amt] });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
  if (rcpt.status !== 'success') throw new Error(`vApp deposit reverted ${h}`);
  log(`vApp deposit ok: tx=${h}`);
}

async function main() {
  const owner = relayWallet.account.address;
  log(`replenish start — relay=${owner}`);
  // DEPOSIT_ONLY: skip the fee-asset sweep entirely and just move PROVE into the vApp. The sweep
  // early-returns when FEE_ASSETS is unset ("manual top-up mode"), which also skipped the deposit —
  // so a manual top-up previously had no path through this job at all.
  if (process.env.DEPOSIT_ONLY === '1') {
    log('DEPOSIT_ONLY=1 — skipping fee sweep, depositing PROVE only');
    await depositProveToVApp();
    log('replenish done (deposit only)');
    return;
  }
  const buffer = CFG.ethGasBufferWei;
  const assets = feeAssets();
  if (assets.length === 0) { log('FEE_ASSETS empty — nothing to sweep (manual PROVE top-up mode)'); return; }

  // Sweep and fund EVERY wallet the relay spends from, not just RELAY_KEY.
  //
  // The two roles genuinely differ in where value lands. The SETTLE wallet is msg.sender on every settle,
  // so the pool's `_payout` credits the fee to it and its own gas is what the settle burns — it both earns
  // and spends. The RELAY wallet pays for the maintenance lane (header attestation, reflection), which
  // earns nothing. Sweeping only `relayWallet`, as this loop used to, therefore looked for fees where they
  // never arrive and topped up the wallet that was not paying for settles.
  //
  // Funding each wallet from its OWN fee income keeps that honest, and self-corrects when the keys are
  // consolidated: SETTLE_KEY defaults to RELAY_KEY, in which case this is one wallet and one pass.
  for (const { address: owner, wallet, roles } of fundedWallets) {
    log(`— wallet ${owner} (${roles.join('+')})`);
    try { await maxPreApprove(assets, wallet); }
    catch (e) { log(`  pre-approve failed (continuing): ${e.message}`); }

    // Bias: keep native ETH as gas (only the surplus over the buffer goes to PROVE); convert the
    // stablecoins/wstETH fully to PROVE to cover network basis. Hold TAC (never in FEE_ASSETS).
    for (const asset of assets) {
      try {
        if (asset === ETH) {
          const ethBal = await publicClient.getBalance({ address: owner });
          const surplus = ethBal > buffer ? ethBal - buffer : 0n;
          if (surplus < MIN_ETH_SWEEP) { log(`  ETH ${ethBal} <= buffer+dust — keeping as gas`); continue; }
          const q = await quote(ETH, PROVE, surplus, owner);
          log(`  ETH surplus ${surplus} -> ~${q.amountOut} PROVE`);
          await fireSwap(q, wallet);
          continue;
        }

        const bal = await erc20Balance(asset, owner);
        if (bal === 0n) continue;
        log(`  fee asset ${asset} balance=${bal}`);

        // If ETH is below the gas buffer, first buy just enough ETH from this asset (exact-out),
        // then convert whatever's left to PROVE. Gas before PROVE is the right order: a wallet that
        // cannot pay for a transaction cannot buy PROVE either, so the gas leg has to clear first.
        const ethBal = await publicClient.getBalance({ address: owner });
        if (ethBal < buffer) {
          const need = buffer - ethBal;
          try {
            const qe = await quote(asset, ETH, need, owner, /* exactOut */ true);
            if (qe.amountIn > 0n && qe.amountIn <= bal) {
              log(`  gas top-up: ~${qe.amountIn} ${asset} -> ${need} ETH`);
              await fireSwap(qe, wallet);
            }
          } catch (e) { log(`  gas top-up quote failed (continuing to PROVE): ${e.message}`); }
        }

        const rem = await erc20Balance(asset, owner);
        if (rem > 0n) {
          const q = await quote(asset, PROVE, rem, owner);
          log(`  ${rem} ${asset} -> ~${q.amountOut} PROVE`);
          await fireSwap(q, wallet);
        }
      } catch (e) {
        log(`  sweep for ${asset} failed (continuing): ${e.message}`);
      }
    }

    // Deposit this wallet's accumulated PROVE to the vApp (top up the network prover balance).
    try { await depositProveToVApp(wallet); }
    catch (e) { log(`  vApp deposit failed: ${e.message}`); }
  }

  log('replenish done');
}

// Run only when invoked directly (also imported by settle-relay for quoteRelayFee).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
