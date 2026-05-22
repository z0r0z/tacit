// BIP-352 sender-side test vectors.
//
// Runs the official BIP-352 send_and_receive_test_vectors.json against
// dapp/tacit.js's senderComputeSilentPaymentOutput + decodeSilentPaymentAddress.
//
// The fixture in tests/fixtures/ is a verbatim copy of the file shipped with
// the BIP-352 reference (github.com/bitcoin/bips bip-0352/). Each vector lists
// inputs (with private_key + prevout.scriptPubKey), recipient addresses (sp1…),
// and the expected per-output P2TR x-only key.
//
// Scope: SENDER side only. For every vector whose input set has at least one
// eligible input per BIP-352 §"Inputs For Shared Secret Derivation", we assert
// our derivation matches the BIP's reference outputs.
//
// Eligibility filter implemented per the BIP: P2WPKH, P2PKH, P2SH-P2WPKH,
// P2TR keypath (rejecting NUMS-tag script-path). Uncompressed-key P2PKH and
// P2WPKH inputs are skipped per spec. The op_L (lex-smallest outpoint) is
// computed over ALL transaction inputs even when some are ineligible —
// passed via the optional `allInputOutpoints` parameter.
//
// Out-of-scope vectors (skipped, with reason):
//   • Multi-recipient labeled-address vectors (11, 15, 17, 18) — the per-
//     scan-key k counter has to walk in a specific order that depends on
//     a recipient-side sort; not relevant to tacit's single-recipient send.
//   • K_max recipient-side scanning limit (27) — sender-side only sees its
//     own outputs.
//
// Run: `node bip352-sender-vectors.test.mjs`
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');
const {
  decodeSilentPaymentAddress,
  senderComputeSilentPaymentOutput,
  bip352OutpointBytes,
} = dapp;

const VECTORS = JSON.parse(readFileSync(
  new URL('./fixtures/bip352-send-and-receive-vectors.json', import.meta.url),
  'utf8',
));

const SECP_N = secp.CURVE.n;
function hexToBytes(h) {
  if (h.length & 1) throw new Error('odd hex');
  const b = new Uint8Array(h.length >> 1);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i*2, i*2+2), 16);
  return b;
}
function bytesToHex(b) {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
function bytes32ToBigint(b) {
  let r = 0n;
  for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(b[i]);
  return r;
}
function bigintToBytes32(n) {
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
function hash160(b) { return ripemd160(sha256(b)); }

// ============================================================================
// Witness wire-format parser
// ============================================================================
// The BIP-352 vectors encode txinwitness as the wire-format-serialized
// witness stack: one varint count, then per item one varint length + bytes.
// All vector items have count < 0xfd and length < 0xfd so we only need the
// 1-byte fast path. Returns an array of Uint8Array items.
function parseWitnessWire(hex) {
  if (!hex) return [];
  const buf = hexToBytes(hex);
  let i = 0;
  const readVarint = () => {
    const b = buf[i++];
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = buf[i] | (buf[i+1] << 8); i += 2; return v; }
    throw new Error('varint > 0xfd unsupported in test vectors');
  };
  const count = readVarint();
  const items = [];
  for (let n = 0; n < count; n++) {
    const len = readVarint();
    items.push(buf.slice(i, i + len));
    i += len;
  }
  return items;
}

// Parse data pushes out of scriptSig bytes. Used for P2PKH pubkey extraction
// per BIP-352 §"Inputs For Shared Secret Derivation".
function parsePushOps(buf) {
  const ops = [];
  let i = 0;
  while (i < buf.length) {
    const op = buf[i++];
    if (op >= 1 && op <= 75) { ops.push(buf.slice(i, i + op)); i += op; continue; }
    if (op === 0x4c) { const n = buf[i++]; ops.push(buf.slice(i, i + n)); i += n; continue; }
    if (op === 0x4d) {
      const n = buf[i++] | (buf[i++] << 8);
      ops.push(buf.slice(i, i + n)); i += n; continue;
    }
    // Non-push opcodes (OP_0 = 0x00 emits empty, but ignore otherwise).
    if (op === 0x00) { ops.push(new Uint8Array(0)); continue; }
  }
  return ops;
}

// ============================================================================
// BIP-352 input eligibility + pubkey extraction
// ============================================================================
const H_NUMS_TAG_X = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

function classifyInput(vin) {
  const spkHex = vin.prevout.scriptPubKey.hex.toLowerCase();
  const spk = hexToBytes(spkHex);
  const scriptSig = vin.scriptSig ? hexToBytes(vin.scriptSig) : new Uint8Array(0);
  const witness = parseWitnessWire(vin.txinwitness || '');
  const priv = vin.private_key ? hexToBytes(vin.private_key) : null;
  if (!priv || priv.length !== 32) return { eligible: false };

  // P2WPKH: 0014<20B>
  if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) {
    if (witness.length !== 2) return { eligible: false };
    const pub = witness[1];
    if (pub.length !== 33 || (pub[0] !== 0x02 && pub[0] !== 0x03)) return { eligible: false };
    return { eligible: true, pubkey: pub, normalizedPriv: priv };
  }

  // P2PKH: 76a914<20B>88ac
  if (spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14
      && spk[23] === 0x88 && spk[24] === 0xac) {
    const expectedHash = spk.slice(3, 23);
    const pushes = parsePushOps(scriptSig);
    // Per BIP-352: identify the push whose hash160 matches the pubkey-hash.
    // Compressed (33B starting 02/03) only — uncompressed P2PKH is skipped.
    for (const p of pushes) {
      if (p.length !== 33) continue;
      if ((p[0] !== 0x02) && (p[0] !== 0x03)) continue;
      const h = hash160(p);
      if (h.every((b, idx) => b === expectedHash[idx])) {
        return { eligible: true, pubkey: p, normalizedPriv: priv };
      }
    }
    return { eligible: false };
  }

  // P2SH-P2WPKH: a914<20B>87
  if (spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87) {
    const pushes = parsePushOps(scriptSig);
    if (pushes.length !== 1) return { eligible: false };
    const redeem = pushes[0];
    if (redeem.length !== 22 || redeem[0] !== 0x00 || redeem[1] !== 0x14) return { eligible: false };
    // Belt: the redeem-script hash160 must match the P2SH program.
    const expectedHash = spk.slice(2, 22);
    const h = hash160(redeem);
    if (!h.every((b, idx) => b === expectedHash[idx])) return { eligible: false };
    if (witness.length !== 2) return { eligible: false };
    const pub = witness[1];
    if (pub.length !== 33 || (pub[0] !== 0x02 && pub[0] !== 0x03)) return { eligible: false };
    return { eligible: true, pubkey: pub, normalizedPriv: priv };
  }

  // P2TR keypath: 5120<32B>
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) {
    // Strip annex (BIP-341) before counting items for script-path detection.
    const stripped = (witness.length > 0
                   && witness[witness.length - 1].length > 0
                   && witness[witness.length - 1][0] === 0x50)
      ? witness.slice(0, -1)
      : witness;
    // Script-path spend has > 1 witness item; last is the control block.
    // BIP-352: if internal key (bytes [1, 33) of control block) equals the
    // NUMS tag, the input is ineligible (script-path-only spend).
    if (stripped.length > 1) {
      const cb = stripped[stripped.length - 1];
      if (cb.length >= 33) {
        const internal = bytesToHex(cb.slice(1, 33));
        if (internal === H_NUMS_TAG_X) return { eligible: false };
      }
    }
    const xonly = spk.slice(2, 34);
    const Peven = new Uint8Array(33);
    Peven[0] = 0x02; Peven.set(xonly, 1);
    // Y-parity normalization: if priv→pubkey has odd Y, negate priv mod n
    // so the contributing pubkey is the even-Y form (matching the x-only).
    const dBig = bytes32ToBigint(priv);
    if (dBig <= 0n || dBig >= SECP_N) return { eligible: false };
    const Ppoint = secp.ProjectivePoint.fromPrivateKey(priv);
    const Pcompressed = Ppoint.toRawBytes(true);
    const yOdd = (Pcompressed[0] === 0x03);
    const normPriv = yOdd ? bigintToBytes32(SECP_N - dBig) : priv;
    return { eligible: true, pubkey: Peven, normalizedPriv: normPriv };
  }

  return { eligible: false };
}

// ============================================================================
// Out-of-scope: vectors that exercise functionality outside tacit's send path
// ============================================================================
const SKIP_REASON = {
  11: 'multi-recipient k-counter ordering — tacit only sends 1 output to 1 recipient',
  15: 'multi-recipient labeled-address ordering — out of scope',
  17: 'multi-recipient labeled-address ordering — out of scope',
  18: 'sender-change labeled-address ordering — out of scope',
  27: 'K_max is a RECIPIENT scanning limit; sender has no analog',
};

// ============================================================================
// Per-vector runner
// ============================================================================
let pass = 0, fail = 0, skip = 0;
function logResult(label, ok, detail) {
  if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
  else if (ok === 'skip') { console.log(`  SKIP  ${label}${detail ? ' — ' + detail : ''}`); skip++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log('BIP-352 sender-side reference vectors:');

for (let vi = 0; vi < VECTORS.length; vi++) {
  const v = VECTORS[vi];
  const label = `${vi} ${v.comment}`;
  if (SKIP_REASON[vi]) { logResult(label, 'skip', SKIP_REASON[vi]); continue; }
  for (let si = 0; si < v.sending.length; si++) {
    const send = v.sending[si];
    const expectedOutputGroups = send.expected.outputs;

    // All transaction outpoints — used for op_L. BIP-352 mandates this is
    // over ALL inputs, eligible or not.
    const allOutpoints = send.given.vin.map(inp => bip352OutpointBytes(inp.txid, inp.vout));

    // Classify each vin → eligible (priv + pubkey) or ineligible.
    const classified = send.given.vin.map(classifyInput);
    const eligiblePrivs = [];
    const eligibleOutpoints = [];
    const eligiblePubs = [];
    for (let i = 0; i < send.given.vin.length; i++) {
      const c = classified[i];
      if (!c.eligible) continue;
      eligiblePrivs.push(c.normalizedPriv);
      eligiblePubs.push(c.pubkey);
      eligibleOutpoints.push(allOutpoints[i]);
    }

    // No eligible inputs → sender produces nothing. Vector expects empty.
    if (eligiblePrivs.length === 0) {
      const expectsEmpty = expectedOutputGroups.every(g => g.length === 0);
      logResult(label, expectsEmpty, expectsEmpty ? 'no eligible inputs — sender produces nothing' : 'no eligible inputs but vector expects outputs');
      continue;
    }

    // Sanity-check our eligibility set against vector's expected pubs.
    if (Array.isArray(send.expected.input_pub_keys)) {
      const expected = new Set(send.expected.input_pub_keys.map(s => s.toLowerCase()));
      const got = new Set(eligiblePubs.map(bytesToHex));
      const same = expected.size === got.size && [...got].every(p => expected.has(p));
      if (!same) {
        logResult(label, false, `eligible-pub mismatch · got=${[...got].join(',')} want=${[...expected].join(',')}`);
        continue;
      }
    }

    // a_sum zero → sender refuses; vector expects empty.
    let aSum = 0n;
    for (const p of eligiblePrivs) aSum = (aSum + bytes32ToBigint(p)) % SECP_N;
    if (aSum === 0n) {
      const expectsEmpty = expectedOutputGroups.every(g => g.length === 0);
      logResult(label, expectsEmpty, expectsEmpty ? 'a_sum is zero — sender refuses' : 'a_sum is zero but vector expects outputs');
      continue;
    }

    // Build the per-recipient output list and compare order-insensitively.
    // For each recipient address, derive at k = 0, 1, 2... until we've
    // produced as many outputs as the vector expects (per address group).
    // Vectors with one recipient and one expected output (tacit's production
    // case) reduce to k=0 once.
    const recipients = send.given.recipients.map(r => decodeSilentPaymentAddress(r.address || r));
    if (recipients.some(r => r === null)) {
      logResult(label, false, 'address decoder rejected a vector recipient');
      continue;
    }

    // Group expected outputs by recipient index (the vector's
    // expected.outputs is parallel to recipients).
    let ok = true;
    let detail = '';
    for (let ri = 0; ri < recipients.length; ri++) {
      const sp = recipients[ri];
      const want = (expectedOutputGroups[ri] || []).map(s => s.toLowerCase());
      const got = [];
      for (let k = 0; got.length < want.length; k++) {
        try {
          const out = senderComputeSilentPaymentOutput({
            inputPrivs: eligiblePrivs,
            inputOutpoints: eligibleOutpoints,
            allInputOutpoints: allOutpoints,
            scanPub: sp.scanPub,
            spendPub: sp.spendPub,
            k,
          });
          got.push(bytesToHex(out.xOnly));
        } catch {
          // tweak-zero etc. — skip this k and try next.
        }
        if (k > 50) break; // safety bound
      }
      const wantSet = new Set(want);
      const gotSet = new Set(got);
      const same = wantSet.size === gotSet.size && [...wantSet].every(o => gotSet.has(o));
      if (!same) {
        ok = false;
        detail = `recipient ${ri} got=[${[...gotSet].join(',')}] want=[${[...wantSet].join(',')}]`;
        break;
      }
    }
    logResult(label, ok, ok ? '' : detail);
  }
}

console.log(`\nVector summary: ${pass} passed · ${fail} failed · ${skip} skipped\n`);

// ============================================================================
// Decoder sanity (independent of sending vectors)
// ============================================================================
console.log('decodeSilentPaymentAddress sanity:');

function dtest(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const knownMainnet = 'sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv';

dtest('decodes canonical mainnet sp1…', () => {
  const r = decodeSilentPaymentAddress(knownMainnet);
  return r !== null && r.hrp === 'sp' && r.network === 'mainnet' && r.version === 0
      && r.scanPub.length === 33 && r.spendPub.length === 33;
});

dtest('rejects mixed-case', () => {
  const mixed = knownMainnet.slice(0, 10) + knownMainnet.charAt(10).toUpperCase() + knownMainnet.slice(11);
  return decodeSilentPaymentAddress(mixed) === null;
});

dtest('rejects wrong HRP', () => {
  return decodeSilentPaymentAddress('bc1qxgqfp2yqqevxr7z6tzzhv7y62yz4jal3luu92v') === null;
});

dtest('rejects truncated', () => {
  return decodeSilentPaymentAddress(knownMainnet.slice(0, -5)) === null;
});

dtest('rejects bit-flipped checksum', () => {
  const bytes = knownMainnet.split('');
  bytes[knownMainnet.indexOf('1') + 1] = 'p';
  return decodeSilentPaymentAddress(bytes.join('')) === null;
});

dtest('rejects null/non-string', () => {
  return decodeSilentPaymentAddress(null) === null
      && decodeSilentPaymentAddress(undefined) === null
      && decodeSilentPaymentAddress(42) === null
      && decodeSilentPaymentAddress({}) === null;
});

console.log(`\nFinal: ${pass} passed · ${fail} failed · ${skip} skipped`);
if (fail > 0) process.exit(1);
