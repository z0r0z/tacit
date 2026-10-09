// Silent-payment hints (worker-relay/src/lib/sp-hints.js). After a silent payment the sender's app posts the
// transaction id sealed to the recipient's scan key; the recipient's app reads every hint, opens only its own, and finds
// the payment in that transaction as it would from a shared link. The service cannot tell who a hint is for.
//
// A hint: e = an ephemeral public key E (33 bytes), c = txid ⊕ pad (32 bytes) ‖ tag (16 bytes), with
// k = HMAC-SHA256(x(ECDH), "tacit-sp-hint-v1" ‖ E), pad = SHA256(k ‖ 0x01), tag = HMAC-SHA256(k, E ‖ body)[0..16].

import { secp, sha256, hmac, bytesToHex, hexToBytes, concatBytes } from './vendor/tacit-deps.min.js';

const TAG = new TextEncoder().encode('tacit-sp-hint-v1');
const keys = (x, E) => { const k = hmac(sha256, x, concatBytes(TAG, E)); return { pad: sha256(concatBytes(k, Uint8Array.of(1))), k }; };
const xor = (a, b) => a.map((v, i) => v ^ b[i]);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The hint for a payment in `txidHex` to the holder of `scanPub` (33-byte compressed).
export function sealHint(scanPub, txidHex) {
  const e = secp.utils.randomPrivateKey(), E = secp.getPublicKey(e, true);
  const { pad, k } = keys(secp.getSharedSecret(e, scanPub, true).slice(1), E);
  const body = xor(hexToBytes(txidHex), pad);
  return { e: bytesToHex(E), c: bytesToHex(concatBytes(body, hmac(sha256, k, concatBytes(E, body)).slice(0, 16))) };
}

// The txid a hint carries when it was sealed to one of `scanPrivs`, else null.
export function openHint(scanPrivs, e, c) {
  let E, all;
  try { E = hexToBytes(e); all = hexToBytes(c); } catch { return null; }
  if (E.length !== 33 || all.length !== 48) return null;
  const body = all.slice(0, 32), tag = all.slice(32);
  for (const priv of scanPrivs) {
    let x;
    try { x = secp.getSharedSecret(priv, E, true).slice(1); } catch { return null; }
    const { pad, k } = keys(x, E);
    if (same(hmac(sha256, k, concatBytes(E, body)).slice(0, 16), tag)) return bytesToHex(xor(body, pad));
  }
  return null;
}

export async function postHint(base, scanPub, txidHex, fetchImpl = fetch) {
  const r = await fetchImpl(`${base}/sp/hints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sealHint(scanPub, txidHex)), signal: AbortSignal.timeout?.(20_000) });
  if (!r.ok) throw new Error(`hint: HTTP ${r.status}`);
  return (await r.json()).id;
}

// Every hint after `after`, in order, through onHint(id, e, c); returns the last id read. At most `maxPages` pages of
// 2,000 a call: anyone may post hints, so one read is bounded and the next carries on from the id this one returns.
export async function readHints(base, after, onHint, fetchImpl = fetch, { maxPages = 1000 } = {}) {
  let at = after;
  for (let guard = 0; guard < maxPages; guard++) {
    const r = await fetchImpl(`${base}/sp/hints?after=${at}&limit=2000`, { cache: 'no-store', signal: AbortSignal.timeout?.(20_000) });
    if (!r.ok) throw new Error(`hints: HTTP ${r.status}`);
    const j = await r.json();
    for (const [id, e, c] of j.hints) { await onHint(id, e, c); at = id; }
    if (j.next == null) break;
  }
  return at;
}
