// tacit-pin Worker
//
// All network-scoped endpoints accept ?network=signet|mainnet. The query
// default is signet so older clients calling /assets without the query
// keep working unchanged; the current dapp explicitly sends ?network=mainnet.
// KV keys are namespaced per network: signet keeps its legacy unprefixed form
// (asset:<aid>), mainnet uses asset:mainnet:<aid>.
//
// Endpoints:
//   POST /pin                    — upload an image; returns { cid, size }
//   POST /pin-json               — pin a small (≤4KB) metadata JSON (name/description/etc)
//   POST /pin-mixer-vk           — pin a snarkjs Groth16 verifying-key JSON (≤32KB)
//   POST /pin-airdrop-snapshot   — pin a tacit-airdrop-v1 snapshot JSON (≤16MB, ≤100k rows)
//   GET  /drops-onchain          — list T_DROP-rooted on-chain claim pools (SPEC §5.12)
//   GET  /drops-onchain/:drop_id        — single drop metadata + cap progress
//   GET  /drops-onchain/:drop_id/claims — paginated T_DCLAIM event list (SPEC §5.13)
//   POST /drops-hint             — targeted index of a fresh T_DROP / T_DCLAIM broadcast
//   GET  /balance           — faucet wallet balance + address (signet only)
//   POST /drip { address }  — send DRIP_SATS to a signet address (signet only)
//   GET  /assets            — list etched assets on the requested network
//                              optional ?limit=N (default unbounded, max 1000)
//                              optional ?mints=0 to skip per-asset mint history
//   GET  /assets/:asset_id  — single asset's metadata
//   POST /assets/hint       — { reveal_txid, reveal_vout? } targeted index of a
//                              fresh etch/mint so it appears immediately without
//                              waiting on the cron tick. Works pre-confirmation.
//   POST /assets/:asset_id/attest — etcher publishes (supply, blinding) opening; worker verifies
//                                   C == supply·H + r·G against the on-chain commitment.
//   POST /assets/:asset_id/mints/:mint_txid/attest — issuer publishes (mint_amount, mint_blinding)
//                                   for a specific T_MINT event. Same semantics as etch attest.
//   POST /utxos/:txid/:vout/opening — UTXO holder publishes (amount, blinding) opening for any
//                                   tacit UTXO they own. Worker verifies Pedersen + ownership
//                                   (P2WPKH hash160 match) + BIP-340 sig from owner_pubkey over
//                                   sha256("tacit-opening-v1" || asset_id || txid_BE || vout_LE
//                                   || amount_LE || blinding || owner_pubkey).
//   GET  /utxos/:txid/:vout/opening — fetch a single published opening.
//   GET  /assets/:asset_id/openings — list all published openings for an asset (marketplace-friendly).
//   POST /assets/:asset_id/disclosures — holder publishes a "balance ≥ threshold" range disclosure
//                                   for one or more UTXOs they own. Worker verifies ownership +
//                                   sig but NOT the bulletproof itself; consumers verify client-side.
//   GET  /assets/:asset_id/disclosures — list all published range disclosures for an asset.
//   POST /assets/:asset_id/listings — atomic create-listing-with-opening: opening fields plus
//                                   {price_sats, maker_address, expiry, listing_sig}. Worker
//                                   verifies opening, listing sig, and address coherence.
//   GET  /assets/:asset_id/listings — list active listings (with expired flag).
//   DELETE /assets/:asset_id/listings/:txid/:vout — explicit cancel; requires cancel_sig from
//                                   owner_pubkey. (Implicit cancellation: spend the UTXO.)
//   POST /assets/:asset_id/listings/:txid/:vout/claim — taker reserves a listing for 5 min
//                                   to prevent multi-taker race in OTC settlement. Atomic
//                                   claim-or-409. Body: {taker_pubkey, sig over canonical msg}.
//   POST /assets/:asset_id/listings-range — range-disclosed listing: maker proves balance ≥ K
//                                   without revealing per-UTXO openings. Body combines
//                                   disclosure (utxos, threshold, rangeproof, disclosure_sig)
//                                   with listing terms (price_sats, maker_address, expiry,
//                                   listing_sig). One per (asset, owner_pubkey).
//   GET  /assets/:asset_id/listings-range — list active range-listings.
//   DELETE /assets/:asset_id/listings-range/:owner_pubkey — explicit cancel by maker.
//   POST /assets/:asset_id/listings-range/:maker_pubkey/claim — taker reservation, 5 min TTL.
//   POST /assets/:asset_id/preauth-sales — buyer-completable T_AXFER listing (SPEC §5.7.8).
//                                   Body carries the sale-auth fields + a pre-signed P2WPKH
//                                   spend signature for vin[1] bound to vout[1]; worker verifies
//                                   auth_sig, opening, outpoint ownership/liveness, and rebuilds
//                                   the BIP-143 sighash to ECDSA-verify seller_asset_spend_sig.
//                                   One live sale per asset_outpoint (409 on duplicate).
//   GET  /assets/:asset_id/preauth-sales — list active preauth sales (with expired flag).
//   GET  /assets/:asset_id/preauth-sales/:sale_id — single preauth sale record.
//   DELETE /assets/:asset_id/preauth-sales/:sale_id — signed cancel; requires cancel_sig from
//                                   seller_pubkey. (Implicit cancellation: spend the asset UTXO.)
// Debug endpoints (gated on DEBUG_TOKEN env secret; default-deny 404 if unset):
//   POST /scan              — manually trigger a registry scan for the requested network.
//   POST /rescan?from=<h>   — rewind meta:last_scanned so next tick re-scans from height <h>.
// Scheduled (cron */5 * * * *): scans signet AND mainnet for CETCH, T_CXFER, T_MINT, T_BURN, T_AXFER, T_PETCH, T_PMINT, T_DEPOSIT, and T_WITHDRAW envelopes.
// Mainnet runs at a smaller blocks-per-tick budget because mainnet blocks
// (~3000 txs each) burn far more subrequests than near-empty signet blocks.
//
// Secrets (set via `wrangler secret put`):
//   PINATA_JWT     — Pinata API JWT for image uploads
//   FAUCET_PRIV    — 64-hex signet wallet privkey for the auto-faucet
//
// All trust-bearing logic stays in the dApp (rangeproof, kernel sig, recursive
// validation). This Worker is purely cache + convenience.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { bech32, bech32m } from '@scure/base';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

// ============== CONSTANTS ==============
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PNG_MAGIC  = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
// Address human-readable-parts per network. P2WPKH on signet/testnet shares
// 'tb'; mainnet is 'bc'. The faucet (signet-only) reads .signet directly;
// the listings module reads HRP_BY_NETWORK[network].
// Robust env-var int parsing. `parseInt('', 10)` and `parseInt('foo', 10)`
// both return NaN, and `prior >= NaN` is false — silently disabling every
// limit check that uses one. Use `safeInt` everywhere to coerce malformed
// values back to the intended default.
function safeInt(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}
const HRP_BY_NETWORK = { signet: 'tb', mainnet: 'bc' };
const DUST = 546;
const ENVELOPE_MAGIC = new TextEncoder().encode('TACIT');
const T_CETCH    = 0x21;
const T_CXFER    = 0x23;
const T_MINT     = 0x24;
const T_BURN     = 0x25;
const T_AXFER = 0x26; // CXFER variant allowing aux non-tacit inputs (atomic OTC settlement, SPEC §5.7)
const T_AXFER_VAR = 0x37; // variable-amount atomic settlement (SPEC §5.7.6.1 / §5.7.9)
const T_PETCH    = 0x27; // permissionless-mint deployment record (SPEC §5.8)
const T_PMINT    = 0x28; // permissionless mint event against a T_PETCH ancestor (SPEC §5.9)
const T_DROP     = 0x2B; // public-claim pool over existing supply (SPEC §5.12)
const T_DCLAIM   = 0x2C; // permissionless claim event against a T_DROP ancestor (SPEC §5.13)
const T_DEPOSIT  = 0x29; // mixer-pool deposit / pool init (SPEC §5.10)
const T_WITHDRAW = 0x2A; // mixer-pool anonymous withdraw (SPEC §5.11)
const N_BITS = 64; // amount range: [0, 2^64) — bulletproof rangeproof.
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ============== PEDERSEN (must match dApp's deriveH / pedersenCommit) ==============
function deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concatBytes(seed, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), x);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
  }
  throw new Error('failed to derive NUMS generator H');
}
const PEDERSEN_H = deriveH();
// SPEC §3.1 cross-implementation KAT: a typo in the seed string ("tacit-
// generator-H-v1") silently produces a different curve point and rejects
// every proof from the canonical implementation. Pin the published vector at
// module load so a regression fails fast (per-isolate cold-start cost only).
{
  const expected = '02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56';
  const actual = bytesToHex(PEDERSEN_H.toRawBytes(true));
  if (actual !== expected) throw new Error(`worker NUMS H mismatch: ${actual} != ${expected}`);
}
const PEDERSEN_G = secp.ProjectivePoint.BASE;
const PEDERSEN_ZERO = secp.ProjectivePoint.ZERO;
const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? PEDERSEN_ZERO : PEDERSEN_H.multiply(a);
  const rG = r === 0n ? PEDERSEN_ZERO : PEDERSEN_G.multiply(r);
  return aH.add(rG);
}

// SPEC §5.9: T_PMINT envelopes carry public (amount, blinding) alongside the
// commitment, so any indexer can recompute the binding before crediting.
// Returns true iff `pedersenCommit(amount, blinding)` equals the declared
// compressed point. The dapp's PMINT recovery path (path 6 in §5.13) already
// rejects mismatches client-side; indexing without the same gate lets bogus
// envelopes occupy canonical (height, tx_index) slots and feed `cumulative_minted`.
// Inputs are taken in decoder format: `amount` as decimal string or BigInt,
// `blindingHex` / `commitmentHex` as lowercase hex (no `0x`). Returns false on
// any parse error so callers can use it as a single boolean gate.
function pmintCommitmentOpens(amount, blindingHex, commitmentHex) {
  let claimed, onchain;
  try {
    claimed = pedersenCommit(BigInt(amount), BigInt('0x' + blindingHex));
    onchain = compressedPointFromHex(commitmentHex);
  } catch { return false; }
  return claimed.equals(onchain);
}

// Strict 33-byte compressed-point parser: pins the length and prefix before
// handing the hex to noble. Mirrors the dApp's bytesToPoint guard so a future
// noble update can't accidentally accept x-only or uncompressed forms — both
// would silently change the meaning of envelope payloads here.
function compressedPointFromHex(input) {
  const hex = typeof input === 'string'
    ? input.toLowerCase()
    : bytesToHex(input);
  if (hex.length !== 66) throw new Error('point must be 33 bytes (66 hex chars)');
  if (hex[0] !== '0' || (hex[1] !== '2' && hex[1] !== '3')) {
    throw new Error('point prefix must be 02/03 (compressed)');
  }
  return secp.ProjectivePoint.fromHex(hex);
}

// ============== UTIL ==============
const hash160 = b => ripemd160(sha256(b));
const hash256 = b => sha256(sha256(b));
const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };

function corsHeaders(env, reqOrigin) {
  const list = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const allow = list.includes('*') ? '*' : (list.includes(reqOrigin) ? reqOrigin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Bearer-token gate for the debug endpoints (/scan, /rescan). Either of those
// can burn substantial mempool.space subrequest budget — /rescan?from=0 in
// particular triggers a scan from genesis on the next cron tick. Default-deny:
// if DEBUG_TOKEN isn't configured the endpoints return 404 (so an attacker
// probing the surface can't tell they exist) rather than 401.
function checkDebugAuth(req, env) {
  const token = env.DEBUG_TOKEN;
  if (!token || typeof token !== 'string' || token.length < 16) return false;
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return false;
  // Constant-time string compare to avoid timing leaks on the secret.
  const a = m[1], b = token;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============== mempool.space CLIENT ==============
// Network plumbing. The worker scans both signet and mainnet; KV keys are
// namespaced per network. Signet keys keep their legacy unprefixed form
// (asset:<aid>) for backward compat; mainnet uses asset:mainnet:<aid>.
const NETWORKS = ['signet', 'mainnet'];
function networkApi(env, network) {
  if (network === 'mainnet') return env.MAINNET_API || 'https://mempool.space/api';
  return env.SIGNET_API || 'https://mempool.space/signet/api';
}
function parseNetwork(value) {
  const v = String(value || '').toLowerCase();
  return v === 'mainnet' ? 'mainnet' : 'signet';
}
function assetKey(network, aid)        { return network === 'signet' ? `asset:${aid}` : `asset:${network}:${aid}`; }
function mintKeyFor(network, aid, txid)   { return network === 'signet' ? `mint:${aid}:${txid}` : `mint:${network}:${aid}:${txid}`; }
function burnKeyFor(network, aid, txid)   { return network === 'signet' ? `burn:${aid}:${txid}` : `burn:${network}:${aid}:${txid}`; }
function assetPrefix(network)          { return network === 'signet' ? 'asset:' : `asset:${network}:`; }
function mintPrefix(network, aid)      { return network === 'signet' ? `mint:${aid}:` : `mint:${network}:${aid}:`; }
function burnPrefix(network, aid)      { return network === 'signet' ? `burn:${aid}:` : `burn:${network}:${aid}:`; }
// T_PETCH (deployment) and T_PMINT (mint event) namespaces. Kept distinct
// from `asset:*` so /assets and /petch-assets stay cleanly separable. Pmint
// keys embed zero-padded (height, tx_index) in the key so KV.list returns
// canonical chain order — SPEC §5.9 *Cap-overflow ordering* mandates
// (height, tx_index) as the canonical sort, not (height, txid). The cron's
// loop index is plumbed through and padded to 6 digits (1M txs/block
// headroom). Without this, two same-block T_PMINTs picking the last cap
// slot would pick the wrong winner vs SPEC.
function petchKey(network, aid)        { return network === 'signet' ? `petch:${aid}` : `petch:${network}:${aid}`; }
function petchPrefix(network)          { return network === 'signet' ? 'petch:' : `petch:${network}:`; }
// Curated "verified" registry. A small set of asset_ids that admin (and
// eventually a community signing scheme) has endorsed as the canonical
// version of a ticker — useful when same-block ties or duplicate-ticker
// land grabs would otherwise leave the platform's reference asset
// indistinguishable from copycats. Surfacing this via KV (not a hardcoded
// list in the Worker source) lets us add/remove without redeploying. The
// VERIFICATION SIGNAL IS NOT TRUSTLESS — the dapp must still chain-verify
// the underlying CETCH envelope; "verified" only means "platform attests
// this is the canonical ticker holder."
function verifiedKey(network, aid)     { return network === 'signet' ? `verified:${aid}` : `verified:${network}:${aid}`; }
function verifiedPrefix(network)       { return network === 'signet' ? 'verified:' : `verified:${network}:`; }
async function loadVerifiedSet(env, network) {
  const list = await env.REGISTRY_KV.list({ prefix: verifiedPrefix(network), limit: 1000 });
  const set = new Set();
  const prefixLen = verifiedPrefix(network).length;
  for (const k of list.keys) {
    const aid = k.name.slice(prefixLen);
    if (/^[0-9a-f]{64}$/.test(aid)) set.add(aid);
  }
  return set;
}
function pmintKeyFor(network, aid, height, txIndex, txid) {
  const h = String(height || 0).padStart(10, '0');
  const idx = String(txIndex || 0).padStart(6, '0');
  return network === 'signet' ? `pmint:${aid}:${h}:${idx}:${txid}` : `pmint:${network}:${aid}:${h}:${idx}:${txid}`;
}
function pmintPrefix(network, aid)     { return network === 'signet' ? `pmint:${aid}:` : `pmint:${network}:${aid}:`; }

// SPEC §5.12 / §5.13 — T_DROP / T_DCLAIM indexer state.
//
// drop_id = SHA256(drop_reveal_txid_BE || 0_LE), 64-hex string. Derived KV
// identifier (not in the wire format — T_DCLAIM carries drop_reveal_txid
// directly so validators can fetch the parent tx without an index lookup).
//
// Per-drop metadata: `drop:<network>:<drop_id>` (signet drops the network
// segment per the legacy unprefixed convention). Stored at hint/cron when
// the worker first sees the T_DROP reveal tx.
function dropKey(network, dropId)         { return network === 'signet' ? `drop:${dropId}` : `drop:${network}:${dropId}`; }
function dropPrefix(network)              { return network === 'signet' ? 'drop:' : `drop:${network}:`; }

// Per-claim canonical-order record. Padded by (height, tx_index) so KV.list
// returns claims in canonical chain order, identical to the pmint pattern.
// The trailing :<txid> disambiguates same-block same-tx-index claims (which
// can't happen on Bitcoin but the convention is robust).
function dclaimKeyFor(network, dropId, height, txIndex, txid) {
  const h = String(height || 0).padStart(10, '0');
  const idx = String(txIndex || 0).padStart(6, '0');
  return network === 'signet'
    ? `dclaim:${dropId}:${h}:${idx}:${txid}`
    : `dclaim:${network}:${dropId}:${h}:${idx}:${txid}`;
}
function dclaimPrefix(network, dropId)    { return network === 'signet' ? `dclaim:${dropId}:` : `dclaim:${network}:${dropId}:`; }

// Per-leaf nullifier set for double-claim prevention (merkle-gated drops
// only — open drops have no nullifier). Padded leaf_index so KV.list returns
// claimed leaves in ascending order. The trailing :<txid> records which
// specific T_DCLAIM consumed the leaf, useful for reorg revocation.
function dclaimLeafKey(network, dropId, leafIndex) {
  const idx = String(leafIndex || 0).padStart(10, '0');
  return network === 'signet'
    ? `dclaim-leaf:${dropId}:${idx}`
    : `dclaim-leaf:${network}:${dropId}:${idx}`;
}
function dclaimLeafPrefix(network, dropId) {
  return network === 'signet' ? `dclaim-leaf:${dropId}:` : `dclaim-leaf:${network}:${dropId}:`;
}

// Per-drop cap-progress snapshot, mirroring petchProgressKey. Lets read
// endpoints return cumulative_claimed + remaining without an O(N) KV.list
// over the dclaim namespace.
function dropProgressKey(network, dropId) {
  return network === 'signet' ? `drop_progress:${dropId}` : `drop_progress:${network}:${dropId}`;
}

// Per-drop dirty marker. Set when a new dclaim key lands; cleared after the
// progress snapshot is rebuilt. TTL prevents stuck flags after a restart.
function dropDirtyKey(network, dropId) {
  return network === 'signet' ? `drop_dirty:${dropId}` : `drop_dirty:${network}:${dropId}`;
}
function dropDirtyPrefix(network) {
  return network === 'signet' ? 'drop_dirty:' : `drop_dirty:${network}:`;
}

// Per-asset cap-progress snapshot. Maintained by cron + hint so user-facing
// reads don't pay O(N) KV.list cost for assets with tens of thousands of
// canonical pmints (FAIR hit 50k+ where the inline per-request derivation
// blew past 30s wall-time and 1000 subrequest budgets, and the legacy
// loadCanonicalPmints value-fetch path took 45s for ~5800 entries before
// truncating). Read endpoints return this snapshot directly; writers
// schedule async refreshes via ctx.waitUntil.
function petchProgressKey(network, aid) {
  return network === 'signet' ? `petch_progress:${aid}` : `petch_progress:${network}:${aid}`;
}
// Per-asset "dirty since last cron refresh" marker. Writers (hint + cron block
// scan) set this when they write a new canonical pmint key; the cron clears
// it after refreshing the snapshot. TTL prevents stuck flags after a restart.
function petchDirtyKey(network, aid) {
  return network === 'signet' ? `petch_dirty:${aid}` : `petch_dirty:${network}:${aid}`;
}
function petchDirtyPrefix(network) {
  return network === 'signet' ? 'petch_dirty:' : `petch_dirty:${network}:`;
}
// Per-asset debounce marker for hint-triggered snapshot refreshes. When a
// burst of pmints lands for the same asset (e.g. FAIR-launch hour with many
// concurrent minters), each hint would otherwise schedule its own
// ~50-page KV.list refresh via ctx.waitUntil — wasted work since the
// snapshot derived by any one of them already incorporates all the others.
// The marker collapses the burst: first hint sets the key (with TTL), every
// hint inside the window short-circuits. Dirty marker still set so the next
// cron tick reconciles regardless. SPEC §5.9 cap-credit lag is bounded by
// PETCH_REFRESH_DEBOUNCE_SECS + cron interval.
function petchRefreshDebounceKey(network, aid) {
  return network === 'signet'
    ? `petch_refresh_debounce:${aid}`
    : `petch_refresh_debounce:${network}:${aid}`;
}

// Mixer-pool KV layout (SPEC §5.10 / §5.11). Three namespaces:
//   pool:<aid>:<denom>                 — POOL_INIT record (vk_cid, ceremony_cid, init_height, init_txid).
//                                        First-confirmed-wins per SPEC §5.10.1.
//   poolleaf:<aid>:<denom>:<h>:<idx>:<txid>
//                                      — single deposit leaf, keyed by canonical position so
//                                        list-order reproduces the merkle tree layout.
//   poolnull:<aid>:<denom>:<nullifier_hex>
//                                      — single withdraw nullifier; existence == spent.
// Network-prefix follows the pmint convention (signet legacy, mainnet prefixed).
function poolInitKey(network, aid, denom) {
  return network === 'signet' ? `pool:${aid}:${denom}` : `pool:${network}:${aid}:${denom}`;
}
function poolPrefix(network) {
  return network === 'signet' ? 'pool:' : `pool:${network}:`;
}
function poolLeafKeyFor(network, aid, denom, height, txIndex, txid) {
  const h = String(height || 0).padStart(10, '0');
  const idx = String(txIndex || 0).padStart(6, '0');
  return network === 'signet'
    ? `poolleaf:${aid}:${denom}:${h}:${idx}:${txid}`
    : `poolleaf:${network}:${aid}:${denom}:${h}:${idx}:${txid}`;
}
function poolLeafPrefix(network, aid, denom) {
  return network === 'signet' ? `poolleaf:${aid}:${denom}:` : `poolleaf:${network}:${aid}:${denom}:`;
}
function poolNullifierKey(network, aid, denom, nullifierHex) {
  return network === 'signet'
    ? `poolnull:${aid}:${denom}:${nullifierHex}`
    : `poolnull:${network}:${aid}:${denom}:${nullifierHex}`;
}
function poolNullifierPrefix(network, aid, denom) {
  return network === 'signet' ? `poolnull:${aid}:${denom}:` : `poolnull:${network}:${aid}:${denom}:`;
}
// SPEC §3.6 — fixed merkle-tree depth L = 20, so each pool caps at
// 2^20 = 1048576 leaves. Without enforcement here, the worker would
// continue to index leaves past the cap; the dapp's mixerAppendLeaf
// rejects them locally so no withdraw could ever credit, but third-
// party indexers running the SPEC strictly would diverge from a worker
// that over-indexes. Counter is per (network, asset_id, denom).
function poolLeafCountKey(network, aid, denom) {
  return network === 'signet' ? `poolcount:${aid}:${denom}` : `poolcount:${network}:${aid}:${denom}`;
}
const POOL_TREE_DEPTH_WORKER = 20;
const POOL_LEAF_CAP = 1 << POOL_TREE_DEPTH_WORKER;
function attestKey(network, aid)       { return network === 'signet' ? `attest:${aid}` : `attest:${network}:${aid}`; }
function attestMintKey(network, aid, txid) {
  return network === 'signet' ? `attest:mint:${aid}:${txid}` : `attest:${network}:mint:${aid}:${txid}`;
}
function openingKey(network, aid, txid, vout) {
  return network === 'signet'
    ? `opening:${aid}:${txid}:${vout}`
    : `opening:${network}:${aid}:${txid}:${vout}`;
}
function openingPrefix(network, aid) {
  return network === 'signet' ? `opening:${aid}:` : `opening:${network}:${aid}:`;
}
function disclosureKey(network, aid, ownerPubHex, thresholdHex) {
  // One disclosure per (asset, owner_pubkey, threshold) — re-publishing
  // overwrites and refreshes the timestamp / UTXO set / proof.
  const tag = `${ownerPubHex}:${thresholdHex}`;
  return network === 'signet'
    ? `disclosure:${aid}:${tag}`
    : `disclosure:${network}:${aid}:${tag}`;
}
function disclosurePrefix(network, aid) {
  return network === 'signet' ? `disclosure:${aid}:` : `disclosure:${network}:${aid}:`;
}
function listingKey(network, aid, txid, vout) {
  return network === 'signet'
    ? `listing:${aid}:${txid}:${vout}`
    : `listing:${network}:${aid}:${txid}:${vout}`;
}
function listingPrefix(network, aid) {
  return network === 'signet' ? `listing:${aid}:` : `listing:${network}:${aid}:`;
}
// Airdrop claim queue: recipients submit signed claim tuples here, issuers
// pull them in batches. Worker is dumb storage — no signature or merkle
// validation (the issuer's dapp re-verifies before broadcast). Per-leaf KV
// keys, zero-padded so KV.list returns claims in numeric leaf-index order.
// Per-root funding-txid nullifier set. Closes the tip-stealing race: a
// recipient who tipped the treasury includes their funding_txid in the claim
// submission; the worker writes both the claim record AND a marker keyed by
// txid in a single KV.put pair. A second submission citing the same
// funding_txid (whether honest retry or an attacker trying to ride someone
// else's tip) fails the existence check and is rejected.
//
// Trade-off: a malicious frontrunner could still see a tip broadcast in the
// mempool and race a claim citing it before the honest recipient submits.
// Closing that fully requires the funding tx to commit to the recipient's
// eth_address (OP_RETURN or a per-eth-address derived funding address), which
// is a bigger feature deferred to a hardened-mode follow-up. For a community
// drop with ~5 USD tips, the race window is small and the attack uneconomic.
function airdropFundingKey(network, rootHex, fundingTxidHex) {
  return network === 'signet'
    ? `airdrop:funding:${rootHex}:${fundingTxidHex}`
    : `airdrop:funding:${network}:${rootHex}:${fundingTxidHex}`;
}

function airdropClaimKey(network, rootHex, leafIndex) {
  const idxPad = String(leafIndex).padStart(10, '0');
  return network === 'signet'
    ? `airdrop:claim:${rootHex}:${idxPad}`
    : `airdrop:claim:${network}:${rootHex}:${idxPad}`;
}
function airdropClaimPrefix(network, rootHex) {
  return network === 'signet'
    ? `airdrop:claim:${rootHex}:`
    : `airdrop:claim:${network}:${rootHex}:`;
}
// Canonical signing message for DELETE /airdrops/:root/claims/:leaf_index.
// Must match the dapp's `airdropClaimDeleteMsgBytes` byte-for-byte.
// Replay is bounded by the timestamp (±5 min window enforced in the handler)
// — without it, a captured sig over a stale claim record could be replayed
// to delete a fresh resubmission of the same leaf_index.
function airdropClaimDeleteMsg(network, rootHex, leafIndex, issuerPubHex, timestamp) {
  const leafLE = new Uint8Array(8); new DataView(leafLE.buffer).setBigUint64(0, BigInt(leafIndex), true);
  const tsLE = new Uint8Array(8); new DataView(tsLE.buffer).setBigUint64(0, BigInt(timestamp), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-airdrop-claim-delete-v1'),
    new Uint8Array([_networkByte(network)]),
    hexToBytes(rootHex),
    leafLE,
    hexToBytes(issuerPubHex),
    tsLE,
  ));
}
// Canonical message the issuer signs to mark a claim as paid. Same shape
// as the delete-msg but with the payout_txid bound in so the sig can't
// be replayed against a different payout. Recipients reading /claims
// can then filter `paid: true` entries out of the backlog metric — the
// alarming "daemon stalled" badge was firing on already-settled claims
// the worker couldn't distinguish from pending ones. Domain string is
// v1 so future changes (e.g. adding a "rejected" reason) can land
// without breaking existing daemons.
function airdropClaimPaidMsg(network, rootHex, leafIndex, issuerPubHex, payoutTxidHex, timestamp) {
  const leafLE = new Uint8Array(8); new DataView(leafLE.buffer).setBigUint64(0, BigInt(leafIndex), true);
  const tsLE = new Uint8Array(8); new DataView(tsLE.buffer).setBigUint64(0, BigInt(timestamp), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-airdrop-claim-paid-v1'),
    new Uint8Array([_networkByte(network)]),
    hexToBytes(rootHex),
    leafLE,
    hexToBytes(issuerPubHex),
    hexToBytes(payoutTxidHex),
    tsLE,
  ));
}
// Range-disclosed listings: one per (maker, asset). Different KV namespace
// from per-UTXO listings so GET prefix-lists don't collide.
function rangeListingKey(network, aid, ownerPubHex) {
  return network === 'signet'
    ? `listing-range:${aid}:${ownerPubHex}`
    : `listing-range:${network}:${aid}:${ownerPubHex}`;
}
function rangeListingPrefix(network, aid) {
  return network === 'signet' ? `listing-range:${aid}:` : `listing-range:${network}:${aid}:`;
}
// Atomic intents — browse-and-take T_AXFER marketplace. Three records per
// intent: the intent itself, the current taker claim, the maker's fulfilment
// (partial reveal targeted at the claimant). intent_id is a 16-hex-char
// sha256-prefix of (commit_txid || maker_pubkey).
// Drop-announcement KV layout. One record per (network, root) — re-announcing
// the same root overwrites (latest wins). Key includes the network byte for
// the same reason every other key does: a single colo cache holds both
// networks' data and prefix scans must not bleed.
function dropAnnounceKey(network, rootHex) {
  return network === 'signet'
    ? `drop-announce:${rootHex}`
    : `drop-announce:${network}:${rootHex}`;
}
function dropAnnouncePrefix(network) {
  return network === 'signet' ? 'drop-announce:' : `drop-announce:${network}:`;
}
function atomicIntentKey(network, aid, intentIdHex) {
  return network === 'signet'
    ? `axintent:${aid}:${intentIdHex}`
    : `axintent:${network}:${aid}:${intentIdHex}`;
}
function atomicIntentPrefix(network, aid) {
  return network === 'signet' ? `axintent:${aid}:` : `axintent:${network}:${aid}:`;
}
function atomicClaimKey(network, aid, intentIdHex) {
  return network === 'signet'
    ? `axclaim:${aid}:${intentIdHex}`
    : `axclaim:${network}:${aid}:${intentIdHex}`;
}
function atomicFulfilmentKey(network, aid, intentIdHex) {
  return network === 'signet'
    ? `axfulfil:${aid}:${intentIdHex}`
    : `axfulfil:${network}:${aid}:${intentIdHex}`;
}
function lastScannedKey(network)       { return network === 'signet' ? 'meta:last_scanned' : `meta:last_scanned:${network}`; }
// Per-asset CXFER+AXFER transfer counter. Exposed on /assets as
// `transfer_count` so the Discover/Market UI can surface "popularity"
// signals (movement is a coarse "is anyone using this?" indicator —
// not legitimacy proof, since self-spam is cheap, but absence of any
// transfers is still a meaningful negative signal). Counter-only design
// (no per-tx records) keeps the read path at one KV.get per asset, well
// inside the Worker subrequest budget. Cron does read-modify-write each
// time it sees a confidential transfer envelope. Re-scan double-counts
// at most a handful of CXFERs in the rare crash-mid-block case.
function transferCountKey(network, aid) {
  return network === 'signet' ? `xfercnt:${aid}` : `xfercnt:${network}:${aid}`;
}
// Per-tx dedupe key for the transfer counter. Both the cron block-scanner and
// the /assets/hint fast-path bump `xfercnt:` for the same on-chain tx; without
// dedupe a hint-broadcast tx would be counted twice (once by the dapp's hint,
// once by the cron when the block finally scans). 30-day TTL is comfortably
// past any cron lag while bounding KV growth (~one entry per CXFER).
function transferSeenKey(network, aid, txidHex) {
  return network === 'signet' ? `xferseen:${aid}:${txidHex}` : `xferseen:${network}:${aid}:${txidHex}`;
}
async function bumpTransferCount(env, network, aid, txidHex) {
  const seenKey = transferSeenKey(network, aid, txidHex);
  if (await env.REGISTRY_KV.get(seenKey)) return false;     // already counted
  const cntKey = transferCountKey(network, aid);
  const cur = parseInt((await env.REGISTRY_KV.get(cntKey)) || '0', 10);
  await env.REGISTRY_KV.put(cntKey, String(cur + 1));
  await env.REGISTRY_KV.put(seenKey, '1', { expirationTtl: 30 * 24 * 3600 });
  return true;
}
// Per-asset distinct-holder counter. We index recipient scriptpubkey
// hashes (the P2WPKH hash160) as a proxy for distinct wallets that
// have ever received this asset — the pubkey itself isn't on-chain at
// receive time, only the hash, so the hash is the strongest signal the
// indexer can derive without recipients spending their UTXOs. Same
// idempotency pattern as bumpTransferCount: a per-(asset, scripthash)
// "seen" marker gates the counter bump so a re-scan / hint replay
// doesn't double-count. No TTL on the seen marker — (asset, recipient)
// is a permanent pair; counting drift after expiry would underflow.
//
// "All-time recipients" semantics — not "current holders." A wallet
// that received and spent its full balance still counts. Frame in UI
// as "wallets" not "users" since same-user-multi-wallet inflates the
// number; this is a popularity signal, not a head count.
function holderCountKey(network, aid) {
  return network === 'signet' ? `holdercnt:${aid}` : `holdercnt:${network}:${aid}`;
}
function holderSeenKey(network, aid, scriptHashHex) {
  return network === 'signet'
    ? `holderseen:${aid}:${scriptHashHex}`
    : `holderseen:${network}:${aid}:${scriptHashHex}`;
}
async function bumpHolderCount(env, network, aid, scriptHashHex) {
  if (!/^[0-9a-f]+$/.test(String(scriptHashHex || ''))) return false;
  const seenKey = holderSeenKey(network, aid, scriptHashHex);
  if (await env.REGISTRY_KV.get(seenKey)) return false;
  const cntKey = holderCountKey(network, aid);
  const cur = parseInt((await env.REGISTRY_KV.get(cntKey)) || '0', 10);
  await env.REGISTRY_KV.put(cntKey, String(cur + 1));
  await env.REGISTRY_KV.put(seenKey, '1');
  return true;
}
// Buyer-opening cache: opt-in storage of a UTXO's (amount, blinding)
// opening, encrypted by the recipient to themselves via ECDH(priv, pub).
// The worker stores the ciphertext + the publisher's declared pubkey;
// only a wallet holding the matching priv can decrypt. Recovery path
// for preauth-take buyers whose localStorage opening write failed
// (quota, browser crash mid-flush) — without this, the UTXO lands as
// h.ghosts on the next scan and the user sees a "failed validation"
// banner until they manually retry.
//
// Threat model: no auth on POST since the ciphertext is encrypted to
// the recipient's pubkey already. A spoofer publishing garbage just
// wastes one KV slot per UTXO; the legitimate buyer's POST overwrites
// (last-write-wins) within the take-broadcast window. If we lose the
// race, recovery just fails (same as today) — never silently mis-
// recovers a wrong opening because the AES-GCM auth tag check would
// reject the ciphertext.
// One-shot backfill for an asset's holder_count. The live cron only
// bumps the counter from its current scan height forward, so an asset
// etched before the holder index existed shows a small count even
// when its true holder set is in the hundreds. This handler walks the
// already-indexed `xferseen:*` keys (30-day TTL) plus the mint
// records, fetches each tx, and bumps holderCount for every
// previously-unseen recipient scriptpubkey. Doesn't touch
// last_scanned, so the live cron keeps catching new blocks in
// parallel.
//
// Chunked: each call processes up to ?limit= keys (default 30, cap
// 100). Caller paginates via the returned next_cursor until
// done=true. Per-call subrequest budget: ~limit × 2 (tx fetch + KV
// gets/puts), comfortably under the 1000 Workers cap.
async function handleBackfillHolders(env, network, cors, opts = {}) {
  if (!checkDebugAuth(opts.req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
  const aid = String(opts.aid || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(aid)) return jsonResponse({ error: 'aid required (64 hex)' }, 400, cors);
  const limit = Math.min(100, Math.max(1, parseInt(opts.limit || '30', 10) || 30));
  const cursor = opts.cursor || undefined;
  // Source 1: xferseen for T_CXFER/T_AXFER recipient discovery. These keys
  // have the form xferseen:[network:]<aid>:<txid> so the prefix scopes to
  // this asset's transfers only.
  const prefix = network === 'signet' ? `xferseen:${aid}:` : `xferseen:${network}:${aid}:`;
  const listOpts = { prefix, limit };
  if (cursor) listOpts.cursor = cursor;
  const list = await env.REGISTRY_KV.list(listOpts);
  let processed = 0, bumped = 0, fetchErrors = 0;
  for (const k of list.keys) {
    const parts = k.name.split(':');
    const txid = parts[parts.length - 1];
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    let tx;
    try { tx = await apiJson(env, `/tx/${txid}`, {}, network); }
    catch { fetchErrors++; continue; }
    // Decode the envelope at vin[0] to determine which vouts are the
    // tacit asset outputs. For T_CXFER and T_AXFER the mapping is
    // identity (output i → vout[i], outputs contiguous from vout[0]).
    // For T_AXFER_VAR (§5.7.9) the layout is INTERLEAVED — tacit at
    // {vout[0], vout[2]}, BTC payment at vout[1], OP_RETURN(80) at
    // vout[3]; we need to skip vout[1] when bumping holder counts.
    const wit = tx?.vin?.[0]?.witness;
    if (!wit || wit.length < 3) continue;
    let envBytes;
    try { envBytes = hexToBytes(wit[1]); } catch { continue; }
    const decoded = decodeEnvelopeScript(envBytes);
    if (!decoded) continue;
    let dec, voutForOutput;
    if (decoded.opcode === T_AXFER) {
      dec = decodeAxferPayload(decoded.payload);
      voutForOutput = (i) => i;
    } else if (decoded.opcode === T_CXFER) {
      dec = decodeCXferPayload(decoded.payload);
      voutForOutput = (i) => i;
    } else if (decoded.opcode === T_AXFER_VAR) {
      dec = decodeAxferVarPayload(decoded.payload);
      voutForOutput = (i) => i === 0 ? 0 : 2;  // interleaved layout
    } else {
      continue;
    }
    if (!dec || dec.asset_id !== aid) continue;
    for (let i = 0; i < dec.outputs.length; i++) {
      const v = voutForOutput(i);
      if (v >= (tx.vout?.length || 0)) continue;
      const spk = tx.vout[v]?.scriptpubkey;
      if (typeof spk === 'string' && spk.length > 0) {
        try {
          const was = await bumpHolderCount(env, network, aid, spk.toLowerCase());
          if (was) bumped++;
        } catch {}
      }
    }
    processed++;
  }
  return jsonResponse({
    ok: true,
    asset_id: aid,
    network,
    processed_this_call: processed,
    newly_bumped: bumped,
    fetch_errors: fetchErrors,
    next_cursor: list.list_complete ? null : (list.cursor || null),
    done: !!list.list_complete,
  }, 200, cors);
}

function buyerOpeningKey(network, txidHex, vout) {
  return network === 'signet'
    ? `buyer-opening:${txidHex}:${vout}`
    : `buyer-opening:${network}:${txidHex}:${vout}`;
}
// Last-traded price record per (network, asset_id). Set by the AXFER hint
// path when the dapp passes price + amount alongside the settlement txid;
// surfaced on /assets and /assets/:id so cards can display "last sold at X
// sats/TAC · 3h ago". Decorative (not security-critical) — the worker can't
// independently verify the price (atomic-intent records may already be GC'd
// by the time the hint arrives), so this trusts the dapp's say-so. Bounded
// damage: a malicious caller can mis-stamp ONE last-trade per asset, gets
// overwritten by the next legitimate trade.
function lastTradeKey(network, aid) {
  return network === 'signet' ? `lasttrade:${aid}` : `lasttrade:${network}:${aid}`;
}

// Daily volume bucket. One key per (network, asset, UTC-day) holding the
// summed sats traded that day. Read-side sums the last two buckets to
// build a rolling-24h figure (cheap: at most 2 KV.gets per asset). The
// 7-day expirationTtl auto-collects stale buckets without a sweeper cron.
function tradeDayKey(network, aid, yyyymmdd) {
  return network === 'signet'
    ? `trade-day:${aid}:${yyyymmdd}`
    : `trade-day:${network}:${aid}:${yyyymmdd}`;
}
function _utcYyyymmdd(tsSeconds) {
  const d = new Date(Math.floor(tsSeconds) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

// Recent-trades ring buffer per asset. Bounded at TRADES_RING_CAP entries.
// Newest first; older entries fall off the end. Each entry is the same
// shape we write to lastTradeKey so client renderers can reuse the same
// formatting code. Stored as a JSON array under one KV key; one read per
// asset page, one write per trade hint. No expirationTtl — once an asset
// has any trades, the ring is "always interesting"; if the asset goes
// idle, the ring is small (≤cap entries × ~100 bytes) and harmless.
// Cap raised 50 → 200 to give the asset-page price chart enough history
// for week+ horizons on actively-traded assets without growing the per-
// asset KV write past a few KB. Each entry is ~100 bytes; 200 × 100 ≈
// 20 KB per asset, well under KV's 25 MB-per-key limit.
const TRADES_RING_CAP = 200;
function tradesRingKey(network, aid) {
  return network === 'signet' ? `trades-ring:${aid}` : `trades-ring:${network}:${aid}`;
}

async function apiText(env, path, opts = {}, network = 'signet') {
  const base = networkApi(env, network);
  const r = await fetch(`${base}${path}`, opts);
  if (!r.ok) throw new Error(`${network} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.text();
}
async function apiJson(env, path, opts = {}, network = 'signet') {
  const base = networkApi(env, network);
  const r = await fetch(`${base}${path}`, opts);
  if (!r.ok) throw new Error(`${network} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Race between dApp broadcasting and mempool.space's /tx/{txid} index seeing
// the tx (typically 1–10s lag for fresh broadcasts). The atomic-intent post
// is the canonical case: dApp broadcasts the commit, then immediately POSTs
// the intent; without retry the worker fail-closes on a tx that's perfectly
// fine. Retries on 404 only — other 4xx/5xx aren't an indexer race and fail
// fast. Backoff schedule is ~7s total wall clock (well under the Worker's
// 30s soft cap). Confirmed broadcasts of older txs (asset UTXO, parent
// envelopes) don't need this and keep using apiJson directly.
async function fetchFreshTxJson(env, txid, network, maxAttempts = 4) {
  const base = networkApi(env, network);
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * (1 << (i - 1))));
    const r = await fetch(`${base}/tx/${txid}`);
    if (r.ok) return r.json();
    if (r.status !== 404) {
      throw new Error(`${network} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    lastErr = new Error(`${network} 404: tx not yet indexed`);
  }
  throw lastErr;
}

// ============== /pin ==============
function startsWith(b, prefix) {
  if (b.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[i] !== prefix[i]) return false;
  return true;
}
function isWebP(b) {
  return b.length > 12
    && b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46
    && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50;
}
function magicMatches(bytes, mime) {
  if (mime === 'image/png')  return startsWith(bytes, PNG_MAGIC);
  if (mime === 'image/jpeg') return startsWith(bytes, JPEG_MAGIC);
  if (mime === 'image/webp') return isWebP(bytes);
  return false;
}

async function handlePin(req, env, cors) {
  if (!env.PINATA_JWT) {
    return jsonResponse({ error: 'server not configured (PINATA_JWT missing)' }, 500, cors);
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `pin:${day}:${ip}`;
  const dailyLimit = safeInt(env.DAILY_LIMIT, 20, { min: 0 });
  const prior = safeInt(await env.UPLOAD_KV.get(kvKey), 0, { min: 0 });
  if (prior >= dailyLimit) {
    return jsonResponse({ error: 'daily upload limit reached' }, 429, cors);
  }

  let fd;
  try { fd = await req.formData(); }
  catch { return jsonResponse({ error: 'expected multipart form-data' }, 400, cors); }
  const file = fd.get('file');
  if (!(file instanceof File)) {
    return jsonResponse({ error: 'missing form field "file"' }, 400, cors);
  }
  const maxBytes = safeInt(env.MAX_BYTES, 2 * 1024 * 1024, { min: 1 });
  if (file.size > maxBytes) {
    return jsonResponse({ error: `file exceeds ${maxBytes} bytes` }, 413, cors);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return jsonResponse({ error: `mime not allowed: ${file.type}` }, 415, cors);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!magicMatches(bytes, file.type)) {
    return jsonResponse({ error: 'file content does not match declared mime' }, 415, cors);
  }

  const ext = file.type.split('/')[1];
  const pinFd = new FormData();
  pinFd.append('file', new Blob([bytes], { type: file.type }), `tacit-${Date.now()}.${ext}`);
  pinFd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  let pinResp;
  try {
    pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
      body: pinFd,
    });
  } catch { return jsonResponse({ error: 'pinata unreachable' }, 502, cors); }
  if (!pinResp.ok) {
    // Don't echo Pinata's response body to the client — some upstreams include
    // request-context (auth headers, internal IDs) in error bodies, and the
    // bearer JWT is long enough to fit in 240 chars. Log server-side; return
    // only the status code to the caller.
    try { console.error(`pinata ${pinResp.status}: ${(await pinResp.text()).slice(0, 240)}`); } catch {}
    return jsonResponse({ error: `pinata error (status ${pinResp.status})` }, 502, cors);
  }
  const j = await pinResp.json();
  if (!j.IpfsHash) return jsonResponse({ error: 'pinata returned no CID' }, 502, cors);

  await env.UPLOAD_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
  return jsonResponse({ cid: j.IpfsHash, size: j.PinSize ?? bytes.length }, 200, cors);
}

// ============== Ceremony coordination (Groth16 Phase 2 MPC) ==============
// Browser-driven public ceremony: anyone can fetch the current head zkey,
// run snarkjs.zKey.contribute locally, and upload their new zkey to extend
// the chain. Worker is convenience — pins to IPFS, advances head pointer,
// records attestations. NOT a trust target: anyone can re-walk the chain
// of CIDs and verify each contribution independently via snarkjs.zKey.verify.
//
// State per circuit:
//   ceremony:<circuit_hash>            — head state JSON
//   ceremony:<circuit_hash>:contrib:<idx>:<cid>  — per-contribution record
//
// Concurrency: optimistic. Contributors submit `prev_cid`; if it doesn't
// match the current head, return 409 and the contributor refreshes + retries.
// Under load, only one contribution per (circuit, head) lands per round-trip.

// Coordinator-only operations gate. Set via `wrangler secret put
// CEREMONY_INIT_TOKEN` (a long random token). Required for /ceremony/init,
// /reset, and /finalize. Without the secret, those endpoints return 503 —
// preventing accidental open-init in production. Per-IP rate limit still
// applies on top.
function ceremonyAuthOk(req, env) {
  const expected = env.CEREMONY_INIT_TOKEN;
  if (!expected) return false; // refuse coordinator-only ops if no token configured
  const presented = req.headers.get('x-tacit-init-token') || '';
  if (!presented || presented.length !== expected.length) return false;
  // Constant-time comparison.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

function ceremonyKey(hash)              { return `ceremony:${hash}`; }
// Drain state lives in its OWN KV key, NOT inside the ceremony state
// object. Storing drain_until in state.drain_until would create a
// classic eventual-consistency race: drain reads state, sets the
// flag, writes state. If a contribute lands between drain's read
// and drain's write, drain's write overwrites the contribute's chain
// advance. Separate key = drain and contribute never write the same
// KV entry. Auto-expires via expirationTtl so even a coordinator
// crash post-drain doesn't permanently block contributions.
function ceremonyDrainKey(hash)         { return `ceremony:${hash}:drain_until`; }
function ceremonyContribKey(hash, idx, cid) {
  return `ceremony:${hash}:contrib:${String(idx).padStart(8, '0')}:${cid}`;
}
function ceremonyContribPrefix(hash)    { return `ceremony:${hash}:contrib:`; }

// Magic-byte tags at offset 0 in snarkjs file formats. Validated server-side
// before pinning so a malicious client can't waste contributors' bandwidth
// (and our Pinata storage) on garbage that the next contributor would only
// detect after a 5-MB download + verifyFromR1cs failure.
const _CEREMONY_MAGIC = {
  zkey: [0x7a, 0x6b, 0x65, 0x79], // "zkey"
  r1cs: [0x72, 0x31, 0x63, 0x73], // "r1cs"
  ptau: [0x70, 0x74, 0x61, 0x75], // "ptau"
};
function _hasCeremonyMagic(bytes, kind) {
  const m = _CEREMONY_MAGIC[kind];
  if (!bytes || bytes.length < m.length) return false;
  for (let i = 0; i < m.length; i++) if (bytes[i] !== m[i]) return false;
  return true;
}

// Pin an arbitrary binary blob to IPFS. Used for zkey files (~5 MB each).
// MAX_BYTES env var caps total upload size; we want zkeys to fit so we
// override locally to 16 MB minimum (the env default of 2 MB is for images).
async function pinBinaryToIpfs(env, bytes, filename, contentType = 'application/octet-stream') {
  const pinFd = new FormData();
  pinFd.append('file', new Blob([bytes], { type: contentType }), filename);
  pinFd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
    body: pinFd,
  });
  if (!pinResp.ok) {
    const txt = await pinResp.text().catch(() => '');
    throw new Error(`pinata ${pinResp.status}: ${txt.slice(0, 240)}`);
  }
  const j = await pinResp.json();
  if (!j.IpfsHash) throw new Error('pinata returned no CID');
  return j.IpfsHash;
}

// POST /ceremony/init — start a new ceremony. Multipart form with three
// files (zkey0, r1cs, ptau) + form field circuit_hash (sha256 of r1cs in hex).
// First-write-wins per circuit_hash.
async function handleCeremonyInit(req, env, cors) {
  if (!env.PINATA_JWT) return jsonResponse({ error: 'PINATA_JWT missing' }, 500, cors);
  // SECURITY: coordinator-only. Without auth, an attacker could squat the
  // canonical (asset_id, denomination) pair by racing /ceremony/init with a
  // bad ptau the moment the r1cs file is published.
  if (!ceremonyAuthOk(req, env)) {
    if (!env.CEREMONY_INIT_TOKEN) {
      return jsonResponse({ error: 'CEREMONY_INIT_TOKEN not configured on worker — set via wrangler secret put' }, 503, cors);
    }
    return jsonResponse({ error: 'unauthorized — set X-Tacit-Init-Token header' }, 401, cors);
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `pin:${day}:${ip}`;
  const dailyLimit = safeInt(env.DAILY_LIMIT, 20, { min: 0 });
  const prior = safeInt(await env.UPLOAD_KV.get(kvKey), 0, { min: 0 });
  if (prior >= dailyLimit) return jsonResponse({ error: 'daily upload limit reached' }, 429, cors);

  let fd;
  try { fd = await req.formData(); }
  catch { return jsonResponse({ error: 'expected multipart form-data' }, 400, cors); }

  const circuitHash = String(fd.get('circuit_hash') || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'circuit_hash must be 64 hex chars (sha256 of r1cs)' }, 400, cors);
  }
  const initiatorName = String(fd.get('initiator_name') || 'anonymous').slice(0, 64);

  // Refuse if already initialized.
  const existing = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (existing) return jsonResponse({ error: 'ceremony already initialized', state: existing }, 409, cors);

  // Bound files at 32 MB each. zkey for our circuit is ~5 MB; ptau14 is ~18 MB;
  // r1cs is small. CF Worker request body cap is 100 MB so 32 MB × 3 fits.
  const MAX_PER_FILE = 32 * 1024 * 1024;
  const zkey = fd.get('zkey0');
  const r1cs = fd.get('r1cs');
  const ptau = fd.get('ptau');
  if (!(zkey instanceof File) || !(r1cs instanceof File) || !(ptau instanceof File)) {
    return jsonResponse({ error: 'expected files: zkey0, r1cs, ptau' }, 400, cors);
  }
  if (zkey.size > MAX_PER_FILE || r1cs.size > MAX_PER_FILE || ptau.size > MAX_PER_FILE) {
    return jsonResponse({ error: `each file must be <= ${MAX_PER_FILE} bytes` }, 413, cors);
  }

  // Read once + magic-byte sniff before any Pinata I/O. Rejects garbage uploads
  // up front rather than letting them land in the chain head where the next
  // contributor's snarkjs verifyFromR1cs would catch them after a 5-MB download.
  const zkeyBytes = new Uint8Array(await zkey.arrayBuffer());
  const r1csBytes = new Uint8Array(await r1cs.arrayBuffer());
  const ptauBytes = new Uint8Array(await ptau.arrayBuffer());
  if (!_hasCeremonyMagic(zkeyBytes, 'zkey')) {
    return jsonResponse({ error: 'zkey0 does not start with snarkjs "zkey" magic bytes' }, 400, cors);
  }
  if (!_hasCeremonyMagic(r1csBytes, 'r1cs')) {
    return jsonResponse({ error: 'r1cs does not start with snarkjs "r1cs" magic bytes' }, 400, cors);
  }
  if (!_hasCeremonyMagic(ptauBytes, 'ptau')) {
    return jsonResponse({ error: 'ptau does not start with snarkjs "ptau" magic bytes' }, 400, cors);
  }

  let zkeyCid, r1csCid, ptauCid;
  try {
    zkeyCid = await pinBinaryToIpfs(env, zkeyBytes, `withdraw_0000_${circuitHash.slice(0,8)}.zkey`);
    r1csCid = await pinBinaryToIpfs(env, r1csBytes, `withdraw_${circuitHash.slice(0,8)}.r1cs`);
    ptauCid = await pinBinaryToIpfs(env, ptauBytes, `pot_${circuitHash.slice(0,8)}.ptau`);
  } catch (e) {
    return jsonResponse({ error: 'pin failed: ' + (e.message || 'unknown') }, 502, cors);
  }

  const state = {
    circuit_hash: circuitHash,
    head_cid: zkeyCid,
    contribution_count: 0,
    r1cs_cid: r1csCid,
    ptau_cid: ptauCid,
    started_at: Math.floor(Date.now() / 1000),
    initiator: initiatorName,
    last_contributor: initiatorName,
  };
  await env.REGISTRY_KV.put(ceremonyKey(circuitHash), JSON.stringify(state));
  // Also record the genesis as contribution index 0 so the attestations list
  // has a complete chain from the start.
  const initRec = {
    index: 0,
    cid: zkeyCid,
    contributor_name: initiatorName,
    contribution_hash: '',
    contributed_at: state.started_at,
    prev_cid: '',
  };
  await env.REGISTRY_KV.put(ceremonyContribKey(circuitHash, 0, zkeyCid), JSON.stringify(initRec));

  await env.UPLOAD_KV.put(kvKey, String(prior + 1), { expirationTtl: 60 * 60 * 25 });
  return jsonResponse({ state }, 200, cors);
}

// Edge-cache wrapper for ceremony GET endpoints. Fronts hot-path reads
// (state, stats, default-mode attestations) with Cloudflare's per-PoP
// edge cache so polling traffic from many concurrent dapp tabs collapses
// into one real KV lookup per PoP per TTL window. Without this, every
// dapp tab that's open during a ceremony hits the KV namespace on its
// poll interval — multiplied across thousands of contributors during a
// public push, KV op cost dominates the worker bill.
//
// TTLs are intentionally short (5–30s) so dapp progress views stay
// reactive. The cron's 5-minute scheduled scan is the upper bound on
// "real" state-change frequency, and these TTLs are well below that.
//
// NOT used for cursor-based /attestations (one-shot audit walks — caching
// across distinct cursors has no payoff) or any non-GET method.
async function ceremonyCacheGet(ctx, cors, ttlSeconds, cacheKeyUrl, computeFn) {
  const cache = caches.default;
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAtStr = cached.headers.get('X-Cached-At');
    const ageMs = cachedAtStr ? Date.now() - parseInt(cachedAtStr, 10) : Infinity;
    if (ageMs < ttlSeconds * 1000) {
      const body = await cached.text();
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      headers.set('X-Cache', 'HIT');
      return new Response(body, { status: cached.status, headers });
    }
  }
  const fresh = await computeFn();
  if (fresh.status === 200) {
    const body = await fresh.clone().text();
    const cacheHeaders = new Headers();
    cacheHeaders.set('Content-Type', 'application/json');
    cacheHeaders.set('X-Cached-At', String(Date.now()));
    cacheHeaders.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    const cacheable = new Response(body, { status: 200, headers: cacheHeaders });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(cacheKey, cacheable));
    } else {
      await cache.put(cacheKey, cacheable);
    }
  }
  return fresh;
}

async function handleCeremonyState(env, circuitHash, cors) {
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const state = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!state) return jsonResponse({ error: 'ceremony not found' }, 404, cors);
  return jsonResponse({ state }, 200, cors);
}

// POST /ceremony/:circuit_hash/contribute
// Multipart form: zkey (file), contributor_name (string ≤ 64), prev_cid (string),
// contribution_hash (string, snarkjs's "Contribution Hash" output, ≤ 256 chars).
// Optimistic concurrency: prev_cid must match current head_cid.
// Invalidate the ceremony GET endpoint caches after a contribute lands.
// Without this, the dapp's post-flight "did my upload appear in the
// attestations index?" check hits the stale 30s edge cache and shows
// "Uploaded but not yet verified" until the cache expires — even though
// the worker accepted the upload and wrote the contrib record. Called
// from handleCeremonyContribute after every successful state advance.
async function _invalidateCeremonyCache(ctx, circuitHash) {
  const cache = caches.default;
  const ops = [
    cache.delete(`https://_ceremony-cache_/state/${circuitHash}`),
    cache.delete(`https://_ceremony-cache_/stats/${circuitHash}`),
  ];
  // /attestations cache is keyed by limit because different limits return
  // different slices. Invalidate the values dapp + tooling actually use;
  // any limit not listed here will simply re-cache fresh on its next miss
  // (no correctness impact — just one extra MISS hit). The default-100
  // is the most important since the dapp's verify-after call uses it.
  for (const limit of ['5', '10', '20', '50', '100', '1000']) {
    ops.push(cache.delete(`https://_ceremony-cache_/attestations/${circuitHash}/${limit}`));
  }
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(Promise.allSettled(ops));
  } else {
    await Promise.allSettled(ops);
  }
}

async function handleCeremonyContribute(req, env, circuitHash, cors, ctx) {
  if (!env.PINATA_JWT) return jsonResponse({ error: 'PINATA_JWT missing' }, 500, cors);
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const state = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!state) return jsonResponse({ error: 'ceremony not found — initialize first' }, 404, cors);
  if (state.finalized) return jsonResponse({ error: 'ceremony has been finalized; chain is locked' }, 409, cors);

  // Drain check — coordinator may have paused contributions while
  // running finalize, since the pre-flight (download + beacon + verify)
  // takes 3-7 min at scale and any contribute landing during that
  // window would race the final CAS check. drain_until lives in its own
  // KV key (not in state) so drain and contribute never write the same
  // entry. Once it's in the past (or absent), contributions auto-resume.
  // Returns 423 (Locked) so the dapp can distinguish from other 4xx.
  const _checkDrain = async () => {
    const now = Math.floor(Date.now() / 1000);
    const drainStr = await env.REGISTRY_KV.get(ceremonyDrainKey(circuitHash));
    const drainUntil = drainStr ? parseInt(drainStr, 10) : 0;
    if (drainUntil && now < drainUntil) {
      return { rejected: true, drainUntil, remaining: drainUntil - now };
    }
    return { rejected: false };
  };
  {
    const d = await _checkDrain();
    if (d.rejected) {
      return jsonResponse({
        error: `ceremony is being finalized; contributions paused for ~${d.remaining}s`,
        drain_until: d.drainUntil,
      }, 423, cors);
    }
  }

  // Per-IP rate limit reuses the upload KV — 500 contributions/IP/day. The
  // cap is sized for a coordinated push toward gold-tier (1100+) where power
  // contributors carry many contributions from the same machine; below this,
  // a single laptop running contributions back-to-back tops out at ~5–8h of
  // compute (each contribution ~30–60s), which is the natural sanity ceiling.
  // The cap exists for spam mitigation, not soundness — Phase 2 is robust to
  // repeat contributions from the same source (each still mixes fresh entropy
  // into the chain). Raising the cap does NOT weaken the ceremony; it only
  // affects how the diversity story reads in attestations.
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `ceremony:${day}:${ip}`;
  const prior = safeInt(await env.UPLOAD_KV.get(rlKey), 0, { min: 0 });
  if (prior >= 500) return jsonResponse({ error: 'rate limited (500/day per IP)' }, 429, cors);

  let fd;
  try { fd = await req.formData(); }
  catch { return jsonResponse({ error: 'expected multipart form-data' }, 400, cors); }
  const zkey = fd.get('zkey');
  const contributorName = String(fd.get('contributor_name') || 'anonymous').slice(0, 64);
  const prevCid = String(fd.get('prev_cid') || '');
  const contribHash = String(fd.get('contribution_hash') || '').slice(0, 256);
  if (!(zkey instanceof File)) return jsonResponse({ error: 'missing form field "zkey"' }, 400, cors);
  if (zkey.size > 32 * 1024 * 1024) return jsonResponse({ error: 'zkey too large (max 32 MB)' }, 413, cors);
  if (!prevCid || prevCid !== state.head_cid) {
    return jsonResponse({
      error: 'stale prev_cid — ceremony advanced before your upload landed; refresh and retry',
      head_cid: state.head_cid,
      contribution_count: state.contribution_count,
    }, 409, cors);
  }

  // Magic-byte sniff before pinning — rejects non-zkey blobs up front.
  const zkeyBytes = new Uint8Array(await zkey.arrayBuffer());
  if (!_hasCeremonyMagic(zkeyBytes, 'zkey')) {
    return jsonResponse({ error: 'zkey does not start with snarkjs "zkey" magic bytes' }, 400, cors);
  }

  let newCid;
  try {
    newCid = await pinBinaryToIpfs(env, zkeyBytes, `withdraw_${String(state.contribution_count + 1).padStart(4, '0')}_${circuitHash.slice(0,8)}.zkey`);
  } catch (e) {
    return jsonResponse({ error: 'pin failed: ' + (e.message || 'unknown') }, 502, cors);
  }

  // Re-read state for the CAS — concurrent contributions can race here.
  // If the head moved between our initial check and the pin, reject. We
  // accept the cost of a wasted Pinata pin in that case (cheap relative to
  // the social cost of dropping the contributor's actual entropy).
  const fresh = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!fresh || fresh.head_cid !== prevCid) {
    return jsonResponse({
      error: 'lost CAS race — another contribution landed first; refresh and retry',
      head_cid: fresh ? fresh.head_cid : null,
    }, 409, cors);
  }
  // Re-check drain too — without this, a contribute that started just
  // BEFORE drain was set could complete its pin AFTER drain takes effect
  // and slip through (since head_cid is unchanged from the pre-pin read).
  // Drain is supposed to freeze the chain during finalize; the only way
  // to honor that is to re-check here, post-pin.
  {
    const d = await _checkDrain();
    if (d.rejected) {
      return jsonResponse({
        error: `ceremony was put into drain during your contribute; pin pre-empted by finalize. Try again after drain expires.`,
        drain_until: d.drainUntil,
      }, 423, cors);
    }
  }

  const newCount = (fresh.contribution_count || 0) + 1;
  const newState = {
    ...fresh,
    head_cid: newCid,
    contribution_count: newCount,
    last_contributor: contributorName,
    last_contributed_at: Math.floor(Date.now() / 1000),
  };
  await env.REGISTRY_KV.put(ceremonyKey(circuitHash), JSON.stringify(newState));

  const rec = {
    index: newCount,
    cid: newCid,
    contributor_name: contributorName,
    contribution_hash: contribHash,
    contributed_at: newState.last_contributed_at,
    prev_cid: prevCid,
  };
  await env.REGISTRY_KV.put(ceremonyContribKey(circuitHash, newCount, newCid), JSON.stringify(rec));

  await env.UPLOAD_KV.put(rlKey, String(prior + 1), { expirationTtl: 60 * 60 * 25 });
  // Invalidate the GET-endpoint edge caches BEFORE responding so the
  // contributor's immediate post-flight verification (which calls
  // /attestations to look for their just-landed contribution_hash) sees
  // a fresh response, not a 30s-stale cache miss-as-not-found. Uses
  // ctx.waitUntil so the cache.delete fanout doesn't block the response.
  await _invalidateCeremonyCache(ctx, circuitHash);
  return jsonResponse({ state: newState, contribution: rec }, 200, cors);
}

async function handleCeremonyAttestations(req, env, url, circuitHash, cors) {
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  // Cap at 800 (down from 1000) so the per-page KV.gets — now run via
  // Promise.all below for ~100x speedup over sequential — stay under
  // Cloudflare's 1000-subrequest-per-invocation ceiling. 800 KV.gets +
  // 1 KV.list + headroom for cache + auth checks. Without parallelism
  // the worker's per-page response time was 130-180s for 1000 records,
  // exceeding the 120s curl timeout in the bundle pagination script.
  const limit = Math.max(1, Math.min(safeInt(url.searchParams.get('limit'), 100, { min: 1, max: 800 }), 800));
  // Distinguish "cursor key absent" (recent mode) from "cursor key present
  // but empty" (cursor mode starting from beginning). Auditors paginating
  // the full chain hit `?cursor=` for the first call — without this
  // distinction they'd land in recent mode and only see the alphabetically-
  // last `limit` records, missing the genesis + early contributions.
  const hasCursor = url.searchParams.has('cursor');
  const cursor = hasCursor ? url.searchParams.get('cursor') : null;
  // Two modes:
  //
  // 1. **Cursor mode** (`?cursor=<token>` or `?cursor=` for start-of-chain):
  //    forward-pagination through the full record set. Each call returns up
  //    to `limit` records starting from the cursor (or from the beginning
  //    if cursor is empty), plus a next-page cursor. Used by audit tooling
  //    that needs every record (e.g., post-finalize verification, bulk
  //    export, ceremony bundle attestations.json).
  //
  // 2. **Recent mode** (no cursor key, default): returns the *truly* latest
  //    `limit` records by walking every page server-side and slicing the
  //    last `limit` from the alphabetically-sorted list. This is what UI
  //    "recent contributions" panels actually want.
  if (hasCursor) {
    const listOpts = {
      prefix: ceremonyContribPrefix(circuitHash),
      limit,
    };
    // Empty cursor string = start from beginning of the prefix range.
    // Non-empty cursor string = continue from that opaque KV cursor.
    if (cursor) listOpts.cursor = cursor;
    const list = await env.REGISTRY_KV.list(listOpts);
    // Parallel KV.gets — Promise.all over 800 reads completes in 1-3s
    // vs the 130-180s a sequential await loop would take. KV is reliable
    // enough that fail-fast (Promise.all) is fine; allSettled-and-filter
    // would just hide transient errors that the caller should retry on.
    const fetched = await Promise.all(
      list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')),
    );
    const attestations = fetched.filter(r => r);
    attestations.reverse();
    const body = {
      attestations,
      count: attestations.length,
      list_complete: list.list_complete !== false,
    };
    if (!body.list_complete && list.cursor) body.cursor = list.cursor;
    return jsonResponse(body, 200, cors);
  }
  // Recent mode — walk every page, take the last `limit` keys.
  let allKeys = [];
  let walkCursor;
  for (let p = 0; p < 50; p++) {
    const opts = { prefix: ceremonyContribPrefix(circuitHash), limit: 1000 };
    if (walkCursor) opts.cursor = walkCursor;
    const list = await env.REGISTRY_KV.list(opts);
    allKeys = allKeys.concat(list.keys);
    if (list.list_complete !== false) break;
    walkCursor = list.cursor;
    if (!walkCursor) break;
  }
  // Slice the alphabetically-last `limit` keys = highest idx values =
  // most recent contributions. Then reverse for newest-first UI ordering.
  // Parallel KV.gets via Promise.all for the same speedup as cursor mode.
  // limit is already capped at 800 above; combined with the ~20 sequential
  // KV.list calls in the walk above, we stay under the 1000-subrequest cap.
  const recentKeys = allKeys.slice(Math.max(0, allKeys.length - limit));
  const fetched = await Promise.all(
    recentKeys.map(k => env.REGISTRY_KV.get(k.name, 'json')),
  );
  const attestations = fetched.filter(r => r);
  attestations.reverse();
  return jsonResponse({
    attestations,
    count: attestations.length,
    total: allKeys.length,
    list_complete: true,
  }, 200, cors);
}

// GET /ceremony/:circuit_hash/stats — lightweight progress numbers without
// downloading the full attestations index. Walks every contribution record
// server-side via cursor pagination and returns only the aggregate counts:
//
//   - contribution_count        the live state's counter (raw accepts)
//   - total_attestation_records every contrib record in KV (some are
//                                CAS-race orphans whose CID isn't in the
//                                canonical chain)
//   - unique_chain_advances     distinct `index` values across all records
//                                — this is the *true* chain depth and the
//                                meaningful number for ceremony soundness
//   - distinct_contributor_names number of distinct contributor names —
//                                a proxy for trust-root diversity
//
// This endpoint is the durable way to track progress past the 1000-record
// /attestations cap. Callers should poll this endpoint, not /attestations,
// when measuring "have we hit our gold-tier target".
async function handleCeremonyStats(req, env, circuitHash, cors) {
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const state = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!state) return jsonResponse({ error: 'ceremony not found' }, 404, cors);
  // Walk all contribution keys via KV.list ONLY — no per-record KV.get.
  // KV.get on every record would scale at ~5–30ms × N and blow past the
  // Cloudflare worker CPU budget once the ceremony grows past ~1000
  // records. The KV key itself encodes everything we need for counts:
  //
  //   ceremony:<hash>:contrib:<padded-idx>:<cid>
  //
  // We parse `padded-idx` directly out of the key after stripping the
  // prefix, so the loop is O(records) in list calls (≈ records/1000) and
  // does zero per-record reads. This keeps the stats endpoint fast even
  // as the ceremony grows past 10k+ raw records.
  //
  // Note: distinct contributor name count was dropped from this endpoint
  // for the same scale reason — that field requires KV.get per record.
  // Anyone who wants distinct-name counting can paginate through
  // /attestations?cursor=… and aggregate client-side, or we can ship a
  // separate (cached) /contributor-names endpoint later if needed.
  const prefix = ceremonyContribPrefix(circuitHash);
  const uniqueIdx = new Set();
  let totalRecords = 0;
  let cursor;
  for (let page = 0; page < 50; page++) {
    const listOpts = { prefix, limit: 1000 };
    if (cursor) listOpts.cursor = cursor;
    const list = await env.REGISTRY_KV.list(listOpts);
    for (const k of list.keys) {
      totalRecords++;
      const tail = k.name.slice(prefix.length);
      const idxStr = tail.split(':')[0];
      const idxNum = parseInt(idxStr, 10);
      if (Number.isFinite(idxNum)) uniqueIdx.add(idxNum);
    }
    if (list.list_complete !== false) break;
    cursor = list.cursor;
    if (!cursor) break;
  }
  return jsonResponse({
    circuit_hash: circuitHash,
    contribution_count: state.contribution_count || 0,
    finalized: !!state.finalized,
    total_attestation_records: totalRecords,
    unique_chain_advances: uniqueIdx.size,
    last_contributor: state.last_contributor || null,
    last_contributed_at: state.last_contributed_at || null,
  }, 200, cors);
}

// POST /ceremony/:circuit_hash/reset — admin operation. Wipes the ceremony
// state + all contributions for the given hash. Used to re-bootstrap a
// contaminated ceremony (e.g., when the initial Phase 1 ptau was discovered
// to be single-party and you need to start over). Auth-gated via
// CEREMONY_INIT_TOKEN, same as /ceremony/init.
async function handleCeremonyReset(req, env, circuitHash, cors) {
  if (!ceremonyAuthOk(req, env)) {
    return jsonResponse({ error: 'unauthorized' }, 401, cors);
  }
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  // Delete the head state + every contribution record. Paginate via
  // cursor — Tornado's reference 1100-contribution ceremony exceeds the
  // 1000-key page limit, so a single list() would leave a tail of stale
  // records that would re-emerge under the next init's attestations
  // endpoint with conflicting indices.
  const prefix = ceremonyContribPrefix(circuitHash);
  let cursor = undefined, deleted = 0;
  for (let page = 0; page < 100; page++) {
    const list = await env.REGISTRY_KV.list({ prefix, limit: 1000, cursor });
    for (const k of list.keys) {
      await env.REGISTRY_KV.delete(k.name);
      deleted++;
    }
    if (list.list_complete !== false) break;
    cursor = list.cursor;
    if (!cursor) break;
  }
  await env.REGISTRY_KV.delete(ceremonyKey(circuitHash));
  // Clear the drain key too — without this, post-reset contributes are
  // 423'd until the drain TTL expires (up to ~35 min), with no way to
  // undo. drain key may not exist if drain was never set; .delete is
  // idempotent so this is safe regardless.
  await env.REGISTRY_KV.delete(ceremonyDrainKey(circuitHash));
  return jsonResponse({ ok: true, deleted: deleted + 1 }, 200, cors);
}

// POST /ceremony/:circuit_hash/finalize — coordinator finalizes the ceremony
// by uploading a beacon-applied zkey. After finalize, the ceremony is locked:
// further contribute calls are rejected. Multipart form: zkey (file),
// beacon_block_hash (hex string for audit trail), beacon_iterations (int).
// SPEC §3.7's beacon application closes the late-Sybil collusion window.
// POST /ceremony/:circuit_hash/drain — coordinator pauses new contributes
// for a bounded window. Used before running finalize at scale: the pre-
// flight (download + beacon + verify) takes 3-7 min for a 2000+ contrib
// chain, and any contribute landing during that window would race the
// final CAS check. Setting a drain window before pre-flight starts
// guarantees the chain is stable while we beacon. drain_until is an
// absolute timestamp; expires automatically (no separate undrain
// needed) so a failed finalize doesn't permanently block contributions.
//
// Multipart form: duration_seconds (optional, default 1800 = 30 min,
// max 7200 = 2 hours).
async function handleCeremonyDrain(req, env, circuitHash, cors, ctx) {
  if (!ceremonyAuthOk(req, env)) {
    return jsonResponse({ error: 'unauthorized' }, 401, cors);
  }
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const state = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!state) return jsonResponse({ error: 'ceremony not found' }, 404, cors);
  if (state.finalized) return jsonResponse({ error: 'ceremony already finalized; drain is moot' }, 409, cors);

  // safeInt always returns a finite number (clamps invalid/missing
  // input to default), so no isFinite guard needed. Default 1800s
  // covers a typical pre-flight window with margin.
  let durationSecs = 1800;
  try {
    const fd = await req.formData();
    durationSecs = safeInt(fd.get('duration_seconds'), 1800, { min: 60, max: 7200 });
  } catch { /* form-data parse failure → use default duration */ }

  const now = Math.floor(Date.now() / 1000);
  const drainUntil = now + durationSecs;
  // Write to a SEPARATE KV key — never touch the ceremony state object.
  // expirationTtl auto-cleans the key after the drain window + 5min
  // buffer, so even a coordinator crash post-drain doesn't permanently
  // block contributions: KV deletes the key on its own.
  await env.REGISTRY_KV.put(
    ceremonyDrainKey(circuitHash),
    String(drainUntil),
    { expirationTtl: durationSecs + 300 },
  );
  // No need to invalidate /ceremony/<hash> cache — drain_until is no
  // longer in that response shape. /contribute reads the drain key
  // directly each invocation, so it always sees the current value.
  return jsonResponse({
    ok: true,
    drain_until: drainUntil,
    duration_seconds: durationSecs,
    message: `contributions paused until ${new Date(drainUntil * 1000).toISOString()}`,
  }, 200, cors);
}

async function handleCeremonyFinalize(req, env, circuitHash, cors, ctx) {
  if (!ceremonyAuthOk(req, env)) {
    return jsonResponse({ error: 'unauthorized' }, 401, cors);
  }
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const state = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!state) return jsonResponse({ error: 'ceremony not found' }, 404, cors);
  if (state.finalized) return jsonResponse({ error: 'ceremony already finalized', state }, 409, cors);

  // Defense-in-depth contribution-count floor. The operator's finalize.sh
  // enforces MIN_CONTRIBUTIONS=2000 (overridable), but a hand-POSTed finalize
  // bypasses that. MIN_CEREMONY_CONTRIBUTIONS is an opt-in env var (no
  // default — preserves existing behavior unless deliberately set) so a fresh
  // operator deploying a new ceremony can choose their floor without code
  // changes. Mismatch returns 400 so the caller can correct + retry rather
  // than silently shipping a low-trust ceremony.
  const minContribs = safeInt(env.MIN_CEREMONY_CONTRIBUTIONS, 0, { min: 0 });
  if (minContribs > 0 && (state.contribution_count || 0) < minContribs) {
    return jsonResponse({
      error: `contribution_count=${state.contribution_count || 0} below MIN_CEREMONY_CONTRIBUTIONS=${minContribs}`,
    }, 400, cors);
  }

  let fd;
  try { fd = await req.formData(); }
  catch { return jsonResponse({ error: 'expected multipart form-data' }, 400, cors); }
  const zkey = fd.get('zkey');
  const beaconHash = String(fd.get('beacon_block_hash') || '').toLowerCase();
  // Tightened range: snarkjs's beacon() rejects values outside [10, 63]
  // (cli.cjs hard-coded bound). Looser bounds here would let a hand-
  // crafted POST through worker validation only to fail at snarkjs apply
  // time on the contributor's machine — bad UX. Reject invalid values
  // explicitly with 400 instead of silently coercing to default 10.
  const beaconItersRaw = String(fd.get('beacon_iterations') || '');
  if (!/^\d+$/.test(beaconItersRaw)) {
    return jsonResponse({ error: 'beacon_iterations must be a positive integer in [10, 63]' }, 400, cors);
  }
  const beaconIters = parseInt(beaconItersRaw, 10);
  if (beaconIters < 10 || beaconIters > 63) {
    return jsonResponse({ error: `beacon_iterations must be in [10, 63] (got ${beaconIters})` }, 400, cors);
  }
  // beacon_block_height — recorded in state for audit-trail purposes.
  // beacon_block_hash alone is sufficient cryptographically (snarkjs only
  // sees the hash), but auditors comparing against block explorers want
  // the height too so they don't have to reverse-lookup hash → height.
  const beaconBlockHeightRaw = String(fd.get('beacon_block_height') || '');
  if (!/^\d+$/.test(beaconBlockHeightRaw)) {
    return jsonResponse({ error: 'beacon_block_height must be a positive integer' }, 400, cors);
  }
  const beaconBlockHeight = parseInt(beaconBlockHeightRaw, 10);
  // Coordinator's expectation of which head_cid the beacon-applied zkey
  // was built on top of. Used for the post-pin CAS check below — closes
  // the lost-contribution race where a contribute lands during the
  // (multi-second) IPFS pin window and finalize would otherwise silently
  // overwrite it. REQUIRED — there is no legitimate flow that sends a
  // finalize POST without this field, and accepting one would silently
  // disable the CAS gate.
  const expectedHeadCid = String(fd.get('expected_head_cid') || '');
  if (!expectedHeadCid) {
    return jsonResponse({ error: 'missing expected_head_cid — required for the CAS gate that prevents lost contributions during the IPFS pin window' }, 400, cors);
  }
  if (!(zkey instanceof File)) return jsonResponse({ error: 'missing form field "zkey"' }, 400, cors);
  if (zkey.size > 32 * 1024 * 1024) return jsonResponse({ error: 'zkey too large' }, 413, cors);
  // 64 hex = sha256 / Bitcoin block hash — what snarkjs's beacon stage expects.
  // The previous regex accepted any-length hex which let through e.g. "ab".
  if (!/^[0-9a-f]{64}$/.test(beaconHash)) {
    return jsonResponse({ error: 'beacon_block_hash must be exactly 64 hex chars (Bitcoin block hash)' }, 400, cors);
  }

  // Magic-byte sniff before pinning.
  const zkeyBytes = new Uint8Array(await zkey.arrayBuffer());
  if (!_hasCeremonyMagic(zkeyBytes, 'zkey')) {
    return jsonResponse({ error: 'zkey does not start with snarkjs "zkey" magic bytes' }, 400, cors);
  }

  let finalCid;
  try {
    finalCid = await pinBinaryToIpfs(env, zkeyBytes, `withdraw_final_${circuitHash.slice(0,8)}.zkey`);
  } catch (e) {
    return jsonResponse({ error: 'pin failed: ' + (e.message || 'unknown') }, 502, cors);
  }

  // Re-read state for the CAS check — Pinata pins can take seconds and
  // a contribute landing during that window would advance state.head_cid
  // past what the beacon was applied to. Without this check, finalize
  // would silently overwrite the contribute's chain advance, leaving an
  // orphan contrib record and "lost" entropy for that contributor. Same
  // pattern handleCeremonyContribute uses (line ~791-797).
  const fresh = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!fresh || fresh.head_cid !== expectedHeadCid) {
    return jsonResponse({
      error: 'stale expected_head_cid — chain advanced during finalize pin window; refresh head and retry',
      expected: expectedHeadCid,
      actual_head_cid: fresh ? fresh.head_cid : null,
      actual_contribution_count: fresh ? fresh.contribution_count : null,
    }, 409, cors);
  }
  if (fresh.finalized) {
    return jsonResponse({ error: 'ceremony was finalized between pin and CAS — race lost', state: fresh }, 409, cors);
  }

  // Build newState from `fresh` (the CAS-checked re-read), NOT `state`
  // (the original read taken before the IPFS pin). If the CAS check
  // passed, the two are equivalent on head_cid + contribution_count by
  // construction — but defensively using `fresh` ensures other fields
  // (timestamps, last_contributor metadata) carry forward whatever
  // value is most current. Same for the contrib record's prev_cid.
  const now = Math.floor(Date.now() / 1000);
  const newCount = (fresh.contribution_count || 0) + 1;
  const newState = {
    ...fresh,
    head_cid: finalCid,
    contribution_count: newCount,
    last_contributor: 'beacon',
    last_contributed_at: now,
    finalized: true,
    beacon_block_hash: beaconHash,
    beacon_block_height: beaconBlockHeight,
    beacon_iterations: beaconIters,
    finalized_at: now,
  };
  await env.REGISTRY_KV.put(ceremonyKey(circuitHash), JSON.stringify(newState));

  const rec = {
    index: newCount,
    cid: finalCid,
    contributor_name: 'beacon',
    contribution_hash: beaconHash,
    contributed_at: now,
    prev_cid: fresh.head_cid,
    is_beacon: true,
    beacon_block_height: beaconBlockHeight,
    beacon_iterations: beaconIters,
  };
  await env.REGISTRY_KV.put(ceremonyContribKey(circuitHash, newCount, finalCid), JSON.stringify(rec));

  // Invalidate the GET-endpoint edge caches so every dapp tab globally
  // sees finalized:true on its next poll instead of waiting up to 30s
  // for the cache to expire. Without this, the mixer-ceremony-locked
  // class would remain on for up to half a TTL window after finalize,
  // gating deposit/withdraw/init buttons that should already be live.
  await _invalidateCeremonyCache(ctx, circuitHash);
  return jsonResponse({ state: newState, contribution: rec }, 200, cors);
}

// ============== /pin-mixer-vk — pin a Groth16 verifying-key JSON ==============
// The mixer's POOL_INIT envelope references a vk by IPFS CID. The vk is the
// JSON output of `snarkjs zkey export verificationkey` — a fixed-shape blob
// (~3-4 KB for our circuit) whose fields don't fit /pin-json's whitelist
// (protocol, curve, vk_alpha_1, vk_beta_2, IC, etc.). This endpoint accepts
// snarkjs's exact shape, validates it structurally (protocol == 'groth16',
// curve == 'bn128'/'bn254'), pins to IPFS via Pinata, and returns the CID.
//
// Same daily-limit + size-cap as /pin-json — there's no privileged path here,
// just a different field schema.
async function handlePinMixerVk(req, env, cors) {
  if (!env.PINATA_JWT) return jsonResponse({ error: 'PINATA_JWT missing' }, 500, cors);

  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `pin:${day}:${ip}`;
  const dailyLimit = safeInt(env.DAILY_LIMIT, 20, { min: 0 });
  const prior = safeInt(await env.UPLOAD_KV.get(kvKey), 0, { min: 0 });
  if (prior >= dailyLimit) return jsonResponse({ error: 'daily upload limit reached' }, 429, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonResponse({ error: 'expected JSON object' }, 400, cors);
  }
  // Structural validation: snarkjs Groth16 vk shape. Reject anything that
  // doesn't look like a verifying key — the endpoint isn't a general blob
  // store, it's specifically for vk JSON.
  if (body.protocol !== 'groth16') {
    return jsonResponse({ error: 'protocol must be "groth16"' }, 400, cors);
  }
  if (body.curve !== 'bn128' && body.curve !== 'bn254') {
    return jsonResponse({ error: 'curve must be bn128 or bn254' }, 400, cors);
  }
  // Required snarkjs vk fields — confirms the shape end-to-end.
  for (const k of ['vk_alpha_1', 'vk_beta_2', 'vk_gamma_2', 'vk_delta_2', 'IC']) {
    if (body[k] === undefined) return jsonResponse({ error: `missing field ${k}` }, 400, cors);
  }
  if (!Array.isArray(body.IC) || body.IC.length < 2) {
    return jsonResponse({ error: 'IC must be array length >= 2' }, 400, cors);
  }

  const json = JSON.stringify(body);
  if (json.length > 32 * 1024) {
    return jsonResponse({ error: 'vk exceeds 32 KB' }, 413, cors);
  }

  const pinFd = new FormData();
  pinFd.append('file', new Blob([json], { type: 'application/json' }), `tacit-mixer-vk-${Date.now()}.json`);
  pinFd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  let pinResp;
  try {
    pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
      body: pinFd,
    });
  } catch { return jsonResponse({ error: 'pinata unreachable' }, 502, cors); }
  if (!pinResp.ok) {
    try { console.error(`pinata ${pinResp.status}: ${(await pinResp.text()).slice(0, 240)}`); } catch {}
    return jsonResponse({ error: `pinata error (status ${pinResp.status})` }, 502, cors);
  }
  const pj = await pinResp.json();
  if (!pj.IpfsHash) return jsonResponse({ error: 'pinata returned no CID' }, 502, cors);

  const newCount = prior + 1;
  await env.UPLOAD_KV.put(kvKey, String(newCount), { expirationTtl: 60 * 60 * 25 });

  return jsonResponse({ cid: pj.IpfsHash }, 200, cors);
}

// ============== /pin-json — pin a small metadata JSON blob ==============
// Used when the etcher wants to attach description / external_url / etc. The
// resulting CID goes into the CETCH envelope's image_uri field; renderers
// dereference it to find { name, description, image, external_url }.
async function handlePinJson(req, env, cors) {
  if (!env.PINATA_JWT) return jsonResponse({ error: 'PINATA_JWT missing' }, 500, cors);

  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `pin:${day}:${ip}`;
  const dailyLimit = safeInt(env.DAILY_LIMIT, 20, { min: 0 });
  const prior = safeInt(await env.UPLOAD_KV.get(kvKey), 0, { min: 0 });
  if (prior >= dailyLimit) return jsonResponse({ error: 'daily upload limit reached' }, 429, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonResponse({ error: 'expected JSON object' }, 400, cors);
  }
  // Whitelist allowed fields; ignore everything else to keep blobs predictable.
  // tacit_attest is a structured object the dapp embeds when an etcher opts
  // into "Publish supply opening" — verifiers later read it from the IPFS
  // blob and recompute Pedersen against the on-chain commitment. Without
  // this, the IPFS-embedded attestation path silently degrades to the
  // worker /attest cache (still cryptographically verified, but no longer
  // content-addressed).
  const allowed = ['name', 'description', 'image', 'external_url', 'decimals', 'tacit_attest'];
  const clean = {};
  for (const k of allowed) if (body[k] !== undefined) clean[k] = body[k];
  // Bound-check tacit_attest's shape so we don't pin garbage. The dapp's
  // verifier already re-checks Pedersen, but rejecting malformed shapes
  // here keeps the blob compact and the schema honest.
  if (clean.tacit_attest !== undefined) {
    const a = clean.tacit_attest;
    const ok = a && typeof a === 'object' && !Array.isArray(a)
      && typeof a.supply === 'string' && /^\d+$/.test(a.supply)
      && typeof a.blinding === 'string' && /^[0-9a-f]{64}$/.test(a.blinding)
      && typeof a.commitment === 'string' && /^[0-9a-f]{66}$/.test(a.commitment);
    if (!ok) return jsonResponse({ error: 'tacit_attest malformed' }, 400, cors);
    // Drop any extra fields the caller tacked on.
    clean.tacit_attest = { supply: a.supply, blinding: a.blinding, commitment: a.commitment };
  }
  const json = JSON.stringify(clean);
  if (json.length > 4096) {
    return jsonResponse({ error: 'metadata exceeds 4 KB' }, 413, cors);
  }

  const pinFd = new FormData();
  pinFd.append('file', new Blob([json], { type: 'application/json' }), `tacit-meta-${Date.now()}.json`);
  pinFd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  let pinResp;
  try {
    pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
      body: pinFd,
    });
  } catch { return jsonResponse({ error: 'pinata unreachable' }, 502, cors); }
  if (!pinResp.ok) {
    // See note in handlePin — never echo Pinata's body to the client.
    try { console.error(`pinata ${pinResp.status}: ${(await pinResp.text()).slice(0, 240)}`); } catch {}
    return jsonResponse({ error: `pinata error (status ${pinResp.status})` }, 502, cors);
  }
  const j = await pinResp.json();
  if (!j.IpfsHash) return jsonResponse({ error: 'pinata returned no CID' }, 502, cors);

  await env.UPLOAD_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
  return jsonResponse({ cid: j.IpfsHash }, 200, cors);
}

// ============== airdrop merkle helpers (SPEC §5.13 + §8) ==============
// Byte-for-byte parity with `dapp/tacit.js` airdropLeafHash / buildAirdropMerkle.
// Sort-pair sibling hashing + tagged sha256 = standard OpenZeppelin shape.
// Used at /pin-airdrop-snapshot to recompute the root from rows and refuse
// snapshots whose declared root doesn't match — closes the footgun where an
// issuer pins a tampered/buggy snapshot, burns the pin slot + announcement,
// and only discovers the mismatch when no recipient can claim.
const _AIRDROP_LEAF_TAG = new TextEncoder().encode('tacit-airdrop-leaf-v1');
const _AIRDROP_NODE_TAG = new TextEncoder().encode('tacit-airdrop-node-v1');
function _airdropLeafHash(ethAddrBytes, amountBig, indexU32) {
  const amtLE = new Uint8Array(8);
  new DataView(amtLE.buffer).setBigUint64(0, amountBig, true);
  const idxLE = new Uint8Array(4);
  new DataView(idxLE.buffer).setUint32(0, indexU32 >>> 0, true);
  return sha256(concatBytes(_AIRDROP_LEAF_TAG, ethAddrBytes, amtLE, idxLE));
}
function _airdropNodeHash(a, b) {
  let cmp = 0;
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) { cmp = a[i] < b[i] ? -1 : 1; break; }
  }
  const [lo, hi] = cmp <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(_AIRDROP_NODE_TAG, lo, hi));
}
function _buildAirdropMerkleRoot(leaves) {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0];
  let layer = leaves;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) next.push(_airdropNodeHash(layer[i], layer[i + 1]));
      else next.push(layer[i]);
    }
    layer = next;
  }
  return layer[0];
}

// ============== /pin-airdrop-snapshot — pin a tacit-airdrop-v1 snapshot ==============
// The dapp's Drops tab pins a snapshot JSON keyed by merkle root; recipients
// fetch it from IPFS to verify their leaf and sign their claim. The snapshot
// schema (`schema`, `network`, `asset_id`, `merkle_root`, `leaf_count`,
// `total_amount`, `rows[]`, `sources`, `blacklist_size`, …) doesn't fit
// /pin-json's metadata whitelist (which would strip every airdrop field) and
// the 4 KB cap there is too tight (even a 50-recipient drop is ~5 KB). Same
// pattern as /pin-mixer-vk: dedicated endpoint with a shape validator + a
// schema-appropriate size cap. Same daily-limit semantics.
async function handlePinAirdropSnapshot(req, env, cors) {
  if (!env.PINATA_JWT) return jsonResponse({ error: 'PINATA_JWT missing' }, 500, cors);

  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `pin:${day}:${ip}`;
  const dailyLimit = safeInt(env.DAILY_LIMIT, 20, { min: 0 });
  const prior = safeInt(await env.UPLOAD_KV.get(kvKey), 0, { min: 0 });
  if (prior >= dailyLimit) return jsonResponse({ error: 'daily upload limit reached' }, 429, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonResponse({ error: 'expected JSON object' }, 400, cors);
  }

  // Structural validation — refuse anything that isn't a tacit-airdrop-v1
  // snapshot. The recipient's dapp will refuse it on load anyway (schema
  // check + root recompute), so rejecting up front gives the issuer a fast,
  // clear error instead of a silent "CID returned but no one can claim."
  if (body.schema !== 'tacit-airdrop-v1') {
    return jsonResponse({ error: 'schema must be "tacit-airdrop-v1"' }, 400, cors);
  }
  if (body.network !== 'signet' && body.network !== 'mainnet') {
    return jsonResponse({ error: 'network must be "signet" or "mainnet"' }, 400, cors);
  }
  if (typeof body.asset_id !== 'string' || !/^[0-9a-f]{64}$/.test(body.asset_id)) {
    return jsonResponse({ error: 'asset_id must be 64-char hex' }, 400, cors);
  }
  if (typeof body.merkle_root !== 'string' || !/^[0-9a-f]{64}$/.test(body.merkle_root)) {
    return jsonResponse({ error: 'merkle_root must be 64-char hex' }, 400, cors);
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return jsonResponse({ error: 'rows must be a non-empty array' }, 400, cors);
  }
  // Cap row count to match the dapp's localStorage-quota-driven cap. Anything
  // larger would not be storable on a recipient's machine anyway, and burns
  // Pinata storage for blobs no one can load.
  if (body.rows.length > 100_000) {
    return jsonResponse({ error: 'rows length exceeds 100,000 — split into multiple drops' }, 413, cors);
  }
  if (body.leaf_count != null) {
    if (!Number.isInteger(body.leaf_count) || body.leaf_count !== body.rows.length) {
      return jsonResponse({ error: 'leaf_count must equal rows.length' }, 400, cors);
    }
  }
  // asset_decimals + asset_ticker are required (not optional). The canonical
  // claim msg interpolates both — if a snapshot omits them, recipients sign
  // with the fallback `decimals=0, ticker='?'` while the issuer's fulfiller
  // rebuilds the msg from the on-chain CETCH ticker/decimals → sig recovery
  // fails and the claim is rejected as "forged" even though it was
  // legitimately signed. Recipient-side `_claimValidateSnapshot` already
  // refuses such snapshots; enforcing the same up-front prevents the issuer
  // from burning a pin slot + announce slot on a dead snapshot.
  if (!Number.isInteger(body.asset_decimals) || body.asset_decimals < 0 || body.asset_decimals > 8) {
    return jsonResponse({ error: 'asset_decimals required: integer 0..8 (CETCH max)' }, 400, cors);
  }
  if (typeof body.asset_ticker !== 'string' || body.asset_ticker.length === 0 || body.asset_ticker.length > 16) {
    return jsonResponse({ error: 'asset_ticker required: string of length 1..16' }, 400, cors);
  }
  // Reject control / bidi codepoints in the ticker — it's interpolated
  // verbatim into the EIP-191 msg MetaMask shows the recipient at sign
  // time. Same defense as the dapp's _claimValidateSnapshot ticker check.
  for (let i = 0; i < body.asset_ticker.length; i++) {
    const cp = body.asset_ticker.codePointAt(i);
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
      return jsonResponse({ error: 'asset_ticker contains control or bidi characters' }, 400, cors);
    }
  }
  if (body.total_amount != null && (typeof body.total_amount !== 'string' || !/^\d+$/.test(body.total_amount))) {
    return jsonResponse({ error: 'total_amount must be a base-10 integer string' }, 400, cors);
  }
  // Optional source-provenance fields: let the issuer record where the
  // snapshot rows came from so auditors can independently reproduce the
  // (eth_address, amount) tuples and re-derive the merkle root. None of
  // these are cryptographically anchored — the snapshot is still trust-
  // the-issuer — but having a chain_id + contract + block_height makes the
  // claim auditable.
  if (body.source_chain_id != null) {
    if (!Number.isInteger(body.source_chain_id) || body.source_chain_id < 0) {
      return jsonResponse({ error: 'source_chain_id must be a non-negative integer (EIP-155 chain id)' }, 400, cors);
    }
  }
  if (body.source_contract != null) {
    if (typeof body.source_contract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.source_contract)) {
      return jsonResponse({ error: 'source_contract must be 0x + 40 hex chars (ERC-20 contract address)' }, 400, cors);
    }
  }
  if (body.source_block_height != null) {
    if (!Number.isInteger(body.source_block_height) || body.source_block_height < 0) {
      return jsonResponse({ error: 'source_block_height must be a non-negative integer' }, 400, cors);
    }
  }
  if (body.source_method != null) {
    if (typeof body.source_method !== 'string' || body.source_method.length === 0 || body.source_method.length > 64) {
      return jsonResponse({ error: 'source_method must be a string of length 1..64' }, 400, cors);
    }
  }
  // Validate every row's shape AND collect the parsed fields so we can
  // recompute the merkle root in a single pass. Sampling only the first
  // rows would let blobs with bad rows[N] (N≥sample) pin successfully and
  // burn the issuer's pin slot on an unusable blob — recipient-side
  // validation catches them at load time but only after the cost.
  const parsedRows = new Array(body.rows.length);
  let summed = 0n;
  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i];
    if (!r || typeof r !== 'object') return jsonResponse({ error: `rows[${i}] not an object` }, 400, cors);
    if (typeof r.eth_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.eth_address)) {
      return jsonResponse({ error: `rows[${i}].eth_address must be 0x + 40 hex chars` }, 400, cors);
    }
    if (typeof r.amount !== 'string' || !/^\d+$/.test(r.amount)) {
      return jsonResponse({ error: `rows[${i}].amount must be a base-10 integer string` }, 400, cors);
    }
    if (!Number.isInteger(r.index) || r.index < 0) {
      return jsonResponse({ error: `rows[${i}].index must be a non-negative integer` }, 400, cors);
    }
    let amountBig;
    try { amountBig = BigInt(r.amount); }
    catch { return jsonResponse({ error: `rows[${i}].amount unparseable as BigInt` }, 400, cors); }
    if (amountBig < 0n || amountBig >= (1n << 64n)) {
      return jsonResponse({ error: `rows[${i}].amount out of u64 range` }, 400, cors);
    }
    parsedRows[i] = {
      ethAddrBytes: hexToBytes(r.eth_address.slice(2).toLowerCase()),
      amount: amountBig,
      index: r.index,
    };
    summed += amountBig;
  }
  // Recipient validator (`dapp/tacit.js:_claimValidateSnapshot`) requires
  // indexes be contiguous 0..N-1 and rejects duplicates / bad ordering. If
  // the pin passes those gates server-side too, an issuer-side bug surfaces
  // at the /pin call rather than at recipient claim time after pin + announce
  // slots have already been burned.
  const sortedByIndex = [...parsedRows].sort((a, b) => a.index - b.index);
  for (let i = 0; i < sortedByIndex.length; i++) {
    if (sortedByIndex[i].index !== i) {
      return jsonResponse({ error: `rows indexes must be contiguous 0..${sortedByIndex.length - 1} (saw index ${sortedByIndex[i].index} at slot ${i})` }, 400, cors);
    }
  }
  const seenAddrs = new Set();
  for (const r of parsedRows) {
    const k = bytesToHex(r.ethAddrBytes);
    if (seenAddrs.has(k)) {
      return jsonResponse({ error: `duplicate eth_address: 0x${k} (each address must appear at most once)` }, 400, cors);
    }
    seenAddrs.add(k);
  }
  // total_amount consistency. The recipient validator also enforces this;
  // surfacing it server-side keeps the pin from succeeding on a snapshot
  // whose displayed total is wrong.
  if (body.total_amount != null) {
    const declared = BigInt(body.total_amount);
    if (declared !== summed) {
      return jsonResponse({ error: `total_amount (${declared}) does not equal sum of rows (${summed})` }, 400, cors);
    }
  }
  // Recompute the merkle root from rows and refuse mismatches. Without this,
  // a buggy issuer build could pin a snapshot whose `merkle_root` doesn't
  // hash from `rows[]` — every recipient's `_claimValidateSnapshot` rejects
  // it, but the pin + announce + treasury setup have already cost real $.
  // 100k sha256 ops + log2(100k)=17 layers of pairwise hashing comfortably
  // fits the CF Worker CPU budget (paid tier 30s, free tier 50ms is borderline
  // for very large drops — issuers near the free-tier limit should split).
  // SHA256 is fast — ~250ns/op in V8 — so 200k ops ≈ 50ms even at full row count.
  const leaves = parsedRows.map(r => _airdropLeafHash(r.ethAddrBytes, r.amount, r.index));
  // Sort leaves by the parsed index to ensure leaf-order matches the canonical
  // (sorted) ordering recipients use. Indexes were already validated to be
  // contiguous 0..N-1, so sorting by index gives leaves[i] = leaf-for-index-i.
  const orderedLeaves = new Array(parsedRows.length);
  for (let i = 0; i < parsedRows.length; i++) orderedLeaves[parsedRows[i].index] = leaves[i];
  const computedRoot = _buildAirdropMerkleRoot(orderedLeaves);
  if (!computedRoot || bytesToHex(computedRoot) !== body.merkle_root) {
    return jsonResponse({
      error: `merkle_root mismatch — declared ${body.merkle_root} but rows hash to ${computedRoot ? bytesToHex(computedRoot) : '<empty>'}. Rebuild the snapshot in the dapp's Drops tab.`,
    }, 400, cors);
  }

  const json = JSON.stringify(body);
  // 16 MB cap. 100k recipients × ~110 bytes/row ≈ 11 MB; the extra headroom
  // covers source/blacklist metadata and JSON whitespace from re-pretty-printing.
  // CF Worker body limits and Pinata both accept well over this.
  if (json.length > 16 * 1024 * 1024) {
    return jsonResponse({ error: 'snapshot exceeds 16 MB' }, 413, cors);
  }

  const pinFd = new FormData();
  pinFd.append('file', new Blob([json], { type: 'application/json' }), `tacit-airdrop-${body.merkle_root.slice(0, 12)}.json`);
  pinFd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  // Retry on transient failures. A single Pinata blip (network glitch, edge
  // cold-start, or 5xx) shouldn't fail the whole drop publish flow — the
  // issuer is mid-ceremony and there's no graceful manual retry path. Three
  // attempts with exponential backoff covers ~7s of total wait while a
  // recipient-blocking outage rarely lasts that long. 4xx is NOT retried —
  // those are deterministic (auth, payload) and re-sending won't help.
  let pinResp = null;
  let lastErr = '';
  const PIN_RETRY_DELAYS_MS = [500, 1500, 3500];
  for (let attempt = 0; attempt < PIN_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, PIN_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
        body: pinFd,
      });
    } catch (e) {
      lastErr = `network error: ${e?.message || 'unknown'}`;
      pinResp = null;
      continue;
    }
    if (pinResp.ok) break;
    // 4xx is the caller's fault (bad JWT, malformed payload). 5xx and 429
    // are Pinata's transient signals — retry on those only.
    if (pinResp.status >= 400 && pinResp.status < 500 && pinResp.status !== 429) {
      try { console.error(`pinata ${pinResp.status}: ${(await pinResp.text()).slice(0, 240)}`); } catch {}
      return jsonResponse({ error: `pinata error (status ${pinResp.status})` }, 502, cors);
    }
    try { lastErr = `pinata ${pinResp.status}: ${(await pinResp.text()).slice(0, 240)}`; } catch { lastErr = `pinata ${pinResp.status}`; }
    pinResp = null;
  }
  if (!pinResp || !pinResp.ok) {
    if (lastErr) try { console.error(lastErr); } catch {}
    return jsonResponse({ error: lastErr || 'pinata unreachable after retries' }, 502, cors);
  }
  const pj = await pinResp.json();
  if (!pj.IpfsHash) return jsonResponse({ error: 'pinata returned no CID' }, 502, cors);

  await env.UPLOAD_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
  return jsonResponse({ cid: pj.IpfsHash, IpfsHash: pj.IpfsHash }, 200, cors);
}

// ============== Bitcoin tx primitives (P2WPKH only — what the faucet needs) ==============
class W {
  constructor() { this.parts = []; }
  push(b) { this.parts.push(b); return this; }
  u8(n)   { this.parts.push(new Uint8Array([n & 0xff])); return this; }
  u32(n)  { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return this.push(b); }
  u64(n)  { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.push(b); }
  varint(n) {
    if (n < 0xfd)        return this.u8(n);
    if (n < 0x10000)     { this.u8(0xfd); const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return this.push(b); }
    if (n < 0x100000000) { this.u8(0xfe); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.push(b); }
    this.u8(0xff); return this.u64(n);
  }
  out() { return concatBytes(...this.parts); }
}
const p2wpkhScript  = pub => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pub));
const p2wpkhAddress = (pub, hrp) => bech32.encode(hrp, [0, ...bech32.toWords(hash160(pub))]);
function addressToScript(addr, hrp) {
  const decoded = bech32.decode(addr);
  if (decoded.prefix !== hrp) throw new Error(`wrong network prefix: ${decoded.prefix}`);
  if (decoded.words[0] !== 0) throw new Error('only segwit v0 supported');
  const program = bech32.fromWords(decoded.words.slice(1));
  if (program.length !== 20) throw new Error('only P2WPKH (20-byte programs) supported');
  return concatBytes(new Uint8Array([0x00, 0x14]), new Uint8Array(program));
}
function sighashV0(tx, idx, scriptCode, value) {
  const w = new W();
  w.u32(tx.version);
  const wp = new W();
  for (const i of tx.inputs) { wp.push(reverseBytes(hexToBytes(i.txid))); wp.u32(i.vout); }
  w.push(hash256(wp.out()));
  const ws = new W();
  for (const i of tx.inputs) ws.u32(i.sequence);
  w.push(hash256(ws.out()));
  const inp = tx.inputs[idx];
  w.push(reverseBytes(hexToBytes(inp.txid)));
  w.u32(inp.vout);
  w.varint(scriptCode.length).push(scriptCode);
  w.u64(value);
  w.u32(inp.sequence);
  const wo = new W();
  for (const o of tx.outputs) { wo.u64(o.value); wo.varint(o.script.length).push(o.script); }
  w.push(hash256(wo.out()));
  w.u32(tx.locktime);
  w.u32(0x01); // SIGHASH_ALL
  return hash256(w.out());
}
function serializeTx(tx, withWitness = true) {
  const hasWit = withWitness && tx.inputs.some(i => i.witness && i.witness.length);
  const w = new W();
  w.u32(tx.version);
  if (hasWit) w.push(new Uint8Array([0x00, 0x01]));
  w.varint(tx.inputs.length);
  for (const i of tx.inputs) {
    w.push(reverseBytes(hexToBytes(i.txid)));
    w.u32(i.vout);
    const ss = i.scriptSig || new Uint8Array(0);
    w.varint(ss.length).push(ss);
    w.u32(i.sequence);
  }
  w.varint(tx.outputs.length);
  for (const o of tx.outputs) { w.u64(o.value); w.varint(o.script.length).push(o.script); }
  if (hasWit) {
    for (const i of tx.inputs) {
      const wit = i.witness || [];
      w.varint(wit.length);
      for (const item of wit) w.varint(item.length).push(item);
    }
  }
  w.u32(tx.locktime);
  return w.out();
}
const txid = tx => bytesToHex(reverseBytes(hash256(serializeTx(tx, false))));

function derEncode(rs) {
  const trim = x => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let t = x.slice(i);
    if (t[0] & 0x80) t = concatBytes(new Uint8Array([0]), t);
    return t;
  };
  const r = trim(rs.slice(0, 32));
  const s = trim(rs.slice(32, 64));
  return concatBytes(
    new Uint8Array([0x30, 4 + r.length + s.length]),
    new Uint8Array([0x02, r.length]), r,
    new Uint8Array([0x02, s.length]), s
  );
}
function signECDSA(hash, priv) {
  const sig = secp.sign(hash, priv, { lowS: true });
  return concatBytes(derEncode(sig.toCompactRawBytes()), new Uint8Array([0x01]));
}

// ============== /balance + /drip ==============
function faucetKeys(env) {
  if (!env.FAUCET_PRIV) throw new Error('FAUCET_PRIV not set');
  const cleaned = env.FAUCET_PRIV.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) throw new Error('FAUCET_PRIV must be 64 hex chars');
  const priv = hexToBytes(cleaned);
  const pub = secp.getPublicKey(priv, true);
  const address = p2wpkhAddress(pub, HRP_BY_NETWORK.signet);
  return { priv, pub, address };
}

async function handleBalance(env, cors) {
  let f;
  try { f = faucetKeys(env); }
  catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
  let utxos;
  try { utxos = await apiJson(env, `/address/${f.address}/utxo`); }
  catch (e) { return jsonResponse({ error: e.message }, 502, cors); }
  const balance = utxos.reduce((s, u) => s + u.value, 0);
  return jsonResponse({ address: f.address, balance, utxos: utxos.length }, 200, cors);
}

async function handleDrip(req, env, cors) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
  const recipient = String(body.address || '').trim();
  if (!recipient) return jsonResponse({ error: 'missing "address"' }, 400, cors);

  let recipientScript;
  try { recipientScript = addressToScript(recipient, HRP_BY_NETWORK.signet); }
  catch (e) { return jsonResponse({ error: `invalid address: ${e.message}` }, 400, cors); }

  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `drip:ip:${day}:${ip}`;
  const addrKey = `drip:addr:${day}:${recipient}`;
  const ipLimit = safeInt(env.FAUCET_IP_LIMIT, 1, { min: 0 });
  const addrLimit = safeInt(env.FAUCET_ADDR_LIMIT, 1, { min: 0 });
  const ipPrior = safeInt(await env.REGISTRY_KV.get(ipKey), 0, { min: 0 });
  const addrPrior = safeInt(await env.REGISTRY_KV.get(addrKey), 0, { min: 0 });
  if (ipPrior >= ipLimit)   return jsonResponse({ error: `IP daily limit reached (${ipLimit}/day)` }, 429, cors);
  if (addrPrior >= addrLimit) return jsonResponse({ error: `address daily limit reached (${addrLimit}/day)` }, 429, cors);

  // Pre-increment the per-IP / per-address counters BEFORE the slow broadcast.
  // KV has no CAS, so two requests racing within the broadcast window would
  // both see prior=0 and both broadcast — draining the faucet at twice the
  // intended rate. Pre-incrementing closes the window from "broadcast time"
  // (~hundreds of ms) to "two KV reads + writes" (~tens of ms). Best-effort
  // rollback on broadcast failure so a transient mempool.space error doesn't
  // permanently consume the user's daily quota.
  await env.REGISTRY_KV.put(ipKey, String(ipPrior + 1), { expirationTtl: 90000 });
  await env.REGISTRY_KV.put(addrKey, String(addrPrior + 1), { expirationTtl: 90000 });
  const rollbackCounters = async () => {
    try { await env.REGISTRY_KV.put(ipKey, String(ipPrior), { expirationTtl: 90000 }); } catch {}
    try { await env.REGISTRY_KV.put(addrKey, String(addrPrior), { expirationTtl: 90000 }); } catch {}
  };

  let f;
  try { f = faucetKeys(env); }
  catch (e) { await rollbackCounters(); return jsonResponse({ error: e.message }, 500, cors); }

  let utxos;
  try { utxos = await apiJson(env, `/address/${f.address}/utxo`); }
  catch (e) { await rollbackCounters(); return jsonResponse({ error: e.message }, 502, cors); }
  if (!utxos.length) {
    await rollbackCounters();
    return jsonResponse({ error: 'faucet has no UTXOs — send signet sats to ' + f.address }, 503, cors);
  }

  const dripSats = safeInt(env.DRIP_SATS, 20000, { min: DUST });
  const feeRate = 2; // signet, conservative
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const picked = []; let total = 0;
  let estVb = 11 + 1 * 68 + 31 * 2;
  let estFee = Math.max(200, Math.ceil(estVb * feeRate));
  for (const u of sorted) {
    picked.push(u); total += u.value;
    estVb = 11 + picked.length * 68 + 31 * 2;
    estFee = Math.max(200, Math.ceil(estVb * feeRate));
    if (total >= dripSats + estFee + DUST) break;
  }
  if (total < dripSats + estFee) {
    await rollbackCounters();
    return jsonResponse({ error: `faucet underfunded: ${total} sats, need ${dripSats + estFee}` }, 503, cors);
  }
  const change = total - dripSats - estFee;
  const outputs = [{ value: dripSats, script: recipientScript }];
  if (change >= DUST) outputs.push({ value: change, script: p2wpkhScript(f.pub) });

  const tx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs,
  };
  const scriptCode = concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(f.pub), new Uint8Array([0x88, 0xac]));
  for (let i = 0; i < tx.inputs.length; i++) {
    const sh = sighashV0(tx, i, scriptCode, picked[i].value);
    const sig = signECDSA(sh, f.priv);
    tx.inputs[i].witness = [sig, f.pub];
  }
  const hex = bytesToHex(serializeTx(tx));

  let broadcastTxid;
  try { broadcastTxid = (await apiText(env, '/tx', { method: 'POST', body: hex })).trim(); }
  catch (e) {
    await rollbackCounters();
    return jsonResponse({ error: `broadcast failed: ${e.message}` }, 502, cors);
  }
  // Counters were pre-incremented above; broadcast succeeded, leave them in place.

  return jsonResponse({
    txid: broadcastTxid,
    amount_sats: dripSats,
    fee_sats: estFee,
    recipient,
    explorer: `https://mempool.space/signet/tx/${broadcastTxid}`,
  }, 200, cors);
}

// ============== /assets — registry ==============
function decodeEnvelopeScript(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 1;
  if (p + 32 > script.length) return null;
  p += 32; // signing pubkey
  if (p + 1 > script.length || script[p] !== 0xac) return null; p += 1; // OP_CHECKSIG
  if (p + 2 > script.length || script[p] !== 0x00 || script[p + 1] !== 0x63) return null; p += 2; // OP_FALSE OP_IF
  const pushes = [];
  let sawEndif = false;
  while (p < script.length) {
    if (script[p] === 0x68) { p += 1; sawEndif = true; break; }
    const op = script[p]; p += 1;
    let data;
    if (op >= 1 && op <= 75) {
      if (p + op > script.length) return null;
      data = script.slice(p, p + op); p += op;
    } else if (op === 0x4c) {
      if (p + 1 > script.length) return null;
      const ln = script[p]; p += 1;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === 0x4d) {
      if (p + 2 > script.length) return null;
      const ln = script[p] | (script[p + 1] << 8); p += 2;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === 0x00) {
      data = new Uint8Array(0);
    } else { return null; }
    pushes.push(data);
  }
  if (!sawEndif || p !== script.length || pushes.length < 3) return null;
  if (pushes[0].length !== 5) return null;
  for (let i = 0; i < 5; i++) if (pushes[0][i] !== ENVELOPE_MAGIC[i]) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== 0x01) return null;
  const payload = concatBytes(...pushes.slice(2));
  if (payload.length < 1) return null;
  return { opcode: payload[0], payload };
}

// Worker only does length-validation; rangeproof verification stays client-side.
// CETCH wire format:
//   T_CETCH(1) || tlen(1) || ticker(tlen) || decimals(1) ||
//   commitment(33) || amount_ct(8) || rp_len(2 LE) || rangeproof(rp_len) ||
//   mint_authority(32) || img_len(2 LE) || image_uri(img_len)
function decodeCEtchPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 1 + 1 + 1 + 33 + 8 + 2 + 32 + 2) return null;
  if (payload[0] !== T_CETCH) return null;
  let p = 1;
  const tlen = payload[p]; p += 1;
  if (tlen < 1 || tlen > 16) return null;
  if (p + tlen > payload.length) return null;
  let ticker;
  try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  if (p + 33 + 8 + 2 > payload.length) return null;
  const commitment = payload.slice(p, p + 33); p += 33;
  p += 8;                        // skip amount_ct
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen + 32 + 2 > payload.length) return null;
  p += rpLen;                    // skip rangeproof
  const mintAuthority = payload.slice(p, p + 32); p += 32;
  const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (imgLen > 256) return null;
  if (p + imgLen !== payload.length) return null;
  let imageUri = null;
  if (imgLen > 0) {
    try { imageUri = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + imgLen)); } catch { return null; }
  }
  let mintable = false;
  for (let i = 0; i < 32; i++) if (mintAuthority[i] !== 0) { mintable = true; break; }
  return {
    ticker, decimals, commitment: bytesToHex(commitment), image_uri: imageUri,
    mintable, mint_authority: bytesToHex(mintAuthority),
  };
}
function assetIdFor(etchTxidHex, etchVout) {
  const txidBE = reverseBytes(hexToBytes(etchTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, etchVout >>> 0, true);
  return bytesToHex(sha256(concatBytes(txidBE, voutLE)));
}

// T_MINT structural decoder (length checks only; signature + range proof verify
// is the dApp's job).
function decodeCMintPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 32 + 33 + 8 + 2 + 64) return null;
  if (payload[0] !== T_MINT) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const etchTxid = payload.slice(p, p + 32); p += 32;
  const commitment = payload.slice(p, p + 33); p += 33;
  p += 8; // amount_ct
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen + 64 > payload.length) return null;
  p += rpLen;
  p += 64; // issuer_sig
  if (p !== payload.length) return null;
  return {
    asset_id: bytesToHex(assetId),
    etch_txid: bytesToHex(etchTxid),
    commitment: bytesToHex(commitment),
  };
}

// T_CXFER structural decoder. Returns asset_id + per-output commitments. Used
// by the per-UTXO opening endpoint to resolve a CXFER output's commitment by
// vout. Kernel sig + range proof stay client-side.
function decodeCXferPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 64 + 1) return null;
  if (payload[0] !== T_CXFER) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  p += 64; // kernel_sig
  const N = payload[p]; p += 1;
  if (![1, 2, 4, 8].includes(N)) return null;
  if (p + N * (33 + 8) + 2 > payload.length) return null;
  const outputs = [];
  for (let i = 0; i < N; i++) {
    const commitment = payload.slice(p, p + 33); p += 33;
    p += 8; // amount_ct
    outputs.push({ commitment: bytesToHex(commitment) });
  }
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen !== payload.length) return null;
  return { asset_id: bytesToHex(assetId), outputs };
}

// T_AXFER structural decoder. Same shape as CXFER plus an asset_input_count
// byte after asset_id (SPEC §5.7). The kernel sig and rangeproof verify
// client-side; the worker only needs the per-vout commitments to power
// commitmentForUtxo() lookups.
function decodeAxferPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 1 + 64 + 1) return null;
  if (payload[0] !== T_AXFER) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount < 1) return null;
  p += 64; // kernel_sig
  const N = payload[p]; p += 1;
  if (![1, 2, 4, 8].includes(N)) return null;
  if (p + N * (33 + 8) + 2 > payload.length) return null;
  const outputs = [];
  for (let i = 0; i < N; i++) {
    const commitment = payload.slice(p, p + 33); p += 33;
    p += 8; // amount_ct
    outputs.push({ commitment: bytesToHex(commitment) });
  }
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen !== payload.length) return null;
  return { asset_id: bytesToHex(assetId), asset_input_count: assetInputCount, outputs };
}

// T_AXFER_VAR structural decoder (SPEC §5.7.9). Mirrors decodeAxferPayload
// but with two SPEC-mandated tightenings: asset_input_count MUST be exactly
// 1, and N MUST be exactly 2. Anything else under opcode 0x37 is invalid and
// returns null. The dapp ships a byte-identical decoder; tests/t-axfer-var-
// decoder.test.mjs pins the wire format.
function decodeAxferVarPayload(payload) {
  if (!payload) return null;
  if (payload[0] !== T_AXFER_VAR) return null;
  if (payload.length < 1 + 32 + 1 + 64 + 1 + 2 * (33 + 8) + 2) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount !== 1) return null;  // T_AXFER_VAR: exactly 1 asset input
  p += 64; // kernel_sig
  const N = payload[p]; p += 1;
  if (N !== 2) return null;                  // T_AXFER_VAR: exactly N=2 (recipient + maker change)
  if (p + N * (33 + 8) + 2 > payload.length) return null;
  const outputs = [];
  for (let i = 0; i < N; i++) {
    const commitment = payload.slice(p, p + 33); p += 33;
    p += 8; // amount_ct
    outputs.push({ commitment: bytesToHex(commitment) });
  }
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen !== payload.length) return null;
  return { asset_id: bytesToHex(assetId), asset_input_count: assetInputCount, n: N, outputs };
}

// T_PETCH structural decoder (SPEC §5.8). Permissionless-mint deployment
// record. No commitment, no rangeproof, no signature — anyone may broadcast.
// Wire: opcode(1) || tlen(1) || ticker(tlen) || decimals(1) || cap(8 LE) ||
//   limit(8 LE) || start_h(4 LE) || end_h(4 LE) || img_len(2 LE) || img_uri(img_len)
function decodeCPetchPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 1 + 1 + 1 + 8 + 8 + 4 + 4 + 2) return null;
  if (payload[0] !== T_PETCH) return null;
  let p = 1;
  const tlen = payload[p]; p += 1;
  if (tlen < 1 || tlen > 16) return null;
  if (p + tlen > payload.length) return null;
  let ticker;
  try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  if (p + 8 + 8 + 4 + 4 + 2 > payload.length) return null;
  const capLE = payload.slice(p, p + 8); p += 8;
  const limitLE = payload.slice(p, p + 8); p += 8;
  const capView = new DataView(capLE.buffer, capLE.byteOffset, 8);
  const cap_amount = (BigInt(capView.getUint32(4, true)) << 32n) | BigInt(capView.getUint32(0, true));
  const limitView = new DataView(limitLE.buffer, limitLE.byteOffset, 8);
  const mint_limit = (BigInt(limitView.getUint32(4, true)) << 32n) | BigInt(limitView.getUint32(0, true));
  // Envelope-level invariants per SPEC §5.8: cap > 0, limit > 0, cap evenly
  // divisible by limit. The height-window invariants (mint_start_height ≥
  // etch_height + 1) require knowing etch_height and are enforced by the
  // indexer, not the decoder.
  if (cap_amount <= 0n) return null;
  if (mint_limit <= 0n) return null;
  if (mint_limit > cap_amount) return null;
  if (cap_amount % mint_limit !== 0n) return null;
  const startView = new DataView(payload.buffer, payload.byteOffset + p, 4);
  const mint_start_height = startView.getUint32(0, true); p += 4;
  const endView = new DataView(payload.buffer, payload.byteOffset + p, 4);
  const mint_end_height = endView.getUint32(0, true); p += 4;
  // 0 sentinels mean "next block after etch confirms" / "no end". A non-zero
  // end height MUST exceed the effective start; bare-decoder can only check
  // the relation when both are non-zero (otherwise the effective_start
  // depends on etch_height which the decoder doesn't see).
  if (mint_start_height !== 0 && mint_end_height !== 0 && mint_end_height <= mint_start_height) return null;
  const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (imgLen > 256) return null;
  if (p + imgLen !== payload.length) return null;
  let imageUri = null;
  if (imgLen > 0) {
    try { imageUri = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + imgLen)); } catch { return null; }
  }
  return {
    ticker, decimals,
    cap_amount: cap_amount.toString(),
    mint_limit: mint_limit.toString(),
    mint_start_height, mint_end_height,
    image_uri: imageUri,
  };
}

// T_PMINT structural decoder (SPEC §5.9). Permissionless mint event. No
// signature; (amount, blinding) are public, so the validator (and any
// observer) can recompute the commitment from the envelope alone. Cap +
// height-window enforcement is the indexer's job.
// Wire: opcode(1) || asset_id(32) || etch_txid(32) || commitment(33) ||
//   amount(8 LE) || blinding(32)
function decodeCPmintPayload(payload) {
  if (!payload) return null;
  if (payload.length !== 1 + 32 + 32 + 33 + 8 + 32) return null;
  if (payload[0] !== T_PMINT) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const etchTxid = payload.slice(p, p + 32); p += 32;
  const commitment = payload.slice(p, p + 33); p += 33;
  const amountLE = payload.slice(p, p + 8); p += 8;
  const amountView = new DataView(amountLE.buffer, amountLE.byteOffset, 8);
  const amount = (BigInt(amountView.getUint32(4, true)) << 32n) | BigInt(amountView.getUint32(0, true));
  if (amount <= 0n || amount >= (1n << BigInt(N_BITS))) return null;
  const blinding = payload.slice(p, p + 32); p += 32;
  // 0 < blinding scalar — full curve_order check belongs in the validator
  // (BigInt comparison against secp256k1 order constant). The decoder rejects
  // an all-zero blinding which would yield an unblinded commitment.
  let blindingNonZero = false;
  for (let i = 0; i < 32; i++) if (blinding[i] !== 0) { blindingNonZero = true; break; }
  if (!blindingNonZero) return null;
  if (p !== payload.length) return null;
  return {
    asset_id: bytesToHex(assetId),
    etch_txid: bytesToHex(etchTxid),
    commitment: bytesToHex(commitment),
    amount: amount.toString(),
    blinding: bytesToHex(blinding),
  };
}

// ============== T_DROP / T_DCLAIM CODEC (SPEC §5.12 / §5.13) ==============
// Mirror of dapp/tacit.js's encoders/decoders. Wire format pinned in
// tests/airdrop.test.mjs + tests/dapp-parity.test.mjs. Byte-for-byte parity
// with the dapp is enforced via dapp-parity tests; any drift breaks there.
//
// T_DROP payload — standard shape (per_claim > 0):
//   T_DROP(1) || asset_id(32) || cap_amount_LE(8) || per_claim_LE(8) ||
//   merkle_root(32) || expiry_height_LE(4) || ticker_len(1) || ticker(tlen) ||
//   decimals(1) || asset_input_count(1) || kernel_sig(64)
//
// Reclaim shape (per_claim = 0 sentinel; SPEC §5.12.1):
//   T_DROP(1) || asset_id(32) || cap_amount_LE(8) || per_claim_LE(8) = 0 ||
//   reclaim_drop_id(32) || reclaim_sig(64) || cap_blinding(32)
//
// The worker doesn't need encoders (it only reads chain bytes) but exposing
// them keeps dapp-parity testing trivial and supports future tooling.
function encodeCDropPayload({ assetId, capAmount, perClaim, merkleRoot, expiryHeight, ticker, decimals, assetInputCount, kernelSig }) {
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  const cap = BigInt(capAmount);
  const per = BigInt(perClaim);
  if (cap <= 0n || cap >= (1n << 64n)) throw new Error('cap_amount out of u64');
  if (per <= 0n || per >= (1n << 64n)) throw new Error('per_claim out of u64');
  if (cap % per !== 0n) throw new Error('cap_amount must be divisible by per_claim');
  if (!(merkleRoot instanceof Uint8Array) || merkleRoot.length !== 32) throw new Error('merkle_root 32');
  const exp = Number(expiryHeight);
  if (!Number.isInteger(exp) || exp < 0 || exp > 0xffffffff) throw new Error('expiry_height u32');
  const tk = ticker ? new TextEncoder().encode(String(ticker)) : new Uint8Array(0);
  if (tk.length > 16) throw new Error('ticker too long');
  const dec = Number(decimals) || 0;
  if (!Number.isInteger(dec) || dec < 0 || dec > 8) throw new Error('decimals 0..8');
  const aic = Number(assetInputCount);
  if (!Number.isInteger(aic) || aic < 1 || aic > 16) throw new Error('asset_input_count 1..16');
  if (!(kernelSig instanceof Uint8Array) || kernelSig.length !== 64) throw new Error('kernel_sig 64');
  const capLE = new Uint8Array(8);
  { const v = new DataView(capLE.buffer); v.setUint32(0, Number(cap & 0xffffffffn), true); v.setUint32(4, Number((cap >> 32n) & 0xffffffffn), true); }
  const perLE = new Uint8Array(8);
  { const v = new DataView(perLE.buffer); v.setUint32(0, Number(per & 0xffffffffn), true); v.setUint32(4, Number((per >> 32n) & 0xffffffffn), true); }
  const expLE = new Uint8Array(4); new DataView(expLE.buffer).setUint32(0, exp >>> 0, true);
  return concatBytes(
    new Uint8Array([T_DROP]), assetId, capLE, perLE, merkleRoot, expLE,
    new Uint8Array([tk.length]), tk, new Uint8Array([dec]),
    new Uint8Array([aic]), kernelSig,
  );
}

function encodeCDropReclaimPayload({ assetId, capAmount, reclaimDropId, reclaimSig, capBlinding }) {
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  const cap = BigInt(capAmount);
  if (cap <= 0n || cap >= (1n << 64n)) throw new Error('cap_amount out of u64');
  if (!(reclaimDropId instanceof Uint8Array) || reclaimDropId.length !== 32) throw new Error('reclaim_drop_id 32');
  if (!(reclaimSig instanceof Uint8Array) || reclaimSig.length !== 64) throw new Error('reclaim_sig 64');
  if (!(capBlinding instanceof Uint8Array) || capBlinding.length !== 32) throw new Error('cap_blinding 32');
  let bNonZero = false;
  for (let i = 0; i < 32; i++) if (capBlinding[i] !== 0) { bNonZero = true; break; }
  if (!bNonZero) throw new Error('cap_blinding must be non-zero');
  const capLE = new Uint8Array(8);
  { const v = new DataView(capLE.buffer); v.setUint32(0, Number(cap & 0xffffffffn), true); v.setUint32(4, Number((cap >> 32n) & 0xffffffffn), true); }
  const perZeroLE = new Uint8Array(8);
  return concatBytes(
    new Uint8Array([T_DROP]), assetId, capLE, perZeroLE,
    reclaimDropId, reclaimSig, capBlinding,
  );
}

function decodeCDropPayload(payload) {
  if (!payload) return null;
  if (payload.length < 152) return null;   // 1+32+8+8+32+4+1+0+1+1+64 minimum
  if (payload[0] !== T_DROP) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const capView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const capAmount = (BigInt(capView.getUint32(4, true)) << 32n) | BigInt(capView.getUint32(0, true));
  p += 8;
  const perView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const perClaim = (BigInt(perView.getUint32(4, true)) << 32n) | BigInt(perView.getUint32(0, true));
  p += 8;
  if (capAmount <= 0n) return null;
  // Reclaim shape sentinel.
  if (perClaim === 0n) {
    if (payload.length !== 1 + 32 + 8 + 8 + 32 + 64 + 32) return null;
    const reclaimDropId = payload.slice(p, p + 32); p += 32;
    const reclaimSig = payload.slice(p, p + 64); p += 64;
    const capBlinding = payload.slice(p, p + 32); p += 32;
    if (p !== payload.length) return null;
    let bNonZero = false;
    for (let i = 0; i < 32; i++) if (capBlinding[i] !== 0) { bNonZero = true; break; }
    if (!bNonZero) return null;
    return {
      kind: 'cdrop-reclaim',
      asset_id: bytesToHex(assetId),
      cap_amount: capAmount.toString(),
      reclaim_drop_id: bytesToHex(reclaimDropId),
      reclaim_sig: bytesToHex(reclaimSig),
      cap_blinding: bytesToHex(capBlinding),
    };
  }
  if (perClaim >= (1n << 64n)) return null;
  if (capAmount % perClaim !== 0n) return null;
  const merkleRoot = payload.slice(p, p + 32); p += 32;
  const expView = new DataView(payload.buffer, payload.byteOffset + p, 4);
  const expiryHeight = expView.getUint32(0, true); p += 4;
  if (p + 1 > payload.length) return null;
  const tlen = payload[p]; p += 1;
  if (tlen > 16) return null;
  if (p + tlen + 1 + 1 + 64 > payload.length) return null;
  let ticker = null;
  if (tlen > 0) {
    try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount < 1 || assetInputCount > 16) return null;
  const kernelSig = payload.slice(p, p + 64); p += 64;
  if (p !== payload.length) return null;
  return {
    kind: 'cdrop',
    asset_id: bytesToHex(assetId),
    cap_amount: capAmount.toString(),
    per_claim: perClaim.toString(),
    merkle_root: bytesToHex(merkleRoot),
    expiry_height: expiryHeight,
    ticker, decimals,
    asset_input_count: assetInputCount,
    kernel_sig: bytesToHex(kernelSig),
  };
}

// T_DCLAIM payload:
//   T_DCLAIM(1) || asset_id(32) || drop_reveal_txid(32) || commitment(33) ||
//   amount_LE(8) || blinding(32) || witness_len_LE(2) || witness(witness_len)
//
// Witness (merkle-gated): recipient_pub(33) || leaf_index_LE(4) ||
//   eth_address(20) || eth_sig(65) || proof_len(1) || proof_path(proof_len*32)
// Witness (open): empty (witness_len == 0).
function encodeCDClaimPayload({ assetId, dropRevealTxid, commitment, amount, blinding, witness }) {
  if (!(assetId instanceof Uint8Array) || assetId.length !== 32) throw new Error('asset_id 32');
  if (!(dropRevealTxid instanceof Uint8Array) || dropRevealTxid.length !== 32) throw new Error('drop_reveal_txid 32');
  if (!(commitment instanceof Uint8Array) || commitment.length !== 33) throw new Error('commitment 33');
  const amt = BigInt(amount);
  if (amt <= 0n || amt >= (1n << 64n)) throw new Error('amount out of u64');
  if (!(blinding instanceof Uint8Array) || blinding.length !== 32) throw new Error('blinding 32');
  let bNonZero = false;
  for (let i = 0; i < 32; i++) if (blinding[i] !== 0) { bNonZero = true; break; }
  if (!bNonZero) throw new Error('blinding must be non-zero');
  const witnessBytes = witness instanceof Uint8Array ? witness : new Uint8Array(0);
  if (witnessBytes.length > 65535) throw new Error('witness too large');
  const amtLE = new Uint8Array(8);
  { const v = new DataView(amtLE.buffer); v.setUint32(0, Number(amt & 0xffffffffn), true); v.setUint32(4, Number((amt >> 32n) & 0xffffffffn), true); }
  const wLen = new Uint8Array(2); new DataView(wLen.buffer).setUint16(0, witnessBytes.length, true);
  return concatBytes(
    new Uint8Array([T_DCLAIM]), assetId, dropRevealTxid, commitment, amtLE, blinding,
    wLen, witnessBytes,
  );
}

function encodeCDClaimWitness({ recipientPub, leafIndex, ethAddress, ethSig, proofPath }) {
  if (!(recipientPub instanceof Uint8Array) || recipientPub.length !== 33) throw new Error('recipient_pub 33');
  if (recipientPub[0] !== 0x02 && recipientPub[0] !== 0x03) throw new Error('recipient_pub must start with 02 or 03');
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 0xffffffff) throw new Error('leaf_index u32');
  if (!(ethAddress instanceof Uint8Array) || ethAddress.length !== 20) throw new Error('eth_address 20');
  if (!(ethSig instanceof Uint8Array) || ethSig.length !== 65) throw new Error('eth_sig 65');
  if (!Array.isArray(proofPath)) throw new Error('proof_path must be an array');
  if (proofPath.length > 32) throw new Error('proof_path too deep');
  for (const s of proofPath) {
    if (!(s instanceof Uint8Array) || s.length !== 32) throw new Error('proof_path entries must be 32-byte');
  }
  const liLE = new Uint8Array(4); new DataView(liLE.buffer).setUint32(0, leafIndex >>> 0, true);
  return concatBytes(
    recipientPub, liLE, ethAddress, ethSig,
    new Uint8Array([proofPath.length]),
    ...proofPath,
  );
}

function decodeCDClaimPayload(payload) {
  if (!payload) return null;
  if (payload.length < 140) return null;   // 1+32+32+33+8+32+2 minimum
  if (payload[0] !== T_DCLAIM) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const dropRevealTxid = payload.slice(p, p + 32); p += 32;
  const commitment = payload.slice(p, p + 33); p += 33;
  const amtView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const amount = (BigInt(amtView.getUint32(4, true)) << 32n) | BigInt(amtView.getUint32(0, true));
  p += 8;
  if (amount <= 0n || amount >= (1n << 64n)) return null;
  const blinding = payload.slice(p, p + 32); p += 32;
  let bNonZero = false;
  for (let i = 0; i < 32; i++) if (blinding[i] !== 0) { bNonZero = true; break; }
  if (!bNonZero) return null;
  const wView = new DataView(payload.buffer, payload.byteOffset + p, 2);
  const witnessLen = wView.getUint16(0, true); p += 2;
  if (p + witnessLen !== payload.length) return null;
  const witnessBytes = payload.slice(p, p + witnessLen); p += witnessLen;
  let witness = null;
  if (witnessLen > 0) {
    const headerSize = 33 + 4 + 20 + 65 + 1;
    if (witnessLen < headerSize) return null;
    let wp = 0;
    const recipientPub = witnessBytes.slice(wp, wp + 33); wp += 33;
    if (recipientPub[0] !== 0x02 && recipientPub[0] !== 0x03) return null;
    const liView = new DataView(witnessBytes.buffer, witnessBytes.byteOffset + wp, 4);
    const leafIndex = liView.getUint32(0, true); wp += 4;
    const ethAddress = witnessBytes.slice(wp, wp + 20); wp += 20;
    const ethSig = witnessBytes.slice(wp, wp + 65); wp += 65;
    const proofLen = witnessBytes[wp]; wp += 1;
    if (proofLen > 32) return null;
    if (wp + proofLen * 32 !== witnessBytes.length) return null;
    const proofPath = [];
    for (let i = 0; i < proofLen; i++) {
      proofPath.push(bytesToHex(witnessBytes.slice(wp, wp + 32)));
      wp += 32;
    }
    witness = {
      recipient_pub: bytesToHex(recipientPub),
      leaf_index: leafIndex,
      eth_address: bytesToHex(ethAddress),
      eth_sig: bytesToHex(ethSig),
      proof_path: proofPath,
    };
  }
  return {
    kind: 'cdclaim',
    asset_id: bytesToHex(assetId),
    drop_reveal_txid: bytesToHex(dropRevealTxid),
    commitment: bytesToHex(commitment),
    amount: amount.toString(),
    blinding: bytesToHex(blinding),
    witness,
  };
}

// drop_id derives from the reveal tx the same way asset_id does for CETCH
// (SPEC §4): SHA256(reveal_txid_BE || 0_LE). This is the KV-key identifier,
// not a wire-format field; the T_DCLAIM payload carries drop_reveal_txid.
function dropIdFromRevealTxid(revealTxidHex) {
  const txidBE = (() => { const b = hexToBytes(revealTxidHex); return new Uint8Array([...b].reverse()); })();
  const voutLE = new Uint8Array(4);
  return sha256(concatBytes(txidBE, voutLE));
}

// SPEC §5.10. Two payload shapes: POOL_INIT (denomination = 0 sentinel) and
// standard deposit. Returned shape's `kind` discriminates.
function decodeTDepositPayload(payload) {
  if (!payload) return null;
  if (payload[0] !== T_DEPOSIT) return null;
  if (payload.length < 1 + 32 + 8) return null;
  let p = 1;
  const assetIdBytes = payload.slice(p, p + 32); p += 32;
  const denomView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const denomination = (BigInt(denomView.getUint32(4, true)) << 32n) | BigInt(denomView.getUint32(0, true));
  p += 8;
  const asset_id = bytesToHex(assetIdBytes);
  if (denomination === 0n) {
    if (payload.length < p + 8 + 1) return null;
    const pdView = new DataView(payload.buffer, payload.byteOffset + p, 8);
    const poolDenom = (BigInt(pdView.getUint32(4, true)) << 32n) | BigInt(pdView.getUint32(0, true));
    p += 8;
    if (poolDenom <= 0n || poolDenom >= (1n << BigInt(N_BITS))) return null;
    if (p + 1 > payload.length) return null;
    const vkLen = payload[p]; p += 1;
    if (vkLen < 1 || vkLen > 64) return null;
    if (p + vkLen > payload.length) return null;
    const vkCid = new TextDecoder().decode(payload.slice(p, p + vkLen)); p += vkLen;
    if (p + 1 > payload.length) return null;
    const ceLen = payload[p]; p += 1;
    if (ceLen < 1 || ceLen > 64) return null;
    if (p + ceLen > payload.length) return null;
    const ceremonyCid = new TextDecoder().decode(payload.slice(p, p + ceLen)); p += ceLen;
    if (p + 64 !== payload.length) return null;
    const initSig = bytesToHex(payload.slice(p, p + 64)); p += 64;
    return {
      kind: 'pool_init',
      asset_id,
      pool_denom: poolDenom.toString(),
      vk_cid: vkCid,
      ceremony_cid: ceremonyCid,
      init_sig: initSig,
    };
  }
  if (payload.length !== 1 + 32 + 8 + 32 + 64) return null;
  if (denomination >= (1n << BigInt(N_BITS))) return null;
  const leaf = bytesToHex(payload.slice(p, p + 32)); p += 32;
  const kernelSig = bytesToHex(payload.slice(p, p + 64)); p += 64;
  return {
    kind: 'deposit',
    asset_id,
    denomination: denomination.toString(),
    leaf_commitment: leaf,
    kernel_sig: kernelSig,
  };
}

// SPEC §5.11. Worker decodes structurally only — proof verification + bind_hash
// re-derivation happen client-side (the dApp pulls the worker's pool snapshot
// and re-validates).
// SPEC §5.11. Re-derive bind_hash from the surrounding fields and reject if
// the envelope's stored bind_hash doesn't match. Closing this here (not just
// in the dapp) makes the indexer rejection path BYTE-DETERMINISTIC across
// worker + dapp + any third-party indexer running the same spec — a critical
// invariant for the protocol's most consensus-sensitive state, the spent-
// nullifier set. Without this check, a structurally-valid-but-bind-hash-bad
// envelope would be accepted by the worker (writing its nullifier to
// poolnull:) but rejected by the dapp's decoder, creating a divergence
// where the worker thinks a nullifier is spent but the dapp doesn't
// recognize the prior withdrawal as legitimate. The dapp would then refuse
// to credit downstream withdrawals using that nullifier as "double-spent"
// per the worker's authority, even though no real withdrawal happened.
const _WITHDRAW_BIND_DOMAIN = new TextEncoder().encode('tacit-withdraw-bind-v1');
function _computeWithdrawBindHash(assetIdBytes, denomination, nullifierHashBytes, recipientCommitmentBytes, rLeafBytes) {
  const denomLE = new Uint8Array(8);
  const v = new DataView(denomLE.buffer);
  const d = BigInt(denomination);
  v.setUint32(0, Number(d & 0xffffffffn), true);
  v.setUint32(4, Number((d >> 32n) & 0xffffffffn), true);
  return sha256(concatBytes(
    _WITHDRAW_BIND_DOMAIN,
    assetIdBytes, denomLE, nullifierHashBytes, recipientCommitmentBytes, rLeafBytes,
  ));
}

function decodeTWithdrawPayload(payload) {
  if (!payload) return null;
  if (payload[0] !== T_WITHDRAW) return null;
  const HEADER = 1 + 32 + 8 + 32 + 32 + 33 + 32 + 32 + 2;
  if (payload.length < HEADER) return null;
  let p = 1;
  const assetIdBytes = payload.slice(p, p + 32); p += 32;
  const denomView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const denomination = (BigInt(denomView.getUint32(4, true)) << 32n) | BigInt(denomView.getUint32(0, true));
  p += 8;
  if (denomination <= 0n || denomination >= (1n << BigInt(N_BITS))) return null;
  const merkleRootBytes = payload.slice(p, p + 32); p += 32;
  const nullifierHashBytes = payload.slice(p, p + 32); p += 32;
  const recipientCommitmentBytes = payload.slice(p, p + 33); p += 33;
  const rLeafBytes = payload.slice(p, p + 32); p += 32;
  const bindHashBytes = payload.slice(p, p + 32); p += 32;
  const proofLen = new DataView(payload.buffer, payload.byteOffset + p, 2).getUint16(0, true);
  p += 2;
  if (p + proofLen !== payload.length) return null;
  // Bind-hash determinism check (SPEC §5.11). MUST match the dapp's decoder
  // exactly so worker + dapp + any third-party indexer all reject the same
  // envelopes. Without this the spent-nullifier ledger diverges. See block
  // comment at _computeWithdrawBindHash for the threat model.
  const expectedBindHash = _computeWithdrawBindHash(
    assetIdBytes, denomination, nullifierHashBytes, recipientCommitmentBytes, rLeafBytes,
  );
  for (let i = 0; i < 32; i++) if (expectedBindHash[i] !== bindHashBytes[i]) return null;
  const proof = bytesToHex(payload.slice(p, p + proofLen));
  return {
    kind: 'withdraw',
    asset_id: bytesToHex(assetIdBytes),
    denomination: denomination.toString(),
    merkle_root: bytesToHex(merkleRootBytes),
    nullifier_hash: bytesToHex(nullifierHashBytes),
    recipient_commitment: bytesToHex(recipientCommitmentBytes),
    r_leaf: bytesToHex(rLeafBytes),
    bind_hash: bytesToHex(bindHashBytes),
    proof,
  };
}

function decodeCBurnPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 8 + 64 + 1) return null;
  if (payload[0] !== T_BURN) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const burnedLE = payload.slice(p, p + 8); p += 8;
  const view = new DataView(burnedLE.buffer, burnedLE.byteOffset, 8);
  const burnedAmount = (BigInt(view.getUint32(4, true)) << 32n) | BigInt(view.getUint32(0, true));
  if (burnedAmount < 0n || burnedAmount >= (1n << BigInt(N_BITS))) return null;
  p += 64; // kernel_sig
  const n = payload[p]; p += 1;
  if (![0, 1, 2, 4, 8].includes(n)) return null;
  const outputs = [];
  for (let i = 0; i < n; i++) {
    if (p + 33 + 8 > payload.length) return null;
    const commitment = payload.slice(p, p + 33); p += 33;
    p += 8; // amount_ct
    outputs.push({ commitment: bytesToHex(commitment) });
  }
  // Match the dApp's strict bounds: BURN with N>0 carries an aggregated rp;
  // N=0 carries nothing trailing. Anything else is malformed.
  if (n > 0) {
    if (p + 2 > payload.length) return null;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen !== payload.length) return null;
  } else if (p !== payload.length) {
    return null;
  }
  return {
    asset_id: bytesToHex(assetId),
    burned_amount: burnedAmount.toString(),
    outputs,
  };
}

async function loadBurnsForAsset(env, network, assetIdHex) {
  // Burns are public: no attestation logic, just sum the cleartext amounts.
  const list = await env.REGISTRY_KV.list({ prefix: burnPrefix(network, assetIdHex), limit: 1000 });
  const fetched = await Promise.all(
    list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')),
  );
  const burns = fetched.filter(v => v);
  burns.sort((a, b) => (a.burned_at || 0) - (b.burned_at || 0));
  return burns;
}

async function loadMintsForAsset(env, network, assetIdHex) {
  // Returns sorted list of mint events for one asset_id, attested where
  // available. Cap at 1000 mints/asset (way beyond any practical use).
  const list = await env.REGISTRY_KV.list({ prefix: mintPrefix(network, assetIdHex), limit: 1000 });
  const events = (await Promise.all(
    list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')),
  )).filter(v => v);
  // Hydrate attestations in parallel rather than serially per-mint.
  const attestations = await Promise.all(
    events.map(v => env.REGISTRY_KV.get(attestMintKey(network, assetIdHex, v.mint_txid), 'json')),
  );
  for (let i = 0; i < events.length; i++) if (attestations[i]) events[i].attestation = attestations[i];
  events.sort((a, b) => (a.minted_at || 0) - (b.minted_at || 0));
  return events;
}

// Per-asset hydration for the Discover/Market list. Pre-parallelisation this
// ran 8+ KV operations sequentially per asset (attestation, mints loop, burns
// loop, plus 5 separate KV.list calls for counts) which dominated /assets
// latency on networks with many assets. Now everything fan-outs in one
// Promise.all per asset.
async function hydrateAssetSummary(env, network, v, includeMints) {
  // Pre-compute today + yesterday's daily-bucket keys so the
  // volume_24h_sats fan-out joins the same parallel Promise.all. The
  // dapp used to per-asset-enrich this from /assets/:id; folding it
  // into the bulk response kills the visible "…" lag on every market
  // load. Same bucket-sum logic as handleAssetGet — slightly over-
  // counts (up to 48h worst case) but the bound is documented.
  const _nowSec = Math.floor(Date.now() / 1000);
  const _todayKey = tradeDayKey(network, v.asset_id, _utcYyyymmdd(_nowSec));
  const _yestKey  = tradeDayKey(network, v.asset_id, _utcYyyymmdd(_nowSec - 86400));
  const _holderKey = holderCountKey(network, v.asset_id);
  const [att, mints, burns, op, dc, ls, lr, ai, ps, xfer, lastTrade, ring, todaySats, yestSats, holderCnt] = await Promise.all([
    env.REGISTRY_KV.get(attestKey(network, v.asset_id), 'json'),
    includeMints ? loadMintsForAsset(env, network, v.asset_id) : Promise.resolve(null),
    loadBurnsForAsset(env, network, v.asset_id),
    env.REGISTRY_KV.list({ prefix: openingPrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: disclosurePrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: listingPrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: rangeListingPrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: atomicIntentPrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: preauthSalePrefix(network, v.asset_id), limit: 1000 }),
    // Single KV.get of the cron-maintained transfer counter — folded into
    // the existing parallel fan-out so it adds zero round-trip latency.
    env.REGISTRY_KV.get(transferCountKey(network, v.asset_id)),
    env.REGISTRY_KV.get(lastTradeKey(network, v.asset_id), 'json'),
    // Recent-trades ring — used here to compute a compact price summary
    // (24h Δ% + price_summary[10]) that the bulk /assets response surfaces
    // for tile-side sparklines + delta. The full ring stays available
    // through /assets/:id for the deep chart.
    env.REGISTRY_KV.get(tradesRingKey(network, v.asset_id), 'json'),
    // Daily bucket sums for rolling 24h volume. Two extra KV.gets per
    // asset; KV reads parallelize within Promise.all and don't count
    // toward the subrequest budget, so the only cost is per-key billing.
    env.REGISTRY_KV.get(_todayKey),
    env.REGISTRY_KV.get(_yestKey),
    // Per-asset holder counter — distinct recipient scriptpubkey hashes
    // bumped by the cron's CETCH/T_MINT/T_PMINT/T_CXFER/T_AXFER paths.
    // "All-time wallets that received this asset" — a popularity signal,
    // not a current-holder head count.
    env.REGISTRY_KV.get(_holderKey),
  ]);
  if (att) v.attestation = att;
  if (includeMints) v.mints = mints;
  v.burns = burns;
  v.opening_count = op.keys.length;
  v.disclosure_count = dc.keys.length;
  v.listing_count = ls.keys.length;
  v.range_listing_count = lr.keys.length;
  v.atomic_intent_count = ai.keys.length;
  v.preauth_sale_count = ps.keys.length;
  v.transfer_count = parseInt(xfer || '0', 10) || 0;
  if (lastTrade) v.last_trade = lastTrade;
  // Rolling 24h volume — bucket sum of today + yesterday's UTC daily
  // totals (same logic as handleAssetGet line ~3915). Moved into the
  // bulk response so dapp tiles populate volume on first paint instead
  // of waiting for per-asset enrichment.
  v.volume_24h_sats = (Number(todaySats) || 0) + (Number(yestSats) || 0);
  // Distinct-recipient counter (all-time, not current). Counts unique
  // scriptpubkey hashes that have ever received this asset via T_CETCH,
  // T_MINT, T_PMINT, T_CXFER, or T_AXFER. Older asset entries indexed
  // before this counter existed return 0 — they'll backfill as new
  // transfers land. Frame as "wallets" not "users" in UI.
  v.holder_count = parseInt(holderCnt || '0', 10) || 0;
  // Canonical mark price for valuation. Computed server-side so every API
  // client (dapp Holdings, third-party portfolio tools, future SDKs) sees
  // the same reference number. Priority matches how equities and crypto
  // exchanges mark holdings: last trade → median of recent trades. Floor
  // (lowest open ask) is NOT included here — it's a thin signal that
  // collapses on a single dust ask. Clients still get floor by walking
  // listings themselves.
  if (Number.isInteger(v.decimals)) {
    const _dec = v.decimals;
    const _u = (priceSats, amountStr) => {
      const p = Number(priceSats);
      if (!Number.isFinite(p) || p <= 0) return null;
      let a; try { a = BigInt(amountStr || '0'); } catch { return null; }
      if (a <= 0n) return null;
      const num = BigInt(Math.floor(p)) * (10n ** BigInt(_dec)) * 100000000n;
      return Number(num / a) / 1e8;
    };
    // Compute the recent-ring median up-front so the last_trade path can
    // outlier-guard against it. A single fat-finger or wash trade
    // shouldn't swing the entire asset's mark price (which feeds market
    // cap, holdings valuation, swap-tile reference) by orders of
    // magnitude — but the previous "last_trade wins unconditionally"
    // logic let exactly that happen on small-cap volatile tokens.
    let _ringMedian = null;
    let _ringSampleCount = 0;
    if (Array.isArray(ring) && ring.length > 0) {
      const units = ring.map(t => _u(t.price_sats, t.amount))
        .filter(u => Number.isFinite(u) && u > 0)
        .sort((a, b) => a - b);
      if (units.length > 0) {
        const mid = units.length >> 1;
        _ringMedian = (units.length % 2) ? units[mid] : (units[mid - 1] + units[mid]) / 2;
        _ringSampleCount = units.length;
      }
    }
    // 1) last_trade unit price — authoritative when within 5× of the
    //    recent-ring median. Above that, the print is treated as an
    //    outlier and the median takes over with source='median_outlier_guard'
    //    so callers can tell the difference (e.g., chart can show "fat-
    //    finger filtered").
    if (lastTrade && Number.isInteger(lastTrade.price_sats) && lastTrade.price_sats > 0) {
      const u = _u(lastTrade.price_sats, lastTrade.amount);
      if (u != null && u > 0) {
        if (_ringMedian != null && _ringSampleCount >= 5) {
          const ratio = u / _ringMedian;
          if (ratio > 5 || ratio < 0.2) {
            v.mark_price = {
              unit: _ringMedian,
              source: 'median_outlier_guard',
              sample: _ringSampleCount,
              last_trade_unit: u,
              last_trade_ratio_to_median: ratio,
            };
          } else {
            v.mark_price = { unit: u, source: 'last_trade', ts: Number(lastTrade.ts) || 0 };
          }
        } else {
          v.mark_price = { unit: u, source: 'last_trade', ts: Number(lastTrade.ts) || 0 };
        }
      }
    }
    // 2) Median of recent ring as a manipulation-resistant fallback when
    //    last_trade is missing but the ring has entries.
    if (!v.mark_price && _ringMedian != null) {
      v.mark_price = { unit: _ringMedian, source: 'median', sample: _ringSampleCount };
    }
  }
  // Compact trade summary for tile-side rendering. Keep it small — every
  // asset in the list response carries this, so we trim to 10 (ts, unit
  // price) pairs + a single price_24h_change_pct number rather than
  // shipping the full 200-entry ring. Clients that need the full ring
  // hit /assets/:id instead.
  if (Array.isArray(ring) && ring.length > 0 && Number.isInteger(v.decimals)) {
    const dec = v.decimals;
    // Unit price = price_sats × 10^dec / amount, but we ship it as a
    // pre-divided Number so tile-side sparklines don't need to redo the
    // BigInt math for every asset. Precision = 1e-8 sat/whole to match
    // the dapp's unitPriceSats (recent PRECISION bump).
    const _unit = (priceSats, amountStr) => {
      const p = Number(priceSats);
      if (!Number.isFinite(p) || p <= 0) return null;
      let a; try { a = BigInt(amountStr || '0'); } catch { return null; }
      if (a <= 0n) return null;
      const num = BigInt(Math.floor(p)) * (10n ** BigInt(dec)) * 100000000n;
      return Number(num / a) / 1e8;
    };
    const pts = ring.slice(0, 10).map(t => {
      const u = _unit(t.price_sats, t.amount);
      const ts = Number(t.ts) || 0;
      return (u != null && ts > 0) ? { ts, u } : null;
    }).filter(Boolean);
    if (pts.length > 0) v.price_summary = pts;
    // Window-based price-change deltas. Compute multiple windows so the
    // asset page can surface whichever ones have data, and the tile/preview
    // can pick the BEST available (tightest meaningful window) for young
    // markets where 24h Δ% would otherwise be undefined.
    if (pts.length > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const latestU = pts[0].u;
      // Lazy reference-finder: for a given cutoff (seconds), return the
      // unit price of the latest trade that landed BEFORE the cutoff.
      // Walks newest→oldest so the first hit is the closest reference.
      const refForCutoff = (cutoffSec) => {
        for (const t of ring) {
          const ts = Number(t.ts) || 0;
          if (ts >= cutoffSec) continue;
          const u = _unit(t.price_sats, t.amount);
          if (u != null && u > 0) return { u, ts };
        }
        return null;
      };
      // Oldest-overall fallback for the "since first indexed trade" view.
      let oldestRef = null;
      for (let i = ring.length - 1; i >= 0; i--) {
        const u = _unit(ring[i].price_sats, ring[i].amount);
        const ts = Number(ring[i].ts) || 0;
        if (u != null && u > 0 && ts > 0) { oldestRef = { u, ts }; break; }
      }
      const _pct = (latest, ref) => (ref && ref.u > 0 && latest != null)
        ? ((latest - ref.u) / ref.u) * 100
        : null;
      // Per-window deltas. Tile/preview picks the tightest available;
      // asset-page surfaces all that exist.
      const r1h  = refForCutoff(nowSec -      3600);
      const r4h  = refForCutoff(nowSec -  4 * 3600);
      const r24h = refForCutoff(nowSec -     86400);
      const r7d  = refForCutoff(nowSec - 7 * 86400);
      const p1h  = _pct(latestU, r1h);
      const p4h  = _pct(latestU, r4h);
      const p24h = _pct(latestU, r24h);
      const p7d  = _pct(latestU, r7d);
      if (p1h  != null) v.price_1h_change_pct  = p1h;
      if (p4h  != null) v.price_4h_change_pct  = p4h;
      if (p24h != null) v.price_24h_change_pct = p24h;
      if (p7d  != null) v.price_7d_change_pct  = p7d;
      // "All-time within indexed ring" delta. Distinct field so the UI
      // can label correctly ("since first known trade") rather than
      // overloading the windowed slots.
      const pAll = _pct(latestU, oldestRef);
      if (pAll != null && oldestRef && oldestRef.u !== latestU) {
        v.price_all_change_pct = pAll;
        v.price_first_trade_ts = oldestRef.ts;
      }
      // Primary window — the tightest 1h/4h/24h/7d delta we have data
      // for, plus the window label. Preference order prefers a stable
      // 24h figure when available, falling back to tighter windows for
      // markets younger than 24h. 7d is only chosen when 24h failed AND
      // the market has 7d+ history (i.e., we're on a quiet asset where
      // 24h-bucket had no trades) — rare.
      const candidates = [
        { window: '24h', pct: p24h },
        { window: '4h',  pct: p4h },
        { window: '1h',  pct: p1h },
        { window: '7d',  pct: p7d },
        { window: 'all', pct: pAll },
      ];
      const primary = candidates.find(c => c.pct != null);
      if (primary) {
        v.price_change_primary_pct = primary.pct;
        v.price_change_primary_window = primary.window;
      }
    }
  }
}

async function handleAssetsList(env, network, cors, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 1000) : null;
  const includeMints = opts.includeMints !== false;
  // Signet's legacy unprefixed `asset:*` would also catch `asset:mainnet:*`
  // entries; filter those out when listing signet so the namespaces don't bleed.
  const prefix = assetPrefix(network);
  const list = await env.REGISTRY_KV.list({ prefix, limit: 1000 });
  const wanted = list.keys.filter(k => !(network === 'signet' && k.name.startsWith('asset:mainnet:')));
  // Kick off the side-fetches (last_scanned and chain tip-height) in parallel
  // with the asset hydration. Both are independent of the asset list and used
  // only for the freshness banner; running them sequentially after hydration
  // adds ~150-300ms to the MISS path for no value. The mempool.space upstream
  // can be slow / occasionally 522 — catch failures so a flaky upstream
  // doesn't fail the whole /assets response.
  const lastScannedP = env.REGISTRY_KV.get(lastScannedKey(network));
  // Cap the chain tip fetch at 2.5s. mempool.space occasionally hangs
  // (we've observed >60s latency for /blocks/tip/height under stress),
  // and the tip is only used for the freshness banner — losing it just
  // shows "tip unavailable" instead of "X blocks behind". Without this
  // timeout a slow upstream blocks the entire /assets response, since
  // the second Promise.all below awaits this promise regardless of
  // how the per-asset hydrate completes.
  const tipP = Promise.race([
    apiText(env, '/blocks/tip/height', {}, network).then(s => s.trim()),
    new Promise(resolve => setTimeout(() => resolve(null), 2500)),
  ]).catch(() => null);
  // Curated verified set fetched in parallel — per-network registry of
  // platform-attested asset_ids. Failure to load is non-fatal; we just
  // serve everything as unverified and let the next call try again.
  const verifiedP = loadVerifiedSet(env, network).catch(() => new Set());
  const fetched = await Promise.all(
    wanted.map(k => env.REGISTRY_KV.get(k.name, 'json')),
  );
  const assets = fetched.filter(v => v);
  const verifiedSet = await verifiedP;
  for (const a of assets) a.verified = verifiedSet.has(a.asset_id);
  assets.sort((a, b) => (b.etched_at || 0) - (a.etched_at || 0));
  const trimmed = limit ? assets.slice(0, limit) : assets;
  // Lightweight counts so Discover can show "N openings · M disclosures"
  // without doing per-asset round-trips client-side. KV list is paginated;
  // 1000 cap is way beyond any realistic per-asset count for v1.
  await Promise.all(trimmed.map(v => hydrateAssetSummary(env, network, v, includeMints)));
  const [lastScannedRaw, tipRaw] = await Promise.all([lastScannedP, tipP]);
  const lastScanned = parseInt(lastScannedRaw || '0', 10);
  let tip = null;
  let tipUnavailable = tipRaw === null;
  if (!tipUnavailable) {
    const parsed = parseInt(tipRaw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) tip = parsed;
    else tipUnavailable = true;
  }
  return jsonResponse({
    network,
    count: assets.length,
    assets: trimmed,
    // tip_unavailable=true lets the dapp distinguish "caught up" (tip ===
    // last_scanned) from "we couldn't reach mempool.space" (tip null).
    // Without this flag the freshness label silently lied as "caught up".
    meta: { last_scanned: lastScanned, tip, tip_unavailable: tipUnavailable },
  }, 200, cors);
}

// ============== /assets edge cache (SWR + cron pre-warm) ==============
// FRESH: how long a cached response counts as "current".
// STALE: how long past FRESH we still serve cached + refresh async.
// Beyond STALE the cache is treated as missing and we recompute synchronously.
// Tuned around the cron's 5-min tick: fresh data only changes that often,
// so a 5-min serve-stale window doesn't lose meaningful accuracy.
const ASSETS_CACHE_FRESH_MS = 60 * 1000;
const ASSETS_CACHE_STALE_MS = 5 * 60 * 1000;

// Build a normalized cache key for /assets responses. Both the live route
// handler and the cron pre-warm hit the same key, so cron writes are visible
// to subsequent user requests within the same colo. The synthetic origin
// prevents the worker's deployed hostname from leaking into the key (which
// would make staging/preview deploys see different cache entries from prod).
function assetsCacheKey(network, limit, includeMints) {
  const params = new URLSearchParams();
  params.set('network', network);
  if (Number.isInteger(limit) && limit > 0) params.set('limit', String(limit));
  if (!includeMints) params.set('mints', '0');
  return new Request(`https://_assets-cache_/assets?${params.toString()}`, { method: 'GET' });
}

// Compute /assets and write it into the edge cache. Used by both the live
// route handler (synchronous MISS path + ctx.waitUntil background refresh
// during STALE) and the cron pre-warm (so the next user lands on a HIT
// instead of paying the MISS cost themselves).
async function assetsComputeAndCache(env, network, opts) {
  // Empty cors here — caller wraps with the request's cors at response time.
  const fresh = await handleAssetsList(env, network, {}, opts);
  const body = await fresh.text();
  if (fresh.status === 200) {
    const ch = new Headers();
    ch.set('Content-Type', 'application/json');
    ch.set('X-Cached-At', String(Date.now()));
    ch.set('Cache-Control', `public, max-age=${Math.floor(ASSETS_CACHE_STALE_MS / 1000)}`);
    await caches.default.put(
      assetsCacheKey(network, opts.limit, opts.includeMints),
      new Response(body, { status: 200, headers: ch }),
    );
  }
  return { body, status: fresh.status };
}

// ============== /market aggregate (worker-side join) ==============
// Collapses the client's per-asset 3-way fan-out (openings + ranges + intents)
// into a single round-trip. Without this, the Market tab issued N parallel
// per-asset fetches at first paint — the user waited for the slowest of N×3
// round-trips before any tile rendered. Server-side join lets one worker
// invocation fan out within the same colo and serve the joined result from
// edge cache for every browser request after the cron pre-warm.
//
// The /market response shape is a strict superset of the legacy data the
// client built up itself: { assets, listings, meta } — listings is a flat
// array of { kind, _asset, ...listing fields } the client can hand straight
// to applyMarketFilters without further joining.
const MARKET_CACHE_FRESH_MS = 60 * 1000;
const MARKET_CACHE_STALE_MS = 5 * 60 * 1000;
function marketCacheKey(network) {
  const params = new URLSearchParams();
  params.set('network', network);
  return new Request(`https://_market-cache_/market?${params.toString()}`, { method: 'GET' });
}

// /market uses the mints=false flavour of the asset list — mints metadata is
// dead weight on the marketplace path (counts already drive the haveAny
// filter and the floor/breakdown tiles). Computing on this flavour keeps the
// /market payload lean even for users on the Market tab without ever hitting
// Discover, which still pre-warms its own mints=true cache.
async function handleMarket(env, network, cors) {
  const assetsResp = await handleAssetsList(env, network, {}, { limit: null, includeMints: false });
  const assetsBody = JSON.parse(await assetsResp.text());
  const allAssets = assetsBody.assets || [];
  const haveAny = allAssets.filter(a =>
    Number(a.listing_count || 0) > 0
    || Number(a.range_listing_count || 0) > 0
    || Number(a.atomic_intent_count || 0) > 0
    || Number(a.preauth_sale_count || 0) > 0,
  );
  // Per-asset 4-way fan-out, all in this single worker invocation.
  // Best-effort: a per-asset failure leaves an empty bucket for that kind so
  // the rest of the response is still useful, mirroring the client's existing
  // .catch(() => ({listings: []})) tolerance.
  const all = await Promise.all(haveAny.map(async a => {
    const aid = a.asset_id;
    const [openings, ranges, intents, preauths] = await Promise.all([
      Number(a.listing_count || 0) > 0
        ? loadListingsForAsset(env, network, aid).catch(() => [])
        : Promise.resolve([]),
      Number(a.range_listing_count || 0) > 0
        ? loadRangeListingsForAsset(env, network, aid).catch(() => [])
        : Promise.resolve([]),
      Number(a.atomic_intent_count || 0) > 0
        ? loadAtomicIntentsForAsset(env, network, aid).catch(() => [])
        : Promise.resolve([]),
      Number(a.preauth_sale_count || 0) > 0
        ? loadPreauthSalesForAsset(env, network, aid).catch(() => [])
        : Promise.resolve([]),
    ]);
    // Strip expired and attach kind + _asset reference so the client can sort
    // and filter without needing to re-join against the assets array.
    const opens = openings.filter(l => !l.expired).map(l => ({ ...l, kind: 'opening', _asset: a }));
    const ranges_ = ranges.filter(l => !l.expired).map(l => ({ ...l, kind: 'range', _asset: a }));
    const intents_ = intents.filter(i => !i.expired).map(i => ({ ...i, kind: 'intent', _asset: a }));
    const preauths_ = preauths.filter(p => !p.expired).map(p => ({ ...p, kind: 'preauth', _asset: a }));
    return [...opens, ...ranges_, ...intents_, ...preauths_];
  }));
  return jsonResponse({
    network,
    assets: allAssets,
    listings: all.flat(),
    meta: assetsBody.meta || null,
  }, 200, cors);
}

// ============== /petch-assets edge cache (SWR + cron pre-warm) ==============
// Mirrors the /assets and /market patterns. /petch-assets is even costlier per
// MISS than /assets (every petch asset triggers its own loadCanonicalPmints
// fan-out for cap-progress hydration), so SWR + pre-warm matter more here.
const PETCH_ASSETS_CACHE_FRESH_MS = 60 * 1000;
const PETCH_ASSETS_CACHE_STALE_MS = 5 * 60 * 1000;
function petchAssetsCacheKey(network) {
  const params = new URLSearchParams();
  params.set('network', network);
  return new Request(`https://_petch-assets-cache_/petch-assets?${params.toString()}`, { method: 'GET' });
}
async function petchAssetsComputeAndCache(env, network) {
  const fresh = await handlePetchAssetsList(env, network, {});
  const body = await fresh.text();
  if (fresh.status === 200) {
    const ch = new Headers();
    ch.set('Content-Type', 'application/json');
    ch.set('X-Cached-At', String(Date.now()));
    ch.set('Cache-Control', `public, max-age=${Math.floor(PETCH_ASSETS_CACHE_STALE_MS / 1000)}`);
    await caches.default.put(
      petchAssetsCacheKey(network),
      new Response(body, { status: 200, headers: ch }),
    );
  }
  return { body, status: fresh.status };
}

// /pmints?credited=1 edge cache. The response is a flat list of credited
// txids (up to 50k) plus the snapshot fields — currently 3.3MB and ~7s
// cold-read for FAIR-scale assets. SWR (30s FRESH + 5min STALE) collapses
// concurrent reads across users/tabs at each Cloudflare POP so only the
// first request per window pays the inline-scan cost; everyone else gets an
// instant edge response. FRESH aligns with the dapp's local 30s
// _pmintCreditedCache so staleness doesn't exceed what the client already
// tolerates. STALE-while-revalidate keeps responses snappy past the FRESH
// window while a background refresh runs.
const PMINT_CREDITED_CACHE_FRESH_MS = 30 * 1000;
const PMINT_CREDITED_CACHE_STALE_MS = 5 * 60 * 1000;
function pmintCreditedCacheKey(network, aid) {
  const params = new URLSearchParams();
  params.set('network', network);
  return new Request(`https://_pmints-credited-cache_/${aid}?${params.toString()}`, { method: 'GET' });
}
async function pmintCreditedComputeAndCache(env, network, aid) {
  const fresh = await handlePmintList(aid, env, network, {}, { creditedOnly: true });
  const body = await fresh.text();
  if (fresh.status === 200) {
    const ch = new Headers();
    ch.set('Content-Type', 'application/json');
    ch.set('X-Cached-At', String(Date.now()));
    ch.set('Cache-Control', `public, max-age=${Math.floor(PMINT_CREDITED_CACHE_STALE_MS / 1000)}`);
    await caches.default.put(
      pmintCreditedCacheKey(network, aid),
      new Response(body, { status: 200, headers: ch }),
    );
  }
  return { body, status: fresh.status };
}

async function marketComputeAndCache(env, network) {
  const fresh = await handleMarket(env, network, {});
  const body = await fresh.text();
  if (fresh.status === 200) {
    const ch = new Headers();
    ch.set('Content-Type', 'application/json');
    ch.set('X-Cached-At', String(Date.now()));
    ch.set('Cache-Control', `public, max-age=${Math.floor(MARKET_CACHE_STALE_MS / 1000)}`);
    await caches.default.put(
      marketCacheKey(network),
      new Response(body, { status: 200, headers: ch }),
    );
  }
  return { body, status: fresh.status };
}

// ============== /holdings aggregate (per-user join) ==============
// Collapses the Holdings tab's per-asset 3-way fan-out (openings + listings
// + range listings) into one round-trip. Server-side filters listings to
// the requesting wallet's pubkey so the wire payload is much smaller than
// the per-asset endpoints would have been (which return all listings
// regardless of owner). Range listings use a direct .get() since their
// KV key already includes owner_pubkey — no list scan for that arm.
//
// Per-user → not edge-cacheable; the dapp's 30s _holdingsCache absorbs
// tab-switches. Cap on asset_ids prevents abuse.
async function handleHoldings(req, env, network, cors) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const ownerPubHex = String(body.owner_pubkey ?? '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex)) {
    return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed hex' }, 400, cors);
  }
  const aids = Array.isArray(body.asset_ids) ? body.asset_ids : [];
  if (aids.length === 0) {
    return jsonResponse({ openings: {}, listings: {}, range_listings: {} }, 200, cors);
  }
  if (aids.length > 200) {
    return jsonResponse({ error: 'asset_ids capped at 200' }, 400, cors);
  }
  for (const aid of aids) {
    if (typeof aid !== 'string' || !/^[0-9a-f]{64}$/.test(aid)) {
      return jsonResponse({ error: 'asset_ids must be 64-hex strings' }, 400, cors);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.all(aids.map(async aid => {
    const [openings, allListings, rangeListing] = await Promise.all([
      loadOpeningsForAsset(env, network, aid).catch(() => []),
      loadListingsForAsset(env, network, aid).catch(() => []),
      env.REGISTRY_KV.get(rangeListingKey(network, aid, ownerPubHex), 'json').catch(() => null),
    ]);
    // Server-side filter listings to this owner so the response carries
    // only what the holdings card actually renders.
    const myListings = allListings.filter(l => l.owner_pubkey === ownerPubHex);
    const myRange = rangeListing ? [rangeListing] : [];
    // Mirror loadRangeListingsForAsset's expired/claim normalisation for
    // the single-key direct .get() path.
    for (const v of myRange) {
      v.expired = (v.expiry || 0) <= now;
      if (v.claim && v.claim.expires_at <= now) v.claim = null;
    }
    return { aid, openings, listings: myListings, rangeListings: myRange };
  }));
  const openings = {};
  const listings = {};
  const rangeListings = {};
  for (const r of results) {
    openings[r.aid] = r.openings;
    listings[r.aid] = r.listings;
    rangeListings[r.aid] = r.rangeListings;
  }
  return jsonResponse({ openings, listings, range_listings: rangeListings }, 200, cors);
}

async function commitmentFromRevealTx(env, revealTxid, vout, network) {
  // Fallback path for attestations submitted before the cron has indexed the asset.
  // Fetch the reveal tx from mempool.space, decode the CETCH envelope at vin[0].witness[1],
  // and return its commitment so we can validate the opening before the cron catches up.
  const tx = await apiJson(env, `/tx/${revealTxid}`, {}, network);
  if (!tx?.vin?.[0]?.witness || tx.vin[0].witness.length < 3) {
    throw new Error('reveal tx has no Taproot script-path witness');
  }
  const envBytes = hexToBytes(tx.vin[0].witness[1]);
  const decoded = decodeEnvelopeScript(envBytes);
  if (!decoded || decoded.opcode !== T_CETCH) throw new Error('not a CETCH envelope');
  const ce = decodeCEtchPayload(decoded.payload);
  if (!ce) throw new Error('invalid CETCH payload');
  const aidHex = assetIdFor(revealTxid, vout >>> 0);
  return { commitment: ce.commitment, asset: { ticker: ce.ticker, decimals: ce.decimals, image_uri: ce.image_uri }, aidHex };
}

async function handleAttest(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) {
    return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  }
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const supplyStr = String(body.supply ?? '');
  const blindingHex = String(body.blinding ?? '').toLowerCase();
  if (!/^\d+$/.test(supplyStr)) return jsonResponse({ error: 'supply must be a base-10 integer string' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(blindingHex)) return jsonResponse({ error: 'blinding must be 64-hex-char (32 bytes)' }, 400, cors);
  let supply;
  try { supply = BigInt(supplyStr); } catch { return jsonResponse({ error: 'unparseable supply' }, 400, cors); }
  if (supply < 0n || supply >= (1n << BigInt(N_BITS))) {
    return jsonResponse({ error: `supply must be in [0, 2^${N_BITS})` }, 400, cors);
  }
  const blinding = BigInt('0x' + blindingHex);

  let commitmentHex = null;
  const indexed = await env.REGISTRY_KV.get(assetKey(network, assetIdHex), 'json');
  if (indexed?.commitment) {
    commitmentHex = indexed.commitment;
  } else {
    const revealTxid = String(body.reveal_txid ?? body.etch_tx ?? '').toLowerCase();
    const revealVout = Number.isInteger(body.reveal_vout) ? body.reveal_vout : 0;
    if (!/^[0-9a-f]{64}$/.test(revealTxid)) {
      return jsonResponse({
        error: 'asset not yet indexed; pass reveal_txid (and optional reveal_vout) so worker can fetch from chain',
      }, 404, cors);
    }
    try {
      const r = await commitmentFromRevealTx(env, revealTxid, revealVout, network);
      if (r.aidHex !== assetIdHex) {
        return jsonResponse({ error: `reveal_txid + vout do not derive to ${assetIdHex}` }, 400, cors);
      }
      commitmentHex = r.commitment;
    } catch (e) {
      return jsonResponse({ error: 'failed to resolve reveal tx: ' + e.message }, 400, cors);
    }
  }

  let claimed, onchain;
  try {
    claimed = pedersenCommit(supply, blinding);
    onchain = compressedPointFromHex(commitmentHex);
  } catch (e) {
    return jsonResponse({ error: 'commitment math failed: ' + e.message }, 400, cors);
  }
  if (!claimed.equals(onchain)) {
    return jsonResponse({ error: 'opening does not match on-chain commitment' }, 400, cors);
  }
  const attestation = {
    supply: supplyStr,
    blinding: blindingHex,
    attested_at: Math.floor(Date.now() / 1000),
  };
  await env.REGISTRY_KV.put(attestKey(network, assetIdHex), JSON.stringify(attestation));
  return jsonResponse({ ok: true, attestation }, 200, cors);
}

// Targeted-scan endpoint. The cron polls in 5-min ticks, so a freshly broadcast
// etch can take ~5–15 min to surface in /assets. The dApp calls this right after
// broadcast with the reveal txid; the worker fetches the tx directly from
// mempool.space (which serves unconfirmed txs too), validates the TACIT envelope,
// and writes the registry entry immediately. The cron later overwrites with
// confirmed metadata once the tx lands in a block.
async function handleAssetHint(req, env, network, cors, ctx) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
  const txidHex = String(body.reveal_txid ?? body.txid ?? '').toLowerCase();
  const vout = Number.isInteger(body.reveal_vout) ? body.reveal_vout : 0;
  if (!/^[0-9a-f]{64}$/.test(txidHex)) {
    return jsonResponse({ error: 'reveal_txid must be 64 hex chars' }, 400, cors);
  }
  if (vout < 0 || vout > 0xffff) {
    return jsonResponse({ error: 'reveal_vout out of range' }, 400, cors);
  }

  // Light per-IP daily cap. Hints only echo data already on chain (or in
  // mempool), so abuse is bounded — but we still don't want unbounded work.
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `hint:${day}:${ip}`;
  const limit = safeInt(env.HINT_LIMIT, 200, { min: 0 });
  const prior = safeInt(await env.REGISTRY_KV.get(kvKey), 0, { min: 0 });
  if (prior >= limit) return jsonResponse({ error: 'daily hint limit reached' }, 429, cors);

  let tx;
  try { tx = await apiJson(env, `/tx/${txidHex}`, {}, network); }
  catch (e) { return jsonResponse({ error: `tx not found on ${network}: ${e.message}` }, 404, cors); }
  if (!tx?.vin?.[0]?.witness || tx.vin[0].witness.length < 3) {
    return jsonResponse({ error: 'tx has no taproot script-path witness' }, 400, cors);
  }

  let envBytes;
  try { envBytes = hexToBytes(tx.vin[0].witness[1]); }
  catch { return jsonResponse({ error: 'invalid witness hex' }, 400, cors); }
  const decoded = decodeEnvelopeScript(envBytes);
  if (!decoded) return jsonResponse({ error: 'not a tacit envelope' }, 400, cors);

  const confirmed = !!tx.status?.confirmed;
  const blockHeight = Number.isInteger(tx.status?.block_height) ? tx.status.block_height : null;
  const blockTime = Number.isInteger(tx.status?.block_time) ? tx.status.block_time : null;

  if (decoded.opcode === T_CETCH) {
    const ce = decodeCEtchPayload(decoded.payload);
    if (!ce) return jsonResponse({ error: 'invalid CETCH payload' }, 400, cors);
    const aid = assetIdFor(txidHex, vout >>> 0);
    const existing = await env.REGISTRY_KV.get(assetKey(network, aid), 'json');
    if (existing && Number.isInteger(existing.etched_at_height)) {
      await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
      return jsonResponse({ ok: true, asset: existing, source: 'registry', network }, 200, cors);
    }
    const meta = {
      asset_id: aid,
      ticker: ce.ticker,
      decimals: ce.decimals,
      commitment: ce.commitment,
      image_uri: ce.image_uri,
      etch_txid: txidHex,
      etch_vout: vout,
      etched_at_height: blockHeight,
      etched_at: blockTime || Math.floor(Date.now() / 1000),
      mintable: ce.mintable,
      mint_authority: ce.mint_authority,
      pending: confirmed ? undefined : true,
      network,
    };
    await env.REGISTRY_KV.put(assetKey(network, aid), JSON.stringify(meta));
    await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
    return jsonResponse({ ok: true, asset: meta, source: 'hint', network }, 200, cors);
  }

  if (decoded.opcode === T_MINT) {
    const cm = decodeCMintPayload(decoded.payload);
    if (!cm) return jsonResponse({ error: 'invalid mint payload' }, 400, cors);
    const mk = mintKeyFor(network, cm.asset_id, txidHex);
    const existing = await env.REGISTRY_KV.get(mk, 'json');
    if (existing && Number.isInteger(existing.minted_at_height)) {
      await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
      return jsonResponse({ ok: true, mint: existing, source: 'registry', network }, 200, cors);
    }
    const mintMeta = {
      asset_id: cm.asset_id,
      etch_txid: cm.etch_txid,
      mint_txid: txidHex,
      mint_vout: vout,
      commitment: cm.commitment,
      minted_at_height: blockHeight,
      minted_at: blockTime || Math.floor(Date.now() / 1000),
      pending: confirmed ? undefined : true,
      network,
    };
    await env.REGISTRY_KV.put(mk, JSON.stringify(mintMeta));
    await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
    return jsonResponse({ ok: true, mint: mintMeta, source: 'hint', network }, 200, cors);
  }

  // CXFER/AXFER hint — bump the per-asset transfer counter. Without this the
  // counter only ticks on the next cron block-scan (5+ min lag on mainnet),
  // and any block scanned before the cron started running is permanently
  // missed since mainnet has zero backfill window. The xferseen dedupe in
  // bumpTransferCount makes this idempotent against the cron.
  if (decoded.opcode === T_CXFER || decoded.opcode === T_AXFER || decoded.opcode === T_AXFER_VAR) {
    const decoder = decoded.opcode === T_AXFER ? decodeAxferPayload
                  : decoded.opcode === T_AXFER_VAR ? decodeAxferVarPayload
                  : decodeCXferPayload;
    const dx = decoder(decoded.payload);
    if (!dx) return jsonResponse({ error: 'invalid transfer payload' }, 400, cors);
    const counted = await bumpTransferCount(env, network, dx.asset_id, txidHex);
    // Optional last-traded record. AXFER (whole-UTXO atomic OTC, §5.7) and
    // AXFER_VAR (variable-amount, §5.7.6.1) both have a well-defined trade
    // price the dapp can vouch for at broadcast time. For AXFER_VAR the
    // dapp hints the SCALED price (floor(requested × full_price / amount))
    // and the actual settled (requested) amount, so last_trade reflects the
    // unit price of the partial fill — not the full-lot list price. Without
    // this, every variable-amount trade would stamp the maker's listed
    // total and the mark_price would jitter on each partial settle.
    let lastTrade = null;
    if ((decoded.opcode === T_AXFER || decoded.opcode === T_AXFER_VAR)
        && Number.isInteger(body.price_sats) && body.price_sats > 0
        && typeof body.amount === 'string' && /^[0-9]+$/.test(body.amount)) {
      try {
        const amt = BigInt(body.amount);
        if (amt > 0n && amt < (1n << 64n)) {
          lastTrade = {
            txid: txidHex,
            price_sats: body.price_sats,
            amount: body.amount,
            ts: Math.floor(Date.now() / 1000),
          };
          // last_trade is last-write-wins; overwriting on a replay is harmless
          // (same data) and lets a stale display refresh.
          await env.REGISTRY_KV.put(lastTradeKey(network, dx.asset_id), JSON.stringify(lastTrade));
          // CRITICAL: the daily volume bucket and ring buffer are aggregations
          // — replaying a trade hint must NOT double-count or re-append. Gate
          // on bumpTransferCount's idempotency signal (`counted === true`
          // means this txid wasn't seen in the past 30 days). Without this
          // gate, anyone within the per-IP daily hint quota could re-POST
          // the same valid trade hint to inflate the asset's 24h volume.
          // ring buffer also has a txid-dedup as defense-in-depth, but it
          // only protects within the cap-50 window — old replays after
          // eviction would have slipped through.
          if (counted) {
            // Daily volume bucket. Add this trade's sats to today's bucket so
            // the asset endpoint can sum (today + yesterday) for a rolling 24h
            // figure. Bucket expires in 7 days — long after it's left the
            // window — to auto-collect without a sweeper.
            const dayKey = tradeDayKey(network, dx.asset_id, _utcYyyymmdd(lastTrade.ts));
            try {
              const prevDay = await env.REGISTRY_KV.get(dayKey);
              const prevSats = prevDay ? (Number(prevDay) || 0) : 0;
              await env.REGISTRY_KV.put(dayKey, String(prevSats + body.price_sats), { expirationTtl: 7 * 86400 });
            } catch { /* KV blip — bucket missing this trade is acceptable, last_trade still landed */ }
            // Recent-trades ring buffer. Append (newest-first) and trim to
            // TRADES_RING_CAP. Best-effort; failure here doesn't void the
            // last_trade write above.
            try {
              const ringKey = tradesRingKey(network, dx.asset_id);
              const prevRingJson = await env.REGISTRY_KV.get(ringKey);
              let ring = [];
              if (prevRingJson) {
                try { const j = JSON.parse(prevRingJson); if (Array.isArray(j)) ring = j; } catch {}
              }
              // Belt-and-suspender txid dedup inside the cap-window. The
              // outer `counted` gate handles the 30-day replay; this
              // catches the edge where the ring evicted the entry but the
              // seen-set still has it (or vice versa).
              if (!ring.some(r => r && r.txid === lastTrade.txid)) {
                ring.unshift(lastTrade);
                if (ring.length > TRADES_RING_CAP) ring.length = TRADES_RING_CAP;
                await env.REGISTRY_KV.put(ringKey, JSON.stringify(ring));
              }
            } catch { /* ring is best-effort */ }
          }
        }
      } catch { /* BigInt parse failed — ignore, transfer counter bump still landed */ }
    }
    await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
    return jsonResponse({
      ok: true, source: counted ? 'hint' : 'already-counted',
      asset_id: dx.asset_id, kind: decoded.opcode === T_AXFER ? 'axfer' : 'cxfer',
      ...(lastTrade ? { last_trade: lastTrade } : {}),
      network,
    }, 200, cors);
  }

  // BURN hint — write the burn record so the asset's supply ledger reflects
  // it immediately. Mirrors the cron's per-burn put at scanForEtches.
  if (decoded.opcode === T_BURN) {
    const cb = decodeCBurnPayload(decoded.payload);
    if (!cb) return jsonResponse({ error: 'invalid burn payload' }, 400, cors);
    const bk = burnKeyFor(network, cb.asset_id, txidHex);
    const existing = await env.REGISTRY_KV.get(bk, 'json');
    if (existing && Number.isInteger(existing.burned_at_height)) {
      await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
      return jsonResponse({ ok: true, burn: existing, source: 'registry', network }, 200, cors);
    }
    const burnMeta = {
      asset_id: cb.asset_id,
      burn_txid: txidHex,
      burned_amount: cb.burned_amount,
      burned_at_height: blockHeight,
      burned_at: blockTime || Math.floor(Date.now() / 1000),
      pending: confirmed ? undefined : true,
      network,
    };
    await env.REGISTRY_KV.put(bk, JSON.stringify(burnMeta));
    await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
    return jsonResponse({ ok: true, burn: burnMeta, source: 'hint', network }, 200, cors);
  }

  // T_PETCH hint — register a permissionless-mint deployment record so
  // /petch-assets surfaces it immediately rather than waiting for the cron to
  // re-scan its block. Mirrors the cron's per-petch put in scanForEtches; same
  // §5.8 mint_start_height invariant enforced here so a deployer can't bypass
  // §5.9 step-4 by hinting a malformed petch the cron would have dropped.
  // Mainnet's scanner is forward-only (backfillBlocks=0); without this branch a
  // T_PETCH whose reveal confirmed before the petch-aware code went live can
  // never be indexed at all.
  if (decoded.opcode === T_PETCH) {
    const cp = decodeCPetchPayload(decoded.payload);
    if (!cp) return jsonResponse({ error: 'invalid T_PETCH payload' }, 400, cors);
    if (cp.mint_start_height !== 0 && Number.isInteger(blockHeight) && cp.mint_start_height < blockHeight + 1) {
      return jsonResponse({ error: 'mint_start_height < etch_height + 1' }, 400, cors);
    }
    const aid = assetIdFor(txidHex, vout >>> 0);
    const existing = await env.REGISTRY_KV.get(petchKey(network, aid), 'json');
    if (existing && Number.isInteger(existing.etched_at_height)) {
      await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
      return jsonResponse({ ok: true, asset: existing, source: 'registry', network }, 200, cors);
    }
    const meta = {
      asset_id: aid,
      ticker: cp.ticker,
      decimals: cp.decimals,
      cap_amount: cp.cap_amount,
      mint_limit: cp.mint_limit,
      mint_start_height: cp.mint_start_height,
      mint_end_height: cp.mint_end_height,
      image_uri: cp.image_uri,
      etch_txid: txidHex,
      etch_vout: vout,
      etched_at_height: blockHeight,
      etched_at: blockTime || Math.floor(Date.now() / 1000),
      kind: 'petch',
      pending: confirmed ? undefined : true,
      network,
    };
    await env.REGISTRY_KV.put(petchKey(network, aid), JSON.stringify(meta));
    await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
    // Refresh the /petch-assets edge cache so the next discover render sees
    // the newly-hinted asset without waiting for the FRESH/STALE TTL to lapse.
    // Fire-and-forget; the response goes out regardless.
    // Delete the cached /petch-assets response and recompute. `caches.default`
    // is per-POP, so a single delete only invalidates this POP — but the
    // recompute writes a fresh entry that other POPs will pick up on their
    // next miss / FRESH-window expiry. Without the delete, this POP keeps
    // serving the pre-hint FRESH entry for up to PETCH_ASSETS_CACHE_FRESH_MS
    // even though we just wrote new state.
    await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
    petchAssetsComputeAndCache(env, network).catch(() => {});
    return jsonResponse({ ok: true, asset: meta, source: 'hint', network }, 200, cors);
  }

  // T_PMINT hint — register a permissionless mint event under the canonical
  // (height, tx_index, txid) key so /assets/<aid>/pmints and the cap counter
  // reflect it without waiting for the cron. Enforces SPEC §5.9 steps 1–4
  // exactly like the cron does (asset_id derivation, parent T_PETCH presence,
  // amount==mint_limit, height-window). tx_index requires fetching the block's
  // ordered txid list once — costlier than other hints but bounded by per-IP
  // daily cap and cached by Cloudflare for repeat hints in the same block.
  if (decoded.opcode === T_PMINT) {
    const cm = decodeCPmintPayload(decoded.payload);
    if (!cm) return jsonResponse({ error: 'invalid T_PMINT payload' }, 400, cors);
    // §5.9 step 1: asset_id derivation must match.
    const expectedAid = assetIdFor(cm.etch_txid, 0);
    if (expectedAid !== cm.asset_id) return jsonResponse({ error: 'asset_id != sha256(etch_txid_BE || 0_LE)' }, 400, cors);
    // §5.9 step 2: parent envelope must be T_PETCH (looked up by derived aid
    // so a forged cm.asset_id can't aim at a real CETCH namespace).
    const petch = await env.REGISTRY_KV.get(petchKey(network, expectedAid), 'json');
    if (!petch) return jsonResponse({ error: 'parent T_PETCH not indexed yet — hint the etch first' }, 400, cors);
    // §5.9 step 3: amount must equal mint_limit.
    try {
      if (BigInt(cm.amount) !== BigInt(petch.mint_limit)) {
        return jsonResponse({ error: 'amount != petch.mint_limit' }, 400, cors);
      }
    } catch {
      return jsonResponse({ error: 'unparseable amount' }, 400, cors);
    }
    // §5.9 step 4: confirmed_height in [effective_start, effective_end]. Skip
    // when not yet confirmed — the cron will pick the pmint up on confirmation
    // and re-validate. Out-of-window broadcasts get rejected so the cap counter
    // never sees them.
    if (confirmed && Number.isInteger(blockHeight)) {
      const etchH = Number.isInteger(petch.etched_at_height) ? petch.etched_at_height : null;
      if (etchH != null) {
        const effStart = petch.mint_start_height !== 0 ? petch.mint_start_height : etchH + 1;
        if (blockHeight < effStart) return jsonResponse({ error: 'mint before window opens' }, 400, cors);
        if (petch.mint_end_height !== 0 && blockHeight > petch.mint_end_height) {
          return jsonResponse({ error: 'mint after window closes' }, 400, cors);
        }
      }
    }
    // §5.9 step 5: Pedersen binding. Same check the cron path performs — see
    // the matching block in scanForEtches for rationale. Hint callers that
    // ship a forged commitment get rejected here rather than poisoning KV.
    if (!pmintCommitmentOpens(cm.amount, cm.blinding, cm.commitment)) {
      return jsonResponse({ error: 'commitment does not open to (amount, blinding)' }, 400, cors);
    }
    // Need the block's ordered txid list to find the canonical tx_index. Use
    // /block/<hash>/txids which returns the entire ordered list in one shot
    // (vs the paginated /block/<hash>/txs that scanForEtches walks).
    let txIndex = 0;
    if (confirmed && tx.status?.block_hash) {
      try {
        const txids = await apiJson(env, `/block/${tx.status.block_hash}/txids`, {}, network);
        if (Array.isArray(txids)) {
          const i = txids.indexOf(txidHex);
          if (i >= 0) txIndex = i;
        }
      } catch { /* fall through with txIndex=0; cron will rewrite the canonical key */ }
    }
    const mintMeta = {
      asset_id: cm.asset_id,
      etch_txid: cm.etch_txid,
      mint_txid: txidHex,
      mint_vout: 0,
      commitment: cm.commitment,
      amount: cm.amount,
      blinding: cm.blinding,
      minted_at_height: blockHeight,
      minted_at: blockTime || Math.floor(Date.now() / 1000),
      tx_index: txIndex,
      pending: confirmed ? undefined : true,
      network,
    };
    // Don't write unconfirmed PMINTs to the canonical pmint:* namespace.
    // The canonical key embeds zero-padded block height; an unconfirmed hint
    // would land under height 0000000000, which (a) lex-sorts ahead of every
    // real entry — polluting the first KV.list page on heavy assets — and
    // (b) was historically misclassified as deeply confirmed by
    // loadCanonicalPmints, crediting it toward the cap. The cron will pick
    // this PMINT up on confirmation and write it under its real
    // (height, tx_index) canonical key. Caller (postHint fire-and-forget)
    // doesn't read the body, so source='pending' is purely informational.
    if (!confirmed || !Number.isInteger(blockHeight)) {
      await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
      return jsonResponse({ ok: true, mint: mintMeta, source: 'pending', network }, 200, cors);
    }
    const pmk = pmintKeyFor(network, cm.asset_id, blockHeight, txIndex, txidHex);
    const existing = await env.REGISTRY_KV.get(pmk, 'json');
    if (existing && Number.isInteger(existing.minted_at_height)) {
      await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
      return jsonResponse({ ok: true, mint: existing, source: 'registry', network }, 200, cors);
    }
    await env.REGISTRY_KV.put(pmk, JSON.stringify(mintMeta));
    await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
    // Best-effort cleanup of any height-0 orphan that an earlier worker
    // version may have written for this same txid. Loop over candidate
    // tx_index values is unnecessary — Fix B above prevents new orphans —
    // but the `pmintKeyFor(...,0,0,txid)` form is the only shape the old
    // hint path produced (txIndex was 0 when blockHeight was null), so a
    // single targeted delete suffices for live cleanup.
    const stalePendingKey = pmintKeyFor(network, cm.asset_id, 0, 0, txidHex);
    if (stalePendingKey !== pmk) {
      env.REGISTRY_KV.delete(stalePendingKey).catch(() => {});
    }
    // Mark the asset dirty so the next cron tick refreshes its snapshot.
    // Sync mark is cheap (one KV.put with TTL); the actual snapshot refresh
    // happens in the background so the hint response stays fast.
    await markPetchDirty(env, network, cm.asset_id);
    // Schedule snapshot refresh + cache invalidation in the background.
    // Debounced via PETCH_REFRESH_DEBOUNCE_SECS so a burst of hints for the
    // same asset doesn't trigger N parallel snapshot scans — the first hint
    // in the window wins, every subsequent hint short-circuits (the mint is
    // already in the canonical KV namespace, markPetchDirty above ensures
    // the next cron tick reconciles). Hint response returns immediately; the
    // refresh runs after via ctx.waitUntil.
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil((async () => {
        try {
          const debounceKey = petchRefreshDebounceKey(network, cm.asset_id);
          const recent = await env.REGISTRY_KV.get(debounceKey);
          if (recent) return; // another hint refreshed inside the debounce window
          await env.REGISTRY_KV.put(debounceKey, '1', { expirationTtl: PETCH_REFRESH_DEBOUNCE_SECS });
          const tip = await fetchTipHeight(env, network);
          await refreshAndStorePetchProgress(env, network, cm.asset_id, tip, petch);
          await caches.default.delete(petchAssetsCacheKey(network));
          await petchAssetsComputeAndCache(env, network);
        } catch { /* best-effort: cron will reconcile on next tick */ }
      })());
    } else {
      // No ctx (synchronous caller path, e.g. tests). Fall back to the legacy
      // cache-bust behavior so the next reader at minimum sees a fresh recompute.
      await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
      petchAssetsComputeAndCache(env, network).catch(() => {});
    }
    return jsonResponse({ ok: true, mint: mintMeta, source: 'hint', network }, 200, cors);
  }

  return jsonResponse({ error: 'unsupported envelope opcode' }, 400, cors);
}

async function handleAssetGet(assetIdHex, env, network, cors) {
  const v = await env.REGISTRY_KV.get(assetKey(network, assetIdHex), 'json');
  if (!v) return jsonResponse({ error: 'unknown asset_id' }, 404, cors);
  const att = await env.REGISTRY_KV.get(attestKey(network, v.asset_id), 'json');
  if (att) v.attestation = att;
  v.mints = await loadMintsForAsset(env, network, assetIdHex);
  v.burns = await loadBurnsForAsset(env, network, assetIdHex);
  const op = await env.REGISTRY_KV.list({ prefix: openingPrefix(network, assetIdHex), limit: 1000 });
  v.opening_count = op.keys.length;
  // Disclosed-supply lower bound: sum of amounts across all published
  // openings. Each opening publishes (txid, vout, amount, blinding) for
  // one UTXO and is verified against the on-chain Pedersen commitment,
  // so each amount is cryptographically committed to a real on-chain
  // UTXO. Summing across distinct outpoints can't double-count, which
  // makes this a strict lower bound on circulating supply that any
  // observer can reproduce. Useful headline metric when the etcher
  // hasn't published the total-supply attestation. Only computed on the
  // single-asset endpoint (avoid N×17 fan-out on bulk /assets).
  if (op.keys.length > 0) {
    const openingRecords = await Promise.all(
      op.keys.slice(0, 1000).map(k => env.REGISTRY_KV.get(k.name, 'json'))
    );
    let sum = 0n;
    for (const r of openingRecords) {
      if (!r || typeof r.amount !== 'string') continue;
      try { sum += BigInt(r.amount); } catch {}
    }
    if (sum > 0n) v.disclosed_supply_min = sum.toString();
  }
  const dc = await env.REGISTRY_KV.list({ prefix: disclosurePrefix(network, assetIdHex), limit: 1000 });
  v.disclosure_count = dc.keys.length;
  const ls = await env.REGISTRY_KV.list({ prefix: listingPrefix(network, assetIdHex), limit: 1000 });
  v.listing_count = ls.keys.length;
  const lr = await env.REGISTRY_KV.list({ prefix: rangeListingPrefix(network, assetIdHex), limit: 1000 });
  v.range_listing_count = lr.keys.length;
  const ai = await env.REGISTRY_KV.list({ prefix: atomicIntentPrefix(network, assetIdHex), limit: 1000 });
  v.atomic_intent_count = ai.keys.length;
  const ps = await env.REGISTRY_KV.list({ prefix: preauthSalePrefix(network, assetIdHex), limit: 1000 });
  v.preauth_sale_count = ps.keys.length;
  // transfer_count + last_trade + volume_24h_sats are also in the
  // /assets list response via hydrateAssetSummary; mirror them here
  // so single-asset clients get the same discovery metrics. The
  // single-asset endpoint additionally returns trades (recent ring
  // buffer) — kept off the list response since the per-asset blob
  // can be large enough to matter when fanned across 50+ tokens.
  const xfer = await env.REGISTRY_KV.get(transferCountKey(network, assetIdHex));
  v.transfer_count = parseInt(xfer || '0', 10) || 0;
  const lastTrade = await env.REGISTRY_KV.get(lastTradeKey(network, assetIdHex), 'json');
  if (lastTrade) v.last_trade = lastTrade;
  // Rolling 24h volume = sum of today's + yesterday's UTC daily buckets.
  // The sum slightly over-counts (it covers up to 48h worst case) but a
  // straight 24h cutoff would require timestamped per-trade scanning; the
  // bucket sum is one-order-cheaper and the over-count is bounded.
  const nowSec = Math.floor(Date.now() / 1000);
  const todayKey = tradeDayKey(network, assetIdHex, _utcYyyymmdd(nowSec));
  const yestKey  = tradeDayKey(network, assetIdHex, _utcYyyymmdd(nowSec - 86400));
  const [todaySats, yestSats] = await Promise.all([
    env.REGISTRY_KV.get(todayKey),
    env.REGISTRY_KV.get(yestKey),
  ]);
  v.volume_24h_sats = (Number(todaySats) || 0) + (Number(yestSats) || 0);
  // Distinct-recipient counter, same field as the bulk response. Mirror
  // here so single-asset clients get the same popularity signal.
  const holderCntRaw = await env.REGISTRY_KV.get(holderCountKey(network, assetIdHex));
  v.holder_count = parseInt(holderCntRaw || '0', 10) || 0;
  // Recent trades. JSON array of up to TRADES_RING_CAP entries, newest
  // first. Empty array (rather than omission) so consumers can render
  // "no recent trades" without an undefined-vs-empty distinction.
  const ringJson = await env.REGISTRY_KV.get(tradesRingKey(network, assetIdHex));
  let trades = [];
  if (ringJson) { try { const j = JSON.parse(ringJson); if (Array.isArray(j)) trades = j; } catch {} }
  v.trades = trades;
  // mark_price — same priority as hydrateAssetSummary so single-asset and
  // list responses agree. Decimals comes from the asset record above; if a
  // legacy asset is missing decimals we skip rather than guess.
  if (Number.isInteger(v.decimals)) {
    const _dec = v.decimals;
    const _u = (priceSats, amountStr) => {
      const p = Number(priceSats);
      if (!Number.isFinite(p) || p <= 0) return null;
      let a; try { a = BigInt(amountStr || '0'); } catch { return null; }
      if (a <= 0n) return null;
      const num = BigInt(Math.floor(p)) * (10n ** BigInt(_dec)) * 100000000n;
      return Number(num / a) / 1e8;
    };
    // Same outlier-guarded mark_price logic as hydrateAssetSummary
    // (single-asset endpoint mirrors the bulk endpoint so clients hit
    // either path and see identical mark_price semantics).
    let _ringMedian = null;
    let _ringSampleCount = 0;
    if (trades.length > 0) {
      const units = trades.map(t => _u(t.price_sats, t.amount))
        .filter(u => Number.isFinite(u) && u > 0)
        .sort((a, b) => a - b);
      if (units.length > 0) {
        const mid = units.length >> 1;
        _ringMedian = (units.length % 2) ? units[mid] : (units[mid - 1] + units[mid]) / 2;
        _ringSampleCount = units.length;
      }
    }
    if (lastTrade && Number.isInteger(lastTrade.price_sats) && lastTrade.price_sats > 0) {
      const u = _u(lastTrade.price_sats, lastTrade.amount);
      if (u != null && u > 0) {
        if (_ringMedian != null && _ringSampleCount >= 5) {
          const ratio = u / _ringMedian;
          if (ratio > 5 || ratio < 0.2) {
            v.mark_price = {
              unit: _ringMedian,
              source: 'median_outlier_guard',
              sample: _ringSampleCount,
              last_trade_unit: u,
              last_trade_ratio_to_median: ratio,
            };
          } else {
            v.mark_price = { unit: u, source: 'last_trade', ts: Number(lastTrade.ts) || 0 };
          }
        } else {
          v.mark_price = { unit: u, source: 'last_trade', ts: Number(lastTrade.ts) || 0 };
        }
      }
    }
    if (!v.mark_price && _ringMedian != null) {
      v.mark_price = { unit: _ringMedian, source: 'median', sample: _ringSampleCount };
    }
  }
  // Per-window price-change deltas — same computation as
  // hydrateAssetSummary so single-asset clients see the same Δ% the
  // bulk /assets response carries. Previously only the bulk path
  // computed these, leaving the asset page's headline Δ% banner +
  // stats strip's 24h Δ row reading null and rendering "—" even when
  // the data was clearly there in the trade ring below.
  if (Number.isInteger(v.decimals) && trades.length > 0) {
    const _dec = v.decimals;
    const _u = (priceSats, amountStr) => {
      const p = Number(priceSats);
      if (!Number.isFinite(p) || p <= 0) return null;
      let a; try { a = BigInt(amountStr || '0'); } catch { return null; }
      if (a <= 0n) return null;
      const num = BigInt(Math.floor(p)) * (10n ** BigInt(_dec)) * 100000000n;
      return Number(num / a) / 1e8;
    };
    const ring = trades;
    const latestU = _u(ring[0].price_sats, ring[0].amount);
    if (latestU != null && latestU > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const refForCutoff = (cutoffSec) => {
        for (const t of ring) {
          const ts = Number(t.ts) || 0;
          if (ts >= cutoffSec) continue;
          const u = _u(t.price_sats, t.amount);
          if (u != null && u > 0) return { u, ts };
        }
        return null;
      };
      let oldestRef = null;
      for (let i = ring.length - 1; i >= 0; i--) {
        const u = _u(ring[i].price_sats, ring[i].amount);
        const ts = Number(ring[i].ts) || 0;
        if (u != null && u > 0 && ts > 0) { oldestRef = { u, ts }; break; }
      }
      const _pct = (latest, ref) => (ref && ref.u > 0 && latest != null)
        ? ((latest - ref.u) / ref.u) * 100
        : null;
      const r1h  = refForCutoff(nowSec -      3600);
      const r4h  = refForCutoff(nowSec -  4 * 3600);
      const r24h = refForCutoff(nowSec -     86400);
      const r7d  = refForCutoff(nowSec - 7 * 86400);
      const p1h  = _pct(latestU, r1h);
      const p4h  = _pct(latestU, r4h);
      const p24h = _pct(latestU, r24h);
      const p7d  = _pct(latestU, r7d);
      if (p1h  != null) v.price_1h_change_pct  = p1h;
      if (p4h  != null) v.price_4h_change_pct  = p4h;
      if (p24h != null) v.price_24h_change_pct = p24h;
      if (p7d  != null) v.price_7d_change_pct  = p7d;
      const pAll = _pct(latestU, oldestRef);
      if (pAll != null && oldestRef && oldestRef.u !== latestU) {
        v.price_all_change_pct = pAll;
        v.price_first_trade_ts = oldestRef.ts;
      }
      const candidates = [
        { window: '24h', pct: p24h },
        { window: '4h',  pct: p4h },
        { window: '1h',  pct: p1h },
        { window: '7d',  pct: p7d },
        { window: 'all', pct: pAll },
      ];
      const primary = candidates.find(c => c.pct != null);
      if (primary) {
        v.price_change_primary_pct = primary.pct;
        v.price_change_primary_window = primary.window;
      }
    }
  }
  return jsonResponse(v, 200, cors);
}

// SPEC §5.9 confirmation depth for cap correctness — see also §10. Tip-state
// T_PMINTs surface as 'pending' until they cross this depth; only credited
// mints count toward `cumulative_minted` and the cap.
const PMINT_CONFIRMATION_DEPTH = 3;

// SPEC §5.10 reorg-safety gate. A T_DEPOSIT becomes part of the canonical
// pool merkle tree only after this many confirmations. Without it a short
// reorg dropping the deposit's block silently changes the root for every
// position after it, bricking pending withdraw proofs that bound the old
// root. Value mirrors PMINT_CONFIRMATION_DEPTH for the same reason: 3 is
// past the deepest historical mainnet reorg (4 was the deepest ever, in
// 2010, and modern hashrate makes that effectively impossible). Read-side
// endpoints (/pools/:aid/:denom) annotate each leaf with `depth` + `status`
// so clients can distinguish included-in-tree from waiting-for-confirms;
// the dapp's local merkle tree builder consumes only `included` leaves to
// match the indexer-visible tree state.
const MIXER_DEPOSIT_CONFIRMATION_DEPTH = 3;

// Cap-bookkeeping helpers. `loadCanonicalPmints` returns mints in lexically-
// sorted KV order, which equals canonical (height, txid) order because the
// key embeds zero-padded height. Each entry is annotated with `depth`,
// `status`, and a credit decision derived from `cap_amount` and `mint_limit`.
//
// We deliberately do NOT maintain a live `pmint_count` counter in KV. The
// cron writes raw events; this read-side computation is the single source of
// truth for cap correctness, which makes reorg handling trivial — we never
// have to "undo" a stale counter, only re-list.
async function loadCanonicalPmints(env, network, assetIdHex, tipHeight, capAmountStr, mintLimitStr) {
  const capAmount = capAmountStr != null ? BigInt(capAmountStr) : null;
  const mintLimit = mintLimitStr != null ? BigInt(mintLimitStr) : null;
  // Two-prefix paginated KV.list. A single broad-prefix scan has a fatal
  // failure mode on assets polluted with thousands of height-0 orphan hints:
  // the orphans sort ahead of every canonical entry, exhaust the pagination
  // budget before reaching them, and silently drop credited mints from the
  // count. The split below queries each bucket separately so the orphan
  // backlog can't starve the canonical path.
  //
  // Orphans (legacy hint-endpoint pre-fix entries) all have padded-height
  // 0000000000. Canonical entries have padded-height matching the real
  // block. We list each in turn with cursor pagination, capped per-bucket
  // to bound Worker memory.
  const ORPHAN_HEIGHT_TOKEN = '0000000000:';
  const orphanPrefixStr = pmintPrefix(network, assetIdHex) + ORPHAN_HEIGHT_TOKEN;
  // Orphan walk: we only need the txids (callers match orphans by mint_txid),
  // not the values. Cap at 5000 — enough for a v1 backlog; the cleanup
  // runner drains them so this cap shrinks back to ~0 over time.
  const orphanTxids = [];
  let cursor = null;
  for (let page = 0; page < 30; page++) {
    const list = await env.REGISTRY_KV.list({
      prefix: orphanPrefixStr,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const k of list.keys) {
      const parts = k.name.split(':');
      orphanTxids.push(parts[parts.length - 1]);
    }
    if (list.list_complete || orphanTxids.length >= 5000) break;
    cursor = list.cursor;
    if (!cursor) break;
  }
  // Canonical walk: list the broader pmint:* prefix and drop orphan-range
  // matches. Orphans sort lex-first (height segment '0000000000' < every
  // real canonical height), so on a polluted asset the canonical entries
  // sit *after* tens of thousands of orphans. We page past the orphan
  // block by cursor and start collecting once we see canonical keys. Cap
  // total work at 50 pages × 1000 keys + 5000 canonical kept — comfortably
  // covers current mainnet pmints while bounding subrequest budget.
  const canonicalKeys = [];
  let canonCursor = null;
  let canonicalComplete = false;
  let canonicalTruncated = false;
  for (let page = 0; page < 60; page++) {
    const list = await env.REGISTRY_KV.list({
      prefix: pmintPrefix(network, assetIdHex),
      limit: 1000,
      ...(canonCursor ? { cursor: canonCursor } : {}),
    });
    for (const k of list.keys) {
      if (!k.name.startsWith(orphanPrefixStr)) canonicalKeys.push(k);
    }
    if (list.list_complete) { canonicalComplete = true; break; }
    if (canonicalKeys.length >= 5000) { canonicalTruncated = true; break; }
    canonCursor = list.cursor;
    if (!canonCursor) { canonicalComplete = true; break; }
  }
  if (!canonicalComplete && !canonicalTruncated) canonicalTruncated = true;
  // Batch the per-key KV.get calls for canonical entries only. Earlier code
  // used a single Promise.all over every key, which on a dense asset spun
  // up that many concurrent KV reads inside one Worker isolate; with
  // /petch-assets fanning out the loader across N assets in parallel, peak
  // memory pressure tipped past the 128 MiB ceiling. Chunked keeps in-flight
  // count bounded without serializing the full list.
  const canonical = [];
  const CHUNK = 50;
  for (let i = 0; i < canonicalKeys.length; i += CHUNK) {
    const slice = canonicalKeys.slice(i, i + CHUNK);
    const part = await Promise.all(slice.map(k => env.REGISTRY_KV.get(k.name, 'json')));
    for (const v of part) if (v) canonical.push(v);
  }
  // Synthesize lean orphan placeholders so callers that iterate `events`
  // still see the right `pending_count` and can match by mint_txid without
  // 3400 round-trips.
  const orphanEvents = orphanTxids.map(t => ({
    asset_id: assetIdHex,
    mint_txid: t,
    mint_vout: 0,
    pending: true,
    minted_at_height: null,
    status: 'pending',
    credited: false,
    depth: null,
  }));
  const events = canonical.concat(orphanEvents);
  // KV.list returns keys in lex order; the embedded zero-padded
  // (height, tx_index, txid) makes that lex order equal to canonical
  // chain order — SPEC §5.9 *Cap-overflow ordering*.
  let creditedCount = 0n;
  let creditedAmount = 0n;
  const annotated = events.map(e => {
    // Defensive: an earlier worker version (handleAssetHint T_PMINT branch)
    // wrote unconfirmed hints into this canonical namespace with
    // minted_at_height=null, which the previous `Number(null) || 0 = 0`
    // computation turned into a fake `depth = tip + 1`, crediting them as
    // deeply confirmed. Trust `pending: true` and require an integer height
    // before doing the depth math. The cron's confirmed entry under a
    // real-height key supersedes any orphan; the orphan stays here as
    // 'pending' and is never credited.
    if (e.pending === true || !Number.isInteger(e.minted_at_height)) {
      return { ...e, depth: null, status: 'pending', credited: false };
    }
    const h = e.minted_at_height;
    // Bitcoin convention: a tx in block N has 1 confirmation when tip == N
    // (the tx's own block counts). SPEC §5.9 cites the standard "~1% reorg
    // risk at depth 3" threshold, which is 3 confirmations. So depth here =
    // confirmations = (tipHeight - h) + 1.
    const depth = Number.isInteger(tipHeight) ? Math.max(0, tipHeight - h + 1) : null;
    let status;
    let credited = false;
    if (depth == null) {
      status = 'unknown_depth';   // tip unavailable — surface to UI but don't credit
    } else if (depth < PMINT_CONFIRMATION_DEPTH) {
      status = 'pending';
    } else if (capAmount != null && mintLimit != null) {
      const wouldBe = creditedAmount + mintLimit;
      if (wouldBe > capAmount) {
        status = 'cap_overflow';
      } else {
        status = 'credited';
        credited = true;
        creditedCount += 1n;
        creditedAmount = wouldBe;
      }
    } else {
      status = 'credited';   // missing cap metadata; can't enforce, default to credit
      credited = true;
      creditedCount += 1n;
      if (mintLimit != null) creditedAmount += mintLimit;
    }
    return { ...e, depth, status, credited };
  });
  // Also flag truncation if the orphan walk hit its cap. Even though orphan
  // entries don't credit, an unbounded backlog being capped means we may
  // have missed orphan txids the caller wanted to match against.
  const orphanTruncated = orphanTxids.length >= 5000;
  return {
    events: annotated,
    credited_count: creditedCount.toString(),
    cumulative_minted: creditedAmount.toString(),
    truncated: canonicalTruncated || orphanTruncated,
    canonical_truncated: canonicalTruncated,
    orphan_truncated: orphanTruncated,
  };
}

// SAFETY_CAP / page bounds for snapshot refresh. The key-only scan is far
// cheaper than loadCanonicalPmints's value-fetch path, so we can afford a
// much larger window. 300k keys ≈ 300 KV.list calls (one per 1000-key page)
// — sequential at ~50ms each, ~15s wall-time, well within the cron's
// 30s budget but too costly for synchronous user requests (hence the
// snapshot indirection: this runs in the background via ctx.waitUntil).
// Covers any current fair-launch asset (FAIR's cap of 21M/100 = 210k mints
// fits with ~40% headroom for cap_overflow + out-of-window events that
// don't credit but still occupy canonical key slots).
const PETCH_REFRESH_MAX_PAGES = 300;
const PETCH_REFRESH_SAFETY_CAP = 300000;
// Mark a petch asset as dirty so the next cron tick refreshes its snapshot.
// Short TTL: a dropped flag just delays refresh by one tick (5 min) — not
// data loss, since the snapshot recomputes from canonical KV state anyway.
const PETCH_DIRTY_TTL_SECS = 30 * 60;
// Hint-triggered refresh debounce window. First hint POST for a given asset
// refreshes its snapshot inside ctx.waitUntil; subsequent hints inside this
// window short-circuit (the just-broadcast pmint will be in the next
// scheduled refresh anyway, since markPetchDirty is still called). 30s
// matches the dapp's _pmintCreditedCache local TTL — staleness past that
// window is already tolerated by clients.
const PETCH_REFRESH_DEBOUNCE_SECS = 30;

// Compute a fresh cap-progress snapshot for one asset by key-only scan of
// canonical pmint:* entries. Returns the snapshot object (NOT written to KV
// — caller decides). Mirrors handlePetchAssetsList's per-asset loop semantics
// (depth gate, cap-overflow ordering, orphan skip) but produces an aggregate
// that read endpoints can return in O(1) per asset.
async function refreshPetchProgress(env, network, aid, tipHeight, petch) {
  if (!petch) return null;
  // Without a tip we can't enforce SPEC §5.9's depth-3 credit gate. The
  // alternative — crediting every confirmed mint regardless of depth — would
  // race the cron's next tick (which DOES have a tip) and produce
  // over-counts in the interim. Refuse to refresh; the existing snapshot (if
  // any) keeps serving and the next tick retries with a fresh tip. Matches
  // loadCanonicalPmints's `unknown_depth` semantics applied to the aggregate.
  if (!Number.isInteger(tipHeight)) return null;
  const orphanPrefixStr = pmintPrefix(network, aid) + '0000000000:';
  const capAmount = petch.cap_amount != null ? BigInt(petch.cap_amount) : null;
  const mintLimit = petch.mint_limit != null ? BigInt(petch.mint_limit) : null;
  let creditedCount = 0;
  let creditedAmount = 0n;
  let capOverflowCount = 0;
  let pendingCount = 0;
  let canonicalCount = 0;
  let lastCreditedH = null;
  let lastCreditedTi = null;
  let lastCreditedTxid = null;
  // cap_overflow_txids stored on the snapshot so the dapp can identify
  // permanently-rejected mints without paging through the full /pmints list.
  // Bounded: only the cap-saturation tail produces overflows, so the list
  // stays small in practice (CONF currently has 86; pre-saturation assets
  // have 0). Cap at 10000 entries to guard against pathological cases.
  const capOverflowTxids = [];
  const CAP_OVERFLOW_TXIDS_MAX = 10000;
  let truncated = false;
  let canonicalComplete = false;
  let cursor = null;
  for (let page = 0; page < PETCH_REFRESH_MAX_PAGES; page++) {
    const lst = await env.REGISTRY_KV.list({
      prefix: pmintPrefix(network, aid),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const k of lst.keys) {
      if (k.name.startsWith(orphanPrefixStr)) continue;
      canonicalCount++;
      const parts = k.name.split(':');
      const txid = parts[parts.length - 1];
      const ti = parseInt(parts[parts.length - 2], 10);
      const h = parseInt(parts[parts.length - 3], 10);
      if (!Number.isInteger(h) || !Number.isInteger(ti) || !/^[0-9a-f]{64}$/.test(txid)) continue;
      const depth = Math.max(0, tipHeight - h + 1);
      if (depth < PMINT_CONFIRMATION_DEPTH) { pendingCount++; continue; }
      if (capAmount != null && mintLimit != null) {
        const wouldBe = creditedAmount + mintLimit;
        if (wouldBe > capAmount) {
          capOverflowCount++;
          if (capOverflowTxids.length < CAP_OVERFLOW_TXIDS_MAX) capOverflowTxids.push(txid);
          continue;
        }
        creditedAmount = wouldBe;
        creditedCount++;
        lastCreditedH = h;
        lastCreditedTi = ti;
        lastCreditedTxid = txid;
      } else {
        creditedCount++;
        lastCreditedH = h;
        lastCreditedTi = ti;
        lastCreditedTxid = txid;
        if (mintLimit != null) creditedAmount += mintLimit;
      }
      if (canonicalCount >= PETCH_REFRESH_SAFETY_CAP) { truncated = true; break; }
    }
    if (truncated) break;
    if (lst.list_complete) { canonicalComplete = true; break; }
    cursor = lst.cursor;
    if (!cursor) { canonicalComplete = true; break; }
  }
  if (!canonicalComplete && !truncated) truncated = true;
  // Orphan count: separate key-only scan, capped at 5000 (legacy backlog).
  let orphanCount = 0;
  let orphanComplete = false;
  cursor = null;
  for (let page = 0; page < 60; page++) {
    const lst = await env.REGISTRY_KV.list({ prefix: orphanPrefixStr, limit: 1000, ...(cursor ? { cursor } : {}) });
    orphanCount += lst.keys.length;
    if (lst.list_complete) { orphanComplete = true; break; }
    if (orphanCount >= 5000) break;
    cursor = lst.cursor;
    if (!cursor) { orphanComplete = true; break; }
  }
  // `cap_counter_final` is the strict authoritativeness signal: it's true iff
  // cumulative_minted / mints_remaining / credited_pmint_count can no longer
  // change as new blocks arrive. Two sufficient conditions:
  //   1. credited_amount == cap_amount — cap is full, additional confirmed
  //      pmints can only be cap_overflow (don't move cumulative_minted).
  //   2. mint window has closed at the snapshot's tip (mint_end_height set
  //      AND tip_at_update > mint_end_height + PMINT_CONFIRMATION_DEPTH);
  //      no future pmint can ever pass the §5.9 step 4 height-window gate.
  // Anything else — including healthy in-progress fair launches — is NOT
  // authoritative: the snapshot may be momentarily complete but the very next
  // block can credit more mints. cumulative_minted etc. are only
  // authoritative when accounting is complete.
  const capFull = (capAmount != null && creditedAmount === capAmount);
  const windowClosed = (
    Number.isInteger(petch.mint_end_height) && petch.mint_end_height > 0 &&
    Number.isInteger(tipHeight) &&
    tipHeight > petch.mint_end_height + PMINT_CONFIRMATION_DEPTH
  );
  const capCounterFinal = capFull || windowClosed;
  return {
    credited_count: creditedCount,
    credited_amount: creditedAmount.toString(),
    cap_overflow_count: capOverflowCount,
    cap_overflow_txids: capOverflowTxids,
    cap_overflow_truncated: capOverflowCount > capOverflowTxids.length,
    pending_count: pendingCount + orphanCount,
    canonical_count: canonicalCount,
    orphan_count: orphanCount,
    last_credited_height: lastCreditedH,
    last_credited_tx_index: lastCreditedTi,
    last_credited_txid: lastCreditedTxid,
    tip_at_update: Number.isInteger(tipHeight) ? tipHeight : null,
    updated_at: Math.floor(Date.now() / 1000),
    truncated,
    // Snapshot KV scan completed without hitting its page/key caps. Distinct
    // from `bootstrapped` (which also requires positive cap-counter finality);
    // surfaced for consumers that want to distinguish "scan worked end-to-end"
    // from "the cap counter is authoritative".
    snapshot_scan_complete: !truncated && orphanComplete,
    cap_counter_final: capCounterFinal,
    // `bootstrapped` is the cap-counter-authoritativeness signal — true only
    // when both the snapshot scan completed AND the cap counter is final
    // (capFull or windowClosed). Consumers should treat mid-mint counts as
    // non-final until this flag flips.
    bootstrapped: !truncated && orphanComplete && capCounterFinal,
    schema_version: 1,
  };
}

// Refresh + write the snapshot. Returns the snapshot. Use this from cron and
// from hint POST's ctx.waitUntil callback.
async function refreshAndStorePetchProgress(env, network, aid, tipHeight, petch) {
  const snap = await refreshPetchProgress(env, network, aid, tipHeight, petch);
  if (snap) {
    await env.REGISTRY_KV.put(petchProgressKey(network, aid), JSON.stringify(snap));
  }
  return snap;
}

// Read snapshot; returns null if missing or schema-mismatched.
async function readPetchProgress(env, network, aid) {
  const v = await env.REGISTRY_KV.get(petchProgressKey(network, aid), 'json');
  if (!v || v.schema_version !== 1) return null;
  return v;
}

// Mark asset dirty so the next cron tick re-refreshes the snapshot.
async function markPetchDirty(env, network, aid) {
  try {
    await env.REGISTRY_KV.put(petchDirtyKey(network, aid), '1', { expirationTtl: PETCH_DIRTY_TTL_SECS });
  } catch { /* dropping a dirty marker just delays refresh; not fatal */ }
}

// Helper: fetch tip, time-bounded so a slow mempool.space endpoint doesn't
// stall the whole snapshot refresh. Mirrors the inline tipP idiom used by
// handlePetchAssetsList today.
async function fetchTipHeight(env, network, timeoutMs = 2500) {
  return Promise.race([
    apiText(env, '/blocks/tip/height', {}, network).then(s => parseInt(s.trim(), 10)),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]).catch(() => null);
}

// Promote height-0 orphan T_PMINTs left behind by an older worker version
// whose hint endpoint wrote unconfirmed pmints into the canonical pmint:*
// namespace under (height=0, idx=0, txid) keys with `pending: true,
// minted_at_height: null`. Once the reveal tx confirms, the orphan must be
// rewritten under its real (height, tx_index, txid) canonical key so
// loadCanonicalPmints credits it toward the cap. The cron's per-block scan
// does this on the fly when scanning the reveal's block, but assets whose
// blocks pre-date deployment of the fix never get re-scanned (last_scanned
// has already advanced past them) and the orphans sit forever as pending.
//
// This walker:
//   1. Lists every petch asset (lightweight cursor scan; petches are sparse).
//   2. For each asset, lists pmint:*:0000000000:* orphan keys.
//   3. For each orphan, fetches /tx/<txid> from mempool.space:
//      - confirmed → look up (height, tx_index), write canonical key, delete orphan.
//      - unconfirmed → skip (still legitimately pending).
//      - 404 (replaced-by-fee, dropped) → leave alone for now; a separate
//        reaper would need to GC these but they're rare and harmless until then.
//   4. Caps total work per call via `maxOps` so the cron's tick budget stays
//      bounded.
//
// Per-block /block/<hash>/txids is cached across orphans in the same block to
// keep the API call count near 1 per orphan rather than 2.
async function promotePmintOrphans(env, network, { maxOps = 50, assetIdHex = null } = {}) {
  let opsRemaining = maxOps;
  let promoted = 0;
  let unconfirmed = 0;
  let errored = 0;
  // Bounded LRU for /block/<hash>/txids responses. Each response is up to
  // ~200KB (3000 64-hex txids), so caching unbounded blew the Worker's
  // 128 MiB memory ceiling on bulk runs. Cap at 8 entries — orphans tend
  // to cluster in nearby blocks so even a small cache dedupes most calls.
  const blockTxidsCache = new Map();
  const BLOCK_CACHE_MAX = 8;
  const fetchBlockTxids = async (hash) => {
    const cached = blockTxidsCache.get(hash);
    if (cached !== undefined) return cached;
    let txids = null;
    try { txids = await apiJson(env, `/block/${hash}/txids`, {}, network); }
    catch { txids = null; }
    if (blockTxidsCache.size >= BLOCK_CACHE_MAX) {
      // Drop oldest insertion (Map preserves insertion order).
      const firstKey = blockTxidsCache.keys().next().value;
      blockTxidsCache.delete(firstKey);
    }
    blockTxidsCache.set(hash, txids);
    return txids;
  };

  // Walk known petch assets. Petches are sparse (one per fair launch) so a
  // single 1000-key page covers any v1 deployment. With assetIdHex set, we
  // narrow to a single asset — useful when bulk-draining a specific backlog
  // (e.g. FAIR with 3000+ orphans) without spending the per-call budget on
  // assets that are nearly drained already.
  let petchKeys;
  if (assetIdHex && /^[0-9a-f]{64}$/.test(assetIdHex)) {
    const exists = await env.REGISTRY_KV.get(petchKey(network, assetIdHex), 'json');
    petchKeys = exists ? [{ name: petchKey(network, assetIdHex) }] : [];
  } else {
    const petchList = await env.REGISTRY_KV.list({ prefix: petchPrefix(network), limit: 1000 });
    petchKeys = petchList.keys;
  }
  for (const k of petchKeys) {
    if (opsRemaining <= 0) break;
    const aid = k.name.slice(petchPrefix(network).length);
    if (!/^[0-9a-f]{64}$/.test(aid)) continue;
    // Orphan keys all share the height=0 prefix.
    const orphanPrefix = `${pmintPrefix(network, aid)}0000000000:`;
    let cursor = null;
    let pageGuard = 0;
    while (opsRemaining > 0 && pageGuard++ < 20) {
      const orphanList = await env.REGISTRY_KV.list({
        prefix: orphanPrefix,
        limit: Math.min(opsRemaining, 100),
        ...(cursor ? { cursor } : {}),
      });
      // Process this page's keys in fixed-size parallel batches. Sequential
      // per-orphan was bottlenecked on mempool.space round-trip latency
      // (~500ms each); even max=20 timed out at 60s wall clock. Parallelism
      // of 5 keeps API calls in-flight without spiking memory or tripping
      // mempool.space's per-IP rate limit. Per-orphan logic still serializes
      // the KV.put → KV.delete write pair so we never lose the record.
      const PARALLEL = 5;
      const promoteOne = async (o) => {
        const parts = o.name.split(':');
        const txid = parts[parts.length - 1];
        if (!/^[0-9a-f]{64}$/.test(txid)) return null;
        let status;
        try { status = await apiJson(env, `/tx/${txid}/status`, {}, network); }
        catch { return { kind: 'errored' }; }
        if (!status?.confirmed) return { kind: 'unconfirmed' };
        const h = status.block_height;
        const blockHash = status.block_hash;
        if (!Number.isInteger(h) || !blockHash) return { kind: 'errored' };
        const txids = await fetchBlockTxids(blockHash);
        let txIndex = 0;
        if (Array.isArray(txids)) {
          const i = txids.indexOf(txid);
          if (i >= 0) txIndex = i;
        }
        const orphan = await env.REGISTRY_KV.get(o.name, 'json');
        if (!orphan) return null;
        const promotedMeta = {
          ...orphan,
          minted_at_height: h,
          minted_at: status.block_time || orphan.minted_at,
          tx_index: txIndex,
          kind: 'pmint',
          network,
        };
        delete promotedMeta.pending;
        const pmk = pmintKeyFor(network, aid, h, txIndex, txid);
        // Order matters: write canonical first, then delete orphan. If the
        // delete races with a concurrent reader, they see both entries
        // briefly (loadCanonicalPmints handles this — the canonical entry
        // credits, the orphan classifies as pending and returns false). If
        // the put fails before the delete, the orphan stays for next pass.
        await env.REGISTRY_KV.put(pmk, JSON.stringify(promotedMeta));
        await env.REGISTRY_KV.delete(o.name);
        return { kind: 'promoted' };
      };
      for (let i = 0; i < orphanList.keys.length && opsRemaining > 0; i += PARALLEL) {
        const slice = orphanList.keys.slice(i, Math.min(i + PARALLEL, i + opsRemaining));
        opsRemaining -= slice.length;
        const results = await Promise.all(slice.map(promoteOne));
        for (const r of results) {
          if (!r) continue;
          if (r.kind === 'promoted') promoted++;
          else if (r.kind === 'unconfirmed') unconfirmed++;
          else if (r.kind === 'errored') errored++;
        }
      }
      if (orphanList.list_complete) break;
      cursor = orphanList.cursor;
      if (!cursor) break;
    }
  }
  return { network, promoted, unconfirmed, errored, ops_used: maxOps - opsRemaining };
}

// Refresh cap-progress snapshots for petch assets that have new activity.
// Walks the dirty-marker namespace (set by hint POSTs + cron block scan)
// and recomputes the snapshot for each, capped per-tick so a flurry of
// new mints across many assets doesn't blow the cron's wall-time budget.
// Also opportunistically bootstraps assets that have no snapshot yet.
// The MAX_PER_TICK cap
// ensures FAIR-scale heavy assets get refreshed in priority order without
// starving smaller assets — anything not refreshed this tick gets picked
// up on the next 5-min tick.
async function refreshDirtyPetchSnapshots(env, network, { maxPerTick = 5 } = {}) {
  let refreshed = 0;
  let bootstrapped = 0;
  let errored = 0;
  const tip = await fetchTipHeight(env, network);
  // Walk dirty markers first; these reflect "something landed this tick"
  // and are highest priority. Limit batch size so the cron stays bounded.
  const dirtyList = await env.REGISTRY_KV.list({
    prefix: petchDirtyPrefix(network),
    limit: maxPerTick * 2,
  });
  const dirtyAids = [];
  const dirtyPrefixLen = petchDirtyPrefix(network).length;
  for (const k of dirtyList.keys) {
    const aid = k.name.slice(dirtyPrefixLen);
    if (/^[0-9a-f]{64}$/.test(aid)) dirtyAids.push(aid);
  }
  for (const aid of dirtyAids.slice(0, maxPerTick)) {
    try {
      const petch = await env.REGISTRY_KV.get(petchKey(network, aid), 'json');
      if (!petch) { await env.REGISTRY_KV.delete(petchDirtyKey(network, aid)).catch(() => {}); continue; }
      const snap = await refreshAndStorePetchProgress(env, network, aid, tip, petch);
      // We deliberately do NOT pre-warm the /pmints?credited=1 fat-path edge
      // cache here. The new dapp uses ?include_txids=0 (slim path, ~50ms,
      // served directly from the snapshot we just refreshed) and bypasses
      // that cache entirely. Old dapp clients still in stale browser caches
      // pay one cold MISS per 30s FRESH window per POP, which is acceptable
      // for a deprecated path. Saves ~14s of cron CPU per FAIR-scale asset
      // and the per-POP edge storage of a 3.3MB response.
      if (snap) {
        // Only clear the dirty marker on successful refresh. If refresh
        // returned null (tip unavailable), leave the marker so the next tick
        // retries — otherwise we'd lose the signal and the snapshot would
        // sit stale until another pmint reset the marker.
        await env.REGISTRY_KV.delete(petchDirtyKey(network, aid)).catch(() => {});
        refreshed++;
      }
    } catch { errored++; }
  }
  // Then bootstrap any assets with no snapshot at all (one per tick is fine —
  // post-deploy backfill is amortized over multiple ticks). Skip entirely if
  // tip is unavailable: refresh would return null anyway, just wasting a
  // KV.list + per-asset KV.get.
  if (refreshed < maxPerTick && Number.isInteger(tip)) {
    const petches = await env.REGISTRY_KV.list({ prefix: petchPrefix(network), limit: 1000 });
    for (const k of petches.keys) {
      const aid = k.name.slice(petchPrefix(network).length);
      if (!/^[0-9a-f]{64}$/.test(aid)) continue;
      const existing = await readPetchProgress(env, network, aid);
      if (existing) continue;
      try {
        const petch = await env.REGISTRY_KV.get(k.name, 'json');
        if (!petch) continue;
        const snap = await refreshAndStorePetchProgress(env, network, aid, tip, petch);
        if (snap) bootstrapped++;
        if (refreshed + bootstrapped >= maxPerTick) break;
      } catch { errored++; }
    }
  }
  return { network, refreshed, bootstrapped, errored, tip };
}

// ============== PMINT BACKFILL (one-time FAIR recovery for issue #31) =======
// FAIR's mainnet etch landed during dense fair-launch reveal blocks (3000-5500
// txs/block) and the cron's per-tick subrequest budget ran out before the
// block's pmint tail was indexed — silently dropping ~125k canonical entries
// across blocks 948488..948700 (issue #31 Problem #4 + utx0set's clarifying
// comment). The HTTP /admin/pmint-backfill endpoint exists for one-shot
// recovery, but FAIR-era blocks are too large to fit in a single CF wall-time
// budget. This cron-driven variant processes one block per tick (~5 min
// cadence), persists progress in a KV cursor, and self-terminates when
// complete. Configuration is intentionally hardcoded — this is migration code
// for a specific historical incident, not a generic feature.
//
// Removal: after FAIR completes (cursor.completed_at set), this function is
// a no-op forever. Safe to delete the call site + function in a follow-up
// commit once the snapshot has read as bootstrapped=true for a tick.
const PMINT_BACKFILLS = [
  {
    network: 'mainnet',
    aid: 'c4a678d6d674cdd0f4a1a9df0cb5980bd1255bd0b62f8ddc886e61bd43f56b83',  // FAIR
    from_height: 948488,
    end_height: 948700,
  },
];
function pmintBackfillCursorKey(network, aid) {
  return `pmint_backfill:${network}:${aid}`;
}
async function runPmintBackfills(env) {
  // Time budget: process blocks until 20s of wall-clock has elapsed inside
  // backfill, then yield. Leaves ~10s headroom for CF wall-time limits (which
  // are shared with the main cron block's ctx.waitUntil). Early FAIR blocks
  // have very few PMINTs and finish in <1s; dense blocks take ~10s; mixing
  // lets us chew through the sparse range fast.
  const deadline = Date.now() + 20_000;
  for (const cfg of PMINT_BACKFILLS) {
    try {
      while (Date.now() < deadline) {
        const result = await runOnePmintBackfill(env, cfg);
        if (result === 'done' || result === 'skip') break;
      }
    } catch { /* swallow per-backfill errors — next tick retries */ }
  }
}
async function runOnePmintBackfill(env, cfg) {
  const { network, aid, from_height, end_height } = cfg;
  const cursorKey = pmintBackfillCursorKey(network, aid);
  let cursor = await env.REGISTRY_KV.get(cursorKey, 'json');
  // Done marker — no-op forever once set.
  if (cursor && cursor.completed_at) return 'done';
  if (!cursor) {
    cursor = {
      next_height: from_height,
      end_height,
      started_at: Math.floor(Date.now() / 1000),
      total_wrote: 0,
      total_rejected: 0,
    };
    await env.REGISTRY_KV.put(cursorKey, JSON.stringify(cursor));
  }
  if (cursor.next_height > cursor.end_height) {
    cursor.completed_at = Math.floor(Date.now() / 1000);
    await env.REGISTRY_KV.put(cursorKey, JSON.stringify(cursor));
    await markPetchDirty(env, network, aid);
    return 'done';
  }
  const petch = await env.REGISTRY_KV.get(petchKey(network, aid), 'json');
  // Petch not yet indexed (e.g. fresh deploy on a different network) — defer.
  if (!petch) return 'skip';
  const h = cursor.next_height;
  let blockHash;
  try { blockHash = (await apiText(env, `/block-height/${h}`, {}, network)).trim(); }
  catch (e) {
    cursor.last_error = `block-height/${h} fetch failed: ${e.message}`;
    cursor.last_tick_at = Math.floor(Date.now() / 1000);
    await env.REGISTRY_KV.put(cursorKey, JSON.stringify(cursor)).catch(() => {});
    return 'skip';
  }
  let txs;
  // Use sequential fetchBlockTxs (proven-working in the cron context for the
  // forward scanner). The parallel variant triggers mempool.space rate-limits
  // for dense legacy blocks. The sequential walk's 5000-tx cap is the same
  // bug that caused the silent drops in the first place — we lift it here so
  // backfill sees the full block. CF subrequest budget (1000) is the real
  // ceiling; 8000 txs ~ 320 pages, well within the 1000 cap even with our
  // other cron work.
  try { txs = await fetchBlockTxs(env, blockHash, network, { maxTxs: 8000 }); }
  catch (e) {
    cursor.last_error = `fetchBlockTxs(${blockHash}) failed: ${e.message}`;
    cursor.last_tick_at = Math.floor(Date.now() / 1000);
    await env.REGISTRY_KV.put(cursorKey, JSON.stringify(cursor)).catch(() => {});
    return 'skip';
  }
  cursor.last_block_txs_scanned = txs.length;
  // Build the set of canonical keys already at this height in one KV.list —
  // a single height has at most a few hundred PMINTs, so this is cheap and
  // saves N×KV.get probes. Scoped to FAIR's per-height prefix.
  const heightPrefix = pmintPrefix(network, aid) + String(h).padStart(10, '0') + ':';
  const existing = new Set();
  {
    let lc = null;
    for (let page = 0; page < 5; page++) {   // 5×1000 ≫ any plausible per-block PMINT count
      const lst = await env.REGISTRY_KV.list({
        prefix: heightPrefix,
        limit: 1000,
        ...(lc ? { cursor: lc } : {}),
      });
      for (const k of lst.keys) existing.add(k.name);
      if (lst.list_complete) break;
      lc = lst.cursor;
      if (!lc) break;
    }
  }
  let wrote = 0;
  let alreadyPresent = 0;
  let rejected = 0;
  let txIndex = -1;
  for (const tx of txs) {
    txIndex++;
    if (!tx.vin || !tx.vin[0] || !tx.vin[0].witness || tx.vin[0].witness.length < 3) continue;
    let envBytes;
    try { envBytes = hexToBytes(tx.vin[0].witness[1]); } catch { continue; }
    const decoded = decodeEnvelopeScript(envBytes);
    if (!decoded || decoded.opcode !== T_PMINT) continue;
    const cm = decodeCPmintPayload(decoded.payload);
    if (!cm) { rejected++; continue; }
    const derivedAid = assetIdFor(cm.etch_txid, 0);
    if (derivedAid !== cm.asset_id || derivedAid !== aid) { rejected++; continue; }
    try {
      if (BigInt(cm.amount) !== BigInt(petch.mint_limit)) { rejected++; continue; }
    } catch { rejected++; continue; }
    const startH = Number(petch.mint_start_height) || 0;
    const endH = Number(petch.mint_end_height) || 0;
    const etchedAt = Number(petch.etched_at_height) || 0;
    const effectiveStart = startH !== 0 ? startH : etchedAt + 1;
    if (h < effectiveStart || (endH !== 0 && h > endH)) { rejected++; continue; }
    if (!pmintCommitmentOpens(cm.amount, cm.blinding, cm.commitment)) { rejected++; continue; }
    const pmk = pmintKeyFor(network, derivedAid, h, txIndex, tx.txid);
    if (existing.has(pmk)) { alreadyPresent++; continue; }
    const mintMeta = {
      asset_id: derivedAid,
      etch_txid: cm.etch_txid,
      mint_txid: tx.txid,
      mint_vout: 0,
      commitment: cm.commitment,
      amount: cm.amount,
      blinding: cm.blinding,
      minted_at_height: h,
      minted_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
      kind: 'pmint',
      tx_index: txIndex,
      network,
    };
    await env.REGISTRY_KV.put(pmk, JSON.stringify(mintMeta));
    existing.add(pmk);
    wrote++;
  }
  // Cursor write is LAST so a mid-block timeout retries the same block on
  // next tick (KV puts above are idempotent via `existing` set).
  cursor.next_height = h + 1;
  cursor.last_tick_at = Math.floor(Date.now() / 1000);
  cursor.last_tick_height = h;
  cursor.last_tick_wrote = wrote;
  cursor.last_tick_already_present = alreadyPresent;
  cursor.last_tick_rejected = rejected;
  cursor.total_wrote = (cursor.total_wrote || 0) + wrote;
  cursor.total_rejected = (cursor.total_rejected || 0) + rejected;
  // Clear stale error from a previous tick now that this one succeeded.
  delete cursor.last_error;
  if (cursor.next_height > cursor.end_height) {
    cursor.completed_at = Math.floor(Date.now() / 1000);
  }
  await env.REGISTRY_KV.put(cursorKey, JSON.stringify(cursor));
  // Mark snapshot dirty so the next refresh tick picks up the new entries.
  if (wrote > 0 || cursor.completed_at) {
    await markPetchDirty(env, network, aid);
  }
  return cursor.completed_at ? 'done' : 'ok';
}

// GET /petch-assets — registry of T_PETCH-rooted assets. Same envelope shape
// as /assets plus per-asset cap progress (cumulative_minted / cap_amount /
// remaining) read from the petch_progress snapshot. The snapshot is
// maintained by the cron tick (full refresh) and by hint POSTs (async
// refresh via ctx.waitUntil), so this endpoint pays O(1) per asset instead
// of the O(N) KV.list scan the previous version did. Kept distinct from
// /assets so a Discover UI can present each issuance model in its own pane
// without the other polluting; consumers wanting a unified list union both
// endpoints.
async function handlePetchAssetsList(env, network, cors, { limit = 1000 } = {}) {
  const list = await env.REGISTRY_KV.list({ prefix: petchPrefix(network), limit });
  const tipP = fetchTipHeight(env, network);
  // Curated verified set in parallel; same semantics as /assets.
  const verifiedP = loadVerifiedSet(env, network).catch(() => new Set());
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const assets = fetched.filter(v => v);
  const verifiedSet = await verifiedP;
  for (const a of assets) a.verified = verifiedSet.has(a.asset_id);
  assets.sort((a, b) => (b.etched_at || 0) - (a.etched_at || 0));
  const tipHeight = await tipP;
  // Read per-asset snapshot. Missing snapshots fall back to an inline
  // refresh — bounded by PETCH_REFRESH_SAFETY_CAP so even a brand-new
  // FAIR-scale asset returns in <30s. The cron's next tick produces a
  // persistent snapshot so subsequent reads are O(1).
  await Promise.all(assets.map(async a => {
    const aid = a.asset_id;
    let snap = await readPetchProgress(env, network, aid);
    if (!snap) {
      // First sight of this asset — compute inline AND persist so subsequent
      // requests hit the fast path.
      snap = await refreshAndStorePetchProgress(env, network, aid, tipHeight, a).catch(() => null);
    }
    if (snap) {
      a.cumulative_minted = snap.credited_amount;
      a.credited_pmint_count = snap.credited_count;
      a.cap_overflow_count = snap.cap_overflow_count || 0;
      a.pmint_count = snap.canonical_count + (snap.orphan_count || 0);
      a.pending_pmint_count = snap.pending_count;
      a.snapshot_updated_at = snap.updated_at;
      a.snapshot_tip = snap.tip_at_update;
      a.truncated = !!snap.truncated;
      a.bootstrapped = !!snap.bootstrapped;
    } else {
      // Snapshot read AND refresh both failed (KV error). Surface honest empties
      // rather than fake zeros — the dapp's truncated check will signal
      // "data unavailable" instead of "0 minted".
      a.cumulative_minted = '0';
      a.credited_pmint_count = 0;
      a.cap_overflow_count = 0;
      a.pmint_count = 0;
      a.pending_pmint_count = 0;
      a.truncated = true;
      a.bootstrapped = false;
      a.snapshot_unavailable = true;
    }
    if (a.cap_amount && a.mint_limit) {
      const minted = BigInt(a.cumulative_minted || '0');
      const remaining = BigInt(a.cap_amount) - minted;
      a.mints_remaining = String(remaining < 0n ? 0n : remaining / BigInt(a.mint_limit));
    }
  }));
  return jsonResponse({
    count: assets.length,
    network,
    meta: {
      tip: Number.isInteger(tipHeight) ? tipHeight : null,
      tip_unavailable: !Number.isInteger(tipHeight),
      confirmation_depth: PMINT_CONFIRMATION_DEPTH,
    },
    assets,
  }, 200, cors);
}

// GET /assets/:asset_id/pmints — canonically-ordered T_PMINT history for one
// asset, annotated with `depth` and `status` (pending | credited | cap_overflow
// | unknown_depth) so wallets can grey out non-credited UTXOs and surface
// reorg-revoked entries explicitly.
async function handlePmintList(assetIdHex, env, network, cors, opts = {}) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const petch = await env.REGISTRY_KV.get(petchKey(network, assetIdHex), 'json');
  if (!petch) return jsonResponse({ error: 'unknown petch asset_id' }, 404, cors);
  // Tip is only load-bearing for the inline scan paths (depth-3 filter on
  // canonical pmint keys). The slim path returns snapshot fields directly,
  // and the snapshot already records `tip_at_update` from when it was
  // refreshed — fetching a live tip here just to repeat it in the response
  // would add up to 2.5s of mempool.space round-trip on a hot dapp call.
  // Defer the fetch unless we actually need to walk canonical keys.
  const needsLiveTip = !opts.creditedOnly || opts.includeTxids !== false;
  // Kick off tip + snapshot in parallel. For fat-path callers that need
  // both, this saves the smaller-of-the-two await (typically ~50-200ms,
  // up to ~2.5s if mempool.space is stalling). For the slim path we don't
  // start the tip fetch at all.
  const tipP = needsLiveTip ? fetchTipHeight(env, network) : Promise.resolve(null);
  const snapP = readPetchProgress(env, network, assetIdHex);
  // Slim path: the dapp's validateOutpoint hot path only needs the set of
  // credited mint txids. Every fact required for the credit decision is
  // already encoded in the canonical key (height, tx_index, txid), so we
  // can list keys without ever fetching values — saves N×500B of JSON
  // payloads + N parallel KV.get calls when N is in the thousands. Without
  // this, /pmints?credited=1 on a heavy asset (FAIR with 26k+ canonical
  // entries) tips past the Worker wall-time ceiling.
  if (opts.creditedOnly) {
    // Read the cap-progress snapshot. The snapshot has authoritative aggregate
    // fields (credited_count, last_credited_*, cap_overflow_txids) regardless
    // of canonical list size. For the per-txid membership check, we still
    // page through credited_txids up to SAFETY_CAP — wallets check their own
    // mints by membership, and consumers past SAFETY_CAP fall back to the
    // position-comparison path (compare their (h, ti, txid) against
    // last_credited_(h, ti, txid)).
    const [tip, snap] = await Promise.all([tipP, snapP]);
    const orphanPrefixStr = pmintPrefix(network, assetIdHex) + '0000000000:';
    const capAmount = petch.cap_amount != null ? BigInt(petch.cap_amount) : null;
    const mintLimit = petch.mint_limit != null ? BigInt(petch.mint_limit) : null;
    // Slim path: caller opts out of the credited_txids list entirely (the
    // 3.3MB-for-FAIR payload + 7s inline scan). Consumers that do per-mint
    // credit decisions via position-comparison against last_credited_*
    // don't need the list. Backwards-compatible: omitted param defaults to
    // include_txids=1, so existing clients see no change. The new dapp
    // passes include_txids=0 to get a ~3KB response in ~50ms.
    const includeTxids = opts.includeTxids !== false;
    const credited_txids = [];
    // For cap_overflow_txids, prefer the snapshot's list (it's authoritative).
    // Inline scan still populates as backup for assets without a snapshot.
    const cap_overflow_txids = snap?.cap_overflow_txids ? [...snap.cap_overflow_txids] : [];
    const haveOverflowFromSnapshot = !!snap?.cap_overflow_txids;
    let creditedAmount = 0n;
    let canonCursor = null;
    let collected = 0;
    let truncated = false;
    const SAFETY_CAP = 50000;
    let canonicalComplete = !includeTxids; // slim path skips the scan entirely
    if (!includeTxids) {
      // Slim path: no inline scan. Snapshot provides all needed fields.
      // cap_overflow_txids still comes from snapshot if available, else empty.
      return jsonResponse({
        asset_id: assetIdHex,
        network,
        credited_txids,                            // intentionally empty (slim)
        cap_overflow_txids,
        credited_count: snap?.credited_count ?? null,
        credited_amount: snap?.credited_amount ?? null,
        cap_overflow_count: snap?.cap_overflow_count ?? cap_overflow_txids.length,
        last_credited_height: snap?.last_credited_height ?? null,
        last_credited_tx_index: snap?.last_credited_tx_index ?? null,
        last_credited_txid: snap?.last_credited_txid ?? null,
        snapshot_updated_at: snap?.updated_at ?? null,
        snapshot_bootstrapped: !!snap?.bootstrapped,
        confirmation_depth: PMINT_CONFIRMATION_DEPTH,
        // Slim path skipped the live tip fetch; surface snapshot's tip
        // instead so consumers still see the chain height the snapshot was
        // computed against. tip_unavailable stays true here because callers
        // shouldn't use this for live-chain reasoning (it's the snapshot's
        // tip, not the current chain tip).
        tip: snap?.tip_at_update ?? null,
        tip_unavailable: true,
        slim: true,                                // signal to consumers that the list is empty by design
        truncated: true,                           // the list IS truncated (to zero); use last_credited_* for membership
        list_complete: false,
      }, 200, cors);
    }
    for (let page = 0; page < 200; page++) {
      const list = await env.REGISTRY_KV.list({
        prefix: pmintPrefix(network, assetIdHex),
        limit: 1000,
        ...(canonCursor ? { cursor: canonCursor } : {}),
      });
      for (const k of list.keys) {
        if (k.name.startsWith(orphanPrefixStr)) continue;
        // Key shape: pmint:<network>:<aid>:<padded_h>:<padded_idx>:<txid>
        const parts = k.name.split(':');
        const txid = parts[parts.length - 1];
        const h = parseInt(parts[parts.length - 3], 10);
        if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(h)) continue;
        if (Number.isInteger(tip)) {
          const depth = Math.max(0, tip - h + 1);
          if (depth < PMINT_CONFIRMATION_DEPTH) continue; // pending
        }
        if (capAmount != null && mintLimit != null) {
          const wouldBe = creditedAmount + mintLimit;
          if (wouldBe > capAmount) {
            if (!haveOverflowFromSnapshot) cap_overflow_txids.push(txid);
            continue;
          }
          creditedAmount = wouldBe;
        }
        credited_txids.push(txid);
        collected++;
        if (collected >= SAFETY_CAP) { truncated = true; break; }
      }
      if (truncated) break;
      if (list.list_complete) { canonicalComplete = true; break; }
      canonCursor = list.cursor;
      if (!canonCursor) { canonicalComplete = true; break; }
    }
    if (!canonicalComplete && !truncated) truncated = true;
    return jsonResponse({
      asset_id: assetIdHex,
      network,
      credited_txids,
      cap_overflow_txids,
      // Snapshot-derived fields. Consumers (the dapp) use these for
      // position-based credit checks when credited_txids is truncated and
      // the user's own mint sits past SAFETY_CAP — they can't rely on
      // set membership, but they can compare (h, ti, txid) against
      // last_credited_(h, ti, txid).
      credited_count: snap?.credited_count ?? null,
      credited_amount: snap?.credited_amount ?? null,
      cap_overflow_count: snap?.cap_overflow_count ?? cap_overflow_txids.length,
      last_credited_height: snap?.last_credited_height ?? null,
      last_credited_tx_index: snap?.last_credited_tx_index ?? null,
      last_credited_txid: snap?.last_credited_txid ?? null,
      snapshot_updated_at: snap?.updated_at ?? null,
      snapshot_bootstrapped: !!snap?.bootstrapped,
      confirmation_depth: PMINT_CONFIRMATION_DEPTH,
      tip: Number.isInteger(tip) ? tip : null,
      tip_unavailable: !Number.isInteger(tip),
      truncated,
      list_complete: !truncated,
    }, 200, cors);
  }
  // Full event list path. Aggregate fields (cumulative_minted, credited_count,
  // cap_overflow_count) come from the snapshot when present so this endpoint
  // agrees with /petch-assets numbers — explorers/auditors hitting both
  // shouldn't see drift driven by where the cap walk happened to stop. The
  // per-event detail array (`pmints`) still comes from loadCanonicalPmints
  // and is capped at 5000 events; consumers needing exhaustive per-event
  // access should use ?credited=1 for txid-only or paginate via cursor (future).
  // tip + snapshot were kicked off as parallel promises near the top of the
  // function; the credited-only branch above didn't consume them (it
  // returned early), so we await them here.
  const [tip, snap] = await Promise.all([tipP, snapP]);
  const r = await loadCanonicalPmints(env, network, assetIdHex, tip, petch.cap_amount, petch.mint_limit);
  return jsonResponse({
    asset_id: assetIdHex,
    network,
    cap_amount: petch.cap_amount,
    mint_limit: petch.mint_limit,
    cumulative_minted: snap?.credited_amount ?? r.cumulative_minted,
    credited_count: snap?.credited_count ?? (parseInt(r.credited_count, 10) || 0),
    pending_count: snap?.pending_count ?? r.events.filter(e => e.status === 'pending').length,
    cap_overflow_count: snap?.cap_overflow_count ?? r.events.filter(e => e.status === 'cap_overflow').length,
    last_credited_height: snap?.last_credited_height ?? null,
    last_credited_tx_index: snap?.last_credited_tx_index ?? null,
    last_credited_txid: snap?.last_credited_txid ?? null,
    snapshot_updated_at: snap?.updated_at ?? null,
    snapshot_bootstrapped: !!snap?.bootstrapped,
    confirmation_depth: PMINT_CONFIRMATION_DEPTH,
    tip: Number.isInteger(tip) ? tip : null,
    tip_unavailable: !Number.isInteger(tip),
    pmints: r.events,
    events_truncated: !!r.truncated,
    truncated: !!r.truncated,
    list_complete: !r.truncated,
  }, 200, cors);
}

// Per-mint attestation. Takes the issuer's (mint_amount, mint_blinding) opening
// and verifies it against the mint's on-chain commitment (either from the KV
// registry or, if not yet indexed, fetched from the reveal tx directly).
async function handleMintAttest(assetIdHex, mintTxidHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex))     return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(mintTxidHex))    return jsonResponse({ error: 'invalid mint_txid' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const supplyStr = String(body.supply ?? body.amount ?? '');
  const blindingHex = String(body.blinding ?? '').toLowerCase();
  if (!/^\d+$/.test(supplyStr))             return jsonResponse({ error: 'supply must be a base-10 integer string' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(blindingHex))  return jsonResponse({ error: 'blinding must be 64-hex-char (32 bytes)' }, 400, cors);
  let supply;
  try { supply = BigInt(supplyStr); } catch { return jsonResponse({ error: 'unparseable supply' }, 400, cors); }
  if (supply < 0n || supply >= (1n << BigInt(N_BITS))) {
    return jsonResponse({ error: `supply must be in [0, 2^${N_BITS})` }, 400, cors);
  }
  const blinding = BigInt('0x' + blindingHex);

  // Resolve commitment from registry, falling back to fetching the mint's
  // reveal tx envelope directly so attestations work pre-index.
  let commitmentHex = null;
  const indexed = await env.REGISTRY_KV.get(mintKeyFor(network, assetIdHex, mintTxidHex), 'json');
  if (indexed?.commitment) {
    commitmentHex = indexed.commitment;
  } else {
    try {
      const tx = await apiJson(env, `/tx/${mintTxidHex}`, {}, network);
      if (!tx?.vin?.[0]?.witness || tx.vin[0].witness.length < 3) {
        return jsonResponse({ error: 'mint tx has no taproot script-path witness' }, 400, cors);
      }
      const decoded = decodeEnvelopeScript(hexToBytes(tx.vin[0].witness[1]));
      if (!decoded || decoded.opcode !== T_MINT) {
        return jsonResponse({ error: 'tx is not a T_MINT envelope' }, 400, cors);
      }
      const cm = decodeCMintPayload(decoded.payload);
      if (!cm || cm.asset_id !== assetIdHex) {
        return jsonResponse({ error: 'mint envelope does not match asset_id' }, 400, cors);
      }
      commitmentHex = cm.commitment;
    } catch (e) {
      return jsonResponse({ error: 'failed to resolve mint tx: ' + e.message }, 400, cors);
    }
  }

  let claimed, onchain;
  try {
    claimed = pedersenCommit(supply, blinding);
    onchain = compressedPointFromHex(commitmentHex);
  } catch (e) {
    return jsonResponse({ error: 'commitment math failed: ' + e.message }, 400, cors);
  }
  if (!claimed.equals(onchain)) {
    return jsonResponse({ error: 'opening does not match on-chain mint commitment' }, 400, cors);
  }

  const attestation = {
    supply: supplyStr,
    blinding: blindingHex,
    attested_at: Math.floor(Date.now() / 1000),
  };
  await env.REGISTRY_KV.put(attestMintKey(network, assetIdHex, mintTxidHex), JSON.stringify(attestation));
  return jsonResponse({ ok: true, attestation }, 200, cors);
}

// ============== Per-UTXO opening (publish) ==============
// Marketplaces / explorers can fetch (amount, blinding) openings for any UTXO
// the holder has chosen to publish. Pedersen binding alone makes the opening
// unforgeable, but we also require a BIP-340 Schnorr sig from the UTXO's owner
// pubkey so a counterparty who happens to know an opening cannot dox the holder
// by publishing on their behalf.

const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const bytes32ToBigint = b => BigInt('0x' + bytesToHex(b));
function _taggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}
// Direct port of the dApp's verifySchnorr (BIP-340). Avoids relying on noble's
// schnorr API surface across versions.
function verifySchnorr(sig64, msgHash, pubXonly32) {
  if (sig64.length !== 64 || pubXonly32.length !== 32 || msgHash.length !== 32) return false;
  const Rx = sig64.slice(0, 32);
  const sBig = bytes32ToBigint(sig64.slice(32, 64));
  if (sBig >= SECP_N) return false;
  if (bytes32ToBigint(pubXonly32) >= SECP_P) return false;
  let P;
  try { P = secp.ProjectivePoint.fromHex('02' + bytesToHex(pubXonly32)); } catch { return false; }
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, pubXonly32, msgHash)) % SECP_N;
  const R = secp.ProjectivePoint.BASE.multiply(sBig).add(P.multiply(e).negate());
  // BIP-340 mandates rejecting infinite R. noble encodes the identity as
  // 02 || 00…00; without an explicit guard, a sig with Rx = 32 zero bytes
  // would verify against the identity point.
  if (R.equals(secp.ProjectivePoint.ZERO)) return false;
  const Rb = R.toRawBytes(true);
  if (Rb[0] !== 0x02) return false;
  return bytesToHex(Rb.slice(1)) === bytesToHex(Rx);
}

// Resolve the on-chain commitment + declared asset_id for an arbitrary tacit
// UTXO by walking its parent tx's envelope. Mirrors the dApp's
// getParentEnvelopeData but lives server-side so the worker can validate
// openings without trusting the submitter.
async function commitmentForUtxo(env, txidHex, vout, network) {
  const tx = await apiJson(env, `/tx/${txidHex}`, {}, network);
  if (!tx?.vin?.[0]?.witness || tx.vin[0].witness.length < 3) {
    throw new Error('parent tx has no taproot script-path witness');
  }
  const decoded = decodeEnvelopeScript(hexToBytes(tx.vin[0].witness[1]));
  if (!decoded) throw new Error('parent tx is not a tacit envelope');
  if (decoded.opcode === T_CETCH) {
    if (vout !== 0) throw new Error('CETCH supply lives at vout 0 only');
    const ce = decodeCEtchPayload(decoded.payload);
    if (!ce) throw new Error('invalid CETCH payload');
    return { commitment: ce.commitment, asset_id: assetIdFor(txidHex, 0) };
  }
  if (decoded.opcode === T_MINT) {
    if (vout !== 0) throw new Error('T_MINT supply lives at vout 0 only');
    const cm = decodeCMintPayload(decoded.payload);
    if (!cm) throw new Error('invalid T_MINT payload');
    return { commitment: cm.commitment, asset_id: cm.asset_id };
  }
  if (decoded.opcode === T_CXFER) {
    const cx = decodeCXferPayload(decoded.payload);
    if (!cx) throw new Error('invalid CXFER payload');
    if (vout >= cx.outputs.length) throw new Error(`CXFER vout ${vout} out of range`);
    return { commitment: cx.outputs[vout].commitment, asset_id: cx.asset_id };
  }
  if (decoded.opcode === T_AXFER) {
    const cx = decodeAxferPayload(decoded.payload);
    if (!cx) throw new Error('invalid T_AXFER payload');
    if (vout >= cx.outputs.length) throw new Error(`T_AXFER vout ${vout} out of range`);
    return { commitment: cx.outputs[vout].commitment, asset_id: cx.asset_id };
  }
  if (decoded.opcode === T_BURN) {
    const cb = decodeCBurnPayload(decoded.payload);
    if (!cb) throw new Error('invalid T_BURN payload');
    if (vout >= cb.outputs.length) throw new Error(`T_BURN vout ${vout} out of range`);
    return { commitment: cb.outputs[vout].commitment, asset_id: cb.asset_id };
  }
  if (decoded.opcode === T_PMINT) {
    if (vout !== 0) throw new Error('T_PMINT supply lives at vout 0 only');
    const pm = decodeCPmintPayload(decoded.payload);
    if (!pm) throw new Error('invalid T_PMINT payload');
    return { commitment: pm.commitment, asset_id: pm.asset_id };
  }
  if (decoded.opcode === T_WITHDRAW) {
    if (vout !== 0) throw new Error('T_WITHDRAW output lives at vout 0 only');
    const tw = decodeTWithdrawPayload(decoded.payload);
    if (!tw) throw new Error('invalid T_WITHDRAW payload');
    return { commitment: tw.recipient_commitment, asset_id: tw.asset_id };
  }
  throw new Error('unsupported envelope opcode');
}

// SPEC §5.10 — T_DEPOSIT kernel sig: BIP-340 over kernel_msg under
// (C_in − denomination·H).x_only(). Closes the Conservation invariant
// (SPEC §5.11.4 invariant 1): proves exactly `denomination` of `asset_id`
// was consumed into the pool. Without this check anyone can append leaves
// to a pool tree that aren't backed by real asset value, then withdraw
// against their own leaf — free inflation.
//
// Returns true iff the deposit genuinely consumed an asset UTXO of the
// right (asset_id, denomination). Any failure (parent fetch failure,
// asset_id mismatch, sig verify failure) returns false.
//
// `tx` is the already-fetched deposit transaction object (cron has it in
// scope), so this only spends one mempool.space subrequest per deposit
// (the parent walk via commitmentForUtxo).
const _DEPOSIT_DOMAIN = new TextEncoder().encode('tacit-deposit-v1');
async function verifyMixerDepositKernel(env, tx, expectedAssetIdHex, expectedDenomStr, leafCommitmentHex, kernelSigHex, network) {
  if (!tx || !Array.isArray(tx.vin) || tx.vin.length < 2) return false;
  const inp = tx.vin[1];
  if (!inp || typeof inp.txid !== 'string' || typeof inp.vout !== 'number') return false;
  let parent;
  try { parent = await commitmentForUtxo(env, inp.txid, inp.vout, network); }
  catch { return false; }
  if (!parent || parent.asset_id !== expectedAssetIdHex) return false;
  let CinPoint;
  try { CinPoint = compressedPointFromHex(parent.commitment); }
  catch { return false; }
  const denomBig = BigInt(expectedDenomStr);
  const denomH = denomBig === 0n ? PEDERSEN_ZERO : PEDERSEN_H.multiply(modN(denomBig));
  const EPrime = CinPoint.add(denomH.negate());
  if (EPrime.equals(PEDERSEN_ZERO)) return false;
  const ExBytes = EPrime.toRawBytes(true).slice(1);
  const denomLE = new Uint8Array(8);
  {
    const v = new DataView(denomLE.buffer);
    v.setUint32(0, Number(denomBig & 0xffffffffn), true);
    v.setUint32(4, Number((denomBig >> 32n) & 0xffffffffn), true);
  }
  const inputTxidBE = reverseBytes(hexToBytes(inp.txid));
  const inputVoutLE = new Uint8Array(4);
  new DataView(inputVoutLE.buffer).setUint32(0, inp.vout >>> 0, true);
  const kernelMsg = sha256(concatBytes(
    _DEPOSIT_DOMAIN,
    hexToBytes(expectedAssetIdHex),
    denomLE,
    inputTxidBE,
    inputVoutLE,
    hexToBytes(leafCommitmentHex),
  ));
  return verifySchnorr(hexToBytes(kernelSigHex), kernelMsg, ExBytes);
}

// Canonical message the holder signs over to authorize publication. Must match
// the dApp's signOpening helper byte-for-byte.
function openingMsg(assetIdHex, txidHex, vout, amount, blindingHex, ownerPubHex) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  const amountLE = new Uint8Array(8);
  const view = new DataView(amountLE.buffer);
  const a = BigInt(amount);
  view.setBigUint64(0, a, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-opening-v1'),
    hexToBytes(assetIdHex),
    txidBE,
    voutLE,
    amountLE,
    hexToBytes(blindingHex),
    hexToBytes(ownerPubHex),
  ));
}

async function handleUtxoOpeningPost(txidHex, voutStr, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(txidHex)) return jsonResponse({ error: 'invalid txid' }, 400, cors);
  const vout = parseInt(voutStr, 10);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) {
    return jsonResponse({ error: 'invalid vout' }, 400, cors);
  }
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const amountStr = String(body.amount ?? '');
  const blindingHex = String(body.blinding ?? '').toLowerCase();
  const ownerPubHex = String(body.owner_pubkey ?? '').toLowerCase();
  const sigHex = String(body.sig ?? '').toLowerCase();
  if (!/^\d+$/.test(amountStr))            return jsonResponse({ error: 'amount must be base-10 integer string' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(blindingHex)) return jsonResponse({ error: 'blinding must be 64 hex chars' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex)) return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed hex (02/03 prefix)' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))     return jsonResponse({ error: 'sig must be 128 hex chars (64-byte BIP-340)' }, 400, cors);

  let amount;
  try { amount = BigInt(amountStr); } catch { return jsonResponse({ error: 'unparseable amount' }, 400, cors); }
  if (amount < 0n || amount >= (1n << BigInt(N_BITS))) {
    return jsonResponse({ error: `amount must be in [0, 2^${N_BITS})` }, 400, cors);
  }
  const blinding = BigInt('0x' + blindingHex);

  // Resolve the on-chain commitment + the parent envelope's declared asset_id.
  let resolved;
  try { resolved = await commitmentForUtxo(env, txidHex, vout, network); }
  catch (e) { return jsonResponse({ error: 'commitment lookup failed: ' + e.message }, 400, cors); }
  const assetIdHex = resolved.asset_id;

  // Pedersen binding: opening must commit to on-chain C.
  let claimed, onchain;
  try {
    claimed = pedersenCommit(amount, blinding);
    onchain = compressedPointFromHex(resolved.commitment);
  } catch (e) {
    return jsonResponse({ error: 'commitment math failed: ' + e.message }, 400, cors);
  }
  if (!claimed.equals(onchain)) {
    return jsonResponse({ error: 'opening does not match on-chain commitment' }, 400, cors);
  }

  // Ownership: hash160(owner_pubkey) must match the P2WPKH script-pubkey hash
  // at the UTXO's vout. Anyone publishing on the holder's behalf would have to
  // forge a Schnorr sig under their pubkey or grind a hash collision.
  const tx = await apiJson(env, `/tx/${txidHex}`, {}, network);
  const out = tx?.vout?.[vout];
  if (!out?.scriptpubkey) return jsonResponse({ error: 'vout has no scriptpubkey' }, 400, cors);
  const spk = hexToBytes(out.scriptpubkey);
  if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
    return jsonResponse({ error: 'vout is not P2WPKH (tacit outputs are P2WPKH)' }, 400, cors);
  }
  const expectHash = bytesToHex(spk.slice(2, 22));
  const gotHash = bytesToHex(hash160(hexToBytes(ownerPubHex)));
  if (expectHash !== gotHash) {
    return jsonResponse({ error: 'owner_pubkey does not control this UTXO' }, 403, cors);
  }

  // Authorization: BIP-340 sig under x-only(owner_pubkey) over the canonical msg.
  const msg = openingMsg(assetIdHex, txidHex, vout, amountStr, blindingHex, ownerPubHex);
  const xonly = hexToBytes(ownerPubHex).slice(1);
  if (!verifySchnorr(hexToBytes(sigHex), msg, xonly)) {
    return jsonResponse({ error: 'invalid owner signature' }, 403, cors);
  }

  const opening = {
    asset_id: assetIdHex,
    txid: txidHex,
    vout,
    amount: amountStr,
    blinding: blindingHex,
    owner_pubkey: ownerPubHex,
    sig: sigHex,
    attested_at: Math.floor(Date.now() / 1000),
    network,
  };
  await env.REGISTRY_KV.put(openingKey(network, assetIdHex, txidHex, vout), JSON.stringify(opening));
  return jsonResponse({ ok: true, opening }, 200, cors);
}

// POST /utxos/:txid/:vout/buyer-opening — publish a self-encrypted
// opening blob the buyer can later decrypt to recover (amount,
// blinding). No auth: the ciphertext is bound to a declared pubkey;
// only a wallet holding the matching priv produces a valid AES-GCM
// open. Worst-case attacker overwrites with garbage → legitimate
// buyer fails decrypt → falls through to other recovery paths
// (same as today). 90-day TTL auto-collects stale entries.
async function handleBuyerOpeningPost(txidHex, voutStr, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(txidHex)) return jsonResponse({ error: 'invalid txid' }, 400, cors);
  const vout = parseInt(voutStr, 10);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) {
    return jsonResponse({ error: 'invalid vout' }, 400, cors);
  }
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const declaredPub = String(body.declared_pubkey || '').toLowerCase();
  const ciphertext = String(body.ciphertext || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(declaredPub)) {
    return jsonResponse({ error: 'declared_pubkey must be 33-byte compressed hex' }, 400, cors);
  }
  // Bound ciphertext size to defend against KV-quota grinding. 12 (IV)
  // + 64 (plaintext: amount+blinding) + 16 (GCM tag) = 92 bytes raw =
  // 184 hex; cap at 512 hex for forward headroom on future schema.
  if (!/^[0-9a-f]+$/.test(ciphertext) || ciphertext.length === 0 || ciphertext.length > 512) {
    return jsonResponse({ error: 'ciphertext must be 1..256 bytes of hex' }, 400, cors);
  }
  const record = {
    declared_pubkey: declaredPub,
    ciphertext,
    stored_at: Math.floor(Date.now() / 1000),
  };
  await env.REGISTRY_KV.put(
    buyerOpeningKey(network, txidHex, vout),
    JSON.stringify(record),
    { expirationTtl: 90 * 24 * 3600 },
  );
  return jsonResponse({ ok: true, stored_at: record.stored_at }, 200, cors);
}

async function handleBuyerOpeningGet(txidHex, voutStr, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(txidHex)) return jsonResponse({ error: 'invalid txid' }, 400, cors);
  const vout = parseInt(voutStr, 10);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) {
    return jsonResponse({ error: 'invalid vout' }, 400, cors);
  }
  const v = await env.REGISTRY_KV.get(buyerOpeningKey(network, txidHex, vout), 'json');
  if (!v) return jsonResponse({ error: 'no buyer-opening published for this UTXO' }, 404, cors);
  return jsonResponse(v, 200, cors);
}

async function handleUtxoOpeningGet(txidHex, voutStr, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(txidHex)) return jsonResponse({ error: 'invalid txid' }, 400, cors);
  const vout = parseInt(voutStr, 10);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) {
    return jsonResponse({ error: 'invalid vout' }, 400, cors);
  }
  // The opening key is namespaced by asset_id, but callers don't necessarily
  // know the asset_id up front. Resolve it from chain so a single fetch by
  // (txid, vout) works.
  let assetIdHex;
  try { assetIdHex = (await commitmentForUtxo(env, txidHex, vout, network)).asset_id; }
  catch (e) { return jsonResponse({ error: 'commitment lookup failed: ' + e.message }, 404, cors); }
  const v = await env.REGISTRY_KV.get(openingKey(network, assetIdHex, txidHex, vout), 'json');
  if (!v) return jsonResponse({ error: 'no opening published for this UTXO' }, 404, cors);
  return jsonResponse(v, 200, cors);
}

async function loadOpeningsForAsset(env, network, assetIdHex) {
  const list = await env.REGISTRY_KV.list({ prefix: openingPrefix(network, assetIdHex), limit: 1000 });
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const openings = fetched.filter(v => v);
  openings.sort((a, b) => (b.attested_at || 0) - (a.attested_at || 0));
  return openings;
}

async function handleAssetOpenings(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const openings = await loadOpeningsForAsset(env, network, assetIdHex);
  return jsonResponse({ asset_id: assetIdHex, count: openings.length, openings }, 200, cors);
}

// ============== Range disclosure ("balance >= K" without revealing balance) ==============
// A holder publishes a bulletproof showing that the homomorphic sum of their
// owned UTXOs for an asset is at least `threshold` base units, without revealing
// the exact total. The worker stores the proof + provenance; clients verify the
// bulletproof at consume time. Off-chain by design (no new opcode needed).
//
// Soundness sketch:
//   C_sum = Σ C_i = a_sum·H + r_sum·G  (homomorphic over the listed UTXOs)
//   Prover commits to v = a_sum − K with the same blinding r_sum:
//     C' = C_sum − K·H = v·H + r_sum·G
//   Bulletproof on C' bounds v ∈ [0, 2⁶⁴), so a_sum ≥ K (in the integers, since
//   each UTXO's on-chain rangeproof already pins a_i < 2⁶⁴ and the prover knows
//   the unique opening of C_sum by Pedersen binding).

// Bulletproof byte sizes for m ∈ {1, 2, 4, 8} at n=64. Disclosures aggregate
// to a single virtual commitment (m=1) so the proof is exactly 688 bytes; we
// allow a small slack in case future versions add an aggregated form.
const BP_LEN_MIN = 688; // m=1, n=64 bulletproof byte size
const BP_LEN_MAX = 900;

function disclosureMsg(assetIdHex, utxos, thresholdBig, rangeproofHex, ownerPubHex) {
  const N = utxos.length;
  if (N > 0xffff) throw new Error('too many utxos');
  const refsBytes = new Uint8Array(N * (32 + 4));
  for (let i = 0; i < N; i++) {
    refsBytes.set(reverseBytes(hexToBytes(utxos[i].txid)), i * 36);
    new DataView(refsBytes.buffer, refsBytes.byteOffset + i * 36 + 32, 4)
      .setUint32(0, utxos[i].vout >>> 0, true);
  }
  const nLE = new Uint8Array(2);
  new DataView(nLE.buffer).setUint16(0, N, true);
  const thresholdLE = new Uint8Array(8);
  new DataView(thresholdLE.buffer).setBigUint64(0, BigInt(thresholdBig), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-disclosure-v1'),
    hexToBytes(assetIdHex),
    nLE,
    refsBytes,
    thresholdLE,
    hexToBytes(rangeproofHex),
    hexToBytes(ownerPubHex),
  ));
}

async function handleDisclosurePost(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const thresholdStr = String(body.threshold ?? '');
  const rangeproofHex = String(body.rangeproof ?? '').toLowerCase();
  const ownerPubHex = String(body.owner_pubkey ?? '').toLowerCase();
  const sigHex = String(body.sig ?? '').toLowerCase();
  const utxosRaw = Array.isArray(body.utxos) ? body.utxos : null;
  if (!/^\d+$/.test(thresholdStr))                return jsonResponse({ error: 'threshold must be base-10 integer string' }, 400, cors);
  if (!/^[0-9a-f]+$/.test(rangeproofHex))         return jsonResponse({ error: 'rangeproof must be hex' }, 400, cors);
  if (rangeproofHex.length / 2 < BP_LEN_MIN || rangeproofHex.length / 2 > BP_LEN_MAX) {
    return jsonResponse({ error: `rangeproof length out of range (${BP_LEN_MIN}–${BP_LEN_MAX} bytes)` }, 400, cors);
  }
  if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex))   return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))            return jsonResponse({ error: 'sig must be 128 hex chars (64-byte BIP-340)' }, 400, cors);
  if (!utxosRaw || !utxosRaw.length || utxosRaw.length > 64) {
    return jsonResponse({ error: 'utxos must be a non-empty array (max 64 entries)' }, 400, cors);
  }
  const utxos = [];
  for (const u of utxosRaw) {
    const txid = String(u?.txid ?? '').toLowerCase();
    const vout = u?.vout;
    if (!/^[0-9a-f]{64}$/.test(txid))                       return jsonResponse({ error: 'utxo.txid must be 64 hex chars' }, 400, cors);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) return jsonResponse({ error: 'utxo.vout must be integer 0..65535' }, 400, cors);
    utxos.push({ txid, vout });
  }

  let threshold;
  try { threshold = BigInt(thresholdStr); } catch { return jsonResponse({ error: 'unparseable threshold' }, 400, cors); }
  if (threshold <= 0n || threshold >= (1n << BigInt(N_BITS))) {
    return jsonResponse({ error: `threshold must be in (0, 2^${N_BITS})` }, 400, cors);
  }

  // Validate ownership + asset_id consistency for every referenced UTXO.
  const ownerHash160 = bytesToHex(hash160(hexToBytes(ownerPubHex)));
  for (const u of utxos) {
    let resolved;
    try { resolved = await commitmentForUtxo(env, u.txid, u.vout, network); }
    catch (e) { return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: ${e.message}` }, 400, cors); }
    if (resolved.asset_id !== assetIdHex) {
      return jsonResponse({ error: `utxo ${u.txid}:${u.vout} is for a different asset` }, 400, cors);
    }
    const tx = await apiJson(env, `/tx/${u.txid}`, {}, network);
    const out = tx?.vout?.[u.vout];
    if (!out?.scriptpubkey) return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: vout missing scriptpubkey` }, 400, cors);
    const spk = hexToBytes(out.scriptpubkey);
    if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
      return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: not P2WPKH` }, 400, cors);
    }
    if (bytesToHex(spk.slice(2, 22)) !== ownerHash160) {
      return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: owner_pubkey does not control this UTXO` }, 403, cors);
    }
  }

  // Authorization sig over canonical msg.
  let msg;
  try { msg = disclosureMsg(assetIdHex, utxos, threshold, rangeproofHex, ownerPubHex); }
  catch (e) { return jsonResponse({ error: 'msg construction failed: ' + e.message }, 400, cors); }
  const xonly = hexToBytes(ownerPubHex).slice(1);
  if (!verifySchnorr(hexToBytes(sigHex), msg, xonly)) {
    return jsonResponse({ error: 'invalid owner signature' }, 403, cors);
  }

  // We deliberately do NOT verify the bulletproof here — it's ~600 LOC of
  // verifier code we don't want to run in a Worker on every submission.
  // Consumers (marketplaces, gating UIs) re-verify client-side using the
  // dApp's bpRangeAggVerify. The worker is a pin/index, not a trust root.
  const thresholdHex = threshold.toString(16);
  const disclosure = {
    asset_id: assetIdHex,
    utxos,
    threshold: thresholdStr,
    rangeproof: rangeproofHex,
    owner_pubkey: ownerPubHex,
    sig: sigHex,
    attested_at: Math.floor(Date.now() / 1000),
    network,
  };
  await env.REGISTRY_KV.put(disclosureKey(network, assetIdHex, ownerPubHex, thresholdHex), JSON.stringify(disclosure));
  return jsonResponse({ ok: true, disclosure }, 200, cors);
}

async function handleDisclosureList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const list = await env.REGISTRY_KV.list({ prefix: disclosurePrefix(network, assetIdHex), limit: 1000 });
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const disclosures = fetched.filter(v => v);
  disclosures.sort((a, b) => (b.attested_at || 0) - (a.attested_at || 0));
  return jsonResponse({ asset_id: assetIdHex, count: disclosures.length, disclosures }, 200, cors);
}

// ============== Listings (orderbook layer) ==============
// A listing is a signed offer to sell a specific tacit UTXO for a fixed BTC
// payment. Settlement is OFF-CHAIN (OTC two-tx) in v1: taker pays maker via a
// regular Bitcoin tx, then maker broadcasts a CXFER to the taker. Atomic
// single-tx settlement requires the v1.5 validator relaxation (allow non-tacit
// aux inputs). The listing primitive is the same either way.
//
// Storage is one listing per UTXO. Re-publishing overwrites. Cancellation is
// either explicit (DELETE with cancel_sig) or implicit (UTXO gets spent — the
// listing becomes unsettleable; clients should check liveness before taking).

// Strict bech32 / bech32m decoding. P2WPKH uses bech32, P2TR uses bech32m;
// accept either so cold-storage P2TR addresses work as maker_address. Bech32
// requires uniform case (all-lower or all-upper); reject mixed.
function decodeBitcoinAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 8 || addr.length > 90) return null;
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) return null;
  // Validate the address is actually spendable: witness version must be 0 or
  // 1, and the (codec, version, program length) tuple must be one of the
  // BIP-141 / BIP-350 canonical combinations. Without these checks a maker
  // could publish a listing whose `maker_address` decodes but is unspendable
  // (e.g. v17 with 2-byte program), causing takers to burn fees crafting an
  // unrelayable tx.
  const codecs = [{ codec: bech32, version: 0 }, { codec: bech32m, version: 1 }];
  for (const { codec, version } of codecs) {
    try {
      const d = codec.decode(lower);
      if (!d.words || d.words.length === 0) continue;
      const ver = d.words[0];
      if (ver !== version) continue;
      let program;
      try { program = codec.fromWords(d.words.slice(1)); } catch { continue; }
      // v0: P2WPKH (20 bytes) or P2WSH (32 bytes). v1: P2TR (32 bytes).
      if (version === 0 && program.length !== 20 && program.length !== 32) continue;
      if (version === 1 && program.length !== 32) continue;
      return { hrp: d.prefix, version, program };
    } catch {}
  }
  return null;
}
const ADDR_MAX_LEN = 90;
const PRICE_MIN = 546;   // dust
const EXPIRY_MAX_DAYS = 365;

function listingMsg(assetIdHex, txidHex, vout, priceSats, expiry, makerAddress, openingSigHex) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const addrBytes = new TextEncoder().encode(makerAddress);
  const addrLen = new Uint8Array(2);
  new DataView(addrLen.buffer).setUint16(0, addrBytes.length, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-v1'),
    hexToBytes(assetIdHex),
    txidBE,
    voutLE,
    priceLE,
    expiryLE,
    addrLen,
    addrBytes,
    hexToBytes(openingSigHex),
  ));
}

function cancelMsg(assetIdHex, txidHex, vout) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-cancel-v1'),
    hexToBytes(assetIdHex),
    txidBE,
    voutLE,
  ));
}

async function handleListingPost(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const txidHex = String(body.txid ?? '').toLowerCase();
  const vout = body.vout;
  const amountStr = String(body.amount ?? '');
  const blindingHex = String(body.blinding ?? '').toLowerCase();
  const ownerPubHex = String(body.owner_pubkey ?? '').toLowerCase();
  const openingSigHex = String(body.opening_sig ?? '').toLowerCase();
  const priceSatsRaw = body.price_sats;
  const expiryRaw = body.expiry;
  const makerAddress = String(body.maker_address ?? '');
  const listingSigHex = String(body.listing_sig ?? '').toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(txidHex))                return jsonResponse({ error: 'invalid txid' }, 400, cors);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) return jsonResponse({ error: 'invalid vout' }, 400, cors);
  if (!/^\d+$/.test(amountStr))                       return jsonResponse({ error: 'amount must be base-10 integer string' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(blindingHex))            return jsonResponse({ error: 'blinding must be 64 hex chars' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex))       return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(openingSigHex))         return jsonResponse({ error: 'opening_sig must be 128 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(listingSigHex))         return jsonResponse({ error: 'listing_sig must be 128 hex chars' }, 400, cors);
  if (!Number.isInteger(priceSatsRaw) || priceSatsRaw < PRICE_MIN || priceSatsRaw > Number.MAX_SAFE_INTEGER) {
    return jsonResponse({ error: `price_sats must be integer >= ${PRICE_MIN}` }, 400, cors);
  }
  if (!Number.isInteger(expiryRaw))                   return jsonResponse({ error: 'expiry must be integer unix-seconds' }, 400, cors);
  const now = Math.floor(Date.now() / 1000);
  if (expiryRaw <= now)                               return jsonResponse({ error: 'expiry must be in the future' }, 400, cors);
  if (expiryRaw > now + EXPIRY_MAX_DAYS * 86400)      return jsonResponse({ error: `expiry must be within ${EXPIRY_MAX_DAYS} days` }, 400, cors);
  if (!makerAddress || makerAddress.length > ADDR_MAX_LEN) {
    return jsonResponse({ error: `maker_address required, ≤ ${ADDR_MAX_LEN} chars` }, 400, cors);
  }
  const decoded = decodeBitcoinAddress(makerAddress);
  if (!decoded) {
    return jsonResponse({ error: 'maker_address is not a valid bech32/bech32m address' }, 400, cors);
  }
  const expectedHrp = HRP_BY_NETWORK[network];
  if (decoded.hrp !== expectedHrp) {
    return jsonResponse({ error: `maker_address must use ${expectedHrp}… HRP for ${network}` }, 400, cors);
  }

  let amount;
  try { amount = BigInt(amountStr); } catch { return jsonResponse({ error: 'unparseable amount' }, 400, cors); }
  if (amount < 0n || amount >= (1n << BigInt(N_BITS))) {
    return jsonResponse({ error: `amount must be in [0, 2^${N_BITS})` }, 400, cors);
  }

  // Resolve commitment + asset_id from chain. Same path as handleUtxoOpeningPost.
  let resolved;
  try { resolved = await commitmentForUtxo(env, txidHex, vout, network); }
  catch (e) { return jsonResponse({ error: 'commitment lookup failed: ' + e.message }, 400, cors); }
  if (resolved.asset_id !== assetIdHex) {
    return jsonResponse({ error: 'utxo asset_id mismatch' }, 400, cors);
  }

  // Pedersen binding: opening must commit to on-chain C.
  let claimed, onchain;
  try {
    claimed = pedersenCommit(amount, BigInt('0x' + blindingHex));
    onchain = compressedPointFromHex(resolved.commitment);
  } catch (e) {
    return jsonResponse({ error: 'commitment math failed: ' + e.message }, 400, cors);
  }
  if (!claimed.equals(onchain)) {
    return jsonResponse({ error: 'opening does not match on-chain commitment' }, 400, cors);
  }

  // Ownership: hash160(owner_pubkey) matches vout's P2WPKH script hash.
  const tx = await apiJson(env, `/tx/${txidHex}`, {}, network);
  const out = tx?.vout?.[vout];
  if (!out?.scriptpubkey) return jsonResponse({ error: 'vout has no scriptpubkey' }, 400, cors);
  const spk = hexToBytes(out.scriptpubkey);
  if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
    return jsonResponse({ error: 'vout is not P2WPKH' }, 400, cors);
  }
  if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(hexToBytes(ownerPubHex)))) {
    return jsonResponse({ error: 'owner_pubkey does not control this UTXO' }, 403, cors);
  }

  // Both sigs verify under x-only(owner_pubkey).
  const xonly = hexToBytes(ownerPubHex).slice(1);
  const oMsg = openingMsg(assetIdHex, txidHex, vout, amountStr, blindingHex, ownerPubHex);
  if (!verifySchnorr(hexToBytes(openingSigHex), oMsg, xonly)) {
    return jsonResponse({ error: 'invalid opening signature' }, 403, cors);
  }
  const lMsg = listingMsg(assetIdHex, txidHex, vout, priceSatsRaw, expiryRaw, makerAddress, openingSigHex);
  if (!verifySchnorr(hexToBytes(listingSigHex), lMsg, xonly)) {
    return jsonResponse({ error: 'invalid listing signature' }, 403, cors);
  }

  // Store opening (idempotent — overwrites with same content) + listing.
  const opening = {
    asset_id: assetIdHex,
    txid: txidHex, vout,
    amount: amountStr,
    blinding: blindingHex,
    owner_pubkey: ownerPubHex,
    sig: openingSigHex,
    attested_at: now,
    network,
  };
  await env.REGISTRY_KV.put(openingKey(network, assetIdHex, txidHex, vout), JSON.stringify(opening));

  const listing = {
    asset_id: assetIdHex,
    txid: txidHex, vout,
    amount: amountStr,
    price_sats: priceSatsRaw,
    maker_address: makerAddress,
    expiry: expiryRaw,
    owner_pubkey: ownerPubHex,
    listing_sig: listingSigHex,
    listed_at: now,
    network,
  };
  await env.REGISTRY_KV.put(listingKey(network, assetIdHex, txidHex, vout), JSON.stringify(listing));
  return jsonResponse({ ok: true, listing }, 200, cors);
}

// Shared loader: list+hydrate opening listings for one asset, with the same
// expired/claim normalisation and recency sort the public endpoint returns.
// Extracted so the /market aggregate can fan out across many assets without
// going through the per-asset HTTP layer.
async function loadListingsForAsset(env, network, assetIdHex) {
  const list = await env.REGISTRY_KV.list({ prefix: listingPrefix(network, assetIdHex), limit: 1000 });
  const now = Math.floor(Date.now() / 1000);
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const listings = fetched.filter(v => v);
  for (const v of listings) {
    v.expired = (v.expiry || 0) <= now;
    // Drop stale claims at read time so clients don't see them as active.
    // The KV record itself is left alone; the next claim POST will overwrite.
    if (v.claim && v.claim.expires_at <= now) v.claim = null;
  }
  listings.sort((a, b) => (b.listed_at || 0) - (a.listed_at || 0));
  return listings;
}

async function handleListingList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const listings = await loadListingsForAsset(env, network, assetIdHex);
  return jsonResponse({ asset_id: assetIdHex, count: listings.length, listings }, 200, cors);
}

// Claim lock prevents the multi-taker race in OTC settlement: two takers each
// paying the maker for the same listing. The maker can only deliver once.
// This is a soft, time-bounded reservation — no on-chain commitment, just a
// coordination signal. 5 min is enough for a maker to fulfil + taker to
// broadcast in one sitting; longer TTLs let trolls free-claim and lock up
// active intents (claims today require only a Schnorr sig, no funds proof).
// A real fix is requiring the taker to commit to a sat UTXO ≥ price_sats;
// until that lands, this short TTL caps the grief radius.
const CLAIM_TTL_SECONDS = 5 * 60;
// Atomic-intent fulfilment TTL. After 24h the maker can re-fulfil for a new
// claimant — this protects the maker from a taker who claims, gets a signed
// partial reveal, and then ghosts. The taker's BTC payment is still locked
// behind their own SIGHASH_ALL signature so this doesn't risk anyone's funds;
// it just frees the marketplace slot.
const FULFILMENT_TTL_SECONDS = 24 * 3600;

function claimMsg(assetIdHex, txidHex, vout, takerPubHex) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-claim-v1'),
    hexToBytes(assetIdHex),
    txidBE,
    voutLE,
    hexToBytes(takerPubHex),
  ));
}

async function handleListingClaim(assetIdHex, txidHex, voutStr, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(txidHex))    return jsonResponse({ error: 'invalid txid' }, 400, cors);
  const vout = parseInt(voutStr, 10);
  if (!Number.isInteger(vout) || vout < 0) return jsonResponse({ error: 'invalid vout' }, 400, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const takerPubHex = String(body.taker_pubkey ?? '').toLowerCase();
  const sigHex = String(body.sig ?? '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(takerPubHex)) return jsonResponse({ error: 'taker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))          return jsonResponse({ error: 'sig must be 128 hex chars' }, 400, cors);

  const msg = claimMsg(assetIdHex, txidHex, vout, takerPubHex);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(takerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid taker signature' }, 403, cors);
  }

  const key = listingKey(network, assetIdHex, txidHex, vout);
  const stored = await env.REGISTRY_KV.get(key, 'json');
  if (!stored)                 return jsonResponse({ error: 'no such listing' }, 404, cors);
  if (stored.expiry <= Math.floor(Date.now() / 1000)) {
    return jsonResponse({ error: 'listing expired' }, 410, cors);
  }
  const now = Math.floor(Date.now() / 1000);
  // Reject if an unexpired claim exists for a different taker. Same taker can
  // refresh their own claim (idempotent re-claim).
  if (stored.claim && stored.claim.expires_at > now && stored.claim.taker_pubkey !== takerPubHex) {
    return jsonResponse({
      error: 'listing already claimed',
      claim: { expires_at: stored.claim.expires_at },
    }, 409, cors);
  }
  stored.claim = {
    taker_pubkey: takerPubHex,
    claimed_at: now,
    expires_at: now + CLAIM_TTL_SECONDS,
  };
  await env.REGISTRY_KV.put(key, JSON.stringify(stored));
  return jsonResponse({ ok: true, listing: stored }, 200, cors);
}

async function handleListingDelete(assetIdHex, txidHex, voutStr, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(txidHex))    return jsonResponse({ error: 'invalid txid' }, 400, cors);
  const vout = parseInt(voutStr, 10);
  if (!Number.isInteger(vout) || vout < 0) return jsonResponse({ error: 'invalid vout' }, 400, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const ownerPubHex = String(body.owner_pubkey ?? '').toLowerCase();
  const cancelSigHex = String(body.cancel_sig ?? '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex)) return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(cancelSigHex))    return jsonResponse({ error: 'cancel_sig must be 128 hex chars' }, 400, cors);

  const stored = await env.REGISTRY_KV.get(listingKey(network, assetIdHex, txidHex, vout), 'json');
  if (!stored) return jsonResponse({ error: 'no listing found' }, 404, cors);
  if (stored.owner_pubkey !== ownerPubHex) {
    return jsonResponse({ error: 'owner_pubkey does not match listing' }, 403, cors);
  }
  const msg = cancelMsg(assetIdHex, txidHex, vout);
  if (!verifySchnorr(hexToBytes(cancelSigHex), msg, hexToBytes(ownerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid cancel signature' }, 403, cors);
  }
  await env.REGISTRY_KV.delete(listingKey(network, assetIdHex, txidHex, vout));
  return jsonResponse({ ok: true }, 200, cors);
}

// ============== Range-disclosed listings ==============
// Same offer semantics as per-UTXO listings, but the maker discloses only a
// LOWER BOUND on their balance (via the disclosure rangeproof) instead of
// publishing each UTXO's opening. Other UTXOs of theirs stay confidential.
//
// Wire format combines a disclosure (utxos, threshold, rangeproof,
// disclosure_sig) with the listing terms (price_sats, maker_address, expiry,
// listing_sig). Worker validates BOTH: ownership of every referenced UTXO,
// matching asset_id, disclosure sig, listing sig, network-coherent address.
// Bulletproof itself is not verified server-side (clients re-verify), same
// policy as the standalone disclosure endpoint.
//
// Storage: one range-listing per (asset_id, owner_pubkey). Re-publish to
// update price / available / proof; old entry overwritten.

function rangeListingMsg(assetIdHex, threshold, priceSats, expiry, makerAddress, disclosureSigHex) {
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const thresholdLE = new Uint8Array(8);
  new DataView(thresholdLE.buffer).setBigUint64(0, BigInt(threshold), true);
  const addrBytes = new TextEncoder().encode(makerAddress);
  const addrLen = new Uint8Array(2);
  new DataView(addrLen.buffer).setUint16(0, addrBytes.length, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-range-v1'),
    hexToBytes(assetIdHex),
    thresholdLE,
    priceLE,
    expiryLE,
    addrLen,
    addrBytes,
    hexToBytes(disclosureSigHex),
  ));
}

function rangeListingCancelMsg(assetIdHex, ownerPubHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-range-cancel-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(ownerPubHex),
  ));
}

function rangeListingClaimMsg(assetIdHex, makerPubHex, takerPubHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-range-claim-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(makerPubHex),
    hexToBytes(takerPubHex),
  ));
}

async function handleRangeListingPost(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  // ---- Disclosure fields (ownership + balance lower-bound proof) ----
  const utxosRaw = Array.isArray(body.utxos) ? body.utxos : null;
  const thresholdStr = String(body.threshold ?? '');
  const rangeproofHex = String(body.rangeproof ?? '').toLowerCase();
  const ownerPubHex = String(body.owner_pubkey ?? '').toLowerCase();
  const disclosureSigHex = String(body.disclosure_sig ?? '').toLowerCase();
  // ---- Listing terms ----
  const priceSatsRaw = body.price_sats;
  const expiryRaw = body.expiry;
  const makerAddress = String(body.maker_address ?? '');
  const listingSigHex = String(body.listing_sig ?? '').toLowerCase();

  // Same shape checks as handleDisclosurePost + handleListingPost.
  if (!utxosRaw || !utxosRaw.length || utxosRaw.length > 64) return jsonResponse({ error: 'utxos must be a non-empty array (max 64)' }, 400, cors);
  if (!/^\d+$/.test(thresholdStr))                     return jsonResponse({ error: 'threshold must be base-10 integer string' }, 400, cors);
  if (!/^[0-9a-f]+$/.test(rangeproofHex) || rangeproofHex.length / 2 < BP_LEN_MIN || rangeproofHex.length / 2 > BP_LEN_MAX)
    return jsonResponse({ error: `rangeproof length out of range (${BP_LEN_MIN}–${BP_LEN_MAX} bytes)` }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex))        return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(disclosureSigHex))       return jsonResponse({ error: 'disclosure_sig must be 128 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(listingSigHex))          return jsonResponse({ error: 'listing_sig must be 128 hex chars' }, 400, cors);
  if (!Number.isInteger(priceSatsRaw) || priceSatsRaw < PRICE_MIN || priceSatsRaw > Number.MAX_SAFE_INTEGER)
    return jsonResponse({ error: `price_sats must be integer >= ${PRICE_MIN}` }, 400, cors);
  if (!Number.isInteger(expiryRaw))                    return jsonResponse({ error: 'expiry must be integer unix-seconds' }, 400, cors);
  const now = Math.floor(Date.now() / 1000);
  if (expiryRaw <= now)                                return jsonResponse({ error: 'expiry must be in the future' }, 400, cors);
  if (expiryRaw > now + EXPIRY_MAX_DAYS * 86400)       return jsonResponse({ error: `expiry must be within ${EXPIRY_MAX_DAYS} days` }, 400, cors);

  if (!makerAddress || makerAddress.length > ADDR_MAX_LEN) return jsonResponse({ error: `maker_address required, ≤ ${ADDR_MAX_LEN} chars` }, 400, cors);
  const decoded = decodeBitcoinAddress(makerAddress);
  if (!decoded)  return jsonResponse({ error: 'maker_address is not a valid bech32/bech32m address' }, 400, cors);
  if (decoded.hrp !== HRP_BY_NETWORK[network]) return jsonResponse({ error: `maker_address must use ${HRP_BY_NETWORK[network]}… HRP for ${network}` }, 400, cors);

  let threshold;
  try { threshold = BigInt(thresholdStr); } catch { return jsonResponse({ error: 'unparseable threshold' }, 400, cors); }
  if (threshold <= 0n || threshold >= (1n << BigInt(N_BITS))) {
    return jsonResponse({ error: `threshold must be in (0, 2^${N_BITS})` }, 400, cors);
  }

  const utxos = [];
  for (const u of utxosRaw) {
    const txid = String(u?.txid ?? '').toLowerCase();
    const vout = u?.vout;
    if (!/^[0-9a-f]{64}$/.test(txid))                       return jsonResponse({ error: 'utxo.txid must be 64 hex chars' }, 400, cors);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) return jsonResponse({ error: 'utxo.vout must be integer 0..65535' }, 400, cors);
    utxos.push({ txid, vout });
  }

  // Validate ownership + asset_id consistency for every referenced UTXO.
  const ownerHash160Hex = bytesToHex(hash160(hexToBytes(ownerPubHex)));
  for (const u of utxos) {
    let resolved;
    try { resolved = await commitmentForUtxo(env, u.txid, u.vout, network); }
    catch (e) { return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: ${e.message}` }, 400, cors); }
    if (resolved.asset_id !== assetIdHex) {
      return jsonResponse({ error: `utxo ${u.txid}:${u.vout} is for a different asset` }, 400, cors);
    }
    const tx = await apiJson(env, `/tx/${u.txid}`, {}, network);
    const out = tx?.vout?.[u.vout];
    if (!out?.scriptpubkey) return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: vout missing scriptpubkey` }, 400, cors);
    const spk = hexToBytes(out.scriptpubkey);
    if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
      return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: not P2WPKH` }, 400, cors);
    }
    if (bytesToHex(spk.slice(2, 22)) !== ownerHash160Hex) {
      return jsonResponse({ error: `utxo ${u.txid}:${u.vout}: owner_pubkey does not control this UTXO` }, 403, cors);
    }
  }

  // Disclosure sig over the canonical disclosure msg.
  const xonly = hexToBytes(ownerPubHex).slice(1);
  const dMsg = disclosureMsg(assetIdHex, utxos, threshold, rangeproofHex, ownerPubHex);
  if (!verifySchnorr(hexToBytes(disclosureSigHex), dMsg, xonly)) {
    return jsonResponse({ error: 'invalid disclosure signature' }, 403, cors);
  }
  // Listing sig over the canonical range-listing msg (binds disclosure_sig +
  // price + expiry + maker_address + threshold).
  const lMsg = rangeListingMsg(assetIdHex, threshold, priceSatsRaw, expiryRaw, makerAddress, disclosureSigHex);
  if (!verifySchnorr(hexToBytes(listingSigHex), lMsg, xonly)) {
    return jsonResponse({ error: 'invalid listing signature' }, 403, cors);
  }

  const listing = {
    kind: 'range',
    asset_id: assetIdHex,
    utxos,
    threshold: thresholdStr,
    available_amount: thresholdStr, // alias for clients
    rangeproof: rangeproofHex,
    owner_pubkey: ownerPubHex,
    disclosure_sig: disclosureSigHex,
    price_sats: priceSatsRaw,
    maker_address: makerAddress,
    expiry: expiryRaw,
    listing_sig: listingSigHex,
    listed_at: now,
    network,
  };
  await env.REGISTRY_KV.put(rangeListingKey(network, assetIdHex, ownerPubHex), JSON.stringify(listing));
  return jsonResponse({ ok: true, listing }, 200, cors);
}

async function loadRangeListingsForAsset(env, network, assetIdHex) {
  const list = await env.REGISTRY_KV.list({ prefix: rangeListingPrefix(network, assetIdHex), limit: 1000 });
  const now = Math.floor(Date.now() / 1000);
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const listings = fetched.filter(v => v);
  for (const v of listings) {
    v.expired = (v.expiry || 0) <= now;
    if (v.claim && v.claim.expires_at <= now) v.claim = null;
  }
  listings.sort((a, b) => (b.listed_at || 0) - (a.listed_at || 0));
  return listings;
}

async function handleRangeListingList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const listings = await loadRangeListingsForAsset(env, network, assetIdHex);
  return jsonResponse({ asset_id: assetIdHex, count: listings.length, listings }, 200, cors);
}

async function handleRangeListingDelete(assetIdHex, ownerPubHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex))             return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex.toLowerCase()))
    return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed hex' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const cancelSigHex = String(body.cancel_sig ?? '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(cancelSigHex))          return jsonResponse({ error: 'cancel_sig must be 128 hex chars' }, 400, cors);

  const stored = await env.REGISTRY_KV.get(rangeListingKey(network, assetIdHex, ownerPubHex.toLowerCase()), 'json');
  if (!stored)                  return jsonResponse({ error: 'no listing found' }, 404, cors);
  const msg = rangeListingCancelMsg(assetIdHex, ownerPubHex.toLowerCase());
  if (!verifySchnorr(hexToBytes(cancelSigHex), msg, hexToBytes(ownerPubHex.toLowerCase()).slice(1))) {
    return jsonResponse({ error: 'invalid cancel signature' }, 403, cors);
  }
  await env.REGISTRY_KV.delete(rangeListingKey(network, assetIdHex, ownerPubHex.toLowerCase()));
  return jsonResponse({ ok: true }, 200, cors);
}

async function handleRangeListingClaim(assetIdHex, makerPubHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex))             return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(makerPubHex.toLowerCase()))
    return jsonResponse({ error: 'maker_pubkey must be 33-byte compressed hex' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const takerPubHex = String(body.taker_pubkey ?? '').toLowerCase();
  const sigHex = String(body.sig ?? '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(takerPubHex))       return jsonResponse({ error: 'taker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))                return jsonResponse({ error: 'sig must be 128 hex chars' }, 400, cors);

  const msg = rangeListingClaimMsg(assetIdHex, makerPubHex.toLowerCase(), takerPubHex);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(takerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid taker signature' }, 403, cors);
  }
  const key = rangeListingKey(network, assetIdHex, makerPubHex.toLowerCase());
  const stored = await env.REGISTRY_KV.get(key, 'json');
  if (!stored)                 return jsonResponse({ error: 'no such listing' }, 404, cors);
  if (stored.expiry <= Math.floor(Date.now() / 1000)) {
    return jsonResponse({ error: 'listing expired' }, 410, cors);
  }
  const now = Math.floor(Date.now() / 1000);
  if (stored.claim && stored.claim.expires_at > now && stored.claim.taker_pubkey !== takerPubHex) {
    return jsonResponse({
      error: 'listing already claimed',
      claim: { expires_at: stored.claim.expires_at },
    }, 409, cors);
  }
  stored.claim = {
    taker_pubkey: takerPubHex,
    claimed_at: now,
    expires_at: now + CLAIM_TTL_SECONDS,
  };
  await env.REGISTRY_KV.put(key, JSON.stringify(stored));
  return jsonResponse({ ok: true, listing: stored }, 200, cors);
}

// ============== Atomic intents (T_AXFER browse-and-take marketplace) ==============
// Three-step trustless settlement that's also discoverable:
//   1. Maker publishes a generic intent (asset UTXO + commit tx + terms,
//      no recipient yet).
//   2. Taker browses and claims with their pubkey. Worker locks for 5 min.
//   3. Maker observes the claim, generates a partial reveal targeted at
//      the claimant's pubkey, uploads as a fulfilment.
//   4. Taker fetches the fulfilment, finalizes (appends BTC funding,
//      signs SIGHASH_ALL), broadcasts. One Bitcoin tx, atomic settlement,
//      no counterparty trust.

function atomicIntentMsg(assetIdHex, intentIdHex, makerPubHex, amountStr, priceSats, expiry, commitTxidHex, assetUtxoTxidHex, assetUtxoVout) {
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const amountLE = new Uint8Array(8);
  new DataView(amountLE.buffer).setBigUint64(0, BigInt(amountStr), true);
  const utxoVoutLE = new Uint8Array(4);
  new DataView(utxoVoutLE.buffer).setUint32(0, assetUtxoVout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(intentIdHex),
    hexToBytes(makerPubHex),
    amountLE,
    priceLE,
    expiryLE,
    reverseBytes(hexToBytes(commitTxidHex)),
    reverseBytes(hexToBytes(assetUtxoTxidHex)),
    utxoVoutLE,
  ));
}

// The claim message binds the taker's committed sat UTXO so a third party
// can't replay a captured sig at a different UTXO. Worker enforces
// value >= price_sats on this UTXO at claim time, so a sig over
// (asset, intent, pub, utxo) attests to "this pubkey controlled funds
// ≥ price_sats sitting at this outpoint".
function atomicIntentClaimMsg(assetIdHex, intentIdHex, takerPubHex, takerUtxoTxidHex, takerUtxoVout) {
  const txidBE = reverseBytes(hexToBytes(takerUtxoTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, takerUtxoVout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-claim-v2'),
    hexToBytes(assetIdHex),
    hexToBytes(intentIdHex),
    hexToBytes(takerPubHex),
    txidBE,
    voutLE,
  ));
}

function atomicIntentFulfilmentMsg(assetIdHex, intentIdHex, takerPubHex, partialRevealJson) {
  const phash = sha256(new TextEncoder().encode(partialRevealJson));
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-fulfilment-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(intentIdHex),
    hexToBytes(takerPubHex),
    phash,
  ));
}

function atomicIntentCancelMsg(assetIdHex, intentIdHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-cancel-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(intentIdHex),
  ));
}

// ======== T_AXFER_VAR (§5.7.6.1 + §5.7.9) — variable-amount atomic intents ========
// Pure-function message helpers + intent_id derivation for the variable-amount
// flow. Land before any handler changes so PR2/PR3 can call into a stable
// surface. None of these are wired into the route table yet — the legacy
// whole-UTXO path (atomicIntentMsg / atomicIntentClaimMsg / fulfilment-v1)
// continues to handle every live atomic-intent.

// Deterministic intent_id for variable-amount intents. Unlike the legacy v1
// derivation (which depends on commit_txid and so requires the commit tx to
// exist), this is computed from (maker_pubkey, asset_utxo_outpoint) and is
// therefore derivable both at publish time (no commit tx yet) and from chain
// data alone at seed-only recovery (vin[1] reveals the asset_utxo outpoint).
function atomicIntentIdHexVar(makerPubHex, assetUtxoTxidHex, assetUtxoVout) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, assetUtxoVout >>> 0, true);
  const h = sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-id-v1'),
    hexToBytes(makerPubHex),
    reverseBytes(hexToBytes(assetUtxoTxidHex)),
    voutLE,
  ));
  return bytesToHex(h.slice(0, 16));
}

// Publish-time BIP-340 message for variable-amount intents. Binds every
// field a taker quotes against. No commit_txid (it doesn't exist yet); the
// maker's signature over this message is the only binding the worker holds
// until fulfilment.
function atomicIntentPublishMsgVar({
  assetIdHex, intentIdHex, makerPubHex, makerAddress,
  amountStr, priceSats, minTakeStr, expiry,
  assetUtxoTxidHex, assetUtxoVout, assetUtxoValue, network,
}) {
  const amountLE   = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amountStr), true);
  const priceLE    = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const minTakeLE  = new Uint8Array(8); new DataView(minTakeLE.buffer).setBigUint64(0, BigInt(minTakeStr || '0'), true);
  const expiryLE   = new Uint8Array(8); new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const utxoVoutLE = new Uint8Array(4); new DataView(utxoVoutLE.buffer).setUint32(0, assetUtxoVout >>> 0, true);
  const utxoValLE  = new Uint8Array(8); new DataView(utxoValLE.buffer).setBigUint64(0, BigInt(assetUtxoValue), true);
  const addrHash   = sha256(new TextEncoder().encode(String(makerAddress)));
  const netTag     = new Uint8Array([network === 'mainnet' ? 1 : 0]);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-publish-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(intentIdHex),
    reverseBytes(hexToBytes(assetUtxoTxidHex)),
    utxoVoutLE,
    utxoValLE,
    amountLE,
    priceLE,
    minTakeLE,
    expiryLE,
    hexToBytes(makerPubHex),
    addrHash,
    netTag,
  ));
}

// Variable-amount claim message. Adds `requested_amount` to v2's binding so
// a maker cannot honour a different amount than the taker requested.
function atomicIntentClaimMsgVar(assetIdHex, intentIdHex, takerPubHex, takerUtxoTxidHex, takerUtxoVout, requestedAmountStr) {
  const txidBE = reverseBytes(hexToBytes(takerUtxoTxidHex));
  const voutLE = new Uint8Array(4); new DataView(voutLE.buffer).setUint32(0, takerUtxoVout >>> 0, true);
  const reqLE  = new Uint8Array(8); new DataView(reqLE.buffer).setBigUint64(0, BigInt(requestedAmountStr), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-claim-v3'),
    hexToBytes(assetIdHex),
    hexToBytes(intentIdHex),
    hexToBytes(takerPubHex),
    txidBE,
    voutLE,
    reqLE,
  ));
}

// Variable-amount fulfilment message. Adds `requested_amount` to v1's
// binding so the maker's signature commits to the delivered amount even if
// partial_reveal_json parsing diverges between implementations.
function atomicIntentFulfilmentMsgVar(assetIdHex, intentIdHex, takerPubHex, requestedAmountStr, partialRevealJson) {
  const phash = sha256(new TextEncoder().encode(partialRevealJson));
  const reqLE = new Uint8Array(8); new DataView(reqLE.buffer).setBigUint64(0, BigInt(requestedAmountStr), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-fulfilment-v2'),
    hexToBytes(assetIdHex),
    hexToBytes(intentIdHex),
    hexToBytes(takerPubHex),
    reqLE,
    phash,
  ));
}

// Verifies the maker's intent_sig over the publish-time message under
// `maker_pubkey`. Returns boolean. Caller is responsible for x-only
// extraction (the dapp passes 33-byte compressed pubkey; we slice for the
// x-only form noble expects). Rejects malformed inputs cleanly.
function verifyAtomicIntentPublishSig({
  assetIdHex, intentIdHex, makerPubHex, makerAddress,
  amountStr, priceSats, minTakeStr, expiry,
  assetUtxoTxidHex, assetUtxoVout, assetUtxoValue, network,
  sigHex,
}) {
  try {
    if (!/^[0-9a-f]{128}$/.test(String(sigHex || '').toLowerCase())) return false;
    if (!/^[0-9a-f]{66}$/.test(String(makerPubHex || '').toLowerCase())) return false;
    const msg = atomicIntentPublishMsgVar({
      assetIdHex, intentIdHex, makerPubHex, makerAddress,
      amountStr, priceSats, minTakeStr, expiry,
      assetUtxoTxidHex, assetUtxoVout, assetUtxoValue, network,
    });
    const xonly = hexToBytes(makerPubHex).slice(1);
    return verifySchnorr(hexToBytes(String(sigHex).toLowerCase()), msg, xonly);
  } catch {
    return false;
  }
}

// ============== PREAUTH SALES (SPEC §5.7.8) ==============
// Buyer-completable T_AXFER: seller signs once at listing time, buyer
// completes settlement alone via ECDH-derived r_out (§5.7.3-style recovery).
// Storage: one record per sale, plus an outpoint→sale_id index so POST
// can reject duplicates in O(1) and cron outspend-scans can mark spent
// outpoints stale without iterating every presale.

function preauthSaleKey(network, aid, saleIdHex) {
  return network === 'signet'
    ? `presale:${aid}:${saleIdHex}`
    : `presale:${network}:${aid}:${saleIdHex}`;
}
function preauthSalePrefix(network, aid) {
  return network === 'signet' ? `presale:${aid}:` : `presale:${network}:${aid}:`;
}
function preauthOutpointIndexKey(network, aid, txidHex, vout) {
  return network === 'signet'
    ? `presale-by-outpoint:${aid}:${txidHex}:${vout}`
    : `presale-by-outpoint:${network}:${aid}:${txidHex}:${vout}`;
}

// Bitcoin varint encoding — matches the wire format used in serialized
// scripts and in the BIP-143 sighash preimage's scriptCode/varslice fields.
function _writeBitcoinVarint(n) {
  const v = Number(n);
  if (v < 0xfd) return new Uint8Array([v]);
  if (v < 0x10000) { const b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, v, true); return b; }
  if (v < 0x100000000) { const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, v, true); return b; }
  const b = new Uint8Array(9); b[0] = 0xff; new DataView(b.buffer).setBigUint64(1, BigInt(v), true); return b;
}
function _varslice(bytes) {
  return concatBytes(_writeBitcoinVarint(bytes.length), bytes);
}

// sale_id derivation pins each listing to its outpoint + seller + a per-
// publish nonce. Cancel + re-list yields a fresh sale_id; outpoint
// uniqueness is enforced separately via preauthOutpointIndexKey.
function preauthSaleIdHex(assetOutpointTxidHex, assetOutpointVout, sellerPubHex, nonceHex) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, assetOutpointVout >>> 0, true);
  const h = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-sale-id-v1'),
    reverseBytes(hexToBytes(assetOutpointTxidHex)),
    voutLE,
    hexToBytes(sellerPubHex),
    hexToBytes(nonceHex),
  ));
  return bytesToHex(h.slice(0, 16));
}

function preauthSaleAuthMsg({
  assetIdHex, saleIdHex, sellerPubHex,
  assetOutpointTxidHex, assetOutpointVout, assetUtxoValue,
  amountStr, blindingHex,
  minPriceSats,
  sellerPayoutScriptHex,
  expiry,
  sellerAssetSpendSigHex,
  nonceHex,
}) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, assetOutpointVout >>> 0, true);
  const valueLE = new Uint8Array(8);
  new DataView(valueLE.buffer).setBigUint64(0, BigInt(assetUtxoValue), true);
  const amountLE = new Uint8Array(8);
  new DataView(amountLE.buffer).setBigUint64(0, BigInt(amountStr), true);
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(minPriceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-sale-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(saleIdHex),
    hexToBytes(sellerPubHex),
    reverseBytes(hexToBytes(assetOutpointTxidHex)),
    voutLE,
    valueLE,
    amountLE,
    hexToBytes(blindingHex),
    priceLE,
    _varslice(hexToBytes(sellerPayoutScriptHex)),
    expiryLE,
    _varslice(hexToBytes(sellerAssetSpendSigHex)),
    hexToBytes(nonceHex),
  ));
}

function preauthSaleCancelMsg(assetIdHex, saleIdHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-sale-cancel-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(saleIdHex),
  ));
}

// BIP-143 sighash reconstruction for the seller's pre-signed asset input.
// SPEC §5.7.8: vin[1] = asset outpoint, vout[1] = seller payout, version 2,
// locktime 0, nSequence 0xfffffffd, SIGHASH_SINGLE|ANYONECANPAY (0x83).
// Every field comes from the sale-auth body, so this is deterministic and
// replayable; the worker rejects the listing if the signature doesn't
// verify against this exact preimage.
function preauthSellerSpendSighash({
  assetOutpointTxidHex, assetOutpointVout, assetUtxoValue,
  sellerPubHex, sellerPayoutScriptHex, minPriceSats,
}) {
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const zero32 = new Uint8Array(32);
  // P2WPKH scriptCode = 0x76 0xa9 0x14 || hash160(pubkey) || 0x88 0xac.
  const scriptCode = concatBytes(
    new Uint8Array([0x76, 0xa9, 0x14]),
    hash160(hexToBytes(sellerPubHex)),
    new Uint8Array([0x88, 0xac]),
  );
  // SIGHASH_SINGLE on input_index=1 → hashOutputs covers only vout[1].
  const vout1Serialized = concatBytes(u64(minPriceSats), _varslice(hexToBytes(sellerPayoutScriptHex)));
  const hashOutputs = hash256(vout1Serialized);
  const preimage = concatBytes(
    u32(2),                                          // nVersion
    zero32,                                          // hashPrevouts (ANYONECANPAY)
    zero32,                                          // hashSequence (ANYONECANPAY)
    reverseBytes(hexToBytes(assetOutpointTxidHex)),  // outpoint.txid (BE wire form)
    u32(assetOutpointVout),                          // outpoint.vout
    _varslice(scriptCode),                           // scriptCode
    u64(assetUtxoValue),                             // value
    u32(0xfffffffd),                                 // nSequence
    hashOutputs,                                     // hashOutputs (vout[1] only)
    u32(0),                                          // nLocktime
    u32(0x83),                                       // nHashType (SIGHASH_SINGLE | ANYONECANPAY)
  );
  return hash256(preimage);
}

// DER → compact (64-byte r||s) for noble's verify(), which is compact-only.
// Returns null if DER is malformed; caller treats null as a verification failure.
function derToCompactSig(derBytes) {
  if (!(derBytes instanceof Uint8Array) || derBytes.length < 8 || derBytes.length > 72) return null;
  if (derBytes[0] !== 0x30) return null;
  if (derBytes[1] !== derBytes.length - 2) return null;
  if (derBytes[2] !== 0x02) return null;
  const rLen = derBytes[3];
  if (rLen < 1 || rLen > 33 || 4 + rLen >= derBytes.length) return null;
  let r = derBytes.slice(4, 4 + rLen);
  if (derBytes[4 + rLen] !== 0x02) return null;
  const sLen = derBytes[5 + rLen];
  if (sLen < 1 || sLen > 33 || 6 + rLen + sLen !== derBytes.length) return null;
  let s = derBytes.slice(6 + rLen, 6 + rLen + sLen);
  // Strip the leading sign-padding byte that DER adds when the high bit is set.
  if (r.length === 33) { if (r[0] !== 0x00) return null; r = r.slice(1); }
  if (s.length === 33) { if (s[0] !== 0x00) return null; s = s.slice(1); }
  if (r.length > 32 || s.length > 32) return null;
  const compact = new Uint8Array(64);
  compact.set(r, 32 - r.length);
  compact.set(s, 64 - s.length);
  return compact;
}

function verifyEcdsaDerSig(derSigBytes, msgHash32, pubkeyBytes33) {
  const compact = derToCompactSig(derSigBytes);
  if (!compact) return false;
  try { return secp.verify(compact, msgHash32, pubkeyBytes33, { lowS: true }); } catch { return false; }
}

// ======== Variable-amount handler helpers (PR2/3 of §5.7.6.1 rollout) ========
// Each `_var` helper is dispatched from the matching legacy handler when the
// intent / body carries `min_take_amount`. The legacy whole-UTXO path is
// otherwise untouched: an intent without `min_take_amount` flows through the
// pre-existing code unchanged. State machine:
//   POST  /atomic-intents               → OPEN          (intent created)
//   POST  /atomic-intents/.../claim     → CLAIMED       (taker reservation)
//   POST  /atomic-intents/.../fulfilment→ COMMIT_READY  (maker shipped commit+reveal bytes)
// PR3 will add /finalize → REVEAL_READY → broadcast → SETTLED.

async function _handleAtomicIntentPostVar(assetIdHex, body, env, network, cors) {
  const intentIdHex   = String(body.intent_id ?? '').toLowerCase();
  const makerPubHex   = String(body.maker_pubkey ?? '').toLowerCase();
  const makerAddress  = String(body.maker_address ?? '');
  const amountStr     = String(body.amount ?? '');
  const minTakeStr    = String(body.min_take_amount ?? '');
  const priceSatsRaw  = body.price_sats;
  const expiryRaw     = body.expiry;
  const assetUtxoTxid = String(body.asset_utxo?.txid ?? '').toLowerCase();
  const assetUtxoVout = body.asset_utxo?.vout;
  const assetUtxoValue= body.asset_utxo?.value;
  const ticker        = String(body.ticker ?? '');
  const decimals      = body.decimals;
  const sigHex        = String(body.intent_sig ?? '').toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(intentIdHex))             return jsonResponse({ error: 'intent_id must be 32 hex chars (16 bytes)' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(makerPubHex))        return jsonResponse({ error: 'maker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^\d+$/.test(amountStr))                        return jsonResponse({ error: 'amount must be base-10 integer string' }, 400, cors);
  if (!/^\d+$/.test(minTakeStr))                       return jsonResponse({ error: 'min_take_amount must be base-10 integer string' }, 400, cors);
  if (!Number.isInteger(priceSatsRaw) || priceSatsRaw < PRICE_MIN) return jsonResponse({ error: `price_sats must be integer ≥ ${PRICE_MIN}` }, 400, cors);
  if (!Number.isInteger(expiryRaw))                    return jsonResponse({ error: 'expiry must be integer unix-seconds' }, 400, cors);
  const now = Math.floor(Date.now() / 1000);
  if (expiryRaw <= now)                                return jsonResponse({ error: 'expiry must be in the future' }, 400, cors);
  if (expiryRaw > now + EXPIRY_MAX_DAYS * 86400)       return jsonResponse({ error: `expiry must be within ${EXPIRY_MAX_DAYS} days` }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(assetUtxoTxid))           return jsonResponse({ error: 'asset_utxo.txid must be 64 hex chars' }, 400, cors);
  if (!Number.isInteger(assetUtxoVout) || assetUtxoVout < 0) return jsonResponse({ error: 'asset_utxo.vout must be non-negative integer' }, 400, cors);
  if (!Number.isInteger(assetUtxoValue) || assetUtxoValue < DUST) return jsonResponse({ error: 'asset_utxo.value invalid' }, 400, cors);
  if (!makerAddress || makerAddress.length > ADDR_MAX_LEN) return jsonResponse({ error: `maker_address required, ≤ ${ADDR_MAX_LEN} chars` }, 400, cors);
  const decoded = decodeBitcoinAddress(makerAddress);
  if (!decoded || decoded.hrp !== HRP_BY_NETWORK[network]) {
    return jsonResponse({ error: `maker_address must be a ${HRP_BY_NETWORK[network]}… bech32 address` }, 400, cors);
  }
  if (!/^[0-9a-f]{128}$/.test(sigHex))                 return jsonResponse({ error: 'intent_sig must be 128 hex chars' }, 400, cors);

  // Bound check: 1 ≤ min_take ≤ amount. min_take == amount is the degenerate
  // case (semantically equivalent to a whole-UTXO intent on opcode 0x26);
  // refuse so the maker uses the legacy path instead of paying T_AXFER_VAR's
  // ~40-vbyte OP_RETURN(80) overhead for no gain.
  const amountBI  = BigInt(amountStr);
  const minTakeBI = BigInt(minTakeStr);
  if (minTakeBI < 1n)         return jsonResponse({ error: 'min_take_amount must be ≥ 1 base unit' }, 400, cors);
  if (minTakeBI > amountBI)   return jsonResponse({ error: 'min_take_amount must not exceed amount' }, 400, cors);
  if (minTakeBI === amountBI) return jsonResponse({ error: 'min_take_amount == amount is a whole-UTXO intent; use the legacy path (omit min_take_amount)' }, 400, cors);

  // Verify the deterministic intent_id derivation. For variable-amount intents
  // the id depends on (maker_pubkey, asset_utxo_outpoint) — derivable from
  // chain at recovery time. See SPEC §5.7.6.1 "Commit-phase timing".
  const expectedIntentId = atomicIntentIdHexVar(makerPubHex, assetUtxoTxid, assetUtxoVout);
  if (intentIdHex !== expectedIntentId) {
    return jsonResponse({ error: 'intent_id does not derive from sha256("tacit-axintent-id-v1" || maker_pubkey || asset_utxo)[:16]' }, 400, cors);
  }

  // Verify the maker controls the asset UTXO (P2WPKH of maker_pubkey).
  let assetTx;
  try { assetTx = await fetchFreshTxJson(env, assetUtxoTxid, network); }
  catch (e) { return jsonResponse({ error: 'asset_utxo tx not found after retries: ' + e.message }, 400, cors); }
  const out = assetTx?.vout?.[assetUtxoVout];
  if (!out?.scriptpubkey) return jsonResponse({ error: 'asset_utxo missing scriptpubkey' }, 400, cors);
  const spk = hexToBytes(out.scriptpubkey);
  if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) return jsonResponse({ error: 'asset_utxo not P2WPKH' }, 400, cors);
  if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(hexToBytes(makerPubHex)))) {
    return jsonResponse({ error: 'maker_pubkey does not control the asset UTXO' }, 403, cors);
  }
  // Asset-id binding: the parent envelope of asset_utxo must declare assetIdHex.
  let resolved;
  try { resolved = await commitmentForUtxo(env, assetUtxoTxid, assetUtxoVout, network); }
  catch (e) { return jsonResponse({ error: 'commitment lookup failed: ' + e.message }, 400, cors); }
  if (resolved.asset_id !== assetIdHex) {
    return jsonResponse({ error: 'asset_utxo is for a different asset' }, 400, cors);
  }
  // Sanity: the cleartext `amount` field must match the parent's amount.
  // For T_AXFER_VAR the maker can't lie about the listed amount (the kernel
  // sig at fulfilment closes against C_listed = amount·H + r_listed·G), but
  // catching the mismatch at publish saves takers a wasted claim.
  if (resolved.amount != null && String(resolved.amount) !== amountStr) {
    return jsonResponse({ error: `amount mismatch (declared ${amountStr}, parent envelope says ${resolved.amount})` }, 400, cors);
  }

  if (!verifyAtomicIntentPublishSig({
    assetIdHex, intentIdHex, makerPubHex, makerAddress,
    amountStr, priceSats: priceSatsRaw, minTakeStr, expiry: expiryRaw,
    assetUtxoTxidHex: assetUtxoTxid, assetUtxoVout, assetUtxoValue, network,
    sigHex,
  })) {
    return jsonResponse({ error: 'invalid intent signature (variable-amount publish)' }, 403, cors);
  }

  const intent = {
    asset_id: assetIdHex,
    intent_id: intentIdHex,
    maker_pubkey: makerPubHex,
    maker_address: makerAddress,
    amount: amountStr,
    price_sats: priceSatsRaw,
    min_take_amount: minTakeStr,   // presence discriminates variable-amount from legacy
    expiry: expiryRaw,
    asset_utxo: { txid: assetUtxoTxid, vout: assetUtxoVout, value: assetUtxoValue },
    ticker: ticker || '',
    decimals: Number.isInteger(decimals) ? decimals : 0,
    intent_sig: sigHex,
    state: 'OPEN',
    created_at: now,
    network,
    // NOTE: NO commit_txid / envelope_script_hex / control_block_hex /
    // p2tr_spk_hex / commit_value. Per §5.7.6.1 *Commit-phase timing*, those
    // fields are populated at fulfilment time, not publish.
  };
  await env.REGISTRY_KV.put(atomicIntentKey(network, assetIdHex, intentIdHex), JSON.stringify(intent));
  return jsonResponse({ ok: true, intent }, 200, cors);
}

async function _handleAtomicIntentClaimVar(assetIdHex, intentIdHex, intent, body, env, network, cors) {
  // intent is the loaded variable-amount intent record (caller has already
  // verified it exists, isn't expired, and that no conflicting claim is live).
  const takerPubHex     = String(body.taker_pubkey ?? '').toLowerCase();
  const sigHex          = String(body.sig ?? '').toLowerCase();
  const takerUtxoTxid   = String(body.taker_utxo?.txid ?? '').toLowerCase();
  const takerUtxoVout   = body.taker_utxo?.vout;
  const requestedAmountStr = String(body.requested_amount ?? '');

  if (!/^0[23][0-9a-f]{64}$/.test(takerPubHex)) return jsonResponse({ error: 'taker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))          return jsonResponse({ error: 'sig must be 128 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(takerUtxoTxid))    return jsonResponse({ error: 'taker_utxo.txid must be 64 hex chars' }, 400, cors);
  if (!Number.isInteger(takerUtxoVout) || takerUtxoVout < 0 || takerUtxoVout > 0xffff) {
    return jsonResponse({ error: 'taker_utxo.vout must be non-negative integer' }, 400, cors);
  }
  if (!/^\d+$/.test(requestedAmountStr)) return jsonResponse({ error: 'requested_amount must be base-10 integer string' }, 400, cors);

  // Bound check: min_take ≤ requested ≤ amount.
  const amountBI    = BigInt(intent.amount);
  const minTakeBI   = BigInt(intent.min_take_amount || '0');
  const requestedBI = BigInt(requestedAmountStr);
  if (requestedBI < minTakeBI) return jsonResponse({ error: `requested_amount ${requestedAmountStr} below min_take_amount ${intent.min_take_amount}` }, 400, cors);
  if (requestedBI > amountBI)  return jsonResponse({ error: `requested_amount ${requestedAmountStr} exceeds listed amount ${intent.amount}` }, 400, cors);

  // Same taker-utxo on-chain proof-of-funds check as legacy claim. Price gate
  // is *scaled* — taker only needs to cover floor(requested × price / amount)
  // not the whole listed price.
  let takerTx;
  try { takerTx = await fetchFreshTxJson(env, takerUtxoTxid, network); }
  catch (e) { return jsonResponse({ error: 'taker_utxo tx not found after retries: ' + e.message }, 400, cors); }
  const takerOut = takerTx?.vout?.[takerUtxoVout];
  if (!takerOut?.scriptpubkey) return jsonResponse({ error: 'taker_utxo missing scriptpubkey' }, 400, cors);
  const spk = hexToBytes(takerOut.scriptpubkey);
  if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) return jsonResponse({ error: 'taker_utxo not P2WPKH' }, 400, cors);
  if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(hexToBytes(takerPubHex)))) {
    return jsonResponse({ error: 'taker_pubkey does not control taker_utxo' }, 403, cors);
  }
  // Scaled-price gate. Uses BigInt for the multiply to avoid precision loss on
  // u64 amounts, then converts the final divided sat figure to Number for the
  // ≥ check (BTC values fit comfortably in Number until ~21 PHsat).
  const priceSatsBI = BigInt(intent.price_sats);
  const requiredSatsBI = (requestedBI * priceSatsBI) / amountBI; // floor
  const requiredSats   = Number(requiredSatsBI);
  if (requiredSats < DUST) {
    return jsonResponse({ error: `requested_amount yields sub-dust BTC payment (${requiredSats} < ${DUST}); raise requested_amount` }, 400, cors);
  }
  const utxoValue = Number(takerOut.value);
  if (!Number.isInteger(utxoValue) || utxoValue < requiredSats) {
    return jsonResponse({ error: `taker_utxo value (${utxoValue}) is below scaled price (${requiredSats}) for requested_amount ${requestedAmountStr}` }, 400, cors);
  }

  const msg = atomicIntentClaimMsgVar(assetIdHex, intentIdHex, takerPubHex, takerUtxoTxid, takerUtxoVout, requestedAmountStr);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(takerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid taker signature (claim_msg_v3)' }, 403, cors);
  }
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    intent_id: intentIdHex,
    taker_pubkey: takerPubHex,
    taker_utxo: { txid: takerUtxoTxid, vout: takerUtxoVout, value: utxoValue },
    requested_amount: requestedAmountStr,  // new for variable-amount
    sig: sigHex,
    state: 'CLAIMED',
    claimed_at: now,
    expires_at: now + CLAIM_TTL_SECONDS,
  };
  await env.REGISTRY_KV.put(
    atomicClaimKey(network, assetIdHex, intentIdHex),
    JSON.stringify(claim),
    { expirationTtl: CLAIM_TTL_SECONDS + 60 },
  );
  return jsonResponse({ ok: true, claim, intent }, 200, cors);
}

// PR3: taker-completed reveal submission + sequential broadcast. The maker
// shipped commit_tx_hex (unbroadcast) + partial_reveal at /fulfilment; the
// taker downloaded both, added funding inputs + SIGHASH_ALL signature, and
// now submits the completed reveal here. The worker broadcasts the commit
// tx first, polls for mempool visibility, then broadcasts the completed
// reveal as a CPFP-style ancestor pair. The two broadcasts together settle
// the atomic OTC variable-amount take per SPEC §5.7.6.1.
async function _handleAtomicIntentFinalizeVar(assetIdHex, intentIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex))    return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(intentIdHex))   return jsonResponse({ error: 'invalid intent_id' }, 400, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const takerPubHex   = String(body.taker_pubkey ?? '').toLowerCase();
  const revealTxHex   = String(body.reveal_tx_hex ?? '').toLowerCase();

  if (!/^0[23][0-9a-f]{64}$/.test(takerPubHex)) return jsonResponse({ error: 'taker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]+$/.test(revealTxHex)        || revealTxHex.length < 200 || revealTxHex.length > 65536) {
    return jsonResponse({ error: 'reveal_tx_hex must be hex (≥ 100 bytes raw, ≤ 32 KB raw)' }, 400, cors);
  }

  // Load the intent + claim + fulfilment triple. Variable-amount intents must
  // be in COMMIT_READY (maker shipped the unbroadcast commit + partial reveal
  // at /fulfilment) before /finalize can advance them.
  const intent = await env.REGISTRY_KV.get(atomicIntentKey(network, assetIdHex, intentIdHex), 'json');
  if (!intent) return jsonResponse({ error: 'no such intent' }, 404, cors);
  if (!(intent.min_take_amount && String(intent.min_take_amount) !== '')) {
    return jsonResponse({ error: '/finalize is only for variable-amount intents; legacy intents broadcast taker-side' }, 400, cors);
  }
  const claim = await env.REGISTRY_KV.get(atomicClaimKey(network, assetIdHex, intentIdHex), 'json');
  const now = Math.floor(Date.now() / 1000);
  if (!claim || claim.expires_at <= now) return jsonResponse({ error: 'no active claim' }, 404, cors);
  if (claim.taker_pubkey !== takerPubHex) return jsonResponse({ error: 'taker_pubkey does not match claim' }, 403, cors);

  const fulfilment = await env.REGISTRY_KV.get(atomicFulfilmentKey(network, assetIdHex, intentIdHex), 'json');
  if (!fulfilment) return jsonResponse({ error: 'no fulfilment record; maker must POST /fulfilment first' }, 404, cors);
  if (fulfilment.taker_pubkey !== takerPubHex) return jsonResponse({ error: 'fulfilment taker_pubkey does not match claim' }, 403, cors);
  // State machine guard: only COMMIT_READY may transition forward. Idempotent
  // re-POSTs against an already-broadcast fulfilment return the existing state
  // so the taker UI can surface the in-flight broadcast rather than re-trying.
  if (fulfilment.state === 'REVEAL_BROADCAST' || fulfilment.state === 'SETTLED') {
    return jsonResponse({ ok: true, fulfilment, note: 'already finalized; broadcast in flight or confirmed' }, 200, cors);
  }
  if (fulfilment.state !== 'COMMIT_READY') {
    return jsonResponse({ error: `fulfilment state ${fulfilment.state || 'unknown'} cannot transition to REVEAL_READY` }, 409, cors);
  }
  if (!fulfilment.commit_tx_hex) {
    return jsonResponse({ error: 'fulfilment record is missing commit_tx_hex; cannot finalize' }, 400, cors);
  }

  // Persist the taker-completed reveal + advance state to REVEAL_READY before
  // attempting any broadcast. If broadcast fails midway, the fulfilment record
  // still reflects what was submitted, and the maker UI / cron can drive a
  // retry rather than the taker having to re-sign.
  const fulfilmentAdvanced = {
    ...fulfilment,
    reveal_tx_hex: revealTxHex,
    state: 'REVEAL_READY',
    reveal_submitted_at: now,
  };
  await env.REGISTRY_KV.put(
    atomicFulfilmentKey(network, assetIdHex, intentIdHex),
    JSON.stringify(fulfilmentAdvanced),
  );

  // Step 1: broadcast commit. mempool.space returns the canonical txid on the
  // 200 response body — we capture it for the visibility poll.
  let commitTxid;
  try { commitTxid = (await apiText(env, '/tx', { method: 'POST', body: fulfilment.commit_tx_hex }, network)).trim(); }
  catch (e) {
    // Leave the fulfilment at REVEAL_READY so the maker can re-fulfil if the
    // commit was malformed; the next /fulfilment POST will overwrite it.
    return jsonResponse({ error: `commit_tx broadcast failed: ${e.message}` }, 502, cors);
  }
  if (!/^[0-9a-f]{64}$/.test(commitTxid)) {
    return jsonResponse({ error: `commit_tx broadcast returned unexpected txid: ${commitTxid}` }, 502, cors);
  }

  // Step 2: brief mempool-visibility poll. mempool.space's /tx/{txid} index
  // typically catches up in 1–10s after broadcast. We poll up to ~15s total
  // wall clock (3 attempts × 5s) so the reveal's CPFP parent is referenceable
  // by the time we broadcast it. Skipping the wait works on most healthy
  // nodes but is brittle on slow indexers, so we do the cheap thing.
  let commitVisible = false;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await apiJson(env, `/tx/${commitTxid}`, {}, network);
      if (r && r.txid === commitTxid) { commitVisible = true; break; }
    } catch { /* indexer lag, retry */ }
    if (i < 2) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!commitVisible) {
    // Soft-fail: the commit broadcast accepted, the indexer just hasn't caught
    // up. We still attempt the reveal — bitcoind's mempool will accept the
    // reveal as long as the commit is somewhere in the mempool, even if the
    // /tx/{txid} HTTP index hasn't refreshed. This matches existing dapp
    // broadcast behavior for chunked preauth + axintent settlements.
  }

  // Step 3: broadcast the taker-completed reveal.
  //
  // Retry loop: mempool.space's /tx/{txid} HTTP index can return 200 OK for
  // the commit BEFORE the underlying bitcoind that serves /tx POST has the
  // commit in its mempool yet. When that happens, bitcoind rejects the reveal
  // with `bad-txns-inputs-missingorspent` (code -25) because it can't see
  // commit:0 yet. The fix is to retry the reveal a few times with backoff —
  // each retry gives bitcoind another chance to receive the commit via gossip.
  // Surfaced on the §5.7.6.1 signet e2e harness's second run (the first run
  // had an OP_RETURN(80) bug; once that was fixed, this timing race remained).
  let revealTxid;
  let revealErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      revealTxid = (await apiText(env, '/tx', { method: 'POST', body: revealTxHex }, network)).trim();
      revealErr = null;
      break;
    } catch (e) {
      revealErr = e;
      // Retry ONLY on the missing-or-spent class — any other error (bad
      // signature, oversize, non-final, etc.) won't be helped by waiting and
      // we should fail fast so the dapp sees the real problem.
      if (!/missingorspent|missing or spent/i.test(String(e.message))) break;
      if (attempt < 3) {
        // Exponential-ish backoff: 4s, 8s, 16s — caps at ~28s total before
        // the worker's 30s CPU budget runs out.
        await new Promise(resolve => setTimeout(resolve, [4000, 8000, 16000][attempt]));
      }
    }
  }
  if (revealErr) {
    // Reveal failed for real (not a transient indexer race). Commit is on
    // chain but the reveal won't settle. Mark fulfilment ABANDONED so the
    // maker UI can offer the script-path reclaim per §5.7.6 *recovery*.
    await env.REGISTRY_KV.put(
      atomicFulfilmentKey(network, assetIdHex, intentIdHex),
      JSON.stringify({ ...fulfilmentAdvanced, state: 'ABANDONED', commit_txid: commitTxid, abandoned_at: now, error: String(revealErr.message).slice(0, 200) }),
    );
    return jsonResponse({
      error: `commit broadcast OK (${commitTxid}) but reveal broadcast failed after retries: ${revealErr.message}. Maker can reclaim the commit P2TR UTXO via maker-only script-path spend.`,
      commit_txid: commitTxid,
    }, 502, cors);
  }
  if (!/^[0-9a-f]{64}$/.test(revealTxid)) {
    return jsonResponse({ error: `reveal_tx broadcast returned unexpected txid: ${revealTxid}` }, 502, cors);
  }

  const settled = {
    ...fulfilmentAdvanced,
    state: 'REVEAL_BROADCAST',
    commit_txid: commitTxid,
    reveal_txid: revealTxid,
    broadcast_at: now,
  };
  await env.REGISTRY_KV.put(atomicFulfilmentKey(network, assetIdHex, intentIdHex), JSON.stringify(settled));
  return jsonResponse({
    ok: true,
    fulfilment: settled,
    commit_txid: commitTxid,
    reveal_txid: revealTxid,
    explorer: {
      commit: `https://mempool.space/${network === 'mainnet' ? '' : 'signet/'}tx/${commitTxid}`,
      reveal: `https://mempool.space/${network === 'mainnet' ? '' : 'signet/'}tx/${revealTxid}`,
    },
  }, 200, cors);
}

async function _handleAtomicIntentFulfilVar(assetIdHex, intentIdHex, intent, claim, body, env, network, cors) {
  // intent is the loaded variable-amount intent; claim is a live CLAIMED record
  // (caller verified claim.taker_pubkey matches body.taker_pubkey already).
  const takerPubHex   = String(body.taker_pubkey ?? '').toLowerCase();
  const partialReveal = body.partial_reveal;
  const sigHex        = String(body.fulfilment_sig ?? '').toLowerCase();
  const encRecipBlindingHex  = String(body.enc_recipient_blinding ?? '').toLowerCase();
  // PR2 stores the broadcast-related fields opaquely. PR3 will decode the
  // envelope, derive the P2TR address, verify it matches the commit tx's
  // vout[0] script, and validate vout[1] == floor(requested × price / amount).
  const commitTxHex          = String(body.commit_tx_hex ?? '').toLowerCase();
  const envelopeScriptHex    = String(body.envelope_script_hex ?? '').toLowerCase();
  const controlBlockHex      = String(body.control_block_hex ?? '').toLowerCase();
  const p2trSpkHex           = String(body.p2tr_spk_hex ?? '').toLowerCase();

  if (typeof partialReveal !== 'object' || partialReveal === null) return jsonResponse({ error: 'partial_reveal must be a JSON object' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return jsonResponse({ error: 'fulfilment_sig must be 128 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(encRecipBlindingHex)) return jsonResponse({ error: 'enc_recipient_blinding must be 64 hex chars (32-byte ciphertext)' }, 400, cors);
  if (!/^[0-9a-f]+$/.test(commitTxHex)        || commitTxHex.length > 32768)        return jsonResponse({ error: 'commit_tx_hex must be hex, ≤ 16 KB raw' }, 400, cors);
  if (!/^[0-9a-f]+$/.test(envelopeScriptHex)  || envelopeScriptHex.length > 4096 || envelopeScriptHex.length < 80) {
    return jsonResponse({ error: 'envelope_script_hex required (40–2048 byte hex string)' }, 400, cors);
  }
  if (!/^[0-9a-f]{66}$/.test(controlBlockHex)) return jsonResponse({ error: 'control_block_hex must be 33-byte hex (parity_byte + 32-byte internal key)' }, 400, cors);
  if (!/^5120[0-9a-f]{64}$/.test(p2trSpkHex)) return jsonResponse({ error: 'p2tr_spk_hex must be a P2TR scriptPubKey: 34 bytes (51 20 + 32-byte tweaked output key)' }, 400, cors);

  const requestedAmountStr = String(claim.requested_amount ?? '');
  if (!/^\d+$/.test(requestedAmountStr)) {
    return jsonResponse({ error: 'claim is missing requested_amount; cannot fulfil under v2 path' }, 400, cors);
  }
  // Maker fulfilment sig under v2 domain — binds requested_amount explicitly.
  const partialRevealJson = JSON.stringify(partialReveal);
  const msg = atomicIntentFulfilmentMsgVar(assetIdHex, intentIdHex, takerPubHex, requestedAmountStr, partialRevealJson);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(intent.maker_pubkey).slice(1))) {
    return jsonResponse({ error: 'invalid fulfilment signature (fulfilment_msg_v2)' }, 403, cors);
  }
  const now = Math.floor(Date.now() / 1000);
  const fulfilment = {
    intent_id: intentIdHex,
    taker_pubkey: takerPubHex,
    partial_reveal: partialReveal,
    fulfilment_sig: sigHex,
    enc_recipient_blinding: encRecipBlindingHex,
    requested_amount: requestedAmountStr,
    commit_tx_hex: commitTxHex,
    envelope_script_hex: envelopeScriptHex,
    control_block_hex: controlBlockHex,
    p2tr_spk_hex: p2trSpkHex,
    state: 'COMMIT_READY',           // PR3 advances to REVEAL_READY → COMMIT_BROADCAST → REVEAL_BROADCAST
    fulfilled_at: now,
  };
  await env.REGISTRY_KV.put(atomicFulfilmentKey(network, assetIdHex, intentIdHex), JSON.stringify(fulfilment));
  return jsonResponse({ ok: true, fulfilment }, 200, cors);
}

async function handleAtomicIntentPost(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  // Dispatch variable-amount publishes (§5.7.6.1) to the dedicated handler.
  // Presence of `min_take_amount` is the discriminator — legacy whole-UTXO
  // publishes omit it and fall through to the existing path unchanged.
  if (body && body.min_take_amount !== undefined && body.min_take_amount !== null && String(body.min_take_amount) !== '') {
    return _handleAtomicIntentPostVar(assetIdHex, body, env, network, cors);
  }

  const intentIdHex = String(body.intent_id ?? '').toLowerCase();
  const makerPubHex = String(body.maker_pubkey ?? '').toLowerCase();
  const makerAddress = String(body.maker_address ?? '');
  const amountStr = String(body.amount ?? '');
  const priceSatsRaw = body.price_sats;
  const expiryRaw = body.expiry;
  const commitTxidHex = String(body.commit_txid ?? '').toLowerCase();
  const commitValueRaw = body.commit_value;
  const p2trSpkHex = String(body.p2tr_spk_hex ?? '').toLowerCase();
  const assetUtxoTxid = String(body.asset_utxo?.txid ?? '').toLowerCase();
  const assetUtxoVout = body.asset_utxo?.vout;
  const assetUtxoValue = body.asset_utxo?.value;
  const ticker = String(body.ticker ?? '');
  const decimals = body.decimals;
  const sigHex = String(body.intent_sig ?? '').toLowerCase();
  // Envelope script + control block are required so the maker can rebuild
  // the script-path witness at fulfilment time. Stored opaquely (the worker
  // doesn't decode them — Bitcoin will when the eventual reveal broadcasts).
  // Generous upper bounds: an aggregated bulletproof at m=1 is ~688 bytes;
  // padded-PUSHDATA framing + payload header runs the envelope to ~830
  // bytes. 4096 hex chars (2048 bytes) is well above that and well below
  // anything that would bloat KV.
  const envelopeScriptHex = String(body.envelope_script_hex ?? '').toLowerCase();
  const controlBlockHex = String(body.control_block_hex ?? '').toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(intentIdHex))             return jsonResponse({ error: 'intent_id must be 32 hex chars (16 bytes)' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(makerPubHex))        return jsonResponse({ error: 'maker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^\d+$/.test(amountStr))                        return jsonResponse({ error: 'amount must be base-10 integer string' }, 400, cors);
  if (!Number.isInteger(priceSatsRaw) || priceSatsRaw < PRICE_MIN) return jsonResponse({ error: `price_sats must be integer ≥ ${PRICE_MIN}` }, 400, cors);
  if (!Number.isInteger(expiryRaw))                    return jsonResponse({ error: 'expiry must be integer unix-seconds' }, 400, cors);
  const now = Math.floor(Date.now() / 1000);
  if (expiryRaw <= now)                                return jsonResponse({ error: 'expiry must be in the future' }, 400, cors);
  if (expiryRaw > now + EXPIRY_MAX_DAYS * 86400)       return jsonResponse({ error: `expiry must be within ${EXPIRY_MAX_DAYS} days` }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(commitTxidHex))           return jsonResponse({ error: 'invalid commit_txid' }, 400, cors);
  if (!Number.isInteger(commitValueRaw) || commitValueRaw < DUST) return jsonResponse({ error: 'invalid commit_value' }, 400, cors);
  if (!/^5120[0-9a-f]{64}$/.test(p2trSpkHex))          return jsonResponse({ error: 'p2tr_spk_hex must be a P2TR scriptPubKey: 34 bytes (51 20 + 32-byte tweaked output key)' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(assetUtxoTxid))           return jsonResponse({ error: 'asset_utxo.txid must be 64 hex chars' }, 400, cors);
  if (!Number.isInteger(assetUtxoVout) || assetUtxoVout < 0) return jsonResponse({ error: 'asset_utxo.vout must be non-negative integer' }, 400, cors);
  if (!Number.isInteger(assetUtxoValue) || assetUtxoValue < DUST) return jsonResponse({ error: 'asset_utxo.value invalid' }, 400, cors);
  if (!makerAddress || makerAddress.length > ADDR_MAX_LEN) return jsonResponse({ error: `maker_address required, ≤ ${ADDR_MAX_LEN} chars` }, 400, cors);
  const decoded = decodeBitcoinAddress(makerAddress);
  if (!decoded || decoded.hrp !== HRP_BY_NETWORK[network]) {
    return jsonResponse({ error: `maker_address must be a ${HRP_BY_NETWORK[network]}… bech32 address` }, 400, cors);
  }
  if (!/^[0-9a-f]{128}$/.test(sigHex))                 return jsonResponse({ error: 'intent_sig must be 128 hex chars' }, 400, cors);
  if (!/^[0-9a-f]+$/.test(envelopeScriptHex) || envelopeScriptHex.length > 4096 || envelopeScriptHex.length < 80) {
    return jsonResponse({ error: 'envelope_script_hex required (40–2048 byte hex string)' }, 400, cors);
  }
  if (!/^[0-9a-f]{66}$/.test(controlBlockHex)) {
    return jsonResponse({ error: 'control_block_hex must be 33-byte hex (parity_byte + 32-byte internal key)' }, 400, cors);
  }
  // Verify intent_id derives from (commit_txid || maker_pubkey).
  const expectedIntentId = bytesToHex(sha256(concatBytes(
    reverseBytes(hexToBytes(commitTxidHex)),
    hexToBytes(makerPubHex),
  ))).slice(0, 32);
  if (intentIdHex !== expectedIntentId) {
    return jsonResponse({ error: 'intent_id does not derive from sha256(commit_txid || maker_pubkey).slice(0, 16)' }, 400, cors);
  }

  // Verify the maker controls the asset UTXO (P2WPKH(hash160(maker_pubkey))).
  let assetTx;
  // Same indexer-race rationale as the commit_txid + taker_utxo paths: the
  // maker may have just received this asset via a private send seconds
  // before publishing an intent, in which case mempool.space's /tx index
  // hasn't caught up. Retry on 404 absorbs ~7s of propagation lag.
  try { assetTx = await fetchFreshTxJson(env, assetUtxoTxid, network); }
  catch (e) { return jsonResponse({ error: 'asset_utxo tx not found after retries: ' + e.message }, 400, cors); }
  const out = assetTx?.vout?.[assetUtxoVout];
  if (!out?.scriptpubkey) return jsonResponse({ error: 'asset_utxo missing scriptpubkey' }, 400, cors);
  const spk = hexToBytes(out.scriptpubkey);
  if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) return jsonResponse({ error: 'asset_utxo not P2WPKH' }, 400, cors);
  if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(hexToBytes(makerPubHex)))) {
    return jsonResponse({ error: 'maker_pubkey does not control the asset UTXO' }, 403, cors);
  }
  // Verify the asset UTXO's parent envelope declares the same asset_id.
  let resolved;
  try { resolved = await commitmentForUtxo(env, assetUtxoTxid, assetUtxoVout, network); }
  catch (e) { return jsonResponse({ error: 'commitment lookup failed: ' + e.message }, 400, cors); }
  if (resolved.asset_id !== assetIdHex) {
    return jsonResponse({ error: 'asset_utxo is for a different asset' }, 400, cors);
  }
  // Verify the intent_sig.
  const msg = atomicIntentMsg(assetIdHex, intentIdHex, makerPubHex, amountStr, priceSatsRaw, expiryRaw, commitTxidHex, assetUtxoTxid, assetUtxoVout);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(makerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid intent signature' }, 403, cors);
  }

  // Structural binding of the envelope script. The worker can't bind the
  // (amount, blinding) opening since it never sees `r`, but it can confirm
  // the envelope is the right shape for an atomic-intent settlement: T_AXFER
  // opcode, single asset input, single tacit output, asset_id matches the
  // intent. Without this, a maker could publish an envelope that's a CXFER
  // or a different asset and have it accepted; the eventual reveal would
  // fail to relay, but a claimant would have already wasted a 5-min lock.
  let env_decoded;
  try { env_decoded = decodeEnvelopeScript(hexToBytes(envelopeScriptHex)); }
  catch (e) { return jsonResponse({ error: 'envelope_script_hex decode threw: ' + e.message }, 400, cors); }
  if (!env_decoded) return jsonResponse({ error: 'envelope_script_hex is structurally invalid' }, 400, cors);
  if (env_decoded.opcode !== T_AXFER) return jsonResponse({ error: `envelope opcode 0x${env_decoded.opcode.toString(16)} != T_AXFER (0x26)` }, 400, cors);
  const ax = decodeAxferPayload(env_decoded.payload);
  if (!ax) return jsonResponse({ error: 'T_AXFER payload decode failed' }, 400, cors);
  if (ax.asset_input_count !== 1) return jsonResponse({ error: `asset_input_count must be 1 for atomic intent (got ${ax.asset_input_count})` }, 400, cors);
  if (ax.outputs.length !== 1) return jsonResponse({ error: `expected exactly 1 tacit output (got ${ax.outputs.length})` }, 400, cors);
  if (ax.asset_id !== assetIdHex) {
    return jsonResponse({ error: 'envelope.asset_id does not match URL asset_id' }, 400, cors);
  }

  // Bind the published p2tr_spk to the actual on-chain commit_txid:0. Without
  // this, a maker could point at any commit; the take would only fail at
  // Bitcoin relay time. We fetch the commit tx and compare scripts byte-wise.
  // Use fetchFreshTxJson so a propagation race between the dApp's broadcast
  // and the mempool.space index doesn't fail-close a perfectly valid post
  // (the worker would otherwise return 400 for a 1–10s indexer lag).
  let commitTx;
  try { commitTx = await fetchFreshTxJson(env, commitTxidHex, network); }
  catch (e) { return jsonResponse({ error: 'commit_txid not found on chain after retries: ' + e.message }, 400, cors); }
  const commitVout0 = commitTx?.vout?.[0];
  if (!commitVout0?.scriptpubkey) return jsonResponse({ error: 'commit tx vout[0] missing scriptpubkey' }, 400, cors);
  if (commitVout0.scriptpubkey.toLowerCase() !== p2trSpkHex) {
    return jsonResponse({ error: 'commit_txid vout[0] scriptpubkey does not match p2tr_spk_hex' }, 400, cors);
  }
  if (commitVout0.value !== commitValueRaw) {
    return jsonResponse({ error: `commit_value mismatch (declared ${commitValueRaw}, on-chain ${commitVout0.value})` }, 400, cors);
  }

  const intent = {
    asset_id: assetIdHex,
    intent_id: intentIdHex,
    maker_pubkey: makerPubHex,
    maker_address: makerAddress,
    amount: amountStr,
    price_sats: priceSatsRaw,
    expiry: expiryRaw,
    commit_txid: commitTxidHex,
    commit_value: commitValueRaw,
    p2tr_spk_hex: p2trSpkHex,
    asset_utxo: { txid: assetUtxoTxid, vout: assetUtxoVout, value: assetUtxoValue },
    ticker: ticker || '',
    decimals: Number.isInteger(decimals) ? decimals : 0,
    envelope_script_hex: envelopeScriptHex,
    control_block_hex: controlBlockHex,
    intent_sig: sigHex,
    created_at: now,
    network,
  };
  await env.REGISTRY_KV.put(atomicIntentKey(network, assetIdHex, intentIdHex), JSON.stringify(intent));
  return jsonResponse({ ok: true, intent }, 200, cors);
}

async function loadAtomicIntentsForAsset(env, network, assetIdHex) {
  const list = await env.REGISTRY_KV.list({ prefix: atomicIntentPrefix(network, assetIdHex), limit: 1000 });
  const now = Math.floor(Date.now() / 1000);
  // intent_id is the last `:`-separated segment of the KV key (see
  // atomicIntentKey). Parsing it from the key lets us issue intent + claim
  // + fulfilment fetches in one fan-out instead of two phases — saves one
  // round-trip's latency on the hot Market path.
  const triples = await Promise.all(list.keys.map(async k => {
    const intentIdHex = k.name.slice(k.name.lastIndexOf(':') + 1);
    if (!/^[0-9a-f]{32}$/.test(intentIdHex)) return null;
    const [intent, claim, fulfil] = await Promise.all([
      env.REGISTRY_KV.get(k.name, 'json'),
      env.REGISTRY_KV.get(atomicClaimKey(network, assetIdHex, intentIdHex), 'json'),
      env.REGISTRY_KV.get(atomicFulfilmentKey(network, assetIdHex, intentIdHex), 'json'),
    ]);
    if (!intent) return null;
    return { intent, claim, fulfil, intentIdHex };
  }));
  const intents = [];
  for (const t of triples) {
    if (!t) continue;
    const v = t.intent;
    v.expired = (v.expiry || 0) <= now;
    if (t.claim && t.claim.expires_at > now) v.claim = t.claim;
    if (t.fulfil) {
      const fulfilledAt = Number(t.fulfil.fulfilled_at) || 0;
      if (fulfilledAt && (now - fulfilledAt) > FULFILMENT_TTL_SECONDS) {
        // GC: lazy cleanup on read. Fire-and-forget, no await — we don't need
        // the delete to land before responding, and deferring keeps the read
        // path cheap.
        env.REGISTRY_KV.delete(atomicFulfilmentKey(network, assetIdHex, t.intentIdHex)).catch(() => {});
      } else {
        v.fulfilment_pending = true; // don't include the partial reveal here; it's a separate fetch
        v.fulfilled_at = fulfilledAt;
      }
    }
    intents.push(v);
  }
  intents.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return intents;
}

async function handleAtomicIntentList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const intents = await loadAtomicIntentsForAsset(env, network, assetIdHex);
  return jsonResponse({ asset_id: assetIdHex, count: intents.length, intents }, 200, cors);
}

async function handleAtomicIntentDelete(assetIdHex, intentIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(intentIdHex)) return jsonResponse({ error: 'invalid intent_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const cancelSigHex = String(body.cancel_sig ?? '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(cancelSigHex)) return jsonResponse({ error: 'cancel_sig must be 128 hex chars' }, 400, cors);
  const stored = await env.REGISTRY_KV.get(atomicIntentKey(network, assetIdHex, intentIdHex), 'json');
  if (!stored) return jsonResponse({ error: 'no intent found' }, 404, cors);
  const msg = atomicIntentCancelMsg(assetIdHex, intentIdHex);
  if (!verifySchnorr(hexToBytes(cancelSigHex), msg, hexToBytes(stored.maker_pubkey).slice(1))) {
    return jsonResponse({ error: 'invalid cancel signature' }, 403, cors);
  }
  await env.REGISTRY_KV.delete(atomicIntentKey(network, assetIdHex, intentIdHex));
  await env.REGISTRY_KV.delete(atomicClaimKey(network, assetIdHex, intentIdHex));
  await env.REGISTRY_KV.delete(atomicFulfilmentKey(network, assetIdHex, intentIdHex));
  return jsonResponse({ ok: true }, 200, cors);
}

async function handleAtomicIntentClaim(assetIdHex, intentIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(intentIdHex)) return jsonResponse({ error: 'invalid intent_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const takerPubHex = String(body.taker_pubkey ?? '').toLowerCase();
  const sigHex = String(body.sig ?? '').toLowerCase();
  // v2 claims commit to a sat UTXO ≥ price_sats so the worker can attest
  // proof-of-funds at claim time. Without this any pubkey could free-claim
  // and lock an intent for the full CLAIM_TTL window.
  const takerUtxoTxid = String(body.taker_utxo?.txid ?? '').toLowerCase();
  const takerUtxoVout = body.taker_utxo?.vout;
  if (!/^0[23][0-9a-f]{64}$/.test(takerPubHex)) return jsonResponse({ error: 'taker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))          return jsonResponse({ error: 'sig must be 128 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(takerUtxoTxid))    return jsonResponse({ error: 'taker_utxo.txid must be 64 hex chars' }, 400, cors);
  if (!Number.isInteger(takerUtxoVout) || takerUtxoVout < 0 || takerUtxoVout > 0xffff) {
    return jsonResponse({ error: 'taker_utxo.vout must be non-negative integer' }, 400, cors);
  }

  const intent = await env.REGISTRY_KV.get(atomicIntentKey(network, assetIdHex, intentIdHex), 'json');
  if (!intent) return jsonResponse({ error: 'no such intent' }, 404, cors);
  const now = Math.floor(Date.now() / 1000);
  if ((intent.expiry || 0) <= now) return jsonResponse({ error: 'intent expired' }, 410, cors);

  // Reject if there's an unexpired claim by a different taker.
  const existing = await env.REGISTRY_KV.get(atomicClaimKey(network, assetIdHex, intentIdHex), 'json');
  if (existing && existing.expires_at > now && existing.taker_pubkey !== takerPubHex) {
    return jsonResponse({
      error: 'intent already claimed',
      claim: { expires_at: existing.expires_at },
    }, 409, cors);
  }

  // Dispatch variable-amount claims (§5.7.6.1) to the dedicated handler. The
  // intent's `min_take_amount` field is the discriminator — legacy intents
  // omit it and fall through to the existing path. A taker who tries to
  // submit a `requested_amount` against a legacy intent is rejected here
  // (claim_msg_v3 won't verify against a v2 sig), surfacing as a "invalid
  // signature" 403 rather than a silent semantic mismatch.
  if (intent.min_take_amount !== undefined && intent.min_take_amount !== null && String(intent.min_take_amount) !== '') {
    return _handleAtomicIntentClaimVar(assetIdHex, intentIdHex, intent, body, env, network, cors);
  }

  // Verify the committed UTXO: exists on chain, P2WPKH-controlled by the
  // claimant, and value ≥ intent.price_sats. Same defensive pattern as
  // handleAtomicIntentPost uses for the maker's asset_utxo. We do not lock
  // the UTXO — taker may spend it before fulfilment, that's their risk —
  // but at claim time they had to actually have the funds.
  let takerTx;
  // Use fetchFreshTxJson rather than apiJson: takers often top up their sat
  // balance from a faucet or external send specifically to claim a hot
  // intent, so the taker_utxo can be very recently confirmed and hit the
  // mempool.space indexer-lag race we fixed for commit_txid (see
  // handleAtomicIntentPost). Retrying on 404 absorbs ~7s of propagation
  // lag instead of failing the claim and forcing the user to wait + retry.
  try { takerTx = await fetchFreshTxJson(env, takerUtxoTxid, network); }
  catch (e) { return jsonResponse({ error: 'taker_utxo tx not found after retries: ' + e.message }, 400, cors); }
  const takerOut = takerTx?.vout?.[takerUtxoVout];
  if (!takerOut?.scriptpubkey) return jsonResponse({ error: 'taker_utxo missing scriptpubkey' }, 400, cors);
  const spk = hexToBytes(takerOut.scriptpubkey);
  if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
    return jsonResponse({ error: 'taker_utxo not P2WPKH' }, 400, cors);
  }
  if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(hexToBytes(takerPubHex)))) {
    return jsonResponse({ error: 'taker_pubkey does not control taker_utxo' }, 403, cors);
  }
  const priceSats = Number(intent.price_sats);
  const utxoValue = Number(takerOut.value);
  if (!Number.isInteger(utxoValue) || utxoValue < priceSats) {
    return jsonResponse({ error: `taker_utxo value (${utxoValue}) is below price_sats (${priceSats})` }, 400, cors);
  }

  const msg = atomicIntentClaimMsg(assetIdHex, intentIdHex, takerPubHex, takerUtxoTxid, takerUtxoVout);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(takerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid taker signature' }, 403, cors);
  }
  const claim = {
    intent_id: intentIdHex,
    taker_pubkey: takerPubHex,
    taker_utxo: { txid: takerUtxoTxid, vout: takerUtxoVout, value: utxoValue },
    sig: sigHex,
    claimed_at: now,
    expires_at: now + CLAIM_TTL_SECONDS,
  };
  // Auto-expire the claim record at the TTL deadline so KV doesn't accumulate
  // dead reservations. A small buffer (60s) absorbs clock skew between CF
  // edges and ensures readers within the TTL window always see the claim.
  await env.REGISTRY_KV.put(
    atomicClaimKey(network, assetIdHex, intentIdHex),
    JSON.stringify(claim),
    { expirationTtl: CLAIM_TTL_SECONDS + 60 },
  );
  return jsonResponse({ ok: true, claim, intent }, 200, cors);
}

async function handleAtomicIntentFulfil(assetIdHex, intentIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(intentIdHex)) return jsonResponse({ error: 'invalid intent_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const takerPubHex = String(body.taker_pubkey ?? '').toLowerCase();
  const partialReveal = body.partial_reveal;
  const sigHex = String(body.fulfilment_sig ?? '').toLowerCase();
  // 32-byte ECDH-encrypted recipient blinding `r XOR keystream(maker.priv,
  // taker.pub, intent_id, asset_id)`. Worker stores it opaquely; only the
  // claimant can decrypt with their priv. Refuse fulfilments without it —
  // older clients that omit this field would ship blinding cleartext via
  // the obsolete intent.recipient_blinding path, leaking amounts to anyone
  // watching the marketplace.
  const encRecipBlindingHex = String(body.enc_recipient_blinding ?? '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(takerPubHex)) return jsonResponse({ error: 'taker_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (typeof partialReveal !== 'object' || partialReveal === null) return jsonResponse({ error: 'partial_reveal must be a JSON object' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return jsonResponse({ error: 'fulfilment_sig must be 128 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(encRecipBlindingHex)) return jsonResponse({ error: 'enc_recipient_blinding must be 64 hex chars (32-byte ciphertext)' }, 400, cors);

  const intent = await env.REGISTRY_KV.get(atomicIntentKey(network, assetIdHex, intentIdHex), 'json');
  if (!intent) return jsonResponse({ error: 'no such intent' }, 404, cors);
  const claim = await env.REGISTRY_KV.get(atomicClaimKey(network, assetIdHex, intentIdHex), 'json');
  const now = Math.floor(Date.now() / 1000);
  if (!claim || claim.expires_at <= now) return jsonResponse({ error: 'no active claim' }, 404, cors);
  if (claim.taker_pubkey !== takerPubHex) return jsonResponse({ error: 'taker_pubkey does not match claim' }, 403, cors);

  // Dispatch variable-amount fulfilments (§5.7.6.1) to the dedicated handler.
  // The intent's `min_take_amount` is the discriminator — a v1 fulfilment POST
  // against a variable-amount intent would silently store a v1-shaped record
  // and later confuse the broadcast path, so we branch here before parsing
  // any of the legacy-only fields.
  if (intent.min_take_amount !== undefined && intent.min_take_amount !== null && String(intent.min_take_amount) !== '') {
    return _handleAtomicIntentFulfilVar(assetIdHex, intentIdHex, intent, claim, body, env, network, cors);
  }

  // Verify the maker (== owner of intent) signed the fulfilment.
  const partialRevealJson = JSON.stringify(partialReveal);
  const msg = atomicIntentFulfilmentMsg(assetIdHex, intentIdHex, takerPubHex, partialRevealJson);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(intent.maker_pubkey).slice(1))) {
    return jsonResponse({ error: 'invalid fulfilment signature (must be signed by the intent maker)' }, 403, cors);
  }
  const fulfilment = {
    intent_id: intentIdHex,
    taker_pubkey: takerPubHex,
    partial_reveal: partialReveal,
    fulfilment_sig: sigHex,
    enc_recipient_blinding: encRecipBlindingHex,
    fulfilled_at: now,
  };
  await env.REGISTRY_KV.put(atomicFulfilmentKey(network, assetIdHex, intentIdHex), JSON.stringify(fulfilment));
  return jsonResponse({ ok: true, fulfilment }, 200, cors);
}

async function handleAtomicIntentFulfilGet(assetIdHex, intentIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(intentIdHex)) return jsonResponse({ error: 'invalid intent_id' }, 400, cors);
  const fulfilment = await env.REGISTRY_KV.get(atomicFulfilmentKey(network, assetIdHex, intentIdHex), 'json');
  if (!fulfilment) return jsonResponse({ error: 'fulfilment not yet posted' }, 404, cors);
  const now = Math.floor(Date.now() / 1000);
  const fulfilledAt = Number(fulfilment.fulfilled_at) || 0;
  if (fulfilledAt && (now - fulfilledAt) > FULFILMENT_TTL_SECONDS) {
    // Stale: GC lazily and treat as "not yet posted" so the maker can re-fulfil.
    env.REGISTRY_KV.delete(atomicFulfilmentKey(network, assetIdHex, intentIdHex)).catch(() => {});
    return jsonResponse({ error: 'fulfilment expired (stale beyond TTL); maker should re-fulfil for an active claim' }, 410, cors);
  }
  const intent = await env.REGISTRY_KV.get(atomicIntentKey(network, assetIdHex, intentIdHex), 'json');
  return jsonResponse({ ok: true, fulfilment, intent }, 200, cors);
}

// ============== PREAUTH SALE HANDLERS (SPEC §5.7.8) ==============
// Validation flow mirrors handleAtomicIntentPost / handleListingPost: shape
// checks first, then chain-state checks, then signature verifications, then
// the new piece — reconstruct the BIP-143 sighash from the sale-auth body
// and ECDSA-verify the seller_asset_spend signature against it.

async function handlePreauthSalePost(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const sellerPubHex = String(body.seller_pubkey ?? '').toLowerCase();
  const assetOutpoint = body.asset_outpoint;
  const assetOutpointTxidHex = String(assetOutpoint?.txid ?? '').toLowerCase();
  const assetOutpointVoutRaw = assetOutpoint?.vout;
  const assetUtxoValueRaw = assetOutpoint?.value;
  const assetOpening = body.asset_opening;
  const amountStr = String(assetOpening?.amount ?? '');
  const blindingHex = String(assetOpening?.blinding ?? '').toLowerCase();
  const minPriceSatsRaw = body.min_price_sats;
  const sellerPayoutScriptHex = String(body.seller_payout_script ?? '').toLowerCase();
  const sellerPayoutAddress = String(body.seller_payout_address ?? '');
  const expiryRaw = body.expiry;
  const sellerAssetSpendSigHex = String(body.seller_asset_spend_sig ?? '').toLowerCase();
  const nonceHex = String(body.nonce ?? '').toLowerCase();
  const authSigHex = String(body.auth_sig ?? '').toLowerCase();
  const ticker = String(body.ticker ?? '');
  const decimals = body.decimals;

  // ---------- shape checks ----------
  if (!/^0[23][0-9a-f]{64}$/.test(sellerPubHex))         return jsonResponse({ error: 'seller_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(assetOutpointTxidHex))      return jsonResponse({ error: 'asset_outpoint.txid must be 64 hex chars' }, 400, cors);
  if (!Number.isInteger(assetOutpointVoutRaw) || assetOutpointVoutRaw < 0 || assetOutpointVoutRaw > 0xffff) {
    return jsonResponse({ error: 'asset_outpoint.vout must be a u16 integer' }, 400, cors);
  }
  if (!Number.isInteger(assetUtxoValueRaw) || assetUtxoValueRaw < DUST) {
    return jsonResponse({ error: `asset_outpoint.value must be integer ≥ ${DUST}` }, 400, cors);
  }
  if (!/^\d+$/.test(amountStr))                          return jsonResponse({ error: 'asset_opening.amount must be base-10 integer string' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(blindingHex))               return jsonResponse({ error: 'asset_opening.blinding must be 64 hex chars' }, 400, cors);
  if (!Number.isInteger(minPriceSatsRaw) || minPriceSatsRaw < PRICE_MIN || minPriceSatsRaw > Number.MAX_SAFE_INTEGER) {
    return jsonResponse({ error: `min_price_sats must be integer ≥ ${PRICE_MIN}` }, 400, cors);
  }
  // P2WPKH or P2TR payout scripts only at v1: 22 bytes (0014 + 20B hash160) or
  // 34 bytes (5120 + 32B tweaked output key). Both are universal-relay; other
  // scripts (P2SH, P2PKH legacy, bare scripts) are deferred until the dApp's
  // tx builder can construct + sign them on the buyer side.
  if (!(/^0014[0-9a-f]{40}$/.test(sellerPayoutScriptHex) || /^5120[0-9a-f]{64}$/.test(sellerPayoutScriptHex))) {
    return jsonResponse({ error: 'seller_payout_script must be P2WPKH (0014…) or P2TR (5120…) hex' }, 400, cors);
  }
  if (!Number.isInteger(expiryRaw))                      return jsonResponse({ error: 'expiry must be integer unix-seconds' }, 400, cors);
  const now = Math.floor(Date.now() / 1000);
  if (expiryRaw <= now)                                  return jsonResponse({ error: 'expiry must be in the future' }, 400, cors);
  if (expiryRaw > now + EXPIRY_MAX_DAYS * 86400)         return jsonResponse({ error: `expiry must be within ${EXPIRY_MAX_DAYS} days` }, 400, cors);
  // DER (≤72B) + 1B sighash flag → 8..73 bytes = 16..146 hex chars.
  if (!/^[0-9a-f]+$/.test(sellerAssetSpendSigHex) || sellerAssetSpendSigHex.length < 16 || sellerAssetSpendSigHex.length > 146) {
    return jsonResponse({ error: 'seller_asset_spend_sig must be DER+sighash hex (16–146 chars)' }, 400, cors);
  }
  if (!sellerAssetSpendSigHex.endsWith('83')) {
    return jsonResponse({ error: 'seller_asset_spend_sig must end with sighash byte 0x83 (SIGHASH_SINGLE|ANYONECANPAY)' }, 400, cors);
  }
  if (!/^[0-9a-f]{32}$/.test(nonceHex))                  return jsonResponse({ error: 'nonce must be 32 hex chars (16 bytes)' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(authSigHex))               return jsonResponse({ error: 'auth_sig must be 128 hex chars' }, 400, cors);
  if (sellerPayoutAddress.length > ADDR_MAX_LEN)         return jsonResponse({ error: `seller_payout_address must be ≤ ${ADDR_MAX_LEN} chars` }, 400, cors);
  // Address is optional (script is the load-bearing field) but if present it
  // must match the network so client display stays consistent.
  if (sellerPayoutAddress) {
    const decoded = decodeBitcoinAddress(sellerPayoutAddress);
    if (!decoded || decoded.hrp !== HRP_BY_NETWORK[network]) {
      return jsonResponse({ error: `seller_payout_address must be a ${HRP_BY_NETWORK[network]}… bech32 address` }, 400, cors);
    }
  }

  // sale_id must derive from (outpoint, seller, nonce) per SPEC §5.7.8.
  const expectedSaleIdHex = preauthSaleIdHex(assetOutpointTxidHex, assetOutpointVoutRaw, sellerPubHex, nonceHex);
  const saleIdHex = String(body.sale_id ?? '').toLowerCase();
  if (saleIdHex !== expectedSaleIdHex) {
    return jsonResponse({ error: 'sale_id does not derive from (asset_outpoint, seller_pubkey, nonce)' }, 400, cors);
  }

  // ---------- chain-state checks ----------
  // The seller must control the asset outpoint as P2WPKH(hash160(seller_pubkey)).
  let assetTx;
  try { assetTx = await fetchFreshTxJson(env, assetOutpointTxidHex, network); }
  catch (e) { return jsonResponse({ error: 'asset outpoint tx not found after retries: ' + e.message }, 400, cors); }
  const out = assetTx?.vout?.[assetOutpointVoutRaw];
  if (!out?.scriptpubkey) return jsonResponse({ error: 'asset outpoint missing scriptpubkey' }, 400, cors);
  const spk = hexToBytes(out.scriptpubkey);
  if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
    return jsonResponse({ error: 'asset outpoint is not P2WPKH' }, 400, cors);
  }
  if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(hexToBytes(sellerPubHex)))) {
    return jsonResponse({ error: 'seller_pubkey does not control the asset outpoint' }, 403, cors);
  }
  if (out.value !== assetUtxoValueRaw) {
    return jsonResponse({ error: `asset_outpoint.value mismatch (declared ${assetUtxoValueRaw}, on-chain ${out.value})` }, 400, cors);
  }
  // Outpoint must currently be unspent.
  let outspend;
  try { outspend = await apiJson(env, `/tx/${assetOutpointTxidHex}/outspend/${assetOutpointVoutRaw}`, {}, network); }
  catch { outspend = null; }
  if (outspend && outspend.spent) {
    return jsonResponse({ error: 'asset outpoint is already spent' }, 409, cors);
  }

  // Asset outpoint must be a tacit UTXO of the declared asset_id. Mirrors
  // handleListingPost / handleAtomicIntentPost path via commitmentForUtxo.
  let resolved;
  try { resolved = await commitmentForUtxo(env, assetOutpointTxidHex, assetOutpointVoutRaw, network); }
  catch (e) { return jsonResponse({ error: 'commitment lookup failed: ' + e.message }, 400, cors); }
  if (resolved.asset_id !== assetIdHex) {
    return jsonResponse({ error: 'asset outpoint is for a different asset' }, 400, cors);
  }

  // Pedersen opening must commit to the on-chain commitment for that outpoint.
  let amount;
  try { amount = BigInt(amountStr); } catch { return jsonResponse({ error: 'unparseable amount' }, 400, cors); }
  if (amount < 0n || amount >= (1n << BigInt(N_BITS))) {
    return jsonResponse({ error: `amount must be in [0, 2^${N_BITS})` }, 400, cors);
  }
  let claimed, onchain;
  try {
    claimed = pedersenCommit(amount, BigInt('0x' + blindingHex));
    onchain = compressedPointFromHex(resolved.commitment);
  } catch (e) {
    return jsonResponse({ error: 'commitment math failed: ' + e.message }, 400, cors);
  }
  if (!claimed.equals(onchain)) {
    return jsonResponse({ error: 'asset_opening does not match on-chain commitment' }, 400, cors);
  }

  // ---------- signature checks ----------
  // Seller's BIP-340 auth signature covers the whole sale-auth body.
  const authMsg = preauthSaleAuthMsg({
    assetIdHex, saleIdHex, sellerPubHex,
    assetOutpointTxidHex, assetOutpointVout: assetOutpointVoutRaw,
    assetUtxoValue: assetUtxoValueRaw,
    amountStr, blindingHex,
    minPriceSats: minPriceSatsRaw,
    sellerPayoutScriptHex,
    expiry: expiryRaw,
    sellerAssetSpendSigHex,
    nonceHex,
  });
  if (!verifySchnorr(hexToBytes(authSigHex), authMsg, hexToBytes(sellerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid auth signature' }, 403, cors);
  }

  // Seller's pre-signed P2WPKH spend: ECDSA over the BIP-143 sighash that
  // binds vin[1] (asset outpoint) to vout[1] (payout). Reconstruct the
  // sighash from the same fields the seller signed; reject if the signature
  // doesn't verify against this preimage under seller_pubkey.
  const spendSigBytes = hexToBytes(sellerAssetSpendSigHex);
  const spendDer = spendSigBytes.slice(0, spendSigBytes.length - 1);
  const sighash = preauthSellerSpendSighash({
    assetOutpointTxidHex, assetOutpointVout: assetOutpointVoutRaw,
    assetUtxoValue: assetUtxoValueRaw,
    sellerPubHex, sellerPayoutScriptHex,
    minPriceSats: minPriceSatsRaw,
  });
  if (!verifyEcdsaDerSig(spendDer, sighash, hexToBytes(sellerPubHex))) {
    return jsonResponse({ error: 'seller_asset_spend_sig does not verify against the BIP-143 sighash' }, 403, cors);
  }

  // ---------- one-live-sale-per-outpoint ----------
  // Check the outpoint index BEFORE the main record so a duplicate doesn't
  // leak a partial KV write. KV's eventual consistency means two near-
  // simultaneous POSTs could race past this check; the dApp side handles the
  // 409 path on the second insert by reading back the existing sale_id.
  const existingSaleIdHex = await env.REGISTRY_KV.get(
    preauthOutpointIndexKey(network, assetIdHex, assetOutpointTxidHex, assetOutpointVoutRaw),
  );
  if (existingSaleIdHex) {
    return jsonResponse({
      error: 'a live preauth-sale already exists for this asset_outpoint; cancel it first',
      existing_sale_id: existingSaleIdHex,
    }, 409, cors);
  }

  const sale = {
    asset_id: assetIdHex,
    sale_id: saleIdHex,
    seller_pubkey: sellerPubHex,
    seller_payout_script: sellerPayoutScriptHex,
    seller_payout_address: sellerPayoutAddress || '',
    asset_outpoint: { txid: assetOutpointTxidHex, vout: assetOutpointVoutRaw, value: assetUtxoValueRaw },
    asset_opening: { amount: amountStr, blinding: blindingHex },
    min_price_sats: minPriceSatsRaw,
    expiry: expiryRaw,
    seller_asset_spend_sig: sellerAssetSpendSigHex,
    nonce: nonceHex,
    auth_sig: authSigHex,
    ticker: ticker || '',
    decimals: Number.isInteger(decimals) ? decimals : 0,
    created_at: now,
    network,
  };
  await env.REGISTRY_KV.put(preauthSaleKey(network, assetIdHex, saleIdHex), JSON.stringify(sale));
  await env.REGISTRY_KV.put(
    preauthOutpointIndexKey(network, assetIdHex, assetOutpointTxidHex, assetOutpointVoutRaw),
    saleIdHex,
  );
  return jsonResponse({ ok: true, sale }, 200, cors);
}

async function loadPreauthSalesForAsset(env, network, assetIdHex) {
  const list = await env.REGISTRY_KV.list({ prefix: preauthSalePrefix(network, assetIdHex), limit: 1000 });
  const now = Math.floor(Date.now() / 1000);
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const sales = [];
  for (const v of fetched) {
    if (!v) continue;
    v.expired = (v.expiry || 0) <= now;
    sales.push(v);
  }
  sales.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return sales;
}

async function handlePreauthSaleList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const sales = await loadPreauthSalesForAsset(env, network, assetIdHex);
  return jsonResponse({ asset_id: assetIdHex, count: sales.length, sales }, 200, cors);
}

async function handlePreauthSaleGet(assetIdHex, saleIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(saleIdHex)) return jsonResponse({ error: 'invalid sale_id' }, 400, cors);
  const sale = await env.REGISTRY_KV.get(preauthSaleKey(network, assetIdHex, saleIdHex), 'json');
  if (!sale) return jsonResponse({ error: 'no sale found' }, 404, cors);
  const now = Math.floor(Date.now() / 1000);
  sale.expired = (sale.expiry || 0) <= now;
  return jsonResponse({ ok: true, sale }, 200, cors);
}

async function handlePreauthSaleDelete(assetIdHex, saleIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(saleIdHex)) return jsonResponse({ error: 'invalid sale_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const cancelSigHex = String(body.cancel_sig ?? '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(cancelSigHex)) return jsonResponse({ error: 'cancel_sig must be 128 hex chars' }, 400, cors);
  const stored = await env.REGISTRY_KV.get(preauthSaleKey(network, assetIdHex, saleIdHex), 'json');
  if (!stored) return jsonResponse({ error: 'no sale found' }, 404, cors);
  const msg = preauthSaleCancelMsg(assetIdHex, saleIdHex);
  if (!verifySchnorr(hexToBytes(cancelSigHex), msg, hexToBytes(stored.seller_pubkey).slice(1))) {
    return jsonResponse({ error: 'invalid cancel signature' }, 403, cors);
  }
  await env.REGISTRY_KV.delete(preauthSaleKey(network, assetIdHex, saleIdHex));
  await env.REGISTRY_KV.delete(preauthOutpointIndexKey(
    network, assetIdHex, stored.asset_outpoint.txid, stored.asset_outpoint.vout,
  ));
  return jsonResponse({ ok: true }, 200, cors);
}

// ============== AIRDROP CLAIM QUEUE ==============
// Recipients submit signed claim tuples here; issuers pull them in batches.
// The worker performs format validation only — it doesn't have the snapshot
// rows, so it can't (and doesn't try to) verify the merkle proof or the eth
// signature. The issuer's dapp re-verifies before broadcast. Worker is dumb
// dropbox; the canonical truth is on-chain after fulfilment.
//
// KV layout:
//   airdrop:claim:<root>:<padded_leaf_index>             (signet, legacy unprefixed)
//   airdrop:claim:<network>:<root>:<padded_leaf_index>   (other networks)
// One record per leaf_index per drop. Re-submission overwrites (latest wins),
// so a recipient who switches tacit identities can re-sign without manual
// cleanup.
//
// Format limits:
//   - leaf_index: 0 ≤ idx < 2^32 (4_294_967_296). Bounds the KV key space.
//   - tacit_pubkey: 33-byte compressed (66 hex chars, 02/03 prefix).
//   - eth_sig:     65 bytes (130 hex chars, 0x prefix optional).
const AIRDROP_LEAF_INDEX_MAX = 0xffffffff;
const AIRDROP_LIST_PAGE = 1000;     // KV's max per call
// 90-day TTL on claim records. Bounds stale entries when issuers abandon a
// drop and limits the attack surface of an unauthenticated DELETE: legitimate
// recipients re-POST during fulfilment, attackers must keep wiping under the
// per-IP rate limit, and any drop that hasn't fulfilled in 90 days is
// effectively dead anyway.
const AIRDROP_CLAIM_TTL_SECONDS = 90 * 24 * 3600;
// Each returned claim costs one KV.get subrequest. CF Workers paid plan caps
// at 1000 subrequests per invocation; the cap below keeps us comfortably
// under that ceiling. The dapp's pull loop paginates via PAGE_GUARD_CAP=16,
// so this per-call cap is invisible in normal use.
const AIRDROP_LIST_HARD_CAP = 900;  // total per response; bound size + subrequest cost

// Layered daily rate limit for airdrop-claim POST and DELETE. Without this an
// attacker could fill KV with junk submissions for any root, or wipe a
// recipient's submission before the issuer pulls.
//
// Four counters compose:
//   1. ip-global: per-IP, all drops combined. Generous so legitimate
//      recipients who claim from multiple drops aren't throttled.
//   2. pk-global: per tacit-pubkey, all drops. Forces a determined attacker
//      to rotate tacit keys as well as IPs (mirrors /drops posture).
//   3. ip-per-root: per-IP within a single drop. Scopes a targeted attack
//      against one drop — without this, an attacker could burn the global
//      limit on a single root and prevent legitimate claimants from there.
//   4. pk-per-root: per tacit-pubkey within a single drop. Stops a single
//      identity from spamming many leaves in one drop.
//
// DELETE only checks ip-global + ip-per-root (no signed pubkey to bind).
async function _airdropRateLimit(req, env, tacitPubHex, rootHex) {
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `airdrop-rl:ip:${day}:${ip}`;
  const ipLimit = safeInt(env.AIRDROP_DAILY_LIMIT, 200, { min: 1 });
  const ipPrior = safeInt(await env.REGISTRY_KV.get(ipKey), 0, { min: 0 });
  if (ipPrior >= ipLimit) return { ok: false, reason: `IP daily limit (${ipLimit}/day)` };
  // Per-root + IP: scopes per-drop abuse without throttling cross-drop use.
  // Default 50/day/IP/drop covers re-sign churn (account swap, retry) on a
  // single drop without enabling fill-the-queue attacks.
  let ipRootKey = null;
  let ipRootPrior = 0;
  if (rootHex) {
    ipRootKey = `airdrop-rl:root-ip:${day}:${rootHex}:${ip}`;
    const ipRootLimit = safeInt(env.AIRDROP_DAILY_LIMIT_ROOT_IP, 50, { min: 1 });
    ipRootPrior = safeInt(await env.REGISTRY_KV.get(ipRootKey), 0, { min: 0 });
    if (ipRootPrior >= ipRootLimit) return { ok: false, reason: `per-drop IP limit (${ipRootLimit}/day)` };
  }
  let pkKey = null;
  let pkPrior = 0;
  let pkRootKey = null;
  let pkRootPrior = 0;
  if (tacitPubHex) {
    pkKey = `airdrop-rl:pk:${day}:${tacitPubHex}`;
    const pkLimit = safeInt(env.AIRDROP_DAILY_LIMIT_PUBKEY, 50, { min: 1 });
    pkPrior = safeInt(await env.REGISTRY_KV.get(pkKey), 0, { min: 0 });
    if (pkPrior >= pkLimit) return { ok: false, reason: `pubkey daily limit (${pkLimit}/day)` };
    if (rootHex) {
      pkRootKey = `airdrop-rl:root-pk:${day}:${rootHex}:${tacitPubHex}`;
      const pkRootLimit = safeInt(env.AIRDROP_DAILY_LIMIT_ROOT_PUBKEY, 25, { min: 1 });
      pkRootPrior = safeInt(await env.REGISTRY_KV.get(pkRootKey), 0, { min: 0 });
      if (pkRootPrior >= pkRootLimit) return { ok: false, reason: `per-drop pubkey limit (${pkRootLimit}/day)` };
    }
  }
  // Commit counters only after every gate has passed so a rejection upstream
  // doesn't burn slots on the limits downstream of it.
  await env.REGISTRY_KV.put(ipKey, String(ipPrior + 1), { expirationTtl: 90000 });
  if (ipRootKey) await env.REGISTRY_KV.put(ipRootKey, String(ipRootPrior + 1), { expirationTtl: 90000 });
  if (pkKey) await env.REGISTRY_KV.put(pkKey, String(pkPrior + 1), { expirationTtl: 90000 });
  if (pkRootKey) await env.REGISTRY_KV.put(pkRootKey, String(pkRootPrior + 1), { expirationTtl: 90000 });
  return { ok: true };
}

async function handleAirdropClaimPost(rootHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle root' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const leafIndex = body.leaf_index;
  const tacitPubHex = String(body.tacit_pubkey ?? '').toLowerCase();
  let ethSigHex = String(body.eth_sig ?? '').toLowerCase();
  if (ethSigHex.startsWith('0x')) ethSigHex = ethSigHex.slice(2);
  // Tips bound to this leaf. Body may carry either `funding_txid`
  // (singular, legacy) or `funding_txids` (array, cumulative); multiple
  // tips from the same recipient compound. The fulfiller sums their sats
  // for the funding gate and orders the queue by cumulative tip amount,
  // so re-tipping after the first POST raises this seat's priority
  // rather than orphaning prior tips (which the recipient already paid
  // for in good faith). Daemon-side enforcement (the fulfiller refuses
  // to broadcast claims whose tips don't verify) closes the free-rider
  // attack; the worker's role here is to (a) format-validate, (b)
  // prevent two distinct leaves from citing the same tip (per-tx
  // nullifier), and (c) MERGE tips into the existing record on re-POST
  // rather than overwriting.
  const incomingTxids = [];
  const _pushTxid = (raw) => {
    let h = String(raw ?? '').toLowerCase();
    if (h.startsWith('0x')) h = h.slice(2);
    if (!h) return true;
    if (!/^[0-9a-f]{64}$/.test(h)) return false;
    if (!incomingTxids.includes(h)) incomingTxids.push(h);
    return true;
  };
  if (Array.isArray(body.funding_txids)) {
    for (const t of body.funding_txids) {
      if (!_pushTxid(t)) return jsonResponse({ error: 'each funding_txids entry must be 64 hex chars' }, 400, cors);
    }
  }
  if (body.funding_txid != null) {
    if (!_pushTxid(body.funding_txid)) return jsonResponse({ error: 'funding_txid must be 64 hex chars when present' }, 400, cors);
  }

  // Format-validate before charging the rate limit so malformed bodies don't
  // burn slots that legitimate retries might need.
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > AIRDROP_LEAF_INDEX_MAX) {
    return jsonResponse({ error: `leaf_index must be integer in [0, ${AIRDROP_LEAF_INDEX_MAX}]` }, 400, cors);
  }
  if (!/^0[23][0-9a-f]{64}$/.test(tacitPubHex)) {
    return jsonResponse({ error: 'tacit_pubkey must be 33-byte compressed hex (starts 02 or 03)' }, 400, cors);
  }
  if (!/^[0-9a-f]{130}$/.test(ethSigHex)) {
    return jsonResponse({ error: 'eth_sig must be 65 bytes (130 hex chars)' }, 400, cors);
  }

  const rl = await _airdropRateLimit(req, env, tacitPubHex, rootHex);
  if (!rl.ok) return jsonResponse({ error: `airdrop limit reached: ${rl.reason}` }, 429, cors);

  // Read the prior claim record so we MERGE new tips into the existing
  // list instead of overwriting. Without this, a re-POST with a fresh
  // tip drops the earlier tips and the recipient loses their cumulative
  // funding credit. KV is eventually consistent but the same recipient
  // re-POSTing sequentially after each tip broadcast is well within the
  // read-your-writes window in practice.
  const claimKey = airdropClaimKey(network, rootHex, leafIndex);
  const prior = await env.REGISTRY_KV.get(claimKey, 'json');
  const priorTxids = [];
  if (Array.isArray(prior?.funding_txids)) {
    for (const t of prior.funding_txids) {
      const h = String(t || '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(h) && !priorTxids.includes(h)) priorTxids.push(h);
    }
  } else if (typeof prior?.funding_txid === 'string') {
    const h = prior.funding_txid.toLowerCase();
    if (/^[0-9a-f]{64}$/.test(h)) priorTxids.push(h);
  }
  const mergedTxids = priorTxids.slice();
  for (const t of incomingTxids) if (!mergedTxids.includes(t)) mergedTxids.push(t);

  // Per-tx nullifier: each tip can back at most one leaf within this
  // root. Distinct roots can share a funding_txid (no cross-drop
  // interference). Only check tips NEW relative to the prior record —
  // previously-bound tips on this same leaf already passed this gate
  // when first POSTed.
  for (const t of incomingTxids) {
    if (priorTxids.includes(t)) continue;
    const existing = await env.REGISTRY_KV.get(airdropFundingKey(network, rootHex, t));
    if (existing && existing !== String(leafIndex)) {
      return jsonResponse({
        error: `funding_txid ${t} already used by claim for leaf_index ${existing}; tip again with a fresh tx and retry`,
      }, 409, cors);
    }
  }

  const record = {
    root: rootHex,
    network,
    leaf_index: leafIndex,
    tacit_pubkey: tacitPubHex,
    eth_sig: '0x' + ethSigHex,
    submitted_at: Math.floor(Date.now() / 1000),
  };
  if (mergedTxids.length > 0) {
    record.funding_txids = mergedTxids;
    // Back-compat mirror for legacy fulfiller builds / clients that
    // only read the singular field. First-bound tip is exposed here;
    // the fulfiller treats funding_txids[] as authoritative when
    // present.
    record.funding_txid = mergedTxids[0];
  }
  // 90-day TTL bounds stale records and self-heals after a mass-delete
  // attack: legitimate recipients re-POST on their next visit and the
  // attacker has to keep wiping under the existing rate-limit ceiling.
  // The issuer's pull window is typically days, not months, so any drop
  // active long enough to exceed this TTL has already been fulfilled and
  // the dropbox is just a leak.
  await env.REGISTRY_KV.put(
    claimKey,
    JSON.stringify(record),
    { expirationTtl: AIRDROP_CLAIM_TTL_SECONDS },
  );
  // Per-tip nullifier markers — outlive the claim record by 30 days so
  // an attacker can't wait for a TTL'd record to expire then re-bind
  // the same tip to a different claim. Same TTL anchors both flows
  // once expired. Only write for NEW tips to avoid burning KV writes on
  // already-bound ones.
  for (const t of incomingTxids) {
    if (priorTxids.includes(t)) continue;
    await env.REGISTRY_KV.put(
      airdropFundingKey(network, rootHex, t),
      String(leafIndex),
      { expirationTtl: AIRDROP_CLAIM_TTL_SECONDS + 30 * 24 * 3600 },
    );
  }
  return jsonResponse({ ok: true, claim: record }, 200, cors);
}

async function handleAirdropClaimList(rootHex, env, network, cors, opts = {}) {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle root' }, 400, cors);
  const requestedLimit = Number.isInteger(opts.limit) ? Math.min(opts.limit, AIRDROP_LIST_HARD_CAP) : AIRDROP_LIST_HARD_CAP;

  // Synthetic cursor: "after:<leaf_index>". The previous design tried to
  // reuse KV's native cursor here, which broke when ?limit truncated mid-
  // KV-page (KV gives no cursor when list_complete=true, but we DO have
  // unreturned entries within that page). The synthetic form is always
  // resumable: caller passes back the same string, worker filters keys
  // whose leaf_index suffix is ≤ the cursor's value.
  let afterLeaf = -1;
  if (typeof opts.cursor === 'string' && opts.cursor.startsWith('after:')) {
    const n = parseInt(opts.cursor.slice('after:'.length), 10);
    if (Number.isInteger(n) && n >= 0) afterLeaf = n;
  }

  const claims = [];
  let truncated = false;
  let nextCursor = null;
  let kvCursor = undefined;
  outer: while (claims.length < requestedLimit) {
    const listOpts = { prefix: airdropClaimPrefix(network, rootHex), limit: AIRDROP_LIST_PAGE };
    if (kvCursor) listOpts.cursor = kvCursor;
    const list = await env.REGISTRY_KV.list(listOpts);
    for (const k of list.keys) {
      // Decode leaf_index from the padded suffix on the key name.
      const lastSegment = k.name.split(':').pop();
      const leafIdx = parseInt(lastSegment, 10);
      if (!Number.isInteger(leafIdx)) continue;            // malformed key; skip
      if (leafIdx <= afterLeaf) continue;                  // already returned in a prior page
      if (claims.length >= requestedLimit) {
        truncated = true;
        nextCursor = `after:${claims[claims.length - 1].leaf_index}`;
        break outer;
      }
      const v = await env.REGISTRY_KV.get(k.name, 'json');
      if (v) claims.push(v);
    }
    if (list.list_complete) break;
    if (!list.cursor) break;
    kvCursor = list.cursor;
  }
  return jsonResponse({ root: rootHex, network, count: claims.length, claims, truncated, next_cursor: nextCursor }, 200, cors);
}

async function handleAirdropClaimDelete(rootHex, leafIndexStr, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle root' }, 400, cors);
  const leafIndex = safeInt(leafIndexStr, -1, { min: 0, max: AIRDROP_LEAF_INDEX_MAX });
  if (leafIndex < 0) return jsonResponse({ error: 'invalid leaf_index' }, 400, cors);

  // Issuer-authenticated DELETE. The body must carry a BIP-340 signature
  // over `airdropClaimDeleteMsg(network, root, leaf_index, issuer_pubkey, timestamp)`
  // verifiable under the announcement's `issuer_pubkey`. Without auth, a
  // single curl attacker could DELETE-wipe the entire queue (DoS), and
  // queue-absence could be falsely interpreted as fulfilment by recipient
  // dashboards. The sig binds the request to: the originating issuer (key
  // gate), the specific leaf, and a fresh timestamp (replay gate).
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const sigHex = String(body.cancel_sig ?? '').toLowerCase();
  const tsRaw = body.timestamp;
  const timestamp = Number.isInteger(tsRaw) ? tsRaw : Number(tsRaw);
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return jsonResponse({ error: 'cancel_sig must be 128 hex chars (BIP-340)' }, 400, cors);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return jsonResponse({ error: 'timestamp required (unix seconds, integer)' }, 400, cors);

  // ±5 min freshness window. Prevents replay of a stale sig against a later
  // resubmission of the same leaf_index. Five minutes covers ordinary NTP
  // skew + brief network detours without being so wide that an attacker
  // could harvest sigs and replay them at scale.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return jsonResponse({ error: 'timestamp not fresh (must be within ±5 min of server time)' }, 403, cors);
  }

  // Authoritative issuer_pubkey comes from the announcement, not from the
  // request body. This way the caller can't pretend to be a different issuer
  // by claiming a key they don't own — the sig must verify against the
  // pubkey on file, period. Missing announcement → no authorization is
  // possible → reject. (Issuers can re-announce if they accidentally
  // cancelled the announcement; existing claims persist independent of
  // announcement state.)
  const stored = await env.REGISTRY_KV.get(dropAnnounceKey(network, rootHex), 'json');
  if (!stored) return jsonResponse({
    error: 'no announcement for this root — cannot authorize delete. Re-publish the announcement (POST /drops) with the original issuer_pubkey, then retry the DELETE. The announcement record is the worker\'s only persistent record of which key may sign claim cancels for this drop.',
  }, 404, cors);
  const issuerPubHex = String(stored.issuer_pubkey || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(issuerPubHex)) return jsonResponse({ error: 'stored issuer_pubkey malformed' }, 500, cors);

  const issuerXOnly = hexToBytes(issuerPubHex).slice(1);
  const msg = airdropClaimDeleteMsg(network, rootHex, leafIndex, issuerPubHex, timestamp);
  if (!verifySchnorr(hexToBytes(sigHex), msg, issuerXOnly)) {
    return jsonResponse({ error: 'invalid cancel_sig (must be BIP-340 signed by the announcement issuer)' }, 403, cors);
  }

  await env.REGISTRY_KV.delete(airdropClaimKey(network, rootHex, leafIndex));
  return jsonResponse({ ok: true }, 200, cors);
}

// POST /airdrops/:root/claims/:leaf_index/paid — issuer marks a claim as
// fulfilled, stamping paid_at + payout_txid on the existing record so
// recipient dashboards can distinguish settled claims from genuinely
// queued ones. Auth mirrors the DELETE handler: BIP-340 sig from the
// announcement issuer over (network, root, leaf_index, issuer_pubkey,
// payout_txid, timestamp). The daemon broadcasting CXFER fulfilments
// calls this for each leaf in the batch — same key it uses to sign
// the kernel sig, so no new key material to manage.
//
// Failure modes return 4xx and DON'T mutate the claim, so a retry from
// a transient blip is safe. The handler is idempotent: re-marking a
// claim paid (with the same or newer payout_txid) just updates the
// stamp.
async function handleAirdropClaimPaid(rootHex, leafIndexStr, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle root' }, 400, cors);
  const leafIndex = safeInt(leafIndexStr, -1, { min: 0, max: AIRDROP_LEAF_INDEX_MAX });
  if (leafIndex < 0) return jsonResponse({ error: 'invalid leaf_index' }, 400, cors);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const sigHex = String(body.paid_sig ?? '').toLowerCase();
  const payoutTxidHex = String(body.payout_txid ?? '').toLowerCase();
  const tsRaw = body.timestamp;
  const timestamp = Number.isInteger(tsRaw) ? tsRaw : Number(tsRaw);
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return jsonResponse({ error: 'paid_sig must be 128 hex chars (BIP-340)' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(payoutTxidHex)) return jsonResponse({ error: 'payout_txid must be 64 hex chars' }, 400, cors);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return jsonResponse({ error: 'timestamp required (unix seconds, integer)' }, 400, cors);

  // ±5 min freshness — same window as the DELETE handler. Prevents an
  // attacker who recovers a sig later from re-marking a deleted-then-
  // resubmitted claim.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return jsonResponse({ error: 'timestamp not fresh (must be within ±5 min of server time)' }, 403, cors);
  }

  // Authoritative issuer_pubkey from the announcement record; the request
  // can't pretend to be a different issuer.
  const stored = await env.REGISTRY_KV.get(dropAnnounceKey(network, rootHex), 'json');
  if (!stored) return jsonResponse({
    error: 'no announcement for this root — cannot authorize paid stamp. Re-publish the announcement (POST /drops) with the original issuer_pubkey, then retry.',
  }, 404, cors);
  const issuerPubHex = String(stored.issuer_pubkey || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(issuerPubHex)) return jsonResponse({ error: 'stored issuer_pubkey malformed' }, 500, cors);

  const issuerXOnly = hexToBytes(issuerPubHex).slice(1);
  const msg = airdropClaimPaidMsg(network, rootHex, leafIndex, issuerPubHex, payoutTxidHex, timestamp);
  if (!verifySchnorr(hexToBytes(sigHex), msg, issuerXOnly)) {
    return jsonResponse({ error: 'invalid paid_sig (must be BIP-340 signed by the announcement issuer)' }, 403, cors);
  }

  // Load existing claim, stamp paid_at + payout_txid, write back.
  // Missing claim → 404 (can't mark a non-existent claim paid). Same
  // TTL preserved so the claim still self-expires at the same time
  // as a non-paid record — a stamped record doesn't get to live
  // forever.
  const claimKey = airdropClaimKey(network, rootHex, leafIndex);
  const existing = await env.REGISTRY_KV.get(claimKey, 'json');
  if (!existing) return jsonResponse({ error: 'no claim found for this leaf_index' }, 404, cors);
  existing.paid_at = timestamp;
  existing.payout_txid = payoutTxidHex;
  await env.REGISTRY_KV.put(
    claimKey,
    JSON.stringify(existing),
    { expirationTtl: AIRDROP_CLAIM_TTL_SECONDS },
  );
  return jsonResponse({ ok: true, claim: existing }, 200, cors);
}

// ============== AIRDROP ANNOUNCEMENTS (discovery layer) ==============
// Recipients shouldn't have to copy/paste a merkle root + IPFS CID from a
// Discord message. Issuers post a signed announcement here; the dapp's Claim
// tab fetches the list, fans out to fetch each snapshot, and surfaces only
// the drops a connected MetaMask address is in. Spam is bounded by an IP
// daily cap plus a per-pubkey daily cap.
//
// Trust model: anyone holding a tacit privkey can announce. The worker is
// not the gatekeeper — it just verifies the BIP-340 sig over the canonical
// message and re-broadcasts. The dapp computes "matches_etcher" provenance
// by comparing announcement.issuer_pubkey against the asset's CETCH signing
// pubkey on the client; self-announced drops surface with a warning badge,
// not hidden, so users decide.
//
// Re-announcing the same (network, root) overwrites — convenient for typos
// or a renewed expiry; the issuer can also DELETE to retract.
const DROP_NOTE_MAX_LEN = 200;
const DROP_EXPIRES_MAX_SECONDS = 365 * 24 * 3600; // refuse expiries > 1y from now (KV residency)

function _networkByte(network) { return network === 'mainnet' ? 1 : 0; }

// Canonical signing message — must match dApp's `dropAnnounceMsgBytes`.
function dropAnnounceMsg(network, assetIdHex, rootHex, cidString, expiresAt, noteString) {
  const cidBytes = new TextEncoder().encode(cidString);
  const noteBytes = new TextEncoder().encode(noteString);
  const cidLen = new Uint8Array(2); new DataView(cidLen.buffer).setUint16(0, cidBytes.length, true);
  const expiresLE = new Uint8Array(8); new DataView(expiresLE.buffer).setBigUint64(0, BigInt(expiresAt), true);
  const noteLen = new Uint8Array(2); new DataView(noteLen.buffer).setUint16(0, noteBytes.length, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-drop-announce-v1'),
    new Uint8Array([_networkByte(network)]),
    hexToBytes(assetIdHex),
    hexToBytes(rootHex),
    cidLen, cidBytes,
    expiresLE,
    noteLen, noteBytes,
  ));
}
function dropAnnounceCancelMsg(network, rootHex, issuerPubHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-drop-announce-cancel-v1'),
    new Uint8Array([_networkByte(network)]),
    hexToBytes(rootHex),
    hexToBytes(issuerPubHex),
  ));
}

// Layered rate-limit: per-IP and per-issuer. The per-IP cap is the same TTL
// pattern as /pin and /drip; the per-pubkey cap forces a determined attacker
// to acquire fresh keys, which costs them nothing but bounds the fan-out
// from a single rotated IP-per-key. Either limit triggers 429.
async function _dropAnnounceRateLimit(req, env, issuerPubHex) {
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `drop-announce-rl:ip:${day}:${ip}`;
  const pkKey = `drop-announce-rl:pk:${day}:${issuerPubHex}`;
  const ipLimit = safeInt(env.DROPS_DAILY_LIMIT_IP, 50, { min: 1 });
  const pkLimit = safeInt(env.DROPS_DAILY_LIMIT_PUBKEY, 10, { min: 1 });
  const ipPrior = safeInt(await env.REGISTRY_KV.get(ipKey), 0, { min: 0 });
  const pkPrior = safeInt(await env.REGISTRY_KV.get(pkKey), 0, { min: 0 });
  if (ipPrior >= ipLimit) return { ok: false, reason: `IP daily limit (${ipLimit}/day)` };
  if (pkPrior >= pkLimit) return { ok: false, reason: `pubkey daily limit (${pkLimit}/day)` };
  await env.REGISTRY_KV.put(ipKey, String(ipPrior + 1), { expirationTtl: 90000 });
  await env.REGISTRY_KV.put(pkKey, String(pkPrior + 1), { expirationTtl: 90000 });
  return { ok: true };
}

async function handleDropAnnouncePost(req, env, network, cors) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const assetIdHex = String(body.asset_id ?? '').toLowerCase();
  const rootHex = String(body.merkle_root ?? '').toLowerCase().replace(/^0x/, '');
  const cid = String(body.ipfs_cid ?? '').trim();
  const issuerPubHex = String(body.issuer_pubkey ?? '').toLowerCase();
  const expiresAt = body.expires_at;
  const note = String(body.note ?? '');
  const sigHex = String(body.announce_sig ?? '').toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle_root' }, 400, cors);
  // Match dApp's `_claimNormaliseCid` regex — same shape Pinata returns.
  if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|baf[a-z0-9]{50,})$/.test(cid)) {
    return jsonResponse({ error: 'invalid ipfs_cid' }, 400, cors);
  }
  if (!/^0[23][0-9a-f]{64}$/.test(issuerPubHex)) {
    return jsonResponse({ error: 'issuer_pubkey must be 33-byte compressed hex (starts 02 or 03)' }, 400, cors);
  }
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return jsonResponse({ error: 'expires_at must be a future unix timestamp' }, 400, cors);
  }
  if (expiresAt > Math.floor(Date.now() / 1000) + DROP_EXPIRES_MAX_SECONDS) {
    return jsonResponse({ error: `expires_at must be within ${DROP_EXPIRES_MAX_SECONDS / 86400} days` }, 400, cors);
  }
  if (note.length > DROP_NOTE_MAX_LEN) {
    return jsonResponse({ error: `note must be ≤ ${DROP_NOTE_MAX_LEN} chars` }, 400, cors);
  }
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return jsonResponse({ error: 'announce_sig must be 128 hex chars' }, 400, cors);

  // BIP-340 verifies under x-only, but the announcement carries the full
  // 33-byte compressed pubkey so the dapp can render it without an extra
  // round-trip. Verify against the x-coord (slice off the parity byte).
  const issuerXOnly = hexToBytes(issuerPubHex).slice(1);
  const msg = dropAnnounceMsg(network, assetIdHex, rootHex, cid, expiresAt, note);
  if (!verifySchnorr(hexToBytes(sigHex), msg, issuerXOnly)) {
    return jsonResponse({ error: 'invalid announce_sig (must be BIP-340 under issuer_pubkey)' }, 403, cors);
  }

  const rl = await _dropAnnounceRateLimit(req, env, issuerPubHex);
  if (!rl.ok) return jsonResponse({ error: `drop announce limit reached: ${rl.reason}` }, 429, cors);

  const record = {
    schema: 'tacit-drop-v1',
    network,
    asset_id: assetIdHex,
    merkle_root: rootHex,
    ipfs_cid: cid,
    issuer_pubkey: issuerPubHex,
    expires_at: expiresAt,
    note,
    announce_sig: sigHex,
    announced_at: Math.floor(Date.now() / 1000),
  };
  // Native TTL on the KV key so expired announcements GC even if no client
  // ever lists/reads them — the lazy-on-read path below still applies but
  // can't keep up with announcements that get pinned to localStorage and
  // then never re-read on the worker side. +60s of slack to ensure the GC
  // doesn't race a final read at the boundary.
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, expiresAt - nowSec + 60);
  await env.REGISTRY_KV.put(
    dropAnnounceKey(network, rootHex),
    JSON.stringify(record),
    { expirationTtl: ttlSeconds },
  );
  return jsonResponse({ ok: true, drop: record }, 200, cors);
}

async function handleDropAnnounceList(env, network, cors) {
  const list = await env.REGISTRY_KV.list({ prefix: dropAnnouncePrefix(network), limit: 1000 });
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const now = Math.floor(Date.now() / 1000);
  const drops = [];
  for (const v of fetched) {
    if (!v) continue;
    // Signet keeps the legacy unprefixed KV form (`drop-announce:<root>`),
    // and KV's prefix scan does raw string matching with no awareness of
    // our colon-separated network namespacing. The signet prefix
    // `drop-announce:` therefore matches every mainnet key
    // `drop-announce:mainnet:<root>` too, so a signet listing pulls in
    // mainnet announcements. Filter records to the requested network so
    // recipients on signet don't see mainnet drops in their discovery list
    // (the snapshot-load + sign step would block them anyway via the
    // network-mismatch banner, but surfacing mismatched drops upstream is
    // confusing UX). Records without a network field default to signet.
    if ((v.network || 'signet') !== network) continue;
    if (v.expires_at && v.expires_at <= now) {
      // Lazy GC: fire-and-forget delete on read. Cheaper than a sweeper cron.
      // The filter above guarantees v.network === network, so reconstructing
      // the key from `network + v.merkle_root` matches the actual stored key.
      env.REGISTRY_KV.delete(dropAnnounceKey(network, v.merkle_root)).catch(() => {});
      continue;
    }
    drops.push(v);
  }
  // Newest first so freshly announced drops surface immediately.
  drops.sort((a, b) => (b.announced_at || 0) - (a.announced_at || 0));
  return jsonResponse({ network, count: drops.length, drops }, 200, cors);
}

async function handleDropAnnounceGet(rootHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle root' }, 400, cors);
  const v = await env.REGISTRY_KV.get(dropAnnounceKey(network, rootHex), 'json');
  if (!v) return jsonResponse({ error: 'no such drop' }, 404, cors);
  const now = Math.floor(Date.now() / 1000);
  if (v.expires_at && v.expires_at <= now) {
    env.REGISTRY_KV.delete(dropAnnounceKey(network, rootHex)).catch(() => {});
    return jsonResponse({ error: 'drop expired' }, 410, cors);
  }
  return jsonResponse({ drop: v }, 200, cors);
}

async function handleDropAnnounceDelete(rootHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle root' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const issuerPubHex = String(body.issuer_pubkey ?? '').toLowerCase();
  const sigHex = String(body.cancel_sig ?? '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(issuerPubHex)) return jsonResponse({ error: 'issuer_pubkey required' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return jsonResponse({ error: 'cancel_sig must be 128 hex chars' }, 400, cors);

  const stored = await env.REGISTRY_KV.get(dropAnnounceKey(network, rootHex), 'json');
  if (!stored) return jsonResponse({ error: 'no such drop' }, 404, cors);
  // Sig must be under the SAME pubkey that announced it. Otherwise an
  // attacker who learned the rootHex could publish their own announcement
  // first and then DELETE the legitimate one.
  if (stored.issuer_pubkey !== issuerPubHex) {
    return jsonResponse({ error: 'cancel must be signed by the original announcer' }, 403, cors);
  }
  const issuerXOnly = hexToBytes(issuerPubHex).slice(1);
  const msg = dropAnnounceCancelMsg(network, rootHex, issuerPubHex);
  if (!verifySchnorr(hexToBytes(sigHex), msg, issuerXOnly)) {
    return jsonResponse({ error: 'invalid cancel_sig' }, 403, cors);
  }
  await env.REGISTRY_KV.delete(dropAnnounceKey(network, rootHex));
  return jsonResponse({ ok: true }, 200, cors);
}

// ============== BID INTENTS (off-chain bid book — SPEC §5.7.7) ==============
// Buyer-initiated counterpart to §5.7.6 atomic intents. Bid intents are pure
// off-chain coordination — the buyer signs an intent (no on-chain lock), a
// seller can claim by spinning up a §5.7.6 atomic intent targeted at the
// bidder, and the bidder takes through the existing §5.7.6 take flow.
// Settlement is exactly §5.7.3 (T_AXFER opcode 0x26) — no new wire format.
//
// Trust model: bidder-can-ghost. Spam mitigation = sig-required POST,
// per-IP rate limit, 30-day expiry cap. v2 with covenants can replace this
// with on-chain escrow (see SPEC §5.7.7 trust analysis).

const BID_EXPIRY_MAX_DAYS = 30;

function bidIntentKey(network, aid, bidIdHex) {
  return network === 'signet'
    ? `bidintent:${aid}:${bidIdHex}`
    : `bidintent:${network}:${aid}:${bidIdHex}`;
}
function bidIntentPrefix(network, aid) {
  return network === 'signet' ? `bidintent:${aid}:` : `bidintent:${network}:${aid}:`;
}
function bidClaimKey(network, aid, bidIdHex) {
  return network === 'signet'
    ? `bidclaim:${aid}:${bidIdHex}`
    : `bidclaim:${network}:${aid}:${bidIdHex}`;
}
// Variable-fill bid (§5.7.7) needs many claim records per bid — one per
// partial fulfilment. Keyed by axintent_id so each linked atomic-intent
// owns its own claim record; the bid's `remaining_amount` is the
// authoritative ledger (decremented as fills settle, re-credited by the
// abandonment cron in PR3). list({prefix}) over bidPartialClaimPrefix
// gives an O(K) traversal of all live partial-fill claims for a bid.
function bidPartialClaimKey(network, aid, bidIdHex, axintentIdHex) {
  return network === 'signet'
    ? `bidpclaim:${aid}:${bidIdHex}:${axintentIdHex}`
    : `bidpclaim:${network}:${aid}:${bidIdHex}:${axintentIdHex}`;
}
function bidPartialClaimPrefix(network, aid, bidIdHex) {
  return network === 'signet'
    ? `bidpclaim:${aid}:${bidIdHex}:`
    : `bidpclaim:${network}:${aid}:${bidIdHex}:`;
}

// CAS overshoot resolution for variable-fill bids. KV `put` is not
// linearizable, so two concurrent POSTs against the same bid can both
// pass the pre-write `fill_amount <= remaining_amount` bound check and
// both write claim records. After each write the handler re-lists the
// bid's partial-claims and runs this resolver: filter to active claims,
// sort by axintent_id ascending, greedily accept while sum ≤ amount,
// evict the rest. The sort is the deterministic tiebreaker — both
// racers compute the same survivors + evicted sets without coordinating,
// so the loser converges on a 409 even if its own POST handler hasn't
// seen the winner's claim record yet (the next list() will).
//
// Exported for tests/worker-bid-claim-race.test.mjs which exercises
// the resolution rule directly with synthesized claim records, without
// the rest of the KV / signature / atomic-intent setup the full handler
// requires. The signet e2e harness covers the integrated path.
function _resolveBidPartialOvershoot(records, intentAmtBI, nowSec) {
  const active = records.filter(p => p && (p.expires_at || 0) > nowSec);
  const sorted = active.slice().sort((a, b) =>
    a.axintent_id < b.axintent_id ? -1 : a.axintent_id > b.axintent_id ? 1 : 0
  );
  let kept = 0n;
  const survivors = [];
  const evicted = [];
  for (const p of sorted) {
    const f = BigInt(p.fill_amount || '0');
    if (kept + f <= intentAmtBI) { kept += f; survivors.push(p); }
    else evicted.push(p);
  }
  return { kept, survivors, evicted };
}

// Canonical bid-intent + bid-claim messages. SPEC §5.7.7 (variable-amount
// bid intents) extends the byte format to bind `min_fill_amount` (publish)
// and `fill_amount` (claim) so a single signed bid can be partial-filled
// by multiple sellers. Whole-bid usage sets `min_fill = 0` (or absent)
// and `fill_amount = amount`; the bytes are deterministic in both cases.
//
// Domain strings drop the `-v1` suffix per the canonical-form framing
// (Tacit launched this week; the SPEC describes the canonical form, not
// a versioned migration path). The dapp's _bidIntentMsg / _bidClaimMsg
// match these bytes exactly; a parity test pins the equivalence.
function bidIntentMsg(assetIdHex, bidIdHex, buyerPubHex, amountStr, priceSats, minFillStr, expiry, nonceHex) {
  const amountLE  = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amountStr), true);
  const priceLE   = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const minFillLE = new Uint8Array(8); new DataView(minFillLE.buffer).setBigUint64(0, BigInt(minFillStr || '0'), true);
  const expiryLE  = new Uint8Array(8); new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-intent'),
    hexToBytes(assetIdHex),
    hexToBytes(bidIdHex),
    hexToBytes(buyerPubHex),
    amountLE,
    priceLE,
    minFillLE,
    expiryLE,
    hexToBytes(nonceHex),
  ));
}

function bidClaimMsg(assetIdHex, bidIdHex, sellerPubHex, axintentIdHex, fillAmountStr) {
  const fillLE = new Uint8Array(8); new DataView(fillLE.buffer).setBigUint64(0, BigInt(fillAmountStr || '0'), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-claim'),
    hexToBytes(assetIdHex),
    hexToBytes(bidIdHex),
    hexToBytes(sellerPubHex),
    hexToBytes(axintentIdHex),
    fillLE,
  ));
}

function bidCancelMsg(assetIdHex, bidIdHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-cancel-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(bidIdHex),
  ));
}

async function handleBidIntentPost(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const bidIdHex = String(body.bid_id ?? '').toLowerCase();
  const buyerPubHex = String(body.buyer_pubkey ?? '').toLowerCase();
  const buyerAddress = String(body.buyer_address ?? '');
  const amountStr = String(body.amount ?? '');
  const priceSatsRaw = body.price_sats;
  const expiryRaw = body.expiry;
  const nonceHex = String(body.nonce ?? '').toLowerCase();
  const sigHex = String(body.intent_sig ?? '').toLowerCase();
  // Variable-fill opt-in: SPEC §5.7.7. Presence + non-zero means partial
  // fulfilment is allowed; absent or "0" means whole-bid only. The bytes
  // sign over min_fill_amount in both cases (0 for whole-bid), so the
  // canonical form is deterministic.
  const minFillStr = String(body.min_fill_amount ?? '0');

  // Format-validate before charging the rate limit so malformed bodies don't
  // burn slots that legitimate retries might need (mirrors handleAirdropClaimPost).
  if (!/^[0-9a-f]{32}$/.test(bidIdHex))               return jsonResponse({ error: 'bid_id must be 32 hex chars (16 bytes)' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(buyerPubHex))       return jsonResponse({ error: 'buyer_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^\d+$/.test(amountStr))                       return jsonResponse({ error: 'amount must be base-10 integer string' }, 400, cors);
  if (BigInt(amountStr) <= 0n || BigInt(amountStr) >= (1n << 64n)) return jsonResponse({ error: 'amount out of u64' }, 400, cors);
  if (!/^\d+$/.test(minFillStr))                      return jsonResponse({ error: 'min_fill_amount must be base-10 integer string' }, 400, cors);
  const minFillBI = BigInt(minFillStr);
  if (minFillBI < 0n || minFillBI >= (1n << 64n))     return jsonResponse({ error: 'min_fill_amount out of u64' }, 400, cors);
  if (minFillBI > 0n && minFillBI > BigInt(amountStr))return jsonResponse({ error: 'min_fill_amount must not exceed amount' }, 400, cors);
  if (minFillBI > 0n && minFillBI === BigInt(amountStr)) {
    // Degenerate: variable bid with min_fill == amount collapses to whole-bid.
    // Reject so the bidder uses the simpler path; matches the §5.7.6.1
    // pattern for variable-amount intents.
    return jsonResponse({ error: 'min_fill_amount == amount is the degenerate (whole-bid) case; omit min_fill_amount instead' }, 400, cors);
  }
  if (!Number.isInteger(priceSatsRaw) || priceSatsRaw < PRICE_MIN) return jsonResponse({ error: `price_sats must be integer ≥ ${PRICE_MIN}` }, 400, cors);
  if (!Number.isInteger(expiryRaw))                   return jsonResponse({ error: 'expiry must be integer unix-seconds' }, 400, cors);
  const now = Math.floor(Date.now() / 1000);
  if (expiryRaw <= now)                               return jsonResponse({ error: 'expiry must be in the future' }, 400, cors);
  if (expiryRaw > now + BID_EXPIRY_MAX_DAYS * 86400)  return jsonResponse({ error: `expiry must be within ${BID_EXPIRY_MAX_DAYS} days` }, 400, cors);
  if (!/^[0-9a-f]{64}$/.test(nonceHex))               return jsonResponse({ error: 'nonce must be 32-byte hex (64 chars)' }, 400, cors);
  if (!buyerAddress || buyerAddress.length > ADDR_MAX_LEN) return jsonResponse({ error: `buyer_address required, ≤ ${ADDR_MAX_LEN} chars` }, 400, cors);
  const decoded = decodeBitcoinAddress(buyerAddress);
  if (!decoded || decoded.hrp !== HRP_BY_NETWORK[network]) {
    return jsonResponse({ error: `buyer_address must be a ${HRP_BY_NETWORK[network]}… bech32 address` }, 400, cors);
  }
  if (decoded.version !== 0 || decoded.program.length !== 20) {
    return jsonResponse({ error: 'buyer_address must be a v0 P2WPKH (20-byte program)' }, 400, cors);
  }
  if (bytesToHex(decoded.program) !== bytesToHex(hash160(hexToBytes(buyerPubHex)))) {
    return jsonResponse({ error: 'buyer_address does not derive from buyer_pubkey' }, 400, cors);
  }
  if (!/^[0-9a-f]{128}$/.test(sigHex))                return jsonResponse({ error: 'intent_sig must be 128 hex chars' }, 400, cors);

  // Verify bid_id derives from sha256(asset_id || buyer_pubkey || nonce)[:16].
  const expectedBidId = bytesToHex(sha256(concatBytes(
    hexToBytes(assetIdHex),
    hexToBytes(buyerPubHex),
    hexToBytes(nonceHex),
  ))).slice(0, 32);
  if (bidIdHex !== expectedBidId) {
    return jsonResponse({ error: 'bid_id does not derive from sha256(asset_id || buyer_pubkey || nonce).slice(0, 16)' }, 400, cors);
  }

  // Verify intent_sig under buyer_pubkey. Sub-dust scaled-payment guard
  // when variable fills are enabled: floor(min_fill × price / amount)
  // must be ≥ DUST so the smallest legal fill can settle.
  if (minFillBI > 0n) {
    const minScaledSats = Number((minFillBI * BigInt(priceSatsRaw)) / BigInt(amountStr));
    if (minScaledSats < DUST) {
      return jsonResponse({ error: `min_fill_amount yields sub-dust scaled payment (${minScaledSats} < ${DUST}); raise min_fill_amount or price_sats` }, 400, cors);
    }
  }
  const msg = bidIntentMsg(assetIdHex, bidIdHex, buyerPubHex, amountStr, priceSatsRaw, minFillStr, expiryRaw, nonceHex);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(buyerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid intent signature' }, 403, cors);
  }

  // Charge rate limit only after sig verification — so a malformed or
  // unsigned body can't drain the bidder's daily slots.
  const rl = await _airdropRateLimit(req, env);
  if (!rl.ok) return jsonResponse({ error: `bid daily limit reached: ${rl.reason}` }, 429, cors);

  const intent = {
    asset_id: assetIdHex,
    bid_id: bidIdHex,
    buyer_pubkey: buyerPubHex,
    buyer_address: buyerAddress,
    amount: amountStr,
    price_sats: priceSatsRaw,
    expiry: expiryRaw,
    nonce: nonceHex,
    intent_sig: sigHex,
    created_at: now,
    network,
  };
  // Variable-fill record fields (§5.7.7). `min_fill_amount` is stored as a
  // signal to readers + sellers that partial fulfilment is allowed;
  // `remaining_amount` is the worker-maintained ledger the atomic-CAS
  // (PR2) will decrement on each linked atomic-intent settlement.
  if (minFillBI > 0n) {
    intent.min_fill_amount = minFillStr;
    intent.remaining_amount = amountStr;  // starts at full amount; decrements as fills settle
  }
  await env.REGISTRY_KV.put(bidIntentKey(network, assetIdHex, bidIdHex), JSON.stringify(intent));
  return jsonResponse({ ok: true, intent }, 200, cors);
}

async function handleBidIntentList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const list = await env.REGISTRY_KV.list({ prefix: bidIntentPrefix(network, assetIdHex), limit: 1000 });
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const intents = fetched.filter(v => v);
  const now = Math.floor(Date.now() / 1000);
  // Drop expired bids at read time. KV record left for lazy GC.
  const active = intents.filter(v => (v.expiry || 0) > now);
  // Decorate with claim status. Variable-fill bids may have many linked
  // partial-fill claims; whole-bid uses the single legacy claim key.
  await Promise.all(active.map(async v => {
    const isVar = !!(v.min_fill_amount && v.min_fill_amount !== '0');
    if (isVar) {
      const partials = await env.REGISTRY_KV.list({ prefix: bidPartialClaimPrefix(network, assetIdHex, v.bid_id), limit: 200 });
      if (partials.keys.length) {
        const claims = await Promise.all(partials.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
        v.partial_claims = claims.filter(c => c && c.expires_at > now);
      }
    } else {
      const claim = await env.REGISTRY_KV.get(bidClaimKey(network, assetIdHex, v.bid_id), 'json');
      if (claim && claim.expires_at > now) v.claim = claim;
    }
  }));
  active.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return jsonResponse({ asset_id: assetIdHex, count: active.length, intents: active }, 200, cors);
}

async function handleBidIntentGet(assetIdHex, bidIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(bidIdHex))   return jsonResponse({ error: 'invalid bid_id' }, 400, cors);
  const intent = await env.REGISTRY_KV.get(bidIntentKey(network, assetIdHex, bidIdHex), 'json');
  if (!intent) return jsonResponse({ error: 'no such bid' }, 404, cors);
  const now = Math.floor(Date.now() / 1000);
  const isVar = !!(intent.min_fill_amount && intent.min_fill_amount !== '0');
  if (isVar) {
    const partials = await env.REGISTRY_KV.list({ prefix: bidPartialClaimPrefix(network, assetIdHex, bidIdHex), limit: 200 });
    if (partials.keys.length) {
      const claims = await Promise.all(partials.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
      intent.partial_claims = claims.filter(c => c && c.expires_at > now);
    }
  } else {
    const claim = await env.REGISTRY_KV.get(bidClaimKey(network, assetIdHex, bidIdHex), 'json');
    if (claim && claim.expires_at > now) intent.claim = claim;
  }
  return jsonResponse({ ok: true, intent }, 200, cors);
}

async function handleBidIntentDelete(assetIdHex, bidIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(bidIdHex))   return jsonResponse({ error: 'invalid bid_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const sigHex = String(body.cancel_sig ?? '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return jsonResponse({ error: 'cancel_sig must be 128 hex chars' }, 400, cors);
  const intent = await env.REGISTRY_KV.get(bidIntentKey(network, assetIdHex, bidIdHex), 'json');
  if (!intent) return jsonResponse({ error: 'no such bid' }, 404, cors);
  const msg = bidCancelMsg(assetIdHex, bidIdHex);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(intent.buyer_pubkey).slice(1))) {
    return jsonResponse({ error: 'invalid cancel signature' }, 403, cors);
  }
  await env.REGISTRY_KV.delete(bidIntentKey(network, assetIdHex, bidIdHex));
  await env.REGISTRY_KV.delete(bidClaimKey(network, assetIdHex, bidIdHex));
  // Variable-fill bids may have many linked partial claims; delete them all.
  // Any in-flight linked atomic-intents still exist independently — the
  // seller can self-spend their asset_utxo back to invalidate. Same hard-
  // cancel pattern as §5.7.6.1 *Garbage collection*.
  try {
    const partials = await env.REGISTRY_KV.list({ prefix: bidPartialClaimPrefix(network, assetIdHex, bidIdHex), limit: 1000 });
    await Promise.all(partials.keys.map(k => env.REGISTRY_KV.delete(k.name)));
  } catch { /* best-effort GC; cron will eventually sweep */ }
  return jsonResponse({ ok: true }, 200, cors);
}

const BID_CLAIM_TTL_SECONDS = 30 * 60;

// Sweep abandoned variable-fill bid partial-claim records and refund their
// fill_amount back to the parent bid's remaining_amount. Without this, a
// seller who posts a claim then walks away (never has a buyer take their
// linked atomic-intent, or has the atomic-intent expire unsettled) would
// permanently lock fill_amount worth of the bid's remaining capacity —
// effectively a drain attack on the bidder's open order.
//
// Detection: each bidpclaim record points at a linked axintent_id. The
// linked atomic-intent's fulfilment record (atomicFulfilmentKey) carries
// the on-chain state. Three outcomes:
//   - REVEAL_BROADCAST / SETTLED → chunk settled, leave the bid record
//     decremented (correct accounting).
//   - ABANDONED → refund + delete the bidpclaim.
//   - missing / no fulfilment record / atomic-intent expired without ever
//     reaching COMMIT_READY → refund + delete.
//
// Bounded sweep: at most BID_PARTIAL_CLAIM_SWEEP_LIMIT keys per network
// per tick so a large backlog doesn't blow the cron's 30s CPU budget.
// Self-paces: the auto-TTL on bidpclaim records catches anything we
// miss, just without the bid-side remaining refund.
const BID_PARTIAL_CLAIM_SWEEP_LIMIT = 200;
async function sweepBidPartialClaims(env, network) {
  // Prefix on signet is `bidpclaim:` (network-implicit); on mainnet it's
  // `bidpclaim:mainnet:`. Use the explicit prefix builder so we don't
  // accidentally cross-list networks.
  const prefix = network === 'signet' ? 'bidpclaim:' : `bidpclaim:${network}:`;
  let cursor = null, processed = 0, refunded = 0, deleted = 0;
  while (processed < BID_PARTIAL_CLAIM_SWEEP_LIMIT) {
    const opts = { prefix, limit: 100 };
    if (cursor) opts.cursor = cursor;
    const list = await env.REGISTRY_KV.list(opts);
    for (const k of list.keys) {
      if (processed >= BID_PARTIAL_CLAIM_SWEEP_LIMIT) break;
      processed++;
      const claim = await env.REGISTRY_KV.get(k.name, 'json');
      if (!claim || !claim.bid_id || !claim.asset_id || !claim.axintent_id || !claim.fill_amount) continue;
      const aid = claim.asset_id;
      const fulfil = await env.REGISTRY_KV.get(atomicFulfilmentKey(network, aid, claim.axintent_id), 'json');
      // Settled? Done — keep the bidpclaim record for the buyer's read
      // path; it'll auto-TTL out. (We don't strictly need it after settle
      // but cleaning it up is opportunistic.)
      const settledStates = new Set(['REVEAL_BROADCAST', 'SETTLED']);
      const abandonedStates = new Set(['ABANDONED']);
      const isSettled = !!(fulfil && settledStates.has(fulfil.state));
      if (isSettled) continue;
      // Abandoned or never-fulfilled? Refund + delete.
      const atomicIntent = await env.REGISTRY_KV.get(atomicIntentKey(network, aid, claim.axintent_id), 'json');
      const now = Math.floor(Date.now() / 1000);
      const atomicExpired = !atomicIntent || (Number(atomicIntent.expiry) || 0) <= now;
      const isAbandoned = !!(fulfil && abandonedStates.has(fulfil.state));
      if (!isAbandoned && !atomicExpired) continue;  // still in-flight, leave alone
      // Re-credit the parent bid.
      const bid = await env.REGISTRY_KV.get(bidIntentKey(network, aid, claim.bid_id), 'json');
      if (bid && (Number(bid.expiry) || 0) > now && bid.min_fill_amount) {
        try {
          const oldRemaining = BigInt(bid.remaining_amount || bid.amount || '0');
          const fillBI = BigInt(claim.fill_amount);
          let newRemaining = oldRemaining + fillBI;
          const fullAmt = BigInt(bid.amount || '0');
          if (newRemaining > fullAmt) newRemaining = fullAmt;  // defensive
          bid.remaining_amount = newRemaining.toString();
          // If the bid had been CLOSED for being below min_fill, re-open it.
          if (bid.state === 'CLOSED' && newRemaining >= BigInt(bid.min_fill_amount)) {
            bid.state = 'PARTIALLY_RESERVED';
          }
          await env.REGISTRY_KV.put(bidIntentKey(network, aid, claim.bid_id), JSON.stringify(bid));
          refunded++;
        } catch { /* skip on parse errors */ }
      }
      await env.REGISTRY_KV.delete(k.name).catch(() => {});
      deleted++;
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }
  return { processed, refunded, deleted };
}

async function handleBidIntentClaim(assetIdHex, bidIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(bidIdHex))   return jsonResponse({ error: 'invalid bid_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const sellerPubHex = String(body.seller_pubkey ?? '').toLowerCase();
  const axintentIdHex = String(body.axintent_id ?? '').toLowerCase();
  const sigHex = String(body.sig ?? '').toLowerCase();
  // fill_amount is required canonically (SPEC §5.7.7). For whole-bid claims,
  // sellers pass the bid's full `amount`. For variable-fill claims, sellers
  // pass their chosen chunk in [min_fill_amount, remaining_amount]. The
  // claim message bytes bind fill_amount, so a worker / relay can't mutate
  // the chunk size without invalidating the seller's signature.
  const fillAmountStr = String(body.fill_amount ?? '');
  if (!/^0[23][0-9a-f]{64}$/.test(sellerPubHex)) return jsonResponse({ error: 'seller_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(axintentIdHex))     return jsonResponse({ error: 'axintent_id must be 32 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))           return jsonResponse({ error: 'sig must be 128 hex chars' }, 400, cors);
  if (!/^\d+$/.test(fillAmountStr))              return jsonResponse({ error: 'fill_amount must be base-10 integer string' }, 400, cors);
  const fillBI = BigInt(fillAmountStr);
  if (fillBI <= 0n || fillBI >= (1n << 64n))     return jsonResponse({ error: 'fill_amount out of u64' }, 400, cors);

  const intent = await env.REGISTRY_KV.get(bidIntentKey(network, assetIdHex, bidIdHex), 'json');
  if (!intent) return jsonResponse({ error: 'no such bid' }, 404, cors);
  const now = Math.floor(Date.now() / 1000);
  if ((intent.expiry || 0) <= now) return jsonResponse({ error: 'bid expired' }, 410, cors);

  // Bound-check fill_amount against the bid's allowed range.
  //   Whole-bid (no min_fill_amount on the record): fill_amount must
  //     equal amount exactly; existing TTL'd single-claim record applies.
  //   Variable-fill (min_fill_amount > 0): fill_amount must be in
  //     [min_fill_amount, remaining_amount]; multiple linked claims may
  //     exist concurrently (keyed by axintent_id under bidPartialClaimKey).
  const intentAmtBI = BigInt(intent.amount || '0');
  const isVariableFill = !!(intent.min_fill_amount && intent.min_fill_amount !== '0');

  if (isVariableFill) {
    const minFillBI = BigInt(intent.min_fill_amount);
    const remainingBI = BigInt(intent.remaining_amount || intent.amount || '0');
    if (fillBI < minFillBI) {
      return jsonResponse({ error: `fill_amount ${fillAmountStr} below bid.min_fill_amount ${intent.min_fill_amount}` }, 400, cors);
    }
    if (fillBI > remainingBI) {
      return jsonResponse({ error: `fill_amount ${fillAmountStr} exceeds bid.remaining_amount ${intent.remaining_amount || intent.amount}` }, 409, cors);
    }
    // Reject duplicate claims for the same linked axintent. A seller who
    // re-POSTs the same claim hits this; we surface idempotently rather
    // than rejecting outright so the dapp can re-fetch state cleanly.
    const existingPartial = await env.REGISTRY_KV.get(bidPartialClaimKey(network, assetIdHex, bidIdHex, axintentIdHex), 'json');
    if (existingPartial && existingPartial.expires_at > now) {
      return jsonResponse({ ok: true, claim: existingPartial, idempotent: true }, 200, cors);
    }
  } else {
    if (fillBI !== intentAmtBI) {
      return jsonResponse({ error: `fill_amount must equal bid.amount (${intent.amount}) for whole-bid claims` }, 400, cors);
    }
    // Reject if already claimed by a different seller within TTL window.
    const existing = await env.REGISTRY_KV.get(bidClaimKey(network, assetIdHex, bidIdHex), 'json');
    if (existing && existing.expires_at > now && existing.seller_pubkey !== sellerPubHex) {
      return jsonResponse({ error: 'bid already claimed', claim: { expires_at: existing.expires_at } }, 409, cors);
    }
  }

  const msg = bidClaimMsg(assetIdHex, bidIdHex, sellerPubHex, axintentIdHex, fillAmountStr);
  if (!verifySchnorr(hexToBytes(sigHex), msg, hexToBytes(sellerPubHex).slice(1))) {
    return jsonResponse({ error: 'invalid claim signature' }, 403, cors);
  }

  // Verify the linked axintent exists, is active, and targets the bid's
  // buyer_address. Without this binding a malicious seller could publish a
  // claim pointing at any axintent (or none), wasting the bidder's time.
  const axintent = await env.REGISTRY_KV.get(atomicIntentKey(network, assetIdHex, axintentIdHex), 'json');
  if (!axintent) return jsonResponse({ error: 'linked axintent_id not found in atomic-intent registry' }, 400, cors);
  if ((axintent.expiry || 0) <= now) return jsonResponse({ error: 'linked axintent already expired' }, 400, cors);
  if (axintent.maker_pubkey !== sellerPubHex) {
    return jsonResponse({ error: 'linked axintent.maker_pubkey != seller_pubkey' }, 400, cors);
  }
  // Pull the bidder's recipient hash160 from the axintent's envelope and
  // require it to match the bid's buyer_pubkey hash160. The seller would
  // have constructed the axintent's recipient blinding ECDH'd against
  // buyer_pubkey, so the hash160 in the envelope's eventual P2WPKH output
  // (encoded by the dapp at intent build time) must equal hash160(buyer_pubkey).
  // We can't recompute the recipient_pubkey from an x-only blob, so the
  // simplest worker-side check is by buyer_address-bytes equality:
  const expectedBuyerH160 = bytesToHex(hash160(hexToBytes(intent.buyer_pubkey)));
  // axintent stores p2tr_spk_hex (commit), envelope_script_hex, etc.; the
  // recipient hash160 is reachable by decoding the envelope payload's first
  // output commitment vs. an off-chain "intended_buyer_hash160" field.
  // We'll require the dapp to include that field in the axintent post for
  // bid-flow axintents; absent that, we skip and trust the dapp re-verifies
  // at take-time (same policy as §5.6).
  if (axintent.intended_buyer_h160 && axintent.intended_buyer_h160.toLowerCase() !== expectedBuyerH160) {
    return jsonResponse({ error: 'linked axintent does not target buyer_address' }, 400, cors);
  }

  const claim = {
    bid_id: bidIdHex,
    asset_id: assetIdHex,
    seller_pubkey: sellerPubHex,
    axintent_id: axintentIdHex,
    fill_amount: fillAmountStr,  // canonical field (SPEC §5.7.7)
    sig: sigHex,
    claimed_at: now,
    expires_at: now + BID_CLAIM_TTL_SECONDS,
    network,
  };

  if (isVariableFill) {
    // Variable-fill bid: one claim record per linked atomic-intent.
    //
    // The pre-write bound check at line 8786 above is best-effort: two
    // concurrent POSTs can both read the same `remaining_amount` and
    // both pass, over-committing the bid by their combined fill_amount.
    // KV `put` is not a linearizable CAS; we can't strictly prevent the
    // race. What we CAN do is detect overshoot post-write and resolve
    // it deterministically — write our claim, re-list ALL active
    // claims under the bid's prefix, and if the sum exceeds the bid's
    // total amount, evict the lexicographically-largest axintent_id(s)
    // until the budget fits. Both racers run the same resolution rule
    // and converge on the same winner without coordinating.
    //
    // The bid's `remaining_amount` then becomes a projection of the
    // active partial-claims set rather than a free-running counter,
    // so any subsequent reader sees the truth even if the racers'
    // intent writes interleaved arbitrarily.
    //
    // PR3's re-credit cron handles the longer tail (claims abandoned
    // mid-fulfilment); this only fixes the in-flight POST race.
    const minFillBI = BigInt(intent.min_fill_amount);
    await env.REGISTRY_KV.put(
      bidPartialClaimKey(network, assetIdHex, bidIdHex, axintentIdHex),
      JSON.stringify(claim),
      { expirationTtl: BID_CLAIM_TTL_SECONDS + 60 },
    );
    const listed = await env.REGISTRY_KV.list({ prefix: bidPartialClaimPrefix(network, assetIdHex, bidIdHex), limit: 1000 });
    const recs = await Promise.all(listed.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
    const { kept, survivors, evicted } = _resolveBidPartialOvershoot(recs, intentAmtBI, now);
    if (evicted.length > 0) {
      await Promise.all(evicted.map(p =>
        env.REGISTRY_KV.delete(bidPartialClaimKey(network, assetIdHex, bidIdHex, p.axintent_id))
      ));
    }
    const ourEvicted = evicted.some(p => p.axintent_id === axintentIdHex);
    intent.remaining_amount = (intentAmtBI - kept).toString();
    intent.linked_axintents = survivors.map(p => p.axintent_id);
    if (BigInt(intent.remaining_amount) < minFillBI) {
      intent.state = 'CLOSED';
    } else if (!intent.state || intent.state === 'OPEN') {
      intent.state = survivors.length > 0 ? 'PARTIALLY_RESERVED' : 'OPEN';
    }
    await env.REGISTRY_KV.put(bidIntentKey(network, assetIdHex, bidIdHex), JSON.stringify(intent));
    if (ourEvicted) {
      return jsonResponse({
        error: 'bid remaining insufficient (lost race to concurrent fill; retry with smaller fill_amount or another bid)',
        remaining_amount: intent.remaining_amount,
      }, 409, cors);
    }
    return jsonResponse({ ok: true, claim, intent }, 200, cors);
  }

  await env.REGISTRY_KV.put(bidClaimKey(network, assetIdHex, bidIdHex), JSON.stringify(claim));
  return jsonResponse({ ok: true, claim, intent }, 200, cors);
}

// ============== Cron: scan signet + mainnet for new CETCH envelopes ==============
async function fetchBlockTxs(env, blockHash, network, { maxTxs = 5000 } = {}) {
  const all = [];
  let startIdx = 0;
  while (true) {
    let txs;
    try { txs = await apiJson(env, `/block/${blockHash}/txs/${startIdx}`, {}, network); }
    catch { break; }
    if (!Array.isArray(txs) || txs.length === 0) break;
    all.push(...txs);
    if (txs.length < 25) break;
    startIdx += 25;
    // Mainnet blocks can be 3000+ txs (120+ pages); default cap of 5000 bounds
    // work per cron tick for the live-tip forward scan. The hint endpoint
    // catches anything missed by truncation. Backfill (issue #31 FAIR
    // recovery) passes a higher cap since dense legacy blocks are 5500+ txs
    // and we want the full tail to avoid reproducing the original silent-drop
    // bug. Subrequest budget is the real ceiling at 1000/invocation.
    if (all.length >= maxTxs) break;
  }
  return all;
}

// Backfill-only parallel variant of fetchBlockTxs. The sequential version
// above is fine for the cron's live-tip scan (1 block/tick, only the tail
// few pages matter); but the FAIR recovery walk has to revisit dense legacy
// blocks where mempool.space's /block/<hash>/txs/<N> endpoint takes 5+s per
// page and 22+ pages per block → 110s sequential, past CF's wall-time budget.
// Batches PARALLEL page-fetches at a time. Stops early when a partial page
// or empty array signals end-of-block. Drops the cron's 5000-tx cap because
// the backfill is rate-limited by the caller's height range, not by a
// per-block subrequest budget. Pages that error are surfaced as `null` and
// terminate the walk to avoid silently truncating mid-block.
async function fetchBlockTxsParallel(env, blockHash, network, { batch = 16, maxTxs = 8000 } = {}) {
  const pageSize = 25;
  const all = [];
  let startIdx = 0;
  while (all.length < maxTxs) {
    const offsets = [];
    for (let i = 0; i < batch; i++) offsets.push(startIdx + i * pageSize);
    // Retry each failed page once. Single transient failures in a parallel
    // batch shouldn't truncate the block; only persistent failures should
    // surface as an early-stop signal (returned via reject below).
    const pages = await Promise.all(offsets.map(async off => {
      try { return await apiJson(env, `/block/${blockHash}/txs/${off}`, {}, network); }
      catch {
        try { return await apiJson(env, `/block/${blockHash}/txs/${off}`, {}, network); }
        catch { throw new Error(`page ${off} failed twice`); }
      }
    }));
    let done = false;
    for (const page of pages) {
      if (!Array.isArray(page) || page.length === 0) { done = true; break; }
      all.push(...page);
      if (page.length < pageSize) { done = true; break; }
    }
    if (done) break;
    startIdx += batch * pageSize;
  }
  return all;
}

async function rewindLastScanned(env, from, network) {
  if (!Number.isInteger(from) || from < 0) throw new Error('from must be a non-negative integer');
  const tip = parseInt((await apiText(env, '/blocks/tip/height', {}, network)).trim(), 10);
  if (from > tip) throw new Error(`from (${from}) is ahead of tip (${tip})`);
  const key = lastScannedKey(network);
  const prior = parseInt((await env.REGISTRY_KV.get(key)) || '0', 10);
  if (from === 0) await env.REGISTRY_KV.delete(key);
  else await env.REGISTRY_KV.put(key, String(from - 1));
  return { rewound_to: from, prior_last_scanned: prior, tip, network };
}

async function scanForEtches(env, network) {
  // Distinguish "never scanned" (key absent) from "scanned through 0" (value
  // '0'). Without this distinction, `/rescan?from=1` writes '0' into the key
  // and the next tick mistakes that for "never scanned" and triggers backfill.
  const raw = await env.REGISTRY_KV.get(lastScannedKey(network));
  const lastScanned = raw === null ? -1 : parseInt(raw, 10);
  const tip = parseInt((await apiText(env, '/blocks/tip/height', {}, network)).trim(), 10);
  // Per-network blocks-per-tick budget (signet is sparse, mainnet is dense).
  const blocksPerTick = network === 'mainnet'
    ? safeInt(env.SCAN_BLOCKS_MAINNET, 1, { min: 1, max: 100 })
    : safeInt(env.SCAN_BLOCKS_SIGNET, 5, { min: 1, max: 100 });
  // Backfill window: signet has near-empty blocks so we backfill 2 weeks (2016
  // blocks); mainnet would be prohibitive at 3000 txs/block, so we start from
  // tip and only catch new etches going forward. Hint endpoint covers anything
  // historical the dApp owner cares about.
  const backfillBlocks = network === 'mainnet' ? 0 : 2016;
  const startHeight = lastScanned >= 0 ? lastScanned + 1 : Math.max(0, tip - backfillBlocks);
  const endHeight = Math.min(tip, startHeight + blocksPerTick);
  if (startHeight > tip) return { up_to_date: true, tip, network };

  let scanned = 0, found = 0;
  // Per-scan petch lookup cache. Each T_PMINT in the block-tx loop used to
  // do its own KV.get(petchKey(...)), so a dense block on a popular fair
  // launch (FAIR's etch+200 blocks landed ~300 reveals/block) burned
  // ~300 subrequests per block just on petch lookups. With the per-tx
  // KV.put for canonical entries plus the orphan-cleanup KV.delete on top,
  // the cron tipped past the 1000-subrequest budget mid-block and silently
  // skipped the rest of the T_PMINTs — leaving "confirmed but not credited"
  // mints in users' wallets that no rescan would heal because last_scanned
  // had already advanced. Caching keeps it at one petch lookup per asset
  // per scan tick.
  const _petchCache = new Map();
  const _petchLookup = async (aid) => {
    if (_petchCache.has(aid)) return _petchCache.get(aid);
    const v = await env.REGISTRY_KV.get(petchKey(network, aid), 'json');
    _petchCache.set(aid, v);
    return v;
  };
  // Per-scan dedupe set for petch_dirty markers. The T_PMINT branch below
  // would otherwise KV.put the same `petch_dirty:<aid>` key once per pmint —
  // for a dense fair-launch block (~300 reveals on FAIR), that's 300 writes
  // of the same value to the same key. Same scaling concern as the petch
  // lookup cache above. Batched once at end-of-scan.
  const _dirtyPetchAids = new Set();
  // Same pattern for T_DCLAIM (SPEC §5.12 / §5.13). One drop_progress dirty
  // marker per drop_id that saw a confirmed T_DCLAIM this scan.
  const _dirtyDropIds = new Set();
  // Seed at `startHeight - 1` so a transient API failure on the very first
  // block of a never-scanned network doesn't write `0` to KV and abandon the
  // entire backfill window. We only update `lastContiguous` after a block's
  // tx list completes, so the seed value is what gets persisted on early-exit.
  let lastContiguous = startHeight - 1;
  for (let h = startHeight; h <= endHeight; h++) {
    let blockHash;
    try { blockHash = (await apiText(env, `/block-height/${h}`, {}, network)).trim(); }
    catch { break; }
    let txs;
    try { txs = await fetchBlockTxs(env, blockHash, network); }
    catch { break; }
    // Track tx_index alongside the iteration so T_PMINT KV keys can record
    // the canonical block position (SPEC §5.9 ordering). mempool.space's
    // /block/<hash>/txs endpoint returns txs in block order, so the array
    // index IS the canonical tx_index.
    let txIndex = -1;
    for (const tx of txs) {
      txIndex++;
      scanned++;
      if (!tx.vin || !tx.vin[0] || !tx.vin[0].witness || tx.vin[0].witness.length < 3) continue;
      let envBytes;
      try { envBytes = hexToBytes(tx.vin[0].witness[1]); } catch { continue; }
      const decoded = decodeEnvelopeScript(envBytes);
      if (!decoded) continue;
      if (decoded.opcode === T_CETCH) {
        const ce = decodeCEtchPayload(decoded.payload);
        if (!ce) continue;
        const aid = assetIdFor(tx.txid, 0);
        const meta = {
          asset_id: aid,
          ticker: ce.ticker,
          decimals: ce.decimals,
          commitment: ce.commitment,
          image_uri: ce.image_uri,
          etch_txid: tx.txid,
          etch_vout: 0,
          etched_at_height: h,
          etched_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
          // Position-in-block (mempool.space returns txs in canonical block
          // order, so the array index IS the canonical tx_index). The Discover
          // sort uses this as a same-block tiebreaker so two CETCHes in one
          // block surface in actual chain order rather than asset_id lex
          // order. Old entries without this field fall back to lex order at
          // the dapp comparator; a /rescan backfills them.
          tx_index: txIndex,
          mintable: ce.mintable,
          mint_authority: ce.mint_authority,
          network,
        };
        await env.REGISTRY_KV.put(assetKey(network, aid), JSON.stringify(meta));
        // First holder = the etcher at vout[0]. Bump the holder counter so
        // freshly-etched assets show "1 wallet" not "0 wallets".
        const etchSpk = tx.vout?.[0]?.scriptpubkey;
        if (typeof etchSpk === 'string' && etchSpk.length > 0) {
          try { await bumpHolderCount(env, network, aid, etchSpk.toLowerCase()); } catch {}
        }
        found++;
      } else if (decoded.opcode === T_MINT) {
        const cm = decodeCMintPayload(decoded.payload);
        if (!cm) continue;
        const mintMeta = {
          asset_id: cm.asset_id,
          etch_txid: cm.etch_txid,
          mint_txid: tx.txid,
          mint_vout: 0,
          commitment: cm.commitment,
          minted_at_height: h,
          minted_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
          network,
        };
        await env.REGISTRY_KV.put(mintKeyFor(network, cm.asset_id, tx.txid), JSON.stringify(mintMeta));
        // Mint recipient at vout[0] is a new holder for this asset.
        const mintSpk = tx.vout?.[0]?.scriptpubkey;
        if (typeof mintSpk === 'string' && mintSpk.length > 0) {
          try { await bumpHolderCount(env, network, cm.asset_id, mintSpk.toLowerCase()); } catch {}
        }
        found++;
      } else if (decoded.opcode === T_BURN) {
        const cb = decodeCBurnPayload(decoded.payload);
        if (!cb) continue;
        const burnMeta = {
          asset_id: cb.asset_id,
          burn_txid: tx.txid,
          burned_amount: cb.burned_amount,
          burned_at_height: h,
          burned_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
          network,
        };
        await env.REGISTRY_KV.put(burnKeyFor(network, cb.asset_id, tx.txid), JSON.stringify(burnMeta));
        found++;
      } else if (decoded.opcode === T_CXFER || decoded.opcode === T_AXFER) {
        // Confidential transfer (T_CXFER) or atomic-OTC settlement reveal
        // (T_AXFER). Both move asset value between holders; bump a single
        // per-asset counter so /assets can surface a "movement" stat without
        // paying the cost of a full per-tx index. The xferseen dedupe key
        // makes hint+cron idempotent: whichever path sees the tx first wins,
        // the other no-ops. Mid-block-crash re-scans no longer double-count.
        const decoder = decoded.opcode === T_AXFER ? decodeAxferPayload : decodeCXferPayload;
        const dx = decoder(decoded.payload);
        if (!dx) continue;
        await bumpTransferCount(env, network, dx.asset_id, tx.txid);
        // Per-asset holder counter: each output's recipient scriptpubkey is
        // a candidate new wallet. Walk the tx outputs that correspond to
        // tacit asset commitments (dx.outputs.length aligns with
        // tx.vout[0..N-1] by SPEC layout for both opcodes) and bump the
        // counter for each previously-unseen recipient. holderSeen dedup
        // makes this idempotent across cron re-scans.
        for (let i = 0; i < dx.outputs.length && i < (tx.vout?.length || 0); i++) {
          const spk = tx.vout[i]?.scriptpubkey;
          if (typeof spk === 'string' && spk.length > 0) {
            try { await bumpHolderCount(env, network, dx.asset_id, spk.toLowerCase()); } catch {}
          }
        }
        // Don't increment `found` — that counter is for new etches/mints/
        // burns specifically (used in the cron's status return). Transfers
        // happen on every active asset; counting them as "found" would be
        // misleading.
      } else if (decoded.opcode === T_PETCH) {
        // Permissionless-mint deployment record (SPEC §5.8). T_PETCH never
        // produces a tacit UTXO — its only role is to register the issuance
        // schedule. Stored under a distinct `petch:*` namespace so /assets
        // (which lists CETCH-rooted assets) and /petch-assets (which lists
        // these) can be filtered cleanly without one polluting the other.
        const cp = decodeCPetchPayload(decoded.payload);
        if (!cp) continue;
        // SPEC §5.8: if mint_start_height ≠ 0, it MUST be ≥ etch_height + 1.
        // The decoder defers this (it doesn't see etch_height); enforce here
        // so a deployer can't set mint_start_height = etch_height to bypass
        // the §5.9 step-4 same-block defense and premine into their own
        // T_PETCH. Non-conforming T_PETCHes are dropped entirely.
        if (cp.mint_start_height !== 0 && cp.mint_start_height < h + 1) continue;
        const aid = assetIdFor(tx.txid, 0);
        const meta = {
          asset_id: aid,
          ticker: cp.ticker,
          decimals: cp.decimals,
          cap_amount: cp.cap_amount,
          mint_limit: cp.mint_limit,
          mint_start_height: cp.mint_start_height,
          mint_end_height: cp.mint_end_height,
          image_uri: cp.image_uri,
          etch_txid: tx.txid,
          etch_vout: 0,
          etched_at_height: h,
          etched_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
          kind: 'petch',
          network,
        };
        await env.REGISTRY_KV.put(petchKey(network, aid), JSON.stringify(meta));
        found++;
      } else if (decoded.opcode === T_PMINT) {
        // Permissionless mint event (SPEC §5.9). Cron-side validation block:
        // structurally-valid envelopes pass the decoder length/opcode checks
        // but the cron must additionally enforce:
        //
        //   §5.9 step 1: asset_id == sha256(etch_txid_BE || 0_LE). Without
        //     this an attacker can broadcast a T_PMINT claiming a victim's
        //     real asset_id with a forged etch_txid; the cron would write
        //     under the victim's pmint:* namespace, poisoning the cap
        //     counter on /petch-assets and (eventually) disabling the Mint
        //     button across all wallets. Each grief envelope costs full
        //     Bitcoin fees but the asymmetry is one bad mint affects every
        //     viewer's UI.
        //   §5.9 step 2: parent envelope at etch_txid is T_PETCH (not
        //     CETCH or anything else). Cross-mode references would index a
        //     T_PMINT against an asset that has no cap_amount/mint_limit
        //     metadata — read-side cap arithmetic divides by zero and the
        //     dapp's UI shows wrong state.
        //   §5.9 step 3: amount == petch.mint_limit. T_PMINT is the
        //     non-substitutable per-mint tranche; an envelope with a
        //     different amount is malformed and shouldn't credit.
        //   §5.9 step 4: confirmed_height in [effective_start,
        //     effective_end]. This is the structural defense of the
        //     "zero deployer allocation" property — without it, a deployer
        //     who broadcasts T_PETCH and T_PMINT in the same block would
        //     have the cap counter credit their same-block premine even
        //     though dapp wallets correctly reject it.
        //
        // The dapp's validateOutpoint catches all four client-side, so
        // wallets never credit the bad UTXOs as holdings. But /petch-assets
        // is what every Discover view + every Mint button reads, and that's
        // the surface this validation block protects.
        const cm = decodeCPmintPayload(decoded.payload);
        if (!cm) continue;
        // §5.9 step 1: asset_id derivation.
        const expectedAid = assetIdFor(cm.etch_txid, 0);
        if (expectedAid !== cm.asset_id) continue;
        // §5.9 step 2: parent must be T_PETCH. Lookup by the DERIVED asset_id
        // rather than the (potentially forged) cm.asset_id so a payload that
        // somehow slipped past step 1 still resolves to the right namespace.
        // Cached across the scan invocation — see _petchLookup above for why.
        const petch = await _petchLookup(expectedAid);
        if (!petch) continue;   // T_PETCH not yet indexed — re-scan picks it up
        // §5.9 step 3: amount equals mint_limit (BigInt compare; both are
        // base-10 strings in the metadata + decoder).
        try {
          if (BigInt(cm.amount) !== BigInt(petch.mint_limit)) continue;
        } catch { continue; }
        // §5.9 step 4: height window. effective_start = mint_start_height ||
        // (etch_height + 1); effective_end = mint_end_height || ∞. Any mint
        // outside that window is permanently invalid and must not be counted.
        const startH = Number(petch.mint_start_height) || 0;
        const endH   = Number(petch.mint_end_height)   || 0;
        const etchedAt = Number(petch.etched_at_height) || 0;
        const effectiveStart = startH !== 0 ? startH : etchedAt + 1;
        if (h < effectiveStart) continue;
        if (endH !== 0 && h > endH) continue;
        // §5.9 step 5: Pedersen binding. (amount, blinding) are public in the
        // envelope, so the indexer must recompute pedersenCommit(amount, blinding)
        // and verify it equals the declared commitment. Without this gate, any
        // structurally-valid envelope with a forged commitment lands in the
        // canonical pmint:* namespace, occupies a slot in cap accounting, and
        // (for the dapp consumer) is recognized as not-mine but credit-bearing.
        // The dapp's recovery path always re-checks this binding, so a worker
        // that skips it is silently more permissive than every wallet.
        if (!pmintCommitmentOpens(cm.amount, cm.blinding, cm.commitment)) continue;
        const mintMeta = {
          asset_id: expectedAid,   // canonical derived id, not the claimed one
          etch_txid: cm.etch_txid,
          mint_txid: tx.txid,
          mint_vout: 0,
          commitment: cm.commitment,
          amount: cm.amount,
          blinding: cm.blinding,
          minted_at_height: h,
          minted_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
          kind: 'pmint',
          network,
        };
        // Write under (height, tx_index, txid) — see pmintKeyFor for why
        // tx_index is required by SPEC §5.9 ordering. The txid suffix is
        // a tiebreaker only used when an ill-formed indexer passes
        // duplicate (height, tx_index); under canonical chain order it
        // never differs.
        mintMeta.tx_index = txIndex;
        const pmk = pmintKeyFor(network, expectedAid, h, txIndex, tx.txid);
        await env.REGISTRY_KV.put(pmk, JSON.stringify(mintMeta));
        // Pmint recipient at vout[0] is a new wallet holding this asset.
        // For fair-launch tokens, each mint is a different wallet (the
        // public minter) so this is the primary holder-discovery path.
        const pmintSpk = tx.vout?.[0]?.scriptpubkey;
        if (typeof pmintSpk === 'string' && pmintSpk.length > 0) {
          try { await bumpHolderCount(env, network, expectedAid, pmintSpk.toLowerCase()); } catch {}
        }
        // Stage this asset for dirty-marking. Deferred to end-of-scan so a
        // dense block with 300 pmints for one asset writes the marker once
        // (≤1 KV.put) instead of 300 times. The end-of-scan loop converts
        // the Set into actual KV writes.
        _dirtyPetchAids.add(expectedAid);
        // Stale-orphan cleanup is delegated to the dedicated orphan
        // promoter (promotePmintOrphans, run on every cron tick) rather
        // than inline KV.delete — on dense fair-launch blocks (~300
        // reveals each), an inline delete per T_PMINT can tip the cron
        // past the 1000-subrequest budget mid-block and silently drop
        // the tail of T_PMINTs from canonical indexing.
        found++;
      } else if (decoded.opcode === T_DEPOSIT) {
        // SPEC §5.10. Two payload shapes share opcode 0x29:
        //   - POOL_INIT (denomination = 0 sentinel): registers a new pool.
        //     First-confirmed-wins per §5.10.1; subsequent inits for the
        //     same (asset_id, pool_denom) are ignored.
        //   - Standard deposit: appends a leaf to the pool's merkle tree at
        //     a canonical position derived from (height, tx_index, txid).
        //
        // Standard deposits are gated by the kernel sig check below, which
        // walks vin[1] to recover C_in and verifies the BIP-340 sig under
        // (C_in − denomination·H).x_only(). This enforces the Conservation
        // invariant (SPEC §5.11.4 invariant 1): the leaf is only indexed if
        // the deposit genuinely consumed `denomination` of `asset_id`. The
        // dapp re-runs the same check as defense-in-depth before appending
        // worker-supplied leaves to its local merkle tree.
        const td = decodeTDepositPayload(decoded.payload);
        if (!td) continue;
        if (td.kind === 'pool_init') {
          const k = poolInitKey(network, td.asset_id, td.pool_denom);
          const existing = await env.REGISTRY_KV.get(k);
          if (!existing) {
            const meta = {
              asset_id: td.asset_id,
              pool_denom: td.pool_denom,
              vk_cid: td.vk_cid,
              ceremony_cid: td.ceremony_cid,
              init_height: h,
              init_txid: tx.txid,
              init_sig: td.init_sig,
              network,
            };
            await env.REGISTRY_KV.put(k, JSON.stringify(meta));
            found++;
          }
          // else first-confirmed-wins: silently ignore re-inits.
        } else if (td.kind === 'deposit') {
          // Skip leaf-write if the pool isn't initialized yet — same
          // "metadata not yet indexed" tolerance as T_PMINT's petch lookup.
          // A re-scan will pick up these deposits once their POOL_INIT is
          // canonicalized. NOTE: re-scans only happen via /rescan; in normal
          // forward-only operation a deposit before its POOL_INIT in the
          // same scan window is silently dropped.
          const initRec = await env.REGISTRY_KV.get(poolInitKey(network, td.asset_id, td.denomination), 'json');
          if (!initRec) continue;
          // SPEC §5.10 / §5.11.4 invariant 1 — Conservation. Verify the
          // BIP-340 kernel sig under (C_in − denomination·H).x_only() before
          // appending the leaf. Without this, any well-formed envelope (with
          // garbage kernel_sig) would be indexed as a real deposit; the
          // depositor could then withdraw their own leaf and steal pool
          // value (free inflation). The signing message binds asset_id,
          // denomination, the consumed input outpoint, and the leaf
          // commitment, so no cross-leaf or cross-pool replay is possible.
          const kernelOk = await verifyMixerDepositKernel(
            env, tx, td.asset_id, td.denomination,
            td.leaf_commitment, td.kernel_sig, network,
          );
          if (!kernelOk) continue;
          // SPEC §3.6 fixed-depth merkle tree (L=20). Refuse to index a
          // leaf that would push the pool past 2^20 entries — the dapp's
          // mixerAppendLeaf locally enforces the same cap, and a worker
          // over-index would diverge from any conforming indexer. Counter
          // drift on reorgs (over-counts when a leaf reorgs out) only
          // makes us reject earlier, never later, so it's safe.
          const cntKey = poolLeafCountKey(network, td.asset_id, td.denomination);
          const cnt = parseInt(await env.REGISTRY_KV.get(cntKey) || '0', 10);
          if (cnt >= POOL_LEAF_CAP) continue;
          const leafKey = poolLeafKeyFor(network, td.asset_id, td.denomination, h, txIndex, tx.txid);
          const leafMeta = {
            asset_id: td.asset_id,
            denomination: td.denomination,
            leaf_commitment: td.leaf_commitment,
            deposit_txid: tx.txid,
            tx_index: txIndex,
            deposited_at_height: h,
            deposited_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
            network,
          };
          await env.REGISTRY_KV.put(leafKey, JSON.stringify(leafMeta));
          await env.REGISTRY_KV.put(cntKey, String(cnt + 1));
          found++;
        }
      } else if (decoded.opcode === T_WITHDRAW) {
        // SPEC §5.11. Worker records the nullifier as spent — the dApp
        // verifies the Groth16 proof + recent-root check at consume time.
        // Indexing without verification is safe: a structurally-decoded
        // withdraw whose proof fails on the client will be rejected by the
        // dApp's validator regardless of whether the nullifier was indexed.
        // Conversely, indexing an unverified withdraw can't enable double-
        // spend because the dApp re-checks both nullifier-set membership
        // AND proof validity.
        const tw = decodeTWithdrawPayload(decoded.payload);
        if (!tw) continue;
        const initRec = await env.REGISTRY_KV.get(poolInitKey(network, tw.asset_id, tw.denomination), 'json');
        if (!initRec) continue;
        const nKey = poolNullifierKey(network, tw.asset_id, tw.denomination, tw.nullifier_hash);
        const existing = await env.REGISTRY_KV.get(nKey);
        if (!existing) {
          const meta = {
            asset_id: tw.asset_id,
            denomination: tw.denomination,
            nullifier_hash: tw.nullifier_hash,
            withdraw_txid: tx.txid,
            withdrawn_at_height: h,
            withdrawn_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
            network,
          };
          await env.REGISTRY_KV.put(nKey, JSON.stringify(meta));
          found++;
        }
      } else if (decoded.opcode === T_DROP) {
        // SPEC §5.12. Two payload shapes share opcode 0x2B:
        //   - Standard (per_claim > 0): registers a new claim pool keyed by
        //     drop_id = SHA256(reveal_txid_BE || 0_LE). Cron extracts the
        //     declared (asset_id, cap, per_claim, merkle_root, expiry,
        //     ticker, decimals) and pins them under drop:<network>:<drop_id>.
        //     No tacit UTXO is produced — vout 0 is a pool marker.
        //   - Reclaim (per_claim = 0 sentinel, SPEC §5.12.1): depositor
        //     reclaims the unclaimed remainder. Produces ONE tacit UTXO at
        //     vout 0. The cron's role here is to recognize the shape; the
        //     cap-credit verification (cap_amount == canonical remainder)
        //     happens at the dapp's validator + a future scanDrops pass.
        //     Today we record the reclaim event under a reclaim:<...> key
        //     so the original drop's drop_progress snapshot can show it as
        //     "closed by reclaim" without scanning every tx.
        const cd = decodeCDropPayload(decoded.payload);
        if (!cd) continue;
        if (cd.kind === 'cdrop') {
          // Standard drop: derive drop_id and write metadata. The kernel-sig
          // soundness gate (Σ C_in − cap_amount·H verifies) requires walking
          // the asset inputs and their parent commitments — that's the
          // dapp validator's job. The cron stores the declared metadata so
          // downstream readers (the dapp's T_DCLAIM validator, GET endpoints)
          // can look it up by drop_id; structurally-malformed drops are
          // already rejected by decodeCDropPayload.
          const dropId = bytesToHex(dropIdFromRevealTxid(tx.txid));
          const meta = {
            drop_id: dropId,
            drop_reveal_txid: tx.txid,
            asset_id: cd.asset_id,
            cap_amount: cd.cap_amount,
            per_claim: cd.per_claim,
            merkle_root: cd.merkle_root,
            expiry_height: cd.expiry_height,
            ticker: cd.ticker,
            decimals: cd.decimals,
            asset_input_count: cd.asset_input_count,
            drop_at_height: h,
            drop_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
            kind: 'drop',
            network,
          };
          // First-canonically-confirmed-wins per drop_id — but drop_id derives
          // from the reveal tx itself, so two confirmed T_DROPs with the same
          // drop_id are structurally impossible. A re-scan that hits the same
          // reveal tx re-writes the same metadata, which is idempotent.
          await env.REGISTRY_KV.put(dropKey(network, dropId), JSON.stringify(meta));
          found++;
        } else if (cd.kind === 'cdrop-reclaim') {
          // Reclaim shape: record under the original drop's progress for
          // discoverability. The reclaim's own UTXO credit is gated on a
          // future scanDrops pass that knows the canonical cumulative
          // claim count at reclaim's depth-3 acceptance. Recording the
          // event here is informational only.
          const meta = {
            kind: 'drop-reclaim',
            reclaim_drop_id: cd.reclaim_drop_id,
            reclaim_txid: tx.txid,
            asset_id: cd.asset_id,
            cap_amount: cd.cap_amount,    // declared by depositor; verified at consume time
            cap_blinding: cd.cap_blinding,
            reclaim_sig: cd.reclaim_sig,
            reclaim_at_height: h,
            reclaim_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
            network,
          };
          const reclaimKey = network === 'signet'
            ? `drop-reclaim:${cd.reclaim_drop_id}`
            : `drop-reclaim:${network}:${cd.reclaim_drop_id}`;
          await env.REGISTRY_KV.put(reclaimKey, JSON.stringify(meta));
          found++;
        }
      } else if (decoded.opcode === T_DCLAIM) {
        // SPEC §5.13. Permissionless claim event against a T_DROP parent.
        // Cron-side validation mirrors T_PMINT's gate:
        //   §5.13 step 2: drop_id derives from drop_reveal_txid; parent envelope
        //                 at drop_reveal_txid is T_DROP standard (not reclaim).
        //   §5.13 step 3: amount == drop.per_claim.
        //   §5.13 step 5: cumulative_claimed + amount ≤ cap_amount (cap_overflow).
        //   §5.13 step 6: if merkle-gated, witness verifies (recipient_pub
        //                 binding, merkle proof, eth_sig recovery) AND
        //                 (drop_id, leaf_index) not previously claimed.
        //   §5.13 step 7: Pedersen open: pedersenCommit(amount, blinding) == commitment.
        //
        // The dapp's validateOutpoint covers all of these client-side too, so
        // wallets never credit a bad UTXO regardless of whether the cron
        // indexed it. The cron's job is the cap-progress snapshot + the
        // claimed-leaf nullifier set, which read-side endpoints surface.
        const cdc = decodeCDClaimPayload(decoded.payload);
        if (!cdc) continue;
        const dropId = bytesToHex(dropIdFromRevealTxid(cdc.drop_reveal_txid));
        // Parent drop must be indexed first. If we hit this in the same scan
        // window as the parent T_DROP and the T_DROP comes after the T_DCLAIM
        // in canonical order (impossible on Bitcoin chain — drop must confirm
        // before its claims spend its drop_id reference), or if the parent is
        // unknown (cron lag, reorg), skip and let a re-scan catch it.
        const drop = await env.REGISTRY_KV.get(dropKey(network, dropId), 'json');
        if (!drop || drop.kind !== 'drop') continue;
        // §5.13 step 3: amount == drop.per_claim.
        try {
          if (BigInt(cdc.amount) !== BigInt(drop.per_claim)) continue;
        } catch { continue; }
        // Expiry: confirmed_height ≤ drop.expiry_height (when set).
        if (drop.expiry_height !== 0 && h > drop.expiry_height) continue;
        // §5.13 step 7: Pedersen binding. Reuses pmintCommitmentOpens since
        // both opcodes carry plaintext (amount, blinding) and a Pedersen
        // commitment — identical opening check.
        if (!pmintCommitmentOpens(cdc.amount, cdc.blinding, cdc.commitment)) continue;
        // §5.13 step 6: eligibility gate. Merkle-gated drops require witness;
        // open drops require empty witness.
        const merkleRootZero = /^0+$/.test(drop.merkle_root);
        if (merkleRootZero) {
          if (cdc.witness) continue;
        } else {
          if (!cdc.witness) continue;
          // (drop_id, leaf_index) nullifier check. Indexer atomically
          // checks + inserts — if the leaf is already in the set, this
          // T_DCLAIM is a double-claim and is rejected.
          const leafKey = dclaimLeafKey(network, dropId, cdc.witness.leaf_index);
          const existingLeaf = await env.REGISTRY_KV.get(leafKey);
          if (existingLeaf) continue;
          // Merkle proof + eth_sig + recipient_pub binding are NOT re-verified
          // here — they're the dapp's validator job, identical to how T_PMINT
          // structural verification is dapp-side. The cron's role is the cap
          // counter + nullifier set + metadata cache. A T_DCLAIM that passes
          // here but has a bad merkle proof is rejected by every wallet on
          // load; the only "regression" is that it still occupies a cap slot
          // — same cost-symmetric posture as T_PMINT rewrap (SPEC §5.13
          // Replay analysis).
          await env.REGISTRY_KV.put(leafKey, JSON.stringify({
            drop_id: dropId,
            leaf_index: cdc.witness.leaf_index,
            eth_address: cdc.witness.eth_address,
            claim_txid: tx.txid,
            claimed_at_height: h,
            network,
          }));
        }
        // §5.13 step 5: cap_overflow ordering. Same KV.list-based canonical
        // ordering as T_PMINT — keys embed (height, tx_index, txid) so a
        // lex sort = canonical chain order. The CAP check happens at
        // read time via the drop_progress snapshot, NOT here, so dense-block
        // dclaim flows aren't bottlenecked on a serial KV.list per claim
        // (matching the T_PMINT optimization that was load-bearing for
        // FAIR's fair-launch hour).
        const claimMeta = {
          drop_id: dropId,
          drop_reveal_txid: cdc.drop_reveal_txid,
          asset_id: cdc.asset_id,
          commitment: cdc.commitment,
          amount: cdc.amount,
          blinding: cdc.blinding,
          witness: cdc.witness,    // null for open drops, object for merkle-gated
          claim_txid: tx.txid,
          claim_vout: 0,
          tx_index: txIndex,
          claimed_at_height: h,
          claimed_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
          kind: 'dclaim',
          network,
        };
        const dck = dclaimKeyFor(network, dropId, h, txIndex, tx.txid);
        await env.REGISTRY_KV.put(dck, JSON.stringify(claimMeta));
        // Stage dirty marker; the end-of-scan loop materializes one KV write
        // per dirty drop_id (mirrors the petch dirty-set pattern).
        if (typeof _dirtyDropIds === 'object' && _dirtyDropIds) _dirtyDropIds.add(dropId);
        found++;
      }
    }
    lastContiguous = h;
  }
  // Flush deferred petch_dirty markers BEFORE advancing lastScanned. One
  // write per unique asset that saw a confirmed T_PMINT this scan. Ordering
  // matters: if the worker is killed between these two writes, the next
  // tick must re-scan the same blocks to re-create the dirty markers.
  // Writing lastScanned first would advance past those blocks, leaving
  // their assets' snapshots stale until another pmint or admin rebuild.
  // markPetchDirty is idempotent so re-scans cost no extra correctness.
  for (const aid of _dirtyPetchAids) {
    await markPetchDirty(env, network, aid);
  }
  // Same flush for T_DCLAIM-touched drops. Schedules a drop_progress
  // recompute on the next read or admin rebuild.
  for (const dropId of _dirtyDropIds) {
    // TTL keeps the marker bounded so a permanently-stuck recompute (e.g.,
    // a malformed drop record) doesn't leak storage. The 1-day TTL matches
    // petch_dirty's posture.
    await env.REGISTRY_KV.put(dropDirtyKey(network, dropId), '1', { expirationTtl: 86400 });
  }
  await env.REGISTRY_KV.put(lastScannedKey(network), String(lastContiguous));
  return { scanned_txs: scanned, found_etches: found, from: startHeight, to: lastContiguous, tip, network };
}

// Named exports for cross-impl parity tests in the test harness. Cloudflare
// Workers ignores extra named exports — only the default object's fetch /
// scheduled handlers are invoked at runtime — so this has no production effect.
export {
  openingMsg, disclosureMsg, listingMsg, cancelMsg, claimMsg,
  atomicIntentMsg, atomicIntentClaimMsg, atomicIntentFulfilmentMsg, atomicIntentCancelMsg,
  // T_AXFER_VAR (§5.7.6.1) — variable-amount atomic-intent message helpers.
  // Exported so tests/worker-axintent-var can pin byte-for-byte determinism
  // of intent_id derivation, message-byte equality with the dapp side, and
  // signature-verification round-trip before the handler PRs wire them in.
  atomicIntentIdHexVar,
  atomicIntentPublishMsgVar, atomicIntentClaimMsgVar, atomicIntentFulfilmentMsgVar,
  verifyAtomicIntentPublishSig,
  // Preauth-sale helpers (SPEC §5.7.8). Exported so the dapp/worker parity
  // tests can pin message-byte equality + cross-check the BIP-143 sighash
  // reconstruction; drift here silently breaks the seller-spend signature
  // verification on every POST.
  preauthSaleAuthMsg, preauthSaleCancelMsg, preauthSaleIdHex,
  preauthSellerSpendSighash, derToCompactSig, verifyEcdsaDerSig,
  dropAnnounceMsg, dropAnnounceCancelMsg, airdropClaimDeleteMsg,
  bidIntentMsg, bidClaimMsg, bidCancelMsg,
  // Deterministic CAS overshoot resolver for variable-fill bid POSTs.
  // Exported so tests can pin the resolution rule (sort by axintent_id
  // ascending → greedy keep until sum ≤ bid.amount → evict the rest)
  // without setting up the full handler's KV / signature path. The
  // signet e2e harness covers the integrated flow.
  _resolveBidPartialOvershoot,
  verifySchnorr, compressedPointFromHex,
  // Wire-format decoders + opcode constants exported so tests/worker-decoder
  // can pin down the exact return shape. The atomic-intent regression where
  // a handler read `ax.assetInputCount` (camelCase) against a snake_case
  // `asset_input_count` was silent in JS — this surface lets a test fail loudly
  // if any decoder's return-shape contract drifts.
  decodeEnvelopeScript,
  decodeCEtchPayload, decodeCMintPayload, decodeCXferPayload, decodeAxferPayload, decodeAxferVarPayload, decodeCBurnPayload,
  decodeCPetchPayload, decodeCPmintPayload,
  decodeTDepositPayload, decodeTWithdrawPayload,
  encodeCDropPayload, encodeCDropReclaimPayload, decodeCDropPayload,
  encodeCDClaimPayload, encodeCDClaimWitness, decodeCDClaimPayload,
  dropIdFromRevealTxid,
  T_CETCH, T_CXFER, T_MINT, T_BURN, T_AXFER, T_AXFER_VAR, T_PETCH, T_PMINT, T_DEPOSIT, T_WITHDRAW, T_DROP, T_DCLAIM,
  // Mixer kernel-sig verifier — exported so tests/mixer-conservation can
  // drive it directly against a stubbed apiJson/fetch and confirm the
  // Conservation invariant (SPEC §5.11.4 #1) is enforced. Without dedicated
  // negative coverage for this gate, the indexer test suite trained itself
  // around garbage kernel sigs ('00'.repeat(64)) and missed the inflation
  // vector when the gate wasn't wired in the cron at all.
  verifyMixerDepositKernel, commitmentForUtxo,
  // SPEC §5.9 cap-credit policy + the function that applies it. Exported so
  // the petch-pmint test can simulate full canonical-order scenarios
  // (depth-gated crediting, cap-overflow rejection, reorg-revoke) against
  // an in-memory KV stub without spinning up Cloudflare's runtime.
  PMINT_CONFIRMATION_DEPTH, loadCanonicalPmints,
  // Commitment-opening gate applied by the cron + hint indexers (issue #31
  // Problem #3). Exported so tests can pin the valid / mismatch / malformed-
  // point cases without reaching into the cron's block loop. `pedersenCommit`
  // is exported alongside so tests can synthesize valid (amount, blinding,
  // commitment) tuples without re-deriving the NUMS-H generator.
  pmintCommitmentOpens, pedersenCommit,
  // Snapshot-based cap-progress layer (the O(1) read replacement for
  // loadCanonicalPmints fan-out). Exported so tests can simulate the
  // refresh/read/dirty-mark lifecycle without a live Cloudflare runtime.
  refreshPetchProgress, refreshAndStorePetchProgress, readPetchProgress,
  markPetchDirty, refreshDirtyPetchSnapshots,
  petchProgressKey, petchDirtyKey,
  // Airdrop merkle helpers (SPEC §5.13). Exported so tests/worker-contract
  // can pin byte-for-byte parity with the dapp's airdropLeafHash /
  // buildAirdropMerkle — the worker uses these in /pin-airdrop-snapshot to
  // recompute the root and refuse rows-don't-hash-to-declared-root pins.
  // A regression here would silently let buggy snapshots through the pin
  // gate and surface only when recipients fail to claim.
  _airdropLeafHash, _buildAirdropMerkleRoot,
};

// ============== ROUTER ==============
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/pin' && req.method === 'POST')      return handlePin(req, env, cors);
    if (url.pathname === '/pin-json' && req.method === 'POST') return handlePinJson(req, env, cors);
    if (url.pathname === '/pin-mixer-vk' && req.method === 'POST') return handlePinMixerVk(req, env, cors);
    if (url.pathname === '/pin-airdrop-snapshot' && req.method === 'POST') return handlePinAirdropSnapshot(req, env, cors);
    if (url.pathname === '/ceremony/init' && req.method === 'POST') return handleCeremonyInit(req, env, cors);
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})$/i);
      if (m && req.method === 'GET') {
        const hash = m[1].toLowerCase();
        // 5s edge cache: ceremony state advances at most once per
        // contribution (~1-5 / sec at peak), so 5s is a fine staleness
        // budget and collapses thousands of concurrent state-poll calls
        // from open dapp tabs into one real KV lookup per PoP.
        return ceremonyCacheGet(ctx, cors, 5, `https://_ceremony-cache_/state/${hash}`,
          () => handleCeremonyState(env, hash, cors));
      }
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/contribute$/i);
      if (m && req.method === 'POST') return handleCeremonyContribute(req, env, m[1].toLowerCase(), cors, ctx);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/attestations$/i);
      if (m && req.method === 'GET') {
        const hash = m[1].toLowerCase();
        // Cursor-based pagination is per-page audit work — caching adds
        // no value and would just waste edge memory. Default-mode
        // (no cursor) is the hot path that polling UIs hit; cache it.
        // Use .has() not .get() so `?cursor=` (empty value, used to
        // start a forward walk from genesis) ALSO bypasses cache.
        // Without .has(), `?cursor=` was sharing a cache entry with
        // recent-mode requests at the same limit, returning newest-N
        // records instead of the genesis-start-forward chunk.
        if (url.searchParams.has('cursor')) {
          return handleCeremonyAttestations(req, env, url, hash, cors);
        }
        // Cache key includes limit so different limit values get their
        // own cache entry (a request for limit=20 doesn't replay a
        // limit=100 cached body, which would be wrong).
        const limit = url.searchParams.get('limit') || '100';
        return ceremonyCacheGet(ctx, cors, 30, `https://_ceremony-cache_/attestations/${hash}/${limit}`,
          () => handleCeremonyAttestations(req, env, url, hash, cors));
      }
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/stats$/i);
      if (m && req.method === 'GET') {
        const hash = m[1].toLowerCase();
        // 30s edge cache: stats counts grow steadily but slowly relative
        // to typical poll rates from observers. 30s lag on a live counter
        // is invisible UX-wise and collapses ~98% of poll cost.
        return ceremonyCacheGet(ctx, cors, 30, `https://_ceremony-cache_/stats/${hash}`,
          () => handleCeremonyStats(req, env, hash, cors));
      }
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/reset$/i);
      if (m && req.method === 'POST') return handleCeremonyReset(req, env, m[1].toLowerCase(), cors);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/finalize$/i);
      if (m && req.method === 'POST') return handleCeremonyFinalize(req, env, m[1].toLowerCase(), cors, ctx);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/drain$/i);
      if (m && req.method === 'POST') return handleCeremonyDrain(req, env, m[1].toLowerCase(), cors, ctx);
    }
    if (url.pathname === '/balance' && req.method === 'GET')   return handleBalance(env, cors);
    if (url.pathname === '/drip' && req.method === 'POST')     return handleDrip(req, env, cors);
    // Network is selected via ?network=signet|mainnet. Default is signet so a
    // no-network call (legacy clients) doesn't accidentally hit mainnet KV.
    // The current dapp explicitly passes ?network=mainnet for mainnet ops.
    const network = parseNetwork(url.searchParams.get('network'));

    // /pools — list initialized mixer pools (SPEC §5.10.1). Returns each
    // pool's POOL_INIT record + leaf/nullifier counts. The dApp consumes
    // this on Mixer-tab open; per-pool detail (full leaf list + nullifier
    // set) lives at /pools/:asset_id/:denom.
    //
    // Pagination: ?cursor=<opaque> + ?limit=<N> for forward pagination.
    // Default (no cursor): returns the first page; response includes a
    // cursor field if more pools exist. Limit is capped to keep within the
    // 1000-subrequest-per-invocation worker budget — each pool costs 3
    // subrequests (1 init record get + 2 KV.list calls for leaf/null counts).
    if (url.pathname === '/pools' && req.method === 'GET') {
      const POOLS_PAGE_MAX = 200; // 200 × 3 = 600 subrequests, safe under cap
      const reqLimit = safeInt(url.searchParams.get('limit'), POOLS_PAGE_MAX,
                                { min: 1, max: POOLS_PAGE_MAX });
      const cursor = url.searchParams.get('cursor') || undefined;
      const listOpts = { prefix: poolPrefix(network), limit: reqLimit };
      if (cursor) listOpts.cursor = cursor;
      const list = await env.REGISTRY_KV.list(listOpts);
      const pools = [];
      // Parallelize the per-pool fanout (init record + 1 counter get +
      // 1 nullifier list call each) so latency stays bounded as pool
      // count grows. Sequential awaits would 3×-multiply round-trip
      // latency for large pages.
      //
      // Leaf count comes from the dedicated poolLeafCountKey counter
      // (maintained on every indexed deposit, see scanForEtches). It's
      // exact and O(1) — preferred over KV.list.keys.length which capped
      // at 1000 and silently truncated past that. Nullifier count still
      // uses KV.list since there's no nullifier counter; capped at 1000
      // with a truncated flag for honest reporting.
      const perPool = await Promise.all(list.keys.map(async k => {
        const rec = await env.REGISTRY_KV.get(k.name, 'json');
        if (!rec) return null;
        const [leafCntStr, nullL] = await Promise.all([
          env.REGISTRY_KV.get(poolLeafCountKey(network, rec.asset_id, rec.pool_denom)),
          env.REGISTRY_KV.list({
            prefix: poolNullifierPrefix(network, rec.asset_id, rec.pool_denom),
            limit: 1000,
          }),
        ]);
        const leafCount = parseInt(leafCntStr || '0', 10) || 0;
        return {
          ...rec,
          leaf_count: leafCount,
          nullifier_count: nullL.keys.length,
          // leaf count is exact (counter); nullifier count remains a
          // lower bound past 1000 until a counter is added.
          nullifier_count_truncated: nullL.list_complete === false,
        };
      }));
      for (const p of perPool) if (p) pools.push(p);
      const body = {
        pools,
        network,
        list_complete: list.list_complete !== false,
      };
      if (list.list_complete === false && list.cursor) body.cursor = list.cursor;
      return jsonResponse(body, 200, cors);
    }
    // /pools/:asset_id/:denom — full per-pool state. Leaves are returned
    // in canonical KV-key order (height-padded + tx_index-padded), which
    // is the order the dApp must apply them in to reproduce the canonical
    // merkle tree.
    //
    // Pagination: ?leaves_cursor=<opaque> and/or ?nullifiers_cursor=<opaque>
    // for forward pagination of either list. Default (neither cursor)
    // returns the first page of both plus pool metadata + tip. With a
    // cursor: returns ONLY that paginated list, without the metadata bundle
    // (saves the dapp from re-receiving init/tip on every page). Limit is
    // capped to fit the 1000-subrequest-per-invocation worker budget:
    // ~4 fixed (init + tip race + 2 KV.lists) + N leaf gets + M nullifier
    // gets ≤ 1000 → cap default page at 400 each, cursor pages at 800 each.
    {
      const m = url.pathname.match(/^\/pools\/([0-9a-f]{64})\/(\d+)$/i);
      if (m && req.method === 'GET') {
        const aid = m[1].toLowerCase();
        const denom = m[2];
        const leavesCursor = url.searchParams.get('leaves_cursor');
        const nullifiersCursor = url.searchParams.get('nullifiers_cursor');
        // Page-size budget: cursor pages fetch only one list, so they get
        // the full 800 budget. Default page fetches both, so each gets 400.
        const PAGE_DEFAULT = 400;
        const PAGE_CURSOR  = 800;

        // _annotateLeaves: stamps each raw leaf record with depth + status
        // for the dapp's reorg-safe filter. Mirrors the SPEC §5.10 depth
        // gate so the worker is the source of truth for inclusion.
        const _annotateLeaves = (rawLeaves, tipHeight, fallbackTipHeight) => {
          // L1 fix: tip-unavailable fallback. When mempool.space is slow or
          // unreachable, fall back to the highest deposited_at_height we've
          // observed in this pool's leaves as a tip estimate. A leaf at
          // height H with N other leaves at heights > H is by construction
          // at depth ≥ N — using max(observed_heights) as the tip floor
          // makes leaves whose height is ≥3 below that floor 'included'
          // rather than 'unknown_depth'. Conservative for the very latest
          // leaves (which still get 'unknown_depth'), accurate for older
          // ones. Without this, a tip-unreachable response leaves the
          // dapp's local pool view appearing empty.
          const tipFloor = Number.isInteger(tipHeight)
            ? tipHeight
            : (Number.isInteger(fallbackTipHeight) ? fallbackTipHeight : null);
          const tipFromExplorer = Number.isInteger(tipHeight);
          return rawLeaves.map(rec => {
            const h = Number.isInteger(rec.deposited_at_height) ? rec.deposited_at_height : null;
            let depth = null, status;
            if (Number.isInteger(tipFloor) && Number.isInteger(h)) {
              depth = Math.max(1, tipFloor - h + 1);
              if (depth >= MIXER_DEPOSIT_CONFIRMATION_DEPTH) {
                status = 'included';
              } else {
                // Fallback tip is a *lower bound*, not authoritative — if
                // the real tip is higher this leaf may already be included.
                // Without tip-from-explorer, refuse to call it pending and
                // mark 'unknown_depth' so the reorg-safe filter holds.
                status = tipFromExplorer ? 'pending' : 'unknown_depth';
              }
            } else {
              status = 'unknown_depth';
            }
            return { ...rec, depth, status };
          });
        };
        const _fetchListPage = async (prefix, cursor, limit) => {
          const opts = { prefix, limit };
          if (cursor) opts.cursor = cursor;
          const list = await env.REGISTRY_KV.list(opts);
          const fetched = await Promise.all(
            list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json'))
          );
          return {
            records: fetched.filter(r => r),
            list_complete: list.list_complete !== false,
            next_cursor: (list.list_complete === false && list.cursor) ? list.cursor : null,
          };
        };

        // Cursor mode (leaves only). Skip pool metadata + nullifier walk —
        // the dapp accumulated those from the first call. tip is included
        // for the depth annotation; cheap (1 subrequest).
        if (leavesCursor !== null && nullifiersCursor === null) {
          const tipP = Promise.race([
            apiText(env, '/blocks/tip/height', {}, network).then(s => parseInt(s.trim(), 10)),
            new Promise(resolve => setTimeout(() => resolve(null), 2500)),
          ]).catch(() => null);
          const page = await _fetchListPage(
            poolLeafPrefix(network, aid, denom),
            leavesCursor || undefined,
            PAGE_CURSOR,
          );
          const tipHeight = await tipP;
          const fallback = page.records.reduce((acc, r) =>
            Number.isInteger(r.deposited_at_height) && (acc === null || r.deposited_at_height > acc)
              ? r.deposited_at_height : acc, null);
          const leaves = _annotateLeaves(page.records, tipHeight, fallback);
          const body = {
            leaves,
            list_complete: page.list_complete,
            tip: Number.isInteger(tipHeight) ? tipHeight : null,
            tip_unavailable: !Number.isInteger(tipHeight),
          };
          if (page.next_cursor) body.leaves_cursor = page.next_cursor;
          return jsonResponse(body, 200, cors);
        }

        // Cursor mode (nullifiers only). Same structural shape as leaves.
        if (nullifiersCursor !== null && leavesCursor === null) {
          const page = await _fetchListPage(
            poolNullifierPrefix(network, aid, denom),
            nullifiersCursor || undefined,
            PAGE_CURSOR,
          );
          const body = {
            nullifiers: page.records,
            list_complete: page.list_complete,
          };
          if (page.next_cursor) body.nullifiers_cursor = page.next_cursor;
          return jsonResponse(body, 200, cors);
        }
        // Reject ambiguous "both cursors at once" — forces the dapp to
        // paginate one list at a time so each call stays within budget.
        if (leavesCursor !== null && nullifiersCursor !== null) {
          return jsonResponse({
            error: 'pass at most one of leaves_cursor / nullifiers_cursor per call',
          }, 400, cors);
        }

        // Default mode: pool metadata + first page of both lists.
        const initRec = await env.REGISTRY_KV.get(poolInitKey(network, aid, denom), 'json');
        if (!initRec) return jsonResponse({ error: 'pool not found' }, 404, cors);
        // Fetch chain tip in parallel with the KV walks so the depth-gate
        // annotation can be applied without doubling latency. Tolerate tip
        // failure — when null, _annotateLeaves uses lex-max deposited
        // height as a fallback (L1).
        const tipP = Promise.race([
          apiText(env, '/blocks/tip/height', {}, network).then(s => parseInt(s.trim(), 10)),
          new Promise(resolve => setTimeout(() => resolve(null), 2500)),
        ]).catch(() => null);
        const [leafPage, nullPage] = await Promise.all([
          _fetchListPage(poolLeafPrefix(network, aid, denom), undefined, PAGE_DEFAULT),
          _fetchListPage(poolNullifierPrefix(network, aid, denom), undefined, PAGE_DEFAULT),
        ]);
        const tipHeight = await tipP;
        const fallback = leafPage.records.reduce((acc, r) =>
          Number.isInteger(r.deposited_at_height) && (acc === null || r.deposited_at_height > acc)
            ? r.deposited_at_height : acc, null);
        const leaves = _annotateLeaves(leafPage.records, tipHeight, fallback);
        const includedCount = leaves.filter(l => l.status === 'included').length;
        const pendingCount = leaves.filter(l => l.status === 'pending').length;
        const body = {
          pool: initRec,
          leaves,
          nullifiers: nullPage.records,
          network,
          tip: Number.isInteger(tipHeight) ? tipHeight : null,
          tip_unavailable: !Number.isInteger(tipHeight),
          confirmation_depth: MIXER_DEPOSIT_CONFIRMATION_DEPTH,
          included_leaf_count: includedCount,
          pending_leaf_count: pendingCount,
          leaves_list_complete: leafPage.list_complete,
          nullifiers_list_complete: nullPage.list_complete,
        };
        if (leafPage.next_cursor) body.leaves_cursor = leafPage.next_cursor;
        if (nullPage.next_cursor) body.nullifiers_cursor = nullPage.next_cursor;
        return jsonResponse(body, 200, cors);
      }
    }
    if (url.pathname === '/assets' && req.method === 'GET') {
      const limitStr = url.searchParams.get('limit');
      let limit = null;
      if (limitStr !== null) {
        // Reject non-numeric limits explicitly rather than silently
        // coercing to no-limit. handleAssetsList caps at 1000 anyway,
        // but garbage input should 400 so callers fix their query.
        if (!/^\d+$/.test(limitStr)) {
          return jsonResponse({ error: 'limit must be a non-negative integer' }, 400, cors);
        }
        limit = parseInt(limitStr, 10);
        if (limit < 1 || limit > 1000) {
          return jsonResponse({ error: 'limit must be between 1 and 1000' }, 400, cors);
        }
      }
      const mintsParam = url.searchParams.get('mints');
      const includeMints = mintsParam !== '0' && mintsParam !== 'false';
      // Cloudflare Cache API layer in front of the registry list, with
      // stale-while-revalidate semantics. Without SWR the first request after
      // a TTL window pays the full MISS cost (~2-3s on cold mainnet — KV
      // fan-out + mempool.space tip-height upstream). With SWR, anyone past
      // the fresh window but within the stale window gets the cached body
      // instantly while the worker refreshes in the background; only requests
      // arriving after a long quiet period (>STALE_MS) ever pay MISS again.
      //
      // FRESH: how long a cached response counts as "current".
      // STALE: how long past FRESH we still serve cached + refresh async.
      // Beyond STALE the cache is treated as missing and we recompute synchronously.
      // Tuned around the cron's 5-min tick: fresh data only changes that often,
      // so a 5-min serve-stale window doesn't lose much accuracy.
      const cache = caches.default;
      const cacheKey = assetsCacheKey(network, limit, includeMints);
      const _withCors = (body, status, kind) => {
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        headers.set('X-Cache', kind);
        return new Response(body, { status, headers });
      };
      const _computeAndCache = () => assetsComputeAndCache(env, network, { limit, includeMints });
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedAtStr = cached.headers.get('X-Cached-At');
        const ageMs = cachedAtStr ? Date.now() - parseInt(cachedAtStr, 10) : Infinity;
        if (ageMs < ASSETS_CACHE_FRESH_MS) {
          return _withCors(await cached.text(), cached.status, 'HIT');
        }
        if (ageMs < ASSETS_CACHE_STALE_MS) {
          // Stale-while-revalidate: serve immediately, refresh async. The
          // background refresh swallows errors so a transient failure doesn't
          // poison the next read; the next read then sees the same stale
          // body again and re-tries the refresh, eventually catching up.
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(_computeAndCache().catch(() => null));
          }
          return _withCors(await cached.text(), cached.status, 'STALE');
        }
        // Older than STALE: fall through to synchronous recomputation below.
      }
      // MISS path. Compute synchronously and cache before responding.
      const result = await _computeAndCache();
      return _withCors(result.body, result.status, cached ? 'EXPIRED-MISS' : 'MISS');
    }
    if (url.pathname === '/market' && req.method === 'GET') {
      // Same SWR pattern as /assets: HIT inside FRESH window, STALE serve +
      // background refresh between FRESH and STALE, MISS path recomputes
      // synchronously. Cron pre-warms /market alongside /assets so the
      // first user after a quiet period lands on a HIT.
      const cache = caches.default;
      const cacheKey = marketCacheKey(network);
      const _withCors = (body, status, kind) => {
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        headers.set('X-Cache', kind);
        return new Response(body, { status, headers });
      };
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedAtStr = cached.headers.get('X-Cached-At');
        const ageMs = cachedAtStr ? Date.now() - parseInt(cachedAtStr, 10) : Infinity;
        if (ageMs < MARKET_CACHE_FRESH_MS) {
          return _withCors(await cached.text(), cached.status, 'HIT');
        }
        if (ageMs < MARKET_CACHE_STALE_MS) {
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(marketComputeAndCache(env, network).catch(() => null));
          }
          return _withCors(await cached.text(), cached.status, 'STALE');
        }
      }
      const result = await marketComputeAndCache(env, network);
      return _withCors(result.body, result.status, cached ? 'EXPIRED-MISS' : 'MISS');
    }
    if (url.pathname === '/holdings' && req.method === 'POST') return handleHoldings(req, env, network, cors);
    if (url.pathname === '/assets/hint' && req.method === 'POST') return handleAssetHint(req, env, network, cors, ctx);
    // Permissionless-mint registry (T_PETCH-rooted). Kept separate from
    // /assets so consumers can filter cleanly without one mode polluting the
    // other; clients wanting "every asset" union /assets and /petch-assets.
    // Public read-only progress endpoint for the cron-driven PMINT backfill
    // (issue #31 FAIR recovery). Returns each configured backfill's cursor
    // state — current height, total writes, completion timestamp. No auth
    // because it exposes nothing sensitive and no destructive operations;
    // op visibility is useful while the multi-hour backfill is in flight.
    if (url.pathname === '/pmint-backfills' && req.method === 'GET') {
      try {
        const out = [];
        for (const cfg of PMINT_BACKFILLS) {
          const cursor = await env.REGISTRY_KV.get(pmintBackfillCursorKey(cfg.network, cfg.aid), 'json');
          out.push({
            network: cfg.network,
            asset_id: cfg.aid,
            from_height: cfg.from_height,
            end_height: cfg.end_height,
            cursor: cursor || null,
            progress_pct: cursor
              ? Math.min(100, Math.round(((cursor.next_height - cfg.from_height) / (cfg.end_height - cfg.from_height + 1)) * 100))
              : 0,
          });
        }
        return jsonResponse({ backfills: out }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    if (url.pathname === '/petch-assets' && req.method === 'GET') {
      // Same SWR pattern as /assets and /market: HIT inside FRESH window,
      // STALE-serve + background refresh between FRESH and STALE, MISS path
      // recomputes synchronously. Cron pre-warm makes user requests almost
      // always land on a HIT — important here since each MISS fans out to
      // loadCanonicalPmints per asset, which is the costliest /petch-assets
      // payload on the system.
      const cache = caches.default;
      const cacheKey = petchAssetsCacheKey(network);
      const _withCors = (body, status, kind) => {
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        headers.set('X-Cache', kind);
        return new Response(body, { status, headers });
      };
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedAtStr = cached.headers.get('X-Cached-At');
        const ageMs = cachedAtStr ? Date.now() - parseInt(cachedAtStr, 10) : Infinity;
        if (ageMs < PETCH_ASSETS_CACHE_FRESH_MS) {
          return _withCors(await cached.text(), cached.status, 'HIT');
        }
        if (ageMs < PETCH_ASSETS_CACHE_STALE_MS) {
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(petchAssetsComputeAndCache(env, network).catch(() => null));
          }
          return _withCors(await cached.text(), cached.status, 'STALE');
        }
      }
      const result = await petchAssetsComputeAndCache(env, network);
      return _withCors(result.body, result.status, cached ? 'EXPIRED-MISS' : 'MISS');
    }
    const mpa = url.pathname.match(/^\/petch-assets\/([0-9a-f]{64})$/);
    if (mpa && req.method === 'GET') {
      const aid = mpa[1];
      const v = await env.REGISTRY_KV.get(petchKey(network, aid), 'json');
      if (!v) return jsonResponse({ error: 'unknown petch asset_id' }, 404, cors);
      // Read snapshot first. The previous implementation called
      // loadCanonicalPmints which value-fetched every canonical key and took
      // ~45s wall-time on FAIR before truncating at 5000 entries — over the
      // 30s worker ceiling and inconsistent with /petch-assets's 50000-key
      // counts. The snapshot is the single source of truth maintained by
      // the cron + hint write paths.
      // Parallel: tip fetch (mempool.space, 50ms–2.5s) and snapshot KV.get
      // (~10-50ms) are independent. Sequential awaits added the smaller of
      // the two to every cold response unnecessarily.
      let [tip, snap] = await Promise.all([
        fetchTipHeight(env, network),
        readPetchProgress(env, network, aid),
      ]);
      if (!snap) {
        snap = await refreshAndStorePetchProgress(env, network, aid, tip, v).catch(() => null);
      }
      if (snap) {
        v.cumulative_minted = snap.credited_amount;
        v.credited_pmint_count = snap.credited_count;
        v.cap_overflow_count = snap.cap_overflow_count || 0;
        v.pmint_count = snap.canonical_count + (snap.orphan_count || 0);
        v.pending_pmint_count = snap.pending_count;
        v.snapshot_updated_at = snap.updated_at;
        v.snapshot_tip = snap.tip_at_update;
        v.truncated = !!snap.truncated;
        v.bootstrapped = !!snap.bootstrapped;
      } else {
        v.cumulative_minted = '0';
        v.credited_pmint_count = 0;
        v.cap_overflow_count = 0;
        v.pmint_count = 0;
        v.pending_pmint_count = 0;
        v.truncated = true;
        v.bootstrapped = false;
        v.snapshot_unavailable = true;
      }
      if (v.cap_amount && v.mint_limit) {
        const minted = BigInt(v.cumulative_minted || '0');
        const remaining = BigInt(v.cap_amount) - minted;
        v.mints_remaining = String(remaining < 0n ? 0n : remaining / BigInt(v.mint_limit));
      }
      return jsonResponse(v, 200, cors);
    }

    // ============== /drops-onchain (SPEC §5.12 / §5.13) ==============
    // Distinct from /drops, which lists off-chain worker-mediated airdrop
    // announcements. This namespace surfaces T_DROP-rooted on-chain claim
    // pools indexed by the cron scanner. Three endpoints:
    //   GET /drops-onchain                  — list active drops on this network
    //   GET /drops-onchain/:drop_id         — single drop metadata + progress
    //   GET /drops-onchain/:drop_id/claims  — paginated T_DCLAIM event list
    //   POST /drops-hint                    — targeted indexing for fresh broadcasts
    if (url.pathname === '/drops-onchain' && req.method === 'GET') {
      const list = await env.REGISTRY_KV.list({ prefix: dropPrefix(network), limit: 1000 });
      const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
      const drops = [];
      const tip = await fetchTipHeight(env, network).catch(() => null);
      for (const v of fetched) {
        if (!v || v.kind !== 'drop') continue;
        // Cross-network bleed guard: prefix lookups on signet match mainnet
        // keys too (legacy unprefixed-signet convention). Same fix pattern
        // as handleDropAnnounceList.
        if ((v.network || 'signet') !== network) continue;
        // Expiry: omit expired drops by default. Callers wanting to see
        // expired drops (for reclaim UX) can pass ?include_expired=1.
        const includeExpired = url.searchParams.get('include_expired') === '1';
        if (!includeExpired && v.expiry_height && Number.isFinite(tip) && tip > v.expiry_height) continue;
        drops.push(v);
      }
      // Newest first so freshly-confirmed drops surface immediately.
      drops.sort((a, b) => (b.drop_at_height || 0) - (a.drop_at_height || 0));
      return jsonResponse({ network, count: drops.length, drops, tip }, 200, cors);
    }
    const mdo = url.pathname.match(/^\/drops-onchain\/([0-9a-f]{64})$/);
    if (mdo && req.method === 'GET') {
      const dropId = mdo[1];
      const v = await env.REGISTRY_KV.get(dropKey(network, dropId), 'json');
      if (!v) return jsonResponse({ error: 'unknown drop_id' }, 404, cors);
      if (v.kind !== 'drop') return jsonResponse({ error: 'drop_id does not resolve to a T_DROP record' }, 404, cors);
      // Inline cap-progress computation. For scale a drop_progress snapshot
      // (parallel to petch_progress) is the right answer; MVP paginates the
      // KV.list scan up to DCLAIM_PROGRESS_PAGE_GUARD pages — enough for any
      // realistic drop (32 × 1000 = 32000 claims past any cap a single drop
      // would reasonably hold). The list-only walk costs no per-key gets,
      // so the page-budget here only bounds list calls, not subrequests.
      //
      // CAP-OVERFLOW HANDLING: the cron writes every structurally-valid
      // T_DCLAIM to dclaim:*, including ones that collectively exceed cap.
      // Cap-overflow resolution per SPEC §5.13 step 5 picks the first
      // `max_claims` claims in canonical (height, tx_index, txid) order.
      // KV.list returns the prefix in lex order which equals canonical order
      // (height + tx_index are zero-padded in dclaimKeyFor). We cap
      // claim_count at max_claims when reporting `claimed_amount` so the
      // remaining/claims_remaining math doesn't go negative when an issuer
      // sees a brief over-claim flurry.
      const perClaim = BigInt(v.per_claim);
      const capAmount = BigInt(v.cap_amount);
      const maxClaimsBig = capAmount / perClaim;
      const DCLAIM_PROGRESS_PAGE_GUARD = 32;
      let totalSeen = 0;
      let kvCursor = undefined;
      let listComplete = false;
      for (let page = 0; page < DCLAIM_PROGRESS_PAGE_GUARD; page++) {
        const opts = { prefix: dclaimPrefix(network, dropId), limit: 1000 };
        if (kvCursor) opts.cursor = kvCursor;
        const claimList = await env.REGISTRY_KV.list(opts);
        totalSeen += claimList.keys.length;
        // Early-exit once we've enumerated enough claims to fully account
        // for cap_overflow. Past the cap we don't credit further claims,
        // so the exact count of overflow is informational only — but the
        // canonical-order winners are already in the first maxClaims of
        // the lex-sorted prefix scan, so once totalSeen ≥ maxClaims the
        // creditedCount answer is locked in regardless of further pages.
        if (BigInt(totalSeen) >= maxClaimsBig && claimList.list_complete) {
          listComplete = true;
          break;
        }
        if (claimList.list_complete) { listComplete = true; break; }
        if (!claimList.cursor) { listComplete = true; break; }
        kvCursor = claimList.cursor;
      }
      const creditedCount = Math.min(totalSeen, Number(maxClaimsBig));
      const claimed_amount = BigInt(creditedCount) * perClaim;
      v.claim_count = creditedCount;            // claims credited toward cap
      v.claim_total_seen = totalSeen;           // includes cap-overflow rejects
      v.cap_overflow_count = totalSeen - creditedCount;
      v.claimed_amount = claimed_amount.toString();
      const remainingAmount = capAmount - claimed_amount;
      v.remaining_amount = (remainingAmount < 0n ? 0n : remainingAmount).toString();
      v.claims_remaining = String(remainingAmount > 0n ? remainingAmount / perClaim : 0n);
      v.list_complete = listComplete;
      const reclaimKey = network === 'signet'
        ? `drop-reclaim:${dropId}`
        : `drop-reclaim:${network}:${dropId}`;
      const reclaim = await env.REGISTRY_KV.get(reclaimKey, 'json');
      if (reclaim) v.reclaimed = reclaim;
      return jsonResponse(v, 200, cors);
    }
    const mdoc = url.pathname.match(/^\/drops-onchain\/([0-9a-f]{64})\/claims$/);
    if (mdoc && req.method === 'GET') {
      const dropId = mdoc[1];
      const drop = await env.REGISTRY_KV.get(dropKey(network, dropId), 'json');
      if (!drop) return jsonResponse({ error: 'unknown drop_id' }, 404, cors);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 10000);
      const cursor = url.searchParams.get('cursor') || undefined;
      // Slim path: caller passes ?credited=1&include_txids=1 to get just the
      // set of canonically-credited claim txids — used by the dapp validator
      // for the rewrap-supply-inflation gate (SPEC §5.13 *Replay analysis*).
      // Identical posture to /assets/:aid/pmints?credited=1&include_txids=1.
      // No JSON-per-record overhead; for 1000 claims this is ~70KB vs.
      // ~500KB for the full record path.
      const slim = url.searchParams.get('credited') === '1' && url.searchParams.get('include_txids') === '1';
      const list = await env.REGISTRY_KV.list({
        prefix: dclaimPrefix(network, dropId),
        limit,
        cursor,
      });
      if (slim) {
        // KV key suffix is `…:<padded_height>:<padded_tx_index>:<txid>`.
        // Extract just the trailing txid. The cron's nullifier check means
        // every key here corresponds to ONE canonical claim per leaf — rewraps
        // never make it into this list.
        const credited_txids = [];
        for (const k of list.keys) {
          const txid = k.name.split(':').pop();
          if (/^[0-9a-f]{64}$/.test(txid)) credited_txids.push(txid);
        }
        return jsonResponse({
          drop_id: dropId,
          network,
          credited_count: credited_txids.length,
          credited_txids,
          cursor: list.list_complete ? null : list.cursor,
          list_complete: !!list.list_complete,
          truncated: !list.list_complete,
        }, 200, cors);
      }
      const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
      const claims = fetched.filter(v => v && v.kind === 'dclaim');
      return jsonResponse({
        drop_id: dropId,
        count: claims.length,
        claims,
        cursor: list.list_complete ? null : list.cursor,
        list_complete: !!list.list_complete,
      }, 200, cors);
    }
    // POST /drops-hint — targeted indexing for a freshly-broadcast T_DROP or
    // T_DCLAIM, mirrors POST /assets/hint for T_PMINT. Lets a dapp force
    // immediate KV write after broadcast without waiting up to 5 min for the
    // next cron tick. Idempotent: re-hinting a tx re-decodes and re-writes
    // with the same metadata; no-op for already-indexed entries.
    if (url.pathname === '/drops-hint' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
      const txid = String(body?.txid || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) return jsonResponse({ error: 'txid must be 64-char hex' }, 400, cors);
      // Per-IP daily cap, same posture as /assets/hint: hints only echo data
      // already on chain (or in mempool), so abuse is bounded — but we still
      // don't want an attacker fetching every txid in their flood through
      // the worker's subrequest budget.
      const ip = req.headers.get('CF-Connecting-IP') || 'anon';
      const day = new Date().toISOString().slice(0, 10);
      const hintKey = `hint:${day}:${ip}`;
      const hintLimit = safeInt(env.HINT_LIMIT, 200, { min: 0 });
      const hintPrior = safeInt(await env.REGISTRY_KV.get(hintKey), 0, { min: 0 });
      if (hintPrior >= hintLimit) return jsonResponse({ error: 'daily hint limit reached' }, 429, cors);
      let tx;
      try { tx = await apiJson(env, `/tx/${txid}`, {}, network); }
      catch (e) { return jsonResponse({ error: `tx fetch failed: ${e.message}` }, 502, cors); }
      if (!tx?.vin?.[0]?.witness || tx.vin[0].witness.length < 3) {
        return jsonResponse({ error: 'tx vin[0] does not carry a tacit envelope' }, 400, cors);
      }
      let decoded;
      try { decoded = decodeEnvelopeScript(hexToBytes(tx.vin[0].witness[1])); } catch { decoded = null; }
      if (!decoded) return jsonResponse({ error: 'envelope decode failed' }, 400, cors);
      const h = Number(tx.status?.block_height) || 0;
      // We don't fetch the block to recover canonical tx_index, so the hint's
      // dclaim:* key uses tx_index=0 as a placeholder. For merkle-gated drops
      // the cron's later pass sees the leafKey already set and SKIPS writing
      // its own canonical-tx_index record (leaving the hint's record in
      // place) — so claim_count stays correct, but cap-overflow ordering for
      // same-block ties favors hinted claims. Acceptable trade-off for the
      // immediate-index UX. (Earlier comment claimed cron "overwrites" — it
      // doesn't; the keys differ.)
      const txIndex = 0;
      if (decoded.opcode === T_DROP) {
        // Reject unconfirmed T_DROP hints. An attacker who broadcasts a
        // valid-looking T_DROP envelope (locking real asset UTXOs as inputs)
        // could RBF it out before confirmation while the worker's drop:*
        // record persists indefinitely. Recipients seeing the phantom drop
        // via /drops-onchain would attempt T_DCLAIMs against a parent that
        // never confirmed and burn their own commit + reveal fees. The
        // attacker's RBF replacement reclaims their inputs — they pay
        // nothing for the grief. Cron picks up confirmed T_DROPs on its
        // next tick (≤5 min), so the only UX cost is a short wait between
        // broadcast and discovery.
        if (!tx.status?.confirmed) {
          return jsonResponse({
            error: 'T_DROP hint requires a confirmed tx — retry after the first confirmation (the cron will pick it up automatically)',
          }, 400, cors);
        }
        const cd = decodeCDropPayload(decoded.payload);
        if (!cd) return jsonResponse({ error: 'invalid T_DROP payload' }, 400, cors);
        if (cd.kind === 'cdrop') {
          const dropId = bytesToHex(dropIdFromRevealTxid(txid));
          const meta = {
            drop_id: dropId,
            drop_reveal_txid: txid,
            asset_id: cd.asset_id,
            cap_amount: cd.cap_amount,
            per_claim: cd.per_claim,
            merkle_root: cd.merkle_root,
            expiry_height: cd.expiry_height,
            ticker: cd.ticker,
            decimals: cd.decimals,
            asset_input_count: cd.asset_input_count,
            drop_at_height: h,
            drop_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
            kind: 'drop',
            hinted: true,
            network,
          };
          await env.REGISTRY_KV.put(dropKey(network, dropId), JSON.stringify(meta));
          // Bump the per-IP hint counter on success only — a 400/502 response
          // doesn't consume budget. Same TTL as the /assets/hint precedent.
          await env.REGISTRY_KV.put(hintKey, String(hintPrior + 1), { expirationTtl: 90000 });
          return jsonResponse({ ok: true, drop_id: dropId, kind: 'drop' }, 200, cors);
        } else {
          // SPEC §5.12.1 — reclaim variant. Write the same drop-reclaim KV
          // record the cron writes, so /drops-onchain/:drop_id surfaces it
          // immediately. The dapp validator independently re-checks the cap
          // equality + reclaim_sig against the live drop record, so an
          // attacker hinting a fake reclaim cannot inflate supply — the
          // record's existence is informational, soundness lives in the
          // dapp's validator against the worker's authoritative drop_id state.
          const reclaimMeta = {
            kind: 'drop-reclaim',
            reclaim_drop_id: cd.reclaim_drop_id,
            reclaim_txid: txid,
            asset_id: cd.asset_id,
            cap_amount: cd.cap_amount,
            cap_blinding: cd.cap_blinding,
            reclaim_sig: cd.reclaim_sig,
            reclaim_at_height: h,
            reclaim_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
            hinted: true,
            network,
          };
          const reclaimKey = network === 'signet'
            ? `drop-reclaim:${cd.reclaim_drop_id}`
            : `drop-reclaim:${network}:${cd.reclaim_drop_id}`;
          await env.REGISTRY_KV.put(reclaimKey, JSON.stringify(reclaimMeta));
          await env.REGISTRY_KV.put(hintKey, String(hintPrior + 1), { expirationTtl: 90000 });
          return jsonResponse({ ok: true, reclaim_drop_id: cd.reclaim_drop_id, kind: 'drop-reclaim' }, 200, cors);
        }
      }
      if (decoded.opcode === T_DCLAIM) {
        // Hinting a T_DCLAIM has soundness implications the T_DROP hint
        // doesn't: it writes a leaf nullifier that PERMANENTLY locks
        // (drop_id, leaf_index) in this KV namespace. If we accepted a
        // mempool-only tx, an attacker could broadcast a low-fee /
        // RBF-replaceable T_DCLAIM with a valid Pedersen open for any
        // victim's leaf, hint it, then drop or RBF the tx — leaf
        // nullifier persists indefinitely, blocking the legitimate
        // claimant. The cost is ~zero (the attacker's RBF replacement
        // pays them, not the network). Refuse mempool hints; the
        // claimant retries after first confirmation, or the cron picks
        // the tx up on its next scan once confirmed. For drops the
        // posture is different (the metadata is only ever additive and
        // cron corrects it on confirmation), so we don't gate those.
        if (!tx.status?.confirmed) {
          return jsonResponse({
            error: 'T_DCLAIM hint requires a confirmed tx — retry after the first confirmation (the cron will pick it up automatically)',
          }, 400, cors);
        }
        const cdc = decodeCDClaimPayload(decoded.payload);
        if (!cdc) return jsonResponse({ error: 'invalid T_DCLAIM payload' }, 400, cors);
        const dropId = bytesToHex(dropIdFromRevealTxid(cdc.drop_reveal_txid));
        const drop = await env.REGISTRY_KV.get(dropKey(network, dropId), 'json');
        if (!drop || drop.kind !== 'drop') {
          return jsonResponse({ error: 'parent T_DROP not indexed yet — hint the drop first' }, 400, cors);
        }
        try {
          if (BigInt(cdc.amount) !== BigInt(drop.per_claim)) return jsonResponse({ error: 'amount != drop.per_claim' }, 400, cors);
        } catch { return jsonResponse({ error: 'amount parse failed' }, 400, cors); }
        if (drop.expiry_height !== 0 && h > drop.expiry_height) return jsonResponse({ error: 'claim past expiry' }, 400, cors);
        if (!pmintCommitmentOpens(cdc.amount, cdc.blinding, cdc.commitment)) return jsonResponse({ error: 'Pedersen open failed' }, 400, cors);
        const merkleRootZero = /^0+$/.test(drop.merkle_root);
        if (merkleRootZero) {
          if (cdc.witness) return jsonResponse({ error: 'open drop must have empty witness' }, 400, cors);
        } else {
          if (!cdc.witness) return jsonResponse({ error: 'merkle-gated drop requires witness' }, 400, cors);
          const leafKey = dclaimLeafKey(network, dropId, cdc.witness.leaf_index);
          const existingLeaf = await env.REGISTRY_KV.get(leafKey);
          if (existingLeaf) return jsonResponse({ error: 'leaf already claimed' }, 400, cors);
          await env.REGISTRY_KV.put(leafKey, JSON.stringify({
            drop_id: dropId,
            leaf_index: cdc.witness.leaf_index,
            eth_address: cdc.witness.eth_address,
            claim_txid: txid,
            claimed_at_height: h,
            hinted: true,
            network,
          }));
        }
        const claimMeta = {
          drop_id: dropId,
          drop_reveal_txid: cdc.drop_reveal_txid,
          asset_id: cdc.asset_id,
          commitment: cdc.commitment,
          amount: cdc.amount,
          blinding: cdc.blinding,
          witness: cdc.witness,
          claim_txid: txid,
          claim_vout: 0,
          tx_index: txIndex,
          claimed_at_height: h,
          claimed_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
          kind: 'dclaim',
          hinted: true,
          network,
        };
        const dck = dclaimKeyFor(network, dropId, h, txIndex, txid);
        await env.REGISTRY_KV.put(dck, JSON.stringify(claimMeta));
        await env.REGISTRY_KV.put(hintKey, String(hintPrior + 1), { expirationTtl: 90000 });
        return jsonResponse({ ok: true, drop_id: dropId, kind: 'dclaim' }, 200, cors);
      }
      return jsonResponse({ error: `not a T_DROP or T_DCLAIM envelope (opcode 0x${decoded.opcode.toString(16)})` }, 400, cors);
    }

    const mpm = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/pmints$/);
    if (mpm && req.method === 'GET') {
      const creditedOnly = url.searchParams.get('credited') === '1';
      // Slim path: caller opts out of credited_txids list. Response is just
      // snapshot fields (~3KB) and the underlying call is one KV.get of the
      // snapshot — ~50ms wall-time. Skip edge cache entirely: there's nothing
      // costly enough to merit caching, and the snapshot has its own freshness
      // contract (refreshed by cron every 5 min). The new dapp passes
      // include_txids=0 to take this path.
      const includeTxids = url.searchParams.get('include_txids') !== '0';
      if (creditedOnly && includeTxids) {
        const aid = mpm[1];
        // SWR cache for the legacy fat-list path. Same pattern as
        // /petch-assets: HIT inside FRESH, STALE-serve + background refresh
        // between FRESH and STALE, MISS recomputes synchronously. For FAIR-
        // scale assets the underlying inline scan is ~7s and ~3.3MB; the
        // cache collapses concurrent reads at each Cloudflare POP into one
        // real scan per 30s window. The full /pmints path (events array) is
        // explorer-only and not worth caching the multi-MB events response.
        const cache = caches.default;
        const cacheKey = pmintCreditedCacheKey(network, aid);
        const _withCors = (body, status, kind) => {
          const headers = new Headers();
          headers.set('Content-Type', 'application/json');
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          headers.set('X-Cache', kind);
          return new Response(body, { status, headers });
        };
        const cached = await cache.match(cacheKey);
        if (cached) {
          const cachedAtStr = cached.headers.get('X-Cached-At');
          const ageMs = cachedAtStr ? Date.now() - parseInt(cachedAtStr, 10) : Infinity;
          if (ageMs < PMINT_CREDITED_CACHE_FRESH_MS) {
            return _withCors(await cached.text(), cached.status, 'HIT');
          }
          if (ageMs < PMINT_CREDITED_CACHE_STALE_MS) {
            if (ctx && typeof ctx.waitUntil === 'function') {
              ctx.waitUntil(pmintCreditedComputeAndCache(env, network, aid).catch(() => null));
            }
            return _withCors(await cached.text(), cached.status, 'STALE');
          }
        }
        const result = await pmintCreditedComputeAndCache(env, network, aid);
        return _withCors(result.body, result.status, cached ? 'EXPIRED-MISS' : 'MISS');
      }
      return handlePmintList(mpm[1], env, network, cors, { creditedOnly, includeTxids });
    }
    const m = url.pathname.match(/^\/assets\/([0-9a-f]{64})$/);
    if (m && req.method === 'GET')                             return handleAssetGet(m[1], env, network, cors);
    const ma = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/attest$/);
    if (ma && req.method === 'POST')                           return handleAttest(ma[1], req, env, network, cors);
    const mm = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/mints\/([0-9a-f]{64})\/attest$/);
    if (mm && req.method === 'POST')                           return handleMintAttest(mm[1], mm[2], req, env, network, cors);
    const mo = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/openings$/);
    if (mo && req.method === 'GET')                            return handleAssetOpenings(mo[1], env, network, cors);
    const mu = url.pathname.match(/^\/utxos\/([0-9a-f]{64})\/(\d+)\/opening$/);
    if (mu && req.method === 'POST')                           return handleUtxoOpeningPost(mu[1], mu[2], req, env, network, cors);
    if (mu && req.method === 'GET')                            return handleUtxoOpeningGet(mu[1], mu[2], env, network, cors);
    const mub = url.pathname.match(/^\/utxos\/([0-9a-f]{64})\/(\d+)\/buyer-opening$/);
    if (mub && req.method === 'POST')                          return handleBuyerOpeningPost(mub[1], mub[2], req, env, network, cors);
    if (mub && req.method === 'GET')                           return handleBuyerOpeningGet(mub[1], mub[2], env, network, cors);
    const md = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/disclosures$/);
    if (md && req.method === 'POST')                           return handleDisclosurePost(md[1], req, env, network, cors);
    if (md && req.method === 'GET')                            return handleDisclosureList(md[1], env, network, cors);
    const ml = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/listings$/);
    if (ml && req.method === 'POST')                           return handleListingPost(ml[1], req, env, network, cors);
    if (ml && req.method === 'GET')                            return handleListingList(ml[1], env, network, cors);
    const ml2 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/listings\/([0-9a-f]{64})\/(\d+)$/);
    if (ml2 && req.method === 'DELETE')                        return handleListingDelete(ml2[1], ml2[2], ml2[3], req, env, network, cors);
    const ml3 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/listings\/([0-9a-f]{64})\/(\d+)\/claim$/);
    if (ml3 && req.method === 'POST')                          return handleListingClaim(ml3[1], ml3[2], ml3[3], req, env, network, cors);
    const mlr = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/listings-range$/);
    if (mlr && req.method === 'POST')                          return handleRangeListingPost(mlr[1], req, env, network, cors);
    if (mlr && req.method === 'GET')                           return handleRangeListingList(mlr[1], env, network, cors);
    const mlr2 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/listings-range\/(0[23][0-9a-f]{64})$/);
    if (mlr2 && req.method === 'DELETE')                       return handleRangeListingDelete(mlr2[1], mlr2[2], req, env, network, cors);
    const mlr3 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/listings-range\/(0[23][0-9a-f]{64})\/claim$/);
    if (mlr3 && req.method === 'POST')                         return handleRangeListingClaim(mlr3[1], mlr3[2], req, env, network, cors);
    // Atomic intents (browse-and-take T_AXFER marketplace).
    const mai = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/atomic-intents$/);
    if (mai && req.method === 'POST')                          return handleAtomicIntentPost(mai[1], req, env, network, cors);
    if (mai && req.method === 'GET')                           return handleAtomicIntentList(mai[1], env, network, cors);
    const mai2 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/atomic-intents\/([0-9a-f]{32})$/);
    if (mai2 && req.method === 'DELETE')                       return handleAtomicIntentDelete(mai2[1], mai2[2], req, env, network, cors);
    const mai3 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/atomic-intents\/([0-9a-f]{32})\/claim$/);
    if (mai3 && req.method === 'POST')                         return handleAtomicIntentClaim(mai3[1], mai3[2], req, env, network, cors);
    const mai4 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/atomic-intents\/([0-9a-f]{32})\/fulfilment$/);
    if (mai4 && req.method === 'POST')                         return handleAtomicIntentFulfil(mai4[1], mai4[2], req, env, network, cors);
    if (mai4 && req.method === 'GET')                          return handleAtomicIntentFulfilGet(mai4[1], mai4[2], env, network, cors);
    const mai5 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/atomic-intents\/([0-9a-f]{32})\/finalize$/);
    if (mai5 && req.method === 'POST')                         return _handleAtomicIntentFinalizeVar(mai5[1], mai5[2], req, env, network, cors);

    // Preauth sales (buyer-completable T_AXFER — SPEC §5.7.8). Seller signs once,
    // buyer completes settlement alone via ECDH-derived recipient blinding.
    const mps = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/preauth-sales$/);
    if (mps && req.method === 'POST')                          return handlePreauthSalePost(mps[1], req, env, network, cors);
    if (mps && req.method === 'GET')                           return handlePreauthSaleList(mps[1], env, network, cors);
    const mps2 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/preauth-sales\/([0-9a-f]{32})$/);
    if (mps2 && req.method === 'GET')                          return handlePreauthSaleGet(mps2[1], mps2[2], env, network, cors);
    if (mps2 && req.method === 'DELETE')                       return handlePreauthSaleDelete(mps2[1], mps2[2], req, env, network, cors);

    // Bid intents (off-chain bid book — SPEC §5.7.7). Buyer-initiated mirror
    // of atomic intents; settlement is via the seller spinning up an
    // axintent targeted at the bidder, no new wire format.
    const mbi = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/bid-intents$/);
    if (mbi && req.method === 'POST')                          return handleBidIntentPost(mbi[1], req, env, network, cors);
    if (mbi && req.method === 'GET')                           return handleBidIntentList(mbi[1], env, network, cors);
    const mbi2 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/bid-intents\/([0-9a-f]{32})$/);
    if (mbi2 && req.method === 'GET')                          return handleBidIntentGet(mbi2[1], mbi2[2], env, network, cors);
    if (mbi2 && req.method === 'DELETE')                       return handleBidIntentDelete(mbi2[1], mbi2[2], req, env, network, cors);
    const mbi3 = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/bid-intents\/([0-9a-f]{32})\/claim$/);
    if (mbi3 && req.method === 'POST')                         return handleBidIntentClaim(mbi3[1], mbi3[2], req, env, network, cors);

    // Airdrop claim queue.
    const mac = url.pathname.match(/^\/airdrops\/([0-9a-f]{64})\/claims$/);
    if (mac && req.method === 'POST')                          return handleAirdropClaimPost(mac[1], req, env, network, cors);
    if (mac && req.method === 'GET') {
      const cursorRaw = url.searchParams.get('cursor');
      const limitRaw = url.searchParams.get('limit');
      const opts = {};
      if (cursorRaw) opts.cursor = cursorRaw;
      if (limitRaw !== null) {
        if (!/^\d+$/.test(limitRaw)) {
          return jsonResponse({ error: 'limit must be a non-negative integer' }, 400, cors);
        }
        const lim = parseInt(limitRaw, 10);
        if (lim < 1 || lim > AIRDROP_LIST_HARD_CAP) {
          return jsonResponse({ error: `limit must be between 1 and ${AIRDROP_LIST_HARD_CAP}` }, 400, cors);
        }
        opts.limit = lim;
      }
      return handleAirdropClaimList(mac[1], env, network, cors, opts);
    }
    const mac2 = url.pathname.match(/^\/airdrops\/([0-9a-f]{64})\/claims\/(\d+)$/);
    if (mac2 && req.method === 'DELETE')                       return handleAirdropClaimDelete(mac2[1], mac2[2], req, env, network, cors);
    const mac3 = url.pathname.match(/^\/airdrops\/([0-9a-f]{64})\/claims\/(\d+)\/paid$/);
    if (mac3 && req.method === 'POST')                         return handleAirdropClaimPaid(mac3[1], mac3[2], req, env, network, cors);

    // Drop announcements (discovery layer for airdrops).
    if (url.pathname === '/drops') {
      if (req.method === 'POST') return handleDropAnnouncePost(req, env, network, cors);
      if (req.method === 'GET')  return handleDropAnnounceList(env, network, cors);
    }
    const mda = url.pathname.match(/^\/drops\/([0-9a-f]{64})$/);
    if (mda && req.method === 'GET')                           return handleDropAnnounceGet(mda[1], env, network, cors);
    if (mda && req.method === 'DELETE')                         return handleDropAnnounceDelete(mda[1], req, env, network, cors);

    // Debug endpoints: gated on DEBUG_TOKEN. Without the secret, attackers
    // can rescan-from-genesis and exhaust the worker's daily subrequest
    // budget. We return 404 (not 401) on missing/wrong auth so the surface
    // looks like it doesn't exist.
    if (url.pathname === '/scan' && req.method === 'POST') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try { return jsonResponse(await scanForEtches(env, network), 200, cors); }
      catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    if (url.pathname === '/rescan' && req.method === 'POST') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const fromStr = url.searchParams.get('from');
        if (fromStr === null) return jsonResponse({ error: 'missing ?from=<height>' }, 400, cors);
        const from = parseInt(fromStr, 10);
        return jsonResponse(await rewindLastScanned(env, from, network), 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 400, cors); }
    }
    // POST /admin/backfill-holders?aid=...&network=...[&cursor=&limit=]
    // Walks the worker's already-indexed transfer records for one asset
    // and bumps holderCount for each previously-unseen recipient. Pure
    // additive — doesn't touch the live cron's last_scanned, so new
    // blocks keep indexing in parallel.
    if (url.pathname === '/admin/backfill-holders' && req.method === 'POST') {
      try {
        const aid = url.searchParams.get('aid') || '';
        const cursor = url.searchParams.get('cursor') || '';
        const limit = url.searchParams.get('limit') || '';
        return await handleBackfillHolders(env, network, cors, { req, aid, cursor, limit });
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    // Bulk one-shot version of the cron's per-tick orphan healer. Useful right
    // after deploying the fix to clear an existing backlog without waiting
    // on the cron to drain it 50 at a time. ?max= bounds the work; default
    // 1000 fits one Worker invocation's subrequest budget comfortably (each
    // promoted orphan = ~2 mempool.space calls + 2 KV ops).
    if (url.pathname === '/admin/pmint-keys' && req.method === 'GET') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const aid = url.searchParams.get('aid');
        if (!aid || !/^[0-9a-f]{64}$/.test(aid)) return jsonResponse({ error: 'aid required' }, 400, cors);
        const allKeys = [];
        let cursor = null;
        for (let page = 0; page < 50; page++) {
          const list = await env.REGISTRY_KV.list({
            prefix: pmintPrefix(network, aid),
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          });
          allKeys.push(...list.keys.map(k => k.name));
          if (list.list_complete) break;
          cursor = list.cursor;
          if (!cursor) break;
        }
        const orphanPrefixStr = pmintPrefix(network, aid) + '0000000000:';
        const orphans = allKeys.filter(n => n.startsWith(orphanPrefixStr));
        const canonical = allKeys.filter(n => !n.startsWith(orphanPrefixStr));
        return jsonResponse({
          total: allKeys.length,
          orphan: orphans.length,
          canonical: canonical.length,
          first_canonical: canonical.slice(0, 3),
          first_orphan: orphans.slice(0, 3),
        }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    // Sample N orphans starting at offset, return their on-chain status.
    // Used to check what fraction of an asset's orphan backlog is actually
    // confirmed (vs mempool-stale broadcasts that will never promote).
    // Bulk-delete every height-0 orphan key for one petch asset. Useful when
    // an asset's orphan backlog is so dense (e.g. FAIR's ~46k pre-fix entries)
    // that the cron-tick promoter would take weeks to drain it AND the
    // canonical-walk loader is starved by the orphan range. Returns the
    // deleted count; safe to re-run (idempotent — re-runs find no keys).
    // Canonical entries written by scanForEtches's block scan are untouched
    // since they live under the real-height prefix, not 0000000000.
    if (url.pathname === '/admin/delete-orphans' && req.method === 'POST') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const aid = url.searchParams.get('aid');
        if (!aid || !/^[0-9a-f]{64}$/.test(aid)) {
          return jsonResponse({ error: 'aid required (64-hex asset_id)' }, 400, cors);
        }
        const maxStr = url.searchParams.get('max');
        const maxOps = maxStr ? Math.max(1, Math.min(5000, parseInt(maxStr, 10) || 2000)) : 2000;
        const orphanPrefix = pmintPrefix(network, aid) + '0000000000:';
        let deleted = 0;
        let cursor = null;
        const PARALLEL = 25;
        outer: while (deleted < maxOps) {
          const list = await env.REGISTRY_KV.list({
            prefix: orphanPrefix,
            limit: Math.min(1000, maxOps - deleted),
            ...(cursor ? { cursor } : {}),
          });
          if (list.keys.length === 0) break;
          for (let i = 0; i < list.keys.length; i += PARALLEL) {
            const slice = list.keys.slice(i, Math.min(i + PARALLEL, list.keys.length));
            await Promise.all(slice.map(k => env.REGISTRY_KV.delete(k.name).catch(() => {})));
            deleted += slice.length;
            if (deleted >= maxOps) break outer;
          }
          if (list.list_complete) break;
          cursor = list.cursor;
          if (!cursor) break;
        }
        // Bust the petch-assets cache so /petch-assets recomputes against the
        // newly-pruned namespace immediately rather than serving 5-min-stale.
        if (deleted > 0) {
          await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
          ctx.waitUntil(petchAssetsComputeAndCache(env, network).catch(() => {}));
        }
        return jsonResponse({ network, aid, deleted, max_ops: maxOps }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    // Curated verified-asset registry. POST adds, DELETE removes, GET lists.
    // Verification only attests platform-endorsement of a ticker's canonical
    // holder; the dapp must still chain-verify the underlying CETCH envelope.
    if (url.pathname === '/admin/verify' && req.method === 'GET') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const list = await env.REGISTRY_KV.list({ prefix: verifiedPrefix(network), limit: 1000 });
        const prefixLen = verifiedPrefix(network).length;
        const entries = await Promise.all(list.keys.map(async k => {
          const meta = await env.REGISTRY_KV.get(k.name, 'json');
          return { asset_id: k.name.slice(prefixLen), ...(meta || {}) };
        }));
        return jsonResponse({ network, count: entries.length, verified: entries }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    if (url.pathname === '/admin/verify' && req.method === 'POST') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const aid = url.searchParams.get('aid');
        if (!aid || !/^[0-9a-f]{64}$/.test(aid)) {
          return jsonResponse({ error: 'aid required (64-hex asset_id)' }, 400, cors);
        }
        const note = url.searchParams.get('note') || null;
        const meta = { verified_at: Math.floor(Date.now() / 1000), source: 'admin', note };
        await env.REGISTRY_KV.put(verifiedKey(network, aid), JSON.stringify(meta));
        // Bust read-side caches so the badge surfaces on the next user request
        // instead of waiting up to 5 min for the SWR stale window.
        await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
        await caches.default.delete(assetsCacheKey(network, null, true)).catch(() => {});
        return jsonResponse({ network, aid, verified: true, ...meta }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    if (url.pathname === '/admin/verify' && req.method === 'DELETE') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const aid = url.searchParams.get('aid');
        if (!aid || !/^[0-9a-f]{64}$/.test(aid)) {
          return jsonResponse({ error: 'aid required (64-hex asset_id)' }, 400, cors);
        }
        await env.REGISTRY_KV.delete(verifiedKey(network, aid));
        await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
        await caches.default.delete(assetsCacheKey(network, null, true)).catch(() => {});
        return jsonResponse({ network, aid, verified: false }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    if (url.pathname === '/admin/promote-orphans' && req.method === 'POST') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const maxStr = url.searchParams.get('max');
        const maxOps = maxStr ? Math.max(1, Math.min(2000, parseInt(maxStr, 10) || 1000)) : 1000;
        const aid = url.searchParams.get('aid');
        const assetIdHex = aid && /^[0-9a-f]{64}$/.test(aid) ? aid : null;
        const result = await promotePmintOrphans(env, network, { maxOps, assetIdHex });
        // Bust the /petch-assets edge cache and the slim per-asset /pmints
        // cache so the next read sees freshly-promoted credits rather than
        // 5-min-stale "0 credited" data. Fire-and-forget; the response goes
        // out without waiting on the recompute.
        if (result.promoted > 0) {
          await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
          ctx.waitUntil(petchAssetsComputeAndCache(env, network).catch(() => {}));
        }
        return jsonResponse(result, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    // Force a cap-progress snapshot refresh. ?aid=<hex> targets one asset;
    // ?all=1 walks the petch namespace and refreshes every asset (bounded
    // by the worker's wall-time budget — heavy ones might need multiple
    // calls). Use this after a deploy to backfill FAIR-scale assets that
    // would otherwise wait one cron tick per asset for bootstrap.
    if (url.pathname === '/admin/petch-progress/rebuild' && req.method === 'POST') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const aid = url.searchParams.get('aid');
        const all = url.searchParams.get('all') === '1';
        const tip = await fetchTipHeight(env, network);
        if (aid && /^[0-9a-f]{64}$/.test(aid)) {
          const petch = await env.REGISTRY_KV.get(petchKey(network, aid), 'json');
          if (!petch) return jsonResponse({ error: 'unknown petch asset_id' }, 404, cors);
          const snap = await refreshAndStorePetchProgress(env, network, aid, tip, petch);
          await env.REGISTRY_KV.delete(petchDirtyKey(network, aid)).catch(() => {});
          await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
          return jsonResponse({ network, aid, snapshot: snap }, 200, cors);
        }
        if (all) {
          const petches = await env.REGISTRY_KV.list({ prefix: petchPrefix(network), limit: 1000 });
          const results = [];
          for (const k of petches.keys) {
            const a = k.name.slice(petchPrefix(network).length);
            if (!/^[0-9a-f]{64}$/.test(a)) continue;
            try {
              const petch = await env.REGISTRY_KV.get(k.name, 'json');
              if (!petch) continue;
              const snap = await refreshAndStorePetchProgress(env, network, a, tip, petch);
              await env.REGISTRY_KV.delete(petchDirtyKey(network, a)).catch(() => {});
              results.push({ aid: a, credited_count: snap.credited_count, truncated: snap.truncated });
            } catch (e) {
              results.push({ aid: a, error: e.message });
            }
          }
          await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
          return jsonResponse({ network, count: results.length, results }, 200, cors);
        }
        return jsonResponse({ error: 'pass ?aid=<hex> or ?all=1' }, 400, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    // Snapshot health audit for ops. Lists every petch asset with its
    // snapshot's key health fields — credited_count, bootstrapped state,
    // last refresh timestamp, dirty flag. Pure read, no side effects.
    // Useful for: spotting un-bootstrapped assets, detecting stale snapshots
    // (cron stuck?), confirming admin rebuilds landed, debugging mint
    // discrepancies between dapp and worker.
    if (url.pathname === '/admin/petch-progress/status' && req.method === 'GET') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const now = Math.floor(Date.now() / 1000);
        const petches = await env.REGISTRY_KV.list({ prefix: petchPrefix(network), limit: 1000 });
        const results = await Promise.all(petches.keys.map(async k => {
          const aid = k.name.slice(petchPrefix(network).length);
          if (!/^[0-9a-f]{64}$/.test(aid)) return null;
          const [petch, snap, dirty] = await Promise.all([
            env.REGISTRY_KV.get(k.name, 'json').catch(() => null),
            readPetchProgress(env, network, aid).catch(() => null),
            env.REGISTRY_KV.get(petchDirtyKey(network, aid)).catch(() => null),
          ]);
          return {
            aid,
            ticker: petch?.ticker ?? null,
            has_snapshot: !!snap,
            bootstrapped: !!snap?.bootstrapped,
            truncated: !!snap?.truncated,
            credited_count: snap?.credited_count ?? null,
            credited_amount: snap?.credited_amount ?? null,
            cap_overflow_count: snap?.cap_overflow_count ?? null,
            cap_overflow_truncated: !!snap?.cap_overflow_truncated,
            orphan_count: snap?.orphan_count ?? null,
            last_credited_height: snap?.last_credited_height ?? null,
            snapshot_updated_at: snap?.updated_at ?? null,
            snapshot_age_secs: snap?.updated_at ? now - snap.updated_at : null,
            tip_at_update: snap?.tip_at_update ?? null,
            dirty: !!dirty,
          };
        }));
        const assets = results.filter(r => r);
        return jsonResponse({
          network,
          count: assets.length,
          now,
          assets: assets.sort((a, b) => (b.credited_count || 0) - (a.credited_count || 0)),
        }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }
    // POST /admin/pmint-backfill?aid=<hex>&from=<h>&to=<h>[&max_blocks=N][&dry_run=1]
    // Rescans the chain across [from, min(to, from+max_blocks-1)] for T_PMINT
    // envelopes against `aid` and writes any canonical pmint:* entries the
    // cron missed. Recovers dense fair-launch blocks where the per-cron-tick
    // subrequest budget tipped past 1000 before the block's pmint tail was
    // indexed (silent-drop case documented at the §5.9 cron block). Applies
    // §5.9 steps 1-5 identically to the cron — including the commitment-
    // opening check — so this never indexes anything the cron would have
    // rejected. Asset-scoped + height-bounded; long ranges walk in chunks.
    if (url.pathname === '/admin/pmint-backfill' && req.method === 'POST') {
      if (!checkDebugAuth(req, env)) return jsonResponse({ error: 'not found' }, 404, cors);
      try {
        const aid = url.searchParams.get('aid');
        if (!aid || !/^[0-9a-f]{64}$/.test(aid)) {
          return jsonResponse({ error: 'aid required (64-hex asset_id)' }, 400, cors);
        }
        const from = parseInt(url.searchParams.get('from') || '', 10);
        const to = parseInt(url.searchParams.get('to') || '', 10);
        if (!Number.isInteger(from) || from < 0) return jsonResponse({ error: 'from required (non-negative int)' }, 400, cors);
        if (!Number.isInteger(to) || to < from) return jsonResponse({ error: 'to required (>= from)' }, 400, cors);
        // 5 blocks fits a single Worker invocation comfortably on dense FAIR-
        // scale assets: ~12 page-fetches/block + ~300 pmints/block × (KV.get
        // already-present probe is replaced by the upfront list, so per-pmint
        // cost is ~1 KV.put). Total subrequests stay under the 1000 ceiling
        // with headroom for the upfront key-list (≤300 calls for FAIR's ~93k
        // existing entries). Capped at 50 so a runaway parameter can't loop.
        const maxBlocks = Math.max(1, Math.min(50, parseInt(url.searchParams.get('max_blocks') || '5', 10) || 5));
        const dryRun = url.searchParams.get('dry_run') === '1';
        const endHeight = Math.min(to, from + maxBlocks - 1);
        const petch = await env.REGISTRY_KV.get(petchKey(network, aid), 'json');
        if (!petch) return jsonResponse({ error: 'unknown petch asset_id' }, 404, cors);
        // Build the set of canonical (h, ti, txid) keys already in KV. One
        // KV.list pass up front replaces a per-candidate KV.get probe inside
        // the block loop — for FAIR (~94k existing entries) that's ~94 list
        // calls vs ~1500 gets if we did one per candidate. The orphan range
        // is included in the set so we don't double-write a pmint that's
        // already pending at height-0 (the orphan promoter will rewrite it).
        const existing = new Set();
        {
          let cursor = null;
          for (let page = 0; page < PETCH_REFRESH_MAX_PAGES; page++) {
            const lst = await env.REGISTRY_KV.list({
              prefix: pmintPrefix(network, aid),
              limit: 1000,
              ...(cursor ? { cursor } : {}),
            });
            for (const k of lst.keys) existing.add(k.name);
            if (lst.list_complete) break;
            cursor = lst.cursor;
            if (!cursor) break;
          }
        }
        const stats = {
          blocks_scanned: 0,
          txs_scanned: 0,
          wrote: 0,
          already_present: 0,
          rejected_decoder: 0,
          rejected_aid_derivation: 0,
          rejected_wrong_asset: 0,
          rejected_wrong_amount: 0,
          rejected_out_of_window: 0,
          rejected_commitment_mismatch: 0,
        };
        for (let h = from; h <= endHeight; h++) {
          let blockHash;
          try { blockHash = (await apiText(env, `/block-height/${h}`, {}, network)).trim(); }
          catch { break; }
          let txs;
          try { txs = await fetchBlockTxsParallel(env, blockHash, network); }
          catch { break; }
          stats.blocks_scanned++;
          let txIndex = -1;
          for (const tx of txs) {
            txIndex++;
            stats.txs_scanned++;
            if (!tx.vin || !tx.vin[0] || !tx.vin[0].witness || tx.vin[0].witness.length < 3) continue;
            let envBytes;
            try { envBytes = hexToBytes(tx.vin[0].witness[1]); } catch { continue; }
            const decoded = decodeEnvelopeScript(envBytes);
            if (!decoded || decoded.opcode !== T_PMINT) continue;
            const cm = decodeCPmintPayload(decoded.payload);
            if (!cm) { stats.rejected_decoder++; continue; }
            const derivedAid = assetIdFor(cm.etch_txid, 0);
            if (derivedAid !== cm.asset_id) { stats.rejected_aid_derivation++; continue; }
            // Asset filter — pmints for other assets in the same block are
            // irrelevant to this call. A separate backfill run handles them.
            if (derivedAid !== aid) { stats.rejected_wrong_asset++; continue; }
            try {
              if (BigInt(cm.amount) !== BigInt(petch.mint_limit)) { stats.rejected_wrong_amount++; continue; }
            } catch { stats.rejected_wrong_amount++; continue; }
            const startH = Number(petch.mint_start_height) || 0;
            const endH = Number(petch.mint_end_height) || 0;
            const etchedAt = Number(petch.etched_at_height) || 0;
            const effectiveStart = startH !== 0 ? startH : etchedAt + 1;
            if (h < effectiveStart || (endH !== 0 && h > endH)) { stats.rejected_out_of_window++; continue; }
            if (!pmintCommitmentOpens(cm.amount, cm.blinding, cm.commitment)) {
              stats.rejected_commitment_mismatch++; continue;
            }
            const pmk = pmintKeyFor(network, derivedAid, h, txIndex, tx.txid);
            if (existing.has(pmk)) { stats.already_present++; continue; }
            if (!dryRun) {
              const mintMeta = {
                asset_id: derivedAid,
                etch_txid: cm.etch_txid,
                mint_txid: tx.txid,
                mint_vout: 0,
                commitment: cm.commitment,
                amount: cm.amount,
                blinding: cm.blinding,
                minted_at_height: h,
                minted_at: tx.status?.block_time || Math.floor(Date.now() / 1000),
                kind: 'pmint',
                tx_index: txIndex,
                network,
              };
              await env.REGISTRY_KV.put(pmk, JSON.stringify(mintMeta));
              existing.add(pmk);
            }
            stats.wrote++;
          }
        }
        if (stats.wrote > 0 && !dryRun) {
          await markPetchDirty(env, network, aid);
          const tip = await fetchTipHeight(env, network);
          ctx.waitUntil(refreshAndStorePetchProgress(env, network, aid, tip, petch).catch(() => {}));
          ctx.waitUntil(caches.default.delete(petchAssetsCacheKey(network)).catch(() => {}));
        }
        return jsonResponse({
          network, aid, dry_run: dryRun,
          from, to: endHeight, requested_to: to,
          complete: endHeight >= to,
          ...stats,
        }, 200, cors);
      } catch (e) { return jsonResponse({ error: e.message }, 500, cors); }
    }

    return jsonResponse({ error: 'not found' }, 404, cors);
  },

  async scheduled(_event, env, ctx) {
    // Scan both networks each cron tick. Failures in one don't affect the other.
    ctx.waitUntil((async () => {
      await Promise.allSettled(
        NETWORKS.map(net => scanForEtches(env, net).catch(() => {})),
      );
      // Sweep abandoned variable-fill bid partial-claims and refund their
      // fill_amount back to the parent bid (§5.7.7 *Re-credit on
      // abandonment*). Bounded per network to keep cron CPU under budget.
      await Promise.allSettled(
        NETWORKS.map(net => sweepBidPartialClaims(env, net).catch(() => {})),
      );
      // Heal a small batch of height-0 orphan T_PMINTs each tick. Bounded
      // to 15 ops/network/tick so the cron isolate stays under the 128 MiB
      // memory ceiling even when /petch-assets pre-warm runs alongside it.
      // A bigger backlog can be drained in one shot via /admin/promote-orphans.
      await Promise.allSettled(
        NETWORKS.map(net => promotePmintOrphans(env, net, { maxOps: 15 }).catch(() => {})),
      );
      // After the scan updates KV, pre-warm the /assets edge cache for both
      // networks. Without this, the first user to hit /assets after a quiet
      // period pays the full MISS cost (~2-3s on cold mainnet). With the
      // pre-warm, the SWR layer always has a fresh-or-stale entry to serve
      // instantly. We pre-warm the default (no-limit, mints=true) shape since
      // that's what Discover/Market/lander all hit; specialized callers with
      // ?limit= or ?mints=0 still pay one MISS but they're rare paths.
      await Promise.allSettled(
        NETWORKS.map(net => assetsComputeAndCache(env, net, { limit: null, includeMints: true }).catch(() => {})),
      );
      // Pre-warm the /market aggregate too. Internally calls handleAssetsList
      // with mints=false (a separate cache shape from the Discover pre-warm
      // above), so /market clients get the lean joined payload from cache
      // without ever waiting on a synchronous KV fan-out.
      await Promise.allSettled(
        NETWORKS.map(net => marketComputeAndCache(env, net).catch(() => {})),
      );
      // Refresh per-asset cap-progress snapshots for assets that received
      // new pmints this tick (dirty markers set by scanForEtches's T_PMINT
      // branch and by /assets/hint POSTs). Bootstrap any asset that has no
      // snapshot yet. Snapshot reads are O(1) for the /petch-assets endpoint
      // so this is where the O(N) key-only scan cost gets amortized — at
      // most once per asset per 5-min tick instead of once per user request.
      await Promise.allSettled(
        NETWORKS.map(net => refreshDirtyPetchSnapshots(env, net).catch(() => {})),
      );
      // Pre-warm /petch-assets. With snapshots in place the MISS path is
      // cheap (one KV.get per asset), but the cron still warms it so the
      // first user request after a deploy or cache flush hits HIT immediately.
      await Promise.allSettled(
        NETWORKS.map(net => petchAssetsComputeAndCache(env, net).catch(() => {})),
      );
    })());

    // PMINT backfill runs in a SEPARATE ctx.waitUntil block (issue #31 FAIR
    // recovery). The main cron block above gets crowded by FAIR's heavy
    // snapshot refresh (94k+ KV entries to scan) plus 2-network forward scan
    // plus pre-warms — leaving no wall-time budget for backfill. Splitting
    // into two blocks doesn't grant separate wall-time per CF docs, but it
    // does ensure backfill starts even if the main block is killed mid-way.
    // No-op after `cursor.completed_at` is set.
    ctx.waitUntil(runPmintBackfills(env).catch(() => {}));
  },
};
