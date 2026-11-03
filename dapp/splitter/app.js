// The tip splitter page: what an EthSplitter holds, who it pays and in what proportion, a button that sends the balance on, a form the owner
// uses to change the list, and a form that deploys a new one. Reads go to Ethereum's public nodes, one after another; sends go through the
// injected wallet. Nothing is kept except the address of the splitter being looked at (and the arguments of the one deployed here, for
// its Etherscan form).
import {
  SEL, TOPIC, MAX_RECIPIENTS, encDistribute, encSetShares, encDeployArgs, deployData, decodeShares, decodeAddress,
  payouts, percent, fmtEth, sharesProblem, isAddress, safeBatch,
} from '/splitter/abi.js?cb=44661448';
import { SPLITTER_INITCODE } from '/splitter/bytecode.js?cb=6e21588e';
import { bodyType } from '../rpc-body.js';
import { ETH_NODES } from '/eth-nodes.js';

const API = 'https://api.tacit.finance';
const RPCS = ETH_NODES;
const OPS_MULTISIG = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const DEPLOYER = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7';
const SETTLE = '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331';
const BUYBACK = '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250';
const KNOWN = new Map([
  [OPS_MULTISIG.toLowerCase(), ['Ops multisig', 'owns the pool, the farms and this splitter']],
  [DEPLOYER.toLowerCase(), ['Deployer wallet', 'headers and attests: keeps Bitcoin’s state on Ethereum current']],
  [SETTLE.toLowerCase(), ['Settle wallet', 'settles relayed requests']],
  [BUYBACK.toLowerCase(), ['TAC buyback', 'turns its ETH into TAC for the reserve, at most once every six hours']],
]);
// 10% to the buyback, then the other 90% as 70 : 30 between the wallets that run the relay (63 : 27).
const START_ROWS = [[DEPLOYER, '63'], [SETTLE, '27'], [BUYBACK, '10']];
const KEY = 'tacit-splitter-v1';

const $ = (s, el = document) => el.querySelector(s);
const lc = (a) => String(a || '').toLowerCase();
const short = (a, k = 6) => `${a.slice(0, 2 + k)}…${a.slice(-4)}`;
const nameOf = (a) => KNOWN.get(lc(a))?.[0] || null;
const roleOf = (a) => KNOWN.get(lc(a))?.[1] || '';
const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } },
  set(patch) { try { localStorage.setItem(KEY, JSON.stringify({ ...store.get(), ...patch })); } catch { /* private window */ } },
};

// ── DOM ──
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const mount = (el, ...kids) => { el.replaceChildren(...kids.flat().filter((x) => x != null && x !== false)); };
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
const scan = (path, text) => link(`https://etherscan.io/${path}`, text);
const SVG = 'http://www.w3.org/2000/svg';
const mark = (id) => { const s = document.createElementNS(SVG, 'svg'), u = document.createElementNS(SVG, 'use'); s.setAttribute('class', 'tk'); s.setAttribute('aria-hidden', 'true'); u.setAttribute('href', `#${id}`); s.append(u); return s; };
const say = (el, text, cls = '') => { el.className = `status ${cls}`.trim(); mount(el, text); };

// ── chain reads ──
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': bodyType(url) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (j.error) { if (j.error.code === 3 || /revert/i.test(j.error.message || '')) throw Object.assign(new Error(j.error.message), { revert: true }); last = new Error(j.error.message); continue; }
      return j.result;
    } catch (e) { if (e.revert) throw e; last = e; }
  }
  throw last || new Error('no node answered');
}
async function waitReceipt(hash, ms = 20 * 60e3) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) { if (r.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`); return r; }
    if (Date.now() > end) throw new Error('Not confirmed after 20 minutes. It can still land: check the transaction on Etherscan.');
    await new Promise((res) => setTimeout(res, 4000));
  }
}

// ── wallet ──
const provider = () => window.ethereum || null;
async function ensureChain() {
  const id = await provider().request({ method: 'eth_chainId' });
  if (parseInt(id, 16) === 1) return;
  await provider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
}
async function connect() {
  if (!provider()) throw new Error('No wallet found in this browser. The Safe batch below works without one.');
  const accts = await provider().request({ method: 'eth_requestAccounts' });
  S.account = lc(accts[0]);
  await ensureChain();
  paint();
  return S.account;
}
async function sendTx(tx) {
  if (!S.account) await connect();
  await ensureChain();
  return provider().request({ method: 'eth_sendTransaction', params: [{ from: S.account, ...tx }] });
}
const walletWords = (e) => (e?.code === 4001 || /user (rejected|denied)/i.test(e?.message || '') ? 'Cancelled in your wallet.' : String(e?.message || e).slice(0, 240));

// ── state ──
const S = { addr: null, account: null, owner: null, shares: null, balance: 0n, block: 0, recip: [], quote: null, logs: [], err: null, rows: null, dirty: false, deploy: { owner: OPS_MULTISIG, rows: START_ROWS.map((r) => [...r]), ownerOk: false }, gas: null };
// One status line per panel, made once: a panel drawn again after its transaction lands keeps what the action said.
const OUT = { state: h('div', { class: 'status', role: 'status' }), edit: h('div', { class: 'status', role: 'status' }), deploy: h('div', { class: 'status', role: 'status' }) };
const clearOut = () => { for (const o of Object.values(OUT)) say(o, ''); };
const isOwner = () => !!S.account && !!S.owner && lc(S.account) === lc(S.owner);

async function load() {
  if (!S.addr) { paint(); return; }
  S.err = null;
  try {
    const [sh, ow, bal, blk] = await Promise.all([
      rpc('eth_call', [{ to: S.addr, data: SEL.shares }, 'latest']), rpc('eth_call', [{ to: S.addr, data: SEL.owner }, 'latest']),
      rpc('eth_getBalance', [S.addr, 'latest']), rpc('eth_blockNumber', []),
    ]);
    if (!sh || sh === '0x' || !ow || ow === '0x') throw new Error('empty');
    S.shares = decodeShares(sh); S.owner = decodeAddress(ow); S.balance = BigInt(bal); S.block = parseInt(blk, 16);
    S.recip = await Promise.all(S.shares.to.map((a) => rpc('eth_getBalance', [a, 'latest']).then(BigInt).catch(() => null)));
    if (!S.dirty) S.rows = S.shares.to.map((a, i) => [a, String(S.shares.weight[i])]);
  } catch (e) {
    S.shares = null;
    S.err = e.message === 'empty' || e.revert ? 'No splitter answers at that address.' : 'Could not read that address. Try again in a moment.';
  }
  paint();
  loadExtras();
}
async function loadExtras() {
  if (!S.addr || !S.shares) return;
  const [quote, logs] = await Promise.all([
    fetch(`${API}/confidential/quote?asset=cETH`, { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then((r) => r.json()).then((j) => j.tipSplitter || j.recommendedTipRecipient || null).catch(() => null),
    rpc('eth_getLogs', [{ address: S.addr, topics: [TOPIC.distributed], fromBlock: '0x' + Math.max(0, S.block - 100000).toString(16), toBlock: 'latest' }]).catch(() => []),
  ]);
  S.quote = quote;
  S.logs = (logs || []).slice(-5).reverse().map((l) => ({ amount: BigInt(l.data), block: parseInt(l.blockNumber, 16), tx: l.transactionHash }));
  paintState();
}

// ── a button that runs one action ──
async function busy(btn, out, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try { await fn((t, c) => say(out, t, c)); } catch (e) { say(out, walletWords(e), 'err'); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
}
function copy(text, el) {
  const done = () => { const was = el.textContent; el.textContent = 'Copied'; setTimeout(() => { el.textContent = was; }, 1200); };
  (navigator.clipboard?.writeText(text) || Promise.reject()).then(done, () => {
    const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy'); done(); } catch { /* the text is on screen too */ } t.remove();
  });
}

// ── the shares editor, shared by the change form and the deploy form ──
// The inputs are built once; typing only rewrites the line under each of them, so a field keeps its focus. A wallet removed changes the
// rows, which the caller draws again (onChange(true)).
function editor(rows, { balance = 0n, onChange }) {
  const wrap = h('div', { class: 'edit' }), pcs = [];
  const refresh = () => {
    const ws = rows.map((r) => (/^\d+$/.test(String(r[1]).trim()) ? BigInt(String(r[1]).trim()) : 0n)), pay = payouts(balance, ws);
    pcs.forEach((el, i) => {
      const r = rows[i];
      el.textContent = !isAddress(r[0]) ? 'Paste the address.'
        : [nameOf(r[0]) || 'Not a known Tacit wallet', ws[i] > 0n ? ` · ${percent(ws, i)}%` : ' · –', balance > 0n && ws[i] > 0n ? ` · ${fmtEth(pay[i])} ETH of what waits` : ''].join('');
    });
  };
  rows.forEach((r, i) => {
    const pc = h('div', { class: 'pc' }); pcs.push(pc);
    wrap.append(h('div', { class: 'row' },
      h('input', { type: 'text', value: r[0], spellcheck: 'false', 'aria-label': `Wallet ${i + 1}`, placeholder: '0x…', oninput: (e) => { r[0] = e.target.value.trim(); refresh(); onChange(false); } }),
      h('input', { type: 'text', inputmode: 'numeric', value: r[1], 'aria-label': `Weight of wallet ${i + 1}`, placeholder: 'Weight', oninput: (e) => { r[1] = e.target.value; refresh(); onChange(false); } }),
      h('button', { type: 'button', 'aria-label': `Remove wallet ${i + 1}`, disabled: rows.length < 2, onclick: () => { rows.splice(i, 1); onChange(true); } }, '\u00d7'),
      pc));
  });
  refresh();
  wrap.refresh = refresh;
  return wrap;
}
const rowsProblem = (rows, self) => sharesProblem(rows.map((r) => r[0]), rows.map((r) => (/^\d+$/.test(String(r[1]).trim()) ? String(r[1]).trim() : 'x')), self);
const rowsArgs = (rows) => ({ to: rows.map((r) => r[0]), weight: rows.map((r) => BigInt(String(r[1]).trim())) });

// ── painting ──
// A form panel is not drawn again under someone typing in it: a refresh in the background (the wallet changing, a read finishing) leaves it
// alone, and what they typed is already in S.rows / S.deploy.rows for the next draw.
// With no splitter yet, deploying is the page: its panel leads the left column. Once there is one, it moves to the side.
function placeDeploy() {
  const cols = document.querySelectorAll('.grid > .col'), d = $('#p-deploy'), want = S.addr ? cols[1] : cols[0];
  if (d.parentElement !== want) want.prepend(d);
}
const typing = (el) => el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
function paint() {
  placeDeploy();
  paintAddr(); paintState();
  if (!typing($('#p-edit'))) paintEdit(); else S.editCheck?.();       // what depends on who is connected is updated in place
  if (!typing($('#p-deploy'))) paintDeploy();
  paintNext(); paintChip(); paintRelay();
}
function paintAddr() { const i = $('#addr-in'); if (i && document.activeElement !== i) i.value = S.addr || ''; }
function paintChip() {
  const chip = $('#wallet-chip'); if (!provider()) return;
  chip.hidden = false;
  $('#wallet-dot').className = `dot ${S.account ? 'on' : ''}`;
  $('#wallet-label').textContent = S.account ? `${short(S.account, 4)}${isOwner() ? ' · owner' : ''}` : 'Connect';
}
const ago = (blocks) => { const s = blocks * 12; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

function paintState() {
  const el = $('#p-state');
  if (!S.addr) { el.hidden = true; return; }
  el.hidden = false;
  if (!S.shares) { mount(el, h('p', { class: 'eyebrow' }, 'Splitter'), h('p', { class: S.err ? 'err' : 'mute' }, S.err || 'Loading…')); return; }
  const { to, weight } = S.shares, pay = payouts(S.balance, weight), out = OUT.state;
  const go = h('button', { class: 'btn', type: 'button', disabled: S.balance === 0n }, S.balance === 0n ? 'Nothing to send on' : 'Send it on');
  go.addEventListener('click', () => busy(go, out, async (say_) => {
    say_('Confirm in your wallet…');
    const tx = await sendTx({ to: S.addr, data: encDistribute() });
    say_(h('span', {}, 'Sent ', scan(`tx/${tx}`, short(tx, 8)), '. Waiting for it to land…'));
    await waitReceipt(tx);
    say_(h('span', { class: 'ok' }, 'Sent on. ', scan(`tx/${tx}`, short(tx, 8))));
    await load();
  }));
  const tipsHere = S.quote && lc(S.quote) === lc(S.addr);
  mount(el,
    h('p', { class: 'eyebrow' }, h('span', {}, 'Splitter'), scan(`address/${S.addr}`, short(S.addr, 8))),
    h('p', { class: 'room num' }, mark('tk-eth'), fmtEth(S.balance), h('small', {}, 'ETH waiting')),
    S.balance > 0n ? h('div', { class: 'rows' }, to.map((a, i) => h('div', { class: 'kv' }, h('span', {}, `→ ${nameOf(a) || short(a)}`), h('b', { class: 'num' }, `${fmtEth(pay[i])} ETH`)))) : null,
    go, out,
    S.quote == null ? null : h('div', { class: `callout ${tipsHere ? 'good' : ''}` }, tipsHere
      ? h('span', {}, h('b', {}, 'Tacit’s own pages tip this splitter.'), ' The relay’s quote names it. A page that pinned the ops multisig keeps paying the multisig, and the relay counts both.')
      : h('span', {}, h('b', {}, 'Tacit’s pages do not tip this splitter yet.'), ` The relay’s quote names ${nameOf(S.quote) || short(S.quote, 8)}. Set RELAY_TIP_SPLITTER_ADDR on the API to ${S.addr} to change that.`)),
    h('div', { class: 'rows' }, to.map((a, i) => h('div', { class: 'who' },
      h('div', { class: 'nm' }, h('b', {}, nameOf(a) || 'Wallet'), h('small', {}, roleOf(a) || a, roleOf(a) ? ` · ${short(a, 6)}` : '')),
      h('div', { class: 'pc num' }, `${percent(weight, i)}%`),
      h('div', { class: 'bal num' }, S.recip[i] == null ? '' : `${fmtEth(S.recip[i], 4)} ETH held`)))),
    h('div', { class: 'rows' },
      h('div', { class: 'kv' }, h('span', {}, 'Owner'), h('b', {}, nameOf(S.owner) ? `${nameOf(S.owner)} · ${short(S.owner, 6)}` : S.owner)),
      S.logs.length ? S.logs.map((l) => h('div', { class: 'log' }, h('span', {}, `Sent on ${ago(S.block - l.block)}`), h('b', { class: 'num' }, scan(`tx/${l.tx}`, `${fmtEth(l.amount)} ETH`)))) : h('div', { class: 'kv' }, h('span', {}, 'Sent on'), h('b', {}, 'nothing in the last two weeks'))));
}

function paintEdit() {
  const el = $('#p-edit');
  if (!S.shares) { el.hidden = true; return; }
  el.hidden = false;
  const rows = S.rows, out = OUT.edit, hint = h('p', { class: 'hint err' });
  const ownerNote = h('p', { class: 'note' });
  const check = () => {
    hint.textContent = rowsProblem(rows, S.addr) || ''; hint.className = 'hint err';
    go.disabled = !isOwner() || !!rowsProblem(rows, S.addr);
    ownerNote.textContent = isOwner() ? 'You are connected as the owner.' : `Only the owner (${nameOf(S.owner) || short(S.owner, 8)}) can change the list. From a Safe, use the batch below.`;
    sb.redraw();
  };
  S.editCheck = check;
  const ed = editor(rows, { balance: S.balance, onChange: (structural) => { S.dirty = true; if (structural) paintEdit(); else check(); } });
  const go = h('button', { class: 'btn', type: 'button' }, S.balance > 0n ? 'Send what waits, then set the list' : 'Set the list');
  go.addEventListener('click', () => busy(go, out, async (say_) => {
    const { to, weight } = rowsArgs(rows);
    if (S.balance > 0n) {
      say_('Sending what waits under the current list first. Confirm in your wallet…');
      const t1 = await sendTx({ to: S.addr, data: encDistribute() });
      await waitReceipt(t1);
    }
    say_('Confirm the new list in your wallet…');
    const t2 = await sendTx({ to: S.addr, data: encSetShares(to, weight) });
    say_(h('span', {}, 'Sent ', scan(`tx/${t2}`, short(t2, 8)), '. Waiting for it to land…'));
    await waitReceipt(t2);
    S.dirty = false;
    say_(h('span', { class: 'ok' }, 'The list is changed. ', scan(`tx/${t2}`, short(t2, 8))));
    await load();
  }));
  const sb = safeBox(rows, out);
  mount(el,
    h('p', { class: 'eyebrow' }, h('span', {}, 'Change who is paid'), h('button', { class: 'linkbtn', type: 'button', onclick: () => { S.dirty = false; S.rows = S.shares.to.map((a, i) => [a, String(S.shares.weight[i])]); paintEdit(); } }, 'Start again')),
    ed,
    h('button', { class: 'linkbtn', type: 'button', disabled: rows.length >= MAX_RECIPIENTS, onclick: () => { rows.push(['', '1']); S.dirty = true; paintEdit(); } }, rows.length >= MAX_RECIPIENTS ? 'Eight wallets is the most' : '+ Add a wallet'),
    h('p', { class: 'note' }, 'Weights are plain numbers: 7 and 3, or 70 and 30, both pay 70% and 30%. The new list applies to what has not been sent on yet.'),
    hint, go, out,
    ownerNote,
    sb);
  check();
}

// The Safe's own route: the calls as a batch file for the Transaction Builder, and each as raw calldata.
function safeBox(rows, out) {
  const area = h('textarea', { class: 'field', readonly: true, 'aria-label': 'Safe batch' }), calls = h('div');
  const box = h('details', {}, h('summary', {}, 'For a Safe: the batch'), h('p', { class: 'note' }, 'In the Safe’s Transaction Builder choose “Upload a batch” and drop in this file’s text. It sends what waits first (if anything), then sets the list.'), area, calls,
    h('button', { class: 'btn ghost', type: 'button', onclick: (e) => copy(area.value, e.target) }, 'Copy the batch'));
  box.redraw = () => {
    if (rowsProblem(rows, S.addr)) { area.value = ''; mount(calls); return; }
    const { to, weight } = rowsArgs(rows), list = [...(S.balance > 0n ? [encDistribute()] : []), encSetShares(to, weight)];
    area.value = JSON.stringify(safeBatch({ to: S.addr, name: 'Set the tip splitter list', calls: list }), null, 2);
    mount(calls, list.map((d, i) => h('p', { class: 'note mono-wrap' }, h('b', {}, `${i + 1}. to ${short(S.addr, 8)}, value 0`), h('br'), d.length > 200 ? `${d.slice(0, 190)}…` : d)));
  };
  return box;
}

// The operator's view of the relay: where each wallet stands and what the standing commitments are set to, from the API's /relay/economics.
// Balances are shown here and not on the public page (/relay/), which is about flows.
const RELAY = { j: null };
const ethFmt = (x) => (x == null ? '–' : x === 0 ? '0' : x < 0.0001 ? x.toPrecision(2) : Number(x).toLocaleString('en-US', { maximumFractionDigits: 4 }));
function paintRelay() {
  const el = $('#p-relay'), j = RELAY.j;
  if (!j || !j.chain) { el.hidden = true; return; }
  el.hidden = false;
  const w = j.chain.wallets, l = j.ledger, wk = l && l.week, cfg = (l && l.cfg) || {};
  const perSettle = wk && wk.settled > 0 && wk.gasEth > 0 ? wk.gasEth / wk.settled : null;
  const left = (eth) => (perSettle && eth != null ? ` · enough for about ${Math.floor(eth / perSettle)} settles` : '');
  const row = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: 'num' }, v));
  mount(el,
    h('p', { class: 'eyebrow' }, h('span', {}, 'The relay’s wallets'), h('a', { href: '/relay/' }, 'Public page →')),
    h('div', { class: 'rows' },
      row('Settle wallet', `${ethFmt(w.settle.eth)} ETH${left(w.settle.eth)}`),
      row('Deployer wallet', `${ethFmt(w.relay.eth)} ETH`),
      row('PROVE held there', w.relay.prove == null ? '–' : `${ethFmt(w.relay.prove)} PROVE`)),
    h('div', { class: 'rows' },
      row('Buyback share of fee income', cfg.buybackBps ? `${cfg.buybackBps / 100}%` : 'off'),
      row('Settle wallet keeps before paying it', cfg.buybackKeepEth != null ? `${ethFmt(cfg.buybackKeepEth)} ETH` : '–'),
      row('Carried to the next pass', l ? `${ethFmt(l.owedEth)} ETH` : '–'),
      row('Splitter sent on by the relay', cfg.splitter ? `${wk ? wk.splitterSends : 0} ${wk && wk.splitterSends === 1 ? 'time' : 'times'} this week` : 'not set (SPLITTER_ADDR)')),
    j.sponsorship ? h('div', { class: 'rows' },
      row('Sponsored settles today', `${j.sponsorship.total.used} of ${j.sponsorship.total.cap}`),
      j.sponsorship.cheapGas ? row('  Allowances open while network fees are low', j.sponsorship.cheapGas.on ? `on (network fee ${j.sponsorship.cheapGas.gwei} gwei, under ${j.sponsorship.cheapGas.limit}): bridge, cBTC and cUSD ops have no daily limit, the rest ${j.sponsorship.cheapGas.mult}×`
        : j.sponsorship.cheapGas.limit ? `off (network fee ${j.sponsorship.cheapGas.gwei ?? 'unread'} gwei; opens under ${j.sponsorship.cheapGas.limit})` : 'off (FREE_RELAY_CHEAP_GWEI is 0)') : null,
      Object.entries({ bridge: 'bridge mints', onboard: 'cBTC mints', cusd: 'cUSD loans, repayments, top-ups', farm: 'farm harvests and unbonds', wrap: 'wraps with no tip', other: 'other' }).map(([k, label]) => { const c = j.sponsorship.classes[k]; return row(`  ${label}`, c.cap == null ? `${c.used}, no limit` : `${c.used} of ${c.cap}${c.used >= c.cap ? ' (used up)' : ''}`); })) : null,
    h('p', { class: 'note' }, l && l.stale ? 'These figures are as of the relay’s last report.' : 'The buyback and splitter settings are on the settle service (BUYBACK_INCOME_BPS, BUYBACK_KEEP_WEI, BUYBACK_MIN_SEND_WEI, SPLITTER_ADDR, SPLITTER_MIN_WEI) and take effect on its next pass; the sponsored-settle limits are on the API (FREE_RELAY_DAILY_CAP, FREE_RELAY_CAP_ONBOARD, _FARM, _WRAP, _OTHER).'));
}
async function loadRelay() {
  try { RELAY.j = await (await fetch(`${API}/relay/economics`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })).json(); } catch { /* the panel stays as it was */ }
  paintRelay();
}

const DEPLOY_GAS = 765_000n;                       // measured: 763,688 for the three-wallet list (tools/splitter-fork-check.mjs)
function paintDeploy() {
  const el = $('#p-deploy'), D = S.deploy, out = OUT.deploy, hint = h('p', { class: 'hint err' }), fresh = !S.addr;
  const bad = () => (isAddress(D.owner) ? null : 'The owner is not an address.') || rowsProblem(D.rows, null);
  const check = () => {
    const p = bad();
    hint.textContent = p || ''; go.disabled = !!p || !D.ownerOk; dataBtn.disabled = !!p;
    if (!p) { const { to, weight } = rowsArgs(D.rows); dataBtn.dataset.data = deployData(SPLITTER_INITCODE, D.owner, to, weight); }
    ownerName.textContent = isAddress(D.owner) ? (nameOf(D.owner) || 'Not a known Tacit wallet') : '';
  };
  const ed = editor(D.rows, { balance: 0n, onChange: (structural) => { if (structural) paintDeploy(); else check(); } });
  const go = h('button', { class: 'btn', type: 'button' }, S.account ? 'Deploy' : 'Connect a wallet and deploy');
  const dataBtn = h('button', { class: 'linkbtn', type: 'button', onclick: (e) => copy(e.target.dataset.data, e.target) }, 'Copy the deploy data');
  const ownerName = h('span', { class: 'mute' });
  go.addEventListener('click', () => busy(go, out, async (say_) => {
    const { to, weight } = rowsArgs(D.rows);
    say_('Confirm the deploy in your wallet…');
    const tx = await sendTx({ data: deployData(SPLITTER_INITCODE, D.owner, to, weight) });
    say_(h('span', {}, 'Sent ', scan(`tx/${tx}`, short(tx, 8)), '. Waiting for it to land…'));
    const rc = await waitReceipt(tx);
    if (!isAddress(rc.contractAddress)) throw new Error('The transaction did not create a contract.');
    S.addr = rc.contractAddress; S.dirty = false; S.rows = null; D.ownerOk = false;
    store.set({ addr: S.addr, args: encDeployArgs(D.owner, to, weight), tx });
    location.hash = S.addr;
    say_(h('span', { class: 'ok' }, 'Deployed at ', scan(`address/${S.addr}`, S.addr), '.'));
    await load();
  }));
  const cost = S.gas ? `About ${Number(DEPLOY_GAS).toLocaleString('en-US')} gas to deploy: ${ethFmt(Number(DEPLOY_GAS * S.gas) / 1e18)} ETH in network fees today.` : `About ${Number(DEPLOY_GAS).toLocaleString('en-US')} gas to deploy.`;
  mount(el,
    h('p', { class: 'eyebrow' }, h('span', {}, fresh ? 'Deploy the splitter' : 'Deploy another')),
    fresh ? h('ul', { class: 'what' },
      h('li', {}, 'It holds wrap tips until anyone sends them on, in one call.'),
      h('li', {}, 'It pays the wallets below by weight. 63 / 27 / 10 is the deployer wallet, the settle wallet and the TAC buyback.'),
      h('li', {}, 'Only the owner can change who is paid and in what proportion.')) : null,
    h('label', { class: 'lbl', for: 'dep-owner' }, 'Owner: can change the list, and can hand the contract on'),
    h('input', { id: 'dep-owner', class: 'field', type: 'text', value: D.owner, spellcheck: 'false', oninput: (e) => { D.owner = e.target.value.trim(); D.ownerOk = false; tick.checked = false; check(); } }),
    h('p', { class: 'note' }, ownerName),
    h('span', { class: 'lbl' }, 'Who is paid, and in what proportion'),
    ed,
    h('button', { class: 'linkbtn', type: 'button', disabled: D.rows.length >= MAX_RECIPIENTS, onclick: () => { D.rows.push(['', '1']); paintDeploy(); } }, '+ Add a wallet'),
    h('label', { class: 'tick' }, h('input', { type: 'checkbox', id: 'dep-ok', checked: D.ownerOk, onchange: (e) => { D.ownerOk = e.target.checked; check(); } }), h('span', {}, 'The owner address is right. Its owner can redirect every tip; the wallet that deploys only pays the network fee.')),
    h('p', { class: 'note' }, cost),
    hint, go, h('div', {}, dataBtn), out);
  const tick = $('#dep-ok', el);
  check();
}

function paintNext() {
  const el = $('#p-next'), st = store.get();
  if (!S.addr || !S.shares) { el.hidden = true; return; }
  el.hidden = false;
  const mine = st.args && lc(st.addr) === lc(S.addr);
  const lines = { verify: `forge verify-contract ${S.addr} src/EthSplitter.sol:EthSplitter --chain mainnet --compiler-version 0.8.37 --num-of-optimizations 1 --via-ir --evm-version prague${mine ? ` --constructor-args 0x${st.args}` : ' --constructor-args <the hex from the deploy>'} --watch`,
    api: `RELAY_TIP_SPLITTER_ADDR=${S.addr}\nSPLITTER_ADDR=${S.addr}`, settle: `SPLITTER_ADDR=${S.addr}` };
  const copyBlock = (key, label, text) => h('div', { class: 'cmd' }, h('div', { class: 'cmd-h' }, h('span', { class: 'mute' }, label), h('button', { class: 'linkbtn', type: 'button', onclick: (e) => copy(text, e.target) }, 'Copy')), h('pre', {}, text));
  mount(el,
    h('p', { class: 'eyebrow' }, 'Switching the tips over'),
    h('ol', { class: 'steps' },
      h('li', {}, h('b', {}, 'Verify it on Etherscan. '), 'From the repo’s contracts folder, with your Etherscan key in the environment (compiler 0.8.37, optimizer 1 run, via IR, EVM prague):', copyBlock('verify', 'forge', lines.verify)),
      h('li', {}, h('b', {}, 'Point the tips here. '), 'On the API service on Render, set these two. The relay’s quote then names the splitter in a separate field. Tacit’s own pages tip it, and the relay counts a tip paid to it or to the ops multisig as paid.', copyBlock('api', 'tacit-api', lines.api)),
      h('li', {}, h('b', {}, 'Let the relay send it on. '), 'On the settle service, set this. Its next pass (every 30 minutes) sends the splitter on once it holds 0.0005 ETH.', copyBlock('settle', 'tacit-settle', lines.settle)),
      h('li', {}, h('b', {}, 'Pinned pages. '), 'A page that pays the ops multisig directly (an integrator’s, say) still can: its tips reach the multisig as before, and only a page that reads the new field tips the splitter.')));
}

// ── start ──
function openAddr(a) {
  if (!isAddress(a)) { S.err = 'That is not an address.'; S.addr = null; S.shares = null; paint(); return; }
  if (lc(a) !== lc(S.addr)) clearOut();
  S.addr = a; S.dirty = false; S.rows = null; S.shares = null; S.quote = null; S.logs = [];
  store.set({ addr: a }); history.replaceState(null, '', `#${a}`);
  load();
}
$('#pick').addEventListener('submit', (e) => { e.preventDefault(); openAddr($('#addr-in').value.trim()); });
$('#wallet-chip').addEventListener('click', () => connect().catch((e) => alert(walletWords(e))));
if (provider()?.on) {
  provider().on('accountsChanged', (a) => { S.account = a[0] ? lc(a[0]) : null; paint(); });
  provider().on('chainChanged', () => paint());
}
(async () => {
  loadRelay(); setInterval(loadRelay, 120000);
  rpc('eth_gasPrice', []).then((g) => { S.gas = BigInt(g); paintDeploy(); }).catch(() => {});
  paintChip();
  if (provider()) provider().request({ method: 'eth_accounts' }).then((a) => { if (a[0]) { S.account = lc(a[0]); paint(); } }).catch(() => {});
  const fromHash = location.hash.replace(/^#/, '');
  const start = isAddress(fromHash) ? fromHash : store.get().addr;
  if (isAddress(start)) openAddr(start); else paint();
})();
