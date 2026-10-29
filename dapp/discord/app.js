import { makeConnect } from '/trade/connect.js?cb=de979716';
import { esc } from '/trade/sheet.js?cb=84cda8f2';
import { API, $, short, fmtUnits, rpc } from '/trade/util.js?cb=dcf3a4f2';
import { discordGateMessage, DISCORD_MIN_TAC_BASE_UNITS, DISCORD_MIN_TAC_ERC20 } from '/discord/message.js?cb=0232a98d';
import { TAC as TAC_ERC20, FARM, POOL } from '/trade/farm-read.js?cb=112a01b9';
import { readPrecisionTacStake } from '/discord/holdings.js?cb=48f774e8';

// The Discord verification panel sends a holder here: the link carries a one-time nonce (#gate=<32 hex>, made for one Discord account, good for ten minutes).
// The holder connects the Ethereum account that holds the public TAC ERC-20 and signs a plain message that names the nonce; the API recovers the signer,
// reads the account's TAC balance, and gives the Discord account the holder role. Nothing is sent on chain.
const NEED = `${DISCORD_MIN_TAC_BASE_UNITS / 10n ** 8n} TAC`;
const NONCE_KEY = 'tacit.discord.gate';

// The nonce is taken out of the address bar (it is the link's secret) and kept for this tab, so a reload or a wallet app's return finds it again.
function takeNonce() {
  const m = /^#gate=([0-9a-fA-F]{32})$/.exec(location.hash);
  if (m) {
    const n = m[1].toLowerCase();
    try { sessionStorage.setItem(NONCE_KEY, n); } catch { /* the link works for this load without it */ }
    history.replaceState(null, '', location.pathname + location.search);
    return n;
  }
  try { return sessionStorage.getItem(NONCE_KEY); } catch { return null; }
}
const forgetNonce = () => { try { sessionStorage.removeItem(NONCE_KEY); } catch { /* nothing kept */ } };

const S = { nonce: takeNonce(), bal: null, farmBal: null, reading: false, readSeq: 0, busy: false, done: false, note: '', bad: false };
const say = (text, bad = false) => { S.note = text; S.bad = bad; paintNote(); };
const conn = makeConnect({
  describe: 'Discord holder role: show you hold TAC', name: 'tacit discord', rewards: false,
  say: (t, b) => say(t, b), busy: () => S.busy, onChange: () => { S.bal = null; S.farmBal = null; render(); readBalance(); },
});
const W = conn.W;
$('#wallet-chip').hidden = false;

// ── reading ──
async function readBalance() {
  const who = W.account;
  const seq = ++S.readSeq;
  if (!who) return;
  S.reading = true; render();
  try {
    const block = await rpc('eth_blockNumber', []);
    if (!/^0x[0-9a-fA-F]+$/.test(block || '')) throw new Error('Block unavailable');
    const call = (c) => rpc('eth_call', [c, block]);
    const data = `0x70a08231${'0'.repeat(24)}${who.slice(2).toLowerCase()}`;
    const [wallet, farm] = await Promise.allSettled([
      call({ to: TAC_ERC20, data }).then((raw) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(raw || '')) throw new Error('Balance unavailable');
        return BigInt(raw);
      }),
      readPrecisionTacStake(call, who, { farm: FARM, pool: POOL }),
    ]);
    if (seq !== S.readSeq || who !== W.account) return;
    S.bal = wallet.status === 'fulfilled' ? wallet.value : null;
    S.farmBal = farm.status === 'fulfilled' ? farm.value : null;
    if (S.bal === null || S.farmBal === null) say('Some holdings could not be read. You can retry, or verify if either balance qualifies.', true);
  } catch {
    if (seq === S.readSeq && who === W.account) { S.bal = null; S.farmBal = null; say('Could not read your TAC holdings. Try again in a moment.', true); }
  } finally {
    if (seq === S.readSeq && who === W.account) { S.reading = false; render(); }
  }
}

// ── the page ──
const paintNote = () => { const el = $('#note'); if (el) { el.className = `status${S.bad ? ' err' : ''}`; el.textContent = S.note; } };
function render() {
  const root = $('#gate');
  if (S.done) {
    root.innerHTML = `<div class="done"><p class="eyebrow">Verified</p>
      <h2>You have the holder role.</h2>
      <p class="note">It is on your Discord account. Go back to the server.</p></div>`;
    return;
  }
  if (!S.nonce) {
    root.innerHTML = `<p class="eyebrow">Holder role</p>
      <h2>Start from Discord.</h2>
      <p class="note">Click <b>Verify</b> on the panel in the server’s <b>#verify</b> channel. It sends you a private link for your account, good for ten minutes.</p>
      <p class="status" id="note" aria-live="polite"></p>`;
    paintNote();
    return;
  }
  const on = !!W.account, enough = (S.bal ?? 0n) >= DISCORD_MIN_TAC_ERC20 || (S.farmBal ?? 0n) >= DISCORD_MIN_TAC_ERC20;
  const balance = (v) => v == null ? (on ? S.reading ? 'Reading…' : 'Unavailable' : '—') : `${fmtUnits(v, 18, 4)} TAC`;
  const label = S.busy ? 'Waiting for your wallet…' : !on ? 'Connect wallet' : S.reading ? 'Reading your TAC…' : enough ? 'Verify' : `Needs at least ${NEED}`;
  root.innerHTML = `<p class="eyebrow">Holder role</p>
    <h2>Show you hold TAC.</h2>
    <div class="rows flat">
      <div class="kv"><span>Account</span><b>${on ? `<svg class="tk xs" role="img" aria-label="Ethereum"><title>Ethereum</title><use href="#c-eth"/></svg>${esc(short(W.account, 6))}` : 'Not connected'}${on ? ' <button class="linkbtn" type="button" id="swap-acct">change</button>' : ''}</b></div>
      <div class="kv"><span>TAC in wallet</span><b class="num"><svg class="tk xs" aria-hidden="true"><use href="#tk-tac"/></svg>${esc(balance(S.bal))}</b></div>
      <div class="kv"><span>Needed</span><b><svg class="tk xs" aria-hidden="true"><use href="#tk-tac"/></svg>${esc(NEED)}</b></div>
      <div class="kv"><span>TAC in Precision farm</span><b class="num">${esc(balance(S.farmBal))}</b></div>
    </div>
    <button class="btn" type="button" id="go" ${S.busy || (on && !enough) ? 'disabled' : ''}>${esc(label)}</button>
    <p class="status" id="note" aria-live="polite"></p>
    ${on && !S.reading && (S.bal == null || S.farmBal == null) ? '<p class="note"><button class="linkbtn" type="button" id="retry">Retry balance check</button></p>' : ''}
    <p class="note">Hold at least ${esc(NEED)} in your wallet or backing your staked TAC/ETH Precision LP shares. Each balance qualifies separately; unclaimed rewards and unstaked LP shares do not count. Your wallet signs a message that names this link. It costs nothing and your TAC stays where it is.</p>
    <p class="note">Hold TAC on Bitcoin instead? <a href="/classic.html#gate=${esc(S.nonce)}">Prove it privately in the Classic app</a>.</p>`;
  paintNote();
  $('#go').onclick = go;
  $('#swap-acct')?.addEventListener('click', () => conn.changeAccount());
  $('#retry')?.addEventListener('click', () => { say(''); readBalance(); });
}

async function go() {
  if (!W.account) { await conn.connect(); return; }
  if (S.busy) return;
  S.busy = true; say(''); render();
  try {
    const sig = await conn.wallet.signMessage(discordGateMessage(S.nonce), W.account);
    say('Checking your TAC…');
    const r = await fetch(`${API}/discord/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: S.nonce, eth_sig: sig }), signal: AbortSignal.timeout(30e3),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || `The server answered ${r.status}.`), { status: r.status });
    forgetNonce(); S.nonce = null; S.done = true;
  } catch (e) {
    if (e.status === 404) { forgetNonce(); S.nonce = null; }
    say(e.userStopped ? 'Cancelled in your wallet. Nothing was sent.' : failure(e), !e.userStopped);
  } finally { S.busy = false; render(); }
}
// The API's words for what went wrong, said plainly. 404: the link has lapsed; 409: it has been used.
function failure(e) {
  if (e.status === 404) return 'This link has expired. Click Verify in Discord’s #verify channel for a new one.';
  if (e.status === 409) return 'This link was already used. If you did not get the role, click Verify in Discord’s #verify channel again.';
  return String(e.message || 'Something went wrong.').replace(/^discord_gate:\s*/, '');
}

render();
