#!/usr/bin/env node
// OP_CBTC_MINT witness: mint a cBTC.zk bearer note against a reflection-recorded self-custody Bitcoin lock,
// now with a RELAY FEE leg (gasless auto-mint). The bearer note opens to v_btc − fee (owner-free; control is
// the blinding r), the settler is paid `fee` in cBTC, total = v_btc (exact 1:1 backing). fee = 0 ⇒ self-mint.
// Run: node tests/gen-confidential-cbtcmint-fixture.mjs > contracts/sp1/confidential/fixtures/cbtc_mint_op.json
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const CBTC_ZK_ASSET_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
const ZERO_OWNER = '0x' + '00'.repeat(32);
const CHAIN_BINDING = '0x' + '00'.repeat(32);

const OUTPOINT = '0x' + 'be'.repeat(32); // the Bitcoin lock outpoint
const V_BTC = 100000n;                    // locked sats
const FEE = BigInt(process.env.FEE || '0');
const net = V_BTC - FEE;
if (net <= 0n) throw new Error('fee >= v_btc');
const blinding = randomScalar();
const { cx, cy } = pool.commitXY(net, beHex(blinding)); // note pre-committed to v_btc − fee

const ctx = pool.intentContext('tacit-cbtc-mint-intent-v1', CHAIN_BINDING, CBTC_ZK_ASSET_ID, OUTPOINT,
  [[cx, cy, ZERO_OWNER]], [V_BTC, FEE]);
const sig = pool.openingSigma(net, beHex(blinding), ctx, pool.deriveOpeningNonce(beHex(blinding), ctx, 'cbtc-mint'));
if (!pool.verifyOpeningSigma(cx, cy, net, sig.R, sig.z, ctx)) throw new Error('cbtc sigma self-verify failed');

process.stdout.write(JSON.stringify({
  note: 'OP_CBTC_MINT: mint cBTC against a Bitcoin lock, with a relay-fee leg (note opens to v_btc − fee)',
  op: 'cbtcmint',
  chainBinding: CHAIN_BINDING,
  outpoint: OUTPOINT,
  vBtc: Number(V_BTC),
  fee: Number(FEE),
  cx, cy,
  sigR: sig.R, sigZ: sig.z,
}, null, 2) + '\n');
