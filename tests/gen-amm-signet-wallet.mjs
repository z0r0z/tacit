// Wallet generator for the AMM signet smoke test.
//
// Produces .local/amm-signet-wallet.json with one fresh privkey + bech32
// P2WPKH signet address. The address is printed to stdout — top it up
// via https://signet.bublina.eu.org/ (or similar signet faucet) before
// running tests/amm-smoke-signet.mjs.
//
// Run once:  node tests/gen-amm-signet-wallet.mjs
// Re-running prints the existing wallet (idempotent — does NOT overwrite).

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) {
  try { globalThis.crypto = dom.window.crypto; } catch {}
}
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const OUT_FILE = path.join(STATE_DIR, 'amm-signet-wallet.json');

if (existsSync(OUT_FILE)) {
  const existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  console.log(`Wallet already exists at ${OUT_FILE} (re-use; not overwriting).\n`);
  console.log(`  address:  ${existing.address}`);
  console.log(`  network:  ${existing.network}`);
  console.log(`  pub_hex:  ${existing.pub_hex.slice(0, 16)}…`);
  console.log(`\nFund signet sats: https://signet.bublina.eu.org/`);
  console.log(`Then run: node tests/amm-smoke-signet.mjs`);
  process.exit(0);
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const priv = secp.utils.randomPrivateKey();
const pub = secp.getPublicKey(priv, true);
dapp.wallet.priv = priv;
dapp.wallet.pub = pub;
const address = dapp.wallet.address();

const wallet = {
  network: 'signet',
  priv_hex: bytesToHex(priv),
  pub_hex: bytesToHex(pub),
  address,
  created_at: new Date().toISOString(),
};
writeFileSync(OUT_FILE, JSON.stringify(wallet, null, 2));

console.log(`\n=== AMM signet smoke-test wallet generated ===\n`);
console.log(`  network:  signet`);
console.log(`  address:  ${address}`);
console.log(`  pub_hex:  ${bytesToHex(pub)}`);
console.log(`  saved to: ${OUT_FILE}`);
console.log(`\nNext steps:`);
console.log(`  1. Top up signet sats at:`);
console.log(`     https://signet.bublina.eu.org/`);
console.log(`     OR https://alt.signetfaucet.com/`);
console.log(`     Need ~200,000 sats minimum (covers 2× CETCH + POOL_INIT + slack)`);
console.log(``);
console.log(`  2. Once funded (verify on https://mempool.space/signet/address/${address})`);
console.log(`     run: node tests/amm-smoke-signet.mjs`);
console.log(``);
console.log(`  This wallet acts as: AMM founder + LP + trader (all roles in one`);
console.log(`  wallet for the smoke test). The smoke test will:`);
console.log(`    a) CETCH asset_A ("amm-smoke-A")`);
console.log(`    b) CETCH asset_B ("amm-smoke-B")`);
console.log(`    c) POOL_INIT at deltaA=100k / deltaB=300k / fee_bps=30`);
console.log(`    d) Verify the pool registers on the worker after confirmation`);
console.log(``);
