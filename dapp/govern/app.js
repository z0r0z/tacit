import { makeConnect } from '/trade/connect.js?cb=514272b7';
import { declinedWords } from '/wallet-prompts.js';
import { addrView } from '/address-view.js?cb=58dd4914';
import { esc } from '/trade/sheet.js?cb=d857446c';
import { API, $, short, fmtUnits, rpc } from '/trade/util.js?cb=9c8b4133';
import { TAC as TAC_ERC20 } from '/trade/farm-read.js?cb=fb6ec72f';
import { GOV_NETWORK, PROPOSE_FLOOR_TAC, CATEGORIES, voteMessage, proposeMessage } from '/govern/message.js?cb=c73bd573';

// TAC holders signal on proposals here. A holder with TAC in an Ethereum wallet votes or opens a proposal by signing a message (nothing is sent on chain);
// the API reads the TAC held at the proposal's snapshot block. Holders with TAC on Bitcoin do the same, privately, in the Classic app: both are counted
// in the same tally. Results advise; they do not move funds.
const CLASSIC = '/classic.html#tab=govern';
const E10 = 10n ** 10n;
const q = (p) => `${API}/governance${p}${p.includes('?') ? '&' : '?'}network=${GOV_NETWORK}`;
const S = { filter: 'active', list: null, loadErr: '', p: null, bal: null, busy: false, note: '', bad: false, route: { name: 'list' } };
const say = (text, bad = false) => { S.note = text; S.bad = bad; const el = $('#note'); if (el) { el.className = `status${bad ? ' err' : ''}`; el.textContent = text; } };
const conn = makeConnect({
  describe: 'Governance: vote on TAC proposals', name: 'tacit governance', rewards: false,
  say: (t, b) => say(t, b), busy: () => S.busy, onChange: () => { S.bal = null; render(); readBalance(); },
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
  S.list = null; S.loadErr = ''; render();
  try { S.list = (await getJson('/proposals')).proposals || []; } catch (e) { S.loadErr = 'Could not load proposals. Try again in a moment.'; }
  render();
}
async function loadProposal(id) {
  S.p = null; S.loadErr = ''; render();
  try { S.p = (await getJson(`/proposal/${id}`)).proposal; } catch (e) { S.loadErr = e.status === 404 ? 'No such proposal.' : 'Could not load this proposal. Try again in a moment.'; }
  render(); readWeight();
}
async function readBalance() {
  const who = W.account; if (!who) return;
  try {
    const raw = await rpc('eth_call', [{ to: TAC_ERC20, data: `0x70a08231${'0'.repeat(24)}${who.slice(2).toLowerCase()}` }, 'latest']);
    if (who === W.account && /^0x[0-9a-fA-F]{64}$/.test(raw || '')) { S.bal = BigInt(raw); render(); }
  } catch { /* the balance line stays empty */ }
}
// the holder's weight on this proposal: the TAC held at its snapshot block (an archive answer; left out when the nodes cannot give one)
async function readWeight() {
  const who = W.account, p = S.p;
  if (!who || !p || !Number.isInteger(p.eth_snapshot_block)) return;
  try {
    const raw = await rpc('eth_call', [{ to: TAC_ERC20, data: `0x70a08231${'0'.repeat(24)}${who.slice(2).toLowerCase()}` }, `0x${p.eth_snapshot_block.toString(16)}`]);
    if (S.p === p && who === W.account && /^0x[0-9a-fA-F]{64}$/.test(raw || '')) { S.weight = BigInt(raw); render(); }
  } catch { /* no archive answer */ }
}

// ── format ──
const fmtTac = (base) => { let v = 0n; try { v = BigInt(base || '0'); } catch { /* 0 */ } return fmtUnits(v, 8, 2); };
function left(endsAt) {
  const s = endsAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'ended';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
const statusWord = (p) => (p.status === 'active' ? left(p.voting_ends_at) : p.status === 'closed' ? (p.result?.passed ? 'passed' : 'did not pass') : 'awaiting tally');
const totals = (p) => (p.tally?.totals || []).map((x) => { try { return BigInt(x); } catch { return 0n; } });
const proposer = (p) => (/^0x[0-9a-fA-F]{40}$/.test(p.proposer_pubkey || '') ? addrView(p.proposer_pubkey, 5) : 'a Bitcoin holder');

// ── views ──
function render() {
  const root = $('#app');
  const r = S.route;
  root.innerHTML = r.name === 'new' ? newView() : r.name === 'detail' ? detailView() : listView();
  wire(root);
}
const holdingNote = () => `<p class="note">TAC on Bitcoin? <a href="${CLASSIC}">Vote or propose privately in the Classic app</a>; those votes land in the same tally. Weight is the TAC held when the proposal opened.</p>`;

function listView() {
  const chips = [['active', 'Open'], ['ended', 'To tally'], ['closed', 'Closed'], ['', 'All']]
    .map(([k, l]) => `<button class="chip-f${S.filter === k ? ' on' : ''}" type="button" data-f="${k}">${l}</button>`).join('');
  let body;
  if (S.loadErr) body = `<p class="status err">${esc(S.loadErr)} <button class="linkbtn" type="button" id="retry">Retry</button></p>`;
  else if (S.list === null) body = '<p class="empty">Loading…</p>';
  else {
    const rows = S.list.filter((p) => !S.filter || p.status === S.filter).sort((a, b) => b.created_at - a.created_at);
    body = rows.length ? rows.map((p) => {
      const t = totals(p), sum = t.reduce((a, b) => a + b, 0n);
      let lead = '';
      if (sum > 0n) { let bi = 0; t.forEach((w, i) => { if (w > t[bi]) bi = i; }); lead = ` · ${esc(p.choices[bi])} ${Number((t[bi] * 1000n) / sum) / 10}%`; }
      return `<a class="prop" href="#${p.id}"><b>${esc(p.title)}</b>
        <span class="mute">${esc(statusWord(p))} · ${p.tally?.voters || 0} voter${p.tally?.voters === 1 ? '' : 's'} · ${esc(fmtTac(p.tally?.total_weight))} TAC${lead}</span></a>`;
    }).join('') : '<p class="empty">No proposals here yet.</p>';
  }
  return `<div class="bar"><div class="chips">${chips}</div><a class="btn ghost sm" href="#new">New proposal</a></div>
    <div class="props">${body}</div>${holdingNote()}`;
}

function detailView() {
  const p = S.p;
  const back = '<p class="eyebrow"><a href="#">← All proposals</a></p>';
  if (S.loadErr) return `${back}<p class="status err">${esc(S.loadErr)}</p>`;
  if (!p) return `${back}<p class="empty">Loading…</p>`;
  const t = totals(p), sum = t.reduce((a, b) => a + b, 0n);
  const quorum = (() => { try { return BigInt(p.quorum || '0'); } catch { return 0n; } })();
  const bars = p.choices.map((c, i) => {
    const pct = sum > 0n ? Number((t[i] * 1000n) / sum) / 10 : 0, win = p.result && p.result.winner === i;
    return `<div class="res"><div class="kv"><span>${esc(c)}${win ? ' ✓' : ''}</span><b class="num">${esc(fmtTac(t[i].toString()))} TAC · ${pct}%</b></div><div class="track"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
  const on = !!W.account;
  let act = '';
  if (p.status === 'active') {
    const sel = S.choice ?? -1;
    const hasW = S.weight != null;
    act = `<form class="ballot" id="ballot"><div class="eyebrow">Your vote</div>
      ${p.choices.map((c, i) => `<label class="opt"><input type="radio" name="c" value="${i}"${sel === i ? ' checked' : ''}> ${esc(c)}</label>`).join('')}
      <button class="btn" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Waiting for your wallet…' : on ? 'Sign and vote' : 'Connect wallet'}</button>
      ${on && hasW ? `<p class="note">Your weight here: ${esc(fmtUnits(S.weight, 18, 2))} TAC, as held at block ${p.eth_snapshot_block}.</p>` : ''}
      ${!Number.isInteger(p.eth_snapshot_block) ? '<p class="note">This proposal has no Ethereum snapshot, so only Bitcoin votes count.</p>' : ''}
      <p class="status" id="note" aria-live="polite"></p></form>`;
  } else if (p.status === 'ended') {
    act = `<div class="ballot"><p class="note" style="margin:0">Voting closed. The result is recorded when someone finalizes it.</p>
      <button class="btn ghost" type="button" id="fin" ${S.busy ? 'disabled' : ''}>Finalize result</button><p class="status" id="note" aria-live="polite"></p></div>`;
  } else {
    act = `<div class="ballot"><p class="note" style="margin:0">${p.result?.passed ? `Passed: “${esc(p.result.winner_choice)}” with ${esc(fmtTac(p.result.winner_weight))} TAC.` : 'Did not pass.'} Advisory result${p.result_cid ? ', pinned to IPFS' : ''}.</p></div>`;
  }
  return `${back}<h2 class="ptitle">${esc(p.title)}</h2>
    <div class="kv"><span>Status</span><b>${esc(statusWord(p))}</b></div>
    <div class="kv"><span>Proposed by</span><b>${proposer(p)}</b></div>
    <div class="kv"><span>Voters</span><b class="num">${p.tally?.voters || 0} (${p.tally?.private_voters || 0} Bitcoin, ${p.tally?.public_voters || 0} Ethereum)</b></div>
    <div class="body">${esc(p.body)}</div>
    <div class="rows">${bars}</div>
    ${quorum > 0n ? `<p class="note">Quorum ${esc(fmtTac(sum.toString()))} / ${esc(fmtTac(quorum.toString()))} TAC${sum >= quorum ? ' · met' : ''}</p>` : ''}
    ${act}
    ${p.cid ? `<p class="note"><a href="https://ipfs.filebase.io/ipfs/${esc(p.cid)}" target="_blank" rel="noopener">Proposal on IPFS</a>${p.result_cid ? ` · <a href="https://ipfs.filebase.io/ipfs/${esc(p.result_cid)}" target="_blank" rel="noopener">Result</a>` : ''}</p>` : ''}
    ${p.status === 'active' ? holdingNote() : ''}`;
}

function newView() {
  const on = !!W.account, enough = (S.bal ?? 0n) >= BigInt(PROPOSE_FLOOR_TAC) * 10n ** 18n;
  const d = S.draft || (S.draft = { title: '', body: '', category: 'general', dur: '604800', quorum: '', choices: ['Yes', 'No'] });
  return `<p class="eyebrow"><a href="#">← All proposals</a></p><h2 class="ptitle">New proposal</h2>
    <p class="note" style="margin:0 0 14px">A signal among TAC holders: it records what holders want and moves nothing by itself. You need ${PROPOSE_FLOOR_TAC} TAC${on && S.bal != null ? ` (you hold ${esc(fmtUnits(S.bal, 18, 2))})` : ''} when it opens.</p>
    <form class="form" id="newform">
      <label>Title<input class="fld" id="f-title" maxlength="140" value="${esc(d.title)}" required></label>
      <label>Details<textarea class="fld" id="f-body" rows="7" maxlength="12000" placeholder="What you propose, why, and any links">${esc(d.body)}</textarea></label>
      <label>Topic<select class="fld" id="f-cat">${CATEGORIES.map(([k, l]) => `<option value="${k}"${d.category === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <div><div class="lbl">Choices</div><div id="f-choices">${d.choices.map((c, i) => `<div class="crow"><input class="fld f-ch" data-i="${i}" maxlength="80" value="${esc(c)}">${d.choices.length > 2 ? `<button class="btn ghost sm" type="button" data-del="${i}" aria-label="Remove choice">✕</button>` : ''}</div>`).join('')}</div>
        ${d.choices.length < 8 ? '<button class="linkbtn" type="button" id="f-add">Add a choice</button>' : ''}</div>
      <div class="two"><label>Voting open for<select class="fld" id="f-dur">${[['86400', '1 day'], ['259200', '3 days'], ['604800', '7 days'], ['1209600', '14 days'], ['2592000', '30 days']].map(([v, l]) => `<option value="${v}"${d.dur === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Quorum, TAC (optional)<input class="fld" id="f-quorum" inputmode="numeric" placeholder="none" value="${esc(d.quorum)}"></label></div>
      <button class="btn" type="submit" ${S.busy || (on && S.bal != null && !enough) ? 'disabled' : ''}>${S.busy ? 'Waiting for your wallet…' : !on ? 'Connect wallet' : S.bal != null && !enough ? `Needs ${PROPOSE_FLOOR_TAC} TAC` : 'Sign and open'}</button>
      <p class="status" id="note" aria-live="polite"></p>
    </form>
    <p class="note">TAC on Bitcoin? <a href="${CLASSIC}">Open it privately in the Classic app</a>.</p>`;
}

// ── actions ──
function wire(root) {
  root.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { S.filter = b.dataset.f; render(); }; });
  $('#retry', root)?.addEventListener('click', () => (S.route.name === 'detail' ? loadProposal(S.route.id) : loadList()));
  const ballot = $('#ballot', root);
  if (ballot) {
    ballot.onsubmit = (e) => { e.preventDefault(); castVote(); };
    ballot.querySelectorAll('input[name="c"]').forEach((i) => { i.onchange = () => { S.choice = +i.value; }; });
  }
  $('#fin', root)?.addEventListener('click', finalize);
  const form = $('#newform', root);
  if (form) {
    const d = S.draft, keep = () => {
      d.title = $('#f-title').value; d.body = $('#f-body').value; d.category = $('#f-cat').value; d.dur = $('#f-dur').value; d.quorum = $('#f-quorum').value;
      root.querySelectorAll('.f-ch').forEach((i) => { d.choices[+i.dataset.i] = i.value; });
    };
    form.oninput = keep;
    $('#f-add')?.addEventListener('click', () => { keep(); d.choices.push(''); render(); });
    root.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { keep(); d.choices.splice(+b.dataset.del, 1); render(); }; });
    form.onsubmit = (e) => { e.preventDefault(); keep(); openProposal(); };
  }
}

async function castVote() {
  if (!W.account) { await conn.connect(); return; }
  const p = S.p, c = S.choice ?? -1;
  if (c < 0) { say('Pick a choice first.', true); return; }
  if (S.busy) return;
  S.busy = true; render();
  try {
    const sig = await conn.wallet.signMessage(voteMessage(p.id, c, p.choices[c]), W.account);
    say('Counting your TAC…');
    const j = await getJson(`/proposal/${p.id}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'public', choice: c, eth_sig: sig }) });
    S.busy = false; await loadProposal(p.id);
    say(`Voted with ${fmtTac(j.weight)} TAC${j.revote ? ' (changed your vote)' : ''}.`);
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
    S.busy = false; S.draft = null; location.hash = j.id;
  } catch (e) {
    S.busy = false; render();
    say(e.userStopped ? declinedWords(e, 'Nothing was sent.') : plain(e), !e.userStopped);
  }
}
async function finalize() {
  S.busy = true; render();
  try { await getJson(`/proposal/${S.p.id}/finalize`, { method: 'POST' }); S.busy = false; await loadProposal(S.p.id); }
  catch (e) { S.busy = false; render(); say(plain(e), true); }
}
const plain = (e) => String(e.message || 'Something went wrong.');

// ── routing ──
function route() {
  const h = location.hash.replace(/^#/, '');
  S.choice = undefined; S.weight = undefined; S.note = '';
  if (/^[0-9a-f]{64}$/.test(h)) { S.route = { name: 'detail', id: h }; loadProposal(h); }
  else if (h === 'new') { S.route = { name: 'new' }; render(); readBalance(); }
  else { S.route = { name: 'list' }; loadList(); }
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
setInterval(() => { if (S.route.name === 'list' && S.list) render(); }, 60e3);
route();
