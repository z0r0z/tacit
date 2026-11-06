// Has Ethereum finality moved past the head the last eth-state candidate was built from?
//
// The eth-reflection guest asserts that the finalized head advanced ("finalized head did not advance", src/main.rs). Finality moves
// every 32 slots (about 6.4 minutes) and the eth-state stage starts the moment an attest lands, so the head is often still the one
// the previous candidate reached. The network then refuses the request as unexecutable (nothing is charged) and the retry waits two
// minutes. Asking the beacon node first lets the stage wait for the head and send one request that can run.

// The finalized head the beacon node reports now (the same finality update eth_prove reads): its slot, and the execution block it
// carries, the block a candidate made now proves the pool at (null when the update names none). Throws when there is no slot.
export async function finalizedHead(consensusRpc, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchImpl(`${String(consensusRpc).replace(/\/+$/, '')}/eth/v1/beacon/light_client/finality_update`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`finality_update answered ${res.status}`);
  const head = (await res.json())?.data?.finalized_header;
  const slot = Number(head?.beacon?.slot);
  if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('finality_update names no finalized slot');
  const block = Number(head?.execution?.block_number);
  return { slot, block: Number.isSafeInteger(block) && block > 0 ? block : null };
}

export async function finalizedSlot(consensusRpc, opts) {
  return (await finalizedHead(consensusRpc, opts)).slot;
}

// `committed` is the parsed eth_set_state.json: its bootstrap_slot is the finalized slot the last candidate reached.
// -> a one-line reason to wait, or null when the head is past it (or there is no file to compare with, a cold start).
export function finalityNotAdvanced({ committed, slot }) {
  const prev = Number(committed?.bootstrap_slot ?? 0);
  return prev > 0 && slot <= prev ? `the finalized slot (${slot}) is not past the one the last candidate reached (${prev})` : null;
}
