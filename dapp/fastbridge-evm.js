
import { makeConfidentialAdaptor } from './confidential-adaptor.js';
import * as X from './adaptor-xswap.js';
import { G, SECP_N, signSchnorr } from './bulletproofs.js';

const LOCK_SPENT_SLOT = 119n;
const LOCK_COUNT_SLOT = '0x54';
const POSITION_TTL_MS = 5 * 60 * 1000;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const lc = (h) => '0x' + strip(h);

const MAINNET_RELAYER = '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3';

export function makeFastBridgeEvm({ ux, secp, keccak256, hmacSha256, walletPriv, seed, asset, poolAddress, relayerAddress = MAINNET_RELAYER, policy = {}, adaptor = null, selfSettle = null, ownAccount = null, openGraceMs = 45000, selfRetryMs = 120000, clock = () => Date.now(), log = () => {} }) {
  const te = new TextEncoder();
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const bytes = (h) => Uint8Array.from(strip(h).match(/../g).map((x) => parseInt(x, 16)));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const toBig = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
  const scalarHex = (k) => '0x' + k.toString(16).padStart(64, '0');
  const privBytes = walletPriv instanceof Uint8Array ? walletPriv : bytes(walletPriv);
  const pool = ux.pool;
  const ad = adaptor || makeConfidentialAdaptor({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool });
  const rpc = ux.rpc;
  const assetId = lc(asset);
  const identity = () => ux.identity(privBytes);

  function derive(tag, id, i = 0) {
    for (let c = i; ; c++) {
      const k = toBig(hmacSha256(privBytes, cat(te.encode('tacit-fastbridge-' + tag), bytes(id), Uint8Array.of(c)))) % SECP_N;
      if (k > 0n) return k;
    }
  }
  const xonlyOf = (k) => G.multiply(k).toRawBytes(true).slice(1);
  const seeded = (seedHex) => { let i = 0; const key = bytes(seedHex); return () => { for (; ; i++) { const k = toBig(hmacSha256(key, Uint8Array.of(i))) % SECP_N; if (k > 0n) { i++; return k; } } }; };
  const affine = (P) => { const u = P.toRawBytes(false); return { tx: '0x' + hex(u.slice(1, 33)), ty: '0x' + hex(u.slice(33, 65)) }; };

  const queue = { p: Promise.resolve() };
  const serial = (fn) => { const run = queue.p.catch(() => {}).then(fn); queue.p = run; return run; };
  const reserved = new Set();

  async function now() {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    return parseInt(b.timestamp, 16);
  }
  const lockNullifier = (leaf) => pool.nullifier(lc(leaf));
  const positions = new Map(), misses = new Map();
  const cap = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  async function lockPosition(leaf) {
    const key = lc(leaf), hit = positions.get(key);
    if (hit && Date.now() - hit.at < POSITION_TTL_MS) return hit.pos;
    const count = BigInt((await rpc('eth_getStorageAt', [poolAddress, LOCK_COUNT_SLOT, 'latest'])) || '0x0');
    if (!hit && misses.get(key) === count) return null;
    const pos = await ux.stealthLockPosition({ lockLeaf: key });
    if (pos) { positions.set(key, { at: Date.now(), pos }); misses.delete(key); } else { positions.delete(key); misses.set(key, count); }
    cap(positions, 1024); cap(misses, 1024);
    return pos;
  }

  async function mappingFlag(slot, key) {
    const k = hex(keccak256(cat(bytes(key), bytes('0x' + slot.toString(16).padStart(64, '0')))));
    return BigInt((await rpc('eth_getStorageAt', [poolAddress, '0x' + k, 'latest'])) || '0x0') !== 0n;
  }
  const blocks = new Map();
  async function blockTs(n) {
    if (!blocks.has(n)) { blocks.set(n, parseInt((await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false])).timestamp, 16)); cap(blocks, 4096); }
    return blocks.get(n);
  }
  async function blockAtOrAfter(ts) {
    let lo = 0, hi = parseInt(await rpc('eth_blockNumber', []), 16);
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await blockTs(mid)) < ts) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const inputs = new Map();
  async function txOf(h) {
    if (!inputs.has(h)) { const t = await rpc('eth_getTransactionByHash', [h]); inputs.set(h, t && t.input ? { input: t.input, to: String(t.to || '').toLowerCase() } : null); cap(inputs, 256); }
    return inputs.get(h);
  }
  const trustedTo = new Set([poolAddress, relayerAddress].map((a) => String(a).toLowerCase()));
  const claims = new Map();
  async function findClaim(lockNu, { sinceSecs = 0 } = {}) {
    if (!(await mappingFlag(LOCK_SPENT_SLOT, lockNu))) return null;
    const key = lc(lockNu);
    if (claims.has(key)) return claims.get(key);
    const events = await ux.fetchEvents({ fromBlock: sinceSecs ? await blockAtOrAfter(Math.max(0, sinceSecs - 3600)) : undefined, toBlock: 'latest' });
    const seen = new Set();
    const found = []; let named = false;
    for (const e of events) {
      if (!e.txHash || seen.has(e.txHash) || (e.type !== 'LeavesInserted' && e.type !== 'NullifiersSpent')) continue;
      seen.add(e.txHash);
      const tx = await txOf(e.txHash);
      const decoded = tx && ux.lockScan.decodeSettleCalls(tx.input);
      if (!decoded || !decoded.direct || !trustedTo.has(tx.to)) continue;
      for (const call of decoded.calls) {
        let f; try { f = ux.lockScan.decodePublicValuesAdaptorFields(call.publicValues); } catch { continue; }
        if (f.lockNullifiers.map(lc).includes(key)) { named = true; found.push(...f.adaptorClaimS); }
      }
    }
    if (named) { claims.set(key, found); cap(claims, 1024); return found; }
    throw new Error('the lock is spent, and the settle that spent it is not found yet');
  }

  const own = new Map();
  function sendOwn(id, proven, immediate = false) {
    let o = own.get(id);
    if (!o) own.set(id, (o = { seen: immediate ? -Infinity : clock(), retryAt: 0, sending: null, done: false }));
    if (o.done) return 'settled';
    if (o.sending || clock() - o.seen < openGraceMs || clock() < o.retryAt) return 'pending';
    log({ level: 'info', msg: 'the relay holds a settle: sending it from your wallet', jobId: id });
    o.sending = Promise.resolve().then(proven)
      .then((x) => selfSettle({ jobId: x.jobId || id, publicValues: x.publicValues, proof: x.proof, memos: Array.isArray(x.memos) ? x.memos : [] }).then((r) => [x, r]))
      .then(([x, r]) => {
        o.done = true;
        if (r && r.txHash && ux.relay.landed) for (const j of new Set([id, x.jobId || id])) Promise.resolve(ux.relay.landed(j, r.txHash)).catch(() => {});
      })
      .catch((e) => { o.retryAt = clock() + selfRetryMs; log({ level: 'warn', msg: 'the settle was not sent from your wallet', error: String((e && e.message) || e).slice(0, 160) }); })
      .finally(() => { o.sending = null; });
    return 'pending';
  }
  const relayHeld = async () => { try { const r = ux.relay.state ? await ux.relay.state() : null; return !!(r && r.state === 'held'); } catch { return false; } };
  async function jobStatus(id, again = null) {
    if (isOwnJob(id)) {
      if (own.get(id) && own.get(id).done) return 'settled';
      if (!selfSettle || !again || !again.bundle) return 'pending';
      return sendOwn(id, () => ux.relay.prove(specOf(again.type, again.bundle)), true);
    }
    const st = await ux.relay.status(id);
    const s = st && st.status;
    if (s === 'settled' || (own.get(id) && own.get(id).done)) return 'settled';
    if (s === 'failed' || s === 'unknown') return 'failed';
    if (!selfSettle) return 'pending';
    if (s === 'open' && st.publicValues && st.proof) return sendOwn(id, () => st);
    if (again && again.bundle && (own.has(id) || (await relayHeld()))) return sendOwn(id, () => ux.relay.prove(specOf(again.type, again.bundle)));
    return 'pending';
  }
  const specOf = (type, bundle) => ({
    type, op: bundle.op, leaves: bundle.leaves || [], outputs: bundle.outputs || null,
    ephRand: bundle.ephSeed ? seeded(bundle.ephSeed) : undefined, lockMemos: bundle.lockMemos || null,
  });
  const refusalOf = (e) => {
    const m = String((e && e.message) || e), code = e && e.code;
    if (code === 'free_budget' || /free relayed settles for today/i.test(m)) return 'the free settles for today are used up';
    if (code === 'relay_held' || /can.t take this one|catching up on settles/i.test(m)) return 'the relay is not sending settles';
    if (/too many submit requests/i.test(m)) return 'the relay is busy with this address';
    if (/fee below|feegate|marginal cost/i.test(m)) return 'the settle is below the relay’s fee floor';
    return null;
  };
  const refusals = new Map();
  const refusal = (type) => { const r = refusals.get(type); return r && clock() < r.until ? r : null; };
  let readyAt = -Infinity, readyLast = { ok: true }, ownSeq = 0;
  const isOwnJob = (id) => String(id).startsWith('own-');
  async function submit(type, bundle) {
    const proveHere = (r) => { log({ level: 'warn', msg: 'the relay will not send this settle: it is proved and sent from the provider’s own account', type, why: r.why }); return { jobId: `own-${type}-${clock().toString(36)}-${++ownSeq}` }; };
    const held = refusal(type);
    if (held) { if (ownAccount && selfSettle) return proveHere(held); throw held.error; }
    try {
      const r = await ux.relay.submitOp(specOf(type, bundle));
      if (!r || !r.jobId) throw new Error('the relay did not take the job');
      refusals.delete(type); readyAt = -Infinity;
      return { jobId: r.jobId };
    } catch (e) {
      const why = refusalOf(e);
      if (!why) throw e;
      const r = { why, error: e, until: clock() + Math.min(600, Math.max(30, Number(e.retryAfter) || 60)) * 1000 };
      refusals.set(type, r); readyAt = -Infinity;
      if (ownAccount && selfSettle) return proveHere(r);
      throw e;
    }
  }

  async function ready() {
    if (clock() - readyAt < 20000) return readyLast;
    let st = null;
    try { st = ux.relay.state ? await ux.relay.state() : null; } catch { st = null; }
    const state = st && st.state, lock = refusal('adaptorlock');
    let r;
    if (state === 'paused' || state === 'down') r = { ok: false, why: 'the relay is not proving right now' };
    else if (state !== 'held' && !lock) r = { ok: true };
    else {
      const why = state === 'held' ? 'the relay is not sending settles' : lock.why;
      if (!selfSettle) r = { ok: false, why };
      else if (!ownAccount) r = { ok: true };
      else {
        try {
          const bal = BigInt(await ux.rpc('eth_getBalance', [ownAccount.address, 'latest']));
          const gas = BigInt(await ux.rpc('eth_gasPrice', []));
          r = bal >= 800000n * (2n * gas + 100000000n) ? { ok: true } : { ok: false, why: `${why}, and the provider’s own account is low on ETH` };
        } catch { r = { ok: false, why: `${why}, and the provider’s own account cannot be read` }; }
      }
    }
    readyAt = clock(); readyLast = r;
    return r;
  }

  async function heldNotes() {
    const { byAsset } = await ux.balance(privBytes);
    return (byAsset[assetId] && byAsset[assetId].notes) || [];
  }

  const cutFee = { at: -Infinity, fee: 0n };
  async function cutReserve(sum) {
    if (clock() - cutFee.at > 600000) { cutFee.fee = await refundFee(sum + 1n); cutFee.at = clock(); }
    return cutFee.fee;
  }
  const available = async () => {
    const sum = (await heldNotes()).filter((n) => !reserved.has(lc(n.leaf))).reduce((s, n) => s + BigInt(n.value), 0n);
    const fee = sum > 0n ? await cutReserve(sum) : 0n;
    return sum > fee ? sum - fee : 0n;
  };

  const refundKey = async (id) => ({ xonly: xonlyOf(derive('evm-refund', id)) });
  const prepare = ({ rec }) => serial(async () => {
    const amount = BigInt(rec.offer.evm.amount);
    const free = (await heldNotes()).filter((n) => !reserved.has(lc(n.leaf)));
    if (free.some((n) => BigInt(n.value) === amount)) return;
    const pick = (fee) => {
      const need = amount + fee, sorted = free.slice().sort((x, y) => (BigInt(x.value) > BigInt(y.value) ? 1 : -1));
      const one = sorted.find((n) => BigInt(n.value) >= need);
      if (one) return [one];
      const out = []; let sum = 0n;
      for (const n of sorted.reverse()) { if (sum >= need || out.length >= 16) break; out.push(n); sum += BigInt(n.value); }
      return sum >= need ? out : null;
    };
    const send = async (fee) => {
      const notes = pick(fee);
      if (!notes) throw new Error(`fastbridge: the pool notes hold ${free.reduce((x, n) => x + BigInt(n.value), 0n)}, short of ${amount}${fee ? ` and the fee of cutting it (${fee})` : ''}`);
      const own = selfSettle && (await relayHeld()) ? (x) => { log({ level: 'info', msg: 'the relay is held: sending the cut from your wallet', jobId: x.jobId }); return selfSettle(x); } : null;
      return ux.transfer({ walletPriv: privBytes, notes, recipientPubHex: identity().pubHex, amount, fee, ...(own ? { selfSettle: own } : {}) }).catch((e) => {
        if (!(e && e.open && selfSettle)) throw e;
        log({ level: 'info', msg: 'the relay holds a settle: sending it from your wallet', jobId: e.open.jobId });
        return selfSettle({ jobId: e.open.jobId, publicValues: e.open.publicValues, proof: e.open.proof, memos: e.open.memos || [] });
      });
    };
    try { await send(0n); } catch (e) {
      const m = String((e && e.message) || e);
      if (!/free relayed settles|free_budget|fee below|floor/i.test(m)) throw e;
      await send(await refundFee(amount + 1n));
    }
  });
  const reserve = (rec) => {
    if (!rec || rec.phase === 'aborted') return;
    const op = rec.lock && rec.lock.op && (rec.lock.op.op || rec.lock.op);
    if (op && op.nCx) reserved.add(lc(pool.leaf(assetId, op.nCx, op.nCy, op.locker)));
    if (rec.lockNote) reserved.add(lc(rec.lockNote));
  };
  const release = ({ rec }) => { if (rec && rec.lockNote) reserved.delete(lc(rec.lockNote)); };
  const lockOp = ({ rec, rEvmLock, T, deadline, recipient, refundXonly, prefer = null }) => serial(async () => {
    const amount = BigInt(rec.offer.evm.amount);
    const held = await heldNotes();
    const note = prefer ? held.find((n) => lc(n.leaf) === lc(prefer) && BigInt(n.value) === amount) : held.find((n) => BigInt(n.value) === amount && !reserved.has(lc(n.leaf)));
    if (!note) return null;
    const op = ad.buildAdaptorLock({
      chainBinding: ux.chainBindingHex(), spendRoot: note.root, asset: assetId, amount, lBlinding: scalarHex(rEvmLock), T: affine(T), deadline,
      recipient: lc(recipient), refundPub: '0x' + hex(refundXonly),
      nNote: { cx: note.cx, cy: note.cy, owner: note.owner, blinding: note.blinding, leafIndex: note.leafIndex, path: note.path, secret: note.secret },
    });
    reserved.add(lc(note.leaf));
    return { op: { op, leaves: [], lockMemos: ['0x'] }, lockLeaf: op.lockLeaf, noteLeaf: lc(note.leaf) };
  });
  async function refundFee(amount) {
    try {
      const ticker = ux.poolTickerOf(assetId);
      const fee = ticker ? ux.ladderFee(await ux.quoteOpFee(ticker, 'transfer')) : 0n;
      return fee > 0n && fee < amount ? BigInt(fee) : 0n;
    } catch { return 0n; }
  }
  async function refundOp({ rec, position }) {
    const lop = rec.lock.op.op || rec.lock.op;
    const id = rec.id, amount = BigInt(lop.amount);
    const T = secpPoint(rec.offer.T);
    const nk = scalarHex(derive('refund-nk', id)), refundOwner = pool.nkToOwner(nk), oBlinding = scalarHex(derive('refund-out', id));
    const fee = await refundFee(amount);
    const op = ad.buildAdaptorRefund({
      chainBinding: ux.chainBindingHex(), lockSetRoot: position.lockSetRoot, asset: assetId, lCx: lop.lCx, lCy: lop.lCy, T: { tx: lop.tx, ty: lop.ty },
      deadline: lop.deadline, recipient: lop.recipient, locker: lop.refundPub, lockerPriv: scalarHex(derive('evm-refund', id)),
      lIndex: position.lIndex, lPath: position.lPath, amount, lBlinding: scalarHex(X.evmLockBlinding({ seed, swapId: bytes(id), T })), oBlinding, fee, refundOwner,
    });
    const output = { value: (amount - fee).toString(), blinding: oBlinding, secret: nk, asset: assetId, owner: refundOwner, cx: op.oCx, cy: op.oCy, ownerPub: identity().pubHex };
    return { op, leaves: [pool.leaf(assetId, op.oCx, op.oCy, refundOwner)], outputs: [output], ephSeed: scalarHex(derive('refund-eph', id)) };
  }
  const secpPoint = (h) => secp.ProjectivePoint.fromHex(strip(h));

  const recipient = async (id) => { const k = derive('evm-auth', id); return { xonly: xonlyOf(k), priv: k }; };
  async function claimOp({ rec, evmOffer, sec, position }) {
    const id = rec.id, amount = BigInt(evmOffer.amount);
    const kernel = X.completeEvmClaim({ offer: evmOffer, t: sec.t, rOut: sec.rOut, nowSecs: await now(), minClaimSecs: policy.minClaimSecs ?? 3600 });
    const L = secpPoint(evmOffer.L).toRawBytes(false);
    const nk = scalarHex(derive('claim-nk', id)), outOwner = pool.nkToOwner(nk), oBlinding = scalarHex(sec.rOut);
    const op = ad.buildAdaptorClaim({
      chainBinding: ux.chainBindingHex(), lockSetRoot: position.lockSetRoot, asset: assetId, lCx: '0x' + hex(L.slice(1, 33)), lCy: '0x' + hex(L.slice(33, 65)),
      T: affine(sec.T), deadline: evmOffer.deadline, recipient: lc(evmOffer.recipient), locker: lc(evmOffer.locker), lIndex: position.lIndex, lPath: position.lPath,
      amount, oBlinding, kernel, outOwner, recipientPriv: scalarHex(derive('evm-auth', id)),
    });
    const output = { value: amount.toString(), blinding: oBlinding, secret: nk, asset: assetId, owner: outOwner, cx: op.oCx, cy: op.oCy, ownerPub: identity().pubHex };
    return { op, leaves: [op.outLeaf], outputs: [output], ephSeed: scalarHex(derive('claim-eph', id)) };
  }

  return { now, lockNullifier, lockPosition, findClaim, jobStatus, claimStatus: jobStatus, submit, ready, prepare, lockOp, refundOp, refundKey, reserve, release, available, cutReserve, recipient, claimOp };
}
