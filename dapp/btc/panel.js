// "Your Bitcoin" on /btc/: the Tacit wallet's own Bitcoin address, what it holds, and a send of it to any address. The lane (swap/atomic.js) opens the key and the
// pair client; its `bitcoin()` (fast/pair-wire.js) reads the coins and the fee estimates, signs with the key and broadcasts. What a send is and costs is btc/send.js.
//
// A send is: an address (checked here, mainnet only), an amount or Max, a fee rate (the explorers' estimates for the next block, about half an hour, about an
// hour), then a review of exactly what will be signed, then the signature and the broadcast. No coin of a swap under way is spent, nor one a note may ride on.
import { parseAddress, spendable, planSend, signSend, holdingOutpoints, outputScript, scriptHex, DUST, vsizeOf } from '/btc/send.js?cb=990d748a';
import { esc, fmtUnits, parseUnits, plain } from '/trade/util.js?cb=9c8b4133';

const SENT_KEY = 'tacit-btc-sent-v1:';
const EXPLORER = 'https://mempool.space/tx/';
const STATUS_MS = 30000;
const TIERS = [['fast', 'Fast', 'next block'], ['normal', 'Normal', 'about 30 min'], ['slow', 'Slow', 'about an hour']];
const sats = (v) => `${BigInt(v).toLocaleString('en-US')} sats`;
const btc = (v) => { const s = plain(BigInt(v), 8); return s.includes('.') ? s : `${s}`; };
const tidyBtc = (v) => `${btc(v)} BTC`;

export function mountSendPanel({ host, lane, notify = () => {} }) {
  const $ = (id) => host.querySelector(`#${id}`);
  const S = { open: false, rates: null, ratesAt: 0, ratesP: null, tier: 'normal', max: false, plan: null, review: null, busy: false, sent: [], timer: 0, coins: null, heldSats: 0n };
  host.innerHTML = `
    <p class="sec-say" id="yb-say">Open your Tacit wallet above to see its Bitcoin address.</p>
    <div class="box yb" id="yb-box" hidden>
      <div class="yb-row"><span class="k">Address</span><code class="yb-addr" id="yb-addr"></code><button class="btn" type="button" id="yb-copy">Copy</button></div>
      <div class="yb-row"><span class="k">Balance</span><b class="num" id="yb-bal">…</b><button class="btn" type="button" id="yb-send" aria-expanded="false" aria-controls="yb-form">Send BTC</button></div>
      <p class="yb-note" id="yb-held" hidden></p>
      <form class="yb-form" id="yb-form" hidden novalidate>
        <label class="yb-f"><span>To</span><input id="yb-to" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="bc1q…, bc1p…, 1… or 3…" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" aria-describedby="yb-to-say"></label>
        <p class="yb-say" id="yb-to-say" role="status"></p>
        <label class="yb-f"><span>Amount</span><span class="yb-amt"><input id="yb-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" aria-describedby="yb-amt-say"><i>BTC</i><button class="btn" type="button" id="yb-max">Max</button></span></label>
        <p class="yb-say" id="yb-amt-say" role="status"></p>
        <fieldset class="yb-fee" id="yb-fee"><legend>Network fee</legend><div id="yb-tiers"></div></fieldset>
        <div class="row yb-go"><button class="btn main" type="submit" id="yb-review">Review</button><button class="btn" type="button" id="yb-cancel">Cancel</button></div>
        <p class="yb-say" id="yb-form-say" role="status"></p>
      </form>
      <div class="yb-rv" id="yb-rv" hidden>
        <p class="yb-h">Check it. A Bitcoin payment cannot be undone.</p>
        <dl class="yb-dl" id="yb-dl"></dl>
        <div class="row yb-go"><button class="btn main" type="button" id="yb-sign">Sign and send</button><button class="btn" type="button" id="yb-back">Back</button></div>
        <p class="yb-say" id="yb-rv-say" role="status"></p>
      </div>
      <ul class="yb-sent" id="yb-sent"></ul>
    </div>`;

  // the open key's `bitcoin`; while the lane opens its pair client again for the same key (it does when the key's session stirs), the one it had stays in use,
  // so the panel keeps showing the address, the balance and what was sent rather than going back to reading the address
  let last = null, lastBal = null;
  const bitcoin = () => {
    const b = lane.bitcoin();
    if (b) { last = { b, key: lane.key }; return b; }
    return lane.unlocked && last && lane.key != null && last.key === lane.key ? last.b : null;
  };
  const own = () => bitcoin()?.address || null;
  const say = (id, h, cls = '') => { const el = $(id); el.className = `yb-say${cls ? ` ${cls}` : ''}`; el.innerHTML = h; };

  // ── what was sent from this address, kept in this browser, with each one's status read again until it confirms ──
  const sentKey = () => SENT_KEY + (own() || '');
  const readSent = () => { try { const a = JSON.parse(localStorage.getItem(sentKey()) || '[]'); return Array.isArray(a) ? a.filter((x) => /^[0-9a-f]{64}$/.test(x?.txid || '')) : []; } catch { return []; } };
  const keepSent = () => { try { localStorage.setItem(sentKey(), JSON.stringify(S.sent.slice(0, 10))); } catch { /* a convenience */ } };
  function paintSent() {
    $('yb-sent').innerHTML = S.sent.map((x) => `<li class="${x.conf ? 'ok' : 'wait'}"><span><i class="dot" aria-hidden="true"></i><b>${x.conf ? 'Confirmed' : 'Waiting for a confirmation'}</b> · ${esc(tidyBtc(x.sats))} to <span class="yb-a">${esc(x.to)}</span></span><a href="${EXPLORER}${esc(x.txid)}" target="_blank" rel="noopener noreferrer">${esc(x.txid.slice(0, 10))}…↗</a></li>`).join('');
  }
  async function readStatus() {
    clearTimeout(S.timer);
    const b = bitcoin(), open = S.sent.filter((x) => !x.conf);
    if (!b || !open.length) return;
    for (const x of open) {
      try { const st = await b.status(x.txid); if (st.confirmations > 0) { x.conf = true; lane.refresh?.(); } } catch { /* the next pass */ }
    }
    keepSent(); paintSent();
    if (S.sent.some((x) => !x.conf)) S.timer = setTimeout(readStatus, STATUS_MS);
  }

  // ── the panel ──
  let shownFor = null;
  function paint() {
    const b = bitcoin(), on = !!(lane.unlocked && b);
    $('yb-box').hidden = !on;
    $('yb-say').hidden = on;
    if (!on) { $('yb-say').textContent = lane.unlocked ? 'Reading your Bitcoin address…' : 'Open your Tacit wallet above to see its Bitcoin address.'; if (!lane.unlocked) close(); return; }
    $('yb-addr').textContent = b.address;
    // (the fee estimates are read as soon as the address shows, so a send has them when its form opens)
    if (shownFor !== b.address) { shownFor = b.address; S.sent = readSent(); paintSent(); readStatus(); S.rates = null; readRates().catch(() => {}); }
    // (the balance last read for this key stays until the next read lands, as the address does)
    const now = lane.balances();
    if (now.sats != null) lastBal = { bal: now, key: lane.key };
    const bal = now.sats == null && lastBal && lastBal.key === lane.key ? lastBal.bal : now;
    $('yb-bal').textContent = bal.sats == null ? 'reading…' : `${tidyBtc(bal.sats)}${bal.pending > 0n ? ` · ${tidyBtc(bal.pending)} confirming` : ''}`;
    $('yb-send').disabled = bal.sats == null || bal.sats <= DUST;
  }

  // the coins a send may take, read fresh: confirmed plain-sat coins, less those a swap under way holds and those a note may ride on (tacit.js's holdings scan;
  // a scan that cannot be read stops the send, as tacit.js's own sats send stops)
  async function readCoins() {
    const b = bitcoin();
    const [c, held] = await Promise.all([b.coins(), b.held().then((h) => new Set(h), () => null)]);
    if (!held) throw new Error('The swaps under way could not be read just now, so nothing is sent. Try again in a moment.');
    let notes = new Set();
    if (b.holdings) {
      const h = await b.holdings().catch(() => null);
      if (!(h instanceof Map)) throw new Error('Your coins could not be checked just now, so nothing is sent. Try again in a moment.');
      notes = holdingOutpoints(h);
    }
    const all = (c && c.coins) || [];
    const coins = spendable(all, { held, holdings: notes });
    const heldSats = all.filter((x) => held.has(`${x.txid}:${x.vout}`)).reduce((s, x) => s + BigInt(x.value), 0n);
    return { coins, heldSats };
  }
  // (one read at a time: the form opened while the first read is out waits for that one)
  function readRates() {
    if (S.rates && Date.now() - S.ratesAt < 60000) return Promise.resolve(S.rates);
    if (S.ratesP) return S.ratesP;
    const b = bitcoin();
    const p = S.ratesP = (async () => {
      const r = await b.feeRates();
      if (!r || (!r.fast && !r.normal && !r.slow)) throw new Error('The fee estimates could not be read just now. Try again in a moment.');
      // a slower tier never asks more than a faster one; one that did not answer takes the next answer up
      const fast = r.fast || r.normal || r.slow, normal = Math.min(r.normal || fast, fast), slow = Math.min(r.slow || normal, normal);
      S.rates = { fast, normal, slow }; S.ratesAt = Date.now();
      return S.rates;
    })().finally(() => { if (S.ratesP === p) S.ratesP = null; if (S.open) paintTiers(); });
    return p;
  }
  const rateNow = () => S.rates?.[S.tier] || null;

  function paintTiers() {
    const to = parseAddress($('yb-to').value), len = to.ok ? to.script.length : 22;
    $('yb-tiers').innerHTML = TIERS.map(([k, name, when]) => {
      const r = S.rates?.[k];
      const p = r && S.coins ? (S.max ? planSend({ coins: S.coins, max: true, rate: r, scriptLen: len }) : amountSats() ? planSend({ coins: S.coins, amount: amountSats(), rate: r, scriptLen: len }) : null) : null;
      const fee = p && !p.error ? p.fee : r ? BigInt(vsizeOf(1, [len, 22])) * BigInt(r) : null;
      return `<label class="yb-t"><input type="radio" name="yb-tier" value="${k}"${S.tier === k ? ' checked' : ''}${r ? '' : ' disabled'}><span><b>${name}</b><small>${when}</small><small class="num">${r ? `${r} sat/vB · ${p && !p.error ? '' : 'about '}${sats(fee)}` : S.ratesP ? 'reading…' : 'not read'}</small></span></label>`;
    }).join('');
  }
  const amountSats = () => { const v = parseUnits($('yb-amt').value.trim(), 8); return v && v > 0n ? v : null; };

  // the address as typed: refused when it is not a mainnet address, or is one of this key's swap locks; a send to the wallet's own address is said, not refused
  let locks = null;
  async function lockScripts() {
    if (locks) return locks;
    const out = new Set();
    for (const l of (await bitcoin().locks().catch(() => [])) || []) { const s = l.spk || (l.hex ? outputScript(l.hex, l.vout) : null); if (s) out.add(String(s).toLowerCase()); }
    return (locks = out);
  }
  async function checkTo(final = false) {
    const raw = $('yb-to').value.trim();
    if (!raw) { say('yb-to-say', final ? 'Enter a Bitcoin address.' : '', final ? 'err' : ''); return null; }
    const a = parseAddress(raw);
    if (!a.ok) { if (final || raw.length >= 26) say('yb-to-say', esc(a.why), 'err'); else say('yb-to-say', ''); return null; }
    if ((await lockScripts()).has(scriptHex(a.script))) { say('yb-to-say', 'That is the address of one of your own swap locks. Bitcoin sent there is not simply yours again. Use another address.', 'err'); return null; }
    if (a.address === own()) say('yb-to-say', 'That is this wallet’s own address: the send comes back here, less the fee.', 'warn');
    else say('yb-to-say', '');
    return a;
  }
  function checkAmt(final = false) {
    const t = $('yb-amt').value.trim();
    if (S.max) { say('yb-amt-say', ''); return true; }
    if (!t) { say('yb-amt-say', final ? 'Enter an amount.' : ''); return null; }
    const v = amountSats();
    if (v == null) { say('yb-amt-say', 'Enter an amount in BTC, up to 8 decimals.', 'err'); return null; }
    if (v < DUST) { say('yb-amt-say', `Bitcoin does not carry payments under ${sats(DUST)}.`, 'err'); return null; }
    say('yb-amt-say', `${sats(v)}`);
    return v;
  }

  async function open() {
    if (S.open) return;
    S.open = true; S.max = false; locks = null;
    $('yb-form').hidden = false; $('yb-rv').hidden = true; $('yb-send').setAttribute('aria-expanded', 'true');
    say('yb-form-say', 'Checking your coins…');
    paintTiers();
    $('yb-to').focus();
    // the coins are read while the fee estimates finish (they were asked for when the address showed)
    const rates = readRates();
    rates.catch(() => {});
    try {
      const { coins, heldSats } = await readCoins();
      S.coins = coins; S.heldSats = heldSats;
      $('yb-held').hidden = !(heldSats > 0n);
      $('yb-held').textContent = heldSats > 0n ? `${tidyBtc(heldSats)} of it is in a swap under way, and is not sent from here.` : '';
      paintTiers();
      if (!S.rates) say('yb-form-say', 'Reading the fee estimates…');
      await rates;
      say('yb-form-say', '');
      paintTiers();
    } catch (e) { say('yb-form-say', esc(e.message || 'Could not read your coins just now.'), 'err'); }
  }
  function close() {
    S.open = false; S.review = null; S.max = false; S.busy = false;
    $('yb-form').hidden = true; $('yb-rv').hidden = true; $('yb-send').setAttribute('aria-expanded', 'false');
    $('yb-to').value = ''; $('yb-amt').value = '';
    for (const id of ['yb-to-say', 'yb-amt-say', 'yb-form-say', 'yb-rv-say']) say(id, '');
  }

  async function review() {
    if (S.busy) return;
    const to = await checkTo(true), amt = checkAmt(true);
    if (!to || !amt) return;
    S.busy = true; $('yb-review').disabled = true;
    say('yb-form-say', 'Checking your coins…');
    try {
      await readRates();
      const { coins, heldSats } = await readCoins();
      S.coins = coins; S.heldSats = heldSats;
      const rate = rateNow();
      if (!rate) throw new Error('Choose a fee.');
      const plan = S.max ? planSend({ coins, max: true, rate, scriptLen: to.script.length }) : planSend({ coins, amount: amountSats(), rate, scriptLen: to.script.length });
      if (plan.error === 'short' || plan.error === 'empty') {
        const have = coins.reduce((s, c) => s + BigInt(c.value), 0n);
        throw new Error(S.max ? `Your coins (${sats(have)}) do not cover the fee of sending them at ${rate} sat/vB.` : `That is more than you can send: you hold ${sats(have)}${plan.need ? `, and this needs ${sats(plan.need)} with the fee` : ''}.`);
      }
      if (plan.error) throw new Error('That amount cannot be sent.');
      S.review = { plan, to, at: Date.now() };
      const rows = [
        ['To', `<span class="yb-a">${esc(to.address)}</span>`],
        ['Amount', `${esc(tidyBtc(plan.send))} <small>(${esc(sats(plan.send))})</small>`],
        ['Network fee', `${esc(sats(plan.fee))} <small>(${plan.rate} sat/vB, ${plan.vsize} vB${plan.extra > 0n ? `, with ${esc(sats(plan.extra))} too small to return as change` : ''})</small>`],
        ['Leaves your balance', `${esc(sats(plan.send + plan.fee))}`],
        ['Change back to you', plan.change > 0n ? esc(sats(plan.change)) : 'none'],
        ['Coins spent', `${plan.inputs.length}`],
        ['Speed up later', 'yes (replace-by-fee)'],
      ];
      $('yb-dl').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
      if (to.address === own()) $('yb-dl').insertAdjacentHTML('beforeend', '<div><dt>Note</dt><dd class="warn">This is your own address.</dd></div>');
      $('yb-form').hidden = true; $('yb-rv').hidden = false; say('yb-rv-say', ''); say('yb-form-say', '');
      $('yb-sign').focus();
    } catch (e) { say('yb-form-say', esc(e.message || 'Could not plan the send.'), 'err'); }
    finally { S.busy = false; $('yb-review').disabled = false; }
  }

  async function signAndSend() {
    const r = S.review;
    if (!r || S.busy) return;
    if (Date.now() - r.at > 10 * 60e3) { say('yb-rv-say', 'This review is more than ten minutes old. Go back and review it again.', 'err'); return; }
    S.busy = true; $('yb-sign').disabled = true; $('yb-back').disabled = true;
    say('yb-rv-say', 'Checking the coins once more…');
    try {
      // a coin a swap took since the review is not signed for
      const held = new Set(await bitcoin().held());
      if (r.plan.inputs.some((c) => held.has(`${c.txid}:${c.vout}`))) throw new Error('A swap started with some of these coins. Nothing was sent. Go back and review it again.');
      const signed = signSend({ prims: bitcoin().prims, plan: r.plan, script: r.to.script });
      say('yb-rv-say', 'Sending…');
      await bitcoin().broadcast(signed.hex);
      S.sent.unshift({ txid: signed.txid, to: r.to.address, sats: String(r.plan.send), fee: String(r.plan.fee), at: Math.floor(Date.now() / 1000), conf: false });
      keepSent(); paintSent();
      notify('Bitcoin sent');
      close();
      lane.refresh?.();
      readStatus();
    } catch (e) {
      say('yb-rv-say', esc(/broadcast refused/.test(String(e?.message)) ? `The explorers refused it: ${String(e.message).replace(/^broadcast refused:\s*/, '').slice(0, 140)}. Nothing was sent.` : e?.message || 'It could not be sent. Nothing was sent.'), 'err');
    } finally { S.busy = false; $('yb-sign').disabled = false; $('yb-back').disabled = false; }
  }

  // ── events ──
  $('yb-copy').addEventListener('click', () => { const a = own(); if (!a) return; navigator.clipboard?.writeText(a).then(() => { $('yb-copy').textContent = 'Copied'; setTimeout(() => { $('yb-copy').textContent = 'Copy'; }, 1500); }, () => { $('yb-copy').textContent = 'Select it'; }); });
  $('yb-send').addEventListener('click', () => { if (S.open) close(); else open(); });
  $('yb-cancel').addEventListener('click', close);
  $('yb-back').addEventListener('click', () => { if (S.busy) return; S.review = null; $('yb-rv').hidden = true; $('yb-form').hidden = false; });
  $('yb-sign').addEventListener('click', signAndSend);
  $('yb-form').addEventListener('submit', (e) => { e.preventDefault(); review(); });
  $('yb-to').addEventListener('input', () => { checkTo(false); paintTiers(); });
  $('yb-to').addEventListener('blur', () => { if ($('yb-to').value.trim()) checkTo(true); });
  $('yb-amt').addEventListener('input', () => { S.max = false; checkAmt(false); paintTiers(); });
  $('yb-max').addEventListener('click', () => {
    const r = rateNow(), to = parseAddress($('yb-to').value);
    if (!S.coins || !r) return;
    const p = planSend({ coins: S.coins, max: true, rate: r, scriptLen: to.ok ? to.script.length : 22 });
    if (p.error) { say('yb-amt-say', 'Your coins do not cover the fee of sending them at this rate.', 'err'); return; }
    S.max = true; $('yb-amt').value = btc(p.send); say('yb-amt-say', `${sats(p.send)}: all you can send, after the fee`);
    paintTiers();
  });
  $('yb-tiers').addEventListener('change', (e) => {
    if (e.target.name !== 'yb-tier') return;
    S.tier = e.target.value;
    // Max follows the fee: a dearer fee leaves less to send
    if (S.max) $('yb-max').click(); else paintTiers();
  });

  // The send opened from a finished swap: the amount that arrived filled in, or Max when the coins do not cover that and the fee (the swap's BTC is the
  // address's only coin, as it is for a new wallet). The address is left to the sender.
  async function openSend({ sats = null } = {}) {
    if (!bitcoin()) return;
    if (!S.open) await open();
    host.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    $('yb-to').focus({ preventScroll: true });
    const want = sats != null ? BigInt(sats) : null;
    if (!want || !S.coins) return;
    const r = rateNow(), have = S.coins.reduce((s, c) => s + BigInt(c.value), 0n);
    const p = r ? planSend({ coins: S.coins, amount: want, rate: r, scriptLen: 22 }) : null;
    if (r && (want >= have || (p && p.error === 'short'))) { $('yb-max').click(); return; }
    S.max = false; $('yb-amt').value = btc(want); checkAmt(false); paintTiers();
  }

  return { paint, openSend };
}
