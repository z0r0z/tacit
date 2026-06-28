// Raw-tx-hex Bitcoin parsers (faithful JS ports of cxfer-core/src/bitcoin.rs) + the `burnDepositKit`
// factory the worker injects into makeScanReflectionIndexer to assemble TAC burn-deposit / cmint-deposit
// onboarding (a 0x2B burn of a PRE-existing, never-reflected note proven real via per-bridge provenance).
//
// The AUTHORITATIVE parser is the reflection guest (the Rust). These ports must match it byte-for-byte: a
// mismatch makes the worker assemble a witness the guest REJECTS — a LIVENESS failure (the holder's bridge
// doesn't prove), never a soundness one (the guest is the arbiter; it only mints what its own parse accepts).
// Validated against btc-mini-built fixtures in tests/burn-deposit-kit.mjs (computeTxid == btc-mini, envelope
// round-trips buildRevealTx, asset_id == sha256(internalTxid‖vout0), a full synthetic burn-deposit verifies).

import { makeConfidentialPool } from './confidential-pool.js';
import { verifySchnorr } from './bulletproofs.js';
import { bppRangeVerify, bytesToPoint as bppPoint } from './bulletproofs-plus.js';
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
// 64-byte blob (round-8 C-01) — a merkle internal node (txid_L‖txid_R, ≈random bytes) parses as a tx with
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
    // C-01: admit a 64-byte non-witness tx iff it parses (real tx → no reflection stall); reject the
    // collision blob (a merkle internal node masquerading as a tx).
    if (tx.length === 64 && !segwit && !nonwitnessTxExactLen(tx)) return null;
    if (!segwit) return dsha(tx);
    const version = tx.subarray(0, 4);
    let pos = 6;
    const inputsStart = pos;
    let r = readVarint(tx, pos); if (!r) return null; const inCount = r[0]; pos += r[1];
    for (let i = 0; i < inCount; i++) { pos += 36; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0] + 4; }
    r = readVarint(tx, pos); if (!r) return null; const outCount = r[0]; pos += r[1];
    for (let i = 0; i < outCount; i++) { pos += 8; r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0]; }
    const outputsEnd = pos;
    for (let i = 0; i < inCount; i++) {
      r = readVarint(tx, pos); if (!r) return null; const wc = r[0]; pos += r[1];
      for (let j = 0; j < wc; j++) { r = readVarint(tx, pos); if (!r) return null; pos += r[1] + r[0]; }
    }
    if (outputsEnd > tx.length || pos + 4 > tx.length) return null;
    const locktime = tx.subarray(pos, pos + 4);
    const stripped = cat([version, tx.subarray(inputsStart, outputsEnd), locktime]);
    // C-01 parity (mirror cxfer-core): a stripped form of exactly 64 bytes is admitted iff it parses.
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

// extract_taproot_envelope (cxfer-core::bitcoin::extract_taproot_envelope): from the first input's witness
// item[1] tapscript (PUSH32 xonly ‖ OP_CHECKSIG ‖ OP_FALSE OP_IF ‖ data pushes ‖ OP_ENDIF), concatenate the
// pushed chunks, strip the "TACIT"‖0x01 frame, return the envelope (env[0] = opcode) as hex. null otherwise.
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
  p += rpLen;
  if (p + 32 > env.length) return null;
  const mintAuthority = env.subarray(p, p + 32);
  return { c0Compressed: bytesToHex(commitment), mintAuthority: bytesToHex(mintAuthority), decimals };
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
//   { asset, nullifier, dest } (all hex). Layout (env[0]=0x2B, exactly 129B):
//   opcode(1) ‖ assetId(32) ‖ bitcoinPoolRoot(32) ‖ nullifier(32) ‖ destCommitment(32).
function parseBurnEnvelope(envHex) {
  const env = hexToBytes(envHex);
  if (env.length !== 129 || env[0] !== 0x2b) return null;
  return {
    asset: bytesToHex(env.subarray(1, 33)),
    nullifier: bytesToHex(env.subarray(65, 97)),
    dest: bytesToHex(env.subarray(97, 129)),
  };
}

// parse_cxfer_envelope_full (cxfer-core::bitcoin::parse_cxfer_envelope_full): a confidential transfer
// (T_CXFER_BPP 0x22 OR T_CXFER 0x23, identical wire shape) → { asset, kernelSig, commitments[], rangeProof }
// (all hex; commitments compressed). Layout (env[0]∈{0x22,0x23}):
//   opcode(1) ‖ assetId(32) ‖ kernel_sig(64) ‖ N(1,∈{1,2,4,8}) ‖ N×(commitment(33) ‖ amount_ct(8)) ‖ rpLen(2 LE) ‖ rp.
// T_CXFER_BPP(0x22) / T_CXFER(0x23) + the atomic-settlement family T_AXFER(0x26/0x37/0x3C/0x3D): identical
// wire shape, all folded by the guest via the same parse_cxfer_envelope_full → fold_cxfer (single-asset
// Σin=Σout kernel + BP+ range), so the JS reflection mirrors them all as 'cxfer'.
const CXFER_OPCODES = new Set([0x22, 0x23, 0x26, 0x37, 0x3c, 0x3d]);
function parseCxferEnvelopeFull(envHex) {
  const env = hexToBytes(envHex);
  if (env.length < 1 + 32 + 64 + 1 || !CXFER_OPCODES.has(env[0])) return null;
  const asset = env.subarray(1, 33);
  const kernelSig = env.subarray(33, 97);
  let p = 97;
  const n = env[p]; p += 1;
  if (![1, 2, 4, 8].includes(n) || p + n * (33 + 8) + 2 > env.length) return null;
  const commitments = [];
  for (let i = 0; i < n; i++) { commitments.push(bytesToHex(env.subarray(p, p + 33))); p += 33 + 8; }
  const rpLen = env[p] | (env[p + 1] << 8); p += 2;
  if (p + rpLen !== env.length) return null;
  return { asset: bytesToHex(asset), kernelSig: bytesToHex(kernelSig), commitments, rangeProof: bytesToHex(env.subarray(p, p + rpLen)) };
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
// tip_a_c(33) ‖ tip_b_c(33) ‖ r_tip_a(32) ‖ r_tip_b(32) ‖ n×intent(352) ‖ n×receipt(234) ‖ proofLen(2) ‖ proof ‖
// metaLen(1) ‖ meta. intent = dir(1) ‖ pubkey(33) ‖ c_in_secp(33) ‖ c_in_bjj(32) ‖ in_xsigma(169) ‖ min_out(8) ‖
// tip(8) ‖ expiry(4) ‖ sig(64). receipt = c_out_secp(33) ‖ c_out_bjj(32) ‖ out_xsigma(169).
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
    take(32); take(32); // r_tip_a, r_tip_b (not needed by the reflection)
    const intents = [];
    for (let i = 0; i < ni; i++) {
      const s = take(SWAP_BATCH_INTENT_LEN); const dir = env[s]; if (dir > 1) return null;
      intents.push({ direction: dir, cInSecp: bytesToHex(env.subarray(s + 34, s + 67)), cInBjj: bytesToHex(env.subarray(s + 67, s + 99)), minOut: u64le(s + 268).toString(), tipAmount: u64le(s + 276).toString() });
    }
    const receipts = [];
    for (let i = 0; i < ni; i++) {
      const s = take(SWAP_BATCH_RECEIPT_LEN);
      receipts.push({ cOutSecp: bytesToHex(env.subarray(s, s + 33)), cOutBjj: bytesToHex(env.subarray(s + 33, s + 65)), outXcurveSigma: bytesToHex(env.subarray(s + 65, s + 65 + SWAP_BATCH_XSIGMA)) });
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
  return { type: 'swap_var', poolId: _h(e, 1, 33), direction: e[33], rAPre: _u64le(e, 34), rBPre: _u64le(e, 42), deltaIn: _u64le(e, 50), deltaOut: _u64le(e, 74), tipAmount: _u64le(e, 90), cIn: _h(e, 136, 169), cChangeOrSentinel: _h(e, 169, 202), cReceipt: _h(e, 202, 235), rReceipt: _h(e, 235, 267), kernelSig: _h(e, ks, ks + 64) };
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
  return { type: 'swap_route', traderInputAsset: _h(e, 2, 34), traderOutputAsset: _h(e, 34, 66), hops, cIn, cReceipt, rReceipt, kernelSig: _h(e, p, p + 64) };
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
  // the claim + vout-0 destination (round-6 — the claimer/sig were previously parsed-over).
  if (e[0] !== 0x31 || e.length !== 207) return null;
  return { type: 'protocol_fee_claim', poolId: _h(e, 1, 33), claimer: _h(e, 33, 66), feeBps: _u32le(e, 66), amount: _u64le(e, 70), cSecp: _h(e, 78, 111), blinding: _h(e, 111, 143), sig: _h(e, 143, 207) };
}
function parseFarmInitEnvelope(envHex) {
  const e = hexToBytes(envHex);
  const HDR = 1 + 32 + 32 + 33 + 32 + 8 + 8 + 4 + 4 + 33; // 187 = rp_len offset
  if (e[0] !== 0x34 || e.length < HDR + 2) return null;
  const rpLen = e[HDR] | (e[HDR + 1] << 8), ks = HDR + 2 + rpLen;
  if (e.length !== ks + 64 + 64) return null; // EXACT close (kernel_sig + launcher_sig), matching guest parse_farm_init_envelope
  // start_height[146..150] + end_height[150..154]: the campaign window the reflection clamps accrual to
  // (was parsed-over before). end == 0 ⇒ perpetual. Mirrors guest parse_farm_init_envelope.
  return { type: 'farm_init', poolId: _h(e, 1, 33), farmNonce: _h(e, 33, 65), launcherPubkey: _h(e, 65, 98), rewardAsset: _h(e, 98, 130), rewardTotal: _u64le(e, 130), rewardPerBlock: _u64le(e, 138), startHeight: _u32le(e, 146), endHeight: _u32le(e, 150), cChangeOrSentinel: _h(e, 154, 187), kernelSig: _h(e, ks, ks + 64) };
}
// T_LP_BOND (0x35): farm_id(32) ‖ bonder_pubkey(33) ‖ bond_amount(8) ‖ entry_acc(16) ‖ view_h(4) ‖
// owner_commit(32)[94..126] ‖ nonce(32)[126..158] ‖ c_change(33)[158..191] ‖ rp_len(2)[191..193] ‖
// range_proof(rp_len) ‖ kernel_sig(64) ‖ bonder_sig(64). Mirrors guest parse_lp_bond_fields_full + encodeLpBond.
function parseLpBond(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x35 || e.length < 193) return null;
  const rpLen = e[191] | (e[192] << 8), ks = 193 + rpLen;
  if (e.length !== ks + 64 + 64) return null; // exact close: kernel_sig(64) + bonder_sig(64)
  return { type: 'lp_bond', farmId: _h(e, 1, 33), bonderPubkey: _h(e, 33, 66), bondAmount: _u64le(e, 66), owner: _h(e, 94, 126), nonce: _h(e, 126, 158), kernelSig: _h(e, ks, ks + 64) };
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
  const HEADER = 452, TAIL = 484;
  if (e[0] !== 0x2D || e.length < TAIL) return null;
  const variant = e[1];
  if (variant !== 0 && variant !== 1) return null;
  let feeBps = 0, capabilityFlags = 0, protocolFeeAddress = '0x' + '00'.repeat(33), protocolFeeBps = 0;
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
    } catch { return null; }
  }
  return {
    type: 'lp_add', variant,
    assetA: _h(e, 2, 34), assetB: _h(e, 34, 66),
    deltaA: _u64le(e, 66), deltaB: _u64le(e, 74), shareAmount: _u64le(e, 82),
    shareCsecp: _h(e, 90, 123), kernelSigA: _h(e, 324, 388), kernelSigB: _h(e, 388, 452),
    shareR: _h(e, HEADER, TAIL),
    feeBps, capabilityFlags, protocolFeeAddress, protocolFeeBps,
  };
}

// T_LP_REMOVE (0x2E) — option-a wire: the two recv blindings r_recv_a/b ride after the kernel sig (offset 621),
// before the proof. Mirrors cxfer-core parse_lp_remove_envelope.
function parseLpRemoveEnvelope(envHex) {
  const e = hexToBytes(envHex);
  const RECV_B = 323, KS = 557, R = KS + 64; // 621
  if (e[0] !== 0x2E || e.length < R + 64 + 2) return null;
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
    lockVout: e[33] | (e[34] << 8) | (e[35] << 16) | (e[36] * 0x1000000),
    cx: _h(e, 37, 69), cy: _h(e, 69, 101),
    sigRx: _h(e, 101, 133), sigRy: _h(e, 133, 165), sigZ: _h(e, 165, 197),
  };
}

// T_CBTC_REDEEM (0x67) — the single-tx Bitcoin-native cBTC↔BTC redemption: the same tx UNLOCKS the named lock
// AND burns exactly v_btc of cBTC (Σ C_in = v_btc·H, the audited CXFER burn). Recognized so the reflection
// folds it (fold_cbtc_redeem) BEFORE the rug scan — retiring the lock off the live set, never slashing an
// honest exit. Layout: opcode ‖ lock_txid(32) ‖ lock_vout(4 LE) ‖ v_btc(8 LE) ‖ kernel_sig(64) = 109 bytes.
function parseCbtcRedeemEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x67 || e.length !== 109) return null;
  let v = 0n; for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(e[37 + j]);
  return {
    type: 'cbtc_redeem',
    lockTxid: _h(e, 1, 33),
    lockVout: e[33] | (e[34] << 8) | (e[35] << 16) | (e[36] * 0x1000000),
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
// lets the forward scan emit those witnesses + skip, so a 0x65 (a reverse-mint once that path is live, or a
// crafted one) no longer makes the attester refuse the block. The actual onboarding is the mode_b=1
// reverse-prove path (separate). Layout: opcode ‖ asset(32) ‖ claim_id(32) ‖ Cx(32) ‖ Cy(32) ‖ owner(32).
function parseCrossoutMintEnvelope(envHex) {
  const e = hexToBytes(envHex);
  if (e[0] !== 0x65 || e.length !== 161) return null;
  return { type: 'crossout_mint', asset: _h(e, 1, 33), claimId: _h(e, 33, 65), cx: _h(e, 65, 97), cy: _h(e, 97, 129), owner: _h(e, 129, 161) };
}

// Mirror of cxfer_core::canonical_output_vout — the REAL Bitcoin vout of a cxfer-family envelope's i-th
// confidential output. Identity for 0x22/0x23/0x26/0x3C; the INTERLEAVE {0->0,1->2} for the variable-amount
// atomic settlement 0x37/0x3D (vout 1 is the maker BTC payment). null = no canonical tacit vout (skip).
function canonicalOutputVout(opcode, i, n) {
  if (opcode === 0x22 || opcode === 0x23 || opcode === 0x26 || opcode === 0x3c) return i;
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
  if (burn) return { type: 'burn', assetId: burn.asset, nullifier: burn.nullifier, dest: burn.dest };
  const opcode = hexToBytes(envHex)[0];
  const cx = parseCxferEnvelopeFull(envHex);
  if (cx) {
    // Per-opcode REAL Bitcoin vouts (mirrors the guest cxfer fold + commitmentForUtxo) — NOT the output index;
    // AXFER_VAR (0x37/0x3D) interleaves, so the maker-change note keys at vout 2, not vout 1. A malformed layout
    // (any null) is skipped, matching the guest's skip-not-fold (keeps the witness/spent-set stream in sync).
    const vouts = cx.commitments.map((_, i) => canonicalOutputVout(opcode, i, cx.commitments.length));
    if (vouts.some((v) => v === null)) return null;
    return { type: 'cxfer', assetId: cx.asset, commitments: cx.commitments, kernelSig: cx.kernelSig, rangeProof: cx.rangeProof, vouts };
  }
  // A preauth-bid fill (0x5B/0x5C) folds via the SAME cxfer fold; its notes key at the bid's canonical vouts
  // (buyer filled @0, seller change @3 or @4-with-refund) — NOT a flat vout[1] offset.
  const bid = parsePreauthBidEnvelope(envHex);
  if (bid) {
    const hasRefund = preauthBidVarHasRefund(envHex);
    const vouts = bid.commitments.map((_, i) => canonicalBidOutputVout(opcode, i, bid.commitments.length, hasRefund));
    if (vouts.some((v) => v === null)) return null;
    return { type: 'cxfer', assetId: bid.asset, commitments: bid.commitments, kernelSig: bid.kernelSig, rangeProof: bid.rangeProof, vouts };
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
  // lp_add (0x2D) / lp_remove (0x2E): the opening blindings (share_r / r_recv_a/b) now ride the envelope
  // (option a), so the indexer can fold them — route to their fold env.
  const la = parseLpAddEnvelope(envHex);
  if (la) return la;
  const lr = parseLpRemoveEnvelope(envHex);
  if (lr) return lr;
  // cBTC lock (0x66): v_btc is the lock output's sats value, stamped from the tx (the guest reads it from
  // the tx the same way). A malformed lock output → fail-loud unsupported.
  const cb = parseCbtcLockEnvelope(envHex);
  if (cb) { const vBtc = txOutputValue(rawTxHex, cb.lockVout); return vBtc == null ? { type: 'unsupported', opcode: 0x66 } : { ...cb, vBtc }; }
  // cBTC redeem (0x67): the honest single-tx exit. v_btc + the kernel sig are on-chain in the envelope; the
  // assembler's fold_cbtc_redeem re-verifies the burn against the tx's cBTC vins. Decode == the fold env.
  const cr = parseCbtcRedeemEnvelope(envHex);
  if (cr) return cr;
  // T_CROSSOUT_MINT (0x65, Mode-B reverse): route it so the forward scan emits the witnesses the guest reads +
  // skips (fold_crossout is a no-op in a forward batch — crossout_set_root=0), instead of refusing the block.
  const co = parseCrossoutMintEnvelope(envHex);
  if (co) return co;
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

export { readVarint, extractInputs, extractTaprootEnvelope, parseCetch, parseCmint, parseBurnEnvelope, parseCxferEnvelopeFull, parsePreauthBidEnvelope, parseSwapBatchEnvelope, parseSwapVarEnvelope, parseSwapRouteEnvelope, parseHarvestEnvelope, parseProtocolFeeClaimEnvelope, parseFarmInitEnvelope, parseLpAddEnvelope, parseLpRemoveEnvelope, parseCbtcLockEnvelope, parseCbtcRedeemEnvelope, parseCrossoutMintEnvelope, txOutputValue, txOutputScript, classifyConfidentialTx };

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
  });
  const assembler = makeBurnDepositAssembler({ dsha256: dsha, cat, bytesToHex });

  return { mirror, assembler, parseEtchAnchor, computeTxidInternal: computeTxid };
}
