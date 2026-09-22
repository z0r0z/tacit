// Recovery of confidential AMM farm-position notes (lp_return + reward) after a localStorage wipe.
//
// Both note blindings are PUBLIC in the unbond/harvest envelope (lpReturnR / rewardR), so the
// openings reconstruct from the envelope + the farm/bond records. The envelope carries only
// farmId/bondId — NOT pool_id, lp_asset_id, reward_asset_id, or bond_amount — so those come from the
// worker farm record (fetchFarm / fetchBondsForBonder). This is the same trust model as
// T_PROTOCOL_FEE_CLAIM: the worker enforces accounting soundness (the reward an unbond owes); the
// dapp's job here is only to RECONSTRUCT each note's opening so a wiped wallet can re-credit and
// spend it. The reconstructed Pedersen commitment is byte-identical to the validator's decree
// (tests/amm-farm.mjs validateLpUnbond / validateLpHarvest: pedersenCommit(amount, r) per note),
// so a recovered opening reopens exactly the on-chain UTXO.
//
// Pure + portable (node + browser); the integration that fetches the farm/bond records and feeds
// these openings into the holdings scan is a separate, gated step.

import { pedersenCommit, pointToBytes, SECP_N } from './bulletproofs.js';
import { decodeLpUnbond, decodeLpHarvest, deriveLpAssetIdFromPoolId } from './amm-envelope.js';

const _hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const _beBig = (b) => (b && b.length ? BigInt('0x' + _hex(b)) : 0n); // big-endian, matches the validator's bytesToBigintBE
const _toBytes = (h) => (h instanceof Uint8Array ? h : Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16))));

export function makeFarmRecovery() {
  // One note opening: enough to re-credit + spend (asset, amount, blinding, and the on-chain
  // commitment it must reopen). null when the public blinding is degenerate (zero) — the validator
  // rejects that too, so no such UTXO exists.
  function _opening(kind, vout, assetIdHex, amount, rBytes) {
    const blinding = _beBig(rBytes) % SECP_N;
    if (blinding === 0n) return null;
    const commitmentHex = _hex(pointToBytes(pedersenCommit(BigInt(amount), blinding)));
    return { kind, vout, assetIdHex: String(assetIdHex).replace(/^0x/, '').toLowerCase(), amount: BigInt(amount), blinding, commitmentHex };
  }

  // T_LP_UNBOND → lp_return note (vout 1) of the bonded shares, which the envelope carries.
  // poolId (→ lp_asset_id) comes from the worker farm record.
  function recoverUnbond(payload, { poolId } = {}) {
    const dec = decodeLpUnbond(_toBytes(payload));
    if (!dec || poolId == null) return [];
    const lpAssetIdHex = _hex(deriveLpAssetIdFromPoolId(_toBytes(poolId)));
    const lp = _opening('lp_return', 1, lpAssetIdHex, dec.shares, dec.lpReturnR);
    return lp ? [lp] : [];
  }

  // T_LP_HARVEST → reward note (vout 1, only when rewardAmount > 0). The reward amount + blinding are
  // both in the envelope; only reward_asset_id comes from the farm record.
  function recoverHarvest(payload, { rewardAssetIdHex } = {}) {
    const dec = decodeLpHarvest(_toBytes(payload));
    if (!dec || dec.rewardAmount === 0n || rewardAssetIdHex == null) return [];
    const rw = _opening('farm_reward', 1, rewardAssetIdHex, dec.rewardAmount, dec.rewardR);
    return rw ? [rw] : [];
  }

  return { recoverUnbond, recoverHarvest };
}
