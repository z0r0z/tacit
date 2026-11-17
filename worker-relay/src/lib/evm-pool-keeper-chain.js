// Chain I/O for the EVM pool keeper, behind the small interface the loop, intake and relay use (tests mock it).

import { createPublicClient, createWalletClient, defineChain, fallback, getAddress, http, parseAbi } from 'viem';
import { withNonceRetry } from './nonce-retry.js';
import { safeErr } from './safe-err.js';
import { ETH } from './evm-pool-keeper-config.js';

const DEPOSIT_INTENT = {
  name: 'intent', type: 'tuple', components: [
    { name: 'amount', type: 'uint256' }, { name: 'outLeaf0', type: 'uint256' }, { name: 'outLeaf1', type: 'uint256' },
    { name: 'memo0Hash', type: 'bytes32' }, { name: 'memo1Hash', type: 'bytes32' }, { name: 'refund', type: 'address' },
    { name: 'deadline', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
  ],
};
const WRAP_INTENT = {
  name: 'intent', type: 'tuple', components: [
    { name: 'assetId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'tip', type: 'uint256' }, { name: 'tipTo', type: 'address' },
    { name: 'commit', type: 'bytes32' }, { name: 'refund', type: 'address' }, { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const TX = {
  name: 't', type: 'tuple', components: [
    { name: 'pA', type: 'uint256[2]' }, { name: 'pB', type: 'uint256[2][2]' }, { name: 'pC', type: 'uint256[2]' },
    { name: 'publicInputs', type: 'uint256[11]' }, { name: 'recipient', type: 'address' }, { name: 'extAmount', type: 'int256' },
    { name: 'relayer', type: 'address' }, { name: 'fee', type: 'uint256' }, { name: 'memo0', type: 'bytes' }, { name: 'memo1', type: 'bytes' },
  ],
};
const CALL_INTENT = {
  name: 'intent', type: 'tuple', components: [
    {
      name: 'calls', type: 'tuple[]', components: [
        { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' }, { name: 'push', type: 'bool' }, { name: 'data', type: 'bytes' },
      ],
    },
    { name: 'outTokens', type: 'address[]' }, { name: 'minOuts', type: 'uint256[]' }, { name: 'to', type: 'address' },
    { name: 'refund', type: 'address' }, { name: 'deadline', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
  ],
};
const fn = (name, inputs, outputs = [], stateMutability = 'nonpayable') => ({ type: 'function', name, stateMutability, inputs, outputs });
const ERRORS = [
  // router
  'BadTarget', 'BadIntent', 'BadPermit2', 'AmountTooLarge', 'ShortSwapOutput', 'ZRouterCallFailed', 'NotExpired', 'NothingToReclaim',
  'Expired', 'EscrowEmpty', 'ShortOutput',
  // pool
  'ZeroAddress', 'NotAContract', 'WrongAsset', 'StaleRoot', 'UnknownMembershipRoot', 'WrongInsertionIndex', 'PoolFull',
  'AlreadyNullified', 'BadProof', 'ValueOutOfRange', 'EthValueMismatch', 'EthNotAccepted', 'FeeOnTransferAsset',
  // box and token transfers
  'NotRouter', 'TransferFailed', 'TransferFromFailed', 'ETHTransferFailed', 'ApproveFailed', 'Reentrancy',
].map((name) => ({ type: 'error', name, inputs: [] }));

export const ROUTER_ABI = [
  fn('POOL', [], [{ type: 'address' }], 'view'),
  fn('ASSET', [], [{ type: 'address' }], 'view'),
  fn('V1', [], [{ type: 'address' }], 'view'),
  fn('depositBoxOf', [DEPOSIT_INTENT], [{ type: 'address' }], 'view'),
  fn('wrapBoxOf', [WRAP_INTENT], [{ type: 'address' }], 'view'),
  fn('completeDeposit', [DEPOSIT_INTENT, TX]),
  fn('completeWrap', [WRAP_INTENT]),
  fn('reclaimDeposit', [DEPOSIT_INTENT, { type: 'address' }]),
  fn('reclaimWrap', [WRAP_INTENT, { type: 'address' }]),
  fn('receiveBoxOf', [{ type: 'uint256' }, { type: 'uint16' }], [{ type: 'address' }], 'view'),
  fn('receiveCount', [{ type: 'address' }], [{ type: 'uint256' }], 'view'),
  fn('sweepReceive', [{ type: 'uint256' }, { type: 'uint16' }, TX]),
  fn('withdrawToV1', [TX, WRAP_INTENT]),
  fn('callEscrowOf', [CALL_INTENT], [{ type: 'address' }], 'view'),
  fn('withdrawAndCall', [TX, CALL_INTENT]),
  fn('executeCall', [CALL_INTENT]),
  fn('refundCall', [CALL_INTENT, { type: 'address' }]),
  ...ERRORS,
];
const RECEIVED_EVENT = parseAbi(['event Received(address indexed box, uint256 indexed n, uint256 index, uint256 value, uint256 rho, uint256 fee)'])[0];
// The catch-up registry: the tree's edge at a count, kept only if the pool held its root (TacitEvmPoolCheckpoints).
const CHECKPOINTS_ABI = parseAbi([
  'function POOL() view returns (address)',
  'function latest() view returns (uint256)',
  'function pointAt(uint256 size) view returns (uint256 blockNumber, uint256 prev, bytes32[32] filled)',
  'function postedAt(uint256 size) view returns (uint256)',
  'function post(uint256 size, uint256 blockNumber, bytes32[32] filled)',
]);
// The catch-up hub: the same points for any pool, named first (TacitEvmPoolCheckpointsHub); its errors, so a refused post says why.
export const HUB_ABI = parseAbi([
  'function latest(address pool) view returns (uint256)',
  'function postedAt(address pool, uint256 size) view returns (uint256)',
  'function post(address pool, uint256 size, uint256 blockNumber, bytes32[32] filled)',
  'error NotEven()', 'error BadBlock()', 'error Known()', 'error NotHeld()',
]);
const POOL_ABI = [
  fn('transact', [
    { type: 'uint256[2]' }, { type: 'uint256[2][2]' }, { type: 'uint256[2]' }, { type: 'uint256[11]' }, { type: 'address' },
    { type: 'int256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes' },
  ], [], 'payable'),
  ...ERRORS,
  fn('root', [], [{ type: 'bytes32' }], 'view'),
  fn('nextIndex', [], [{ type: 'uint256' }], 'view'),
  fn('everKnownRoot', [{ type: 'bytes32' }], [{ type: 'bool' }], 'view'),
  fn('isSpent', [{ type: 'bytes32[]' }], [{ type: 'bool[]' }], 'view'),
  ...parseAbi(['event Transact(bytes32 indexed nf0, bytes32 indexed nf1, bytes32 outLeaf0, bytes32 outLeaf1, uint256 firstIndex, bytes32 newRoot, address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1)']),
];
const V1_ABI = parseAbi(['function assets(bytes32) view returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals)']);
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

const KNOWN = new Set(ERRORS.map((e) => e.name));
// The custom error a failed call reverted with, or null.
export function revertName(e) {
  const r = e?.walk?.((x) => x?.name === 'ContractFunctionRevertedError');
  if (r?.data?.errorName) return r.data.errorName;
  const m = String(e?.shortMessage || e?.message || '').match(/\b([A-Z][A-Za-z]+)\(\)/g) || [];
  for (const s of m) { const n = s.slice(0, -2); if (KNOWN.has(n)) return n; }
  return null;
}

// What a send of `gas` can offer per gas when the keeper must front it: a node refuses a transaction whose
// gas × maxFeePerGas is more than the account holds, and the fee only comes back once it runs. The headroom (twice
// the base fee, surviving several blocks of rises) comes down to what the balance affords, never below what this
// block needs, so a thinly funded keeper keeps sending while the base fee holds; below that it cannot send at all.
// → { ok, maxFeePerGas, maxPriorityFeePerGas, balance, need (at this block), headroom (full headroom affordable) }
export function frontFees({ base, prio, balance, gas }) {
  const full = base * 2n + prio, floor = base + prio, g = BigInt(gas || 0);
  const afford = g > 0n ? balance / g : full;
  const maxFeePerGas = afford < full ? afford : full;
  return { ok: afford >= floor, maxFeePerGas, maxPriorityFeePerGas: prio, balance, need: g * floor, headroom: afford >= full };
}

// One queue and one nonce count per signer on a chain, shared by every keeper in the process that signs with it (several pools on one
// chain may share a key): their sends go one at a time, so two pools never pick the same nonce.
const SIGNERS = new Map();
const signerOf = (chainId, address) => {
  const k = `${chainId}:${address.toLowerCase()}`;
  if (!SIGNERS.has(k)) SIGNERS.set(k, { sending: Promise.resolve(), sentNonce: -1, sentAt: 0, users: 0 });
  const s = SIGNERS.get(k);
  s.users++;
  return s;
};

// A read client over a list of nodes, shared by every keeper that reads the same list (seven Ethereum keepers ask the same nodes, and each
// ranking them would ping them seven times). viem waits 10 s for a node that does not answer and goes round all of them up to four
// times, so one hung node stalled a call for 10 s and a dead list for minutes: here a node that does not answer in `ms` is left for the
// next, the round is repeated once, and the nodes are ranked by how fast and how steadily they answer (a ping each `rankSecs`), so a
// slow or failing one is no longer tried first (pinged with eth_blockNumber: viem's own ping, net_listening, is not on every node,
// and a node that lacked it would rank as failing). One node: asked, and once more.
const READERS = new Map();
export function readerFor(urls, { ms = 6000, rankSecs = 30 } = {}) {
  const key = `${urls.join('|')}|${ms}|${rankSecs}`;
  if (!READERS.has(key)) {
    const node = (u) => http(u, { timeout: ms, retryCount: 0 });
    const transport = urls.length > 1
      ? fallback(urls.map(node), { retryCount: 1, ...(rankSecs > 0 ? { rank: { interval: rankSecs * 1000, sampleCount: 4, timeout: Math.min(ms, 2500), ping: ({ transport }) => transport.request({ method: 'eth_blockNumber' }) } } : {}) })
      : http(urls[0], { timeout: ms, retryCount: 1 });
    READERS.set(key, createPublicClient({ transport }));
  }
  return READERS.get(key);
}

export async function makeKeeperChain({ cfg, account, log = () => {} }) {
  const rpc = { ms: cfg.rpcTimeoutMs ?? 6000, rankSecs: cfg.rpcRankSecs ?? 0 };
  const pub = readerFor(cfg.rpcUrls, rpc);
  // History facts (a transaction's sender and target, a block's time, an old range of logs) are read from their own list of
  // nodes (EVM_POOL_FACTS_RPC_URLS, else the read nodes), so a backfill does not crowd the node that relays and proofs read.
  // A node that keeps only recent history answers an old range with nothing, not an error, and a fallback stops at that
  // answer, so a range of logs is asked of each node in turn until one returns every event the store holds for it.
  const factsUrls = cfg.factsRpcUrls?.length ? cfg.factsRpcUrls : cfg.rpcUrls;
  const factsPub = readerFor(factsUrls, rpc);
  const factsEach = factsUrls.map((u) => readerFor([u], rpc));
  const logUrls = cfg.logRpcUrls?.length ? cfg.logRpcUrls : null;
  const logPub = logUrls ? readerFor(logUrls, rpc) : pub;
  const chainId = await pub.getChainId();
  if (cfg.chainId && chainId !== cfg.chainId) throw new Error(`RPC is on chain ${chainId}, EVM_POOL_CHAIN_ID is ${cfg.chainId}`);
  const viemChain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrls[0]] } } });
  const read = (address, abi, functionName, args = [], blockNumber) => pub.readContract({ address, abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });

  const [pool, asset, v1] = await Promise.all(['POOL', 'ASSET', 'V1'].map((f) => read(cfg.router, ROUTER_ABI, f)));
  if (getAddress(pool) !== cfg.pool) throw new Error(`router ${cfg.router} serves pool ${pool}, not EVM_POOL_ADDR ${cfg.pool}`);

  // The public pass tries the read nodes in turn and stops at the first that takes the transaction: a node that is rate-limiting
  // or down must not fail a relay while another would have taken it.
  const privateUrls = cfg.sendRpcUrls, publicUrls = cfg.allowPublicSend || !privateUrls.length ? cfg.rpcUrls : [];
  // `functionName` on the router, or `pool.transact` (a relayed user transaction) on the pool.
  const target = (functionName) => (functionName === 'pool.transact'
    ? { address: cfg.pool, abi: POOL_ABI, functionName: 'transact' }
    : functionName === 'checkpoints.post'
      ? { address: cfg.pointsAddress, abi: CHECKPOINTS_ABI, functionName: 'post' }
      : functionName === 'hub.post'
        ? { address: cfg.pointsHub, abi: HUB_ABI, functionName: 'post' }
        : { address: cfg.router, abi: ROUTER_ABI, functionName });
  // One signer, one nonce: the loop and relay requests (and any other pool's keeper on this chain with the same key) send through this
  // queue one at a time.
  const signer = signerOf(chainId, account.address);
  const serial = (f) => { const run = signer.sending.then(f, f); signer.sending = run.catch(() => {}); return run; };
  // The next nonce: the chain's pending count; with the queue on (public mempool only), or a key several pools' keepers share, past
  // what this signer last sent while the RPC has not seen it yet. A private endpoint can drop a transaction without using its nonce,
  // so a keeper with a key of its own behind one trusts only the chain's count; a shared key cannot (a private send stays unseen by
  // the read node until it is mined, and the next pool's send would take the same nonce), so it counts on, and a send never seen
  // within a minute is forgotten, as with the queue.
  const nextNonce = async () => {
    const pending = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    if ((!cfg.pipeline && signer.users < 2) || (pending <= signer.sentNonce && Date.now() - signer.sentAt > 60_000)) return pending;
    return Math.max(pending, signer.sentNonce + 1);
  };
  // Fees that survive several blocks of base-fee rises, with at least the configured tip (a private builder skips a
  // transaction that pays it nothing), within what the keeper can front for `gas` (see frontFees).
  const prices = async () => {
    const [block, tip, balance] = await Promise.all([pub.getBlock(), pub.estimateMaxPriorityFeePerGas().catch(() => 0n), pub.getBalance({ address: account.address })]);
    return { base: block.baseFeePerGas ?? 0n, prio: tip > cfg.minPriorityFee ? tip : cfg.minPriorityFee, balance };
  };
  const fees = async (gas) => {
    const f = frontFees({ ...(await prices()), gas });
    if (!f.ok) throw Object.assign(new Error(`keeper ${account.address} holds ${f.balance} wei, under the ${f.need} wei a ${gas}-gas send needs at the current base fee`), { shortOfGas: true });
    return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  };
  // One signed call to a list of endpoints: `nonce` and `fee` are part of the call, so the same call signs to the same hash each time it
  // is made. `fail(e)` hears each endpoint's error. → the hash, or null when no endpoint took it; a revert is thrown.
  const sendMs = cfg.sendTimeoutMs ?? 8000;
  const via = async ({ functionName, args, gas, nonce, fee }, urls, firstWins, fail) => {
    const send1 = (url) => createWalletClient({ account, chain: viemChain, transport: http(url, { timeout: sendMs, retryCount: 1 }) })
      .writeContract({ ...target(functionName), args, gas, nonce, ...fee });
    if (firstWins) {
      // the public nodes, one after another: the first that takes it
      let hash = null;
      for (const url of urls) {
        try { hash = (await send1(url)) || hash; if (hash) break; }
        catch (e) { fail(e); log(`  submit via ${new URL(url).host} failed: ${safeErr(e)}`); if (revertName(e)) throw e; }
      }
      return hash;
    }
    // The private endpoints, all at once. The hash is the same at each, so whichever takes it first is the answer and the others go on
    // in the background: one that hangs no longer holds the relay up for the sum of the timeouts, one that refuses does not stop the
    // others, and a revert fails the send only when no endpoint took it.
    return new Promise((resolve, reject) => {
      let left = urls.length, done = false, reverted = null;
      for (const url of urls) {
        send1(url).then(
          (h) => { if (h && !done) { done = true; resolve(h); } },
          (e) => { fail(e); log(`  submit via ${new URL(url).host} failed: ${safeErr(e)}`); if (revertName(e) && !reverted) reverted = e; },
        ).finally(() => { if (--left === 0 && !done) { done = true; if (reverted) reject(reverted); else resolve(null); } });
      }
    });
  };
  async function receiptOf(hash) {
    try { return await pub.getTransactionReceipt({ hash }); }
    catch (e) { if (/could not be found|not found/i.test(String(e?.shortMessage || e?.message))) return null; throw e; }
  }
  // A private endpoint can take a transaction and never mine it (the builder drops it, or holds it past its window), and then the
  // transaction is nowhere the read nodes can see it. Each send is kept as it was signed (the last few), and one with no receipt after
  // `resendSecs` is sent again unchanged (same nonce and fees: the same hash, never a second transaction), to every private endpoint and,
  // when public sends are allowed, to the read nodes too, up to `resendTries` times. A mined one is left alone, and an endpoint that
  // already has it, or a nonce used since, is no failure.
  const sentCalls = new Map();
  const remember = (hash, call) => { sentCalls.set(hash, call); if (sentCalls.size > 64) sentCalls.delete(sentCalls.keys().next().value); };
  async function resend(hash) {
    const call = sentCalls.get(hash);
    if (!call || await receiptOf(hash).catch(() => null)) return false;
    for (const urls of [privateUrls, publicUrls]) {
      if (urls.length) await via(call, urls, urls === publicUrls, () => {}).catch(() => {});
    }
    return true;
  }
  function watch(hash) {
    const ms = Math.round((cfg.resendSecs ?? 40) * 1000), tries = cfg.resendTries ?? 3;
    if (!(ms > 0)) return;
    (async () => {
      for (let i = 1; i <= tries; i++) {
        await new Promise((r) => { setTimeout(r, ms).unref?.(); });
        if (await receiptOf(hash).catch(() => null)) return;
        log(`  ${hash} not mined after ${Math.round(ms * i / 1000)} s; sending it again`);
        await resend(hash).catch(() => {});
      }
    })();
  }

  const b32 = (x) => `0x${BigInt(x).toString(16).padStart(64, '0')}`;
  const transactOf = (logs) => logs.map((l) => ({
    firstIndex: l.args.firstIndex, outLeaf0: BigInt(l.args.outLeaf0), outLeaf1: BigInt(l.args.outLeaf1), blockNumber: l.blockNumber,
    logIndex: l.logIndex, tx: l.transactionHash, nf0: l.args.nf0, nf1: l.args.nf1, memo0: l.args.memo0, memo1: l.args.memo1,
    recipient: l.args.recipient, extAmount: l.args.extAmount, relayer: l.args.relayer, fee: l.args.fee, blockTimestamp: l.blockTimestamp ?? null,
  }));

  return {
    address: account.address,
    chainId,
    pool: cfg.pool,
    router: cfg.router,
    asset: getAddress(asset),
    v1: getAddress(v1),

    blockNumber: () => pub.getBlockNumber(),
    hasCode: async (address) => { const c = await pub.getCode({ address }); return !!c && c !== '0x'; },
    // The catch-up registry: the newest point's count, and the time a count was posted (0 for one never posted).
    pointLatest: async () => Number(await read(cfg.pointsAddress, CHECKPOINTS_ABI, 'latest')),
    pointPostedAt: async (size) => Number(await read(cfg.pointsAddress, CHECKPOINTS_ABI, 'postedAt', [BigInt(size)])),
    // The pool the registry keeps points for (one registry per pool: another pool's keeper must not post there).
    pointPool: async () => getAddress(await read(cfg.pointsAddress, CHECKPOINTS_ABI, 'POOL')),
    // The hub's newest count for this pool, and the time a count of it was posted (0 for one never posted).
    hubLatest: async () => Number(await read(cfg.pointsHub, HUB_ABI, 'latest', [cfg.pool])),
    hubPostedAt: async (size) => Number(await read(cfg.pointsHub, HUB_ABI, 'postedAt', [cfg.pool, BigInt(size)])),
    // Any view on the chain (a price feed the fee checks read).
    readContract: (address, abi, functionName, args = [], opts = {}) => pub.readContract({ address, abi, functionName, args, ...opts }),
    knownRoot: async (root) => read(cfg.pool, POOL_ABI, 'everKnownRoot', [b32(root)]),
    spent: async (nfs) => read(cfg.pool, POOL_ABI, 'isSpent', [nfs.map(b32)]),
    async poolState(blockNumber) {
      const [root, nextIndex] = await Promise.all([read(cfg.pool, POOL_ABI, 'root', [], blockNumber), read(cfg.pool, POOL_ABI, 'nextIndex', [], blockNumber)]);
      return { root: BigInt(root), nextIndex };
    },
    // The Transact logs of fromBlock..toBlock from the first facts node that returns every one of `expect` ([{ block, logIndex }]).
    async factsLogs(fromBlock, toBlock, expect) {
      let last = new Error('no facts node');
      for (const c of factsEach) {
        try {
          const logs = transactOf(await c.getLogs({ address: cfg.pool, event: POOL_ABI.find((x) => x.type === 'event'), fromBlock, toBlock, strict: true }));
          const have = new Set(logs.map((l) => `${Number(l.blockNumber)}:${Number(l.logIndex)}`));
          const lacking = expect.find((x) => !have.has(`${x.block}:${x.logIndex}`));
          if (!lacking) return logs;
          last = new Error(`a facts node has no Transact log at block ${lacking.block} index ${lacking.logIndex}`);
        } catch (e) { last = e; }
      }
      throw last;
    },
    async transactLogs(fromBlock, toBlock) {
      const logs = await logPub.getLogs({ address: cfg.pool, event: POOL_ABI.find((x) => x.type === 'event'), fromBlock, toBlock, strict: true });
      return transactOf(logs);
    },
    async receivedLogs(fromBlock, toBlock) {
      const logs = await logPub.getLogs({ address: cfg.router, event: RECEIVED_EVENT, fromBlock, toBlock, strict: true });
      return logs.map((l) => ({
        box: l.args.box, n: l.args.n, index: l.args.index, value: l.args.value, rho: l.args.rho, fee: l.args.fee,
        blockNumber: l.blockNumber, logIndex: l.logIndex, tx: l.transactionHash, blockTimestamp: l.blockTimestamp ?? null,
      }));
    },
    async txFacts(hash) {
      const t = await factsPub.getTransaction({ hash });
      return { from: t.from, to: t.to ?? null, input: t.input };
    },
    blockTime: async (blockNumber) => Number((await factsPub.getBlock({ blockNumber: BigInt(blockNumber) })).timestamp),
    depositBoxOf: async (intent) => getAddress(await read(cfg.router, ROUTER_ABI, 'depositBoxOf', [intent])),
    wrapBoxOf: async (intent) => getAddress(await read(cfg.router, ROUTER_ABI, 'wrapBoxOf', [intent])),
    async wrapToken(assetId) {
      const [registered, underlying] = await read(v1, V1_ABI, 'assets', [assetId]);
      return { registered, token: getAddress(underlying) };
    },
    balanceOf: (token, holder) => (token.toLowerCase() === ETH ? pub.getBalance({ address: holder }) : read(token, ERC20_ABI, 'balanceOf', [holder])),
    // What a send pays per gas: the RPC's price, or the base fee plus the tip floor if that is more.
    async gasPrice() {
      const [gp, block] = await Promise.all([pub.getGasPrice(), pub.getBlock()]);
      const floor = (block.baseFeePerGas ?? 0n) + cfg.minPriorityFee;
      return gp > floor ? gp : floor;
    },
    receiveBoxOf: async (npk, feeBps) => getAddress(await read(cfg.router, ROUTER_ABI, 'receiveBoxOf', [npk, feeBps])),
    receiveCount: async (box) => BigInt(await read(cfg.router, ROUTER_ABI, 'receiveCount', [box])),
    estimate: (functionName, args) => pub.estimateContractGas({ ...target(functionName), args, account }),
    // Whether the keeper can front a send of `gas` now: { ok, balance, need, headroom } (frontFees).
    canFront: async (gas) => frontFees({ ...(await prices()), gas }),

    // One signed transaction to every private endpoint (the same hash at each, so whichever builder takes it, it lands
    // once); the read RPC only when every private endpoint refused it and public sends are allowed. Returns the hash.
    // Re-simulated inside the queue, right before signing, so state that moved since the caller's estimate
    // (another relay spending the same note, a new root) fails here instead of on chain; a transaction that
    // follows the keeper's own unmined ones cannot be simulated yet and is sent with simulate: false.
    send: (functionName, args, { gas, simulate = true }) => serial(async () => {
      if (simulate) await pub.estimateContractGas({ ...target(functionName), args, account });
      let lastErr;
      const fail = (e) => { lastErr = e; };
      for (const urls of [privateUrls, publicUrls]) {
        if (!urls.length) continue;
        const hash = await withNonceRetry(functionName, async () => {
          const [nonce, fee] = await Promise.all([nextNonce(), fees(gas)]);
          const call = { functionName, args, gas, nonce, fee };
          const h = await via(call, urls, urls === publicUrls, fail);
          if (!h) throw lastErr || new Error('no submission endpoint took it');
          signer.sentNonce = nonce;
          signer.sentAt = Date.now();
          remember(h, call);
          watch(h);
          return h;
        }, { log }).catch((e) => { if (revertName(e)) throw e; lastErr = e; return null; });
        if (hash) return hash;
      }
      throw lastErr || new Error('no submission endpoint');
    }),
    resend,
    async waitReceipt(hash, timeoutMs) {
      try { return await pub.waitForTransactionReceipt({ hash, timeout: timeoutMs }); }
      catch (e) { if (/timed out|could not be found/i.test(String(e?.shortMessage || e?.message))) return null; throw e; }
    },
    receipt: receiptOf,
  };
}
