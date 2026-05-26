#!/usr/bin/env node
/**
 * tETH Bridge Sepolia ↔ Signet E2E test.
 *
 * Tests the full round-trip:
 *   Phase 1: Fetch Sepolia deposits, identify unminted, mint on signet
 *   Phase 2: Burn a previously-minted tETH leaf on signet
 *   Phase 3: (manual) withdrawFromBurn on Sepolia after 6 confirmations
 *
 * Mock-verifier deployment: proofs can be zeros; the SP1 and Groth16
 * verifiers on Sepolia accept anything.
 *
 * Usage:
 *   node tests/bridge-sepolia-signet-e2e.mjs [--mint | --burn | --status]
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { keccak_256 } from '@noble/hashes/sha3';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import { randomBytes } from 'crypto';

// ─── Config ────────────────────────────────────────────────────────
const SIGNET_PRIVKEY = process.env.SIGNET_PRIVKEY || '827aee3498ebbf5f4374387dc9937741ac87ec58a7a67c8091241d0797589222';
const MEMPOOL_API    = 'https://mempool.space/signet/api';
const WORKER_API     = process.env.WORKER_API || 'https://tacit-pin.rosscampbell9.workers.dev';
const SEPOLIA_RPC    = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const NETWORK_TAG    = 0x01;

const MIXER_ADDRESS  = '0x13124e519C9C11Ef200Fc4C36ed5a7010750f00e';
const ASSET_ID_HEX   = 'd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b';
const DENOM_WEI      = 1000000000000000n; // 0.001 ETH
const DENOM_WEI_HEX  = '00000000000000000000000000000000000000000000000000038d7ea4c68000';
const DEPLOY_BLOCK   = '0xa6a6e0';
const DEPOSIT_TOPIC  = null; // computed lazily

const T_BRIDGE_DEPOSIT = 0x60;
const T_BRIDGE_BURN    = 0x61;

// ─── Helpers ───────────────────────────────────────────────────────
function hex(b) { return Buffer.from(b).toString('hex'); }
function unhex(s) { return Buffer.from(s.replace(/^0x/, ''), 'hex'); }
function sha256d(data) { return sha256(sha256(data)); }
function hash160(data) { return ripemd160(sha256(data)); }
function compressedPubkey(privHex) { return secp.getPublicKey(privHex, true); }

function writeVarInt(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}
function writeU32LE(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function writeU64LE(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

function bigintToBytes32(v) {
  const buf = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}
function bytes32ToBigint(b) {
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}

function keccak256(data) {
  return keccak_256(data);
}

function concatBytes(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function p2wpkhScript(pubkey) {
  const h = hash160(pubkey);
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.from(h)]);
}

// ─── RPC ───────────────────────────────────────────────────────────
async function ethCall(method, params) {
  const resp = await fetch(SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ─── Phase 0: Status ──────────────────────────────────────────────
async function showStatus() {
  console.log('=== tETH Bridge Status ===\n');

  // Sepolia deposits
  const depositEventSig = 'Deposit(bytes32,bytes32,uint256,uint256)';
  const depositTopic = '0x' + hex(keccak256(new TextEncoder().encode(depositEventSig)));
  const poolId = computePoolId();

  const logs = await ethCall('eth_getLogs', [{
    fromBlock: DEPLOY_BLOCK, toBlock: 'latest',
    address: MIXER_ADDRESS,
    topics: [depositTopic, '0x' + hex(poolId)],
  }]);
  console.log(`Sepolia deposits: ${logs.length}`);
  const ethCommitments = [];
  for (const log of logs) {
    const commitment = log.topics[2].replace(/^0x/, '');
    const leafIndex = parseInt(log.data.slice(0, 66), 16);
    ethCommitments.push(commitment);
    console.log(`  [${leafIndex}] ${commitment.slice(0, 20)}... block=${parseInt(log.blockNumber, 16)}`);
  }

  // Signet pool leaves
  const poolResp = await fetch(`${WORKER_API}/pools/${ASSET_ID_HEX}/${DENOM_WEI}?network=signet`);
  const poolData = await poolResp.json();
  const signetLeaves = poolData.leaves || [];
  console.log(`\nSignet pool leaves: ${signetLeaves.length}`);
  const signetCommitments = new Set();
  for (const l of signetLeaves) {
    signetCommitments.add(l.leaf_commitment);
    const matchesEth = ethCommitments.includes(l.leaf_commitment);
    console.log(`  ${l.leaf_commitment.slice(0, 20)}... h=${l.deposited_at_height} ${matchesEth ? '(matches ETH deposit)' : '(mock/orphan)'}`);
  }

  // Identify unminted
  const unminted = ethCommitments.filter(c => !signetCommitments.has(c));
  console.log(`\nUnminted Sepolia deposits: ${unminted.length}`);
  for (const c of unminted) {
    console.log(`  ${c.slice(0, 20)}...`);
  }

  // Pool root
  const poolRootHex = await ethCall('eth_call', [{
    to: MIXER_ADDRESS,
    data: '0x' + 'ee59a615' + hex(poolId), // getPoolRoot(bytes32)
  }, 'latest']);
  console.log(`\nSepolia pool root: ${poolRootHex}`);

  // Balance
  const balHex = await ethCall('eth_getBalance', [MIXER_ADDRESS, 'latest']);
  const bal = BigInt(balHex);
  console.log(`Sepolia mixer balance: ${Number(bal) / 1e18} ETH (${bal} wei)`);

  // Signet UTXO
  const address = getSignetAddress();
  const utxoResp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
  const utxos = await utxoResp.json();
  const confirmed = utxos.filter(u => u.status.confirmed);
  const totalSats = confirmed.reduce((s, u) => s + u.value, 0);
  console.log(`\nSignet address: ${address}`);
  console.log(`Signet UTXOs: ${confirmed.length} confirmed (${totalSats} sats)`);

  return { ethCommitments, signetLeaves, unminted, confirmed };
}

// ─── Compute pool ID (keccak256(abi.encode(assetId, denom))) ──────
function computePoolId() {
  const encoded = new Uint8Array(64);
  encoded.set(unhex(ASSET_ID_HEX), 0);
  const denomBytes = bigintToBytes32(DENOM_WEI);
  encoded.set(denomBytes, 32);
  return keccak256(encoded);
}

function getSignetAddress() {
  const pubkey = compressedPubkey(SIGNET_PRIVKEY);
  const pkh = hash160(pubkey);
  // bech32 encode for signet (tb1q...)
  // Simplified: just return the known address
  return 'tb1qc0tjnm339uu89as6lhauegpc340m747n3jnsu5';
}

// ─── Phase 1: Mint (T_BRIDGE_DEPOSIT) ─────────────────────────────
async function mintDeposit(commitmentHex) {
  console.log(`\n=== Minting deposit ${commitmentHex.slice(0, 20)}... on signet ===\n`);

  const pubkey = compressedPubkey(SIGNET_PRIVKEY);
  const address = getSignetAddress();

  // Get UTXO
  const utxoResp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
  const utxos = await utxoResp.json();
  const utxo = utxos.find(u => u.status.confirmed) || utxos[0];
  if (!utxo) throw new Error('No UTXO on signet');
  console.log(`UTXO: ${utxo.txid}:${utxo.vout} = ${utxo.value} sats (confirmed=${utxo.status?.confirmed})`);

  // Fetch current Sepolia pool root
  const poolId = computePoolId();
  const poolRootHex = await ethCall('eth_call', [{
    to: MIXER_ADDRESS,
    data: '0x' + 'ee59a615' + hex(poolId),
  }, 'latest']);
  const ethRoot = unhex(poolRootHex);
  console.log(`Eth pool root: ${poolRootHex}`);

  // Build envelope
  const envelope = buildBridgeDepositEnvelope({
    ethRoot,
    leafHash: unhex(commitmentHex),
  });
  console.log(`Envelope: ${envelope.length} bytes`);

  // Build and broadcast tx
  const txid = await buildAndBroadcastTx(pubkey, utxo, envelope);
  console.log(`\nBroadcast result: ${txid}`);
  return txid;
}

function buildBridgeDepositEnvelope({ ethRoot, leafHash }) {
  const buf = Buffer.alloc(517);
  let o = 0;

  buf[o++] = T_BRIDGE_DEPOSIT;
  buf[o++] = NETWORK_TAG;

  // asset_id (32)
  unhex(ASSET_ID_HEX).copy(buf, o); o += 32;

  // denom_wei (32)
  unhex(DENOM_WEI_HEX).copy(buf, o); o += 32;

  // eth_root (32)
  Buffer.from(ethRoot).copy(buf, o); o += 32;

  // nullifier_hash (32) — random for mock (unique per deposit)
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;

  // recipient_commit (33) — compressed pubkey placeholder
  buf[o] = 0x02; o += 33;

  // leaf_hash (32) — the actual Sepolia commitment
  Buffer.from(leafHash).copy(buf, o); o += 32;

  // r_leaf (32) — random for mock
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;

  // bind_hash (32) — mock (would be domain-bound in real flow)
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;

  // proof_length LE = 256
  buf[o++] = 0x00; buf[o++] = 0x01;
  // proof (256) — zeros (mock verifier accepts)

  return buf;
}

// ─── Phase 2: Burn (T_BRIDGE_BURN) ────────────────────────────────
async function burnLeaf(ethRecipientHex) {
  if (!ethRecipientHex) throw new Error('Must provide --eth-recipient=0x...');
  const ethRecipient = unhex(ethRecipientHex);
  if (ethRecipient.length !== 20) throw new Error('ETH recipient must be 20 bytes');

  console.log(`\n=== Burning tETH leaf on signet ===`);
  console.log(`ETH recipient: 0x${hex(ethRecipient)}\n`);

  const pubkey = compressedPubkey(SIGNET_PRIVKEY);
  const address = getSignetAddress();

  // Get UTXO
  const utxoResp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
  const utxos = await utxoResp.json();
  const utxo = utxos.find(u => u.status.confirmed) || utxos[0];
  if (!utxo) throw new Error('No UTXO on signet');
  console.log(`UTXO: ${utxo.txid}:${utxo.vout} = ${utxo.value} sats (confirmed=${utxo.status?.confirmed})`);

  // Build burn envelope
  const envelope = buildBridgeBurnEnvelope({ ethRecipient });
  console.log(`Burn envelope: ${envelope.length} bytes`);

  const txid = await buildAndBroadcastTx(pubkey, utxo, envelope);
  console.log(`\nBurn broadcast result: ${txid}`);
  return txid;
}

function buildBridgeBurnEnvelope({ ethRecipient }) {
  // T_BRIDGE_BURN: 281 header + proof
  const proofLen = 256;
  const buf = Buffer.alloc(281 + proofLen);
  let o = 0;

  buf[o++] = T_BRIDGE_BURN;
  buf[o++] = NETWORK_TAG;

  // asset_id (32)
  unhex(ASSET_ID_HEX).copy(buf, o); o += 32;

  // denom_wei (32)
  unhex(DENOM_WEI_HEX).copy(buf, o); o += 32;

  // merkle_root (32) — mock pool root (would be real Tacit pool root)
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;

  // nullifier_hash (32) — random (unique per burn)
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;

  // recipient_commit (33)
  buf[o] = 0x02; o += 33;

  // r_leaf (32)
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;

  // eth_recipient (20)
  Buffer.from(ethRecipient).copy(buf, o); o += 20;

  // burn_nonce (32)
  randomBytes(32).copy(buf, o); o += 32;

  // bind_hash (32)
  Buffer.from(sha256(randomBytes(32))).copy(buf, o); o += 32;

  // proof_length LE = 256
  buf[o++] = 0x00; buf[o++] = 0x01;
  // proof (256) — zeros

  return buf;
}

// ─── TX Builder ────────────────────────────────────────────────────
async function buildAndBroadcastTx(pubkey, utxo, envelope) {
  const pubkeyHash = hash160(pubkey);

  // OP_RETURN script
  const opRetScript = Buffer.concat([
    Buffer.from([0x6a, 0x4d]),
    Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]),
    envelope,
  ]);

  const fee = 1000;
  const change = utxo.value - fee;
  if (change < 546) throw new Error(`Not enough sats for change (${utxo.value} - ${fee} = ${change})`);

  const changeScript = p2wpkhScript(pubkey);
  const version = writeU32LE(2);
  const prevTxid = Buffer.from(utxo.txid, 'hex').reverse();
  const prevVout = writeU32LE(utxo.vout);
  const sequence = writeU32LE(0xfffffffd);

  const allOutputsSerialized = Buffer.concat([
    writeU64LE(0), writeVarInt(opRetScript.length), opRetScript,
    writeU64LE(change), writeVarInt(changeScript.length), changeScript,
  ]);

  const outputs = Buffer.concat([writeVarInt(2), allOutputsSerialized]);

  const locktime = writeU32LE(0);

  // BIP143 sighash
  const hashPrevouts = sha256d(Buffer.concat([prevTxid, prevVout]));
  const hashSequence = sha256d(sequence);
  const hashOutputs = sha256d(allOutputsSerialized);

  const scriptCode = Buffer.concat([
    Buffer.from([0x19, 0x76, 0xa9, 0x14]),
    Buffer.from(pubkeyHash),
    Buffer.from([0x88, 0xac]),
  ]);

  const sighashPreimage = Buffer.concat([
    version,
    Buffer.from(hashPrevouts),
    Buffer.from(hashSequence),
    prevTxid, prevVout,
    scriptCode,
    writeU64LE(utxo.value),
    sequence,
    Buffer.from(hashOutputs),
    locktime,
    writeU32LE(1), // SIGHASH_ALL
  ]);

  const sighash = sha256d(sighashPreimage);

  // Sign
  const sig = await secp.signAsync(sighash, SIGNET_PRIVKEY, { lowS: true });
  const compact = sig.toCompactRawBytes();
  const r = compact.slice(0, 32);
  const s = compact.slice(32, 64);

  function derInt(buf) {
    let b = Buffer.from(buf);
    if (b[0] >= 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.slice(1);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  }
  const derR = derInt(r);
  const derS = derInt(s);
  const derBody = Buffer.concat([derR, derS]);
  const derBytes = Buffer.concat([Buffer.from([0x30, derBody.length]), derBody]);
  const derSig = Buffer.concat([derBytes, Buffer.from([0x01])]);

  // Assemble tx
  const rawTx = Buffer.concat([
    version,
    Buffer.from([0x00, 0x01]), // segwit marker
    writeVarInt(1),
    prevTxid, prevVout,
    writeVarInt(0),
    sequence,
    outputs,
    writeVarInt(2),
    writeVarInt(derSig.length), derSig,
    writeVarInt(pubkey.length), Buffer.from(pubkey),
    locktime,
  ]);

  console.log(`Raw tx: ${rawTx.length} bytes`);

  // Broadcast
  const broadcastResp = await fetch(`${MEMPOOL_API}/tx`, {
    method: 'POST',
    body: hex(rawTx),
  });
  const result = await broadcastResp.text();
  if (broadcastResp.ok) {
    return result; // txid
  } else {
    throw new Error(`Broadcast failed: ${result}`);
  }
}

// ─── Phase 3: Verify worker indexed ───────────────────────────────
async function verifyWorkerIndexed(expectedCommitment) {
  console.log(`\n=== Verifying worker indexed commitment ===`);

  const poolResp = await fetch(`${WORKER_API}/pools/${ASSET_ID_HEX}/${DENOM_WEI}?network=signet`);
  const poolData = await poolResp.json();
  const leaves = poolData.leaves || [];

  const found = leaves.find(l => l.leaf_commitment === expectedCommitment);
  if (found) {
    console.log(`FOUND: leaf ${expectedCommitment.slice(0, 20)}... at height ${found.deposited_at_height}`);
    return true;
  } else {
    console.log(`NOT FOUND yet. Pool has ${leaves.length} leaves.`);
    console.log(`Worker may need a cron cycle (5 min) to index new blocks.`);
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const mode = args.find(a => a.startsWith('--'))?.replace(/^--/, '') || 'status';

  if (mode === 'status') {
    await showStatus();
    return;
  }

  if (mode === 'mint') {
    // Find the latest unminted Sepolia deposit and mint it
    const status = await showStatus();
    if (status.unminted.length === 0) {
      console.log('\nAll Sepolia deposits already minted on signet.');
      return;
    }
    const commitmentToMint = args.find(a => !a.startsWith('--')) || status.unminted[status.unminted.length - 1];
    const txid = await mintDeposit(commitmentToMint);
    if (txid && txid.length === 64) {
      console.log(`\nMint broadcast OK. txid: ${txid}`);
      console.log(`Track: ${MEMPOOL_API.replace('/api', '')}/tx/${txid}`);
      console.log(`\nWait for confirmation (~10 min) then run --verify ${commitmentToMint}`);
    }
    return;
  }

  if (mode === 'burn') {
    const ethRecipient = args.find(a => a.startsWith('0x') && a.length === 42)
                      || args.find(a => a.startsWith('--eth-recipient='))?.split('=')[1];
    if (!ethRecipient) {
      console.log('Usage: --burn 0xYourSepoliaAddress');
      return;
    }
    await burnLeaf(ethRecipient);
    return;
  }

  if (mode.startsWith('verify')) {
    const commitment = args.find(a => !a.startsWith('--') && a.length === 64);
    if (!commitment) {
      console.log('Usage: --verify <commitment_hex>');
      return;
    }
    await verifyWorkerIndexed(commitment);
    return;
  }

  console.log('Usage: node bridge-sepolia-signet-e2e.mjs [--status | --mint | --burn 0xAddr | --verify <commitment>]');
}

main().catch(e => { console.error(e); process.exit(1); });
