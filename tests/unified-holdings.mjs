#!/usr/bin/env node
// Unified cross-chain holdings merge (ops/ARCH-tacit-chain-abstraction.md, the unified-surface
// contract). Locks: the SAME asset_id on both lanes merges into ONE row with total = btc + eth and an
// auditable per-lane split; distinct ids stay separate; label fields propagate; balances coerce from
// bigint/number/string; the DI scan merges scanHoldings() + EVM readers; an EVM-read failure degrades
// to a Bitcoin-only view (never sinks the BTC holdings); the portfolio total splits by lane.
//
// Run: node tests/unified-holdings.mjs

import assert from 'node:assert';
import { mergeUnifiedHoldings, scanHoldingsUnified, unifiedPortfolioTotals } from '../dapp/unified-holdings.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const TAC = '0x' + 'aa'.repeat(32);
const cBTC = '0x' + 'bb'.repeat(32);

// ── 1. same asset_id on both lanes → ONE row, total = btc + eth, lane split correct ──
{
  const u = mergeUnifiedHoldings([
    { assetId: TAC, ticker: 'TAC', decimals: 8, balance: 100n, lane: 'bitcoin', source: 'btc-utxo' },
    { assetId: TAC, balance: 40n, lane: 'ethereum', source: 'eth-confidential' },
    { assetId: TAC, balance: 10n, lane: 'ethereum', source: 'eth-canonical' },
  ]);
  assert.strictEqual(u.size, 1, 'one merged row for the shared asset_id');
  const e = u.get(TAC.toLowerCase());
  assert.strictEqual(e.total, 150n, 'total = 100 (btc) + 40 + 10 (eth)');
  assert.strictEqual(e.lanes.bitcoin, 100n, 'bitcoin lane = 100');
  assert.strictEqual(e.lanes.ethereum, 50n, 'ethereum lane = 40 + 10');
  assert.strictEqual(e.byLane.length, 3, 'auditable per-lane breakdown retained');
  assert.strictEqual(e.ticker, 'TAC', 'ticker propagated from the BTC lane');
  assert.strictEqual(e.decimals, 8, 'decimals propagated');
  ok('the same asset_id on both lanes merges into one row (total = btc + eth, auditable split)');
}

// ── 2. distinct asset_ids stay separate; label fields fill from whichever lane has them ──
{
  const u = mergeUnifiedHoldings([
    { assetId: TAC, balance: 5n, lane: 'ethereum', source: 'eth-canonical' },        // no ticker here
    { assetId: cBTC, ticker: 'cBTC', decimals: 8, balance: 7n, lane: 'bitcoin' },
  ]);
  assert.strictEqual(u.size, 2, 'two assets, two rows');
  assert.strictEqual(u.get(cBTC.toLowerCase()).ticker, 'cBTC', 'cBTC labelled');
  assert.strictEqual(u.get(TAC.toLowerCase()).total, 5n, 'TAC eth-only total');
  ok('distinct asset_ids stay separate rows');
}

// ── 3. balance coercion: bigint, integer-number, decimal-string (fractional tail truncated) ──
{
  const u = mergeUnifiedHoldings([
    { assetId: TAC, balance: 3n, lane: 'bitcoin' },
    { assetId: TAC, balance: 4, lane: 'ethereum' },
    { assetId: TAC, balance: '5.9', lane: 'ethereum' }, // string with fractional tail → 5
  ]);
  assert.strictEqual(u.get(TAC.toLowerCase()).total, 12n, '3 + 4 + 5 (string truncated) = 12');
  ok('balances coerce from bigint / number / decimal-string (truncating any fractional tail)');
}

// ── 4. DI scan merges scanHoldings() (Map) + EVM readers ──
{
  const scanBitcoin = async () => new Map([[TAC, { ticker: 'TAC', decimals: 8, balance: 100n }]]);
  const readEvmLanes = async () => [{ assetId: TAC, balance: 25n, source: 'eth-teth' }];
  const u = await scanHoldingsUnified({ scanBitcoin, readEvmLanes });
  const e = u.get(TAC.toLowerCase());
  assert.strictEqual(e.total, 125n, 'unified total = btc 100 + eth 25');
  assert.strictEqual(e.lanes.ethereum, 25n, 'eth lane from the reader');
  ok('scanHoldingsUnified merges the existing scanHoldings() with the EVM-lane readers');
}

// ── 5. an EVM-read failure degrades to a Bitcoin-only view (never sinks the BTC holdings) ──
{
  const scanBitcoin = async () => new Map([[TAC, { ticker: 'TAC', decimals: 8, balance: 100n }]]);
  const readEvmLanes = async () => { throw new Error('eth rpc down'); };
  const u = await scanHoldingsUnified({ scanBitcoin, readEvmLanes });
  assert.strictEqual(u.get(TAC.toLowerCase()).total, 100n, 'BTC holdings survive an EVM-read failure');
  assert.strictEqual(u.get(TAC.toLowerCase()).lanes.ethereum, 0n, 'eth lane empty, not errored');
  ok('an EVM-read failure degrades to a Bitcoin-only view (BTC holdings never thrown away)');
}

// ── 6. portfolio totals split by lane + quote via markFor ──
{
  const u = mergeUnifiedHoldings([
    { assetId: TAC, balance: 100n, lane: 'bitcoin' },
    { assetId: TAC, balance: 50n, lane: 'ethereum' },
    { assetId: cBTC, balance: 8n, lane: 'bitcoin' },
  ]);
  const t = unifiedPortfolioTotals(u, (assetId, _d, total) => total * 2n); // toy mark: 2 sats per unit
  assert.strictEqual(t.lanes.bitcoin, 108n, 'bitcoin lane total across assets');
  assert.strictEqual(t.lanes.ethereum, 50n, 'ethereum lane total');
  assert.strictEqual(t.total, 158n, 'grand total across lanes');
  assert.strictEqual(t.quoted, (150n + 8n) * 2n, 'quoted sum via markFor');
  ok('unifiedPortfolioTotals splits by lane and quotes via markFor');
}

console.log(`\n${n}/6 unified cross-chain holdings checks passed`);
