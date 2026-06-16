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
function makeComputeTxidBytes(dsha) {
  return function computeTxidBytes(tx) {
    const segwit = tx.length > 5 && tx[4] === 0x00 && tx[5] === 0x01;
    if (tx.length === 64 && !segwit) return null;
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
    return dsha(cat([version, tx.subarray(inputsStart, outputsEnd), locktime]));
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
  if (rpEnd + 64 > env.length) return null;
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
//   { asset, nullifier, dest } (all hex). Layout (env[0]=0x2B, >=129B):
//   opcode(1) ‖ assetId(32) ‖ bitcoinPoolRoot(32) ‖ nullifier(32) ‖ destCommitment(32).
function parseBurnEnvelope(envHex) {
  const env = hexToBytes(envHex);
  if (env.length < 129 || env[0] !== 0x2b) return null;
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

// classifyConfidentialTx(rawTxHex) → the reflection scan's per-tx classification, MIRRORING the guest's
// reflect.rs (extract_taproot_envelope → parse_burn_envelope / parse_cxfer_envelope_full): a confidential
// bridge-burn → {type:'burn', dest}; a confidential transfer → {type:'cxfer', assetId, commitments,
// kernelSig, rangeProof}; anything else (plain spend, non-confidential envelope) → null. This is the
// `classifyTx` buildScanReflectionAttester injects; the guest RE-parses from txData and is authoritative, so a
// misclassification is a liveness failure (the prove fails / skips), never a wrong attestation.
function classifyConfidentialTx(rawTxHex) {
  const envHex = extractTaprootEnvelope(rawTxHex);
  if (!envHex) return null;
  const burn = parseBurnEnvelope(envHex);
  if (burn) return { type: 'burn', dest: burn.dest };
  const cx = parseCxferEnvelopeFull(envHex);
  if (cx) return { type: 'cxfer', assetId: cx.asset, commitments: cx.commitments, kernelSig: cx.kernelSig, rangeProof: cx.rangeProof };
  // env[0] is the opcode (the TACIT frame is already stripped). cetch (0x21) / cmint (0x24) create a note
  // but the conservation-closed full scan does NOT fold them (no free-output deposit path), so the guest
  // treats them as plain too — safe. EVERY OTHER Tacit op (AMM lp/swap/route/batch/farm/protocol-fee,
  // cBTC lock, bid, crossout, AXFER) IS folded by the guest (reflect.rs reads its fold witnesses). The JS
  // scan does not yet mirror those folds, so it must SURFACE such a tx, not silently treat it as plain —
  // otherwise the guest reads fold witnesses this scan never emitted and the whole batch's stream desyncs
  // (a wrong / un-chainable digest). Fail-loud: the attester refuses the batch (liveness, not soundness —
  // the guest is authoritative). Mirroring a fold here is what lets the corresponding op attest.
  const opcode = hexToBytes(envHex)[0];
  if (opcode === 0x21 || opcode === 0x24) return null; // cetch / cmint — created-but-not-folded (plain)
  return { type: 'unsupported', opcode };
}

export { readVarint, extractInputs, extractTaprootEnvelope, parseCetch, parseCmint, parseBurnEnvelope, parseCxferEnvelopeFull, classifyConfidentialTx };

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
