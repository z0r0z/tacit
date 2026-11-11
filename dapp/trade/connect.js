import { announceWalletConnect, wcSheets, WC_PROJECT_ID } from '/walletconnect.js?cb=843803d6';
import { makeWallet, UserStopped } from '/trade/wallet.js?cb=c12e83a8';
import { overlay, esc } from '/trade/sheet.js?cb=84cda8f2';
import { rpc, RPCS, short, $ } from '/trade/util.js?cb=ba5a02b1';

export { UserStopped };

export function makeConnect({ describe, name = 'tacit trade', rpc: read = rpc, rows = () => '', wire = () => {}, leave = () => {}, busy = () => false, say = () => {}, onChange = () => {}, restore = true, rewards = true }) {
  const sheets = wcSheets((title, onClose) => overlay({ title, top: true, onClose }));
  const WC = announceWalletConnect({
    projectId: WC_PROJECT_ID, chains: [1], rpcMap: { 1: RPCS[0] },
    metadata: { name, description: describe, url: location.origin, icons: [`${location.origin}/tac-logo.png`] },
    onPair: sheets.onPair, onAsk: sheets.onAsk,
  });
  const wallet = makeWallet({ rpc: read, busy, leave: (p) => (p?.isWalletConnect ? WC.disconnect() : null) });
  const W = wallet.state;

  function pickWallet(list) {
    return new Promise((resolve) => {
      const o = overlay({ title: 'Choose a wallet', top: true, onClose: () => resolve(null) });
      o.body.innerHTML = `<div class="picker">${list.map((w, i) => `<button class="way" type="button" data-i="${i}"><span class="way-t">${/^data:image\//.test(w.info?.icon || '') ? `<img src="${esc(w.info.icon)}" alt="" width="20" height="20">` : ''}${esc(w.info?.name || 'Wallet')}</span></button>`).join('')}</div>`;
      o.body.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { resolve(Number(b.dataset.i)); o.close(); }; });
    });
  }
  let connecting = false;
  async function connect() {
    if (connecting) return false;
    const list = wallet.available();
    if (!list.length) { say('No wallet was found in this browser. Open this page in a wallet app’s browser, or use tacit.finance.'); return false; }
    connecting = true; renderChip();
    try {
      let w = list[0];
      if (list.length > 1) { const i = await pickWallet(list); if (i == null) return false; w = list[i]; }
      await wallet.connect(w);
      return true;
    } catch (e) { say(esc(e instanceof UserStopped ? 'Not connected.' : (e.message || 'The wallet did not connect.')), true); return false; }
    finally { connecting = false; renderChip(); }
  }
  async function changeAccount() {
    if (connecting) return;
    try {
      if (W.prov?.isWalletConnect) { await leaveAccount(); await connect(); return; }
      connecting = true; renderChip();
      await wallet.chooseAccount();
    } catch (e) { say(esc(e instanceof UserStopped ? 'Account not changed.' : (e.message || 'The wallet did not change account.')), !(e instanceof UserStopped)); }
    finally { connecting = false; renderChip(); }
  }
  async function leaveAccount() { const addr = W.account; await leave(addr); await wallet.disconnect(); }
  function renderChip() {
    const on = !!W.account, wrong = on && W.chain && W.chain !== '0x1';
    $('#wallet-dot').classList.toggle('on', on && !wrong && !connecting); $('#wallet-dot').classList.toggle('warn', !!wrong || connecting);
    $('#wallet-label').textContent = on ? short(W.account, 4) : 'Connect';
    $('#wallet-chip').setAttribute('aria-label', connecting ? 'Waiting for your wallet' : on ? `Wallet ${W.account}${wrong ? ', on another network' : ''}` : 'Connect a wallet');
    $('#wallet-chip').toggleAttribute('aria-busy', connecting);
    $('#wallet-chip').title = connecting ? 'Waiting for your wallet…' : wrong ? 'Your wallet is on another network. It is asked to switch to Ethereum when you send.' : '';
  }
  function accountSheet() {
    const o = overlay({ title: 'Wallet', top: true });
    const wrong = W.chain && W.chain !== '0x1', stop = busy(), app = W.prov?.peerName?.();
    o.body.innerHTML = `<div class="kv"><span>Connected with</span><b>${esc(W.name)}${app ? ` · ${esc(app)}` : ''}${stop ? '' : ' <button class="linkbtn" type="button" data-change>Change account</button>'}</b></div><div class="kv"><span>Account</span><b class="addr-s">${esc(W.account)}</b></div>${wrong ? '<div class="kv"><span>Network</span><b>Not Ethereum <button class="linkbtn" type="button" data-switch>Switch</button></b></div>' : ''}${rows()}${rewards ? `<a class="btn ghost" href="/rewards/?q=${esc(W.account)}">Rewards →</a>` : ''}<div class="bsheet-actions" style="margin-top:14px"><button class="btn ghost" type="button" data-copy>Copy address</button><button class="btn" type="button" data-leave${stop ? ' disabled' : ''}>Disconnect</button></div>${stop ? '<p class="note">Something is in progress; disconnect when it ends.</p>' : ''}`;
    const addr = W.account;
    o.body.querySelector('[data-switch]')?.addEventListener('click', (e) => { e.target.disabled = true; wallet.ensureMainnet().then(() => { o.close(); renderChip(); }, () => { e.target.disabled = false; }); });
    o.body.querySelector('[data-copy]').onclick = (e) => navigator.clipboard?.writeText(addr).then(() => { e.target.textContent = 'Copied'; }, () => { e.target.textContent = 'Could not copy'; });
    wire(o.body, o.close);
    o.body.querySelector('[data-change]')?.addEventListener('click', () => { o.close(); changeAccount(); });
    o.body.querySelector('[data-leave]').onclick = async () => { o.close(); await leaveAccount(); };
  }
  $('#wallet-chip').addEventListener('click', () => { if (W.account) accountSheet(); else connect(); });
  let owedFor = null;
  const markOwed = (on) => { const nav = document.querySelector('header.top .sn'); if (nav) { nav.toggleAttribute('data-owed', !!on); nav.querySelector('a[href="/rewards/"]')?.setAttribute('aria-label', on ? 'Rewards, something to claim' : 'Rewards'); } };
  function checkOwed() {
    const a = W.account ? W.account.toLowerCase() : null;
    if (!rewards || a === owedFor) return;
    owedFor = a; markOwed(false);
    if (a) (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => import('/trade/rewards-dot.js?cb=a0612927').then((m) => m.owedDot(a, (on) => { if (owedFor === a) markOwed(on); })).catch(() => {}));
  }
  wallet.onChange(() => { renderChip(); onChange(); checkOwed(); });
  const restoreLast = () => wallet.restore().catch(() => {});
  if (restore) restoreLast();
  renderChip();
  return { wallet, W, connect, changeAccount, renderChip, restore: restoreLast };
}
