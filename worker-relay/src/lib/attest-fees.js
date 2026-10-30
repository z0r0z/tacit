// What the relay wallet must hold for an attest to be sent. A node refuses a send whose gas limit times fee cap the wallet cannot
// cover, and the send carries viem's default cap, 1.2x the base fee plus the tip; the check allows a little over that (1.35x), so a
// wallet that passes it can send. It was twice the base fee, which is what the lane asked for in float when an attest cost a
// third of that (a 394k-gas attest at a 0.70 gwei base fee cost 0.00028 ETH and the check asked for 0.0010).
//
//   gas   the gas limit the send will carry (the padded estimate once the proof is in hand, the budget before one is bought)
export const ATTEST_CAP_PCT = 135n;
export const attestFundsNeed = ({ gas, base, tip }) => BigInt(gas) * ((BigInt(base) * ATTEST_CAP_PCT) / 100n + BigInt(tip));
