// Finds the transaction that already did a job's work on chain.
//
// A settle pays its bound fee to whoever sends it, and the proof alone decides what the settle does, so a copy of
// our settle landed by another sender did exactly what ours would have: the user's op is done, only the fee went
// elsewhere. The same holds for a job served again after its first settle landed. In both cases the job should be
// reported settled with that transaction, not failed because our own transaction had nothing left to do.
//
// findCarrier looks through the pool's logs from `fromBlock` to the head, newest first, for a successful
// transaction whose calldata carries every needle (hex: a proof's public values, or a job's sealed memos). The
// calldata is what the pool executed, whether the pool was called directly or through a contract, so a match on
// the public values is a match on the whole op. Bounded by `maxTxs` distinct transactions read.
export async function findCarrier({ client, pool, needles, fromBlock, maxTxs = 60, chunk = 5000n }) {
  const want = (needles || []).map((n) => String(n || '').replace(/^0x/i, '').toLowerCase()).filter((n) => n.length >= 64);
  if (!want.length) return null;
  const head = await client.getBlockNumber();
  const floor = BigInt(fromBlock) < 0n ? 0n : BigInt(fromBlock);
  const seen = new Set();
  for (let hi = head; hi >= floor; hi -= chunk) {
    const lo = hi - chunk + 1n > floor ? hi - chunk + 1n : floor;
    const logs = await client.getLogs({ address: pool, fromBlock: lo, toBlock: hi });
    for (const l of [...logs].reverse()) {
      const h = l.transactionHash;
      if (!h || seen.has(h)) continue;
      if (seen.size >= maxTxs) return null;
      seen.add(h);
      const tx = await client.getTransaction({ hash: h });
      const input = String(tx.input || '').toLowerCase();
      if (!want.every((n) => carries(input, n))) continue;
      const r = await client.getTransactionReceipt({ hash: h });
      if (r.status === 'success') return h;
    }
    if (lo === floor) break;
  }
  return null;
}

// Byte-aligned containment: a needle found at an odd hex offset is not the same bytes.
function carries(input, needle) {
  for (let i = input.indexOf(needle); i !== -1; i = input.indexOf(needle, i + 1)) if (i % 2 === 0) return true;
  return false;
}

// Viem wraps a node's revert several layers deep; a settle that reverts in simulation is the chain's answer, not
// an endpoint problem, and trying the other endpoints or a higher tip cannot change it.
export function isRevert(e) {
  for (let x = e, d = 0; x && d < 8; x = x.cause, d++) {
    if (x.name === 'ContractFunctionRevertedError' || (x.name === 'CallExecutionError' && /revert/i.test(String(x.message)))) return true;
    if (/execution reverted|reverted with the following|reverted with reason/i.test(String(x.shortMessage || x.details || ''))) return true;
  }
  return false;
}

// A private endpoint that simulates a transaction against the PENDING block and refuses one that would revert there (MEV Blocker:
// "Missing or invalid parameters", its detail "Failed in pending block with: Reverted"). It is a verdict on the transaction as it
// stands against the pending block, not a fault of the endpoint, and the other endpoint's acceptance means nothing: Flashbots Protect
// takes the same transaction and never includes it while it would revert. The settle's own simulation runs against the latest block,
// which can pass while the pending block does not, so this is told apart from a refusal (and from isRevert, a latest-block revert).
export const PENDING_REVERT = /failed in pending block with:?\s*reverted/i;
export function isPendingRevert(e) {
  for (let x = e, d = 0; x && d < 8; x = x.cause, d++) {
    if (PENDING_REVERT.test(String(x.details || '')) || PENDING_REVERT.test(String(x.shortMessage || '')) || PENDING_REVERT.test(String(x.message || ''))) return true;
  }
  return false;
}

// An endpoint turning the relay away for asking too often (MEV Blocker answers "Missing or invalid parameters." with the detail "Request rate limited" for the egress address
// every Render service shares). Nothing is wrong with the transaction; asking again at once only makes it worse, and the other endpoints carry it meanwhile.
export const RATE_LIMITED = /rate.?limit|too many requests|\b429\b/i;
export function isRateLimited(e) {
  for (let x = e, d = 0; x && d < 8; x = x.cause, d++) {
    if (x.status === 429 || RATE_LIMITED.test(String(x.details || '')) || RATE_LIMITED.test(String(x.shortMessage || '')) || RATE_LIMITED.test(String(x.message || ''))) return true;
  }
  return false;
}

// What an endpoint's refusal says, for the log: viem's one-line message and the node's own detail (the part the one-line message leaves
// out), with the signed transaction and any other long hex cut short.
export function errDetail(e, max = 300) {
  const parts = [];
  for (let x = e, d = 0; x && d < 4; x = x.cause, d++) for (const t of [x.shortMessage, x.details]) if (t && !parts.includes(String(t))) parts.push(String(t));
  if (!parts.length) parts.push(String(e && e.message));
  return parts.join(' | ').replace(/0x[0-9a-fA-F]{80,}/g, (m) => `${m.slice(0, 12)}…(${(m.length - 2) / 2} bytes)`).replace(/\s+/g, ' ').slice(0, max);
}

// A transaction an endpoint refused because it reverts in the pending block is asked again soon, not a whole receipt wait later: the
// pending block moves every few seconds (a transaction ahead of ours lands, or leaves), and the refusal clears with it. Every `pollMs`:
// `dead()` is asked first (the settle now reverts against the latest block too: nothing sent could succeed, and the caller's answer is
// returned), then `resend(endpoints)` offers the same transaction again to the endpoints still refusing and says which still do.
//   -> { state: 'accepted' } | { state: 'dead', value } | { state: 'timeout', left }
export async function holdPendingRevert({ stuck, resend, dead, holdMs, pollMs = 4_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const until = now() + holdMs;
  let left = stuck;
  while (left.length && now() < until) {
    await sleep(pollMs);
    const v = await dead();
    if (v) return { state: 'dead', value: v };
    left = await resend(left);
  }
  return left.length ? { state: 'timeout', left } : { state: 'accepted' };
}

