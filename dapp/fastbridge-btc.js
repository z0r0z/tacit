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

export function makeEsploraBtcChain({ bases, tacit, prims, builder, pool, ethGetStorageAt, poolAddress, binding, keccak256, secp, fetchImpl = fetch, timeoutMs = 20000, feeTarget = '3', minFeeRate = 1, retryMs = 1500, feeFreshMs = 60000, feeStaleMs = 2 * 3600000, feeRetryMs = 15000, nowMs = Date.now }) {
  const list = bases.map((b) => b.replace(/\/$/, ''));
  const wallet = { pub: prims.wallet.pub, priv: prims.wallet.priv, xonly: prims.wallet.pub.slice(1) };
  const address = prims.wallet.address();
  const guard = keccak256 ? makeCrossLaneGuard({ keccak256 }) : null;

  // The first explorer that has the answer. A 404 from one is not the end of the search (another may know a newer
  // transaction); when none has it the 404 is the answer, and when none could answer it is an error.
  async function req(path, init) {
    let last = null, notFound = null;
    for (const b of list) {
      try {
        const r = await fetchImpl(b + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const text = (await r.text()).trim();
        if (r.ok) return text;
        const err = Object.assign(new Error(`${path} -> ${r.status} ${text.slice(0, 160)}`), { status: r.status });
        if (r.status === 404) notFound ||= err; else last = err;
      } catch (e) { last = e; }
    }
    throw notFound || last;
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
    const st = await orNull(() => getJson(`/tx/${need(txid)}/status`));
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
  async function readFee() {
    const why = [];
    const seen = (await Promise.all(list.map(async (b) => {
      const host = (() => { try { return new URL(b).host; } catch { return b; } })();
      try {
        const r = await fetchImpl(b + '/fee-estimates', { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) { why.push(`${host} ${r.status}`); return null; }
        const f = await r.json(), v = Number(f[feeTarget] ?? f['6']);
        if (Number.isFinite(v) && v > FEE_RATE_CEILING) { why.push(`${host} gave an implausible estimate`); return null; }
        if (Number.isFinite(v) && v > 0) return v;
        why.push(`${host} gave no estimate`); return null;
      } catch (e) { why.push(`${host} ${e && e.name === 'TimeoutError' ? 'timed out' : 'was unreachable'}`); return null; }
    }))).filter((v) => v != null).sort((a, b) => a - b);
    if (!seen.length) throw new Error(`no explorer answered a fee estimate (${why.join(', ')})`);
    // (`minFeeRate`: a lock that a bridge waits on is not sent at the least the network relays when the explorers' estimates run under it, as they
    // do when the pool is busy with transactions above that line: one sent at 1.06 sat/vB sat unconfirmed for over an hour)
    // explorers that disagree by more than this are not both right: the lower stands, since too low a rate only confirms slowly
    if (seen.length > 1 && seen[seen.length - 1] > seen[0] * FEE_RATE_SPREAD) return Math.max(1, minFeeRate, Math.ceil(seen[0]));
    return Math.max(1, minFeeRate, Math.ceil(seen.length % 2 ? seen[(seen.length - 1) / 2] : (seen[seen.length / 2 - 1] + seen[seen.length / 2]) / 2));
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
  // plain-sat coins only: a coin of dust size may carry a note
  async function satsUtxos() {
    const all = await getJson(`/address/${address}/utxo`);
    return all.filter((u) => u.status && u.status.confirmed && u.value > DUST).sort((a, b) => b.value - a.value).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
  }
  // the same bytes to every explorer; one that takes it (or already has it) is enough
  async function post(hex) {
    let took = false, last = 'no explorer answered';
    for (const b of list) {
      try {
        const r = await fetchImpl(b + '/tx', { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(timeoutMs) });
        const text = (await r.text()).trim();
        if (r.ok || KNOWN.test(text)) took = true; else last = text.slice(0, 160);
      } catch (e) { last = String((e && e.message) || e).slice(0, 160); }
    }
    if (!took) throw new Error(`broadcast refused: ${last}`);
  }
  // the commit first, then the reveal, which is asked again while the commit spreads
  async function broadcast(pair) {
    await post(pair.commitHex);
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
  const proved = new Map();
  const validate = async (a, b, c, f) => {
    // (not the note being asked about: its own reads, the pool service's answer on an exit among them, are made again, so that a service that has
    // gone away is seen as one to ask again and not taken for a note that is not valid)
    for (const k of proved.keys()) if (k !== `${a}:${b}`) c.set(k, true);
    const reasons = new Map();
    const ok = await tacit.validateOutpoint(a, b, c, async (t) => { const r = await f(t); await turn(); return r; }, 0, null, null, null, reasons);
    for (const [k, v] of c) if (v === true) proved.set(k, true);
    while (proved.size > 4000) proved.delete(proved.keys().next().value);
    if (ok !== true && reasons.get(`${a}:${b}`) === 'fetch-failed') throw Object.assign(new Error(`the note ${String(a).slice(0, 8)}…:${b} could not be read just now`), { transient: true });
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
      if (v.blocked) return `${i.txid}:${i.vout} (${v.reason})`;
    }
    return null;
  }

  return { prims, wallet, tx: builder, address, satsUtxos, feeRate, broadcast, fetchTx, status, tip, blockTime, outspend, history, resolveNote, crossLaneBlocked };
}
