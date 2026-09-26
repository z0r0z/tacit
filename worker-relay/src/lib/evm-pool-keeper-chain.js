// Chain I/O for the EVM pool box keeper, behind the small interface the loop and intake use (tests mock it).

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
const fn = (name, inputs, outputs = [], stateMutability = 'nonpayable') => ({ type: 'function', name, stateMutability, inputs, outputs });
const ERRORS = [
  // router
  'BadTarget', 'BadIntent', 'BadPermit2', 'AmountTooLarge', 'ShortSwapOutput', 'ZRouterCallFailed', 'NotExpired', 'NothingToReclaim',
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
  ...ERRORS,
];
const POOL_ABI = [
  fn('root', [], [{ type: 'bytes32' }], 'view'),
  fn('nextIndex', [], [{ type: 'uint256' }], 'view'),
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

export async function makeKeeperChain({ cfg, account, log = () => {} }) {
  const pub = createPublicClient({ transport: fallback(cfg.rpcUrls.map((u) => http(u))) });
  const chainId = await pub.getChainId();
  if (cfg.chainId && chainId !== cfg.chainId) throw new Error(`RPC is on chain ${chainId}, EVM_POOL_CHAIN_ID is ${cfg.chainId}`);
  const viemChain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrls[0]] } } });
  const read = (address, abi, functionName, args = [], blockNumber) => pub.readContract({ address, abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });

  const [pool, asset, v1] = await Promise.all(['POOL', 'ASSET', 'V1'].map((f) => read(cfg.router, ROUTER_ABI, f)));
  if (getAddress(pool) !== cfg.pool) throw new Error(`router ${cfg.router} serves pool ${pool}, not EVM_POOL_ADDR ${cfg.pool}`);

  const sendUrls = [...cfg.sendRpcUrls, ...(cfg.allowPublicSend || !cfg.sendRpcUrls.length ? [cfg.rpcUrls[0]] : [])];

  return {
    address: account.address,
    chainId,
    pool: cfg.pool,
    router: cfg.router,
    asset: getAddress(asset),
    v1: getAddress(v1),

    blockNumber: () => pub.getBlockNumber(),
    async poolState(blockNumber) {
      const [root, nextIndex] = await Promise.all([read(cfg.pool, POOL_ABI, 'root', [], blockNumber), read(cfg.pool, POOL_ABI, 'nextIndex', [], blockNumber)]);
      return { root: BigInt(root), nextIndex };
    },
    async transactLogs(fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: cfg.pool, event: POOL_ABI.find((x) => x.type === 'event'), fromBlock, toBlock, strict: true });
      return logs.map((l) => ({ firstIndex: l.args.firstIndex, outLeaf0: BigInt(l.args.outLeaf0), outLeaf1: BigInt(l.args.outLeaf1), blockNumber: l.blockNumber }));
    },
    depositBoxOf: async (intent) => getAddress(await read(cfg.router, ROUTER_ABI, 'depositBoxOf', [intent])),
    wrapBoxOf: async (intent) => getAddress(await read(cfg.router, ROUTER_ABI, 'wrapBoxOf', [intent])),
    async wrapToken(assetId) {
      const [registered, underlying] = await read(v1, V1_ABI, 'assets', [assetId]);
      return { registered, token: getAddress(underlying) };
    },
    balanceOf: (token, holder) => (token.toLowerCase() === ETH ? pub.getBalance({ address: holder }) : read(token, ERC20_ABI, 'balanceOf', [holder])),
    gasPrice: () => pub.getGasPrice(),
    estimate: (functionName, args) => pub.estimateContractGas({ address: cfg.router, abi: ROUTER_ABI, functionName, args, account }),

    // Private endpoints first; the read RPC last when public sends are allowed. Returns the tx hash.
    async send(functionName, args, { gas }) {
      let lastErr;
      for (const url of sendUrls) {
        try {
          const wallet = createWalletClient({ account, chain: viemChain, transport: http(url) });
          return await withNonceRetry(functionName, () => wallet.writeContract({ address: cfg.router, abi: ROUTER_ABI, functionName, args, gas }), { log });
        } catch (e) {
          lastErr = e;
          log(`  submit via ${new URL(url).host} failed: ${safeErr(e)}`);
          if (revertName(e)) throw e;
        }
      }
      throw lastErr || new Error('no submission endpoint');
    },
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
