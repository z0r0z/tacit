// The nodes page: the leaderboard of operators and the list of nodes behind it, drawn from the prober's signed status. `load` and the pinned keys are
// passed in, so the page's logic runs without a network (tests/nodes-page.test.mjs). Every string from the status is written as text, never as markup.

export const FILTERS = [['all', 'All'], ['community', 'Community'], ['tacit', 'Tacit'], ['public', 'Public']];
const STATE = { shadow: 'testing', probation: 'probation', listed: 'listed', down: 'down', removed: 'removed' };
const ROLE = { 'eth-reads': 'Ethereum reads', 'eth-logs': 'Ethereum logs', 'eth-proofs': 'Ethereum proofs', 'eth-archive': 'Ethereum archive', 'btc-esplora': 'Bitcoin reads', 'btc-index': 'Bitcoin history' };
export const roleName = (r) => ROLE[r] || r;
const pct = (x) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
const host = (u) => { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return String(u).slice(0, 60); } };
const short = (k) => `${String(k).slice(0, 8)}…${String(k).slice(-4)}`;
const ago = (s) => (s < 90 ? 'moments' : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);

export const operatorName = (o) => (o.baseline ? (o.own ? 'Tacit nodes' : 'Public services') : o.name ? String(o.name).slice(0, 40) : `Operator ${short(o.operator)}`);
export const groupOf = (n) => (n.baseline ? (n.own ? 'tacit' : 'public') : 'community');
export const kindOf = (o) => (o.baseline ? (o.own ? 'tacit' : 'public') : 'community');

function el(doc, tag, attrs = {}, ...kids) {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : doc.createTextNode(String(k)));
  return e;
}

// what the page says about the status it was given: shown only if it verifies under a pinned key (or no key is pinned yet, and then it says so)
export function trust(status, { check, pubs, now }) {
  if (!status || status.v !== 1 || !Array.isArray(status.nodes) || !Array.isArray(status.operators)) return { show: false, line: 'The status is not readable.' };
  const age = now - (status.at || 0);
  if (!pubs.length) return { show: true, preview: true, line: 'Not verified: this build pins no signing key yet, so the figures are shown as the service gave them.' };
  if (!check(status)) return { show: false, line: 'The status does not verify against the pinned signing key, so it is not shown.' };
  return { show: true, line: `Signed by ${short(status.signer)}, ${ago(age)} ago. Verified.`, stale: age > 3600 };
}

export function mountNodes({ root, load, check, pubs, now = () => Math.floor(Date.now() / 1000), nodesOnly }) {
  const doc = root.ownerDocument;
  const $ = (id) => doc.getElementById(id);
  const S = { status: null, filter: 'all', t: null };

  function paintOps() {
    const body = $('ops-body'); body.replaceChildren();
    const ops = S.t?.show ? S.status.operators.filter((o) => S.filter === 'all' || kindOf(o) === S.filter) : [];
    $('ops-empty').hidden = ops.length > 0;
    $('ops').hidden = ops.length === 0;
    ops.forEach((o) => {
      body.append(el(doc, 'tr', {},
        el(doc, 'td', { class: 'num' }, o.rank),
        el(doc, 'td', {}, el(doc, 'b', {}, operatorName(o)), el(doc, 'small', {}, o.roles.map(roleName).join(', '))),
        el(doc, 'td', { class: 'num' }, pct(o.uptime)), el(doc, 'td', { class: 'num' }, pct(o.fresh)), el(doc, 'td', { class: 'num' }, pct(o.correct)),
        el(doc, 'td', { class: 'num' }, o.baseline ? '–' : o.score ? o.score.toFixed(1) : '0')));
    });
  }
  function paintNodes() {
    const body = $('nodes-body'); body.replaceChildren();
    const ns = S.t?.show ? S.status.nodes.filter((n) => S.filter === 'all' || groupOf(n) === S.filter) : [];
    $('nodes-empty').hidden = ns.length > 0;
    $('nodes-table').hidden = ns.length === 0;
    for (const n of ns) {
      const state = n.baseline ? (n.weight > 0 ? 'up' : 'down') : STATE[n.state] || n.state;
      const cls = n.baseline ? (n.weight > 0 ? 'ok' : 'err') : n.state === 'removed' || n.state === 'down' ? 'err' : n.state === 'listed' ? 'ok' : 'mute';
      const worst = n.roles.reduce((a, r) => (r.latency != null && (a == null || r.latency > a) ? r.latency : a), null);
      body.append(el(doc, 'tr', {},
        el(doc, 'td', {}, el(doc, 'b', {}, host(n.url)), el(doc, 'small', {}, n.name ? `${n.name} · ` : '', n.fronted ? 'behind a fronting service · ' : '', n.roles.map((r) => `${roleName(r.role)} ${pct(r.uptime)}/${pct(r.correct)}`).join(' · '))),
        el(doc, 'td', { class: cls }, state),
        el(doc, 'td', { class: 'num' }, n.baseline ? '–' : n.weight ? n.weight.toFixed(2) : '0'),
        el(doc, 'td', { class: 'num' }, worst == null ? '–' : `${worst} ms`),
        el(doc, 'td', { class: 'num mute' }, n.lastOk ? ago(now() - n.lastOk) : '–')));
    }
  }
  function paint() {
    $('sig').textContent = S.t?.line || '';
    $('sig').classList.toggle('err', !!S.t && !S.t.show);
    $('sig').classList.toggle('warn', !!S.t?.preview || !!S.t?.stale);
    doc.querySelectorAll('#filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === S.filter)));
    paintOps(); paintNodes();
  }

  const f = $('filter'); f.replaceChildren();
  for (const [k, label] of FILTERS) { const b = el(doc, 'button', { type: 'button', 'data-f': k, 'aria-pressed': String(k === S.filter) }, label); b.addEventListener('click', () => { S.filter = k; paint(); }); f.append(b); }

  const only = $('only');
  if (only) { only.checked = !!nodesOnly?.get(); only.addEventListener('change', () => { nodesOnly?.set(only.checked); $('only-note').textContent = only.checked ? 'Community nodes are off in this browser.' : 'Community nodes may answer fee reads here.'; }); only.dispatchEvent(new doc.defaultView.Event('change')); }

  async function refresh() {
    try {
      const status = await load();
      S.status = status; S.t = trust(status, { check, pubs, now: now() });
    } catch { S.status = null; S.t = { show: false, line: 'The status could not be loaded. Try again in a minute.' }; }
    paint();
    return S;
  }
  return { refresh, state: () => S };
}
