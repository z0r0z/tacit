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

  // The relay's own coins: confirmed, not already promised to a pair it signed and has not seen land.
  async function freeCoins(held) {
    const utxos = (await esplora.utxos(address)) || [];
    return utxos.filter((u) => u.status?.confirmed && !held.has(`${u.txid}:${u.vout}`)).sort((a, b) => b.value - a.value);
  }

  async function opens() {
    const out = []; let cursor = null;
    do {
      const page = await kv.list({ prefix: relayPrefix(network), cursor });
      cursor = page.list_complete ? null : page.cursor;
      for (const k of page.keys) { const r = await kv.get(k.name, 'json'); if (r && OPEN_STATES.has(r.status)) out.push(r); }
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

  async function send(rec) {
    const refused = [];
    for (const hex of [rec.commitHex, rec.revealHex]) {
      try { await esplora.broadcast(hex); } catch (e) { const m = String(e?.message || e); if (!/already|known|in block|in mempool|txn-mempool-conflict.*same/i.test(m)) refused.push(m); }
    }
    return refused;
  }

  // A pair it signed: sent, then followed until credited.
  async function follow(rec) {
    const done = await mintedAs(rec).catch(() => null);
    if (done) return put({ ...rec, status: done === rec.revealTxid ? 'minted' : 'elsewhere', mintedTxid: done, doneAt: now() });
    const seen = await esplora.txStatus(rec.revealTxid).catch(() => undefined);
    if (seen === undefined) return rec;                                // Bitcoin could not be read: next tick
    if (seen && seen.confirmed) return rec.status === 'sent' ? rec : put({ ...rec, status: 'sent', sentAt: rec.sentAt || now() });
    if (seen) return rec.status === 'sent' ? rec : put({ ...rec, status: 'sent', sentAt: now() });
    // not on Bitcoin (never sent, or dropped): send it again, the same pair
    const refused = await send(rec);
    if (!refused.length) return put({ ...rec, status: 'sent', sentAt: rec.sentAt || now(), tries: (rec.tries || 0) + 1 });
    const tries = (rec.tries || 0) + 1;
    log('warn', 'crossout relay: Bitcoin refused the pair', { claim: rec.claimId, err: refused[0].slice(0, 160), tries });
    return put({ ...rec, tries, lastError: refused[0].slice(0, 200), ...(tries >= SEND_TRIES ? { status: 'failed', reason: 'refused' } : {}) });
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
    const coin = (await freeCoins(held)).find((u) => u.value >= need + CHANGE_FLOOR) || (await freeCoins(held)).find((u) => u.value >= need);
    if (!coin) return put({ ...rec, status: 'declined', reason: 'funds' });
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
    const held = new Set(list.filter((r) => r.status === 'signing' && r.fundingUtxo).map((r) => `${r.fundingUtxo.txid}:${r.fundingUtxo.vout}`));
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
        if (rec.status === 'signing' || rec.status === 'sent') { await follow(rec); continue; }
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
// with `query` appended (its network), and broadcasts to each of `send` in turn until one takes the transaction.
export function makeEsplora({ read = 'https://mempool.space/api', query = '', send = null } = {}, fetchImpl = (...a) => fetch(...a)) {
  const q = (p) => `${read}${p}${query ? (p.includes('?') ? '&' : '?') + query : ''}`;
  const get = async (p) => { const r = await fetchImpl(q(p), { signal: AbortSignal.timeout(15e3) }); if (r.status === 404) return null; if (!r.ok) throw new Error(`esplora ${p} ${r.status}`); return r.json(); };
  return {
    utxos: (addr) => get(`/address/${addr}/utxo`),
    feeRate: async () => { const f = await get('/v1/fees/recommended'); return f ? f.halfHourFee || f.fastestFee : null; },
    // null: not on Bitcoin; { confirmed }: in the mempool or a block
    txStatus: async (txid) => { const s = await get(`/tx/${txid}/status`); return s ? { confirmed: !!s.confirmed } : null; },
    broadcast: async (hex) => {
      let last = null;
      for (const base of send || [read]) {
        try {
          const r = await fetchImpl(base + '/tx', { method: 'POST', body: hex, signal: AbortSignal.timeout(15e3) });
          const t = await r.text();
          if (r.ok) return t.trim();
          last = new Error(t || `broadcast ${r.status}`);
          if (r.status === 400) throw last;            // the transaction itself is refused: another explorer will say the same
        } catch (e) { last = e; if (/^(sendrawtransaction|RPC error|bad-|txn-|non-mandatory|mandatory|missing-inputs|insufficient)/i.test(String(e?.message || ''))) throw e; }
      }
      throw last || new Error('no explorer took the transaction');
    },
  };
}
