#!/usr/bin/env node
// Canonical asset metadata → IPFS pipeline.
//
// Builds a per-asset metadata JSON (logo/description) in a canonical, byte-stable form and
// derives its content id `cid = sha256(jsonBytes)` — a CIDv1 with the *raw* codec (0x55), so
// the multihash digest is just sha256 of the bytes and anyone can recompute it with no IPFS
// encoder. That `cid` is the value that gets ETCHED:
//   • EVM-native etch:   bound into meta_hash → asset_id (CanonicalAssetFactory.etchCanonical)
//   • Bitcoin-native etch: carried in the CETCH / T_PETCH reveal envelope's [cid(32)]
// and the canonical ERC20 surfaces it as `contractURI() = ipfs://f01551220‖hex(cid)` (EIP-7572).
//
// The cid is authoritative from the bytes alone; pinning only provides availability. Pin the
// EXACT bytes this writes (raw codec) so the etched cid resolves — `ipfs add --cid-version=1`
// yields the matching raw CID (bafkrei…). Pinning a reserialized JSON, or as dag-pb, lands a
// different cid that the on-chain contractURI will not point at.
//
// Usage:
//   node scripts/pin-asset-metadata.mjs \
//     --symbol cBTC --decimals 8 \
//     --name "cBTC" --description "Canonical BTC on Tacit" \
//     --image ipfs://bafkrei... [--external-link https://tacit.finance] \
//     [--out out/cBTC.metadata.json] [--pin]
//
//   # also derive the EVM-native etch asset_id (+ the value to feed deriveAssetId/etchCanonical):
//     --chainid 11155111 --factory 0x… --salt 0x… --etcher 0x…
//
//   # load the metadata object verbatim from a file instead of building it from flags:
//     --in path/to/metadata.json
//
// Pinning (`--pin`): prefers local kubo (`ipfs add --cid-version=1`, deterministic raw codec);
// falls back to Pinata pinFileToIPFS when PINATA_JWT is set (the result is verified to equal the
// raw cid, and rejected if Pinata returned a non-raw CID). Without either, it prints the exact
// command to pin the written file.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { metaHash, deriveAssetId, contractURI, metadataCid } from '../tests/confidential-canonical-asset-id.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest();
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

// ── canonical, byte-stable JSON: sorted keys, compact, UTF-8 (recomputable in any language) ──
function canonicalize(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// ── CIDv1 raw (0x55) reconstruction: prefix bytes 01 55 12 20 then the 32-byte digest ──
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const cidBytes = (digest) => Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]); // v1 ‖ raw ‖ sha2-256 ‖ len-32
const cidBase32 = (digest) => 'b' + base32(cidBytes(digest)); // bafkrei… (multibase 'b')
const cidBase16 = (digest) => 'f' + cidBytes(digest).toString('hex'); // f0155122…

// ── arg parsing ──
function parseArgs(argv) {
  const out = {}; const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    if (i + 1 < a.length && !a[i + 1].startsWith('--')) { out[k] = a[++i]; } else { out[k] = true; }
  }
  return out;
}

function buildMetadata(args) {
  if (args.in) return JSON.parse(readFileSync(args.in, 'utf8'));
  const m = {};
  // EIP-7572 contract-level fields (only the ones supplied). `decimals` stays off the JSON —
  // it lives on-chain via decimals() — but is bound into the id through meta_hash.
  if (args.name) m.name = String(args.name);
  if (args.symbol) m.symbol = String(args.symbol);
  if (args.description) m.description = String(args.description);
  if (args.image) m.image = String(args.image);
  if (args['banner-image']) m.banner_image = String(args['banner-image']);
  if (args['external-link']) m.external_link = String(args['external-link']);
  return m;
}

function tryKubo(fileArgs) {
  try { return execFileSync('ipfs', fileArgs, { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

async function pinPinata(bytes, jwt) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), 'metadata.json');
  fd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${await res.text()}`);
  return (await res.json()).IpfsHash;
}

async function main() {
  const args = parseArgs(process.argv);
  const symbol = args.symbol != null ? String(args.symbol) : null;
  const decimals = args.decimals != null ? Number(args.decimals) : null;

  // 1. canonical bytes + cid = sha256(bytes)  (the authoritative, etch-ready value)
  const meta = buildMetadata(args);
  const json = canonicalize(meta);
  const bytes = Buffer.from(json, 'utf8');
  const cid = metadataCid(bytes); // == sha256(bytes)
  const cidHex = hex(cid);

  // 2. self-check: our raw-CID reconstruction must equal kubo's (when kubo is available)
  const file = args.out || `out/${symbol || 'asset'}.metadata.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const kuboCid = tryKubo(['add', '--only-hash', '-Q', '--cid-version=1', file]);
  const ours32 = cidBase32(cid);
  if (kuboCid && kuboCid !== ours32) {
    throw new Error(`raw-CID mismatch vs kubo: ours ${ours32} != ipfs ${kuboCid}`);
  }

  // 3. report
  console.log('canonical metadata bytes:', bytes.length, '→', file);
  console.log('  json        :', json);
  console.log('  cid (bytes32):', cidHex, '   ← the value etched into the asset id');
  console.log('  CID base16  :', cidBase16(cid));
  console.log('  CID base32  :', ours32, kuboCid ? '(kubo ✓)' : '(kubo not run)');
  console.log('  contractURI :', contractURI(cid));

  // 4. etch bindings (when symbol/decimals supplied)
  if (symbol != null && decimals != null) {
    console.log('  meta_hash   :', hex(metaHash(symbol, decimals, cid)));
    if (args.chainid && args.factory && args.salt && args.etcher) {
      const id = deriveAssetId({ chainId: Number(args.chainid), factory: args.factory, salt: args.salt, etcher: args.etcher, symbol, decimals, cid });
      console.log('  asset_id    :', hex(id), '   ← EVM-native etch (= etchCanonical output)');
    } else {
      console.log('  (pass --chainid --factory --salt --etcher to also derive the EVM-native asset_id)');
    }
  } else {
    console.log('  (pass --symbol --decimals to also derive meta_hash; + etch params for asset_id)');
  }

  // 5. pin (optional)
  if (args.pin) {
    const jwt = process.env.PINATA_JWT;
    const localAdd = tryKubo(['add', '-Q', '--cid-version=1', file]); // pins to local node, deterministic raw codec
    if (localAdd) {
      if (localAdd !== ours32) throw new Error(`kubo pin returned ${localAdd}, expected ${ours32}`);
      console.log('  pinned (kubo):', localAdd);
    } else if (jwt) {
      const got = await pinPinata(bytes, jwt);
      if (got !== ours32) {
        console.error(`  ✗ Pinata returned ${got} (not the raw cid ${ours32}). The etched (raw) cid will`);
        console.error(`    NOT resolve via this pin — pin the raw bytes with: ipfs add --cid-version=1 ${file}`);
        process.exit(1);
      }
      console.log('  pinned (pinata):', got);
    } else {
      console.log(`  (no kubo and no PINATA_JWT) pin the written bytes with: ipfs add --cid-version=1 ${file}`);
    }
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
