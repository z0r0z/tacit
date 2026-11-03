#!/usr/bin/env node
// tacit-pool-maker: buys TAC out of the Bitcoin shielded pool for sats, so a payment to a bitcoin address settles
// in the next block instead of waiting for a buyer on the market.
//
// The user proves a pool spend (btc-pool-zap.js exitToSats) that exits TAC to this maker's key and wants `sats`
// paid to a script of their choosing, a recipient's among them. The want is in the proved body and the pool's
// replay checks it at acceptance, so the maker cannot take the exit without paying it; the maker checks the spend
// natively before any sats move and posts one carrier from its own coins:
//
//   GET  /maker/quote?sats=N     the TAC the maker takes for N sats to the payee; reserves a bind coin; names the terms
//   GET  /maker/quote?units=N    the sats the maker pays for N units of TAC
//   POST /maker/fill             { quoteId, payload, offer }: checks the spend, posts the carrier
//   GET  /maker/status           terms, caps, float and recent fills
//
// Price: a recent trade of the asset, or the cheapest live ask when that is lower, less a spread. With no recent
// trade there is no quote. The exit notes it buys pay the maker's main key, an ordinary Tacit wallet key: the
// operator holds, lists or sells that inventory like any holder's. The coins it pays from sit on a key derived from
// MAKER_KEY, funded by the operator (status names the address).
//
// Env:
//   MAKER_KEY                  32-byte hex wallet key (required)
//   MAKER_NETWORK              mainnet (default) or signet
//   MAKER_ASSET_ID             asset to buy (default: TAC on mainnet)
//   MAKER_STATE                state file (default /var/lib/tacit-pool-maker/state.json)
//   MAKER_POOL_API             pool replay service (default per network)
//   TACIT_WORKER_BASE          control-plane worker for prices (default https://api.tacit.finance)
//   MAKER_SPREAD_BPS           discount to the reference price, in basis points (default 400 = 4%)
//   MAKER_MIN_SATS             least payment per fill (default 20,000)
//   MAKER_MAX_SATS             most per fill (default 100,000)
//   MAKER_DAILY_SATS           sats paid per rolling 24h, quotes included (default 500,000)
//   MAKER_DAILY_UNITS          units bought per rolling 24h, quotes included (default 500,000,000,000 = 5,000 TAC)
//   MAKER_IP_FILLS             fills per client per 24h (default 3)
//   MAKER_QUOTE_SECS           quote lifetime (default 1200)
//   MAKER_FEE_RATE             carrier fee rate, sat/vB (default 1.5)
//   MAKER_MARK_MAX_AGE_SECS    oldest last trade it prices from (default 7 days)
//   MAKER_CORS_ORIGINS         origins allowed to quote and fill (default https://tacit.finance)
//   PORT                       HTTP port (default 10000)

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, clientIp, makeLock, loadTacitHeadless, setWalletKey, openStateFile } from './sats-faucet.js';
import { parseUrl, badRequest } from './lib/safe-url.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.resolve(HERE, '../../dapp');

export const TAC_MAINNET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const POOL_API = { mainnet: 'https://tacit-btc-pool-mainnet.onrender.com', signet: 'https://tacit-btc-pool.onrender.com' };

const ANCHOR_WINDOW = 144;            // retained roots, as the pool replay and relayer
const MAX_PAYLOAD_BYTES = 128 * 1024;
const FILL_WINDOW_SECS = 86400;
const QUOTE_IP_HOURLY = 20;
const QUOTE_IP_OPEN = 2;
const MAKER_FEE_ALLOWANCE = 6000;     // commit + reveal at the maker's fee rate, for proofs up to a few kB
const WANT_DUST = 330;                // the least a payout can be (P2TR); the spend's own check applies the payee script's floor
const EXIT_VOUT = 0, WANT_VOUT = 1;
const SPENT_MEMORY_SECS = 3600;
const TAKEN_HISTORY = 50;
const MAX_BODY = 1024;
const MAX_FILL_BODY = 2 * MAX_PAYLOAD_BYTES + 8 * 1024;

const log = (...a) => console.log(`[pool-maker ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const hex32 = (x) => BigInt(x).toString(16).padStart(64, '0');
const opKey = (o) => `${o.txid}:${o.vout}`;
const ipTag = (ip) => createHash('sha256').update('pool-maker:' + ip).digest('hex').slice(0, 32);

export function configFromEnv(env = process.env) {
  const network = env.MAKER_NETWORK || 'mainnet';
  const cfg = {
    network,
    assetId: (env.MAKER_ASSET_ID || (network === 'mainnet' ? TAC_MAINNET : '')).toLowerCase().replace(/^0x/, ''),
    decimals: int(env.MAKER_DECIMALS, 8),
    statePath: env.MAKER_STATE || '/var/lib/tacit-pool-maker/state.json',
    port: int(env.PORT, 10000),
    corsOrigins: (env.MAKER_CORS_ORIGINS || 'https://tacit.finance').split(',').map((s) => s.trim()).filter(Boolean),
    poolApi: (env.MAKER_POOL_API || POOL_API[network] || '').replace(/\/$/, ''),
    workerBase: (env.TACIT_WORKER_BASE || 'https://api.tacit.finance').replace(/\/$/, ''),
    spreadBps: Math.min(5000, Math.max(0, Number.isFinite(Number(env.MAKER_SPREAD_BPS)) && env.MAKER_SPREAD_BPS !== undefined && env.MAKER_SPREAD_BPS !== '' ? Math.floor(Number(env.MAKER_SPREAD_BPS)) : 400)),
    minSats: int(env.MAKER_MIN_SATS, 20_000),
    maxSats: int(env.MAKER_MAX_SATS, 100_000),
    dailySats: int(env.MAKER_DAILY_SATS, 500_000),
    dailyUnits: BigInt(env.MAKER_DAILY_UNITS || '500000000000'),
    ipFills: int(env.MAKER_IP_FILLS, 3),
    quoteSecs: int(env.MAKER_QUOTE_SECS, 1200),
    feeRate: Number(env.MAKER_FEE_RATE) > 0 ? Number(env.MAKER_FEE_RATE) : 1.5,
    markMaxAgeSecs: int(env.MAKER_MARK_MAX_AGE_SECS, 7 * 86400),
  };
  if (!['mainnet', 'signet'].includes(cfg.network)) throw new Error('MAKER_NETWORK must be mainnet or signet');
  if (!/^[0-9a-f]{64}$/.test(cfg.assetId)) throw new Error('MAKER_ASSET_ID must be 32-byte hex');
  if (!cfg.poolApi) throw new Error('MAKER_POOL_API is required');
  if (cfg.minSats < WANT_DUST) throw new Error(`MAKER_MIN_SATS must be at least ${WANT_DUST}`);
  if (cfg.maxSats < cfg.minSats) throw new Error('MAKER_MAX_SATS must be at least MAKER_MIN_SATS');
  if (cfg.dailySats < cfg.maxSats) throw new Error('MAKER_DAILY_SATS must cover at least one fill');
  if (cfg.dailyUnits <= 0n) throw new Error('MAKER_DAILY_UNITS must be positive');
  return cfg;
}

// ── address ──
// The BIP-173 address of a P2WPKH key, so /maker/status can name where the float goes.
export function p2wpkhAddressOf(deps, pub, network = 'mainnet') {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const hrp = network === 'mainnet' ? 'bc' : 'tb';
  const polymod = (values) => values.reduce((chk, v) => {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    GEN.forEach((g, i) => { if ((top >>> i) & 1) chk ^= g; });
    return chk;
  }, 1);
  const program = deps.ripemd160(deps.sha256(pub));
  const data = [0]; let acc = 0, bits = 0;
  for (const b of program) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expand, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...check].map((d) => CHARSET[d]).join('');
}

// ── price ──
// refUnit is sats per whole unit of the asset (a float from the market), taken in thousandths so the sums are integers.
const milliOf = (refUnit) => BigInt(Math.max(1, Math.round(Number(refUnit) * 1000)));
// TAC to take so that `sats` come out to the payee after the spread: rounded up, so the maker never pays more than it takes.
export function unitsForSats(sats, refUnit, spreadBps, decimals = 8) {
  const net = milliOf(refUnit) * BigInt(10_000 - spreadBps);
  return (BigInt(sats) * 10n ** BigInt(decimals) * 10_000n * 1000n + net - 1n) / net;
}
// Sats paid for `units`, rounded down.
export function satsForUnits(units, refUnit, spreadBps, decimals = 8) {
  return Number((BigInt(units) * milliOf(refUnit) * BigInt(10_000 - spreadBps)) / (10n ** BigInt(decimals) * 10_000n * 1000n));
}

// The price the maker works from: a recent trade, or the cheapest live ask when that is lower. null with no recent trade:
// an ask alone says what sellers hope for, not where a buyer is.
export async function readReference({ cfg, now = () => Math.floor(Date.now() / 1000), fetchJson }) {
  const [info, book] = await Promise.all([
    fetchJson(`${cfg.workerBase}/assets/${cfg.assetId}?network=${cfg.network}`),
    fetchJson(`${cfg.workerBase}/assets/${cfg.assetId}/preauth-sales?network=${cfg.network}`),
  ]);
  const t = now(), one = 10 ** cfg.decimals;
  const mark = Number(info?.mark_price?.unit) > 0 && Number(info.mark_price.ts) > t - cfg.markMaxAgeSecs ? Number(info.mark_price.unit) : null;
  if (!mark) return null;
  const asks = (book?.sales || [])
    .filter((s) => !s.expired && Number(s.expiry) > t && /^\d+$/.test(String(s.asset_opening?.amount)) && BigInt(s.asset_opening.amount) > 0n)
    .map((s) => Number(s.min_price_sats) / (Number(s.asset_opening.amount) / one));
  const ask = asks.length ? Math.min(...asks) : null;
  const unit = ask && ask < mark ? ask : mark;
  return { unit, basis: unit === mark ? 'trade' : 'ask', mark, ask };
}

// ── the maker ──
// mk = { key: { priv, pub }, pool, zap, verifier: { verify({ proof, publics }), system }, poolGet?(path), utxos?(spkHex) }
export function makePoolMaker({ tacit, deps, cfg, store, mk, logger = log, now = () => Math.floor(Date.now() / 1000), reference = null }) {
  const state = store.load();
  // A fill cut off by a restart is not retried; its quote lapses and frees the bind.
  for (const q of Object.values(state.makerQuotes || {})) if (q.state === 'filling') q.state = 'failed';
  const esplora = tacit.NET.api;
  const locked = makeLock();
  const recentlySpent = new Map(); // outpoint -> time, until the indexer stops listing it
  const save = () => { state.updatedAt = Math.floor(Date.now() / 1000); store.save(state); };

  const fetchJson = async (u) => {
    try { const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout?.(20_000) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  const getJson = async (p) => {
    const r = await fetch(esplora + p);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`esplora ${p}: HTTP ${r.status}`);
    return r.json();
  };
  const priceNow = reference || (() => readReference({ cfg, now, fetchJson }));

  const mainSpk = () => tacit.p2wpkhScript(tacit.wallet.pub);   // the exit notes pay this key
  const makerSpk = tacit.p2wpkhScript(mk.key.pub);              // the coins it pays from
  const poolGet = mk.poolGet || (async (p) => {
    const r = await fetch(cfg.poolApi + p);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(j?.error || `pool ${p}: HTTP ${r.status}`), { status: r.status });
    return j;
  });
  const utxosRaw = mk.utxos || (async (spkHex) => (await getJson(`/scripthash/${createHash('sha256').update(Buffer.from(spkHex, 'hex')).digest('hex')}/utxo`)) || []);
  const pruneSpent = (t) => { for (const [k, at] of recentlySpent) if (t - at > SPENT_MEMORY_SECS) recentlySpent.delete(k); };
  // The coin key only ever receives plain sats (top-ups, commit change), so every coin on it is spendable.
  async function makerCoins() {
    pruneSpent(now());
    const all = await utxosRaw(deps.bytesToHex(makerSpk));
    return all.filter((u) => u.value > tacit.DUST && !recentlySpent.has(opKey(u)))
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
  }

  const quotes = () => (state.makerQuotes ||= {});
  const recentFills = (t) => (state.makerFills || []).filter((f) => t - f.at < FILL_WINDOW_SECS);
  function pruneQuotes(t) {
    for (const [id, q] of Object.entries(quotes())) if (q.state !== 'filling' && t >= q.expiry) delete quotes()[id];
  }
  // Quotes that still hold their bind and their sats: open or failed until they lapse, and any in flight.
  const openQuotes = (t = now()) => Object.values(quotes()).filter((q) => q.state === 'filling' || t < q.expiry);
  const reservedBinds = (except = null) => new Set(openQuotes().filter((q) => q.id !== except).map((q) => opKey(q.bind)));
  const satsCommitted = (t) => recentFills(t).reduce((s, f) => s + f.sats, 0) + openQuotes(t).reduce((s, q) => s + q.sats, 0);
  const unitsCommitted = (t) => recentFills(t).reduce((s, f) => s + BigInt(f.units), 0n) + openQuotes(t).reduce((s, q) => s + BigInt(q.units), 0n);

  const quoteView = (q) => ({
    quoteId: q.id, asset: cfg.assetId, units: q.units, sats: q.sats,
    makerSpk: deps.bytesToHex(mainSpk()), exitVout: EXIT_VOUT, wantVout: WANT_VOUT,
    bind: { txid: q.bind.txid, vout: q.bind.vout }, expiry: q.expiry,
    price: { unit: q.ref.unit, basis: q.ref.basis, spread_bps: cfg.spreadBps },
  });
  const termsOf = (q) => ({ spk: mainSpk(), sats: BigInt(q.sats), vout: WANT_VOUT, exitVout: EXIT_VOUT, bind: { txid: q.bind.txid, vout: q.bind.vout } });

  // GET /maker/quote?sats=N or ?units=N
  async function quote({ sats, units, ip }) {
    const asInt = (v, what) => { if (!/^\d{1,20}$/.test(String(v))) throw new HttpError(400, `${what} must be a positive integer`); return BigInt(v); };
    if (sats == null && units == null) throw new HttpError(400, 'sats or units required');
    if (sats != null && units != null) throw new HttpError(400, 'give sats or units, not both');
    const ref = await priceNow();
    if (!ref) throw new HttpError(503, 'the maker has no recent trade to price from; try again later');
    let s, u;
    if (sats != null) {
      s = Number(asInt(sats, 'sats'));
      u = unitsForSats(s, ref.unit, cfg.spreadBps, cfg.decimals);
    } else {
      u = asInt(units, 'units');
      s = satsForUnits(u, ref.unit, cfg.spreadBps, cfg.decimals);
    }
    if (s <= 0 || u <= 0n) throw new HttpError(400, 'amount too small');
    if (s < cfg.minSats) throw new HttpError(400, `the maker pays at least ${cfg.minSats} sats per swap`);
    if (s > cfg.maxSats) throw new HttpError(400, `the maker pays at most ${cfg.maxSats} sats per swap`);
    const tag = ipTag(ip || 'unknown');
    return locked(async () => {
      const t = now();
      pruneQuotes(t);
      if (recentFills(t).filter((f) => f.ip === tag).length >= cfg.ipFills) throw new HttpError(429, `at most ${cfg.ipFills} swaps per client every 24 hours`);
      const mine = Object.values(quotes()).filter((q) => q.ip === tag);
      if (mine.filter((q) => q.state === 'open').length >= QUOTE_IP_OPEN) throw new HttpError(429, 'finish or let lapse your open quotes first');
      state.makerQuoteLog = (state.makerQuoteLog || []).filter((x) => t - x.at < 3600);
      if (state.makerQuoteLog.filter((x) => x.ip === tag).length >= QUOTE_IP_HOURLY) throw new HttpError(429, 'too many quotes; try again within the hour');
      if (satsCommitted(t) + s > cfg.dailySats) throw new HttpError(429, 'the maker has bought its daily budget; try again later');
      if (unitsCommitted(t) + u > cfg.dailyUnits) throw new HttpError(429, 'the maker has bought its daily amount of TAC; try again later');
      const coins = await makerCoins();
      const taken = reservedBinds();
      const free = coins.filter((c) => !taken.has(opKey(c)));
      // Smallest free coin binds; the rest must cover the want, the exit output and the fees.
      const bind = [...free].sort((a, b) => a.value - b.value)[0];
      const rest = free.filter((c) => c !== bind).reduce((x, c) => x + c.value, 0);
      if (!bind || rest + bind.value < s + tacit.DUST + MAKER_FEE_ALLOWANCE || rest <= tacit.DUST) {
        throw new HttpError(503, 'the maker has no sats free to buy with right now; try again in a few minutes');
      }
      const id = randomBytes(16).toString('hex');
      const q = { id, units: u.toString(), sats: s, bind: { txid: bind.txid, vout: bind.vout, value: bind.value }, ref: { unit: ref.unit, basis: ref.basis }, expiry: t + cfg.quoteSecs, ip: tag, state: 'open', at: t };
      quotes()[id] = q;
      state.makerQuoteLog.push({ ip: tag, at: t });
      save();
      logger(`quote ${id}: ${q.units} units for ${s} sats at ${ref.unit} (${ref.basis}), bind ${opKey(bind)}`);
      return quoteView(q);
    });
  }

  const readHex = (h, name, max) => {
    const s = String(h ?? '').replace(/^0x/i, '');
    if (!s || s.length % 2 || s.length > max * 2 || /[^0-9a-f]/i.test(s)) throw new HttpError(400, `${name} must be hex`);
    return deps.hexToBytes(s.toLowerCase());
  };
  function readOffer(o) {
    if (!o || typeof o !== 'object') throw new HttpError(400, 'offer required');
    const op = o.exitOpening;
    if (!op || !/^\d{1,20}$/.test(String(op.value ?? ''))) throw new HttpError(400, 'offer.exitOpening.value must be a decimal string');
    if (!/^(0x)?[0-9a-f]{1,64}$/i.test(String(op.blinding ?? ''))) throw new HttpError(400, 'offer.exitOpening.blinding must be hex');
    const b = String(op.blinding);
    const payout = readHex(o.payoutScriptPubKey, 'offer.payoutScriptPubKey', 64);
    return { exitOpening: { value: String(op.value), blinding: /^0x/i.test(b) ? b : '0x' + b }, payoutScriptPubKey: '0x' + deps.bytesToHex(payout) };
  }

  // Checks that stand for the indexer's acceptance, run before any sats move: the offer against the quote,
  // the anchor and its root, the nullifiers, and the proof under the pool's pinned system.
  async function checkOffer(q, payload, offer) {
    let sp;
    try { sp = mk.pool.parseSpend(payload, { full: true }); } catch (e) { throw new HttpError(400, `not a pool spend: ${e.message}`); }
    const st = await poolGet('/btc-pool/status');
    if (st.halted || st.height == null) throw new HttpError(503, 'the pool replay is paused; try again later');
    const sys = mk.verifier.system;
    if (!mk.verifier.verify || (st.proofSystem && sys?.id && st.proofSystem !== sys.id) || (st.vkHash && sys?.vkHash && String(st.vkHash).replace(/^0x/, '') !== String(sys.vkHash).replace(/^0x/, ''))) {
      throw new HttpError(503, 'the maker is updating to the pool\'s proof system; try again shortly');
    }
    if (sp.hAnchor > st.height || sp.hAnchor < st.height + 2 - ANCHOR_WINDOW) throw new HttpError(400, 'the spend\'s anchor is outside the pool window; build it again');
    let r;
    try { r = await poolGet(`/btc-pool/root/${sp.hAnchor}`); } catch { r = null; }
    if (!r?.retained || !r.root) throw new HttpError(400, 'the pool keeps no root at the spend\'s anchor; build it again');
    for (const nf of sp.nullifiers) {
      const n = await poolGet(`/btc-pool/nullifier/${String(nf).replace(/^0x/, '')}`);
      if (n?.spent) throw new HttpError(409, 'a note in this spend is already spent');
    }
    try {
      return await mk.zap.validateExitToSats({ pool: mk.pool, payload, offer, maker: termsOf(q), amount: BigInt(q.units), asset: '0x' + cfg.assetId, root: r.root, verify: mk.verifier.verify });
    } catch (e) {
      throw new HttpError(400, String(e?.message || e).replace(/^btc-pool-zap: /, ''));
    }
  }

  // The carrier: vin[0] the envelope commit (script path, main key), vin[1] the bind coin; outputs from
  // makerCarrierOutputs. The commit is funded from the maker's other coins. Caller holds the lock.
  async function postCarrier(q, payload, v) {
    const coins = await makerCoins();
    const bind = coins.find((c) => c.txid === q.bind.txid && c.vout === q.bind.vout);
    if (!bind) throw new HttpError(409, 'the quote\'s bind coin is gone; get a new quote');
    const taken = reservedBinds(q.id);
    const funding = coins.filter((c) => !taken.has(opKey(c)) && opKey(c) !== opKey(bind))
      .sort((a, b) => (Number(b.confirmed) - Number(a.confirmed)) || b.value - a.value);
    const outputs = mk.zap.makerCarrierOutputs({
      exitVout: v.exitVout, wantVout: v.wantVout, wantValue: v.wantValue, payoutScriptPubKey: v.payoutScriptPubKey,
      makerSpk: mainSpk(), exitSats: tacit.DUST,
    }).map((o) => ({ value: Number(o.value), script: o.script }));
    const rate = cfg.feeRate;
    const env = tacit.encodeEnvelopeScript(tacit.wallet.xonly(), payload);
    const { Q_xonly, parity } = tacit.tweakedOutputKey(tacit.TAP_NUMS, tacit.tapLeafHash(env));
    const commitSpk = tacit.p2trScript(Q_xonly);
    const cb = tacit.controlBlock(tacit.TAP_NUMS, parity);
    const witnessLen = 1 + 65 + (env.length < 0xfd ? 1 : 3) + env.length + 1 + 33 + 108;
    const feeOf = (outs) => tacit.feeFor(Math.ceil(((4 + 1 + 41 * 2 + 1 + outs.reduce((s, o) => s + 9 + o.script.length, 0) + 4) * 4 + 2 + witnessLen) / 4) + 5, rate);
    const sum = (outs) => outs.reduce((s, o) => s + o.value, 0);
    // A bind coin worth more than the carrier needs returns the rest to the coin key, after the signed indices.
    const withChange = [...outputs, { value: 0, script: makerSpk }];
    const spare = tacit.DUST + bind.value - sum(outputs) - feeOf(withChange);
    if (spare >= tacit.DUST) { withChange[withChange.length - 1].value = spare; outputs.splice(0, outputs.length, ...withChange); }
    const revealFee = feeOf(outputs);
    const outSum = sum(outputs);
    const commitValue = Math.max(tacit.DUST, outSum + revealFee - bind.value);
    const picked = [];
    let total = 0, commitFee = 0;
    for (const c of funding) {
      picked.push(c); total += c.value;
      commitFee = tacit.feeFor(tacit.estCommitVb(picked.length), rate);
      if (total >= commitValue + commitFee + tacit.DUST) break;
    }
    if (!picked.length || total < commitValue + commitFee) throw new HttpError(503, 'the maker has no sats free to buy with right now; try again in a few minutes');
    const change = total - commitValue - commitFee;
    const commitTx = {
      version: 2, locktime: 0,
      inputs: picked.map((c) => ({ txid: c.txid, vout: c.vout, sequence: 0xfffffffd, witness: [] })),
      outputs: [{ value: commitValue, script: commitSpk }, ...(change >= tacit.DUST ? [{ value: change, script: makerSpk }] : [])],
    };
    picked.forEach((c, i) => { commitTx.inputs[i].witness = tacit.signP2wpkhInputWithKey(commitTx, i, c.value, mk.key.priv, mk.key.pub); });
    const commitTxid = tacit.txid(commitTx);
    const revealTx = {
      version: 2, locktime: 0,
      inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }, { txid: bind.txid, vout: bind.vout, sequence: 0xfffffffd, witness: [] }],
      outputs,
    };
    const prevouts = [{ value: commitValue, script: commitSpk }, { value: bind.value, script: makerSpk }];
    revealTx.inputs[1].witness = tacit.signP2wpkhInputWithKey(revealTx, 1, bind.value, mk.key.priv, mk.key.pub);
    revealTx.inputs[0].witness = tacit.signTaprootScriptPathInput(revealTx, prevouts, env, cb);
    const revealTxid = tacit.txid(revealTx);
    const t = now();
    await tacit.broadcast(deps.bytesToHex(tacit.serializeTx(commitTx)));
    for (const c of picked) recentlySpent.set(opKey(c), t);
    try {
      await tacit.broadcastWithRetry(deps.bytesToHex(tacit.serializeTx(revealTx)));
    } catch (e) {
      // The commit output is the main key's (script path); recorded for manual recovery.
      state.makerStranded = [...(state.makerStranded || []), { quoteId: q.id, commitTxid, revealHex: deps.bytesToHex(tacit.serializeTx(revealTx)), at: t }].slice(-TAKEN_HISTORY);
      throw e;
    }
    recentlySpent.set(opKey(bind), t);
    return { commitTxid, revealTxid, fee: commitFee + revealFee };
  }

  // POST /maker/fill { quoteId, payload, offer }
  async function fill({ quoteId, payload: payloadHex, offer: rawOffer, ip }) {
    if (!/^[0-9a-f]{32}$/.test(String(quoteId ?? ''))) throw new HttpError(400, 'quoteId required');
    const payload = readHex(payloadHex, 'payload', MAX_PAYLOAD_BYTES);
    const offer = readOffer(rawOffer);
    const tag = ipTag(ip || 'unknown');
    const q0 = quotes()[quoteId];
    if (!q0) throw new HttpError(404, 'no such quote; get a new one');
    if (now() >= q0.expiry) throw new HttpError(410, 'the quote has expired; get a new one');
    if (q0.state !== 'open') throw new HttpError(409, 'the quote is already being filled');
    if (recentFills(now()).filter((f) => f.ip === tag).length >= cfg.ipFills) throw new HttpError(429, `at most ${cfg.ipFills} swaps per client every 24 hours`);
    const v = await checkOffer(q0, payload, offer);
    return locked(async () => {
      const t = now();
      const q = quotes()[quoteId];
      if (!q || t >= q.expiry) throw new HttpError(410, 'the quote has expired; get a new one');
      if (q.state !== 'open') throw new HttpError(409, 'the quote is already being filled');
      q.state = 'filling'; save();
      let r;
      try {
        r = await postCarrier(q, payload, v);
      } catch (e) {
        // A carrier whose commit went out is not retried: its bind stays reserved until the quote lapses.
        q.state = (state.makerStranded || []).some((s) => s.quoteId === q.id) ? 'failed' : 'open';
        save();
        if (!(e instanceof HttpError)) logger(`fill ${quoteId} failed: ${String(e?.message || e).slice(0, 300)}`);
        throw e;
      }
      delete quotes()[quoteId];
      const sats = Number(v.wantValue);
      state.makerFills = [...recentFills(t), { quoteId, txid: r.revealTxid, units: q.units, sats, ip: tag, at: t }];
      state.makerFillTotal = (state.makerFillTotal || 0) + 1;
      // The exit note pays the main key; its opening comes from the offer. Inventory for the operator to list or sell.
      state.makerNotes = [...(state.makerNotes || []), {
        txid: r.revealTxid, vout: v.exitVout, value: tacit.DUST, units: q.units,
        blinding: hex32(offer.exitOpening.blinding), quoteId, at: t,
      }].slice(-500);
      save();
      logger(`filled ${quoteId}: ${q.units} units for ${sats} sats in ${r.revealTxid}`);
      return { txid: r.revealTxid, commitTxid: r.commitTxid, sats, units: q.units, exitVout: v.exitVout, wantVout: v.wantVout };
    });
  }

  let floatCache = { at: 0, v: null };
  async function status() {
    const t = now();
    if (t - floatCache.at > 60) {
      let coins = null;
      try { coins = await makerCoins(); } catch { /* the float reads again next time */ }
      floatCache = { at: t, v: coins && { coins: coins.length, sats: coins.reduce((s, c) => s + c.value, 0) } };
    }
    let ref = null;
    try { ref = await priceNow(); } catch { /* shown as no price */ }
    const notes = state.makerNotes || [];
    return {
      network: cfg.network,
      asset_id: cfg.assetId,
      quoting: !!ref && !!floatCache.v && floatCache.v.sats >= cfg.minSats + MAKER_FEE_ALLOWANCE,
      reference: ref && { unit: ref.unit, basis: ref.basis, mark: ref.mark, ask: ref.ask },
      spread_bps: cfg.spreadBps,
      min_sats: cfg.minSats,
      max_sats: cfg.maxSats,
      sats_left_today: Math.max(0, cfg.dailySats - satsCommitted(t)),
      units_left_today: (cfg.dailyUnits > unitsCommitted(t) ? cfg.dailyUnits - unitsCommitted(t) : 0n).toString(),
      open_quotes: openQuotes(t).length,
      float: { address: coinAddress(), coins: floatCache.v?.coins ?? null, sats: floatCache.v?.sats ?? null },
      main_key: tacit.wallet.pub ? deps.bytesToHex(tacit.wallet.pub) : null,
      fills_total: state.makerFillTotal || 0,
      inventory_units: notes.reduce((s, n) => s + BigInt(n.units), 0n).toString(),
      recent_fills: recentFills(t).slice(-10).reverse().map(({ ip, ...f }) => f),
      stranded: (state.makerStranded || []).length,
    };
  }
  const coinAddress = () => p2wpkhAddressOf(deps, mk.key.pub, cfg.network);

  return { quote, fill, status, state };
}

// ── HTTP ──
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function makeHandler(maker, { corsOrigins = [], logger = log } = {}) {
  const allowed = new Set(corsOrigins);
  return async (req, res) => {
    const origin = req.headers.origin;
    const url = parseUrl(req, 'http://x');
    if (!url) return badRequest(res);
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    // Routes that reserve or spend the maker's coins: allow-listed origins only.
    const ROUTES = { '/maker/quote': { method: 'GET', label: 'quote' }, '/maker/fill': { method: 'POST', label: 'fill' } };
    const route = ROUTES[url.pathname];
    if (route) {
      if (origin && allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', `${route.method}, OPTIONS`);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (req.method === 'OPTIONS') { res.writeHead(origin && allowed.has(origin) ? 204 : 403); return res.end(); }
      if (req.method !== route.method) return send(405, { error: 'method not allowed' });
      if (origin && !allowed.has(origin)) return send(403, { error: 'origin not allowed' });
      try {
        const ip = clientIp(req);
        if (route.label === 'quote') return send(200, await maker.quote({ sats: url.searchParams.get('sats'), units: url.searchParams.get('units'), ip }));
        let body;
        try { body = JSON.parse(await readBody(req, MAX_FILL_BODY)); } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, 'body must be JSON {"quoteId", "payload", "offer"}');
        }
        return send(200, await maker.fill({ quoteId: body?.quoteId, payload: body?.payload, offer: body?.offer, ip }));
      } catch (e) {
        if (e instanceof HttpError) return send(e.status, { error: e.message });
        logger(`${route.label} failed: ${String(e?.message || e).slice(0, 300)}`);
        return send(502, { error: 'the maker could not act right now; try again shortly' });
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname === '/maker/status') return send(200, await maker.status());
    return send(404, { error: 'not found' });
  };
}

export function serve(maker, port, opts = {}) {
  const handler = makeHandler(maker, opts);
  const server = createServer((req, res) => handler(req, res).catch((e) => {
    log(`request failed: ${String(e?.message || e).slice(0, 300)}`);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal error"}'); }
  }));
  server.listen(port, () => log(`listening on :${port}`));
  return server;
}

// The coin key, derived from the wallet key: the maker's float never sits on the key that holds the exit notes.
export function coinKeyFor({ deps }, privHex) {
  const seed = Buffer.from(String(privHex).trim().toLowerCase().replace(/^0x/, ''), 'hex');
  const d = BigInt('0x' + createHash('sha256').update('tacit-pool-maker-coins-v1:').update(seed).digest('hex')) % deps.secp.CURVE.n;
  if (d === 0n) throw new Error('degenerate coin key');
  const priv = deps.hexToBytes(d.toString(16).padStart(64, '0'));
  return { priv, pub: deps.secp.getPublicKey(priv, true) };
}

// Pool modules and the pool's own proof verifier (the one the replay service accepts spends with).
async function loadMaker(loaded, cfg, privHex) {
  const { deps } = loaded;
  const [{ makeBtcShieldedPool }, { makeBtcPoolZap }, { makeBtcPoolVerifier }] = await Promise.all([
    import(path.join(DAPP, 'btc-shielded-pool.js')),
    import(path.join(DAPP, 'btc-pool-zap.js')),
    import('./lib/btc-pool-verify.js'),
  ]);
  const verifier = makeBtcPoolVerifier({ network: cfg.network, log });
  if (!verifier.enabled) throw new Error(`the proof verifier is off: ${verifier.reason}`);
  await verifier.ready?.();
  const hashes = { secp: deps.secp, sha256: deps.sha256, keccak256: deps.keccak_256 };
  return {
    key: coinKeyFor(loaded, privHex),
    pool: makeBtcShieldedPool({ ...hashes, ripemd160: deps.ripemd160 }),
    zap: makeBtcPoolZap(hashes),
    verifier,
  };
}

async function main() {
  const cfg = configFromEnv();
  if (!process.env.MAKER_KEY) throw new Error('MAKER_KEY is required');
  const loaded = await loadTacitHeadless(cfg.network);
  const pub = setWalletKey(loaded, process.env.MAKER_KEY);
  const mk = await loadMaker(loaded, cfg, process.env.MAKER_KEY);
  const maker = makePoolMaker({ ...loaded, cfg, store: openStateFile(cfg.statePath), mk });
  log(`maker on ${cfg.network}: asset ${cfg.assetId.slice(0, 8)}…, wallet key ${pub}, coin key ${loaded.deps.bytesToHex(mk.key.pub)}, proofs ${mk.verifier.system.id} ${mk.verifier.vkHash}`);
  serve(maker, cfg.port, { corsOrigins: cfg.corsOrigins });
  for (;;) await sleep(3600_000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[pool-maker] fatal: ${e?.message || e}`); process.exit(1); });
}
