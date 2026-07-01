#!/usr/bin/env node
// Real end-to-end withdrawFromBurn validation — headless dapp flow.
// Mirrors dapp/tacit.js: two-secret-pair deposit (eth+pool), real Groth16
// mint envelope, real Groth16 burn envelope, withdrawFromBurn on Sepolia.
//
// Subcommands:
//   status                  show state file + signet + worker status
//   deposit                 gen witness pair, deposit 0.001 ETH on Sepolia
//   mint                    build REAL Groth16 mint envelope + broadcast on signet
//   burn 0xEthAddr          fetch pool tree, build REAL Groth16 burn + broadcast
//   withdraw                build BTC inclusion proof + cast withdrawFromBurn
//
// State file: /tmp/3a-state.json

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { keccak_256 } from '@noble/hashes/sha3';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import { randomBytes } from 'crypto';
import * as snarkjs from 'snarkjs';
import fs from 'fs';
import { execSync } from 'child_process';
import * as cx from './cxfer-helpers.mjs';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

// node's undici fetch throws a bare "fetch failed" on transient DNS/socket
// blips against public RPC + mempool endpoints. Retry with backoff so a single
// hiccup doesn't abort a multi-step round-trip. Patches the global so the
// shared cxfer-helpers broadcaster benefits too.
const _origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try { return await _origFetch(url, opts); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
  }
  throw lastErr;
};

// ─── Config ────────────────────────────────────────────────────────
const SIGNET_PRIVKEY = process.env.SIGNET_PRIVKEY || '827aee3498ebbf5f4374387dc9937741ac87ec58a7a67c8091241d0797589222';
const MEMPOOL_API    = process.env.MEMPOOL_API || 'https://mempool.space/signet/api';
const WORKER_BASE    = process.env.TACIT_WORKER_BASE || process.env.WORKER_BASE || 'https://api.tacit.finance';
const SEPOLIA_RPC    = process.env.ETH_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const MIXER_ADDRESS  = process.env.MIXER_ADDRESS || '0x5bAcd098E59e937A8FFaEA4D281B3097A01ad91C';
const ASSET_ID_HEX   = process.env.ASSET_ID_HEX || 'd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b';
const BTC_HRP        = process.env.BTC_HRP || 'tb'; // 'bc' for mainnet
const DEPOSIT_FROM_BLOCK = process.env.DEPOSIT_FROM_BLOCK || '0xa7586c';
const RELAY_ADDRESS  = process.env.RELAY_ADDRESS || '0xDBa6B6b68957275bdA76Dd89F6c1a62aB04a36d3';
const DENOM_WEI      = 1000000000000000n;             // 0.001 ETH wei
const UNIT_SCALE     = 10000000000n;                  // 1e10 (wei → tacit 8-dec)
const DENOM_TACIT    = DENOM_WEI / UNIT_SCALE;        // 100000 (tacit 8-dec)
const NETWORK_TAG    = process.env.NETWORK_TAG ? parseInt(process.env.NETWORK_TAG, 10) : 0x01;
const TETH_CHAIN_ID  = process.env.CHAIN_ID ? BigInt(process.env.CHAIN_ID) : 11155111n;
const POOL_TREE_DEPTH= 20;
const T_BRIDGE_DEPOSIT = 0x60;
const T_BRIDGE_BURN    = 0x61;
const BN254_FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SECP_N           = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const BRIDGE_DEPOSIT_DOMAIN = new TextEncoder().encode('tacit-bridge-deposit-v1');
const BRIDGE_BURN_DOMAIN    = new TextEncoder().encode('tacit-bridge-burn-v1');
const CEREMONY_HASH       = '1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d';
const WITHDRAW_WASM_PATH  = '/Users/z/tacit/dapp/vendor/withdraw.wasm';
const STATE_FILE          = process.env.STATE_FILE || '/tmp/3a-state.json';
const TX_FEE_SATS         = 1500;
const DUST_LIMIT          = 546;

// ─── Bytes/hex ─────────────────────────────────────────────────────
const hex = b => Buffer.from(b).toString('hex');
const unhex = s => new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const hexToBytes = unhex;
const bytesToHex = hex;
function concatBytes(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function bigintToBytes32(v) {
  v = BigInt(v);
  const buf = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}
function bytes32ToBigint(b) {
  let v = 0n;
  for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}
function writeVarInt(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}
function writeU32LE(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function writeU64LE(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function sha256d(d) { return sha256(sha256(d)); }
function hash160(d) { return ripemd160(sha256(d)); }
function compressedPubkey(privHex) { return secp.getPublicKey(privHex, true); }

// ─── Poseidon ──────────────────────────────────────────────────────
function poseidonInputToBigInt(x) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') return BigInt(x);
  if (x instanceof Uint8Array || Buffer.isBuffer(x)) return bytes32ToBigint(x);
  if (typeof x === 'string') return BigInt(x.startsWith('0x') ? x : '0x' + x);
  throw new Error('poseidon input type');
}
function poseidonHash(...inputs) {
  const args = inputs.map(poseidonInputToBigInt);
  let r;
  if (args.length === 1) r = poseidon1(args);
  else if (args.length === 2) r = poseidon2(args);
  else if (args.length === 3) r = poseidon3(args);
  else throw new Error('arity ' + args.length);
  return bigintToBytes32(r);
}
function computePoolLeafCommitment(secret, preimage, denomTacit) {
  return poseidonHash(secret, preimage, BigInt(denomTacit));
}
function computeNullifierHash(preimage) { return poseidonHash(preimage); }

// ─── Pedersen (secp256k1) ──────────────────────────────────────────
function deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let c = 0; c < 256; c++) {
    const x = sha256(concatBytes(seed, new Uint8Array([c])));
    const cand = concatBytes(new Uint8Array([0x02]), x);
    try { const p = secp.ProjectivePoint.fromHex(hex(cand)); if (!p.equals(secp.ProjectivePoint.ZERO)) return p; } catch {}
  }
  throw new Error('H');
}
const H = deriveH();
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;
const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? ZERO : H.multiply(a);
  const rG = r === 0n ? ZERO : G.multiply(r);
  return aH.add(rG);
}

// ─── Bind hashes ────────────────────────────────────────────────────
function _reduceModField(h32) {
  return bigintToBytes32(bytes32ToBigint(h32) % BN254_FIELD_SIZE);
}
function computeBridgeDepositBindHash(networkTag, assetId, denomTacitBytes, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf) {
  const chainId32 = bigintToBytes32(TETH_CHAIN_ID);
  const mixerAddr = hexToBytes(MIXER_ADDRESS.replace(/^0x/i,'').padStart(40,'0'));
  return _reduceModField(sha256(concatBytes(
    BRIDGE_DEPOSIT_DOMAIN, chainId32, mixerAddr, new Uint8Array([networkTag & 0xff]),
    assetId, denomTacitBytes, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf,
  )));
}
function computeBridgeBurnBindHash(networkTag, assetId, denomTacitBytes, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce) {
  const chainId32 = bigintToBytes32(TETH_CHAIN_ID);
  const mixerAddr = hexToBytes(MIXER_ADDRESS.replace(/^0x/i,'').padStart(40,'0'));
  return _reduceModField(sha256(concatBytes(
    BRIDGE_BURN_DOMAIN, chainId32, mixerAddr, new Uint8Array([networkTag & 0xff]),
    assetId, denomTacitBytes, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce,
  )));
}

function encodeTBridgeDepositPayload({ networkTag, assetId, denomTacit, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf, bindHash, proof }) {
  return concatBytes(
    new Uint8Array([T_BRIDGE_DEPOSIT, networkTag & 0xff]),
    assetId, denomTacit, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf, bindHash,
    new Uint8Array([proof.length & 0xff, (proof.length >> 8) & 0xff]),
    proof,
  );
}
function encodeTBridgeBurnPayload({ networkTag, assetId, denomTacit, merkleRoot, nullifierHash, recipientCommit, rLeaf, ethRecipient, burnNonce, bindHash, proof }) {
  return concatBytes(
    new Uint8Array([T_BRIDGE_BURN, networkTag & 0xff]),
    assetId, denomTacit, merkleRoot, nullifierHash, recipientCommit, rLeaf,
    ethRecipient, burnNonce, bindHash,
    new Uint8Array([proof.length & 0xff, (proof.length >> 8) & 0xff]),
    proof,
  );
}
function _serializeGroth16Proof(p) {
  const out = new Uint8Array(256);
  const w = (off, dec) => { let v = BigInt(dec); for (let i = 31; i >= 0; i--) { out[off + i] = Number(v & 0xffn); v >>= 8n; } };
  w(0, p.pi_a[0]); w(32, p.pi_a[1]);
  w(64, p.pi_b[0][0]); w(96, p.pi_b[0][1]);
  w(128, p.pi_b[1][0]); w(160, p.pi_b[1][1]);
  w(192, p.pi_c[0]); w(224, p.pi_c[1]);
  return out;
}

// ─── Eth RPC ───────────────────────────────────────────────────────
async function ethCall(method, params) {
  const r = await fetch(SEPOLIA_RPC, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ─── Sparse merkle tree (depth 20, poseidon) — matches dapp + mixer ─
function buildEthTree(commitmentHexes) {
  const depth = POOL_TREE_DEPTH;
  const n = commitmentHexes.length;
  const leaves = commitmentHexes.map(h => hexToBytes(h));
  const zeroLeaf = new Uint8Array(32);
  const zeros = [zeroLeaf];
  for (let d = 1; d < depth; d++) zeros.push(poseidonHash(zeros[d - 1], zeros[d - 1]));
  const nodes = new Map();
  const k = (l, i) => `${l}:${i}`;
  const get = (l, i) => nodes.get(k(l, i)) || zeros[l];
  for (let i = 0; i < n; i++) nodes.set(k(0, i), leaves[i]);
  for (let d = 0; d < depth; d++) {
    const cnt = Math.ceil(n / (1 << d));
    for (let i = 0; i < cnt; i += 2) {
      nodes.set(k(d + 1, Math.floor(i / 2)), poseidonHash(get(d, i), get(d, i + 1)));
    }
  }
  return {
    root: get(depth, 0),
    leafCount: n,
    getProof(leafIndex) {
      const pe = [], pi = [];
      let idx = leafIndex;
      for (let d = 0; d < depth; d++) {
        pe.push(bytes32ToBigint(get(d, idx ^ 1)));
        pi.push(idx & 1);
        idx >>= 1;
      }
      return { pathElements: pe, pathIndices: pi };
    },
  };
}

// Pool merkle proof built for just OUR leaf at idx 0 — matches guest's view
// after a single accepted mint (worker may have ignored/included other leaves;
// we mirror what the guest will compute when our valid mint is the first).
function buildPoolProofForOnlyMyLeaf(myLeafIdx, allLeavesUpThroughMine) {
  return buildEthTree(allLeavesUpThroughMine).getProof(myLeafIdx);
}

// ─── Fetch Sepolia deposits for pool ────────────────────────────────
async function fetchSepoliaDeposits() {
  const depositSig = keccak_256(new TextEncoder().encode('Deposit(bytes32,bytes32,uint256,uint256)'));
  const poolId = keccak_256(concatBytes(hexToBytes(ASSET_ID_HEX), bigintToBytes32(DENOM_WEI)));
  const logs = await ethCall('eth_getLogs', [{
    address: MIXER_ADDRESS, fromBlock: DEPOSIT_FROM_BLOCK, toBlock: 'latest',
    topics: ['0x' + bytesToHex(depositSig), '0x' + bytesToHex(poolId)],
  }]);
  return logs.map(l => ({
    commitment: l.topics[2].replace(/^0x/, ''),
    leafIndex: parseInt(l.data.slice(0, 66), 16),
    blockNumber: parseInt(l.blockNumber, 16),
  })).sort((a, b) => a.leafIndex - b.leafIndex);
}

// ─── IPFS zkey ─────────────────────────────────────────────────────
async function fetchHeadZkeyBytes() {
  // Local override: the finalized ceremony zkey ships in the repo; use it when
  // IPFS gateways are flaky. Must be the ceremony key (matches the guest VK).
  if (process.env.ZKEY_PATH) {
    const buf = new Uint8Array(fs.readFileSync(process.env.ZKEY_PATH));
    if (buf.length < 256 || buf[0] !== 0x7a || buf[1] !== 0x6b) throw new Error(`ZKEY_PATH not a zkey: ${process.env.ZKEY_PATH}`);
    console.log(`  using local zkey ${process.env.ZKEY_PATH} (${buf.length} bytes)`);
    return buf;
  }
  const r = await fetch(`${WORKER_BASE}/ceremony/${CEREMONY_HASH}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`ceremony state: HTTP ${r.status}`);
  const { state } = await r.json();
  if (!state?.head_cid) throw new Error('no head_cid');
  const gws = [
    `https://${state.head_cid}.ipfs.w3s.link`,
    `https://${state.head_cid}.ipfs.dweb.link`,
    `https://w3s.link/ipfs/${state.head_cid}`,
    `https://ipfs.io/ipfs/${state.head_cid}`,
  ];
  for (const gw of gws) {
    try {
      console.log(`  trying ${gw.split('//')[1].split('/')[0]}...`);
      const rr = await fetch(gw, { headers: { Accept: 'application/octet-stream' } });
      if (!rr.ok) { console.log(`    HTTP ${rr.status}`); continue; }
      const buf = new Uint8Array(await rr.arrayBuffer());
      if (buf.length < 256 || buf[0] !== 0x7a || buf[1] !== 0x6b || buf[2] !== 0x65 || buf[3] !== 0x79) {
        console.log(`    no zkey magic (${buf.length} bytes)`); continue;
      }
      console.log(`    zkey OK (${buf.length} bytes)`);
      return buf;
    } catch (e) { console.log(`    ${e.message}`); }
  }
  throw new Error('all IPFS gateways failed');
}

// ─── Signet wallet ─────────────────────────────────────────────────
function bech32Encode(hrp, witver, prog) {
  const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const polymod = vs => {
    let chk = 1;
    for (const v of vs) {
      const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][i];
    }
    return chk;
  };
  const conv = (data, fb, tb, pad) => {
    let acc = 0, bits = 0; const out = []; const maxv = (1 << tb) - 1;
    for (const v of data) { acc = (acc << fb) | v; bits += fb; while (bits >= tb) { bits -= tb; out.push((acc >> bits) & maxv); } }
    if (pad && bits > 0) out.push((acc << (tb - bits)) & maxv);
    return out;
  };
  const expand = h => { const a = h.split('').map(c => c.charCodeAt(0) >> 5); a.push(0); const b = h.split('').map(c => c.charCodeAt(0) & 31); return [...a, ...b]; };
  const data5 = [witver, ...conv(prog, 8, 5, true)];
  const values = [...expand(hrp), ...data5];
  const chk = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1; // 1 for bech32 witver 0
  const checksum = []; for (let i = 0; i < 6; i++) checksum.push((chk >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data5, ...checksum].map(i => CS[i]).join('');
}
function getSignetAddress() {
  return bech32Encode(BTC_HRP, 0, [...hash160(compressedPubkey(SIGNET_PRIVKEY))]);
}
function p2wpkhScript(pubkey) {
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.from(hash160(pubkey))]);
}

// ─── Build + sign + broadcast signet tx (OP_RETURN + P2WPKH change) ──
async function broadcastWithOpReturn(privHex, envelope) {
  const pubkey = compressedPubkey(privHex);
  const pkh = hash160(pubkey);
  const addr = getSignetAddress();

  const utxoR = await fetch(`${MEMPOOL_API}/address/${addr}/utxo`);
  let utxos = await utxoR.json();
  // Pick the largest spendable (pays fee + change ≥ dust). If no confirmed
  // candidate qualifies, fall back to mempool-chained UTXOs.
  const MIN_SPENDABLE = TX_FEE_SATS + DUST_LIMIT;
  const spendable = utxos.filter(u => u.value >= MIN_SPENDABLE);
  const confSpendable = spendable.filter(u => u.status.confirmed);
  if (confSpendable.length) utxos = confSpendable;
  else if (spendable.length) { utxos = spendable; console.log('(no confirmed spendable UTXOs — using mempool chain)'); }
  else throw new Error(`no spendable signet UTXO ≥ ${MIN_SPENDABLE} sats`);
  const utxo = utxos.sort((a, b) => b.value - a.value)[0];
  console.log(`UTXO: ${utxo.txid.slice(0,16)}...:${utxo.vout} = ${utxo.value} sats`);

  // OP_RETURN script (OP_RETURN OP_PUSHDATA2 LE_len envelope)
  const opLen = envelope.length;
  const opRet = Buffer.concat([
    Buffer.from([0x6a, 0x4d, opLen & 0xff, (opLen >> 8) & 0xff]),
    Buffer.from(envelope),
  ]);

  const change = utxo.value - TX_FEE_SATS;
  if (change < DUST_LIMIT) throw new Error(`change ${change} < dust`);
  const changeSpk = p2wpkhScript(pubkey);

  // Outputs: [op_return (0 sats), change P2WPKH]
  const outputs = [
    { value: writeU64LE(0), spk: opRet },
    { value: writeU64LE(change), spk: changeSpk },
  ];

  const version = writeU32LE(2);
  const sequence = writeU32LE(0xfffffffd);
  const locktime = writeU32LE(0);

  const prevTxid = Buffer.from(utxo.txid, 'hex').reverse();
  const prevVout = writeU32LE(utxo.vout);

  // BIP143 sighash for P2WPKH
  const hashPrevouts = sha256d(Buffer.concat([prevTxid, prevVout]));
  const hashSequence = sha256d(sequence);
  const hashOutputs = sha256d(Buffer.concat(outputs.map(o => Buffer.concat([o.value, writeVarInt(o.spk.length), o.spk]))));
  const scriptCode = Buffer.concat([Buffer.from([0x19, 0x76, 0xa9, 0x14]), Buffer.from(pkh), Buffer.from([0x88, 0xac])]);
  const sigVal = writeU64LE(utxo.value);

  const preimage = Buffer.concat([
    version, Buffer.from(hashPrevouts), Buffer.from(hashSequence),
    prevTxid, prevVout, scriptCode, sigVal, sequence,
    Buffer.from(hashOutputs), locktime, writeU32LE(1),
  ]);
  const sigHash = sha256d(preimage);
  const sig = secp.sign(sigHash, privHex, { lowS: true });
  // Canonical DER per BIP66
  const toCanonicalIntBytes = bn => {
    let h = bn.toString(16);
    if (h.length % 2) h = '0' + h;
    let buf = Buffer.from(h, 'hex');
    while (buf.length > 1 && buf[0] === 0 && !(buf[1] & 0x80)) buf = buf.slice(1);
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return buf;
  };
  const rBytes = toCanonicalIntBytes(sig.r);
  const sBytes = toCanonicalIntBytes(sig.s);
  const der = Buffer.concat([
    Buffer.from([0x30, 2 + rBytes.length + 2 + sBytes.length]),
    Buffer.from([0x02, rBytes.length]), rBytes,
    Buffer.from([0x02, sBytes.length]), sBytes,
  ]);
  const sigWithType = Buffer.concat([der, Buffer.from([0x01])]);

  // Final tx
  const txParts = [
    version, Buffer.from([0x00, 0x01]), // marker + flag
    writeVarInt(1), prevTxid, prevVout, writeVarInt(0), sequence, // single input, empty scriptSig
    writeVarInt(outputs.length),
    ...outputs.flatMap(o => [o.value, writeVarInt(o.spk.length), o.spk]),
    writeVarInt(2), writeVarInt(sigWithType.length), sigWithType, writeVarInt(pubkey.length), Buffer.from(pubkey),
    locktime,
  ];
  const rawTx = Buffer.concat(txParts);
  console.log(`raw tx ${rawTx.length} bytes`);

  const br = await fetch(`${MEMPOOL_API}/tx`, { method:'POST', body: hex(rawTx) });
  const body = await br.text();
  if (!br.ok) throw new Error(`broadcast failed: ${br.status} ${body}`);
  return body.trim();
}

// ─── State ──────────────────────────────────────────────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ─── Subcommand: deposit ────────────────────────────────────────────
async function cmdDeposit() {
  const state = loadState();
  if (state.depositCommitment) {
    console.log(`state already has depositCommitment ${state.depositCommitment.slice(0,16)}... — overwriting`);
  }
  const secretEth = randomBytes(32);
  const preimageEth = randomBytes(32);
  const secretPool = randomBytes(32);
  const preimagePool = randomBytes(32);
  const depositCommitment = computePoolLeafCommitment(secretEth, preimageEth, DENOM_TACIT);
  const poolLeaf = computePoolLeafCommitment(secretPool, preimagePool, DENOM_TACIT);
  if (bytes32ToBigint(depositCommitment) >= BN254_FIELD_SIZE) throw new Error('deposit commitment overflow');
  if (bytes32ToBigint(poolLeaf) >= BN254_FIELD_SIZE) throw new Error('pool leaf overflow');

  const newState = {
    secretEth: hex(secretEth),
    preimageEth: hex(preimageEth),
    secretPool: hex(secretPool),
    preimagePool: hex(preimagePool),
    depositCommitment: hex(depositCommitment),
    poolLeaf: hex(poolLeaf),
    denomTacit: DENOM_TACIT.toString(),
    denomWei: DENOM_WEI.toString(),
  };
  saveState(newState);
  console.log(`depositCommitment: 0x${hex(depositCommitment)}`);
  console.log(`poolLeaf:          0x${hex(poolLeaf)}`);
  const PK = process.env.DEPLOYER_PRIVATE_KEY;
  if (!PK) throw new Error('DEPLOYER_PRIVATE_KEY env required');
  console.log(`depositing 0.001 ETH on Sepolia mixer ${MIXER_ADDRESS}`);
  const result = execSync(
    `cast send ${MIXER_ADDRESS} 'deposit(bytes32,uint256)' 0x${hex(depositCommitment)} ${DENOM_WEI} --value ${DENOM_WEI} --rpc-url ${SEPOLIA_RPC} --private-key ${PK} 2>&1`,
    { encoding: 'utf8' }
  );
  const txMatch = result.match(/transactionHash\s+(0x[a-fA-F0-9]+)/);
  const blockMatch = result.match(/blockNumber\s+(\d+)/);
  newState.depositTxid = txMatch?.[1];
  newState.depositBlock = blockMatch?.[1];
  saveState(newState);
  console.log(`deposit tx: ${newState.depositTxid} block ${newState.depositBlock}`);
}

// ─── Subcommand: mint ───────────────────────────────────────────────
async function cmdMint() {
  const state = loadState();
  if (!state.depositCommitment) throw new Error('no deposit — run "deposit" first');

  console.log('fetching Sepolia deposits for pool...');
  const deposits = await fetchSepoliaDeposits();
  console.log(`found ${deposits.length} deposits`);
  const myCommitHex = state.depositCommitment.toLowerCase();
  const myIdx = deposits.findIndex(d => d.commitment.toLowerCase() === myCommitHex);
  if (myIdx < 0) throw new Error(`commitment ${myCommitHex.slice(0,16)}... not in eth tree — wait for indexer`);
  console.log(`my deposit at leafIndex ${deposits[myIdx].leafIndex} of ${deposits.length}`);

  console.log(`building eth tree from ${deposits.length} leaves...`);
  const ethTree = buildEthTree(deposits.map(d => d.commitment));
  const ethProof = ethTree.getProof(deposits[myIdx].leafIndex);

  // Verify against on-chain pool root
  const sel = 'ee59a615';
  const poolId = keccak_256(concatBytes(hexToBytes(ASSET_ID_HEX), bigintToBytes32(DENOM_WEI)));
  const onchainRoot = await ethCall('eth_call', [{ to: MIXER_ADDRESS, data: '0x' + sel + bytesToHex(poolId) }, 'latest']);
  const computedRootHex = '0x' + bytesToHex(ethTree.root);
  console.log(`onchain root:  ${onchainRoot}`);
  console.log(`computed root: ${computedRootHex}`);
  if (onchainRoot.toLowerCase() !== computedRootHex.toLowerCase()) {
    throw new Error('ETH TREE ROOT MISMATCH — local computation differs from mixer.getPoolRoot');
  }

  // Witness setup
  const secretEth = hexToBytes(state.secretEth);
  const preimageEth = hexToBytes(state.preimageEth);
  const nullifierHashEth = computeNullifierHash(preimageEth);
  const rLeaf = poseidonHash(secretEth, preimageEth);
  const rLeafBig = bytes32ToBigint(rLeaf) % SECP_N;
  const recipientCommit = pedersenCommit(DENOM_TACIT, rLeafBig).toRawBytes(true);
  const poolLeaf = hexToBytes(state.poolLeaf);
  const ethRootBytes = ethTree.root;
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const denomTacitBytes = bigintToBytes32(DENOM_TACIT);

  const bindHash = computeBridgeDepositBindHash(
    NETWORK_TAG, assetIdBytes, denomTacitBytes, ethRootBytes,
    nullifierHashEth, recipientCommit, poolLeaf, rLeaf,
  );

  const proverInput = {
    root: bytes32ToBigint(ethRootBytes).toString(),
    nullifier_hash: bytes32ToBigint(nullifierHashEth).toString(),
    denomination: DENOM_TACIT.toString(),
    r_leaf: bytes32ToBigint(rLeaf).toString(),
    bind_hash: bytes32ToBigint(bindHash).toString(),
    secret: bytes32ToBigint(secretEth).toString(),
    nullifier_preimage: bytes32ToBigint(preimageEth).toString(),
    path_elements: ethProof.pathElements.map(e => e.toString()),
    path_indices: ethProof.pathIndices,
  };

  console.log('fetching head zkey...');
  const zkeyBytes = await fetchHeadZkeyBytes();
  console.log('loading withdraw.wasm...');
  const wasmBytes = new Uint8Array(fs.readFileSync(WITHDRAW_WASM_PATH));

  console.log('generating Groth16 mint proof (~30-60s)...');
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(proverInput, wasmBytes, zkeyBytes);
  console.log(`proof done in ${((Date.now() - t0)/1000).toFixed(1)}s`);
  const proofBytes = _serializeGroth16Proof(proof);

  const payload = encodeTBridgeDepositPayload({
    networkTag: NETWORK_TAG, assetId: assetIdBytes, denomTacit: denomTacitBytes,
    ethRoot: ethRootBytes, nullifierHash: nullifierHashEth, recipientCommit,
    leafHash: poolLeaf, rLeaf, bindHash, proof: proofBytes,
  });
  console.log(`mint envelope ${payload.length} bytes`);

  // MINT (0x60) is 517B — over the 80B OP_RETURN cap — so it rides in a Taproot
  // script-path reveal (witness item 1), the mainnet-relayable carrier the dapp
  // uses. The reveal txid is what the worker/guest index.
  const { revealTxid: txid } = await cx.broadcastTaprootEnvelope({
    envelope: payload,
    signerPriv: cx.hexToBytes(SIGNET_PRIVKEY),
    signerPub: compressedPubkey(SIGNET_PRIVKEY),
    address: getSignetAddress(),
    mempoolApi: MEMPOOL_API,
  });
  state.mintTxid = txid;
  state.mintEthRoot = hex(ethRootBytes);
  state.mintEthLeafIndex = deposits[myIdx].leafIndex;
  saveState(state);
  console.log(`mint txid: ${txid}`);
  console.log(`Track: ${MEMPOOL_API.replace('/api','')}/tx/${txid}`);
}

// ─── Subcommand: burn ───────────────────────────────────────────────
async function cmdBurn(ethRecipient) {
  const state = loadState();
  if (!state.poolLeaf) throw new Error('no poolLeaf — run "deposit" first');
  if (!state.mintTxid) throw new Error('no mintTxid — run "mint" first');
  if (!ethRecipient || !/^0x[0-9a-fA-F]{40}$/.test(ethRecipient)) throw new Error('need 0xEthAddress');

  // For the burn proof, mirror the guest's view: our pool leaf is at idx 0
  // in a tree that ONLY contains our (valid) mint. Other mempool/mock mints
  // the guest rejected (invalid proof) wouldn't enter its tree.
  const poolLeafHex = state.poolLeaf;
  const allLeaves = [poolLeafHex]; // guest's view: just ours after one accepted mint
  const tree = buildEthTree(allLeaves);
  const mp = tree.getProof(0);
  const merkleRoot = tree.root;

  const secretPool = hexToBytes(state.secretPool);
  const preimagePool = hexToBytes(state.preimagePool);
  const rLeaf = poseidonHash(secretPool, preimagePool);
  const rLeafBig = bytes32ToBigint(rLeaf) % SECP_N;
  const recipientCommit = pedersenCommit(DENOM_TACIT, rLeafBig).toRawBytes(true);
  const nullifierHash = computeNullifierHash(preimagePool);
  const burnNonce = randomBytes(32);
  const ethRecipientBytes = hexToBytes(ethRecipient.replace(/^0x/, ''));
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const denomTacitBytes = bigintToBytes32(DENOM_TACIT);

  const bindHash = computeBridgeBurnBindHash(
    NETWORK_TAG, assetIdBytes, denomTacitBytes, merkleRoot,
    nullifierHash, recipientCommit, rLeaf, ethRecipientBytes, burnNonce,
  );

  const proverInput = {
    root: bytes32ToBigint(merkleRoot).toString(),
    nullifier_hash: bytes32ToBigint(nullifierHash).toString(),
    denomination: DENOM_TACIT.toString(),
    r_leaf: bytes32ToBigint(rLeaf).toString(),
    bind_hash: bytes32ToBigint(bindHash).toString(),
    secret: bytes32ToBigint(secretPool).toString(),
    nullifier_preimage: bytes32ToBigint(preimagePool).toString(),
    path_elements: mp.pathElements.map(e => e.toString()),
    path_indices: mp.pathIndices,
  };

  console.log('fetching head zkey...');
  const zkeyBytes = await fetchHeadZkeyBytes();
  console.log('loading withdraw.wasm...');
  const wasmBytes = new Uint8Array(fs.readFileSync(WITHDRAW_WASM_PATH));
  console.log('generating Groth16 burn proof (~30-60s)...');
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(proverInput, wasmBytes, zkeyBytes);
  console.log(`proof done in ${((Date.now() - t0)/1000).toFixed(1)}s`);
  const proofBytes = _serializeGroth16Proof(proof);

  const payload = encodeTBridgeBurnPayload({
    networkTag: NETWORK_TAG, assetId: assetIdBytes, denomTacit: denomTacitBytes,
    merkleRoot, nullifierHash, recipientCommit, rLeaf,
    ethRecipient: ethRecipientBytes, burnNonce, bindHash, proof: proofBytes,
  });
  console.log(`burn envelope ${payload.length} bytes`);

  state.burnEthRecipient = ethRecipient.toLowerCase();
  state.burnMerkleRoot = hex(merkleRoot);
  state.burnNullifierHash = hex(nullifierHash);
  state.burnRecipientCommit = hex(recipientCommit);
  state.burnRLeaf = hex(rLeaf);
  state.burnNonce = hex(burnNonce);
  state.burnBindHash = hex(bindHash);
  state.burnProof = hex(proofBytes);
  saveState(state);

  // BURN (0x61) is 537B — Taproot reveal carries it (witness item 1), same as
  // the dapp. The reveal txid is the burn the worker/guest index + the withdraw
  // proves inclusion of.
  const { revealTxid: txid } = await cx.broadcastTaprootEnvelope({
    envelope: payload,
    signerPriv: cx.hexToBytes(SIGNET_PRIVKEY),
    signerPub: compressedPubkey(SIGNET_PRIVKEY),
    address: getSignetAddress(),
    mempoolApi: MEMPOOL_API,
  });
  state.burnTxid = txid;
  saveState(state);
  console.log(`burn txid: ${txid}`);
  console.log(`Track: ${MEMPOOL_API.replace('/api','')}/tx/${txid}`);
}

// ─── Subcommand: status ─────────────────────────────────────────────
async function cmdStatus() {
  const state = loadState();
  console.log('=== 3a state ===');
  const safe = { ...state };
  for (const k of ['secretEth','preimageEth','secretPool','preimagePool','burnProof']) {
    if (safe[k]) safe[k] = safe[k].slice(0, 16) + '...';
  }
  console.log(JSON.stringify(safe, null, 2));
  const addr = getSignetAddress();
  console.log(`\nsignet address: ${addr}`);
  const uR = await fetch(`${MEMPOOL_API}/address/${addr}/utxo`);
  const utxos = (await uR.json()).filter(u => u.status.confirmed);
  console.log(`UTXOs: ${utxos.length} confirmed, total ${utxos.reduce((s,u)=>s+u.value,0)} sats`);
  for (const k of ['depositTxid', 'mintTxid', 'burnTxid']) {
    if (!state[k]) continue;
    if (k === 'depositTxid') {
      const r = await ethCall('eth_getTransactionReceipt', [state[k]]);
      console.log(`${k}: status ${r?.status} block ${r?.blockNumber}`);
    } else {
      const r = await fetch(`${MEMPOOL_API}/tx/${state[k]}`);
      if (r.ok) { const t = await r.json(); console.log(`${k}: confirmed=${t.status?.confirmed} block=${t.status?.block_height || 'mempool'}`); }
      else console.log(`${k}: not in mempool API`);
    }
  }
}

// ─── Subcommand: withdraw — Sepolia mixer.withdrawFromBurn ─────────
async function cmdWithdraw() {
  const state = loadState();
  if (!state.burnTxid) throw new Error('no burnTxid — run "burn" first');
  if (!state.burnEthRecipient) throw new Error('no burnEthRecipient saved');

  const RELAY = RELAY_ADDRESS;

  const statusR = await fetch(`${MEMPOOL_API}/tx/${state.burnTxid}/status`);
  const status = await statusR.json();
  if (!status.confirmed) throw new Error(`burn tx not confirmed yet (height=${status.block_height})`);
  const burnBlock = status.block_height;
  console.log(`burn at signet block ${burnBlock}`);

  const tipHex = await ethCall('eth_call', [{ to: RELAY, data: '0x1fd4827a' }, 'latest']);
  const relayTip = parseInt(tipHex, 16);
  console.log(`relay tip: ${relayTip}`);
  if (relayTip < burnBlock + 6) {
    throw new Error(`relay tip ${relayTip} < burnBlock+6 (${burnBlock + 6}); prover must advance further`);
  }

  const burnBlockHash = await (await fetch(`${MEMPOOL_API}/block-height/${burnBlock}`)).text();
  const txids = await (await fetch(`${MEMPOOL_API}/block/${burnBlockHash}/txids`)).json();
  const txPos = txids.indexOf(state.burnTxid);
  if (txPos < 0) throw new Error('burn tx not in block txids');

  const rawHex = await (await fetch(`${MEMPOOL_API}/tx/${state.burnTxid}/hex`)).text();

  function sha256d_buf(b) { return Buffer.from(sha256(sha256(b))); }
  let hashes = txids.map(t => Buffer.from(t, 'hex').reverse());
  const proof = [];
  let idx = txPos;
  while (hashes.length > 1) {
    if (hashes.length % 2) hashes.push(hashes[hashes.length - 1]);
    const sib = idx ^ 1;
    proof.push(hashes[sib]);
    const next = [];
    for (let i = 0; i < hashes.length; i += 2) next.push(sha256d_buf(Buffer.concat([hashes[i], hashes[i + 1]])));
    hashes = next;
    idx = Math.floor(idx / 2);
  }
  const merkleProofHex = proof.map(p => '0x' + p.toString('hex')).join(',');

  let headers = '';
  for (let h = burnBlock; h <= relayTip; h++) {
    const bh = await (await fetch(`${MEMPOOL_API}/block-height/${h}`)).text();
    headers += await (await fetch(`${MEMPOOL_API}/block/${bh}/header`)).text();
  }
  console.log(`headers ${headers.length/160} blocks (${burnBlock}..${relayTip})`);

  const PK = process.env.DEPLOYER_PRIVATE_KEY;
  if (!PK) throw new Error('DEPLOYER_PRIVATE_KEY required');
  const args = [
    MIXER_ADDRESS,
    `'withdrawFromBurn(bytes,bytes,uint256,bytes32[],uint256)'`,
    `"0x${rawHex}"`, `"0x${headers}"`, `${burnBlock}`,
    `"[${merkleProofHex}]"`, `${txPos}`,
  ];
  const cmd = `cast send ${args.join(' ')} --rpc-url ${SEPOLIA_RPC} --private-key ${PK} --gas-limit 1500000`;
  console.log('calling withdrawFromBurn…');
  const result = execSync(cmd + ' 2>&1', { encoding: 'utf8' });
  const status_match = result.match(/status\s+(\d+)/);
  const tx_match = result.match(/transactionHash\s+(0x[a-fA-F0-9]+)/);
  console.log(`withdraw status: ${status_match?.[1]} tx: ${tx_match?.[1]}`);
  if (!result.includes('status               1')) {
    console.log('--- output ---');
    console.log(result);
  }
  state.withdrawTxid = tx_match?.[1];
  saveState(state);
}

// ─── Main ───────────────────────────────────────────────────────────
const cmd = process.argv[2];
const arg = process.argv[3];
(async () => {
  try {
    if (cmd === 'deposit') await cmdDeposit();
    else if (cmd === 'mint') await cmdMint();
    else if (cmd === 'burn') await cmdBurn(arg);
    else if (cmd === 'withdraw') await cmdWithdraw();
    else if (cmd === 'status') await cmdStatus();
    else { console.log('Usage: bridge-3a.mjs [deposit | mint | burn 0xEthAddr | withdraw | status]'); process.exit(1); }
  } catch (e) {
    console.error('ERROR:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  } finally { process.exit(0); }
})();
