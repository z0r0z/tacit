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

// Privacy Pools (privacypools.com) Entrypoint — third-party protocol. Its WithdrawalRelayed event names
// the REAL recipient of a relayed ETH withdrawal directly; the pool contract's own Withdrawn event only
// ever names the Entrypoint itself as `_processooor` under the default relayed flow, never the person who
// actually receives the funds.
const PP_BLOCKSCOUT_BASE = 'https://eth.blockscout.com/api/v2';
const NATIVE_ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

function pointsForDeposit(amountWei, priorDepositCount) {
  const amountEth = Number(amountWei) / 1e18;
  const bonus = 1 + CFG.pointsBonusScale / (1 + priorDepositCount / CFG.pointsBonusHalfLife);
  return amountEth * CFG.pointsBasePerEth * bonus;
}

// Scans Privacy Pools' Entrypoint for ETH WithdrawalRelayed events via Blockscout's address-logs API
// (paginated by item, not block range), so scanCycle below can check a wrap's boost eligibility with a
// single local lookup instead of an RPC call per deposit. NOT plain eth_getLogs: this address's own history
// spans ~3.9M blocks back to its deploy, and public RPC providers cap eth_getLogs to as little as a 10-block
// range per call (hit in practice on this service's own RPC_URL) — a raw block-range backfill over that
// span would mean hundreds of thousands of calls and would stall scanCycle/settleCycle behind it in the
// same loop. Blockscout pages by ITEM COUNT regardless of block span, so the real (low) event volume is
// what bounds the request count, not the block range. No recency cutoff by design (see config.js): walks
// backward from the newest log, recording every qualifying (ETH-asset) WithdrawalRelayed it finds, and
// stops as soon as a page is entirely at or before ppCursor (already covered by a prior run) or at the
// Entrypoint's own deploy block (nothing real can exist before it) — so a fully-caught-up run costs one
// request, and only the first-ever run pays for the full historical walk.
async function scanPrivacyPoolCycle(store) {
  const priorCursor = store.loadPpCursor(); // BigInt | null — newest block already fully covered by a past run
  const deployBlock = BigInt(CFG.ppEntrypointDeployBlock);
  let newestSeen = null;
  let params = '';

  for (;;) {
    const res = await fetch(`${PP_BLOCKSCOUT_BASE}/addresses/${ADDR.ppEntrypoint}/logs${params}`);
    if (!res.ok) throw new Error(`blockscout address-logs ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) break;
    if (newestSeen === null) newestSeen = BigInt(items[0].block_number);

    let reachedCoverage = false;
    for (const item of items) {
      const blockNumber = BigInt(item.block_number);
      if (blockNumber < deployBlock || (priorCursor != null && blockNumber <= priorCursor)) {
        reachedCoverage = true;
        break;
      }
      if (!item.decoded || !item.decoded.method_call.startsWith('WithdrawalRelayed(')) continue;
      const params_ = Object.fromEntries(item.decoded.parameters.map((p) => [p.name, p.value]));
      if (String(params_._asset).toLowerCase() !== NATIVE_ETH_SENTINEL.toLowerCase()) continue;
      store.recordPpWithdrawal({
        txHash: item.transaction_hash,
        address: String(params_._recipient).toLowerCase(),
        blockNumber: Number(blockNumber),
        blockTime: Math.floor(new Date(item.block_timestamp).getTime() / 1000),
        amountWei: String(params_._amount),
      });
    }

    if (reachedCoverage || !data.next_page_params) break;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }

  if (newestSeen != null && (priorCursor == null || newestSeen > priorCursor)) store.savePpCursor(newestSeen);
}

// Same decaying early-adopter bonus as ETH wraps (pointsForDeposit above) — every deposit gets it, not just
// the first; it just shrinks as more of the SAME activity accumulates. Reuses pointsBonusScale/HalfLife
// rather than a separate knob per activity, so all three curves shrink at the same relative pace.
function earlyAdopterBonus(priorCount) {
  return 1 + CFG.pointsBonusScale / (1 + priorCount / CFG.pointsBonusHalfLife);
}
function pointsForCbtcEscrow(amountWei, priorCount) {
  return (Number(amountWei) / 1e18) * CFG.pointsBasePerCbtc * earlyAdopterBonus(priorCount);
}
// debtValue is tacitDecimals=8-scaled (unitScale=1e10, decimals=18 — see confidential-deployments.js), so
// dividing by 1e8 gives the real dollar amount minted.
function pointsForCusdMint(debtValueRaw, priorCount) {
  return (Number(debtValueRaw) / 1e8) * CFG.pointsBasePerCusd * CFG.cusdMintBonusMultiplier * earlyAdopterBonus(priorCount);
}

// Two more ways to earn points, both on CollateralEngine: EscrowPosted (wstETH collateral posted toward a
// cBTC mint) and CdpMinted (a cUSD loan opened). Same Blockscout-pagination approach as
// scanPrivacyPoolCycle and for the same reason — this address's own eth_getLogs range would hit the same
// 10-block RPC cap on a cold-start backfill. Volume here is even lower than Privacy Pools' (a handful of
// transactions total as of writing), so a caught-up run costs one request either way.
//
// Blockscout pages NEWEST-first, but the early-adopter bonus needs each activity's items scored OLDEST-
// first (so "prior count" only ever counts what genuinely came before it) — so this collects candidates
// across all pages first and scores them in a second, ascending-order pass, seeded from how many of each
// activity already exist in the store.
async function scanCollateralEngineCycle(store) {
  const priorCursor = store.loadCeCursor();
  const deployBlock = BigInt(CFG.collateralEngineDeployBlock);
  let newestSeen = null;
  let params = '';
  const cbtcCandidates = [];
  const cusdCandidates = [];

  // EscrowPosted's own `from` is the real depositor UNLESS the call was routed through a CbtcEscrowHelper, in
  // which case `from` is that helper's own address and the helper's OWN event (HelperEscrowPosted, same tx)
  // names the real one — same tx-hash cross-reference points-indexer.js already does for wrap tips.
  const cbtcEscrowHelperSet = new Set(ADDR.cbtcEscrowHelpers.map((a) => a.toLowerCase()));
  async function realCbtcDepositor(txHash, rawFrom) {
    if (!cbtcEscrowHelperSet.has(rawFrom.toLowerCase())) return rawFrom;
    const res = await fetch(`${PP_BLOCKSCOUT_BASE}/transactions/${txHash}/logs`);
    if (!res.ok) return rawFrom; // fail open to the helper's own address rather than lose the row
    const data = await res.json();
    for (const item of data.items || []) {
      if (item.decoded && item.decoded.method_call.startsWith('HelperEscrowPosted(')) {
        const p = Object.fromEntries(item.decoded.parameters.map((x) => [x.name, x.value]));
        if (p.depositor) return p.depositor;
      }
    }
    return rawFrom;
  }

  for (;;) {
    const res = await fetch(`${PP_BLOCKSCOUT_BASE}/addresses/${ADDR.collateralEngine}/logs${params}`);
    if (!res.ok) throw new Error(`blockscout address-logs ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) break;
    if (newestSeen === null) newestSeen = BigInt(items[0].block_number);

    let reachedCoverage = false;
    for (const item of items) {
      const blockNumber = BigInt(item.block_number);
      if (blockNumber < deployBlock || (priorCursor != null && blockNumber <= priorCursor)) {
        reachedCoverage = true;
        break;
      }
      if (!item.decoded) continue;
      const method = item.decoded.method_call;
      const p = Object.fromEntries(item.decoded.parameters.map((x) => [x.name, x.value]));
      const blockTime = Math.floor(new Date(item.block_timestamp).getTime() / 1000);

      if (method.startsWith('EscrowPosted(')) {
        cbtcCandidates.push({ item, p, blockNumber, blockTime });
      } else if (method.startsWith('CdpMinted(')) {
        cusdCandidates.push({ item, p, blockNumber, blockTime });
      }
    }

    if (reachedCoverage || !data.next_page_params) break;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }

  cbtcCandidates.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  cusdCandidates.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));

  let cbtcCount = store.countByActivity('cbtcmint');
  for (const { item, p, blockNumber, blockTime } of cbtcCandidates) {
    const depositor = (await realCbtcDepositor(item.transaction_hash, p.from)).toLowerCase();
    const wrote = store.recordDeposit({
      txHash: item.transaction_hash, blockNumber: Number(blockNumber), blockTime,
      depositor, amountWei: String(p.amount), priorDepositCount: cbtcCount,
      points: pointsForCbtcEscrow(p.amount, cbtcCount), activity: 'cbtcmint',
    });
    if (wrote) cbtcCount += 1;
  }

  let cusdCount = store.countByActivity('cusdmint');
  for (const { item, p, blockNumber, blockTime } of cusdCandidates) {
    // No borrower address on CdpMinted — same convention as the wrap scanner: the transaction's own
    // signer, not any confidential note owner (which isn't public anyway).
    const tx = await publicClient.getTransaction({ hash: item.transaction_hash });
    const wrote = store.recordDeposit({
      txHash: item.transaction_hash, blockNumber: Number(blockNumber), blockTime,
      depositor: tx.from.toLowerCase(), amountWei: String(p.debtValue), priorDepositCount: cusdCount,
      points: pointsForCusdMint(p.debtValue, cusdCount), activity: 'cusdmint',
    });
    if (wrote) cusdCount += 1;
  }

  if (newestSeen != null && (priorCursor == null || newestSeen > priorCursor)) store.saveCeCursor(newestSeen);
}

function pointsForZswapEth(valueWei, priorCount) {
  return (Number(valueWei) / 1e18) * CFG.pointsBasePerZswapEth * earlyAdopterBonus(priorCount);
}

// A fourth way to earn points: swapping ETH through zSwap/zRouter. Deliberately forward-only (no
// backfill) — the cursor starts at whatever block this service first sees live, not any deploy block.
// zRouter's own event log carries nothing but OwnershipTransferred (the pools it routes through emit their
// own Swap events, not zRouter), so this detects a swap by the plain on-chain fact of it instead: a
// top-level transaction sending ETH directly to zRouter. `tx.from` on a top-level transaction already IS
// the originating EOA — there's no separate tx.origin to fetch; that distinction only exists inside a
// contract's own internal call chain, which a plain transaction object can't show.
async function scanZRouterCycle(store) {
  const cursorBlock = store.loadZrouterCursor();
  const latest = await publicClient.getBlockNumber();
  const confirmedTip = latest - BigInt(CFG.pointsConfirmations);
  const from = cursorBlock != null ? cursorBlock + 1n : confirmedTip + 1n;
  if (confirmedTip < from) return;

  const candidates = [];
  for (let b = from; b <= confirmedTip; b++) {
    const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions) {
      if (tx.to && tx.to.toLowerCase() === ADDR.zRouter.toLowerCase() && tx.value > 0n) {
        candidates.push({ tx, blockTime: Number(block.timestamp) });
      }
    }
  }

  let priorCount = store.countByActivity('zswapeth');
  for (const { tx, blockTime } of candidates) {
    const depositor = tx.from.toLowerCase();
    const wrote = store.recordDeposit({
      txHash: tx.hash, blockNumber: Number(tx.blockNumber), blockTime,
      depositor, amountWei: tx.value.toString(), priorDepositCount: priorCount,
      points: pointsForZswapEth(tx.value, priorCount), activity: 'zswapeth',
    });
    if (wrote) priorCount += 1;
  }

  store.saveZrouterCursor(confirmedTip);
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
      const depositor = tx.from.toLowerCase();
      // Boosted only when the depositor itself has EVER been paid out by a Privacy Pools ETH withdrawal at
      // or before this wrap's own block — see scanPrivacyPoolCycle. This runs once per deposit, against the
      // local cache only, never a live RPC call.
      const ppBoosted = store.hasEarlierPpWithdrawal(depositor, Number(evt.blockNumber));
      let points = pointsForDeposit(evt.args.amount, priorDepositCount);
      if (ppBoosted) points *= CFG.ppBoostMultiplier;
      const wrote = store.recordDeposit({
        txHash: evt.transactionHash,
        blockNumber: Number(evt.blockNumber),
        blockTime: Number(block.timestamp),
        // tx.from, not msg.sender as seen by the pool: whether this call reached the pool directly or via
        // WrapTipForwarder, tx.from is always the EOA that signed and funded it — the true depositor, never
        // the forwarder's own address, and unaffected by whatever tipRecipient it chose.
        depositor,
        amountWei: evt.args.amount.toString(),
        priorDepositCount,
        points,
        ppBoosted: ppBoosted ? 1 : 0,
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
        const ppCursor = store.loadPpCursor();
        const ceCursor = store.loadCeCursor();
        res.end(JSON.stringify({
          ok: true,
          lastScannedBlock: cursor ? cursor.lastScannedBlock.toString() : null,
          ethDepositCount: cursor ? cursor.ethDepositCount : 0,
          // Privacy Pools scan is a separate backfill (see scanPrivacyPoolCycle) — surfaced here so a stalled
          // or still-catching-up scan is visible without a dedicated endpoint.
          ppLastScannedBlock: ppCursor != null ? ppCursor.toString() : null,
          // CollateralEngine scan (cBTC escrow + cUSD mint activity — see scanCollateralEngineCycle).
          ceLastScannedBlock: ceCursor != null ? ceCursor.toString() : null,
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
          const dayRows = store.dayPointsByAddress(dayStart, dayStart + 86400);
          const row = dayRows.find((r) => r.address.toLowerCase() === address.toLowerCase());
          // The running total as of THIS request, not a settled end-of-day figure — it moves as more
          // addresses deposit today, same as `row`'s own count does.
          const totalPoints = dayRows.reduce((s, r) => s + r.dayPoints, 0);
          today = { points: row ? row.dayPoints : 0, totalPoints, dayBudgetWei: dayBudgetWei(todayDay - startDay).toString() };
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
    // Runs before scanCycle so any Privacy Pools withdrawal that landed this cycle is already cached by the
    // time a same-cycle wrap is scored against it.
    try {
      await scanPrivacyPoolCycle(store);
    } catch (err) {
      log('privacy pool scan cycle failed:', err?.message || err);
    }
    try {
      await scanCollateralEngineCycle(store);
    } catch (err) {
      log('collateral engine scan cycle failed:', err?.message || err);
    }
    try {
      await scanZRouterCycle(store);
    } catch (err) {
      log('zRouter scan cycle failed:', err?.message || err);
    }
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
