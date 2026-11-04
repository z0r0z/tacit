// The Ethereum side of the fast bridge machines (fastbridge-bl.js, fastbridge-el.js) on the pool wallet
// (dapp/confidential-pool-ux.js) and the relay client it carries: the chain reads (time, the lock set, whether a lock
// is spent and by which claim), the ops of both lockers, and sending them through the relay.
//
// Ops are built once, returned as bundles { op, leaves, outputs, lockMemos, ephSeed } the machines store before they
// send, and sent from the stored bytes. Every key and blinding a bundle needs derives from the wallet key and the swap
// id, and the memos are sealed from a seed in the bundle, so a bundle sent twice is the same job and a lost record
// costs nothing the key and the chain cannot rebuild. Notes the wallet receives (a claimed or refunded note) carry a
// memo sealed to its key and are found again by the wallet's own scan.
//
//   const evm = makeFastBridgeEvm({ ux, secp, keccak256, hmacSha256, walletPriv, seed, asset, poolAddress })
//   ux          makeConfidentialPoolUx(...)           walletPriv  32 bytes, the pool identity        seed  32 bytes, the swap seed
//   hmacSha256  (key, msg) => 32 bytes                asset       the pool asset id of the swap      poolAddress  the pool contract

import { makeConfidentialAdaptor } from './confidential-adaptor.js';
import * as X from './adaptor-xswap.js';
import { G, SECP_N, signSchnorr } from './bulletproofs.js';

const LOCK_SPENT_SLOT = 119n;
const LOCK_COUNT_SLOT = '0x54';
const POSITION_TTL_MS = 5 * 60 * 1000;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const lc = (h) => '0x' + strip(h);

// the relayer the pool's lock scan trusts to forward settles (dapp/confidential-lock-scan.js)
const MAINNET_RELAYER = '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3';

export function makeFastBridgeEvm({ ux, secp, keccak256, hmacSha256, walletPriv, seed, asset, poolAddress, relayerAddress = MAINNET_RELAYER, policy = {}, adaptor = null }) {
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

  // A scalar from the wallet key, a purpose and the swap id: the same on every run.
  function derive(tag, id, i = 0) {
    for (let c = i; ; c++) {
      const k = toBig(hmacSha256(privBytes, cat(te.encode('tacit-fastbridge-' + tag), bytes(id), Uint8Array.of(c)))) % SECP_N;
      if (k > 0n) return k;
    }
  }
  const xonlyOf = (k) => G.multiply(k).toRawBytes(true).slice(1);
  // The randomness a memo is sealed with, from a seed, so the same bundle seals to the same memo every time.
  const seeded = (seedHex) => { let i = 0; const key = bytes(seedHex); return () => { for (; ; i++) { const k = toBig(hmacSha256(key, Uint8Array.of(i))) % SECP_N; if (k > 0n) { i++; return k; } } }; };
  const affine = (P) => { const u = P.toRawBytes(false); return { tx: '0x' + hex(u.slice(1, 33)), ty: '0x' + hex(u.slice(33, 65)) }; };

  const queue = { p: Promise.resolve() };
  const serial = (fn) => { const run = queue.p.catch(() => {}).then(fn); queue.p = run; return run; };
  const reserved = new Set();

  // ── chain reads ──
  async function now() {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    return parseInt(b.timestamp, 16);
  }
  const lockNullifier = (leaf) => pool.nullifier(lc(leaf));
  // Where a lock sits in the lock set. Reading the set decodes the pool's whole event history, so it is not done for a
  // question already answered: a position found stays good (the pool accepts any root the set has had) and is read again
  // only after a few minutes, in case the block it was found in has since been replaced; a lock not found is looked for
  // again only when the set has grown, which its count shows at the cost of one storage read.
  const positions = new Map(), misses = new Map();
  async function lockPosition(leaf) {
    const key = lc(leaf), hit = positions.get(key);
    if (hit && Date.now() - hit.at < POSITION_TTL_MS) return hit.pos;
    const count = BigInt((await rpc('eth_getStorageAt', [poolAddress, LOCK_COUNT_SLOT, 'latest'])) || '0x0');
    if (!hit && misses.get(key) === count) return null;
    const pos = await ux.stealthLockPosition({ lockLeaf: key });
    if (pos) { positions.set(key, { at: Date.now(), pos }); misses.delete(key); } else { positions.delete(key); misses.set(key, count); }
    return pos;
  }

  async function mappingFlag(slot, key) {
    const k = hex(keccak256(cat(bytes(key), bytes('0x' + slot.toString(16).padStart(64, '0')))));
    return BigInt((await rpc('eth_getStorageAt', [poolAddress, '0x' + k, 'latest'])) || '0x0') !== 0n;
  }
  const blocks = new Map();
  async function blockTs(n) {
    if (!blocks.has(n)) blocks.set(n, parseInt((await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false])).timestamp, 16));
    return blocks.get(n);
  }
  // The first block at or after a time, by bisection.
  async function blockAtOrAfter(ts) {
    let lo = 0, hi = parseInt(await rpc('eth_blockNumber', []), 16);
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await blockTs(mid)) < ts) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const inputs = new Map();
  async function txOf(h) {
    if (!inputs.has(h)) { const t = await rpc('eth_getTransactionByHash', [h]); inputs.set(h, t && t.input ? { input: t.input, to: String(t.to || '').toLowerCase() } : null); }
    return inputs.get(h);
  }
  const trustedTo = new Set([poolAddress, relayerAddress].map((a) => String(a).toLowerCase()));
  const claims = new Map();
  // null while the lock is unspent; the s values its settle committed once it is spent ([] for a refund).
  async function findClaim(lockNu, { sinceSecs = 0 } = {}) {
    if (!(await mappingFlag(LOCK_SPENT_SLOT, lockNu))) return null;
    const key = lc(lockNu);
    if (claims.has(key)) return claims.get(key);
    const events = await ux.fetchEvents({ fromBlock: sinceSecs ? await blockAtOrAfter(Math.max(0, sinceSecs - 3600)) : undefined, toBlock: 'latest' });
    const seen = new Set();
    for (const e of events) {
      if (!e.txHash || seen.has(e.txHash) || (e.type !== 'LeavesInserted' && e.type !== 'NullifiersSpent')) continue;
      seen.add(e.txHash);
      const tx = await txOf(e.txHash);
      const decoded = tx && ux.lockScan.decodeSettleCalls(tx.input);
      // only a settle the pool itself (or its relayer) was called with says what the pool did: bytes inside the calldata of some other
      // contract's call are whatever its sender wrote, and a settle-shaped decoy there would end the swap in the wrong phase
      if (!decoded || !decoded.direct || !trustedTo.has(tx.to)) continue;
      for (const call of decoded.calls) {
        let f; try { f = ux.lockScan.decodePublicValuesAdaptorFields(call.publicValues); } catch { continue; }
        if (f.lockNullifiers.map(lc).includes(key)) { claims.set(key, f.adaptorClaimS); return f.adaptorClaimS; }
      }
    }
    throw new Error('the lock is spent, and the settle that spent it is not found yet');
  }

  async function jobStatus(id) {
    const st = await ux.relay.status(id);
    const s = st && st.status;
    return s === 'settled' ? 'settled' : s === 'failed' || s === 'unknown' ? 'failed' : 'pending';
  }
  async function submit(type, bundle) {
    const r = await ux.relay.submitOp({
      type, op: bundle.op, leaves: bundle.leaves || [], outputs: bundle.outputs || null,
      ephRand: bundle.ephSeed ? seeded(bundle.ephSeed) : undefined, lockMemos: bundle.lockMemos || null,
    });
    if (!r || !r.jobId) throw new Error('the relay did not take the job');
    return { jobId: r.jobId };
  }

  async function heldNotes() {
    const { byAsset } = await ux.balance(privBytes);
    return (byAsset[assetId] && byAsset[assetId].notes) || [];
  }

  // What the wallet holds of the asset, less the notes already given to a lock: the most a new lock can use.
  const available = async () => (await heldNotes()).filter((n) => !reserved.has(lc(n.leaf))).reduce((s, n) => s + BigInt(n.value), 0n);

  // ── the Ethereum locker ──
  const refundKey = async (id) => ({ xonly: xonlyOf(derive('evm-refund', id)) });
  // A note of exactly the amount, cut from a larger one when there is none; one cut at a time.
  const prepare = ({ rec }) => serial(async () => {
    const amount = BigInt(rec.offer.evm.amount);
    const free = (await heldNotes()).filter((n) => !reserved.has(lc(n.leaf)));
    if (free.some((n) => BigInt(n.value) === amount)) return;
    try { await ux.ensureExactNote({ walletPriv: privBytes, asset: assetId, amount, notes: free }); return; } catch (e) {
      if (!/consolidate first/.test(String((e && e.message) || e))) throw e;
    }
    // No one note covers it: one transfer to this wallet's own identity takes several notes in (the largest first) and puts out a note of
    // exactly the amount and the change, so a provider whose balance came in pieces can lock what it advertises.
    const fee = await refundFee(amount + 1n);
    const picked = [];
    let sum = 0n;
    for (const n of free.slice().sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1))) {
      if (sum >= amount + fee || picked.length >= 16) break;
      picked.push(n); sum += BigInt(n.value);
    }
    if (sum < amount + fee) throw new Error(`fastbridge: the pool notes hold ${sum}, short of ${amount} and the fee of cutting it (${fee})`);
    await ux.transfer({ walletPriv: privBytes, notes: picked, recipientPubHex: identity().pubHex, amount, fee });
  });
  // The reservation of a note keeps two swaps of one size from being given the same note. A swap keeps its note across tries: a lock
  // that is built again (the relay lost the job, or said it failed) is built from the note the first try used, so that if the first
  // lands after all the second cannot, instead of two locks of one swap being made from two notes.
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
    // a note an earlier try used is the one to use: when it is no longer held, that try has probably landed, and the pool says so by the lock's leaf
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

  // ── the Bitcoin locker ──
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

  return { now, lockNullifier, lockPosition, findClaim, jobStatus, claimStatus: jobStatus, submit, prepare, lockOp, refundOp, refundKey, reserve, release, available, recipient, claimOp };
}
