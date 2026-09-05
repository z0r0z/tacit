// viem clients + the minimal ABIs the relay calls on-chain.
// We use viem (not ethers) — lighter, ESM-native, typed. Noted in README.

import { createPublicClient, createWalletClient, http, fallback, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CFG, ADDR } from './config.js';

// Reads fall through the configured endpoints in order: a single provider going slow or rate-limiting
// otherwise aborts the whole cycle, and for reflection that discards an already-paid proof.
const transport = CFG.rpcUrls.length > 1
  ? fallback(CFG.rpcUrls.map((url) => http(url)))
  : http(CFG.rpcUrl);
// Settle txs go out via a PRIVATE endpoint (Flashbots Protect) so the proof never hits the public mempool —
// otherwise a searcher copies it, lands it first as msg.sender to steal the bound fee, and reverts our tx.
// Receipts are still polled on publicClient (the tx is private only until it's mined).
const settleTransport = CFG.settleRpcUrl ? http(CFG.settleRpcUrl) : transport;

// Chain object: default to mainnet; for other chainIds viem still works with an
// explicit id override via the transport (the pool addresses drive correctness, not chain metadata).
const chain = CFG.chainId === 1 ? mainnet : { ...mainnet, id: CFG.chainId };

export const publicClient = createPublicClient({ chain, transport });

// A SECOND opinion, deliberately not sharing the fallback list above. viem's fallback() sticks with the
// first endpoint that doesn't error, so as long as RPC_URL answers every call — receipts included — every
// read in a normal cycle goes through it alone; the public fallbacks are all reachability insurance, not a
// disagreement check. That is exactly the gap that let a false "3 confirmations" receipt through: the
// endpoint that reported it was the same one asked to confirm it, and it never had to answer to anyone
// else. The reflection cursor is unrewindable once acked, so before advancing it, cross-check against an
// endpoint that was never party to the submission.
export const verifyClient = createPublicClient({ chain, transport: http(CFG.reflectionVerifyRpcUrl) });

function walletFor(pk, tp = transport) {
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  return createWalletClient({ account, chain, transport: tp });
}
export const relayWallet = walletFor(CFG.relayKey);
export const settleWallet = walletFor(CFG.settleKey || CFG.relayKey, settleTransport);
// The same signer over each configured private endpoint, tried in order: one relay refusing a submission
// (stale validator, outage) would otherwise waste a proof the relay has already paid for.
export const settleWallets = [
  ...(CFG.settleRpcUrls || []).map((url) => ({ url, wallet: walletFor(CFG.settleKey || CFG.relayKey, http(url)) })),
  ...(CFG.settleAllowPublic ? [{ url: `${CFG.rpcUrl} (PUBLIC)`, wallet: walletFor(CFG.settleKey || CFG.relayKey, transport) }] : []),
];

// Live ETH/USD (Chainlink). The relay's cost is gas × ETH price, so a hardcoded price misprices every job
// the moment ETH moves — overstating cost rejects profitable work, understating it relays at a loss. Cached
// ~1 min (the feed moves more slowly than that); falls back to the static CFG.ethPriceUsd if the read fails.
let _ethUsd = { at: 0, v: null };
export async function ethUsdPrice() {
  if (Date.now() - _ethUsd.at < 60_000 && _ethUsd.v) return _ethUsd.v;
  try {
    const { data } = await publicClient.call({ to: getAddress(ADDR.ethUsdFeed), data: '0xfeaf968c' }); // latestRoundData()
    const hex = String(data || '').replace(/^0x/, '');
    if (hex.length >= 128) {
      const answer = BigInt('0x' + hex.slice(64, 128)); // int256 answer (word[1]), 8 decimals
      if (answer > 0n) _ethUsd = { at: Date.now(), v: Number(answer) / 1e8 };
    }
  } catch { /* keep the last good price, else the static fallback */ }
  return _ethUsd.v ?? CFG.ethPriceUsd;
}

// ── ABIs (minimal) ──
// NOTE: knownReflectionDigest / lastRelayHeight are INTERNAL vars on the deployed pool — no public
// getter (calls revert). Read them by storage slot via readReflectionDigest() / readRelayHeight() below.
// Only attest/settle are external functions.
export const POOL_ABI = [
  { type: 'function', name: 'attestBitcoinStateProven', stateMutability: 'nonpayable', inputs: [{ type: 'bytes' }, { type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes[]' }], outputs: [] },
  { type: 'function', name: 'attestedReflectionDigest', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
];

// Storage slot of ConfidentialPool.knownReflectionDigest (an internal var — no getter, so it is read
// by slot). RE-DERIVE THIS AFTER ANY POOL STORAGE CHANGE, do not trust a remembered number:
//   forge inspect src/ConfidentialPool.sol:ConfidentialPool storage-layout --json
// Current layout: 78 knownBitcoinRoot / 79 knownBitcoinSpentRoot / 80 knownBitcoinBurnRoot /
// 81 knownReflectionDigest. A stale value here is not cosmetic: this read is the idempotency check, so
// pointing it at the wrong slot makes "already attested" undetectable — the folder then re-proves the
// same batch and never acks, and the scan cursor stops advancing.
export const POOL_SLOT_REFLECTION_DIGEST = 81n;

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
  // retarget(): cross a difficulty epoch. Relay must be AT the boundary; headers = PROOF_LENGTH*2 (=8)
  // straddling it (last 4 of old epoch + first 4 of new).
  { type: 'function', name: 'retarget', stateMutability: 'nonpayable', inputs: [{ name: 'headers', type: 'bytes' }], outputs: [] },
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

// The digest the pool has attested up to — the reflection-folder's idempotency check (skip a batch that
// is already on-chain, and recognise an "already attested" revert so it acks instead of looping).
// Prefer the view: it cannot drift when the pool's storage layout shifts, which is how this read silently
// pointed at knownBitcoinBurnRoot for a generation. The slot read stays as a fallback for older pools
// deployed before `attestedReflectionDigest()` existed.
export async function readReflectionDigest(client = publicClient) {
  try {
    const d = await client.readContract({ address: POOL, abi: POOL_ABI, functionName: 'attestedReflectionDigest' });
    if (d) return d;
  } catch { /* pre-getter pool — fall through to the pinned slot */ }
  return client.getStorageAt({ address: POOL, slot: `0x${POOL_SLOT_REFLECTION_DIGEST.toString(16)}` });
}
