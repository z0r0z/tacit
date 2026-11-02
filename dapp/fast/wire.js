// The fast bridge for a page that holds a Tacit key: the Bitcoin and pool sides built from the key and tacit.js, the client over
// them, and the key's TAC notes on Bitcoin. No DOM.
//
//   const s = await openFast({ T, withKey, ux, priv, pubHex, lp, pins })
//   T        tacit.js with the key's wallet open          withKey(fn)  a call under that key (tacit-session.js)
//   ux       the pool module (trade/poolux.js)            priv         the key, 32 bytes
//   lp       the provider: { base, claimPub? }            pins         { btcAsset, evmAsset }
//   -> { fb, address, notes(), balance() }

import { makeBtcWallet } from '/bitcoin-taproot-wallet.js?cb=6e90dd96';
import { makeAdaptorBtcTx, tacitKit } from '/adaptor-btc-tx.js?cb=bc74dcba';
import { makeEsploraBtcChain } from '/fastbridge-btc.js?cb=8216bdd8';
import { makeFastBridgeEvm } from '/fastbridge-evm.js?cb=2391fffd';
import { makeHttpCounter } from '/fastbridge-http.js?cb=11295986';
import { makeFastBridgeClient, makeLocalStore } from '/fastbridge-client.js?cb=ad95b8d6';
import { secp, sha256, keccak_256, hmac } from '/vendor/tacit-deps.min.js';

export const TAC_ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];
const enc = new TextEncoder();

// The key's confirmed TAC notes as the lock takes them.
export async function notesOf(T, asset = TAC_ASSET) {
  const h = await T.scanHoldings();
  const e = h instanceof Map ? h.get(asset) : null;
  return ((e && e.utxos) || [])
    .filter((x) => x.utxo && x.utxo.status && x.utxo.status.confirmed)
    .map((x) => ({ txid: x.utxo.txid, vout: x.utxo.vout, value: x.utxo.value, amount: BigInt(x.amount), blinding: BigInt(x.blinding) }));
}

export async function openFast({ T, withKey, ux, priv, pubHex, lp, pins = {}, fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', now }) {
  const asset = { btcAsset: TAC_ASSET, evmAsset: TAC_ASSET, ...pins };
  const { prims } = makeBtcWallet({ priv, hrp, fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  // the lock spends notes at the wallet's own address: both must name the same one
  if (prims.wallet.address() !== T.wallet.address()) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.');
  const builder = makeAdaptorBtcTx({ prims, kit: tacitKit(T) });
  const btc = makeEsploraBtcChain({ bases, prims, builder, fetchImpl });
  const seed = hmac(sha256, priv, enc.encode('tacit-fastbridge-user-seed'));
  const evm = makeFastBridgeEvm({
    ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: priv, seed, asset: asset.evmAsset, poolAddress: ux.cfg.pool,
  });
  const store = makeLocalStore(`tacit-fastbridge-v1:mainnet:${pubHex}:`);
  const counter = makeHttpCounter({ base: lp.base, fetchImpl });
  const fb = makeFastBridgeClient({ lp: counter, btc, evm, store, seed, pins: { claimPub: lp.claimPub || undefined, ...asset }, ...(now ? { now } : {}) });
  const notes = () => withKey((t) => notesOf(t, asset.btcAsset));
  const balance = async () => (await notes()).reduce((s, n) => s + n.amount, 0n);
  return { fb, address: prims.wallet.address(), notes, balance };
}
