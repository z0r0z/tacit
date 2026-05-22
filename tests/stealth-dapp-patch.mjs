// Pre-staged dapp integration code for Task 19 (class-2 CXFER
// stealth-recipient support). Self-contained module that mirrors
// what will be inlined into dapp/tacit.js once the parallel batch
// merge clears. The exact shape of these functions is designed for
// drop-in placement next to the existing cBTC.tac variant-1
// helpers around dapp/tacit.js:7845.
//
// Reference: spec/design/STEALTH-DAPP-INTEGRATION-PLAN.md
// Spec: spec/amendments/SPEC-BLINDED-PUBKEY-AMENDMENT.md
//
// Functions exported here are byte-identical to what tests/stealth-
// primitives.mjs provides, plus a few wrappers tailored to how
// dapp/tacit.js's existing CXFER builder + scanHoldings will call
// them. The unit test file tests/cxfer-stealth.test.mjs exercises
// this module standalone — once inlined into dapp/tacit.js, the
// same tests pass without modification (the function signatures and
// semantics stay identical).

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;

const hash160 = b => ripemd160(sha256(b));
const p2wpkhScript = pub => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pub));
const p2trScript = xOnly32 => concatBytes(new Uint8Array([0x51, 0x20]), xOnly32);

// =============================================================================
// PART 1 — Constants for the §C anchor registry
// =============================================================================
//
// These constants get inlined verbatim near dapp/tacit.js's existing
// CBTC_TAC_RECOVERY_BLINDING_DOMAIN block (line ~7820).

export const STEALTH_HRP = {
  mainnet: 'tcs',
  signet:  'tcsts',
  regtest: 'tcsrt',
};

export const DOMAIN_CXFER_STEALTH = new TextEncoder().encode('tacit-cxfer-stealth-v1');
export const DOMAIN_AXFER_STEALTH = new TextEncoder().encode('tacit-axfer-stealth-v1');
export const DOMAIN_AXFER_VAR_STEALTH = new TextEncoder().encode('tacit-axfer-var-stealth-v1');

// Map opcode byte → domain tag for scanner dispatch.
export const STEALTH_DOMAIN_BY_OPCODE = new Map([
  [0x22, DOMAIN_CXFER_STEALTH],     // T_CXFER_BPP
  [0x23, DOMAIN_CXFER_STEALTH],     // T_CXFER
  [0x26, DOMAIN_AXFER_STEALTH],     // T_AXFER
  [0x37, DOMAIN_AXFER_VAR_STEALTH], // T_AXFER_VAR
  [0x3C, DOMAIN_AXFER_STEALTH],     // T_AXFER_BPP
  [0x3D, DOMAIN_AXFER_VAR_STEALTH], // T_AXFER_VAR_BPP
]);

// Opcodes whose outputs are excluded from §A.2.5 sender aggregation
// (audit 2.2 normative classifier).
export const MIXER_EMITTING_OPCODES = new Set([
  0x2A,  // T_WITHDRAW
  0x44,  // T_SLOT_BURN
]);

// =============================================================================
// PART 2 — Bech32m address codec (tcs / tcsts / tcsrt)
// =============================================================================
//
// Slots into dapp/tacit.js next to the existing bech32 helpers
// around line 465. Note: the dapp already imports a `bech32` module
// (line 21); we use that for bech32m too via the same checksum
// constant swap.

const BECH32M_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function _bech32mPolymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function _bech32mExpandHrp(hrp) {
  const r = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >>> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}
function _bech32mChecksum(hrp, data) {
  const v = _bech32mExpandHrp(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const pm = _bech32mPolymod(v) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((pm >>> (5 * (5 - i))) & 31);
  return out;
}
function _bech32mVerifyChecksum(hrp, data) {
  return _bech32mPolymod(_bech32mExpandHrp(hrp).concat(data)) === BECH32M_CONST;
}
function _convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || (v >>> fromBits) !== 0) throw new Error('convertBits: invalid input');
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; ret.push((acc >>> bits) & maxv); }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error('convertBits: invalid padding');
  }
  return ret;
}
function _bech32mEncode(hrp, dataBytes) {
  const d5 = _convertBits(Array.from(dataBytes), 8, 5, true);
  const cs = _bech32mChecksum(hrp, d5);
  let out = hrp + '1';
  for (const v of d5.concat(cs)) out += BECH32M_ALPHABET[v];
  return out;
}
function _bech32mDecode(addr) {
  const lower = addr.toLowerCase();
  const upper = addr.toUpperCase();
  if (lower !== addr && upper !== addr) throw new Error('mixed case');
  addr = lower;
  const sep = addr.lastIndexOf('1');
  if (sep < 1 || sep + 7 > addr.length) throw new Error('invalid separator position');
  const hrp = addr.slice(0, sep);
  const d5 = [];
  for (let i = sep + 1; i < addr.length; i++) {
    const idx = BECH32M_ALPHABET.indexOf(addr[i]);
    if (idx === -1) throw new Error(`invalid char ${addr[i]}`);
    d5.push(idx);
  }
  if (!_bech32mVerifyChecksum(hrp, d5)) throw new Error('checksum');
  const payload5 = d5.slice(0, d5.length - 6);
  return { hrp, payloadBytes: new Uint8Array(_convertBits(payload5, 5, 8, false)) };
}

export function encodeStealthAddress({ network, recipientPub, scanPub, spendPub }) {
  const hrp = STEALTH_HRP[network];
  if (!hrp) throw new Error(`unknown network: ${network}`);
  const version = 0x00;
  let mode, payload;
  if (recipientPub && !scanPub && !spendPub) {
    if (!(recipientPub instanceof Uint8Array) || recipientPub.length !== 33) {
      throw new Error('recipientPub must be 33-byte compressed');
    }
    mode = 0x00; payload = recipientPub;
  } else if (scanPub && spendPub) {
    if (scanPub.length !== 33 || spendPub.length !== 33) {
      throw new Error('scan/spend pubkeys must be 33-byte compressed each');
    }
    mode = 0x01; payload = concatBytes(scanPub, spendPub);
  } else {
    throw new Error('provide either {recipientPub} or {scanPub, spendPub}');
  }
  return _bech32mEncode(hrp, concatBytes(new Uint8Array([version, mode]), payload));
}

export function decodeStealthAddress(addr) {
  const { hrp, payloadBytes } = _bech32mDecode(addr);
  let network;
  for (const [k, v] of Object.entries(STEALTH_HRP)) if (hrp === v) network = k;
  if (!network) throw new Error(`HRP ${hrp} is not a tacit stealth HRP`);
  if (payloadBytes.length < 2) throw new Error('payload too short');
  const version = payloadBytes[0], mode = payloadBytes[1];
  if (version !== 0x00) throw new Error(`unsupported version ${version}`);
  if (mode === 0x00) {
    if (payloadBytes.length !== 2 + 33) throw new Error('single-mode payload must be 33 bytes');
    const recipientPub = payloadBytes.slice(2, 35);
    try { secp.ProjectivePoint.fromHex(bytesToHex(recipientPub)); }
    catch { throw new Error('recipientPub is not a valid secp256k1 point'); }
    return { network, mode: 'single', recipientPub };
  } else if (mode === 0x01) {
    if (payloadBytes.length !== 2 + 66) throw new Error('dual-mode payload must be 66 bytes');
    const scanPub  = payloadBytes.slice(2, 35);
    const spendPub = payloadBytes.slice(35, 68);
    try {
      secp.ProjectivePoint.fromHex(bytesToHex(scanPub));
      secp.ProjectivePoint.fromHex(bytesToHex(spendPub));
    } catch { throw new Error('scan/spend pubkey not on curve'); }
    return { network, mode: 'dual', scanPub, spendPub };
  } else throw new Error(`unsupported mode ${mode}`);
}

// =============================================================================
// PART 3 — Blinding + commit + tweaked_sk derivation
// =============================================================================
//
// Inlines next to dapp/tacit.js's existing CBTC_TAC_RECOVERY block.
// Naming convention: Stealth* prefix to distinguish from the variant-1
// self-derived cBTC.tac helpers.

const networkTagByte = (net) => {
  if (net === 'mainnet') return 0x00;
  if (net === 'signet')  return 0x01;
  if (net === 'regtest') return 0x02;
  if (typeof net === 'number') return net & 0xff;
  throw new Error(`unknown network: ${net}`);
};

// ECDH shared secret per §A.2 (NORMATIVE x-only serialization). Split out
// so recipientScanTxForStealth can amortize a single call across every
// output of a tx (per §H.1: "ONE ECDH per tx").
export function deriveStealthEcdhSharedSecret({ ourPriv, theirPub }) {
  if (ourPriv.length !== 32) throw new Error('ourPriv must be 32 bytes');
  if (theirPub.length !== 33) throw new Error('theirPub must be 33 bytes compressed');
  const ourPrivBig = BigInt('0x' + bytesToHex(ourPriv));
  const theirPt = secp.ProjectivePoint.fromHex(bytesToHex(theirPub));
  const sharedPt = theirPt.multiply(ourPrivBig);
  const sharedXonly = sharedPt.toRawBytes(true).slice(1);
  return sha256(sharedXonly);
}

// Per-vout HMAC stage. Cheap (~20µs) once the caller has cached `shared`.
export function deriveStealthBlindingFromShared({ shared, networkTag, domain, txAnchor }) {
  const tag = new Uint8Array([networkTagByte(networkTag) & 0xff]);
  const mac = hmac(sha256, shared, concatBytes(domain, tag, txAnchor));
  const b = BigInt('0x' + bytesToHex(mac)) % SECP_N;
  if (b === 0n) throw new Error('ECDH blinding derived zero (statistically impossible)');
  return b;
}

// Convenience wrapper: do both stages in one call. The sender uses this
// because it computes a single commit per recipient pubkey.
export function deriveStealthEcdhBlinding({
  ourPriv, theirPub, networkTag, domain, txAnchor,
}) {
  const shared = deriveStealthEcdhSharedSecret({ ourPriv, theirPub });
  return deriveStealthBlindingFromShared({ shared, networkTag, domain, txAnchor });
}

export function computeStealthCommit({ underlyingPub, blinding }) {
  if (underlyingPub.length !== 33) throw new Error('underlyingPub must be 33 bytes compressed');
  const Pt = secp.ProjectivePoint.fromHex(bytesToHex(underlyingPub));
  const commitPt = Pt.add(G.multiply(blinding));
  if (commitPt.equals(ZERO)) throw new Error('commit equals point at infinity');
  return commitPt.toRawBytes(true);
}

export function computeStealthTweakedSk({ underlyingPriv, blinding }) {
  if (underlyingPriv.length !== 32) throw new Error('underlyingPriv must be 32 bytes');
  const d = BigInt('0x' + bytesToHex(underlyingPriv));
  if (d <= 0n || d >= SECP_N) throw new Error('underlyingPriv scalar out of range');
  const tweaked = (d + blinding) % SECP_N;
  if (tweaked === 0n) throw new Error('tweaked secret derived zero (statistically impossible)');
  let hex = tweaked.toString(16);
  while (hex.length < 64) hex = '0' + hex;
  return hexToBytes(hex);
}

// =============================================================================
// PART 4 — Eligible-input classifier + aggregation + §F.7 refusal
// =============================================================================
//
// classifyInput(): per-input descriptor for §A.2.5 aggregation.
// Wire it into dapp/tacit.js scanner where each tx's inputs are
// already walked for ancestry. Returns { kind, pub } where kind is
// one of 'p2wpkh', 'p2tr-keypath', 'p2wsh', 'p2tr-scriptpath',
// 'mixer-derived', 'unknown'.
//
// `prevoutOpReturn` (optional): opcode byte from vout[0] of the
// prevout's parent tx when that vout is an OP_RETURN-shaped tacit
// envelope. Checked FIRST per §A.2.5 precedence so a mixer-payout
// prevout that happens to be P2WPKH-shaped is correctly excluded
// before any script-shape branch fires. Reserved for future class-1
// stealth-withdraw amendments where mixer-derived asset UTXOs could
// flow into a class-2 reveal tx; no shipped opcode currently emits
// such inputs, so existing callers leave it undefined.

export function classifyInput({ witness, prevoutScript, prevoutOpReturn }) {
  // Mixer-derived precedence: parent tx's vout[0] envelope opcode in
  // MIXER_EMITTING_OPCODES. Must run before script-shape branches —
  // a mixer-withdraw recipient marker is itself P2WPKH-shaped and
  // would otherwise short-circuit into the wrong eligible bucket.
  if (prevoutOpReturn != null && MIXER_EMITTING_OPCODES.has(prevoutOpReturn)) {
    return { kind: 'mixer-derived', pub: null };
  }
  // P2WPKH: witness = [sig, pubkey(33)]; prevoutScript starts with 0x00 0x14.
  if (witness && witness.length === 2 && witness[1].length === 33 &&
      prevoutScript && prevoutScript[0] === 0x00 && prevoutScript[1] === 0x14) {
    return { kind: 'p2wpkh', pub: witness[1] };
  }
  // P2TR key-path: witness = [sig(64 or 65)]; prevoutScript starts with 0x51 0x20.
  if (witness && witness.length === 1 && (witness[0].length === 64 || witness[0].length === 65) &&
      prevoutScript && prevoutScript[0] === 0x51 && prevoutScript[1] === 0x20) {
    // P_i = lift_x(output_key). x-only is bytes [2..34); lift even-Y for the full point.
    const xOnly = prevoutScript.slice(2, 34);
    try {
      const pub = concatBytes(new Uint8Array([0x02]), xOnly);  // even-Y lift
      secp.ProjectivePoint.fromHex(bytesToHex(pub));            // validate
      return { kind: 'p2tr-keypath', pub };
    } catch { return { kind: 'unknown', pub: null }; }
  }
  // P2WSH: prevoutScript starts with 0x00 0x20.
  if (prevoutScript && prevoutScript[0] === 0x00 && prevoutScript[1] === 0x20) {
    return { kind: 'p2wsh', pub: null };
  }
  // P2TR script-path: witness ends with control block (last item).
  if (witness && witness.length >= 2 && prevoutScript &&
      prevoutScript[0] === 0x51 && prevoutScript[1] === 0x20) {
    return { kind: 'p2tr-scriptpath', pub: null };
  }
  return { kind: 'unknown', pub: null };
}

export function isStealthEligibleKind(kind) {
  return kind === 'p2wpkh' || kind === 'p2tr-keypath';
}

export function aggregateStealthEligibleInputPubkeys(inputs) {
  let acc = ZERO, count = 0;
  for (const inp of inputs) {
    if (!isStealthEligibleKind(inp.kind)) continue;
    if (!inp.pub || inp.pub.length !== 33) continue;
    const Pt = secp.ProjectivePoint.fromHex(bytesToHex(inp.pub));
    acc = acc.add(Pt); count += 1;
  }
  if (count === 0 || acc.equals(ZERO)) return { aggregatePub: null, eligibleCount: 0 };
  return { aggregatePub: acc.toRawBytes(true), eligibleCount: count };
}

// Mixer-derived classifier per §A.2.5 rule 6 (audit 2.2). Caller
// fetches prevoutTx; we read vout[0]'s OP_RETURN opcode byte.
export function isMixerDerivedInput({ prevoutTx, prevoutVout }) {
  if (!prevoutTx || !Array.isArray(prevoutTx.outputs) || prevoutTx.outputs.length === 0) {
    return false;
  }
  const vout0 = prevoutTx.outputs[0];
  if (!vout0?.script || vout0.script.length === 0) return false;
  if (vout0.script[0] !== 0x6a) return false;
  let opcodeIndex;
  if (vout0.script.length >= 3 && vout0.script[1] < 0x4c) opcodeIndex = 2;
  else if (vout0.script.length >= 4 && vout0.script[1] === 0x4c) opcodeIndex = 3;
  else return false;
  if (opcodeIndex >= vout0.script.length) return false;
  return MIXER_EMITTING_OPCODES.has(vout0.script[opcodeIndex]);
}

// §F.7 NORMATIVE refusal rule (audit 2.1). Caller supplies
// eachInputIsOurs(inp) which returns true iff inp is owned by the
// emitting wallet (wallet UTXO ledger lookup).
export function checkStealthEmissionSafety({ inputs, eachInputIsOurs }) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { safe: false, reason: 'no inputs' };
  }
  const eligible = inputs.filter(inp => isStealthEligibleKind(inp.kind));
  if (eligible.length === 0) return { safe: false, reason: 'no eligible inputs under §A.2.5' };
  for (let i = 0; i < eligible.length; i++) {
    if (!eachInputIsOurs(eligible[i])) {
      return {
        safe: false,
        reason: `eligible input #${i} (${eligible[i].kind}) not wallet-owned — multi-owner stealth out of scope for v1`,
      };
    }
  }
  return { safe: true, reason: 'all eligible inputs wallet-owned' };
}

// =============================================================================
// PART 5 — Sender + recipient high-level helpers
// =============================================================================

// Compose tx_anchor head per §C: first-asset-input outpoint =
// txid_LE(32) || vout_LE(4). For tacit envelope transfer opcodes
// (CXFER/AXFER family), vin[0] is the commit-reveal P2TR script-path
// input (ineligible per §A.2.5 rule 5); the canonical anchor uses
// vin[1].outpoint — the first asset input. Matches the existing
// amount-channel anchor convention so one outpoint binds both
// privacy planes.
export function stealthTxAnchorHead(firstAssetInTxidHex, firstAssetInVout) {
  const txidBE = hexToBytes(firstAssetInTxidHex);
  const txidLE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) txidLE[i] = txidBE[31 - i];
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, firstAssetInVout >>> 0, true);
  return concatBytes(txidLE, voutLE);
}

function _u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

// Sender side: compute commit for a stealth payment.
//   senderEligibleInputPrivs: array of 32-byte scalars (the wallet's
//     own privkeys corresponding to eligible inputs).
//   recipientPub: from decoded stealth address.
//   txAnchorHead: per §C registry (head only; vout_index appended).
//   voutIndex: per-output disambiguator.
export function senderComputeStealthCommit({
  senderEligibleInputPrivs, recipientPub, networkTag, domain, txAnchorHead, voutIndex,
}) {
  if (!Array.isArray(senderEligibleInputPrivs) || senderEligibleInputPrivs.length === 0) {
    throw new Error('senderEligibleInputPrivs must be non-empty');
  }
  let sum = 0n;
  for (const priv of senderEligibleInputPrivs) {
    if (priv.length !== 32) throw new Error('priv must be 32 bytes');
    const d = BigInt('0x' + bytesToHex(priv));
    if (d <= 0n || d >= SECP_N) throw new Error('priv scalar out of range');
    sum = (sum + d) % SECP_N;
  }
  if (sum === 0n) throw new Error('eligible priv sum is zero');
  let hex = sum.toString(16); while (hex.length < 64) hex = '0' + hex;
  const sumBytes = hexToBytes(hex);

  const txAnchor = concatBytes(txAnchorHead, _u32le(voutIndex));
  const b = deriveStealthEcdhBlinding({
    ourPriv: sumBytes, theirPub: recipientPub, networkTag, domain, txAnchor,
  });
  const commit = computeStealthCommit({ underlyingPub: recipientPub, blinding: b });
  return { commit, blinding: b };
}

// Recipient side: scan a tx for stealth-shaped outputs paying us.
//   classifiedInputs: array of { kind, pub } from classifyInput() per-vin.
//   outputs: array of { script: Uint8Array } per-vout.
//   txAnchorHead: per §C registry.
// Returns array of credits: { voutIndex, scriptKind, tweakedSk, commit, blinding, senderAggregatePub }.
export function recipientScanTxForStealth({
  classifiedInputs, outputs, walletPriv, walletPub, networkTag, domain, txAnchorHead,
}) {
  const { aggregatePub } = aggregateStealthEligibleInputPubkeys(classifiedInputs);
  if (!aggregatePub) return [];
  // §H.1: ONE ECDH per tx. shared depends only on (walletPriv, aggregatePub);
  // every vout reuses it and pays only the HMAC + EC scalar mul stage.
  const shared = deriveStealthEcdhSharedSecret({ ourPriv: walletPriv, theirPub: aggregatePub });
  const credits = [];
  for (let v = 0; v < outputs.length; v++) {
    const txAnchor = concatBytes(txAnchorHead, _u32le(v));
    const b = deriveStealthBlindingFromShared({
      shared, networkTag, domain, txAnchor,
    });
    const commit = computeStealthCommit({ underlyingPub: walletPub, blinding: b });
    const wpkh = p2wpkhScript(commit);
    const tr = p2trScript(commit.slice(1));
    const out = outputs[v].script;
    let scriptKind = null;
    if (out.length === wpkh.length && out.every((x, i) => x === wpkh[i])) scriptKind = 'p2wpkh';
    else if (out.length === tr.length && out.every((x, i) => x === tr[i])) scriptKind = 'p2tr';
    if (scriptKind) {
      const tweakedSk = computeStealthTweakedSk({ underlyingPriv: walletPriv, blinding: b });
      credits.push({
        voutIndex: v,
        scriptKind,
        tweakedSk,
        commit,
        blinding: b,
        senderAggregatePub: aggregatePub,
      });
    }
  }
  return credits;
}

// =============================================================================
// PART 6 — Re-export helpers the dapp scanner already has
// =============================================================================

export { p2wpkhScript, p2trScript };
export const xOnly = compressed33 => compressed33.slice(1);
