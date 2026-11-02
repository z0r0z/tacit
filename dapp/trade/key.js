// The Tacit key for the tETH page: opened from an Ethereum wallet's signature or a passkey, held in this visit's memory and never stored. What
// is stored is the public record of how it was opened, which every page that opens a Tacit key reads (tacit-wallet-known.js), so a visitor is
// offered the wallet they already use. This is /trade's own session (btc-session.js) without tacit.js, which a private deposit has no use for
// and which is four megabytes: the ways in that need it (a Bitcoin wallet, a saved key) are left to tacit.finance.
import { secp, sha256, keccak_256, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { prfBytesToScalar, prfLogin, prfRegister, loadPrfMap, savePrfMap, isPasskeyAvailable } from '/prf-wallet.js';
import { knownWallets } from '/tacit-wallet-known.js?cb=ed4c75b7';
import { makeEvmWallet } from '/evm-wallet.js?cb=f3072d82';
import { overlay, esc } from '/trade/sheet.js?cb=84cda8f2';
import { short } from '/trade/util.js?cb=e53086bb';

const RECORD = 'tacit-trade-id-v1';                                           // how /trade last opened a key: public data only (the Bitcoin market writes it too)
const KNOWN_IDS = [RECORD, 'tacit-tac-id-v1', 'tacit-pay-hub-id-v1', 'tacit-lite-id-v1', 'tacit-pay-id-v1'];
const DERIVED = new Set(['eth', 'passkey']);                                  // ways in where the wallet or passkey is itself the backup of the key

const lc = (s) => String(s || '').toLowerCase();
const writeJson = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage is a convenience */ } };
export class Cancelled extends Error { constructor(m = 'Cancelled.') { super(m); this.unlockCancelled = true; } }

// `moved(text)`: the wallet that opened the key has moved to another account or locked, and `text` says so. The page locks the key in full (what it
// holds besides the session goes with it) and says it; a page that gives no `moved` has the session lock.
export function makeKeySession({ moved = null } = {}) {
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
  const ids = () => knownWallets(KNOWN_IDS);
  const usable = (w) => (w && DERIVED.has(w.mode) ? w : null);
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
    elsewhere: () => { const p = ids().primary; return p && !DERIVED.has(p.mode) ? p : null; },
    passkeyAvailable: () => isPasskeyAvailable(), ethAvailable: () => evm.available(),
    lock() { priv = null; key = null; emit(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// The ways in, in a sheet. Resolves once a key is open; rejects with Cancelled when the sheet is closed without one.
// `pick(list)` chooses among several Ethereum wallets; `why` says what the key is for.
export function signInSheet(session, { pick, why = 'Open your Tacit wallet to make ETH private. This page never stores the key.' } = {}) {
  return new Promise((resolve, reject) => {
    const known = session.known(), other = session.other(), away = session.elsewhere();
    const via = (k) => ({ eth: `Ethereum ${short(k.address || '')}`, passkey: `passkey “${k.label || 'Tacit'}”` })[k?.mode] || 'your wallet';
    const o = overlay({ title: 'Open your Tacit wallet', top: true, onClose: () => { if (!session.unlocked) reject(new Cancelled()); } });
    const opt = (k, t, m, cls = '') => `<button class="way ${cls}" type="button" data-in="${k}"><span class="way-t">${t}</span><span class="way-m">${m}</span></button>`;
    const pk = session.passkeyAvailable(), hasEth = session.ethAvailable();
    o.body.innerHTML = `<p class="note" style="margin-top:0">${esc(why)}</p><div class="ways">
      ${known ? opt('known', 'Continue with your Tacit wallet', `Opens with ${esc(via(known))}, the same wallet as everywhere on tacit.finance.`, 'main') : ''}
      ${other ? opt('other', 'Your other Tacit wallet', `A different wallet, opened here before with ${esc(via(other))}.`) : ''}
      ${opt('eth', 'Ethereum wallet', hasEth ? 'MetaMask, Rabby, Rainbow or any browser wallet, or a wallet app through WalletConnect. One free signature, two the first time.' : 'MetaMask, Rabby, Rainbow or any browser wallet, or a wallet app through WalletConnect.')}
      ${pk ? opt('passkey', 'Passkey', 'Touch ID, Windows Hello or a security key.') : ''}
      <p class="ways-err" role="alert" hidden></p>
      ${away ? '<p class="note">The wallet open on tacit.finance was opened another way (a Bitcoin wallet or a key saved in the browser). That one opens on <a href="/">tacit.finance</a>.</p>' : ''}
      ${pk ? '<p class="more"><button class="linkbtn" type="button" data-in="new">New passkey wallet</button></p>' : ''}
    </div>`;
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
        else await session.open[k](undefined, pick);
        o.close(); resolve();
      } catch (e) {
        if (!/cancel/i.test(e?.message || '') && e?.name !== 'NotAllowedError' && !e?.unlockCancelled && e?.code !== 4001) { err.textContent = e?.message || 'Could not open your Tacit wallet. Try again.'; err.hidden = false; }
      } finally { busy = false; b.removeAttribute('aria-busy'); o.body.querySelectorAll('[data-in]').forEach((x) => { x.disabled = false; }); }
    }; });
  });
}
