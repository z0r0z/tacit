// Higher-level crypto from tacit.html, mirrored for offline testing.
// BP primitives are imported from ./bulletproofs.mjs (single source of truth).
//
// What's mirrored here:
//   - BIP-340 Schnorr (in-house impl; same one tacit.html ships)
//   - ECDH-derived blinding factors and amount-encryption keystreams
//   - Self-derived (etcher / change) blindings + keystreams
//   - Pedersen amount encryption (XOR-OTP over HMAC keystream)
//   - Kernel message hash (Mimblewimble-style)
//   - Asset_id derivation
//   - CETCH / CXFER payload encoders + decoders
//
// Run from this directory: `node composition.test.mjs`.
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, bytesToPoint,
  bigintToBytes32, bytes32ToBigint,
  randomScalar,
} from './bulletproofs.mjs';

const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N_BITS = 64;

const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };

// ---- Asset ID ----
function assetIdFor(etchTxidHex, etchVout) {
  const txidBE = reverseBytes(hexToBytes(etchTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, etchVout >>> 0, true);
  return sha256(concatBytes(txidBE, voutLE));
}

// ---- Domain labels ----
const BLIND_DOMAIN       = new TextEncoder().encode('tacit-blind-v1');
const CHANGE_DOMAIN      = new TextEncoder().encode('tacit-change-v1');
const ETCH_BLIND_DOMAIN  = new TextEncoder().encode('tacit-etch-v1');
const ETCH_AMOUNT_DOMAIN = new TextEncoder().encode('tacit-etch-amount-v1');
const MINT_BLIND_DOMAIN  = new TextEncoder().encode('tacit-mint-blind-v1');
const MINT_AMOUNT_DOMAIN = new TextEncoder().encode('tacit-mint-amount-v1');
const AMOUNT_DOMAIN      = new TextEncoder().encode('tacit-amount-v1');
const AMOUNT_SELF_DOMAIN = new TextEncoder().encode('tacit-amount-self-v1');

function deriveBlinding(myPriv, theirPubBytes, anchorBytes, voutIdx) {
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const sharedX = shared.slice(1);
  const seed = sha256(sharedX);
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, seed, concatBytes(BLIND_DOMAIN, anchorBytes, voutLE));
  return bytes32ToBigint(out) % SECP_N;
}
function deriveChangeBlinding(myPriv, anchorBytes, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, myPriv, concatBytes(CHANGE_DOMAIN, anchorBytes, voutLE));
  return bytes32ToBigint(out) % SECP_N;
}
function deriveEtchBlinding(myPriv, anchorBytes) {
  const out = hmac(sha256, myPriv, concatBytes(ETCH_BLIND_DOMAIN, anchorBytes));
  return bytes32ToBigint(out) % SECP_N;
}
function deriveEtchAmountKeystream(myPriv, anchorBytes) {
  return hmac(sha256, myPriv, concatBytes(ETCH_AMOUNT_DOMAIN, anchorBytes)).slice(0, 8);
}
function deriveAmountKeystreamECDH(myPriv, theirPubBytes, anchorBytes, voutIdx) {
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const seed = sha256(shared.slice(1));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, seed, concatBytes(AMOUNT_DOMAIN, anchorBytes, voutLE)).slice(0, 8);
}
function deriveAmountKeystreamSelf(myPriv, anchorBytes, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, myPriv, concatBytes(AMOUNT_SELF_DOMAIN, anchorBytes, voutLE)).slice(0, 8);
}
function deriveMintBlinding(myPriv, anchorBytes) {
  const out = hmac(sha256, myPriv, concatBytes(MINT_BLIND_DOMAIN, anchorBytes));
  return bytes32ToBigint(out) % SECP_N;
}
function deriveMintAmountKeystream(myPriv, anchorBytes) {
  return hmac(sha256, myPriv, concatBytes(MINT_AMOUNT_DOMAIN, anchorBytes)).slice(0, 8);
}

// ---- Atomic-intent ECDH blinding keystream (mirror of dapp/worker) ----
// 32-byte keystream used to encrypt a maker's recipient_blinding to the
// claimant at fulfilment time. Symmetric: maker uses (maker.priv, taker.pub),
// taker uses (taker.priv, maker.pub). Domain-separated and bound to
// (intent_id, asset_id).
const AXINTENT_BLINDING_DOMAIN = new TextEncoder().encode('tacit-axintent-blinding-v1');
function deriveAxintentBlindingKeystream(myPriv, theirPubBytes, intentIdBytes, assetIdBytes) {
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const seed = sha256(shared.slice(1));
  return hmac(sha256, seed, concatBytes(AXINTENT_BLINDING_DOMAIN, intentIdBytes, assetIdBytes));
}
function xor32(a, b) {
  if (a.length !== 32 || b.length !== 32) throw new Error('xor32 requires 32-byte inputs');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i];
  return out;
}

// ---- Atomic-intent message hashes (mirror of dapp/worker domain tags) ----
function axintentMsg(assetIdBytes, intentIdBytes, makerPubBytes, amount, priceSats, expiry, commitTxidHex, assetUtxoTxidHex, assetUtxoVout) {
  const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8); new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
  const utxoVoutLE = new Uint8Array(4); new DataView(utxoVoutLE.buffer).setUint32(0, assetUtxoVout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-v1'),
    assetIdBytes, intentIdBytes, makerPubBytes,
    amountLE, priceLE, expiryLE,
    reverseBytes(hexToBytes(commitTxidHex)),
    reverseBytes(hexToBytes(assetUtxoTxidHex)), utxoVoutLE,
  ));
}
function axintentClaimMsg(assetIdBytes, intentIdBytes, takerPubBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-claim-v1'),
    assetIdBytes, intentIdBytes, takerPubBytes,
  ));
}
function axintentFulfilmentMsg(assetIdBytes, intentIdBytes, takerPubBytes, partialJson) {
  const phash = sha256(new TextEncoder().encode(partialJson));
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-fulfilment-v1'),
    assetIdBytes, intentIdBytes, takerPubBytes, phash,
  ));
}
function axintentCancelMsg(assetIdBytes, intentIdBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-cancel-v1'),
    assetIdBytes, intentIdBytes,
  ));
}

// ---- XOR-OTP amount encryption ----
function encryptAmount(amountBigint, keystream8) {
  const a = BigInt(amountBigint);
  if (a < 0n || a >= (1n << 64n)) throw new Error('amount out of u64 range');
  const ct = new Uint8Array(8);
  let n = a;
  for (let i = 0; i < 8; i++) { ct[i] = (Number(n & 0xffn)) ^ keystream8[i]; n >>= 8n; }
  return ct;
}
function decryptAmount(ciphertext8, keystream8) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(ciphertext8[i] ^ keystream8[i]);
  return n;
}

// ---- BIP-340 Schnorr (in-house impl mirrored from tacit.html) ----
function _taggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}
function _xor32(a, b) { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = a[i] ^ b[i]; return r; }
function signSchnorr(msgHash, priv32) {
  const dPrime = bytes32ToBigint(priv32);
  if (dPrime <= 0n || dPrime >= SECP_N) throw new Error('schnorr: invalid private key');
  const P = G.multiply(dPrime);
  const Pbytes = P.toRawBytes(true);
  const Px = Pbytes.slice(1);
  const d = (Pbytes[0] === 0x02) ? dPrime : (SECP_N - dPrime);
  const aux = crypto.getRandomValues(new Uint8Array(32));
  const t = _xor32(bigintToBytes32(d), _taggedHash('BIP0340/aux', aux));
  const rand = _taggedHash('BIP0340/nonce', t, Px, msgHash);
  let kPrime = bytes32ToBigint(rand) % SECP_N;
  if (kPrime === 0n) throw new Error('schnorr: nonce was zero');
  const R = G.multiply(kPrime);
  const Rbytes = R.toRawBytes(true);
  const Rx = Rbytes.slice(1);
  const k = (Rbytes[0] === 0x02) ? kPrime : (SECP_N - kPrime);
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, Px, msgHash)) % SECP_N;
  const s = (k + e * d) % SECP_N;
  return concatBytes(Rx, bigintToBytes32(s));
}
function verifySchnorr(sig64, msgHash, pubXonly32) {
  if (sig64.length !== 64 || pubXonly32.length !== 32 || msgHash.length !== 32) return false;
  const Rx = sig64.slice(0, 32);
  const sBig = bytes32ToBigint(sig64.slice(32, 64));
  if (sBig >= SECP_N) return false;
  if (bytes32ToBigint(pubXonly32) >= SECP_P) return false;
  let P; try { P = secp.ProjectivePoint.fromHex('02' + bytesToHex(pubXonly32)); } catch { return false; }
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, pubXonly32, msgHash)) % SECP_N;
  const R = G.multiply(sBig).add(P.multiply(e).negate());
  if (R.equals(secp.ProjectivePoint.ZERO)) return false; // BIP-340: reject infinite R
  const Rb = R.toRawBytes(true);
  if (Rb[0] !== 0x02) return false;
  return bytesToHex(Rb.slice(1)) === bytesToHex(Rx);
}

// ---- Kernel message ----
// burnedAmount is appended (8 LE u64) so CXFER (burn=0) and BURN (burn>0) hash
// differently and replay across paths is impossible. CXFER callers omit the
// argument; default 0n keeps the existing serialisation when burn isn't used.
function computeKernelMsg(assetId, inputOutpoints, outputCommitments, burnedAmount = 0n) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), assetId, new Uint8Array([inputOutpoints.length & 0xff])];
  for (const op of inputOutpoints) {
    parts.push(reverseBytes(hexToBytes(op.txid)));
    const voutLE = new Uint8Array(4);
    new DataView(voutLE.buffer).setUint32(0, op.vout >>> 0, true);
    parts.push(voutLE);
  }
  parts.push(new Uint8Array([outputCommitments.length & 0xff]));
  for (const c of outputCommitments) parts.push(c);
  const burnLE = new Uint8Array(8);
  const view = new DataView(burnLE.buffer);
  view.setUint32(0, Number(burnedAmount & 0xffffffffn), true);
  view.setUint32(4, Number((burnedAmount >> 32n) & 0xffffffffn), true);
  parts.push(burnLE);
  return sha256(concatBytes(...parts));
}

// ---- Mint authorisation message (SPEC §5.3) ----
// commitAnchor = commit_tx.vin[0].txid_BE || commit_tx.vin[0].vout_LE (36 bytes).
// Binding the issuer sig to commit_anchor stops envelope-replay into a different
// commit/reveal pair: without it, an attacker who reads any past T_MINT can
// rewrap the on-chain payload into their own commit/reveal at their own address
// and the validator would still accept it.
function computeMintMsg(assetId, commitAnchor, commitment, encryptedAmount) {
  if (!commitAnchor || commitAnchor.length !== 36) throw new Error('commit_anchor must be 36 bytes');
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-mint-v1'),
    assetId, commitAnchor, commitment, encryptedAmount,
  ));
}

// ---- Off-chain message builders (worker-flow signatures) ----
// These mirror the dApp's openingMsg / disclosureMsg / listingMsg / cancelMsg /
// claimMsg byte-for-byte. The cross-impl parity test in worker-parity.test.mjs
// asserts these produce identical bytes to the worker's own copies.

function openingMsg(assetIdBytes, txidHex, vout, amountBigint, blindingBytes, ownerPubBytes) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  const amountLE = new Uint8Array(8);
  new DataView(amountLE.buffer).setBigUint64(0, BigInt(amountBigint), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-opening-v1'),
    assetIdBytes,
    txidBE,
    voutLE,
    amountLE,
    blindingBytes,
    ownerPubBytes,
  ));
}

function disclosureMsg(assetIdBytes, utxos, thresholdBig, rangeproofBytes, ownerPubBytes) {
  const N = utxos.length;
  if (N > 0xffff) throw new Error('disclosure: too many utxos');
  const refsBytes = new Uint8Array(N * 36);
  for (let i = 0; i < N; i++) {
    refsBytes.set(reverseBytes(hexToBytes(utxos[i].txid)), i * 36);
    new DataView(refsBytes.buffer, refsBytes.byteOffset + i * 36 + 32, 4)
      .setUint32(0, utxos[i].vout >>> 0, true);
  }
  const nLE = new Uint8Array(2);
  new DataView(nLE.buffer).setUint16(0, N, true);
  const thresholdLE = new Uint8Array(8);
  new DataView(thresholdLE.buffer).setBigUint64(0, BigInt(thresholdBig), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-disclosure-v1'),
    assetIdBytes,
    nLE,
    refsBytes,
    thresholdLE,
    rangeproofBytes,
    ownerPubBytes,
  ));
}

function listingMsg(assetIdBytes, txidHex, vout, priceSats, expiry, makerAddress, openingSigBytes) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const addrBytes = new TextEncoder().encode(makerAddress);
  const addrLen = new Uint8Array(2);
  new DataView(addrLen.buffer).setUint16(0, addrBytes.length, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-v1'),
    assetIdBytes,
    txidBE,
    voutLE,
    priceLE,
    expiryLE,
    addrLen,
    addrBytes,
    openingSigBytes,
  ));
}

function cancelMsg(assetIdBytes, txidHex, vout) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-cancel-v1'),
    assetIdBytes, txidBE, voutLE,
  ));
}

function claimMsg(assetIdBytes, txidHex, vout, takerPubBytes) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-claim-v1'),
    assetIdBytes, txidBE, voutLE, takerPubBytes,
  ));
}

// ---- Wire format opcodes ----
const T_CETCH = 0x21;
const T_CXFER = 0x23;
const T_MINT  = 0x24;
const T_BURN  = 0x25;

const MINT_AUTH_NONE = new Uint8Array(32);
const _isZeroAuth = b => { for (let i = 0; i < 32; i++) if (b[i] !== 0) return false; return true; };

// CETCH payload (envelope v3, bulletproofs + opt-in mint authority)
function encodeCEtchPayload({ ticker, decimals, commitment, rangeproof, encryptedAmount, mintAuthority = null, imageUri = null }) {
  const tk = new TextEncoder().encode(ticker);
  if (tk.length === 0 || tk.length > 16) throw new Error('ticker 1–16 bytes');
  if (decimals < 0 || decimals > 8) throw new Error('decimals 0–8');
  if (commitment.length !== 33) throw new Error('commitment 33 bytes');
  if (!encryptedAmount || encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const auth = mintAuthority || MINT_AUTH_NONE;
  if (auth.length !== 32) throw new Error('mint_authority must be 32 bytes (x-only pubkey or zero)');
  const imgBytes = imageUri ? new TextEncoder().encode(imageUri) : new Uint8Array(0);
  if (imgBytes.length > 256) throw new Error('image_uri must be ≤256 bytes');
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  const imgLen = new Uint8Array(2); new DataView(imgLen.buffer).setUint16(0, imgBytes.length, true);
  return concatBytes(
    new Uint8Array([T_CETCH]), new Uint8Array([tk.length]), tk,
    new Uint8Array([decimals]), commitment, encryptedAmount, rpLen, rangeproof, auth, imgLen, imgBytes,
  );
}
function decodeCEtchPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 1 + 1 + 1 + 33 + 8 + 2 + 32 + 2) return null;
  if (payload[0] !== T_CETCH) return null;
  let p = 1;
  const tlen = payload[p]; p += 1;
  if (tlen < 1 || tlen > 16) return null;
  if (p + tlen > payload.length) return null;
  let ticker;
  try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  if (p + 33 + 8 + 2 > payload.length) return null;
  const commitment = payload.slice(p, p + 33); p += 33;
  const encryptedAmount = payload.slice(p, p + 8); p += 8;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen + 32 + 2 > payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen); p += rpLen;
  const mintAuthority = payload.slice(p, p + 32); p += 32;
  const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (imgLen > 256) return null;
  if (p + imgLen !== payload.length) return null;
  let imageUri = null;
  if (imgLen > 0) {
    try { imageUri = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + imgLen)); } catch { return null; }
  }
  const mintable = !_isZeroAuth(mintAuthority);
  return { kind: 'cetch', ticker, decimals, commitment, rangeproof, encryptedAmount, mintAuthority, mintable, imageUri };
}

// MINT payload (envelope v3, signed by mint_authority over (asset_id, commitment, ct))
function encodeCMintPayload({ assetId, etchTxid, commitment, encryptedAmount, rangeproof, issuerSig }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (etchTxid.length !== 32) throw new Error('etch_txid 32 bytes');
  if (commitment.length !== 33) throw new Error('commitment 33 bytes');
  if (!encryptedAmount || encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  if (!issuerSig || issuerSig.length !== 64) throw new Error('issuer_sig must be 64 bytes');
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  return concatBytes(
    new Uint8Array([T_MINT]), assetId, etchTxid,
    commitment, encryptedAmount, rpLen, rangeproof, issuerSig,
  );
}
function decodeCMintPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 32 + 33 + 8 + 2 + 64) return null;
  if (payload[0] !== T_MINT) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const etchTxid = payload.slice(p, p + 32); p += 32;
  const commitment = payload.slice(p, p + 33); p += 33;
  const encryptedAmount = payload.slice(p, p + 8); p += 8;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen + 64 > payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen); p += rpLen;
  const issuerSig = payload.slice(p, p + 64); p += 64;
  if (p !== payload.length) return null;
  return { kind: 'cmint', assetId, etchTxid, commitment, encryptedAmount, rangeproof, issuerSig };
}

// BURN payload (envelope v3, public burnedAmount + Σ_in = burned·H + Σ_out balance)
function encodeCBurnPayload({ assetId, burnedAmount, kernelSig, outputs, rangeproof }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (burnedAmount < 0n || burnedAmount >= (1n << BigInt(N_BITS))) throw new Error('burned_amount out of range');
  if (!kernelSig || kernelSig.length !== 64) throw new Error('kernel_sig must be 64 bytes');
  if (![0, 1, 2, 4, 8].includes(outputs.length)) throw new Error('outputs.length must be in {0,1,2,4,8}');
  if (outputs.length > 0 && rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const burnLE = new Uint8Array(8);
  {
    const view = new DataView(burnLE.buffer);
    view.setUint32(0, Number(burnedAmount & 0xffffffffn), true);
    view.setUint32(4, Number((burnedAmount >> 32n) & 0xffffffffn), true);
  }
  const parts = [new Uint8Array([T_BURN]), assetId, burnLE, kernelSig, new Uint8Array([outputs.length])];
  for (const o of outputs) {
    if (o.commitment.length !== 33) throw new Error('commitment 33 bytes');
    if (!o.encryptedAmount || o.encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
    parts.push(o.commitment, o.encryptedAmount);
  }
  if (outputs.length > 0) {
    const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
    parts.push(rpLen, rangeproof);
  }
  return concatBytes(...parts);
}
function decodeCBurnPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 8 + 64 + 1) return null;
  if (payload[0] !== T_BURN) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const burnedLE = payload.slice(p, p + 8); p += 8;
  const view = new DataView(burnedLE.buffer, burnedLE.byteOffset, 8);
  const burnedAmount = (BigInt(view.getUint32(4, true)) << 32n) | BigInt(view.getUint32(0, true));
  const kernelSig = payload.slice(p, p + 64); p += 64;
  const n = payload[p]; p += 1;
  if (![0, 1, 2, 4, 8].includes(n)) return null;
  const outputs = [];
  for (let i = 0; i < n; i++) {
    if (p + 33 + 8 > payload.length) return null;
    const commitment = payload.slice(p, p + 33); p += 33;
    const encryptedAmount = payload.slice(p, p + 8); p += 8;
    outputs.push({ commitment, encryptedAmount });
  }
  let rangeproof = new Uint8Array(0);
  if (n > 0) {
    if (p + 2 > payload.length) return null;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen !== payload.length) return null;
    rangeproof = payload.slice(p, p + rpLen);
  } else {
    if (p !== payload.length) return null;
  }
  return { kind: 'cburn', assetId, burnedAmount, kernelSig, outputs, rangeproof };
}

// CXFER payload (envelope v2, aggregated bulletproof)
function encodeCXferPayload({ assetId, kernelSig, outputs, rangeproof }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (!kernelSig || kernelSig.length !== 64) throw new Error('kernel_sig must be 64 bytes');
  if (![1, 2, 4, 8].includes(outputs.length)) throw new Error('outputs must be in {1,2,4,8}');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const parts = [new Uint8Array([T_CXFER]), assetId, kernelSig, new Uint8Array([outputs.length])];
  for (const o of outputs) {
    if (o.commitment.length !== 33) throw new Error('commitment 33 bytes');
    if (!o.encryptedAmount || o.encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
    parts.push(o.commitment, o.encryptedAmount);
  }
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  parts.push(rpLen, rangeproof);
  return concatBytes(...parts);
}
function decodeCXferPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 64 + 1 + (33 + 8) + 2) return null;
  if (payload[0] !== T_CXFER) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const kernelSig = payload.slice(p, p + 64); p += 64;
  const n = payload[p]; p += 1;
  if (![1, 2, 4, 8].includes(n)) return null;
  const outputs = [];
  for (let i = 0; i < n; i++) {
    if (p + 33 + 8 > payload.length) return null;
    const commitment = payload.slice(p, p + 33); p += 33;
    const encryptedAmount = payload.slice(p, p + 8); p += 8;
    outputs.push({ commitment, encryptedAmount });
  }
  if (p + 2 > payload.length) return null;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen !== payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen);
  return { kind: 'cxfer', assetId, kernelSig, outputs, rangeproof };
}

export {
  N_BITS, T_CETCH, T_CXFER, T_MINT, T_BURN,
  reverseBytes, assetIdFor,
  deriveBlinding, deriveChangeBlinding, deriveEtchBlinding, deriveMintBlinding,
  deriveAmountKeystreamECDH, deriveAmountKeystreamSelf, deriveEtchAmountKeystream, deriveMintAmountKeystream,
  deriveAxintentBlindingKeystream, xor32,
  encryptAmount, decryptAmount,
  signSchnorr, verifySchnorr,
  computeKernelMsg, computeMintMsg,
  openingMsg, disclosureMsg, listingMsg, cancelMsg, claimMsg,
  axintentMsg, axintentClaimMsg, axintentFulfilmentMsg, axintentCancelMsg,
  encodeCEtchPayload, decodeCEtchPayload,
  encodeCXferPayload, decodeCXferPayload,
  encodeCMintPayload, decodeCMintPayload,
  encodeCBurnPayload, decodeCBurnPayload,
};
