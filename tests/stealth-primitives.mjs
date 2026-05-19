// Reference implementation of the blinded-pubkey commit construction
// from SPEC-BLINDED-PUBKEY-AMENDMENT.md, for use in unit + signet tests.
//
// Standalone module — does NOT modify dapp/tacit.js. Once these
// primitives are validated by the test suite + signet round-trip,
// they can be integrated into the production dapp via a follow-up
// refactor.
//
// Construction (recap):
//   commit  =  P_underlying  +  blinding · G
//   blinding = HMAC-SHA256(shared_secret, domain || network || tx_anchor)
//
// Two derivation variants:
//   - Self-derived:   shared_secret = wallet.priv
//   - ECDH-derived:   shared_secret = ECDH(sender_priv, recipient_pub)
//
// Spending:  tweaked_sk = (sk_underlying + blinding) mod SECP_N
//   - P2WPKH(hash160(commit_compressed)) → sign ECDSA with tweaked_sk
//   - P2TR(x_only(commit))               → sign BIP-340 Schnorr with tweaked_sk

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;

const hash160 = b => ripemd160(sha256(b));

// =============================================================================
//                       Address codec (§D.1 normative)
// =============================================================================

// Tacit stealth-capable address format (bech32m):
//   hrp     = "tcs" | "tcsts" | "tcsrt"  (mainnet / signet / regtest)
//   version = 0x00
//   mode    = 0x00 (single-pubkey)  or  0x01 (dual scan+spend)
//   payload =
//     mode=0x00:  P_recipient (33 bytes compressed)
//     mode=0x01:  P_scan ++ P_spend (66 bytes total)

export const STEALTH_HRP = {
  mainnet: 'tcs',
  signet:  'tcsts',
  regtest: 'tcsrt',
};

// Bech32m constants (BIP-350).
const BECH32M_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function _bech32mChecksumPolymod(values) {
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

function _bech32mCreateChecksum(hrp, data) {
  const values = _bech32mExpandHrp(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = _bech32mChecksumPolymod(values) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((polymod >>> (5 * (5 - i))) & 31);
  return out;
}

function _bech32mVerifyChecksum(hrp, data) {
  const expanded = _bech32mExpandHrp(hrp).concat(data);
  return _bech32mChecksumPolymod(expanded) === BECH32M_CONST;
}

function _convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || (v >>> fromBits) !== 0) throw new Error('convertBits: invalid input');
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error('convertBits: invalid padding');
  }
  return ret;
}

function _bech32mEncode(hrp, dataBytes) {
  const data5bit = _convertBits(Array.from(dataBytes), 8, 5, true);
  const checksum = _bech32mCreateChecksum(hrp, data5bit);
  const combined = data5bit.concat(checksum);
  let out = hrp + '1';
  for (const v of combined) out += BECH32M_ALPHABET[v];
  return out;
}

function _bech32mDecode(addr) {
  const lower = addr.toLowerCase();
  const upper = addr.toUpperCase();
  if (lower !== addr && upper !== addr) throw new Error('mixed case');
  addr = lower;
  const sep = addr.lastIndexOf('1');
  if (sep < 1 || sep + 7 > addr.length) throw new Error('separator position invalid');
  const hrp = addr.slice(0, sep);
  const data5bit = [];
  for (let i = sep + 1; i < addr.length; i++) {
    const idx = BECH32M_ALPHABET.indexOf(addr[i]);
    if (idx === -1) throw new Error(`invalid char ${addr[i]}`);
    data5bit.push(idx);
  }
  if (!_bech32mVerifyChecksum(hrp, data5bit)) throw new Error('checksum');
  const payload5bit = data5bit.slice(0, data5bit.length - 6);
  const payloadBytes = new Uint8Array(_convertBits(payload5bit, 5, 8, false));
  return { hrp, payloadBytes };
}

// Encode a stealth-capable receiving address.
//   network: 'mainnet' | 'signet' | 'regtest'
//   recipientPub: 33-byte compressed secp256k1 pubkey (single-pubkey mode)
// Returns a bech32m string starting with the network's stealth HRP.
export function encodeStealthAddress({ network, recipientPub, scanPub, spendPub }) {
  const hrp = STEALTH_HRP[network];
  if (!hrp) throw new Error(`unknown network: ${network}`);
  const version = 0x00;
  let mode, payload;
  if (recipientPub && !scanPub && !spendPub) {
    if (!(recipientPub instanceof Uint8Array) || recipientPub.length !== 33) {
      throw new Error('recipientPub must be 33-byte compressed');
    }
    mode = 0x00;
    payload = recipientPub;
  } else if (scanPub && spendPub) {
    if (scanPub.length !== 33 || spendPub.length !== 33) {
      throw new Error('scanPub + spendPub must be 33-byte compressed each');
    }
    mode = 0x01;
    payload = concatBytes(scanPub, spendPub);
  } else {
    throw new Error('provide either {recipientPub} or {scanPub, spendPub}');
  }
  const dataBytes = concatBytes(new Uint8Array([version, mode]), payload);
  return _bech32mEncode(hrp, dataBytes);
}

// Decode a stealth-capable address.
// Returns { network, mode, recipientPub, scanPub?, spendPub? }.
// Throws on any malformation (no silent fallback).
export function decodeStealthAddress(addr) {
  const { hrp, payloadBytes } = _bech32mDecode(addr);
  let network;
  for (const [net, h] of Object.entries(STEALTH_HRP)) {
    if (hrp === h) { network = net; break; }
  }
  if (!network) throw new Error(`HRP ${hrp} is not a tacit stealth HRP`);
  if (payloadBytes.length < 2) throw new Error('payload too short');
  const version = payloadBytes[0];
  const mode    = payloadBytes[1];
  if (version !== 0x00) throw new Error(`unsupported version ${version}`);
  if (mode === 0x00) {
    if (payloadBytes.length !== 2 + 33) throw new Error('single-mode payload must be 33 bytes');
    const recipientPub = payloadBytes.slice(2, 35);
    // Sanity: must be a valid curve point
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
    } catch { throw new Error('scan/spend pubkey is not a valid secp256k1 point'); }
    return { network, mode: 'dual', scanPub, spendPub };
  } else {
    throw new Error(`unsupported mode ${mode}`);
  }
}

// =============================================================================
//                Blinded-pubkey commit derivation (§A normative)
// =============================================================================

const networkTagByte = (network) => {
  if (network === 'mainnet') return 0x00;
  if (network === 'signet')  return 0x01;
  if (network === 'regtest') return 0x02;
  throw new Error(`unknown network: ${network}`);
};

// Self-derived variant (§A.2 variant 1).
// blinding = HMAC(walletPriv, domain || network_tag || anchor) mod SECP_N
export function deriveSelfBlinding({ walletPriv, networkTag, domain, anchor }) {
  if (walletPriv.length !== 32) throw new Error('walletPriv must be 32 bytes');
  if (anchor.length === 0) throw new Error('anchor must be non-empty');
  const tagByte = typeof networkTag === 'number'
    ? new Uint8Array([networkTag & 0xff])
    : new Uint8Array([networkTagByte(networkTag) & 0xff]);
  const mac = hmac(sha256, walletPriv, concatBytes(domain, tagByte, anchor));
  let b = BigInt('0x' + bytesToHex(mac)) % SECP_N;
  if (b === 0n) throw new Error('blinding derived zero (statistically impossible)');
  return b;
}

// ECDH-derived variant (§A.2 variant 2).
// sharedPt = senderPriv · P_recipient = recipientPriv · P_sender
// shared   = SHA256(x_only(sharedPt))    // NORMATIVE per §A.2 — x-only,
//                                          matches existing dapp ECDH stack
// blinding = HMAC(shared, domain || network_tag || tx_anchor) mod SECP_N
export function deriveEcdhBlinding({ ourPriv, theirPub, networkTag, domain, txAnchor }) {
  if (ourPriv.length !== 32) throw new Error('ourPriv must be 32 bytes');
  if (theirPub.length !== 33) throw new Error('theirPub must be 33 bytes compressed');
  const ourPrivBig = BigInt('0x' + bytesToHex(ourPriv));
  const theirPt = secp.ProjectivePoint.fromHex(bytesToHex(theirPub));
  const sharedPt = theirPt.multiply(ourPrivBig);
  // x-only serialization (32 bytes, parity byte stripped) — NORMATIVE per
  // §A.2. Matches dapp/tacit.js amount-keystream derivation so a single
  // ECDH point drives both keystreams via domain separation.
  const sharedXonly = sharedPt.toRawBytes(true).slice(1);
  const shared = sha256(sharedXonly);
  const tagByte = typeof networkTag === 'number'
    ? new Uint8Array([networkTag & 0xff])
    : new Uint8Array([networkTagByte(networkTag) & 0xff]);
  const mac = hmac(sha256, shared, concatBytes(domain, tagByte, txAnchor));
  let b = BigInt('0x' + bytesToHex(mac)) % SECP_N;
  if (b === 0n) throw new Error('ECDH blinding derived zero (statistically impossible)');
  return b;
}

// Compute commit = P_underlying + blinding · G.
// Returns 33-byte compressed point.
export function computeCommit({ underlyingPub, blinding }) {
  if (underlyingPub.length !== 33) throw new Error('underlyingPub must be 33 bytes compressed');
  const Pt = secp.ProjectivePoint.fromHex(bytesToHex(underlyingPub));
  const commitPt = Pt.add(G.multiply(blinding));
  if (commitPt.equals(ZERO)) throw new Error('commit equals point at infinity');
  return commitPt.toRawBytes(true);
}

// Compute tweaked_sk = (sk_underlying + blinding) mod SECP_N.
// Returns 32-byte scalar.
export function computeTweakedSk({ underlyingPriv, blinding }) {
  if (underlyingPriv.length !== 32) throw new Error('underlyingPriv must be 32 bytes');
  const d = BigInt('0x' + bytesToHex(underlyingPriv));
  if (d <= 0n || d >= SECP_N) throw new Error('underlyingPriv scalar out of range');
  const tweaked = (d + blinding) % SECP_N;
  if (tweaked === 0n) throw new Error('tweaked secret derived zero (statistically impossible)');
  // Convert to 32-byte big-endian.
  let hex = tweaked.toString(16);
  while (hex.length < 64) hex = '0' + hex;
  return hexToBytes(hex);
}

// =============================================================================
//              Output script helpers + recipient marker detection
// =============================================================================

export function p2wpkhScript(pubkey) {
  return concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));
}

export function p2trScript(xOnly32) {
  if (xOnly32.length !== 32) throw new Error('xOnly32 must be 32 bytes');
  return concatBytes(new Uint8Array([0x51, 0x20]), xOnly32);
}

export function xOnly(compressedPub33) {
  return compressedPub33.slice(1);
}

// Returns true iff the output script matches the recipient-side derived
// commit under either P2WPKH or P2TR encoding. Used in the dual-scan loop.
export function matchesCommit({ outputScript, commit33 }) {
  const wpkh = p2wpkhScript(commit33);
  if (outputScript.length === wpkh.length &&
      outputScript.every((b, i) => b === wpkh[i])) {
    return { match: true, scriptKind: 'p2wpkh' };
  }
  const tr = p2trScript(xOnly(commit33));
  if (outputScript.length === tr.length &&
      outputScript.every((b, i) => b === tr[i])) {
    return { match: true, scriptKind: 'p2tr' };
  }
  return { match: false };
}

// =============================================================================
//             Sender-side input pubkey aggregation (§A.2.5 rule)
// =============================================================================

// For unit testing the aggregation rule, we accept a list of input descriptors:
//   [{ kind: 'p2wpkh' | 'p2tr-keypath' | 'tacit-envelope' | 'p2wsh' | 'p2tr-scriptpath',
//      pub: 33-byte compressed,  // present for eligible kinds
//   }, ...]
export function aggregateEligibleInputPubkeys(inputs) {
  let acc = ZERO;
  let eligibleCount = 0;
  for (const inp of inputs) {
    if (!isEligibleKind(inp.kind)) continue;
    if (!inp.pub || inp.pub.length !== 33) continue;
    const Pt = secp.ProjectivePoint.fromHex(bytesToHex(inp.pub));
    acc = acc.add(Pt);
    eligibleCount += 1;
  }
  if (eligibleCount === 0 || acc.equals(ZERO)) {
    return { aggregatePub: null, eligibleCount };
  }
  return { aggregatePub: acc.toRawBytes(true), eligibleCount };
}

export function isEligibleKind(kind) {
  // Per §A.2.5 eligibility rules:
  //   1. P2TR key-path                 ✓ eligible
  //   2. P2WPKH                        ✓ eligible
  //   3. tacit-envelope (commit-reveal P2TR script-path)  ✓ eligible
  //   4. P2WSH                         ✗ excluded
  //   5. P2TR script-path (non-keypath) ✗ excluded
  //   6. mixer-pool consumed           ✗ excluded
  return kind === 'p2wpkh' || kind === 'p2tr-keypath' || kind === 'tacit-envelope';
}

// §A.2.5 rule 6 NORMATIVE classifier (audit 2.2): an input is
// mixer-derived iff its prevout was emitted as the recipient marker
// UTXO of a confirmed mixer-emitting envelope (T_WITHDRAW, T_SLOT_BURN,
// and future additions per their class-1 amendments). Sender and
// recipient classify identically from chain data alone.
//
//   prevoutTx: the source tx of the input being classified (the tx
//     whose output the current tx is spending). Caller fetches it
//     from chain or local store.
//   prevoutVout: which output of prevoutTx is being spent.
//
// Returns true iff this input should be excluded from §A.2.5 aggregation.
//
// Implementation: parses the tacit envelope at prevoutTx's OP_RETURN
// (vout[0] per tacit convention) and checks the opcode byte.
export const MIXER_EMITTING_OPCODES = new Set([
  0x2A,  // T_WITHDRAW
  0x44,  // T_SLOT_BURN
  // Future class-1 amendments add entries here.
]);

export function isMixerDerivedInput({ prevoutTx, prevoutVout }) {
  if (!prevoutTx || !Array.isArray(prevoutTx.outputs) || prevoutTx.outputs.length === 0) {
    return false;
  }
  // The envelope opcode for tacit txs lives in the OP_RETURN at vout[0]
  // (per SPEC.md §5.5). Locate it.
  const vout0 = prevoutTx.outputs[0];
  if (!vout0 || !vout0.script || vout0.script.length === 0) return false;
  // OP_RETURN scripts start with 0x6a (OP_RETURN); the payload follows
  // as a single push. Locate the push and read its first byte = opcode.
  const script = vout0.script;
  if (script[0] !== 0x6a) return false;  // not OP_RETURN
  // Standard tacit envelope: OP_RETURN <push-length> <opcode> <...payload>
  // Push length is at script[1]; for <76 bytes, it's a direct byte length.
  // For larger, OP_PUSHDATA1 (0x4c) etc. — tacit envelopes typically fit
  // in the direct-length range for the opcode byte access.
  let opcodeIndex;
  if (script.length >= 3 && script[1] < 0x4c) opcodeIndex = 2;
  else if (script.length >= 4 && script[1] === 0x4c) opcodeIndex = 3;
  else return false;  // unrecognized push form
  if (opcodeIndex >= script.length) return false;
  const opcode = script[opcodeIndex];
  if (!MIXER_EMITTING_OPCODES.has(opcode)) return false;
  // Additional check: only the recipient marker outputs are mixer-derived.
  // For T_WITHDRAW per SPEC.md §5.11, the recipient marker is vout[0]'s
  // OP_RETURN-companion; for v1 we conservatively classify ALL outputs
  // of a mixer-emitting tx as mixer-derived, since the dust outputs at
  // any vout are protocol-emitted under the withdrawer's chosen recipient.
  // Future amendments may tighten this per opcode.
  return true;
}

// §F.7 NORMATIVE refusal rule (audit 2.1): an emitter MUST verify
// every eligible input is wallet-owned BEFORE emitting a class-2
// stealth output. Returns true iff emission is safe.
//
//   inputs: array of input descriptors per aggregateEligibleInputPubkeys
//   eachInputIsOurs(inp): predicate the caller supplies — returns true
//     iff that input is owned by the emitting wallet. Caller-side logic
//     because input ownership is wallet-state-dependent.
//
// Returns:
//   { safe: true,  reason: 'all eligible inputs wallet-owned' }
//   { safe: false, reason: '<diagnostic>' }
export function checkStealthEmissionSafety({ inputs, eachInputIsOurs }) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { safe: false, reason: 'no inputs' };
  }
  const eligible = inputs.filter(inp => isEligibleKind(inp.kind));
  if (eligible.length === 0) {
    return { safe: false, reason: 'no eligible inputs under §A.2.5' };
  }
  for (let i = 0; i < eligible.length; i++) {
    const inp = eligible[i];
    if (!eachInputIsOurs(inp)) {
      return {
        safe: false,
        reason: `eligible input #${i} (${inp.kind}) not wallet-owned — multi-owner stealth out of scope for v1`,
      };
    }
  }
  return { safe: true, reason: 'all eligible inputs wallet-owned' };
}

// =============================================================================
//            High-level helpers: sender-side and recipient-side
// =============================================================================

// Sender computes commit for a stealth payment.
//   senderInputPubs: ordered list of input descriptors for §A.2.5 aggregation
//   senderInputPrivs: ordered list of {kind, priv} matching senderInputPubs
//                     ONLY for the eligible inputs the sender controls; sum
//                     of their privs corresponds to the eligible aggregate
//                     pubkey (sender knows their own scalars).
//   recipientPub: from the recipient's stealth address payload (33 bytes)
//   txAnchorHead: 36-byte vin[0].outpoint bytes
//   voutIndex: 0-based output index
//   network: 'signet' | 'mainnet' | etc.
//   domain: per-opcode domain bytes (e.g., new TextEncoder().encode('tacit-cxfer-stealth-v1'))
export function senderComputeStealthCommit({
  senderEligibleInputPrivs, recipientPub, networkTag, domain, txAnchorHead, voutIndex,
}) {
  if (!Array.isArray(senderEligibleInputPrivs) || senderEligibleInputPrivs.length === 0) {
    throw new Error('senderEligibleInputPrivs must be non-empty array');
  }
  // Sum the sender's eligible-input privkeys (sk_sender aggregate).
  let skSum = 0n;
  for (const priv of senderEligibleInputPrivs) {
    if (priv.length !== 32) throw new Error('priv must be 32 bytes');
    const d = BigInt('0x' + bytesToHex(priv));
    if (d <= 0n || d >= SECP_N) throw new Error('priv scalar out of range');
    skSum = (skSum + d) % SECP_N;
  }
  if (skSum === 0n) throw new Error('senderEligibleInputPrivs sum to zero');
  // Convert to 32-byte big-endian
  let skHex = skSum.toString(16); while (skHex.length < 64) skHex = '0' + skHex;
  const skSumBytes = hexToBytes(skHex);

  // ECDH-derived blinding (anchor includes vout_index per §C registry)
  const txAnchor = concatBytes(txAnchorHead, _u32le(voutIndex));
  const b = deriveEcdhBlinding({
    ourPriv: skSumBytes, theirPub: recipientPub,
    networkTag, domain, txAnchor,
  });

  // commit = P_recipient + b·G
  const commit = computeCommit({ underlyingPub: recipientPub, blinding: b });
  return { commit, blinding: b };
}

// Recipient checks whether a given output is paying it via stealth.
// Returns { match: true, scriptKind, tweakedSk } on hit; { match: false } on miss.
export function recipientCheckOutputForStealth({
  walletPriv, walletPub, senderAggregatePub, networkTag, domain,
  txAnchorHead, voutIndex, outputScript,
}) {
  // Compute b via symmetric ECDH (recipient_priv · sender_aggregate_pub).
  const txAnchor = concatBytes(txAnchorHead, _u32le(voutIndex));
  const b = deriveEcdhBlinding({
    ourPriv: walletPriv, theirPub: senderAggregatePub,
    networkTag, domain, txAnchor,
  });
  const commit = computeCommit({ underlyingPub: walletPub, blinding: b });
  const res = matchesCommit({ outputScript, commit33: commit });
  if (!res.match) return { match: false };
  const tweakedSk = computeTweakedSk({ underlyingPriv: walletPriv, blinding: b });
  return { match: true, scriptKind: res.scriptKind, tweakedSk, blinding: b, commit };
}

// Walk every output of a tx; return list of stealth-credit descriptors.
//   tx: { inputs: [{kind, pub}], outputs: [{script}], }
//   walletPriv / walletPub: receiver's wallet
//   domain: opcode-specific domain bytes
//   networkTag: byte or name
//   txAnchorHead: bytes (36 if vin[0].outpoint, or any opcode-specific head)
export function recipientScanTxForStealth({
  tx, walletPriv, walletPub, networkTag, domain, txAnchorHead,
}) {
  const { aggregatePub } = aggregateEligibleInputPubkeys(tx.inputs);
  if (!aggregatePub) return [];
  const credits = [];
  for (let v = 0; v < tx.outputs.length; v++) {
    const r = recipientCheckOutputForStealth({
      walletPriv, walletPub, senderAggregatePub: aggregatePub,
      networkTag, domain, txAnchorHead, voutIndex: v,
      outputScript: tx.outputs[v].script,
    });
    if (r.match) {
      credits.push({
        voutIndex: v,
        scriptKind: r.scriptKind,
        tweakedSk: r.tweakedSk,
        blinding: r.blinding,
        commit: r.commit,
        senderAggregatePub: aggregatePub,
      });
    }
  }
  return credits;
}

// =============================================================================
//                              Utilities
// =============================================================================

function _u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

// Convenience: canonical domain tag for CXFER stealth recipient marker.
export const DOMAIN_CXFER_STEALTH = new TextEncoder().encode('tacit-cxfer-stealth-v1');
export const DOMAIN_AXFER_STEALTH = new TextEncoder().encode('tacit-axfer-stealth-v1');
export const DOMAIN_AXFER_VAR_STEALTH = new TextEncoder().encode('tacit-axfer-var-stealth-v1');
