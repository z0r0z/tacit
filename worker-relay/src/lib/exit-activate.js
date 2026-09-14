// Relay-side activation of a relayed L2 exit (ConfidentialRouter.activateExit). The settle pays the exit to the
// recipe's CREATE2 escrow; activateExit then deploys that escrow and runs the recipe's bridge call from it. It is
// permissionless and pays its caller nothing, so the relay sends it only when the op's own bound fee covers both
// the settle already mined and the activation. The checks are pure so they are unit-tested
// (tests/confidential-exit-activate.mjs); settle-relay.js does the chain I/O.

import { getAddress } from 'viem';

const EXIT_CALL = [
  { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'push', type: 'bool' }, { name: 'data', type: 'bytes' },
];
const EXIT_RECIPE = {
  name: 'recipe', type: 'tuple', components: [
    { name: 'exitedAsset', type: 'bytes32' }, { name: 'feeAsset', type: 'address' }, { name: 'finalRecipient', type: 'address' },
    { name: 'deadline', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
    { name: 'calls', type: 'tuple[]', components: EXIT_CALL },
    { name: 'sweepTokens', type: 'address[]' }, { name: 'minOuts', type: 'uint256[]' },
  ],
};
export const ROUTER_EXIT_ABI = [
  { type: 'function', name: 'escrowAddressFor', stateMutability: 'view', inputs: [EXIT_RECIPE], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'activateExit', stateMutability: 'nonpayable', inputs: [EXIT_RECIPE], outputs: [] },
];

// The queued recipe (decimal strings, lowercase hex — see normalizeExit in worker/src/confidential-settle.js)
// as viem call arguments.
export function recipeArgs(e) {
  return {
    exitedAsset: e.exitedAsset,
    feeAsset: getAddress(e.feeAsset),
    finalRecipient: getAddress(e.finalRecipient),
    deadline: BigInt(e.deadline),
    nonce: BigInt(e.nonce),
    calls: e.calls.map((c) => ({
      target: getAddress(c.target), value: BigInt(c.value), token: getAddress(c.token),
      amount: BigInt(c.amount), push: c.push, data: c.data,
    })),
    sweepTokens: e.sweepTokens.map((t) => getAddress(t)),
    minOuts: e.minOuts.map((v) => BigInt(v)),
  };
}

// Checks that need no gas figures: the recipe maps to the recipient the proof paid (so it is this exit's own
// recipe, and the escrow the settle funded), it exits ETH (the fee converts to wei at a fixed unit scale), and it
// can still run. `escrow` is the router's own escrowAddressFor(recipe).
export function exitCheck({ job, escrow, nowSecs, ethAssetId }) {
  const e = job && job.exit;
  const op = (job && job.op) || {};
  if (!e) return { ok: false, reason: 'no exit recipe' };
  if (job.type !== 'unwrap' && job.type !== 'sendunwrap') return { ok: false, reason: `a ${job.type} job is not an exit` };
  const eth = String(ethAssetId).toLowerCase();
  if (String(e.exitedAsset).toLowerCase() !== eth || String(op.asset || '').toLowerCase() !== eth) {
    return { ok: false, reason: 'the relay activates ETH exits only' };
  }
  if (!escrow || String(op.recipient || '').toLowerCase() !== String(escrow).toLowerCase()) {
    return { ok: false, reason: 'the recipe does not map to the recipient the proof paid' };
  }
  if (BigInt(e.deadline) <= BigInt(nowSecs) + 120n) return { ok: false, reason: 'the recipe expires too soon to activate' };
  return { ok: true };
}

// Whether the op's bound fee (in-system ETH units × weiPerUnit) pays for the mined settle plus this activation,
// with `marginBps` on top. On success returns the gas limit to send with: the estimate plus 30%, never above
// the cap, which is also the limit the pre-flight simulation must use.
export function activationCover({ job, settleCostWei, gasEstimate, gasPriceWei, weiPerUnit, gasCap, marginBps = 0n }) {
  const est = BigInt(gasEstimate);
  const cap = BigInt(gasCap);
  if (est > cap) return { ok: false, reason: `activation needs ${est} gas, over the ${cap} cap` };
  const feeWei = BigInt(job.op?.fee ?? 0) * BigInt(weiPerUnit);
  const cost = BigInt(settleCostWei) + est * BigInt(gasPriceWei);
  const need = cost + (cost * BigInt(marginBps)) / 10000n;
  if (feeWei < need) return { ok: false, reason: `the fee (${feeWei} wei) is below the settle plus activation cost (${need} wei)` };
  const gas = (est * 13n) / 10n;
  return { ok: true, gas: gas > cap ? cap : gas, feeWei, cost: need };
}
