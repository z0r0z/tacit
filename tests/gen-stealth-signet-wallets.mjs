// Generate two signet wallets (Alice = recipient, Bob = sender) for the
// stealth-payment round-trip test (tests/stealth-signet-e2e.mjs).
//
// Run once:  node tests/gen-stealth-signet-wallets.mjs
//
// Writes:
//   .local/stealth-signet-alice.json
//   .local/stealth-signet-bob.json
//
// Each file contains: { priv_hex, pub_hex, address, stealth_address }.
//
// Then fund Bob's `address` with signet sats (e.g., at signet.bublina.eu.org)
// before running the e2e test.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { encodeStealthAddress } from './stealth-primitives.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');

// bech32 (BIP-173) for classical signet P2WPKH (HRP = "tb").
const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function expandHrp(hrp) {
  const r = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >>> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}
function createChecksum(hrp, data, c) {
  const values = expandHrp(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const pm = polymod(values) ^ c;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((pm >>> (5 * (5 - i))) & 31);
  return out;
}
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}
function bech32SignetP2WPKH(pubkey) {
  const h = ripemd160(sha256(pubkey));
  const data = [0, ...convertBits(Array.from(h), 8, 5, true)];
  const checksum = createChecksum('tb', data, BECH32_CONST);
  return 'tb1' + [...data, ...checksum].map(v => ALPHABET[v]).join('');
}

function genWallet(label) {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = secp.getPublicKey(priv, true);
  const address = bech32SignetP2WPKH(pub);
  const stealth_address = encodeStealthAddress({ network: 'signet', recipientPub: pub });
  return {
    label,
    priv_hex: bytesToHex(priv),
    pub_hex: bytesToHex(pub),
    address,
    stealth_address,
  };
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const ALICE_FILE = path.join(STATE_DIR, 'stealth-signet-alice.json');
const BOB_FILE   = path.join(STATE_DIR, 'stealth-signet-bob.json');

function persistOrSkip(file, label) {
  if (existsSync(file)) {
    const w = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`✓ ${label} wallet exists at ${file}`);
    console.log(`    classical address: ${w.address}`);
    console.log(`    stealth address:   ${w.stealth_address}`);
    return w;
  }
  const w = genWallet(label);
  writeFileSync(file, JSON.stringify(w, null, 2));
  console.log(`✓ ${label} wallet generated → ${file}`);
  console.log(`    classical address: ${w.address}`);
  console.log(`    stealth address:   ${w.stealth_address}`);
  return w;
}

console.log(`\n=== Generating stealth signet wallets ===\n`);
const alice = persistOrSkip(ALICE_FILE, 'Alice (recipient)');
const bob   = persistOrSkip(BOB_FILE,   'Bob (sender)');

console.log(`\nNext steps:`);
console.log(`  1. Fund Bob's classical address with signet sats:`);
console.log(`       ${bob.address}`);
console.log(`     (e.g. via https://signet.bublina.eu.org/ — 20,000 sats is enough)`);
console.log(`  2. Run: node tests/stealth-signet-e2e.mjs`);
console.log();
