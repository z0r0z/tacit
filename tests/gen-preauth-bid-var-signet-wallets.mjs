// Wallet generator for the T_PREAUTH_BID_VAR signet e2e harness
// (tests/preauth-bid-var-onchain-e2e-signet.mjs).
//
// Roles:
//   seller   — Auto-etches a small test asset (1000 base units), then
//              fills the buyer's preauth-bid-var via takePreauthBidVar
//              at a chosen ratio (commit + reveal with refund vout when
//              fill_amount < max_fill).
//              Needs sats for: CETCH commit/reveal fees (~5k) + take
//              commit fee (~1k) + buffer.
//   buyer    — Publishes the preauth-bid-var via publishPreauthBidVar,
//              which broadcasts a pre-fund split tx sized for
//              max_fill × price_per_unit + DUST + max_fee_budget. Funding
//              UTXO is the largest of the family because it must cover
//              the full bid (vs §5.7.11 where it covers the lot price).
//
// Run once:  node tests/gen-preauth-bid-var-signet-wallets.mjs
// Re-running prints existing wallets (idempotent — does NOT overwrite).

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
const OUT_FILE = path.join(STATE_DIR, 'preauth-bid-var-signet-wallets.json');

if (existsSync(OUT_FILE)) {
  const existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  console.log(`File already exists at ${OUT_FILE} — reusing (NOT overwriting).\n`);
  for (const role of ['seller', 'buyer']) {
    const w = existing[role];
    console.log(`  ${role.padEnd(8)} ${w.address}   (fund ≥ ${w.target_sats.toLocaleString()} sats)`);
  }
  console.log(`\nFaucets:`);
  console.log(`  https://signet.bublina.eu.org/      (~10k sats/drip)`);
  console.log(`  https://alt.signetfaucet.com/       (more generous)`);
  console.log(`\nVerify funding at:`);
  for (const role of ['seller', 'buyer']) {
    console.log(`  ${role.padEnd(8)} https://mempool.space/signet/address/${existing[role].address}`);
  }
  console.log(`\nThen run: node tests/preauth-bid-var-onchain-e2e-signet.mjs`);
  process.exit(0);
}

function makeWallet(role, target_sats, purpose) {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  dapp.wallet.priv = priv;
  dapp.wallet.pub = pub;
  const address = dapp.wallet.address();
  return {
    role,
    priv_hex: bytesToHex(priv),
    pub_hex: bytesToHex(pub),
    address,
    target_sats,
    purpose,
  };
}

const seller = makeWallet(
  'seller',
  80_000,
  'Auto-etches a test asset, then takes the buyer\'s preauth-bid-var at a chosen ratio (commit + reveal with refund vout)',
);
// Buyer needs more sats than the §5.7.11 path because the funding UTXO
// covers max_fill × price_per_unit (worst-case fill), not just one lot.
// At a test config like maxFill=1000 × price=10 sat/token = 10k base +
// DUST + max_fee_budget ≈ 11.5k, plus split-tx fee ≈ 200, plus buffer
// for re-runs / a few harness retries. 100k signet sats is comfortable.
const buyer = makeWallet(
  'buyer',
  100_000,
  'Publishes preauth-bid-var (broadcasts pre-fund split tx sized to max_fill × price_per_unit + DUST + max_fee_budget; K ECDSA pre-sigs over BIP-143)',
);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const out = {
  network: 'signet',
  generated_at: new Date().toISOString(),
  seller,
  buyer,
  notes: [
    'T_PREAUTH_BID_VAR end-to-end signet harness wallets (SPEC §5.7.12).',
    'Coverage: publishPreauthBidVar → fetch bid → takePreauthBidVar at a',
    '  chosen fill_amount → reveal confirms with refund vout enforced.',
    '',
    'The harness exercises:',
    '  • K-signature batch verify on /preauth-bids-var POST',
    '  • Per-ratio sighash + selection at take time',
    '  • Indexer-enforced refund vout (validator rule 7)',
    '  • Chain-only buyer recovery via scanHoldings T_PREAUTH_BID_VAR branch',
    '  • K=1 degenerate (fill_amount == max_fill, skip-refund path)',
    '  • Partial-fill (fill_amount < max_fill, refund vout REQUIRED)',
    '',
    'Fund each address to its target_sats minimum before running the harness.',
    'Total: ~180,000 signet sats across 2 addresses.',
    '',
    'Faucets:',
    '  https://signet.bublina.eu.org/      (~10k sats/drip)',
    '  https://alt.signetfaucet.com/       (more generous)',
    '',
    'These priv keys are stored in .local/ only. DO NOT COMMIT.',
  ],
};
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

console.log(`\n=== T_PREAUTH_BID_VAR signet e2e wallets generated ===\n`);
console.log(`  Saved to: ${OUT_FILE}\n`);
console.log(`Fund each address to its target minimum:\n`);
for (const w of [seller, buyer]) {
  console.log(`  ${w.role.padEnd(8)} ${w.address}`);
  console.log(`           target: ≥ ${w.target_sats.toLocaleString()} sats`);
  console.log(`           role:   ${w.purpose}`);
  console.log(``);
}
console.log(`Total funding needed: ~${(seller.target_sats + buyer.target_sats).toLocaleString()} signet sats.\n`);
console.log(`Faucets:`);
console.log(`  https://signet.bublina.eu.org/      (~10k sats/drip; needs Twitter/captcha)`);
console.log(`  https://alt.signetfaucet.com/       (more generous; may rate-limit per /24)`);
console.log(``);
console.log(`Verify funding:`);
for (const w of [seller, buyer]) {
  console.log(`  https://mempool.space/signet/address/${w.address}`);
}
console.log(``);
console.log(`Then run:  node tests/preauth-bid-var-onchain-e2e-signet.mjs`);
console.log(``);
