// The Tacit key for the tETH page: opened from an Ethereum wallet's signature or a passkey, held in this visit's memory and never stored. What
// is stored is the public record of how it was opened, which every page that opens a Tacit key reads (tacit-wallet-known.js), so a visitor is
// offered the wallet they already use. This is /trade's own session (btc-session.js) without tacit.js, which a private deposit has no use for
// and which is four megabytes: the ways in that need it (a Bitcoin wallet, a saved key) are left to tacit.finance.
import { secp, sha256, keccak_256, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { prfBytesToScalar, prfLogin, prfRegister, loadPrfMap, savePrfMap, isPasskeyAvailable } from '/prf-wallet.js';
import { knownWallets } from '/tacit-wallet-known.js?cb=ed4c75b7';
import { makeEvmWallet } from '/evm-wallet.js?cb=b400cbe7';
import { overlay, esc } from '/trade/sheet.js?cb=84cda8f2';
import { short } from '/trade/util.js?cb=ba5a02b1';

const RECORD = 'tacit-trade-id-v1';                                           // how /trade last opened a key: public data only (the Bitcoin market writes it too)
const KNOWN_IDS = [RECORD, 'tacit-tac-id-v1', 'tacit-pay-hub-id-v1', 'tacit-lite-id-v1', 'tacit-pay-id-v1'];
const DERIVED = new Set(['eth', 'passkey']);                                  // ways in where the wallet or passkey is itself the backup of the key

const lc = (s) => String(s || '').toLowerCase();
const writeJson = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage is a convenience */ } };
export class Cancelled extends Error { constructor(m = 'Cancelled.') { super(m); this.unlockCancelled = true; } }

// `moved(text)`: the wallet that opened the key has moved to another account or locked, and `text` says so. The page locks the key in full (what it
// holds besides the session goes with it) and says it; a page that gives no `moved` has the session lock.
// `ways` adds the ways in that need tacit.js, from a page that loads it: `btc(record)` opens a Bitcoin wallet (btc-session.js openBtcWallet) and
// resolves to { mode: 'btc', priv, pubHex, address, btc }.
export function makeKeySession({ moved = null, ways = {} } = {}) {
  const evm = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
  let priv = null, key = null;
  const listeners = new Set(), emit = () => listeners.forEach((f) => { try { f(); } catch { /* a listener must not break the session */ } });
  const pubOf = (hex) => bytesToHex(secp.getPublicKey(hexToBytes(hex), true));

  function set(k) {
    const pubHex = lc(String(k.pubHex || pubOf(k.priv)).replace(/^0x/, ''));
    if (pubOf(k.priv) !== pubHex) throw new Error('That wallet opened a different key than expected. Nothing was changed.');
    const { priv: p, ...rest } = k;
    priv = p; key = { ...rest, pubHex };
    writeJson(RECORD, key);
    emit();
  }
  const open = {
    // `pick(list)` names which of several announced wallets signs: the page passes the one already connected.
    async eth(k, pick) {
      const id = await evm.deriveIdentity({ pick, expect: k?.address });
      set({ mode: 'eth', priv: id.priv, pubHex: k?.pubHex || id.pubHex, address: '0x' + lc(id.address).replace(/^0x/, '') });
    },
    async passkey(k) {
      if (!isPasskeyAvailable()) throw new Error('Passkeys need a browser that supports them.');
      const r = await prfLogin({ credentialId: k?.credentialId });
      const pubHex = bytesToHex(r.pub), m = loadPrfMap();
      const label = k?.label || Object.keys(m).find((l) => m[l]?.credentialId === r.credentialId) || `passkey-${pubHex.slice(0, 6)}`;
      m[label] = { credentialId: r.credentialId, pubkey: pubHex, createdAt: m[label]?.createdAt || Date.now(), lastUsed: m[label]?.lastUsed ?? Date.now() };
      savePrfMap(m);
      const p = bytesToHex(r.priv); r.priv.fill(0);
      set({ mode: 'passkey', priv: p, pubHex, label, credentialId: r.credentialId });
    },
    // A key pasted in: 64 hex characters, held for this visit like any other.
    async key(hex) {
      const h = lc(String(hex || '').trim()).replace(/^0x/, '');
      if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('A Tacit key is 64 hex characters.');
      if (!BigInt('0x' + h) || BigInt('0x' + h) >= secp.CURVE.n) throw new Error('That is not a valid Tacit key.');
      set({ mode: 'key', priv: h });
    },
    async newPasskey() {
      if (!isPasskeyAvailable()) throw new Error('Passkeys need a browser that supports them.');
      const m = loadPrfMap();
      let label = 'Tacit', n = 1;
      while (m[label]) label = `Tacit ${++n}`;
      const r = await prfRegister(label);
      m[label] = { credentialId: r.credentialId, pubkey: r.pubHex, createdAt: Date.now(), lastUsed: Date.now() };
      savePrfMap(m);
      const p = bytesToHex(r.priv); r.priv.fill(0);
      set({ mode: 'passkey', priv: p, pubHex: r.pubHex, label, credentialId: r.credentialId });
    },
  };
  if (ways.btc) open.btc = async (k) => set(await ways.btc(k));
  const opens = new Set([...DERIVED, ...(ways.btc ? ['btc'] : [])]);
  const ids = () => knownWallets(KNOWN_IDS);
  const usable = (w) => (w && opens.has(w.mode) ? w : null);
  // The wallet that opened a key is the proof of it: when that wallet moves to another account, or locks, the key is locked too, as on every other
  // page of the site.
  addEventListener('tacit:evm-accounts', (e) => {
    if (key?.mode !== 'eth') return;
    const a = lc((e.detail?.accounts || [])[0]);
    if (a && a === lc(key.address)) return;
    const why = `Your wallet ${a ? 'switched accounts' : 'locked'}, so the Tacit key opened with it was locked. Open it again to continue.`;
    if (moved) moved(why); else { priv = null; key = null; emit(); }
  });
  return {
    open,
    get unlocked() { return !!(key && priv); }, get key() { return key; },
    // A fresh copy each time, as the front page's walletPriv: whatever takes it may wipe it.
    priv() { if (!priv) throw Object.assign(new Error('Your Tacit key was locked, so this stopped. Open it again to continue.'), { said: true }); return hexToBytes(priv); },
    known: () => usable(ids().primary), other: () => usable(ids().other),
    // The wallet tacit.finance has open, when this page cannot open it (a Bitcoin wallet, a key saved in the browser).
    elsewhere: () => { const p = ids().primary; return p && !opens.has(p.mode) ? p : null; },
    passkeyAvailable: () => isPasskeyAvailable(), ethAvailable: () => evm.available(), btcOffered: () => !!ways.btc,
    // the Ethereum wallet the key was opened with (null for a passkey, a pasted key or a Bitcoin wallet): a page's last-resort node for reads
    walletProvider: () => (key && key.mode === 'eth' ? evm.provider() : null),
    lock() { priv = null; key = null; emit(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// Which of several Ethereum wallets signs, chosen in a sheet over the sign-in sheet: resolves to its uuid, or null when closed.
export function pickWalletSheet(list) {
  return new Promise((resolve) => {
    let chosen = null;
    const o = overlay({ title: 'Choose a wallet', top: true, onClose: () => resolve(chosen) });
    o.body.innerHTML = `<div class="ways">${list.map((w) => `<button class="way" type="button" data-uuid="${esc(w.uuid)}"><span class="way-t">${/^data:image\//.test(w.icon || '') ? `<img class="way-ic" src="${esc(w.icon)}" width="22" height="22" alt="">` : ''}${esc(w.name)}</span></button>`).join('')}</div>`;
    o.body.querySelectorAll('[data-uuid]').forEach((b) => { b.onclick = () => { chosen = b.dataset.uuid; o.close(); }; });
  });
}

// The ways in, in a sheet. Resolves once a key is open; rejects with Cancelled when the sheet is closed without one.
// `pick(list)` chooses among several Ethereum wallets (by default the visitor chooses, in a sheet); `why` says what the key is for; `icons` puts
// the front page's mark on each way in.
export function signInSheet(session, { pick = pickWalletSheet, icons = false, why = 'Open your Tacit wallet to make ETH private. This page never stores the key.' } = {}) {
  return new Promise((resolve, reject) => {
    const known = session.known(), other = session.other(), away = session.elsewhere();
    const via = (k) => ({ eth: `Ethereum ${short(k.address || '')}`, btc: `Bitcoin ${short(k.address || '')}`, passkey: `passkey “${k.label || 'Tacit'}”` })[k?.mode] || 'your wallet';
    const o = overlay({ title: 'Open your Tacit wallet', top: true, onClose: () => { if (!session.unlocked) reject(new Cancelled()); } });
    // the front page's mark for each way in, on a page that draws the sheet as the front page does and has the marks
    const ic = (id) => (icons && id && document.getElementById(id) ? `<svg class="way-ic" width="22" height="22" aria-hidden="true"><use href="#${id}"/></svg>` : '');
    const opt = (k, t, m, cls = '', icon = null) => `<button class="way ${cls}" type="button" data-in="${k}"><span class="way-t">${ic(icon)}${t}</span><span class="way-m">${m}</span></button>`;
    const pk = session.passkeyAvailable(), hasEth = session.ethAvailable(), btc = !!session.btcOffered?.();
    o.body.innerHTML = `<p class="note" style="margin-top:0">${esc(why)}</p><div class="ways">
      ${known ? opt('known', 'Continue with your Tacit wallet', `Opens with ${esc(via(known))}, the same wallet as everywhere on tacit.finance.`, 'main', 'tk-tac') : ''}
      ${other ? opt('other', 'Your other Tacit wallet', `A different wallet, opened here before with ${esc(via(other))}.`, '', 'tk-tac') : ''}
      ${opt('eth', 'Ethereum wallet', hasEth ? 'MetaMask, Rabby, Rainbow or any browser wallet, or a wallet app through WalletConnect. One free signature, two the first time.' : 'MetaMask, Rabby, Rainbow or any browser wallet, or a wallet app through WalletConnect.', '', 'tk-eth')}
      ${btc ? opt('btc', 'Bitcoin wallet', 'Xverse, Leather or UniSat. One free signature, two the first time.', '', 'tk-btc') : ''}
      ${pk ? opt('passkey', 'Passkey', 'Touch ID, Windows Hello or a security key.', '', 'i-key') : ''}
      <p class="ways-err" role="alert" hidden></p>
      ${away ? `<p class="note">The wallet open on tacit.finance was opened another way (${btc ? 'a key saved in the browser' : 'a Bitcoin wallet or a key saved in the browser'}). That one opens on <a href="/">tacit.finance</a>, or paste its key here.</p>` : ''}
      <p class="more" style="display:flex;flex-wrap:wrap;gap:4px 18px"><button class="linkbtn" type="button" data-show="paste">Paste a key</button>${pk ? '<button class="linkbtn" type="button" data-in="new">New passkey wallet</button>' : ''}</p>
      <form class="paste-key" style="display:grid;gap:8px" hidden><input type="password" placeholder="64-character Tacit key" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="Tacit key" style="width:100%;box-sizing:border-box;padding:10px 12px;font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--hair-2)"><button class="btn" type="submit" data-in="key" style="margin-top:0">Open</button></form>
    </div>`;
    const paste = o.body.querySelector('.paste-key');
    o.body.querySelector('[data-show="paste"]').onclick = () => { paste.hidden = !paste.hidden; if (!paste.hidden) paste.querySelector('input').focus(); };
    paste.onsubmit = (e) => e.preventDefault();
    const err = o.body.querySelector('.ways-err');
    let busy = false;
    o.body.querySelectorAll('[data-in]').forEach((b) => { b.onclick = async () => {
      if (busy) return;
      busy = true; err.hidden = true; b.setAttribute('aria-busy', 'true'); o.body.querySelectorAll('[data-in]').forEach((x) => { x.disabled = true; });
      try {
        const k = b.dataset.in;
        if (k === 'known') await session.open[known.mode](known, pick);
        else if (k === 'other') await session.open[other.mode](other, pick);
        else if (k === 'new') await session.open.newPasskey();
        else if (k === 'key') { const input = paste.querySelector('input'); await session.open.key(input.value); input.value = ''; }
        else await session.open[k](undefined, pick);
        o.close(); resolve();
      } catch (e) {
        if (!/cancel/i.test(e?.message || '') && e?.name !== 'NotAllowedError' && !e?.unlockCancelled && e?.code !== 4001) { err.textContent = e?.message || 'Could not open your Tacit wallet. Try again.'; err.hidden = false; }
      } finally { busy = false; b.removeAttribute('aria-busy'); o.body.querySelectorAll('[data-in]').forEach((x) => { x.disabled = false; }); }
    }; });
  });
}
