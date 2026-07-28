// Pin the bridge-burn identity across the guest (cxfer-core bridge_burn_id) and the JS assembler
// (dapp/confidential-pool.js bridgeBurnId). The reflection guest keys the burn accumulator by burn_id, so if the
// assembler's byte layout drifts from the guest's by even one field, the reflected/burn-deposit bridge fold
// records the wrong key and the first bridge burn halts reflection (the mint can never reproduce the id). The
// guest's own Rust KAT (bridge_burn_id_kat in lib.rs) pins it to fixed digests; this test recomputes them from
// the REAL assembler function on the SAME inputs and asserts it reproduces the digests parsed out of lib.rs.
//   node tests/bridge-burn-id-pin.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

// The two digests the guest KAT pins, read straight out of the Rust source (order: reflected then deposit).
const RUST = readFileSync(join(REPO, 'contracts/sp1/confidential/cxfer-core/src/lib.rs'), 'utf8');
const at = RUST.indexOf('fn bridge_burn_id_kat()');
if (at < 0) throw new Error('no bridge_burn_id_kat in lib.rs');
const digs = [...RUST.slice(at).matchAll(/"([0-9a-f]{64})"/g)].map((m) => m[1]);
if (digs.length < 2) throw new Error('bridge_burn_id_kat: expected 2 pinned digests');
const [guestReflected, guestDeposit] = digs;

// The SAME fixed inputs the Rust KAT uses.
const rep = (b) => '0x' + Buffer.alloc(32, b).toString('hex');
const cx = rep(0x11), cy = rep(0x22), x = rep(0xA0), kv = rep(0xC0), txid = rep(0x33), tgt = rep(0x7c);
const ZERO = '0x' + '00'.repeat(32);

let pass = 0, fail = 0;
const pin = (label, guest, actual) => {
  if (guest === actual) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n        guest: ${guest}\n        got:   ${actual}`); fail++; }
};

// BURN_SOURCE_REFLECTED = 1 over the note's full btc_note_leaf(asset,Cx,Cy,auth_key), target-scoped (C-01).
pin('reflected burn_id == guest', guestReflected, pool.bridgeBurnId(1, txid, 0, pool.btcNoteLeaf(x, cx, cy, kv), tgt).replace(/^0x/, ''));
// BURN_SOURCE_DEPOSIT = 2 over the native leaf(asset,Cx,Cy,0), target-scoped.
pin('deposit burn_id == guest', guestDeposit, pool.bridgeBurnId(2, txid, 0, pool.leaf(x, cx, cy, ZERO), tgt).replace(/^0x/, ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
