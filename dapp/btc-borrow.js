export function exactNotes(notes, debt) {
  const one = notes.find((n) => BigInt(n.value) === debt);
  if (one) return [one];
  const xs = [...notes].sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1)).slice(0, 12);
  for (let k = 2; k <= 4; k++) {
    const pick = (from, left, sum) => {
      if (left === 0) return sum === debt ? [] : null;
      for (let i = from; i < xs.length; i++) { const v = sum + BigInt(xs[i].value); if (v > debt) continue; const r = pick(i + 1, left - 1, v); if (r) return [xs[i], ...r]; }
      return null;
    };
    const r = pick(0, k, 0n);
    if (r) return r;
  }
  return null;
}

export const SAFE_RATIOS = [250, 200, 175];
export function loanHealth({ sats, debt, usdBtc, floor, liq }) {
  const coll = Number(sats) / 1e8, owed = Number(debt) / 1e8;
  if (!(coll > 0) || !(owed > 0) || !(usdBtc > 0)) return { ratio: null, liqAt: null, level: '' };
  const ratio = (coll * usdBtc / owed) * 100;
  return { ratio, liqAt: liq > 0 ? (owed / coll) * (liq / 100) : null, level: floor && ratio < floor ? 'err' : ratio < 175 ? 'warn' : '' };
}
export function borrowAt({ sats, usdBtc, pct }) {
  const v = (Number(sats) / 1e8) * usdBtc / (pct / 100);
  return Number.isFinite(v) && v > 0 ? Math.floor(v * 100) / 100 : 0;
}

export const ESCROW = '0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA', POST_ESCROW_WITH_ETH = 'c0e2d9a1';
export const outpointOf = (t, lock) => t.pool.outpointKey('0x' + lock.lockTxid.match(/../g).reverse().join(''), lock.lockVout);
export function bondGap(needWst, have) { const want = (BigInt(needWst) * 11n) / 10n, held = BigInt(have || 0); return { want, gap: want > held ? want - held : 0n }; }
// What a lock costs on top of its amount: the reveal's dust output and fee, and the commit's fee for `coins` inputs (every coin the
// address holds may be one), with a tenth to spare. `lockRate` is the fee rate it is sized with, which the lock is then sent at
// (makeLoans().lock's `rate`), so the lock the page sized is the lock that is built.
export const lockRate = (recommended, estimates) => Math.max(1, Math.ceil(recommended?.fastestFee || estimates?.['1'] || estimates?.['2'] || 5));
export function lockPad(recommended, estimates, coins = 2) {
  const rate = lockRate(recommended, estimates), fee = (vb) => Math.max(500, vb * rate), n = Math.max(1, Math.min(Number(coins) || 2, 20));
  return BigInt(Math.ceil((546 + fee(LOCK_REVEAL_VB) + fee(11 + n * 68 + 43 + 31)) * 1.1));
}
const LOCK_REVEAL_VB = 212;
export const bondCall = (t, lock) => ({ to: ESCROW, data: '0x' + POST_ESCROW_WITH_ETH + strip(outpointOf(t, lock)) });

const strip = (h) => String(h).replace(/^0x/, '');
const ZERO = '0x' + '0'.repeat(64);

const CBTC_MINTED = 'e2c2a40c', ESCROW_TOTAL = 'e06e89c9';
const sentence = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

export function makeLoans({ sha256, hmac, secp, bytesToHex, hexToBytes, pubHex, noteRecovery = () => import('/cbtc-note-recovery.js'), redeemModule = () => import('/cbtc-redeem.js?cb=10a0d63f'),
  lockModule = () => import('/cbtc-lock-mint.js?cb=91821cf3'), deployments = () => import('/confidential-deployments.js') }) {
  async function positions() {
    const { makeCdpPositionStore } = await import('/confidential-secret-store.js');
    return makeCdpPositionStore({ sha256, hmac, secp, curveOrder: secp.CURVE.n });
  }

  async function nextKeyNonce(t, priv, controller, ps, ownerOf) {
    const c = String(controller).toLowerCase(), K = `tacit-cdp-next-key-nonce:${c}:${pubHex()}`;
    let local = 0;
    try { local = Math.max(0, parseInt(localStorage.getItem(K), 10) || 0); } catch {}
    for (const p of ps.list()) if (String(p.controller).toLowerCase() === c && Number.isInteger(p.keyNonce) && String(p.positionOwner).toLowerCase() === ownerOf(p.keyNonce)) local = Math.max(local, p.keyNonce + 1);
    let chain = null, partial = null;
    try {
      const r = await t.recoverCdpPositions({ walletPriv: priv });
      if (Number.isInteger(r?.nextKeyNonce)) { if ((r.skipped || []).length) partial = r.nextKeyNonce; else chain = r.nextKeyNonce; }
    } catch {}
    if (chain == null && partial == null && local === 0) throw new Error('Could not read your existing loans to pick a fresh key. Try again in a moment.');
    const n = chain != null ? Math.max(chain, Math.min(local, chain + 10)) : Math.max(local, partial ?? 0);
    try { localStorage.setItem(K, String(n + 1)); } catch {}
    return n;
  }

  async function fresh(t, priv, controller) {
    const { derivePositionOwnerPriv } = await import('/confidential-recovery.js');
    const ps = await positions();
    const ownerOf = (i) => '0x' + bytesToHex(secp.getPublicKey(hexToBytes(strip(derivePositionOwnerPriv({ hmac, sha256, curveOrder: secp.CURVE.n }, priv, controller, i))), true).slice(1));
    const keyNonce = await nextKeyNonce(t, priv, controller, ps, ownerOf);
    return { ps, keyNonce, positionOwner: ownerOf(keyNonce) };
  }

  function openArgs(t, priv, { note: n, debtValue, controller, rate, positionOwner }) {
    const leg = { asset: n.asset, cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner, nk: n.secret };
    const anchor = t.pool.nativeNu(leg.owner, leg.nk, t.pool.leaf(leg.asset, leg.cx, leg.cy, leg.owner));
    const d = t.deriveOutput(priv, anchor, 'cdpDebt', 0);
    return { leg, anchor, args: { controller, debtValue, rateSnapshot: rate, fee: 0n, collateral: [leg], spendRoot: n.root, debtBlinding: d.blindingHex, positionOwner, debtNk: d.nk } };
  }
  const opened = (ps, priv, { controller, debtValue, keyNonce, positionOwner, rate, anchor, basket, txHash = null }) =>
    ps.add(priv, { controller, debtValue: debtValue.toString(), nonce: ZERO, keyNonce, positionOwner, rateSnapshot: rate, debtAnchor: anchor, basket, openedAt: txHash }).catch(() => {});

  function positionLeaf(t, p) {
    const cdp = t.cdp, debtAsset = String(cdp.debtAssetId(p.controller)).toLowerCase();
    const basket = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
    const leaf = cdp.positionLeaf(p.controller, debtAsset, cdp.basketRoot(basket.map((l) => cdp.basketLeg(l.asset, l.value))), BigInt(p.debtValue), p.rateSnapshot, p.positionOwner, p.nonce || ZERO);
    return { leaf, basket, debtAsset };
  }
  function repayArgs(t, priv, { p, ownerPriv, basket, tree, index, picked }) {
    const cdp = t.cdp, { leaf } = positionLeaf(t, p);
    const nu = cdp.positionNullifier(leaf);
    const keys = basket.map((_l, i) => t.deriveOutput(priv, nu, 'cdpRelease', i));
    return {
      controller: p.controller, debtValue: BigInt(p.debtValue), rateSnapshot: p.rateSnapshot, positionOwner: p.positionOwner, positionOwnerPriv: ownerPriv,
      basket, positionIndex: index, positionPath: tree.pathFor(index).path, spendRoot: picked[0].root, cdpPositionRoot: tree.root, fee: 0n,
      releaseBlindings: keys.map((k) => k.blindingHex), releaseNks: keys.map((k) => k.nk),
      debtNotes: picked.map((n) => ({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner, nk: n.secret })),
    };
  }
  const repaid = (ps, p) => ps.remove((x) => x.controller === p.controller && (x.positionOwner || '') === (p.positionOwner || '') && x.debtValue === p.debtValue);

  async function mintArgs(t, priv, lock) {
    const { makeCbtcNoteRecovery } = await noteRecovery();
    const r = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
    const b = r.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: r.anchorBytes(lock.anchor.txid, lock.anchor.vout), outputIndex: 0 });
    return { walletPriv: priv, outpoint: outpointOf(t, lock), vBtc: BigInt(lock.vBtc), blinding: '0x' + b.toString(16).padStart(64, '0') };
  }

  async function lockMaker(t, priv, skip = []) {
    const [lm, dep] = await Promise.all([lockModule(), deployments()]);
    return { lm: lm.makeCbtcLockMint({ priv, pool: t.pool, cbtcAsset: t.pool.CBTC_ZK_ASSET_ID, hrp: 'bc', excludeOutpoints: [...dep.listProtectedOutpoints(), ...skip] }), dep };
  }
  // A lock is two Bitcoin transactions, and the first holds the lock's sats until the second spends it. Both are signed before
  // either is sent and kept in this browser under the key until Bitcoin has the second, so a lock cut short between the two (a closed
  // tab, a lost connection, a refusal) is sent again on a later visit rather than left where no page finishes it.
  const signedKey = () => `tacit-cbtc-lock-signed-v1:${pubHex()}`;
  const signedList = () => { try { const v = JSON.parse(localStorage.getItem(signedKey()) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const signedPut = (list) => { try { if (list.length) localStorage.setItem(signedKey(), JSON.stringify(list)); else localStorage.removeItem(signedKey()); } catch {} };
  const signedDrop = (lockTxid) => signedPut(signedList().filter((x) => x.lockTxid !== lockTxid));
  const recordOf = (x) => ({ lockTxid: x.lockTxid, lockVout: x.lockVout, vBtc: String(x.vBtc), anchor: { txid: x.anchor.txid, vout: x.anchor.vout }, at: x.at || Date.now() });

  // The kept locks, each sent again where it is not on Bitcoin yet. → { locked: [record], waiting: n }: the ones Bitcoin now has, and how
  // many could not be finished or ruled out this time.
  async function resumeLocks(t, priv) {
    const list = signedList(), out = { locked: [], waiting: 0 };
    if (!list.length) return out;
    const { lm, dep } = await lockMaker(t, priv);
    for (const x of list) {
      let state;
      try { state = await lm.finishLock(x); } catch { out.waiting++; continue; }
      if (state === 'locked') { dep.protectOutpoint(x.lockTxid, x.lockVout, x.vBtc); out.locked.push(recordOf(x)); }
      else dep.unprotectOutpoint(x.lockTxid, x.lockVout);
      signedDrop(x.lockTxid);
    }
    return out;
  }

  // `rate` (sat/vB) is the fee rate the page sized the lock with (lockRate). A lock kept from an earlier press is finished first, and is
  // what comes back (`resumed`) when it is: a second lock is not made beside it.
  async function lock(t, priv, { sats, unconfirmed = [], rate = null, say = () => {} }) {
    say('Checking which of your outputs are already locks…');
    await t.syncCbtcLockReservations(priv);
    const earlier = await resumeLocks(t, priv);
    if (earlier.waiting) throw new Error('An earlier lock from this browser is still being sent to Bitcoin. Try again in a minute.');
    if (earlier.locked.length) { const r = earlier.locked[earlier.locked.length - 1]; return { ...r, record: r, resumed: true }; }
    const { lm, dep } = await lockMaker(t, priv, unconfirmed);
    say('Signing and broadcasting your lock…');
    let signed = null;
    const keep = (s) => { signed = { ...s, at: Date.now() }; dep.protectOutpoint(s.lockTxid, s.lockVout, s.vBtc); signedPut([...signedList().filter((x) => x.lockTxid !== s.lockTxid), signed]); };
    let res;
    try { res = await lm.lock({ amountSats: sats, feeRate: rate, onSigned: keep }); }
    catch (e) {
      if (!signed) throw e;
      // nothing of it reached Bitcoin: it is not kept, and the press can be made again
      if ((await lm.txKnown(signed.commitTxid).catch(() => true)) === false) { signedDrop(signed.lockTxid); dep.unprotectOutpoint(signed.lockTxid, signed.lockVout); throw e; }
      throw Object.assign(new Error('Your lock is signed but Bitcoin does not have all of it yet. It is kept in this browser and sent again on its own: read again in a minute, before locking again.'), { lockKept: true, cause: e });
    }
    signedDrop(res.lockTxid);
    dep.protectOutpoint(res.lockTxid, res.lockVout, res.vBtc);
    return { ...res, record: recordOf({ ...res, at: Date.now() }) };
  }

  // A lock nothing was minted on, taken back: its output spent to the key's deposit address in one Bitcoin transaction, the fee out of
  // the lock. It is refused unless the pool has minted nothing on the lock and no bond stands on it, both read now, and Bitcoin still
  // has the output; a read that fails refuses too. `quote` builds it and sends nothing.
  //   → { txid, fee, outValue, sent }
  async function takeBack(t, priv, lock, { rate = null, quote = false, say = () => {} } = {}) {
    const op = strip(outpointOf(t, lock)), word = (h) => (/^0x[0-9a-f]{64}/i.test(String(h)) ? BigInt(String(h).slice(0, 66)) : null);
    say('Checking the lock…');
    const { lm, dep } = await lockMaker(t, priv);
    const unasked = () => { throw new Error('Bitcoin could not be asked whether this lock is still unspent, so nothing was sent. Try again in a moment.'); };
    const [minted, escrow, lockState, spentBy, known] = await Promise.all([
      t.ethCall(t.cfg.pool, '0x' + CBTC_MINTED + op).then(word, () => null), t.ethCall(t.cfg.collateralEngine, '0x' + ESCROW_TOTAL + op).then(word, () => null),
      t.cbtcLockState(lock.lockTxid, lock.lockVout).catch(() => null),
      lm.spentBy(lock.lockTxid, lock.lockVout).catch(unasked), lm.txKnown(lock.lockTxid).catch(unasked),
    ]);
    if (!known) throw Object.assign(new Error('Bitcoin does not have this lock, so there is nothing to take back.'), { refused: true });
    const R = (await redeemModule()).makeCbtcRedeem({ pool: t.pool, secp, sha256, prims: lm.prims });
    const a = R.assessUnlock({ minted: minted == null ? null : minted !== 0n, escrow, lockState, spentBy });
    if (!a.ok) throw Object.assign(new Error(sentence(a.problems[0])), { refused: true, problems: a.problems });
    const built = R.buildUnlockTx({ lock: { txid: lock.lockTxid, vout: lock.lockVout, value: Number(lock.vBtc), spk: bytesToHex(lm.ownLockScriptPubKey()) }, feeRate: rate > 0 ? rate : await lm.feeRate() });
    if (quote) return { ...built, sent: false };
    say('Sending it back to your Bitcoin address…');
    await lm.send(built.hex);
    dep.unprotectOutpoint(lock.lockTxid, lock.lockVout);
    signedDrop(lock.lockTxid);
    return { ...built, sent: true };
  }

  return { positions, nextKeyNonce, fresh, openArgs, opened, positionLeaf, repayArgs, repaid, mintArgs, lockMaker, lock, resumeLocks, takeBack };
}
