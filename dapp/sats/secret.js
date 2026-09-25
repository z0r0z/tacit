// Secret Sats demo steps. mount(el, ctx) renders the step list into el; the step styles live in index.html.
//   ctx = { tacit, wallet, network, log, refresh, ensureKey, track, errMsg, getSats, onWallet }
//   tacit: the imported tacit.js module; wallet: tacit.wallet; getSats() asks the faucet for signet sats;
//   onWallet(fn) reports connect/unlock/balance changes.
//
// "Get signet sats" funds the fees and the lot price from the faucet.
// "Get private cBTC" buys one of the faucet's pre-authorized cBTC lots straight into the pool in one
// transaction: the T_BTC_SHIELD envelope rides vin[0], the faucet's lot is vin[1] with the seller's pre-signed
// SIGHASH_SINGLE|ANYONECANPAY witness, and vout[1] is the seller's payout. (SINGLE_ACTION_JOIN = false shows the
// two-step Get cBTC / Shield flow instead.)
// "Pay privately", "Receive" and "Exit" spend and scan pool notes. Every shield and spend is proved in this
// browser (btc-pool-client.js: the pinned circuit and key, downloaded once and cached); the carrier is posted
// by the pool's relayer when one is configured, else from this wallet's signet sats.

import { secp, sha256, keccak_256, hmac, bytesToHex, hexToBytes } from '../vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../btc-shielded-pool.js';
import { makePoolClient } from '../btc-pool-client.js';

export const FAUCET_URL = (globalThis.__SATS_FAUCET_URL__ || 'https://tacit-sats-faucet.onrender.com').replace(/\/$/, '');
export const WORKER_BASE = (globalThis.__TACIT_WORKER_BASE__ || 'https://api.tacit.finance').replace(/\/$/, '');
export const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
export const poolClient = makePoolClient({ base: '/btc-pool/' });

const te = new TextEncoder();
const SEQ = 0xfffffffd;
const NOTES_KEY = (net) => `tacit-sats-demo-v1:${net}`;

// Pool wallet derived from the Tacit key, so it is recoverable from the same backup.
export function poolWalletFor(priv, network = 'signet') {
  return pool.walletFromSeed(hmac(sha256, priv, te.encode('tacit-btc-pool-seed-v1')), network);
}

const outpointBytes = (txid, vout) => {
  const b = new Uint8Array(36);
  b.set(hexToBytes(txid).reverse(), 0);
  new DataView(b.buffer).setUint32(32, vout >>> 0, true);
  return b;
};

async function esplora(tacit, p) {
  const r = await fetch(tacit.NET.api + p);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

// ── faucet ──
export async function fetchFaucet(url = FAUCET_URL) {
  const r = await fetch(`${url}/faucet/status`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`faucet: HTTP ${r.status}`);
  return r.json();
}

// First open sale whose lot is unspent, with the full worker record (seller signature included).
export async function pickSale(tacit, status) {
  const mine = tacit.wallet.pub ? bytesToHex(tacit.wallet.pub) : null;
  let lastErr = null;
  for (const s of status.open_sales || []) {
    const sp = await esplora(tacit, `/tx/${s.txid}/outspend/${s.vout}`).catch(() => null);
    if (sp?.spent) continue;
    let sale;
    try { sale = await tacit.fetchPreauthSale({ assetIdHex: status.asset_id, saleIdHex: s.sale_id }); }
    catch (e) { lastErr = e; continue; }
    if (!sale || sale.expired || sale.seller_pubkey === mine) continue;
    return sale;
  }
  if (lastErr) throw new Error(`could not load the faucet's sale from the Tacit API (${lastErr.message || lastErr}); try again in a minute`);
  throw new Error('no open faucet sale right now; try again in a minute');
}

// Opening of the note a takePreauthSale leaves at reveal:0 (same ECDH derivation the take uses).
export function takenNoteOpening(tacit, sale) {
  const anchor = outpointBytes(sale.asset_outpoint.txid, sale.asset_outpoint.vout);
  return { amount: BigInt(sale.asset_opening.amount), blinding: tacit.deriveBlinding(tacit.wallet.priv, hexToBytes(sale.seller_pubkey), anchor, 0) };
}

export async function claim(tacit, { status, sale, onProgress } = {}) {
  status = status || await fetchFaucet();
  sale = sale || await pickSale(tacit, status);
  const r = await tacit.takePreauthSale({ assetIdHex: status.asset_id, saleIdHex: sale.sale_id, sale, onProgress });
  const { amount, blinding } = takenNoteOpening(tacit, sale);
  const note = { assetId: status.asset_id, txid: r.reveal_txid, vout: 0, value: tacit.DUST, amount: amount.toString(), blinding: blinding.toString(16).padStart(64, '0') };
  return { commitTxid: r.commit_txid, revealTxid: r.reveal_txid, sale, note };
}

// ── carriers ──
// Checks (amount, blinding) opens the commitment that defines txid:vout, and returns it as (Cx, Cy).
async function onChainNote(tacit, assetId, txid, vout, amount, blinding) {
  const tx = await esplora(tacit, `/tx/${txid}`);
  if (!tx) throw new Error(`${txid} not visible`);
  const env = tacit.txOutputEnvelope(tx);
  const pd = env ? await tacit.getParentEnvelopeData(env, vout, txid) : null;
  if (!pd || String(pd.assetIdHex).toLowerCase() !== assetId) throw new Error(`${txid}:${vout} is not a note of ${assetId}`);
  const xy = pool.commitXY(amount, blinding);
  const C = secp.ProjectivePoint.fromHex(bytesToHex(pd.commitment)).toAffine();
  if (BigInt(xy.cx) !== C.x || BigInt(xy.cy) !== C.y) throw new Error(`opening does not match ${txid}:${vout}`);
  return { Cx: xy.cx, Cy: xy.cy, value: tx.vout[vout].value };
}

// Commit/reveal carrier. vin[0] spends the envelope commit; inputs[] follow as vin[1..], each either
// signed here by the wallet (P2WPKH) or carrying a pre-signed witness. The commit output funds
// Σoutputs + reveal fee − Σinputs, from the wallet's plain sats.
export async function broadcastCarrier(tacit, { payload, inputs = [], outputs }) {
  const w = tacit.wallet;
  const envelopeScript = tacit.encodeEnvelopeScript(w.xonly(), payload);
  const { Q_xonly, parity } = tacit.tweakedOutputKey(tacit.TAP_NUMS, tacit.tapLeafHash(envelopeScript));
  const commitSpk = tacit.p2trScript(Q_xonly);
  const cb = tacit.controlBlock(tacit.TAP_NUMS, parity);
  const ownSpk = tacit.p2wpkhScript(w.pub);

  const lenPush = envelopeScript.length < 0xfd ? 1 : 3;
  const witnessLen = 1 + 65 + lenPush + envelopeScript.length + 1 + 33 + inputs.length * 108;
  const baseLen = 4 + 1 + 41 * (1 + inputs.length) + 1 + outputs.reduce((s, o) => s + 9 + o.script.length, 0) + 4;
  const feeRate = await tacit.getFeeRate(null, { fresh: true, safetyMult: 1.2 });
  const revealFee = tacit.feeFor(Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5, feeRate);
  const outSum = outputs.reduce((s, o) => s + o.value, 0);
  const inSum = inputs.reduce((s, i) => s + i.value, 0);
  const commitValue = Math.max(tacit.DUST, outSum + revealFee - inSum);

  const avoid = new Set(inputs.map((i) => `${i.txid}:${i.vout}`));
  const all = await tacit.getUtxos(w.address());
  const sats = tacit.selectSatsUtxosSafe(all, await tacit.scanHoldings()).filter((u) => !avoid.has(`${u.txid}:${u.vout}`)).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0, commitFee = 0;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = tacit.feeFor(tacit.estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + tacit.DUST) break;
  }
  if (total < commitValue + commitFee) throw new Error(`not enough signet sats: need ${commitValue + commitFee}, have ${total}`);
  const change = total - commitValue - commitFee;
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: SEQ, witness: [] })),
    outputs: [{ value: commitValue, script: commitSpk }, ...(change >= tacit.DUST ? [{ value: change, script: ownSpk }] : [])],
  };
  picked.forEach((u, i) => { commitTx.inputs[i].witness = tacit.signP2wpkhInput(commitTx, i, u.value); });
  const commitTxid = tacit.txid(commitTx);

  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: SEQ, witness: [] }, ...inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: SEQ, witness: [] }))],
    outputs,
  };
  const prevouts = [{ value: commitValue, script: commitSpk }, ...inputs.map((i) => ({ value: i.value, script: i.script }))];
  inputs.forEach((i, j) => { revealTx.inputs[1 + j].witness = i.witness || tacit.signP2wpkhInput(revealTx, 1 + j, i.value); });
  revealTx.inputs[0].witness = tacit.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  const revealTxid = tacit.txid(revealTx);

  await tacit.broadcast(bytesToHex(tacit.serializeTx(commitTx)));
  await tacit.broadcastWithRetry(bytesToHex(tacit.serializeTx(revealTx)));
  return { commitTxid, revealTxid, revealFee, commitFee };
}

// Step 2: shield a transparent note the wallet holds (P2WPKH to wallet.pub) into poolWallet's address.
export async function shieldNote(tacit, { note, poolWallet, say = () => {} }) {
  const amount = BigInt(note.amount), blinding = BigInt('0x' + note.blinding);
  const c = await onChainNote(tacit, note.assetId, note.txid, note.vout, amount, blinding);
  const sh = pool.buildShieldEnvelope({
    asset: '0x' + note.assetId,
    inputs: [{ txid: note.txid, vout: note.vout, Cx: c.Cx, Cy: c.Cy, value: amount, blinding }],
    recipientAddress: poolWallet.addressString, network: poolWallet.network,
  });
  const { payload } = await proveHere(sh, say);
  say('sending…');
  const r = await broadcastCarrier(tacit, {
    payload,
    inputs: [{ txid: note.txid, vout: note.vout, value: c.value, script: tacit.p2wpkhScript(tacit.wallet.pub) }],
    outputs: [{ value: tacit.DUST, script: tacit.p2wpkhScript(tacit.wallet.pub) }],
  });
  return { ...r, poolNote: poolNoteRecord(sh.note, r.revealTxid) };
}

// Buy and shield in one transaction. The seller's signature commits to vin[1] and vout[1] only, so the
// envelope in vin[0] can be the shield; the kernel is signed from the sale's published opening.
export async function buyAndShield(tacit, { status, sale, poolWallet, say = () => {} } = {}) {
  status = status || await fetchFaucet();
  sale = sale || await pickSale(tacit, status);
  const assetId = status.asset_id;
  const lot = sale.asset_outpoint;
  const amount = BigInt(sale.asset_opening.amount), blinding = BigInt('0x' + sale.asset_opening.blinding);
  const c = await onChainNote(tacit, assetId, lot.txid, lot.vout, amount, blinding);
  if (c.value !== Number(lot.value)) throw new Error('listed lot value does not match the chain');
  const sellerPub = hexToBytes(sale.seller_pubkey);
  const sh = pool.buildShieldEnvelope({
    asset: '0x' + assetId,
    inputs: [{ txid: lot.txid, vout: lot.vout, Cx: c.Cx, Cy: c.Cy, value: amount, blinding }],
    recipientAddress: poolWallet.addressString, network: poolWallet.network,
  });
  const { payload } = await proveHere(sh, say);
  say('buying into the pool…');
  const r = await broadcastCarrier(tacit, {
    payload,
    inputs: [{ txid: lot.txid, vout: lot.vout, value: c.value, script: tacit.p2wpkhScript(sellerPub), witness: [hexToBytes(sale.seller_asset_spend_sig), sellerPub] }],
    outputs: [
      { value: tacit.DUST, script: tacit.p2wpkhScript(tacit.wallet.pub) },
      { value: Number(sale.min_price_sats), script: hexToBytes(sale.seller_payout_script) },
    ],
  });
  return { ...r, sale, poolNote: poolNoteRecord(sh.note, r.revealTxid) };
}

function poolNoteRecord(note, txid) {
  const { value, npk, rho, ...fields } = note;
  return { ...fields, txid, value: value.toString() };
}

// ── proving on the device ──
const mb = (n) => (n / 1e6).toFixed(1);
// Proves a built shield or spend here, reporting the one-time download and then the elapsed proving time.
export async function proveHere(built, say = () => {}) {
  const pin = await poolClient.pin();
  const total = (pin.wasm_bytes || 0) + (pin.zkey_bytes || 0);
  const got = new Map();
  let t0 = 0, timer = null;
  const system = await poolClient.system({
    onProgress: ({ name, loaded, cached }) => {
      got.set(name, loaded);
      if (cached) return;
      const sum = [...got.values()].reduce((a, b) => a + b, 0);
      say(`Downloading the prover (${mb(total)} MB, once)… ${Math.min(99, Math.floor((100 * sum) / (total || 1)))}%`);
    },
  });
  try {
    return await pool.prove(built, system, {
      onProgress: (stage) => {
        if (stage !== 'proving') return;
        t0 = Date.now();
        say('Proving on your device… 0 s');
        timer = setInterval(() => say(`Proving on your device… ${Math.round((Date.now() - t0) / 1000)} s`), 500);
      },
    });
  } finally {
    if (timer) clearInterval(timer);
  }
}

// ── pool spends ──
const DUST_SATS = 546;
const eqAsset = (a, b) => String(a).replace(/^0x/, '').toLowerCase() === String(b).replace(/^0x/, '').toLowerCase();

// The wallet's pool notes of `asset`, scanned from the replay service's feed.
export async function poolNotes(poolWallet, asset) {
  const all = await poolClient.walletNotes(pool, poolWallet);
  return asset ? all.filter((x) => eqAsset(x.asset, asset)) : all;
}

// Inputs covering `need`, with the anchor, root and paths. { wait } when the wallet's anchor policy has not
// reached the newest input yet; `anchor` overrides the policy with a retained height.
async function prepare(poolWallet, asset, need, anchor) {
  const unspent = (await poolNotes(poolWallet, asset)).filter((x) => !x.spent);
  const { inputs, total } = pool.selectInputs(unspent, need, { asset: '0x' + String(asset).replace(/^0x/, '') });
  const a = await poolClient.anchorAndPaths(inputs, anchor != null ? { anchor } : {});
  return { ...a, total };
}

// Pays `amount` of `asset` to a pool address. Relayed when the replay service runs a relayer that quotes the
// asset (fee paid as an extra pool output); otherwise this wallet posts the carrier from its signet sats.
export async function payPrivately(tacit, { poolWallet, to, amount, asset, anchor = null, say = () => {} }) {
  pool.decodeAddress(to, poolWallet.network);
  const info = await poolClient.relayInfo().catch(() => null);
  const fee = info?.fees?.['0x' + String(asset).replace(/^0x/, '').toLowerCase()];
  const q = fee != null ? await poolClient.quote({ asset: '0x' + String(asset).replace(/^0x/, '') }) : null;
  say('finding your notes…');
  const a = await prepare(poolWallet, asset, amount + (q ? BigInt(q.fee) : 0n), anchor);
  if (a.wait) return { wait: a.wait, tip: a.tip };
  const outputs = [{ address: to, value: amount }];
  if (q) outputs.push({ address: q.address, value: BigInt(q.fee) });
  const built = pool.buildSpendBody({ asset: '0x' + String(asset).replace(/^0x/, ''), hAnchor: a.hAnchor, root: a.root, inputs: a.notes, outputs, wallet: poolWallet, bind: q ? q.bind : null });
  const { payload, payloadHex } = await proveHere(built, say);
  if (q) {
    say('handing it to the relayer…');
    const sub = await poolClient.submit({ payload: payloadHex, quoteId: q.quoteId });
    for (let i = 0; i < 60; i++) {
      const stt = await poolClient.relayStatus(sub.id).catch(() => null);
      if (stt?.carrier) return { revealTxid: stt.carrier, relayed: true, anchor: a.hAnchor };
      if (stt && ['dropped', 'rejected'].includes(stt.state)) throw new Error(`the relayer dropped the payment: ${stt.reason || stt.state}`);
      say('waiting for the relayer’s batch…');
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('the relayer has not posted the payment yet; check back shortly');
  }
  say('sending…');
  const own = tacit.p2wpkhScript(tacit.wallet.pub);
  const r = await broadcastCarrier(tacit, { payload, outputs: [{ value: tacit.DUST, script: own }] });
  return { ...r, relayed: false, anchor: a.hAnchor };
}

// Exits `amount` of `asset` to this wallet's own address as an ordinary Tacit note (vout 0 of the carrier), the
// rest staying shielded as internal change. Returns the new note's opening.
export async function exitToWallet(tacit, { poolWallet, amount, asset, anchor = null, say = () => {} }) {
  say('finding your notes…');
  const a = await prepare(poolWallet, asset, amount, anchor);
  if (a.wait) return { wait: a.wait, tip: a.tip };
  const self = { address: poolWallet.internalAddress, network: poolWallet.network };
  const change = a.total - amount;
  const outputs = change > 0n ? [{ ...self, value: change }] : [];
  while (outputs.length < 3) outputs.push({ ...self, value: 0n });
  const own = tacit.p2wpkhScript(tacit.wallet.pub);
  const built = pool.buildSpendBody({
    asset: '0x' + String(asset).replace(/^0x/, ''), hAnchor: a.hAnchor, root: a.root, inputs: a.notes, outputs, network: poolWallet.network,
    exit: { exitVout: 0, scriptPubKey: '0x' + bytesToHex(own), value: amount },
  });
  const { payload } = await proveHere(built, say);
  say('sending…');
  const r = await broadcastCarrier(tacit, { payload, outputs: [{ value: Math.max(tacit.DUST, DUST_SATS), script: own }] });
  return { ...r, exit: { vout: 0, value: amount.toString(), blinding: built.exit.blinding, cx: built.exit.cx, cy: built.exit.cy }, anchor: a.hAnchor };
}

// ── UI ──
// One-line switch: true shows a single "Get private cBTC" step (buy and shield in one transaction) in place of
// the separate Get cBTC and Shield steps. The zap module can replace the local buyAndShield by import.
// index.html carries a static preview of STEPS for before this module loads; merge its rows too when flipping.
const SINGLE_ACTION_JOIN = true;
const joinImpl = buyAndShield;

const hooks = new Map();
// impl: { title, done?(state), render(body, api) } where api = { ctx, state, save, log, poolWallet, pool, setStatus, rerender }.
export function registerStep(id, impl) { hooks.set(id, impl); }

export const STEPS = [
  { id: 'sats', title: 'Get signet sats' },
  ...(SINGLE_ACTION_JOIN
    ? [{ id: 'join', title: 'Get private cBTC' }]
    : [{ id: 'get', title: 'Get cBTC' }, { id: 'shield', title: 'Shield' }]),
  { id: 'pay', title: 'Pay privately' }, { id: 'receive', title: 'Receive' }, { id: 'exit', title: 'Exit' },
];

const POOL_STEPS = new Set(['pay', 'receive', 'exit']);

// What each step does, shown while it is still ahead.
const ABOUT = {
  sats: 'Free test sats for the fees and the cBTC price.',
  get: 'Buy a test cBTC lot from the faucet in one atomic swap.',
  shield: 'Move it into the pool, where amounts and owners are hidden.',
  join: 'Buy a test cBTC lot straight into the pool in one atomic swap, proved on your device.',
  pay: 'Pay another pool address. The amount and where your coins came from stay hidden.',
  receive: 'Find private payments sent to your pool address.',
  exit: 'Leave the pool to an ordinary cBTC note in your wallet.',
};

// takePreauthSale progress stages, in words.
const STAGE = {
  'fetch-start': 'checking the lot…', 'commit-start': 'sending your payment…',
  'wait-visible': 'waiting for the network…', 'broadcast-start': 'claiming the lot…',
};

// Rough sats a buy needs on top of the lot price (commit + reveal fees at signet rates, plus the change floor).
const FEE_ALLOWANCE = 2500;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

// One line for the step; the take's post-commit errors carry a recovery pointer the main app acts on.
function stepError(e, ctx) {
  const m = String(e?.message || e || '');
  if (/locked at [0-9a-f]{64}/.test(m)) return 'Your payment went out but the claim did not finish. The sats are recoverable from the main Tacit app (Holdings, stranded commits).';
  let x;
  if ((x = m.match(/insufficient sats for (?:commit|reveal) \(need ~?(\d+), have (\d+)\)/)) || (x = m.match(/not enough signet sats: need (\d+), have (\d+)/))) {
    return `Not enough signet sats: this needs about ${Number(x[1]).toLocaleString('en-US')}, you have ${Number(x[2]).toLocaleString('en-US')}. Get more in step 1.`;
  }
  if (/already spent|race lost|no open faucet sale/.test(m)) return 'Someone took that lot first. Try again; the faucet keeps a few listed.';
  return ctx.errMsg ? ctx.errMsg(e) : m.split('\n')[0];
}

export function mount(root, ctx) {
  const { tacit } = ctx;
  const network = ctx.network || tacit.NET?.name || 'signet';
  const log = ctx.log || (() => {});
  const explorer = tacit.NET?.explorer || 'https://mempool.space/signet';
  const txLink = (txid, label) => el('a', { href: `${explorer}/tx/${txid}`, target: '_blank', rel: 'noopener noreferrer' }, label || `${txid.slice(0, 10)}…`);
  const poolWallet = () => (ctx.wallet?.priv ? poolWalletFor(ctx.wallet.priv, network) : null);
  const n = (x) => Number(x).toLocaleString('en-US');

  // Progress is kept per wallet, so a second wallet in this browser starts fresh.
  let who = null; // { connected, unlocked, pubHex, sats }
  let state = {};
  const key = () => (who?.pubHex ? `tacit-sats-demo-v2:${network}:${who.pubHex}` : null);
  const load = () => { try { return JSON.parse((key() && localStorage.getItem(key())) || '{}') || {}; } catch { return {}; } };
  const save = () => { try { if (key()) localStorage.setItem(key(), JSON.stringify(state)); } catch {} };

  let faucet = { loading: true, status: null, error: null };
  let running = null;             // step id in flight
  const errs = {};                // step id → last error line
  const progress = {};            // step id → progress line

  const intro = el('p', { class: 'note' });
  const list = el('ol', { class: 'steps', 'aria-label': 'Secret payment steps' });
  root.replaceChildren(intro, list);

  const sections = {};
  STEPS.forEach((s, i) => {
    const num = el('span', { class: 'step-n', 'aria-hidden': 'true' }, String(i + 1));
    const status = el('span', { class: 'step-status', 'aria-live': 'polite' });
    const body = el('div', { class: 'step-body' });
    const sec = el('li', { class: 'step', 'data-step': s.id }, num,
      el('div', {}, el('div', { class: 'step-head' }, el('span', { class: 'step-title' }, s.title), status), body));
    sections[s.id] = { sec, num, status, body, index: i + 1 };
    list.append(sec);
  });

  const fmt = (units) => {
    const d = Number.isInteger(faucet.status?.decimals) ? faucet.status.decimals : 8;
    const s = BigInt(units).toString().padStart(d + 1, '0');
    return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '');
  };
  const ticker = () => faucet.status?.ticker || 'cBTC';
  const need = () => Number(faucet.status?.price_sats || 0) + FEE_ALLOWANCE;
  const satsKnown = () => who?.sats !== null && who?.sats !== undefined;

  async function run(id, fn, { needKey = true } = {}) {
    if (running) return;
    running = id; errs[id] = null; progress[id] = 'working…';
    render();
    const say = (m) => { progress[id] = m; sections[id].status.textContent = m; };
    try {
      if (needKey) await ctx.ensureKey?.();
      await fn(say);
    } catch (e) {
      errs[id] = stepError(e, ctx);
      if (!/^Cancelled/.test(errs[id]) && errs[id] === (ctx.errMsg ? ctx.errMsg(e) : String(e?.message || e).split('\n')[0])) console.warn('[sats] step', id, e);
    } finally {
      running = null; progress[id] = null;
      render();
    }
  }

  function button(label, onClick, disabled = false) {
    const b = el('button', { class: 'btn', type: 'button' }, label);
    b.disabled = disabled || !!running;
    b.addEventListener('click', onClick);
    return b;
  }

  function put(node, ...kids) { node.append(...kids.filter((k) => k != null && k !== '')); }

  function errLine(id) { return errs[id] ? el('div', { class: 'err', role: 'alert' }, errs[id]) : null; }

  // Why a buy can't start yet, or null.
  function buyBlocker() {
    if (!who?.connected) return 'Connect a wallet above first.';
    if (faucet.loading) return 'Checking the faucet…';
    if (faucet.error) return 'The faucet is offline right now. Try again in a few minutes.';
    if (!(faucet.status.open_sales || []).length) return 'No lots listed right now. The faucet relists every few minutes.';
    if (satsKnown() && who.sats < need()) return `You need about ${n(need())} signet sats (price plus fees). Get them in step 1.`;
    return null;
  }

  function offerLine() {
    const st = faucet.status;
    if (!st) return null;
    const k = (st.open_sales || []).length;
    return el('div', {}, `Pay ${n(st.price_sats)} signet sats for ${fmt(st.lot)} ${ticker()}, a test token standing in for bitcoin-backed cBTC. ${k} lot${k === 1 ? '' : 's'} open.`);
  }

  // done | active | locked, in order: the first open step is the active one. Pay, Receive and Exit open together
  // once the wallet holds a pool note, and stay usable after they are done.
  function phases() {
    const done = {
      sats: !!(state.note || state.poolNote) || (satsKnown() && who.sats >= need()),
      get: !!(state.note || state.poolNote),
      shield: !!state.poolNote,
      join: !!state.poolNote,
      pay: !!state.pays?.length,
      receive: !!state.received?.length,
      exit: !!state.exits?.length,
    };
    const out = {};
    let open = !!who?.connected;
    for (const { id } of STEPS) {
      const impl = hooks.get(id);
      const d = impl?.done ? !!impl.done(state) : done[id];
      if (POOL_STEPS.has(id)) out[id] = running === id ? 'active' : !who?.connected || !state.poolNote ? 'locked' : d ? 'done' : 'active';
      else if (running === id) { out[id] = 'active'; open = false; }
      else if (d) out[id] = 'done';
      else if (open) { out[id] = 'active'; open = false; }
      else out[id] = 'locked';
    }
    return out;
  }

  function setPhase(id, phase, status = '') {
    const S = sections[id];
    S.sec.className = `step is-${phase}${running === id ? ' is-running' : ''}`;
    S.num.textContent = phase === 'done' ? '✓' : String(S.index);
    if (phase === 'active') S.sec.setAttribute('aria-current', 'step'); else S.sec.removeAttribute('aria-current');
    const line = running === id ? (progress[id] || 'working…') : status;
    if (S.status.textContent !== line) S.status.textContent = line;
    S.body.replaceChildren();
    return S;
  }

  function renderSats(ph) {
    const S = setPhase('sats', ph, ph === 'done' ? 'done' : who?.connected && !satsKnown() ? 'checking…' : '');
    if (ph === 'done') {
      if (satsKnown() && who.sats > 0) put(S.body, el('div', {}, `${n(who.sats)} signet sats in your wallet.`));
      return;
    }
    if (ph !== 'active') { put(S.body, el('div', {}, ABOUT.sats)); return; }
    const faucetLink = el('a', { href: 'https://signetfaucet.com', target: '_blank', rel: 'noopener noreferrer' }, 'signetfaucet.com');
    put(S.body,
      el('div', {}, `The buy costs about ${n(need())} signet sats with fees${satsKnown() ? `; you have ${n(who.sats)}` : ''}. The faucet sends 10,000.`),
      el('div', { class: 'row' },
        button('Get signet sats', () => run('sats', async (say) => { say('asking the faucet…'); await ctx.getSats(); }, { needKey: false }), !ctx.getSats),
        el('span', { class: 'small muted' }, 'or ', faucetLink)),
      errLine('sats'));
  }

  function renderGet(ph) {
    const S = setPhase('get', ph, ph === 'done' ? 'done' : '');
    if (ph === 'done') {
      if (state.note) put(S.body, el('div', {}, `${fmt(state.note.amount)} ${ticker()} bought in `, txLink(state.note.txid), '. It shows under tokens in your wallet.'));
      return;
    }
    if (running === 'get') { put(S.body, offerLine()); return; }
    if (ph !== 'active') { put(S.body, el('div', {}, ABOUT.get)); return; }
    const block = buyBlocker();
    put(S.body, offerLine(), block ? el('div', {}, block) : null,
      el('div', { class: 'row' }, button(`Get ${ticker()}`, () => run('get', async (say) => {
        say('finding a lot…');
        const r = await claim(tacit, { status: faucet.status, onProgress: (st) => say(STAGE[st] || 'working…') });
        state.note = r.note; state.claim = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, saleId: r.sale.sale_id }; save();
        ctx.track?.(r.revealTxid, `Bought ${fmt(r.note.amount)} ${ticker()}`);
        log(`Bought ${fmt(r.note.amount)} ${ticker()}.`);
        refreshFaucet();
        ctx.refresh?.();
      }), !!block)),
      errLine('get'));
  }

  function shieldedLine() {
    const pw = poolWallet();
    return el('div', {}, `${fmt(state.poolNote.value)} ${ticker()} shielded in `, txLink(state.shield.revealTxid), pw ? ` to your pool address ${pw.addressString.slice(0, 16)}…` : '', '. The pool picks it up after one confirmation.');
  }

  function renderShield(ph) {
    const S = setPhase('shield', ph, ph === 'done' ? 'done' : '');
    if (ph === 'done') { put(S.body, shieldedLine()); return; }
    if (running === 'shield') return;
    if (ph !== 'active') { put(S.body, el('div', {}, ABOUT.shield)); return; }
    put(S.body, el('div', {}, `Move your ${fmt(state.note.amount)} ${ticker()} into the pool. One transaction, paid from your signet sats.`),
      el('div', { class: 'row' }, button('Shield', () => run('shield', async (say) => {
        const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
        say('building the shield…');
        const r = await shieldNote(tacit, { note: state.note, poolWallet: pw, say });
        state.poolNote = r.poolNote; state.shield = { commitTxid: r.commitTxid, revealTxid: r.revealTxid }; save();
        ctx.track?.(r.revealTxid, `Shielded ${fmt(r.poolNote.value)} ${ticker()}`);
        log('Shielded.');
        ctx.refresh?.();
      }), !who?.connected)),
      errLine('shield'));
  }

  function renderJoin(ph) {
    const S = setPhase('join', ph, ph === 'done' ? 'done' : '');
    if (ph === 'done') { put(S.body, shieldedLine()); return; }
    if (running === 'join') { put(S.body, offerLine()); return; }
    if (ph !== 'active') { put(S.body, el('div', {}, ABOUT.join)); return; }
    const block = buyBlocker();
    put(S.body, offerLine(), block ? el('div', {}, block) : null,
      el('div', { class: 'row' }, button(`Get private ${ticker()}`, () => run('join', async (say) => {
        const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
        say('building the shield…');
        const r = await joinImpl(tacit, { status: faucet.status, poolWallet: pw, say });
        state.poolNote = r.poolNote; state.shield = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, bought: true }; save();
        ctx.track?.(r.revealTxid, `Bought ${fmt(r.poolNote.value)} private ${ticker()}`);
        refreshFaucet();
        ctx.refresh?.();
      }), !!block)),
      errLine('join'));
  }

  // ── pool steps ──
  const asset = () => faucet.status?.asset_id || null;
  const units = (str) => {
    const d = Number.isInteger(faucet.status?.decimals) ? faucet.status.decimals : 8;
    const m = String(str || '').trim().match(/^(\d*)(?:\.(\d*))?$/);
    if (!m || (!m[1] && !m[2]) || (m[2] || '').length > d) throw new Error(`Enter an amount with at most ${d} decimals.`);
    return BigInt((m[1] || '0') + (m[2] || '').padEnd(d, '0'));
  };
  let notes = null; // last scan: [{ value, spent, internal, txid, height, leafIndex }]
  const balance = () => (notes || []).filter((x) => !x.spent).reduce((t, x) => t + BigInt(x.value), 0n);
  async function scanNotes(say) {
    const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
    say?.('scanning the pool…');
    notes = await poolNotes(pw, asset());
    const seen = new Set((state.received || []).map((x) => x.leafIndex));
    const own = new Set([...(state.pays || []), ...(state.exits || [])].map((x) => x.txid));
    for (const x of notes) {
      if (!x.internal && !seen.has(x.leafIndex) && x.txid !== state.shield?.revealTxid && !own.has(x.txid)) {
        (state.received ||= []).push({ leafIndex: x.leafIndex, txid: x.txid, value: x.value.toString(), height: x.height });
      }
    }
    save();
  }
  const waitLine = (w) => `Your newest note is too recent for the wallet's anchor policy: it needs ${w.wait} more signet block${w.wait === 1 ? '' : 's'} (about ${w.wait * 10} min). Spending sooner anchors at the latest block, which tells an observer your note is new.`;
  const pending = {}; // step id → { wait, retry }
  function waitBox(id, retry) {
    const w = pending[id];
    if (!w) return null;
    return el('div', {}, waitLine(w), el('div', { class: 'row' },
      button('Spend now at the latest block', () => { delete pending[id]; retry(w.tip); }),
      button('Wait', () => { delete pending[id]; render(); })));
  }
  function field(id, label, attrs = {}) {
    const input = el('input', { type: 'text', id, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...attrs });
    return { input, node: el('div', { class: 'field' }, el('label', { for: id }, label), input) };
  }
  const balanceLine = () => (notes ? el('div', {}, `Private balance: ${fmt(balance())} ${ticker()}${notes.some((x) => !x.spent && x.internal) ? ' (change included)' : ''}.`) : null);

  function renderPay(ph) {
    const S = setPhase('pay', ph, ph === 'done' ? 'done' : '');
    if (ph === 'locked') { put(S.body, el('div', {}, ABOUT.pay)); return; }
    const last = state.pays?.[state.pays.length - 1];
    if (running === 'pay') { if (last) put(S.body, el('div', {}, 'Last payment ', txLink(last.txid), '.')); return; }
    const to = field('pool-pay-to', 'To: a pool address (tbp1…)', { placeholder: 'tbp1…' });
    const amt = field('pool-pay-amt', `Amount (${ticker()})`, { inputmode: 'decimal', placeholder: '0.0001' });
    const go = (anchor = null) => run('pay', async (say) => {
      const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
      const address = (state.payDraft?.to || '').trim();
      const value = units(state.payDraft?.amount);
      if (value <= 0n) throw new Error('Enter an amount above zero.');
      const r = await payPrivately(tacit, { poolWallet: pw, to: address, amount: value, asset: asset(), anchor, say });
      if (r.wait) { pending.pay = { ...r }; return; }
      (state.pays ||= []).push({ txid: r.revealTxid, to: address.slice(0, 16) + '…', value: value.toString(), relayed: r.relayed });
      state.payDraft = null; save();
      ctx.track?.(r.revealTxid, `Paid ${fmt(value)} private ${ticker()}`);
      log(`Paid ${fmt(value)} ${ticker()} privately.`);
      notes = null;
    });
    to.input.value = state.payDraft?.to || ''; amt.input.value = state.payDraft?.amount || '';
    const keep = () => { state.payDraft = { to: to.input.value, amount: amt.input.value }; };
    to.input.addEventListener('input', keep); amt.input.addEventListener('input', keep);
    put(S.body,
      last ? el('div', {}, `Paid ${fmt(last.value)} ${ticker()} to ${last.to} in `, txLink(last.txid), last.relayed ? ' (relayed).' : '.') : el('div', {}, ABOUT.pay),
      balanceLine(), waitBox('pay', go) || el('div', {}, to.node, amt.node,
        el('div', { class: 'row' }, button('Pay privately', () => { keep(); go(); }), el('span', { class: 'small muted' }, 'Proved on your device; the first proof downloads the prover once.'))),
      errLine('pay'));
  }

  function renderReceive(ph) {
    const S = setPhase('receive', ph, ph === 'done' ? `${state.received.length} received` : '');
    if (ph === 'locked') { put(S.body, el('div', {}, ABOUT.receive)); return; }
    if (running === 'receive') return;
    const pw = poolWallet();
    const addr = pw ? el('div', { class: 'small' }, 'Your pool address: ', el('code', {}, pw.addressString.slice(0, 20) + '…' + pw.addressString.slice(-8)), ' ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); navigator.clipboard?.writeText(pw.addressString); log('Pool address copied.'); } }, 'copy')) : null;
    const got = (state.received || []).slice(-5).reverse().map((x) => el('div', {}, `${fmt(x.value)} ${ticker()} received in `, txLink(x.txid), ` (block ${x.height}).`));
    put(S.body, addr, ...got, balanceLine(),
      el('div', { class: 'row' }, button('Scan the pool', () => run('receive', async (say) => { await scanNotes(say); }))),
      errLine('receive'));
  }

  function renderExit(ph) {
    const S = setPhase('exit', ph, ph === 'done' ? 'done' : '');
    if (ph === 'locked') { put(S.body, el('div', {}, ABOUT.exit)); return; }
    const last = state.exits?.[state.exits.length - 1];
    if (running === 'exit') return;
    const amt = field('pool-exit-amt', `Amount (${ticker()})`, { inputmode: 'decimal', placeholder: notes ? fmt(balance()) : '0.0001' });
    amt.input.value = state.exitDraft || '';
    amt.input.addEventListener('input', () => { state.exitDraft = amt.input.value; });
    const go = (anchor = null) => run('exit', async (say) => {
      const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
      const value = units(state.exitDraft);
      if (value <= 0n) throw new Error('Enter an amount above zero.');
      const r = await exitToWallet(tacit, { poolWallet: pw, amount: value, asset: asset(), anchor, say });
      if (r.wait) { pending.exit = { ...r }; return; }
      (state.exits ||= []).push({ txid: r.revealTxid, ...r.exit });
      state.exitDraft = ''; save();
      ctx.track?.(r.revealTxid, `Exited ${fmt(value)} ${ticker()}`);
      log(`Exited ${fmt(value)} ${ticker()} to your wallet.`);
      notes = null;
      ctx.refresh?.();
    });
    put(S.body,
      last ? el('div', {}, `${fmt(last.value)} ${ticker()} left the pool to your wallet in `, txLink(last.txid), '. It is an ordinary cBTC note once the pool records the exit.') : el('div', {}, ABOUT.exit),
      balanceLine(), waitBox('exit', go) || el('div', {}, amt.node,
        el('div', { class: 'row' }, button('Exit to my wallet', () => go()), el('span', { class: 'small muted' }, 'The amount stays hidden on chain.'))),
      errLine('exit'));
  }

  function renderHook(id, ph) {
    const impl = hooks.get(id);
    if (!impl) return ({ pay: renderPay, receive: renderReceive, exit: renderExit })[id](ph);
    const S = setPhase(id, ph, ph === 'done' ? 'done' : '');
    impl.render(S.body, { ctx, state, save, log, poolWallet, pool, setStatus: (m) => { S.status.textContent = m; }, rerender: render });
  }

  let scanning = false;
  function autoscan() {
    if (notes || scanning || running || !state.poolNote || !who?.unlocked || !poolWallet()) return;
    scanning = true;
    scanNotes().catch(() => {}).finally(() => { scanning = false; if (!running && notes) render(); });
  }

  function render() {
    autoscan();
    intro.textContent = who?.connected
      ? 'Each step is one signet transaction from your wallet above. Progress is saved in this browser.'
      : 'Connect a wallet above to start. Each step is one signet transaction.';
    const ph = phases();
    renderSats(ph.sats);
    if (SINGLE_ACTION_JOIN) renderJoin(ph.join); else { renderGet(ph.get); renderShield(ph.shield); }
    for (const id of ['pay', 'receive', 'exit']) renderHook(id, ph[id]);
  }

  async function refreshFaucet() {
    try { faucet = { loading: false, status: await fetchFaucet(), error: null }; }
    catch (e) { faucet = { loading: false, status: faucet.status, error: e }; }
    if (!running) render();
  }

  ctx.onWallet?.((d) => {
    const changed = d.pubHex !== who?.pubHex;
    who = d;
    if (changed) { state = load(); for (const k of Object.keys(errs)) errs[k] = null; }
    if (!running) render();
  });
  render();
  refreshFaucet();
  const timer = setInterval(() => { if (!document.hidden && !running) refreshFaucet(); }, 60_000);
  return { render, get state() { return state; }, sections, stop: () => clearInterval(timer) };
}
