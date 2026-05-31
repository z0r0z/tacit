#!/usr/bin/env node
// 3b (fractional, smaller scale): Alice deposits 0.1 ETH, mints 0.1 tETH,
// EXPORTS the 0.1 tETH leaf, CXFER-splits to [Bob 0.001, Alice 0.099 change
// stranded for test], Bob IMPORTS his 0.001 into the 0.001 ETH pool, burns,
// withdraws 0.001 ETH on Sepolia.
//
// CXFER uses BP+ on signet (mainnet uses regular BP — same protocol, different
// wire encoding).
//
// **STATUS: skeleton only. CXFER/import/Bob's burn/withdraw still being
// engineered — multi-session port: tapscript leaf hash + tweaked output key
// + control block, stealth blinding/keystream helpers, Schnorr kernel sig,
// BPP+ integration, multi-input/multi-output BTC tx. Currently
// deposit/mint/export are ready; CXFER is the wildcard.**
//
// Subcommands:
//   status                    show state + tx status
//   deposit                   gen Alice + Bob witnesses, deposit 0.1 ETH (Sepolia)
//   mint                      Groth16 mint on signet
//   export                    Groth16 export, releases stealth tETH UTXO
//   cxfer                     [TODO] split tETH UTXO into [Bob 0.001, Alice change]
//   import                    [TODO] Bob imports his 0.001 into the 0.001 ETH pool
//   burn 0xBobEthAddr         [TODO] Bob's burn at 0.001 ETH denom
//   withdraw                  [TODO] Bob's withdrawFromBurn (0.001 ETH to Bob)
//
// State file: /tmp/3b-state.json

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { keccak_256 } from '@noble/hashes/sha3';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import { randomBytes } from 'crypto';
import * as snarkjs from 'snarkjs';
import fs from 'fs';
import * as cx from './cxfer-helpers.mjs';
import { execSync } from 'child_process';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

// Retry undici "fetch failed" transient blips against public RPC + mempool.
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
const MEMPOOL_API    = 'https://mempool.space/signet/api';
const WORKER_BASE    = 'https://tacit-pin.rosscampbell9.workers.dev';
const SEPOLIA_RPC    = 'https://ethereum-sepolia-rpc.publicnode.com';
const MIXER_ADDRESS  = '0xba57f4a7Bc7AEcEda43Be5008bbAc94d39ee6179';
const ASSET_ID_HEX   = 'd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b';
const DENOM_WEI      = 10000000000000000n;   // 0.01 ETH (Alice's deposit + 0.01 pool)
const UNIT_SCALE     = 10000000000n;
const DENOM_TACIT    = DENOM_WEI / UNIT_SCALE;  // 10000000
const DENOM_WEI_BOB  = 1000000000000000n;    // 0.001 ETH (Bob's import + burn + withdraw)
const DENOM_TACIT_BOB = DENOM_WEI_BOB / UNIT_SCALE;  // 100000
const NETWORK_TAG    = 0x01;
const TETH_CHAIN_ID  = 11155111n;
const POOL_TREE_DEPTH= 20;
const T_BRIDGE_DEPOSIT = 0x60;
const T_BRIDGE_BURN    = 0x61;
const T_BRIDGE_ROTATE  = 0x62;
const T_BRIDGE_EXPORT  = 0x63;
const T_BRIDGE_IMPORT  = 0x64;
const BN254_FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SECP_N           = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const BRIDGE_DEPOSIT_DOMAIN = new TextEncoder().encode('tacit-bridge-deposit-v1');
const BRIDGE_BURN_DOMAIN    = new TextEncoder().encode('tacit-bridge-burn-v1');
const BRIDGE_ROTATE_DOMAIN  = new TextEncoder().encode('tacit-bridge-rotate-v1');
const BRIDGE_EXPORT_DOMAIN  = new TextEncoder().encode('tacit-bridge-export-v1');
const BRIDGE_IMPORT_DOMAIN  = new TextEncoder().encode('tacit-bridge-import-v1');
const CEREMONY_HASH       = '1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d';
const WITHDRAW_WASM_PATH  = '/Users/z/tacit/dapp/vendor/withdraw.wasm';
const STATE_FILE          = process.env.STATE_FILE || '/tmp/3b-state.json';
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

// ─── Pedersen ──────────────────────────────────────────────────────
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
function _reduceModField(h32) { return bigintToBytes32(bytes32ToBigint(h32) % BN254_FIELD_SIZE); }
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
function computeBridgeRotateBindHash(networkTag, assetId, denomTacitBytes, merkleRoot, nullifierHash, newCommitment, rLeaf) {
  const chainId32 = bigintToBytes32(TETH_CHAIN_ID);
  const mixerAddr = hexToBytes(MIXER_ADDRESS.replace(/^0x/i,'').padStart(40,'0'));
  return _reduceModField(sha256(concatBytes(
    BRIDGE_ROTATE_DOMAIN, chainId32, mixerAddr, new Uint8Array([networkTag & 0xff]),
    assetId, denomTacitBytes, merkleRoot, nullifierHash, newCommitment, rLeaf,
  )));
}
function computeBridgeExportBindHash(networkTag, assetId, denomTacitBytes, merkleRoot, nullifierHash, recipientCommit, rLeaf) {
  const chainId32 = bigintToBytes32(TETH_CHAIN_ID);
  const mixerAddr = hexToBytes(MIXER_ADDRESS.replace(/^0x/i,'').padStart(40,'0'));
  return _reduceModField(sha256(concatBytes(
    BRIDGE_EXPORT_DOMAIN, chainId32, mixerAddr, new Uint8Array([networkTag & 0xff]),
    assetId, denomTacitBytes, merkleRoot, nullifierHash, recipientCommit, rLeaf,
  )));
}

// ─── Stealth helpers (for export's spendable tETH UTXO at vout 1) ──
function _deriveBridgeWithdrawStealthBlinding(privkey, secretBytes) {
  const out = hmac(sha256, privkey, concatBytes(
    new TextEncoder().encode('tacit-bridge-withdraw-stealth-v1'),
    secretBytes,
  ));
  return bytes32ToBigint(out) % SECP_N;
}
function computeStealthCommit({ underlyingPub, blinding }) {
  if (underlyingPub.length !== 33) throw new Error('underlyingPub 33');
  const Pt = secp.ProjectivePoint.fromHex(hex(underlyingPub));
  const commitPt = Pt.add(G.multiply(blinding));
  if (commitPt.equals(ZERO)) throw new Error('stealth zero');
  return commitPt.toRawBytes(true);
}
function computeStealthTweakedSk({ underlyingPriv, blinding }) {
  const d = BigInt('0x' + hex(underlyingPriv));
  const tweaked = (d + blinding) % SECP_N;
  let h = tweaked.toString(16); while (h.length < 64) h = '0' + h;
  return hexToBytes(h);
}

// ─── Envelope encoders ──────────────────────────────────────────────
function encodeTBridgeDepositPayload({ networkTag, assetId, denomTacit, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf, bindHash, proof }) {
  return concatBytes(
    new Uint8Array([T_BRIDGE_DEPOSIT, networkTag & 0xff]),
    assetId, denomTacit, ethRoot, nullifierHash, recipientCommit, leafHash, rLeaf, bindHash,
    new Uint8Array([proof.length & 0xff, (proof.length >> 8) & 0xff]),
    proof,
  );
}
function encodeTBridgeRotatePayload({ networkTag, assetId, denomTacit, merkleRoot, nullifierHash, newCommitment, rLeaf, bindHash, proof }) {
  return concatBytes(
    new Uint8Array([T_BRIDGE_ROTATE, networkTag & 0xff]),
    assetId, denomTacit, merkleRoot, nullifierHash, newCommitment, rLeaf, bindHash,
    new Uint8Array([proof.length & 0xff, (proof.length >> 8) & 0xff]),
    proof,
  );
}
function encodeTBridgeExportPayload({ networkTag, assetId, denomTacit, merkleRoot, nullifierHash, recipientCommit, rLeaf, bindHash, proof }) {
  return concatBytes(
    new Uint8Array([T_BRIDGE_EXPORT, networkTag & 0xff]),
    assetId, denomTacit, merkleRoot, nullifierHash, recipientCommit, rLeaf, bindHash,
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

// ─── Eth tree (poseidon depth 20) ──────────────────────────────────
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

async function fetchSepoliaDeposits() {
  const depositSig = keccak_256(new TextEncoder().encode('Deposit(bytes32,bytes32,uint256,uint256)'));
  const poolId = keccak_256(concatBytes(hexToBytes(ASSET_ID_HEX), bigintToBytes32(DENOM_WEI)));
  const logs = await ethCall('eth_getLogs', [{
    address: MIXER_ADDRESS, fromBlock: '0xa7418a', toBlock: 'latest',
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
    `https://ipfs.io/ipfs/${state.head_cid}`,
  ];
  for (const gw of gws) {
    try {
      console.log(`  trying ${gw.split('//')[1].split('/')[0]}...`);
      const rr = await fetch(gw, { headers: { Accept: 'application/octet-stream' } });
      if (!rr.ok) { console.log(`    HTTP ${rr.status}`); continue; }
      const buf = new Uint8Array(await rr.arrayBuffer());
      if (buf.length < 256 || buf[0] !== 0x7a || buf[1] !== 0x6b || buf[2] !== 0x65 || buf[3] !== 0x79) continue;
      console.log(`    zkey OK (${buf.length} bytes)`);
      return buf;
    } catch (e) { console.log(`    ${e.message}`); }
  }
  throw new Error('all IPFS gateways failed');
}

// ─── Signet helpers (shared single wallet) ─────────────────────────
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
  const chk = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = []; for (let i = 0; i < 6; i++) checksum.push((chk >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data5, ...checksum].map(i => CS[i]).join('');
}
function getSignetAddress() {
  return bech32Encode('tb', 0, [...hash160(compressedPubkey(SIGNET_PRIVKEY))]);
}
function p2wpkhScript(pubkey) {
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.from(hash160(pubkey))]);
}

// ─── Build + sign + broadcast single OP_RETURN + (optional stealth) + change tx ─
async function broadcastWithOpReturn(privHex, envelope, stealthRecipPub = null) {
  const pubkey = compressedPubkey(privHex);
  const pkh = hash160(pubkey);
  const addr = getSignetAddress();

  const utxoR = await fetch(`${MEMPOOL_API}/address/${addr}/utxo`);
  const allUtxos = await utxoR.json();
  if (!allUtxos.length) throw new Error('no signet UTXO');
  // Pick the largest UTXO across confirmed+mempool, so we can chain through
  // unconfirmed change from previous steps in this same script run.
  const utxo = allUtxos.sort((a, b) => b.value - a.value)[0];
  console.log(`UTXO: ${utxo.txid.slice(0,16)}...:${utxo.vout} = ${utxo.value} sats (confirmed=${utxo.status?.confirmed})`);

  const opLen = envelope.length;
  const opRet = Buffer.concat([
    Buffer.from([0x6a, 0x4d, opLen & 0xff, (opLen >> 8) & 0xff]),
    Buffer.from(envelope),
  ]);
  // Stealth output (for export): DUST P2WPKH(stealthRecipPub) at vout 1 — becomes the spendable tETH UTXO
  const stealthValue = stealthRecipPub ? DUST_LIMIT : 0;
  const change = utxo.value - TX_FEE_SATS - stealthValue;
  if (change < DUST_LIMIT) throw new Error(`change ${change} < dust`);

  const outputs = [
    { value: writeU64LE(0), spk: opRet },
    ...(stealthRecipPub ? [{ value: writeU64LE(DUST_LIMIT), spk: p2wpkhScript(stealthRecipPub) }] : []),
    { value: writeU64LE(change), spk: p2wpkhScript(pubkey) },
  ];
  const version = writeU32LE(2);
  const sequence = writeU32LE(0xfffffffd);
  const locktime = writeU32LE(0);
  const prevTxid = Buffer.from(utxo.txid, 'hex').reverse();
  const prevVout = writeU32LE(utxo.vout);

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
  const toCanonicalIntBytes = bn => {
    let h = bn.toString(16); if (h.length % 2) h = '0' + h;
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

  const txParts = [
    version, Buffer.from([0x00, 0x01]),
    writeVarInt(1), prevTxid, prevVout, writeVarInt(0), sequence,
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

// ─── deposit (Alice, 0.1 ETH on Sepolia) ───────────────────────────
async function cmdDeposit() {
  const state = loadState();
  if (state.depositCommitment) console.log('  overwriting existing state');
  const aliceSecretEth = randomBytes(32);
  const alicePreimageEth = randomBytes(32);
  const aliceSecretPool = randomBytes(32);
  const alicePreimagePool = randomBytes(32);
  const bobSecretPool = randomBytes(32);
  const bobPreimagePool = randomBytes(32);

  const depositCommitment = computePoolLeafCommitment(aliceSecretEth, alicePreimageEth, DENOM_TACIT);
  const alicePoolLeaf = computePoolLeafCommitment(aliceSecretPool, alicePreimagePool, DENOM_TACIT);
  const bobPoolLeaf   = computePoolLeafCommitment(bobSecretPool, bobPreimagePool, DENOM_TACIT);

  const newState = {
    aliceSecretEth: hex(aliceSecretEth),
    alicePreimageEth: hex(alicePreimageEth),
    aliceSecretPool: hex(aliceSecretPool),
    alicePreimagePool: hex(alicePreimagePool),
    bobSecretPool: hex(bobSecretPool),
    bobPreimagePool: hex(bobPreimagePool),
    depositCommitment: hex(depositCommitment),
    alicePoolLeaf: hex(alicePoolLeaf),
    bobPoolLeaf: hex(bobPoolLeaf),
    denomTacit: DENOM_TACIT.toString(),
    denomWei: DENOM_WEI.toString(),
  };
  saveState(newState);
  console.log(`depositCommitment: 0x${hex(depositCommitment)}`);
  console.log(`alicePoolLeaf:     0x${hex(alicePoolLeaf)}  (pre-rotate)`);
  console.log(`bobPoolLeaf:       0x${hex(bobPoolLeaf)}    (post-rotate)`);

  const PK = process.env.DEPLOYER_PRIVATE_KEY;
  if (!PK) throw new Error('DEPLOYER_PRIVATE_KEY env required');
  console.log(`depositing 0.1 ETH on Sepolia mixer ${MIXER_ADDRESS}`);
  const result = execSync(
    `cast send ${MIXER_ADDRESS} 'deposit(bytes32,uint256)' 0x${hex(depositCommitment)} ${DENOM_WEI} --value ${DENOM_WEI} --rpc-url ${SEPOLIA_RPC} --private-key ${PK} 2>&1`,
    { encoding: 'utf8' }
  );
  const txMatch = result.match(/transactionHash\s+(0x[a-fA-F0-9]+)/);
  newState.depositTxid = txMatch?.[1];
  saveState(newState);
  console.log(`deposit tx: ${newState.depositTxid}`);
}

// ─── mint (Alice, 0.1 tETH on signet) ──────────────────────────────
async function cmdMint() {
  const state = loadState();
  if (!state.depositCommitment) throw new Error('no deposit');

  const deposits = await fetchSepoliaDeposits();
  console.log(`Sepolia deposits in 0.1 ETH pool: ${deposits.length}`);
  const myCommitHex = state.depositCommitment.toLowerCase();
  const myIdx = deposits.findIndex(d => d.commitment.toLowerCase() === myCommitHex);
  if (myIdx < 0) throw new Error('our deposit not in eth tree — wait');
  console.log(`my deposit at leafIndex ${deposits[myIdx].leafIndex}`);

  const ethTree = buildEthTree(deposits.map(d => d.commitment));
  const ethProof = ethTree.getProof(deposits[myIdx].leafIndex);

  const poolId = keccak_256(concatBytes(hexToBytes(ASSET_ID_HEX), bigintToBytes32(DENOM_WEI)));
  const onchainRoot = await ethCall('eth_call', [{ to: MIXER_ADDRESS, data: '0x' + 'ee59a615' + bytesToHex(poolId) }, 'latest']);
  if (onchainRoot.toLowerCase() !== ('0x' + bytesToHex(ethTree.root)).toLowerCase()) {
    throw new Error(`eth tree root mismatch`);
  }
  console.log(`eth tree root matches on-chain ✓`);

  const secretEth = hexToBytes(state.aliceSecretEth);
  const preimageEth = hexToBytes(state.alicePreimageEth);
  const nullifierHashEth = computeNullifierHash(preimageEth);
  const rLeaf = poseidonHash(secretEth, preimageEth);
  const rLeafBig = bytes32ToBigint(rLeaf) % SECP_N;
  const recipientCommit = pedersenCommit(DENOM_TACIT, rLeafBig).toRawBytes(true);
  const alicePoolLeaf = hexToBytes(state.alicePoolLeaf);
  const ethRootBytes = ethTree.root;
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const denomTacitBytes = bigintToBytes32(DENOM_TACIT);

  const bindHash = computeBridgeDepositBindHash(
    NETWORK_TAG, assetIdBytes, denomTacitBytes, ethRootBytes,
    nullifierHashEth, recipientCommit, alicePoolLeaf, rLeaf,
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

  const zkeyBytes = await fetchHeadZkeyBytes();
  const wasmBytes = new Uint8Array(fs.readFileSync(WITHDRAW_WASM_PATH));
  console.log('mint proof…');
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(proverInput, wasmBytes, zkeyBytes);
  console.log(`proof done in ${((Date.now() - t0)/1000).toFixed(1)}s`);
  const proofBytes = _serializeGroth16Proof(proof);

  const payload = encodeTBridgeDepositPayload({
    networkTag: NETWORK_TAG, assetId: assetIdBytes, denomTacit: denomTacitBytes,
    ethRoot: ethRootBytes, nullifierHash: nullifierHashEth, recipientCommit,
    leafHash: alicePoolLeaf, rLeaf, bindHash, proof: proofBytes,
  });
  console.log(`mint envelope ${payload.length} bytes`);
  const { revealTxid: txid } = await cx.broadcastTaprootEnvelope({
    envelope: payload,
    signerPriv: hexToBytes(SIGNET_PRIVKEY), signerPub: compressedPubkey(SIGNET_PRIVKEY),
    address: getSignetAddress(), mempoolApi: MEMPOOL_API,
  });
  state.mintTxid = txid;
  saveState(state);
  console.log(`mint txid: ${txid}`);
}

// ─── export (Alice releases her 0.1 tETH leaf as stealth tETH UTXO at vout 1) ─
async function cmdExport() {
  const state = loadState();
  if (!state.mintTxid) throw new Error('no mint');

  // Pool tree for the 0.1 ETH pool just before our export = [alicePoolLeaf at 0]
  const tree = buildEthTree([state.alicePoolLeaf]);
  const mp = tree.getProof(0);
  const merkleRoot = tree.root;

  const secret = hexToBytes(state.aliceSecretPool);
  const preimage = hexToBytes(state.alicePreimagePool);
  const rLeaf = poseidonHash(secret, preimage);
  const rLeafBig = bytes32ToBigint(rLeaf) % SECP_N;
  const recipientCommit = pedersenCommit(DENOM_TACIT, rLeafBig).toRawBytes(true);
  const nullifierHash = computeNullifierHash(preimage);
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const denomTacitBytes = bigintToBytes32(DENOM_TACIT);

  const bindHash = computeBridgeExportBindHash(
    NETWORK_TAG, assetIdBytes, denomTacitBytes, merkleRoot,
    nullifierHash, recipientCommit, rLeaf,
  );

  const proverInput = {
    root: bytes32ToBigint(merkleRoot).toString(),
    nullifier_hash: bytes32ToBigint(nullifierHash).toString(),
    denomination: DENOM_TACIT.toString(),
    r_leaf: bytes32ToBigint(rLeaf).toString(),
    bind_hash: bytes32ToBigint(bindHash).toString(),
    secret: bytes32ToBigint(secret).toString(),
    nullifier_preimage: bytes32ToBigint(preimage).toString(),
    path_elements: mp.pathElements.map(e => e.toString()),
    path_indices: mp.pathIndices,
  };

  const zkeyBytes = await fetchHeadZkeyBytes();
  const wasmBytes = new Uint8Array(fs.readFileSync(WITHDRAW_WASM_PATH));
  console.log('export proof…');
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(proverInput, wasmBytes, zkeyBytes);
  console.log(`proof done in ${((Date.now() - t0)/1000).toFixed(1)}s`);
  const proofBytes = _serializeGroth16Proof(proof);

  const payload = encodeTBridgeExportPayload({
    networkTag: NETWORK_TAG, assetId: assetIdBytes, denomTacit: denomTacitBytes,
    merkleRoot, nullifierHash, recipientCommit, rLeaf, bindHash, proof: proofBytes,
  });
  console.log(`export envelope ${payload.length} bytes`);

  // Stealth pubkey for the spendable tETH UTXO at vout 1
  const stealthBlinding = _deriveBridgeWithdrawStealthBlinding(hexToBytes(SIGNET_PRIVKEY), hexToBytes(state.aliceSecretPool));
  const stealthPub = computeStealthCommit({ underlyingPub: compressedPubkey(SIGNET_PRIVKEY), blinding: stealthBlinding });

  // EXPORT (0x63, ~485B) via Taproot reveal; the spendable stealth tETH UTXO is
  // vout 0 (where the guest registers the export UTXO), envelope in the witness.
  const { revealTxid: txid } = await cx.broadcastTaprootEnvelope({
    envelope: payload,
    signerPriv: hexToBytes(SIGNET_PRIVKEY), signerPub: compressedPubkey(SIGNET_PRIVKEY),
    address: getSignetAddress(), mempoolApi: MEMPOOL_API,
    extraRevealOutputs: [{ value: cx.DUST, script: cx.p2wpkhScript(stealthPub) }],
  });
  state.exportTxid = txid;
  state.exportStealthBlinding = stealthBlinding.toString();
  state.exportStealthPub = hex(stealthPub);
  state.exportMerkleRoot = hex(merkleRoot);
  state.exportNullifierHash = hex(nullifierHash);
  state.exportRLeaf = hex(rLeaf);
  state.exportRecipientCommit = hex(recipientCommit);
  saveState(state);
  console.log(`export txid: ${txid}`);
  console.log(`spendable tETH UTXO: ${txid}:0 (stealth pub ${hex(stealthPub).slice(0,16)}...)`);
  console.log(`amount = ${DENOM_TACIT} tacit-units (0.1 tETH)`);
}

// ─── cxfer (Alice splits 0.1 tETH UTXO into [Bob 0.001, Alice 0.099, padding, padding]) ─
// Two-stage commit+reveal taproot tx with BPP+ rangeproof + Schnorr kernel sig.
async function cmdCxfer() {
  const state = loadState();
  if (!state.exportTxid) throw new Error('no export');

  // Alice's signet wallet
  const aliceSignetPriv = hexToBytes(SIGNET_PRIVKEY);
  const aliceSignetPub = compressedPubkey(SIGNET_PRIVKEY);
  const aliceXOnly = aliceSignetPub.slice(1);

  // Bob: fresh keypair just for this test
  const bobBtcPriv = randomBytes(32);
  const bobBtcPub = secp.getPublicKey(bobBtcPriv, true);
  state.bobBtcPriv = hex(bobBtcPriv);
  state.bobBtcPub = hex(bobBtcPub);

  // Stealth-input spending key for the export's tETH UTXO at exportTxid:1
  const stealthBlinding = BigInt(state.exportStealthBlinding);
  const stealthTweakedSk = (() => {
    const d = BigInt('0x' + hex(aliceSignetPriv));
    let h = ((d + stealthBlinding) % cx.SECP_N).toString(16);
    while (h.length < 64) h = '0' + h;
    return cx.hexToBytes(h);
  })();
  const stealthPub = hexToBytes(state.exportStealthPub);

  // Amount channel: sender's amount-channel priv = stealthTweakedSk (matches recipient's ECDH).
  const amountChannelSenderPriv = stealthTweakedSk;

  // Anchor = first asset input's outpoint reversed-txid || vout LE
  const exportTxidBytes = hexToBytes(state.exportTxid);
  const anchorBytes = cx.concatBytes(cx.reverseBytes(exportTxidBytes), (() => {
    const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, 1 >>> 0, true); return b;
  })());

  // Amounts (tacit-units, u64)
  const aBob   = 100000n;    // 0.001 tETH (unchanged)
  const aAlice = 900000n;   // 0.009 tETH (Alice change)
  const aPad   = 0n;
  const inAmt  = 1000000n;   // 0.01 tETH (export's commit amount)
  const K = 1;               // 1 recipient (Bob)
  const m = 4;               // smallest m ∈ {2,4,8} for K=1 + 1 change = 2 outs; we use m=4 for safety
  console.log(`amounts: Bob ${aBob}, Alice change ${aAlice}, padding ${aPad}×${m-K-1}`);

  // Per-vout blindings + keystreams
  const blindings = [];
  const keystreams = [];
  // Bob (vout 0): ECDH via senderPriv → bobPub
  blindings.push(cx.deriveBlinding(amountChannelSenderPriv, bobBtcPub, anchorBytes, 0));
  keystreams.push(cx.deriveAmountKeystreamECDH(amountChannelSenderPriv, bobBtcPub, anchorBytes, 0));
  // Alice change (vout K=1): self
  blindings.push(cx.deriveChangeBlinding(aliceSignetPriv, anchorBytes, K));
  keystreams.push(cx.deriveAmountKeystreamSelf(aliceSignetPriv, anchorBytes, K));
  // Padding (vouts K+1..m-1): self
  for (let v = K + 1; v < m; v++) {
    blindings.push(cx.deriveChangeBlinding(aliceSignetPriv, anchorBytes, v));
    keystreams.push(cx.deriveAmountKeystreamSelf(aliceSignetPriv, anchorBytes, v));
  }
  const amounts = [aBob, aAlice, aPad, aPad];
  if (amounts.reduce((s, a) => s + a, 0n) !== inAmt) throw new Error('amount conservation broken');

  // Pedersen commitments + BPP+ rangeproof
  console.log('BPP+ range proof (~5s)…');
  const t0 = Date.now();
  const { proof: rangeproof, commitments } = cx.bppProveAmounts(amounts, blindings);
  console.log(`proof ${rangeproof.length} bytes in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  const commitmentBytesList = commitments.map(cx.pointToBytes);

  // Encrypted amounts
  const cts = amounts.map((a, i) => cx.encryptAmount(a, keystreams[i]));

  // Kernel sig: excess = Σ r_out − Σ r_in. inBlindingSum = rLeafBig from export
  const inBlindingSum = BigInt(state.exportRLeaf
    ? BigInt('0x' + state.exportRLeaf) % cx.SECP_N
    : 0n);
  // Actually rLeafBig is poseidon-derived; from export state we stored rLeaf as 32 bytes
  const rLeafBytes = hexToBytes(state.exportRLeaf);
  const rLeafBig = cx.bytes32ToBigint(rLeafBytes) % cx.SECP_N;
  const blindingSum = blindings.reduce((s, b) => cx.modN(s + b), 0n);
  const excess = cx.modN(blindingSum - rLeafBig);
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const kernelMsg = cx.computeKernelMsg(assetIdBytes, [{ txid: state.exportTxid, vout: 1 }], commitmentBytesList);
  const kernelSig = cx.signSchnorr(kernelMsg, cx.bigintToBytes32(excess));

  // CXFER BPP envelope payload
  const cxferPayload = cx.encodeCXferBppPayload({
    assetId: assetIdBytes, kernelSig,
    outputs: amounts.map((_, i) => ({ commitment: commitmentBytesList[i], encryptedAmount: cts[i] })),
    rangeproof,
  });
  console.log(`CXFER payload ${cxferPayload.length} bytes`);

  // Tapscript envelope + P2TR
  const envelopeScript = cx.encodeEnvelopeScript(aliceXOnly, cxferPayload);
  const leaf = cx.tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = cx.tweakedOutputKey(cx.TAP_NUMS, leaf);
  const p2trSpk = cx.p2trScript(Q_xonly);
  const cb = cx.controlBlock(cx.TAP_NUMS, parity);

  // ─── Build commit tx: 1 sats input → [P2TR (envelope), change P2WPKH(Alice)]
  const addr = getSignetAddress();
  const utxoR = await fetch(`${MEMPOOL_API}/address/${addr}/utxo`);
  const utxos = await utxoR.json();
  if (!utxos.length) throw new Error('no signet UTXOs');
  // Pick the largest sats UTXO that isn't the export's stealth UTXO (vout 1 = DUST).
  // Consider confirmed AND mempool — needed when chaining off the just-broadcast export.
  const fundingUtxo = utxos.filter(u => !(u.txid === state.exportTxid && u.vout === 0))
    .filter(u => u.value > cx.DUST)
    .sort((a, b) => b.value - a.value)[0];
  if (!fundingUtxo) throw new Error('no funding UTXO ≠ asset UTXO');
  console.log(`funding UTXO: ${fundingUtxo.txid.slice(0,16)}…:${fundingUtxo.vout} = ${fundingUtxo.value} sats`);

  // Fee approximations (signet, 1 sat/vbyte)
  const REVEAL_FEE = 2000;  // ~1300 vbyte tx, generous
  const COMMIT_FEE = 200;   // ~150 vbyte tx
  const commitValue = cx.DUST * m + REVEAL_FEE; // value put into P2TR; reveal will use this + asset DUST
  const commitChange = fundingUtxo.value - commitValue - COMMIT_FEE;
  if (commitChange < cx.DUST) throw new Error(`commit change ${commitChange} < dust`);
  console.log(`commit: ${fundingUtxo.value} sats → P2TR ${commitValue} + change ${commitChange} - fee ${COMMIT_FEE}`);

  const wpkhSpkAlice = cx.p2wpkhScript(aliceSignetPub);
  const commitTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: fundingUtxo.txid, vout: fundingUtxo.vout, sequence: 0xfffffffd, witness: [] }],
    outputs: [
      { value: commitValue, script: p2trSpk },
      { value: commitChange, script: wpkhSpkAlice },
    ],
  };
  commitTx.inputs[0].witness = cx.signP2wpkhInputWithKey(commitTx, 0, fundingUtxo.value, aliceSignetPriv, aliceSignetPub);
  const commitTxHex = cx.bytesToHex(cx.serializeTx(commitTx));
  const commitTxid = cx.computeTxid(commitTx);
  console.log(`commit txid: ${commitTxid}`);

  // ─── Build reveal tx
  // input 0: commit P2TR (script-path spend)
  // input 1: asset = export stealth UTXO at exportTxid:1 (P2WPKH, stealth-tweaked sk)
  // outputs: m × DUST P2WPKH
  const wpkhSpkBob = cx.p2wpkhScript(bobBtcPub);
  const revealOuts = [
    { value: cx.DUST, script: wpkhSpkBob },         // vout 0: Bob
    { value: cx.DUST, script: wpkhSpkAlice },       // vout 1: Alice change
    { value: cx.DUST, script: wpkhSpkAlice },       // vout 2: padding
    { value: cx.DUST, script: wpkhSpkAlice },       // vout 3: padding
  ];
  const revealTx = {
    version: 2, locktime: 0,
    inputs: [
      { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
      { txid: state.exportTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
    ],
    outputs: revealOuts,
  };
  // Prevouts for sighash
  const prevoutsReveal = [
    { value: commitValue, script: p2trSpk },                              // commit P2TR
    { value: cx.DUST, script: cx.p2wpkhScript(stealthPub) },              // export stealth UTXO
  ];
  // Sign input 0 (script-path, signs over the envelope script with aliceSignetPriv since envelope's signing pubkey = aliceXOnly)
  revealTx.inputs[0].witness = cx.signTaprootScriptPathInputWithKey(revealTx, prevoutsReveal, envelopeScript, cb, aliceSignetPriv, 0);
  // Sign input 1 (P2WPKH, stealth-tweaked sk + stealthPub)
  revealTx.inputs[1].witness = cx.signP2wpkhInputWithKey(revealTx, 1, cx.DUST, stealthTweakedSk, stealthPub);

  const revealTxHex = cx.bytesToHex(cx.serializeTx(revealTx));
  const revealTxid = cx.computeTxid(revealTx);
  console.log(`reveal txid: ${revealTxid}, tx ${revealTxHex.length/2} bytes`);

  // Broadcast (commit first, then reveal)
  console.log('broadcasting commit…');
  const br1 = await fetch(`${MEMPOOL_API}/tx`, { method: 'POST', body: commitTxHex });
  const body1 = await br1.text();
  if (!br1.ok) throw new Error(`commit broadcast: ${br1.status} ${body1}`);
  console.log(`commit broadcast: ${body1.trim()}`);

  console.log('broadcasting reveal…');
  const br2 = await fetch(`${MEMPOOL_API}/tx`, { method: 'POST', body: revealTxHex });
  const body2 = await br2.text();
  if (!br2.ok) throw new Error(`reveal broadcast: ${br2.status} ${body2}`);
  console.log(`reveal broadcast: ${body2.trim()}`);

  state.cxferCommitTxid = commitTxid;
  state.cxferRevealTxid = revealTxid;
  state.bobCxferVout = 0;
  state.bobCxferBlinding = blindings[0].toString();
  state.bobCxferAmount = aBob.toString();
  saveState(state);
  console.log(`CXFER complete: Bob receives ${aBob} tacit-units (0.001 tETH) at ${revealTxid}:0`);

  // Auto-publish openings — the SP1 prover needs (amount, blinding) for every
  // CXFER output to verify Pedersen conservation; without them the guest skips
  // the CXFER → recipients can't import + redeem ETH. Mirrors the dapp's
  // auto-publish behavior (dapp/tacit.js buildAndBroadcastCXferMulti). Best-
  // effort: failure here doesn't fail the broadcast (the user can retry via
  // the explicit `publish-openings` subcommand below). Audit task #33.
  try {
    await cmdPublishCxferOpenings();
  } catch (e) {
    console.warn(`auto-publish failed (${e?.message || e}); run "publish-openings" manually before the prover cycle`);
  }
}

// ─── publish-openings (worker needs (amount, blinding) for every CXFER output) ─
// The SP1 bridge guest verifies Pedersen conservation on CXFER tx outputs by
// fetching openings from the worker (see scripts/fetch-cxfer-openings.py). The
// dapp auto-publishes after broadcasting CXFER (dapp/tacit.js
// buildAndBroadcastCXferMulti); the test harness must do the same or the
// guest treats every output as untracked → recipients (Bob) can't import +
// redeem ETH. Run AFTER cxfer, BEFORE the prover cycle that covers the CXFER
// block. Audit task #33.
async function cmdPublishCxferOpenings() {
  const state = loadState();
  if (!state.cxferRevealTxid) throw new Error('no cxferRevealTxid — run "cxfer" first');
  if (!state.exportTxid) throw new Error('no exportTxid — needed to re-derive anchor');
  if (!state.bobBtcPub) throw new Error('no bobBtcPub in state');

  const aliceSignetPriv = hexToBytes(SIGNET_PRIVKEY);
  const aliceSignetPub = compressedPubkey(SIGNET_PRIVKEY);
  const bobBtcPub = hexToBytes(state.bobBtcPub);
  const stealthBlinding = BigInt(state.exportStealthBlinding);
  // Stealth-tweaked spending key for the export UTXO that fed CXFER.
  const stealthTweakedSk = (() => {
    const d = BigInt('0x' + hex(aliceSignetPriv));
    let h = ((d + stealthBlinding) % cx.SECP_N).toString(16);
    while (h.length < 64) h = '0' + h;
    return hexToBytes(h);
  })();
  // CXFER anchor = export's outpoint reversed-txid || vout LE (matches cxfer build).
  const exportTxidBytes = hexToBytes(state.exportTxid);
  const anchorBytes = concatBytes(cx.reverseBytes(exportTxidBytes), (() => {
    const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, 1, true); return b;
  })());

  // Re-derive amounts + blindings + owners exactly as cxfer build did them.
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const outputs = [
    { vout: 0, amount: 100000n,  blinding: cx.deriveBlinding(stealthTweakedSk, bobBtcPub, anchorBytes, 0), ownerPub: bobBtcPub,     ownerPriv: hexToBytes(state.bobBtcPriv) },
    { vout: 1, amount: 900000n,  blinding: cx.deriveChangeBlinding(aliceSignetPriv, anchorBytes, 1),       ownerPub: aliceSignetPub, ownerPriv: aliceSignetPriv },
    { vout: 2, amount: 0n,       blinding: cx.deriveChangeBlinding(aliceSignetPriv, anchorBytes, 2),       ownerPub: aliceSignetPub, ownerPriv: aliceSignetPriv },
    { vout: 3, amount: 0n,       blinding: cx.deriveChangeBlinding(aliceSignetPriv, anchorBytes, 3),       ownerPub: aliceSignetPub, ownerPriv: aliceSignetPriv },
  ];

  // openingMsg: sha256("tacit-opening-v1" || asset_id || txid_be || vout_le ||
  //   amount_le || blinding_be || owner_pub_compressed). Matches the worker
  //   handleUtxoOpeningPost verifier exactly (worker/src/index.js:14953).
  function openingMsg(asset, txidHex, vout, amount, blindingBytes, ownerPubBytes) {
    const txidBE = cx.reverseBytes(hexToBytes(txidHex));
    const voutLE = new Uint8Array(4); new DataView(voutLE.buffer).setUint32(0, vout, true);
    const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
    return sha256(concatBytes(
      new TextEncoder().encode('tacit-opening-v1'),
      asset, txidBE, voutLE, amountLE, blindingBytes, ownerPubBytes,
    ));
  }

  const url = `${WORKER_BASE}/utxos/${state.cxferRevealTxid}/`;
  console.log(`publishing ${outputs.length} CXFER openings to worker for ${state.cxferRevealTxid}…`);
  for (const o of outputs) {
    const blindingBytes = bigintToBytes32(o.blinding);
    const msg = openingMsg(assetIdBytes, state.cxferRevealTxid, o.vout, o.amount, blindingBytes, o.ownerPub);
    const sig = cx.signSchnorr(msg, o.ownerPriv);
    const body = {
      amount: o.amount.toString(),
      blinding: hex(blindingBytes),
      owner_pubkey: hex(o.ownerPub),
      sig: hex(sig),
    };
    const r = await fetch(`${url}${o.vout}/opening?network=signet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.log(`  vout ${o.vout}: FAILED ${r.status} ${JSON.stringify(j)}`);
    } else {
      console.log(`  vout ${o.vout}: amount=${o.amount} blinding=${hex(blindingBytes).slice(0, 16)}… owner=${hex(o.ownerPub).slice(0, 16)}… ✓`);
    }
  }
  console.log('done — re-run prover cycle covering this block to pick up openings.');
}

// ─── import (Bob brings his 0.001 tETH UTXO back into the 0.001 ETH pool) ─
async function cmdImport() {
  const state = loadState();
  if (!state.cxferRevealTxid) throw new Error('no cxfer');
  if (!state.bobBtcPriv) throw new Error('no bob keys');

  // Bob's pool witness for the 0.001 ETH pool
  const bobSecret = randomBytes(32);
  const bobPreimage = randomBytes(32);
  const bobLeaf = computePoolLeafCommitment(bobSecret, bobPreimage, DENOM_TACIT_BOB);

  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const denomTacitBytes = bigintToBytes32(DENOM_TACIT_BOB);
  // Internal (raw-tx) byte order: the guest stores utxo_set txids from compute_txid
  // (double-sha256, un-reversed) and reads input prev-txids straight from the tx
  // bytes, both internal order — so env_prev_txid must be the reversed display txid,
  // NOT hexToBytes(display). (The dapp's buildAndBroadcastBridgeImport needs the
  // same reversal — validate here first, then mirror.)
  const prevTxidBytes = cx.reverseBytes(hexToBytes(state.cxferRevealTxid));
  const prevVout = 0;

  // bind_hash for import
  const chainId32 = bigintToBytes32(TETH_CHAIN_ID);
  const mixerAddr = hexToBytes(MIXER_ADDRESS.replace(/^0x/i,'').padStart(40,'0'));
  const voutBytes = new Uint8Array(2);
  voutBytes[0] = prevVout & 0xff; voutBytes[1] = (prevVout >> 8) & 0xff;
  const bindHash = _reduceModField(sha256(concatBytes(
    BRIDGE_IMPORT_DOMAIN, chainId32, mixerAddr, new Uint8Array([NETWORK_TAG & 0xff]),
    assetIdBytes, denomTacitBytes, bobLeaf, prevTxidBytes, voutBytes,
  )));

  // T_BRIDGE_IMPORT envelope (no Groth16 — just commitment + bind)
  const payload = concatBytes(
    new Uint8Array([0x64, NETWORK_TAG & 0xff]),  // T_BRIDGE_IMPORT
    assetIdBytes, denomTacitBytes, bobLeaf, bindHash, prevTxidBytes, voutBytes,
  );
  console.log(`import envelope ${payload.length} bytes`);

  // IMPORT (0x64) via Taproot reveal: vin0 = commit P2TR (Alice funds + signs the
  // envelope script-path), vin1 = Bob's tETH UTXO at (cxferRevealTxid, 0) so the
  // guest's extract_input_outpoints match fires. Alice receives the BTC change.
  const bobBtcPriv = hexToBytes(state.bobBtcPriv);
  const bobBtcPub = hexToBytes(state.bobBtcPub);
  const { revealTxid: txid } = await cx.broadcastTaprootEnvelope({
    envelope: payload,
    signerPriv: hexToBytes(SIGNET_PRIVKEY), signerPub: compressedPubkey(SIGNET_PRIVKEY),
    address: getSignetAddress(), mempoolApi: MEMPOOL_API,
    extraRevealInputs: [{
      txid: state.cxferRevealTxid, vout: 0, value: cx.DUST,
      script: cx.p2wpkhScript(bobBtcPub), priv: bobBtcPriv, pub: bobBtcPub,
    }],
  });
  console.log(`import reveal txid ${txid}`);

  state.importTxid = txid;
  state.bobPoolSecret0001 = hex(bobSecret);
  state.bobPoolPreimage0001 = hex(bobPreimage);
  state.bobPoolLeaf0001 = hex(bobLeaf);
  saveState(state);
  console.log(`Bob's 0.001 ETH pool leaf: 0x${hex(bobLeaf)}`);
}

// ─── burn (Bob, 0.001 ETH leaf at idx 1 in 0.001 ETH pool, 3a's leaf at idx 0) ─
async function cmdBurnBob(ethRecipient) {
  const state = loadState();
  if (!state.importTxid) throw new Error('no import');
  if (!ethRecipient || !/^0x[0-9a-fA-F]{40}$/.test(ethRecipient)) throw new Error('need 0xBobEthAddr');

  // 0.001 ETH pool tree at the time of Bob's burn = [3a's poolLeaf at 0, Bob's leaf at 1]
  const POOL_LEAF_3A = '2d6688b305bec3c828995eca04f69f6701f6a8115244077db2cdc20a64363ec3';
  const tree = buildEthTree([POOL_LEAF_3A, state.bobPoolLeaf0001]);
  const mp = tree.getProof(1);
  const merkleRoot = tree.root;

  const secret = hexToBytes(state.bobPoolSecret0001);
  const preimage = hexToBytes(state.bobPoolPreimage0001);
  const rLeaf = poseidonHash(secret, preimage);
  const rLeafBig = bytes32ToBigint(rLeaf) % SECP_N;
  const recipientCommit = pedersenCommit(DENOM_TACIT_BOB, rLeafBig).toRawBytes(true);
  const nullifierHash = computeNullifierHash(preimage);
  const burnNonce = randomBytes(32);
  const ethRecipientBytes = hexToBytes(ethRecipient.replace(/^0x/, ''));
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const denomTacitBytes = bigintToBytes32(DENOM_TACIT_BOB);

  const bindHash = computeBridgeBurnBindHash(
    NETWORK_TAG, assetIdBytes, denomTacitBytes, merkleRoot,
    nullifierHash, recipientCommit, rLeaf, ethRecipientBytes, burnNonce,
  );

  const proverInput = {
    root: bytes32ToBigint(merkleRoot).toString(),
    nullifier_hash: bytes32ToBigint(nullifierHash).toString(),
    denomination: DENOM_TACIT_BOB.toString(),
    r_leaf: bytes32ToBigint(rLeaf).toString(),
    bind_hash: bytes32ToBigint(bindHash).toString(),
    secret: bytes32ToBigint(secret).toString(),
    nullifier_preimage: bytes32ToBigint(preimage).toString(),
    path_elements: mp.pathElements.map(e => e.toString()),
    path_indices: mp.pathIndices,
  };

  const zkeyBytes = await fetchHeadZkeyBytes();
  const wasmBytes = new Uint8Array(fs.readFileSync(WITHDRAW_WASM_PATH));
  console.log('Bob burn proof…');
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(proverInput, wasmBytes, zkeyBytes);
  console.log(`proof done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  const proofBytes = _serializeGroth16Proof(proof);

  const payload = encodeTBridgeBurnPayload({
    networkTag: NETWORK_TAG, assetId: assetIdBytes, denomTacit: denomTacitBytes,
    merkleRoot, nullifierHash, recipientCommit, rLeaf,
    ethRecipient: ethRecipientBytes, burnNonce, bindHash, proof: proofBytes,
  });
  console.log(`Bob burn envelope ${payload.length} bytes`);

  state.bobBurnEthRecipient = ethRecipient.toLowerCase();
  state.bobBurnMerkleRoot = hex(merkleRoot);
  state.bobBurnNullifierHash = hex(nullifierHash);
  state.bobBurnRecipientCommit = hex(recipientCommit);
  state.bobBurnRLeaf = hex(rLeaf);
  state.bobBurnNonce = hex(burnNonce);
  state.bobBurnBindHash = hex(bindHash);
  saveState(state);

  // Bob's BURN (0x61) via Taproot reveal — Alice's wallet funds + signs the
  // commit (the envelope content is Bob's note; the Taproot signer is unrelated).
  const { revealTxid: txid } = await cx.broadcastTaprootEnvelope({
    envelope: payload,
    signerPriv: hexToBytes(SIGNET_PRIVKEY), signerPub: compressedPubkey(SIGNET_PRIVKEY),
    address: getSignetAddress(), mempoolApi: MEMPOOL_API,
  });
  state.bobBurnTxid = txid;
  saveState(state);
  console.log(`Bob burn txid: ${txid}`);
}

// ─── withdraw (Bob's withdrawFromBurn on Sepolia, releases 0.001 ETH) ─
async function cmdWithdrawBob() {
  const state = loadState();
  if (!state.bobBurnTxid) throw new Error('no bob burn');
  if (!state.bobBurnEthRecipient) throw new Error('no burn recipient');

  // Burn block + position
  const statusR = await fetch(`${MEMPOOL_API}/tx/${state.bobBurnTxid}/status`);
  const status = await statusR.json();
  if (!status.confirmed) throw new Error(`bob burn not confirmed yet (block_height=${status.block_height})`);
  const burnBlock = status.block_height;
  console.log(`Bob burn at block ${burnBlock}`);

  // Relay current tip
  const tipHex = await ethCall('eth_call', [{ to: '0x67685fa6b706d8374c174756d5583d93f6bb5670', data: '0x1fd4827a' }, 'latest']);
  const relayTip = parseInt(tipHex, 16);
  console.log(`relay tip: ${relayTip}`);
  if (relayTip < burnBlock + 6) {
    throw new Error(`relay tip ${relayTip} < burn+6 (${burnBlock + 6}); wait for prover to advance`);
  }

  // Block hash + tx position
  const burnBlockHash = await (await fetch(`${MEMPOOL_API}/block-height/${burnBlock}`)).text();
  const txids = await (await fetch(`${MEMPOOL_API}/block/${burnBlockHash}/txids`)).json();
  const txPos = txids.indexOf(state.bobBurnTxid);
  if (txPos < 0) throw new Error('bob burn not in block txids');

  // Raw tx hex
  const rawHex = await (await fetch(`${MEMPOOL_API}/tx/${state.bobBurnTxid}/hex`)).text();

  // Merkle proof
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

  // Headers from burn_block to relay_tip
  let headers = '';
  for (let h = burnBlock; h <= relayTip; h++) {
    const bh = await (await fetch(`${MEMPOOL_API}/block-height/${h}`)).text();
    headers += await (await fetch(`${MEMPOOL_API}/block/${bh}/header`)).text();
  }
  console.log(`headers ${headers.length} chars (${(headers.length/2/80)} blocks)`);

  // cast send mixer.withdrawFromBurn
  const PK = process.env.DEPLOYER_PRIVATE_KEY;
  if (!PK) throw new Error('DEPLOYER_PRIVATE_KEY required');
  const args = [
    `0x4d0102867cd97ff2945fee858fcaa8c0485b68dd`,
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
  state.bobWithdrawTxid = tx_match?.[1];
  saveState(state);
}

// ─── rotate (Alice → Bob, whole note, in-pool) — kept for reference but
// unused in fractional flow ─────────────────────────────────────────
async function cmdRotate() {
  const state = loadState();
  if (!state.mintTxid) throw new Error('no mint');

  // Guest's pool tree for the 0.1 ETH pool just before our rotate = [alicePoolLeaf at 0]
  const tree = buildEthTree([state.alicePoolLeaf]);
  const mp = tree.getProof(0);
  const merkleRoot = tree.root;

  const secret = hexToBytes(state.aliceSecretPool);
  const preimage = hexToBytes(state.alicePreimagePool);
  const rLeaf = poseidonHash(secret, preimage);
  const rLeafBig = bytes32ToBigint(rLeaf) % SECP_N;
  const _recipientCommit = pedersenCommit(DENOM_TACIT, rLeafBig).toRawBytes(true); // unused in rotate envelope
  const nullifierHash = computeNullifierHash(preimage);
  const newCommitment = hexToBytes(state.bobPoolLeaf);
  const assetIdBytes = hexToBytes(ASSET_ID_HEX);
  const denomTacitBytes = bigintToBytes32(DENOM_TACIT);

  const bindHash = computeBridgeRotateBindHash(
    NETWORK_TAG, assetIdBytes, denomTacitBytes, merkleRoot,
    nullifierHash, newCommitment, rLeaf,
  );

  const proverInput = {
    root: bytes32ToBigint(merkleRoot).toString(),
    nullifier_hash: bytes32ToBigint(nullifierHash).toString(),
    denomination: DENOM_TACIT.toString(),
    r_leaf: bytes32ToBigint(rLeaf).toString(),
    bind_hash: bytes32ToBigint(bindHash).toString(),
    secret: bytes32ToBigint(secret).toString(),
    nullifier_preimage: bytes32ToBigint(preimage).toString(),
    path_elements: mp.pathElements.map(e => e.toString()),
    path_indices: mp.pathIndices,
  };

  const zkeyBytes = await fetchHeadZkeyBytes();
  const wasmBytes = new Uint8Array(fs.readFileSync(WITHDRAW_WASM_PATH));
  console.log('rotate proof…');
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(proverInput, wasmBytes, zkeyBytes);
  console.log(`proof done in ${((Date.now() - t0)/1000).toFixed(1)}s`);
  const proofBytes = _serializeGroth16Proof(proof);

  const payload = encodeTBridgeRotatePayload({
    networkTag: NETWORK_TAG, assetId: assetIdBytes, denomTacit: denomTacitBytes,
    merkleRoot, nullifierHash, newCommitment, rLeaf, bindHash, proof: proofBytes,
  });
  console.log(`rotate envelope ${payload.length} bytes`);
  const txid = await broadcastWithOpReturn(SIGNET_PRIVKEY, payload);
  state.rotateTxid = txid;
  state.aliceNullifierHash = hex(nullifierHash);
  state.aliceMerkleRoot = hex(merkleRoot);
  saveState(state);
  console.log(`rotate txid: ${txid}`);
}

// ─── burn (Bob, 0.1 tETH on signet) ────────────────────────────────
async function cmdBurn(ethRecipient) {
  const state = loadState();
  if (!state.rotateTxid) throw new Error('no rotate');
  if (!ethRecipient || !/^0x[0-9a-fA-F]{40}$/.test(ethRecipient)) throw new Error('need Bob 0xEthAddr');

  // After rotate, guest's 0.1 ETH pool tree = [alicePoolLeaf at 0, bobPoolLeaf at 1]
  const tree = buildEthTree([state.alicePoolLeaf, state.bobPoolLeaf]);
  const mp = tree.getProof(1);
  const merkleRoot = tree.root;
  console.log(`Bob's pool merkle proof: idx 1, root ${hex(merkleRoot).slice(0, 16)}...`);

  const secret = hexToBytes(state.bobSecretPool);
  const preimage = hexToBytes(state.bobPreimagePool);
  const rLeaf = poseidonHash(secret, preimage);
  const rLeafBig = bytes32ToBigint(rLeaf) % SECP_N;
  const recipientCommit = pedersenCommit(DENOM_TACIT, rLeafBig).toRawBytes(true);
  const nullifierHash = computeNullifierHash(preimage);
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
    secret: bytes32ToBigint(secret).toString(),
    nullifier_preimage: bytes32ToBigint(preimage).toString(),
    path_elements: mp.pathElements.map(e => e.toString()),
    path_indices: mp.pathIndices,
  };

  const zkeyBytes = await fetchHeadZkeyBytes();
  const wasmBytes = new Uint8Array(fs.readFileSync(WITHDRAW_WASM_PATH));
  console.log('Bob burn proof…');
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

  const txid = await broadcastWithOpReturn(SIGNET_PRIVKEY, payload);
  state.burnTxid = txid;
  saveState(state);
  console.log(`burn txid: ${txid}`);
}

// ─── status ────────────────────────────────────────────────────────
async function cmdStatus() {
  const state = loadState();
  const safe = { ...state };
  for (const k of Object.keys(safe)) {
    if (/secret|preimage|Proof/i.test(k) && typeof safe[k] === 'string' && safe[k].length > 24) {
      safe[k] = safe[k].slice(0, 16) + '...';
    }
  }
  console.log(JSON.stringify(safe, null, 2));
  console.log(`\nsignet: ${getSignetAddress()}`);
  for (const k of ['depositTxid','mintTxid','rotateTxid','burnTxid']) {
    if (!state[k]) continue;
    if (k === 'depositTxid') {
      const r = await ethCall('eth_getTransactionReceipt', [state[k]]);
      console.log(`${k}: status=${r?.status} block=${r?.blockNumber}`);
    } else {
      const r = await fetch(`${MEMPOOL_API}/tx/${state[k]}`);
      if (r.ok) { const t = await r.json(); console.log(`${k}: confirmed=${t.status?.confirmed} block=${t.status?.block_height || 'mempool'}`); }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────
const cmd = process.argv[2];
const arg = process.argv[3];
(async () => {
  try {
    if (cmd === 'deposit') await cmdDeposit();
    else if (cmd === 'mint') await cmdMint();
    else if (cmd === 'export') await cmdExport();
    else if (cmd === 'cxfer') await cmdCxfer();
    else if (cmd === 'publish-openings') await cmdPublishCxferOpenings();
    else if (cmd === 'import') await cmdImport();
    else if (cmd === 'rotate') await cmdRotate();
    else if (cmd === 'burnbob') await cmdBurnBob(arg);
    else if (cmd === 'withdrawbob') await cmdWithdrawBob();
    else if (cmd === 'burn') await cmdBurn(arg);
    else if (cmd === 'status') await cmdStatus();
    else { console.log('Usage: bridge-3b.mjs [deposit|mint|export|rotate|burn 0xAddr|status]'); process.exit(1); }
  } catch (e) {
    console.error('ERROR:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  } finally { process.exit(0); }
})();
