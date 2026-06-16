#!/usr/bin/env node
// Validates the real burnDepositKit (dapp/burn-deposit-bitcoin.js) the worker injects: the raw-tx-hex
// Bitcoin parsers are byte-exact ports of cxfer-core/src/bitcoin.rs (the guest is the arbiter — a mismatch
// is a liveness failure), and the kit's crypto adapters wire makeBurnDepositProvenance correctly so a REAL
// conserving provenance verifies (and a tampered one does not). Parser fixtures are built with btc-mini's
// buildRevealTx/computeTxid (the same frame extract_taproot_envelope expects); the conservation check reuses
// the Rust-validated conserving_m1 vector, mirroring burn_deposit.rs::verify_provenance_accepts_real_depth1.
//
// Run: node tests/burn-deposit-kit.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTxid as btcComputeTxid, buildRevealTx, varint, cat as bcat } from './btc-mini.mjs';
import { makeBurnDepositKit, extractInputs, extractTaprootEnvelope, parseCmint, parseCetch, classifyConfidentialTx, parseBurnEnvelope, parseCxferEnvelopeFull } from '../dapp/burn-deposit-bitcoin.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const kit = makeBurnDepositKit(deps);
const pool = makeConfidentialPool(deps);

let failures = 0;
const ok = (c, msg) => { if (!c) { console.error(`FAIL ${msg}`); failures++; } else console.log(`ok   ${msg}`); };
const eq = (a, b, msg) => ok(a === b, `${msg}${a === b ? '' : ` (got ${a} exp ${b})`}`);

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const hexToBytes = (h) => Uint8Array.from(Buffer.from(strip(h), 'hex'));
const u16le = (n) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
const G = secp.ProjectivePoint.BASE.toRawBytes(true); // a real 33-byte compressed point

// ── 1. computeTxidInternal matches btc-mini's computeTxid (== the Rust compute_txid) ──
{
  const tx = buildRevealTx(Uint8Array.from([0x99, 1, 2, 3, 4])); // arbitrary framed payload
  eq(kit.computeTxidInternal(hex(tx)), hex(btcComputeTxid(tx)), 'computeTxidInternal == btc-mini computeTxid (segwit)');
  const legacy = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // version + non-segwit body
  eq(kit.computeTxidInternal(hex(legacy)), hex(btcComputeTxid(legacy)), 'computeTxidInternal == btc-mini computeTxid (legacy)');
}

// ── 2. extractTaprootEnvelope round-trips the TACIT frame buildRevealTx embeds ──
{
  const payload = Uint8Array.from([0x2b, ...new Array(40).fill(0xab)]); // a burn-shaped envelope body
  const tx = buildRevealTx(payload);
  eq(extractTaprootEnvelope(hex(tx)), hex(payload), 'extractTaprootEnvelope recovers the embedded envelope');
  eq(extractTaprootEnvelope(hex(Uint8Array.from([1, 0, 0, 0, 0]))), null, 'extractTaprootEnvelope: non-segwit → null');
}

// ── 3. extractInputs reads the prevout(s) (internal order) ──
{
  const tx = buildRevealTx(Uint8Array.from([0x21, 0, 0]));
  const ins = extractInputs(hex(tx));
  ok(Array.isArray(ins) && ins.length === 1, 'extractInputs: one input');
  eq(ins[0].prevTxid, '0x' + '00'.repeat(32), 'extractInputs: prevTxid (buildRevealTx zero prevout)');
  eq(ins[0].prevVout, 0, 'extractInputs: prevVout');
}

// ── 4. parseEtchAnchor: a CETCH reveal binds asset_id = sha256(internalTxid‖vout0) → { c0, mintAuthority } ──
{
  const MINT_AUTH = Uint8Array.from(new Array(32).fill(0x11));
  // CETCH: 0x21 ‖ tlen ‖ ticker ‖ decimals ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2 LE) ‖ rp ‖ mint_authority(32) ‖ img_len(2 LE) ‖ img
  const cetch = bcat([
    [0x21], [0x03], Buffer.from('TAC'), [0x08],
    G, new Uint8Array(8), u16le(0), /* rp_len 0 */ MINT_AUTH, u16le(0), /* img_len 0 */
  ]);
  const etchTx = buildRevealTx(cetch);
  const etchTxHex = hex(etchTx);
  // asset_id the kit derives internally: sha256(compute_txid(etchTx) ‖ vout0 LE)
  const pre = new Uint8Array(36); pre.set(btcComputeTxid(etchTx), 0);
  const asset = hex(sha256(pre));
  const anchor = kit.parseEtchAnchor(etchTxHex, asset);
  ok(anchor != null, 'parseEtchAnchor: correct asset binding accepted');
  eq(anchor && anchor.c0Compressed, hex(G), 'parseEtchAnchor: returns C_0 (the supply commitment)');
  eq(anchor && anchor.mintAuthority, hex(MINT_AUTH), 'parseEtchAnchor: returns mint_authority');
  eq(kit.parseEtchAnchor(etchTxHex, '0x' + 'ff'.repeat(32)), null, 'parseEtchAnchor: wrong asset → null (no etch substitution)');
  // parseCetch directly on the envelope (mintable form here; fixed-supply would carry all-zero authority)
  const c = parseCetch(extractTaprootEnvelope(etchTxHex));
  eq(c.decimals, 8, 'parseCetch: decimals');
}

// ── 5. parseCmint round-trips a T_MINT (0x24) envelope ──
{
  const asset = new Uint8Array(32).fill(0xa5);
  const etchTxid = new Uint8Array(32).fill(0xe7);
  const amountCt = new Uint8Array(8).fill(0x07);
  const rp = Uint8Array.from([0xde, 0xad]);
  const sig = new Uint8Array(64).fill(0x5c);
  const env = bcat([[0x24], asset, etchTxid, G, amountCt, u16le(rp.length), rp, sig]);
  const m = parseCmint(hex(env));
  ok(m != null, 'parseCmint: parses');
  eq(m.asset, hex(asset), 'parseCmint: asset');
  eq(m.commitment, hex(G), 'parseCmint: commitment');
  eq(m.encryptedAmount, hex(amountCt), 'parseCmint: amount_ct');
  eq(m.rangeProof, hex(rp), 'parseCmint: rangeProof');
  eq(m.issuerSig, hex(sig), 'parseCmint: issuerSig');
}

// ── 6. The kit's conservation adapters verify a REAL conserving provenance (and reject a tampered one) ──
//      Mirrors burn_deposit.rs::verify_provenance_accepts_real_depth1_from_c0 through the actual kit: the
//      conserving_m1 fixture framed as a depth-1 distribution (its input IS C_0, its output IS the burned note).
{
  const f = JSON.parse(readFileSync(join(__dir, '../contracts/sp1/confidential/fixtures/cxfer_conservation_diff.json'), 'utf8'));
  const v = f.vectors.find((x) => x.name === 'conserving_m1');
  const inTxid = v.inputs[0].txid;
  const inVout = v.inputs[0].vout;
  const inC = v.inputs[0].commitment; // compressed C_0
  const outC = v.outsCompressed[0];   // compressed burned note
  const provTxidBytes = Uint8Array.from(new Array(32).fill(0x99));
  const provTxid = hex(provTxidBytes);

  const chOf = (compressed) => { const { cx, cy } = pool.decompressCommitment(compressed); return pool.commitmentHash(cx, cy); };
  const c0Outpoint = pool.outpointKey(inTxid, inVout);
  const c0Ch = chOf(inC);
  const burnedOutpoint = pool.outpointKey(provTxid, 0);
  const burnedCh = chOf(outC);
  // single-tx block → siblings [], confirmedBlockRoot == the cxfer txid (assembler, as the indexer builds it)
  const mkCxfer = (kernelSig) => ({
    txid: provTxid,
    inputOutpoints: [[inTxid, inVout]],
    inputCommitments: [inC],
    outputCommitments: [outC],
    outputVouts: [0],
    burnedAmount: 0,
    rangeProof: v.rangeProof,
    kernelSig,
    merkleSiblings: kit.assembler.merkleSiblings([provTxidBytes], 0),
    merkleIndex: 0,
    confirmedBlockRoot: kit.assembler.merkleRoot([provTxidBytes]),
  });

  ok(
    kit.mirror.verifyProvenanceLeaves(v.asset, [[c0Outpoint, c0Ch]], burnedOutpoint, burnedCh, [mkCxfer(v.kernelSig)]) === true,
    'kit conservation adapter: a real conserving depth-1 provenance from C_0 VERIFIES',
  );
  ok(
    kit.mirror.verifyProvenanceLeaves(v.asset, [[c0Outpoint, c0Ch]], burnedOutpoint, burnedCh, [mkCxfer('0x' + '00'.repeat(64))]) === false,
    'kit conservation adapter: a tampered kernel sig is REJECTED (no inflation)',
  );
  // wrong C_0 commitment hash → the burned note doesn't descend from a valid leaf
  ok(
    kit.mirror.verifyProvenanceLeaves(v.asset, [[c0Outpoint, '0x' + '00'.repeat(32)]], burnedOutpoint, burnedCh, [mkCxfer(v.kernelSig)]) === false,
    'kit conservation adapter: a fabricated C_0 commitment is REJECTED',
  );
}

// ── 7. classifyConfidentialTx mirrors the guest's reflection scan classification (burn / cxfer / plain) ──
//      The scan-attester cutover injects this as `classifyTx`; the guest re-parses from txData and is the
//      arbiter, so a mismatch is a liveness failure (the prove fails), never a wrong attestation.
{
  // a CXFER (0x22): opcode ‖ asset(32) ‖ kernelSig(64) ‖ N(1) ‖ commitment(33) ‖ amount_ct(8) ‖ rpLen(2) ‖ rp
  const asset = new Uint8Array(32).fill(0xa5);
  const kSig = new Uint8Array(64).fill(0x5c);
  const amt = new Uint8Array(8).fill(0x07);
  const rp = Uint8Array.from([0xde, 0xad, 0xbe]);
  const cxferEnv = bcat([[0x22], asset, kSig, [0x01], G, amt, u16le(rp.length), rp]);
  const cxTx = hex(buildRevealTx(cxferEnv));
  const c = classifyConfidentialTx(cxTx);
  ok(c && c.type === 'cxfer', 'classify: a 0x22 CXFER → type cxfer');
  eq(c && c.assetId, hex(asset), 'classify: cxfer assetId');
  eq(c && c.kernelSig, hex(kSig), 'classify: cxfer kernelSig surfaced (for REFLECT-1 conservation)');
  eq(c && c.rangeProof, hex(rp), 'classify: cxfer rangeProof surfaced');
  eq(c && c.commitments.length === 1 && c.commitments[0], hex(G), 'classify: cxfer commitment');
  // direct parser parity
  eq(parseCxferEnvelopeFull(hex(cxferEnv)).kernelSig, hex(kSig), 'parseCxferEnvelopeFull: kernelSig');

  // a confidential bridge-burn (0x2B, 129B): opcode ‖ asset(32) ‖ poolRoot(32) ‖ nullifier(32) ‖ dest(32)
  const poolRoot = new Uint8Array(32).fill(0x11);
  const nu = new Uint8Array(32).fill(0x17);
  const dest = new Uint8Array(32).fill(0xde);
  const burnEnv = bcat([[0x2b], asset, poolRoot, nu, dest]);
  const b = classifyConfidentialTx(hex(buildRevealTx(burnEnv)));
  ok(b && b.type === 'burn', 'classify: a 0x2B confidential bridge-burn → type burn');
  eq(b && b.dest, hex(dest), 'classify: burn destCommitment');
  eq(parseBurnEnvelope(hex(burnEnv)).nullifier, hex(nu), 'parseBurnEnvelope: nullifier');

  // a CETCH (0x21) is neither a cxfer nor a burn → null (the scan treats it as a plain tx)
  const cetchEnv = bcat([[0x21], [0x03], Buffer.from('TAC'), [0x08], G, new Uint8Array(8), u16le(0), new Uint8Array(32), u16le(0)]);
  eq(classifyConfidentialTx(hex(buildRevealTx(cetchEnv))), null, 'classify: a CETCH (0x21) → null (plain)');
  // a tx with no Tacit envelope → null
  eq(classifyConfidentialTx(hex(Uint8Array.from([1, 0, 0, 0, 0]))), null, 'classify: a non-envelope tx → null');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall burn-deposit-kit checks passed');
process.exit(failures ? 1 : 0);
