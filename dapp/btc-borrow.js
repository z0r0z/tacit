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
export function lockPad(recommended, estimates) {
  const rate = Math.max(1, Math.ceil(recommended?.fastestFee || estimates?.['1'] || estimates?.['2'] || 5)), fee = (vb) => Math.max(500, vb * rate);
  return BigInt(Math.ceil((546 + fee(200) + fee(11 + 2 * 68 + 43 + 31)) * 1.1));
}
export const bondCall = (t, lock) => ({ to: ESCROW, data: '0x' + POST_ESCROW_WITH_ETH + strip(outpointOf(t, lock)) });

const strip = (h) => String(h).replace(/^0x/, '');
const ZERO = '0x' + '0'.repeat(64);

export function makeLoans({ sha256, hmac, secp, bytesToHex, hexToBytes, pubHex, noteRecovery = () => import('/cbtc-note-recovery.js'),
  lockModule = () => import('/cbtc-lock-mint.js?cb=b746689c'), deployments = () => import('/confidential-deployments.js') }) {
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
  async function lock(t, priv, { sats, unconfirmed = [], say = () => {} }) {
    say('Checking which of your outputs are already locks…');
    await t.syncCbtcLockReservations(priv);
    const { lm, dep } = await lockMaker(t, priv, unconfirmed);
    say('Signing and broadcasting your lock…');
    const res = await lm.lock({ amountSats: sats });
    dep.protectOutpoint(res.lockTxid, res.lockVout, res.vBtc);
    return { ...res, record: { lockTxid: res.lockTxid, lockVout: res.lockVout, vBtc: String(res.vBtc), anchor: { txid: res.anchor.txid, vout: res.anchor.vout }, at: Date.now() } };
  }

  return { positions, nextKeyNonce, fresh, openArgs, opened, positionLeaf, repayArgs, repaid, mintArgs, lockMaker, lock };
}
