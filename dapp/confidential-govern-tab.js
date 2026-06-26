// Govern tab — off-chain TAC governance (Snapshot-style, advisory → multisig).
//
// TAC holders create proposals and vote until a deadline; results are advisory
// inputs the admin/multisig acts on (Collateral Engine admin/ownership, spec
// amendments, parameters, treasury). HYBRID weight:
//
//   • Private (Bitcoin/confidential holders) — a Bulletproofs+ THRESHOLD proof:
//     prove your TAC sum clears a tier (≥1 / ≥10 / ≥100 … TAC) WITHOUT
//     revealing the exact balance. The proven tier floor is what's counted.
//   • Public (Ethereum holders) — a transparent canonical-TAC-ERC20 balanceOf
//     authorised by a wallet signature; the exact balance is counted.
//
// All proposal/vote state is pinned to IPFS + indexed in the worker KV. This
// module is pure UI + orchestration; every signed/hashed input is produced by
// governanceApi() in tacit.js so the worker can verify it. Styling uses the
// scoped #tab-govern classes (index.html) so it matches tacit's ink-on-paper
// design tokens and theme.

const el = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CAT_LABEL = {
  'collateral-engine': 'Collateral Engine',
  'spec-amendment': 'Spec Amendment',
  'parameter': 'Parameter',
  'treasury': 'Treasury',
  'general': 'General',
};

function fmtTac(baseStr) {
  let v = 0n; try { v = BigInt(baseStr || '0'); } catch {}
  const whole = v / 100000000n;
  const frac = (v % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${w}.${frac}` : w;
}
function fmtCountdown(endsAt) {
  const s = endsAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'ended';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}
function tierLabel(gov, tierBig) { return `${(tierBig / gov.tacBase).toString()} TAC`; }
function catBadge(cat) { return `<span class="gov-badge">${esc(CAT_LABEL[cat] || cat)}</span>`; }
function leadingChoice(p) {
  const totals = (p.tally?.totals || []).map((x) => { try { return BigInt(x); } catch { return 0n; } });
  const total = totals.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;
  let bi = 0, bw = -1n;
  totals.forEach((w, i) => { if (w > bw) { bw = w; bi = i; } });
  return { label: p.choices[bi], pct: Number((bw * 1000n) / total) / 10 };
}

// ---- module state ----------------------------------------------------------
let _gov = null, _wallet = null, _view = { mode: 'list', filter: 'active', id: null };
let _tacBalance = null;            // cached BigInt | null
let _timer = null;

export async function renderGovernTab(wallet, gov) {
  _wallet = wallet; _gov = gov;
  const body = el('govern-body');
  if (!body) return;
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_view.mode === 'detail' && _view.id) return renderDetail(body);
  if (_view.mode === 'create') return renderCreate(body);
  return renderList(body);
}

// ============================ LIST ==========================================
async function renderList(body) {
  body.innerHTML = `
    <div class="note-concept" style="margin-bottom:14px;"><b>TAC governance.</b> Holders steer the protocol —
      Collateral Engine admin, spec amendments, parameters, treasury. Vote with your TAC held on
      <b>Bitcoin</b> (private threshold proof — your balance stays hidden) or on <b>Ethereum</b>
      (public ERC20 balance). Results are advisory inputs the multisig executes.</div>
    <div class="gov-toolbar">
      <div id="gov-filters" style="display:flex;gap:6px;"></div>
      <span style="flex:1;"></span>
      <button id="gov-new-btn" class="btn">+ New proposal</button>
    </div>
    <div id="gov-list" class="muted" style="font-size:12px;">Loading proposals…</div>`;

  const filters = el('gov-filters');
  [['active', 'Active'], ['ended', 'Awaiting tally'], ['closed', 'Closed'], ['', 'All']].forEach(([k, lbl]) => {
    const b = document.createElement('button');
    b.className = 'gov-chip' + (_view.filter === k ? ' is-active' : '');
    b.textContent = lbl;
    b.onclick = () => { _view.filter = k; renderGovernTab(_wallet, _gov); };
    filters.appendChild(b);
  });
  el('gov-new-btn').onclick = () => { _view.mode = 'create'; renderGovernTab(_wallet, _gov); };

  let proposals;
  try { proposals = await _gov.listProposals(_view.filter || undefined); }
  catch (e) { el('gov-list').innerHTML = `<div class="gov-err">Could not load proposals: ${esc(e.message)}</div>`; return; }

  const wrap = el('gov-list');
  if (!wrap) return;
  if (!proposals.length) {
    wrap.innerHTML = `<div style="line-height:1.7;">No ${esc(_view.filter || '')} proposals yet.
      ${_gov.walletReady() ? 'Be the first — <b>+ New proposal</b> (≥100 TAC to open one).' : 'Unlock a wallet to participate.'}</div>`;
    return;
  }
  wrap.innerHTML = proposals.map((p) => proposalCard(p)).join('');
  proposals.forEach((p) => {
    const card = el('gov-card-' + p.id);
    if (card) card.onclick = () => { _view.mode = 'detail'; _view.id = p.id; renderGovernTab(_wallet, _gov); };
  });
  _timer = setInterval(() => {
    proposals.forEach((p) => { const c = el('gov-cd-' + p.id); if (c) c.textContent = fmtCountdown(p.voting_ends_at); });
  }, 30000);
}

function proposalCard(p) {
  const totalW = p.tally?.total_weight || '0';
  const lead = leadingChoice(p);
  const statusTxt = p.status === 'active' ? fmtCountdown(p.voting_ends_at) : (p.status === 'closed' ? 'finalized' : 'awaiting tally');
  return `<div id="gov-card-${p.id}" class="gov-card">
    <div class="gov-card-top">
      ${catBadge(p.category)}
      <span class="gov-status ${p.status}">${esc(p.status)}</span>
      <span style="flex:1;"></span>
      <span id="gov-cd-${p.id}" style="font-size:11px;color:var(--ink-mid);">${esc(statusTxt)}</span>
    </div>
    <div class="gov-ctitle">${esc(p.title)}</div>
    <div class="gov-meta">
      <span>${p.tally?.voters || 0} voter${(p.tally?.voters || 0) === 1 ? '' : 's'}</span>
      <span>${fmtTac(totalW)} TAC</span>
      ${lead ? `<span>leading: <b>${esc(lead.label)}</b> · ${lead.pct}%</span>` : ''}
      ${p.result?.passed ? '<span class="gov-ok" style="font-weight:600;">✓ passed</span>' : (p.status === 'closed' ? '<span style="color:var(--red-warn);">did not pass</span>' : '')}
    </div>
  </div>`;
}

// ============================ DETAIL ========================================
async function renderDetail(body) {
  body.innerHTML = `<div style="margin-bottom:12px;"><a id="gov-back" class="gov-link">← All proposals</a></div>
    <div id="gov-detail" class="muted" style="font-size:12px;">Loading…</div>`;
  el('gov-back').onclick = () => { _view.mode = 'list'; _view.id = null; renderGovernTab(_wallet, _gov); };

  let p;
  try { p = await _gov.getProposal(_view.id, true); }
  catch (e) { el('gov-detail').innerHTML = `<div class="gov-err">Could not load: ${esc(e.message)}</div>`; return; }
  const d = el('gov-detail'); if (!d) return;

  const totals = (p.tally?.totals || []).map((x) => { try { return BigInt(x); } catch { return 0n; } });
  const total = totals.reduce((a, b) => a + b, 0n);
  const quorum = (() => { try { return BigInt(p.quorum || '0'); } catch { return 0n; } })();
  const quorumPct = quorum > 0n ? Math.min(100, Number((total * 100n) / quorum)) : null;

  d.innerHTML = `
    <div class="gov-card-top" style="margin-bottom:10px;">
      ${catBadge(p.category)}
      <span class="gov-status ${p.status}">${esc(p.status)}</span>
      <span style="flex:1;"></span>
      <span style="font-size:11px;color:var(--ink-mid);">${p.status === 'active' ? fmtCountdown(p.voting_ends_at) : new Date(p.voting_ends_at * 1000).toLocaleString()}</span>
    </div>
    <h3 style="margin:0 0 10px;font-size:18px;line-height:1.25;">${esc(p.title)}</h3>
    <div style="font-size:13px;line-height:1.65;white-space:pre-wrap;margin-bottom:16px;">${esc(p.body)}</div>
    ${p.exec_target || p.exec_note ? `<div class="gov-soft" style="margin-bottom:16px;">
      <b>Execution target:</b> ${esc(p.exec_target || '—')}${p.exec_note ? `<br>${esc(p.exec_note)}` : ''}</div>` : ''}

    <div style="margin-bottom:18px;">${resultsHtml(p, totals, total)}</div>

    ${quorum > 0n ? `<div style="margin-bottom:18px;">
      <div style="font-size:11px;color:var(--ink-mid);margin-bottom:5px;">Quorum: ${fmtTac(total.toString())} / ${fmtTac(quorum.toString())} TAC ${quorumPct >= 100 ? '· met ✓' : `· ${quorumPct}%`}</div>
      <div class="gov-track"><div class="gov-fill ${quorumPct >= 100 ? 'win' : ''}" style="width:${quorumPct}%;"></div></div>
    </div>` : ''}

    <div class="gov-meta" style="margin-bottom:16px;">
      <span>${p.tally?.voters || 0} voters</span>
      <span>${p.tally?.private_voters || 0} private 🔒</span>
      <span>${p.tally?.public_voters || 0} public</span>
      ${p.cid ? `<a href="https://ipfs.io/ipfs/${esc(p.cid)}" target="_blank" rel="noopener" class="gov-link">proposal on IPFS ↗</a>` : ''}
      ${p.result_cid ? `<a href="https://ipfs.io/ipfs/${esc(p.result_cid)}" target="_blank" rel="noopener" class="gov-link">result snapshot ↗</a>` : ''}
    </div>

    <div id="gov-vote-zone"></div>`;

  renderVoteZone(p);
}

function resultsHtml(p, totals, total) {
  return p.choices.map((c, i) => {
    const w = totals[i] || 0n;
    const pct = total > 0n ? Number((w * 1000n) / total) / 10 : 0;
    const win = p.result && p.result.winner === i;
    return `<div style="margin-bottom:10px;">
      <div class="gov-row">
        <span style="font-weight:${win ? 600 : 400};">${esc(c)}${win ? ' ✓' : ''}</span>
        <span style="color:var(--ink-mid);">${fmtTac(w.toString())} TAC · ${pct}%</span>
      </div>
      <div class="gov-track"><div class="gov-fill ${win ? 'win' : ''}" style="width:${pct}%;"></div></div>
    </div>`;
  }).join('');
}

async function renderVoteZone(p) {
  const zone = el('gov-vote-zone');
  if (!zone) return;

  if (p.status === 'closed') {
    zone.innerHTML = `<div class="gov-soft">
      ${p.result?.passed ? `<b class="gov-ok">Passed</b> — “${esc(p.result.winner_choice)}” with ${fmtTac(p.result.winner_weight)} TAC.` : '<b>Did not pass.</b>'}
      Advisory result recorded${p.result_cid ? ' and pinned to IPFS' : ''}; the multisig executes accordingly.</div>`;
    return;
  }
  if (p.status === 'ended') {
    zone.innerHTML = `<div class="gov-soft">
      Voting closed — tally not yet finalized. <button id="gov-finalize" class="btn" style="margin-left:8px;">Finalize result</button>
      <div id="gov-finalize-status" style="margin-top:6px;color:var(--ink-mid);"></div></div>`;
    el('gov-finalize').onclick = async () => {
      const st = el('gov-finalize-status'); st.textContent = 'Finalizing…';
      try { await _gov.finalize(p.id); _view.mode = 'detail'; renderGovernTab(_wallet, _gov); }
      catch (e) { st.innerHTML = `<span class="gov-err">✗ ${esc(e.message)}</span>`; }
    };
    return;
  }

  // active — render the ballot
  const choiceRadios = p.choices.map((c, i) =>
    `<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 0;cursor:pointer;">
      <input type="radio" name="gov-choice" value="${i}"> ${esc(c)}</label>`).join('');

  if (_tacBalance === null && _gov.walletReady()) {
    try { _tacBalance = await _gov.readTacBalance(); } catch { _tacBalance = 0n; }
  }
  const highest = _gov.walletReady() ? _gov.highestTier(_tacBalance ?? 0n) : null;
  const tierOptions = _gov.tiers.filter((t) => highest !== null && t <= highest)
    .map((t) => `<option value="${t.toString()}">${tierLabel(_gov, t)}</option>`).join('');

  zone.innerHTML = `
    <div class="gov-votebox">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px;">Cast your vote</div>
      <div style="margin-bottom:14px;">${choiceRadios}</div>
      <div class="gov-methods">
        <div class="gov-method">
          <div style="font-size:12px;font-weight:600;margin-bottom:5px;">🔒 Private — Bitcoin TAC</div>
          ${_gov.walletReady()
      ? (highest !== null
        ? `<div style="font-size:11px;color:var(--ink-mid);margin-bottom:8px;line-height:1.5;">Prove a tier without revealing your balance. Higher tier = more weight; lower = more privacy.</div>
             <select id="gov-tier" class="gov-field" style="margin-bottom:8px;">${tierOptions}</select>
             <button id="gov-vote-private" class="btn" style="width:100%;">Vote privately</button>`
        : `<div style="font-size:11px;color:var(--ink-mid);">This wallet holds ${fmtTac((_tacBalance ?? 0n).toString())} TAC — below the 1 TAC minimum tier.</div>`)
      : '<div style="font-size:11px;color:var(--ink-mid);">Unlock a Tacit wallet to vote with Bitcoin-held TAC.</div>'}
        </div>
        <div class="gov-method">
          <div style="font-size:12px;font-weight:600;margin-bottom:5px;">Public — Ethereum TAC</div>
          <div style="font-size:11px;color:var(--ink-mid);margin-bottom:8px;line-height:1.5;">Sign with your ETH wallet; your exact public ERC20 balance is counted.</div>
          <button id="gov-vote-public" class="btn" style="width:100%;">${_gov.ethConnected() ? 'Vote with public balance' : 'Connect ETH wallet & vote'}</button>
        </div>
      </div>
      <div id="gov-vote-status" style="font-size:12px;margin-top:12px;color:var(--ink-mid);"></div>
    </div>`;

  const selectedChoice = () => {
    const r = document.querySelector('input[name="gov-choice"]:checked');
    return r ? parseInt(r.value, 10) : -1;
  };
  const status = el('gov-vote-status');

  const pvBtn = el('gov-vote-private');
  if (pvBtn) pvBtn.onclick = async () => {
    const ci = selectedChoice();
    if (ci < 0) { status.textContent = 'Pick a choice first.'; return; }
    const tier = BigInt(el('gov-tier').value);
    pvBtn.disabled = true; status.textContent = 'Building threshold proof (balance never revealed)…';
    try {
      const res = await _gov.votePrivate(p.id, ci, tier);
      status.innerHTML = `<span class="gov-ok">✓ Voted privately at ${tierLabel(_gov, tier)}${res.revote ? ' (updated)' : ''}.</span>`;
      setTimeout(() => renderGovernTab(_wallet, _gov), 900);
    } catch (e) { status.innerHTML = `<span class="gov-err">✗ ${esc(e.message)}</span>`; pvBtn.disabled = false; }
  };

  const pubBtn = el('gov-vote-public');
  if (pubBtn) pubBtn.onclick = async () => {
    const ci = selectedChoice();
    if (ci < 0) { status.textContent = 'Pick a choice first.'; return; }
    pubBtn.disabled = true; status.textContent = 'Requesting wallet signature…';
    try {
      const res = await _gov.votePublic(p.id, ci, p.choices[ci]);
      status.innerHTML = `<span class="gov-ok">✓ Voted with ${fmtTac(res.weight)} TAC (public)${res.revote ? ' (updated)' : ''}.</span>`;
      setTimeout(() => renderGovernTab(_wallet, _gov), 900);
    } catch (e) { status.innerHTML = `<span class="gov-err">✗ ${esc(e.message)}</span>`; pubBtn.disabled = false; }
  };
}

// ============================ CREATE ========================================
async function renderCreate(body) {
  body.innerHTML = `<div style="margin-bottom:12px;"><a id="gov-cancel" class="gov-link">← Cancel</a></div>
    <h3 style="margin:0 0 4px;font-size:16px;">New proposal</h3>
    <div style="font-size:11px;color:var(--ink-mid);margin-bottom:16px;line-height:1.5;">Opening a proposal requires proving you hold ≥100 TAC (threshold proof — your balance stays hidden). The proposal is pinned to IPFS.</div>
    ${_gov.walletReady() ? '' : '<div style="color:var(--red-warn);font-size:12px;margin-bottom:14px;">Unlock a Tacit wallet first — the proposal is bound to your TAC stake.</div>'}
    <div class="gov-form">
      <label class="gov-label">Title
        <input id="gp-title" class="gov-field" maxlength="140" style="margin-top:4px;" placeholder="e.g. Transfer Collateral Engine admin to the 3/5 multisig"></label>
      <label class="gov-label">Category
        <select id="gp-category" class="gov-field" style="margin-top:4px;">
          ${_gov.categories.map((c) => `<option value="${c}">${esc(CAT_LABEL[c] || c)}</option>`).join('')}
        </select></label>
      <label class="gov-label">Details
        <textarea id="gp-body" class="gov-field" rows="6" maxlength="12000" style="margin-top:4px;" placeholder="Rationale, links, exact change requested…"></textarea></label>
      <div>
        <div class="gov-label" style="margin-bottom:6px;">Choices</div>
        <div id="gp-choices"></div>
        <button id="gp-add-choice" class="btn" style="font-size:11px;margin-top:4px;padding:4px 10px;">+ Add choice</button>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <label class="gov-label" style="flex:1;min-width:150px;">Voting period
          <select id="gp-duration" class="gov-field" style="margin-top:4px;">
            <option value="86400">1 day</option>
            <option value="259200">3 days</option>
            <option value="604800" selected>7 days</option>
            <option value="1209600">14 days</option>
            <option value="2592000">30 days</option>
          </select></label>
        <label class="gov-label" style="flex:1;min-width:150px;">Quorum (TAC, optional)
          <input id="gp-quorum" class="gov-field" type="number" min="0" step="1" style="margin-top:4px;" placeholder="0 = none"></label>
      </div>
      <label class="gov-label">Execution target (optional)
        <input id="gp-exec-target" class="gov-field" maxlength="80" style="margin-top:4px;" placeholder="e.g. CollateralEngine.setAdmin(0x…)"></label>
      <label class="gov-label">Execution note (optional)
        <input id="gp-exec-note" class="gov-field" maxlength="400" style="margin-top:4px;" placeholder="What the multisig should do if this passes"></label>
      <button id="gp-submit" class="btn" ${_gov.walletReady() ? '' : 'disabled'}>Publish proposal</button>
      <div id="gp-status" style="font-size:12px;color:var(--ink-mid);"></div>
    </div>`;

  el('gov-cancel').onclick = () => { _view.mode = 'list'; renderGovernTab(_wallet, _gov); };

  const choicesWrap = el('gp-choices');
  const choices = ['Yes', 'No', 'Abstain'];
  const renderChoices = () => {
    choicesWrap.innerHTML = choices.map((c, i) =>
      `<div style="display:flex;gap:6px;margin-bottom:6px;">
        <input class="gp-choice gov-field" data-i="${i}" value="${esc(c)}" maxlength="80">
        ${choices.length > 2 ? `<button class="gp-del btn" data-i="${i}" style="padding:0 12px;">✕</button>` : ''}
      </div>`).join('');
    choicesWrap.querySelectorAll('.gp-choice').forEach((inp) => {
      inp.oninput = () => { choices[parseInt(inp.dataset.i, 10)] = inp.value; };
    });
    choicesWrap.querySelectorAll('.gp-del').forEach((b) => {
      b.onclick = () => { choices.splice(parseInt(b.dataset.i, 10), 1); renderChoices(); };
    });
  };
  renderChoices();
  el('gp-add-choice').onclick = () => { if (choices.length < 8) { choices.push(''); renderChoices(); } };

  el('gp-submit').onclick = async () => {
    const status = el('gp-status');
    const title = el('gp-title').value.trim();
    const text = el('gp-body').value.trim();
    const cleanChoices = choices.map((c) => c.trim()).filter(Boolean);
    const category = el('gp-category').value;
    const duration = parseInt(el('gp-duration').value, 10);
    const quorumTac = el('gp-quorum').value.trim();
    if (!title) { status.textContent = 'Title is required.'; return; }
    if (cleanChoices.length < 2) { status.textContent = 'At least 2 distinct choices.'; return; }
    if (new Set(cleanChoices).size !== cleanChoices.length) { status.textContent = 'Choices must be distinct.'; return; }
    let quorum = '0';
    if (quorumTac && /^\d+$/.test(quorumTac)) quorum = (BigInt(quorumTac) * _gov.tacBase).toString();

    el('gp-submit').disabled = true;
    status.textContent = 'Proving ≥100 TAC + pinning proposal to IPFS…';
    try {
      const res = await _gov.createProposal({
        title, body: text, choices: cleanChoices, category,
        voting_ends_at: Math.floor(Date.now() / 1000) + duration,
        snapshot_height: 0, quorum,
        exec_target: el('gp-exec-target').value.trim(),
        exec_note: el('gp-exec-note').value.trim(),
      });
      _tacBalance = null; // force re-read on next ballot
      _view.mode = 'detail'; _view.id = res.id;
      renderGovernTab(_wallet, _gov);
    } catch (e) {
      status.innerHTML = `<span class="gov-err">✗ ${esc(e.message)}</span>`;
      el('gp-submit').disabled = false;
    }
  };
}
