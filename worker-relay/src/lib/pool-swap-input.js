// What a V2- or V3-style pool really took in from a swap, read off the pool's own Swap events.
//
// zRouter sending WETH to a pool is not a swap. Anyone can send a pool WETH and take it straight back: a V2 pair's
// skim() hands back whatever sits above its reserves, in the same transaction, with no Swap event at all. A flash-
// loaned 5 ETH did that for no cost and was credited in full.
// A pool's Swap event is the proof the ETH went through its curve, and the amount it shows paid in is how much did.
//
// Only that is checked, not where the WETH goes afterwards: a route that comes back through the same pool is a real
// swap that paid the pool's fee both ways, and a participant who routes that way is not turned away for it.

import { decodeEventLog } from 'viem';

const ev = (inputs) => ({ type: 'event', name: 'Swap', inputs: inputs.map(([type, name, indexed]) => ({ type, name, indexed })) });

// Uniswap V2 and Sushi
const V2_SWAP = ev([['address', 'sender', true], ['uint256', 'amount0In', false], ['uint256', 'amount1In', false], ['uint256', 'amount0Out', false], ['uint256', 'amount1Out', false], ['address', 'to', true]]);
// Aerodrome V2: the same fields, `to` second
const AERO_SWAP = ev([['address', 'sender', true], ['address', 'to', true], ['uint256', 'amount0In', false], ['uint256', 'amount1In', false], ['uint256', 'amount0Out', false], ['uint256', 'amount1Out', false]]);
// Uniswap V3 and Aerodrome Slipstream: signed amounts from the pool's side, positive is paid in
const V3_SWAP = ev([['address', 'sender', true], ['address', 'recipient', true], ['int256', 'amount0', false], ['int256', 'amount1', false], ['uint160', 'sqrtPriceX96', false], ['uint128', 'liquidity', false], ['int24', 'tick', false]]);
const SWAP_EVENTS = [V2_SWAP, AERO_SWAP, V3_SWAP];

/// The WETH that `pool`'s Swap events among `logs` show paid in. `wethIsToken0` says which side of the pool WETH is.
/// Only the pool's own logs count (a log's address is its emitter, nobody else can write one for the pool).
export function wethPaidIntoPool(logs, pool, wethIsToken0) {
  const own = String(pool).toLowerCase();
  let total = 0n;
  for (const entry of logs) {
    if (String(entry.address).toLowerCase() !== own) continue;
    for (const abi of SWAP_EVENTS) {
      let args;
      try { args = decodeEventLog({ abi: [abi], data: entry.data, topics: entry.topics }).args; } catch { continue; }
      if ('amount0In' in args) total += wethIsToken0 ? args.amount0In : args.amount1In;
      else { const v = wethIsToken0 ? args.amount0 : args.amount1; if (v > 0n) total += v; }
      break;
    }
  }
  return total;
}
