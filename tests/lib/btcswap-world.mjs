// A world for the Bitcoin-to-Bitcoin swap machines (dapp/btcswap-holder.js, dapp/btcswap-desk.js): a simulated Bitcoin on one
// virtual clock (tests/lib/chain-sim.mjs), real commit/reveal transactions run through the real note validator, a holder with a
// note the proof does not follow and a desk with notes it does, and both machines over stores that go through JSON. Node 22.

import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit, txFromJson } from '../../dapp/adaptor-btc-tx.js';
import { makeBtcSwapHolder } from '../../dapp/btcswap-holder.js';
import { makeBtcSwapDesk } from '../../dapp/btcswap-desk.js';
import { makePledges } from '../../btcswap-desk/pledges.mjs';
import * as S from '../../dapp/btcswap.js';
import * as M from '../../dapp/musig2.js';
import { bigintToBytes32 } from '../../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { tacit, te, scalar, etchNote, cxfer } from './btc-sim.mjs';
import { makeClock, makeBitcoinSim, partyKeys, sha256 } from './chain-sim.mjs';
import { memStore } from './fastbridge-world.mjs';

export const SUPPLY = 1_000_000n, HELD = 50_000n, PLEDGER_NOTE = 100_000n, RESERVE_NOTE = 100_000n;

// A provider's holdings after N bridges, with and without the desk: each bridge is one note of `noteTAC` TAC, a share
// `stuckShare` of them stuck. Without the desk the stuck notes sit; with it they swap at the discount, less the desk's
// fee. The desk ends holding the stuck notes it took, and owes its pledgers what it drew plus the return. Deterministic.
export function projectProvider({ n, discountBps, stuckShare = 0.05, noteTAC = 100n, feeBps = 30, flatFee = 1n, returnBps = 50, seed = 1 }) {
  const TAC = 100_000_000n;
  const note = noteTAC * TAC, fee = (note * BigInt(feeBps)) / 10000n + flatFee * TAC, discount = (note * BigInt(discountBps)) / 10000n;
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 0x100000000;
  let ethWith = 0n, ethWithout = 0n, stuckWithout = 0n, deskStuck = 0n, deskDrawn = 0n, bridges = 0;
  for (let i = 0; i < n; i++) {
    if (rnd() < stuckShare) { stuckWithout += note; ethWith += note - fee - discount; deskStuck += note; deskDrawn += note - fee - discount; bridges++; }
    else { ethWith += note; ethWithout += note; }
  }
  return { n, discountBps, bridges, ethWith, ethWithout, stuckWith: 0n, stuckWithout, deskStuck, deskOwed: deskDrawn + (deskDrawn * BigInt(returnBps)) / 10000n };
}

export function world({ desk: deskOver = {}, holder: holderOver = {}, tracked = null, pledge: pledgeOver = {} } = {}) {
  const clock = makeClock();
  const btc = makeBitcoinSim(clock);
  const kit = tacitKit(tacit);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const hW = wallet('holder'), dW = wallet('desk'), pW = wallet('pledger');

  // Every reveal a builder makes (and the claim once signed), by txid: the sim sends the decoded reveal.
  const reveals = new Map();
  const recording = (b) => {
    const wrap = (fn) => (...a) => { const p = fn(...a); reveals.set(p.revealTxid, p.revealTx); return p; };
    return { ...b, lockTransfer: wrap(b.lockTransfer), claimTransfer: wrap(b.claimTransfer), refundTransfer: wrap(b.refundTransfer), jointClaimTransfer: wrap(b.jointClaimTransfer), payTransfer: wrap(b.payTransfer),
      withKeyPathSig: (a) => { const r = b.withKeyPathSig(a); reveals.set(txidOf(r.revealTx), r.revealTx); return r; } };
  };
  const txidOf = (tx) => hW.prims.txid(tx);
  let coinN = 0;
  const sats = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];
  const adapter = (W) => {
    const a = btc.adapter({ prims: W.prims, builder: recording(makeAdaptorBtcTx({ prims: W.prims, kit })), sats });
    a.broadcast = async (p) => {
      const id = p.revealTxid || p.txid;
      const tx = p.revealJson ? txFromJson(p.revealJson) : reveals.get(id);
      if (!tx) throw new Error('btcswap-world: a reveal no builder made');
      return btc.broadcast({ revealTxid: id, revealTx: tx });
    };
    return a;
  };
  const hBtc = adapter(hW), dBtc = adapter(dW), pBtc = adapter(pW);

  // The asset: etched to the desk, which pays the holder a note of it (the holder's history is what the proof does not follow).
  const rE = scalar('etch'), rH = scalar('holder/note'), rD = scalar('desk/note'), rP = scalar('pledger/note'), rP2 = scalar('pledger/note2'), rD2 = scalar('desk/note2'), rR = scalar('reserve/note');
  const etch = etchNote({ ticker: 'TS', value: SUPPLY, r: rE, script: dW.prims.p2wpkhScript(dW.wallet.pub) });
  btc.addConfirmed(etch);
  const split = cxfer(etch.asset, [{ txid: etch.txid, vout: 0, value: 546, spk: dW.prims.p2wpkhScript(dW.wallet.pub), r: rE, sign: (tx, i, prev) => dW.prims.signP2wpkhInput(tx, i, prev[i].value) }],
    [{ value: HELD, r: rH, script: hW.prims.p2wpkhScript(hW.wallet.pub) }, { value: SUPPLY - HELD, r: rD, script: dW.prims.p2wpkhScript(dW.wallet.pub) }]);
  btc.addConfirmed(split);
  const holderNote = { txid: split.txid, vout: 0, value: 546, amount: HELD, blinding: rH, height: btc.tip };
  // The pledger's tracked notes, carved from the desk's: the desk keeps the rest as its owned inventory, and a reserve note
  // the operator can move in later (a top-up, for the repayment test).
  const carve = cxfer(etch.asset, [{ txid: split.txid, vout: 1, value: 546, spk: dW.prims.p2wpkhScript(dW.wallet.pub), r: rD, sign: (tx, i, prev) => dW.prims.signP2wpkhInput(tx, i, prev[i].value) }],
    [{ value: PLEDGER_NOTE, r: rP, script: pW.prims.p2wpkhScript(pW.wallet.pub) }, { value: PLEDGER_NOTE, r: rP2, script: pW.prims.p2wpkhScript(pW.wallet.pub) }, { value: SUPPLY - HELD - 2n * PLEDGER_NOTE - RESERVE_NOTE, r: rD2, script: dW.prims.p2wpkhScript(dW.wallet.pub) }, { value: RESERVE_NOTE, r: rR, script: dW.prims.p2wpkhScript(dW.wallet.pub) }]);
  btc.addConfirmed(carve);
  const pledgerNote = { txid: carve.txid, vout: 0, value: 546, amount: PLEDGER_NOTE, blinding: rP, height: btc.tip };
  const pledgerNote2 = { txid: carve.txid, vout: 1, value: 546, amount: PLEDGER_NOTE, blinding: rP2, height: btc.tip };
  const deskNote = { txid: carve.txid, vout: 2, value: 546, amount: SUPPLY - HELD - 2n * PLEDGER_NOTE - RESERVE_NOTE, blinding: rD2, height: btc.tip };
  const reserveNote = { txid: carve.txid, vout: 3, value: 546, amount: RESERVE_NOTE, blinding: rR, height: btc.tip };
  const asset = bytesToHex(etch.asset);

  // What the proof follows: the desk's note and the pledger's note; a test widens or narrows it. Everything else confirmed is 'new' until a test says.
  const follows = new Set(tracked || [`${deskNote.txid}:${deskNote.vout}`, `${pledgerNote.txid}:${pledgerNote.vout}`, `${pledgerNote2.txid}:${pledgerNote2.vout}`, `${reserveNote.txid}:${reserveNote.vout}`]);
  const tracking = (who) => async (notes) => new Map(notes.map((n) => {
    const k = `${n.txid}:${n.vout}`;
    if (w.trackingOf?.[who]) return [k, w.trackingOf[who](k)];
    return [k, follows.has(k) ? 'tracked' : k === `${holderNote.txid}:${holderNote.vout}` ? 'untracked' : 'new'];
  }));

  const deskPolicy = { asset, minAmount: 1000n, maxAmount: 10_000_000n, feeBps: 30, flatFee: 10n, csvHolder: 288, csvDesk: 144, minConfsFor: () => 1,
    discountBps: { clean: 0, 'long-history': 150, 'pool-exit': 300 }, discountMaxBps: 500, ...deskOver };
  const holderPolicy = { csvBlocks: 288, minConfs: 2, ...holderOver };
  const pledgeConfig = { csvPledge: 144, minConfs: 2, pledgeReturnBps: 50, ...pledgeOver };
  const w = {
    clock, btc, etch, asset, hW, dW, pW, hBtc, dBtc, pBtc, holderNote, deskNote, pledgerNote, pledgerNote2, reserveNote, follows, reveals,
    holderStore: memStore(), deskStore: memStore(), quoteStore: memStore(), pledgeStore: memStore(),
    deskUp: true, deskOnline: true, holderOnline: true, traceClass: {}, refuseSign: new Set(),
  };
  // The trace of a note's history, as the reflection API would answer it: a test names the class of the note it cares
  // about (the holder's, usually), and the trace carries the shape classOfTrace reads.
  const trace = async (note) => {
    const cls = w.traceClass[`${note.txid}:${note.vout}`];
    if (cls === 'pool-exit') return { bundle: { cxfers: [{ opcode: '0x6d' }] } };
    if (cls === 'long-history') return { hops: 300 };
    return { hops: 3 };
  };
  // The pledger's half of a draw's signature, as tools/pledge-signer.mjs runs it: the amount, the discount and the swap
  // are checked against the pledge and the desk's record before anything is signed, and a refusal is a null.
  const pledgerSign = async (req) => {
    if (w.refuseSign?.has(req.pledgeId)) return null;
    const pledge = await w.pledges.get(req.pledgeId);
    if (!pledge) return null;
    const remaining = BigInt(pledge.amount) - BigInt(pledge.drawn) - pledge.draws.filter((d) => ['allocated', 'requested', 'broadcast'].includes(d.phase)).reduce((s, d) => s + BigInt(d.amount), 0n);
    if (BigInt(req.amount) > remaining || req.discountBps > pledge.maxDiscountBps) return null;
    const swap = await w.deskStore.get(req.swapId);
    if (!swap || swap.phase !== 'accepted') return null;
    const reveal = txFromJson(req.revealJson);
    const deskScript = bytesToHex(dW.prims.p2wpkhScript(dW.wallet.pub));
    if (reveal.inputs[1].txid !== pledge.lock.txid || reveal.inputs[1].vout !== pledge.lock.vout) return null;
    if (bytesToHex(reveal.outputs[0].script) !== deskScript) return null;
    const joint = S.jointLock({ prims: pW.prims, holderPub: pledge.pledgerPub, deskPub: pledge.joint.deskPub, deskXonly: pledge.joint.refundXonly, csvBlocks: pledge.csvBlocks, refundXonly: pledge.joint.refundXonly });
    const nonce = M.nonceGen({ sk: pW.prims.wallet.priv, pk: pW.prims.wallet.pub, aggXonly: joint.keys.xonly, msg: hexToBytes(req.sighash) });
    const sess = M.session({ keys: joint.keys, pubnonces: [hexToBytes(req.deskNonce), nonce.pubnonce], msg: hexToBytes(req.sighash), T: null });
    return { pubnonce: bytesToHex(nonce.pubnonce), psig: bytesToHex(M.partialSign({ secnonce: nonce.secnonce, sk: pW.prims.wallet.priv, sess })) };
  };
  // The desk's inventory: its notes, spent ones left out (as makeOwnNotes does), and a drawn note joins it once confirmed.
  const deskInventory = { notes: async () => { const out = []; for (const n of w.deskNotes) { if (!(await btc.outspend(n.txid, n.vout))) out.push(n); } return out; },
    add: async (note) => { w.deskNotes.push(note); follows.add(`${note.txid}:${note.vout}`); } };
  w.pledges = makePledges({ seed: partyKeys('desk').seed, store: w.pledgeStore, btc: dBtc,
    inventory: deskInventory,
    tracking: tracking('desk'), signer: pledgerSign, log: () => {}, asset, config: pledgeConfig });
  w.makeDesk = () => makeBtcSwapDesk({
    seed: partyKeys('desk').seed, now: clock.now, policy: deskPolicy, store: w.deskStore, quotes: w.quoteStore, btc: dBtc,
    inventory: deskInventory,
    tracking: tracking('desk'), pledges: w.pledges, trace, log: (o) => { if (process.env.TRACE && o.level !== 'info') console.log('  desk', JSON.stringify(o)); }, alert: (a) => (w.alerts ||= []).push(a),
  });
  w.deskNotes = [deskNote];
  w.desk = w.makeDesk();
  // Fund a pledge of a pledger note: offer, lock the note into the joint lock, fund it. Returns the pledge id.
  w.pledge = async (amount = PLEDGER_NOTE, maxDiscountBps = 500, note = pledgerNote) => {
    const o = await viaHttp('POST', '/pledge', { pledgerPub: bytesToHex(pW.prims.wallet.pub), pledgerXonly: bytesToHex(pW.prims.wallet.pub.slice(1)), amount: String(amount), maxDiscountBps });
    const joint = S.jointLock({ prims: pW.prims, holderPub: pW.prims.wallet.pub, deskPub: hexToBytes(o.deskPub), deskXonly: pW.prims.wallet.pub.slice(1), csvBlocks: o.csvBlocks, refundXonly: pW.prims.wallet.pub.slice(1) });
    const pair = pBtc.tx.lockTransfer({ asset: hexToBytes(asset), notes: [note], lock: joint, lockAmount: BigInt(amount), rLock: BigInt('0x' + o.rLock), satsUtxos: await pBtc.satsUtxos(), feeRate: await pBtc.feeRate() });
    await pBtc.broadcast({ ...pair, revealTxid: pair.revealTxid });
    btc.mine(2);
    const r = await viaHttp('POST', `/pledge/${o.pledgeId}/lock`, { lock: { txid: pair.revealTxid, vout: 0 } });
    if (!r.ok) throw new Error('pledge did not fund: ' + r.why);
    return o.pledgeId;
  };
  const reach = (fn) => async (...a) => { if (!w.deskUp) throw new Error('the desk is unreachable'); return fn(...a); };
  const viaHttp = (method, path, body) => w.desk.handle({ method, path, body: JSON.parse(JSON.stringify(body ?? null)) }).then((r) => {
    if (r.status >= 400 && r.status !== 404) throw Object.assign(new Error(r.body.error || r.body.why || `HTTP ${r.status}`), { status: r.status });
    return r.status === 404 ? null : r.body;
  });
  w.deskApi = {
    offer: reach((b) => viaHttp('POST', '/offer', b)),
    status: reach((id) => viaHttp('GET', `/swap/${id}`)),
    nonce: reach((id, b) => viaHttp('POST', `/swap/${id}/nonce`, b)),
    sign: reach((id, b) => viaHttp('POST', `/swap/${id}/sign`, b)),
  };
  w.holder = makeBtcSwapHolder({ seed: partyKeys('holder').seed, now: clock.now, policy: holderPolicy, store: w.holderStore, btc: hBtc, desk: w.deskApi, tracking: tracking('holder') });
  w.h = async () => (await w.holderStore.list())[0];
  w.d = async () => (await w.deskStore.list())[0];
  w.start = async (amount = HELD, note = null) => {
    const q = await viaHttp('POST', '/quote', { amount: String(amount), ...(note ? { note: { txid: note.txid, vout: note.vout } } : {}) });
    if (!q.id) throw new Error('no quote: ' + q.why);
    return w.holder.start({ asset: etch.asset, amount, notes: [holderNote], quote: q });
  };
  w.step = async () => {
    if (w.holderOnline) for (const r of await w.holderStore.list()) await w.holder.step(r);
    if (w.deskOnline) await w.desk.tick();
  };
  let ticks = 0;
  w.run = async (until, max = 6000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      if (process.env.TRACE) { const h = await w.h(), d = await w.d(), k = `${h?.phase}/${d?.phase}|${h?.lastError || ''}|${d?.lastError || ''}|${h?.waiting || ''}`; if (k !== w._k) { w._k = k; console.log(`  t${i} tip ${btc.tip}: ${k}`); } }
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: holder ' + JSON.stringify(await w.h()).slice(0, 600) + ' desk ' + JSON.stringify(await w.d()).slice(0, 600));
  };
  w.noteOf = (txid, vout) => btc.resolveNote(txid, vout);
  return w;
}
