// The Tacit wallet's sign-in sheet and its wallet picker, drawn as the front page draws them (signIn() in index.html): a first visit sees the ways in as
// rows; a browser that has opened a Tacit wallet sees each one by its address and what opens it, and the other ways in as tiles. Every page that opens a
// Tacit key opens it from here (trade/key.js for the pages with a key session, trade/btc.js for the Bitcoin market), so the sheet is the same on each.
// What the sheet looks like is trade/sheet.js's; this file is what it says and does.
import { overlay, esc, mark } from '/trade/sheet.js?cb=1161dd4e';
import { short } from '/trade/util.js?cb=1d2cd8d3';

export class Cancelled extends Error { constructor(m = 'Cancelled.') { super(m); this.unlockCancelled = true; } }

const lc = (s) => String(s || '').toLowerCase();
const ADDR_SEEN = 'tacit-lite-addr-v1';      // pubkey -> Tacit address of each key the front page opened (public: never a pasted key's)
const seenAddr = (w) => {
  if (typeof w?.tacit === 'string') return w.tacit;
  try { const a = JSON.parse(localStorage.getItem(ADDR_SEEN))?.[lc(w?.pubHex)]; return typeof a === 'string' ? a : null; } catch { return null; }
};
const tacitShort = (a) => `${a.slice(0, 16)}…${a.slice(-6)}`;
const nw = (s) => `<span class="nw">${esc(s)}</span>`;
const via = (k) => ({ eth: `Ethereum ${nw(short(k.address || ''))}`, btc: `Bitcoin ${nw(short(k.address || '', 6))}`, passkey: `passkey “${esc(k.label || 'Tacit')}”` })[k?.mode] || 'your wallet';
const viaMark = (k) => mark(k?.mode === 'eth' ? 'eth' : k?.mode === 'btc' ? 'btc' : 'key');

const WHY = 'Open your Tacit wallet to make ETH private. It stays open in this tab only, until you close it, lock it, or leave the site idle for 30 minutes.';

// Which of several Ethereum wallets signs, chosen in a sheet over the sign-in sheet: resolves to its uuid, or null when closed.
export function pickWalletSheet(list) {
  return new Promise((resolve) => {
    let chosen = null;
    const o = overlay({ title: 'Choose a wallet', top: true, onClose: () => resolve(chosen) });
    o.body.innerHTML = `<div class="picker">${list.map((w) => `<button class="way" type="button" data-uuid="${esc(w.uuid)}"><span class="way-t">${/^data:image\//.test(w.icon || '') ? `<img src="${esc(w.icon)}" alt="">` : ''}<span>${esc(w.name)}</span></span></button>`).join('')}</div>`;
    o.body.querySelectorAll('[data-uuid]').forEach((b) => { b.onclick = () => { chosen = b.dataset.uuid; o.close(); }; });
  });
}

// The ways in, in a sheet. Resolves once a key is open; rejects with Cancelled when the sheet is closed without one.
// `session` is a key session (trade/key.js, trade/btc-session.js): what it can open is what the sheet offers (`open.btc` a Bitcoin wallet, `open.key` a
// pasted key, `elsewhere()` the wallet a page cannot open). `pick(list)` chooses among several Ethereum wallets (by default the visitor chooses, in a sheet);
// `why` says what the key is for; `first: 'btc'` leads with a Bitcoin wallet; `here` is an Ethereum wallet this page has connected ({ uuid, address }):
// it signs with no choice to make, and the wallet it opens is marked connected.
export function signInSheet(session, { pick = pickWalletSheet, why = WHY, first = 'eth', here = null } = {}) {
  return new Promise((resolve, reject) => {
    session.warm?.();
    const known = session.known(), other = session.other(), away = session.elsewhere?.() || null;
    const pk = session.passkeyAvailable(), canBtc = typeof session.open.btc === 'function', canPaste = typeof session.open.key === 'function';
    const connected = (k) => !!(here && k?.mode === 'eth' && lc(k.address) === lc(here.address));
    const pickFor = (k) => (here?.uuid && (!k?.address || connected(k)) ? async () => here.uuid : pick);
    const o = overlay({ title: 'Wallet', top: true, onClose: () => { if (!session.unlocked) reject(new Cancelled()); } });
    const opt = (k, t, m, cls = '') => `<button class="opt${cls ? ` ${cls}` : ''}" type="button" data-in="${k}"><span class="opt-t">${t}</span><span class="opt-m">${m}</span></button>`;
    const way = (k, id, name, title) => `<button class="way" type="button" data-in="${k}" title="${esc(title)}">${mark(id)}<span>${name}</span></button>`;
    // a Tacit wallet this browser has opened: its address when it is known, and what opens it
    const mine = (k, w, main) => {
      const t = seenAddr(w);
      return opt(k, `${mark('tac')}${t ? `<span class="num">${esc(tacitShort(t))}</span>` : '<b>Tacit wallet</b>'}`,
        `${viaMark(w)}<span>Opens with ${via(w)}</span>${connected(w) ? '<span class="wl-on">connected</span>' : ''}`, `mine${main ? ' main' : ''}`);
    };
    let rows;
    if (known || other) {
      const eth = way('eth', 'eth', 'Ethereum', 'MetaMask, Rabby, Rainbow, any browser wallet, or WalletConnect'), btc = canBtc ? way('btc', 'btc', 'Bitcoin', 'Xverse, Leather or UniSat') : '';
      // the Ethereum wallet connected here is already offered above, as what opens one of the wallets
      const tiles = (first === 'btc' ? [btc, eth] : [eth, btc]).filter((x) => x && !(x === eth && (connected(known) || connected(other))));
      rows = `<div class="lbl"><span>${known && other ? 'Open a wallet' : 'Open your wallet'}</span></div>
        ${known && other ? '<p class="note">Two separate wallets, each with its own address and balances.</p>' : ''}
        ${known ? mine('known', known, true) : ''}${other ? mine('other', other, !known) : ''}
        <div class="lbl"><span>Other ways in</span></div>
        <div class="ways">${tiles.join('')}${pk ? way('passkey', 'key', 'Passkey', 'Touch ID, Windows Hello or a security key') : ''}</div>`;
    } else {
      const eth = opt('eth', `${mark('eth')}Ethereum wallet`, here ? `${esc(short(here.address))} is connected here. One free signature, two the first time.` : 'MetaMask, Rabby, Rainbow, any browser wallet, or WalletConnect. One free signature, two the first time.', here ? 'main' : '');
      const btc = canBtc ? opt('btc', `${mark('btc')}Bitcoin wallet`, `Xverse, Leather or UniSat. ${session.btcSeen && !session.btcSeen() ? 'None found in this browser.' : 'One free signature, two the first time.'}`, first === 'btc' ? 'main' : '') : '';
      rows = `${first === 'btc' ? btc + eth : eth + btc}
        ${pk ? opt('passkey', `${mark('key')}Passkey`, 'Already made one? Touch ID, Windows Hello or a security key.') : ''}
        ${pk ? opt('new', `${mark('key')}No wallet yet? Create one`, 'Touch ID, Face ID or Windows Hello. Nothing to install.') : ''}`;
    }
    const links = [canPaste ? '<button class="link" type="button" data-in="paste">Paste a key</button>' : '', pk && (known || other) ? '<button class="link" type="button" data-in="new">New passkey wallet</button>' : ''].join('');
    o.body.innerHTML = `${why ? `<p class="lede-s">${esc(why)}</p>` : ''}<div class="opts">
      ${rows}
      ${away ? `<p class="note">The wallet open on tacit.finance was opened another way (${canBtc ? 'a key saved in the browser' : 'a Bitcoin wallet or a key saved in the browser'}). That one opens on <a href="/">tacit.finance</a>${canPaste ? ', or paste its key here' : ''}.</p>` : ''}
      <p class="note err" role="alert" hidden></p>
      ${links ? `<p class="more">${links}</p>` : ''}
      ${canPaste ? '<form class="amt" hidden><input type="password" placeholder="64-character Tacit key" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Tacit key"><button class="link" type="submit" data-in="key">Open</button></form>' : ''}
    </div>`;
    const paste = o.body.querySelector('form.amt'), err = o.body.querySelector('.note.err');
    o.body.querySelector('[data-in="paste"]')?.addEventListener('click', () => { paste.hidden = !paste.hidden; if (!paste.hidden) paste.querySelector('input').focus(); });
    paste?.addEventListener('submit', (e) => e.preventDefault());
    const ins = [...o.body.querySelectorAll('[data-in]')].filter((b) => b.dataset.in !== 'paste');
    let busy = false;
    for (const b of ins) b.onclick = async () => {
      if (busy) return;
      busy = true; err.hidden = true; b.setAttribute('aria-busy', 'true'); ins.forEach((x) => { x.disabled = true; });
      try {
        const k = b.dataset.in;
        if (k === 'known') await session.open[known.mode](known, pickFor(known));
        else if (k === 'other') await session.open[other.mode](other, pickFor(other));
        else if (k === 'new') await session.open.newPasskey();
        else if (k === 'key') { const input = paste.querySelector('input'); await session.open.key(input.value); input.value = ''; }
        else if (k === 'eth') await session.open.eth(here ? { address: here.address } : undefined, pickFor(null));
        else await session.open[k](undefined, pick);
        o.close(); resolve();
      } catch (e) {
        if (!/cancel/i.test(e?.message || '') && e?.name !== 'NotAllowedError' && !e?.unlockCancelled && e?.code !== 4001) { err.textContent = e?.message || 'Could not open your Tacit wallet. Try again.'; err.hidden = false; }
      } finally { busy = false; b.removeAttribute('aria-busy'); ins.forEach((x) => { x.disabled = false; }); }
    };
  });
}
