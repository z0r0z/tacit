
import { secp, sha256, keccak_256, hmac, ripemd160, bytesToHex, hexToBytes } from '../vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../btc-shielded-pool.js';
import { makeBtcPoolZap } from '../btc-pool-zap.js';
import { makePoolClient } from '../btc-pool-client.js';
import { poolRecipient } from '../pool-recipient.js';

export const FAUCET_URL = (globalThis.__SATS_FAUCET_URL__ || 'https://tacit-sats-faucet.onrender.com').replace(/\/$/, '');
export const WORKER_BASE = (globalThis.__TACIT_WORKER_BASE__ || 'https://api.tacit.finance').replace(/\/$/, '');
export const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256, ripemd160 });
export const zap = makeBtcPoolZap({ secp, sha256, keccak256: keccak_256 });

const MAINNET_POOL_API = globalThis.__TACIT_BTC_POOL_API_MAINNET__ || 'https://tacit-btc-pool-mainnet.onrender.com';
const SIGNET_POOL_RELAY = globalThis.__TACIT_BTC_POOL_RELAY__ || 'https://tacit-btc-pool-relay.onrender.com';
const MAINNET_POOL_RELAY = globalThis.__TACIT_BTC_POOL_RELAY_MAINNET__ || 'https://tacit-btc-pool-relay-mainnet.onrender.com';
const poolClients = {
  signet: makePoolClient({ base: '/btc-pool/', relayApi: SIGNET_POOL_RELAY }),
  mainnet: makePoolClient({ api: MAINNET_POOL_API, base: '/btc-pool/', relayApi: MAINNET_POOL_RELAY }),
};
export const poolClient = poolClients.signet;
export const poolClientFor = (network) => poolClients[network] || poolClients.signet;

export const MAINNET_POOL_ASSETS = [
  { ticker: 'TAC', decimals: 8, logo: '../tac-logo.png', live: true,
    id: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b' },
  { ticker: 'cBTC', decimals: 8, logo: null, live: true,
    id: '62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8' },
];

export const TAC_ASSET_MAINNET = MAINNET_POOL_ASSETS[0].id;
export const livePoolAssets = () => MAINNET_POOL_ASSETS.filter((a) => a.live);
const TAC_DECIMALS_FALLBACK = MAINNET_POOL_ASSETS[0].decimals;

const te = new TextEncoder();
const SEQ = 0xfffffffd;
const NOTES_KEY = (net) => `tacit-sats-demo-v1:${net}`;

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
  let last = null;
  for (const base of [tacit.NET.api, tacit.NET.api2]) {
    if (!base) continue;
    try {
      const r = await fetch(base + p);
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
      last = new Error(`${p}: HTTP ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last || new Error(`${p}: no explorer to ask`);
}

export async function fetchFaucet(url = FAUCET_URL) {
  const r = await fetch(`${url}/faucet/status`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`faucet: HTTP ${r.status}`);
  return r.json();
}

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

const T_CXFER_BOUND = 0x39;
async function onChainNote(tacit, assetId, txid, vout, amount, blinding) {
  const tx = await esplora(tacit, `/tx/${txid}`);
  if (!tx) throw new Error(`${txid} not visible`);
  const env = tacit.txOutputEnvelope(tx);
  if (env && env.opcode === T_CXFER_BOUND) throw new Error(`${txid}:${vout} is bound to a pool deployment, so the Bitcoin pool cannot take it`);
  const pd = env ? await tacit.getParentEnvelopeData(env, vout, txid) : null;
  if (!pd || String(pd.assetIdHex).toLowerCase() !== assetId) throw new Error(`${txid}:${vout} is not a note of ${assetId}`);
  const xy = pool.commitXY(amount, blinding);
  const C = secp.ProjectivePoint.fromHex(bytesToHex(pd.commitment)).toAffine();
  if (BigInt(xy.cx) !== C.x || BigInt(xy.cy) !== C.y) throw new Error(`opening does not match ${txid}:${vout}`);
  return { Cx: xy.cx, Cy: xy.cy, value: tx.vout[vout].value };
}

export async function broadcastCarrier(tacit, { payload, inputs = [], outputs, feeTier = null }) {
  const w = tacit.wallet;
  const envelopeScript = tacit.encodeEnvelopeScript(w.xonly(), payload);
  const { Q_xonly, parity } = tacit.tweakedOutputKey(tacit.TAP_NUMS, tacit.tapLeafHash(envelopeScript));
  const commitSpk = tacit.p2trScript(Q_xonly);
  const cb = tacit.controlBlock(tacit.TAP_NUMS, parity);
  const ownSpk = tacit.p2wpkhScript(w.pub);

  const lenPush = envelopeScript.length < 0xfd ? 1 : 3;
  const witnessLen = 1 + 65 + lenPush + envelopeScript.length + 1 + 33 + inputs.length * 108;
  const baseLen = 4 + 1 + 41 * (1 + inputs.length) + 1 + outputs.reduce((s, o) => s + 9 + o.script.length, 0) + 4;
  const feeRate = await tacit.getFeeRate(feeTier, { fresh: true, safetyMult: 1.2 });
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
  if (total < commitValue + commitFee) throw new Error(`not enough sats at your Bitcoin address: need ${commitValue + commitFee}, have ${total}`);
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

  const kept = typeof tacit.recordPreauthTakePending === 'function';
  if (kept) tacit.recordPreauthTakePending(commitTxid, { envelope_script_hex: bytesToHex(envelopeScript), control_block_hex: bytesToHex(cb), commit_value: commitValue, reveal_txid: revealTxid, ticker: 'sats' });
  try { await tacit.broadcast(bytesToHex(tacit.serializeTx(commitTx))); }
  catch (e) { if (kept) forgetCommit(tacit, commitTxid); throw e; }
  try { await tacit.broadcastWithRetry(bytesToHex(tacit.serializeTx(revealTx))); }
  catch (e) {
    throw Object.assign(new Error(`Bitcoin refused the transaction that finishes this, so it did not go through. The ${commitValue.toLocaleString('en-US')} sats set aside for it wait in its first transaction, and can be returned to your Bitcoin address (also from the classic app’s Holdings).`), { said: true, commitTxid, stranded: commitValue, cause: e });
  }
  if (kept) forgetCommit(tacit, commitTxid);
  return { commitTxid, revealTxid, revealFee, commitFee };
}
function forgetCommit(tacit, commitTxid) {
  try {
    const k = `tacit-preauth-take-pending-v1:${tacit.NET?.name || 'mainnet'}`, all = JSON.parse(localStorage.getItem(k) || 'null');
    if (all && commitTxid in all) { delete all[commitTxid]; localStorage.setItem(k, JSON.stringify(all)); }
  } catch {}
}

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

export async function buyAndShield(tacit, { status, sale, poolWallet, say = () => {}, feeTier = null } = {}) {
  status = status || await fetchFaucet();
  sale = sale || await pickSale(tacit, status);
  const assetId = status.asset_id;
  const lot = sale.asset_outpoint;
  const amount = BigInt(sale.asset_opening.amount), blinding = BigInt('0x' + sale.asset_opening.blinding);
  const c = await onChainNote(tacit, assetId, lot.txid, lot.vout, amount, blinding);
  if (c.value !== Number(lot.value)) throw new Error('listed lot value does not match the chain');
  await tacit.requireValidatedLot(lot.txid, lot.vout, 'the listed lot');
  const sellerPub = hexToBytes(sale.seller_pubkey);
  const sh = pool.buildShieldEnvelope({
    asset: '0x' + assetId,
    inputs: [{ txid: lot.txid, vout: lot.vout, Cx: c.Cx, Cy: c.Cy, value: amount, blinding }],
    recipientAddress: poolWallet.addressString, network: poolWallet.network,
  });
  const { payload } = await proveHere(sh, say);
  const sp = await esplora(tacit, `/tx/${lot.txid}/outspend/${lot.vout}`).catch(() => null);
  if (sp?.spent) throw Object.assign(new Error('That lot was just bought by someone else. Nothing was sent; pick another.'), { said: true });
  say('buying into the pool…');
  const r = await broadcastCarrier(tacit, {
    payload, feeTier,
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

const mb = (n) => (n / 1e6).toFixed(1);
export async function proveHere(built, say = () => {}) {
  const total = await poolClient.artifactBytes();
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
        if (stage === 'loading') { say('Preparing the prover…'); return; }
        if (stage !== 'proving') return;
        t0 = Date.now();
        say('Proving on your device (~15 s)… 0 s');
        timer = setInterval(() => say(`Proving on your device (~15 s)… ${Math.round((Date.now() - t0) / 1000)} s`), 500);
      },
    });
  } finally {
    if (timer) clearInterval(timer);
    system.close?.();
  }
}

const DUST_SATS = 546;
const eqAsset = (a, b) => String(a).replace(/^0x/, '').toLowerCase() === String(b).replace(/^0x/, '').toLowerCase();

export async function poolNotes(poolWallet, asset) {
  const all = await poolClientFor(poolWallet.network).walletNotes(pool, poolWallet);
  return asset ? all.filter((x) => eqAsset(x.asset, asset)) : all;
}

const PENDING_KEY = 'tacit-pool-pending-v1', PENDING_MS = 6 * 3600e3;
const MAY_STILL_MS = 30 * 60e3;
const nfKey = (nf) => String(nf).replace(/^0x/, '').toLowerCase();
function pendingRead() {
  let v = null;
  try { v = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch {}
  const out = { spent: {}, change: {} }, now = Date.now();
  for (const [k, x] of Object.entries(v?.spent || {})) if (now < (x.until ?? x.at + PENDING_MS)) out.spent[k] = x;
  for (const [k, x] of Object.entries(v?.change || {})) if (now - x.at < PENDING_MS) out.change[k] = x;
  return out;
}
const ownerTag = (poolWallet) => (poolWallet?.addressString ? String(poolWallet.addressString).slice(-16) : null);
function pendingMark(notes, txid, change, asset, out = 0n, owner = null, { pay = false, hold = null } = {}) {
  const p = pendingRead(), at = Date.now();
  for (const n of notes) if (n.nf) p.spent[nfKey(n.nf)] = { at, txid, ...(hold ? { until: at + hold } : {}) };
  if (txid && (change > 0n || out > 0n)) p.change[txid] = { at, v: change.toString(), ...(out > 0n ? { [pay ? 'pay' : 'out']: out.toString() } : {}), asset: String(asset).replace(/^0x/, '').toLowerCase(), ...(owner ? { owner } : {}) };
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch {}
}
export function pendingView(notes, asset, poolWallet = null) {
  const p = pendingRead(), seen = new Set(notes.map((n) => n.txid)), owner = ownerTag(poolWallet);
  const live = notes.filter((n) => !n.spent && !(n.nf && p.spent[nfKey(n.nf)]));
  let settling = 0n, leaving = 0n, paying = 0n;
  for (const [txid, c] of Object.entries(p.change)) {
    if (seen.has(txid) || (asset && !eqAsset(c.asset, asset)) || (owner && c.owner && c.owner !== owner)) continue;
    settling += BigInt(c.v); leaving += BigInt(c.out || 0); paying += BigInt(c.pay || 0);
  }
  return { live, settling, leaving, paying };
}
const spentElsewhere = (m) => /nullifier|conflict|replayed|already spent|double/i.test(String(m || ''));
const relayDeclined = (msg) => Object.assign(new Error(msg), { said: true, relayDeclined: true });

async function prepare(poolWallet, asset, need, anchor, fixed = null) {
  const { inputs, total } = fixed
    ? { inputs: fixed, total: fixed.reduce((t, x) => t + BigInt(x.value), 0n) }
    : pool.selectInputs(pendingView(await poolNotes(poolWallet, asset)).live, need, { asset: '0x' + String(asset).replace(/^0x/, '') });
  const a = await poolClientFor(poolWallet.network).anchorAndPaths(inputs, anchor != null ? { anchor } : {});
  return { ...a, total };
}

export async function payPrivately(tacit, { poolWallet, to, amount, asset, anchor = null, noRelay = false, maxFee = null, say = () => {}, inputs = null, askSelf = null, deductFee = false, requoted = false }) {
  to = poolRecipient(to, poolWallet.network);
  pool.decodeAddress(to, poolWallet.network);
  const client = poolClientFor(poolWallet.network);
  const info = noRelay ? null : await client.relayInfo().catch(() => null);
  const fee = info?.fees?.['0x' + String(asset).replace(/^0x/, '').toLowerCase()];
  const askQuote = () => client.quote({ asset: '0x' + String(asset).replace(/^0x/, '') });
  const q = fee != null ? await askQuote().catch(() => new Promise((r) => setTimeout(r, 1500)).then(askQuote).catch(() => null)) : null;
  const cap = maxFee ?? (fee != null ? (BigInt(fee) * 5n) / 4n : null);
  if (q && cap != null && BigInt(q.fee) > BigInt(cap)) throw Object.assign(new Error('The relay’s fee changed.'), { feeMoved: BigInt(q.fee) });
  const pay = deductFee ? amount - (q ? BigInt(q.fee) : 0n) : amount;
  if (pay <= 0n) throw Object.assign(new Error('The relay’s fee is more than this payment.'), { feeOver: q ? BigInt(q.fee) : 0n });
  say('finding your notes…');
  const a = await prepare(poolWallet, asset, pay + (q ? BigInt(q.fee) : 0n), anchor, inputs);
  if (a.wait) return { wait: a.wait, tip: a.tip };
  if (!q && !noRelay && askSelf && !(await askSelf('no-relay'))) throw relayDeclined('The relay can’t take this one right now. Nothing was sent.');
  const outputs = [{ address: to, value: pay }];
  if (q) outputs.push({ address: q.address, value: BigInt(q.fee) });
  const built = pool.buildSpendBody({ asset: '0x' + String(asset).replace(/^0x/, ''), hAnchor: a.hAnchor, root: a.root, inputs: a.notes, outputs, wallet: poolWallet, bind: q ? q.bind : null });
  const { payload, payloadHex } = await proveHere(built, say);
  if (q) {
    say('Handing it to the relay…');
    const relayed = (carrier) => { pendingMark(a.notes, carrier, a.total - pay - BigInt(q.fee), asset, 0n, ownerTag(poolWallet)); return { revealTxid: carrier, relayed: true, anchor: a.hAnchor, amount: pay, fee: BigInt(q.fee) }; };
    const landed = (stt) => stt?.carrier || (stt?.state === 'confirmed' ? stt.carrier || null : undefined);
    let reason = null, sub = null, timedOut = false;
    try {
      try { sub = await client.submit({ payload: payloadHex, quoteId: q.quoteId }); }
      catch (e) {
        if (requoted || !/quote expired/i.test(e?.message || '')) throw e;
        say('The relay’s quote ran out while the proof was made; asking for a new one…');
        return payPrivately(tacit, { poolWallet, to, amount, asset, anchor: a.hAnchor, noRelay, maxFee, say, inputs: a.notes, askSelf, deductFee, requoted: true });
      }
      for (let i = 0; i < 60 && !reason; i++) {
        const stt = await client.relayStatus(sub.id).catch(() => null);
        if (landed(stt) !== undefined) return relayed(landed(stt));
        if (stt && (['dropped', 'rejected'].includes(stt.state) || spentElsewhere(stt.state))) { reason = stt.reason || stt.state; break; }
        say('Waiting for the relay’s batch…');
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!reason) { reason = 'it did not post in time'; timedOut = true; }
    } catch (e) { reason = e?.message || String(e); }
    if (spentElsewhere(reason)) throw new Error('Those notes are already being spent by another payment. Wait for it to settle, then try again.');
    if (!askSelf) {
      say('The relay could not post it in time, so this wallet is posting it from its Bitcoin address…');
      return payPrivately(tacit, { poolWallet, to, amount, asset, anchor: a.hAnchor, noRelay: true, say, inputs: a.notes, deductFee });
    }
    const ctl = new AbortController();
    const watch = timedOut ? (async () => {
      while (!ctl.signal.aborted) {
        await new Promise((r) => setTimeout(r, 5000));
        const stt = ctl.signal.aborted ? null : await client.relayStatus(sub.id).catch(() => null);
        if (landed(stt) !== undefined) return { carrier: landed(stt), landed: true };
      }
      return {};
    })() : null;
    const asked = (async () => ({ ok: !!(await askSelf('relay-slow', { timedOut, signal: ctl.signal })) }))();
    const got = await (watch ? Promise.race([asked, watch]) : asked).finally(() => ctl.abort());
    if (got.landed) return relayed(got.carrier);
    if (!got.ok) {
      if (!timedOut) throw relayDeclined('The relay hasn’t posted it yet and may still. Nothing else was sent; check your balance before paying again.');
      pendingMark(a.notes, null, 0n, asset, 0n, ownerTag(poolWallet), { hold: MAY_STILL_MS });
      throw relayDeclined('The relay hasn’t posted it yet and may still. Nothing else was sent; the TAC it would spend is set aside for half an hour, so it is not paid twice.');
    }
    say('Posting it from your Bitcoin address…');
    return payPrivately(tacit, { poolWallet, to, amount, asset, anchor: a.hAnchor, noRelay: true, say, inputs: a.notes, deductFee });
  }
  say('sending…');
  const own = tacit.p2wpkhScript(tacit.wallet.pub);
  const r = await broadcastCarrier(tacit, { payload, outputs: [{ value: tacit.DUST, script: own }] });
  pendingMark(a.notes, r.revealTxid, a.total - pay, asset, 0n, ownerTag(poolWallet));
  return { ...r, relayed: false, anchor: a.hAnchor, amount: pay };
}

export function combinePlan(values, need, fee = 0n) {
  const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0), u = values.map(BigInt).filter((v) => v > 0n).sort(desc), want = BigInt(need), f = BigInt(fee);
  for (let n = 0; n < 64; n++) {
    if ((u[0] ?? 0n) + (u[1] ?? 0n) >= want) return n;
    if (u.length < 2 || u[0] + u[1] <= f) return null;
    u.splice(0, 2, u[0] + u[1] - f);
    u.sort(desc);
  }
  return null;
}

export async function combineNotes(tacit, { poolWallet, asset, anchor = null, noRelay = false, maxFee = null, say = () => {}, askSelf = null }) {
  if (!noRelay && maxFee == null) throw new Error('combineNotes: a relayed join needs maxFee');
  const desc = (a, b) => (BigInt(a.value) < BigInt(b.value) ? 1 : BigInt(a.value) > BigInt(b.value) ? -1 : 0);
  const two = pendingView(await poolNotes(poolWallet, asset)).live.filter((n) => BigInt(n.value) > 0n).sort(desc).slice(0, 2);
  if (two.length < 2) throw Object.assign(new Error('Your shielded balance is one note: there is nothing to combine.'), { said: true });
  const total = BigInt(two[0].value) + BigInt(two[1].value);
  if (!noRelay && total <= BigInt(maxFee)) throw Object.assign(new Error('Your two largest notes hold less than the relay’s fee.'), { said: true });
  let r;
  try { r = await payPrivately(tacit, { poolWallet, to: poolWallet.addressString, amount: total, deductFee: true, asset, anchor, noRelay, maxFee, say, inputs: two, askSelf }); }
  catch (e) { if (e?.feeOver != null) throw Object.assign(new Error('Your two largest notes hold less than the relay’s fee.'), { said: true }); throw e; }
  if (r.wait) return r;
  const value = r.amount;
  pendingMark(two, r.revealTxid, value, asset, 0n, ownerTag(poolWallet));
  return { ...r, value };
}

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
  pendingMark(a.notes, r.revealTxid, change, asset, amount, ownerTag(poolWallet));
  tacit.recordOpening?.(r.revealTxid, 0, String(asset).replace(/^0x/, '').toLowerCase(), amount, BigInt(built.exit.blinding));
  return { ...r, exit: { vout: 0, value: amount.toString(), blinding: built.exit.blinding, cx: built.exit.cx, cy: built.exit.cy }, anchor: a.hAnchor };
}

export async function recoverExitOpenings(tacit, { poolWallet, asset, utxos, notes }) {
  const assetHex = String(asset).replace(/^0x/, '').toLowerCase();
  let n = 0;
  for (const u of utxos || []) {
    const tx = await tacit.getTx(u.txid).catch(() => null);
    const env = tx ? tacit.txOutputEnvelope(tx) : null;
    if (!env || env.opcode !== 0x6d) continue;
    let o;
    try { o = pool.recoverExit(poolWallet, env.payload, notes); } catch { continue; }
    if (o.exitVout !== u.vout) continue;
    tacit.recordOpening(u.txid, u.vout, assetHex, BigInt(o.value), BigInt(o.blinding));
    n++;
  }
  return n;
}

async function faucetCall(url, init, { timeoutMs = 60_000, who = 'faucet' } = {}) {
  let r;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try { r = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }, signal: ctl?.signal }); }
  catch { throw Object.assign(new Error(`The ${who} is unreachable; try again in a minute.`), { unreachable: true }); }
  finally { if (timer) clearTimeout(timer); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${who === 'faucet' ? 'Faucet' : 'The ' + who}: ${j.error || `HTTP ${r.status}`}`);
  return j;
}
async function findFill(faucetUrl, quoteId, say) {
  for (let i = 0; i < 12; i++) {
    say('checking with the faucet…');
    const st = await fetchFaucet(faucetUrl).catch(() => null);
    const hit = st?.maker?.recent_fills?.find((x) => x.quoteId === quoteId);
    if (hit) return { txid: hit.txid, sats: hit.sats, commitTxid: null };
    await new Promise((res) => setTimeout(res, 10_000));
  }
  return null;
}
export const makerQuote = (units, faucetUrl = FAUCET_URL) => faucetCall(`${faucetUrl}/faucet/maker/quote?units=${BigInt(units)}`);

export async function sellForSats(tacit, { poolWallet, amount, asset, anchor = null, usedScripts = new Set(), say = () => {}, prove = proveHere, faucetUrl = FAUCET_URL }) {
  const assetHex = String(asset).replace(/^0x/, '').toLowerCase();
  say('finding your notes…');
  const a = await prepare(poolWallet, assetHex, amount, anchor);
  if (a.wait) return { wait: a.wait, tip: a.tip };
  say('asking the faucet for a price…');
  const q = await makerQuote(amount, faucetUrl);
  if (BigInt(q.units) !== BigInt(amount) || String(q.asset).replace(/^0x/, '').toLowerCase() !== assetHex) throw new Error('the faucet quoted other terms');
  const r = zap.exitToSats({
    pool, wallet: poolWallet, notes: a.notes, amount, asset: '0x' + assetHex, hAnchor: a.hAnchor, root: a.root, usedScripts,
    maker: { spk: '0x' + String(q.makerSpk).replace(/^0x/, ''), sats: BigInt(q.sats), vout: q.wantVout, exitVout: q.exitVout, bind: q.bind },
  });
  const { payloadHex } = await prove(r.spend, say);
  say('the faucet is checking and posting the swap…');
  let f;
  try {
    f = await faucetCall(`${faucetUrl}/faucet/maker/fill`, {
      method: 'POST',
      body: JSON.stringify({
        quoteId: q.quoteId, payload: payloadHex,
        offer: { exitOpening: { value: r.offer.exitOpening.value.toString(), blinding: r.offer.exitOpening.blinding }, payoutScriptPubKey: r.offer.payoutScriptPubKey },
      }),
    }, { timeoutMs: 120_000 });
  } catch (e) {
    if (!e.unreachable) throw e;
    f = await findFill(faucetUrl, q.quoteId, say);
    if (!f) throw new Error('The faucet did not answer. If the swap went out it shows in your activity within a few minutes.');
  }
  pendingMark(a.notes, f.txid, 0n, assetHex);
  return {
    revealTxid: f.txid, commitTxid: f.commitTxid, sats: Number(f.sats), units: BigInt(amount),
    payout: { counter: r.payout.counter, scriptPubKey: r.payout.scriptPubKey, vout: q.wantVout }, anchor: a.hAnchor,
  };
}

export const makerQuoteSats = (sats, makerUrl) => faucetCall(`${String(makerUrl).replace(/\/$/, '')}/maker/quote?sats=${BigInt(sats)}`, undefined, { who: 'maker' });
async function findMakerFill(makerUrl, quoteId, say) {
  for (let i = 0; i < 12; i++) {
    say('checking with the maker…');
    const st = await fetch(`${String(makerUrl).replace(/\/$/, '')}/maker/status`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const hit = st?.recent_fills?.find((x) => x.quoteId === quoteId);
    if (hit) return { txid: hit.txid, sats: hit.sats, commitTxid: null };
    await new Promise((res) => setTimeout(res, 10_000));
  }
  return null;
}
export async function payThroughMaker(tacit, { poolWallet, sats, payoutScript, asset = TAC_ASSET_MAINNET, anchor = null, usedScripts = new Set(), say = () => {}, prove = proveHere, makerUrl }) {
  const assetHex = String(asset).replace(/^0x/, '').toLowerCase();
  const base = String(makerUrl).replace(/\/$/, '');
  say('asking the maker for a price…');
  const q = await makerQuoteSats(sats, base);
  if (BigInt(q.sats) !== BigInt(sats) || String(q.asset).replace(/^0x/, '').toLowerCase() !== assetHex) throw new Error('The maker quoted other terms.');
  const units = BigInt(q.units);
  say('finding your notes…');
  const a = await prepare(poolWallet, assetHex, units, anchor);
  if (a.wait) return { wait: a.wait, tip: a.tip };
  const r = zap.exitToSats({
    pool, wallet: poolWallet, notes: a.notes, amount: units, asset: '0x' + assetHex, hAnchor: a.hAnchor, root: a.root, usedScripts,
    payoutScriptPubKey: payoutScript,
    maker: { spk: '0x' + String(q.makerSpk).replace(/^0x/, ''), sats: BigInt(q.sats), vout: q.wantVout, exitVout: q.exitVout, bind: q.bind },
  });
  const { payloadHex } = await prove(r.spend, say);
  say('the maker is checking and posting it…');
  let f;
  try {
    f = await faucetCall(`${base}/maker/fill`, {
      method: 'POST',
      body: JSON.stringify({
        quoteId: q.quoteId, payload: payloadHex,
        offer: { exitOpening: { value: r.offer.exitOpening.value.toString(), blinding: r.offer.exitOpening.blinding }, payoutScriptPubKey: r.offer.payoutScriptPubKey },
      }),
    }, { timeoutMs: 120_000, who: 'maker' });
  } catch (e) {
    if (!e.unreachable) throw e;
    f = await findMakerFill(base, q.quoteId, say);
    if (!f) throw new Error('The maker did not answer. If the payment went out it shows in your activity within a few minutes.');
  }
  pendingMark(a.notes, f.txid, 0n, assetHex);
  return { revealTxid: f.txid, commitTxid: f.commitTxid, sats: Number(f.sats), units, anchor: a.hAnchor, price: q.price };
}

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const bech32Poly = (vs) => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const v of vs) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i]; }
  return c >>> 0;
};
const hrpWords = (hrp) => [...hrp].map((ch) => ch.charCodeAt(0) >> 5).concat(0, [...hrp].map((ch) => ch.charCodeAt(0) & 31));
function segwitAddress(hrp, version, program) {
  const words = [version];
  let acc = 0, bits = 0;
  for (const x of program) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31); } }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const pm = bech32Poly([...hrpWords(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ (version === 0 ? 1 : 0x2bc830a3);
  const cs = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...cs].map((w) => B32[w]).join('')}`;
}

export function payoutScriptFor(addr) {
  const s = String(addr || '').trim();
  if (!/^bc1/i.test(s)) throw new Error('Use a bc1q… or bc1p… Bitcoin address.');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('That address mixes upper and lower case. Retype it.');
  const a = s.toLowerCase();
  if (!/^bc1[qp][02-9ac-hj-np-z]{6,}$/.test(a)) throw new Error('Use a bc1q… or bc1p… Bitcoin address.');
  const words = [...a.slice(3)].map((ch) => B32.indexOf(ch));
  const ver = words[0];
  if (bech32Poly([...hrpWords('bc'), ...words]) !== (ver === 0 ? 1 : 0x2bc830a3)) throw new Error('That address did not check out. Retype it.');
  let acc = 0, bits = 0;
  const prog = [];
  for (const v of words.slice(1, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; prog.push((acc >>> bits) & 0xff); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error('That address did not check out. Retype it.');
  if (ver === 0 && prog.length === 20) return Uint8Array.from([0x00, 0x14, ...prog]);
  if (ver === 1 && prog.length === 32) return Uint8Array.from([0x51, 0x20, ...prog]);
  throw new Error('Use a bc1q… or bc1p… Bitcoin address.');
}
export function p2trAddress(spkHex, network = 'signet') {
  const spk = hexToBytes(String(spkHex).replace(/^0x/, ''));
  if (spk.length !== 34 || spk[0] !== 0x51 || spk[1] !== 0x20) throw new Error('not a P2TR script');
  return segwitAddress(network === 'mainnet' ? 'bc' : 'tb', 1, spk.slice(2));
}

export function knownExitCount(network, pubHex) {
  let st = {};
  try { st = JSON.parse(localStorage.getItem(`tacit-sats-demo-v2:${network}:${pubHex}`) || '{}') || {}; } catch {}
  const counters = (st.sells || []).map((x) => Number(x.payout?.counter)).filter(Number.isInteger);
  return Math.max((st.sellUsed || []).length, counters.length ? Math.max(...counters) + 1 : 0);
}

export async function isPlainSats(tacit, tx, vout) {
  const out = tx.vout[vout];
  if (!out) return false;
  const env = tacit.txOutputEnvelope(tx);
  if (env) {
    if (env.opcode === 0x6d) {
      let sp;
      try { sp = pool.parseSpend(env.payload, { full: true }); } catch { return false; }
      if (sp.exit && sp.exit.exitVout === vout) return false;
      if (sp.want && sp.want.vout === vout) {
        return String(sp.want.spkHash).replace(/^0x/, '') === pool.exitDestHash('0x' + out.scriptpubkey).replace(/^0x/, '');
      }
    } else {
      const pd = await tacit.getParentEnvelopeData(env, vout, tx.txid).catch(() => 'unknown');
      if (pd) return false;
    }
  }
  return out.value > tacit.DUST;
}

const EXIT_GAP = 3;
export async function exitCoins(tacit, poolWallet, { known = 0 } = {}) {
  const coins = [], held = [];
  const txs = new Map();
  let quiet = 0;
  for (let c = 0; c < known || quiet < EXIT_GAP; c++) {
    const k = pool.deriveExitKey(poolWallet, c, 'p2tr');
    const addr = p2trAddress(k.scriptPubKey, poolWallet.network);
    const info = await esplora(tacit, `/address/${addr}`);
    const s = info ? [info.chain_stats, info.mempool_stats] : [];
    if (!s.some((x) => x?.tx_count > 0)) { quiet++; continue; }
    quiet = 0;
    const live = s.reduce((t, x) => t + (x?.funded_txo_count || 0) - (x?.spent_txo_count || 0), 0);
    if (live <= 0) continue;
    for (const u of (await esplora(tacit, `/address/${addr}/utxo`)) || []) {
      if (!txs.has(u.txid)) txs.set(u.txid, await esplora(tacit, `/tx/${u.txid}`));
      const tx = txs.get(u.txid);
      const coin = { txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed, counter: c, spk: String(k.scriptPubKey).replace(/^0x/, '') };
      (tx && (await isPlainSats(tacit, tx, u.vout)) ? coins : held).push(coin);
    }
  }
  return { coins, held };
}

export const sweepVbytes = (n, m = 0) => Math.ceil(10.5 + 57.5 * n + 68 * m + 31);

export function buildSweep({ poolWallet, coins, walletCoins = [], toScript, feeRate, signKeyPath, signWallet, serializeTx, txid, dust = 546 }) {
  if (!coins.length) throw new Error('nothing to move');
  const total = coins.reduce((t, c) => t + c.value, 0);
  const added = walletCoins.reduce((t, c) => t + c.value, 0);
  const fee = Math.ceil(sweepVbytes(coins.length, walletCoins.length) * feeRate);
  const value = total + added - fee;
  if (value <= dust) throw new Error(`${total} sats is too little to move at ${feeRate} sat/vB (fee ${fee}); add sats to your wallet or wait for more`);
  const all = [...coins, ...walletCoins];
  const tx = {
    version: 2, locktime: 0,
    inputs: all.map((c) => ({ txid: c.txid, vout: c.vout, sequence: SEQ, witness: [] })),
    outputs: [{ value, script: toScript }],
  };
  const prevouts = [...coins.map((c) => ({ value: c.value, script: hexToBytes(c.spk) })), ...walletCoins.map((c) => ({ value: c.value, script: toScript }))];
  coins.forEach((c, i) => {
    const k = pool.deriveExitKey(poolWallet, c.counter, 'p2tr');
    if (String(k.scriptPubKey).replace(/^0x/, '') !== c.spk) throw new Error('exit key does not match the coin');
    tx.inputs[i].witness = signKeyPath(tx, i, prevouts, hexToBytes(String(k.outputPriv).replace(/^0x/, '')));
  });
  walletCoins.forEach((c, j) => { tx.inputs[coins.length + j].witness = signWallet(tx, coins.length + j, c.value); });
  return { tx, hex: bytesToHex(serializeTx(tx)), txid: txid(tx), total, added, fee, value };
}

export async function sweepFeeRate(tacit) {
  const r = Number(await tacit.getFeeRate(null, { fresh: true }));
  return Math.max(1, Number.isFinite(r) ? r : 1);
}

export async function planSweep(tacit, poolWallet, coins, { feeRate = null } = {}) {
  const rate = feeRate ?? await sweepFeeRate(tacit);
  const deps = {
    poolWallet, coins, toScript: tacit.p2wpkhScript(tacit.wallet.pub), feeRate: rate,
    signKeyPath: tacit.signTaprootKeyPathInputWithKey, signWallet: tacit.signP2wpkhInput, serializeTx: tacit.serializeTx, txid: tacit.txid, dust: tacit.DUST,
  };
  const total = coins.reduce((t, c) => t + c.value, 0);
  if (total - Math.ceil(sweepVbytes(coins.length) * rate) > tacit.DUST) return buildSweep(deps);
  const own = tacit.selectSatsUtxosSafe(await tacit.getUtxos(tacit.wallet.address()), await tacit.scanHoldings()).sort((a, b) => a.value - b.value);
  const need = tacit.DUST + 1 + Math.ceil(sweepVbytes(coins.length, 1) * rate) - total;
  const top = own.find((u) => u.value >= need);
  if (!top) return buildSweep(deps);
  return buildSweep({ ...deps, walletCoins: [{ txid: top.txid, vout: top.vout, value: top.value }] });
}

export async function sweepExitCoins(tacit, poolWallet, coins, { feeRate = null } = {}) {
  const b = await planSweep(tacit, poolWallet, coins, { feeRate });
  await tacit.broadcast(b.hex);
  return { txid: b.txid, total: b.total, added: b.added, fee: b.fee, value: b.value };
}

const SALE_GAP = 6;
const SALE_HOLD_MS = 24 * 3600e3;
const SALE_KEYS_KEY = 'tacit-pool-sale-keys-v1';
const strip0x = (h) => String(h).replace(/^0x/, '').toLowerCase();

export function saleKey(poolWallet, counter) {
  const k = pool.deriveExitKey(poolWallet, counter, 'p2wpkh');
  const spk = strip0x(k.scriptPubKey);
  return { counter, priv: strip0x(k.priv), pub: strip0x(k.pub), scriptPubKey: spk, address: segwitAddress(poolWallet.network === 'mainnet' ? 'bc' : 'tb', 0, hexToBytes(spk).slice(2)) };
}

function saleHeld(poolWallet) {
  let v = null;
  try { v = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(SALE_KEYS_KEY) || 'null'); } catch {}
  const now = Date.now(), mine = v?.[ownerTag(poolWallet)] || {};
  return new Set(Object.entries(mine).filter(([, at]) => now - at < SALE_HOLD_MS).map(([c]) => Number(c)));
}
function saleHold(poolWallet, counter) {
  try {
    if (typeof localStorage === 'undefined') return;
    const v = JSON.parse(localStorage.getItem(SALE_KEYS_KEY) || 'null') || {}, tag = ownerTag(poolWallet), now = Date.now();
    const mine = Object.fromEntries(Object.entries(v[tag] || {}).filter(([, at]) => now - at < SALE_HOLD_MS));
    mine[counter] = now;
    localStorage.setItem(SALE_KEYS_KEY, JSON.stringify({ ...v, [tag]: mine }));
  } catch {}
}

export async function saleKeys(tacit, poolWallet, notes, asset, { addresses = [] } = {}) {
  const assetHex = strip0x(asset), held = saleHeld(poolWallet);
  const used = async (addr) => {
    const i = await esplora(tacit, `/address/${addr}`);
    return !!i && [i.chain_stats, i.mempool_stats].some((x) => x?.tx_count > 0);
  };
  const keys = [];
  let quiet = 0, free = null;
  for (let c = 0; quiet < SALE_GAP || free == null; c++) {
    const k = saleKey(poolWallet, c);
    if (!(await used(k.address))) {
      if (await used(p2trAddress(pool.deriveExitKey(poolWallet, c, 'p2tr').scriptPubKey, poolWallet.network))) { quiet = 0; continue; }
      quiet++;
      if (free == null && !held.has(c)) free = c;
      continue;
    }
    quiet = 0;
    const found = [];
    for (const u of (await esplora(tacit, `/address/${k.address}/utxo`)) || []) {
      const tx = await tacit.getTx(u.txid).catch(() => null);
      const env = tx ? tacit.txOutputEnvelope(tx) : null;
      if (!env || env.opcode !== 0x6d) continue;
      let o;
      try { o = pool.recoverExit(poolWallet, env.payload, notes, { addresses }); } catch { continue; }
      if (o.exitVout !== u.vout) continue;
      tacit.recordOpening(u.txid, u.vout, assetHex, BigInt(o.value), BigInt(o.blinding));
      found.push({ txid: u.txid, vout: u.vout, value: BigInt(o.value), confirmed: !!u.status?.confirmed });
    }
    keys.push({ ...k, notes: found });
  }
  return { keys, free };
}

export async function exitToSaleKey(tacit, { poolWallet, amount, asset, key, anchor = null, maxFee = null, say = () => {}, inputs = null, requoted = false }) {
  const assetHex = strip0x(asset), client = poolClientFor(poolWallet.network);
  const NOT_NOW = 'The relay can’t take this one right now. Nothing was sent. Try again in a few minutes.';
  const info = await client.relayInfo().catch(() => null);
  const listed = info?.fees?.['0x' + assetHex];
  if (listed == null) throw relayDeclined(NOT_NOW);
  const askQuote = () => client.quote({ asset: '0x' + assetHex, exitScriptPubKey: key.scriptPubKey });
  const q = await askQuote().catch(() => new Promise((r) => setTimeout(r, 1500)).then(askQuote).catch(() => null));
  if (!q || !Number.isInteger(q.exitVout)) throw relayDeclined(NOT_NOW);
  const fee = BigInt(q.fee);
  if (fee > (maxFee ?? (BigInt(listed) * 5n) / 4n)) throw Object.assign(new Error('The relay’s fee changed.'), { feeMoved: fee });
  say('finding your notes…');
  const a = await prepare(poolWallet, assetHex, amount + fee, anchor, inputs);
  if (a.wait) return { wait: a.wait, tip: a.tip };
  saleHold(poolWallet, key.counter);
  const self = { address: poolWallet.internalAddress, network: poolWallet.network };
  const change = a.total - amount - fee;
  const outputs = [{ address: q.address, value: fee }];
  if (change > 0n) outputs.push({ ...self, value: change });
  while (outputs.length < 3) outputs.push({ ...self, value: 0n });
  const build = (exitVout) => pool.buildSpendBody({
    asset: '0x' + assetHex, hAnchor: a.hAnchor, root: a.root, inputs: a.notes, wallet: poolWallet, bind: q.bind, outputs,
    exit: { exitVout, scriptPubKey: '0x' + key.scriptPubKey, value: amount },
  });
  // a submit with no answer, or a server error, may be one the relay took: its notes are set aside as when it has not posted yet, and the error says so
  const unsure = (e) => {
    if (e?.status >= 400 && e?.status < 500) return e;
    if (e?.status === 503 && e?.body?.error) return e;                         // the relay's own refusal (busy, behind, carrier full), said before it took anything
    pendingMark(a.notes, null, 0n, assetHex, 0n, ownerTag(poolWallet), { hold: MAY_STILL_MS });
    return relayDeclined('The relay did not answer, and it may still take this payment. Nothing else was sent; check your balance before paying again.');
  };
  let built = build(q.exitVout);
  let { payloadHex } = await proveHere(built, say);
  say('Handing it to the relay…');
  let sub;
  try { sub = await client.submit({ payload: payloadHex, quoteId: q.quoteId }); }
  catch (e) {
    if (!requoted && /quote expired/i.test(e?.message || '')) {
      say('The relay’s quote ran out while the proof was made; asking for a new one…');
      return exitToSaleKey(tacit, { poolWallet, amount, asset, key, anchor: a.hAnchor, maxFee, say, inputs: a.notes, requoted: true });
    }
    if (e?.status !== 409 || !Number.isInteger(e?.body?.exitVout)) throw unsure(e);
    built = build(e.body.exitVout);
    ({ payloadHex } = await proveHere(built, say));
    try { sub = await client.submit({ payload: payloadHex, quoteId: q.quoteId }); } catch (e2) { throw unsure(e2); }
  }
  const exitVout = built.exit.exitVout;
  for (let i = 0; i < 60; i++) {
    const st = await client.relayStatus(sub.id).catch(() => null);
    const carrier = st?.carrier || (st?.state === 'confirmed' ? null : undefined);
    if (carrier !== undefined) {
      pendingMark(a.notes, carrier, a.total - amount - fee, assetHex, amount, ownerTag(poolWallet), { pay: true });
      if (carrier) tacit.recordOpening?.(carrier, exitVout, assetHex, amount, BigInt(built.exit.blinding));
      return { revealTxid: carrier, exitVout, amount, fee };
    }
    if (st && (['dropped', 'rejected'].includes(st.state) || spentElsewhere(st.state))) {
      if (spentElsewhere(st.reason || st.state)) throw new Error('Those notes are already being spent by another payment. Wait for it to settle, then try again.');
      throw new Error(`The relay could not post it (${st.reason || st.state}). Nothing was sent.`);
    }
    say('Waiting for the relay’s batch…');
    await new Promise((r) => setTimeout(r, 5000));
  }
  pendingMark(a.notes, null, 0n, assetHex, 0n, ownerTag(poolWallet), { hold: MAY_STILL_MS });
  throw relayDeclined('The relay hasn’t posted it yet and may still. Nothing else was sent; once it posts, the TAC shows here, ready to list.');
}

export async function listFromSaleKey(tacit, { key, note, sats, expiry, payoutScript, onProgress = null }) {
  const keep = { priv: tacit.wallet.priv, pub: tacit.wallet.pub };
  const priv = hexToBytes(key.priv);
  tacit.wallet.priv = priv; tacit.wallet.pub = hexToBytes(key.pub);
  try { tacit.invalidateHoldingsCache?.(); } catch {}
  try {
    return await tacit.publishPreauthSale({ utxoTxid: note.txid, utxoVout: note.vout, minPriceSats: Number(sats), expiry, sellerPayoutScript: payoutScript, onProgress });
  } finally {
    priv.fill(0);
    tacit.wallet.priv = keep.priv; tacit.wallet.pub = keep.pub;
    try { tacit.invalidateHoldingsCache?.(); } catch {}
  }
}

export async function saleQuote(sats, { asset = TAC_ASSET_MAINNET, network = 'mainnet', under = 0.02, decimals = 8, fast = false } = {}) {
  const net = network === 'mainnet' ? 'mainnet' : 'signet';
  const read = (u) => fetch(u, { cache: 'no-store', signal: AbortSignal.timeout?.(20_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [book, info] = await Promise.all([read(`${WORKER_BASE}/assets/${asset}/preauth-sales?network=${net}`), read(`${WORKER_BASE}/assets/${asset}?network=${net}`)]);
  const now = Date.now() / 1000, one = 10 ** decimals;
  const asks = (book?.sales || [])
    .filter((s) => !s.expired && Number(s.expiry) > now && /^\d+$/.test(String(s.asset_opening?.amount)) && BigInt(s.asset_opening.amount) > 0n)
    .map((s) => Number(s.min_price_sats) / (Number(s.asset_opening.amount) / one));
  const ask = asks.length ? Math.min(...asks) : null, mark = Number(info?.mark_price?.unit) || null;
  const recent = mark && Number(info?.mark_price?.ts) > now - 7 * 86400 ? mark : null;
  let base, basis;
  if (fast && recent && (!ask || recent < ask)) { base = recent; basis = 'trade'; }
  else if (ask) { base = ask; basis = 'ask'; }
  else { base = mark; basis = 'trade'; }
  if (!(base > 0)) return null;
  const unit = base * (1 - under);
  return { unit, units: BigInt(Math.ceil((Number(sats) * one) / unit)), ask, mark, basis };
}

export const BUY_CARRIER_VB = 1150;
export async function buyFee(tacit, tier = 'priority') {
  return Math.ceil((await tacit.getFeeRate(tier, { fresh: true, safetyMult: 1.2 })) * BUY_CARRIER_VB);
}

export async function lotsToBuy(tacit, { asset = TAC_ASSET_MAINNET, network = 'mainnet', budget = null, limit = 3, minLeft = 900, decimals = 8, exclude = null } = {}) {
  const assetHex = String(asset).replace(/^0x/, '').toLowerCase();
  const book = await fetch(`${WORKER_BASE}/assets/${assetHex}/preauth-sales?network=${network === 'mainnet' ? 'mainnet' : 'signet'}`, { cache: 'no-store', signal: AbortSignal.timeout?.(20_000) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!book) return null;
  const now = Date.now() / 1000, mine = tacit?.wallet?.pub ? bytesToHex(tacit.wallet.pub) : null, one = 10 ** decimals;
  const live = (book.sales || [])
    .filter((s) => !s.expired && Number(s.expiry) > now + minLeft && s.seller_pubkey !== mine && !exclude?.has(strip0x(s.seller_pubkey)) && /^\d+$/.test(String(s.asset_opening?.amount)) && BigInt(s.asset_opening.amount) > 0n)
    .map((s) => ({ ...s, unit: Number(s.min_price_sats) / (Number(s.asset_opening.amount) / one) }))
    .sort((a, b) => a.unit - b.unit || Number(a.min_price_sats) - Number(b.min_price_sats));
  const within = budget == null ? live : live.filter((s) => Number(s.min_price_sats) <= Number(budget));
  const seen = new Set(), distinct = within.filter((s) => { const k = `${s.asset_opening.amount}:${s.min_price_sats}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { lots: distinct.slice(0, limit), smallest: live.reduce((m, s) => (!m || Number(s.min_price_sats) < Number(m.min_price_sats) ? s : m), null) };
}

export async function saleSettlement(tacit, { note, payoutScript, sats }) {
  const sp = await esplora(tacit, `/tx/${note.txid}/outspend/${note.vout}`);
  if (!sp?.spent || !sp.txid) return null;
  const tx = await tacit.getTx(sp.txid).catch(() => null);
  const want = bytesToHex(payoutScript);
  const paid = !!tx?.vout?.some((o) => String(o.scriptpubkey).toLowerCase() === want && Number(o.value) >= Number(sats));
  return { txid: sp.txid, paid, confirmed: !!(sp.status?.confirmed ?? tx?.status?.confirmed) };
}

const SINGLE_ACTION_JOIN = true;
const joinImpl = buyAndShield;

const hooks = new Map();
export function registerStep(id, impl) { hooks.set(id, impl); }

export const STEPS = [
  { id: 'sats', title: 'Get signet sats' },
  ...(SINGLE_ACTION_JOIN
    ? [{ id: 'join', title: 'Get private cBTC' }]
    : [{ id: 'get', title: 'Get cBTC' }, { id: 'shield', title: 'Shield' }]),
  { id: 'pay', title: 'Pay privately' }, { id: 'receive', title: 'Receive' }, { id: 'exit', title: 'Exit' },
  { id: 'sell', title: 'Back to sats' },
];

const POOL_STEPS = new Set(['pay', 'receive', 'exit', 'sell']);

const ABOUT = {
  sats: 'Free test sats for fees and the cBTC price.',
  get: 'Swap sats for a test cBTC lot in one atomic swap.',
  shield: 'Move it into the pool, where amounts and owners are hidden.',
  join: 'Swap sats for test cBTC straight into the pool, in one transaction.',
  pay: 'Pay a pool address. Amount and source stay hidden.',
  receive: 'Find pool payments sent to you.',
  exit: 'Leave the pool as ordinary cBTC in your wallet.',
  sell: 'Swap private cBTC for sats in one transaction. Change stays in the pool.',
};

const STAGE = {
  'fetch-start': 'checking the lot…', 'commit-start': 'sending your payment…',
  'wait-visible': 'waiting for the network…', 'broadcast-start': 'claiming the lot…',
};

const FEE_ALLOWANCE = 2500;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

export const askSelfIn = (host) => (why, { timedOut = false, signal } = {}) => new Promise((resolve) => {
  const lead = why === 'relay-slow' ? (timedOut ? 'The relay hasn’t posted it in five minutes.' : 'The relay hasn’t posted it.') : 'The relay didn’t take this payment.';
  const yes = el('button', { class: 'btn', type: 'button' }, 'Post it from my Bitcoin address');
  const no = el('button', { class: 'btn quiet', type: 'button' }, 'Not now');
  const box = el('span', { role: 'group' }, `${lead} Post it from your Bitcoin address instead? Your Bitcoin address shows as the sender. `, yes, no);
  const end = (answer) => { clearTimeout(timer); signal?.removeEventListener('abort', decline); box.remove(); resolve(answer); };
  const decline = () => end(false), timer = setTimeout(decline, 10 * 60e3);
  yes.addEventListener('click', () => end(true)); no.addEventListener('click', decline);
  if (signal?.aborted) return decline();
  signal?.addEventListener('abort', decline);
  host.replaceChildren(box);
});

function stepError(e, ctx) {
  const m = String(e?.message || e || '');
  if (/locked at [0-9a-f]{64}/.test(m)) return 'Your payment went out but the claim did not finish. The sats are recoverable from the main Tacit app (Holdings, stranded commits).';
  let x;
  if ((x = m.match(/insufficient sats for (?:commit|reveal) \(need ~?(\d+), have (\d+)\)/)) || (x = m.match(/not enough (?:signet )?sats(?: at your Bitcoin address)?: need (\d+), have (\d+)/))) {
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

  let who = null;
  let state = {};
  const key = () => (who?.pubHex ? `tacit-sats-demo-v2:${network}:${who.pubHex}` : null);
  const load = () => { try { return JSON.parse((key() && localStorage.getItem(key())) || '{}') || {}; } catch { return {}; } };
  const save = () => { try { if (key()) localStorage.setItem(key(), JSON.stringify(state)); } catch {} };

  let faucet = { loading: true, status: null, error: null };
  let running = null;
  const errs = {};
  const progress = {};

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
    return el('div', {}, `Swap ${n(st.price_sats)} signet sats for ${fmt(st.lot)} test ${ticker()}. ${k} lot${k === 1 ? '' : 's'} open.`);
  }

  function phases() {
    const done = {
      sats: !!(state.note || state.poolNote) || (satsKnown() && who.sats >= need()),
      get: !!(state.note || state.poolNote),
      shield: !!state.poolNote,
      join: !!state.poolNote,
      pay: !!state.pays?.length,
      receive: !!state.received?.length,
      exit: !!state.exits?.length,
      sell: !!state.sells?.length,
    };
    const out = {};
    let open = !!who?.connected;
    for (const { id, soon } of STEPS) {
      if (soon && !hooks.has(id)) { out[id] = 'soon'; continue; }
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
      el('div', {}, `The buy costs about ${n(need())} signet sats with fees${satsKnown() ? `; you have ${n(who.sats)}` : ''}. The faucet sends 5,000.`),
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
    return el('div', {}, `${fmt(state.poolNote.value)} ${ticker()} shielded in `, txLink(state.shield.revealTxid), pw ? ` to your pool address ${pw.addressString.slice(0, 16)}…` : '', '. The pool picks it up after a few confirmations.');
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

  const asset = () => faucet.status?.asset_id || null;
  const units = (str) => {
    const d = Number.isInteger(faucet.status?.decimals) ? faucet.status.decimals : 8;
    const m = String(str || '').trim().match(/^(\d*)(?:\.(\d*))?$/);
    if (!m || (!m[1] && !m[2]) || (m[2] || '').length > d) throw new Error(`Enter an amount with at most ${d} decimals.`);
    return BigInt((m[1] || '0') + (m[2] || '').padEnd(d, '0'));
  };
  let notes = null;
  const balance = () => (notes || []).filter((x) => !x.spent).reduce((t, x) => t + BigInt(x.value), 0n);
  async function scanNotes(say) {
    const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
    say?.('scanning the pool…');
    notes = await poolNotes(pw, asset());
    const seen = new Set((state.received || []).map((x) => x.leafIndex));
    const own = new Set([...(state.pays || []), ...(state.exits || []), ...(state.sells || [])].map((x) => x.txid));
    for (const x of notes) {
      if (!x.internal && !seen.has(x.leafIndex) && x.txid !== state.shield?.revealTxid && !own.has(x.txid)) {
        (state.received ||= []).push({ leafIndex: x.leafIndex, txid: x.txid, value: x.value.toString(), height: x.height });
      }
    }
    save();
  }
  const waitLine = (w) => `Your newest note is too recent for the wallet's anchor policy: it needs ${w.wait} more signet block${w.wait === 1 ? '' : 's'} (about ${w.wait * 10} min). Spending sooner anchors at the latest block, which tells an observer your note is new.`;
  const pending = {};
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

  const maker = () => (faucet.status?.maker?.enabled ? faucet.status.maker : null);
  const sellQuote = (u) => {
    const m = maker(), st = faucet.status;
    if (!m || !st) return null;
    return Number((BigInt(u) * BigInt(st.price_sats) * BigInt(10_000 - m.spread_bps)) / (BigInt(st.lot) * 10_000n));
  };

  function renderSell(ph) {
    const S = setPhase('sell', ph, ph === 'done' ? 'done' : '');
    if (ph === 'locked') { put(S.body, el('div', {}, ABOUT.sell)); return; }
    const last = state.sells?.[state.sells.length - 1];
    if (running === 'sell') return;
    const m = maker();
    const lastLine = last
      ? el('div', {}, `Sold ${fmt(last.units)} ${ticker()} for ${n(last.sats)} signet sats in `, txLink(last.txid), '. The sats went to a fresh address of your pool wallet, recoverable from the same backup; the change stayed in the pool.')
      : el('div', {}, ABOUT.sell);
    if (!m) {
      put(S.body, lastLine, el('div', {}, faucet.loading ? 'Checking the faucet…' : 'The faucet is not buying cBTC back right now. Try again in a few minutes.'), errLine('sell'));
      return;
    }
    const amt = field('pool-sell-amt', `Amount (${ticker()})`, { inputmode: 'decimal', placeholder: notes ? fmt(balance()) : fmt(faucet.status.lot) });
    const est = el('span', { class: 'small muted' });
    const estimate = () => {
      let u = null;
      try { u = units(amt.input.value); } catch { u = null; }
      est.textContent = u && u > 0n ? `≈ ${n(sellQuote(u))} signet sats` : `${n(m.sats_per_lot)} sats per ${fmt(faucet.status.lot)} ${ticker()}`;
    };
    amt.input.value = state.sellDraft || '';
    amt.input.addEventListener('input', () => { state.sellDraft = amt.input.value; estimate(); });
    estimate();
    const go = (anchor = null) => run('sell', async (say) => {
      const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
      const value = units(state.sellDraft);
      if (value <= 0n) throw new Error('Enter an amount above zero.');
      if (value < BigInt(m.min_units)) throw new Error(`The faucet buys at least ${fmt(m.min_units)} ${ticker()}.`);
      if (value > BigInt(m.max_units)) throw new Error(`The faucet buys at most ${fmt(m.max_units)} ${ticker()} per swap.`);
      const used = new Set(state.sellUsed || []);
      let r;
      try { r = await sellForSats(tacit, { poolWallet: pw, amount: value, asset: asset(), anchor, usedScripts: used, say }); }
      finally { state.sellUsed = [...used]; save(); }
      if (r.wait) { pending.sell = { ...r }; return; }
      (state.sells ||= []).push({ txid: r.revealTxid, units: value.toString(), sats: r.sats, payout: r.payout });
      state.sellDraft = ''; save();
      ctx.track?.(r.revealTxid, `Sold ${fmt(value)} ${ticker()} for ${n(r.sats)} sats`);
      log(`Sold ${fmt(value)} ${ticker()} for ${n(r.sats)} signet sats.`);
      notes = null;
      refreshFaucet();
    });
    put(S.body, lastLine,
      el('div', {}, `The faucet buys ${ticker()} back at ${n(m.sats_per_lot)} signet sats per ${fmt(faucet.status.lot)}, from ${fmt(m.min_units)} to ${fmt(m.max_units)} per swap.`),
      balanceLine(), waitBox('sell', go) || el('div', {}, amt.node,
        el('div', { class: 'row' }, button('Swap for sats', () => go()), est)),
      errLine('sell'));
  }

  function renderHook(id, ph) {
    const impl = hooks.get(id);
    if (!impl) return ({ pay: renderPay, receive: renderReceive, exit: renderExit, sell: renderSell })[id](ph);
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
      ? 'Each step is one signet transaction. Progress is saved in this browser.'
      : 'Connect a wallet above to start. Each step is one signet transaction.';
    const ph = phases();
    renderSats(ph.sats);
    if (SINGLE_ACTION_JOIN) renderJoin(ph.join); else { renderGet(ph.get); renderShield(ph.shield); }
    for (const id of ['pay', 'receive', 'exit', 'sell']) renderHook(id, ph[id]);
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
  return { render, get state() { return state; }, get running() { return !!running; }, sections, stop: () => clearInterval(timer) };
}

function blindingHex(v) {
  const big = typeof v === 'bigint' ? v : BigInt(/^0x/i.test(String(v)) ? v : '0x' + String(v));
  return big.toString(16).padStart(64, '0');
}

function parseTacUnits(str, decimals) {
  const m = String(str || '').trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2]) || (m[2] || '').length > decimals) throw new Error(`Enter an amount with at most ${decimals} decimals.`);
  return BigInt((m[1] || '0') + (m[2] || '').padEnd(decimals, '0'));
}

export function mountMainnet(root, ctx) {
  const { tacit } = ctx;
  const log = ctx.log || (() => {});
  const explorer = tacit.NET?.explorer || 'https://mempool.space';
  const txLink = (txid, label) => el('a', { href: `${explorer}/tx/${txid}`, target: '_blank', rel: 'noopener noreferrer' }, label || `${txid.slice(0, 10)}…`);
  const poolWallet = () => (ctx.wallet?.priv ? poolWalletFor(ctx.wallet.priv, 'mainnet') : null);
  let sel = livePoolAssets()[0] || MAINNET_POOL_ASSETS[0];
  const asset = () => sel.id;

  let who = null;
  let running = null;
  const errs = {};
  let pub = { loading: false, utxos: [], decimals: sel.decimals };
  let shielded = { loading: false, notes: null };
  let relay = { checked: false, live: false };
  let lastShield = null, lastPay = null, lastExit = null;
  const pending = {};

  const fmt = (units) => {
    const d = pub.decimals;
    const s = BigInt(units).toString().padStart(d + 1, '0');
    return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '') || '0';
  };
  const shieldedView = () => pendingView(shielded.notes || [], asset(), poolWallet());
  const shieldedTotal = () => shieldedView().live.reduce((t, x) => t + BigInt(x.value), 0n);
  const publicTotal = () => pub.utxos.reduce((t, u) => t + (typeof u.amount === 'bigint' ? u.amount : BigInt(u.amount)), 0n);

  async function loadPublic() {
    if (!ctx.wallet?.priv) return;
    const owner = who?.pubHex;
    pub = { ...pub, loading: true }; render();
    try {
      const h = await tacit.scanHoldings();
      if (who?.pubHex !== owner) return;
      const entry = h instanceof Map ? h.get(asset()) : null;
      pub = { loading: false, utxos: entry?.utxos || [], decimals: Number.isInteger(entry?.decimals) ? entry.decimals : sel.decimals };
    } catch (e) { if (who?.pubHex !== owner) return; pub = { ...pub, loading: false }; errs.load = ctx.errMsg ? ctx.errMsg(e) : String(e?.message || e); }
    render();
  }

  async function loadShielded() {
    const pw = poolWallet(); if (!pw) return;
    const owner = who?.pubHex;
    shielded = { ...shielded, loading: true }; render();
    try { const notes = await poolNotes(pw, asset()); if (who?.pubHex !== owner) return; shielded = { loading: false, notes }; }
    catch (e) { if (who?.pubHex !== owner) return; shielded = { ...shielded, loading: false }; errs.receive = ctx.errMsg ? ctx.errMsg(e) : String(e?.message || e); }
    render();
  }

  async function checkRelay() {
    try { relay = { checked: true, live: !!(await poolClientFor('mainnet').relayInfo()) }; }
    catch { relay = { checked: true, live: false }; }
    render();
  }

  async function run(id, fn) {
    if (running) return;
    running = id; errs[id] = null; render();
    try { await fn(); }
    catch (e) {
      errs[id] = ctx.errMsg ? ctx.errMsg(e) : String(e?.message || e);
      if (!/^Cancelled/.test(errs[id])) console.warn('[sats] mainnet pool', id, e);
    } finally { running = null; render(); }
  }

  function errLine(id) { return errs[id] ? el('div', { class: 'status' }, el('span', { class: 'err', role: 'alert' }, errs[id])) : null; }

  function button(label, onClick, disabled = false) {
    const b = el('button', { class: 'btn', type: 'button' }, label);
    b.disabled = disabled || !!running;
    b.addEventListener('click', onClick);
    return b;
  }
  const tok = (cls) => (sel.logo ? el('img', { class: cls ? `tok ${cls}` : 'tok', src: sel.logo, alt: '', 'aria-hidden': 'true' }) : null);

  const shieldStatus = el('span', { class: 'small muted' });
  const payStatus = el('span', { class: 'small muted' });
  const exitStatus = el('span', { class: 'small muted' });

  const toField = el('input', { type: 'text', id: 'mn-pay-to', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'tacit1… or bp1…' });
  const payAmtField = el('input', { type: 'text', id: 'mn-pay-amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0001' });
  const exitAmtField = el('input', { type: 'text', id: 'mn-exit-amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0001' });

  async function doShield() {
    await ctx.ensureKey?.();
    const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
    if (!pub.utxos.length) await loadPublic();
    if (!pub.utxos.length) throw new Error(`No ${sel.ticker} to shield yet.`);
    const val = (u) => (typeof u.amount === 'bigint' ? u.amount : BigInt(u.amount));
    const biggest = [...pub.utxos].sort((a, b) => (val(b) > val(a) ? 1 : val(b) < val(a) ? -1 : 0))[0];
    const note = {
      assetId: asset(), txid: biggest.utxo.txid, vout: biggest.utxo.vout,
      amount: val(biggest).toString(), blinding: blindingHex(biggest.blinding),
    };
    shieldStatus.textContent = '';
    const r = await shieldNote(tacit, { note, poolWallet: pw, say: (m) => { shieldStatus.textContent = m; } });
    lastShield = { txid: r.revealTxid, value: r.poolNote.value };
    ctx.track?.(r.revealTxid, `Shielded ${fmt(r.poolNote.value)} ${sel.ticker}`);
    log('Shielded.');
    ctx.refresh?.();
    try { tacit.invalidateHoldingsCache?.(); } catch {}
    await loadPublic();
    await loadShielded();
  }

  async function doPay(anchor = null) {
    await ctx.ensureKey?.();
    const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
    const to = toField.value.trim();
    const value = parseTacUnits(payAmtField.value, pub.decimals);
    if (value <= 0n) throw new Error('Enter an amount above zero.');
    payStatus.textContent = '';
    const r = await payPrivately(tacit, { poolWallet: pw, to, amount: value, asset: asset(), anchor, say: (m) => { payStatus.textContent = m; }, askSelf: askSelfIn(payStatus) });
    if (r.wait) { pending.pay = { ...r }; return; }
    lastPay = { txid: r.revealTxid, to: to.slice(0, 16) + '…', value: value.toString(), relayed: r.relayed };
    toField.value = ''; payAmtField.value = '';
    ctx.track?.(r.revealTxid, `Paid ${fmt(value)} private ${sel.ticker}`);
    log(`Paid ${fmt(value)} ${sel.ticker} privately.`);
    await loadShielded();
  }

  async function doExit(anchor = null) {
    await ctx.ensureKey?.();
    const pw = poolWallet(); if (!pw) throw new Error('Unlock the wallet first.');
    const value = parseTacUnits(exitAmtField.value, pub.decimals);
    if (value <= 0n) throw new Error('Enter an amount above zero.');
    exitStatus.textContent = '';
    const r = await exitToWallet(tacit, { poolWallet: pw, amount: value, asset: asset(), anchor, say: (m) => { exitStatus.textContent = m; } });
    if (r.wait) { pending.exit = { ...r }; return; }
    lastExit = { txid: r.revealTxid, value: value.toString() };
    exitAmtField.value = '';
    ctx.track?.(r.revealTxid, `Exited ${fmt(value)} ${sel.ticker}`);
    log(`Exited ${fmt(value)} ${sel.ticker} to your wallet.`);
    ctx.refresh?.();
    try { tacit.invalidateHoldingsCache?.(); } catch {}
    await loadPublic();
    await loadShielded();
  }

  function selectAsset(id) {
    const next = livePoolAssets().find((a) => a.id === id);
    if (!next || next.id === sel.id) return;
    sel = next;
    pub = { loading: false, utxos: [], decimals: sel.decimals };
    shielded = { loading: false, notes: null };
    lastShield = lastPay = lastExit = null;
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(errs)) delete errs[k];
    render();
    loadPublic();
    loadShielded();
  }

  function waitBoxFor(id, w, retry) {
    return el('div', {},
      `Your newest note is too recent for the wallet's anchor policy: it needs ${w.wait} more Bitcoin block${w.wait === 1 ? '' : 's'} (about ${w.wait * 10} min). Spending sooner anchors at the latest block, which tells an observer your note is new.`,
      el('div', { class: 'row' },
        button('Spend now at the latest block', () => { delete pending[id]; run(id, () => retry(w.tip)); }),
        button('Wait', () => { delete pending[id]; render(); })));
  }

  function render() {
    const items = [];

    items.push(el('p', { class: 'note' },
      !relay.checked ? 'Checking the gasless relay…'
        : relay.live ? 'The gasless relay is live: payments and exits can ride it fee-free.'
        : 'Gasless relay: coming soon. Shielding, payments and exits all work now — each pays its own Bitcoin network fee.'));

    if (!who?.connected) {
      items.push(el('p', { class: 'note' }, `Connect a wallet above to shield, pay and exit ${sel.ticker} in the pool.`));
      root.replaceChildren(...items.filter((x) => x != null));
      return;
    }

    const live = livePoolAssets();
    items.push(el('div', { class: 'field' }, el('label', { for: 'mn-asset' }, 'Asset'),
      el('div', { class: 'row', style: 'margin:0' }, tok(),
        el('select', { id: 'mn-asset', 'aria-label': 'Pool asset', ...(live.length > 1 ? {} : { disabled: true }), onchange: (e) => selectAsset(e.target.value) },
          ...live.map((a) => el('option', a.id === sel.id ? { value: a.id, selected: 'selected' } : { value: a.id }, a.ticker))))));

    items.push(el('div', { class: 'addrs' },
      el('div', { class: 'kv' }, el('span', {}, tok(), ' public'), el('b', {}, pub.loading ? '…' : `${fmt(publicTotal())} ${sel.ticker}`)),
      el('div', { class: 'kv' }, el('span', {}, tok('shielded'), ' shielded'), el('b', {}, shielded.loading ? '…' : shielded.notes ? `${fmt(shieldedTotal())} ${sel.ticker}${shieldedView().settling > 0n ? ` (+${fmt(shieldedView().settling)} settling)` : ''}` : '— scan below'))));
    items.push(el('div', { class: 'row' }, button('Refresh', () => { loadPublic(); loadShielded(); })));
    items.push(errLine('load'));

    items.push(el('p', { class: 'eyebrow sub-h' }, 'Shield'));
    items.push(el('p', { class: 'note' }, `Move ${sel.ticker} you hold into the pool, where amounts and owners are hidden. Self-funded: this wallet pays the Bitcoin fee.`));
    if (lastShield) items.push(el('div', {}, `${fmt(lastShield.value)} ${sel.ticker} shielded in `, txLink(lastShield.txid), '.'));
    if (who?.unlocked && !pub.loading && !pub.utxos.length) items.push(el('div', { class: 'small muted' }, `No ${sel.ticker} in this wallet yet. Get some on `, el('a', { href: '/' }, 'tacit.finance'), ', then come back to shield it.'));
    items.push(el('div', { class: 'row' }, button(`Shield my ${sel.ticker}`, () => run('shield', doShield), who?.unlocked && !pub.loading && !pub.utxos.length), running === 'shield' ? shieldStatus : null));
    items.push(errLine('shield'));

    items.push(el('p', { class: 'eyebrow sub-h' }, 'Pay privately'));
    if (lastPay) items.push(el('div', {}, `Paid ${fmt(lastPay.value)} ${sel.ticker} to ${lastPay.to} in `, txLink(lastPay.txid), lastPay.relayed ? ' (relayed).' : ' (self-funded).'));
    if (pending.pay) items.push(waitBoxFor('pay', pending.pay, doPay));
    else items.push(
      el('div', { class: 'field' }, el('label', { for: 'mn-pay-to' }, 'To: a Tacit address (tacit1…) or pool address (bp1…)'), toField),
      el('div', { class: 'field' }, el('label', { for: 'mn-pay-amt' }, `Amount (${sel.ticker})`), payAmtField),
      el('div', { class: 'row' }, button('Pay privately', () => run('pay', () => doPay())), running === 'pay' ? payStatus : null));
    items.push(errLine('pay'));

    items.push(el('p', { class: 'eyebrow sub-h' }, 'Receive'));
    const pw = poolWallet();
    if (pw) items.push(el('div', { class: 'small' }, 'Your pool address: ', el('code', {}, pw.addressString.slice(0, 20) + '…' + pw.addressString.slice(-8)), ' ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); navigator.clipboard?.writeText(pw.addressString); log('Pool address copied.'); } }, 'copy')));
    items.push(el('div', { class: 'row' }, button('Scan the pool', () => run('receive', loadShielded))));
    items.push(errLine('receive'));

    items.push(el('p', { class: 'eyebrow sub-h' }, 'Exit'));
    items.push(el('p', { class: 'note' }, `Leave the pool as an ordinary ${sel.ticker} note in your wallet. Self-funded: this wallet pays the Bitcoin fee.`));
    if (lastExit) items.push(el('div', {}, `${fmt(lastExit.value)} ${sel.ticker} left the pool to your wallet in `, txLink(lastExit.txid), '.'));
    if (pending.exit) items.push(waitBoxFor('exit', pending.exit, doExit));
    else items.push(
      el('div', { class: 'field' }, el('label', { for: 'mn-exit-amt' }, `Amount (${sel.ticker})`), exitAmtField),
      el('div', { class: 'row' }, button('Exit to my wallet', () => run('exit', () => doExit())), running === 'exit' ? exitStatus : null));
    items.push(errLine('exit'));

    root.replaceChildren(...items.filter((x) => x != null));
  }

  ctx.onWallet?.((d) => {
    const changed = d.pubHex !== who?.pubHex;
    who = d;
    if (changed) { pub = { loading: false, utxos: [], decimals: pub.decimals }; shielded = { loading: false, notes: null }; lastShield = lastPay = lastExit = null; }
    if (who?.connected && who?.unlocked) { loadPublic(); loadShielded(); }
    render();
  });

  checkRelay();
  render();
  return { render, get running() { return !!running; }, stop: () => {} };
}
