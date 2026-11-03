// The open board: settles the relay has proved and holds for a sender. settle() on the pool is open to every account and pays each fee leg its
// proof binds to whoever sends it, so any visitor with a wallet can send one: the page reads the board (the API's /confidential/open), tries the
// settle with eth_call, has the wallet send it, and tells the API it landed. The fee shown is read from the proof's own public values.
import { makeConfidentialRelay } from '/confidential-relay.js?cb=a38a3e0c';
import { CONFIDENTIAL_DEPLOYMENTS, shownTicker } from '/confidential-deployments.js?cb=477f3312';
import { pvFees, pvDeadline, settleCalldata, typeWords } from '/relay/abi.js?cb=5078b247';
import { UserStopped } from '/trade/wallet.js?cb=88b623b8';
import { rpc, esc, fmtUnits, short } from '/trade/util.js?cb=e53086bb';

const API = 'https://api.tacit.finance';
const SCAN = 'https://etherscan.io/';
const DEP = CONFIDENTIAL_DEPLOYMENTS.mainnet;
export const POOL = DEP.pool;
const lc = (s) => String(s || '').toLowerCase();
// The marks the page's sprite carries, by the ticker a fee is shown in.
const MARK = { tETH: 'tk-teth', TAC: 'tk-tac', cTAC: 'tk-tac', cBTC: 'tk-cbtc', cUSD: 'tk-cusd' };
const markOf = (t) => (MARK[t] ? `<svg class="tk" aria-hidden="true"><use href="#${MARK[t]}"/></svg>` : '');

// The dapp's asset table, by pool asset id: the name an asset is shown under and the decimals its in-pool values carry. A farm's reward is wTAC.
const ASSETS = new Map();
for (const a of DEP.assets || []) if (a.assetId && !ASSETS.has(lc(a.assetId))) ASSETS.set(lc(a.assetId), { ticker: shownTicker(a.ticker), dec: Number(a.tacitDecimals ?? a.decimals ?? 8) });
if (DEP.farm?.rewardAsset && !ASSETS.has(lc(DEP.farm.rewardAsset))) ASSETS.set(lc(DEP.farm.rewardAsset), { ticker: 'wTAC', dec: 8 });

// What a job pays its sender, in words: each fee leg as an amount of its asset, or the API's own figures when the public values cannot be read.
export function feeOf(job) {
  let legs = null;
  try { legs = pvFees(job.publicValues); } catch { /* the API's figures below */ }
  const usd = Number.isFinite(job.feeUsd) && job.feeUsd > 0 ? ` ≈ $${job.feeUsd < 10 ? job.feeUsd.toFixed(2) : Math.round(job.feeUsd).toLocaleString('en-US')}` : '';
  if (!legs) { const text = job.feeAsset ? `in ${job.feeAsset}` : 'unknown'; return { text, html: esc(text), usd, none: false }; }
  const paid = legs.filter((l) => l.value > 0n);
  if (!paid.length) return { text: 'no fee', html: 'no fee', usd: '', none: true };
  const leg = (l) => { const a = ASSETS.get(lc(l.assetId)); return a ? [`${fmtUnits(l.value, a.dec, a.dec)} ${a.ticker}`, markOf(a.ticker)] : [`${l.value} units of ${short(l.assetId, 4)}`, '']; };
  return { text: paid.map((l) => leg(l)[0]).join(' + '), html: paid.map((l) => { const [t, m] = leg(l); return `${m}${esc(t)}`; }).join(' + '), usd, none: false };
}
const span = (ms) => { const m = Math.max(0, Math.round(ms / 60e3)); return m < 1 ? 'under a minute' : m < 90 ? `${m} min` : m < 36 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
// When a job's settle stops being accepted, in ms (0 = never): the API's figure, else the deadline its proof commits to.
function expiry(job) {
  let by = Number(job.expiresAt) || 0;
  if (!by) { try { by = pvDeadline(job.publicValues) * 1000; } catch { /* none */ } }
  return by;
}
function timing(job, at = Date.now()) {
  const by = expiry(job);
  const waited = job.openSince ? `waiting ${span(at - Number(job.openSince))}` : 'waiting';
  return `${waited} · ${by ? (by > at ? `expires in ${span(by - at)}` : 'its deadline has passed') : 'no deadline'}`;
}

// `wallet`, `W`, `connect`: the page's wallet (trade/connect.js). `say(html, err)`: the board's status line.
export function mountOpen({ el, wallet, W, connect, say }) {
  const relay = makeConfidentialRelay({ base: API });
  const S = { jobs: null, pool: null, err: false, busy: null, at: 0 };
  const list = el.querySelector('#open-list');

  function render() {
    if (S.jobs == null) { list.innerHTML = `<p class="mute">${S.err ? 'Could not read the board. Try again in a moment.' : 'Loading…'}</p>`; return; }
    if (!S.jobs.length) { list.innerHTML = '<p class="calm">Nothing is waiting.</p>'; return; }
    const at = Date.now();
    list.innerHTML = S.jobs.map((j) => {
      const f = feeOf(j), sending = j.status === 'sending', mine = S.busy === j.jobId, ready = j.publicValues && j.proof && Array.isArray(j.memos) && !(expiry(j) && expiry(j) <= at);
      return `<div class="job"><div class="jt"><b>${esc(typeWords(j.type))}</b>${j.posted ? '<span class="tag" title="Proved by its holder’s own prover and posted here">posted</span>' : ''}<small>${esc(timing(j, at))}</small></div>`
        + `<div class="jf num"><span>${f.html}</span>${f.usd ? `<small>${esc(f.usd)}</small>` : ''}</div>`
        + (sending ? '<span class="jx mute">being sent</span>' : `<button class="btn sm" type="button" data-send="${esc(j.jobId)}"${S.busy || !ready ? ' disabled' : ''}${mine ? ' aria-busy="true"' : ''}>${mine ? 'Sending…' : 'Send it'}</button>`) + '</div>';
    }).join('');
  }

  async function load() {
    try {
      const j = await relay.openJobs({ limit: 50 });
      S.jobs = Array.isArray(j?.jobs) ? j.jobs : []; S.pool = j?.pool || null; S.err = false; S.at = Date.now();
    } catch { S.err = true; }                                                      // a board read before stays shown
    render();
  }

  // Tried first with eth_call from the sending account: a settle someone else sent first, or one past its deadline, is never sent.
  async function send(id) {
    const job = S.jobs?.find((x) => x.jobId === id);
    if (!job || S.busy) return;
    if (!W.account && !(await connect.connect())) return;
    if (S.pool && lc(S.pool) !== lc(POOL)) { say('The board names a pool this page does not know, so nothing will be sent.', true); return; }
    const from = W.account, data = settleCalldata(job), f = feeOf(job), link = (h) => `<a href="${SCAN}tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}… ↗</a>`;
    S.busy = id; render();
    try {
      say('Checking it first…');
      try { await rpc('eth_call', [{ from, to: POOL, data }, 'latest']); }
      catch (e) {
        if (e?.revert) { say('This one would not go through: someone has most likely sent it already, or its deadline has passed. Nothing was sent.', true); return; }
        throw new Error('Could not check it. Nothing was sent. Try again in a moment.');
      }
      say(`You pay the network fee${f.none ? '' : `, and the account that sends it is paid ${esc(f.text)}`}. Confirm in your wallet…`);
      const hash = await wallet.sendTx({ to: POOL, data, from });
      say(`Sent ${link(hash)}. Waiting for it to land…`);
      const rc = await wallet.receipt(hash);
      if (rc.status !== '0x1') { say(`It did not go through ${link(hash)}: someone most likely sent it first. Nothing was lost but its network fee.`, true); return; }
      await relay.landed(job.jobId, hash);
      say(`<span class="ok">Sent.</span> ${link(hash)} ${f.none ? 'It carried no fee.' : `Its fee, ${esc(f.text)}, went to ${esc(short(from, 4))}.`}`);
    } catch (e) { say(esc(e instanceof UserStopped || e?.userStopped ? e.message : (e?.message || 'It could not be sent.')), true); }
    finally { S.busy = null; render(); load(); }
  }

  list.addEventListener('click', (e) => { const b = e.target.closest('[data-send]'); if (b && !b.disabled) send(b.dataset.send); });
  el.querySelector('#open-re')?.addEventListener('click', () => { if (!S.busy) load(); });
  render();
  const ready = load();
  setInterval(() => { if (!document.hidden && !S.busy) load(); }, 30e3);
  return { ready, busy: () => !!S.busy, render };
}
