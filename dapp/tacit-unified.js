// A Tacit key's unified tacit1… address: its Bitcoin keys (spend, and the BIP-352 scan key of it) and the pool keys
// every shielded pool pays (the bp1… the ETH pools and the Bitcoin pool share), with the Ethereum-side key marked as
// the spend key (flags 0x85, 276 characters). The same derivation as dapp/kit/tacit-address-kit.js, from the modules
// the apps already load; tests/tacit-address-kit.mjs holds the two to each other.
import { secp, sha256, keccak_256, hmac, hexToBytes } from './vendor/tacit-deps.min.js';
import { makeTacitAddress } from './tacit-address.js';
import { bip352TaggedHash } from './bip352.js';
import { makeBtcShieldedPool } from './btc-shielded-pool.js';

const POOL_SEED_TAG = new TextEncoder().encode('tacit-btc-pool-seed-v1');
const N = secp.CURVE.n;
const { encodeTacitAddress } = makeTacitAddress({ secp });
const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const toBig = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

// key: the 32-byte Tacit key (bytes or hex); left as given. chainHash: the key's tacit chain lane (32 bytes), once the chain is on; without it the
// address is as it always was. → { address, poolAddress }
export function unifiedAddress(key, chainHash) {
  const k = typeof key === 'string' ? hexToBytes(key.replace(/^0x/, '')) : Uint8Array.from(key);
  let seed = null;
  try {
    const spendPub = secp.getPublicKey(k, true);
    const scan = toBig(bip352TaggedHash('BIP0352/ScanKey', k)) % N;
    const btcScanPub = secp.getPublicKey(hexToBytes(scan.toString(16).padStart(64, '0')), true);
    seed = hmac(sha256, k, POOL_SEED_TAG);
    const w = pool.walletFromSeed(seed, 'mainnet');
    const address = encodeTacitAddress({ network: 'mainnet', btcSpendPub: spendPub, btcScanPub, evmOwnerPub: spendPub, poolKeys: hexToBytes(w.address.replace(/^0x/, '')), ...(chainHash ? { chainHash } : {}) });
    return { address, poolAddress: w.addressString };
  } finally { k.fill(0); seed?.fill(0); }
}
