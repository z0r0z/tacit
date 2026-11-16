// A Tacit key's chain lane: the hash of its address on the Tacit chain, which the key's tacit1… address names (as the 0x… chain lane of the address)
// so a payer on the chain finds the key without asking the directory. It comes from the key alone: the chain and the asset only matter once a note is
// spent, so any page can make it with no contract read and no prover. The derivation is the chain wallet's own.
import { sha256, hmac, hexToBytes } from './vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from './vendor/tacit-poseidon.min.js';
import { makeChainWallet } from './tacit-chain-wallet.js';

const te = new TextEncoder();
export const chainSeed = (priv) => hmac(sha256, priv, te.encode('tacit-chain-seed-v1'));

const NO_CHAIN = '0x' + '00'.repeat(32);
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const poseidon = (xs) => POSEIDON[xs.length](xs);
let wallet = null;

// priv: the 32-byte Tacit key, as bytes or hex (left as given). → the 32-byte chain lane
export function chainLane(priv) {
  wallet ||= makeChainWallet({ poseidon, prover: null, chain: NO_CHAIN, asset: 0n });
  const k = typeof priv === 'string' ? hexToBytes(priv.replace(/^0x/, '')) : Uint8Array.from(priv);
  let seed = null;
  try {
    seed = chainSeed(k);
    return wallet.chainAddressHash(wallet.address(wallet.keys(seed)));
  } finally { k.fill(0); seed?.fill(0); }
}
