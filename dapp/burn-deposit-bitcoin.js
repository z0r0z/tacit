// Raw-tx-hex Bitcoin parsers (faithful JS ports of cxfer-core/src/bitcoin.rs) + the `burnDepositKit`
// factory the worker injects into makeScanReflectionIndexer to assemble TAC burn-deposit / cmint-deposit
// onboarding (a 0x2B burn of a PRE-existing, never-reflected note proven real via per-bridge provenance).
//
// The AUTHORITATIVE parser is the reflection guest (the Rust). These ports must match it byte-for-byte: a
// mismatch makes the worker assemble a witness the guest REJECTS — a LIVENESS failure (the holder's bridge
// doesn't prove), never a soundness one (the guest is the arbiter; it only mints what its own parse accepts).
// Validated against btc-mini-built fixtures in tests/burn-deposit-kit.mjs (computeTxid == btc-mini, envelope
// round-trips buildRevealTx, asset_id == sha256(internalTxid‖vout0), a full synthetic burn-deposit verifies).

import { makeConfidentialPool, isLegacyBridgeAsset } from './confidential-pool.js';
import { verifySchnorr, signSchnorr, pedersenCommit, pointToBytes, bigintToBytes32, modN, bpRangeVerify, bpClassicProofLen } from './bulletproofs.js';
import { bppRangeVerify, bytesToPoint as bppPoint, bppRangeProve } from './bulletproofs-plus.js';
import { sha256 as _sha256 } from './vendor/tacit-deps.min.js';
import { makeBurnDepositProvenance } from './burn-deposit-provenance.js';
import { makeBurnDepositAssembler } from './burn-deposit-assembler.js';

const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const hexToBytes = (h) => {
  h = strip(h);
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return a;
};
const bytesToHex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const cat = (arrs) => {
  const t = arrs.reduce((n, a) => n + a.length, 0);
  const o = new Uint8Array(t);
  let off = 0;
  for (const a of arrs) { o.set(a, off); off += a.length; }
  return o;
};

// read_varint (cxfer-core::bitcoin::read_varint) → [value, byteLen] | null. Bounds are byte-for-byte the
// Rust (e.g. a 0xfd needs pos+2 < len), so a truncated varint is a clean null, not a throw.
function readVarint(d, pos) {
  if (pos >= d.length) return null;
  const f = d[pos];
  if (f < 0xfd) return [f, 1];
  if (f === 0xfd) { if (pos + 2 >= d.length) return null; return [d[pos + 1] | (d[pos + 2] << 8), 3]; }
  if (f === 0xfe) { if (pos + 4 >= d.length) return null; return [(d[pos + 1] | (d[pos + 2] << 8) | (d[pos + 3] << 16) | (d[pos + 4] * 0x1000000)) >>> 0, 5]; }
  if (pos + 8 >= d.length) return null;
  let v = 0;
  for (let i = 0; i < 8; i++) v += d[pos + 1 + i] * 2 ** (8 * i);
  return [v, 9];
}

// compute_txid (cxfer-core::bitcoin::compute_txid): legacy = double-SHA of the whole tx; segwit = double-SHA
// of version ‖ inputs ‖ outputs ‖ locktime (witness stripped). Returns the INTERNAL-order txid bytes, or
// null (incl. the BIP-141 64-byte-non-witness anti-merkle-collision reject). `dsha` = double-SHA256.
// Structural validity of a NON-witness tx consuming EXACTLY its length (mirror cxfer-core
// nonwitness_tx_exact_len): in_count ≥ 1, out_count ≥ 1, exact byte consumption. Used to disambiguate a
// 64-byte blob — a merkle internal node (txid_L‖txid_R, ≈random bytes) parses as a tx with
// negligible probability, so a real 64-byte tx is admitted while the collision blob is rejected.
function nonwitnessTxExactLen(tx) {
  if (tx.length < 4) return false;
  let pos = 4;
  let r = readVarint(tx, pos); if (!r) return false; const inCount = r[0]; if (inCount === 0) return false; pos += r[1];
  for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return false; pos += r[1] + r[0] + 4; }
  r = readVarint(tx, pos); if (!r) return false; const outCount = r[0]; if (outCount === 0) return false; pos += r[1];
  for (let i = 0; i < outCount; i++) { pos += 8; r = readVarint(tx, pos); if (!r) return false; pos += r[1] + r[0]; }
  pos += 4; // locktime
  return pos === tx.length;
}
function makeComputeTxidBytes(dsha) {
  return function computeTxidBytes(tx) {
    const segwit = tx.length > 5 && tx[4] === 0x00 && tx[5] === 0x01;
    // Admit a 64-byte non-witness tx iff it parses (real tx → no reflection stall); reject the
    // collision blob (a merkle internal node masquerading as a tx).
    if (tx.length === 64 && !segwit && !nonwitnessTxExactLen(tx)) return null;
    if (!segwit) return dsha(tx);
    const version = tx.subarray(0, 4);
    let pos = 6;
    const inputsStart = pos;
    let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; if (inCount === 0) return null; pos += r[1]; // require ≥1 input
    for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4; }
    r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; if (outCount === 0) return null; pos += r[1]; // require ≥1 output
    for (let i = 0; i < outCount; i++) { pos += 8; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0]; }
    const outputsEnd = pos;
    for (let i = 0; i < inCount; i++) {
      r = readVarint(tx, pos); if (!r) return null; const wc = r[0]; pos += r[1];
      for (let j = 0; j < wc; j++) { r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0]; }
    }
    if (outputsEnd > tx.length || pos + 4 !== tx.length) return null; // exact consumption (no trailing bytes)
    const locktime = tx.subarray(pos, pos + 4);
    const stripped = cat([version, tx.subarray(inputsStart, outputsEnd), locktime]);
    // Parity (mirror cxfer-core): a stripped form of exactly 64 bytes is admitted iff it parses.
    if (stripped.length === 64 && !nonwitnessTxExactLen(stripped)) return null;
    return dsha(stripped);
  };
}

// extract_inputs (cxfer-core::bitcoin::extract_inputs): the prevout (txid INTERNAL order, vout) of each
// vin — segwit or legacy, witness ignored. null on a malformed tx or zero inputs.
function extractInputs(txHex) {
  const tx = hexToBytes(txHex);
  if (tx.length < 5) return null;
  let pos = 4;
  if (tx[4] === 0x00 && tx.length >= 6 && tx[5] === 0x01) pos = 6;
  let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; if (inCount === 0) return null; pos += r[1];
  const inputs = [];
  for (let i = 0; i < inCount; i++) {
    if (pos + 36 > tx.length) return null;
    const txid = tx.subarray(pos, pos + 32);
    const vout = (tx[pos + 32] | (tx[pos + 33] << 8) | (tx[pos + 34] << 16) | (tx[pos + 35] * 0x1000000)) >>> 0;
    inputs.push({ prevTxid: bytesToHex(txid), prevVout: vout });
    pos += 36;
    r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4;
  }
  return inputs;
}

// First witness stack item of input `vinIndex` in a SegWit tx — the signature slot for both a P2WPKH
// spend ([sig‖sighash, pubkey]) and a Taproot key-/script-path spend ([sig, …]). null on a legacy
// (no-witness) tx, an out-of-range index, an empty stack, or a truncated varint. Mirrors cxfer-core
// bitcoin::input_first_witness_item byte-for-byte (used by the destination-binding gate).
// True iff `sig` is a strict DER ECDSA signature followed by exactly one sighash byte — the SegWit v0
// P2WPKH signature shape `0x30 ‖ len ‖ 0x02 ‖ rlen ‖ r ‖ 0x02 ‖ slen ‖ s ‖ sighash`. Used ONLY to tell a
// 2-item P2WPKH witness apart from a 2-item Taproot script-path witness; the signature's cryptographic
// validity is Bitcoin consensus' job, already settled by the tx being confirmed. Mirrors cxfer-core
// bitcoin::is_strict_der_sig_with_sighash byte for byte.
function isStrictDerSigWithSighash(sig) {
  if (!sig || sig.length < 9 || sig.length > 73 || sig[0] !== 0x30) return false;
  if (sig[1] !== sig.length - 3) return false;
  if (sig[2] !== 0x02) return false;
  const rlen = sig[3];
  if (rlen === 0 || 4 + rlen + 2 > sig.length) return false;
  if (sig[4 + rlen] !== 0x02) return false;
  const slen = sig[5 + rlen];
  if (slen === 0) return false;
  return 6 + rlen + slen === sig.length - 1;
}

function inputFirstWitnessItem(txHex, vinIndex) {
  const tx = hexToBytes(txHex);
  if (tx.length < 6 || tx[4] !== 0x00 || tx[5] !== 0x01) return null; // legacy → no witness section
  let pos = 6;
  let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; if (inCount === 0 || vinIndex >= inCount) return null; pos += r[1];
  for (let i = 0; i < inCount; i++) {
    pos += 36; if (pos > tx.length) return null;
    r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4;
  }
  r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; pos += r[1];
  for (let i = 0; i < outCount; i++) {
    pos += 8; if (pos > tx.length) return null;
    r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0];
  }
  for (let i = 0; i < inCount; i++) {
    r = readVarint(tx, pos); if (!r) return null; const itemCount = r[0]; pos += r[1];
    if (i === vinIndex) {
      // Two accepted shapes, both putting a REAL signature in the first slot whose trailing sighash byte
      // is meaningful: a 1-item Taproot KEY-PATH witness [schnorr_sig], and a 2-item SegWit v0 P2WPKH
      // witness [der_sig‖sighash, compressed_pubkey]. A Taproot SCRIPT-PATH spend also has >=2 items but
      // its first is arbitrary script input, so its last byte is not a sighash flag — rejected.
      // P2WPKH is admitted because the entire pre-Taproot-homing note population is P2WPKH-homed and such
      // a spend binds destinations identically (same sighash check). Mirrors the guest EXACTLY
      // (cxfer-core bitcoin::input_first_witness_item) — a divergence here desyncs the reflection digest.
      if (itemCount !== 1 && itemCount !== 2) return null;
      r = readVarint(tx, pos); if (!r) return null; const ilen = r[0]; pos += r[1];
      const end = pos + ilen; if (end > tx.length) return null;
      const sig = tx.subarray(pos, end);
      if (itemCount === 1) return sig;
      // 2 items: admit only an unambiguous P2WPKH witness (33-byte compressed pubkey + strict DER sig),
      // so a 2-item script-path witness whose 33-byte control block starts 0x02/0x03 cannot masquerade.
      r = readVarint(tx, end); if (!r) return null; const plen = r[0]; const pkStart = end + r[1];
      const pkEnd = pkStart + plen; if (pkEnd > tx.length || plen !== 33) return null;
      const pk0 = tx[pkStart]; if (pk0 !== 0x02 && pk0 !== 0x03) return null;
      if (!isStrictDerSigWithSighash(sig)) return null;
      return sig;
    }
    for (let k = 0; k < itemCount; k++) { r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0]; }
  }
  return null;
}

// True iff a witness signature's sighash flag commits to ALL of the tx's outputs. A 64-byte Schnorr item
// is SIGHASH_DEFAULT (implicit ALL); otherwise the last byte is the explicit flag and its low 6 bits select
// the output-commitment mode, so both SIGHASH_ALL (0x01) and SIGHASH_ALL|ANYONECANPAY (0x81) bind every
// output — SINGLE/NONE (0x02/0x03 and their 0x82/0x83 variants, e.g. the atomic-settlement adaptor's 0x83)
// do not. Mirrors cxfer-core bitcoin::sig_binds_all_outputs.
function sigBindsAllOutputs(sig) {
  if (!sig || sig.length === 0) return false;
  if (sig.length === 64) return true;
  return (sig[sig.length - 1] & 0x7f) === 0x01;
}

// Defense-in-depth destination binding: every listed note-spend input of a pure CXFER / LP-add /
// LP-remove must commit to ALL of the tx's outputs (SIGHASH_DEFAULT/ALL), so the reflected notes'
// destinations are Bitcoin-consensus-bound by the spender. Scoped to the passed note outpoints — the
// atomic-settlement family (T_AXFER, bids) legitimately spends with 0x83 and the caller must NOT gate it.
// Mirrors cxfer-core bitcoin::note_spends_bind_outputs; keeps the guest and this assembler in lockstep.
function noteSpendsBindOutputs(txHex, noteOutpoints) {
  const inputs = extractInputs(txHex);
  if (!inputs) return false;
  const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
  for (const [txid, vout] of noteOutpoints) {
    const want = strip(txid);
    const idx = inputs.findIndex((i) => strip(i.prevTxid) === want && i.prevVout === (vout >>> 0));
    if (idx < 0) return false;
    if (!sigBindsAllOutputs(inputFirstWitnessItem(txHex, idx))) return false;
  }
  return true;
}

// extract_taproot_envelope (cxfer-core::bitcoin::extract_taproot_envelope): from the first input's witness
// item[1] tapscript (PUSH32 xonly ‖ OP_CHECKSIG ‖ OP_FALSE OP_IF ‖ data pushes ‖ optional OP_ENDIF),
// concatenate the pushed chunks, strip the "TACIT"‖0x01 frame, return the envelope (env[0] = opcode) as
// hex. null otherwise. The push loop stops at OP_ENDIF or end-of-script, matching the guest exactly: a
// script that never reaches its own OP_ENDIF is still valid Bitcoin (the branch simply ran to its end),
// so this must not reject it — the guest does not.
function extractTaprootEnvelope(txHex) {
  const tx = hexToBytes(txHex);
  if (tx.length < 6 || tx[4] !== 0x00 || tx[5] !== 0x01) return null;
  let pos = 6;
  let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; if (inCount === 0) return null; pos += r[1];
  for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4; }
  r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; pos += r[1];
  for (let i = 0; i < outCount; i++) { pos += 8; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0]; }
  r = readVarint(tx, pos); if (!r) return null; const witCount = r[0]; pos += r[1];
  if (witCount < 2) return null;
  r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0]; // skip item0 (the signature)
  r = readVarint(tx, pos); if (!r) return null; const scriptLen = r[0]; pos += r[1];
  if (pos + scriptLen > tx.length) return null;
  const script = tx.subarray(pos, pos + scriptLen);
  if (script.length < 36) return null;
  let sp = 0;
  if (script[sp] !== 32) return null; sp += 1; // PUSH(32)
  sp += 32; // xonly pubkey
  if (sp >= script.length || script[sp] !== 0xac) return null; sp += 1; // OP_CHECKSIG
  if (sp + 1 >= script.length || script[sp] !== 0x00 || script[sp + 1] !== 0x63) return null; sp += 2; // OP_FALSE OP_IF
  const chunks = [];
  while (sp < script.length) {
    if (script[sp] === 0x68) break; // OP_ENDIF
    const op = script[sp]; sp += 1;
    if (op >= 1 && op <= 75) {
      if (sp + op > script.length) return null;
      chunks.push(script.subarray(sp, sp + op)); sp += op;
    } else if (op === 0x4c) { // OP_PUSHDATA1
      if (sp >= script.length) return null;
      const ln = script[sp]; sp += 1;
      if (sp + ln > script.length) return null;
      chunks.push(script.subarray(sp, sp + ln)); sp += ln;
    } else if (op === 0x4d) { // OP_PUSHDATA2
      if (sp + 1 >= script.length) return null;
      const ln = script[sp] | (script[sp + 1] << 8); sp += 2;
      if (sp + ln > script.length) return null;
      chunks.push(script.subarray(sp, sp + ln)); sp += ln;
    } else if (op === 0x4e) { // OP_PUSHDATA4 (mirror cxfer-core: consensus-valid in a Taproot script)
      if (sp + 3 >= script.length) return null;
      const ln = (script[sp] | (script[sp + 1] << 8) | (script[sp + 2] << 16) | (script[sp + 3] * 0x1000000)) >>> 0; sp += 4;
      if (sp + ln > script.length) return null;
      chunks.push(script.subarray(sp, sp + ln)); sp += ln;
    } else {
      return null;
    }
  }
  const payload = cat(chunks);
  const FRAME = [0x54, 0x41, 0x43, 0x49, 0x54, 0x01]; // "TACIT" ‖ v1
  if (payload.length <= 6 || !FRAME.every((b, i) => payload[i] === b)) return null;
  return bytesToHex(payload.subarray(6));
}

// parse_cetch (cxfer-core::bitcoin::parse_cetch): a CETCH (0x21) envelope →
//   { c0Compressed, mintAuthority, decimals }. Layout (env[0]=0x21):
//   tlen(1,1..16) ‖ ticker ‖ decimals(1,0..8) ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2 LE) ‖ rp ‖ mint_authority(32) ‖ ...
function parseCetch(envHex) {
  const env = hexToBytes(envHex);
  if (env.length < 1 || env[0] !== 0x21) return null;
  let p = 1;
  const tlen = env[p]; p += 1;
  if (tlen < 1 || tlen > 16) return null;
  p += tlen;
  if (p >= env.length) return null;
  const decimals = env[p]; p += 1;
  if (decimals > 8) return null;
  if (p + 33 + 8 + 2 > env.length) return null;
  const commitment = env.subarray(p, p + 33); p += 33;
  p += 8; // amount_ct
  const rpLen = env[p] | (env[p + 1] << 8); p += 2;
  const rangeProof = env.subarray(p, p + rpLen);
  p += rpLen;
  if (p + 32 > env.length) return null;
  const mintAuthority = env.subarray(p, p + 32);
  return { c0Compressed: bytesToHex(commitment), mintAuthority: bytesToHex(mintAuthority), decimals, rangeProof: bytesToHex(rangeProof) };
}

// parse_cmint (cxfer-core::bitcoin::parse_cmint): a T_MINT (0x24) envelope →
//   { asset, etchTxid, commitment, encryptedAmount, rangeProof, issuerSig } (all hex). Layout (env[0]=0x24):
//   assetId(32) ‖ etchTxid(32) ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2 LE) ‖ rp ‖ issuer_sig(64).
function parseCmint(envHex) {
  const env = hexToBytes(envHex);
  if (env.length < 1 + 32 + 32 + 33 + 8 + 2 || env[0] !== 0x24) return null;
  const asset = env.subarray(1, 33);
  const etchTxid = env.subarray(33, 65);
  const commitment = env.subarray(65, 98);
  const amountCt = env.subarray(98, 106);
  const rpLen = env[106] | (env[107] << 8);
  const rpStart = 108;
  const rpEnd = rpStart + rpLen;
  if (rpEnd + 64 !== env.length) return null; // EXACT close, matching guest parse_cmint (rp_end+64 != len)
  const rangeProof = env.subarray(rpStart, rpEnd);
  const issuerSig = env.subarray(rpEnd, rpEnd + 64);
  return {
    asset: bytesToHex(asset),
    etchTxid: bytesToHex(etchTxid),
    commitment: bytesToHex(commitment),
    encryptedAmount: bytesToHex(amountCt),
    rangeProof: bytesToHex(rangeProof),
    issuerSig: bytesToHex(issuerSig),
  };
}

// parse_burn_envelope (cxfer-core::bitcoin::parse_burn_envelope): a confidential bridge-burn (0x2B) →
//   { asset, nullifier, dest, target } (all hex). Layout (env[0]=0x2B, exactly 161B):
//   opcode(1) ‖ assetId(32) ‖ bitcoinPoolRoot(32) ‖ nullifier(32) ‖ destCommitment(32) ‖ targetChainBinding(32).
// `target` = the CHAIN_BINDING (keccak(chainid, poolAddress)) of the deployment the burn targets;
// it is folded into bridge_burn_id so a burn is redeemable in exactly one deployment. The 161-byte format is
// required unconditionally.
function parseBurnEnvelope(envHex) {
  const env = hexToBytes(envHex);
  // Both a reflected bridge-burn and a scan-free burn-deposit carry exactly this 161-byte envelope; the
  // burn-deposit's provenance DAG rides SP1 stdin, not the envelope, so the envelope itself is fixed-length
  // for every burn. Mirrors cxfer-core bitcoin::parse_burn_envelope exactly.
  if (env.length !== 161 || env[0] !== 0x2b) return null;
  return {
    asset: bytesToHex(env.subarray(1, 33)),
    nullifier: bytesToHex(env.subarray(65, 97)),
    dest: bytesToHex(env.subarray(97, 129)),
    target: bytesToHex(env.subarray(129, 161)),
  };
}

// parse_cxfer_envelope_full (cxfer-core::bitcoin::parse_cxfer_envelope_full): a confidential transfer →
// { asset, kernelSig, commitments[], rangeProof, assetInputCount } (all hex; commitments compressed). Layouts:
//   T_CXFER_BPP 0x22 / T_CXFER 0x23:
//     opcode(1) ‖ assetId(32) ‖ kernel_sig(64) ‖ N(1,∈{1,2,4,8}) ‖ N×(commitment(33) ‖ amount_ct(8)) ‖ rpLen(2 LE) ‖ rp
//   the FIXED-amount atomic settlement T_AXFER 0x26 / T_AXFER_BPP 0x3C:
//     opcode(1) ‖ assetId(32) ‖ asset_input_count(1, ≥ 1) ‖ kernel_sig(64) ‖ N ‖ … (as above)
// asset_input_count names the kernel's inputs by position, vin[1..1+count]; it is null for 0x22/0x23. All four fold
// through the guest's same fold_cxfer (single-asset Σin=Σout kernel + range), so the JS reflection mirrors them as 'cxfer'. The variable-amount variants
// T_AXFER_VAR(0x37) / T_AXFER_VAR_BPP(0x3D) are DISABLED (unbindable maker-change destination) — NOT in the set,
// so they parse to null here exactly like the guest, and classifyConfidentialTx falls through to plain traffic.
const CXFER_OPCODES = new Set([0x22, 0x23, 0x26, 0x3c]);
function parseCxferEnvelopeFull(envHex) {
  const env = hexToBytes(envHex);
  if (!env.length || !CXFER_OPCODES.has(env[0])) return null;
  const atomic = env[0] === 0x26 || env[0] === 0x3c;
  const head = atomic ? 1 + 32 + 1 : 1 + 32;
  if (env.length < head + 64 + 1 || (atomic && env[33] === 0)) return null;
  const asset = env.subarray(1, 33);
  const kernelSig = env.subarray(head, head + 64);
  let p = head + 64;
  const n = env[p]; p += 1;
  if (![1, 2, 4, 8].includes(n) || p + n * (33 + 8) + 2 > env.length) return null;
  const commitments = [];
  for (let i = 0; i < n; i++) { commitments.push(bytesToHex(env.subarray(p, p + 33))); p += 33 + 8; }
  const rpLen = env[p] | (env[p + 1] << 8); p += 2;
  if (p + rpLen !== env.length) return null;
  return { asset: bytesToHex(asset), kernelSig: bytesToHex(kernelSig), commitments, rangeProof: bytesToHex(env.subarray(p, p + rpLen)), assetInputCount: atomic ? env[33] : null };
}
// axfer_asset_input_count: the atomic settlement's asset_input_count, or null for any other envelope (or one that
// does not parse).
function axferAssetInputCount(envHex) {
  const cx = parseCxferEnvelopeFull(envHex);
  return cx ? cx.assetInputCount : null;
}

// T_CXFER_BOUND (0x39): the deployment-bound CXFER → { target, asset, kernelSig, commitments[], rangeProof }.
// Same wire shape as T_CXFER with a 32-byte target_chain_binding prepended (env[0]=0x39):
//   0x39 ‖ target(32) ‖ assetId(32) ‖ kernel_sig(64) ‖ N(1∈{1,2,4,8}) ‖ N×(commitment(33)‖amount_ct(8)) ‖ rpLen(2 LE) ‖ rp.
// Mirrors cxfer-core::bitcoin::parse_cxfer_bound_envelope.
const T_CXFER_BOUND = 0x39;
function parseCxferBoundEnvelope(envHex) {
  const env = hexToBytes(envHex);
  if (env.length < 1 + 32 + 32 + 64 + 1 || env[0] !== T_CXFER_BOUND) return null;
  const target = env.subarray(1, 33);
  const asset = env.subarray(33, 65);
  const kernelSig = env.subarray(65, 129);
  let p = 129;
  const n = env[p]; p += 1;
  if (![1, 2, 4, 8].includes(n) || p + n * (33 + 8) + 2 > env.length) return null;
  const commitments = [];
  for (let i = 0; i < n; i++) { commitments.push(bytesToHex(env.subarray(p, p + 33))); p += 33 + 8; }
  const rpLen = env[p] | (env[p + 1] << 8); p += 2;
  if (p + rpLen !== env.length) return null;
  return { target: bytesToHex(target), asset: bytesToHex(asset), kernelSig: bytesToHex(kernelSig), commitments, rangeProof: bytesToHex(env.subarray(p, p + rpLen)) };
}

// Encode side of parseCxferBoundEnvelope: assemble a T_CXFER_BOUND (0x39) envelope from a target
// chain-binding, asset, kernel sig, output notes (33-byte commitment + 8-byte amount_ct each), and one
// aggregated range proof. Byte-for-byte the inverse of the parser above:
//   0x39 ‖ target(32) ‖ assetId(32) ‖ kernel_sig(64) ‖ N(1∈{1,2,4,8}) ‖ N×(commitment(33)‖amount_ct(8)) ‖ rpLen(2 LE) ‖ rp.
function _coerce(x, n, what) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (n != null && b.length !== n) throw new Error(`${what} must be ${n} bytes`);
  return b;
}
function encodeCxferBoundEnvelope({ target, asset, kernelSig, outputs, rangeProof }) {
  const t = _coerce(target, 32, 'target_chain_binding');
  const a = _coerce(asset, 32, 'assetId');
  const ks = _coerce(kernelSig, 64, 'kernel_sig');
  if (![1, 2, 4, 8].includes(outputs.length)) throw new Error('outputs.length must be in {1,2,4,8}');
  const rp = _coerce(rangeProof, null, 'rangeProof');
  if (rp.length > 0xffff) throw new Error('rangeProof too large');
  const parts = [Uint8Array.of(T_CXFER_BOUND), t, a, ks, Uint8Array.of(outputs.length)];
  for (const o of outputs) {
    parts.push(_coerce(o.commitment, 33, 'commitment'));
    parts.push(_coerce(o.amountCt != null ? o.amountCt : new Uint8Array(8), 8, 'amount_ct'));
  }
  parts.push(Uint8Array.of(rp.length & 0xff, (rp.length >> 8) & 0xff), rp);
  return bytesToHex(cat(parts));
}

// One-time migration of a legacy (unbound) TAC note into the deployment-bound note format. The fast lane
// onboards only bound notes, so the holder spends a legacy TAC note on Bitcoin into a single T_CXFER_BOUND
// (0x39) TAC output note of the SAME amount, homed to `targetChainBinding` (= keccak(chainid, poolAddress) of the deployment, which
// the caller supplies since it is a deploy-time CREATE3 artifact). This is value-preserving — in = the legacy
// TAC note, out = one bound TAC note of the same amount — so it conserves under the SAME `tacit-kernel-v1`
// kernel a v1 CXFER uses (cxfer-core fold_cxfer_bound → verify_cxfer_conservation); the migration adds no
// consensus rule, only the encode side of the already-onboarded 0x39 format. Gated to the sole legacy-bridge
// asset (TAC); every other asset is already born bound.
//
// `note`  = { assetId, amount(bigint sats), blinding(bigint), outpoint:{ txid(BE hex), vout } } — the input
//           TAC note the holder currently controls.
// Returns the envelope + everything needed to bind the note-spend and record the new output note. The caller
// wraps `envelope` in the standard commit/reveal Taproot envelope tx, spends `note.outpoint` under
// SIGHASH_ALL (the bound fold requires every note-spend input to bind all outputs), and records the new note
// via `outCommitment`/`outBlinding`. Amount encryption (amount_ct) is a recipient-liveness channel only; the
// value is committed by `outCommitment`, so a self-migration may leave it zero (default) or supply a keystream.
function buildTacMigration({ note, targetChainBinding, outBlinding = null, amountCt = null }) {
  if (!note || note.amount == null || note.blinding == null || !note.outpoint) {
    throw new Error('buildTacMigration: note requires { assetId, amount, blinding, outpoint }');
  }
  if (!isLegacyBridgeAsset(note.assetId)) {
    throw new Error('buildTacMigration: only the legacy TAC bridge asset can be migrated');
  }
  const target = _coerce(targetChainBinding, 32, 'targetChainBinding');
  const asset = _coerce(note.assetId, 32, 'assetId');
  const amount = BigInt(note.amount);
  const inBlinding = modN(BigInt(note.blinding));
  const txidBE = hexToBytes(note.outpoint.txid);
  if (txidBE.length !== 32) throw new Error('note.outpoint.txid must be 32 bytes');
  const vout = note.outpoint.vout >>> 0;

  // Fresh, unlinkable output blinding (deterministic when not supplied so the builder round-trips in tests).
  let rOut = outBlinding != null ? modN(BigInt(outBlinding))
    : modN(_beToBig(_sha256(cat([
        new TextEncoder().encode('tacit-tac-migration-blinding-v1'),
        bigintToBytes32(inBlinding), target, txidBE, _voutLE(vout),
      ]))));
  const cOut = pedersenCommit(amount, rOut);           // v·H + r·G
  const cOutBytes = pointToBytes(cOut);

  // Kernel over (asset, [input outpoint], [output commitment]) — the same `tacit-kernel-v1` message a v1 CXFER
  // signs; the bound fold conserves under it unchanged. P = ΣC_out − ΣC_in = (r_out − r_in)·G, so the signing
  // key is the excess r_out − r_in.
  const kernelMsg = _kernelMsg(asset, [{ txidBE, vout }], [cOutBytes]);
  const excess = modN(rOut - inBlinding);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));

  const rangeProof = bppRangeProve([amount], [rOut]).proof;
  const envelope = encodeCxferBoundEnvelope({
    target, asset, kernelSig,
    outputs: [{ commitment: cOutBytes, amountCt: amountCt != null ? _coerce(amountCt, 8, 'amount_ct') : new Uint8Array(8) }],
    rangeProof,
  });
  return {
    envelope,
    target: bytesToHex(target),
    asset: bytesToHex(asset),
    amount,
    inputOutpoint: { txid: note.outpoint.txid, vout },
    outCommitment: bytesToHex(cOutBytes),
    outBlinding: rOut,
    kernelSig: bytesToHex(kernelSig),
  };
}

// tacit-kernel-v1 message: sha256("tacit-kernel-v1" ‖ asset ‖ in_count ‖ (txid_internal ‖ vout_LE)×in ‖
// out_count ‖ commitments ‖ burned(8 LE = 0)). txid is stored big-endian (display) and hashed little-endian
// (internal), matching computeKernelMsg / cxfer-core.
function _voutLE(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
function _beToBig(b) { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; }
function _kernelMsg(asset, inputs, outCommitments) {
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), asset, Uint8Array.of(inputs.length & 0xff)];
  for (const inp of inputs) {
    const rev = new Uint8Array(inp.txidBE); rev.reverse();
    parts.push(rev, _voutLE(inp.vout));
  }
  parts.push(Uint8Array.of(outCommitments.length & 0xff));
  for (const c of outCommitments) parts.push(c);
  parts.push(new Uint8Array(8)); // burned = 0
  return _sha256(cat(parts));
}

// T_PREAUTH_BID family (0x5B exact-fill / 0x5C partial-fill walk-away bid) — a CXFER on the tacit-asset side
// (the seller's asset inputs → the buyer's filled note + seller change under tacit-kernel-v1, one BP+ range
// over the outputs). Returns the SAME { asset, kernelSig, commitments[], rangeProof } shape as
// parseCxferEnvelopeFull, fed to the IDENTICAL cxfer fold — only the inline-section length and the bid-tx vout
// base (notes start at vout[1], after the envelope-hash OP_RETURN) differ. Mirrors cxfer-core
// parse_preauth_bid_common: opcode ‖ asset(32) ‖ skip(1) ‖ inline(97|134) ‖ kernel_sig(64) ‖ N(1,∈{1,2}) ‖
// N×commitment(33) (out[1] is followed by an 8-byte amount_ct) ‖ rpLen(2 LE) ‖ rp.
const PREAUTH_BID_INLINE = { 0x5b: 16 + 33 + 8 + 32 + 8, 0x5c: 16 + 33 + 8 + 8 + 8 + 8 + 32 + 20 + 1 }; // 97 / 134
function parsePreauthBidEnvelope(envHex) {
  const env = hexToBytes(envHex);
  const inline = PREAUTH_BID_INLINE[env[0]];
  if (inline == null) return null;
  const ksOff = 1 + 32 + 1 + inline;
  if (env.length < ksOff + 64 + 1 + 33 + 2) return null;
  const asset = env.subarray(1, 33), kernelSig = env.subarray(ksOff, ksOff + 64);
  const n = env[ksOff + 64];
  if (n !== 1 && n !== 2) return null;
  let p = ksOff + 64 + 1;
  const commitments = [];
  for (let i = 0; i < n; i++) {
    if (p + 33 > env.length) return null;
    commitments.push(bytesToHex(env.subarray(p, p + 33))); p += 33;
    if (i === 1) p += 8; // out[1] carries an 8-byte amount_ct; out[0] does not
  }
  if (p + 2 > env.length) return null;
  const rpLen = env[p] | (env[p + 1] << 8); p += 2;
  if (p + rpLen !== env.length) return null;
  return { asset: bytesToHex(asset), kernelSig: bytesToHex(kernelSig), commitments, rangeProof: bytesToHex(env.subarray(p, p + rpLen)) };
}

// T_SWAP_BATCH (0x2F) — a batched uniform-clearing settlement; onboards every receipt as a real note, gated by
// a BN254 Groth16 (per-receipt split) + the aggregate Pedersen identity + per-receipt BabyJubJub sigma. This
// parser surfaces the fields the reflection fold needs (mirror cxfer-core parse_swap_batch_envelope); the fold
// itself (Groth16 + BJJ verify) is the assembler's swap_batch branch. Layout: opcode ‖ asset_a(32) ‖ asset_b(32)
// ‖ n_intents(1) ‖ δa(9 signed) ‖ δb(9) ‖ R_net_a(32) ‖ R_net_b(32) ‖ fee_bps(2) ‖ tip_a(8) ‖ tip_b(8) ‖
// tip_a_c(33) ‖ tip_b_c(33) ‖ r_tip_a(32) ‖ r_tip_b(32) ‖ n×intent(352) ‖ n×receipt(234+rangeProof) ‖ proofLen(2) ‖
// proof ‖ metaLen(1) ‖ meta. intent = dir(1) ‖ pubkey(33) ‖ c_in_secp(33) ‖ c_in_bjj(32) ‖ in_xsigma(169) ‖
// min_out(8) ‖ tip(8) ‖ expiry(4) ‖ sig(64). receipt = c_out_secp(33) ‖ c_out_bjj(32) ‖ out_xsigma(169) ‖
// rangeProofLen(2) ‖ rangeProof — the sigma only binds c_out_secp to c_out_bjj modulo each curve's order, so
// rangeProof is what bounds c_out_secp's real integer value (mirror cxfer-core SwapBatchReceipt.range_proof).
const SWAP_BATCH_XSIGMA = 169, SWAP_BATCH_INTENT_LEN = 1 + 33 + 33 + 32 + 169 + 8 + 8 + 4 + 64, SWAP_BATCH_RECEIPT_LEN = 33 + 32 + 169; // 352, 234
function parseSwapBatchEnvelope(envHex) {
  const env = hexToBytes(envHex);
  if (env[0] !== 0x2f) return null;
  let p = 1;
  const u64le = (o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(env[o + i]); return v; };
  const u16le = (o) => env[o] | (env[o + 1] << 8);
  try {
    const take = (n) => { const s = p; if (p + n > env.length) throw 0; p += n; return s; };
    const aA = take(32), aB = take(32);
    const niOff = take(1); const ni = env[niOff]; if (ni < 1 || ni > 16) return null;
    const da = take(9); if (env[da] > 1) return null;
    const db = take(9); if (env[db] > 1) return null;
    const rna = take(32), rnb = take(32), fb = take(2), taA = take(8), tbA = take(8), tac = take(33), tbc = take(33);
    const rta = take(32), rtb = take(32); // r_tip_a, r_tip_b — the guest opens each tip commitment with them
    const intents = [];
    for (let i = 0; i < ni; i++) {
      const s = take(SWAP_BATCH_INTENT_LEN); const dir = env[s]; if (dir > 1) return null;
      intents.push({ direction: dir, traderPubkey: bytesToHex(env.subarray(s + 1, s + 34)), cInSecp: bytesToHex(env.subarray(s + 34, s + 67)), cInBjj: bytesToHex(env.subarray(s + 67, s + 99)), inXcurveSigma: bytesToHex(env.subarray(s + 99, s + 268)), minOut: u64le(s + 268).toString(), tipAmount: u64le(s + 276).toString(), expiryHeight: _u32le(env, s + 284), intentSig: bytesToHex(env.subarray(s + 288, s + 352)) });
    }
    const receipts = [];
    for (let i = 0; i < ni; i++) {
      const s = take(SWAP_BATCH_RECEIPT_LEN);
      const rpLenOff = take(2); const rpLen = u16le(rpLenOff); const rpOff = take(rpLen);
      receipts.push({
        cOutSecp: bytesToHex(env.subarray(s, s + 33)), cOutBjj: bytesToHex(env.subarray(s + 33, s + 65)),
        outXcurveSigma: bytesToHex(env.subarray(s + 65, s + 65 + SWAP_BATCH_XSIGMA)),
        rangeProof: bytesToHex(env.subarray(rpOff, rpOff + rpLen)),
      });
    }
    const plOff = take(2); const proofLen = u16le(plOff); const prOff = take(proofLen);
    const slOff = take(1); take(env[slOff]); // settler_meta_uri (informational)
    if (p !== env.length) return null;
    return {
      assetA: bytesToHex(env.subarray(aA, aA + 32)), assetB: bytesToHex(env.subarray(aB, aB + 32)), nIntents: ni,
      deltaANetSign: env[da], deltaANetMag: u64le(da + 1).toString(), deltaBNetSign: env[db], deltaBNetMag: u64le(db + 1).toString(),
      rNetA: bytesToHex(env.subarray(rna, rna + 32)), rNetB: bytesToHex(env.subarray(rnb, rnb + 32)),
      feeBps: u16le(fb), tipAAmount: u64le(taA).toString(), tipBAmount: u64le(tbA).toString(),
      tipACSecp: bytesToHex(env.subarray(tac, tac + 33)), tipBCSecp: bytesToHex(env.subarray(tbc, tbc + 33)),
      rTipA: bytesToHex(env.subarray(rta, rta + 32)), rTipB: bytesToHex(env.subarray(rtb, rtb + 32)),
      intents, receipts, proof: bytesToHex(env.subarray(prOff, prOff + proofLen)),
    };
  } catch { return null; }
}

// ── Track-B AMM op parsers (mirror cxfer-core parse_*_envelope) → the assembler's env shape. These ops' fold
// data is FULLY on-chain (kernel sigs, PUBLIC blindings, commitments in the envelope; the note-tree append
// paths are indexer-derived), so the live classifier can route them. A wrong parse is fail-loud (the guest
// re-parses txData + is authoritative), never a wrong attestation.
const _u64le = (e, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(e[o + i]); return v.toString(); };
const _u32le = (e, o) => { let v = 0; for (let i = 3; i >= 0; i--) v = v * 256 + e[o + i]; return v; };
const _u128le = (e, o) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(e[o + i]); return v.toString(); };
const _h = (e, a, b) => bytesToHex(e.subarray(a, b));

function parseSwapVarEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x32 || e.length < 269) return null;
  if (e[33] !== 0 && e[33] !== 1) return null;
  const rpLen = e[267] | (e[268] << 8), ks = 269 + rpLen;
  if (e.length !== ks + 64 + 64) return null; // EXACT close (kernel_sig + intent_sig), matching guest parse_swap_var_envelope (trailing-byte tx must NOT classify, or the witness stream desyncs)
  return { type: 'swap_var', poolId: _h(e, 1, 33), direction: e[33], rAPre: _u64le(e, 34), rBPre: _u64le(e, 42), deltaIn: _u64le(e, 50), deltaInMin: _u64le(e, 58), deltaInMax: _u64le(e, 66), deltaOut: _u64le(e, 74), minOut: _u64le(e, 82), tipAmount: _u64le(e, 90), tipAsset: e[98], expiryHeight: _u32le(e, 99), traderPubkey: _h(e, 103, 136), cIn: _h(e, 136, 169), cChangeOrSentinel: _h(e, 169, 202), cReceipt: _h(e, 202, 235), rReceipt: _h(e, 235, 267), rangeProof: _h(e, 269, 269 + rpLen), kernelSig: _h(e, ks, ks + 64), intentSig: _h(e, ks + 64, ks + 128) };
}
function parseSwapRouteEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x33) return null;
  const n = e[1]; if (n < 2 || n > 4) return null;
  if (_h(e, 2, 34) === _h(e, 34, 66)) return null;
  let p = 111; const hops = [];
  for (let i = 0; i < n; i++) {
    const s = p; p += 67; if (p > e.length) return null;
    const direction = e[s + 32]; if (direction !== 0 && direction !== 1) return null;
    hops.push({ poolId: _h(e, s, s + 32), direction, rAPre: _u64le(e, s + 35), rBPre: _u64le(e, s + 43), deltaANetMag: _u64le(e, s + 51), deltaBNetMag: _u64le(e, s + 59) });
  }
  p += 36; // trader_input_outpoint (the fold uses the detected spend, not this)
  const cIn = _h(e, p, p + 33); p += 33;
  const cReceipt = _h(e, p, p + 33); p += 33;
  const rReceipt = _h(e, p, p + 32); p += 32;
  if (p + 2 > e.length) return null;
  const rpLen = e[p] | (e[p + 1] << 8); if (rpLen === 0) return null; p += 2 + rpLen;
  if (p + 64 + 64 !== e.length) return null; // kernel_sig + intent_sig, exact end
  return { type: 'swap_route', traderInputAsset: _h(e, 2, 34), traderOutputAsset: _h(e, 34, 66), minOut: _u64le(e, 66), expiryHeight: _u32le(e, 74), traderPubkey: _h(e, 78, 111), hops, cIn, cReceipt, rReceipt, kernelSig: _h(e, p, p + 64), intentSig: _h(e, p + 64, p + 128) };
}
function parseHarvestEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] === 0x3b && e.length === 346) return { type: 'harvest', farmId: _h(e, 1, 33), amount: _u64le(e, 122), r: _h(e, 130, 162), owner: _h(e, 162, 194), oldNonce: _h(e, 194, 226), newNonce: _h(e, 226, 258), shares: _u64le(e, 258), rpsEntry: _u128le(e, 266), harvesterSig: _h(e, 282, 346) };       // T_LP_HARVEST
  if (e[0] === 0x3e && e.length === 174) return { type: 'farm_refund', farmId: _h(e, 1, 33), launcherPubkey: _h(e, 33, 66), amount: _u64le(e, 66), refundViewHeight: ((e[74] | (e[75] << 8) | (e[76] << 16) | (e[77] << 24)) >>> 0), r: _h(e, 78, 110), launcherSig: _h(e, 110, 174) };     // T_FARM_REFUND (launcher-authorized)
  return null;
}
function parseProtocolFeeClaimEnvelope(envHex) {
  const e = hexToBytes(envHex);
  // 207B: op ‖ pool_id(32) ‖ claimer(33) ‖ fee_bps(4 LE) ‖ amount(8 LE) ‖ C(33) ‖ blinding(32) ‖ sig(64).
  // claimer + fee_bps let the fold re-derive pool_id (prove the claimer is the bound recipient); sig binds
  // the claim + vout-0 destination.
  if (e[0] !== 0x31 || e.length !== 207) return null;
  return { type: 'protocol_fee_claim', poolId: _h(e, 1, 33), claimer: _h(e, 33, 66), feeBps: _u32le(e, 66), amount: _u64le(e, 70), cSecp: _h(e, 78, 111), blinding: _h(e, 111, 143), sig: _h(e, 143, 207) };
}
function parseFarmInitEnvelope(envHex) {
  const e = hexToBytes(envHex);
  const HDR = 1 + 32 + 32 + 33 + 32 + 8 + 8 + 4 + 4 + 33; // 187 = rp_len offset
  if (e[0] !== 0x34 || e.length < HDR + 2) return null;
  const rpLen = e[HDR] | (e[HDR + 1] << 8), ks = HDR + 2 + rpLen, rt = ks + 64 + 64;
  if (e.length !== rt + 4 + 32 + 32) return null; // EXACT close (kernel_sig + launcher_sig + refund tail), matching guest parse_farm_init_envelope
  // start_height[146..150] + end_height[150..154]: the campaign window the reflection clamps accrual to
  // end == 0 ⇒ perpetual. Trailing refund tail = founder-refund binding. Mirrors
  // guest parse_farm_init_envelope.
  return { type: 'farm_init', poolId: _h(e, 1, 33), farmNonce: _h(e, 33, 65), launcherPubkey: _h(e, 65, 98), rewardAsset: _h(e, 98, 130), rewardTotal: _u64le(e, 130), rewardPerBlock: _u64le(e, 138), startHeight: _u32le(e, 146), endHeight: _u32le(e, 150), cChangeOrSentinel: _h(e, 154, 187), kernelSig: _h(e, ks, ks + 64), launcherSig: _h(e, ks + 64, ks + 128), refundExpiry: _u32le(e, rt), refundDestXonly: _h(e, rt + 4, rt + 36), refundBlinding: _h(e, rt + 36, rt + 68) };
}
// T_LP_BOND (0x35): farm_id(32) ‖ bonder_pubkey(33) ‖ bond_amount(8) ‖ entry_acc(16) ‖ view_h(4) ‖
// owner_commit(32)[94..126] ‖ nonce(32)[126..158] ‖ c_change(33)[158..191] ‖ rp_len(2)[191..193] ‖
// range_proof(rp_len) ‖ kernel_sig(64) ‖ bonder_sig(64). Mirrors guest parse_lp_bond_fields_full + encodeLpBond.
function parseLpBond(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x35 || e.length < 193) return null;
  const rpLen = e[191] | (e[192] << 8), ks = 193 + rpLen, rt = ks + 64 + 64;
  if (e.length !== rt + 4 + 32 + 32) return null; // exact close: kernel_sig(64) + bonder_sig(64) + refund tail
  return { type: 'lp_bond', farmId: _h(e, 1, 33), bonderPubkey: _h(e, 33, 66), bondAmount: _u64le(e, 66), entryAcc: _u128le(e, 74), bondViewHeight: _u32le(e, 90), owner: _h(e, 94, 126), nonce: _h(e, 126, 158), kernelSig: _h(e, ks, ks + 64), bonderSig: _h(e, ks + 64, ks + 128), refundExpiry: _u32le(e, rt), refundDestXonly: _h(e, rt + 4, rt + 36), refundBlinding: _h(e, rt + 36, rt + 68) };
}
// T_LP_UNBOND (0x36, 217B): farm_id(32) ‖ owner_commit(32)[33..65] ‖ nonce(32)[65..97] ‖ shares(8)[97..105] ‖
// rps_entry(16)[105..121] ‖ lp_return_r(32)[121..153] ‖ unbonder_sig(64). Mirrors guest parse_lp_unbond_fields.
function parseLpUnbond(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x36 || e.length !== 217) return null;
  return { type: 'lp_unbond', farmId: _h(e, 1, 33), owner: _h(e, 33, 65), nonce: _h(e, 65, 97), shares: _u64le(e, 97), rpsEntry: _u128le(e, 105), lpReturnR: _h(e, 121, 153), unbonderSig: _h(e, 153, 217) };
}

// T_LP_ADD / POOL_INIT (0x2D) — option-a wire: the minted share note's blinding share_r rides the envelope at
// offset 452 (between the header and the variant-1 tail). Mirrors cxfer-core parse_lp_add_envelope → the fold env.
function parseLpAddEnvelope(envHex) {
  const e = hexToBytes(envHex);
  const HEADER = 452, TAIL = 484, V0_LEN = 552; // variant 0 tail: expiry(4) ‖ refund_a_blinding(32) ‖ refund_b_blinding(32)
  if (e[0] !== 0x2D || e.length < TAIL) return null;
  const variant = e[1];
  if (variant !== 0 && variant !== 1) return null;
  let feeBps = 0, capabilityFlags = 0, protocolFeeAddress = '0x' + '00'.repeat(33), protocolFeeBps = 0;
  let expiryHeight = 0, refundABlinding = '0x' + '00'.repeat(32), refundBBlinding = '0x' + '00'.repeat(32);
  if (variant === 0) {
    if (e.length !== V0_LEN) return null; // variant 0 length is fixed (no pool-identity tail, plus the refund tail)
    expiryHeight = e[TAIL] | (e[TAIL + 1] << 8) | (e[TAIL + 2] << 16) | (e[TAIL + 3] << 24);
    refundABlinding = _h(e, TAIL + 4, TAIL + 36);
    refundBBlinding = _h(e, TAIL + 36, TAIL + 68);
  }
  if (variant === 1) {
    let p = TAIL;
    const need = (n) => { if (!Number.isInteger(n) || n < 0 || p + n > e.length) throw 0; const s = p; p += n; return s; };
    const needLenPrefixed = () => { const l = e[need(1)]; need(l); };
    try {
      const f0 = need(2); feeBps = e[f0] | (e[f0 + 1] << 8);
      needLenPrefixed();                        // vkLen ‖ vkCid
      needLenPrefixed();                        // cerLen ‖ ceremonyCid
      const ac = e[need(1)]; need(1); need(ac * 33); // arbCount, then arbM ‖ arbiter pubkeys
      const lc = e[need(1)]; need(lc * 64);    // lsigCount ‖ launcher sigs
      const pa = need(33); protocolFeeAddress = _h(e, pa, pa + 33);
      const pb = need(2); protocolFeeBps = e[pb] | (e[pb + 1] << 8);
      needLenPrefixed();                        // metaLen ‖ poolMetaUri
      capabilityFlags = e[need(1)];
      if (capabilityFlags & 0x04) return null; // reserved arbiter-authority — fail closed (matches the guest)
      // Founder-refund tail (mirrors the guest parse_lp_add_envelope): a POOL_INIT that loses the
      // deterministic pool_id to a front-run (or is otherwise stale/malformed post-kernel) returns the
      // seeded delta_a/delta_b to owner-bound refund notes instead of self-burning the seed. This tail
      // follows capability_flags, and ONLY THEN must the envelope end exactly (Q-04).
      const e0 = need(4);
      expiryHeight = e[e0] | (e[e0 + 1] << 8) | (e[e0 + 2] << 16) | (e[e0 + 3] << 24);
      const a0 = need(32); refundABlinding = _h(e, a0, a0 + 32);
      const b0 = need(32); refundBBlinding = _h(e, b0, b0 + 32);
      if (p !== e.length) return null; // canonical wire: tail consumes the envelope exactly (Q-04)
    } catch { return null; }
  }
  return {
    type: 'lp_add', variant,
    assetA: _h(e, 2, 34), assetB: _h(e, 34, 66),
    deltaA: _u64le(e, 66), deltaB: _u64le(e, 74), shareAmount: _u64le(e, 82),
    shareCsecp: _h(e, 90, 123), kernelSigA: _h(e, 324, 388), kernelSigB: _h(e, 388, 452),
    shareR: _h(e, HEADER, TAIL),
    feeBps, capabilityFlags, protocolFeeAddress, protocolFeeBps,
    expiryHeight: expiryHeight >>> 0, refundABlinding, refundBBlinding,
  };
}

// T_LP_REMOVE (0x2E) — option-a wire: the two recv blindings r_recv_a/b ride after the kernel sig (offset 621),
// before the proof. Mirrors cxfer-core parse_lp_remove_envelope.
function parseLpRemoveEnvelope(envHex) {
  const e = hexToBytes(envHex);
  const RECV_B = 323, KS = 557, R = KS + 64; // 621
  if (e[0] !== 0x2E || e.length < R + 64 + 2) return null;
  const proofLen = e[R + 64] | (e[R + 65] << 8); // canonical wire: declared proof_len accounts for the tail exactly (Q-04)
  if (e.length !== R + 66 + proofLen) return null;
  return {
    type: 'lp_remove',
    assetA: _h(e, 1, 33), assetB: _h(e, 33, 65),
    shareAmount: _u64le(e, 65), deltaA: _u64le(e, 73), deltaB: _u64le(e, 81),
    recvASecp: _h(e, 89, 122), recvBSecp: _h(e, RECV_B, RECV_B + 33),
    kernelSig: _h(e, KS, KS + 64), rRecvA: _h(e, R, R + 32), rRecvB: _h(e, R + 32, R + 64),
  };
}

// T_CBTC_LOCK (0x66) — track-not-mint wire: legacy sigma-shaped fields still ride after Cy (offset 101) for
// compatibility, but reflection ignores them. v_btc is NOT in the envelope; the caller stamps it from the tx
// output at lock_vout, and OP_CBTC_MINT later proves the note opens to exactly that value.
function parseCbtcLockEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x66 || e.length !== 197) return null;
  return {
    type: 'cbtc_lock', asset: _h(e, 1, 33),
    lockVout: (e[33] | (e[34] << 8) | (e[35] << 16) | (e[36] * 0x1000000)) >>> 0,
    cx: _h(e, 37, 69), cy: _h(e, 69, 101),
    sigRx: _h(e, 101, 133), sigRy: _h(e, 133, 165), sigZ: _h(e, 165, 197),
  };
}

// T_CBTC_REDEEM (0x67) — the single-tx Bitcoin-native cBTC↔BTC redemption: the same tx UNLOCKS the named lock
// AND burns exactly v_btc of cBTC (Σ C_in = v_btc·H, the verified CXFER burn). Recognized so the reflection
// folds it (fold_cbtc_redeem) BEFORE the rug scan — retiring the lock off the live set, never slashing an
// honest exit. Layout: opcode ‖ lock_txid(32) ‖ lock_vout(4 LE) ‖ v_btc(8 LE) ‖ kernel_sig(64) = 109 bytes.
function parseCbtcRedeemEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x67 || e.length !== 109) return null;
  let v = 0n; for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(e[37 + j]);
  return {
    type: 'cbtc_redeem',
    lockTxid: _h(e, 1, 33),
    lockVout: (e[33] | (e[34] << 8) | (e[35] << 16) | (e[36] * 0x1000000)) >>> 0,
    vBtc: v.toString(),
    kernelSig: _h(e, 45, 109),
  };
}

// The sats value of output[vout] in a raw (segwit or legacy) tx — cBTC's v_btc, the lock output the note must
// open to. The guest reads it from the tx the same way; null if vout is out of range / the tx is malformed.
function txOutputValue(rawTxHex, vout) {
  const tx = hexToBytes(rawTxHex.startsWith('0x') ? rawTxHex.slice(2) : rawTxHex);
  let pos = (tx[4] === 0x00 && tx[5] === 0x01) ? 6 : 4; // skip version (+ segwit marker/flag)
  let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; pos += r[1];
  for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4; }
  r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; pos += r[1];
  for (let i = 0; i < outCount; i++) {
    if (i === vout) { let v = 0n; for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(tx[pos + j]); return v.toString(); }
    pos += 8; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0];
  }
  return null;
}

// The scriptPubKey hex of a tx's `vout`-th output (mirrors cxfer-core::bitcoin::output_scriptpubkey). The
// trustless-farm spends materialize their value note at vout[1]; the owner/launcher BIP-340 sig binds this
// DESTINATION so a mempool front-runner can't replay the public envelope into their own vout[1] and steal
// the reward/principal/treasury. Returns null if there is no such output (the guest's empty-vec fallback).
function txOutputScript(rawTxHex, vout) {
  const tx = hexToBytes(rawTxHex.startsWith('0x') ? rawTxHex.slice(2) : rawTxHex);
  let pos = (tx[4] === 0x00 && tx[5] === 0x01) ? 6 : 4; // skip version (+ segwit marker/flag)
  let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; pos += r[1];
  for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4; }
  r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; pos += r[1];
  for (let i = 0; i < outCount; i++) {
    pos += 8; r = readVarint(tx, pos); if (!r) return null; const sl = r[0]; pos += r[1];
    if (i === vout) { if (pos + sl > tx.length) return null; return bytesToHex(tx.slice(pos, pos + sl)); }
    pos += sl;
  }
  return null;
}

// T_CROSSOUT_MINT (0x65) — the Mode-B reverse mint (ETH→BTC). In a FORWARD batch (mode_b=0) the guest's
// fold_crossout ALWAYS skips (crossout_set_root=0 → set-membership fails) — it onboards nothing — but it reads
// the witnesses (set_index, set_path, note_path) for ANY parseable 0x65 first. Routing it (vs 'unsupported')
// lets the forward scan emit those witnesses + skip, so any 0x65 in a block leaves the forward scan able to
// attest it. The actual onboarding is the mode_b=1
// reverse-prove path (separate). Layout: opcode ‖ asset(32) ‖ claim_id(32) ‖ Cx(32) ‖ Cy(32) ‖ owner(32).
function parseCrossoutMintEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x65 || e.length !== 161) return null;
  return { type: 'crossout_mint', asset: _h(e, 1, 33), claimId: _h(e, 33, 65), cx: _h(e, 65, 97), cy: _h(e, 97, 129), owner: _h(e, 129, 161) };
}

// T_ETH_CALL (0x69) — an Ethereum-authorized message honored on Bitcoin (mirror of
// cxfer_core::bitcoin::parse_eth_call_envelope). Routed like 0x65 so a FORWARD batch emits the witnesses the
// guest reads and skips (fold_eth_message no-ops at eth_msg_set_root=0) instead of refusing the block —
// otherwise anyone could halt the relay by broadcasting one 0x69. Layout: opcode ‖ msg_id(32) ‖ ns(32) ‖
// sender(20) ‖ dest_chain(2 BE) ‖ payload_hash(32) ‖ payload_len(2 LE) ‖ payload(N).
function parseEthCallEnvelope(envHex) {
  const e = hexToBytes(envHex);
  const HEADER = 121;
  if (e[0] !== 0x69 || e.length < HEADER) return null;
  const payloadLen = e[119] | (e[120] << 8);
  // Exact length (no trailing bytes) + the payload cap, matching the Rust parser byte-for-byte: two
  // envelopes must never be able to carry the same message, and the fold's hash must stay bounded.
  if (e.length !== HEADER + payloadLen || payloadLen > 1024) return null;
  return {
    type: 'eth_call',
    msgId: _h(e, 1, 33),
    ns: _h(e, 33, 65),
    sender: _h(e, 65, 85),
    destChain: (e[85] << 8) | e[86],
    payloadHash: _h(e, 87, 119),
    payload: _h(e, HEADER, HEADER + payloadLen),
  };
}

// Mirror of cxfer_core::canonical_output_vout — the REAL Bitcoin vout of a cxfer-family envelope's i-th
// confidential output. Identity for 0x22/0x23/0x26/0x3C; the INTERLEAVE {0->0,1->2} for the variable-amount
// atomic settlement 0x37/0x3D (vout 1 is the maker BTC payment). null = no canonical tacit vout (skip).
function canonicalOutputVout(opcode, i, n) {
  if (opcode === 0x22 || opcode === 0x23 || opcode === 0x26 || opcode === 0x3c || opcode === 0x39) return i;
  if (opcode === 0x37 || opcode === 0x3d) { if (i === 0) return 0; if (i === 1 && n >= 2) return 2; return null; }
  return null;
}
// Mirror of cxfer_core::canonical_bid_output_vout — buyer filled note @vout0; seller change @vout3 (0x5B), or
// @vout4 with a buyer refund (fill_amount<max_fill) else @vout3 (0x5C).
function canonicalBidOutputVout(opcode, i, n, hasRefund) {
  if ((opcode === 0x5b || opcode === 0x5c) && i === 0) return 0;
  if (opcode === 0x5b && i === 1 && n >= 2) return 3;
  if (opcode === 0x5c && i === 1 && n >= 2) return hasRefund ? 4 : 3;
  return null;
}
// Mirror of cxfer_core::preauth_bid_var_has_refund — fill_amount < max_fill (both u64 LE inside the inline).
function preauthBidVarHasRefund(envHex) {
  const env = hexToBytes(envHex);
  if (env[0] !== 0x5c) return false;
  const maxOff = 1 + 32 + 1 + 16 + 33 + 8; // 91
  const fillOff = maxOff + 8 + 8; // 107 (skip max_fill + fill_increment)
  if (env.length < fillOff + 8) return false;
  const rd = (o) => new DataView(env.buffer, env.byteOffset + o, 8).getBigUint64(0, true);
  return rd(fillOff) < rd(maxOff);
}

// classifyConfidentialTx(rawTxHex) → the reflection scan's per-tx classification, MIRRORING the guest's
// reflect.rs (extract_taproot_envelope → parse_burn_envelope / parse_cxfer_envelope_full): a confidential
// bridge-burn → {type:'burn', assetId, nullifier, dest}; a confidential transfer → {type:'cxfer', assetId, commitments,
// kernelSig, rangeProof}; anything else (plain spend, non-confidential envelope) → null. This is the
// `classifyTx` buildScanReflectionAttester injects; the guest RE-parses from txData and is authoritative, so a
// misclassification is a liveness failure (the prove fails / skips), never a wrong attestation.
function classifyConfidentialTx(rawTxHex) {
  const envHex = extractTaprootEnvelope(rawTxHex);
  if (!envHex) return null;
  const burn = parseBurnEnvelope(envHex);
  if (burn) return { type: 'burn', assetId: burn.asset, nullifier: burn.nullifier, dest: burn.dest, target: burn.target };
  const opcode = hexToBytes(envHex)[0];
  const cx = parseCxferEnvelopeFull(envHex);
  if (cx) {
    // Per-opcode REAL Bitcoin vouts (mirrors the guest cxfer fold + commitmentForUtxo) — NOT the output index;
    // AXFER_VAR (0x37/0x3D) interleaves, so the maker-change note keys at vout 2, not vout 1. A malformed layout
    // (any null) is skipped, matching the guest's skip-not-fold (keeps the witness/spent-set stream in sync).
    const vouts = cx.commitments.map((_, i) => canonicalOutputVout(opcode, i, cx.commitments.length));
    if (vouts.some((v) => v === null)) return null;
    return { type: 'cxfer', opcode, assetId: cx.asset, commitments: cx.commitments, kernelSig: cx.kernelSig, rangeProof: cx.rangeProof, vouts, assetInputCount: cx.assetInputCount };
  }
  // A deployment-bound CXFER (0x39): the bound-note fold. Surfaces target_chain_binding so the assembler/guest
  // can require it == this deployment's chainBinding before onboarding. Identity vouts, like v1 CXFER.
  const cxb = parseCxferBoundEnvelope(envHex);
  if (cxb) {
    const vouts = cxb.commitments.map((_, i) => canonicalOutputVout(opcode, i, cxb.commitments.length));
    if (vouts.some((v) => v === null)) return null;
    return { type: 'cxfer_bound', opcode, target: cxb.target, assetId: cxb.asset, commitments: cxb.commitments, kernelSig: cxb.kernelSig, rangeProof: cxb.rangeProof, vouts };
  }
  // A preauth-bid fill (0x5B/0x5C) folds via the SAME cxfer fold; its notes key at the bid's canonical vouts
  // (buyer filled @0, seller change @3 or @4-with-refund) — NOT a flat vout[1] offset.
  const bid = parsePreauthBidEnvelope(envHex);
  if (bid) {
    const hasRefund = preauthBidVarHasRefund(envHex);
    const vouts = bid.commitments.map((_, i) => canonicalBidOutputVout(opcode, i, bid.commitments.length, hasRefund));
    if (vouts.some((v) => v === null)) return null;
    return { type: 'cxfer', opcode, assetId: bid.asset, commitments: bid.commitments, kernelSig: bid.kernelSig, rangeProof: bid.rangeProof, vouts };
  }
  // Track-B AMM ops whose fold data is FULLY on-chain (the indexer derives only the note paths) → route them
  // to their fold; the assembler advances the pool registry / onboards the receipt. Decode == the assembler's env.
  const amm = parseSwapVarEnvelope(envHex) || parseSwapRouteEnvelope(envHex) || parseHarvestEnvelope(envHex)
    || parseProtocolFeeClaimEnvelope(envHex) || parseFarmInitEnvelope(envHex);
  if (amm) return amm;
  // T_SWAP_BATCH (0x2F): fold data is fully on-chain too, but its BN254 Groth16 verify is async — the indexer's
  // injected hook verifies it against the pool's fold-point reserves, then onboards the n receipts. Route it (the
  // parser returns no `type`, so stamp it); the assembler's swap_batch branch reads exactly these fields.
  const sb = parseSwapBatchEnvelope(envHex);
  if (sb) return { type: 'swap_batch', ...sb };
  // lp_add (0x2D) / lp_remove (0x2E): the opening blindings (share_r / r_recv_a/b) ride the envelope,
  // so the indexer can fold them — route to their fold env.
  const la = parseLpAddEnvelope(envHex);
  if (la) return la;
  const lr = parseLpRemoveEnvelope(envHex);
  if (lr) return lr;
  // cBTC lock (0x66): v_btc is the lock output's sats value, stamped from the tx (the guest reads it from
  // the tx the same way). An out-of-range lock_vout is a SKIP in the guest (fold_cbtc_lock returns None,
  // reads no witness) — so carry vBtc=null and let foldCbtcLock skip it, rather than fail-loud 'unsupported'
  // which would halt the worker on a tx the authoritative guest silently ignores.
  const cb = parseCbtcLockEnvelope(envHex);
  if (cb) { const vBtc = txOutputValue(rawTxHex, cb.lockVout); return { ...cb, vBtc }; }
  // cBTC redeem (0x67): the honest single-tx exit. v_btc + the kernel sig are on-chain in the envelope; the
  // assembler's fold_cbtc_redeem re-verifies the burn against the tx's cBTC vins. Decode == the fold env.
  const cr = parseCbtcRedeemEnvelope(envHex);
  if (cr) return cr;
  // T_CROSSOUT_MINT (0x65, Mode-B reverse): route it so the forward scan emits the witnesses the guest reads +
  // skips (fold_crossout is a no-op in a forward batch — crossout_set_root=0), instead of refusing the block.
  const co = parseCrossoutMintEnvelope(envHex);
  if (co) return co;
  // T_ETH_CALL (0x69, ETH→BTC message): route it so the forward scan emits the witnesses the guest reads +
  // skips, instead of refusing the block (the fail-loud gate would otherwise be a one-tx relay stall).
  const ec = parseEthCallEnvelope(envHex);
  if (ec) return ec;
  // T_LP_BOND (0x35): trustless farm bond — owner+nonce ride the PUBLIC envelope (blinded, unlinkable) so any
  // prover folds it; the kernel binds bond_amount to the spent lp_asset notes. The assembler appends the
  // owner-blinded receipt + tracks total_shares (mirror reflect.rs lp_bond + the bond_backed gate).
  const lb = parseLpBond(envHex);
  if (lb) return lb;
  // T_LP_UNBOND (0x36): trustless complete exit — receipt fields + lp_return_r ride the envelope; the assembler
  // nullifies the receipt, drops shares, and mints the shares-worth lp_asset return note.
  const ub = parseLpUnbond(envHex);
  if (ub) return ub;
  // Anything else reaching here is a created-not-folded envelope (cetch/cmint), an unknown opcode, or a
  // malformed/truncated instance of a known opcode. The Rust guest also parses no fold in all of those cases and
  // reads no per-op witnesses, so mirror it as plain traffic. `unsupported` is reserved for explicit callers /
  // missing fold hooks that know a parseable guest-folded envelope would desync the stream.
  return null;
}

export { readVarint, extractInputs, inputFirstWitnessItem, sigBindsAllOutputs, noteSpendsBindOutputs, extractTaprootEnvelope, parseCetch, parseCmint, parseBurnEnvelope, parseCxferEnvelopeFull, axferAssetInputCount, parseCxferBoundEnvelope, encodeCxferBoundEnvelope, buildTacMigration, parsePreauthBidEnvelope, parseSwapBatchEnvelope, parseSwapVarEnvelope, parseSwapRouteEnvelope, parseHarvestEnvelope, parseProtocolFeeClaimEnvelope, parseFarmInitEnvelope, parseLpAddEnvelope, parseLpRemoveEnvelope, parseCbtcLockEnvelope, parseCbtcRedeemEnvelope, parseCrossoutMintEnvelope, parseEthCallEnvelope, txOutputValue, txOutputScript, classifyConfidentialTx };

// Build the burnDepositKit the worker injects (buildScanReflectionAttester → makeScanReflectionIndexer).
// Sources every crypto primitive from the SAME modules the pool/guest use (so verdicts match byte-for-byte)
// and the raw-tx parsers above. `deps` = { secp, keccak256, sha256 } (the @noble crypto the worker already has).
export function makeBurnDepositKit({ secp, keccak256, sha256 }) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const dsha = (b) => sha256(sha256(b));
  const computeTxidBytes = makeComputeTxidBytes(dsha);
  const computeTxid = (txHex) => { const t = computeTxidBytes(hexToBytes(txHex)); return t ? bytesToHex(t) : null; };

  // asset_id_from_etch: sha256(compute_txid(etch_tx) ‖ vout_LE=0) — the trustless supply anchor binding.
  const assetIdFromEtch = (etchTxHex) => {
    const t = computeTxidBytes(hexToBytes(etchTxHex));
    if (!t) return null;
    const pre = new Uint8Array(36); // txid(32) ‖ vout 0 LE (zeros)
    pre.set(t, 0);
    return bytesToHex(sha256(pre));
  };

  // verify_etch_anchor: bind asset_id to its CETCH reveal + read C_0 / mint_authority. The caller (mirror →
  // guest) confirms the etch tx is real/confirmed; this only checks the asset binding + CETCH shape.
  const parseEtchAnchor = (etchTxHex, assetHex) => {
    const aid = assetIdFromEtch(etchTxHex);
    if (!aid || aid.toLowerCase() !== '0x' + strip(assetHex).toLowerCase()) return null;
    const envHex = extractTaprootEnvelope(etchTxHex);
    if (!envHex) return null;
    const cetch = parseCetch(envHex);
    if (!cetch) return null;
    return { c0Compressed: cetch.c0Compressed, mintAuthority: cetch.mintAuthority };
  };

  // ── crypto adapters: feed makeBurnDepositProvenance the exact primitive shapes it expects ──
  // decompress → a secp ProjectivePoint (the pool's secp), used as conservation inputPoints + range inputs.
  const decompress = (cHex) => { try { return secp.ProjectivePoint.fromHex(strip(cHex)); } catch { return null; } };
  const commitmentHashCompressed = (cHex) => { const { cx, cy } = pool.decompressCommitment(cHex); return pool.commitmentHash(cx, cy); };
  const bip340Verify = (sigHex, msgBytes, pxHex) => verifySchnorr(hexToBytes(sigHex), msgBytes, hexToBytes(pxHex));
  // verify_range over the minted cmint commitment: bppRangeVerify uses bulletproofs-plus.js's OWN secp, so
  // rebuild the commitment point there via bppPoint(compressed) (the same gotcha verifyCxferConservation handles).
  const verifyRange = (points, rpHex) => {
    try { return bppRangeVerify(points.map((p) => bppPoint(p.toRawBytes(true))), hexToBytes(rpHex)); }
    catch { return false; }
  };
  // positional → object adapter for the pool's conservation predicate (the exact one the guest re-runs).
  const verifyCxferConservation = (asset, inputOutpoints, inputPoints, outputCompressed, rangeProof, kernelSig, burned) =>
    pool.verifyCxferConservation({ asset, inputOutpoints, inputPoints, outsCompressed: outputCompressed, rangeProof, kernelSig, burned: burned || 0 });

  const mirror = makeBurnDepositProvenance({
    outpointKey: pool.outpointKey,
    sha256,
    verifyCxferConservation,
    commitmentHashCompressed,
    decompress,
    extractTaprootEnvelope,
    parseCmint,
    computeTxid,
    extractInputs,
    bip340Verify,
    verifyRange,
    leaf: pool.leaf,
    btcNoteLeaf: pool.btcNoteLeaf,
    btcNoteLeafBound: pool.btcNoteLeafBound,
    merkleRootFrom: pool.merkleRootFrom,
    commitmentHash: pool.commitmentHash,
  });
  const assembler = makeBurnDepositAssembler({ dsha256: dsha, cat, bytesToHex });


  // ── Burn-deposit admission: the exact decision the reflection guest makes for a 0x2B burn of a note that is not
  // in the live set, computed over the SAME bytes the guest will read (the serialized provenance blob, the header
  // chain, the burn tx and its envelope). The worker only emits a non-empty blob when this admits, so a bundle the
  // guest would refuse never reaches the prover as a fold. The guest re-verifies all of it; this port only has to
  // agree with it.
  const hexU8 = (h) => hexToBytes(typeof h === 'string' ? h : bytesToHex(h));
  const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const isZeroBytes = (b) => b.every((x) => x === 0);
  // bits_to_target: nBits → 32-byte big-endian target; negative, zero-mantissa or exponent > 32 is invalid.
  const bitsToTarget = (h) => {
    if (h.length < 76) return null;
    const bits = (h[72] | (h[73] << 8) | (h[74] << 16) | (h[75] * 0x1000000)) >>> 0;
    const exp = bits >>> 24, mant = bits & 0x7fffff;
    if (bits & 0x00800000) return null;
    if (mant === 0) return null;
    if (exp > 32) return null;
    const t = new Uint8Array(32);
    const be4 = (v) => Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    if (exp <= 3) t.set(be4(mant >>> (8 * (3 - exp))), 28);
    else if (exp === 32) t.set(be4(mant).subarray(1), 0); // be4(mant)'s top byte is always 0 (mant < 2^24); its 3 real bytes exactly fill the target's leading edge here, where the general offset (31 - exp) would be -1
    else if (exp - 3 + 4 <= 32) t.set(be4(mant), 32 - (exp - 3) - 4);
    return t;
  };
  const beLte = (a, b) => { for (let i = 0; i < 32; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return true; };
  // verify_header_chain: every header 80 bytes with valid PoW, each linking to the previous; returns the tip hash.
  function headerChainTip(headers) {
    if (!headers.length) return null;
    let prev = null;
    for (const hh of headers) {
      const h = hexU8(hh);
      if (h.length !== 80) return null;
      const bh = dsha(h);
      const target = bitsToTarget(h);
      if (!target) return null;
      if (!beLte(Uint8Array.from(bh).reverse(), target)) return null;
      if (prev && !eqBytes(h.subarray(4, 36), prev)) return null;
      prev = Uint8Array.from(bh);
    }
    return prev;
  }
  // verify_merkle_path: fold a txid up its siblings by the index bits (double-SHA256, internal order).
  function merklePathRoot(txid, siblings, index) {
    let acc = Uint8Array.from(txid); let idx = index >>> 0;
    for (const sib of siblings) { acc = dsha(idx & 1 ? cat([sib, acc]) : cat([acc, sib])); idx >>>= 1; }
    return acc;
  }
  // The coinbase's BIP141 commitment output (last `6a24aa21a9ed‖32B` wins), scanned over the outputs only.
  function coinbaseCommitmentOutput(tx) {
    if (tx.length < 4) return null;
    let pos = (tx.length > 5 && tx[4] === 0x00 && tx[5] === 0x01) ? 6 : 4;
    let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; pos += r[1];
    for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4; }
    r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; pos += r[1];
    let c = null;
    for (let i = 0; i < outCount; i++) {
      pos += 8; r = readVarint(tx, pos); if (!r) return null; pos += r[1];
      const end = pos + r[0]; if (end > tx.length) return null;
      const sc = tx.subarray(pos, end);
      if (sc.length >= 38 && sc[0] === 0x6a && sc[1] === 0x24 && sc[2] === 0xaa && sc[3] === 0x21 && sc[4] === 0xa9 && sc[5] === 0xed) c = sc.subarray(6, 38);
      pos = end;
    }
    return c;
  }
  // parse_coinbase_commitment: a SegWit coinbase whose input-0 witness is exactly one 32-byte reserved value.
  function coinbaseCommitment(tx) {
    if (tx.length < 6 || tx[4] !== 0x00 || tx[5] !== 0x01) return null;
    let pos = 6;
    let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; pos += r[1];
    for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4; }
    r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; pos += r[1];
    let c = null;
    for (let i = 0; i < outCount; i++) {
      pos += 8; r = readVarint(tx, pos); if (!r) return null; pos += r[1];
      const end = pos + r[0]; if (end > tx.length) return null;
      const sc = tx.subarray(pos, end);
      if (sc.length >= 38 && sc[0] === 0x6a && sc[1] === 0x24 && sc[2] === 0xaa && sc[3] === 0x21 && sc[4] === 0xa9 && sc[5] === 0xed) c = sc.subarray(6, 38);
      pos = end;
    }
    if (!c) return null;
    r = readVarint(tx, pos); if (!r) return null; if (r[0] !== 1) return null; pos += r[1];
    r = readVarint(tx, pos); if (!r) return null; if (r[0] !== 32) return null; pos += r[1];
    if (pos + 32 > tx.length) return null;
    return { commitment: c, reserved: tx.subarray(pos, pos + 32) };
  }
  // verify_tx_witness_committed → 'ok' | 'no' | 'abort'. 'abort' is a coinbase that carries a commitment output but
  // no committed reserved value: the guest treats that as a tampered proof and panics, so it must never be emitted.
  function witnessCommitted(tx, txIndex, wtxidSiblings, coinbase, cbTxidSiblings, txidRoot) {
    const cbTxid = computeTxidBytes(coinbase);
    if (!cbTxid) return 'no';
    if (!eqBytes(merklePathRoot(cbTxid, cbTxidSiblings, 0), txidRoot)) return 'no';
    const cc = coinbaseCommitment(coinbase);
    if (!cc) return coinbaseCommitmentOutput(coinbase) ? 'abort' : 'no';
    const wroot = merklePathRoot(dsha(tx), wtxidSiblings, txIndex);
    return eqBytes(dsha(cat([wroot, cc.reserved])), cc.commitment) ? 'ok' : 'no';
  }
  // verify_range: the scheme is selected by proof length (classic Bulletproofs or BP+), anything else rejects.
  function rangeOk(compressedList, proof) {
    try {
      return proof.length === bpClassicProofLen(compressedList.length)
        ? bpRangeVerify(compressedList, proof)
        : bppRangeVerify(compressedList.map((c) => bppPoint(c)), proof);
    } catch { return false; }
  }
  const pointOk = (c33) => { try { secp.ProjectivePoint.fromHex(bytesToHex(c33).slice(2)); return c33.length === 33; } catch { return false; } };
  const chCompressed = (c33) => (pointOk(c33) ? commitmentHashCompressed(bytesToHex(c33)).toLowerCase() : null);
  const opKey = (txid, vout) => pool.outpointKey(bytesToHex(txid), vout >>> 0).toLowerCase();
  // burn_deposit::ProvenanceBlob::parse, including its count caps and exact consumption.
  function parseBlob(b) {
    let i = 0;
    const u32 = () => { if (i + 4 > b.length) throw 0; const v = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] * 0x1000000)) >>> 0; i += 4; return v; };
    const u64 = () => { if (i + 8 > b.length) throw 0; let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]); i += 8; return v; };
    const bytes = () => { const n = u32(); if (i + n > b.length) throw 0; const v = b.subarray(i, i + n); i += n; return v; };
    const a = (n) => { if (i + n > b.length) throw 0; const v = b.subarray(i, i + n); i += n; return v; };
    const vec = (n) => { const c = u32(); if (c > 4096) throw 0; const out = []; for (let k = 0; k < c; k++) out.push(a(n)); return out; };
    const vu32 = () => { const c = u32(); if (c > 4096) throw 0; const out = []; for (let k = 0; k < c; k++) out.push(u32()); return out; };
    try {
      const etchTx = bytes(), etchIndex = u32(), etchSiblings = vec(32), etchWtxidSiblings = vec(32);
      const etchCoinbase = bytes(), etchCbTxidSiblings = vec(32);
      const ncm = u32(); if (ncm > 1024) return null;
      const cmints = [];
      for (let k = 0; k < ncm; k++) cmints.push({ revealTx: bytes(), commitTx: bytes(), merkleSiblings: vec(32), merkleIndex: u32(), revealWtxidSiblings: vec(32), revealCoinbase: bytes(), revealCbTxidSiblings: vec(32) });
      const ncx = u32(); if (ncx > 256) return null;
      const prov = [];
      for (let k = 0; k < ncx; k++) prov.push({ tx: bytes(), inputCommitments: vec(33), outputVouts: vu32(), burnedAmount: u64(), inputSkip: u32(), merkleIndex: u32(), merkleSiblings: vec(32), confirmedBlockRoot: a(32), wtxidSiblings: vec(32), coinbase: bytes(), coinbaseTxidSiblings: vec(32) });
      const npm = u32(); if (npm > 256) return null;
      const poolMemberships = [];
      for (let k = 0; k < npm; k++) poolMemberships.push({ outpoint: a(32), cx: a(32), cy: a(32), owner: a(32), noteClass: u32(), chainBinding: a(32), leafIndex: u64(), path: vec(32) });
      if (i !== b.length) return null;
      return { etchTx, etchIndex, etchSiblings, etchWtxidSiblings, etchCoinbase, etchCbTxidSiblings, cmints, prov, poolMemberships };
    } catch { return null; }
  }
  // verify_etch_anchor: asset id bound to the etch txid, a well-formed CETCH, and a range-bounded C_0.
  function etchAnchor(etchTx, assetHex) {
    const txid = computeTxidBytes(etchTx);
    if (!txid) return null;
    const pre = new Uint8Array(36); pre.set(txid, 0);
    if (bytesToHex(sha256(pre)).toLowerCase() !== bytesToHex(hexU8(assetHex)).toLowerCase()) return null;
    const env = extractTaprootEnvelope(bytesToHex(etchTx));
    if (!env) return null;
    const ce = parseCetch(env);
    if (!ce) return null;
    const c0 = hexToBytes(ce.c0Compressed);
    if (!pointOk(c0) || !rangeOk([c0], hexToBytes(ce.rangeProof))) return null;
    return { c0, mintAuthority: hexToBytes(ce.mintAuthority), etchTxid: txid };
  }
  // verify_cmint_authorized.
  function cmintLeaf(assetHex, mintAuthority, etchTxid, revealTx, commitTx) {
    if (isZeroBytes(mintAuthority)) return null;
    const env = extractTaprootEnvelope(bytesToHex(revealTx));
    if (!env) return null;
    const cm = parseCmint(env);
    if (!cm) return null;
    if (!eqBytes(hexToBytes(cm.asset), hexU8(assetHex))) return null;
    if (!eqBytes(hexToBytes(cm.etchTxid), etchTxid)) return null;
    const commitTxid = computeTxidBytes(commitTx);
    if (!commitTxid) return null;
    const rIns = extractInputs(bytesToHex(revealTx));
    if (!rIns || !rIns.length) return null;
    if (!eqBytes(hexToBytes(rIns[0].prevTxid), commitTxid) || rIns[0].prevVout !== 0) return null;
    const cIns = extractInputs(bytesToHex(commitTx));
    if (!cIns || !cIns.length) return null;
    const vle = new Uint8Array(4); new DataView(vle.buffer).setUint32(0, cIns[0].prevVout >>> 0, true);
    const msg = sha256(cat([new TextEncoder().encode('tacit-mint-v1'), hexU8(assetHex), hexToBytes(cIns[0].prevTxid), vle, hexToBytes(cm.commitment), hexToBytes(cm.encryptedAmount)]));
    if (!verifySchnorr(hexToBytes(cm.issuerSig), msg, mintAuthority)) return null;
    const c = hexToBytes(cm.commitment);
    if (!pointOk(c) || !rangeOk([c], hexToBytes(cm.rangeProof))) return null;
    const revealTxid = computeTxidBytes(revealTx);
    if (!revealTxid) return null;
    return [opKey(revealTxid, 0), chCompressed(c)];
  }
  // burn_deposit::verify_cxfers → the linkage shape, or 'abort' / null.
  function verifiedHops(assetHex, prov) {
    const out = [];
    for (const p of prov) {
      const txid = computeTxidBytes(p.tx);
      if (!txid) return null;
      if (!eqBytes(merklePathRoot(txid, p.merkleSiblings, p.merkleIndex), p.confirmedBlockRoot)) return null;
      const w = witnessCommitted(p.tx, p.merkleIndex, p.wtxidSiblings, p.coinbase, p.coinbaseTxidSiblings, p.confirmedBlockRoot);
      if (w !== 'ok') return w === 'abort' ? 'abort' : null;
      const envHex = extractTaprootEnvelope(bytesToHex(p.tx));
      if (!envHex) return null;
      const cx = parseCxferEnvelopeFull(envHex);
      if (!cx) return null;
      if (!eqBytes(hexToBytes(cx.asset), hexU8(assetHex))) return null;
      const all = extractInputs(bytesToHex(p.tx));
      if (!all) return null;
      if (p.inputSkip > all.length) return null;
      // An atomic settlement's kernel covers only its asset inputs, vin[1..1+asset_input_count]; the rest are the
      // taker's sats, and its witnessed skip must name that position.
      let ins;
      if (cx.assetInputCount == null) ins = all.slice(p.inputSkip);
      else if (p.inputSkip !== 1 || 1 + cx.assetInputCount > all.length) return null;
      else ins = all.slice(1, 1 + cx.assetInputCount);
      if (p.inputCommitments.length !== ins.length) return null;
      if (p.outputVouts.length !== cx.commitments.length) return null;
      if (!p.inputCommitments.every(pointOk)) return null;
      const inputPoints = p.inputCommitments.map((c) => secp.ProjectivePoint.fromHex(bytesToHex(c).slice(2)));
      let conserves = false;
      try {
        conserves = pool.verifyCxferConservation({
          asset: assetHex, inputOutpoints: ins.map((x) => [x.prevTxid, x.prevVout]), inputPoints,
          outsCompressed: cx.commitments, rangeProof: cx.rangeProof, kernelSig: cx.kernelSig, burned: p.burnedAmount,
        });
      } catch { conserves = false; }
      if (!conserves) return null;
      const inputs = ins.map((x, k) => [opKey(hexToBytes(x.prevTxid), x.prevVout), chCompressed(p.inputCommitments[k])]);
      const opcode = hexToBytes(envHex)[0];
      const outputs = [];
      for (let k = 0; k < cx.commitments.length; k++) {
        const ch = chCompressed(hexToBytes(cx.commitments[k]));
        if (!ch) return null;
        const canonical = canonicalOutputVout(opcode, k, cx.commitments.length);
        if (canonical === null || p.outputVouts[k] !== canonical) return null;
        outputs.push([canonical, ch]);
      }
      out.push({ txid, inputs, outputs });
    }
    return out;
  }
  // burn_deposit::verify_provenance_dag_leaves: every hop reachable from a supply leaf (fixpoint), no duplicate
  // producer or double consume, and the burned outpoint produced by the DAG but not consumed inside it.
  function dagCommitmentHash(leaves, burnedOutpoint, hops) {
    if (!hops.length) return null;
    const produced = new Map();
    for (const h of hops) {
      if (!h.outputs.length) return null;
      for (const [vout, ch] of h.outputs) { const op = opKey(h.txid, vout); if (produced.has(op)) return null; produced.set(op, ch); }
    }
    const consumed = new Set();
    for (const h of hops) {
      if (!h.inputs.length) return null;
      for (const [op] of h.inputs) { if (consumed.has(op)) return null; consumed.add(op); }
    }
    const reachable = leaves.map(([o, c]) => [o.toLowerCase(), String(c).toLowerCase()]);
    const accepted = hops.map(() => false);
    for (;;) {
      let progress = false;
      hops.forEach((h, k) => {
        if (accepted[k]) return;
        if (h.inputs.every(([op, ch]) => reachable.some(([o, c]) => o === op && c === ch))) {
          accepted[k] = true; progress = true;
          for (const [vout, ch] of h.outputs) reachable.push([opKey(h.txid, vout), ch]);
        }
      });
      if (!progress) break;
    }
    if (accepted.some((x) => !x)) return null;
    if (consumed.has(burnedOutpoint)) return null;
    return produced.has(burnedOutpoint) ? produced.get(burnedOutpoint) : null;
  }
  // The burned note's leaf: a native leaf whose owner is its own Bitcoin outpoint key, so its nullifier is unique to
  // that UTXO. The envelope ν must be this leaf's nullifier.
  const burnDepositLeaf = (assetHex, cx, cy, burnedTxidHex, burnedVout) =>
    pool.leaf(assetHex, cx, cy, pool.outpointKey(burnedTxidHex, burnedVout >>> 0));
  // admitBurnDeposit → { admitted, reason, burnedTxid, burnedVout, burnedNoteLeaf }. `burnedTxid/Vout` are always the
  // burn tx's first input (what the guest binds), whatever the bundle claims. A consumed-outpoint (fast-lane) check is
  // state-dependent and is made by the fold itself, not here.
  function admitBurnDeposit({ burnTxHex, envAsset, envNu, blobHex, provHeaders = [], burnedCx, burnedCy, batchPrevHash }) {
    const burnIns = extractInputs(burnTxHex);
    const burnedTxid = burnIns && burnIns.length ? burnIns[0].prevTxid.toLowerCase() : null;
    const burnedVout = burnIns && burnIns.length ? burnIns[0].prevVout : 0;
    const res = (admitted, reason) => ({
      admitted, reason, burnedTxid, burnedVout,
      burnedNoteLeaf: burnedTxid && burnedCx && burnedCy ? burnDepositLeaf(envAsset, burnedCx, burnedCy, burnedTxid, burnedVout) : null,
    });
    const pb = parseBlob(hexU8(blobHex || '0x'));
    if (!pb) return res(false, 'blob does not parse');
    const tip = headerChainTip(provHeaders);
    if (!tip || !batchPrevHash || bytesToHex(tip).toLowerCase() !== String(batchPrevHash).toLowerCase()) return res(false, 'header chain does not reach the batch anchor');
    const roots = new Set(provHeaders.map((hh) => bytesToHex(hexU8(hh).subarray(36, 68)).toLowerCase()));
    if (!pb.prov.every((c) => roots.has(bytesToHex(c.confirmedBlockRoot).toLowerCase()))) return res(false, 'a hop block is not in the header chain');
    const leaves = [];
    if (pb.etchTx.length) {
      const anchor = etchAnchor(pb.etchTx, envAsset);
      if (!anchor) return res(false, 'etch anchor');
      const etchRoot = merklePathRoot(anchor.etchTxid, pb.etchSiblings, pb.etchIndex);
      if (!roots.has(bytesToHex(etchRoot).toLowerCase())) return res(false, 'etch block not in the header chain');
      const ew = witnessCommitted(pb.etchTx, pb.etchIndex, pb.etchWtxidSiblings, pb.etchCoinbase, pb.etchCbTxidSiblings, etchRoot);
      if (ew !== 'ok') return res(false, ew === 'abort' ? 'etch coinbase downgraded' : 'etch witness not committed');
      const c0Ch = chCompressed(anchor.c0);
      if (!c0Ch) return res(false, 'C_0 not a point');
      leaves.push([opKey(anchor.etchTxid, 0), c0Ch]);
      const seenCommits = [];
      for (const cm of pb.cmints) {
        const revealTxid = computeTxidBytes(cm.revealTx);
        if (!revealTxid) return res(false, 'cmint reveal txid');
        const root = merklePathRoot(revealTxid, cm.merkleSiblings, cm.merkleIndex);
        if (!roots.has(bytesToHex(root).toLowerCase())) return res(false, 'cmint block not in the header chain');
        const commitTxid = computeTxidBytes(cm.commitTx);
        if (!commitTxid) return res(false, 'cmint commit txid');
        if (seenCommits.some((c) => eqBytes(c, commitTxid))) return res(false, 'cmint commit reused');
        seenCommits.push(commitTxid);
        const cw = witnessCommitted(cm.revealTx, cm.merkleIndex, cm.revealWtxidSiblings, cm.revealCoinbase, cm.revealCbTxidSiblings, root);
        if (cw !== 'ok') return res(false, cw === 'abort' ? 'cmint coinbase downgraded' : 'cmint witness not committed');
        const leaf = cmintLeaf(envAsset, anchor.mintAuthority, anchor.etchTxid, cm.revealTx, cm.commitTx);
        if (!leaf) return res(false, 'cmint not authorized');
        leaves.push(leaf);
      }
    }
    if (pb.poolMemberships.length) return res(false, 'pool-membership leaves are refused');
    if (!burnedTxid) return res(false, 'burn tx has no inputs');
    const burnedOutpoint = pool.outpointKey(burnedTxid, burnedVout).toLowerCase();
    if (!pb.prov.length) return res(false, 'empty provenance');
    const hops = verifiedHops(envAsset, pb.prov);
    if (hops === 'abort') return res(false, 'hop coinbase downgraded');
    if (!hops) return res(false, 'a provenance hop does not verify');
    const realCh = dagCommitmentHash(leaves, burnedOutpoint, hops);
    if (!realCh) return res(false, 'burned note does not descend from a supply leaf');
    // A wrong opening for a reachable burn is a prover error the guest aborts on; the blob is then withheld instead.
    if (pool.commitmentHash(burnedCx, burnedCy).toLowerCase() !== realCh) return res(false, 'bundle opening does not match the authenticated commitment');
    const leaf = burnDepositLeaf(envAsset, burnedCx, burnedCy, burnedTxid, burnedVout);
    if (pool.nullifier(leaf).toLowerCase() !== String(envNu).toLowerCase()) return res(false, 'envelope nullifier does not match the burned note');
    return res(true, 'admitted');
  }
  // The 161-byte burn envelope for a burn-deposit spending `burnedTxid:burnedVout` (internal byte order):
  //   0x2B ‖ asset(32) ‖ pool-root field(32, unused) ‖ ν(32) ‖ dest(32) ‖ target(32), ν = nullifier(burnDepositLeaf).
  function buildBurnDepositEnvelope({ assetId, cx, cy, burnedTxid, burnedVout, dest, target, poolRootField = null }) {
    const leaf = burnDepositLeaf(assetId, cx, cy, burnedTxid, burnedVout);
    const nu = pool.nullifier(leaf);
    const f32 = (h) => { const b = hexU8(h); if (b.length !== 32) throw new Error('burn envelope: 32-byte field expected'); return b; };
    const env = cat([Uint8Array.of(0x2b), f32(assetId), poolRootField ? f32(poolRootField) : new Uint8Array(32), f32(nu), f32(dest), f32(target)]);
    return { envelope: bytesToHex(env), nu, burnedNoteLeaf: leaf };
  }

  return { mirror, assembler, parseEtchAnchor, computeTxidInternal: computeTxid, admitBurnDeposit, buildBurnDepositEnvelope, burnDepositLeaf };
}
