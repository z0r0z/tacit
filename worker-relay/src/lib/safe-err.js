// Error text that is safe to publish.
//
// Two of the worker's endpoints republish these strings to anyone who asks: `/prover-health` returns a
// service's last heartbeat `note` verbatim, and `/confidential/status?id=` returns the relay's ack `error`
// verbatim. Both are public and unauthenticated. So every string handed to `heartbeat()` or to
// `confidentialAck({error})` is, in effect, a public response body.
//
// A raw viem exception is not safe there. `BaseError` composes its `message` from the short message plus
// metaMessages, and `HttpRequestError` puts `URL: <endpoint>` in that list — and viem's own `getUrl`
// redacts only `user:pass@` basic-auth, never a path-embedded key. Since the universal provider form is
// `https://host/v2/<API-KEY>`, an RPC timeout or 429 during a settle would otherwise publish RELAY_KEY's
// provider credential on demand. `URL:` lands early enough in the message to survive any later truncation,
// so truncating is not a mitigation.
//
// Strip every URL, keep the part of the message that is actually diagnostic, and bound the length.
const URLS = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

// Nor is an address. A revert or a gas estimate quotes the accounts and calldata it was given, and for a relayed exit
// those name the holder's destination. The relay has no business republishing who a job paid, so a 20-byte address
// becomes <addr> and a blob longer than a hash (calldata, a proof, a witness) becomes <hex>. A 32-byte transaction hash
// stays, because the pending-landing hashes are published on purpose, and so does a 4-byte selector.
const ADDRS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const BLOBS = /0x[0-9a-fA-F]{65,}/g;

export function scrubPublic(s) {
  return String(s ?? '').replace(URLS, '<url>').replace(BLOBS, '<hex>').replace(ADDRS, '<addr>');
}

export function safeErr(e, max = 200) {
  const raw = e && (e.shortMessage || e.message) ? String(e.shortMessage || e.message) : String(e ?? 'unknown error');
  return scrubPublic(raw).replace(/\s+/g, ' ').trim().slice(0, max);
}
