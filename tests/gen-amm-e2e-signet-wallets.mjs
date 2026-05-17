// 3-wallet generator for the full AMM end-to-end signet harness
// (tests/amm-full-e2e-signet.mjs).
//
// Roles:
//   founder  — CETCHes asset_A + asset_B, POOL_INIT across fee tiers,
//              slot mints for cBTC.zk/cBTC.tac side, claims T_PROTOCOL_FEE_CLAIM.
//   lp       — LP_ADD variant 0 to each pool, LP_REMOVE round-trip.
//              Receives a CXFER of asset_A/asset_B from founder before adding.
//   trader   — Single-hop + 2-hop multihop swaps via the router; their swap
//              fees accrue to the founder's protocol-fee bucket.
//
// Run once:  node tests/gen-amm-e2e-signet-wallets.mjs
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
const OUT_FILE = path.join(STATE_DIR, 'amm-e2e-signet-wallets.json');

if (existsSync(OUT_FILE)) {
  const existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  console.log(`File already exists at ${OUT_FILE} — reusing (NOT overwriting).\n`);
  for (const role of ['founder', 'lp', 'trader']) {
    const w = existing[role];
    console.log(`  ${role.padEnd(8)} ${w.address}   (fund ≥ ${w.target_sats.toLocaleString()} sats)`);
  }
  console.log(`\nFaucets:`);
  console.log(`  https://signet.bublina.eu.org/      (~10k sats/drip)`);
  console.log(`  https://alt.signetfaucet.com/       (more generous)`);
  console.log(`\nVerify funding at:`);
  for (const role of ['founder', 'lp', 'trader']) {
    console.log(`  ${role.padEnd(8)} https://mempool.space/signet/address/${existing[role].address}`);
  }
  console.log(`\nThen run: node tests/amm-full-e2e-signet.mjs`);
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

const founder = makeWallet(
  'founder',
  300_000,
  'CETCH asset_A + asset_B, POOL_INIT × 4 pools across fee tiers (5/30/100 bps + cBTC pools), slot mints, T_PROTOCOL_FEE_CLAIM',
);
const lp = makeWallet(
  'lp',
  200_000,
  'LP_ADD variant 0 across all pools, LP_REMOVE round-trip; receives asset_A/asset_B via CXFER from founder',
);
const trader = makeWallet(
  'trader',
  200_000,
  'Single-hop + 2-hop multihop swaps via router; swap fees accrue to founder',
);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const out = {
  network: 'signet',
  generated_at: new Date().toISOString(),
  founder,
  lp,
  trader,
  notes: [
    'Full AMM end-to-end signet harness wallets.',
    'Coverage: fee tiers 5/30/100 bps, capability_flags=0x01 reject test,',
    'multihop swap via router, cBTC.zk + cBTC.tac pools, LP add/remove,',
    'protocol-fee claim across parties.',
    '',
    'Fund each address to its target_sats minimum before running the harness.',
    'Total: ~700,000 signet sats across 3 addresses.',
    '',
    'Faucets:',
    '  https://signet.bublina.eu.org/      (~10k sats/drip)',
    '  https://alt.signetfaucet.com/       (more generous)',
    '',
    'These priv keys are stored in .local/ only. DO NOT COMMIT.',
  ],
};
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

console.log(`\n=== AMM full e2e signet wallets generated ===\n`);
console.log(`  Saved to: ${OUT_FILE}\n`);
console.log(`Fund each address to its target minimum:\n`);
for (const w of [founder, lp, trader]) {
  console.log(`  ${w.role.padEnd(8)} ${w.address}`);
  console.log(`           target: ≥ ${w.target_sats.toLocaleString()} sats`);
  console.log(`           role:   ${w.purpose}`);
  console.log(``);
}
console.log(`Total funding needed: ~${(founder.target_sats + lp.target_sats + trader.target_sats).toLocaleString()} signet sats.\n`);
console.log(`Faucets:`);
console.log(`  https://signet.bublina.eu.org/      (~10k sats/drip; needs Twitter/captcha)`);
console.log(`  https://alt.signetfaucet.com/       (more generous; may rate-limit per /24)`);
console.log(``);
console.log(`Verify funding:`);
for (const w of [founder, lp, trader]) {
  console.log(`  https://mempool.space/signet/address/${w.address}`);
}
console.log(``);
console.log(`Then run:  node tests/amm-full-e2e-signet.mjs`);
console.log(``);
