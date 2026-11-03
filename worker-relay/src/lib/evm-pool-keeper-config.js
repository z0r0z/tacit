// Env config for the EVM pool box keeper (src/evm-pool-keeper.js). Pure: takes an env object, returns a plain
// config, so tests build one without touching process.env.
//
// The keeper signs with EVM_POOL_KEEPER_PRIV and nothing else. It never reads the relay's keys: that EOA's
// nonce is shared by several services, and a second signer on it would race them.

import { getAddress, isAddress } from 'viem';
import { privateSettleUrl } from './private-settle-url.js';
import { RECEIVE_FEE_BPS } from '../../../dapp/evm-pool-gateway.js';
import { gatewayKeys } from '../../../dapp/sealed-request.js';
import { parseRateFeed } from './evm-pool-keeper-rates.js';

const ETH = '0x0000000000000000000000000000000000000000';
// The catch-up registry, the same address on every chain the pool is on: CreateX CREATE2 under a salt anyone may use
// (contracts/script/deploy-checkpoints.mjs), so the address is fixed by the registry's init code and any account may deploy it.
export const CHECKPOINTS = '0x00000000C3267616ED5E0DAA6F6490D109d6844D';
// The catch-up hub (TacitEvmPoolCheckpointsHub), which keeps points for every pool on a chain and reads the registry above through
// for the ETH pool: the same address on every chain (CreateX CREATE2 under an open salt, tools/checkpoint-hub-kit.mjs), so nothing
// but the hub's own code can ever be there, and a keeper may name it before it is deployed.
export const CHECKPOINT_HUB = '0x00000000C824B4F120C03f4Bdd4Bf4656232E835';
// The shared relay EOA. A keeper key that derives to it is refused outright.
export const RELAY_EOA = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7';
const BUILD = new URL('../../../dapp/circuits/evm-pool/build/', import.meta.url).pathname;

const str = (env, k, d = '') => (env[k] === undefined || env[k] === '' ? d : String(env[k]).trim());
const int = (env, k, d) => {
  const v = str(env, k);
  if (v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
  return n;
};
const big = (env, k, d) => {
  const v = str(env, k);
  if (v === '') return d;
  if (!/^\d+$/.test(v)) throw new Error(`${k} must be a non-negative integer`);
  return BigInt(v);
};
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
// The private route's gateway key as 64 hex characters, or '' for off. A key that is not one stops the keeper at start, without
// saying what it was.
const gatewayKeyOf = (v) => {
  if (!v) return '';
  try { gatewayKeys(v); } catch (e) { throw new Error(`EVM_POOL_KEEPER_GATEWAY_KEY: ${e.message}`); }
  return v.replace(/^0x/, '').toLowerCase();
};

// "token:amount,..." with token an address or "eth". Keys are lowercase addresses.
export function parseTokenMap(v, name) {
  const out = new Map();
  for (const pair of list(v || '')) {
    const [t, a] = pair.split(':').map((s) => s.trim());
    const token = t?.toLowerCase() === 'eth' ? ETH : t;
    if (!token || !isAddress(token) || !/^\d+$/.test(a || '')) throw new Error(`${name}: bad entry "${pair}"`);
    out.set(token.toLowerCase(), BigInt(a));
  }
  return out;
}

// Every app shows the receive address with this fee cap; a keeper that requires more would refuse them all.
export function checkReceiveFloor(minReceiveFeeBps) {
  if (minReceiveFeeBps > RECEIVE_FEE_BPS) {
    throw new Error(`EVM_POOL_KEEPER_MIN_RECEIVE_FEE_BPS=${minReceiveFeeBps} is above the canonical receive fee cap ${RECEIVE_FEE_BPS}; this keeper would refuse every app's receive address`);
  }
  return minReceiveFeeBps;
}

export function loadKeeperConfig(env = process.env) {
  const pool = str(env, 'EVM_POOL_ADDR');
  const router = str(env, 'EVM_POOL_ROUTER_ADDR');
  if (!pool || !router) return { enabled: false, reason: 'EVM_POOL_ADDR and EVM_POOL_ROUTER_ADDR are not both set' };
  if (!isAddress(pool) || !isAddress(router)) throw new Error('EVM_POOL_ADDR / EVM_POOL_ROUTER_ADDR must be addresses');

  const rpcUrl = str(env, 'EVM_POOL_RPC_URL', str(env, 'RPC_URL'));
  if (!rpcUrl) throw new Error('EVM_POOL_RPC_URL is not set');
  const chainId = str(env, 'EVM_POOL_CHAIN_ID') ? Number(str(env, 'EVM_POOL_CHAIN_ID')) : null;

  const minFees = parseTokenMap(str(env, 'EVM_POOL_KEEPER_MIN_FEES'), 'EVM_POOL_KEEPER_MIN_FEES');
  const rateFeed = parseRateFeed(str(env, 'EVM_POOL_KEEPER_RATE_FEED'));
  const rates = parseTokenMap(str(env, 'EVM_POOL_KEEPER_TOKEN_RATES'), 'EVM_POOL_KEEPER_TOKEN_RATES');
  rates.set(ETH, 10n ** 18n);

  const fastFlashbots = (raw) => { try { const u = new URL(raw); if (u.hostname === 'rpc.flashbots.net') u.pathname = '/fast'; return u.toString(); } catch { return raw; } };
  const sendDefault = chainId === 1 ? 'https://rpc.flashbots.net,https://rpc.mevblocker.io' : '';
  return {
    enabled: true,
    pool: getAddress(pool),
    router: getAddress(router),
    chainId,
    // A read node that does not answer in this long is left for the next (ms); the nodes are ranked by a ping every rpcRankSecs (0 = off).
    rpcTimeoutMs: int(env, 'EVM_POOL_RPC_TIMEOUT_MS', 6000),
    rpcRankSecs: int(env, 'EVM_POOL_RPC_RANK_SECS', 30),
    rpcUrls: [rpcUrl, ...list(str(env, 'EVM_POOL_RPC_URLS_FALLBACK'))].filter((u, i, a) => a.indexOf(u) === i),
    // Through the same normaliser the settle path uses: these carry a fee payable to whoever sends them,
    // so an endpoint in its searcher-visible mode invites a copy landed first for that fee.
    // Flashbots Protect in fast mode: shared with every builder (still hash-only to searchers), where its default shares
    // with too few to land a large transaction at a small tip within the 25 blocks it keeps one.
    sendRpcUrls: list(str(env, 'EVM_POOL_KEEPER_SEND_RPC_URLS', sendDefault)).map(privateSettleUrl).map(fastFlashbots),
    allowPublicSend: str(env, 'EVM_POOL_KEEPER_ALLOW_PUBLIC', '1') !== '0',
    dryRun: str(env, 'EVM_POOL_KEEPER_DRY_RUN', '0') === '1',

    dbPath: str(env, 'EVM_POOL_KEEPER_DB', '/var/lib/tacit-evm-pool-keeper/keeper.db'),
    port: int(env, 'PORT', 10000),

    startBlock: big(env, 'EVM_POOL_START_BLOCK', 0n),
    confirmations: big(env, 'EVM_POOL_CONFIRMATIONS', 12n),
    logChunk: big(env, 'EVM_POOL_LOG_CHUNK', 2000n),

    pollSecs: int(env, 'EVM_POOL_KEEPER_POLL_SECS', 15),
    // How often the stored history behind /events is brought up to date when no proof needs it.
    historySecs: int(env, 'EVM_POOL_KEEPER_HISTORY_SECS', 60),
    // Catch-up points (TacitEvmPoolCheckpoints): the keeper posts the tree's edge when the pool has grown by this many
    // leaves, or this long has passed, since the newest point; off with EVM_POOL_KEEPER_POINTS=0, or on a chain where the
    // registry has no code. A post is simulated first and costs gas only; one per count, the first to land.
    pointsAddress: (() => { const v = str(env, 'EVM_POOL_KEEPER_POINTS', CHECKPOINTS); return v === '0' || !isAddress(v) ? null : getAddress(v); })(),
    // A pool the registry is not for (a token pool, the TAC pools) posts its points to the hub instead, once the hub has code on its
    // chain; off with EVM_POOL_KEEPER_POINTS_HUB=0, and with EVM_POOL_KEEPER_POINTS=0, which stops every post.
    pointsHub: (() => { const v = str(env, 'EVM_POOL_KEEPER_POINTS_HUB', CHECKPOINT_HUB); return v === '0' || str(env, 'EVM_POOL_KEEPER_POINTS') === '0' || !isAddress(v) ? null : getAddress(v); })(),
    pointsEvery: int(env, 'EVM_POOL_KEEPER_POINTS_EVERY', 2000),
    pointsMaxAgeSecs: int(env, 'EVM_POOL_KEEPER_POINTS_MAX_AGE_SECS', 86400),
    pointsGas: big(env, 'EVM_POOL_KEEPER_POINTS_GAS', 2500000n),
    // The public facts /events?facts=1 serves are filled in by a loop of their own; 0 turns it off.
    facts: str(env, 'EVM_POOL_KEEPER_FACTS', '1') !== '0',
    factsConcurrency: int(env, 'EVM_POOL_KEEPER_FACTS_CONCURRENCY', 4),
    // The nodes the history facts are read from, tried one at a time for old logs (see makeKeeperChain); else the read nodes.
    factsRpcUrls: list(str(env, 'EVM_POOL_FACTS_RPC_URLS')),
    // The nodes the pool's and router's logs are read from (the leaf sync), when the read fallbacks include nodes that refuse log ranges
    // (a chain's only public alternatives often do); else the read nodes.
    logRpcUrls: list(str(env, 'EVM_POOL_LOG_RPC_URLS')),
    maxBackoffSecs: int(env, 'EVM_POOL_KEEPER_MAX_BACKOFF_SECS', 900),
    maxChecksPerTick: int(env, 'EVM_POOL_KEEPER_MAX_CHECKS_PER_TICK', 200),
    minFees,
    rates,
    // A token pool's price in ETH read from the chain (evm-pool-keeper-rates.js): how often, and how long the last one stands when a
    // read fails before fees in the token are refused.
    rateFeed,
    rateSecs: Math.max(10, int(env, 'EVM_POOL_KEEPER_RATE_SECS', 60)),
    rateMaxAgeSecs: int(env, 'EVM_POOL_KEEPER_RATE_MAX_AGE_SECS', 900),
    // TAC: the lowest price read over this long is the one fees are counted at
    rateWindowSecs: int(env, 'EVM_POOL_KEEPER_RATE_WINDOW_SECS', 600),
    marginBps: big(env, 'EVM_POOL_KEEPER_MARGIN_BPS', 2000n),
    depositGas: big(env, 'EVM_POOL_KEEPER_DEPOSIT_GAS', 500000n),
    wrapGas: big(env, 'EVM_POOL_KEEPER_WRAP_GAS', 300000n),
    sweepGas: big(env, 'EVM_POOL_KEEPER_SWEEP_GAS', 600000n),
    // A sweep's fee is capped at 25 bps of the box, so the smallest balance it pays for is 400 times its cost. To move smaller
    // deposits in, the keeper absorbs part of the cost itself: SWEEP_SUBSIDY_BPS of it (of 10,000), never more than
    // SWEEP_SUBSIDY_WEI per sweep (the bound when gas spikes), nor SWEEP_SUBSIDY_DAILY_WEI in a rolling day (0 = no daily bound; one budget
    // for all the pools a signer serves), and only while the signer holds SUBSIDY_RESERVE_WEI of ETH beyond what it spends (0 = no reserve).
    // The cost is priced as the fee is, in the token through its rate or oracle, so it follows gas and the price by itself.
    // RECEIVE_MIN_MULT floors the smallest balance at that many times the sweep's cost; MIN_RECEIVE (token:units) is an
    // absolute floor per token. A subsidised sweep is done only for a balance at or above the floor, so dust is never swept at a loss.
    sweepSubsidy: big(env, 'EVM_POOL_KEEPER_SWEEP_SUBSIDY_WEI', 0n),
    sweepSubsidyBps: int(env, 'EVM_POOL_KEEPER_SWEEP_SUBSIDY_BPS', 0),
    sweepSubsidyDaily: big(env, 'EVM_POOL_KEEPER_SWEEP_SUBSIDY_DAILY_WEI', 0n),
    subsidyReserve: big(env, 'EVM_POOL_KEEPER_SUBSIDY_RESERVE_WEI', 0n),
    receiveMinMult: int(env, 'EVM_POOL_KEEPER_RECEIVE_MIN_MULT', 0),
    minReceive: parseTokenMap(str(env, 'EVM_POOL_KEEPER_MIN_RECEIVE'), 'EVM_POOL_KEEPER_MIN_RECEIVE'),
    relayGas: big(env, 'EVM_POOL_KEEPER_RELAY_GAS', 450000n),
    // Receive boxes are watched indefinitely; this caps how many, and the smallest fee cap worth registering.
    maxReceive: int(env, 'EVM_POOL_KEEPER_MAX_RECEIVE', 100000),
    minReceiveFeeBps: checkReceiveFloor(int(env, 'EVM_POOL_KEEPER_MIN_RECEIVE_FEE_BPS', 1)),
    // An idle receive box is looked at least this often; re-posting it asks for a look now.
    receiveMaxBackoffSecs: int(env, 'EVM_POOL_KEEPER_RECEIVE_MAX_BACKOFF_SECS', 1800),
    // A box that holds funds but was skipped (its cost is not covered at today's gas) is looked at again at least this often: gas moves every block.
    receiveSkipMaxBackoffSecs: int(env, 'EVM_POOL_KEEPER_RECEIVE_SKIP_MAX_BACKOFF_SECS', 120),
    // A receive box registered in the last receiveFreshSecs is looked at again after receiveFastSecs, doubling, not after the poll interval.
    receiveFastSecs: int(env, 'EVM_POOL_KEEPER_RECEIVE_FAST_SECS', 3),
    receiveFreshSecs: int(env, 'EVM_POOL_KEEPER_RECEIVE_FRESH_SECS', 300),
    // A receive box is watched closely this long after its last registration or sweep (re-posting renews it), and
    // after that checked at least every receiveSlowSecs. At capacity, the oldest lapsed box that was never swept
    // makes room for a new one.
    receiveWatchSecs: int(env, 'EVM_POOL_KEEPER_RECEIVE_WATCH_SECS', 14 * 86400),
    receiveSlowSecs: int(env, 'EVM_POOL_KEEPER_RECEIVE_SLOW_SECS', 86400),
    maxReceiveChecksPerTick: int(env, 'EVM_POOL_KEEPER_MAX_RECEIVE_CHECKS_PER_TICK', 100),
    // Queued relaying (evm-pool-keeper-pipeline.js): relayed insertions follow the keeper's unmined ones. Off by
    // default where sends go to private endpoints, which drop a reverting transaction and would leave a nonce gap.
    pipeline: str(env, 'EVM_POOL_KEEPER_PIPELINE', list(str(env, 'EVM_POOL_KEEPER_SEND_RPC_URLS', sendDefault)).length ? '0' : '1') !== '0',
    pipelineDepth: int(env, 'EVM_POOL_KEEPER_PIPELINE_DEPTH', 24),
    // The least priority fee a send offers, in wei (a private builder on Ethereum skips a transaction tipping ~0).
    minPriorityFee: big(env, 'EVM_POOL_KEEPER_MIN_PRIORITY_FEE', chainId === 1 ? 50_000_000n : 0n),
    // Public relaying of users' own transactions (withdrawals and transfers) at /evm-pool/keeper/relay.
    relay: str(env, 'EVM_POOL_KEEPER_RELAY', '1') !== '0',
    gasCap: big(env, 'EVM_POOL_KEEPER_GAS_CAP', 1500000n),
    // A completion or sweep whose proof goes stale (the pool moved while it was made) is proved again this many times at once, then
    // looked at again after pollSecs, doubling each time up to STALE_MAX_BACKOFF_SECS: a pool in heavy use cannot keep the keeper proving.
    staleRetries: int(env, 'EVM_POOL_KEEPER_STALE_RETRIES', 1),
    staleMaxBackoffSecs: int(env, 'EVM_POOL_KEEPER_STALE_MAX_BACKOFF_SECS', 120),
    // How many worker threads a proof may start (snarkjs starts one per CPU it is told of, and a container is told of its host's).
    proverThreads: int(env, 'EVM_POOL_KEEPER_PROVER_THREADS', 2),
    // rapidsnark's `prover` binary: the proof comes from it (about 2.5 CPU-seconds, against snarkjs's 21), each one checked against the
    // verification key, and snarkjs makes any it does not give. Unset: snarkjs only. After BREAK_AFTER failures in a row it is not tried
    // for BREAK_SECS.
    nativeProver: str(env, 'EVM_POOL_KEEPER_NATIVE_PROVER'),
    nativeTimeoutMs: int(env, 'EVM_POOL_KEEPER_NATIVE_TIMEOUT_SECS', 60) * 1000,
    nativeBreakAfter: int(env, 'EVM_POOL_KEEPER_NATIVE_BREAK_AFTER', 3),
    nativeBreakSecs: int(env, 'EVM_POOL_KEEPER_NATIVE_BREAK_SECS', 600),
    // One proof of a made-up completion when the binary starts, timed in the log (0 = none).
    nativeSelfTest: str(env, 'EVM_POOL_KEEPER_NATIVE_SELFTEST', '1') !== '0',
    // A submission endpoint that does not answer in this long (ms) is given up on (one retry after a network error); the private ones are
    // sent to at once, so a hung one does not hold a relay up.
    sendTimeoutMs: int(env, 'EVM_POOL_KEEPER_SEND_TIMEOUT_MS', 8000),
    // The proofs of every pool share one queue; a pool with a priority of 1 goes ahead of the others by a minute of their waiting.
    proofPriority: int(env, 'EVM_POOL_KEEPER_PROOF_PRIORITY', 0),
    // How long a /quote answer is shared by everyone who asks (ms).
    quoteCacheMs: int(env, 'EVM_POOL_KEEPER_QUOTE_CACHE_MS', 4000),
    quoteStaleMs: int(env, 'EVM_POOL_KEEPER_QUOTE_STALE_MS', 15_000),
    maxAttempts: int(env, 'EVM_POOL_KEEPER_MAX_ATTEMPTS', 5),
    receiptWaitSecs: int(env, 'EVM_POOL_KEEPER_RECEIPT_WAIT_SECS', 180),
    // reclaim: after a box's deadline the keeper sends what the box still holds back to its refund address: the whole of a box it never completed, and what a completed
    // one holds above its amount (what a swap that paid it paid over). The second is looked for at most every sweepSurplusSecs, sweepSurplusBatch boxes at a time.
    reclaim: str(env, 'EVM_POOL_KEEPER_RECLAIM', '0') === '1',
    sweepSurplusSecs: int(env, 'EVM_POOL_KEEPER_SURPLUS_SECS', 600),
    sweepSurplusBatch: int(env, 'EVM_POOL_KEEPER_SURPLUS_BATCH', 10),
    expireGraceSecs: int(env, 'EVM_POOL_KEEPER_EXPIRE_GRACE_SECS', 86400),

    maxBody: int(env, 'EVM_POOL_KEEPER_MAX_BODY', 16384),
    maxMemoBytes: int(env, 'EVM_POOL_KEEPER_MAX_MEMO_BYTES', 1024),
    maxPending: int(env, 'EVM_POOL_KEEPER_MAX_PENDING', 5000),
    minDeadlineSecs: int(env, 'EVM_POOL_KEEPER_MIN_DEADLINE_SECS', 600),
    // a call that is sent for a wallet must outlast the send, the block and the router's own run: one a few seconds from its deadline reverts at the keeper's cost
    minCallDeadlineSecs: int(env, 'EVM_POOL_KEEPER_MIN_CALL_DEADLINE_SECS', 120),
    maxDeadlineSecs: int(env, 'EVM_POOL_KEEPER_MAX_DEADLINE_SECS', 30 * 86400),
    ratePerMin: int(env, 'EVM_POOL_KEEPER_RATE_PER_MIN', 20),
    // The private route (docs/EVM-POOL.md): a gateway key turns on POST /sealed. The addresses listed as forwarders carry many callers
    // and may send ten times the rate.
    gatewayKey: gatewayKeyOf(str(env, 'EVM_POOL_KEEPER_GATEWAY_KEY')),
    forwarders: list(str(env, 'EVM_POOL_KEEPER_FORWARDERS')),

    wasm: str(env, 'EVM_POOL_WASM', BUILD + 'transact_js/transact.wasm'),
    zkey: str(env, 'EVM_POOL_ZKEY', BUILD + 'transact_dev_final.zkey'),
    vk: str(env, 'EVM_POOL_VK', BUILD + 'transact_dev_vk.json'),
    vkHash: str(env, 'EVM_POOL_VK_HASH'),
    // Set with https URLs for wasm / zkey (the finalized ceremony artifacts); cached under artifactDir.
    wasmSha256: str(env, 'EVM_POOL_WASM_SHA256'),
    zkeySha256: str(env, 'EVM_POOL_ZKEY_SHA256'),
    artifactDir: str(env, 'EVM_POOL_ARTIFACT_DIR', '/var/lib/tacit-evm-pool-keeper/artifacts'),
    singleThread: str(env, 'EVM_POOL_KEEPER_SINGLE_THREAD', '0') === '1',

    keeperKey: str(env, 'EVM_POOL_KEEPER_PRIV'),
    // Public addresses only: the keeper key must not be one of these.
    forbiddenSigners: [RELAY_EOA, str(env, 'SETTLE_ADDRESS')].filter((a) => isAddress(a)).map((a) => a.toLowerCase()),
  };
}

export function checkKeeperSigner(cfg, address) {
  if (cfg.forbiddenSigners.includes(address.toLowerCase())) {
    throw new Error(`EVM_POOL_KEEPER_PRIV derives to ${address}, a shared relay signer; give the keeper its own key`);
  }
}

export { ETH };
