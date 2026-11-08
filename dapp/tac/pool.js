// TAC's shielded pool on Bitcoin, drawn into a page that holds an open Tacit key: TAC shielded from the key's Bitcoin address, paid
// privately (to a Tacit or bp1 address, or to a claim link), combined, withdrawn to the Bitcoin address or sold for sats (sats.js),
// received, and claimed from a link someone sent. The page keeps the key; this asks for it through `ctx` and stores none of it.
//
//   const tp = makeTacPool(ctx);
//   tp.mount(host)                 its tabs, drawn once into `host` (the page may move the host; it keeps its state)
//   tp.show('send')                a tab: 'shield' | 'send' | 'withdraw' | 'receive' (tp.show('withdraw', 'sats') for To sats)
//   tp.claim(box, '#tacclaim=…')   a claim link's panel, drawn into `box`
//   tp.keyChanged()                the page's key was opened, switched or locked
//   tp.totals()                    { shielded, public } in TAC units (1e-8), null until read
//   tp.pay(to, amount)             Send, filled with a payment the page took and pressed
//   tp.fees(), tp.poolAddress(), tp.scan(report), tp.stats()   the relay's fee, the key's bp1… address, Scan for payments, the pool's figures
//
// ctx: key() → { pubHex } | null; priv() → the open key's bytes; ensureKey() returns with a key open, or shows the page's sign-in and throws
// a quiet error; withKey(fn) → fn(T), tacit.js with the key in its wallet (the page's own turn of it); tacitAddress() → 'tacit1…' | null;
// toast(msg, bad). Optional: hold(btn, fn), the page's own busy press around fn; changed(what), the pool's balance moved ('bitcoin': the
// key's TAC on Bitcoin too); viewChanged(), a tab was picked; usd(sats) → '$…' | ''; mods: { secret, claim, sats }, the modules themselves, where they are not to be
// loaded by their URLs (a test's stubs).

const SECRET_URL = '/sats/secret.js?cb=d10eac01';
const SATS_URL = '/tac/sats.js?cb=37cf5ec2';
const CLAIM_URL = '/tac/claim.js?cb=dc513e91';
const WORKER = 'https://api.tacit.finance';
const ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const DECIMALS = 8;
const CLAIM_LINKS = 'tacit-tac-claim-links-v1';
export const TABS = [['shield', 'Shield'], ['send', 'Send'], ['withdraw', 'Withdraw'], ['receive', 'Receive']];
// A claim link, in a page's fragment (`#tacclaim=p1.…`, tac/claim.js)
export const CLAIM_HASH = /(?:^#?|&)tacclaim=[^&\s]+/;

export const fmt = (units, d = DECIMALS) => {
  const s = BigInt(units).toString().padStart(d + 1, '0');
  const whole = s.slice(0, -d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-d).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
const fmtPlain = (units, d = DECIMALS) => {
  const s = BigInt(units).toString().padStart(d + 1, '0');
  const frac = s.slice(-d).replace(/0+$/, '');
  return frac ? `${s.slice(0, -d)}.${frac}` : s.slice(0, -d);
};
export function parseAmount(s, dec = 8) {
  let t = String(s || '').trim();
  if (t.includes(',')) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(t) && (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(','))) t = t.replace(/,/g, '');
    else if (/^\d*,\d*$/.test(t) && !/^[1-9]\d{0,2},\d{3}$/.test(t)) t = t.replace(',', '.');
    else return null;
  }
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  if (f.length > dec) return null;
  return BigInt(w || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
const amountWhy = (t, dec) => (t.includes(',') ? 'Write 1500 for fifteen hundred, or 1,5 for a decimal comma.' : /^\d*\.?\d*$/.test(t) ? `Up to ${dec} decimals.` : 'Numbers only.');
const parseUnits = (str, d = DECIMALS) => {
  const t = String(str || '').trim(), v = parseAmount(t, d);
  if (v == null) throw new Error(t ? amountWhy(t, d) : 'Enter an amount above zero.');
  return v;
};
const blocksText = (n) => `${n} more Bitcoin block${n === 1 ? '' : 's'} (≈ ${n * 10} min)`;
const short = (a, n = 4) => { if (!a) return ''; const head = /^tacit1/.test(a) ? 10 + n : n + 2; return a.length > head + n + 2 ? `${a.slice(0, head)}…${a.slice(-n)}` : a; };
// A relayed payment can come back without its id (the relay says it posted, not in which transaction): it went out in the relay's batch.
const txLink = (txid) => {
  if (!txid) return document.createTextNode('the relay’s batch');
  const a = document.createElement('a');
  a.href = `https://mempool.space/tx/${txid}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = `${txid.slice(0, 10)}…`;
  return a;
};
const lc = (s) => String(s || '').toLowerCase();
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
class Raw { constructor(s) { this.s = s; } }
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : String(v).replace(/[&<>"']/g, (c) => escMap[c]));
const html = (strs, ...vals) => new Raw(strs.reduce((a, s, i) => a + part(vals[i - 1]) + s));
const said = (msg, extra = {}) => Object.assign(new Error(msg), { said: true, ...extra });
const copyText = (t) => (navigator.clipboard?.writeText ? navigator.clipboard.writeText(t).then(() => true, () => false) : Promise.resolve(false));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));

export function errText(e) {
  if (e?.said) return e.message;
  const m = String(e?.shortMessage || e?.message || e || 'Something went wrong');
  if (e?.code === 4001 || /user (rejected|denied)|rejected the request|denied transaction|no wallet selected/i.test(m)) return 'Cancelled in your wallet.';
  if (e?.unlockCancelled || e?.name === 'NotAllowedError') return 'Cancelled.';
  if (/insufficient sats|no plain-sats|not enough (?:signet )?sats/i.test(m)) return 'Not enough BTC at your Bitcoin address for this and its network fee.';
  if (/two notes cannot cover/i.test(m)) return 'One payment spends two of your notes at most. Combine them first, then pay again.';
  if (/no spendable notes/i.test(m)) return 'Nothing in your shielded balance can be spent yet: a payment you just made is still settling.';
  if (/\bHTTP 5\d\d\b/.test(m)) return 'The service is busy. Try again in a moment.';
  if (e?.name === 'QuotaExceededError' || e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || /^the quota has been exceeded\.?$|^failed to execute 'setItem' on 'storage'/i.test(m)) return 'Could not save this in your browser. Its storage for this site is full. Free up space on this device or clear old site data, then try again.';
  if (/failed to fetch|networkerror|load failed|all rpcs failed/i.test(m)) return 'Could not reach the network. Check your connection and try again.';
  if (/rate.?limit|too many requests|\b429\b|exceeded.*(?:request|quota)|upgrade.*(?:plan|tier)/i.test(m)) return 'That network is busy. Try again in a moment.';
  if (/timed? ?out|timeout/i.test(m)) return 'The network did not answer. Try again in a moment.';
  const t = m.replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay');
  if (t.length <= 240) return t;
  const cut = t.slice(0, 240), end = cut.lastIndexOf('. ');
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// The claim links this device made, by their secrets (the only copy of a link the relay posted without saying where)
function claimLinks() {
  try {
    const v = JSON.parse(localStorage.getItem(CLAIM_LINKS) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && /^[0-9a-f]{64}$/.test(x.secret)) : [];
  } catch { return []; }
}

export function makeTacPool(ctx) {
  let S = null, T = null, C = null;
  let host = null, tab = 'shield', wTab = 'self';
  let pw = null, pwPub = null;
  let pub = { loading: false, notes: [], read: false }, shielded = { loading: false, notes: [], read: false };
  let relayLive = null, relayFee = null, relayP = null, markSats = null, priceP = null;
  let busyId = null, afterBusy = null, stealthScanned = false, satsMounted = false;
  let feedKept = null, shieldedP = null;

  const q = (id) => host?.querySelector(`#${id}`) || document.getElementById(id);
  const mods = ctx.mods || {};
  const loadSecret = () => (S ? Promise.resolve(S) : (mods.secret ? Promise.resolve(mods.secret) : import(SECRET_URL)).then((m) => (S = m)));
  const loadClaim = () => (C ? Promise.resolve(C) : (mods.claim ? Promise.resolve(mods.claim) : import(CLAIM_URL)).then((m) => (C = m)));
  const unlocked = () => !!ctx.key();
  // the pool wallet of the key open now (derived once a key)
  function wallet() {
    const k = ctx.key();
    if (!k || !S) return null;
    if (pwPub !== k.pubHex) { pwPub = k.pubHex; pw = S.poolWalletFor(ctx.priv(), 'mainnet'); }
    return pw;
  }
  // the key open, the modules loaded and tacit.js's wallet holding the key, for a press
  async function ready() {
    await ctx.ensureKey();
    await loadSecret();
    T = await ctx.withKey((t) => t);
    if (!wallet()) throw said('Open your Tacit wallet first.', { quiet: true });
    return T;
  }

  function say(id, ...nodes) {
    const el = q(id);
    if (!el) return;
    el.replaceChildren(...nodes.filter((n) => n != null).map((n) => (typeof n === 'string' ? document.createTextNode(n) : n)));
  }
  function errSay(id, e) {
    const msg = errText(e);
    if (e?.quiet || e?.relayDeclined) return say(id, msg);
    const span = document.createElement('span');
    span.className = 'err'; span.setAttribute('role', 'alert'); span.textContent = msg;
    say(id, span);
    if (!/^Cancelled/.test(msg)) console.warn('[tac pool]', id, e);
  }
  async function busy(btn, id, fn) {
    if (busyId) { say(id, busyId === id ? 'Already working on that…' : 'Finishing the last action first. Try again in a moment.'); return; }
    busyId = id;
    const own = !ctx.hold, wasDisabled = btn.disabled;
    if (own) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try { if (own) await fn(); else await ctx.hold(btn, fn); }
    catch (e) { errSay(id, e); }
    finally {
      busyId = null;
      if (own) { btn.disabled = wasDisabled; btn.removeAttribute('aria-busy'); }
      if (afterBusy) { const f = afterBusy; afterBusy = null; f(); }
    }
  }

  // ── prices, the relay's fee, the pool's note feed ──
  const satsFor = (units) => (markSats == null ? null : Math.floor((Number(units) / 10 ** DECIMALS) * markSats));
  const satsText = (units) => {
    const s = satsFor(units);
    if (s == null) return '';
    const usd = ctx.usd?.(s) || '';
    return `≈ ${s.toLocaleString('en-US')} sats${usd ? ` · ${usd}` : ''}`;
  };
  function loadPrice() {
    return (priceP ||= fetch(`${WORKER}/assets/${ASSET}?network=mainnet`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const u = Number(j?.mark_price?.unit);
      if (Number.isFinite(u) && u > 0) markSats = u;
      paintBalances(); paintHints();
    }, () => { priceP = null; }));
  }
  // the relay's fee read, which a press that sizes an amount waits for
  function loadRelay() {
    return (relayP ||= loadSecret().then(() => S.poolClientFor('mainnet').relayInfo()).then((info) => {
      relayLive = !!info; const f = info?.fees?.['0x' + S.TAC_ASSET_MAINNET]; relayFee = f == null ? null : BigInt(f);
    }, () => { relayLive = false; relayFee = null; }).finally(() => paintSendComb()));
  }
  const relayFeeUnits = () => (relayLive && relayFee != null ? relayFee : 0n);
  const combineFee = () => (relayLive && relayFee != null ? relayFee : null);
  const feeCap = () => (combineFee() == null ? null : (combineFee() * 5n) / 4n);   // a quote up to a quarter over the fee shown goes through; one above it is shown first
  // A quote above the fee shown ends the press before anything is paid: the fee shown, Max and the balance check follow the new one, and the
  // press is asked for again.
  const feeMoved = (e) => {
    if (e?.feeMoved == null) throw e;
    relayFee = e.feeMoved; paintSendComb();
    throw said(`The relay’s fee changed to ${fmt(e.feeMoved)} TAC. Check it and press again.`);
  };
  // The pool's note feed as last read here, kept as long as the pool client keeps its own read (20 s from its answer): a claim panel and the
  // wallet's own read scan the same bytes instead of fetching them again.
  function poolFeed() {
    if (!feedKept || (feedKept.at != null && Date.now() - feedKept.at > 20e3)) {
      const kept = { p: null, at: null };
      kept.p = S.poolClientFor('mainnet').allNotes().then((notes) => { kept.at = Date.now(); return notes; }, (e) => { if (feedKept === kept) feedKept = null; throw e; });
      feedKept = kept;
    }
    return feedKept.p;
  }
  const feedFresh = () => (feedKept && (feedKept.at == null || Date.now() - feedKept.at <= 20e3) ? feedKept.p : null);

  // ── balances ──
  const noteVal = (u) => (typeof u.amount === 'bigint' ? u.amount : BigInt(u.amount));
  const publicTotal = () => pub.notes.reduce((t, u) => t + noteVal(u), 0n);
  const liveAll = () => (S && wallet() ? S.pendingView(shielded.notes || [], S.TAC_ASSET_MAINNET, wallet()).live : (shielded.notes || []).filter((n) => !n.spent));
  const shieldedTotal = () => liveAll().reduce((t, n) => t + BigInt(n.value), 0n);
  const liveNotes = () => liveAll().filter((n) => BigInt(n.value) > 0n);
  const liveValues = () => liveNotes().map((n) => BigInt(n.value)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  async function loadPublic() {
    if (!unlocked()) return;
    const k = ctx.key().pubHex;
    pub = { ...pub, loading: true }; paintBalances();
    try {
      await loadSecret();
      const h = await ctx.withKey((t) => { T = t; return t.scanHoldings(); });
      if (ctx.key()?.pubHex !== k) return;
      const entry = h instanceof Map ? h.get(S.TAC_ASSET_MAINNET) : null;
      pub = { loading: false, notes: entry?.utxos || [], read: true };
    } catch (e) { if (ctx.key()?.pubHex !== k) return; pub = { ...pub, loading: false }; errSay('tp-st-shield', e); }
    paintBalances(); paintShieldPicker();
  }
  function loadShielded() { return (shieldedP = readShielded()); }
  async function readShielded() {
    await loadSecret();
    const w = wallet();
    if (!w) return;
    shielded = { ...shielded, loading: true }; paintBalances();
    try {
      // a feed read moments ago opens this wallet's notes too, so the pool's notes are not fetched a second time for it
      const kept = feedFresh();
      const notes = kept ? (await S.poolClientFor('mainnet').walletNotes(S.pool, w, { notes: await kept })).filter((n) => lc(n.asset).replace(/^0x/, '') === S.TAC_ASSET_MAINNET) : await S.poolNotes(w, S.TAC_ASSET_MAINNET);
      if (wallet() !== w) return;
      shielded = { loading: false, notes, read: true };
    } catch (e) { if (wallet() !== w) return; shielded = { ...shielded, loading: false }; errSay('tp-st-recv', e); }
    paintBalances();
    ctx.changed?.();
  }
  async function refreshAll() {
    if (!unlocked()) return;
    await loadSecret();
    paintBalances();
    await Promise.all([loadPublic(), loadShielded()]);
    await recoverExits().catch(() => {});
  }
  // A withdrawal whose opening this device lost (a tab closed mid-exit) is opened again from the pool's record of it.
  async function recoverExits() {
    if (!unlocked() || !wallet() || !shielded.notes) return;
    const k = ctx.key().pubHex;
    const h = await ctx.withKey((t) => t.scanHoldings());
    if (ctx.key()?.pubHex !== k) return;
    const ghosts = (h instanceof Map ? h.get(S.TAC_ASSET_MAINNET)?.ghosts : null) || [];
    if (!ghosts.length) return;
    const n = await ctx.withKey((t) => S.recoverExitOpenings(t, { poolWallet: wallet(), asset: S.TAC_ASSET_MAINNET, utxos: ghosts.map((g) => g.utxo), notes: shielded.notes }));
    if (n) { await ctx.withKey((t) => { t.invalidateHoldingsCache?.(); }); await loadPublic(); ctx.changed?.('bitcoin'); }
  }
  // Payments to the key's one-time (stealth) addresses on Bitcoin, found by scanning TAC's transfers
  async function findStealth({ report } = {}) {
    if (!unlocked()) return 0;
    let found = 0;
    try {
      const r = await ctx.withKey((t) => t.scanAssetForStealthReceipts(S.TAC_ASSET_MAINNET, {
        onProgress: (pr) => report?.(`Checking transfers for payments to you… ${(pr.txsScanned + pr.txsSkipped).toLocaleString('en-US')} seen`),
      }));
      found = r?.discovered?.length || 0;
    } catch (e) {
      report?.(`Could not check for stealth payments: ${errText(e)}`);
      return 0;
    }
    stealthScanned = true;
    if (found) { await ctx.withKey((t) => { t.invalidateHoldingsCache?.(); }); await loadPublic(); ctx.changed?.('bitcoin'); }
    return found;
  }
  // (`statusId`: the panel's line to say it in, or a function the page says it with)
  async function scanEverything(statusId = 'tp-st-recv') {
    const tell = typeof statusId === 'function' ? statusId : (m) => say(statusId, m);
    await ready();
    tell('Scanning…');
    const [found] = await Promise.all([findStealth({ report: tell }), loadShielded()]);
    if (!found) await loadPublic();
    const n = liveNotes().length;
    tell(`${n} shielded note${n === 1 ? '' : 's'}. ${found ? `${found} stealth payment${found === 1 ? '' : 's'} added to your Bitcoin balance.` : 'No new stealth payments.'}`);
    ctx.changed?.();
  }

  // ── painting ──
  function paintBalances() {
    if (!host) return;
    const el = q('tp-bal');
    if (!el) return;
    const n = liveNotes().length;
    el.textContent = !unlocked() ? 'Open your Tacit wallet to see what you hold here.'
      : !shielded.read ? 'Reading your shielded notes…'
      : `${fmt(shieldedTotal())} TAC shielded, in ${n} note${n === 1 ? '' : 's'}`;
    if (unlocked() && shielded.read && !shielded.loading && n > 2) {   // a payment spends two notes at most: Withdraw and claim links need this too
      const b = Object.assign(document.createElement('button'), { className: 'link', type: 'button', textContent: 'Combine' });
      b.onclick = offerCombine;
      el.append(' · ', b);
    }
    q('tp-refresh').hidden = !unlocked();
    paintSendComb();
  }
  const combineBox = (id, lead, each = false) => html`<div class="callout"><span>${lead}<small>${combineFee() != null ? `Relay fee ≈ ${fmt(combineFee())} TAC${each ? ' each' : ''}` : 'Posted from your Bitcoin address, which pays its Bitcoin fee and shows as the sender'}.</small></span><button class="btn ghost" type="button" id="${id}">Combine</button></div>`;
  function paintSendComb() {
    const box = q('tp-send-comb');
    if (!box) return;
    let v = 0n;
    try { v = parseUnits(q('tp-send-amt').value); } catch {}
    const vals = liveValues(), k = v > 0n && unlocked() && S ? S.combinePlan(vals, v + relayFeeUnits(), combineFee() || 0n) : null;
    box.hidden = !k;
    if (!k) return box.replaceChildren();
    box.innerHTML = combineBox('tp-comb-send', html`Your TAC is in ${vals.length} notes; one payment spends two.${k > 1 ? ` This one takes ${k} combines, one per press.` : ''} Combine them first: `, k > 1).s;
    q('tp-comb-send').onclick = (e) => busy(e.currentTarget, 'tp-st-send', () => doCombine('tp-st-send', 'Then pay again.'));
  }
  function offerCombine() {
    const [a = 0n, b = 0n] = liveValues();
    q('tp-st-comb').innerHTML = combineBox('tp-comb', html`Your TAC is in ${liveValues().length} notes; one payment spends two. Combining joins your two largest into one note of ${fmt(a + b - (combineFee() || 0n))} TAC. `).s;
    q('tp-comb').onclick = (e) => busy(e.currentTarget, 'tp-st-comb', () => doCombine('tp-st-comb', ''));
  }
  function paintHints() {
    if (!host) return;
    for (const [field, hint] of [['tp-send-amt', 'tp-send-sats'], ['tp-exit-amt', 'tp-exit-sats'], ['tp-claim-amt', 'tp-claim-sats']]) {
      const el = q(hint); if (!el) continue;
      let units = 0n;
      try { units = parseUnits(q(field).value); } catch { units = 0n; }
      el.textContent = units > 0n ? satsText(units) : '';
    }
  }
  function paintShieldPicker() {
    const sel = q('tp-shield-pick');
    if (!sel) return;
    const was = sel.value, note = q('tp-shield-note');
    sel.replaceChildren();
    const one = (text) => { const o = document.createElement('option'); o.textContent = text; sel.append(o); sel.disabled = true; };
    note.textContent = '';
    if (!pub.notes.length) return one(!unlocked() ? 'Open your Tacit wallet first' : pub.loading || !pub.read ? 'Reading your TAC on Bitcoin…' : 'No TAC at your Bitcoin address');
    const shieldable = pub.notes.filter((u) => !u.stealthTweakedSk), held = pub.notes.length - shieldable.length;
    if (held) note.textContent = `${held} note${held === 1 ? '' : 's'} paid to a one-time address ${held === 1 ? 'needs' : 'need'} moving in the classic app first.`;
    if (!shieldable.length) return one('No TAC here can be shielded yet');
    sel.disabled = false;
    [...shieldable].sort((a, b) => (noteVal(b) > noteVal(a) ? 1 : noteVal(b) < noteVal(a) ? -1 : 0)).forEach((u) => {
      const o = document.createElement('option'), s = satsText(noteVal(u));
      o.value = `${u.utxo.txid}:${u.utxo.vout}`;
      o.textContent = `${fmt(noteVal(u))} TAC${s ? `  ·  ${s}` : ''}`;
      sel.append(o);
    });
    ([...sel.options].find((o) => o.value === was) || sel.options[0]).selected = true;
  }
  function paintReceive() {
    const w = unlocked() && S ? wallet() : null, a = w ? ctx.tacitAddress() : null;
    const t = q('tp-recv-tacit'), p = q('tp-recv-pool');
    if (!t) return;
    t.value = a || ''; p.value = w ? w.addressString : '';
    t.placeholder = p.placeholder = w ? 'Reading…' : 'Open your Tacit wallet to see it';
  }

  // ── presses ──
  async function doShield() {
    await ready();
    if (!pub.notes.length) await loadPublic();
    const picked = q('tp-shield-pick').value, shieldable = pub.notes.filter((x) => !x.stealthTweakedSk);
    if (!shieldable.length) throw new Error('No TAC at your Bitcoin address can be shielded yet.');
    const u = shieldable.find((x) => `${x.utxo.txid}:${x.utxo.vout}` === picked);
    if (!u) throw new Error('Your notes changed. Pick the note to shield again.');
    const big = typeof u.blinding === 'bigint' ? u.blinding : BigInt(/^0x/i.test(String(u.blinding)) ? u.blinding : '0x' + String(u.blinding));
    const note = { assetId: S.TAC_ASSET_MAINNET, txid: u.utxo.txid, vout: u.utxo.vout, amount: noteVal(u).toString(), blinding: big.toString(16).padStart(64, '0') };
    const r = await S.shieldNote(T, { note, poolWallet: wallet(), say: (m) => say('tp-st-shield', m) });
    say('tp-st-shield', `${fmt(r.poolNote.value)} TAC shielded in `, txLink(r.revealTxid), '. It joins the pool after one confirmation.');
    try { T.invalidateHoldingsCache?.(); } catch {}
    await loadPublic(); await loadShielded();
    ctx.changed?.('bitcoin');
  }
  async function doSend(anchor = null) {
    await ready();
    const to = q('tp-send-to').value.trim();
    if (!to) throw new Error('Paste the Tacit or pool address you are paying.');
    const amount = parseUnits(q('tp-send-amt').value);
    if (amount <= 0n) throw new Error('Enter an amount above zero.');
    if (!shielded.notes.length) await loadShielded();
    if (amount + relayFeeUnits() > shieldedTotal()) throw new Error(relayFeeUnits() > 0n ? `More than your shielded balance with the relay’s ${fmt(relayFeeUnits())} TAC fee.` : 'More than your shielded balance.');
    const r = await S.payPrivately(T, { poolWallet: wallet(), to, amount, asset: S.TAC_ASSET_MAINNET, anchor, maxFee: feeCap(), say: (m) => say('tp-st-send', m), askSelf: askSelfPost('tp-st-send') }).catch(feeMoved);
    if (r.wait) return waitBox('tp-st-send', r, (tip) => doSend(tip));
    q('tp-send-to').value = ''; q('tp-send-amt').value = ''; paintHints();
    say('tp-st-send', `Sent ${fmt(amount)} TAC in `, txLink(r.revealTxid), r.relayed ? '. The relay posted it, for a fee in TAC.' : '. Posted from your Bitcoin address.');
    await loadShielded();
  }
  async function doCombine(statusId, then, anchor = null) {
    await ready();
    if (!shielded.notes.length) await loadShielded();
    const fee = combineFee();
    const r = await S.combineNotes(T, { poolWallet: wallet(), asset: S.TAC_ASSET_MAINNET, anchor, noRelay: fee == null, maxFee: fee, say: (m) => say(statusId, m), askSelf: askSelfPost(statusId) }).catch(feeMoved);
    if (r.wait) return waitBox(statusId, r, (tip) => doCombine(statusId, then, tip));
    say(statusId, 'Combining in ', txLink(r.revealTxid), ': the new note counts after three Bitcoin confirmations, about 30 minutes.', then ? ` ${then}` : '');
    await loadShielded();
  }
  async function doExit(anchor = null) {
    await ready();
    const amount = parseUnits(q('tp-exit-amt').value);
    if (amount <= 0n) throw new Error('Enter an amount above zero.');
    if (!shielded.notes.length) await loadShielded();
    if (amount > shieldedTotal()) throw new Error('More than your shielded balance.');
    const r = await S.exitToWallet(T, { poolWallet: wallet(), amount, asset: S.TAC_ASSET_MAINNET, anchor, say: (m) => say('tp-st-exit', m) });
    if (r.wait) return waitBox('tp-st-exit', r, (tip) => doExit(tip));
    q('tp-exit-amt').value = ''; paintHints();
    say('tp-st-exit', `${fmt(amount)} TAC withdrawn in `, txLink(r.revealTxid), '. The rest stays shielded.');
    try { T.invalidateHoldingsCache?.(); } catch {}
    await loadPublic(); await loadShielded();
    ctx.changed?.('bitcoin');
  }
  // Max: the shielded balance, less the relay's fee where the relay carries it (it is waited for rather than taken as none)
  const maxInto = (field, statusId) => async () => {
    await ready();
    if (shielded.loading) await shieldedP; else if (!shielded.notes.length) await loadShielded();
    if (relayLive == null) await loadRelay();
    const total = shieldedTotal() - (field === 'tp-exit-amt' ? 0n : relayFeeUnits());
    if (total <= 0n) return say(statusId, 'Nothing shielded yet. Shield some TAC first.');
    q(field).value = fmtPlain(total);
    q(field).dispatchEvent(new Event('input', { bubbles: true }));
    say(statusId, '');
  };

  const askSelfPost = (statusId) => (why, { timedOut = false, signal } = {}) => new Promise((resolve) => {
    const el = q(statusId), box = document.createElement('div'), p = document.createElement('div'), row = document.createElement('div');
    const lead = why === 'relay-slow' ? (timedOut ? 'The relay hasn’t posted it in five minutes.' : 'The relay hasn’t posted it.') : 'The relay didn’t take this payment.';
    p.textContent = `${lead} Post it from your Bitcoin address instead? Your Bitcoin address shows as the sender.`;
    const button = (cls, text, yes) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = () => end(yes); return b; };
    row.className = 'row2';
    row.append(button('btn', 'Post it from my Bitcoin address', true), button('btn ghost', 'Not now', false));
    box.append(p, row);
    const keep = new MutationObserver(() => { if (!box.isConnected) el.append(box); });
    const end = (yes) => { clearTimeout(timer); keep.disconnect(); signal?.removeEventListener('abort', no); box.remove(); resolve(yes); };
    const no = () => end(false), timer = setTimeout(no, 10 * 60e3);
    if (signal?.aborted) return no();
    signal?.addEventListener('abort', no);
    say(statusId, box);
    keep.observe(el, { childList: true });
  });
  function waitBox(statusId, w, retry) {
    const wrap = document.createElement('div'), p = document.createElement('div'), row = document.createElement('div');
    p.textContent = `Your newest note needs ${blocksText(w.wait)} before it can be spent against a settled block.`;
    row.className = 'row2';
    const now = document.createElement('button');
    now.type = 'button'; now.className = 'btn ghost'; now.textContent = 'Spend now anyway';
    now.onclick = () => busy(now, statusId, () => retry(w.tip));
    const wait = document.createElement('button');
    wait.type = 'button'; wait.className = 'btn ghost'; wait.textContent = 'Wait';
    wait.onclick = () => say(statusId, 'Waiting. Try again in a few minutes.');
    row.append(now, wait);
    const why = document.createElement('p');
    why.className = 'note';
    why.textContent = 'Spending now anchors at the newest block, which hints to an observer that the note is fresh.';
    wrap.append(p, row, why);
    say(statusId, wrap);
  }

  // ── claim links: made here ──
  function writeClaimLinks(list) {
    try { localStorage.setItem(CLAIM_LINKS, JSON.stringify(list)); } catch {}
    paintClaimLinks();
  }
  const putClaimLink = (rec) => writeClaimLinks([...claimLinks().filter((x) => x.secret !== rec.secret), rec]);
  const patchClaimLink = (secret, patch) => writeClaimLinks(claimLinks().map((x) => (x.secret === secret ? { ...x, ...patch } : x)));
  const dropClaimLink = (secret) => writeClaimLinks(claimLinks().filter((x) => x.secret !== secret));
  function paintClaimLinks() {
    const box = q('tp-links');
    if (!box) return;
    const list = claimLinks().sort((a, b) => b.at - a.at);
    box.hidden = !list.length;
    q('tp-links-list').replaceChildren(...list.map((rec) => {
      const row = document.createElement('div'), what = document.createElement('span'), acts = document.createElement('b');
      row.className = 'kv';
      let amount = '';
      try { amount = `${fmt(rec.amount)} TAC · `; } catch {}
      what.textContent = `${amount}${new Date(rec.at).toLocaleString()}${rec.pinned ? ' · with a PIN' : ''}`;
      const act = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'link'; b.textContent = label;
        b.onclick = () => fn(b);
        acts.append(b);
        return b;
      };
      if (rec.link) act('Copy link', (b) => { copyText(rec.link).then((ok) => { b.textContent = ok ? 'Copied' : 'Could not copy'; }); });
      else {
        let pinField = null;
        if (rec.pinned) {
          pinField = document.createElement('input');
          pinField.autocomplete = 'off'; pinField.inputMode = 'numeric'; pinField.placeholder = 'its PIN'; pinField.className = 'tp-pin';
          pinField.setAttribute('aria-label', 'The PIN you set for this link');
          acts.append(pinField);
        }
        act('Find the link', (b) => busy(b, 'tp-st-links', () => findClaimLink(rec, pinField ? pinField.value.trim() : '')));
      }
      act('Forget', () => {
        if (!confirm(rec.link ? 'Forget this link on this device? Anyone who already has it can still claim it.' : 'Forget this link? This device keeps the only copy of its secret.')) return;
        dropClaimLink(rec.secret);
      });
      row.append(what, acts);
      return row;
    }));
  }
  async function findClaimLink(rec, pin) {
    await Promise.all([loadSecret(), loadClaim()]);
    if (rec.pinned && !pin) throw new Error('Enter the PIN you set for this link.');
    const secret32 = fromHex(rec.secret);
    say('tp-st-links', 'Looking for its payment…');
    const notes = await S.poolNotes(C.claimPoolWallet(S.pool, secret32, { pin, network: rec.network }), S.TAC_ASSET_MAINNET);
    const n = notes.find((x) => x.txid && BigInt(x.value) > 0n);
    if (!n) {
      return say('tp-st-links', rec.pinned
        ? 'Nothing under this link yet. Check the PIN, or try again in a few blocks.'
        : 'Nothing under this link yet. Try again in a few blocks. A payment that never went out left the TAC in your shielded balance.');
    }
    patchClaimLink(rec.secret, { txid: n.txid, link: C.claimUrl(location.origin, C.encodeClaim({ secret32, txid: n.txid, network: rec.network, pinned: rec.pinned })) });
    say('tp-st-links', 'Found. Copy the link above.');
  }
  async function makeClaimLink() {
    await ready();
    await loadClaim();
    const amount = parseUnits(q('tp-claim-amt').value);
    if (amount <= 0n) throw new Error('Enter an amount above zero.');
    if (!shielded.notes.length) await loadShielded();
    if (amount + relayFeeUnits() > shieldedTotal()) throw new Error(relayFeeUnits() > 0n ? `More than your shielded balance with the relay’s ${fmt(relayFeeUnits())} TAC fee.` : 'More than your shielded balance.');
    const pin = q('tp-claim-pin').value.trim();
    let secret = null;
    const r = await C.createClaim(T, {
      S, pool: S.pool, poolWallet: wallet(), amount, asset: S.TAC_ASSET_MAINNET, pin, network: 'mainnet', maxFee: feeCap(),
      say: (m) => say('tp-st-claim-make', m), askSelf: askSelfPost('tp-st-claim-make'),
      keep: ({ secret32, pinned, network }) => {
        secret = toHex(secret32);
        putClaimLink({ secret, pinned, network, amount: amount.toString(), at: Date.now() });
        // storage that is full or blocked keeps nothing: the payment is not made to a key only this tab knows
        if (!claimLinks().some((x) => x.secret === secret)) throw new Error('This browser could not save the link’s key, so nothing was sent. Free some space or allow this site’s data, then try again.');
      },
    }).catch((e) => { if (e?.feeMoved != null && secret) dropClaimLink(secret); feeMoved(e); });   // a fee refused before anything is paid leaves no link behind
    if (r.wait) {
      if (secret) dropClaimLink(secret);
      return say('tp-st-claim-make', `Your newest note needs ${blocksText(r.wait)} before it can be spent. Try again after that.`);
    }
    if (secret) patchClaimLink(secret, { txid: r.revealTxid, link: r.link });
    q('tp-claim-amt').value = ''; q('tp-claim-pin').value = ''; paintHints();
    if (!r.link) {   // the relay posted it without saying where: the link is read back from the note once the pool counts it
      say('tp-st-claim-make', `${fmt(amount)} TAC went out in the relay’s batch. Its link is under Links made here: press Find the link there in a few blocks.`);
      return loadShielded();
    }
    const box = document.createElement('div'), field = document.createElement('input'), copy = document.createElement('button');
    field.readOnly = true; field.value = r.link; field.className = 'tp-out'; field.setAttribute('aria-label', 'Claim link');
    copy.type = 'button'; copy.className = 'btn ghost'; copy.textContent = 'Copy link';
    copy.onclick = () => { copyText(r.link).then((ok) => { copy.textContent = ok ? 'Copied' : 'Select the link above to copy it'; }); };
    box.append(document.createTextNode(`${fmt(amount)} TAC is under this link. Anyone who has the link${pin ? ' and the PIN' : ''} can take it.`), field, copy);
    say('tp-st-claim-make', box);
    await loadShielded();
  }

  // ── a claim link someone sent: one panel at a time (a new link stops the last one's checks, and a late read of the last one's changes nothing) ──
  const claimTimers = { typing: 0, again: 0 };
  let claimGen = 0;
  async function showClaim(box, payload) {
    clearTimeout(claimTimers.typing); clearTimeout(claimTimers.again);
    const gen = ++claimGen;
    box.hidden = false;
    box.textContent = 'Reading the link…';
    let parsed;
    try { await Promise.all([loadClaim(), loadSecret()]); parsed = C.decodeClaim(payload); }
    catch (e) { box.textContent = ''; return errInto(box, e); }
    if (parsed.network !== 'mainnet') { box.textContent = 'That link is for another network.'; return; }

    const pinField = document.createElement('input');
    pinField.placeholder = 'PIN'; pinField.autocomplete = 'off'; pinField.inputMode = 'numeric'; pinField.className = 'tp-pin wide';
    pinField.setAttribute('aria-label', 'PIN');
    const line = document.createElement('div'); line.className = 'kv';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Claim it';
    btn.disabled = true;   // live once a read says there is something under the link
    const st = document.createElement('div'); st.className = 'status'; st.id = 'tp-st-claim'; st.setAttribute('role', 'status');

    let looked = 0, claimed = false;   // claimed here: the pool's feed can still show the note for a few blocks
    async function refresh() {
      if (gen !== claimGen || !box.isConnected) return;
      const mine = ++looked;
      line.replaceChildren(document.createTextNode('Checking…'));
      let has = false, gone = false, failed = false;
      try {
        const feed = await poolFeed();
        const r = await C.readClaim(S, S.pool, { secret32: parsed.secret32, pin: pinField.value.trim(), network: 'mainnet', asset: S.TAC_ASSET_MAINNET, feed, txid: parsed.txid });
        if (mine !== looked || gen !== claimGen) return;
        has = r.total > 0n && !claimed; gone = claimed || (!has && r.seen > 0);
        // no note under the link at all: a payment still on its way while the pool has not indexed its transaction; once it has, the PIN is not
        // the one the link was made with, or the link was changed on the way
        const why = has ? `${fmt(r.total)} TAC${satsText(r.total) ? ' · ' + satsText(r.total) : ''}` : gone ? 'Already claimed' : r.indexed === false ? 'Not arrived yet' : parsed.pinned ? 'Check the PIN' : r.indexed ? 'Copy the whole link again' : 'Not arrived yet';
        line.replaceChildren(
          Object.assign(document.createElement('span'), { textContent: has ? 'Waiting for you' : gone ? 'Nothing under this link' : 'Nothing here yet' }),
          Object.assign(document.createElement('b'), { className: 'num', textContent: why }));
        btn.disabled = !has;
      } catch (e) { if (mine !== looked || gen !== claimGen) return; failed = true; line.replaceChildren(); errInto(line, e); }
      clearTimeout(claimTimers.again);
      // a payment a few blocks out, or a read that failed, is looked for again in a minute; a tab out of sight looks once it is seen again
      if (failed || (!has && !gone)) claimTimers.again = setTimeout(() => { if (!document.hidden) refresh(); else document.addEventListener('visibilitychange', () => refresh(), { once: true }); }, 60e3);
    }

    btn.onclick = () => busy(btn, 'tp-st-claim', async () => {
      try { await ready(); } catch (e) { if (e?.quiet) { st.textContent = 'Open your Tacit wallet, then press Claim it again.'; return; } throw e; }
      const r = await C.sweepClaim(T, {
        S, pool: S.pool, secret32: parsed.secret32, pin: pinField.value.trim(), network: 'mainnet',
        asset: S.TAC_ASSET_MAINNET, toAddress: wallet().addressString, fmt, say: (m) => { st.textContent = m; }, askSelf: askSelfPost('tp-st-claim'),
      });
      if (r.wait) { st.textContent = `The note needs ${blocksText(r.wait)} before it can move. Try again after that.`; return; }
      claimed = true;
      st.replaceChildren(document.createTextNode('Claimed into your shielded TAC on Bitcoin in '), txLink(r.revealTxid), document.createTextNode(r.relayed ? '. The fee came out of the TAC, so it cost you no bitcoin.' : '.'));
      await refreshAll();
      await refresh();
    }).then(() => { if (claimed) btn.disabled = true; });   // busy hands the button back as it was before the press

    box.replaceChildren(
      Object.assign(document.createElement('p'), { className: 'note tp-lead', textContent: parsed.pinned ? 'Someone sent you TAC. Enter the PIN you were given.' : 'Someone sent you TAC. Claiming moves it into your shielded TAC on Bitcoin.' }),
      ...(parsed.pinned ? [pinField] : []), line, btn, st);
    if (parsed.pinned) pinField.addEventListener('input', () => { clearTimeout(claimTimers.typing); claimTimers.typing = setTimeout(refresh, 400); });
    await refresh();
  }
  function errInto(el, e) {
    const span = document.createElement('span');
    span.className = 'err'; span.setAttribute('role', 'alert'); span.textContent = errText(e);
    el.append(span);
  }

  // ── tabs ──
  function pick(k, sub = null, user = false) {
    if (!TABS.some(([x]) => x === k)) k = 'shield';
    tab = k;
    if (k === 'withdraw' && sub) wTab = sub === 'sats' ? 'sats' : 'self';
    if (!host) return;
    for (const [x] of TABS) {
      const t = q(`tp-t-${x}`);
      t.setAttribute('aria-selected', String(x === k)); t.tabIndex = x === k ? 0 : -1;
      q(`tp-p-${x}`).hidden = x !== k;
    }
    for (const [x, id] of [['self', 'tp-w-self'], ['sats', 'tp-w-sats']]) {
      const t = q(`tp-wt-${x}`);
      t.setAttribute('aria-selected', String(x === wTab)); t.tabIndex = x === wTab ? 0 : -1;
      q(id).hidden = x !== wTab;
    }
    if (k === 'send') paintClaimLinks();
    if (k === 'receive') paintReceive();
    if (k === 'withdraw' && wTab === 'sats') mountSats();
    if (user) ctx.viewChanged?.();
  }
  function mountSats() {
    const box = q('tp-sats');
    if (satsMounted || !box) return;
    satsMounted = true;
    // the panel reads the key's sale keys through tacit.js as it is drawn, so it is loaded with the key first
    const keyed = unlocked() ? ctx.withKey((t) => { T = t; }).catch(() => {}) : Promise.resolve();
    Promise.all([keyed, loadSecret(), mods.sats ? mods.sats : import(SATS_URL)]).then(([, , m]) => m.mount(box, {
      get T() { return T; }, get S() { return S; }, get poolWallet() { return wallet(); },
      get markSats() { return markSats; }, get notes() { return shielded.notes; },
      ensureKey: ready, busy, say, errSay, fmt, blocksText, parseUnits, shieldedTotal, txLink, loadShielded, relayFeeUnits, feeCap, feeMoved,
      turn: (fn) => ctx.withKey(fn),
    })).catch((e) => { satsMounted = false; errSay('tp-st-exit', e); });
  }
  const tabsKeys = (sel, attr, onPick) => {
    const list = [...host.querySelectorAll(sel)];
    list.forEach((b, i) => {
      b.addEventListener('click', () => onPick(b.dataset[attr]));
      b.addEventListener('keydown', (e) => {
        const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
        if (j === undefined) return;
        e.preventDefault();
        const n = list[(j + list.length) % list.length];
        onPick(n.dataset[attr]); n.focus();
      });
    });
  };

  const amtRow = (id, label, maxId) => html`<div class="lbl"><label for="${id}">${label}</label><button type="button" id="${maxId}">Max</button></div>
    <div class="amt"><input id="${id}" inputmode="decimal" autocomplete="off" placeholder="0.00"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div>
    <div class="tp-sats" id="${id.replace('-amt', '-sats')}"></div>`;
  function view() {
    return html`<div class="seg sub" role="tablist" aria-label="TAC in the Bitcoin pool">${TABS.map(([k, t]) => html`<button type="button" role="tab" id="tp-t-${k}" aria-controls="tp-p-${k}" aria-selected="false" tabindex="-1" data-tp="${k}">${t}</button>`)}</div>
    <div class="kv tp-bal"><span id="tp-bal"></span><button class="link" type="button" id="tp-refresh" hidden>Refresh</button></div>
    <div class="status" id="tp-st-comb" role="status"></div>

    <div id="tp-p-shield" role="tabpanel" aria-labelledby="tp-t-shield">
      <div class="lbl"><label for="tp-shield-pick">TAC on Bitcoin</label></div>
      <div class="amt text"><select id="tp-shield-pick"><option>Open your Tacit wallet first</option></select></div>
      <p class="note">A whole note goes in. Your Bitcoin address pays the network fee.</p>
      <p class="note" id="tp-shield-note"></p>
      <button class="btn" type="button" id="tp-shield-go">Shield</button>
      <div class="status" id="tp-st-shield" role="status"></div>
    </div>

    <div id="tp-p-send" role="tabpanel" aria-labelledby="tp-t-send" hidden>
      <div class="lbl"><label for="tp-send-to">To</label></div>
      <div class="amt text"><input id="tp-send-to" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="tacit1… or bp1…"></div>
      ${amtRow('tp-send-amt', 'Amount', 'tp-send-max')}
      <div id="tp-send-comb" hidden></div>
      <button class="btn" type="button" id="tp-send-go">Send privately</button>
      <div class="status" id="tp-st-send" role="status"></div>
      <div class="lbl tp-sep"><span>Or as a claim link</span></div>
      <p class="note">Anyone with the link can take it. Add a PIN if you share it in the open.</p>
      ${amtRow('tp-claim-amt', 'Amount', 'tp-claim-max')}
      <div class="lbl"><label for="tp-claim-pin">PIN, shared separately</label></div>
      <div class="amt text"><input id="tp-claim-pin" autocomplete="off" inputmode="numeric" placeholder="none"></div>
      <button class="btn ghost" type="button" id="tp-claim-go">Create a claim link</button>
      <div class="status" id="tp-st-claim-make" role="status"></div>
      <div id="tp-links" hidden>
        <div class="lbl tp-sep"><span>Links made here</span></div>
        <div id="tp-links-list"></div>
        <div class="status" id="tp-st-links" role="status"></div>
      </div>
    </div>

    <div id="tp-p-withdraw" role="tabpanel" aria-labelledby="tp-t-withdraw" hidden>
      <div class="seg sub" role="tablist" aria-label="Withdraw">
        <button type="button" role="tab" id="tp-wt-self" aria-controls="tp-w-self" aria-selected="true" data-tpw="self">To Bitcoin</button>
        <button type="button" role="tab" id="tp-wt-sats" aria-controls="tp-w-sats" aria-selected="false" tabindex="-1" data-tpw="sats">To sats</button>
      </div>
      <div id="tp-w-self" role="tabpanel" aria-labelledby="tp-wt-self">
        ${amtRow('tp-exit-amt', 'Amount', 'tp-exit-max')}
        <p class="note">Arrives as TAC at your Bitcoin address, which pays the network fee.</p>
        <button class="btn" type="button" id="tp-exit-go">Withdraw</button>
        <div class="status" id="tp-st-exit" role="status"></div>
      </div>
      <div id="tp-w-sats" role="tabpanel" aria-labelledby="tp-wt-sats" hidden><div id="tp-sats"></div></div>
    </div>

    <div id="tp-p-receive" role="tabpanel" aria-labelledby="tp-t-receive" hidden>
      <div class="lbl"><label for="tp-recv-tacit">Your Tacit address</label></div>
      <div class="amt text"><input id="tp-recv-tacit" readonly><button class="link" type="button" id="tp-copy-tacit">Copy</button></div>
      <div class="lbl"><label for="tp-recv-pool">Pool address, for an app that asks for bp1…</label></div>
      <div class="amt text"><input id="tp-recv-pool" readonly><button class="link" type="button" id="tp-copy-pool">Copy</button></div>
      <button class="btn ghost" type="button" id="tp-scan">Scan for payments</button>
      <div class="status" id="tp-st-recv" role="status"></div>
    </div>`;
  }

  function mount(el) {
    if (host === el) return;
    host = el;
    el.classList.add('tp');
    el.innerHTML = view().s;
    // an amount that does not read says why under its field
    for (const ev of ['input', 'change']) el.addEventListener(ev, ({ target: i }) => {
      if (!i.matches?.('input[inputmode="decimal"]')) return;
      const t = i.value.trim(), open = ev === 'input' && (t === '.' || /^[1-9]\d{0,2}(?:,\d{3})*,\d{0,3}$/.test(t));
      const bad = t && !open && parseAmount(t, DECIMALS) == null;
      if (bad) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
      const box = i.closest('.amt'), at = box.nextElementSibling?.matches?.('[data-amt-hint]') ? box.nextElementSibling : null;
      if (!bad) { at?.remove(); return; }
      const h = at || Object.assign(document.createElement('p'), { className: 'note err' });
      h.setAttribute('data-amt-hint', ''); h.setAttribute('role', 'alert'); h.textContent = amountWhy(t, DECIMALS);
      if (!at) box.after(h);
    }, true);
    tabsKeys('[data-tp]', 'tp', (k) => pick(k, null, true));
    tabsKeys('[data-tpw]', 'tpw', (k) => { wTab = k; pick('withdraw', k, true); });
    q('tp-refresh').onclick = (e) => busy(e.currentTarget, 'tp-st-recv', () => scanEverything('tp-st-recv'));
    q('tp-shield-go').onclick = (e) => busy(e.currentTarget, 'tp-st-shield', doShield);
    q('tp-send-go').onclick = (e) => busy(e.currentTarget, 'tp-st-send', () => doSend());
    q('tp-exit-go').onclick = (e) => busy(e.currentTarget, 'tp-st-exit', () => doExit());
    q('tp-claim-go').onclick = (e) => busy(e.currentTarget, 'tp-st-claim-make', makeClaimLink);
    q('tp-scan').onclick = (e) => busy(e.currentTarget, 'tp-st-recv', () => scanEverything('tp-st-recv'));
    q('tp-send-max').onclick = () => maxInto('tp-send-amt', 'tp-st-send')().catch((e) => errSay('tp-st-send', e));
    q('tp-exit-max').onclick = () => maxInto('tp-exit-amt', 'tp-st-exit')().catch((e) => errSay('tp-st-exit', e));
    q('tp-claim-max').onclick = () => maxInto('tp-claim-amt', 'tp-st-claim-make')().catch((e) => errSay('tp-st-claim-make', e));
    q('tp-send-amt').addEventListener('input', () => { paintHints(); paintSendComb(); });
    q('tp-exit-amt').addEventListener('input', paintHints);
    q('tp-claim-amt').addEventListener('input', paintHints);
    const copyOf = (field, what) => () => {
      const v = q(field).value;
      if (!v) return say('tp-st-recv', unlocked() ? 'Still reading it. Try again in a moment.' : `Open your Tacit wallet first: your ${what} comes from its key.`);
      copyText(v).then((ok) => say('tp-st-recv', ok ? `${what[0].toUpperCase()}${what.slice(1)} copied.` : 'Could not copy: the browser refused clipboard access.'));
    };
    q('tp-copy-tacit').onclick = copyOf('tp-recv-tacit', 'Tacit address');
    q('tp-copy-pool').onclick = copyOf('tp-recv-pool', 'pool address');
    pick(tab, wTab);
    paintBalances(); paintShieldPicker(); paintReceive(); paintClaimLinks();
    loadPrice(); loadRelay();
    loadSecret().then(() => { paintReceive(); if (unlocked() && !shielded.read && !shielded.loading) refreshAll().catch(() => {}); }, () => {});
  }

  // the key opened, switched or locked: what was read for the last one is let go of
  function keyChanged() {
    pw = null; pwPub = null; stealthScanned = false;
    pub = { loading: false, notes: [], read: false }; shielded = { loading: false, notes: [], read: false };
    for (const id of ['tp-st-shield', 'tp-st-send', 'tp-st-exit', 'tp-st-recv', 'tp-st-comb', 'tp-st-claim-make']) say(id);
    window.dispatchEvent(new Event('tac:wallet'));      // the To sats pane's sale keys are the key's
    if (!host) return;
    paintBalances(); paintShieldPicker(); paintReceive();
    if (unlocked()) whenIdle(() => refreshAll().then(() => {
      if (!stealthScanned && unlocked()) findStealth().then((n) => { if (n) say('tp-st-recv', `Found ${n} stealth payment${n === 1 ? '' : 's'}.`); }).catch(() => {});
    }).catch(() => {}));
  }
  const whenIdle = (fn) => { if (busyId) afterBusy = fn; else fn(); };

  return {
    mount,
    show: (k, sub = null) => pick(k, sub),
    view: () => [tab, ...(tab === 'withdraw' && wTab === 'sats' ? ['sats'] : [])],
    claim: (box, payload) => showClaim(box, payload).catch((e) => console.warn('[tac pool] claim link', e)),
    stopClaim: () => { claimGen++; clearTimeout(claimTimers.typing); clearTimeout(claimTimers.again); },
    keyChanged,
    refresh: () => (unlocked() ? refreshAll() : Promise.resolve()),
    busy: () => busyId != null,
    totals: () => ({ shielded: shielded.read ? shieldedTotal() : null, public: pub.read ? publicTotal() : null }),
    // a payment entered on the page: the Send tab filled with it, then pressed as its own button is
    pay: (to, amount) => {
      pick('send');
      q('tp-send-to').value = String(to || ''); q('tp-send-amt').value = String(amount || '');
      paintHints(); paintSendComb();
      return busy(q('tp-send-go'), 'tp-st-send', () => doSend());
    },
    // the relay's fee for a payment (TAC units), null while it is not posting them
    fees: () => loadRelay().then(() => ({ relay: relayLive && relayFee != null ? relayFee : null })),
    // the key's pool address (bp1…), null with no key open
    poolAddress: () => loadSecret().then(() => (unlocked() ? wallet()?.addressString || null : null)),
    // Scan for payments, its words said through `report`
    scan: (report) => scanEverything(report),
    // the pool as anyone sees it: its notes (the anonymity set), its transactions, the Bitcoin block it has read and its proof system
    stats: async () => {
      await loadSecret();
      const st = await S.poolClientFor('mainnet').status(), feed = await poolFeed().catch(() => null);
      return { set: Number(st.leafCount || 0), height: Number(st.height || 0), proof: st.proofSystem === 'halo2-kzg-bn254' ? 'Halo2·KZG' : (st.proofSystem || '—'),
        txs: feed ? new Set(feed.filter((n) => n.txid).map((n) => n.txid)).size : null };
    },
  };
}
