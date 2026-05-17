// One-shot generator for the cBTC.tac signet smoke-test wallets.
// Produces .local/cbtc-tac-signet-test-wallets.json with two fresh
// privkeys + bech32 P2WPKH addresses (depositor + recipient).
//
// Run once:  node tests/gen-cbtc-tac-signet-wallets.mjs
// Re-running OVERWRITES the file — guard intent before invoking.

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
const OUT_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-test-wallets.json');

if (existsSync(OUT_FILE)) {
  const existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  console.log(`File already exists at ${OUT_FILE} — reusing.`);
  console.log(JSON.stringify(existing, null, 2));
  process.exit(0);
}

function makeWallet(role) {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  // Use the dapp's wallet singleton to derive the address — guarantees
  // byte-for-byte parity with what the dapp itself produces when this
  // privkey is loaded.
  dapp.wallet.priv = priv;
  dapp.wallet.pub = pub;
  const address = dapp.wallet.address();
  return { role, priv_hex: bytesToHex(priv), pub_hex: bytesToHex(pub), address };
}

const depositor = makeWallet('depositor');
const recipient = makeWallet('recipient');

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const out = {
  network: 'signet',
  generated_at: new Date().toISOString(),
  depositor,
  recipient,
  notes: [
    'cBTC.tac smoke test (SPEC-CBTC-TAC-AMENDMENT §§5.36–5.37).',
    'depositor needs: ~200k signet sats for slot mint + deposit/withdraw fees',
    '                 PLUS an existing TAC-like tacit asset UTXO of ≥5_000 base units',
    '                 (CETCH a throwaway token first via dapp UI on signet).',
    'recipient needs: ~10k signet sats for incoming-transfer dust + fees (optional).',
    'Faucets: https://signet.bublina.eu.org/  or  https://alt.signetfaucet.com/',
    'These priv keys are stored in .local/ only. DO NOT COMMIT.',
  ],
};
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT_FILE}\n`);
console.log(`depositor: ${depositor.address}`);
console.log(`recipient: ${recipient.address}`);
