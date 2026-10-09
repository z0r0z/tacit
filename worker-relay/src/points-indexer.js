// ETH-wrap points program. Purely a read + tally over the pool's existing Wrap event and each wrap's
// tx sender — no contract change, no interaction with settle/reflection. See CFG's "Points program"
// section (lib/config.js) for the formula and every tunable.
//
// Deliberately forward-only: counts wraps from CFG.pointsStartBlock on, nothing earlier. Informational
// only for now — this serves a leaderboard/lookup API; it does not mint or gate anything on-chain.

import { createServer } from 'node:http';
import { createWalletClient, http, decodeEventLog, keccak256, toBytes, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CFG, ADDR } from './lib/config.js';
import { publicClient, clientForChain } from './lib/chain.js';
import { withNonceRetry } from './lib/nonce-retry.js';
import { parseRateCapSchedule, rateCapForDay } from './lib/points-rate-cap.js';
import { settleThroughDay as gateThroughDay } from './lib/points-settle-gate.js';
import { parseAdjustments } from './lib/points-adjustments.js';
import { creditLateDays } from './lib/points-late-credit.js';
import { makeBlockAtOrBefore } from './lib/block-at-time.js';
import { fundingStatus, fundingVerdict } from './lib/points-funding.js';
import { tvlSeries } from './lib/points-tvl.js';
import { programTerms } from './lib/points-program.js';
import { makeCounted } from './lib/points-counted.js';
import { createHolding } from './lib/holding-service.js';
import { parseBuckets } from './lib/holding-epoch.js';
import { loadHash } from './lib/poseidon-hash.js';
import { readJson } from './lib/http-json.js';
import { clientKey } from './lib/token-bucket.js';
import { makeClient as holdingClient } from './lib/evm-pool-snapshot-chain.js';
import { decideBondHolds, accrueBondHolds } from './lib/points-bond-hold.js';
import { parseCategoryWeights, parseEngagementSchedule } from './lib/points-engagement.js';
import { dayPot, dayBoard, dayHistory, splitDayBudget } from './lib/points-day-board.js';
import Database from 'better-sqlite3';
import { openStore } from './lib/points-store.js';
import { parseBoostTiers, openTacBoost, scanTacTransfers } from './lib/tac-holder-boost.js';
import { build as buildMerkleTree, formatTac } from './lib/points-merkle.js';
import {
  openEvmPoolPointsState, scanEvmPoolChain, resolvePendingBoxes, explorerGet, isV1WrapViaEvmRouter, WRAP_BOX_COMPLETED_EVENT, rpcRefusal,
} from './lib/evm-pool-points.js';

const log = (...a) => console.log(`[points ${new Date().toISOString()}]`, ...a);

// TAC-holder and Z-share-holder boosts (lib/tac-holder-boost.js, the second opened under the 'zshare'
// namespace). Null when their *_BOOST_TIERS is empty: that multiplier is then 1 and it holds no scan back.
// The two stack multiplicatively.
let tacBoost = null;
let zShareBoost = null;
function tacMultiplier(address, blockNumber) {
  return tacBoost ? tacBoost.boostFor(address, Number(blockNumber)).multiplier : 1;
}
function zShareMultiplier(address, blockNumber) {
  return zShareBoost ? zShareBoost.boostFor(address, Number(blockNumber)).multiplier : 1;
}
// An activity can only be scored once BOTH transfer replays cover its block, so each scan stops at whichever
// is behind.
function capToBoostCoverage(tip) {
  let capped = tip;
  if (tacBoost) { const c = BigInt(tacBoost.coveredThrough()); if (c < capped) capped = c; }
  if (zShareBoost) { const c = BigInt(zShareBoost.coveredThrough()); if (c < capped) capped = c; }
  return capped;
}

// Resolves an L2 swap's boost-eligibility block deterministically from its own blockTime, not from whatever
// the mainnet tip happens to be when the scan runs — a scan replayed later (e.g. after a DB rebuild) must
// reproduce the exact same multiplier for the exact same swap, the same property settle_state.knobs guards
// for every other activity. Binary search over mainnet block timestamps (monotonic) for the last block at or
// before `targetTime`, up to `tip` (a real, uncapped mainnet block number).
const mainnetBlockAtOrBefore = makeBlockAtOrBefore(async (n) => (await publicClient.getBlock({ blockNumber: n })).timestamp);

// One-time fast catch-up for a freshly (re-)enabled boost, run once at startup before scanTacTransfers's
// eth_getLogs-based incremental scan takes over. That scan chunks by block range, and this RPC caps
// eth_getLogs ranges hard regardless of how few events are actually in them (the same limit
// scanPrivacyPoolCycle above works around) — backfilling a token's whole history that way is thousands of
// tiny range calls and would hold every points activity frozen for hours. Blockscout's transfers endpoint
// pages by item count instead, so it costs a handful of calls for these low-volume boost tokens. Walks
// backward (newest first) until a page is entirely at or before what's already covered, then hands the
// collected rows to `boost` directly — scanTacTransfers's own small incremental ranges near head are cheap
// enough on this RPC and don't need this.
async function blockscoutBackfillBoost(boost, token, confirmedTip) {
  const already = boost.coveredThrough();
  if (already >= confirmedTip) return;
  const collected = [];
  let params = '';
  for (;;) {
    const res = await blockscoutFetch(`${PP_BLOCKSCOUT_BASE}/tokens/${token}/transfers${params}`);
    if (!res.ok) throw new Error(`blockscout token-transfers ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) break;
    let reachedCoverage = false;
    for (const item of items) {
      if (item.block_number <= already) { reachedCoverage = true; break; }
      if (item.block_number > confirmedTip) continue; // not yet confirmed, scanTacTransfers will pick it up
      collected.push({
        txHash: item.transaction_hash, logIndex: Number(item.log_index), blockNumber: item.block_number,
        from: item.from.hash, to: item.to.hash, valueWei: item.total.value,
      });
    }
    if (reachedCoverage || !data.next_page_params) break;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }
  boost.recordTransfers(collected, confirmedTip);
}

const DISTRIBUTOR_ABI = [
  { type: 'function', name: 'updateRoot', stateMutability: 'nonpayable', inputs: [{ name: 'newRoot', type: 'bytes32' }, { name: 'newTotalAllocated', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'totalClaimed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const ERC20_BALANCEOF_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ESCROW_OF_ABI = [
  { type: 'function', name: 'escrowOf', stateMutability: 'view', inputs: [{ name: 'outpoint', type: 'bytes32' }, { name: 'funder', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const POOL_LOCK_ABI = [
  { type: 'function', name: 'cbtcLockVBtc', stateMutability: 'view', inputs: [{ name: 'outpoint', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'cbtcLockSpent', stateMutability: 'view', inputs: [{ name: 'outpoint', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'cbtcLockRedeemed', stateMutability: 'view', inputs: [{ name: 'outpoint', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'cbtcMinted', stateMutability: 'view', inputs: [{ name: 'outpoint', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
];
const HELPER_ESCROW_OF_ABI = [
  { type: 'function', name: 'helperEscrowOf', stateMutability: 'view', inputs: [{ name: 'outpoint', type: 'bytes32' }, { name: 'depositor', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const REQUIRED_ESCROW_ABI = [
  { type: 'function', name: 'requiredEscrow', stateMutability: 'view', inputs: [{ name: 'vBtc', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
];
const escrowHelpers = new Set(ADDR.cbtcEscrowHelpers.map((a) => a.toLowerCase()));
// What a depositor has posted on an outpoint now. Through a helper the engine holds every depositor's share under the helper's one
// address, and one depositor's reclaim posts the others' part straight back, so the helper's own record of the depositor is what is read.
const readEscrowOf = (outpoint, funder, depositor) => (escrowHelpers.has(String(funder).toLowerCase())
  ? publicClient.readContract({ address: funder, abi: HELPER_ESCROW_OF_ABI, functionName: 'helperEscrowOf', args: [outpoint, depositor] })
  : publicClient.readContract({ address: ADDR.collateralEngine, abi: ESCROW_OF_ABI, functionName: 'escrowOf', args: [outpoint, funder] }));
// What the pool knows of a lock: its size, whether cBTC is minted against it, and whether it is spent or redeemed.
const readLockState = async (outpoint) => {
  const call = (functionName) => publicClient.readContract({ address: ADDR.pool, abi: POOL_LOCK_ABI, functionName, args: [outpoint] });
  const [vBtc, spent, redeemed, minted] = await Promise.all([call('cbtcLockVBtc'), call('cbtcLockSpent'), call('cbtcLockRedeemed'), call('cbtcMinted')]);
  return { vBtc, spent, redeemed, minted };
};
// The same, with the escrow the lock needs at the engine's price (which reverts on a stale feed, so only the daily credit reads it).
const readBondLock = async (outpoint) => {
  const lock = await readLockState(outpoint);
  const required = lock.vBtc > 0n ? await publicClient.readContract({ address: ADDR.collateralEngine, abi: REQUIRED_ESCROW_ABI, functionName: 'requiredEscrow', args: [lock.vBtc] }) : 0n;
  return { ...lock, required };
};
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
const ROOT_SETTER_MIN_TIP_WEI = 50_000_000n; // 0.05 gwei — same floor as header-relay's MIN_TIP_WEI
const ROOT_SETTER_RECEIPT_TIMEOUT_MS = 300_000;

const rateCapSchedule = parseRateCapSchedule(CFG.pointsRateCapSchedule, log);
const ledgerAdjustments = parseAdjustments(CFG.pointsLedgerAdjustments, log);
const categoryWeights = parseCategoryWeights(CFG.pointsCategoryWeights, log);
const engagementSchedule = parseEngagementSchedule(CFG.pointsEngagement, log);
// The rows each UTC day is split by: settlement and every read of a day go through this one.
const countedFor = (store, onTime = false) => makeCounted({ store, weightSchedule: categoryWeights, engagementSchedule, bondHoldFromDay: CFG.pointsBondHoldFromDay, onTime });

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
// A bare fetch() has no default timeout — if Blockscout's connection hangs (no response at all, not even an
// eventual error status), this can block forever. Every raw Blockscout call in this file goes through this
// specifically because that happened live: a stuck weiname backfill call froze zRouter and ETH-wrap scoring
// for the rest of the process, since main()'s loop awaits each scan in sequence and nothing after a hung one
// ever runs again. Turning a hang into a thrown error lets main()'s existing per-scan try/catch do its job.
async function blockscoutFetch(url) {
  return fetch(url, { signal: AbortSignal.timeout(15000) });
}
const NATIVE_ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
// PM.sol's own convention for "this market's collateral is native ETH" — the real zero address, NOT the
// 0xEeee...EEeE sentinel Privacy Pools uses above (a different third-party protocol's own convention).
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
    const res = await blockscoutFetch(`${PP_BLOCKSCOUT_BASE}/addresses/${ADDR.ppEntrypoint}/logs${params}`);
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
// keccak256("HelperEscrowPosted(bytes32,address,uint256)") — CbtcEscrowHelper.sol; outpoint and depositor are indexed.
const HELPER_ESCROW_POSTED_TOPIC = keccak256(toBytes('HelperEscrowPosted(bytes32,address,uint256)'));
async function scanCollateralEngineCycle(store) {
  // Bonds posted before their references were kept have none: one walk from the engine's first block fills them in. Rows
  // already recorded are left as they are (recordDeposit ignores them); only the references are added.
  const backfillRefs = store.getMeta('bond_refs_backfilled') == null;
  const storedCursor = store.loadCeCursor();
  const priorCursor = backfillRefs ? null : storedCursor;
  // Blocks the scan had already covered: during the backfill these only yield references. What is newer is recorded as always.
  const alreadyCovered = (blockNumber) => backfillRefs && storedCursor != null && blockNumber <= storedCursor;
  const deployBlock = BigInt(CFG.collateralEngineDeployBlock);
  let newestSeen = null;
  let params = '';
  const cbtcCandidates = [];
  const cusdCandidates = [];

  // EscrowPosted's own `from` is the real depositor UNLESS the call was routed through a CbtcEscrowHelper, in
  // which case `from` is that helper's own address and the helper's OWN event (HelperEscrowPosted, same tx)
  // names the real one — same tx-hash cross-reference points-indexer.js already does for wrap tips.
  const cbtcEscrowHelperSet = new Set(ADDR.cbtcEscrowHelpers.map((a) => a.toLowerCase()));
  async function realCbtcDepositor(txHash, rawFrom, blockTime) {
    if (!cbtcEscrowHelperSet.has(rawFrom.toLowerCase())) return rawFrom;
    const res = await blockscoutFetch(`${PP_BLOCKSCOUT_BASE}/transactions/${txHash}/logs`);
    if (!res.ok) {
      // Retried with the whole page rather than recorded under the helper's address; but a transaction that still cannot be
      // read well after it happened stops holding the scan back (the grace settlement itself allows), so one bad transaction
      // cannot stop every bond after it.
      if (Math.floor(Date.now() / 1000) - blockTime < CFG.pointsSettleMaxWaitSecs) throw new Error(`blockscout tx logs ${res.status}`);
      log(`bond tx ${txHash}: logs unreadable ${res.status} long after it happened, credited to ${rawFrom}`);
      return rawFrom;
    }
    const data = await res.json();
    for (const item of data.items || []) {
      if (item.decoded && item.decoded.method_call.startsWith('HelperEscrowPosted(')) {
        const p = Object.fromEntries(item.decoded.parameters.map((x) => [x.name, x.value]));
        if (p.depositor) return p.depositor;
      }
      // Undecoded (a helper the explorer has no ABI for yet): the depositor is the event's second indexed topic.
      const tp = item.topics || [];
      if (!item.decoded && String(tp[0]).toLowerCase() === HELPER_ESCROW_POSTED_TOPIC && cbtcEscrowHelperSet.has(String(item.address?.hash || item.address || '').toLowerCase()) && tp[2]) {
        return '0x' + String(tp[2]).slice(-40).toLowerCase();
      }
    }
    return rawFrom;
  }

  for (;;) {
    const res = await blockscoutFetch(`${PP_BLOCKSCOUT_BASE}/addresses/${ADDR.collateralEngine}/logs${params}`);
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

  // Blockscout serves blocks a boost's transfer replay hasn't reached yet. Score nothing and keep the cursor,
  // so the whole page is retried next cycle rather than recording those activities unboosted.
  const newestCandidate = [...cbtcCandidates, ...cusdCandidates].reduce((m, c) => (c.blockNumber > m ? c.blockNumber : m), 0n);
  if (capToBoostCoverage(newestCandidate) < newestCandidate) return;

  let cbtcCount = store.countByActivity('cbtcmint');
  for (const { item, p, blockNumber, blockTime } of cbtcCandidates) {
    // A bond already recorded only needs its reference; the walk that fills references in records nothing new, so it cannot
    // credit an old bond to a day that has settled.
    const known = store.depositorOfTx(item.transaction_hash);
    if (known || alreadyCovered(blockNumber)) {
      if (known) store.saveBondRef({ txHash: item.transaction_hash, outpoint: p.outpoint, funder: p.from });
      continue;
    }
    const depositor = (await realCbtcDepositor(item.transaction_hash, p.from, blockTime)).toLowerCase();
    const tacB = tacMultiplier(depositor, blockNumber);
    const zShareB = zShareMultiplier(depositor, blockNumber);
    const wrote = store.recordDeposit({
      txHash: item.transaction_hash, blockNumber: Number(blockNumber), blockTime,
      depositor, amountWei: String(p.amount), priorDepositCount: cbtcCount,
      points: pointsForCbtcEscrow(p.amount, cbtcCount) * tacB * zShareB, activity: 'cbtcmint', tacBoost: tacB, zShareBoost: zShareB,
    });
    if (wrote) cbtcCount += 1;
    // The outpoint and the funder the escrow share sits under (the helper, when one posted it), for the hold check.
    store.saveBondRef({ txHash: item.transaction_hash, outpoint: p.outpoint, funder: p.from });
  }

  let cusdCount = store.countByActivity('cusdmint');
  for (const { item, p, blockNumber, blockTime } of cusdCandidates) {
    if (alreadyCovered(blockNumber)) continue;
    // No borrower address on CdpMinted — same convention as the wrap scanner: the transaction's own
    // signer, not any confidential note owner (which isn't public anyway).
    const tx = await publicClient.getTransaction({ hash: item.transaction_hash });
    const depositor = tx.from.toLowerCase();
    const tacB = tacMultiplier(depositor, blockNumber);
    const zShareB = zShareMultiplier(depositor, blockNumber);
    const wrote = store.recordDeposit({
      txHash: item.transaction_hash, blockNumber: Number(blockNumber), blockTime,
      depositor, amountWei: String(p.debtValue), priorDepositCount: cusdCount,
      points: pointsForCusdMint(p.debtValue, cusdCount) * tacB * zShareB, activity: 'cusdmint', tacBoost: tacB, zShareBoost: zShareB,
    });
    if (wrote) cusdCount += 1;
  }

  if (newestSeen != null && (priorCursor == null || newestSeen > priorCursor)) store.saveCeCursor(newestSeen);
  if (backfillRefs) store.setMeta('bond_refs_backfilled', String(Math.floor(Date.now() / 1000)));
}

function pointsForPmBet(amountWei, priorCount) {
  return (Number(amountWei) / 1e18) * CFG.pointsBasePerPmBet * earlyAdopterBonus(priorCount);
}
function pointsForPmCreate(priorCount) {
  return CFG.pointsPerPmCreate * earlyAdopterBonus(priorCount);
}

// A fifth way to earn points: creating or betting in an ETH-denominated PM market (zfi's parimutuel
// prediction-market singleton, src/PM.sol — mainnet only). Same Blockscout-pagination approach as
// scanPrivacyPoolCycle/scanCollateralEngineCycle, since this address's own history would hit the same
// eth_getLogs range cap on a cold-start backfill.
//
// A market's collateral asset is fixed at Created and is address(0) for ETH — both a market's creator and
// every bettor in it only earn points when that holds; a market funded in any other asset earns nothing
// here. Every market's asset is persisted to pm_markets regardless (not just ETH ones), so a later Bet's
// lookup is a definite "not eth" rather than an ambiguous "not yet scanned."
//
// A Bet event alone carries no trader — PM.sol mints the winning-side share to the bettor as its own
// ERC-6909-style Transfer(caller, from=0x0, to, id, amount) in the SAME tx, immediately before the Bet log
// (same index - 1). `to` is the real bettor (not `caller`, the tx signer — they differ when someone bets on
// another address's behalf); `id` is the share id, and marketId = id with its low bit cleared (YES/NO share
// ids are marketId and marketId|1).
//
// This is scored immediately at Bet time, not deferred to market resolution — a bet-then-Exited round trip
// can currently farm points cheaply (paying only the exit fee each cycle), a real gap a zfi peer flagged.
// Accepted deliberately: points are an epoch allocation, not a fixed mint, so this can be tightened in a
// later epoch without touching any TAC already claimed under an earlier one.
//
// The creator reward is a DIFFERENT hole, not the same tradeoff: creating a market costs nothing at all (no
// collateral, no bet, any resolver including yourself), so a flat reward at Created alone is free-to-farm at
// gas cost only — one script could mint unlimited creator points (a second zfi finding). This one IS closed:
// the reward is deferred until the market's first Bet from an address other than the creator (of at least
// pmMinQualifyingBetWei — otherwise the creator's own second wallet placing a dust bet would satisfy this at
// near-zero extra cost, a residual the same zfi peer flagged), gated by pm_markets.creator_awarded so it only
// ever fires once per market regardless of how many further bets follow.
async function scanPmCycle(store) {
  const priorCursor = store.loadPmCursor();
  const deployBlock = BigInt(CFG.pmDeployBlock);
  let newestSeen = null;
  let params = '';
  const byTxHash = new Map(); // tx_hash -> item[], every item this cycle saw for that tx (any event type)
  const createdItems = [];

  for (;;) {
    const res = await blockscoutFetch(`${PP_BLOCKSCOUT_BASE}/addresses/${ADDR.pm}/logs${params}`);
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
      if (!method.startsWith('Bet(') && !method.startsWith('Transfer(') && !method.startsWith('Created(')) continue;
      const p = Object.fromEntries(item.decoded.parameters.map((x) => [x.name, x.value]));
      const blockTime = Math.floor(new Date(item.block_timestamp).getTime() / 1000);
      const entry = { item, p, blockNumber, blockTime, index: item.index, method };
      if (method.startsWith('Created(')) createdItems.push(entry);
      const list = byTxHash.get(item.transaction_hash) ?? [];
      list.push(entry);
      byTxHash.set(item.transaction_hash, list);
    }

    if (reachedCoverage || !data.next_page_params) break;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }

  createdItems.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  // marketId -> { isEth, creator, createdTxHash } for markets created THIS cycle, since a market created
  // earlier in this same page walk isn't in the store yet when the bet-pairing pass below needs to look it up.
  // marketId is kept as a STRING throughout (never Number()) — PM's real ids are full uint256s, hash-derived
  // and nowhere near Number.MAX_SAFE_INTEGER, so downcasting one silently corrupts it (a real bug this
  // avoided from the start would have caught before any real market existed).
  const marketsThisBatch = new Map();
  for (const { item, p } of createdItems) {
    const isEth = String(p.asset).toLowerCase() === ZERO_ADDRESS;
    const creator = String(p.creator).toLowerCase();
    const marketId = String(p.marketId);
    store.recordPmMarket(marketId, isEth, creator, item.transaction_hash);
    marketsThisBatch.set(marketId, { isEth, creator, createdTxHash: item.transaction_hash });
  }

  // Pair each Bet with the mint Transfer immediately before it in the same tx (index - 1), then resolve its
  // market (this batch first, else the store) to filter to ETH-denominated markets and to check whether this
  // is the market's first bet from someone other than its creator.
  const betCandidates = [];
  for (const list of byTxHash.values()) {
    list.sort((a, b) => a.index - b.index);
    for (let i = 1; i < list.length; i++) {
      const bet = list[i];
      const xfer = list[i - 1];
      if (!bet.method.startsWith('Bet(')) continue;
      if (!xfer.method.startsWith('Transfer(') || String(xfer.p.from).toLowerCase() !== ZERO_ADDRESS) continue;
      if (String(xfer.p.id) !== String(bet.p.id)) continue; // defensive: same share id on both halves of the pair
      const marketId = (BigInt(bet.p.id) & ~1n).toString();
      const market = marketsThisBatch.get(marketId) ?? store.getPmMarket(marketId);
      if (!market || !market.isEth) continue;
      const bettor = String(xfer.p.to).toLowerCase();
      betCandidates.push({
        item: bet.item, marketId, bettor, amountWei: bet.p.amount, blockNumber: bet.blockNumber, blockTime: bet.blockTime,
        creator: market.creator, createdTxHash: market.createdTxHash, creatorAlreadyAwarded: market.creatorAwarded === true,
      });
    }
  }
  betCandidates.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));

  // Same guard as scanCollateralEngineCycle/scanWeinameCycle: Blockscout serves blocks a boost's transfer
  // replay hasn't reached yet. Score nothing and keep the cursor, so the whole page is retried next cycle
  // rather than either recording a bet/creator-award unboosted or reaching tacMultiplier/zShareMultiplier past
  // their coverage, which throws and would abort every candidate in this batch on every retry until the
  // replay caught all the way up to the newest one — markets are still recorded above regardless, since that
  // part carries no boost multiplier and needs no such guard.
  const newestCandidate = betCandidates.reduce((m, c) => (c.blockNumber > m ? c.blockNumber : m), 0n);
  if (capToBoostCoverage(newestCandidate) < newestCandidate) return;

  let betCount = store.countByActivity('pmbet');
  let createCount = store.countByActivity('pmcreate');
  const creatorAwardedThisCycle = new Set(); // marketId — belt-and-suspenders against awarding twice within one batch
  for (const { item, marketId, bettor, amountWei, blockNumber, blockTime, creator, createdTxHash, creatorAlreadyAwarded } of betCandidates) {
    const tacB = tacMultiplier(bettor, blockNumber);
    const zShareB = zShareMultiplier(bettor, blockNumber);
    const wrote = store.recordDeposit({
      txHash: item.transaction_hash, blockNumber: Number(blockNumber), blockTime,
      depositor: bettor, amountWei: String(amountWei), priorDepositCount: betCount,
      points: pointsForPmBet(amountWei, betCount) * tacB * zShareB, activity: 'pmbet', tacBoost: tacB, zShareBoost: zShareB,
    });
    if (wrote) betCount += 1;

    if (bettor !== creator && BigInt(amountWei) >= CFG.pmMinQualifyingBetWei && !creatorAlreadyAwarded && !creatorAwardedThisCycle.has(marketId)) {
      const creatorTacB = tacMultiplier(creator, blockNumber);
      const creatorZShareB = zShareMultiplier(creator, blockNumber);
      // Keyed on the market's own Created tx hash — real, unique per market, and never the triggering bet's
      // own hash (which already keys the bettor's row above and would collide on deposits' tx_hash PK).
      const wroteCreate = store.recordDeposit({
        txHash: createdTxHash, blockNumber: Number(blockNumber), blockTime,
        depositor: creator, amountWei: '0', priorDepositCount: createCount,
        points: pointsForPmCreate(createCount) * creatorTacB * creatorZShareB, activity: 'pmcreate',
        tacBoost: creatorTacB, zShareBoost: creatorZShareB,
      });
      if (wroteCreate) createCount += 1;
      store.markPmCreatorAwarded(marketId);
      creatorAwardedThisCycle.add(marketId);
    }
  }

  if (newestSeen != null && (priorCursor == null || newestSeen > priorCursor)) store.savePmCursor(newestSeen);
}

function pointsForWeiname(amountWei, priorCount) {
  return (Number(amountWei) / 1e18) * CFG.pointsBasePerWeiname * earlyAdopterBonus(priorCount);
}

// A sixth way to earn points: registering a .wei name through zRouter (NameNFT's revealName flow). Mainnet
// only. zRouter pays its whole ETH balance into NameNFT.reveal{value}, then transfers the new tokenId to the
// real registrant — so the signal is NameNFT's own NameRegistered(tokenId, label, owner, expiresAt) with
// owner == zRouter (the router registers, then hands it off), paired by tokenId with a same-tx ERC-721
// Transfer(from=zRouter, to=recipient, id=tokenId) for who actually receives it (falls back to the
// transaction's own signer if no such Transfer is found). Same Blockscout-pagination approach as PM/
// CollateralEngine/Privacy Pools, for the same reason: this address's own eth_getLogs range could hit the
// same RPC cap on a cold-start backfill.
//
// Unlike wrap/sweep, this ETH is spent for good — NameNFT keeps it outright, there's no round trip a farmer
// could loop — so this scores immediately with no gaming mitigation needed, and a free .id.wei name (0 ETH
// kept) simply earns 0 automatically rather than needing a special case.
async function scanWeinameCycle(store) {
  const priorCursor = store.loadWeinameCursor();
  const deployBlock = BigInt(CFG.weinameDeployBlock);
  let newestSeen = null;
  let params = '';
  const registeredCandidates = [];
  const transfersByTx = new Map(); // tx_hash -> Map(tokenId -> recipient)

  for (;;) {
    const res = await blockscoutFetch(`${PP_BLOCKSCOUT_BASE}/addresses/${ADDR.nameNft}/logs${params}`);
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
      if (method.startsWith('NameRegistered(') && String(p.owner).toLowerCase() === ADDR.zRouter.toLowerCase()) {
        registeredCandidates.push({ item, tokenId: String(p.tokenId), blockNumber, blockTime });
      } else if (method.startsWith('Transfer(') && String(p.from).toLowerCase() === ADDR.zRouter.toLowerCase()) {
        const byToken = transfersByTx.get(item.transaction_hash) ?? new Map();
        byToken.set(String(p.id), String(p.to).toLowerCase());
        transfersByTx.set(item.transaction_hash, byToken);
      }
    }

    if (reachedCoverage || !data.next_page_params) break;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }

  registeredCandidates.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));

  // Same guard as scanCollateralEngineCycle: Blockscout serves blocks a boost's transfer replay hasn't reached
  // yet. Score nothing and keep the cursor, so the whole page is retried next cycle rather than either
  // recording a registration unboosted or reaching tacMultiplier/zShareMultiplier past their coverage (which
  // throws — this is exactly what aborted a real registration's scoring the first time this came up live).
  const newestCandidate = registeredCandidates.reduce((m, c) => (c.blockNumber > m ? c.blockNumber : m), 0n);
  if (capToBoostCoverage(newestCandidate) < newestCandidate) return;

  let priorCount = store.countByActivity('weiname');
  for (const { item, tokenId, blockNumber, blockTime } of registeredCandidates) {
    const txHash = item.transaction_hash;
    const recipient = transfersByTx.get(txHash)?.get(tokenId);
    let depositor;
    if (recipient) {
      depositor = recipient;
    } else {
      const tx = await publicClient.getTransaction({ hash: txHash });
      depositor = tx.from.toLowerCase();
    }

    // The ETH NameNFT actually kept — a free .id.wei name has none, and simply scores 0 below. Netted, not a
    // one-directional sum: zRouter's revealName forwards its whole balance to NameNFT.reveal (confirmed against
    // its verified mainnet source), and the registry refunds any overpayment straight back to zRouter as a
    // separate internal transfer before zRouter sweeps that refund out to the buyer — so a plain zRouter→NameNFT
    // sum counts the gross amount forwarded, not the net amount actually kept, whenever a reveal executes for
    // less than the router's balance at call time (premium decay between quote and mining, or dust left over
    // from an earlier leg of the same multicall). Same grace window and fail-closed direction as the V4
    // settlement check: a fresh lookup that's genuinely still unindexed retries the whole cycle, but past 30
    // minutes from this registration's own block, treat it as unresolved and skip crediting for it rather than
    // guessing (a registration itself is never in doubt — NameRegistered came from NameNFT's own canonical
    // address — only how much ETH it cost is uncertain here).
    let amountWei;
    try {
      const { net, indexed } = await internalEthTransferNet(PP_BLOCKSCOUT_BASE, txHash, ADDR.zRouter, ADDR.nameNft);
      if (!indexed) throw new Error(`internal-transactions not yet indexed for ${txHash}`);
      amountWei = net;
    } catch (err) {
      if (Date.now() / 1000 - blockTime < 1800) throw err;
      log(`weiname ETH-kept lookup still unresolved 30+ min after block time for ${txHash}, skipping:`, err?.message || err);
      continue;
    }
    if (amountWei <= 0n) continue;

    const tacB = tacMultiplier(depositor, blockNumber);
    const zShareB = zShareMultiplier(depositor, blockNumber);
    const wrote = store.recordDeposit({
      txHash, blockNumber: Number(blockNumber), blockTime,
      depositor, amountWei: amountWei.toString(), priorDepositCount: priorCount,
      points: pointsForWeiname(amountWei, priorCount) * tacB * zShareB, activity: 'weiname', tacBoost: tacB, zShareBoost: zShareB,
    });
    if (wrote) priorCount += 1;
  }

  if (newestSeen != null && (priorCursor == null || newestSeen > priorCursor)) store.saveWeinameCursor(newestSeen);
}

function pointsForZswapEth(valueWei, priorCount) {
  return (Number(valueWei) / 1e18) * CFG.pointsBasePerZswapEth * earlyAdopterBonus(priorCount);
}

const WETH_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const WETH_DEPOSIT_EVENT = {
  type: 'event',
  name: 'Deposit',
  inputs: [
    { name: 'dst', type: 'address', indexed: true },
    { name: 'wad', type: 'uint256', indexed: false },
  ],
};

// Real pool factories per chain, for verifying a WETH transfer's destination is an actual DEX pool rather
// than an attacker-controlled contract — zRouter's SafeExecutor (the snwap target) will call any contract the
// caller names, which could otherwise emit fake Swap-shaped logs claiming huge amounts for free. A pool's own
// factory() is a real, unspoofable on-chain read; only pools whose factory matches one of these are trusted.
// Uniswap V2/Sushi, Uniswap V3, Aerodrome V2, Aerodrome Slipstream (CL) — addresses from zfi, checked against
// zFi source and live chain data.
const ZROUTER_POOL_FACTORIES = {
  1: new Set(['0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac', '0x1f98431c8ad98523631ae4a59f267346ea31f984']),
  8453: new Set(['0x8909dc15e40173ff4699343b6eb8132c65e18ec6', '0x33128a8fc17869897dce68ed026d694621f6fdfd', '0x420dd381b31aef6683db6b902084cb0ffece40da', '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a']),
  4663: new Set(['0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f', '0x1f7d7550b1b028f7571e69a784071f0205fd2efa']),
};
// zfi's own Precision AMM factory (same address on all 3 chains) — isPool() is that factory's own answer for
// whether an address is a real pool it deployed, equally unspoofable.
const PRECISION_POOL_FACTORY = '0x000000eb27b557ab426d9e99cfd54ec455799e81';
const FACTORY_FN_ABI = [{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
const IS_POOL_FN_ABI = [{ type: 'function', name: 'isPool', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }];
const ERC20_TRANSFER_EVENT = {
  type: 'event', name: 'Transfer',
  inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }],
};
const PRECISION_SWAP_EVENT = {
  type: 'event', name: 'Swap',
  inputs: [
    { name: 'tokenIn', type: 'address', indexed: true }, { name: 'amountIn', type: 'uint256', indexed: false },
    { name: 'amountOut', type: 'uint256', indexed: false }, { name: 'to', type: 'address', indexed: true },
  ],
};
// Uniswap V4's PoolManager — same core contract, canonical address on every chain it's deployed to (verified
// against zfi's addresses, and independently confirmed the sign convention below against two real mainnet
// zRouter V4 transactions before trusting it here).
const V4_POOL_MANAGER = {
  1: '0x000000000004444c5dc75cb358380d2e3de08a90',
  8453: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  4663: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
};
const V4_SWAP_EVENT = {
  type: 'event', name: 'Swap',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'amount0', type: 'int128', indexed: false }, { name: 'amount1', type: 'int128', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false }, { name: 'fee', type: 'uint24', indexed: false },
  ],
};

// zRouter also exposes public deposit/wrap/sweep primitives with no trade at all — wrap ETH into WETH then
// immediately sweep it back out (to the caller, a second wallet, or anywhere else) costs only gas and, before
// this existed, was credited in full and repeatable without limit (a zfi review finding). This verifies real
// ETH reached a pool that's independently provably real, reading logs directly off the tx's OWN receipt —
// never Blockscout's decoded/tagged data, which isn't a security boundary since tags are informational.
//
// V4 native-ETH swaps: rather than resolving a pool's currency0 (V4 doesn't store it anywhere queryable
// outside its one-time Initialize event, making that expensive to verify generally), this instead checks that
// the PoolManager's own Swap event — from its fixed, canonical, unspoofable address, with sender == zRouter —
// shows a paid-in amount exactly equal to this transaction's own tx.value. PoolManager only ever emits a
// settled delta once every side has actually been paid in full, so that exact match is proof real ETH backed
// it, without needing to know which side of the pool is currency0 at all. Confirmed on two real mainnet
// zRouter V4 transactions (zfi) before trusting it for anything that sizes a reward.
//
// This only verifies a candidate scanZRouterCycle already found — it doesn't discover new ones. Since only
// mainnet runs Signal 1 (the only signal that would surface a bare V4 native-ETH call, which never touches
// WETH), a V4 native-ETH swap on Base/Robinhood still isn't discovered at all yet, verification aside. Closing
// that needs its own getLogs-based discovery signal (a PoolManager Swap with sender == zRouter, cheap on any
// chain since it needs no block bodies) — a real follow-up, not something this change closes for L2s.
async function zRouterVerifiedSwapAmount(client, chainId, wethAddr, txHash, zRouter, blockTime) {
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash: txHash }),
    client.getTransaction({ hash: txHash }),
  ]);
  const factoryCache = new Map();
  async function isKnownPool(address) {
    const addr = address.toLowerCase();
    if (factoryCache.has(addr)) return factoryCache.get(addr);
    let ok = false;
    try {
      const factory = await client.readContract({ address, abi: FACTORY_FN_ABI, functionName: 'factory' });
      ok = ZROUTER_POOL_FACTORIES[chainId]?.has(factory.toLowerCase()) ?? false;
    } catch { /* not a V2/V3-shaped pool at all */ }
    factoryCache.set(addr, ok);
    return ok;
  }
  async function isPrecisionPool(address) {
    const addr = address.toLowerCase();
    if (factoryCache.has(`precision:${addr}`)) return factoryCache.get(`precision:${addr}`);
    let ok = false;
    try {
      ok = await client.readContract({ address: PRECISION_POOL_FACTORY, abi: IS_POOL_FN_ABI, functionName: 'isPool', args: [address] });
    } catch { /* factory not deployed on this chain, or call reverted */ }
    factoryCache.set(`precision:${addr}`, ok);
    return ok;
  }

  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === wethAddr.toLowerCase()) {
      let decoded;
      try { decoded = decodeEventLog({ abi: [ERC20_TRANSFER_EVENT], data: log.data, topics: log.topics }); } catch { continue; }
      if (decoded.args.from.toLowerCase() === zRouter.toLowerCase() && await isKnownPool(decoded.args.to)) {
        total += decoded.args.value;
      }
      continue;
    }
    if (await isPrecisionPool(log.address)) {
      let decoded;
      try { decoded = decodeEventLog({ abi: [PRECISION_SWAP_EVENT], data: log.data, topics: log.topics }); } catch { continue; }
      if (decoded.args.tokenIn === '0x0000000000000000000000000000000000000000') total += decoded.args.amountIn;
      continue;
    }
    if (log.address.toLowerCase() === V4_POOL_MANAGER[chainId]) {
      let decoded;
      try { decoded = decodeEventLog({ abi: [V4_SWAP_EVENT], data: log.data, topics: log.topics }); } catch { continue; }
      if (decoded.args.sender.toLowerCase() !== zRouter.toLowerCase()) continue;
      const paidIn = -decoded.args.amount0 === tx.value ? tx.value : -decoded.args.amount1 === tx.value ? tx.value : 0n;
      if (paidIn === 0n) continue;
      // V4 pools are permissionless — a matching NUMBER alone proves nothing: a farmer can initialize their
      // own junk/junk pool, swap an amount that happens to equal tx.value, and separately sweep the real ETH
      // straight back out untouched (a second zfi finding on this same check). Confirm real native ETH
      // actually reached PoolManager: it can only receive native ETH as call value on zRouter's own settle()
      // call, never for a token leg, so this must show an internal transfer of exactly that amount.
      //
      // Bounded the same way as the refund check, but failing the OPPOSITE direction: a lookup failure here
      // (unindexed, or Blockscout itself erroring — a zfi review finding: Robinhood's Blockscout served an
      // HTML page instead of JSON on one real request) retries the whole cycle while the candidate is fresh,
      // same as before. Past a 30-minute grace window from the candidate's own block, this leg is instead
      // treated as UNVERIFIED — contributes nothing, logged — rather than credited on a guess. The refund
      // check's fallback (no refund, credit gross) is safe because the swap itself is already confirmed real
      // by then; here the lookup failure means the swap was never confirmed real in the first place, so
      // "don't credit" is the only safe default once retrying stops being worth it.
      const apiBase = CFG.evmPoolExplorerApis[chainId];
      if (!apiBase) continue;
      try {
        const { sum: settled, indexed } = await internalEthTransferSum(apiBase, txHash, zRouter, V4_POOL_MANAGER[chainId]);
        if (!indexed) throw new Error(`internal-transactions not yet indexed for ${txHash}`);
        if (settled >= paidIn) total += paidIn;
      } catch (err) {
        if (Date.now() / 1000 - blockTime < 1800) throw err;
        log(`zRouter V4 settlement check still unresolved 30+ min after block time for ${txHash}, crediting nothing for that leg:`, err?.message || err);
      }
    }
  }
  return total;
}

// zRouter is deployed at the same address on all three of these chains (confirmed with zfi) — only the RPC
// and canonical WETH differ, so scanZRouterCycle below is called once per entry here.
//
// Only mainnet runs Signal 1 (the full-block-body scan for direct top-level value transfers). A real OOM
// incident traced to it: Robinhood Chain does ~10 blocks/sec, its cursor fell ~31,000 blocks behind, and
// fetching a full body per block for that backlog crashed the whole service in a loop. getLogs (Signal 2)
// costs the same regardless of chain throughput — only the match count matters, not the block span — so L2s
// run Signal-2-only: cheaper, and scales with whatever block time these chains turn out to have, at the cost
// of missing native-ETH-route swaps there (V4/zAMM/Lido — see scanZRouterCycle's own comment). Consistent
// with this program's existing "good enough proxy" stance elsewhere, and mainnet's own detection is unchanged.
const ZROUTER_CHAINS = [
  { chainId: 1, client: publicClient, wethAddr: WETH_ADDR, signal1: true },
  { chainId: 8453, client: clientForChain(8453, CFG.baseRpcUrl), wethAddr: CFG.baseWethAddr, signal1: false },
  { chainId: 4663, client: clientForChain(4663, CFG.robinhoodRpcUrl), wethAddr: CFG.robinhoodWethAddr, signal1: false },
];

// A fourth way to earn points: swapping ETH through zSwap/zRouter — treated as "ETH reaching zRouter" as a
// deliberate proxy for a swap, not an exhaustive decode of every route zRouter can take (z's call: AMM-style
// swaps only, order-board fills excluded, and this proxy is "good enough" rather than chasing every pool's
// own Swap event). Deliberately forward-only (no backfill) — the cursor starts at whatever block this
// service first sees live, not any deploy block. Runs once per chain zRouter is deployed on — mainnet, Base
// (8453), Robinhood (4663) — same zRouter address on each, `client`/`wethAddr` are the only things that vary.
//
// Two signals, merged and deduped by tx hash:
//   1. A top-level transaction sending value directly to zRouter — catches a DIRECT call on any route,
//      wrap-based or native-ETH (V4/zAMM/Lido/Curve), since this only looks at the top-level value, never
//      which pool type ends up trading it.
//   2. Canonical WETH's own `Deposit(dst, wad)` naming zRouter — catches a BATCHED wallet call (EIP-5792/
//      7702, where the top-level tx goes to the user's own account and the call into zRouter is internal)
//      on zRouter's WRAP-based routes specifically, since an event is part of the transaction's logs
//      regardless of call depth, unlike a plain value transfer.
// The one gap left standing: a BATCHED call on a NATIVE-ETH route (no WETH involved at all) is invisible to
// both — that needs transaction tracing or the destination pool's own Swap event, neither of which this
// attempts. `tx.from` is the real signer either way for an EOA or an EIP-7702-delegated EOA; a true
// ERC-4337 smart-account transaction submitted by a separate bundler would show the bundler instead.
//
// The TAC/Z-share boosts are only ever replayed against MAINNET transfers, so a Base/Robinhood block number
// has no meaning to boostFor() — there is no cross-chain block correspondence to use instead. For a non-
// mainnet chain this evaluates the boost as of the current confirmed MAINNET tip (already clamped to what
// both replays cover, so it can never throw) rather than the swap's own chain-local block: with a multi-hour
// trailing window, the skew between "at the swap" and "now" is immaterial.

// A few quick retries with backoff before giving up on a single Blockscout call — observed in production:
// its own gateway (524, a Cloudflare origin timeout) can time out transiently on the internal-transactions
// endpoint specifically, on an otherwise perfectly real, already-settled historical transaction. Without
// this, every caller's own 30-minute grace window burns on the FIRST attempt for an old backfill candidate
// (whose block time is already well past 30 minutes old), turning a one-off timeout into a guaranteed skip
// rather than the transient hiccup it actually was.
async function explorerGetWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await explorerGet(url);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

// Sums any internal ETH transfer from `from` to `to` within `txHash`, walking every page (Blockscout pages
// internal transactions at 50 — a busy multicall can exceed that). Also reports whether the result can be
// trusted at all: Blockscout answers an empty list both for "genuinely no internal transfers" and for "this
// tx isn't indexed yet", and its indexing can lag behind this scan's own confirmation window (a zfi review
// finding). Any zRouter call that actually moved value produces at least one internal transaction, so an
// empty list is never a confirmed zero — callers must treat `indexed: false` as "retry later, not now",
// never as zero. Trusting an unindexed empty list as zero would have reopened the refund-overcounting fix
// this same helper backs: an in-flight refund reading as "no refund" credits the unnetted gross value again.
async function fetchInternalTxs(apiBase, txHash) {
  const items = [];
  let params = '';
  for (let page = 0; page < 20; page++) {
    const data = await explorerGetWithRetry(`${apiBase}/transactions/${txHash}/internal-transactions${params}`);
    items.push(...(data.items || []));
    if (!data.next_page_params) break;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }
  return items;
}
async function internalEthTransferSum(apiBase, txHash, from, to) {
  const items = await fetchInternalTxs(apiBase, txHash);
  let sum = 0n;
  for (const item of items) {
    if (item.success === false) continue;
    const itemFrom = item.from && String(item.from.hash).toLowerCase();
    const itemTo = item.to && String(item.to.hash).toLowerCase();
    if (itemFrom === from.toLowerCase() && itemTo === to.toLowerCase()) sum += BigInt(item.value || 0);
  }
  return { sum, indexed: items.length > 0 };
}
// A contract that forwards its whole balance onward (rather than a computed exact amount) relies on the
// receiving side's own overpayment refund to make itself whole — that refund is a separate internal transfer
// in the opposite direction, in the same tx. Summing only the forward leg counts the gross amount sent, not
// the net amount actually kept; this nets both legs from one fetch so the two reads can't drift out of sync
// with each other the way two separate calls could under indexing lag.
async function internalEthTransferNet(apiBase, txHash, from, to) {
  const items = await fetchInternalTxs(apiBase, txHash);
  let net = 0n;
  for (const item of items) {
    if (item.success === false) continue;
    const itemFrom = item.from && String(item.from.hash).toLowerCase();
    const itemTo = item.to && String(item.to.hash).toLowerCase();
    if (itemFrom === from.toLowerCase() && itemTo === to.toLowerCase()) net += BigInt(item.value || 0);
    else if (itemFrom === to.toLowerCase() && itemTo === from.toLowerCase()) net -= BigInt(item.value || 0);
  }
  return { net, indexed: items.length > 0 };
}
// Throws rather than fails open on an unindexed or lookup-failed result: crediting the unnetted gross value
// is exactly the overcounting this exists to prevent, so an ambiguous read should retry next cycle, not
// silently trust the larger number.
async function zRouterRefundTo(txHash, sender) {
  const { sum, indexed } = await internalEthTransferSum(PP_BLOCKSCOUT_BASE, txHash, ADDR.zRouter, sender);
  if (!indexed) throw new Error(`internal-transactions not yet indexed for ${txHash}`);
  return sum;
}
// The getLogs span each L2's zRouter scan last managed, kept across cycles.
const ZROUTER_SPANS = new Map();
async function scanZRouterCycle(store, { chainId, client, wethAddr, signal1 = true }) {
  const cursorBlock = store.loadZrouterCursor(chainId);
  const latest = await client.getBlockNumber();
  let confirmedTip = latest - BigInt(CFG.pointsConfirmations);
  if (chainId === 1) confirmedTip = capToBoostCoverage(confirmedTip);
  // First-ever run: establish "now" as the starting line and stop — there is nothing before it to scan by
  // design (no backfill). Without this, a from = confirmedTip + 1 would keep being 1 block ahead of the
  // tip forever, since the cursor would never actually get saved to seed the next cycle.
  if (cursorBlock == null) {
    store.saveZrouterCursor(confirmedTip, chainId);
    return;
  }
  const from = cursorBlock + 1n;
  if (confirmedTip < from) return;
  // Cap how much of [from, confirmedTip] this single call processes. Signal 1's chunk is small: it fetches a
  // full block body per block, and a fast chain (or one recovering from a stall) can hand this an arbitrarily
  // large backlog otherwise (a real OOM incident — Robinhood Chain's ~10 blocks/sec). getLogs-only chains use
  // the same larger chunk as every other Blockscout-free scan in this file: a log-filtered query costs the
  // same regardless of how many blocks it spans, only how many matches it returns, so there's no equivalent
  // risk to cap tightly for. Either way, saving the cursor after each chunk means an interrupted catch-up
  // resumes from where it left off instead of restarting the backlog from scratch.
  const chunkSize = signal1 ? CFG.zrouterBlockScanChunk : Math.min(CFG.pointsScanChunk, ZROUTER_SPANS.get(chainId) ?? Infinity);
  const chunkTip = from + BigInt(chunkSize) - 1n;
  if (chunkTip < confirmedTip) confirmedTip = chunkTip;

  const blockCache = new Map();
  const getBlock = async (blockNumber) => {
    let block = blockCache.get(blockNumber);
    if (!block) {
      // includeTransactions: true — viem defaults to hash-only transactions, and Signal 1 below needs each
      // tx's own `to`/`value` to check without a second RPC round trip per transaction.
      block = await client.getBlock({ blockNumber, includeTransactions: true });
      blockCache.set(blockNumber, block);
    }
    return block;
  };

  // Signal 1: direct top-level calls. Block-by-block, not eth_getLogs — a plain ETH transfer emits no
  // event, so there is nothing to filter logs on for this signal. Skipped on chains where fetching a full
  // block body per block doesn't scale (see the chunk-size comment above) — Signal 2 alone still catches
  // every wrap-based swap there, just not the native-ETH-route ones this signal exists for.
  const byTxHash = new Map(); // tx hash -> { blockNumber, blockTime, amountWei, depositor }
  if (signal1) {
    for (let b = from; b <= confirmedTip; b++) {
      const block = await getBlock(b);
      for (const tx of block.transactions) {
        if (tx.to && tx.to.toLowerCase() === ADDR.zRouter.toLowerCase() && tx.value > 0n) {
          // The raw value only, un-netted — refund-netting happens later, and ONLY once a real swap is
          // confirmed (see the verification pass below). zRouter has a plain receive() fallback on every
          // chain, so a bare, no-calldata ETH transfer (anyone, ~21k gas, including by mistake) is a valid
          // Signal-1 candidate with zero internal transactions of any kind — genuinely, permanently, not due
          // to indexing lag. Netting a refund here unconditionally used to run the Blockscout lookup on that
          // candidate immediately, which reads as "not indexed" forever and would have halted this whole
          // chain's cursor on a single trivial, freely-repeatable transaction (a real zfi finding).
          byTxHash.set(tx.hash, {
            blockNumber: tx.blockNumber, blockTime: Number(block.timestamp),
            amountWei: tx.value, depositor: tx.from.toLowerCase(),
          });
        }
      }
    }
  }

  // Signal 2: WETH's own Deposit event, for batched wrap-based calls signal 1 can't see (its top-level
  // tx.value is 0 or unrelated — the value moved on an INNER call). `.set` here never overwrites an
  // already-found signal-1 entry for the same tx, so a direct wrap-based swap (caught by both signals)
  // keeps its signal-1 entry rather than being re-fetched.
  let logs;
  try {
    logs = await client.getLogs({
      address: wethAddr, event: WETH_DEPOSIT_EVENT, args: { dst: ADDR.zRouter }, fromBlock: from, toBlock: confirmedTip,
    });
  } catch (err) {
    // A node that caps a query's block span answers a wider one with a bare error: halve the span (to a floor) and retry next cycle.
    const wide = Number(confirmedTip - from + 1n), why = rpcRefusal(err);
    // Same reading as the EVM pool scan: only a span cap narrows the span; a throttle keeps it and waits out the cycle.
    if (signal1 || why === 'other') throw err;
    if (why === 'rate') { log(`zRouter getLogs on chain ${chainId} was rate limited at block ${from}; resuming next cycle`); return; }
    if (wide <= 50) throw err;
    ZROUTER_SPANS.set(chainId, Math.max(50, Math.floor(wide / 2)));
    log(`zRouter getLogs failed on chain ${chainId} over ${wide} blocks (${err?.shortMessage || err?.message || err}); trying ${ZROUTER_SPANS.get(chainId)} per call`);
    return;
  }
  for (const evt of logs) {
    if (byTxHash.has(evt.transactionHash)) continue;
    const block = await getBlock(evt.blockNumber);
    const tx = await client.getTransaction({ hash: evt.transactionHash });
    byTxHash.set(evt.transactionHash, {
      blockNumber: evt.blockNumber, blockTime: Number(block.timestamp),
      amountWei: evt.args.wad, depositor: tx.from.toLowerCase(),
    });
  }

  // Signal 3: the V4 PoolManager's own Swap event with sender == zRouter, for chains that skip Signal 1 —
  // native-ETH V4 swaps never touch WETH, so Signal 2 can't see them either, and zSwap's L2 pages route
  // meaningful native-ETH volume through exactly this path (a zfi review finding — it's not the small edge
  // case first assumed). getLogs on a single known address costs the same regardless of chain throughput, no
  // block bodies needed, so it doesn't reintroduce the OOM risk Signal 1 has on a fast L2. Mainnet skips this:
  // Signal 1 already finds these there, and adding it would just be a redundant second discovery of the same
  // candidate. Every candidate found here still goes through the same zRouterVerifiedSwapAmount check below —
  // no new security surface, it's discovery-only.
  if (!signal1 && V4_POOL_MANAGER[chainId]) {
    const v4Logs = await client.getLogs({
      address: V4_POOL_MANAGER[chainId], event: V4_SWAP_EVENT, args: { sender: ADDR.zRouter }, fromBlock: from, toBlock: confirmedTip,
    });
    for (const evt of v4Logs) {
      if (byTxHash.has(evt.transactionHash)) continue;
      const block = await getBlock(evt.blockNumber);
      const tx = await client.getTransaction({ hash: evt.transactionHash });
      if (tx.value <= 0n) continue; // a token/token V4 leg with zRouter as sender but no native ETH at all
      byTxHash.set(evt.transactionHash, {
        blockNumber: evt.blockNumber, blockTime: Number(block.timestamp),
        amountWei: tx.value, depositor: tx.from.toLowerCase(),
      });
    }
  }

  // Verify each candidate actually reached a real pool before trusting its raw amount — "ETH entered
  // zRouter" alone is not "ETH was swapped" (see zRouterVerifiedSwapAmount's own comment). A candidate with
  // no verified leg is dropped entirely rather than credited at the unverified figure. This RPC-only check
  // runs before any Blockscout lookup and for every candidate, not just ones that survive it: a bare ETH
  // transfer to zRouter (its plain receive() fallback, ~21k gas, anyone) verifies to 0 here and is dropped
  // immediately, never reaching the refund-netting below — that ordering is itself the fix for the finding
  // below, not just an optimization.
  const verifiedCandidates = [];
  for (const [txHash, candidate] of byTxHash.entries()) {
    const verified = await zRouterVerifiedSwapAmount(client, chainId, wethAddr, txHash, ADDR.zRouter, candidate.blockTime);
    if (verified <= 0n) continue;
    let amountWei = verified < candidate.amountWei ? verified : candidate.amountWei;
    // Net a swapV2/swapV3 refund only now that a real swap is confirmed — mainnet Signal 1 only, the one
    // signal that ever credits raw tx.value. Netting this unconditionally during discovery (this session's
    // own earlier attempt) ran the Blockscout lookup on EVERY candidate, including plain transfers that will
    // NEVER index any internal transaction — reading as "not indexed" forever and halting this chain's
    // cursor on one freely-repeatable, trivial transaction (a real zfi finding). A genuinely fresh, real
    // swap whose indexing hasn't caught up yet still retries the whole cycle (thrown, caught by main()'s
    // loop); past a 30-minute grace window from its own block, an unindexed result is instead treated as no
    // refund and logged, so a single permanently-stuck Blockscout entry can't block every candidate after it
    // forever either.
    if (chainId === 1 && signal1) {
      try {
        amountWei = candidate.amountWei - await zRouterRefundTo(txHash, candidate.depositor);
        if (amountWei < 0n) amountWei = 0n;
        if (amountWei > verified) amountWei = verified;
      } catch (err) {
        if (Date.now() / 1000 - candidate.blockTime < 1800) throw err;
        log(`zRouter refund check still unindexed 30+ min after block time for ${txHash}, crediting gross:`, err?.message || err);
      }
    }
    if (amountWei <= 0n) continue;
    verifiedCandidates.push([txHash, { ...candidate, amountWei }]);
  }
  const candidates = verifiedCandidates.sort((a, b) => (a[1].blockNumber < b[1].blockNumber ? -1 : a[1].blockNumber > b[1].blockNumber ? 1 : 0));

  // For an L2, resolve each candidate's own blockTime to a mainnet block via mainnetBlockAtOrBefore (cached
  // per distinct blockTime — several candidates can share one). Gated on the LATEST candidate's resolved
  // block first: since blockTime is non-decreasing across sorted candidates and the resolver is monotonic,
  // every earlier candidate resolves to an equal-or-earlier mainnet block, so if the latest one is already
  // within boost coverage, so is every other one — one cheap check covers the whole batch. If it is NOT yet
  // covered, bail without recording or advancing the cursor: retried next cycle once the boost replay (which
  // runs first in main()'s loop) has caught up far enough in real time.
  const evalBlockCache = new Map();
  let mainnetTip = null;
  async function boostEvalBlockFor(blockTime) {
    if (evalBlockCache.has(blockTime)) return evalBlockCache.get(blockTime);
    const b = await mainnetBlockAtOrBefore(blockTime, mainnetTip);
    evalBlockCache.set(blockTime, b);
    return b;
  }
  if (chainId !== 1 && candidates.length > 0) {
    mainnetTip = BigInt(await publicClient.getBlockNumber()) - BigInt(CFG.pointsConfirmations);
    const latestBlockTime = candidates[candidates.length - 1][1].blockTime;
    const gateBlock = await boostEvalBlockFor(latestBlockTime);
    if (capToBoostCoverage(gateBlock) < gateBlock) return;
  }

  let priorCount = store.countByActivity('zswapeth');
  for (const [txHash, { blockNumber, blockTime, amountWei, depositor }] of candidates) {
    const evalBlock = chainId === 1 ? blockNumber : await boostEvalBlockFor(blockTime);
    const tacB = tacMultiplier(depositor, evalBlock);
    const zShareB = zShareMultiplier(depositor, evalBlock);
    const wrote = store.recordDeposit({
      txHash, blockNumber: Number(blockNumber), blockTime,
      depositor, amountWei: amountWei.toString(), priorDepositCount: priorCount,
      points: pointsForZswapEth(amountWei, priorCount) * tacB * zShareB, activity: 'zswapeth', tacBoost: tacB, zShareBoost: zShareB,
      chainId,
    });
    if (wrote) priorCount += 1;
  }

  store.saveZrouterCursor(confirmedTip, chainId);
}

function pointsForEvmPoolDeposit(amountWei, priorCount) {
  return (Number(amountWei) / 1e18) * CFG.pointsBasePerEvmPoolEth * earlyAdopterBonus(priorCount);
}

// Public ETH deposited into the EVM pool, per chain (see lib/evm-pool-points.js for attribution). Boosts are
// judged at the deposit's own mainnet block, or for an L2 at the last mainnet block at or before its
// timestamp, the same rule scanZRouterCycle uses.
// The getLogs span each chain's scan last managed, kept across cycles (see scanEvmPoolChain).
const EVM_POOL_SPANS = new Map(), EVM_POOL_WINS = new Map();
function evmPoolCtx(store, evmState, { chainId, client }) {
  const evalCache = new Map();
  let mainnetTip = null;
  return {
    store, state: evmState, chainId, client, spans: EVM_POOL_SPANS, wins: EVM_POOL_WINS, pauseMs: chainId === 1 ? 0 : 250,
    apiBase: CFG.evmPoolExplorerApis[chainId],
    startBlock: CFG.evmPoolPointsStartBlocks[chainId],
    pool: CFG.evmPoolAddr, router: CFG.evmPoolRouterAddr, v1Pool: ADDR.pool, v1Router: ADDR.router,
    excluded: new Set(CFG.evmPoolPointsExclude),
    confirmations: CFG.pointsConfirmations, chunk: CFG.pointsScanChunk,
    maxChunks: CFG.evmPoolScanMaxChunks, resolvePerCycle: CFG.evmPoolResolvePerCycle,
    capTip: chainId === 1 ? capToBoostCoverage : null,
    explorerGet, pointsFor: pointsForEvmPoolDeposit, log,
    async evalBlock(chain, blockNumber, blockTime) {
      if (chain === 1) return BigInt(blockNumber);
      const t = Number(blockTime);
      if (!evalCache.has(t)) {
        if (mainnetTip == null) mainnetTip = BigInt(await publicClient.getBlockNumber()) - BigInt(CFG.pointsConfirmations);
        evalCache.set(t, await mainnetBlockAtOrBefore(t, mainnetTip));
      }
      return evalCache.get(t);
    },
    covered: (b) => capToBoostCoverage(b) >= b,
    multipliers: (address, b) => ({
      tacB: tacMultiplier(address, b), zShareB: zShareMultiplier(address, b),
      // The same Privacy Pools rule as a V1 wrap, judged at the deposit's mainnet block.
      ppB: store.hasEarlierPpWithdrawal(address, Number(b)) ? CFG.ppBoostMultiplier : 1,
    }),
  };
}

async function scanCycle(store) {
  const cursor = store.loadCursor() ?? {
    lastScannedBlock: BigInt(CFG.pointsStartBlock) - 1n,
    ethDepositCount: 0,
  };

  const latest = await publicClient.getBlockNumber();
  const confirmedTip = capToBoostCoverage(latest - BigInt(CFG.pointsConfirmations));
  if (confirmedTip <= cursor.lastScannedBlock) return;

  const chunk = BigInt(CFG.pointsScanChunk);
  const blockCache = new Map();
  const txCache = new Map();

  let from = cursor.lastScannedBlock + 1n;
  while (from <= confirmedTip) {
    const to = from + chunk - 1n > confirmedTip ? confirmedTip : from + chunk - 1n;

    const [logs, tipLogs, wrapBoxLogs] = await Promise.all([
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
      publicClient.getLogs({ address: CFG.evmPoolRouterAddr, event: WRAP_BOX_COMPLETED_EVENT, fromBlock: from, toBlock: to }),
    ]);
    const wrapBoxTxs = new Set(wrapBoxLogs.map((l) => l.transactionHash));
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
      // Value leaving the EVM pool (or a wrap box) into V1 is not new public ETH, and crediting it would let
      // the same ETH earn again on every V1 -> pool -> V1 round.
      if (isV1WrapViaEvmRouter(tx, evt.transactionHash, wrapBoxTxs, CFG.evmPoolRouterAddr)) continue;

      const priorDepositCount = cursor.ethDepositCount;
      const depositor = tx.from.toLowerCase();
      // Boosted only when the depositor itself has EVER been paid out by a Privacy Pools ETH withdrawal at
      // or before this wrap's own block — see scanPrivacyPoolCycle. This runs once per deposit, against the
      // local cache only, never a live RPC call.
      const ppBoosted = store.hasEarlierPpWithdrawal(depositor, Number(evt.blockNumber));
      let points = pointsForDeposit(evt.args.amount, priorDepositCount);
      if (ppBoosted) points *= CFG.ppBoostMultiplier;
      points *= CFG.tethWrapBoostMultiplier;
      const tacB = tacMultiplier(depositor, evt.blockNumber);
      const zShareB = zShareMultiplier(depositor, evt.blockNumber);
      points *= tacB * zShareB;
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
        tacBoost: tacB,
        zShareBoost: zShareB,
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

export function buildRewardTree(rewards) {
  return buildMerkleTree(rewards.map((r) => ({ address: r.address, cumulativeAmountWei: BigInt(r.cumulativeWei) })));
}

// When each Blockscout-paged scanner last completed a cycle, in epoch seconds taken from before the call began. Their
// cursors only name the newest log seen, not how far they have looked, so a success time stands in for coverage.
const scanOkAt = {};
let lastGateLogSec = 0;
let lastFundingAlertSec = 0;
const PAGED_SCANNERS = () => ['pp', 'ce', 'pm', ...(CFG.weinameEnabled ? ['weiname'] : [])];
async function ran(name, fn) {
  const startedAt = Math.floor(Date.now() / 1000);
  await fn();
  scanOkAt[name] = startedAt;
}
const PAGED_LAG_SECS = 300; // how far behind the chain a freshly read explorer page can be

// The earliest moment any scanner has read up to, or null when that cannot be known. Block-ranged scanners are
// read from their cursor block's own timestamp; a scanner that has not completed a cycle since start is unknown.
async function scannersCoveredThrough(store, evmState) {
  const blockTime = async (client, block) => Number((await client.getBlock({ blockNumber: block })).timestamp);
  const times = [];
  const wrap = store.loadCursor();
  if (wrap) times.push(await blockTime(publicClient, wrap.lastScannedBlock));
  for (const { chainId, client } of ZROUTER_CHAINS) {
    const z = store.loadZrouterCursor(chainId);
    if (z != null) times.push(await blockTime(client, z));
    const e = evmState.loadCursor(chainId);
    if (e != null) times.push(await blockTime(client, e));
  }
  for (const name of PAGED_SCANNERS()) {
    if (scanOkAt[name] == null) return null;
    times.push(scanOkAt[name] - PAGED_LAG_SECS);
  }
  return times.length ? Math.min(...times) : null;
}

// Whether the distributor holds enough TAC for the days still to publish (lib/points-funding.js), read at most once a
// minute. null when it is not configured or the chain cannot be read, so a failed read never looks like "funded".
let fundingCache = { at: 0, value: null };
async function readFunding(state, ledgerWei) {
  if (!ADDR.pointsDistributor || !CFG.pointsProgramStartSec) return null;
  if (Date.now() - fundingCache.at < 60_000) return fundingCache.value;
  let value = null;
  try {
    const [held, claimed] = await Promise.all([
      publicClient.readContract({ address: ADDR.tacToken, abi: ERC20_BALANCEOF_ABI, functionName: 'balanceOf', args: [ADDR.pointsDistributor] }),
      publicClient.readContract({ address: ADDR.pointsDistributor, abi: DISTRIBUTOR_ABI, functionName: 'totalClaimed' }),
    ]);
    const startDay = Math.floor(CFG.pointsProgramStartSec / 86400);
    const budgetFor = (day) => (day >= startDay && day < startDay + CFG.pointsProgramDays ? dayBudgetWei(day - startDay) : 0n);
    const s = fundingStatus({ heldWei: held, claimedWei: claimed, ledgerWei, budgetFor, nextDay: (state?.lastSettledDay ?? startDay - 1) + 1, graceSecs: CFG.pointsSettleGraceSecs });
    value = {
      distributor: ADDR.pointsDistributor, heldWei: String(held), claimedWei: String(claimed), fundedWei: String(s.fundedWei),
      ledgerWei: String(s.ledgerWei), headroomWei: String(s.headroomWei), shortfallWei: String(s.shortfallWei),
      daysCovered: s.daysCovered, topUpBeforeSec: s.topUpBeforeSec, verdict: fundingVerdict(s),
    };
  } catch (err) { log('funding read failed:', err?.message || err); }
  fundingCache = { at: Date.now(), value };
  return value;
}

// One reading of the ETH each pool holds per UTC day (lib/points-tvl.js), taken on the first cycle of the day and only
// within its first six hours, so a closed day compares readings from the same moment and a mid-day restart does not
// leave a part-day reading. A pool that cannot be read is retried next cycle; the first reading of a day is kept.
const poolTargets = () => [
  { chainId: 1, pool: 'v1', address: ADDR.pool, client: publicClient },
  ...ZROUTER_CHAINS.map(({ chainId, client }) => ({ chainId, pool: 'evm', address: CFG.evmPoolAddr, client })),
];
async function snapshotPools(store) {
  const nowSec = Math.floor(Date.now() / 1000);
  const day = Math.floor(nowSec / 86400);
  if (nowSec - day * 86400 > 6 * 3600) return;
  const have = new Set(store.poolSnapshots(day).filter((r) => r.day === day).map((r) => `${r.chainId}:${r.pool}`));
  for (const t of poolTargets()) {
    if (have.has(`${t.chainId}:${t.pool}`)) continue;
    try {
      const bal = await t.client.getBalance({ address: t.address });
      store.savePoolSnapshot({ day, chainId: t.chainId, pool: t.pool, ethWei: bal.toString(), takenAt: nowSec });
    } catch (err) { log(`pool snapshot failed (${t.pool} on chain ${t.chainId}):`, err?.message || err); }
  }
}

// Folds every UTC day-epoch through yesterday into the local reward ledger (always happens, independent of
// funding), then best-effort publishes a new cumulative root on-chain (only when POINTS_DISTRIBUTOR_ADDR +
// POINTS_ROOT_SETTER_KEY are set AND the distributor currently holds enough TAC to cover the new declared
// total). Deliberately decoupled: scoring stays accurate and current even on days the ops multisig hasn't yet
// topped up the distributor, and a funding shortfall just defers the on-chain publish to a later cycle rather
// than blocking or losing the day's computed entitlements.
export async function settleCycle(store, coverage = null) {
  if (!CFG.pointsProgramStartSec) return; // reward program not configured yet — informational points still work

  const startDay = Math.floor(CFG.pointsProgramStartSec / 86400);
  const lastProgramDay = startDay + CFG.pointsProgramDays - 1;
  const nowSec = Math.floor(Date.now() / 1000);

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

  // A day settles once and is never revisited, so hold it until it is over and every scanner has read past its end.
  // Coverage is only looked up when a day is otherwise ready, and an unreadable answer holds the day back.
  const gate = { nowSec, lastProgramDay, graceSecs: CFG.pointsSettleGraceSecs, maxWaitSecs: CFG.pointsSettleMaxWaitSecs };
  const byTime = gateThroughDay({ ...gate, coveredThroughSec: Infinity });
  let coveredThroughSec = Infinity;
  if (coverage && state.lastSettledDay < byTime) {
    try { coveredThroughSec = await coverage(); }
    catch (err) { coveredThroughSec = null; log('settle: scanner coverage unreadable, holding the day back:', err?.message || err); }
  }
  const settleThroughDay = gateThroughDay({ ...gate, coveredThroughSec });
  if (settleThroughDay < byTime && nowSec - lastGateLogSec > 600) {
    lastGateLogSec = nowSec;
    log(`settle: day ${state.lastSettledDay + 1} waits for the scanners (${coveredThroughSec == null ? 'coverage unknown' : `read through ${new Date(coveredThroughSec * 1000).toISOString()}`})`);
  }

  for (let d = state.lastSettledDay + 1; d <= settleThroughDay; d++) {
    const dayIndex = d - startDay;
    // A bond counts only if its escrow is still posted now that its day is over; an escrow that cannot be read leaves the day unsettled.
    if (CFG.pointsBondHoldFromDay && d >= CFG.pointsBondHoldFromDay) {
      const r = await decideBondHolds({ store, day: d, readEscrow: readEscrowOf, readLock: readLockState, failAfterSecs: CFG.pointsSettleMaxWaitSecs, log });
      if (r.checked) log(`settle: day ${d}: ${r.checked} bond(s) checked, ${r.released} not counted (taken back, or no cBTC minted against them)`);
    }
    // A bond still posted on a real lock earns for each further day; its credit is recorded before the day is read.
    if (CFG.pointsCbtcHoldRate > 0 && CFG.pointsCbtcHoldFromDay && d >= CFG.pointsCbtcHoldFromDay) {
      const r = await accrueBondHolds({ store, day: d, readEscrow: readEscrowOf, readLock: readBondLock, perWstEthDay: CFG.pointsCbtcHoldRate, failAfterSecs: CFG.pointsSettleMaxWaitSecs, log });
      if (r.credited) log(`settle: day ${d}: ${r.credited} bond(s) credited for staying posted`);
    }
    const rows = countedFor(store).rows(d);
    let deltas = null;
    if (rows.length) {
      const budget = dayBudgetWei(dayIndex);
      if (budget > 0n) {
        deltas = splitDayBudget(rows, budget, rateCapForDay(rateCapSchedule, d));
      }
    }
    // The day's rewards and the mark that it is settled go in together, so a crash cannot pay a day and leave it to be paid again.
    state.lastSettledDay = d;
    store.commitDay(deltas, state);
  }

  for (const adj of ledgerAdjustments) {
    if (store.applyAdjustment(adj)) log(`ledger adjustment ${adj.id}: credited ${formatTac(adj.wei)} TAC to ${adj.address}`);
  }

  // A day settled without a scanner that was behind is made whole once that scanner has read past it (lib/points-late-credit.js).
  const pendingLate = store.lateDays().some(({ day, n }) => day >= startDay && day <= state.lastSettledDay && Number(store.getMeta(`late-rows:${day}`)) !== Number(n));
  if (coverage && pendingLate) {
    let covered = null;
    try { covered = await coverage(); } catch (err) { log('late credit: scanner coverage unreadable, trying again next cycle:', err?.message || err); }
    creditLateDays({
      store, lastSettledDay: state.lastSettledDay, firstDay: startDay, coveredThroughSec: covered, log,
      rowsFor: (d, { onTime }) => countedFor(store, onTime).rows(d),
      budgetFor: (d) => dayBudgetWei(d - startDay),
      capFor: (d) => rateCapForDay(rateCapSchedule, d),
    });
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
    if (nowSec - lastFundingAlertSec <= 600) return;
    lastFundingAlertSec = nowSec;
    log(`ALERT: PointsDistributor needs ${formatTac(totalWei - funded)} more TAC funded before day ${settleThroughDay} settles on-chain (declared ${formatTac(totalWei)}, funded ${formatTac(funded)})`);
    return;
  }

  const call = { address: ADDR.pointsDistributor, abi: DISTRIBUTOR_ABI, functionName: 'updateRoot', args: [tree.root, totalWei] };

  // Same EIP-1559 sizing as header-relay's submitAdvance: base fee doubled plus a real tip, rather than
  // leaving the fee to the client's own default (which reserves several times what this actually costs).
  // Checked once up front against the wallet's own balance — a genuine shortfall should defer to next cycle
  // (matching the TAC-funding check above) rather than burn retries against a fee it can't cover either way.
  const [block0, tip0, ethBalance] = await Promise.all([
    publicClient.getBlock(),
    publicClient.estimateMaxPriorityFeePerGas().catch(() => ROOT_SETTER_MIN_TIP_WEI),
    publicClient.getBalance({ address: rootSetterWallet.account.address }),
  ]);
  const maxPriorityFeePerGas0 = tip0 > ROOT_SETTER_MIN_TIP_WEI ? tip0 : ROOT_SETTER_MIN_TIP_WEI;
  const gas = (await publicClient.estimateContractGas({ ...call, account: rootSetterWallet.account }) * 125n) / 100n;
  const need = gas * ((block0.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas0);
  if (need > ethBalance) {
    log(`ALERT: root-setter wallet ${rootSetterWallet.account.address} holds ${formatEther(ethBalance)} ETH; `
      + `today's updateRoot needs ~${formatEther(need)} ETH at today's gas — top it up`);
    return;
  }

  // Fees are refetched on every attempt, not just the upfront estimate above, so a retry after a stuck or
  // underpriced send bids at least the network's current rate instead of repeating the same rejected fee.
  const hash = await withNonceRetry('updateRoot', async () => {
    const [block, tip] = await Promise.all([publicClient.getBlock(), publicClient.estimateMaxPriorityFeePerGas().catch(() => ROOT_SETTER_MIN_TIP_WEI)]);
    const maxPriorityFeePerGas = tip > ROOT_SETTER_MIN_TIP_WEI ? tip : ROOT_SETTER_MIN_TIP_WEI;
    const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;
    return rootSetterWallet.writeContract({ ...call, gas, maxFeePerGas, maxPriorityFeePerGas });
  }, { log });

  // Bounded, not left to hang: settleCycle runs last in main()'s loop, so an unconfirmed wait here would
  // otherwise stall every scanner's next cycle behind it. A timeout isn't a failure — the send went through
  // fine — so it logs and returns rather than throwing; the root stays unpublished locally, and the next
  // cycle re-evaluates fees and either finds it confirmed or sends a proper replacement.
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: ROOT_SETTER_RECEIPT_TIMEOUT_MS }).catch((err) => {
    log(`updateRoot ${hash} not confirmed within ${ROOT_SETTER_RECEIPT_TIMEOUT_MS / 1000}s, will re-check next cycle:`, err?.message || err);
    return null;
  });
  if (!receipt) return;
  if (receipt.status !== 'success') {
    log(`updateRoot ${hash} reverted`);
    return;
  }

  store.savePublishedClaims(tree.claims);
  store.saveSettleState({ ...state, publishedRoot: tree.root, publishedTotalWei: tree.totalWei });
  log(`published points root ${tree.root} (${formatTac(totalWei)} TAC across ${tree.count} addresses), tx ${hash}`);
}

// The holding reward (lib/holding-service.js), built at start when HOLDING_ENABLED=1 and null otherwise, in which case its routes
// answer that it is off. Its verification key must match the pinned hash or the service does not start it.
let holding = null;
const HOLDING_CHAINS = {
  1: { deployBlock: 26069245, confirmations: 12, span: 2000, maxSpan: 2000 },
  8453: { deployBlock: 51864014, confirmations: 20, span: 500, maxSpan: 500 },
  4663: { deployBlock: 73991661, confirmations: 600, span: 20000, maxSpan: 400000 },
};
async function setupHolding(store) {
  if (!CFG.holdingEnabled) return null;
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const raw = readFileSync(CFG.holdingVkeyFile);
  const pin = CFG.holdingVkeySha256.toLowerCase().replace(/^0x/, '');
  if (!pin || createHash('sha256').update(raw).digest('hex') !== pin) throw new Error('HOLDING_VKEY_FILE does not match HOLDING_VKEY_SHA256');
  // A chain's reading client is the points service's own for it unless HOLDING_RPC_<chain> names another (a node that serves the
  // pool's whole history, for the first read).
  const clients = Object.fromEntries(ZROUTER_CHAINS.map(({ chainId, client }) => [chainId, CFG.holdingRpcUrls[chainId] ? holdingClient(CFG.holdingRpcUrls[chainId]) : client]));
  const h = createHolding({
    store, hash: await loadHash(), groth16: (await import('snarkjs')).groth16, log, clients,
    cfg: {
      enabled: true, rate: CFG.holdingRate, buckets: parseBuckets(CFG.holdingBucketsEth), pool: CFG.evmPoolAddr, vkey: JSON.parse(raw.toString('utf8')),
      chains: CFG.holdingChains.filter((id) => HOLDING_CHAINS[id] && clients[id]).map((chainId) => ({ chainId, ...HOLDING_CHAINS[chainId] })), budgetMs: 15000,
    },
  });
  log(`holding reward on: ${CFG.holdingChains.join(', ')}, ${CFG.holdingRate} points per ETH-day`);
  return h;
}
function startHttp(store, evmState) {
  const counted = countedFor(store);
  const history = dayHistory({
    dayRowsFor: (d) => counted.rows(d),
    budgetFor: (d) => dayBudgetWei(d - Math.floor(CFG.pointsProgramStartSec / 86400)),
    capFor: (d) => rateCapForDay(rateCapSchedule, d),
    ledgerFor: (a) => store.rewardFor(a),
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.statusCode = 204; res.end(); return;
    }
    try {
      if (url.pathname === '/holding') {
        res.end(JSON.stringify(holding ? holding.status() : { enabled: false }));
        return;
      }
      const nfPath = url.pathname.match(/^\/holding\/nullifiers\/(\d+)\/(\d+)$/);
      if (nfPath) {
        const r = holding ? holding.nullifiers(Number(nfPath[1]), Number(nfPath[2])) : { status: 404, body: { error: 'not enabled' } };
        res.statusCode = r.status; res.end(JSON.stringify(r.body));
        return;
      }
      if (url.pathname === '/holding/claim') {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST a claim' })); return; }
        if (!holding) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not enabled' })); return; }
        const r = await holding.claim(await readJson(req), { client: clientKey(req) });
        res.statusCode = r.status; res.end(JSON.stringify(r.body));
        return;
      }
      if (url.pathname === '/health') {
        const cursor = store.loadCursor();
        const ppCursor = store.loadPpCursor();
        const ceCursor = store.loadCeCursor();
        const pmCursor = store.loadPmCursor();
        const weinameCursor = store.loadWeinameCursor();
        // zRouter ETH-swap scan (see scanZRouterCycle), one cursor per chain — forward-only, null until each
        // chain's first cycle runs.
        const zrouterCursors = Object.fromEntries(ZROUTER_CHAINS.map(({ chainId }) => {
          const c = store.loadZrouterCursor(chainId);
          return [chainId, c != null ? c.toString() : null];
        }));
        const evmPoolCursors = Object.fromEntries(ZROUTER_CHAINS.map(({ chainId }) => {
          const c = evmState.loadCursor(chainId);
          return [chainId, { lastScannedBlock: c != null ? c.toString() : null, pendingBoxes: evmState.countPending(chainId) }];
        }));
        res.end(JSON.stringify({
          ok: true,
          lastScannedBlock: cursor ? cursor.lastScannedBlock.toString() : null,
          ethDepositCount: cursor ? cursor.ethDepositCount : 0,
          // Privacy Pools scan is a separate backfill (see scanPrivacyPoolCycle) — surfaced here so a stalled
          // or still-catching-up scan is visible without a dedicated endpoint.
          ppLastScannedBlock: ppCursor != null ? ppCursor.toString() : null,
          // CollateralEngine scan (cBTC escrow + cUSD mint activity — see scanCollateralEngineCycle).
          ceLastScannedBlock: ceCursor != null ? ceCursor.toString() : null,
          // PM prediction-market activity (see scanPmCycle).
          pmLastScannedBlock: pmCursor != null ? pmCursor.toString() : null,
          // .wei name registration activity (see scanWeinameCycle).
          weinameLastScannedBlock: weinameCursor != null ? weinameCursor.toString() : null,
          zrouterLastScannedBlock: zrouterCursors[1],
          zrouterLastScannedBlockByChain: zrouterCursors,
          evmPoolByChain: evmPoolCursors,
          // TAC transfer replay behind the holder boost; every other scan waits for it. null when the boost is off.
          tacBoostLastScannedBlock: tacBoost ? String(tacBoost.coveredThrough()) : null,
          // Same, for the Z-share holder boost.
          zShareBoostLastScannedBlock: zShareBoost ? String(zShareBoost.coveredThrough()) : null,
        }));
        return;
      }
      if (url.pathname === '/leaderboard') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        // ?day=today ranks the UTC day so far instead of the whole program, with the pot those points split, and the
        // program's own terms (lib/points-program.js) so a page shows them as the service holds them. It is an object
        // where the default is an array, so a service that predates it is told apart by its array.
        if (url.searchParams.get('day') === 'today') {
          if (!CFG.pointsProgramStartSec) { res.statusCode = 404; res.end(JSON.stringify({ error: 'no reward program' })); return; }
          const startDay = Math.floor(CFG.pointsProgramStartSec / 86400);
          const todayDay = Math.floor(Date.now() / 1000 / 86400);
          res.end(JSON.stringify({
            day: todayDay, programDay: todayDay - startDay + 1, programDays: CFG.pointsProgramDays,
            program: programTerms({ cfg: CFG, dayBudgetWei, rateCapSchedule, tiers: CFG.tacBoostTiers ? parseBoostTiers(CFG.tacBoostTiers) : [], weights: categoryWeights, engagement: engagementSchedule }),
            ...dayBoard(counted.rows(todayDay), { budgetWei: dayBudgetWei(todayDay - startDay), maxWeiPerPoint: rateCapForDay(rateCapSchedule, todayDay), limit }),
          }));
          return;
        }
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
          const dayRows = counted.rows(todayDay);
          const row = dayRows.find((r) => r.address.toLowerCase() === address.toLowerCase());
          // The running total as of THIS request, not a settled end-of-day figure — it moves as more
          // addresses deposit today, same as `row`'s own count does. The pot is the day's budget as it would split
          // right now, or less where the TAC-per-point ceiling binds, so a client's "share of today's pot" estimate
          // matches what settlement will pay.
          const { totalPoints, pot } = dayPot(dayRows, dayBudgetWei(todayDay - startDay), rateCapForDay(rateCapSchedule, todayDay));
          today = { points: row ? row.dayPoints : 0, totalPoints, dayBudgetWei: pot.toString(), factor: row?.factor ?? 1, rawPoints: row ? row.rawPoints : 0, kinds: row?.kinds ?? 0, activeDays: row?.activeDays ?? 0 };
        }
        res.end(JSON.stringify({ ...total, today, deposits }));
        return;
      }
      // What each UTC day of the program paid (or, for today, would pay so far) this address, from the same split
      // settlement uses, so a client can show points and TAC by day without the 100-activity limit /points has.
      const daysMatch = url.pathname.match(/^\/points\/(0x[0-9a-fA-F]{40})\/days$/);
      if (daysMatch) {
        if (!CFG.pointsProgramStartSec) { res.statusCode = 404; res.end(JSON.stringify({ error: 'no reward program' })); return; }
        const startDay = Math.floor(CFG.pointsProgramStartSec / 86400);
        const todayDay = Math.floor(Date.now() / 1000 / 86400);
        const lastSettledDay = store.loadSettleState()?.lastSettledDay ?? startDay - 1;
        res.end(JSON.stringify({
          address: daysMatch[1].toLowerCase(), startDay, programDays: CFG.pointsProgramDays, today: todayDay, lastSettledDay,
          ...history(daysMatch[1], { fromDay: startDay, throughDay: todayDay, lastSettledDay }),
        }));
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
          funding: await readFunding(state, BigInt(totalLedgerWei)),
          adjustments: store.listAdjustments().map((a) => ({ id: a.id, address: a.address, wei: a.wei, appliedAt: a.appliedAt })),
          rateCapSchedule: rateCapSchedule.map((e) => ({ fromDay: e.fromDay, maxWeiPerPoint: e.maxWeiPerPoint === null ? null : e.maxWeiPerPoint.toString() })),
          leaderboard,
        }));
        return;
      }
      if (url.pathname === '/tvl') {
        const todayDay = Math.floor(Date.now() / 1000 / 86400);
        const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 120);
        const from = todayDay - days;
        res.end(JSON.stringify({
          asOf: Math.floor(Date.now() / 1000),
          days: tvlSeries(store.poolSnapshots(from), store.poolDepositWeiByDay(from * 86400, (todayDay + 1) * 86400)),
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.statusCode = err?.status === 400 || err?.status === 413 ? err.status : 500;      // a request body that is too large or not JSON
      if (res.statusCode === 413) res.setHeader('Connection', 'close');
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });
  server.listen(CFG.pointsHttpPort, () => log(`http listening on :${CFG.pointsHttpPort}`));
}

async function main() {
  if (!CFG.pointsStartBlock) throw new Error('missing required env POINTS_START_BLOCK');
  const store = openStore(CFG.pointsDbPath, { excluded: CFG.evmPoolPointsExclude });
  if (CFG.tacBoostTiers) {
    if (!CFG.tacBoostStartBlock) throw new Error('TAC_BOOST_TIERS needs TAC_BOOST_START_BLOCK');
    tacBoost = openTacBoost(new Database(CFG.pointsDbPath), {
      tiers: parseBoostTiers(CFG.tacBoostTiers),
      windowBlocks: CFG.tacBoostWindowBlocks,
      startBlock: CFG.tacBoostStartBlock,
      fromBlock: CFG.tacTokenDeployBlock,
    });
  }
  if (CFG.zShareBoostTiers) {
    if (!CFG.zShareBoostStartBlock) throw new Error('ZSHARE_BOOST_TIERS needs ZSHARE_BOOST_START_BLOCK');
    zShareBoost = openTacBoost(new Database(CFG.pointsDbPath), {
      tiers: parseBoostTiers(CFG.zShareBoostTiers),
      windowBlocks: CFG.zShareBoostWindowBlocks,
      startBlock: CFG.zShareBoostStartBlock,
      fromBlock: CFG.zShareTokenDeployBlock,
      namespace: 'zshare',
    });
  }
  if (tacBoost || zShareBoost) {
    const confirmedTip = Number(await publicClient.getBlockNumber()) - CFG.pointsConfirmations;
    if (tacBoost) {
      try { await blockscoutBackfillBoost(tacBoost, ADDR.tacToken, confirmedTip); }
      catch (err) { log('TAC boost Blockscout backfill failed, falling back to the incremental scan:', err?.message || err); }
    }
    if (zShareBoost) {
      try { await blockscoutBackfillBoost(zShareBoost, ADDR.zShareToken, confirmedTip); }
      catch (err) { log('Z-share boost Blockscout backfill failed, falling back to the incremental scan:', err?.message || err); }
    }
  }
  const evmState = openEvmPoolPointsState(store.db);
  try { holding = await setupHolding(store); } catch (err) { log('holding reward not started:', err?.message || err); holding = null; }
  startHttp(store, evmState);

  for (;;) {
    // First, so every scan below can score up to the block each replay reached.
    if (tacBoost) {
      try {
        await scanTacTransfers(tacBoost, publicClient, { token: ADDR.tacToken, confirmations: CFG.pointsConfirmations, chunk: CFG.pointsScanChunk });
      } catch (err) {
        log('TAC transfer scan cycle failed:', err?.message || err);
      }
    }
    if (zShareBoost) {
      try {
        await scanTacTransfers(zShareBoost, publicClient, { token: ADDR.zShareToken, confirmations: CFG.pointsConfirmations, chunk: CFG.pointsScanChunk });
      } catch (err) {
        log('Z-share transfer scan cycle failed:', err?.message || err);
      }
    }
    // Runs before scanCycle so any Privacy Pools withdrawal that landed this cycle is already cached by the
    // time a same-cycle wrap is scored against it.
    try {
      await ran('pp', () => scanPrivacyPoolCycle(store));
    } catch (err) {
      log('privacy pool scan cycle failed:', err?.message || err);
    }
    try {
      await ran('ce', () => scanCollateralEngineCycle(store));
    } catch (err) {
      log('collateral engine scan cycle failed:', err?.message || err);
    }
    try {
      await ran('pm', () => scanPmCycle(store));
    } catch (err) {
      log('PM scan cycle failed:', err?.message || err);
    }
    if (CFG.weinameEnabled) {
      try {
        await ran('weiname', () => scanWeinameCycle(store));
      } catch (err) {
        log('weiname scan cycle failed:', err?.message || err);
      }
    }
    for (const chain of ZROUTER_CHAINS) {
      try {
        await scanZRouterCycle(store, chain);
      } catch (err) {
        log(`zRouter scan cycle failed (chain ${chain.chainId}):`, err?.message || err);
      }
    }
    for (const chain of ZROUTER_CHAINS) {
      const ctx = evmPoolCtx(store, evmState, chain);
      try {
        await scanEvmPoolChain(ctx);
      } catch (err) {
        log(`EVM pool scan cycle failed (chain ${chain.chainId}):`, err?.message || err);
      }
      try {
        await resolvePendingBoxes(ctx);
      } catch (err) {
        log(`EVM pool box resolution failed (chain ${chain.chainId}):`, err?.message || err);
      }
    }
    try {
      await scanCycle(store);
    } catch (err) {
      log('scan cycle failed:', err?.message || err);
    }
    try {
      await snapshotPools(store);
    } catch (err) {
      log('pool snapshot cycle failed:', err?.message || err);
    }
    try {
      await settleCycle(store, () => scannersCoveredThrough(store, evmState));
    } catch (err) {
      log('settle cycle failed:', err?.message || err);
    }
    if (holding) { try { await holding.cycle(); } catch (err) { log('holding cycle failed:', err?.message || err); } }
    await new Promise((r) => setTimeout(r, CFG.pointsPollSecs * 1000));
  }
}

main().catch((err) => {
  log('fatal:', err?.stack || err);
  process.exit(1);
});
