#!/usr/bin/env node
/**
 * Broadcasts a T_BRIDGE_DEPOSIT OP_RETURN on signet for e2e testing.
 * Uses mock proof bytes since Sepolia has MockBurnVerifier.
 */
import { createHash, randomBytes } from 'crypto';

const SIGNET_PRIVKEY = '827aee3498ebbf5f4374387dc9937741ac87ec58a7a67c8091241d0797589222';
const MEMPOOL_API = 'https://mempool.space/signet/api';
const NETWORK_TAG = 0x01;
const ASSET_ID = 'f0bbe86800000000000000000000000000000000d1aa7194efe3e9a1ef1bde43';
const DENOM_WEI = '00000000000000000000000000000000000000000000000000038d7ea4c68000'; // 0.001 ETH

async function main() {
  console.log('=== Broadcast T_BRIDGE_DEPOSIT on Signet ===\n');

  // 1. Get UTXOs
  const ADDRESS = 'tb1qc0tjnm339uu89as6lhauegpc340m747n3jnsu5';
  const resp = await fetch(`${MEMPOOL_API}/address/${ADDRESS}/utxo`);
  const utxos = await resp.json();
  const confirmed = utxos.filter(u => u.status.confirmed);
  if (confirmed.length === 0) throw new Error('No confirmed UTXOs');

  const utxo = confirmed[0];
  console.log(`UTXO: ${utxo.txid}:${utxo.vout} = ${utxo.value} sats`);

  // 2. Build envelope (517 bytes: 261 header + 256 mock proof)
  const envelope = buildMintEnvelope();
  console.log(`Envelope: ${envelope.length} bytes`);
  console.log(`Envelope hex (first 80): ${Buffer.from(envelope).toString('hex').slice(0, 80)}...`);

  // 3. Build the OP_RETURN output script
  // OP_RETURN (0x6a) + OP_PUSHDATA2 (0x4d) + length LE + data
  const envLen = envelope.length;
  const opReturnScript = Buffer.concat([
    Buffer.from([0x6a, 0x4d, envLen & 0xff, (envLen >> 8) & 0xff]),
    envelope
  ]);

  // 4. Build raw transaction
  // We need secp256k1 signing — use the dApp's existing Bitcoin primitives
  // For this test, output the raw envelope for manual broadcast or use bitcoin-cli

  console.log('\n=== Transaction Details ===');
  console.log(`Input: ${utxo.txid}:${utxo.vout}`);
  console.log(`OP_RETURN script: ${opReturnScript.length} bytes`);
  console.log(`\nTo broadcast manually with bitcoin-cli (signet):`);
  console.log(`  1. Import key: bitcoin-cli -signet importprivkey <WIF>`);
  console.log(`  2. Create raw tx with OP_RETURN output`);

  // Output the envelope hex for the dApp to use
  console.log(`\n=== Envelope (full hex) ===`);
  console.log(Buffer.from(envelope).toString('hex'));

  // Also output as base64 for easier copy
  console.log(`\n=== For dApp broadcast ===`);
  console.log(`window.__TEST_MINT_ENVELOPE = '${Buffer.from(envelope).toString('hex')}';`);
}

function buildMintEnvelope() {
  const buf = Buffer.alloc(517);
  let o = 0;

  // opcode
  buf[o++] = 0x60; // T_BRIDGE_DEPOSIT

  // network_tag
  buf[o++] = NETWORK_TAG;

  // asset_id (32)
  Buffer.from(ASSET_ID, 'hex').copy(buf, o); o += 32;

  // denom_wei (32)
  Buffer.from(DENOM_WEI, 'hex').copy(buf, o); o += 32;

  // eth_root (32) — the Ethereum deposit tree root
  // For test: use a placeholder. The SP1 guest checks this against valid_deposit_roots.
  // Since we're using mock SP1 verifier, the exact value doesn't matter for the on-chain test.
  // But the SP1 guest execute would skip this if it doesn't match.
  const ethRoot = Buffer.alloc(32);
  ethRoot[31] = 0x01; // non-zero placeholder
  ethRoot.copy(buf, o); o += 32;

  // nullifier_hash (32)
  const nullifier = createHash('sha256').update(randomBytes(32)).digest();
  nullifier.copy(buf, o); o += 32;

  // recipient_commit (33)
  const recipCommit = Buffer.alloc(33);
  recipCommit[0] = 0x02; // compressed pubkey prefix
  recipCommit.copy(buf, o); o += 33;

  // leaf_hash (32) — the Poseidon commitment
  const leaf = createHash('sha256').update(randomBytes(32)).digest();
  leaf.copy(buf, o); o += 32;

  // r_leaf (32)
  const rLeaf = createHash('sha256').update(randomBytes(32)).digest();
  rLeaf.copy(buf, o); o += 32;

  // bind_hash (32) — would be computed from domain preimage
  const bindHash = Buffer.alloc(32);
  bindHash.copy(buf, o); o += 32;

  // proof_length (2 LE) = 256
  buf[o++] = 0x00;
  buf[o++] = 0x01;

  // proof (256 bytes) — mock zeros
  // proof bytes stay zero-filled

  console.log(`Built envelope: opcode=0x${buf[0].toString(16)} network=${buf[1]} offset=${o}`);
  return buf;
}

main().catch(console.error);
