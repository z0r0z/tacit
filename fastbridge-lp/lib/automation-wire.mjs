// The daemon's side of a pair provider's upkeep (lib/automation.mjs): the reads and sends it needs, made from what server.mjs already holds. Everything here
// spends only from the provider's own keys and pays only to them, with one exception that is fixed in code: the buyback send, to TacBuyback, off unless
// FB_LP_BUYBACK=on.
//
//   FB_LP_RECYCLE=off       stop moving take coins from the main address to the reverse address (on by default when the reverse side is on)
//   FB_LP_SKEW=off          quote at the market plus the fee, with no lean (on by default when the reverse side is on)
//   FB_LP_NOTES_MERGE=off   stop merging small ETH notes (on by default)
//   FB_LP_BUYBACK=on        past the target, send what the provider nets to TacBuyback (off unless set)
//   FB_LP_TARGET_ETH=<eth>  the target: this much pool ETH and Bitcoin worth as much (10 unless set; the config's `target` sets the two apart)

import { resolve } from 'node:path';
import { makeFileStore } from './store.mjs';
import { recycleConfig, makeRecycler } from './recycle.mjs';
import { skewConfig, feeAtMinBps } from './skew.mjs';
import { notesConfig } from './notes.mjs';
import { buybackConfig, targetConfig, buybackTopic } from './buyback.mjs';
import { makeAutomation } from './automation.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const lc = (h) => String(h || '').toLowerCase();
const FWD_TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);

export async function wireAutomation({ C, key, prims, btc, tacit, ux, evm, service, swapStore, quoteStore, rside, rateFeed, poolTurn, data, keccak256, log, alert, setLean, env = process.env }) {
  const cfg = { recycle: recycleConfig(C, env), skew: skewConfig(C, env), notes: notesConfig(C, env), buyback: buybackConfig(C, env), target: targetConfig(C, env) };
  if (!rside) { cfg.recycle.enabled = false; cfg.skew.enabled = false; }
  const kv = makeFileStore(resolve(data, 'upkeep'));
  const asset = lc(C.evmAsset);
  const mainSpk = hex(prims.p2wpkhScript(prims.wallet.pub));

  const recycler = rside && cfg.recycle.enabled ? makeRecycler({
    cfg: cfg.recycle, btc, fwd: swapStore, rev: rside.swaps, mainSpk, reverseSpk: hex(rside.prims.p2wpkhScript(rside.prims.wallet.pub)),
    sign: (tx, i, value) => tacit.signP2wpkhInputWithKey(tx, i, value, key, prims.wallet.pub),
    serialize: (tx) => hex(tacit.serializeTx(tx)), txidOf: (tx) => tacit.txid(tx),
    load: async () => { const r = await kv.get('recycle'); if (r) delete r.id; return r; }, save: async (s) => kv.put({ ...s, id: 'recycle' }),
    bases: C.btcBases, log, alert, onMoved: (m) => auto.onMoved(m),
  }) : null;

  // the free notes of the pool ETH (one scan, shared by the report, the merge and the buyback)
  let notesRun = null, notesAt = 0, notesLast = null;
  const ethNotes = async () => {
    if (notesLast && Date.now() - notesAt < 30000) return notesLast;
    notesRun ||= Promise.resolve(ux.balance(key, { bridge: false, cbtc: false })).then(({ byAsset }) => { notesLast = ((byAsset[asset] && byAsset[asset].notes) || []).filter((n) => BigInt(n.value) > 0n); notesAt = Date.now(); return notesLast; }).finally(() => { notesRun = null; });
    return notesRun;
  };
  // nothing under way on the forward side: no swap open, no hold, nothing promised (a merge or a send then spends no note a lock waits on)
  const quiet = async () => {
    for (const r of await swapStore.list()) if (!FWD_TERMINAL.has(r.phase)) return false;
    if (service.reservations && [...service.reservations.values()].some((r) => r.until > Math.floor(Date.now() / 1000))) return false;
    return (await service.held()) === 0n;
  };
  const isFloor = (e) => /free relayed settles|free_budget|fee below|floor/i.test(String((e && e.message) || e));
  const merge = async ({ notes, amount, fee }) => {
    const sum = notes.reduce((s, n) => s + BigInt(n.value), 0n), to = ux.identity(key).pubHex;
    try { const r = await ux.transfer({ walletPriv: key, notes, recipientPubHex: to, amount: sum, fee: 0n }); notesLast = null; return { fee: 0n, txHash: r && r.txHash }; }
    catch (e) { if (!isFloor(e) || !(fee > 0n)) throw e; }
    const r = await ux.transfer({ walletPriv: key, notes, recipientPubHex: to, amount, fee });
    notesLast = null;
    return { fee, txHash: r && r.txHash };
  };
  const sendBuyback = async ({ note, amount, to }) => {
    if (lc(to) !== cfg.buyback.to) throw new Error('the buyback address is not the fixed one: nothing sent');
    const r = await ux.sendUnwrap({ note, walletPriv: key, recipient: cfg.buyback.to, amount });
    notesLast = null;
    const block = await ux.rpc('eth_blockNumber', []).then((h) => Number(BigInt(h)), () => null);
    return { fee: r && r.fee != null ? BigInt(r.fee) : 0n, txHash: (r && r.txHash) || null, block };
  };
  const topic = buybackTopic(keccak256);
  const readBought = async (fromBlock) => {
    if (fromBlock == null) return null;
    const latest = Number(BigInt(await ux.rpc('eth_blockNumber', [])));
    if (latest < fromBlock) return null;
    const to = Math.min(latest, fromBlock + 9999);
    const logs = await ux.rpc('eth_getLogs', [{ address: cfg.buyback.to, topics: [topic], fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + to.toString(16) }]);
    const events = (logs || []).map((l) => ({ block: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.logIndex || '0x0')), tx: l.transactionHash, ethIn: BigInt('0x' + l.data.slice(2, 66)), tacOut: BigInt('0x' + l.data.slice(66, 130)) }))
      .sort((a, b) => a.block - b.block || a.index - b.index);
    return { events, toBlock: to };
  };
  const balanceAt = async (block) => BigInt(await ux.rpc('eth_getBalance', [cfg.buyback.to, '0x' + block.toString(16)]));

  const R = C.reverse || {};
  const auto = makeAutomation({
    cfg, kv, rate: () => rateFeed.rate(), fwd: swapStore, rev: rside ? rside.swaps : null,
    fwdQuote: (id) => quoteStore.get(id), revQuote: (id) => (rside ? rside.quotes.get(id) : null),
    ethFree: () => service.free(), ethNotes, btcSats: rside ? async () => (await rside.btc.satsUtxos()).reduce((s, c) => s + BigInt(c.value), 0n) : async () => null,
    txFee: async (txid) => { const t = await btc.fetchTx(txid).catch(() => null); return t && t.status && t.status.confirmed && Number.isFinite(t.fee) ? t.fee : null; },
    relayFee: () => evm.cutReserve(10n ** 10n), quiet, gate: poolTurn, merge, sendBuyback, readBought, balanceAt, recycler,
    feeAtMin: { fwd: feeAtMinBps(C.quote.minAmount, C.quote.feeBps, C.quote.flatFee), rev: R.enabled ? feeAtMinBps(R.minAmount, R.feeBps, R.flatFee) : Infinity },
    log, alert,
  });
  const tickSecs = Math.max(30, Number((C.upkeep && C.upkeep.tickSecs) || 120));
  let busy = false;
  const go = async () => { if (busy) return; busy = true; try { await auto.tick(); setLean(auto.skew()); } catch (e) { log({ level: 'error', msg: 'upkeep: a look failed', error: String((e && e.message) || e).slice(0, 200) }); } finally { busy = false; } };
  setTimeout(go, 20000).unref();
  setInterval(go, tickSecs * 1000).unref();
  log({ level: 'info', msg: 'upkeep is on', recycle: cfg.recycle.enabled, skew: cfg.skew.enabled ? cfg.skew.maxBps : 0, notesMerge: cfg.notes.enabled, buyback: cfg.buyback.enabled, targetEth: String(cfg.target.eth), tickSecs });
  // /info carries the totals, the target, the lean and the buybacks
  const wrap = (handle) => async (req) => {
    const r = await handle(req);
    if (req && req.method === 'GET' && req.path === '/info' && r && r.status === 200 && r.body && typeof r.body === 'object') { const x = auto.info(); if (x) return { ...r, body: { ...r.body, ...x } }; }
    return r;
  };
  return { auto, wrap, cfg };
}
