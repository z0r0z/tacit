#!/usr/bin/env node
// Builds a COMPLETE, real burn -> withdraw fixture for the on-chain e2e Foundry
// test (BridgeWithdrawRealProof.t.sol). Everything is bound to a deterministic
// mixer address so the bind_hash the circuit commits to matches the bind_hash
// the deployed mixer recomputes from the envelope:
//   - real ceremony Groth16 proof (ceremony zkey) for a self-consistent pool tree
//   - real burn envelope in the dapp's exact T_BRIDGE_BURN byte layout
//   - real Pedersen recipient commitment (NUMS H, matching secp.rs / the dapp)
//   - bind_hash + burn claim id computed with the exact mixer formulas
//   - a minimal legacy Bitcoin tx carrying the envelope in an OP_RETURN
//
// Run: node tests/gen-withdraw-flow-fixture.mjs
// (mixer address comes from: cast compute-address <DEPLOYER> --nonce 0)

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as snarkjs from '../dapp/circuits/node_modules/snarkjs/main.js';
import { buildPoseidon } from '../dapp/circuits/node_modules/circomlibjs/main.js';
import * as secp from '@noble/secp256k1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRC = path.join(__dirname, '..', 'dapp', 'circuits');
const WASM = path.join(CIRC, 'artifacts', 'withdraw.wasm');
const ZKEY = path.join(CIRC, 'ceremony-bundle', 'withdraw_final.zkey');
const OUT  = path.join(__dirname, '..', 'contracts', 'test', 'fixtures', 'withdraw_flow.json');

// ── Fixed parameters (must match the Foundry test) ──
const MIXER_ADDR  = '0xE8279BE14E9fe2Ad2D8E52E42Ca96Fb33a813BBe'; // cast compute-address 0x..DeaDBeef --nonce 0
const CHAIN_ID    = 11155111n;
const NETWORK_TAG = 0x01;
const ASSET_ID    = 'd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b';
const DENOM_TACIT = 100000000n;          // 1.0 tETH (8 decimals); env[34..66] + circuit denomination
const UNIT_SCALE  = 10n ** 10n;          // ETH 18 -> tacit 8
const WEI_DENOM   = DENOM_TACIT * UNIT_SCALE; // 1e18 = 1 ETH
const ETH_RECIP   = 'cafe000000000000000000000000000000c0ffee';   // 20-byte recipient
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LEVELS = 20;

const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(Buffer.from(p)); return new Uint8Array(h.digest()); };
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const bytesToHex = (b) => Buffer.from(b).toString('hex');
const beBytes = (n, len = 32) => { let h = n.toString(16); h = h.padStart(len * 2, '0'); return hexToBytes(h); };
const concat = (...a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const bToBig = (b) => BigInt('0x' + bytesToHex(b));

// Pedersen NUMS generator H — matches secp.rs / dapp (sha256("tacit-generator-H-v1") + try-increment).
function pedersenH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let c = 0; c < 256; c++) {
    const x = sha256(seed, new Uint8Array([c]));
    try { return secp.ProjectivePoint.fromHex('02' + bytesToHex(x)); } catch {}
  }
  throw new Error('no H');
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const p3 = (a, b, c) => F.toObject(poseidon([a, b, c]));
  const p2 = (a, b) => F.toObject(poseidon([a, b]));
  const p1 = (a) => F.toObject(poseidon([a]));
  const randFr = () => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (i * 37 + 11) & 0xff; b[0] &= 0x3f; return bToBig(b); };

  // Self-consistent 4-leaf tree, withdraw leaf #2 (mirrors prove-sample).
  const secret = randFr(), nullifierPreimage = (randFr() ^ 0x9n);
  const leaves = [];
  for (let i = 0; i < 4; i++) leaves.push(i === 2 ? p3(secret, nullifierPreimage, DENOM_TACIT) : p3(BigInt(i + 1), BigInt(i + 100), DENOM_TACIT));
  const EMPTY = p1(0n);
  const zeros = [EMPTY];
  for (let d = 1; d <= LEVELS; d++) zeros.push(p2(zeros[d - 1], zeros[d - 1]));
  let layer = leaves.slice(); const layers = [layer];
  for (let d = 0; d < LEVELS; d++) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(p2(layer[i], i + 1 < layer.length ? layer[i + 1] : zeros[d]));
    if (next.length === 0) next.push(zeros[d + 1]);
    layer = next; layers.push(layer);
  }
  const root = layer[0];
  const path_elements = [], path_indices = [];
  let idx = 2;
  for (let d = 0; d < LEVELS; d++) {
    const lyr = layers[d];
    path_elements.push(idx % 2 === 0 ? (idx + 1 < lyr.length ? lyr[idx + 1] : zeros[d]) : lyr[idx - 1]);
    path_indices.push(idx % 2); idx = Math.floor(idx / 2);
  }

  const nullifierHash = p1(nullifierPreimage);
  const rLeaf = p2(secret, nullifierPreimage);

  // Real Pedersen recipient commitment: denom*H + (rLeaf mod n)*G, compressed.
  const H = pedersenH();
  const rLeafN = rLeaf % secp.CURVE.n;
  const commitPt = H.multiply(DENOM_TACIT).add(secp.ProjectivePoint.BASE.multiply(rLeafN));
  const recipientCommit = commitPt.toRawBytes(true); // 33 bytes

  const assetId = hexToBytes(ASSET_ID);
  const denom32 = beBytes(DENOM_TACIT);
  const root32 = beBytes(root);
  const nh32 = beBytes(nullifierHash);
  const rLeaf32 = beBytes(rLeaf);
  const ethRecip = hexToBytes(ETH_RECIP);
  const burnNonce = beBytes(0xB0_5E_42n); // deterministic
  const mixer20 = hexToBytes(MIXER_ADDR);
  const chainId32 = beBytes(CHAIN_ID);

  // bind_hash — exact dapp computeBridgeBurnBindHash / mixer _validateBurn formula.
  const bindRaw = sha256(
    new TextEncoder().encode('tacit-bridge-burn-v1'),
    chainId32, mixer20, new Uint8Array([NETWORK_TAG]),
    assetId, denom32, root32, nh32, recipientCommit, rLeaf32, ethRecip, burnNonce,
  );
  const bindHash = bToBig(bindRaw) % FIELD;
  const bindHash32 = beBytes(bindHash);

  // burn claim id — mixer line 316 / guest: sha256(nh || denom || root || recipient(20) || bindHash).
  const claimId = sha256(nh32, denom32, root32, ethRecip, bindHash32);

  // Real ceremony proof.
  const input = {
    root: root.toString(), nullifier_hash: nullifierHash.toString(), denomination: DENOM_TACIT.toString(),
    r_leaf: rLeaf.toString(), bind_hash: bindHash.toString(),
    secret: secret.toString(), nullifier_preimage: nullifierPreimage.toString(),
    path_elements: path_elements.map(String), path_indices,
  };
  console.log('==> fullProve (ceremony zkey)');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const vk = JSON.parse(await fs.readFile(path.join(CIRC, 'ceremony-bundle', 'verification_key.json'), 'utf8'));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error('snarkjs verify failed');

  // proof bytes: dapp _serializeGroth16Proof native order (a, pi_b native, c).
  const proofBytes = concat(
    beBytes(BigInt(proof.pi_a[0])), beBytes(BigInt(proof.pi_a[1])),
    beBytes(BigInt(proof.pi_b[0][0])), beBytes(BigInt(proof.pi_b[0][1])),
    beBytes(BigInt(proof.pi_b[1][0])), beBytes(BigInt(proof.pi_b[1][1])),
    beBytes(BigInt(proof.pi_c[0])), beBytes(BigInt(proof.pi_c[1])),
  );
  if (proofBytes.length !== 256) throw new Error('proof len');

  // envelope — dapp encodeTBridgeBurnPayload layout.
  const envelope = concat(
    new Uint8Array([0x61, NETWORK_TAG]), assetId, denom32, root32, nh32,
    recipientCommit, rLeaf32, ethRecip, burnNonce, bindHash32,
    new Uint8Array([proofBytes.length & 0xff, (proofBytes.length >> 8) & 0xff]), proofBytes,
  );

  // Minimal legacy Bitcoin tx: 1 input, 1 OP_RETURN output (PUSHDATA2), locktime 0.
  const opret = concat(new Uint8Array([0x6a, 0x4d, envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope);
  const scriptLen = opret.length; // 4 + envelope.length
  const viScriptLen = scriptLen < 0xfd ? new Uint8Array([scriptLen]) : new Uint8Array([0xfd, scriptLen & 0xff, (scriptLen >> 8) & 0xff]);
  const rawTx = concat(
    hexToBytes('02000000'),                 // version
    new Uint8Array([0x01]),                  // vin count
    new Uint8Array(32),                      // prev txid
    hexToBytes('ffffffff'),                  // prev vout
    new Uint8Array([0x00]),                  // scriptSig len
    hexToBytes('ffffffff'),                  // sequence
    new Uint8Array([0x01]),                  // vout count
    new Uint8Array(8),                       // value 0
    viScriptLen, opret,
    new Uint8Array(4),                       // locktime
  );
  // txid = dsha256(rawTx) (legacy, no witness).
  const txid = sha256(sha256(rawTx));

  const fixture = {
    note: 'Real burn->withdraw fixture bound to a deterministic mixer address. Regenerate with node tests/gen-withdraw-flow-fixture.mjs.',
    deployer: '0x00000000000000000000000000000000DeaDBeef',
    mixer: MIXER_ADDR, chainId: Number(CHAIN_ID), networkTag: NETWORK_TAG,
    assetId: '0x' + ASSET_ID, denomTacit: DENOM_TACIT.toString(), weiDenom: WEI_DENOM.toString(),
    ethRecipient: '0x' + ETH_RECIP,
    poolRoot: '0x' + bytesToHex(root32), nullifierHash: '0x' + bytesToHex(nh32),
    bindHash: '0x' + bytesToHex(bindHash32), claimId: '0x' + bytesToHex(claimId),
    rawBtcTx: '0x' + bytesToHex(rawTx), txid: '0x' + bytesToHex(txid),
    envelopeLen: envelope.length,
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fixture, null, 2));
  console.log('==> wrote', path.relative(path.join(__dirname, '..'), OUT));
  console.log('   txid    :', fixture.txid);
  console.log('   claimId :', fixture.claimId);
  console.log('   rawTx   :', rawTx.length, 'bytes; envelope', envelope.length);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
