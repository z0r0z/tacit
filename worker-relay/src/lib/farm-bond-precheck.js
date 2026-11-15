// Before a farm entry (an lpbond: add liquidity to a pool and bond the shares into a farm) is proved, ask the farm it names whether it holds
// that pool's shares. A standalone farm names its one stake asset; the launch manager lists its pools. An entry bonded into a farm that does not
// hold the pool's shares can only revert (WrongStakeAsset, in the farm's onCdpMint, after the proof was made and paid for), whatever its proof, so
// it is failed without proving, with a reason the user can act on. Anything unreadable lets the job through, so the check only ever skips work
// that cannot succeed.
import { concatHex, keccak256, numberToHex, pad, stringToHex } from 'viem';

const isHex32 = (v) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]{1,64}$/.test(v);
const word = (v) => pad(String(v).startsWith('0x') ? v : `0x${v}`, { size: 32 });

// The share asset of a pool: the derivation the pages and the guest use (dapp/confidential-pool.js evmPoolId, evmLpShareId).
export function lpShareOf(assetA, assetB, feeBps) {
  const [a, b] = [word(assetA), word(assetB)];
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  const pid = keccak256(concatHex([lo, hi, numberToHex(Number(feeBps), { size: 32 })]));
  return keccak256(concatHex([pid, stringToHex('lp')]));
}

const STAKE_ABI = [{ type: 'function', name: 'STAKE_ASSET', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }];
const MANAGER_ABI = [{ type: 'function', name: 'pidOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ name: 'pid', type: 'uint256' }, { name: 'exists', type: 'bool' }] }];
const WRONG_FARM = 'this farm does not hold the shares of the pool you are adding to. Nothing was spent: reload the page and try again';

// A stand-alone farm's stake asset never changes, so a read that succeeded is kept; a read that failed is not (it may only be a node that did not answer).
const stakeOf = new Map();

// A reason string when the entry's settle can only revert, else null.
export async function bondBlocker({ type, op }, { client }) {
  if (type !== 'lpbond' || !op) return null;
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(op.controller || '')) || !isHex32(op.assetA) || !isHex32(op.assetB) || !Number.isInteger(Number(op.feeBps))) return null;
    // a pool id with a protocol fee is derived another way: the pool decides
    if (Number(op.protocolFeeBps || 0) !== 0) return null;
    const lp = lpShareOf(op.assetA, op.assetB, op.feeBps).toLowerCase();
    const ctl = op.controller.toLowerCase();
    let stake = stakeOf.get(ctl);
    if (stake === undefined) {
      stake = await client.readContract({ address: op.controller, abi: STAKE_ABI, functionName: 'STAKE_ASSET' }).then((s) => String(s).toLowerCase(), () => null);
      if (stake) stakeOf.set(ctl, stake);
    }
    if (stake) return stake === lp ? null : WRONG_FARM;
    // not a stand-alone farm: the launch manager, which lists the pools it holds
    const [, exists] = await client.readContract({ address: op.controller, abi: MANAGER_ABI, functionName: 'pidOf', args: [lp] });
    return exists ? null : WRONG_FARM;
  } catch { return null; }
}
