// An EIP-2612 permit for the registry's stake, signed by the relay's key: approval and listing in one transaction (registerWithPermit).
// The digest is built from the token's own DOMAIN_SEPARATOR, so it holds for any permit token whatever its name and version.
import { encodeAbiParameters, keccak256, concatHex, toHex, parseAbi } from 'viem';

const TYPEHASH = keccak256(toHex('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
const ABI = parseAbi(['function DOMAIN_SEPARATOR() view returns (bytes32)', 'function nonces(address) view returns (uint256)']);

export function permitDigest({ domainSeparator, owner, spender, value, nonce, deadline }) {
  const struct = keccak256(encodeAbiParameters(
    ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'].map((type) => ({ type })),
    [TYPEHASH, owner, spender, value, nonce, deadline],
  ));
  return keccak256(concatHex(['0x1901', domainSeparator, struct]));
}

// → { v, r, s, deadline } for `value` of `token` to `spender`, from the account (a viem local account) with the token's current nonce
export async function signPermit({ account, client, token, spender, value, deadline }) {
  const [domainSeparator, nonce] = await Promise.all([
    client.readContract({ address: token, abi: ABI, functionName: 'DOMAIN_SEPARATOR' }),
    client.readContract({ address: token, abi: ABI, functionName: 'nonces', args: [account.address] }),
  ]);
  const sig = await account.sign({ hash: permitDigest({ domainSeparator, owner: account.address, spender, value, nonce, deadline }) });
  return { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16), deadline };
}
