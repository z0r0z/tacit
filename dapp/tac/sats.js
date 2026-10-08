// "Withdraw to sats" — the two hops that turn shielded TAC into real bitcoin.
//
//   1. Withdraw. The TAC leaves the pool as an ordinary note in this wallet. This hop funds its own
//      Bitcoin fee.
//   2. List. publishPreauthSale signs an authorization and POSTs it — no transaction, no fee. A buyer
//      settles it alone and pays sats straight to a payout address you name, which can be a wallet that
//      has never held anything and never touches this page's key.
//
// The listing price defaults to the worker's mark price for TAC, which is computed from real trades.

const WORKER = 'https://api.tacit.finance';
const ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const DAY = 86400;

// A mainnet segwit address → its scriptPubKey. BIP-173 for v0 (bc1q) and BIP-350 for v1+ (bc1p); the two
// differ only in the checksum constant, and using the wrong one for a version is itself invalid. Anything
// else — legacy base58, a testnet HRP, a bad checksum, a mixed-case string — is refused rather than
// guessed at, because this script is where someone's sale proceeds land.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function expandHrp(hrp) {
  const r = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >>> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}
function convert5to8(words) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of words) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error('bad padding');
  return Uint8Array.from(out);
}
export function addressToScript(addr) {
  const s = String(addr || '').trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('That address mixes upper and lower case — retype it.');
  const a = s.toLowerCase();
  if (!/^bc1[02-9ac-hj-np-z]{6,}$/.test(a)) throw new Error('Use a mainnet address (bc1…).');
  const words = [];
  for (const ch of a.slice(3)) {
    const i = CHARSET.indexOf(ch);
    if (i === -1) throw new Error('That address has a character that cannot appear in one.');
    words.push(i);
  }
  if (words.length < 7) throw new Error('That address is too short.');
  const ver = words[0];
  if (ver > 16) throw new Error('Unknown witness version.');
  const want = ver === 0 ? 1 : 0x2bc830a3;   // BIP-173 vs BIP-350
  if (polymod(expandHrp('bc').concat(words)) !== want) throw new Error('That address did not check out — retype it.');
  const prog = convert5to8(words.slice(1, -6));
  if (ver === 0 && prog.length !== 20 && prog.length !== 32) throw new Error('Unsupported v0 address length.');
  if (prog.length < 2 || prog.length > 40) throw new Error('Unsupported witness program length.');
  const out = new Uint8Array(2 + prog.length);
  out[0] = ver === 0 ? 0x00 : 0x50 + ver;
  out[1] = prog.length;
  out.set(prog, 2);
  return out;
}

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

export function mount(host, ctx) {
  const { ensureKey, busy, say, fmt, parseUnits, shieldedTotal, txLink, loadShielded } = ctx;
  // fmt() groups thousands, which parseUnits rejects — inputs get the ungrouped form.
  const plain = (u) => fmt(u).replace(/,/g, '');

  let mark = null;          // sats per whole TAC
  let book = null;          // open sales on the mainnet book
  let exited = null;        // { txid, vout, units } once the withdrawal lands

  const amt = el('input', { id: 'sats-amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
  const payout = el('input', { id: 'sats-payout', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'bc1…' });
  const priceEl = el('input', { id: 'sats-price', inputmode: 'numeric', autocomplete: 'off', placeholder: '—' });
  const quote = el('div', { class: 'kv' }, el('span', {}, 'You receive'), el('b', { id: 'sats-quote' }, '—'));

  const statusStep1 = el('div', { class: 'status', id: 'st-sats-1' });
  const statusStep2 = el('div', { class: 'status', id: 'st-sats-2' });

  const btnExit = el('button', { class: 'btn' }, 'Withdraw from the pool');
  const btnList = el('button', { class: 'btn' }, 'List for sats');

  function recompute() {
    const px = Number(priceEl.value);
    let units = 0n;
    try { units = parseUnits(amt.value); } catch { units = 0n; }
    if (!Number.isFinite(px) || px <= 0 || units <= 0n) { document.getElementById('sats-quote').textContent = '—'; return; }
    // mark price is sats per whole TAC; units are 8-decimal fixed point.
    const sats = Math.floor((Number(units) / 1e8) * px);
    document.getElementById('sats-quote').textContent = `${sats.toLocaleString('en-US')} sats`;
  }
  amt.addEventListener('input', recompute);
  priceEl.addEventListener('input', recompute);

  async function doExit() {
    await ensureKey();
    const T = ctx.T, S = ctx.S;
    const units = parseUnits(amt.value);
    if (units <= 0n) throw new Error('Enter an amount above zero.');
    await loadShielded();   // a cold unlock has not scanned the pool yet
    if (units > shieldedTotal()) throw new Error('More than your shielded balance.');
    const r = await S.exitToWallet(T, {
      poolWallet: ctx.poolWallet, amount: units, asset: S.TAC_ASSET_MAINNET,
      say: (m) => say('st-sats-1', m),
    });
    if (r.wait) {
      say('st-sats-1', `Your newest note needs ${r.wait} more Bitcoin block${r.wait === 1 ? '' : 's'} before the wallet spends it against a settled block. Try again shortly, or withdraw from the "To my wallet" tab, which offers to spend now.`);
      return;
    }
    exited = { txid: r.revealTxid, vout: 0, units };
    say('st-sats-1', `${fmt(units)} TAC withdrawn in `, txLink(r.revealTxid), '. Once it confirms, list it below.');
    await loadShielded();
    render();
  }

  async function doList() {
    await ensureKey();
    const T = ctx.T;
    if (!exited) throw new Error('Withdraw from the pool first.');
    const dest = payout.value.trim();
    if (!dest) throw new Error('Give a Bitcoin address for the sats to land at.');
    const px = Number(priceEl.value);
    if (!Number.isFinite(px) || px <= 0) throw new Error('Set a price in sats per TAC.');
    const sats = Math.floor((Number(exited.units) / 1e8) * px);
    if (sats < 546) throw new Error('That comes to less than the 546-sat dust limit. Sell more, or raise the price.');

    const script = addressToScript(dest);

    say('st-sats-2', 'Signing the listing…');
    const sale = await T.publishPreauthSale({
      utxoTxid: exited.txid,
      utxoVout: exited.vout,
      minPriceSats: sats,
      expiry: Math.floor(Date.now() / 1000) + 7 * DAY,
      sellerPayoutScript: script,
      onProgress: (m) => say('st-sats-2', String(m)),
    });
    say('st-sats-2', `Listed ${fmt(exited.units)} TAC for ${sats.toLocaleString('en-US')} sats. A buyer settles it and pays ${dest.slice(0, 12)}… directly — you need nothing further.`, sale?.sale_id ? el('div', { class: 'note' }, `Sale ${String(sale.sale_id).slice(0, 12)}…`) : null);
    exited = null;
    render();
  }

  function render() {
    const depth = book?.count ?? null;
    host.replaceChildren(
      el('p', { class: 'note', style: 'margin-top:0' },
        'Shielded TAC out, real bitcoin in. You withdraw, which pays its own small Bitcoin fee, then list at the market price; the buyer settles and pays sats straight to an address you name. That address can be a brand-new wallet, so the sats arrive somewhere with no history at all.'),

      el('div', { class: 'lbl' }, el('label', { for: 'sats-amt' }, 'Amount to sell'),
        el('button', { class: 'link', type: 'button', onclick: () => { amt.value = plain(shieldedTotal()); recompute(); } }, 'max')),
      el('div', { class: 'amt' }, amt, el('span', { class: 'u' }, 'TAC')),

      el('div', { class: 'lbl' }, el('label', { for: 'sats-price' }, 'Price'),
        mark ? el('button', { class: 'link', type: 'button', onclick: () => { priceEl.value = String(mark); recompute(); } }, `market · ${mark} sats`) : el('span', {}, 'market price unavailable')),
      el('div', { class: 'amt' }, priceEl, el('span', { class: 'u' }, 'sats / TAC')),
      quote,
      depth != null ? el('div', { class: 'kv' }, el('span', {}, 'Open sales on the book'), el('b', {}, String(depth))) : null,

      el('div', { class: 'lbl sep' }, el('label', { for: 'sats-payout' }, 'Pay the sats to')),
      el('div', { class: 'amt text' }, payout),
      el('p', { class: 'note' }, 'A Bitcoin address you control. Use a fresh one — it never has to hold anything first, and nothing links it to the wallet on this page.'),

      el('p', { class: 'eyebrow', style: 'margin-top:22px' }, 'Step 1 — withdraw'),
      exited
        ? el('div', { class: 'kv' }, el('span', {}, 'Withdrawn, ready to list'), el('b', {}, `${fmt(exited.units)} TAC`))
        : btnExit,
      statusStep1,

      el('p', { class: 'eyebrow', style: 'margin-top:18px' }, 'Step 2 — list for sats'),
      btnList,
      statusStep2,
      el('p', { class: 'note' }, 'Listing is a signature, not a transaction: it costs nothing and needs no bitcoin. The listing stays on the book for seven days. Shielding the TAC back into the pool before a buyer takes it spends the note, which ends the listing at once.'),
    );
    btnList.disabled = !exited;
  }

  btnExit.addEventListener('click', () => busy(btnExit, 'st-sats-1', doExit));
  btnList.addEventListener('click', () => busy(btnList, 'st-sats-2', doList));

  render();
  markPriceSats().then((m) => { if (m) { mark = m; if (!priceEl.value) priceEl.value = String(m); recompute(); render(); } }).catch(() => {});
  openSales().then((b) => { book = b; render(); }).catch(() => {});
}
