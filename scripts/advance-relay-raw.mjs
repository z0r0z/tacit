#!/usr/bin/env node
// Cast-free BitcoinLightRelay advancer.
//
// Use this when Foundry/cast is unavailable or crashes while building RPC transports (we hit this on
// macOS during the Sepolia/signet pilot). It performs the same operation as scripts/advance-relay.sh:
// fetch contiguous Bitcoin/signet headers from mempool.space and submit advanceTip(bytes) as a raw
// replay-protected Ethereum transaction. It deliberately requires explicit RELAY_ADDRESS + RELAY_PK so
// a developer cannot accidentally advance a stale/default relay.
//
// Usage:
//   ETH_RPC=https://ethereum-sepolia-rpc.publicnode.com \
//   RELAY_ADDRESS=0x... RELAY_PK=0x... \
//   MEMPOOL_API=https://mempool.space/signet/api \
//   node scripts/advance-relay-raw.mjs --count 10
//
// Options:
//   --from <height>   first Bitcoin height to submit; defaults to on-chain relay tip + 1
//   --count <n>       max headers to submit; defaults to 10
//   --dry-run         fetch/encode/check gas, but do not submit

import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

secp.etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, secp.etc.concatBytes(...msgs));

const args = process.argv.slice(2);
let fromArg = process.env.FROM_HEIGHT ? Number(process.env.FROM_HEIGHT) : null;
let count = Number(process.env.COUNT || 10);
let dryRun = process.env.DRY_RUN === '1';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--from') fromArg = Number(args[++i]);
  else if (a === '--count') count = Number(args[++i]);
  else if (a === '--dry-run') dryRun = true;
  else throw new Error(`unknown arg ${a}`);
}
if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`bad --count ${count}`);
if (fromArg !== null && (!Number.isSafeInteger(fromArg) || fromArg <= 0)) throw new Error(`bad --from ${fromArg}`);

const RPC = process.env.ETH_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const MEMPOOL_API = process.env.MEMPOOL_API || 'https://mempool.space/signet/api';
const RELAY = (process.env.RELAY_ADDRESS || '').toLowerCase();
const privateKey = (process.env.RELAY_PK || process.env.SEPOLIA_PK || '').replace(/^0x/, '');
if (!/^0x[0-9a-f]{40}$/.test(RELAY)) throw new Error('set RELAY_ADDRESS=0x...');
if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('set RELAY_PK=0x... (or SEPOLIA_PK)');

const enc = new TextEncoder();
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex) => {
  hex = hex.replace(/^0x/, '');
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const concat = (...arrs) => {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
};
const intBytes = (n) => {
  n = BigInt(n);
  if (n === 0n) return new Uint8Array();
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(hex);
};
const lenBytes = (len) => intBytes(BigInt(len));
const rlpBytes = (bytes) => {
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  if (bytes.length <= 55) return concat(new Uint8Array([0x80 + bytes.length]), bytes);
  const l = lenBytes(bytes.length);
  return concat(new Uint8Array([0xb7 + l.length]), l, bytes);
};
const rlpList = (items) => {
  const payload = concat(...items);
  if (payload.length <= 55) return concat(new Uint8Array([0xc0 + payload.length]), payload);
  const l = lenBytes(payload.length);
  return concat(new Uint8Array([0xf7 + l.length]), l, payload);
};
const rlp = (x) => Array.isArray(x) ? rlpList(x.map(rlp)) :
  typeof x === 'bigint' || typeof x === 'number' ? rlpBytes(intBytes(x)) :
  typeof x === 'string' ? rlpBytes(hexToBytes(x)) :
  rlpBytes(x);

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}
async function mempool(path) {
  const res = await fetch(`${MEMPOOL_API}${path}`);
  if (!res.ok) throw new Error(`${MEMPOOL_API}${path}: HTTP ${res.status}`);
  return (await res.text()).trim();
}
const selector = (sig) => bytesToHex(keccak_256(enc.encode(sig))).slice(0, 8);
const word = (x) => (typeof x === 'bigint' || typeof x === 'number'
  ? BigInt(x).toString(16)
  : String(x).replace(/^0x/, '')).padStart(64, '0');
const abiBytesCall = (sig, bytesHex) => {
  const len = bytesHex.length / 2;
  return `0x${selector(sig)}${word(32)}${word(len)}${bytesHex.padEnd(Math.ceil(len / 32) * 64, '0')}`;
};
const addressFromPrivate = (pk) => {
  const pub = secp.getPublicKey(pk, false).slice(1);
  return `0x${bytesToHex(keccak_256(pub).slice(-20))}`;
};
const asNumber = (hex, label) => {
  const n = BigInt(hex);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} too large for JS number`);
  return Number(n);
};

const fromAddress = addressFromPrivate(privateKey);
const relayTip = asNumber(await rpc('eth_call', [{ to: RELAY, data: `0x${selector('tipHeight()')}` }, 'latest']), 'relay tip');
const currentEpoch = asNumber(await rpc('eth_call', [{ to: RELAY, data: `0x${selector('currentEpoch()')}` }, 'latest']), 'current epoch');
const signetTip = Number(await mempool('/blocks/tip/height'));
if (!Number.isSafeInteger(signetTip)) throw new Error(`bad Bitcoin tip from ${MEMPOOL_API}`);

const fromHeight = fromArg ?? relayTip + 1;
if (fromHeight !== relayTip + 1) throw new Error(`--from ${fromHeight} must equal relay tip + 1 (${relayTip + 1})`);
let submitCount = Math.min(count, signetTip - fromHeight + 1);
const boundary = (currentEpoch + 1) * 2016 - 1;
if (fromHeight > boundary) {
  console.log(JSON.stringify({ relayTip, currentEpoch, boundary, status: 'retarget-required' }, null, 2));
  process.exit(0);
}
if (fromHeight + submitCount - 1 > boundary) submitCount = boundary - fromHeight + 1;
if (submitCount <= 0) {
  console.log(JSON.stringify({ relayTip, signetTip, status: 'already-up-to-date' }, null, 2));
  process.exit(0);
}

let headers = '';
const blocks = [];
for (let h = fromHeight; h < fromHeight + submitCount; h++) {
  const hash = await mempool(`/block-height/${h}`);
  const header = await mempool(`/block/${hash}/header`);
  if (!/^[0-9a-f]{160}$/i.test(header)) throw new Error(`bad header for height ${h}`);
  headers += header;
  blocks.push({ height: h, hash });
}
const data = abiBytesCall('advanceTip(bytes)', headers);

const [chainIdHex, nonceHex, gasPriceHex, balanceHex] = await Promise.all([
  rpc('eth_chainId'),
  rpc('eth_getTransactionCount', [fromAddress, 'pending']),
  rpc('eth_gasPrice'),
  rpc('eth_getBalance', [fromAddress, 'latest']),
]);
let gasLimit;
if (process.env.GAS_LIMIT) {
  gasLimit = BigInt(process.env.GAS_LIMIT);
} else {
  try {
    const estimate = BigInt(await rpc('eth_estimateGas', [{ from: fromAddress, to: RELAY, data }]));
    gasLimit = (estimate * 12n) / 10n + 50_000n;
  } catch {
    gasLimit = 5_000_000n;
  }
}
const chainId = BigInt(chainIdHex);
const nonce = BigInt(nonceHex);
const gasPrice = BigInt(gasPriceHex);
const balance = BigInt(balanceHex);
const maxCost = gasPrice * gasLimit;
if (!dryRun && balance < maxCost) throw new Error(`relayer ${fromAddress} balance ${balance} below max gas cost ${maxCost}`);

const summary = {
  from: fromAddress,
  relay: RELAY,
  relayTipBefore: relayTip,
  currentEpoch,
  signetTip,
  count: submitCount,
  first: blocks[0],
  last: blocks[blocks.length - 1],
  chainId: Number(chainId),
  nonce: Number(nonce),
  gasPriceWei: gasPrice.toString(),
  gasLimit: gasLimit.toString(),
  dryRun,
};
if (dryRun) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const unsigned = [nonce, gasPrice, gasLimit, RELAY, 0n, data, chainId, 0n, 0n];
const msgHash = keccak_256(rlp(unsigned));
const sig = secp.sign(msgHash, privateKey, { lowS: true });
const v = BigInt(sig.recovery) + 35n + 2n * chainId;
const rawTx = `0x${bytesToHex(rlp([nonce, gasPrice, gasLimit, RELAY, 0n, data, v, sig.r, sig.s]))}`;
const txHash = await rpc('eth_sendRawTransaction', [rawTx]);
console.log(JSON.stringify({ ...summary, txHash }, null, 2));

for (let i = 0; i < 30; i++) {
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (receipt) {
    const relayTipAfter = asNumber(await rpc('eth_call', [{ to: RELAY, data: `0x${selector('tipHeight()')}` }, 'latest']), 'relay tip after');
    console.log(JSON.stringify({
      receipt: {
        status: receipt.status,
        blockNumber: asNumber(receipt.blockNumber, 'receipt block number'),
        gasUsed: BigInt(receipt.gasUsed).toString(),
      },
      relayTipAfter,
    }, null, 2));
    process.exit(receipt.status === '0x1' ? 0 : 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
}
throw new Error(`timed out waiting for receipt ${txHash}`);
