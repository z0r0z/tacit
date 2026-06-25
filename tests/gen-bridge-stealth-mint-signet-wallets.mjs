// Generate the two wallets for the OP_BRIDGE_STEALTH_MINT signet rehearsal
// (tests/bridge-stealth-mint-signet-e2e.mjs): a SENDER (burns a note on Bitcoin) and a RECIPIENT
// (receives the cross-chain confidential pay into the stealth lock-set under a one-time pubkey).
//
// Run once:  node tests/gen-bridge-stealth-mint-signet-wallets.mjs
// Writes:    .local/bridge-stealth-mint-wallets.json
//            { sender:{priv_hex,pub_hex,address}, recipient:{priv_hex,spend_pub_hex} }
// Then fund the sender `address` with signet sats before the live run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as secp from '../node_modules/@noble/secp256k1/index.js';

const bytesToHex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ripemd160 = (b) => new Uint8Array(createHash('ripemd160').update(Buffer.from(b)).digest());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const OUT = path.join(STATE_DIR, 'bridge-stealth-mint-wallets.json');

// Compact bech32 (BIP-173) signet P2WPKH (HRP "tb", witver 0) — funding address for the sender.
const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (v) => { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; } return c; };
const hrpExpand = (h) => { const r = []; for (let i = 0; i < h.length; i++) r.push(h.charCodeAt(i) >>> 5); r.push(0); for (let i = 0; i < h.length; i++) r.push(h.charCodeAt(i) & 31); return r; };
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
  if (pad && bits) out.push((acc << (to - bits)) & max);
  return out;
}
function bech32P2WPKH(pub) {
  const program = ripemd160(sha256(pub)); // 20-byte witness program
  const data = [0, ...convertBits([...program], 8, 5, true)];
  const values = [...hrpExpand('tb'), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = []; for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return 'tb1' + [...data, ...checksum].map((x) => ALPHABET[x]).join('');
}

if (existsSync(OUT)) { console.log(`exists: ${OUT} (delete to regenerate)`); process.exit(0); }
mkdirSync(STATE_DIR, { recursive: true });

const senderPriv = secp.utils.randomPrivateKey();
const senderPub = secp.getPublicKey(senderPriv, true);
const recipientPriv = secp.utils.randomPrivateKey();
const recipientSpendPub = secp.getPublicKey(recipientPriv, true); // the recipient's STATIC published spend pubkey

const wallets = {
  sender: { priv_hex: bytesToHex(senderPriv), pub_hex: bytesToHex(senderPub), address: bech32P2WPKH(senderPub) },
  recipient: { priv_hex: bytesToHex(recipientPriv), spend_pub_hex: bytesToHex(recipientSpendPub) },
};
writeFileSync(OUT, JSON.stringify(wallets, null, 2));
console.log(`wrote ${OUT}`);
console.log(`  sender address (fund with signet sats): ${wallets.sender.address}`);
console.log(`  recipient spend pub:                    ${wallets.recipient.spend_pub_hex}`);
console.log(`\nNEXT: fund the sender, then: node tests/bridge-stealth-mint-signet-e2e.mjs`);
