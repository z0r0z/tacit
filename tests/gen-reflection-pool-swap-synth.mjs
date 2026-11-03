#!/usr/bin/env node
// Build a FULL-SCAN reflection prover input around the pool swap of tests/pool-swap-carrier.test.mjs: one block [coinbase, swap] whose
// swap is an atomic settlement at vin[0] (the desk's tracked note at vin[1] to the holder) with a shielded-pool spend carried on vin[2].
// The prior live set holds the desk's note. The pinned reflection guest must land on the JS assembler's newDigest (reflect-execute's
// DIGEST_MATCH), and the JS assembler is the one the swap test checks folds the holder's note; `bad` is the swap whose kernel does
// not conserve, which folds nothing.
//   SWAP_DUMP=/tmp/swap.json node tests/pool-swap-carrier.test.mjs
//   node tests/gen-reflection-pool-swap-synth.mjs /tmp/swap.json [swap|bad] > /tmp/pool-swap-reflect-input.json
//   REFLECT_ELF=contracts/sp1/confidential/elf/reflection-prover contracts/sp1/reflect-exec/target/release/reflect-execute /tmp/pool-swap-reflect-input.json

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { computeTxid, computeMerkleRoot, mineHeader, cat } from './btc-mini.mjs';

const [dumpPath, which = 'swap'] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const t = dump[which];
if (!t) throw new Error(`no ${which} in ${dumpPath}`);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha = (b) => sha256(sha256(b));
const rev = (h) => h.match(/../g).reverse().join('');
const hxs = (b) => '0x' + Buffer.from(b).toString('hex');
const BLOCK_HEIGHT = 970001;

const swap = Buffer.from(t.hex, 'hex');
const swapTxid = computeTxid(swap);
if (Buffer.from(swapTxid).reverse().toString('hex') !== t.txid) throw new Error('the dumped txid is not the bytes\'');

// Coinbase with a valid BIP141 witness commitment over [coinbase = 0, swap's wtxid].
const reserved = Buffer.alloc(32, 7);
const wcommit = dsha(cat([computeMerkleRoot([Buffer.alloc(32), dsha(swap)]), reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
  [0x01], [0x20], reserved, Buffer.alloc(4),
]);
const cbTxid = computeTxid(coinbase);
const header = mineHeader(computeMerkleRoot([cbTxid, swapTxid]));

// The prior state: the desk's note (value 0, blinding kIn) live under the asset, as the service holds it.
const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
const cp = ix.pool, st = ix.state();
st.setHeight(BLOCK_HEIGHT - 1);
const P = secp.ProjectivePoint.BASE.multiply(BigInt(dump.kIn)).toAffine();
const cx = '0x' + P.x.toString(16).padStart(64, '0'), cy = '0x' + P.y.toString(16).padStart(64, '0');
const deskOut = cp.outpointKey('0x' + rev(dump.deskLot), 0);
st.foldOutput(cp.leaf('0x' + dump.tac, cx, cy, '0x' + '00'.repeat(32)), deskOut, cp.commitmentHash(cx, cy), '0x' + dump.tac);
ix.coords().set(deskOut.toLowerCase(), { cx, cy });

const input = await ix.assembleBlocks([{ txs: [
  { txidDisplay: Buffer.from(cbTxid).reverse().toString('hex'), rawHex: Buffer.from(coinbase).toString('hex'), decode: null, vins: [] },
  { txidDisplay: t.txid, rawHex: t.hex, decode: classifyConfidentialTx('0x' + t.hex), vins: t.vins.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) },
] }], { headers: [hxs(header)], anchorHeight: BLOCK_HEIGHT });

const s = input.blocks[0].txs[1];
console.error(`pool swap (${which}): folded=${s.outputs.length} spends=${s.openings.length} newDigest=${input.newDigest}`);
console.log(JSON.stringify(input));
