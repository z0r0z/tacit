// The burn-deposit assembler's merkle-path builder must agree with compute_merkle_root (btc-mini, == the
// guest's) and verify_merkle_path (the guest mirror, dapp/burn-deposit-provenance.js) for real multi-tx
// blocks — the generator only exercises single-tx blocks (empty paths), but the worker assembles witnesses
// for txs at arbitrary positions in full blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeBurnDepositAssembler } from '../dapp/burn-deposit-assembler.js';
import { makeBurnDepositProvenance } from '../dapp/burn-deposit-provenance.js';
import { computeMerkleRoot, dsha256, cat } from './btc-mini.mjs';

const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
const strip = (h) => h.replace(/^0x/, '');
const asm = makeBurnDepositAssembler({ dsha256, cat, bytesToHex });
const mk = makeBurnDepositProvenance({ sha256: nobleSha256 });

test('merkle path builder agrees with computeMerkleRoot + verifyMerklePath across block sizes', () => {
  for (const n of [1, 2, 3, 4, 5, 8, 13]) {
    const txids = Array.from({ length: n }, (_, i) => Uint8Array.from(Buffer.alloc(32, i + 1)));
    const root = strip(bytesToHex(computeMerkleRoot(txids)));
    assert.equal(strip(asm.merkleRoot(txids)), root, `merkleRoot n=${n}`);
    for (let i = 0; i < n; i++) {
      const sibs = asm.merkleSiblings(txids, i);
      // verify_merkle_path(txid, siblings, index) reconstructs the root from the leaf — the guest's check.
      assert.equal(strip(mk.verifyMerklePath(bytesToHex(txids[i]), sibs, i)), root, `path n=${n} i=${i}`);
    }
  }
});

test('BIP141 paths use the zero coinbase wtxid and the txid-tree coinbase leaf', () => {
  const txids = [1, 2, 3].map((x) => Uint8Array.from(Buffer.alloc(32, x)));
  const wtxids = [9, 8, 7].map((x) => Uint8Array.from(Buffer.alloc(32, x)));
  const got = asm.witnessPath({ blockTxids: txids, blockWtxids: wtxids, coinbase: '0x00', index: 2 }, 'kat');
  const zero = new Uint8Array(32);
  assert.equal(
    strip(mk.verifyMerklePath(bytesToHex(wtxids[2]), got.wtxidSiblings, 2)),
    strip(asm.merkleRoot([zero, wtxids[1], wtxids[2]])),
  );
  assert.equal(
    strip(mk.verifyMerklePath(bytesToHex(txids[0]), got.coinbaseTxidSiblings, 0)),
    strip(asm.merkleRoot(txids)),
  );
  assert.throws(() => asm.witnessPath({ blockTxids: txids, blockWtxids: wtxids, coinbase: '0x00', index: 0 }, 'kat'));
});
