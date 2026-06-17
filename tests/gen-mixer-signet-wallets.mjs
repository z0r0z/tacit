// One-shot generator for the Tacit mixer (T_DEPOSIT 0x29 / T_WITHDRAW 0x2A)
// signet end-to-end test wallets. Produces .local/mixer-signet-test-wallets.json
// with two fresh privkeys + bech32 P2WPKH signet addresses:
//   depositor  — CETCHes a test asset, runs POOL_INIT + T_DEPOSIT, pays fees
//   withdrawer — fresh wallet that receives the anonymized T_WITHDRAW output
//                (kept unlinkable from the depositor; this is the whole point)
//
// Run once:  node tests/gen-mixer-signet-wallets.mjs
// Re-running prints the existing file rather than overwriting; delete the file
// first if you intentionally want fresh keys.

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
const OUT_FILE = path.join(STATE_DIR, 'mixer-signet-test-wallets.json');

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

const depositor  = makeWallet('depositor');
const withdrawer = makeWallet('withdrawer');

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const out = {
  network: 'signet',
  generated_at: new Date().toISOString(),
  depositor,
  withdrawer,
  notes: [
    'Tacit mixer signet e2e (SPEC §5.10 / §5.11).',
    'depositor  needs: ~200k signet sats — CETCH (commit+reveal), POOL_INIT,',
    '                  one or more T_DEPOSIT at the chosen denomination, fees.',
    'withdrawer needs: ~20k signet sats only if you want to re-spend the',
    '                  withdrawn UTXO afterwards (the withdraw itself is funded',
    '                  by the depositor side broadcasting the T_WITHDRAW tx).',
    'Faucets: https://signet.bublina.eu.org/  or  https://alt.signetfaucet.com/',
    'These priv keys are stored in .local/ only. DO NOT COMMIT.',
  ],
};
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT_FILE}\n`);
console.log(`depositor:  ${depositor.address}`);
console.log(`withdrawer: ${withdrawer.address}`);
