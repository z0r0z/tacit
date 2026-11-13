// "To sats": shielded TAC out, real bitcoin in, with nothing that ties the sats to this wallet.
//
//   1. Take out. The relay takes the TAC out of the pool to a sale key (secret.js saleKey: a new key of the pool
//      wallet, recoverable from the same backup) and posts the carrier from its own coins, for its fee in TAC. This
//      wallet's Bitcoin address funds nothing and signs nothing; with no relay, nothing is taken out.
//   2. List. The sale key signs a pre-authorized sale (publishPreauthSale): no transaction, no fee. A buyer settles
//      it alone and pays sats straight to the address the seller names.
//
// On chain: a pool exit to a new key, then that key's sale to the payout address. The listing shows the amount and
// the price, as every listing does. The price defaults to the worker's mark price for TAC, computed from real trades.

const WORKER = 'https://api.tacit.finance';
const ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const DAY = 86400;

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter((x) => x != null).map((x) => (typeof x === 'string' ? document.createTextNode(x) : x)));
  return n;
};

async function markPriceSats() {
  const r = await fetch(`${WORKER}/assets/${ASSET}?network=mainnet`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`market: HTTP ${r.status}`);
  const j = await r.json();
  const unit = Number(j?.mark_price?.unit);
  return Number.isFinite(unit) && unit > 0 ? unit : null;
}

async function openSales() {
  try {
    const r = await fetch(`${WORKER}/assets/${ASSET}/preauth-sales?network=mainnet`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const opKey = (n) => `${n.txid}:${n.vout}`;
// A price in sats per TAC as it is shown and prefilled: the market's mark carries eight decimals, a price is read to two.
const pxText = (n) => String(Math.round(Number(n) * 100) / 100);
const LASTS = [[1, '1 day'], [3, '3 days'], [7, '7 days']];
// replaceChildren writes a null as the text "null": a part that is not shown is left out.
const fill = (host, ...kids) => host.replaceChildren(...kids.filter((x) => x != null));

export function mount(host, ctx) {
  const { ensureKey, busy, say, fmt, parseUnits, shieldedTotal, txLink, loadShielded } = ctx;
  // fmt() groups thousands, which parseUnits rejects — inputs get the ungrouped form.
  const plain = (u) => fmt(u).replace(/,/g, '');

  let mark = null;          // sats per whole TAC
  let markRead = false;     // the market's price has answered (or failed)
  let book = null;          // open sales on the mainnet book
  let sale = null;          // S.saleKeys: { keys: the sale keys used, each with the TAC still at it, free: the next key }
  let looking = null, lookingFor = null;       // that read, while it runs, and the wallet it is for
  const ready = new Set();  // outpoints the pool's replay has recorded: until then a buyer's wallet does not credit them
  let pick = null;          // outpoint chosen to list
  let readErr = false;       // the last read of the sale keys failed

  const amt = el('input', { id: 'sats-amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
  const payout = el('input', { id: 'sats-payout', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'bc1…' });
  const priceEl = el('input', { id: 'sats-price', inputmode: 'decimal', autocomplete: 'off', placeholder: '—' });
  const lasts = el('select', { id: 'sats-lasts' }, ...LASTS.map(([d, t]) => el('option', d === 3 ? { value: String(d), selected: '' } : { value: String(d) }, t)));
  const quote = el('div', { class: 'kv' }, el('span', {}, 'You receive'), el('b', { id: 'sats-quote' }, '—'));
  const payHint = el('p', { class: 'note', id: 'sats-payout-hint' });

  const statusStep1 = el('div', { class: 'status', id: 'st-sats-1' });
  const statusStep2 = el('div', { class: 'status', id: 'st-sats-2' });

  const btnOut = el('button', { class: 'btn' }, 'Take it out');
  const btnList = el('button', { class: 'btn' }, 'List for sats');

  const fee = () => (ctx.relayFeeUnits ? ctx.relayFeeUnits() : 0n);
  const held = () => (sale?.keys || []).flatMap((k) => k.notes.map((n) => ({ ...n, key: k })));
  const unread = () => sale?.unread || [];     // outputs at the sale keys that the read could not open
  const retry = () => { readErr = false; sale = null; render(); look().catch(() => {}); };
  const listing = (n) => (book?.sales || []).find((s) => !s.expired && s.asset_outpoint?.txid === n.txid && s.asset_outpoint?.vout === n.vout) || null;
  const listable = () => held().filter((n) => ready.has(opKey(n)) && !listing(n));
  const chosen = () => { const l = listable(); return l.find((n) => opKey(n) === pick) || l[0] || null; };

  // the price as typed, read by the page's amount rule (a decimal comma is a point; a lone comma before three digits is refused)
  const price = () => { try { return Number(parseUnits(priceEl.value, 8)) / 1e8; } catch { return NaN; } };
  function recompute() {
    const px = price();
    const n = chosen();
    let units = n ? n.value : 0n;
    if (!n) { try { units = parseUnits(amt.value); } catch { units = 0n; } }
    const q = document.getElementById('sats-quote');
    if (!q) return;
    if (!Number.isFinite(px) || px <= 0 || units <= 0n) { q.textContent = '—'; return; }
    // mark price is sats per whole TAC; units are 8-decimal fixed point.
    q.textContent = `${Math.floor((Number(units) / 1e8) * px).toLocaleString('en-US')} sats`;
  }
  amt.addEventListener('input', recompute);
  priceEl.addEventListener('input', recompute);

  // An address with history still works; a new one keeps the sats apart from everything else it ever held.
  payout.addEventListener('change', async () => {
    const a = payout.value.trim();
    payHint.textContent = '';
    if (!a || !ctx.T?.NET?.api) return;
    if (!ctx.S) return;
    try { payoutScript(a); } catch (e) { payHint.textContent = e.message; return; }
    try {
      const r = await fetch(`${ctx.T.NET.api}/address/${a}`);
      const j = r.ok ? await r.json() : null;
      const used = j && [j.chain_stats, j.mempool_stats].some((x) => x?.tx_count > 0);
      if (payout.value.trim() === a && used) payHint.textContent = 'This address has been used before. A new one keeps these sats apart.';
    } catch {}
  });

  // The TAC already taken out to sale keys, read from the chain and opened from the pool seed, so it shows on any device.
  function look() {
    const pw = ctx.poolWallet, S = ctx.S, T = ctx.T;
    if (looking && lookingFor === pw) return looking;                        // a read made for another wallet does not stand in for this one's
    if (!pw || !S || !T) return Promise.resolve();
    lookingFor = pw;
    const me = looking = (async () => {
      try {
        if (!ctx.notes?.length) await loadShielded();
        const client = S.poolClientFor('mainnet');
        // The fee notes of past take-outs went to the relay's address; naming it is what lets each one be opened again.
        const info = await client.relayInfo().catch(() => null);
        const r = await S.saleKeys(T, pw, ctx.notes || [], S.TAC_ASSET_MAINNET, { addresses: info?.address ? [info.address] : [] });
        if (ctx.poolWallet !== pw) return;
        sale = r;
        await Promise.all(held().filter((n) => !ready.has(opKey(n))).map(async (n) => {
          const x = await client.exit(n.txid, n.vout).catch(() => null);
          if (x?.exists) ready.add(opKey(n));
        }));
        readErr = false;
        render();
      } catch (e) {
        // A read that fails is said so: a page that shows nothing reads as TAC that is gone.
        if (ctx.poolWallet === pw) { readErr = true; render(); }
        throw e;
      }
    })().finally(() => { if (looking === me) looking = null; });
    return me;
  }

  // The pool counts a take-out three confirmations after its carrier, about half an hour on, and a tab left open through
  // that wait should not need a reload: each minute the notes still waiting are asked about again, one request apiece.
  async function recheck() {
    const waiting = held().filter((n) => !ready.has(opKey(n)));
    if (!waiting.length || !ctx.S || document.hidden || host.closest('[hidden]')) return;
    const client = ctx.S.poolClientFor('mainnet');
    let any = false;
    await Promise.all(waiting.map(async (n) => {
      const x = await client.exit(n.txid, n.vout).catch(() => null);
      if (x?.exists === true) { ready.add(opKey(n)); any = true; }
    }));
    if (any) render();
  }
  setInterval(() => { if (host.isConnected) recheck().catch(() => {}); }, 60_000);

  // A payout script a listing takes (secret.js payoutScriptFor: bc1q… or bc1p…, checksummed).
  const payoutScript = (addr) => ctx.S.payoutScriptFor(addr);
  // The newest Bitcoin block's time.
  const tipTime = async () => { const r = await fetch(`${ctx.T.NET.api}/blocks`); const b = r.ok ? await r.json() : null; return Number(b?.[0]?.timestamp) || 0; };
  // The listing, signed by the sale key in this page's turn of tacit.js (secret.js listFromSaleKey).
  const listAs = (key, note, opts) => ctx.turn(async () => {
    if (!ctx.T.wallet.priv) throw new Error('Open your Tacit wallet first.');
    return ctx.S.listFromSaleKey(ctx.T, { key, note, ...opts });
  });

  async function doOut() {
    await ensureKey();
    const S = ctx.S, pw = ctx.poolWallet;
    const units = parseUnits(amt.value);
    if (units <= 0n) throw new Error('Enter an amount above zero.');
    await loadShielded();   // a cold unlock has not scanned the pool yet
    if (units + fee() > shieldedTotal()) throw new Error(fee() ? `More than your shielded balance with the relay’s ${fmt(fee())} TAC fee.` : 'More than your shielded balance.');
    say('st-sats-1', 'Finding a new key for this sale…');
    await look();
    if (ctx.poolWallet !== pw || sale?.free == null) throw new Error('Your Tacit wallet changed, so nothing was done.');
    const r = await S.exitToSaleKey(ctx.T, {
      poolWallet: pw, amount: units, asset: S.TAC_ASSET_MAINNET, key: S.saleKey(pw, sale.free), maxFee: ctx.feeCap?.() ?? null,
      say: (m) => say('st-sats-1', m),
    }).catch((e) => {
      if (e?.feeMoved == null || !ctx.feeMoved) throw e;
      try { ctx.feeMoved(e); } finally { render(); }   // the page takes up the new fee and says so; the fee line here follows it
    });
    if (r.wait) {
      say('st-sats-1', `Your newest note needs ${ctx.blocksText(r.wait)} before it can be spent against a settled block. Try again after that.`);
      return;
    }
    if (r.revealTxid) pick = `${r.revealTxid}:${r.exitVout}`;
    say('st-sats-1', `${fmt(units)} TAC is on its way to a new key`, ...(r.revealTxid ? [', posted by the relay in ', txLink(r.revealTxid)] : [', posted by the relay']),
      '. It can be listed once the pool counts it, three confirmations from now (about 30 minutes).');
    await loadShielded();
    await looking?.catch(() => {});   // a read already under way began before this take-out and would miss it
    sale = null;
    await look().catch(() => {});     // the take-out is done: a read that fails shows its own note and retry, and does not unsay it
  }

  async function doList() {
    await ensureKey();
    const n = chosen();
    if (!n) throw new Error(held().length ? 'Nothing is ready to list yet: the pool counts a take-out three confirmations after it is posted.' : 'Take some TAC out first.');
    const dest = payout.value.trim();
    if (!dest) throw new Error('Enter the address to pay the sats to.');
    const script = payoutScript(dest), T = ctx.T;
    if (hexOf(script) === hexOf(T.p2wpkhScript(T.wallet.pub))) throw new Error('That is this wallet’s own address. Use one from another wallet, so the sats land apart from it.');
    if ((sale?.keys || []).some((k) => k.scriptPubKey === hexOf(script))) throw new Error('That is a key this page made for a sale. Use an address from another wallet.');
    const px = price();
    if (!Number.isFinite(px) || px <= 0) throw new Error('Set a price in sats per TAC.');
    const sats = Math.floor((Number(n.value) / 1e8) * px);
    if (sats < 546) throw new Error('That comes to less than the 546-sat dust limit. Raise the price.');
    const days = Number(lasts.value) || 3;
    // the listing runs by the chain's clock where that is ahead of this device's: a device hours slow would list for less than chosen, or not at all
    const now = Math.max(Math.floor(Date.now() / 1000), await tipTime().catch(() => 0));

    say('st-sats-2', 'Signing the listing with the sale key…');
    const rec = await listAs(n.key, n, {
      sats,
      expiry: now + days * DAY,
      payoutScript: script,
      onProgress: (m) => say('st-sats-2', String(m)),
    });
    say('st-sats-2', `Listed ${fmt(n.value)} TAC for ${sats.toLocaleString('en-US')} sats, for ${days === 1 ? 'a day' : `${days} days`}. A buyer settles it and pays ${dest.slice(0, 12)}… directly. Nothing more to do.`,
      rec?.sale_id ? el('div', { class: 'note' }, `Sale ${String(rec.sale_id).slice(0, 12)}…`) : null);
    pick = null;
    book = (await openSales()) || book;
    render();
  }

  const until = (s) => new Date(Number(s.expiry) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  function heldRow(n) {
    const l = listing(n), on = opKey(n) === opKey(chosen() || {});
    const state = l ? `listed for ${Number(l.min_price_sats).toLocaleString('en-US')} sats until ${until(l)}`
      : ready.has(opKey(n)) ? 'ready to list'
        : 'waiting for the pool to count it';
    const pickable = !l && ready.has(opKey(n)) && listable().length > 1;
    return el('div', { class: 'kv' },
      pickable
        ? el('label', {}, el('input', on ? { type: 'radio', name: 'sats-pick', checked: '' } : { type: 'radio', name: 'sats-pick' }), ` ${fmt(n.value)} TAC`)
        : el('span', {}, `${fmt(n.value)} TAC`),
      el('b', {}, state));
  }

  function render() {
    const f = fee(), rows = held(), miss = unread();
    // the field being typed in keeps its place: putting it back under the host takes its focus
    const at = document.activeElement, kept = at && host.contains(at) ? at : null, s0 = kept?.selectionStart, s1 = kept?.selectionEnd;
    fill(host,
      el('p', { class: 'note', style: 'margin-top:0' },
        'Sell shielded TAC for sats. A new key made for this sale lists it, and the buyer pays sats straight to an address you name. This wallet’s address takes no part, so nothing ties those sats to it.'),

      el('div', { class: 'lbl' }, el('label', { for: 'sats-amt' }, 'Amount to take out'),
        el('button', { class: 'link', type: 'button', onclick: () => { const m = shieldedTotal() - f; amt.value = m > 0n ? plain(m) : '0'; recompute(); } }, 'Max')),
      el('div', { class: 'amt' }, amt, el('span', { class: 'u' }, 'TAC')),

      el('div', { class: 'lbl' }, el('label', { for: 'sats-price' }, 'Price'),
        mark ? el('button', { class: 'link', type: 'button', onclick: () => { priceEl.value = pxText(mark); recompute(); } }, `Market · ${pxText(mark)} sats`) : el('span', {}, markRead ? 'Market price unavailable' : 'Reading the market…')),
      el('div', { class: 'amt' }, priceEl, el('span', { class: 'u' }, 'sats / TAC')),
      quote,
      book?.count != null ? el('div', { class: 'kv' }, el('span', {}, 'Open sales on the book'), el('b', {}, String(book.count))) : null,

      el('div', { class: 'lbl sep' }, el('label', { for: 'sats-payout' }, 'Pay the sats to')),
      el('div', { class: 'amt text' }, payout),
      el('p', { class: 'note' }, 'Ideally a new address from another wallet. It needs no funds first.'),
      payHint,
      el('div', { class: 'lbl' }, el('label', { for: 'sats-lasts' }, 'Listing lasts'), lasts),

      el('p', { class: 'eyebrow', style: 'margin-top:22px' }, 'Step 1: take it out'),
      f ? el('p', { class: 'note' }, `The relay’s fee is ${fmt(f)} TAC, from your shielded balance.`) : null,
      btnOut,
      statusStep1,

      el('p', { class: 'eyebrow', style: 'margin-top:18px' }, 'Step 2: list for sats'),
      readErr ? el('p', { class: 'note' }, 'Could not read what you have taken out. Nothing is lost: it stays at its own key. ',
        el('button', { class: 'link', type: 'button', onclick: retry }, 'Retry')) : null,
      miss.length ? el('p', { class: 'note' }, `Could not read ${miss.length === 1 ? 'one output' : `${miss.length} outputs`} at your sale keys: ${miss.map((u) => `${u.txid.slice(0, 8)}…:${u.vout}`).join(', ')}. `,
        el('button', { class: 'link', type: 'button', onclick: retry }, 'Retry')) : null,
      // said only once the read has finished, and never over an output it could not open
      sale && !readErr && !rows.length && !miss.length ? el('p', { class: 'note' }, 'Found no TAC at this wallet’s sale keys.') : null,
      ...rows.map(heldRow),
      btnList,
      statusStep2,
      el('p', { class: 'note' }, 'Listing is a free signature and stands until it ends. The relay sees your connection when it takes the TAC out and the market when you list, so Tor or a VPN for the listing keeps the two apart.'),
    );
    if (kept && host.contains(kept)) { kept.focus({ preventScroll: true }); try { if (s0 != null) kept.setSelectionRange(s0, s1); } catch { /* a field with no selection */ } }
    host.querySelectorAll('input[name="sats-pick"]').forEach((r, i) => r.addEventListener('change', () => { pick = opKey(listable()[i]); recompute(); }));
    btnList.disabled = !chosen();
    recompute();
    // the pool panel keeps a line of its own for this, since the balance there counts only what is still in the pool
    ctx.held?.(sale && !readErr ? { units: rows.reduce((t, n) => t + n.value, 0n), count: rows.length, unread: miss.length } : null);
  }

  btnOut.addEventListener('click', () => busy(btnOut, 'st-sats-1', doOut));
  btnList.addEventListener('click', () => busy(btnList, 'st-sats-2', doList));
  window.addEventListener('tac:wallet', () => { sale = null; ready.clear(); pick = null; readErr = false; render(); look().catch(() => {}); });

  render();
  // the page's header already holds the mark price once it has read it; the market is asked only while it does not
  (ctx.markSats != null ? Promise.resolve(ctx.markSats) : markPriceSats()).then((m) => { if (m) { mark = m; if (!priceEl.value) priceEl.value = pxText(m); } }).catch(() => {}).finally(() => { markRead = true; render(); });
  openSales().then((b) => { book = b; render(); }).catch(() => {});
  look().catch(() => {});
}
