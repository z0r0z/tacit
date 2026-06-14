// cBTC redemption — a trustless atomic cBTC<->BTC swap (ops/DESIGN-cbtc-redemption.md).
//
// A fungible cBTC holder can't unlock a stranger's self-custody lock, so redemption pairs a redeeming
// HOLDER (cBTC -> BTC) with an EXITING LOCKER (their lock's BTC -> cBTC, to close out) and binds the
// cBTC BURN <-> BTC UNLOCK by an adaptor signature (PTLC). It is one market on the built cross-chain
// orderbook (dapp/cross-chain-orderbook.js), whose fills already compose the adaptor swap
// (dapp/adaptor-swap.js) — so this module adds only the redemption semantics: the locker's lock as the
// BTC source, and the PEG-PROTECTIVE invariant that a redemption burns at least as much cBTC as the BTC
// it unlocks (so supply drops >= backing drops; redemption can never weaken the peg). 1:1, trustless,
// no custodian, no mediator.

export function makeCbtcRedemption({ orderbook, cbtcAsset, btcAsset, btcLane = 'bitcoin', cbtcLane = 'tacit' }) {
  if (!orderbook) throw new Error('cbtc-redeem: orderbook required');
  if (!cbtcAsset || !btcAsset) throw new Error('cbtc-redeem: cbtcAsset + btcAsset required');
  if (btcLane === cbtcLane) throw new Error('cbtc-redeem: BTC and cBTC must be on distinct lanes');

  // offerId -> { locker, lockId } : the self-custody lock that backs the BTC a close offer pays out.
  const closes = new Map();

  // A locker posts a CLOSE offer: give the BTC from their lock, want cBTC to RETIRE. `cbtcWanted >=
  // btcAmount` is the peg-protective invariant (equality = 1:1; a surplus is the locker's fee/spread,
  // the arbitrage that pins the peg). The lockId names the BTC source (the locker's self-custody outpoint).
  function postClose({ locker, lockId, btcAmount, cbtcWanted, expiry }) {
    const btc = BigInt(btcAmount), cbtc = BigInt(cbtcWanted);
    if (btc <= 0n) throw new Error('cbtc-redeem: zero BTC');
    if (cbtc < btc) throw new Error('cbtc-redeem: close must retire >= the BTC it unlocks (peg-protective)');
    if (lockId == null) throw new Error('cbtc-redeem: lockId (the BTC source) required');
    const id = orderbook.post({
      maker: locker,
      giveAsset: btcAsset, giveAmount: btc, giveLane: btcLane,
      wantAsset: cbtcAsset, wantAmount: cbtc, wantLane: cbtcLane,
      expiry,
    });
    closes.set(id, { locker, lockId });
    return id;
  }

  // A holder discovering redemptions GIVES cBTC to GET BTC — match close offers (give BTC, want cBTC),
  // ranked best-price-for-the-holder by the orderbook.
  function quoteRedeem({ nowTs } = {}) {
    return orderbook.quote({ giveAsset: cbtcAsset, wantAsset: btcAsset, nowTs });
  }

  // Redeem `btcToTake` of a close offer: drives the atomic adaptor swap — the holder pays (burns)
  // `cbtcBurned` cBTC and receives `btcToTake` BTC from the locker's lock. Returns the swap context to
  // drive (lock/verify/claim/counterclaim) + the conservation-checked amounts + the lock being unwound.
  function redeem(closeOfferId, { holder, btcToTake, t, nearDeadline, farDeadline, nowTs }) {
    const close = closes.get(closeOfferId);
    if (!close) throw new Error('cbtc-redeem: not a redemption (close) offer');
    const f = orderbook.fill(closeOfferId, { taker: holder, takeGive: btcToTake, t, nearDeadline, farDeadline, nowTs });
    const cbtcBurned = f.legs.initiator.amount; // the holder (taker) pays cBTC -> burned on settlement
    const btcUnlocked = f.legs.responder.amount; // the locker (maker) pays the lock's BTC
    // peg-protective conservation: the supply burned must be >= the backing unlocked.
    if (cbtcBurned < btcUnlocked) throw new Error('cbtc-redeem: invariant violated — burn < unlock');
    return {
      swap: f.swap,
      cbtcBurned,
      btcUnlocked,
      lockId: close.lockId, // the self-custody lock unlocked to the holder
      holder,
      locker: close.locker,
    };
  }

  function cancelClose(offerId, locker) {
    const ok = orderbook.cancel(offerId, locker);
    if (ok) closes.delete(offerId);
    return ok;
  }

  return { postClose, quoteRedeem, redeem, cancelClose };
}
