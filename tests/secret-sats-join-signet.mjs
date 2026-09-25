// Secret Sats Join on signet with real transactions (DESIGN-secret-sats-join.md). Local participant wallets
// each make an entry transaction to their own silent address, register through a join board, run the DC-net
// round and co-sign one join transaction; after it confirms, each wallet finds its output with its own
// silent-payment scan (tacit.js receiverScanTxForSilentPayments under the wallet's version-1 identity).
//
//   node tests/secret-sats-join-signet.mjs [fund|round|scan|report|all]   (default: all, resumable)
//
// fund   the funding wallet (~/.tacit-validation/signet.json) pays each participant's P2WPKH key; each
//        participant then makes its entry transaction: one output of o + f_in + margin to its silent address.
// round  once every entry output has AGE_MIN confirmations, every participant JOINs the board's topic for
//        (d, fr) at the tip and runs the round; the join transaction is broadcast.
// scan   after the join confirms, each participant scans it and records its output.
//
// Tier: the signet-only d = 10,000 sats at fr = 1 sat/vB, so o = 11,000 and each entry output is 11,210.
// Env: JOIN_BOARD (default https://tacit-join-board.onrender.com), PARTICIPANTS (default 8), ESPLORA
// (comma-separated), STATE_FILE, AGE_MIN (default 6), FEE_RATE (entry and funding, default 2).
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  location: dom.window.location, navigator: dom.window.navigator,
  prompt: () => null, alert: () => {}, confirm: () => false, __TACIT_NO_INIT__: true,
});
const tacit = await import('../dapp/tacit.js');
const J = await import('../dapp/secret-sats-join.js');
const { secp, sha256, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');

const HOME_V = path.join(os.homedir(), '.tacit-validation');
const WALLET_FILE = path.join(HOME_V, 'signet.json');
const STATE_FILE = process.env.STATE_FILE || path.join(HOME_V, 'secret-sats-join-signet.json');
const BOARD = (process.env.JOIN_BOARD || 'https://tacit-join-board.onrender.com').replace(/\/$/, '');
const ESPLORA = (process.env.ESPLORA || 'https://mempool.space/signet/api,https://blockstream.info/signet/api').split(',');
const N_PART = Number(process.env.PARTICIPANTS || 8);
const AGE_MIN = Number(process.env.AGE_MIN || 6);
const FEE_RATE = Number(process.env.FEE_RATE || 2);
const NET = 'signet';
const D = 10_000;
const FR = 1;
const K_MIN = J.networkParams(NET).kMin;
const ENTRY_VALUE = J.entryOutputValue({ d: D, fr: FR, kMin: K_MIN });
const ENTRY_VB = Math.ceil((42 + 272 + 172) / 4);
const FUND_EACH = ENTRY_VALUE + Math.ceil(ENTRY_VB * FEE_RATE);
const BUDGET = 120_000;

const log = (...a) => console.log(`[join-signet ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chain = J.makeEsploraChain(ESPLORA, { minGapMs: 150 });
const link = (txid) => `https://mempool.space/signet/tx/${txid}`;

// ── state (participant keys live only in the state file; nothing secret is printed) ──
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { mode: 0o600 });

function participant(i) {
  state.participants ??= [];
  if (!state.participants[i]) {
    let p; do { p = crypto.getRandomValues(new Uint8Array(32)); } while (!secp.utils.isValidPrivateKey(p));
    state.participants[i] = { walletPriv: bytesToHex(p) };
    save();
  }
  const rec = state.participants[i];
  const walletPriv = hexToBytes(rec.walletPriv);
  const pub = secp.getPublicKey(walletPriv, true);
  const sp = tacit.deriveWalletSilentPaymentKeys(walletPriv, 1);
  return { i, rec, walletPriv, pub, spk: J.p2wpkhScript(pub), sp };
}

const esplora = async (p, init) => {
  let err;
  for (const b of ESPLORA) {
    try { const r = await fetch(b.replace(/\/$/, '') + p, init); const t = await r.text(); if (r.ok) return t; err = new Error(`${p}: ${r.status} ${t.slice(0, 200)}`); if (r.status === 400) throw err; }
    catch (e) { err = e; if (/: 400 /.test(e.message)) throw e; }
  }
  throw err;
};
const utxosOf = async (addr) => JSON.parse(await esplora(`/address/${addr}/utxo`));
async function broadcast(hexTx, label) {
  try { const txid = await esplora('/tx', { method: 'POST', body: hexTx }); log(`${label}: ${link(txid)}`); return txid; }
  catch (e) { if (/already|known|in block/i.test(e.message)) return null; throw e; }
}
async function confirmations(txid) {
  const s = JSON.parse(await esplora(`/tx/${txid}/status`));
  if (!s.confirmed) return 0;
  return (await chain.tipHeight()) - s.block_height + 1;
}

// ── fund ──
async function fund() {
  const fundW = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
  const fPriv = hexToBytes(fundW.priv_hex);
  const fPub = secp.getPublicKey(fPriv, true);
  const fSpk = J.p2wpkhScript(fPub);
  const ps = Array.from({ length: N_PART }, (_, i) => participant(i));
  if (!state.fundTxid) {
    const total = N_PART * FUND_EACH;
    if (total > BUDGET) throw new Error(`budget: ${total} > ${BUDGET}`);
    // Pick coins right before broadcasting; others spend this wallet too, so retry on conflicts.
    for (let attempt = 0; attempt < 5 && !state.fundTxid; attempt++) {
      const utxos = (await utxosOf(fundW.address)).filter((u) => u.value > 1000)
        .sort((a, b) => (b.status.confirmed - a.status.confirmed) || (b.value - a.value));
      const picked = []; let sum = 0;
      for (const u of utxos) {
        picked.push(u); sum += u.value;
        const vb = Math.ceil((42 + picked.length * 272 + (N_PART + 1) * 124) / 4);
        if (sum >= total + Math.ceil(vb * FEE_RATE) + 294) break;
      }
      const vb = Math.ceil((42 + picked.length * 272 + (N_PART + 1) * 124) / 4);
      const change = sum - total - Math.ceil(vb * FEE_RATE);
      if (change < 294) throw new Error('funding wallet has too little');
      const tx = {
        version: 2, locktime: 0,
        inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: J.SEQUENCE, witness: [] })),
        outputs: [...ps.map((p) => ({ value: FUND_EACH, script: p.spk })), { value: change, script: fSpk }],
      };
      const prevouts = picked.map((u) => ({ value: u.value, script: fSpk }));
      picked.forEach((u, k) => { tx.inputs[k].witness = J.signInput(tx, k, prevouts, { type: 'p2wpkh', priv: fPriv, pub33: fPub }); });
      try {
        const hexTx = bytesToHex(J.serializeTx(tx));
        await broadcast(hexTx, `fund ${N_PART} × ${FUND_EACH}`);
        state.fundTxid = J.txidOf(tx); state.fundFee = sum - total - change; save();
      } catch (e) {
        log(`fund attempt ${attempt + 1} failed: ${e.message.slice(0, 160)}`);
        await sleep(3000);
      }
    }
    if (!state.fundTxid) throw new Error('funding failed');
  }
  // Entry transactions: one output of o + f_in + margin to the participant's own silent address.
  for (const p of ps) {
    if (p.rec.entry) continue;
    const coin = { txid: state.fundTxid, vout: p.i, value: FUND_EACH, spk: bytesToHex(p.spk), type: 'p2wpkh', priv: p.walletPriv, pub33: bytesToHex(p.pub) };
    const e = J.buildEntryTx({ coins: [coin], keys: { scanPub: p.sp.scanPub, spendPub: p.sp.spendPub }, count: 1, value: ENTRY_VALUE, changeSpk: null, feeRate: FEE_RATE });
    await broadcast(e.hex, `entry ${p.i}`);
    p.rec.entry = { txid: e.txid, vout: 0, value: ENTRY_VALUE, tweak: e.outputs[0].tweak, fee: e.fee };
    save();
    await sleep(500);
  }
}

// The entry output as a spendable coin: its key is b_spend + t (the entry's own silent payment).
function entryCoin(p) {
  const c = J.mixedCoin({ txid: p.rec.entry.txid, vout: p.rec.entry.vout, value: p.rec.entry.value, tweak: p.rec.entry.tweak, spendPriv: p.sp.spendPriv });
  return c;
}

// ── round ──
async function round() {
  const ps = Array.from({ length: N_PART }, (_, i) => participant(i));
  for (;;) {
    const confs = await Promise.all(ps.map((p) => confirmations(p.rec.entry.txid)));
    if (confs.every((c) => c >= AGE_MIN)) break;
    log(`entry confirmations ${confs.join(',')}; waiting for ${AGE_MIN}`);
    await sleep(60_000);
  }
  const info = await (await fetch(`${BOARD}/join/v1/info`)).json();
  log(`board ${BOARD} key ${info.boardKey.slice(0, 16)}… tip ${info.tip}`);
  const hRef = await chain.tipHeight();
  const t0 = Date.now();
  const results = await Promise.all(ps.map(async (p) => {
    // One transport per participant; independent JOIN delays of up to 20 s.
    const board = J.makeHttpBoard(BOARD);
    return J.runParticipant({
      board, chain, network: NET, d: D, fr: FR, frOwn: FR, coin: entryCoin(p), keys: { scanPriv: p.sp.scanPriv, spendPub: p.sp.spendPub },
      hRef, ageMin: AGE_MIN, joinDelayMs: () => Math.random() * 20_000,
      onEvent: (e) => { if (e.type !== 'step') log(`p${p.i} ${e.type}${e.n ? ' n=' + e.n : ''}${e.r ? ' r=' + e.r : ''}${e.txid ? ' ' + e.txid : ''}${e.error ? ' ' + e.error : ''}`); },
    }).catch((e) => ({ status: 'error', error: e.message }));
  }));
  const ok = results.filter((r) => r.status === 'broadcast');
  log(`round finished in ${((Date.now() - t0) / 60_000).toFixed(1)} min: ${results.map((r) => r.status).join(',')}`);
  if (!ok.length) throw new Error('no join transaction: ' + JSON.stringify(results.map((r) => r.error || r.reason || r.status)));
  const txid = ok[0].txid;
  if (!ok.every((r) => r.txid === txid)) throw new Error('participants broadcast different transactions');
  state.join = { txid, n: ok[0].n, runs: ok[0].runs, topic: ok[0].topic, hRef, own: ok.map((r) => r.own[0]) };
  save();
  log(`join ${link(txid)} n=${ok[0].n} runs=${ok[0].runs}`);
}

// ── scan ──
async function scan() {
  const ps = Array.from({ length: N_PART }, (_, i) => participant(i));
  const txid = state.join.txid;
  while ((await confirmations(txid)) < 1) { log('waiting for the join to confirm'); await sleep(60_000); }
  const tx = JSON.parse(await esplora(`/tx/${txid}`));
  const inputs = J.joinShape(tx) && tacit.bip352ReceiverInputsFromEsploraTx(tx);
  if (!inputs) throw new Error('join transaction is not join-shaped');
  const outputs = tx.vout.map((o) => ({ script: hexToBytes(o.scriptpubkey), value: o.value }));
  state.found = [];
  for (const p of ps) {
    const m = tacit.receiverScanTxForSilentPayments({ ...inputs, outputs, scanPriv: p.sp.scanPriv, spendPub: p.sp.spendPub });
    if (m.length !== 1) { log(`p${p.i}: ${m.length} outputs found`); continue; }
    const sk = tacit.silentPaymentSpendingKey(p.sp.spendPriv, m[0].tweakScalar);
    const opens = bytesToHex(secp.getPublicKey(sk, true).slice(1)) === tx.vout[m[0].voutIndex].scriptpubkey.slice(4);
    p.rec.mixed = { txid, vout: m[0].voutIndex, value: tx.vout[m[0].voutIndex].value, tweak: bytesToHex(m[0].tweak) };
    state.found.push({ p: p.i, vout: m[0].voutIndex, value: tx.vout[m[0].voutIndex].value, opens });
    log(`p${p.i} found its output: vout ${m[0].voutIndex}, ${tx.vout[m[0].voutIndex].value} sats, spending key opens it: ${opens}`);
  }
  save();
}

async function report() {
  const txid = state.join?.txid;
  if (!txid) { log('no join yet'); return; }
  const tx = JSON.parse(await esplora(`/tx/${txid}`));
  const fee = tx.fee, vsize = Math.ceil(tx.weight / 4);
  const entryFees = (state.participants || []).reduce((s, p) => s + (p.entry?.fee || 0), 0);
  console.log(JSON.stringify({
    board: BOARD, txid, link: link(txid), participants: tx.vin.length, vsize, weight: tx.weight, fee, feeRate: +(fee / vsize).toFixed(2),
    outputValue: tx.vout[0].value, tier: D, bucket: FR, confirmed: tx.status.confirmed, block: tx.status.block_height,
    found: state.found?.length ?? 0, fundTxid: state.fundTxid, fundFee: state.fundFee, entryFees,
    totalSpent: N_PART * FUND_EACH + (state.fundFee || 0),
  }, null, 1));
}

const cmd = process.argv[2] || 'all';
if (cmd === 'fund' || cmd === 'all') await fund();
if (cmd === 'round' || (cmd === 'all' && !state.join)) await round();
if (cmd === 'scan' || cmd === 'all') await scan();
if (cmd === 'report' || cmd === 'all') await report();
process.exit(0);
