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

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// 1. metaHash KAT — must equal the Solidity test (test_metaHash_kat); cid=0 (no metadata)
assert.strictEqual(hex(metaHash('TAC', 18)),
  '0xe4c8ab35e9869863d4b3a44796e370871abf8ccdae06b04d82fff892e89c06e6', 'metaHash KAT');
ok('metaHash(TAC,18,cid=0) matches the Solidity KAT (cross-language)');

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

console.log(`\n${n}/3 confidential-canonical-asset-id checks passed`);
console.log('  example asset_id =', hex(id));
