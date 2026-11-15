// An interactive swap of a bridged token's Bitcoin note for sats, as ONE generation-bound Tacit transfer (T_CXFER_BOUND,
// 0x39). The reflection folds a plain transfer or sale (0x22/0x26) only for TAC, but folds 0x39 for any asset when the
// note's signature binds every output, the payload names this pool deployment and the kernel conserves (reflect.rs,
// mirrored by confidential-pool.js assembleReflectionScanInput). So a bridged token sold this way stays reflected, and
// the buyer's note can go back to Ethereum by the fast lane.
//
//   commit  the buyer funds it from a sats coin; output 0 is the Taproot output carrying the 0x39 envelope (signed by the
//           buyer's key), output 1 the buyer's change
//   reveal  vin[0] = commit:0 (the buyer, script path), vin[1] = the seller's note (the seller, a signature binding every
//           output: SIGHASH_ALL, ALL|ANYONECANPAY, or a 64-byte Taproot one)
//           vout[0] the buyer's note at P2TR(buyer), vout[1] the seller's change note at P2TR(seller) (both the payload's
//           outputs, in order), vout[2] the seller's sats payout
//
// The flow:
//   buyer   buyerNoteSecrets: the blinding (and amount ciphertext) of its note, sent to the seller with its x-only key
//   seller  sellerPayload: the payload (kernel over its note, range proof) and the payload outputs' scripts
//   buyer   buyerTxs: the signed commit and the unsigned reveal, with what the seller signs
//   seller  sellerSign (after sellerCheck): its note's witness
//   buyer   buyerFinish: checks the seller's signature, signs vin[0]; verifyBoundSwap before broadcasting
//
// The Bitcoin validator (tacit.js validateOutpoint) counts every vin[1..] of a 0x39 reveal as a note input of the kernel,
// so the reveal carries the seller's note and nothing else: the buyer pays through the commit, never a reveal input.
//
// Pure: no network, no storage, no page globals. `prims` is the wallet's primitives (bitcoin-taproot-wallet.js
// makeBtcWallet().prims; importing it configures the ECDSA nonce for P2WPKH signing), `kit` Tacit's channel functions
// (adaptor-btc-tx.js tacitKit(tacit)).

import { secp, sha256, ripemd160, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';
import { G, modN, pedersenCommit, pointToBytes, bigintToBytes32, signSchnorr, verifySchnorr, bpRangeVerify, bpClassicProofLen } from './bulletproofs.js';
import { bppRangeProve, bppRangeVerify, bytesToPoint } from './bulletproofs-plus.js';
import { encodeCxferBoundEnvelope, parseCxferBoundEnvelope, extractTaprootEnvelope, noteSpendsBindOutputs } from './burn-deposit-bitcoin.js';
import { txToJson, txFromJson } from './adaptor-btc-tx.js';

export const T_CXFER_BOUND = 0x39;
export const SELLER_INPUT = 1;
const SEQ = 0xfffffffd;
// The signatures that bind every output (cxfer-core bitcoin.rs sig_binds_all_outputs): SIGHASH_DEFAULT (Taproot only, a
// 64-byte signature), SIGHASH_ALL and ALL|ANYONECANPAY. NONE (0x02) and SINGLE (0x03), with or without ANYONECANPAY,
// leave outputs free and the reflection would not fold the swap.
export const BINDING_SIGHASHES = Object.freeze({ taproot: [0x00, 0x01, 0x81], p2wpkh: [0x01, 0x81] });

const fail = (msg) => { throw new Error('bound-swap: ' + msg); };
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const asBytes = (x) => (x instanceof Uint8Array ? x : hexToBytes(strip(x)));
const asBig = (x) => (typeof x === 'bigint' ? x : BigInt(x));
const bytes32 = (x, what) => { const b = asBytes(x); if (b.length !== 32) fail(`${what} must be 32 bytes`); return b; };
const priv32 = (k) => (k instanceof Uint8Array ? k : bigintToBytes32(asBig(k)));
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const reverse = (b) => Uint8Array.from(b).reverse();
const hash256 = (b) => sha256(sha256(b));
const hash160 = (b) => ripemd160(sha256(b));
const sameOutpoint = (a, b) => strip(a.txid) === strip(b.txid) && (a.vout >>> 0) === (b.vout >>> 0);

// Keys are 32-byte Uint8Arrays or bigints.
export const xonlyOf = (key) => G.multiply(modN(BigInt('0x' + bytesToHex(priv32(key))))).toRawBytes(true).slice(1);
export const p2trScriptOf = (xonly) => concatBytes(Uint8Array.of(0x51, 0x20), bytes32(xonly, 'x-only key'));
export const p2wpkhScriptOf = (pub33) => concatBytes(Uint8Array.of(0x00, 0x14), hash160(pub33));
const isP2tr = (s) => s.length === 34 && s[0] === 0x51 && s[1] === 0x20;
const isP2wpkh = (s) => s.length === 22 && s[0] === 0x00 && s[1] === 0x14;

// The self-channel anchor: the seller's note outpoint, the reveal's vin[1] (txid in internal byte order, vout LE).
export const noteAnchor = ({ txid, vout }) => concatBytes(reverse(hexToBytes(strip(txid))), u32le(vout >>> 0));

// tacit-kernel-v1, as tacit.js computeKernelMsg: sha256(domain ‖ asset ‖ n ‖ (txid ‖ vout)* ‖ m ‖ C* ‖ burned).
export function kernelMsg(assetId, inputs, commitments, burned = 0n) {
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), bytes32(assetId, 'asset id'), Uint8Array.of(inputs.length)];
  for (const i of inputs) parts.push(reverse(hexToBytes(strip(i.txid))), u32le(i.vout >>> 0));
  parts.push(Uint8Array.of(commitments.length));
  for (const c of commitments) parts.push(asBytes(c));
  parts.push(u64le(burned));
  return sha256(concatBytes(...parts));
}

// ---- transactions as bytes -------------------------------------------------------------------------------------------
function readTx(hex) {
  const b = asBytes(hex);
  let p = 0;
  const need = (n) => { if (p + n > b.length) fail('truncated transaction'); };
  const take = (n) => { need(n); const s = b.subarray(p, p + n); p += n; return s; };
  const u32 = () => { const s = take(4); return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] * 0x1000000)) >>> 0; };
  const varint = () => { const f = take(1)[0]; if (f < 0xfd) return f; if (f === 0xfd) { const s = take(2); return s[0] | (s[1] << 8); } if (f === 0xfe) return u32(); fail('oversized varint'); };
  const version = u32();
  const segwit = b[p] === 0x00 && b[p + 1] === 0x01;
  if (segwit) p += 2;
  const inputs = [];
  for (let i = 0, n = varint(); i < n; i++) {
    const txid = bytesToHex(reverse(take(32))), vout = u32();
    const scriptSig = take(varint());
    inputs.push({ txid, vout, scriptSig, sequence: u32(), witness: [] });
  }
  const outputs = [];
  for (let i = 0, n = varint(); i < n; i++) {
    const v = take(8); const value = Number(new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true));
    outputs.push({ value, script: Uint8Array.from(take(varint())) });
  }
  if (segwit) for (const inp of inputs) for (let k = 0, n = varint(); k < n; k++) inp.witness.push(Uint8Array.from(take(varint())));
  const locktime = u32();
  if (p !== b.length) fail('trailing bytes after the transaction');
  return { version, inputs, outputs, locktime };
}
const varintOf = (n) => (n < 0xfd ? Uint8Array.of(n) : concatBytes(Uint8Array.of(0xfd), Uint8Array.of(n & 0xff, n >> 8)));
function writeTx(tx, withWitness = true) {
  const parts = [];
  const vi = varintOf;
  const hasWit = withWitness && tx.inputs.some((i) => i.witness && i.witness.length);
  parts.push(u32le(tx.version));
  if (hasWit) parts.push(Uint8Array.of(0, 1));
  parts.push(vi(tx.inputs.length));
  for (const i of tx.inputs) { const ss = i.scriptSig || new Uint8Array(0); parts.push(reverse(hexToBytes(strip(i.txid))), u32le(i.vout), vi(ss.length), ss, u32le(i.sequence)); }
  parts.push(vi(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64le(o.value), vi(o.script.length), o.script);
  if (hasWit) for (const i of tx.inputs) { parts.push(vi(i.witness.length)); for (const w of i.witness) parts.push(vi(w.length), w); }
  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}
export const txidOf = (tx) => bytesToHex(reverse(hash256(writeTx(tx, false))));
export const parseTx = (hex) => { const tx = readTx(hex); return { ...tx, txid: txidOf(tx) }; };
const vsizeOf = (tx) => Math.ceil((writeTx(tx, false).length * 3 + writeTx(tx, true).length) / 4);
const asTx = (t) => (t.outputs.some((o) => typeof o.script === 'string') ? txFromJson(t) : t);   // a tx, or txToJson of one
const asPrevouts = (ps) => ps.map((p) => ({ value: p.value, script: asBytes(p.script) }));

// ---- P2WPKH (BIP-143) ------------------------------------------------------------------------------------------------
function bip143Sighash(tx, idx, prevout, hashType) {
  const acp = (hashType & 0x80) === 0x80, base = hashType & 0x1f;
  const zero = new Uint8Array(32);
  const hashPrevouts = acp ? zero : hash256(concatBytes(...tx.inputs.flatMap((i) => [reverse(hexToBytes(strip(i.txid))), u32le(i.vout)])));
  const hashSequence = (acp || base !== 0x01) ? zero : hash256(concatBytes(...tx.inputs.map((i) => u32le(i.sequence))));
  if (base !== 0x01) fail('only SIGHASH_ALL and ALL|ANYONECANPAY are built here');
  const hashOutputs = hash256(concatBytes(...tx.outputs.flatMap((o) => [u64le(o.value), varintOf(o.script.length), o.script])));
  const inp = tx.inputs[idx];
  const scriptCode = concatBytes(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), asBytes(prevout.script).subarray(2), Uint8Array.of(0x88, 0xac));
  return hash256(concatBytes(u32le(tx.version), hashPrevouts, hashSequence, reverse(hexToBytes(strip(inp.txid))), u32le(inp.vout), scriptCode, u64le(prevout.value), u32le(inp.sequence), hashOutputs, u32le(tx.locktime), u32le(hashType)));
}
function derOf(compact) {
  const trim = (x) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let t = x.slice(i); if (t[0] & 0x80) t = concatBytes(Uint8Array.of(0), t); return t; };
  const r = trim(compact.slice(0, 32)), s = trim(compact.slice(32, 64));
  return concatBytes(Uint8Array.of(0x30, 4 + r.length + s.length, 0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
}
function compactOfDer(der) {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[2] !== 0x02) return null;
  const rl = der[3], r = der.subarray(4, 4 + rl);
  if (der[4 + rl] !== 0x02) return null;
  const sl = der[5 + rl], s = der.subarray(6 + rl, 6 + rl + sl);
  if (6 + rl + sl !== der.length || rl > 33 || sl > 33) return null;
  const pad = (x) => { const t = x[0] === 0 ? x.subarray(1) : x; if (t.length > 32) return null; const o = new Uint8Array(32); o.set(t, 32 - t.length); return o; };
  const R = pad(r), S = pad(s);
  return R && S ? concatBytes(R, S) : null;
}

// The seller input's witness signs every output, and is a real signature of the seller note's key over this reveal
// (null), or why not.
function sellerWitnessCheck(prims, reveal, prevouts, witness) {
  const spk = prevouts[SELLER_INPUT].script;
  const sig = witness[0];
  if (!sig) return 'the seller input is unsigned';
  if (isP2tr(spk)) {
    if (witness.length !== 1 || (sig.length !== 64 && sig.length !== 65)) return 'the seller note is not spent by its Taproot key';
    const ht = sig.length === 64 ? 0x00 : sig[64];
    if (!BINDING_SIGHASHES.taproot.includes(ht)) return `the seller's sighash 0x${ht.toString(16)} leaves outputs free`;
    if (sig.length === 65 && ht === 0x00) return 'a 65-byte Taproot signature cannot carry SIGHASH_DEFAULT';
    const sh = prims.tapSighashKeyPath(reveal, SELLER_INPUT, prevouts, ht);
    return verifySchnorr(sig.subarray(0, 64), sh, spk.subarray(2)) ? null : 'the seller signature does not verify';
  }
  if (isP2wpkh(spk)) {
    if (witness.length !== 2 || witness[1].length !== 33) return 'the seller note is not spent by its P2WPKH key';
    const ht = sig[sig.length - 1];
    if (!BINDING_SIGHASHES.p2wpkh.includes(ht)) return `the seller's sighash 0x${ht.toString(16)} leaves outputs free`;
    if (!eqBytes(p2wpkhScriptOf(witness[1]), spk)) return 'the seller key is not the note\'s';
    const compact = compactOfDer(sig.subarray(0, sig.length - 1));
    if (!compact) return 'the seller signature is not strict DER';
    let okSig = false;
    try { okSig = secp.verify(compact, bip143Sighash(reveal, SELLER_INPUT, prevouts[SELLER_INPUT], ht), witness[1]); } catch { okSig = false; }
    return okSig ? null : 'the seller signature does not verify';
  }
  return 'the seller note is neither P2TR nor P2WPKH';
}

// ---- buyer: the note's secrets -----------------------------------------------------------------------------------------
// The buyer's note uses the buyer's own change channel, anchored at the seller's note outpoint (the reveal's vin[1]) at
// vout 0: blinding = deriveChangeBlinding(buyerKey, anchor, 0), amount ciphertext = encryptAmount(amount,
// deriveAmountKeystreamSelf(buyerKey, anchor, 0)). That is exactly what tacit.js openTransferOutput tries on its 'self'
// path (btc-bind.js openBoundNote anchors at vin[1]), so the buyer's key alone finds and opens the note again. The buyer
// sends { buyerXonly, buyerBlinding, buyerAmountCt } to the seller; the blinding is no secret from the seller, who needs
// it to build the kernel, and the note is spendable only by the buyer's key (P2TR(buyerXonly)).
export function buyerNoteSecrets({ kit, buyerKey, sellerNoteOutpoint, amount }) {
  const anchor = noteAnchor(sellerNoteOutpoint);
  const k = priv32(buyerKey);
  return {
    buyerXonly: xonlyOf(k),
    buyerBlinding: kit.deriveChangeBlinding(k, anchor, 0),
    buyerAmountCt: kit.encryptAmount(asBig(amount), kit.deriveAmountKeystreamSelf(k, anchor, 0)),
  };
}

// ---- seller: the payload -----------------------------------------------------------------------------------------------
// sellerNote: { txid, vout, amount, blinding, cx?, cy? } (cx/cy: its commitment, checked against amount/blinding).
// The seller's change note (amount − toBuyer, possibly zero: the payload needs 2, 4 or 8 outputs) uses the seller's own
// change channel at vout 1 and sits at P2TR(the seller's x-only key), untweaked, as btc-bind's bound notes do.
export function sellerPayload({ prims, kit, assetId, sellerNote, toBuyer, buyerXonly, buyerBlinding, buyerAmountCt = null, chainBinding, sellerKey = prims.wallet.priv, rangeProve = bppRangeProve, changeScript = null }) {
  const asset = bytes32(assetId, 'asset id');
  const target = bytes32(chainBinding, 'chain binding');
  const amount = asBig(sellerNote.amount), give = asBig(toBuyer);
  if (give <= 0n || give > amount) fail('the buyer\'s part must be positive and within the seller\'s note');
  const rIn = modN(asBig(sellerNote.blinding));
  if (sellerNote.cx != null && sellerNote.cy != null) {
    const A = pedersenCommit(amount, rIn).toAffine();
    if (A.x !== asBig(sellerNote.cx) || A.y !== asBig(sellerNote.cy)) fail('the seller note\'s amount and blinding do not open its commitment');
  }
  const k = priv32(sellerKey);
  const anchor = noteAnchor(sellerNote);
  const change = amount - give;
  const outs = [
    { vout: 0, amount: give, blinding: modN(asBig(buyerBlinding)), script: p2trScriptOf(buyerXonly), ct: buyerAmountCt ? asBytes(buyerAmountCt) : new Uint8Array(8) },
    { vout: 1, amount: change, blinding: kit.deriveChangeBlinding(k, anchor, 1), script: changeScript ? asBytes(changeScript) : p2trScriptOf(xonlyOf(k)), ct: kit.encryptAmount(change, kit.deriveAmountKeystreamSelf(k, anchor, 1)) },
  ];
  if (outs[0].ct.length !== 8) fail('the buyer\'s amount ciphertext must be 8 bytes');
  const { proof, commitments } = rangeProve(outs.map((o) => o.amount), outs.map((o) => o.blinding));
  const Cs = commitments.map((c) => (c instanceof Uint8Array ? c : pointToBytes(c)));
  const excess = modN(outs.reduce((s, o) => s + o.blinding, 0n) - rIn);
  if (excess === 0n) fail('the kernel excess is zero');
  const kernelSig = signSchnorr(kernelMsg(asset, [sellerNote], Cs), bigintToBytes32(excess));
  const payload = hexToBytes(strip(encodeCxferBoundEnvelope({ target, asset, kernelSig, rangeProof: proof, outputs: outs.map((o, i) => ({ commitment: Cs[i], amountCt: o.ct })) })));
  return {
    payload, kernelSig,
    noteScripts: outs.map((o) => o.script),
    buyerNote: { vout: 0, amount: give, commitment: Cs[0], script: outs[0].script },
    change: { vout: 1, amount: change, blinding: outs[1].blinding, commitment: Cs[1], script: outs[1].script },
  };
}

// The reveal's outputs: each payload note at dust, then the seller's payout. One place for both sides: the seller signs these
// (ALL|ANYONECANPAY) before the buyer has built the reveal.
export const revealOutputs = ({ prims, noteScripts, sellerPayoutScript, priceSats }) =>
  [...noteScripts.map((s) => ({ value: prims.DUST, script: asBytes(s) })), { value: priceSats, script: asBytes(sellerPayoutScript) }];

// ---- buyer: commit and reveal --------------------------------------------------------------------------------------------
// fundingUtxo / sellerNote: { txid, vout, value (sats), script }. The funding coin is the buyer key's P2TR or P2WPKH.
// noteScripts: the payload outputs' scripts (sellerPayload), the first the buyer's own P2TR.
// With buyerKey null (and buyerXonly, plus buyerPub for a P2WPKH funding coin) the pair is built unsigned: the commit's txid does not
// depend on its witness, so the seller of a pinned offer builds the very commit and reveal the buyer will sign.
export function buyerTxs({ prims, payload, noteScripts, buyerKey = prims.wallet.priv, buyerXonly = null, buyerPub: buyerPubIn = null, fundingUtxo, sellerNote, sellerPayoutScript, priceSats, feeRate, changeScript = null }) {
  const { DUST } = prims;
  const pl = asBytes(payload);
  if (pl[0] !== T_CXFER_BOUND) fail('a bridged token is swapped by a generation-bound transfer (0x39) only');
  const dec = parseCxferBoundEnvelope(bytesToHex(pl));
  if (!dec) fail('the payload does not parse');
  const n = dec.commitments.length;
  const scripts = noteScripts.map(asBytes);
  if (scripts.length !== n) fail(`the payload has ${n} outputs, ${scripts.length} scripts were given`);
  const k = buyerKey == null ? null : priv32(buyerKey), bx = k ? xonlyOf(k) : bytes32(buyerXonly, 'buyer x-only key');
  if (!eqBytes(scripts[0], p2trScriptOf(bx))) fail('the payload\'s first output is not at the buyer key\'s Taproot address');
  if (!Number.isInteger(priceSats) || priceSats < DUST) fail('the price must be a whole number of sats, at least dust');
  const note = { txid: sellerNote.txid, vout: sellerNote.vout, value: sellerNote.value, script: asBytes(sellerNote.script) };
  if (!isP2tr(note.script) && !isP2wpkh(note.script)) fail('the seller note must sit at a P2TR or P2WPKH script');
  const fund = { txid: fundingUtxo.txid, vout: fundingUtxo.vout, value: fundingUtxo.value, script: asBytes(fundingUtxo.script) };
  const buyerPub = k ? secp.getPublicKey(k, true) : buyerPubIn ? asBytes(buyerPubIn) : null;
  if (buyerPub && !eqBytes(buyerPub.slice(1), bx)) fail('the buyer key and its x-only half differ');
  const fundTaproot = eqBytes(fund.script, p2trScriptOf(bx));
  if (!fundTaproot && !(buyerPub && eqBytes(fund.script, p2wpkhScriptOf(buyerPub)))) fail('the funding coin is not the buyer key\'s P2TR or P2WPKH');

  const envelopeScript = prims.encodeEnvelopeScript(bx, pl);
  const leafHash = prims.tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = prims.tweakedOutputKey(prims.TAP_NUMS, leafHash);
  const commitSpk = prims.p2trScript(Q_xonly);
  const controlBlock = prims.controlBlock(prims.TAP_NUMS, parity);

  const outputs = revealOutputs({ prims, noteScripts: scripts, sellerPayoutScript, priceSats });
  const revealOf = (commitTxid) => ({
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: SEQ, witness: [] }, { txid: note.txid, vout: note.vout, sequence: SEQ, witness: [] }],
    outputs: outputs.map((o) => ({ ...o })),
  });
  const sized = revealOf('00'.repeat(32));
  sized.inputs[0].witness = [new Uint8Array(64), envelopeScript, controlBlock];
  sized.inputs[1].witness = isP2tr(note.script) ? [new Uint8Array(65)] : [new Uint8Array(73), new Uint8Array(33)];
  const revealFee = prims.feeFor(vsizeOf(sized), feeRate);
  const commitValue = outputs.reduce((s, o) => s + o.value, 0) + revealFee - note.value;
  if (commitValue < DUST) fail('the commit output would be below dust');

  const change = changeScript ? asBytes(changeScript) : fund.script;
  const commitOf = (changeValue) => ({
    version: 2, locktime: 0,
    inputs: [{ txid: fund.txid, vout: fund.vout, sequence: SEQ, witness: fundTaproot ? [new Uint8Array(64)] : [new Uint8Array(72), new Uint8Array(33)] }],
    outputs: [{ value: commitValue, script: commitSpk }, ...(changeValue >= DUST ? [{ value: changeValue, script: change }] : [])],
  });
  const commitFee = prims.feeFor(vsizeOf(commitOf(DUST)), feeRate);
  const changeValue = fund.value - commitValue - commitFee;
  if (changeValue < 0) fail(`the funding coin is too small (need ${commitValue + commitFee} sats, it holds ${fund.value})`);
  const commitTx = commitOf(changeValue);
  if (!k) { /* unsigned: the witness placeholders stand (the txid is the same) */ } else if (fundTaproot) {
    commitTx.inputs[0].witness = [signSchnorr(prims.tapSighashKeyPath(commitTx, 0, [fund], 0x00), k)];
  } else {
    const sh = bip143Sighash(commitTx, 0, fund, 0x01);
    commitTx.inputs[0].witness = [concatBytes(derOf(secp.sign(sh, k, { lowS: true }).toCompactRawBytes()), Uint8Array.of(0x01)), buyerPub];
  }
  const commitTxid = txidOf(commitTx);
  const reveal = revealOf(commitTxid);
  const prevouts = [{ value: commitValue, script: commitSpk }, { value: note.value, script: note.script }];
  return {
    commitTx, commitTxid, commitHex: bytesToHex(writeTx(commitTx)), commitFee,
    reveal, revealTxid: txidOf(reveal), revealFee, prevouts,
    envelopeScript, leafHash, controlBlock, buyerXonly: bx,
    // What the seller signs: this reveal's vin[1] over these prevouts (a witness is not part of the txid, so it is final).
    toSign: { reveal: txToJson(reveal), prevouts: prevouts.map((p) => ({ value: p.value, script: bytesToHex(p.script) })), inputIndex: SELLER_INPUT, commitHex: bytesToHex(writeTx(commitTx)) },
  };
}

// ---- seller: check, then sign -----------------------------------------------------------------------------------------------
// What a seller confirms before signing: the reveal spends its note as vin[1] with nothing after it, its payload outputs
// sit at the scripts it built, the payout pays it at least the price, and (given the payload and the buyer's x-only
// key) vin[0] is the commit output carrying ITS payload.
export function sellerCheck({ prims = null, reveal, prevouts, sellerNote, noteScripts, payoutScript, priceSats, payload = null, buyerXonly = null }) {
  const tx = asTx(reveal), ps = asPrevouts(prevouts), reasons = [];
  if (tx.inputs.length !== 2 || ps.length !== 2) reasons.push('extra-inputs');
  if (!tx.inputs[SELLER_INPUT] || !sameOutpoint(tx.inputs[SELLER_INPUT], sellerNote)) reasons.push('not-the-seller-note');
  const scripts = noteScripts.map(asBytes), n = scripts.length;
  if (tx.outputs.length !== n + 1) reasons.push('output-count');
  scripts.forEach((s, i) => { if (!tx.outputs[i] || !eqBytes(tx.outputs[i].script, s)) reasons.push(`note-script-${i}`); });
  const pay = tx.outputs[n];
  if (!pay || !eqBytes(pay.script, asBytes(payoutScript))) reasons.push('payout-script');
  else if (pay.value < priceSats) reasons.push('payout-value');
  if (prims && payload && buyerXonly) {
    const leaf = prims.tapLeafHash(prims.encodeEnvelopeScript(bytes32(buyerXonly, 'buyer x-only key'), asBytes(payload)));
    if (!ps[0] || !eqBytes(ps[0].script, prims.p2trScript(prims.tweakedOutputKey(prims.TAP_NUMS, leaf).Q_xonly))) reasons.push('commit-envelope-mismatch');
  }
  return { ok: reasons.length === 0, reasons };
}

// kind 'taproot': the note at P2TR(the seller key's x-only), untweaked (a cross-out mint's or a bound note's address),
// signed by key path. kind 'p2wpkh': the note at P2WPKH(the seller key). `expect` (sellerCheck's arguments less the
// reveal and prevouts) refuses to sign a reveal that does not pay.
export function sellerSign({ prims, reveal, prevouts, sellerKey = prims.wallet.priv, kind, sighash = 0x01, expect = null }) {
  if (!BINDING_SIGHASHES[kind]) fail(`unknown note kind ${kind}`);
  if (!BINDING_SIGHASHES[kind].includes(sighash)) fail(`sighash 0x${sighash.toString(16)} leaves outputs free: the reflection folds a bound transfer only when the note's signature binds every output`);
  const tx = asTx(reveal), ps = asPrevouts(prevouts);
  if (expect) { const c = sellerCheck({ prims, reveal: tx, prevouts: ps, ...expect }); if (!c.ok) fail(`refusing to sign: ${c.reasons.join(', ')}`); }
  const k = priv32(sellerKey), spk = ps[SELLER_INPUT].script;
  if (kind === 'taproot') {
    if (!eqBytes(spk, p2trScriptOf(xonlyOf(k)))) fail('the seller note is not at this key\'s Taproot address');
    const sig = signSchnorr(prims.tapSighashKeyPath(tx, SELLER_INPUT, ps, sighash), k);
    return { witness: [sighash === 0x00 ? sig : concatBytes(sig, Uint8Array.of(sighash))], sighash };
  }
  const pub = secp.getPublicKey(k, true);
  if (!eqBytes(spk, p2wpkhScriptOf(pub))) fail('the seller note is not at this key\'s P2WPKH address');
  const sh = bip143Sighash(tx, SELLER_INPUT, ps[SELLER_INPUT], sighash);
  return { witness: [concatBytes(derOf(secp.sign(sh, k, { lowS: true }).toCompactRawBytes()), Uint8Array.of(sighash)), pub], sighash };
}

// ---- buyer: finish -------------------------------------------------------------------------------------------------------------
// swap: buyerTxs's result. The seller's witness must bind every output and verify over this reveal; vin[0] is then
// signed by script path under the buyer's key (the envelope's signer).
export function buyerFinish({ prims, swap, sellerWitness, buyerKey = prims.wallet.priv }) {
  const reveal = txFromJson(txToJson(swap.reveal));
  const ps = asPrevouts(swap.prevouts);
  const witness = sellerWitness.map(asBytes);
  const bad = sellerWitnessCheck(prims, reveal, ps, witness);
  if (bad) fail(bad);
  reveal.inputs[SELLER_INPUT].witness = witness;
  const k = priv32(buyerKey);
  if (!eqBytes(xonlyOf(k), swap.buyerXonly)) fail('this is not the key that signs the envelope');
  reveal.inputs[0].witness = [signSchnorr(prims.tapSighash(reveal, 0, ps, swap.leafHash, 0x00), k), swap.envelopeScript, swap.controlBlock];
  return { revealTx: reveal, revealTxid: txidOf(reveal), revealHex: bytesToHex(writeTx(reveal)), commitHex: swap.commitHex, commitTxid: swap.commitTxid };
}

// ---- anyone: verify before broadcasting ---------------------------------------------------------------------------------------
// The buyer's (or a watchtower's) checks of the final pair. expected: { assetId, amountToBuyer, buyerXonly, buyerBlinding,
// sellerPayoutScript, priceSats, chainBinding, sellerNoteOutpoint: { txid, vout }, sellerNoteCommitment (33-byte
// compressed, or { cx, cy }) }. Returns { ok, reasons }: every failed check, by name.
export function verifyBoundSwap({ revealHex, commitHex, expected, prims = null }) {
  const reasons = [];
  let reveal, commit;
  try { reveal = parseTx(revealHex); } catch { return { ok: false, reasons: ['reveal-unparseable'] }; }
  try { commit = parseTx(commitHex); } catch { return { ok: false, reasons: ['commit-unparseable'] }; }
  let env = null;
  try { env = extractTaprootEnvelope('0x' + strip(bytesToHex(asBytes(revealHex)))); } catch { env = null; }
  const dec = env ? parseCxferBoundEnvelope(env) : null;
  if (!dec) return { ok: false, reasons: ['not-a-bound-transfer'] };

  if (strip(dec.target) !== strip(expected.chainBinding)) reasons.push('wrong-chain-binding');
  if (strip(dec.asset) !== strip(expected.assetId)) reasons.push('wrong-asset');

  const sellerOut = expected.sellerNoteOutpoint;
  if (reveal.inputs.length !== 2) reasons.push('extra-inputs');
  if (!reveal.inputs[SELLER_INPUT] || !sameOutpoint(reveal.inputs[SELLER_INPUT], sellerOut)) reasons.push('not-the-seller-note');
  if (!sameOutpoint(reveal.inputs[0], { txid: commit.txid, vout: 0 }) || !commit.outputs[0] || !isP2tr(commit.outputs[0].script)) reasons.push('commit-not-spent');
  if (reveal.inputs[0].witness.length !== 3 || !(reveal.inputs[SELLER_INPUT] && reveal.inputs[SELLER_INPUT].witness.length)) reasons.push('unsigned');
  if (!reveal.outputs.length) return { ok: false, reasons: [...reasons, 'output-count'] };

  const Cs = dec.commitments;
  const n = Cs.length;
  if (reveal.outputs.length !== n + 1) reasons.push('output-count');
  let opens = false;
  try { opens = eqBytes(pointToBytes(pedersenCommit(asBig(expected.amountToBuyer), asBig(expected.buyerBlinding))), asBytes(Cs[0])); } catch { opens = false; }
  if (!opens) reasons.push('buyer-note-opening');
  if (!eqBytes(reveal.outputs[0].script, p2trScriptOf(expected.buyerXonly))) reasons.push('buyer-note-script');
  const pay = reveal.outputs[n];
  if (!pay || !eqBytes(pay.script, asBytes(expected.sellerPayoutScript))) reasons.push('payout-script');
  if (!pay || pay.value < expected.priceSats) reasons.push('payout-value');

  let kernelOk = false;
  try {
    const c = expected.sellerNoteCommitment;
    const Cin = c && c.cx != null ? secp.ProjectivePoint.fromAffine({ x: asBig(c.cx), y: asBig(c.cy) }) : secp.ProjectivePoint.fromHex(strip(bytesToHex(asBytes(c))));
    let E = secp.ProjectivePoint.ZERO;
    for (const x of Cs) E = E.add(secp.ProjectivePoint.fromHex(strip(x)));
    E = E.add(Cin.negate());
    kernelOk = !E.equals(secp.ProjectivePoint.ZERO)
      && verifySchnorr(asBytes(dec.kernelSig), kernelMsg(dec.asset, [sellerOut], Cs), E.toRawBytes(true).slice(1));
  } catch { kernelOk = false; }
  if (!kernelOk) reasons.push('kernel');

  let rangeOk = false;
  try {
    const rp = asBytes(dec.rangeProof);
    rangeOk = rp.length === bpClassicProofLen(n) ? bpRangeVerify(Cs, rp) : bppRangeVerify(Cs.map((c) => bytesToPoint(asBytes(c))), rp);
  } catch { rangeOk = false; }
  if (!rangeOk) reasons.push('range-proof');

  const internal = bytesToHex(reverse(hexToBytes(strip(sellerOut.txid))));
  if (!noteSpendsBindOutputs('0x' + strip(bytesToHex(asBytes(revealHex))), [[internal, sellerOut.vout >>> 0]])) reasons.push('unbound-seller-signature');
  // Given the wallet primitives: the commit output is the Taproot output of the envelope vin[0] reveals (NUMS internal key, as
  // buyerTxs builds it), and, given the seller note's value and script, the seller's witness is a real signature of its key over
  // THIS reveal, binding every output.
  if (prims) {
    const w0 = reveal.inputs[0] ? reveal.inputs[0].witness : [];
    let tweakOk = false;
    try { tweakOk = w0.length === 3 && !!commit.outputs[0] && eqBytes(commit.outputs[0].script, prims.p2trScript(prims.tweakedOutputKey(prims.TAP_NUMS, prims.tapLeafHash(w0[1])).Q_xonly)); } catch { tweakOk = false; }
    if (!tweakOk) reasons.push('commit-tweak');
    if (expected.sellerNote && reveal.inputs[SELLER_INPUT] && commit.outputs[0]) {
      let bad = 'unchecked';
      try { bad = sellerWitnessCheck(prims, reveal, [{ value: commit.outputs[0].value, script: commit.outputs[0].script }, { value: expected.sellerNote.value, script: asBytes(expected.sellerNote.script) }], reveal.inputs[SELLER_INPUT].witness); } catch (e) { bad = String(e.message || e); }
      if (bad) reasons.push('seller-signature');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ---- one round: the seller's offer, the buyer's (watchtower's) take ---------------------------------------------------------
// The buyer's note, derived by BOTH sides from one ECDH (the seller's key × the buyer's x-only key = the buyer's key × the
// seller's x-only key, x-coordinate only, so either key's parity gives the same secret), anchored at the seller's note outpoint
// at vout 0: tacit.js's CXFER recipient blinding (deriveBlinding) and amount keystream (deriveAmountKeystreamECDH). The seller
// builds its payload with it and goes offline; the buyer recomputes it from the seller's x-only key to check the note opens.
export function buyerNoteEcdh({ kit, myKey, theirXonly, sellerNoteOutpoint, amount }) {
  if (!kit.deriveBlinding || !kit.deriveAmountKeystreamECDH) fail('the kit has no ECDH channel (tacitKit gives it)');
  const anchor = noteAnchor(sellerNoteOutpoint), pub = concatBytes(Uint8Array.of(0x02), bytes32(theirXonly, 'their x-only key')), k = priv32(myKey);
  return { blinding: kit.deriveBlinding(k, pub, anchor, 0), amountCt: kit.encryptAmount(asBig(amount), kit.deriveAmountKeystreamECDH(k, pub, anchor, 0)) };
}

const hexOf = (b) => bytesToHex(asBytes(b));
// The seller's offer: its WHOLE note to the buyer (a part would leave the seller's change in the same transfer, where a buyer who
// re-wrapped the payload in an envelope the reflection skips could strand it; a whole note leaves the seller only the payout,
// which its signature fixes), the payload, and its note's signature, ALL|ANYONECANPAY over the reveal's outputs: the signature
// does not cover the other input, so the buyer can build the commit afterwards and the seller need not be online again.
// sellerNote: { txid, vout, value (sats), script, amount, blinding, cx?, cy? } (a live, UNBOUND note: the buyer checks it).
export function sellerOffer({ prims, kit, assetId, sellerNote, buyerXonly, chainBinding, sellerPayoutScript, priceSats, sellerKey = prims.wallet.priv, rangeProve = bppRangeProve }) {
  const k = priv32(sellerKey), pub = secp.getPublicKey(k, true);
  const note = { txid: strip(sellerNote.txid), vout: sellerNote.vout >>> 0, value: sellerNote.value, script: asBytes(sellerNote.script) };
  const kind = isP2tr(note.script) ? 'taproot' : isP2wpkh(note.script) ? 'p2wpkh' : fail('the seller note must sit at a P2TR or P2WPKH script');
  if (!Number.isInteger(note.value) || note.value < 1) fail('the seller note\'s sats value is needed for its signature');
  if (!Number.isInteger(priceSats) || priceSats < prims.DUST) fail('the price must be a whole number of sats, at least dust');
  const amount = asBig(sellerNote.amount);
  const { blinding, amountCt } = buyerNoteEcdh({ kit, myKey: k, theirXonly: buyerXonly, sellerNoteOutpoint: note, amount });
  const pl = sellerPayload({ prims, kit, assetId, chainBinding, sellerKey: k, rangeProve, toBuyer: amount, buyerXonly, buyerBlinding: blinding, buyerAmountCt: amountCt,
    sellerNote: { txid: note.txid, vout: note.vout, amount, blinding: sellerNote.blinding, cx: sellerNote.cx, cy: sellerNote.cy } });
  const outputs = revealOutputs({ prims, noteScripts: pl.noteScripts, sellerPayoutScript, priceSats });
  const template = { version: 2, locktime: 0, outputs,
    inputs: [{ txid: '00'.repeat(32), vout: 0, sequence: SEQ, witness: [] }, { txid: note.txid, vout: note.vout, sequence: SEQ, witness: [] }] };
  const { witness } = sellerSign({ prims, kit, reveal: template, prevouts: [{ value: 0, script: new Uint8Array(34) }, note], sellerKey: k, kind, sighash: 0x81 });
  return {
    v: 1, kind, assetId: strip(hexOf(assetId)), chainBinding: strip(hexOf(chainBinding)), amount: amount.toString(), priceSats,
    sellerPub: bytesToHex(pub), sellerXonly: bytesToHex(pub.slice(1)), buyerXonly: strip(hexOf(buyerXonly)),
    note: { txid: note.txid, vout: note.vout, value: note.value, script: bytesToHex(note.script) },
    payload: bytesToHex(pl.payload), noteScripts: pl.noteScripts.map(bytesToHex), payoutScript: strip(hexOf(sellerPayoutScript)),
    witness: witness.map(bytesToHex),
  };
}

// The seller's PINNED offer (v2): any part of its note. The seller builds the exact pair the buyer will sign (the commit from one of
// the bid wallet's coins at a fee rate it names, the reveal spending that commit and its note) and signs its note SIGHASH_ALL, which
// covers the commit's outpoint and so the envelope the payload rides in: no one can re-wrap the payload in an envelope the
// reflection skips, so the seller's change (at its own P2WPKH address, a note its wallet reads and can sell again) is never stranded.
// Still one round: the seller posts and can go offline. The price of the pin: the offer names one coin of the bid wallet, and goes
// stale if that coin is spent first (another fill); the seller posts again.
// buyerPub: the bid's 33-byte key (its P2WPKH holds the coin); fund: { txid, vout, value, script } of that coin.
export function sellerPinnedOffer({ prims, kit, assetId, sellerNote, toBuyer, buyerPub, fund, feeRate, chainBinding, sellerPayoutScript, priceSats, sellerKey = prims.wallet.priv, rangeProve = bppRangeProve }) {
  const k = priv32(sellerKey), pub = secp.getPublicKey(k, true);
  const note = { txid: strip(sellerNote.txid), vout: sellerNote.vout >>> 0, value: sellerNote.value, script: asBytes(sellerNote.script) };
  const kind = isP2tr(note.script) ? 'taproot' : isP2wpkh(note.script) ? 'p2wpkh' : fail('the seller note must sit at a P2TR or P2WPKH script');
  if (!Number.isInteger(note.value) || note.value < 1) fail('the seller note\'s sats value is needed for its signature');
  if (!Number.isInteger(priceSats) || priceSats < prims.DUST) fail('the price must be a whole number of sats, at least dust');
  if (!(Number(feeRate) > 0)) fail('a pinned offer names its fee rate');
  const bpub = asBytes(buyerPub);
  if (bpub.length !== 33) fail('the bid\'s 33-byte key is needed (its P2WPKH holds the coin)');
  const buyerXonly = bpub.slice(1), give = asBig(toBuyer), amount = asBig(sellerNote.amount);
  if (give <= 0n || give > amount) fail('the part sold must be positive and within the note');
  const { blinding, amountCt } = buyerNoteEcdh({ kit, myKey: k, theirXonly: buyerXonly, sellerNoteOutpoint: note, amount: give });
  const pl = sellerPayload({ prims, kit, assetId, chainBinding, sellerKey: k, rangeProve, toBuyer: give, buyerXonly, buyerBlinding: blinding, buyerAmountCt: amountCt,
    changeScript: p2wpkhScriptOf(pub), sellerNote: { txid: note.txid, vout: note.vout, amount, blinding: sellerNote.blinding, cx: sellerNote.cx, cy: sellerNote.cy } });
  const f = { txid: strip(fund.txid), vout: fund.vout >>> 0, value: fund.value, script: asBytes(fund.script) };
  const swap = buyerTxs({ prims, payload: pl.payload, noteScripts: pl.noteScripts, buyerKey: null, buyerXonly, buyerPub: bpub, fundingUtxo: f, sellerNote: note,
    sellerPayoutScript, priceSats, feeRate: Number(feeRate) });
  const { witness } = sellerSign({ prims, reveal: swap.reveal, prevouts: swap.prevouts, sellerKey: k, kind, sighash: 0x01 });
  return {
    v: 2, kind, assetId: strip(hexOf(assetId)), chainBinding: strip(hexOf(chainBinding)), amount: give.toString(), priceSats,
    sellerPub: bytesToHex(pub), sellerXonly: bytesToHex(pub.slice(1)), buyerXonly: bytesToHex(buyerXonly), buyerPub: bytesToHex(bpub),
    note: { txid: note.txid, vout: note.vout, value: note.value, script: bytesToHex(note.script) },
    payload: bytesToHex(pl.payload), noteScripts: pl.noteScripts.map(bytesToHex), payoutScript: strip(hexOf(sellerPayoutScript)),
    witness: witness.map(bytesToHex),
    fund: { txid: f.txid, vout: f.vout, value: f.value, script: bytesToHex(f.script) }, feeRate: Number(feeRate), commitTxid: swap.commitTxid, revealTxid: swap.revealTxid,
    change: { amount: pl.change.amount.toString() },
  };
}

// The buyer's (watchtower's) check of an offer before it spends anything: the payload is a 0x39 transfer of this asset naming
// this deployment, its two notes are the buyer's (opening, with the ECDH blinding, to the offer's whole amount, at P2TR(buyer))
// and a zero change at the seller's Taproot address, the kernel conserves against the seller note's on-chain commitment, the
// range proof holds, the seller note sits at the offer's key, and the payout is at least dust. expected: { assetId,
// chainBinding, sellerNoteCommitment (33-byte compressed, or { cx, cy }) }.
export function buyerCheckOffer({ kit, offer, buyerKey, expected }) {
  const reasons = [];
  const k = priv32(buyerKey), bx = xonlyOf(k);
  let dec = null;
  try { dec = parseCxferBoundEnvelope(bytesToHex(asBytes(offer.payload))); } catch { dec = null; }
  if (!dec || asBytes(offer.payload)[0] !== T_CXFER_BOUND) return { ok: false, reasons: ['not-a-bound-transfer'] };
  if (strip(dec.target) !== strip(hexOf(expected.chainBinding)) || strip(offer.chainBinding) !== strip(hexOf(expected.chainBinding))) reasons.push('wrong-chain-binding');
  if (strip(dec.asset) !== strip(hexOf(expected.assetId)) || strip(offer.assetId) !== strip(hexOf(expected.assetId))) reasons.push('wrong-asset');
  const Cs = dec.commitments, scripts = (offer.noteScripts || []).map(asBytes);
  if (Cs.length !== 2 || scripts.length !== 2) reasons.push('output-count');
  if (!scripts[0] || !eqBytes(scripts[0], p2trScriptOf(bx))) reasons.push('buyer-note-script');
  const sellerPub = asBytes(offer.sellerPub || '');
  if (sellerPub.length !== 33 || strip(offer.sellerXonly) !== bytesToHex(sellerPub.slice(1))) reasons.push('seller-key');
  if (!scripts[1] || !(eqBytes(scripts[1], p2trScriptOf(sellerPub.slice(1))) || (offer.v === 2 && sellerPub.length === 33 && eqBytes(scripts[1], p2wpkhScriptOf(sellerPub))))) reasons.push('change-script');
  const ns = asBytes(offer.note.script);
  if (!(isP2tr(ns) && eqBytes(ns, p2trScriptOf(sellerPub.slice(1)))) && !(isP2wpkh(ns) && eqBytes(ns, p2wpkhScriptOf(sellerPub)))) reasons.push('seller-note-script');
  let amount = 0n;
  try { amount = asBig(offer.amount); } catch { amount = 0n; }
  if (amount <= 0n) reasons.push('amount');
  let buyerBlinding = null;
  try {
    buyerBlinding = buyerNoteEcdh({ kit, myKey: k, theirXonly: sellerPub.slice(1), sellerNoteOutpoint: offer.note, amount }).blinding;
    if (!eqBytes(pointToBytes(pedersenCommit(amount, buyerBlinding)), asBytes(Cs[0]))) reasons.push('buyer-note-opening');
    // a zero change: the second note commits to 0 (the seller keeps its blinding, so the buyer checks it through the kernel: C1 = C_in − C0 + excess·G)
  } catch { reasons.push('buyer-note-opening'); }
  if (!(Number.isInteger(offer.priceSats) && offer.priceSats > 0)) reasons.push('price');
  try {
    const c = expected.sellerNoteCommitment;
    const Cin = c && c.cx != null ? secp.ProjectivePoint.fromAffine({ x: asBig(c.cx), y: asBig(c.cy) }) : secp.ProjectivePoint.fromHex(strip(bytesToHex(asBytes(c))));
    let E = secp.ProjectivePoint.ZERO;
    for (const x of Cs) E = E.add(secp.ProjectivePoint.fromHex(strip(x)));
    E = E.add(Cin.negate());
    if (E.equals(secp.ProjectivePoint.ZERO) || !verifySchnorr(asBytes(dec.kernelSig), kernelMsg(dec.asset, [offer.note], Cs), E.toRawBytes(true).slice(1))) reasons.push('kernel');
  } catch { reasons.push('kernel'); }
  try {
    const rp = asBytes(dec.rangeProof);
    if (!(rp.length === bpClassicProofLen(Cs.length) ? bpRangeVerify(Cs, rp) : bppRangeVerify(Cs.map((x) => bytesToPoint(asBytes(x))), rp))) reasons.push('range-proof');
  } catch { reasons.push('range-proof'); }
  return { ok: reasons.length === 0, reasons, buyerBlinding, amount };
}

// The buyer's (watchtower's) take: check the offer, build the commit (funded from its coin) and the reveal, attach the seller's
// witness, sign the envelope input, and check the pair as anyone would before broadcasting. Throws, with the reasons, if any
// check fails; returns the hex to broadcast (commit first) and the buyer's note.
export function buyerTakeOffer({ prims, kit, offer, buyerKey = prims.wallet.priv, fundingUtxo, feeRate, expected, changeScript = null, maxFeeRate = null }) {
  const chk = buyerCheckOffer({ kit, offer, buyerKey, expected });
  if (!chk.ok) fail(`the offer does not check: ${chk.reasons.join(', ')}`);
  if (offer.v === 2) {
    // the pair is the seller's: its coin, its fee rate (within the buyer's ceiling), the commit's change back to the coin's script
    if (!(Number(offer.feeRate) > 0) || (maxFeeRate != null && Number(offer.feeRate) > Number(maxFeeRate))) fail(`the offer does not check: fee rate ${offer.feeRate} is over ${maxFeeRate}`);
    fundingUtxo = { txid: offer.fund.txid, vout: offer.fund.vout, value: offer.fund.value, script: offer.fund.script };
    feeRate = Number(offer.feeRate); changeScript = null;
  }
  const swap = buyerTxs({ prims, payload: offer.payload, noteScripts: offer.noteScripts, buyerKey, fundingUtxo, sellerNote: offer.note, sellerPayoutScript: offer.payoutScript,
    priceSats: offer.priceSats, feeRate, changeScript });
  if (offer.v === 2 && (swap.commitTxid !== offer.commitTxid || swap.revealTxid !== offer.revealTxid)) fail('the offer does not check: the pair it was signed over is not the one its coin and fee rate build');
  const fin = buyerFinish({ prims, swap, sellerWitness: offer.witness, buyerKey });
  const v = verifyBoundSwap({ revealHex: fin.revealHex, commitHex: fin.commitHex, prims, expected: {
    assetId: expected.assetId, amountToBuyer: chk.amount, buyerXonly: xonlyOf(priv32(buyerKey)), buyerBlinding: chk.buyerBlinding, sellerPayoutScript: offer.payoutScript,
    priceSats: offer.priceSats, chainBinding: expected.chainBinding, sellerNoteOutpoint: offer.note, sellerNoteCommitment: expected.sellerNoteCommitment, sellerNote: offer.note } });
  if (!v.ok) fail(`the swap does not verify: ${v.reasons.join(', ')}`);
  return { ...fin, commitFee: swap.commitFee, revealFee: swap.revealFee, swap: { envelopeScript: swap.envelopeScript, leafHash: swap.leafHash, controlBlock: swap.controlBlock },
    buyerNote: { txid: fin.revealTxid, vout: 0, amount: chk.amount, blinding: chk.buyerBlinding, script: bytesToHex(p2trScriptOf(xonlyOf(priv32(buyerKey)))) } };
}

// What the seller signs when it posts an offer (worker/src/bound-offers.js boundOfferMsg is the same function): every field of the
// offer, the bid it answers, and how long it stands.
export function boundOfferMsg(network, o, bidIdHex, expiry) {
  return sha256(new TextEncoder().encode(['tacit-bound-offer-v1', network, o.assetId, bidIdHex, `${o.note.txid}:${o.note.vout}`, o.note.value, o.note.script, o.amount, o.priceSats,
    o.payoutScript, o.payload, (o.noteScripts || []).join(','), (o.witness || []).join(','), o.sellerPub, o.buyerXonly, o.chainBinding, expiry,
    ...(o.v === 2 ? ['v2', `${o.fund?.txid}:${o.fund?.vout}`, o.fund?.value, o.fund?.script, o.feeRate, o.commitTxid, o.revealTxid, o.buyerPub] : [])].join('|')));
}
export const boundOfferCancelMsg = (network, asset, id) => sha256(new TextEncoder().encode(`tacit-bound-offer-cancel-v1|${network}|${asset}|${id}`));
export const boundOfferFilledMsg = (network, asset, id, revealTxid) => sha256(new TextEncoder().encode(`tacit-bound-offer-filled-v1|${network}|${asset}|${id}|${revealTxid}`));

// The commit's output back to the buyer by script path (it signs the envelope), when the reveal cannot go out (the seller spent its note
// first). The envelope shows again in this transaction, which carries no note input, so it makes no note on either side.
export function buyerReclaim({ prims, commitHex, swap, buyerKey = prims.wallet.priv, toScript, feeRate }) {
  const commit = parseTx(commitHex), out = commit.outputs[0];
  if (!out || !isP2tr(out.script)) fail('the commit has no envelope output');
  const k = priv32(buyerKey);
  const tx = { version: 2, locktime: 0, inputs: [{ txid: commit.txid, vout: 0, sequence: SEQ, witness: [new Uint8Array(64), swap.envelopeScript, swap.controlBlock] }], outputs: [{ value: 0, script: asBytes(toScript) }] };
  const value = out.value - prims.feeFor(vsizeOf(tx), feeRate);
  if (value < prims.DUST) fail('the commit output is too small to reclaim at this fee rate');
  tx.outputs[0].value = value;
  const ps = [{ value: out.value, script: out.script }];
  tx.inputs[0].witness = [signSchnorr(prims.tapSighash(tx, 0, ps, swap.leafHash, 0x00), k), swap.envelopeScript, swap.controlBlock];
  return { hex: bytesToHex(writeTx(tx)), txid: txidOf(tx), value };
}

// How a bought note goes home by the fast lane: through the relay, for its fee in the token, when the relay quotes one; else the
// wallet settles it itself (fee 0, Ethereum gas from the wallet), since a runtime token the relay does not price has no quote.
// quote: async () => the relay's fee in base units (throws or returns null when there is none).
export async function homeFeePlan({ quote, amount }) {
  const total = asBig(amount);
  let fee = null;
  try { const q = await quote(); fee = q == null ? null : asBig(q); } catch { fee = null; }
  if (fee == null || fee < 0n) return { fee: 0n, selfRelay: true };
  if (fee >= total) fail('this note is smaller than the fee of moving it');
  return { fee, selfRelay: false };
}
