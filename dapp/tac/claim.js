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

// The throwaway pool wallet a link addresses. Same (secret, pin) on both sides derives the same wallet, and the same object each time it is
// asked for here: the pool client remembers per wallet object which leaves it has tried, so a panel's re-reads try only the leaves that are new.
const wallets = new WeakMap();
export function claimPoolWallet(pool, secret32, { pin = '', network = 'mainnet' } = {}) {
  let mine = wallets.get(pool);
  if (!mine) wallets.set(pool, (mine = new Map()));
  const k = `${network}/${Array.from(secret32, (b) => b.toString(16).padStart(2, '0')).join('')}/${pin}`;
  let w = mine.get(k);
  if (!w) {
    const { priv } = claimKeyFromSecret(secret32, pin);   // 32 bytes, PIN-bound exactly as transparent claims are
    w = pool.walletFromSeed(priv, network);
    mine.set(k, w);
    if (mine.size > 8) mine.delete(mine.keys().next().value);   // a PIN typed in steps leaves the wallets of its first digits behind
  }
  return w;
}
const sameAsset = (a, b) => String(a).replace(/^0x/, '').toLowerCase() === String(b).replace(/^0x/, '').toLowerCase();

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
  if (!input || typeof input !== 'string') throw new Error('That claim link is empty.');
  let p = input.trim();
  const at = p.lastIndexOf(`${FRAGMENT}=`);
  if (at !== -1) p = p.slice(at + FRAGMENT.length + 1);
  p = p.split(/[&#\s]/)[0];
  const parts = p.split('.');
  if (parts.length !== 5) throw new Error('That does not look like a claim link.');
  const [v, network, secretB64, txid, pinFlag] = parts;
  if (v !== LINK_VERSION) throw new Error('This claim link is in a format this page does not read.');
  if (!NETS.has(network)) throw new Error('That link is for another network.');
  // A link cut short or changed on the way: its transaction id or its secret does not read.
  const partial = 'Part of this claim link is missing or changed. Copy the whole link again.';
  if (!TXID_RE.test(txid)) throw new Error(partial);
  let secret32;
  try { secret32 = unb64url(secretB64); } catch { throw new Error(partial); }
  if (secret32.length !== 32) throw new Error(partial);
  return { secret32, txid, network, pinned: pinFlag === '1' };
}

// Sender: pay a fresh throwaway pool wallet, and hand back the link that opens it.
// `keep` is handed the secret before anything is paid, so the caller can store it first.
// `askSelf` is payPrivately's: asked before the payment is posted from the sender's own Bitcoin address. `maxFee` is payPrivately's too.
export async function createClaim(tacit, { S, pool, poolWallet, amount, asset, pin = '', network = 'mainnet', maxFee = null, say = () => {}, keep = () => {}, askSelf = null }) {
  const secret32 = genClaimSecret();
  const to = claimPoolWallet(pool, secret32, { pin, network });
  keep({ secret32, pinned: !!pin, network });
  const r = await S.payPrivately(tacit, { poolWallet, to: to.addressString, amount, asset, maxFee, say, askSelf });
  if (r.wait) return { wait: r.wait, tip: r.tip };
  return {
    ...r,
    secret32,
    // a relayed payment that came back without its id has no link yet: the sender finds it once the pool counts the note
    link: r.revealTxid ? claimUrl(location.origin, encodeClaim({ secret32, txid: r.revealTxid, network, pinned: !!pin })) : null,
  };
}

// Recipient: what is actually sitting under this link right now. With the pool's note feed in hand (`feed`) the wallet's notes are opened
// from it, and `indexed` says whether the link's payment (`txid`) is in the pool at all: nothing under the link is then the wrong PIN, or a link
// changed on the way, and not a payment still on its way.
export async function readClaim(S, pool, { secret32, pin = '', network = 'mainnet', asset, feed = null, txid = null }) {
  const w = claimPoolWallet(pool, secret32, { pin, network });
  const notes = feed
    ? (await S.poolClientFor(network).walletNotes(pool, w, { notes: feed })).filter((n) => !asset || sameAsset(n.asset, asset))
    : await S.poolNotes(w, asset);
  // a claim this device just made is spent here before the pool's feed says so
  const live = (S.pendingView ? S.pendingView(notes, asset, w).live : notes.filter((n) => !n.spent)).filter((n) => BigInt(n.value) > 0n);
  return { wallet: w, notes: live, total: live.reduce((t, n) => t + BigInt(n.value), 0n), seen: notes.length, indexed: feed && txid ? feed.some((n) => n.txid === txid) : null };
}

// Recipient: move it into a wallet of their own. Relayed when the relay quotes, so somebody who has never
// held bitcoin can take delivery — the carrier is paid for out of the note itself, in TAC. The whole link is given up
// (`deductFee`): the relay's quoted fee comes out of it and nothing is left behind under a key two people know.
// `askSelf` is payPrivately's: asked before the sweep is posted from the claimer's own Bitcoin address.
export async function sweepClaim(tacit, { S, pool, secret32, pin = '', network = 'mainnet', asset, toAddress, fmt = String, say = () => {}, askSelf = null }) {
  const from = claimPoolWallet(pool, secret32, { pin, network });
  const { total } = await readClaim(S, pool, { secret32, pin, network, asset });
  if (total <= 0n) throw new Error(`Nothing is left under this link: it was already claimed${pin ? ', or the PIN is not the one it was made with' : ''}.`);
  try { return await S.payPrivately(tacit, { poolWallet: from, to: toAddress, amount: total, deductFee: true, asset, say, askSelf }); }
  catch (e) {
    if (e?.feeOver != null) throw new Error(`The relay’s fee (${fmt(e.feeOver)} TAC) is more than this link holds (${fmt(total)} TAC). Nothing was sent.`);
    throw e;
  }
}
