#!/usr/bin/env node
// Cross-chain asset resolver (ops/ARCH-tacit-chain-abstraction.md primitive 3). Locks:
//  - the EVM derivations are byte-identical to the on-chain rules (etch parity vs the canonical-asset-id
//    KAT; token-namespace explicit layout vs ConfidentialPool.sol:526) — so a crossed note's asset_id
//    matches and is recognizable;
//  - unitScale + normalizeEvmBalance harmonize 18-dec ERC20 ↔ in-system base units;
//  - the registry merges a Bitcoin-registry entry + a cross-lane EVM entry of the SAME shared id into
//    one descriptor with BOTH lanes (the multi-asset-bidirectional coherence), and recognizes an
//    EVM-native asset by its derived id.
//
// Run: node tests/cross-chain-asset-resolver.mjs

import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { metaHash as katMetaHash, deriveAssetId as katDeriveAssetId } from './confidential-canonical-asset-id.mjs';
import { makeCrossChainAssets, unitScaleFor, normalizeEvmBalance } from '../dapp/cross-chain-asset-resolver.js';

const sha256 = (b) => createHash('sha256').update(Buffer.from(b)).digest();
const X = makeCrossChainAssets({ sha256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const lc = (h) => String(h).toLowerCase().replace(/^0x/, '');
const be8 = (v) => { const u = Buffer.alloc(8); u.writeBigUInt64BE(BigInt(v)); return u; };
const addr20 = (a) => Buffer.from(String(a).replace(/^0x/, '').padStart(40, '0'), 'hex');

// ── 1. EVM etch asset_id is byte-identical to the canonical-asset-id KAT (Solidity parity) ──
{
  const p = { chainId: 11155111, factory: '0x' + '11'.repeat(20), salt: '0x' + 'cd'.repeat(32), etcher: '0x' + '22'.repeat(20), symbol: 'TAC', decimals: 8, cid: '0x' + '00'.repeat(32) };
  assert.strictEqual(lc(X.metaHash(p.symbol, p.decimals, p.cid)), lc('0x' + Buffer.from(katMetaHash(p.symbol, p.decimals, p.cid)).toString('hex')), 'metaHash parity vs KAT');
  assert.strictEqual(lc(X.deriveEvmEtchAssetId(p)), lc('0x' + Buffer.from(katDeriveAssetId(p)).toString('hex')), 'EVM etch asset_id parity vs KAT (= CanonicalAssetFactory.deriveAssetId)');
  ok('EVM etch asset_id + metaHash are byte-identical to the canonical-asset-id KAT / Solidity');
}

// ── 2. EVM token-namespace asset_id matches ConfidentialPool.sol:526 layout ──
{
  const chainId = 11155111, underlying = '0x' + 'ab'.repeat(20);
  const want = '0x' + sha256(Buffer.concat([Buffer.from('tacit-evm-token-v1', 'utf8'), be8(chainId), addr20(underlying)])).toString('hex');
  assert.strictEqual(lc(X.deriveEvmTokenAssetId(chainId, underlying)), lc(want), 'token asset_id = sha256("tacit-evm-token-v1"‖chainid_be8‖underlying)');
  ok('EVM token-namespace asset_id matches the ConfidentialPool layout');
}

// ── 3. unitScale + balance harmonization (18-dec ERC20 ↔ in-system base units) ──
{
  assert.strictEqual(unitScaleFor(8), 10n ** 10n, 'TAC/tETH (8-dec) → unitScale 1e10');
  assert.strictEqual(unitScaleFor(6), 10n ** 12n, '6-dec → 1e12');
  assert.strictEqual(normalizeEvmBalance(5n * 10n ** 18n, 8), 5n * 10n ** 8n, '5·1e18 canonical-ERC20 amount → 5·1e8 base units (÷ unitScale 1e10)');
  ok('unitScale + normalizeEvmBalance harmonize the 18↔8 decimals boundary');
}

// ── 4. registry merges a Bitcoin entry + a cross-lane EVM entry of the SAME shared id ──
{
  const TAC = '0x' + 'f0'.repeat(32);
  X.ingestBitcoin({ assetIdHex: TAC, ticker: 'TAC', decimals: 8, etchTxid: '0x' + 'aa'.repeat(32), etchVout: 0 });
  X.ingestEvm({ assetIdHex: TAC, ticker: 'TAC', decimals: 8, canonicalErc20: '0x' + 'ee'.repeat(20) }, 11155111);
  const d = X.resolve(TAC);
  assert.ok(d, 'resolves the shared id');
  assert.deepStrictEqual([...d.lanes].sort(), ['bitcoin', 'ethereum'], 'both lanes merged onto one descriptor');
  assert.strictEqual(d.originChain, 'bitcoin', 'origin is Bitcoin (the etch)');
  assert.strictEqual(d.unitScale, 10n ** 10n, 'unitScale derived from decimals');
  assert.strictEqual(d.canonicalErc20, '0x' + 'ee'.repeat(20), 'canonical ERC20 from the EVM source');
  assert.ok(d.bitcoinEtch && d.bitcoinEtch.txid, 'Bitcoin etch retained');
  ok('a Bitcoin-issued asset (TAC) resolves with both lanes — recognizable on Ethereum and back');
}

// ── 5. an EVM-native asset is recognized by its derived id (so it is recognizable on Bitcoin after cross-out) ──
{
  const underlying = '0x' + 'cc'.repeat(20);
  X.ingestEvm({ originChain: 'ethereum', ticker: 'tUSDC', decimals: 6, underlying }, 11155111);
  const id = X.deriveEvmTokenAssetId(11155111, underlying);
  const d = X.resolve(id);
  assert.ok(d, 'EVM-native asset resolvable by its derived shared id');
  assert.strictEqual(d.originChain, 'ethereum', 'origin Ethereum');
  assert.strictEqual(d.underlying, underlying, 'underlying retained (for the EVM lane)');
  assert.strictEqual(d.unitScale, 10n ** 12n, '6-dec → 1e12');
  assert.strictEqual(X.resolve('0x' + 'de'.repeat(32)), null, 'unknown id → null');
  ok('an EVM-native asset (ERC20) is recognized by its derived id — the key to crossing it to Bitcoin');
}

// ── 6. cross-chain alias: legacy Bitcoin tETH id and the cETH pool id resolve to ONE descriptor ──
{
  const Y = makeCrossChainAssets({ sha256 });
  const TETH_BTC = '0x' + 'd9'.repeat(32);                    // legacy Bitcoin-side tETH id
  const CETH_EVM = '0x' + '2a'.repeat(32);                    // cETH pool id = _evmAssetId(0)
  // Bitcoin lane ingested FIRST (legacy holder), then the EVM cETH declares the link — order-independent.
  Y.ingestBitcoin({ assetIdHex: TETH_BTC, ticker: 'tETH', decimals: 8 });
  Y.ingestEvm({ assetId: CETH_EVM, ticker: 'cETH', decimals: 18, bitcoinLink: TETH_BTC, underlying: '0x' + '00'.repeat(20) }, 11155111);
  assert.strictEqual(Y.canonical(TETH_BTC), CETH_EVM.replace(/^0x/, ''), 'legacy tETH id canonicalizes to the cETH id');
  const viaBtc = Y.resolve(TETH_BTC), viaEvm = Y.resolve(CETH_EVM);
  assert.ok(viaBtc && viaEvm, 'both ids resolve');
  assert.strictEqual(viaBtc.assetId, viaEvm.assetId, 'both ids resolve to the SAME canonical descriptor');
  assert.deepStrictEqual([...viaEvm.lanes].sort(), ['bitcoin', 'ethereum'], 'the merged descriptor carries both lanes');
  // and the reverse ingest order (EVM link first, Bitcoin note later) lands in the same single descriptor
  const Z = makeCrossChainAssets({ sha256 });
  Z.ingestEvm({ assetId: CETH_EVM, ticker: 'cETH', decimals: 18, bitcoinLink: TETH_BTC, underlying: '0x' + '00'.repeat(20) }, 11155111);
  Z.ingestBitcoin({ assetIdHex: TETH_BTC, ticker: 'tETH', decimals: 8 });
  assert.strictEqual(Z.resolve(TETH_BTC).assetId, CETH_EVM.replace(/^0x/, ''), 'alias holds regardless of ingest order');
  assert.deepStrictEqual([...Z.resolve(CETH_EVM).lanes].sort(), ['bitcoin', 'ethereum'], 'both lanes merged either order');
  ok('legacy tETH (Bitcoin) and cETH (Ethereum) collapse into one cross-lane descriptor via the bitcoinLink');
}

console.log(`\n${n}/6 cross-chain asset resolver checks passed`);
