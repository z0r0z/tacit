// Claimable-link primitives. A claimable link lets a sender hand a tacit asset
// to someone who has no tacit identity yet: the asset is CXFER'd to a throwaway
// key `s` (claimPub = s·G), and `s` rides in the link's URL fragment. The
// recipient opens the link, the dapp loads `s` transiently, locates the asset,
// and sweeps it into a real identity they create on the spot (btc-identity /
// passkey / burner). An optional PIN binds the spend key to a secret the
// recipient must also know, so a leaked URL alone can't claim.
//
// Pure + dependency-light (mirrors prf-wallet.js): no DOM, no localStorage, no
// network. The send/claim orchestration in tacit.js consumes these. Keeping the
// crypto + wire format here makes it unit-testable in isolation and means the
// (riskier) UI wiring can't regress the format.

import { secp, sha256, bytesToHex } from './vendor/tacit-deps.min.js';
// Reuse the tested [1, N-1] scalar mapper so a (vanishingly rare) raw secret or
// PIN-hash of 0 / ≥ N can't wedge a claim with an unspendable key.
import { prfBytesToScalar as toValidScalar } from './prf-wallet.js';

const LINK_VERSION = 'v1';
// Domain-separates the PIN-bound key derivation from any other sha256 use, so a
// signature/commitment elsewhere can never coincide with a claim key.
const PIN_DOMAIN = 'tacit-claim-pin-v1';
const SUPPORTED_NETS = new Set(['mainnet', 'signet', 'regtest']);
const TXID_RE = /^[0-9a-f]{64}$/;

const enc = new TextEncoder();

function toB64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function fromB64url(s) {
  s = String(s).replaceAll('-', '+').replaceAll('_', '/');
  if (s.length % 4) s += '='.repeat(4 - (s.length % 4));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatU8(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// Fresh 32-byte claim secret. The bearer of this value (plus the PIN, if set)
// can claim the asset, so it must come from a CSPRNG and never be reused.
export function genClaimSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

// Deterministically map (secret[, pin]) → secp256k1 keypair. The sender computes
// `.pub` to address the CXFER; the recipient computes `.priv` to sweep. Both
// sides MUST pass the same pin (or both omit it) or they derive different keys.
// Without a pin the secret IS the key (mapped into range); with a pin the key is
// sha256(domain || secret || pin), so a leaked link alone can't reconstruct it.
export function claimKeyFromSecret(secret32, pin = '') {
  const s = secret32 instanceof Uint8Array ? secret32 : new Uint8Array(secret32);
  if (s.length !== 32) throw new Error('claim secret must be 32 bytes');
  const raw = pin
    ? sha256(concatU8(enc.encode(PIN_DOMAIN), s, enc.encode(String(pin))))
    : s;
  const priv = toValidScalar(raw);
  const pub = secp.getPublicKey(priv, true);
  return { priv, pub, pubHex: bytesToHex(pub) };
}

// Wire format (URL-fragment safe — base64url has no '.'):
//   v1.<network>.<base64url(secret)>.<txid>.<pinFlag>
// `pinFlag` is 1 when a PIN is required (the PIN itself is shared out-of-band,
// never in the link). `txid` is where the asset UTXO landed so the claim side
// can decode it without a full chain scan.
export function encodeClaimLink({ secret32, txid, network, pinned = false }) {
  const s = secret32 instanceof Uint8Array ? secret32 : new Uint8Array(secret32);
  if (s.length !== 32) throw new Error('claim secret must be 32 bytes');
  if (!SUPPORTED_NETS.has(network)) throw new Error(`unsupported network: ${network}`);
  const tx = String(txid || '').toLowerCase();
  if (!TXID_RE.test(tx)) throw new Error('txid must be 64 hex chars');
  return [LINK_VERSION, network, toB64url(s), tx, pinned ? '1' : '0'].join('.');
}

// Build a full claim URL from an origin (e.g. "https://tacit.finance") and a
// payload from encodeClaimLink. The payload lives in the fragment so it never
// reaches a server.
export function buildClaimUrl(origin, payload) {
  return `${String(origin).replace(/\/+$/, '')}/#claim=${payload}`;
}

// Parse a claim link. Accepts a full URL, a "#claim=…" fragment, or the bare
// payload. Returns { secret32, txid, network, pinned }. Throws on any malformed
// / unsupported input so callers fail closed rather than acting on junk.
export function decodeClaimLink(input) {
  if (!input || typeof input !== 'string') throw new Error('empty claim link');
  let payload = input.trim();
  const at = payload.lastIndexOf('claim=');
  if (at !== -1) payload = payload.slice(at + 'claim='.length);
  // Cut at the first separator that can't appear inside our payload.
  payload = payload.split(/[&#\s]/)[0];
  const parts = payload.split('.');
  if (parts.length !== 5) throw new Error('malformed claim link');
  const [ver, network, secretB64, txid, pinFlag] = parts;
  if (ver !== LINK_VERSION) throw new Error(`unsupported claim link version: ${ver}`);
  if (!SUPPORTED_NETS.has(network)) throw new Error(`unsupported network: ${network}`);
  if (!TXID_RE.test(txid)) throw new Error('claim link txid malformed');
  if (pinFlag !== '0' && pinFlag !== '1') throw new Error('claim link pin flag malformed');
  let secret32;
  try { secret32 = fromB64url(secretB64); } catch { throw new Error('claim link secret malformed'); }
  if (secret32.length !== 32) throw new Error('claim link secret must decode to 32 bytes');
  return { secret32, txid, network, pinned: pinFlag === '1' };
}
