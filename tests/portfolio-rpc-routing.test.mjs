import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'dapp/tacit.js'), 'utf8');
const chainlinkStart = app.indexOf('const _fetchChainlink = async () => {');
const chainlinkEnd = app.indexOf('\n    try {', chainlinkStart);
assert.ok(chainlinkStart >= 0 && chainlinkEnd > chainlinkStart, 'Chainlink price reader not found');
const chainlink = app.slice(chainlinkStart, chainlinkEnd);

assert.match(chainlink, /_ethRpcCall\('eth_call'/, 'portfolio price fallback must use the shared RPC router');
assert.doesNotMatch(chainlink, /ethereum-rpc\.publicnode\.com/, 'portfolio price fallback must not call PublicNode directly');
assert.doesNotMatch(app, /ethereum-rpc\.publicnode\.com/, 'portfolio app bundle must not contain direct PublicNode routes');

const index = readFileSync(join(ROOT, 'dapp/index.html'), 'utf8');
assert.ok(index.includes("rpcUrls: ['https://eth.drpc.org']"), 'portfolio WalletConnect must use the healthy default RPC');

const walletConnect = readFileSync(join(ROOT, 'dapp/walletconnect.js'), 'utf8');
assert.match(walletConnect, /ETH_NODES\[0\]/, 'WalletConnect must inherit the shared Ethereum RPC route');
assert.doesNotMatch(walletConnect, /ethereum-rpc\.publicnode\.com/, 'WalletConnect must not default to PublicNode');

console.log('portfolio RPC routing: all checks passed');
