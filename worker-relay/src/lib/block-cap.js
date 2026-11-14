// How many Bitcoin blocks the reflection lane asks the API to put in one job.
//
// A batch costs prover-network gas in proportion to its blocks and to the provenance chains of the bridge burns in
// them, and the request carries a gas limit (REFLECT_GAS_LIMIT). A batch over that limit is refused as
// "unexecutable", and the API would serve the same batch again. The lane cannot know a batch's cost before the
// network answers, so it learns the size the limit allows: a refusal halves the ask (down to one block), and each
// batch proved at the full ask raises it by one. The ask is kept in memory; a restarted lane starts with the API's
// own cap and relearns within a few cycles.
//
// The prover board takes a Bitcoin-state input of at most `maxBytes`. A batch whose input (`bytes`) is over that is
// asked for again at the share of its blocks that fits, with room to spare since blocks differ in size, so the board
// can still take it; it then grows back one block at a time like any other ask.
//
//   -> the ask for the next job; null = no ask (the API's own cap decides)

export const BLOCK_CAP_MAX = 64;
export const BOARD_FIT = 0.85;

export function nextBlockCap(cap, { proved = false, unexecutable = false, blocks = 0, bytes = 0, maxBytes = 0 } = {}) {
  const n = Math.floor(Number(blocks)) || 0;
  const cur = Number.isInteger(cap) && cap > 0 ? cap : null;
  if (Number(maxBytes) > 0 && Number(bytes) > Number(maxBytes)) {
    // One block over the limit cannot be made smaller by asking for fewer, so the ask stays where it is.
    return n > 1 ? Math.max(1, Math.min(n - 1, Math.floor((n * Number(maxBytes) * BOARD_FIT) / Number(bytes)))) : cur;
  }
  if (unexecutable) {
    // A refusal at one block is not about how many blocks there are: the input itself is bad, or the limit is under
    // one block's cost. Asking for less cannot help, so the ask stays where it is.
    return n > 1 ? Math.max(1, Math.floor(n / 2)) : cur;
  }
  if (!proved || cur === null) return cur;
  // A job smaller than the ask (the lane was nearly caught up) says nothing about the larger sizes.
  if (n < cur) return cur;
  return cur + 1 >= BLOCK_CAP_MAX ? null : cur + 1;
}

// Whether a prove failure is the network refusing to run the request. bitcoin_prove reports it on stderr
// ("Proof request 0x... is unexecutable").
export function isUnexecutable(stderr) {
  return /\bis (?:unexecutable|unfulfillable)\b/i.test(String(stderr || ''));
}
