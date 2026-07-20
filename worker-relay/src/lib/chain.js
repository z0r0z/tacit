// viem clients + the minimal ABIs the relay calls on-chain.
// We use viem (not ethers) — lighter, ESM-native, typed. Noted in README.

import { createPublicClient, createWalletClient, http, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CFG, ADDR } from './config.js';

const transport = http(CFG.rpcUrl);

// Chain object: default to mainnet; for other chainIds viem still works with an
// explicit id override via the transport (the pool addresses drive correctness, not chain metadata).
const chain = CFG.chainId === 1 ? mainnet : { ...mainnet, id: CFG.chainId };

export const publicClient = createPublicClient({ chain, transport });

function walletFor(pk) {
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  return createWalletClient({ account, chain, transport });
}
export const relayWallet = walletFor(CFG.relayKey);
export const settleWallet = walletFor(CFG.settleKey || CFG.relayKey);

// ── ABIs (minimal) ──
// NOTE: knownReflectionDigest / lastRelayHeight are INTERNAL vars on the deployed pool — no public
// getter (calls revert). Read them by storage slot via readReflectionDigest() / readRelayHeight() below.
// Only attest/settle are external functions.
export const POOL_ABI = [
  { type: 'function', name: 'attestBitcoinStateProven', stateMutability: 'nonpayable', inputs: [{ type: 'bytes' }, { type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes[]' }], outputs: [] },
];

// Storage slots on the deployed ConfidentialPool (confirmed on mainnet 0x0000…C03D):
//   80 = knownReflectionDigest (bytes32). lastRelayHeight slot: derive from the layout — the monitor
//   compares it to the HEADER_RELAY tip for lag; TODO pin the exact height slot (grep the compiled layout).
export const POOL_SLOT_REFLECTION_DIGEST = 80n;

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

// Succinct vApp deposit(uint256) — tops up the network prover balance in PROVE.
export const VAPP_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
];

// zQuoter (verified 0x000000a7…) — buildSwapAuto (0x98d7d292) auto-routes across all venues
// INCLUDING multihop through the ETH/WETH hub, and returns ready-to-send zRouter callData +
// msgValue, so replenish just fires (to: zRouter, data: callData, value: msgValue).
// exactOut=false ⇒ exact-in. (buildBestSwap, 0xe7798987, is single-pool only — a thin quote
// for tokens whose PROVE liquidity sits behind the WETH hub, e.g. USDC/wstETH → PROVE.)
export const ZQUOTER_ABI = [
  {
    type: 'function', name: 'buildSwapAuto', stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' }, { name: 'exactOut', type: 'bool' },
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'swapAmount', type: 'uint256' }, { name: 'slippageBps', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'best', type: 'tuple', components: [
        { name: 'source', type: 'uint8' }, { name: 'feeBps', type: 'uint256' },
        { name: 'amountIn', type: 'uint256' }, { name: 'amountOut', type: 'uint256' }] },
      { name: 'callData', type: 'bytes' }, { name: 'amountLimit', type: 'uint256' }, { name: 'msgValue', type: 'uint256' },
    ],
  },
];

// zRouter (verified 0x0000…600e4) — fire the zQuoter callData via a raw tx (to: zRouter, data, value),
// or swapV4 directly for a known V4 pool. execute() is the generic passthrough.
export const ZROUTER_ABI = [
  {
    type: 'function', name: 'swapV4', stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' }, { name: 'exactOut', type: 'bool' }, { name: 'swapFee', type: 'uint24' },
      { name: 'tickSpace', type: 'int24' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'swapAmount', type: 'uint256' }, { name: 'amountLimit', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOut', type: 'uint256' }],
  },
  { type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ type: 'bytes[]' }], outputs: [{ type: 'bytes[]' }] },
];

// BitcoinLightRelay — advanceTip(bytes) appends confirmed BTC headers; tipHeight() = confirmed height.
export const RELAY_ABI = [
  { type: 'function', name: 'tipHeight', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'advanceTip', stateMutability: 'nonpayable', inputs: [{ name: 'headers', type: 'bytes' }], outputs: [] },
];
export const HEADER_RELAY = getAddress(ADDR.headerRelay);

export const POOL = getAddress(ADDR.pool);
export const VAPP = getAddress(ADDR.vApp);
export const PROVE = getAddress(ADDR.prove);
export const ZQUOTER = getAddress(ADDR.zQuoter);
export const ZROUTER = getAddress(ADDR.zRouter);

export async function readPool(fn, args = []) {
  return publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: fn, args });
}

// knownReflectionDigest is an internal var (no getter) — read it by storage slot (80 on mainnet).
// This is what the reflection-folder uses for its idempotency check (skip an already-attested batch).
export async function readReflectionDigest() {
  return publicClient.getStorageAt({ address: POOL, slot: `0x${POOL_SLOT_REFLECTION_DIGEST.toString(16)}` });
}
