// The Bitcoin market of a bridged token other than TAC. Such a token is not sold by an atomic sale (the reflection folds a plain transfer
// or sale only for TAC); it is sold into a BOUND bid: a buyer's watchtower bid, which a holder fills with a bound offer of a note, whole or
// in part (the rest back at its Bitcoin address) (one generation-bound transfer, which the reflection folds, so the buyer's note can go back to Ethereum by the fast lane). This view
// lists the bound bids with "Sell into this bid" for a holder, takes a buyer's bid ("Place a bid", through the watchtower), and lists
// the notes the buyer's bids bought, each with "Move to Ethereum". tacit.js does every check and signature (publishBoundOffer,
// placeBoundBid, boughtBoundNotes, moveBoundNoteHome). No imports: it is tested offline (tests/trade-bound.test.mjs).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function fmtUnits(v, dec) {
  const n = BigInt(v), d = BigInt(dec), one = 10n ** d, w = n / one, f = n % one;
  const fs = d ? f.toString().padStart(Number(d), '0').replace(/0+$/, '') : '';
  return `${w.toLocaleString('en-US')}${fs ? '.' + fs : ''}`;
}
export function parseUnits(s, dec) {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(String(s || ''));
  if (!m) return null;
  const f = (m[2] || '');
  if (f.length > dec) return null;
  return BigInt(m[1]) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
// sats per whole token, as the book shows it
const perUnit = (amount, sats, dec) => (BigInt(amount) > 0n ? Number(BigInt(sats) * 10n ** BigInt(dec) / BigInt(amount)) : 0);

export function mountBoundMarket(box, { T, asset, unlock = async () => {}, notify = () => {} }) {
  const { id, ticker, decimals = 8 } = asset;
  const st = { bids: [], bought: [], busy: null, err: null };
  const root = document.createElement('div');
  root.className = 'bound-mkt';
  box.append(root);

  async function load() {
    try { st.bids = await T.browseBoundBids(id); st.err = null; } catch (e) { st.err = e?.message || String(e); }
    try { st.bought = (await T.boughtBoundNotes()).filter((n) => String(n.assetIdHex).replace(/^0x/, '') === id); } catch { st.bought = []; }
    paint();
  }
  const act = (key, fn) => async () => {
    if (st.busy) return;
    st.busy = key; paint();
    try { await unlock(); await fn(); } catch (e) { notify(e?.message || String(e), 'error', 9000); } finally { st.busy = null; await load(); }
  };
  function paint() {
    const bidRows = st.bids.map((b) => {
      const amt = b.remaining_amount ?? b.amount, unit = perUnit(b.amount, b.price_sats, decimals);
      return `<li class="row" data-bid="${esc(b.bid_id)}"><span class="num">${esc(fmtUnits(amt, decimals))} ${esc(ticker)}</span>
        <span class="num mute">${unit.toLocaleString('en-US')} sats each</span>
        <input class="part" data-part="${esc(b.bid_id)}" inputmode="decimal" placeholder="Amount (optional)" aria-label="Amount of ${esc(ticker)} to sell into this bid">
        <button class="btn" type="button" data-sell="${esc(b.bid_id)}" ${st.busy ? 'disabled' : ''}>${st.busy === 'sell:' + b.bid_id ? 'Offering…' : 'Sell into this bid'}</button></li>`;
    }).join('');
    const boughtRows = st.bought.map((n, i) => `<li class="row"><span class="num">${esc(fmtUnits(n.amount, decimals))} ${esc(ticker)}</span><span class="mute">bought on Bitcoin</span>
      <button class="btn ghost" type="button" data-home="${i}" ${st.busy ? 'disabled' : ''}>${st.busy === 'home:' + i ? 'Moving…' : 'Move to Ethereum'}</button></li>`).join('');
    root.innerHTML = `
      <section><h3>Bids for ${esc(ticker)}</h3>
        ${st.err ? `<p class="err">${esc(st.err)}</p>` : bidRows ? `<ul class="rows">${bidRows}</ul>` : `<p class="note">No bids for ${esc(ticker)} on Bitcoin yet.</p>`}
        <p class="note">Selling sends a ${esc(ticker)} note on Bitcoin to the buyer, for its sats, in one transaction the buyer's watchtower completes. Enter an amount to sell part of a note: the rest comes back to your Bitcoin address. You can close the page after offering.</p></section>
      <section><h3>Place a bid</h3>
        <div class="form"><input id="bb-amt" inputmode="decimal" placeholder="Amount of ${esc(ticker)}" aria-label="Amount of ${esc(ticker)} to buy">
          <input id="bb-sats" inputmode="numeric" placeholder="Total sats" aria-label="Total sats you pay">
          <button class="btn" type="button" data-bid-place ${st.busy ? 'disabled' : ''}>${st.busy === 'bid' ? 'Placing…' : 'Place a bid'}</button></div>
        <p class="note">Your watchtower completes a seller's offer while you are away. What it buys arrives on Bitcoin and moves to Ethereum from here.</p></section>
      ${boughtRows ? `<section><h3>Bought</h3><ul class="rows">${boughtRows}</ul></section>` : ''}`;
    // the amount is read before the press repaints the view
    root.querySelectorAll('[data-sell]').forEach((b) => { b.onclick = () => { const partIn = root.querySelector(`[data-part="${b.dataset.sell}"]`)?.value || ''; return act('sell:' + b.dataset.sell, async () => {
      const bid = st.bids.find((x) => x.bid_id === b.dataset.sell);
      const part = partIn.trim() ? parseUnits(partIn, decimals) : null;
      if (partIn.trim() && (!part || part <= 0n)) throw new Error(`Enter an amount of ${ticker}, or leave it empty.`);
      const r = await T.publishBoundOffer({ assetIdHex: id, bid, ...(part ? { part } : {}) });
      notify(`Offered ${fmtUnits(r.amount, decimals)} ${ticker} for ${Number(r.priceSats).toLocaleString('en-US')} sats. The buyer's watchtower completes it; the sats arrive at your Bitcoin address.`, 'ok', 9000);
    })(); }; });
    const place = root.querySelector('[data-bid-place]');
    // the inputs are read before the press repaints the view (its button says it is placing)
    if (place) place.onclick = () => { const amtIn = root.querySelector('#bb-amt').value, satsIn = root.querySelector('#bb-sats').value; return act('bid', async () => {
      const amount = parseUnits(amtIn, decimals), sats = Number(satsIn);
      if (!amount || amount <= 0n) throw new Error(`Enter an amount of ${ticker}.`);
      if (!Number.isInteger(sats) || sats < 546) throw new Error('Enter the total sats (at least 546).');
      await T.placeBoundBid({ assetIdHex: id, amount, priceSats: sats, decimals, expiry: Math.floor(Date.now() / 1000) + 7 * 86400 });
      notify(`Bid placed for ${fmtUnits(amount, decimals)} ${ticker}.`, 'ok', 6000);
    })(); };
    root.querySelectorAll('[data-home]').forEach((b) => { b.onclick = act('home:' + b.dataset.home, async () => {
      const n = st.bought[Number(b.dataset.home)];
      await T.moveBoundNoteHome(n);
      notify(`Moving ${fmtUnits(n.amount, decimals)} ${ticker} into your private balance on Ethereum.`, 'ok', 6000);
    }); });
  }
  paint();
  load();
  return { refresh: load, destroy: () => root.remove(), state: st };
}
