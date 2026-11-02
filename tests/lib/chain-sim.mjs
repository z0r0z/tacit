// A small Bitcoin and a small Ethereum pool for the fast bridge's orchestration tests, on one virtual clock.
// Bitcoin: real transactions (dapp/adaptor-btc-tx.js) in a mempool and blocks; notes are judged by the real
// tacit.validateOutpoint. Ethereum: the pool's lock set, note tree and nullifiers, with the adaptor lock / claim /
// refund checks of the settle guest and the contract's timing rules mirrored in JS (the real guest runs in
// fast-lane-e2e.test.mjs). Both let a test crash, delay, reorder and replay what the real chains would.
// Needs Node 22.

import { createHash } from 'node:crypto';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeConfidentialPool } from '../../dapp/confidential-pool.js';
import { makeConfidentialAdaptor } from '../../dapp/confidential-adaptor.js';
import { makeNoteResolver } from '../../dapp/btc-pool-zap.js';
import * as X from '../../dapp/adaptor-xswap.js';
import * as adaptor from '../../dapp/adaptor-signature.js';
import { G, SECP_N, modN, pedersenCommit, bigintToBytes32, signSchnorr, verifySchnorr } from '../../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes, sha256 as dappSha256 } from '../../dapp/vendor/tacit-deps.min.js';
import { tacit } from './btc-sim.mjs';

export const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
export const pool = makeConfidentialPool({ secp: rootSecp, keccak256: keccak_256, sha256 });
export const ad = makeConfidentialAdaptor({ keccak256: keccak_256, secp: rootSecp, signSchnorr, curveOrder: SECP_N, pool });
export const ZERO = '0x' + '00'.repeat(32);
export const ASSET = '0x' + 'a1'.repeat(32);
export const CHAIN_BINDING = '0x' + '11'.repeat(32);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const te = (s) => new TextEncoder().encode(s);
export const scalarHex = (x) => '0x' + bytesToHex(bigintToBytes32(x));
export const derive = (seed, tag) => (BigInt('0x' + bytesToHex(sha256(new Uint8Array([...seed, ...te(tag)])))) % (SECP_N - 1n)) + 1n;

// ── the clock: Bitcoin blocks are 600 s apart and every other time reads this one ──
export function makeClock(start = 1_800_000_000) {
  const c = { t: start, now: () => c.t, advance: (s) => { c.t += s; } };
  return c;
}

// ── Bitcoin ──
export function makeBitcoinSim(clock, { baseHeight = 800_000 } = {}) {
  const sim = { tip: baseHeight, txs: new Map(), mempool: [], spends: new Map(), blockTimes: new Map([[baseHeight, clock.now()]]), consumed: new Set(), broadcasts: [] };
  const confirmed = (txid) => sim.txs.get(txid)?.height ?? null;
  sim.addConfirmed = (op) => { sim.txs.set(op.txid, { esplora: op.esplora, height: sim.tip }); for (const i of op.esplora.vin) sim.spends.set(`${i.txid}:${i.vout}`, op.txid); };
  sim.fetchTx = async (txid) => {
    const e = sim.txs.get(txid);
    if (!e) return null;
    return { ...e.esplora, status: { confirmed: e.height != null, block_height: e.height ?? undefined } };
  };
  sim.status = async (txid) => { const h = confirmed(txid); return h == null ? { confirmations: 0, height: 0 } : { confirmations: sim.tip - h + 1, height: h }; };
  sim.tip_ = async () => sim.tip;
  sim.blockTime = async (h) => { const t = sim.blockTimes.get(h); if (t == null) throw new Error('no such block'); return t; };
  sim.outspend = async (txid, vout) => sim.spends.get(`${txid}:${vout}`) || null;
  const esploraOf = (pair) => ({
    txid: pair.revealTxid,
    vin: pair.revealTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
    vout: pair.revealTx.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })),
  });
  sim.broadcast = async (pair) => {
    if (sim.txs.has(pair.revealTxid)) return;
    for (const i of pair.revealTx.inputs) {
      const by = sim.spends.get(`${i.txid}:${i.vout}`);
      if (by && by !== pair.revealTxid) throw new Error(`bad-txns-inputs-missingorspent: ${i.txid}:${i.vout} is spent by ${by}`);
    }
    // a relative timelock is enforced the way consensus does it
    for (const [k, i] of pair.revealTx.inputs.entries()) {
      if (k === 0 || i.sequence >= 0xfffffffd) continue;
      const parent = sim.txs.get(i.txid);
      if (!parent || parent.height == null || sim.tip + 1 < parent.height + i.sequence) throw new Error('non-BIP68-final');
    }
    sim.broadcasts.push(pair.revealTxid);
    sim.txs.set(pair.revealTxid, { esplora: esploraOf(pair), height: null });
    for (const i of pair.revealTx.inputs) sim.spends.set(`${i.txid}:${i.vout}`, pair.revealTxid);
  };
  sim.mine = (n = 1, { advance = true } = {}) => {
    for (let k = 0; k < n; k++) {
      if (advance) clock.advance(600);
      sim.tip += 1; sim.blockTimes.set(sim.tip, clock.now());
      for (const e of sim.txs.values()) if (e.height == null) e.height = sim.tip;
    }
  };
  // The note the validator derives from an output, as the Ethereum locker reads it.
  sim.resolveNote = async (txid, vout) => {
    const fetchTx = async (id) => { const e = sim.txs.get(id); return e ? { ...e.esplora, status: { confirmed: true, block_height: e.height ?? sim.tip } } : null; };
    return makeNoteResolver({ validateOutpoint: (a, b, c, f) => tacit.validateOutpoint(a, b, c, f), txOutputEnvelope: tacit.txOutputEnvelope, getParentEnvelopeData: tacit.getParentEnvelopeData, fetchTx })(txid, vout);
  };
  sim.crossLaneBlocked = async (tx) => { for (const i of tx.vin.slice(1)) if (sim.consumed.has(`${i.txid}:${i.vout}`)) return `${i.txid}:${i.vout}`; return null; };
  // the seam both machines use; `builder` is a makeAdaptorBtcTx whose pairs the sim records, `sats()` the wallet's plain coins
  sim.adapter = ({ prims, builder, sats }) => ({
    prims, wallet: { pub: prims.wallet.pub, priv: prims.wallet.priv, xonly: prims.wallet.pub.slice(1) }, address: prims.wallet.address(), tx: recordingBuilder(builder),
    history: async () => [...sim.txs.entries()].reverse().map(([txid, e]) => ({ ...e.esplora, txid, status: { confirmed: e.height != null, block_height: e.height ?? undefined } })),
    satsUtxos: async () => sats(), feeRate: async () => 3,
    broadcast: async (p) => {
      const id = p.revealTxid || p.txid, tx = pairs.get(id);
      if (!tx) throw new Error('chain-sim: this reveal was not built by a builder of this run');
      return sim.broadcast({ revealTxid: id, revealTx: tx });
    },
    fetchTx: sim.fetchTx, status: sim.status, tip: sim.tip_, blockTime: sim.blockTime, outspend: sim.outspend,
    resolveNote: sim.resolveNote, crossLaneBlocked: sim.crossLaneBlocked,
  });
  return sim;
}

// A stored pair is hex; the sim keeps the decoded reveal each builder produced, keyed by its txid.
const pairs = new Map();
function recordingBuilder(builder) {
  const wrap = (fn) => (...a) => { const p = fn(...a); pairs.set(p.revealTxid, p.revealTx); return p; };
  return { ...builder, lockTransfer: wrap(builder.lockTransfer), claimTransfer: wrap(builder.claimTransfer), refundTransfer: wrap(builder.refundTransfer) };
}

// ── Ethereum ──
export function makeEvmSim(clock) {
  const sim = {
    notes: new pool.Tree(), noteRoots: new Set(), spentNotes: new Set(), locks: new pool.Tree(), lockRoots: new Set(), lockSpent: new Set(),
    claims: new Map(), jobs: new Map(), submitted: [], inventory: new Map(), paused: false,
  };
  sim.noteRoots.add(sim.notes.root());
  sim.addNote = (leaf) => { const i = sim.notes.insert(leaf); sim.noteRoots.add(sim.notes.root()); return i; };
  sim.now = async () => clock.now();

  const jobId = (type, op) => '0x' + bytesToHex(keccak_256(te(type + JSON.stringify(op))));
  const mirrorLock = (op) => {
    if (!sim.noteRoots.has(op.spendRoot)) throw new Error('UnknownRoot');
    if (!pool.verifyPath(pool.leaf(op.asset, op.nCx, op.nCy, op.locker), op.nIndex, op.nPath, op.spendRoot)) throw new Error('N membership');
    const nu = pool.nativeNullifier(op.nk, pool.leaf(op.asset, op.nCx, op.nCy, op.locker));
    if (sim.spentNotes.has(nu)) throw new Error('NullifierAlreadySpent');
    const ctx = pool.intentContext('tacit-adaptor-lock-intent-v1', op.chainBinding, op.asset, op.asset,
      [[op.nCx, op.nCy, op.locker], [op.lCx, op.lCy, op.recipient], [op.tx, op.ty, ZERO], [op.refundPub, ZERO, ZERO]], [BigInt(op.amount), BigInt(op.deadline)]);
    if (!pool.verifyOpeningSigma(op.nCx, op.nCy, op.amount, op.nSigR, op.nSigZ, ctx)) throw new Error('N opening');
    if (!pool.verifyOpeningSigma(op.lCx, op.lCy, op.amount, op.lSigR, op.lSigZ, ctx)) throw new Error('L opening');
    if (clock.now() > op.deadline) throw new Error('Expired');
    sim.spentNotes.add(nu);
    sim.locks.insert(op.lockLeaf);
    sim.lockRoots.add(sim.locks.root());
  };
  const pt = (cx, cy) => rootSecp.ProjectivePoint.fromHex('04' + strip(cx).padStart(64, '0') + strip(cy).padStart(64, '0'));
  const kernelOk = (L, O, R, z, fee = 0n) => {
    const e = BigInt('0x' + bytesToHex(keccak_256(new Uint8Array([...te('tacit-evm-cxfer-kernel-v1'), ...L.toRawBytes(true), ...O.toRawBytes(true), ...R.toRawBytes(true)])))) % SECP_N;
    const X_ = fee ? L.add(O.negate()).add(pool.prover.H.multiply(fee).negate()) : L.add(O.negate());
    return rootSecp.ProjectivePoint.BASE.multiply(z).equals(R.add(X_.multiply(e)));
  };
  const mirrorClaim = (op) => {
    if (!sim.lockRoots.has(op.lockSetRoot)) throw new Error('UnknownLockRoot');
    const lockNu = pool.nullifier(op.lockLeaf);
    if (sim.lockSpent.has(lockNu)) throw new Error('LockAlreadySpent');
    if (!pool.verifyPath(op.lockLeaf, op.lIndex, op.lPath, op.lockSetRoot)) throw new Error('L membership');
    if (clock.now() > op.deadline) throw new Error('Expired');
    const oCtx = pool.intentContext('tacit-adaptor-claim-out-v1', op.chainBinding, op.asset, op.asset, [[op.oCx, op.oCy, op.recipient], [op.lCx, op.lCy, op.locker]], [BigInt(op.amount), BigInt(op.deadline)]);
    if (!pool.verifyOpeningSigma(op.oCx, op.oCy, op.amount, op.oSigR, op.oSigZ, oCtx)) throw new Error('O opening');
    if (!kernelOk(pt(op.lCx, op.lCy), pt(op.oCx, op.oCy), rootSecp.ProjectivePoint.fromHex(strip(op.kernelR)), BigInt(op.kernelS))) throw new Error('value conservation');
    const msg = ad.adaptorClaimMsg(op.chainBinding, op.lockLeaf, lockNu, op.outLeaf, BigInt(op.amount), op.kernelR, op.kernelS);
    if (!verifySchnorr(hexToBytes(strip(op.recipientSig)), msg, hexToBytes(strip(op.recipient)))) throw new Error('recipient authorization');
    sim.lockSpent.add(lockNu);
    sim.claims.set(lockNu, [op.kernelS]);
    sim.addNote(op.outLeaf);
  };
  const mirrorRefund = (op) => {
    if (!sim.lockRoots.has(op.lockSetRoot)) throw new Error('UnknownLockRoot');
    const lockNu = pool.nullifier(op.lockLeaf);
    if (sim.lockSpent.has(lockNu)) throw new Error('LockAlreadySpent');
    if (!pool.verifyPath(op.lockLeaf, op.lIndex, op.lPath, op.lockSetRoot)) throw new Error('L membership');
    if (!(clock.now() > op.deadline)) throw new Error('RefundTooEarly');
    const ctx = pool.intentContext('tacit-adaptor-refund-v1', op.chainBinding, op.asset, op.asset, [[op.lCx, op.lCy, op.locker], [op.oCx, op.oCy, op.locker]], [BigInt(op.amount), BigInt(op.deadline)]);
    if (!pool.verifyOpeningSigma(op.lCx, op.lCy, op.amount, op.lSigR, op.lSigZ, ctx)) throw new Error('L opening');
    if (!kernelOk(pt(op.lCx, op.lCy), pt(op.oCx, op.oCy), rootSecp.ProjectivePoint.fromHex(strip(op.kernelR)), BigInt(op.kernelZ), BigInt(op.fee))) throw new Error('value conservation');
    const msg = ad.adaptorRefundMsg(op.chainBinding, op.lockLeaf, op.oCx, op.oCy, BigInt(op.fee), op.refundOwner);
    if (!verifySchnorr(hexToBytes(strip(op.lockerSig)), msg, hexToBytes(strip(op.locker)))) throw new Error('locker authorization');
    sim.lockSpent.add(lockNu);
    sim.claims.set(lockNu, []);
  };
  const mirrors = { adaptorlock: mirrorLock, adaptorclaim: mirrorClaim, adaptorrefund: mirrorRefund };

  // A relayed job lands when the test lets it (`sim.process()`), or at once when `eager`.
  sim.dieOnce = null;
  sim.dieAfter = null;
  sim.submit = async (type, op) => {
    if (sim.dieOnce === type) { sim.dieOnce = null; throw new Error('process died before the job was sent'); }
    const id = jobId(type, op);
    if (!sim.jobs.has(id)) { sim.jobs.set(id, { type, op, status: 'pending' }); sim.submitted.push({ type, id }); }
    if (sim.eager) sim.process();
    if (sim.dieAfter === type) { sim.dieAfter = null; throw new Error('process died after the job was sent'); }
    return { jobId: id };
  };
  sim.process = () => {
    if (sim.paused) return;
    for (const j of sim.jobs.values()) {
      if (j.status !== 'pending') continue;
      try { mirrors[j.type](j.op); j.status = 'settled'; } catch (e) { j.status = 'failed'; j.error = e.message; }
    }
  };
  sim.eager = true;
  sim.jobStatus = async (id) => (sim.jobs.get(id) || { status: 'failed' }).status;
  sim.lockPosition = async (leaf) => {
    const i = sim.locks.leaves.findIndex((l) => bytesToHex(l) === strip(leaf));
    if (i < 0) return null;
    const { root, path } = sim.locks.rootAndPath(i);
    return { lIndex: i, lPath: path, lockSetRoot: root };
  };
  sim.lockSpentFn = async (nu) => sim.lockSpent.has(nu);
  sim.findClaim = async (nu) => (sim.claims.has(nu) ? sim.claims.get(nu) : null);
  return sim;
}

// ── a party's keys on both chains, derived from its seed ──
export function partyKeys(name) {
  const seed = sha256(te('seed/' + name));
  const d = (tag) => derive(seed, tag);
  return {
    name, seed, dAuth: d('evm-auth'), dRefund: d('evm-refund'), nk: scalarHex(d('nk')), nkOut: scalarHex(d('nk-out')), nkRefund: scalarHex(d('nk-refund')),
    xonlyHex: (priv) => bytesToHex(G.multiply(priv).toRawBytes(true).slice(1)),
  };
}

// An Ethereum pool wallet of one party: notes it holds and the adapters the two machines call.
export function makeEvmParty({ evm, keys, clock }) {
  const holdings = [];
  const party = { keys, holdings };
  party.fund = (amount, tag) => {
    const r = scalarHex(derive(keys.seed, 'note/' + tag));
    const C = pool.commitXY(amount, r), owner = pool.nkToOwner(keys.nk);
    const leaf = pool.leaf(ASSET, C.cx, C.cy, owner);
    const idx = evm.addNote(leaf);
    holdings.push({ cx: C.cx, cy: C.cy, owner, blinding: r, nk: keys.nk, amount, leafIndex: idx, leaf, used: false });
  };
  const nTree = () => evm.notes;
  // EL adapter pieces
  party.lockOp = async ({ rec, rEvmLock, T, deadline, recipient, refundXonly }) => {
    const amount = BigInt(rec.offer.evm.amount);
    const h = holdings.find((x) => !x.used && x.amount === amount);
    if (!h) return null;
    const { root, path } = nTree().rootAndPath(h.leafIndex);
    const aff = (Pt) => { const u = Pt.toRawBytes(false); return { tx: '0x' + bytesToHex(u.slice(1, 33)), ty: '0x' + bytesToHex(u.slice(33, 65)) }; };
    const op = ad.buildAdaptorLock({
      chainBinding: CHAIN_BINDING, spendRoot: root, asset: ASSET,
      nNote: { cx: h.cx, cy: h.cy, owner: h.owner, blinding: h.blinding, leafIndex: h.leafIndex, path, secret: h.nk },
      amount, lBlinding: scalarHex(rEvmLock), T: aff(T), deadline, recipient: '0x' + strip(recipient), refundPub: '0x' + bytesToHex(refundXonly),
    });
    h.used = true;
    return { op, lockLeaf: op.lockLeaf, lockNu: pool.nullifier(op.lockLeaf) };
  };
  party.refundOp = async ({ rec, position }) => {
    const { op } = rec.lock;
    const aff = { tx: op.tx, ty: op.ty };
    return ad.buildAdaptorRefund({
      chainBinding: CHAIN_BINDING, lockSetRoot: position.lockSetRoot, asset: ASSET, lCx: op.lCx, lCy: op.lCy, T: aff, deadline: op.deadline,
      recipient: op.recipient, locker: op.refundPub, lockerPriv: scalarHex(keys.dRefund), lIndex: position.lIndex, lPath: position.lPath, amount: BigInt(op.amount),
      lBlinding: scalarHex(X.evmLockBlinding({ seed: keys.seed, swapId: hexToBytes(rec.id), T: rootSecp.ProjectivePoint.fromHex(strip(rec.offer.T)) })),
      oBlinding: scalarHex(derive(keys.seed, 'refund-out/' + rec.id)), fee: 0n, refundOwner: pool.nkToOwner(keys.nkRefund),
    });
  };
  party.refundKey = async () => ({ xonly: G.multiply(keys.dRefund).toRawBytes(true).slice(1) });
  // BL adapter pieces
  party.recipient = async () => ({ xonly: G.multiply(keys.dAuth).toRawBytes(true).slice(1), priv: keys.dAuth });
  party.claimOp = async ({ rec, evmOffer, sec, position }) => {
    const nowSecs = clock.now();
    const kernel = X.completeEvmClaim({ offer: evmOffer, t: sec.t, rOut: sec.rOut, nowSecs, minClaimSecs: 1800 });
    const T = { tx: '0x' + bytesToHex(sec.T.toRawBytes(false).slice(1, 33)), ty: '0x' + bytesToHex(sec.T.toRawBytes(false).slice(33, 65)) };
    const L = rootSecp.ProjectivePoint.fromHex(strip(evmOffer.L)).toRawBytes(false);
    const op = ad.buildAdaptorClaim({
      chainBinding: CHAIN_BINDING, lockSetRoot: position.lockSetRoot, asset: ASSET, lCx: '0x' + bytesToHex(L.slice(1, 33)), lCy: '0x' + bytesToHex(L.slice(33, 65)), T,
      deadline: evmOffer.deadline, recipient: '0x' + strip(evmOffer.recipient), locker: '0x' + strip(evmOffer.locker), lIndex: position.lIndex, lPath: position.lPath,
      amount: BigInt(evmOffer.amount), oBlinding: scalarHex(sec.rOut), kernel, outOwner: pool.nkToOwner(keys.nkOut), recipientPriv: scalarHex(keys.dAuth),
    });
    return op;
  };
  return party;
}
