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

export function safeErr(e, max = 200) {
  const raw = e && (e.shortMessage || e.message) ? String(e.shortMessage || e.message) : String(e ?? 'unknown error');
  return raw.replace(URLS, '<url>').replace(/\s+/g, ' ').trim().slice(0, max);
}
