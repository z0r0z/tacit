#!/usr/bin/env node
// Cross-language derivation of the canonical EVM-etch asset id, matching
// CanonicalAssetFactory.sol (deriveAssetId / metaHash) and the spec amendment
// (SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT §"Asset identity"). Locks the byte layout so
// the asset id — and the metadata bound into it — is identical on Bitcoin, JS, Solidity.
//
//   meta_hash = sha256( u8(len name) ‖ name ‖ u8(len symbol) ‖ symbol ‖ u8(decimals) )
//   asset_id  = sha256( "tacit-evm-etch-v1" ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ meta_hash )
//
// Run: node tests/confidential-canonical-asset-id.mjs

import { createHash } from 'node:crypto';
import assert from 'node:assert';

const sha256 = (b) => createHash('sha256').update(b).digest();
const u8 = (n) => Buffer.from([n]);
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

export function metaHash(name, symbol, decimals) {
  const n = Buffer.from(name, 'utf8'), s = Buffer.from(symbol, 'utf8');
  if (n.length > 255 || s.length > 255) throw new Error('label too long');
  return sha256(Buffer.concat([u8(n.length), n, u8(s.length), s, u8(decimals)]));
}

export function deriveAssetId({ chainId, factory, salt, etcher, name, symbol, decimals }) {
  const tag = Buffer.from('tacit-evm-etch-v1', 'utf8');
  const chainBe8 = Buffer.alloc(8); chainBe8.writeBigUInt64BE(BigInt(chainId));
  const addr = (a) => Buffer.from(a.replace(/^0x/, ''), 'hex'); // 20 bytes
  const b32 = (x) => Buffer.from(x.replace(/^0x/, '').padStart(64, '0'), 'hex'); // 32 bytes
  return sha256(Buffer.concat([
    tag, chainBe8, addr(factory), b32(salt), addr(etcher), metaHash(name, symbol, decimals),
  ]));
}

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// 1. metaHash KAT — must equal the Solidity test (test_metaHash_kat)
assert.strictEqual(hex(metaHash('Tacit', 'TAC', 18)),
  '0x2dec931ecd9e631fd629c1c04b2e2dd266eb4c6cad3e679dae839c6c05dbf036', 'metaHash KAT');
ok('metaHash(Tacit,TAC,18) matches the Solidity KAT (cross-language)');

// 2. length-prefix disambiguates labels
assert.notStrictEqual(hex(metaHash('AB', 'C', 0)), hex(metaHash('A', 'BC', 0)), 'length-prefix');
ok('length-prefixed labels cannot be re-segmented to collide');

// 3. metadata is bound: any change to name/symbol/decimals changes the id
const base = { chainId: 11155111, factory: '0xC2CB3b29D6314936f48a26e6e719bc327d67962c',
  salt: '0x' + '07'.padStart(64, '0'), etcher: '0x0000000000000000000000000000000000000E7C',
  name: 'Tacit', symbol: 'TAC', decimals: 18 };
const id = deriveAssetId(base);
assert.notStrictEqual(hex(id), hex(deriveAssetId({ ...base, symbol: 'TAK' })), 'symbol bound');
assert.notStrictEqual(hex(id), hex(deriveAssetId({ ...base, name: 'Tacit Token' })), 'name bound');
assert.notStrictEqual(hex(id), hex(deriveAssetId({ ...base, decimals: 8 })), 'decimals bound');
ok('asset id changes if any of name/symbol/decimals changes (metadata is bound)');

// 4. deterministic: same inputs -> same id (anyone re-derives the canonical id)
assert.strictEqual(hex(deriveAssetId(base)), hex(id), 'deterministic');
ok('deriveAssetId is deterministic — the canonical id is reproducible by anyone');

console.log(`\n${n}/4 confidential-canonical-asset-id checks passed`);
console.log('  example asset_id =', hex(id));
