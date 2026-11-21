// What a claim for a reviewed step names, as the 32 bytes of the transaction the claimant sends to themselves (the service reads them:
// worker-relay/src/lib/points-tasks.js). A step's `input` says what is asked for. With none it is a Bitcoin transaction id, 64 hex digits.
// With `{ pattern, text: true }` it is a short id from another site (CoinGecko's request id), written as its ASCII bytes and padded with
// zeros to 32. → the data to send, or null when it is not what was asked.
export function reviewData(step, raw) {
  const text = String(raw ?? '').trim(), spec = step?.input;
  if (!spec) { const id = text.toLowerCase(); return /^[0-9a-f]{64}$/.test(id) ? `0x${id}` : null; }
  if (!new RegExp(spec.pattern).test(text)) return null;
  const hex = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.length <= 64 ? `0x${hex.padEnd(64, '0')}` : null;
}

// The text a claim named, read back from its data: what a reviewer checks against the site it came from.
export const reviewText = (data) => new TextDecoder().decode(Uint8Array.from(String(data).replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16))).replace(/\0+$/, '');
