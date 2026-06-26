// EVM-lane balance reader — the Ethereum-side holdings for the unified surface (task #6 of
// ops/CHECKLIST-v1-multi-asset-readiness.md; feeds dapp/unified-holdings.js scanHoldingsUnified).
// For each asset the resolver knows on the Ethereum lane, it reads the user's canonical-ERC20 balance
// (`canonicalTokenFor(assetId)` → `balanceOf(evmAddress)`) and normalizes the 18-dec amount to the
// asset's in-system base units (the unified-holdings UNIT CONTRACT). Confidential-pool notes + tETH
// are additional lanes that plug in as `extraReaders`. INERT (returns []) until a pool + evm address
// are set, so it is safe to wire before the ConfidentialPool deploys.
//
// `ethCall(to, dataHex) => Promise<hexResult>` is injected (tacit.js provides `_ethRpcCall`-based);
// `keccak256` = the @noble keccak_256 (for ABI selectors); `resolver` = cross-chain-asset-resolver.

import { unitScaleFor } from './cross-chain-asset-resolver.js';

const _selector = (keccak256, sig) =>
  '0x' + Array.from(keccak256(new TextEncoder().encode(sig))).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
const _pad32 = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const _isZeroAddr = (a) => !a || /^0x0*$/.test(a);

export function makeEvmLaneReader({ ethCall, keccak256, resolver, evmAddress, pool, externalErc20 = [], extraReaders = [] } = {}) {
  if (!ethCall || !keccak256 || !resolver || !evmAddress || !pool) {
    return { readEvmLanes: async () => [] }; // inert until configured
  }
  const canonSel = _selector(keccak256, 'canonicalTokenFor(bytes32)'); // pool view: id → ERC20 address
  const balSel = _selector(keccak256, 'balanceOf(address)');

  async function canonicalToken(d) {
    if (d.canonicalErc20 && !_isZeroAddr(d.canonicalErc20)) return d.canonicalErc20;
    const r = await ethCall(pool, canonSel + _pad32(d.assetId)).catch(() => null);
    if (!r || r === '0x') return null;
    const addr = '0x' + r.replace(/^0x/, '').slice(-40);
    return _isZeroAddr(addr) ? null : addr;
  }

  // The canonical-ERC20 EVM lane for every resolver asset with an Ethereum lane (normalized to base units).
  async function readCanonicalErc20() {
    const out = [];
    for (const d of resolver.all()) {
      if (!Array.isArray(d.lanes) || !d.lanes.includes('ethereum')) continue;
      const token = await canonicalToken(d);
      if (!token) continue;
      const balHex = await ethCall(token, balSel + _pad32(evmAddress)).catch(() => null);
      const bal18 = balHex && balHex !== '0x' ? BigInt(balHex) : 0n;
      if (bal18 === 0n) continue;
      const scale = d.unitScale ?? unitScaleFor(d.tacitDecimals ?? 8);
      out.push({ assetId: d.assetId, ticker: d.ticker, decimals: d.tacitDecimals, balance: bal18 / scale, source: 'eth-canonical', lane: 'ethereum' });
    }
    return out;
  }

  // Display-only external ERC20s (USDC/USDT/wstETH) — public tokens the user holds but that are NOT tacit
  // assets. Each row carries `external: true` and a synthetic assetId (the token address) so the unified
  // merge keeps it as its own standalone row and never folds it into a cross-lane tacit-asset sum. `balance`
  // stays in the token's own base units (rawBalance) — there is no in-system unit contract to honor here, so
  // we also pass `decimals` for display formatting.
  async function readExternalErc20() {
    const out = [];
    for (const t of (externalErc20 || [])) {
      if (!t || _isZeroAddr(t.address)) continue;
      const balHex = await ethCall(t.address, balSel + _pad32(evmAddress)).catch(() => null);
      const raw = balHex && balHex !== '0x' ? BigInt(balHex) : 0n;
      if (raw === 0n) continue;
      out.push({ assetId: t.address.toLowerCase(), ticker: t.ticker, decimals: t.decimals, balance: raw, rawBalance: raw, source: 'eth-external', lane: 'ethereum', external: true });
    }
    return out;
  }

  // The full EVM lane = canonical ERC20 + external watch-tokens + any injected readers (pool notes, tETH).
  // A failing reader is skipped (the unified view degrades, never sinks the other lanes).
  async function readEvmLanes() {
    const parts = [readCanonicalErc20(), readExternalErc20(), ...extraReaders.map((r) => Promise.resolve().then(r))];
    const settled = await Promise.allSettled(parts);
    return settled.flatMap((s) => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []));
  }

  return { readEvmLanes, readCanonicalErc20, readExternalErc20 };
}
