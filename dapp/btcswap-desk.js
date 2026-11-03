// The desk of a Bitcoin-to-Bitcoin swap (dapp/btcswap.js): quotes, checks a holder's lock on the chain, locks the same amount
// less its fee of TAC the bridge's proof follows in a lock keyed to both parties, gives its half of the claim's signature
// adapted to the holder's T, reads t from the claim and opens the holder's lock. Or, if the holder never claims, takes its
// lock back once the timelock runs.
//
// One record per swap, the safety state of the swap, kept durably; steps of one record run one at a time. The desk's key in
// a swap's joint lock, and the lock's blinding, follow the seed and the swap id (deskSwapSecrets). A secret nonce is stored
// before its public half is given out, and wiped in the same save that stores the partial signature it made, so it signs
// one session only; a session answers again with what it already gave, never with a second signature.
//
// What the desk reads from the chain itself and never takes from the holder: the holder's lock output and the outpoints its
// transaction spends (the swap id), the validator's note at it, its confirmations and age, whether its notes are consumed on
// Ethereum, and every spend of either lock.
//
// Phases:  accepted -> locking -> locked -> offered -> taking -> done          or  ... offered -> refunding -> refunded
//          aborted (nothing was locked)        lost (a lock was spent and t could not be read)
//
// ctx = { seed, now(), policy, store, quotes, btc, inventory, tracking, log, alert }
//   policy     { asset, minAmount, maxAmount, feeBps, flatFee, validSecs, csvHolder, csvDesk, minConfsFor(v), maxSessions (4),
//                lockDelayBlocks, takeMarginBlocks, signStopBlocks, acceptWaitSecs }
//   quotes     a store of the quotes given: { get(id), put(q), list() }
//   btc        the fast bridge's Bitcoin seam (dapp/fastbridge-btc.js), crossLaneBlocked included
//   inventory  { notes() -> the desk's TAC notes [{ txid, vout, value, amount, blinding, height }] }
//   tracking(notes) -> Map 'txid:vout' -> 'tracked' | 'bound' | 'new' | 'untracked' (burndep-ux noteTracking's answer)

import * as S from './btcswap.js';
import * as M from './musig2.js';
import { claimSecret } from './adaptor-btc-lock.js';
import { bigintToBytes32 } from './bulletproofs.js';
import { secp, bytesToHex, hexToBytes, sha256 } from './vendor/tacit-deps.min.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const DUST_P2TR = 330;
const TERMINAL = new Set(['done', 'refunded', 'aborted', 'lost']);
const OPEN = new Set(['locking', 'locked', 'offered', 'refunding']);

export function makeBtcSwapDesk(ctx) {
  const { seed, store, quotes, btc, inventory } = ctx;
  const P = { ...S.DEFAULTS, maxSessions: 4, acceptWaitSecs: 6 * 3600, validSecs: 600, feeBps: 30, flatFee: 0n, minConfsFor: () => 1, ...ctx.policy };
  const log = ctx.log || (() => {}), alert = ctx.alert || (() => {});
  const deskPub = hx(btc.wallet.pub);
  const sid = (rec) => hexToBytes(rec.id);
  const mine = (rec) => S.deskSwapSecrets({ seed, swapId: sid(rec) });
  const jointOf = (rec) => S.jointLock({ prims: btc.prims, holderPub: rec.offer.holderPub, deskPub: mine(rec).pub, deskXonly: btc.wallet.xonly, csvBlocks: rec.csvDesk });
  const holderLockOf = (rec) => S.holderLock({ prims: btc.prims, deskPub, T: secp.ProjectivePoint.fromHex(strip(rec.offer.T)), holderXonly: hexToBytes(strip(rec.offer.holderPub)).slice(1), csvBlocks: rec.offer.lock.csvBlocks });
  const save = async (rec, patch) => {
    const entered = patch.phase && patch.phase !== rec.phase ? { phaseAt: ctx.now() } : {};
    Object.assign(rec, patch, entered, { updated: ctx.now() });
    await store.put(rec);
    return rec;
  };
  const queues = new Map();
  const serial = (id, fn) => {
    const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, run);
    run.catch(() => {}).finally(() => { if (queues.get(id) === run) queues.delete(id); });
    return run;
  };
  // the desk's notes are chosen one lock at a time
  let picking = Promise.resolve();
  const exclusive = (fn) => { const run = picking.catch(() => {}).then(fn); picking = run; return run; };

  const feeOf = (amount) => (BigInt(amount) * BigInt(P.feeBps)) / 10000n + BigInt(P.flatFee);

  // The notes the desk can lock: the proof follows them, and no open swap holds them.
  async function lockable() {
    const held = new Set();
    for (const r of await store.list()) if (OPEN.has(r.phase) || (r.phase === 'accepted' && r.lockPair)) for (const n of r.noteInputs || []) held.add(`${n.txid}:${n.vout}`);
    const notes = (await inventory.notes()).filter((n) => !held.has(`${n.txid}:${n.vout}`));
    const tr = await ctx.tracking(notes);
    return notes.filter((n) => tr.get(`${n.txid}:${n.vout}`) === 'tracked').sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  }
  async function available() { return (await lockable()).reduce((s, n) => s + BigInt(n.amount), 0n); }

  async function quote({ amount }) {
    const a = BigInt(amount);
    if (a < BigInt(P.minAmount) || a > BigInt(P.maxAmount)) return { ok: false, why: 'amount outside this desk\'s limits' };
    const out = a - feeOf(a);
    if (out <= 0n) return { ok: false, why: 'the amount does not cover the fee' };
    if ((await available()) < out) return { ok: false, why: 'this desk does not hold that much just now' };
    const q = { id: hx(sha256(new TextEncoder().encode(`${deskPub}|${a}|${ctx.now()}|${Math.random()}`))).slice(0, 32), asset: strip(P.asset), value: String(a), out: String(out), deskPub, csvHolder: P.csvHolder, validUntil: ctx.now() + P.validSecs };
    await quotes.put(q);
    return { ok: true, quote: q };
  }

  // The holder's offer, checked against the quote and the chain. A refusal is recomputed from the chain each time and stores
  // nothing; a swap already stored answers with its record.
  function receive({ quoteId, offer }) {
    const id = strip((offer && offer.swapId) || '');
    if (!/^[0-9a-f]{72}$/.test(id)) return Promise.resolve({ ok: false, retry: false, why: 'malformed offer: the swap id' });
    return serial(id, async () => {
      const known = await store.get(id);
      if (known) return { ok: true, rec: known };
      const no = (why, retry = false) => ({ ok: false, retry, why });
      const q = await quotes.get(String(quoteId || ''));
      if (!q) return no('unknown quote');
      if (ctx.now() > q.validUntil) return no('quote expired');
      const l = offer.lock || {};
      const tx = /^[0-9a-f]{64}$/.test(strip(l.txid || '')) ? await btc.fetchTx(strip(l.txid)) : null;
      if (!tx) return no('the lock transaction is not on the chain', true);
      const out = tx.vout[l.vout];
      if (!out || !Number.isInteger(out.value) || out.value < DUST_P2TR) return no('the lock output carries no spendable amount');
      const note = await btc.resolveNote(strip(l.txid), l.vout);
      const st = await btc.status(strip(l.txid));
      const chain = {
        spk: out.scriptpubkey, commitment: note ? hx(note.commitment) : '', validNote: !!note && strip(note.assetIdHex) === strip(P.asset),
        confirmations: st.confirmations, height: st.height, tip: await btc.tip(), noteInputs: tx.vin.slice(1).map((i) => ({ txid: i.txid, vout: i.vout })),
      };
      const v = S.checkHolderOffer(offer, { prims: btc.prims, deskPub, expect: { asset: q.asset, value: q.value, out: q.out }, chain, minConfs: 0, policy: P });
      if (!v.ok) return no(v.reasons.join('; '));
      if (await btc.outspend(strip(l.txid), l.vout)) return no('the lock is spent');
      const consumed = await btc.crossLaneBlocked(tx);
      if (consumed) return no('a spent note is already consumed on Ethereum: ' + consumed);
      const rec = { v: 1, role: 'desk', id, phase: 'accepted', created: ctx.now(), updated: ctx.now(), quoteId: q.id, offer, csvDesk: P.csvDesk, sessions: [] };
      await store.put(rec);
      return { ok: true, rec };
    });
  }

  // What the published signature says: t, or nothing this desk gave a half to.
  async function readClaim(rec, spender) {
    const tx = await btc.fetchTx(spender);
    const vin = tx && tx.vin.find((i) => i.txid === rec.lock.txid && i.vout === rec.lock.vout);
    if (!vin) return null;
    return S.extractT({ witness: vin.witness, sessions: rec.sessions, keys: jointOf(rec).keys, T: secp.ProjectivePoint.fromHex(strip(rec.offer.T)) });
  }

  async function spentLock(rec, spender) {
    if (rec.refund && spender === rec.refund.txid) return save(rec, { phase: 'refunding' });
    const t = await readClaim(rec, spender);
    if (t) return save(rec, { phase: 'taking', t: t.toString(16).padStart(64, '0'), claimedBy: spender });
    alert({ level: 'alert', msg: 'the desk\'s lock was spent and t could not be read', id: rec.id, spender });
    return save(rec, { phase: 'lost', claimedBy: spender });
  }

  async function advance(rec) {
    const l = rec.offer.lock;
    switch (rec.phase) {
      case 'accepted': {
        if (await btc.outspend(l.txid, l.vout)) return save(rec, { phase: 'aborted', why: 'the holder\'s lock was spent' });
        const st = await btc.status(l.txid), tip = await btc.tip();
        if (st.confirmations < P.minConfsFor(BigInt(l.value))) {
          return ctx.now() - rec.created > P.acceptWaitSecs ? save(rec, { phase: 'aborted', why: 'the holder\'s lock did not confirm' }) : rec;
        }
        if (st.height + l.csvBlocks - 1 < tip + P.lockDelayBlocks + rec.csvDesk + P.takeMarginBlocks) return save(rec, { phase: 'aborted', why: 'the holder\'s refund opens too soon to lock against' });
        if (!rec.lockPair) {
          const pair = await exclusive(async () => {
            const want = BigInt(rec.offer.out), notes = [];
            let sum = 0n;
            for (const n of await lockable()) { if (sum >= want) break; notes.push(n); sum += BigInt(n.amount); }
            if (sum < want) return null;
            const p = btc.tx.lockTransfer({ asset: hexToBytes(strip(P.asset)), notes, lock: jointOf(rec), lockAmount: want, rLock: mine(rec).rLock, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate() });
            await save(rec, { lockPair: { txid: p.revealTxid, vout: 0, value: p.revealTx.outputs[0].value, commitTxid: p.commitTxid, commitHex: p.commitHex, revealHex: p.revealHex }, noteInputs: notes.map((n) => ({ txid: n.txid, vout: n.vout })) });
            return p;
          });
          if (!pair) {
            if (!rec.short) { alert({ level: 'warn', msg: 'the desk holds too little tracked TAC for a swap', id: rec.id, want: rec.offer.out }); await save(rec, { short: true }); }
            return ctx.now() - rec.created > P.acceptWaitSecs ? save(rec, { phase: 'aborted', why: 'the desk could not lock in time' }) : rec;
          }
        }
        return save(rec, { phase: 'locking', lock: rec.lockPair });
      }
      case 'locking': {
        await btc.broadcast({ ...rec.lock, revealTxid: rec.lock.txid });
        return save(rec, { phase: 'locked' });
      }
      case 'locked': {
        const st = await btc.status(rec.lock.txid);
        if (!st.confirmations) { await btc.broadcast({ ...rec.lock, revealTxid: rec.lock.txid }); return rec; }
        const deskOffer = S.makeDeskOffer({ swapId: sid(rec), asset: P.asset, amount: BigInt(rec.offer.out), rLock: mine(rec).rLock, txid: rec.lock.txid, vout: rec.lock.vout, csvBlocks: rec.csvDesk, deskXonly: btc.wallet.xonly, musigPub: mine(rec).pub });
        return save(rec, { phase: 'offered', lockHeight: st.height, deskOffer });
      }
      case 'offered': {
        const by = await btc.outspend(rec.lock.txid, rec.lock.vout);
        if (by) return spentLock(rec, by);
        if ((await btc.tip()) < rec.lockHeight + rec.csvDesk - 1) return rec;
        if (!rec.refund) {
          const pair = btc.tx.refundTransfer({
            asset: hexToBytes(strip(P.asset)), lockOut: { txid: rec.lock.txid, vout: rec.lock.vout, value: rec.lock.value }, lock: jointOf(rec), dLocker: btc.wallet.priv,
            amount: BigInt(rec.offer.out), rLock: mine(rec).rLock, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
          });
          await save(rec, { refund: { txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex } });
        }
        await btc.broadcast({ ...rec.refund, revealTxid: rec.refund.txid });
        return save(rec, { phase: 'refunding' });
      }
      case 'refunding': {
        const by = await btc.outspend(rec.lock.txid, rec.lock.vout);
        if (by && by !== rec.refund.txid) return spentLock(rec, by);
        if (by && (await btc.status(by)).confirmations) return save(rec, { phase: 'refunded' });
        await btc.broadcast({ ...rec.refund, revealTxid: rec.refund.txid });
        return rec;
      }
      case 'taking': {
        if (!rec.take) {
          const lock = holderLockOf(rec);
          const sk = claimSecret({ dClaimer: btc.wallet.priv, t: BigInt('0x' + rec.t), lock });
          const pair = btc.tx.claimTransfer({
            asset: hexToBytes(strip(P.asset)), lockOut: { txid: l.txid, vout: l.vout, value: (await btc.fetchTx(l.txid)).vout[l.vout].value }, lock, sk,
            amount: BigInt(l.value), rLock: BigInt('0x' + l.rLock), satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
          });
          await save(rec, { take: { txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex } });
        }
        const by = await btc.outspend(l.txid, l.vout);
        if (by && by !== rec.take.txid) {
          alert({ level: 'alert', msg: 'the holder took its lock back before the desk could open it', id: rec.id, spender: by });
          return save(rec, { phase: 'lost', why: 'the holder refunded first' });
        }
        if (by && (await btc.status(by)).confirmations) return save(rec, { phase: 'done', doneAt: ctx.now() });
        await btc.broadcast({ ...rec.take, revealTxid: rec.take.txid });
        return rec;
      }
      default:
        return rec;
    }
  }

  function step(rec) {
    return serial(rec.id, async () => {
      const cur = (await store.get(rec.id)) || rec;
      try { return await advance(cur); } catch (e) { return save(cur, { lastError: String((e && e.message) || e).slice(0, 300) }); }
    });
  }

  // ── the claim's signature, two rounds ──
  const signable = async (rec) => rec.phase === 'offered' && (await btc.tip()) < rec.lockHeight + rec.csvDesk - 1 - P.signStopBlocks && !(await btc.outspend(rec.lock.txid, rec.lock.vout));
  const authed = (rec, path, body) => S.checkRequest({ holderPub: rec.offer.holderPub, id: rec.id, path, body: Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'auth')), auth: body.auth });

  function nonce(id, body) {
    return serial(id, async () => {
      const rec = await store.get(id);
      if (!rec) return { status: 404, body: { error: 'unknown swap' } };
      if (!body || !/^[0-9a-f]{64}$/.test(strip(body.msg || '')) || !/^[0-9a-f]{132}$/.test(strip(body.pubnonce || ''))) return { status: 400, body: { error: 'msg and pubnonce are required' } };
      if (!authed(rec, 'nonce', { msg: body.msg, pubnonce: body.pubnonce, auth: body.auth })) return { status: 403, body: { error: 'not signed by the holder' } };
      const have = rec.sessions.find((s) => s.msg === strip(body.msg) && s.holderNonce === strip(body.pubnonce));
      if (have) return { status: 200, body: { pubnonce: have.deskNonce } };
      if (!(await signable(rec))) return { status: 409, body: { error: 'this swap no longer takes a claim' } };
      if (rec.sessions.length >= P.maxSessions) return { status: 409, body: { error: 'too many signing sessions for this swap' } };
      const n = M.nonceGen({ sk: bigintToBytes32(mine(rec).d), pk: mine(rec).pub, aggXonly: jointOf(rec).keys.xonly, msg: hexToBytes(strip(body.msg)) });
      rec.sessions.push({ msg: strip(body.msg), holderNonce: strip(body.pubnonce), deskNonce: hx(n.pubnonce), sec: hx(n.secnonce) });
      await save(rec, { sessions: rec.sessions });
      return { status: 200, body: { pubnonce: hx(n.pubnonce) } };
    });
  }

  function sign(id, body) {
    return serial(id, async () => {
      const rec = await store.get(id);
      if (!rec) return { status: 404, body: { error: 'unknown swap' } };
      if (!body || !/^[0-9a-f]{132}$/.test(strip(body.pubnonce || '')) || !/^[0-9a-f]{64}$/.test(strip(body.psig || ''))) return { status: 400, body: { error: 'pubnonce and psig are required' } };
      if (!authed(rec, 'sign', { pubnonce: body.pubnonce, psig: body.psig, auth: body.auth })) return { status: 403, body: { error: 'not signed by the holder' } };
      const s = rec.sessions.find((x) => x.holderNonce === strip(body.pubnonce));
      if (!s) return { status: 404, body: { error: 'no such session' } };
      if (s.deskPsig) return s.holderPsig === strip(body.psig) ? { status: 200, body: { psig: s.deskPsig } } : { status: 409, body: { error: 'this session has signed already' } };
      if (!(await signable(rec))) return { status: 409, body: { error: 'this swap no longer takes a claim' } };
      const keys = jointOf(rec).keys;
      const sess = M.session({ keys, pubnonces: [hexToBytes(s.holderNonce), hexToBytes(s.deskNonce)], msg: hexToBytes(s.msg), T: secp.ProjectivePoint.fromHex(strip(rec.offer.T)) });
      if (!M.partialVerify({ psig: hexToBytes(strip(body.psig)), pubnonce: hexToBytes(s.holderNonce), pk: hexToBytes(strip(rec.offer.holderPub)), sess })) return { status: 400, body: { error: 'the holder\'s half does not verify' } };
      const mineP = M.partialSign({ secnonce: hexToBytes(s.sec), sk: mine(rec).d, sess });
      const sPre = M.partialAgg({ psigs: [hexToBytes(strip(body.psig)), mineP], sess });
      if (!M.preVerify({ sPre, sess })) return { status: 500, body: { error: 'the pre-signature does not verify' } };
      Object.assign(s, { sec: null, holderPsig: strip(body.psig), deskPsig: hx(mineP), sPre: sPre.toString(16).padStart(64, '0'), pubnonces: [s.holderNonce, s.deskNonce] });
      await save(rec, { sessions: rec.sessions });
      return { status: 200, body: { psig: hx(mineP) } };
    });
  }

  const statusOf = async (id) => {
    const rec = await store.get(id);
    return rec ? { phase: rec.phase, why: rec.why || null, deskOffer: rec.deskOffer || null } : null;
  };

  async function tick() {
    for (const rec of await store.list()) {
      if (TERMINAL.has(rec.phase)) continue;
      const before = rec.phase;
      const next = await step(rec);
      if (next.phase !== before) log({ level: 'info', msg: 'swap', id: next.id, from: before, to: next.phase, why: next.why || null });
      if (next.lastError && next.lastError !== rec.lastError) log({ level: 'warn', msg: 'swap step failed', id: next.id, phase: next.phase, error: next.lastError });
    }
  }

  const reply = (body, status = 200) => ({ status, body });
  async function handle({ method, path, body }) {
    try {
      if (method === 'GET' && path === '/info') {
        const a = await available().catch(() => null);
        return reply({ v: 1, deskPub, asset: strip(P.asset), minAmount: String(P.minAmount), maxAmount: String(P.maxAmount), feeBps: P.feeBps, flatFee: String(P.flatFee), csvHolder: P.csvHolder, csvDesk: P.csvDesk, available: a == null ? null : String(a) });
      }
      if (method === 'POST' && path === '/quote') {
        if (!body || !/^\d{1,30}$/.test(String(body.amount))) return reply({ error: 'amount must be a whole number' }, 400);
        const r = await quote({ amount: body.amount });
        return reply(r.ok ? r.quote : { ok: false, why: r.why });
      }
      if (method === 'POST' && path === '/offer') {
        if (!body || typeof body.quoteId !== 'string' || !body.offer || typeof body.offer !== 'object') return reply({ error: 'quoteId and offer are required' }, 400);
        const r = await receive({ quoteId: body.quoteId, offer: body.offer });
        return reply(r.ok ? { ok: true, phase: r.rec.phase } : { ok: false, retry: !!r.retry, why: r.why });
      }
      const m = /^\/swap\/([0-9a-f]{72})(?:\/(nonce|sign))?$/.exec(path);
      if (m && method === 'GET' && !m[2]) { const s = await statusOf(m[1]); return s ? reply(s) : reply({ error: 'unknown swap' }, 404); }
      if (m && method === 'POST' && m[2] === 'nonce') return await nonce(m[1], body);
      if (m && method === 'POST' && m[2] === 'sign') return await sign(m[1], body);
      return reply({ error: 'not found' }, 404);
    } catch (e) {
      log({ level: 'error', msg: 'request failed', method, path, error: String((e && e.message) || e).slice(0, 200) });
      return reply({ error: 'the desk could not answer' }, 500);
    }
  }

  return { quote, receive, step, tick, nonce, sign, status: statusOf, handle, available };
}

// The holder's view of a desk over HTTP (`base` its URL): what dapp/btcswap-holder.js calls `desk`.
export function deskClient({ base, fetchImpl = fetch, timeoutMs = 20000 }) {
  const url = base.replace(/\/$/, '');
  const call = async (method, path, body) => {
    const r = await fetchImpl(url + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 404) throw Object.assign(new Error(j.error || `the desk answered ${r.status}`), { status: r.status });
    return r.status === 404 ? null : j;
  };
  return {
    info: () => call('GET', '/info'),
    quote: (amount) => call('POST', '/quote', { amount: String(amount) }),
    offer: (b) => call('POST', '/offer', b),
    status: (id) => call('GET', `/swap/${id}`),
    nonce: (id, b) => call('POST', `/swap/${id}/nonce`, b),
    sign: (id, b) => call('POST', `/swap/${id}/sign`, b),
  };
}
