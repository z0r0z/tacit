#!/usr/bin/env node
// Build a FULL-SCAN reflection prover input from transactions a test kept (DUMP=<file>): one block [coinbase, ...txs] with a valid BIP141
// witness commitment and an easy header, over a prior live set holding the dump's `live` notes (value `amount`, 0 if none, blinding k). The pinned
// reflection guest (reflect-execute) must land on the JS assembler's newDigest.
//   DUMP=/tmp/d.json node tests/btc-swap-lock-reflect.test.mjs
//   node tests/gen-reflection-dump-synth.mjs /tmp/d.json swap > /tmp/in.json
//   REFLECT_ELF=contracts/sp1/confidential/elf/reflection-prover contracts/sp1/reflect-exec/target/release/reflect-execute /tmp/in.json

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { computeTxid, computeMerkleRoot, mineHeader, cat } from './btc-mini.mjs';
import { pedersenCommit } from '../dapp/bulletproofs.js';

const [dumpPath, which] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const set = dump[which];
if (!set) throw new Error(`no ${which} in ${dumpPath}`);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha = (b) => sha256(sha256(b));
const rev = (h) => h.match(/../g).reverse().join('');
const hxs = (b) => '0x' + Buffer.from(b).toString('hex');
const BLOCK_HEIGHT = 970001;

const raws = set.txs.map((t) => Buffer.from(t.hex, 'hex'));
const ids = raws.map(computeTxid);
set.txs.forEach((t, i) => { if (Buffer.from(ids[i]).reverse().toString('hex') !== t.txid) throw new Error(`tx ${i}: the kept txid is not its bytes'`); });
const reserved = Buffer.alloc(32, 7);
const wcommit = dsha(cat([computeMerkleRoot([Buffer.alloc(32), ...raws.map(dsha)]), reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
  [0x01], [0x20], reserved, Buffer.alloc(4),
]);
const cbTxid = computeTxid(coinbase);
const header = mineHeader(computeMerkleRoot([cbTxid, ...ids]));

const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
const cp = ix.pool, st = ix.state();
st.setHeight(BLOCK_HEIGHT - 1);
for (const n of set.live) {
  const P = (n.amount ? pedersenCommit(BigInt(n.amount), BigInt(n.k)) : secp.ProjectivePoint.BASE.multiply(BigInt(n.k))).toAffine();
  const cx = '0x' + P.x.toString(16).padStart(64, '0'), cy = '0x' + P.y.toString(16).padStart(64, '0');
  const key = cp.outpointKey('0x' + rev(n.txid), n.vout);
  st.foldOutput(cp.leaf('0x' + dump.tac, cx, cy, '0x' + '00'.repeat(32)), key, cp.commitmentHash(cx, cy), '0x' + dump.tac);
  ix.coords().set(key.toLowerCase(), { cx, cy });
}
const input = await ix.assembleBlocks([{ txs: [
  { txidDisplay: Buffer.from(cbTxid).reverse().toString('hex'), rawHex: Buffer.from(coinbase).toString('hex'), decode: null, vins: [] },
  ...set.txs.map((t) => ({ txidDisplay: t.txid, rawHex: t.hex, decode: classifyConfidentialTx('0x' + t.hex), vins: t.vins.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) })),
] }], { headers: [hxs(header)], anchorHeight: BLOCK_HEIGHT });

console.error(`${which}: folded=${input.blocks[0].txs.slice(1).map((t) => t.outputs.length).join(',')} newDigest=${input.newDigest}`);
console.log(JSON.stringify(input));
