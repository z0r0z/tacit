#!/usr/bin/env node
// A real Bitcoin block (easy PoW) with a single Taproot-reveal tx, for testing
// bitcoin::verify_tx_in_block — the per-event confirmation the reflection prover runs
// before folding a Bitcoin deposit/spend into the pool / spent-set roots. Decoupled from
// bridge_mint, which (spec B5) proves a burn via spent-set membership, not a block.
//
// Run: node tests/gen-cxfer-btc-block-fixture.mjs > contracts/sp1/confidential/fixtures/btc_block.json

import { buildRevealTx, computeTxid, computeMerkleRoot, mineHeader } from './btc-mini.mjs';

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const envelope = Buffer.from('tacit reflection-prover confirmation test payload', 'utf8');
const tx = buildRevealTx(envelope);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

process.stdout.write(JSON.stringify({
  note: 'a real BTC block + reveal tx for bitcoin::verify_tx_in_block (reflection-prover confirmation)',
  header: hx(header),
  tx: hx(tx),
  txIndex: 0,
  txids: [hx(txid)],
}, null, 2) + '\n');
