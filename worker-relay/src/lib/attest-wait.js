// Waiting for a submitted attest to land, without mistaking a slow receipt for a failure.
//
// A receipt wait that times out says nothing about the tx: it can confirm minutes later. Treating the timeout as a
// failure abandons the batch that just landed and re-proves the same job, whose attest then reverts stale — and the
// cursor, never acked, is left behind the pool for good. So the pool's own digest is the source of truth: it either
// reaches the batch's newDigest (landed), or the tx is shown to have reverted or vanished, or the window closes.
// A window that closes is not an error either — the tx is left alone and the next run picks it up.
//
//   -> { outcome: 'landed' | 'reverted' | 'dropped' | 'timeout' }
//
//   readDigest()  the pool's attested digest, or null when the endpoint could not answer
//   txStatus(h)   { state: 'mined' | 'reverted' | 'pending' | 'missing', confirmations? }
//   dropMisses    consecutive polls a tx may be missing (no receipt, unknown to the node) before it counts as dropped
//   deepEnough()  whether the digest still equals newDigest `confirmations` blocks back; it stands in for the receipt's
//                 depth when there is no receipt to count, so a digest seen only at the head is never enough
export async function awaitAttestLanding({
  newDigest, txHash, readDigest, txStatus, windowSecs, pollSecs, confirmations = 1, dropMisses = 20, deepEnough = async () => true,
  sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), now = () => Date.now(),
}) {
  const want = String(newDigest).toLowerCase();
  const deadline = now() + windowSecs * 1000;
  let misses = 0;
  for (;;) {
    let digest = null;
    try { digest = await readDigest(); } catch { /* endpoint hiccup — the next poll retries */ }
    let st = { state: 'unknown' };
    try { st = (await txStatus(txHash)) || st; } catch { /* likewise */ }

    if (digest && String(digest).toLowerCase() === want) {
      // A receipt that has not reached the required depth is not yet safe to ack on. With no receipt (the tx was
      // replaced, or the node forgot it) the depth has to come from the state itself.
      if (st.state === 'mined' ? (st.confirmations ?? confirmations) >= confirmations : await safely(deepEnough)) return { outcome: 'landed' };
    } else if (st.state === 'reverted') {
      // Our tx reverting usually means the batch is already attested (a duplicate), and the two reads may not
      // agree yet: look once more before calling it a failure.
      await sleep(pollSecs);
      let again = null;
      try { again = await readDigest(); } catch { /* treated as unchanged */ }
      return { outcome: again && String(again).toLowerCase() === want && await safely(deepEnough) ? 'landed' : 'reverted' };
    } else if (st.state === 'missing') {
      if (++misses >= dropMisses) return { outcome: 'dropped' };
    }
    if (st.state !== 'missing') misses = 0;

    if (now() >= deadline) return { outcome: 'timeout' };
    await sleep(pollSecs);
  }
}

async function safely(fn) {
  try { return !!(await fn()); } catch { return false; }
}

// Is `expected` still the pool's digest `confirmations` blocks behind the head? Reading at the head proves only that
// the digest is there now; a tx one block old can still be reorged out, and the ack that follows cannot be undone.
export async function digestDeepEnough({ readDigestAt, getBlockNumber, confirmations, expected }) {
  try {
    const at = (await getBlockNumber()) - BigInt(confirmations);
    const d = await readDigestAt(at < 0n ? 0n : at);
    return !!d && String(d).toLowerCase() === String(expected).toLowerCase();
  } catch { return false; }
}
