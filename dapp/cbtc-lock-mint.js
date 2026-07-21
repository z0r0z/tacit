// cbtc-lock-mint — assembles the full self-custody cBTC ① lock driver from the portable pieces:
//   bitcoin-taproot-wallet (BTC prims) + cbtc-note-recovery (recoverable blinding) + cbtc-lock (orchestrator)
//   + cbtc-lock-broadcast (Taproot commit→reveal). Network access is public esplora (injected fetch).
//   The two functions cbtc-lock needs that were never written elsewhere are defined here:
//   - selectLockFunding: coin-select a wallet UTXO to fund the lock (the note blinding anchors to it)
//   - ownLockScriptPubKey: the self-custody key-path P2TR the vBtc locks into (user redeems it later)
// ② reflection folds the lock; ③ mintCbtc (engine) opens the note 1:1. FUND-CRITICAL: prove a SMALL lock on
// mainnet first (recoverability via scanCbtc) before scaling.
import { makeBtcWallet } from './bitcoin-taproot-wallet.js';
import { makeCbtcLock } from './cbtc-lock.js';
import { makeCbtcLockBroadcast } from './cbtc-lock-broadcast.js';
import { makeCbtcNoteRecovery } from './cbtc-note-recovery.js';
import { hmac, sha256 } from './vendor/tacit-deps.min.js';

const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

// Public esplora fetch deps (rotates mirrors). Returns { fetchUtxos, broadcastTx, fetchFeeRate }.
function makeEsplora(bases = ['https://blockstream.info/api', 'https://mempool.space/api']) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function req(path, opts) {
    let err;
    for (let a = 0; a < 8; a++) {
      const base = bases[a % bases.length];
      try { const r = await fetch(base + path, opts); if (!r.ok) throw new Error(`${r.status}`); return r; }
      catch (e) { err = e; await sleep(300 * (a + 1)); }
    }
    throw err;
  }
  return {
    fetchUtxos: async (address) => (await req(`/address/${address}/utxo`)).json(),        // [{txid,vout,value,...}]
    broadcastTx: async (hex) => (await req('/tx', { method: 'POST', body: hex })).text(),  // → txid
    fetchFeeRate: async (_tier) => { try { const j = await (await req('/fee-estimates')).json(); return Math.max(1, Math.ceil(j['2'] || j['3'] || j['6'] || 5)); } catch { return 5; } },
  };
}

export function makeCbtcLockMint({ priv, pool, cbtcAsset, esploraBases, postHint = null, lockVout = 1, hrp = 'bc' } = {}) {
  if (!(priv instanceof Uint8Array) || priv.length !== 32) throw new Error('cbtc-lock-mint: priv must be 32 bytes');
  if (!pool || typeof pool.commitXY !== 'function') throw new Error('cbtc-lock-mint: need pool.commitXY');
  if (!cbtcAsset) throw new Error('cbtc-lock-mint: need cbtcAsset (0x62a20d98… CBTC_ZK_ASSET_ID)');

  const { wallet, prims } = makeBtcWallet({ priv, hrp, ...makeEsplora(esploraBases) });
  const rec = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: SECP_N });
  const broadcastCbtcLockTx = makeCbtcLockBroadcast(prims);

  // Self-custody lock output = the user's KEY-PATH-only P2TR (BIP-341 tweak with an empty merkle root).
  // Redemption/reflection don't constrain the spk form (the fold records outpoint→vBtc), so key-path is the
  // simplest form the user can later redeem with their own key.
  function ownLockScriptPubKey() {
    const { Q_xonly } = prims.tweakedOutputKey(wallet.xonly(), new Uint8Array(0));
    return prims.p2trScript(Q_xonly);
  }

  // Coin-select the funding prevout: smallest UTXO that alone covers amount+buffer (fewest inputs); else the
  // largest available (the lock's fee logic tops up with extra UTXOs if needed).
  async function selectLockFunding({ amountSats }) {
    const utxos = await prims.getUtxos(wallet.address());
    if (!Array.isArray(utxos) || !utxos.length) throw new Error('cbtc-lock: no BTC UTXOs to fund the lock');
    const need = BigInt(amountSats);
    const covering = utxos.filter((u) => BigInt(u.value) >= need).sort((a, b) => Number(BigInt(a.value) - BigInt(b.value)));
    const pick = covering[0] || utxos.slice().sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)))[0];
    return { fundingPrevout: { txid: pick.txid, vout: pick.vout, value: pick.value } };
  }

  const cbtc = makeCbtcLock({
    privkey: priv, asset: cbtcAsset, commitXY: pool.commitXY,
    deriveCbtcNoteBlinding: rec.deriveCbtcNoteBlinding, anchorBytes: rec.anchorBytes,
    selectLockFunding, ownLockScriptPubKey, broadcastCbtcLockTx, postHint, lockVout,
  });

  // ① Lock: broadcast the commit→reveal, return everything ③ mint needs (outpoint = lockTxid‖lockVout).
  //   → { lockTxid, lockVout, vBtc, blinding, anchor }
  return {
    wallet,
    lock: cbtc.buildAndBroadcastCbtcLock,
    scanCbtc: rec.scanCbtc,           // recover the note from key + chain (the anti-strand check)
    ownLockScriptPubKey,
  };
}
