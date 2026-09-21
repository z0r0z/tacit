// Key-only recovery walks for the confidential pool. A note reaches a wallet after a wipe through exactly one of:
//   (a) a memo sealed to the wallet's own key (the normal channel), or
//   (b) a derivation the wallet can repeat from its key plus PUBLIC chain data.
// This module is channel (b): pure walkers over an already-fetched event stream (plus a few injected readers), each of
// which accepts a candidate only when the recomputed leaf / receipt / position hash equals a value the chain holds, so a
// walk never invents a note and a wrong guess is simply not found.
//
//   walkWraps          wrap deposits — deriveNote(key, asset, index), matched to the pool's public Wrap deposit ids
//   walkChange         send-and-unwrap change notes — derived from the spent parent note, matched inside the settle
//   walkBridgeMints    bridge-mint destination notes — owner from deriveNote(key, asset, index), blinding from the burn
//                      nullifier, matched to the leaf a settle appended
//   scanCbtcNotes      cBTC bearer notes — blinding from the key and the lock's funding prevout
//   deriveFarmPositions farm receipts — key and nonce from the wallet key and an anchor note, matched to Bonded events
//   walkCdpPositions   CDP positions — owner from the wallet key and a key nonce, matched to the position's settle calldata
//   openSentLocks      stealth locks the wallet sent — the sender-tail channel appended to the lock memo
//
// Deps: { pool, memo, keccak256, secp, hmac, sha256, curveOrder, lockScan, airdrop, cdp, bpp: { H, G } }.

const lc = (h) => String(h == null ? '' : h).toLowerCase();
const strip0x = (h) => String(h == null ? '' : h).replace(/^0x/, '');
const hexToBytes = (h) => Uint8Array.from((strip0x(h).match(/../g) || []).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const w32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ZERO32 = '0x' + '00'.repeat(32);

// The wallet key as 32 bytes, whatever form the caller holds it in.
export function privBytes(p) {
  if (p instanceof Uint8Array) return p;
  return hexToBytes(String(p).replace(/^0x/, '').padStart(64, '0'));
}

// The CDP position owner key for the Nth position a wallet opens against a controller — the derivation the CDP tab uses:
// HMAC(walletPriv, "tacit-cdp-position-v1" ‖ controller ‖ keyNonce_be32) reduced mod the curve order.
export function derivePositionOwnerPriv({ hmac, sha256, curveOrder }, walletPriv, controller, keyNonce) {
  const N = BigInt(curveOrder);
  const domain = new TextEncoder().encode('tacit-cdp-position-v1');
  const c = hexToBytes(controller);
  const nonceBytes = new Uint8Array(4);
  new DataView(nonceBytes.buffer).setUint32(0, keyNonce >>> 0, false);
  const msg = new Uint8Array(domain.length + c.length + 4);
  msg.set(domain); msg.set(c, domain.length); msg.set(nonceBytes, domain.length + c.length);
  const raw = hmac(sha256, privBytes(walletPriv), msg);
  let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
  b %= N;
  return '0x' + (b === 0n ? 1n : b).toString(16).padStart(64, '0');
}

export function makeConfidentialRecovery({ pool, memo, keccak256, secp, hmac, sha256, curveOrder, lockScan, airdrop, cdp, bpp }) {
  const { H, G } = bpp;
  const N = BigInt(curveOrder);
  const cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const affineHex = (P) => { const a = P.toAffine(); return { cx: w32(a.x), cy: w32(a.y) }; };

  // ── event indexes ──
  // Which transaction each leaf / nullifier arrived in, from the tx hash the log decoder carries on every event. A
  // relayed settle is one transaction, so a spend and the notes it produced share a hash.
  function txIndex(events) {
    const txOfLeaf = new Map(), leavesOfTx = new Map(), txOfNullifier = new Map(), nullifiersOfTx = new Map();
    const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
    for (const ev of events || []) {
      if (!ev || !ev.txHash) continue;
      const tx = lc(ev.txHash);
      if (ev.type === 'LeavesInserted') for (const lf of ev.leaves) { txOfLeaf.set(lc(lf), tx); push(leavesOfTx, tx, lc(lf)); }
      else if (ev.type === 'NullifiersSpent') for (const n of ev.nullifiers) { txOfNullifier.set(lc(n), tx); push(nullifiersOfTx, tx, lc(n)); }
    }
    return { txOfLeaf, leavesOfTx, txOfNullifier, nullifiersOfTx };
  }

  // ── wrap deposits ──
  // A wrap note's opening is deriveNote(key, asset, index): the wrap's public Wrap event carries depositId and the
  // amount, and depositId = keccak(asset, value, keccak(Cx, Cy, owner)), so every (index, value) the wallet could have
  // used is checked against the deposit ids the pool holds. Per index the blinding point is computed once and each
  // distinct deposited value adds its (cached) value point to it. A run of `gap` unused indexes ends the walk.
  function walkWraps({ priv, events, assets, gap = 24, maxIndex = 4096 }) {
    const byAsset = new Map();
    for (const e of events || []) {
      if (!e || e.type !== 'Wrap') continue;
      let d = byAsset.get(lc(e.assetId));
      if (!d) byAsset.set(lc(e.assetId), (d = { ids: new Set(), amounts: new Set() }));
      d.ids.add(lc(e.depositId)); d.amounts.add(BigInt(e.amount));
    }
    const found = [], scanned = [];
    for (const a of assets || []) {
      const d = byAsset.get(lc(a.assetId));
      if (!d) continue;
      const scale = BigInt(a.unitScale || 1);
      const values = [...new Set([...d.amounts].filter((x) => x > 0n && x % scale === 0n).map((x) => x / scale))];
      const Hv = new Map(values.map((v) => [v, H.multiply(v)]));
      let miss = 0, tried = 0, matched = 0;
      for (let i = 0; i <= maxIndex && miss < gap; i++) {
        tried++;
        const dn = pool.deriveNote(priv, a.assetId, i);
        const owner = pool.nkToOwner(dn.secret);
        const Gr = G.multiply(BigInt(dn.blinding));
        let hit = false;
        for (const v of values) {
          const { cx, cy } = affineHex(Hv.get(v).add(Gr));
          const depositId = pool.depositId(a.assetId, v, cx, cy, owner);
          if (!d.ids.has(lc(depositId))) continue;
          hit = true; matched++;
          found.push({ index: i, value: v, blinding: w32(dn.blinding), secret: dn.secret, asset: a.assetId, owner, cx, cy, leaf: pool.leaf(a.assetId, cx, cy, owner), depositId });
        }
        miss = hit ? 0 : miss + 1;
      }
      scanned.push({ assetId: a.assetId, ticker: a.ticker || null, deposits: d.ids.size, indexesTried: tried, matched });
    }
    return { found, scanned };
  }

  // ── send-and-unwrap change ──
  // Fields of a settle's PublicValues this walk reads: nullifiers (3), withdrawals (6), fees (7). The struct is one
  // dynamic tuple, so the encoding opens with an offset word to it; the array heads at these indexes are offsets into it.
  const hexWord = (data, byteOff) => (data.slice(byteOff * 2, byteOff * 2 + 64) || '').padEnd(64, '0');
  const u256At = (data, byteOff) => BigInt('0x' + hexWord(data, byteOff));
  function decodeExitFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const data = outer.slice(Number(u256At(outer, 0)) * 2);
    const arrayAt = (field, width, take) => {
      const off = Number(u256At(data, field * 32));
      const n = Number(u256At(data, off));
      const out = [];
      for (let i = 0; i < n; i++) out.push(take((k) => '0x' + hexWord(data, off + 32 + (i * width + k) * 32)));
      return out;
    };
    return {
      nullifiers: arrayAt(3, 1, (at) => at(0)),
      withdrawals: arrayAt(6, 3, (at) => ({ asset: at(0), value: BigInt(at(2)) })),
      fees: arrayAt(7, 2, (at) => ({ asset: at(0), value: BigInt(at(1)) })),
    };
  }

  // The change note of a send-and-unwrap is derived from the spent parent: its blinding and nullifier key are
  // deterministic in (parent blinding, parent Cx). The only unknown is the value, which is the parent value minus what
  // the settle paid out — and the payout and relay fee are public in that settle's calldata. Each (payout, fee) pair
  // gives one candidate change value; a candidate counts only when its leaf is one the same transaction inserted.
  // `parents` are notes the wallet already holds (spent or not). A found note becomes a parent in turn.
  async function walkChange({ parents, tx, knownLeaves, getTxInput, maxParents = 5000 }) {
    const found = [], skipped = [];
    const queue = [...parents];
    const seen = new Set(parents.map((p) => lc(p.leaf)));
    const inputCache = new Map();
    for (let n = 0; queue.length && n < maxParents; n++) {
      const p = queue.shift();
      const txHash = tx.txOfNullifier.get(lc(p.nullifier));
      if (!txHash) continue;
      const fresh = (tx.leavesOfTx.get(txHash) || []).filter((lf) => !knownLeaves.has(lf) && !seen.has(lf));
      if (!fresh.length) continue;
      if (!inputCache.has(txHash)) {
        let calls = null;
        try { const input = await getTxInput(txHash); calls = input ? lockScan.decodeSettleCalls(input) : null; } catch { calls = null; }
        inputCache.set(txHash, calls);
      }
      const decoded = inputCache.get(txHash);
      if (!decoded) { skipped.push({ nullifier: p.nullifier, reason: 'settle calldata unavailable' }); continue; }
      const rChange = pool.deriveOpeningNonce(p.blinding, p.cx, 'sendunwrap-change-v1');
      const nk = w32(pool.deriveOpeningNonce(p.blinding, p.cx, 'sendunwrap-change-nk-v1'));
      const owner = pool.nkToOwner(nk);
      const wantLeaf = new Set(fresh);
      const parentValue = BigInt(p.value);
      for (const call of decoded.calls) {
        let f; try { f = decodeExitFields(call.publicValues); } catch { continue; }
        if (!f.nullifiers.some((n) => lc(n) === lc(p.nullifier))) continue;
        const pays = f.withdrawals.filter((w) => lc(w.asset) === lc(p.asset)).map((w) => w.value);
        const fees = [0n, ...f.fees.filter((x) => lc(x.asset) === lc(p.asset)).map((x) => x.value)];
        for (const paid of pays) for (const fee of fees) {
          const change = parentValue - paid - fee;
          if (change <= 0n) continue;
          const { cx, cy } = pool.commitXY(change, rChange);
          const leaf = lc(pool.leaf(p.asset, cx, cy, owner));
          if (!wantLeaf.has(leaf) || seen.has(leaf)) continue;
          seen.add(leaf);
          const note = { value: change, blinding: w32(rChange), secret: nk, asset: p.asset, owner, cx, cy, leaf, parentLeaf: p.leaf };
          found.push(note); queue.push({ ...note, nullifier: pool.nativeNu(owner, nk, leaf) });
        }
      }
    }
    return { found, skipped };
  }

  // ── bridge-mint destination notes ──
  // A burn's destination note is pre-committed on Bitcoin; the mint re-creates it with owner nkToOwner(deriveNote(key,
  // asset, DEST_INDEX).secret) and blinding HMAC(key, burn nullifier) (bridge-mint-recovery.js). The burn nullifier is
  // one of the nullifiers the mint's settle recorded, so the walk tries the nullifiers of every transaction that inserted a
  // leaf nothing else explained. The value is hidden in the minted commitment, so candidate values come from `values` (a
  // caller's known amounts: a Bitcoin-side burn history, the amounts of other held notes) plus, unless `roundValues` is
  // false, every m·10^k for m < 100: the burns a wallet makes are whole-unit amounts. A candidate counts only when its leaf
  // equals one the chain inserted, so an amount outside the set is not found — never mis-found.
  // `unexplained` maps txHash -> the leaves of that transaction no other channel accounted for.
  function walkBridgeMints({ priv, tx, unexplained, assets, values = [], roundValues = true, destIndexes = 8, maxNullifiers = 16 }) {
    const p = privBytes(priv);
    const nulls = [];
    for (const [txHash, leaves] of unexplained) {
      for (const n of tx.nullifiersOfTx.get(txHash) || []) nulls.push({ n, want: new Set(leaves) });
    }
    if (nulls.length > maxNullifiers) nulls.length = maxNullifiers;
    if (!nulls.length || !(assets || []).length) return { found: [], tried: 0 };
    // Value points: caller values by multiplication; round values by repeated addition of one base per exponent.
    const points = new Map();
    for (const v of values) { const b = BigInt(v); if (b > 0n && !points.has(b)) points.set(b, H.multiply(b)); }
    if (roundValues) {
      for (let k = 0; k <= 18; k++) {
        const base = H.multiply(10n ** BigInt(k));
        let acc = base;
        for (let m = 1; m < 100; m++) { const v = BigInt(m) * 10n ** BigInt(k); if (!points.has(v)) points.set(v, acc); acc = acc.add(base); }
      }
    }
    const found = [];
    let tried = 0;
    const buf = new Uint8Array(128);
    for (const { n, want } of nulls) {
      const b = deriveBridgeMintBlinding(p, n);
      const Gb = G.multiply(b);
      const cands = [];
      for (const [v, Pv] of points) {
        const a = Pv.add(Gb).toAffine();
        const xy = new Uint8Array(64);
        xy.set(hexToBytes(a.x.toString(16).padStart(64, '0')), 0); xy.set(hexToBytes(a.y.toString(16).padStart(64, '0')), 32);
        cands.push({ v, x: a.x, y: a.y, xy });
      }
      for (const asset of assets) {
        buf.set(hexToBytes(asset.assetId).subarray(0, 32), 0);
        for (let i = 0; i < destIndexes; i++) {
          const dn = pool.deriveNote(p, asset.assetId, i);
          const owner = pool.nkToOwner(dn.secret);
          buf.set(hexToBytes(owner), 96);
          for (const c of cands) {
            tried++;
            buf.set(c.xy, 32);
            const leaf = '0x' + bytesToHex(keccak256(buf));
            if (!want.has(leaf)) continue;
            found.push({ value: c.v, blinding: w32(b), secret: dn.secret, asset: asset.assetId, owner, cx: w32(c.x), cy: w32(c.y), leaf, burnNullifier: n, destIndex: i });
          }
        }
      }
    }
    return { found, tried };
  }
  function deriveBridgeMintBlinding(privKey, nullifier) {
    const domain = new TextEncoder().encode('tacit-bridgemint-blinding-v1');
    const raw = hmac(sha256, privKey, cat([domain, hexToBytes(nullifier)]));
    let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
    b %= N;
    return b === 0n ? 1n : b;
  }

  // ── cBTC bearer notes ──
  // Blinding = HMAC(key, "tacit-cbtc-note-blinding-v1" ‖ funding prevout ‖ 0) (cbtc-note-recovery.js). `anchors` are the
  // prevouts the wallet has spent on Bitcoin (any could have funded a lock's commit tx); `locks` are the lock outpoints
  // the pool has recorded a value for (cbtcLockVBtc). A note is accepted when its leaf is in the pool tree.
  function scanCbtcNotes({ priv, anchors, locks, cbtcAsset, slotOf, rec }) {
    const p = privBytes(priv);
    const blindings = anchors.map((a) => ({ a, b: rec.deriveCbtcNoteBlinding({ privkey: p, anchorOutpoint: rec.anchorBytes(a.txid, a.vout), outputIndex: 0 }) }));
    // Every recorded lock value is tried against every anchor, and every leaf in the tree is kept (two locks of one value
    // give two notes; the leaf, not the lock, identifies a note).
    const byValue = new Map();
    for (const lock of locks) { const v = BigInt(lock.vBtc); (byValue.get(v) || byValue.set(v, []).get(v)).push(lock); }
    const found = [], seen = new Set();
    for (const [v, list] of byValue) {
      for (const { a, b } of blindings) {
        const { cx, cy } = pool.commitXY(v, b);
        const leaf = pool.leaf(cbtcAsset, cx, cy, ZERO32);
        if (seen.has(lc(leaf)) || slotOf(leaf) == null) continue;
        seen.add(lc(leaf));
        found.push({ value: v, blinding: w32(b), secret: ZERO32, asset: cbtcAsset, owner: ZERO32, cx, cy, leaf, anchor: a, lockOutpoint: list.length === 1 ? list[0].outpoint : null });
      }
    }
    return found;
  }

  // ── farm receipts ──
  // A receipt leaf is farmReceiptLeaf(manager, lpAsset, shares, owner, nonce) with owner/nonce from
  // lpBondPosition(wallet, manager, lpAsset, anchor). The manager's Bonded events publish (receipt, pid, shares), so each
  // candidate anchor note (a canonical-A note an lpBond spent, or a bonded LP-share note) is tried per pool against the
  // receipts of that pool. Returns the matches and the receipts nothing derived.
  function deriveFarmPositions({ bonded, pools, anchors, manager, lpBondPosition }) {
    const c32 = '0x' + '00'.repeat(12) + strip0x(manager).toLowerCase();
    const byPid = new Map();
    for (const b of bonded) {
      const pl = (pools || []).find((x) => Number(x.pid) === Number(b.pid));
      if (!pl) continue;
      let e = byPid.get(Number(b.pid));
      if (!e) byPid.set(Number(b.pid), (e = { lpAsset: lc(pl.lpAsset), byReceipt: new Map(), shares: new Set() }));
      e.byReceipt.set(lc(b.receipt), b); e.shares.add(BigInt(b.shares));
    }
    const matched = new Map();
    for (const a of anchors) {
      for (const e of byPid.values()) {
        const keys = lpBondPosition({ controller: manager, lpAsset: e.lpAsset, anchorLeaf: a.leaf });
        for (const s of e.shares) {
          const rl = lc(pool.farmReceiptLeaf(c32, e.lpAsset, s, keys.owner, keys.nonce));
          const b = e.byReceipt.get(rl);
          if (b && !matched.has(rl)) matched.set(rl, { receiptLeaf: rl, pid: Number(b.pid), lpAsset: e.lpAsset, shares: BigInt(b.shares), unlockAt: b.unlockAt, anchorLeaf: a.leaf });
        }
      }
    }
    const unresolved = bonded.filter((b) => !matched.has(lc(b.receipt))).map((b) => ({ receiptLeaf: lc(b.receipt), pid: Number(b.pid), shares: BigInt(b.shares) }));
    return { found: [...matched.values()], unresolved };
  }

  // ── CDP positions ──
  // A position's owner key is derivePositionOwnerPriv(wallet, controller, keyNonce), and the settle that opens it
  // publishes the owner in its CdpMint. So the walk decodes each CdpPositionInserted settle's cdpMints (PublicValues
  // field 22), matches the owner to the derived key of some keyNonce, and recomputes the position leaf from the published
  // controller / debt / rate / basket. A top-up (field 25) replaces the leaf under the same owner; its leaf is recomputed
  // from the carried owner and the new basket. Key nonces are tried up to `gap` past the last one that matched.
  function decodeCdpFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const data = outer.slice(Number(u256At(outer, 0)) * 2);
    const legsAt = (base, headOff) => {
      const off = base + Number(u256At(data, base + headOff * 32));
      const n = Number(u256At(data, off));
      const out = [];
      for (let i = 0; i < n; i++) out.push({ asset: '0x' + hexWord(data, off + 32 + i * 64), value: u256At(data, off + 32 + i * 64 + 32) });
      return out;
    };
    const dynArray = (field, take) => {
      const arr = Number(u256At(data, field * 32));
      const n = Number(u256At(data, arr));
      const out = [];
      for (let i = 0; i < n; i++) out.push(take(arr + 32 + Number(u256At(data, arr + 32 + i * 32))));
      return out;
    };
    return {
      mints: dynArray(22, (at) => ({
        controller: '0x' + hexWord(data, at).slice(24), debtAsset: '0x' + hexWord(data, at + 32), debtValue: u256At(data, at + 64),
        positionLeaf: '0x' + hexWord(data, at + 96), rateSnapshot: '0x' + hexWord(data, at + 128), legs: legsAt(at, 5), owner: '0x' + hexWord(data, at + 192),
      })),
      topups: dynArray(25, (at) => ({
        controller: '0x' + hexWord(data, at).slice(24), debtValue: u256At(data, at + 32), rateSnapshot: '0x' + hexWord(data, at + 64),
        oldPositionNullifier: '0x' + hexWord(data, at + 96), newPositionLeaf: '0x' + hexWord(data, at + 128), oldLegs: legsAt(at, 5), newLegs: legsAt(at, 6),
      })),
    };
  }

  async function walkCdpPositions({ priv, controller, positionEvents, getTxInput, positionIndexOf, gap = 20, maxNonce = 512 }) {
    const owners = new Map(); // owner x-only → keyNonce
    const derive = (k) => {
      const ownerPriv = derivePositionOwnerPriv({ hmac, sha256, curveOrder }, priv, controller, k);
      const owner = '0x' + bytesToHex(secp.getPublicKey(hexToBytes(ownerPriv), true).subarray(1));
      owners.set(lc(owner), { keyNonce: k, ownerPriv, owner });
    };
    let nextDerived = 0;
    const ensure = (upTo) => { for (; nextDerived <= upTo && nextDerived <= maxNonce; nextDerived++) derive(nextDerived); };
    ensure(gap);
    const debtAsset = cdp.debtAssetId(controller);
    const leafOf = (c, d, owner, debtValue, rate, legs) => {
      const sorted = [...legs].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : BigInt(a.asset) > BigInt(b.asset) ? 1 : 0));
      return cdp.positionLeaf(c, d, cdp.basketRoot(sorted.map((l) => cdp.basketLeg(l.asset, BigInt(l.value)))), BigInt(debtValue), rate, owner, ZERO32);
    };
    const lineage = new Map(); // current live leaf lc → position record
    const positions = [];
    const seenTx = new Set();
    let farthest = -1;
    for (const ev of positionEvents) {
      const txHash = lc(ev.txHash);
      if (!txHash || seenTx.has(txHash)) continue;
      seenTx.add(txHash);
      let calls = null;
      try { const input = await getTxInput(txHash); calls = input ? lockScan.decodeSettleCalls(input) : null; } catch { calls = null; }
      if (!calls) continue;
      for (const call of calls.calls) {
        let f; try { f = decodeCdpFields(call.publicValues); } catch { continue; }
        for (const m of f.mints) {
          if (lc(m.controller) !== lc(controller)) continue;
          const mine = owners.get(lc(m.owner));
          if (!mine) continue;
          const legs = m.legs.map((l) => ({ asset: l.asset, value: l.value.toString() }));
          if (lc(leafOf(controller, debtAsset, m.owner, m.debtValue, m.rateSnapshot, legs)) !== lc(m.positionLeaf)) continue;
          const rec = { controller, keyNonce: mine.keyNonce, positionOwner: mine.owner, positionOwnerPriv: mine.ownerPriv, debtValue: m.debtValue.toString(), nonce: ZERO32, rateSnapshot: m.rateSnapshot, basket: legs, positionLeaf: m.positionLeaf, openedIn: txHash };
          positions.push(rec); lineage.set(lc(m.positionLeaf), rec);
          farthest = Math.max(farthest, mine.keyNonce); ensure(farthest + gap);
        }
        for (const t of f.topups) {
          const prevLeaf = [...lineage.keys()].find((l) => lc(cdp.positionNullifier(l)) === lc(t.oldPositionNullifier));
          if (!prevLeaf) continue;
          const prev = lineage.get(prevLeaf);
          const legs = t.newLegs.map((l) => ({ asset: l.asset, value: l.value.toString() }));
          if (lc(leafOf(controller, debtAsset, prev.positionOwner, t.debtValue, t.rateSnapshot, legs)) !== lc(t.newPositionLeaf)) continue;
          lineage.delete(prevLeaf);
          const rec = { ...prev, basket: legs, debtValue: t.debtValue.toString(), rateSnapshot: t.rateSnapshot, positionLeaf: t.newPositionLeaf, openedIn: txHash };
          positions.push(rec); lineage.set(lc(t.newPositionLeaf), rec);
        }
      }
    }
    // The position tree index of each surviving leaf (the CdpPositionInserted order).
    const live = positions.filter((r) => lineage.get(lc(r.positionLeaf)) === r);
    for (const r of positions) r.positionIndex = positionIndexOf ? positionIndexOf(r.positionLeaf) : null;
    return { positions: live, allOpened: positions, nextKeyNonce: farthest + 1 };
  }
  // ── stealth locks the wallet sent ──
  // The lock memo the sender publishes is the recipient's memo followed by a tail sealed to the sender's own key. Open
  // each lock's tail with that key; the lock leaf authenticates the result.
  function openSentLocks({ senderPriv, lockLeaves, lockMemos }) {
    const RECIPIENT_MEMO = 33 + 112;
    const out = [];
    for (let i = 0; i < lockLeaves.length; i++) {
      const m = lockMemos[i];
      if (!m) continue;
      const b = hexToBytes(m);
      if (b.length < RECIPIENT_MEMO + 177) continue;
      const opened = airdrop.openStealthSenderTail({ senderPriv, ephemeralPub: '0x' + bytesToHex(b.subarray(0, 33)), leaf: lockLeaves[i], tailHex: '0x' + bytesToHex(b.subarray(RECIPIENT_MEMO)) });
      if (opened) out.push({ ...opened, leaf: lockLeaves[i], lIndex: i, ephemeralPub: '0x' + bytesToHex(b.subarray(0, 33)) });
    }
    return out;
  }

  return { txIndex, walkWraps, decodeExitFields, walkChange, walkBridgeMints, deriveBridgeMintBlinding, scanCbtcNotes, deriveFarmPositions, decodeCdpFields, walkCdpPositions, openSentLocks };
}
