// Recovery when the pool is ahead of the API's cursor — a batch whose attest landed but whose ack never did.
//
// The API keeps the candidate it served for each batch, keyed by that batch's digest. If the pool now sits on a
// digest the API still holds a candidate for, that batch is the one that landed, and acking it moves the cursor
// to where the chain already is. If no candidate is held (it expired, or the cursor was reseeded) the only way
// forward is a manual re-seed, and proving on the stale prior in the meantime would just burn PROVE.
//
// The ack cannot be undone, so it waits until the landed digest is deep enough (`deepEnough`): an attest one block old
// may still have its own run in its confirmation wait, and a reorg after the ack would leave the cursor ahead of the chain.
//
//   -> { recovered: true, attestedTo } | { recovered: false, waiting?: true, reason, hint }
export async function recoverLostAck({ onchain, findPending, ack, deepEnough = async () => true }) {
  let pending = null;
  try { pending = await findPending(onchain); } catch { /* API unreachable — treated as not held */ }
  if (pending && pending.found && Number(pending.attestedTo) > 0) {
    const attestedTo = Number(pending.attestedTo);
    let deep = false;
    try { deep = await deepEnough(); } catch { /* unreadable — not deep enough */ }
    if (!deep) return { recovered: false, waiting: true, reason: `the landed batch ${onchain} is not yet deep enough to ack`, hint: '' };
    const res = await ack({ attestedTo, jobId: onchain });
    if (res && res.ok) return { recovered: true, attestedTo };
    return { recovered: false, reason: `the API refused the ack for ${onchain} (status ${res ? res.status : 'none'})`, hint: manualRecoveryHint(onchain) };
  }
  return { recovered: false, reason: `the API holds no stashed batch for the pool's digest ${onchain}`, hint: manualRecoveryHint(onchain) };
}

export function manualRecoveryHint(onchain) {
  return `re-seed the cursor at the chain: POST /reflection/seed?network=mainnet {"state":{"attestedHeight":<pool's attested height>,"tipHeight":<tip>,"snapshot":<snapshot digesting to ${onchain}>},"expectDigest":"${onchain}"}; `
    + `or, if the landed batch's stash is still held, POST /reflection/ack {"network":"mainnet","jobId":"${onchain}","attestedTo":<its height>}`;
}
