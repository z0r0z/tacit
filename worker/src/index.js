// tacit-pin Worker
//
// All network-scoped endpoints accept ?network=signet|mainnet. The query
// default is signet so older clients calling /assets without the query
// keep working unchanged; the current dapp explicitly sends ?network=mainnet.
// KV keys are namespaced per network: signet keeps its legacy unprefixed form
// (asset:<aid>), mainnet uses asset:mainnet:<aid>.
//
// Endpoints:
//   POST /pin               — upload an image; returns { cid, size }
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
const T_PETCH    = 0x27; // permissionless-mint deployment record (SPEC §5.8)
const T_PMINT    = 0x28; // permissionless mint event against a T_PETCH ancestor (SPEC §5.9)
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
// (height, tx_index) as the canonical sort, not (height, txid). The audit
// caught my v1 mistake of using txid as the tiebreaker (lex order ≠
// position-in-block); fix #2 plumbs the cron's loop index through and
// pads it to 6 digits (1M txs/block headroom). Without this, two
// same-block T_PMINTs picking the last cap slot pick the wrong winner
// vs SPEC.
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
async function handleCeremonyContribute(req, env, circuitHash, cors) {
  if (!env.PINATA_JWT) return jsonResponse({ error: 'PINATA_JWT missing' }, 500, cors);
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const state = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!state) return jsonResponse({ error: 'ceremony not found — initialize first' }, 404, cors);
  if (state.finalized) return jsonResponse({ error: 'ceremony has been finalized; chain is locked' }, 409, cors);

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
  return jsonResponse({ state: newState, contribution: rec }, 200, cors);
}

async function handleCeremonyAttestations(req, env, url, circuitHash, cors) {
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const limit = Math.max(1, Math.min(safeInt(url.searchParams.get('limit'), 100, { min: 1, max: 1000 }), 1000));
  const cursor = url.searchParams.get('cursor') || undefined;
  // Two modes:
  //
  // 1. **Cursor mode** (`?cursor=<token>`): forward-pagination through the
  //    full record set. Each call returns up to `limit` records starting
  //    from the cursor, plus a next-page cursor. Used by audit tooling that
  //    needs every record (e.g., post-finalize verification, bulk export).
  //
  // 2. **Recent mode** (no cursor, default): returns the *truly* latest
  //    `limit` records by walking every page server-side and slicing the
  //    last `limit` from the alphabetically-sorted list. This is what UI
  //    "recent contributions" panels actually want. Without this server-
  //    side walk, the dapp would see only the alphabetically-first `limit`
  //    records (= lowest idx, oldest contributions), which freezes the
  //    "recent" panel at the start of the chain once the ceremony grows
  //    past the default limit. The walk is bounded at 50 pages × 1000 keys
  //    = 50k records — well past any realistic ceremony scale.
  if (cursor) {
    const list = await env.REGISTRY_KV.list({
      prefix: ceremonyContribPrefix(circuitHash),
      limit,
      cursor,
    });
    const attestations = [];
    for (const k of list.keys) {
      const r = await env.REGISTRY_KV.get(k.name, 'json');
      if (r) attestations.push(r);
    }
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
  const recentKeys = allKeys.slice(Math.max(0, allKeys.length - limit));
  const attestations = [];
  for (const k of recentKeys) {
    const r = await env.REGISTRY_KV.get(k.name, 'json');
    if (r) attestations.push(r);
  }
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
  return jsonResponse({ ok: true, deleted: deleted + 1 }, 200, cors);
}

// POST /ceremony/:circuit_hash/finalize — coordinator finalizes the ceremony
// by uploading a beacon-applied zkey. After finalize, the ceremony is locked:
// further contribute calls are rejected. Multipart form: zkey (file),
// beacon_block_hash (hex string for audit trail), beacon_iterations (int).
// SPEC §3.7's beacon application closes the late-Sybil collusion window.
async function handleCeremonyFinalize(req, env, circuitHash, cors) {
  if (!ceremonyAuthOk(req, env)) {
    return jsonResponse({ error: 'unauthorized' }, 401, cors);
  }
  if (!/^[0-9a-f]{64}$/.test(circuitHash)) {
    return jsonResponse({ error: 'invalid circuit_hash' }, 400, cors);
  }
  const state = await env.REGISTRY_KV.get(ceremonyKey(circuitHash), 'json');
  if (!state) return jsonResponse({ error: 'ceremony not found' }, 404, cors);
  if (state.finalized) return jsonResponse({ error: 'ceremony already finalized', state }, 409, cors);

  let fd;
  try { fd = await req.formData(); }
  catch { return jsonResponse({ error: 'expected multipart form-data' }, 400, cors); }
  const zkey = fd.get('zkey');
  const beaconHash = String(fd.get('beacon_block_hash') || '').toLowerCase();
  const beaconIters = safeInt(fd.get('beacon_iterations'), 10, { min: 1, max: 64 });
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

  const newCount = (state.contribution_count || 0) + 1;
  const newState = {
    ...state,
    head_cid: finalCid,
    contribution_count: newCount,
    last_contributor: 'beacon',
    last_contributed_at: Math.floor(Date.now() / 1000),
    finalized: true,
    beacon_block_hash: beaconHash,
    beacon_iterations: beaconIters,
    finalized_at: Math.floor(Date.now() / 1000),
  };
  await env.REGISTRY_KV.put(ceremonyKey(circuitHash), JSON.stringify(newState));

  const rec = {
    index: newCount,
    cid: finalCid,
    contributor_name: 'beacon',
    contribution_hash: beaconHash,
    contributed_at: newState.last_contributed_at,
    prev_cid: state.head_cid,
    is_beacon: true,
    beacon_iterations: beaconIters,
  };
  await env.REGISTRY_KV.put(ceremonyContribKey(circuitHash, newCount, finalCid), JSON.stringify(rec));

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

// T_BURN structural decoder. Burns are simpler than mints because the burned
// amount is public — no Pedersen indirection. We only extract asset_id and
// burned_amount. The kernel sig + remaining outputs are validated client-side.
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
  const [att, mints, burns, op, dc, ls, lr, ai, xfer, lastTrade] = await Promise.all([
    env.REGISTRY_KV.get(attestKey(network, v.asset_id), 'json'),
    includeMints ? loadMintsForAsset(env, network, v.asset_id) : Promise.resolve(null),
    loadBurnsForAsset(env, network, v.asset_id),
    env.REGISTRY_KV.list({ prefix: openingPrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: disclosurePrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: listingPrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: rangeListingPrefix(network, v.asset_id), limit: 1000 }),
    env.REGISTRY_KV.list({ prefix: atomicIntentPrefix(network, v.asset_id), limit: 1000 }),
    // Single KV.get of the cron-maintained transfer counter — folded into
    // the existing parallel fan-out so it adds zero round-trip latency.
    env.REGISTRY_KV.get(transferCountKey(network, v.asset_id)),
    env.REGISTRY_KV.get(lastTradeKey(network, v.asset_id), 'json'),
  ]);
  if (att) v.attestation = att;
  if (includeMints) v.mints = mints;
  v.burns = burns;
  v.opening_count = op.keys.length;
  v.disclosure_count = dc.keys.length;
  v.listing_count = ls.keys.length;
  v.range_listing_count = lr.keys.length;
  v.atomic_intent_count = ai.keys.length;
  v.transfer_count = parseInt(xfer || '0', 10) || 0;
  if (lastTrade) v.last_trade = lastTrade;
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
    || Number(a.atomic_intent_count || 0) > 0,
  );
  // Per-asset 3-way fan-out, all in this single worker invocation.
  // Best-effort: a per-asset failure leaves an empty bucket for that kind so
  // the rest of the response is still useful, mirroring the client's existing
  // .catch(() => ({listings: []})) tolerance.
  const all = await Promise.all(haveAny.map(async a => {
    const aid = a.asset_id;
    const [openings, ranges, intents] = await Promise.all([
      Number(a.listing_count || 0) > 0
        ? loadListingsForAsset(env, network, aid).catch(() => [])
        : Promise.resolve([]),
      Number(a.range_listing_count || 0) > 0
        ? loadRangeListingsForAsset(env, network, aid).catch(() => [])
        : Promise.resolve([]),
      Number(a.atomic_intent_count || 0) > 0
        ? loadAtomicIntentsForAsset(env, network, aid).catch(() => [])
        : Promise.resolve([]),
    ]);
    // Strip expired and attach kind + _asset reference so the client can sort
    // and filter without needing to re-join against the assets array.
    const opens = openings.filter(l => !l.expired).map(l => ({ ...l, kind: 'opening', _asset: a }));
    const ranges_ = ranges.filter(l => !l.expired).map(l => ({ ...l, kind: 'range', _asset: a }));
    const intents_ = intents.filter(i => !i.expired).map(i => ({ ...i, kind: 'intent', _asset: a }));
    return [...opens, ...ranges_, ...intents_];
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
async function handleAssetHint(req, env, network, cors) {
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
  if (decoded.opcode === T_CXFER || decoded.opcode === T_AXFER) {
    const decoder = decoded.opcode === T_AXFER ? decodeAxferPayload : decodeCXferPayload;
    const dx = decoder(decoded.payload);
    if (!dx) return jsonResponse({ error: 'invalid transfer payload' }, 400, cors);
    const counted = await bumpTransferCount(env, network, dx.asset_id, txidHex);
    // Optional last-traded record. Only AXFER (atomic-OTC settlement) has a
    // well-defined trade price the dapp can vouch for at broadcast time.
    // Validate format strictly so a malformed body can't poison the field;
    // the worker doesn't independently verify the price (intent record may
    // already be GC'd), so we trust well-formed input. Last-write wins.
    let lastTrade = null;
    if (decoded.opcode === T_AXFER
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
          await env.REGISTRY_KV.put(lastTradeKey(network, dx.asset_id), JSON.stringify(lastTrade));
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
    // Delete the cached /petch-assets response and recompute. `caches.default`
    // is per-POP, so a single delete only invalidates this POP — but the
    // recompute writes a fresh entry that other POPs will pick up on their
    // next miss / FRESH-window expiry. Without the delete, this POP keeps
    // serving the pre-hint FRESH entry for up to PETCH_ASSETS_CACHE_FRESH_MS
    // even though we just wrote new state.
    await caches.default.delete(petchAssetsCacheKey(network)).catch(() => {});
    petchAssetsComputeAndCache(env, network).catch(() => {});
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
  const dc = await env.REGISTRY_KV.list({ prefix: disclosurePrefix(network, assetIdHex), limit: 1000 });
  v.disclosure_count = dc.keys.length;
  const ls = await env.REGISTRY_KV.list({ prefix: listingPrefix(network, assetIdHex), limit: 1000 });
  v.listing_count = ls.keys.length;
  const lr = await env.REGISTRY_KV.list({ prefix: rangeListingPrefix(network, assetIdHex), limit: 1000 });
  v.range_listing_count = lr.keys.length;
  const ai = await env.REGISTRY_KV.list({ prefix: atomicIntentPrefix(network, assetIdHex), limit: 1000 });
  v.atomic_intent_count = ai.keys.length;
  // transfer_count + last_trade are also in the /assets list response via
  // hydrateAssetSummary; mirror them here so single-asset clients get the
  // same discovery metrics.
  const xfer = await env.REGISTRY_KV.get(transferCountKey(network, assetIdHex));
  v.transfer_count = parseInt(xfer || '0', 10) || 0;
  const lastTrade = await env.REGISTRY_KV.get(lastTradeKey(network, assetIdHex), 'json');
  if (lastTrade) v.last_trade = lastTrade;
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

// GET /petch-assets — registry of T_PETCH-rooted assets. Same envelope shape
// as /assets plus per-asset cap progress (cumulative_minted / cap_amount /
// remaining) computed at read time. Kept distinct from /assets so a Discover
// UI can present each issuance model in its own pane without the other
// polluting; consumers wanting a unified list union both endpoints.
async function handlePetchAssetsList(env, network, cors, { limit = 1000 } = {}) {
  const list = await env.REGISTRY_KV.list({ prefix: petchPrefix(network), limit });
  const tipP = Promise.race([
    apiText(env, '/blocks/tip/height', {}, network).then(s => parseInt(s.trim(), 10)),
    new Promise(resolve => setTimeout(() => resolve(null), 2500)),
  ]).catch(() => null);
  // Curated verified set in parallel; same semantics as /assets.
  const verifiedP = loadVerifiedSet(env, network).catch(() => new Set());
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const assets = fetched.filter(v => v);
  const verifiedSet = await verifiedP;
  for (const a of assets) a.verified = verifiedSet.has(a.asset_id);
  assets.sort((a, b) => (b.etched_at || 0) - (a.etched_at || 0));
  const tipHeight = await tipP;
  // Hydrate cap progress per asset using KEY-ONLY pagination — every fact
  // we surface (credited count, cumulative_minted, pending count) is
  // derivable from canonical keys alone (height + tx_index + txid). Skipping
  // the per-key value fetch is critical on heavy assets (FAIR's ~30k
  // canonical entries) where the previous Promise.all-fetched loader hit
  // the Worker wall-time ceiling and the whole /petch-assets response
  // timed out.
  await Promise.all(assets.map(async a => {
    const aid = a.asset_id;
    const orphanPrefix = pmintPrefix(network, aid) + '0000000000:';
    const capAmount = a.cap_amount != null ? BigInt(a.cap_amount) : null;
    const mintLimit = a.mint_limit != null ? BigInt(a.mint_limit) : null;
    let creditedCount = 0;
    let creditedAmount = 0n;
    let canonicalCount = 0;
    let pendingCount = 0;       // canonical entries below confirmation depth
    let truncated = false;
    let canonicalComplete = false;
    let cursor = null;
    const SAFETY_CAP = 50000;
    for (let page = 0; page < 60; page++) {
      const lst = await env.REGISTRY_KV.list({
        prefix: pmintPrefix(network, aid),
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const k of lst.keys) {
        if (k.name.startsWith(orphanPrefix)) continue;
        canonicalCount++;
        const parts = k.name.split(':');
        const h = parseInt(parts[parts.length - 3], 10);
        if (!Number.isInteger(h)) continue;
        if (Number.isInteger(tipHeight)) {
          const depth = Math.max(0, tipHeight - h + 1);
          if (depth < PMINT_CONFIRMATION_DEPTH) { pendingCount++; continue; }
        }
        if (capAmount != null && mintLimit != null) {
          const wouldBe = creditedAmount + mintLimit;
          if (wouldBe > capAmount) continue; // cap_overflow — exclude from credit
          creditedAmount = wouldBe;
          creditedCount++;
        } else {
          creditedCount++;
          if (mintLimit != null) creditedAmount += mintLimit;
        }
        if (canonicalCount >= SAFETY_CAP) { truncated = true; break; }
      }
      if (truncated) break;
      if (lst.list_complete) { canonicalComplete = true; break; }
      cursor = lst.cursor;
      if (!cursor) { canonicalComplete = true; break; }
    }
    if (!canonicalComplete && !truncated) truncated = true; // hit page-loop bound
    // Count orphan keys with a separate lightweight scan — they all share the
    // height-0 prefix and we just need a count for the UI.
    let orphanCount = 0;
    let orphanComplete = false;
    cursor = null;
    for (let page = 0; page < 60; page++) {
      const lst = await env.REGISTRY_KV.list({ prefix: orphanPrefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      orphanCount += lst.keys.length;
      if (lst.list_complete) { orphanComplete = true; break; }
      if (orphanCount >= SAFETY_CAP) { truncated = true; break; }
      cursor = lst.cursor;
      if (!cursor) { orphanComplete = true; break; }
    }
    if (!orphanComplete && !truncated) truncated = true;
    a.cumulative_minted = creditedAmount.toString();
    a.credited_pmint_count = creditedCount;
    a.pmint_count = canonicalCount + orphanCount;
    a.pending_pmint_count = pendingCount + orphanCount;
    a.truncated = truncated;
    if (a.cap_amount && a.mint_limit) {
      const remaining = BigInt(a.cap_amount) - creditedAmount;
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
  const tip = await Promise.race([
    apiText(env, '/blocks/tip/height', {}, network).then(s => parseInt(s.trim(), 10)),
    new Promise(resolve => setTimeout(() => resolve(null), 2500)),
  ]).catch(() => null);
  // Slim path: the dapp's validateOutpoint hot path only needs the set of
  // credited mint txids. Every fact required for the credit decision is
  // already encoded in the canonical key (height, tx_index, txid), so we
  // can list keys without ever fetching values — saves N×500B of JSON
  // payloads + N parallel KV.get calls when N is in the thousands. Without
  // this, /pmints?credited=1 on a heavy asset (FAIR with 26k+ canonical
  // entries) tips past the Worker wall-time ceiling.
  if (opts.creditedOnly) {
    const orphanPrefixStr = pmintPrefix(network, assetIdHex) + '0000000000:';
    const capAmount = petch.cap_amount != null ? BigInt(petch.cap_amount) : null;
    const mintLimit = petch.mint_limit != null ? BigInt(petch.mint_limit) : null;
    const credited_txids = [];
    const cap_overflow_txids = [];
    let creditedAmount = 0n;
    let canonCursor = null;
    let collected = 0;
    let truncated = false;
    const SAFETY_CAP = 50000;
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
            cap_overflow_txids.push(txid);
            continue;
          }
          creditedAmount = wouldBe;
        }
        credited_txids.push(txid);
        collected++;
        if (collected >= SAFETY_CAP) { truncated = true; break; }
      }
      if (truncated) break;
      if (list.list_complete) { var canonicalComplete = true; break; }
      canonCursor = list.cursor;
      if (!canonCursor) { var canonicalComplete = true; break; }
    }
    // Issue #13 explicitly asked for this signal so consumers can distinguish
    // "complete view" from "first N mints only." Without it the silent cap
    // was the original v1 bug. We flag truncated unless we exited the page
    // loop via either list_complete or a falsy cursor — both indicate the
    // KV.list namespace was fully drained for this prefix.
    if (typeof canonicalComplete === 'undefined') canonicalComplete = false;
    if (!canonicalComplete && !truncated) truncated = true;
    // cap_overflow is published alongside credited so the dapp can distinguish
    // "pending — will eventually credit" from "permanently rejected — paid
    // fees for nothing." Without the overflow list, the wallet would have to
    // either fall back to the full /pmints endpoint or treat overflow as
    // pending indefinitely (audit fix #1 partial).
    return jsonResponse({
      asset_id: assetIdHex,
      network,
      credited_txids,
      cap_overflow_txids,
      confirmation_depth: PMINT_CONFIRMATION_DEPTH,
      tip: Number.isInteger(tip) ? tip : null,
      tip_unavailable: !Number.isInteger(tip),
      truncated,
      list_complete: !truncated,
    }, 200, cors);
  }
  const r = await loadCanonicalPmints(env, network, assetIdHex, tip, petch.cap_amount, petch.mint_limit);
  return jsonResponse({
    asset_id: assetIdHex,
    network,
    cap_amount: petch.cap_amount,
    mint_limit: petch.mint_limit,
    cumulative_minted: r.cumulative_minted,
    credited_count: parseInt(r.credited_count, 10) || 0,
    pending_count: r.events.filter(e => e.status === 'pending').length,
    cap_overflow_count: r.events.filter(e => e.status === 'cap_overflow').length,
    confirmation_depth: PMINT_CONFIRMATION_DEPTH,
    tip: Number.isInteger(tip) ? tip : null,
    tip_unavailable: !Number.isInteger(tip),
    pmints: r.events,
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

// Bumped to v2: message now binds the taker's committed sat UTXO. Without
// the binding, a third party could replay a captured v1 sig pointing the
// claim at a different UTXO. Worker enforces value >= price_sats on this
// UTXO at claim time so a sig over (asset, intent, pub, utxo) attests to
// "this pubkey controlled funds ≥ price_sats sitting at this outpoint".
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

async function handleAtomicIntentPost(assetIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

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
const AIRDROP_LIST_HARD_CAP = 10000; // total per response; bound size + cost

// Layered daily rate limit for airdrop-claim POST and DELETE. Without this an
// attacker could fill KV with junk submissions for any root, or wipe a
// recipient's submission before the issuer pulls. The IP cap is generous so a
// legitimate recipient who needs to re-sign isn't blocked; the per-pubkey cap
// (POST-only — DELETE has no signed pubkey) forces a determined attacker to
// rotate keys as well as IPs, mirroring the layered defense on /drops.
async function _airdropRateLimit(req, env, tacitPubHex) {
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `airdrop-rl:ip:${day}:${ip}`;
  const ipLimit = safeInt(env.AIRDROP_DAILY_LIMIT, 200, { min: 1 });
  const ipPrior = safeInt(await env.REGISTRY_KV.get(ipKey), 0, { min: 0 });
  if (ipPrior >= ipLimit) return { ok: false, reason: `IP daily limit (${ipLimit}/day)` };
  if (tacitPubHex) {
    const pkKey = `airdrop-rl:pk:${day}:${tacitPubHex}`;
    const pkLimit = safeInt(env.AIRDROP_DAILY_LIMIT_PUBKEY, 50, { min: 1 });
    const pkPrior = safeInt(await env.REGISTRY_KV.get(pkKey), 0, { min: 0 });
    if (pkPrior >= pkLimit) return { ok: false, reason: `pubkey daily limit (${pkLimit}/day)` };
    await env.REGISTRY_KV.put(pkKey, String(pkPrior + 1), { expirationTtl: 90000 });
  }
  await env.REGISTRY_KV.put(ipKey, String(ipPrior + 1), { expirationTtl: 90000 });
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

  const rl = await _airdropRateLimit(req, env, tacitPubHex);
  if (!rl.ok) return jsonResponse({ error: `airdrop limit reached: ${rl.reason}` }, 429, cors);

  const record = {
    root: rootHex,
    network,
    leaf_index: leafIndex,
    tacit_pubkey: tacitPubHex,
    eth_sig: '0x' + ethSigHex,
    submitted_at: Math.floor(Date.now() / 1000),
  };
  await env.REGISTRY_KV.put(airdropClaimKey(network, rootHex, leafIndex), JSON.stringify(record));
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
  // Same per-IP cap as POST. The endpoint is intentionally unauthenticated —
  // the issuer's dapp calls DELETE after pulling each leaf for fulfilment, and
  // doesn't have the claimant's private key to sign with. Adding sig auth
  // would break the existing flow; the rate limit bounds the blast radius of
  // a malicious deleter to AIRDROP_DAILY_LIMIT entries per day per IP, which
  // combined with claimants storing their submission locally and the issuer
  // re-pulling on each fulfilment session makes mass-wipe impractical.
  const rl = await _airdropRateLimit(req, env, null);   // null pubkey → IP-only
  if (!rl.ok) return jsonResponse({ error: `airdrop limit reached: ${rl.reason}` }, 429, cors);
  const leafIndex = safeInt(leafIndexStr, -1, { min: 0, max: AIRDROP_LEAF_INDEX_MAX });
  if (leafIndex < 0) {
    return jsonResponse({ error: 'invalid leaf_index' }, 400, cors);
  }
  await env.REGISTRY_KV.delete(airdropClaimKey(network, rootHex, leafIndex));
  return jsonResponse({ ok: true }, 200, cors);
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
  await env.REGISTRY_KV.put(dropAnnounceKey(network, rootHex), JSON.stringify(record));
  return jsonResponse({ ok: true, drop: record }, 200, cors);
}

async function handleDropAnnounceList(env, network, cors) {
  const list = await env.REGISTRY_KV.list({ prefix: dropAnnouncePrefix(network), limit: 1000 });
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const now = Math.floor(Date.now() / 1000);
  const drops = [];
  for (const v of fetched) {
    if (!v) continue;
    if (v.expires_at && v.expires_at <= now) {
      // Lazy GC: fire-and-forget delete on read. Cheaper than a sweeper cron.
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

function bidIntentMsg(assetIdHex, bidIdHex, buyerPubHex, amountStr, priceSats, expiry, nonceHex) {
  const amountLE = new Uint8Array(8);
  new DataView(amountLE.buffer).setBigUint64(0, BigInt(amountStr), true);
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-intent-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(bidIdHex),
    hexToBytes(buyerPubHex),
    amountLE,
    priceLE,
    expiryLE,
    hexToBytes(nonceHex),
  ));
}

function bidClaimMsg(assetIdHex, bidIdHex, sellerPubHex, axintentIdHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-claim-v1'),
    hexToBytes(assetIdHex),
    hexToBytes(bidIdHex),
    hexToBytes(sellerPubHex),
    hexToBytes(axintentIdHex),
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

  // Format-validate before charging the rate limit so malformed bodies don't
  // burn slots that legitimate retries might need (mirrors handleAirdropClaimPost).
  if (!/^[0-9a-f]{32}$/.test(bidIdHex))               return jsonResponse({ error: 'bid_id must be 32 hex chars (16 bytes)' }, 400, cors);
  if (!/^0[23][0-9a-f]{64}$/.test(buyerPubHex))       return jsonResponse({ error: 'buyer_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^\d+$/.test(amountStr))                       return jsonResponse({ error: 'amount must be base-10 integer string' }, 400, cors);
  if (BigInt(amountStr) <= 0n || BigInt(amountStr) >= (1n << 64n)) return jsonResponse({ error: 'amount out of u64' }, 400, cors);
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

  // Verify intent_sig under buyer_pubkey.
  const msg = bidIntentMsg(assetIdHex, bidIdHex, buyerPubHex, amountStr, priceSatsRaw, expiryRaw, nonceHex);
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
  // Decorate with claim status if a seller has claimed.
  await Promise.all(active.map(async v => {
    const claim = await env.REGISTRY_KV.get(bidClaimKey(network, assetIdHex, v.bid_id), 'json');
    if (claim && claim.expires_at > now) v.claim = claim;
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
  const claim = await env.REGISTRY_KV.get(bidClaimKey(network, assetIdHex, bidIdHex), 'json');
  if (claim && claim.expires_at > now) intent.claim = claim;
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
  return jsonResponse({ ok: true }, 200, cors);
}

const BID_CLAIM_TTL_SECONDS = 30 * 60;

async function handleBidIntentClaim(assetIdHex, bidIdHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(bidIdHex))   return jsonResponse({ error: 'invalid bid_id' }, 400, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
  const sellerPubHex = String(body.seller_pubkey ?? '').toLowerCase();
  const axintentIdHex = String(body.axintent_id ?? '').toLowerCase();
  const sigHex = String(body.sig ?? '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(sellerPubHex)) return jsonResponse({ error: 'seller_pubkey must be 33-byte compressed hex' }, 400, cors);
  if (!/^[0-9a-f]{32}$/.test(axintentIdHex))     return jsonResponse({ error: 'axintent_id must be 32 hex chars' }, 400, cors);
  if (!/^[0-9a-f]{128}$/.test(sigHex))           return jsonResponse({ error: 'sig must be 128 hex chars' }, 400, cors);

  const intent = await env.REGISTRY_KV.get(bidIntentKey(network, assetIdHex, bidIdHex), 'json');
  if (!intent) return jsonResponse({ error: 'no such bid' }, 404, cors);
  const now = Math.floor(Date.now() / 1000);
  if ((intent.expiry || 0) <= now) return jsonResponse({ error: 'bid expired' }, 410, cors);

  // Reject if already claimed by a different seller within TTL window.
  const existing = await env.REGISTRY_KV.get(bidClaimKey(network, assetIdHex, bidIdHex), 'json');
  if (existing && existing.expires_at > now && existing.seller_pubkey !== sellerPubHex) {
    return jsonResponse({ error: 'bid already claimed', claim: { expires_at: existing.expires_at } }, 409, cors);
  }

  const msg = bidClaimMsg(assetIdHex, bidIdHex, sellerPubHex, axintentIdHex);
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
    sig: sigHex,
    claimed_at: now,
    expires_at: now + BID_CLAIM_TTL_SECONDS,
    network,
  };
  await env.REGISTRY_KV.put(bidClaimKey(network, assetIdHex, bidIdHex), JSON.stringify(claim));
  return jsonResponse({ ok: true, claim, intent }, 200, cors);
}

// ============== Cron: scan signet + mainnet for new CETCH envelopes ==============
async function fetchBlockTxs(env, blockHash, network) {
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
    // Mainnet blocks can be 3000+ txs (120+ pages); cap at 5000 to bound work
    // per cron tick. The hint endpoint catches anything missed by truncation.
    if (all.length >= 5000) break;
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
    // the canonical block position (audit fix #2 + SPEC §5.9 ordering).
    // mempool.space's /block/<hash>/txs endpoint returns txs in block order,
    // so the array index IS the canonical tx_index.
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
        // Permissionless mint event (SPEC §5.9). Cron-side validation block
        // (audit fix #3 + #4): structurally-valid envelopes pass the decoder
        // length/opcode checks but the cron must additionally enforce:
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
        // Stale-orphan cleanup is now handled by the dedicated orphan
        // promoter (promotePmintOrphans, run on every cron tick). The
        // previous inline `KV.delete(stalePendingKey)` here cost one extra
        // subrequest per T_PMINT, which on dense fair-launch blocks
        // (~300 reveals/block on FAIR's first 100 blocks) was enough to
        // tip the cron past the 1000-subrequest budget mid-block, silently
        // dropping the tail of T_PMINTs from canonical indexing. Users
        // whose mints landed in the dropped tail saw "confirmed but not
        // credited" forever because last_scanned advanced anyway. Removing
        // the inline delete buys ~300 subrequests/dense-block of headroom
        // and the orphan promoter still handles legacy cleanup.
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
      }
    }
    lastContiguous = h;
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
  dropAnnounceMsg, dropAnnounceCancelMsg,
  bidIntentMsg, bidClaimMsg, bidCancelMsg,
  verifySchnorr, compressedPointFromHex,
  // Wire-format decoders + opcode constants exported so tests/worker-decoder
  // can pin down the exact return shape. The atomic-intent regression where
  // a handler read `ax.assetInputCount` (camelCase) against a snake_case
  // `asset_input_count` was silent in JS — this surface lets a test fail loudly
  // if any decoder's return-shape contract drifts.
  decodeEnvelopeScript,
  decodeCEtchPayload, decodeCMintPayload, decodeCXferPayload, decodeAxferPayload, decodeCBurnPayload,
  decodeCPetchPayload, decodeCPmintPayload,
  decodeTDepositPayload, decodeTWithdrawPayload,
  T_CETCH, T_CXFER, T_MINT, T_BURN, T_AXFER, T_PETCH, T_PMINT, T_DEPOSIT, T_WITHDRAW,
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
    if (url.pathname === '/ceremony/init' && req.method === 'POST') return handleCeremonyInit(req, env, cors);
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})$/i);
      if (m && req.method === 'GET') return handleCeremonyState(env, m[1].toLowerCase(), cors);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/contribute$/i);
      if (m && req.method === 'POST') return handleCeremonyContribute(req, env, m[1].toLowerCase(), cors);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/attestations$/i);
      if (m && req.method === 'GET') return handleCeremonyAttestations(req, env, url, m[1].toLowerCase(), cors);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/stats$/i);
      if (m && req.method === 'GET') return handleCeremonyStats(req, env, m[1].toLowerCase(), cors);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/reset$/i);
      if (m && req.method === 'POST') return handleCeremonyReset(req, env, m[1].toLowerCase(), cors);
    }
    {
      const m = url.pathname.match(/^\/ceremony\/([0-9a-f]{64})\/finalize$/i);
      if (m && req.method === 'POST') return handleCeremonyFinalize(req, env, m[1].toLowerCase(), cors);
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
    if (url.pathname === '/pools' && req.method === 'GET') {
      const pools = [];
      const list = await env.REGISTRY_KV.list({ prefix: poolPrefix(network), limit: 1000 });
      for (const k of list.keys) {
        const rec = await env.REGISTRY_KV.get(k.name, 'json');
        if (!rec) continue;
        // Lightweight stats: counts only, not full lists (the detail
        // endpoint is for that).
        const leafCount = (await env.REGISTRY_KV.list({
          prefix: poolLeafPrefix(network, rec.asset_id, rec.pool_denom),
          limit: 1000,
        })).keys.length;
        const nullifierCount = (await env.REGISTRY_KV.list({
          prefix: poolNullifierPrefix(network, rec.asset_id, rec.pool_denom),
          limit: 1000,
        })).keys.length;
        pools.push({ ...rec, leaf_count: leafCount, nullifier_count: nullifierCount });
      }
      return jsonResponse({ pools, network }, 200, cors);
    }
    // /pools/:asset_id/:denom — full per-pool state. Leaves are returned
    // in canonical KV-key order (height-padded + tx_index-padded), which
    // is the order the dApp must apply them in to reproduce the canonical
    // merkle tree.
    {
      const m = url.pathname.match(/^\/pools\/([0-9a-f]{64})\/(\d+)$/i);
      if (m && req.method === 'GET') {
        const aid = m[1].toLowerCase();
        const denom = m[2];
        const initRec = await env.REGISTRY_KV.get(poolInitKey(network, aid, denom), 'json');
        if (!initRec) return jsonResponse({ error: 'pool not found' }, 404, cors);
        // Fetch chain tip in parallel with the KV walks so the depth-gate
        // annotation can be applied without doubling latency. Tolerate tip
        // failure — when null, mark every leaf 'unknown_depth' rather than
        // assuming included (a reorg-unsafe assumption).
        const tipP = Promise.race([
          apiText(env, '/blocks/tip/height', {}, network).then(s => parseInt(s.trim(), 10)),
          new Promise(resolve => setTimeout(() => resolve(null), 2500)),
        ]).catch(() => null);
        const leafList = await env.REGISTRY_KV.list({
          prefix: poolLeafPrefix(network, aid, denom),
          limit: 1000,
        });
        const rawLeaves = [];
        for (const k of leafList.keys) {
          const rec = await env.REGISTRY_KV.get(k.name, 'json');
          if (rec) rawLeaves.push(rec);
        }
        const tipHeight = await tipP;
        // SPEC §5.10 reorg-safety: annotate each leaf with depth + status so
        // the dapp's tree builder can include only depth-≥-3 leaves. Without
        // this, a short reorg that drops a deposit silently changes the
        // canonical root for every position after it. 'unknown_depth' fires
        // when tip is unreachable — the dapp must treat it as not-yet-
        // included (reorg-safe default).
        const leaves = rawLeaves.map(rec => {
          const h = Number.isInteger(rec.deposited_at_height) ? rec.deposited_at_height : null;
          let depth = null, status;
          if (Number.isInteger(tipHeight) && Number.isInteger(h)) {
            depth = Math.max(1, tipHeight - h + 1);
            status = depth >= MIXER_DEPOSIT_CONFIRMATION_DEPTH ? 'included' : 'pending';
          } else {
            status = 'unknown_depth';
          }
          return { ...rec, depth, status };
        });
        const includedCount = leaves.filter(l => l.status === 'included').length;
        const pendingCount = leaves.filter(l => l.status === 'pending').length;
        const nullifierList = await env.REGISTRY_KV.list({
          prefix: poolNullifierPrefix(network, aid, denom),
          limit: 1000,
        });
        const nullifiers = [];
        for (const k of nullifierList.keys) {
          const rec = await env.REGISTRY_KV.get(k.name, 'json');
          if (rec) nullifiers.push(rec);
        }
        return jsonResponse({
          pool: initRec,
          leaves,
          nullifiers,
          network,
          tip: Number.isInteger(tipHeight) ? tipHeight : null,
          tip_unavailable: !Number.isInteger(tipHeight),
          confirmation_depth: MIXER_DEPOSIT_CONFIRMATION_DEPTH,
          included_leaf_count: includedCount,
          pending_leaf_count: pendingCount,
        }, 200, cors);
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
    if (url.pathname === '/assets/hint' && req.method === 'POST') return handleAssetHint(req, env, network, cors);
    // Permissionless-mint registry (T_PETCH-rooted). Kept separate from
    // /assets so consumers can filter cleanly without one mode polluting the
    // other; clients wanting "every asset" union /assets and /petch-assets.
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
      const v = await env.REGISTRY_KV.get(petchKey(network, mpa[1]), 'json');
      if (!v) return jsonResponse({ error: 'unknown petch asset_id' }, 404, cors);
      const tip = await Promise.race([
        apiText(env, '/blocks/tip/height', {}, network).then(s => parseInt(s.trim(), 10)),
        new Promise(resolve => setTimeout(() => resolve(null), 2500)),
      ]).catch(() => null);
      const r = await loadCanonicalPmints(env, network, mpa[1], tip, v.cap_amount, v.mint_limit);
      v.cumulative_minted = r.cumulative_minted;
      v.credited_pmint_count = parseInt(r.credited_count, 10) || 0;
      v.pmint_count = r.events.length;
      if (v.cap_amount && v.mint_limit) {
        const remaining = BigInt(v.cap_amount) - BigInt(v.cumulative_minted);
        v.mints_remaining = String(remaining < 0n ? 0n : remaining / BigInt(v.mint_limit));
      }
      return jsonResponse(v, 200, cors);
    }
    const mpm = url.pathname.match(/^\/assets\/([0-9a-f]{64})\/pmints$/);
    if (mpm && req.method === 'GET') {
      const creditedOnly = url.searchParams.get('credited') === '1';
      return handlePmintList(mpm[1], env, network, cors, { creditedOnly });
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
        if (lim < 1 || lim > 10000) {
          return jsonResponse({ error: 'limit must be between 1 and 10000' }, 400, cors);
        }
        opts.limit = lim;
      }
      return handleAirdropClaimList(mac[1], env, network, cors, opts);
    }
    const mac2 = url.pathname.match(/^\/airdrops\/([0-9a-f]{64})\/claims\/(\d+)$/);
    if (mac2 && req.method === 'DELETE')                       return handleAirdropClaimDelete(mac2[1], mac2[2], req, env, network, cors);

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

    return jsonResponse({ error: 'not found' }, 404, cors);
  },

  async scheduled(_event, env, ctx) {
    // Scan both networks each cron tick. Failures in one don't affect the other.
    ctx.waitUntil((async () => {
      await Promise.allSettled(
        NETWORKS.map(net => scanForEtches(env, net).catch(() => {})),
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
      // Pre-warm /petch-assets. Each MISS fans out to loadCanonicalPmints
      // per asset (the costliest /petch-assets payload on the system), so
      // keeping cache fresh keeps Discover's public-mint section snappy
      // even after long quiet periods.
      await Promise.allSettled(
        NETWORKS.map(net => petchAssetsComputeAndCache(env, net).catch(() => {})),
      );
    })());
  },
};
