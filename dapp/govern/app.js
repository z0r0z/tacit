import { makeConnect } from '/trade/connect.js?cb=514272b7';
import { declinedWords } from '/wallet-prompts.js';
import { addrView } from '/address-view.js?cb=58dd4914';
import { esc } from '/trade/sheet.js?cb=d857446c';
import { API, $, fmtUnits, rpc } from '/trade/util.js?cb=9c8b4133';
import { TAC as TAC_ERC20 } from '/trade/farm-read.js?cb=fb6ec72f';
import { makeKeySession, signInSheet } from '/trade/key.js?cb=e9a3a06d';
import { openBtcWallet } from '/trade/btc-session.js?cb=26eb770f';
import { makeTacitSession } from '/tacit-session.js?cb=4636e436';
import { isPasskeyAvailable } from '/prf-wallet.js';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { GOV_NETWORK, PROPOSE_FLOOR_TAC, CATEGORIES, voteMessage, proposeMessage } from '/govern/message.js?cb=c73bd573';
import { invaderSvg } from '/prove/invader.js?cb=e8a5ec59';

// TAC holders signal on proposals here, from either chain or both at once.
//   Ethereum: the holder's wallet signs a message (nothing is sent on chain) and the API reads the TAC it held at the proposal's snapshot block.
//   Bitcoin: the holder opens their Tacit wallet (an Ethereum wallet's signature, a passkey or a Bitcoin wallet, the site's usual sign-in) and tacit.js,
//   loaded only then, proves the TAC they held clears a tier without showing the exact amount: the same proof the classic app makes.
// Each chain's vote is its own, counted in one tally; this page shows the two sides apart.
const TACIT_URL = '/tacit.js?cb=43ed18ad';
const TAC_BASE = 10n ** 8n;
const q = (p) => `${API}/governance${p}${p.includes('?') ? '&' : '?'}network=${GOV_NETWORK}`;
const S = {
  filter: 'active', list: null, loadErr: '', p: null, route: { name: 'list' }, draft: null, choice: undefined, busy: false, note: '', bad: false,
  bal: null, weight: undefined,                                   // Ethereum: TAC now, and at the open proposal's snapshot (18 decimals)
  btc: null, btcReading: false, btcErr: '',                       // Bitcoin: TAC held by the open Tacit wallet (8 decimals)
  use: { eth: true, btc: true }, tier: null, from: null,          // the ballot's sources, the Bitcoin tier, and which chain opens a proposal
  steps: {},                                                      // per source, what happened on the last cast
};
const say = (text, bad = false) => { S.note = text; S.bad = bad; const el = $('#note'); if (el) { el.className = `status${bad ? ' err' : ''}`; el.textContent = text; } };

// ── the two ways in ──
const conn = makeConnect({
  describe: 'tacit gov: vote on TAC proposals', name: 'tacit gov', rewards: false,
  say: (t, b) => say(t, b), busy: () => S.busy, onChange: () => { S.bal = null; S.weight = undefined; render(); readBalance(); readWeight(); },
});
const W = conn.W;
$('#wallet-chip').hidden = false;
let TS = null;
const keyS = makeKeySession({
  moved: (why) => { keyS.lock(); S.btc = null; say(why, true); render(); }, busy: () => S.busy,
  ways: { btc: (k) => TS.turn(() => openBtcWallet(TS.T, { k, tPriv: TS.tPriv, passkey: isPasskeyAvailable() })), btcSeen: () => !!(window.btc_providers?.length || window.XverseProviders?.BitcoinProvider || window.LeatherProvider || window.unisat) },
});
TS = makeTacitSession({ url: TACIT_URL, key: () => (keyS.unlocked ? { pubHex: keyS.key.pubHex, priv: bytesToHex(keyS.priv()) } : null), secp, bytesToHex, hexToBytes });
const tacitOn = () => keyS.unlocked;
const gov = (fn) => TS.withKey((T) => fn(T.governanceApi()));
keyS.onChange(() => { S.btc = null; S.btcErr = ''; S.tier = null; render(); if (tacitOn()) readBtc(); });
const signIn = () => signInSheet(keyS, { why: 'Open your Tacit wallet to vote with the TAC it holds on Bitcoin. Your exact balance stays private.' }).catch(() => {});

// ── data ──
async function getJson(path, init) {
  const r = await fetch(q(path), { signal: AbortSignal.timeout(30e3), ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `The server answered ${r.status}.`), { status: r.status });
  return j;
}
// a quiet refresh keeps the last good data on screen when a read fails; the error shows only when nothing has loaded
async function loadList({ quiet = false } = {}) {
  if (!quiet) { S.loadErr = ''; render(); }
  try { S.list = (await getJson('/proposals')).proposals || []; S.loadErr = ''; } catch { if (!quiet || !S.list) S.loadErr = 'Could not load proposals. Try again in a moment.'; }
  if (S.route.name === 'list') render();
}
const sameTally = (a, b) => a?.status === b?.status && JSON.stringify(a?.tally) === JSON.stringify(b?.tally);
async function loadProposal(id, { quiet = false } = {}) {
  if (!quiet) { S.p = null; S.loadErr = ''; render(); }
  const had = S.p?.id === id ? S.p : null;
  try {
    // a refresh reads the proposal alone first; the vote list is fetched again only when the tally moved
    let p = had?.votes ? (await getJson(`/proposal/${id}`)).proposal : null;
    if (p && sameTally(p, had)) p.votes = had.votes;
    else p = (await getJson(`/proposal/${id}?votes=1`)).proposal;
    if (S.route.id !== id) return;
    S.p = p; S.loadErr = '';
  } catch (e) {
    if (S.route.id !== id) return;
    if (!had) S.loadErr = e.status === 404 ? 'No such proposal.' : 'Could not load this proposal. Try again in a moment.';
  }
  render(); readWeight();
}
const balanceCall = (who, block) => rpc('eth_call', [{ to: TAC_ERC20, data: `0x70a08231${'0'.repeat(24)}${who.slice(2).toLowerCase()}` }, block]);
async function readBalance() {
  const who = W.account; if (!who) return;
  try {
    const raw = await balanceCall(who, 'latest');
    if (who === W.account && /^0x[0-9a-fA-F]{64}$/.test(raw || '')) { S.bal = BigInt(raw); render(); }
  } catch { /* the balance line stays empty */ }
}
// the holder's Ethereum weight on this proposal: the TAC held at its snapshot block (an archive answer; left out when the nodes cannot give one)
async function readWeight() {
  const who = W.account, p = S.p;
  if (!who || !p || p.status !== 'active' || !Number.isInteger(p.eth_snapshot_block) || S.weight !== undefined) return;
  try {
    const raw = await balanceCall(who, `0x${p.eth_snapshot_block.toString(16)}`);
    if (S.p?.id === p.id && who === W.account && /^0x[0-9a-fA-F]{64}$/.test(raw || '')) { S.weight = BigInt(raw); render(); }
  } catch { /* no archive answer */ }
}
// the TAC the open Tacit wallet holds on Bitcoin (a scan of its coins, done by tacit.js)
let btcSeq = 0;
async function readBtc() {
  if (!tacitOn()) return;
  const seq = ++btcSeq, pub = keyS.key.pubHex;
  S.btcReading = true; S.btcErr = ''; render();
  try {
    const v = await gov((g) => g.readTacBalance({ rescan: true }));
    if (seq === btcSeq && keyS.key?.pubHex === pub) S.btc = BigInt(v || 0);
  } catch { if (seq === btcSeq) S.btcErr = 'Could not read your Bitcoin TAC. Try again in a moment.'; }
  finally { if (seq === btcSeq) { S.btcReading = false; render(); } }
}

// ── format ──
const big = (x) => { try { return BigInt(x || '0'); } catch { return 0n; } };
const fmtTac = (base) => fmtUnits(big(base), 8, 2);
const pctOf = (w, sum) => (sum > 0n ? Number((w * 1000n) / sum) / 10 : 0);
const TIERS = [1n, 10n, 100n, 1000n, 10000n, 100000n].map((t) => t * TAC_BASE);    // the balance tiers a Bitcoin vote proves (worker GOV_TIERS)
const tiersFor = (v) => TIERS.filter((t) => t <= (v ?? 0n));
const floorBtc = BigInt(PROPOSE_FLOOR_TAC) * TAC_BASE, floorEth = BigInt(PROPOSE_FLOOR_TAC) * 10n ** 18n;
function left(endsAt) {
  const s = endsAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'ended';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
const pill = (p) => {
  const [cls, word] = p.status === 'active' ? ['live', 'Open'] : p.status === 'ended' ? ['wait', 'To tally'] : p.result?.passed ? ['done', 'Passed'] : ['shut', 'Closed'];
  return `<span class="pill ${cls}">${word}</span>`;
};
const when = (p) => (p.status === 'active' ? left(p.voting_ends_at) : `ended ${new Date(p.voting_ends_at * 1000).toLocaleDateString()}`);
const totals = (p) => (p.tally?.totals || []).map(big);
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(v || '');
const isBtc = (v) => v.kind === 'private';
// a face for every holder: the zOrgz invader their address (or Bitcoin key) picks, as the prover and praxis pages draw it
const faces = new Map();
function face(key, px = 28) {
  const k = isAddr(key) ? key.toLowerCase() : /^[0-9a-f]{66}$/i.test(key || '') ? `0x${key}` : '';
  if (!k) return '';
  if (!faces.has(k)) { let src = ''; try { src = `data:image/svg+xml;base64,${btoa(invaderSvg(k, 128))}`; } catch { /* no face */ } faces.set(k, src); }
  const src = faces.get(k);
  return src ? `<img class="inv" src="${src}" width="${px}" height="${px}" alt="">` : '';
}
const keyLabel = (hex) => `key ${esc(String(hex || '').slice(0, 8))}…`;
const proposer = (p) => `<span class="who-f">${face(p.proposer_pubkey, 22)}${isAddr(p.proposer_pubkey) ? addrView(p.proposer_pubkey, 5) : `Bitcoin ${keyLabel(p.proposer_pubkey)}`}</span>`;
// per choice, the TAC from each chain, from the proposal's vote list (a Bitcoin vote counts its proven tier)
function lanes(p) {
  const n = p.choices.length, btc = new Array(n).fill(0n), eth = new Array(n).fill(0n);
  for (const v of p.votes || []) { const c = v.choice | 0; if (c < 0 || c >= n) continue; (isBtc(v) ? btc : eth)[c] += big(v.weight); }
  return { btc, eth };
}
const ago = (t) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const chainTag = (btc) => `<span class="lane ${btc ? 'b' : 'e'}">${btc ? 'Bitcoin' : 'Ethereum'}</span>`;
// this holder's own votes on a proposal, per chain
const myVotes = (p) => ({
  eth: W.account ? (p.votes || []).find((v) => v.kind === 'public' && String(v.voter || '').toLowerCase() === W.account.toLowerCase()) : null,
  btc: tacitOn() ? (p.votes || []).find((v) => isBtc(v) && String(v.voter || '').toLowerCase() === keyS.key.pubHex) : null,
});

// ── views ──
function render() {
  const root = $('#app');
  root.innerHTML = S.route.name === 'new' ? newView() : S.route.name === 'detail' ? detailView() : listView();
  wire(root);
  renderSide();
  const note = $('#note', root);
  if (note && S.note) { note.className = `status${S.bad ? ' err' : ''}`; note.textContent = S.note; }
}
// the holder's own TAC on each chain, and the way in to each
function renderSide() {
  const side = $('#side'); if (!side) return;
  const on = !!W.account, bt = tacitOn();
  const ethB = on ? (S.bal == null ? '…' : `${esc(fmtUnits(S.bal, 18, 2))} TAC`) : '';
  const btcB = bt ? (S.btcReading && S.btc == null ? 'Reading…' : S.btc == null ? '—' : `${esc(fmtTac(S.btc))} TAC`) : '';
  side.innerHTML = `<p class="eyebrow">Your TAC</p>
    <div class="acct">
      <div class="acct-h">${on ? face(W.account, 40) : '<span class="inv ph"></span>'}<div><span class="lane e">Ethereum</span><b class="num">${on ? ethB : 'Not connected'}</b><small>${on ? addrView(W.account, 4) : 'The TAC in your wallet'}</small></div></div>
      ${on ? '' : '<button class="btn ghost" type="button" id="side-connect">Connect wallet</button>'}
    </div>
    <div class="acct">
      <div class="acct-h">${bt ? face(keyS.key.pubHex, 40) : '<span class="inv ph"></span>'}<div><span class="lane b">Bitcoin</span><b class="num">${bt ? btcB : 'Not open'}</b><small>${bt ? `Tacit ${keyLabel(keyS.key.pubHex)} · <button class="linkbtn" type="button" id="btc-lock">lock</button>` : 'The TAC in your Tacit wallet, kept private'}</small></div></div>
      ${bt ? (S.btcErr ? `<p class="status err">${esc(S.btcErr)} <button class="linkbtn" type="button" id="btc-retry">Retry</button></p>` : '') : '<button class="btn ghost" type="button" id="side-tacit">Open Tacit wallet</button>'}
    </div>
    <div class="side-rule"></div>
    <div class="kv"><span>To open a proposal</span><b class="num">${PROPOSE_FLOOR_TAC} TAC</b></div>
    <p class="note">A vote weighs the TAC held when its proposal opened. Vote from one chain or both at once: each counts on its own.</p>
    <p class="note">A Bitcoin vote proves the TAC you hold clears a tier (1, 10, 100… TAC) without showing the amount.</p>`;
  $('#side-connect', side)?.addEventListener('click', () => conn.connect());
  $('#side-tacit', side)?.addEventListener('click', signIn);
  $('#btc-lock', side)?.addEventListener('click', () => { keyS.lock(); });
  $('#btc-retry', side)?.addEventListener('click', readBtc);
}

function listView() {
  const chips = [['active', 'Open'], ['ended', 'To tally'], ['closed', 'Closed'], ['', 'All']]
    .map(([k, l]) => `<button class="chip-f${S.filter === k ? ' on' : ''}" type="button" data-f="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join('');
  let body;
  if (S.loadErr) body = `<p class="status err">${esc(S.loadErr)} <button class="linkbtn" type="button" id="retry">Retry</button></p>`;
  else if (S.list === null) body = '<div class="skel"></div><div class="skel"></div>';
  else {
    const rows = S.list.filter((p) => !S.filter || p.status === S.filter).sort((a, b) => b.created_at - a.created_at);
    body = rows.length ? rows.map((p) => {
      const t = totals(p), sum = t.reduce((a, b) => a + b, 0n);
      let bi = 0; t.forEach((w, i) => { if (w > t[bi]) bi = i; });
      const lead = sum > 0n ? `<span class="lead">${esc(p.choices[bi])} · ${pctOf(t[bi], sum)}%</span>` : '<span class="lead mute">No votes yet</span>';
      const tl = p.tally || {};
      return `<a class="prop" href="#${p.id}">
        <span class="prop-top">${pill(p)}<span class="mute">${esc(when(p))}</span></span>
        <span class="prop-t">${face(p.proposer_pubkey, 36)}<b>${esc(p.title)}</b></span>
        <span class="mini"><i style="width:${sum > 0n ? pctOf(t[bi], sum) : 0}%"></i></span>
        <span class="prop-meta">${lead}<span class="mute">${esc(fmtTac(tl.total_weight))} TAC · ${tl.private_voters || 0} Bitcoin · ${tl.public_voters || 0} Ethereum</span></span></a>`;
    }).join('') : `<div class="blank"><p>No ${S.filter === 'active' ? 'open ' : ''}proposals${S.filter ? '' : ' yet'}.</p><a class="linkbtn" href="#new">Open one</a></div>`;
  }
  return `<div class="bar"><div class="chips" role="group" aria-label="Show">${chips}</div><a class="btn sm" href="#new">New proposal</a></div>
    <div class="props">${body}</div>`;
}

// the ballot's two sources: what each would count, and whether it can vote
function sources(p) {
  const mine = myVotes(p), noEth = !Number.isInteger(p.eth_snapshot_block);
  const eth = { key: 'eth', ready: !!W.account && !noEth, mine: mine.eth };
  eth.line = !W.account ? 'Connect a wallet to vote with its TAC.'
    : noEth ? 'This proposal opened without an Ethereum snapshot.'
      : S.weight == null ? 'Counts the TAC held at the snapshot block.'
        : S.weight === 0n ? `Held no TAC at block ${p.eth_snapshot_block}, so it has no vote here.` : `${fmtUnits(S.weight, 18, 2)} TAC, held at block ${p.eth_snapshot_block}.`;
  if (S.weight === 0n) eth.ready = false;
  const opts = tiersFor(S.btc);
  const btc = { key: 'btc', ready: tacitOn() && opts.length > 0, mine: mine.btc, opts };
  btc.line = !tacitOn() ? 'Open your Tacit wallet to vote with the TAC it holds.'
    : S.btc == null ? (S.btcReading ? 'Reading your Bitcoin TAC…' : 'Your Bitcoin TAC could not be read.')
      : !opts.length ? `Holds ${fmtTac(S.btc)} TAC, under the 1 TAC a vote needs.` : 'Proves you hold at least the tier you pick. The amount stays private.';
  return { eth, btc };
}
function detailView() {
  const p = S.p;
  const back = '<p class="eyebrow"><a href="#">← All proposals</a></p>';
  if (S.loadErr) return `${back}<p class="status err">${esc(S.loadErr)} <button class="linkbtn" type="button" id="retry">Retry</button></p>`;
  if (!p) return `${back}<div class="skel tall"></div>`;
  const t = totals(p), sum = t.reduce((a, b) => a + b, 0n), L = lanes(p);
  const btcSum = L.btc.reduce((a, b) => a + b, 0n), ethSum = L.eth.reduce((a, b) => a + b, 0n);
  const quorum = big(p.quorum);
  const bars = p.choices.map((c, i) => {
    const win = p.result && p.result.winner === i;
    return `<div class="res${win ? ' win' : ''}"><div class="res-h"><span>${esc(c)}${win ? ' <i class="ok">✓</i>' : ''}</span><b class="num">${esc(fmtTac(t[i].toString()))} TAC · ${pctOf(t[i], sum)}%</b></div>
      <div class="track" title="Bitcoin ${esc(fmtTac(L.btc[i].toString()))} TAC · Ethereum ${esc(fmtTac(L.eth[i].toString()))} TAC"><i class="b" style="width:${pctOf(L.btc[i], sum)}%"></i><i class="e" style="width:${pctOf(L.eth[i], sum)}%"></i></div></div>`;
  }).join('');
  let act = '';
  if (p.status === 'active') {
    const src = sources(p);
    const picked = ['eth', 'btc'].filter((k) => S.use[k] && src[k].ready);
    const anyMine = src.eth.mine || src.btc.mine;
    const sel = S.choice ?? (src.eth.mine ? src.eth.mine.choice : src.btc.mine ? src.btc.mine.choice : -1);
    if (S.tier == null && src.btc.opts.length) S.tier = src.btc.opts[src.btc.opts.length - 1];
    const row = (s, name) => {
      const st = S.steps[s.key];
      return `<label class="src${s.ready ? '' : ' off'}${S.use[s.key] && s.ready ? ' on' : ''}">
        <input type="checkbox" data-src="${s.key}" ${S.use[s.key] && s.ready ? 'checked' : ''} ${s.ready ? '' : 'disabled'}>
        <span class="src-b">${chainTag(s.key === 'btc')}<span class="src-l">${esc(name)}</span>
          <small>${esc(s.line)}${s.mine ? ` <b>Voted ${esc(p.choices[s.mine.choice] ?? '')}${isBtc(s.mine) ? ` at ${esc(fmtTac(s.mine.weight))} TAC` : ''}.</b>` : ''}</small>
          ${st ? `<small class="${st.bad ? 'err' : st.ok ? 'ok' : ''}" id="step-${s.key}">${esc(st.text)}</small>` : ''}</span>
        ${s.key === 'btc' && s.ready ? `<select class="fld tier" id="tier" aria-label="Tier to prove">${s.opts.map((v) => `<option value="${v}"${S.tier === v ? ' selected' : ''}>≥ ${fmtTac(v)}</option>`).join('')}</select>` : ''}
        ${!s.ready && s.key === 'eth' && !W.account ? '<button class="linkbtn" type="button" id="b-eth">Connect</button>' : ''}
        ${!s.ready && s.key === 'btc' && !tacitOn() ? '<button class="linkbtn" type="button" id="b-btc">Open</button>' : ''}
      </label>`;
    };
    const label = S.busy ? 'Voting…' : !picked.length ? (W.account || tacitOn() ? 'Nothing to vote with' : 'Connect a wallet to vote') : `${anyMine ? 'Change vote' : 'Vote'}${picked.length === 2 ? ' from both' : picked[0] === 'btc' ? ' from Bitcoin' : ' from Ethereum'}`;
    act = `<form class="ballot" id="ballot"><p class="eyebrow">Your vote</p>
      <div class="opts">${p.choices.map((c, i) => `<label class="opt${sel === i ? ' on' : ''}"><input type="radio" name="c" value="${i}"${sel === i ? ' checked' : ''}><span>${esc(c)}</span></label>`).join('')}</div>
      <p class="eyebrow" style="margin-top:16px">Vote with</p>
      <div class="srcs">${row(src.eth, 'Your Ethereum wallet')}${row(src.btc, 'Your Tacit wallet')}</div>
      <button class="btn" type="submit" id="vote" ${S.busy || !picked.length ? 'disabled' : ''}>${esc(label)}</button>
      <p class="status" id="note" aria-live="polite"></p></form>`;
  } else if (p.status === 'ended') {
    act = `<div class="ballot"><p class="note" style="margin:0">Voting has closed. Anyone can record the final tally.</p>
      <button class="btn ghost" type="button" id="fin" ${S.busy ? 'disabled' : ''}>Record the result</button><p class="status" id="note" aria-live="polite"></p></div>`;
  } else {
    act = `<div class="ballot"><p class="note" style="margin:0">${p.result?.passed ? `Passed: <b>${esc(p.result.winner_choice)}</b> with ${esc(fmtTac(p.result.winner_weight))} TAC.` : 'Did not pass.'} Final tally${p.result_cid ? `, <a href="https://ipfs.filebase.io/ipfs/${esc(p.result_cid)}" target="_blank" rel="noopener">pinned to IPFS</a>` : ''}.</p></div>`;
  }
  const votes = (p.votes || []).slice(0, 50);
  const feed = votes.length ? `<div class="sec"><p class="eyebrow">Votes <span class="who">${p.votes.length}</span></p><div class="feed">${votes.map((v) => {
    const btc = isBtc(v);
    return `<div class="vrow">${face(v.voter, 32) || '<span class="inv"></span>'}<span class="vwho">${chainTag(btc)} ${btc ? keyLabel(v.voter) : isAddr(v.voter) ? addrView(v.voter, 4) : '—'}</span>
      <span class="vch">${esc(p.choices[v.choice] ?? '')}</span><b class="num">${btc ? '≥ ' : ''}${esc(fmtTac(v.weight))}</b><span class="mute vt">${esc(ago(v.voted_at || 0))}</span></div>`;
  }).join('')}</div></div>` : '';
  return `${back}<div class="prop-top">${pill(p)}<span class="mute">${esc(when(p))}</span></div>
    <h2 class="ptitle">${esc(p.title)}</h2>
    <div class="meta">
      <div class="kv"><span>Proposed by</span><b>${proposer(p)}</b></div>
      <div class="kv"><span>Snapshot</span><b>${p.snapshot_height ? `<a href="https://mempool.space/block/${p.snapshot_height}" target="_blank" rel="noopener">Bitcoin ${p.snapshot_height}</a>` : '—'}${Number.isInteger(p.eth_snapshot_block) ? ` · <a href="https://etherscan.io/block/${p.eth_snapshot_block}" target="_blank" rel="noopener">Ethereum ${p.eth_snapshot_block}</a>` : ''}</b></div>
      ${quorum > 0n ? `<div class="kv"><span>Quorum</span><b class="num">${esc(fmtTac(sum.toString()))} / ${esc(fmtTac(quorum.toString()))} TAC${sum >= quorum ? ' · met' : ''}</b></div>` : ''}
    </div>
    ${p.body ? `<div class="body">${esc(p.body)}</div>` : ''}
    <div class="sec"><div class="res-legend"><p class="eyebrow" style="margin:0">Results</p>
      <span id="lane-b"><i class="dot b"></i>Bitcoin ${esc(fmtTac(btcSum.toString()))} TAC · ${p.tally?.private_voters || 0}</span><span id="lane-e"><i class="dot e"></i>Ethereum ${esc(fmtTac(ethSum.toString()))} TAC · ${p.tally?.public_voters || 0}</span></div>
      ${bars}</div>
    ${act}
    ${feed}
    ${p.cid ? `<p class="note"><a href="https://ipfs.filebase.io/ipfs/${esc(p.cid)}" target="_blank" rel="noopener">The proposal on IPFS</a></p>` : ''}`;
}

const DURATIONS = [['86400', '1d'], ['259200', '3d'], ['604800', '7d'], ['1209600', '14d'], ['2592000', '30d']];
function newView() {
  const d = S.draft || (S.draft = { title: '', body: '', category: 'general', dur: '604800', quorum: '', choices: ['Yes', 'No'] });
  const ethOk = !!W.account && S.bal != null && S.bal >= floorEth, btcOk = tacitOn() && S.btc != null && S.btc >= floorBtc;
  const from = S.from && ((S.from === 'eth' && W.account) || (S.from === 'btc' && tacitOn())) ? S.from : btcOk && !ethOk ? 'btc' : W.account ? 'eth' : tacitOn() ? 'btc' : 'eth';
  const on = from === 'eth' ? !!W.account : tacitOn();
  const known = from === 'eth' ? S.bal != null : S.btc != null;
  const enough = from === 'eth' ? ethOk : btcOk;
  const label = S.busy ? (from === 'btc' ? 'Proving your TAC…' : 'Waiting for your wallet…') : !on ? (from === 'eth' ? 'Connect wallet' : 'Open Tacit wallet') : known && !enough ? `Needs ${PROPOSE_FLOOR_TAC} TAC to open` : 'Sign and open';
  const fromRow = `<div class="seg two-way" role="radiogroup" aria-label="Open from">${[['eth', 'Ethereum wallet'], ['btc', 'Tacit wallet (Bitcoin)']].map(([k, l]) => `<button type="button" role="radio" aria-checked="${from === k}" class="${from === k ? 'on' : ''}" data-from="${k}">${l}</button>`).join('')}</div>`;
  return `<p class="eyebrow"><a href="#">← All proposals</a></p><h2 class="ptitle">New proposal</h2>
    <p class="lede">Put a question to TAC holders. They vote with the TAC they hold, on Bitcoin or Ethereum, for as long as you choose.</p>
    <form class="form" id="newform" data-from="${from}">
      <label class="f"><span class="lbl">Title <i class="cnt" id="f-cnt">${d.title.length}/140</i></span><input class="fld" id="f-title" maxlength="140" value="${esc(d.title)}" placeholder="A short question holders can answer" required></label>
      <label class="f"><span class="lbl">Details</span><textarea class="fld" id="f-body" rows="7" maxlength="12000" placeholder="What you propose, why, and any links">${esc(d.body)}</textarea></label>
      <label class="f"><span class="lbl">Topic</span><select class="fld" id="f-cat">${CATEGORIES.map(([k, l]) => `<option value="${k}"${d.category === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="f"><span class="lbl">Choices</span>
        <div class="choices">${d.choices.map((c, i) => `<div class="crow"><span class="cn">${i + 1}</span><input class="fld f-ch" data-i="${i}" maxlength="80" value="${esc(c)}" placeholder="Choice ${i + 1}" aria-label="Choice ${i + 1}">${d.choices.length > 2 ? `<button class="cx" type="button" data-del="${i}" aria-label="Remove choice ${i + 1}">×</button>` : ''}</div>`).join('')}</div>
        ${d.choices.length < 8 ? '<button class="add" type="button" id="f-add">+ Add a choice</button>' : ''}</div>
      <div class="two">
        <div class="f"><span class="lbl">Voting open for</span><div class="seg" role="radiogroup" aria-label="Voting open for">${DURATIONS.map(([v, l]) => `<button type="button" role="radio" aria-checked="${d.dur === v}" class="${d.dur === v ? 'on' : ''}" data-dur="${v}">${l}</button>`).join('')}</div></div>
        <label class="f"><span class="lbl">Quorum <i class="cnt">optional</i></span><span class="unit"><input class="fld" id="f-quorum" inputmode="numeric" placeholder="None" value="${esc(d.quorum)}"><i>TAC</i></span></label>
      </div>
      <div class="f"><span class="lbl">Open it from <i class="cnt">${PROPOSE_FLOOR_TAC} TAC held</i></span>${fromRow}</div>
      <button class="btn" type="submit" id="f-go" ${S.busy || (on && known && !enough) ? 'disabled' : ''}>${esc(label)}</button>
      <p class="status" id="note" aria-live="polite"></p>
    </form>`;
}

// ── actions ──
function wire(root) {
  root.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { S.filter = b.dataset.f; render(); }; });
  $('#retry', root)?.addEventListener('click', () => (S.route.name === 'detail' ? loadProposal(S.route.id) : loadList()));
  const ballot = $('#ballot', root);
  if (ballot) {
    ballot.onsubmit = (e) => { e.preventDefault(); castVotes(); };
    ballot.querySelectorAll('input[name="c"]').forEach((i) => { i.onchange = () => { S.choice = +i.value; ballot.querySelectorAll('.opt').forEach((o, k) => o.classList.toggle('on', k === S.choice)); }; });
    ballot.querySelectorAll('[data-src]').forEach((c) => { c.onchange = () => { S.use[c.dataset.src] = c.checked; render(); }; });
    $('#tier', ballot)?.addEventListener('change', (e) => { S.tier = BigInt(e.target.value); });
    $('#b-eth', ballot)?.addEventListener('click', (e) => { e.preventDefault(); conn.connect(); });
    $('#b-btc', ballot)?.addEventListener('click', (e) => { e.preventDefault(); signIn(); });
  }
  $('#fin', root)?.addEventListener('click', finalize);
  const form = $('#newform', root);
  if (form) {
    const d = S.draft, keep = () => {
      d.title = $('#f-title').value; d.body = $('#f-body').value; d.category = $('#f-cat').value; d.quorum = $('#f-quorum').value;
      root.querySelectorAll('.f-ch').forEach((i) => { d.choices[+i.dataset.i] = i.value; });
      const cnt = $('#f-cnt'); if (cnt) cnt.textContent = `${d.title.length}/140`;
    };
    form.oninput = keep;
    $('#f-add')?.addEventListener('click', () => { keep(); d.choices.push(''); render(); $(`.f-ch[data-i="${d.choices.length - 1}"]`)?.focus(); });
    root.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { keep(); d.choices.splice(+b.dataset.del, 1); render(); }; });
    root.querySelectorAll('[data-dur]').forEach((b) => { b.onclick = () => { keep(); d.dur = b.dataset.dur; render(); }; });
    root.querySelectorAll('[data-from]').forEach((b) => { if (b.tagName === 'BUTTON') b.onclick = () => { keep(); S.from = b.dataset.from; render(); }; });
    form.onsubmit = (e) => { e.preventDefault(); keep(); openProposal(form.dataset.from); };
  }
}

// One vote per chosen source, Ethereum first (its wallet asks at once), then Bitcoin (a proof made here, which takes a few seconds). Each is sent on
// its own and counted on its own; one failing leaves the other standing.
async function castVotes() {
  const p = S.p, picked = document.querySelector('#ballot input[name="c"]:checked'), c = picked ? +picked.value : -1;
  if (c < 0) { say('Pick a choice first.', true); return; }
  const src = sources(p), use = ['eth', 'btc'].filter((k) => S.use[k] && src[k].ready);
  if (!use.length || S.busy) return;
  S.busy = true; S.choice = c; S.steps = {}; render();
  const step = (k, text, o = {}) => { S.steps[k] = { text, ...o }; render(); };
  for (const k of use) {
    try {
      if (k === 'eth') {
        step('eth', 'Waiting for your wallet…');
        const sig = await conn.wallet.signMessage(voteMessage(p.id, c, p.choices[c]), W.account);
        step('eth', 'Counting your TAC…');
        const j = await getJson(`/proposal/${p.id}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'public', choice: c, eth_sig: sig }) });
        step('eth', `Voted with ${fmtTac(j.weight)} TAC${j.revote ? ' (changed)' : ''}.`, { ok: true });
      } else {
        const tier = S.tier ?? src.btc.opts[src.btc.opts.length - 1];
        step('btc', `Proving at least ${fmtTac(tier)} TAC…`);
        const j = await gov(async (g) => { await g.readTacBalance(); return g.votePrivate(p.id, c, tier); });
        step('btc', `Voted at ${fmtTac(j.weight || tier)} TAC${j.revote ? ' (changed)' : ''}.`, { ok: true });
      }
    } catch (e) {
      step(k, e.userStopped || e.unlockCancelled ? declinedWords(e, 'Nothing was sent.') : plain(e), { bad: !e.userStopped });
    }
  }
  S.busy = false;
  await loadProposal(p.id, { quiet: true });
}
async function openProposal(from) {
  if (from === 'eth' && !W.account) { await conn.connect(); return; }
  if (from === 'btc' && !tacitOn()) { await signIn(); return; }
  const d = S.draft;
  const choices = d.choices.map((c) => c.trim()).filter(Boolean), title = d.title.trim();
  if (!title) { say('Add a title.', true); return; }
  if (choices.length < 2 || new Set(choices).size !== choices.length) { say('Give at least two different choices.', true); return; }
  if (d.quorum.trim() && !/^\d+$/.test(d.quorum.trim())) { say('Quorum is a whole number of TAC.', true); return; }
  const c = { network: GOV_NETWORK, title, body: d.body.trim(), choices, category: d.category, voting_ends_at: Math.floor(Date.now() / 1000) + +d.dur,
    quorum: d.quorum.trim() ? (BigInt(d.quorum.trim()) * TAC_BASE).toString() : '0', exec_target: '', exec_note: '' };
  if (S.busy) return;
  S.busy = true; render();
  try {
    let j;
    if (from === 'eth') {
      const sig = await conn.wallet.signMessage(await proposeMessage(c), W.account);
      say('Opening your proposal…');
      j = await getJson('/proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...c, kind: 'public', eth_sig: sig }) });
    } else {
      say(`Proving you hold ${PROPOSE_FLOOR_TAC} TAC…`);
      j = await gov(async (g) => { await g.readTacBalance(); return g.createProposal({ ...c, snapshot_height: 0 }); });
    }
    S.busy = false; S.draft = null; S.list = null; location.hash = j.id;
  } catch (e) {
    S.busy = false; render();
    say(e.userStopped || e.unlockCancelled ? declinedWords(e, 'Nothing was sent.') : plain(e), !e.userStopped);
  }
}
async function finalize() {
  S.busy = true; render();
  try { await getJson(`/proposal/${S.p.id}/finalize`, { method: 'POST' }); S.busy = false; await loadProposal(S.p.id, { quiet: true }); }
  catch (e) { S.busy = false; render(); say(plain(e), true); }
}
// the API's words, said plainly
function plain(e) {
  const m = String(e.message || 'Something went wrong.');
  if (/needs \d+ TAC held at the snapshot/.test(m)) return `Opening a proposal needs ${PROPOSE_FLOOR_TAC} TAC held a few blocks ago. TAC that just arrived counts after a few minutes.`;
  if (/held no TAC at the snapshot/.test(m)) return 'This account held no TAC when the proposal opened, so it has no vote here.';
  if (/not confirmed by the snapshot|spent by the snapshot/.test(m)) return 'Your Bitcoin TAC moved after this proposal opened, so it votes as it stood then. Pick a lower tier, or it has no vote here.';
  if (/could not cover tier/.test(m)) return 'Your Tacit wallet does not hold that much TAC. Pick a lower tier.';
  if (/daily limit/.test(m)) return 'Too many proposals from here today. Try again tomorrow.';
  if (/archive RPC|snapshot unavailable|retry shortly|tip/.test(m)) return 'A balance could not be read just now. Try again in a minute.';
  return m;
}

// ── routing ──
function route() {
  const h = location.hash.replace(/^#/, '');
  S.choice = undefined; S.weight = undefined; S.note = ''; S.steps = {};
  if (/^[0-9a-f]{64}$/.test(h)) { S.route = { name: 'detail', id: h }; loadProposal(h); }
  else if (h === 'new') { S.route = { name: 'new' }; render(); }
  else { S.route = { name: 'list' }; loadList(); }
  if (S.bal == null) readBalance();
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
// open proposals keep their tallies fresh while the page is in view (not while a wallet is asked to sign)
setInterval(() => {
  if (S.busy || document.visibilityState !== 'visible') return;
  if (S.route.name === 'list' && S.list) loadList({ quiet: true });
  else if (S.route.name === 'detail' && S.p?.status === 'active') loadProposal(S.route.id, { quiet: true });
}, 60e3);
route();
if (tacitOn()) readBtc();      // a Tacit wallet this tab already opened on another page of the site
