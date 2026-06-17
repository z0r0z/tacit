// Generates the SELLER + TAKER signet wallets the axintent e2e harnesses share
// at .local/axintent-signet-test-wallets.json. Both axintent-onchain-e2e-signet
// (T_AXFER take) and axintent-var-onchain-e2e-signet (T_AXFER_VAR take) read this
// file. Re-running reuses an existing file (never overwrites). Ephemeral signet
// test keys only — .local/ is gitignored. Prints funding addresses + amounts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const OUT_FILE = path.join(STATE_DIR, 'axintent-signet-test-wallets.json');
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function addrFor(skHex) {
  dapp.wallet.priv = hexToBytes(skHex);
  dapp.wallet.pub = secp.getPublicKey(dapp.wallet.priv, true);
  return dapp.wallet.address();
}

let wallets;
if (existsSync(OUT_FILE)) {
  wallets = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  console.log(`Reusing existing ${OUT_FILE} (NOT overwriting).\n`);
} else {
  wallets = {
    seller: { priv_hex: bytesToHex(secp.utils.randomPrivateKey()) },
    taker:  { priv_hex: bytesToHex(secp.utils.randomPrivateKey()) },
  };
  writeFileSync(OUT_FILE, JSON.stringify(wallets, null, 2));
  console.log(`Wrote ${OUT_FILE}\n`);
}

// Per-test gates: onchain seller≥10k/taker≥50k, var seller≥15k/taker≥50k.
// These targets carry both runs back-to-back (etch fees + payments + headroom).
const targets = [
  ['seller', addrFor(wallets.seller.priv_hex), 40_000],
  ['taker',  addrFor(wallets.taker.priv_hex),  110_000],
];
console.log('Fund these signet addresses (covers BOTH axintent-onchain + axintent-var):');
for (const [role, addr, sats] of targets) {
  console.log(`  ${role.padEnd(7)} ${addr}   (fund >= ${sats.toLocaleString()} sats)`);
}
console.log('\nFaucets:');
console.log('  https://signet.bublina.eu.org/   (~10k/drip)');
console.log('  https://alt.signetfaucet.com/    (more generous)');
console.log('\nVerify funding:');
for (const [role, addr] of targets) console.log(`  ${role.padEnd(7)} https://mempool.space/signet/address/${addr}`);
console.log('\nThen run: node tests/axintent-onchain-e2e-signet.mjs && node tests/axintent-var-onchain-e2e-signet.mjs');
