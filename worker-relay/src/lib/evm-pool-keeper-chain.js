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

export async function makeKeeperChain({ cfg, account, log = () => {} }) {
  const pub = createPublicClient({ transport: fallback(cfg.rpcUrls.map((u) => http(u))) });
  // History facts (a transaction's sender and target, a block's time) are read from the read nodes in reverse order, so a
  // backfill does not crowd the node that relays and proofs read first.
  const factsPub = cfg.rpcUrls.length > 1 ? createPublicClient({ transport: fallback([...cfg.rpcUrls].reverse().map((u) => http(u))) }) : pub;
  const chainId = await pub.getChainId();
  if (cfg.chainId && chainId !== cfg.chainId) throw new Error(`RPC is on chain ${chainId}, EVM_POOL_CHAIN_ID is ${cfg.chainId}`);
  const viemChain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrls[0]] } } });
  const read = (address, abi, functionName, args = [], blockNumber) => pub.readContract({ address, abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });

  const [pool, asset, v1] = await Promise.all(['POOL', 'ASSET', 'V1'].map((f) => read(cfg.router, ROUTER_ABI, f)));
  if (getAddress(pool) !== cfg.pool) throw new Error(`router ${cfg.router} serves pool ${pool}, not EVM_POOL_ADDR ${cfg.pool}`);

  const privateUrls = cfg.sendRpcUrls, publicUrls = cfg.allowPublicSend || !privateUrls.length ? [cfg.rpcUrls[0]] : [];
  // `functionName` on the router, or `pool.transact` (a relayed user transaction) on the pool.
  const target = (functionName) => (functionName === 'pool.transact'
    ? { address: cfg.pool, abi: POOL_ABI, functionName: 'transact' }
    : { address: cfg.router, abi: ROUTER_ABI, functionName });
  // One signer, one nonce: the loop and relay requests send through this queue one at a time.
  let sending = Promise.resolve();
  const serial = (f) => { const run = sending.then(f, f); sending = run.catch(() => {}); return run; };
  // The next nonce: the chain's pending count; with the queue on (public mempool only), past what this process last
  // sent while the RPC has not seen it yet. A private endpoint can drop a transaction without using its nonce, so
  // there only the chain's count is trusted; and a send never seen within a minute is forgotten.
  let sentNonce = -1, sentAt = 0;
  const nextNonce = async () => {
    const pending = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    if (!cfg.pipeline || (pending <= sentNonce && Date.now() - sentAt > 60_000)) return pending;
    return Math.max(pending, sentNonce + 1);
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
  const b32 = (x) => `0x${BigInt(x).toString(16).padStart(64, '0')}`;

  return {
    address: account.address,
    chainId,
    pool: cfg.pool,
    router: cfg.router,
    asset: getAddress(asset),
    v1: getAddress(v1),

    blockNumber: () => pub.getBlockNumber(),
    knownRoot: async (root) => read(cfg.pool, POOL_ABI, 'everKnownRoot', [b32(root)]),
    spent: async (nfs) => read(cfg.pool, POOL_ABI, 'isSpent', [nfs.map(b32)]),
    async poolState(blockNumber) {
      const [root, nextIndex] = await Promise.all([read(cfg.pool, POOL_ABI, 'root', [], blockNumber), read(cfg.pool, POOL_ABI, 'nextIndex', [], blockNumber)]);
      return { root: BigInt(root), nextIndex };
    },
    async transactLogs(fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: cfg.pool, event: POOL_ABI.find((x) => x.type === 'event'), fromBlock, toBlock, strict: true });
      return logs.map((l) => ({
        firstIndex: l.args.firstIndex, outLeaf0: BigInt(l.args.outLeaf0), outLeaf1: BigInt(l.args.outLeaf1), blockNumber: l.blockNumber,
        logIndex: l.logIndex, tx: l.transactionHash, nf0: l.args.nf0, nf1: l.args.nf1, memo0: l.args.memo0, memo1: l.args.memo1,
        recipient: l.args.recipient, extAmount: l.args.extAmount, relayer: l.args.relayer, fee: l.args.fee, blockTimestamp: l.blockTimestamp ?? null,
      }));
    },
    async receivedLogs(fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: cfg.router, event: RECEIVED_EVENT, fromBlock, toBlock, strict: true });
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
      const via = async (urls, nonce, fee) => {
        let hash = null;
        for (const url of urls) {
          try {
            const wallet = createWalletClient({ account, chain: viemChain, transport: http(url) });
            hash = (await wallet.writeContract({ ...target(functionName), args, gas, nonce, ...fee })) || hash;
          } catch (e) {
            lastErr = e;
            log(`  submit via ${new URL(url).host} failed: ${safeErr(e)}`);
            if (revertName(e)) throw e;
          }
        }
        return hash;
      };
      for (const urls of [privateUrls, publicUrls]) {
        if (!urls.length) continue;
        const hash = await withNonceRetry(functionName, async () => {
          const [nonce, fee] = await Promise.all([nextNonce(), fees(gas)]);
          const h = await via(urls, nonce, fee);
          if (!h) throw lastErr || new Error('no submission endpoint took it');
          sentNonce = nonce;
          sentAt = Date.now();
          return h;
        }, { log }).catch((e) => { if (revertName(e)) throw e; lastErr = e; return null; });
        if (hash) return hash;
      }
      throw lastErr || new Error('no submission endpoint');
    }),
    async waitReceipt(hash, timeoutMs) {
      try { return await pub.waitForTransactionReceipt({ hash, timeout: timeoutMs }); }
      catch (e) { if (/timed out|could not be found/i.test(String(e?.shortMessage || e?.message))) return null; throw e; }
    },
    async receipt(hash) {
      try { return await pub.getTransactionReceipt({ hash }); }
      catch (e) { if (/could not be found|not found/i.test(String(e?.shortMessage || e?.message))) return null; throw e; }
    },
  };
}
