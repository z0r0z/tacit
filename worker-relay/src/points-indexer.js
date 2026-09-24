// ETH-wrap points program. Purely a read + tally over the pool's existing Wrap event and each wrap's
// tx sender — no contract change, no interaction with settle/reflection. See CFG's "Points program"
// section (lib/config.js) for the formula and every tunable.
//
// Deliberately forward-only: counts wraps from CFG.pointsStartBlock on, nothing earlier. Informational
// only for now — this serves a leaderboard/lookup API; it does not mint or gate anything on-chain.

import { createServer } from 'node:http';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CFG, ADDR } from './lib/config.js';
import { publicClient } from './lib/chain.js';
import { openStore } from './lib/points-store.js';
import { build as buildMerkleTree, formatTac } from './lib/points-merkle.js';

const log = (...a) => console.log(`[points ${new Date().toISOString()}]`, ...a);

const DISTRIBUTOR_ABI = [
  { type: 'function', name: 'updateRoot', stateMutability: 'nonpayable', inputs: [{ name: 'newRoot', type: 'bytes32' }, { name: 'newTotalAllocated', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'totalClaimed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const ERC20_BALANCEOF_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const CLAIMED_ABI = [
  { type: 'function', name: 'claimed', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

// Built once at startup, reused for every settle cycle. null when publishing isn't configured yet (no
// POINTS_ROOT_SETTER_KEY) — settleCycle still folds days into the local reward ledger either way; only the
// on-chain publish step is skipped.
const rootSetterWallet = CFG.pointsRootSetterKey
  ? createWalletClient({
      account: privateKeyToAccount(CFG.pointsRootSetterKey.startsWith('0x') ? CFG.pointsRootSetterKey : `0x${CFG.pointsRootSetterKey}`),
      chain: publicClient.chain,
      transport: http(CFG.rpcUrl),
    })
  : null;

const WRAP_EVENT = {
  type: 'event',
  name: 'Wrap',
  inputs: [
    { name: 'depositId', type: 'bytes32', indexed: true },
    { name: 'assetId', type: 'bytes32', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
};

// contracts/src/WrapTipForwarder.sol — the NATIVE-ETH forwarder specifically. Purely informational here:
// points already go to `tx.from` (the transaction's own signer) whether it called the pool directly or
// through the forwarder, so a missing or unmatched tip log never affects who earns points, only whether this
// deposit's row also shows the tip it paid.
//
// The ERC20 sibling (WrapTokenTipForwarder) emits a DIFFERENT event — it carries a leading indexed assetId,
// so a different topic0 — and is deliberately not decoded here. Adding it would find nothing: this scan only
// reads Wrap events for CFG.ethAssetId, so a token wrap never produces a row for a tip to attach to. If the
// points program is ever widened past native ETH, this ABI has to be widened with it rather than the
// forwarder address simply being pointed at the token one.
const WRAPPED_WITH_TIP_EVENT = {
  type: 'event',
  name: 'WrappedWithTip',
  inputs: [
    { name: 'depositCommit', type: 'bytes32', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'tip', type: 'uint256', indexed: false },
    { name: 'tipRecipient', type: 'address', indexed: true },
  ],
};

function pointsForDeposit(amountWei, priorDepositCount) {
  const amountEth = Number(amountWei) / 1e18;
  const bonus = 1 + CFG.pointsBonusScale / (1 + priorDepositCount / CFG.pointsBonusHalfLife);
  return amountEth * CFG.pointsBasePerEth * bonus;
}

async function scanCycle(store) {
  const cursor = store.loadCursor() ?? {
    lastScannedBlock: BigInt(CFG.pointsStartBlock) - 1n,
    ethDepositCount: 0,
  };

  const latest = await publicClient.getBlockNumber();
  const confirmedTip = latest - BigInt(CFG.pointsConfirmations);
  if (confirmedTip <= cursor.lastScannedBlock) return;

  const chunk = BigInt(CFG.pointsScanChunk);
  const blockCache = new Map();
  const txCache = new Map();

  let from = cursor.lastScannedBlock + 1n;
  while (from <= confirmedTip) {
    const to = from + chunk - 1n > confirmedTip ? confirmedTip : from + chunk - 1n;

    const [logs, tipLogs] = await Promise.all([
      publicClient.getLogs({
        address: ADDR.pool,
        event: WRAP_EVENT,
        args: { assetId: CFG.ethAssetId },
        fromBlock: from,
        toBlock: to,
      }),
      ADDR.wrapTipForwarder
        ? publicClient.getLogs({ address: ADDR.wrapTipForwarder, event: WRAPPED_WITH_TIP_EVENT, fromBlock: from, toBlock: to })
        : [],
    ]);
    // Keyed by tx hash: the forwarder makes exactly one pool.wrap() call per invocation, so a tx has at
    // most one Wrap and at most one WrappedWithTip, and they always share a tx hash when both are present.
    const tipByTx = new Map(tipLogs.map((t) => [t.transactionHash, { tipWei: t.args.tip.toString(), tipRecipient: t.args.tipRecipient.toLowerCase() }]));

    for (const evt of logs) {
      let block = blockCache.get(evt.blockNumber);
      if (!block) {
        block = await publicClient.getBlock({ blockNumber: evt.blockNumber });
        blockCache.set(evt.blockNumber, block);
      }
      let tx = txCache.get(evt.transactionHash);
      if (!tx) {
        tx = await publicClient.getTransaction({ hash: evt.transactionHash });
        txCache.set(evt.transactionHash, tx);
      }

      const priorDepositCount = cursor.ethDepositCount;
      const points = pointsForDeposit(evt.args.amount, priorDepositCount);
      const wrote = store.recordDeposit({
        txHash: evt.transactionHash,
        blockNumber: Number(evt.blockNumber),
        blockTime: Number(block.timestamp),
        // tx.from, not msg.sender as seen by the pool: whether this call reached the pool directly or via
        // WrapTipForwarder, tx.from is always the EOA that signed and funded it — the true depositor, never
        // the forwarder's own address, and unaffected by whatever tipRecipient it chose.
        depositor: tx.from.toLowerCase(),
        amountWei: evt.args.amount.toString(),
        priorDepositCount,
        points,
        ...tipByTx.get(evt.transactionHash),
      });
      if (wrote) cursor.ethDepositCount += 1;
    }

    cursor.lastScannedBlock = to;
    store.saveCursor(cursor);
    from = to + 1n;
  }

  log(`scanned to block ${cursor.lastScannedBlock}, ${cursor.ethDepositCount} ETH deposits recorded`);
}

// Cumulative TAC budget through `daysElapsed` whole days of the program (clamped to [0, pointsProgramDays]).
// Computed as a fraction of the total each time, rather than a fixed per-day rate, so the 90 days sum to
// EXACTLY pointsProgramTotalWei with no rounding drift — any remainder from integer division lands in
// whichever day's delta absorbs it, never accumulates across days.
export function cumulativeTargetWei(daysElapsed) {
  const d = daysElapsed < 0 ? 0 : daysElapsed > CFG.pointsProgramDays ? CFG.pointsProgramDays : daysElapsed;
  return (CFG.pointsProgramTotalWei * BigInt(d)) / BigInt(CFG.pointsProgramDays);
}
export function dayBudgetWei(dayIndex) {
  return cumulativeTargetWei(dayIndex + 1) - cumulativeTargetWei(dayIndex);
}

// Splits `budgetWei` pro-rata across `rows` ([{address, dayPoints}], dayPoints a JS float — a WEIGHT, never a
// wei amount). Scaling both sides of the ratio by the same factor before doing BigInt division means the
// float's imprecision only ever affects the last few bits of the ratio, never the wei-scale result, and never
// compounds across days (each day's split is independent). Integer division leaves a few wei of dust
// unallocated per day — negligible at TAC's scale and not worth the complexity of redistributing.
export function splitDayBudget(rows, budgetWei) {
  const scaled = rows.map((r) => BigInt(Math.round(r.dayPoints * 1e6)));
  const totalScaled = scaled.reduce((s, v) => s + v, 0n);
  const deltas = new Map();
  if (totalScaled <= 0n) return deltas;
  rows.forEach((r, i) => {
    const share = (budgetWei * scaled[i]) / totalScaled;
    if (share > 0n) deltas.set(r.address, share);
  });
  return deltas;
}

export function buildRewardTree(rewards) {
  return buildMerkleTree(rewards.map((r) => ({ address: r.address, cumulativeAmountWei: BigInt(r.cumulativeWei) })));
}

// Folds every UTC day-epoch through yesterday into the local reward ledger (always happens, independent of
// funding), then best-effort publishes a new cumulative root on-chain (only when POINTS_DISTRIBUTOR_ADDR +
// POINTS_ROOT_SETTER_KEY are set AND the distributor currently holds enough TAC to cover the new declared
// total). Deliberately decoupled: scoring stays accurate and current even on days the ops multisig hasn't yet
// topped up the distributor, and a funding shortfall just defers the on-chain publish to a later cycle rather
// than blocking or losing the day's computed entitlements.
export async function settleCycle(store) {
  if (!CFG.pointsProgramStartSec) return; // reward program not configured yet — informational points still work

  const startDay = Math.floor(CFG.pointsProgramStartSec / 86400);
  const lastProgramDay = startDay + CFG.pointsProgramDays - 1;
  const todayDay = Math.floor(Date.now() / 1000 / 86400);
  const settleThroughDay = Math.min(todayDay - 1, lastProgramDay); // never settle a day still in progress

  const state = store.loadSettleState() ?? { lastSettledDay: startDay - 1, publishedRoot: null, publishedTotalWei: null, knobs: null };

  // Refuse to extend a settled history under different scoring knobs.
  //
  // Days already folded into the reward ledger were scored at the knobs in force then. Folding further days
  // at different ones silently mixes two scoring regimes into one cumulative tree — and after a disk loss the
  // whole history is re-scored at today's knobs, which can lower an individual account's cumulative below
  // what it already claimed. The contract catches an aggregate decrease (TotalDecreased) but not a per-account
  // one, so the damage surfaces later as honest claimants hitting OverAllocated. Stop at the point where it
  // is still one operator decision rather than a payout failure.
  const knobs = JSON.stringify({
    basePerEth: CFG.pointsBasePerEth,
    bonusScale: CFG.pointsBonusScale,
    bonusHalfLife: CFG.pointsBonusHalfLife,
    programStartSec: CFG.pointsProgramStartSec,
    programDays: CFG.pointsProgramDays,
    programTotalWei: CFG.pointsProgramTotalWei.toString(),
  });
  if (state.knobs && state.knobs !== knobs && state.lastSettledDay >= startDay) {
    log(`REFUSING to settle: the scoring knobs changed after ${state.lastSettledDay - startDay + 1} day(s) were `
      + `already settled.\n  settled under: ${state.knobs}\n  configured now: ${knobs}\n`
      + '  Restore the original values, or deliberately reset the reward ledger — do not mix two regimes '
      + 'into one cumulative tree.');
    // Deliberately NOT a heartbeat: worker-client's heartbeat needs WORKER_BASE + BOX_TOKEN, and this
    // service is specifically the one that should hold neither. The log plus a `lastSettledDay` that stops
    // advancing on /rewards is the signal.
    return;
  }
  state.knobs = knobs;

  for (let d = state.lastSettledDay + 1; d <= settleThroughDay; d++) {
    const dayIndex = d - startDay;
    const dayStart = d * 86400;
    const dayEnd = dayStart + 86400;
    const rows = store.dayPointsByAddress(dayStart, dayEnd);
    if (rows.length) {
      const budget = dayBudgetWei(dayIndex);
      if (budget > 0n) {
        const deltas = splitDayBudget(rows, budget);
        if (deltas.size) store.applyDayRewards(deltas);
      }
    }
    state.lastSettledDay = d;
    store.saveSettleState(state);
  }

  if (!ADDR.pointsDistributor || !rootSetterWallet) return; // publishing not configured yet

  const rewards = store.allRewards();
  if (!rewards.length) return;
  const tree = buildRewardTree(rewards);
  if (tree.root === state.publishedRoot) return; // nothing new since the last successful publish

  const totalWei = BigInt(tree.totalWei);
  const [balance, totalClaimed] = await Promise.all([
    publicClient.readContract({ address: ADDR.tacToken, abi: ERC20_BALANCEOF_ABI, functionName: 'balanceOf', args: [ADDR.pointsDistributor] }),
    publicClient.readContract({ address: ADDR.pointsDistributor, abi: DISTRIBUTOR_ABI, functionName: 'totalClaimed' }),
  ]);
  const funded = balance + totalClaimed;
  if (totalWei > funded) {
    log(`ALERT: PointsDistributor needs ${formatTac(totalWei - funded)} more TAC funded before day ${settleThroughDay} settles on-chain (declared ${formatTac(totalWei)}, funded ${formatTac(funded)})`);
    return;
  }

  const hash = await rootSetterWallet.writeContract({
    address: ADDR.pointsDistributor,
    abi: DISTRIBUTOR_ABI,
    functionName: 'updateRoot',
    args: [tree.root, totalWei],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  store.savePublishedClaims(tree.claims);
  store.saveSettleState({ lastSettledDay: state.lastSettledDay, publishedRoot: tree.root, publishedTotalWei: tree.totalWei });
  log(`published points root ${tree.root} (${formatTac(totalWei)} TAC across ${tree.count} addresses), tx ${hash}`);
}

function startHttp(store) {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/health') {
        const cursor = store.loadCursor();
        res.end(JSON.stringify({
          ok: true,
          lastScannedBlock: cursor ? cursor.lastScannedBlock.toString() : null,
          ethDepositCount: cursor ? cursor.ethDepositCount : 0,
        }));
        return;
      }
      if (url.pathname === '/leaderboard') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        res.end(JSON.stringify(store.leaderboard(limit)));
        return;
      }
      const pointsMatch = url.pathname.match(/^\/points\/(0x[0-9a-fA-F]{40})$/);
      if (pointsMatch) {
        const address = pointsMatch[1];
        const total = store.totalFor(address) ?? { address: address.toLowerCase(), points: 0, deposit_count: 0, amount_wei: '0' };
        const deposits = store.depositsFor(address, 100);
        // Cheap trend context for a client that doesn't want a full history view: today's points for this
        // address against today's TAC budget, since the payout is a share of a fixed daily pool rather than a
        // flat points-to-TAC rate. null when the reward program isn't configured yet — no day budget to report.
        let today = null;
        if (CFG.pointsProgramStartSec) {
          const startDay = Math.floor(CFG.pointsProgramStartSec / 86400);
          const todayDay = Math.floor(Date.now() / 1000 / 86400);
          const dayStart = todayDay * 86400;
          const row = store.dayPointsByAddress(dayStart, dayStart + 86400)
            .find((r) => r.address.toLowerCase() === address.toLowerCase());
          today = { points: row ? row.dayPoints : 0, dayBudgetWei: dayBudgetWei(todayDay - startDay).toString() };
        }
        res.end(JSON.stringify({ ...total, today, deposits }));
        return;
      }
      // The claim proof for the LAST on-chain-published root (see savePublishedClaims) PLUS what the
      // distributor already shows as claimed for this account, so an integrator can render "earned so far /
      // already claimed / claimable now" without doing its own on-chain read. cumulativeAmount only ever grows
      // across epochs (see settleCycle) — this never resets, it just reports where the running total sits
      // right now and how much of it hasn't been picked up yet.
      const claimMatch = url.pathname.match(/^\/claim\/(0x[0-9a-fA-F]{40})$/);
      if (claimMatch) {
        const address = claimMatch[1];
        const claim = store.claimFor(address); // { cumulativeAmount, proof } | null
        const cumulativeAmount = claim?.cumulativeAmount ?? '0';
        let claimedWei = '0';
        if (ADDR.pointsDistributor) {
          try {
            const onChain = await publicClient.readContract({
              address: ADDR.pointsDistributor, abi: CLAIMED_ABI, functionName: 'claimed', args: [address],
            });
            claimedWei = onChain.toString();
          } catch (err) {
            log(`/claim read failed for ${address}:`, err?.message || err); // report 0 claimed rather than fail the response over a transient RPC hiccup
          }
        }
        const unclaimedWei = (BigInt(cumulativeAmount) > BigInt(claimedWei) ? BigInt(cumulativeAmount) - BigInt(claimedWei) : 0n).toString();
        res.end(JSON.stringify({
          address,
          distributor: ADDR.pointsDistributor || null,
          cumulativeAmount,
          claimedWei,
          unclaimedWei,
          proof: claim?.proof ?? null,
        }));
        return;
      }
      // Monitoring view of the reward settlement itself — separate from /points, which is real-time. A day's
      // entitlements only land here once that whole UTC day has elapsed (settleCycle never settles "today").
      if (url.pathname === '/rewards') {
        const state = store.loadSettleState();
        const startDay = CFG.pointsProgramStartSec ? Math.floor(CFG.pointsProgramStartSec / 86400) : null;
        const todayDay = Math.floor(Date.now() / 1000 / 86400);
        const rewards = store.allRewards();
        const totalLedgerWei = rewards.reduce((s, r) => s + BigInt(r.cumulativeWei), 0n).toString();
        const leaderboard = rewards.sort((a, b) => (BigInt(a.cumulativeWei) < BigInt(b.cumulativeWei) ? 1 : -1)).slice(0, 100);
        res.end(JSON.stringify({
          programConfigured: Boolean(CFG.pointsProgramStartSec),
          programStartDay: startDay,
          programDays: CFG.pointsProgramDays,
          currentDay: todayDay,
          lastSettledDay: state?.lastSettledDay ?? null,
          publishingConfigured: Boolean(ADDR.pointsDistributor && CFG.pointsRootSetterKey),
          publishedRoot: state?.publishedRoot ?? null,
          publishedTotalWei: state?.publishedTotalWei ?? null,
          totalLedgerWei,
          leaderboard,
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });
  server.listen(CFG.pointsHttpPort, () => log(`http listening on :${CFG.pointsHttpPort}`));
}

async function main() {
  if (!CFG.pointsStartBlock) throw new Error('missing required env POINTS_START_BLOCK');
  const store = openStore(CFG.pointsDbPath);
  startHttp(store);

  for (;;) {
    try {
      await scanCycle(store);
    } catch (err) {
      log('scan cycle failed:', err?.message || err);
    }
    try {
      await settleCycle(store);
    } catch (err) {
      log('settle cycle failed:', err?.message || err);
    }
    await new Promise((r) => setTimeout(r, CFG.pointsPollSecs * 1000));
  }
}

main().catch((err) => {
  log('fatal:', err?.stack || err);
  process.exit(1);
});
