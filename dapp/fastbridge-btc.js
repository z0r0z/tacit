// The Bitcoin side of a fast bridge party on esplora explorers (a list of bases, asked in order, with the same bytes sent to
// every base on a broadcast): the `btc` context of both role machines. Runs in a page and in the LP process.
//
//   makeEsploraBtcChain({ bases, prims, builder, fetchImpl, timeoutMs, feeTarget, retryMs, feeFreshMs, feeStaleMs, feeRetryMs, nowMs, tacit, pool, ethGetStorageAt, poolAddress, binding, keccak256, secp })
//     bases     ['https://mempool.space/api', 'https://blockstream.info/api', ...]
//     feeFreshMs / feeStaleMs / feeRetryMs   how long a fee estimate is reused, how old one may be when no explorer answers, and how
//                                            long after a failed read the explorers are left alone (a minute, two hours, 15 seconds)
//     prims     makeBtcWallet({ priv, hrp }).prims        builder  makeAdaptorBtcTx({ prims, kit })
//   The Ethereum locker also reads notes and whether they are spent on Ethereum, which takes the rest:
//     tacit     the dapp's tacit.js namespace                 pool    the pool wallet's .pool
//     ethGetStorageAt(to, slot, tag)   poolAddress   binding  chain binding hex   keccak256   secp

import { makeNoteResolver } from './btc-pool-zap.js';
import { bytesToHex } from './vendor/tacit-deps.min.js';
import { makeCrossLaneGuard } from './confidential-crosslane-guard.js';

const DUST = 546;
const ZERO_AUTH = '0x' + '00'.repeat(32);
const KNOWN = /already (in|known)|txn-already|already in block|already exists|duplicate/i;

export function makeEsploraBtcChain({ bases, tacit, prims, builder, pool, ethGetStorageAt, poolAddress, binding, keccak256, secp, fetchImpl = fetch, timeoutMs = 20000, feeTarget = '3', minFeeRate = 1, retryMs = 1500, feeFreshMs = 60000, feeStaleMs = 2 * 3600000, feeRetryMs = 15000, soloFeeCeiling = 300, nowMs = Date.now, log = () => {}, maxReads = 8, coolMs = 20000, coolMaxMs = 5 * 60000 }) {
  const list = bases.map((b) => b.replace(/\/$/, ''));
  const wallet = { pub: prims.wallet.pub, priv: prims.wallet.priv, xonly: prims.wallet.pub.slice(1) };
  const address = prims.wallet.address();
  const guard = keccak256 ? makeCrossLaneGuard({ keccak256 }) : null;

  // Explorers are shared, rate limited and sometimes down, so a read is not made the same way every time: the ones that answered are asked first and
  // the load is spread over them in turn, one that is failing (rate limited, down, slow) is left alone for a while, longer each time it fails again (or as
  // long as it asks, with a Retry-After), and still asked last when the others have failed too, so that none is ever given up for good. Reads for the same
  // path that are under way together are one read, and no more than `maxReads` are out at once however many locks are being judged.
  const health = new Map(list.map((b) => [b, { until: 0, fails: 0 }]));
  const retryAfter = (r) => { const v = Number(r && r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : 0); return v > 0 ? Math.min(v * 1000, 10 * 60000) : 0; };
  const hostOf = (b) => { try { return new URL(b).host; } catch { return b; } };
  const coolDown = (b, askedMs = 0, why = '') => {
    const h = health.get(b); const was = h.until > nowMs(); h.fails++; h.until = nowMs() + Math.max(askedMs, Math.min(coolMaxMs, coolMs * 2 ** (h.fails - 1)));
    if (!was) { try { log({ level: 'warn', msg: 'an explorer is left alone for a while', explorer: hostOf(b), why: String(why).slice(0, 120), forSecs: Math.round((h.until - nowMs()) / 1000) }); } catch { /* a log that fails changes nothing */ } }
  };
  const healed = (b) => { const h = health.get(b); h.fails = 0; h.until = 0; };
  let turnOf = 0;
  const askOrder = () => {
    const t = nowMs(), up = list.filter((b) => health.get(b).until <= t);
    const down = list.filter((b) => health.get(b).until > t).sort((a, b) => health.get(a).until - health.get(b).until);
    const k = up.length ? turnOf++ % up.length : 0;
    return [...up.slice(k), ...up.slice(0, k), ...down];
  };
  let reading = 0; const queued = [];
  const takeSlot = () => (reading < maxReads ? (reading++, Promise.resolve()) : new Promise((r) => queued.push(r)));
  const giveSlot = () => { const next = queued.shift(); if (next) next(); else reading--; };   // a waiting read takes the slot over as it is given back
  const underWay = new Map();

  // The first explorer that has the answer. A 404 from one is not the end of the search (another may know a newer
  // transaction); when none has it the 404 is the answer when every explorer that was asked said so or two agree (for a status look, two agreeing
  // with no other failure end the search: a transaction not out yet is not asked of every explorer on each look), and when none could answer it is an
  // error. One explorer's 404 beside others that failed is not an answer (the one that said 404 may be the one that lags), so it is an error to ask again.
  async function ask(path, init, quick = false) {
    let last = null, notFound = null, notFounds = 0;
    for (const b of askOrder()) {
      try {
        const r = await fetchImpl(b + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const text = (await r.text()).trim();
        if (r.ok) { healed(b); return text; }
        const err = Object.assign(new Error(`${path} -> ${r.status} ${text.slice(0, 160)}`), { status: r.status });
        if (r.status === 404) { healed(b); notFound ||= err; if (++notFounds >= 2 && !last && quick) break; } else { last = err; if (r.status === 429 || r.status >= 500) coolDown(b, retryAfter(r), `HTTP ${r.status}`); }
      } catch (e) { last = e; coolDown(b, 0, e && e.name === 'TimeoutError' ? 'timed out' : (e && e.cause && e.cause.code) || (e && e.message) || e); }
    }
    if (notFound && (!last || notFounds >= 2)) throw notFound;
    throw last || notFound;
  }
  async function req(path, init, quick = false) {
    if (init) { await takeSlot(); try { return await ask(path, init); } finally { giveSlot(); } }
    if (underWay.has(path)) return underWay.get(path);
    const p = (async () => { await takeSlot(); try { return await ask(path, init, quick); } finally { giveSlot(); } })().finally(() => underWay.delete(path));
    underWay.set(path, p);
    return p;
  }
  const getJson = async (path) => JSON.parse(await req(path));
  const orNull = async (fn) => { try { return await fn(); } catch (e) { if (e && e.status === 404) return null; throw e; } };

  // a transaction id is 64 hex digits and nothing else: it is put into a request path
  const isTxid = (t) => /^[0-9a-f]{64}$/.test(String(t));
  const need = (txid) => { if (!isTxid(txid)) throw new Error('not a transaction id'); return txid; };
  // confirmed transactions never change: the last few hundred are kept
  const txs = new Map();
  async function fetchTx(txid) {
    need(txid);
    if (txs.has(txid)) return txs.get(txid);
    const tx = await orNull(() => getJson(`/tx/${txid}`));
    if (tx && tx.status && tx.status.confirmed) { txs.set(txid, tx); if (txs.size > 400) txs.delete(txs.keys().next().value); }
    return tx;
  }
  const tip = async () => Number(await req('/blocks/tip/height'));
  async function status(txid) {
    const st = await orNull(async () => JSON.parse(await req(`/tx/${need(txid)}/status`, undefined, true)));
    if (!st || !st.confirmed) return { confirmations: 0, height: 0 };
    return { confirmations: (await tip()) - st.block_height + 1, height: st.block_height };
  }
  const blockTimes = new Map();
  async function blockTime(height) {
    if (!blockTimes.has(height)) blockTimes.set(height, (await getJson(`/block/${await req(`/block-height/${height}`)}`)).timestamp);
    return blockTimes.get(height);
  }
  async function outspend(txid, vout) {
    const o = await getJson(`/tx/${need(txid)}/outspend/${Number(vout) >>> 0}`);
    return o && o.spent ? o.txid : null;
  }
  // The median of what the explorers estimate. An estimate moves slowly and every quote asks for one, so the last answer is kept
  // for feeFreshMs and callers at the same moment share one read. A shared address can be rate limited by every explorer for
  // hours: an answer up to feeStaleMs old then stands in, and without one the error names what each explorer said.
  // An estimate above the ceiling (sat/vB) is a mistake or a lie; no fee market has been near it.
  const FEE_RATE_CEILING = 5000, FEE_RATE_SPREAD = 8;
  let fee = null, feeRead = null, feeLost = null;
  async function readFee(target = feeTarget) {
    const why = [];
    // Three explorers are asked first (the ones that answered lately, in turn: askOrder), and the rest only when fewer than two of them gave an estimate; one that
    // fails is left alone for a while like any other read (coolDown), so a dead explorer is not asked again with every estimate.
    const one = async (b) => {
      const host = hostOf(b);
      try {
        const r = await fetchImpl(b + '/fee-estimates', { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) { why.push(`${host} ${r.status}`); coolDown(b, retryAfter(r), `fee estimate ${r.status}`); return null; }
        const f = await r.json(), v = Number(f[target] ?? f['6']);
        if (Number.isFinite(v) && v > FEE_RATE_CEILING) { why.push(`${host} gave an implausible estimate`); return null; }
        if (Number.isFinite(v) && v > 0) { healed(b); return v; }
        why.push(`${host} gave no estimate`); return null;
      } catch (e) { why.push(`${host} ${e && e.name === 'TimeoutError' ? 'timed out' : 'was unreachable'}`); coolDown(b, 0, 'fee estimate failed'); return null; }
    };
    const order = askOrder();
    let seen = (await Promise.all(order.slice(0, 3).map(one))).filter((v) => v != null);
    if (seen.length < 2 && order.length > 3) seen = seen.concat((await Promise.all(order.slice(3).map(one))).filter((v) => v != null));
    seen.sort((a, b) => a - b);
    if (!seen.length) throw new Error(`no explorer answered a fee estimate (${why.join(', ')})`);
    // (`minFeeRate`: a lock that a bridge waits on is not sent at the least the network relays when the explorers' estimates run under it, as they
    // do when the pool is busy with transactions above that line: one sent at 1.06 sat/vB sat unconfirmed for over an hour)
    // explorers that disagree by more than this are not both right: the lower stands, since too low a rate only confirms slowly
    if (seen.length > 1 && seen[seen.length - 1] > seen[0] * FEE_RATE_SPREAD) return Math.max(1, minFeeRate, Math.ceil(seen[0]));
    // one explorer's word alone is held to `soloFeeCeiling` (sat/vB): a rate above it is taken only when two say so
    if (seen.length === 1) return Math.max(1, minFeeRate, Math.ceil(Math.min(seen[0], soloFeeCeiling)));
    return Math.max(1, minFeeRate, Math.ceil(seen.length % 2 ? seen[(seen.length - 1) / 2] : (seen[seen.length / 2 - 1] + seen[seen.length / 2]) / 2));
  }
  // What the explorers give for the NEXT block (target 1), read the same way: a lock that a block went by without is bumped to this, not to the target the
  // party sends at (a three-block estimate runs under what a block takes when a backlog builds: a lock bumped to it on 2026-11-28 waited three more blocks)
  let nextFee = null, nextRead = null;
  async function nextFeeRate(maxAgeMs = 60000) {
    const t = nowMs();
    if (nextFee && t - nextFee.at < maxAgeMs) return nextFee.v;
    try {
      nextRead ||= readFee('1').then((v) => { nextFee = { v, at: nowMs() }; return v; }).finally(() => { nextRead = null; });
      return await nextRead;
    } catch (e) { if (nextFee && t - nextFee.at < feeStaleMs) return nextFee.v; return feeRate(0); }
  }
  async function feeRate(maxAgeMs = feeFreshMs) {          // a caller that wants it newer than a quote needs it (the LP's tick) says so
    const t = nowMs();
    if (fee && t - fee.at < maxAgeMs) return fee.v;
    try {
      if (feeLost && t - feeLost.at < feeRetryMs) throw feeLost.error;          // a read that just failed is not repeated for every caller
      feeRead ||= readFee().then((v) => { fee = { v, at: nowMs() }; feeLost = null; return v; }, (e) => { feeLost = { at: nowMs(), error: e }; throw e; }).finally(() => { feeRead = null; });
      return await feeRead;
    } catch (e) { if (fee && t - fee.at < feeStaleMs) return fee.v; throw e; }
  }
  // the address's transactions, newest first, a page at a time (esplora gives the unconfirmed ones and 25 confirmed, then 25 after the last seen)
  async function history(addr = address, pages = 4) {
    const out = [];
    for (let i = 0, last = null; i < pages; i++) {
      const page = await getJson(`/address/${addr}/txs${last ? `/chain/${last}` : ''}`);
      if (!Array.isArray(page) || !page.length) break;
      out.push(...page);
      const confirmed = page.filter((t) => t.status && t.status.confirmed);
      if (confirmed.length < 25) break;
      last = confirmed[confirmed.length - 1].txid;
    }
    return out;
  }
  // The lock as the explorers see it, before this side locks anything against it: the transaction (its inputs and outputs), the block it is in, the tip, and
  // whether the lock output is spent. Ordinary reads take the first explorer that answers; this one asks them all. Two that show the same lock agree. An
  // explorer that does not answer (a refusal for too many requests, a timeout) is silent, which is not a contradiction: one explorer that answers alone
  // gives `thin: true`, and the caller waits for a second before it goes on (dapp/fastbridge-el.js locks nothing on one explorer's word). An explorer that says the lock is not there or not in a block, or two
  // that show it differently, is a contradiction: it throws (to be asked again). With one explorer configured, that one is the source.
  async function lockAgreed(txid, vout) {
    need(txid);
    const want = Math.min(2, list.length);
    const one = async (b) => {
      const get = async (p) => {
        const r = await fetchImpl(b + p, { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) throw Object.assign(new Error(`${p} -> ${r.status}`), { status: r.status });
        return (await r.text()).trim();
      };
      let tx;
      try { tx = JSON.parse(await get(`/tx/${txid}`)); } catch (e) { if (e && e.status === 404) return { deny: true }; throw e; }
      if (!tx || tx.txid !== txid || !tx.status || !tx.status.confirmed) return { deny: true };
      const out = (tx.vout || [])[vout];
      if (!out) return { deny: true };
      const tipH = Number(await get('/blocks/tip/height'));
      const sp = JSON.parse(await get(`/tx/${txid}/outspend/${Number(vout) >>> 0}`));
      const spent = !!(sp && sp.spent);
      return {
        key: JSON.stringify([tx.status.block_hash, tx.status.block_height, (tx.vin || []).map((i) => `${i.txid}:${i.vout}`), (tx.vout || []).map((o) => `${o.value}:${o.scriptpubkey}`), spent]),
        height: tx.status.block_height, tip: tipH, value: out.value, scriptpubkey: out.scriptpubkey, spent,
      };
    };
    const results = (await Promise.all(list.map((b) => one(b).catch(() => null)))).filter(Boolean);
    const denied = results.filter((r) => r.deny).length, seen = results.filter((r) => !r.deny);
    const groups = new Map();
    for (const s of seen) groups.set(s.key, [...(groups.get(s.key) || []), s]);
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
    const thin = best.length > 0 && best.length < want && groups.size === 1 && denied === 0;
    if (best.length < want && !thin) throw Object.assign(new Error(`the lock is not yet seen alike by ${want} explorers (${seen.length} answered, ${groups.size} views, ${denied} say it is not there)`), { transient: true });
    const tipH = Math.min(...best.map((s) => s.tip));
    return { confirmations: tipH - best[0].height + 1, height: best[0].height, value: best[0].value, scriptpubkey: best[0].scriptpubkey, spent: best[0].spent, agreed: best.length, ...(thin ? { thin: true } : {}) };
  }

  // plain-sat coins only: a coin of dust size may carry a note
  async function satsCoins() {
    const all = await getJson(`/address/${address}/utxo`);
    const coins = all.filter((u) => u.status && u.status.confirmed && u.value > DUST).sort((a, b) => b.value - a.value).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
    // what has reached the address and is not yet in a block: not spendable (a lock builds on confirmed coins), but a person who just paid it should see it is coming
    const pending = all.filter((u) => !(u.status && u.status.confirmed) && u.value > DUST).reduce((s, u) => s + u.value, 0);
    return { coins, pending };
  }
  const satsUtxos = async () => (await satsCoins()).coins;
  // The plain-sat coins a confirmed transaction pays to this address that are still unspent. A lock leaves one for the take of it (`takeSats`, paid to the
  // claimer's address), so the take can be funded from that one transaction, read by its id, instead of listing the whole address: explorers refuse that
  // list for an address with over 500 outputs and rate limit it harder than any other read. A coin whose spend cannot be read is left out, not guessed.
  async function coinsIn(txid) {
    const tx = await fetchTx(txid);
    if (!tx || !tx.status || !tx.status.confirmed) return [];
    const mine = bytesToHex(prims.p2wpkhScript(prims.wallet.pub)), out = [];
    for (const [vout, o] of (tx.vout || []).entries()) {
      if (o.scriptpubkey !== mine || !(o.value > DUST)) continue;
      let spent;
      try { spent = await outspend(txid, vout); } catch { continue; }
      if (spent === null) out.push({ txid, vout, value: o.value });
    }
    return out.sort((a, b) => b.value - a.value);
  }
  // the same bytes to each explorer in turn until one takes it (or already has it): its node passes it on to the network, and a second copy
  // would only be refused as known (a refusal a page shows as an error, and two explorers send it without the header a page needs to read it)
  async function post(hex) {
    let took = false, last = 'no explorer answered';
    for (const b of list) {
      try {
        const r = await fetchImpl(b + '/tx', { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(timeoutMs) });
        const text = (await r.text()).trim();
        if (r.ok || KNOWN.test(text)) { took = true; break; } else last = text.slice(0, 160);
      } catch (e) { last = String((e && e.message) || e).slice(0, 160); }
    }
    if (!took) throw new Error(`broadcast refused: ${last}`);
  }
  // the commit first, then the reveal, which is asked again while the commit spreads (a sats transaction has no commit: it is the reveal alone)
  async function broadcast(pair) {
    if (pair.commitHex) await post(pair.commitHex);
    let last;
    for (let i = 0; i < 6; i++) {
      try { await post(pair.revealHex); return; } catch (e) { last = e; await new Promise((r) => setTimeout(r, retryMs * (i + 1))); }
    }
    throw last;
  }

  // A note that cannot be told is not a note that is not valid. The validator marks each outpoint it rejects as 'invalid' or as 'fetch-failed' (an
  // explorer, or the pool service, that did not answer), and a rejection of the second kind is thrown: whoever asks (a provider judging a lock)
  // asks again, and a read that failed is never taken for a note that is not valid.
  //
  // The validator walks a note's whole history, and its awaits on reads it already has give the event loop back to microtasks only: a long history
  // held the process for minutes (measured on a real lock: 170 s) while Render's health check, which asks every few seconds, went unanswered and
  // restarted it, so the offer that was being judged started over. So each read gives the loop a real turn, and what is proved valid is kept for the
  // life of the process (a confirmed transaction's note does not change), so a history shared with an earlier lock is not walked again.
  const turn = () => new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
  // A note made by a bind (T_CXFER_BOUND) is a note only while the pool has not spent it, which can change at any time: an output of such a
  // transaction is never kept as proved (as tacit.js keeps it out of its own cache), and neither is one whose transaction this walk did not read.
  const T_CXFER_BOUND = 0x39;
  const proved = new Map();
  const validate = async (a, b, c, f) => {
    // (not the note being asked about: its own reads, the pool service's answer on an exit among them, are made again, so that a service that has
    // gone away is seen as one to ask again and not taken for a note that is not valid)
    for (const k of proved.keys()) if (k !== `${a}:${b}`) c.set(k, true);
    const before = new Set(c.keys()), read = new Map();
    const reasons = new Map();
    const ok = await tacit.validateOutpoint(a, b, c, async (t) => { const r = await f(t); if (r && r.txid) read.set(r.txid, r); await turn(); return r; }, 0, null, null, null, reasons);
    const lasting = (k) => {
      if (before.has(k) && proved.has(k)) return true;
      const tx = read.get(String(k).split(':')[0]);
      if (!tx) return false;
      let env = null; try { env = tacit.txOutputEnvelope(tx); } catch { return false; }
      return !(env && env.opcode === T_CXFER_BOUND);
    };
    for (const [k, v] of c) if (v === true && lasting(k)) proved.set(k, true);
    while (proved.size > 4000) proved.delete(proved.keys().next().value);
    if (ok !== true && reasons.get(`${a}:${b}`) === 'fetch-failed') throw Object.assign(new Error(`the note ${String(a).slice(0, 8)}…:${b} could not be read just now`), { transient: true });
    // a verdict that a note is not valid says where in its history: the first outpoint the walk rejected (its parents were judged before it), and what the reads gave
    if (ok !== true) { try { log({ level: 'warn', msg: 'a note is not valid', note: `${a}:${b}`, rejected: [...reasons].filter(([, v]) => v === 'invalid').slice(0, 3).map(([k]) => k), unread: [...reasons].filter(([, v]) => v === 'fetch-failed').length }); } catch { /* a log that fails is not a reason to answer otherwise */ } }
    return ok;
  };
  const resolveNote = tacit ? makeNoteResolver({ validateOutpoint: validate, txOutputEnvelope: tacit.txOutputEnvelope, getParentEnvelopeData: tacit.getParentEnvelopeData, fetchTx }) : null;

  // Whether a note the lock spends is already consumed on Ethereum, as the wallet asks before it spends a note. A reason
  // when it is (or cannot be told), null when the pool shows none of the note's identities spent.
  async function crossLaneBlocked(tx) {
    for (const i of tx.vin.slice(1)) {
      const note = await resolveNote(i.txid, i.vout);
      if (!note) return `${i.txid}:${i.vout} is not a valid note`;
      const parent = await fetchTx(i.txid);
      const spk = String(parent.vout[i.vout].scriptpubkey || '').toLowerCase();
      const P = secp.ProjectivePoint.fromHex(bytesToHex(note.commitment)).toRawBytes(false);
      const cx = '0x' + bytesToHex(P.slice(1, 33)), cy = '0x' + bytesToHex(P.slice(33, 65));
      const asset = '0x' + String(note.assetIdHex).replace(/^0x/, '');
      const auths = spk.startsWith('5120') ? ['0x' + spk.slice(4)] : [ZERO_AUTH];
      const nus = [];
      for (const a of auths) {
        nus.push(pool.nullifier(pool.btcNoteLeaf(asset, cx, cy, a)));
        if (binding && pool.btcNoteLeafBound) nus.push(pool.nullifier(pool.btcNoteLeafBound(asset, cx, cy, a, binding)));
      }
      const v = await guard.bitcoinSpendBlockedAny(ethGetStorageAt, poolAddress, nus);
      // (a pool that could not be read is not a note that is consumed: the guard is closed when it cannot tell, so nothing is accepted on it, but the answer is
      // asked for again, not given as a refusal that ends the swap)
      if (v.blocked && v.reason === 'evm-unverifiable') throw Object.assign(new Error('Ethereum could not be read just now'), { transient: true });
      if (v.blocked) return `${i.txid}:${i.vout} (${v.reason})`;
    }
    return null;
  }

  return { prims, wallet, tx: builder, address, satsUtxos, satsCoins, coinsIn, feeRate, nextFeeRate, broadcast, fetchTx, status, tip, blockTime, outspend, lockAgreed, history, resolveNote, crossLaneBlocked };
}
