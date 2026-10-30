// How many headers a wallet can send in one transaction, decided from a model before any header is fetched or any gas is estimated.
//
// A node asks the wallet to hold gas x fee cap, so a thin wallet sends a shorter batch. The cut used to be made after estimating the
// gas of the whole batch, and a node will not estimate what the sender cannot pay for: it answers 'gas required exceeds allowance
// (1981129)' (the allowance being the whole balance at the node's own gas price) instead of a number. So a wallet holding 0.00065 ETH
// asked for 20 headers failed every attempt, three minutes apart, with all twenty headers fetched first, and not one header went out
// on the 2026-10-30 dip under 0.3 gwei. The batch is cut here instead, to what the model says the wallet pays for, and the estimate that
// follows is for a batch it can afford.

// A header costs about 177k gas (measured on this relay's own advances) and a transaction about 50k besides; the send pads the estimate by 25%.
export const HEADER_GAS = 180_000n;
export const HEADER_TX_GAS = 50_000n;
export const GAS_PAD_PCT = 125n;

// The gas of a batch of `n` headers as the model has it, before the pad.
export const headerBatchGas = (n) => HEADER_TX_GAS + BigInt(n) * HEADER_GAS;

// → the most headers (0..max) a wallet with `budget` wei to spend can send at `maxFeePerGas`.
export function affordableHeaders({ budget, maxFeePerGas, max }) {
  const b = BigInt(budget), fee = BigInt(maxFeePerGas), cap = Math.max(0, Math.floor(Number(max)) || 0);
  if (b <= 0n || fee <= 0n || cap === 0) return 0;
  const gas = (b * 100n) / (fee * GAS_PAD_PCT);              // the padded gas limit the budget pays for
  if (gas <= HEADER_TX_GAS) return 0;
  const n = (gas - HEADER_TX_GAS) / HEADER_GAS;
  return n > BigInt(cap) ? cap : Number(n);
}

// What the node's wallet check asks for a batch of `n`, at `maxFeePerGas`: the padded gas limit times the cap.
export const headerBatchNeed = (n, maxFeePerGas) => (headerBatchGas(n) * GAS_PAD_PCT * BigInt(maxFeePerGas)) / 100n;

// A node's refusal to estimate a send the account cannot pay for. The model is a little optimistic only if the node prices the
// estimate above the fee cap we send with; the caller then halves the batch.
export const exceedsAllowance = (e) => /exceeds allowance|insufficient funds/i.test(String(e?.details || e?.shortMessage || e?.message || e));
