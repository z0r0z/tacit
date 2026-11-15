// The Bitcoin step of a bridge to Bitcoin, sent by Tacit's relay so the holder needs no sats of their own.
//
// A bridge burns a note on Ethereum (crossOut) and names where its note lands on Bitcoin: the commitment (cx, cy) and the Taproot key
// (destXonly) that owns it, hashed into the claim's leaf, which the pool keeps (crossOutCommitment, slot 77). The Bitcoin step is a
// commit/reveal pair whose reveal pays P2TR(destXonly) at vout 0; the reflection reads the owner from that output and nothing else, so
// whoever funds the pair cannot take the note, and any coin may pay for it. The page asks (POST /crossout/relay, worker/src/index.js),
// the relay (fulfiller/crossout-relay.mjs, in the hosted watchtower) checks the ask against the claim on chain, waits for the proof to
// cover the burn, then funds, signs and sends the pair from its own key. If it cannot (its budget, its coins, a fee too high), it says
// so and the page sends the step from the holder's own sats, as it always could.
//
// Shared by the worker (which takes the asks) and the relay (which sends them), so both check a claim the same way.

export const CLAIM_SLOT = 77n;                                     // ConfidentialPool.crossOutCommitment
export const CROSSOUT_RECORDED_SIG = 'CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)';
const BTC_NOTE_DOM = new TextEncoder().encode('tacit-btc-note-v1');
const HEX64 = /^[0-9a-f]{64}$/;

// Where an ask lives, and what the relay keeps of itself: its address, budget and last look (for GET /crossout/relay/info), what it
// spent in a day, and how many steps it sent for one key in a day.
export const relayKey = (network, claimId) => `crossout-relay:${network}:${claimId}`;
export const relayPrefix = (network) => `crossout-relay:${network}:`;
export const relayInfoKey = (network) => `crossout-relay-info:${network}`;
export const relaySpentKey = (network, day) => `crossout-relay-spent:${network}:${day}`;
export const relayDestKey = (network, day, destXonly) => `crossout-relay-dest:${network}:${day}:${destXonly}`;
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// An ask's states. `queued`: asked, not yet checked; `waiting`: a real claim, the proof not yet past its burn (or fees high);
// `signing`: the pair is built and kept, being sent; `sent`: Bitcoin has it; `minted`: the reflection credited it; `elsewhere`: the
// claim was minted by another pair (the holder's own); `declined`: the relay will not send it (budget, coins, a limit): the page sends
// it; `rejected`: the ask does not match the claim; `expired`: never became sendable.
export const OPEN_STATES = new Set(['queued', 'waiting', 'signing', 'sent']);
export const PAGE_SENDS = new Set(['declined', 'rejected', 'expired', 'failed']);

const strip = (h) => String(h ?? '').replace(/^0x/i, '').toLowerCase();
const hexBytes = (h) => { const s = strip(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const cat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

// The ask, read strictly: 32-byte hex fields and the Ethereum block of the burn.
export function parseRelayRequest(body) {
  const b = body || {};
  const out = { claimId: strip(b.claimId), assetId: strip(b.assetId), cx: strip(b.cx), cy: strip(b.cy), destXonly: strip(b.destXonly), ethBlock: Number(b.ethBlock) };
  for (const k of ['claimId', 'assetId', 'cx', 'cy', 'destXonly']) if (!HEX64.test(out[k])) throw new Error(`${k} must be 32-byte hex`);
  if (/^0{64}$/.test(out.destXonly)) throw new Error('destXonly must not be zero');
  if (!Number.isSafeInteger(out.ethBlock) || out.ethBlock <= 0) throw new Error('ethBlock must be a positive integer');
  return out;
}

// The claim's leaf (confidential-pool.js btcNoteLeaf): what crossOutCommitment holds for a burn that lands at (cx, cy) owned by destXonly.
export const claimLeaf = (keccak256, { assetId, cx, cy, destXonly }) => toHex(keccak256(cat(hexBytes(assetId), hexBytes(cx), hexBytes(cy), hexBytes(destXonly), BTC_NOTE_DOM)));
// Its storage slot: keccak256(claimId ‖ uint256(77)).
export function claimSlot(keccak256, claimId) {
  const slot = new Uint8Array(32); let v = CLAIM_SLOT;
  for (let i = 31; i >= 0 && v > 0n; i--) { slot[i] = Number(v & 0xffn); v >>= 8n; }
  return '0x' + toHex(keccak256(cat(hexBytes(claimId), slot)));
}
export const recordedTopic = (keccak256) => '0x' + toHex(keccak256(new TextEncoder().encode(CROSSOUT_RECORDED_SIG)));

// Whether the ask is a burn the pool recorded, landing exactly where it says, in the block it says (the block the proof must cover
// before a mint can count, so it is read from the chain and not taken on trust). { ok } or { ok: false, reason, retry }: retry when
// the chain could not be read, or the claim is not there yet (an RPC behind the burn); not when it is there and says otherwise.
export async function verifyClaim({ keccak256, ethRpc, pool, req }) {
  let stored;
  try { stored = await ethRpc('eth_getStorageAt', [pool, claimSlot(keccak256, req.claimId), 'latest']); } catch { stored = null; }
  if (typeof stored !== 'string') return { ok: false, reason: 'chain-unreadable', retry: true };
  if (/^(0x)?0*$/.test(stored)) return { ok: false, reason: 'no-claim', retry: true };
  if (strip(stored).padStart(64, '0') !== claimLeaf(keccak256, req)) return { ok: false, reason: 'not-this-claim', retry: false };
  let logs;
  const block = '0x' + req.ethBlock.toString(16);
  try { logs = await ethRpc('eth_getLogs', [{ address: pool, fromBlock: block, toBlock: block, topics: [recordedTopic(keccak256), '0x' + req.claimId] }]); } catch { logs = null; }
  if (!Array.isArray(logs)) return { ok: false, reason: 'chain-unreadable', retry: true };
  const ev = logs.find((l) => strip(l.data).length >= 64 * 4);
  if (!ev) return { ok: false, reason: 'wrong-block', retry: false };
  // data: destChain (uint16), destCommitment, nullifier, assetId (claimId is the indexed topic)
  const d = strip(ev.data), destChain = parseInt(d.slice(0, 64), 16), destCommitment = d.slice(64, 128), assetId = d.slice(192, 256);
  if (destChain !== 1 || destCommitment !== claimLeaf(keccak256, req) || assetId !== req.assetId) return { ok: false, reason: 'not-this-claim', retry: false };
  return { ok: true };
}

// What the page is told of an ask: no hexes it already has, nothing of the relay's coins.
export const publicStatus = (rec) => rec && ({
  status: rec.status, reason: rec.reason || null, askedAt: rec.askedAt || null, sentAt: rec.sentAt || null,
  commitTxid: rec.commitTxid || null, revealTxid: rec.revealTxid || null, mintedTxid: rec.mintedTxid || null,
});
