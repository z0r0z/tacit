// Claim links for pool notes — handing shielded TAC to someone who has no wallet at all.
//
// dapp/claim-link.js already does this for transparent assets: the sender CXFERs to a throwaway key and
// puts the secret in a URL fragment. A pool note cannot work that way, because a pool recipient is a
// bp1… address derived from a pool wallet, not a single secp key. So the same trick is applied one level
// up: the secret derives a whole throwaway *pool wallet*, the sender pays that wallet privately, and the
// link carries the secret. The recipient derives the same wallet, finds the note by scanning with its
// viewing key, and moves it to a wallet of their own.
//
// It reuses claim-link.js's secret and PIN derivation rather than inventing a second scheme, so a PIN
// behaves identically here: without one the secret is the seed, with one the seed is sha256 over both and
// a leaked URL alone claims nothing.
//
// Bearer, and deliberately so: whoever holds the secret can spend the note, the sender included. That is
// what makes it work for a recipient with nothing, and it is why the claim side sweeps immediately
// instead of leaving the money sitting under a key two people know.

import { claimKeyFromSecret, genClaimSecret } from '/claim-link.js';

const LINK_VERSION = 'p1';
const FRAGMENT = 'tacclaim';
const NETS = new Set(['mainnet', 'signet']);
const TXID_RE = /^[0-9a-f]{64}$/;

const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

// The throwaway pool wallet a link addresses. Same (secret, pin) on both sides derives the same wallet.
export function claimPoolWallet(pool, secret32, { pin = '', network = 'mainnet' } = {}) {
  const { priv } = claimKeyFromSecret(secret32, pin);   // 32 bytes, PIN-bound exactly as transparent claims are
  return pool.walletFromSeed(priv, network);
}

export { genClaimSecret };

// Wire format, mirroring claim-link.js so the two stay legible side by side:
//   p1.<network>.<base64url(secret)>.<txid>.<pinFlag>
export function encodeClaim({ secret32, txid, network, pinned = false }) {
  if (!(secret32 instanceof Uint8Array) || secret32.length !== 32) throw new Error('claim secret must be 32 bytes');
  if (!NETS.has(network)) throw new Error(`unsupported network: ${network}`);
  const tx = String(txid || '').toLowerCase();
  if (!TXID_RE.test(tx)) throw new Error('txid must be 64 hex chars');
  return [LINK_VERSION, network, b64url(secret32), tx, pinned ? '1' : '0'].join('.');
}

export const claimUrl = (origin, payload) => `${String(origin).replace(/\/+$/, '')}/tac/#${FRAGMENT}=${payload}`;

export function decodeClaim(input) {
  if (!input || typeof input !== 'string') throw new Error('empty claim link');
  let p = input.trim();
  const at = p.lastIndexOf(`${FRAGMENT}=`);
  if (at !== -1) p = p.slice(at + FRAGMENT.length + 1);
  p = p.split(/[&#\s]/)[0];
  const parts = p.split('.');
  if (parts.length !== 5) throw new Error('that does not look like a claim link');
  const [v, network, secretB64, txid, pinFlag] = parts;
  if (v !== LINK_VERSION) throw new Error(`unsupported claim link version ${v}`);
  if (!NETS.has(network)) throw new Error(`unsupported network ${network}`);
  if (!TXID_RE.test(txid)) throw new Error('claim link carries a malformed txid');
  let secret32;
  try { secret32 = unb64url(secretB64); } catch { throw new Error('claim link secret is not valid base64url'); }
  if (secret32.length !== 32) throw new Error('claim link secret is the wrong length');
  return { secret32, txid, network, pinned: pinFlag === '1' };
}

// Sender: pay a fresh throwaway pool wallet, and hand back the link that opens it.
// `keep` is handed the secret before anything is paid, so the caller can store it first.
export async function createClaim(tacit, { S, pool, poolWallet, amount, asset, pin = '', network = 'mainnet', say = () => {}, keep = () => {} }) {
  const secret32 = genClaimSecret();
  const to = claimPoolWallet(pool, secret32, { pin, network });
  keep({ secret32, pinned: !!pin, network });
  const r = await S.payPrivately(tacit, { poolWallet, to: to.addressString, amount, asset, say });
  if (r.wait) return { wait: r.wait, tip: r.tip };
  return {
    ...r,
    secret32,
    link: claimUrl(location.origin, encodeClaim({ secret32, txid: r.revealTxid, network, pinned: !!pin })),
  };
}

// Recipient: what is actually sitting under this link right now.
export async function readClaim(S, pool, { secret32, pin = '', network = 'mainnet', asset }) {
  const w = claimPoolWallet(pool, secret32, { pin, network });
  const notes = await S.poolNotes(w, asset);
  const live = notes.filter((n) => !n.spent && BigInt(n.value) > 0n);
  return { wallet: w, notes: live, total: live.reduce((t, n) => t + BigInt(n.value), 0n), seen: notes.length };
}

// Recipient: move it into a wallet of their own. Relayed when a relayer quotes, so somebody who has never
// held bitcoin can take delivery — the carrier is paid for out of the note itself, in TAC.
export async function sweepClaim(tacit, { S, pool, secret32, pin = '', network = 'mainnet', asset, toAddress, fmt = String, say = () => {} }) {
  const from = claimPoolWallet(pool, secret32, { pin, network });
  const { total } = await readClaim(S, pool, { secret32, pin, network, asset });
  if (total <= 0n) throw new Error('there is nothing left under this link — it may already have been claimed.');
  // The relayer's fee comes out of the same notes, so sweep the balance minus whatever it quotes.
  let fee = 0n;
  try {
    const info = await S.poolClientFor(network).relayInfo();
    const f = info?.fees?.['0x' + String(asset).replace(/^0x/, '').toLowerCase()];
    if (f != null) fee = BigInt(f);
  } catch { fee = 0n; }
  const amount = total - fee;
  if (amount <= 0n) throw new Error(`The relay's fee (${fmt(fee)} TAC) is more than this link holds (${fmt(total)} TAC).`);
  return S.payPrivately(tacit, { poolWallet: from, to: toAddress, amount, asset, say });
}
