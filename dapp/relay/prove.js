// Paying for proofs: every proof the relay makes is paid in PROVE from one prover account (the Succinct network requester), and PROVE sent to that
// account is put into the prover network within a few minutes (under 2 PROVE, at the relay's next half-hourly top-up). A visitor's wallet can send PROVE there, or pay ETH that zRouter swaps to
// PROVE with the prover account as the recipient, in one transaction. Only the visitor's own balances are read; never the prover account's.
import { PROVER, PROVE, ZROUTER, PROVE_PER_PROOF, SLIPPAGE_BPS, transferData, balanceOfData, quoteEthToProve } from '/relay/abi.js?cb=190ea12d';
import { UserStopped } from '/trade/wallet.js?cb=3595ad83';
import { rpc, esc, fmtUnits, parseUnits, plain, grp, short } from '/trade/util.js?cb=ba5a02b1';

const SCAN = 'https://etherscan.io/';
const QUOTE_TTL = 60e3;                                                            // a quote older than this is read again before it is sent
// The chain's time, for a swap's deadline: the latest block's timestamp, read with a quote and kept for a minute as an offset from the device's
// clock, whose own time would otherwise set the deadline (already past when the clock runs slow, longer than meant when it runs fast).
let clock = null;
async function chainNow() {
  if (!clock || Date.now() - clock.at > QUOTE_TTL) {
    try { const t = Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp)) * 1000; if (t > 0) clock = { skew: t - Date.now(), at: Date.now() }; } catch { /* the device's clock */ }
  }
  return Math.floor((Date.now() + (clock ? clock.skew : 0)) / 1000);
}
const proofs = (wei) => Math.floor(Number(wei) / 1e18 / PROVE_PER_PROOF);
const link = (h) => `<a href="${SCAN}tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}… ↗</a>`;
const kv = (k, v) => `<div class="kv"><span>${k}</span><b class="num">${v}</b></div>`;

export function mountProve({ el, wallet, W, connect, say }) {
  const P = { mode: 'prove', amt: '', bal: null, quote: null, seq: 0, busy: false, timer: 0 };
  const $ = (s) => el.querySelector(s);
  const want = () => parseUnits(P.amt, 18) || 0n;
  const mine = () => (P.bal && P.bal.who === W.account ? P.bal : null);

  async function readBalances() {
    const who = W.account;
    if (!who) { P.bal = null; return; }
    const [prove, eth] = await Promise.all([
      rpc('eth_call', [{ to: PROVE, data: balanceOfData(who) }, 'latest']).then((x) => BigInt(x || 0), () => null),
      rpc('eth_getBalance', [who, 'latest']).then((x) => BigInt(x), () => null),
    ]);
    if (W.account === who) P.bal = { who, prove, eth };
  }

  // zQuoter's best route from ETH to PROVE, built for the prover account as the recipient. Checked before it is shown: it spends exactly what was
  // asked, pays the prover account, and guards a least amount out.
  async function requote() {
    const wei = want(), my = ++P.seq;
    if (P.mode !== 'eth' || !wei) { P.quote = null; render(); return; }
    P.quote = { wei, loading: true }; render();
    try {
      const q = await quoteEthToProve({ call: ({ to, data, gas }) => rpc('eth_call', [{ to, data, gas }, 'latest']), to: PROVER, wei, noRoute: 'No route from ETH to PROVE was found. Try again in a moment, or send PROVE.', now: await chainNow() });
      if (my !== P.seq) return;
      P.quote = q;
    } catch (e) {
      if (my !== P.seq) return;
      P.quote = { wei, err: e?.revert ? 'No route from ETH to PROVE was found. Try again in a moment, or send PROVE.' : (e?.message || 'Could not read a quote.') };
    }
    render();
  }

  function render() {
    const b = mine(), wei = want(), q = P.quote;
    el.querySelectorAll('[data-pay]').forEach((x) => { x.setAttribute('aria-pressed', String(x.dataset.pay === P.mode)); x.disabled = P.busy; });
    $('#pv-lbl').textContent = P.mode === 'eth' ? 'ETH to pay' : 'PROVE to send';
    $('#pv-unit').textContent = P.mode === 'eth' ? 'ETH' : 'PROVE';
    $('#pv-amt').disabled = P.busy;
    const have = P.mode === 'eth' ? b?.eth : b?.prove;
    $('#pv-bal').textContent = have != null ? `Balance ${fmtUnits(have, 18, 4)} ${P.mode === 'eth' ? 'ETH' : 'PROVE'}` : '';
    $('#pv-max').hidden = !(P.mode === 'prove' && b?.prove);
    const box = $('#pv-quote');
    if (P.mode === 'prove') box.innerHTML = wei ? kv('Pays for', `about ${grp(proofs(wei), 0)} proof${proofs(wei) === 1 ? '' : 's'}`) + kv('Sent to', `the prover account, ${esc(short(PROVER, 4))}`) : '';
    else if (!wei) box.innerHTML = '';
    else if (!q || q.loading || q.wei !== wei) box.innerHTML = kv('You get', '<span class="mute">loading…</span>');
    else if (q.err) box.innerHTML = `<p class="hint err">${esc(q.err)}</p>`;
    else box.innerHTML = kv('You get about', `${esc(fmtUnits(q.amountOut, 18, 2))} PROVE`) + kv('At least', `${esc(fmtUnits(q.amountLimit, 18, 2))} PROVE · ${Number(SLIPPAGE_BPS) / 100}% slippage guard`)
      + kv('Pays for', `about ${grp(proofs(q.amountOut), 0)} proof${proofs(q.amountOut) === 1 ? '' : 's'}`) + kv('Sent to', `the prover account, ${esc(short(PROVER, 4))}, through zRouter`);
    const go = $('#pv-go');
    go.disabled = false;
    if (!W.account) { go.textContent = 'Connect wallet'; return; }
    if (P.busy) { go.textContent = 'Sending…'; go.disabled = true; return; }
    if (!wei) { go.textContent = 'Enter an amount'; go.disabled = true; return; }
    if (have != null && wei > have) { go.textContent = `Not enough ${P.mode === 'eth' ? 'ETH' : 'PROVE'}`; go.disabled = true; return; }
    if (P.mode === 'prove') { go.textContent = 'Send PROVE'; return; }
    if (!q || q.loading || q.wei !== wei) { go.textContent = 'Reading the quote…'; go.disabled = true; return; }
    if (q.err) { go.textContent = 'Try again'; return; }
    go.textContent = 'Swap and send';
  }

  // Each send is tried with eth_call from the paying account first: a call that would revert is never put to the wallet.
  async function sendTx(tx, from) {
    try { await rpc('eth_call', [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: '0x' + tx.value.toString(16) } : {}) }, 'latest']); }
    catch (e) { throw new Error(e?.revert ? 'It would not go through. Nothing was sent.' : 'Could not check it. Nothing was sent. Try again in a moment.'); }
    say('Confirm in your wallet…');
    return wallet.sendTx({ ...tx, from });
  }

  async function go() {
    if (!W.account) { await connect.connect(); return; }
    const wei = want(), q = P.quote;
    if (P.busy || !wei) return;
    if (P.mode === 'eth' && (!q || q.err || q.wei !== wei || Date.now() - q.at > QUOTE_TTL)) {
      await requote();
      if (P.quote && !P.quote.err && q && !q.err) say('The quote was read again. Check it and press once more.');
      return;
    }
    const from = W.account;
    P.busy = true; render(); say('Checking it first…');
    try {
      const hash = P.mode === 'eth'
        ? await sendTx({ to: ZROUTER, data: q.callData, value: q.msgValue }, from)
        : await sendTx({ to: PROVE, data: transferData(PROVER, wei) }, from);
      say(`Sent ${link(hash)}. It reaches the prover within a few minutes, or within half an hour for under 2 PROVE.`);
      P.amt = ''; $('#pv-amt').value = ''; P.quote = null; P.seq++;
      const rc = await wallet.receipt(hash);
      if (rc.status !== '0x1') say(`It did not go through ${link(hash)}. Nothing was lost but its network fee.`, true);
      else say(`<span class="ok">Landed.</span> ${link(hash)} It reaches the prover within a few minutes, or within half an hour for under 2 PROVE.`);
    } catch (e) { say(esc(e instanceof UserStopped || e?.userStopped ? e.message : (e?.message || 'It could not be sent.')), true); }
    finally { P.busy = false; await readBalances().catch(() => {}); render(); }
  }

  el.addEventListener('click', (e) => {
    const m = e.target.closest('[data-pay]');
    if (m && !P.busy && m.dataset.pay !== P.mode) { P.mode = m.dataset.pay; P.amt = ''; $('#pv-amt').value = ''; P.quote = null; P.seq++; say(''); render(); return; }
    if (e.target.id === 'pv-max' && mine()?.prove) { P.amt = plain(mine().prove, 18); $('#pv-amt').value = P.amt; render(); }
    if (e.target.id === 'pv-go') go();
  });
  $('#pv-amt').addEventListener('input', (e) => { P.amt = e.target.value; clearTimeout(P.timer); if (P.mode === 'eth') { P.quote = null; P.timer = setTimeout(requote, 350); } render(); });
  render();
  return {
    busy: () => P.busy,
    onAccount: () => { render(); readBalances().then(render).catch(() => {}); },
  };
}
