// The swap page's Bitcoin lane: tETH and TAC swapped in the Bitcoin pool, signed by a Tacit key. The page loads this when the lane is first opened. tacit.js
// comes with it through the trade page's Bitcoin module, which also holds the key's sign-in. Nothing here builds or signs a transaction: tacit.js does.
import { esc, fmtUnits, parseUnits, plain } from '/trade/util.js?cb=ba5a02b1';
import { moveSatsNeeded, MOVE_SATS_FLAT } from '/btc-book.js?cb=0a09ab9e';

const BTC_MODULE = '/trade/btc.js?cb=124a5ce8';
const TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const TOKENS = { [TETH]: { sym: 'tETH', icon: 'teth', dec: 8 }, [TAC]: { sym: 'TAC', icon: 'tac', dec: 8 } };
const SLIPS = [50, 100, 300];
const DUST = 546, IMPACT_WARN = 0.05, IMPACT_ACK = 0.1;
const STAGES = { check: 'Checking the pool…', prepare: 'Cutting the exact amount…', 'cut:wait': 'Waiting for the network to show the cut…', send: 'Sending the swap…' };
const MEMPOOL = 'https://mempool.space';
const SLIP_KEY = 'tacit-swap-btc-slip-v1';
const SENT_KEY = 'tacit-swap-btc-sent-v1', SENT_KEEP = 5, SENT_FOR = 24 * 3600e3;               // the swaps sent from this browser, so one is still followed after a reload
const BRIDGED_KEY = 'tacit-bridged-v1';                                           // what each key last read at its Taproot address, as the front page keeps it

const tidy = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
// A price in plain notation: six digits from 1 up, four significant ones below; zeros are dropped only after a decimal point (100000 stays 100000)
export const priceText = (px) => (!(px > 0) || !Number.isFinite(px) ? '0' : px >= 1e5 ? px.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 }) : px >= 1 ? tidy(px.toPrecision(6)) : tidy(px.toFixed(Math.min(20, 3 - Math.floor(Math.log10(px))))));
const fmt = (v, aid, max = 8) => fmtUnits(v, TOKENS[aid].dec, max);
const sym = (aid) => TOKENS[aid].sym;
const ageText = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
// The swaps kept, newest first: every one still waiting, however many or old (it is followed until it settles), and the settled ones in the room that is left
export function keepSent(xs) {
  let room = SENT_KEEP - xs.filter((s) => s.state === 'waiting').length;
  return xs.filter((s) => s.state === 'waiting' || room-- > 0);
}
function loadSent() {
  try {
    return keepSent((JSON.parse(localStorage.getItem(SENT_KEY) || '[]') || [])
      .filter((s) => /^[0-9a-f]{64}$/.test(s?.txid) && TOKENS[s.from] && TOKENS[s.to] && [s.din, s.quoted, s.floor].every((v) => /^\d+$/.test(String(v))) && Number.isFinite(s.at) && (Date.now() - s.at < SENT_FOR || s.state === 'waiting'))
      .map((s) => ({ ...s, din: BigInt(s.din), quoted: BigInt(s.quoted), floor: BigInt(s.floor), got: s.got != null ? BigInt(s.got) : null, refund: s.refund != null ? BigInt(s.refund) : null })));
  } catch { return []; }
}
// Why the pool returned a swap, from the reason it gave: a price past the floor is the usual one
const refundWhy = (r) => (!r || /slippage|floor/i.test(r) ? 'The pool had moved past your floor.' : r === 'expired' ? 'The swap expired before the pool settled it.' : `The pool passed on it (${r}).`);
// Where the explorer has a transaction: { block } (null while it is in the mempool), { gone } when it does not know it, undefined when it did not answer.
const whereIs = (txid) => fetch(`${MEMPOOL}/api/tx/${txid}`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.status === 404 ? { gone: true } : r.ok ? r.json().then((j) => ({ block: j.status?.confirmed ? j.status.block_height ?? null : null })) : undefined)).catch(() => undefined);

export function makeBitcoinLane({ host, notify = () => {}, wallet = () => null, onBridged = () => {}, from = 'teth' }) {
  let slip = 100;
  try { const s = Number(localStorage.getItem(SLIP_KEY)); if (SLIPS.includes(s)) slip = s; } catch { /* storage is a convenience */ }
  const L = { pay: from === 'tac' ? TAC : TETH, get: from === 'tac' ? TETH : TAC, amt: '', q: null, pool: null, noPool: false, bal: {}, sats: null, need: null, notes: [], unread: 0, bridgedAt: 0, ack: false, busy: false, sent: loadSent(), asking: null, line: '', cls: '', open: false };
  let moveNeed = MOVE_SATS_FLAT, bitcoin = null, T = null, ensuring = null, mounted = false, seq = 0, qTimer = 0, poll = 0, refreshTimer = 0, reading = null;
  const $ = (id) => host.querySelector(`#${id}`);

  host.innerHTML = `
    <div class="f" id="b-pay">
      <div class="fh"><span>From</span><span class="where"><svg class="tk xs" aria-hidden="true"><use href="#c-btc"/></svg>Bitcoin</span></div>
      <div class="fm"><input class="amt" id="b-amt" inputmode="decimal" placeholder="0" autocomplete="off" spellcheck="false" aria-label="Amount to pay"><span class="coin" id="b-pay-coin"></span></div>
      <div class="ff"><span id="b-bal" class="num"></span><span class="quick" id="b-quick"></span></div>
    </div>
    <div class="mid"><button class="flip" id="b-flip" type="button" aria-label="Swap the two sides"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v17m0 0-4-4m4 4 4-4M16 21V4m0 0-4 4m4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <div class="f" id="b-get">
      <div class="fh"><span>To</span><span class="where"><svg class="tk xs" aria-hidden="true"><use href="#c-btc"/></svg>Bitcoin</span></div>
      <div class="fm"><output class="big ph num" id="b-out" for="b-amt">0</output><span class="coin" id="b-get-coin"></span></div>
      <div class="ff"><span id="b-get-bal" class="num"></span><span></span></div>
    </div>
    <dl class="rcpt" id="b-rcpt" hidden></dl>
    <div class="brd" id="b-brd" hidden></div>
    <div class="snt" id="b-sent" hidden></div>
    <div class="act">
      <div class="ack" id="b-ack" hidden><label><input type="checkbox" id="b-ackbox"> <span id="b-acktext"></span></label></div>
      <button class="go" id="b-go" type="button" disabled>Open your Tacit wallet</button>
      <p class="q" id="b-q" role="status"></p>
    </div>
    <div class="sw-foot"><span>Slippage</span><span class="slip" id="b-slip" role="group" aria-label="Slippage"></span></div>`;

  const say = (h, cls = '') => { L.line = h; L.cls = cls; const q = $('b-q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };

  // ── the library, the key and the pool ──
  // made once, however fast the lane is opened again: the first call's promise is what the rest wait on (a failed start is asked again)
  const ensure = () => (ensuring ||= (async () => {
    if (!bitcoin) {
      const m = await import(BTC_MODULE);
      bitcoin = m.makeBitcoin({ notify, wallet, onChange: () => { if (L.open) { paint(); readMe(true); } }, asset: { id: TETH, title: 'tETH on Bitcoin', after: '' } });
    }
    T ||= await bitcoin.session.load();
    return T;
  })().catch((e) => { ensuring = null; throw e; }));
  const unlocked = () => !!bitcoin?.session.unlocked;

  async function readPool() {
    const pools = await T.bitcoinSwapPools();
    const p = pools.find((x) => [x.asset_a, x.asset_b].sort().join() === [TETH, TAC].sort().join());
    L.pool = p ? { id: String(p.pool_id).toLowerCase(), a: String(p.asset_a).toLowerCase(), ra: BigInt(p.reserve_a), rb: BigInt(p.reserve_b), fee: p.fee_bps } : null;
    L.noPool = !p;
  }
  // The sats a swap can spend and what the key holds: the coins that carry a token are not counted as sats.
  const spendable = (utxos, holdings) => {
    const keep = new Set();
    if (holdings instanceof Map) {
      const add = (x) => { const t = x?.utxo?.txid || x?.txid, v = x?.utxo?.vout ?? x?.vout; if (t != null) keep.add(`${t}:${v}`); };
      for (const h of holdings.values()) for (const k of ['utxos', 'ghosts', 'inflated', 'pending', 'unverified']) for (const x of (h[k] || [])) add(x);
      for (const k of (holdings.unclassified || [])) keep.add(k);
    }
    return utxos.reduce((a, u) => a + (Number(u.value || 0) > DUST && !keep.has(`${u.txid}:${u.vout}`) ? Number(u.value) : 0), 0);
  };
  function readMe(quiet = false) {
    if (!unlocked()) return Promise.resolve();
    if (reading) return reading;
    const key = bitcoin.session.key?.pubHex;
    reading = (async () => {
      try {
        const [utxos, holdings] = await Promise.all([T.getUtxos(T.wallet.address()).catch(() => null), T.scanHoldings().catch(() => null)]);
        if (bitcoin.session.key?.pubHex !== key) return;
        if (Array.isArray(utxos)) L.sats = spendable(utxos, holdings);
        if (holdings instanceof Map) for (const aid of [TETH, TAC]) L.bal[aid] = holdings.get(aid)?.balance ?? 0n;
        L.need = await T.bitcoinSwapFundsNeeded().catch(() => L.need);
        paint();
        readBridged();
      } catch (e) { if (!quiet) say(esc(e?.message || e), 'err'); }
      finally { reading = null; }
    })();
    return reading;
  }
  // Tokens bridged to Bitcoin sit at the key's Taproot address, which a swap does not spend from: they are listed here with the move.
  // What was read is kept for the key as the front page keeps it (a count and a sum, no note), so the page's Bitcoin switch can say a move is waiting
  // and stops saying it once there is none.
  function keepBridged(pub, name, r) {
    if (!pub || r.unread) return;
    try {
      const all = JSON.parse(localStorage.getItem(BRIDGED_KEY) || '{}') || {}, mine = (all[pub] ||= {}), ok = r.notes.filter((n) => n.amount != null);
      mine[name] = { v: String(ok.reduce((t, n) => t + BigInt(n.amount), 0n)), n: ok.length, ready: ok.filter((n) => n.confirmed).length, at: Date.now() };
      localStorage.setItem(BRIDGED_KEY, JSON.stringify(all));
    } catch { /* storage is a convenience */ }
  }
  async function readBridged() {
    if (!unlocked() || Date.now() - L.bridgedAt < 60e3) return;
    L.bridgedAt = Date.now();
    const pub = bitcoin.session.key?.pubHex;
    try {
      const { count } = await T.bridgedAtTaproot({ force: true });
      let notes = [], unread = 0;
      if (count) {
        const [a, b] = await Promise.all([T.bridgedNotes(TETH), T.bridgedNotes(TAC)]);
        notes = [...a.notes.map((n) => ({ ...n, aid: TETH })), ...b.notes.map((n) => ({ ...n, aid: TAC }))]; unread = a.unread + b.unread;
      }
      // What a swap paid to the Taproot address (its receipt) waits there like a bridged note: the holdings, which read the trading address, do not count it.
      const got = await T.swapReceiptNotes().then((r) => r.filter((n) => TOKENS[n.assetIdHex]).map((n) => ({ ...n, aid: n.assetIdHex, swap: true })), () => []);
      L.notes = [...notes, ...got]; L.unread = unread;
      for (const [aid, name] of [[TETH, 'teth'], [TAC, 'tac']]) keepBridged(pub, name, { notes: L.notes.filter((n) => n.aid === aid), unread });
    } catch { L.bridgedAt = 0; }
    paint(); onBridged();
  }
  // The bridged note of a token that is ready to move (its amount read, its block confirmed), the largest first, or -1.
  const readyNote = (aid) => {
    let best = -1;
    L.notes.forEach((n, i) => { if (n.aid === aid && n.amount != null && n.confirmed && (best < 0 || n.amount > L.notes[best].amount)) best = i; });
    return best;
  };

  // ── the quote ──
  const amountBase = () => { const v = parseUnits(L.amt, TOKENS[L.pay].dec); return v && v > 0n ? v : null; };
  // `keep` leaves the quote shown until the new one lands (the lane's own refresh: the pool's floor covers a quote that old); an amount, pair or slippage change clears it
  function requote(now = false, keep = false) {
    clearTimeout(qTimer);
    seq++;                                                                       // a quote still on its way is for the amount before this one
    const din = amountBase();
    if (!keep || !din || !T || L.noPool) L.q = null;
    if (!din || !T || L.noPool) { paint(); return; }
    const run = async () => {
      const my = ++seq;
      try {
        const q = await T.bitcoinSwapQuote({ fromAid: L.pay, toAid: L.get, amountIn: din, slipBps: slip });
        if (my !== seq) return;
        L.q = q ? { ...q, din } : { kind: 'none', error: 'no pool', din };
      } catch (e) { if (my !== seq) return; L.q = { kind: 'none', error: e?.message || String(e), din }; }
      // a box ticked for this amount, pair and slippage stands through the lane's own refresh, unless the quote got worse
      const key = `${L.pay}>${L.get}:${din}:${slip}`, worse = L.ackFor && (L.q.kind !== 'direct' || L.q.minOut < L.ackFor.minOut || impact(L.q) > L.ackFor.impact + 1e-9);
      if (L.ackFor?.key !== key || worse) { L.ack = false; L.ackFor = null; }
      paint();
    };
    paint();
    if (now) run(); else qTimer = setTimeout(run, 300);
  }
  // How much worse the quote is than the pool's own price at its reserves (the swap's size moving the price, and the fee).
  const impact = (q) => {
    if (!q || q.kind !== 'direct') return 0;
    const spot = q.direction === 0 ? Number(q.reserveB) / Number(q.reserveA) : Number(q.reserveA) / Number(q.reserveB);
    const got = Number(q.deltaOut) / Number(q.din);
    return spot > 0 ? Math.max(0, 1 - got / spot) : 0;
  };

  // ── painting ──
  const coin = (aid) => `<svg class="tk" aria-hidden="true"><use href="#tk-${TOKENS[aid].icon}"/></svg>${TOKENS[aid].sym}`;
  function gate() {
    const din = amountBase(), q = L.q, bal = L.bal[L.pay];
    if (L.busy) return { label: 'Swapping…', off: true };
    if (!T) return { label: 'Loading…', off: true };
    if (L.noPool) return { label: 'No pool yet', off: true };
    if (!unlocked()) return { label: 'Open your Tacit wallet', act: 'unlock' };
    // The token to pay is held, bridged, at the Taproot address and the trading address has none (or too little): the way on is the move.
    const mv = bal != null && (bal === 0n || (din && din > bal)) ? readyNote(L.pay) : -1;
    if (mv >= 0) return { label: `Move your ${L.notes[mv].swap ? '' : 'bridged '}${TOKENS[L.pay].sym} first`, act: 'move', mv };
    if (!L.amt) return { label: 'Enter an amount', off: true };
    if (!din) return { label: 'Enter a valid amount', off: true };
    if (bal != null && din > bal) return { label: `Not enough ${TOKENS[L.pay].sym} on Bitcoin`, off: true };
    if (!q || q.din !== din) return { label: 'Getting a quote…', off: true };
    if (q.kind !== 'direct') return { label: q.kind === 'multihop' ? 'Not offered here' : 'No route', off: true };
    if (q.minOut < 1n) return { label: 'Too small', off: true };
    if (L.sats != null && L.need != null && L.sats < L.need) return { label: 'Add sats for the Bitcoin fees', act: 'fund' };
    if (impact(q) > IMPACT_ACK && !L.ack) return { label: 'Swap', off: true };
    return { label: 'Swap', act: 'swap' };
  }
  function paint() {
    if (!mounted) return;
    $('b-pay-coin').innerHTML = coin(L.pay); $('b-get-coin').innerHTML = coin(L.get);
    $('b-pay-coin').setAttribute('aria-label', `Pay with ${TOKENS[L.pay].sym}`); $('b-get-coin').setAttribute('aria-label', `Get ${TOKENS[L.get].sym}`);
    const bp = L.bal[L.pay], bg = L.bal[L.get];
    $('b-bal').textContent = !unlocked() ? '' : bp == null ? 'Reading your balance…' : `Balance ${tidy(fmt(bp, L.pay))} ${TOKENS[L.pay].sym}`;
    $('b-get-bal').textContent = !unlocked() || bg == null ? '' : `Balance ${tidy(fmt(bg, L.get))} ${TOKENS[L.get].sym}`;
    $('b-quick').innerHTML = bp > 0n ? [25, 50, 100].map((p) => `<button type="button" data-quick="${tidy(plain((bp * BigInt(p)) / 100n, TOKENS[L.pay].dec))}">${p === 100 ? 'Max' : `${p}%`}</button>`).join('') : '';
    $('b-slip').innerHTML = SLIPS.map((b) => `<button type="button" data-slip="${b}" aria-pressed="${slip === b}">${b / 100}%</button>`).join('');
    const q = L.q, out = $('b-out'), rc = $('b-rcpt');
    if (q?.kind === 'direct') {
      out.textContent = tidy(fmt(q.deltaOut, L.get)); out.classList.remove('ph');
      const imp = impact(q), px = (Number(q.deltaOut) / 10 ** TOKENS[L.get].dec) / (Number(q.din) / 10 ** TOKENS[L.pay].dec);
      rc.hidden = false;
      rc.innerHTML = [
        ['Price', `1 ${TOKENS[L.pay].sym} ≈ ${priceText(px)} ${TOKENS[L.get].sym}`, ''],
        ['At least', `${tidy(fmt(q.minOut, L.get))} ${TOKENS[L.get].sym}`, ''],
        ['Price impact', `${(imp * 100).toFixed(imp < 0.1 ? 1 : 0)}%`, imp > IMPACT_ACK ? 'err' : imp > IMPACT_WARN ? 'warn' : ''],
        ['Pool fee', `${(q.feeBps / 100).toFixed(2)}%`, ''],
        ['Pool holds', `${tidy(fmt(L.pool.a === TETH ? L.pool.ra : L.pool.rb, TETH))} tETH · ${tidy(fmt(L.pool.a === TAC ? L.pool.ra : L.pool.rb, TAC))} TAC`, ''],
        ...(q.pending ? [['In flight', `${q.pending} swap${q.pending > 1 ? 's' : ''} counted`, '']] : []),
        ['Settles', 'in the next Bitcoin block', ''],
      ].map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd${c ? ` class="${c}"` : ''}>${esc(v)}</dd></div>`).join('');
      const needAck = imp > IMPACT_ACK;
      $('b-ack').hidden = !needAck;
      $('b-acktext').textContent = `I accept ${(imp * 100).toFixed(0)}% less than the pool’s price.`;
      $('b-ackbox').checked = L.ack;
    } else {
      out.textContent = '0'; out.classList.add('ph'); $('b-ack').hidden = true;
      if (L.pool && !q) {
        rc.hidden = false;
        rc.innerHTML = `<div><dt>Pool holds</dt><dd>${esc(tidy(fmt(L.pool.a === TETH ? L.pool.ra : L.pool.rb, TETH)))} tETH · ${esc(tidy(fmt(L.pool.a === TAC ? L.pool.ra : L.pool.rb, TAC)))} TAC</dd></div><div><dt>Pool fee</dt><dd>${(L.pool.fee / 100).toFixed(2)}%</dd></div>`;
      } else rc.hidden = true;
    }
    paintBridged(); paintSent();
    const g = gate(), go = $('b-go');
    go.textContent = g.label; go.disabled = !!g.off; go.dataset.act = g.act || ''; go.dataset.mv = g.mv ?? '';
    if (!L.busy && !L.sent.length && !L.asking && !L.line && L.noPool) say('No tETH and TAC pool on Bitcoin yet.');
  }
  function paintBridged() {
    const box = $('b-brd');
    const rows = L.notes.map((n, i) => {
      const what = n.amount != null ? `${tidy(fmt(n.amount, n.aid))} ${TOKENS[n.aid].sym}` : `A note of ${TOKENS[n.aid].sym}`;
      if (L.asking === i) return `<div><span>Move ${esc(what)} to your trading address? One Bitcoin transaction, about ${moveNeed.toLocaleString('en-US')} sats in fees.</span> <button class="link" type="button" data-move-yes="${i}">Move</button> <button class="link" type="button" data-move-no>Cancel</button></div>`;
      const ready = n.amount != null && n.confirmed;
      return `<div><span>${esc(what)} ${n.swap ? 'from your swap' : 'you bridged'} sits at your Taproot address, which a swap does not spend from.${ready ? '' : ` <em>${esc(n.amount == null ? 'Its amount is not readable yet.' : 'Waiting for its Bitcoin confirmation.')}</em>`}</span>${ready && !L.busy ? ` <button class="link" type="button" data-move="${i}">Move to trade</button>` : ''}</div>`;
    });
    if (L.unread && !L.notes.length) rows.push('<div><span>Could not read part of your Taproot address. Try again in a moment.</span></div>');
    box.hidden = !rows.length; box.innerHTML = rows.join('');
  }

  // ── actions ──
  async function unlock() {
    try { await bitcoin.signIn(); } catch (e) { if (!e?.unlockCancelled) say(esc(e?.message || e), 'err'); return; }
    L.bridgedAt = 0; say(''); paint(); await readMe();
  }
  function fund() { bitcoin.fund(); }
  async function swap() {
    const q = L.q; if (!q || q.kind !== 'direct' || L.busy) return;
    const from = L.pay, to = L.get;
    L.busy = true; say(STAGES.check); paint();
    try {
      const r = await T.bitcoinSwap({ fromAid: from, toAid: to, amountIn: q.din, minOut: q.minOut, onProgress: (s) => { if (STAGES[s]) say(STAGES[s]); } });
      L.sent = keepSent([{ txid: r.revealTxid, from, to, floor: q.minOut, quoted: q.deltaOut, din: q.din, at: Date.now(), state: 'waiting', block: null }, ...L.sent]);
      saveSent();
      L.amt = ''; $('b-amt').value = ''; L.q = null; L.ack = false;
      say(''); follow();
    } catch (e) { say(esc(e?.message || e), 'err'); }
    finally { L.busy = false; paint(); }
    readMe(true);
  }
  // ── the swaps sent: each says where it is (waiting for a block, in one, filled, returned), and is followed until it is settled ──
  function saveSent() { try { localStorage.setItem(SENT_KEY, JSON.stringify(L.sent, (k, v) => (typeof v === 'bigint' ? String(v) : v))); } catch { /* storage is a convenience */ } }
  function paintSent() {
    const box = $('b-sent'); box.hidden = !L.sent.length;
    box.innerHTML = L.sent.map((s, i) => {
      const link = `<a href="${MEMPOOL}/tx/${esc(s.txid)}" target="_blank" rel="noopener noreferrer">${esc(s.txid.slice(0, 10))}…↗</a>`;
      const waiting = s.state === 'waiting', gone = waiting && s.gone && Date.now() - s.at > 10 * 60e3;
      const head = s.state === 'filled' ? 'Filled' : s.state === 'refunded' ? 'Returned' : gone ? 'Not showing on mempool.space' : s.block ? `In block ${s.block}` : 'Waiting for a Bitcoin block';
      const what = s.state === 'refunded' ? `${s.refund == null ? 'about ' : ''}${tidy(fmt(s.refund ?? s.din, s.from))} ${sym(s.from)} back`
        : `${tidy(fmt(s.din, s.from))} ${sym(s.from)} → ${waiting || (s.state === 'filled' && s.got == null) ? 'about ' : ''}${tidy(fmt(s.state === 'filled' ? s.got ?? s.quoted : s.quoted, s.to))} ${sym(s.to)}`;
      const note = gone ? 'If it was dropped, nothing was spent. Quote it again to retry.' : waiting ? `${s.block ? 'The pool settles it.' : `Sent ${ageText(s.at)}.`} At least ${tidy(fmt(s.floor, s.to))} ${sym(s.to)}, or your ${sym(s.from)} comes back.` : s.state === 'refunded' ? `${refundWhy(s.reason)} Quote it again to retry.` : '';
      return `<div class="${gone ? 'warn' : waiting ? 'wait' : s.state === 'filled' ? 'ok' : 'warn'}"><span><i class="dot" aria-hidden="true"></i><b>${esc(head)}</b></span><span>${link}${waiting && !gone ? '' : ` <button class="link" type="button" data-dismiss="${i}" aria-label="Dismiss">×</button>`}</span><span class="what">${esc(what)}</span>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
    }).join('');
  }
  async function check(s) {
    const [o, w] = await Promise.all([T.bitcoinSwapOutcome(s.txid), whereIs(s.txid)]);
    if (w) { s.gone = !!w.gone; s.block = w.gone ? null : w.block; }
    if (o.state === 'filled') { Object.assign(s, { state: 'filled', got: o.got }); notify('Swap filled'); L.bridgedAt = 0; readMe(true); }
    else if (o.state === 'refunded') { Object.assign(s, { state: 'refunded', refund: o.refund, reason: o.reason }); notify('Swap returned'); readMe(true); }
  }
  function follow(wait = 15e3) {
    clearTimeout(poll);
    if (!T || !L.open || !L.sent.some((s) => s.state === 'waiting')) return;
    poll = setTimeout(async () => {
      // a tab in the background asks nothing of the explorer or the pool: the swaps are looked at again once it is seen
      if (!document.hidden) { await Promise.all(L.sent.filter((s) => s.state === 'waiting').map((s) => check(s).catch(() => {}))); saveSent(); paintSent(); }
      follow();
    }, wait);
  }
  const readMoveNeed = async () => { moveNeed = await moveSatsNeeded(() => T?.getFeeRate()); };      // the commit and reveal at the fee rate now
  async function move(i) {
    const n = L.notes[i]; if (!n || L.busy) return;
    L.busy = true;                                                         // before the fee is read: a second press while it is read moves nothing
    try {
      await readMoveNeed();
      if (L.sats != null && L.sats < moveNeed) { L.asking = null; say(`Moving takes about ${moveNeed.toLocaleString('en-US')} sats for the Bitcoin fee, paid from the sats at your trading address. Add sats, then try again.`, 'err'); fund(); return; }
      L.asking = null; say('Moving it to your trading address…'); paint();
      await T.moveBridgedNote({ txid: n.txid, vout: n.vout ?? 0, assetIdHex: n.aid, swap: !!n.swap, onProgress: (s) => say(s === 'reveal-start' ? 'Sending the second transaction…' : 'Sending the first transaction…') });
      say(`Moved ${esc(tidy(fmt(n.amount, n.aid)))} ${TOKENS[n.aid].sym}. It shows in your balance after the next Bitcoin block.`, 'ok');
      // (the list may have been read again meanwhile, so the note is found by its coin, not by its place in the list)
      L.notes = L.notes.filter((x) => !(x.txid === n.txid && (x.vout ?? 0) === (n.vout ?? 0) && x.aid === n.aid));
      keepBridged(bitcoin.session.key?.pubHex, n.aid === TETH ? 'teth' : 'tac', { notes: L.notes.filter((x) => x.aid === n.aid), unread: L.unread });
      onBridged();
    } catch (e) { say(esc(/insufficient sats/i.test(e?.message || '') ? `You need about ${moveNeed.toLocaleString('en-US')} sats at your trading address for the fee. Add sats, then try again.` : (e?.message || e)), 'err'); }
    finally { L.busy = false; L.bridgedAt = 0; paint(); }
  }

  // ── events ──
  const setAmt = (v) => { L.amt = v; if (L.cls === 'err' && !L.busy) say(''); requote(); };
  host.addEventListener('input', (e) => { if (e.target.id === 'b-amt') setAmt(e.target.value.trim()); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'b-amt' && !$('b-go').disabled) $('b-go').click(); });
  host.addEventListener('change', (e) => { if (e.target.id === 'b-ackbox') { L.ack = e.target.checked; L.ackFor = L.ack && L.q ? { key: `${L.pay}>${L.get}:${L.q.din}:${slip}`, minOut: L.q.minOut, impact: impact(L.q) } : null; paint(); } });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#b-flip')) { [L.pay, L.get] = [L.get, L.pay]; L.amt = ''; $('b-amt').value = ''; L.q = null; seq++; L.ack = false; if (L.cls === 'err' && !L.busy) say(''); paint(); return; }
    const dm = t.closest('[data-dismiss]'); if (dm) { L.sent.splice(Number(dm.dataset.dismiss), 1); saveSent(); paintSent(); return; }
    const sl = t.closest('[data-slip]'); if (sl) { slip = Number(sl.dataset.slip); try { localStorage.setItem(SLIP_KEY, String(slip)); } catch { /* storage is a convenience */ } requote(true); return; }
    const qk = t.closest('[data-quick]'); if (qk) { $('b-amt').value = qk.dataset.quick; setAmt(qk.dataset.quick); return; }
    const mv = t.closest('[data-move]'); if (mv) { L.asking = Number(mv.dataset.move); paint(); readMoveNeed().then(() => { if (L.asking != null) paint(); }); return; }
    const yes = t.closest('[data-move-yes]'); if (yes) { move(Number(yes.dataset.moveYes)); return; }
    if (t.closest('[data-move-no]')) { L.asking = null; paint(); return; }
    if (t.closest('#b-go')) { const a = $('b-go').dataset.act; if (a === 'unlock') unlock(); else if (a === 'fund') fund(); else if (a === 'swap') swap(); else if (a === 'move') { L.asking = Number($('b-go').dataset.mv); paint(); readMoveNeed().then(() => { if (L.asking != null) paint(); }); } }
  });

  return {
    // The lane opens: tacit.js loads (once), the pool is read, and a key that is already open is read for its balances.
    async show() {
      L.open = true; mounted = true; paint();
      if (!T) say('Loading…');
      try { await ensure(); await readPool(); } catch (e) { say(`Could not load the Bitcoin lane: ${esc(e?.message || e)}`, 'err'); return; }
      if (L.line === 'Loading…') say('');
      paint(); requote(true); readMe(); follow(1e3);
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => { if (!document.hidden && L.open) { readPool().then(() => requote(true, true)).catch(() => {}); readMe(true); } }, 45e3);
    },
    hide() { L.open = false; clearInterval(refreshTimer); clearTimeout(poll); },
    // the side it pays from, as the page names it ('teth' or 'tac'): the other is what it gets
    pair(f) {
      const pay = f === 'tac' ? TAC : TETH;
      if (L.pay === pay || L.busy) return;
      [L.pay, L.get] = [L.get, L.pay]; L.amt = ''; $('b-amt').value = ''; L.q = null; seq++; L.ack = false;
      if (L.open) { paint(); requote(true); }
    },
    get unlocked() { return unlocked(); },
  };
}
