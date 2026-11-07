// The tacit chain's page, drawn from a state and nothing else: the chain as anyone sees it (read from Ethereum and its leader), and with a
// key open what the key holds there and anything of its that waits. Every move is the front page's tile, so each action here is a link to
// the flow there that shows it. No network and no key in this module (tests/tacit-chain-page-ui.test.mjs draws it under jsdom).
//
//   const ui = mountChain({ root, actions: { signIn(), copy(text), publish(), lock() } });
//   ui.render({ on, status, now, key, note })
//     on      whether the chain is deployed (else one quiet line and nothing more)
//     status  null while it is read, 'error' when it could not be, or chainStatus()'s { height, lastLanded, pool, shares, leader }
//     now     the time, in milliseconds
//     key     null with no key open, or { address, published (null: not known yet, true, false), publishing, balance (units, null while
//             read), kept (the client's pending(), each with unswept, paid and backAt as the page reads them), hops (hopsWaiting()) }
//     note    a line under the key's panel (a copy, a refusal)

export const UNIT = 10n ** 8n;                 // the chain counts TAC in units of 1e-8
const VIRTUAL = 100_000_000n;                  // the pool and shares the rate counts that no note holds (tacit-chain-wallet.js VIRTUAL)
const HOP_WAIT = 5 * 60e3;                     // a landed hop the leader has not sent on after this long is offered here

// The tile's flows that show each kind of kept spend (dapp/index.html chainKeptPaint), and its three ways in
export const CARD = {
  shield: '/#card=shield:wtac:chain',
  inbox: '/#card=shield:tac:chain',
  out: '/#card=shield:ctac:wallet',
  hop: '/#card=shield:ctac:defi',
  send: '/#card=send:ctac',
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

/// `units` of 1e-8 TAC as TAC, grouped, with at most `dp` decimals (rounded down).
export function fmtTac(units, dp = 4) {
  const v = big(units), neg = v < 0n, a = neg ? -v : v;
  const whole = (a / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (a % UNIT).toString().padStart(8, '0').slice(0, dp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
/// TAC's own wei (18 decimals) as TAC.
export const fmtWei = (wei, dp = 4) => fmtTac(big(wei) / 10n ** 10n, dp);

/// What 1 TAC of shares from the start is worth now, in TAC: (pool + V) / (shares + V), to `dp` decimals (rounded down).
export function sharePrice(pool, shares, dp = 6) {
  const s = 10n ** BigInt(dp), v = (big(pool) + VIRTUAL) * s / (big(shares) + VIRTUAL);
  return `${v / s}.${(v % s).toString().padStart(dp, '0')}`;
}

/// How long ago, in plain words, from a number of seconds.
export function ago(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 10) return 'just now';
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/// A Tacit address shortened for a row.
export const shortAddr = (a, n = 10) => (!a ? '' : a.length > 2 * n + 4 ? `${a.slice(0, n + 4)}…${a.slice(-n)}` : a);

// What a kept spend is, in the words the tile uses for it (dapp/index.html chainWhat), and the flow of the tile that shows it
const fromWallet = (e) => e.kind === 'shield' && (!e.inbox || e.src === 'wallet');
function whatOf(e) {
  const of = e.units ? ` of ${fmtTac(e.units)} TAC` : '';
  if (fromWallet(e)) return `A shield${of}`;
  if (e.inbox) return `A move${of} from the private pool`;
  if (e.kind === 'pay') return `A payment${of}`;
  if (e.kind === 'hop') return `A move${of} to the private pool`;
  return `A withdrawal${of}`;
}
const hrefOf = (e) => (fromWallet(e) ? CARD.shield : e.inbox ? CARD.inbox : e.kind === 'hop' ? CARD.hop : CARD.out);

/// One kept spend as the page shows it: { what, say, links: [{ label, href }] }. `now` in milliseconds.
export function keptView(e, now = Date.now()) {
  const what = whatOf(e), href = hrefOf(e);
  if (e.unswept) return { what, say: 'is on its way to the Tacit chain.', links: e.paid ? [{ label: 'Send it in', href }] : [] };
  const links = [];
  if (!e.forced) links.push({ label: 'Post it to Ethereum', href });
  if (e.deposit && e.backAt && now / 1000 >= e.backAt) links.push({ label: 'Take it back', href });
  return { what, say: `has not landed.${e.forced ? ' Posted to Ethereum.' : ''}`, links };
}
/// A landed hop not sent on into the private pool: shown once it has waited a while.
export function hopView(h) {
  return { what: `A move of ${fmtTac(h.units)} TAC to the private pool`, say: 'has not been sent on.', links: [{ label: 'Send it on', href: CARD.hop }] };
}
export const hopsDue = (hops, now = Date.now()) => (hops || []).filter((h) => now - Number(h.at || 0) > HOP_WAIT);

const row = (k, v, tip = '') => `<div class="kv"${tip ? ` title="${esc(tip)}"` : ''}><span>${esc(k)}</span><b>${v}</b></div>`;
const links = (ls) => ls.map((l) => `<a class="go" href="${esc(l.href)}">${esc(l.label)}</a>`).join('');

function statusHtml(st, now) {
  if (st == null) return `<p class="eyebrow">Status</p><p class="empty">Reading…</p>`;
  if (st === 'error') return `<p class="eyebrow">Status</p><p class="empty">Could not read the chain. Try again in a moment.</p>`;
  const L = st.leader, off = '<span class="mute">not answering</span>';
  // (the contract stamps its deploy time as the last landing: no block has landed until the height moves)
  const last = st.height > 0 && st.lastLanded > 0 ? ago(now / 1000 - st.lastLanded) : 'none yet';
  return `<p class="eyebrow">Status</p><div class="rows flat">
    ${row('Status', '<span class="live"><i class="dot on" aria-hidden="true"></i>Live</span>')}
    ${row('Blocks', `<span class="num">${esc(Number(st.height).toLocaleString('en-US'))}</span>`)}
    ${row('Last block', esc(last))}
    ${row('Share price', `<span class="num">${esc(sharePrice(st.pool, st.shares))}</span>`, 'What 1 TAC of shares from the start is worth now, in TAC')}
    ${row('Pool', `<span class="num">${esc(fmtTac(st.pool))}</span> TAC`)}
    ${row('Leader fee', L ? (L.fee > 0n ? `<span class="num">${esc(fmtTac(L.fee))}</span> TAC a move` : 'none') : off)}
    ${row('Shield cap', L ? (L.shieldCap != null ? `up to <span class="num">${esc(fmtTac(L.shieldCap))}</span> TAC` : 'none') : off)}
  </div>`;
}

function keyHtml(k, now, note) {
  if (!k) return `<p class="eyebrow">Yours</p><p class="empty">Your TAC on the Tacit chain is in your wallet, with the rest of your coins.</p>
    <button class="btn" type="button" data-act="signin">Open your wallet</button>${note ? `<p class="status">${esc(note)}</p>` : ''}`;
  const pub = k.published === false ? `<button class="linkbtn" type="button" data-act="publish"${k.publishing ? ' disabled' : ''}>${k.publishing ? 'Publishing…' : 'Publish'}</button>`
    : k.published === true ? '<span class="mute">Published</span>' : '';
  const addr = k.address ? `<span class="mono" title="${esc(k.address)}">${esc(shortAddr(k.address))}</span>` : '<span class="mute">Reading…</span>';
  const kept = (k.kept || []).map((e) => keptView(e, now)), hops = hopsDue(k.hops, now).map(hopView), all = [...kept, ...hops];
  return `<p class="eyebrow"><span>Yours</span><button class="linkbtn who" type="button" data-act="lock">Lock</button></p><div class="rows flat">
    ${row('Balance', k.balance == null ? '<span class="mute">Reading…</span>' : `<span class="num">${esc(fmtTac(k.balance))}</span> TAC`)}
    <div class="kv addr"><span>Address</span><b>${addr}<span class="acts">${k.address ? '<button class="linkbtn" type="button" data-act="copy">Copy</button>' : ''}${pub}</span></b></div>
  </div>
  ${all.length ? `<p class="eyebrow sub">Waiting</p><ul class="kept">${all.map((v) => `<li><span>${esc(v.what)} ${esc(v.say)}</span>${v.links.length ? `<span class="acts">${links(v.links)}</span>` : ''}</li>`).join('')}</ul>` : ''}
  ${note ? `<p class="status">${esc(note)}</p>` : ''}`;
}

export function mountChain({ root, actions = {} }) {
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest?.('[data-act]');
    if (!b || b.disabled) return;
    const a = b.dataset.act;
    if (a === 'signin') actions.signIn?.();
    else if (a === 'copy') actions.copy?.();
    else if (a === 'publish') actions.publish?.();
    else if (a === 'lock') actions.lock?.();
  });
  // (drawn again only when something in it changed, so a timer's redraw keeps the focus where it is)
  function render(s) {
    const now = s.now ?? Date.now();
    const h = !s.on ? '<p class="off">Not live yet</p>'
      : `<section class="panel" id="status" aria-live="polite">${statusHtml(s.status, now)}</section>
      <section class="panel" id="mine">${keyHtml(s.key, now, s.note)}</section>
      <nav class="ways-in" id="acts" aria-label="On the Tacit chain"><a href="${CARD.shield}">Shield</a><a href="${CARD.send}">Send</a><a href="${CARD.out}">Withdraw</a></nav>`;
    if (root.__h !== h) { root.__h = h; root.innerHTML = h; }
  }
  return { render };
}
