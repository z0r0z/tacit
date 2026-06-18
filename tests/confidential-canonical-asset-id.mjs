#!/usr/bin/env node
// Cross-language derivation of the canonical EVM-etch asset id, matching
// CanonicalAssetFactory.sol (deriveAssetId / metaHash) and the spec amendment
// (SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT §"Asset identity"). Locks the byte layout so
// the asset id — and the (symbol, decimals) bound into it — is identical on Bitcoin, JS,
// Solidity. The ERC20 `name` is the constant brand "Tacit Token" and is NOT part of the
// commitment; the only per-asset metadata is (symbol, decimals), deterministic to the
// real asset.
//
//   meta_hash = sha256( u8(len symbol) ‖ symbol ‖ u8(decimals) ‖ cid )
//   asset_id  = sha256( "tacit-evm-etch-v1" ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ meta_hash )
//
// `cid` (32 bytes, 0 = none) is the asset's IPFS metadata content hash (logo/description JSON),
// bound into the id like (symbol, decimals) so its on-chain contractURI is trustless.
//
// Run: node tests/confidential-canonical-asset-id.mjs

import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const sha256 = (b) => createHash('sha256').update(b).digest();
const u8 = (n) => Buffer.from([n]);
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const ZERO32 = Buffer.alloc(32);
const asBytes32 = (x) => (x == null ? ZERO32 : Buffer.isBuffer(x) ? x : Buffer.from(String(x).replace(/^0x/, '').padStart(64, '0'), 'hex'));

export function metaHash(symbol, decimals, cid) {
  const s = Buffer.from(symbol, 'utf8');
  if (s.length > 255) throw new Error('label too long');
  return sha256(Buffer.concat([u8(s.length), s, u8(decimals), asBytes32(cid)]));
}

export function deriveAssetId({ chainId, factory, salt, etcher, symbol, decimals, cid }) {
  const tag = Buffer.from('tacit-evm-etch-v1', 'utf8');
  const chainBe8 = Buffer.alloc(8); chainBe8.writeBigUInt64BE(BigInt(chainId));
  const addr = (a) => Buffer.from(a.replace(/^0x/, ''), 'hex'); // 20 bytes
  const b32 = (x) => Buffer.from(x.replace(/^0x/, '').padStart(64, '0'), 'hex'); // 32 bytes
  return sha256(Buffer.concat([
    tag, chainBe8, addr(factory), b32(salt), addr(etcher), metaHash(symbol, decimals, cid),
  ]));
}

// The metadata cid is the CIDv1 *raw* (codec 0x55) sha2-256 hash of the metadata JSON, which
// for the raw codec is exactly sha256(jsonBytes) — recomputable from the JSON with no IPFS
// encoder. This is the cid that gets etched (EVM: into meta_hash → asset_id; Bitcoin: into the
// reveal envelope's [cid(32)]).
export function metadataCid(jsonBytes) {
  return sha256(Buffer.isBuffer(jsonBytes) ? jsonBytes : Buffer.from(jsonBytes, 'utf8'));
}

// contractURI reconstruction — must equal CanonicalBridgedERC20.contractURI() (EIP-7572):
// the metadata cid surfaced as a CIDv1 base16 string (multibase 'f'):
//   01(v1) ‖ 55(raw) ‖ 12(sha2-256) ‖ 20(len 32) ‖ hex(cid).  cid=0 ⇒ empty.
export function contractURI(cid) {
  const c = asBytes32(cid);
  if (c.equals(ZERO32)) return '';
  return 'ipfs://f01551220' + Buffer.from(c).toString('hex');
}

// Every Tacit etch (CETCH and T_PETCH alike) references its metadata blob by `image_uri` (an ipfs://
// URI) at the envelope tail, NOT an inline cid. The worker decoders (decodeCEtchPayload /
// decodeCPetchPayload) surface that URI; this resolves it to the same raw-CIDv1 digest the guest does
// (cxfer-core `cetch_image_cid` / `petch_image_cid` → `ipfs_raw_cidv1_digest`), so the dapp/worker
// predict the SAME canonical token address (the cid is in the CREATE2 salt) and render the SAME
// contractURI. Raw codec (0x55) only: dag-pb / CIDv0 / non-ipfs / path-suffixed URIs return null
// (→ cid 0), exactly as the guest, so the harmonization never mispoints a contractURI at a re-encoded
// object.
export function cidFromIpfsUri(uri) {
  const PREFIX = 'ipfs://b'; // ipfs:// ‖ multibase base32 tag 'b'
  if (typeof uri !== 'string' || !uri.startsWith(PREFIX)) return null;
  const out = []; let acc = 0, bits = 0;
  for (const ch of uri.slice(PREFIX.length)) {
    const c = ch.charCodeAt(0);
    let v;
    if (c >= 97 && c <= 122) v = c - 97;          // a-z → 0..25
    else if (c >= 50 && c <= 55) v = c - 50 + 26; // 2-7 → 26..31
    else return null;                             // uppercase / padding / path → not a bare lowercase CID
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; if (out.length >= 36) return null; out.push((acc >> bits) & 0xff); }
  }
  if (out.length !== 36 || out[0] !== 0x01 || out[1] !== 0x55 || out[2] !== 0x12 || out[3] !== 0x20) return null;
  return Buffer.from(out.slice(4));
}

// Run the KAT only when executed directly (`node tests/…mjs`); stay side-effect-free when
// imported (e.g. by scripts/pin-asset-metadata.mjs, which reuses the exports above).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// 1. metaHash KAT — must equal the Solidity test (test_metaHash_kat); cid=0 (no metadata)
assert.strictEqual(hex(metaHash('TAC', 18)),
  '0xe4c8ab35e9869863d4b3a44796e370871abf8ccdae06b04d82fff892e89c06e6', 'metaHash KAT');
ok('metaHash(TAC,18,cid=0) matches the Solidity KAT (cross-language)');

// 1b. metaHash with a nonzero cid — must equal test_metaHash_kat_with_cid (the cid-binding path)
assert.strictEqual(hex(metaHash('cBTC', 8, '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')),
  '0x96dcb13599f507d7d84d8b1b44e25f7094fcd54115a74cfa1412d48a559a0c81', 'metaHash cid KAT');
ok('metaHash(cBTC,8,cid=0x00..1f) matches the Solidity KAT (full 32-byte cid bound)');

// 2. metadata is bound: any change to symbol/decimals/cid changes the id
const base = { chainId: 11155111, factory: '0xC2CB3b29D6314936f48a26e6e719bc327d67962c',
  salt: '0x' + '07'.padStart(64, '0'), etcher: '0x0000000000000000000000000000000000000E7C',
  symbol: 'TAC', decimals: 18 };
const id = deriveAssetId(base);
assert.notStrictEqual(hex(id), hex(deriveAssetId({ ...base, symbol: 'TAK' })), 'symbol bound');
assert.notStrictEqual(hex(id), hex(deriveAssetId({ ...base, decimals: 8 })), 'decimals bound');
assert.notStrictEqual(hex(id), hex(deriveAssetId({ ...base, cid: '0x' + '42'.repeat(32) })), 'cid bound');
ok('asset id changes if symbol, decimals, or the metadata cid changes (all bound)');

// 3. deterministic: same inputs -> same id (anyone re-derives the canonical id)
assert.strictEqual(hex(deriveAssetId(base)), hex(id), 'deterministic');
ok('deriveAssetId is deterministic — the canonical id is reproducible by anyone');

// 4. contractURI KAT — must equal the Solidity test (test_contractURI_reconstructs_cidv1_base16)
const cidKat = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
assert.strictEqual(contractURI(cidKat),
  'ipfs://f01551220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'contractURI KAT');
ok('contractURI(cid) matches the Solidity reconstruction (cross-language CIDv1 base16, raw codec)');

// 5. no metadata -> empty contractURI (cid = 0)
assert.strictEqual(contractURI(null), '', 'cid=0 -> empty');
assert.strictEqual(contractURI(ZERO32), '', 'cid=0 -> empty');
ok('absent metadata cid yields an empty contractURI');

// 6. raw-codec cid == sha256(json bytes) == the digest in the pinned CIDv1 raw CID.
// KAT bytes + digest verified against kubo: `ipfs add --cid-version=1` => bafkrei… (raw 0x55).
const metaJson = '{"name":"Tacit Token","description":"cBTC on Tacit","image":"ipfs://bafkreihmbs7c6hg2q5zu3kl65f65irwmleuxdw6jfop44lwtzc4ijta53q"}';
assert.strictEqual(hex(metadataCid(metaJson)),
  '0x28acd844984260a912bbf07394159648dc2b278c487f2e7bd1aeb2ab9d6410fb', 'metadataCid = sha256(json) KAT');
ok('metadataCid(json) = sha256(bytes) equals the kubo raw-CID digest (no IPFS encoder needed)');

// 7. image_uri → cid (CETCH and T_PETCH both): TAC's live image_uri resolves to the SAME 32-byte
// digest the guest surfaces (cxfer-core bitcoin.rs `etch_meta_and_asset_id` KAT — asserted there for
// both a CETCH and a T_PETCH envelope) and round-trips to its contractURI. The resolution is
// etch-type-agnostic — only the Bitcoin envelope walk that LOCATES image_uri differs per type.
const TAC_IMAGE_URI = 'ipfs://bafkreig7m5j66zlaewjvo6bipk723udgdhnyl7ve5k2suofuvhi2mmb3ai';
const tacCid = cidFromIpfsUri(TAC_IMAGE_URI);
assert.strictEqual(hex(tacCid),
  '0xdf6753ef656025935778287abfadd06619db85fea4eab52a38b4a9d1a6303b02', 'image_uri → raw-CIDv1 digest (TAC KAT)');
assert.strictEqual(contractURI(tacCid),
  'ipfs://f01551220df6753ef656025935778287abfadd06619db85fea4eab52a38b4a9d1a6303b02', 'TAC contractURI round-trips');
// Only raw codec is surfaced — dag-pb / CIDv0 / non-ipfs / path-suffixed → null (cid 0), matching the guest.
assert.strictEqual(cidFromIpfsUri('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), null, 'dag-pb → null');
assert.strictEqual(cidFromIpfsUri('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'), null, 'CIDv0 → null');
assert.strictEqual(cidFromIpfsUri('https://example.com/meta.json'), null, 'non-ipfs → null');
assert.strictEqual(cidFromIpfsUri(TAC_IMAGE_URI + '/logo.png'), null, 'path-suffixed → null (bare CID only)');
ok('image_uri resolves to the guest-identical raw-CIDv1 cid (CETCH + T_PETCH bridge metadata, raw-only)');

console.log(`\n${n}/8 confidential-canonical-asset-id checks passed`);
console.log('  example asset_id =', hex(id));
}
