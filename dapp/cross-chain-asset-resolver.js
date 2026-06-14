// Cross-chain asset resolver — the single source of truth for "what is asset X across both chains",
// so a Tacit asset is recognizable on Bitcoin AND Ethereum regardless of which chain issued it
// (ops/ARCH-tacit-chain-abstraction.md, primitive 3 "one asset"). Multi-asset bidirectional movement
// needs this: a Bitcoin-etched asset (TAC, tETH) crossing to Ethereum keeps its shared asset_id (the
// canonical ERC20 deploys at f(asset_id)); an EVM-issued ERC20 crossing to Bitcoin carries its
// EVM-namespace asset_id, which the Bitcoin side must then recognize. The registry merges asset
// descriptors from both origins keyed by the SHARED asset_id, accumulating the lanes each can settle on.
//
// Derivations are faithful ports of the on-chain rules (the asset_id MUST match what the contract +
// the canonical-asset-id KAT compute, or a crossed note is unrecognizable):
//   Bitcoin etch : sha256(reveal_txid_BE ‖ vout_LE4)                          (dapp/tacit.js assetIdFor)
//   EVM etch     : sha256("tacit-evm-etch-v1" ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ metaHash)
//   EVM token    : sha256("tacit-evm-token-v1" ‖ chainid_be8 ‖ underlying)    (ConfidentialPool.sol:526)
//   metaHash     : sha256(u8(len symbol) ‖ symbol ‖ u8(decimals) ‖ cid32)
//   unitScale    : 10^(ETH_DECIMALS − tacitDecimals), ETH_DECIMALS = 18
//
// `sha256` is injected (Uint8Array/Buffer in → Uint8Array/Buffer out) for node + browser parity.

const ETH_DECIMALS = 18;
const lc = (h) => String(h == null ? '' : h).toLowerCase().replace(/^0x/, '');
const _u8 = (n) => Uint8Array.of(n & 0xff);
const _hexToBytes = (h) => {
  const s = String(h).replace(/^0x/, '');
  const u = new Uint8Array(s.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16);
  return u;
};
const _bytesToHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const _concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const _be8 = (n) => {
  const u = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) { u[i] = Number(v & 0xffn); v >>= 8n; }
  return u;
};
const _b32 = (x) => _hexToBytes(String(x == null ? '' : x).replace(/^0x/, '').padStart(64, '0'));
const _addr20 = (a) => _hexToBytes(String(a).replace(/^0x/, '').padStart(40, '0'));
const _utf8 = (s) => new TextEncoder().encode(s);

// unitScale = 10^(ETH_DECIMALS − tacitDecimals) as BigInt; the multiplier between an in-system base
// unit (≤8-dec) and the 18-dec canonical-ERC20 amount.
export function unitScaleFor(tacitDecimals, ethDecimals = ETH_DECIMALS) {
  return 10n ** BigInt(ethDecimals - tacitDecimals);
}
// Normalize a public canonical-ERC20 balance (18-dec) to the asset's in-system base units, for the
// unified-holdings UNIT CONTRACT. (A *confidential* note value is already base units — do not scale it.)
export function normalizeEvmBalance(balance18, tacitDecimals, ethDecimals = ETH_DECIMALS) {
  return BigInt(balance18) / unitScaleFor(tacitDecimals, ethDecimals);
}

export function makeCrossChainAssets({ sha256 }) {
  if (typeof sha256 !== 'function') throw new Error('cross-chain-asset-resolver: inject sha256');
  const h = (bytes) => _bytesToHex(Uint8Array.from(sha256(bytes)));

  function metaHash(symbol, decimals, cid) {
    const s = _utf8(symbol);
    if (s.length > 255) throw new Error('symbol too long');
    return h(_concat(_u8(s.length), s, _u8(decimals), _b32(cid)));
  }
  function deriveEvmEtchAssetId({ chainId, factory, salt, etcher, symbol, decimals, cid }) {
    return h(_concat(_utf8('tacit-evm-etch-v1'), _be8(chainId), _addr20(factory), _b32(salt), _addr20(etcher), _hexToBytes(metaHash(symbol, decimals, cid))));
  }
  function deriveEvmTokenAssetId(chainId, underlying) {
    return h(_concat(_utf8('tacit-evm-token-v1'), _be8(chainId), _addr20(underlying)));
  }

  // The registry: shared asset_id (lowercased, no 0x) → unified descriptor. Sources upsert their view
  // of an asset; lanes accumulate, so a Bitcoin-registry entry + a cross-lane EVM entry of the SAME id
  // merge into one descriptor with both lanes — the cross-chain coherence the unified surface needs.
  const byId = new Map();
  function upsert(desc) {
    const id = lc(desc.assetId);
    if (!id) return null;
    const cur = byId.get(id) || { assetId: id, lanes: [] };
    const lanes = Array.from(new Set([...(cur.lanes || []), ...(desc.lanes || [])]));
    const next = { ...cur, ...desc, assetId: id, lanes };
    if (next.tacitDecimals != null && next.unitScale == null) next.unitScale = unitScaleFor(next.tacitDecimals);
    byId.set(id, next);
    return next;
  }

  // From the Bitcoin asset registry (dapp/tacit.js loadRegistry entries): {assetIdHex, ticker, decimals, etchTxid?, etchVout?}.
  function ingestBitcoin(meta) {
    return upsert({
      assetId: meta.assetIdHex || meta.asset_id, ticker: meta.ticker, tacitDecimals: meta.decimals,
      originChain: 'bitcoin',
      bitcoinEtch: meta.etchTxid ? { txid: meta.etchTxid, vout: meta.etchVout ?? 0 } : null,
      lanes: ['bitcoin'],
    });
  }
  // From an EVM-side source (CROSSLANE_DEPLOYMENTS.assets / TETH_DEPLOYMENTS): a Bitcoin-shared asset
  // with an Ethereum lane (originChain stays 'bitcoin'), OR an EVM-native asset (originChain 'ethereum'
  // — pass it, with `underlying` so its id is derivable). `canonicalErc20` is the resolved/queried ERC20.
  function ingestEvm(a, chainId) {
    const originChain = a.originChain || 'bitcoin';
    let assetId = a.assetIdHex || a.assetId;
    if (!assetId && originChain === 'ethereum' && a.underlying != null) assetId = deriveEvmTokenAssetId(chainId, a.underlying);
    return upsert({
      assetId, ticker: a.ticker, tacitDecimals: a.decimals, originChain, chainId,
      canonicalErc20: a.canonicalErc20 || null, underlying: a.underlying || null,
      lanes: ['ethereum'],
    });
  }

  // Resolve a shared asset_id to its unified descriptor (null if unknown). Works regardless of which
  // chain is asking — a Bitcoin note keyed by an EVM-native id resolves here, and vice versa.
  function resolve(assetId) {
    const d = byId.get(lc(assetId));
    return d ? { ...d, lanes: [...d.lanes] } : null;
  }
  const all = () => [...byId.values()].map((d) => ({ ...d, lanes: [...d.lanes] }));

  return { metaHash, deriveEvmEtchAssetId, deriveEvmTokenAssetId, unitScaleFor, normalizeEvmBalance, ingestBitcoin, ingestEvm, upsert, resolve, all };
}
