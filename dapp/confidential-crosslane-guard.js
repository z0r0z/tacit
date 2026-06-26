// ETH→BTC reverse cross-lane gate — PLAN-confidential-cross-chain.md §10, step 1.
//
// Reflection carries Bitcoin spends → Ethereum only (the SP1 reflection prover
// re-derives the Bitcoin spent set from Bitcoin headers and never reads the EVM
// nullifier set). So a note spent on the EVM `ConfidentialPool` is invisible to the
// Bitcoin side unless the Bitcoin-spend validator asks Ethereum directly. This module
// is that ask: given a note's nullifier ν, query `ConfidentialPool.nullifierSpent(ν)`
// and BLOCK a Bitcoin spend of a note already spent on Ethereum — its value moved to
// the Ethereum lane, so honoring the Bitcoin spend would duplicate it.
//
// This is the unified spent set of §3/§10 realized as a QUERY, deliberately kept
// SEPARATE from the reflected `bitcoinSpentRoot`: that root is trustlessly re-derived
// from Bitcoin by the reflection prover, so folding EVM spends into it would diverge
// the operator's set from the proven one. The reverse check is an ADDITIONAL gate.
//
// Fail-closed: any inability to confirm "unspent at the queried tag" BLOCKS the
// Bitcoin spend. Blocking is always recoverable — an EVM reorg that un-spends ν only
// un-blocks a later Bitcoin spend; it can never enable a double-spend. Default tag is
// `latest` (block the moment an EVM spend is mined, not after finality) so the window
// the query can see is closed; the sub-confirmation instant is covered by the §10
// provisional-yield ("Bitcoin arbitrates, the fast lane yields") — step 2.
//
// Enforcement points: the worker indexer-of-record (security) and the dapp pre-spend
// check (UX). When the EVM pool is not wired (`poolAddress` falsy — cross-lane
// inactive, the current mainnet posture) the guard is a no-op, so pure-Bitcoin
// operation is unchanged.
//
// `ethCall(to, data, blockTag)` is injected (worker `_ethCall`, dapp `_ethRpcCall`),
// so this module is pure and unit-testable with a mock.

export function makeCrossLaneGuard({ keccak256 }) {
  const enc = new TextEncoder();
  const strip = (h) => String(h == null ? '' : h).replace(/^0x/, '');
  const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  // nullifierSpent(bytes32) → bool — the contract's public spent-set mapping auto-getter.
  // (Browser-safe hex, no Buffer, so this loads identically in the dapp bundle and in Node.)
  const SELECTOR = '0x' + toHex(keccak256(enc.encode('nullifierSpent(bytes32)')).slice(0, 4));

  // True iff ν is spent on the EVM ConfidentialPool at `blockTag`. Throws on RPC failure
  // or a malformed return (so the caller fails closed).
  async function evmNullifierSpent(ethCall, poolAddress, nullifierHex, blockTag = 'latest') {
    const nu = strip(nullifierHex).padStart(64, '0');
    if (nu.length !== 64) throw new Error('crosslane: nullifier must be 32 bytes');
    const data = SELECTOR + nu;
    const raw = await ethCall(String(poolAddress).toLowerCase(), data, blockTag);
    // ABI bool is a single 32-byte word, non-zero == true. An empty `0x` (no contract at
    // the address, or a reverted call) is NOT "unspent" — it is unverifiable, so reject.
    const hex = strip(raw);
    if (hex.length < 64) throw new Error('crosslane: malformed nullifierSpent return');
    return BigInt('0x' + hex.slice(0, 64)) !== 0n;
  }

  // Decision for a Bitcoin spend of note ν. Returns { blocked, reason }.
  //   poolAddress falsy   → cross-lane inactive            → { blocked:false, 'crosslane-inactive' }
  //   ν spent on EVM      → would duplicate value          → { blocked:true,  'evm-spent' }
  //   ν unspent at tag    → safe to honor on Bitcoin       → { blocked:false, 'evm-unspent' }
  //   RPC / parse failure → cannot confirm unspent         → { blocked:true,  'evm-unverifiable' }  (FAIL-CLOSED)
  async function bitcoinSpendBlocked(ethCall, poolAddress, nullifierHex, opts = {}) {
    if (!poolAddress) return { blocked: false, reason: 'crosslane-inactive' };
    const blockTag = opts.blockTag || 'latest';
    try {
      const spent = await evmNullifierSpent(ethCall, poolAddress, nullifierHex, blockTag);
      return spent
        ? { blocked: true, reason: 'evm-spent' }
        : { blocked: false, reason: 'evm-unspent' };
    } catch (e) {
      return { blocked: true, reason: 'evm-unverifiable', error: String((e && e.message) || e) };
    }
  }

  return { SELECTOR, evmNullifierSpent, bitcoinSpendBlocked };
}
