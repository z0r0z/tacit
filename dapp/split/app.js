// The split page: an amount, the plan for it, a wallet to deposit the whole notes, and a way back to them.
// Off unless the link carries ?fixed=1 (kept in this browser until ?fixed=0).

import { planSplit, FIXED_POOLS, DEFAULT_MIN_DENOMINATION, DEFAULT_MAX_NOTES } from '/fixed-pool-notes.js?cb=ab06e6d2';
import { makeFlow, parseEther, formatEther, describeNote } from '/fixed-pool-flow.js?cb=0f50365d';
import { PAYMASTERS } from '/fixed-pool-paymaster.js?cb=40893745';
import { workerProver } from '/fixed-pool-prover.js?cb=307cfddc';

const $ = (id) => document.getElementById(id);
const kv = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* a convenience only */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* a convenience only */ } },
};

const FLAG = 'tacit-fixed-pools';
const asked = new URLSearchParams(location.search).get('fixed');
if (asked === '1') kv.set(FLAG, '1'); else if (asked === '0') kv.del(FLAG);
const enabled = kv.get(FLAG) === '1';
$(enabled ? 'app' : 'off').hidden = false;

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const NETWORKS = { 1: 'Ethereum', 11155111: 'Sepolia' };
const TACIT_LINK = { 1: '/pay/eth/#ethereum/deposit' };

const S = { account: null, chainId: null, flow: null, busy: false, notes: [] };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const say = (id, text, cls = '') => { const el = $(id); el.textContent = text; el.className = `status ${cls}`.trim(); };

function settings() {
  const min = BigInt($('min').value || DEFAULT_MIN_DENOMINATION);
  const max = Math.max(0, Math.min(20, Number($('max').value)));
  return { minDenominationWei: min, maxNotes: Number.isFinite(max) ? max : DEFAULT_MAX_NOTES };
}

function fillMinOptions() {
  const sel = $('min'), keep = sel.value;
  const pools = FIXED_POOLS[S.chainId] || FIXED_POOLS[1];
  sel.innerHTML = pools.map((p) => `<option value="${p.denomination}">${formatEther(p.denomination)} ETH</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : String(DEFAULT_MIN_DENOMINATION);
  if (!sel.value) sel.selectedIndex = 0;
}

function plan() {
  const wei = parseEther($('amt').value);
  if (wei === null || wei === 0n) return null;
  return { wei, ...planSplit(wei, S.chainId ?? 1, settings()) };
}

function renderPlan() {
  const p = plan();
  const box = $('plan');
  $('next').hidden = true;
  if (!p) { box.innerHTML = '<span class="mute">Enter an amount.</span>'; setGo(); return; }
  const rows = p.notes.map((n) => `<div class="row"><span>${n.count} × ${formatEther(n.denomination)} ETH</span><b><small>whole notes</small></b></div>`);
  rows.push(`<div class="row"><span>${p.remainder === 0n ? 'Nothing' : esc(formatEther(p.remainder)) + ' ETH'}</span><b><small>${p.remainder === 0n ? 'for Tacit' : 'to Tacit'}</small></b></div>`);
  if (!p.notes.length) rows.unshift(`<div class="row"><span class="mute">No whole notes at this size: all of it goes to Tacit.</span><b></b></div>`);
  box.innerHTML = rows.join('');
  setGo();
}

const validTo = (v) => /^0x[0-9a-fA-F]{40}$/.test(v.trim()) && !/^0x0{40}$/i.test(v.trim());
// Paying the gas from the note needs a paymaster on this network; it also needs no connected account, only a node to read from.
const sponsored = () => $('wgas').checked && !!PAYMASTERS[S.chainId];
function setWithdraw() {
  const g = $('wgo'), prep = $('wprep');
  const ready = /^[a-z]+-eth-[0-9.]+-\d+-0x[0-9a-fA-F]{124}$/.test($('wnote').value.trim()) && validTo($('wto').value);
  const has = !!PAYMASTERS[S.chainId];
  $('wgas').disabled = !has && S.chainId != null;
  const spons = sponsored();
  $('wnote-gas').hidden = !spons; $('wnote-wallet').hidden = spons; prep.hidden = spons;
  if (spons) { g.dataset.mode = 'withdraw'; g.textContent = 'Withdraw'; g.disabled = S.busy || !ready || !S.flow; return; }
  if (!S.account) { g.disabled = S.busy; g.textContent = 'Connect a wallet'; g.dataset.mode = 'connect'; prep.disabled = true; return; }
  g.dataset.mode = 'withdraw'; g.textContent = 'Withdraw';
  g.disabled = S.busy || !ready || !FIXED_POOLS[S.chainId];
  prep.disabled = g.disabled;
}

function setGo() {
  setWithdraw();
  const p = plan(), b = $('go');
  if (!S.account) { b.disabled = S.busy; b.textContent = 'Connect a wallet'; b.dataset.mode = 'connect'; return; }
  const net = NETWORKS[S.chainId];
  if (!net) { b.disabled = true; b.textContent = 'Switch to Ethereum'; b.dataset.mode = 'none'; return; }
  if (!p) { b.disabled = true; b.textContent = 'Enter an amount'; b.dataset.mode = 'none'; return; }
  if (!p.notes.length) { b.disabled = false; b.textContent = 'Continue in Tacit'; b.dataset.mode = 'tacit'; return; }
  b.disabled = S.busy; b.dataset.mode = 'deposit';
  b.textContent = `Deposit ${p.noteCount} ${p.noteCount === 1 ? 'note' : 'notes'}`;
}

function renderNotes(list) {
  $('notes').hidden = !list.length;
  $('dl').hidden = !list.length;
  $('noteList').innerHTML = list.map((n, i) => `
    <div class="note"><div class="head"><span>${esc(n.denomination)} ETH <small class="mute">· nonce ${n.nonce}${n.spent ? ' · spent' : ''}</small></span>
      <span><button class="btn ghost small" type="button" data-copy="${i}">Copy</button>${n.spent ? '' : ` <button class="btn ghost small" type="button" data-use="${i}">Withdraw</button>`}</span></div><code>${esc(n.text)}</code></div>`).join('');
  S.notes = list;
}

function renderNext(p) {
  $('next').hidden = false;
  const link = TACIT_LINK[S.chainId];
  $('nextBody').innerHTML = p.remainder === 0n
    ? '<span class="mute">Nothing is left for Tacit.</span>'
    : `<div class="row"><span>${esc(formatEther(p.remainder))} ETH</span><b><small>into Tacit</small></b></div>${link
      ? `<a class="btn" href="${link}">Continue in Tacit</a>`
      : '<div class="mute" style="font-size:12.5px">Tacit is not on this network on this page.</div>'}`;
}

async function connect() {
  const eth = window.ethereum;
  if (!eth) return say('status', 'No wallet found in this browser.', 'err');
  try {
    const [a] = await eth.request({ method: 'eth_requestAccounts' });
    S.account = a;
    S.chainId = Number(await eth.request({ method: 'eth_chainId' }));
    start(eth);
  } catch (e) { say('status', e?.message || 'The wallet did not connect.', 'err'); }
}

// Without an account: enough to read the chain, which is all that paying the gas from the note takes.
async function readOnly(eth) {
  try { S.chainId = Number(await eth.request({ method: 'eth_chainId' })); } catch { return; }
  S.flow = makeFlow({ provider: eth, account: null, chainId: S.chainId, store: kv });
  $('who').textContent = NETWORKS[S.chainId] || `chain ${S.chainId}`;
  fillMinOptions();
  setGo();
}

function start(eth) {
  S.flow = makeFlow({ provider: eth, account: S.account, chainId: S.chainId, store: kv });
  $('who').textContent = `${short(S.account)} · ${NETWORKS[S.chainId] || `chain ${S.chainId}`}`;
  fillMinOptions();
  $('find').disabled = !FIXED_POOLS[S.chainId];
  renderPlan();
}

async function go() {
  const mode = $('go').dataset.mode, p = plan();
  if (mode === 'connect') return connect();
  if (mode === 'tacit') { const l = TACIT_LINK[S.chainId]; if (l) location.href = l; else say('status', 'Tacit is not on this network on this page.', 'warn'); return; }
  if (mode !== 'deposit' || !p || S.busy) return;
  S.busy = true; setGo(); $('find').disabled = true;
  try {
    const bal = BigInt(await window.ethereum.request({ method: 'eth_getBalance', params: [S.account, 'latest'] }));
    if (bal < p.wei) throw new Error(`The wallet holds ${formatEther(bal)} ETH, less than ${formatEther(p.wei)}.`);
    const out = await S.flow.deposit(p, {
      onStep: (s) => say('status', s.step === 'find' ? 'Looking for the next free note number…' : s.step === 'sign' ? `Sign for note ${s.i + 1} of ${s.of}…` : s.step === 'send' ? 'Confirm the deposits in your wallet…' : `Deposit ${s.i} of ${s.of} confirmed.`),
    });
    renderNotes(out.notes.map((n) => describeNote(n, S.chainId)));
    say('status', `${out.notes.length === 1 ? 'Deposited.' : 'Deposited all.'} Keep the notes: they open the deposit anywhere.`, 'ok');
    renderNext(p);
  } catch (e) {
    const partial = e?.done?.length ? ` ${e.done.length} of ${e.notes.length} deposits went through; Find shows them.` : '';
    say('status', `${e?.message || 'Something went wrong.'}${partial}`, 'err');
  } finally { S.busy = false; $('find').disabled = !FIXED_POOLS[S.chainId]; setGo(); }
}

async function find() {
  if (!S.flow || S.busy) return;
  S.busy = true; setGo(); $('find').disabled = true;
  try {
    const { found } = await S.flow.scan({ from: 0, onProbe: (n) => say('findStatus', `Sign for number ${n}…`) });
    say('findStatus', found.length ? `${found.length} found.` : 'No deposits found.', found.length ? 'ok' : '');
    renderNotes(found.map((n) => describeNote(n, S.chainId)));
  } catch (e) { say('findStatus', e?.message || 'Something went wrong.', 'err'); }
  finally { S.busy = false; $('find').disabled = !FIXED_POOLS[S.chainId]; setGo(); }
}

const WSTEPS = {
  read: (s) => (s.of ? `Reading the pool's deposits (${s.done} of ${s.of})…` : s.note ? s.note : 'Reading the pool\'s deposits…'),
  tree: (s) => `Building the tree from ${s.count} deposits…`,
  prove: () => 'Proving. This takes a little while.',
  send: () => 'Confirm the withdrawal in your wallet…',
  estimate: () => 'Asking the bundler about the gas…',
  quote: () => 'Check the fee below, then send.',
  price: () => 'Gas is high right now. Waiting for a calmer price…',
  wait: () => 'Waiting for the withdrawal to be mined…',
};

async function withdraw(send) {
  if ($('wgo').dataset.mode === 'connect') return connect();
  if (sponsored()) return withdrawFromNote();
  if (!S.flow || S.busy) return;
  S.busy = true; setGo(); $('wout').hidden = true;
  const prover = workerProver('/fixed-pool-worker.js?cb=2999c092');
  try {
    const out = await S.flow.withdraw({
      noteText: $('wnote').value.trim(), recipient: $('wto').value.trim(), prover, send,
      onStep: (s) => say('wstatus', (WSTEPS[s.step] || (() => ''))(s)),
    });
    if (out.sent) say('wstatus', out.spent ? `Withdrawn. Transaction ${out.hash}` : `Sent. Transaction ${out.hash}. The pool has not shown it yet.`, out.spent ? 'ok' : 'warn');
    else say('wstatus', 'Proved. Send this call from any account.', 'ok');
    if (!out.sent) { $('wdata').textContent = `to ${out.call.target}\ndata ${out.call.input}`; $('wout').hidden = false; }
  } catch (e) { say('wstatus', e?.message || 'Something went wrong.', 'err'); }
  finally { prover.close(); S.busy = false; setGo(); }
}

// Asks before the withdrawal is sent: the fee is fixed by then (the proof carries it) and is the most the paymaster may take.
// Nothing is sent without a press, or if none comes in three minutes.
function confirmFee({ fee, receive, denomination }) {
  return new Promise((resolve) => {
    const pct = Number((fee * 10000n) / denomination) / 100;
    $('wconfirm-text').textContent = `Gas is paid from the note: up to ${formatEther(fee)} ETH (${pct.toFixed(2)}% of it), and what is not used comes back to the address. The address gets at least ${formatEther(receive)} ETH.`;
    $('wconfirm').hidden = false;
    const done = (ok) => { clearTimeout(timer); $('wconfirm').hidden = true; $('wsend').onclick = null; $('wcancel').onclick = null; resolve(ok); };
    const timer = setTimeout(() => done(false), 3 * 60 * 1000);
    $('wsend').onclick = () => done(true);
    $('wcancel').onclick = () => done(false);
  });
}

async function withdrawFromNote() {
  if (!S.flow || S.busy) return;
  S.busy = true; setGo(); $('wout').hidden = true; $('wconfirm').hidden = true;
  const prover = workerProver('/fixed-pool-worker.js?cb=2999c092');
  try {
    const out = await S.flow.withdrawSponsored({
      noteText: $('wnote').value.trim(), recipient: $('wto').value.trim(), prover, confirm: confirmFee,
      onStep: (s) => say('wstatus', (WSTEPS[s.step] || (() => ''))(s)),
    });
    const got = `${formatEther(out.receive)} ETH, plus what the fee left over after gas`;
    say('wstatus', out.spent ? `Withdrawn: ${got}. Transaction ${out.hash}` : `Sent. Transaction ${out.hash}. The pool has not shown it yet.`, out.spent ? 'ok' : 'warn');
  } catch (e) { say('wstatus', e?.message || 'Something went wrong.', e?.cancelled ? '' : 'err'); }
  finally { prover.close(); S.busy = false; $('wconfirm').hidden = true; setGo(); }
}

function download() {
  const text = S.notes.map((n) => n.text).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = 'tacit-notes.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

if (enabled) {
  $('max').value = String(DEFAULT_MAX_NOTES);
  fillMinOptions();
  $('amt').addEventListener('input', renderPlan);
  $('min').addEventListener('change', renderPlan);
  $('max').addEventListener('input', renderPlan);
  $('go').addEventListener('click', go);
  $('find').addEventListener('click', find);
  $('dl').addEventListener('click', download);
  $('wgo').addEventListener('click', () => withdraw(true));
  $('wprep').addEventListener('click', () => withdraw(false));
  $('wnote').addEventListener('input', setWithdraw);
  $('wto').addEventListener('input', setWithdraw);
  $('wgas').addEventListener('change', setGo);
  $('wcopy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText($('wdata').textContent); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; }
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  });
  $('noteList').addEventListener('click', async (e) => {
    const use = e.target?.dataset?.use;
    if (use != null) { $('wnote').value = S.notes[Number(use)].text; setWithdraw(); $('wto').focus(); return; }
    const i = e.target?.dataset?.copy;
    if (i == null) return;
    try { await navigator.clipboard.writeText(S.notes[Number(i)].text); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; }
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  });
  const eth = window.ethereum;
  if (eth?.on) {
    eth.on('accountsChanged', (a) => { if (!a?.length) location.reload(); else { S.account = a[0]; start(eth); } });
    eth.on('chainChanged', (c) => { S.chainId = Number(c); if (S.account) start(eth); else readOnly(eth); });
    readOnly(eth);
  }
  renderPlan();
}
