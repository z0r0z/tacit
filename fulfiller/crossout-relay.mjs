// Tacit's relay for the Bitcoin step of a bridge to Bitcoin (worker/src/crossout-relay.js says what it is and why any coin may pay).
// One tick: say what the relay has (its address, coins and what is left of today's budget), then take each open ask oldest first:
// check it against the claim on chain, wait for the proof to cover the burn, and send the commit/reveal pair from the relay's key,
// keeping the signed pair before sending it so a restart sends the same pair and never a second one. A sent pair is followed until
// the reflection credits it. It declines (and the page sends the step from the holder's own sats) when the day's budget, a key's
// daily count or its coins would be passed, and waits while fees are over its ceiling.
import {
  relayKey, relayPrefix, relayInfoKey, relaySpentKey, relayDestKey, dayOf, OPEN_STATES, verifyClaim,
} from '../worker/src/crossout-relay.js';

const DAY_S = 86400;
const ASK_TTL_S = 14 * DAY_S;            // an ask is kept two weeks, whatever became of it
const EXPIRE_AFTER_MS = 3 * DAY_S * 1e3; // an ask that never became sendable in three days is let go
const SEND_TRIES = 6;                    // a pair Bitcoin keeps refusing is given up (its coin is free again: the commit never landed)
const RETRY_FAILED_MS = 30 * 60e3;       // a given-up pair whose coin is still unspent is offered again this often (a refusal may have passed)
const CHANGE_FLOOR = 1000;               // a coin must leave at least this much over the step, so change is worth keeping

export function makeCrossoutRelay({
  kv, network = 'mainnet', pool, prims, mintReveal, keccak256,
  api, ethRpc, esplora,
  dailySats = 50_000, maxFeeRate = 25, perDestDaily = 5, maxPerTick = 3,
  log = () => {}, now = () => Date.now(),
}) {
  if (!kv || !pool || !prims || !mintReveal || !keccak256 || !api || !ethRpc || !esplora) throw new Error('crossout-relay: deps missing');
  const address = prims.wallet.address();
  const put = async (rec) => { await kv.put(relayKey(network, rec.claimId), JSON.stringify(rec), { expiration: Math.floor(now() / 1e3) + ASK_TTL_S }); return rec; };
  const num = async (k) => Number((await kv.get(k)) || 0);
  const bump = async (k, by) => kv.put(k, String((await num(k)) + by), { expiration: Math.floor(now() / 1e3) + 3 * DAY_S });

  // The relay's own coins: confirmed, not already promised to a pair it signed or sent and has not seen land. A read that gives no list is an
  // error, never "no coins" (it would decline a step the relay could pay).
  async function ownCoins() {
    const utxos = await esplora.utxos(address);
    if (!Array.isArray(utxos)) throw new Error('crossout-relay: the relay\'s coins could not be read');
    return utxos;
  }
  async function freeCoins(held, all = null) {
    return (all || await ownCoins()).filter((u) => u.status?.confirmed && !held.has(`${u.txid}:${u.vout}`)).sort((a, b) => b.value - a.value);
  }

  async function opens() {
    const out = []; let cursor = null;
    do {
      const page = await kv.list({ prefix: relayPrefix(network), cursor });
      cursor = page.list_complete ? null : page.cursor;
      // and a pair given up as refused, whose coin may since have been taken: looked at again, so its claim can be sent with another coin
      for (const k of page.keys) { const r = await kv.get(k.name, 'json'); if (r && (OPEN_STATES.has(r.status) || (r.status === 'failed' && r.reason === 'refused' && r.commitTxid))) out.push(r); }
    } while (cursor);
    return out.sort((a, b) => (a.askedAt || 0) - (b.askedAt || 0));
  }

  async function covered(ethBlock) {
    const cv = await api(`/reflection/eth-state/covers?block=${ethBlock}`);
    return !!(cv && cv.covered === true);
  }
  // The claim's recorded mint, whichever pair made it: { mintedTxid } once the reflection has one.
  async function mintedAs(rec) {
    const st = await api(`/crossout/minted?asset=${rec.assetId}&claim=${rec.claimId}&txid=${'00'.repeat(32)}`);
    return st && st.status === 'minted' && st.mintedTxid ? String(st.mintedTxid).toLowerCase() : null;
  }

  // { refused: [node rejections], busy: [explorers that would not take a request (rate limits, outages)] }: only a rejection counts toward
  // giving a pair up; an explorer that is busy is no answer about the pair.
  async function send(rec) {
    const refused = [], busy = [];
    for (const hex of [rec.commitHex, rec.revealHex]) {
      try { await esplora.broadcast(hex); } catch (e) {
        const m = String(e?.message || e);
        if (/already|known|in block|in mempool|txn-mempool-conflict.*same/i.test(m)) continue;
        (e?.transient ? busy : refused).push(m);
      }
    }
    return { refused, busy };
  }

  // A pair it signed: sent, then followed until credited.
  async function follow(rec) {
    const done = await mintedAs(rec).catch(() => null);
    if (done) return put({ ...rec, status: done === rec.revealTxid ? 'minted' : 'elsewhere', mintedTxid: done, doneAt: now() });
    const seen = await esplora.txStatus(rec.revealTxid).catch(() => undefined);
    if (seen === undefined) return rec;                                // Bitcoin could not be read: next tick
    if (seen && seen.confirmed) return rec.status === 'sent' ? rec : put({ ...rec, status: 'sent', sentAt: rec.sentAt || now() });
    if (seen) return rec.status === 'sent' ? rec : put({ ...rec, status: 'sent', sentAt: now() });
    // not on Bitcoin (never sent, or dropped): if its coin has gone to another transaction this pair can never land, so the claim goes back to
    // be signed with another coin (no second mint is possible: this pair's commit cannot exist); else the same pair is sent again
    if (await coinTaken(rec)) return requeue(rec);
    if (rec.status === 'failed' && now() - Number(rec.failedAt || 0) < RETRY_FAILED_MS) return rec;
    const { refused, busy } = await send(rec);
    if (!refused.length && !busy.length) return put({ ...rec, status: 'sent', sentAt: rec.sentAt || now(), tries: (rec.tries || 0) + 1, lastError: null });
    if (!refused.length) {
      // every explorer was busy: no answer about the pair, so it is neither a try nor a refusal; the next tick sends it again
      log('warn', 'crossout relay: no explorer would take the pair just now', { claim: rec.claimId, err: busy[0].slice(0, 160) });
      return put({ ...rec, ...(rec.status === 'failed' ? { status: 'signing', failedAt: null } : {}), lastError: busy[0].slice(0, 200) });
    }
    const tries = (rec.tries || 0) + 1;
    log('warn', 'crossout relay: Bitcoin refused the pair', { claim: rec.claimId, err: refused[0].slice(0, 160), tries });
    if (await coinTaken(rec)) return requeue(rec);
    return put({ ...rec, tries, lastError: refused[0].slice(0, 200), ...(tries >= SEND_TRIES ? { status: 'failed', reason: 'refused', failedAt: now() } : {}) });
  }
  // the pair's funding coin is spent, and not by its own commit
  async function coinTaken(rec) {
    if (!rec.fundingUtxo || !esplora.outspend) return false;
    const o = await esplora.outspend(rec.fundingUtxo.txid, rec.fundingUtxo.vout).catch(() => null);
    return !!(o && o.spent && o.txid && String(o.txid).toLowerCase() !== String(rec.commitTxid || '').toLowerCase());
  }
  function requeue(rec) {
    log('warn', 'crossout relay: the pair\'s coin went elsewhere; the claim is signed again with another coin', { claim: rec.claimId, dead: rec.commitTxid });
    return put({ ...rec, status: 'queued', reason: null, note: 'coin-taken', commitHex: null, revealHex: null, commitTxid: null, revealTxid: null, fundingUtxo: null,
      tries: 0, lastError: null, retakes: (rec.retakes || 0) + 1, deadCommits: [...(rec.deadCommits || []), rec.commitTxid].filter(Boolean) });
  }

  async function consider(rec, held, spent, rate) {
    if (now() - (rec.askedAt || 0) > EXPIRE_AFTER_MS) return put({ ...rec, status: 'expired', reason: rec.reason || 'not-sendable' });
    const v = await verifyClaim({ keccak256, ethRpc, pool, req: rec });
    if (!v.ok) return put({ ...rec, ...(v.retry ? { status: 'queued', note: v.reason } : { status: 'rejected', reason: v.reason }) });
    if (!(await covered(rec.ethBlock))) return rec.status === 'waiting' && rec.note === 'proof' ? rec : put({ ...rec, status: 'waiting', note: 'proof' });
    const done = await mintedAs(rec);
    if (done) return put({ ...rec, status: 'elsewhere', mintedTxid: done, doneAt: now() });
    if (!(rate > 0)) return rec;
    if (rate > maxFeeRate) return rec.note === 'fees' ? rec : put({ ...rec, status: 'waiting', note: 'fees' });
    const need = mintReveal.estimateSats({ feeRate: rate, dust: prims.DUST });
    if (spent.today + need > dailySats) return put({ ...rec, status: 'declined', reason: 'budget' });
    const day = dayOf(now());
    if ((await num(relayDestKey(network, day, rec.destXonly))) >= perDestDaily) return put({ ...rec, status: 'declined', reason: 'limit' });
    const all = await ownCoins(), free = await freeCoins(held, all);
    const coin = free.find((u) => u.value >= need + CHANGE_FLOOR) || free.find((u) => u.value >= need);
    if (!coin) {
      // a coin big enough that is only waiting for its confirmation (the last step's change): wait for it, the page's grace covers the block
      if (all.some((u) => !u.status?.confirmed && u.value >= need)) return rec.note === 'coin' && rec.status === 'waiting' ? rec : put({ ...rec, status: 'waiting', note: 'coin' });
      return put({ ...rec, status: 'declined', reason: 'funds' });
    }
    const built = mintReveal.buildCrossoutMintTxs({
      prims, assetId: '0x' + rec.assetId, claimId: '0x' + rec.claimId, cx: '0x' + rec.cx, cy: '0x' + rec.cy, destXonly: rec.destXonly,
      fundingUtxo: { txid: coin.txid, vout: coin.vout, value: coin.value }, feeRate: rate,
    });
    const cost = built.commitFee + built.commitValue;
    // kept before it is sent: a restart sends this pair, never a second one for the same claim
    const signed = await put({
      ...rec, status: 'signing', note: null, commitHex: built.commitHex, revealHex: built.revealHex, commitTxid: built.commitTxid.toLowerCase(),
      revealTxid: built.revealTxid.toLowerCase(), fundingUtxo: { txid: coin.txid, vout: coin.vout, value: coin.value }, feeRate: rate, cost, signedAt: now(),
    });
    held.add(`${coin.txid}:${coin.vout}`);
    await bump(relaySpentKey(network, day), need); spent.today += need;
    await bump(relayDestKey(network, day, rec.destXonly), 1);
    log('info', 'crossout relay: sending the Bitcoin step', { claim: rec.claimId, reveal: signed.revealTxid, sats: need, rate, cost });
    return follow(signed);
  }

  async function tick() {
    const day = dayOf(now()), spent = { today: await num(relaySpentKey(network, day)) };
    const list = await opens();
    const held = new Set(list.filter((r) => (r.status === 'signing' || r.status === 'sent') && r.fundingUtxo).map((r) => `${r.fundingUtxo.txid}:${r.fundingUtxo.vout}`));
    let rate = 0;
    try { rate = Math.max(1, Math.ceil(Number(await esplora.feeRate()) || 0)); } catch {}
    let coins = [], balance = null;
    try { coins = await freeCoins(held); balance = coins.reduce((n, u) => n + u.value, 0); } catch {}
    const need = rate ? mintReveal.estimateSats({ feeRate: rate, dust: prims.DUST }) : null;
    const ready = !!need && rate <= maxFeeRate && spent.today + need <= dailySats && coins.some((u) => u.value >= need);
    await kv.put(relayInfoKey(network), JSON.stringify({ address, balance, coins: coins.length, feeRate: rate || null, maxFeeRate, dailySats, spentToday: spent.today, perDestDaily, needSats: need, ready, at: now() }), { expiration: Math.floor(now() / 1e3) + DAY_S });
    let sent = 0;
    for (const rec of list) {
      try {
        if (rec.status === 'signing' || rec.status === 'sent' || rec.status === 'failed') { await follow(rec); continue; }
        if (sent >= maxPerTick) continue;
        const r = await consider(rec, held, spent, rate);
        if (r && (r.status === 'signing' || r.status === 'sent') && rec.status !== r.status) sent++;
      } catch (e) { log('error', 'crossout relay: an ask threw', { claim: rec.claimId, err: String(e?.message || e).slice(0, 200) }); }
    }
    return { open: list.length, sent, ready, balance, spentToday: spent.today };
  }

  return { tick, address };
}

// Bitcoin by Esplora: reads from `read` (the Tacit API's /chain proxy in the watchtower: a public explorer throttles a server's address),
// with `query` appended (its network), then from each of `backup` when it fails (the proxy too can be cooling on its upstreams); and
// broadcasts to each of `send` in turn until one takes the transaction.
export function makeEsplora({ read = 'https://mempool.space/api', query = '', backup = [], send = null } = {}, fetchImpl = (...a) => fetch(...a)) {
  const sources = [[read, query], ...backup.map((b) => [b, ''])];
  const get1 = async ([base, qs], p) => {
    const r = await fetchImpl(`${base}${p}${qs ? (p.includes('?') ? '&' : '?') + qs : ''}`, { signal: AbortSignal.timeout(15e3) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`esplora ${p} ${r.status}`);
    return r.json();
  };
  const get = async (p) => { let last; for (const s of sources) { try { return await get1(s, p); } catch (e) { last = e; } } throw last; };
  return {
    utxos: (addr) => get(`/address/${addr}/utxo`),
    // { spent, txid } of an output: which transaction spent it, if any
    outspend: (txid, vout) => get(`/tx/${txid}/outspend/${vout}`),
    // mempool.space's recommended rates, or an Esplora's estimates (Blockstream has only those): the rate for about three blocks
    feeRate: async () => {
      try { const f = await get('/v1/fees/recommended'); if (f && (f.halfHourFee || f.fastestFee)) return f.halfHourFee || f.fastestFee; } catch {}
      const e = await get('/fee-estimates');
      return e ? Math.ceil(Number(e['3'] ?? e['2'] ?? e['6']) || 0) || null : null;
    },
    // null: not on Bitcoin; { confirmed }: in the mempool or a block. Asked of the transaction itself: /tx/:id/status answers
    // {"confirmed":false} (HTTP 200) for a transaction nobody has seen, which reads as "in the mempool" and is never sent.
    txStatus: async (txid) => { const t = await get(`/tx/${txid}`); return t ? { confirmed: !!t.status?.confirmed } : null; },
    // to each of `send` in turn until one takes it, then (best effort, not awaited) to the rest, so one mempool dropping it is not the end of
    // it. A node's rejection of the transaction is thrown at once; explorers that are all busy (rate limits, outages, timeouts) throw an
    // error marked `transient`, which is no answer about the transaction.
    broadcast: async (hex) => {
      const bases = send || [read];
      let last = null;
      for (let i = 0; i < bases.length; i++) {
        try {
          const r = await fetchImpl(bases[i] + '/tx', { method: 'POST', body: hex, signal: AbortSignal.timeout(15e3) });
          const t = await r.text();
          if (r.ok) {
            for (const b of bases.slice(i + 1)) fetchImpl(b + '/tx', { method: 'POST', body: hex, signal: AbortSignal.timeout(15e3) }).catch(() => {});
            return t.trim();
          }
          last = new Error(t || `broadcast ${r.status}`);
          if (r.status === 400 && !/rate|limit|too many/i.test(t)) throw Object.assign(last, { rejected: true });   // the transaction itself is refused
        } catch (e) { last = e; if (e?.rejected || /^(sendrawtransaction|RPC error|bad-|txn-|non-mandatory|mandatory|missing-inputs|insufficient)/i.test(String(e?.message || ''))) throw e; }
      }
      throw Object.assign(last || new Error('no explorer took the transaction'), { transient: true });
    },
  };
}
