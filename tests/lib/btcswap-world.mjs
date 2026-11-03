// A world for the Bitcoin-to-Bitcoin swap machines (dapp/btcswap-holder.js, dapp/btcswap-desk.js): a simulated Bitcoin on one
// virtual clock (tests/lib/chain-sim.mjs), real commit/reveal transactions run through the real note validator, a holder with a
// note the proof does not follow and a desk with notes it does, and both machines over stores that go through JSON. Node 22.

import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit, txFromJson } from '../../dapp/adaptor-btc-tx.js';
import { makeBtcSwapHolder } from '../../dapp/btcswap-holder.js';
import { makeBtcSwapDesk } from '../../dapp/btcswap-desk.js';
import { bigintToBytes32 } from '../../dapp/bulletproofs.js';
import { bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { tacit, te, scalar, etchNote, cxfer } from './btc-sim.mjs';
import { makeClock, makeBitcoinSim, partyKeys, sha256 } from './chain-sim.mjs';
import { memStore } from './fastbridge-world.mjs';

export const SUPPLY = 1_000_000n, HELD = 50_000n;

export function world({ desk: deskOver = {}, holder: holderOver = {}, tracked = null } = {}) {
  const clock = makeClock();
  const btc = makeBitcoinSim(clock);
  const kit = tacitKit(tacit);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const hW = wallet('holder'), dW = wallet('desk');

  // Every reveal a builder makes (and the claim once signed), by txid: the sim sends the decoded reveal.
  const reveals = new Map();
  const recording = (b) => {
    const wrap = (fn) => (...a) => { const p = fn(...a); reveals.set(p.revealTxid, p.revealTx); return p; };
    return { ...b, lockTransfer: wrap(b.lockTransfer), claimTransfer: wrap(b.claimTransfer), refundTransfer: wrap(b.refundTransfer), jointClaimTransfer: wrap(b.jointClaimTransfer),
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
  const hBtc = adapter(hW), dBtc = adapter(dW);

  // The asset: etched to the desk, which pays the holder a note of it (the holder's history is what the proof does not follow).
  const rE = scalar('etch'), rH = scalar('holder/note'), rD = scalar('desk/note');
  const etch = etchNote({ ticker: 'TS', value: SUPPLY, r: rE, script: dW.prims.p2wpkhScript(dW.wallet.pub) });
  btc.addConfirmed(etch);
  const split = cxfer(etch.asset, [{ txid: etch.txid, vout: 0, value: 546, spk: dW.prims.p2wpkhScript(dW.wallet.pub), r: rE, sign: (tx, i, prev) => dW.prims.signP2wpkhInput(tx, i, prev[i].value) }],
    [{ value: HELD, r: rH, script: hW.prims.p2wpkhScript(hW.wallet.pub) }, { value: SUPPLY - HELD, r: rD, script: dW.prims.p2wpkhScript(dW.wallet.pub) }]);
  btc.addConfirmed(split);
  const holderNote = { txid: split.txid, vout: 0, value: 546, amount: HELD, blinding: rH, height: btc.tip };
  const deskNote = { txid: split.txid, vout: 1, value: 546, amount: SUPPLY - HELD, blinding: rD, height: btc.tip };
  const asset = bytesToHex(etch.asset);

  // What the proof follows: the desk's note; a test widens or narrows it. Everything else confirmed is 'new' until a test says.
  const follows = new Set(tracked || [`${deskNote.txid}:${deskNote.vout}`]);
  const tracking = (who) => async (notes) => new Map(notes.map((n) => {
    const k = `${n.txid}:${n.vout}`;
    if (w.trackingOf?.[who]) return [k, w.trackingOf[who](k)];
    return [k, follows.has(k) ? 'tracked' : k === `${holderNote.txid}:${holderNote.vout}` ? 'untracked' : 'new'];
  }));

  const deskPolicy = { asset, minAmount: 1000n, maxAmount: 10_000_000n, feeBps: 30, flatFee: 10n, csvHolder: 288, csvDesk: 144, minConfsFor: () => 1, ...deskOver };
  const holderPolicy = { csvBlocks: 288, minConfs: 2, ...holderOver };
  const w = {
    clock, btc, etch, asset, hW, dW, hBtc, dBtc, holderNote, deskNote, follows, reveals,
    holderStore: memStore(), deskStore: memStore(), quoteStore: memStore(),
    deskUp: true, deskOnline: true, holderOnline: true,
  };
  w.makeDesk = () => makeBtcSwapDesk({
    seed: partyKeys('desk').seed, now: clock.now, policy: deskPolicy, store: w.deskStore, quotes: w.quoteStore, btc: dBtc,
    inventory: { notes: async () => w.deskNotes }, tracking: tracking('desk'), log: (o) => { if (process.env.TRACE && o.level !== 'info') console.log('  desk', JSON.stringify(o)); }, alert: (a) => (w.alerts ||= []).push(a),
  });
  w.deskNotes = [deskNote];
  w.desk = w.makeDesk();
  const reach = (fn) => async (...a) => { if (!w.deskUp) throw new Error('the desk is unreachable'); return fn(...a); };
  const viaHttp = (method, path, body) => w.desk.handle({ method, path, body: JSON.parse(JSON.stringify(body ?? null)) }).then((r) => {
    if (r.status >= 400 && r.status !== 404) throw Object.assign(new Error(r.body.error), { status: r.status });
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
  w.start = async (amount = HELD) => {
    const q = await viaHttp('POST', '/quote', { amount: String(amount) });
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
