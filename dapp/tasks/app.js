// The tasks page: jobs anyone can do for TAC from the points program's separate task budget. A job is a list of steps (transactions);
// the page shows what each does, checks in the browser that the transactions it would send are the plan's, sends the ones still
// open from the visitor's wallet, and names each one to the points service, which reads it from the chain, prices it from the gas
// of its own block and the TAC price around it, and credits the account that sent it. What the page sends is decided from the chain,
// never from the service: the deployment is the same from any browser. What it shows as done may come from the service's claims (each
// is a step the service has read from the chain), so that a visit does not download the code of every contract a job deployed.
//
// Open jobs are shown in full; a job that is done is a tile with its result, and opens to what it did when it is clicked.
import { makeConnect, UserStopped } from '/trade/connect.js?cb=cbf21295';
import { declinedWords } from '/wallet-prompts.js';
import { esc } from '/trade/sheet.js?cb=c8f387a5';
import { rpc, RPCS, $, short, fmtUnits } from '/trade/util.js?cb=1d2cd8d3';
import { addrView, addrFlat } from '/address-view.js?cb=58dd4914';
import { bodyType } from '/trade/rpc.js';
import { BASE_NODES, ROBINHOOD_NODES } from '/eth-nodes.js';
import { checkPayload, checkStep } from '/tasks/verify.js?cb=b8174dad';
import { trace, guide } from '/tasks/inspect.js?cb=3c995729';
import { keccak_256 } from '/vendor/tacit-deps.min.js';

const POINTS = 'https://tacit-points.onrender.com';
const KEEPERS = 'https://tacit-evm-pool-keepers.onrender.com';
const ETHERSCAN = 'https://etherscan.io';
// The chains a job's steps may be on: the nodes the page reads them from, the explorer that shows them, and what a wallet needs to add one.
const CHAINS = {
  1: { name: 'Ethereum', explorer: ETHERSCAN, hosts: RPCS },
  8453: { name: 'Base', explorer: 'https://basescan.org', hosts: BASE_NODES },
  4663: { name: 'Robinhood Chain', explorer: 'https://robinhoodchain.blockscout.com', hosts: ROBINHOOD_NODES },
};
// What the reader has set (Endpoints, below): nodes per chain, the rewards service and the keepers. A chain with nodes of the reader's own
// is read through them alone; the page's are the default.
const ENDS = 'tacit.tasks.endpoints.v1';
let ends = (() => { try { return JSON.parse(localStorage.getItem(ENDS)) || {}; } catch { return {}; } })();
const hostsOf = (id) => (ends.rpc?.[id]?.length ? ends.rpc[id] : CHAINS[id].hosts);
const pointsUrl = () => ends.points || POINTS;
const keepersUrl = () => ends.keepers || KEEPERS;
const chainOf = (job, s) => s.chainId ?? job.chainId;
const readOn = (id, method, params) => rpc(method, params, hostsOf(id));
// Several reads of one chain in one request: [[method, params], …] → [result, …], null for one that failed. A node that will not take a
// batch is passed over for the next; with none left the reads go one at a time.
async function batchOn(id, calls) {
  if (!calls.length) return [];
  const body = JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i + 1, method, params })));
  for (const host of hostsOf(id)) {
    try {
      const j = await (await fetch(host, { method: 'POST', headers: { 'content-type': bodyType(host) }, body, signal: AbortSignal.timeout(15e3) })).json();
      if (Array.isArray(j) && j.length === calls.length) { const out = new Array(calls.length).fill(null); for (const x of j) if (!x.error && x.id >= 1 && x.id <= calls.length) out[x.id - 1] = x.result ?? null; return out; }
    } catch { /* the next node */ }
  }
  return Promise.all(calls.map(([m, p]) => readOn(id, m, p).catch(() => null)));
}
const CHAIN_MARK = { 1: 'c-eth', 8453: 'c-base', 4663: 'c-rh' };
const mark = (id) => `<svg class="tk xs inl" role="img" aria-label="${esc(CHAINS[id].name)}"><title>${esc(CHAINS[id].name)}</title><use href="#${CHAIN_MARK[id]}"/></svg>`;
const asWallet = (id) => ({ id, name: CHAINS[id].name, rpc: hostsOf(id).slice(0, 2), explorer: CHAINS[id].explorer, icon: `${location.origin}/chain-icons/${id}.svg` });
const LATEST = '0x52bfe789';                          // the catch-up registry's latest(): the count of its newest point
// A job's steps in the groups it names (else contracts, then the confidential pool's calls), in order.
const groupOf = (s) => s.group || (s.kind === 'createx' ? 'Contracts' : 'Confidential pool');
const groupsOf = (job) => { const m = new Map(); job.steps.forEach((s, i) => { const g = groupOf(s); if (!m.has(g)) m.set(g, []); m.get(g).push([s, i]); }); return [...m]; };
// Where a step shows: its chain's mark when the job is on more than one.
const jobChains = (job) => [...new Set(job.steps.map((s) => chainOf(job, s)))];
const manyChains = (job) => jobChains(job).length > 1;
const atChain = (job, s) => (manyChains(job) ? mark(chainOf(job, s)) : '');
const steps = (n) => (n === 1 ? 'step' : 'steps');
const STORE = 'tacit.tasks.v1';
const tac = (wei, max = 2) => (wei == null ? '—' : fmtUnits(BigInt(wei), 18, max));
// A whole number of TAC, rounded to the nearest (the figures a person reads at a glance).
const tacR = (wei) => (wei == null ? '—' : fmtUnits(BigInt(wei) + 5n * 10n ** 17n, 18, 0));
const day = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

const DISCORD = 'https://discord.gg/VxYx9XSBrM';
const S = { jobs: [], folded: [], api: null, asked: false, done: {}, loaded: false, payload: {}, verdict: {}, running: null, hashes: {}, trips: {}, expanded: new Map() };

// ── what the browser remembers: the transactions this visitor sent or named, until the service has answered for each ──
const remembered = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const remember = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* private window: the page works without it */ } };
S.hashes = remembered();
// The hashes still waiting under a job: each is kept with the job it was sent or pasted for (one kept before that is shown under every job).
const pendingFor = (job) => Object.entries(S.hashes).filter(([, v]) => v.state === 'pending' && (!v.job || v.job === job.id));

// ── the notice under a job's ticket. It is kept, because the cards are drawn again whenever something they show changes. ──
let notice = { id: null, text: '', bad: false };
const say = (text, bad = false, id = S.running || firstOpen()?.id) => { notice = { id, text, bad }; paintNotice(); };
const paintNotice = () => document.querySelectorAll('.status').forEach((el) => {
  const mine = el.dataset.for === notice.id;
  el.className = `status${mine && notice.bad ? ' err' : ''}`; el.innerHTML = mine ? notice.text : '';
});
const conn = makeConnect({
  describe: 'Tasks: do a listed job from your wallet and earn TAC', say: (t, b) => say(t, b),
  busy: () => !!S.running, onChange: () => renderAll(),
});
const W = conn.W;
$('#wallet-chip').hidden = false;

// ── reading ──
const get = (url) => fetch(url, { signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
// ── a held place: where its round trip stands ──
// A closed job keeps a place for each tester who was in line (`held` in jobs.json: the account and the claim it sent, a transaction to itself naming a Bitcoin
// transaction of its round trip). Each is followed from that transaction to its burn and the pool's mint (dapp/tasks/inspect.js), so a tester sees what is left
// and nobody has to be asked. The burn reader loads only when a place is shown.
const BTC_API = 'https://api.tacit.finance', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', BTC_NODES = ['https://blockstream.info/api', 'https://mempool.space/api'];
// An explorer's answer: { data }, null when every explorer says there is no such transaction, and a throw when they could not be read.
async function esplora(path, text = false) {
  let missing = 0;
  for (const base of BTC_NODES) {
    try { const r = await fetch(base + path, { signal: AbortSignal.timeout(12e3) }); if (r.ok) return { data: text ? (await r.text()).trim() : await r.json() }; if (r.status === 404) missing++; } catch { /* the next explorer */ }
  }
  if (missing === BTC_NODES.length) return null;
  throw new Error('explorers');
}
let burnKit = null;
const readKit = () => (burnKit ||= Promise.all([import('/burn-deposit-bitcoin.js?cb=5a017049'), import('/confidential-crosslane-guard.js?cb=1f92a331')]));
const tripDeps = {
  look: async (txid) => {
    const j = await esplora(`/tx/${txid}`);
    if (!j) return null;
    const { classifyConfidentialTx } = (await readKit())[0], hex = (await esplora(`/tx/${txid}/hex`, true))?.data;
    let c = null;
    try { c = hex ? classifyConfidentialTx(`0x${hex}`) : null; } catch { /* not a bridge transaction */ }
    const st = j.data.status || {};
    return { confirmed: !!st.confirmed, height: st.block_height ?? null, time: st.block_time ?? null, kind: c?.type === 'burn' ? 'burn' : c?.type === 'crossout_mint' ? 'crossout_mint' : 'other', assetId: c?.assetId, nullifier: c?.nullifier };
  },
  outspends: async (txid) => (await esplora(`/tx/${txid}/outspends`))?.data ?? null,
  minted: async (nullifier) => {
    if (!nullifier) return null;
    const { makeCrossLaneGuard } = (await readKit())[1];
    return makeCrossLaneGuard({ keccak256: keccak_256 }).evmNullifierSpent((a, slot, tag) => readOn(1, 'eth_getStorageAt', [a, slot, tag || 'latest']), POOL, nullifier);
  },
  attested: async () => (await get(`${BTC_API}/reflection/status?network=mainnet`))?.attestedHeight ?? null,
};
const heldOf = (job) => job.steps.filter((s) => s.held);
function ensureTrips(job) {
  for (const s of heldOf(job)) {
    const cur = S.trips[s.id];
    if (claimsOf(job).some((c) => c.step === s.id) || (cur && (cur.state === 'loading' || cur.state === 'complete' || Date.now() - cur.at < (cur.state === 'unreachable' ? 30e3 : 300e3)))) continue;
    if (!cur) S.trips[s.id] = { state: 'loading', at: Date.now() };
    else S.trips[s.id] = { ...cur, at: Date.now() };
    (async () => {
      let r;
      try {
        const tx = await readOn(1, 'eth_getTransactionByHash', [s.held.claim]);
        r = /^0x[0-9a-f]{64}$/i.test(tx?.input || '') ? await trace(tx.input.slice(2), tripDeps) : { state: 'unreachable', text: 'Could not read the claim just now.' };
      } catch { r = { state: 'unreachable', text: 'Could not read the claim just now.' }; }
      S.trips[s.id] = { ...r, at: Date.now() };
      renderAll();
    })();
  }
}
// What a held role says in the list: whose it is and where its round trip stands.
const tripLine = (s) => {
  const r = S.trips[s.id], who = `Held for ${addrView(s.held.address, 4)}`;
  if (!r || r.state === 'loading') return `${who} · reading where it stands…`;
  return `${who} · ${esc(guide(r)[0])}${r.eta ? `, the pool mints it back around ${hhmm(r.eta)} UTC` : ''}`;
};
// The card a closed job shows in place of the claim form: for the account that holds a place, where it stands and what is next; for others, that the places are held.
function heldPanel(job) {
  const mine = heldOf(job).find((s) => W.account && s.held.address.toLowerCase() === W.account.toLowerCase());
  const shell = (body) => `<section class="panel p-mine p-claim" aria-label="Your place"><p class="eyebrow">Your place</p>${body}</section>`;
  if (!mine) return shell(`<p class="note">${W.account ? 'This job is closed. Its places are held for the testers who were in line.' : 'This job is closed. Its places are held for the testers who were in line: connect the wallet you claimed from to see yours.'}</p>${W.account ? '' : '<button class="btn ghost" type="button" data-connect>Connect wallet</button>'}`);
  const r = S.trips[mine.id];
  if (!r || r.state === 'loading') return shell('<p class="note">Reading where your round trip stands…</p>');
  const [head] = guide(r);
  return shell(`<p class="hl"><b>${esc(head)}</b></p>
    <p class="note">${esc(r.text)}${r.eta ? ` It should land around ${hhmm(r.eta)} UTC.` : ''}</p>
    <div class="acts">${r.state === 'on-bitcoin' ? '<a class="btn" href="/#usdt/bitcoin/back" target="_blank" rel="noopener noreferrer">Bring it back ↗</a>' : ''}${r.burn ? link(`https://mempool.space/tx/${r.burn}`, 'Your burn on Bitcoin ↗') : ''}</div>
    <p class="note">Your claim is in: ${link(`${ETHERSCAN}/tx/${mine.held.claim}`, 'its transaction ↗')}. There is nothing to send: you are credited once the pool has minted your USDT back.</p>`);
}

const flagged = (r) => String(r).slice(2, 66) === `${'0'.repeat(63)}1`;

// A step seen on the chain stays there (a contract is not taken away, a registry's count and a flag only rise), so the steps this browser has seen done are
// kept and not asked again: the code of the larger contracts is most of what the page downloads (a job's chunks are 1 MB of code to learn that they exist). Only
// the page's own nodes count: a reader who names nodes of their own may be looking at another chain.
const SEEN = 'tacit.tasks.seen.v1';
const seenDone = (() => { try { return new Set(JSON.parse(localStorage.getItem(SEEN)) || []); } catch { return new Set(); } })();
const stepKey = (job, s) => [job.id, s.id, chainOf(job, s), s.expected || s.to, s.minSize || s.asset || s.poolId || ''].join(':');
const ownNodes = (id) => !!ends.rpc?.[id]?.length;
function keepSeen(job, out) {
  let more = false;
  for (const s of job.steps) if (out[s.id] === true && !ownNodes(chainOf(job, s)) && !seenDone.has(stepKey(job, s))) { seenDone.add(stepKey(job, s)); more = true; }
  if (more) { try { localStorage.setItem(SEEN, JSON.stringify([...seenDone])); } catch { /* the page works without it */ } }
}

// The service's answer is waited for a moment before the chain is read, so that the steps it has claimed need no read at all.
let apiFirst = null;
const apiSettled = () => (apiFirst ? Promise.race([apiFirst, new Promise((r) => setTimeout(() => { S.apiLate = true; r(); }, 4e3))]) : Promise.resolve());

// Whether each step is already on the chain: code at a deployment's address, the registry's newest point, the asset or the pool in the
// confidential pool's registry. One request per chain; a step that has been seen on the chain, or that the service has claimed, is not
// asked about (a send passes `chain` and asks the chain about everything not seen on it).
async function readDone(job, { chain = false } = {}) {
  if (!chain) await apiSettled();
  const out = {}, prev = S.done[job.id] || {}, asks = new Map(), aj = chain ? null : apiJob(job);
  const ask = (id, s, method, params, yes) => { if (!asks.has(id)) asks.set(id, []); asks.get(id).push({ s, method, params, yes }); };
  for (const s of job.steps) {
    const id = chainOf(job, s);
    if (prev[s.id] === true || (!ownNodes(id) && seenDone.has(stepKey(job, s)))) { out[s.id] = true; continue; }
    if (aj && !ownNodes(id) && aj.steps.find((x) => x.id === s.id)?.claim) { out[s.id] = true; continue; }
    if (s.kind === 'review') { out[s.id] = !!apiJob(job)?.steps.find((x) => x.id === s.id)?.claim; continue; }
    if (s.kind === 'createx') ask(id, s, 'eth_getCode', [s.expected, 'latest'], (r) => r !== '0x');
    else if (s.kind === 'post') ask(id, s, 'eth_call', [{ to: s.to, data: LATEST }, 'latest'], (r) => r !== '0x' && BigInt(r) >= BigInt(s.minSize));
    else if (s.kind === 'register') ask(id, s, 'eth_call', [{ to: s.to, data: `0x9fda5b66${s.asset.slice(2)}` }, 'latest'], flagged);
    else ask(id, s, 'eth_call', [{ to: s.to, data: `0xb5217bb4${s.poolId.slice(2)}` }, 'latest'], flagged);
  }
  await Promise.all([...asks].map(async ([id, rows]) => {
    const got = await batchOn(id, rows.map((r) => [r.method, r.params]));
    rows.forEach((r, i) => { try { out[r.s.id] = got[i] == null ? null : !!r.yes(got[i]); } catch { out[r.s.id] = null; } });
  }));
  keepSeen(job, out);
  return out;
}
async function loadApi() {
  S.api = await get(`${pointsUrl()}/tasks`);
  S.asked = true;
  renderAll();
}
async function refresh() {
  const fresh = await Promise.all(S.jobs.filter((j) => S.running !== j.id).map(async (j) => [j.id, await readDone(j)]));
  for (const [id, d] of fresh) S.done[id] = d;
  S.loaded = true;
  renderAll();
}

const apiJob = (job) => (S.api?.enabled ? S.api.jobs?.find((j) => j.id === job.id) : null);
// Over: the day it was open until has passed, or its budget is spent (the service refuses a claim then, and parks one over the budget for good).
const programEnded = () => {
  const a = S.api;
  if (!a?.enabled) return false;
  if (a.endSec && Date.now() / 1000 >= a.endSec) return true;
  try { return a.budget?.remainingWei != null && BigInt(a.budget.remainingWei) <= 0n; } catch { return false; }
};
const isOpen = (job) => !!(S.api?.enabled && job.opensAt && Date.now() / 1000 >= job.opensAt && !programEnded());
const onChain = (job, s) => S.done[job.id]?.[s.id];
const doneCount = (job) => job.steps.filter((s) => onChain(job, s)).length;
// a job the owner has finished (`done: true`) reads as done even while a reviewed claim is still to be sent
const isDone = (job) => job.done === true || doneCount(job) === job.steps.length;
const stateOf = (job) => (isDone(job) ? 'done' : !S.api ? 'offline' : programEnded() ? 'closed' : !isOpen(job) ? 'soon' : 'open');
const PILL = { done: ['Done', 'ok'], open: ['Open', 'ok'], soon: ['Opens soon', 'mute'], closed: ['Closed', 'mute'], offline: ['Rewards offline', 'mute'] };
const firstOpen = () => S.jobs.find((j) => stateOf(j) !== 'done');
// Open jobs show in full; a job that is done shows its tile and opens when clicked (what the visitor chose stays as chosen).
const isExpanded = (job) => (S.expanded.has(job.id) ? S.expanded.get(job.id) : stateOf(job) !== 'done');

// The service's claims for a job, with those of the jobs folded into it (`into` in jobs.json: listed under the job they belong to).
const claimsOf = (job) => (S.api?.claims ?? []).filter((c) => c.job === job.id || S.folded.some((f) => f.id === c.job && f.into === job.id));

// What a job has paid so far, from the service's claims: the TAC, who got it, and when the steps landed.
function resultOf(job) {
  const mine = claimsOf(job);
  const times = mine.map((c) => c.blockTime).sort((a, b) => a - b);
  return {
    total: mine.reduce((x, c) => x + BigInt(c.wei), 0n), count: mine.length,
    senders: [...new Set(mine.map((c) => c.address))], first: times[0], last: times.at(-1),
  };
}

// What a job pays now, from the gas of its steps at the service's latest slow-mode gas price and TAC price: the gas, with the tip, held to the job's floor and cap.
function economics(job) {
  const q = S.api?.quote, t = S.api?.terms;
  if (!S.api?.enabled || !q?.fresh || !q.tacPerEthWei || !t || job.steps.some((s) => s.minWei != null)) return null;
  const gas = job.steps.reduce((n, s) => n + BigInt(s.gas), 0n);
  const eth = gas * BigInt(q.gasPriceWei), plain = (eth * BigInt(q.tacPerEthWei)) / 10n ** 18n;
  const tipped = (plain * (10000n + BigInt(t.tipBps))) / 10000n, floor = BigInt(t.floorWei), cap = BigInt(t.capWei);
  const pays = tipped < floor ? floor : tipped > cap ? cap : tipped;
  return { gas, eth, plain, tipped, floor, cap, pays, by: tipped < floor ? 'floor' : tipped > cap ? 'cap' : 'gas' };
}

// ── drawing ──
// The cards are drawn again whenever something they show changes: what is typed in their forms, the chain chosen for a pasted hash and
// the field being typed in, with its caret, are carried over to the new ones.
const FIELDS = '.paste textarea, .paste select, .review textarea';
function renderAll() {
  renderStats();
  const fields = [...document.querySelectorAll(FIELDS)], typed = Object.fromEntries(fields.map((t) => [t.dataset.for, t.value]));
  const at = fields.find((t) => t === document.activeElement), caret = at ? { key: at.dataset.for, start: at.selectionStart, end: at.selectionEnd } : null;
  renderJobs();
  for (const t of document.querySelectorAll(FIELDS)) {
    if (typed[t.dataset.for]) t.value = typed[t.dataset.for];
    if (caret && t.dataset.for === caret.key) { t.focus({ preventScroll: true }); if (t.setSelectionRange && caret.start != null) t.setSelectionRange(caret.start, caret.end); }
  }
  paintNotice();
}

function renderStats() {
  const a = S.api, el = $('#stats');
  if (!S.asked || !S.loaded) return;                                  // the row keeps its place until the service and the chain have answered
  el.classList.remove('loading'); el.removeAttribute('aria-hidden');
  if (!a?.enabled) { el.hidden = true; return; }
  const done = S.jobs.filter(isDone).length;
  el.hidden = false;
  el.innerHTML = `
    <div><b class="num">${tac(a.budget.creditedWei)}</b><span>TAC paid so far</span></div>
    <div><b class="num">${tacR(a.budget.remainingWei)}</b><span>TAC left in the budget</span></div>
    <div><b class="num">${done} of ${S.jobs.length}</b><span>${S.jobs.length === 1 ? 'job' : 'jobs'} done</span></div>`;
}

function renderJobs() {
  const root = $('#jobs');
  if (!S.jobs.length) return;
  if (!S.loaded || !(S.asked || S.apiLate)) { root.innerHTML = '<p class="none">Reading the chain…</p>'; return; }
  $('#jobs').classList.remove('loading');
  const open = S.jobs.filter((j) => stateOf(j) !== 'done'), done = S.jobs.filter(isDone).sort((a, b) => (b.opensAt || 0) - (a.opensAt || 0));
  root.innerHTML = `
    <h2 class="sec-h">Open jobs <span class="num">${open.length}</span></h2>
    ${open.length ? open.map(card).join('') : '<p class="none">No open jobs right now. The next one will show up here.</p>'}
    ${done.length ? `<h2 class="sec-h">Done <span class="num">${done.length}</span></h2><div class="done-grid">${done.map(card).join('')}</div>` : ''}`;
  root.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = () => {
      const job = S.jobs.find((j) => j.id === b.dataset.toggle);
      S.expanded.set(job.id, !isExpanded(job));
      history.replaceState(null, '', S.expanded.get(job.id) ? `#${job.id}` : location.pathname);
      renderAll();
    };
  });
  root.querySelectorAll('[data-connect]').forEach((b) => { b.onclick = () => conn.connect(); });
  for (const job of S.jobs) if (isExpanded(job) && heldOf(job).length) ensureTrips(job);
  root.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(S.jobs.find((j) => j.id === b.dataset.go)); });
  root.querySelectorAll('[data-one]').forEach((b) => { b.onclick = () => go(S.jobs.find((j) => j.id === b.dataset.job), b.dataset.one); });
  root.querySelectorAll('[data-verify]').forEach((b) => { b.onclick = () => verify(S.jobs.find((j) => j.id === b.dataset.verify), true); });
  root.querySelectorAll('.paste').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); paste(f); }; });
  root.querySelectorAll('.review').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); sendReview(f); }; });
  gasNote();
}

function card(job) {
  const st = stateOf(job), exp = isExpanded(job), [label, cls] = PILL[st];
  const n = doneCount(job), total = job.steps.length, eco = economics(job), res = resultOf(job);
  const own = job.steps.filter((s) => chainOf(job, s) === job.chainId);
  const reviewed = job.steps.every((s) => s.kind === 'review');
  let fig = '—', cap = 'shown when rewards open', foot = reviewed ? '' : `${(own.reduce((x, s) => x + s.gas, 0) / 1e6).toFixed(1)}M gas${manyChains(job) ? ` ${mark(job.chainId)}` : ''}`;
  if (st === 'done') {
    fig = res.count ? `${tacR(res.total)}<small>TAC</small>` : '—';
    const waiting = pendingFor(job).length;
    cap = res.count ? `paid to ${res.senders.map((a) => short(a)).join(', ')}` : waiting ? 'waiting for twelve confirmations' : S.api?.enabled && job.opensAt && Date.now() / 1000 >= job.opensAt ? 'no reward claimed yet' : 'deployed outside the rewards';
    foot = res.last ? `Done ${day(res.last)}` : 'Done';
  } else if (reviewed) {
    fig = `${tac(job.steps.reduce((x, s) => x + BigInt(s.minWei), 0n), 0)}<small>TAC</small>`;
    const pays = job.steps.map((s) => BigInt(s.minWei)), least = pays.reduce((x, y) => (y < x ? y : x)), most = pays.reduce((x, y) => (y > x ? y : x));
    cap = least === most ? `${tac(least, 0)} TAC for each role, paid once` : `${tac(least, 0)} to ${tac(most, 0)} TAC a role, paid once`;
  } else if (eco || apiJob(job)?.estimateWei != null) { fig = `≈ ${tacR(eco ? eco.pays : apiJob(job).estimateWei)}<small>TAC</small>`; cap = 'for the whole job, at today’s network fees'; }
  const where = reviewed ? 'roles claimed' : `${steps(total)} on the chain`;
  return `<article class="job ${st}${exp ? ' is-open' : ''}" id="${esc(job.id)}">
    <button class="job-head" type="button" data-toggle="${esc(job.id)}" aria-expanded="${exp}" aria-controls="body-${esc(job.id)}">
      <span class="job-top"><b>${esc(job.title)}</b><span class="pill ${cls}">${label}</span></span>
      <span class="job-sub">${esc(job.tagline)}${manyChains(job) ? ` ${jobChains(job).map(mark).join('')}` : ''}</span>
      <span class="job-fig"><span class="big num">${fig}</span><span class="cap">${cap}</span></span>
      ${st === 'done' ? '' : `<span class="bar" role="img" aria-label="${n} of ${total} ${where}"><i style="width:${(100 * n) / total}%"></i></span>`}
      <span class="job-foot"><span>${n} of ${total} ${where}</span><span>${foot}</span></span>
    </button>
    <div class="job-body" id="body-${esc(job.id)}"${exp ? '' : ' hidden'}>${exp ? (st === 'done' ? doneBody(job, res) : openBody(job)) : ''}</div>
  </article>`;
}

// ── a job that is done: what it was and what it made ──
const about = (job) => `<div class="abouts">${job.about.map((x) => `<div class="sec"><h3>${esc(x.h)}</h3><p>${esc(x.p)}</p></div>`).join('')}</div>`;
const links = (job) => `<div class="links">${job.links.map((l) => link(l.href, `${esc(l.label)} ↗`)).join('')}</div>`;

// Where a contract's source can be read: verified on Etherscan and on Sourcify.
const verifiedOn = (addr) => ` · source on ${link(`${ETHERSCAN}/address/${addr}#code`, 'Etherscan ↗')} ${link(`https://repo.sourcify.dev/1/${addr}`, 'Sourcify ↗')}`;

function doneRow(job, s, i) {
  const cs = claimsOf(job).filter((c) => c.step === s.id);
  const id = chainOf(job, s), ex = CHAINS[id].explorer;
  const held = s.held && !cs.length;
  const where = held ? tripLine(s) : s.kind === 'createx' ? link(`${ex}/address/${s.expected}`, esc(s.expected)) : s.kind === 'post' ? `A point posted to ${link(`${ex}/address/${s.to}`, 'the registry')}` : s.kind === 'review' ? 'Reviewed on both chains' : 'Call to the confidential pool';
  const proof = s.kind === 'createx' && job.verified && id === 1 ? verifiedOn(s.expected) : '';
  return `<li class="step is-done">
    <span class="n num">${i + 1}</span>
    <span class="what"><b>${esc(s.label)}</b><small>${atChain(job, s)}${where}${proof}${cs.map((c) => ` · ${link(`${ex}/tx/${c.txHash}`, 'transaction ↗')}`).join('')}</small></span>
    <span class="paid num">${cs.length ? `${tac(cs.reduce((x, c) => x + BigInt(c.wei), 0n))} TAC` : held ? 'In line' : '—'}</span>
  </li>`;
}

function doneBody(job, res) {
  const by = res.senders.length ? res.senders.map((a) => link(`${ETHERSCAN}/address/${a}`, addrFlat(a, 6))).join(', ') : '—';
  const span = res.first ? (day(res.first) === day(res.last) ? `${day(res.first)}, ${hhmm(res.first)} to ${hhmm(res.last)} UTC` : `${day(res.first)} to ${day(res.last)}`) : '—';
  return `
    <div class="status" role="status" data-for="${esc(job.id)}"></div>
    <div class="result">
      <div class="kv"><span>Sent by</span><b>${by}</b></div>
      <div class="kv"><span>When</span><b>${span}</b></div>
      <div class="kv"><span>Paid</span><b class="num">${res.count ? `${tac(res.total)} TAC` : '—'}</b></div>
    </div>
    ${heldOf(job).length ? heldPanel(job) : job.steps.some((s) => s.kind === 'review' && !onChain(job, s)) ? claimPanel(job, job.steps.filter((s) => s.kind === 'review' && !onChain(job, s)), isOpen(job), false) : ''}
    ${about(job)}
    ${links(job)}
    ${groupsOf(job).filter(([g]) => g !== 'Confidential pool').map(([g, rows]) => `<p class="grp-h"><span>${esc(g)}</span><span>${rows.length}</span></p>
    <ol class="steps">${rows.map(([s, i]) => doneRow(job, s, i)).join('')}</ol>`).join('')}
    ${job.created?.length ? `<p class="grp-h"><span>Made by the vaults</span><span>${job.created.length}</span></p>
    <ul class="steps">${job.created.map((x) => `<li class="step is-done"><span class="n"></span><span class="what"><b>${esc(x.label)}</b><small>${link(`${ETHERSCAN}/address/${x.address}`, esc(x.address))}${job.verified ? verifiedOn(x.address) : ''}</small></span><span class="paid"></span></li>`).join('')}</ul>` : ''}
    ${groupsOf(job).filter(([g]) => g === 'Confidential pool').map(([g, rows]) => `<p class="grp-h"><span>${esc(g)}</span><span>${rows.length}</span></p>
    <ol class="steps">${rows.map(([s, i]) => doneRow(job, s, i)).join('')}</ol>`).join('')}`;
}

// ── a job that is open (or about to be): the whole page of it ──
const chipFor = (c, done) => (c ? (c.state === 'credited' ? ['credited', 'Credited'] : ['claimed', 'Claimed']) : done ? ['deployed', 'On the chain'] : done === null ? ['unknown', 'Unknown'] : ['open', 'Open']);
function stepRow(job, s, i) {
  const aj = apiJob(job)?.steps.find((x) => x.id === s.id);
  const done = onChain(job, s), c = aj?.claim;
  const [cls, label] = chipFor(c, done);
  const est = !done && aj?.estimateWei != null ? ` · ≈ ${tac(aj.estimateWei)} TAC` : '';
  const bad = S.verdict[job.id]?.problems.find((p) => p.step === s.id);
  const ex = CHAINS[chainOf(job, s)].explorer;
  const addr = s.kind === 'createx' ? link(`${ex}/address/${s.expected}`, esc(s.expected)) : s.kind === 'post' ? `A point posted to ${link(`${ex}/address/${s.to}`, 'the registry')}` : 'Call to the confidential pool';
  return `<li class="step${done ? ' is-done' : ''}">
    <span class="n num">${i + 1}</span>
    <span class="what"><b>${esc(s.label)}</b><small>${atChain(job, s)}${addr}${bad ? ` <span class="err">· ${esc(bad.bad.join('; '))}</span>` : ''}</small></span>
    <span class="chip-s ${cls}">${label}${est}</span>
    ${!done && !c && isOpen(job) && S.api && S.running !== job.id ? `<button class="linkbtn one" type="button" data-job="${esc(job.id)}" data-one="${esc(s.id)}">Send this step</button>` : ''}
    ${c ? `<span class="by">${c.state === 'credited' ? 'Credited' : 'Claimed'} to ${link(`${ETHERSCAN}/address/${c.address}`, addrFlat(c.address, 4))} · ${tac(c.wei)} TAC</span>` : ''}
  </li>`;
}

function rewardsPanel(job) {
  const a = S.api, eco = economics(job);
  const how = `<ol class="how">
    <li><span><b>Send.</b> The page checks each transaction against the plan, then your wallet signs it.</span></li>
    <li><span><b>Twelve blocks later,</b> the rewards service reads the step from the chain and sets its reward.</span></li>
    <li><span><b>Get paid.</b> The reward is credited to the account that sent the step. Claim it with the daily rewards on the ${link('/rewards/', 'rewards page')}.</span></li>
  </ol>`;
  if (!a) return `<p class="eyebrow">Rewards</p>${how}<p class="note">The rewards service did not answer. The steps can still be read; try again in a moment.</p>`;
  if (!a.enabled) return `<p class="eyebrow">Rewards</p>${how}<p class="note">Rewards are not switched on yet, so a step sent now will not be paid.</p>`;
  const left = BigInt(a.budget.remainingWei);
  const est = apiJob(job)?.estimateWei, perStep = job.steps.some((s) => s.minWei != null);
  return `<p class="eyebrow"><span>Rewards</span><span class="who">${a.quote?.fresh ? 'live' : 'price not fresh'}</span></p>
    <p class="sum num">${eco ? `≈ ${tacR(eco.pays)}<small>TAC for the job</small>` : est != null ? `≈ ${tacR(est)}<small>TAC for the job</small>` : '—'}</p>
    ${perStep ? `<div class="eq">${groupsOf(job).map(([g, rows]) => { const lo = rows.reduce((x, [s]) => x + BigInt(s.minWei ?? 0), 0n) / BigInt(rows.length); return `<div class="l"><span>${esc(g)}</span><b class="num">at least ${tac(lo, 0)} TAC a step</b></div>`; }).join('')}</div>` : ''}
    ${eco ? `<div class="eq">
      <div class="l"><span>Network fees for the whole job</span><b class="num">${(Number(eco.eth) / 1e18).toFixed(4)} ETH ≈ ${tac(eco.plain)} TAC</b></div>
      <div class="l"><span>With the ${Number(a.terms.tipBps) / 100}% tip</span><b class="num">${tac(eco.tipped)} TAC</b></div>
      <div class="l"><span>Floor · cap for the job</span><b class="num">${tac(eco.floor, 0)} · ${tac(eco.cap, 0)} TAC</b></div>
      <div class="l tot"><span>${eco.by === 'floor' ? 'Pays the floor' : eco.by === 'cap' ? 'Pays the cap' : 'Pays'}</span><b class="num">${tac(eco.pays)} TAC</b></div>
    </div>` : ''}
    <p class="note">${perStep ? 'Each step pays its own network fee, on its own chain, with the tip, and never less than its minimum: a chain where fees cost next to nothing still takes the time of whoever sends the step. ' : ''}Network fees are priced at a slow-mode rate, in TAC at the ${a.quote ? esc(a.quote.venue) : 'deepest'} venue’s price${a.quote?.tacPerEthWei ? ` (${tac(a.quote.tacPerEthWei, 0)} TAC per ETH)` : ''}. Each step takes its share by the gas it uses.</p>
    ${how}
    <div class="rows"><div class="kv"><span>Budget left</span><b class="num">${tac(left, 0)} of ${tac(a.budget.totalWei, 0)} TAC</b></div><div class="kv"><span>Open until</span><b>${esc(day(a.endSec))}</b></div></div>`;
}

// A job read by hand: each step names its Bitcoin transaction from the account to be paid, and pays a fixed sum once it has been reviewed.
function reviewRow(job, s, i) {
  const c = apiJob(job)?.steps.find((x) => x.id === s.id)?.claim;
  return `<li class="step${c ? ' is-done' : ''}">
    <span class="n num">${i + 1}</span>
    <span class="what"><b>${esc(s.label)}</b><small>${esc(s.detail)}</small></span>
    <span class="chip-s ${c ? (c.state === 'credited' ? 'credited' : 'claimed') : 'open'}">${c ? (c.state === 'credited' ? 'Credited' : 'Claimed') : `${tac(s.minWei, 0)} TAC`}</span>
    ${c ? `<span class="by">${c.state === 'credited' ? 'Credited' : 'Claimed'} to ${link(`${ETHERSCAN}/address/${c.address}`, addrFlat(c.address, 4))} · ${tac(c.wei)} TAC</span>` : ''}
  </li>`;
}
// The claim forms of the steps a reviewed job has left: each names the Bitcoin transaction of a bridge and is paid to the wallet that claims.
// `status` is false where the page already has this job's status line.
// The claim names only the Bitcoin transaction (the role is read from it), so the roles that ask the same question share one form.
const claimPanel = (job, todo, open, status = true) => `<section class="panel p-mine p-claim" aria-label="Claim">
          <p class="eyebrow">Claim</p>
          ${todo.filter((s, i) => todo.findIndex((x) => x.ask === s.ask) === i).map((s) => `<form class="review" autocomplete="off" data-job="${esc(job.id)}" data-step="${esc(s.id)}">
            <label class="lbl"><span>${esc(s.ask)}</span>
              <textarea rows="2" spellcheck="false" data-for="${esc(`${job.id}/${s.id}`)}" placeholder="Bitcoin transaction id"></textarea></label>
            <button class="btn ghost" type="submit" ${open && S.running !== job.id ? '' : 'disabled'}>${S.running === job.id ? 'Sending…' : W.account ? 'Claim' : 'Connect wallet'}</button>
          </form>`).join('')}
          ${status ? `<div class="status" role="status" data-for="${esc(job.id)}"></div>` : ''}
        </section>`;
function reviewBody(job) {
  // `reserved` steps (taken by a bridge already checked) keep their claim form for its owner but are not offered to others as work to do
  const todo = job.steps.filter((s) => !onChain(job, s)), doit = todo.filter((s) => !s.reserved), open = isOpen(job), a = S.api;
  return `
    <div class="grid">
      <div class="col">
        <section class="panel p-about" aria-label="About the job">
          <p class="eyebrow">About</p>
          ${about(job)}
          ${links(job)}
        </section>
        <section class="panel p-steps" aria-label="Steps">
          <p class="eyebrow">Roles</p>
          <ol class="steps">${job.steps.map((s, i) => reviewRow(job, s, i)).join('')}</ol>
        </section>
      </div>
      <div class="col">
        ${doit.length ? `<section class="panel p-ticket" aria-label="Do it">
          <p class="eyebrow">Do it</p>
          <div class="acts">${doit.filter((s, i) => doit.findIndex((x) => x.action.href === s.action.href && x.action.label === s.action.label) === i).map((s) => `<a class="btn" href="${esc(s.action.href)}" target="_blank" rel="noopener noreferrer">${esc(s.action.label)} ↗</a>`).join('')}</div>
          <p class="hint">${esc(job.hint || 'Opens the fast bridge. Come back here to claim when the bridge is done.')}</p>
        </section>` : ''}
        ${claimPanel(job, todo, open)}
        ${a?.enabled ? `<section class="panel p-rewards" aria-label="Rewards"><p class="eyebrow">Rewards</p>
          <div class="rows"><div class="kv"><span>Budget left</span><b class="num${BigInt(a.budget.remainingWei) < todo.reduce((x, s) => x + BigInt(s.minWei ?? 0), 0n) ? ' warn' : ''}">${tac(BigInt(a.budget.remainingWei), 0)} of ${tac(a.budget.totalWei, 0)} TAC</b></div><div class="kv"><span>Open until</span><b>${esc(day(a.endSec))}</b></div></div></section>` : ''}
      </div>
    </div>`;
}

function openBody(job) {
  if (job.steps.every((s) => s.kind === 'review')) return reviewBody(job);
  const todo = job.steps.filter((s) => !onChain(job, s));
  const aj = apiJob(job), open = isOpen(job), n = doneCount(job), eco = economics(job);
  const gas = todo.filter((s) => chainOf(job, s) === job.chainId).reduce((x, s) => x + s.gas, 0);
  const verdict = S.verdict[job.id], busy = S.running === job.id;
  // What the steps left pay now: the job's own figure when none is done, else the sum of the steps' estimates (none shown when one is missing).
  const est = todo.map((s) => aj?.steps.find((y) => y.id === s.id)?.estimateWei);
  const payNow = !open || !aj || !todo.length ? null : todo.length === job.steps.length && eco ? eco.pays : est.every((e) => e != null) ? est.reduce((x, e) => x + BigInt(e), 0n) : null;
  const hint = !S.api ? 'The rewards service did not answer, so sending is paused: a step sent now might not be paid.'
    : programEnded() ? 'Rewards for these jobs are over, so a step sent now would not be paid.'
    : !open ? 'Rewards for this job are not open yet. Sending opens with them.'
    : todo.length ? 'Each step is paid to the account that sends it: send all or some, and leave the rest to others. Pick a slower speed in your wallet to keep your network fee below what a step pays.' : 'Everything in this job is on the chain.';
  return `
    <div class="grid">
      <div class="col">
        <section class="panel p-about" aria-label="About the job">
          <p class="eyebrow">About</p>
          ${about(job)}
          ${links(job)}
        </section>
        <section class="panel p-steps" aria-label="Steps">
          <p class="eyebrow"><span>Steps, in order</span><span class="who">${n} of ${job.steps.length} on the chain</span></p>
          ${groupsOf(job).map(([g, rows]) => `<p class="grp-h"><span>${esc(g)}</span><span>${rows.filter(([s]) => onChain(job, s)).length} of ${rows.length}</span></p>
          <ol class="steps">${rows.map(([s, i]) => stepRow(job, s, i)).join('')}</ol>`).join('')}
          <p class="note">${verdict ? (verdict.ok ? '<span class="ok">Checked in your browser: every transaction matches the plan, with the same code, salt, settings and address the job names.</span>' : '<span class="err">A transaction does not match the plan; nothing will be sent.</span>') : 'Before anything is sent, this page checks each transaction against the plan in your browser.'} <button class="linkbtn" type="button" data-verify="${esc(job.id)}">Check now</button> · ${link(job.payloadUrl, 'The transactions (JSON) ↗')}</p>
        </section>
      </div>
      <div class="col">
        <section class="panel p-ticket" aria-label="Do it">
          <p class="eyebrow">Do it</p>
          <div class="rows flat">
            <div class="kv"><span>Steps left</span><b class="num">${todo.length} of ${job.steps.length}</b></div>
            <div class="kv"><span>Gas${manyChains(job) ? ` ${mark(job.chainId)}` : ' for them'}</span><b class="num">${(gas / 1e6).toFixed(1)}M<small class="gasnote"></small></b></div>
            <div class="kv"><span>Pays, about</span><b class="num">${payNow != null ? `${tacR(payNow)} TAC` : '—'}</b></div>
          </div>
          <p class="hint">${hint}</p>
          <button class="btn" type="button" data-go="${esc(job.id)}" ${!todo.length || !open || busy ? 'disabled' : ''}>${busy ? 'Sending…' : !W.account ? 'Connect wallet' : todo.length ? (todo.length === 1 ? `Send the ${job.steps.length === 1 ? '' : 'remaining '}step` : `Send ${todo.length === job.steps.length ? 'all' : 'the remaining'} ${todo.length} steps`) : 'Done'}</button>
          <div class="status" role="status" data-for="${esc(job.id)}"></div>
        </section>
        <section class="panel p-rewards" aria-label="Rewards">${rewardsPanel(job)}</section>
        <section class="panel p-mine" aria-label="Your steps">
          <p class="eyebrow">Your steps</p>
          ${mineList(job)}
          <form class="paste" autocomplete="off" data-for="${esc(job.id)}">
            <label class="lbl"><span>Sent a step yourself? Paste its transaction hash</span>
              <textarea rows="2" spellcheck="false" data-for="${esc(job.id)}" placeholder="0x… (one or more transaction hashes)"></textarea></label>
            ${manyChains(job) ? `<label class="lbl"><span>On which chain</span><select data-for="${esc(job.id)}:chain">${[...new Set(job.steps.map((s) => chainOf(job, s)))].map((id) => `<option value="${id}">${esc(CHAINS[id].name)}</option>`).join('')}</select></label>` : ''}
            <button class="btn ghost" type="submit">Claim</button>
          </form>
        </section>
      </div>
    </div>`;
}

function mineList(job) {
  const mine = (S.api?.claims ?? []).filter((c) => c.job === job.id && W.account && c.address.toLowerCase() === W.account.toLowerCase());
  const waiting = pendingFor(job);
  if (!mine.length && !waiting.length) return `<p class="empty">${W.account ? 'None yet.' : 'Connect a wallet to see the steps credited to it.'}</p>`;
  const label = (id) => job.steps.find((s) => s.id === id)?.label ?? id;
  const total = mine.reduce((x, c) => x + BigInt(c.wei), 0n);
  return `<ul class="mine">${mine.map((c) => `<li><span>${esc(label(c.step))}</span><span class="num">${tac(c.wei)} TAC · ${c.state === 'credited' ? 'credited' : 'waiting for the budget'}</span></li>`).join('')}${waiting.map(([h, v]) => `<li>${link(`${ETHERSCAN}/tx/${h}`, esc(short(h, 6)))}<span>${esc(v.note || 'waiting for confirmations')}</span></li>`).join('')}</ul>${mine.length ? `<div class="rows"><div class="kv"><span>Yours so far</span><b class="num">${tac(total)} TAC</b></div></div>` : ''}`;
}

function paste(form) {
  const area = form.querySelector('textarea');
  const found = [...new Set(area.value.match(/0x[0-9a-fA-F]{64}/g) || [])];
  if (!found.length) { say('No transaction hash found there.', true, form.dataset.for); return; }
  const chainId = Number(form.querySelector('select')?.value || 1);
  found.forEach((h) => track(h, chainId, form.dataset.for));
  area.value = '';
  say(`Checking ${found.length} transaction${found.length > 1 ? 's' : ''} with the rewards service…`, false, form.dataset.for);
  settle();
}

// the gas price is read again after a minute: the cards are drawn far more often than it moves
let gasAt = 0, gasPrice = 0n;
async function gasNote() {
  const els = document.querySelectorAll('.gasnote');
  if (!els.length) return;
  try {
    if (Date.now() - gasAt > 60e3) { gasPrice = BigInt(await rpc('eth_gasPrice', [])); gasAt = Date.now(); }
    const p = gasPrice;
    for (const el of els) {
      const job = S.jobs.find((j) => j.id === el.closest('article')?.id);
      if (!job) continue;
      const gas = job.steps.filter((s) => !onChain(job, s) && chainOf(job, s) === job.chainId).reduce((x, s) => x + s.gas, 0);
      el.textContent = `≈ ${(Number(BigInt(gas) * p) / 1e18).toFixed(4)} ETH at ${(Number(p) / 1e9).toFixed(3)} gwei`;
    }
  } catch { /* the note is only a convenience */ }
}

// ── checking the plan ──
async function loadPayload(job) {
  if (!S.payload[job.id]) {
    const r = await fetch(job.payloadUrl, { signal: AbortSignal.timeout(30e3) });
    if (!r.ok) throw new Error('Could not load the transactions. Try again in a moment.');
    S.payload[job.id] = await r.json();
  }
  return S.payload[job.id];
}
async function verify(job, show = false) {
  try {
    S.verdict[job.id] = checkPayload(job, await loadPayload(job));
  } catch (e) { S.verdict[job.id] = { ok: false, problems: [{ step: '*', bad: [e.message] }] }; }
  renderAll();
  if (show && S.verdict[job.id].ok) say('Every transaction matches the plan: the same code, salts, settings and addresses the job names.', false, job.id);
  return S.verdict[job.id].ok;
}

// ── a point for the registry: read from the chain's keeper when it is sent, and checked here against the plan ──
async function pointTx(job, s) {
  const id = chainOf(job, s), r = await get(`${keepersUrl()}/${id}/evm-pool/keeper/point`);
  if (!r?.data) throw new Error(`The keeper on ${CHAINS[id].name} has no point to give. Try again in a moment.`);
  if (Number(r.chainId) !== id || String(r.registry).toLowerCase() !== s.to.toLowerCase()) throw new Error('That point is for another registry, so nothing was sent.');
  return { id: s.id, to: s.to, data: r.data, value: '0x0' };
}

// ── sending ──
async function go(job, only = null) {
  if (!job || S.running) return;
  if (!W.account) { await conn.connect(); return; }
  S.running = job.id; S.expanded.set(job.id, true); renderAll();
  try {
    if (!(await verify(job))) { say('A transaction does not match the plan, so nothing was sent.', true); return; }
    const payload = S.payload[job.id];
    // the chain is asked once, about every step not yet seen on it; a step this send lands is on it by its receipt
    const done = S.done[job.id] = await readDone(job, { chain: true });
    for (const [i, s] of job.steps.entries()) {
      if (only && s.id !== only) continue;
      if (done[s.id] === null) throw new Error('Could not read that step from the chain just now, so nothing was sent for it. Try again in a moment.');
      if (done[s.id]) { if (only) say('That step is already on the chain.'); continue; }
      // A point goes to the registry, which must be on that chain first.
      if (s.kind === 'post') {
        const reg = job.steps.find((r) => r.kind === 'createx' && r.bound === false && chainOf(job, r) === chainOf(job, s) && r.expected.toLowerCase() === s.to.toLowerCase());
        if (reg && !done[reg.id]) { if (only) throw new Error(`The registry on ${CHAINS[chainOf(job, s)].name} is not on the chain yet: send its step first.`); continue; }
      }
      const id = chainOf(job, s), tx = s.kind === 'post' ? await pointTx(job, s) : payload.steps[i];
      if (checkStep(job, s, tx).length) throw new Error('A transaction no longer matches the plan.');
      say(`Step ${i + 1} of ${job.steps.length}: ${esc(s.label)}${id === job.chainId ? '' : ` ${mark(id)}`}. Confirm in your wallet…`);
      const hash = await conn.wallet.sendTx({ to: tx.to, data: tx.data, value: 0n, from: W.account, chain: id === 1 ? null : asWallet(id) });
      say(`Step ${i + 1} sent: ${link(`${CHAINS[id].explorer}/tx/${hash}`, esc(short(hash, 6)))}. Waiting for it to land…`);
      const rc = await conn.wallet.receipt(hash, { read: (m, p) => readOn(id, m, p), where: `the ${CHAINS[id].name} explorer` });
      if (rc.status !== '0x1') throw new Error(`Step ${i + 1} failed (${short(hash, 6)}). Nothing more was sent.`);
      track(hash, id, job.id);
      done[s.id] = true;
      renderAll();
    }
    S.done[job.id] = await readDone(job, { chain: true });
    renderAll();
    say(only ? 'Sent. The rewards service reads the step after twelve confirmations.' : 'Everything is sent. The rewards service reads each step after twelve confirmations.');
  } catch (e) {
    say(esc(e instanceof UserStopped ? declinedWords(e, 'Send again to continue where it left off.') : (e.message || 'The wallet did not send it.')), !(e instanceof UserStopped));
  } finally { const id = S.running; S.running = null; S.done[id] = await readDone(job, { chain: true }).catch(() => S.done[id]); renderAll(); settle(); }
}

// The account to be paid sends itself the Bitcoin transaction id, so nobody else can name that account for this work.
async function sendReview(form) {
  if (S.running) return;
  if (!W.account) { await conn.connect(); return; }
  const job = S.jobs.find((j) => j.id === form.dataset.job), txid = form.querySelector('textarea').value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) { say('That is not a Bitcoin transaction id.', true, job.id); return; }
  S.running = job.id; renderAll();
  try {
    say('Confirm in your wallet…', false, job.id);
    const hash = await conn.wallet.sendTx({ to: W.account, data: `0x${txid}`, value: 0n, from: W.account, chain: null });
    say(`Sent: ${link(`${ETHERSCAN}/tx/${hash}`, esc(short(hash, 6)))}. Post this link in ${link(DISCORD, 'Discord')} for review.`, false, job.id);
  } catch (e) { say(esc(e instanceof UserStopped ? declinedWords(e) : (e.message || 'The wallet did not send it.')), !(e instanceof UserStopped), job.id); }
  finally { S.running = null; renderAll(); }
}

// ── naming steps to the service ──
function track(hash, chainId = 1, job = null) {
  const h = hash.toLowerCase();
  if (!S.hashes[h]) S.hashes[h] = { state: 'pending', note: 'waiting for confirmations', chainId, job, at: Date.now() };
  remember(S.hashes);
}
let settling = false;
async function settle() {
  if (settling) return;
  const waiting = Object.keys(S.hashes).filter((h) => S.hashes[h].state === 'pending');
  if (!waiting.length) return;
  settling = true;
  try {
    // A transaction is named on the chain it was sent on (Ethereum when it was kept without one).
    const chains = [...new Set(waiting.map((h) => S.hashes[h].chainId ?? 1))];
    for (const chainId of chains) for (let i = 0, mine = waiting.filter((h) => (S.hashes[h].chainId ?? 1) === chainId); i < mine.length; i += 25) {
      const batch = mine.slice(i, i + 25);
      const r = await fetch(`${pointsUrl()}/tasks/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chainId === 1 ? { txHashes: batch } : { txHashes: batch, chainId }), signal: AbortSignal.timeout(60e3) }).catch(() => null);
      if (!r || !r.ok) { for (const h of batch) S.hashes[h].note = r?.status === 429 ? 'the service asked to slow down' : 'the rewards service did not answer'; continue; }
      for (const res of (await r.json()).results) {
        const h = res.txHash.toLowerCase(), steps = res.steps.filter((x) => x.state);
        if (res.status === 'ok' && steps.length && steps.every((x) => ['queued', 'credited'].includes(x.status))) S.hashes[h] = { state: 'done' };
        else if (res.status === 'no step') S.hashes[h] = { state: 'void', note: 'not a step of a listed job' };
        else if (res.status === 'failed') S.hashes[h] = { state: 'void', note: 'the transaction failed' };
        else if (res.status === 'ok') S.hashes[h].note = steps.map((x) => x.status).filter((x) => !['queued', 'credited'].includes(x))[0] ?? 'waiting';
        else if (res.status === 'unknown chain') S.hashes[h] = { state: 'void', note: 'the rewards service does not know that chain' };
        else {
          S.hashes[h].note = res.status === 'confirming' ? `${res.confirmationsLeft} confirmations to go` : res.status;
          S.hashes[h].at ||= Date.now();
          if (res.status === 'not found' && Date.now() - S.hashes[h].at > 6 * 3600e3) S.hashes[h] = { state: 'void', note: 'the rewards service has not found it in six hours: check the hash and its chain' };
        }
      }
    }
  } finally { remember(S.hashes); settling = false; loadApi(); }
}

// ── the reader's own endpoints ──
// Each chain is read through public nodes, which see the reader's IP address; with nodes of their own it is read through those alone. The
// rewards service and the keepers can be the reader's too. Saved in this browser.
const goodUrl = (u) => /^https:\/\/[^\s/]+/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u);
const urlsOf = (t) => [...new Set(String(t).split(/\s+/).filter(Boolean).map((u) => u.replace(/\/+$/, '')))];
function renderEnds() {
  const el = $('#ends-body');
  el.innerHTML = `<form autocomplete="off">
    <p class="note">Each chain is read through public nodes, which see your IP address. Set your own and it is read through yours alone.</p>
    ${Object.entries(CHAINS).map(([id, c]) => `<label class="lbl"><span>${mark(id)}${esc(c.name)} · your own nodes</span><textarea rows="2" spellcheck="false" id="e-rpc-${id}" placeholder="https://… (optional)">${esc((ends.rpc?.[id] || []).join('\n'))}</textarea></label>`).join('')}
    <label class="lbl"><span>Rewards service</span><input id="e-points" spellcheck="false" placeholder="${esc(POINTS)}" value="${esc(ends.points || '')}"></label>
    <label class="lbl"><span>Keepers, for the first points</span><input id="e-keepers" spellcheck="false" placeholder="${esc(KEEPERS)}" value="${esc(ends.keepers || '')}"></label>
    <p class="note" id="ends-say" role="status"></p>
    <div class="row2"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="e-reset">Use the defaults</button></div>
  </form>`;
  const say = (m, bad = false) => { const n = $('#ends-say'); n.className = `note${bad ? ' err' : ''}`; n.textContent = m; };
  el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const next = { rpc: {}, points: '', keepers: '' }, bad = [];
    for (const id of Object.keys(CHAINS)) { const l = urlsOf($(`#e-rpc-${id}`).value); bad.push(...l.filter((u) => !goodUrl(u))); if (l.length) next.rpc[id] = l; }
    for (const k of ['points', 'keepers']) { const v = urlsOf($(`#e-${k}`).value)[0] || ''; if (v && !goodUrl(v)) bad.push(v); next[k] = v; }
    if (bad.length) return say(`${short(bad[0], 18)} is not a URL this page can reach. Use https://… for each.`, true);
    say('Checking the nodes…');
    // A node on another chain would show that chain's code as this one's.
    for (const [id, l] of Object.entries(next.rpc)) for (const u of l) {
      const got = await fetch(u, { method: 'POST', headers: { 'content-type': bodyType(u) }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(10e3) }).then((r) => r.json()).then((j) => Number(j.result), () => NaN);
      if (Number.isNaN(got)) return say(`${short(u, 18)} did not answer. Check the address, and that it allows requests from this page.`, true);
      if (got !== Number(id)) return say(`${short(u, 18)} is on chain ${got}, not ${CHAINS[id].name}.`, true);
    }
    apply(next);
    say('Saved.');
  };
  $('#e-reset').onclick = () => { apply({}); renderEnds(); $('#ends-say').textContent = 'Using the defaults.'; };
}
function apply(next) {
  ends = next;
  try { localStorage.setItem(ENDS, JSON.stringify(next)); } catch { /* private window: it lasts until this page is closed */ }
  S.done = {}; S.api = null;
  refresh(); loadApi();
  $('#ends > summary').textContent = Object.keys(next.rpc || {}).length || next.points || next.keepers ? 'Endpoints: yours' : 'Endpoints';
}
$('#ends').addEventListener('toggle', () => { if ($('#ends').open) renderEnds(); });
$('#ends > summary').textContent = Object.keys(ends.rpc || {}).length || ends.points || ends.keepers ? 'Endpoints: yours' : 'Endpoints';

// ── start ──
// The places the page's late blocks will fill are held from the first paint (the css names them .loading); they are let go when the blocks are
// there, or after a while, so a node that does not answer never leaves the stats row or the endpoints out of reach.
function settled() { $('#jobs').classList.remove('loading'); $('#stats').classList.remove('loading'); }
setTimeout(settled, 12e3);
async function start() {
  const file = await get('/tasks/jobs.json');
  if (!file?.jobs?.length) { settled(); $('#jobs').innerHTML = '<p class="none">Could not load the jobs. Try again in a moment.</p>'; return; }
  S.jobs = file.jobs.filter((j) => !j.into);
  S.folded = file.jobs.filter((j) => j.into);
  const wanted = location.hash.slice(1);
  if (S.jobs.some((j) => j.id === wanted)) S.expanded.set(wanted, true);          // a link to a job opens it
  renderAll();
  apiFirst = loadApi();
  await Promise.all([apiFirst, refresh()]);
  setInterval(() => { if (!document.hidden && !S.running) { refresh(); loadApi(); } }, 30e3);
  setInterval(() => { if (!document.hidden) settle(); }, 20e3);
  settle();
}
start();
