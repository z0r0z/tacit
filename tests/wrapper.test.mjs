// Tacit wrapper convention (SPEC §4.2 / §5.19) — worker-side correctness.
//
// Pins down:
//   - T_WRAPPER_ATTEST envelope wire format (159 bytes, no envelope_version)
//   - attestation_msg byte-level construction per §4.2.4
//   - BIP-340 sig verify with a known keypair (round-trip sign + decode + verify)
//   - parseTacitWrapper validation: valid → struct, malformed → null
//   - extractIpfsCid: ipfs:// URIs → CID; non-IPFS → null
//   - networkTagFor: signet/mainnet/regtest mapping
//
// Run: `node wrapper.test.mjs`

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

import {
  T_WRAPPER_ATTEST,
  decodeWrapperAttestPayload,
  wrapperAttestationMsg,
  parseTacitWrapper,
  extractIpfsCid,
  networkTagFor,
  verifySchnorr,
} from '../worker/src/index.js';
import { signSchnorr } from './composition.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const u8 = (...nums) => new Uint8Array(nums);

// Fixture-generation helper: encode a T_WRAPPER_ATTEST envelope.
function encodeWrapperAttest({ networkTag, assetId, issuerPubkey, reserves, supply, asOfHeight, timestamp, sig }) {
  const buf = new Uint8Array(1 + 1 + 32 + 33 + 8 + 8 + 4 + 8 + 64);
  let p = 0;
  buf[p] = T_WRAPPER_ATTEST; p += 1;
  buf[p] = networkTag & 0xff; p += 1;
  buf.set(hexToBytes(assetId), p); p += 32;
  buf.set(hexToBytes(issuerPubkey), p); p += 33;
  const view = new DataView(buf.buffer);
  const r = BigInt(reserves);
  view.setUint32(p, Number(r & 0xffffffffn), true);
  view.setUint32(p + 4, Number((r >> 32n) & 0xffffffffn), true);
  p += 8;
  const s = BigInt(supply);
  view.setUint32(p, Number(s & 0xffffffffn), true);
  view.setUint32(p + 4, Number((s >> 32n) & 0xffffffffn), true);
  p += 8;
  view.setUint32(p, asOfHeight >>> 0, true); p += 4;
  const t = BigInt(timestamp);
  view.setUint32(p, Number(t & 0xffffffffn), true);
  view.setUint32(p + 4, Number((t >> 32n) & 0xffffffffn), true);
  p += 8;
  buf.set(hexToBytes(sig), p); p += 64;
  return buf;
}

console.log('Wrapper convention (SPEC §4.2 / §5.19):');

// =============================================================================
// Wire format
// =============================================================================

test('T_WRAPPER_ATTEST opcode is 0x38', () => {
  return T_WRAPPER_ATTEST === 0x38;
});

test('wire format = 159 bytes (no envelope_version on the wire)', () => {
  const payload = encodeWrapperAttest({
    networkTag: 0x01,
    assetId: 'a'.repeat(64),
    issuerPubkey: '02' + 'b'.repeat(64),
    reserves: '1000000000',
    supply: '999000000',
    asOfHeight: 850000,
    timestamp: '1700000000',
    sig: 'c'.repeat(128),
  });
  return payload.length === 159 && payload[0] === T_WRAPPER_ATTEST;
});

test('decoder round-trips a valid envelope', () => {
  const payload = encodeWrapperAttest({
    networkTag: 0x01,
    assetId: '11'.repeat(32),
    issuerPubkey: '02' + '22'.repeat(32),
    reserves: '42',
    supply: '41',
    asOfHeight: 12345,
    timestamp: '1700000123',
    sig: '00'.repeat(64),
  });
  const decoded = decodeWrapperAttestPayload(payload);
  return decoded
    && decoded.network_tag === 0x01
    && decoded.asset_id === '11'.repeat(32)
    && decoded.issuer_pubkey === '02' + '22'.repeat(32)
    && decoded.reserves === '42'
    && decoded.supply === '41'
    && decoded.as_of_height === 12345
    && decoded.timestamp === '1700000123'
    && decoded.attestation_sig === '00'.repeat(64);
});

test('decoder rejects wrong opcode', () => {
  const payload = encodeWrapperAttest({
    networkTag: 0x00, assetId: 'a'.repeat(64), issuerPubkey: '02' + 'b'.repeat(64),
    reserves: '0', supply: '0', asOfHeight: 0, timestamp: '0', sig: '0'.repeat(128),
  });
  payload[0] = 0x37;  // T_AXFER_VAR opcode
  return decodeWrapperAttestPayload(payload) === null;
});

test('decoder rejects wrong length', () => {
  return decodeWrapperAttestPayload(new Uint8Array(158)) === null
      && decodeWrapperAttestPayload(new Uint8Array(160)) === null;
});

test('decoder rejects network_tag > 0x02', () => {
  const payload = encodeWrapperAttest({
    networkTag: 0x03, assetId: 'a'.repeat(64), issuerPubkey: '02' + 'b'.repeat(64),
    reserves: '0', supply: '0', asOfHeight: 0, timestamp: '0', sig: '0'.repeat(128),
  });
  return decodeWrapperAttestPayload(payload) === null;
});

test('decoder rejects malformed issuer_pubkey (not 0x02/0x03 prefix)', () => {
  const payload = encodeWrapperAttest({
    networkTag: 0x01, assetId: 'a'.repeat(64), issuerPubkey: '04' + 'b'.repeat(64),
    reserves: '0', supply: '0', asOfHeight: 0, timestamp: '0', sig: '0'.repeat(128),
  });
  return decodeWrapperAttestPayload(payload) === null;
});

test('decoder accepts max u64 reserves + supply (boundary)', () => {
  const payload = encodeWrapperAttest({
    networkTag: 0x00,
    assetId: 'f'.repeat(64),
    issuerPubkey: '02' + 'f'.repeat(64),
    reserves: '18446744073709551615',  // 2^64 - 1
    supply: '18446744073709551615',
    asOfHeight: 0xffffffff,
    timestamp: '18446744073709551615',
    sig: 'a'.repeat(128),
  });
  const d = decodeWrapperAttestPayload(payload);
  return d && d.reserves === '18446744073709551615' && d.supply === '18446744073709551615'
      && d.as_of_height === 0xffffffff && d.timestamp === '18446744073709551615';
});

// =============================================================================
// attestation_msg construction (SPEC §4.2.4)
// =============================================================================

test('attestation_msg is SHA256 of canonical preimage', () => {
  const msg = wrapperAttestationMsg(
    0x01,
    'ab'.repeat(32),
    '02' + 'cd'.repeat(32),
    '1000',
    '900',
    100,
    '1700000000',
  );
  // Recompute independently per SPEC §4.2.4:
  //   SHA256("tacit-wrapper-attest-v1" || network_tag(1) || asset_id(32)
  //          || issuer_pubkey(33) || reserves_LE(8) || supply_LE(8)
  //          || as_of_height_LE(4) || timestamp_LE(8))
  const tag = new TextEncoder().encode('tacit-wrapper-attest-v1');
  const preimage = new Uint8Array(1 + 32 + 33 + 8 + 8 + 4 + 8);
  let p = 0;
  preimage[p] = 0x01; p += 1;
  preimage.set(hexToBytes('ab'.repeat(32)), p); p += 32;
  preimage.set(hexToBytes('02' + 'cd'.repeat(32)), p); p += 33;
  const view = new DataView(preimage.buffer);
  view.setUint32(p, 1000, true); view.setUint32(p + 4, 0, true); p += 8;
  view.setUint32(p, 900, true); view.setUint32(p + 4, 0, true); p += 8;
  view.setUint32(p, 100, true); p += 4;
  view.setUint32(p, 1700000000, true); view.setUint32(p + 4, 0, true); p += 8;
  const expected = sha256(concatBytes(tag, preimage));
  for (let i = 0; i < 32; i++) if (msg[i] !== expected[i]) return false;
  return true;
});

test('attestation_msg differs when network_tag changes', () => {
  const a = wrapperAttestationMsg(0x00, 'aa'.repeat(32), '02' + 'bb'.repeat(32), '0', '0', 0, '0');
  const b = wrapperAttestationMsg(0x01, 'aa'.repeat(32), '02' + 'bb'.repeat(32), '0', '0', 0, '0');
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return true;
  return false;
});

// =============================================================================
// BIP-340 round-trip sign + verify
// =============================================================================

test('BIP-340 sign + decode + verify round-trip', () => {
  // Deterministic test keypair.
  const privHex = '0101010101010101010101010101010101010101010101010101010101010101';
  const priv = hexToBytes(privHex);
  const pubXOnly = secp.getPublicKey(priv, true).slice(1);   // 32 bytes, x-only
  const pubCompressed = '02' + bytesToHex(pubXOnly);

  const networkTag = 0x01;
  const assetId = 'de'.repeat(32);
  const reserves = '5000';
  const supply = '4900';
  const asOfHeight = 200000;
  const timestamp = '1700000999';

  const msg = wrapperAttestationMsg(networkTag, assetId, pubCompressed, reserves, supply, asOfHeight, timestamp);
  const sig = signSchnorr(msg, priv);
  const sigHex = bytesToHex(sig);

  const payload = encodeWrapperAttest({
    networkTag, assetId, issuerPubkey: pubCompressed, reserves, supply, asOfHeight, timestamp, sig: sigHex,
  });
  const decoded = decodeWrapperAttestPayload(payload);
  if (!decoded) return false;

  // Recompute msg from the decoded fields — should be byte-identical.
  const msg2 = wrapperAttestationMsg(
    decoded.network_tag, decoded.asset_id, decoded.issuer_pubkey,
    decoded.reserves, decoded.supply, decoded.as_of_height, decoded.timestamp,
  );
  for (let i = 0; i < 32; i++) if (msg[i] !== msg2[i]) return false;

  // Verify the sig under the x-only form of the decoded issuer_pubkey.
  const issuerXOnly = hexToBytes(decoded.issuer_pubkey).slice(1);
  return verifySchnorr(hexToBytes(decoded.attestation_sig), msg2, issuerXOnly);
});

// =============================================================================
// networkTagFor
// =============================================================================

test('networkTagFor maps signet/mainnet/regtest', () => {
  return networkTagFor('mainnet') === 0x00
      && networkTagFor('signet')  === 0x01
      && networkTagFor('regtest') === 0x02
      && networkTagFor('garbage') === null;
});

// =============================================================================
// extractIpfsCid
// =============================================================================

test('extractIpfsCid accepts ipfs:// CID', () => {
  const cid = extractIpfsCid('ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy');
  return cid === 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
});

test('extractIpfsCid accepts ipfs:// CID with trailing path', () => {
  return extractIpfsCid('ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy/metadata.json')
    === 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
});

test('extractIpfsCid rejects HTTPS URLs', () => {
  return extractIpfsCid('https://example.com/foo.json') === null;
});

test('extractIpfsCid rejects bare CID without ipfs:// scheme', () => {
  return extractIpfsCid('bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy') === null;
});

test('extractIpfsCid rejects non-string input', () => {
  return extractIpfsCid(null) === null
      && extractIpfsCid(undefined) === null
      && extractIpfsCid(42) === null;
});

// =============================================================================
// parseTacitWrapper
// =============================================================================

const validFixedWrapper = {
  ticker: 'cBTC',
  decimals: 8,
  tacit_wrapper: {
    version: 1,
    underlying: { chain: 'bitcoin', asset: 'native', unit: 'satoshi' },
    peg: { numerator: 1, denominator: 1, kind: 'fixed' },
    custody: {
      kind: 'multisig',
      reserve_address: 'bc1pexample',
      threshold_k: 3,
      threshold_n: 5,
    },
    redemption: { fee_bps: 10, min_request_units: 1000 },
    attestation: { issuer_pubkey: '02' + 'ab'.repeat(32), schedule_blocks: 144 },
  },
};

test('parseTacitWrapper accepts canonical fixed-peg multisig wrapper', () => {
  const r = parseTacitWrapper(validFixedWrapper);
  return r && r.version === 1
    && r.underlying.chain === 'bitcoin'
    && r.peg.kind === 'fixed' && r.peg.numerator === 1
    && r.custody.kind === 'multisig' && r.custody.threshold_k === 3
    && r.redemption.fee_bps === 10
    && r.attestation.schedule_blocks === 144;
});

test('parseTacitWrapper rejects metadata without tacit_wrapper field', () => {
  return parseTacitWrapper({ ticker: 'PLAIN', decimals: 8 }) === null;
});

test('parseTacitWrapper rejects unknown version (forward-compat)', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.version = 2;
  return parseTacitWrapper(meta) === null;
});

test('parseTacitWrapper rejects peg.numerator = 0', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.peg.numerator = 0;
  return parseTacitWrapper(meta) === null;
});

test('parseTacitWrapper rejects unknown peg.kind', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.peg.kind = 'algorithmic';
  return parseTacitWrapper(meta) === null;
});

test('parseTacitWrapper rejects unknown custody.kind', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.custody.kind = 'sidechain';
  return parseTacitWrapper(meta) === null;
});

test('parseTacitWrapper rejects fee_bps > 10000', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.redemption.fee_bps = 10001;
  return parseTacitWrapper(meta) === null;
});

test('parseTacitWrapper rejects malformed issuer_pubkey', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.attestation.issuer_pubkey = 'not-a-pubkey';
  return parseTacitWrapper(meta) === null;
});

test('parseTacitWrapper accepts oracle_priced peg', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.peg = { numerator: 1, denominator: 1, kind: 'oracle_priced' };
  meta.tacit_wrapper.custody.kind = 'user_dlc';
  const r = parseTacitWrapper(meta);
  return r && r.peg.kind === 'oracle_priced' && r.custody.kind === 'user_dlc';
});

test('parseTacitWrapper accepts burn-kind custody without reserve_address', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.custody = { kind: 'burn' };
  const r = parseTacitWrapper(meta);
  return r && r.custody.kind === 'burn' && r.custody.reserve_address === null;
});

test('parseTacitWrapper rejects negative schedule_blocks', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.attestation.schedule_blocks = -1;
  return parseTacitWrapper(meta) === null;
});

test('parseTacitWrapper accepts schedule_blocks = 0 (on_demand)', () => {
  const meta = JSON.parse(JSON.stringify(validFixedWrapper));
  meta.tacit_wrapper.attestation.schedule_blocks = 0;
  const r = parseTacitWrapper(meta);
  return r && r.attestation.schedule_blocks === 0;
});

// =============================================================================
// Summary
// =============================================================================

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
