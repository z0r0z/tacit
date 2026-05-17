// One-shot generator for the T_CXFER_BPP signet smoke-test wallets.
// Produces .local/cxfer-bpp-signet-test-wallets.json with two fresh
// privkeys + bech32 P2WPKH addresses (sender + recipient).
//
// Run once:  node tests/gen-cxfer-bpp-signet-wallets.mjs
// Re-running prints the existing file rather than overwriting; delete
// the file first if you intentionally want fresh keys.

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
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const OUT_FILE = path.join(STATE_DIR, 'cxfer-bpp-signet-test-wallets.json');

if (existsSync(OUT_FILE)) {
  const existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  console.log(`File already exists at ${OUT_FILE} — reusing.`);
  console.log(JSON.stringify(existing, null, 2));
  process.exit(0);
}

function makeWallet(role) {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  dapp.wallet.priv = priv;
  dapp.wallet.pub = pub;
  const address = dapp.wallet.address();
  return { role, priv_hex: bytesToHex(priv), pub_hex: bytesToHex(pub), address };
}

const sender    = makeWallet('sender');
const recipient = makeWallet('recipient');

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const out = {
  network: 'signet',
  generated_at: new Date().toISOString(),
  sender,
  recipient,
  notes: [
    'T_CXFER_BPP signet smoke (SPEC-CXFER-BPP-AMENDMENT §5.47).',
    'sender    needs: ~150k signet sats for CETCH + 3 follow-on transfers',
    '                 (CETCH, T_CXFER_BPP send, T_CXFER reverse, T_CXFER_BPP again)',
    'recipient needs: ~30k  signet sats for sending the asset back',
    'Faucets: https://signet.bublina.eu.org/  or  https://alt.signetfaucet.com/',
    'These priv keys are stored in .local/ only. DO NOT COMMIT.',
  ],
};
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT_FILE}\n`);
console.log(`sender:    ${sender.address}`);
console.log(`recipient: ${recipient.address}`);
console.log(`\nFund both addresses on signet, then run:`);
console.log(`  node tests/cxfer-bpp-onchain-e2e-signet.mjs`);
