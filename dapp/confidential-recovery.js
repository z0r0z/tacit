
import { makeBridgeMintRecovery } from './bridge-mint-recovery.js';

const lc = (h) => String(h == null ? '' : h).toLowerCase();
const strip0x = (h) => String(h == null ? '' : h).replace(/^0x/, '');
const hexToBytes = (h) => Uint8Array.from((strip0x(h).match(/../g) || []).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const w32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ZERO32 = '0x' + '00'.repeat(32);

export function privBytes(p) {
  if (p instanceof Uint8Array) return p;
  return hexToBytes(String(p).replace(/^0x/, '').padStart(64, '0'));
}

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

export const OUTPUT_ROLES = Object.freeze(['send', 'change', 'lpShare', 'lpOut', 'swapOut', 'harvest', 'harvestNonce', 'unbond', 'cdpDebt', 'cdpRelease', 'claim', 'refund', 'exit', 'receive']);

export function deriveOutputKeys({ hmac, sha256, curveOrder }, walletPriv, anchor, role, index = 0) {
  if (!OUTPUT_ROLES.includes(role)) throw new Error(`deriveOutputKeys: unknown role "${role}"`);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > 0xffffffff) throw new Error('deriveOutputKeys: index must be a uint32');
  const hex = strip0x(anchor);
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error('deriveOutputKeys: anchor must be a 32-byte hex value');
  const a = hexToBytes(hex.padStart(64, '0'));
  const roleB = new TextEncoder().encode(role);
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, i, false);
  const tail = new Uint8Array(32 + 1 + roleB.length + 4);
  tail.set(a); tail[32] = roleB.length; tail.set(roleB, 33); tail.set(idx, 33 + roleB.length);
  const N = BigInt(curveOrder);
  const key = privBytes(walletPriv);
  const one = (domain) => {
    const d = new TextEncoder().encode(domain);
    const msg = new Uint8Array(d.length + tail.length);
    msg.set(d); msg.set(tail, d.length);
    let b = 0n; for (const x of hmac(sha256, key, msg)) b = (b << 8n) | BigInt(x);
    b %= N;
    return b === 0n ? 1n : b;
  };
  const nk = one('tacit-out-nk-v1');
  const r = one('tacit-out-r-v1');
  return { nk: w32(nk), blinding: r, blindingHex: w32(r) };
}

export function roundAmounts(max = (1n << 64n) - 1n) {
  const out = new Set();
  for (let k = 0n, p = 1n; p <= max; k++, p *= 10n) for (let m = 1n; m < 100n; m++) if (m * p <= max) out.add(m * p);
  return [...out];
}

export function makeConfidentialRecovery({ pool, memo, keccak256, secp, hmac, sha256, curveOrder, lockScan, airdrop, cdp, bpp }) {
  const { H, G } = bpp;
  const N = BigInt(curveOrder);
  const cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const affineHex = (P) => { const a = P.toAffine(); return { cx: w32(a.x), cy: w32(a.y) }; };
  // A message to oneself yields like a timer but is not slowed to a second a turn in a background tab.
  const handBack = () => new Promise((r) => { if (typeof MessageChannel === 'undefined') return setTimeout(r, 0); const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

  function txIndex(events) {
    const txOfLeaf = new Map(), leavesOfTx = new Map(), txOfNullifier = new Map(), nullifiersOfTx = new Map(), order = new Map();
    const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
    for (const ev of events || []) {
      if (!ev || !ev.txHash) continue;
      const tx = lc(ev.txHash);
      if (!order.has(tx)) order.set(tx, order.size);
      if (ev.type === 'LeavesInserted') for (const lf of ev.leaves) { txOfLeaf.set(lc(lf), tx); push(leavesOfTx, tx, lc(lf)); }
      else if (ev.type === 'NullifiersSpent') for (const n of ev.nullifiers) { txOfNullifier.set(lc(n), tx); push(nullifiersOfTx, tx, lc(n)); }
    }
    return { txOfLeaf, leavesOfTx, txOfNullifier, nullifiersOfTx, order };
  }

  // The walk is written as steps (one per index tried) so it can run to the end at once, `walkWraps`, or in slices that hand the thread back, `walkWrapsSliced`.
  function* walkWrapsSteps({ priv, events, assets, gap = 24, maxIndex = 4096, minIndex = 0 }) {
    const floorFor = (assetId) => {
      const n = Number(typeof minIndex === 'function' ? minIndex(assetId) : minIndex);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), maxIndex) : 0;
    };
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
      const floor = floorFor(a.assetId);
      let miss = 0, tried = 0, matched = 0, lastMatch = -1;
      for (let i = 0; i <= maxIndex && (miss < gap || i <= floor); i++) {
        tried++;
        const dn = pool.deriveNote(priv, a.assetId, i);
        const owner = pool.nkToOwner(dn.secret);
        const Gr = G.multiply(BigInt(dn.blinding));
        let hit = false;
        for (const v of values) {
          const { cx, cy } = affineHex(Hv.get(v).add(Gr));
          const depositId = pool.depositId(a.assetId, v, cx, cy, owner);
          if (!d.ids.has(lc(depositId))) continue;
          hit = true; matched++; lastMatch = i;
          found.push({ index: i, value: v, blinding: w32(dn.blinding), secret: dn.secret, asset: a.assetId, owner, cx, cy, leaf: pool.leaf(a.assetId, cx, cy, owner), depositId });
        }
        miss = hit ? 0 : miss + 1;
        yield;
      }
      const scannedThrough = tried - 1;
      scanned.push({
        assetId: a.assetId, ticker: a.ticker || null, deposits: d.ids.size, indexesTried: tried, matched,
        minIndex: floor, scannedThrough, lastMatch,
        stoppedOnGap: miss >= gap && scannedThrough < maxIndex, stoppedAtMaxIndex: scannedThrough >= maxIndex,
      });
    }
    return { found, scanned };
  }
  function walkWraps(args) {
    const g = walkWrapsSteps(args);
    for (let r = g.next(); ; r = g.next()) if (r.done) return r.value;
  }
  async function walkWrapsSliced(args, { sliceMs = 12 } = {}) {
    const g = walkWrapsSteps(args);
    let t0 = Date.now();
    for (let r = g.next(); ; r = g.next()) {
      if (r.done) return r.value;
      if (Date.now() - t0 > sliceMs) { await handBack(); t0 = Date.now(); }
    }
  }

  const hexWord = (data, byteOff) => (data.slice(byteOff * 2, byteOff * 2 + 64) || '').padEnd(64, '0');
  const u256At = (data, byteOff) => BigInt('0x' + hexWord(data, byteOff));
  const OUTPUT_FIELD_CAP = 4096;
  function decodeExitFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const data = outer.slice(Number(u256At(outer, 0)) * 2);
    const arrayAt = (field, width, take) => {
      const off = Number(u256At(data, field * 32));
      const n = Number(u256At(data, off));
      if (n > OUTPUT_FIELD_CAP) throw new Error('settle array out of range');
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

  const FIELD_P = 2n ** 256n - 0x1000003d1n;
  const _fieldInv = (x) => { let a = ((x % FIELD_P) + FIELD_P) % FIELD_P, m = FIELD_P, u = 1n, v = 0n; while (a) { const q = m / a; [a, m] = [m - q * a, a]; [u, v] = [v - q * u, u]; } return ((v % FIELD_P) + FIELD_P) % FIELD_P; };
function _be32(x, out, off) { const dv = new DataView(out.buffer, out.byteOffset + off, 32); for (let j = 24; j >= 0; j -= 8) { dv.setBigUint64(j, x & 0xffffffffffffffffn); x >>= 64n; } }
function _toAffineBatch(ps) {
    if (!ps.length || ps.some((q) => typeof q.pz !== 'bigint' || q.pz === 0n)) return ps.map((q) => q.toAffine());
    const pre = new Array(ps.length);
    let acc = 1n;
    for (let k = 0; k < ps.length; k++) { pre[k] = acc; acc = (acc * ps[k].pz) % FIELD_P; }
    let inv = _fieldInv(acc);
    const out = new Array(ps.length);
    for (let k = ps.length - 1; k >= 0; k--) {
      const zi = (inv * pre[k]) % FIELD_P;
      inv = (inv * ps[k].pz) % FIELD_P;
      out[k] = { x: (ps[k].px * zi) % FIELD_P, y: (ps[k].py * zi) % FIELD_P };
    }
    return out;
  }

  async function walkBridgeMints({ priv, tx, unexplained, assets, values = [], roundValues = true, destIndexes = 8, maxNullifiers = 16, maxExp = 18 }) {
    const p = privBytes(priv);
    const groups = [];
    for (const [txHash, leaves] of unexplained) {
      const ns = tx.nullifiersOfTx.get(txHash) || [];
      if (ns.length) groups.push({ txHash, ns, want: new Set(leaves) });
    }
    groups.reverse();
    const nulls = [], searched = new Set();
    let oversize = null;
    for (const g of groups) {
      if (nulls.length + g.ns.length > maxNullifiers) { oversize = oversize || g; continue; }
      for (const n of g.ns) nulls.push({ n, want: g.want });
      searched.add(g.txHash);
    }
    if (!nulls.length && oversize) { for (const n of oversize.ns) nulls.push({ n, want: oversize.want }); searched.add(oversize.txHash); }
    if (!nulls.length || !(assets || []).length) return { found: [], tried: 0, searched };
    // the thread is handed back every few milliseconds, also while the value points are made (about 1,900 point additions) and added to each
    // blinding below, so no stretch of this search holds it for a third of a second
    let t0 = Date.now();
    const breathe = async () => { if (Date.now() - t0 > 12) { await handBack(); t0 = Date.now(); } };
    const points = new Map();
    for (const v of values) { const b = BigInt(v); if (b > 0n && !points.has(b)) points.set(b, H.multiply(b)); }
    if (roundValues) {
      for (let k = 0; k <= maxExp; k++) {
        await breathe();
        const base = H.multiply(10n ** BigInt(k));
        let acc = base;
        for (let m = 1; m < 100; m++) { const v = BigInt(m) * 10n ** BigInt(k); if (!points.has(v)) points.set(v, acc); acc = acc.add(base); if (m % 16 === 0) await breathe(); }
      }
    }
    const found = [];
    let tried = 0;
    const buf = new Uint8Array(128);
    const owners = assets.map((asset) => ({ asset, idBytes: hexToBytes(asset.assetId).subarray(0, 32), notes: Array.from({ length: destIndexes }, (_, i) => {
      const dn = pool.deriveNote(p, asset.assetId, i); const owner = pool.nkToOwner(dn.secret);
      return { i, secret: dn.secret, owner, ownerBytes: hexToBytes(owner) };
    }) }));
    const pts = [...points];
    const same = (d, w) => { for (let j = 0; j < 32; j++) if (d[j] !== w[j]) return false; return true; };
    for (const { n, want } of nulls) {
      await breathe();
      const b = deriveBridgeMintBlinding(p, n);
      const Gb = G.multiply(b);
      const wanted = [...want].map((w) => hexToBytes(w));
      const sums = [];
      for (const [, Pv] of pts) { sums.push(Pv.add(Gb)); if (sums.length % 32 === 0) await breathe(); }
      const cands = _toAffineBatch(sums).map((a, k) => {
        const xy = new Uint8Array(64);
        _be32(a.x, xy, 0); _be32(a.y, xy, 32);
        return { v: pts[k][0], x: a.x, y: a.y, xy };
      });
      for (const { asset, idBytes, notes } of owners) {
        buf.set(idBytes, 0);
        for (const dn of notes) {
          await breathe();
          buf.set(dn.ownerBytes, 96);
          for (const c of cands) {
            tried++;
            buf.set(c.xy, 32);
            const d = keccak256(buf);
            if (!wanted.some((w) => same(d, w))) continue;
            found.push({ value: c.v, blinding: w32(b), secret: dn.secret, asset: asset.assetId, owner: dn.owner, cx: w32(c.x), cy: w32(c.y), leaf: '0x' + bytesToHex(d), burnNullifier: n, destIndex: dn.i });
          }
        }
      }
    }
    return { found, tried, searched };
  }
  const _bridgeMintRecovery = makeBridgeMintRecovery({ hmac, sha256, curveOrder });
  const deriveBridgeMintBlinding = (privKey, nullifier) => _bridgeMintRecovery.deriveBridgeMintBlinding({ privkey: privKey, nullifier });

  function scanCbtcNotes({ priv, anchors, locks, cbtcAsset, slotOf, rec }) {
    const p = privBytes(priv);
    const blindings = anchors.map((a) => ({ a, b: rec.deriveCbtcNoteBlinding({ privkey: p, anchorOutpoint: rec.anchorBytes(a.txid, a.vout), outputIndex: 0 }) }));
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

  function decodeCdpFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const data = outer.slice(Number(u256At(outer, 0)) * 2);
    const legsAt = (base, headOff) => {
      const off = base + Number(u256At(data, base + headOff * 32));
      const n = Number(u256At(data, off));
      if (n > OUTPUT_FIELD_CAP) throw new Error('settle array out of range');
      const out = [];
      for (let i = 0; i < n; i++) out.push({ asset: '0x' + hexWord(data, off + 32 + i * 64), value: u256At(data, off + 32 + i * 64 + 32) });
      return out;
    };
    const dynArray = (field, take) => {
      const arr = Number(u256At(data, field * 32));
      const n = Number(u256At(data, arr));
      if (n > OUTPUT_FIELD_CAP) throw new Error('settle array out of range');
      const out = [];
      for (let i = 0; i < n; i++) out.push(take(arr + 32 + Number(u256At(data, arr + 32 + i * 32))));
      return out;
    };
    return {
      mints: dynArray(22, (at) => ({
        controller: '0x' + hexWord(data, at).slice(24), debtAsset: '0x' + hexWord(data, at + 32), debtValue: u256At(data, at + 64),
        positionLeaf: '0x' + hexWord(data, at + 96), rateSnapshot: '0x' + hexWord(data, at + 128), legs: legsAt(at, 5), owner: '0x' + hexWord(data, at + 192),
      })),
      closes: (() => {
        try {
          return dynArray(23, (at) => ({
            controller: '0x' + hexWord(data, at).slice(24), debtValue: u256At(data, at + 32), repaid: u256At(data, at + 64), rateSnapshot: '0x' + hexWord(data, at + 96),
            positionNullifier: '0x' + hexWord(data, at + 128), legs: legsAt(at, 5),
          }));
        } catch { return []; }
      })(),
      topups: dynArray(25, (at) => ({
        controller: '0x' + hexWord(data, at).slice(24), debtValue: u256At(data, at + 32), rateSnapshot: '0x' + hexWord(data, at + 64),
        oldPositionNullifier: '0x' + hexWord(data, at + 96), newPositionLeaf: '0x' + hexWord(data, at + 128), oldLegs: legsAt(at, 5), newLegs: legsAt(at, 6),
      })),
    };
  }

  async function walkCdpPositions({ priv, controller, positionEvents, getTxInput, positionIndexOf, gap = 20, maxNonce = 512 }) {
    const owners = new Map();
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
    const lineage = new Map();
    const positions = [];
    const skipped = [];
    const seenTx = new Set();
    let farthest = -1;
    for (const ev of positionEvents) {
      const txHash = lc(ev.txHash);
      if (!txHash || seenTx.has(txHash)) continue;
      seenTx.add(txHash);
      let calls = null;
      try { const input = await getTxInput(txHash); calls = input ? lockScan.decodeSettleCalls(input) : null; } catch { calls = null; }
      if (!calls) { skipped.push({ txHash, reason: 'settle calldata unavailable' }); continue; }
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
    const live = positions.filter((r) => lineage.get(lc(r.positionLeaf)) === r);
    for (const r of positions) r.positionIndex = positionIndexOf ? positionIndexOf(r.positionLeaf) : null;
    return { positions: live, allOpened: positions, nextKeyNonce: farthest + 1, skipped };
  }
  const MAX_U64 = (1n << 64n) - 1n;
  const keyDeps = { hmac, sha256, curveOrder };
  let _round = null;
  const _hCache = new Map();
  const roundTable = () => {
    if (_round) return _round;
    _round = new Map();
    for (let p = 1n; p <= MAX_U64; p *= 10n) {
      const base = H.multiply(p);
      let acc = base;
      for (let m = 1n; m < 100n; m++) { const v = m * p; if (v <= MAX_U64 && !_round.has(v)) _round.set(v, acc); acc = acc.add(base); }
    }
    return _round;
  };
  const hPoint = (v) => {
    const r = _round && _round.get(v);
    if (r) return r;
    let c = _hCache.get(v);
    if (!c) _hCache.set(v, (c = H.multiply(v)));
    return c;
  };
  const putWord = (buf, off, n) => { const h = n.toString(16).padStart(64, '0'); for (let i = 0; i < 32; i++) buf[off + i] = parseInt(h.substr(i * 2, 2), 16); };

  function netCandidates(base) {
    base = BigInt(base);
    if (base <= 0n || base > MAX_U64) return [];
    const Hb = hPoint(base);
    const out = [{ v: base, P: Hb }];
    for (const [f, Pf] of roundTable()) if (f < base) out.push({ v: base - f, P: Hb.add(Pf.negate()) });
    return out;
  }

  function tryDerived({ priv, anchor, role, index = 0, assets, values, want }) {
    const k = deriveOutputKeys(keyDeps, priv, anchor, role, index);
    const owner = pool.nkToOwner(k.nk);
    const Gr = G.multiply(k.blinding);
    const buf = new Uint8Array(128);
    buf.set(hexToBytes(owner), 96);
    const assetBytes = assets.map((a) => [a, hexToBytes(w32(a))]);
    const out = [];
    for (const c of values) {
      const v = typeof c === 'bigint' ? c : c.v;
      if (v <= 0n || v > MAX_U64) continue;
      const a = (typeof c === 'bigint' ? hPoint(v) : c.P).add(Gr).toAffine();
      putWord(buf, 32, a.x); putWord(buf, 64, a.y);
      for (const [asset, ab] of assetBytes) {
        buf.set(ab, 0);
        const leaf = '0x' + bytesToHex(keccak256(buf));
        if (want(leaf)) out.push({ value: v, blinding: k.blindingHex, secret: k.nk, asset, owner, cx: w32(a.x), cy: w32(a.y), leaf, role, index, anchor });
      }
    }
    return out;
  }

  function decodeOutputFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const data = outer.slice(Number(u256At(outer, 0)) * 2);
    const arrayAt = (field, width, take) => {
      const off = Number(u256At(data, field * 32));
      const n = Number(u256At(data, off));
      if (n > OUTPUT_FIELD_CAP) throw new Error('settle array out of range');
      const out = [];
      for (let i = 0; i < n; i++) out.push(take((k) => '0x' + hexWord(data, off + 32 + (i * width + k) * 32)));
      return out;
    };
    const big = (h) => BigInt(h);
    const cdpF = decodeCdpFields(publicValuesHex);
    return {
      nullifiers: arrayAt(3, 1, (at) => at(0)),
      deposits: arrayAt(5, 1, (at) => at(0)),
      withdrawals: arrayAt(6, 3, (at) => ({ asset: at(0), value: big(at(2)) })),
      fees: arrayAt(7, 2, (at) => ({ asset: at(0), value: big(at(1)) })),
      swaps: arrayAt(13, 7, (at) => ({ poolId: at(0), aPre: big(at(1)), bPre: big(at(2)), aPost: big(at(3)), bPost: big(at(4)), cutA: big(at(5)), cutB: big(at(6)) })),
      liquidity: arrayAt(14, 7, (at) => ({ poolId: at(0), aPre: big(at(1)), bPre: big(at(2)), sharesPre: big(at(3)), aPost: big(at(4)), bPost: big(at(5)), sharesPost: big(at(6)) })),
      lockNullifiers: arrayAt(18, 1, (at) => at(0)),
      mints: cdpF.mints, closes: cdpF.closes, topups: cdpF.topups,
    };
  }

  function publicAmounts(f) {
    const D = new Set(), F = new Set(), assets = new Set();
    const absd = (a, b) => (a > b ? a - b : b - a);
    for (const w of f.withdrawals) { D.add(w.value); assets.add(lc(w.asset)); }
    for (const x of f.fees) { F.add(x.value); assets.add(lc(x.asset)); }
    for (const s of f.swaps) { D.add(absd(s.aPre, s.aPost)); D.add(absd(s.bPre, s.bPost)); F.add(s.cutA); F.add(s.cutB); }
    for (const l of f.liquidity) { D.add(absd(l.aPre, l.aPost)); D.add(absd(l.bPre, l.bPost)); D.add(absd(l.sharesPre, l.sharesPost)); }
    for (const m of f.mints) { D.add(m.debtValue); assets.add(lc(m.debtAsset)); for (const l of m.legs) { D.add(l.value); assets.add(lc(l.asset)); } }
    for (const c of f.closes) { D.add(c.debtValue); D.add(c.repaid); for (const l of c.legs) { D.add(l.value); assets.add(lc(l.asset)); } }
    D.delete(0n); F.delete(0n);
    return { D: [...D], F: [...F], assets: [...assets] };
  }

  const TX_ROLES = [['change', [0, 1]], ['send', [0]], ['exit', [0]], ['lpShare', [0]], ['lpOut', [0, 1]], ['swapOut', [0]], ['cdpDebt', [0]], ['cdpRelease', [0, 1, 2, 3]]];

  async function walkDerivedOutputs({ priv, parents = [], deposits = [], tx, knownLeaves, getTxInput, assets = [], lpShareOf = null, roundValues = true, maxTxs = 4000 }) {
    const found = [], skipped = [];
    const seen = new Set([...(knownLeaves || [])].map(lc));
    const decoded = new Map();
    const decodeTx = async (h) => {
      if (!decoded.has(h)) {
        let calls = null;
        try { const input = await getTxInput(h); calls = input ? lockScan.decodeSettleCalls(input) : null; } catch { calls = null; }
        decoded.set(h, calls);
      }
      return decoded.get(h);
    };
    const pending = new Map();
    const enqueue = (h, a) => { if (!h) return; let l = pending.get(h); if (!l) pending.set(h, (l = [])); l.push(a); };
    for (const p of parents) enqueue(tx.txOfNullifier.get(lc(p.nullifier)), { anchor: p.nullifier, asset: p.asset, value: BigInt(p.value), kind: 'nullifier' });
    for (const d of deposits) if (d.txHash) enqueue(lc(d.txHash), { anchor: d.depositId, asset: d.asset, value: BigInt(d.value), kind: 'deposit' });
    const ord = (h) => (tx.order && tx.order.has(h) ? tx.order.get(h) : Infinity);
    for (let n = 0; pending.size && n < maxTxs; n++) {
      let h = null;
      for (const k of pending.keys()) if (h === null || ord(k) < ord(h)) h = k;
      const anchors = pending.get(h); pending.delete(h);
      const fresh = (tx.leavesOfTx.get(h) || []).filter((lf) => !seen.has(lf));
      if (!fresh.length) continue;
      const calls = await decodeTx(h);
      if (!calls) { skipped.push({ txHash: h, reason: 'settle calldata unavailable' }); continue; }
      const want = new Set(fresh);
      const wanted = (lf) => want.has(lf) && !seen.has(lf);
      const searchRound = roundValues && !(tx.leavesOfTx.get(h) || []).some((lf) => seen.has(lf));
      for (const call of calls.calls) {
        let f; try { f = decodeOutputFields(call.publicValues); } catch { continue; }
        const mine = anchors.filter((a) => (a.kind === 'deposit' ? f.deposits : f.nullifiers).some((x) => lc(x) === lc(a.anchor)));
        if (!mine.length) continue;
        const { D, F, assets: named } = publicAmounts(f);
        const D0 = [0n, ...D], F0 = [0n, ...F];
        const lpAssets = lpShareOf ? f.liquidity.map((l) => lpShareOf(l.poolId)) : [];
        const outAssets = [...new Set([...assets, ...named, ...lpAssets].map(lc))];
        const parentValues = new Map();
        for (const a of mine) { const k = lc(a.asset); if (!parentValues.has(k)) parentValues.set(k, []); parentValues.get(k).push(a.value); }
        for (const a of mine) {
          const groups = [...parentValues].map(([asset, vals]) => ({ asset, vals, psum: vals.reduce((x, y) => x + y, 0n) }));
          const gen = {
            change: () => groups.map((g) => {
              const vs = new Set();
              for (const p of new Set([...g.vals, g.psum])) for (const d of D0) for (const fe of F0) { const v = p - d - fe; if (v > 0n) vs.add(v); }
              return { assets: [g.asset], values: [...vs] };
            }),
            send: () => groups.map((g) => {
              const vs = new Set(F0.map((fe) => g.psum - fe).filter((v) => v > 0n));
              if (searchRound) for (const v of roundTable().keys()) if (v < g.psum) vs.add(v);
              return { assets: [g.asset], values: [...vs] };
            }),
            exit: () => groups.map((g) => ({ assets: [g.asset], values: F0.map((fe) => g.psum - fe).filter((v) => v > 0n) })),
            lpShare: () => [{ assets: lpAssets, values: pubOut(D, F0) }],
            lpOut: () => [{ assets: outAssets, values: pubOut(D, F0) }],
            swapOut: () => [{ assets: outAssets, values: pubOut(D, F0) }],
            cdpDebt: () => [{ assets: outAssets, values: pubOut(D, F0) }],
            cdpRelease: () => [{ assets: outAssets, values: pubOut(D, F0) }],
          };
          for (const [role, indexes] of TX_ROLES) {
            for (const g of gen[role]()) {
              if (!g.assets.length || !g.values.length) continue;
              for (const index of indexes) {
                if (![...want].some((lf) => !seen.has(lf))) break;
                const hits = tryDerived({ priv, anchor: a.anchor, role, index, assets: g.assets, values: g.values, want: wanted });
                if (role === 'send') {
                  const grp = groups.find((x) => lc(x.asset) === lc(g.assets[0]));
                  for (const hit of [...hits]) hits.push(...tryDerived({ priv, anchor: a.anchor, role: 'change', index: 0, assets: g.assets, values: F0.map((fe) => grp.psum - fe - hit.value), want: wanted }));
                }
                for (const hit of hits) {
                  if (seen.has(lc(hit.leaf))) continue;
                  seen.add(lc(hit.leaf));
                  found.push({ ...hit, txHash: h });
                  const nu = pool.nativeNu(hit.owner, hit.secret, hit.leaf);
                  enqueue(tx.txOfNullifier.get(lc(nu)), { anchor: nu, asset: hit.asset, value: hit.value, kind: 'nullifier' });
                }
              }
            }
          }
        }
      }
    }
    return { found, skipped };
  }
  const pubOut = (D, F0) => {
    const vs = new Set();
    for (const d of D) for (const fe of F0) { const v = d - fe; if (v > 0n) vs.add(v); }
    return [...vs];
  };

  function walkDirectOutputs({ priv, jobs, isLeaf, known }) {
    const found = [];
    for (const j of jobs) {
      const hits = tryDerived({ priv, anchor: j.anchor, role: j.role, index: j.index || 0, assets: j.assets, values: j.values, want: (lf) => isLeaf(lf) && !(known && known.has(lc(lf))) });
      for (const h of hits) found.push({ ...h, ...(j.meta || {}) });
    }
    return { found };
  }

  async function locateDepositTx({ deposits, events, getTxInput, maxTxs = 64, perDeposit = 24 }) {
    const evs = events || [];
    const wrapAt = new Map();
    evs.forEach((e, i) => { if (e && e.type === 'Wrap') wrapAt.set(lc(e.depositId), i); });
    const consumedBy = new Map();
    let fetched = 0;
    const idsOf = async (h) => {
      if (consumedBy.has(h)) return consumedBy.get(h);
      if (fetched >= maxTxs) return null;
      fetched++;
      let ids = null;
      try {
        const input = await getTxInput(h);
        const calls = input ? lockScan.decodeSettleCalls(input) : null;
        if (calls) { ids = new Set(); for (const c of calls.calls) { try { for (const d of decodeOutputFields(c.publicValues).deposits) ids.add(lc(d)); } catch { } } }
      } catch { ids = null; }
      consumedBy.set(h, ids);
      return ids;
    };
    const out = new Map();
    for (const d of deposits) {
      const at = wrapAt.get(lc(d.depositId));
      if (at == null) continue;
      const tried = new Set();
      for (let i = at; i < evs.length && tried.size < perDeposit; i++) {
        const e = evs[i];
        if (!e || e.type !== 'LeavesInserted' || !e.txHash) continue;
        const h = lc(e.txHash);
        if (tried.has(h)) continue;
        tried.add(h);
        const ids = await idsOf(h);
        if (ids && ids.has(lc(d.depositId))) { out.set(lc(d.depositId), h); break; }
      }
    }
    return out;
  }

  function openSentLocks({ senderPriv, lockLeaves, lockMemos, lockMemoCandidates }) {
    const RECIPIENT_MEMO = 33 + 112;
    const out = [];
    for (let i = 0; i < lockLeaves.length; i++) {
      const cand = lockMemoCandidates && lockMemoCandidates[i];
      for (const m of (cand && cand.length ? cand : [lockMemos[i]])) {
        if (!m) continue;
        const b = hexToBytes(m);
        if (b.length < RECIPIENT_MEMO + 177) continue;
        const opened = airdrop.openStealthSenderTail({ senderPriv, ephemeralPub: '0x' + bytesToHex(b.subarray(0, 33)), leaf: lockLeaves[i], tailHex: '0x' + bytesToHex(b.subarray(RECIPIENT_MEMO)) });
        if (opened) { out.push({ ...opened, leaf: lockLeaves[i], lIndex: i, ephemeralPub: '0x' + bytesToHex(b.subarray(0, 33)) }); break; }
      }
    }
    return out;
  }

  return { txIndex, walkWraps, walkWrapsSliced, decodeExitFields, decodeOutputFields, walkChange, walkBridgeMints, deriveBridgeMintBlinding, scanCbtcNotes, deriveFarmPositions, decodeCdpFields, walkCdpPositions, openSentLocks, tryDerived, netCandidates, walkDerivedOutputs, walkDirectOutputs, locateDepositTx };
}
