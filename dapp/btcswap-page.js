// The Bitcoin-to-Bitcoin swap desk for a page that holds a Tacit key (dapp/btcswap*.js): the desk's terms, a swap of a note the
// bridge's proof does not follow for TAC it does, and the key's swaps, advanced while the page is open. No DOM.
//
//   const s = openBtcSwap({ T, withKey, ux, priv, pubHex, desk })
//   -> { info(), quote(amount), start(note, quote), records(), run(), say(rec) }
//
//   T  tacit.js with the key's wallet open     withKey(fn)  a call under that key     ux  the pool module     desk  the desk's URL

import { makeBtcWallet } from '/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '/adaptor-btc-tx.js';
import { makeEsploraBtcChain } from '/fastbridge-btc.js?cb=882f11ad';
import { makeLocalStore } from '/fastbridge-client.js?cb=ee84ee44';
import { makeBtcSwapHolder, holderDone } from '/btcswap-holder.js?cb=ec8dc7eb';
import { deskClient } from '/btcswap-desk.js?cb=e511951b';
import { secp, sha256, keccak_256, hmac, hexToBytes } from '/vendor/tacit-deps.min.js';

// The desk's URL. None is running yet, so the page offers no swap and asks nothing until this is set.
export const DESK = null;
const EXPLORERS = ['https://mempool.space/api', 'https://mempool.emzy.de/api', 'https://mempool.bitaroo.net/api', 'https://blockstream.info/api'];
const enc = new TextEncoder();

export function openBtcSwap({ T, withKey, ux, priv, pubHex, desk = DESK || 'http://localhost:0', fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc' }) {
  const { prims } = makeBtcWallet({ priv, hrp, fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  if (prims.wallet.address() !== T.wallet.address()) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.');
  const btc = makeEsploraBtcChain({
    bases, prims, builder: makeAdaptorBtcTx({ prims, kit: tacitKit(T) }), fetchImpl,
    tacit: T, pool: ux.pool, ethGetStorageAt: (to, slot, tag) => ux.rpc('eth_getStorageAt', [to, slot, tag]), poolAddress: ux.cfg.pool, binding: ux.chainBindingHex(), keccak256: keccak_256, secp,
  });
  const api = deskClient({ base: desk, fetchImpl });
  const store = makeLocalStore(`tacit-btcswap-v1:mainnet:${pubHex}:`);
  const holder = makeBtcSwapHolder({
    seed: hmac(sha256, priv, enc.encode('tacit-btcswap-holder-seed')), now: () => Math.floor(Date.now() / 1000), store, btc, desk: api,
    policy: { csvBlocks: 288 }, tracking: (notes) => withKey((t) => t.bridgeUx().noteTracking(notes)),
  });
  let running = null;
  const run = () => running || (running = (async () => {
    try { for (const r of await store.list()) if (!holderDone(r)) await holder.step(r); } finally { running = null; }
  })());
  return {
    address: prims.wallet.address(),
    info: () => api.info(),
    quote: (amount) => api.quote(amount),
    start: async (note, quote) => {
      const rec = await holder.start({ asset: hexToBytes(quote.asset), amount: BigInt(quote.value), notes: [note], quote });
      await holder.step(rec);
      return rec;
    },
    records: () => store.list(),
    run,
  };
}

// One line for a swap, as the Bridge tab lists it.
export function sayBtcSwap(rec) {
  switch (rec.phase) {
    case 'built': case 'broadcast': return 'Locked for the swap desk. Waiting for Bitcoin to confirm it.';
    case 'offered': return rec.waiting ? 'The desk has locked TAC for you. Waiting for it to confirm.' : 'Waiting for the desk to lock TAC for you.';
    case 'claiming': return 'Taking the desk’s TAC.';
    case 'claimed': return 'Taken. Waiting for Bitcoin to confirm it.';
    case 'done': return 'Swapped. This TAC bridges once Bitcoin’s proof on Ethereum has seen it, usually within a few hours.';
    case 'refund-wait': return 'The swap did not go ahead. Your TAC comes back once its timelock runs (about two days from the lock).';
    case 'refunded': return 'The swap did not go ahead. Your TAC is back.';
    case 'desk-took': return 'The desk opened your lock.';
    default: return '';
  }
}
