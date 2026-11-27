import { makeConnect } from '/trade/connect.js?cb=514272b7';
import { declinedWords } from '/wallet-prompts.js';
import { addrView } from '/address-view.js?cb=58dd4914';
import { esc } from '/trade/sheet.js?cb=d857446c';
import { API, $, fmtUnits, rpc } from '/trade/util.js?cb=9c8b4133';
import { TAC as TAC_ERC20 } from '/trade/farm-read.js?cb=fb6ec72f';
import { GOV_NETWORK, PROPOSE_FLOOR_TAC, CATEGORIES, voteMessage, proposeMessage } from '/govern/message.js?cb=c73bd573';

// TAC holders signal on proposals here. A holder with TAC in an Ethereum wallet votes or opens a proposal by signing a message (nothing is sent on chain);
// the API reads the TAC held at the proposal's snapshot block. Holders with TAC on Bitcoin vote privately in the Classic app, by proving a balance tier;
// both land in one tally, and this page shows each proposal's Bitcoin and Ethereum sides apart.
const CLASSIC = '/classic.html#tab=govern';
const q = (p) => `${API}/governance${p}${p.includes('?') ? '&' : '?'}network=${GOV_NETWORK}`;
const S = { filter: 'active', list: null, loadErr: '', p: null, bal: null, weight: undefined, choice: undefined, busy: false, note: '', bad: false, route: { name: 'list' }, draft: null };
const say = (text, bad = false) => { S.note = text; S.bad = bad; const el = $('#note'); if (el) { el.className = `status${bad ? ' err' : ''}`; el.textContent = text; } };
const conn = makeConnect({
  describe: 'tacit gov: vote on TAC proposals', name: 'tacit gov', rewards: false,
  say: (t, b) => say(t, b), busy: () => S.busy, onChange: () => { S.bal = null; S.weight = undefined; render(); readBalance(); readWeight(); },
});
const W = conn.W;
$('#wallet-chip').hidden = false;

// ── data ──
async function getJson(path, init) {
  const r = await fetch(q(path), { signal: AbortSignal.timeout(30e3), ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `The server answered ${r.status}.`), { status: r.status });
  return j;
}
async function loadList() {
  S.loadErr = ''; render();
  try { S.list = (await getJson('/proposals')).proposals || []; } catch { S.loadErr = 'Could not load proposals. Try again in a moment.'; }
  render();
}
async function loadProposal(id, { quiet = false } = {}) {
  if (!quiet) { S.p = null; S.loadErr = ''; render(); }
  try { S.p = (await getJson(`/proposal/${id}?votes=1`)).proposal; } catch (e) { S.loadErr = e.status === 404 ? 'No such proposal.' : 'Could not load this proposal. Try again in a moment.'; }
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
// the holder's weight on this proposal: the TAC held at its snapshot block (an archive answer; left out when the nodes cannot give one)
async function readWeight() {
  const who = W.account, p = S.p;
  if (!who || !p || p.status !== 'active' || !Number.isInteger(p.eth_snapshot_block) || S.weight !== undefined) return;
  try {
    const raw = await balanceCall(who, `0x${p.eth_snapshot_block.toString(16)}`);
    if (S.p?.id === p.id && who === W.account && /^0x[0-9a-fA-F]{64}$/.test(raw || '')) { S.weight = BigInt(raw); render(); }
  } catch { /* no archive answer */ }
}

// ── format ──
const big = (x) => { try { return BigInt(x || '0'); } catch { return 0n; } };
const fmtTac = (base) => fmtUnits(big(base), 8, 2);
const pctOf = (w, sum) => (sum > 0n ? Number((w * 1000n) / sum) / 10 : 0);
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
const proposer = (p) => (isAddr(p.proposer_pubkey) ? addrView(p.proposer_pubkey, 5) : `Bitcoin key ${esc(String(p.proposer_pubkey || '').slice(0, 8))}…`);
const isBtc = (v) => v.kind === 'private';
// per choice, the TAC from each chain, from the proposal's vote list (a Bitcoin vote counts its proven tier)
function lanes(p) {
  const n = p.choices.length, btc = new Array(n).fill(0n), eth = new Array(n).fill(0n);
  for (const v of p.votes || []) { const c = v.choice | 0; if (c < 0 || c >= n) continue; (isBtc(v) ? btc : eth)[c] += big(v.weight); }
  return { btc, eth };
}
const ago = (t) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const chainTag = (btc) => `<span class="lane ${btc ? 'b' : 'e'}">${btc ? 'Bitcoin' : 'Ethereum'}</span>`;

// ── views ──
function render() {
  const root = $('#app');
  root.innerHTML = S.route.name === 'new' ? newView() : S.route.name === 'detail' ? detailView() : listView();
  wire(root);
  renderSide();
}
// the holder's own line, beside every view: who is connected, their TAC on each chain, and where Bitcoin votes are cast
function renderSide() {
  const side = $('#side'); if (!side) return;
  const on = !!W.account;
  side.innerHTML = `<p class="eyebrow">Your TAC</p>
    <div class="kv"><span>Account</span><b>${on ? addrView(W.account, 5) : 'Not connected'}</b></div>
    <div class="kv"><span>On Ethereum</span><b class="num">${on ? (S.bal == null ? '…' : `${esc(fmtUnits(S.bal, 18, 2))} TAC`) : '—'}</b></div>
    <div class="kv"><span>On Bitcoin</span><b><a href="${CLASSIC}">In the Classic app</a></b></div>
    <div class="kv"><span>To open a proposal</span><b class="num">${PROPOSE_FLOOR_TAC} TAC</b></div>
    ${on ? '' : '<button class="btn ghost" type="button" id="side-connect">Connect wallet</button>'}
    <div class="side-rule"></div>
    <p class="note">A vote weighs the TAC held when its proposal opened, on both chains.</p>
    <p class="note">Bitcoin holders prove a balance tier in the Classic app, so their exact balance stays private. Their votes show here beside Ethereum's.</p>`;
  $('#side-connect', side)?.addEventListener('click', () => conn.connect());
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
        <b>${esc(p.title)}</b>
        <span class="mini"><i style="width:${sum > 0n ? pctOf(t[bi], sum) : 0}%"></i></span>
        <span class="prop-meta">${lead}<span class="mute">${esc(fmtTac(tl.total_weight))} TAC · ${tl.private_voters || 0} Bitcoin · ${tl.public_voters || 0} Ethereum</span></span></a>`;
    }).join('') : `<div class="blank"><p>No ${S.filter === 'active' ? 'open ' : ''}proposals${S.filter ? '' : ' yet'}.</p><a class="linkbtn" href="#new">Open one</a></div>`;
  }
  return `<div class="bar"><div class="chips" role="group" aria-label="Show">${chips}</div><a class="btn sm" href="#new">New proposal</a></div>
    <div class="props">${body}</div>`;
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
  const on = !!W.account;
  let act = '';
  if (p.status === 'active') {
    const mine = on ? (p.votes || []).find((v) => v.kind === 'public' && String(v.voter || '').toLowerCase() === W.account.toLowerCase()) : null;
    const sel = S.choice ?? (mine ? mine.choice : -1), noEth = !Number.isInteger(p.eth_snapshot_block);
    act = `<form class="ballot" id="ballot"><p class="eyebrow">Vote with Ethereum TAC</p>
      <div class="opts">${p.choices.map((c, i) => `<label class="opt${sel === i ? ' on' : ''}"><input type="radio" name="c" value="${i}"${sel === i ? ' checked' : ''}><span>${esc(c)}</span></label>`).join('')}</div>
      <button class="btn" type="submit" id="vote" ${S.busy || noEth ? 'disabled' : ''}>${S.busy ? 'Waiting for your wallet…' : !on ? 'Connect wallet' : mine ? 'Change vote' : 'Sign and vote'}</button>
      ${mine ? `<p class="note" id="mine">You voted <b>${esc(p.choices[mine.choice] ?? '')}</b> with ${esc(fmtTac(mine.weight))} TAC. You can change it until voting closes.</p>` : ''}
      ${on && S.weight != null ? `<p class="note" id="weight">Your weight: <b>${esc(fmtUnits(S.weight, 18, 2))} TAC</b>, held at Ethereum block ${p.eth_snapshot_block}.${S.weight === 0n ? ' You held none then, so a vote would not count.' : ''}</p>` : ''}
      ${noEth ? '<p class="note">This proposal opened without an Ethereum snapshot, so only Bitcoin votes count.</p>' : ''}
      <p class="status" id="note" aria-live="polite"></p>
      <p class="note">On Bitcoin? <a href="${CLASSIC}">Vote privately in the Classic app</a>.</p></form>`;
  } else if (p.status === 'ended') {
    act = `<div class="ballot"><p class="note" style="margin:0">Voting has closed. Anyone can record the final tally.</p>
      <button class="btn ghost" type="button" id="fin" ${S.busy ? 'disabled' : ''}>Record the result</button><p class="status" id="note" aria-live="polite"></p></div>`;
  } else {
    act = `<div class="ballot"><p class="note" style="margin:0">${p.result?.passed ? `Passed: <b>${esc(p.result.winner_choice)}</b> with ${esc(fmtTac(p.result.winner_weight))} TAC.` : 'Did not pass.'} Final tally${p.result_cid ? `, <a href="https://ipfs.filebase.io/ipfs/${esc(p.result_cid)}" target="_blank" rel="noopener">pinned to IPFS</a>` : ''}.</p></div>`;
  }
  const votes = (p.votes || []).slice(0, 50);
  const feed = votes.length ? `<div class="sec"><p class="eyebrow">Votes <span class="who">${p.votes.length}</span></p><div class="feed">${votes.map((v) => {
    const btc = isBtc(v);
    return `<div class="vrow">${chainTag(btc)}<span class="vwho">${btc ? `key ${esc(String(v.voter || '').slice(0, 8))}…` : isAddr(v.voter) ? addrView(v.voter, 4) : '—'}</span>
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
  const on = !!W.account, enough = (S.bal ?? 0n) >= BigInt(PROPOSE_FLOOR_TAC) * 10n ** 18n;
  const d = S.draft || (S.draft = { title: '', body: '', category: 'general', dur: '604800', quorum: '', choices: ['Yes', 'No'] });
  const label = S.busy ? 'Waiting for your wallet…' : !on ? 'Connect wallet' : S.bal != null && !enough ? `Needs ${PROPOSE_FLOOR_TAC} TAC to open` : 'Sign and open';
  return `<p class="eyebrow"><a href="#">← All proposals</a></p><h2 class="ptitle">New proposal</h2>
    <p class="lede">Put a question to TAC holders. They vote with the TAC they hold, on Ethereum or Bitcoin, for as long as you choose.</p>
    <form class="form" id="newform">
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
      <button class="btn" type="submit" id="f-go" ${S.busy || (on && S.bal != null && !enough) ? 'disabled' : ''}>${esc(label)}</button>
      <p class="status" id="note" aria-live="polite"></p>
      <p class="note">On Bitcoin? <a href="${CLASSIC}">Open it privately in the Classic app</a>.</p>
    </form>`;
}

// ── actions ──
function wire(root) {
  root.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { S.filter = b.dataset.f; render(); }; });
  $('#retry', root)?.addEventListener('click', () => (S.route.name === 'detail' ? loadProposal(S.route.id) : loadList()));
  const ballot = $('#ballot', root);
  if (ballot) {
    ballot.onsubmit = (e) => { e.preventDefault(); castVote(); };
    ballot.querySelectorAll('input[name="c"]').forEach((i) => { i.onchange = () => { S.choice = +i.value; ballot.querySelectorAll('.opt').forEach((o, k) => o.classList.toggle('on', k === S.choice)); }; });
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
    form.onsubmit = (e) => { e.preventDefault(); keep(); openProposal(); };
  }
}

async function castVote() {
  if (!W.account) { await conn.connect(); return; }
  const p = S.p, picked = document.querySelector('#ballot input[name="c"]:checked'), c = picked ? +picked.value : -1;
  if (c < 0) { say('Pick a choice first.', true); return; }
  if (S.busy) return;
  S.busy = true; render();
  try {
    const sig = await conn.wallet.signMessage(voteMessage(p.id, c, p.choices[c]), W.account);
    say('Counting your TAC…');
    const j = await getJson(`/proposal/${p.id}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'public', choice: c, eth_sig: sig }) });
    S.busy = false; await loadProposal(p.id, { quiet: true });
    say(`Voted with ${fmtTac(j.weight)} TAC${j.revote ? ' (your vote changed)' : ''}.`);
  } catch (e) {
    S.busy = false; render();
    say(e.userStopped ? declinedWords(e, 'Nothing was sent.') : plain(e), !e.userStopped);
  }
}
async function openProposal() {
  if (!W.account) { await conn.connect(); return; }
  const d = S.draft;
  const choices = d.choices.map((c) => c.trim()).filter(Boolean), title = d.title.trim();
  if (!title) { say('Add a title.', true); return; }
  if (choices.length < 2 || new Set(choices).size !== choices.length) { say('Give at least two different choices.', true); return; }
  if (d.quorum.trim() && !/^\d+$/.test(d.quorum.trim())) { say('Quorum is a whole number of TAC.', true); return; }
  const c = { network: GOV_NETWORK, title, body: d.body.trim(), choices, category: d.category, voting_ends_at: Math.floor(Date.now() / 1000) + +d.dur,
    quorum: d.quorum.trim() ? (BigInt(d.quorum.trim()) * 10n ** 8n).toString() : '0', exec_target: '', exec_note: '' };
  if (S.busy) return;
  S.busy = true; render();
  try {
    const sig = await conn.wallet.signMessage(await proposeMessage(c), W.account);
    say('Opening your proposal…');
    const j = await getJson('/proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...c, kind: 'public', eth_sig: sig }) });
    S.busy = false; S.draft = null; S.list = null; location.hash = j.id;
  } catch (e) {
    S.busy = false; render();
    say(e.userStopped ? declinedWords(e, 'Nothing was sent.') : plain(e), !e.userStopped);
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
  if (/daily limit/.test(m)) return 'Too many proposals from here today. Try again tomorrow.';
  if (/archive RPC|snapshot unavailable|retry shortly/.test(m)) return 'The TAC balance could not be read just now. Try again in a minute.';
  return m;
}

// ── routing ──
function route() {
  const h = location.hash.replace(/^#/, '');
  S.choice = undefined; S.weight = undefined; S.note = '';
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
  if (S.route.name === 'list' && S.list) loadList();
  else if (S.route.name === 'detail' && S.p?.status === 'active') loadProposal(S.route.id, { quiet: true });
}, 60e3);
route();
