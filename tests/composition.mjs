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
function axintentClaimMsg(assetIdBytes, intentIdBytes, takerPubBytes, takerUtxoTxidHex, takerUtxoVout) {
  const txidBE = reverseBytes(hexToBytes(takerUtxoTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, takerUtxoVout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-claim-v2'),
    assetIdBytes, intentIdBytes, takerPubBytes,
    txidBE, voutLE,
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
const T_DROP   = 0x2B;   // public-claim pool over existing supply (SPEC §5.12)
const T_DCLAIM = 0x2C;   // permissionless claim event against a T_DROP ancestor (SPEC §5.13)

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

// ============== T_DROP / T_DCLAIM (SPEC §5.12 / §5.13) ==============
// Wire-format mirror of dapp/tacit.js — kept in sync via a dedicated parity
// test. Any change to the byte layout below MUST also update the dapp side
// and the test vectors in tests/airdrop.test.mjs.
//
// T_DROP payload — standard shape (per_claim > 0):
//   T_DROP(1) || asset_id(32) || cap_amount_LE(8) || per_claim_LE(8) ||
//   merkle_root(32) || expiry_height_LE(4) || ticker_len(1) || ticker(tlen) ||
//   decimals(1) || asset_input_count(1) || kernel_sig(64)
//
// Reclaim shape (per_claim = 0 sentinel; SPEC §5.12.1):
//   T_DROP(1) || asset_id(32) || cap_amount_LE(8) || per_claim_LE(8) = 0 ||
//   reclaim_drop_id(32) || reclaim_sig(64) || cap_blinding(32)
function encodeCDropPayload({ assetId, capAmount, perClaim, merkleRoot, expiryHeight, ticker, decimals, assetInputCount, kernelSig }) {
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  const cap = BigInt(capAmount);
  const per = BigInt(perClaim);
  if (cap <= 0n || cap >= (1n << 64n)) throw new Error('cap_amount out of u64');
  if (per <= 0n || per >= (1n << 64n)) throw new Error('per_claim out of u64');
  if (cap % per !== 0n) throw new Error('cap_amount must be divisible by per_claim');
  if (!(merkleRoot instanceof Uint8Array) || merkleRoot.length !== 32) throw new Error('merkle_root 32');
  const exp = Number(expiryHeight);
  if (!Number.isInteger(exp) || exp < 0 || exp > 0xffffffff) throw new Error('expiry_height u32');
  const tk = ticker ? new TextEncoder().encode(String(ticker)) : new Uint8Array(0);
  if (tk.length > 16) throw new Error('ticker too long');
  const dec = Number(decimals) || 0;
  if (!Number.isInteger(dec) || dec < 0 || dec > 8) throw new Error('decimals 0..8');
  const aic = Number(assetInputCount);
  if (!Number.isInteger(aic) || aic < 1 || aic > 16) throw new Error('asset_input_count 1..16');
  if (!(kernelSig instanceof Uint8Array) || kernelSig.length !== 64) throw new Error('kernel_sig 64');
  const capLE = new Uint8Array(8);
  { const v = new DataView(capLE.buffer); v.setUint32(0, Number(cap & 0xffffffffn), true); v.setUint32(4, Number((cap >> 32n) & 0xffffffffn), true); }
  const perLE = new Uint8Array(8);
  { const v = new DataView(perLE.buffer); v.setUint32(0, Number(per & 0xffffffffn), true); v.setUint32(4, Number((per >> 32n) & 0xffffffffn), true); }
  const expLE = new Uint8Array(4); new DataView(expLE.buffer).setUint32(0, exp >>> 0, true);
  return concatBytes(
    new Uint8Array([T_DROP]), assetId, capLE, perLE, merkleRoot, expLE,
    new Uint8Array([tk.length]), tk, new Uint8Array([dec]),
    new Uint8Array([aic]), kernelSig,
  );
}

function encodeCDropReclaimPayload({ assetId, capAmount, reclaimDropId, reclaimSig, capBlinding }) {
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  const cap = BigInt(capAmount);
  if (cap <= 0n || cap >= (1n << 64n)) throw new Error('cap_amount out of u64');
  if (!(reclaimDropId instanceof Uint8Array) || reclaimDropId.length !== 32) throw new Error('reclaim_drop_id 32');
  if (!(reclaimSig instanceof Uint8Array) || reclaimSig.length !== 64) throw new Error('reclaim_sig 64');
  if (!(capBlinding instanceof Uint8Array) || capBlinding.length !== 32) throw new Error('cap_blinding 32');
  let bNonZero = false;
  for (let i = 0; i < 32; i++) if (capBlinding[i] !== 0) { bNonZero = true; break; }
  if (!bNonZero) throw new Error('cap_blinding must be non-zero');
  const capLE = new Uint8Array(8);
  { const v = new DataView(capLE.buffer); v.setUint32(0, Number(cap & 0xffffffffn), true); v.setUint32(4, Number((cap >> 32n) & 0xffffffffn), true); }
  const perZeroLE = new Uint8Array(8);
  return concatBytes(
    new Uint8Array([T_DROP]), assetId, capLE, perZeroLE,
    reclaimDropId, reclaimSig, capBlinding,
  );
}

function decodeCDropPayload(payload) {
  if (!payload) return null;
  if (payload.length < 152) return null;
  if (payload[0] !== T_DROP) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const capView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const capAmount = (BigInt(capView.getUint32(4, true)) << 32n) | BigInt(capView.getUint32(0, true));
  p += 8;
  const perView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const perClaim = (BigInt(perView.getUint32(4, true)) << 32n) | BigInt(perView.getUint32(0, true));
  p += 8;
  if (capAmount <= 0n) return null;
  if (perClaim === 0n) {
    if (payload.length !== 1 + 32 + 8 + 8 + 32 + 64 + 32) return null;
    const reclaimDropId = payload.slice(p, p + 32); p += 32;
    const reclaimSig = payload.slice(p, p + 64); p += 64;
    const capBlinding = payload.slice(p, p + 32); p += 32;
    if (p !== payload.length) return null;
    let bNonZero = false;
    for (let i = 0; i < 32; i++) if (capBlinding[i] !== 0) { bNonZero = true; break; }
    if (!bNonZero) return null;
    return { kind: 'cdrop-reclaim', assetId, capAmount, reclaimDropId, reclaimSig, capBlinding };
  }
  if (perClaim >= (1n << 64n)) return null;
  if (capAmount % perClaim !== 0n) return null;
  const merkleRoot = payload.slice(p, p + 32); p += 32;
  const expView = new DataView(payload.buffer, payload.byteOffset + p, 4);
  const expiryHeight = expView.getUint32(0, true); p += 4;
  if (p + 1 > payload.length) return null;
  const tlen = payload[p]; p += 1;
  if (tlen > 16) return null;
  if (p + tlen + 1 + 1 + 64 > payload.length) return null;
  let ticker = null;
  if (tlen > 0) {
    try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount < 1 || assetInputCount > 16) return null;
  const kernelSig = payload.slice(p, p + 64); p += 64;
  if (p !== payload.length) return null;
  return { kind: 'cdrop', assetId, capAmount, perClaim, merkleRoot, expiryHeight, ticker, decimals, assetInputCount, kernelSig };
}

// T_DCLAIM payload:
//   T_DCLAIM(1) || asset_id(32) || drop_reveal_txid(32) || commitment(33) ||
//   amount_LE(8) || blinding(32) || witness_len_LE(2) || witness(witness_len)
//
// drop_reveal_txid is the raw txid of the originating T_DROP reveal tx.
// "drop_id" (the KV key, derived as SHA256(drop_reveal_txid_BE || 0_LE)) is
// a per-indexer derivation; the wire format does NOT carry it.
//
// Witness (merkle-gated): recipient_pub(33) || leaf_index_LE(4) ||
//   eth_address(20) || eth_sig(65) || proof_len(1) || proof_path(proof_len*32)
// Witness (open): empty (witness_len == 0).
function encodeCDClaimPayload({ assetId, dropRevealTxid, commitment, amount, blinding, witness }) {
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  if (!(dropRevealTxid instanceof Uint8Array) || dropRevealTxid.length !== 32) throw new Error('drop_reveal_txid 32');
  if (!(commitment instanceof Uint8Array) || commitment.length !== 33) throw new Error('commitment 33');
  const amt = BigInt(amount);
  if (amt <= 0n || amt >= (1n << 64n)) throw new Error('amount out of u64');
  if (!(blinding instanceof Uint8Array) || blinding.length !== 32) throw new Error('blinding 32');
  let bNonZero = false;
  for (let i = 0; i < 32; i++) if (blinding[i] !== 0) { bNonZero = true; break; }
  if (!bNonZero) throw new Error('blinding must be non-zero');
  const witnessBytes = witness instanceof Uint8Array ? witness : new Uint8Array(0);
  if (witnessBytes.length > 65535) throw new Error('witness too large');
  const amtLE = new Uint8Array(8);
  { const v = new DataView(amtLE.buffer); v.setUint32(0, Number(amt & 0xffffffffn), true); v.setUint32(4, Number((amt >> 32n) & 0xffffffffn), true); }
  const wLen = new Uint8Array(2); new DataView(wLen.buffer).setUint16(0, witnessBytes.length, true);
  return concatBytes(
    new Uint8Array([T_DCLAIM]), assetId, dropRevealTxid, commitment, amtLE, blinding,
    wLen, witnessBytes,
  );
}

function encodeCDClaimWitness({ recipientPub, leafIndex, ethAddress, ethSig, proofPath }) {
  if (!(recipientPub instanceof Uint8Array) || recipientPub.length !== 33) throw new Error('recipient_pub 33');
  if (recipientPub[0] !== 0x02 && recipientPub[0] !== 0x03) throw new Error('recipient_pub must start with 02 or 03');
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 0xffffffff) throw new Error('leaf_index u32');
  if (!(ethAddress instanceof Uint8Array) || ethAddress.length !== 20) throw new Error('eth_address 20');
  if (!(ethSig instanceof Uint8Array) || ethSig.length !== 65) throw new Error('eth_sig 65');
  if (!Array.isArray(proofPath)) throw new Error('proof_path must be an array');
  if (proofPath.length > 32) throw new Error('proof_path too deep');
  for (const s of proofPath) {
    if (!(s instanceof Uint8Array) || s.length !== 32) throw new Error('proof_path entries must be 32-byte');
  }
  const liLE = new Uint8Array(4); new DataView(liLE.buffer).setUint32(0, leafIndex >>> 0, true);
  return concatBytes(
    recipientPub, liLE, ethAddress, ethSig,
    new Uint8Array([proofPath.length]),
    ...proofPath,
  );
}

function decodeCDClaimPayload(payload) {
  if (!payload) return null;
  if (payload.length < 140) return null;
  if (payload[0] !== T_DCLAIM) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const dropRevealTxid = payload.slice(p, p + 32); p += 32;
  const commitment = payload.slice(p, p + 33); p += 33;
  const amtView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const amount = (BigInt(amtView.getUint32(4, true)) << 32n) | BigInt(amtView.getUint32(0, true));
  p += 8;
  if (amount <= 0n || amount >= (1n << 64n)) return null;
  const blinding = payload.slice(p, p + 32); p += 32;
  let bNonZero = false;
  for (let i = 0; i < 32; i++) if (blinding[i] !== 0) { bNonZero = true; break; }
  if (!bNonZero) return null;
  const wView = new DataView(payload.buffer, payload.byteOffset + p, 2);
  const witnessLen = wView.getUint16(0, true); p += 2;
  if (p + witnessLen !== payload.length) return null;
  const witnessBytes = payload.slice(p, p + witnessLen); p += witnessLen;
  let witness = null;
  if (witnessLen > 0) {
    const headerSize = 33 + 4 + 20 + 65 + 1;
    if (witnessLen < headerSize) return null;
    let wp = 0;
    const recipientPub = witnessBytes.slice(wp, wp + 33); wp += 33;
    if (recipientPub[0] !== 0x02 && recipientPub[0] !== 0x03) return null;
    const liView = new DataView(witnessBytes.buffer, witnessBytes.byteOffset + wp, 4);
    const leafIndex = liView.getUint32(0, true); wp += 4;
    const ethAddress = witnessBytes.slice(wp, wp + 20); wp += 20;
    const ethSig = witnessBytes.slice(wp, wp + 65); wp += 65;
    const proofLen = witnessBytes[wp]; wp += 1;
    if (proofLen > 32) return null;
    if (wp + proofLen * 32 !== witnessBytes.length) return null;
    const proofPath = [];
    for (let i = 0; i < proofLen; i++) {
      proofPath.push(witnessBytes.slice(wp, wp + 32));
      wp += 32;
    }
    witness = { recipientPub, leafIndex, ethAddress, ethSig, proofPath };
  }
  return { kind: 'cdclaim', assetId, dropRevealTxid, commitment, amount, blinding, witness };
}

function dropIdFromRevealTxid(revealTxidHex) {
  const txidBE = (() => { const b = hexToBytes(revealTxidHex); return b.reverse ? b.reverse() : new Uint8Array([...b].reverse()); })();
  const voutLE = new Uint8Array(4);
  return sha256(concatBytes(txidBE, voutLE));
}

function dropKernelMsg({ assetId, capAmount, perClaim, merkleRoot, expiryHeight, assetInputCount, assetInputs }) {
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  if (!(merkleRoot instanceof Uint8Array) || merkleRoot.length !== 32) throw new Error('merkle_root 32');
  const cap = BigInt(capAmount);
  const per = BigInt(perClaim);
  const capLE = new Uint8Array(8);
  { const v = new DataView(capLE.buffer); v.setUint32(0, Number(cap & 0xffffffffn), true); v.setUint32(4, Number((cap >> 32n) & 0xffffffffn), true); }
  const perLE = new Uint8Array(8);
  { const v = new DataView(perLE.buffer); v.setUint32(0, Number(per & 0xffffffffn), true); v.setUint32(4, Number((per >> 32n) & 0xffffffffn), true); }
  const expLE = new Uint8Array(4); new DataView(expLE.buffer).setUint32(0, Number(expiryHeight) >>> 0, true);
  const aicByte = new Uint8Array([assetInputCount & 0xff]);
  const inputsBytes = [];
  if (!Array.isArray(assetInputs) || assetInputs.length !== assetInputCount) {
    throw new Error('assetInputs.length must equal assetInputCount');
  }
  for (const inp of assetInputs) {
    if (typeof inp.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(inp.txid)) throw new Error('input.txid 64-hex');
    if (!Number.isInteger(inp.vout) || inp.vout < 0 || inp.vout > 0xffffffff) throw new Error('input.vout u32');
    const bytes = hexToBytes(inp.txid);
    inputsBytes.push(new Uint8Array([...bytes].reverse()));
    const voutLE = new Uint8Array(4); new DataView(voutLE.buffer).setUint32(0, inp.vout >>> 0, true);
    inputsBytes.push(voutLE);
  }
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-drop-v1'),
    assetId, capLE, perLE, merkleRoot, expLE, aicByte,
    ...inputsBytes,
  ));
}

function dropReclaimMsg({ reclaimDropId, assetId, capAmount }) {
  if (!(reclaimDropId instanceof Uint8Array) || reclaimDropId.length !== 32) throw new Error('reclaim_drop_id 32');
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  const cap = BigInt(capAmount);
  const capLE = new Uint8Array(8);
  { const v = new DataView(capLE.buffer); v.setUint32(0, Number(cap & 0xffffffffn), true); v.setUint32(4, Number((cap >> 32n) & 0xffffffffn), true); }
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-drop-reclaim-v1'),
    reclaimDropId, assetId, capLE,
  ));
}

// ============== AIRDROP / SNAPSHOT HELPERS ==============
// Mirror of dapp/tacit.js (search "AIRDROP_LEAF_TAG"). Keep in sync — if the
// merkle scheme or domain tags change, both must update.
const AIRDROP_LEAF_TAG = 'tacit-airdrop-leaf-v1';
const AIRDROP_NODE_TAG = 'tacit-airdrop-node-v1';

function _parseEthAddress(s) {
  if (typeof s !== 'string') throw new Error('eth_address must be a string');
  let a = s.trim();
  if (a.startsWith('0x') || a.startsWith('0X')) a = a.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(a)) throw new Error(`invalid eth_address: ${s}`);
  return hexToBytes(a.toLowerCase());
}

function airdropLeafHash(ethAddrBytes, amountBig, indexU32) {
  if (!(ethAddrBytes instanceof Uint8Array) || ethAddrBytes.length !== 20) {
    throw new Error('eth_address must be 20 bytes');
  }
  const amt = BigInt(amountBig);
  if (amt < 0n || amt >= (1n << 64n)) throw new Error('amount out of u64 range');
  const idx = Number(indexU32);
  if (!Number.isInteger(idx) || idx < 0 || idx > 0xffffffff) throw new Error('index out of u32 range');
  const amtLE = new Uint8Array(8);
  new DataView(amtLE.buffer).setBigUint64(0, amt, true);
  const idxLE = new Uint8Array(4);
  new DataView(idxLE.buffer).setUint32(0, idx, true);
  return sha256(concatBytes(
    new TextEncoder().encode(AIRDROP_LEAF_TAG),
    ethAddrBytes, amtLE, idxLE,
  ));
}

function _airdropNodeHash(a, b) {
  let cmp = 0;
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) { cmp = a[i] < b[i] ? -1 : 1; break; }
  }
  const [lo, hi] = cmp <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(
    new TextEncoder().encode(AIRDROP_NODE_TAG),
    lo, hi,
  ));
}

function buildAirdropMerkle(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('leaves must be a non-empty array');
  for (const l of leaves) {
    if (!(l instanceof Uint8Array) || l.length !== 32) throw new Error('leaves must be 32-byte arrays');
  }
  if (leaves.length === 1) return { root: leaves[0], layers: [leaves.slice()] };
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) next.push(_airdropNodeHash(prev[i], prev[i + 1]));
      else next.push(prev[i]);
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

function airdropMerkleProof(layers, leafIndex) {
  if (!Array.isArray(layers) || layers.length === 0) throw new Error('empty layers');
  if (leafIndex < 0 || leafIndex >= layers[0].length) throw new Error('leafIndex out of range');
  const proof = [];
  let idx = leafIndex;
  for (let h = 0; h < layers.length - 1; h++) {
    const layer = layers[h];
    const sibIdx = idx ^ 1;
    if (sibIdx < layer.length) proof.push(layer[sibIdx]);
    idx = idx >> 1;
  }
  return proof;
}

function verifyAirdropMerkleProof(leaf, proof, root) {
  if (!(leaf instanceof Uint8Array) || leaf.length !== 32) return false;
  if (!(root instanceof Uint8Array) || root.length !== 32) return false;
  let h = leaf;
  for (const s of proof) {
    if (!(s instanceof Uint8Array) || s.length !== 32) return false;
    h = _airdropNodeHash(h, s);
  }
  return h.length === 32 && h.every((b, i) => b === root[i]);
}

function _splitCSVLine(line) {
  const cells = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    let cell = '';
    if (line[i] === '"') {
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { cell += '"'; i += 2; }
          else { i++; break; }
        } else { cell += line[i]; i++; }
      }
      while (i < n && line[i] !== ',' && line[i] !== '\t') i++;
      if (i < n && (line[i] === ',' || line[i] === '\t')) i++;
    } else if (line[i] === ',' || line[i] === '\t') {
      i++;
    } else {
      while (i < n && line[i] !== ',' && line[i] !== '\t') { cell += line[i]; i++; }
      if (i < n && (line[i] === ',' || line[i] === '\t')) i++;
    }
    cells.push(cell.trim());
  }
  return cells;
}

function _parseAmountCell(s, decimals) {
  let clean = String(s).trim();
  if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
  clean = clean.replace(/[,\s_]/g, '');
  if (!clean) throw new Error('empty amount');
  if (decimals === 0) {
    if (!/^[0-9]+$/.test(clean)) {
      throw new Error(`amount must be a non-negative integer (saw "${s}"); set sourceDecimals to allow decimal display`);
    }
    return BigInt(clean);
  }
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(clean);
  if (!m) throw new Error(`invalid decimal amount: "${s}"`);
  const intPart = m[1];
  const fracPart = (m[2] || '').slice(0, decimals);
  const fracPadded = fracPart + '0'.repeat(decimals - fracPart.length);
  return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPadded);
}

function truncateAmountDecimals(amount, sourceDecimals, dstDecimals) {
  if (sourceDecimals === dstDecimals) return amount;
  if (sourceDecimals > dstDecimals) return amount / (10n ** BigInt(sourceDecimals - dstDecimals));
  return amount * (10n ** BigInt(dstDecimals - sourceDecimals));
}

function parseAirdropCSV(csvText, opts = {}) {
  if (typeof csvText !== 'string') throw new Error('csv must be a string');
  const sourceDecimals = Number.isInteger(opts.sourceDecimals) ? opts.sourceDecimals : 0;
  const targetDecimals = Number.isInteger(opts.targetDecimals) ? opts.targetDecimals : sourceDecimals;
  if (sourceDecimals < 0 || sourceDecimals > 36) throw new Error('sourceDecimals must be 0..36');
  if (targetDecimals < 0 || targetDecimals > 36) throw new Error('targetDecimals must be 0..36');
  const blacklist = opts.blacklist instanceof Set ? opts.blacklist : null;
  const addressColumn = Number.isInteger(opts.addressColumn) ? opts.addressColumn : 0;
  const amountColumn = Number.isInteger(opts.amountColumn) ? opts.amountColumn : 1;

  const lines = csvText.split(/\r?\n/);
  const rows = [];
  let assignedIndex = 0;
  let headerSeen = false;
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (!raw) continue;
    if (raw.startsWith('#') || raw.startsWith('//')) continue;

    const cells = _splitCSVLine(raw);
    if (cells.length <= Math.max(addressColumn, amountColumn)) {
      throw new Error(`csv line ${lineNo + 1}: expected ≥${Math.max(addressColumn, amountColumn) + 1} columns`);
    }
    const addrCell = cells[addressColumn];
    const amtCell = cells[amountColumn];

    if (!headerSeen && !/^0[xX]/.test(addrCell)) {
      headerSeen = true; continue;
    }
    headerSeen = true;

    let ethAddrBytes;
    try { ethAddrBytes = _parseEthAddress(addrCell); }
    catch (e) { throw new Error(`csv line ${lineNo + 1}: ${e.message}`); }
    const ethAddrHex = bytesToHex(ethAddrBytes);

    if (blacklist && blacklist.has(ethAddrHex)) continue;

    let amount;
    try { amount = _parseAmountCell(amtCell, sourceDecimals); }
    catch (e) { throw new Error(`csv line ${lineNo + 1}: ${e.message}`); }
    if (sourceDecimals !== targetDecimals) {
      amount = truncateAmountDecimals(amount, sourceDecimals, targetDecimals);
    }
    if (amount < 0n) throw new Error(`csv line ${lineNo + 1}: negative amount`);
    if (amount >= (1n << 64n)) throw new Error(`csv line ${lineNo + 1}: amount overflows u64 after conversion to ${targetDecimals} decimals`);
    if (amount === 0n) continue;

    rows.push({ ethAddrHex, ethAddrBytes, amount, index: assignedIndex });
    assignedIndex++;
  }
  return rows;
}

function mergeAirdropRows(rowSets) {
  if (!Array.isArray(rowSets)) throw new Error('rowSets must be an array');
  const byAddr = new Map();
  for (const rs of rowSets) {
    if (!Array.isArray(rs)) continue;
    for (const r of rs) {
      const key = r.ethAddrHex;
      const existing = byAddr.get(key);
      if (existing) existing.amount += r.amount;
      else byAddr.set(key, { ethAddrBytes: r.ethAddrBytes, amount: r.amount });
    }
  }
  for (const v of byAddr.values()) {
    if (v.amount >= (1n << 64n)) throw new Error('merged amount overflows u64');
  }
  const sorted = [...byAddr.entries()]
    .filter(([, v]) => v.amount > 0n)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sorted.map(([ethAddrHex, v], i) => ({
    ethAddrHex, ethAddrBytes: v.ethAddrBytes, amount: v.amount, index: i,
  }));
}

function parseBlacklist(text) {
  if (!text) return new Set();
  if (typeof text !== 'string') throw new Error('blacklist must be a string');
  const out = new Set();
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (!raw) continue;
    if (raw.startsWith('#') || raw.startsWith('//')) continue;
    const first = (_splitCSVLine(raw)[0] || '').trim();
    if (!first) continue;
    let hex = first.toLowerCase();
    if (hex.startsWith('0x')) hex = hex.slice(2);
    if (!/^[0-9a-f]{40}$/.test(hex)) {
      throw new Error(`blacklist line ${lineNo + 1}: invalid address "${first}"`);
    }
    out.add(hex);
  }
  return out;
}

function computeAirdropCommitment(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be non-empty');
  const seen = new Map();
  const duplicates = [];
  for (const r of rows) {
    if (seen.has(r.ethAddrHex)) duplicates.push({ addr: r.ethAddrHex, indexes: [seen.get(r.ethAddrHex), r.index] });
    else seen.set(r.ethAddrHex, r.index);
  }
  const leaves = rows.map(r => airdropLeafHash(r.ethAddrBytes, r.amount, r.index));
  const { root, layers } = buildAirdropMerkle(leaves);
  const total = rows.reduce((s, r) => s + r.amount, 0n);
  return {
    rows: rows.map((r, i) => ({ ...r, leaf: leaves[i] })),
    root, layers, total, count: rows.length, duplicates,
  };
}

// ---- Airdrop claim message + EIP-191 + ECDSA recover (mirror of dapp) ----
async function _loadKeccak() {
  const m = await import('@noble/hashes/sha3');
  return m.keccak_256;
}
let _keccak256 = null;  // populated at module-eval time below
{
  // top-level await isn't available in cjs/esm config here, but @noble's sha3
  // has a sync export. Import it directly.
  const m = await import('@noble/hashes/sha3');
  _keccak256 = m.keccak_256;
}

// Display a u64 amount with up to `decimals` fractional digits, no trailing
// zeros, no thousands separator. Mirrors fmtAssetAmountPlain in the dapp.
function _fmtAssetAmountPlain(amount, decimals) {
  if (decimals === 0) return amount.toString();
  const scale = 10n ** BigInt(decimals);
  const intPart = amount / scale;
  const fracPart = amount % scale;
  if (fracPart === 0n) return intPart.toString();
  let frac = fracPart.toString().padStart(decimals, '0');
  frac = frac.replace(/0+$/, '');
  return `${intPart.toString()}.${frac}`;
}

function buildAirdropClaimMsg({ rootHex, network, assetIdHex, ethAddrHex, leafIndex, amount, ticker, decimals, tacitPubHex }) {
  if (!/^[0-9a-f]{64}$/.test(String(rootHex || '').toLowerCase())) throw new Error('rootHex must be 64-hex');
  if (typeof network !== 'string' || !network) throw new Error('network required');
  if (!/^[0-9a-f]{64}$/.test(String(assetIdHex || '').toLowerCase())) throw new Error('assetIdHex must be 64-hex');
  const cleanAddr = String(ethAddrHex).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(cleanAddr)) throw new Error('ethAddrHex must be 40-hex');
  if (!Number.isInteger(leafIndex) || leafIndex < 0) throw new Error('leafIndex required');
  const amt = BigInt(amount);
  if (amt < 0n || amt >= (1n << 64n)) throw new Error('amount out of u64');
  if (typeof ticker !== 'string') throw new Error('ticker required');
  // Mirror of dapp/tacit.js: CETCH caps asset decimals at 8.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('decimals 0..8 (CETCH max)');
  const cleanPub = String(tacitPubHex).toLowerCase().replace(/\s/g, '');
  if (!/^0[23][0-9a-f]{64}$/.test(cleanPub)) throw new Error('tacitPubHex must be 33-byte compressed');
  const display = _fmtAssetAmountPlain(amt, decimals);
  const cleanRoot = String(rootHex).toLowerCase();
  const cleanAsset = String(assetIdHex).toLowerCase();
  return [
    'tacit airdrop claim v1',
    '',
    `Drop:    ${cleanRoot}`,
    `Network: ${network}`,
    `Asset:   ${cleanAsset}`,
    `Address: 0x${cleanAddr}`,
    `Leaf:    ${leafIndex}`,
    `Amount:  ${display} ${ticker} (${amt.toString()})`,
    `Tacit:   ${cleanPub}`,
    '',
    `By signing, you authorize the airdrop issuer to send the above amount of ${ticker} to the tacit pubkey listed.`,
  ].join('\n');
}

function eip191Hash(msg) {
  const msgBytes = new TextEncoder().encode(msg);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  return _keccak256(concatBytes(prefix, msgBytes));
}

function recoverEthAddrFromSig(msg, sigHex) {
  const clean = String(sigHex).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{130}$/.test(clean)) throw new Error('eth signature must be 65 bytes (130 hex)');
  const r = clean.slice(0, 64);
  const s = clean.slice(64, 128);
  const vByte = parseInt(clean.slice(128, 130), 16);
  let recovery;
  if (vByte === 27 || vByte === 28) recovery = vByte - 27;
  else if (vByte === 0 || vByte === 1) recovery = vByte;
  else throw new Error(`unsupported recovery v: ${vByte}`);
  const sig = secp.Signature.fromCompact(r + s).addRecoveryBit(recovery);
  const msgHash = eip191Hash(msg);
  const pub = sig.recoverPublicKey(msgHash);
  const pubBytes = pub.toRawBytes(false);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) throw new Error('recovered pubkey malformed');
  const xy = pubBytes.slice(1);
  return bytesToHex(_keccak256(xy).slice(12));
}

function verifyAirdropClaimSig(msg, sigHex, expectedEthAddrHex) {
  try {
    const recovered = recoverEthAddrFromSig(msg, sigHex);
    const expected = String(expectedEthAddrHex).toLowerCase().replace(/^0x/, '');
    return recovered === expected;
  } catch { return false; }
}

// Helper for tests: sign an EIP-191 message with a known privkey.
// Mirrors what MetaMask does on the recipient side.
function _signEip191WithPriv(msg, privBytes) {
  const msgHash = eip191Hash(msg);
  const sig = secp.sign(msgHash, privBytes);  // returns RecoveredSignature in noble v2
  // sig.recovery is 0|1; serialise as r||s||v with v ∈ {27, 28}
  const compact = sig.toCompactHex();  // 64+64 hex
  const v = (sig.recovery + 27).toString(16).padStart(2, '0');
  return '0x' + compact + v;
}

function _ethAddrFromPriv(privBytes) {
  const pub = secp.getPublicKey(privBytes, false);  // 65B uncompressed (0x04||X||Y)
  return bytesToHex(_keccak256(pub.slice(1)).slice(12));
}

export {
  N_BITS, T_CETCH, T_CXFER, T_MINT, T_BURN, T_DROP, T_DCLAIM,
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
  // T_DROP / T_DCLAIM (SPEC §5.12 / §5.13). Mirror of dapp/tacit.js.
  encodeCDropPayload, encodeCDropReclaimPayload, decodeCDropPayload,
  encodeCDClaimPayload, encodeCDClaimWitness, decodeCDClaimPayload,
  dropIdFromRevealTxid, dropKernelMsg, dropReclaimMsg,
  // Airdrop / snapshot helpers (mirror of dapp/tacit.js, see § AIRDROP)
  AIRDROP_LEAF_TAG, AIRDROP_NODE_TAG,
  airdropLeafHash, buildAirdropMerkle, airdropMerkleProof, verifyAirdropMerkleProof,
  parseAirdropCSV, computeAirdropCommitment,
  truncateAmountDecimals, mergeAirdropRows, parseBlacklist,
  // Airdrop claim message + EIP-191 + ECDSA recover
  buildAirdropClaimMsg, eip191Hash, recoverEthAddrFromSig, verifyAirdropClaimSig,
  _signEip191WithPriv, _ethAddrFromPriv,
};
