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
// Scheduled (cron */5 * * * *): scans signet AND mainnet for CETCH, T_MINT, and T_BURN envelopes.
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
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
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

// T_BURN structural decoder. Burns are simpler than mints because the burned
// amount is public — no Pedersen indirection. We only extract asset_id and
// burned_amount. The kernel sig + remaining outputs are validated client-side.
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
  const [att, mints, burns, op, dc, ls, lr, ai, xfer] = await Promise.all([
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
}

async function handleAssetsList(env, network, cors, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 1000) : null;
  const includeMints = opts.includeMints !== false;
  // Signet's legacy unprefixed `asset:*` would also catch `asset:mainnet:*`
  // entries; filter those out when listing signet so the namespaces don't bleed.
  const prefix = assetPrefix(network);
  const list = await env.REGISTRY_KV.list({ prefix, limit: 1000 });
  const wanted = list.keys.filter(k => !(network === 'signet' && k.name.startsWith('asset:mainnet:')));
  const fetched = await Promise.all(
    wanted.map(k => env.REGISTRY_KV.get(k.name, 'json')),
  );
  const assets = fetched.filter(v => v);
  assets.sort((a, b) => (b.etched_at || 0) - (a.etched_at || 0));
  const trimmed = limit ? assets.slice(0, limit) : assets;
  // Lightweight counts so Discover can show "N openings · M disclosures"
  // without doing per-asset round-trips client-side. KV list is paginated;
  // 1000 cap is way beyond any realistic per-asset count for v1.
  await Promise.all(trimmed.map(v => hydrateAssetSummary(env, network, v, includeMints)));
  const lastScanned = parseInt((await env.REGISTRY_KV.get(lastScannedKey(network))) || '0', 10);
  let tip = null;
  let tipUnavailable = false;
  try {
    const raw = (await apiText(env, '/blocks/tip/height', {}, network)).trim();
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) tip = parsed;
    else tipUnavailable = true;
  } catch { tipUnavailable = true; }
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
  return jsonResponse(v, 200, cors);
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
  throw new Error('unsupported envelope opcode');
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

async function handleAssetOpenings(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const list = await env.REGISTRY_KV.list({ prefix: openingPrefix(network, assetIdHex), limit: 1000 });
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const openings = fetched.filter(v => v);
  openings.sort((a, b) => (b.attested_at || 0) - (a.attested_at || 0));
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
      return { hrp: d.prefix, version, programLength: program.length };
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

async function handleListingList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
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

async function handleRangeListingList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
  const list = await env.REGISTRY_KV.list({ prefix: rangeListingPrefix(network, assetIdHex), limit: 1000 });
  const now = Math.floor(Date.now() / 1000);
  const fetched = await Promise.all(list.keys.map(k => env.REGISTRY_KV.get(k.name, 'json')));
  const listings = fetched.filter(v => v);
  for (const v of listings) {
    v.expired = (v.expiry || 0) <= now;
    if (v.claim && v.claim.expires_at <= now) v.claim = null;
  }
  listings.sort((a, b) => (b.listed_at || 0) - (a.listed_at || 0));
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

async function handleAtomicIntentList(assetIdHex, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return jsonResponse({ error: 'invalid asset_id' }, 400, cors);
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

// Per-IP daily rate limit for airdrop-claim POST and DELETE. Without this an
// attacker could fill KV with junk submissions for any root, or wipe a
// recipient's submission before the issuer pulls. The cap is generous so a
// legitimate recipient who needs to re-sign isn't blocked.
async function _airdropRateLimit(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const day = new Date().toISOString().slice(0, 10);
  const kvKey = `airdrop-rl:${day}:${ip}`;
  const limit = safeInt(env.AIRDROP_DAILY_LIMIT, 200, { min: 1 });
  const prior = safeInt(await env.REGISTRY_KV.get(kvKey), 0, { min: 0 });
  if (prior >= limit) return { ok: false, limit };
  await env.REGISTRY_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
  return { ok: true };
}

async function handleAirdropClaimPost(rootHex, req, env, network, cors) {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return jsonResponse({ error: 'invalid merkle root' }, 400, cors);
  const rl = await _airdropRateLimit(req, env);
  if (!rl.ok) return jsonResponse({ error: `airdrop daily limit reached (${rl.limit}/day)` }, 429, cors);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }

  const leafIndex = body.leaf_index;
  const tacitPubHex = String(body.tacit_pubkey ?? '').toLowerCase();
  let ethSigHex = String(body.eth_sig ?? '').toLowerCase();
  if (ethSigHex.startsWith('0x')) ethSigHex = ethSigHex.slice(2);

  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > AIRDROP_LEAF_INDEX_MAX) {
    return jsonResponse({ error: `leaf_index must be integer in [0, ${AIRDROP_LEAF_INDEX_MAX}]` }, 400, cors);
  }
  if (!/^0[23][0-9a-f]{64}$/.test(tacitPubHex)) {
    return jsonResponse({ error: 'tacit_pubkey must be 33-byte compressed hex (starts 02 or 03)' }, 400, cors);
  }
  if (!/^[0-9a-f]{130}$/.test(ethSigHex)) {
    return jsonResponse({ error: 'eth_sig must be 65 bytes (130 hex chars)' }, 400, cors);
  }

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
  const rl = await _airdropRateLimit(req, env);
  if (!rl.ok) return jsonResponse({ error: `airdrop daily limit reached (${rl.limit}/day)` }, 429, cors);
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
    for (const tx of txs) {
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
        // (T_AXFER). Both move asset value between holders; we bump a single
        // per-asset counter so /assets can surface a "movement" stat without
        // paying the cost of a full per-tx index. Counter design: read +
        // increment + put. Idempotency is approximate — the cron's normal
        // path advances `lastContiguous` only after the whole block scans,
        // so a mid-block crash can re-scan a block on the next tick and
        // double-count its transfers. The drift is bounded (≤ one block of
        // CXFERs) and acceptable for a coarse popularity signal.
        const decoder = decoded.opcode === T_AXFER ? decodeAxferPayload : decodeCXferPayload;
        const dx = decoder(decoded.payload);
        if (!dx) continue;
        const cntKey = transferCountKey(network, dx.asset_id);
        const cur = parseInt((await env.REGISTRY_KV.get(cntKey)) || '0', 10);
        await env.REGISTRY_KV.put(cntKey, String(cur + 1));
        // Don't increment `found` — that counter is for new etches/mints/
        // burns specifically (used in the cron's status return). Transfers
        // happen on every active asset; counting them as "found" would be
        // misleading.
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
  verifySchnorr, compressedPointFromHex,
  // Wire-format decoders + opcode constants exported so tests/worker-decoder
  // can pin down the exact return shape. The atomic-intent regression where
  // a handler read `ax.assetInputCount` (camelCase) against a snake_case
  // `asset_input_count` was silent in JS — this surface lets a test fail loudly
  // if any decoder's return-shape contract drifts.
  decodeEnvelopeScript,
  decodeCEtchPayload, decodeCMintPayload, decodeCXferPayload, decodeAxferPayload, decodeCBurnPayload,
  T_CETCH, T_CXFER, T_MINT, T_BURN, T_AXFER,
};

// ============== ROUTER ==============
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/pin' && req.method === 'POST')      return handlePin(req, env, cors);
    if (url.pathname === '/pin-json' && req.method === 'POST') return handlePinJson(req, env, cors);
    if (url.pathname === '/balance' && req.method === 'GET')   return handleBalance(env, cors);
    if (url.pathname === '/drip' && req.method === 'POST')     return handleDrip(req, env, cors);
    // Network is selected via ?network=signet|mainnet. Default is signet so a
    // no-network call (legacy clients) doesn't accidentally hit mainnet KV.
    // The current dapp explicitly passes ?network=mainnet for mainnet ops.
    const network = parseNetwork(url.searchParams.get('network'));

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
      // Cloudflare Cache API layer in front of the registry list. Each /assets
      // call would otherwise issue 1 + 5×N KV list operations (asset prefix +
      // openings/disclosures/listings/range-listings/atomic-intents per asset),
      // which on the free tier (1000 list ops/day) burns the quota in tens of
      // page loads. The Cache API has no quota and is per-colo, so a 30s TTL
      // collapses bursts of dapp polls into a single backend hit.
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const cached = await cache.match(cacheKey);
      if (cached) {
        // CORS headers must match the *current* request's origin, not the
        // cached one (otherwise origin A's response leaks to origin B's CORS
        // check). Rebuild the response with this request's CORS.
        const body = await cached.text();
        const headers = new Headers(cached.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        headers.set('X-Cache', 'HIT');
        return new Response(body, { status: cached.status, headers });
      }
      const fresh = await handleAssetsList(env, network, cors, { limit, includeMints });
      // Only cache successful responses; errors should retry.
      if (fresh.status === 200) {
        const body = await fresh.text();
        const cacheHeaders = new Headers(fresh.headers);
        cacheHeaders.set('Cache-Control', 'public, max-age=30');
        const toCache = new Response(body, { status: 200, headers: cacheHeaders });
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
        }
        const respHeaders = new Headers(cacheHeaders);
        respHeaders.set('X-Cache', 'MISS');
        return new Response(body, { status: 200, headers: respHeaders });
      }
      return fresh;
    }
    if (url.pathname === '/assets/hint' && req.method === 'POST') return handleAssetHint(req, env, network, cors);
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

    return jsonResponse({ error: 'not found' }, 404, cors);
  },

  async scheduled(_event, env, ctx) {
    // Scan both networks each cron tick. Failures in one don't affect the other.
    ctx.waitUntil(Promise.allSettled(
      NETWORKS.map(net => scanForEtches(env, net).catch(() => {}))
    ));
  },
};
