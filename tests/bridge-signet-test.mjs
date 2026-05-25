#!/usr/bin/env node
/**
 * tETH Bridge signet test — broadcasts a T_BRIDGE_DEPOSIT OP_RETURN
 * for the test deposit already made on Sepolia.
 *
 * This is a simplified test that uses mock proofs (the Sepolia deployment
 * uses MockBurnVerifier which accepts any proof). The real flow would
 * generate a Groth16 proof via snarkjs.
 *
 * Usage: node tests/bridge-signet-test.mjs
 */

const SIGNET_PRIVKEY = '827aee3498ebbf5f4374387dc9937741ac87ec58a7a67c8091241d0797589222';
const SIGNET_ADDRESS = 'tb1qc0tjnm339uu89as6lhauegpc340m747n3jnsu5';
const MEMPOOL_API = 'https://mempool.space/signet/api';

const SEPOLIA_MIXER = '0x7C00A01C1cA94055b6EF3D7e25fb8424D29949F0';
const ASSET_ID = 'f0bbe86800000000000000000000000000000000d1aa7194efe3e9a1ef1bde43';
const NETWORK_TAG = 0x01; // signet
const DENOM_WEI = '00000000000000000000000000000000000000000000000000038d7ea4c68000'; // 0.001 ETH

async function main() {
  console.log('=== tETH Bridge Signet Test ===');
  console.log(`Address: ${SIGNET_ADDRESS}`);
  console.log(`Mixer: ${SEPOLIA_MIXER}`);
  console.log('');

  // Check UTXOs
  const utxoResp = await fetch(`${MEMPOOL_API}/address/${SIGNET_ADDRESS}/utxo`);
  const utxos = await utxoResp.json();
  const confirmed = utxos.filter(u => u.status.confirmed);
  console.log(`UTXOs: ${utxos.length} total, ${confirmed.length} confirmed`);

  if (confirmed.length === 0) {
    console.log('Waiting for UTXO confirmation...');
    console.log('Signet blocks take ~10 minutes. Re-run after confirmation.');
    return;
  }

  const utxo = confirmed[0];
  console.log(`Using UTXO: ${utxo.txid}:${utxo.vout} (${utxo.value} sats)`);

  // Build a minimal T_BRIDGE_DEPOSIT envelope
  // For testnet with mock verifiers, the proof can be zeros
  const envelope = buildTestDepositEnvelope();
  console.log(`Envelope: ${envelope.length} bytes`);

  // Build OP_RETURN transaction
  // This is a simplified tx builder for the test
  console.log('');
  console.log('Envelope hex (first 100 chars):');
  console.log(Buffer.from(envelope).toString('hex').slice(0, 100) + '...');
  console.log('');
  console.log('To broadcast, the dApp would build a Bitcoin tx with:');
  console.log('  - Input: the confirmed UTXO');
  console.log('  - Output 1: OP_RETURN with envelope');
  console.log('  - Output 2: change back to sender');
  console.log('');
  console.log('For full e2e test, use the dApp\'s buildAndBroadcastBridgeDeposit()');
}

function buildTestDepositEnvelope() {
  // T_BRIDGE_DEPOSIT format per spec §5.60.1
  const buf = new Uint8Array(517); // 261 header + 256 mock proof
  let o = 0;
  buf[o++] = 0x60; // opcode
  buf[o++] = NETWORK_TAG;
  // asset_id (32)
  const aid = hexToBytes(ASSET_ID);
  buf.set(aid, o); o += 32;
  // denom_wei (32)
  const denom = hexToBytes(DENOM_WEI);
  buf.set(denom, o); o += 32;
  // eth_root (32) — placeholder, would be real Ethereum tree root
  o += 32;
  // nullifier_hash (32) — placeholder
  buf[o + 31] = 0x01; o += 32;
  // recipient_commit (33) — placeholder
  o += 33;
  // leaf_hash (32) — placeholder
  buf[o + 31] = 0x42; o += 32;
  // r_leaf (32) — placeholder
  o += 32;
  // bind_hash (32) — placeholder (mock verifier accepts anything)
  o += 32;
  // proof_length (2 LE)
  buf[o++] = 0x00; buf[o++] = 0x01; // 256 bytes
  // proof (256) — zeros (mock verifier accepts)
  // already zero-filled
  return buf;
}

function hexToBytes(hex) {
  hex = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

main().catch(console.error);
