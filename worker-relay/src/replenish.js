// ─────────────────────────────────────────────────────────────────────────────
// Replenish — the self-subsidizing flywheel.
//
// Render service type: Cron Job (e.g. every 30-60 min). Runs once and exits.
//
//   1. Read accumulated fee-asset balances (the proof-bound fees the relay collected).
//   2. zQuoter → best route fee-asset -> PROVE and fee-asset -> ETH.
//   3. zRouter → execute the swaps, keeping an ETH gas buffer.
//   4. approve + deposit(PROVE) to the Succinct vApp → top up the network prover balance.
//
// Also exports quoteRelayFee() — the dynamic fee the dapp shows at quote time and the
// settle feeGate uses. Self-sustaining iff fee_collected ≥ PROVE_cost + gas_cost per op.
// ─────────────────────────────────────────────────────────────────────────────

import { getAddress, maxUint256 } from 'viem';
import { CFG, ADDR, OP_GAS, DEFAULT_OP_GAS, OP_PROVE, MAINTENANCE_RUNS_PER_DAY } from './lib/config.js';
import { withNonceRetry as _withNonceRetry } from './lib/nonce-retry.js';
import { proverCredit } from './lib/prover.js';
import { setProverCredit } from './lib/worker-client.js';
import { creditText } from './lib/prove-credit.js';
import { ledger } from './lib/income-ledger.js';
import { planBuyback, splitterDue } from './lib/income-allocation.js';
import { planTreasury, daysText, swapMinWei } from './lib/treasury-plan.js';
import { treasuryFloors } from './lib/settle-fees.js';
import { checkZRouterCall, decodeZRouterCall } from './lib/zrouter-guard.js';
import {
  publicClient, relayWallet, fundedWallets, ethUsdPrice, ERC20_ABI, VAPP_ABI, ZQUOTER_ABI, ZROUTER_ABI,
  PROVE, VAPP, ZQUOTER, ZROUTER,
} from './lib/chain.js';

const log = (...a) => console.log(`[replenish ${new Date().toISOString()}]`, ...a);

// ── Dynamic fee math ──
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

  // MARGINAL cost: what this one op costs us to do. Maintenance is a fixed running cost of the protocol, not
  // something one op causes, so it is amortised into the QUOTED price (costUsd) but is not what decides whether
  // an op is worth doing at all.
  const marginalCostUsd = gasCostUsd + proveCostUsd;
  const costUsd = marginalCostUsd + maintenanceCostUsd;

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
    gasCostUsd, proveCostUsd, maintenanceCostUsd, marginalCostUsd, costUsd,
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
export function feeAssets() {
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

// Shared with the header and reflection services, which sign from the same key — see lib/nonce-retry.js.
const withNonceRetry = (label, fn, tries = 3) => _withNonceRetry(label, fn, { tries, log });

// The fee a housekeeping send carries. viem prices a send at the node's own tip estimate and 1.2 times the base fee, a tip the settle path found
// too low to wait on (SETTLE_TIP_FLOOR_WEI) and a cap a rising base fee passes before the next block: the splitter's distribute went out ten
// times in a row and none was mined. Only base plus tip is paid; the rest of the cap is not.
async function sendFees() {
  try {
    const base = (await publicClient.getBlock({ blockTag: 'latest' })).baseFeePerGas;
    if (base == null) return {};
    return { maxFeePerGas: base * 3n + CFG.settleTipFloorWei, maxPriorityFeePerGas: CFG.settleTipFloorWei };
  } catch { return {}; }
}

async function ensureApproval(token, spender, amount, wallet = relayWallet) {
  const owner = wallet.account.address;
  const cur = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
  if (cur >= amount) return;
  log(`approving ${spender} for token ${token} (owner ${owner})`);
  const h = await withNonceRetry('approve', () => wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] }));
  await publicClient.waitForTransactionReceipt({ hash: h });
}

const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || 100); // 1%

// One-time max approvals so every subsequent sweep is a bare swap (no per-swap approve tx):
// each ERC20 fee asset -> zRouter, and PROVE -> vApp for the deposit. Native ETH needs none.
async function maxPreApprove(assets, wallet = relayWallet, includeProve = true) {
  const owner = wallet.account.address;
  const pairs = assets.filter((a) => a !== ETH).map((a) => [a, ZROUTER]);
  if (includeProve) pairs.push([PROVE, VAPP]); // only needed to deposit; a gas-only pass never touches PROVE
  for (const [token, spender] of pairs) {
    const cur = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
    if (cur >= maxUint256 / 2n) continue; // already effectively unlimited
    log(`pre-approving ${spender} for ${token} (owner ${owner})`);
    const h = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
}

// zQuoter has no single "auto, try everything" entrypoint (see chain.js's ZQUOTER_ABI comment) — this
// tries buildBestSwap (direct pools) and buildBestSwapViaETHMulticall (the tokenIn->ETH->tokenOut hub
// route, needed when a token's PROVE liquidity sits behind WETH — wstETH and USDT, verified 2026-09-23)
// and keeps whichever actually quotes, picking the better one when both do. exactOut=false ⇒ exact-in,
// optimize for highest amountOut; exactOut=true ⇒ optimize for lowest amountIn (both are real call sites
// below). `to` = recipient of the output; the via-ETH route also needs a refund address for ETH-leg dust,
// which is the same recipient here (nothing downstream currently wants it split out).
export async function quote(tokenIn, tokenOut, amountIn, recipient, exactOut = false) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const candidates = [];
  // The terms the quote was asked for, kept with it: fireSwap reads the call it is about to sign against them.
  const intent = { tokenIn, tokenOut, recipient, exactOut, amount: BigInt(amountIn), deadline };

  try {
    const [best, callData, amountLimit, msgValue] = await publicClient.readContract({
      address: ZQUOTER, abi: ZQUOTER_ABI, functionName: 'buildBestSwap',
      args: [recipient, exactOut, tokenIn, tokenOut, amountIn, SLIPPAGE_BPS, deadline],
    });
    if (best.amountIn > 0n && best.amountOut > 0n) {
      candidates.push({ amountIn: best.amountIn, amountOut: best.amountOut, callData, amountLimit, msgValue, intent });
    }
  } catch {}

  if (tokenIn !== ETH && tokenOut !== ETH) {
    try {
      const [legA, legB, , multicall, msgValue] = await publicClient.readContract({
        address: ZQUOTER, abi: ZQUOTER_ABI, functionName: 'buildBestSwapViaETHMulticall',
        args: [recipient, recipient, exactOut, tokenIn, tokenOut, amountIn, SLIPPAGE_BPS, deadline],
      });
      if (legA.amountIn > 0n && legB.amountOut > 0n) {
        candidates.push({ amountIn: legA.amountIn, amountOut: legB.amountOut, callData: multicall, amountLimit: 0n, msgValue, intent });
      }
    } catch {}
  }

  if (!candidates.length) throw new Error(`zQuoter: no route ${tokenIn} -> ${tokenOut}`);
  return exactOut
    ? candidates.reduce((a, b) => (b.amountIn < a.amountIn ? b : a))    // cheapest input for a fixed output
    : candidates.reduce((a, b) => (b.amountOut > a.amountOut ? b : a)); // most output for a fixed input
}

// Live PROVE price in USD, via the same quoter/route selection replenish actually swaps through — so the
// cost model tracks what replenishing genuinely costs rather than a constant. Probe size is
// batch-representative, so the quote carries the price impact a real top-up would pay. Clamped to a band
// around the static value: PROVE is ~10% of per-op cost, but a broken or manipulated quote should never be
// able to swing the fee gate wildly in either direction.
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
// Curve pools beyond the built-in list that a route may use (comma-separated addresses).
const EXTRA_CURVE_POOLS = String(process.env.ZROUTER_CURVE_POOLS || '').split(',').map((a) => a.trim()).filter(Boolean);
// A quote's call read against the terms it was asked for: one swap, or a short chain of swaps, that spends the asked token and pays the asked
// recipient, with the ETH sent matching the input and a guard on what is spent and what is paid. → null when acceptable, else the reason.
export function swapProblem(q) {
  const i = q && q.intent;
  if (!i) return 'the quote carries no terms';
  let legs;
  try { legs = decodeZRouterCall(q.callData); } catch (e) { return String((e && e.message) || e); }
  const ethIn = String(i.tokenIn).toLowerCase() === ETH;
  const spend = i.exactOut && legs.length === 1 ? q.amountLimit : i.amount;
  if (q.msgValue !== (ethIn ? spend : 0n)) return 'the ETH sent does not match the input';
  if (legs.length === 1 && legs[0].limit !== q.amountLimit) return 'the call guards another amount than the quote';
  const want = { to: i.recipient, tokenIn: i.tokenIn, tokenOut: i.tokenOut, exactOut: i.exactOut, amount: i.amount, deadline: i.deadline, curvePools: EXTRA_CURVE_POOLS };
  if (i.exactOut) want.maxIn = q.amountIn * (10000n + 2n * SLIPPAGE_BPS) / 10000n;
  else { want.maxIn = i.amount; want.minOut = q.amountOut * (10000n - 2n * SLIPPAGE_BPS) / 10000n; }
  return checkZRouterCall(q.callData, want);
}
async function fireSwap(quoted, wallet = relayWallet) {
  const problem = swapProblem(quoted);
  if (problem) throw new Error(`refusing the swap: ${problem}`);
  const h = await wallet.sendTransaction({ to: ZROUTER, data: quoted.callData, value: quoted.msgValue || 0n });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
  if (rcpt.status !== 'success') throw new Error(`zRouter swap reverted ${h}`);
  return h;
}

// The prover credit the last pass read (PROVE wei) and when, for the settle loop's choices between passes; null before the first.
let lastCreditWei = null, lastCreditAt = 0;
export const lastProverCredit = () => (lastCreditWei == null ? null : { wei: lastCreditWei, at: lastCreditAt });
// Read the prover credit now. A reading is kept as the last one and carried with the heartbeat, so a pass and the settle
// loop's proving pause (lib/prove-pause.js) leave the same figure for the open board's gate and the monitor. -> PROVE wei, or null.
export async function readProverCredit() {
  const credit = await proverCredit();
  if (credit != null) { setProverCredit(creditText(credit)); lastCreditWei = credit; lastCreditAt = Date.now(); }
  return credit;
}

// The credit as the settle loop's urgent check reads it: what the network holds plus PROVE already in the sink waiting for its deposit
// (the watch deposits it within a minute, so buying more now would double the top-up). null when the network credit cannot be read.
export async function creditForEager() {
  const credit = await readProverCredit();
  if (credit == null) return null;
  const waiting = await erc20Balance(PROVE, relayWallet.account.address).catch(() => 0n);
  return credit + waiting;
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
  const h = await withNonceRetry('vApp deposit', () => wallet.writeContract({ address: VAPP, abi: VAPP_ABI, functionName: 'deposit', args: [amt] }));
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
  if (rcpt.status !== 'success') throw new Error(`vApp deposit reverted ${h}`);
  log(`vApp deposit ok: tx=${h}`);
  ledger.deposited(Number(amt / 10n ** 14n) / 1e4);
}

// PROVE that reached the prover account since the last pass (a top-up, or a visitor paying for proofs) goes into the
// vApp now, once there is at least `minWei` of it: proving can run short of credit well inside a 30-minute pass. The
// deposit is the same one a pass makes, so nothing here can move anything but PROVE into the prover's own credit.
// The prover account is also the wallet the header and attest crons pay from. While the credit is healthy (the last
// reading at least SETTLE_PROVE_WHILE_SHORT_MIN_CREDIT_WEI) the deposit leaves the gas an attest keeps back
// (REFLECTION_ATTEST_GAS_BUDGET at twice the base fee, as the header relay reckons it) alone; with the credit low or unread
// the deposit is what lets an attest be proved at all, so it needs only its own approve and deposit, twice over. After a
// refusal or a failure it is not tried again for DEPOSIT_RETRY_MS. -> true when it deposited.
const DEPOSIT_GAS = 150_000n;             // an approve and a vApp deposit
const DEPOSIT_RETRY_MS = 10 * 60_000;
let depositHeldUntil = 0;
export async function depositArrivedProve({ minWei, now = Date.now() }) {
  if (now < depositHeldUntil) return false;
  const owner = relayWallet.account.address;
  const bal = await erc20Balance(PROVE, owner);
  if (bal < minWei) return false;
  const [eth, blk] = await Promise.all([publicClient.getBalance({ address: owner }), publicClient.getBlock({ blockTag: 'latest' })]);
  const price = (blk.baseFeePerGas ?? 0n) * 2n + CFG.settleTipFloorWei;
  const healthy = lastCreditWei != null && lastCreditWei >= CFG.proveWhileShortMinCreditWei;
  const need = healthy ? (CFG.attestGasBudget + DEPOSIT_GAS) * price : DEPOSIT_GAS * price * 2n;
  if (eth < need) {
    log(`${bal} PROVE arrived at the prover account; its ETH is short of ${healthy ? 'the attests\' reserve and ' : ''}a deposit, so it waits for a funded pass`);
    depositHeldUntil = now + DEPOSIT_RETRY_MS;
    return false;
  }
  log(`${bal} PROVE arrived at the prover account — depositing it now`);
  try { await depositProveToVApp(relayWallet); }
  catch (e) { depositHeldUntil = Date.now() + DEPOSIT_RETRY_MS; throw e; }
  return true;
}

// Dollar value of an ERC20 fee balance, for the dust floor and the quote sanity check. It must NOT come from
// the aggregator: the check exists to catch a bad aggregator quote, so valuing the asset with one would make the
// guard fail whenever the thing it guards against does.
//
//   stablecoins — exact: balance / 10^decimals
//   wstETH      — exact on-chain: stEthPerToken() (stETH per wstETH, 1e18), and stETH is valued as ETH
//   anything else — unknown, so the caller holds rather than guessing
const STABLE_FEE_ASSETS = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
]);
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const WSTETH_ABI = [{ type: 'function', name: 'stEthPerToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
async function usdValueOf(asset, amount, ethUsd) {
  try {
    const a = asset.toLowerCase();
    if (STABLE_FEE_ASSETS.has(a)) {
      const dec = Number(await publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 6));
      return Number(amount) / 10 ** dec;
    }
    if (a === WSTETH) {
      const rate = await publicClient.readContract({ address: asset, abi: WSTETH_ABI, functionName: 'stEthPerToken' });
      return (Number(amount) / 1e18) * (Number(rate) / 1e18) * ethUsd;
    }
    return null;
  } catch { return null; }
}

// Refuse a PROVE quote that an independent price says is nonsense (the aggregator's quotes for small
// amounts can be off by orders of magnitude). Reference price is the live PROVE->ETH probe, which is clamped to a
// band around the configured value, so a manipulated reference cannot swing this far either.
async function provePlausible(q, usdIn, ethUsd, label) {
  const px = await provePriceUsd(ethUsd);
  const expected = usdIn / px;
  const got = Number(q.amountOut) / 1e18;
  const band = CFG.quoteSanityBand;
  if (Number.isFinite(got) && got >= expected / band && got <= expected * band) return true;
  log(`  REFUSING ${label}: quote gives ${got.toFixed(2)} PROVE for $${usdIn.toFixed(2)} (~$${(usdIn / (got || 1)).toFixed(4)}/PROVE) but the reference is $${px.toFixed(4)} — implausible, holding`);
  return false;
}

// Merge the earner into the sink: move everything the settle wallet holds to the relay wallet. This is the
// one-shot that lets the keys be consolidated without stranding anything — run it, confirm the settle wallet
// is empty, then drop SETTLE_KEY and the two roles are one wallet.
//
// Order matters. ERC20 fee assets go first, while there is still ETH to pay their transfer gas; ETH goes last,
// less a reserve for its own transfer (priced at the live max fee with headroom, because a balance that is a
// hair short of value + gas simply fails). It moves ALL of every fee asset, dust included — the dust floor
// exists to avoid pointless swaps, and a transfer to ourselves is neither.
export async function drainToSink({ roles = ['settle'] } = {}) {
  const sink = relayWallet;
  const sinkAddr = sink.account.address;
  const earners = fundedWallets.filter((w) => w.roles.some((r) => roles.includes(r)) && w.address.toLowerCase() !== sinkAddr.toLowerCase());
  if (!earners.length) { log('drain: the settle wallet is already the relay wallet — nothing to move'); return { moved: [] }; }
  const moved = [];
  for (const { address: owner, wallet } of earners) {
    log(`drain: ${owner} -> ${sinkAddr}`);
    for (const asset of feeAssets().filter((a) => a !== ETH)) {
      try {
        const bal = await erc20Balance(asset, owner);
        if (bal === 0n) continue;
        const h = await withNonceRetry('drain erc20', () => wallet.writeContract({ address: asset, abi: ERC20_ABI, functionName: 'transfer', args: [sinkAddr, bal] }));
        const r = await publicClient.waitForTransactionReceipt({ hash: h });
        if (r.status !== 'success') throw new Error(`transfer reverted ${h}`);
        log(`  moved ${bal} of ${asset}`);
        moved.push({ asset, amount: bal });
      } catch (e) { log(`  drain of ${asset} failed (continuing): ${e.message}`); }
    }
    try {
      const bal = await publicClient.getBalance({ address: owner });
      const fees = await publicClient.estimateFeesPerGas();
      const reserve = 21000n * fees.maxFeePerGas * 2n; // 2x headroom over the live max fee
      if (bal <= reserve) { log(`  ETH ${bal} does not cover a transfer (reserve ${reserve}) — leaving it`); continue; }
      const send = bal - reserve;
      const h = await withNonceRetry('drain eth', () => wallet.sendTransaction({ to: sinkAddr, value: send }));
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      if (r.status !== 'success') throw new Error(`ETH transfer reverted ${h}`);
      log(`  moved ${send} wei ETH (kept ${reserve} for gas)`);
      moved.push({ asset: ETH, amount: send });
    } catch (e) { log(`  drain of ETH failed: ${e.message}`); }
  }
  log('drain: done');
  return { moved };
}

// Move the fee tokens the relay holds rather than sells (TAC, and RESERVE_ASSETS: tacUSD, tacBTC) off the hot wallets to the reserve,
// each once it reaches its own minimum. Separate from the fee-asset sweep so it runs even in manual top-up mode, and never swaps: a token
// named in FEE_ASSETS is converted by the sweep instead and is left out here.
export function heldAssets() {
  const converted = new Set(feeAssets().map((a) => a.toLowerCase()));
  const list = [{ token: ADDR.tacToken, minWei: CFG.tacReserveMinWei, name: 'TAC' }, ...CFG.reserveAssets.map((r) => ({ ...r, name: r.token.slice(0, 10) }))];
  return list.filter((r) => /^0x[0-9a-fA-F]{40}$/.test(r.token) && !converted.has(r.token.toLowerCase()))
    .filter((r, i, a) => a.findIndex((x) => x.token.toLowerCase() === r.token.toLowerCase()) === i);
}
export async function sweepTacToReserve(wallets = fundedWallets) {
  const reserve = CFG.tacReserveAddr;
  if (!reserve) return [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(reserve)) { log(`TAC_RESERVE_ADDR ${reserve} is not an address — not sweeping`); return []; }
  const moved = [];
  for (const { address: owner, wallet } of wallets) {
    if (owner.toLowerCase() === reserve.toLowerCase()) continue;
    for (const { token, minWei, name } of heldAssets()) {
      try {
        const bal = await erc20Balance(token, owner);
        if (bal === 0n || bal < minWei) continue;
        const h = await withNonceRetry(`${name} reserve`, async () => wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'transfer', args: [reserve, bal], ...(await sendFees()) }));
        const r = await publicClient.waitForTransactionReceipt({ hash: h });
        if (r.status !== 'success') throw new Error(`transfer reverted ${h}`);
        log(`  moved ${bal} ${name} from ${owner} to the reserve ${reserve}`);
        moved.push({ owner, token, amount: bal });
      } catch (e) { log(`  ${name} reserve sweep from ${owner} failed (continuing): ${e.message}`); }
    }
  }
  return moved;
}

// Send BUYBACK_SHARE_BPS of an ETH surplus to TacBuyback. Returns what was sent (0 when off or on failure,
// so the caller simply converts the whole surplus as before).
async function sendBuybackShare(excess, wallet) {
  const to = CFG.buybackAddr, bps = BigInt(Math.floor(CFG.buybackShareBps || 0));
  if (!to || bps <= 0n) return 0n;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || bps > 10000n) { log(`  buyback: BUYBACK_ADDR/BUYBACK_SHARE_BPS invalid — skipping`); return 0n; }
  const share = (excess * bps) / 10000n;
  if (share === 0n) return 0n;
  try {
    const h = await withNonceRetry('buyback share', () => wallet.sendTransaction({ to, value: share }));
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error(`transfer reverted ${h}`);
    log(`  buyback: sent ${share} wei ETH -> ${to}`);
    return share;
  } catch (e) { log(`  buyback share failed (continuing): ${e.message}`); return 0n; }
}

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const SPLITTER_ABI = [{ type: 'function', name: 'distribute', inputs: [], outputs: [], stateMutability: 'nonpayable' }];

// The standing buyback (CFG.buybackIncomeBps): its share of the fee income the ledger counted since the last pass goes to TacBuyback,
// from the wallet that earned it, as far as that wallet can spare it; the rest is carried as owed (lib/income-allocation.js). Never throws:
// a failure hands the income back to the next pass and the settle loop goes on.
async function payIncomeBuyback(owner, wallet) {
  const to = CFG.buybackAddr;
  if (!(CFG.buybackIncomeBps > 0)) return;
  if (!isAddr(to)) { log('  buyback: BUYBACK_ADDR is not an address — skipping'); return; }
  const baseUsd = ledger.takeBuybackBase();
  let plan;
  try {
    const [ethUsd, balanceWei] = await Promise.all([ethUsdPrice(), publicClient.getBalance({ address: owner })]);
    plan = planBuyback({ baseUsd, ethUsd, bps: CFG.buybackIncomeBps, owedWei: ledger.owed(), balanceWei, keepWei: CFG.buybackKeepWei, minSendWei: CFG.buybackMinSendWei, owedCapWei: CFG.buybackOwedCapWei });
  } catch (e) { ledger.giveBackBase(baseUsd); log(`  buyback: could not price this pass (${e.message}) — income carried`); return; }
  // Owed is written before anything is sent, so a pass that dies after the send cannot pay the same share twice.
  ledger.setOwed(plan.owedAfterWei);
  log(`  buyback: ${(CFG.buybackIncomeBps / 100).toFixed(1)}% of $${baseUsd.toFixed(2)} fee income: ${plan.dueWei} wei due, ${plan.payWei} wei paid, ${plan.owedAfterWei} wei owed (${plan.reason})`);
  if (plan.payWei === 0n) return;
  try {
    const h = await withNonceRetry('buyback income', () => wallet.sendTransaction({ to, value: plan.payWei }));
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error(`transfer reverted ${h}`);
    ledger.boughtBack(plan.payWei);
    log(`  buyback: sent ${plan.payWei} wei ETH -> ${to} (tx ${h})`);
  } catch (e) {
    ledger.setOwed(ledger.owed() + plan.payWei > CFG.buybackOwedCapWei ? CFG.buybackOwedCapWei : ledger.owed() + plan.payWei);
    log(`  buyback send failed — owed again (${e.message})`);
  }
}

// Sends a splitter's balance on to its recipients once it holds the minimum (CFG.splitterAddr). Anyone may call distribute(); this is only
// so nobody has to. A revert (a recipient that refuses ETH) is logged and tried again next pass.
async function distributeSplitter(wallet) {
  const to = CFG.splitterAddr;
  if (!to) return;
  if (!isAddr(to)) { log('  splitter: SPLITTER_ADDR is not an address — skipping'); return; }
  try {
    const bal = await publicClient.getBalance({ address: to });
    if (!splitterDue(bal, CFG.splitterMinWei)) return;
    const h = await withNonceRetry('splitter distribute', async () => wallet.writeContract({ address: to, abi: SPLITTER_ABI, functionName: 'distribute', args: [], ...(await sendFees()) }));
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error(`distribute reverted ${h}`);
    ledger.splitterSent();
    log(`  splitter: sent ${bal} wei on from ${to} (tx ${h})`);
  } catch (e) { log(`  splitter distribute failed (continuing): ${e.message}`); }
}

// The treasury pass (lib/treasury-plan.js). Reads what the settle wallet, the relay wallet and the prover's credit hold and burn, plans
// where the settle wallet's spare ETH goes, and moves it: a plain transfer to the relay wallet, a swap to PROVE delivered to the sink.
// Burns come from the books where they have a day or more, else from the gas model and the measured defaults; floors from today's gas.
// Nothing here throws into the pass: a treasury that cannot be read is logged and left for the next pass.
async function runTreasury(earner, sink, { credit, convertToProve }) {
  // The moves go through the public endpoints (`publicWallet`): a transfer carries nothing a searcher could take, a swap this small is
  // not worth a sandwich, and a private builder left both unmined past the receipt wait.
  const owner = earner.address, mover = earner.publicWallet || earner.wallet, sinkAddr = sink.account.address;
  const toSink = owner.toLowerCase() !== sinkAddr.toLowerCase();
  try {
    const [settleWei, relayWei, gasPrice, floors, ethUsd] = await Promise.all([
      publicClient.getBalance({ address: owner }),
      toSink ? publicClient.getBalance({ address: sinkAddr }) : 0n,
      publicClient.getGasPrice(),
      treasuryFloors(publicClient),
      ethUsdPrice().catch(() => null),
    ]);
    const books = ledger.burnPerDay();
    const perDayWei = (eth) => (eth != null && eth > 0 ? BigInt(Math.round(eth * 1e9)) * 10n ** 9n : null);
    const settleBurn = perDayWei(books.gasEthPerDay) ?? OP_GAS.transfer * BigInt(Math.max(1, Math.round(CFG.expectedOpsPerDay))) * gasPrice;
    const relayBurn = CFG.relayBurnGasPerDay * gasPrice;
    const proveBurn = books.provePerDay != null && books.provePerDay > 0 ? BigInt(Math.round(books.provePerDay * 1e4)) * 10n ** 14n : BigInt(Math.round(CFG.proveBurnPerDayDefault * 1e4)) * 10n ** 14n;
    const { settleFloor, relayFloor } = floors;
    // PROVE per ETH at a swap of the size a pass would make, from the same quoter the swap goes through.
    let proveWeiPerEth = null;
    if (convertToProve) {
      try { const q = await quote(ETH, PROVE, CFG.treasuryMinSwapWei, sinkAddr); if (q?.amountOut > 0n) proveWeiPerEth = (q.amountOut * 10n ** 18n) / CFG.treasuryMinSwapWei; } catch {}
    }
    // What a swap is worth making follows today's gas (a swap's gas about 4% of it, 10% for an urgent one), up to the fixed minimum a dear
    // gas price keeps: at 0.09 gwei that is 0.0007 ETH rather than 0.002, so a small wallet's PROVE is bought, not left waiting.
    const swapGasWei = CFG.treasurySwapGas * gasPrice;
    const minSwapWei = swapMinWei({ gasWei: swapGasWei, multiple: CFG.treasurySwapGasMultiple, floorWei: CFG.treasuryMinSwapFloorWei, ceilWei: CFG.treasuryMinSwapWei });
    const urgentMinSwapWei = swapMinWei({ gasWei: swapGasWei, multiple: CFG.treasuryUrgentSwapGasMultiple, floorWei: CFG.treasuryMinSwapFloorWei, ceilWei: minSwapWei });
    const plan = planTreasury({
      settle: { wei: settleWei, burnPerDayWei: toSink ? settleBurn : settleBurn + relayBurn, floorWei: toSink ? settleFloor : settleFloor + relayFloor },
      relay: toSink ? { wei: relayWei, burnPerDayWei: relayBurn, floorWei: relayFloor, hardMinWei: CFG.attestGasBudget * (gasPrice * 2n) * BigInt(CFG.relayHardMinAttests) } : { wei: 0n, burnPerDayWei: 0n, floorWei: 0n },
      prove: { wei: credit ?? 0n, burnPerDayWei: credit == null ? 0n : proveBurn, floorWei: CFG.proveCreditFloorWei,
        urgentBelowWei: credit == null ? 0n : CFG.proveUrgentBelowWei, urgentToWei: CFG.proveUrgentToWei },
      targetDays: CFG.treasuryTargetDays, minMoveWei: CFG.treasuryMinMoveWei, minSwapWei, urgentMinSwapWei, maxSwapWei: CFG.proveTopUpMaxWei,
      proveWeiPerEth: credit == null ? null : proveWeiPerEth,
    });
    const d = (x) => daysText(x);
    log(`  treasury: settle ${d(plan.runway.settleDays)} d, relay ${d(plan.runway.relayDays)} d, credit ${d(plan.runway.proveDays)} d of burn`
      + ` (floors ${settleFloor} / ${relayFloor} wei, burns ${settleBurn} / ${relayBurn} wei/day, ${(Number(proveBurn) / 1e18).toFixed(1)} PROVE/day${books.days ? `, ${books.days} day(s) of books` : ', no books yet'})`
      + ` -> relay wallet +${plan.toRelayWei} wei, PROVE +${plan.toProveWei} wei of ETH${plan.urgentWei > 0n ? ` (${plan.urgentWei} of it urgent)` : ''}; after: ${d(plan.after.settleDays)} / ${d(plan.after.relayDays)} / ${d(plan.after.proveDays)} d`
      + ` (minimum swap ${minSwapWei}, urgent ${urgentMinSwapWei} wei at ${Number(gasPrice) / 1e9} gwei)`);
    for (const n of plan.notes) log(`  treasury: ${n}`);
    let sentRelay = 0n, sentProve = 0n;
    if (plan.toRelayWei > 0n && toSink) {
      try {
        const h = await withNonceRetry('relay wallet gas', () => mover.sendTransaction({ to: sinkAddr, value: plan.toRelayWei }));
        const r = await publicClient.waitForTransactionReceipt({ hash: h });
        if (r.status !== 'success') throw new Error(`transfer reverted ${h}`);
        sentRelay = plan.toRelayWei;
        log(`  treasury: sent ${plan.toRelayWei} wei ETH -> relay wallet ${sinkAddr} (tx ${h})`);
      } catch (e) { log(`  treasury: relay wallet transfer failed (continuing): ${e.message}`); }
    }
    if (plan.toProveWei > 0n && convertToProve) {
      try {
        const q = await quote(ETH, PROVE, plan.toProveWei, sinkAddr); // PROVE lands on the sink, which deposits it
        if (ethUsd && !(await provePlausible(q, (Number(plan.toProveWei) / 1e18) * ethUsd, ethUsd, 'ETH->PROVE'))) throw new Error('implausible quote');
        log(`  treasury: ${plan.toProveWei} wei ETH -> ~${q.amountOut} PROVE (to sink)`);
        await fireSwap(q, mover);
        sentProve = plan.toProveWei;
      } catch (e) { log(`  treasury: PROVE purchase failed (continuing): ${e.message}`); }
    }
    ledger.setRunway({
      settleDays: plan.runway.settleDays, relayDays: plan.runway.relayDays, proveDays: plan.runway.proveDays, levelDays: plan.levelDays,
      toRelayEth: Number(sentRelay) / 1e18, toProveEth: Number(sentProve) / 1e18,
      settleEth: Number(settleWei) / 1e18, relayEth: Number(relayWei) / 1e18, credit: credit == null ? null : Number(credit) / 1e18,
      burn: { settleEthPerDay: Number(settleBurn) / 1e18, relayEthPerDay: Number(relayBurn) / 1e18, provePerDay: Number(proveBurn) / 1e18, fromBooks: !!books.days },
    });
  } catch (e) { log(`  treasury: could not be planned this pass (${e.message})`); }
}

// One replenish pass: turn fee income into the two things the relay burns — ETH gas and PROVE.
//
// Two roles matter, and they are not the same wallet:
//
//   EARNER — where fee income lands. The settle wallet is msg.sender on every settle, so the pool's
//            `_payout` credits it there. It also burns settle gas.
//   SINK   — the RELAY wallet (`relayWallet`). It pays for the maintenance lane (header attestation,
//            reflection) and earns nothing, AND it is the account behind the network prover key, so it is
//            the only wallet whose vApp deposit actually funds proving. A deposit credits whoever sends it.
//
// So income flows earner -> sink. Swaps take a recipient, which lets one swap deliver straight to the
// sink rather than landing on the earner and being moved again:
//
//   fee asset -> ETH gas for the earner            (exact-out, recipient = earner)
//   fee asset -> ETH gas for the sink              (exact-out, recipient = sink)
//   fee asset -> PROVE                             (recipient = sink)
//   native ETH surplus -> transfer to sink, remainder -> PROVE to sink
//   sink deposits its PROVE to the vApp
//
// When the keys are consolidated the earner IS the sink and every "to the sink" step collapses into the
// ordinary single-wallet case, so this needs no changes for that migration.
//
// `roles` limits which wallets act as earners (null = every funded wallet, the cron's behaviour). The
// settle service passes ['settle'] so it never sweeps the sink as if it earned fees.
// `convertToProve: false` keeps a pass to gas only.
export async function replenishOnce({ roles = null, convertToProve = true } = {}) {
  const sink = relayWallet;
  const sinkAddr = sink.account.address;
  log(`replenish start — sink=${sinkAddr} roles=${roles ? roles.join('+') : 'all'} convertToProve=${convertToProve}`);
  // DEPOSIT_ONLY: skip the fee-asset sweep entirely and just move PROVE into the vApp. The sweep
  // early-returns when FEE_ASSETS is unset ("manual top-up mode"), which would skip the deposit too.
  if (process.env.DEPOSIT_ONLY === '1') {
    log('DEPOSIT_ONLY=1 — skipping fee sweep, depositing PROVE only');
    await depositProveToVApp(sink);
    log('replenish done (deposit only)');
    return;
  }
  await sweepTacToReserve(roles ? fundedWallets.filter((w) => w.roles.some((r) => roles.includes(r))) : fundedWallets);
  const buffer = CFG.ethGasBufferWei;
  const assets = feeAssets();
  if (assets.length === 0) { log('FEE_ASSETS empty — nothing to sweep (manual PROVE top-up mode)'); return; }

  const earners = roles ? fundedWallets.filter((w) => w.roles.some((r) => roles.includes(r))) : fundedWallets;
  if (!earners.length) { log(`no funded wallet holds role ${roles.join('/')} in this service — nothing to do`); return; }

  // The standing commitments first, from the settle wallet (the one that earns the fees): the buyback's share of what was earned, and a
  // splitter sent on. Only the settle service has a ledger to take from, and each is off unless its setting is on.
  if (roles && roles.includes('settle')) {
    const settleEarner = earners.find((w) => w.roles.includes('settle'));
    if (settleEarner) { await payIncomeBuyback(settleEarner.address, settleEarner.wallet); await distributeSplitter(settleEarner.wallet); }
  }

  // Proving stops outright when the network credit runs out, so a low credit outranks keeping a large ETH float:
  // under the floor, ETH above the gas buffer goes to PROVE this pass (capped), not only ETH above the sweep line.
  const credit = convertToProve ? await creditForEager() : null;      // the network's, and PROVE waiting in the sink for the deposit this pass ends with
  if (credit != null) log(`prover credit ${(Number(credit) / 1e18).toFixed(2)} PROVE (the network's and what waits in the sink)`);

  // Where the fee ETH goes (lib/treasury-plan.js): the settle wallet feeds the relay wallet (headers, attests, deposits) and the prover's
  // credit by runway, shortest first, keeping what its own next settles need. Only the settle service has the books and the settle key.
  if (roles && roles.includes('settle')) {
    const settleEarner = earners.find((w) => w.roles.includes('settle'));
    if (settleEarner) await runTreasury(settleEarner, sink, { credit, convertToProve });
  }

  for (const { address: owner, wallet, roles: held } of earners) {
    const toSink = owner.toLowerCase() !== sinkAddr.toLowerCase();
    log(`— earner ${owner} (${held.join('+')})${toSink ? ` -> sink ${sinkAddr}` : ' (is the sink)'}`);
    try { await maxPreApprove(assets, wallet, false); } // fee assets -> zRouter, from the wallet that holds them
    catch (e) { log(`  pre-approve failed (continuing): ${e.message}`); }

    // Bias: native ETH stays as gas up to the buffer; stablecoins/wstETH are converted. Hold TAC (never
    // in FEE_ASSETS).
    for (const asset of assets) {
      try {
        if (asset === ETH) {
          if (!convertToProve) continue;
          // Gas for both wallets and PROVE by runway were settled by the treasury pass above. What is left is only converted past
          // ETH_SWEEP_ABOVE_WEI: a manual top-up sits in the wallet too, and it is gas by intent, so only genuine excess goes.
          const remaining = await publicClient.getBalance({ address: owner });
          const keep = CFG.ethSweepAboveWei > buffer ? CFG.ethSweepAboveWei : buffer;
          const excess = remaining > keep ? remaining - keep : 0n;
          if (excess < MIN_ETH_SWEEP) { log(`  ETH ${remaining} within the gas float (<= ${keep} + dust) — keeping as gas`); continue; }
          const toProve = excess - await sendBuybackShare(excess, wallet);
          if (toProve < MIN_ETH_SWEEP) continue;
          const q = await quote(ETH, PROVE, toProve, sinkAddr); // PROVE lands on the sink, which deposits it
          const ethUsd = await ethUsdPrice();
          if (!(await provePlausible(q, (Number(toProve) / 1e18) * ethUsd, ethUsd, 'ETH->PROVE'))) continue;
          log(`  ETH excess ${toProve} -> ~${q.amountOut} PROVE (to sink)`);
          await fireSwap(q, wallet);
          continue;
        }

        const bal = await erc20Balance(asset, owner);
        if (bal === 0n) continue;
        log(`  fee asset ${asset} balance=${bal}`);

        // Gas before PROVE: a wallet that cannot pay for a transaction cannot buy PROVE either, so the
        // exact-out gas legs clear first — the earner's own, then the sink's.
        const gasLegs = [[owner, 'earner']];
        if (toSink) gasLegs.push([sinkAddr, 'sink']);
        for (const [who, label] of gasLegs) {
          const have = await publicClient.getBalance({ address: who });
          // Refill only when CLEARLY low (under half the buffer), then fill to the buffer. Topping up whenever a
          // wallet dips under the buffer means a wallet hovering near it — settles burn gas continuously —
          // buys ETH in tiny slices on every pass, each one paying swap gas and leaning on the aggregator's
          // least reliable quotes.
          if (have >= buffer / 2n) continue;
          const need = buffer - have;
          try {
            const left = await erc20Balance(asset, owner);
            const qe = await quote(asset, ETH, need, who, /* exactOut */ true);
            // A cost far above the ETH it buys is a bad quote, not a price: refuse it rather than hand the
            // aggregator the whole balance for a sliver of gas. Valued exactly (stablecoin decimals, wstETH's
            // on-chain rate) — never by the aggregator being checked — and an asset that cannot be valued is held.
            const ethUsd = await ethUsdPrice();
            const costUsd = await usdValueOf(asset, qe.amountIn, ethUsd);
            if (costUsd === null) { log(`  ${label} gas top-up: cannot value ${asset} — holding`); continue; }
            const worthUsd = (Number(need) / 1e18) * ethUsd;
            if (costUsd > worthUsd * CFG.quoteSanityBand) { log(`  REFUSING ${label} gas top-up: $${costUsd.toFixed(2)} of ${asset} for $${worthUsd.toFixed(2)} of ETH — implausible, holding`); continue; }
            if (qe.amountIn > 0n && qe.amountIn <= left) {
              log(`  ${label} gas top-up: ~${qe.amountIn} ${asset} -> ${need} ETH (to ${who})`);
              await fireSwap(qe, wallet);
            }
          } catch (e) { log(`  ${label} gas top-up quote failed (continuing): ${e.message}`); }
        }

        if (!convertToProve) continue; // hold the rest
        const rem = await erc20Balance(asset, owner);
        if (rem > 0n) {
          const ethUsd = await ethUsdPrice();
          const usd = await usdValueOf(asset, rem, ethUsd);
          if (usd === null) { log(`  ${asset}: cannot value ${rem} — holding`); continue; }
          if (usd < CFG.sweepMinUsd) { log(`  ${asset}: $${usd.toFixed(2)} is under the $${CFG.sweepMinUsd} dust floor — holding to accumulate`); continue; }
          const q = await quote(asset, PROVE, rem, sinkAddr); // PROVE lands on the sink, which deposits it
          if (!(await provePlausible(q, usd, ethUsd, `${asset}->PROVE`))) continue;
          log(`  ${rem} ${asset} -> ~${q.amountOut} PROVE (to sink)`);
          await fireSwap(q, wallet);
        }
      } catch (e) {
        log(`  sweep for ${asset} failed (continuing): ${e.message}`);
      }
    }
  }

  // The sink deposits, once, after every earner has delivered — it is the account that funds proving.
  if (convertToProve) {
    try { await depositProveToVApp(sink); }
    catch (e) { log(`  vApp deposit failed: ${e.message}`); }
  }

  log('replenish done');
}

// Run only when invoked directly (also imported by settle-relay for quoteRelayFee and replenishOnce).
if (import.meta.url === `file://${process.argv[1]}`) {
  replenishOnce().catch((e) => { console.error('fatal', e); process.exit(1); });
}
